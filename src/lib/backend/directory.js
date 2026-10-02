/**
 * Backend directory — the shard-ready seam between a shop and the
 * backend project that holds its data.
 *
 * Today every shop lives in ONE Supabase project: the one named by the
 * build-time VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY pair. Nothing
 * here changes that. This module adds the lookup that will let shops
 * spread across several projects later, without re-architecting:
 *
 *   slug ──► directory ──► backend id ──► { url, anonKey }
 *      └──── no directory / unknown slug ──► build-time default ────┘
 *
 * The directory is a small static JSON document (shape below). It can
 * be checked into the repo or fetched from a fixed config URL
 * (VITE_BACKEND_DIRECTORY_URL); the public anon keys inside it are the
 * same values already baked into every client build, so publishing the
 * directory publishes nothing secret. Service-role keys must NEVER
 * appear in a directory.
 *
 *   {
 *     "version": 1,
 *     "default": "main",
 *     "backends": {
 *       "main": { "url": "https://….supabase.co", "anonKey": "…" },
 *       "west": { "url": "https://….supabase.co", "anonKey": "…" }
 *     },
 *     "shops": { "marie-bakery": "west" }
 *   }
 *
 * Every function here is pure (loadBackendDirectory's fetch is
 * injectable) and unit-tested in test/backend-directory.test.mjs.
 * Resolution NEVER throws on lookup: a missing/broken directory or an
 * unknown slug always lands on the build-time default backend, which
 * keeps the single-backend product working exactly as today until the
 * day sharding is switched on.
 */

import { validateBackendConfig } from './configCheck.js';

/** Backend id used for the build-time default pair. */
export const DEFAULT_BACKEND_ID = 'build-default';

/**
 * Same slug grammar as migration 063's storefront_profiles check
 * (^[a-z0-9][a-z0-9-]{0,62}$), applied to the trimmed/lowercased
 * input. Returns the normalized slug, or null when the input can
 * never be a shop slug.
 */
export function normalizeStorefrontSlug(raw) {
  const slug = String(raw ?? '').trim().toLowerCase();
  return /^[a-z0-9][a-z0-9-]{0,62}$/.test(slug) ? slug : null;
}

/**
 * Validate + normalize a parsed directory document. Throws an Error
 * with a plain, operator-readable message on any problem (messages
 * describe config shape only — never key material, matching
 * configCheck.js). Returns:
 *   { version: 1, defaultBackendId, backends: {id: {url, anonKey}},
 *     shops: {slug: backendId} }
 */
export function parseBackendDirectory(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('backend directory is not a JSON object');
  }
  if (raw.version !== 1) {
    throw new Error(`backend directory version must be 1 (got ${JSON.stringify(raw.version ?? null)})`);
  }
  const rawBackends = raw.backends;
  if (!rawBackends || typeof rawBackends !== 'object' || Array.isArray(rawBackends)) {
    throw new Error('backend directory needs a "backends" object');
  }
  const backends = {};
  for (const [id, cfg] of Object.entries(rawBackends)) {
    if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(id)) {
      throw new Error(`backend id "${id}" is not a simple id (letters, numbers, dashes)`);
    }
    if (!cfg || typeof cfg !== 'object') {
      throw new Error(`backend "${id}" needs a settings object`);
    }
    // Same shape rules as the boot-time check (complete anon JWT,
    // hosted Supabase URL, key issued for the same project). Problem
    // strings never contain key material.
    const verdict = validateBackendConfig(cfg.url, cfg.anonKey);
    if (verdict.status !== 'ok') {
      const why = verdict.status === 'missing'
        ? 'its server address or access key is missing'
        : verdict.problems.join('; ');
      throw new Error(`backend "${id}" is not usable: ${why}`);
    }
    backends[id] = { url: String(cfg.url).trim(), anonKey: String(cfg.anonKey).trim() };
  }
  const ids = Object.keys(backends);
  if (ids.length === 0) {
    throw new Error('backend directory lists no backends');
  }
  const defaultBackendId = raw.default ?? null;
  if (defaultBackendId !== null && !backends[defaultBackendId]) {
    throw new Error(`backend directory default "${defaultBackendId}" is not one of its backends`);
  }
  const shops = {};
  const rawShops = raw.shops ?? {};
  if (!rawShops || typeof rawShops !== 'object' || Array.isArray(rawShops)) {
    throw new Error('backend directory "shops" must be an object when present');
  }
  for (const [rawSlug, backendId] of Object.entries(rawShops)) {
    const slug = normalizeStorefrontSlug(rawSlug);
    if (!slug) {
      throw new Error(`shop "${rawSlug}" in the directory is not a valid shop address`);
    }
    if (shops[slug] && shops[slug] !== backendId) {
      throw new Error(`shop "${slug}" is listed twice with different backends`);
    }
    if (!backends[backendId]) {
      throw new Error(`shop "${slug}" points at unknown backend "${backendId}"`);
    }
    shops[slug] = backendId;
  }
  return { version: 1, defaultBackendId, backends, shops };
}

/**
 * Resolve which backend serves one shop slug.
 *
 *   directory — output of parseBackendDirectory(), or null
 *   fallback  — the build-time default pair { url, anonKey }
 *               (either may be null; passed through untouched)
 *
 * Returns { backendId, url, anonKey, source } where source is
 * 'directory' (the directory named this shop's backend, or its own
 * "default" backend) or 'build-default' (no directory, unparseable
 * slug, or a slug the directory does not know — today's behavior).
 * Never throws.
 */
export function resolveBackendForSlug(slug, directory, fallback) {
  const fb = {
    backendId: DEFAULT_BACKEND_ID,
    url: fallback?.url ?? null,
    anonKey: fallback?.anonKey ?? null,
    source: 'build-default',
  };
  if (!directory) return fb;
  const normalized = normalizeStorefrontSlug(slug);
  const backendId = (normalized && directory.shops[normalized]) || directory.defaultBackendId;
  if (!backendId || !directory.backends[backendId]) return fb;
  const cfg = directory.backends[backendId];
  return { backendId, url: cfg.url, anonKey: cfg.anonKey, source: 'directory' };
}

/**
 * Resolve the platform default backend (where new shops land and
 * where the signed-in app boots until per-shop routing exists).
 * Same fallback rules as resolveBackendForSlug.
 */
export function resolveDefaultBackend(directory, fallback) {
  return resolveBackendForSlug('', directory, fallback);
}

const DIRECTORY_URL_ENV = 'VITE_BACKEND_DIRECTORY_URL';

/**
 * Read the directory config URL from an env-like object (pass
 * import.meta.env at the call site). Returns null when unset — the
 * common case today, meaning "no directory, single backend".
 */
export function backendDirectoryUrlFromEnv(env) {
  const raw = env?.[DIRECTORY_URL_ENV];
  const url = String(raw ?? '').trim();
  return url ? url : null;
}

/**
 * Fetch + parse the directory from a URL. NEVER throws: any network,
 * HTTP, JSON, or shape failure returns null, and callers fall back to
 * the build-time default backend. A broken directory must never take
 * a working shop offline.
 */
export async function loadBackendDirectory(url, fetchImpl) {
  const target = String(url ?? '').trim();
  if (!target) return null;
  const doFetch = fetchImpl ?? (typeof fetch === 'function' ? fetch : null);
  if (!doFetch) return null;
  try {
    const res = await doFetch(target, { headers: { Accept: 'application/json' } });
    if (!res || res.ok === false) return null;
    const raw = typeof res.json === 'function' ? await res.json() : null;
    return parseBackendDirectory(raw);
  } catch {
    return null;
  }
}
