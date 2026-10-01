/**
 * Money audit trail — nuclear failsafe.
 *
 * Every money movement (sale, refund, void, gift-card issue/redeem) is logged
 * to an append-only local ledger. This is the "black box flight recorder"
 * for the POS: if something goes wrong, this log tells us exactly what happened.
 *
 * Nuclear rules:
 * - Append-only: entries are never modified or deleted (only pruned by age).
 * - Tamper-evident: each entry includes a hash chain (prevHash) — if someone
 *   edits an old entry, the chain breaks and we can detect it.
 * - Local-first: works offline, syncs to backend when available (future).
 * - Bounded: keeps last 1000 entries (~30 days of typical use).
 *
 * This is a LOCAL ledger. The backend is the source of truth; this is the
 * independent cross-check. If they disagree, that's a red flag.
 */

const LEDGER_KEY = 'driftshop_money_audit';
const MAX_ENTRIES = 1000;

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

function loadLedger() {
  try {
    const raw = localStorage.getItem(LEDGER_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveLedger(entries) {
  try {
    // Keep only the last MAX_ENTRIES (prune oldest).
    const trimmed = entries.slice(-MAX_ENTRIES);
    localStorage.setItem(LEDGER_KEY, JSON.stringify(trimmed));
  } catch (e) {
    console.error('[driftshop] audit ledger save failed', e);
  }
}

/**
 * Log a money movement.
 *
 * @param {string} type - 'sale' | 'refund' | 'void' | 'giftcard_issue' | 'giftcard_redeem' | 'adjustment'
 * @param {object} details - { amountCents, saleId, saleNumber, method, userId, userName, note }
 */
export function logMoneyMovement(type, details = {}) {
  const ledger = loadLedger();
  const prevHash = ledger.length > 0 ? ledger[ledger.length - 1].hash : 'GENESIS';

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

  // Hash chain: hash of (prevHash + entry data).
  entry.hash = simpleHash(prevHash + JSON.stringify({
    type: entry.type,
    timestamp: entry.timestamp,
    amountCents: entry.amountCents,
    saleId: entry.saleId,
  }));

  ledger.push(entry);
  saveLedger(ledger);

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
  const ledger = loadLedger();
  return ledger.slice(-limit).reverse();
}

/**
 * Verify the hash chain. Returns { valid: bool, brokenAt: index|null }.
 * If valid is false, the ledger was tampered with (or corrupted).
 */
export function verifyAuditChain() {
  const ledger = loadLedger();
  let prevHash = 'GENESIS';

  for (let i = 0; i < ledger.length; i++) {
    const entry = ledger[i];
    if (entry.prevHash !== prevHash) {
      return { valid: false, brokenAt: i, reason: 'prevHash mismatch' };
    }
    const expected = simpleHash(prevHash + JSON.stringify({
      type: entry.type,
      timestamp: entry.timestamp,
      amountCents: entry.amountCents,
      saleId: entry.saleId,
    }));
    if (entry.hash !== expected) {
      return { valid: false, brokenAt: i, reason: 'hash mismatch' };
    }
    prevHash = entry.hash;
  }

  return { valid: true, brokenAt: null, count: ledger.length };
}

/**
 * Get audit stats for the health dashboard.
 */
export function getAuditStats() {
  const ledger = loadLedger();
  const today = new Date().toISOString().slice(0, 10);

  const todayEntries = ledger.filter((e) => e.timestamp.slice(0, 10) === today);
  const salesToday = todayEntries.filter((e) => e.type === 'sale');
  const refundsToday = todayEntries.filter((e) => e.type === 'refund');

  return {
    totalEntries: ledger.length,
    todayCount: todayEntries.length,
    salesToday: salesToday.length,
    refundsToday: refundsToday.length,
    salesCentsToday: salesToday.reduce((s, e) => s + e.amountCents, 0),
    refundsCentsToday: refundsToday.reduce((s, e) => s + e.amountCents, 0),
  };
}
