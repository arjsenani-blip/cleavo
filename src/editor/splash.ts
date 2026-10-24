/**
 * Startup splash, after Arc's intro: the window dims, a fluid gradient
 * orb (colors drifting inside it) grows from a point with a spring, the
 * name staggers in letter by letter, then the orb opens outward to reveal
 * the app. Sound: a filtered-noise whoosh as the orb grows, a soft chord
 * with sparkle notes as the name lands, and a swell on the reveal — all
 * synthesized with Web Audio, no audio files.
 *
 * Plays every time the app opens (the launch's first window; windows
 * opened later skip it), never in the mobile layout, and only while
 * Settings → Startup animation is on. Reduced motion gets a short fade.
 * Any key or click skips it.
 */

import { settings } from './settings.js';
import { claimLaunchSplash } from './host/electron-host.js';

const REVEAL_AT_MS = 2050;
const REVEAL_MS = 650;
const REDUCED_MS = 900;

function el(cls: string, text?: string): HTMLDivElement {
  const d = document.createElement('div');
  d.className = cls;
  if (text != null) d.textContent = text;
  return d;
}

function buildOrb(): HTMLDivElement {
  const orb = el('lb-orb');
  for (let i = 1; i <= 4; i++) orb.append(el(`lb-orb-blob lb-orb-blob-${i}`));
  orb.append(el('lb-orb-sheen'));
  return orb;
}

/** "Cooky", one span per letter for the stagger. */
function buildWord(): HTMLDivElement {
  const word = el('lb-intro-word');
  word.setAttribute('aria-label', 'Cooky');
  [...'Cooky'].forEach((ch, i) => {
    const s = document.createElement('span');
    s.textContent = ch === ' ' ? ' ' : ch;
    s.style.setProperty('--i', String(i));
    s.setAttribute('aria-hidden', 'true');
    word.append(s);
  });
  return word;
}

// ─── Sound ───────────────────────────────────────────────────────────

function noiseBuffer(ctx: AudioContext, seconds: number): AudioBuffer {
  const buf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * seconds), ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return buf;
}

/** Filtered noise sweeping up (or down) in pitch and across the stereo field. */
function whoosh(ctx: AudioContext, out: AudioNode, at: number, len: number, up: boolean, level: number): void {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx, len + 0.1);
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.Q.value = 1.4;
  bp.frequency.setValueAtTime(up ? 260 : 2600, at);
  bp.frequency.exponentialRampToValueAtTime(up ? 3200 : 380, at + len);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(level, at + len * 0.6);
  g.gain.exponentialRampToValueAtTime(0.0001, at + len);
  const pan = ctx.createStereoPanner();
  pan.pan.setValueAtTime(up ? -0.6 : 0.5, at);
  pan.pan.linearRampToValueAtTime(up ? 0.5 : -0.3, at + len);
  src.connect(bp).connect(g).connect(pan).connect(out);
  src.start(at);
  src.stop(at + len + 0.05);
}

function tone(
  ctx: AudioContext,
  out: AudioNode,
  freq: number,
  at: number,
  attack: number,
  len: number,
  level: number,
  type: OscillatorType = 'sine',
  detune = 0,
): void {
  const osc = ctx.createOscillator();
  osc.type = type;
  osc.frequency.value = freq;
  osc.detune.value = detune;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(level, at + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, at + len);
  osc.connect(g).connect(out);
  osc.start(at);
  osc.stop(at + len + 0.05);
}

function playIntroSound(): void {
  const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) return;
  let ctx: AudioContext;
  try {
    ctx = new Ctx();
  } catch {
    return;
  }
  const master = ctx.createGain();
  master.gain.value = 0.5;
  // Soft space: a lowpass to round the edges, a feedback delay for air.
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 7000;
  const delay = ctx.createDelay(1);
  delay.delayTime.value = 0.23;
  const fb = ctx.createGain();
  fb.gain.value = 0.32;
  const wet = ctx.createGain();
  wet.gain.value = 0.3;
  master.connect(lp).connect(ctx.destination);
  lp.connect(delay);
  delay.connect(fb).connect(delay);
  delay.connect(wet).connect(ctx.destination);

  const t = ctx.currentTime + 0.05;
  // 1. The orb grows: a rising whoosh.
  whoosh(ctx, master, t, 0.95, true, 0.22);
  // 2. The name lands: a warm A-major add9 pad…
  const pad: [number, number][] = [
    [220.0, -6], [329.63, 5], [440.0, -4], [493.88, 6], [554.37, 0],
  ];
  for (const [f, d] of pad) {
    tone(ctx, master, f, t + 0.78, 0.35, 2.4, 0.05, 'sine', d);
    tone(ctx, master, f, t + 0.78, 0.45, 2.2, 0.012, 'triangle', -d);
  }
  // …with sparkle notes on top.
  [1318.51, 1760.0, 2217.46, 2637.02].forEach((f, i) => {
    tone(ctx, master, f, t + 0.86 + i * 0.07, 0.008, 0.9, 0.06);
  });
  // 3. The reveal: a gentle swell back down.
  whoosh(ctx, master, t + REVEAL_AT_MS / 1000 - 0.1, 0.7, false, 0.12);
  tone(ctx, master, 880, t + REVEAL_AT_MS / 1000, 0.01, 1.2, 0.035);

  setTimeout(() => void ctx.close().catch(() => {}), 4500);
}

// ─── Play ────────────────────────────────────────────────────────────

/** Show the intro when the app opens. Resolves once it has cleared. */
export async function playStartupSplash(): Promise<void> {
  if (!settings.get('startupAnimation')) return;
  if (document.body.classList.contains('pmd-mobile')) return;
  // Desktop: the first window of each launch (windows opened later skip
  // it). Web: every load.
  if ((await claimLaunchSplash()) === false) return;

  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  const overlay = el(`lb-intro${reduced ? ' lb-intro-reduced' : ''}`);
  overlay.setAttribute('role', 'presentation');
  const stage = el('lb-intro-stage');
  stage.append(buildOrb(), buildWord(), el('lb-intro-sub', 'Cut cards · Write cites · Find evidence'));
  overlay.append(stage);
  document.body.append(overlay);

  if (settings.get('startupSound') && !reduced) playIntroSound();

  let done = false;
  await new Promise<void>((resolve) => {
    const finish = () => {
      if (done) return;
      done = true;
      window.removeEventListener('keydown', finish, true);
      overlay.classList.add('lb-intro-out');
      setTimeout(() => {
        overlay.remove();
        resolve();
      }, reduced ? 250 : REVEAL_MS);
    };
    overlay.addEventListener('pointerdown', finish);
    window.addEventListener('keydown', finish, true);
    setTimeout(finish, reduced ? REDUCED_MS : REVEAL_AT_MS);
  });
}
