/**
 * Public Forum cite creator ("Create PF Cite").
 *
 * Put the caret on (or select) a line with an article link and run it:
 * the page is fetched (desktop main process — no CORS), its citation
 * metadata read (Highwire `citation_*`, Dublin Core, Open Graph,
 * JSON-LD, bylines), and a full cite written in place:
 *
 *   Jane Smith 24, Senior Fellow at Brookings, "Title," Publication,
 *   3/14/2024, https://…, accessed 10/23/2026 // arjun 🦡
 *
 * That carries every element the NSDA evidence rules ask a card to have
 * on hand — full author name, qualifications, date, title, source, URL,
 * date accessed — with "Lastname Date" (what you read aloud) marked
 * with the cite style.
 *
 * Run it with no link under the caret and it asks for one, inserting
 * the cite at the caret. It works the cite out itself first: metadata,
 * then qualifications from the byline/bio ("Jane Smith is a senior
 * fellow at …"), following the author's profile page when the article
 * has none. Only when something is still missing (no author, date or
 * qualifications) does it ask Claude, handing over everything it found.
 * The user's signature (Settings → Cite signature) is appended either way.
 */

import type { EditorView } from 'prosemirror-view';
import { settings } from '../settings.js';
import { aiConfigured, aiFailureNotice, activeApiKey, callLlm } from './llm.js';
import { AiActivity } from './ai-activity.js';
import { claimRegion } from './edit-coordinator.js';
import { showToast } from '../toast.js';
import { promptForText } from '../text-prompt.js';
import { researchApi } from '../host/electron-host.js';
import { ensureTagAboveCite } from '../ribbon-commands.js';
import {
  buildCiteTransaction,
  CITE_TOKENS_MARKED_META,
  parseCiteResponse,
  withCiteSignature,
  type AiCiteResult,
} from './cite-creator.js';

export interface PageMeta {
  url: string;
  title: string;
  publication: string;
  authors: string[];
  /** ISO-ish date string as published, '' when unknown. */
  published: string;
  description: string;
  /** Byline / author-bio text near the article, for qualifications. */
  bylineText: string;
  /** Opening article text, so the model can spot credentials in it. */
  excerpt: string;
  /** Author profile links found in the byline (absolute URLs). */
  authorLinks: string[];
  /** Author bio text found at the end of the article, if any. */
  bioText: string;
}

const URL_RE = /\bhttps?:\/\/[^\s<>"'”’)\]]+[^\s<>"'”’)\].,;:!?]/i;

export function findUrl(text: string): string | null {
  const m = URL_RE.exec(text);
  return m ? m[0] : null;
}

function clean(s: string | null | undefined): string {
  return (s ?? '').replace(/\s+/g, ' ').trim();
}

/** An element's text with a space between every text node — unlike
 *  `textContent`, which glues "<span>Jane Smith</span><span>Editor</span>"
 *  into "Jane SmithEditor". */
function spacedText(el: Node | null | undefined): string {
  if (!el) return '';
  const parts: string[] = [];
  const walk = (n: Node): void => {
    if (n.nodeType === 3) parts.push(n.nodeValue ?? '');
    else n.childNodes.forEach(walk);
  };
  walk(el);
  return clean(parts.join(' ').replace(/\s+([,.;:!?])/g, '$1'));
}

/** "By Jane Smith and John Doe" → ["Jane Smith", "John Doe"]. */
export function splitAuthors(raw: string): string[] {
  const s = clean(raw).replace(/^by\s+/i, '');
  if (!s) return [];
  return s
    .split(/\s*(?:,\s*and\s+|\s+and\s+|&|;|,|\|)\s*/i)
    .map((x) => x.trim())
    .filter((x) => x.length > 1 && x.length < 80 && !/^https?:/i.test(x) && /[A-Za-z]/.test(x));
}

function uniq(xs: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of xs) {
    const k = x.toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      out.push(x);
    }
  }
  return out;
}

