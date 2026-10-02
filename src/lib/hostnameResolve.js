/**
 * hostnameResolve — decides, from the address the browser is visiting,
 * whether to show the normal app or one shop's public storefront.
 *
 * Three ways a shop page can be reached:
 *   1. Hash link (the original way): <app>/​#/store/<slug>
 *   2. Automatic subdomain: <slug>.<apex> — zero setup for the shop, works
 *      for every published storefront the moment DNS + the wildcard host
 *      route exist (see docs/custom-domains.md). The apex is the product's
 *      own domain, a one-line setting: BRAND.apexDomain.
 *   3. The shop's own domain (e.g. mymarieshop.ca): the buyer points a
 *      CNAME at us; the hostname is looked up in the custom_domains table
 *      by the public_storefront_by_host RPC (migration 074) and the
 *      matching published storefront is served.
 *
 * SECURITY: a hostname is NEVER trusted. This module only chooses which
 * PUBLIC page to render. The storefront itself is public-only data served
 * by SECURITY DEFINER RPCs that re-check publication server-side, and the
 * admin app always boots behind its normal sign-in — arriving on a shop
 * hostname can never sign anyone in or elevate anything.
 */
export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

const LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

// Subdomains that never mean "a shop": www.<apex> is the main site.
const RESERVED_SUBDOMAINS = new Set(['www']);

// Deployment platforms' own hostnames. They serve the app but never host
// shop addresses; matching here keeps us from firing pointless (and
// always-empty) custom-domain lookups on every mirror page load.
const PLATFORM_SUFFIXES = [
  '.github.io',
  '.pages.dev',
  '.netlify.app',
  '.workers.dev',
  '.vercel.app',
  '.onrender.com',
];

/**
 * Lowercase, trim, drop a trailing dot and a single :port. IPv6 literals
 * keep their inner colons (bracketed or not). Never throws.
 */
export function normalizeHostname(raw) {
  let h = String(raw ?? '').trim().toLowerCase();
  if (!h) return '';
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    if (end > 0) return h.slice(1, end);
    return h.replace(/[[\]]/g, '');
  }
  // One colon = host:port. Many colons = a bare IPv6 literal — keep whole.
  if ((h.match(/:/g) || []).length === 1) h = h.slice(0, h.indexOf(':'));
  if (h.endsWith('.')) h = h.slice(0, -1);
  return h;
}

function isIpLiteral(host) {
  if (host.includes(':')) return true; // IPv6 (brackets already stripped)
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host);
}

/**
 * A plausible public DNS name: at least two labels, each 1–63 chars of
 * letters/numbers/dashes (no leading/trailing dash), 253 chars overall.
 * Punycode (xn--…) passes. Used before any custom-domain lookup or save.
 */
export function isValidHostname(host) {
  const h = normalizeHostname(host);
  if (!h || h.length > 253) return false;
  const labels = h.split('.');
  if (labels.length < 2) return false;
  return labels.every((label) => LABEL_PATTERN.test(label));
}

/**
 * resolveHostname(hostname, apexDomain) -> one of:
 *   { kind: 'app' }                    boot the normal app
 *   { kind: 'storefront', slug }       show this slug's public page
 *   { kind: 'custom', hostname }       ask the DB which shop (if any) owns
 *                                      this hostname, then show its page
 *   { kind: 'not-found' }              under our apex but not a usable shop
 *                                      name — show the friendly dead end
 *
 * Pure and total: any input (garbage included) returns a route, and bad
 * input falls back to the normal app rather than a blank page.
 */
export function resolveHostname(rawHost, apexDomain) {
  const host = normalizeHostname(rawHost);
  const apex = normalizeHostname(apexDomain);
  if (!host) return { kind: 'app' };

  // Local development and LAN previews behave exactly as before.
  if (
    isIpLiteral(host) ||
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.test')
  ) {
    return { kind: 'app' };
  }

  if (apex) {
    if (host === apex) return { kind: 'app' };
    if (host.endsWith(`.${apex}`)) {
      const prefix = host.slice(0, host.length - apex.length - 1);
      if (prefix.includes('.')) return { kind: 'not-found' };
      if (RESERVED_SUBDOMAINS.has(prefix)) return { kind: 'app' };
      if (SLUG_PATTERN.test(prefix)) return { kind: 'storefront', slug: prefix };
      return { kind: 'not-found' };
    }
  }

  if (PLATFORM_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    return { kind: 'app' };
  }

  // Anything else that looks like a real DNS name might be a shop's own
  // domain — ask the database. Anything else is just an odd host; the app.
  if (!isValidHostname(host)) return { kind: 'app' };
  return { kind: 'custom', hostname: host };
}

/**
 * Admin-side cleanup for a domain the shop typed or pasted (they WILL
 * paste "https://mymarieshop.ca/"). Returns a normalized hostname, or ''
 * when nothing usable was entered.
 */
export function normalizeDomainInput(raw) {
  let s = String(raw ?? '').trim().toLowerCase();
  s = s.replace(/^https?:\/\//, '');
  s = s.split('/')[0].split('?')[0].split('#')[0];
  return normalizeHostname(s);
}

/**
 * Look up which published shop (if any) owns a custom hostname.
 * Calls the public_storefront_by_host RPC over REST with the anon key —
 * the same public door the storefront page itself uses; no service keys,
 * no session. Returns the slug, or null when the hostname is unknown or
 * the shop unpublished its page. Throws on transport/HTTP failure so the
 * caller can show its honest error state. fetchImpl is injectable for
 * tests.
 */
export async function lookupSlugForHost({ supabaseUrl, anonKey, hostname, fetchImpl }) {
  const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!doFetch) throw new Error('no fetch available for storefront host lookup');
  const base = String(supabaseUrl || '').replace(/\/+$/, '');
  const res = await doFetch(`${base}/rest/v1/rpc/public_storefront_by_host`, {
    method: 'POST',
    headers: {
      apikey: anonKey,
      Authorization: `Bearer ${anonKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ p_host: hostname }),
  });
  if (!res.ok) throw new Error(`storefront host lookup failed (${res.status})`);
  const data = await res.json();
  return typeof data === 'string' && SLUG_PATTERN.test(data) ? data : null;
}
