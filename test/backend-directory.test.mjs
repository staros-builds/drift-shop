/**
 * Unit tests for the backend directory (src/lib/backend/directory.js).
 * Run: node test/backend-directory.test.mjs
 *
 * The directory is the shard-ready seam: slug → backend project config.
 * The behavior that matters most today is what must NOT change: with no
 * directory, an unknown slug, or a broken directory fetch, resolution
 * lands on the build-time default pair and never throws — the
 * single-backend product keeps working exactly as before. Fixture keys
 * are fabricated in-test; no real key material appears here.
 */
import assert from 'node:assert/strict';
import {
  DEFAULT_BACKEND_ID,
  normalizeStorefrontSlug,
  parseBackendDirectory,
  resolveBackendForSlug,
  resolveDefaultBackend,
  backendDirectoryUrlFromEnv,
  loadBackendDirectory,
} from '../src/lib/backend/directory.js';

let n = 0;
const pending = [];
function check(name, fn) {
  const run = async () => {
    const idx = ++n;
    try {
      await fn();
      console.log(`  ok ${idx} - ${name}`);
    } catch (e) {
      console.error(`  FAIL ${idx} - ${name}: ${e.message}`);
      process.exitCode = 1;
    }
  };
  pending.push(run());
}

const b64url = (obj) => Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
function makeKey(ref) {
  return `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({ ref, role: 'anon', iat: 1700000000, exp: 2000000000 })}.fakesig`;
}

const MAIN = { url: 'https://aaaaaaaaaaaaaaaaaaaa.supabase.co', anonKey: makeKey('aaaaaaaaaaaaaaaaaaaa') };
const WEST = { url: 'https://bbbbbbbbbbbbbbbbbbbb.supabase.co', anonKey: makeKey('bbbbbbbbbbbbbbbbbbbb') };
const FALLBACK = { url: 'https://fallbackfallback00.supabase.co', anonKey: makeKey('fallbackfallback00') };

const DIR_RAW = {
  version: 1,
  default: 'main',
  backends: { main: MAIN, west: WEST },
  shops: { 'marie-bakery': 'west', 'Chez-Leo': 'main' },
};

/* ---------- normalizeStorefrontSlug ---------- */

check('slug normalization trims and lowercases', () => {
  assert.equal(normalizeStorefrontSlug('  Marie-Bakery '), 'marie-bakery');
  assert.equal(normalizeStorefrontSlug('shop-2'), 'shop-2');
  assert.equal(normalizeStorefrontSlug('a'), 'a');
});

check('slug normalization rejects non-slugs', () => {
  assert.equal(normalizeStorefrontSlug(''), null);
  assert.equal(normalizeStorefrontSlug(null), null);
  assert.equal(normalizeStorefrontSlug('has space'), null);
  assert.equal(normalizeStorefrontSlug('-leading-dash'), null);
  assert.equal(normalizeStorefrontSlug('under_score'), null);
  assert.equal(normalizeStorefrontSlug('éclair'), null);
  assert.equal(normalizeStorefrontSlug('a'.repeat(64)), null);
});

/* ---------- parseBackendDirectory ---------- */

check('a well-formed directory parses and normalizes slugs', () => {
  const dir = parseBackendDirectory(DIR_RAW);
  assert.equal(dir.defaultBackendId, 'main');
  assert.deepEqual(dir.shops, { 'marie-bakery': 'west', 'chez-leo': 'main' });
  assert.equal(dir.backends.west.url, WEST.url);
});

check('directory without shops or default still parses', () => {
  const dir = parseBackendDirectory({ version: 1, backends: { main: MAIN } });
  assert.equal(dir.defaultBackendId, null);
  assert.deepEqual(dir.shops, {});
});

check('wrong version is rejected', () => {
  assert.throws(() => parseBackendDirectory({ version: 2, backends: { main: MAIN } }), /version must be 1/);
});

check('non-object and missing backends are rejected', () => {
  assert.throws(() => parseBackendDirectory(null), /not a JSON object/);
  assert.throws(() => parseBackendDirectory({ version: 1 }), /"backends" object/);
  assert.throws(() => parseBackendDirectory({ version: 1, backends: {} }), /no backends/);
});

check('a backend with a broken key is rejected (shape only, no key echo)', () => {
  const bad = { version: 1, backends: { main: { url: MAIN.url, anonKey: 'truncated' } } };
  assert.throws(
    () => parseBackendDirectory(bad),
    (e) => /not usable/.test(e.message) && !e.message.includes('truncated'),
  );
});

check('a backend whose key belongs to another project is rejected', () => {
  const bad = { version: 1, backends: { main: { url: MAIN.url, anonKey: makeKey('zzzzzzzzzzzzzzzzzzzz') } } };
  assert.throws(() => parseBackendDirectory(bad), /not usable/);
});