/** Collect JSON-LD objects (flattening @graph / arrays). */
function jsonLdObjects(doc: Document): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const visit = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(visit);
    else if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      out.push(o);
      if (o['@graph']) visit(o['@graph']);
    }
  };
  doc.querySelectorAll('script[type="application/ld+json"]').forEach((el) => {
    try {
      visit(JSON.parse(el.textContent ?? ''));
    } catch {
      /* malformed JSON-LD is common; skip it */
    }
  });
  return out;
}

function ldNames(v: unknown): string[] {
  if (!v) return [];
  if (typeof v === 'string') return [v];
  if (Array.isArray(v)) return v.flatMap(ldNames);
  if (typeof v === 'object') {
    const name = (v as { name?: unknown }).name;
    return typeof name === 'string' ? [name] : [];
  }
  return [];
}

/** Read citation metadata out of a fetched page. Pure (DOMParser only). */
export function extractPageMetadata(html: string, url: string): PageMeta {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const meta = (...names: string[]): string[] => {
    const out: string[] = [];
    for (const n of names) {
      doc
        .querySelectorAll(`meta[name="${n}" i], meta[property="${n}" i], meta[itemprop="${n}" i]`)
        .forEach((el) => {
          const c = clean(el.getAttribute('content'));
          if (c) out.push(c);
        });
    }
    return out;
  };
  const ld = jsonLdObjects(doc).filter((o) => {
    const t = o['@type'];
    const types = Array.isArray(t) ? t : [t];
    return types.some((x) => typeof x === 'string' && /Article|Report|Posting|WebPage|ScholarlyArticle|Blog/i.test(x));
  });
  const ldFirst = (key: string): unknown => ld.find((o) => o[key] != null)?.[key];

  const authors = uniq([
    ...meta('citation_author', 'dc.creator', 'dcterms.creator'),
    ...ldNames(ldFirst('author')),
    ...meta('author', 'article:author', 'parsely-author', 'sailthru.author').flatMap(splitAuthors),
    ...Array.from(doc.querySelectorAll('[rel="author"], [itemprop="author"] [itemprop="name"], .byline__name, .author-name'))
      .map((el) => clean(el.textContent))
      .flatMap(splitAuthors),
  ]).filter((a) => !/^https?:/i.test(a) && !/\b(staff|editors?|team)\b$/i.test(a) && a.split(' ').length <= 5);

  const title = cleanTitle(
    meta('citation_title', 'dc.title', 'og:title', 'twitter:title')[0] ||
    (typeof ldFirst('headline') === 'string' ? clean(ldFirst('headline') as string) : '') ||
    clean(doc.querySelector('h1')?.textContent) ||
    clean(doc.title),
  );

  const publication =
    meta('citation_journal_title', 'citation_publisher', 'og:site_name', 'dc.publisher', 'application-name')[0] ||
    ldNames(ldFirst('publisher'))[0] ||
    hostLabel(url);

  const published =
    meta(
      'citation_publication_date',
      'citation_date',
      'citation_online_date',
      'article:published_time',
      'dc.date',
      'dcterms.created',
      'datePublished',
      'pubdate',
      'date',
      'parsely-pub-date',
      'sailthru.date',
    )[0] ||
    (typeof ldFirst('datePublished') === 'string' ? (ldFirst('datePublished') as string) : '') ||
    clean(doc.querySelector('time[datetime]')?.getAttribute('datetime'));

  const description = meta('description', 'og:description', 'citation_abstract')[0] ?? '';

  const bylineText = clean(
    Array.from(
      doc.querySelectorAll(
        '[class*="byline" i], [class*="author" i], [class*="contributor" i], [rel="author"], [itemprop="author"]',
      ),
    )
      .map((el) => spacedText(el))
      .filter((t) => t.length > 3 && t.length < 600)
      .slice(0, 8)
      .join(' | '),
  ).slice(0, 1500);

  const authorLinks = uniq(
    Array.from(
      doc.querySelectorAll<HTMLAnchorElement>(
        'a[rel="author"], [class*="byline" i] a[href], [class*="author" i] a[href], [itemprop="author"] a[href]',
      ),
    )
      .map((a) => {
        try {
          return new URL(a.getAttribute('href') ?? '', url).href;
        } catch {
          return '';
        }
      })
      .filter((h) => /^https?:/.test(h) && !/twitter\.com|x\.com|facebook|linkedin|mailto:|instagram/i.test(h)),
  ).slice(0, 3);

  const bioText = clean(
    Array.from(doc.querySelectorAll('[class*="bio" i], [class*="about-author" i], [class*="author-info" i], [class*="contributor" i]'))
      .map((el) => spacedText(el))
      .filter((t) => t.length > 20 && t.length < 1200)
      .slice(0, 4)
      .join(' | '),
  ).slice(0, 2000);

  // Bylines often sit in a page header outside <article>: keep the top
  // of the page (scripts and styles out) for the credential search.
  doc.querySelectorAll('script, style, noscript, template').forEach((el) => el.remove());
  const topText = spacedText(doc.body).slice(0, 6000);
  doc.querySelectorAll('nav, header, footer, aside, form').forEach((el) => el.remove());
  const body = doc.querySelector('article') ?? doc.querySelector('main') ?? doc.body;
  const fullText = spacedText(body);
  const excerpt = fullText.slice(0, 2500);
  // Article-end bios ("Jane Smith is a senior fellow at …") live in the tail.
  const tail = fullText.slice(-2500);

  return {
    url, title, publication, authors, published, description, bylineText, excerpt,
    authorLinks, bioText: clean(`${bioText} | ${tail} | ${topText}`).slice(0, 10000),
  };
}

