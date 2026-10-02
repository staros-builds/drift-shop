// Nuclear QA — money & tax math harness (§6): adversarial tests on the real
// taxMath.js / moneyAudit.js modules. Usage: node tests/nuclear/money-harness.mjs
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
let pass = 0, fail = 0;
function rec(status, name, detail = '') {
  if (status === 'PASS') pass++; else fail++;
  console.log(`${status}  ${name}${detail ? ' — ' + String(detail).slice(0, 170) : ''}`);
}

const taxMath = await import(pathToFileURL(path.join(ROOT, 'src/lib/taxMath.js')).href);
const moneyAudit = await import(pathToFileURL(path.join(ROOT, 'src/lib/moneyAudit.js')).href);
const { taxLinesFor, taxTotalFor, TAX_PRESETS } = taxMath;
const { logMoneyMovement, verifyAuditChain } = moneyAudit;

const QC = { taxRates: [{ name: 'GST', rate: 5 }, { name: 'QST', rate: 9.975 }] };

// 1. Quebec stacked model — Revenu Quebec reference: $12.50
{
  const lines = taxLinesFor(QC, 1250);
  const gst = lines.find((l) => l.name === 'GST')?.cents;
  const qst = lines.find((l) => l.name === 'QST')?.cents;
  rec(gst === 63 && qst === 125 ? 'PASS' : 'FAIL', 'Quebec GST/QST per-line rounding ($12.50 -> 63c + 125c)', `gst=${gst} qst=${qst}`);
  const total = taxTotalFor(QC, 1250);
  rec(total === 188 ? 'PASS' : 'FAIL', 'taxTotalFor sums lines', `total=${total}`);
}
// 2. Known Revenu Quebec textbook: $100 -> GST $5.00, QST $9.98 (9.975 rounds to 9.98)
{
  const lines = taxLinesFor(QC, 10000);
  const qst = lines.find((l) => l.name === 'QST')?.cents;
  rec(qst === 998 ? 'PASS' : 'FAIL', 'QST $100 -> 998c (rounds 997.5 up)', `qst=${qst}`);
}
// 3. Negative taxable -> negative tax lines (DB tax_cents>=0 CHECK fail-stops;
{
  const lines = taxLinesFor(QC, -1250);
  const neg = lines.some((l) => l.cents < 0);
  rec(neg ? 'PASS' : 'FAIL', 'DOCUMENT: negative taxable yields negative tax (client shows negative; DB rejects)', JSON.stringify(lines.map((l) => l.cents)));
}
// 4. Fractional cents input
{
  const lines = taxLinesFor(QC, 1250.5);
  const ok = lines.every((l) => Number.isInteger(l.cents));
  rec(ok ? 'PASS' : 'FAIL', 'fractional-cent taxable still yields integer cents', JSON.stringify(lines.map((l) => l.cents)));
}
// 5. Huge amount — precision
{
  const lines = taxLinesFor(QC, Number.MAX_SAFE_INTEGER);
  const ok = lines.every((l) => Number.isSafeInteger(l.cents));
  rec(ok ? 'PASS' : 'FAIL', 'MAX_SAFE_INTEGER taxable keeps safe integers', JSON.stringify(lines.map((l) => l.cents)));
}
// 6. Compound row: tax on (taxable + prior tax)
{
  const lines = taxLinesFor({ taxRates: [{ name: 'A', rate: 5 }, { name: 'B', rate: 10, compound: true }] }, 10000);
  const b = lines.find((l) => l.name === 'B')?.cents; // 10% of (10000 + 500) = 1050
  rec(b === 1050 ? 'PASS' : 'FAIL', 'compound row calculated on tax-inclusive base', `B=${b}`);
}
// 7. Legacy single-rate fallback
{
  const lines = taxLinesFor({ taxRate: 5 }, 10000);
  rec(lines.length === 1 && lines[0].cents === 500 ? 'PASS' : 'FAIL', 'legacy tax_rate fallback', JSON.stringify(lines));
}
// 8. Zero rates produce no lines (filter keeps > 0 only)
{
  const lines = taxLinesFor({ taxRates: [{ name: 'Z', rate: 0 }] }, 10000);
  rec(lines.length === 0 ? 'PASS' : 'FAIL', 'zero-rate rows filtered out', `lines=${lines.length}`);
}
// 9. No crash on garbage store shapes
for (const [store, label] of [
  [null, 'null store'], [{}, 'empty store'], [{ taxRates: 'nope' }, 'string taxRates'],
  [{ taxRates: [{ name: 'X' }] }, 'rate missing'], [{ taxRates: [{ name: 'X', rate: 'abc' }] }, 'rate NaN'],
  [{ taxRate: -5 }, 'negative legacy rate'], [{ taxRates: [{ name: 'X', rate: 1e12 }] }, 'absurd rate'],
]) {
  try {
    const lines = taxLinesFor(store, 1250);
    const bad = lines.some((l) => !Number.isFinite(l.cents));
    rec(!bad ? 'PASS' : 'FAIL', `garbage store (${label}) -> finite or no lines`, JSON.stringify(lines.map((l) => l.cents)));
  } catch (e) { rec('PASS', `garbage store (${label}) throws loudly`, e.message.slice(0, 80)); }
}
// 10. Generic product: presets ship 0% placeholder rates (owner configures);
// no jurisdiction's rate is a default (avoids wrong-tax-by-default worldwide)
rec(TAX_PRESETS.every((p) => !p.rates || p.rates.every((r) => r.rate === 0)) ? 'PASS' : 'FAIL',
  'presets ship zero rates (owner-configured, no wrong default tax)', TAX_PRESETS.map((p) => p.label).join(', '));

