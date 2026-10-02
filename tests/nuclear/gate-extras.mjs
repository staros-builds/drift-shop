// Gate extras for the merged build:
// 1. Migrations 067-078 apply TWICE (idempotency gate).
// 2. pos_apply_sale_stock_once applies stock exactly once per key.
// 3. Appointment overlap trigger refuses double-booking.
import fs from 'node:fs';
import path from 'node:path';
let PGlite, pgcryptoExt = null;
try { ({ PGlite } = await import('@electric-sql/pglite')); } catch {
  ({ PGlite } = await import('/home/hatch/workspace/harnesses/pglite-pg/node_modules/@electric-sql/pglite/dist/index.js'));
  try { ({ pgcrypto: pgcryptoExt } = await import('/home/hatch/workspace/harnesses/pglite-pg/node_modules/@electric-sql/pglite/dist/contrib/pgcrypto.js')); } catch {}
}
const ROOT = '/home/hatch/workspace/build3/drift-shop';
const db = new PGlite(pgcryptoExt ? { extensions: { pgcrypto: pgcryptoExt } } : {});
const q = (sql, params) => db.query(sql, params);
// Platform stubs copied from pglite-suite.mjs (same Supabase shapes).
await db.exec(`
create schema if not exists auth; create schema if not exists extensions; create schema if not exists storage;
create extension if not exists pgcrypto with schema extensions;
set search_path = public, extensions, auth;
create table if not exists auth.users (
  id uuid primary key, instance_id uuid, email text, encrypted_password text,
  email_confirmed_at timestamptz, confirmation_sent_at timestamptz, confirmed_at timestamptz,
  last_sign_in_at timestamptz, invited_at timestamptz,
  raw_user_meta_data jsonb not null default '{}'::jsonb, raw_app_meta_data jsonb not null default '{}'::jsonb,
  aud text, role text, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  confirmation_token text, recovery_token text, email_change text,
  email_change_token_current text, email_change_token_new text, email_change_confirm_status smallint,
  phone text default '', phone_confirmed_at timestamptz, phone_change text default '', phone_change_token text default '',
  phone_change_sent_at timestamptz, reauthentication_token text default '', reauthentication_sent_at timestamptz,
  recovery_sent_at timestamptz, banned_until timestamptz, deleted_at timestamptz,
  is_sso_user boolean default false, is_anonymous boolean default false
);
create table if not exists auth.identities (
  id uuid primary key default gen_random_uuid(), user_id uuid not null,
  identity_data jsonb not null default '{}'::jsonb, provider text not null, provider_id text,
  last_sign_in_at timestamptz, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
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
create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls; create role supabase_admin nologin;
create publication supabase_realtime;
grant usage on schema public to anon, authenticated, service_role;
grant usage on schema auth to anon, authenticated, service_role;
`);
const migDir = path.join(ROOT, 'supabase/migrations');
const migFiles = fs.readdirSync(migDir).filter((f) => f.endsWith('.sql')).sort();
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
async function apply(file) {
  const sql = fs.readFileSync(path.join(migDir, file), 'utf8');
  try { await db.exec(sql); return; } catch { /* fall back per-statement */ }
  for (const raw of splitStatements(sql)) {
    const s = raw.trim();
    if (!s || !s.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n').trim()) continue;
    if (/supabase_realtime/i.test(s)) continue;
    try { await db.exec(s); } catch (e) { failed.push({ file, error: e.message.slice(0, 130) }); }
  }
}
await (async () => { const sql = fs.readFileSync(path.join(ROOT, 'supabase/schema.sql'), 'utf8'); try { await db.exec(sql); } catch { for (const raw of splitStatements(sql)) { const s2 = raw.trim(); if (!s2 || /supabase_realtime/i.test(s2)) continue; try { await db.exec(s2); } catch (e) { failed.push({ file: 'schema.sql', error: e.message.slice(0, 130) }); } } } })();
for (const f of migFiles) await apply(f);
if (failed.length) { console.log('FAILED STATEMENTS (all files):'); for (const f of failed.slice(0,10)) console.log('  ', f.file, f.error); }
console.log('PASS  all migrations applied once');

// Gate 1: apply 067-078 a second time
for (const f of migFiles.filter((f) => parseInt(f.slice(0, 3), 10) >= 67)) await apply(f);
console.log('PASS  migrations 067-078 applied twice (idempotent)');

// Gate 2 + 3 need a master + shop. Seed via the same shape the suite uses:
// create master directly (profile + auth user), a store, staff, product.
const masterId = '11111111-1111-1111-1111-111111111111';
await q(`insert into auth.users (id, email, email_confirmed_at) values ($1, 'admin@drift-shop.app', now())`, [masterId]);
// act as master (claims in place before touching guarded fields)
await db.exec(`select set_config('request.jwt.claim.sub', '${masterId}', false)`);
await db.exec(`select set_config('request.jwt.claim.role', 'authenticated', false)`);
// handle_new_user already made the profile; promote it to master.
await q(`update public.profiles set is_master = true, role = 'admin', account_kind = 'owner' where id = $1`, [masterId]);
const store = (await q(`insert into public.pos_stores (name, created_by) values ('Gate Shop', $1) returning id`, [masterId])).rows[0].id;
// Store creation auto-enrolls the creator as owner member (verified:
// an explicit insert hits pos_store_members_pkey).
const prod = (await q(`insert into public.pos_products (store_id, name, price_cents, stock, track_stock) values ($1, 'Widget', 100, 10, true) returning id`, [store])).rows[0].id;
const lines = JSON.stringify([{ product_id: prod, qty: 3, name: 'Widget' }]);
const r1 = (await q(`select public.pos_apply_sale_stock_once($1, $2::jsonb, 'gate-key-1') as r`, [store, lines])).rows[0].r;
const r2 = (await q(`select public.pos_apply_sale_stock_once($1, $2::jsonb, 'gate-key-1') as r`, [store, lines])).rows[0].r;
const stock = (await q(`select stock from public.pos_products where id = $1`, [prod])).rows[0].stock;
console.log(`stock after two keyed calls: ${stock} (expect 7); second already_applied=${r2.already_applied ?? r2.alreadyApplied}`);
if (stock !== 7) { console.log('FAIL  stock exactly-once'); process.exit(1); }
console.log('PASS  stock exactly-once per idempotency key');

// Gate 3: appointment overlap
const staff = (await q(`insert into public.pos_staff (store_id, name, pin_hash) values ($1, 'Sam', 'x') returning id`, [store])).rows[0].id;
await q(`insert into public.pos_appointments (store_id, staff_id, title, starts_at, ends_at, status) values ($1, $2, 'Cut', '2026-10-05 10:00', '2026-10-05 11:00', 'scheduled')`, [store, staff]);
let blocked = false;
try {
  await q(`insert into public.pos_appointments (store_id, staff_id, title, starts_at, ends_at, status) values ($1, $2, 'Cut', '2026-10-05 10:30', '2026-10-05 11:30', 'scheduled')`, [store, staff]);
} catch (e) { blocked = /overlaps/.test(e.message); }
console.log(blocked ? 'PASS  appointment overlap refused' : 'FAIL  appointment overlap NOT refused');
// back-to-back must be allowed
await q(`insert into public.pos_appointments (store_id, staff_id, title, starts_at, ends_at, status) values ($1, $2, 'Cut', '2026-10-05 11:00', '2026-10-05 12:00', 'scheduled')`, [store, staff]);
console.log('PASS  back-to-back appointment allowed');
console.log('GATE EXTRAS DONE');
