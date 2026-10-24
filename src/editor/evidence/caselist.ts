/**
 * OpenCaselist client (renderer side) for Evidence Search.
 *
 * Network calls go through the desktop main process (web-research.ts),
 * which holds the session token. Downloaded Verbatim files are parsed
 * with the normal .docx importer, so cards come back as real card nodes
 * — tag, cite and body with their underlining, emphasis and highlighting
 * intact — ready to insert into the document as they were cut.
 */

import type { Node as PMNode } from 'prosemirror-model';
import { fromDocxFull } from '../../index.js';
import { newHeadingId } from '../../schema/index.js';
import { researchApi, type ResearchApi } from '../host/electron-host.js';
import { settings } from '../settings.js';

export interface CaselistInfo {
  slug: string;
  name: string;
  event: string;
  year: number;
  archived: boolean;
}

export interface SearchHit {
  /** Caselist file path (what /download takes). */
  path: string;
  /** Search snippet from OpenCaselist. */
  content: string;
  shard: string;
}

export interface FoundCard {
  /** Stable key within one search run. */
  key: string;
  tag: string;
  cite: string;
  /** Body text (for display and ranking). */
  body: string;
  /** The nearest block / hat heading above the card in its file. */
  section: string;
  /** Caselist file it came from. */
  source: string;
  /** The card itself, formatting intact. */
  node: PMNode;
}

export class CaselistError extends Error {
  constructor(message: string, readonly needsSignIn = false) {
    super(message);
  }
}

function api(): ResearchApi {
  const r = researchApi();
  if (!r) throw new CaselistError('Evidence Search needs the desktop app.');
  return r;
}

async function getJson(route: string, query?: Record<string, string>): Promise<unknown> {
  const res = await api().caselistGet(route, query);
  if (!res.ok) throw new CaselistError(res.error, res.status === 401);
  return res.data;
}

export async function signedIn(): Promise<boolean> {
  const r = researchApi();
  return r ? (await r.caselistStatus()).signedIn : false;
}

export async function signIn(username: string, password: string): Promise<void> {
  const res = await api().caselistLogin(username, password);
  if (!res.ok) throw new CaselistError(res.error);
}

export async function signOut(): Promise<void> {
  await api().caselistLogout();
}

let caselistsCache: CaselistInfo[] | null = null;
let probedShard: string | null = null;

/** Pull the array out of a reply that is either the array itself or an
 *  object wrapping it ({ caselists: [...] }, { data: [...] }, …). */
function asArray(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    for (const v of Object.values(data as Record<string, unknown>)) if (Array.isArray(v)) return v;
  }
  return [];
}

function toCaselist(raw: unknown): CaselistInfo | null {
  if (!raw || typeof raw !== 'object') return null;
  const c = raw as Record<string, unknown>;
  const slug = typeof c['slug'] === 'string' ? c['slug'] : typeof c['name'] === 'string' && /^[\w-]+$/.test(c['name']) ? c['name'] : '';
  if (!slug) return null;
  return {
    slug,
    name: String(c['display_name'] ?? c['name'] ?? slug),
    event: String(c['event'] ?? ''),
    year: Number(c['year'] ?? 0),
    archived: c['archived'] === true || c['archived'] === 1,
  };
}

/** Current and archived caselists, merged. An empty answer is never
 *  cached, so a hiccup doesn't stick for the session. */
export async function listCaselists(): Promise<CaselistInfo[]> {
  if (caselistsCache) return caselistsCache;
  const [current, archived] = await Promise.all([
    getJson('/caselists').catch((e: unknown) => {
      if (e instanceof CaselistError && e.needsSignIn) throw e;
      return [];
    }),
    getJson('/caselists', { archived: 'true' }).catch(() => []),
  ]);
  const bySlug = new Map<string, CaselistInfo>();
  for (const raw of [...asArray(current), ...asArray(archived)]) {
    const c = toCaselist(raw);
    if (c && !bySlug.has(c.slug)) bySlug.set(c.slug, c);
  }
  const list = [...bySlug.values()];
  if (list.length > 0) caselistsCache = list;
  return list;
}

/** Season years to try when the caselist list can't be read: the
 *  current season (it rolls over in August) and the one before. */
function seasonSuffixes(now: Date = new Date()): string[] {
  const y = now.getFullYear() % 100;
  const season = now.getMonth() >= 7 ? y + 1 : y;
  return [season, season - 1].map((n) => String(n).padStart(2, '0'));
}

/** The caselist to search: Settings → OpenCaselist caselist, else the
 *  newest Public Forum caselist, else (list unreadable) the first of this
 *  and last season's PF caselists that answers a search. */
