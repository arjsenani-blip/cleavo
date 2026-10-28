/**
 * Network side of research: page fetches for the Public Forum cite
 * creator and the OpenCaselist client behind Evidence Search. Both run
 * in main so the renderer isn't bound by CORS and the caselist session
 * token never reaches page script.
 *
 * OpenCaselist (api.opencaselist.com/v1) authenticates with a
 * `caselist_token` cookie that POST /login sets from the user's Tabroom
 * username + password. The password is used once and never stored; the
 * token is kept encrypted with the OS keychain (safeStorage) in
 * userData so the sign-in survives relaunches.
 */
import { app, BrowserWindow, ipcMain, safeStorage, session } from 'electron';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

const CASELIST_API = 'https://api.opencaselist.com/v1';
const FETCH_TIMEOUT_MS = 20_000;
const MAX_PAGE_BYTES = 4 * 1024 * 1024;
const MAX_DOWNLOAD_BYTES = 30 * 1024 * 1024;
const USER_AGENT = 'Cleavo/1.0 (debate research; +https://github.com/ant981228/cardmirror)';

export type Result<T> = ({ ok: true } & T) | { ok: false; error: string; status?: number };

async function timedFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function readCapped(res: Response, cap: number): Promise<Uint8Array | null> {
  const declared = Number(res.headers.get('content-length') ?? '0');
  if (declared > cap) return null;
  const buf = new Uint8Array(await res.arrayBuffer());
  return buf.byteLength > cap ? null : buf;
}

function errorText(err: unknown): string {
  if (err instanceof Error && err.name === 'AbortError') return 'The request timed out.';
  return err instanceof Error ? err.message : String(err);
}

// ─── Page fetch (PF cite creator) ────────────────────────────────────

/** GET an http(s) page as text. HTML only, capped, redirects followed. */
export async function fetchPage(rawUrl: unknown): Promise<Result<{ url: string; html: string }>> {
  let url: URL;
  try {
    url = new URL(String(rawUrl));
  } catch {
    return { ok: false, error: 'That isn’t a valid link.' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, error: 'Only http and https links can be fetched.' };
  }
  try {
    const res = await timedFetch(url.href, {
      redirect: 'follow',
      headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml' },
    });
    if (!res.ok) return { ok: false, error: `The site answered ${res.status}.`, status: res.status };
    const type = res.headers.get('content-type') ?? '';
    if (type && !/html|xml|text\/plain/i.test(type)) {
      return { ok: false, error: `That link is ${type.split(';')[0]}, not a web page.` };
    }
    const bytes = await readCapped(res, MAX_PAGE_BYTES);
    if (!bytes) return { ok: false, error: 'That page is too large to read.' };
    return { ok: true, url: res.url || url.href, html: new TextDecoder().decode(bytes) };
  } catch (err) {
    return { ok: false, error: errorText(err) };
  }
}

// ─── Background reader (PF cite qualifications) ──────────────────────

/** Session for the hidden reader: its own persistent cookie jar, so a
 *  news site the user signs into there stays signed in, and nothing is
 *  shared with the editor windows. Locked down once, on first use. */
const READER_PARTITION = 'persist:cooky-reader';
let readerSessionReady = false;

function readerSession(): Electron.Session {
  const ses = session.fromPartition(READER_PARTITION);
  if (!readerSessionReady) {
    readerSessionReady = true;
    // No camera, mic, location, notifications, clipboard… for any site.
    ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
    ses.setPermissionCheckHandler(() => false);
    // Never download anything.
    ses.on('will-download', (e) => e.preventDefault());
    // A normal desktop Chrome UA: some sites serve bylines only to browsers.
    ses.setUserAgent(ses.getUserAgent().replace(/\s?(Electron|Cleavo|cleavo|Cooky|cooky)\/[\d.]+/g, ''));
    // Hidden reads skip video, audio and web fonts — text is all they need.
    ses.webRequest.onBeforeRequest((details, cb) => {
      const hidden = details.webContentsId !== undefined && hiddenReaders.has(details.webContentsId);
      cb({ cancel: hidden && (details.resourceType === 'media' || details.resourceType === 'font') });
    });
  }
  return ses;
}

/** Reader windows, so the rest of the app can leave them out of window
 *  lists, broadcasts and the quit flow. */