const ROLE_WORDS =
  /\b(professor|fellow|director|president|chair(?:man|woman)?|founder|co-founder|editor|reporter|correspondent|columnist|writer|journalist|analyst|economist|researcher|scientist|scholar|lecturer|dean|chief|ceo|cfo|officer|minister|secretary|ambassador|senator|representative|advisor|adviser|consultant|attorney|lawyer|judge|physician|doctor|engineer|historian|author|contributor|manager|associate|partner|lead|head|candidate|student|expert|specialist|commissioner|governor|member|staff)\b/i;

/** Words that end a Title-Case byline credential ("… Editor Share"). */
const BYLINE_STOP = /^(?:Share|Updated|Published|Posted|By|Follow|Email|More|Read|Listen|Print|Save|Subscribe|Download|And|The|As|In|On)$/;

/** Keep a credential to its first clause and a sensible length:
 *  "co-host and reporter for Planet Money, NPR's award-winning podcast
 *  that…" → "co-host and reporter for Planet Money". */
function trimQualification(q: string): string {
  let out = clean(q).replace(/[,;:]$/, '');
  const comma = out.search(/,\s+(?:NPR|CNN|BBC|the|a|an|which|who|where|whose|and he|and she|and they|[A-Z][a-z]+'s)\b/);
  if (comma > 15) out = out.slice(0, comma);
  if (out.length > 160) out = out.slice(0, out.lastIndexOf(' ', 160)).replace(/[,;:]$/, '');
  return out;
}

/** One author's credentials from bio-like text: "Jane Smith is a senior
 *  fellow at Brookings.", "Jane Smith, senior fellow at Brookings", or a
 *  byline block "Jane Smith Senior Fellow, Economic Studies". Text after
 *  any of `others` (co-authors' names) is never taken as this author's.
 *  Returns '' when nothing credential-like is found. */
export function findQualifications(author: string, text: string, others: readonly string[] = []): string {
  if (!author || !text) return '';
  const last = lastName(author);
  const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const who = `(?:${esc(author)}|${esc(last)})`;
  const cutAtOthers = (q: string) => {
    let end = q.length;
    for (const o of others) {
      const i = q.indexOf(o);
      if (i >= 0) end = Math.min(end, i);
    }
    return q.slice(0, end);
  };
  const patterns = [
    new RegExp(`${who}\\s+(?:is|was|serves as|works as|has been)\\s+(?:an?\\s+|the\\s+)?([^.|]{8,260})`, 'i'),
    new RegExp(`${who},\\s+(?:an?\\s+|the\\s+)?([^.|]{8,200}?)(?:,\\s+(?:said|says|wrote|writes|argues|notes)|\\.|\\||$)`, 'i'),
  ];
  for (const re of patterns) {
    const m = re.exec(text);
    const q = trimQualification(cutAtOthers(m?.[1] ?? ''));
    if (q && ROLE_WORDS.test(q)) return q.charAt(0).toUpperCase() + q.slice(1);
  }
  // Byline block: the full name, then a run of Title-Case words.
  const block = new RegExp(`${esc(author)}\\s+((?:[A-Z][\\w&'-]*,?\\s+){1,7})`).exec(`${text} `);
  if (block?.[1]) {
    const words: string[] = [];
    for (const w of block[1].trim().split(/\s+/)) {
      if (BYLINE_STOP.test(w.replace(/,$/, ''))) break;
      words.push(w);
    }
    const q = trimQualification(cutAtOthers(words.join(' ')));
    if (q && ROLE_WORDS.test(q)) return q;
  }
  return '';
}

/** Credentials for every author; '' entries where none were found. */
export function qualificationsFor(meta: PageMeta): string[] {
  const text = `${meta.bylineText} | ${meta.bioText} | ${meta.excerpt}`;
  return meta.authors.map((a, i) => findQualifications(a, text, meta.authors.filter((_, j) => j !== i)));
}

/** Drop a site-name suffix: "Title | Council on Foreign Relations",
 *  "Title : Planet Money", "Title - The Hill". A real subtitle ("War:
 *  A History") has no space before its colon, so it's kept. */
export function cleanTitle(raw: string): string {
  let t = clean(raw);
  t = t.replace(/\s+\|\s+[^|]+$/, '');
  t = t.replace(/\s+:\s+[^:]+$/, '');
  t = t.replace(/\s+[-–—]\s+(?:[A-Z][\w.&']*(?:\s+[A-Z][\w.&']*){0,4})$/, '');
  return t.trim();
}

function hostLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** Parse a published date into a Date (local), or null. */
export function parseDate(raw: string): Date | null {
  const s = raw.trim();
  if (!s) return null;
  // Bare YYYY / YYYY-MM / YYYY-MM-DD and Highwire's YYYY/MM/DD.
  const m = /^(\d{4})(?:[-/](\d{1,2})(?:[-/](\d{1,2}))?)?/.exec(s);
  if (m && !/T\d/.test(s)) {
    return new Date(Number(m[1]), m[2] ? Number(m[2]) - 1 : 0, m[3] ? Number(m[3]) : 1);
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** The read-aloud date: M/D within a month of today, else the year as
 *  "24" / "9" (single-digit years), or the full year before 1950 — the
 *  same convention as the AI cite creator. */
export function shortDate(d: Date, now: Date = new Date()): string {
  const ageMs = now.getTime() - d.getTime();
  if (ageMs >= 0 && ageMs < 31 * 24 * 3600 * 1000) return `${d.getMonth() + 1}/${d.getDate()}`;
  const y = d.getFullYear();
  if (y < 1950) return String(y);
  return String(y % 100);
}

/** "Senior fellow at Brookings" → "senior fellow at Brookings" after
 *  "Smith is"; a Title-Case job title ("Deputy Managing Editor") stays. */
function lowerFirst(s: string): string {
  return /^[A-Z][a-z]+\s+[a-z]/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s;
}

function fullDate(d: Date): string {
  return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
}

function lastName(full: string): string {
  const parts = full.replace(/,?\s+(Jr\.?|Sr\.?|II|III|IV|PhD|Ph\.D\.|MD)$/i, '').trim().split(/\s+/);
  return parts[parts.length - 1] ?? full;
}

/** Deterministic cite from metadata alone (AI off, or as the fallback). */
export function formatPfCite(
  meta: PageMeta,
  now: Date = new Date(),
  quals: readonly string[] = qualificationsFor(meta),
): AiCiteResult {
  const date = parseDate(meta.published);
  const short = date ? shortDate(date, now) : 'ND';
  const authors = meta.authors;
  let lead: string;
  const tokens: string[] = [];
  if (authors.length === 0) {
    const org = meta.publication || hostLabel(meta.url) || 'Unknown';
    lead = `${org} ${short}`;
    tokens.push(lead);
  } else if (authors.length === 1) {
    lead = `${authors[0]} ${short}`;
    tokens.push(`${lastName(authors[0]!)} ${short}`);
  } else if (authors.length === 2) {
    lead = `${authors[0]} & ${authors[1]} ${short}`;
    tokens.push(`${lastName(authors[0]!)} & `, `${lastName(authors[1]!)} ${short}`);
  } else {
    lead = `${authors[0]} et al. ${short}`;
    tokens.push(`${lastName(authors[0]!)} et al. ${short}`);
  }
  const parts = [lead];
  if (authors.length === 1) {
    parts.push(quals[0] || '[qualifications]');
  } else if (authors.length > 1) {
    const each = authors.map((a, i) => `${lastName(a)} is ${quals[i] ? lowerFirst(quals[i]!) : '[qualifications]'}`);
    parts.push(each.join('; '));
  }
  if (meta.title) parts.push(`"${meta.title.replace(/"/g, '\'')},"`);
  if (meta.publication) parts.push(meta.publication);
  parts.push(date ? fullDate(date) : 'no date');
  parts.push(meta.url);
  parts.push(`accessed ${fullDate(now)}`);
  // `"Title,"` already ends in its comma; join the rest with ", ".
  const cite = parts.reduce((acc, p, i) => (i === 0 ? p : acc.endsWith(',"') ? `${acc} ${p}` : `${acc}, ${p}`), '');
  return { cite, tokens };
}

export const PF_CITE_PROMPT = `You write evidence citations for high school Public Forum debate cards, following the NSDA evidence rules.

A complete PF cite contains, in this order:
1. The read-aloud lead: author full name(s) followed by the short date. Short date is M/D when the piece is less than a month old as of today ({DATE}); otherwise the 2-digit year (single digit for 2001-2009, e.g. "9"; full year before 1950). Two authors: "First Last & First Last 24". Three or more: "First Last et al. 24". No author: the organization or publication name in the author slot.
2. Author qualifications — the credentials that make the author credible (position, employer, degree, expertise). Take them only from the byline, bio, or article text provided. If none are given, write "[qualifications]" so the debater knows to fill it in. Never invent credentials.
3. The full title in double quotes followed by a comma inside the quotes.
4. The publication or publisher.
5. The full publication date as M/D/YYYY (or YYYY when only the year is known; "no date" when unknown).
6. The full URL.
7. "accessed {DATE_SLASH}".

Examples:
Jane Smith 24, Senior Fellow in Foreign Policy at the Brookings Institution and former State Department official, "Why Sanctions Fail," Foreign Affairs, 3/14/2024, https://www.foreignaffairs.com/..., accessed {DATE_SLASH}
Laura Weiss & John Bresnahan 3/26, Weiss is a congressional reporter at Punchbowl News; Bresnahan is co-founder of Punchbowl News, "The House Is Stuck," Punchbowl News, 3/26/2026, https://punchbowl.news/..., accessed {DATE_SLASH}

Rules:
- Use only facts in the submission. Do not add a qualification, date, or name you were not given.
- Fix ALL-CAPS names and titles to normal capitalization. Translate non-English titles and credentials to English.
- Do not add any signature or initials at the end; the app adds the debater's own.

Respond in exactly this delimited format:

[[CITE]]
<the full citation on one line>
[[TOKENS]]
<one token per line>
[[END]]

TOKENS are the verbatim substrings to style as the read-aloud cite: LASTNAME(s) + SHORTDATE of the lead. One author "Jane Smith 24" → "Smith 24". Two authors "Laura Weiss & John Bresnahan 3/26" → "Weiss & " then "Bresnahan 3/26". Three+ "Jie Jiang et al. 23" → "Jiang et al. 23". Organization lead "Brookings Institution 24" → "Brookings Institution 24".`;

export function resolvePfPrompt(now: Date = new Date()): string {
  return PF_CITE_PROMPT.split('{DATE}')
    .join(`${now.getMonth() + 1}-${now.getDate()}-${now.getFullYear()}`)
    .split('{DATE_SLASH}')
    .join(fullDate(now));
}

/** The user message: what we know about the page, labeled. */
export function pfCiteUserMessage(meta: PageMeta, selected: string): string {
  return [
    `URL: ${meta.url}`,
    `Title: ${meta.title || '(none found)'}`,
    `Publication: ${meta.publication || '(none found)'}`,
    `Authors from metadata: ${meta.authors.join('; ') || '(none found)'}`,
    `Published: ${meta.published || '(none found)'}`,
    `Byline text: ${meta.bylineText || '(none found)'}`,
    `Author bio / article ending: ${meta.bioText || '(none found)'}`,
    `Description: ${meta.description || '(none)'}`,
    `Article opening: ${meta.excerpt || '(none)'}`,
    selected.trim() && selected.trim() !== meta.url ? `Text the debater selected: ${selected.trim()}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/** True when the cite can be written without asking Claude: an
 *  author (or organization), a date, a title, and credentials for every
 *  named author. */
export function citeIsComplete(meta: PageMeta, quals: readonly string[]): boolean {
  return (
    !!meta.title &&
    !!parseDate(meta.published) &&
    meta.authors.length > 0 &&
    quals.length === meta.authors.length &&
    quals.every((q) => q.length > 0)
  );
}

function emptyMeta(url: string): PageMeta {
  return {
    url, title: '', publication: hostLabel(url), authors: [], published: '',
    description: '', bylineText: '', excerpt: '', authorLinks: [], bioText: '',
  };
}

/** Fetch + read the page, then the author's profile page when the article
 *  itself carries no credentials. */
async function gatherMeta(url: string): Promise<{ meta: PageMeta; quals: string[] }> {
  const research = researchApi();
  if (!research) return { meta: emptyMeta(url), quals: [] };
  const page = await research.fetchPage(url);
  if (!page.ok) {
    showToast(`Couldn’t read the page (${page.error}).`, { durationMs: 3000 });
    return { meta: emptyMeta(url), quals: [] };
  }
  const meta = extractPageMetadata(page.html, page.url);
  let quals = qualificationsFor(meta);
  if (meta.authors.length > 0 && quals.some((q) => !q)) {
    for (const link of meta.authorLinks) {
      const profile = await research.fetchPage(link);
      if (!profile.ok) continue;
      const pm = extractPageMetadata(profile.html, profile.url);
      const text = `${pm.description} | ${pm.bioText} | ${pm.excerpt}`;
      quals = meta.authors.map((a, i) => quals[i] || findQualifications(a, text, meta.authors.filter((_, j) => j !== i)));
      meta.bioText = clean(`${meta.bioText} | ${pm.description} | ${pm.excerpt.slice(0, 1200)}`).slice(0, 5000);
      if (quals.every(Boolean)) break;
    }
  }
  return { meta, quals };
}

/** Inner start of the textblock that now holds the cite, searched near
 *  where it was written (the own-paragraph split can shift it by a
 *  block boundary). */
function findCiteBlock(doc: import('prosemirror-model').Node, near: number, cite: string): number | null {
  const probe = cite.slice(0, 24);
  let found: number | null = null;
  doc.nodesBetween(Math.max(0, near - 6), Math.min(doc.content.size, near + 6), (node, pos) => {
    if (found !== null) return false;
    if (node.isTextblock) {
      if (node.textContent.startsWith(probe)) found = pos + 1;
      return false;
    }
    return true;
  });
  return found;
}

/** The range to replace: the selection, or (empty selection) the
 *  textblock the caret is in when it holds a link; null otherwise. */
function linkTarget(view: EditorView): { from: number; to: number; text: string } | null {
  const { state } = view;
  const sel = state.selection;
  if (!sel.empty) {
    return { from: sel.from, to: sel.to, text: state.doc.textBetween(sel.from, sel.to, '\n', '\n') };
  }
  const $p = sel.$from;
  if (!$p.parent.isTextblock || !findUrl($p.parent.textContent)) return null;
  return { from: $p.start(), to: $p.end(), text: $p.parent.textContent };
}

/** Create PF Cite: from the link under the caret / in the selection, or
 *  (none there) from a link the user pastes into the prompt — then the
 *  cite goes in at the caret. */
export async function runPfCreateCite(view: EditorView): Promise<void> {
  let target = linkTarget(view);
  let url = target ? findUrl(target.text) : null;
  if (!url) {
    const typed = await promptForText({
      message: 'Paste the article link',
      placeholder: 'https://…',
      okLabel: 'Create cite',
      detail: 'Lucas’ Brain reads the page and writes the full cite — author, qualifications, date, title, publication, link and date accessed.',
    });
    if (!typed) return;
    url = findUrl(typed) ?? (findUrl(`https://${typed.trim()}`) as string | null);
    if (!url) {
      showToast('That doesn’t look like a link.');
      return;
    }
    const pos = view.state.selection.from;
    target = { from: pos, to: view.state.selection.to, text: url };
  }
  const lease = claimRegion(view, { from: target!.from, to: target!.to }, { label: 'cite' });
  if (!lease) {
    showToast('Another AI edit is working here — try again in a moment.');
    return;
  }
  const activity = new AiActivity(view, { from: target!.from, to: target!.to }, 'selection');
  activity.start();
  try {
    const { meta, quals } = await gatherMeta(url);
    let result: AiCiteResult | null = null;
    if (!citeIsComplete(meta, quals) && aiConfigured()) {
      // Something's missing — hand Claude everything found so far.
      try {
        const found = meta.authors.map((a, i) => `${a}: ${quals[i] || '(not found)'}`).join('; ');
        const reply = await callLlm({
          apiKey: activeApiKey(),
          system: resolvePfPrompt(),
          messages: [
            {
              role: 'user',
              content: `${pfCiteUserMessage(meta, target!.text)}\nQualifications found so far: ${found || '(none)'}`,
            },
          ],
        });
        result = parseCiteResponse(reply.text);
      } catch (e) {
        aiFailureNotice('Create PF Cite', e);
      }
    }
    result = withCiteSignature(result ?? formatPfCite(meta, new Date(), quals));
    const region = lease.region();
    if (!region) {
      showToast('Cite: that spot is no longer in the document.');
      return;
    }
    const tr = buildCiteTransaction(view.state, region.from, region.to, result);
    if (!tr) return;
    // The cite only — an empty tag line goes above it for the debater's
    // own tag, and the card body is left for them to cut.
    const citePos = findCiteBlock(tr.doc, region.from, result.cite);
    if (citePos !== null && tr.getMeta(CITE_TOKENS_MARKED_META) !== 0) ensureTagAboveCite(tr, citePos);
    lease.apply(tr);
    if (tr.getMeta(CITE_TOKENS_MARKED_META) === 0) {
      showToast('Cite added, but the author/date couldn’t be styled — select them and press F8.', { durationMs: 3500 });
    } else if (result.cite.includes('[qualifications]')) {
      showToast('Cite added — couldn’t find the author’s qualifications, so fill those in.', { durationMs: 3500 });
    }
  } catch (e) {
    aiFailureNotice('Create PF Cite', e);
  } finally {
    lease.release();
    activity.stop();
  }
}
