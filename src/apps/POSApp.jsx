import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import {
  ShoppingCart, Plus, Minus, Trash2, Search, X, Printer, RotateCcw,
  Package, Receipt, Tag, Settings as SettingsIcon, Check, AlertCircle,
  Banknote, CreditCard, Users, Store as StoreIcon, LogOut, Ticket,
  Copy, Crown, BarChart3, Wallet, KeyRound, UserCheck, UserPlus,
  TrendingUp, CalendarDays, CircleDollarSign, Percent, Hash, Lock, Clock3,
  LibraryBig, Gift, Star, GraduationCap, HandCoins, FileDown,
  Undo2, Repeat, Bell, Edit2, Building2,
} from 'lucide-react';
import { backend } from '../lib/backend/current.js';
import { usePOSMode } from '../os/POSModeContext.jsx';
import { useToasts } from '../os/ToastContext.jsx';
import { useLang, localeTag} from '../lib/i18n.jsx';
import { qrDataUrl, receiptQrText } from '../lib/qr.js';
import { playSound } from '../lib/sound.js';
import { enqueue as enqueueOffline, getQueueDepth as getOfflineQueueDepth } from '../lib/offlineQueue.js';
import { withTimeout, isTimeoutError } from '../lib/timeout.js';
import { startAutoSync } from '../lib/queueSync.js';
import { logMoneyMovement } from '../lib/moneyAudit.js';
import {
  getPrinterConfig, savePrinterConfig, printReceipt, openCashDrawer,
  testPrint, transportCapabilities,
} from '../lib/pos-print/index.js';
import { qzTransport } from '../lib/pos-print/transports.js';
import {
  taxLinesFor, taxTotalFor, TAX_PRESETS, OUTDATED_PRESETS,
  outdatedPresetFor, presetLabel, presetRateName,
} from '../lib/taxMath.js';

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function fmt(cents, currency) {
  const cur = currency || '$';
  const sign = cents < 0 ? '-' : '';
  return `${sign}${cur}${(Math.abs(cents) / 100).toFixed(2)}`;
}

/** Translated receipt labels for the ESC/POS + HTML receipt builders. */
function receiptLabels(t) {
  const k = [
    'sale', 'cashier', 'customer', 'org', 'taxExemptNonprofit', 'taxExemptGeneric',
    'itemDiscount', 'subtotal', 'discount', 'total', 'cashTendered', 'change',
    'paidBy', 'card', 'other',
  ];
  const labels = {};
  for (const key of k) labels[key] = t(`pos.receipt.${key}`);
  return labels;
}

function todayKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const ROLE_LABEL = { owner: 'Owner', manager: 'Manager', cashier: 'Cashier' };
const canManage = (role) => role === 'owner' || role === 'manager';

// Tax math (taxLinesFor, taxTotalFor, TAX_PRESETS, outdatedPresetFor, …)
// lives in ../lib/taxMath.js so it can be unit-tested in node.

const METHOD_LABEL = { cash: 'Cash', card: 'Card', other: 'Other' };

function cartLineKey(productId, variantId) {
  return `${productId}::${variantId || ''}`;
}

const PIN_PAD_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'];

