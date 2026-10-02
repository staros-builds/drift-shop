/**
 * Unit tests for the cloud backup logic (src/lib/cloudBackup.js).
 * Run: node test/cloud-backup.test.mjs
 *
 * Covers the pure pieces only — filename shape, backup rotation (keep
 * newest 5, never touch foreign files), the weekly due check, the
 * multipart upload body, Drive error mapping, and device-local state
 * defaults. The Google-facing functions need a real browser + account
 * and are verified manually (see docs/cloud-backup.md).
 */
import assert from 'node:assert/strict';
import {
  DRIVE_SCOPE,
  KEEP_CLOUD_BACKUPS,
  backupFileName,
  buildMultipartBody,
  classifyDriveError,
  getCloudBackupState,
  isBackupFileName,
  planRotation,
  weeklyBackupDue,
} from '../src/lib/cloudBackup.js';

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

console.log('cloudBackup');

check('scope is the narrow drive.file (own files only)', () => {
  assert.equal(DRIVE_SCOPE, 'https://www.googleapis.com/auth/drive.file');
  assert.equal(KEEP_CLOUD_BACKUPS, 5);
});

check('backupFileName is sortable UTC and matches its own recognizer', () => {
  const name = backupFileName(new Date(Date.UTC(2026, 9, 1, 18, 30, 15)));
  assert.equal(name, 'drift-backup-20261001-183015.json');
  assert.ok(isBackupFileName(name));
  const late = backupFileName(new Date(Date.UTC(2026, 0, 5, 3, 4, 5)));
  assert.equal(late, 'drift-backup-20260105-030405.json');
  assert.ok(late < name, 'lexicographic order follows time order');
});

check('isBackupFileName rejects lookalikes (incl. the local download name)', () => {
  assert.ok(!isBackupFileName('drift-backup-2026-10-01.json')); // local download format
  assert.ok(!isBackupFileName('drift-backup-20261001-183015.json.bak'));
  assert.ok(!isBackupFileName('Drift-backup-20261001-183015.json'));
  assert.ok(!isBackupFileName(''));
  assert.ok(!isBackupFileName(null));
  assert.ok(!isBackupFileName(undefined));
});

const mk = (i, extra = {}) => ({
  id: `id${i}`,
  name: backupFileName(new Date(Date.UTC(2026, 0, i + 1, 12, 0, 0))),
  createdTime: new Date(Date.UTC(2026, 0, i + 1, 12, 0, 0)).toISOString(),
  ...extra,
});

check('planRotation keeps the newest 5 and returns the rest, oldest-safe', () => {
  const files = [mk(0), mk(1), mk(2), mk(3), mk(4), mk(5), mk(6)];
  const del = planRotation(files);
  assert.deepEqual([...del].sort(), ['id0', 'id1']);
  // Input order must not matter.
  const shuffled = [mk(3), mk(0), mk(6), mk(1), mk(5), mk(2), mk(4)];
  assert.deepEqual([...planRotation(shuffled)].sort(), ['id0', 'id1']);
});

check('planRotation never touches foreign files, even inside the folder', () => {
  const files = [
    mk(0), mk(1), mk(2), mk(3), mk(4), mk(5),
    { id: 'photo', name: 'receipt.jpg', createdTime: '2020-01-01T00:00:00Z' },
    { id: 'note', name: 'drift-backup-2026-10-01.json', createdTime: '2020-01-01T00:00:00Z' },
    { id: 'junk' },
    null,
  ];
  assert.deepEqual(planRotation(files), ['id0']);
});

check('planRotation is a no-op at or under the keep count', () => {
  assert.deepEqual(planRotation([mk(0), mk(1), mk(2)]), []);
  assert.deepEqual(planRotation([], 5), []);
  assert.deepEqual(planRotation(null), []);
  assert.deepEqual(planRotation(undefined), []);
});

check('planRotation falls back to filename order when createdTime is missing', () => {
  const files = [mk(0), mk(1), mk(2), mk(3), mk(4), mk(5)].map((f) => ({ id: f.id, name: f.name }));
  assert.deepEqual(planRotation(files), ['id0']);
});

check('weeklyBackupDue: disabled never runs', () => {
  assert.equal(weeklyBackupDue({ enabled: false, lastAt: null }), false);
  assert.equal(weeklyBackupDue({ enabled: false, lastAt: '2020-01-01T00:00:00Z' }), false);
  assert.equal(weeklyBackupDue({}), false);
  assert.equal(weeklyBackupDue(), false);
});

check('weeklyBackupDue: never-backed-up and stale are due; fresh is not', () => {
  const now = Date.UTC(2026, 9, 8, 12, 0, 0);
  assert.equal(weeklyBackupDue({ enabled: true, lastAt: null, now }), true);
  assert.equal(weeklyBackupDue({ enabled: true, lastAt: 'not-a-date', now }), true);
  assert.equal(weeklyBackupDue({ enabled: true, lastAt: new Date(now - 6 * 24 * 3600 * 1000).toISOString(), now }), false);
  assert.equal(weeklyBackupDue({ enabled: true, lastAt: new Date(now - 7 * 24 * 3600 * 1000).toISOString(), now }), true);
  assert.equal(weeklyBackupDue({ enabled: true, lastAt: new Date(now - 30 * 24 * 3600 * 1000).toISOString(), now }), true);
  // Exactly at the boundary counts as due.
  assert.equal(weeklyBackupDue({ enabled: true, lastAt: new Date(now - 7 * 24 * 3600 * 1000).toISOString(), now, intervalMs: 7 * 24 * 3600 * 1000 }), true);
});

check('buildMultipartBody carries metadata, content, and the closing boundary', () => {
  const body = buildMultipartBody({ name: 'x.json', parents: ['f1'] }, '{"a":1}', 'BOUNDARY');
  assert.ok(body.startsWith('--BOUNDARY\r\n'));
  assert.ok(body.includes('Content-Type: application/json; charset=UTF-8'));
  assert.ok(body.includes('{"name":"x.json","parents":["f1"]}'));
  assert.ok(body.includes('{"a":1}'));
  assert.ok(body.endsWith('--BOUNDARY--'));
});

check('classifyDriveError maps the failures owners actually hit', () => {
  assert.equal(classifyDriveError(401, null), 'auth');
  assert.equal(classifyDriveError(401, { error: { message: 'Invalid Credentials' } }), 'auth');
  assert.equal(
    classifyDriveError(403, { error: { errors: [{ reason: 'storageQuotaExceeded' }] } }),
    'full'
  );
  assert.equal(
    classifyDriveError(403, { error: { errors: [{ reason: 'userRateLimitExceeded' }] } }),
    'busy'
  );
  assert.equal(classifyDriveError(403, { error: { errors: [{ reason: 'insufficientPermissions' }] } }), 'auth');
  assert.equal(classifyDriveError(404, null), 'missing');
  assert.equal(classifyDriveError(429, null), 'busy');
  assert.equal(classifyDriveError(500, null), 'http');
  assert.equal(classifyDriveError(0, null), 'http');
});

check('getCloudBackupState defaults safely with no storage (Node, private mode)', () => {
  const s = getCloudBackupState();
  assert.deepEqual(s, { auto: false, lastAt: null, lastName: null });
});

console.log(process.exitCode ? 'cloudBackup: FAILURES above' : 'cloudBackup: all checks passed');
