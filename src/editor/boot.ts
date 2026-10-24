/**
 * Page entry. When the startup intro is playing (html.lb-booting, set by
 * the head script), let it paint and hand its animations to the
 * compositor before the editor bundle loads: loading and running that
 * bundle occupies the main thread for a while, and an animation can't
 * start until the main thread commits it — without this wait the orb sat
 * frozen as a dot until the app finished booting. Once started, the
 * intro's transform/opacity animations run on the GPU regardless of
 * main-thread work. Without the intro, the editor loads immediately.
 */

const load = () => {
  void import('./index.js');
};

if (document.documentElement.classList.contains('lb-booting')) {
  requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(load, 0)));
} else {
  load();
}
