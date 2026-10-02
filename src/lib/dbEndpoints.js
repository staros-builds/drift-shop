import { probeHeaders } from './backend/configCheck.js';

/**
 * dbEndpoints — dual-endpoint (primary + standby) boot failover.
 *
 * DEFAULT OFF: when no VITE_SUPABASE_FALLBACK_* variables are set, the
 * app boots exactly as it always has (primary only).
 *
 * When a standby IS configured (the database layers in
 * docs/redundancy.md), the boot sequence is:
 *   1. Probe the primary a few times (transient blips must not fail over).
 *   2. If the primary is really down, probe the standby list in order.
 *   3. First reachable standby becomes the session's endpoint in
 *      READ-ONLY mode: reads work (browse products, history, storefront),
 *      every write is refused with an honest bilingual message.
 *
 * THE LINE (see docs/redundancy.md for the full evaluation):
 * - Clients NEVER write to a standby. No split-brain: the hourly sync
 *   job is the only writer to standby databases, primary -> standby.
 * - Mid-session primary death is NOT silently re-routed: in-flight work
 *   fails honestly (the cloud-only rule), and a reload re-runs the boot
 *   probe. Re-routing a half-finished sale to another database could
 *   record it twice or lose it — that is exactly what we refuse to do.
 * - Promoting a standby to the new primary is a human decision (the
 *   mesh failover runbook), because the sync direction must flip with it.
 *
 * Env (all optional except the primary pair):
 *   VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY            (primary)
 *   VITE_SUPABASE_FALLBACK_URL / VITE_SUPABASE_FALLBACK_ANON_KEY
 *   VITE_SUPABASE_FALLBACK2_URL / _ANON_KEY ... up to _FALLBACK9_
 * (mirrors the nine standby slots in tools/sync/targets.json)
 *
 * No DOM/window access at module scope — safe to import in Node tests.
 */

const SELF_CHECK_TIMEOUT_MS = 12000;

function fetchWithTimeout(url, options, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...options, signal: ctrl.signal }).finally(() => clearTimeout(timer));
}

const trim = (v) => (typeof v === 'string' ? v.trim() : '');

/**
 * Read the endpoint configuration from an env-like object.
 * Incomplete fallbacks (url without key or vice versa) are dropped.
 */
export function readEndpointConfig(envLike = {}) {
  const primary = {
    url: trim(envLike.VITE_SUPABASE_URL),
    key: trim(envLike.VITE_SUPABASE_ANON_KEY),
  };
  const fallbacks = [];
  const readPair = (suffix) => {
    const url = trim(envLike[`VITE_SUPABASE_FALLBACK${suffix}_URL`]);
    const key = trim(envLike[`VITE_SUPABASE_FALLBACK${suffix}_ANON_KEY`]);
    if (url && key) fallbacks.push({ url, key });
  };
  readPair('');
  for (let i = 2; i <= 9; i++) readPair(String(i));
  return { primary, fallbacks };
}

export function hasFallback(config) {
  return Array.isArray(config?.fallbacks) && config.fallbacks.length > 0;
}

/**
 * Returns { reachable, schemaOk, detail }.
 * - reachable: the host answered HTTP at all (even a 401/404).
 * - schemaOk: a known table (pos_stores) exists. 'unknown' when RLS hides
 *   it from the anon key — that still means the backend is fine.
 */
