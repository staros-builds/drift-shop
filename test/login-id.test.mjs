/**
 * Adversarial unit tests for the username -> email mapping (src/lib/loginId.js).
 * Run: node test/login-id.test.mjs
 *
 * The mapping must produce @drift-shop.app addresses for bare usernames,
 * pass real emails through untouched, and REJECT loudly (never silently
 * mangle) anything else — silent mangling causes account collisions.
 */
import assert from 'node:assert/strict';
import { loginIdToEmail } from '../src/lib/loginId.js';
import { BRAND } from '../src/lib/brand.js';

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
function rejectsAs(code, fn) {
  try {
    fn();
  } catch (e) {
    assert.equal(e.code, code);
    return;
  }
  throw new Error(`expected rejection with code "${code}" but it did not throw`);
}

console.log('loginId');

check('brand accounts domain is drift-shop.app', () => {
  assert.equal(BRAND.accountsDomain, 'drift-shop.app');
});

check('bare username maps to @drift-shop.app', () => {
  assert.equal(loginIdToEmail('marie'), 'marie@drift-shop.app');
});

check('username is lowercased (case-insensitive login, no dup accounts)', () => {
  assert.equal(loginIdToEmail('Marie'), 'marie@drift-shop.app');
  assert.equal(loginIdToEmail('MARIE'), 'marie@drift-shop.app');
});

check('surrounding whitespace is trimmed', () => {
  assert.equal(loginIdToEmail('  marie  '), 'marie@drift-shop.app');
});

check('dots, dashes, underscores, digits are allowed', () => {
  assert.equal(loginIdToEmail('marie.dupont_99-x'), 'marie.dupont_99-x@drift-shop.app');
});

check('real email passes through untouched', () => {
  assert.equal(loginIdToEmail('marie@exemple.ca'), 'marie@exemple.ca');
  assert.equal(loginIdToEmail('Marie@Exemple.CA'), 'Marie@Exemple.CA'); // emails not lowercased
});

check('empty / whitespace-only input is rejected loudly', () => {
  rejectsAs('username-required', () => loginIdToEmail(''));
  rejectsAs('username-required', () => loginIdToEmail('   '));
});

check('spaces are rejected (no silent strip -> no collisions)', () => {
  rejectsAs('username-invalid', () => loginIdToEmail('marie dupont'));
});

check('emoji are rejected loudly', () => {
  rejectsAs('username-invalid', () => loginIdToEmail('marie😀'));
  rejectsAs('username-invalid', () => loginIdToEmail('😀'));
});

check('special chars are rejected loudly', () => {
  for (const bad of ['marie!', 'marie#x', 'a/b', 'a\\b', 'x@y@z', 'p++', "o'brien", 'a*b', 'ünïcodé']) {
    if (bad === 'x@y@z') {
      // contains @ -> treated as email, passed through (Supabase validates)
      assert.equal(loginIdToEmail(bad), bad);
    } else {
      rejectsAs('username-invalid', () => loginIdToEmail(bad));
    }
  }
});

check('SQL-injection-ish strings are rejected, never interpolated', () => {
  rejectsAs('username-invalid', () => loginIdToEmail("admin' OR '1'='1"));
  rejectsAs('username-invalid', () => loginIdToEmail('"; DROP TABLE users; --'));
});

check('1000-char username is rejected, not truncated', () => {
  rejectsAs('username-too-long', () => loginIdToEmail('a'.repeat(1000)));
});

check('64-char username is the max and maps fine', () => {
  const u = 'a'.repeat(64);
  assert.equal(loginIdToEmail(u), `${u}@drift-shop.app`);
});

check('65-char username is rejected', () => {
  rejectsAs('username-too-long', () => loginIdToEmail('a'.repeat(65)));
});

check('null/undefined input throws a loud error, not a TypeError leak', () => {
  for (const v of [null, undefined]) {
    try {
      loginIdToEmail(v);
      throw new Error('did not throw for ' + v);
    } catch (e) {
      assert.ok(e instanceof Error, 'throws an Error');
    }
  }
});

console.log(process.exitCode ? 'FAILED' : 'all login-id tests passed');
