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
import { showConfirm } from '../confirm-dialog.js';
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

function lowerFirst(s: string): string {
  return /^[A-Z][a-z]+\s+[a-z]/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s;
}

function fullDate(d: Date): string {
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${mm}/${dd}/${d.getFullYear()}`;
}

function lastName(full: string): string {
  const parts = full.replace(/,?\s+(Jr\.?|Sr\.?|II|III|IV|PhD|Ph\.D\.|MD)$/i, '').trim().split(/\s+/);
  return parts[parts.length - 1] ?? full;
}

/** Deterministic cite from metadata alone (AI off, or as the fallback). */
/** Two-digit year, zero-padded: 2021 → "21", 2009 → "09". */
export function shortDate(d: Date, _now: Date = new Date()): string {
  return String(d.getFullYear() % 100).padStart(2, '0');
}

/** "Tremblay and Coburn 21" / "Miller 26" / "Smith et al. 21". */
export function citeLead(authors: readonly string[], publication: string, short: string): string {
  if (authors.length === 0) return `${publication || 'Unknown'} ${short}`;
  if (authors.length === 1) return `${lastName(authors[0]!)} ${short}`;
  if (authors.length === 2) return `${lastName(authors[0]!)} and ${lastName(authors[1]!)} ${short}`;
  return `${lastName(authors[0]!)} et al. ${short}`;
}

/** Deterministic cite from metadata alone (AI off, or as the fallback), in
 *  the card format:
 *
 *    Tremblay and Coburn 21 [Yann Allard-Tremblay and Elaine Coburn,
 *    <qualifications>, "Title", 06/09/2021, Publisher, URL,
 *    Accessed 09/03/2025]
 *
 *  The lead (last names + year) is the read-aloud part and carries the
 *  cite style; everything in brackets is the full citation. */
export function formatPfCite(
  meta: PageMeta,
  now: Date = new Date(),
  quals: readonly string[] = qualificationsFor(meta),
): AiCiteResult {
  const date = parseDate(meta.published);
  const short = date ? shortDate(date) : 'ND';
  const authors = meta.authors;
  const lead = citeLead(authors, meta.publication || hostLabel(meta.url), short);

  const inside: string[] = [];
  if (authors.length > 0) {
    const names =
      authors.length === 2 ? `${authors[0]} and ${authors[1]}` : authors.length > 2 ? `${authors.slice(0, -1).join(', ')}, and ${authors[authors.length - 1]}` : authors[0]!;
    inside.push(names);
    const known = authors.map((a, i) => (quals[i] ? (authors.length > 1 ? `${a.split(/\s+/)[0]} is ${lowerFirst(quals[i]!)}` : quals[i]!) : ''));
    inside.push(known.some(Boolean) ? known.filter(Boolean).join('; ') : '[qualifications]');
  }
  if (meta.title) inside.push(`"${meta.title.replace(/"/g, '\'')}"`);
  inside.push(date ? fullDate(date) : 'no date');
  if (meta.publication) inside.push(meta.publication);
  inside.push(meta.url);
  inside.push(`Accessed ${fullDate(now)}`);
  return { cite: `${lead} [${inside.join(', ')}]`, tokens: [lead] };
}

export const PF_CITE_PROMPT = `You write evidence citations for high school Public Forum debate cards, following the NSDA evidence rules, in this exact format:

LEAD [FULL NAMES, QUALIFICATIONS, "TITLE", MM/DD/YYYY, PUBLICATION, URL, Accessed {DATE_SLASH}]

- LEAD is what the debater reads aloud: the author's LAST name and the two-digit year. One author: "Miller 26". Two authors: "Tremblay and Coburn 21". Three or more: "Smith et al. 21". No author: the organization or publication name, e.g. "Brookings Institution 24". Years 2001-2009 are written "01"-"09".
- Inside the brackets:
  1. The full name(s): "Yann Allard-Tremblay and Elaine Coburn".
  2. The qualifications — the credentials that make the author credible (position, employer, degrees, expertise), taken only from the byline, bio, author page or article text provided. For several authors, give each person's credentials (e.g. "Yann is a member of the Huron-Wendat First Nation; Elaine is an Associate Professor of International Studies at York University"). If none are given, write "[qualifications]". Never invent credentials.
  3. The full title in double quotes.
  4. The publication date as MM/DD/YYYY with leading zeros (or YYYY when only the year is known; "no date" when unknown).
  5. The publication or publisher.
  6. The full URL.
  7. "Accessed {DATE_SLASH}".

Example:
Tremblay and Coburn 21 [Yann Allard-Tremblay and Elaine Coburn, Yann obtained his PhD in philosophy from the universities of St Andrews and Stirling and is a member of the Huron-Wendat First Nation; Elaine is an Associate Professor of International Studies at York University in Toronto, "The Flying Heads of Settler Colonialism; or the Ideological Erasures of Indigenous Peoples in Political Theorizing", 06/09/2021, SAGE Publications, https://journals.sagepub.com/doi/10.1177/00323217211018127, Accessed {DATE_SLASH}]

Rules:
- Use only facts in the submission. Do not add a qualification, date, or name you were not given.
- Fix ALL-CAPS names and titles to normal capitalization. Translate non-English titles and credentials to English.
- Do not add any signature or initials at the end; the app adds the debater's own.

Respond in exactly this delimited format:

[[CITE]]
<the full citation on one line>
[[TOKENS]]
<the LEAD exactly as written, e.g. Tremblay and Coburn 21>
[[END]]`;

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

