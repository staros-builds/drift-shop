/**
 * Adversarial unit tests for the customer cart (src/lib/onlineCart.js).
 * Run: node test/online-cart.test.mjs
 *
 * Covers: per-shop key isolation, add/set/remove line semantics, the
 * 1–999 qty clamp and 50-line cap (mirroring the server RPC bounds),
 * price-change detection in the totals preview, tax preview through the
 * till's own tax math, validate-before-place, the quantities-only order
 * payload, and localStorage round-trip / corruption recovery.
 */
import assert from 'node:assert/strict';
import {
  CART_KEY_PREFIX, MAX_CART_LINES, MAX_LINE_QTY,
  cartKey, emptyCart, addLine, setLineQty, removeLine,
  cartCount, cartSubtotalCents, cartTotals, validateCartForOrder,
  cartToOrderItems, loadCart, saveCart, clearCart,
} from '../src/lib/onlineCart.js';

let n = 0;
function check(name, fn) {
  n++;
  try {
    fn();
    console.log(`  ok ${n} - ${name}`);
  } catch (e) {
    console.error(`  FAIL ${n} - ${name}: ${e.message}`);
    process.exitCode = 1;
  }
}

console.log('onlineCart');

check('cartKey isolates shops and is case-insensitive', () => {
  assert.equal(cartKey('Heavy-Test'), cartKey('heavy-test'));
  assert.notEqual(cartKey('shop-a'), cartKey('shop-b'));
  assert.ok(cartKey('shop-a').startsWith(CART_KEY_PREFIX));
  assert.equal(cartKey(''), CART_KEY_PREFIX);
});

check('addLine merges the same product and clamps qty to 999', () => {
  let c = emptyCart();
  c = addLine(c, { id: 'p1', name: 'Widget', priceCents: 1250 }, 2);
  c = addLine(c, { id: 'p1', name: 'Widget', priceCents: 1250 }, 9999);
  assert.equal(c.lines.length, 1);
  assert.equal(c.lines[0].qty, 999);
  assert.equal(c.lines[0].unitPriceCents, 1250);
});

check('addLine rejects absurd quantities: 0, negative, NaN become 1', () => {
  let c = emptyCart();
  c = addLine(c, { id: 'p1', name: 'W', priceCents: 100 }, 0);
  assert.equal(c.lines[0].qty, 1);
  c = emptyCart();
  c = addLine(c, { id: 'p1', name: 'W', priceCents: 100 }, -50);
  assert.equal(c.lines[0].qty, 1);
  c = emptyCart();
  c = addLine(c, { id: 'p1', name: 'W', priceCents: 100 }, 'junk');
  assert.equal(c.lines[0].qty, 1);
});

check('addLine caps the cart at 50 lines (spam/abuse bound)', () => {
  let c = emptyCart();
  for (let i = 0; i < 60; i++) {
    c = addLine(c, { id: `p${i}`, name: `Item ${i}`, priceCents: 100 }, 1);
  }
  assert.equal(c.lines.length, MAX_CART_LINES);
  assert.equal(MAX_CART_LINES, 50);
});

check('addLine with no product id is a no-op', () => {
  let c = emptyCart();
  c = addLine(c, { name: 'No id', priceCents: 100 }, 1);
  assert.equal(c.lines.length, 0);
});

check('setLineQty clamps and removes at 0', () => {
  let c = addLine(emptyCart(), { id: 'p1', name: 'W', priceCents: 100 }, 3);
  c = setLineQty(c, 'p1', 2000);
  assert.equal(c.lines[0].qty, 999);
  c = setLineQty(c, 'p1', 0);
  assert.equal(c.lines.length, 0);
  c = addLine(emptyCart(), { id: 'p1', name: 'W', priceCents: 100 }, 3);
  c = removeLine(c, 'p1');
  assert.equal(c.lines.length, 0);
});

check('setLineQty on an unknown product leaves the cart alone', () => {
  let c = addLine(emptyCart(), { id: 'p1', name: 'W', priceCents: 100 }, 2);
  c = setLineQty(c, 'nope', 5);
  assert.equal(c.lines.length, 1);
  assert.equal(c.lines[0].qty, 2);
});

check('cartCount and cartSubtotalCents do plain integer math', () => {
  let c = emptyCart();
  c = addLine(c, { id: 'p1', name: 'A', priceCents: 1250 }, 2); // 2500
  c = addLine(c, { id: 'p2', name: 'B', priceCents: 99 }, 3);    //  297
  assert.equal(cartCount(c), 5);
  assert.equal(cartSubtotalCents(c), 2797);
});

