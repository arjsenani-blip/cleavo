/**
 * First-launch welcome: after the intro, ask for the user's name (the
 * home screen greets them with it) and their debate tag (the signature
 * every cite ends with), and an accent color (previewed live). All stay
 * editable in Settings → General → Cooky. Shown once; Skip counts as done.
 */

import { settings } from './settings.js';
import { ACCENT_PRESETS, applyAccent, normalizeHex } from './accent.js';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

export function maybeShowWelcome(): void {
  if (settings.get('onboarded')) return;
  if (document.body.classList.contains('pmd-mobile')) return;

  const overlay = el('div', 'lb-welcome');
  const card = el('form', 'lb-welcome-card');
  card.setAttribute('aria-labelledby', 'lb-welcome-title');
  const orb = el('div', 'lb-welcome-orb lb-orb');
  orb.append(el('div', 'lb-orb-field lb-orb-field-a'), el('div', 'lb-orb-field lb-orb-field-b'));
  orb.append(el('div', 'lb-orb-sheen'));
  const title = el('h1', 'lb-welcome-title', 'Welcome to Cooky');
  title.id = 'lb-welcome-title';
  const lead = el('p', 'lb-welcome-lead', 'Three quick things, and you’re cutting.');

  const nameLabel = el('label', 'lb-welcome-label', 'What should we call you?');
  const name = el('input', 'lb-input');
  name.type = 'text';
  name.placeholder = 'Your first name';
  name.autocomplete = 'given-name';
  name.value = settings.get('userName');
  nameLabel.append(name);

  const tagLabel = el('label', 'lb-welcome-label', 'Your debate tag');
  const tag = el('input', 'lb-input');
  tag.type = 'text';
  tag.placeholder = '// your initials';
  tag.value = settings.get('citeSignature');
  const hint = el('span', 'lb-welcome-hint', 'Every cite you create ends with it, so your cards are signed as you cut.');
  tagLabel.append(tag, hint);

  // Live preview of a cite ending in the tag.
  const preview = el('div', 'lb-welcome-preview');
  const sample = el('span', 'lb-welcome-sample', 'Smith 24, Senior Fellow at Brookings, “Why Sanctions Fail,” Foreign Affairs, 3/14/2024 ');
  const sig = el('strong', 'lb-welcome-sig');
  preview.append(sample, sig);
  const syncPreview = () => {
    sig.textContent = tag.value.trim();
  };
  tag.addEventListener('input', syncPreview);
  syncPreview();

  // Accent: preset swatches plus any custom color, previewed live.
  let accent = settings.get('accentColor');
  const accentLabel = el('div', 'lb-welcome-label', 'Pick your color');
  const swatches = el('div', 'lb-swatches');
  swatches.setAttribute('role', 'radiogroup');
  swatches.setAttribute('aria-label', 'Accent color');
  const swatchBtns: HTMLButtonElement[] = [];
  const custom = el('input', 'lb-swatch lb-swatch-custom');
  custom.type = 'color';
  custom.title = 'Any color';
  custom.setAttribute('aria-label', 'Custom accent color');
  const pick = (hex: string) => {
    accent = normalizeHex(hex) ?? accent;
    applyAccent(accent);
    custom.value = accent;
    for (const b of swatchBtns) b.setAttribute('aria-checked', String(b.dataset['hex'] === accent));
  };
  for (const p of ACCENT_PRESETS) {
    const b = el('button', 'lb-swatch');
    b.type = 'button';
    b.dataset['hex'] = p.hex;
    b.style.setProperty('--sw', p.hex);
    b.title = p.name;
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-label', p.name);
    b.addEventListener('click', () => pick(p.hex));
    swatchBtns.push(b);
    swatches.append(b);
  }
  custom.addEventListener('input', () => pick(custom.value));
  swatches.append(custom);
  accentLabel.append(swatches);
  pick(accent);

  const actions = el('div', 'lb-welcome-actions');
  const skip = el('button', 'lb-link-btn', 'Skip for now');
  skip.type = 'button';
  const go = el('button', 'lb-btn', 'Get started');
  go.type = 'submit';
  actions.append(skip, go);

  card.append(orb, title, lead, nameLabel, tagLabel, preview, accentLabel, actions);
  overlay.append(card);
  document.body.append(overlay);
  requestAnimationFrame(() => name.focus());

  const close = () => {
    settings.set('onboarded', true);
    overlay.classList.add('lb-welcome-out');
    setTimeout(() => overlay.remove(), 260);
  };
  card.addEventListener('submit', (e) => {
    e.preventDefault();
    settings.set('userName', name.value.trim().slice(0, 60));
    settings.set('citeSignature', tag.value.trim().slice(0, 80));
    settings.set('accentColor', accent);
    close();
  });
  skip.addEventListener('click', () => {
    applyAccent(); // back to the saved color
    close();
  });
  overlay.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      applyAccent();
      close();
    }
  });
}

/** "Good evening, Arjun" — or just "Cooky" before a name is set. */
export function greeting(now: Date = new Date()): string {
  const name = settings.get('userName').trim();
  if (!name) return 'Cooky';
  const h = now.getHours();
  const part = h < 5 ? 'Up late' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
  return `${part}, ${name}`;
}
