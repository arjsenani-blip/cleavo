/**
 * Case mode's view layer: a glow around each card by its argument role
 * (cyan uniqueness, gold link, orange internal link, red impact) and an
 * empty dashed box where a missing piece belongs.
 *
 * Decorations only — node decorations add a class to the card's DOM and
 * widgets draw the gap boxes — so the document, its formatting, and
 * every export are untouched. Off in block mode.
 *
 * The heuristic read runs on every doc change (top-level walk, cheap);
 * the AI refinement runs debounced in the background and lands through
 * a meta transaction when it returns.
 */

import { Plugin, PluginKey, type EditorState } from 'prosemirror-state';
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view';
import { settings } from '../settings.js';
import {
  analyzeHeuristic,
  applyVerdict,
  cachedVerdict,
  readCase,
  refineWithAi,
  ROLE_LABEL,
  ROLE_NEED,
  tagSignature,
  type ArgGap,
  type CaseAnalysis,
} from './analyze.js';

export const caseModeKey = new PluginKey<CaseModeState>('lbCaseMode');

interface CaseModeState {
  analysis: CaseAnalysis | null;
  decorations: DecorationSet;
}

const REFRESH = 'lbCaseModeRefresh';
const AI_DEBOUNCE_MS = 2500;

/** Listeners (the sidebar) told whenever the analysis changes. */
const listeners = new Set<(a: CaseAnalysis | null, view: EditorView) => void>();
export function onCaseAnalysis(fn: (a: CaseAnalysis | null, view: EditorView) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Hook the gap box's "Find evidence" button calls (set by index.ts). */
let findEvidence: (gap: ArgGap, contentionTitle: string) => void = () => {};
export function setFindEvidenceHandler(fn: (gap: ArgGap, contentionTitle: string) => void): void {
  findEvidence = fn;
}

export function caseModeActive(): boolean {
  return settings.get('cuttingMode') === 'case';
}

function analyze(state: EditorState): CaseAnalysis | null {
  if (!caseModeActive()) return null;
  const contentions = readCase(state.doc);
  const v = cachedVerdict(tagSignature(contentions));
  if (v) return applyVerdict(contentions, v);
  return analyzeHeuristic(state.doc);
}

function gapWidget(gap: ArgGap, title: string): HTMLElement {
  const box = document.createElement('div');
  box.className = 'lb-gap';
  box.contentEditable = 'false';
  box.dataset['role'] = gap.role;
  const head = document.createElement('div');
  head.className = 'lb-gap-head';
  head.textContent = `Missing ${ROLE_LABEL[gap.role].toLowerCase()}`;
  const need = document.createElement('div');
  need.className = 'lb-gap-need';
  need.textContent = gap.suggestion || ROLE_NEED[gap.role];
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'lb-gap-find';
  btn.textContent = 'Find evidence';
  btn.addEventListener('mousedown', (e) => e.preventDefault());
  btn.addEventListener('click', () => findEvidence(gap, title));
  box.append(head, need, btn);
  return box;
}

function build(state: EditorState, analysis: CaseAnalysis | null): DecorationSet {
  if (!analysis) return DecorationSet.empty;
  const decos: Decoration[] = [];
  for (const c of analysis.contentions) {
    for (const card of c.cards) {
      if (card.role === 'other') continue;
      decos.push(Decoration.node(card.pos, card.end, { class: `lb-arg lb-arg-${card.role}` }));
    }
    for (const gap of c.gaps) {
      const key = `gap:${gap.role}:${gap.at}:${gap.suggestion}`;
      decos.push(Decoration.widget(gap.at, () => gapWidget(gap, c.title), { key, side: -1, ignoreSelection: true }));
    }
  }
  return DecorationSet.create(state.doc, decos);
}

export const caseModePlugin = new Plugin<CaseModeState>({
  key: caseModeKey,
  state: {
    init: (_c, state) => {
      const analysis = analyze(state);
      return { analysis, decorations: build(state, analysis) };
    },
    apply: (tr, prev, _old, state) => {
      if (!tr.docChanged && !tr.getMeta(REFRESH)) return prev;
      const analysis = analyze(state);
      return { analysis, decorations: build(state, analysis) };
    },
  },
  props: {
    decorations: (state) => caseModeKey.getState(state)?.decorations ?? DecorationSet.empty,
  },
  view: (view) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let lastSig = '';
    const schedule = () => {
      if (timer) clearTimeout(timer);
      if (!caseModeActive()) return;
      timer = setTimeout(() => {
        const contentions = readCase(view.state.doc);
        if (contentions.length === 0) return;
        void refineWithAi(contentions).then((v) => {
          if (v && !view.isDestroyed) view.dispatch(view.state.tr.setMeta(REFRESH, true));
        });
      }, AI_DEBOUNCE_MS);
    };
    const notify = () => {
      const a = caseModeKey.getState(view.state)?.analysis ?? null;
      for (const fn of listeners) fn(a, view);
    };
    const unsub = settings.subscribe(() => {
      const on = caseModeActive();
      document.body.classList.toggle('lb-case-mode', on);
      if (!view.isDestroyed) view.dispatch(view.state.tr.setMeta(REFRESH, true));
      if (on) schedule();
    });
    document.body.classList.toggle('lb-case-mode', caseModeActive());
    queueMicrotask(notify);
    schedule();
    return {
      update: (v, prevState) => {
        const prev = caseModeKey.getState(prevState);
        const cur = caseModeKey.getState(v.state);
        if (prev !== cur) notify();
        if (v.state.doc !== prevState.doc) {
          const sig = tagSignature(readCase(v.state.doc));
          if (sig !== lastSig) {
            lastSig = sig;
            schedule();
          }
        }
      },
      destroy: () => {
        if (timer) clearTimeout(timer);
        unsub();
      },
    };
  },
});

/** Force a re-read (the "Analyze Case Arguments" command). */
export function refreshCaseAnalysis(view: EditorView): void {
  view.dispatch(view.state.tr.setMeta(REFRESH, true));
  const contentions = readCase(view.state.doc);
  void refineWithAi(contentions).then((v) => {
    if (v && !view.isDestroyed) view.dispatch(view.state.tr.setMeta(REFRESH, true));
  });
}