export async function runSelfChecks(url, key) {
  const base = String(url).replace(/\/+$/, '');
  // 1. Reachability: any HTTP response proves host + network.
  let reachable = false;
  let reachDetail = '';
  try {
    const res = await fetchWithTimeout(
      `${base}/rest/v1/`,
      { method: 'HEAD', headers: { apikey: key } },
      SELF_CHECK_TIMEOUT_MS,
    );
    reachable = true;
    reachDetail = `HTTP ${res.status}`;
  } catch (err) {
    reachable = false;
    reachDetail = err?.name === 'AbortError' ? 'timed out' : String(err?.message || err);
  }
  if (!reachable) return { reachable: false, schemaOk: 'unknown', detail: reachDetail };

  // 2. Schema sanity: probe a table every install must have. Header
  // shape comes from configCheck.probeHeaders: a publishable
  // (sb_publishable_…) key goes on `apikey` ONLY — duplicating it into
  // Authorization: Bearer gets it rejected as an invalid token, which
  // would make a healthy backend (or standby) look broken on every boot.
  try {
    const res = await fetchWithTimeout(
      `${base}/rest/v1/pos_stores?select=id&limit=1`,
      { headers: probeHeaders(key) },
      SELF_CHECK_TIMEOUT_MS,
    );
    if (res.ok) return { reachable: true, schemaOk: true, detail: '' };
    // 401/403: RLS hides the table from anon — backend is fine, unverifiable.
    if (res.status === 401 || res.status === 403) {
      return { reachable: true, schemaOk: 'unknown', detail: '' };
    }
    let body = '';
    try {
      body = await res.text();
    } catch {}
    // PostgREST: table missing -> 404 + PGRST205 "Could not find the table".
    const tableMissing = res.status === 404 && /PGRST205|Could not find the table/i.test(body);
    if (tableMissing) {
      return { reachable: true, schemaOk: false, detail: body.slice(0, 300) };
    }
    // Any other HTTP answer: backend is alive; don't block boot on it.
    return { reachable: true, schemaOk: 'unknown', detail: `HTTP ${res.status}` };
  } catch (err) {
    // Reachable a moment ago; a flaky second probe shouldn't hard-fail boot.
    return { reachable: true, schemaOk: 'unknown', detail: String(err?.message || err) };
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Lightweight reachability probe: does the host answer HTTP at all?
 * Used for the storefront fast path (read-only failover); the full
 * runSelfChecks (reachability + schema) is used for the desktop boot.
 */
export async function probeEndpoint(url, key, timeoutMs = SELF_CHECK_TIMEOUT_MS) {
  const base = String(url).replace(/\/+$/, '');
  try {
    const res = await fetchWithTimeout(
      `${base}/rest/v1/`,
      { method: 'HEAD', headers: { apikey: key } },
      timeoutMs,
    );
    return { ok: true, httpStatus: res.status, detail: `HTTP ${res.status}` };
  } catch (err) {
    return {
      ok: false,
      detail: err?.name === 'AbortError' ? 'timed out' : String(err?.message || err),
    };
  }
}

/**
 * Boot-time endpoint selection.
 * Returns { url, key, mode, detail } where mode is:
 *   'live'         — primary is healthy; everything works.
 *   'standby-read' — primary down, a standby answered; reads only.
 *   'down'         — nothing answered; caller shows the honest error card.
 *
 * opts: { primaryAttempts (default 3), retryDelayMs (default 1500),
 *         selfCheck (default runSelfChecks) }
 */
export async function selectEndpointAtBoot(config, opts = {}) {
  const { primaryAttempts = 3, retryDelayMs = 1500, selfCheck = runSelfChecks } = opts;
  const { primary, fallbacks } = config;

  let lastDetail = '';
  for (let attempt = 1; attempt <= primaryAttempts; attempt++) {
    const res = await selfCheck(primary.url, primary.key);
    if (res.reachable && res.schemaOk !== false) {
      return { url: primary.url, key: primary.key, mode: 'live', detail: '' };
    }
    lastDetail = res.schemaOk === false
      ? `schema problem: ${res.detail}`
      : `primary unreachable (${res.detail})`;
    if (attempt < primaryAttempts) await sleep(retryDelayMs);
  }

  // Primary is really down (not a blip). Walk the standby list in order.
  // A standby whose own schema check fails is skipped, not trusted.
  for (const fb of fallbacks) {
    const res = await selfCheck(fb.url, fb.key);
    if (res.reachable && res.schemaOk !== false) {
      return {
        url: fb.url,
        key: fb.key,
        mode: 'standby-read',
        detail: `${lastDetail}; serving read-only from backup copy`,
      };
    }
  }

  return { url: primary.url, key: primary.key, mode: 'down', detail: lastDetail };
}

export function isWriteAllowed(mode) {
  return mode === 'live';
}

// ---------------------------------------------------------------------------
// Read-only enforcement for standby sessions.
// ---------------------------------------------------------------------------

export function writeBlockedError() {
  const err = new Error(
    'Backup-copy mode: the main server is unreachable, so changes are paused. ' +
      'Use "Try the main server again" in the banner — nothing you entered is lost, ' +
      'it just is not being saved yet. / ' +
      'Mode copie de secours : le serveur principal est injoignable, les modifications ' +
      'sont en pause. Touchez « Réessayer le serveur principal » dans le bandeau — ' +
      'rien de ce que vous avez saisi n’est perdu, ce n’est simplement pas enregistré pour l’instant.',
  );
  err.code = 'standby-read-only';
  return err;
}

/** Thenable that rejects on await but survives chaining (.select().eq()…). */
function poisonedBuilder() {
  const err = writeBlockedError();
  const p = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'then') return (_res, rej) => (rej ? rej(err) : Promise.reject(err));
        if (prop === 'catch') return (rej) => Promise.reject(err).catch(rej);
        if (prop === 'finally') return (fn) => Promise.reject(err).finally(fn);
        if (typeof prop === 'symbol') return undefined;
        return (..._a) => p;
      },
    },
  );
  return p;
}

const MUTATING_TABLE_METHODS = new Set(['insert', 'update', 'delete', 'upsert']);

