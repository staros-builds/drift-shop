/**
 * src/lib/sound.js — Vendra's synthesized UI sound effects.
 *
 * Zero audio assets: every sound is built at play time from Web Audio
 * oscillators and filtered noise. No dependencies beyond React (for the
 * tiny useSound hook).
 *
 * Safe to import anywhere, including jsdom/tests/SSR: every browser access
 * is guarded, and the public API no-ops gracefully when Web Audio or
 * localStorage is unavailable. playSound() never throws.
 *
 * Wiring (do this once, from a user gesture, to unlock audio on mobile):
 *
 *   import { initAudio, playSound } from './lib/sound.js';
 *   window.addEventListener('pointerdown', initAudio, { once: true });
 *   playSound('windowOpen');
 *
 * All times are in seconds.
 */

import { useState, useCallback } from 'react';

/* ------------------------------------------------------------------ */
/* persistent prefs                                                    */
/* ------------------------------------------------------------------ */

const KEY_ENABLED = 'drift:sound-enabled';
const KEY_VOLUME = 'drift:sound-volume';
const DEFAULT_VOLUME = 0.5;

function storage() {
  try {
    if (typeof window !== 'undefined' && window.localStorage) return window.localStorage;
  } catch {
    /* private mode / SSR / tests */
  }
  return null;
}

/** true unless the user explicitly turned sounds off. */
export function isEnabled() {
  const s = storage();
  if (!s) return true;
  const v = s.getItem(KEY_ENABLED);
  return v === null ? true : v === '1';
}

/** Persist the on/off flag ('1' / '0'). */
export function setEnabled(on) {
  const s = storage();
  if (s) {
    try {
      s.setItem(KEY_ENABLED, on ? '1' : '0');
    } catch {
      /* ignore */
    }
  }
}

/** 0..1; default 0.5 when unset or invalid. */
export function getVolume() {
  const s = storage();
  const v = s ? parseFloat(s.getItem(KEY_VOLUME)) : NaN;
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : DEFAULT_VOLUME;
}

/** Clamp to 0..1, persist, and apply live to the master gain. */
export function setVolume(v) {
  const clamped = Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : DEFAULT_VOLUME;
  const s = storage();
  if (s) {
    try {
      s.setItem(KEY_VOLUME, String(clamped));
    } catch {
      /* ignore */
    }
  }
  if (typeof ctx !== 'undefined' && ctx && master) {
    try {
      master.gain.setTargetAtTime(clamped, ctx.currentTime, 0.02);
    } catch {
      /* ignore */
    }
  }
}

/* ------------------------------------------------------------------ */
/* audio graph                                                         */
/* ------------------------------------------------------------------ */

let ctx = null; // AudioContext singleton
let master = null; // master GainNode (volume)
let noiseBuf = null; // shared 1s white-noise buffer

/**
 * Create (or resume) the AudioContext. Safe to call repeatedly.
 * Must be called from a user gesture at least once for mobile browsers.
 * Returns false (no-op) when Web Audio is unavailable. Never throws.
 */
export function initAudio() {
  try {
    if (typeof window === 'undefined') return false;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    if (!ctx) {
      // Build into locals first: if any step throws, ctx stays null and the
      // next call retries cleanly instead of keeping a half-wired graph.
      const c = new AC();
      const m = c.createGain();
      m.gain.value = getVolume();
      // Gentle limiter so layered sounds never clip harshly.
      const comp = c.createDynamicsCompressor();
      comp.threshold.value = -18;
      comp.ratio.value = 6;
      m.connect(comp);
      comp.connect(c.destination);
      ctx = c;
      master = m;
    }
    if (ctx.state === 'suspended') {
      try {
        const r = ctx.resume();
        if (r && typeof r.catch === 'function') r.catch(() => {});
      } catch {
        /* ignore */
      }
    }
    return true;
  } catch {
    return false;
  }
}

