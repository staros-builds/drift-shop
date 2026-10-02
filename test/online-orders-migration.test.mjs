/**
 * Static (offline) checks for draft migration 073 — customer accounts +
 * online ordering (supabase/migrations/073_draft_customer_orders.sql).
 * Run: node test/online-orders-migration.test.mjs
 *
 * These guard the security contract without a database: RLS must be
 * select-only (all writes go through SECURITY DEFINER RPCs), factory_reset
 * must wipe every new table, stock must decrement exactly once and only
 * at convert-to-sale, prices must be recomputed server-side, and the
 * abuse bounds must be present.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const MIG = '073_draft_customer_orders.sql';
const sql = readFileSync(join(here, '..', 'supabase', 'migrations', MIG), 'utf8');

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

// The active (non-rollback) part of the migration: everything before the
// commented rollback block.
const active = sql.split('-- ROLLBACK')[0];

console.log('online-orders-migration (073 draft)');

check('RLS enabled on all three order tables', () => {
  for (const t of ['online_customers', 'online_orders', 'online_order_items']) {
    assert.ok(
      new RegExp(`alter table public\\.${t} enable row level security`).test(active),
      `${t} not RLS-enabled`
    );
  }
});

check('no direct-write RLS policies: select-only, all writes via RPC', () => {
  const policies = active.match(/create policy[\s\S]*?;/g) || [];
  assert.ok(policies.length >= 3, 'expected select policies');
  for (const p of policies) {
    assert.ok(/for select/i.test(p), `non-select policy: ${p.slice(0, 60)}`);
    assert.ok(!/for (insert|update|delete)/i.test(p), `write policy found: ${p.slice(0, 60)}`);
  }
});

check('table grants are select-only; RPCs granted to authenticated only', () => {
  assert.ok(!/grant\s+(insert|update|delete)\s+on\s+(public\.)?(online_customers|online_orders|online_order_items)/i.test(active));
  // The nine customer/staff-facing RPCs are granted; the four internal
  // helpers (tax lines, slug lookup, customer ensure, order JSON) must
  // NOT be directly callable — only reachable from SECURITY DEFINER code.
  const publicRpcs = [
    'online_profile_get', 'online_profile_save', 'online_order_place',
    'online_order_my_orders', 'online_order_cancel', 'online_orders_inbox',
    'online_orders_archive', 'online_order_set_status', 'online_order_convert',
  ];
  for (const fn of publicRpcs) {
    assert.ok(new RegExp(`grant execute on function public\\.${fn}\\(`).test(active),
      `${fn} not granted`);
  }
  for (const fn of ['online_order_tax_lines', 'online_store_for_slug', 'online_customer_ensure', 'online_order_json']) {
    assert.ok(!new RegExp(`grant execute on function public\\.${fn}\\(`).test(active),
      `internal helper ${fn} must not be granted`);
  }
  const rpcGrants = active.match(/grant execute on function public\.online_[a-z_]+\([^)]*\) to ([a-z, ]+);/gi) || [];
  for (const g of rpcGrants) {
    assert.ok(/to authenticated;/.test(g), `grant not limited to authenticated: ${g}`);
  }
});

check('anonymous role gets nothing but the public storefront read', () => {
  const anonGrants = active.match(/grant[^;]*to anon[^;]*;/gi) || [];
  assert.ok(anonGrants.length >= 1, 'expected the public storefront anon grant');
  for (const g of anonGrants) {
    assert.ok(/public_storefront/.test(g), `anon grant outside public storefront: ${g}`);
  }
});

check('factory_reset() truncate list wipes the three new tables', () => {
  const m = active.match(/truncate table([\s\S]*?);/i);
  assert.ok(m, 'truncate list not found');
  for (const t of ['online_customers', 'online_orders', 'online_order_items']) {
    assert.ok(m[1].includes(`public.${t}`), `${t} missing from factory_reset truncate`);
  }
  // comment says 45 tables: count the public.* entries in the list
  const count = (m[1].match(/public\.[a-z_]+/g) || []).length;
  assert.equal(count, 45, `truncate lists ${count} tables, comment says 45`);
});

check('order numbers and idempotency keys are unique per shop', () => {
  assert.ok(active.includes('unique (store_id, number)'));
  assert.ok(active.includes('unique (store_id, idempotency_key)'));
});

check('status column only allows the five plain-word statuses', () => {
  const m = active.match(/status\s+text[\s\S]*?check\s*\(([^)]*)\)/i);
  assert.ok(m, 'status check constraint not found');
  for (const s of ['received', 'preparing', 'ready', 'done', 'cancelled']) {
    assert.ok(m[1].includes(`'${s}'`), `status '${s}' missing`);
  }
});

check('order-spam rate limit: 5 orders per 10 minutes per customer', () => {
  assert.ok(/interval '10 minutes'/.test(active));
  assert.ok(/>=\s*5\s+then raise exception 'ONLINE_TOO_MANY_ORDERS'/.test(active) ||
            /v_recent >= 5/.test(active));
});

check('stock decrements ONLY in online_order_convert, via pos_apply_sale_stock', () => {
  const placeFn = active.split('online_order_place')[1].split('$$')[2] || '';
  assert.ok(!/pos_apply_sale_stock/.test(placeFn), 'place() must not touch stock');
  assert.ok(active.includes('select public.pos_apply_sale_stock(o.store_id, v_lines) into v_stock'),
    'convert() must call pos_apply_sale_stock');
});

check('convert is idempotent: same RPC run twice returns one sale', () => {
  assert.ok(active.includes("v_key := 'online-order:' || p_order_id::text"));
  assert.ok(/if o\.sale_id is not null/i.test(active), 'convert must short-circuit when already done');
});

check('pos_sales channel check admits the online channel', () => {
  assert.ok(/channel in \('register', 'fair', 'online'\)/.test(active));
});

check('server recomputes prices: place() re-reads the product row', () => {
  assert.ok(/online_order_tax_lines/.test(active), 'place() must use the server tax mirror');
  assert.ok(/v_price := p\.price_cents/.test(active) || /price_cents/.test(active));
  // quantities are hard-bounded at the server too (clamp + column check)
  assert.ok(/least\(999/.test(active) || /between 1 and 999/.test(active), 'server qty bound 999 missing');
  assert.ok(/ONLINE_ITEM_UNAVAILABLE/.test(active));
  assert.ok(/ONLINE_OUT_OF_STOCK/.test(active));
});

check('public_storefront() carries the ordering toggle + tax config', () => {
  assert.ok(/online_ordering/.test(active));
  assert.ok(active.match(/create or replace function public\.public_storefront/));
  // products carry id + stock info for the ordering UI
  assert.ok(/track_stock/.test(active));
});

check('rollback block stays commented out (coordinator applies forward)', () => {
  const tail = sql.slice(sql.indexOf('-- ROLLBACK'));
  assert.ok(tail.length > 100, 'rollback block missing');
  assert.ok(!/^drop function public\.online_order_place/m.test(tail),
    'rollback must not be live code');
});

check('no service_role grants and no secrets in the migration', () => {
  assert.ok(!/service_role/i.test(active), 'service_role grant found');
  // encrypted_password is a column name in the factory reseed (the hash is
  // computed inside SQL) — not a secret literal.
  const scrubbed = active.replace(/encrypted_password/g, '');
  assert.ok(!/supabase_url|anon_key|password\s*[:=]\s*['"][^'"]+['"]/i.test(scrubbed), 'secret-like literal found');
});

console.log(`\n${n} checks done`);
