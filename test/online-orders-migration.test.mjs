/**
 * Static (offline) checks for migration 071 — customer accounts + online
 * ordering (supabase/migrations/071_customer_orders.sql), the final
 * factory-reset wipe list in 078, and the online_order_items RLS
 * convergence fix in 079.
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
const mig071 = readFileSync(join(here, '..', 'supabase', 'migrations', '071_customer_orders.sql'), 'utf8');
const mig078 = readFileSync(join(here, '..', 'supabase', 'migrations', '078_factory_reset_final.sql'), 'utf8');
const mig079 = readFileSync(join(here, '..', 'supabase', 'migrations', '079_online_order_items_rls_fix.sql'), 'utf8');

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

// The active (non-rollback) part of migration 071: everything before the
// commented rollback block.
const active = mig071.split('-- ROLLBACK')[0];

console.log('online-orders-migration (071 + 078/079 convergence)');

check('RLS enabled on all three order tables', () => {
  for (const t of ['online_customers', 'online_orders', 'online_order_items']) {
    assert.ok(
      new RegExp(`alter table public\\.${t} enable row level security`).test(active),
      `${t} not RLS-enabled`
    );
  }
});

check('no direct-write RLS policies: select-only, all writes via RPC', () => {
  const policies = `${active}\n${mig079}`.match(/create policy[\s\S]*?;/g) || [];
  assert.ok(policies.length >= 3, 'expected select policies');
  for (const p of policies) {
    assert.ok(/for select/i.test(p), `non-select policy: ${p.slice(0, 60)}`);
    assert.ok(!/for (insert|update|delete)/i.test(p), `write policy found: ${p.slice(0, 60)}`);
  }
});

check('079 keeps online_order_items readable only by staff or the owning customer', () => {
  assert.ok(/drop policy if exists online_order_items_select/i.test(mig079));
  assert.ok(/create policy online_order_items_select[\s\S]*for select to authenticated/i.test(mig079));
  assert.ok(/public\.is_pos_member\(o\.store_id\)/.test(mig079));
  assert.ok(/public\.online_customers c[\s\S]*c\.user_id = auth\.uid\(\)/.test(mig079));
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

check('factory_reset() truncate list wipes the three new tables (51 total)', () => {
  const m = mig078.match(/truncate table([\s\S]*?);/i);
  assert.ok(m, 'truncate list not found');
  for (const t of ['online_customers', 'online_orders', 'online_order_items']) {
    assert.ok(m[1].includes(`public.${t}`), `${t} missing from factory_reset truncate`);
  }
  const count = (m[1].match(/public\.[a-z_]+/g) || []).length;
  assert.equal(count, 51, `truncate lists ${count} tables, expected 51`);
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
  assert.ok(/v_recent >= 5/.test(active));
  assert.ok(/ONLINE_TOO_MANY_ORDERS/.test(active));
});

check('stock decrements ONLY in online_order_convert, via the keyed stock RPC', () => {
  const placeFn = active
    .split('create or replace function public.online_order_place')[1]
    .split('create or replace function public.online_order_my_orders')[0];
  assert.ok(!/pos_apply_sale_stock/.test(placeFn), 'place() must not touch stock');
  assert.ok(/select public\.pos_apply_sale_stock_once\(o\.store_id, v_lines, v_key, v_sale_id\) into v_stock/.test(active),
    'convert() must call pos_apply_sale_stock_once with the sale key');
});

check('convert is idempotent: same RPC run twice returns one sale', () => {
  assert.ok(active.includes("v_key := 'online-order:' || p_order_id::text"));
  assert.ok(/if o\.sale_id is not null/i.test(active), 'convert must short-circuit when already done');
});

check('converted sales are recorded on the online channel', () => {
  assert.ok(/tax_lines, idempotency_key, channel/.test(active));
  assert.ok(/v_key, 'online'/.test(active));
});

check('server recomputes prices: place() re-reads the product row', () => {
  assert.ok(/online_order_tax_lines/.test(active), 'place() must use the server tax mirror');
  assert.ok(/from public\.pos_products p/.test(active), 'place() must re-read products');
  assert.ok(/v_qty < 1 or v_qty > 999/.test(active), 'server qty bound 999 missing');
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
  const tail = mig071.slice(mig071.indexOf('-- ROLLBACK'));
  assert.ok(tail.length > 100, 'rollback block missing');
  assert.ok(!/^drop function public\.online_order_place/m.test(tail),
    'rollback must not be live code');
});

check('no service_role grants and no secrets in the migrations', () => {
  assert.ok(!/service_role/i.test(active), 'service_role grant found');
  // encrypted_password is a column name in the factory reseed (the hash is
  // computed inside SQL) — not a secret literal.
  const scrubbed = `${active}\n${mig078}\n${mig079}`.replace(/encrypted_password/g, '');
  assert.ok(!/supabase_url|anon_key|password\s*[:=]\s*['"][^'"]+['"]/i.test(scrubbed), 'secret-like literal found');
});

console.log(`\n${n} checks done`);