// ---- moneyAudit hash chain ----
globalThis.localStorage = {
  _s: {},
  getItem(k) { return this._s[k] ?? null; },
  setItem(k, v) { this._s[k] = String(v); },
  removeItem(k) { delete this._s[k]; },
};
globalThis.window = { dispatchEvent() {} };
logMoneyMovement('sale', { amountCents: 1250, saleId: 's1', method: 'cash', userId: 'u1', note: 'hello' });
logMoneyMovement('refund', { amountCents: 300, saleId: 's1', method: 'card', userId: 'u2' });
{
  const v = verifyAuditChain();
  rec(v.valid ? 'PASS' : 'FAIL', 'untampered ledger verifies', `count=${v.count}`);
}
{ // tamper amountCents -> detected
  const raw = JSON.parse(localStorage.getItem('driftshop_money_audit'));
  raw[0].amountCents = 999999;
  localStorage.setItem('driftshop_money_audit', JSON.stringify(raw));
  const v = verifyAuditChain();
  rec(!v.valid && v.brokenAt === 0 ? 'PASS' : 'FAIL', 'amount tamper detected', `valid=${v.valid} brokenAt=${v.brokenAt}`);
  raw[0].amountCents = 1250;
  localStorage.setItem('driftshop_money_audit', JSON.stringify(raw));
}
{ // tamper method/userId/note -> NOT covered by hash
  const raw = JSON.parse(localStorage.getItem('driftshop_money_audit'));
  raw[0].method = 'card'; raw[0].userId = 'mallory'; raw[0].note = 'forged';
  localStorage.setItem('driftshop_money_audit', JSON.stringify(raw));
  const v = verifyAuditChain();
  rec(v.valid ? 'FAIL' : 'PASS', 'DOCUMENT: method/userId/note tamper does NOT break chain (hash covers type+timestamp+amountCents+saleId only)',
    `verify=${v.valid} (expected invalid)`);
}
{ // prevHash link break -> detected
  const raw = JSON.parse(localStorage.getItem('driftshop_money_audit'));
  raw[1].prevHash = 'tampered';
  localStorage.setItem('driftshop_money_audit', JSON.stringify(raw));
  const v = verifyAuditChain();
  rec(!v.valid && v.reason === 'prevHash mismatch' ? 'PASS' : 'FAIL', 'link tamper detected', `reason=${v.reason}`);
}

console.log(`\nMONEY HARNESS: pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
