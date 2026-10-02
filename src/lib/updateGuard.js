/**
 * Safe-moment app updates (owner rule: "new updates can't break
 * anything previous" + "auto-update only at safe moments").
 *
 * The app must never reload itself in the middle of:
 *  - a register sale being recorded (completeSale in flight),
 *  - a backup restore writing data (Admin -> Users -> Restore),
 *  - any non-empty cart (POS draft or a customer's storefront cart).
 *
 * Long operations hold a named lock here; the cart checks read the
 * same persisted carts the apps themselves use, so a reload is only
 * ever auto-applied when nothing in progress can be lost. Carts are
 * persisted (driftshop_pos_draft, driftshop:cart:<slug>), so even a
 * manual refresh is non-destructive — the lock just avoids surprising
 * anyone mid-task.
 */

const locks = new Set();

export function acquireUpdateLock(name) {
  locks.add(String(name));
  return () => releaseUpdateLock(name);
}

export function releaseUpdateLock(name) {
  locks.delete(String(name));
}

export function updateLocksHeld() {
  return [...locks];
}

function storageHas(storage, key) {
  try {
    return !!storage.getItem(key);
  } catch {
    return false;
  }
}

function jsonLines(raw) {
  try {
    const parsed = JSON.parse(raw || 'null');
    const lines = Array.isArray(parsed) ? parsed : parsed?.lines;
    return Array.isArray(lines) && lines.length > 0;
  } catch {
    return false;
  }
}

/** True while an automatic reload could disturb someone. */
export function isUpdateBlocked() {
  if (locks.size > 0) return true;
  try {
    const ls = window.localStorage;
    // POS register draft (a half-built sale on the till).
    const draft = ls.getItem('driftshop_pos_draft');
    if (draft && jsonLines(draft)) return true;
    // Customer carts on published storefronts.
    for (let i = 0; i < ls.length; i += 1) {
      const key = ls.key(i);
      if (key && key.startsWith('driftshop:cart:') && jsonLines(ls.getItem(key))) {
        return true;
      }
    }
  } catch {
    // Storage unreadable (private mode etc.): carts live in memory
    // only in that case, and the lock set above still guards us.
  }
  return false;
}

// --- Forced-update escape hatch -------------------------------------
// If auto-apply ever misbehaves on a device, the escape hatch is: the
// update toast's "Later" button snoozes auto-apply for that build for
// the rest of the session; the manual refresh path always remains.
const SNOOZE_KEY = 'driftshop_update_snoozed';

export function snoozeUpdate(buildId) {
  try {
    window.sessionStorage.setItem(SNOOZE_KEY, String(buildId || ''));
  } catch { /* session only anyway */ }
}

export function isUpdateSnoozed(buildId) {
  try {
    return window.sessionStorage.getItem(SNOOZE_KEY) === String(buildId || '');
  } catch {
    return false;
  }
}
