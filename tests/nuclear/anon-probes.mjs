// Nuclear QA — anonymous (no-login) probes against the live backend.
// Read-only: GETs and RPC calls that must refuse or return nothing.
// Usage: node tests/nuclear/anon-probes.mjs
// Reads SUPABASE_URL / SUPABASE_ANON_KEY from env or /tmp/ds-env.json {url,key}.
import fs from 'node:fs';

const envPath = '/tmp/ds-env.json';
const cfg = fs.existsSync(envPath)
  ? JSON.parse(fs.readFileSync(envPath, 'utf8'))
  : { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_ANON_KEY };
const URL_ = cfg.url;
const KEY = cfg.key;
if (!URL_ || !KEY) { console.error('missing config'); process.exit(2); }

let pass = 0, fail = 0, blocked = 0;
const results = [];
function rec(status, name, detail = '') {
  results.push({ status, name, detail });
  if (status === 'PASS') pass++; else if (status === 'FAIL') fail++; else blocked++;
  console.log(`${status}  ${name}${detail ? ' — ' + detail : ''}`);
}

const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };

async function get(path) {
  const r = await fetch(`${URL_}/rest/v1/${path}`, { headers: H });
  const text = await r.text();
  return { status: r.status, text: text.slice(0, 300) };
}
async function rpc(fn, body) {
  const r = await fetch(`${URL_}/rest/v1/rpc/${fn}`, {
    method: 'POST', headers: H, body: JSON.stringify(body || {}),
  });
  const text = await r.text();
  return { status: r.status, text: text.slice(0, 400) };
}

// 1. Anon must not read business tables (RLS: no anon policy -> 200 [] or 401/403; data rows = FAIL)
const TABLES = ['pos_stores','pos_products','pos_sales','pos_customers','pos_staff','pos_appointments',
  'pos_gift_cards','pos_refunds','storefront_profiles','support_tickets','profiles','pos_store_members',
  'pos_orgs','pos_time_punches','bq_items','user_settings','vfs_files'];
for (const t of TABLES) {
  const r = await get(`${t}?select=*&limit=3`);
  let rows = null;
  try { rows = JSON.parse(r.text); } catch { /* not json */ }
  const leaked = Array.isArray(rows) && rows.length > 0;
  rec(leaked ? 'FAIL' : 'PASS', `anon SELECT ${t}`, `http=${r.status} rows=${Array.isArray(rows) ? rows.length : 'n/a'}`);
}

// 2. Anon must not write (attempt insert into pos_products with bogus store — expect 401/403/404)
{
  const r = await fetch(`${URL_}/rest/v1/pos_products`, {
    method: 'POST', headers: { ...H, Prefer: 'return=representation' },
    body: JSON.stringify({ store_id: '00000000-0000-0000-0000-000000000000', name: 'NUCLEARQA-anon-write' }),
  });
  rec(r.status >= 400 ? 'PASS' : 'FAIL', 'anon INSERT pos_products refused', `http=${r.status}`);
}

// 3. Anon must not execute privileged RPCs
for (const [fn, body] of [
  ['factory_reset', {}],
  ['admin_create_user', { p_email: 'x@x.co', p_password: 'x' }],
  ['pos_void_sale', { p_sale_id: '00000000-0000-0000-0000-000000000000' }],
  ['pos_refund_sale', { p_sale_id: '00000000-0000-0000-0000-000000000000', p_lines: [] }],
  ['pos_giftcard_redeem', { p_card_id: '00000000-0000-0000-0000-000000000000', p_amount_cents: 1 }],
  ['pos_apply_sale_stock', { p_store_id: '00000000-0000-0000-0000-000000000000', p_lines: [] }],
]) {
  const r = await rpc(fn, body);
  // Refused = 400 with app-level 'sign in' message, or 401/403/404 permission. Accepted silently = FAIL.
  const refused = r.status === 401 || r.status === 403 || r.status === 404 || /sign in|permission|not a member|restricted/i.test(r.text);
  rec(refused ? 'PASS' : 'FAIL', `anon RPC ${fn} refused`, `http=${r.status} ${r.text.slice(0, 90)}`);
}

