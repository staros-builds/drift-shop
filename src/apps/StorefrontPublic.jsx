import React, { useEffect, useRef, useState } from 'react';
import { backend } from '../lib/backend/current.js';
import { BRAND } from '../lib/brand.js';
import { getLang, tagFor } from '../lib/localeTag.js';
import { en } from '../lib/locales/en.js';
import { fr } from '../lib/locales/fr.js';
import { es } from '../lib/locales/es.js';
import { pt } from '../lib/locales/pt.js';
import { applyStorefrontSeo } from '../lib/storefrontSeo.js';
import StorefrontLinks from './StorefrontLinks.jsx';
import {
  emptyCart,
  addLine,
  setLineQty,
  removeLine,
  cartCount,
  cartTotals,
  validateCartForOrder,
  cartToOrderItems,
  loadCart,
  saveCart,
  clearCart,
} from '../lib/onlineCart.js';
import {
  onlineOrderingReady,
  getProfile,
  saveProfile,
  placeOrder,
  myOrders,
  cancelOrder,
  newIdempotencyKey,
} from '../lib/onlineOrders.js';
import { OAUTH_PROVIDERS, savePendingFlow, clearPendingFlow } from '../lib/authFlow.js';

/**
 * Public storefront page (#/store/<slug>) — the customer-facing web page
 * for one shop, the Comelin-style "website" half of Drift Shop.
 *
 * main.jsx renders this INSTEAD of the desktop when the URL hash matches
 * #/store/<slug>: no staff login required, no app chrome, no self-check
 * gate. Data comes from the public_storefront() RPC (migration 063,
 * extended by 073) — a security-definer function that is the ONLY
 * anonymous door to shop data. It serves the same pos_products rows the
 * POS sells from (filtered to the products the shop left public_visible,
 * which defaults to ON), and only while the shop's storefront profile is
 * published. Unknown or unpublished slugs get NULL back, so this page
 * shows an honest "not available" state instead of leaking anything.
 *
 * The header carries a plain staff login button: shop staff follow it to
 * the normal app entry (same origin, brand base path, no storefront
 * hash) and sign in there.
 *
 * Online ordering (migration 073): when the shop switches on "Accept
 * online orders", signed-in customers can add products to a cart and
 * place an order. Customer login is email-based (no traditional
 * usernames on the storefront — the same rule as staff signup). Guests
 * can browse everything but cannot order: every order is tied to an
 * authenticated user, so anonymous order spam is impossible by design.
 * Orders are priced, taxed and stock-checked SERVER-SIDE by
 * online_order_place(); this page never sends prices or totals — only
 * product ids and quantities. Pay-at-pickup is the honest default: the
 * shop converts the order to a real till sale when the customer pays.
 *
 * Self-contained inline styles on purpose: the page must render cleanly
 * on a phone without the desktop theme. Customer UI strings live in the
 * shared `onlineOrders` locale namespace (en.js/fr.js) via getLang() —
 * the same store the in-app strings use, so the ES/PT parity pass covers
 * them. The page's pre-existing stacked EN/FR display blocks are kept
 * as-is.
 */

const FALLBACK_ACCENT = '#b4542a';

function money(cents, currency = '$') {
  return `${currency}${(Number(cents || 0) / 100).toFixed(2)}`;
}

function accentOf(value) {
  return /^#[0-9a-fA-F]{6}$/.test(String(value || '')) ? value : FALLBACK_ACCENT;
}

// Customer UI strings: same locale store as the app (onlineOrders
// namespace); the visitor's persisted app language picks EN or FR.
function oo(key, vars) {
  const lang = getLang();
  const dicts = { en, fr, es, pt };
  const dict = (dicts[lang] || fr).onlineOrders || {};
  let s = dict[key] ?? en.onlineOrders[key] ?? key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) s = String(s).replaceAll(`{${k}}`, String(v));
  }
  return s;
}

const ORDER_STATUS_KEYS = {
  received: 'stReceived',
  preparing: 'stPreparing',
  ready: 'stReady',
  done: 'stDone',
  cancelled: 'stCancelled',
};

const PLACE_ERROR_KEYS = {
  ONLINE_TOO_MANY_ORDERS: 'tooManyOrders',
  ONLINE_ITEM_UNAVAILABLE: 'itemUnavailable',
  ONLINE_OUT_OF_STOCK: 'outOfStockAtOrder',
  ONLINE_NAME_REQUIRED: 'nameRequired',
  ONLINE_NEEDS_SIGNIN: 'signInFirst',
};