const readerWindows = new WeakSet<BrowserWindow>();
/** webContents ids of the hidden (background) readers. */
const hiddenReaders = new Set<number>();
export function isReaderWindow(w: BrowserWindow): boolean {
  return readerWindows.has(w);
}

const RENDER_TIMEOUT_MS = 25_000;
/** A hidden read doesn't wait for every ad and tracker to finish: the
 *  byline and bio are in the page long before the load event. */
const HIDDEN_READY_MS = 6_000;
const SETTLE_MS = 600;
/** How long a visible reader waits for the user to get past a check. */
const VISIBLE_WAIT_MS = 120_000;

export type RenderResult = Result<{ url: string; html: string }> & { blocked?: boolean };

/** Bot checks and challenges ("Just a moment…", captchas). Cleavo never
 *  tries to get past one by itself: a hidden read reports it, and a
 *  visible read waits for the user to clear it. */
function looksLikeCheck(title: string, html: string): boolean {
  if (/^(just a moment|attention required|are you a robot|access denied|verify you are human|security check)/i.test(title.trim())) {
    return true;
  }
  // Real articles also load bot-monitoring scripts, so a marker only
  // counts on a page small enough to be a check screen (they run ~30 KB;
  // articles run hundreds).
  return html.length < 80_000 && /cf-chl-|challenge-platform|g-recaptcha|h-captcha|captcha-delivery|px-captcha/i.test(html);
}

/** Run a snippet in the page, giving up after `ms` — a busy or frozen
 *  page would otherwise leave the call (and the cite) waiting forever. */
function runInPage<T>(win: BrowserWindow, code: string, fallback: T, ms = 5000): Promise<T> {
  if (win.isDestroyed()) return Promise.resolve(fallback);
  return Promise.race([
    win.webContents.executeJavaScript(code, true).then((v) => v as T, () => fallback),
    new Promise<T>((res) => setTimeout(() => res(fallback), ms)),
  ]);
}

async function readRendered(win: BrowserWindow): Promise<{ title: string; html: string }> {
  const html = await runInPage(win, 'document.documentElement ? document.documentElement.outerHTML : ""', '');
  return { title: win.isDestroyed() ? '' : win.webContents.getTitle(), html };
}

/** Load a page in a sandboxed browser window, let its scripts run, scroll
 *  to the end (author bios often load lazily at the bottom), and return
 *  the rendered HTML — for pages that block plain fetches or build their
 *  byline with JavaScript.
 *
 *  Hidden by default. When the page puts up a bot check, a hidden read
 *  stops and reports `blocked`; with `visible`, the window is shown so the
 *  user can get past the check themselves, and it's read and closed once
 *  the real page appears (or the user closes it). */
export function renderPage(rawUrl: unknown, opts: { visible?: boolean } = {}): Promise<RenderResult> {
  // Hard ceiling on the whole read, whatever the page does.
  const ceiling = opts.visible === true ? VISIBLE_WAIT_MS + 40_000 : 15_000;
  return Promise.race([
    renderPageInner(rawUrl, opts),
    new Promise<RenderResult>((res) =>
      setTimeout(() => res({ ok: false, error: 'Reading the page took too long.' }), ceiling),
    ),
  ]);
}