// Shared-device cashier login: PIN pad, 4-8 digits. PINs are hashed before
// they ever leave this device.
function PinPadModal({ title, subtitle, error, busy, onSubmit, onClose }) {
  const { t } = useLang();
  const [pin, setPin] = useState('');
  const press = (d) => setPin((p) => (p.length >= 8 ? p : p + d));
  return (
    <Modal title={title || t('pos.tabs2.cashierSignIn')} onClose={onClose}>
      {subtitle && <p className="mb-3 text-center text-sm text-muted">{subtitle}</p>}
      <div className="mb-3 flex justify-center" aria-label="PIN entry">
        <div className="flex gap-2">
          {Array.from({ length: 8 }).map((_, i) => (
            <div
              key={i}
              className={`h-4 w-4 rounded-full border ${
                i < pin.length ? 'border-accent bg-accent' : 'border-osborder'
              }`}
            />
          ))}
        </div>
      </div>
      <div className="mb-3"><ErrorNote message={error} /></div>
      <div className="mx-auto grid max-w-[240px] grid-cols-3 gap-2">
        {PIN_PAD_KEYS.map((d) => (
          <button
            key={d}
            type="button"
            onClick={() => press(d)}
            className="rounded-os bg-paper py-3 text-xl font-semibold text-ink duration-160 hover:bg-osborder/40"
          >
            {d}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setPin((p) => p.slice(0, -1))}
          className="rounded-os bg-paper py-3 text-sm font-semibold text-muted duration-160 hover:text-ink"
          aria-label="Backspace"
        >
          ⌫
        </button>
        <button
          type="button"
          onClick={() => setPin('')}
          className="rounded-os bg-paper py-3 text-sm font-semibold text-muted duration-160 hover:text-ink"
        >
          {t('punch.clearPad')}
        </button>
        <button
          type="button"
          onClick={() => onSubmit(pin)}
          disabled={busy || pin.length < 4}
          className="rounded-os bg-accent py-3 text-sm font-semibold text-accentink duration-160 hover:opacity-90 disabled:opacity-40"
        >
          {busy ? '…' : 'OK'}
        </button>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Small UI pieces                                                     */
/* ------------------------------------------------------------------ */

function TabButton({ id, label, icon: Icon, active, onClick }) {
  return (
    <button
      type="button"
      onClick={() => onClick(id)}
      className={`flex shrink-0 items-center gap-2 whitespace-nowrap rounded-os px-4 py-2 text-sm font-medium duration-160 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
        active ? 'bg-accent text-accentink shadow-os' : 'text-muted hover:bg-paper hover:text-ink'
      }`}
    >
      <Icon size={16} />
      {label}
    </button>
  );
}

function Modal({ title, onClose, children, wide }) {
  const dialogRef = useRef(null);
  const closeRef = useRef(null);
  // NUCLEAR FAILSAFE: keep the latest onClose in a ref so the mount effect
  // below does NOT re-run on every render. The old [onClose] dep re-focused
  // the close button on every parent re-render, stealing focus from text
  // inputs inside the modal (users could not type in them).
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Escape closes; focus starts in the dialog (an [autofocus] field when the
  // modal has one, otherwise the close button). Runs ONCE on mount.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCloseRef.current();
      }
    };
    window.addEventListener('keydown', onKey);
    const target = dialogRef.current?.querySelector('[autofocus]') || closeRef.current;
    target?.focus?.();
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30 p-4"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`w-full ${wide ? 'max-w-lg' : 'max-w-sm'} max-h-[90vh] overflow-y-auto rounded-os border border-osborder bg-surface p-6 shadow-os`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-lg font-semibold text-ink">{title}</h3>
          <button
            type="button"
            ref={closeRef}
            onClick={onClose}
            className="rounded-os p-1 text-muted hover:bg-paper hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-muted">{label}</span>
      {children}
    </label>
  );
}

const inputCls =
  'w-full rounded-os border border-osborder bg-paper px-3 py-2 text-sm text-ink outline-none duration-160 focus:border-accent';

function EmptyState({ icon: Icon, title, body, action }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-os border border-dashed border-osborder bg-paper/50 px-6 py-12 text-center">
      <Icon size={32} className="text-muted" />
      <p className="mt-3 font-medium text-ink">{title}</p>
      <p className="mt-1 max-w-xs text-sm text-muted">{body}</p>
      {action}
    </div>
  );
}

function ErrorNote({ message }) {
  if (!message) return null;
  return (
    <div className="flex items-start gap-2 rounded-os border border-osborder bg-paper px-3 py-2 text-sm text-ink">
      <AlertCircle size={16} className="mt-0.5 shrink-0 text-accent" />
      <span>{message}</span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Sell tab                                                            */
/* ------------------------------------------------------------------ */

function SellTab({ products, store, v4, customers, customerId, onCustomerChange, cashier, onSaleComplete, extras, giftCards, onCustomersChanged, seedLines, onSeedConsumed, orgs, orgId, onOrgChange, orgsOk }) {
  const { t } = useLang();
  // Offline queue: sales captured when the network is down.
  const [queueDepth, setQueueDepth] = useState(0);
  useEffect(() => {
    const update = () => {
      try {
        setQueueDepth(getOfflineQueueDepth());
      } catch {}
    };
    update();
    const handler = () => update();
    window.addEventListener('driftshop:queue-changed', handler);
    window.addEventListener('online', handler);
    window.addEventListener('offline', handler);
    return () => {
      window.removeEventListener('driftshop:queue-changed', handler);
      window.removeEventListener('online', handler);
      window.removeEventListener('offline', handler);
    };
  }, []);
  const [cart, setCart] = useState([]); // [{ key, productId, variantId, variantName, name, priceCents, qty, itemDiscountType, itemDiscountValue }]
  const [query, setQuery] = useState('');
  const [catFilter, setCatFilter] = useState('All');
  const [discount, setDiscount] = useState({ type: 'amount', value: '' });
  const [tenderOpen, setTenderOpen] = useState(false);
  const [receipt, setReceipt] = useState(null);
  const [variantFor, setVariantFor] = useState(null);
  const [customerOpen, setCustomerOpen] = useState(false);
  const [orgOpen, setOrgOpen] = useState(false);
  const [discountForKey, setDiscountForKey] = useState(null);
  const [notice, setNotice] = useState('');
  // NUCLEAR FAILSAFE: cart draft auto-save. If the app crashes, the browser
  // closes, or the network dies mid-sale, the in-progress cart is recovered
  // on next POS open. A sale in progress is NEVER lost.
  const [draftAvailable, setDraftAvailable] = useState(null); // null = checking, {cart, discount, ...} = recoverable
  const DRAFT_KEY = 'driftshop_pos_draft';
  const DRAFT_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h: older drafts are stale

  // On mount: check for a recoverable draft (from crash/close).
  useEffect(() => {
    try {
      const raw = localStorage.getItem(DRAFT_KEY);
      if (!raw) {
        setDraftAvailable(null);
        return;
      }
      const draft = JSON.parse(raw);
      // Validate: must have a non-empty cart, must not be stale.
      if (!draft || !Array.isArray(draft.cart) || draft.cart.length === 0) {
        localStorage.removeItem(DRAFT_KEY);
        setDraftAvailable(null);
        return;
      }
      if (!draft.savedAt || Date.now() - draft.savedAt > DRAFT_MAX_AGE_MS) {
        localStorage.removeItem(DRAFT_KEY); // stale — don't offer
        setDraftAvailable(null);
        return;
      }
      setDraftAvailable(draft);
    } catch {
      // Corrupt draft — discard, don't crash.
      try { localStorage.removeItem(DRAFT_KEY); } catch {}
      setDraftAvailable(null);
    }
  }, []);

  // Auto-save the draft whenever the cart changes (debounced).
  useEffect(() => {
    if (cart.length === 0) {
      // Empty cart — clear any saved draft (sale completed or cleared).
      try { localStorage.removeItem(DRAFT_KEY); } catch {}
      return;
    }
    const timer = setTimeout(() => {
      try {
        const draft = {
          cart,
          discount,
          customerId,
          orgId,
          savedAt: Date.now(),
        };
        localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
      } catch {
        // Storage full or unavailable — non-fatal, sale continues in memory.
      }
    }, 500); // 500ms debounce: don't write on every keystroke
    return () => clearTimeout(timer);
  }, [cart, discount, customerId, orgId]);

  // Recover a draft: restore cart/discount/customer/org, dismiss the prompt.
  const recoverDraft = () => {
    if (!draftAvailable) return;
    setCart(draftAvailable.cart || []);
    if (draftAvailable.discount) setDiscount(draftAvailable.discount);
    if (draftAvailable.customerId && onCustomerChange) onCustomerChange(draftAvailable.customerId);
    if (draftAvailable.orgId && onOrgChange) onOrgChange(draftAvailable.orgId);
    setDraftAvailable(null);
    // Keep the draft saved until the sale completes or cart is cleared —
    // if we crash during recovery, the draft is still there.
  };

  // Dismiss a draft without recovering (user starts fresh).
  const dismissDraft = () => {
    setDraftAvailable(null);
    try { localStorage.removeItem(DRAFT_KEY); } catch {}
  };
  // POS upgrades (local backend): promo engine state, upgrade modals, and
  // tender adjustments (gift card / credit note / deposit / loyalty) that
  // are collected in the tender modal and redeemed on sale completion.
  const [promoInput, setPromoInput] = useState('');
  const [promo, setPromo] = useState(null);
  const [promoError, setPromoError] = useState('');
  const [giftOpen, setGiftOpen] = useState(false);
  const [depositOpen, setDepositOpen] = useState(false);
  const [schoolOpen, setSchoolOpen] = useState(false);
  const [presetAdjustments, setPresetAdjustments] = useState([]);
  // Catalogue as a product source: when
  // bqMode is on, the grid searches the catalogue instead of POS
  // products, and completed sales decrement catalogue stock.
  const [bqMode, setBqMode] = useState(false);
  const [bqItems, setBqItems] = useState([]);
  const [bqLoading, setBqLoading] = useState(false);
  const [bqError, setBqError] = useState('');

  const categories = useMemo(() => {
    const cats = new Set();
    products.forEach((p) => p.category && cats.add(p.category));
    return ['All', ...[...cats].sort()];
  }, [products]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return products.filter(
      (p) =>
        (catFilter === 'All' || p.category === catFilter) &&
        (!q || p.name.toLowerCase().includes(q) || (p.sku || '').toLowerCase().includes(q))
    );
  }, [products, query, catFilter]);

  useEffect(() => {
    if (!bqMode) return;
    setBqLoading(true);
    setBqError('');
    const h = setTimeout(async () => {
      try {
        setBqItems(await backend.bouquinerie.listItems({ query: query.trim(), status: 'store' }));
      } catch (err) {
        // Surface the failure — an empty list must never masquerade as "no
        // books in the boutique", or staff will think stock vanished.
        setBqItems([]);
        setBqError(err?.message || t('err.loadCatalogue'));
      } finally {
        setBqLoading(false);
      }
    }, 300);
    return () => clearTimeout(h);
  }, [bqMode, query]);

  const flash = (msg) => {
    setNotice(msg);
    setTimeout(() => setNotice(''), 2600);
  };

  const cartQtyFor = (productId) =>
    cart.filter((i) => i.productId === productId).reduce((s, i) => s + i.qty, 0);

  const addLine = (p, variant) => {
    if (p.trackStock) {
      const inCart = cartQtyFor(p.id);
      if (inCart + 1 > p.stock) {
        flash(p.stock > 0 ? `Only ${p.stock} in stock.` : `${p.name} is out of stock.`);
        return;
      }
    }
    const variantId = variant?.id || '';
    const key = cartLineKey(p.id, variantId);
    const priceCents = p.priceCents + (variant ? Number(variant.priceDeltaCents) || 0 : 0);
    setCart((c) => {
      const found = c.find((i) => i.key === key);
      // NUCLEAR FAILSAFE: max 999 per line. Prevents runaway quantity.
      if (found) {
        if (found.qty >= 999) return c; // silently cap — the UI shows 999
        return c.map((i) => (i.key === key ? { ...i, qty: i.qty + 1 } : i));
      }
      return [
        ...c,
        {
          key,
          productId: p.id,
          variantId,
          variantName: variant?.name || '',
          name: p.name,
          priceCents,
          qty: 1,
          itemDiscountType: 'amount',
          itemDiscountValue: '',
        },
      ];
    });
  };

  const addToCart = (p) => {
    if (v4 && p.variants && p.variants.length > 0) {
      setVariantFor(p);
      return;
    }
    addLine(p, null);
  };

  const addBqToCart = (item) => {
    const inCart = cart.filter((i) => i.bqItemId === item.id).reduce((s, i) => s + i.qty, 0);
    if (inCart + 1 > item.qty) {
      flash(item.qty > 0 ? t('pos.bq.onlyLeft', { n: item.qty }) : t('pos.bq.outOfStock'));
      return;
    }
    const key = `bq:${item.id}`;
    const priceCents = Math.round((Number(item.price) || 0) * 100);
    setCart((c) => {
      const found = c.find((i) => i.key === key);
      if (found) return c.map((i) => (i.key === key ? { ...i, qty: i.qty + 1 } : i));
      return [
        ...c,
        {
          key,
          productId: key,
          bqItemId: item.id,
          // Pre-sale shelf status: a void restores the item to exactly
          // where it was (store shelf vs. book fair) instead of guessing.
          bqStatus: item.status || null,
          variantId: '',
          variantName: '',
          name: item.title + (item.author ? ` — ${item.author}` : ''),
          priceCents,
          qty: 1,
          itemDiscountType: 'amount',
          itemDiscountValue: '',
        },
      ];
    });
  };

  // Barcode/sku scanners type the code and hit Enter — jump straight to the cart.
  // Falls back to a Catalogue ISBN lookup so catalogued stock scans at the till.
  const quickAddSku = async () => {
    const q = query.trim().toLowerCase();
    if (!q) return;
    const p = products.find((x) => (x.sku || '').toLowerCase() === q);
    if (p) {
      addToCart(p);
      setQuery('');
      return;
    }
    try {
      const dups = await backend.bouquinerie.findDuplicates({ isbn: q });
      const hit = dups.find((d) => d.qty > 0 && d.status === 'store');
      if (hit) {
        addBqToCart(hit);
        setQuery('');
        return;
      }
    } catch {
      /* catalogue unavailable — fall through to the notice */
    }
    flash(t('pos.bq.noSku'));
  };

  const setQty = (key, qty) => {
    // NUCLEAR FAILSAFE: clamp to 1..999. Zero removes the line (existing behavior).
    const clamped = Math.min(999, Math.max(0, Math.floor(qty) || 0));
    setCart((c) =>
      clamped <= 0 ? c.filter((i) => i.key !== key) : c.map((i) => (i.key === key ? { ...i, qty: clamped } : i))
    );
  };

  const lineNet = (i) => {
    const gross = i.priceCents * i.qty;
    const d =
      i.itemDiscountType === 'percent'
        ? Math.round((gross * (parseFloat(i.itemDiscountValue) || 0)) / 100)
        : Math.round((parseFloat(i.itemDiscountValue) || 0) * 100);
    const disc = Math.min(Math.max(0, d), gross);
    return { gross, disc, net: gross - disc };
  };

  const subtotal = cart.reduce((s, i) => s + lineNet(i).net, 0);
  // Cart discount can never exceed the subtotal (percent capped at 100%,
  // amount capped at subtotal) — a discount larger than the sale would
  // silently zero it out with no manager approval.
  const discountCents =
    discount.type === 'percent'
      ? Math.round(subtotal * Math.min(100, parseFloat(discount.value) || 0) / 100)
      : Math.min(subtotal, Math.round((parseFloat(discount.value) || 0) * 100));
  const taxableBase = Math.max(0, subtotal - discountCents);
  // Promo engine: percent / fixed / BOGO (2-for-1). BOGO frees every second
  // cheapest unit across the cart, net of per-item discounts.
  const promoDiscountCents = useMemo(() => {
    if (!promo || !extras) return 0;
    if (promo.type === 'percent') {
      return Math.min(taxableBase, Math.round((taxableBase * promo.value) / 100));
    }
    if (promo.type === 'fixed') {
      return Math.min(taxableBase, Math.round(promo.value * 100));
    }
    const units = [];
    cart.forEach((i) => {
      const { net } = lineNet(i);
      const unit = Math.max(0, Math.round(net / Math.max(1, i.qty)));
      for (let k = 0; k < i.qty; k++) units.push(unit);
    });
    units.sort((a, b) => a - b);
    let d = 0;
    for (let k = 1; k < units.length; k += 2) d += units[k];
    return Math.min(taxableBase, d);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [promo, cart, discount, extras]);
  const taxable = Math.max(0, taxableBase - promoDiscountCents);
  // Tax-exempt organizations (e.g. non-profits) are billed tax-free —
  // Taxes are only charged on regular sales. Ticket-level exemption.
  const activeOrg = (orgs || []).find((o) => o.id === orgId) || null;
  const taxLines = activeOrg?.taxExempt ? [] : taxLinesFor(store, taxable);
  const taxCents = taxLines.reduce((s, l) => s + l.cents, 0);
  const total = taxable + taxCents;

  const selectedCustomer = customers.find((c) => c.id === customerId) || null;

  const applyPromo = async () => {
    const code = promoInput.trim();
    if (!code || !extras) return;
    setPromoError('');
    try {
      const p = await backend.pos.getPromoByCode(store.id, code);
      if (!p) {
        setPromoError(t('pos.promo.invalidCode'));
        return;
      }
      setPromo(p);
      setPromoInput('');
      flash(t('pos.promo.applied', { name: p.name }));
    } catch (err) {
      setPromoError(err.message || t('pos.promo.invalidCode'));
    }
  };

  // External lines (exchange from history, school-list conversion) land in
  // the cart as plain lines — no catalog lookup needed.
  const seedCartLines = (lines) => {
    const mapped = (lines || []).map((l, i) => ({
      key: `seed:${Date.now()}:${i}`,
      productId: l.productId || `seed:${i}`,
      bqItemId: l.bqItemId || null,
      variantId: l.variantId || '',
      variantName: l.variantName || '',
      name: l.name,
      priceCents: Math.max(0, Math.round(Number(l.priceCents) || 0)),
      qty: Math.max(1, Math.round(Number(l.qty) || 1)),
      itemDiscountType: 'amount',
      itemDiscountValue: '',
    }));
    if (mapped.length > 0) {
      setCart((c) => [...c, ...mapped]);
      flash(t('pos.school.converted'));
    }
  };

  useEffect(() => {
    if (seedLines && seedLines.length > 0) {
      seedCartLines(seedLines);
      if (onSeedConsumed) onSeedConsumed();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedLines]);

  const completeSale = async ({ method, tenderedCents, adjustments = [] }) => {
    const adjCents = adjustments.reduce((s, a) => s + (Math.max(0, Math.round(Number(a.cents) || 0)) || 0), 0);
    const due = Math.max(0, total - adjCents);
    // Reverse debited tender instruments (gift card / credit note / deposit /
    // loyalty) when something later fails. Best-effort: strictly better than
    // leaving the customer debited with no sale on the books.
    const reverseRedemptions = async (redeemed) => {
      for (const r of redeemed) {
        try {
          if (r.kind === 'giftcard') await backend.pos.creditGiftCard(store.id, r.refId, r.cents);
          else if (r.kind === 'creditnote') await backend.pos.creditCreditNote(store.id, r.refId, r.cents);
          else if (r.kind === 'deposit') await backend.pos.depositUnapply(store.id, r.refId, r.cents);
          else if (r.kind === 'loyalty') await backend.pos.deltaLoyaltyPoints(store.id, customerId, r.points);
        } catch (err) {
          console.error('[drift] tender rollback failed:', r.kind, r.refId, err);
        }
      }
    };
    // Redeem tender instruments BEFORE recording the sale — a failed
    // redemption must never leave a half-paid sale on the books.
    const redeemed = [];
    // Gift-card tender works with the standalone giftCards capability; the
    // other tender instruments still need the full posUpgrades backend.
    if (extras || giftCards) {
      try {
        for (const a of adjustments) {
          const cents = Math.max(0, Math.round(Number(a.cents) || 0));
          if (cents <= 0) continue;
          if (a.kind === 'giftcard') await backend.pos.redeemGiftCard(store.id, a.refId, cents);
          else if (!extras) throw new Error('That tender type is not available yet.');
          else if (a.kind === 'creditnote') await backend.pos.redeemCreditNote(store.id, a.refId, cents);
          else if (a.kind === 'deposit') await backend.pos.depositApply(store.id, a.refId, cents);
          else if (a.kind === 'loyalty') await backend.pos.redeemLoyaltyPoints(store.id, customerId, a.points);
          redeemed.push({ kind: a.kind, refId: a.refId, cents, points: a.points });
        }
      } catch (err) {
        // A redemption itself failed mid-loop: earlier instruments in this
        // sale are already debited — put them back before surfacing.
        await reverseRedemptions(redeemed);
        throw err;
      }
    }
    const perDollar = extras ? Number(store.loyaltyPointsPerDollar) || 0 : 0;
    const earnBase = Math.max(0, subtotal - discountCents - promoDiscountCents);
    const loyaltyEarned = customerId && perDollar > 0 ? Math.floor((earnBase / 100) * perDollar) : 0;
    const loyaltyRedeemed = adjustments
      .filter((a) => a.kind === 'loyalty')
      .reduce((s, a) => s + (Math.max(0, Math.round(Number(a.points) || 0)) || 0), 0);
    const sale = {
      items: cart.map((i) => {
        const { disc } = lineNet(i);
        const item = {
          productId: i.productId,
          name: i.name,
          priceCents: i.priceCents,
          qty: i.qty,
        };
        if (i.variantId) {
          item.variantId = i.variantId;
          item.variantName = i.variantName;
        }
        if (disc > 0) item.itemDiscountCents = disc;
        if (i.bqItemId) item.bqItemId = i.bqItemId;
        if (i.bqItemId && i.bqStatus) item.bqStatus = i.bqStatus;
        return item;
      }),
      subtotalCents: subtotal,
      discountCents,
      promoCode: promo?.code || null,
      promoDiscountCents,
      taxCents,
      // Persisted with the sale (migration 021) so receipts/reprints show the
      // exact lines charged, not a recompute from current settings.
      taxLines: taxLines.map((l) => ({ name: l.name, rate: l.rate, cents: l.cents, compound: !!l.compound })),
      totalCents: total,
      adjustments: adjustments.map((a) => ({
        kind: a.kind,
        refId: a.refId || null,
        code: a.code || null,
        label: a.label || a.kind,
        cents: Math.max(0, Math.round(Number(a.cents) || 0)),
        points: a.points || null,
      })),
      loyaltyEarned,
      loyaltyRedeemed,
      method,
      tenderedCents: method === 'cash' ? tenderedCents : due,
      changeCents: method === 'cash' ? tenderedCents - due : 0,
      cashierName: cashier?.name || null,
      staffPinId: cashier?.pinId || null,
      customerId: customerId || null,
      // Tax-exempt organization billing (ticket-level exemption).
      orgId: orgId || null,
      orgName: activeOrg?.name || null,
      orgType: activeOrg?.type || null,
      taxExempt: !!activeOrg?.taxExempt,
    };
    let recorded;
    try {
      recorded = await onSaleComplete(sale);
    } catch (err) {
      // NUCLEAR FAILSAFE: if the sale failed due to a network error (offline),
      // and it's a simple cash sale with no tender instruments that require
      // server validation, QUEUE it instead of losing it. The sale is captured
      // locally with a UUID idempotency key and synced when connectivity
      // returns. Migration 050 enforces the key server-side via a unique
      // (store_id, idempotency_key) index — replays return the existing sale
      // instead of duplicating it.
      const isNetworkError = /network|offline|fetch|failed to fetch|load failed/i.test(err?.message || '');
      const hasComplexTender = adjustments.some((a) => a.kind !== 'cash' && (a.cents > 0 || a.points > 0));
      const isSimpleCashSale = method === 'cash' && !hasComplexTender;
      
      if (isNetworkError && isSimpleCashSale) {
        try {
          const queued = enqueueOffline('pos_sale', {
            sale,
            storeId: store.id,
            queuedAt: Date.now(),
          });
          // Show a "queued" receipt — the sale is captured, not lost.
          const receiptData = {
            ...sale,
            id: `queued-${queued.id}`,
            queued: true,
            queueId: queued.id,
            taxLines,
            customerName: selectedCustomer?.name || null,
            stockWarnings: [t('pos.queuedStockWarning')],
          };
          setReceipt(receiptData);
          setCart([]);
          setDiscount({ type: 'amount', value: '' });
          setPromo(null);
          setPromoInput('');
          setPromoError('');
          setPresetAdjustments([]);
          // Clear the draft (the sale is now in the offline queue, not a draft).
          try { localStorage.removeItem('driftshop_pos_draft'); } catch {}
          return; // Don't throw — the sale was captured.
        } catch (queueErr) {
          console.error('[driftshop] offline queue failed:', queueErr);
          // Fall through to the normal error path.
        }
      }
      // The sale failed to record AFTER tender instruments were debited —
      // reverse the debits so balances aren't lost with no sale on the books.
      await reverseRedemptions(redeemed);
      throw err;
    }
    // Best-effort audit link: tie each redeemed gift card back to this sale
    // in its ledger history. Never fails the sale.
    if (recorded && recorded.id) {
      for (const r of redeemed) {
        if (r.kind === 'giftcard') {
          await backend.pos.linkGiftCardSale(store.id, r.refId, r.cents, recorded.id);
        }
      }
    }
    if (loyaltyEarned > 0) {
      try {
        await backend.pos.addLoyaltyPoints(store.id, customerId, loyaltyEarned);
      } catch {
        /* points are best-effort — the sale itself is recorded */
      }
      if (onCustomersChanged) onCustomersChanged();
    } else if (loyaltyRedeemed > 0 && onCustomersChanged) {
      onCustomersChanged();
    }
    // Stock (POS products AND catalogue items) was decremented atomically
    // on the server inside recordSale. Anything the server flagged —
    // oversold lines, lines it could not update — is reported on the
    // receipt so staff reconcile instead of inventory silently drifting.
    const stockWarnings = (recorded.stockWarnings || []).map((w) =>
      w.error ? `${w.name}: stock could not be updated (${w.error})` : `${w.name}: sold more than was on hand — please recount`
    );
    const receiptData = { ...recorded, taxLines, customerName: selectedCustomer?.name || recorded.customerName || null, stockWarnings };
    setReceipt(receiptData);
    setCart([]);
    setDiscount({ type: 'amount', value: '' });
    setPromo(null);
    setPromoInput('');
    setPromoError('');
    setPresetAdjustments([]);
    onCustomerChange(null);
    onOrgChange(null);
    setTenderOpen(false);
    playSound('cashRegister');
    // Printer: auto-print + cash-drawer kick. Best effort — a printer
    // failure must never block or roll back a completed sale.
    try {
      // Best-effort hardware, strictly sequential: raw transports share one
      // device handle per session, so print and drawer must never interleave.
      // Either way the recorded sale is never rolled back.
      const pcfg = getPrinterConfig(store.id);
      (async () => {
        if (pcfg.autoPrint) {
          try {
            await printReceipt({ sale: receiptData, store, taxLines, config: pcfg, labels: receiptLabels(t) });
          } catch (err) {
            flash(`Receipt failed: ${err?.message || err}`);
          }
        }
        if (method === 'cash' && pcfg.autoDrawerCash && pcfg.transport !== 'browser') {
          // Browser/system printing has no path to the printer's DK port, so
          // don't flash a pointless error on every cash sale.
          try {
            await openCashDrawer({ store, config: pcfg });
          } catch (err) {
            flash(`Drawer failed: ${err?.message || err}`);
          }
        }
      })();
    } catch (err) {
      flash(`Printer: ${err?.message || err}`);
    }
  };

  const kickDrawer = async () => {
    try {
      await openCashDrawer({ store });
      flash('Cash drawer opened.');
    } catch (err) {
      flash(`Drawer failed: ${err?.message || err}`);
    }
  };

  return (
    <div className="flex h-full gap-4">
      {/* NUCLEAR FAILSAFE: crash-recovery banner. If a draft cart was found
          (app crashed or closed mid-sale), offer to restore it. */}
      {draftAvailable && (
        <div className="absolute left-1/2 top-4 z-50 w-full max-w-md -translate-x-1/2 rounded-os border-2 border-amber-500 bg-amber-50 p-4 shadow-lg dark:bg-amber-950">
          <h3 className="text-sm font-semibold text-amber-800 dark:text-amber-200">
            {t('pos.draftRecoverTitle')}
          </h3>
          <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">
            {t('pos.draftRecoverMsg', { n: draftAvailable.cart.length })}
          </p>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={recoverDraft}
              className="flex-1 rounded-os bg-amber-600 px-3 py-2 text-sm font-semibold text-white hover:bg-amber-700"
            >
              {t('pos.draftRecover')}
            </button>
            <button
              type="button"
              onClick={dismissDraft}
              className="flex-1 rounded-os border border-amber-300 bg-white px-3 py-2 text-sm text-amber-800 hover:bg-amber-100 dark:bg-amber-900 dark:text-amber-200"
            >
              {t('pos.draftDiscard')}
            </button>
          </div>
        </div>
      )}
      {/* Product grid */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="mb-3 flex gap-2">
          <div className="flex shrink-0 overflow-hidden rounded-os border border-osborder" role="tablist" aria-label={t('pos.bq.sourceLabel')}>
            <button
              type="button"
              onClick={() => setBqMode(false)}
              className={`px-3 py-2 text-sm duration-160 ${!bqMode ? 'bg-accent font-semibold text-white' : 'bg-paper text-muted hover:text-ink'}`}
            >
              {t('pos.bq.sourcePos')}
            </button>
            <button
              type="button"
              onClick={() => setBqMode(true)}
              className={`px-3 py-2 text-sm duration-160 ${bqMode ? 'bg-accent font-semibold text-white' : 'bg-paper text-muted hover:text-ink'}`}
            >
              {t('pos.bq.sourceBq')}
            </button>
          </div>
          <div className="relative flex-1">
            <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') quickAddSku(); }}
              placeholder={bqMode ? t('pos.bq.searchPlaceholder') : t('pos.sell.searchPlaceholder')}
              className={`${inputCls} pl-9`}
            />
          </div>
          {!bqMode && (
            <select
              value={catFilter}
              onChange={(e) => setCatFilter(e.target.value)}
              className={`${inputCls} w-40`}
            >
              {categories.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          )}
        </div>
        {notice && (
          <div className="mb-2 flex items-center gap-2 rounded-os border border-osborder bg-paper px-3 py-2 text-sm text-ink">
            <AlertCircle size={15} className="shrink-0 text-accent" /> {notice}
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto pr-1">
          {bqMode ? (
            bqLoading && bqItems.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted">{t('pos.bq.loading')}</p>
            ) : bqError ? (
              <div className="mx-auto max-w-sm py-8 text-center">
                <AlertCircle size={28} className="mx-auto mb-2 text-red-500" />
                <p className="text-sm font-medium text-ink">{t('pos.bq.loadError')}</p>
                <p className="mt-1 text-xs text-muted">{bqError}</p>
                <button
                  type="button"
                  onClick={() => { setBqError(''); setBqLoading(true); backend.bouquinerie.listItems({ query: query.trim(), status: 'store' }).then(setBqItems).catch((err) => { setBqItems([]); setBqError(err?.message || t('err.loadCatalogue')); }).finally(() => setBqLoading(false)); }}
                  className="mt-3 rounded-os border border-osborder bg-paper px-3 py-1.5 text-xs font-medium text-ink hover:border-accent"
                >
                  {t('pos.bq.retry')}
                </button>
              </div>
            ) : bqItems.length === 0 ? (
              <EmptyState
                icon={LibraryBig}
                title={t('pos.bq.emptyTitle')}
                body={t('pos.bq.emptyBody')}
              />
            ) : (
              <div className="grid grid-cols-2 gap-2 lg:grid-cols-3 2xl:grid-cols-4">
                {bqItems.map((item) => {
                  const out = item.qty <= 0;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => addBqToCart(item)}
                      className={`rounded-os border border-osborder bg-paper p-3 text-left duration-160 hover:border-accent hover:shadow-os ${out ? 'opacity-60' : ''}`}
                    >
                      <p className="truncate text-sm font-medium text-ink">{item.title}</p>
                      {item.author && <p className="truncate text-xs text-muted">{item.author}</p>}
                      <div className="mt-1 flex items-center justify-between">
                        <p className="text-sm font-semibold text-accent">
                          {fmt(Math.round((Number(item.price) || 0) * 100), store.currency)}
                        </p>
                        <span className={`text-xs ${out ? 'font-semibold text-accent' : 'text-muted'}`}>
                          {out ? t('pos.bq.outOfStockShort') : t('pos.bq.qtyLeft', { n: item.qty })}
                        </span>
                      </div>
                      {item.shelf && <p className="mt-0.5 truncate text-xs text-muted">{t('pos.bq.shelf')}: {item.shelf}</p>}
                    </button>
                  );
                })}
              </div>
            )
          ) : visible.length === 0 ? (
            <EmptyState
              icon={Package}
              title="No products yet"
              body={canManage(store.role)
                ? 'Add your first product in the Products tab, then come back here to ring up sales.'
                : t('pos.ui.catalogEmpty')}
            />
          ) : (
            <div className="grid grid-cols-2 gap-2 lg:grid-cols-3 2xl:grid-cols-4">
              {visible.map((p) => {
                const out = p.trackStock && p.stock <= 0;
                const low = p.trackStock && !out && p.lowStockThreshold > 0 && p.stock <= p.lowStockThreshold;
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => addToCart(p)}
                    className={`rounded-os border border-osborder bg-paper p-3 text-left duration-160 hover:border-accent hover:shadow-os ${out ? 'opacity-60' : ''}`}
                  >
                    {p.imageUrl ? (
                      <img src={p.imageUrl} alt="" className="mb-1 h-14 w-full rounded-os object-cover" />
                    ) : null}
                    <p className="truncate text-sm font-medium text-ink">{p.name}</p>
                    {p.category && <p className="truncate text-xs text-muted">{p.category}</p>}
                    <div className="mt-1 flex items-center justify-between">
                      <p className="text-sm font-semibold text-accent">
                        {fmt(p.priceCents, store.currency)}
                        {v4 && p.variants?.length > 0 && <span className="ml-1 text-xs font-normal text-muted">+options</span>}
                      </p>
                      {v4 && p.trackStock && (
                        <span className={`text-xs ${out ? 'font-semibold text-accent' : low ? 'text-accent' : 'text-muted'}`}>
                          {out ? 'Out' : `${p.stock} left`}
                        </span>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Cart */}
      <div className="flex w-80 shrink-0 flex-col rounded-os border border-osborder bg-paper">
        <div className="border-b border-osborder px-4 py-3">
          <h3 className="flex items-center gap-2 font-semibold text-ink">
            <ShoppingCart size={16} className="text-accent" /> {t('pos.ui.currentSale')}
          </h3>
          <div className="mt-2 flex items-center gap-2 text-xs">
            {v4 && (
              <button
                type="button"
                onClick={() => setCustomerOpen(true)}
                className="flex min-w-0 flex-1 items-center gap-1.5 rounded-os border border-osborder px-2 py-1.5 text-muted duration-160 hover:border-accent hover:text-ink"
              >
                <UserCheck size={13} className="shrink-0" />
                <span className="truncate">{selectedCustomer ? selectedCustomer.name : t('pos.ui.addCustomer')}</span>
              </button>
            )}
            {cashier?.name && (
              <span className="flex shrink-0 items-center gap-1 rounded-os bg-surface px-2 py-1.5 text-muted" title="Cashier on this sale">
                <KeyRound size={13} /> {cashier.name}
              </span>
            )}
          </div>
          {orgsOk && (
            <div className="mt-1 flex items-center gap-2 text-xs">
              <button
                type="button"
                onClick={() => setOrgOpen(true)}
                className="flex min-w-0 flex-1 items-center gap-1.5 rounded-os border border-osborder px-2 py-1.5 text-muted duration-160 hover:border-accent hover:text-ink"
              >
                <Building2 size={13} className="shrink-0" />
                <span className="truncate">{activeOrg ? activeOrg.name : t('pos.org.attach')}</span>
                {activeOrg?.taxExempt && (
                  <span className="shrink-0 rounded-os bg-accent/15 px-1.5 py-0.5 font-semibold text-accent">
                    {t('pos.org.exemptBadge')}
                  </span>
                )}
              </button>
              {activeOrg && (
                <button
                  type="button"
                  onClick={() => onOrgChange(null)}
                  title={t('pos.org.remove')}
                  aria-label={t('pos.org.remove')}
                  className="shrink-0 rounded-os border border-osborder p-1.5 text-muted duration-160 hover:border-accent hover:text-ink"
                >
                  <X size={13} />
                </button>
              )}
            </div>
          )}
          {(extras || giftCards) && (
            <div className="mt-2 flex gap-1.5">
              {giftCards && (
                <button
                  type="button"
                  onClick={() => setGiftOpen(true)}
                  className="flex flex-1 items-center justify-center gap-1 rounded-os border border-osborder px-2 py-1.5 text-xs font-medium text-muted duration-160 hover:border-accent hover:text-ink"
                >
                  <Gift size={13} /> {t('pos.gift.button')}
                </button>
              )}
              {extras && (
                <>
                  <button
                    type="button"
                    onClick={() => setDepositOpen(true)}
                    className="flex flex-1 items-center justify-center gap-1 rounded-os border border-osborder px-2 py-1.5 text-xs font-medium text-muted duration-160 hover:border-accent hover:text-ink"
                  >
                    <HandCoins size={13} /> {t('pos.deposit.button')}
                  </button>
                  <button
                    type="button"
                    onClick={() => setSchoolOpen(true)}
                    className="flex flex-1 items-center justify-center gap-1 rounded-os border border-osborder px-2 py-1.5 text-xs font-medium text-muted duration-160 hover:border-accent hover:text-ink"
                  >
                    <GraduationCap size={13} /> {t('pos.school.button')}
                  </button>
                </>
              )}
            </div>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-2">
          {cart.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted">{t('pos.sell.tapToAdd')}</p>
          ) : (
            cart.map((i) => {
              const { net, disc } = lineNet(i);
              return (
                <div key={i.key} className="flex items-center gap-2 border-b border-osborder/60 py-2 last:border-0">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-ink">
                      {i.name}
                      {i.variantName && <span className="text-muted"> · {i.variantName}</span>}
                    </p>
                    <p className="text-xs text-muted">
                      {fmt(i.priceCents, store.currency)} {t('pos.sell.each')}
                      {disc > 0 && <span className="text-accent"> · −{fmt(disc, store.currency)}</span>}
                    </p>
                  </div>
                  <div className="flex items-center gap-1">
                    <button type="button" onClick={() => setQty(i.key, i.qty - 1)} className="rounded-os p-2 text-muted hover:bg-surface hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" aria-label={t('pos.sell.decreaseQty')}>
                      <Minus size={14} />
                    </button>
                    <span className="w-6 text-center text-sm font-medium text-ink">{i.qty}</span>
                    <button type="button" onClick={() => setQty(i.key, i.qty + 1)} className="rounded-os p-2 text-muted hover:bg-surface hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" aria-label={t('pos.sell.increaseQty')}>
                      <Plus size={14} />
                    </button>
                  </div>
                  <button
                    type="button"
                    onClick={() => setDiscountForKey(i.key)}
                    title={t('pos.sell.perItemDiscount')}
                    className="w-16 rounded-os text-right text-sm font-medium text-ink hover:text-accent"
                  >
                    {fmt(net, store.currency)}
                  </button>
                </div>
              );
            })
          )}
        </div>
        <div className="space-y-2 border-t border-osborder px-4 py-3">
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted">{t('pos.sell.discount')}</span>
            <div className="flex flex-1 gap-1">
              <input
                value={discount.value}
                onChange={(e) => setDiscount((d) => {
                  const v = e.target.value.replace(/[^0-9.]/g, '');
                  // Clamp percent discounts at 100% — a cart discount can never exceed the sale.
                  return { ...d, value: d.type === 'percent' && parseFloat(v) > 100 ? '100' : v };
                })}
                placeholder="0"
                inputMode="decimal"
                className={`${inputCls} py-1 text-right`}
              />
              <button
                type="button"
                onClick={() => setDiscount((d) => ({ ...d, type: d.type === 'amount' ? 'percent' : 'amount' }))}
                className="shrink-0 rounded-os border border-osborder bg-surface px-2 text-xs font-medium text-ink hover:border-accent"
                title={t('pos.sell.toggleDiscType')}
              >
                {discount.type === 'amount' ? store.currency : '%'}
              </button>
            </div>
          </div>
          <TotalsRow label={t('pos.sell.subtotal')} value={fmt(subtotal, store.currency)} />
          {discountCents > 0 && <TotalsRow label={t('pos.sell.discount')} value={`−${fmt(discountCents, store.currency)}`} />}
          {extras && (
            promo ? (
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted">{t('pos.promo.discount', { code: promo.code })}</span>
                <span className="flex items-center gap-2 text-sm text-ink">
                  −{fmt(promoDiscountCents, store.currency)}
                  <button
                    type="button"
                    onClick={() => setPromo(null)}
                    title={t('pos.promo.remove')}
                    className="rounded-os p-0.5 text-muted hover:text-accent"
                  >
                    <X size={13} />
                  </button>
                </span>
              </div>
            ) : (
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted">{t('pos.promo.enterCode')}</span>
                  <div className="flex flex-1 gap-1">
                    <input
                      value={promoInput}
                      onChange={(e) => { setPromoInput(e.target.value); setPromoError(''); }}
                      onKeyDown={(e) => { if (e.key === 'Enter') applyPromo(); }}
                      placeholder="CODE"
                      className={`${inputCls} py-1 uppercase`}
                    />
                    <button
                      type="button"
                      onClick={applyPromo}
                      className="shrink-0 rounded-os border border-osborder bg-surface px-2 text-xs font-medium text-ink hover:border-accent"
                    >
                      {t('pos.promo.apply')}
                    </button>
                  </div>
                </div>
                {promoError && <p className="mt-1 text-right text-xs text-accent">{promoError}</p>}
              </div>
            )
          )}
          {taxLines.map((l) => (
            <TotalsRow key={l.name} label={`${l.name} (${l.rate}%)`} value={fmt(l.cents, store.currency)} />
          ))}
          {activeOrg?.taxExempt && (
            <p className="text-center text-xs font-semibold text-accent">
              {activeOrg.type === 'obnl' ? t('pos.org.exemptNoteObnl') : t('pos.org.exemptNote')}
            </p>
          )}
          <TotalsRow label={t('pos.sell.total')} value={fmt(total, store.currency)} big />
          <div className="flex gap-2 pt-1">
            <button
              type="button"
              onClick={kickDrawer}
              title={t('pos.sell.openDrawer')}
              aria-label={t('pos.sell.openDrawer')}
              className="rounded-os border border-osborder bg-surface px-3 py-2.5 text-muted duration-160 hover:text-ink disabled:opacity-40"
            >
              <Wallet size={16} />
            </button>
            <button
              type="button"
              onClick={() => {
                setCart([]);
                // Clear must reset the discount too — otherwise a discount
                // silently persists and applies to the next sale (money bug).
                setDiscount({ type: 'amount', value: '' });
                setPromo(null);
                setPromoInput('');
                setPromoError('');
              }}
              disabled={cart.length === 0}
              className="rounded-os border border-osborder bg-surface px-3 py-2.5 text-sm font-medium text-muted duration-160 hover:text-ink disabled:opacity-40"
            >
              {t('pos.sell.clear')}
            </button>
            <button
              type="button"
              onClick={() => setTenderOpen(true)}
              disabled={cart.length === 0}
              className="flex-1 rounded-os bg-accent px-4 py-2.5 text-sm font-semibold text-accentink duration-160 hover:opacity-90 disabled:opacity-40"
            >
              {t('pos.sell.charge', { total: fmt(total, store.currency) })}
            </button>
          </div>
        </div>
      </div>

      {variantFor && (
        <Modal title={`Choose — ${variantFor.name}`} onClose={() => setVariantFor(null)}>
          <div className="space-y-2">
            {variantFor.variants.map((v, i) => (
              <button
                key={v.id || i}
                type="button"
                onClick={() => { addLine(variantFor, v); setVariantFor(null); }}
                className="flex w-full items-center justify-between rounded-os border border-osborder bg-paper px-4 py-3 text-left duration-160 hover:border-accent"
              >
                <span className="text-sm font-medium text-ink">{v.name}</span>
                <span className="text-sm text-muted">
                  {fmt(variantFor.priceCents + (Number(v.priceDeltaCents) || 0), store.currency)}
                  {Number(v.priceDeltaCents) !== 0 && (
                    <span className="ml-1 text-xs">({Number(v.priceDeltaCents) > 0 ? '+' : ''}{fmt(v.priceDeltaCents, store.currency)})</span>
                  )}
                </span>
              </button>
            ))}
          </div>
        </Modal>
      )}

      {customerOpen && (
        <CustomerPickerModal
          customers={customers}
          selectedId={customerId}
          currency={store.currency}
          onSelect={(id) => { onCustomerChange(id); setCustomerOpen(false); }}
          onClose={() => setCustomerOpen(false)}
        />
      )}
      {orgOpen && orgsOk && (
        <OrgPickerModal
          orgs={orgs}
          selectedId={orgId}
          onSelect={(id) => { onOrgChange(id); setOrgOpen(false); }}
          onClose={() => setOrgOpen(false)}
        />
      )}

      {discountForKey && (() => {
        const line = cart.find((i) => i.key === discountForKey);
        if (!line) return null;
        return (
          <ItemDiscountModal
            line={line}
            currency={store.currency}
            onClose={() => setDiscountForKey(null)}
            onSave={(type, value) => {
              setCart((c) => c.map((i) => (i.key === discountForKey ? { ...i, itemDiscountType: type, itemDiscountValue: value } : i)));
              setDiscountForKey(null);
            }}
          />
        );
      })()}

      {tenderOpen && (
        <TenderModal
          total={total}
          currency={store.currency}
          v4={v4}
          customer={selectedCustomer}
          loyaltyValueCents={extras ? Number(store.loyaltyPointsValueCents) || 0 : 0}
          initialAdjustments={presetAdjustments}
          onLookupCode={(extras || giftCards) ? (code) => backend.pos.lookupTenderCode(store.id, code) : null}
          onClose={() => setTenderOpen(false)}
          onComplete={completeSale}
        />
      )}
      {receipt && (
        <ReceiptModal
          receipt={receipt}
          store={store}
          onClose={() => setReceipt(null)}
        />
      )}
      {giftOpen && giftCards && (
        <GiftCardsModal
          store={store}
          cashier={cashier}
          onSaleComplete={onSaleComplete}
          onClose={() => setGiftOpen(false)}
        />
      )}
      {depositOpen && extras && (
        <DepositsModal
          store={store}
          cashier={cashier}
          onSaleComplete={onSaleComplete}
          onCollect={(dep) => {
            setPresetAdjustments([{
              kind: 'deposit',
              refId: dep.id,
              code: dep.code,
              label: t('pos.deposit.title'),
              cents: Math.max(0, Number(dep.totalCents) - Number(dep.paidCents)),
            }]);
            setDepositOpen(false);
            setTenderOpen(true);
          }}
          onClose={() => setDepositOpen(false)}
        />
      )}
      {schoolOpen && extras && (
        <SchoolListsModal
          store={store}
          onRingUp={(lines) => { seedCartLines(lines); setSchoolOpen(false); }}
          onClose={() => setSchoolOpen(false)}
        />
      )}
    </div>
  );
}

function CustomerPickerModal({ customers, selectedId, onSelect, onClose }) {
  const { t } = useLang();
  const [q, setQ] = useState('');
  const visible = customers.filter((c) => {
    const s = q.trim().toLowerCase();
    return !s || c.name.toLowerCase().includes(s) || (c.phone || '').includes(s);
  });
  return (
    <Modal title="Attach customer" onClose={onClose}>
      <div className="relative mb-3">
        <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search customers…" autoFocus className={`${inputCls} pl-9`} />
      </div>
      <div className="max-h-64 space-y-1.5 overflow-y-auto">
        <button
          type="button"
          onClick={() => onSelect(null)}
          className={`flex w-full items-center justify-between rounded-os border px-3 py-2 text-sm duration-160 ${!selectedId ? 'border-accent bg-paper' : 'border-osborder hover:border-accent'}`}
        >
          <span className="text-muted">{t('pos.tabs2.noCustomer')}</span>
          {!selectedId && <Check size={15} className="text-accent" />}
        </button>
        {visible.map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={() => onSelect(c.id)}
            className={`flex w-full items-center justify-between rounded-os border px-3 py-2 text-left text-sm duration-160 ${selectedId === c.id ? 'border-accent bg-paper' : 'border-osborder hover:border-accent'}`}
          >
            <span>
              <span className="font-medium text-ink">{c.name}</span>
              {c.phone && <span className="ml-2 text-xs text-muted">{c.phone}</span>}
            </span>
            {selectedId === c.id && <Check size={15} className="text-accent" />}
          </button>
        ))}
        {visible.length === 0 && (
          <p className="py-4 text-center text-sm text-muted">{t('pos.tabs2.noCustomerMatch')}</p>
        )}
      </div>
    </Modal>
  );
}

function orgTypeLabel(t, type) {
  switch (type) {
    case 'obnl': return t('pos.org.typeObnl');
    case 'ecole': return t('pos.org.typeEcole');
    case 'institution': return t('pos.org.typeInstitution');
    default: return t('pos.org.typeEntreprise');
  }
}

function OrgPickerModal({ orgs, selectedId, onSelect, onClose }) {
  const { t } = useLang();
  const [q, setQ] = useState('');
  const visible = (orgs || []).filter((o) => {
    const s = q.trim().toLowerCase();
    return !s || o.name.toLowerCase().includes(s) || (o.contact || '').toLowerCase().includes(s);
  });
  return (
    <Modal title={t('pos.org.attach')} onClose={onClose}>
      <div className="relative mb-3">
        <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('pos.org.name')} autoFocus className={`${inputCls} pl-9`} />
      </div>
      <div className="max-h-64 space-y-1.5 overflow-y-auto">
        <button
          type="button"
          onClick={() => onSelect(null)}
          className={`flex w-full items-center justify-between rounded-os border px-3 py-2 text-sm duration-160 ${!selectedId ? 'border-accent bg-paper' : 'border-osborder hover:border-accent'}`}
        >
          <span className="text-muted">{t('pos.org.remove')}</span>
          {!selectedId && <Check size={15} className="text-accent" />}
        </button>
        {visible.map((o) => (
          <button
            key={o.id}
            type="button"
            onClick={() => onSelect(o.id)}
            className={`flex w-full items-center justify-between rounded-os border px-3 py-2 text-left text-sm duration-160 ${selectedId === o.id ? 'border-accent bg-paper' : 'border-osborder hover:border-accent'}`}
          >
            <span className="min-w-0">
              <span className="font-medium text-ink">{o.name}</span>
              <span className="ml-2 text-xs text-muted">{orgTypeLabel(t, o.type)}</span>
              {o.taxExempt && (
                <span className="ml-2 rounded-os bg-accent/15 px-1.5 py-0.5 text-[11px] font-semibold text-accent">
                  {t('pos.org.exemptBadge')}
                </span>
              )}
            </span>
            {selectedId === o.id && <Check size={15} className="shrink-0 text-accent" />}
          </button>
        ))}
        {visible.length === 0 && (
          <p className="py-4 text-center text-sm text-muted">{t('pos.org.none')}</p>
        )}
      </div>
    </Modal>
  );
}

function ItemDiscountModal({ line, currency, onClose, onSave }) {
  const { t } = useLang();
  const [type, setType] = useState(line.itemDiscountType || 'amount');
  const [value, setValue] = useState(line.itemDiscountValue || '');
  return (
    <Modal title={`Discount — ${line.name}`} onClose={onClose}>
      <div className="flex gap-2">
        <input
          value={value}
          onChange={(e) => setValue(e.target.value.replace(/[^0-9.]/g, ''))}
          placeholder="0"
          inputMode="decimal"
          autoFocus
          className={`${inputCls} text-right`}
        />
        <button
          type="button"
          onClick={() => setType((t) => (t === 'amount' ? 'percent' : 'amount'))}
          className="shrink-0 rounded-os border border-osborder bg-surface px-3 text-sm font-medium text-ink hover:border-accent"
          title="Toggle $ / %"
        >
          {type === 'amount' ? currency : '%'}
        </button>
      </div>
      <div className="mt-4 flex gap-2">
        <button
          type="button"
          onClick={() => onSave('amount', '')}
          className="flex-1 rounded-os border border-osborder bg-paper px-4 py-2 text-sm font-medium text-ink hover:border-accent"
        >
          {t('pos.ui.remove')}
        </button>
        <button
          type="button"
          onClick={() => onSave(type, value)}
          className="flex-1 rounded-os bg-accent px-4 py-2 text-sm font-semibold text-accentink hover:opacity-90"
        >
          {t('pos.promo.apply')}
        </button>
      </div>
    </Modal>
  );
}
function TotalsRow({ label, value, big }) {
  return (
    <div className="flex items-center justify-between">
      <span className={`text-muted ${big ? 'text-sm font-semibold text-ink' : 'text-xs'}`}>{label}</span>
      <span className={big ? 'text-lg font-bold text-ink' : 'text-sm text-ink'}>{value}</span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Tender modal                                                        */
/* ------------------------------------------------------------------ */

function TenderModal({ total, currency, v4, customer, loyaltyValueCents, initialAdjustments, onLookupCode, onClose, onComplete }) {
  const { t } = useLang();
  const [method, setMethod] = useState('cash');
  const [tendered, setTendered] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submitLock = useRef(false); // synchronous double-submit lock (state-based disabled is too slow for rapid double-clicks)
  const [adjustments, setAdjustments] = useState(initialAdjustments || []);
  const [codeInput, setCodeInput] = useState('');
  const [codeBusy, setCodeBusy] = useState(false);
  const methods = [
    { id: 'cash', label: t('pos.tender.cash'), icon: Banknote },
    { id: 'card', label: t('pos.tender.card'), icon: CreditCard },
    ...(v4 ? [{ id: 'other', label: t('pos.tender.other'), icon: CircleDollarSign }] : []),
  ];

  const adjCents = adjustments.reduce((s, a) => s + (Math.max(0, Math.round(Number(a.cents) || 0)) || 0), 0);
  const due = Math.max(0, total - adjCents);
  const tenderedCents = Math.round((parseFloat(tendered) || 0) * 100);
  const change = tenderedCents - due;
  const quickAmounts = [due, 500, 1000, 2000, 5000, 10000]
    .filter((a, i, arr) => a >= due && arr.indexOf(a) === i)
    .slice(0, 5);

  const addCode = async () => {
    const code = codeInput.trim();
    if (!code || !onLookupCode) return;
    setCodeBusy(true);
    setError('');
    try {
      const hit = await onLookupCode(code);
      const cents = Math.min(hit.balanceCents, due);
      if (cents <= 0) throw new Error(t('pos.gift.fullyRedeemed'));
      if (adjustments.some((a) => a.code === hit.code)) throw new Error(t('pos.gift.fullyRedeemed'));
      setAdjustments((list) => [
        ...list,
        { kind: hit.kind, refId: hit.id, code: hit.code, label: hit.label, cents },
      ]);
      setCodeInput('');
    } catch (err) {
      setError(err.message || t('pos.gift.noMatch'));
    } finally {
      setCodeBusy(false);
    }
  };

  const loyaltyUsable = (() => {
    const pts = Math.max(0, Math.round(Number(customer?.points) || 0));
    if (!pts || !loyaltyValueCents || loyaltyValueCents <= 0) return null;
    if (adjustments.some((a) => a.kind === 'loyalty')) return null;
    const n = Math.min(pts, Math.floor(due / loyaltyValueCents));
    if (n <= 0) return null;
    return { points: n, cents: n * loyaltyValueCents };
  })();

  const addLoyalty = () => {
    if (!loyaltyUsable) return;
    setAdjustments((list) => [
      ...list,
      { kind: 'loyalty', refId: customer.id, code: null, label: t('pos.loyalty.title'), cents: loyaltyUsable.cents, points: loyaltyUsable.points },
    ]);
  };

  const removeAdjustment = (idx) =>
    setAdjustments((list) => list.filter((_, i) => i !== idx));

  const submit = async () => {
    if (submitLock.current) return; // block rapid double-click double sales
    if (method === 'cash' && tenderedCents < due) {
      setError(t('pos.tender.shortBy', { amount: fmt(due - tenderedCents, currency) }));
      return;
    }
    // NUCLEAR FAILSAFE: max $100,000 tender. No cash sale exceeds this.
    // Prevents fat-finger errors from creating absurd change amounts.
    if (method === 'cash' && tenderedCents > 10000000) {
      setError(t('pos.tender.maxTenderError'));
      return;
    }
    submitLock.current = true;
    setBusy(true);
    try {
      await onComplete({ method, tenderedCents, adjustments });
    } catch (err) {
      // NUCLEAR FAILSAFE: timeout errors get a clear, localized message.
      if (isTimeoutError(err)) {
        setError(t('err.timeout'));
      } else {
        setError(err.message || t('pos.tender.couldNotComplete'));
      }
      submitLock.current = false;
      setBusy(false);
    }
  };

  return (
    <Modal title={t('pos.tender.title')} onClose={onClose}>
      <div className={`mb-4 grid gap-1 rounded-os bg-paper p-1 ${methods.length === 3 ? 'grid-cols-3' : 'grid-cols-2'}`}>
        {methods.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => { setMethod(t.id); setError(''); }}
            className={`flex items-center justify-center gap-2 rounded-os px-3 py-2 text-sm font-medium duration-160 ${
              method === t.id ? 'bg-surface text-ink shadow-os' : 'text-muted hover:text-ink'
            }`}
          >
            <t.icon size={16} /> {t.label}
          </button>
        ))}
      </div>

      <div className="rounded-os bg-paper p-4 text-center">
        <p className="text-xs text-muted">{t('pos.tender.amountDue')}</p>
        <p className="text-3xl font-bold text-ink">{fmt(due, currency)}</p>
        {adjCents > 0 && (
          <div className="mx-auto mt-2 max-w-xs space-y-1">
            {adjustments.map((a, i) => (
              <div key={i} className="flex items-center justify-between rounded-os bg-surface px-2 py-1 text-xs">
                <span className="truncate text-muted">
                  {a.label}{a.code ? ` · ${a.code}` : ''}
                </span>
                <span className="flex shrink-0 items-center gap-1 font-medium text-ink">
                  −{fmt(a.cents, currency)}
                  <button type="button" onClick={() => removeAdjustment(i)} className="rounded-os p-0.5 text-muted hover:text-accent" aria-label="Remove">
                    <X size={12} />
                  </button>
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {onLookupCode && (
        <div className="mt-3 rounded-os border border-osborder bg-paper/60 p-3">
          <p className="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted">
            <Gift size={13} /> {t('pos.gift.title')} / {t('pos.credit.title')} / {t('pos.deposit.title')}
          </p>
          <div className="flex gap-2">
            <input
              value={codeInput}
              onChange={(e) => { setCodeInput(e.target.value); setError(''); }}
              onKeyDown={(e) => { if (e.key === 'Enter') addCode(); }}
              placeholder={t('pos.gift.codePlaceholder')}
              className={`${inputCls} font-mono uppercase`}
            />
            <button
              type="button"
              onClick={addCode}
              disabled={codeBusy || !codeInput.trim()}
              className="shrink-0 rounded-os bg-accent px-3 py-2 text-sm font-semibold text-accentink duration-160 hover:opacity-90 disabled:opacity-40"
            >
              {codeBusy ? '…' : t('pos.gift.check')}
            </button>
          </div>
          {loyaltyUsable ? (
            <button
              type="button"
              onClick={addLoyalty}
              className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-os border border-osborder px-3 py-2 text-xs font-medium text-ink duration-160 hover:border-accent"
            >
              <Star size={13} className="text-accent" />
              {t('pos.loyalty.usePoints', {
                n: loyaltyUsable.points,
                amount: fmt(loyaltyUsable.cents, currency),
              })}
            </button>
          ) : customer ? (
            <p className="mt-2 text-center text-xs text-muted">
              {t('pos.loyalty.balance', { n: Math.max(0, Math.round(Number(customer.points) || 0)) })}
            </p>
          ) : (
            <p className="mt-2 text-center text-xs text-muted">{t('pos.loyalty.attachHint')}</p>
          )}
        </div>
      )}

      {method === 'cash' && (
        <div className="mt-4 space-y-3">
          <Field label={t('pos.tender.cashTendered', { currency })}>
            <input
              value={tendered}
              onChange={(e) => { setTendered(e.target.value.replace(/[^0-9.]/g, '')); setError(''); }}
              placeholder="0.00"
              inputMode="decimal"
              autoFocus
              className={`${inputCls} text-right text-lg font-semibold`}
            />
          </Field>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setTendered((due / 100).toFixed(2))}
              className="rounded-os border border-osborder bg-paper px-3 py-1.5 text-sm text-ink hover:border-accent"
            >
              {t('pos.tender.exact')}
            </button>
            {quickAmounts.filter((a) => a !== due).map((a) => (
              <button
                key={a}
                type="button"
                onClick={() => setTendered((a / 100).toFixed(2))}
                className="rounded-os border border-osborder bg-paper px-3 py-1.5 text-sm text-ink hover:border-accent"
              >
                {fmt(a, currency)}
              </button>
            ))}
          </div>
          {tendered && (
            <div className="rounded-os bg-paper p-3 text-center text-sm font-medium text-ink">
              {change >= 0 ? t('pos.tender.changeDue', { amount: fmt(change, currency) }) : t('pos.tender.stillOwed', { amount: fmt(-change, currency) })}
            </div>
          )}
        </div>
      )}

      {method === 'card' && (
        <p className="mt-4 rounded-os bg-paper p-3 text-center text-sm text-muted">
          {t('pos.tender.cardHint', { total: fmt(due, currency) })}
        </p>
      )}

      {method === 'other' && (
        <p className="mt-4 rounded-os bg-paper p-3 text-center text-sm text-muted">
          {t('pos.tender.otherHint', { total: fmt(due, currency) })}
        </p>
      )}

      <div className="mt-3"><ErrorNote message={error} /></div>

      <button
        type="button"
        onClick={submit}
        disabled={busy}
        className="mt-4 w-full rounded-os bg-accent px-4 py-2.5 text-sm font-semibold text-accentink duration-160 hover:opacity-90 disabled:opacity-60"
      >
        <Check size={16} className="mr-2 inline" />
        {busy ? t('pos.tender.recording') : t('pos.tender.completeSale')}
      </button>
    </Modal>
  );
}
/* ------------------------------------------------------------------ */
/* Gift cards + credit notes                                           */
/* ------------------------------------------------------------------ */

function GiftCardsModal({ store, cashier, onSaleComplete, onClose }) {
  const { t } = useLang();
  const [view, setView] = useState('sell'); // sell | balance | outstanding
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [method, setMethod] = useState('cash');
  const [sold, setSold] = useState(null);
  const sellLock = useRef(false); // synchronous double-submit lock for gift-card issuance
  const [codeInput, setCodeInput] = useState('');
  const [lookup, setLookup] = useState(null);
  const [outstanding, setOutstanding] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [histCard, setHistCard] = useState(null); // { card, events } | null
  const [histLoading, setHistLoading] = useState(false);

  const loadOutstanding = async () => {
    try {
      // Credit notes are part of the wider tender suite (still unimplemented
      // server-side); the gift-card view degrades to cards only.
      const [gcs, cns] = await Promise.all([
        backend.pos.listGiftCards(store.id, { outstandingOnly: true }),
        typeof backend.pos.listCreditNotes === 'function'
          ? backend.pos.listCreditNotes(store.id, { outstandingOnly: true })
          : Promise.resolve([]),
      ]);
      setOutstanding({ gcs, cns });
    } catch (err) {
      setError(err.message);
      setOutstanding({ gcs: [], cns: [] });
    }
  };

  useEffect(() => {
    if (view === 'outstanding') loadOutstanding();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  const sell = async () => {
    if (sellLock.current) return; // block rapid double-click double issuance
    const cents = Math.round((parseFloat(amount) || 0) * 100);
    if (cents <= 0) return setError(t('pos.gift.amount') + ' > 0');
    sellLock.current = true;
    setBusy(true);
    setError('');
    let card = null;
    try {
      card = await backend.pos.sellGiftCard(store.id, { amountCents: cents, note: note.trim() });
      // Gift cards are sold tax-free — tax applies at redemption.
      const recorded = await onSaleComplete({
        items: [{
          productId: `giftcard:${card.id}`,
          name: `${t('pos.gift.title')} ${card.code}`,
          priceCents: cents,
          qty: 1,
        }],
        subtotalCents: cents,
        discountCents: 0,
        promoDiscountCents: 0,
        taxCents: 0,
        totalCents: cents,
        adjustments: [],
        loyaltyEarned: 0,
        loyaltyRedeemed: 0,
        method,
        tenderedCents: cents,
        changeCents: 0,
        cashierName: cashier?.name || null,
        staffPinId: cashier?.pinId || null,
        customerId: null,
      });
      setSold({ ...card, saleNumber: recorded.number });
      setAmount('');
      setNote('');
    } catch (err) {
      // The card was issued but its sale failed to record — cancel the issue
      // so no active card exists without a sale on the books. The card never
      // reached the screen, so a clean cancel just surfaces the sale error.
      if (card) {
        try {
          await backend.pos.cancelGiftCardIssue(store.id, card.id);
        } catch (cancelErr) {
          // The card is still live: say so loudly, with its code, so staff
          // void it by hand instead of money appearing from nowhere.
          setError(t('pos.gift.issueOrphaned', { code: card.code }));
          return;
        }
      }
      setError(err.message || t('pos.tender.couldNotComplete'));
    } finally {
      sellLock.current = false;
      setBusy(false);
    }
  };

  const check = async () => {
    const code = codeInput.trim();
    if (!code) return;
    setBusy(true);
    setError('');
    setLookup(null);
    try {
      setLookup(await backend.pos.lookupTenderCode(store.id, code));
    } catch (err) {
      setError(err.message || t('pos.gift.noMatch'));
    } finally {
      setBusy(false);
    }
  };

  const copyCode = async (code) => {
    try {
      await navigator.clipboard.writeText(code);
      setError('');
    } catch {
      /* visible to copy by hand */
    }
  };

  const openHistory = async (card) => {
    setHistLoading(true);
    setHistCard({ card, events: null });
    setError('');
    try {
      const events = await backend.pos.giftCardHistory(store.id, card.id);
      setHistCard({ card, events });
    } catch (err) {
      setError(err.message);
      setHistCard(null);
    } finally {
      setHistLoading(false);
    }
  };

  const voidCard = async (card) => {
    if (!window.confirm(t('pos.gift.voidConfirm', { code: card.code }))) return;
    setBusy(true);
    setError('');
    try {
      await backend.pos.voidGiftCard(store.id, card.id);
      setHistCard(null);
      await loadOutstanding();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const histKindLabel = (kind) =>
    kind === 'issued' ? t('pos.gift.issued')
    : kind === 'redeemed' ? t('pos.gift.redeemed')
    : kind === 'credited' ? t('pos.gift.credited')
    : t('pos.gift.voidedEvent');

  return (
    <Modal title={t('pos.gift.title')} onClose={onClose} wide>
      <div className="mb-4 flex gap-1 rounded-os bg-paper p-1">
        {[
          { id: 'sell', label: t('pos.gift.tabSell') },
          { id: 'balance', label: t('pos.gift.tabBalance') },
          { id: 'outstanding', label: t('pos.gift.tabOutstanding') },
        ].map((v) => (
          <button
            key={v.id}
            type="button"
            onClick={() => { setView(v.id); setError(''); }}
            className={`flex-1 rounded-os px-3 py-2 text-sm font-medium duration-160 ${view === v.id ? 'bg-surface text-ink shadow-os' : 'text-muted hover:text-ink'}`}
          >
            {v.label}
          </button>
        ))}
      </div>

      <ErrorNote message={error} />

      {view === 'sell' && !sold && (
        <div className="space-y-3">
          <Field label={`${t('pos.gift.amount')} (${store.currency})`}>
            <input
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))}
              placeholder="0.00"
              inputMode="decimal"
              autoFocus
              className={`${inputCls} text-right text-lg font-semibold`}
            />
          </Field>
          <Field label={t('pos.gift.note')}>
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="…" className={inputCls} />
          </Field>
          <Field label={t('pos.gift.method')}>
            <select value={method} onChange={(e) => setMethod(e.target.value)} className={inputCls}>
              <option value="cash">{t('pos.tender.cash')}</option>
              <option value="card">{t('pos.tender.card')}</option>
            </select>
          </Field>
          <p className="text-xs text-muted">{t('pos.gift.sellHint')}</p>
          <button
            type="button"
            onClick={sell}
            disabled={busy}
            className="w-full rounded-os bg-accent px-4 py-2.5 text-sm font-semibold text-accentink duration-160 hover:opacity-90 disabled:opacity-60"
          >
            {busy ? t('pos.tender.recording') : t('pos.gift.sell')}
          </button>
        </div>
      )}

      {view === 'sell' && sold && (
        <div className="text-center">
          <p className="flex items-center justify-center gap-2 text-sm font-semibold text-ink">
            <Gift size={16} className="text-accent" /> {t('pos.gift.soldTitle')}
          </p>
          <p className="mt-1 text-xs text-muted">{t('pos.gift.soldBody')}</p>
          <button
            type="button"
            onClick={() => copyCode(sold.code)}
            title={t('pos.gift.copy')}
            className="mx-auto mt-3 flex items-center gap-2 rounded-os border border-osborder bg-paper px-4 py-3"
          >
            <span className="font-mono text-2xl font-bold tracking-widest text-ink">{sold.code}</span>
            <Copy size={16} className="text-muted" />
          </button>
          <p className="mt-2 text-sm font-medium text-ink">{fmt(sold.initialCents, store.currency)}</p>
          <button
            type="button"
            onClick={() => setSold(null)}
            className="mt-4 w-full rounded-os border border-osborder bg-paper px-4 py-2.5 text-sm font-medium text-ink hover:border-accent"
          >
            {t('pos.gift.sell')}
          </button>
        </div>
      )}

      {view === 'balance' && (
        <div className="space-y-3">
          <div className="flex gap-2">
            <input
              value={codeInput}
              onChange={(e) => { setCodeInput(e.target.value); setError(''); }}
              onKeyDown={(e) => { if (e.key === 'Enter') check(); }}
              placeholder={t('pos.gift.codePlaceholder')}
              autoFocus
              className={`${inputCls} font-mono uppercase`}
            />
            <button
              type="button"
              onClick={check}
              disabled={busy || !codeInput.trim()}
              className="shrink-0 rounded-os bg-accent px-4 py-2 text-sm font-semibold text-accentink duration-160 hover:opacity-90 disabled:opacity-40"
            >
              {busy ? '…' : t('pos.gift.check')}
            </button>
          </div>
          {lookup && (
            <div className="rounded-os bg-paper p-4 text-center">
              <p className="text-xs text-muted">{lookup.label} · <span className="font-mono">{lookup.code}</span></p>
              <p className="mt-1 text-2xl font-bold text-ink">{fmt(lookup.balanceCents, store.currency)}</p>
              {lookup.customerName && <p className="mt-1 text-xs text-muted">{lookup.customerName}</p>}
            </div>
          )}
        </div>
      )}

      {view === 'outstanding' && (
        outstanding === null ? (
          <p className="py-6 text-center text-sm text-muted">{t('common.loading')}</p>
        ) : (outstanding.gcs.length === 0 && outstanding.cns.length === 0) ? (
          <p className="py-6 text-center text-sm text-muted">{t('pos.gift.noneOutstanding')}</p>
        ) : (
          <div className="max-h-80 space-y-4 overflow-y-auto">
            {outstanding.gcs.length > 0 && (
              <section>
                <h4 className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-muted">
                  <Gift size={13} /> {t('pos.gift.title')}
                </h4>
                <div className="space-y-1.5">
                  {outstanding.gcs.map((g) => (
                    <div key={g.id}>
                      <button
                        type="button"
                        onClick={() => (histCard?.card.id === g.id ? setHistCard(null) : openHistory(g))}
                        className="flex w-full items-center justify-between rounded-os border border-osborder bg-paper px-3 py-2 text-sm hover:border-accent"
                      >
                        <span className="font-mono font-medium text-ink">{g.code}</span>
                        <span className="font-semibold text-ink">{fmt(g.balanceCents, store.currency)}</span>
                      </button>
                      {histCard?.card.id === g.id && (
                        <div className="mt-1 rounded-os border border-osborder/60 bg-surface/50 px-3 py-2">
                          <p className="mb-1 text-xs font-semibold text-muted">{t('pos.gift.history')}</p>
                          {histLoading || !histCard.events ? (
                            <p className="py-2 text-center text-xs text-muted">{t('common.loading')}</p>
                          ) : histCard.events.length === 0 ? (
                            <p className="py-2 text-center text-xs text-muted">{t('pos.gift.noHistory')}</p>
                          ) : (
                            <ul className="space-y-1">
                              {histCard.events.map((e, i) => (
                                <li key={i} className="flex items-center justify-between text-xs text-ink">
                                  <span>
                                    {histKindLabel(e.kind)} · {fmt(e.amountCents, store.currency)}
                                    <span className="ml-1 text-muted">
                                      {new Date(e.createdAt).toLocaleDateString(localeTag(), { month: 'short', day: 'numeric' })}
                                      {e.saleNumber != null && ` · ${t('pos.gift.saleRef', { n: e.saleNumber })}`}
                                    </span>
                                  </span>
                                  <span className="text-muted">{t('pos.gift.balance')}: {fmt(e.balanceAfterCents, store.currency)}</span>
                                </li>
                              ))}
                            </ul>
                          )}
                          {canManage(store.role) && g.balanceCents === g.initialCents && (
                            <button
                              type="button"
                              onClick={() => voidCard(g)}
                              disabled={busy}
                              className="mt-2 rounded-os border border-red-500/40 px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-500/10 disabled:opacity-60"
                            >
                              {t('pos.gift.voidCard')}
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </section>
            )}
            {outstanding.cns.length > 0 && (
              <section>
                <h4 className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-muted">
                  <Receipt size={13} /> {t('pos.credit.title')}
                </h4>
                <div className="space-y-1.5">
                  {outstanding.cns.map((c) => (
                    <div key={c.id} className="flex items-center justify-between rounded-os border border-osborder bg-paper px-3 py-2 text-sm">
                      <span>
                        <span className="font-mono font-medium text-ink">{c.code}</span>
                        {c.customerName && <span className="ml-2 text-xs text-muted">{c.customerName}</span>}
                      </span>
                      <span className="font-semibold text-ink">{fmt(c.balanceCents, store.currency)}</span>
                    </div>
                  ))}
                </div>
              </section>
            )}
          </div>
        )
      )}
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Deposits                                                            */
/* ------------------------------------------------------------------ */

function DepositsModal({ store, cashier, onSaleComplete, onCollect, onClose }) {
  const { t } = useLang();
  const [deposits, setDeposits] = useState(null);
  const [filter, setFilter] = useState('open'); // open | ready | picked | all
  const [showNew, setShowNew] = useState(false);
  const [form, setForm] = useState({ customerName: '', phone: '', description: '', orderTotal: '', depositNow: '', method: 'cash' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const createLock = useRef(false); // synchronous double-submit lock for deposit creation

  const load = async () => {
    setDeposits(null);
    try {
      setDeposits(await backend.pos.listDeposits(store.id));
    } catch (err) {
      setError(err.message);
      setDeposits([]);
    }
  };
  useEffect(() => { load(); }, []);
  const visible = (deposits || []).filter((d) =>
    filter === 'all' ? true : d.status === filter
  );

  const create = async () => {
    if (createLock.current) return; // block rapid double-click double deposits
    const orderTotalCents = Math.round((parseFloat(form.orderTotal) || 0) * 100);
    const depositCents = Math.round((parseFloat(form.depositNow) || 0) * 100);
    if (orderTotalCents <= 0) return setError(t('pos.deposit.orderTotal') + ' > 0');
    if (depositCents < 0 || depositCents > orderTotalCents) return setError(t('pos.deposit.balanceDue') + ' / ' + t('pos.deposit.depositNow'));
    createLock.current = true;
    setBusy(true);
    setError('');
    try {
      // Record the deposit as a payment through the regular sale pipeline so
      // it appears in reports, drawer, and accounting.
      let saleNumber = null;
      if (depositCents > 0) {
        const recorded = await onSaleComplete({
          items: [{
            productId: `deposit:new`,
            name: `${t('pos.deposit.title')} — ${form.description.trim() || t('pos.deposit.new')}`,
            priceCents: depositCents,
            qty: 1,
          }],
          subtotalCents: depositCents,
          discountCents: 0,
          promoDiscountCents: 0,
          taxCents: 0,
          totalCents: depositCents,
          adjustments: [],
          loyaltyEarned: 0,
          loyaltyRedeemed: 0,
          method: form.method,
          tenderedCents: depositCents,
          changeCents: 0,
          cashierName: cashier?.name || null,
          staffPinId: cashier?.pinId || null,
          customerId: null,
        });
        saleNumber = recorded.number;
      }
      await backend.pos.takeDeposit(store.id, {
        customerName: form.customerName.trim(),
        phone: form.phone.trim(),
        description: form.description.trim(),
        orderTotalCents,
        depositCents,
        saleNumber,
      });
      setForm({ customerName: '', phone: '', description: '', orderTotal: '', depositNow: '', method: 'cash' });
      setShowNew(false);
      await load();
    } catch (err) {
      setError(err.message || t('pos.tender.couldNotComplete'));
    } finally {
      createLock.current = false;
      setBusy(false);
    }
  };

  const setStatus = async (d, status) => {
    setError('');
    try {
      if (status === 'ready') await backend.pos.depositSetReady(store.id, d.id);
      else if (status === 'open') await backend.pos.depositSetOpen(store.id, d.id);
      await load();
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <Modal title={t('pos.deposit.title')} onClose={onClose} wide>
      <div className="mb-3 flex items-center gap-1 rounded-os bg-paper p-1">
        {['open', 'ready', 'picked', 'all'].map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFilter(f)}
            className={`flex-1 rounded-os px-2 py-1.5 text-xs font-medium duration-160 ${filter === f ? 'bg-surface text-ink shadow-os' : 'text-muted hover:text-ink'}`}
          >
            {t(`pos.deposit.${f}`)}
          </button>
        ))}
        <button
          type="button"
          onClick={() => { setShowNew(!showNew); setError(''); }}
          className="shrink-0 rounded-os bg-accent px-3 py-1.5 text-xs font-semibold text-accentink duration-160 hover:opacity-90"
        >
          <Plus size={13} className="mr-1 inline" /> {t('pos.deposit.new')}
        </button>
      </div>

      <ErrorNote message={error} />

      {showNew && (
        <div className="mb-4 space-y-2 rounded-os border border-osborder bg-paper/60 p-3">
          <div className="grid grid-cols-2 gap-2">
            <Field label={t('pos.deposit.customer')}>
              <input value={form.customerName} onChange={(e) => setForm({ ...form, customerName: e.target.value })} placeholder="Nom / Name" className={inputCls} />
            </Field>
            <Field label={t('pos.deposit.phone')}>
              <input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="514…" className={inputCls} />
            </Field>
          </div>
          <Field label={t('pos.deposit.description')}>
            <input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="…" className={inputCls} />
          </Field>
          <div className="grid grid-cols-3 gap-2">
            <Field label={`${t('pos.deposit.orderTotal')} (${store.currency})`}>
              <input value={form.orderTotal} onChange={(e) => setForm({ ...form, orderTotal: e.target.value.replace(/[^0-9.]/g, '') })} placeholder="0.00" inputMode="decimal" className={inputCls} />
            </Field>
            <Field label={`${t('pos.deposit.depositNow')} (${store.currency})`}>
              <input value={form.depositNow} onChange={(e) => setForm({ ...form, depositNow: e.target.value.replace(/[^0-9.]/g, '') })} placeholder="0.00" inputMode="decimal" className={inputCls} />
            </Field>
            <Field label={t('pos.deposit.method')}>
              <select value={form.method} onChange={(e) => setForm({ ...form, method: e.target.value })} className={inputCls}>
                <option value="cash">{t('pos.tender.cash')}</option>
                <option value="card">{t('pos.tender.card')}</option>
              </select>
            </Field>
          </div>
          <button
            type="button"
            onClick={create}
            disabled={busy}
            className="w-full rounded-os bg-accent px-4 py-2 text-sm font-semibold text-accentink duration-160 hover:opacity-90 disabled:opacity-60"
          >
            {busy ? t('pos.tender.recording') : t('pos.deposit.new')}
          </button>
        </div>
      )}

      {deposits === null ? (
        <p className="py-6 text-center text-sm text-muted">{t('common.loading')}</p>
      ) : visible.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted">{t('pos.deposit.none')}</p>
      ) : (
        <div className="max-h-80 space-y-2 overflow-y-auto">
          {visible.map((d) => (
            <div key={d.id} className="rounded-os border border-osborder bg-paper p-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-ink">
                    <span className="font-mono text-muted">{d.code}</span>
                    {' · '}{d.description || '—'}
                  </p>
                  <p className="text-xs text-muted">
                    {[d.customerName, d.phone].filter(Boolean).join(' · ') || '—'}
                  </p>
                </div>
                <span className={`shrink-0 rounded-os px-2 py-0.5 text-xs font-medium ${d.status === 'ready' ? 'bg-accent/15 text-accent' : 'bg-surface text-muted'}`}>
                  {t(`pos.deposit.${d.status}`)}
                </span>
              </div>
              <div className="mt-2 flex items-center justify-between text-xs">
                <span className="text-muted">
                  {t('pos.deposit.depositNow')}: {fmt(d.paidCents, store.currency)}
                  {' · '}{t('pos.deposit.balanceDue')}: <strong className="text-ink">{fmt(d.totalCents - d.paidCents, store.currency)}</strong>
                  {' · '}{t('pos.deposit.orderTotal')}: {fmt(d.totalCents, store.currency)}
                </span>
              </div>
              {d.status !== 'picked' && (
                <div className="mt-2 flex gap-2">
                  {d.status === 'open' && (
                    <button
                      type="button"
                      onClick={() => setStatus(d, 'ready')}
                      className="rounded-os border border-osborder px-2 py-1 text-xs font-medium text-ink hover:border-accent"
                    >
                      <Bell size={12} className="mr-1 inline" /> {t('pos.deposit.markReady')}
                    </button>
                  )}
                  {d.status === 'ready' && (
                    <button
                      type="button"
                      onClick={() => setStatus(d, 'open')}
                      className="rounded-os border border-osborder px-2 py-1 text-xs font-medium text-ink hover:border-accent"
                    >
                      {t('pos.deposit.markOpen')}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => onCollect(d)}
                    className="rounded-os bg-accent px-2 py-1 text-xs font-semibold text-accentink duration-160 hover:opacity-90"
                  >
                    <HandCoins size={12} className="mr-1 inline" /> {t('pos.deposit.collect')}
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* School lists                                                        */
/* ------------------------------------------------------------------ */

function SchoolListsModal({ store, onRingUp, onClose }) {
  const { t } = useLang();
  const [lists, setLists] = useState(null);
  const [editing, setEditing] = useState(null); // null | {…}
  const [error, setError] = useState('');

  const load = async () => {
    setLists(null);
    try {
      setLists(await backend.pos.listSchoolLists(store.id));
    } catch (err) {
      setError(err.message);
      setLists([]);
    }
  };
  useEffect(() => { load(); }, []);

  const startNew = () => setEditing({ id: null, schoolName: '', grade: '', items: [] });
  const startEdit = (l) => setEditing({ id: l.id, schoolName: l.schoolName || '', grade: l.grade || '', items: (l.items || []).map((i) => ({ ...i })) });

  const saveEditing = async () => {
    if (!editing.schoolName.trim()) return setError(t('pos.school.schoolName'));
    setError('');
    try {
      await backend.pos.saveSchoolList(store.id, {
        id: editing.id,
        schoolName: editing.schoolName.trim(),
        grade: editing.grade.trim(),
        items: (editing.items || []).map((i) => ({
          name: String(i.name || '').trim(),
          priceCents: Math.max(0, Math.round(Number(i.priceCents) || 0)),
          qty: Math.max(1, Math.round(Number(i.qty) || 1)),
        })).filter((i) => i.name),
      });
      setEditing(null);
      await load();
    } catch (err) {
      setError(err.message);
    }
  };

  const remove = async (id) => {
    if (!window.confirm(t('common.confirmDelete'))) return;
    setError('');
    try {
      await backend.pos.deleteSchoolList(store.id, id);
      await load();
    } catch (err) {
      setError(err.message);
    }
  };

  if (editing) {
    const editItem = (idx, patch) =>
      setEditing({ ...editing, items: editing.items.map((it, i) => (i === idx ? { ...it, ...patch } : it)) });
    return (
      <Modal title={t('pos.school.edit')} onClose={() => setEditing(null)} wide>
        <ErrorNote message={error} />
        <div className="grid grid-cols-2 gap-2">
          <Field label={t('pos.school.schoolName')}>
            <input value={editing.schoolName} onChange={(e) => setEditing({ ...editing, schoolName: e.target.value })} autoFocus className={inputCls} />
          </Field>
          <Field label={t('pos.school.grade')}>
            <input value={editing.grade} onChange={(e) => setEditing({ ...editing, grade: e.target.value })} className={inputCls} />
          </Field>
        </div>
        <div className="mt-3 space-y-2">
          {editing.items.map((it, idx) => (
            <div key={idx} className="flex items-center gap-2">
              <input
                value={it.name}
                onChange={(e) => editItem(idx, { name: e.target.value })}
                placeholder={t('pos.school.itemName')}
                className={`${inputCls} flex-1`}
              />
              <input
                value={it.qty}
                onChange={(e) => editItem(idx, { qty: e.target.value.replace(/[^0-9]/g, '') })}
                inputMode="numeric"
                className={`${inputCls} w-16`}
              />
              <input
                value={(it.priceCents / 100).toFixed(2)}
                onChange={(e) => editItem(idx, { priceCents: Math.round((parseFloat(e.target.value.replace(/[^0-9.]/g, '')) || 0) * 100) })}
                inputMode="decimal"
                className={`${inputCls} w-24 text-right`}
              />
              <button
                type="button"
                onClick={() => setEditing({ ...editing, items: editing.items.filter((_, i) => i !== idx) })}
                className="shrink-0 rounded-os p-1.5 text-muted hover:text-accent"
              >
                <Trash2 size={15} />
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={() => setEditing({ ...editing, items: [...editing.items, { name: '', qty: 1, priceCents: 0 }] })}
            className="flex w-full items-center justify-center gap-1 rounded-os border border-dashed border-osborder px-3 py-2 text-sm text-muted hover:border-accent hover:text-ink"
          >
            <Plus size={14} /> {t('pos.school.addItem')}
          </button>
        </div>
        <div className="mt-4 flex gap-2">
          <button
            type="button"
            onClick={() => setEditing(null)}
            className="flex-1 rounded-os border border-osborder bg-paper px-4 py-2 text-sm font-medium text-ink hover:border-accent"
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            onClick={saveEditing}
            className="flex-1 rounded-os bg-accent px-4 py-2 text-sm font-semibold text-accentink duration-160 hover:opacity-90"
          >
            {t('common.save')}
          </button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title={t('pos.school.title')} onClose={onClose} wide>
      <div className="mb-3 flex justify-end">
        <button
          type="button"
          onClick={startNew}
          className="rounded-os bg-accent px-3 py-1.5 text-xs font-semibold text-accentink duration-160 hover:opacity-90"
        >
          <Plus size={13} className="mr-1 inline" /> {t('pos.school.new')}
        </button>
      </div>
      <ErrorNote message={error} />
      {lists === null ? (
        <p className="py-6 text-center text-sm text-muted">{t('common.loading')}</p>
      ) : lists.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted">{t('pos.school.none')}</p>
      ) : (
        <div className="max-h-80 space-y-2 overflow-y-auto">
          {lists.map((l) => (
            <div key={l.id} className="rounded-os border border-osborder bg-paper p-3">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="text-sm font-semibold text-ink">
                    {l.schoolName}{l.grade ? ` · ${l.grade}` : ''}
                  </p>
                  <p className="text-xs text-muted">
                    {t('pos.school.itemCount', { n: (l.items || []).length })}
                    {' · '}
                    {fmt((l.items || []).reduce((s, i) => s + i.priceCents * i.qty, 0), store.currency)}
                  </p>
                </div>
                <div className="flex shrink-0 gap-1">
                  <button
                    type="button"
                    onClick={() => onRingUp((l.items || []).map((i) => ({ name: i.name, qty: i.qty, priceCents: i.priceCents })))}
                    className="flex items-center gap-1 rounded-os bg-accent px-2 py-1 text-xs font-semibold text-accentink duration-160 hover:opacity-90"
                  >
                    <ShoppingCart size={12} /> {t('pos.school.ringUp')}
                  </button>
                  <button
                    type="button"
                    onClick={() => startEdit(l)}
                    className="rounded-os border border-osborder p-1.5 text-muted hover:text-ink"
                  >
                    <Edit2 size={13} />
                  </button>
                  <button
                    type="button"
                    onClick={() => remove(l.id)}
                    className="rounded-os border border-osborder p-1.5 text-muted hover:text-accent"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Receipt                                                             */
/* ------------------------------------------------------------------ */

function ReceiptModal({ receipt, store, onClose }) {
  const { t, lang } = useLang();
  const dt = new Date(receipt.createdAt);
  const [printBusy, setPrintBusy] = useState(false);
  const [printMsg, setPrintMsg] = useState('');
  // Historical truth: if the sale persisted its tax snapshot (migration 021),
  // the receipt shows exactly what was charged — even if the shop's tax
  // settings changed since. A persisted [] means genuinely tax-free at sale
  // time (no-tax preset or tax-exempt organization), NOT "recompute me".
  // null = legacy sale from before snapshots existed: best-effort recompute
  // from current settings, clearly the only option available.
  const lines = Array.isArray(receipt.taxLines)
    ? receipt.taxLines
    : taxLinesFor(store, Math.max(0, receipt.subtotalCents - receipt.discountCents));

  const doPrint = async () => {
    setPrintBusy(true);
    setPrintMsg('');
    try {
      const res = await printReceipt({ sale: receipt, store, taxLines: lines, labels: receiptLabels(t) });
      setPrintMsg(res.via === 'browser' ? 'Sent to the system print dialog.' : 'Receipt sent to printer.');
    } catch (err) {
      setPrintMsg(`Print failed: ${err?.message || err}`);
    } finally {
      setPrintBusy(false);
    }
  };
  return (
    <Modal title={receipt.queued ? t('pos.queuedTitle') : `Receipt #${receipt.number}`} onClose={onClose}>
      <div className="pos-receipt-print rounded-os border border-osborder bg-paper p-5">
        {/* NUCLEAR FAILSAFE: queued (offline) sales show a prominent banner. */}
        {receipt.queued && (
          <div className="mb-3 rounded-os border-2 border-amber-500 bg-amber-50 p-3 text-center dark:bg-amber-950">
            <p className="text-sm font-bold text-amber-800 dark:text-amber-200">
              {t('pos.queuedTitle')}
            </p>
            <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">
              {t('pos.queuedMsg')}
            </p>
          </div>
        )}
        <div className="text-center">
          <p className="text-lg font-bold text-ink">{store.name}</p>
          <p className="text-xs text-muted">
            {dt.toLocaleDateString(localeTag())} {dt.toLocaleTimeString(localeTag(), { hour: '2-digit', minute: '2-digit' })}
          </p>
          <p className="text-xs text-muted">Sale #{receipt.number}</p>
          {receipt.cashierName && <p className="text-xs text-muted">Cashier: {receipt.cashierName}</p>}
          {receipt.customerName && <p className="text-xs text-muted">Customer: {receipt.customerName}</p>}
          {(receipt.orgName || receipt.orgId) && (
            <p className="text-xs text-muted">{t('pos.org.billedTo')}: {receipt.orgName || receipt.orgId}</p>
          )}
          {receipt.orgTaxExempt && (
            <p className="text-xs font-semibold text-ink">
              {receipt.orgType === 'obnl' ? t('pos.org.exemptNoteObnl') : t('pos.org.exemptNote')}
            </p>
          )}
        </div>
        <div className="my-3 border-t border-dashed border-osborder" />
        {receipt.items.map((i, idx) => (
          <div key={idx} className="py-0.5 text-sm text-ink">
            <div className="flex justify-between">
              <span>{i.qty} × {i.name}{i.variantName ? ` (${i.variantName})` : ''}</span>
              <span>{fmt(i.priceCents * i.qty, store.currency)}</span>
            </div>
            {i.itemDiscountCents > 0 && (
              <div className="flex justify-between text-xs text-muted">
                <span>{t('pos.tabs2.itemDiscount')}</span>
                <span>−{fmt(i.itemDiscountCents, store.currency)}</span>
              </div>
            )}
          </div>
        ))}
        <div className="my-3 border-t border-dashed border-osborder" />
        <TotalsRow label="Subtotal" value={fmt(receipt.subtotalCents, store.currency)} />
        {receipt.discountCents > 0 && <TotalsRow label="Discount" value={`−${fmt(receipt.discountCents, store.currency)}`} />}
        {receipt.promoDiscountCents > 0 && (
          <TotalsRow label={t('pos.promo.discount', { code: receipt.promoCode || '' })} value={`−${fmt(receipt.promoDiscountCents, store.currency)}`} />
        )}
        {(receipt.adjustments || []).map((a, i) => (
          <TotalsRow key={i} label={`${a.label}${a.code ? ` · ${a.code}` : ''}`} value={`−${fmt(a.cents, store.currency)}`} />
        ))}
        {receipt.loyaltyEarned > 0 && (
          <p className="mt-1 text-center text-xs font-medium text-accent">
            <Star size={11} className="mr-1 inline" />{t('pos.loyalty.earned', { n: receipt.loyaltyEarned })}
          </p>
        )}
        {lines.map((l) => (
          <TotalsRow key={l.name} label={`${l.name} (${l.rate}%)`} value={fmt(l.cents, store.currency)} />
        ))}
        {receipt.taxExempt && (
          <p className="my-1 text-center text-xs font-semibold text-accent">
            {receipt.orgType === 'obnl' ? t('pos.org.exemptNoteObnl') : t('pos.org.exemptNote')}
          </p>
        )}
        <TotalsRow label="Total" value={fmt(receipt.totalCents, store.currency)} big />
        <div className="my-3 border-t border-dashed border-osborder" />
        {receipt.method === 'cash' ? (
          <>
            <TotalsRow label="Cash tendered" value={fmt(receipt.tenderedCents, store.currency)} />
            <TotalsRow label="Change" value={fmt(receipt.changeCents, store.currency)} />
          </>
        ) : (
          <TotalsRow label="Paid by" value={METHOD_LABEL[receipt.method] || 'Card'} />
        )}
        {receipt.stockWarnings && receipt.stockWarnings.length > 0 && (
          <div className="mt-3 rounded-os border border-amber-500/50 bg-amber-500/10 p-3 text-xs text-ink">
            <p className="font-semibold">{t('pos.receipt.stockSyncWarn')}</p>
            <ul className="mt-1 list-disc pl-4">
              {receipt.stockWarnings.map((n, idx) => <li key={idx}>{n}</li>)}
            </ul>
          </div>
        )}
        <p className="mt-4 text-center text-xs text-muted">{t('pos.tabs2.thankYou')}</p>
        <div className="mt-3 flex justify-center">
          <div className="rounded-os border border-osborder bg-white p-2 text-center">
            <img src={qrDataUrl(receiptQrText({ sale: receipt, store }), { size: 120 })} alt="Scan for a digital receipt" width={120} height={120} />
            <p className="mt-1 text-[10px] text-muted">{t('pos.tabs2.scanReceipt')}</p>
          </div>
        </div>
      </div>
      <div className="mt-4 flex gap-2">
        <button
          type="button"
          onClick={doPrint}
          disabled={printBusy}
          className="flex flex-1 items-center justify-center gap-2 rounded-os border border-osborder bg-paper px-4 py-2.5 text-sm font-medium text-ink duration-160 hover:border-accent disabled:opacity-40"
        >
          <Printer size={16} /> {printBusy ? t('pos.ui.printing') : t('pos.ui.print')}
        </button>
        <button
          type="button"
          onClick={onClose}
          className="flex-1 rounded-os bg-accent px-4 py-2.5 text-sm font-semibold text-accentink duration-160 hover:opacity-90"
        >
          {t('pos.ui.newSale')}
        </button>
      </div>
      {printMsg && <p className="mt-2 text-center text-xs text-muted">{printMsg}</p>}
    </Modal>
  );
}
function ProductFormModal({ initial, v4, onClose, onSave }) {
  const { t } = useLang();
  const [name, setName] = useState(initial?.name || '');
  const [sku, setSku] = useState(initial?.sku || '');
  // ISBN auto-fill (Open Library, plain fetch — no new dependency).
  const [isbn, setIsbn] = useState(initial?.isbn || '');
  const [isbnBusy, setIsbnBusy] = useState(false);
  const [isbnMsg, setIsbnMsg] = useState('');

  const lookupIsbn = async () => {
    const digits = isbn.replace(/[^0-9Xx]/g, '');
    if (digits.length < 10) return setIsbnMsg(t('pos.isbn.invalid'));
    setIsbnBusy(true);
    setIsbnMsg('');
    try {
      const res = await fetch(`https://openlibrary.org/isbn/${digits}.json`);
      if (!res.ok) throw new Error('not found');
      const book = await res.json();
      const title = book.title || '';
      let author = '';
      if (Array.isArray(book.authors) && book.authors.length > 0) {
        const key = book.authors[0]?.key;
        if (key) {
          try {
            const ar = await fetch(`https://openlibrary.org${key}.json`);
            if (ar.ok) author = (await ar.json()).name || '';
          } catch {
            /* author lookup is best-effort */
          }
        }
      }
      if (title) setName(title);
      if (!category) setCategory(t('pos.isbn.defaultCategory'));
      setIsbnMsg(t('pos.isbn.found', { title: title || '—', author: author || '—' }));
    } catch {
      setIsbnMsg(t('pos.isbn.notFound'));
    } finally {
      setIsbnBusy(false);
    }
  };

  const [price, setPrice] = useState(initial ? (initial.priceCents / 100).toFixed(2) : '');
  const [category, setCategory] = useState(initial?.category || '');
  const [cost, setCost] = useState(initial?.costCents ? (initial.costCents / 100).toFixed(2) : '');
  const [trackStock, setTrackStock] = useState(!!initial?.trackStock);
  const [stock, setStock] = useState(initial ? String(initial.stock ?? 0) : '0');
  const [lowStockThreshold, setLowStockThreshold] = useState(initial ? String(initial.lowStockThreshold ?? 0) : '0');
  const [imageUrl, setImageUrl] = useState(initial?.imageUrl || '');
  const [variants, setVariants] = useState(
    (initial?.variants || []).map((v) => ({
      id: v.id,
      name: v.name,
      priceDelta: ((Number(v.priceDeltaCents) || 0) / 100).toFixed(2),
      sku: v.sku || '',
    }))
  );
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (!name.trim()) return setError(t('pos.productNameRequired'));
    const cents = Math.round((parseFloat(price) || 0) * 100);
    if (cents <= 0) return setError(t('pos.priceAboveZero'));
    // NUCLEAR FAILSAFE: sane upper bound. No book costs more than $10,000.
    // Prevents fat-finger errors (extra zeros) from creating absurd prices.
    if (cents > 1000000) return setError(t('pos.maxPriceError'));
    setBusy(true);
    try {
      await onSave({
        ...(initial || {}),
        name: name.trim(),
        sku: sku.trim(),
        isbn: isbn.replace(/[^0-9Xx]/g, ''),
        priceCents: cents,
        category: category.trim(),
        costCents: Math.round((parseFloat(cost) || 0) * 100),
        trackStock,
        stock: Math.max(0, Math.round(Number(stock) || 0)),
        lowStockThreshold: Math.max(0, Math.round(Number(lowStockThreshold) || 0)),
        imageUrl: imageUrl.trim(),
        variants: variants
          .filter((v) => v.name.trim())
          .map((v, i) => ({
            id: v.id || `v${Date.now()}${i}`,
            name: v.name.trim().slice(0, 40),
            priceDeltaCents: Math.round((parseFloat(v.priceDelta) || 0) * 100),
            sku: (v.sku || '').trim(),
          })),
      });
    } catch (err) {
      setError(err.message || t('err.saveProduct'));
      setBusy(false);
    }
  };

  const setVariant = (idx, patch) =>
    setVariants((vs) => vs.map((v, i) => (i === idx ? { ...v, ...patch } : v)));

  return (
    <Modal title={initial ? 'Edit product' : 'New product'} onClose={onClose} wide={v4}>
      <div className="space-y-3">
        <Field label="Name">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Blue T-shirt" autoFocus className={inputCls} />
        </Field>
        <div>
          <Field label={t('pos.isbn.label')}>
            <div className="flex gap-2">
              <input
                value={isbn}
                onChange={(e) => { setIsbn(e.target.value.replace(/[^0-9Xx\- ]/g, '')); setIsbnMsg(''); }}
                onKeyDown={(e) => { if (e.key === 'Enter') lookupIsbn(); }}
                placeholder="978…"
                inputMode="numeric"
                className={inputCls}
              />
              <button
                type="button"
                onClick={lookupIsbn}
                disabled={isbnBusy}
                className="shrink-0 rounded-os border border-osborder bg-paper px-3 py-2 text-sm font-medium text-ink duration-160 hover:border-accent disabled:opacity-60"
              >
                {isbnBusy ? '…' : t('pos.isbn.lookup')}
              </button>
            </div>
          </Field>
          {isbnMsg && <p className="mt-1 text-xs text-muted">{isbnMsg}</p>}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Price">
            <input value={price} onChange={(e) => setPrice(e.target.value.replace(/[^0-9.]/g, ''))} placeholder="0.00" inputMode="decimal" className={inputCls} />
          </Field>
          <Field label="SKU (optional)">
            <input value={sku} onChange={(e) => setSku(e.target.value)} placeholder="e.g. TSH-BLU-M" className={inputCls} />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Category (optional)">
            <input value={category} onChange={(e) => setCategory(e.target.value)} placeholder="e.g. Apparel" className={inputCls} />
          </Field>
          {v4 && (
            <Field label="Cost (for margin, optional)">
              <input value={cost} onChange={(e) => setCost(e.target.value.replace(/[^0-9.]/g, ''))} placeholder="0.00" inputMode="decimal" className={inputCls} />
            </Field>
          )}
        </div>

        {v4 && (
          <>
            <div className="rounded-os border border-osborder bg-paper/60 p-3">
              <label className="flex cursor-pointer items-center gap-2 text-sm font-medium text-ink">
                <input
                  type="checkbox"
                  checked={trackStock}
                  onChange={(e) => setTrackStock(e.target.checked)}
                  className="h-4 w-4 accent-[var(--accent)]"
                />
                {t('pos.ui.trackInventory')}
              </label>
              {trackStock && (
                <div className="mt-3 grid grid-cols-2 gap-3">
                  <Field label="Current stock">
                    <input value={stock} onChange={(e) => setStock(e.target.value.replace(/[^0-9]/g, ''))} inputMode="numeric" className={inputCls} />
                  </Field>
                  <Field label="Low-stock alert at">
                    <input value={lowStockThreshold} onChange={(e) => setLowStockThreshold(e.target.value.replace(/[^0-9]/g, ''))} inputMode="numeric" className={inputCls} />
                  </Field>
                </div>
              )}
            </div>

            <div className="rounded-os border border-osborder bg-paper/60 p-3">
              <div className="mb-2 flex items-center justify-between">
                <p className="text-sm font-medium text-ink">{t('pos.tabs2.variants')} <span className="font-normal text-muted">{t('pos.tabs2.variantsHint')}</span></p>
                <button
                  type="button"
                  onClick={() => setVariants((vs) => [...vs, { id: '', name: '', priceDelta: '0.00', sku: '' }])}
                  className="flex items-center gap-1 rounded-os border border-osborder px-2 py-1 text-xs font-medium text-ink hover:border-accent"
                >
                  <Plus size={13} /> {t('pos.ui.addOption')}
                </button>
              </div>
              {variants.length === 0 ? (
                <p className="text-xs text-muted">{t('pos.tabs2.noVariants')}</p>
              ) : (
                <div className="space-y-2">
                  {variants.map((v, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <input value={v.name} onChange={(e) => setVariant(i, { name: e.target.value })} placeholder="Option name" className={`${inputCls} flex-1`} />
                      <input value={v.priceDelta} onChange={(e) => setVariant(i, { priceDelta: e.target.value.replace(/[^0-9.\-]/g, '') })} placeholder="+0.00" inputMode="decimal" title="Price adjustment" className={`${inputCls} w-24 text-right`} />
                      <input value={v.sku} onChange={(e) => setVariant(i, { sku: e.target.value })} placeholder="SKU" className={`${inputCls} w-28`} />
                      <button type="button" onClick={() => setVariants((vs) => vs.filter((_, j) => j !== i))} className="rounded-os p-1.5 text-muted hover:text-accent" aria-label="Remove variant">
                        <Trash2 size={14} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <Field label="Image URL (optional)">
              <input value={imageUrl} onChange={(e) => setImageUrl(e.target.value)} placeholder="https://…" className={inputCls} />
            </Field>
          </>
        )}

        <ErrorNote message={error} />
        <button
          type="button"
          onClick={save}
          disabled={busy}
          className="w-full rounded-os bg-accent px-4 py-2.5 text-sm font-semibold text-accentink duration-160 hover:opacity-90 disabled:opacity-60"
        >
          {busy ? t('pos.ui.saving') : initial ? t('pos.ui.saveChanges') : t('pos.ui.addProduct')}
        </button>
      </div>
    </Modal>
  );
}

function ProductsTab({ store, products, v4, onSave, onDelete, onToggleActive, onAdjustStock }) {
  const { t } = useLang();
  const [query, setQuery] = useState('');
  const [lowOnly, setLowOnly] = useState(false);
  const [editing, setEditing] = useState(null); // null | 'new' | product
  const [confirmDelete, setConfirmDelete] = useState(null);

  const visible = products.filter((p) => {
    if (lowOnly && !(p.trackStock && p.lowStockThreshold > 0 && p.stock <= p.lowStockThreshold)) return false;
    const q = query.trim().toLowerCase();
    return !q || p.name.toLowerCase().includes(q) || (p.sku || '').toLowerCase().includes(q) || (p.category || '').toLowerCase().includes(q);
  });

  const isLow = (p) => v4 && p.trackStock && p.lowStockThreshold > 0 && p.stock <= p.lowStockThreshold;

  return (
    <div className="flex h-full flex-col">
      <div className="mb-3 flex gap-2">
        <div className="relative flex-1">
          <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search products…" className={`${inputCls} pl-9`} />
        </div>
        {v4 && (
          <button
            type="button"
            onClick={() => setLowOnly((v) => !v)}
            className={`rounded-os border px-3 py-2 text-sm font-medium duration-160 ${lowOnly ? 'border-accent bg-paper text-ink' : 'border-osborder bg-paper text-muted hover:text-ink'}`}
          >
            {t('pos.ui.lowStock')}
          </button>
        )}
        <button
          type="button"
          onClick={() => setEditing('new')}
          className="flex items-center gap-2 rounded-os bg-accent px-4 py-2 text-sm font-semibold text-accentink duration-160 hover:opacity-90"
        >
          <Plus size={16} /> {t('pos.ui.addProduct')}
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto rounded-os border border-osborder">
        {visible.length === 0 ? (
          <div className="p-6">
            <EmptyState
              icon={Tag}
              title={products.length === 0 ? t('pos.ui.noProducts') : t('pos.ui.noMatches')}
              body={products.length === 0 ? t('pos.ui.addFirstProductBody') : t('pos.ui.trySearch')}
              action={products.length === 0 ? (
                <button type="button" onClick={() => setEditing('new')} className="mt-4 rounded-os bg-accent px-4 py-2 text-sm font-semibold text-accentink hover:opacity-90">
                  {t('pos.ui.addFirstProduct')}
                </button>
              ) : null}
            />
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-paper">
              <tr className="text-left text-xs text-muted">
                <th className="px-4 py-2 font-medium">{t('pos.tabs2.name')}</th>
                <th className="px-4 py-2 font-medium">SKU</th>
                <th className="px-4 py-2 font-medium">{t('pos.tabs2.category')}</th>
                {v4 && <th className="px-4 py-2 text-center font-medium">{t('pos.tabs2.stock')}</th>}
                <th className="px-4 py-2 text-right font-medium">{t('pos.tabs2.price')}</th>
                <th className="px-4 py-2 text-center font-medium">{t('pos.tabs2.status')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('pos.tabs2.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((p) => (
                <tr key={p.id} className={`border-t border-osborder/60 ${p.active ? '' : 'opacity-50'} ${isLow(p) ? 'bg-accent/5' : ''}`}>
                  <td className="px-4 py-2.5 font-medium text-ink">
                    <span className="flex items-center gap-2">
                      {v4 && p.imageUrl && <img src={p.imageUrl} alt="" className="h-8 w-8 rounded-os object-cover" />}
                      <span>
                        {p.name}
                        {v4 && p.variants?.length > 0 && <span className="ml-1 text-xs font-normal text-muted">({p.variants.length} options)</span>}
                        {isLow(p) && <span className="ml-2 rounded-os bg-accent/15 px-1.5 py-0.5 text-xs font-semibold text-accent">{t('pos.tabs2.low')}</span>}
                      </span>
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-muted">{p.sku || '—'}</td>
                  <td className="px-4 py-2.5 text-muted">{p.category || '—'}</td>
                  {v4 && (
                    <td className="px-4 py-2.5 text-center">
                      {p.trackStock ? (
                        <span className="inline-flex items-center gap-1">
                          <button type="button" onClick={() => onAdjustStock(p, -1)} className="rounded-os p-2 text-muted hover:bg-paper hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" aria-label="Decrease stock">
                            <Minus size={13} />
                          </button>
                          <span className={`min-w-8 text-sm font-semibold ${isLow(p) ? 'text-accent' : 'text-ink'}`}>{p.stock}</span>
                          <button type="button" onClick={() => onAdjustStock(p, 1)} className="rounded-os p-2 text-muted hover:bg-paper hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" aria-label="Increase stock">
                            <Plus size={13} />
                          </button>
                        </span>
                      ) : (
                        <span className="text-xs text-muted">—</span>
                      )}
                    </td>
                  )}
                  <td className="px-4 py-2.5 text-right font-medium text-ink">{fmt(p.priceCents, store.currency)}</td>
                  <td className="px-4 py-2.5 text-center">
                    <button
                      type="button"
                      onClick={() => onToggleActive(p)}
                      title={p.active ? 'Hide from the sell screen' : 'Show on the sell screen'}
                      className={`rounded-os px-2 py-0.5 text-xs font-medium ${p.active ? 'bg-paper text-ink' : 'bg-osborder/40 text-muted'}`}
                    >
                      {p.active ? 'Active' : 'Hidden'}
                    </button>
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex justify-end gap-1">
                      <button type="button" onClick={() => setEditing(p)} className="rounded-os px-2 py-1 text-xs font-medium text-muted hover:bg-paper hover:text-ink">{t('pos.tabs2.edit')}</button>
                      <button type="button" onClick={() => setConfirmDelete(p)} className="rounded-os p-1 text-muted hover:bg-paper hover:text-accent" aria-label="Delete product">
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {editing && (
        <ProductFormModal
          initial={editing === 'new' ? null : editing}
          v4={v4}
          onClose={() => setEditing(null)}
          onSave={async (p) => { await onSave(p); setEditing(null); }}
        />
      )}
      {confirmDelete && (
        <Modal title={t('pos.ui.deleteProductTitle')} onClose={() => setConfirmDelete(null)}>
          <p className="text-sm text-muted">
            {t('pos.ui.deleteProductBody', { name: confirmDelete.name })}
          </p>
          <div className="mt-4 flex gap-2">
            <button type="button" onClick={() => setConfirmDelete(null)} className="flex-1 rounded-os border border-osborder bg-paper px-4 py-2 text-sm font-medium text-ink hover:border-accent">
              {t('pos.ui.keepIt')}
            </button>
            <button type="button" onClick={async () => { await onDelete(confirmDelete.id); setConfirmDelete(null); }} className="flex-1 rounded-os bg-accent px-4 py-2 text-sm font-semibold text-accentink hover:opacity-90">
              {t('common.delete')}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
function HistoryTab({ store, sales, memberName, onVoid, onRefund, onExchange, selfId, role, cashierName, extras, refundsOk, orgsOk }) {
  const { t } = useLang();
  const [query, setQuery] = useState('');
  const [confirmVoid, setConfirmVoid] = useState(null);
  const [voidReason, setVoidReason] = useState('');
  const [voidBusy, setVoidBusy] = useState(false);
  const [voidError, setVoidError] = useState('');
  const [voidWarnings, setVoidWarnings] = useState([]);
  const [viewReceipt, setViewReceipt] = useState(null);
  // Refunds / exchanges (local POS upgrades).
  const [refundFor, setRefundFor] = useState(null);
  const [refundSel, setRefundSel] = useState({}); // lineIndex -> qty
  const [refundMethod, setRefundMethod] = useState('cash');
  const [refundReason, setRefundReason] = useState('');
  const [refundBusy, setRefundBusy] = useState(false);
  const [refundResult, setRefundResult] = useState(null);
  // Synchronous double-submit lock: React state (refundBusy) flips too late
  // to stop a second click landing before the first RPC resolves. The
  // server RPC is also atomic, so a slipped duplicate is rejected — this
  // keeps the UX from showing a spurious error.
  const refundLock = useRef(false);
  // Idempotency key minted per refund dialog session: any retry, double
  // submit or racing duplicate within this dialog replays the original
  // result server-side instead of creating a second refund.
  const refundIdem = useRef(null);
  const [exchangeSel, setExchangeSel] = useState({});
  const manager = canManage(role);
  // Cashiers see only their own sales — never anyone else's, and never
  // store-wide figures. PIN cashiers share one Drift account on a shared
  // device, so they are scoped by cashier name; everyone else by user id.
  const ownOnly = role === 'cashier';
  const scopedSales = ownOnly
    ? sales.filter((s) => (cashierName ? s.cashierName === cashierName : s.createdBy === selfId))
    : sales;

  const liveSales = scopedSales.filter((s) => !s.voided);
  const visible = scopedSales.filter((s) => {
    const q = query.trim().toLowerCase();
    return !q || String(s.number).includes(q) || s.items.some((i) => i.name.toLowerCase().includes(q));
  });

  const today = todayKey();
  const todaySales = liveSales.filter((s) => todayKey(new Date(s.createdAt)) === today);
  const refundedOf = (s) => (s.refunds || []).reduce((sum, r) => sum + (r.refundedCents || 0), 0);
  const todayRefunded = todaySales.reduce((s, x) => s + refundedOf(x), 0);
  const todayNet = todaySales.reduce((s, x) => s + x.totalCents - refundedOf(x), 0);
  const allNet = liveSales.reduce((s, x) => s + x.totalCents - refundedOf(x), 0);

  const stats = ownOnly
    ? [
        { label: 'My sales today', value: String(todaySales.length) },
        { label: 'My gross today', value: fmt(todayNet, store.currency) },
        { label: 'My all-time gross', value: fmt(allNet, store.currency) },
      ]
    : [
        { label: "Today's sales", value: String(todaySales.length) },
        { label: "Today's gross", value: fmt(todayNet, store.currency) },
        { label: 'All-time gross', value: fmt(allNet, store.currency) },
      ];
  if (extras && todayRefunded > 0) {
    stats.push({ label: t('pos.refund.refundsToday'), value: fmt(todayRefunded, store.currency) });
  }

  const whoFor = (s) => s.cashierName || (s.createdBy ? memberName(s.createdBy) : null);

  // ---- refund helpers ----
  // Mirrors the backend's per-line refund key: productId::variantId::index.
  const refundKeyOf = (sale, idx) => {
    const it = sale.items[idx];
    return `${it?.productId || ''}::${it?.variantId || ''}::${idx}`;
  };
  const refundedQtyOf = (sale, idx) => {
    const key = refundKeyOf(sale, idx);
    return (sale.refunds || []).reduce(
      (n, r) => n + (r.lines || []).filter((l) => l.key === key).reduce((a, l) => a + l.qty, 0),
      0
    );
  };
  const openRefund = (sale) => {
    const sel = {};
    sale.items.forEach((it, idx) => {
      const remaining = it.qty - refundedQtyOf(sale, idx);
      if (remaining > 0) sel[idx] = remaining;
    });
    setRefundSel(sel);
    setExchangeSel({});
    setRefundMethod('cash');
    setRefundReason('');
    setRefundResult(null);
    refundIdem.current = (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID()
      : `refund-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setRefundFor(sale);
  };
  // Estimate mirrors backend.pos.refundSale: each line gets its net share of
  // the receipt total (discount + promo + tax allocated proportionally).
  const refundEstimate = () => {
    if (!refundFor) return 0;
    const netOf = (i) => i.priceCents * i.qty - (i.itemDiscountCents || 0);
    const sub = refundFor.items.reduce((s, i) => s + netOf(i), 0);
    if (sub <= 0) return 0;
    const selNet = Object.entries(refundSel).reduce(
      (s, [idx, qty]) => {
        const it = refundFor.items[Number(idx)];
        if (!it) return s;
        const remaining = it.qty - refundedQtyOf(refundFor, Number(idx));
        const q = Math.min(Number(qty) || 0, remaining);
        return s + Math.round((netOf(it) / it.qty) * q);
      },
      0
    );
    return Math.round((selNet / sub) * refundFor.totalCents);
  };
  const refundLines = () =>
    Object.entries(refundSel)
      .map(([idx, qty]) => ({ lineIndex: Number(idx), qty: Math.max(0, Math.round(Number(qty) || 0)) }))
      .filter((l) => l.qty > 0);
  const confirmRefund = async () => {
    const lines = refundLines();
    if (lines.length === 0 || refundLock.current) return;
    refundLock.current = true;
    setRefundBusy(true);
    try {
      const res = await onRefund({
        sale: refundFor,
        lines,
        method: refundMethod,
        reason: refundReason.trim(),
        idemKey: refundIdem.current,
      });
      if (res.creditNote?.code) {
        setRefundResult({ creditCode: res.creditNote.code, refundedCents: res.refund.refundedCents, warnings: res.warnings || [] });
      } else if ((res.warnings || []).length > 0) {
        setRefundResult({ refundedCents: res.refund.refundedCents, warnings: res.warnings || [] });
      } else {
        setRefundFor(null);
      }
    } catch (err) {
      setRefundResult({ error: err.message });
    } finally {
      setRefundBusy(false);
      refundLock.current = false;
    }
  };
  const confirmExchange = async () => {
    const lines = Object.entries(exchangeSel)
      .map(([idx, qty]) => ({ lineIndex: Number(idx), qty: Math.max(0, Math.round(Number(qty) || 0)) }))
      .filter((l) => l.qty > 0);
    if (lines.length === 0 || !refundFor || refundLock.current) return;
    refundLock.current = true;
    setRefundBusy(true);
    try {
      await onExchange({ sale: refundFor, lines, idemKey: refundIdem.current });
      setRefundFor(null);
    } finally {
      setRefundBusy(false);
      refundLock.current = false;
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="mb-3 grid grid-cols-3 gap-2">
        {stats.map((s) => (
          <div key={s.label} className="rounded-os border border-osborder bg-paper px-4 py-3">
            <p className="text-xs text-muted">{s.label}</p>
            <p className="text-xl font-bold text-ink">{s.value}</p>
          </div>
        ))}
      </div>
      <div className="mb-3">
        <div className="relative">
          <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search by sale # or item…" className={`${inputCls} pl-9`} />
        </div>
      </div>
      {voidWarnings.length > 0 && (
        <div className="mb-3 rounded-os border border-amber-300 bg-amber-50 p-3 text-xs text-amber-800">
          <div className="flex items-start justify-between gap-2">
            <p className="font-semibold">{t('pos.tabs2.voidStockWarn')}</p>
            <button type="button" onClick={() => setVoidWarnings([])} className="shrink-0 text-amber-600 hover:text-amber-800" aria-label="Dismiss">
              <X size={14} />
            </button>
          </div>
          <ul className="mt-1 list-disc space-y-0.5 pl-4">
            {voidWarnings.map((w, i) => <li key={i}>{w}</li>)}
          </ul>
        </div>
      )}
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
        {visible.length === 0 ? (
          <EmptyState icon={Receipt} title="No sales yet" body="Completed sales will show up here with totals, history, and voiding." />
        ) : (
          visible.map((s) => {
            const dt = new Date(s.createdAt);
            const who = whoFor(s);
            return (
              <div key={s.id} className={`rounded-os border border-osborder bg-paper px-4 py-3 ${s.voided ? 'opacity-60' : ''}`}>
                <div className="flex items-center justify-between">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-ink">
                      Sale #{s.number}
                      {s.voided && <span className="ml-2 rounded-os bg-osborder/50 px-2 py-0.5 text-xs font-medium text-muted">{t('pos.tabs2.voided')}</span>}
                      {refundsOk && !s.voided && refundedOf(s) > 0 && (
                        <span className="ml-2 rounded-os bg-accent/15 px-2 py-0.5 text-xs font-medium text-accent">
                          {s.fullyRefunded ? t('pos.refund.refundedBadge') : t('pos.refund.partialBadge')} −{fmt(refundedOf(s), store.currency)}
                        </span>
                      )}
                      {(orgsOk || extras) && s.taxExempt && (
                        <span className="ml-2 rounded-os bg-accent/15 px-2 py-0.5 text-xs font-medium text-accent">
                          {t('pos.org.exemptBadge')}
                        </span>
                      )}
                    </p>
                    <p className="text-xs text-muted">
                      {dt.toLocaleDateString(localeTag())} {dt.toLocaleTimeString(localeTag(), { hour: '2-digit', minute: '2-digit' })} · {METHOD_LABEL[s.method] || s.method} · {s.items.reduce((n, i) => n + i.qty, 0)} items
                      {who && ` · ${who}`}
                      {s.customerName && ` · ${s.customerName}`}
                      {s.orgName && ` · ${t('pos.org.billedTo')}: ${s.orgName}`}
                    </p>
                    <p className="mt-1 truncate text-xs text-muted">
                      {s.items.map((i) => `${i.qty}× ${i.name}${i.variantName ? ` (${i.variantName})` : ''}`).join(', ')}
                    </p>
                    {s.voided && s.voidReason && (
                      <p className="mt-1 text-xs text-muted">Reason: {s.voidReason}</p>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    <p className="text-lg font-bold text-ink">{fmt(s.totalCents, store.currency)}</p>
                    <button
                      type="button"
                      onClick={() => setViewReceipt(s)}
                      title="View receipt"
                      className="flex items-center gap-1 rounded-os border border-osborder px-2 py-1 text-xs font-medium text-muted hover:border-accent hover:text-ink"
                    >
                      <Printer size={12} /> {t('pos.ui.receiptBtn')}
                    </button>
                    {manager && !s.voided && (s.refunds || []).length === 0 && (
                      <button
                        type="button"
                        onClick={() => { setConfirmVoid(s); setVoidReason(''); }}
                        title={t('pos.ui.voidRefundTitle')}
                        className="flex items-center gap-1 rounded-os border border-osborder px-2 py-1 text-xs font-medium text-muted hover:border-accent hover:text-ink"
                      >
                        <RotateCcw size={12} /> {t('pos.ui.voidBtn')}
                      </button>
                    )}
                    {onRefund && manager && !s.voided && refundedOf(s) < s.totalCents && (
                      <button
                        type="button"
                        onClick={() => openRefund(s)}
                        className="flex items-center gap-1 rounded-os border border-osborder px-2 py-1 text-xs font-medium text-muted hover:border-accent hover:text-ink"
                      >
                        <Undo2 size={12} /> {t('pos.refund.button')}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
      {confirmVoid && (
        <Modal title={t('pos.ui.voidTitle', { number: confirmVoid.number })} onClose={() => { setConfirmVoid(null); setVoidError(''); }}>
          <p className="text-sm text-muted">
            {t('pos.ui.voidBody', { total: fmt(confirmVoid.totalCents, store.currency) })}
          </p>
          <ErrorNote message={voidError} />
          <div className="mt-3">
            <Field label={t('pos.ui.voidReasonLabel')}>
              <input
                value={voidReason}
                onChange={(e) => setVoidReason(e.target.value)}
                placeholder={t('pos.ui.voidReasonPh')}
                autoFocus
                className={inputCls}
              />
            </Field>
          </div>
          <div className="mt-4 flex gap-2">
            <button type="button" onClick={() => { setConfirmVoid(null); setVoidError(''); }} className="flex-1 rounded-os border border-osborder bg-paper px-4 py-2 text-sm font-medium text-ink hover:border-accent">
              {t('pos.ui.keepSale')}
            </button>
            <button
              type="button"
              disabled={voidBusy}
              onClick={async () => {
                setVoidBusy(true);
                setVoidError('');
                try {
                  const res = await onVoid(confirmVoid.id, voidReason.trim());
                  const warns = (res && res.warnings) || [];
                  if (warns.length > 0) {
                    setVoidWarnings(warns.map((w) => `${w.line || 'Item'}: ${w.issue || 'could not restock'}`));
                  }
                  setConfirmVoid(null);
                  setVoidReason('');
                } catch (err) {
                  // Keep the dialog open so the manager sees why the void
                  // did NOT happen (already voided, not a manager, offline…).
                  setVoidError(err?.message || t('err.voidFailed'));
                } finally {
                  setVoidBusy(false);
                }
              }}
              className="flex-1 rounded-os bg-accent px-4 py-2 text-sm font-semibold text-accentink hover:opacity-90 disabled:opacity-60"
            >
              {voidBusy ? t('pos.ui.voiding') : t('pos.ui.voidSale')}
            </button>
          </div>
        </Modal>
      )}
      {refundFor && (
        <Modal title={t('pos.refund.title', { number: refundFor.number })} onClose={() => setRefundFor(null)} wide>
          {refundResult?.error && <ErrorNote message={refundResult.error} />}
          {(refundResult?.warnings || []).length > 0 && (
            <div className="mb-3 rounded-os border border-amber-500/30 bg-amber-500/10 p-3">
              {(refundResult.warnings || []).map((w, i) => (
                <p key={i} className="text-xs text-amber-700 dark:text-amber-300">
                  {w.line ? `${w.line}: ` : ''}{w.issue}
                </p>
              ))}
            </div>
          )}
          {refundResult?.creditCode && (
            <div className="mb-3 rounded-os bg-accent/10 p-3 text-center">
              <p className="text-xs text-muted">{t('pos.refund.creditIssued')}</p>
              <p className="font-mono text-xl font-bold tracking-widest text-ink">{refundResult.creditCode}</p>
              <p className="mt-1 text-sm font-semibold text-ink">{fmt(refundResult.refundedCents, store.currency)}</p>
            </div>
          )}
          {!refundResult?.creditCode && refundResult?.refundedCents > 0 && (
            <div className="mb-3 rounded-os bg-accent/10 p-3 text-center">
              <p className="text-xs text-muted">{t('pos.refund.completed')}</p>
              <p className="mt-1 text-sm font-semibold text-ink">{fmt(refundResult.refundedCents, store.currency)}</p>
            </div>
          )}
          <p className="mb-2 text-xs text-muted">{t('pos.refund.pickLines')}</p>
          <div className="max-h-56 space-y-1.5 overflow-y-auto">
            {refundFor.items.map((it, idx) => {
              const remaining = it.qty - refundedQtyOf(refundFor, idx);
              if (remaining <= 0) return null;
              const sel = refundSel[idx] || 0;
              const ex = exchangeSel[idx] || 0;
              return (
                <div key={idx} className="flex items-center gap-2 rounded-os border border-osborder bg-paper px-3 py-2 text-sm">
                  <input
                    type="checkbox"
                    checked={sel > 0}
                    onChange={(e) => setRefundSel({ ...refundSel, [idx]: e.target.checked ? remaining : 0 })}
                    className="h-4 w-4 accent-[#b3541e]"
                  />
                  <span className="min-w-0 flex-1 truncate text-ink">
                    {it.name}{it.variantName ? ` (${it.variantName})` : ''}
                    <span className="ml-1 text-xs text-muted">×{remaining} {t('pos.refund.remaining')}</span>
                  </span>
                  {sel > 0 && (
                    <input
                      value={sel}
                      onChange={(e) => {
                        const q = Math.max(0, Math.min(remaining, Math.round(Number(e.target.value.replace(/[^0-9]/g, '')) || 0)));
                        setRefundSel({ ...refundSel, [idx]: q });
                      }}
                      inputMode="numeric"
                      className={`${inputCls} w-14 py-1 text-center`}
                    />
                  )}
                  <button
                    type="button"
                    onClick={() => setExchangeSel({ ...exchangeSel, [idx]: ex > 0 ? 0 : remaining })}
                    title={t('pos.refund.exchangeHint')}
                    className={`rounded-os border px-2 py-1 text-xs font-medium duration-160 ${ex > 0 ? 'border-accent bg-accent/10 text-accent' : 'border-osborder text-muted hover:border-accent hover:text-ink'}`}
                  >
                    <Repeat size={12} className="mr-1 inline" /> {t('pos.refund.exchange')}
                  </button>
                </div>
              );
            })}
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <Field label={t('pos.refund.method')}>
              <select value={refundMethod} onChange={(e) => setRefundMethod(e.target.value)} className={inputCls}>
                <option value="cash">{t('pos.refund.cashBack')}</option>
                <option value="credit">{t('pos.refund.toCredit')}</option>
              </select>
            </Field>
            <Field label={t('pos.refund.reason')}>
              <input value={refundReason} onChange={(e) => setRefundReason(e.target.value)} placeholder="…" className={inputCls} />
            </Field>
          </div>
          <div className="mt-2 rounded-os bg-paper p-3 text-center">
            <p className="text-xs text-muted">{t('pos.refund.estimate')}</p>
            <p className="text-2xl font-bold text-ink">{fmt(refundEstimate(), store.currency)}</p>
          </div>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={() => setRefundFor(null)}
              className="flex-1 rounded-os border border-osborder bg-paper px-4 py-2 text-sm font-medium text-ink hover:border-accent"
            >
              {t('common.cancel')}
            </button>
            <button
              type="button"
              disabled={refundBusy || refundLines().length === 0}
              onClick={confirmRefund}
              className="flex-1 rounded-os bg-accent px-4 py-2 text-sm font-semibold text-accentink duration-160 hover:opacity-90 disabled:opacity-60"
            >
              {refundBusy ? '…' : t('pos.refund.confirm', { amount: fmt(refundEstimate(), store.currency) })}
            </button>
            <button
              type="button"
              disabled={refundBusy || Object.values(exchangeSel).every((q) => !(q > 0))}
              onClick={confirmExchange}
              title={t('pos.refund.exchangeHint')}
              className="flex-1 rounded-os border border-accent bg-accent/10 px-4 py-2 text-sm font-semibold text-accent duration-160 hover:bg-accent/20 disabled:opacity-60"
            >
              <Repeat size={14} className="mr-1 inline" /> {t('pos.refund.exchange')}
            </button>
          </div>
        </Modal>
      )}
      {viewReceipt && (
        <ReceiptModal receipt={viewReceipt} store={store} onClose={() => setViewReceipt(null)} />
      )}
    </div>
  );
}
/* ------------------------------------------------------------------ */
/* Customers tab (v4)                                                  */
/* ------------------------------------------------------------------ */

function CustomerFormModal({ initial, onClose, onSave }) {
  const { t } = useLang();
  const [name, setName] = useState(initial?.name || '');
  const [phone, setPhone] = useState(initial?.phone || '');
  const [email, setEmail] = useState(initial?.email || '');
  const [notes, setNotes] = useState(initial?.notes || '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (!name.trim()) return setError(t('pos.customerNameRequired'));
    setBusy(true);
    try {
      await onSave({
        ...(initial || {}),
        name: name.trim(),
        phone: phone.trim(),
        email: email.trim(),
        notes: notes.trim(),
      });
    } catch (err) {
      setError(err.message || t('err.saveCustomer'));
      setBusy(false);
    }
  };

  return (
    <Modal title={initial ? 'Edit customer' : 'New customer'} onClose={onClose}>
      <div className="space-y-3">
        <Field label="Name">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Ada Lovelace" autoFocus className={inputCls} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Phone (optional)">
            <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="555-1234" className={inputCls} />
          </Field>
          <Field label="Email (optional)">
            <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="ada@example.com" className={inputCls} />
          </Field>
        </div>
        <Field label="Notes (optional)">
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} className={inputCls} />
        </Field>
        <ErrorNote message={error} />
        <button
          type="button"
          onClick={save}
          disabled={busy}
          className="w-full rounded-os bg-accent px-4 py-2.5 text-sm font-semibold text-accentink duration-160 hover:opacity-90 disabled:opacity-60"
        >
          {busy ? t('pos.ui.saving') : initial ? t('pos.ui.saveChanges') : t('pos.ui.addCustomer')}
        </button>
      </div>
    </Modal>
  );
}

function OrgFormModal({ initial, onClose, onSave }) {
  const { t } = useLang();
  const [name, setName] = useState(initial?.name || '');
  const [type, setType] = useState(initial?.type || 'entreprise');
  const [taxExempt, setTaxExempt] = useState(!!initial?.taxExempt);
  const [contact, setContact] = useState(initial?.contact || '');
  const [notes, setNotes] = useState(initial?.notes || '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (!name.trim()) return setError(t('pos.org.nameRequired'));
    setBusy(true);
    setError('');
    try {
      await onSave({
        ...(initial || {}),
        name: name.trim(),
        type,
        taxExempt,
        contact: contact.trim(),
        notes: notes.trim(),
      });
    } catch (err) {
      setError(err.message || t('pos.org.nameRequired'));
      setBusy(false);
    }
  };

  return (
    <Modal title={initial ? t('pos.org.edit') : t('pos.org.new')} onClose={onClose}>
      <div className="space-y-3">
        <Field label={t('pos.org.name')}>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('pos.org.name')} autoFocus className={inputCls} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('pos.org.type')}>
            <select value={type} onChange={(e) => setType(e.target.value)} className={inputCls}>
              <option value="entreprise">{t('pos.org.typeEntreprise')}</option>
              <option value="obnl">{t('pos.org.typeObnl')}</option>
              <option value="ecole">{t('pos.org.typeEcole')}</option>
              <option value="institution">{t('pos.org.typeInstitution')}</option>
            </select>
          </Field>
          <Field label={t('pos.org.contact')}>
            <input value={contact} onChange={(e) => setContact(e.target.value)} placeholder={t('pos.org.contact')} className={inputCls} />
          </Field>
        </div>
        <label className="flex cursor-pointer items-center gap-2 rounded-os border border-osborder bg-surface px-3 py-2.5 text-sm text-ink">
          <input
            type="checkbox"
            checked={taxExempt}
            onChange={(e) => setTaxExempt(e.target.checked)}
            className="h-4 w-4 accent-[#c96f3f]"
          />
          {t('pos.org.taxExempt')}
        </label>
        <Field label={t('pos.org.notes')}>
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} className={inputCls} />
        </Field>
        <ErrorNote message={error} />
        <button
          type="button"
          onClick={save}
          disabled={busy}
          className="w-full rounded-os bg-accent px-4 py-2.5 text-sm font-semibold text-accentink duration-160 hover:opacity-90 disabled:opacity-60"
        >
          {busy ? '…' : t('common.save')}
        </button>
      </div>
    </Modal>
  );
}

function OrgsPanel({ store, orgs, onOrgsChanged }) {
  const { t } = useLang();
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [error, setError] = useState('');

  const save = async (o) => {
    try {
      await backend.pos.saveOrg(store.id, o);
      if (onOrgsChanged) await onOrgsChanged();
      setEditing(null);
      setError('');
    } catch (err) {
      setError(err.message || t('pos.org.nameRequired'));
      throw err;
    }
  };

  const visible = (orgs || []).filter((o) => {
    const q = query.trim().toLowerCase();
    return !q || o.name.toLowerCase().includes(q) || (o.contact || '').toLowerCase().includes(q);
  });

  return (
    <div className="flex h-full flex-col">
      <ErrorNote message={error} />
      <div className="mb-3 flex gap-2">
        <div className="relative flex-1">
          <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('pos.org.name')} className={`${inputCls} pl-9`} />
        </div>
        <button
          type="button"
          onClick={() => setEditing('new')}
          className="flex items-center gap-2 rounded-os bg-accent px-4 py-2 text-sm font-semibold text-accentink duration-160 hover:opacity-90"
        >
          <Plus size={16} /> {t('pos.org.new')}
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pr-1">
        {visible.length === 0 ? (
          <EmptyState
            icon={Building2}
            title={t('pos.org.none')}
            body={t('pos.org.attach')}
            action={orgs.length === 0 ? (
              <button type="button" onClick={() => setEditing('new')} className="mt-4 rounded-os bg-accent px-4 py-2 text-sm font-semibold text-accentink hover:opacity-90">
                {t('pos.org.new')}
              </button>
            ) : null}
          />
        ) : (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {visible.map((o) => (
              <div key={o.id} className="rounded-os border border-osborder bg-paper p-4">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-ink">{o.name}</p>
                    <p className="text-xs text-muted">{orgTypeLabel(t, o.type)}</p>
                    {o.contact && <p className="truncate text-xs text-muted">{o.contact}</p>}
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <button type="button" onClick={() => setEditing(o)} className="rounded-os px-2 py-1 text-xs font-medium text-muted hover:bg-surface hover:text-ink">{t('pos.tabs2.edit')}</button>
                    <button type="button" onClick={() => setConfirmDelete(o)} className="rounded-os p-1 text-muted hover:text-accent" aria-label={t('pos.org.delete')}>
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
                {o.taxExempt && (
                  <p className="mt-2 inline-block rounded-os bg-accent/15 px-2 py-0.5 text-xs font-semibold text-accent">
                    {t('pos.org.exemptBadge')}
                  </p>
                )}
                {o.notes && <p className="mt-2 text-xs text-muted">{o.notes}</p>}
              </div>
            ))}
          </div>
        )}
      </div>
      {editing && (
        <OrgFormModal
          initial={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSave={save}
        />
      )}
      {confirmDelete && (
        <Modal title={t('pos.org.delete')} onClose={() => setConfirmDelete(null)}>
          <p className="text-sm text-muted">{t('pos.org.deleteConfirm')}</p>
          <div className="mt-4 flex gap-2">
            <button type="button" onClick={() => setConfirmDelete(null)} className="flex-1 rounded-os border border-osborder bg-paper px-4 py-2 text-sm font-medium text-ink hover:border-accent">
              {t('common.cancel')}
            </button>
            <button
              type="button"
              onClick={async () => {
                try {
                  await backend.pos.deleteOrg(store.id, confirmDelete.id);
                  if (onOrgsChanged) await onOrgsChanged();
                  setConfirmDelete(null);
                  setError('');
                } catch (err) {
                  setError(err.message);
                }
              }}
              className="flex-1 rounded-os bg-accent px-4 py-2 text-sm font-semibold text-accentink hover:opacity-90"
            >
              {t('pos.org.delete')}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function CustomersPanel({ store, customers, sales, onSave, onDelete, extras }) {
  const { t } = useLang();
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);

  const purchaseCount = useMemo(() => {
    const m = {};
    sales.forEach((s) => {
      if (!s.voided && s.customerId) m[s.customerId] = (m[s.customerId] || 0) + 1;
    });
    return m;
  }, [sales]);

  const visible = customers.filter((c) => {
    const q = query.trim().toLowerCase();
    return !q || c.name.toLowerCase().includes(q) || (c.phone || '').includes(q) || (c.email || '').toLowerCase().includes(q);
  });

  return (
    <div className="flex h-full flex-col">
      <div className="mb-3 flex gap-2">
        <div className="relative flex-1">
          <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search customers…" className={`${inputCls} pl-9`} />
        </div>
        <button
          type="button"
          onClick={() => setEditing('new')}
          className="flex items-center gap-2 rounded-os bg-accent px-4 py-2 text-sm font-semibold text-accentink duration-160 hover:opacity-90"
        >
          <UserPlus size={16} /> {t('pos.ui.addCustomer')}
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pr-1">
        {visible.length === 0 ? (
          <EmptyState
            icon={UserCheck}
            title={customers.length === 0 ? t('pos.ui.noCustomers') : t('pos.ui.noMatches')}
            body={t('pos.ui.customerEmptyBody')}
            action={customers.length === 0 ? (
              <button type="button" onClick={() => setEditing('new')} className="mt-4 rounded-os bg-accent px-4 py-2 text-sm font-semibold text-accentink hover:opacity-90">
                {t('pos.ui.addFirstCustomer')}
              </button>
            ) : null}
          />
        ) : (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {visible.map((c) => (
              <div key={c.id} className="rounded-os border border-osborder bg-paper p-4">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-ink">{c.name}</p>
                    {c.phone && <p className="text-xs text-muted">{c.phone}</p>}
                    {c.email && <p className="truncate text-xs text-muted">{c.email}</p>}
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <button type="button" onClick={() => setEditing(c)} className="rounded-os px-2 py-1 text-xs font-medium text-muted hover:bg-surface hover:text-ink">{t('pos.tabs2.edit')}</button>
                    <button type="button" onClick={() => setConfirmDelete(c)} className="rounded-os p-1 text-muted hover:text-accent" aria-label="Delete customer">
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
                {c.notes && <p className="mt-2 text-xs text-muted">{c.notes}</p>}
                <p className="mt-2 text-xs text-muted">
                  {purchaseCount[c.id] || 0} purchase{(purchaseCount[c.id] || 0) === 1 ? '' : 's'}
                </p>
                {extras && (c.points || 0) > 0 && (
                  <p className="mt-1 flex items-center gap-1 text-xs font-medium text-accent">
                    <Star size={12} /> {t('pos.loyalty.balance', { n: c.points })}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
      {editing && (
        <CustomerFormModal
          initial={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSave={async (c) => { await onSave(c); setEditing(null); }}
        />
      )}
      {confirmDelete && (
        <Modal title={t('pos.ui.deleteCustomerTitle')} onClose={() => setConfirmDelete(null)}>
          <p className="text-sm text-muted">
            {t('pos.ui.deleteCustomerBody', { name: confirmDelete.name })}
          </p>
          <div className="mt-4 flex gap-2">
            <button type="button" onClick={() => setConfirmDelete(null)} className="flex-1 rounded-os border border-osborder bg-paper px-4 py-2 text-sm font-medium text-ink hover:border-accent">
              {t('pos.ui.keep')}
            </button>
            <button type="button" onClick={async () => { await onDelete(confirmDelete.id); setConfirmDelete(null); }} className="flex-1 rounded-os bg-accent px-4 py-2 text-sm font-semibold text-accentink hover:opacity-90">
              {t('common.delete')}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function CustomersTab({ store, customers, sales, onSave, onDelete, extras, orgsOk, orgs, onOrgsChanged }) {
  const { t } = useLang();
  const [sub, setSub] = useState('customers'); // customers | orgs
  // The organization directory lights up when the pos_orgs backend exists
  // (carved out of posUpgrades like gift cards and refunds).
  if (!orgsOk) {
    return <CustomersPanel store={store} customers={customers} sales={sales} onSave={onSave} onDelete={onDelete} extras={extras} />;
  }
  return (
    <div className="flex h-full flex-col">
      <div className="mb-3 flex gap-1 rounded-os border border-osborder bg-surface p-1 text-sm">
        {[
          { id: 'customers', label: t('pos.tabs.customers'), icon: Users },
          { id: 'orgs', label: t('pos.org.title'), icon: Building2 },
        ].map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            onClick={() => setSub(id)}
            className={`flex flex-1 items-center justify-center gap-2 rounded-os px-3 py-1.5 font-medium duration-160 ${sub === id ? 'bg-paper text-ink shadow-sm' : 'text-muted hover:text-ink'}`}
          >
            <Icon size={14} /> {label}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1">
        {sub === 'customers' ? (
          <CustomersPanel store={store} customers={customers} sales={sales} onSave={onSave} onDelete={onDelete} extras={extras} />
        ) : (
          <OrgsPanel store={store} orgs={orgs} onOrgsChanged={onOrgsChanged} />
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Cash drawer tab (v4)                                                 */
/* ------------------------------------------------------------------ */

function DrawerTab({ store, sales, role, cashierName, extras }) {
  const { t } = useLang();
  const [shifts, setShifts] = useState(null);
  const [error, setError] = useState('');
  const [openAmount, setOpenAmount] = useState('');
  const [closing, setClosing] = useState(null);
  const [counted, setCounted] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  // Petty cash (local POS upgrade).
  const [movements, setMovements] = useState([]);
  const [pettyDir, setPettyDir] = useState('out');
  const [pettyAmount, setPettyAmount] = useState('');
  const [pettyReason, setPettyReason] = useState('');
  const [pettyBusy, setPettyBusy] = useState(false);
  const manager = canManage(role);

  const load = async () => {
    try {
      const results = await Promise.all([
        backend.pos.listDrawerShifts(store.id),
        extras ? backend.pos.listPettyCashMovements(store.id, { limit: 200 }) : Promise.resolve([]),
      ]);
      setShifts(results[0]);
      setMovements(results[1]);
      setError('');
    } catch (err) {
      setError(err.message || t('err.loadDrawerShifts'));
      setShifts([]);
    }
  };

  useEffect(() => { load(); }, [store.id, extras]);

  const openShift = shifts?.find((s) => !s.closedAt) || null;

  const cashSalesSince = (openedAt) => {
    const t = new Date(openedAt).getTime();
    return sales
      .filter((s) => !s.voided && s.method === 'cash' && new Date(s.createdAt).getTime() >= t)
      .reduce((sum, s) => sum + s.totalCents, 0);
  };

  const pettySince = (openedAt) => {
    const t = new Date(openedAt).getTime();
    return (movements || []).filter((m) => new Date(m.createdAt).getTime() >= t);
  };
  const pettyNetSince = (openedAt) =>
    pettySince(openedAt).reduce((s, m) => s + (m.direction === 'in' ? m.amountCents : -m.amountCents), 0);

  const addPetty = async () => {
    const cents = Math.round((parseFloat(pettyAmount) || 0) * 100);
    if (cents <= 0) return setError(t('pos.petty.amount') + ' > 0');
    if (!pettyReason.trim()) return setError(t('pos.petty.reason'));
    setPettyBusy(true);
    setError('');
    try {
      await backend.pos.addPettyCashMovement(store.id, {
        direction: pettyDir,
        amountCents: cents,
        reason: pettyReason.trim(),
        byName: cashierName || '',
      });
      setPettyAmount('');
      setPettyReason('');
      setMovements(await backend.pos.listPettyCashMovements(store.id, { limit: 200 }));
    } catch (err) {
      setError(err.message || t('pos.petty.title'));
    } finally {
      setPettyBusy(false);
    }
  };

  const doOpen = async () => {
    setBusy(true);
    setError('');
    try {
      await backend.pos.openDrawer(store.id, {
        amountCents: Math.round((parseFloat(openAmount) || 0) * 100),
        byName: cashierName || '',
      });
      setOpenAmount('');
      await load();
    } catch (err) {
      setError(err.message || t('err.openDrawer'));
    } finally {
      setBusy(false);
    }
  };

  const doClose = async () => {
    if (!closing) return;
    setBusy(true);
    setError('');
    try {
      const expected = closing.openAmountCents + cashSalesSince(closing.openedAt) + (extras ? pettyNetSince(closing.openedAt) : 0);
      await backend.pos.closeDrawer(store.id, closing.id, {
        amountCents: Math.round((parseFloat(counted) || 0) * 100),
        expectedCents: expected,
        note: note.trim(),
      });
      setClosing(null);
      setCounted('');
      setNote('');
      await load();
    } catch (err) {
      setError(err.message || t('err.closeDrawer'));
    } finally {
      setBusy(false);
    }
  };

  const expectedFor = (shift) => shift.openAmountCents + cashSalesSince(shift.openedAt) + (extras ? pettyNetSince(shift.openedAt) : 0);

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto pr-1">
      <ErrorNote message={error} />

      {shifts === null ? (
        <p className="text-sm text-muted">{t('pos.tabs2.loadingDrawer')}</p>
      ) : openShift ? (
        <div className="rounded-os border border-osborder bg-paper p-4">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-ink">
            <Wallet size={15} className="text-accent" /> {t('pos.ui.drawerOpen')}
          </h3>
          <div className="mt-3 grid grid-cols-3 gap-2 text-center">
            <div className="rounded-os bg-surface p-3">
              <p className="text-xs text-muted">{t('pos.tabs2.startingCash')}</p>
              <p className="text-lg font-bold text-ink">{fmt(openShift.openAmountCents, store.currency)}</p>
            </div>
            <div className="rounded-os bg-surface p-3">
              <p className="text-xs text-muted">{t('pos.tabs2.cashSales')}</p>
              <p className="text-lg font-bold text-ink">{fmt(cashSalesSince(openShift.openedAt), store.currency)}</p>
            </div>
            <div className="rounded-os bg-surface p-3">
              <p className="text-xs text-muted">{t('pos.tabs2.expectedNow')}</p>
              <p className="text-lg font-bold text-ink">{fmt(expectedFor(openShift), store.currency)}</p>
            </div>
          </div>
          <p className="mt-2 text-xs text-muted">
            Opened {new Date(openShift.openedAt).toLocaleString(localeTag())}{openShift.openedByName ? ` by ${openShift.openedByName}` : ''}
          </p>
          {manager && (
            <button
              type="button"
              onClick={() => { setClosing(openShift); setCounted(''); setNote(''); }}
              className="mt-3 rounded-os bg-accent px-4 py-2 text-sm font-semibold text-accentink duration-160 hover:opacity-90"
            >
              {t('pos.ui.countCloseDrawer')}
            </button>
          )}
        </div>
      ) : (
        <div className="rounded-os border border-osborder bg-paper p-4">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-ink">
            <Wallet size={15} className="text-accent" /> {t('pos.ui.openDrawer')}
          </h3>
          <p className="mt-1 text-sm text-muted">{t('pos.tabs2.countCashNote')}</p>
          <div className="mt-3 flex max-w-xs items-center gap-2">
            <Field label={`Starting cash (${store.currency})`}>
              <input
                value={openAmount}
                onChange={(e) => setOpenAmount(e.target.value.replace(/[^0-9.]/g, ''))}
                placeholder="0.00"
                inputMode="decimal"
                className={inputCls}
              />
            </Field>
            <button
              type="button"
              onClick={doOpen}
              disabled={busy}
              className="mt-5 shrink-0 rounded-os bg-accent px-4 py-2 text-sm font-semibold text-accentink duration-160 hover:opacity-90 disabled:opacity-60"
            >
              {busy ? 'Opening…' : 'Open'}
            </button>
          </div>
        </div>
      )}

      {extras && (
        <section className="rounded-os border border-osborder bg-paper p-4">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-ink">
            <HandCoins size={15} className="text-accent" /> {t('pos.petty.title')}
          </h3>
          <div className="mt-3 flex flex-wrap items-end gap-2">
            <div className="flex rounded-os bg-surface p-1">
              {['out', 'in'].map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => setPettyDir(d)}
                  className={`rounded-os px-3 py-1.5 text-xs font-medium duration-160 ${pettyDir === d ? 'bg-paper text-ink shadow-os' : 'text-muted hover:text-ink'}`}
                >
                  {t(`pos.petty.${d}`)}
                </button>
              ))}
            </div>
            <Field label={`${t('pos.petty.amount')} (${store.currency})`}>
              <input
                value={pettyAmount}
                onChange={(e) => setPettyAmount(e.target.value.replace(/[^0-9.]/g, ''))}
                placeholder="0.00"
                inputMode="decimal"
                className={`${inputCls} w-28`}
              />
            </Field>
            <Field label={t('pos.petty.reason')}>
              <input
                value={pettyReason}
                onChange={(e) => setPettyReason(e.target.value)}
                placeholder="…"
                className={`${inputCls} w-44`}
              />
            </Field>
            <button
              type="button"
              onClick={addPetty}
              disabled={pettyBusy}
              className="rounded-os bg-accent px-4 py-2 text-sm font-semibold text-accentink duration-160 hover:opacity-90 disabled:opacity-60"
            >
              {pettyBusy ? '…' : t('pos.petty.add')}
            </button>
          </div>
          {movements.length > 0 && (
            <div className="mt-3 max-h-40 space-y-1 overflow-y-auto">
              {movements.slice(0, 20).map((m) => (
                <div key={m.id} className="flex items-center justify-between rounded-os bg-surface px-3 py-1.5 text-xs">
                  <span className="min-w-0 truncate text-muted">
                    {new Date(m.createdAt).toLocaleString(localeTag())} · {m.reason}
                    {m.byName && ` · ${m.byName}`}
                  </span>
                  <span className={`shrink-0 font-semibold ${m.direction === 'in' ? 'text-ink' : 'text-accent'}`}>
                    {m.direction === 'in' ? '+' : '−'}{fmt(m.amountCents, store.currency)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      <section>
        <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold text-ink">
          <CalendarDays size={15} className="text-accent" /> {t('pos.ui.pastCounts')}
        </h3>
        {(shifts || []).filter((s) => s.closedAt).length === 0 ? (
          <p className="text-sm text-muted">{t('pos.tabs2.noClosedCounts')}</p>
        ) : (
          <div className="space-y-2">
            {(shifts || []).filter((s) => s.closedAt).map((s) => {
              const variance = s.closeAmountCents - (s.expectedCents ?? s.closeAmountCents);
              return (
                <div key={s.id} className="flex items-center justify-between rounded-os border border-osborder bg-paper px-4 py-2.5">
                  <div>
                    <p className="text-sm font-medium text-ink">
                      {new Date(s.closedAt).toLocaleDateString(localeTag())} {new Date(s.closedAt).toLocaleTimeString(localeTag(), { hour: '2-digit', minute: '2-digit' })}
                    </p>
                    <p className="text-xs text-muted">
                      Opened {fmt(s.openAmountCents, store.currency)} → counted {fmt(s.closeAmountCents, store.currency)}
                      {s.expectedCents != null && ` · expected ${fmt(s.expectedCents, store.currency)}`}
                      {s.note && ` · ${s.note}`}
                    </p>
                  </div>
                  {s.expectedCents != null && (
                    <span className={`rounded-os px-2 py-1 text-sm font-semibold ${variance === 0 ? 'text-ink' : variance > 0 ? 'bg-paper text-accent' : 'bg-accent/10 text-accent'}`}>
                      {variance === 0 ? 'Even' : `${variance > 0 ? '+' : '−'}${fmt(Math.abs(variance), store.currency)}`}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      {closing && (
        <Modal title="Close the drawer" onClose={() => setClosing(null)}>
          <div className="space-y-3">
            <div className="rounded-os bg-paper p-3 text-center">
              <p className="text-xs text-muted">{t('pos.tabs2.expectedInDrawer')}</p>
              <p className="text-2xl font-bold text-ink">{fmt(expectedFor(closing), store.currency)}</p>
              <p className="mt-1 text-xs text-muted">
                {fmt(closing.openAmountCents, store.currency)} starting + {fmt(cashSalesSince(closing.openedAt), store.currency)} cash sales
              </p>
            </div>
            <Field label={`Counted cash (${store.currency})`}>
              <input
                value={counted}
                onChange={(e) => setCounted(e.target.value.replace(/[^0-9.]/g, ''))}
                placeholder="0.00"
                inputMode="decimal"
                autoFocus
                className={`${inputCls} text-right text-lg font-semibold`}
              />
            </Field>
            <Field label="Note (optional)">
              <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. $20 drop to safe" className={inputCls} />
            </Field>
            {counted && (
              <p className={`text-center text-sm font-semibold ${
                Math.round((parseFloat(counted) || 0) * 100) - expectedFor(closing) === 0 ? 'text-ink' : 'text-accent'
              }`}>
                Variance: {(() => {
                  const v = Math.round((parseFloat(counted) || 0) * 100) - expectedFor(closing);
                  return v === 0 ? 'Even' : `${v > 0 ? '+' : '−'}${fmt(Math.abs(v), store.currency)}`;
                })()}
              </p>
            )}
            <button
              type="button"
              onClick={doClose}
              disabled={busy}
              className="w-full rounded-os bg-accent px-4 py-2.5 text-sm font-semibold text-accentink duration-160 hover:opacity-90 disabled:opacity-60"
            >
              {busy ? 'Closing…' : 'Close drawer'}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Reports tab (manager+)                                               */
/* ------------------------------------------------------------------ */

function ReportsTab({ store, sales, memberName, extras }) {
  const { t } = useLang();
  const [range, setRange] = useState('today'); // today | 7 | 30

  const cutoff = useMemo(() => {
    const d = new Date();
    if (range === 'today') {
      d.setHours(0, 0, 0, 0);
      return d;
    }
    d.setDate(d.getDate() - (range === '7' ? 7 : 30));
    d.setHours(0, 0, 0, 0);
    return d;
  }, [range]);

  const live = useMemo(
    () => sales.filter((s) => !s.voided && new Date(s.createdAt) >= cutoff),
    [sales, cutoff]
  );

  const totals = useMemo(() => {
    let gross = 0, discounts = 0, tax = 0, items = 0, refunds = 0;
    live.forEach((s) => {
      const refunded = (s.refunds || []).reduce((a, r) => a + (r.refundedCents || 0), 0);
      refunds += refunded;
      gross += s.totalCents - refunded;
      discounts += s.discountCents + (s.promoDiscountCents || 0) + s.items.reduce((n, i) => n + (i.itemDiscountCents || 0), 0);
      tax += s.taxCents;
      items += s.items.reduce((n, i) => n + i.qty, 0);
    });
    return { gross, discounts, tax, items, refunds, count: live.length, avg: live.length ? Math.round(gross / live.length) : 0 };
  }, [live]);

  // Acomba/QuickBooks-shaped journal export (date, account, debit, credit,
  // description). Balanced double-entry per sale; refunds post as returns.
  const exportCsv = () => {
    const money = (c) => (c / 100).toFixed(2);
    const rows = [['date', 'account', 'debit', 'credit', 'description']];
    const payAccount = (s) =>
      s.method === 'card' ? '1020 - Banque / Bank' : s.method === 'other' ? '1030 - Autres paiements / Other' : '1000 - Caisse / Cash';
    const dt = (iso) => new Date(iso).toISOString().slice(0, 10);
    live.forEach((s) => {
      const date = dt(s.createdAt);
      const adj = (s.adjustments || []).reduce((a, x) => a + (x.cents || 0), 0);
      // Tax-exempt sales are distinguishable in the journal: dedicated
      // revenue account + explicit marker on every line of the entry.
      const exemptTag = s.taxExempt ? ' (exonéré / tax exempt)' : '';
      const label = `Vente / Sale #${s.number}${exemptTag}`;
      const isLiabilitySale = s.items.some((i) => String(i.productId || '').startsWith('giftcard:') || String(i.productId || '').startsWith('deposit:'));
      const revenueAcct = s.taxExempt
        ? '4001 - Ventes exonérées / Exempt sales'
        : isLiabilitySale ? '2110 - Cartes-cadeaux et acomptes / Gift cards & deposits' : '4000 - Ventes / Sales';
      const netOfTax = s.totalCents - s.taxCents;
      rows.push([date, payAccount(s), money(s.totalCents - adj), '0.00', label]);
      if (adj > 0) rows.push([date, '2110 - Cartes-cadeaux et acomptes / Gift cards & deposits', money(adj), '0.00', `${label} (${t('pos.refund.refunded')})`]);
      if (netOfTax > 0) rows.push([date, revenueAcct, '0.00', money(netOfTax), label]);
      if (s.taxCents > 0) rows.push([date, '2100 - TPS/TVQ à payer / Sales tax payable', '0.00', money(s.taxCents), label]);
      (s.refunds || []).forEach((r) => {
        const rlabel = `${t('pos.refund.title', { n: s.number })} — ${r.reason || ''}`.trim();
        rows.push([dt(r.createdAt), '4000 - Ventes (retours) / Sales returns', money(r.refundedCents), '0.00', rlabel]);
        rows.push([dt(r.createdAt), payAccount(s), '0.00', money(r.refundedCents), rlabel]);
      });
    });
    const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `journal-${range}-${todayKey()}.csv`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 100);
  };

  const byDay = useMemo(() => {
    const m = {};
    live.forEach((s) => {
      const k = todayKey(new Date(s.createdAt));
      const refunded = (s.refunds || []).reduce((a, r) => a + (r.refundedCents || 0), 0);
      m[k] = (m[k] || 0) + s.totalCents - refunded;
    });
    return Object.entries(m).sort(([a], [b]) => (a < b ? -1 : 1));
  }, [live]);
  const dayMax = Math.max(1, ...byDay.map(([, v]) => v));

  const topProducts = useMemo(() => {
    const m = {};
    live.forEach((s) => {
      s.items.forEach((i) => {
        const label = i.variantName ? `${i.name} (${i.variantName})` : i.name;
        const e = m[label] || { qty: 0, revenue: 0 };
        e.qty += i.qty;
        e.revenue += i.priceCents * i.qty - (i.itemDiscountCents || 0);
        m[label] = e;
      });
    });
    return Object.entries(m)
      .sort(([, a], [, b]) => b.revenue - a.revenue)
      .slice(0, 8);
  }, [live]);

  const byMethod = useMemo(() => {
    const m = {};
    live.forEach((s) => {
      const k = s.method || 'cash';
      const e = m[k] || { count: 0, total: 0 };
      e.count += 1;
      e.total += s.totalCents;
      m[k] = e;
    });
    return m;
  }, [live]);

  const byStaff = useMemo(() => {
    const m = {};
    live.forEach((s) => {
      const k = s.cashierName || (s.createdBy ? memberName(s.createdBy) : null) || '—';
      const e = m[k] || { count: 0, total: 0 };
      e.count += 1;
      e.total += s.totalCents;
      m[k] = e;
    });
    return Object.entries(m).sort(([, a], [, b]) => b.total - a.total);
  }, [live, memberName]);

  const cards = [
    { label: 'Gross sales', value: fmt(totals.gross, store.currency), icon: TrendingUp },
    { label: 'Transactions', value: String(totals.count), icon: Receipt },
    { label: 'Average ticket', value: fmt(totals.avg, store.currency), icon: CircleDollarSign },
    { label: 'Items sold', value: String(totals.items), icon: Package },
    { label: 'Discounts given', value: fmt(totals.discounts, store.currency), icon: Percent },
    { label: 'Tax collected', value: fmt(totals.tax, store.currency), icon: Hash },
  ];
  if (totals.refunds > 0) {
    cards.splice(1, 0, { label: t('pos.refund.refundsToday'), value: `−${fmt(totals.refunds, store.currency)}`, icon: Undo2 });
  }

  return (
    <div className="h-full overflow-y-auto pr-1">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {[
          { id: 'today', label: 'Today' },
          { id: '7', label: 'Last 7 days' },
          { id: '30', label: 'Last 30 days' },
        ].map((r) => (
          <button
            key={r.id}
            type="button"
            onClick={() => setRange(r.id)}
            className={`rounded-os border px-3 py-1.5 text-sm font-medium duration-160 ${range === r.id ? 'border-accent bg-paper text-ink' : 'border-osborder bg-paper text-muted hover:text-ink'}`}
          >
            {r.label}
          </button>
        ))}
        {extras && (
          <button
            type="button"
            onClick={exportCsv}
            className="ml-auto flex items-center gap-1.5 rounded-os border border-osborder bg-paper px-3 py-1.5 text-sm font-medium text-ink duration-160 hover:border-accent"
          >
            <FileDown size={14} /> {t('pos.acct.export')}
          </button>
        )}
      </div>

      <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        {cards.map((c) => (
          <div key={c.label} className="rounded-os border border-osborder bg-paper px-3 py-3">
            <p className="flex items-center gap-1.5 text-xs text-muted"><c.icon size={13} /> {c.label}</p>
            <p className="mt-1 text-lg font-bold text-ink">{c.value}</p>
          </div>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="rounded-os border border-osborder bg-paper p-4">
          <h3 className="mb-3 text-sm font-semibold text-ink">{t('pos.tabs2.salesByDay')}</h3>
          {byDay.length === 0 ? (
            <p className="text-sm text-muted">{t('pos.tabs2.noSales')}</p>
          ) : (
            <div className="space-y-2">
              {byDay.map(([day, v]) => (
                <div key={day} className="flex items-center gap-2 text-sm">
                  <span className="w-20 shrink-0 text-xs text-muted">
                    {new Date(`${day}T12:00:00`).toLocaleDateString(localeTag(), { month: 'short', day: 'numeric' })}
                  </span>
                  <div className="h-5 flex-1 overflow-hidden rounded-os bg-surface">
                    <div className="h-full rounded-os bg-accent" style={{ width: `${Math.max(3, (v / dayMax) * 100)}%` }} />
                  </div>
                  <span className="w-20 shrink-0 text-right font-medium text-ink">{fmt(v, store.currency)}</span>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="rounded-os border border-osborder bg-paper p-4">
          <h3 className="mb-3 text-sm font-semibold text-ink">{t('pos.tabs2.topProducts')}</h3>
          {topProducts.length === 0 ? (
            <p className="text-sm text-muted">{t('pos.tabs2.noSales')}</p>
          ) : (
            <div className="space-y-2">
              {topProducts.map(([name, e], i) => (
                <div key={name} className="flex items-center justify-between text-sm">
                  <span className="min-w-0 truncate text-ink"><span className="mr-2 text-xs text-muted">{i + 1}.</span>{name}</span>
                  <span className="ml-3 shrink-0 text-muted">{e.qty} sold · <span className="font-medium text-ink">{fmt(e.revenue, store.currency)}</span></span>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="rounded-os border border-osborder bg-paper p-4">
          <h3 className="mb-3 text-sm font-semibold text-ink">{t('pos.tabs2.byPayMethod')}</h3>
          {Object.keys(byMethod).length === 0 ? (
            <p className="text-sm text-muted">{t('pos.tabs2.noSales')}</p>
          ) : (
            <div className="space-y-2">
              {Object.entries(byMethod).map(([m, e]) => (
                <div key={m} className="flex items-center justify-between text-sm">
                  <span className="text-ink">{METHOD_LABEL[m] || m}</span>
                  <span className="text-muted">{e.count} sale{e.count === 1 ? '' : 's'} · <span className="font-medium text-ink">{fmt(e.total, store.currency)}</span></span>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="rounded-os border border-osborder bg-paper p-4">
          <h3 className="mb-3 text-sm font-semibold text-ink">{t('pos.tabs2.byStaff')}</h3>
          {byStaff.length === 0 ? (
            <p className="text-sm text-muted">{t('pos.tabs2.noSales')}</p>
          ) : (
            <div className="space-y-2">
              {byStaff.map(([name, e]) => (
                <div key={name} className="flex items-center justify-between text-sm">
                  <span className="text-ink">{name}</span>
                  <span className="text-muted">{e.count} sale{e.count === 1 ? '' : 's'} · <span className="font-medium text-ink">{fmt(e.total, store.currency)}</span></span>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
      <p className="mt-4 text-xs text-muted">{t('pos.tabs2.salesLoadedNote', { count: sales.length })}</p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Staff PINs (v4) — shared-device cashier login                        */
/* ------------------------------------------------------------------ */

function StaffFormModal({ initial, onClose, onSave }) {
  const { t } = useLang();
  const [name, setName] = useState(initial?.name || '');
  const [role, setRole] = useState(initial?.role || 'cashier');
  const [pin, setPin] = useState('');
  const [active, setActive] = useState(initial?.active !== false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (!name.trim()) return setError(t('pos.staffNameRequired'));
    if ((pin || !initial) && !/^\d{4,8}$/.test(pin)) return setError(t('pos.pinDigits'));
    setBusy(true);
    try {
      await onSave({
        ...(initial || {}),
        name: name.trim(),
        role,
        active,
        ...(pin ? { pin } : {}),
      });
    } catch (err) {
      setError(err.message || t('err.saveStaff'));
      setBusy(false);
    }
  };

  return (
    <Modal title={initial ? 'Edit staff' : 'New staff'} onClose={onClose}>
      <div className="space-y-3">
        <Field label="Name">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Sam Rivera" autoFocus className={inputCls} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Role">
            <select value={role} onChange={(e) => setRole(e.target.value)} className={inputCls}>
              <option value="cashier">{t('pos.tabs2.cashier')}</option>
              <option value="manager">{t('pos.tabs2.manager')}</option>
            </select>
          </Field>
          <Field label={initial ? 'New PIN (blank = keep)' : 'PIN (4–8 digits)'}>
            <input
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/[^0-9]/g, '').slice(0, 8))}
              placeholder="••••"
              inputMode="numeric"
              type="password"
              className={inputCls}
            />
          </Field>
        </div>
        <label className="flex cursor-pointer items-center gap-2 text-sm text-ink">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} className="h-4 w-4 accent-[var(--accent)]" />
          {t('pos.ui.staffActiveHint')}
        </label>
        <ErrorNote message={error} />
        <button
          type="button"
          onClick={save}
          disabled={busy}
          className="w-full rounded-os bg-accent px-4 py-2.5 text-sm font-semibold text-accentink duration-160 hover:opacity-90 disabled:opacity-60"
        >
          {busy ? t('pos.ui.saving') : initial ? t('pos.ui.saveChanges') : t('pos.ui.addStaff')}
        </button>
      </div>
    </Modal>
  );
}

function StaffPinSection({ store, canManageStaff }) {
  const { t } = useLang();
  const [staff, setStaff] = useState(null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);

  const load = async () => {
    try {
      setStaff(await backend.pos.listStaff(store.id));
      setError('');
    } catch (err) {
      setError(err.message || t('err.loadStaff'));
      setStaff([]);
    }
  };

  useEffect(() => { load(); }, [store.id]);

  const save = async (s) => {
    await backend.pos.saveStaff(store.id, s);
    await load();
  };

  const remove = async (id) => {
    await backend.pos.deleteStaff(store.id, id);
    await load();
  };

  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-ink">
          <KeyRound size={15} className="text-accent" /> Staff PINs · {(staff || []).length}
        </h3>
        {canManageStaff && (
          <button
            type="button"
            onClick={() => setEditing('new')}
            className="flex items-center gap-1.5 rounded-os bg-accent px-3 py-1.5 text-xs font-semibold text-accentink duration-160 hover:opacity-90"
          >
            <Plus size={13} /> {t('pos.ui.addStaff')}
          </button>
        )}
      </div>
      <ErrorNote message={error} />
      <p className="mb-2 text-xs text-muted">
        {t('pos.ui.staffPinExplainer')}
      </p>
      {staff === null ? (
        <p className="text-sm text-muted">{t('pos.tabs2.loadingStaff')}</p>
      ) : staff.length === 0 ? (
        <p className="rounded-os border border-dashed border-osborder bg-paper/50 px-4 py-6 text-center text-sm text-muted">
          {t('pos.ui.staffEmpty')}
        </p>
      ) : (
        <div className="space-y-2">
          {staff.map((m) => (
            <div key={m.id} className={`flex items-center gap-3 rounded-os border border-osborder bg-paper px-4 py-2.5 ${m.active ? '' : 'opacity-50'}`}>
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-os bg-accent/15 text-sm font-bold text-accent">
                {m.name.slice(0, 1).toUpperCase()}
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-ink">{m.name}</p>
                <p className="text-xs text-muted">{ROLE_LABEL[m.role] || m.role}{m.active ? '' : ' · inactive'}</p>
              </div>
              {canManageStaff && (
                <>
                  <button type="button" onClick={() => setEditing(m)} className="rounded-os px-2 py-1 text-xs font-medium text-muted hover:bg-surface hover:text-ink">{t('pos.tabs2.edit')}</button>
                  <button type="button" onClick={() => setConfirmDelete(m)} className="rounded-os p-1.5 text-muted hover:text-accent" aria-label="Delete staff">
                    <Trash2 size={15} />
                  </button>
                </>
              )}
            </div>
          ))}
        </div>
      )}
      {editing && (
        <StaffFormModal
          initial={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSave={async (s) => { await save(s); setEditing(null); }}
        />
      )}
      {confirmDelete && (
        <Modal title={t('pos.ui.removeStaffTitle', { name: confirmDelete.name })} onClose={() => setConfirmDelete(null)}>
          <p className="text-sm text-muted">
            {t('pos.ui.staffDeleteNote')}
          </p>
          <div className="mt-4 flex gap-2">
            <button type="button" onClick={() => setConfirmDelete(null)} className="flex-1 rounded-os border border-osborder bg-paper px-4 py-2 text-sm font-medium text-ink hover:border-accent">
              {t('common.cancel')}
            </button>
            <button type="button" onClick={async () => { await remove(confirmDelete.id); setConfirmDelete(null); }} className="flex-1 rounded-os bg-accent px-4 py-2 text-sm font-semibold text-accentink hover:opacity-90">
              {t('pos.ui.remove')}
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}
function TeamTab({ store, members, selfId, v4, onInvite, onRevokeInvite, onSetRole, onRemove, onLeave }) {
  const { t } = useLang();
  const [invites, setInvites] = useState(null);
  const [inviteRole, setInviteRole] = useState('cashier');
  const [newCode, setNewCode] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(null);
  const manager = canManage(store.role);
  const isOwner = store.role === 'owner';

  // UX guard for demotions/removals/leaves: the DB trigger
  // (pos_members_guard_owner) still enforces "at least one owner", but we
  // catch it here first so the user sees a friendly message instead of a
  // raw database error. Covers both local and cloud paths.
  const otherOwnersRemain = (userId) =>
    members.some((m) => m.role === 'owner' && m.userId !== userId);
  const blockIfLastOwner = (member) => {
    if (member.role === 'owner' && !otherOwnersRemain(member.userId)) {
      setError(
        'This store needs at least one owner — promote someone else to owner first, then try again.'
      );
      return true; // blocked
    }
    return false;
  };

  useEffect(() => {
    let cancelled = false;
    if (manager) {
      backend.pos.listInvites(store.id).then((list) => {
        if (!cancelled) setInvites(list);
      }).catch(() => { if (!cancelled) setInvites([]); });
    }
    return () => { cancelled = true; };
  }, [store.id, manager]);

  const createInvite = async () => {
    setBusy(true);
    setError('');
    try {
      const invite = await onInvite(inviteRole);
      setNewCode(invite.code);
      const list = await backend.pos.listInvites(store.id);
      setInvites(list);
    } catch (err) {
      setError(err.message || t('err.createInvite'));
    } finally {
      setBusy(false);
    }
  };

  const copyCode = async (code) => {
    try {
      await navigator.clipboard.writeText(code);
    } catch {
      /* clipboard unavailable — the code is visible to copy by hand */
    }
  };

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto pr-1">
      <ErrorNote message={error} />

      {/* Members */}
      <section>
        <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold text-ink">
          <Users size={15} className="text-accent" /> Team · {members.length} member{members.length === 1 ? '' : 's'}
        </h3>
        <div className="space-y-2">
          {members.map((m) => (
            <div key={m.userId} className="flex items-center gap-3 rounded-os border border-osborder bg-paper px-4 py-2.5">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-os bg-accent/15 text-sm font-bold text-accent">
                {(m.username || '?').slice(0, 1).toUpperCase()}
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-ink">
                  {m.username}
                  {m.userId === selfId && <span className="ml-2 text-xs text-muted">{t('pos.tabs2.youBadge')}</span>}
                </p>
                <p className="text-xs text-muted">{ROLE_LABEL[m.role] || m.role}</p>
              </div>
              {isOwner && m.userId !== selfId && (
                <select
                  value={m.role}
                  onChange={(e) => {
                    const next = e.target.value;
                    if (next !== m.role && blockIfLastOwner(m)) return;
                    onSetRole(m.userId, next).catch((err) => setError(err.message));
                  }}
                  className="rounded-os border border-osborder bg-surface px-2 py-1 text-xs text-ink"
                  title="Change role"
                >
                  <option value="owner">{t('pos.tabs2.owner')}</option>
                  <option value="manager">{t('pos.tabs2.manager')}</option>
                  <option value="cashier">{t('pos.tabs2.cashier')}</option>
                </select>
              )}
              {(m.userId === selfId || isOwner) && (
                <button
                  type="button"
                  onClick={() => setConfirmRemove(m)}
                  title={m.userId === selfId ? 'Leave this store' : 'Remove from team'}
                  aria-label={m.userId === selfId ? 'Leave this store' : `Remove ${m.username} from team`}
                  className="rounded-os p-1.5 text-muted hover:bg-surface hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                >
                  {m.userId === selfId ? <LogOut size={15} /> : <Trash2 size={15} />}
                </button>
              )}
            </div>
          ))}
        </div>
      </section>

      {/* Staff PINs (shared-device cashier login) */}
      {v4 && <StaffPinSection store={store} canManageStaff={manager} />}

      {/* Invites */}
      {manager && (
        <section>
          <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold text-ink">
            <Ticket size={15} className="text-accent" /> {t('pos.ui.inviteCodes')}
          </h3>
          <div className="rounded-os border border-osborder bg-paper p-4">
            <p className="text-sm text-muted">
              {t('pos.ui.inviteExplainer')}
            </p>
            <div className="mt-3 flex gap-2">
              <select value={inviteRole} onChange={(e) => setInviteRole(e.target.value)} className={`${inputCls} w-36`}>
                <option value="cashier">{t('pos.tabs2.cashier')}</option>
                <option value="manager">{t('pos.tabs2.manager')}</option>
              </select>
              <button
                type="button"
                onClick={createInvite}
                disabled={busy}
                className="flex items-center gap-2 rounded-os bg-accent px-4 py-2 text-sm font-semibold text-accentink duration-160 hover:opacity-90 disabled:opacity-60"
              >
                <Plus size={15} /> {busy ? 'Creating…' : 'New invite code'}
              </button>
            </div>
            {newCode && (
              <div className="mt-3 flex items-center justify-between rounded-os bg-surface px-4 py-3">
                <div>
                  <p className="text-xs text-muted">{t('pos.tabs2.shareCode')}</p>
                  <p className="font-mono text-2xl font-bold tracking-widest text-ink">{newCode}</p>
                </div>
                <button
                  type="button"
                  onClick={() => copyCode(newCode)}
                  className="flex items-center gap-1.5 rounded-os border border-osborder bg-paper px-3 py-1.5 text-sm text-ink hover:border-accent"
                >
                  <Copy size={14} /> {t('pos.gift.copy')}
                </button>
              </div>
            )}
            {invites && invites.length > 0 && (
              <div className="mt-3 space-y-1.5">
                {invites.map((inv) => (
                  <div key={inv.id} className="flex items-center justify-between rounded-os bg-surface px-3 py-2 text-sm">
                    <span className="font-mono font-semibold tracking-wider text-ink">{inv.code}</span>
                    <span className="text-xs text-muted">
                      {ROLE_LABEL[inv.role]} · used {inv.uses}{inv.maxUses ? `/${inv.maxUses}` : '×'}
                      {inv.expiresAt ? ` · expires ${new Date(inv.expiresAt).toLocaleDateString(localeTag())}` : ''}
                    </span>
                    <button
                      type="button"
                      onClick={async () => {
                        try {
                          await onRevokeInvite(inv.id);
                          setInvites(await backend.pos.listInvites(store.id));
                        } catch (err) {
                          setError(err.message || t('err.revokeInvite'));
                        }
                      }}
                      className="min-h-[36px] rounded-os px-2 text-xs font-medium text-muted hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                    >
                      {t('pos.ui.revoke')}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="mt-3 flex items-start gap-2 text-xs text-muted">
            <Crown size={13} className="mt-0.5 shrink-0" />
            <span>{t('pos.tabs2.ownerNote')}</span>
          </div>
        </section>
      )}

      {confirmRemove && (
        <Modal
          title={confirmRemove.userId === selfId ? 'Leave this store?' : `Remove ${confirmRemove.username}?`}
          onClose={() => setConfirmRemove(null)}
        >
          <p className="text-sm text-muted">
            {confirmRemove.userId === selfId
              ? 'You will lose access to this store’s catalog and sales history on all your devices.'
              : `${confirmRemove.username} will lose access to this store immediately.`}
          </p>
          <div className="mt-4 flex gap-2">
            <button type="button" onClick={() => setConfirmRemove(null)} className="flex-1 rounded-os border border-osborder bg-paper px-4 py-2 text-sm font-medium text-ink hover:border-accent">
              {t('common.cancel')}
            </button>
            <button
              type="button"
              onClick={async () => {
                try {
                  if (blockIfLastOwner(confirmRemove)) {
                    setConfirmRemove(null);
                    return;
                  }
                  if (confirmRemove.userId === selfId) await onLeave();
                  else await onRemove(confirmRemove.userId);
                } catch (err) {
                  setError(err.message || t('err.removeMember'));
                }
                setConfirmRemove(null);
              }}
              className="flex-1 rounded-os bg-accent px-4 py-2 text-sm font-semibold text-accentink hover:opacity-90"
            >
              {confirmRemove.userId === selfId ? 'Leave store' : 'Remove'}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Promotions management (local POS upgrade)                             */
/* ------------------------------------------------------------------ */

function PromosSection({ store }) {
  const { t } = useLang();
  const [promos, setPromos] = useState(null);
  const [form, setForm] = useState(null); // null | {…}
  const [error, setError] = useState('');

  const load = async () => {
    setPromos(null);
    try {
      setPromos(await backend.pos.listPromos(store.id));
    } catch (err) {
      setError(err.message);
      setPromos([]);
    }
  };
  useEffect(() => { load(); }, []);

  const startNew = () =>
    setForm({ id: null, code: '', name: '', type: 'percent', value: '', active: true, startsAt: '', endsAt: '' });
  const startEdit = (p) =>
    setForm({
      id: p.id,
      code: p.code || '',
      name: p.name || '',
      type: p.type || 'percent',
      value: p.type === 'fixed' ? (p.value / 100).toFixed(2) : String(p.value ?? ''),
      active: p.active !== false,
      startsAt: p.startsAt ? p.startsAt.slice(0, 10) : '',
      endsAt: p.endsAt ? p.endsAt.slice(0, 10) : '',
    });

  const save = async () => {
    const code = form.code.trim().toUpperCase();
    if (!code) return setError(t('pos.promo.code'));
    const value = form.type === 'bogo' ? 0 : parseFloat(form.value) || 0;
    if (form.type !== 'bogo' && value <= 0) return setError(t('pos.promo.value'));
    setError('');
    try {
      await backend.pos.savePromo(store.id, {
        id: form.id,
        code,
        name: form.name.trim(),
        type: form.type,
        value,
        active: form.active,
        startsAt: form.startsAt ? new Date(`${form.startsAt}T00:00:00`).toISOString() : null,
        endsAt: form.endsAt ? new Date(`${form.endsAt}T23:59:59`).toISOString() : null,
      });
      setForm(null);
      await load();
    } catch (err) {
      setError(err.message);
    }
  };

  const remove = async (id) => {
    if (!window.confirm(t('common.confirmDelete'))) return;
    try {
      await backend.pos.deletePromo(store.id, id);
      await load();
    } catch (err) {
      setError(err.message);
    }
  };

  const typeLabel = (p) =>
    p.type === 'percent' ? `${p.value}%` : p.type === 'fixed' ? fmt(Math.round(p.value * 100), store.currency) : t('pos.promo.typeBogo');

  return (
    <div className="space-y-3 rounded-os border border-osborder bg-paper p-4">
      <div className="flex items-center justify-between">
        <p className="flex items-center gap-2 text-sm font-semibold text-ink">
          <Tag size={15} className="text-accent" /> {t('pos.promo.manage')}
        </p>
        {!form && (
          <button
            type="button"
            onClick={startNew}
            className="rounded-os bg-accent px-3 py-1.5 text-xs font-semibold text-accentink duration-160 hover:opacity-90"
          >
            <Plus size={13} className="mr-1 inline" /> {t('pos.promo.new')}
          </button>
        )}
      </div>
      <ErrorNote message={error} />
      {form ? (
        <div className="space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <Field label={t('pos.promo.code')}>
              <input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })} placeholder="ETE2026" autoFocus className={`${inputCls} font-mono uppercase`} />
            </Field>
            <Field label={t('pos.promo.name')}>
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="…" className={inputCls} />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Field label={t('pos.promo.type')}>
              <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })} className={inputCls}>
                <option value="percent">{t('pos.promo.typePercent')}</option>
                <option value="fixed">{t('pos.promo.typeFixed')}</option>
                <option value="bogo">{t('pos.promo.typeBogo')}</option>
              </select>
            </Field>
            <Field label={t('pos.promo.value')}>
              <input
                value={form.value}
                onChange={(e) => setForm({ ...form, value: e.target.value.replace(/[^0-9.]/g, '') })}
                placeholder={form.type === 'percent' ? '10' : '5.00'}
                inputMode="decimal"
                disabled={form.type === 'bogo'}
                className={inputCls}
              />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Field label={t('pos.promo.startsAt')}>
              <input type="date" value={form.startsAt} onChange={(e) => setForm({ ...form, startsAt: e.target.value })} className={inputCls} />
            </Field>
            <Field label={t('pos.promo.endsAt')}>
              <input type="date" value={form.endsAt} onChange={(e) => setForm({ ...form, endsAt: e.target.value })} className={inputCls} />
            </Field>
          </div>
          <label className="flex cursor-pointer items-center gap-2 text-sm text-ink">
            <input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} className="accent-accent" />
            {t('pos.promo.active')}
          </label>
          <div className="flex gap-2 pt-1">
            <button type="button" onClick={() => setForm(null)} className="flex-1 rounded-os border border-osborder bg-surface px-3 py-2 text-sm text-ink">
              {t('common.cancel')}
            </button>
            <button type="button" onClick={save} className="flex-1 rounded-os bg-accent px-3 py-2 text-sm font-semibold text-accentink duration-160 hover:opacity-90">
              {t('common.save')}
            </button>
          </div>
        </div>
      ) : promos === null ? (
        <p className="text-sm text-muted">{t('common.loading')}</p>
      ) : promos.length === 0 ? (
        <p className="text-sm text-muted">{t('pos.promo.none')}</p>
      ) : (
        <div className="space-y-1.5">
          {promos.map((p) => (
            <div key={p.id} className={`flex items-center justify-between rounded-os bg-surface px-3 py-2 ${p.active === false ? 'opacity-60' : ''}`}>
              <div className="min-w-0">
                <p className="text-sm font-semibold text-ink">
                  <span className="font-mono">{p.code}</span>
                  <span className="ml-2 font-normal text-muted">{p.name || ''}</span>
                </p>
                <p className="text-xs text-muted">{typeLabel(p)}</p>
              </div>
              <div className="flex shrink-0 gap-1">
                <button type="button" onClick={() => startEdit(p)} className="rounded-os p-1.5 text-muted hover:text-ink" aria-label={t('common.edit')}>
                  <Edit2 size={14} />
                </button>
                <button type="button" onClick={() => remove(p.id)} className="rounded-os p-1.5 text-muted hover:text-accent" aria-label={t('common.delete')}>
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Settings tab (manager+)                                             */
/* ------------------------------------------------------------------ */

/* Receipt printer & cash drawer (manager+). Hardware config is stored on
 * this device only (localStorage per store) — it describes the machine's
 * printer, not the cloud account. */
function PrinterSettingsSection({ store }) {
  const { t } = useLang();
  const [cfg, setCfg] = useState(() => getPrinterConfig(store.id));
  const [caps] = useState(() => transportCapabilities());
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [qzPrinters, setQzPrinters] = useState(null);

  useEffect(() => {
    setCfg(getPrinterConfig(store.id));
    setQzPrinters(null);
    setStatus('');
  }, [store.id]);

  const update = (patch) => setCfg((c) => savePrinterConfig(store.id, { ...c, ...patch }));

  const runTest = async () => {
    setBusy(true);
    setStatus('');
    try {
      const res = await testPrint({ store, config: cfg });
      setStatus(res.via === 'browser'
        ? t('pos.tabs2.testSentDialog')
        : t('pos.tabs2.testSentBytes', { bytes: res.bytes, copies: res.copies > 1 ? ` × ${res.copies}` : '' }));
    } catch (err) {
      setStatus(t('pos.tabs2.testFailed', { err: err?.message || err }));
    } finally {
      setBusy(false);
    }
  };

  const kickDrawer = async () => {
    setBusy(true);
    setStatus('');
    try {
      const res = await openCashDrawer({ store, config: cfg });
      setStatus(t('pos.tabs2.drawerKicked', { via: res.via }));
    } catch (err) {
      setStatus(t('pos.tabs2.drawerFailed', { err: err?.message || err }));
    } finally {
      setBusy(false);
    }
  };

  const findQzPrinters = async () => {
    setBusy(true);
    setStatus('');
    try {
      const list = await qzTransport.listPrinters();
      setQzPrinters(list);
      setStatus(list.length === 0 ? t('pos.tabs2.qzNoPrinters') : t('pos.tabs2.qzFound', { n: list.length, s: list.length === 1 ? '' : 's' }));
    } catch (err) {
      setStatus(t('pos.tabs2.qzFailed', { err: err?.message || err }));
    } finally {
      setBusy(false);
    }
  };

  const Toggle = ({ label, hint, value, onChange }) => (
    <label className="flex cursor-pointer items-start gap-2.5 rounded-os border border-osborder bg-paper/60 px-3 py-2.5">
      <input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} className="mt-0.5 accent-accent" />
      <span>
        <span className="block text-sm font-medium text-ink">{label}</span>
        {hint && <span className="block text-xs text-muted">{hint}</span>}
      </span>
    </label>
  );

  return (
    <div className="space-y-3 rounded-os border border-osborder bg-paper p-4">
      <div className="flex items-center gap-2">
        <Printer size={16} className="text-muted" />
        <p className="text-sm font-semibold text-ink">{t('pos.tabs2.printerTitle')}</p>
      </div>
      <p className="text-[11px] text-muted">{t('pos.tabs2.printerAutoSave')}</p>

      <label className="block">
        <span className="mb-1 block text-xs font-medium text-muted">{t('pos.tabs2.connection')}</span>
        <select value={cfg.transport} onChange={(e) => update({ transport: e.target.value })} className={inputCls}>
          {Object.entries(caps).map(([id, c]) => (
            <option key={id} value={id} disabled={!c.supported}>
              {c.label}{c.supported ? '' : t('pos.tabs2.notAvailableHere')}
            </option>
          ))}
        </select>
      </label>
      <p className="text-xs text-muted">{caps[cfg.transport]?.hint}</p>
      {cfg.transport === 'browser' && (
        <p className="text-xs text-muted">
          {t('pos.ui.drawerExplainer')}
        </p>
      )}

      <div className="grid grid-cols-2 gap-2">
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-muted">{t('pos.tabs2.paperWidth')}</span>
          <select value={cfg.paperWidth} onChange={(e) => update({ paperWidth: Number(e.target.value) })} className={inputCls}>
            <option value={80}>80 mm</option>
            <option value={58}>58 mm</option>
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-muted">{t('pos.tabs2.copies')}</span>
          <select value={cfg.copies} onChange={(e) => update({ copies: Number(e.target.value) })} className={inputCls}>
            {[1, 2, 3].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
      </div>

      {cfg.transport === 'serial' && (
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-muted">{t('pos.tabs2.baudRate')}</span>
          <select value={cfg.baudRate} onChange={(e) => update({ baudRate: Number(e.target.value) })} className={inputCls}>
            {[9600, 19200, 38400, 115200].map((b) => <option key={b} value={b}>{b}</option>)}
          </select>
        </label>
      )}

      {cfg.transport === 'qz' && (
        <div className="space-y-2">
          <div className="flex gap-2">
            <input
              value={cfg.qzPrinterName}
              onChange={(e) => update({ qzPrinterName: e.target.value })}
              placeholder="Printer name as QZ Tray sees it"
              className={`${inputCls} flex-1`}
            />
            <button type="button" onClick={findQzPrinters} disabled={busy} className="shrink-0 rounded-os border border-osborder px-3 py-2 text-sm font-medium text-ink hover:border-accent disabled:opacity-40">
              {t('pos.ui.findPrinters')}
            </button>
          </div>
          {qzPrinters && qzPrinters.length > 0 && (
            <select value={cfg.qzPrinterName} onChange={(e) => update({ qzPrinterName: e.target.value })} className={inputCls}>
              <option value="">{t('pos.tabs2.choosePrinter')}</option>
              {qzPrinters.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          )}
          <p className="text-xs text-muted">
            {t('pos.ui.qzHint')}
          </p>
        </div>
      )}

      {(cfg.transport === 'webusb' || cfg.transport === 'serial') && (
        <p className="text-xs text-muted">
          {t('pos.ui.browserPickHint')}
        </p>
      )}

      <div className="space-y-2">
        <Toggle label="Print a receipt after every sale" hint="Sends the receipt as soon as the sale completes." value={cfg.autoPrint} onChange={(v) => update({ autoPrint: v })} />
        <Toggle label="Pop the cash drawer on cash sales" hint="Kicks the drawer through the printer's DK port." value={cfg.autoDrawerCash} onChange={(v) => update({ autoDrawerCash: v })} />
      </div>

      <div className="grid grid-cols-2 gap-2">
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-muted">{t('pos.tabs2.drawerPort')}</span>
          <select value={cfg.drawerPin} onChange={(e) => update({ drawerPin: Number(e.target.value) })} className={inputCls}>
            <option value={0}>{t('pos.tabs2.dkPin1')}</option>
            <option value={1}>{t('pos.tabs2.dkPin2')}</option>
          </select>
        </label>
      </div>

      <label className="block">
        <span className="mb-1 block text-xs font-medium text-muted">{t('pos.tabs2.receiptHeader')}</span>
        <input value={cfg.header} onChange={(e) => update({ header: e.target.value })} placeholder="Address, phone…" className={inputCls} />
      </label>
      <label className="block">
        <span className="mb-1 block text-xs font-medium text-muted">{t('pos.tabs2.receiptFooter')}</span>
        <input value={cfg.footer} onChange={(e) => update({ footer: e.target.value })} className={inputCls} />
      </label>

      <div className="flex gap-2">
        <button type="button" onClick={runTest} disabled={busy} className="flex flex-1 items-center justify-center gap-2 rounded-os border border-osborder px-3 py-2 text-sm font-medium text-ink hover:border-accent disabled:opacity-40">
          <Printer size={15} /> {busy ? 'Working…' : 'Test print'}
        </button>
        <button type="button" onClick={kickDrawer} disabled={busy} className="flex flex-1 items-center justify-center gap-2 rounded-os border border-osborder px-3 py-2 text-sm font-medium text-ink hover:border-accent disabled:opacity-40">
          <Wallet size={15} /> {busy ? 'Working…' : 'Open drawer'}
        </button>
      </div>
      {status && <p className="text-xs text-muted">{status}</p>}
    </div>
  );
}

function SettingsTabPane({ store, v4, onSave, extras }) {
  const { t, lang } = useLang();
  const [name, setName] = useState(store.name);
  const [taxRate, setTaxRate] = useState(String(store.taxRate));
  const [taxRates, setTaxRates] = useState(store.taxRates || []);
  const [presetId, setPresetId] = useState('custom');
  const [currency, setCurrency] = useState(store.currency);
  const [loyaltyPerDollar, setLoyaltyPerDollar] = useState(String(store.loyaltyPointsPerDollar ?? 0));
  const [loyaltyValue, setLoyaltyValue] = useState(
    store.loyaltyPointsValueCents ? (store.loyaltyPointsValueCents / 100).toFixed(2) : ''
  );
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const isOwner = store.role === 'owner';

  // Match saved rows against a preset so the picker reflects what's stored.
  // defaultRate matters for the "No tax" preset: it only matches when the
  // legacy fallback rate is 0 too, otherwise the shop still charges tax.
  const matchPreset = (rows, defaultRate) => {
    if (rows == null) return 'custom';
    const sig = (rs) =>
      JSON.stringify(
        (rs || [])
          .filter((r) => Number(r.rate) > 0)
          .map((r) => [Number(r.rate), r.compound === true])
      );
    const hit = TAX_PRESETS.find((p) => {
      if (p.rates === null) return false;
      if (sig(p.rates) !== sig(rows)) return false;
      if (p.rates.length === 0)
        return (rows || []).filter((r) => Number(r.rate) > 0).length === 0 && Number(defaultRate) === 0;
      // Accept the preset's names in either UI language — the rows are stored
      // with the names of whichever language was active when the preset was
      // applied.
      const known = new Set();
      p.rates.forEach((r) => {
        known.add(String(r.name || '').trim().toUpperCase());
        if (r.nameFr) known.add(String(r.nameFr).trim().toUpperCase());
      });
      return (rows || [])
        .filter((r) => Number(r.rate) > 0)
        .every((r) => known.has(String(r.name || '').trim().toUpperCase()));
    });
    return hit ? hit.id : 'custom';
  };

  // Dirty tracking: the POS auto-syncs store settings from the server every
  // minute (so tax-rate changes propagate to all terminals). That sync must
  // never clobber unsaved edits in this form — skip the re-read below while
  // the form differs from the last-loaded store. Row comparison is
  // key-order-insensitive (DB JSON round-trips don't guarantee key order).
  const normRows = (rows) =>
    JSON.stringify(
      (rows || []).map((r) => [String(r.name || ''), Number(r.rate) || 0, r.compound === true])
    );
  const dirtyRef = useRef(false);
  dirtyRef.current =
    name !== store.name ||
    taxRate !== String(store.taxRate) ||
    normRows(taxRates) !== normRows(store.taxRates) ||
    currency !== store.currency ||
    loyaltyPerDollar !== String(store.loyaltyPointsPerDollar ?? 0) ||
    loyaltyValue !== (store.loyaltyPointsValueCents ? (store.loyaltyPointsValueCents / 100).toFixed(2) : '');

  useEffect(() => {
    // Don't wipe unsaved edits when the background settings auto-sync
    // delivers a fresh store object.
    if (dirtyRef.current) return;
    setName(store.name);
    setTaxRate(String(store.taxRate));
    setTaxRates(store.taxRates || []);
    setPresetId(matchPreset(store.taxRates, store.taxRate));
    setCurrency(store.currency);
    setLoyaltyPerDollar(String(store.loyaltyPointsPerDollar ?? 0));
    setLoyaltyValue(store.loyaltyPointsValueCents ? (store.loyaltyPointsValueCents / 100).toFixed(2) : '');
    // Depend on the store object (not just store.id) so server-normalized
    // values are re-read into the form after a save. Store identity is
    // stable across re-renders; it only changes when the store is updated.
  }, [store]);

  const setTaxRow = (idx, patch) => {
    setPresetId('custom');
    setTaxRates((rows) => rows.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  };

  const applyPreset = (id) => {
    setPresetId(id);
    const p = TAX_PRESETS.find((x) => x.id === id);
    if (p && p.rates !== null) {
      setTaxRates(p.rates.map((r) => ({ name: presetRateName(r, lang), rate: String(r.rate), compound: !!r.compound })));
      // A preset fully defines the shop's taxes, so the legacy default rate
      // must not linger underneath it — otherwise "No tax" would still charge
      // the old default rate on every sale.
      setTaxRate('0');
    }
  };

  const save = async () => {
    if (saving) return;
    setError('');
    setSaving(true);
    try {
      await onSave({
        name: name.trim() || store.name,
        taxRate: parseFloat(taxRate) || 0,
        currency: currency.trim() || '$',
        loyaltyPointsPerDollar: Math.max(0, parseFloat(loyaltyPerDollar) || 0),
        loyaltyPointsValueCents: Math.max(0, Math.round((parseFloat(loyaltyValue) || 0) * 100)),
        taxRates: taxRates
          .map((t) => ({
            name: String(t.name || '').trim().slice(0, 24) || 'Tax',
            rate: Number(t.rate) || 0,
            compound: t.compound === true,
          }))
          .filter((t) => t.rate > 0),
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(err.message || t('err.saveSettings'));
    } finally {
      setSaving(false);
    }
  };

  // Preset update process: if the shop's STORED rates match a superseded preset
  // definition, invite an owner/manager to review the corrected rates.
  // Nothing changes until they explicitly press Save.
  const outdatedPreset = outdatedPresetFor(store.taxRates);
  const showPresetUpdate =
    outdatedPreset &&
    canManage(store.role) &&
    matchPreset(taxRates, taxRate) !== outdatedPreset.id;

  return (
    <div className="mx-auto w-full max-w-md space-y-4">
      <ErrorNote message={error} />
      <Field label="Store name (prints on receipts)">
        <input value={name} onChange={(e) => setName(e.target.value)} className={inputCls} />
      </Field>
      <div>
        <span className="mb-1 block text-xs font-medium text-muted">{t('pos.tabs2.taxRates')}</span>
        {showPresetUpdate && (
          <div className="mb-2 rounded-os border border-accent/40 bg-accent/10 p-3">
            <p className="flex items-center gap-1.5 text-sm font-semibold text-ink">
              <TriangleAlert size={15} className="text-accent" />
              {t('pos.tabs2.taxPresetUpdate')}
            </p>
            <p className="mt-1 text-xs leading-relaxed text-ink">{t(outdatedPreset.noteKey)}</p>
            <button
              type="button"
              onClick={() => applyPreset(outdatedPreset.id)}
              className="mt-2 rounded-os bg-accent px-3 py-1.5 text-xs font-semibold text-white duration-160 hover:opacity-90"
            >
              {t('pos.tabs2.taxReviewApply')}
            </button>
          </div>
        )}
        <div className="space-y-2 rounded-os border border-osborder bg-paper/60 p-3">
          <label className="block">
            <span className="mb-1 block text-xs text-muted">{t('pos.tabs2.taxPresetHint')}</span>
            <select value={presetId} onChange={(e) => applyPreset(e.target.value)} className={inputCls}>
              {TAX_PRESETS.map((p) => (
                <option key={p.id} value={p.id}>{presetLabel(p, lang)}</option>
              ))}
            </select>
          </label>
          {taxRates.length === 0 && (
            <p className="text-xs text-muted">{t('pos.tabs2.taxNoStacked')}</p>
          )}
          {taxRates.map((t, i) => (
            <div key={i}>
              <div className="flex items-center gap-2">
                <input
                  value={t.name}
                  onChange={(e) => setTaxRow(i, { name: e.target.value })}
                  placeholder={t('pos.tabs2.taxNamePh')}
                  className={`${inputCls} flex-1`}
                />
                <input
                  value={String(t.rate)}
                  onChange={(e) => setTaxRow(i, { rate: e.target.value.replace(/[^0-9.]/g, '') })}
                  placeholder="0"
                  inputMode="decimal"
                  className={`${inputCls} w-24 text-right`}
                />
                <span className="text-xs text-muted">%</span>
                <button
                  type="button"
                  onClick={() => { setPresetId('custom'); setTaxRates((rows) => rows.filter((_, j) => j !== i)); }}
                  className="rounded-os p-1.5 text-muted hover:text-accent"
                  aria-label={t('pos.tabs2.taxRemoveRate')}
                >
                  <Trash2 size={14} />
                </button>
              </div>
              {i > 0 && (
                <label className="mt-1 flex cursor-pointer items-center gap-1.5 pl-1 text-[11px] text-muted">
                  <input
                    type="checkbox"
                    checked={t.compound === true}
                    onChange={(e) => setTaxRow(i, { compound: e.target.checked })}
                    className="accent-accent"
                  />
                  {t('pos.tabs2.taxCompoundHint')}
                </label>
              )}
            </div>
          ))}
          <button
            type="button"
            onClick={() => { setPresetId('custom'); setTaxRates((rows) => [...rows, { name: '', rate: '', compound: false }]); }}
            className="flex items-center gap-1 text-xs font-medium text-muted hover:text-ink"
          >
            <Plus size={13} /> {t('pos.tabs2.taxAddRate')}
          </button>
        </div>
      </div>
      <Field label={t('pos.tabs2.taxDefaultRate')}>
        <input
          value={taxRate}
          onChange={(e) => setTaxRate(e.target.value.replace(/[^0-9.]/g, ''))}
          inputMode="decimal"
          placeholder="0"
          disabled={presetId !== 'custom'}
          title={presetId !== 'custom' ? t('pos.tabs2.taxPresetControls') : undefined}
          className={`${inputCls} ${presetId !== 'custom' ? 'opacity-50' : ''}`}
        />
        {presetId !== 'custom' && (
          <p className="mt-1 text-[11px] text-muted">{t('pos.tabs2.taxPresetControls')}</p>
        )}
      </Field>
      <Field label="Currency symbol">
        <input value={currency} onChange={(e) => setCurrency(e.target.value)} className={inputCls} />
      </Field>
      {extras && (
        <div className="space-y-3 rounded-os border border-osborder bg-paper p-4">
          <p className="flex items-center gap-2 text-sm font-semibold text-ink">
            <Star size={15} className="text-accent" /> {t('pos.loyalty.title')}
          </p>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('pos.loyalty.perDollar')}>
              <input
                value={loyaltyPerDollar}
                onChange={(e) => setLoyaltyPerDollar(e.target.value.replace(/[^0-9.]/g, ''))}
                placeholder="0"
                inputMode="decimal"
                className={inputCls}
              />
            </Field>
            <Field label={t('pos.loyalty.valueCents')}>
              <input
                value={loyaltyValue}
                onChange={(e) => setLoyaltyValue(e.target.value.replace(/[^0-9.]/g, ''))}
                placeholder="0.00"
                inputMode="decimal"
                className={inputCls}
              />
            </Field>
          </div>
          <p className="text-xs text-muted">{t('pos.loyalty.enableHint')}</p>
        </div>
      )}
      {extras && <PromosSection store={store} />}
      <PrinterSettingsSection store={store} />
      <button
        type="button"
        onClick={save}
        disabled={saving}
        className="flex w-full items-center justify-center gap-2 rounded-os bg-accent px-4 py-2.5 text-sm font-semibold text-accentink duration-160 hover:opacity-90 disabled:opacity-50"
      >
        {saving ? t('pos.tabs2.saving') : saved ? <><Check size={16} /> {t('pos.tabs2.saved')}</> : t('pos.tabs2.saveSettings')}
      </button>
      {isOwner && (
        <div className="rounded-os border border-osborder bg-paper p-4">
          <p className="text-sm font-medium text-ink">{t('pos.tabs2.dangerZone')}</p>
          <p className="mt-1 text-xs text-muted">
            {t('pos.tabs2.dangerBlurb')}
          </p>
          {!confirmDelete ? (
            <button
              type="button"
              onClick={() => setConfirmDelete(true)}
              className="mt-3 rounded-os border border-osborder px-3 py-1.5 text-sm font-medium text-muted hover:border-accent hover:text-ink"
            >
              {t('pos.tabs2.deleteStore')}
            </button>
          ) : (
            <div className="mt-3 flex gap-2">
              <button type="button" onClick={() => setConfirmDelete(false)} className="flex-1 rounded-os border border-osborder bg-surface px-3 py-1.5 text-sm text-ink">
                {t('pos.tabs2.keepIt')}
              </button>
              <button
                type="button"
                onClick={() => onSave({ __delete: true })}
                className="flex-1 rounded-os bg-accent px-3 py-1.5 text-sm font-semibold text-accentink hover:opacity-90"
              >
                {t('pos.tabs2.yesDelete')}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Store setup (cloud, no stores yet) + create-store modal              */
/* ------------------------------------------------------------------ */

function CreateStoreModal({ onClose, onCreated }) {
  const { t } = useLang();
  const [name, setName] = useState('');
  const [currency, setCurrency] = useState('$');
  const [taxRate, setTaxRate] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!name.trim()) return setError(t('pos.tabs2.giveStoreName'));
    setBusy(true);
    try {
      const store = await backend.pos.createStore({
        name: name.trim(),
        currency: currency.trim() || '$',
        taxRate: parseFloat(taxRate) || 0,
      });
      onCreated(store);
    } catch (err) {
      setError(err.message || t('err.createStore'));
      setBusy(false);
    }
  };

  return (
    <Modal title={t('pos.tabs2.newStore')} onClose={onClose}>
      <div className="space-y-3">
        <Field label={t('pos.tabs2.storeName')}>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('pos.tabs2.storeNamePh')} autoFocus className={inputCls} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('pos.tabs2.currencySymbol')}>
            <input value={currency} onChange={(e) => setCurrency(e.target.value)} className={inputCls} />
          </Field>
          <Field label={t('pos.tabs2.taxRatePct')}>
            <input value={taxRate} onChange={(e) => setTaxRate(e.target.value.replace(/[^0-9.]/g, ''))} placeholder="0" inputMode="decimal" className={inputCls} />
          </Field>
        </div>
        <ErrorNote message={error} />
        <button
          type="button"
          onClick={submit}
          disabled={busy}
          className="w-full rounded-os bg-accent px-4 py-2.5 text-sm font-semibold text-accentink duration-160 hover:opacity-90 disabled:opacity-60"
        >
          {busy ? t('pos.tabs2.creating') : t('pos.tabs2.createStore')}
        </button>
      </div>
    </Modal>
  );
}

function StoreSetupScreen({ onStoreReady }) {
  const { t } = useLang();
  const [mode, setMode] = useState('choice'); // choice | create | join
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const join = async () => {
    if (!code.trim()) return setError(t('pos.tabs2.enterInviteCode'));
    setBusy(true);
    setError('');
    try {
      const storeId = await backend.pos.joinStore(code.trim());
      const stores = await backend.pos.listStores();
      const store = stores.find((s) => s.id === storeId);
      if (!store) throw new Error(t('pos.tabs2.joinedNoStore'));
      onStoreReady(store);
    } catch (err) {
      setError(err.message || t('err.joinStore'));
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full items-center justify-center bg-surface p-6">
      <div className="w-full max-w-md">
        <div className="mb-6 text-center">
          <StoreIcon size={40} className="mx-auto text-accent" />
          <h2 className="mt-3 text-xl font-bold text-ink">{t('pos.tabs2.pointOfSale')}</h2>
          <p className="mt-1 text-sm text-muted">
            {mode === 'join'
              ? t('pos.tabs2.noStoreJoinHint')
              : t('pos.tabs2.noStoreChoice')}
          </p>
        </div>

        {mode === 'choice' && (
          <div className="space-y-2">
            <button
              type="button"
              onClick={() => setMode('create')}
              className="w-full rounded-os bg-accent px-4 py-3 text-sm font-semibold text-accentink duration-160 hover:opacity-90"
            >
              <Plus size={16} className="mr-2 inline" /> {t('pos.tabs2.openNewStore')}
            </button>
            <button
              type="button"
              onClick={() => setMode('join')}
              className="w-full rounded-os border border-osborder bg-paper px-4 py-3 text-sm font-medium text-ink duration-160 hover:border-accent"
            >
              <Ticket size={16} className="mr-2 inline" /> {t('pos.tabs2.joinWithCode')}
            </button>
          </div>
        )}

        {mode === 'create' && (
          <CreateStoreModal onClose={() => setMode('choice')} onCreated={onStoreReady} />
        )}

        {mode === 'join' && (
          <div className="space-y-3">
            <Field label={t('pos.tabs2.inviteCode')}>
              <input
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
                placeholder="p. ex. K7Q2M9XD"
                autoFocus
                className={`${inputCls} text-center font-mono text-lg tracking-widest`}
              />
            </Field>
            <ErrorNote message={error} />
            <button
              type="button"
              onClick={join}
              disabled={busy}
              className="w-full rounded-os bg-accent px-4 py-3 text-sm font-semibold text-accentink duration-160 hover:opacity-90 disabled:opacity-60"
            >
              {busy ? t('pos.tabs2.joining') : t('pos.tabs2.joinStore')}
            </button>
            <button
              type="button"
              onClick={() => { setMode('choice'); setError(''); }}
              className="w-full py-1 text-sm text-muted hover:text-ink"
            >
              {t('pos.tabs2.back')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Time clock — PIN punch in/out + hours                               */
/* ------------------------------------------------------------------ */

function fmtClockTime(iso) {
  return new Date(iso).toLocaleTimeString(localeTag(), { hour: 'numeric', minute: '2-digit' });
}

function fmtClockDay(iso) {
  return new Date(iso).toLocaleDateString(localeTag(), { weekday: 'short', month: 'short', day: 'numeric' });
}

function fmtDur(ms) {
  const m = Math.max(0, Math.round(ms / 60000));
  const h = Math.floor(m / 60);
  return h > 0 ? `${h}h ${m % 60}m` : `${m}m`;
}

// ISO -> "YYYY-MM-DDTHH:MM" for <input type="datetime-local">.
function toLocalInput(iso) {
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const CLOCK_PAD_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'];

function ClockTab({ store }) {
  const { t } = useLang();
  const [who, setWho] = useState(null); // PIN-verified staff { id, name, role }
  const [pin, setPin] = useState('');
  const [openPunch, setOpenPunch] = useState(null);
  const [punches, setPunches] = useState([]);
  const [range, setRange] = useState('today'); // 'today' | 'week'
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [nowTick, setNowTick] = useState(Date.now());
  const punchLock = useRef(false); // synchronous double-submit lock for clock in/out

  // Live "clocked in for …" ticker while a shift is open.
  useEffect(() => {
    if (!openPunch) return;
    const t = setInterval(() => setNowTick(Date.now()), 30000);
    return () => clearInterval(t);
  }, [openPunch]);

  const loadPunches = useCallback(async () => {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    if (range === 'week') start.setDate(start.getDate() - 6);
    setPunches(await backend.pos.listPunches(store.id, { from: start.toISOString() }));
  }, [store.id, range]);

  useEffect(() => {
    loadPunches().catch((e) => setError(e.message || t('err.loadPunches')));
  }, [loadPunches]);

  const submitClockPin = async () => {
    if (pin.length < 4) return;
    setBusy(true);
    setError('');
    try {
      const staff = await backend.pos.staffLogin(store.id, pin);
      setWho(staff);
      setPin('');
      setOpenPunch(await backend.pos.getOpenPunch(store.id, staff.id));
    } catch (err) {
      setError(err.message || t('err.verifyPin'));
    } finally {
      setBusy(false);
    }
  };

  const punch = async () => {
    if (!who) return;
    if (punchLock.current) return; // block rapid double-click double punches
    punchLock.current = true;
    setBusy(true);
    setError('');
    try {
      // Every punch re-verifies the PIN server-side (pos_clock_in/out RPCs);
      // the terminal never punches as anyone but the PIN holder.
      if (openPunch) {
        await backend.pos.clockOut(store.id, who.pinHash);
        setOpenPunch(null);
      } else {
        setOpenPunch(await backend.pos.clockIn(store.id, who.pinHash));
      }
      await loadPunches();
    } catch (err) {
      setError(err.message || t('err.recordPunch'));
    } finally {
      punchLock.current = false;
      setBusy(false);
    }
  };

  // Manager corrections: fix a punch's times (audited server-side) or delete
  // a punch. Only owners/managers see these controls.
  const manager = canManage(store.role);
  const [correcting, setCorrecting] = useState(null);
  const [corrIn, setCorrIn] = useState('');
  const [corrOut, setCorrOut] = useState('');
  const [showAudits, setShowAudits] = useState(false);
  const [audits, setAudits] = useState([]);

  const openCorrect = (p) => {
    setCorrecting(p);
    setCorrIn(toLocalInput(p.punchIn));
    setCorrOut(p.punchOut ? toLocalInput(p.punchOut) : '');
    setError('');
  };

  const saveCorrection = async () => {
    if (!correcting) return;
    setBusy(true);
    setError('');
    try {
      await backend.pos.correctPunch(store.id, correcting.id, {
        punchIn: new Date(corrIn).toISOString(),
        punchOut: corrOut ? new Date(corrOut).toISOString() : null,
      });
      setCorrecting(null);
      await loadPunches();
    } catch (err) {
      setError(err.message || 'Could not correct the punch.');
    } finally {
      setBusy(false);
    }
  };

  const removePunch = async (p) => {
    if (!window.confirm(t('punch.deleteConfirm', { name: p.staffName, day: fmtClockDay(p.punchIn) }))) return;
    setBusy(true);
    setError('');
    try {
      await backend.pos.deletePunch(store.id, p.id);
      await loadPunches();
    } catch (err) {
      setError(err.message || 'Could not delete the punch.');
    } finally {
      setBusy(false);
    }
  };

  const toggleAudits = async () => {
    if (!showAudits) {
      try {
        setAudits(await backend.pos.listPunchAudits(store.id, { limit: 50 }));
      } catch {
        setAudits([]);
      }
    }
    setShowAudits(!showAudits);
  };

  const switchPerson = () => {
    setWho(null);
    setOpenPunch(null);
    setPin('');
    setError('');
  };

  // Hours per staff over the visible punches (open shifts count up to now).
  const totals = useMemo(() => {
    const map = new Map();
    for (const p of punches) {
      const end = p.punchOut ? new Date(p.punchOut).getTime() : nowTick;
      const ms = Math.max(0, end - new Date(p.punchIn).getTime());
      const cur = map.get(p.staffId) || { name: p.staffName, ms: 0, shifts: 0 };
      cur.ms += ms;
      cur.shifts += 1;
      map.set(p.staffId, cur);
    }
    return [...map.values()].sort((a, b) => b.ms - a.ms);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [punches, nowTick]);

  const press = (d) => setPin((p) => (p.length >= 8 ? p : p + d));

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {/* Punch terminal */}
      <div className="rounded-os border border-osborder bg-paper p-4">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-ink">
          <Clock3 size={15} className="text-accent" /> {t('pos.ui.timeClock')}
        </h3>
        <p className="mt-0.5 text-xs text-muted">
          {t('pos.ui.kioskHint')}
        </p>

        <div className="mt-3"><ErrorNote message={error} /></div>

        {!who ? (
          <div className="mt-2">
            <div className="mb-3 flex justify-center" aria-label="PIN entry">
              <div className="flex gap-2">
                {Array.from({ length: 8 }).map((_, i) => (
                  <div
                    key={i}
                    className={`h-4 w-4 rounded-full border ${
                      i < pin.length ? 'border-accent bg-accent' : 'border-osborder'
                    }`}
                  />
                ))}
              </div>
            </div>
            <div className="mx-auto grid max-w-[240px] grid-cols-3 gap-2">
              {CLOCK_PAD_KEYS.map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => press(d)}
                  className="rounded-os bg-surface py-3 text-xl font-semibold text-ink duration-160 hover:bg-osborder/40"
                >
                  {d}
                </button>
              ))}
              <button
                type="button"
                onClick={() => setPin((p) => p.slice(0, -1))}
                aria-label="Backspace"
                className="rounded-os bg-surface py-3 text-sm font-semibold text-muted duration-160 hover:text-ink"
              >
                ⌫
              </button>
              <button
                type="button"
                onClick={submitClockPin}
                disabled={busy || pin.length < 4}
                className="rounded-os bg-accent py-3 text-sm font-semibold text-accentink duration-160 hover:opacity-90 disabled:opacity-40"
              >
                {busy ? '…' : 'OK'}
              </button>
              <button
                type="button"
                onClick={() => setPin('')}
                className="rounded-os bg-surface py-3 text-sm font-semibold text-muted duration-160 hover:text-ink"
              >
                {t('punch.clearPad')}
              </button>
            </div>
          </div>
        ) : (
          <div className="mt-3 rounded-os border border-osborder bg-surface p-4 text-center">
            <p className="text-lg font-semibold text-ink">{who.name}</p>
            <p className="text-xs text-muted">{ROLE_LABEL[who.role] || who.role}</p>
            {openPunch ? (
              <p className="mt-2 text-sm text-ink">
                {t('punch.onShiftSince')} <span className="font-medium">{fmtClockTime(openPunch.punchIn)}</span>
                <span className="text-muted"> · {fmtDur(nowTick - new Date(openPunch.punchIn).getTime())} {t('punch.soFar')}</span>
              </p>
            ) : (
              <p className="mt-2 text-sm text-muted">{t('pos.tabs2.notClockedIn')}</p>
            )}
            <button
              type="button"
              onClick={punch}
              disabled={busy}
              className={`mt-4 w-full rounded-os px-4 py-3 text-base font-semibold duration-160 disabled:opacity-50 ${
                openPunch
                  ? 'bg-red-500/15 text-red-600 hover:bg-red-500/25'
                  : 'bg-accent text-accentink hover:opacity-90'
              }`}
            >
              {busy ? 'Working…' : openPunch ? 'Punch out' : 'Punch in'}
            </button>
            <button
              type="button"
              onClick={switchPerson}
              className="mt-2 w-full py-1 text-xs text-muted hover:text-ink"
            >
              Not {who.name}? Switch person
            </button>
          </div>
        )}
      </div>

      {/* Hours + recent punches */}
      <div className="space-y-4">
        <div className="rounded-os border border-osborder bg-paper p-4">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-ink">{t('pos.tabs2.hours')}</h3>
            <div className="flex gap-1 rounded-os bg-surface p-0.5">
              {[
                { id: 'today', label: 'Today' },
                { id: 'week', label: 'Last 7 days' },
              ].map((r) => (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => setRange(r.id)}
                  className={`rounded-os px-2.5 py-1 text-xs font-medium duration-160 ${
                    range === r.id ? 'bg-paper text-ink shadow-os' : 'text-muted hover:text-ink'
                  }`}
                >
                  {r.label}
                </button>
              ))}
            </div>
          </div>
          {totals.length === 0 ? (
            <p className="py-3 text-center text-xs text-muted">{t('pos.tabs2.noPunches')}</p>
          ) : (
            <ul className="divide-y divide-osborder">
              {totals.map((t) => (
                <li key={t.name} className="flex items-center justify-between py-2">
                  <span className="text-sm text-ink">
                    {t.name}
                    <span className="ml-1.5 text-xs text-muted">
                      {t.shifts} shift{t.shifts === 1 ? '' : 's'}
                    </span>
                  </span>
                  <span className="text-sm font-semibold text-ink">{fmtDur(t.ms)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="rounded-os border border-osborder bg-paper p-4">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-ink">{t('pos.tabs2.recentPunches')}</h3>
            {manager && (
              <button type="button" onClick={toggleAudits}
                className="rounded-os px-2 py-1 text-[11px] font-medium text-muted hover:bg-surface hover:text-ink">
                {showAudits ? 'Hide corrections log' : 'Corrections log'}
              </button>
            )}
          </div>
          {showAudits && manager ? (
            audits.length === 0 ? (
              <p className="py-3 text-center text-xs text-muted">{t('pos.tabs2.noCorrections')}</p>
            ) : (
              <ul className="max-h-64 divide-y divide-osborder overflow-y-auto">
                {audits.map((a) => (
                  <li key={a.id} className="py-1.5 text-xs">
                    <span className={`font-medium ${a.action === 'delete' ? 'text-red-600' : 'text-amber-600'}`}>
                      {a.action === 'delete' ? 'Deleted' : 'Corrected'}
                    </span>
                    <span className="text-muted">
                      {' '}{a.oldPunchIn ? fmtClockDay(a.oldPunchIn) : ''} {a.oldPunchIn ? fmtClockTime(a.oldPunchIn) : ''}
                      {a.oldPunchOut ? ` → ${fmtClockTime(a.oldPunchOut)}` : ' → open'}
                      {a.action === 'correct' && (
                        <> → {fmtClockTime(a.newPunchIn)}{a.newPunchOut ? ` → ${fmtClockTime(a.newPunchOut)}` : ' → open'}</>
                      )}
                    </span>
                    <span className="block text-[10px] text-muted">{fmtClockDay(a.createdAt)} {fmtClockTime(a.createdAt)}</span>
                  </li>
                ))}
              </ul>
            )
          ) : punches.length === 0 ? (
            <p className="py-3 text-center text-xs text-muted">{t('pos.tabs2.nothingHere')}</p>
          ) : (
            <ul className="max-h-64 divide-y divide-osborder overflow-y-auto">
              {punches.slice(0, 30).map((p) => (
                <li key={p.id} className="flex items-center justify-between py-1.5 text-xs">
                  <span className="min-w-0">
                    <span className="block truncate font-medium text-ink">{p.staffName}</span>
                    <span className="block text-muted">{fmtClockDay(p.punchIn)}</span>
                  </span>
                  <span className="flex shrink-0 items-center gap-2 text-right text-muted">
                    <span>
                      {fmtClockTime(p.punchIn)} → {p.punchOut ? fmtClockTime(p.punchOut) : t('pos.ui.nowWord')}
                      <span className="block font-medium text-ink">
                        {fmtDur((p.punchOut ? new Date(p.punchOut).getTime() : nowTick) - new Date(p.punchIn).getTime())}
                      </span>
                    </span>
                    {manager && (
                      <span className="flex flex-col gap-1">
                        <button type="button" onClick={() => openCorrect(p)} aria-label={t('pos.ui.correctPunchAria', { name: p.staffName })}
                          className="rounded-os border border-osborder px-1.5 py-0.5 text-[10px] font-medium text-ink hover:border-accent">
                          {t('pos.ui.fixPunch')}
                        </button>
                        <button type="button" onClick={() => removePunch(p)} aria-label={t('pos.ui.deletePunchAria', { name: p.staffName })}
                          className="rounded-os border border-osborder px-1.5 py-0.5 text-[10px] font-medium text-red-600 hover:border-red-500">
                          Del
                        </button>
                      </span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {correcting && (
        <Modal title={`Correct punch — ${correcting.staffName}`} onClose={() => setCorrecting(null)}>
          <div className="space-y-3">
            <p className="text-xs text-muted">
              {fmtClockDay(correcting.punchIn)} · {fmtClockTime(correcting.punchIn)} →{' '}
              {correcting.punchOut ? fmtClockTime(correcting.punchOut) : 'open'}. The old times are kept in the corrections log.
            </p>
            <div className="grid grid-cols-2 gap-3">
              <label className="block text-xs font-medium text-muted">
                {t('punch.punchInLabel')}
                <input type="datetime-local" value={corrIn} onChange={(e) => setCorrIn(e.target.value)}
                  className="mt-1 w-full rounded-os border border-osborder bg-paper px-3 py-2 text-sm text-ink outline-none focus:border-accent" />
              </label>
              <label className="block text-xs font-medium text-muted">
                {t('punch.punchOutLabel')}
                <input type="datetime-local" value={corrOut} onChange={(e) => setCorrOut(e.target.value)}
                  className="mt-1 w-full rounded-os border border-osborder bg-paper px-3 py-2 text-sm text-ink outline-none focus:border-accent" />
              </label>
            </div>
            <ErrorNote message={error} />
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setCorrecting(null)}
                className="rounded-os border border-osborder px-4 py-2 text-sm font-medium text-ink hover:border-accent">
                {t('common.cancel')}
              </button>
              <button type="button" onClick={saveCorrection} disabled={busy || !corrIn}
                className="rounded-os bg-accent px-4 py-2 text-sm font-semibold text-accentink hover:opacity-90 disabled:opacity-50">
                {busy ? 'Saving…' : 'Save correction'}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Main app                                                            */
/* ------------------------------------------------------------------ */

export default function POSApp({
  kiosk = false, kioskStoreId = null, windowApi = null }) {
  const { t } = useLang();
  const { enterPOSMode } = usePOSMode();
  const { pushToast } = useToasts();
  const [tab, setTab] = useState('sell');
  const [stores, setStores] = useState(null);
  const [storeId, setStoreId] = useState(kiosk && kioskStoreId ? kioskStoreId : null);
  const [products, setProducts] = useState([]);
  const [sales, setSales] = useState([]);
  const [members, setMembers] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [customerId, setCustomerId] = useState(null);
  // Organization directory (POS upgrade): tax-exempt billing.
  const [orgs, setOrgs] = useState([]);
  const [orgId, setOrgId] = useState(null);
  const [caps, setCaps] = useState(null); // { v4 } — migration 004 features
  const [pinStaff, setPinStaff] = useState(null); // { id, name, role } — shared-device login
  const [pinPadOpen, setPinPadOpen] = useState(false);
  const [pinError, setPinError] = useState('');
  const [pinBusy, setPinBusy] = useState(false);
  const [selfId, setSelfId] = useState(null);
  const [error, setError] = useState('');
  const [loadingStore, setLoadingStore] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [posModeOpen, setPosModeOpen] = useState(false);
  const [posModeBusy, setPosModeBusy] = useState(false);
  const [posModeError, setPosModeError] = useState('');
  // External cart lines (exchange from history, school-list conversion).
  const [seedLines, setSeedLines] = useState(null);
  // Ownership token for loadStoreData: if the user switches stores while a
  // load is in flight, the older response must not overwrite the newer
  // store's products, sales, and members.
  const loadSeq = useRef(0);

  const store = stores?.find((s) => s.id === storeId) || null;
  const v4 = !!caps?.v4;
  // POS upgrades (gift cards, credit notes, refunds, deposits, promos,
  // loyalty, ISBN, school lists, accounting export, petty cash) are gated on
  // the backend capability flag. The Supabase backend does not implement
  // these APIs yet, so the UI stays hidden until it does — the components
  // themselves are intact and light up automatically once capabilities()
  // reports posUpgrades.
  const extras = !!caps?.posUpgrades;
  // Refunds are carved out of the posUpgrades bundle behind their own
  // capability (migration 034), the same way gift cards were — the rest of
  // the bundle (credit notes, deposits, promos, loyalty, school lists,
  // accounting export, petty cash) stays hidden until implemented.
  const refundsOk = !!caps?.refunds;
  const giftCards = !!caps?.giftCards;
  const orgsOk = !!caps?.orgs;
  const clockOk = !!caps?.timeClock;
  const memberName = (userId) => members.find((m) => m.userId === userId)?.username || null;
  // A PIN login can step a shared device *down* to cashier (or up for a
  // manager PIN on a cashier's device); it never grants more than the store
  // role already allows at the database level.
  const effectiveRole = pinStaff?.role || store?.role || 'cashier';
  const manager = store ? canManage(effectiveRole) : false;
  const cashierName = pinStaff?.name || memberName(selfId) || 'Staff';

  // initial: who am I + which stores do I belong to
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const me = backend.auth.getUser()?.user;
        if (!cancelled) setSelfId(me?.id ?? null);
        const list = await backend.pos.listStores();
        if (cancelled) return;
        setStores(list);
        // In kiosk mode the store is fixed by the lock — never auto-switch.
        if (!kiosk && list.length > 0) setStoreId(list[0].id);
        // NUCLEAR FAILSAFE: start offline queue auto-sync. Queued sales
        // (captured while offline) sync automatically when connectivity returns.
        if (!cancelled) {
          startAutoSync(async (item) => {
            if (item.type === 'pos_sale') {
              // Use the idempotency key so retries are safe.
              await withTimeout(
                backend.pos.recordSale(item.payload.storeId, {
                  ...item.payload.sale,
                  idempotencyKey: item.idempotencyKey,
                }),
                30000,
                'queueSync'
              );
              // Refresh sales list after sync.
              if (item.payload.storeId === storeId) {
                backend.pos.listSales(item.payload.storeId).then(setSales).catch(() => {});
              }
            }
          });
        }
      } catch (err) {
        if (!cancelled) setError(err.message || t('err.loadPosData'));
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // load a store's data
  const loadStoreData = async (id) => {
    const seq = ++loadSeq.current;
    setLoadingStore(true);
    try {
      const capabilities = backend.pos.capabilities
        ? await backend.pos.capabilities().catch(() => ({ v4: false }))
        : { v4: false };
      const [p, s, m] = await Promise.all([
        backend.pos.listProducts(id),
        backend.pos.listSales(id, { limit: 500 }),
        backend.pos.listMembers(id),
      ]);
      let c = [];
      if (capabilities.v4 && backend.pos.listCustomers) {
        c = await backend.pos.listCustomers(id).catch(() => []);
      }
      let o = [];
      if (capabilities.orgs && backend.pos.listOrgs) {
        o = await backend.pos.listOrgs(id).catch(() => []);
      }
      // A newer store switch superseded this load — drop the stale data.
      if (loadSeq.current !== seq) return;
      setProducts(p);
      setSales(s);
      setMembers(m);
      setCustomers(c);
      setOrgs(o);
      setCaps(capabilities);
      setPinStaff(null);
      setCustomerId(null);
      setOrgId(null);
      setError('');
    } catch (err) {
      if (loadSeq.current !== seq) return;
      setError(err.message || 'Could not load store data.');
    } finally {
      if (loadSeq.current === seq) setLoadingStore(false);
    }
  };

  useEffect(() => {
    if (storeId) loadStoreData(storeId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId]);

  // cashiers lose access to manager tabs if their role changes
  useEffect(() => {
    if (store && !manager && (tab === 'products' || tab === 'settings' || tab === 'reports')) setTab('sell');
  }, [store, manager, tab]);

  // v4-only tabs disappear if the migration isn't applied
  useEffect(() => {
    if (caps && !caps.v4 && (tab === 'customers' || tab === 'drawer')) setTab('sell');
    if (caps && !caps.timeClock && tab === 'clock') setTab('sell');
  }, [caps, tab]);

  const refreshStores = async (selectId) => {
    const list = await backend.pos.listStores();
    setStores(list);
    if (selectId) {
      if (list.some((s) => s.id === selectId)) setStoreId(selectId);
      else if (list.length > 0) setStoreId(list[0].id);
      else setStoreId(null);
    } else if (!list.some((s) => s.id === storeId)) {
      setStoreId(list.length > 0 ? list[0].id : null);
    }
  };

  // AUTO-UPDATE: store settings (tax rates, name, currency) can be changed
  // by an owner/manager on any device. Poll the lightweight store list and
  // also re-check whenever the tab regains focus, so every terminal picks
  // up new tax rates automatically — no reload, no redeploy, no stale
  // charges. Products/prices are deliberately NOT auto-refreshed: swapping
  // the catalog mid-sale would be surprising; they reload on tab revisit.
  const storesRef = useRef(null);
  storesRef.current = stores;
  const storeIdRef = useRef(storeId);
  storeIdRef.current = storeId;
  useEffect(() => {
    if (!storeId) return;
    let cancelled = false;
    // Signature of the settings that affect charging: if any of these
    // change on the server, the local copy is stale.
    const settingsSig = (s) =>
      s
        ? JSON.stringify({
            name: s.name,
            currency: s.currency,
            taxRate: s.taxRate,
            taxRates: s.taxRates,
          })
        : '';
    const syncSettings = async () => {
      try {
        const current = storesRef.current?.find((s) => s.id === storeIdRef.current);
        // Nothing loaded yet — the initial load effect owns the first fetch.
        if (!current) return;
        const list = await backend.pos.listStores();
        if (cancelled) return;
        const fresh = list.find((s) => s.id === storeIdRef.current);
        if (!fresh) return;
        if (settingsSig(fresh) !== settingsSig(current)) {
          setStores(list);
          pushToast({
            title: t('pos.tabs2.settingsAutoTitle'),
            message: t('pos.tabs2.settingsAutoMsg'),
            timeoutMs: 9000,
          });
        }
      } catch {
        // Offline or transient failure: stay on the last known settings and
        // try again on the next tick. Never surface noise for this.
      }
    };
    const id = setInterval(syncSettings, 60000);
    const onVisible = () => {
      if (document.visibilityState === 'visible') syncSettings();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId]);

  /* ----- actions ----- */

  const recordSale = async (sale) => {
    // NUCLEAR FAILSAFE: 30s timeout. A hung sale recording is indistinguishable
    // from a crash to the user — fail fast with a clear error, don't spin forever.
    // (The offline queue catches network failures; this catches hangs.)
    const recorded = await withTimeout(
      backend.pos.recordSale(store.id, sale),
      30000,
      'recordSale'
    );
    setSales((s) => [recorded, ...s]);
    // NUCLEAR FAILSAFE: log to the money audit trail (black box recorder).
    logMoneyMovement('sale', {
      amountCents: recorded.totalCents,
      saleId: recorded.id,
      saleNumber: recorded.number,
      method: sale.method,
      userId: selfId,
      note: `Sale #${recorded.number} via ${sale.method}`,
    });
    // Stock counts changed on the backend — refresh the catalog so the
    // sell screen shows true numbers.
    if (v4) {
      backend.pos.listProducts(store.id).then(setProducts).catch(() => {});
    }
    return recorded;
  };

  const saveProduct = async (product) => {
    // Client-side SKU uniqueness (per store, case-insensitive, blank SKUs
    // allowed) — checked here so it applies to both local and cloud stores
    // before the adapter write happens.
    const sku = String(product.sku ?? '').trim().toLowerCase();
    if (sku) {
      const dup = products.some(
        (x) => x.id !== product.id && String(x.sku || '').trim().toLowerCase() === sku
      );
      if (dup) throw new Error(`SKU "${String(product.sku).trim()}" is already used by another product.`);
    }
    const saved = await backend.pos.saveProduct(store.id, product);
    setProducts((p) => {
      const exists = p.some((x) => x.id === saved.id);
      const next = exists ? p.map((x) => (x.id === saved.id ? saved : x)) : [...p, saved];
      return next.sort((a, b) => a.name.localeCompare(b.name));
    });
  };

  const deleteProduct = async (id) => {
    await backend.pos.deleteProduct(store.id, id);
    setProducts((p) => p.filter((x) => x.id !== id));
  };

  const toggleProductActive = async (p) => {
    const saved = await backend.pos.saveProduct(store.id, { ...p, active: !p.active });
    setProducts((list) => list.map((x) => (x.id === saved.id ? saved : x)));
  };

  const adjustStock = async (p, delta) => {
    const updated = await backend.pos.adjustStock(store.id, p.id, delta);
    setProducts((list) => list.map((x) => (x.id === updated.id ? updated : x)));
  };

  const voidSale = async (id, reason) => {
    // Returns the RPC result { voided, warnings } so the history tab can
    // surface restock warnings; throws on failure (already voided, not a
    // manager) so the dialog can show the error instead of closing.
    const res = await backend.pos.voidSale(store.id, id, reason);
    setSales((s) =>
      s.map((x) =>
        x.id === id
          ? { ...x, voided: true, voidedAt: new Date().toISOString(), voidReason: reason || x.voidReason || null }
          : x
      )
    );
    if (v4) {
      backend.pos.listProducts(store.id).then(setProducts).catch(() => {});
    }
    return res;
  };

  const refreshCustomers = async () => {
    if (v4 && backend.pos.listCustomers) {
      try {
        setCustomers(await backend.pos.listCustomers(store.id));
      } catch {
        /* loyalty balances refresh best-effort */
      }
    }
  };

  const refreshOrgs = async () => {
    if (orgsOk && backend.pos.listOrgs) {
      try {
        setOrgs(await backend.pos.listOrgs(store.id));
      } catch {
        /* best-effort */
      }
    }
  };

  // Refund selected lines of a sale. Refund math (proportional discount /
  // promo / tax) lives in the backend; a credit-note refund is issued there
  // too so the instrument can never be created without the refund record.
  const handleRefund = async ({ sale, lines, method, reason, idemKey }) => {
    const res = await backend.pos.refundSale(store.id, sale.id, {
      lines: lines.map((l) => ({ index: l.lineIndex, qty: l.qty })),
      reason,
      asCreditNote: method === 'credit',
      idemKey: idemKey || null,
      customerId: sale.customerId || null,
      customerName: sale.customerName || null,
    });
    // NUCLEAR FAILSAFE: log to the money audit trail.
    logMoneyMovement('refund', {
      amountCents: res.refundedCents || 0,
      saleId: sale.id,
      saleNumber: sale.number,
      method,
      userId: selfId,
      note: reason || `Refund for sale #${sale.number}`,
    });
    const fresh = await backend.pos.listSales(store.id, { limit: 500 }).catch(() => null);
    if (fresh) setSales(fresh);
    if (v4) {
      backend.pos.listProducts(store.id).then(setProducts).catch(() => {});
    }
    return res;
  };

  // Exchange: refund the returned lines (restocking them), then drop the
  // customer into the sell tab with those lines pre-loaded so the cashier
  // rings up the replacement items in one flow.
  const handleExchange = async ({ sale, lines, idemKey }) => {
    await backend.pos.refundSale(store.id, sale.id, {
      lines: lines.map((l) => ({ index: l.lineIndex, qty: l.qty })),
      reason: t('pos.refund.exchange'),
      idemKey: idemKey || null,
    });
    const fresh = await backend.pos.listSales(store.id, { limit: 500 }).catch(() => null);
    if (fresh) setSales(fresh);
    if (v4) {
      backend.pos.listProducts(store.id).then(setProducts).catch(() => {});
    }
    setSeedLines(
      lines.map((l) => {
        const it = sale.items[l.lineIndex] || {};
        return {
          productId: it.productId,
          variantId: it.variantId,
          variantName: it.variantName,
          bqItemId: it.bqItemId,
          name: it.name || '',
          priceCents: it.priceCents || 0,
          qty: l.qty,
        };
      })
    );
    setTab('sell');
  };

  const saveCustomer = async (customer) => {
    const saved = await backend.pos.saveCustomer(store.id, customer);
    setCustomers((list) => {
      const exists = list.some((x) => x.id === saved.id);
      const next = exists ? list.map((x) => (x.id === saved.id ? saved : x)) : [...list, saved];
      return next.sort((a, b) => a.name.localeCompare(b.name));
    });
  };

  const deleteCustomer = async (id) => {
    await backend.pos.deleteCustomer(store.id, id);
    setCustomers((list) => list.filter((x) => x.id !== id));
    if (customerId === id) setCustomerId(null);
  };

  const saveSettings = async (patch) => {
    if (patch.__delete) {
      await backend.pos.deleteStore(store.id);
      await refreshStores(null);
      setTab('sell');
      return;
    }
    const updated = await backend.pos.updateStore(store.id, patch);
    setStores((list) => list.map((s) => (s.id === store.id ? { ...s, ...updated } : s)));
  };

  const createInvite = (role) => backend.pos.createInvite(store.id, { role });
  const revokeInvite = (inviteId) => backend.pos.revokeInvite(store.id, inviteId);

  const setMemberRole = async (userId, role) => {
    await backend.pos.setMemberRole(store.id, userId, role);
    setMembers((m) => m.map((x) => (x.userId === userId ? { ...x, role } : x)));
  };

  const removeMember = async (userId) => {
    await backend.pos.removeMember(store.id, userId);
    setMembers((m) => m.filter((x) => x.userId !== userId));
  };

  const leaveStore = async () => {
    await backend.pos.removeMember(store.id, selfId);
    await refreshStores(null);
    setTab('sell');
  };

  const submitPin = async (pin) => {
    setPinBusy(true);
    setPinError('');
    try {
      const staff = await backend.pos.staffLogin(store.id, pin);
      setPinStaff(staff);
      setPinPadOpen(false);
      setTab('sell');
    } catch (err) {
      setPinError(err.message || 'Could not sign in.');
    } finally {
      setPinBusy(false);
    }
  };

  // POS Mode entry: managers lock this device to the register. A manager or
  // owner staff PIN must exist first — it is the only way back out.
  const confirmPOSMode = async () => {
    if (!store) return;
    setPosModeBusy(true);
    setPosModeError('');
    try {
      const staff = await backend.pos.listStaff(store.id).catch(() => []);
      const hasManagerPin = (staff || []).some(
        (s) => s.active !== false && (s.role === 'owner' || s.role === 'manager')
      );
      if (!hasManagerPin) {
        setPosModeError(
          t('pos.ui.needManagerPin')
        );
        return;
      }
      enterPOSMode(store.id, store.name);
      setPosModeOpen(false);
      // The overlay mounts its own register instance; close this window so
      // two copies of the POS are never live at once.
      windowApi?.close();
    } finally {
      setPosModeBusy(false);
    }
  };

  /* ----- render ----- */

  if (error && !store) {
    return (
      <div className="flex h-full items-center justify-center bg-surface p-8">
        <div className="text-center">
          <AlertCircle size={32} className="mx-auto text-accent" />
          <p className="mt-2 font-medium text-ink">{t('pos.tabs2.couldNotLoad')}</p>
          <p className="mt-1 max-w-sm text-sm text-muted">{error}</p>
          <button type="button" onClick={() => window.location.reload()} className="mt-4 rounded-os bg-accent px-4 py-2 text-sm font-semibold text-accentink hover:opacity-90">
            {t('common.retry')}
          </button>
        </div>
      </div>
    );
  }

  if (stores === null) {
    return (
      <div className="flex h-full items-center justify-center bg-surface">
        <p className="text-sm text-muted">{t('pos.tabs2.loadingPos')}</p>
      </div>
    );
  }

  // cloud mode with no stores yet -> setup screen
  if (stores.length === 0) {
    return (
      <StoreSetupScreen
        onStoreReady={(s) => {
          setStores([s]);
          setStoreId(s.id);
        }}
      />
    );
  }

  if (!store) {
    return (
      <div className="flex h-full items-center justify-center bg-surface">
        <p className="text-sm text-muted">{t('pos.tabs2.loadingPos')}</p>
      </div>
    );
  }

  const activeProducts = products.filter((p) => p.active);

  return (
    <div className="flex h-full flex-col bg-surface">
      <div className="flex items-center gap-2 overflow-x-auto border-b border-osborder px-4 py-2">
        <TabButton id="sell" label={t("pos.tabs.sell")} icon={ShoppingCart} active={tab === 'sell'} onClick={setTab} />
        {manager && <TabButton id="products" label={t("pos.tabs.products")} icon={Tag} active={tab === 'products'} onClick={setTab} />}
        <TabButton id="history" label={t("pos.tabs.history")} icon={Receipt} active={tab === 'history'} onClick={setTab} />
        {v4 && <TabButton id="customers" label={t("pos.tabs.customers")} icon={UserCheck} active={tab === 'customers'} onClick={setTab} />}
        {v4 && <TabButton id="drawer" label={t("pos.tabs.drawer")} icon={Wallet} active={tab === 'drawer'} onClick={setTab} />}
        {clockOk && <TabButton id="clock" label={t("pos.tabs.clock")} icon={Clock3} active={tab === 'clock'} onClick={setTab} />}
        {manager && <TabButton id="reports" label={t("pos.tabs.reports")} icon={BarChart3} active={tab === 'reports'} onClick={setTab} />}
        <TabButton id="team" label={t("pos.tabs.team")} icon={Users} active={tab === 'team'} onClick={setTab} />
        {manager && <TabButton id="settings" label={t("pos.tabs.settings")} icon={SettingsIcon} active={tab === 'settings'} onClick={setTab} />}

        <div className="ml-auto flex shrink-0 items-center gap-2">
          {v4 && (
            pinStaff ? (
              <button
                type="button"
                onClick={() => setPinStaff(null)}
                title={t('pos.tabs2.signOutCashierTitle')}
                className="flex items-center gap-1.5 rounded-os bg-paper px-2.5 py-1.5 text-xs font-medium text-ink duration-160 hover:border-accent"
              >
                <KeyRound size={13} className="text-accent" />
                {pinStaff.name}
                <span className="text-muted">· {ROLE_LABEL[pinStaff.role]}</span>
                <X size={13} className="text-muted" />
              </button>
            ) : (
              <button
                type="button"
                onClick={() => { setPinError(''); setPinPadOpen(true); }}
                title={t('pos.tabs2.cashierSignInTitle')}
                className="flex items-center gap-1.5 rounded-os border border-osborder bg-paper px-2.5 py-1.5 text-xs font-medium text-muted duration-160 hover:border-accent hover:text-ink"
              >
                <KeyRound size={13} /> {t('pos.tabs2.cashierSignIn')}
              </button>
            )
          )}
          {manager && !kiosk && (
            <button
              type="button"
              onClick={() => { setPosModeError(''); setPosModeOpen(true); }}
              title={t('pos.tabs2.posModeLockTitle')}
              className="flex items-center gap-1.5 rounded-os border border-osborder bg-paper px-2.5 py-1.5 text-xs font-medium text-muted duration-160 hover:border-accent hover:text-ink"
            >
              <Lock size={13} /> {t('pos.ui.posMode')}
            </button>
          )}
          {!kiosk && stores.length > 1 && (
            <select
              value={storeId}
              onChange={(e) => { setStoreId(e.target.value); setTab('sell'); }}
              className="max-w-44 rounded-os border border-osborder bg-paper px-2 py-1.5 text-sm text-ink"
              title="Switch store"
            >
              {stores.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          )}
          {!kiosk && store.role === 'owner' && (
            <button
              type="button"
              onClick={() => setShowCreate(true)}
              title="Open another store"
              aria-label="Open another store"
              className="rounded-os border border-osborder bg-paper p-1.5 text-muted hover:border-accent hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              <Plus size={15} />
            </button>
          )}
          <span className="hidden items-center gap-1.5 text-xs text-muted sm:flex" title={`Your role: ${ROLE_LABEL[effectiveRole]}`}>
            <span className="font-medium text-ink">{store.name}</span>
            <span className="rounded-os bg-paper px-1.5 py-0.5">{ROLE_LABEL[effectiveRole]}</span>
          </span>
        </div>
      </div>

      {caps && !caps.v4 && manager && (
        <div className="border-b border-osborder bg-paper px-4 py-2">
          <p className="flex items-center gap-2 text-xs text-muted">
            <AlertCircle size={14} className="shrink-0 text-accent" />
            <span>
              <span className="font-medium text-ink">{t('pos.tabs2.posUpgrade')}</span>{' '}
              {t('pos.tabs2.posUpgradePre')}
              <span className="font-mono">supabase/migrations/004_pos_features.sql</span>
              {t('pos.tabs2.posUpgradePost')}
            </span>
          </p>
        </div>
      )}

      {error && (
        <div className="px-4 pt-2"><ErrorNote message={error} /></div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {loadingStore ? (
          <div className="flex h-full items-center justify-center">
            <p className="text-sm text-muted">Loading {store.name}…</p>
          </div>
        ) : (
          <>
            {tab === 'sell' && (
              <SellTab
                key={store.id}
                products={activeProducts}
                store={store}
                v4={v4}
                extras={extras}
                giftCards={giftCards}
                customers={customers}
                customerId={customerId}
                onCustomerChange={setCustomerId}
                cashier={pinStaff ? { name: pinStaff.name, pinId: pinStaff.id } : { name: cashierName, pinId: null }}
                onSaleComplete={recordSale}
                onCustomersChanged={refreshCustomers}
                seedLines={seedLines}
                onSeedConsumed={() => setSeedLines(null)}
                orgs={orgs}
                orgId={orgId}
                onOrgChange={setOrgId}
                orgsOk={orgsOk}
              />
            )}
            {tab === 'products' && manager && (
              <ProductsTab
                store={store}
                products={products}
                v4={v4}
                onSave={saveProduct}
                onDelete={deleteProduct}
                onToggleActive={toggleProductActive}
                onAdjustStock={adjustStock}
              />
            )}
            {tab === 'history' && (
              <HistoryTab
                store={store}
                sales={sales}
                memberName={memberName}
                onVoid={voidSale}
                onRefund={refundsOk ? handleRefund : null}
                onExchange={refundsOk ? handleExchange : null}
                extras={extras}
                refundsOk={refundsOk}
                orgsOk={orgsOk}
                selfId={selfId}
                role={effectiveRole}
                cashierName={pinStaff?.name || null}
              />
            )}
            {tab === 'customers' && v4 && (
              <CustomersTab
                store={store}
                customers={customers}
                sales={sales}
                onSave={saveCustomer}
                onDelete={deleteCustomer}
                extras={extras}
                orgsOk={orgsOk}
                orgs={orgs}
                onOrgsChanged={refreshOrgs}
              />
            )}
            {tab === 'drawer' && v4 && (
              <DrawerTab store={store} sales={sales} role={effectiveRole} cashierName={cashierName} extras={extras} />
            )}
            {tab === 'clock' && clockOk && (
              <ClockTab store={store} />
            )}
            {tab === 'reports' && manager && (
              <ReportsTab store={store} sales={sales} memberName={memberName} extras={extras} />
            )}
            {tab === 'team' && (
              <TeamTab
                store={store}
                members={members}
                selfId={selfId}
                v4={v4}
                onInvite={createInvite}
                onRevokeInvite={revokeInvite}
                onSetRole={setMemberRole}
                onRemove={removeMember}
                onLeave={leaveStore}
              />
            )}
            {tab === 'settings' && manager && (
              <SettingsTabPane store={store} v4={v4} onSave={saveSettings} extras={extras} />
            )}
          </>
        )}
      </div>

      {pinPadOpen && (
        <PinPadModal
          title={t('pos.tabs2.cashierSignIn')}
          subtitle={t('pos.tabs2.cashierSignInHint')}
          error={pinError}
          busy={pinBusy}
          onSubmit={submitPin}
          onClose={() => setPinPadOpen(false)}
        />
      )}

      {posModeOpen && (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center bg-ink/30 p-4"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget && !posModeBusy) setPosModeOpen(false);
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label={t('pos.ui.enterPosMode')}
            className="w-full max-w-md rounded-os border border-osborder bg-surface shadow-win"
          >
            <div className="flex items-center justify-between border-b border-osborder px-4 py-3">
              <h3 className="flex items-center gap-2 text-sm font-semibold text-ink">
                <Lock size={16} className="text-accent" /> {t('pos.ui.enterPosMode')}
              </h3>
              <button
                type="button"
                onClick={() => !posModeBusy && setPosModeOpen(false)}
                aria-label="Close dialog"
                className="rounded-os p-1 text-muted hover:bg-paper hover:text-ink"
              >
                <X size={16} />
              </button>
            </div>
            <div className="p-4">
              <p className="text-sm text-ink">
                {t('pos.ui.lockDevice', { store: store.name })}
              </p>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted">
                <li>{t('pos.tabs2.registerOnly')}</li>
                <li>{t('pos.tabs2.cashierPinNote')}</li>
                <li>{t('pos.tabs2.lockNote')}</li>
              </ul>
              {posModeError && (
                <p role="alert" className="mt-3 rounded-os border border-red-700/30 bg-red-700/5 px-3 py-2 text-xs font-medium text-red-700">
                  {posModeError}
                </p>
              )}
              <div className="mt-5 flex justify-end gap-2">
                <button
                  type="button"
                  disabled={posModeBusy}
                  onClick={() => setPosModeOpen(false)}
                  className="rounded-os border border-osborder px-3 py-1.5 text-sm text-ink hover:bg-paper disabled:opacity-50"
                >
                  {t('common.cancel')}
                </button>
                <button
                  type="button"
                  disabled={posModeBusy}
                  onClick={confirmPOSMode}
                  className="rounded-os bg-accent px-4 py-1.5 text-sm font-medium text-accentink hover:opacity-90 disabled:opacity-50"
                >
                  {posModeBusy ? 'Checking…' : 'Lock this device'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {showCreate && (
        <CreateStoreModal
          onClose={() => setShowCreate(false)}
          onCreated={async (s) => {
            setShowCreate(false);
            try {
              // Generic default: two editable tax slots at 0%. The owner sets
              // the real names and rates in the Settings tab afterwards —
              // taxes are per-store settings, never hardcoded.
              await backend.pos.updateStore(s.id, {
                taxRates: [
                  { name: 'Tax 1', rate: 0 },
                  { name: 'Tax 2', rate: 0 },
                ],
              });
            } catch (err) {
              // Non-fatal: the store exists, taxes can be set in Settings.
              console.warn('Could not apply default tax rates:', err);
            }
            try {
              await refreshStores(s.id);
            } catch (err) {
              // The store was created — only the list refresh failed. Surface
              // it honestly instead of dropping the rejection.
              setError(err.message || 'Store created, but the store list could not be refreshed.');
            }
            setTab('sell');
          }}
        />
      )}
    </div>
  );
}
