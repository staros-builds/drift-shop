/**
 * Account-recovery pure-logic tests (src/lib/recovery.js).
 *
 * Run: node test/recovery.test.mjs
 * (Hooked into the normal test flow — run all test/*.test.mjs before a build.)
 */
import assert from 'node:assert/strict';
import {
  generateRecoveryCode,
  generateRecoveryCodes,
  normalizeRecoveryCode,
  isPlausibleRecoveryCode,
  hashRecoveryCode,
  generateSalt,
  normalizeSecurityAnswer,
  hashSecurityAnswer,
  validateSecurityQuestions,
  validateRedeemInput,
  RECOVERY_CODE_ALPHABET,
  RECOVERY_CODE_LENGTH,
  RECOVERY_CODE_COUNT,
} from '../src/lib/recovery.js';

let n = 0;
function check(name, fn) {
  n++;
  const run = async () => {
    try {
      await fn();
      console.log(`  ok ${n} - ${name}`);
    } catch (e) {
      console.error(`  FAIL ${n} - ${name}: ${e.message}`);
      process.exitCode = 1;
    }
  };
  return run();
}

// Deterministic PRNG for tests (xorshift).
function testRand(seed = 42) {
  let s = seed >>> 0;
  return (count) => {
    const out = new Uint8Array(count);
    for (let i = 0; i < count; i++) {
      s ^= s << 13; s >>>= 0;
      s ^= s >> 17;
      s ^= s << 5; s >>>= 0;
      out[i] = s & 0xff;
    }
    return out;
  };
}

console.log('recovery');

await check('generated code matches XXXX-XXXX-XXXX format', () => {
  const code = generateRecoveryCode(testRand());
  assert.match(code, /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  assert.equal(code.replace(/-/g, '').length, RECOVERY_CODE_LENGTH);
});

await check('generated codes use only the unambiguous alphabet', () => {
  for (let i = 0; i < 20; i++) {
    const raw = generateRecoveryCode(testRand(i + 1)).replace(/-/g, '');
    for (const ch of raw) assert.ok(RECOVERY_CODE_ALPHABET.includes(ch), `bad char ${ch}`);
  }
});

await check('no ambiguous characters (0/O, 1/I/L) in alphabet', () => {
  for (const bad of ['0', 'O', '1', 'I', 'L']) {
    assert.ok(!RECOVERY_CODE_ALPHABET.includes(bad), `alphabet contains ${bad}`);
  }
});

await check('generateRecoveryCodes returns the requested unique count', () => {
  const codes = generateRecoveryCodes(RECOVERY_CODE_COUNT, testRand(7));
  assert.equal(codes.length, RECOVERY_CODE_COUNT);
  assert.equal(new Set(codes).size, RECOVERY_CODE_COUNT);
});

await check('normalizeRecoveryCode strips separators and uppercases', () => {
  assert.equal(normalizeRecoveryCode('xk7d q2m9-pl4z'), 'XK7DQ2M9PL4Z');
  assert.equal(normalizeRecoveryCode('  xk7d-q2m9-pl4z\n'), 'XK7DQ2M9PL4Z');
});

await check('isPlausibleRecoveryCode validates shape', () => {
  assert.ok(isPlausibleRecoveryCode('XK7D-Q2M9-PL4Z'));
  assert.ok(isPlausibleRecoveryCode('xk7d q2m9 pl4z'));
  assert.ok(!isPlausibleRecoveryCode('short'));
  assert.ok(!isPlausibleRecoveryCode('XK7D-Q2M9-PL4')); // 11 chars
  assert.ok(!isPlausibleRecoveryCode('0000-0000-0000')); // 0 not in alphabet
});

await check('hashRecoveryCode is deterministic and matches server sha256', async () => {
  const a = await hashRecoveryCode('XK7D-Q2M9-PL4Z');
  const b = await hashRecoveryCode('xk7d q2m9 pl4z'); // normalization first
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{64}$/);
  const c = await hashRecoveryCode('AAAA-BBBB-CCCC');
  assert.notEqual(a, c);
});

await check('generateSalt returns 32 hex chars', () => {
  const s = generateSalt(testRand(9));
  assert.match(s, /^[0-9a-f]{32}$/);
});

await check('normalizeSecurityAnswer lowercases/trims/collapses', () => {
  assert.equal(normalizeSecurityAnswer('  Maple   STREET '), 'maple street');
  assert.equal(normalizeSecurityAnswer('McDonald'), 'mcdonald');
});

await check('hashSecurityAnswer is salted and deterministic', async () => {
  const h1 = await hashSecurityAnswer('Maple Street', 'abc123');
  const h2 = await hashSecurityAnswer('  maple   street ', 'abc123');
  assert.equal(h1, h2); // normalization makes them equal
  const h3 = await hashSecurityAnswer('Maple Street', 'different-salt');
  assert.notEqual(h1, h3); // salt matters
  assert.match(h1, /^[0-9a-f]{64}$/);
});

await check('validateSecurityQuestions accepts a good setup', () => {
  const r = validateSecurityQuestions([
    { question: 'qPet', answer: 'Rex' },
    { question: 'qCity', answer: 'Ottawa' },
    { question: 'custom: nickname?', answer: 'Jo' },
  ]);
  assert.deepEqual(r, { ok: true });
});

await check('validateSecurityQuestions rejects bad setups', () => {
  assert.equal(validateSecurityQuestions([{ question: 'qPet', answer: 'Rex' }]).ok, false); // count
  assert.equal(validateSecurityQuestions([
    { question: 'qPet', answer: 'Rex' },
    { question: '', answer: 'Ottawa' },
    { question: 'qCity', answer: 'Gatineau' },
  ]).code, 'question-required');
  assert.equal(validateSecurityQuestions([
    { question: 'qPet', answer: 'x' },
    { question: 'qCity', answer: 'Ottawa' },
    { question: 'qFood', answer: 'Pizza' },
  ]).code, 'answer-too-short');
  assert.equal(validateSecurityQuestions([
    { question: 'qPet', answer: 'Rex' },
    { question: 'qPet', answer: 'Ottawa' },
    { question: 'qFood', answer: 'Pizza' },
  ]).code, 'question-duplicate');
});

await check('validateRedeemInput checks login and password', () => {
  assert.deepEqual(validateRedeemInput({ login: 'marie', newPassword: 'long-enough-1' }), { ok: true });
  assert.equal(validateRedeemInput({ login: '  ', newPassword: 'long-enough-1' }).code, 'login-required');
  assert.equal(validateRedeemInput({ login: 'marie', newPassword: 'short' }).code, 'password-invalid');
  assert.equal(validateRedeemInput({ login: 'marie', newPassword: '        ' }).code, 'password-invalid');
});

console.log(process.exitCode ? 'FAILED' : 'all recovery tests passed');
