/**
 * Theme mode management: 'light' | 'dark' | 'system'.
 *
 * The *mode* is a per-user, per-device preference stored in localStorage —
 * the same rationale as ui_scale (no backend schema change needed, and
 * "follow the OS" is inherently a per-device concept). The *effective*
 * theme ('daybreak' | 'nightshift') is resolved from the mode and kept in
 * the backend `visual_theme` setting, so Helm, the backends, and anything
 * reading visual_theme keep seeing the real theme.
 */

export const THEME_MODES = ['light', 'dark', 'system'];

const keyFor = (uid) => `drift:theme-mode:${uid || 'anon'}`;

/** Load the persisted theme mode for a user (default 'light'). */
export function loadThemeMode(uid) {
  try {
    const v = localStorage.getItem(keyFor(uid));
    return THEME_MODES.includes(v) ? v : 'light';
  } catch {
    return 'light';
  }
}

/** Persist the theme mode for a user. Returns the stored mode. */
export function saveThemeMode(uid, mode) {
  const m = THEME_MODES.includes(mode) ? mode : 'light';
  try {
    localStorage.setItem(keyFor(uid), m);
  } catch {
    /* storage unavailable — the mode still applies for this session */
  }
  return m;
}

/** Whether the OS currently prefers a dark color scheme. */
export function systemPrefersDark() {
  try {
    return !!window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  } catch {
    return false;
  }
}

/** Resolve a theme mode to the effective backend theme name. */
export function resolveTheme(mode) {
  if (mode === 'dark') return 'nightshift';
  if (mode === 'light') return 'daybreak';
  return systemPrefersDark() ? 'nightshift' : 'daybreak'; // 'system'
}