function getNoiseBuf() {
  if (!noiseBuf) {
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  return noiseBuf;
}

/** Short enveloped oscillator blip. t = delay from now, in seconds. */
function tone({ f0, f1 = f0, t = 0, dur = 0.15, type = 'sine', g = 0.25 }) {
  const t0 = ctx.currentTime + t;
  const osc = ctx.createOscillator();
  const env = ctx.createGain();
  const peak = Math.max(g, 0.0001); // exponential ramps can't target 0
  osc.type = type;
  osc.frequency.setValueAtTime(Math.max(f0, 1), t0);
  if (f1 !== f0) osc.frequency.exponentialRampToValueAtTime(Math.max(f1, 1), t0 + dur);
  env.gain.setValueAtTime(0.0001, t0);
  env.gain.exponentialRampToValueAtTime(peak, t0 + 0.008);
  env.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(env);
  env.connect(master);
  osc.start(t0);
  osc.stop(t0 + dur + 0.05);
}

/** Short enveloped burst of filtered noise (ticks, swishes, thunks). */
function noise({ t = 0, dur = 0.2, g = 0.3, type = 'bandpass', freq = 2000, f1 = 0, q = 1 }) {
  const t0 = ctx.currentTime + t;
  const src = ctx.createBufferSource();
  src.buffer = getNoiseBuf();
  src.loop = true;
  const flt = ctx.createBiquadFilter();
  flt.type = type;
  flt.frequency.setValueAtTime(Math.max(freq, 10), t0);
  flt.Q.value = q;
  if (f1 > 0) flt.frequency.exponentialRampToValueAtTime(Math.max(f1, 10), t0 + dur);
  const env = ctx.createGain();
  env.gain.setValueAtTime(0.0001, t0);
  env.gain.exponentialRampToValueAtTime(Math.max(g, 0.0001), t0 + 0.01);
  env.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  src.connect(flt);
  flt.connect(env);
  env.connect(master);
  src.start(t0);
  src.stop(t0 + dur + 0.05);
}

/* ------------------------------------------------------------------ */
/* the sounds — each is a short function of time; m = gain multiplier  */
/* ------------------------------------------------------------------ */

const SOUNDS = {
  /** Subtle UI tick. */
  click(m) {
    noise({ dur: 0.035, g: 0.1 * m, type: 'highpass', freq: 4500 });
  },
  /** Soft rising blip. */
  windowOpen(m) {
    tone({ f0: 420, f1: 840, dur: 0.12, g: 0.22 * m });
  },
  /** Soft falling blip. */
  windowClose(m) {
    tone({ f0: 640, f1: 320, dur: 0.13, g: 0.22 * m });
  },
  /** Downward slide + faint whoosh. */
  minimize(m) {
    tone({ f0: 520, f1: 180, dur: 0.2, type: 'triangle', g: 0.2 * m });
    noise({ dur: 0.15, g: 0.06 * m, type: 'lowpass', freq: 900 });
  },
  /** Gentle two-tone (A5 -> D6). */
  notification(m) {
    tone({ f0: 880, dur: 0.14, g: 0.22 * m });
    tone({ f0: 1174.66, t: 0.14, dur: 0.24, g: 0.22 * m });
  },
  /** Pleasant major chime, ~1.2s. */
  startupChime(m) {
    [523.25, 659.25, 783.99].forEach((f, i) => {
      tone({ f0: f, t: i * 0.28, dur: 0.65, type: 'triangle', g: 0.28 * m });
      tone({ f0: f * 2, t: i * 0.28, dur: 0.4, g: 0.07 * m });
    });
  },
  /** Ka-ching: metallic ping, then the drawer thunk. */
  cashRegister(m) {
    tone({ f0: 2093, dur: 0.18, type: 'square', g: 0.05 * m });
    tone({ f0: 2637, dur: 0.26, g: 0.16 * m });
    tone({ f0: 3136, t: 0.02, dur: 0.2, g: 0.07 * m });
    noise({ t: 0.1, dur: 0.16, g: 0.45 * m, type: 'lowpass', freq: 320 });
    tone({ f0: 120, f1: 60, t: 0.1, dur: 0.16, g: 0.32 * m });
  },
  /** Soft low double-buzz — deliberately mellow, not harsh. */
  error(m) {
    tone({ f0: 165, f1: 130, dur: 0.22, g: 0.3 * m });
    tone({ f0: 165, f1: 130, t: 0.24, dur: 0.26, g: 0.3 * m });
  },
  /** Warm rising confirm. */
  success(m) {
    tone({ f0: 523.25, dur: 0.12, type: 'triangle', g: 0.24 * m });
    tone({ f0: 659.25, t: 0.1, dur: 0.12, type: 'triangle', g: 0.24 * m });
    tone({ f0: 783.99, t: 0.2, dur: 0.26, type: 'triangle', g: 0.26 * m });
  },
  /** Paper-ish swish. */
  trash(m) {
    noise({ dur: 0.22, g: 0.26 * m, type: 'bandpass', freq: 1400, f1: 500, q: 0.7 });
    noise({ t: 0.05, dur: 0.18, g: 0.12 * m, type: 'highpass', freq: 3000 });
  },
  /* ---- DUSKFALL (original synth SFX for the arcade raycaster) ---- */
  /** Pistol crack. */
  duskPistol(m) {
    noise({ dur: 0.11, g: 0.5 * m, type: 'bandpass', freq: 1900, f1: 420, q: 0.8 });
    tone({ f0: 230, f1: 58, dur: 0.11, type: 'square', g: 0.22 * m });
  },
  /** Scattergun boom. */
  duskShotgun(m) {
    noise({ dur: 0.3, g: 0.62 * m, type: 'lowpass', freq: 950, f1: 140 });
    tone({ f0: 145, f1: 36, dur: 0.28, type: 'square', g: 0.3 * m });
  },
  /** Dry-fire click. */
  duskEmpty(m) {
    tone({ f0: 1250, dur: 0.05, type: 'square', g: 0.1 * m });
  },
  /** Enemy takes a hit. */
  duskHit(m) {
    noise({ dur: 0.07, g: 0.3 * m, type: 'bandpass', freq: 850, q: 1.4 });
  },
  /** Enemy death gurgle. */
  duskDie(m) {
    tone({ f0: 320, f1: 68, dur: 0.34, type: 'sawtooth', g: 0.26 * m });
    noise({ dur: 0.2, g: 0.18 * m, type: 'lowpass', freq: 520 });
  },
  /** Player takes damage. */
  duskHurt(m) {
    tone({ f0: 150, f1: 58, dur: 0.24, type: 'sawtooth', g: 0.32 * m });
  },
  /** Spitter ranged strike. */
  duskSpit(m) {
    noise({ dur: 0.16, g: 0.34 * m, type: 'bandpass', freq: 2600, f1: 700, q: 2 });
    tone({ f0: 700, f1: 180, dur: 0.14, type: 'sawtooth', g: 0.14 * m });
  },
  /** Pickup blip. */
  duskPickup(m) {
    tone({ f0: 660, f1: 1320, dur: 0.12, type: 'triangle', g: 0.24 * m });
  },
  /** Keycard chime. */
  duskKey(m) {
    tone({ f0: 660, dur: 0.1, type: 'triangle', g: 0.24 * m });
    tone({ f0: 990, t: 0.1, dur: 0.18, type: 'triangle', g: 0.24 * m });
  },
  /** Sliding door. */
  duskDoor(m) {
    noise({ dur: 0.34, g: 0.24 * m, type: 'lowpass', freq: 620, f1: 1250 });
    tone({ f0: 92, f1: 165, dur: 0.3, type: 'triangle', g: 0.14 * m });
  },
  /** Locked-door denial buzz. */
  duskDenied(m) {
    tone({ f0: 190, f1: 140, dur: 0.14, type: 'square', g: 0.16 * m });
    tone({ f0: 190, f1: 140, t: 0.16, dur: 0.16, type: 'square', g: 0.16 * m });
  },
  /** Sector-clear / victory arpeggio. */
  duskWin(m) {
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => {
      tone({ f0: f, t: i * 0.13, dur: 0.3, type: 'triangle', g: 0.26 * m });
    });
  },
  /** Defeat descent. */
  duskLose(m) {
    [330, 261.63, 196, 130.81].forEach((f, i) => {
      tone({ f0: f, t: i * 0.22, dur: 0.4, type: 'sawtooth', g: 0.2 * m });
    });
  },
};

/**
 * Play a named sound. Unknown names no-op silently. No-ops when disabled
 * or when Web Audio is unavailable (tests, SSR, old browsers).
 * Never throws. opts: { gain } — optional 0..1 volume multiplier.
 */
export function playSound(name, opts) {
  try {
    if (!isEnabled()) return;
    if (!initAudio() || !ctx || !master) return;
    const fn = SOUNDS[name];
    if (typeof fn !== 'function') return;
    const g =
      opts && typeof opts.gain === 'number' ? Math.min(1, Math.max(0, opts.gain)) : 1;
    fn(g);
  } catch {
    /* sound must never break the app */
  }
}

/**
 * Tiny React hook: { play, enabled, setEnabled }.
 * Toggling setEnabled re-renders the consumer.
 */
export function useSound() {
  const [enabled, setEnabledState] = useState(isEnabled);
  const setEnabledAndSync = useCallback((v) => {
    setEnabled(v);
    setEnabledState(isEnabled());
  }, []);
  return { play: playSound, enabled, setEnabled: setEnabledAndSync };
}
