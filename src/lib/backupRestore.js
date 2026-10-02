/**
 * BACKUP RESTORE — pure decision logic (no DOM, no network, no imports,
 * so node tests can run it directly: tests/backup-restore.test.mjs).
 *
 * validateBackup(data) inspects a parsed backup file BEFORE anything is
 * touched: is it really a Drift Shop backup, what is inside (in counts a
 * shop owner understands), and is there anything in it this version
 * cannot put back. The UI turns these codes into plain words.
 *
 * KNOWN_STORE_TABLES must match what backend.pos.importStore can restore:
 * the POS_IMPORT_COLUMNS allowlist in src/lib/backend/supabase.js plus the
 * tables handled by dedicated import steps (punches, gift cards, refund
 * history, break history, punch settings, storefront profile, donation
 * links).
 */

export const KNOWN_STORE_TABLES = new Set([
  'pos_products', 'pos_sales', 'pos_customers', 'pos_staff',
  'pos_appointments', 'pos_drawer_shifts', 'pos_orgs',
  'pos_community_hours', 'pos_gift_cards', 'pos_gift_card_events',
  'pos_time_punches', 'pos_punch_audits', 'pos_refunds',
  'pos_shifts', 'pos_time_off', 'pos_pay_periods',
  'pos_punch_settings', 'pos_breaks', 'storefront_profiles',
  'bq_items', 'bq_donations', 'bq_donation_items', 'bq_fairs',
  'bq_fair_sales', 'bq_special_orders', 'online_orders',
  'pos_store_members', 'shop_licenses',
]);

const rows = (v) => (Array.isArray(v) ? v.length : 0);
const isTableError = (v) => !!v && typeof v === 'object' && !Array.isArray(v) && '__exportError' in v;

/** Plain-data inventory of a parsed backup: what and how much. */
export function countBackupContents(data) {
  const stores = [];
  const totals = {
    stores: 0, products: 0, sales: 0, refunds: 0, customers: 0, staff: 0,
    appointments: 0, giftCards: 0, catalogue: 0, specialOrders: 0,
  };
  for (const dump of Array.isArray(data?.posStores) ? data.posStores : []) {
    if (!dump || typeof dump !== 'object' || dump.__exportError) continue;
    const c = {
      name: dump.store?.name || 'Shop',
      products: rows(dump.tables?.pos_products),
      sales: rows(dump.tables?.pos_sales),
      refunds: rows(dump.tables?.pos_refunds),
      customers: rows(dump.tables?.pos_customers),
      staff: rows(dump.tables?.pos_staff),
      appointments: rows(dump.tables?.pos_appointments),
      giftCards: rows(dump.tables?.pos_gift_cards),
      catalogue: rows(dump.tables?.bq_items),
      specialOrders: rows(dump.tables?.bq_special_orders),
    };
    stores.push(c);
    totals.stores += 1;
    for (const k of ['products', 'sales', 'refunds', 'customers', 'staff', 'appointments', 'giftCards', 'catalogue', 'specialOrders']) {
      totals[k] += c[k];
    }
  }
  const files = Array.isArray(data?.files) ? data.files : [];
  const shopFilesList = [];
  let shopFileCount = 0;
  for (const entry of Array.isArray(data?.shopFiles) ? data.shopFiles : []) {
    const n = rows(entry?.files) && Array.isArray(entry?.files)
      ? entry.files.filter((f) => f?.type === 'file').length
      : 0;
    shopFileCount += n;
    shopFilesList.push({ storeName: entry?.storeName || 'Shop', files: n });
  }
  return {
    version: typeof data?.version === 'string' ? data.version : null,
    exportedAt: typeof data?.exportedAt === 'string' ? data.exportedAt : null,
    stores,
    totals,
    shopFilesList,
    files: files.filter((f) => f?.type === 'file').length,
    // Files whose bytes never made it into the backup (too large or
    // unreadable at export time) — counted so the UI can say plainly
    // that they cannot come back.
    skippedFiles: files.filter(
      (f) => f?.type === 'file' && (f.skipped || f.note || (f.binary && typeof f.data !== 'string'))
    ).length,
    shopFiles: shopFileCount,
    pins: rows(data?.pins),
    threads: rows(data?.helmThreads),
    spaces: rows(data?.spaces),
    highscores: rows(data?.highscores),
    notifications: rows(data?.notifications),
    supportTickets: rows(data?.support?.tickets),
    feedback: rows(data?.support?.feedback),
  };
}

