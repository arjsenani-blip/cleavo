/**
 * The right-hand dock: Argument Map (case mode) and Evidence Search.
 *
 * Argument Map lists each contention's cards colored by role — the same
 * colors as the glows around the cards — and the missing pieces, each
 * with a one-click evidence search. Evidence Search signs in to
 * OpenCaselist, runs the research agent, and inserts the chosen card
 * (formatting intact) into the document.
 */

import { TextSelection } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { settings } from './settings.js';
import { showToast } from './toast.js';
import { aiConfigured } from './ai/llm.js';
import { researchApi } from './host/electron-host.js';
import { CaselistError, activeCaselist, insertableCard, signIn, signOut, signedIn } from './evidence/caselist.js';
import { runEvidenceAgent, type AgentPick } from './evidence/agent.js';
import { ROLE_LABEL, ROLE_NEED, type ArgGap, type ArgRole, type CaseAnalysis } from './case-mode/analyze.js';
import { caseModeKey, onCaseAnalysis, refreshCaseAnalysis, setFindEvidenceHandler } from './case-mode/case-mode-plugin.js';

type Tab = 'map' | 'evidence';

let getView: () => EditorView | null = () => null;
let dock: HTMLElement | null = null;
let activeTab: Tab = 'map';
/** Where an inserted card goes when the search came from a gap box. */
let insertAt: number | null = null;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

// ─── Shell ───────────────────────────────────────────────────────────

const panes: Record<Tab, HTMLElement> = {} as Record<Tab, HTMLElement>;
const tabButtons: Record<Tab, HTMLButtonElement> = {} as Record<Tab, HTMLButtonElement>;

function ensureDock(): HTMLElement {
  if (dock) return dock;
  dock = el('aside', 'lb-dock');
  dock.id = 'lb-dock';
  dock.setAttribute('aria-label', 'Lucas’ Brain sidebar');
  dock.hidden = true;

  const head = el('div', 'lb-dock-head');
  const tabs = el('div', 'lb-tabs');
  tabs.setAttribute('role', 'tablist');
  for (const [id, label] of [['map', 'Argument Map'], ['evidence', 'Evidence']] as [Tab, string][]) {
    const b = el('button', 'lb-tab', label);
    b.type = 'button';
    b.setAttribute('role', 'tab');
    b.addEventListener('click', () => showTab(id));
    tabButtons[id] = b;
    tabs.append(b);
  }
  const close = el('button', 'lb-icon-btn', '×');
  close.type = 'button';
  close.title = 'Close sidebar';
  close.setAttribute('aria-label', 'Close sidebar');
  close.addEventListener('click', closeDock);
  head.append(tabs, close);

  panes.map = el('div', 'lb-pane');
  panes.evidence = el('div', 'lb-pane');
  dock.append(head, panes.map, panes.evidence);
  document.body.append(dock);
  buildEvidencePane();
  return dock;
}

function showTab(tab: Tab): void {
  activeTab = tab;
  for (const t of ['map', 'evidence'] as Tab[]) {
    panes[t].hidden = t !== tab;
    tabButtons[t].setAttribute('aria-selected', String(t === tab));
    tabButtons[t].classList.toggle('lb-tab-on', t === tab);
  }
  if (tab === 'map') renderMap();
  else void refreshSignIn();
}

export function openDock(tab: Tab = activeTab): void {
  ensureDock().hidden = false;
  document.body.classList.add('lb-dock-open');
  showTab(tab);
}

export function closeDock(): void {
  if (dock) dock.hidden = true;
  document.body.classList.remove('lb-dock-open');
}

export function dockOpen(): boolean {
  return !!dock && !dock.hidden;
}

// ─── Argument Map ────────────────────────────────────────────────────

let lastAnalysis: CaseAnalysis | null = null;

const ROLE_ORDER: ArgRole[] = ['uniqueness', 'link', 'internal-link', 'impact'];