const styles = {
  page: {
    minHeight: '100vh',
    background: '#f7f3ec',
    color: '#26221c',
    fontFamily:
      'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
    margin: 0,
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    padding: '12px 16px',
    background: '#fffdf8',
    borderBottom: '1px solid #e2d9c8',
  },
  headerName: { fontWeight: 700, fontSize: 15, letterSpacing: 0.2, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  headerBtns: { display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0 },
  loginBtn: {
    flexShrink: 0,
    fontSize: 13,
    fontWeight: 600,
    color: '#26221c',
    background: '#fffdf8',
    border: '1px solid #c9bda6',
    borderRadius: 999,
    padding: '7px 14px',
    textDecoration: 'none',
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  acctBtn: {
    flexShrink: 0,
    fontSize: 13,
    fontWeight: 700,
    color: '#fffdf8',
    border: 'none',
    borderRadius: 999,
    padding: '8px 16px',
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  main: { maxWidth: 960, margin: '0 auto', padding: '0 16px 48px', minWidth: 0 },
  hero: { padding: '36px 0 8px', textAlign: 'center' },
  heroRule: { width: 56, height: 4, borderRadius: 2, margin: '0 auto 18px' },
  h1: { fontSize: 34, lineHeight: 1.15, margin: '0 0 8px', fontWeight: 800, overflowWrap: 'anywhere' },
  tagline: { fontSize: 17, color: '#6d6252', margin: '0 auto', maxWidth: 640, overflowWrap: 'anywhere' },
  section: { marginTop: 32 },
  sectionHead: { textAlign: 'center', fontSize: 20, fontWeight: 800, margin: '0 0 4px', overflowWrap: 'anywhere' },
  sectionSub: { textAlign: 'center', fontSize: 14, color: '#6d6252', margin: '0 0 8px', maxWidth: 640, marginLeft: 'auto', marginRight: 'auto' },
  sectionText: { whiteSpace: 'pre-line', fontSize: 15, lineHeight: 1.65, color: '#3d372e', maxWidth: 720, margin: '0 auto', textAlign: 'center', overflowWrap: 'anywhere' },
  card: {
    background: '#fffdf8',
    border: '1px solid #e2d9c8',
    borderRadius: 14,
    padding: '16px 18px',
    maxWidth: 720,
    margin: '0 auto',
  },
  cardTitle: { fontSize: 12, fontWeight: 700, letterSpacing: 1.2, textTransform: 'uppercase', color: '#8a7d68', margin: '0 0 8px' },
  cardBody: { whiteSpace: 'pre-line', fontSize: 15, lineHeight: 1.6, margin: 0, overflowWrap: 'anywhere' },
  contactRow: { display: 'flex', flexWrap: 'wrap', gap: 10, justifyContent: 'center', marginTop: 4 },
  contactLink: {
    fontSize: 14,
    fontWeight: 600,
    color: '#26221c',
    border: '1px solid #c9bda6',
    borderRadius: 999,
    padding: '8px 16px',
    textDecoration: 'none',
    background: '#fffdf8',
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))',
    gap: 12,
    marginTop: 16,
    listStyle: 'none',
    margin: '16px 0 0',
    padding: 0,
  },
  srOnly: {
    position: 'absolute',
    width: 1,
    height: 1,
    overflow: 'hidden',
    clip: 'rect(0 0 0 0)',
    whiteSpace: 'nowrap',
  },
  product: {
    background: '#fffdf8',
    border: '1px solid #e2d9c8',
    borderRadius: 14,
    padding: '16px 14px',
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    minHeight: 76,
    minWidth: 0,
  },
  productName: { fontSize: 15, fontWeight: 600, lineHeight: 1.35, overflowWrap: 'anywhere', minWidth: 0 },
  productPrice: { fontSize: 15, fontWeight: 800, marginTop: 'auto' },
  addBtn: {
    marginTop: 8,
    fontSize: 14,
    fontWeight: 700,
    border: 'none',
    borderRadius: 999,
    padding: '9px 12px',
    color: '#fffdf8',
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  addBtnDisabled: {
    marginTop: 8,
    fontSize: 13,
    fontWeight: 600,
    border: '1px solid #e2d9c8',
    borderRadius: 999,
    padding: '8px 12px',
    color: '#8a7d68',
    background: '#f7f3ec',
    cursor: 'default',
    fontFamily: 'inherit',
  },
  inCartPill: {
    fontSize: 12,
    fontWeight: 700,
    color: '#8a7d68',
  },
  center: { textAlign: 'center', padding: '72px 16px', color: '#6d6252', fontSize: 15, lineHeight: 1.6 },
  footer: {
    borderTop: '1px solid #e2d9c8',
    padding: '18px 16px 26px',
    textAlign: 'center',
    fontSize: 12,
    color: '#8a7d68',
  },
  // --- modals (customer account / cart / orders) ---
  overlay: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(38,34,28,0.45)',
    zIndex: 50,
    display: 'flex',
    alignItems: 'flex-end',
    justifyContent: 'center',
  },
  sheet: {
    background: '#fffdf8',
    borderRadius: '18px 18px 0 0',
    width: '100%',
    maxWidth: 560,
    maxHeight: '88vh',
    overflowY: 'auto',
    padding: '20px 20px 28px',
    boxSizing: 'border-box',
  },
  sheetTitle: { fontSize: 18, fontWeight: 800, margin: '0 0 4px' },
  sheetSub: { fontSize: 13, color: '#6d6252', margin: '0 0 14px', lineHeight: 1.5 },
  fieldLabel: { display: 'block', fontSize: 13, fontWeight: 700, margin: '12px 0 4px' },
  field: {
    width: '100%',
    boxSizing: 'border-box',
    fontSize: 15,
    border: '1px solid #c9bda6',
    borderRadius: 10,
    padding: '10px 12px',
    fontFamily: 'inherit',
    background: '#fff',
    color: '#26221c',
  },
  primaryBtn: {
    width: '100%',
    marginTop: 16,
    fontSize: 16,
    fontWeight: 800,
    border: 'none',
    borderRadius: 12,
    padding: '13px 12px',
    color: '#fffdf8',
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  ghostBtn: {
    width: '100%',
    marginTop: 10,
    fontSize: 14,
    fontWeight: 600,
    border: '1px solid #c9bda6',
    borderRadius: 12,
    padding: '11px 12px',
    color: '#26221c',
    background: '#fffdf8',
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  linkBtn: {
    background: 'none',
    border: 'none',
    padding: '8px 0',
    fontSize: 14,
    fontWeight: 600,
    color: '#6d6252',
    cursor: 'pointer',
    fontFamily: 'inherit',
    textDecoration: 'underline',
  },
  errBox: {
    marginTop: 12,
    fontSize: 13,
    lineHeight: 1.5,
    color: '#8f2f1f',
    background: '#fbeee8',
    border: '1px solid #e5bfae',
    borderRadius: 10,
    padding: '10px 12px',
  },
  noteBox: {
    marginTop: 12,
    fontSize: 13,
    lineHeight: 1.5,
    color: '#5c5344',
    background: '#f7f3ec',
    border: '1px solid #e2d9c8',
    borderRadius: 10,
    padding: '10px 12px',
  },
  cartLine: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '10px 0',
    borderBottom: '1px solid #eee5d3',
  },
  stepper: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    marginLeft: 'auto',
    flexShrink: 0,
  },
  stepBtn: {
    width: 34,
    height: 34,
    borderRadius: 999,
    border: '1px solid #c9bda6',
    background: '#fffdf8',
    fontSize: 18,
    fontWeight: 700,
    color: '#26221c',
    cursor: 'pointer',
    fontFamily: 'inherit',
    lineHeight: 1,
  },
  totalsRow: { display: 'flex', justifyContent: 'space-between', fontSize: 14, padding: '3px 0' },
  totalsTotal: { display: 'flex', justifyContent: 'space-between', fontSize: 17, fontWeight: 800, padding: '8px 0 0', borderTop: '1px solid #e2d9c8', marginTop: 8 },
  orderCard: {
    border: '1px solid #e2d9c8',
    borderRadius: 12,
    padding: '12px 14px',
    marginBottom: 10,
    background: '#fff',
  },
  statusPill: {
    display: 'inline-block',
    fontSize: 12,
    fontWeight: 800,
    borderRadius: 999,
    padding: '4px 10px',
    marginTop: 6,
  },
  bigNumber: {
    fontSize: 54,
    fontWeight: 800,
    textAlign: 'center',
    margin: '12px 0 4px',
    letterSpacing: 1,
  },
};

// One idempotency key per checkout attempt; reused across retries of the
// same payload so a shaky connection can never place the order twice.
function useIdempotencyKey() {
  const ref = useRef(newIdempotencyKey());
  const reset = () => {
    ref.current = newIdempotencyKey();
  };
  return [ref, reset];
}

export default function StorefrontPublic({ slug, configError = null, appHome = null }) {
  // configError (2026-10-01 hardening): main.jsx validated the build's
  // Supabase URL/key shape before rendering us and found it broken (e.
  // a truncated anon key). Skip the RPC entirely and show the same
  // honest error state a failed load would — never flash a spinner or
  // fire a doomed network call with a known-bad key.
  const [state, setState] = useState({
    phase: configError ? 'error' : 'loading',
    data: null,
  });
  const [session, setSession] = useState(undefined); // undefined = checking
  const [ordersReady, setOrdersReady] = useState(null); // migration 073 probe
  const [cart, setCart] = useState(() => {
    try {
      return loadCart(window.localStorage, slug);
    } catch {
      return emptyCart();
    }
  });
  const [modal, setModal] = useState(null); // 'auth' | 'cart' | 'orders' | null
  const [authMode, setAuthMode] = useState('signin'); // signin | signup | checkEmail
  const [authEmail, setAuthEmail] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [authError, setAuthError] = useState('');
  const [authBusy, setAuthBusy] = useState(false);
  const [profile, setProfile] = useState(null); // { display_name, phone }
  const [custName, setCustName] = useState('');
  const [custPhone, setCustPhone] = useState('');
  const [pickupNote, setPickupNote] = useState('');
  const [placing, setPlacing] = useState(false);
  const [placeError, setPlaceError] = useState('');
  const [placed, setPlaced] = useState(null); // server order json after success
  const [ordersList, setOrdersList] = useState(null);
  const [ordersError, setOrdersError] = useState('');
  const [idemRef, resetIdem] = useIdempotencyKey();

  const loadShop = async () => {
    const { data, error } = await backend.supabase.rpc('public_storefront', {
      p_slug: slug,
    });
    if (error) {
      setState({ phase: 'error', data: null });
    } else if (!data) {
      setState({ phase: 'missing', data: null });
    } else {
      setState({ phase: 'ready', data });
    }
  };

  useEffect(() => {
    if (configError) return undefined;
    let cancelled = false;
    (async () => {
      await loadShop();
      if (cancelled) return;
      // Customer session: guests browse freely; ordering needs a login.
      // Read directly from Supabase client storage (not backend.auth's
      // cachedUser) to avoid owner-session races during boot.
      try {
        const { data } = await backend.supabase.auth.getSession();
        const su = data.session?.user || null;
        if (!cancelled) setSession(su ? { user: { id: su.id, email: su.email } } : null);
      } catch {
        if (!cancelled) setSession(null);
      }
      // Migration 073 capability: pre-migration databases simply don't
      // offer ordering (calm note, never a dead button).
      try {
        const ready = await onlineOrderingReady(backend.supabase);
        if (!cancelled) setOrdersReady(ready === true);
      } catch {
        if (!cancelled) setOrdersReady(false);
      }
    })();
    // Subscribe directly to Supabase auth changes (not backend.auth's
    // cachedUser) for the customer session.
    let unsubAuth = null;
    try {
      const { data } = backend.supabase.auth.onAuthStateChange((_event, sess) => {
        const su = sess?.user || null;
        if (!cancelled) {
          setSession(su ? { user: { id: su.id, email: su.email } } : null);
          setProfile(null);
        }
      });
      unsubAuth = () => data?.subscription?.unsubscribe?.();
    } catch {
      unsubAuth = null;
    }
    return () => {
      cancelled = true;
      if (unsubAuth) unsubAuth();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, configError]);

  // Honest <html lang> for the visitor's language (screen readers).
  useEffect(() => {
    try {
      document.documentElement.lang = tagFor(getLang());
    } catch {
      /* noop */
    }
  }, []);

  // Link the signed-in customer to this shop once per session (SSO
  // shop_customers). Best-effort: ordering itself keys off the auth
  // session server-side; the link powers the shop's customer list.
  const linkTried = useRef(false);
  useEffect(() => {
    if (!session?.user || linkTried.current) return;
    linkTried.current = true;
    (async () => {
      try {
        await backend.customer.linkShopCustomer(slug);
      } catch {
        // Non-fatal: retried next visit.
      }
    })();
  }, [session, slug]);

  // Persist the cart per shop; never leaks between shops.
  useEffect(() => {
    try {
      saveCart(window.localStorage, slug, cart);
    } catch {
      /* private mode */
    }
  }, [cart, slug]);

  // Load the caller's profile when they sign in.
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    (async () => {
      try {
        const p = await getProfile(backend.supabase, slug);
        if (cancelled) return;
        setProfile(p);
        setCustName((cur) => cur || p?.display_name || '');
        setCustPhone((cur) => cur || p?.phone || '');
      } catch {
        /* profile read is best-effort; order placement ensures it */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [session, slug]);

  // Search/social metadata (see src/lib/storefrontSeo.js): once the
  // shop data is in, the tab title, meta description, Open Graph /
  // Twitter cards and a Store JSON-LD block describe THIS shop, so a
  // link pasted into a message or social post previews the shop instead
  // of the generic app shell. Client-side only — the honest limits of
  // that (hash route, JS-rendered) live in docs/seo-positioning.md.
  // Cleanup removes every injected node when the visitor leaves.
  useEffect(() => {
    if (state.phase !== 'ready' || !state.data?.shop) return undefined;
    return applyStorefrontSeo({
      shop: state.data.shop,
      products: state.data.products,
      url: window.location.href,
      brandName: BRAND.name,
    });
  }, [state.phase, state.data]);

  // Staff-login target. Normally the app root on this same origin — but
  // on a shop's own address (subdomain or custom domain) this origin IS
  // the storefront, so main.jsx passes appHome (the apex app address).
  const appUrl = appHome || `${window.location.origin}${BRAND.appBasePath()}`;
  const shop = state.data?.shop || {};
  const shopName = shop.display_name || BRAND.name;
  const accent = accentOf(shop.accent_color);
  const products = Array.isArray(state.data?.products) ? state.data.products : [];
  const showPrices = shop.show_prices !== false;
  const currency = shop.currency || '$';
  const orderingEnabled = ordersReady === true && shop.online_ordering?.enabled === true;
  const priceBook = {};
  for (const p of products) priceBook[p.id] = { priceCents: p.price };
  const taxCfg = {
    rates: Array.isArray(shop.tax?.rates) ? shop.tax.rates : [],
    legacyRate: Number(shop.tax?.legacy_rate) || 0,
  };
  const totals = cartTotals(cart, priceBook, taxCfg);
  const count = cartCount(cart);

  const openAuth = (mode = 'signin') => {
    setAuthMode(mode);
    setAuthError('');
    setAuthPassword('');
    setModal('auth');
  };

  const doSignIn = async () => {
    setAuthBusy(true);
    setAuthError('');
    try {
      if (authPassword.length < 6) throw new Error(oo('passwordShort'));
      await backend.auth.signIn({ email: authEmail, password: authPassword });
      // Read the session directly from Supabase client storage (not the
      // cached user) to ensure we get the just-established session.
      const { data } = await backend.supabase.auth.getSession();
      const su = data.session?.user;
      if (!su) throw new Error('Sign in failed: no session was established.');
      setSession({ user: { id: su.id, email: su.email } });
      setModal(count > 0 ? 'cart' : null);
    } catch (e) {
      setAuthError(e.code === 'email-not-confirmed' ? oo('checkEmailBody', { email: authEmail }) : oo('signInFail'));
    } finally {
      setAuthBusy(false);
    }
  };

  const doSignUp = async () => {
    setAuthBusy(true);
    setAuthError('');
    try {
      if (authPassword.length < 8) throw new Error(oo('passwordShort'));
      // One login: signup is email + confirmation email (SSO contract).
      const res = await backend.auth.signUpWithEmail({
        email: authEmail,
        password: authPassword,
        kind: 'customer',
        slug,
      });
      if (res.status === 'needs-confirmation') {
        setAuthMode('checkEmail');
      } else {
        setSession({ user: res.user });
        setModal(count > 0 ? 'cart' : null);
      }
    } catch (e) {
      const msg = String(e?.message || '');
      setAuthError(
        /already registered|already exists|User already/i.test(msg) ? oo('emailInUse') : oo('signUpFail')
      );
    } finally {
      setAuthBusy(false);
    }
  };

  const doSignOut = async () => {
    try { await backend.auth.signOut(); } catch { /* already signed out */ }
    setSession(null);
    setProfile(null);
    setModal(null);
  };

  // Social sign-in for customers: same one-login rule as owners. The
  // pending flow routes the provider round trip back to this shop, and
  // the shop link is stamped on landing (linkShopCustomer above).
  const doOAuth = async (provider) => {
    setAuthBusy(true);
    setAuthError('');
    savePendingFlow({ kind: 'customer', slug });
    try {
      await backend.auth.signInWithOAuth({ provider, kind: 'customer', slug });
    } catch (e) {
      clearPendingFlow();
      setAuthError(e.code === 'oauth-not-enabled' ? oo('oauthNotEnabled') : oo('signInFail'));
      setAuthBusy(false);
    }
  };

  // Passwordless sign-in for customers: emailed link, same routing as the
  // other doors (the pending flow brings them back to this shop, and the
  // shop link is stamped on landing like an OAuth signup).
  const doMagicLink = async () => {
    setAuthBusy(true);
    setAuthError('');
    savePendingFlow({ kind: 'customer', slug });
    try {
      await backend.auth.signInWithMagicLink({ email: authEmail, kind: 'customer', slug });
      setAuthMode('magicSent');
    } catch (e) {
      clearPendingFlow();
      setAuthError(/rate|too many/i.test(String(e?.message || '')) ? oo('magicLinkRate') : oo('signInFail'));
    } finally {
      setAuthBusy(false);
    }
  };

  const doPlaceOrder = async () => {
    if (placing) return;
    const problem = validateCartForOrder(cart);
    if (problem === 'empty') return;
    if (!session) {
      openAuth('signin');
      return;
    }
    if (!custName.trim()) {
      setPlaceError(oo('nameRequired'));
      return;
    }
    setPlacing(true);
    setPlaceError('');
    try {
      const order = await placeOrder(backend.supabase, slug, {
        lines: cartToOrderItems(cart),
        pickupNote,
        name: custName,
        phone: custPhone,
        idemKey: idemRef.current,
      });
      // The server's numbers are the real ones (prices snapshotted there).
      setPlaced(order);
      clearCart(window.localStorage, slug);
      setCart(emptyCart());
      resetIdem();
      // Keep the profile in sync so the next order is one tap.
      try {
        await saveProfile(backend.supabase, slug, { name: custName, phone: custPhone });
      } catch {
        /* best-effort */
      }
    } catch (e) {
      // The cart is NOT cleared on failure — the customer can fix and retry.
      const key = PLACE_ERROR_KEYS[e?.code];
      setPlaceError(key ? oo(key) : oo('errGeneric'));
      if (e?.code === 'ONLINE_ITEM_UNAVAILABLE' || e?.code === 'ONLINE_OUT_OF_STOCK') {
        // Prices/availability changed under us — reload the truth.
        try {
          await loadShop();
        } catch {
          /* keep the old price book */
        }
      }
    } finally {
      setPlacing(false);
    }
  };

  const openOrders = async () => {
    if (!session) {
      openAuth('signin');
      return;
    }
    setModal('orders');
    setOrdersList(null);
    setOrdersError('');
    try {
      const list = await myOrders(backend.supabase, slug);
      setOrdersList(Array.isArray(list) ? list : []);
    } catch {
      setOrdersError(oo('errGeneric'));
    }
  };

  const doCancelOrder = async (orderId) => {
    try {
      await cancelOrder(backend.supabase, orderId);
      const list = await myOrders(backend.supabase, slug);
      setOrdersList(Array.isArray(list) ? list : []);
    } catch {
      setOrdersError(oo('errGeneric'));
    }
  };

  const doReorder = (order) => {
    let next = emptyCart();
    for (const it of order.items || []) {
      next = addLine(next, { id: it.product_id || it.id, name: it.name, priceCents: priceBook[it.product_id]?.priceCents ?? it.unit_price_cents }, it.qty);
    }
    setCart(next);
    setModal('cart');
  };

  const fmtWhen = (iso) => {
    try {
      return new Date(iso).toLocaleString(getLang() === 'en' ? 'en-CA' : 'fr-CA', {
        dateStyle: 'medium',
        timeStyle: 'short',
      });
    } catch {
      return '';
    }
  };

  const renderAuthModal = () => (
    <div style={styles.overlay} onClick={() => setModal(null)}>
      <div style={styles.sheet} onClick={(e) => e.stopPropagation()}>
        {authMode === 'checkEmail' ? (
          <>
            <p style={styles.sheetTitle}>{oo('checkEmailTitle')}</p>
            <p style={styles.sheetSub}>{oo('checkEmailBody', { email: authEmail })}</p>
            <div style={styles.noteBox}>{oo('checkEmailHint')}</div>
            <button type="button" style={{ ...styles.primaryBtn, background: accent }} onClick={() => setAuthMode('signin')}>
              {oo('signInBtn')}
            </button>
          </>
        ) : authMode === 'magicSent' ? (
          <>
            <p style={styles.sheetTitle}>{oo('magicLinkTitle')}</p>
            <p style={styles.sheetSub}>{oo('magicLinkBody', { email: authEmail })}</p>
            <div style={styles.noteBox}>{oo('checkEmailHint')}</div>
            <button type="button" style={{ ...styles.primaryBtn, background: accent }} onClick={() => setAuthMode('signin')}>
              {oo('signInBtn')}
            </button>
          </>
        ) : (
          <>
            <p style={styles.sheetTitle}>{authMode === 'signup' ? oo('signUpTitle') : oo('signInTitle')}</p>
            <p style={styles.sheetSub}>{oo('signInToOrderHint')}</p>
            <label style={styles.fieldLabel} htmlFor="co-email">{oo('emailLabel')}</label>
            <input
              id="co-email"
              type="email"
              autoComplete="email"
              value={authEmail}
              onChange={(e) => setAuthEmail(e.target.value)}
              style={styles.field}
              placeholder="you@example.com"
            />
            <label style={styles.fieldLabel} htmlFor="co-password">{oo('passwordLabel')}</label>
            <input
              id="co-password"
              type="password"
              autoComplete={authMode === 'signup' ? 'new-password' : 'current-password'}
              value={authPassword}
              onChange={(e) => setAuthPassword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (authMode === 'signup' ? doSignUp : doSignIn)();
              }}
              style={styles.field}
            />
            {authError ? <div style={styles.errBox}>{authError}</div> : null}
            {/* DEBUG: show signOut trace if present */}
            {(() => {
              try {
                const t = localStorage.getItem('drift:signout-trace');
                if (t) {
                  const j = JSON.parse(t);
                  return <div style={{...styles.errBox, whiteSpace: 'pre-wrap', fontSize: '10px'}}>SIGNOUT TRACE {j.at}: {j.stack.join('\n')}</div>;
                }
              } catch {}
              return null;
            })()}
            <button
              type="button"
              disabled={authBusy || !authEmail.includes('@') || !authPassword}
              style={{ ...styles.primaryBtn, background: accent, opacity: authBusy ? 0.6 : 1 }}
              onClick={authMode === 'signup' ? doSignUp : doSignIn}
            >
              {authBusy ? '…' : authMode === 'signup' ? oo('signUpBtn') : oo('signInBtn')}
            </button>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, color: '#8a7f72', fontSize: 12 }}>
              <span style={{ flex: 1, height: 1, background: '#e5ddd2' }} />
              {oo('oauthOrContinue')}
              <span style={{ flex: 1, height: 1, background: '#e5ddd2' }} />
            </div>
            {OAUTH_PROVIDERS.map((p) => (
              <button
                key={p.id}
                type="button"
                disabled={authBusy}
                style={{ ...styles.ghostBtn, width: '100%', marginTop: 8, opacity: authBusy ? 0.6 : 1 }}
                onClick={() => doOAuth(p.id)}
              >
                {oo(p.labelKey)}
              </button>
            ))}
            <button
              type="button"
              disabled={authBusy || !authEmail.includes('@')}
              style={{ ...styles.ghostBtn, width: '100%', marginTop: 8, opacity: authBusy ? 0.6 : 1 }}
              onClick={doMagicLink}
            >
              {oo('magicLinkBtn')}
            </button>
            <div style={{ textAlign: 'center', marginTop: 6 }}>
              <button
                type="button"
                style={styles.linkBtn}
                onClick={() => { setAuthMode(authMode === 'signup' ? 'signin' : 'signup'); setAuthError(''); }}
              >
                {authMode === 'signup' ? oo('haveAccount') : oo('needAccount')}
              </button>
            </div>
          </>
        )}
        <button type="button" style={styles.ghostBtn} onClick={() => setModal(null)}>
          {oo('backToBrowsing')}
        </button>
      </div>
    </div>
  );

  const renderCartModal = () => (
    <div style={styles.overlay} onClick={() => setModal(null)}>
      <div style={styles.sheet} onClick={(e) => e.stopPropagation()}>
        {placed ? (
          <>
            <p style={styles.sheetTitle}>{oo('orderPlacedTitle')}</p>
            <p style={styles.sheetSub}>{oo('orderPlacedHint')}</p>
            <p style={{ ...styles.sheetSub, textAlign: 'center', marginBottom: 0 }}>{oo('orderPlacedBody')}</p>
            <p style={{ ...styles.bigNumber, color: accent }}>#{placed.number}</p>
            <div style={styles.noteBox}>
              {oo('total')}: {money(placed.total_cents, currency)}
            </div>
            <button type="button" style={{ ...styles.primaryBtn, background: accent }} onClick={() => { setPlaced(null); setModal(null); openOrders(); }}>
              {oo('myOrdersTitle')}
            </button>
            <button type="button" style={styles.ghostBtn} onClick={() => { setPlaced(null); setModal(null); }}>
              {oo('backToBrowsing')}
            </button>
          </>
        ) : (
          <>
            <p style={styles.sheetTitle}>{oo('cartTitle')}</p>
            {totals.lines.length === 0 ? (
              <>
                <p style={styles.sheetSub}>{oo('cartEmpty')}</p>
                <p style={styles.sheetSub}>{oo('cartEmptyHint')}</p>
                <button type="button" style={{ ...styles.primaryBtn, background: accent }} onClick={() => setModal(null)}>
                  {oo('backToBrowsing')}
                </button>
              </>
            ) : (
              <>
                {totals.lines.map((l) => (
                  <div key={l.productId} style={styles.cartLine}>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ fontSize: 14, fontWeight: 600 }}>{l.name}</div>
                      <div style={{ fontSize: 13, color: '#6d6252' }}>
                        {money(l.currentPriceCents, currency)}
                        {l.priceChanged ? <span> · {oo('priceChangedNote')}</span> : null}
                      </div>
                    </div>
                    <div style={styles.stepper}>
                      <button type="button" aria-label="−" style={styles.stepBtn} onClick={() => setCart((c) => setLineQty(c, l.productId, l.qty - 1))}>−</button>
                      <span style={{ fontSize: 15, fontWeight: 700, minWidth: 22, textAlign: 'center' }}>{l.qty}</span>
                      <button type="button" aria-label="+" style={styles.stepBtn} onClick={() => setCart((c) => setLineQty(c, l.productId, l.qty + 1))}>+</button>
                    </div>
                  </div>
                ))}
                <div style={{ marginTop: 12 }}>
                  <div style={styles.totalsRow}>
                    <span>{oo('subtotal')}</span>
                    <span>{money(totals.subtotalCents, currency)}</span>
                  </div>
                  {totals.taxRows.map((r, i) => (
                    <div key={i} style={styles.totalsRow}>
                      <span>{r.name} ({r.rate}%)</span>
                      <span>{money(r.cents, currency)}</span>
                    </div>
                  ))}
                  <div style={styles.totalsTotal}>
                    <span>{oo('total')}</span>
                    <span>{money(totals.totalCents, currency)}</span>
                  </div>
                </div>
                <p style={{ ...styles.sheetSub, marginTop: 10 }}>{oo('orderNote')}</p>

                <label style={styles.fieldLabel} htmlFor="co-name">{oo('nameLabel')}</label>
                <input id="co-name" value={custName} onChange={(e) => setCustName(e.target.value)} style={styles.field} placeholder={oo('namePh')} autoComplete="name" />
                <label style={styles.fieldLabel} htmlFor="co-phone">{oo('phoneLabel')}</label>
                <input id="co-phone" value={custPhone} onChange={(e) => setCustPhone(e.target.value)} style={styles.field} placeholder={oo('phonePh')} autoComplete="tel" inputMode="tel" />
                <label style={styles.fieldLabel} htmlFor="co-note">{oo('pickupNoteLabel')}</label>
                <input id="co-note" value={pickupNote} onChange={(e) => setPickupNote(e.target.value)} style={styles.field} placeholder={oo('pickupNotePh')} />

                {!session ? (
                  <div style={styles.noteBox}>
                    {oo('signInToOrder')} — {oo('signInToOrderHint')}
                  </div>
                ) : null}
                {placeError ? <div style={styles.errBox}>{placeError}</div> : null}
                <button
                  type="button"
                  disabled={placing}
                  style={{ ...styles.primaryBtn, background: accent, opacity: placing ? 0.6 : 1 }}
                  onClick={doPlaceOrder}
                >
                  {placing ? oo('placing') : session ? oo('placeOrderBtn') : oo('signInToOrder')}
                </button>
                <button type="button" style={styles.ghostBtn} onClick={() => setModal(null)}>
                  {oo('backToBrowsing')}
                </button>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );

  const renderOrdersModal = () => (
    <div style={styles.overlay} onClick={() => setModal(null)}>
      <div style={styles.sheet} onClick={(e) => e.stopPropagation()}>
        <p style={styles.sheetTitle}>{oo('myOrdersTitle')}</p>
        {ordersError ? <div style={styles.errBox}>{ordersError}</div> : null}
        {ordersList === null ? (
          <p style={styles.sheetSub}>…</p>
        ) : ordersList.length === 0 ? (
          <p style={styles.sheetSub}>{oo('myOrdersEmpty')}</p>
        ) : (
          ordersList.map((o) => {
            const pillBg = o.status === 'ready' ? '#dff0da' : o.status === 'cancelled' ? '#f1e4dd' : '#f7f3ec';
            const pillColor = o.status === 'ready' ? '#2e6b2e' : o.status === 'cancelled' ? '#8f2f1f' : '#5c5344';
            return (
              <div key={o.id} style={styles.orderCard}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
                  <strong style={{ fontSize: 15 }}>{oo('orderNumber', { n: o.number })}</strong>
                  <span style={{ fontSize: 12, color: '#8a7d68' }}>{fmtWhen(o.placed_at)}</span>
                </div>
                <div>
                  <span style={{ ...styles.statusPill, background: pillBg, color: pillColor }}>
                    {oo(ORDER_STATUS_KEYS[o.status] || 'stReceived')}
                  </span>
                </div>
                <div style={{ fontSize: 13, color: '#5c5344', marginTop: 8 }}>
                  {(o.items || []).map((it, i) => (
                    <div key={i}>{it.qty} × {it.name}</div>
                  ))}
                </div>
                <div style={{ ...styles.totalsTotal, fontSize: 15 }}>
                  <span>{oo('total')}</span>
                  <span>{money(o.total_cents, currency)}</span>
                </div>
                <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                  {o.status === 'received' ? (
                    <button
                      type="button"
                      style={{ ...styles.ghostBtn, marginTop: 0, flex: 1 }}
                      onClick={() => {
                        if (window.confirm(oo('confirmCancelMyBody'))) doCancelOrder(o.id);
                      }}
                    >
                      {oo('cancelMyOrder')}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    style={{ ...styles.ghostBtn, marginTop: 0, flex: 1 }}
                    onClick={() => doReorder(o)}
                  >
                    {oo('reorder')}
                  </button>
                </div>
              </div>
            );
          })
        )}
        <button type="button" style={styles.ghostBtn} onClick={() => setModal(null)}>
          {oo('backToBrowsing')}
        </button>
      </div>
    </div>
  );

  return (
    <div style={styles.page}>
      <header style={styles.header}>
        <span style={styles.headerName}>{shopName}</span>
        <div style={styles.headerBtns}>
          {ordersReady === true && shop.online_ordering?.enabled === true && state.phase === 'ready' ? (
            session ? (
              <button type="button" style={{ ...styles.acctBtn, background: accent }} onClick={() => setModal('cart')}>
                {oo('cartTitle')} · {count}
              </button>
            ) : (
              <button type="button" style={{ ...styles.acctBtn, background: accent }} onClick={() => openAuth('signin')}>
                {oo('signInToOrder')}
              </button>
            )
          ) : null}
          <a href={appUrl} style={styles.loginBtn}>
            Staff login / Connexion du personnel
          </a>
        </div>
      </header>

      {state.phase === 'loading' && (
        <p style={styles.center}>Loading… / Chargement…</p>
      )}

      {state.phase === 'error' && (
        <div style={styles.center}>
          <p style={{ fontWeight: 700, color: '#26221c' }}>
            We couldn’t load this page.
            <br />
            Impossible de charger cette page.
          </p>
          <p>
            Please check your internet connection, then tap Try again.
            <br />
            Vérifiez votre connexion Internet, puis touchez Réessayer.
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            style={{ ...styles.contactLink, cursor: 'pointer', fontFamily: 'inherit' }}
          >
            Try again / Réessayer
          </button>
        </div>
      )}

      {state.phase === 'missing' && (
        <div style={styles.center}>
          <p style={{ fontWeight: 700, color: '#26221c', fontSize: 17 }}>
            This shop page isn’t available.
            <br />
            Cette page de boutique n’est pas disponible.
          </p>
          <p>
            It may not be published yet, or the address may be wrong.
            <br />
            Elle n’est peut-être pas encore publiée, ou l’adresse est incorrecte.
          </p>
        </div>
      )}

      {state.phase === 'ready' && (
        <main style={styles.main}>
          <div style={styles.hero}>
            <div style={{ ...styles.heroRule, background: accent }} />
            <h1 style={styles.h1}>{shopName}</h1>
            {shop.tagline ? <p style={styles.tagline}>{shop.tagline}</p> : null}
          </div>

          {shop.about ? (
            <section style={styles.section} aria-label="About / À propos">
              <p style={styles.sectionText}>{shop.about}</p>
            </section>
          ) : null}

          {(shop.contact_email || shop.contact_phone) && (
            <section style={styles.section}>
              <div style={styles.contactRow}>
                {shop.contact_email ? (
                  <a style={styles.contactLink} href={`mailto:${shop.contact_email}`}>
                    {shop.contact_email}
                  </a>
                ) : null}
                {shop.contact_phone ? (
                  <a style={styles.contactLink} href={`tel:${shop.contact_phone}`}>
                    {shop.contact_phone}
                  </a>
                ) : null}
              </div>
            </section>
          )}

          {/* Connect links (migration 071): renders nothing unless the
              shop pasted links. Validated again inside the component. */}
          <StorefrontLinks shop={shop} />

          {/* ---- online ordering (migration 073) ---- */}
          {orderingEnabled && (
            <section style={styles.section}>
              <div style={styles.card}>
                <p style={styles.cardTitle}>{oo('orderOnlineTitle')}</p>
                <p style={{ ...styles.cardBody, marginBottom: 4 }}>{oo('orderNote')}</p>
                {shop.online_ordering?.note ? (
                  <p style={{ ...styles.cardBody, fontWeight: 700 }}>{oo('shopOrderingNote', { note: shop.online_ordering.note })}</p>
                ) : null}
                <div style={{ ...styles.contactRow, justifyContent: 'flex-start', marginTop: 12 }}>
                  {!session ? (
                    <button type="button" style={{ ...styles.addBtn, background: accent, marginTop: 0 }} onClick={() => openAuth('signin')}>
                      {oo('signInToOrder')}
                    </button>
                  ) : (
                    <>
                      <button type="button" style={{ ...styles.addBtn, background: accent, marginTop: 0 }} onClick={() => { setPlaced(null); setPlaceError(''); setModal('cart'); }}>
                        {oo('cartTitle')} · {count}
                      </button>
                      <button type="button" style={{ ...styles.loginBtn, cursor: 'pointer', fontFamily: 'inherit' }} onClick={openOrders}>
                        {oo('myOrdersTitle')}
                      </button>
                    </>
                  )}
                </div>
                {session ? (
                  <p style={{ fontSize: 12, color: '#8a7d68', margin: '10px 0 0' }}>
                    {oo('signedInAs', { email: session.user?.email || '' })}{' '}
                    <button type="button" onClick={doSignOut} style={{ ...styles.linkBtn, display: 'inline', padding: 0 }}>
                      {oo('signOut')}
                    </button>
                  </p>
                ) : null}
              </div>
            </section>
          )}

          {products.length > 0 && (
            <section style={styles.section} aria-label={oo('products')}>
              <h2 style={styles.srOnly}>{oo('products')}</h2>
              <ul style={styles.grid}>
                {products.map((p, i) => {
                  const outOfStock = orderingEnabled && p.track_stock && Number(p.stock) <= 0;
                  const inCart = (cart.lines || []).find((l) => l.productId === p.id);
                  return (
                    <li key={`${p.id || p.name}-${i}`} style={styles.product}>
                      <span style={styles.productName}>{p.name}</span>
                      {showPrices ? (
                        <span style={{ ...styles.productPrice, color: accent }}>
                          {money(p.price, currency)}
                        </span>
                      ) : null}
                      {orderingEnabled ? (
                        outOfStock ? (
                          <span style={styles.addBtnDisabled}>{oo('outOfStock')}</span>
                        ) : (
                          <>
                            <button
                              type="button"
                              style={{ ...styles.addBtn, background: accent }}
                              onClick={() => setCart((c) => addLine(c, { id: p.id, name: p.name, priceCents: p.price }, 1))}
                            >
                              {oo('addToCart')}
                            </button>
                            {inCart ? (
                              <span style={styles.inCartPill}>{inCart.qty} {oo('inCart')}</span>
                            ) : null}
                          </>
                        )
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </section>
          )}

          {shop.hours ? (
            <section style={styles.section}>
              <div style={styles.card}>
                <h2 style={styles.cardTitle}>Hours / Heures</h2>
                <p style={styles.cardBody}>{shop.hours}</p>
              </div>
            </section>
          ) : null}
        </main>
      )}

      <footer style={styles.footer}>
        Powered by {BRAND.name}
      </footer>

      {modal === 'auth' && renderAuthModal()}
      {modal === 'cart' && renderCartModal()}
      {modal === 'orders' && renderOrdersModal()}
    </div>
  );
}
