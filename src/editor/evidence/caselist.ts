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

export async function listCaselists(): Promise<CaselistInfo[]> {
  if (caselistsCache) return caselistsCache;
  const data = await getJson('/caselists', { archived: 'true' });
  caselistsCache = (Array.isArray(data) ? data : [])
    .map((c) => c as Partial<CaselistInfo>)
    .filter((c): c is CaselistInfo => typeof c.slug === 'string')
    .map((c) => ({ ...c, event: String(c.event ?? ''), year: Number(c.year ?? 0), archived: !!c.archived }));
  return caselistsCache;
}

/** The caselist to search: Settings → OpenCaselist caselist, else the
 *  newest Public Forum caselist. */
export async function activeCaselist(): Promise<string> {
  const chosen = settings.get('caselistSlug').trim();
  if (chosen) return chosen;
  const lists = await listCaselists();
  const pf = lists
    .filter((c) => /\bpf\b|public\s*forum/i.test(`${c.event} ${c.name}`) || /pf/i.test(c.slug))
    .sort((a, b) => Number(a.archived) - Number(b.archived) || b.year - a.year);
  const pick = pf[0] ?? [...lists].sort((a, b) => b.year - a.year)[0];
  if (!pick) throw new CaselistError('No caselists are available to search.');
  return pick.slug;
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
