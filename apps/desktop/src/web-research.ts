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
import { app, ipcMain, safeStorage } from 'electron';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

const CASELIST_API = 'https://api.opencaselist.com/v1';
const FETCH_TIMEOUT_MS = 20_000;
const MAX_PAGE_BYTES = 4 * 1024 * 1024;
const MAX_DOWNLOAD_BYTES = 30 * 1024 * 1024;
const USER_AGENT = 'Cooky/1.0 (debate research; +https://github.com/ant981228/cardmirror)';

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
