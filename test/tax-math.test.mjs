/**
 * Adversarial unit tests for the POS tax math (src/lib/taxMath.js).
 * Run: node test/tax-math.test.mjs
 *
 * Covers: the generic Tax 1 / Tax 2 slots at 0%, stacked (non-compounding)
 * math, the compound flag, legacy single-rate fallback, presets, and the
 * explicit-save outdated-preset banner signature logic.
 */
import assert from 'node:assert/strict';
import {
  taxLinesFor, taxTotalFor, TAX_PRESETS, OUTDATED_PRESETS,
  outdatedPresetFor, presetLabel, presetRateName,
} from '../src/lib/taxMath.js';

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

console.log('taxMath');

check('new-store default: Tax 1 / Tax 2 at 0% => no tax lines', () => {
  const store = { taxRates: [{ name: 'Tax 1', rate: 0 }, { name: 'Tax 2', rate: 0 }] };
  assert.deepEqual(taxLinesFor(store, 10000), []);
  assert.equal(taxTotalFor(store, 10000), 0);
});

check('stacked taxes each apply to the pre-tax subtotal (not compounded)', () => {
  const store = { taxRates: [{ name: 'Tax 1', rate: 5 }, { name: 'Tax 2', rate: 9.975 }] };
  const lines = taxLinesFor(store, 10000); // $100.00
  assert.equal(lines.length, 2);
  assert.equal(lines[0].cents, 500); // 5% of 10000
  assert.equal(lines[1].cents, 998); // 9.975% of 10000 = 997.5 -> 998 (rounded)
  assert.equal(taxTotalFor(store, 10000), 1498);
});

check('compound row is calculated on subtotal + prior taxes', () => {
  const store = { taxRates: [{ name: 'Tax 1', rate: 10 }, { name: 'Tax 2', rate: 10, compound: true }] };
  const lines = taxLinesFor(store, 10000);
  assert.equal(lines[0].cents, 1000);
  assert.equal(lines[1].cents, 1100); // 10% of (10000 + 1000)
  assert.equal(lines[1].compound, true);
});

check('zero/negative/garbage rates are ignored, never crash', () => {
  const store = {
    taxRates: [
      { name: 'Zero', rate: 0 },
      { name: 'Neg', rate: -5 },
      { name: 'NaN', rate: 'abc' },
      { name: 'Null', rate: null },
      { name: 'Undef' },
      { name: 'Real', rate: 5 },
    ],
  };
  const lines = taxLinesFor(store, 20000);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].cents, 1000);
});

check('legacy single taxRate fallback when no stacked list', () => {
  assert.equal(taxTotalFor({ taxRate: 5 }, 10000), 500);
  assert.equal(taxTotalFor({ taxRate: 0 }, 10000), 0);
  assert.equal(taxTotalFor({}, 10000), 0);
  assert.equal(taxTotalFor({ taxRates: [] }, 10000), 0);
});

check('huge amounts do not overflow to unsafe integers', () => {
  const store = { taxRates: [{ name: 'Tax 1', rate: 15 }, { name: 'Tax 2', rate: 15 }] };
  const total = taxTotalFor(store, 9999999999); // ~$100M subtotal
  assert.ok(Number.isSafeInteger(total), 'tax total stays a safe integer');
  assert.equal(total, 3000000000); // 30% of 9999999999 = 2999999999.7 -> rounds per line
});

check('zero and negative subtotals produce no phantom tax', () => {
  const store = { taxRates: [{ name: 'Tax 1', rate: 5 }] };
  assert.equal(taxTotalFor(store, 0), 0);
  assert.equal(taxTotalFor(store, -1000), -50); // refunds: proportional, honest sign
});

check('per-line rounding uses Math.round (banker-honest half-up)', () => {
  const store = { taxRates: [{ name: 'T', rate: 10 }] };
  assert.equal(taxTotalFor(store, 5), 1); // 0.5 -> 1
  assert.equal(taxTotalFor(store, 15), 2); // 1.5 -> 2
});

check('missing tax name falls back to "Tax"', () => {
  const lines = taxLinesFor({ taxRates: [{ rate: 5 }] }, 10000);
  assert.equal(lines[0].name, 'Tax');
});

check('presets: none/single/stacked2/custom shapes are sane', () => {
  const ids = TAX_PRESETS.map((p) => p.id);
  assert.deepEqual(ids, ['custom', 'none', 'single', 'stacked2']);
  const none = TAX_PRESETS.find((p) => p.id === 'none');
  assert.deepEqual(none.rates, []);
  const single = TAX_PRESETS.find((p) => p.id === 'single');
  assert.equal(single.rates.length, 1);
  assert.equal(single.rates[0].rate, 0);
  assert.equal(single.rates[0].name, 'Tax 1');
  assert.equal(single.rates[0].nameFr, 'Taxe 1');
  const stacked = TAX_PRESETS.find((p) => p.id === 'stacked2');
  assert.equal(stacked.rates.length, 2);
  assert.ok(stacked.rates.every((r) => r.rate === 0), 'generic build ships no rate defaults');
});

check('preset labels are bilingual', () => {
  const stacked = TAX_PRESETS.find((p) => p.id === 'stacked2');
  assert.match(presetLabel(stacked, 'en'), /stacked/i);
  assert.match(presetLabel(stacked, 'fr'), /cumul/i);
  assert.equal(presetRateName({ name: 'Tax 1', nameFr: 'Taxe 1' }, 'fr'), 'Taxe 1');
  assert.equal(presetRateName({ name: 'Tax 1', nameFr: 'Taxe 1' }, 'en'), 'Tax 1');
  assert.equal(presetRateName({ name: 'Tax 1' }, 'fr'), 'Tax 1'); // nameFr missing -> fallback
});

check('outdated-preset banner: generic build has no superseded presets', () => {
  assert.deepEqual(OUTDATED_PRESETS, []);
  assert.equal(outdatedPresetFor([{ rate: 5 }, { rate: 9.975, compound: true }]), null);
  assert.equal(outdatedPresetFor([]), null);
  assert.equal(outdatedPresetFor(null), null);
});

check('outdatedPresetFor ignores zero rates in the signature', () => {
  // Signature only counts rates > 0, matching the banner logic.
  assert.equal(outdatedPresetFor([{ rate: 0 }, { rate: 0 }]), null);
});

console.log(process.exitCode ? 'FAILED' : 'all tax-math tests passed');