check('default and shop assignments must point at real backends', () => {
  assert.throws(
    () => parseBackendDirectory({ version: 1, default: 'nope', backends: { main: MAIN } }),
    /not one of its backends/,
  );
  assert.throws(
    () => parseBackendDirectory({ version: 1, backends: { main: MAIN }, shops: { a: 'nope' } }),
    /unknown backend/,
  );
});

check('invalid shop slugs in the directory are rejected', () => {
  assert.throws(
    () => parseBackendDirectory({ version: 1, backends: { main: MAIN }, shops: { 'bad slug': 'main' } }),
    /not a valid shop address/,
  );
});

check('duplicate slug after normalization with different backends is rejected', () => {
  assert.throws(
    () => parseBackendDirectory({
      version: 1,
      backends: { main: MAIN, west: WEST },
      shops: { 'Chez-Leo': 'main', 'chez-leo': 'west' },
    }),
    /listed twice/,
  );
});

/* ---------- resolveBackendForSlug ---------- */

const DIR = parseBackendDirectory(DIR_RAW);

check('no directory → build-default passthrough (today\u2019s behavior)', () => {
  const r = resolveBackendForSlug('marie-bakery', null, FALLBACK);
  assert.deepEqual(r, {
    backendId: DEFAULT_BACKEND_ID,
    url: FALLBACK.url,
    anonKey: FALLBACK.anonKey,
    source: 'build-default',
  });
});

check('known slug resolves to its assigned backend', () => {
  const r = resolveBackendForSlug('marie-bakery', DIR, FALLBACK);
  assert.equal(r.backendId, 'west');
  assert.equal(r.url, WEST.url);
  assert.equal(r.source, 'directory');
});

check('slug lookup is case/space-insensitive', () => {
  const r = resolveBackendForSlug('  MARIE-Bakery ', DIR, FALLBACK);
  assert.equal(r.backendId, 'west');
});

check('unknown slug falls back to the directory default backend', () => {
  const r = resolveBackendForSlug('brand-new-shop', DIR, FALLBACK);
  assert.equal(r.backendId, 'main');
  assert.equal(r.source, 'directory');
});

check('unknown slug with no directory default → build-default', () => {
  const dir = parseBackendDirectory({ version: 1, backends: { main: MAIN } });
  const r = resolveBackendForSlug('brand-new-shop', dir, FALLBACK);
  assert.equal(r.source, 'build-default');
  assert.equal(r.url, FALLBACK.url);
});

check('unparseable slug → directory default, never a throw', () => {
  const r = resolveBackendForSlug('!!!', DIR, FALLBACK);
  assert.equal(r.backendId, 'main');
  const r2 = resolveBackendForSlug(undefined, DIR, null);
  assert.equal(r2.backendId, 'main');
});

check('resolveDefaultBackend uses the directory default', () => {
  const r = resolveDefaultBackend(DIR, FALLBACK);
  assert.equal(r.backendId, 'main');
  const r2 = resolveDefaultBackend(null, FALLBACK);
  assert.equal(r2.source, 'build-default');
});

/* ---------- env + loader ---------- */

check('backendDirectoryUrlFromEnv trims and tolerates missing env', () => {
  assert.equal(backendDirectoryUrlFromEnv({ VITE_BACKEND_DIRECTORY_URL: ' https://x.test/dir.json ' }), 'https://x.test/dir.json');
  assert.equal(backendDirectoryUrlFromEnv({}), null);
  assert.equal(backendDirectoryUrlFromEnv(null), null);
  assert.equal(backendDirectoryUrlFromEnv({ VITE_BACKEND_DIRECTORY_URL: '  ' }), null);
});

check('loadBackendDirectory parses a fetched directory', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => DIR_RAW });
  const dir = await loadBackendDirectory('https://x.test/dir.json', fetchImpl);
  assert.equal(dir.defaultBackendId, 'main');
});

check('loadBackendDirectory never throws — every failure is null', async () => {
  assert.equal(await loadBackendDirectory('', async () => { throw new Error('unused'); }), null);
  assert.equal(await loadBackendDirectory(null), null);
  assert.equal(await loadBackendDirectory('https://x.test', async () => { throw new Error('offline'); }), null);
  assert.equal(await loadBackendDirectory('https://x.test', async () => ({ ok: false, json: async () => DIR_RAW })), null);
  assert.equal(await loadBackendDirectory('https://x.test', async () => ({ ok: true, json: async () => ({ bogus: true }) })), null);
  assert.equal(await loadBackendDirectory('https://x.test', async () => ({ ok: true, json: async () => { throw new Error('not json'); } })), null);
});

await Promise.all(pending);
console.log(process.exitCode ? '\nFAILED' : '\nAll directory tests passed.');
