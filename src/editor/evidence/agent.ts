/**
 * Evidence Search agent: "find me a card that says X" → ranked cards
 * from OpenCaselist, cut and formatted as their authors cut them.
 *
 * Three model steps when AI is on, each a short delimited reply:
 *   1. plan    — turn the request (and the argument it's for) into a few
 *                caselist search queries;
 *   2. files   — pick the most promising files from the search hits;
 *   3. rank    — from the cards in those files (keyword-prefiltered),
 *                pick the best few and say in a line why each fits.
 * With AI off it runs the same pipeline on keywords alone.
 */

import { aiConfigured, activeApiKey, callLlm } from '../ai/llm.js';
import {
  activeCaselist,
  cardsInFile,
  scoreCard,
  search,
  terms,
  type FoundCard,
  type SearchHit,
} from './caselist.js';

export interface AgentPick {
  card: FoundCard;
  why: string;
}

export interface AgentRequest {
  /** What the debater is looking for, in their words. */
  ask: string;
  /** Optional: the argument it's for (tag chain, the missing piece). */
  context?: string;
  /** Optional: which side / role, e.g. "a link card". */
  role?: string;
}

export type AgentProgress = (step: string) => void;

const MAX_FILES = 4;
const MAX_PICKS = 6;
const PREFILTER = 24;

function section(text: string, name: string): string[] {
  const m = new RegExp(`\\[\\[\\s*${name}\\s*\\]\\]([\\s\\S]*?)(?:\\[\\[|$)`, 'i').exec(text);
  return (m?.[1] ?? '')
    .split(/\r?\n/)
    .map((l) => l.replace(/^[-*•]\s+/, '').trim())
    .filter(Boolean);
}

async function ask(system: string, user: string): Promise<string> {
  const reply = await callLlm({ apiKey: activeApiKey(), system, maxTokens: 1500, messages: [{ role: 'user', content: user }] });
  return reply.text;
}

const PLAN_PROMPT = `You help a high school debater find evidence on OpenCaselist, a wiki of debate files searched by keyword.
Write 2 to 4 short keyword searches (2-5 words each) that would surface cards making the requested claim. Prefer the distinctive nouns a card's tag or text would use. No quotes, no boolean operators.
Reply exactly:
[[QUERIES]]
<one search per line>
[[END]]`;

const FILES_PROMPT = `You pick which OpenCaselist files to open. Each hit shows its file path and a text snippet. Choose up to ${MAX_FILES} files most likely to contain a card making the requested claim. Prefer files whose snippet shows that claim.
Reply exactly:
[[FILES]]
<hit numbers, one per line>
[[END]]`;

const RANK_PROMPT = `You are a debate coach choosing evidence. Each numbered card shows its tag, cite and the start of its text. Pick up to ${MAX_PICKS} cards that best prove the requested claim, best first. Judge by what the card text actually says, not just the tag. Skip cards that don't fit.
For each pick give one short line saying what it proves for this argument.
Reply exactly:
[[PICKS]]
<number> | <why>
[[END]]`;

function requestBlock(req: AgentRequest): string {
  return [
    `Looking for: ${req.ask}`,
    req.role ? `Role in the argument: ${req.role}` : '',
    req.context ? `Argument so far:\n${req.context}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export async function runEvidenceAgent(req: AgentRequest, progress: AgentProgress): Promise<AgentPick[]> {
  const useAi = aiConfigured();
  progress('Finding the caselist…');
  const shard = await activeCaselist();

  // 1. Queries.
  let queries = [req.ask];
  if (useAi) {
    progress('Planning searches…');
    const planned = section(await ask(PLAN_PROMPT, requestBlock(req)), 'QUERIES').slice(0, 4);
    if (planned.length > 0) queries = planned;
  }

  // 2. Search.
  progress(`Searching ${shard} for ${queries.map((q) => `“${q}”`).join(', ')}…`);
  const hitLists = await Promise.all(queries.map((q) => search(q, shard).catch(() => [] as SearchHit[])));
  const byPath = new Map<string, SearchHit>();
  for (const list of hitLists) for (const h of list) if (!byPath.has(h.path)) byPath.set(h.path, h);
  const hits = [...byPath.values()].filter((h) => /\.docx$/i.test(h.path));
  if (hits.length === 0) return [];

  // 3. Files.
  let files = hits.slice(0, MAX_FILES);
  if (useAi && hits.length > MAX_FILES) {
    progress(`Reading ${hits.length} results…`);
    const listing = hits
      .slice(0, 30)
      .map((h, i) => `${i + 1}. ${h.path}\n   ${h.content.replace(/\s+/g, ' ').slice(0, 240)}`)
      .join('\n');
    const nums = section(await ask(FILES_PROMPT, `${requestBlock(req)}\n\nHits:\n${listing}`), 'FILES')
      .map((l) => Number.parseInt(l, 10) - 1)
      .filter((i) => i >= 0 && i < hits.length);
    if (nums.length > 0) files = [...new Set(nums)].slice(0, MAX_FILES).map((i) => hits[i]!);
  }

  // 4. Cards.
  progress(`Opening ${files.length} file${files.length === 1 ? '' : 's'}…`);
  const cards = (await Promise.all(files.map((f) => cardsInFile(f.path).catch(() => [] as FoundCard[])))).flat();
  if (cards.length === 0) return [];
  const words = terms(`${req.ask} ${queries.join(' ')}`);
  const ranked = cards
    .map((c) => ({ c, s: scoreCard(c, words) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, PREFILTER)
    .map((x) => x.c);
  if (ranked.length === 0) return [];
  if (!useAi) return ranked.slice(0, MAX_PICKS).map((card) => ({ card, why: '' }));

  // 5. Rank.
  progress(`Comparing ${ranked.length} cards…`);
  const listing = ranked
    .map((c, i) => `${i + 1}. TAG: ${c.tag}\n   CITE: ${c.cite.slice(0, 160)}\n   TEXT: ${c.body.replace(/\s+/g, ' ').slice(0, 500)}`)
    .join('\n');
  const picks: AgentPick[] = [];
  for (const line of section(await ask(RANK_PROMPT, `${requestBlock(req)}\n\nCards:\n${listing}`), 'PICKS')) {
    const m = /^(\d+)\s*[|:.-]?\s*(.*)$/.exec(line);
    const i = m ? Number(m[1]) - 1 : -1;
    const card = ranked[i];
    if (card && !picks.some((p) => p.card === card)) picks.push({ card, why: m?.[2]?.trim() ?? '' });
  }
  return picks.length > 0 ? picks.slice(0, MAX_PICKS) : ranked.slice(0, MAX_PICKS).map((card) => ({ card, why: '' }));
}