async function renderPageInner(rawUrl: unknown, opts: { visible?: boolean }): Promise<RenderResult> {
  let url: URL;
  try {
    url = new URL(String(rawUrl));
  } catch {
    return { ok: false, error: 'That isn’t a valid link.' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, error: 'Only http and https links can be read.' };
  }
  const visible = opts.visible === true;
  const win = new BrowserWindow({
    show: false,
    width: 1100,
    height: 820,
    title: 'Cleavo reader',
    webPreferences: {
      session: readerSession(),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      javascript: true,
      images: visible,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });
  readerWindows.add(win);
  const wcId = win.webContents.id;
  if (!visible) hiddenReaders.add(wcId);
  win.webContents.setAudioMuted(true);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  let closedByUser = false;
  win.on('closed', () => {
    closedByUser = true;
  });
  const settle = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));
  try {
    const loaded = win.loadURL(url.href).then(
      () => true,
      () => true, // a sub-resource abort still leaves a usable page
    );
    if (visible) win.show();
    // A hidden read goes on once the document is parsed (dom-ready), or
    // after a few seconds at most, instead of waiting for the full load.
    const domReady = new Promise<boolean>((res) => win.webContents.once('dom-ready', () => res(true)));
    const ready = visible ? loaded : Promise.race([loaded, domReady, settle(HIDDEN_READY_MS).then(() => true)]);
    const timedOut = settle(RENDER_TIMEOUT_MS).then(() => false);
    if (!(await Promise.race([ready, timedOut]))) {
      return { ok: false, error: 'The page took too long to load.' };
    }
    await settle(SETTLE_MS);
    let page = await readRendered(win);

    if (looksLikeCheck(page.title, page.html)) {
      if (!visible) return { ok: false, blocked: true, error: 'This site checks for robots before showing the page.' };
      // The user is looking at the check; wait for the real page.
      win.setTitle('Cleavo reader — get past the check and the page will be read automatically');
      const deadline = Date.now() + VISIBLE_WAIT_MS;
      while (Date.now() < deadline) {
        await settle(1000);
        if (closedByUser || win.isDestroyed()) return { ok: false, error: 'The reader window was closed.' };
        page = await readRendered(win).catch(() => page);
        if (!looksLikeCheck(page.title, page.html)) break;
      }
      if (looksLikeCheck(page.title, page.html)) return { ok: false, blocked: true, error: 'The site’s check wasn’t completed.' };
      await settle(SETTLE_MS);
    }

    await runInPage(win, 'window.scrollTo(0, document.body ? document.body.scrollHeight : 0); true', false, 2000);
    await settle(SETTLE_MS);
    page = await readRendered(win);
    if (!page.html || page.html.length < 200) return { ok: false, error: 'The page came back empty.' };
    return { ok: true, url: win.webContents.getURL() || url.href, html: page.html.slice(0, MAX_PAGE_BYTES) };
  } catch (err) {
    if (closedByUser) return { ok: false, error: 'The reader window was closed.' };
    return { ok: false, error: errorText(err) };
  } finally {
    hiddenReaders.delete(wcId);
    if (!win.isDestroyed()) win.destroy();
  }
}

// ─── OpenCaselist ────────────────────────────────────────────────────

function tokenFile(): string {
  return path.join(app.getPath('userData'), 'caselist-session.bin');
}

let cachedToken: string | null | undefined;

async function loadToken(): Promise<string | null> {
  if (cachedToken !== undefined) return cachedToken;
  try {
    const raw = await fs.readFile(tokenFile());
    cachedToken = safeStorage.isEncryptionAvailable()
      ? safeStorage.decryptString(raw)
      : null;
  } catch {
    cachedToken = null;
  }
  return cachedToken;
}

async function saveToken(token: string | null): Promise<void> {
  cachedToken = token;
  if (!token) {
    await fs.rm(tokenFile(), { force: true });
    return;
  }
  // Without OS encryption the token lives for this session only.
  if (!safeStorage.isEncryptionAvailable()) return;
  await fs.mkdir(path.dirname(tokenFile()), { recursive: true });
  await fs.writeFile(tokenFile(), safeStorage.encryptString(token), { mode: 0o600 });
}

/** Pull `caselist_token` out of a login response (cookie, else body). */
export function tokenFromLogin(setCookies: readonly string[], body: unknown): string | null {
  for (const c of setCookies) {
    const m = /(?:^|;\s*)caselist_token=([^;]+)/.exec(c);
    if (m && m[1]) return decodeURIComponent(m[1]);
  }
  if (body && typeof body === 'object' && typeof (body as { token?: unknown }).token === 'string') {
    return (body as { token: string }).token;
  }
  return null;
}

