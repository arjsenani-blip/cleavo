/**
 * F7 never turns a cite into tag text: a selection that grazes the cite
 * keeps it as the new card's cite, F7 on a cite gives it an empty tag
 * above, and tag text typed in front of a cite is split off as the tag.
 */

import { describe, expect, it } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import type { Node as PMNode } from 'prosemirror-model';
import { schema } from '../../src/schema/index.js';
import { setTag, ensureTagAboveCite } from '../../src/editor/ribbon-commands.js';

const cite = (text: string) => schema.text(text, [schema.marks['cite_mark']!.create()]);
const p = (...inl: PMNode[]) => schema.nodes['paragraph']!.create(null, inl);
const doc = (...c: PMNode[]) => schema.nodes['doc']!.createChecked(null, c);

function run(d: PMNode, from: number, to = from): EditorState {
  let state = EditorState.create({ doc: d });
  state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, from, to)));
  let next: EditorState | null = null;
  expect(setTag()(state, (tr) => { next = state.apply(tr); })).toBe(true);
  return next!;
}

function shape(d: PMNode): string[] {
  const out: string[] = [];
  d.forEach((top) => {
    if (top.isTextblock) out.push(`${top.type.name}:${top.textContent}`);
    else top.forEach((c) => out.push(`${top.type.name}/${c.type.name}:${c.textContent}`));
  });
  return out;
}

describe('cite guard', () => {
  it('a selection grazing the cite line keeps the cite as a cite', () => {
    const d = doc(p(schema.text('Sanctions fail')), p(cite('Smith 24'), schema.text(', Professor')));
    // From the tag line into the first character of the cite line.
    const next = run(d, 1, 'Sanctions fail'.length + 4);
    expect(shape(next.doc)).toEqual(['card/tag:Sanctions fail', 'card/cite_paragraph:Smith 24, Professor']);
  });

  it('F7 on a cite gives it an empty tag above with the caret there', () => {
    const d = doc(p(cite('Smith 24'), schema.text(', Professor')));
    const next = run(d, 3);
    expect(shape(next.doc)).toEqual(['card/tag:', 'card/cite_paragraph:Smith 24, Professor']);
    expect(next.selection.$from.parent.type.name).toBe('tag');
  });

  it('tag text typed in front of a cite is split off as the tag', () => {
    const d = doc(p(schema.text('Sanctions fail '), cite('Smith 24'), schema.text(', Professor')));
    const next = run(d, 3);
    expect(shape(next.doc)).toEqual(['card/tag:Sanctions fail ', 'card/cite_paragraph:Smith 24, Professor']);
  });

  it('a plain paragraph still becomes a tag', () => {
    const next = run(doc(p(schema.text('Just a tag'))), 3);
    expect(shape(next.doc)).toEqual(['card/tag:Just a tag']);
  });

  it('ensureTagAboveCite adds a tag line above a loose cite', () => {
    const d = doc(p(cite('Smith 24'), schema.text(', Professor')));
    const state = EditorState.create({ doc: d });
    const tr = state.tr;
    ensureTagAboveCite(tr, 1);
    expect(shape(tr.doc)).toEqual(['card/tag:', 'card/cite_paragraph:Smith 24, Professor']);
  });
});
