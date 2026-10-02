/**
 * hostname → store resolution (src/lib/hostnameResolve.js).
 * Run: node --test test/hostname-resolve.test.mjs
 *
 * The resolver decides, from the address in the browser, whether to boot
 * the normal app or show one shop's public storefront (automatic
 * <slug>.<apex> subdomains and buyer-owned custom domains). It must be
 * bulletproof: ports, uppercase, trailing dots, deep subdomains and evil
 * lookalikes are all covered below. It never trusts the hostname — it
 * only picks which PUBLIC page to render.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeHostname,
  isValidHostname,
  normalizeDomainInput,
  resolveHostname,
  lookupSlugForHost,
} from '../src/lib/hostnameResolve.js';

const APEX = 'driftshop.example';

// [rawHost, apex, expected] — deepEqual against resolveHostname.
const CASES = [
  // --- automatic subdomains ---
  ['mariebakery.driftshop.example', APEX, { kind: 'storefront', slug: 'mariebakery' }],
  ['MARIEBAKERY.DRIFTSHOP.EXAMPLE', APEX, { kind: 'storefront', slug: 'mariebakery' }],
  ['mariebakery.driftshop.example:8443', APEX, { kind: 'storefront', slug: 'mariebakery' }],
  ['mariebakery.driftshop.example.', APEX, { kind: 'storefront', slug: 'mariebakery' }],
  ['  mariebakery.driftshop.example  ', APEX, { kind: 'storefront', slug: 'mariebakery' }],
  ['my-shop-2.driftshop.example', APEX, { kind: 'storefront', slug: 'my-shop-2' }],
  ['bad-.driftshop.example', APEX, { kind: 'storefront', slug: 'bad-' }],
  ['a.driftshop.example', APEX, { kind: 'storefront', slug: 'a' }],
  // --- apex itself and www ---
  ['driftshop.example', APEX, { kind: 'app' }],
  ['DRIFTSHOP.EXAMPLE', APEX, { kind: 'app' }],
  ['www.driftshop.example', APEX, { kind: 'app' }],
  ['WWW.driftshop.example:443', APEX, { kind: 'app' }],
  // --- deep / malformed subdomains → friendly dead end ---
  ['blog.mariebakery.driftshop.example', APEX, { kind: 'not-found' }],
  ['marie_bakery.driftshop.example', APEX, { kind: 'not-found' }],
  ['-bad.driftshop.example', APEX, { kind: 'not-found' }],
  // Trailing dash is fine: the database slug rule (migration 063) allows
  // it, and the resolver follows the database exactly.
  ['--.driftshop.example', APEX, { kind: 'not-found' }],
  [`${'a'.repeat(64)}.driftshop.example`, APEX, { kind: 'not-found' }],
  [`${'a'.repeat(63)}.driftshop.example`, APEX, { kind: 'storefront', slug: 'a'.repeat(63) }],
  ['.driftshop.example', APEX, { kind: 'not-found' }],
  // --- evil lookalikes must NOT resolve as our subdomains ---
  ['mariebakery.driftshop.example.evil.com', APEX, { kind: 'custom', hostname: 'mariebakery.driftshop.example.evil.com' }],
  ['evil-driftshop.example', APEX, { kind: 'custom', hostname: 'evil-driftshop.example' }],
  ['notdriftshop.example', APEX, { kind: 'custom', hostname: 'notdriftshop.example' }],
  ['driftshop.example.evil.com', APEX, { kind: 'custom', hostname: 'driftshop.example.evil.com' }],
  // --- buyer custom domains ---
  ['mymarieshop.ca', APEX, { kind: 'custom', hostname: 'mymarieshop.ca' }],
  ['www.mymarieshop.ca', APEX, { kind: 'custom', hostname: 'www.mymarieshop.ca' }],
  ['MYMARIESHOP.CA:443', APEX, { kind: 'custom', hostname: 'mymarieshop.ca' }],
  ['boulangerie-marie.example.fr', APEX, { kind: 'custom', hostname: 'boulangerie-marie.example.fr' }],
  // --- platform hosts never trigger lookups ---
  ['staros-builds.github.io', APEX, { kind: 'app' }],
  ['drift-shop.pages.dev', APEX, { kind: 'app' }],
  ['fix-branch.drift-shop.pages.dev', APEX, { kind: 'app' }],
  ['drift-shop.netlify.app', APEX, { kind: 'app' }],
  ['drift-shop.someone.workers.dev', APEX, { kind: 'app' }],
  // --- local / dev hosts behave as before ---
  ['localhost', APEX, { kind: 'app' }],
  ['localhost:5173', APEX, { kind: 'app' }],
  ['127.0.0.1', APEX, { kind: 'app' }],
  ['127.0.0.1:5173', APEX, { kind: 'app' }],
  ['192.168.1.20:5173', APEX, { kind: 'app' }],
  ['[::1]:5173', APEX, { kind: 'app' }],
  ['drift.test', APEX, { kind: 'app' }],
  ['printer.local', APEX, { kind: 'app' }],
  // --- garbage falls back to the app, never a blank page ---
  ['', APEX, { kind: 'app' }],
  ['   ', APEX, { kind: 'app' }],
  [null, APEX, { kind: 'app' }],
  [undefined, APEX, { kind: 'app' }],
  ['not a host at all!', APEX, { kind: 'app' }],
  ['singlelabel', APEX, { kind: 'app' }],
  ['-leading-dash.ca', APEX, { kind: 'app' }],
  ['under_score.ca', APEX, { kind: 'app' }],
  // --- no apex configured: subdomains off, custom domains still work ---
  ['mariebakery.driftshop.example', '', { kind: 'custom', hostname: 'mariebakery.driftshop.example' }],
  ['mymarieshop.ca', '', { kind: 'custom', hostname: 'mymarieshop.ca' }],
  ['staros-builds.github.io', '', { kind: 'app' }],
  ['localhost:5173', '', { kind: 'app' }],
  ['mariebakery.driftshop.example', null, { kind: 'custom', hostname: 'mariebakery.driftshop.example' }],
  // --- apex with mixed case / trailing dot in config ---
  ['mariebakery.driftshop.example', 'DriftShop.Example.', { kind: 'storefront', slug: 'mariebakery' }],
];

for (const [rawHost, apex, expected] of CASES) {
  test(`resolveHostname(${JSON.stringify(rawHost)}, ${JSON.stringify(apex)}) -> ${expected.kind}`, () => {
    assert.deepEqual(resolveHostname(rawHost, apex), expected);
  });
}

test('normalizeHostname strips port, case, trailing dot, IPv6 brackets', () => {
  assert.equal(normalizeHostname('Example.COM:8080'), 'example.com');
  assert.equal(normalizeHostname('example.com.'), 'example.com');
  assert.equal(normalizeHostname('[2001:db8::1]:443'), '2001:db8::1');
  assert.equal(normalizeHostname('2001:db8::1'), '2001:db8::1');
  assert.equal(normalizeHostname(''), '');
  assert.equal(normalizeHostname(null), '');
});

test('isValidHostname accepts real names, rejects junk', () => {
  for (const good of ['mymarieshop.ca', 'www.mymarieshop.ca', 'xn--boulangerie-9fa.fr', 'a.b']) {
    assert.equal(isValidHostname(good), true, good);
  }
  for (const bad of ['', 'nodot', '-bad.ca', 'bad-.ca', 'a..ca', 'under_score.ca', `${'a'.repeat(64)}.ca`, 'sp ace.ca']) {
    assert.equal(isValidHostname(bad), false, bad);
  }
});

test('normalizeDomainInput forgives pasted URLs', () => {
  assert.equal(normalizeDomainInput('https://mymarieshop.ca/'), 'mymarieshop.ca');
  assert.equal(normalizeDomainInput('http://www.mymarieshop.ca/menu?x=1#top'), 'www.mymarieshop.ca');
  assert.equal(normalizeDomainInput('  MyMarieShop.CA '), 'mymarieshop.ca');
  assert.equal(normalizeDomainInput('mymarieshop.ca:443'), 'mymarieshop.ca');
  assert.equal(normalizeDomainInput(''), '');
});

function stubFetch(status, json) {
  return async (url, opts) => {
    stubFetch.lastCall = { url, opts };
    return { ok: status >= 200 && status < 300, status, json: async () => json };
  };
}

test('lookupSlugForHost returns the slug from the RPC', async () => {
  const fetchImpl = stubFetch(200, 'mariebakery');
  const slug = await lookupSlugForHost({
    supabaseUrl: 'https://proj.supabase.co/',
    anonKey: 'anon',
    hostname: 'mymarieshop.ca',
    fetchImpl,
  });
  assert.equal(slug, 'mariebakery');
  assert.match(stubFetch.lastCall.url, /\/rest\/v1\/rpc\/public_storefront_by_host$/);
  assert.deepEqual(JSON.parse(stubFetch.lastCall.opts.body), { p_host: 'mymarieshop.ca' });
  assert.equal(stubFetch.lastCall.opts.headers.apikey, 'anon');
});

test('lookupSlugForHost maps null/unknown to null and never trusts junk', async () => {
  assert.equal(
    await lookupSlugForHost({ supabaseUrl: 'https://x.co', anonKey: 'k', hostname: 'a.ca', fetchImpl: stubFetch(200, null) }),
    null
  );
  assert.equal(
    await lookupSlugForHost({ supabaseUrl: 'https://x.co', anonKey: 'k', hostname: 'a.ca', fetchImpl: stubFetch(200, 'Not A Slug!') }),
    null
  );
});

test('lookupSlugForHost throws on HTTP failure (caller shows error state)', async () => {
  await assert.rejects(
    lookupSlugForHost({ supabaseUrl: 'https://x.co', anonKey: 'k', hostname: 'a.ca', fetchImpl: stubFetch(500, {}) }),
    /lookup failed \(500\)/
  );
});
