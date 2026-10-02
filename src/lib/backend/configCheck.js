/**
 * Boot-time validation of the built-in Supabase connection settings.
 *
 * Why this exists: a production build once shipped with a truncated
 * VITE_SUPABASE_ANON_KEY. The old presence check ("are the variables
 * set?") passed, the app booted, and sign-in then failed with a raw
 * "Invalid API key" — users reasonably blamed their password. These
 * helpers validate the SHAPE of the config before the app boots so a
 * broken build says "the connection settings look wrong" instead.
 *
 * Key families (October 2026): legacy JWT anon keys and the new
 * sb_publishable_… keys are both accepted; an sb_secret_… server key
 * is refused with its own plain-language problem. See keyKind().
 *
 * Pure functions, no imports — unit-testable in Node (see
 * test/config-check.test.mjs). Problem strings describe the config's
 * shape only; they never contain key material (segment counts and
 * lengths are safe, key bytes are not).
 */

/** base64url-decode one JWT segment to parsed JSON, or null. */
function decodeSegmentJson(seg) {
  try {
    const b64 = String(seg).replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const text = atob(padded);
    // atob yields a byte string; JWT payloads are UTF-8 JSON.
    const bytes = Uint8Array.from(text, (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

/**
 * Validate the server URL. Returns { ok, ref, problems } where ref is
 * the project ref for hosted projects (<ref>.supabase.co), else null.
 */
export function checkSupabaseUrl(rawUrl) {
  const problems = [];
  const url = String(rawUrl ?? '').trim();
  let parsed = null;
  try {
    parsed = new URL(url);
  } catch {
    problems.push('server address is not a readable URL');
    return { ok: false, ref: null, problems };
  }
  if (parsed.protocol !== 'https:') {
    problems.push('server address must start with https://');
  }
  const host = parsed.hostname.toLowerCase();
  const hosted = host === 'supabase.co' || host.endsWith('.supabase.co') || host.endsWith('.supabase.in');
  if (!hosted) {
    problems.push('server address is not a Supabase address (…supabase.co expected)');
    return { ok: false, ref: null, problems };
  }
  const ref = host.endsWith('.supabase.co') ? host.split('.')[0] : null;
  return { ok: problems.length === 0, ref, problems };
}

/**
 * Which family a candidate access key belongs to. Supabase issues two
 * families today (verified against Supabase's public key-migration
 * guidance, October 2026):
 *
 * - 'jwt': the legacy keys — `anon` / `service_role` JWTs (three
 *   dot-separated base64url segments). Deprecated at the end of 2026 but
 *   still fully supported; projects created before the cutover have
 *   these.
 * - 'publishable': the new client key, `sb_publishable_…`. Projects
 *   created after November 2025 ONLY have these (plus the secret key);
 *   there is no JWT anon key to copy. It is an opaque token, NOT a JWT:
 *   it authorizes via the `apikey` header alone and must never be sent
 *   as an `Authorization: Bearer` token (the gateway can reject it as an
 *   invalid token).
 * - 'secret': the new server-only key, `sb_secret_…`. It bypasses row
 *   security — shipping it inside the app would hand every visitor full
 *   database access. Boot must refuse it with a plain-language problem,
 *   never quietly accept it.
 *
 * Pure shape classification — no network, no key material echoed.
 */
export function keyKind(rawKey) {
  const key = String(rawKey ?? '').trim();
  if (key.startsWith('sb_publishable_')) return 'publishable';
  if (key.startsWith('sb_secret_')) return 'secret';
  if (key.split('.').length === 3) return 'jwt';
  return 'unknown';
}

/**
 * Request headers for raw (non-SDK) probes against this project's REST
 * API. The API key always travels on the `apikey` header. A legacy JWT
 * key is ALSO sent as `Authorization: Bearer` (PostgREST reads the role
 * from it, as before). A publishable key must NOT be duplicated into
 * `Authorization` — the platform rejects a non-JWT Bearer token as an
 * invalid token, which would make a healthy backend look broken.
 */
export function probeHeaders(rawKey) {
  const key = String(rawKey ?? '').trim();
  const headers = { apikey: key };
  if (keyKind(key) === 'jwt') headers.Authorization = `Bearer ${key}`;
  return headers;
}

/**
 * Validate the access key's shape. Two accepted families:
 *
 * - Legacy JWT: a complete JWT (three dot-separated segments),
 *   decodable header/payload, carrying Supabase's role claim, and —
 *   when both sides name a project — issued for the same project the
 *   URL points at.
 * - New publishable key: `sb_publishable_` followed by a sane opaque
 *   suffix. It carries no project ref to cross-check (opaque by
 *   design); a wrong-project publishable key is caught by the boot
 *   reachability/schema probes instead of here.
 *
 * An `sb_secret_…` key is refused outright: it is the server-only key
 * and must never be baked into the app.
 */
export function checkAnonKey(rawKey, expectedRef) {
  const problems = [];
  const key = String(rawKey ?? '').trim();
  const kind = keyKind(key);
  if (kind === 'secret') {
    problems.push(
      'access key is the SECRET server key (starts with sb_secret_) — it must never be used in the app; copy the publishable key (sb_publishable_…) from the same settings page instead',
    );
    return { ok: false, problems };
  }
  if (kind === 'publishable') {
    const suffix = key.slice('sb_publishable_'.length);
    if (!/^[A-Za-z0-9_-]+$/.test(suffix) || suffix.length < 16) {
      problems.push('publishable access key looks cut off or incomplete — copy the whole key');
      return { ok: false, problems };
    }
    return { ok: true, problems };
  }
  const parts = key.split('.');
  if (parts.length !== 3 || parts.some((p) => !p)) {
    problems.push(
      `access key has ${parts.length} part(s) instead of 3 — it looks cut off or incomplete`,
    );
    return { ok: false, problems };
  }
  if (!parts.every((p) => /^[A-Za-z0-9_-]+$/.test(p))) {
    problems.push('access key contains characters a key should not have');
    return { ok: false, problems };
  }
  const header = decodeSegmentJson(parts[0]);
  if (!header || typeof header.alg !== 'string') {
    problems.push('access key header cannot be read — not a complete key');
    return { ok: false, problems };
  }
  const payload = decodeSegmentJson(parts[1]);
  if (!payload || typeof payload !== 'object') {
    problems.push('access key body cannot be read — not a complete key');
    return { ok: false, problems };
  }
  if (payload.role !== 'anon' && payload.role !== 'service_role') {
    problems.push('access key is not a Supabase access key (no valid role inside)');
    return { ok: false, problems };
  }
  if (expectedRef && typeof payload.ref === 'string' && payload.ref !== expectedRef) {
    problems.push('access key belongs to a different project than the server address');
    return { ok: false, problems };
  }
  return { ok: true, problems };
}

/**
 * Full boot config verdict:
 * - 'missing': URL or key absent (the pre-existing not-configured case)
 * - 'invalid': present but malformed — boot must stop with the config
 *   problem screen instead of limping to a confusing sign-in failure
 * - 'ok': shape is valid; reachability is checked separately
 */
export function validateBackendConfig(url, key) {
  if (!String(url ?? '').trim() || !String(key ?? '').trim()) {
    return { status: 'missing', problems: [] };
  }
  const urlCheck = checkSupabaseUrl(url);
  const keyCheck = checkAnonKey(key, urlCheck.ref);
  const problems = [...urlCheck.problems, ...keyCheck.problems];
  return { status: problems.length === 0 ? 'ok' : 'invalid', problems };
}

export default validateBackendConfig;