// 4. Storefront RPC edge cases
async function sf(slug) {
  const r = await rpc('public_storefront', { p_slug: slug });
  let data = null;
  try { data = JSON.parse(r.text); } catch { /* */ }
  return { ...r, data };
}
{
  const ok = await sf('heavy-test');
  rec(ok.status === 200 && ok.data && Array.isArray(ok.data.products) ? 'PASS' : 'FAIL',
    'storefront heavy-test loads', `http=${ok.status} products=${ok.data?.products?.length}`);
  const names = (ok.data?.products || []).map((p) => p.name);
  rec(names.some((n) => /heavy widget/i.test(n)) ? 'PASS' : 'FAIL', 'storefront shows published product', names.slice(0, 5).join('|').slice(0, 120));
  const leakedFields = (ok.data?.products || []).some((p) => Object.keys(p).some((k) => !['name', 'price'].includes(k)));
  rec(!leakedFields ? 'PASS' : 'FAIL', 'storefront product payload has only name+price', '');
  const shopKeys = ok.data?.shop ? Object.keys(ok.data.shop) : [];
  const badShopKeys = shopKeys.filter((k) => !['display_name','tagline','about','hours','contact_email','contact_phone','accent_color','show_prices'].includes(k));
  rec(badShopKeys.length === 0 ? 'PASS' : 'FAIL', 'storefront shop payload has no internal fields', badShopKeys.join(','));

  for (const [slug, label] of [
    ['no-such-shop-nuclear', 'unknown slug -> null'],
    ['', 'empty slug -> null'],
    ['HEAVY-TEST', 'uppercase slug normalized or null'],
    [' heavy-test ', 'whitespace slug trimmed or null'],
    ["heavy-test' OR '1'='1", 'SQLi slug -> null, no error leak'],
    ['heavy-test; DROP TABLE pos_sales', 'SQLi slug 2 -> null, no error leak'],
    ['%00heavy-test', 'NUL byte slug -> null'],
    ['a'.repeat(500), '500-char slug -> null, no crash'],
    ['../heavy-test', 'path-ish slug -> null'],
    ['heavy_test', 'underscore slug -> null (grammar)'],
  ]) {
    const r = await sf(slug);
    const isNull = r.data === null;
    const errLeak = /error|exception|PGRST|postgres/i.test(r.text) && r.status >= 400;
    rec(isNull && !errLeak ? 'PASS' : 'FAIL', label, `http=${r.status} null=${isNull} body=${r.text.slice(0, 80)}`);
  }
  // null slug
  const r = await rpc('public_storefront', { p_slug: null });
  rec(r.status === 200 && r.text.trim() === 'null' || r.status === 400 ? 'PASS' : 'FAIL', 'null slug handled', `http=${r.status}`);
}

// 5. Auth endpoint behaviour: wrong password must fail cleanly; garbage token must 401
{
  const r = await fetch(`${URL_}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey: KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'nuclearqa-nobody@drift-shop.app', password: 'WrongPassword123!' }),
  });
  const t = await r.text();
  rec(r.status === 400 && /invalid/i.test(t) ? 'PASS' : 'FAIL', 'wrong-password sign-in rejected generically', `http=${r.status} ${t.slice(0, 100)}`);
  const r2 = await fetch(`${URL_}/rest/v1/pos_stores?select=id&limit=1`, {
    headers: { apikey: KEY, Authorization: 'Bearer garbage.token.here' },
  });
  rec(r2.status === 401 ? 'PASS' : 'FAIL', 'garbage JWT rejected', `http=${r2.status}`);
}

// 6. Storage: anon must not list buckets/objects
{
  const r = await fetch(`${URL_}/storage/v1/bucket`, { headers: H });
  const t = await r.text();
  let buckets = null;
  try { buckets = JSON.parse(t); } catch { /* */ }
  rec(r.status >= 400 || (Array.isArray(buckets) && buckets.length === 0) ? 'PASS' : 'FAIL',
    'anon storage bucket list empty/refused', `http=${r.status} ${t.slice(0, 80)}`);
}

console.log(`\nANON PROBES: pass=${pass} fail=${fail} blocked=${blocked}`);
process.exit(fail ? 1 : 0);