check('cartTotals previews taxes through the till tax math', () => {
  let c = addLine(emptyCart(), { id: 'p1', name: 'A', priceCents: 1000 }, 1);
  const t = cartTotals(c, { p1: { priceCents: 1000 } }, { rates: [{ name: 'GST', rate: 5 }] });
  assert.equal(t.subtotalCents, 1000);
  assert.equal(t.taxCents, 50);
  assert.equal(t.totalCents, 1050);
  assert.equal(t.taxRows.length, 1);
  assert.equal(t.priceChanged, false);
});

check('cartTotals flags a changed price and uses the CURRENT price', () => {
  let c = addLine(emptyCart(), { id: 'p1', name: 'A', priceCents: 1000 }, 1);
  const t = cartTotals(c, { p1: { priceCents: 1500 } }, {});
  assert.equal(t.priceChanged, true);
  assert.equal(t.lines[0].priceChanged, true);
  assert.equal(t.subtotalCents, 1500);
  assert.equal(t.lines[0].unitPriceCents, 1000); // snapshot kept for the note
});

check('cartTotals never emits negative prices from a hostile price book', () => {
  let c = addLine(emptyCart(), { id: 'p1', name: 'A', priceCents: 1000 }, 1);
  const t = cartTotals(c, { p1: { priceCents: -999 } }, {});
  assert.equal(t.subtotalCents, 0);
});

check('validateCartForOrder: empty / too many lines / bad qty', () => {
  assert.equal(validateCartForOrder(emptyCart()), 'empty');
  let c = emptyCart();
  for (let i = 0; i < 51; i++) {
    c = { lines: [...c.lines, { productId: `p${i}`, name: 'X', unitPriceCents: 1, qty: 1 }] };
  }
  assert.equal(validateCartForOrder(c), 'tooManyLines');
  assert.equal(validateCartForOrder({ lines: [{ productId: 'p1', name: 'X', unitPriceCents: 1, qty: 0 }] }), 'badQty');
  assert.equal(validateCartForOrder({ lines: [{ productId: 'p1', name: 'X', unitPriceCents: 1, qty: 1000 }] }), 'badQty');
  assert.equal(validateCartForOrder({ lines: [{ productId: '', name: 'X', unitPriceCents: 1, qty: 1 }] }), 'badLine');
  let ok = addLine(emptyCart(), { id: 'p1', name: 'X', priceCents: 1 }, 1);
  assert.equal(validateCartForOrder(ok), null);
});

check('cartToOrderItems sends quantities only — never prices', () => {
  let c = addLine(emptyCart(), { id: 'p1', name: 'A', priceCents: 1000 }, 2);
  const items = cartToOrderItems(c);
  assert.deepEqual(items, [{ product_id: 'p1', qty: 2 }]);
  assert.ok(!('unitPriceCents' in items[0]) && !('price' in items[0]));
});

check('localStorage round-trip, corrupt JSON, and per-shop clearing', () => {
  const mem = {};
  const storage = {
    getItem: (k) => (k in mem ? mem[k] : null),
    setItem: (k, v) => { mem[k] = String(v); },
    removeItem: (k) => { delete mem[k]; },
  };
  let c = addLine(emptyCart(), { id: 'p1', name: 'A', priceCents: 100 }, 2);
  saveCart(storage, 'shop-a', c);
  saveCart(storage, 'shop-b', addLine(emptyCart(), { id: 'p2', name: 'B', priceCents: 50 }, 1));
  const back = loadCart(storage, 'shop-a');
  assert.equal(back.lines.length, 1);
  assert.equal(back.lines[0].productId, 'p1');
  assert.equal(back.lines[0].qty, 2);
  // corrupt JSON resets to an empty cart instead of throwing
  mem[cartKey('shop-a')] = '{broken json';
  assert.deepEqual(loadCart(storage, 'shop-a'), emptyCart());
  // clearing one shop keeps the other
  clearCart(storage, 'shop-b');
  assert.equal(loadCart(storage, 'shop-a').lines.length, 0);
  const bAfter = loadCart(storage, 'shop-a');
  assert.deepEqual(bAfter, emptyCart());
  mem[cartKey('shop-c')] = JSON.stringify({ lines: [{ productId: 'p9', name: 'N', unitPriceCents: 1, qty: 1 }] });
  clearCart(storage, 'shop-c');
  assert.equal(storage.getItem(cartKey('shop-c')), null);
});

check('loadCart on missing storage methods is inert', () => {
  assert.deepEqual(loadCart({}, 'shop-a'), emptyCart());
  saveCart({}, 'shop-a', emptyCart()); // must not throw
  clearCart({}, 'shop-a'); // must not throw
});

console.log(`\n${n} checks done`);