function renderMap(): void {
  if (!dock) return;
  const pane = panes.map;
  pane.replaceChildren();

  const mode = el('div', 'lb-segmented');
  for (const [m, label] of [['case', 'Case'], ['block', 'Block']] as const) {
    const b = el('button', 'lb-seg', label);
    b.type = 'button';
    b.classList.toggle('lb-seg-on', settings.get('cuttingMode') === m);
    b.addEventListener('click', () => settings.set('cuttingMode', m));
    mode.append(b);
  }
  pane.append(el('div', 'lb-label', 'Cutting mode'), mode);

  if (settings.get('cuttingMode') !== 'case') {
    pane.append(
      el(
        'p',
        'lb-muted',
        'Block mode keeps the page clean for cutting blocks and answers. Switch to Case to map your contentions: each card gets a glow by its role, and missing pieces show up as empty boxes where they belong.',
      ),
    );
    return;
  }

  const legend = el('div', 'lb-legend');
  for (const r of ROLE_ORDER) {
    const chip = el('span', `lb-chip lb-chip-${r}`, ROLE_LABEL[r]);
    legend.append(chip);
  }
  const missingChip = el('span', 'lb-chip lb-chip-missing', 'Missing');
  legend.append(missingChip);
  pane.append(legend);

  const a = lastAnalysis;
  if (!a || a.contentions.length === 0) {
    pane.append(el('p', 'lb-muted', 'No cards yet. Tag your cards (F7) under contention headings and the map fills in as you cut.'));
    return;
  }

  const status = el(
    'div',
    'lb-status',
    a.refined ? 'Reviewed by Claude' : aiConfigured() ? 'Quick read — Claude is reviewing…' : 'Quick read from your tags',
  );
  const again = el('button', 'lb-link-btn', 'Re-analyze');
  again.type = 'button';
  again.addEventListener('click', () => {
    const v = getView();
    if (v) refreshCaseAnalysis(v);
  });
  status.append(again);
  pane.append(status);

  for (const c of a.contentions) {
    const box = el('section', 'lb-contention');
    box.append(el('h3', 'lb-contention-title', c.title));
    const list = el('ol', 'lb-card-list');
    for (const card of c.cards) {
      const li = el('li', `lb-card-item lb-role-${card.role}`);
      const dot = el('span', 'lb-dot');
      const text = el('span', 'lb-card-tag', card.tag || '(empty tag)');
      const role = el('span', 'lb-card-role', ROLE_LABEL[card.role]);
      li.append(dot, text, role);
      li.tabIndex = 0;
      li.title = 'Jump to this card';
      const jump = () => jumpTo(card.pos + 2);
      li.addEventListener('click', jump);
      li.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') jump();
      });
      list.append(li);
    }
    box.append(list);
    for (const gap of c.gaps) {
      const g = el('div', 'lb-gap-item');
      g.append(el('div', 'lb-gap-item-head', `Missing ${ROLE_LABEL[gap.role].toLowerCase()}`));
      g.append(el('div', 'lb-gap-item-need', gap.suggestion || ROLE_NEED[gap.role]));
      const find = el('button', 'lb-btn lb-btn-small', 'Find evidence');
      find.type = 'button';
      find.addEventListener('click', () => searchForGap(gap, c.title));
      const show = el('button', 'lb-link-btn', 'Show spot');
      show.type = 'button';
      show.addEventListener('click', () => jumpTo(gap.at));
      g.append(find, show);
      box.append(g);
    }
    if (c.gaps.length === 0) box.append(el('div', 'lb-complete', 'Chain complete'));
    pane.append(box);
  }
}

function jumpTo(pos: number): void {
  const view = getView();
  if (!view) return;
  const at = Math.max(0, Math.min(pos, view.state.doc.content.size));
  try {
    view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(at))).scrollIntoView());
    view.focus();
  } catch {
    /* position no longer valid */
  }
}

function searchForGap(gap: ArgGap, contention: string): void {
  insertAt = gap.at;
  openDock('evidence');
  const view = getView();
  const a = view ? caseModeKey.getState(view.state)?.analysis : null;
  const c = a?.contentions.find((x) => x.title === contention);
  const context = c ? c.cards.map((k) => `- [${ROLE_LABEL[k.role]}] ${k.tag}`).join('\n') : '';
  setQuery(gap.suggestion || ROLE_NEED[gap.role]);
  void runSearch({ ask: gap.suggestion || ROLE_NEED[gap.role], role: `${ROLE_LABEL[gap.role]} card`, context: `Contention: ${contention}\n${context}` });
}

// ─── Evidence Search ─────────────────────────────────────────────────

