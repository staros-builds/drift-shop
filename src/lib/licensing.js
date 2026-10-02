/**
 * Licensing — pure logic, no imports (unit-testable).
 *
 * Shop licensing model (migration 072):
 *   - Every shop (pos_stores row) starts a free trial the moment it is
 *     created: TRIAL_DAYS days of full use, clock stamped server-side.
 *   - When the trial (or a paid term) runs out, the shop LOCKS. Nothing
 *     is ever deleted — the data simply waits behind the lock screen.
 *   - The shop owner unlocks by typing a one-time key ("serial") that the
 *     platform owner generates. Keys are lifetime or term (N months).
 *
 * The server is the source of truth (shop_licenses + redeem RPC). This
 * module mirrors the same rules for the UI: key formatting/validation,
 * effective-status computation for display, and the app-level gate
 * decision (who sees the lock screen).
 */

// The trial length, in days. ONE place on the client; the server stamps
// trial_ends_at with the same value (migration 072, handle_new_pos_store).
// The server's stamp is authoritative — this constant only drives the
// "days left" wording before the row exists / for tests.
export const TRIAL_DAYS = 30;

// Unambiguous key alphabet: no 0/O, no 1/I/L — a key read over the phone
// or copied off paper can't be mistyped into a look-alike character.
export const KEY_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const KEY_LENGTH = 16; // shown as XXXX-XXXX-XXXX-XXXX

const ALPHABET_SET = new Set(KEY_ALPHABET.split(''));

/** Strip dashes/spaces, uppercase. 'ab3d-ef5g' -> 'AB3DEF5G'. */
export function normalizeKey(input) {
  return String(input ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

/** True when the input is exactly one well-formed key. */
export function isValidKeyFormat(input) {
  const k = normalizeKey(input);
  if (k.length !== KEY_LENGTH) return false;
  for (const ch of k) if (!ALPHABET_SET.has(ch)) return false;
  return true;
}

/** 'AB3DEF5GHJ7K' (16) -> 'AB3D-EF5G-HJ7K-MNPQ' style grouping. */
export function formatKey(input) {
  const k = normalizeKey(input).slice(0, KEY_LENGTH);
  return k.replace(/(.{4})(?=.)/g, '$1-');
}

/**
 * Format-as-you-type for the key entry box: keep only alphabet
 * characters (so a stray 'O' is dropped, not silently accepted),
 * uppercase, and group in fours.
 */
export function groupKeyInput(value) {
  const clean = normalizeKey(value)
    .split('')
    .filter((ch) => ALPHABET_SET.has(ch))
    .join('')
    .slice(0, KEY_LENGTH);
  return clean.replace(/(.{4})(?=.)/g, '$1-');
}

/**
 * Effective status of one shop_licenses row at `now` (ms epoch).
 * Mirrors public.license_effective_status() in migration 072.
 * row: { status, trial_ends_at, current_period_ends_at }
 */
export function effectiveStatus(row, now = Date.now()) {
  if (!row) return 'none';
  if (row.status === 'active') {
    if (!row.current_period_ends_at) return 'active'; // lifetime
    return new Date(row.current_period_ends_at).getTime() > now ? 'active' : 'locked';
  }
  if (row.status === 'trial') {
    return new Date(row.trial_ends_at).getTime() > now ? 'trial' : 'locked';
  }
  return 'locked';
}

/** Whole days remaining until an ISO timestamp (never negative). */
export function daysLeft(iso, now = Date.now()) {
  if (!iso) return 0;
  const ms = new Date(iso).getTime() - now;
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.ceil(ms / 86_400_000);
}

/**
 * App-level gate decision.
 *
 * rows: my_license_status() rows — [{ store_id, store_name, my_role,
 *   effective_status, trial_ends_at, current_period_ends_at, plan }]
 * profile: the caller's access profile (role / is_master).
 *
 * Returns { locked: false } when the app may open, or
 * { locked: true, stores } when EVERY shop the user belongs to is
 * locked. Platform admins and the platform master are never locked
 * (their own workspace must always open). A user with no shop yet is
 * never locked — no trial clock is running for them.
 */
export function licenseGateDecision(rows, profile) {
  // No profile (read failed): fail open, exactly like the access gate —
  // a broken profile read must never present as a license lock.
  if (!profile) return { locked: false, noProfile: true };
  if (profile.role === 'admin' || profile.is_master) {
    return { locked: false, bypass: true };
  }
  const list = Array.isArray(rows) ? rows : [];
  if (list.length === 0) return { locked: false, noShop: true };
  const anyOpen = list.some(
    (r) => r.effective_status === 'trial' || r.effective_status === 'active'
  );
  if (anyOpen) return { locked: false };
  return { locked: true, stores: list };
}

/**
 * The most urgent trial/term countdown across the user's open shops —
 * drives the gentle "N days left" note. Returns null when nothing is
 * counting down (all lifetime, or everything already locked).
 */
export function nearestCountdown(rows, now = Date.now()) {
  const list = Array.isArray(rows) ? rows : [];
  let best = null;
  for (const r of list) {
    if (r.effective_status === 'trial' && r.trial_ends_at) {
      const d = daysLeft(r.trial_ends_at, now);
      if (!best || d < best.days) best = { kind: 'trial', days: d, store: r };
    } else if (r.effective_status === 'active' && r.current_period_ends_at) {
      const d = daysLeft(r.current_period_ends_at, now);
      if (!best || d < best.days) best = { kind: 'term', days: d, store: r };
    }
  }
  return best;
}