function guardBuilder(builder) {
  return new Proxy(builder, {
    get(t, prop) {
      if (typeof prop === 'symbol') return Reflect.get(t, prop);
      if (MUTATING_TABLE_METHODS.has(prop)) return (..._a) => poisonedBuilder();
      const v = Reflect.get(t, prop);
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
}

const MUTATING_STORAGE_METHODS = new Set([
  'upload',
  'update',
  'remove',
  'move',
  'copy',
  'createSignedUploadUrl',
  'emptyBucket',
]);

function guardBucketApi(bucketApi) {
  return new Proxy(bucketApi, {
    get(t, prop) {
      if (typeof prop === 'symbol') return Reflect.get(t, prop);
      if (MUTATING_STORAGE_METHODS.has(prop)) return () => Promise.reject(writeBlockedError());
      const v = Reflect.get(t, prop);
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
}

function guardStorage(storage) {
  return new Proxy(storage, {
    get(t, prop) {
      if (prop === 'from') {
        const realFrom = Reflect.get(t, 'from').bind(t);
        return (bucket, ...rest) => guardBucketApi(realFrom(bucket, ...rest));
      }
      if (typeof prop === 'symbol') return Reflect.get(t, prop);
      const v = Reflect.get(t, prop);
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
}

/**
 * RPCs the app calls that are provably read-only. Everything else is
 * refused in standby-read mode: most RPCs here move money or stock
 * (pos_apply_sale_stock, pos_refund_sale, giftcard issue/redeem…).
 */
const READ_ONLY_RPCS = new Set(['public_storefront', 'search_pins']);

/**
 * Auth in standby-read mode: signing in/out and reading the session are
 * reads of the copied auth.users (hashes travel with --with-auth). Anything
 * that WRITES auth state is refused. refreshSession is allowed so an
 * existing session keeps working while browsing; its rotation is local to
 * the standby and invisible to the primary (mesh docs: sessions are not
 * copied), so the user signs in again after the primary recovers.
 */
const ALLOWED_AUTH_METHODS = new Set([
  'signInWithPassword',
  'signOut',
  'getSession',
  'getUser',
  'onAuthStateChange',
  'refreshSession',
]);

function guardAuth(auth) {
  return new Proxy(auth, {
    get(t, prop) {
      if (typeof prop === 'symbol') return Reflect.get(t, prop);
      if (ALLOWED_AUTH_METHODS.has(prop)) {
        const v = Reflect.get(t, prop);
        return typeof v === 'function' ? v.bind(t) : v;
      }
      return () => Promise.reject(writeBlockedError());
    },
  });
}

function guardRest(rest) {
  if (!rest || typeof rest !== 'object') return rest;
  return new Proxy(rest, {
    get(t, prop) {
      if (prop === 'from') {
        const realFrom = Reflect.get(t, 'from').bind(t);
        return (table, ...restArgs) => guardBuilder(realFrom(table, ...restArgs));
      }
      if (typeof prop === 'symbol') return Reflect.get(t, prop);
      const v = Reflect.get(t, prop);
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
}

function rejectAll() {
  return new Proxy(
    {},
    {
      get(_t, prop) {
        if (typeof prop === 'symbol') return undefined;
        return () => Promise.reject(writeBlockedError());
      },
    },
  );
}

/**
 * Wrap a supabase-js client so that in standby-read mode every mutation
 * path rejects with the honest bilingual error, while reads pass through.
 * Safe to call only when readOnly is true; returns the client unchanged
 * otherwise (kept simple: callers branch).
 */
export function guardClientForStandbyRead(client) {
  return new Proxy(client, {
    get(t, prop) {
      if (typeof prop === 'symbol') return Reflect.get(t, prop);
      if (prop === 'from') {
        const realFrom = Reflect.get(t, 'from').bind(t);
        return (table, ...rest) => guardBuilder(realFrom(table, ...rest));
      }
      if (prop === 'rest') return guardRest(Reflect.get(t, 'rest'));
      if (prop === 'storage') return guardStorage(Reflect.get(t, 'storage'));
      if (prop === 'auth') return guardAuth(Reflect.get(t, 'auth'));
      if (prop === 'functions') return rejectAll();
      if (prop === 'rpc') {
        const realRpc = Reflect.get(t, 'rpc').bind(t);
        return (name, ...args) =>
          READ_ONLY_RPCS.has(name) ? realRpc(name, ...args) : Promise.reject(writeBlockedError());
      }
      const v = Reflect.get(t, prop);
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
}

// ---------------------------------------------------------------------------
// Active-endpoint override (boot sets it; the adapter reads it).
// ---------------------------------------------------------------------------

let activeEndpoint = null; // { url, key, readOnly } | null

export function setActiveEndpoint({ url, key, readOnly }) {
  activeEndpoint = { url, key, readOnly: !!readOnly };
}

export function clearActiveEndpoint() {
  activeEndpoint = null;
}

/**
 * What the Supabase adapter should connect to. Defaults to the build's
 * env (today's behavior); after a standby-read boot selection, returns
 * the chosen standby with readOnly: true.
 */
export function resolveSupabaseEndpoint(envLike) {
  if (activeEndpoint) return activeEndpoint;
  const env = envLike || (typeof import.meta !== 'undefined' ? import.meta.env : {});
  return {
    url: trim(env?.VITE_SUPABASE_URL),
    key: trim(env?.VITE_SUPABASE_ANON_KEY),
    readOnly: false,
  };
}

export function isStandbyReadMode() {
  return !!activeEndpoint?.readOnly;
}
