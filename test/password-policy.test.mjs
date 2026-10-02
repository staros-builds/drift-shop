/**
 * Unit tests for the shared password policy (src/lib/passwordPolicy.js).
 * Run: node --test test/password-policy.test.mjs
 *
 * Covers the rules every password-choosing surface must enforce: min
 * substance (all-spaces rejected), common-password blocklist, and
 * low-entropy repeating patterns. Coded errors (.code) so login screens
 * can localize them.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertSanePassword } from '../src/lib/passwordPolicy.js';

function codeOf(fn) {
  try {
    fn();
  } catch (e) {
    return e.code;
  }
  return null;
}

test('rejects blank and all-spaces passwords', () => {
  assert.equal(codeOf(() => assertSanePassword('')), 'weak-password');
  assert.equal(codeOf(() => assertSanePassword('        ')), 'weak-password');
  assert.equal(codeOf(() => assertSanePassword(' \t ')), 'weak-password');
});

test('rejects common weak passwords (case-insensitive)', () => {
  for (const pw of ['password', 'Password123', 'ADMIN123', 'qwerty123', '12345678']) {
    assert.equal(codeOf(() => assertSanePassword(pw)), 'common-password', pw);
  }
});

test('rejects low-entropy repeating passwords', () => {
  assert.equal(codeOf(() => assertSanePassword('aaaaaaaa')), 'repeating-password');
  assert.equal(codeOf(() => assertSanePassword('abcabcabc')), 'repeating-password');
  assert.equal(codeOf(() => assertSanePassword('123123123')), 'repeating-password');
});

test('accepts strong passwords', () => {
  assert.equal(codeOf(() => assertSanePassword('Tr4il-M1x!pine')), null);
  assert.equal(codeOf(() => assertSanePassword('correct horse 99!')), null);
});
