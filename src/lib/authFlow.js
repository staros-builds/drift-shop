/**
 * One-login auth flow — pure logic, no imports, unit-testable.
 *
 * Owns the email-signup-with-confirmation flow (Jesse's "one login"
 * requirement, 2026-10-01): owners and customers sign up with a REAL email
 * address, prove it via a confirmation email, and land back where they
 * started. Covers:
 *
 *  - signup email validation (real emails only — synthetic @accountsDomain
 *    addresses from legacy username accounts can never receive mail and
 *    would collide with those accounts);
 *  - the pending-flow record saved before signup so the confirmation
 *    landing knows whether this is an OWNER (route to the desktop / shop
 *    setup) or a CUSTOMER (route back to the shop page);
 *  - the confirmation-email redirect URL builder;
 *  - parsing the auth callback URL (PKCE ?code=, legacy implicit hash,
 *    and error fragments like otp_expired);
 *  - the confirmation-resend cooldown;
 *  - one-time auth notices (expired link) shown on the login screen.
 *
 * The URL is the cross-device carrier: the confirmation email link always
 * carries ?authflow=owner|customer[&shop=<slug>], so confirming on a
 * different device than the signup still routes correctly. localStorage is
 * the same-device fallback.
 */

export const PENDING_FLOW_KEY = 'driftshop_pending_auth_flow';
export const AUTH_NOTICE_KEY = 'driftshop_auth_notice';

// Supabase's per-user resend window (docs/guides/auth/rate-limits, checked
// 2026-10-01). The UI disables the button for this long after each send.
export const RESEND_COOLDOWN_MS = 60_000;

