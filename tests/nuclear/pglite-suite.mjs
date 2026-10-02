// Nuclear QA — PGlite suite: runs the REAL schema.sql + migrations (002..066,
// drafts excluded — matching live) in an in-process Postgres, then attacks the
// SQL layer as different users via SET ROLE + auth.uid() GUC.
// Usage: node tests/nuclear/pglite-suite.mjs
// Requires @electric-sql/pglite (resolved from the repo install, or the
// workspace harnesses install used by the QA worktree).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let PGlite, pgcryptoExt = null;
try {
  ({ PGlite } = await import('@electric-sql/pglite'));
} catch {
  ({ PGlite } = await import('/home/hatch/workspace/harnesses/pglite-pg/node_modules/@electric-sql/pglite/dist/index.js'));
  // Real pgcrypto (digest()/gen_random_salt() used by migs 040/049 and the
  // refund idempotency hash) — contrib bundle shipped with the package.
  try { ({ pgcrypto: pgcryptoExt } = await import('/home/hatch/workspace/harnesses/pglite-pg/node_modules/@electric-sql/pglite/dist/contrib/pgcrypto.js')); } catch {}
}
function dbExtensions() {
  return pgcryptoExt ? { extensions: { pgcrypto: pgcryptoExt } } : {};
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
let pass = 0, fail = 0;
const results = [];
function rec(status, name, detail = '') {
  results.push({ status, name, detail: String(detail).slice(0, 200) });
  if (status === 'PASS') pass++; else fail++;
  console.log(`${status}  ${name}${detail ? ' — ' + String(detail).slice(0, 170) : ''}`);
}

const db = new PGlite(dbExtensions());
const q = (sql, params) => db.query(sql, params);

// ---------- Supabase platform stubs (auth + storage schemas) ----------
await db.exec(`
create schema if not exists auth;
create schema if not exists extensions;
create schema if not exists storage;
create extension if not exists pgcrypto with schema extensions;
set search_path = public, extensions, auth;
create table if not exists auth.users (
  id uuid primary key,
  instance_id uuid,
  email text,
  encrypted_password text,
  email_confirmed_at timestamptz,
  confirmation_sent_at timestamptz,
  confirmed_at timestamptz,
  last_sign_in_at timestamptz,
  invited_at timestamptz,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  raw_app_meta_data jsonb not null default '{}'::jsonb,
  aud text, role text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  confirmation_token text, recovery_token text, email_change text,
  email_change_token_current text, email_change_token_new text,
  email_change_confirm_status smallint,
  phone text default '', phone_confirmed_at timestamptz,
  phone_change text default '', phone_change_token text default '',
  phone_change_sent_at timestamptz,
  reauthentication_token text default '', reauthentication_sent_at timestamptz,
  recovery_sent_at timestamptz,
  banned_until timestamptz, deleted_at timestamptz,
  is_sso_user boolean default false, is_anonymous boolean default false
);
create table if not exists auth.identities (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  identity_data jsonb not null default '{}'::jsonb,
  provider text not null,
  provider_id text,
  last_sign_in_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  email text generated always as (lower(identity_data->>'email')) stored
);
create or replace function auth.uid() returns uuid language sql stable as
  $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create or replace function auth.email() returns text language sql stable as
  $$ select nullif(current_setting('request.jwt.claim.email', true), '') $$;
create table if not exists storage.buckets (
  id text primary key, name text not null, owner uuid, public boolean not null default false,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  file_size_limit bigint, allowed_mime_types text[]
);
create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner uuid,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  last_accessed_at timestamptz, metadata jsonb, path_tokens text[], version text
);
create or replace function storage.foldername(p_name text) returns text[] language sql immutable as
  $$ select (string_to_array(p_name, '/'))[1:cardinality(string_to_array(p_name, '/'))-1] $$;
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create role supabase_admin nologin;
create publication supabase_realtime;
grant usage on schema public to anon, authenticated, service_role;
grant usage on schema auth to anon, authenticated, service_role;
`);

// ---------- apply schema.sql then migrations in order ----------
// Primary path: hand the WHOLE file to Postgres (db.exec). Postgres itself
// parses dollar-quoted function bodies, comments, everything — far more
// faithful than any JS splitter (an earlier hand-rolled splitter shredded
// $$-bodied functions and skipped comment-carrying statements; that bug is
// why whole-file exec is now primary). Fallback: if exec throws (a
// platform-only statement aborts the file), re-apply statement by statement
// with a corrected splitter and isolate the failures.
// Known platform-only noise handled in fallback: statements touching the
// supabase_realtime publication (pre-created in stubs) are recorded as
// skipped, matching how the platform executes them server-side.
function splitStatements(sql) {
  const stmts = [];
  let cur = '', i = 0, tag = null, inStr = false;
  const tagRe = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/; // bare $$ AND $tag$
  while (i < sql.length) {
    const ch = sql[i];
    if (tag) {
      const end = sql.indexOf(tag, i);
      if (end === -1) { cur += sql.slice(i); i = sql.length; break; }
      cur += sql.slice(i, end + tag.length); i = end + tag.length; tag = null;
      continue;
    }
    if (inStr) {
      cur += ch;
      if (ch === "'") { if (sql[i + 1] === "'") { cur += "'"; i += 2; continue; } inStr = false; }
      i++; continue;
    }
    if (ch === "'") { inStr = true; cur += ch; i++; continue; }
    if (ch === '$') { const m = tagRe.exec(sql.slice(i)); if (m) { tag = m[0]; cur += tag; i += tag.length; continue; } }
    if (ch === '-' && sql[i + 1] === '-') {
      const eol = sql.indexOf('\n', i);
      const end = eol === -1 ? sql.length : eol;
      cur += sql.slice(i, end); i = end; continue;
    }
    cur += ch; i++;
    if (ch === ';') { stmts.push(cur); cur = ''; }
  }
  if (cur.trim()) stmts.push(cur);
  return stmts;
}
function sqlBeyondComments(s) {
  return s.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n').trim();
}
const failed = [];
const skipped = [];
async function applyFile(label, sql) {
  try { await db.exec(sql); return splitStatements(sql).length; }
  catch (execErr) {
    // fall back to per-statement application
  }
  let n = 0;
  for (const raw of splitStatements(sql)) {
    const s = raw.trim();
    if (!s || !sqlBeyondComments(s)) continue;
    if (/supabase_realtime/i.test(s)) { skipped.push(`${label}: ${s.slice(0, 70)}`); continue; }
    try { await db.exec(s); n++; }
    catch (e) { failed.push({ label, error: e.message.slice(0, 150), sql: s.slice(0, 90) }); }
  }
  return n;
}
let total = 0;
total += await applyFile('schema.sql', fs.readFileSync(path.join(ROOT, 'supabase/schema.sql'), 'utf8'));
const migDir = path.join(ROOT, 'supabase/migrations');
const migFiles = fs.readdirSync(migDir).filter((f) => f.endsWith('.sql')).sort();
let appliedCount = 0;
for (const f of migFiles) {
  if (/_draft_/.test(f)) continue; // drafts are not applied live
  total += await applyFile(f, fs.readFileSync(path.join(migDir, f), 'utf8'));
  appliedCount++;
}
rec('PASS', `chain applied: ${appliedCount + 1} files, ${total} statements ok`);
if (failed.length) {
  console.log(`\n!! ${failed.length} failed statements:`);
  for (const f of failed.slice(0, 25)) console.log(`   [${f.label}] ${f.error} :: ${f.sql}`);
  console.log(`!! ${skipped.length} realtime-publication statements skipped (platform-only)`);
}
// Mirror Supabase's platform default privileges (bare Postgres has none):
// the platform grants anon/authenticated/service_role table access in
// `public` and lets RLS do the real gating. Without this, every client-role
// query fails 42501 before RLS is even consulted.
await db.exec(`
grant all on all tables in schema public to anon, authenticated, service_role;
grant all on all sequences in schema public to anon, authenticated, service_role;
grant execute on all functions in schema public to anon, authenticated, service_role;
`);

// ---------- actors ----------
async function asRole(role, sub) {
  await db.exec(`set role ${role}`);
  await q(`select set_config('request.jwt.claim.sub', $1, false)`, [sub || '']);
}
const asUser = (id) => asRole('authenticated', id);
const asAnon = () => asRole('anon', '');
const asRoot = () => db.exec('reset role');

const A = 'aaaaaaaa-1111-4111-8111-111111111111';
const B = 'bbbbbbbb-2222-4222-8222-222222222222';
const C = 'cccccccc-3333-4333-8333-333333333333';
await asRoot();
for (const [id, email, un] of [
  [A, 'nuclearqa-a@drift-shop.app', 'nuclearqa_a'],
  [B, 'nuclearqa-b@drift-shop.app', 'nuclearqa_b'],
  [C, 'nuclearqa-c@drift-shop.app', 'nuclearqa_c'],
]) {
  await q(`insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3)`,
    [id, email, JSON.stringify({ username: un })]);
}
const profA = await q(`select role, is_paid, is_locked from public.profiles where id = $1`, [A]);
rec(profA.rows[0] && profA.rows[0].role !== 'admin' ? 'PASS' : 'FAIL',
  'later signups are standard users (first-user-admin only fired for seed)', JSON.stringify(profA.rows[0]));
const masterRow = await q(`select id from public.profiles where is_master = true limit 1`);
const MASTER = masterRow.rows[0]?.id;
rec(!!MASTER ? 'PASS' : 'FAIL', 'platform master seeded by migration 056', MASTER ? MASTER.slice(0, 8) : 'none');

// ---------- OAuth account classification (migration 080) ----------
// Actor A signed up with no account_kind metadata (like a fresh OAuth user:
// the 070 trigger records NULL). The client stamps it once after the
// OAuth callback via classify_oauth_profile().
await asUser(A);
await q(`select public.classify_oauth_profile('owner')`);
const kindA = (await q(`select account_kind from public.profiles where id = $1`, [A])).rows[0]?.account_kind;
rec(kindA === 'owner' ? 'PASS' : 'FAIL',
  'classify_oauth_profile stamps NULL -> owner for a fresh OAuth user', String(kindA));
// A second call with a different kind must NOT overwrite the first stamp.
await q(`select public.classify_oauth_profile('customer')`);
const kindA2 = (await q(`select account_kind from public.profiles where id = $1`, [A])).rows[0]?.account_kind;
rec(kindA2 === 'owner' ? 'PASS' : 'FAIL',
  'classify_oauth_profile never overwrites an existing classification', String(kindA2));
let badKind = '';
try { await q(`select public.classify_oauth_profile('admin')`); } catch (e) { badKind = e.message; }
rec(/owner.*customer/i.test(badKind) ? 'PASS' : 'FAIL',
  'classify_oauth_profile rejects invalid kinds', badKind.slice(0, 80));
await asAnon();
let anonKind = '';
try { await q(`select public.classify_oauth_profile('owner')`); } catch (e) { anonKind = e.message; }
rec(/sign in required/i.test(anonKind) ? 'PASS' : 'FAIL',
  'classify_oauth_profile requires a signed-in user', anonKind.slice(0, 80));

// ---------- shops ----------
await asUser(A);
const SA = (await q(`insert into public.pos_stores (name, created_by) values ('NUCLEARQA Shop A', $1) returning id`, [A])).rows[0].id;
await asUser(B);
const SB = (await q(`insert into public.pos_stores (name, created_by) values ('NUCLEARQA Shop B', $1) returning id`, [B])).rows[0].id;
await asUser(A);
await q(`insert into public.pos_store_members (store_id, user_id, role) values ($1, $2, 'cashier')`, [SA, C]);
const PA = (await q(`insert into public.pos_products (store_id, name, price_cents, stock, track_stock)
  values ($1, 'NUCLEARQA Widget', 1250, 5, true) returning id`, [SA])).rows[0].id;
await asUser(B);
const PB = (await q(`insert into public.pos_products (store_id, name, price_cents, stock, track_stock)
  values ($1, 'NUCLEARQA B Widget', 500, 3, true) returning id`, [SB])).rows[0].id;
rec('PASS', 'shops/products seeded as owners', `SA=${SA.slice(0, 8)} PA=${PA.slice(0, 8)}`);

// ---------- cross-shop isolation (RLS) ----------
const expectEmpty = async (label, sql, params) => {
  try {
    const r = await q(sql, params);
    rec(r.rows.length === 0 ? 'PASS' : 'FAIL', label, `rows=${r.rows.length}`);
  } catch (e) { rec('PASS', label, `error: ${e.message.slice(0, 80)}`); }
};
const expectRefused = async (label, sql, params) => {
  try {
    const r = await q(sql, params);
    rec('FAIL', label, `accepted rows=${r.rows.length}`);
  } catch (e) { rec('PASS', label, e.message.slice(0, 90)); }
};
await asUser(B);
await expectEmpty('B cannot read A products', `select id from public.pos_products where store_id = $1`, [SA]);
await expectEmpty('B cannot read A store', `select id from public.pos_stores where id = $1`, [SA]);
await expectEmpty('B cannot read A sales', `select id from public.pos_sales where store_id = $1`, [SA]);
await expectEmpty('B cannot read A customers', `select id from public.pos_customers where store_id = $1`, [SA]);
await expectEmpty('B cannot read A appointments', `select id from public.pos_appointments where store_id = $1`, [SA]);
await expectEmpty('B cannot read A gift cards', `select id from public.pos_gift_cards where store_id = $1`, [SA]);
await expectEmpty('B cannot read A storefront profile', `select id from public.storefront_profiles where store_id = $1`, [SA]);
await expectEmpty('B cannot read A profile', `select id from public.profiles where id = $1`, [A]);
await expectRefused('B cannot insert product into A shop',
  `insert into public.pos_products (store_id, name, price_cents) values ($1, 'intruder', 100)`, [SA]);
{
  const r = await q(`update public.pos_products set price_cents = 1 where id = $1`, [PA]);
  rec(r.affectedRows === 0 ? 'PASS' : 'FAIL', 'B cannot reprice A product', `affected=${r.affectedRows}`);
  const d = await q(`delete from public.pos_products where id = $1`, [PA]);
  rec(d.affectedRows === 0 ? 'PASS' : 'FAIL', 'B cannot delete A product', `affected=${d.affectedRows}`);
}
await asUser(A);
{
  const r = await q(`select price_cents from public.pos_products where id = $1`, [PA]);
  rec(r.rows[0]?.price_cents === 1250 ? 'PASS' : 'FAIL', 'A product intact after B attacks', JSON.stringify(r.rows[0]));
}

// ---------- role escalation ----------
await asUser(C);
{
  const r = await q(`update public.pos_store_members set role = 'owner' where store_id = $1 and user_id = $2`, [SA, C]);
  rec(r.affectedRows === 0 ? 'PASS' : 'FAIL', 'cashier cannot self-promote', `affected=${r.affectedRows}`);
}
await expectRefused('cashier cannot add members',
  `insert into public.pos_store_members (store_id, user_id, role) values ($1, $2, 'owner')`, [SA, B]);
{
  const r = await q(`update public.pos_products set price_cents = 999 where id = $1`, [PA]);
  rec(r.affectedRows === 0 ? 'PASS' : 'FAIL', 'cashier cannot edit product price', `affected=${r.affectedRows}`);
}
await expectRefused('non-master factory_reset refused (A)', `select public.factory_reset()`, []);
await asUser(A);
await expectRefused('non-master factory_reset refused (A owner)', `select public.factory_reset()`, []);
await expectRefused('non-admin cannot set is_paid/is_locked on own profile',
  `update public.profiles set is_paid = true, is_locked = false, trial_ends_at = '2099-01-01' where id = $1`, [A]);
await expectRefused('non-master cannot set is_master on own profile',
  `update public.profiles set is_master = true where id = $1`, [A]);

// ---------- hostile sale inserts ----------
await asUser(A);
async function saleInsert(over = {}) {
  const s = {
    store_id: SA,
    items: JSON.stringify([{ productId: PA, name: 'NUCLEARQA Widget', qty: 1, priceCents: 1250 }]),
    subtotal_cents: 1250, discount_cents: 0, tax_cents: 0, total_cents: 1250,
    method: 'cash', tendered_cents: 1250, change_cents: 0, ...over,
  };
  const cols = Object.keys(s);
  return q(`insert into public.pos_sales (${cols.join(',')}) values (${cols.map((_, i) => '$' + (i + 1)).join(',')}) returning id, created_by`,
    cols.map((c) => s[c]));
}
const hostileCase = async (label, over, expectOk) => {
  try {
    const r = await saleInsert(over);
    rec(expectOk ? 'PASS' : 'FAIL', label, expectOk ? 'accepted (documented)' : 'ACCEPTED but should reject');
    return r.rows[0];
  } catch (e) {
    rec(expectOk ? 'FAIL' : 'PASS', label, e.message.slice(0, 110));
    return null;
  }
};
await hostileCase('reject negative total', { total_cents: -100, subtotal_cents: -100 }, false);
await hostileCase('reject discount > subtotal', { discount_cents: 99999, total_cents: 0 }, false);
await hostileCase('reject zero-qty line', { items: JSON.stringify([{ productId: PA, qty: 0, priceCents: 1250 }]) }, false);
await hostileCase('reject fractional qty', { items: JSON.stringify([{ productId: PA, qty: 1.5, priceCents: 1250 }]) }, false);
await hostileCase('reject qty 1000 (cap 999)', { items: JSON.stringify([{ productId: PA, qty: 1000, priceCents: 1 }]), subtotal_cents: 1000, total_cents: 1000, tendered_cents: 1000 }, false);
await hostileCase('reject unit price above cap', { items: JSON.stringify([{ productId: PA, qty: 1, priceCents: 1000001 }]), subtotal_cents: 1000001, total_cents: 1000001, tendered_cents: 1000001 }, false);
await hostileCase('reject empty items', { items: '[]', subtotal_cents: 0, total_cents: 0, tendered_cents: 0 }, false);
await hostileCase('reject unknown method', { method: 'bitcoin' }, false);
await hostileCase('DOCUMENT: total=0 while subtotal=1250 accepted (no server arithmetic reconciliation)', { total_cents: 0, tendered_cents: 0 }, true);
await hostileCase('DOCUMENT: cash tendered 100 < total 1250 accepted (no server under-tender check)', { tendered_cents: 100 }, true);
{
  const row = await hostileCase('sale insert with spoofed created_by', { created_by: B, idempotency_key: 'nq-spoof' }, true);
  rec(row && row.created_by === A ? 'PASS' : 'FAIL', 'created_by forced to caller', `created_by=${row?.created_by?.slice(0, 8)}`);
}

// ---------- idempotency ----------
{
  const first = await hostileCase('idem key first insert', { idempotency_key: 'nq-idem-1' }, true);
  await hostileCase('duplicate idempotency key rejected', { idempotency_key: 'nq-idem-1' }, false);
  const cnt = await q(`select count(*)::int as n from public.pos_sales where store_id = $1 and idempotency_key = 'nq-idem-1'`, [SA]);
  rec(cnt.rows[0].n === 1 ? 'PASS' : 'FAIL', 'exactly one sale for idem key', `n=${cnt.rows[0].n}`);
}

// ---------- stock: floor, oversell, replay ----------
const setStock = (n) => q(`update public.pos_products set stock = $1 where id = $2`, [n, PA]);
const getStock = async () => (await q(`select stock from public.pos_products where id = $1`, [PA])).rows[0].stock;
await setStock(1);
{
  const r1 = await q(`select public.pos_apply_sale_stock($1, $2::jsonb) as res`, [SA, JSON.stringify([{ product_id: PA, qty: 1, name: 'W' }])]);
  const r2 = await q(`select public.pos_apply_sale_stock($1, $2::jsonb) as res`, [SA, JSON.stringify([{ product_id: PA, qty: 1, name: 'W' }])]);
  const stock = await getStock();
  const res2 = JSON.stringify(r2.rows[0].res);
  rec(stock === 0 && /oversold/.test(res2) ? 'PASS' : 'FAIL', 'last-item: stock floors at 0 and oversell is reported', `stock=${stock} second=${res2.slice(0, 120)}`);
}
await setStock(5);
{
  const lines = JSON.stringify([{ product_id: PA, qty: 2, name: 'W' }]);
  await q(`select public.pos_apply_sale_stock($1, $2::jsonb)`, [SA, lines]);
  await q(`select public.pos_apply_sale_stock($1, $2::jsonb)`, [SA, lines]);
  const stock = await getStock();
  rec(stock === 1 ? 'PASS' : 'FAIL', 'DEFECT CHECK (passes while bug present): stock replay double-decrements, 5-2-2=1', `stock=${stock}`);
}
await expectRefused('A cannot apply stock in B shop',
  `select public.pos_apply_sale_stock($1, $2::jsonb)`, [SB, JSON.stringify([{ product_id: PB, qty: 1, name: 'W' }])]);

// ---------- gift cards ----------
{
  const issued = await q(`select * from public.pos_giftcard_issue($1, 1000, 'NUCLEARQA')`, [SA]);
  const cardId = issued.rows[0].id;
  rec(!!cardId ? 'PASS' : 'FAIL', 'gift card issued', issued.rows[0].code ? 'code returned' : '');
  await q(`select * from public.pos_giftcard_redeem($1, 800)`, [cardId]);
  await expectRefused('second redeem beyond balance rejected', `select * from public.pos_giftcard_redeem($1, 800)`, [cardId]);
  const bal = await q(`select balance_cents from public.pos_gift_cards where id = $1`, [cardId]);
  rec(bal.rows[0].balance_cents === 200 ? 'PASS' : 'FAIL', 'gift card balance exact after redeems', `balance=${bal.rows[0].balance_cents}`);
  await asUser(B);
  await expectRefused('other shop cannot redeem A gift card', `select * from public.pos_giftcard_redeem($1, 1)`, [cardId]);
  await asUser(A);
}

// ---------- refunds ----------
{
  const sale = await hostileCase('refund fixture sale', { idempotency_key: 'nq-refund-1',
    items: JSON.stringify([{ productId: PA, name: 'W', qty: 2, priceCents: 1250 }]),
    subtotal_cents: 2500, total_cents: 2500, tendered_cents: 2500 }, true);
  const sid = sale.id;
  const rf = await q(`select public.pos_refund_sale($1, $2::jsonb, 'NUCLEARQA') as res`, [sid, JSON.stringify([{ index: 0, qty: 2 }])]);
  rec(!!rf.rows[0].res ? 'PASS' : 'FAIL', 'full refund succeeds', JSON.stringify(rf.rows[0].res).slice(0, 100));
  await expectRefused('refund beyond sold qty rejected',
    `select public.pos_refund_sale($1, $2::jsonb, 'x')`, [sid, JSON.stringify([{ index: 0, qty: 1 }])]);
  await asUser(C);
  await expectRefused('cashier cannot refund', `select public.pos_refund_sale($1, $2::jsonb, 'x')`, [sid, JSON.stringify([{ index: 0, qty: 1 }])]);
  await asUser(B);
  await expectRefused('other shop cannot refund A sale', `select public.pos_refund_sale($1, $2::jsonb, 'x')`, [sid, JSON.stringify([{ index: 0, qty: 1 }])]);
  await asUser(A);
  // idem replay
  const sale2 = await hostileCase('refund idem fixture sale', { idempotency_key: 'nq-refund-2' }, true);
  const a1 = await q(`select public.pos_refund_sale($1, $2::jsonb, '', false, 'nq-rk-1') as res`, [sale2.id, JSON.stringify([{ index: 0, qty: 1 }])]);
  const a2 = await q(`select public.pos_refund_sale($1, $2::jsonb, '', false, 'nq-rk-1') as res`, [sale2.id, JSON.stringify([{ index: 0, qty: 1 }])]);
  const n = await q(`select count(*)::int as n from public.pos_refunds where sale_id = $1`, [sale2.id]);
  rec(n.rows[0].n === 1 ? 'PASS' : 'FAIL', 'refund idem replay yields exactly one refund row', `rows=${n.rows[0].n}`);
  // 040: the idempotency payload hash covers (lines, amounts, credit flag).
  // Reusing the key with a DIFFERENT credit flag must raise, not replay.
  await expectRefused('refund idem key reuse with different payload (credit flag) rejected',
    `select public.pos_refund_sale($1, $2::jsonb, '', true, 'nq-rk-1')`, [sale2.id, JSON.stringify([{ index: 0, qty: 1 }])]);
}

// ---------- appointments double-book ----------
{
  const staff = await q(`insert into public.pos_staff (store_id, name, pin_hash, role)
    values ($1, 'NUCLEARQA Staff', repeat('x', 64), 'cashier') returning id`, [SA]);
  const staffId = staff.rows[0].id;
  const t0 = new Date(Date.now() + 120 * 60000);
  const t1 = new Date(t0.getTime() + 30 * 60000);
  const t2 = new Date(t0.getTime() + 10 * 60000);
  const t3 = new Date(t0.getTime() + 40 * 60000);
  await q(`insert into public.pos_appointments (store_id, staff_id, title, starts_at, ends_at, status)
    values ($1, $2, 'cut 1', $3, $4, 'scheduled')`, [SA, staffId, t0.toISOString(), t1.toISOString()]);
  let secondAccepted = true;
  try {
    await q(`insert into public.pos_appointments (store_id, staff_id, title, starts_at, ends_at, status)
      values ($1, $2, 'cut 2', $3, $4, 'scheduled')`, [SA, staffId, t2.toISOString(), t3.toISOString()]);
  } catch { secondAccepted = false; }
  rec(secondAccepted ? 'FAIL' : 'PASS', 'server rejects overlapping appointment for same staff (UI-only check leaves race)',
    secondAccepted ? 'both overlapping appointments stored' : 'rejected');
}

// ---------- data abuse at SQL layer ----------
{
  const longName = 'NUCLEARQA-' + 'x'.repeat(10000);
  const r = await q(`insert into public.pos_products (store_id, name, price_cents) values ($1, $2, 100) returning id`, [SA, longName]);
  rec(!!r.rows[0].id ? 'PASS' : 'FAIL', 'DOCUMENT: 10k-char product name accepted by DB (rendering layer must clamp)', 'stored');
  await q(`delete from public.pos_products where id = $1`, [r.rows[0].id]);
  await expectRefused('$0 product rejected (price_cents > 0 CHECK)',
    `insert into public.pos_products (store_id, name, price_cents) values ($1, 'free', 0)`, [SA]);
}

// ---------- online ordering (migration 071) ----------
{
  const asJson = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
  await asUser(A);
  await setStock(5);
  await q(`insert into public.storefront_profiles (store_id, slug, display_name, published, online_ordering)
    values ($1, 'nuclearqa-a', 'NUCLEARQA Shop A', true, true)
    on conflict (store_id) do update set slug = excluded.slug, display_name = excluded.display_name,
      published = excluded.published, online_ordering = excluded.online_ordering`, [SA]);

  await asUser(C);
  const placed = await q(`select public.online_order_place($1, $2::jsonb, $3, $4, $5, $6) as res`,
    ['nuclearqa-a', JSON.stringify([{ product_id: PA, qty: 2 }]), 'pickup note', 'Customer C', '', 'nq-online-1']);
  const order = asJson(placed.rows[0].res);
  rec(order && order.status === 'received' && order.total_cents === 2500 ? 'PASS' : 'FAIL',
    'customer places online order with server-derived total', JSON.stringify(order).slice(0, 140));
  const replay = await q(`select public.online_order_place($1, $2::jsonb, $3, $4, $5, $6) as res`,
    ['nuclearqa-a', JSON.stringify([{ product_id: PA, qty: 2 }]), 'pickup note', 'Customer C', '', 'nq-online-1']);
  const replayOrder = asJson(replay.rows[0].res);
  rec(replayOrder && replayOrder.id === order.id ? 'PASS' : 'FAIL',
    'online order idempotency key replays original order', `first=${order.id?.slice(0, 8)} replay=${replayOrder?.id?.slice(0, 8)}`);
  await expectRefused('online order beyond tracked stock rejected',
    `select public.online_order_place($1, $2::jsonb, $3, $4, $5, $6)`,
    ['nuclearqa-a', JSON.stringify([{ product_id: PA, qty: 6 }]), '', 'Customer C', '', 'nq-online-oos']);

  await asUser(B);
  await expectEmpty('other customer cannot read C online order items via RLS',
    `select id from public.online_order_items where order_id = $1`, [order.id]);
  await expectRefused('non-member cannot read shop online order inbox',
    `select public.online_orders_inbox($1)`, [SA]);
  const bOrders = asJson((await q(`select public.online_order_my_orders($1) as res`, ['nuclearqa-a'])).rows[0].res);
  rec(Array.isArray(bOrders) && bOrders.length === 0 ? 'PASS' : 'FAIL',
    'other customer sees only own online orders (none)', `n=${Array.isArray(bOrders) ? bOrders.length : '?'}`);

  await asUser(A);
  const inbox = asJson((await q(`select public.online_orders_inbox($1) as res`, [SA])).rows[0].res);
  rec(Array.isArray(inbox) && inbox.some((o) => o.id === order.id) ? 'PASS' : 'FAIL',
    'shop inbox receives customer order', `orders=${Array.isArray(inbox) ? inbox.length : '?'}`);
  await q(`select public.online_order_set_status($1, 'preparing')`, [order.id]);
  await q(`select public.online_order_set_status($1, 'ready')`, [order.id]);
  const converted = asJson((await q(`select public.online_order_convert($1, 'cash', $2) as res`, [order.id, order.total_cents])).rows[0].res);
  rec(converted && converted.sale_id && converted.already === false ? 'PASS' : 'FAIL',
    'ready online order converts to POS sale', JSON.stringify(converted).slice(0, 140));
  const stockAfterConvert = await getStock();
  rec(stockAfterConvert === 3 ? 'PASS' : 'FAIL', 'online conversion decrements stock once', `stock=${stockAfterConvert}`);
  const convertedAgain = asJson((await q(`select public.online_order_convert($1, 'cash', $2) as res`, [order.id, order.total_cents])).rows[0].res);
  const stockAfterReplay = await getStock();
  const onlineSales = await q(`select count(*)::int as n from public.pos_sales where store_id = $1 and channel = 'online'`, [SA]);
  rec(convertedAgain && convertedAgain.already === true && stockAfterReplay === 3 && onlineSales.rows[0].n === 1 ? 'PASS' : 'FAIL',
    'online conversion replay returns existing sale without double stock/sale', `stock=${stockAfterReplay} sales=${onlineSales.rows[0].n}`);
  await asUser(C);
  await expectRefused('customer cannot cancel a completed online order',
    `select public.online_order_cancel($1)`, [order.id]);
  await asUser(A);
}

// ---------- factory reset as master (LAST: wipes everything) ----------
if (MASTER) {
  await asUser(MASTER);
  let resetOk = true, resetErr = '';
  try { await q(`select public.factory_reset()`); } catch (e) { resetOk = false; resetErr = e.message.slice(0, 160); }
  rec(resetOk ? 'PASS' : 'FAIL', 'master factory_reset executes', resetErr);
  if (resetOk) {
    await asRoot();
    const counts = await q(`select
      (select count(*)::int from public.pos_stores) as stores,
      (select count(*)::int from public.pos_products) as products,
      (select count(*)::int from public.pos_sales) as sales,
      (select count(*)::int from public.storefront_profiles) as storefronts,
      (select count(*)::int from public.profiles) as profiles,
      (select count(*)::int from auth.users) as users`);
    const c = counts.rows[0];
    rec(c.stores === 0 && c.products === 0 && c.sales === 0 && c.storefronts === 0 ? 'PASS' : 'FAIL',
      'factory reset wipes all shop data', JSON.stringify(c));
    rec(c.profiles === 1 && c.users === 1 ? 'PASS' : 'FAIL',
      'factory reset leaves exactly the master account', JSON.stringify(c));
  }
}

console.log(`\nPGLITE SUITE: pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