/**
 * Decide whether a parsed JSON file is a restorable Drift Shop backup.
 * Returns { ok, fatal: [code], warnings: [{code, ...}], summary }.
 * `ok` means the file is usable; warnings are honest "this part cannot
 * come back" notes the UI shows BEFORE the user confirms.
 */
export function validateBackup(data) {
  const fatal = [];
  const warnings = [];
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, fatal: ['not-a-backup'], warnings, summary: null };
  }
  if (data.kind !== undefined && data.kind !== 'drift-backup') {
    return { ok: false, fatal: ['wrong-file'], warnings, summary: null };
  }
  if (data.kind === undefined) warnings.push({ code: 'legacy-backup' });

  const hasAccountShape =
    Array.isArray(data.files) && Array.isArray(data.pins) &&
    Array.isArray(data.helmThreads) && Array.isArray(data.spaces) &&
    !!data.settings && typeof data.settings === 'object';
  const storeDumps = Array.isArray(data.posStores) ? data.posStores : [];
  const hasStores = storeDumps.some((d) => d && typeof d === 'object' && !d.__exportError && d.tables);
  if (!hasAccountShape && !hasStores) {
    fatal.push('not-a-backup');
    return { ok: false, fatal, warnings, summary: null };
  }
  if (!hasAccountShape) warnings.push({ code: 'partial-backup' });

  // Version honesty: a newer major version may hold data this build does
  // not understand; say so instead of silently dropping it.
  const major = parseInt(String(data.version || '0'), 10);
  if (major > 2) warnings.push({ code: 'newer-version', version: data.version });

  for (const dump of storeDumps) {
    if (!dump || typeof dump !== 'object') continue;
    if (dump.__exportError) {
      warnings.push({ code: 'store-export-error', store: dump.store?.name || 'Shop' });
      continue;
    }
    const tables = dump.tables && typeof dump.tables === 'object' ? dump.tables : {};
    for (const [t, v] of Object.entries(tables)) {
      if (isTableError(v)) {
        warnings.push({ code: 'table-export-error', table: t, store: dump.store?.name || 'Shop' });
      } else if (!KNOWN_STORE_TABLES.has(t)) {
        warnings.push({ code: 'unknown-table', table: t, store: dump.store?.name || 'Shop' });
      }
    }
  }

  const summary = countBackupContents(data);
  if (summary.skippedFiles > 0) {
    warnings.push({ code: 'files-not-embedded', count: summary.skippedFiles });
  }
  return { ok: fatal.length === 0, fatal, warnings, summary };
}

/** data URL (from a backup) -> Blob. Browser API; tests stub it. */
export function dataUrlToBlob(dataUrl) {
  const comma = dataUrl.indexOf(',');
  const head = comma >= 0 ? dataUrl.slice(0, comma) : '';
  const b64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  const mime = /data:(.*?);base64/.exec(head)?.[1] || 'application/octet-stream';
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

/* ---- pending-restore marker (phase 1 -> phase 2 across sign-out) ------ */

export const RESTORE_PENDING_KEY = 'driftshop_restore_pending';

export function setRestorePending(info = {}) {
  try {
    localStorage.setItem(RESTORE_PENDING_KEY, JSON.stringify({ at: new Date().toISOString(), ...info }));
    return true;
  } catch {
    return false;
  }
}

export function getRestorePending() {
  try {
    const raw = localStorage.getItem(RESTORE_PENDING_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export function clearRestorePending() {
  try {
    localStorage.removeItem(RESTORE_PENDING_KEY);
  } catch {
    /* non-fatal */
  }
}
