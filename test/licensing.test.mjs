/**
 * Unit tests for the licensing pure logic (src/lib/licensing.js).
 * Run: node test/licensing.test.mjs
 */
import assert from 'node:assert/strict';
import {
  TRIAL_DAYS,
  KEY_ALPHABET,
  KEY_LENGTH,
  normalizeKey,
  isValidKeyFormat,
  formatKey,
  groupKeyInput,
  effectiveStatus,
  daysLeft,
  licenseGateDecision,
  nearestCountdown,
} from '../src/lib/licensing.js';

const NOW = Date.now();
const DAY = 86_400_000;
const future = (ms) => new Date(NOW + ms).toISOString();
const past = (ms) => new Date(NOW - ms).toISOString();

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

console.log('licensing');

/* ---------------- key format ---------------- */

check('trial is 30 days', () => {
  assert.equal(TRIAL_DAYS, 30);
});

check('alphabet excludes look-alikes 0 O 1 I L', () => {
  for (const bad of ['0', 'O', '1', 'I', 'L']) {
    assert.equal(KEY_ALPHABET.includes(bad), false, `alphabet must not contain ${bad}`);
  }
  assert.equal(new Set(KEY_ALPHABET.split('')).size, KEY_ALPHABET.length, 'no dupes');
});

check('normalizeKey strips dashes/spaces and uppercases', () => {
  assert.equal(normalizeKey('ab3d-ef5g hj7k'), 'AB3DEF5GHJ7K');
  assert.equal(normalizeKey(null), '');
  assert.equal(normalizeKey('  a-b  '), 'AB');
});

check('isValidKeyFormat accepts a real key', () => {
  assert.equal(isValidKeyFormat('AB3D-EF5G-HJ7K-MNPQ'), true);
  assert.equal(isValidKeyFormat('ab3def5ghj7kmnpq'), true);
});

check('isValidKeyFormat rejects wrong length and look-alike chars', () => {
  assert.equal(isValidKeyFormat('AB3D-EF5G'), false);
  assert.equal(isValidKeyFormat('AB3D-EF5G-HJ7K-MNP0'), false); // 0 not in alphabet
  assert.equal(isValidKeyFormat('OB3D-EF5G-HJ7K-MNPQ'), false); // O not in alphabet
  assert.equal(isValidKeyFormat(''), false);
});

check('formatKey groups in fours', () => {
  assert.equal(formatKey('AB3DEF5GHJ7KMNPQ'), 'AB3D-EF5G-HJ7K-MNPQ');
  assert.equal(formatKey('ab3d-ef5g-hj7k-mnpq'), 'AB3D-EF5G-HJ7K-MNPQ');
});

check('groupKeyInput drops impossible characters while typing', () => {
  assert.equal(groupKeyInput('ab3o'), 'AB3'); // o -> O dropped (not in alphabet)
  assert.equal(groupKeyInput('ab3def5g'), 'AB3D-EF5G');
  assert.equal(groupKeyInput('ab3def5ghj7kmnpqzzzz'), 'AB3D-EF5G-HJ7K-MNPQ');
});

check('every alphabet char can appear in a valid key', () => {
  const k = (KEY_ALPHABET + KEY_ALPHABET).slice(0, KEY_LENGTH);
  assert.equal(isValidKeyFormat(k), true);
});

/* ---------------- effective status ---------------- */

check('no row -> none', () => {
  assert.equal(effectiveStatus(null, NOW), 'none');
});

check('trial live -> trial; trial past -> locked', () => {
  assert.equal(effectiveStatus({ status: 'trial', trial_ends_at: future(DAY) }, NOW), 'trial');
  assert.equal(effectiveStatus({ status: 'trial', trial_ends_at: past(DAY) }, NOW), 'locked');
});

check('lifetime active never expires', () => {
  assert.equal(
    effectiveStatus({ status: 'active', current_period_ends_at: null }, NOW),
    'active'
  );
});

check('term active -> active until period end, then locked', () => {
  assert.equal(
    effectiveStatus({ status: 'active', current_period_ends_at: future(DAY) }, NOW),
    'active'
  );
  assert.equal(
    effectiveStatus({ status: 'active', current_period_ends_at: past(DAY) }, NOW),
    'locked'
  );
});

check('stored locked stays locked', () => {
  assert.equal(effectiveStatus({ status: 'locked', trial_ends_at: future(DAY) }, NOW), 'locked');
});

/* ---------------- days left ---------------- */

check('daysLeft rounds up and floors at 0', () => {
  assert.equal(daysLeft(future(3 * DAY + 1000), NOW), 4);
  assert.equal(daysLeft(future(3 * DAY), NOW), 3);
  assert.equal(daysLeft(past(DAY), NOW), 0);
  assert.equal(daysLeft(null, NOW), 0);
});

/* ---------------- gate decision ---------------- */

const user = { role: 'standard', is_master: false };
const store = (over) => ({
  store_id: 's1',
  store_name: 'Shop',
  my_role: 'owner',
  effective_status: 'trial',
  trial_ends_at: future(10 * DAY),
  current_period_ends_at: null,
  plan: null,
  ...over,
});

check('admin and master are never locked', () => {
  const locked = [store({ effective_status: 'locked' })];
  assert.equal(licenseGateDecision(locked, { role: 'admin' }).locked, false);
  assert.equal(licenseGateDecision(locked, { role: 'standard', is_master: true }).locked, false);
});

check('missing profile fails open', () => {
  const locked = [store({ effective_status: 'locked' })];
  assert.equal(licenseGateDecision(locked, null).locked, false);
  assert.equal(licenseGateDecision(locked, undefined).locked, false);
});

check('no shops -> never locked', () => {
  assert.equal(licenseGateDecision([], user).locked, false);
  assert.equal(licenseGateDecision(null, user).locked, false);
});

check('one open shop is enough to stay unlocked', () => {
  const rows = [
    store({ store_id: 's1', effective_status: 'locked' }),
    store({ store_id: 's2', effective_status: 'active' }),
  ];
  assert.equal(licenseGateDecision(rows, user).locked, false);
});

check('all shops locked -> locked, stores carried for the lock screen', () => {
  const rows = [
    store({ store_id: 's1', effective_status: 'locked' }),
    store({ store_id: 's2', effective_status: 'locked' }),
  ];
  const d = licenseGateDecision(rows, user);
  assert.equal(d.locked, true);
  assert.equal(d.stores.length, 2);
});

/* ---------------- countdown ---------------- */

check('nearestCountdown picks the smallest countdown', () => {
  const rows = [
    store({ store_id: 's1', trial_ends_at: future(20 * DAY) }),
    store({ store_id: 's2', trial_ends_at: future(5 * DAY) }),
  ];
  const c = nearestCountdown(rows, NOW);
  assert.equal(c.kind, 'trial');
  assert.equal(c.days, 5);
  assert.equal(c.store.store_id, 's2');
});

check('nearestCountdown ignores lifetime and locked shops', () => {
  const rows = [
    store({ effective_status: 'active', current_period_ends_at: null }),
    store({ store_id: 's2', effective_status: 'locked', trial_ends_at: future(2 * DAY) }),
  ];
  assert.equal(nearestCountdown(rows, NOW), null);
});

console.log(`\n${n} checks done`);
