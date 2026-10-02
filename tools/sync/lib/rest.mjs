/**
 * Minimal PostgREST probes for the backend mesh: reachability and
 * per-table row counts, the same signals the app's boot self-check
 * uses (any HTTP response from /rest/v1/ proves the host is alive).
 *
 * Keys come from the environment only — nothing here stores, logs, or
 * returns key material. The service_role key is required for counts
 * (RLS hides tables from the anon key); it is used only as a request
 * header and never printed.
 */

const REQUEST_TIMEOUT_MS = 15000;

function headers(key) {
  return { apikey: key, Authorization: `Bearer ${key}` };
}

async function timedFetch(fetchImpl, url, options) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  const started = Date.now();
  try {
    const res = await fetchImpl(url, { ...options, signal: ctrl.signal });
    return { res, ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Is this backend alive at all? Mirrors runSelfChecks() in src/main.jsx.
 * Returns { ok, status, ms, detail } — ok=true means "the host answered
 * HTTP", even a 401/404: the provider is up even if this key is wrong.
 */
export async function probe(url, anonKey, fetchImpl = fetch) {
  const base = String(url || '').replace(/\/+$/, '');
  if (!base) return { ok: false, status: 0, ms: 0, detail: 'no address configured' };
  try {
    const { res, ms } = await timedFetch(fetchImpl, `${base}/rest/v1/`, {
      method: 'GET',
      headers: headers(anonKey),
    });
    return { ok: true, status: res.status, ms, detail: `HTTP ${res.status}` };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      ms: 0,
      detail: err?.name === 'AbortError' ? 'timed out' : String(err?.message || err),
    };
  }
}

/**
 * List exposed tables via the PostgREST OpenAPI document at /rest/v1/.
 * Returns sorted table names, or null when discovery fails (callers
 * fall back to the committed tables.json list).
 */
export async function discoverTables(url, key, fetchImpl = fetch) {
  const base = String(url || '').replace(/\/+$/, '');
  try {
    const { res } = await timedFetch(fetchImpl, `${base}/rest/v1/`, { headers: headers(key) });
    if (!res.ok) return null;
    const spec = await res.json();
    const paths = Object.keys(spec?.paths || {});
    const tables = paths
      .map((p) => p.replace(/^\//, ''))
      .filter((p) => p && !p.includes('/') && /^[a-z][a-z0-9_]*$/.test(p));
    return tables.length ? [...new Set(tables)].sort() : null;
  } catch {
    return null;
  }
}

/**
 * Row count for one table via a HEAD request with Prefer: count=exact.
 * PostgREST answers with `Content-Range: 0-24/1234` (or `*​/0`).
 * Returns the number, or null when the count cannot be read (RLS,
 * missing table, network) — null means "not seen", never zero.
 */
export async function fetchTableCount(url, key, table, fetchImpl = fetch) {
  const base = String(url || '').replace(/\/+$/, '');
  try {
    const { res } = await timedFetch(fetchImpl, `${base}/rest/v1/${table}?select=*`, {
      method: 'HEAD',
      headers: { ...headers(key), Prefer: 'count=exact' },
    });
    if (!res.ok) return null;
    const range = res.headers.get('content-range') || '';
    const total = range.split('/')[1];
    if (total === '*' || total === undefined) return null;
    const n = Number.parseInt(total, 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/** Counts for many tables. Sequential on purpose: gentle on free tiers. */
export async function fetchCounts(url, key, tables, fetchImpl = fetch) {
  const counts = {};
  for (const table of tables) {
    const n = await fetchTableCount(url, key, table, fetchImpl);
    if (n !== null) counts[table] = n;
  }
  return counts;
}
