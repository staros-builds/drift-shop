// Nuclear QA — authenticated adversarial suite against the live backend.
// Creates clearly-named NUCLEARQA accounts/shops, attacks them, and records
// verdicts. Companion cleanup: tests/nuclear/cleanup.mjs deletes the shops
// (auth users remain, named nuclearqa-*, until the pre-ship factory reset).
// Usage: node tests/nuclear/live-api.mjs
import fs from 'node:fs';
import crypto from 'node:crypto';

const cfg = JSON.parse(fs.readFileSync('/tmp/ds-env.json', 'utf8'));
const URL_ = cfg.url, KEY = cfg.key;
const STATE_PATH = '/tmp/ds-qa-state.json';
const PW = 'Nq!' + crypto.randomBytes(9).toString('base64url') + '9x';

let pass = 0, fail = 0, blocked = 0;
const results = [];
function rec(status, name, detail = '') {
  results.push({ status, name, detail });
  if (status === 'PASS') pass++; else if (status === 'FAIL') fail++; else blocked++;
  console.log(`${status}  ${name}${detail ? ' — ' + String(detail).slice(0, 180) : ''}`);
}

async function req(method, path, { token, body, prefer } = {}) {
  const headers = { apikey: KEY, 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (prefer) headers.Prefer = prefer;
  const r = await fetch(`${URL_}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* */ }
  return { status: r.status, text, json };
}
const rpc = (token, fn, body) => req('POST', `/rest/v1/rpc/${fn}`, { token, body });

async function signup(email) {
  const r = await req('POST', '/auth/v1/signup', { body: { email, password: PW } });
  if (!r.json?.access_token) throw new Error(`signup ${email} failed: ${r.status} ${r.text.slice(0, 160)}`);
  return { token: r.json.access_token, id: r.json.user.id, email };
}

// ---------------------------------------------------------------- setup
const stamp = Date.now().toString(36);
const A = await signup(`nuclearqa-a-${stamp}@drift-shop.app`);
const B = await signup(`nuclearqa-b-${stamp}@drift-shop.app`);
const C = await signup(`nuclearqa-c-${stamp}@drift-shop.app`);
rec('PASS', 'QA accounts A/B/C signed up', `${A.id.slice(0, 8)}/${B.id.slice(0, 8)}/${C.id.slice(0, 8)}`);

async function makeStore(user, name) {
  const r = await req('POST', '/rest/v1/pos_stores', {
    token: user.token, prefer: 'return=representation',
    body: { name, created_by: user.id },
  });
  if (r.status >= 300 || !r.json?.[0]) throw new Error(`store create failed ${r.status} ${r.text.slice(0, 200)}`);
  return r.json[0];
}
const SA = await makeStore(A, `NUCLEARQA Shop A ${stamp}`);
const SB = await makeStore(B, `NUCLEARQA Shop B ${stamp}`);
rec('PASS', 'QA shops created', `SA=${SA.id.slice(0, 8)} SB=${SB.id.slice(0, 8)}`);

// A adds C as cashier of SA (manager member-insert path)
{
  const r = await req('POST', '/rest/v1/pos_store_members', {
    token: A.token, prefer: 'return=representation',
    body: { store_id: SA.id, user_id: C.id, role: 'cashier' },
  });
  rec(r.status < 300 ? 'PASS' : 'FAIL', 'owner adds cashier member', `http=${r.status} ${r.text.slice(0, 100)}`);
}
// products
async function makeProduct(user, storeId, body) {
  return req('POST', '/rest/v1/pos_products', { token: user.token, prefer: 'return=representation', body: { store_id: storeId, ...body } });
}
const PA = (await makeProduct(A, SA.id, { name: 'NUCLEARQA Widget', price_cents: 1250, stock: 5, track_stock: true })).json?.[0];
const PB = (await makeProduct(B, SB.id, { name: 'NUCLEARQA B Widget', price_cents: 500, stock: 3, track_stock: true })).json?.[0];
rec(PA && PB ? 'PASS' : 'FAIL', 'products created', `PA=${PA?.id?.slice(0, 8)} PB=${PB?.id?.slice(0, 8)}`);

const state = { A, B, C, SA: SA.id, SB: SB.id, PA: PA?.id, PB: PB?.id, created: new Date().toISOString() };
fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));

// ------------------------------------------------------- cross-shop isolation
const iso = async (user, path, label) => {
  const r = await req('GET', path, { token: user.token });
  const rows = Array.isArray(r.json) ? r.json.length : -1;
  rec(rows === 0 ? 'PASS' : 'FAIL', label, `http=${r.status} rows=${rows}`);
};
await iso(B, `/rest/v1/pos_products?store_id=eq.${SA.id}&select=id`, 'B cannot list A products');
await iso(B, `/rest/v1/pos_stores?id=eq.${SA.id}&select=id`, 'B cannot see A store row');
await iso(B, `/rest/v1/storefront_profiles?store_id=eq.${SA.id}&select=id`, 'B cannot see A storefront profile');
await iso(B, `/rest/v1/pos_customers?store_id=eq.${SA.id}&select=id`, 'B cannot list A customers');
await iso(B, `/rest/v1/pos_appointments?store_id=eq.${SA.id}&select=id`, 'B cannot list A appointments');
await iso(B, `/rest/v1/pos_gift_cards?store_id=eq.${SA.id}&select=id`, 'B cannot list A gift cards');
await iso(B, `/rest/v1/profiles?id=eq.${A.id}&select=id,username`, 'B cannot read A profile');
await iso(A, `/rest/v1/profiles?id=eq.${B.id}&select=id,username`, 'A cannot read B profile (not teammates)');

{ // B writes into A's shop
  const r = await makeProduct(B, SA.id, { name: 'NUCLEARQA intruder', price_cents: 100 });
  rec(r.status >= 400 ? 'PASS' : 'FAIL', 'B cannot insert product into A shop', `http=${r.status}`);
  const u = await req('PATCH', `/rest/v1/pos_products?id=eq.${PA.id}`, { token: B.token, prefer: 'return=representation', body: { price_cents: 1 } });
  const changed = Array.isArray(u.json) && u.json.length > 0;
  rec(!changed ? 'PASS' : 'FAIL', 'B cannot reprice A product', `http=${u.status} changed=${changed}`);
  const d = await req('DELETE', `/rest/v1/pos_products?id=eq.${PA.id}`, { token: B.token, prefer: 'return=representation' });
  const deleted = Array.isArray(d.json) && d.json.length > 0;
  rec(!deleted ? 'PASS' : 'FAIL', 'B cannot delete A product', `http=${d.status} deleted=${deleted}`);
  const check = await req('GET', `/rest/v1/pos_products?id=eq.${PA.id}&select=price_cents`, { token: A.token });
  rec(check.json?.[0]?.price_cents === 1250 ? 'PASS' : 'FAIL', 'A product intact after B attacks', JSON.stringify(check.json));
}

// ------------------------------------------------------- role escalation
{ // cashier C self-promotion attempts
  const u = await req('PATCH', `/rest/v1/pos_store_members?store_id=eq.${SA.id}&user_id=eq.${C.id}`, {
    token: C.token, prefer: 'return=representation', body: { role: 'owner' },
  });
  const promoted = Array.isArray(u.json) && u.json.some((m) => m.role === 'owner');
  rec(!promoted ? 'PASS' : 'FAIL', 'cashier cannot self-promote to owner', `http=${u.status} ${u.text.slice(0, 100)}`);
  const ins = await req('POST', '/rest/v1/pos_store_members', {
    token: C.token, prefer: 'return=representation',
    body: { store_id: SA.id, user_id: B.id, role: 'owner' },
  });
  rec(ins.status >= 400 ? 'PASS' : 'FAIL', 'cashier cannot add members', `http=${ins.status}`);
  const pu = await req('PATCH', `/rest/v1/pos_products?id=eq.${PA.id}`, { token: C.token, prefer: 'return=representation', body: { price_cents: 999 } });
  const changed = Array.isArray(pu.json) && pu.json.length > 0;
  rec(!changed ? 'PASS' : 'FAIL', 'cashier cannot edit product price', `http=${pu.status} changed=${changed}`);
}
{ // privileged RPCs as ordinary users
  const fr = await rpc(A.token, 'factory_reset', {});
  rec(fr.status >= 400 || /master|restricted|only/i.test(fr.text) ? 'PASS' : 'FAIL', 'non-master factory_reset refused', `http=${fr.status} ${fr.text.slice(0, 110)}`);
  const ac = await rpc(A.token, 'admin_create_user', { p_email: 'nuclearqa-evil@drift-shop.app', p_password: 'Whatever123!' });
  rec(ac.status >= 400 || /admin|master|restricted|only/i.test(ac.text) ? 'PASS' : 'FAIL', 'non-admin admin_create_user refused', `http=${ac.status} ${ac.text.slice(0, 110)}`);
  const sr = await rpc(A.token, 'admin_set_role', { p_user_id: A.id, p_role: 'admin' });
  rec(sr.status >= 400 || /admin|master|restricted|only/i.test(sr.text) ? 'PASS' : 'FAIL', 'non-admin admin_set_role refused', `http=${sr.status} ${sr.text.slice(0, 110)}`);
}
// profile self-modification guard
{
  const r = await req('PATCH', `/rest/v1/profiles?id=eq.${A.id}`, {
    token: A.token, prefer: 'return=representation',
    body: { is_paid: true, is_locked: false, trial_ends_at: '2099-01-01T00:00:00Z' },
  });
  rec(r.status >= 400 ? 'PASS' : 'FAIL', 'user cannot self-set is_paid/is_locked/trial via profile PATCH', `http=${r.status} ${r.text.slice(0, 120)}`);
  const after = await req('GET', `/rest/v1/profiles?id=eq.${A.id}&select=is_paid,is_locked`, { token: A.token });
  rec(after.json?.[0]?.is_paid !== true ? 'PASS' : 'FAIL', 'profile flags unchanged after attack', JSON.stringify(after.json));
}

// ------------------------------------------------------- hostile sale inserts (as shop owner A, direct REST)
async function insertSale(user, overrides = {}) {
  const body = {
    store_id: SA.id,
    items: [{ productId: PA.id, name: 'NUCLEARQA Widget', qty: 1, priceCents: 1250 }],
    subtotal_cents: 1250, discount_cents: 0, tax_cents: 0, total_cents: 1250,
    method: 'cash', tendered_cents: 1250, change_cents: 0,
    ...overrides,
  };
  return req('POST', '/rest/v1/pos_sales', { token: user.token, prefer: 'return=representation', body });
}
const hostile = async (label, overrides, expect) => {
  const r = await insertSale(A, overrides);
  const accepted = r.status < 300;
  rec(accepted === expect ? 'PASS' : 'FAIL', label, `http=${r.status} accepted=${accepted} ${accepted ? '' : r.text.slice(0, 110)}`);
  return r;
};
await hostile('reject negative total', { total_cents: -100, subtotal_cents: -100, tendered_cents: 0 }, false);
await hostile('reject discount > subtotal', { discount_cents: 99999, total_cents: 0 }, false);
await hostile('reject zero-qty line', { items: [{ productId: PA.id, qty: 0, priceCents: 1250 }], total_cents: 0, tendered_cents: 0 }, false);
await hostile('reject fractional qty line', { items: [{ productId: PA.id, qty: 1.5, priceCents: 1250 }] }, false);
await hostile('reject qty 1000 line (cap 999)', { items: [{ productId: PA.id, qty: 1000, priceCents: 1 }], subtotal_cents: 1000, total_cents: 1000, tendered_cents: 1000 }, false);
await hostile('reject unit price above cap', { items: [{ productId: PA.id, qty: 1, priceCents: 1000001 }], subtotal_cents: 1000001, total_cents: 1000001, tendered_cents: 1000001 }, false);
await hostile('reject non-array items', { items: { nope: 1 } }, false);
await hostile('reject empty items', { items: [], subtotal_cents: 0, total_cents: 0, tendered_cents: 0 }, false);
await hostile('reject unknown payment method', { method: 'bitcoin' }, false);
await hostile('DOCUMENT: total=0 with subtotal>0 (no server arithmetic reconciliation)', { total_cents: 0, tendered_cents: 0 }, true);
await hostile('DOCUMENT: cash tendered < total (no server under-tender check)', { tendered_cents: 100, change_cents: 0 }, true);
{ // created_by spoof
  const r = await insertSale(A, { created_by: B.id, idempotency_key: `nq-spoof-${stamp}` });
  const cb = r.json?.[0]?.created_by;
  rec(r.status < 300 && cb === A.id ? 'PASS' : 'FAIL', 'created_by forced to caller (spoof ignored)', `created_by=${cb?.slice(0, 8)} mine=${A.id.slice(0, 8)}`);
}

// ------------------------------------------------------- sale idempotency + stock
const K1 = `nq-idem-${stamp}`;
const s1 = await insertSale(A, { idempotency_key: K1 });
const s1again = await insertSale(A, { idempotency_key: K1 });
rec(s1.status < 300 && s1again.status >= 400 ? 'PASS' : 'FAIL', 'duplicate idempotency key rejected at DB', `first=${s1.status} second=${s1again.status}`);

async function stockOf(user, productId) {
  const r = await req('GET', `/rest/v1/pos_products?id=eq.${productId}&select=stock`, { token: user.token });
  return r.json?.[0]?.stock;
}
// concurrency: last-item race — set stock to 1, two parallel apply-stock
{
  await req('PATCH', `/rest/v1/pos_products?id=eq.${PA.id}`, { token: A.token, body: { stock: 1 } });
  const line = JSON.stringify([{ productId: PA.id, qty: 1 }]);
  const [r1, r2] = await Promise.all([
    rpc(A.token, 'pos_apply_sale_stock', { p_store_id: SA.id, p_lines: JSON.parse(line) }),
    rpc(A.token, 'pos_apply_sale_stock', { p_store_id: SA.id, p_lines: JSON.parse(line) }),
  ]);
  const stock = await stockOf(A, PA.id);
  const oversoldFlags = [r1.json, r2.json].filter((j) => JSON.stringify(j).includes('oversold')).length;
  rec(stock === 0 && oversoldFlags >= 1 ? 'PASS' : 'FAIL', 'concurrent last-item sales: stock floors at 0, oversell reported', `stock=${stock} oversoldFlags=${oversoldFlags} http=${r1.status}/${r2.status}`);
}
// replay double-decrement: same sale applied twice (documents recordSale replay risk)
{
  await req('PATCH', `/rest/v1/pos_products?id=eq.${PA.id}`, { token: A.token, body: { stock: 5 } });
  const lines = [{ productId: PA.id, qty: 2 }];
  await rpc(A.token, 'pos_apply_sale_stock', { p_store_id: SA.id, p_lines: lines });
  await rpc(A.token, 'pos_apply_sale_stock', { p_store_id: SA.id, p_lines: lines });
  const stock = await stockOf(A, PA.id);
  rec(stock === 1 ? 'PASS' : 'FAIL', 'stock application is NOT idempotent per sale (replay double-decrements)', `stock after 2 applies of qty2 from 5 = ${stock} (1 = double-decrement confirmed)`);
}

// ------------------------------------------------------- gift cards
{
  const issue = await rpc(A.token, 'pos_giftcard_issue', { p_store_id: SA.id, p_amount_cents: 1000, p_note: 'NUCLEARQA' });
  const card = Array.isArray(issue.json) ? issue.json[0] : issue.json;
  rec(!!card?.id ? 'PASS' : 'FAIL', 'gift card issued', `http=${issue.status} ${issue.text.slice(0, 100)}`);
  if (card?.id) {
    const [g1, g2] = await Promise.all([
      rpc(A.token, 'pos_giftcard_redeem', { p_card_id: card.id, p_amount_cents: 800 }),
      rpc(A.token, 'pos_giftcard_redeem', { p_card_id: card.id, p_amount_cents: 800 }),
    ]);
    const okCount = [g1, g2].filter((r) => r.status < 300).length;
    const bal = await req('GET', `/rest/v1/pos_gift_cards?id=eq.${card.id}&select=balance_cents`, { token: A.token });
    rec(okCount === 1 && bal.json?.[0]?.balance_cents === 200 ? 'PASS' : 'FAIL',
      'concurrent gift-card redeems cannot overspend', `ok=${okCount} balance=${bal.json?.[0]?.balance_cents}`);
    const over = await rpc(A.token, 'pos_giftcard_redeem', { p_card_id: card.id, p_amount_cents: 99999 });
    rec(over.status >= 400 ? 'PASS' : 'FAIL', 'over-balance redeem rejected', `http=${over.status} ${over.text.slice(0, 90)}`);
    const asB = await rpc(B.token, 'pos_giftcard_redeem', { p_card_id: card.id, p_amount_cents: 1 });
    rec(asB.status >= 400 ? 'PASS' : 'FAIL', 'other shop cannot redeem A gift card', `http=${asB.status} ${asB.text.slice(0, 90)}`);
  }
}

// ------------------------------------------------------- refunds
{
  const sale = await insertSale(A, { idempotency_key: `nq-refund-${stamp}`,
    items: [{ productId: PA.id, name: 'NUCLEARQA Widget', qty: 2, priceCents: 1250 }],
    subtotal_cents: 2500, total_cents: 2500, tendered_cents: 2500 });
  const saleId = sale.json?.[0]?.id;
  rec(!!saleId ? 'PASS' : 'FAIL', 'refund test sale recorded', `http=${sale.status}`);
  if (saleId) {
    const rf1 = await rpc(A.token, 'pos_refund_sale', { p_sale_id: saleId, p_lines: [{ index: 0, qty: 2 }], p_reason: 'NUCLEARQA' });
    rec(rf1.status < 300 ? 'PASS' : 'FAIL', 'full refund succeeds', `http=${rf1.status} ${rf1.text.slice(0, 110)}`);
    const rf2 = await rpc(A.token, 'pos_refund_sale', { p_sale_id: saleId, p_lines: [{ index: 0, qty: 1 }], p_reason: 'NUCLEARQA' });
    rec(rf2.status >= 400 ? 'PASS' : 'FAIL', 'refund beyond sold qty rejected', `http=${rf2.status} ${rf2.text.slice(0, 110)}`);
    const rfC = await rpc(C.token, 'pos_refund_sale', { p_sale_id: saleId, p_lines: [{ index: 0, qty: 1 }], p_reason: 'NUCLEARQA' });
    rec(rfC.status >= 400 || /manager|only/i.test(rfC.text) ? 'PASS' : 'FAIL', 'cashier cannot refund', `http=${rfC.status} ${rfC.text.slice(0, 110)}`);
    const rfB = await rpc(B.token, 'pos_refund_sale', { p_sale_id: saleId, p_lines: [{ index: 0, qty: 1 }], p_reason: 'NUCLEARQA' });
    rec(rfB.status >= 400 ? 'PASS' : 'FAIL', 'other shop cannot refund A sale', `http=${rfB.status} ${rfB.text.slice(0, 110)}`);
    // idem replay: same key + same payload returns same refund; same key + different payload rejected
    const sale2 = await insertSale(A, { idempotency_key: `nq-refund2-${stamp}` });
    const sid2 = sale2.json?.[0]?.id;
    if (sid2) {
      const a1 = await rpc(A.token, 'pos_refund_sale', { p_sale_id: sid2, p_lines: [{ index: 0, qty: 1 }], p_reason: '', p_idem_key: `nq-rk-${stamp}` });
      const a2 = await rpc(A.token, 'pos_refund_sale', { p_sale_id: sid2, p_lines: [{ index: 0, qty: 1 }], p_reason: '', p_idem_key: `nq-rk-${stamp}` });
      rec(a1.status < 300 && a2.status < 300 ? 'PASS' : 'FAIL', 'refund idem replay returns existing', `http=${a1.status}/${a2.status}`);
      const rows = await req('GET', `/rest/v1/pos_refunds?sale_id=eq.${sid2}&select=id`, { token: A.token });
      rec(Array.isArray(rows.json) && rows.json.length === 1 ? 'PASS' : 'FAIL', 'idem replay created exactly one refund row', `rows=${rows.json?.length}`);
    }
  }
}

// ------------------------------------------------------- appointments double-book (server)
{
  const staff = await req('POST', '/rest/v1/pos_staff', {
    token: A.token, prefer: 'return=representation',
    body: { store_id: SA.id, name: `NUCLEARQA Staff ${stamp}`, pin_hash: 'x'.repeat(64), role: 'cashier' },
  });
  const staffId = staff.json?.[0]?.id;
  const appt = (mins) => ({
    store_id: SA.id, staff_id: staffId, title: 'NUCLEARQA cut',
    starts_at: new Date(Date.now() + mins * 60000).toISOString(),
    ends_at: new Date(Date.now() + (mins + 30) * 60000).toISOString(), status: 'scheduled',
  });
  const a1 = await req('POST', '/rest/v1/pos_appointments', { token: A.token, prefer: 'return=representation', body: appt(120) });
  const a2 = await req('POST', '/rest/v1/pos_appointments', { token: A.token, prefer: 'return=representation', body: appt(130) });
  rec(a1.status < 300 && a2.status < 300 ? 'FAIL' : 'PASS',
    'server rejects overlapping appointment for same staff (UI check only = race window)',
    `http=${a1.status}/${a2.status} both accepted=${a1.status < 300 && a2.status < 300}`);
}

// ------------------------------------------------------- data abuse
{
  const longName = 'NUCLEARQA-' + 'x'.repeat(10000);
  const r = await makeProduct(A, SA.id, { name: longName, price_cents: 100 });
  rec(r.status < 300 ? 'PASS' : 'FAIL', 'DOCUMENT: 10k-char product name stored by DB (UI must wrap/clamp)', `http=${r.status}`);
  if (r.json?.[0]?.id) await req('DELETE', `/rest/v1/pos_products?id=eq.${r.json[0].id}`, { token: A.token });
  const emoji = await makeProduct(A, SA.id, { name: '🧨 NUCLEARQA éè — RTL ‏test', price_cents: 100 });
  const back = await req('GET', `/rest/v1/pos_products?id=eq.${emoji.json?.[0]?.id}&select=name`, { token: A.token });
  rec(back.json?.[0]?.name?.includes('🧨') ? 'PASS' : 'FAIL', 'emoji/unicode product name round-trips', `http=${emoji.status}`);
  const zero = await makeProduct(A, SA.id, { name: 'NUCLEARQA free item', price_cents: 0 });
  rec(zero.status >= 400 ? 'PASS' : 'FAIL', 'DOCUMENT: $0 product rejected by DB CHECK price_cents>0', `http=${zero.status} ${zero.text.slice(0, 90)}`);
  const sqli = await makeProduct(A, SA.id, { name: `'; DROP TABLE pos_sales; --`, price_cents: 100 });
  const alive = await req('GET', `/rest/v1/pos_sales?store_id=eq.${SA.id}&select=id&limit=1`, { token: A.token });
  rec(sqli.status < 300 && alive.status < 300 ? 'PASS' : 'FAIL', 'SQLi-shaped product name stored inertly, sales table alive', `http=${sqli.status}/${alive.status}`);
}

// ------------------------------------------------------- wrong-store RPC
{
  const r = await rpc(A.token, 'pos_apply_sale_stock', { p_store_id: SB.id, p_lines: [{ productId: PB.id, qty: 1 }] });
  rec(r.status >= 400 || /member/i.test(r.text) ? 'PASS' : 'FAIL', 'A cannot apply stock in B shop', `http=${r.status} ${r.text.slice(0, 100)}`);
}

console.log(`\nLIVE API: pass=${pass} fail=${fail} blocked=${blocked}`);
console.log('state saved to', STATE_PATH);
process.exit(0);