let signInBox: HTMLElement;
let searchBox: HTMLElement;
let queryInput: HTMLTextAreaElement;
let progressLine: HTMLElement;
let results: HTMLElement;
let caselistChip: HTMLElement;
let busy = false;

function setQuery(q: string): void {
  if (queryInput) queryInput.value = q;
}

function buildEvidencePane(): void {
  const pane = panes.evidence;

  signInBox = el('form', 'lb-signin');
  signInBox.append(
    el('h3', 'lb-h', 'Sign in to OpenCaselist'),
    el('p', 'lb-muted', 'Use your Tabroom email and password. They go straight to OpenCaselist — Lucas’ Brain keeps only the session, encrypted on this computer.'),
  );
  const email = el('input', 'lb-input');
  email.type = 'email';
  email.placeholder = 'Tabroom email';
  email.autocomplete = 'username';
  const pass = el('input', 'lb-input');
  pass.type = 'password';
  pass.placeholder = 'Password';
  pass.autocomplete = 'current-password';
  const go = el('button', 'lb-btn', 'Sign in');
  go.type = 'submit';
  const err = el('p', 'lb-error');
  signInBox.append(email, pass, go, err);
  signInBox.addEventListener('submit', (e) => {
    e.preventDefault();
    err.textContent = '';
    go.disabled = true;
    go.textContent = 'Signing in…';
    signIn(email.value.trim(), pass.value)
      .then(() => {
        pass.value = '';
        return refreshSignIn();
      })
      .catch((x: unknown) => {
        err.textContent = x instanceof Error ? x.message : String(x);
      })
      .finally(() => {
        go.disabled = false;
        go.textContent = 'Sign in';
      });
  });

  searchBox = el('div', 'lb-search');
  const top = el('div', 'lb-search-top');
  caselistChip = el('span', 'lb-caselist-chip', '…');
  caselistChip.title = 'Caselist being searched — change it in Settings → OpenCaselist caselist';
  const out = el('button', 'lb-link-btn', 'Sign out');
  out.type = 'button';
  out.addEventListener('click', () => {
    void signOut().then(refreshSignIn);
  });
  top.append(caselistChip, out);
  queryInput = el('textarea', 'lb-input lb-query');
  queryInput.rows = 2;
  queryInput.placeholder = 'What should the card say? e.g. “tariffs raise consumer prices”';
  queryInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void runSearch({ ask: queryInput.value.trim() });
    }
  });
  const find = el('button', 'lb-btn', 'Search');
  find.type = 'button';
  find.addEventListener('click', () => {
    insertAt = null;
    void runSearch({ ask: queryInput.value.trim() });
  });
  progressLine = el('div', 'lb-progress');
  results = el('div', 'lb-results');
  searchBox.append(top, queryInput, find, progressLine, results);

  pane.append(signInBox, searchBox);
}

async function refreshSignIn(): Promise<void> {
  if (!dock) return;
  if (!researchApi()) {
    signInBox.hidden = true;
    searchBox.hidden = true;
    if (!panes.evidence.querySelector('.lb-desktop-only')) {
      panes.evidence.append(el('p', 'lb-muted lb-desktop-only', 'Evidence Search runs in the desktop app.'));
    }
    return;
  }
  const ok = await signedIn();
  signInBox.hidden = ok;
  searchBox.hidden = !ok;
  if (ok) {
    activeCaselist()
      .then((slug) => {
        caselistChip.textContent = slug;
      })
      .catch(() => {
        caselistChip.textContent = 'caselist';
      });
    queryInput.focus();
  }
}

async function runSearch(req: { ask: string; role?: string; context?: string }): Promise<void> {
  if (busy || !req.ask) return;
  if (!(await signedIn())) {
    await refreshSignIn();
    return;
  }
  busy = true;
  results.replaceChildren();
  progressLine.textContent = 'Starting…';
  progressLine.classList.add('lb-working');
  try {
    const picks = await runEvidenceAgent(req, (step) => {
      progressLine.textContent = step;
    });
    progressLine.textContent = picks.length
      ? `${picks.length} card${picks.length === 1 ? '' : 's'} found`
      : 'No matching cards — try different words.';
    for (const p of picks) results.append(resultCard(p));
  } catch (e) {
    progressLine.textContent = e instanceof Error ? e.message : String(e);
    if (e instanceof CaselistError && e.needsSignIn) await refreshSignIn();
  } finally {
    busy = false;
    progressLine.classList.remove('lb-working');
  }
}

