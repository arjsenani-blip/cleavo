/**
 * Case mode: tag → argument role, contention grouping, missing-piece
 * detection, and the AI verdict parser. Plus Evidence Search's card
 * extraction from a parsed caselist file.
 */

import { describe, expect, it } from 'vitest';
import type { Node as PMNode } from 'prosemirror-model';
import { schema, newHeadingId } from '../../src/schema/index.js';
import {
  analyzeHeuristic,
  applyVerdict,
  classifyTag,
  parseVerdict,
  readCase,
} from '../../src/editor/case-mode/analyze.js';
import { extractCards, insertableCard, scoreCard, terms } from '../../src/editor/evidence/caselist.js';

const block = (t: string) => schema.nodes['block']!.create({ id: newHeadingId() }, schema.text(t));
const card = (tag: string, body = 'text', cite?: string) =>
  schema.nodes['card']!.createChecked(null, [
    schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text(tag)),
    ...(cite ? [schema.nodes['cite_paragraph']!.create(null, schema.text(cite, [schema.marks['cite_mark']!.create()]))] : []),
    schema.nodes['card_body']!.create(null, schema.text(body)),
  ]);
const doc = (...c: PMNode[]) => schema.nodes['doc']!.createChecked(null, c);

describe('classifyTag', () => {
  it('reads explicit labels', () => {
    expect(classifyTag('UQ: tariffs high', 2, 3)).toBe('uniqueness');
    expect(classifyTag('Link – affirming raises prices', 0, 3)).toBe('link');
    expect(classifyTag('IL: prices crush demand', 0, 3)).toBe('internal-link');
    expect(classifyTag('Impact: recession', 0, 3)).toBe('impact');
  });
  it('reads cues', () => {
    expect(classifyTag('Tariffs are rising now', 0, 3)).toBe('uniqueness');
    expect(classifyTag('Affirming causes a trade war', 1, 3)).toBe('link');
    expect(classifyTag('Lack of coverage kills 45,000 people a year', 2, 3)).toBe('impact');
  });
});

describe('case analysis', () => {
  const d = doc(
    block('Contention 1: Economy'),
    card('Tariffs are rising now'),
    card('Affirming causes a trade war'),
    block('Contention 2: Health'),
    card('Uninsured rates are at a record high now'),
    card('Lack of coverage kills 45,000 people a year'),
  );

  it('groups cards under their contention', () => {
    const cs = readCase(d);
    expect(cs.map((c) => c.title)).toEqual(['Contention 1: Economy', 'Contention 2: Health']);
    expect(cs.map((c) => c.cards.map((k) => k.role))).toEqual([
      ['uniqueness', 'link'],
      ['uniqueness', 'impact'],
    ]);
  });

  it('flags the missing piece where it belongs', () => {
    const a = analyzeHeuristic(d);
    const [c1, c2] = a.contentions;
    expect(c1!.gaps.map((g) => g.role)).toEqual(['impact']);
    expect(c1!.gaps[0]!.at).toBe(c1!.cards[1]!.end);
    expect(c2!.gaps.map((g) => g.role)).toEqual(['link']);
    // Between the uniqueness card and the impact card.
    expect(c2!.gaps[0]!.at).toBe(c2!.cards[0]!.end);
  });

  it('parses and applies an AI verdict', () => {
    const v = parseVerdict(
      '[[ROLES]]\n1 | uniqueness\n2 | link\n3 | uniqueness\n4 | impact\n[[GAPS]]\n1 | impact | 2 | Evidence that a trade war causes a recession\n[[END]]',
      4,
    );
    const a = applyVerdict(readCase(d), v);
    expect(a.refined).toBe(true);
    expect(a.contentions[0]!.gaps).toEqual([
      { role: 'impact', at: a.contentions[0]!.cards[1]!.end, suggestion: 'Evidence that a trade war causes a recession' },
    ]);
    expect(a.contentions[1]!.gaps).toEqual([]);
  });
});

describe('evidence cards', () => {
  it('extracts cards with their section and cite', () => {
    const d = doc(block('Tariffs DA'), card('Tariffs raise prices', 'Consumer prices rose 3%.', 'Smith 24'));
    const cards = extractCards(d, 'hspf25/School/Team/file.docx');
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ tag: 'Tariffs raise prices', cite: 'Smith 24', section: 'Tariffs DA', body: 'Consumer prices rose 3%.' });
    const fresh = insertableCard(cards[0]!);
    expect(fresh.firstChild!.attrs['id']).not.toBe(cards[0]!.node.firstChild!.attrs['id']);
    expect(fresh.textContent).toBe(cards[0]!.node.textContent);
  });

  it('scores tag hits above body hits', () => {
    const d = doc(card('Tariffs raise prices', 'unrelated'), card('Unrelated', 'tariffs raise prices'));
    const [a, b] = extractCards(d, 'f.docx');
    const w = terms('tariffs raise prices');
    expect(scoreCard(a!, w)).toBeGreaterThan(scoreCard(b!, w));
  });
});
