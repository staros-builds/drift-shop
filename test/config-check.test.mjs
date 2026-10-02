/**
 * Unit tests for boot config validation (src/lib/backend/configCheck.js).
 * Run: node test/config-check.test.mjs
 *
 * Regression anchor: a production build once shipped with a truncated
 * anon key (clipped at the first "." of the JWT). Presence checks passed,
 * the app booted, and sign-in failed with a raw "Invalid API key". The
 * validator must catch that shape before boot — and must never reject a
 * well-formed key. Fixture keys are fabricated in-test; no real key
 * material appears here.
 */
import assert from 'node:assert/strict';
import { validateBackendConfig, checkSupabaseUrl, checkAnonKey, keyKind, probeHeaders } from '../src/lib/backend/configCheck.js';

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

const b64url = (obj) => Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
function makeKey(payload, header = { alg: 'HS256', typ: 'JWT' }) {
  return `${b64url(header)}.${b64url(payload)}.fakesignaturepart`;
}

const URL_OK = 'https://abcdefghijklmnopqrst.supabase.co';
const KEY_OK = makeKey({ ref: 'abcdefghijklmnopqrst', role: 'anon', iat: 1700000000, exp: 2000000000 });

check('well-formed url + key is ok', () => {
  assert.equal(validateBackendConfig(URL_OK, KEY_OK).status, 'ok');
});

check('missing url or key is missing (not invalid)', () => {
  assert.equal(validateBackendConfig('', KEY_OK).status, 'missing');
  assert.equal(validateBackendConfig(URL_OK, '').status, 'missing');
  assert.equal(validateBackendConfig(undefined, undefined).status, 'missing');
});

check('THE INCIDENT: key truncated at the first dot is invalid', () => {
  const truncated = KEY_OK.split('.')[0];
  const v = validateBackendConfig(URL_OK, truncated);
  assert.equal(v.status, 'invalid');
  assert.ok(v.problems.length >= 1);
  // Problem text must describe shape only — never echo key material.
  assert.ok(!v.problems.join(' ').includes(truncated));
});

check('two-segment and four-segment keys are invalid', () => {
  assert.equal(validateBackendConfig(URL_OK, `${b64url({ a: 1 })}.${b64url({ b: 2 })}`).status, 'invalid');
  assert.equal(validateBackendConfig(URL_OK, `${KEY_OK}.extra`).status, 'invalid');
});

check('empty segment is invalid', () => {
  assert.equal(validateBackendConfig(URL_OK, `${b64url({ alg: 'HS256' })}..sig`).status, 'invalid');
});

check('undecodable segments are invalid', () => {
  assert.equal(validateBackendConfig(URL_OK, 'aaa.bbb.ccc').status, 'invalid');
});

check('payload without a supabase role is invalid', () => {
  const k = makeKey({ ref: 'abcdefghijklmnopqrst', role: 'authenticated' });
  assert.equal(validateBackendConfig(URL_OK, k).status, 'invalid');
});

check('service_role key shape is still well-formed', () => {
  const k = makeKey({ ref: 'abcdefghijklmnopqrst', role: 'service_role' });
  assert.equal(validateBackendConfig(URL_OK, k).status, 'ok');
});

check('key issued for a different project than the url is invalid', () => {
  const k = makeKey({ ref: 'zzzzzzzzzzzzzzzzzzzz', role: 'anon' });
  const v = validateBackendConfig(URL_OK, k);
  assert.equal(v.status, 'invalid');
  assert.ok(/different project/.test(v.problems.join(' ')));
});

check('key without a ref claim cannot mismatch (still ok)', () => {
  const k = makeKey({ role: 'anon' });
  assert.equal(validateBackendConfig(URL_OK, k).status, 'ok');
});

check('http (not https) url is invalid', () => {
  assert.equal(validateBackendConfig('http://abcdefghijklmnopqrst.supabase.co', KEY_OK).status, 'invalid');
});

check('non-supabase host is invalid', () => {
  assert.equal(validateBackendConfig('https://example.com', KEY_OK).status, 'invalid');
});

check('unreadable url is invalid', () => {
  assert.equal(validateBackendConfig('not a url', KEY_OK).status, 'invalid');
});

check('trailing slash and whitespace are tolerated', () => {
  assert.equal(validateBackendConfig(`${URL_OK}/`, `  ${KEY_OK}  `).status, 'ok');
});

check('checkSupabaseUrl extracts the project ref', () => {
  assert.equal(checkSupabaseUrl(URL_OK).ref, 'abcdefghijklmnopqrst');
});

check('checkAnonKey accepts a well-formed key', () => {
  assert.equal(checkAnonKey(KEY_OK, 'abcdefghijklmnopqrst').ok, true);
});

/* --- New key families (October 2026): sb_publishable_ / sb_secret_ --- */
/* Fresh Supabase projects only issue these; the legacy JWT path above
 * must keep working for older projects. Fabricated shapes only. */

const KEY_PUBLISHABLE = 'sb_publishable_Ab3dEf5Gh7Jk9Lm2Np4Qr6St8Uv';

check('publishable key is accepted (fresh projects have nothing else)', () => {
  assert.equal(validateBackendConfig(URL_OK, KEY_PUBLISHABLE).status, 'ok');
});

check('keyKind classifies all three families', () => {
  assert.equal(keyKind(KEY_OK), 'jwt');
  assert.equal(keyKind(KEY_PUBLISHABLE), 'publishable');
  assert.equal(keyKind('sb_secret_Ab3dEf5Gh7Jk9Lm2Np4Qr6St8UvWx0'), 'secret');
  assert.equal(keyKind('not-a-key'), 'unknown');
});

check('secret key is refused with its own plain-language problem', () => {
  const v = validateBackendConfig(URL_OK, 'sb_secret_Ab3dEf5Gh7Jk9Lm2Np4Qr6St8UvWx0');
  assert.equal(v.status, 'invalid');
  assert.ok(/SECRET/.test(v.problems.join(' ')));
  // Problem text must never echo the key material itself.
  assert.ok(!v.problems.join(' ').includes('Ab3dEf5Gh7Jk9Lm2Np4Qr6St8UvWx0'));
});

check('truncated publishable key is invalid', () => {
  assert.equal(validateBackendConfig(URL_OK, 'sb_publishable_Ab3').status, 'invalid');
  assert.equal(validateBackendConfig(URL_OK, 'sb_publishable_').status, 'invalid');
});

check('publishable key with illegal characters is invalid', () => {
  assert.equal(validateBackendConfig(URL_OK, 'sb_publishable_Ab3d Ef5!Gh7Jk9Lm2Np4').status, 'invalid');
});

check('probeHeaders: publishable key goes on apikey ONLY (no Bearer)', () => {
  const h = probeHeaders(KEY_PUBLISHABLE);
  assert.equal(h.apikey, KEY_PUBLISHABLE);
  assert.equal(h.Authorization, undefined);
});

check('probeHeaders: legacy JWT key rides both headers (role claim)', () => {
  const h = probeHeaders(KEY_OK);
  assert.equal(h.apikey, KEY_OK);
  assert.equal(h.Authorization, `Bearer ${KEY_OK}`);
});

console.log(process.exitCode ? '\nFAILURES above' : `\nAll ${n} checks passed`);
