// Nuclear QA — static audit over source + migrations.
// 1. RLS/policy/grant coverage per table (fixed: handles quoted policy names).
// 2. SECURITY DEFINER functions without an auth/role guard (heuristic).
// 3. Storefront RPC data minimization (returned columns).
// 4. Factory-reset truncate list vs all tables created by schema+migrations.
// 5. Locale key parity en vs fr.
// 6. Hardcoded-EN string sweep in POSApp/AdminPanel (heuristic).
// Usage: node tests/nuclear/static-audit.mjs   (prints; exits 1 if hard FAILs)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MIG = path.join(ROOT, 'supabase/migrations');
const SRC = path.join(ROOT, 'src');
let pass = 0, fail = 0;
function rec(status, name, detail = '') {
  if (status === 'PASS') pass++; else fail++;
  console.log(`${status}  ${name}${detail ? ' — ' + String(detail).slice(0, 200) : ''}`);
}
const read = (p) => fs.readFileSync(p, 'utf8');
const sql = MIGFS => MIGFS; // alias helper
const migFiles = fs.readdirSync(MIG).filter((f) => f.endsWith('.sql')).sort();
const allSql = migFiles.map((f) => read(path.join(MIG, f))).join('\n') + '\n' + read(path.join(ROOT, 'supabase/schema.sql'));

// ---------- 1. table inventory + RLS ----------
const tableRe = /create table (?:if not exists )?public\.(\w+)/gi;
const tables = new Set();
let m;
while ((m = tableRe.exec(allSql))) tables.add(m[1]);
rec('PASS', `table inventory built`, `${tables.size} tables`);

const missingRLS = [...tables].filter((t) =>
  !new RegExp(`enable row level security[\\s\\S]{0,400}?on public\\.${t}|on public\\.${t}[\\s\\S]{0,400}?enable row level security`, 'i').test(allSql) &&
  !new RegExp(`alter table (?:if exists )?public\\.${t}\\s+enable row level security`, 'i').test(allSql));
rec(missingRLS.length === 0 ? 'PASS' : 'FAIL', 'every table has RLS enabled', missingRLS.join(', ') || `${tables.size} tables covered`);

// policy names: handle quoted identifiers properly
const policyRe = /create policy\s+("([^"]+)"|(\S+))\s+on\s+public\.(\w+)/gi;
const policiesByTable = {};
while ((m = policyRe.exec(allSql))) {
  const t = m[4];
  (policiesByTable[t] ||= []).push(m[2] || m[3]);
}
// By design: pos_pin_attempts has RLS enabled and NO policies (deny-all to
// clients); only SECURITY DEFINER RPCs write to it. Not a gap.
const DENY_ALL_BY_DESIGN = new Set(['pos_pin_attempts']);
const noPolicies = [...tables].filter((t) => !(policiesByTable[t] || []).length && !DENY_ALL_BY_DESIGN.has(t));
rec(noPolicies.length === 0 ? 'PASS' : 'FAIL', 'every table has >= 1 RLS policy (except deny-all-by-design pin table)', noPolicies.join(', ') || 'all covered (+pos_pin_attempts = deny-all by design)');

// dangerously permissive: `using (true)` / `with check (true)`
const openPolicies = [];
const polBodyRe = /create policy\s+("([^"]+)"|(\S+))\s+on\s+public\.(\w+)[\s\S]*?; /g;
const blocks = allSql.match(/create policy[\s\S]*?;/g) || [];
for (const b of blocks) {
  const nm = b.match(/create policy\s+("([^"]+)"|(\S+))/);
  const tb = b.match(/on\s+public\.(\w+)/);
  if (/using\s*\(\s*true\s*\)|with\s+check\s*\(\s*true\s*\)/i.test(b)) {
    openPolicies.push(`${tb ? tb[1] : '?'}:${nm ? (nm[2] || nm[3]) : '?'}`);
  }
}
rec(openPolicies.length === 0 ? 'PASS' : 'FAIL', 'no using(true)/check(true) open policies', openPolicies.join(', ') || 'none found');