function resultCard(p: AgentPick): HTMLElement {
  const box = el('article', 'lb-result');
  box.append(el('div', 'lb-result-tag', p.card.tag || '(untagged)'));
  if (p.card.cite) box.append(el('div', 'lb-result-cite', p.card.cite));
  if (p.why) box.append(el('div', 'lb-result-why', p.why));
  const body = el('div', 'lb-result-body', p.card.body.replace(/\s+/g, ' ').slice(0, 320) + (p.card.body.length > 320 ? '…' : ''));
  box.append(body);
  const src = el('div', 'lb-result-src', p.card.source.split('/').slice(-2).join(' · '));
  box.append(src);
  const actions = el('div', 'lb-result-actions');
  const insert = el('button', 'lb-btn lb-btn-small', insertAt !== null ? 'Insert in gap' : 'Insert');
  insert.type = 'button';
  insert.addEventListener('click', () => insertCard(p));
  const more = el('button', 'lb-link-btn', 'Show full text');
  more.type = 'button';
  more.addEventListener('click', () => {
    const full = body.classList.toggle('lb-full');
    body.textContent = full ? p.card.body : p.card.body.replace(/\s+/g, ' ').slice(0, 320) + '…';
    more.textContent = full ? 'Show less' : 'Show full text';
  });
  actions.append(insert, more);
  box.append(actions);
  return box;
}

function insertCard(p: AgentPick): void {
  const view = getView();
  if (!view) return;
  const { state } = view;
  const node = insertableCard(p.card);
  let at: number;
  if (insertAt !== null && insertAt <= state.doc.content.size) {
    at = insertAt;
  } else {
    // After the top-level block holding the caret.
    const $from = state.selection.$from;
    at = $from.depth >= 1 ? $from.after(1) : state.doc.content.size;
  }
  try {
    const tr = state.tr.insert(at, node);
    tr.setSelection(TextSelection.near(tr.doc.resolve(at + 2)));
    view.dispatch(tr.scrollIntoView());
    insertAt = null;
    showToast('Card inserted');
    view.focus();
  } catch {
    showToast('Couldn’t insert the card here — put the cursor between cards and try again.');
  }
}

// ─── Setup ───────────────────────────────────────────────────────────

export function setupDock(viewGetter: () => EditorView | null): void {
  getView = viewGetter;
  const syncBody = () => {
    document.body.classList.toggle('lb-page-view', settings.get('pageView'));
    const caseOn = settings.get('cuttingMode') === 'case';
    document.body.classList.toggle('lb-case-mode', caseOn);
    const modeBtn = document.getElementById('lb-mode-btn');
    if (modeBtn) {
      modeBtn.textContent = caseOn ? 'Case mode' : 'Block mode';
      modeBtn.setAttribute('aria-pressed', String(caseOn));
    }
  };
  syncBody();
  settings.subscribe(syncBody);
  setFindEvidenceHandler((gap, title) => searchForGap(gap, title));
  onCaseAnalysis((a, from) => {
    // Several panes may be open; the map follows the focused one.
    const active = getView();
    if (active && from !== active) return;
    lastAnalysis = a;
    if (dockOpen() && activeTab === 'map') renderMap();
  });
  settings.subscribe(() => {
    if (dockOpen() && activeTab === 'map') renderMap();
  });
}

/** The commands. */
export function toggleCaseMode(): void {
  const next = settings.get('cuttingMode') === 'case' ? 'block' : 'case';
  settings.set('cuttingMode', next);
  if (next === 'case') openDock('map');
  showToast(next === 'case' ? 'Case mode — argument map on' : 'Block mode');
}

export function openEvidenceSearch(): void {
  if (dockOpen() && activeTab === 'evidence') {
    closeDock();
    return;
  }
  insertAt = null;
  const view = getView();
  const sel = view?.state.selection;
  if (view && sel && !sel.empty) setQuery(view.state.doc.textBetween(sel.from, sel.to, ' ').slice(0, 300));
  openDock('evidence');
}

export function analyzeArguments(): void {
  const view = getView();
  if (settings.get('cuttingMode') !== 'case') settings.set('cuttingMode', 'case');
  openDock('map');
  if (view) refreshCaseAnalysis(view);
}
