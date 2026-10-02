/**
 * Node tests for the backup-restore pure logic + dry-run import.
 * Run: node tests/backup-restore.test.mjs   (no live DB required)
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateBackup, countBackupContents, KNOWN_STORE_TABLES } from '../src/lib/backupRestore.js';
import { runBackupRestore } from '../src/lib/restoreImport.js';

let passed = 0;
const ok = (name) => { passed++; console.log('ok -', name); };

/* ------------------------------------------------------------------ */
/* Fixture: one shop, every restorable section, one embedded binary.   */
/* ------------------------------------------------------------------ */
const FIXTURE = {
  kind: 'drift-backup',
  version: '2.2.0',
  exportedAt: '2026-10-03T12:00:00.000Z',
  settings: { language: 'en' },
  profile: { username: 'boss', displayName: 'Boss' },
  files: [
    { path: '/', type: 'folder' },
    { path: '/notes.txt', type: 'file', text: 'hello' },
    { path: '/logo.png', type: 'file', binary: true, mime: 'image/png', data: 'data:image/png;base64,iVBORw0KGgo=' },
    { path: '/big.iso', type: 'file', binary: true, skipped: 'too large' },
  ],
  pins: [{ kind: 'text', title: 'remember this', body: 'buy more tape' }],
  helmThreads: [{ title: 'Chat', messages: [{ role: 'user', content: 'hi', toolCalls: null }] }],
  spaces: [{ name: 'Desk', layout: [] }],
  highscores: [{ id: 'hs1', game: 'duskfall', score: 100 }],
  notifications: [{ id: 'n1', title: 'Welcome' }],
  posStores: [{
    store: { id: '11111111-1111-4111-8111-111111111111', name: 'Test Shop' },
    tables: {
      pos_products: [{ id: 'p1', name: 'Widget' }, { id: 'p2', name: 'Gadget' }],
      pos_sales: [{ id: 's1', total_cents: 500 }],
      pos_customers: [{ id: 'c1', name: 'Ana' }],
      pos_staff: [{ id: 'st1', name: 'Sam' }],
      pos_appointments: [{ id: 'a1' }],
      pos_gift_cards: [{ id: 'g1', code: 'GC-1' }],
      pos_refunds: [{ id: 'r1', sale_id: 's1', amount_cents: 200 }],
      pos_breaks: [{ id: 'b1', staff_id: 'st1', punch_id: null }],
      pos_punch_settings: [{ store_id: '11111111-1111-4111-8111-111111111111' }],
      storefront_profiles: [{ store_id: '11111111-1111-4111-8111-111111111111', slug: 'test-shop' }],
    },
    printer: { printerName: 'EPSON TM-T20', paperWidth: 80 },
  }],
  shopFiles: [{
    storeId: '11111111-1111-4111-8111-111111111111',
    storeName: 'Test Shop',
    files: [{ path: '/manual.txt', type: 'file', text: 'shop manual' }],
  }],
  support: { tickets: [{ id: 't1', subject: 'help' }], feedback: [{ id: 'f1', message: 'nice' }] },
};

/* ---- validateBackup: happy path ---------------------------------- */
{
  const v = validateBackup(FIXTURE);
  assert.equal(v.ok, true);
  assert.deepEqual(v.fatal, []);
  assert.equal(v.summary.totals.products, 2);
  assert.equal(v.summary.totals.sales, 1);
  assert.equal(v.summary.totals.refunds, 1);
  assert.equal(v.summary.files, 3, 'folder entries are not counted as files');
  assert.equal(v.summary.shopFiles, 1);
  assert.equal(v.summary.pins, 1);
  assert.equal(v.summary.threads, 1);
  assert.equal(v.summary.spaces, 1);
  assert.equal(v.summary.skippedFiles, 1, 'big.iso could not be embedded');
  assert.equal(v.summary.exportedAt, '2026-10-03T12:00:00.000Z');
  assert.equal(v.summary.version, '2.2.0');
  // The one skipped binary produces exactly one honest warning.
  assert.deepEqual(v.warnings.map((w) => w.code), ['files-not-embedded']);
  assert.equal(v.warnings[0].count, 1);
  ok('validateBackup accepts a full backup with correct plain counts');
}

/* ---- validateBackup: fatal rejects -------------------------------- */
{
  assert.deepEqual(validateBackup(null).fatal, ['not-a-backup']);
  assert.deepEqual(validateBackup([1, 2]).fatal, ['not-a-backup']);
  assert.deepEqual(validateBackup('json').fatal, ['not-a-backup']);
  assert.deepEqual(validateBackup({}).fatal, ['not-a-backup'], 'empty object is not a backup');
  const v = validateBackup({ kind: 'somebody-else', files: [] });
  assert.deepEqual(v.fatal, ['wrong-file'], 'other Drift files get their own plain error');
  assert.equal(v.ok, false);
  ok('validateBackup rejects wrong files with beginner-safe codes');
}

