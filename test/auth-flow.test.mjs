/**
 * Unit tests for the one-login auth flow (src/lib/authFlow.js).
 * Run: node test/auth-flow.test.mjs
 */
import assert from 'node:assert/strict';
import {
  validateSignupEmail,
  resendCooldownRemaining,
  RESEND_COOLDOWN_MS,
  buildSignupRedirectTo,
  parseAuthCallbackUrl,
  resolveConfirmedFlow,
  savePendingFlow,
  readPendingFlow,
  clearPendingFlow,
  setAuthNotice,
  readAndClearAuthNotice,
  PENDING_FLOW_KEY,
  AUTH_NOTICE_KEY,
} from '../src/lib/authFlow.js';

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

// In-memory localStorage stand-in.
function memStore() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
}

console.log('authFlow');

check('accepts a normal email, trims whitespace', () => {
  assert.deepEqual(validateSignupEmail('  Marie@Example.CA ', 'drift-shop.app'), {
    ok: true,
    email: 'Marie@Example.CA',
  });
});

check('rejects empty / missing email', () => {
  assert.deepEqual(validateSignupEmail('', 'drift-shop.app'), { ok: false, code: 'email-required' });
  assert.deepEqual(validateSignupEmail('   ', 'drift-shop.app'), { ok: false, code: 'email-required' });
  assert.deepEqual(validateSignupEmail(null, 'drift-shop.app'), { ok: false, code: 'email-required' });
});

check('rejects malformed emails', () => {
  for (const bad of ['marie', 'marie@', 'marie@example', 'a b@c.de', '@x.co']) {
    assert.deepEqual(validateSignupEmail(bad, 'drift-shop.app'), { ok: false, code: 'invalid-email' }, bad);
  }
});

check('rejects the synthetic accounts domain (legacy username collision + no inbox)', () => {
  const r = validateSignupEmail('marie@drift-shop.app', 'drift-shop.app');
  assert.deepEqual(r, { ok: false, code: 'synthetic-domain' });
  // Case-insensitive on the domain.
  assert.deepEqual(validateSignupEmail('MARIE@DRIFT-SHOP.APP', 'drift-shop.app'), {
    ok: false,
    code: 'synthetic-domain',
  });
});

check('similar-looking domains still pass', () => {
  assert.equal(validateSignupEmail('marie@drift-shop.app.evil.com', 'drift-shop.app').ok, true);
  assert.equal(validateSignupEmail('marie@notdrift-shop.app', 'drift-shop.app').ok, true);
});

check('resend cooldown: 60s after a send, 0 when never sent', () => {
  const now = Date.now();
  assert.equal(resendCooldownRemaining(null, now), 0);
  assert.equal(resendCooldownRemaining(now, now), RESEND_COOLDOWN_MS);
  assert.equal(resendCooldownRemaining(now - 30_000, now), 30_000);
  assert.equal(resendCooldownRemaining(now - 61_000, now), 0);
  assert.equal(resendCooldownRemaining(now + 10_000, now), RESEND_COOLDOWN_MS); // clock skew
});

check('signup redirect URL carries authflow + shop, query-only', () => {
  const u = buildSignupRedirectTo({
    origin: 'https://shop.example.com',
    basePath: '/drift-shop/',
    kind: 'customer',
    slug: 'heavy-test',
  });
  assert.equal(u, 'https://shop.example.com/drift-shop/?authflow=customer&shop=heavy-test');
  assert.ok(!u.includes('#'), 'no hash fragment');
});

check('signup redirect URL normalizes the base path', () => {
  assert.equal(
    buildSignupRedirectTo({ origin: 'https://a.b/', basePath: '/drift-shop', kind: 'owner' }),
    'https://a.b/drift-shop/?authflow=owner'
  );
});

check('pending flow round-trips and expires', () => {
  const s = memStore();
  assert.equal(readPendingFlow(s), null);
  savePendingFlow({ kind: 'customer', slug: 'heavy-test' }, s);
  assert.deepEqual(readPendingFlow(s), { kind: 'customer', slug: 'heavy-test' });
  clearPendingFlow(s);
  assert.equal(readPendingFlow(s), null);
  // Stale record ignored.
  s.setItem(
    PENDING_FLOW_KEY,
    JSON.stringify({ kind: 'owner', savedAt: Date.now() - 8 * 24 * 60 * 60 * 1000 })
  );
  assert.equal(readPendingFlow(s), null);
  // Garbage record ignored, never throws.
  s.setItem(PENDING_FLOW_KEY, 'not-json');
  assert.equal(readPendingFlow(s), null);
});

check('pending flow normalizes unknown kinds to owner', () => {
  const s = memStore();
  savePendingFlow({ kind: 'hacker' }, s);
  assert.equal(readPendingFlow(s).kind, 'owner');
});

check('parseAuthCallbackUrl: PKCE code with authflow', () => {
  const r = parseAuthCallbackUrl('https://a.b/drift-shop/?code=abc123&authflow=customer&shop=x');
  assert.equal(r.kind, 'code');
  assert.equal(r.code, 'abc123');
  assert.equal(r.authflow, 'customer');
});

check('parseAuthCallbackUrl: PKCE code without authflow (legacy)', () => {
  const r = parseAuthCallbackUrl('https://a.b/drift-shop/?code=abc123');
  assert.equal(r.kind, 'code');
  assert.equal(r.code, 'abc123');
  assert.equal(r.authflow, null);
});

check('parseAuthCallbackUrl: legacy implicit signup + recovery', () => {
  assert.deepEqual(parseAuthCallbackUrl('https://a.b/drift-shop/#access_token=t&type=signup'), {
    kind: 'signup-implicit',
  });
  assert.deepEqual(parseAuthCallbackUrl('https://a.b/drift-shop/#access_token=t&type=recovery'), {
    kind: 'recovery-implicit',
  });
});

check('parseAuthCallbackUrl: expired-link error fragment', () => {
  const r = parseAuthCallbackUrl(
    'https://a.b/drift-shop/#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired'
  );
  assert.deepEqual(r, { kind: 'error', errorCode: 'otp_expired' });
});

check('parseAuthCallbackUrl: plain page has no callback', () => {
  assert.deepEqual(parseAuthCallbackUrl('https://a.b/drift-shop/'), { kind: 'none' });
  assert.deepEqual(parseAuthCallbackUrl('not a url'), { kind: 'none' });
});

check('resolveConfirmedFlow: URL markers win, pending record is the fallback', () => {
  const s = memStore();
  savePendingFlow({ kind: 'owner' }, s);
  // URL carries customer+slug (cross-device confirm): URL wins.
  assert.deepEqual(resolveConfirmedFlow('customer', 'heavy-test', s), {
    kind: 'customer',
    slug: 'heavy-test',
  });
  // No URL markers: pending record answers.
  assert.deepEqual(resolveConfirmedFlow(null, null, s), { kind: 'owner', slug: null });
  // Neither: unknown (caller falls back to the profile's account_kind).
  clearPendingFlow(s);
  assert.deepEqual(resolveConfirmedFlow(null, null, s), { kind: null, slug: null });
});

check('auth notice: read-once semantics', () => {
  const s = memStore();
  assert.equal(readAndClearAuthNotice(s), null);
  setAuthNotice({ kind: 'expired', email: 'marie@example.ca' }, s);
  assert.deepEqual(readAndClearAuthNotice(s), { kind: 'expired', email: 'marie@example.ca' });
  // Second read is gone.
  assert.equal(readAndClearAuthNotice(s), null);
  assert.equal(s.getItem(AUTH_NOTICE_KEY), null);
});
