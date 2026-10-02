/**
 * Customer-side client for online ordering (src/lib/onlineOrders.js).
 *
 * Thin wrappers around the shared Supabase client (backend.supabase) for
 * the RPCs from migration 073. Every function takes the client so the
 * storefront page passes the one it already holds; no app state needed.
 *
 * Auth flows (signUp / signIn / signOut) are minimal wrappers on
 * client.auth. If the Supabase project requires email confirmation, a
 * sign-up returns { needsEmailConfirm: true } — the page shows the
 * "check your email" message instead of pretending the login worked.
 * (The dedicated email-auth workstream may supersede these flows later;
 * the contract surface here — a session or a clear email-confirm state —
 * stays the same.)
 */

const ERROR_CODES = [
  'ONLINE_NEEDS_SIGNIN',
  'ONLINE_SHOP_NOT_FOUND',
  'ONLINE_ORDERING_OFF',
  'ONLINE_BAD_ITEMS',
  'ONLINE_NAME_REQUIRED',
  'ONLINE_ITEM_UNAVAILABLE',
  'ONLINE_OUT_OF_STOCK',
  'ONLINE_TOO_MANY_ORDERS',
  'ONLINE_ORDER_NOT_FOUND',
  'ONLINE_FORBIDDEN',
  'ONLINE_BAD_STATUS',
  'ONLINE_BAD_METHOD',
  'ONLINE_ALREADY_SOLD',
  'ONLINE_UNDERPAID',
];

function asError(err) {
  const message = String(err?.message || err || 'Unknown error');
  const code = ERROR_CODES.find((c) => message.includes(c)) || null;
  const e = new Error(message);
  e.code = code;
  e.rpc = true;
  return e;
}

async function rpc(client, name, args) {
  const { data, error } = await client.rpc(name, args);
  if (error) throw asError(error);
  return data;
}

// ---- auth (session helpers only) -------------------------------------
export async function getCustomerSession(client) {
  try {
    const { data } = await client.auth.getSession();
    return data?.session || null;
  } catch {
    return null;
  }
}

export function customerEmailOf(session) {
  return session?.user?.email || null;
}

// Returns { session } on immediate sign-in, or
// { needsEmailConfirm: true, email } when the project requires the
// customer to click the confirmation link first.
export async function customerSignUp(client, email, password) {
  const cleanEmail = String(email || '').trim().toLowerCase();
  const { data, error } = await client.auth.signUp({
    email: cleanEmail,
    password: String(password || ''),
  });
  if (error) throw asError(error);
  if (data?.session) return { session: data.session };
  return { needsEmailConfirm: true, email: cleanEmail };
}

export async function customerSignIn(client, email, password) {
  const { data, error } = await client.auth.signInWithPassword({
    email: String(email || '').trim().toLowerCase(),
    password: String(password || ''),
  });
  if (error) throw asError(error);
  return { session: data?.session || null };
}

export async function customerSignOut(client) {
  try {
    await client.auth.signOut();
  } catch {
    /* signing out a missing session is not an error */
  }
}

export function onCustomerAuthChange(client, cb) {
  try {
    const { data } = client.auth.onAuthStateChange((_event, session) => cb(session || null));
    return () => data?.subscription?.unsubscribe?.();
  } catch {
    return () => {};
  }
}

// ---- customer ordering ------------------------------------------------
// Feature probe for migration 073: does the storefront column set (and
// the order tables) exist yet? Hidden behind a cached promise so the
// storefront can degrade to "ordering not switched on" on old databases.
let ordersProbe = null;
export function onlineOrderingReady(client) {
  if (!ordersProbe) {
    ordersProbe = (async () => {
      try {
        const res = await client
          .from('storefront_profiles')
          .select('online_ordering')
          .limit(1);
        if (res.error) return false;
        return true;
      } catch {
        return false;
      }
    })();
  }
  return ordersProbe;
}

export function getProfile(client, slug) {
  return rpc(client, 'online_profile_get', { p_slug: slug });
}

export function saveProfile(client, slug, { name, phone }) {
  return rpc(client, 'online_profile_save', {
    p_slug: slug,
    p_name: name,
    p_phone: phone,
  });
}

// lines: [{ product_id, qty }] — quantities only; the server re-prices.
export function placeOrder(client, slug, { lines, pickupNote, name, phone, idemKey }) {
  return rpc(client, 'online_order_place', {
    p_slug: slug,
    p_items: lines,
    p_pickup_note: pickupNote || null,
    p_name: name,
    p_phone: phone || null,
    p_idempotency_key: idemKey || null,
  });
}

export function myOrders(client, slug) {
  return rpc(client, 'online_order_my_orders', { p_slug: slug });
}

export function cancelOrder(client, orderId) {
  return rpc(client, 'online_order_cancel', { p_order_id: orderId });
}

// Fresh idempotency key for one checkout attempt; the SAME key must be
// reused across retries of the same payload (the button disables while
// busy so the key only matters for network retries).
export function newIdempotencyKey() {
  try {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  } catch {
    /* fall through */
  }
  return `ord-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
