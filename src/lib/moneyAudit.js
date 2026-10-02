/**
 * Money audit trail — nuclear failsafe.
 *
 * Every money movement (sale, refund, void, gift-card issue/redeem) is logged
 * to an append-only in-session ledger. This is the "black box flight
 * recorder" for the POS: if something goes wrong, this log tells us exactly
 * what happened during this session.
 *
 * CLOUD-ONLY CONTRACT:
 * - The cloud backend is the ONLY money record. Entries are written only
 *   AFTER the backend has recorded the movement; this ledger never
 *   substitutes for the cloud books.
 * - The ledger lives IN MEMORY ONLY for this session — it is never stored
 *   on this device. It dies with the tab. There is no on-device money log
 *   to go stale or to leak between sessions.
 * - Append-only within the session: entries are never modified (only
 *   dropped by the bound).
 * - Tamper-evident: each entry includes a hash chain (prevHash) — if
 *   something edits an old entry, the chain breaks and we can detect it.
 * - Bounded: keeps the last 1000 entries of this session.
 */

const LEGACY_LEDGER_KEY = 'driftshop_money_audit';
try {
  // Purge any ledger stored by older builds: business records must not
  // live on this device.
  localStorage.removeItem(LEGACY_LEDGER_KEY);
} catch {
  /* storage unavailable — nothing to purge */
}

const MAX_ENTRIES = 1000;

/** Session-only ledger. Never persisted — dies with the tab. */
const sessionLedger = [];

/**
 * Simple hash for the chain (not cryptographic — just tamper-evident).
 * In production, use a proper HMAC. For now, this catches accidental edits.
 */
function simpleHash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(36);
}

/**
 * Log a money movement. Call ONLY after the backend has recorded the
 * movement — this trail mirrors the cloud books for this session; it is
 * never a source of truth.
 *
 * @param {string} type - 'sale' | 'refund' | 'void' | 'giftcard_issue' | 'giftcard_redeem' | 'adjustment'
 * @param {object} details - { amountCents, saleId, saleNumber, method, userId, userName, note }
 */
// The chain hash covers the WHOLE entry (QA m-2): leaving saleNumber,
// method, user or note outside the hash would let them be edited
// afterwards without breaking the chain.
function entryDigest(prevHash, entry) {
  return simpleHash(prevHash + JSON.stringify({
    type: entry.type,
    timestamp: entry.timestamp,
    amountCents: entry.amountCents,
    saleId: entry.saleId,
    saleNumber: entry.saleNumber,
    method: entry.method,
    userId: entry.userId,
    userName: entry.userName,
    note: entry.note,
    prevHash: entry.prevHash,
  }));
}

export function logMoneyMovement(type, details = {}) {
  const prevHash = sessionLedger.length > 0 ? sessionLedger[sessionLedger.length - 1].hash : 'GENESIS';

  const entry = {
    id: `audit_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    type,
    timestamp: new Date().toISOString(),
    amountCents: details.amountCents ?? 0,
    saleId: details.saleId || null,
    saleNumber: details.saleNumber || null,
    method: details.method || null,
    userId: details.userId || null,
    userName: details.userName || null,
    note: details.note || null,
    prevHash,
  };

  // Hash chain: hash of (prevHash + the full entry).
  entry.hash = entryDigest(prevHash, entry);

  sessionLedger.push(entry);
  if (sessionLedger.length > MAX_ENTRIES) sessionLedger.splice(0, sessionLedger.length - MAX_ENTRIES);

  // Notify UI (for live audit viewers).
  try {
    window.dispatchEvent(new CustomEvent('driftshop:audit-logged', { detail: entry }));
  } catch {}

  return entry;
}

/**
 * Get the full ledger (newest first).
 */
export function getAuditLedger(limit = 100) {
  return sessionLedger.slice(-limit).reverse();
}

/**
 * Verify the hash chain. Returns { valid: bool, brokenAt: index|null }.
 * If valid is false, the ledger was tampered with (or corrupted).
 */
export function verifyAuditChain() {
  let prevHash = 'GENESIS';

  for (let i = 0; i < sessionLedger.length; i++) {
    const entry = sessionLedger[i];
    if (entry.prevHash !== prevHash) {
      return { valid: false, brokenAt: i, reason: 'prevHash mismatch' };
    }
    const expected = entryDigest(prevHash, entry);
    if (entry.hash !== expected) {
      return { valid: false, brokenAt: i, reason: 'hash mismatch' };
    }
    prevHash = entry.hash;
  }

  return { valid: true, brokenAt: null, count: sessionLedger.length };
}

/**
 * Get audit stats for the health dashboard (this session only).
 */
export function getAuditStats() {
  const today = new Date().toISOString().slice(0, 10);

  const todayEntries = sessionLedger.filter((e) => e.timestamp.slice(0, 10) === today);
  const salesToday = todayEntries.filter((e) => e.type === 'sale');
  const refundsToday = todayEntries.filter((e) => e.type === 'refund');

  return {
    totalEntries: sessionLedger.length,
    todayCount: todayEntries.length,
    salesToday: salesToday.length,
    refundsToday: refundsToday.length,
    salesCentsToday: salesToday.reduce((s, e) => s + e.amountCents, 0),
    refundsCentsToday: refundsToday.reduce((s, e) => s + e.amountCents, 0),
  };
}