export async function caselistLogin(
  username: unknown,
  password: unknown,
): Promise<Result<object>> {
  if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
    return { ok: false, error: 'Enter your Tabroom email and password.' };
  }
  try {
    const res = await timedFetch(`${CASELIST_API}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': USER_AGENT },
      body: JSON.stringify({ username, password, remember: true }),
    });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      /* not JSON */
    }
    if (!res.ok) {
      const msg = (body as { message?: string } | null)?.message;
      return {
        ok: false,
        status: res.status,
        error: res.status === 401 ? 'Tabroom didn’t accept that email and password.' : msg || `Sign-in failed (${res.status}).`,
      };
    }
    const token = tokenFromLogin(res.headers.getSetCookie?.() ?? [], body);
    if (!token) return { ok: false, error: 'Signed in, but OpenCaselist sent no session.' };
    await saveToken(token);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errorText(err) };
  }
}

async function caselistGet(
  route: string,
  query: Record<string, string> = {},
): Promise<Response | { ok: false; error: string; status?: number }> {
  const token = await loadToken();
  if (!token) return { ok: false, error: 'Sign in to OpenCaselist first.', status: 401 };
  const url = new URL(`${CASELIST_API}${route}`);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  try {
    const res = await timedFetch(url.href, {
      headers: { cookie: `caselist_token=${encodeURIComponent(token)}`, 'user-agent': USER_AGENT },
    });
    if (res.status === 401) {
      await saveToken(null);
      return { ok: false, error: 'Your OpenCaselist sign-in expired. Sign in again.', status: 401 };
    }
    if (!res.ok) return { ok: false, error: `OpenCaselist answered ${res.status}.`, status: res.status };
    return res;
  } catch (err) {
    return { ok: false, error: errorText(err) };
  }
}

/** Read-only JSON routes the renderer may ask for. Anything that writes
 *  to the caselist stays out of reach. */
const READ_ROUTE = /^\/(caselists(\/[\w.-]+(\/(schools(\/[\w.%-]+(\/teams(\/[\w.%-]+(\/(cites|rounds))?)?)?)?|recent|downloads))?)?|search|openev)$/;

export async function caselistJson(route: unknown, query: unknown): Promise<Result<{ data: unknown }>> {
  if (typeof route !== 'string' || !READ_ROUTE.test(route)) {
    return { ok: false, error: 'Unsupported caselist request.' };
  }
  const q: Record<string, string> = {};
  if (query && typeof query === 'object') {
    for (const [k, v] of Object.entries(query as Record<string, unknown>)) {
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') q[k] = String(v);
    }
  }
  const res = await caselistGet(route, q);
  if (!(res instanceof Response)) return res;
  try {
    return { ok: true, data: await res.json() };
  } catch (err) {
    return { ok: false, error: `Unreadable reply from OpenCaselist: ${errorText(err)}` };
  }
}

export async function caselistDownload(filePath: unknown): Promise<Result<{ bytes: Uint8Array }>> {
  if (typeof filePath !== 'string' || !filePath) return { ok: false, error: 'No file to download.' };
  const res = await caselistGet('/download', { path: filePath });
  if (!(res instanceof Response)) return res;
  const isJson = /json/i.test(res.headers.get('content-type') ?? '');
  const bytes = await readCapped(res, MAX_DOWNLOAD_BYTES);
  if (!bytes) return { ok: false, error: 'That caselist file is too large.' };
  if (!isJson) return { ok: true, bytes };
  // Some deployments wrap the file as { file: <base64> }.
  try {
    const body = JSON.parse(new TextDecoder().decode(bytes)) as { file?: unknown };
    if (typeof body.file === 'string') return { ok: true, bytes: new Uint8Array(Buffer.from(body.file, 'base64')) };
  } catch {
    /* fall through */
  }
  return { ok: false, error: 'OpenCaselist sent the file in an unexpected format.' };
}

export function registerWebResearchIpc(): void {
  ipcMain.handle('research:fetch-page', (_e, url: unknown) => fetchPage(url));
  ipcMain.handle('research:render-page', (_e, url: unknown, opts: unknown) =>
    renderPage(url, { visible: !!(opts && typeof opts === 'object' && (opts as { visible?: unknown }).visible === true) }),
  );
  ipcMain.handle('caselist:status', async () => ({ signedIn: (await loadToken()) !== null }));
  ipcMain.handle('caselist:login', (_e, username: unknown, password: unknown) =>
    caselistLogin(username, password),
  );
  ipcMain.handle('caselist:logout', async () => {
    await saveToken(null);
  });
  ipcMain.handle('caselist:get', (_e, route: unknown, query: unknown) => caselistJson(route, query));
  ipcMain.handle('caselist:download', (_e, filePath: unknown) => caselistDownload(filePath));
}