// A pending flow older than this is ignored (stale tab, abandoned signup).
export const PENDING_FLOW_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Social sign-in providers (Jesse, 2026-10-01; expanded 2026-10-02 for
// maximum login ease/flexibility): email + password stays, but users may
// also continue with any of these services. Only providers that Supabase
// can enable for free and that we wire end-to-end belong here — the UI
// renders exactly this list, and the backend rejects anything else before
// calling Supabase. A provider that isn't switched on in Supabase Auth →
// Providers yet fails gracefully with the coded 'oauth-not-enabled' error
// (plain-language UI message), never a crash.
// OAuth providers are currently disabled — none are configured in Supabase Auth.
// When a provider is set up (OAuth app + client ID/secret in Supabase dashboard),
// add it back here. Until then, the list stays empty per the "no switch on later" rule.
export const OAUTH_PROVIDERS = [];

/** Normalize a provider id to a supported OAuth provider, or null. */
export function normalizeOAuthProvider(provider) {
  const p = String(provider || '').trim().toLowerCase();
  return OAUTH_PROVIDERS.some((entry) => entry.id === p) ? p : null;
}

/**
 * Decide the account_kind to stamp after an OAuth callback.
 *
 * Supabase's signInWithOAuth cannot carry signup metadata, so fresh OAuth
 * users arrive with profiles.account_kind = NULL (migration 070's trigger).
 * The callback knows which flow the user started (?authflow=owner|customer
 * rides the redirect URL, with the pending-flow record as fallback) — this
 * helper turns that into a stamp decision:
 *
 *   returns 'owner' | 'customer' — stamp it (profile is unclassified);
 *   returns null                 — leave the profile alone.
 *
 * Rules, all deliberate:
 *  - an already-classified profile ('owner' | 'customer') is NEVER
 *    overwritten — an email owner who links Google stays an owner, a
 *    customer can never self-promote to owner via a crafted callback;
 *  - an unknown flow kind stamps nothing;
 *  - stamping 'owner' from the OAuth landing is not a privilege escalation:
 *    email signup as an owner is a public flow, so OAuth owners get exactly
 *    what email owners get (setup access; the shop licensing/trial gate
 *    still applies afterwards).
 */
export function classifyAccountKind(currentKind, flowKind) {
  const want =
    flowKind === 'owner' ? 'owner' : flowKind === 'customer' ? 'customer' : null;
  if (!want) return null;
  if (currentKind === 'owner' || currentKind === 'customer') return null;
  return want;
}

/**
 * Validate an email for SIGNUP. Returns { ok: true, email } or
 * { ok: false, code } where code is one of:
 *   'email-required' | 'invalid-email' | 'synthetic-domain'
 *
 * synthetic-domain: the address sits on the brand's synthetic accounts
 * domain (loginId.js maps bare usernames there). Those addresses are not
 * real inboxes — a confirmation email can never arrive — and they collide
 * with legacy username accounts. Signup must reject them loudly.
 */
export function validateSignupEmail(raw, accountsDomain) {
  const email = String(raw ?? '').trim();
  if (!email) return { ok: false, code: 'email-required' };
  if (!EMAIL_RE.test(email)) return { ok: false, code: 'invalid-email' };
  const domain = (accountsDomain || '').trim().toLowerCase();
  if (domain && email.toLowerCase().endsWith(`@${domain}`)) {
    return { ok: false, code: 'synthetic-domain' };
  }
  return { ok: true, email };
}

/** Milliseconds until the resend button may be used again (0 = now). */
export function resendCooldownRemaining(lastSentAt, now = Date.now()) {
  if (!lastSentAt) return 0;
  const elapsed = now - Number(lastSentAt);
  if (!Number.isFinite(elapsed) || elapsed < 0) return RESEND_COOLDOWN_MS;
  return Math.max(0, RESEND_COOLDOWN_MS - elapsed);
}

function storeOrNull(store) {
  if (store) return store;
  try {
    if (typeof window !== 'undefined' && window.localStorage) return window.localStorage;
  } catch {
    /* non-fatal */
  }
  return null;
}

/**
 * Save the pending signup flow before navigating to the confirmation
 * email. flow = { kind: 'owner' | 'customer', slug?: string }.
 */
export function savePendingFlow(flow, store) {
  const s = storeOrNull(store);
  if (!s) return;
  try {
    s.setItem(
      PENDING_FLOW_KEY,
      JSON.stringify({
        kind: flow && flow.kind === 'customer' ? 'customer' : 'owner',
        slug: typeof flow?.slug === 'string' ? flow.slug : undefined,
        savedAt: Date.now(),
      })
    );
  } catch {
    /* non-fatal */
  }
}

/** Read the pending flow (null when absent or stale). */
export function readPendingFlow(store) {
  const s = storeOrNull(store);
  if (!s) return null;
  try {
    const raw = s.getItem(PENDING_FLOW_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || (parsed.kind !== 'owner' && parsed.kind !== 'customer')) return null;
    if (parsed.savedAt && Date.now() - Number(parsed.savedAt) > PENDING_FLOW_TTL_MS) return null;
    return { kind: parsed.kind, slug: parsed.slug || null };
  } catch {
    return null;
  }
}

export function clearPendingFlow(store) {
  const s = storeOrNull(store);
  if (!s) return;
  try {
    s.removeItem(PENDING_FLOW_KEY);
  } catch {
    /* non-fatal */
  }
}

/**
 * Build the redirect target for an email-confirmation link OR an OAuth
 * provider round trip:
 *   <origin><basePath>?authflow=<kind>[&shop=<slug>]
 * Query-only (no hash): GoTrue merges ?code= into it on the way back, and
 * the callback parser routes from the authflow param. Must be covered by
 * the Supabase project's Redirect URLs allowlist (wildcards supported —
 * see docs/one-login-email-signup.md).
 */
export function buildSignupRedirectTo({ origin, basePath, kind, slug }) {
  const o = String(origin || '').replace(/\/+$/, '');
  const base = String(basePath || '/');
  const normalizedBase = base.endsWith('/') ? base : `${base}/`;
  const params = new URLSearchParams();
  params.set('authflow', kind === 'customer' ? 'customer' : 'owner');
  if (kind === 'customer' && slug) params.set('shop', String(slug));
  return `${o}${normalizedBase}?${params.toString()}`;
}

/**
 * Parse an auth callback URL. Returns one of:
 *   { kind: 'code', code, authflow }   — PKCE ?code= (signup OR recovery;
 *                                         authflow tells which: 'owner' |
 *                                         'customer' | 'recovery' | null)
 *   { kind: 'signup-implicit' }         — #access_token…&type=signup
 *   { kind: 'recovery-implicit' }       — #access_token…&type=recovery
 *   { kind: 'error', errorCode }        — #error=…&error_code=otp_expired…
 *                                         (Supabase delivers errors as
 *                                         fragments; error_code 'otp_expired'
 *                                         is the "link expired" case)
 *   { kind: 'none' }
 */
export function parseAuthCallbackUrl(urlString) {
  let url;
  try {
    url = new URL(urlString);
  } catch {
    return { kind: 'none' };
  }
  const hash = new URLSearchParams((url.hash || '').replace(/^#/, ''));
  const errParam = hash.get('error') || url.searchParams.get('error');
  if (errParam) {
    const errorCode =
      hash.get('error_code') || url.searchParams.get('error_code') || 'other';
    return { kind: 'error', errorCode };
  }
  if (url.searchParams.get('code')) {
    return { kind: 'code', code: url.searchParams.get('code'), authflow: url.searchParams.get('authflow') };
  }
  const hashType = hash.get('type');
  if (hash.get('access_token')) {
    if (hashType === 'recovery') return { kind: 'recovery-implicit' };
    if (hashType === 'signup' || hashType === 'magiclink') {
      return { kind: 'signup-implicit' };
    }
  }
  return { kind: 'none' };
}

/**
 * Merge the flow markers from the callback URL with the same-device
 * pending record. The URL wins (it survives cross-device); the pending
 * record is the fallback when the URL carries no markers.
 */
export function resolveConfirmedFlow(urlAuthflow, urlSlug, store) {
  const pending = readPendingFlow(store);
  const kind =
    urlAuthflow === 'customer' || urlAuthflow === 'owner'
      ? urlAuthflow
      : pending?.kind || null;
  const slug = urlSlug || pending?.slug || null;
  return { kind, slug };
}

/** One-time notice for the login screen: { kind, email? } | null. */
export function setAuthNotice(notice, store) {
  const s = storeOrNull(store);
  if (!s) return;
  try {
    s.setItem(AUTH_NOTICE_KEY, JSON.stringify(notice || null));
  } catch {
    /* non-fatal */
  }
}

/** Read + clear the notice (login screen shows it once). */
export function readAndClearAuthNotice(store) {
  const s = storeOrNull(store);
  if (!s) return null;
  try {
    const raw = s.getItem(AUTH_NOTICE_KEY);
    s.removeItem(AUTH_NOTICE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed.kind === 'string' ? parsed : null;
  } catch {
    return null;
  }
}