/* ---- validateBackup: warnings ------------------------------------- */
{
  // Legacy: no kind marker at all, but recognizable account shape.
  const legacy = { ...FIXTURE };
  delete legacy.kind;
  const vl = validateBackup(legacy);
  assert.equal(vl.ok, true);
  assert.ok(vl.warnings.some((w) => w.code === 'legacy-backup'));

  // Store-only export: still restorable, but the account blocks are gone.
  const partial = validateBackup({ kind: 'drift-backup', version: '2.2.0', posStores: FIXTURE.posStores });
  assert.equal(partial.ok, true);
  assert.ok(partial.warnings.some((w) => w.code === 'partial-backup'));

  // A table this build cannot restore must be named before confirming.
  const unknown = structuredClone(FIXTURE);
  unknown.posStores[0].tables.pos_secrets = [{ id: 'x1' }];
  const vu = validateBackup(unknown);
  assert.equal(vu.ok, true);
  const w = vu.warnings.find((w) => w.code === 'unknown-table');
  assert.equal(w.table, 'pos_secrets');
  assert.equal(w.store, 'Test Shop');

  // Table-level export errors and newer versions are honest warnings.
  const tErr = structuredClone(FIXTURE);
  tErr.posStores[0].tables.pos_sales = { __exportError: 'permission denied' };
  assert.ok(validateBackup(tErr).warnings.some((w) => w.code === 'table-export-error' && w.table === 'pos_sales'));
  const newer = validateBackup({ ...FIXTURE, version: '3.0.0' });
  assert.ok(newer.warnings.some((w) => w.code === 'newer-version'));

  // Export-side failure of a whole store.
  const storeErr = validateBackup({ kind: 'drift-backup', posStores: [{ __exportError: 'x', store: { name: 'Dead Shop' } }] });
  assert.equal(storeErr.ok, false, 'a backup whose only store failed to export is not restorable');
  ok('validateBackup warns (never silently skips) for legacy/partial/unknown-table/newer cases');
}

/* ---- countBackupContents: per-store breakdown --------------------- */
{
  const c = countBackupContents(FIXTURE);
  assert.equal(c.stores.length, 1);
  assert.equal(c.stores[0].name, 'Test Shop');
  assert.equal(c.stores[0].giftCards, 1);
  assert.equal(c.totals.stores, 1);
  ok('countBackupContents breaks counts down per shop');
}

/* ---- static import-order contract in importStore ------------------ */
{
  const src = readFileSync(new URL('../src/lib/backend/supabase.js', import.meta.url), 'utf8');
  const start = src.indexOf('async importStore(dump)');
  assert.ok(start > 0, 'importStore located');
  const body = src.slice(start, start + 40000);
  const iGift = body.indexOf('pos_giftcard_import');
  const iRefunds = body.indexOf('pos_refund_history_import');
  const iBreaks = body.indexOf('pos_break_history_import');
  assert.ok(iGift > 0 && iRefunds > iGift, 'refund history imports AFTER sales + gift cards');
  assert.ok(iBreaks > iRefunds, 'break history imports AFTER refunds (staff + punches settled first)');
  assert.ok(body.indexOf('pos_punch_history_import') > 0, 'punch history RPC still used');
  // Every table the validator calls known must be handled by the importer
  // (RPC reuse or column allowlist) — no silent skips.
  for (const t of KNOWN_STORE_TABLES) {
    assert.ok(src.includes(`'${t}'`) || src.includes(`pos_${t}`), `KNOWN_STORE_TABLES entry ${t} appears in backend source`);
  }
  ok('importStore keeps the FK-safe order: gift cards → refund history → break history');
}

