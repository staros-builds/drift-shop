/**
 * Unit tests for the database-mesh row-count verification
 * (tools/sync/lib/verify.mjs). Run: node test/sync-verify.test.mjs
 *
 * The sync job's whole alarm story rests on this comparison: two
 * databases "agree" only when every table is seen on both sides and
 * the counts match. Fixtures below are plain count maps — the same
 * shape counts.mjs builds from PostgREST responses.
 */
import assert from 'node:assert/strict';
import { compareCounts, formatReport } from '../tools/sync/lib/verify.mjs';

let n = 0;
function check(name, fn) {
  n++;
  try {
    fn();
    console.log(`  ok ${n} - ${name}`);
  } catch (e) {
    console.error(`  FAIL ${n} - ${name}: ${e.message}`);
    process.exitCode = 1;
  }
}

const PRIMARY = { pos_stores: 1, pos_products: 120, pos_sales: 843, pos_customers: 57 };

check('identical counts are ok', () => {
  const r = compareCounts(PRIMARY, { ...PRIMARY });
  assert.equal(r.ok, true);
  assert.equal(r.tablesChecked, 4);
  assert.equal(r.totalPrimary, 1021);
  assert.equal(r.totalStandby, 1021);
});

check('a table missing on the standby is NOT ok and is named', () => {
  const standby = { ...PRIMARY };
  delete standby.pos_sales;
  const r = compareCounts(PRIMARY, standby);
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing, ['pos_sales']);
  assert.equal(r.mismatches.length, 0);
});

check('an extra table on the standby (schema drift) is NOT ok', () => {
  const r = compareCounts(PRIMARY, { ...PRIMARY, pos_new_feature: 3 });
  assert.equal(r.ok, false);
  assert.deepEqual(r.extra, ['pos_new_feature']);
});

check('count drift beyond tolerance is a mismatch with a signed delta', () => {
  const r = compareCounts(PRIMARY, { ...PRIMARY, pos_sales: 840 });
  assert.equal(r.ok, false);
  assert.equal(r.mismatches.length, 1);
  assert.equal(r.mismatches[0].table, 'pos_sales');
  assert.equal(r.mismatches[0].delta, -3);
});

check('small lag within tolerance passes (sales written mid-dump)', () => {
  const r = compareCounts(PRIMARY, { ...PRIMARY, pos_sales: 841 }, { tolerance: 5 });
  assert.equal(r.ok, true);
});

check('zero rows is a real count, not "missing"', () => {
  const r = compareCounts({ pos_time_off: 0 }, { pos_time_off: 0 });
  assert.equal(r.ok, true);
  assert.equal(r.missing.length, 0);
});

check('empty standby against a live primary reports every table missing', () => {
  const r = compareCounts(PRIMARY, {});
  assert.equal(r.ok, false);
  assert.equal(r.missing.length, 4);
});

check('both sides empty is ok (fresh install)', () => {
  assert.equal(compareCounts({}, {}).ok, true);
});

check('report is plain language and names the gap', () => {
  const text = formatReport(compareCounts(PRIMARY, { ...PRIMARY, pos_sales: 800 }), { at: '2026-10-01T12:00:00Z' });
  assert.ok(/NOT matching/.test(text));
  assert.ok(text.includes('pos_sales'));
  assert.ok(/missing 43/.test(text));
  assert.ok(!/supabase\.co|service_role|postgres:\/\//i.test(text), 'report must never leak connection details');
});

check('report for matching copies says so plainly', () => {
  const text = formatReport(compareCounts(PRIMARY, { ...PRIMARY }));
  assert.ok(/OK/.test(text));
  assert.ok(text.includes('1021'));
});

console.log(process.exitCode ? '\nsync-verify: FAILURES above' : '\nsync-verify: all passed');
