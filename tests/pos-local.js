// POS v4 feature tests for the local adapter (node, localStorage stubbed).
// Covers: capabilities, rich products, inventory decrement/restock,
// customers, staff PIN login, drawer shifts, 'other' tender, void reasons.
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};

const { createLocalBackend } = await import('../src/lib/backend/local.js');

const backend = createLocalBackend();
await backend.auth.signUp({ email: 'pos-test@test.dev', password: 'password123', username: 'postest' });
const pos = backend.pos;
let passed = 0;
function assert(cond, msg) {
  if (!cond) throw new Error('ASSERT FAILED: ' + msg);
  passed++;
  console.log('PASS', msg);
}

// capabilities
const caps = await pos.capabilities();
assert(caps.v4 === true, 'capabilities() reports v4');

// store carries taxRates
const stores = await pos.listStores();
assert(Array.isArray(stores[0].taxRates), 'store exposes taxRates array');
const updated = await pos.updateStore('local', {
  taxRates: [{ name: 'GST', rate: 5 }, { name: 'PST', rate: 8 }],
});
assert(updated.taxRates.length === 2 && updated.taxRates[0].rate === 5, 'stacked tax rates saved');

// rich product round-trip
const prod = await pos.saveProduct('local', {
  name: 'Test Shirt',
  priceCents: 2500,
  sku: 'TS-1',
  costCents: 1000,
  trackStock: true,
  stock: 10,
  lowStockThreshold: 2,
  imageUrl: 'https://example.com/shirt.png',
  variants: [{ id: 'v1', name: 'Large', priceDeltaCents: 200, sku: 'TS-1-L' }],
});
assert(
  prod.stock === 10 && prod.trackStock && prod.variants.length === 1 && prod.costCents === 1000,
  'product v4 fields round-trip'
);

// customers
const cust = await pos.saveCustomer('local', { name: 'Ada', phone: '555-1234' });
assert(cust.id && cust.name === 'Ada', 'customer saved');
assert((await pos.listCustomers('local')).length === 1, 'customer listed');

// staff PINs: hash never leaks, login works, wrong PIN rejected
const sm = await pos.saveStaff('local', { name: 'Sam', role: 'cashier', pin: '1234' });
assert(!('pinHash' in sm) && !('pin_hash' in sm), 'saveStaff does not leak hash');
const staffList = await pos.listStaff('local');
assert(staffList.length === 1 && !('pinHash' in staffList[0]), 'listStaff does not leak hash');
const login = await pos.staffLogin('local', '1234');
assert(login.name === 'Sam' && login.role === 'cashier', 'correct PIN logs in');
let rejected = false;
try {
  await pos.staffLogin('local', '9999');
} catch (e) {
  rejected = /Invalid PIN/.test(e.message);
}
assert(rejected, 'wrong PIN rejected');
await pos.saveStaff('local', { id: sm.id, name: 'Sam', role: 'cashier', active: false });
rejected = false;
try {
  await pos.staffLogin('local', '1234');
} catch {
  rejected = true;
}
assert(rejected, 'inactive staff cannot log in');
await pos.saveStaff('local', { id: sm.id, name: 'Sam', role: 'cashier', active: true });

// drawer open
const shift = await pos.openDrawer('local', { amountCents: 5000, byName: 'Sam' });
assert(shift.openAmountCents === 5000 && !shift.closedAt, 'drawer shift opened');

// sale: 'other' tender + attribution + stock decrement
const sale = await pos.recordSale('local', {
  items: [
    {
      productId: prod.id,
      variantId: 'v1',
      variantName: 'Large',
      name: 'Test Shirt',
      priceCents: 2700,
      qty: 2,
      itemDiscountCents: 100,
    },
  ],
  subtotalCents: 5300,
  discountCents: 0,
  taxCents: 265,
  totalCents: 5565,
  method: 'other',
  tenderedCents: 5565,
  changeCents: 0,
  cashierName: 'Sam',
  staffPinId: sm.id,
  customerId: cust.id,
});
assert(sale.method === 'other', "'other' tender recorded");
assert(sale.cashierName === 'Sam' && sale.customerName === 'Ada', 'sale attribution stored');
let products = await pos.listProducts('local');
assert(products.find((p) => p.id === prod.id).stock === 8, 'stock decremented by sale');

// adjustStock
await pos.adjustStock('local', prod.id, 5);
products = await pos.listProducts('local');
assert(products.find((p) => p.id === prod.id).stock === 13, 'adjustStock works');

// void with reason restocks
await pos.voidSale('local', sale.id, 'customer return');
products = await pos.listProducts('local');
assert(products.find((p) => p.id === prod.id).stock === 15, 'stock restocked on void');
const vs = (await pos.listSales('local')).find((s) => s.id === sale.id);
assert(vs.voided && vs.voidReason === 'customer return', 'void reason stored');

// drawer close with expected/variance
await pos.closeDrawer('local', shift.id, { amountCents: 4900, expectedCents: 5000, note: 'short $1' });
const closed = (await pos.listDrawerShifts('local'))[0];
assert(closed.closedAt && closed.expectedCents === 5000 && closed.note === 'short $1', 'drawer closed with variance data');

// legacy records still load with defaults
const legacy = await pos.saveProduct('local', { name: 'Legacy', priceCents: 100 });
assert(legacy.trackStock === false && legacy.stock === 0 && legacy.variants.length === 0, 'legacy product defaults');

// cleanup
await pos.deleteProduct('local', prod.id);
await pos.deleteProduct('local', legacy.id);
await pos.deleteCustomer('local', cust.id);
await pos.deleteStaff('local', sm.id);
assert((await pos.listCustomers('local')).length === 0, 'customer deleted');
assert((await pos.listStaff('local')).length === 0, 'staff deleted');

console.log(`\nALL ${passed} POS LOCAL TESTS PASSED`);
