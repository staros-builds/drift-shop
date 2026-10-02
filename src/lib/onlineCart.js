/**
 * Customer cart for online ordering (src/lib/onlineCart.js).
 *
 * Pure, side-effect-free functions so they run in node tests without a
 * browser (test/online-cart.test.mjs). The storefront page
 * (src/apps/StorefrontPublic.jsx) persists the cart per shop in
 * localStorage and calls the server RPCs in src/lib/onlineOrders.js.
 *
 * Trust model: the cart is a convenience for the customer. NOTHING here
 * is trusted by the server — online_order_place() re-derives every
 * product, price, stock check and tax line from the database and rejects
 * tampered drafts with stable error codes.
 */

import { taxLinesFor } from './taxMath.js';

export const CART_KEY_PREFIX = 'driftshop:cart:';
export const MAX_CART_LINES = 50; // matches the server RPC
export const MAX_LINE_QTY = 999; // matches the server RPC + sale bounds

export function cartKey(slug) {
  // The key carries the shop slug so carts never leak between shops.
  return `${CART_KEY_PREFIX}${String(slug || '').toLowerCase()}`;
}

export function emptyCart() {
  return { lines: [] };
}

// A cart line: { productId, name, unitPriceCents, qty }
// name/unitPriceCents are display snapshots from the price book; the
// server re-prices everything at order time.
export function addLine(cart, product, qty = 1) {
  const next = { lines: (cart?.lines || []).map((l) => ({ ...l })) };
  const id = String(product?.id || '');
  if (!id) return next;
  const add = Math.max(1, Math.min(MAX_LINE_QTY, Math.round(Number(qty) || 1)));
  const existing = next.lines.find((l) => l.productId === id);
  if (existing) {
    existing.qty = Math.min(MAX_LINE_QTY, existing.qty + add);
    existing.name = String(product.name ?? existing.name ?? '');
    existing.unitPriceCents = Math.max(0, Math.round(Number(product.priceCents ?? product.price ?? existing.unitPriceCents) || 0));
  } else {
    if (next.lines.length >= MAX_CART_LINES) return next;
    next.lines.push({
      productId: id,
      name: String(product.name ?? ''),
      unitPriceCents: Math.max(0, Math.round(Number(product.priceCents ?? product.price ?? 0) || 0)),
      qty: add,
    });
  }
  return next;
}

export function setLineQty(cart, productId, qty) {
  const next = { lines: (cart?.lines || []).map((l) => ({ ...l })) };
  const n = Math.max(0, Math.min(MAX_LINE_QTY, Math.round(Number(qty) || 0)));
  next.lines = next.lines
    .map((l) => (l.productId === productId ? { ...l, qty: n } : l))
    .filter((l) => l.qty > 0);
  return next;
}

export function removeLine(cart, productId) {
  return setLineQty(cart, productId, 0);
}

export function cartCount(cart) {
  return (cart?.lines || []).reduce((s, l) => s + (l.qty || 0), 0);
}

export function cartSubtotalCents(cart) {
  return (cart?.lines || []).reduce(
    (s, l) => s + (l.unitPriceCents || 0) * (l.qty || 0),
    0
  );
}

// Totals for the cart preview. priceBook maps productId -> { priceCents }.
// Lines priced from the book (so a changed price shows immediately); the
// line's snapshot price is kept for the price-changed flag.
export function cartTotals(cart, priceBook = {}, taxCfg = {}) {
  const lines = (cart?.lines || []).map((l) => {
    const book = priceBook[l.productId];
    const price = book && book.priceCents != null
      ? Math.max(0, Math.round(Number(book.priceCents) || 0))
      : (l.unitPriceCents || 0);
    return {
      ...l,
      currentPriceCents: price,
      priceChanged: price !== (l.unitPriceCents || 0),
      lineTotalCents: price * (l.qty || 0),
    };
  });
  const subtotalCents = lines.reduce((s, l) => s + l.lineTotalCents, 0);
  // Reuse the till's own tax math so the preview matches the receipt.
  const taxRows = taxLinesFor(
    { taxRates: taxCfg.rates, taxRate: taxCfg.legacyRate },
    subtotalCents
  );
  const taxCents = taxRows.reduce((s, r) => s + (r.cents || 0), 0);
  const priceChanged = lines.some((l) => l.priceChanged);
  return { lines, subtotalCents, taxRows, taxCents, totalCents: subtotalCents + taxCents, priceChanged };
}

// Client-side sanity before asking the server. The server enforces all
// of this again; this only shapes the error the customer sees first.
export function validateCartForOrder(cart) {
  const lines = cart?.lines || [];
  if (lines.length === 0) return 'empty';
  if (lines.length > MAX_CART_LINES) return 'tooManyLines';
  for (const l of lines) {
    if (!l.productId) return 'badLine';
    if (!Number.isInteger(l.qty) || l.qty < 1 || l.qty > MAX_LINE_QTY) return 'badQty';
  }
  return null;
}

// The exact payload sent to online_order_place(). Quantities only —
// prices and taxes are recomputed server-side.
export function cartToOrderItems(cart) {
  return (cart?.lines || []).map((l) => ({
    product_id: l.productId,
    qty: l.qty,
  }));
}

export function loadCart(storage, slug) {
  try {
    const raw = storage.getItem(cartKey(slug));
    if (!raw) return emptyCart();
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.lines)) return emptyCart();
    return {
      lines: parsed.lines
        .filter((l) => l && l.productId)
        .slice(0, MAX_CART_LINES)
        .map((l) => ({
          productId: String(l.productId),
          name: String(l.name ?? ''),
          unitPriceCents: Math.max(0, Math.round(Number(l.unitPriceCents) || 0)),
          qty: Math.max(0, Math.min(MAX_LINE_QTY, Math.round(Number(l.qty) || 0))),
        }))
        .filter((l) => l.qty > 0),
    };
  } catch {
    return emptyCart();
  }
}

export function saveCart(storage, slug, cart) {
  try {
    storage.setItem(cartKey(slug), JSON.stringify({ lines: (cart?.lines || []).slice(0, MAX_CART_LINES) }));
  } catch {
    /* private mode — the cart lives for this session only */
  }
}

export function clearCart(storage, slug) {
  try {
    storage.removeItem(cartKey(slug));
  } catch {
    /* noop */
  }
}
