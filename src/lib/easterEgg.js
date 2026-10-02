/**
 * Easter egg plumbing — the hidden DUSKFALL trigger.
 *
 * Discovery is deliberately invisible in normal use:
 *  - Desktop: the Konami code (↑ ↑ ↓ ↓ ← → ← → B A), typed anywhere
 *    outside a text field.
 *  - Mobile / touch: 7 quick taps on the version line in
 *    Settings → About, which dispatches UNLOCK_EVENT on window.
 *
 * This module is pure (no DOM, no backend) so the matcher can be
 * unit-tested in Node. The game itself is loaded lazily by
 * components/os/EasterEgg.jsx — nothing here ships in the game's
 * chunk, and the game ships nowhere near the boot bundle.
 */

export const KONAMI_SEQUENCE = [
  'ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown',
  'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight',
  'KeyB', 'KeyA',
];

/**
 * Prefix function (KMP) for the sequence, so a wrong key that ends
 * with a valid prefix keeps the overlap — e.g. typing an extra ↑
 * in "↑ ↑ ↑ ↓ …" does not restart from zero.
 */
function prefixFunction(seq) {
  const pi = new Array(seq.length).fill(0);
  for (let i = 1; i < seq.length; i++) {
    let j = pi[i - 1];
    while (j > 0 && seq[i] !== seq[j]) j = pi[j - 1];
    if (seq[i] === seq[j]) j++;
    pi[i] = j;
  }
  return pi;
}
const KONAMI_PI = prefixFunction(KONAMI_SEQUENCE);
/** Window event the Settings → About version line fires after 7 taps. */
export const UNLOCK_EVENT = 'drift:secret-game';

/**
 * Streaming matcher for the Konami code. feed(code) returns true
 * exactly once, on the key that completes the sequence. A wrong key
 * restarts matching but keeps any overlapping prefix (so
 * ↑ ↑ ↑ ↓ … still lines up). A pause longer than `timeoutMs`
 * between keys resets progress.
 */
export function createKonamiMatcher(timeoutMs = 2500) {
  let progress = 0;
  let lastAt = 0;
  return {
    feed(code, now = Date.now()) {
      if (lastAt && now - lastAt > timeoutMs) progress = 0;
      lastAt = now;
      if (code === KONAMI_SEQUENCE[progress]) {
        progress += 1;
      } else {
        while (progress > 0 && code !== KONAMI_SEQUENCE[progress]) progress = KONAMI_PI[progress - 1];
        if (code === KONAMI_SEQUENCE[progress]) progress += 1;
      }
      if (progress === KONAMI_SEQUENCE.length) {
        progress = 0;
        lastAt = 0;
        return true;
      }
      return false;
    },
    reset() {
      progress = 0;
      lastAt = 0;
    },
    get progress() {
      return progress;
    },
  };
}

/** True when a keyboard event is aimed at a text-entry surface. */
export function isEditableTarget(target) {
  if (!target || typeof target !== 'object') return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (target.isContentEditable) return true;
  return false;
}
