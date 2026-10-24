/**
 * Startup intro, after Arc's: the window dims, a fluid gradient orb
 * grows from a point with a spring, the name staggers in letter by
 * letter, then the orb opens outward to reveal the app. Sound: a
 * filtered-noise whoosh as the orb grows, a soft chord with sparkle notes
 * as the name lands, and a swell on the reveal — all synthesized with Web
 * Audio, no audio files.
 *
 * The intro is part of index.html and a head script decides, before the
 * first paint, whether it plays (html.lb-booting): the launch window on
 * desktop, every load on the web, never when Settings → Startup animation
 * is off or in the phone layout. Its CSS runs on the compositor, so it
 * animates from the first frame while this bundle is still loading. This
 * module only times the sound and the reveal against that start
 * (window.__lbIntroT0) and cleans up. Any key or click skips it.
 */

import { settings } from './settings.js';

const REVEAL_AT_MS = 2050;
const REVEAL_MS = 650;
const REDUCED_MS = 900;

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

/** Play the intro's sound, `elapsed` seconds into the intro (events that
 *  have already passed are skipped, so it stays in sync with the visuals). */
function playIntroSound(elapsed: number): void {
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

  // `t` is when the intro started, in the audio clock. A fresh context's
  // clock starts at 0, so `t` is often negative: only events that are
  // still ahead (`due`) get scheduled — Web Audio throws on past times.
  const t = ctx.currentTime + 0.03 - elapsed;
  const due = (at: number) => t + at >= ctx.currentTime + 0.01;
  // 1. The orb grows: a rising whoosh (only if we're early enough).
  if (due(0.12) && elapsed < 0.3) whoosh(ctx, master, t + 0.12, 0.95, true, 0.22);
  // 2. The name lands: a warm A-major add9 pad…
  const pad: [number, number][] = [
    [220.0, -6], [329.63, 5], [440.0, -4], [493.88, 6], [554.37, 0],
  ];
  if (due(0.78)) {
    for (const [f, d] of pad) {
      tone(ctx, master, f, t + 0.78, 0.35, 2.4, 0.05, 'sine', d);
      tone(ctx, master, f, t + 0.78, 0.45, 2.2, 0.012, 'triangle', -d);
    }
  }
  // …with sparkle notes on top.
  [1318.51, 1760.0, 2217.46, 2637.02].forEach((f, i) => {
    const at = 0.86 + i * 0.07;
    if (due(at)) tone(ctx, master, f, t + at, 0.008, 0.9, 0.06);
  });
  // 3. The reveal: a gentle swell back down.
  const reveal = REVEAL_AT_MS / 1000;
  if (due(reveal - 0.1)) whoosh(ctx, master, t + reveal - 0.1, 0.7, false, 0.12);
  if (due(reveal)) tone(ctx, master, 880, t + reveal, 0.01, 1.2, 0.035);

  setTimeout(() => void ctx.close().catch(() => {}), 4500);
}

// ─── Play ────────────────────────────────────────────────────────────

/** Run the intro the page started (if it did). Resolves once it's gone. */
export async function playStartupSplash(): Promise<void> {
  const root = document.documentElement;
  const overlay = document.getElementById('lb-intro');
  if (!overlay) return;
  if (!root.classList.contains('lb-booting')) {
    overlay.remove();
    return;
  }
  const t0 = (window as unknown as { __lbIntroT0?: number }).__lbIntroT0 ?? performance.now();
  const elapsedMs = () => performance.now() - t0;
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

  let done = false;
  await new Promise<void>((resolve) => {
    const finish = () => {
      if (done) return;
      done = true;
      window.removeEventListener('keydown', finish, true);
      overlay.classList.add('lb-intro-out');
      setTimeout(() => {
        overlay.remove();
        root.classList.remove('lb-booting');
        resolve();
      }, reduced ? 250 : REVEAL_MS);
    };
    overlay.addEventListener('pointerdown', finish);
    window.addEventListener('keydown', finish, true);
    setTimeout(finish, Math.max(0, (reduced ? REDUCED_MS : REVEAL_AT_MS) - elapsedMs()));
    // Sound last, and never able to stop the reveal: the handlers above
    // are already in place whatever it does.
    if (settings.get('startupSound') && !reduced) {
      try {
        playIntroSound(elapsedMs() / 1000);
      } catch (e) {
        console.warn('[cardmirror] intro sound skipped:', e);
      }
    }
  });
}