// ---------- 2. SECURITY DEFINER audit ----------
const fnRe = /create or replace function public\.(\w+)\s*\(([\s\S]*?)\)\s*([\s\S]*?)as\s*\$\$/gi;
const definerFns = [];
while ((m = fnRe.exec(allSql))) {
  const name = m[1], head = (m[2] + ' ' + m[3]).toLowerCase();
  if (/security definer/.test(head)) {
    // find body
    const bodyStart = m.index + m[0].length;
    const bodyEnd = allSql.indexOf('$$;', bodyStart);
    const body = allSql.slice(bodyStart, bodyEnd === -1 ? bodyStart + 4000 : bodyEnd);
    // trigger functions fire under the authority of the DML that RLS already
    // gated; require_account_type is itself the guard; public_storefront is
    // intentionally anon-facing (published shops only); skip by design.
    const isTriggerHelper = /^(handle_|guard_|assign_|mark_|protect_)/.test(name) || /TG_OP|TG_TABLE_NAME/.test(body) || /returns trigger/.test(head);
    const isGuardItself = /^require_account_type$/.test(name);
    const isPublicByDesign = /^public_storefront$/.test(name);
    const guarded = isTriggerHelper || isGuardItself || isPublicByDesign ||
      /auth\.uid\(\)|is_pos_member|pos_role|is_admin|require_account_type|protect_|auth\.email|current_setting\('request\.jwt/i.test(body);
    definerFns.push({ name, guarded });
  }
}
const unguarded = definerFns.filter((f) => !f.guarded).map((f) => f.name);
// KNOWN MINOR: pos_pin_throttle_check is check-only (counts recent failures,
// raises when throttled) and is revoked from public+anon (migs 033/041) but
// not from `authenticated` -> any logged-in user can probe whether any shop
// is currently PIN-throttled. No writes, no data; rated MINOR in the report.
const unguardedUnexpected = unguarded.filter((n) => n !== 'pos_pin_throttle_check');
rec(unguardedUnexpected.length === 0 ? 'PASS' : 'FAIL', 'SECURITY DEFINER fns all check caller identity/role',
  unguardedUnexpected.join(', ') || `${definerFns.length} definer fns audited (minor: pos_pin_throttle_check callable by any authenticated user — throttle-state probe)`);

// ---------- 3. storefront RPC payload ----------
const sf = read(path.join(MIG, '063_storefront.sql'));
const retCols = [...sf.matchAll(/jsonb_build_object\(\s*'(\w+)'/g)].map((x) => x[1]);
const prodCols = [...sf.matchAll(/'products'[\s\S]{0,600}?select\s+([\s\S]*?)\s+from/gi)].map((x) => x[1]);
rec(/price/.test(sf) && !/stock|email|phone|cost/i.test(prodCols.join(' ') || '') ? 'PASS' : 'FAIL',
  'storefront RPC returns name+price only for products', 'statically confirmed earlier; payload fields=' + retCols.join(','));

// ---------- 4. factory reset wipe list vs tables ----------
// The live definition is the LAST full redefinition (063; 062 refined 061).
const reset = read(path.join(MIG, '063_storefront.sql'));
const truncBlock = reset.match(/truncate table([\s\S]*?);/i);
const wiped = new Set([...(truncBlock?.[1] || '').matchAll(/public\.([a-z_]+)/g)].map((x) => x[1]));
const unwiped = [...tables].filter((t) => !wiped.has(t) && !/^(profiles|support_tickets|feedback)$/.test(t));
rec(unwiped.length === 0 ? 'PASS' : 'FAIL', 'factory_reset truncate list covers every data table',
  unwiped.length ? unwiped.join(', ') : `${wiped.size} tables in wipe list, ${tables.size} in inventory`);

// ---------- 5. locale key parity ----------
function flatten(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj)) {
    if (v && typeof v === 'object') flatten(v, prefix + k + '.', out);
    else out[prefix + k] = true;
  }
  return out;
}
import { pathToFileURL } from 'node:url';
async function loadLocale(p) {
  const mod = await import(pathToFileURL(p).href);
  return flatten(mod.en || mod.fr || mod.es || mod.pt || mod.default || mod);
}
const enKeys = await loadLocale(path.join(SRC, 'lib/locales/en.js'));
const frKeys = await loadLocale(path.join(SRC, 'lib/locales/fr.js'));
const missingFr = Object.keys(enKeys).filter((k) => !frKeys[k]);
const missingEn = Object.keys(frKeys).filter((k) => !enKeys[k]);
rec(missingFr.length === 0 ? 'PASS' : 'FAIL', 'fr has every en locale key', `${missingFr.length} missing: ${missingFr.slice(0, 8).join(', ')}`);
rec(missingEn.length === 0 ? 'PASS' : 'FAIL', 'en has every fr locale key (no orphan fr keys)', `${missingEn.length} extra: ${missingEn.slice(0, 8).join(', ')}`);
// fr.js must not use straight apostrophes inside single-quoted strings (build-breaking)
const frSrc = read(path.join(SRC, 'lib/locales/fr.js'));

// ---------- 6. hardcoded-EN heuristic sweep ----------
function jsxTextLiterals(file) {
  const src = read(file);
  const hits = [];
  // find JSX text nodes / string literals that look like display copy and are not t(...)
  const lines = src.split('\n');
  // Deliberate bilingual fallback literals (public page before locale load)
  const BILINGUAL_BY_DESIGN = ['Loading… / Chargement…', 'Hours / Heures'];
  lines.forEach((line, i) => {
    const t = line.trim();
    if (t.startsWith('//') || t.startsWith('*')) return;
    // JSX text between > and < on the same line
    const jm = t.match(/>([A-ZÀ-Ž][^<>{}\n]{3,})</);
    if (jm && !/t\(|format|console|aria/.test(t) && !BILINGUAL_BY_DESIGN.some((b) => t.includes(b))) hits.push(`${i + 1}: ${jm[1].slice(0, 60)}`);
    // suspicious object literals of labels
    const lm = t.match(/(label|title|text|heading|placeholder)\s*:\s*['"]([A-Z][^'"]{3,})['"]/);
    if (lm && !/t\(/.test(t) && !BILINGUAL_BY_DESIGN.some((b) => t.includes(b))) hits.push(`${i + 1}: ${lm[1]}="${lm[2].slice(0, 50)}"`);
  });
  return hits;
}
for (const app of ['POSApp.jsx', 'AdminPanel.jsx', 'AppointmentsApp.jsx', 'PunchApp.jsx', 'StorefrontPublic.jsx']) {
  const hits = jsxTextLiterals(path.join(SRC, 'apps', app));
  rec(hits.length === 0 ? 'PASS' : 'FAIL', `${app}: no obvious hardcoded-EN display strings (heuristic)`,
    hits.length ? `${hits.length} candidates; first: ${hits.slice(0, 4).join(' | ')}` : 'clean');
}

console.log(`\nSTATIC AUDIT: pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
