/**
 * Unit tests for the account access policy (src/os/accessPolicy.js).
 * Run: node test/access-policy.test.mjs
 */
import assert from 'node:assert/strict';
import { evaluateAccess } from '../src/os/accessPolicy.js';

const NOW = Date.now();
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

console.log('accessPolicy');

check('null profile grants access', () => {
  assert.equal(evaluateAccess(null), null);
});

check('admin bypasses everything (locked+unpaid+disabled)', () => {
  const p = {
    role: 'admin', is_paid: false, is_locked: true,
    disabled_until: future(60000), is_guest: true, trial_ends_at: past(1000),
  };
  assert.equal(evaluateAccess(p), null);
});

check('paid standard account is granted', () => {
  assert.equal(
    evaluateAccess({ role: 'user', is_paid: true, is_locked: false, disabled_until: null, is_guest: false }),
    null
  );
});

check('unpaid standard account is blocked as unpaid', () => {
  const b = evaluateAccess({ role: 'user', is_paid: false, is_locked: false, disabled_until: null, is_guest: false });
  assert.equal(b.kind, 'unpaid');
  assert.equal(b.titleKey, 'login.blockUnpaidTitle');
  assert.equal(b.messageKey, 'login.blockUnpaidMsg');
});

check('active guest trial is granted', () => {
  const b = evaluateAccess({
    role: 'user', is_paid: false, is_locked: false, disabled_until: null,
    is_guest: true, trial_ends_at: future(20 * 60 * 1000),
  });
  assert.equal(b, null);
});

check('expired guest trial is blocked as expired', () => {
  const b = evaluateAccess({
    role: 'user', is_paid: false, is_locked: false, disabled_until: null,
    is_guest: true, trial_ends_at: past(1000),
  });
  assert.equal(b.kind, 'expired');
});

check('guest with no trial window is blocked as expired', () => {
  const b = evaluateAccess({
    role: 'user', is_paid: false, is_locked: false, disabled_until: null,
    is_guest: true, trial_ends_at: null,
  });
  assert.equal(b.kind, 'expired');
});

check('paid guest (converted trial) is granted', () => {
  const b = evaluateAccess({
    role: 'user', is_paid: true, is_locked: false, disabled_until: null,
    is_guest: true, trial_ends_at: past(1000),
  });
  assert.equal(b, null);
});

check('locked account is blocked even when paid', () => {
  const b = evaluateAccess({
    role: 'user', is_paid: true, is_locked: true, disabled_until: null, is_guest: false,
  });
  assert.equal(b.kind, 'locked');
});

check('temporarily disabled account is blocked with a countdown', () => {
  const b = evaluateAccess({
    role: 'user', is_paid: true, is_locked: false,
    disabled_until: future(4 * 60 * 1000), is_guest: false,
  });
  assert.equal(b.kind, 'disabled');
  assert.equal(b.titleKey, 'login.blockDisabledTitle');
  assert.equal(b.messageKey, 'login.blockDisabledMsg');
  assert.equal(b.messageParams.mins, 4);
  assert.equal(b.messageParams.plural, 's');
});

check('temporary disable under a minute uses the singular', () => {
  const b = evaluateAccess({
    role: 'user', is_paid: true, is_locked: false,
    disabled_until: future(30 * 1000), is_guest: false,
  });
  assert.equal(b.kind, 'disabled');
  assert.equal(b.messageParams.mins, 1);
  assert.equal(b.messageParams.plural, '');
});

check('malformed disabled_until never throws and does not block', () => {
  const b = evaluateAccess({
    role: 'user', is_paid: true, is_locked: false,
    disabled_until: 'not-a-date', is_guest: false,
  });
  assert.equal(b, null);
});

check('lapsed temporary disable no longer blocks', () => {
  const b = evaluateAccess({
    role: 'user', is_paid: true, is_locked: false,
    disabled_until: past(1000), is_guest: false,
  });
  assert.equal(b, null);
});

check('lock beats temporary disable', () => {
  const b = evaluateAccess({
    role: 'user', is_paid: true, is_locked: true,
    disabled_until: future(60000), is_guest: false,
  });
  assert.equal(b.kind, 'locked');
});

console.log(process.exitCode ? 'FAILED' : 'all access-policy tests passed');