/** Fill blanks in `base` from `extra` (a second read of the same page). */
function mergeMeta(base: PageMeta, extra: PageMeta): PageMeta {
  return {
    url: base.url || extra.url,
    title: base.title || extra.title,
    publication: base.publication && base.publication !== hostLabel(base.url) ? base.publication : extra.publication || base.publication,
    authors: base.authors.length > 0 ? base.authors : extra.authors,
    published: base.published || extra.published,
    description: base.description || extra.description,
    bylineText: clean(`${base.bylineText} | ${extra.bylineText}`).slice(0, 3000),
    excerpt: base.excerpt.length >= extra.excerpt.length ? base.excerpt : extra.excerpt,
    authorLinks: [...new Set([...base.authorLinks, ...extra.authorLinks])].slice(0, 4),
    bioText: clean(`${base.bioText} | ${extra.bioText}`).slice(0, 12000),
  };
}

const othersOf = (authors: readonly string[], i: number) => authors.filter((_, j) => j !== i);

/** Read the article, then — when the plain download is blocked or leaves
 *  the author or their credentials missing — open it in the hidden
 *  background browser (scripts run, the page scrolls to its end) and read
 *  that rendering too. Author profile pages get the same two-step read. */
async function gatherMeta(url: string): Promise<{ meta: PageMeta; quals: string[] }> {
  const research = researchApi();
  if (!research) return { meta: emptyMeta(url), quals: [] };
  const needsMore = (m: PageMeta, q: string[]) => m.authors.length === 0 || q.some((x) => !x) || !m.published;

  const page = await research.fetchPage(url);
  let meta = page.ok ? extractPageMetadata(page.html, page.url) : emptyMeta(url);
  let quals = qualificationsFor(meta);

  if ((!page.ok || needsMore(meta, quals)) && research.renderPage) {
    let rendered = await research.renderPage(url);
    // A bot check: never worked around — the user gets past it themselves
    // in a visible reader window, which reads the page once it appears.
    if (!rendered.ok && rendered.blocked) {
      const go = await showConfirm({
        title: 'This site checks for robots',
        message:
          'Cooky can’t read this article in the background. Open it in a reader window? Get past the site’s check there, and Cooky reads the page and closes the window.',
        confirmLabel: 'Open reader',
        cancelLabel: 'Cite from the link alone',
      });
      if (go) rendered = await research.renderPage(url, { visible: true });
    }
    if (rendered.ok) {
      meta = mergeMeta(meta, extractPageMetadata(rendered.html, rendered.url));
      quals = meta.authors.map((a, i) => quals[i] || findQualifications(a, `${meta.bylineText} | ${meta.bioText} | ${meta.excerpt}`, othersOf(meta.authors, i)));
    } else if (!page.ok) {
      showToast(`Couldn’t read the page (${rendered.error}).`, { durationMs: 3000 });
      return { meta, quals };
    }
  } else if (!page.ok) {
    showToast(`Couldn’t read the page (${page.error}).`, { durationMs: 3000 });
    return { meta, quals };
  }

  // Author profile pages: plain read first, the background browser if that
  // fails or still turns up no credentials.
  if (meta.authors.length > 0 && quals.some((q) => !q)) {
    for (const link of meta.authorLinks) {
      let profileText = '';
      const plain = await research.fetchPage(link);
      if (plain.ok) {
        const pm = extractPageMetadata(plain.html, plain.url);
        profileText = `${pm.description} | ${pm.bioText} | ${pm.excerpt}`;
      }
      const tryText = (text: string) =>
        meta.authors.map((a, i) => quals[i] || findQualifications(a, text, othersOf(meta.authors, i)));
      let next = tryText(profileText);
      if (next.some((q) => !q) && research.renderPage) {
        const rendered = await research.renderPage(link);
        if (rendered.ok) {
          const pm = extractPageMetadata(rendered.html, rendered.url);
          profileText = `${profileText} | ${pm.description} | ${pm.bioText} | ${pm.excerpt}`;
          next = tryText(profileText);
        }
      }
      quals = next;
      meta.bioText = clean(`${meta.bioText} | ${profileText.slice(0, 1500)}`).slice(0, 12000);
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
      detail: 'Cooky reads the page and writes the full cite — author, qualifications, date, title, publication, link and date accessed.',
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
