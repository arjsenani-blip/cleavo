/**
 * Shrink (Mod-8) over a whole-card selection, Verbatim-style: only the
 * plain text shrinks. Underlined, emphasized, bold, highlighted and
 * background-colored text keeps its size.
 */

import { describe, expect, it } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import type { Node as PMNode } from 'prosemirror-model';
import { schema, newHeadingId } from '../../src/schema/index.js';
import { shrinkText, compileShrinkProtections } from '../../src/editor/ribbon-commands.js';

const m = (name: string, attrs?: Record<string, unknown>) => schema.marks[name]!.create(attrs);
const t = (text: string, ...marks: ReturnType<typeof m>[]) => schema.text(text, marks);

function tag(text: string) {
  return schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text(text));
}
function body(...inlines: ReturnType<typeof t>[]) {
  return schema.nodes['card_body']!.create(null, inlines);
}
function card(...children: PMNode[]) {
  return schema.nodes['card']!.createChecked(null, children);
}
function makeDoc(...children: PMNode[]) {
  return schema.nodes['doc']!.createChecked(null, children);
}

const NORMAL_PT = 11;

function effectivePt(node: PMNode | null, _parent: PMNode): number {
  const mark = node?.marks.find((mk) => mk.type.name === 'font_size');
  return mark ? Number(mark.attrs['halfPoints']) / 2 : NORMAL_PT;
}

const shrink = shrinkText(
  effectivePt,
  () => NORMAL_PT,
  () => false,
  () => compileShrinkProtections([], '', ''),
);

/** Select the whole document (the entire card) and run Shrink. */
function shrinkAll(doc: PMNode): EditorState {
  let state = EditorState.create({ doc });
  state = state.apply(
    state.tr.setSelection(TextSelection.between(state.doc.resolve(0), state.doc.resolve(state.doc.content.size))),
  );
  let next: EditorState | null = null;
  expect(shrink(state, (tr) => { next = state.apply(tr); })).toBe(true);
  return next!;
}

function ptOf(doc: PMNode, needle: string): number {
  let found = NaN;
  doc.descendants((node, _pos, parent) => {
    if (node.isText && node.text?.includes(needle) && parent) {
      found = effectivePt(node, parent);
      return false;
    }
    return true;
  });
  return found;
}

describe('shrink over a whole-card selection', () => {
  it('shrinks only unhighlighted, unformatted text', () => {
    const doc = makeDoc(
      card(
        tag('TAG'),
        body(
          t('plain one '),
          t('highlit', m('highlight', { color: 'yellow' })),
          t(' plain two '),
          t('underlined', m('underline_mark')),
          t(' plain three '),
          t('emphasized', m('emphasis_mark')),
          t(' plain four '),
          t('bolded', m('bold')),
          t(' plain five '),
          t('shaded', m('shading', { color: 'D2D2D2' })),
        ),
      ),
    );
    const next = shrinkAll(doc).doc;
    for (const plain of ['plain one', 'plain two', 'plain three', 'plain four', 'plain five']) {
      expect(ptOf(next, plain)).toBe(8);
    }
    for (const kept of ['highlit', 'underlined', 'emphasized', 'bolded', 'shaded']) {
      expect(ptOf(next, kept)).toBe(NORMAL_PT);
    }
    expect(ptOf(next, 'TAG')).toBe(NORMAL_PT);
  });

  it('treats an explicit "none" highlight as unhighlighted', () => {
    const doc = makeDoc(card(tag('TAG'), body(t('cleared', m('highlight', { color: 'none' })), t(' plain'))));
    expect(ptOf(shrinkAll(doc).doc, 'cleared')).toBe(8);
  });
});
