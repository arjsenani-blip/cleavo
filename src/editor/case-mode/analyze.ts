/**
 * Case-mode argument analysis: read the case's tags, give each card its
 * role in the argument chain, and find the pieces each contention is
 * missing.
 *
 * A contention is the run of cards under a pocket / hat / block heading.
 * The chain a PF contention is expected to make is
 *
 *   uniqueness → link → (internal link) → impact
 *
 * Roles come from the tag text: an explicit label first ("UQ:", "Link –",
 * "IL", "Impact:"), else keyword cues, else position. When AI is on, a
 * model pass refines both the roles and the gaps (see `refineWithAi`),
 * and its answer is cached by the tag text so it only reruns when tags
 * change. Nothing here touches the document — the results only drive
 * decorations and the sidebar.
 */

import type { Node as PMNode } from 'prosemirror-model';
import { aiConfigured, activeApiKey, callLlm } from '../ai/llm.js';

export type ArgRole = 'uniqueness' | 'link' | 'internal-link' | 'impact' | 'other';

export const ROLE_LABEL: Record<ArgRole, string> = {
  uniqueness: 'Uniqueness',
  link: 'Link',
  'internal-link': 'Internal link',
  impact: 'Impact',
  other: 'Other',
};

/** What each missing piece needs to show, for the gap box. */
export const ROLE_NEED: Record<Exclude<ArgRole, 'other'>, string> = {
  uniqueness: 'Show the problem or trend exists now (status quo), so your side changes something.',
  link: 'Show how your side causes the change — the direct connection to the resolution.',
  'internal-link': 'Bridge the link to the impact: why that change leads to the harm or benefit.',
  impact: 'Show why it matters — who is affected and how much (lives, money, rights).',
};

export interface ArgCard {
  /** Position of the card node (before it). */
  pos: number;
  end: number;
  tag: string;
  role: ArgRole;
}

export interface ArgGap {
  role: Exclude<ArgRole, 'other'>;
  /** Doc position (between blocks) where the missing card should go. */
  at: number;
  /** One-line suggestion of the card to find. */
  suggestion: string;
}

export interface Contention {
  title: string;
  /** Position of the heading (or of the first card when untitled). */
  pos: number;
  cards: ArgCard[];
  gaps: ArgGap[];
}

export interface CaseAnalysis {
  contentions: Contention[];
  /** True when roles/gaps came from the AI pass. */
  refined: boolean;
}