/* ---- dry-run import against an in-memory backend ------------------ */
function makeStubBackend() {
  const ops = [];
  const files = new Map();
  const shopFiles = new Map();
  const pins = [];
  const threads = [];
  const seen = new Set(); // highscores + notifications by id
  const rec = (name, fn) => (...args) => { ops.push(name); return fn(...args); };
  const backend = {
    settings: { update: rec('settings.update', () => {}) },
    profile: { update: rec('profile.update', () => ({})) },
    pos: {
      importStore: rec('pos.importStore', (dump) => ({
        storeId: dump.store.id,
        inserted: { pos_products: dump.tables.pos_products?.length || 0 },
        errors: {},
      })),
    },
    shopFiles: {
      mkdir: rec('shopFiles.mkdir', () => {}),
      write: rec('shopFiles.write', (sid, p, text) => shopFiles.set(sid + ':' + p, text)),
      upload: rec('shopFiles.upload', (sid, p, blob) => shopFiles.set(sid + ':' + p, blob)),
    },
    files: {
      mkdir: rec('files.mkdir', () => {}),
      write: rec('files.write', (p, text) => files.set(p, text)),
      upload: rec('files.upload', (p, blob) => files.set(p, blob)),
    },
    pins: {
      list: rec('pins.list', () => pins.slice()),
      create: rec('pins.create', (p) => { pins.push(p); return p; }),
    },
    helm: {
      threads: rec('helm.threads', () => threads.slice()),
      createThread: rec('helm.createThread', (title) => { const t = { id: 'th' + (threads.length + 1), title, messages: [] }; threads.push(t); return t; }),
      addMessage: rec('helm.addMessage', (id, m) => threads.find((t) => t.id === id).messages.push(m)),
    },
    spaces: { replaceAll: rec('spaces.replaceAll', (s) => s) },
    highscores: {
      importAll: rec('highscores.importAll', (rows) => {
        let inserted = 0;
        for (const r of rows) if (!seen.has('hs' + r.id)) { seen.add('hs' + r.id); inserted++; }
        return { inserted };
      }),
    },
    notifications: {
      importAll: rec('notifications.importAll', (rows) => {
        let inserted = 0;
        for (const r of rows) if (!seen.has('n' + r.id)) { seen.add('n' + r.id); inserted++; }
        return { inserted };
      }),
    },
    support: { importMine: rec('support.importMine', (rows) => ({ inserted: rows?.length || 0 })) },
    feedback: { importMine: rec('feedback.importMine', (rows) => ({ inserted: rows?.length || 0 })) },
  };
  return { backend, ops, files, shopFiles, pins, threads };
}

const stub = makeStubBackend();
const report = await runBackupRestore(FIXTURE, { backend: stub.backend });

{
  assert.equal(report.settings, true);
  assert.equal(report.filesRestored, 2, 'notes.txt + logo.png restored, big.iso skipped');
  assert.deepEqual(report.filesSkipped, [{ path: '/big.iso', reason: 'too large' }]);
  assert.equal(report.shopFilesRestored, 1);
  assert.equal(report.pinsRestored, 1);
  assert.equal(report.threadsRestored, 1);
  assert.equal(report.spacesRestored, 1);
  assert.equal(report.highscoresRestored, 1);
  assert.equal(report.notificationsRestored, 1);
  assert.equal(report.posReports.length, 1);
  assert.equal(report.posReports[0].name, 'Test Shop');
  assert.deepEqual(report.errors, []);

  // Order: settings → profile → store → shop files → files → pins → threads → spaces.
  const idx = (n) => stub.ops.indexOf(n);
  assert.ok(idx('settings.update') < idx('profile.update'));
  assert.ok(idx('profile.update') < idx('pos.importStore'));
  assert.ok(idx('pos.importStore') < idx('shopFiles.write'), 'shop files wait for store IDs');
  assert.ok(idx('shopFiles.write') < idx('files.write'));
  assert.ok(idx('files.write') < idx('pins.create'));
  assert.ok(idx('pins.create') < idx('helm.createThread'));
  assert.ok(idx('helm.createThread') < idx('spaces.replaceAll'));
  ok('dry-run restore imports every section in FK-safe order');
}

/* ---- idempotency: second run never doubles ------------------------ */
{
  const filesBefore = stub.files.size;
  const r2 = await runBackupRestore(FIXTURE, { backend: stub.backend });
  assert.equal(stub.files.size, filesBefore, 'files upsert by name — no duplicates');
  assert.equal(r2.pinsSkippedAsExisting, 1, 'second run leaves pins alone instead of doubling');
  assert.equal(r2.threadsSkippedAsExisting, 1, 'second run leaves conversations alone');
  assert.equal(stub.pins.length, 1);
  assert.equal(stub.threads.length, 1);
  assert.equal(r2.highscoresRestored, 0, 'merge-by-ID sections insert nothing twice');
  ok('running the same restore twice never doubles data');
}

/* ---- failure modes ------------------------------------------------- */
{
  // A settings failure aborts BEFORE anything destructive happens.
  const bad = makeStubBackend();
  bad.backend.settings.update = () => { throw new Error('unknown key: boom'); };
  await assert.rejects(() => runBackupRestore({ ...FIXTURE, settings: { boom: 1 } }, { backend: bad.backend }), /unknown key/);
  assert.equal(bad.ops.length, 0, 'nothing was imported after the settings abort');

  // Username already taken is a note, not a failure.
  const taken = makeStubBackend();
  taken.backend.profile.update = () => ({ usernameConflict: true });
  const rt = await runBackupRestore(FIXTURE, { backend: taken.backend });
  assert.equal(rt.profileNote, 'username-taken');
  assert.deepEqual(rt.errors, []);
  ok('settings abort stops everything; username conflict is a plain note');
}

console.log(`\n${passed} test groups passed`);
