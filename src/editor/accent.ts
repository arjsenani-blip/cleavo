/**
 * The user's accent color (Settings → Accent color; also asked on first
 * launch). One hex drives the whole theme: tints, rings, glows and the
 * frame's light come from its RGB; the text-on-card shade is derived per
 * theme — darkened until it reads on the light card (≥ 4.5:1), lightened
 * until it reads on the dark card (≥ 7:1) — so any pick stays legible.
 */

import { settings } from './settings.js';

export const DEFAULT_ACCENT = '#22d3ee';

/** Quick picks for the welcome card and Settings. */
export const ACCENT_PRESETS: readonly { name: string; hex: string }[] = [
  { name: 'Cyan', hex: '#22d3ee' },
  { name: 'Blue', hex: '#3b82f6' },
  { name: 'Violet', hex: '#8b5cf6' },
  { name: 'Pink', hex: '#ec4899' },
  { name: 'Red', hex: '#ef4444' },
  { name: 'Orange', hex: '#f97316' },
  { name: 'Gold', hex: '#eab308' },
  { name: 'Green', hex: '#22c55e' },
];

const LIGHT_CARD = '#fbfdfe';
const DARK_CARD = '#141820';

type RGB = [number, number, number];

export function normalizeHex(v: string): string | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v.trim());
  if (!m) return null;
  const h = m[1]!.length === 3 ? [...m[1]!].map((c) => c + c).join('') : m[1]!;
  return `#${h.toLowerCase()}`;
}

function rgb(hex: string): RGB {
  const h = hex.slice(1);
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as RGB;
}

function hex([r, g, b]: RGB): string {
  return `#${[r, g, b].map((c) => Math.round(Math.max(0, Math.min(255, c))).toString(16).padStart(2, '0')).join('')}`;
}

function mix(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function luminance([r, g, b]: RGB): number {
  const f = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(rgb(a)), luminance(rgb(b))].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** Mix toward `toward` in small steps until the color reads on `bg`. */
function legibleOn(color: string, bg: string, toward: RGB, min: number): string {
  const base = rgb(color);
  for (let t = 0; t <= 1.0001; t += 0.04) {
    const c = hex(mix(base, toward, t));
    if (contrast(c, bg) >= min) return c;
  }
  return hex(toward);
}

export interface AccentShades {
  rgb: string;
  base: string;
  deepLight: string;
  deepDark: string;
  tintTextDark: string;
}

export function accentShades(input: string): AccentShades {
  const base = normalizeHex(input) ?? DEFAULT_ACCENT;
  const [r, g, b] = rgb(base);
  return {
    rgb: `${r}, ${g}, ${b}`,
    base,
    deepLight: legibleOn(base, LIGHT_CARD, [0, 0, 0], 4.8),
    deepDark: legibleOn(base, DARK_CARD, [255, 255, 255], 7),
    tintTextDark: legibleOn(hex(mix(rgb(base), [255, 255, 255], 0.45)), DARK_CARD, [255, 255, 255], 9),
  };
}

export function applyAccent(input: string = settings.get('accentColor')): void {
  const s = accentShades(input);
  const st = document.documentElement.style;
  st.setProperty('--lb-accent-rgb', s.rgb);
  st.setProperty('--lb-accent-user', s.base);
  st.setProperty('--lb-deep-light', s.deepLight);
  st.setProperty('--lb-deep-dark', s.deepDark);
  st.setProperty('--lb-tint-text-dark', s.tintTextDark);
}

/** Keep the theme in step with the setting. */
export function setupAccent(): void {
  applyAccent();
  // The window frame's drifting color + grain layer (lucas-theme.css).
  if (!document.querySelector('.lb-ambient')) {
    const ambient = document.createElement('div');
    ambient.className = 'lb-ambient';
    ambient.setAttribute('aria-hidden', 'true');
    document.body.prepend(ambient);
  }
  let last = settings.get('accentColor');
  settings.subscribe((v) => {
    if (v.accentColor !== last) {
      last = v.accentColor;
      applyAccent(last);
    }
  });
}