const LABELS: [RegExp, ArgRole][] = [
  [/^\s*(?:\[|\()?\s*(?:uq|uniq(?:ueness)?|non-?unique|n\/u)\b/i, 'uniqueness'],
  [/^\s*(?:\[|\()?\s*(?:il|internal\s*link|i\/l)\b/i, 'internal-link'],
  [/^\s*(?:\[|\()?\s*(?:link|l)\b\s*[-–—:|)\]]/i, 'link'],
  [/^\s*(?:\[|\()?\s*(?:link)\b/i, 'link'],
  [/^\s*(?:\[|\()?\s*(?:impact|imp|terminal\s*impact|i)\b\s*[-–—:|)\]]/i, 'impact'],
  [/^\s*(?:\[|\()?\s*(?:impact|imp)\b/i, 'impact'],
];

/** Weighted keyword cues per role. Weights let a causal tag ("Affirming
 *  causes a trade war") read as a link even though it names a harm,
 *  while terminal harms (deaths, extinction) still read as impacts. */
const CUES: Record<Exclude<ArgRole, 'other'>, [RegExp, number][]> = {
  uniqueness: [
    [/\b(now|currently|status quo|squo|today|already|right now|at present|this year|recent(?:ly)?|trend(?:s|ing)?|on the brink|brink|record (?:high|low)s?|rising|declining|growing|shrinking|is (?:high|low|strong|weak)|remains?|still)\b/i, 1],
    [/\b(20[12]\d)\b/, 0.4],
  ],
  link: [
    [/\b(affirming|negating|the resolution|the plan|passing|banning|adopting|implementing|repealing|withdrawing|imposing)\b/i, 1.3],
    [/\b(causes?|leads? to|results? in|increases?|decreases?|boosts?|undermines?|prevents?|allows?|enables?|forces?|means|would|will|makes?|reduces?|raises?|cuts?)\b/i, 0.8],
  ],
  'internal-link': [
    [/\b(in turn|which (?:then|leads|causes|means)|spill(?:s|over)?|cascades?|key to|triggers?|escalat\w*|snowball|feedback loop|that(?:'s| is) key)\b/i, 1.2],
  ],
  impact: [
    [/\b(extinction|deaths?|die[sd]?|dying|kill(?:s|ed|ing)?|lives|famine|starvation|genocide|nuclear war|nuclear|pandemic|catastroph\w*|human rights|suffering|poverty|disease)\b/i, 1.2],
    [/\b(war|recession|depression|collapse|crisis|millions?|billions?|trillions?|gdp|unemployment)\b/i, 0.6],
    [/\b\d[\d,.]*\s*(?:people|deaths|lives|jobs|%|percent)\b/i, 0.8],
  ],
};

/** Role from the tag alone, with the card's index in its contention as
 *  the tiebreaker (early cards lean uniqueness, late ones impact). */
export function classifyTag(tag: string, index: number, count: number): ArgRole {
  for (const [re, role] of LABELS) if (re.test(tag)) return role;
  const score: Record<Exclude<ArgRole, 'other'>, number> = { uniqueness: 0, link: 0, 'internal-link': 0, impact: 0 };
  for (const role of Object.keys(CUES) as (keyof typeof CUES)[]) {
    for (const [re, w] of CUES[role]) if (re.test(tag)) score[role] += w;
  }
  const rel = count > 1 ? index / (count - 1) : 0.5;
  score.uniqueness += rel < 0.34 ? 0.3 : 0;
  score.impact += rel > 0.66 ? 0.3 : 0;
  score.link += rel >= 0.25 && rel <= 0.75 ? 0.2 : 0;
  const best = (Object.entries(score) as [Exclude<ArgRole, 'other'>, number][]).sort((a, b) => b[1] - a[1])[0]!;
  return best[1] >= 0.75 ? best[0] : 'other';
}

const HEADING_TYPES = new Set(['pocket', 'hat', 'block']);

/** Group the doc's cards into contentions and classify each tag. */
export function readCase(doc: PMNode): Contention[] {
  const out: Contention[] = [];
  let current: Contention | null = null;
  doc.forEach((node, offset) => {
    const t = node.type.name;
    if (HEADING_TYPES.has(t)) {
      current = { title: node.textContent.trim() || 'Untitled', pos: offset, cards: [], gaps: [] };
      out.push(current);
      return;
    }
    if (t !== 'card') return;
    if (!current) {
      current = { title: 'Case', pos: offset, cards: [], gaps: [] };
      out.push(current);
    }
    current.cards.push({
      pos: offset,
      end: offset + node.nodeSize,
      tag: node.firstChild?.textContent.trim() ?? '',
      role: 'other',
    });
  });
  for (const c of out) {
    c.cards.forEach((card, i) => {
      card.role = classifyTag(card.tag, i, c.cards.length);
    });
  }
  return out.filter((c) => c.cards.length > 0);
}

/** Gaps in a contention's chain from its roles alone. */
export function findGaps(c: Contention): ArgGap[] {
  const has = (r: ArgRole) => c.cards.some((k) => k.role === r);
  const lastOf = (r: ArgRole) => [...c.cards].reverse().find((k) => k.role === r);
  const firstOf = (r: ArgRole) => c.cards.find((k) => k.role === r);
  const gaps: ArgGap[] = [];
  const first = c.cards[0]!;
  const last = c.cards[c.cards.length - 1]!;
  if (!has('uniqueness')) {
    gaps.push({ role: 'uniqueness', at: first.pos, suggestion: `Status-quo evidence for “${c.title}”.` });
  }
  if (!has('link')) {
    const after = lastOf('uniqueness');
    const before = firstOf('internal-link') ?? firstOf('impact');
    gaps.push({
      role: 'link',
      at: after ? after.end : before ? before.pos : last.end,
      suggestion: `A card showing your side causes the change in “${c.title}”.`,
    });
  }
  if (!has('impact')) {
    gaps.push({ role: 'impact', at: last.end, suggestion: `Evidence for why “${c.title}” matters — the size of the harm or benefit.` });
  }
  return gaps;
}

export function analyzeHeuristic(doc: PMNode): CaseAnalysis {
  const contentions = readCase(doc);
  for (const c of contentions) c.gaps = findGaps(c);
  return { contentions, refined: false };
}

// ─── AI refinement ───────────────────────────────────────────────────

interface AiVerdict {
  roles: ArgRole[];
  gaps: { contention: number; role: Exclude<ArgRole, 'other'>; afterCard: number; suggestion: string }[];
}

const verdictCache = new Map<string, AiVerdict>();
const inflight = new Map<string, Promise<AiVerdict | null>>();

export function tagSignature(contentions: Contention[]): string {
  return contentions.map((c) => `${c.title}\u0001${c.cards.map((k) => k.tag).join('\u0002')}`).join('\u0003');
}

const ROLE_WORDS: Record<string, ArgRole> = {
  uniqueness: 'uniqueness', uq: 'uniqueness', link: 'link', 'internal-link': 'internal-link',
  'internal link': 'internal-link', il: 'internal-link', impact: 'impact', other: 'other',
};

const REFINE_PROMPT = `You are a Public Forum debate coach reviewing a case outline. Each contention lists its cards by tag, numbered across the whole case.
1. Label every card's role in its contention's argument chain: uniqueness (the status quo / it's happening now), link (the resolution causes the change), internal-link (connects the link to the impact), impact (why it matters), or other (framework, definitions, background, analysis).
2. Find the missing logic: a step the chain needs that no card provides. For each, name the contention number, the missing role, the card number it should go after (0 = at the start of that contention), and a one-line description of the evidence to find.
Only flag gaps that really weaken the argument. Do not flag internal-link unless the jump from link to impact is genuinely unexplained.
Reply exactly:
[[ROLES]]
<card number> | <role>
[[GAPS]]
<contention number> | <role> | <after card number> | <evidence to find>
[[END]]`;

function sectionLines(text: string, name: string): string[] {
  const m = new RegExp(`\\[\\[\\s*${name}\\s*\\]\\]([\\s\\S]*?)(?:\\[\\[|$)`, 'i').exec(text);
  return (m?.[1] ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

export function parseVerdict(text: string, cardCount: number): AiVerdict {
  const roles: ArgRole[] = new Array(cardCount).fill('other');
  for (const line of sectionLines(text, 'ROLES')) {
    const [n, r] = line.split('|').map((x) => x.trim());
    const i = Number.parseInt(n ?? '', 10) - 1;
    const role = ROLE_WORDS[(r ?? '').toLowerCase()];
    if (i >= 0 && i < cardCount && role) roles[i] = role;
  }
  const gaps: AiVerdict['gaps'] = [];
  for (const line of sectionLines(text, 'GAPS')) {
    const [c, r, a, ...why] = line.split('|').map((x) => x.trim());
    const role = ROLE_WORDS[(r ?? '').toLowerCase()];
    const contention = Number.parseInt(c ?? '', 10) - 1;
    const afterCard = Number.parseInt(a ?? '', 10);
    if (!role || role === 'other' || contention < 0 || Number.isNaN(afterCard)) continue;
    gaps.push({ contention, role, afterCard, suggestion: why.join('|').trim() });
  }
  return { roles, gaps };
}

/** Apply a verdict onto a fresh heuristic read of the same tags. */
export function applyVerdict(contentions: Contention[], v: AiVerdict): CaseAnalysis {
  let n = 0;
  for (const c of contentions) {
    for (const card of c.cards) card.role = v.roles[n++] ?? card.role;
    c.gaps = [];
  }
  // Card numbers in the verdict are case-wide; map to positions.
  const flat = contentions.flatMap((c) => c.cards);
  for (const g of v.gaps) {
    const c = contentions[g.contention];
    if (!c) continue;
    const afterCard = g.afterCard > 0 ? flat[g.afterCard - 1] : undefined;
    const at = afterCard && c.cards.includes(afterCard) ? afterCard.end : g.afterCard === 0 ? c.cards[0]!.pos : c.cards[c.cards.length - 1]!.end;
    c.gaps.push({ role: g.role, at, suggestion: g.suggestion || ROLE_NEED[g.role] });
  }
  return { contentions, refined: true };
}

/** Cached AI verdict for these tags, if one has come back. */
export function cachedVerdict(sig: string): AiVerdict | undefined {
  return verdictCache.get(sig);
}

/** Ask the model about these tags (deduped, cached by signature). */
export function refineWithAi(contentions: Contention[]): Promise<AiVerdict | null> {
  const sig = tagSignature(contentions);
  const done = verdictCache.get(sig);
  if (done) return Promise.resolve(done);
  if (!aiConfigured()) return Promise.resolve(null);
  let p = inflight.get(sig);
  if (!p) {
    let n = 0;
    const outline = contentions
      .map((c, ci) => `Contention ${ci + 1}: ${c.title}\n${c.cards.map((k) => `  ${++n}. ${k.tag || '(empty tag)'}`).join('\n')}`)
      .join('\n\n');
    p = callLlm({
      apiKey: activeApiKey(),
      system: REFINE_PROMPT,
      maxTokens: 1500,
      messages: [{ role: 'user', content: outline }],
    })
      .then((reply) => {
        const v = parseVerdict(reply.text, n);
        verdictCache.set(sig, v);
        return v;
      })
      .catch(() => null)
      .finally(() => inflight.delete(sig));
    inflight.set(sig, p);
  }
  return p;
}