export async function activeCaselist(): Promise<string> {
  const chosen = settings.get('caselistSlug').trim();
  if (chosen) return chosen;
  const lists = await listCaselists();
  const pf = lists
    .filter((c) => /\bpf\b|public\s*forum/i.test(`${c.event} ${c.name}`) || /pf/i.test(c.slug))
    .sort((a, b) => Number(a.archived) - Number(b.archived) || b.year - a.year);
  const pick = pf[0] ?? [...lists].sort((a, b) => b.year - a.year)[0];
  if (pick) return pick.slug;
  if (probedShard) return probedShard;
  for (const yy of seasonSuffixes()) {
    const shard = `hspf${yy}`;
    try {
      await getJson('/search', { q: 'evidence', shard });
      probedShard = shard;
      return shard;
    } catch (e) {
      if (e instanceof CaselistError && e.needsSignIn) throw e;
    }
  }
  throw new CaselistError(
    'OpenCaselist didn’t list any caselists for this account. Type a caselist name (for example hspf26) in the box above the search.',
  );
}

export async function search(query: string, shard: string): Promise<SearchHit[]> {
  const data = await getJson('/search', { q: query, shard });
  return (Array.isArray(data) ? data : [])
    .map((h) => h as Partial<SearchHit>)
    .filter((h): h is SearchHit => typeof h.path === 'string' && h.path.length > 0)
    .map((h) => ({ path: h.path, content: String(h.content ?? ''), shard: String(h.shard ?? shard) }));
}

const fileCache = new Map<string, Promise<FoundCard[]>>();

/** Download a caselist file and split it into cards. Cached per path. */
export function cardsInFile(path: string): Promise<FoundCard[]> {
  let p = fileCache.get(path);
  if (!p) {
    p = (async () => {
      const res = await api().caselistDownload(path);
      if (!res.ok) throw new CaselistError(res.error, res.status === 401);
      if (!/\.docx$/i.test(path)) return [];
      const { doc } = await fromDocxFull(res.bytes);
      return extractCards(doc, path);
    })();
    p.catch(() => fileCache.delete(path));
    fileCache.set(path, p);
  }
  return p;
}

function isCiteNode(n: PMNode): boolean {
  if (n.type.name === 'cite_paragraph') return true;
  let has = false;
  n.forEach((c) => {
    if (c.isText && c.marks.some((m) => m.type.name === 'cite_mark')) has = true;
  });
  return has;
}

/** Every card in a parsed document, with the heading it sits under. */
export function extractCards(doc: PMNode, source: string): FoundCard[] {
  const out: FoundCard[] = [];
  let section = '';
  doc.forEach((top, _offset, index) => {
    const t = top.type.name;
    if (t === 'block' || t === 'hat' || t === 'pocket') {
      section = top.textContent.trim();
      return;
    }
    if (t !== 'card') return;
    const tag = top.firstChild?.textContent.trim() ?? '';
    let cite = '';
    const body: string[] = [];
    top.forEach((c, _o, i) => {
      if (i === 0) return;
      if (!cite && isCiteNode(c)) cite = c.textContent.trim();
      else body.push(c.textContent);
    });
    if (!tag && !cite) return;
    out.push({
      key: `${source}#${index}`,
      tag,
      cite,
      body: body.join('\n').trim(),
      section,
      source,
      node: top,
    });
  });
  return out;
}

/** A card ready to insert: fresh heading ids so it can't collide with
 *  the document's own outline. */
export function insertableCard(card: FoundCard): PMNode {
  const n = card.node;
  const tag = n.firstChild!;
  const freshTag = tag.type.create({ ...tag.attrs, id: newHeadingId() }, tag.content, tag.marks);
  const rest: PMNode[] = [];
  n.forEach((c, _o, i) => {
    if (i > 0) rest.push(c);
  });
  return n.type.create(n.attrs, [freshTag, ...rest], n.marks);
}

const STOP = new Set('the a an of to and or in on for is are be by with that this it as at from was were will not'.split(' '));

export function terms(q: string): string[] {
  return q
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !STOP.has(w));
}

/** Keyword relevance: tag hits weigh most, then cite, then body. */
export function scoreCard(card: FoundCard, words: readonly string[]): number {
  if (words.length === 0) return 0;
  const tag = card.tag.toLowerCase();
  const cite = card.cite.toLowerCase();
  const body = card.body.toLowerCase();
  let s = 0;
  for (const w of words) {
    if (tag.includes(w)) s += 4;
    if (cite.includes(w)) s += 1;
    if (body.includes(w)) s += 1.5;
  }
  return s / words.length;
}
