/**
 * Pure tax math for POS — extracted from src/apps/POSApp.jsx so it can be
 * unit-tested in node (test/tax-math.test.mjs). No imports, no side effects.
 */

// Multi-rate tax support (migration 004). Falls back to the store's single
// legacy tax_rate when no stacked rates are configured.
//
// A row may set compound: true, meaning it is calculated on the running total
// *including* the taxes above it. Plain rows are always calculated on the
// original taxable amount (stacked) — the compound flag stays available for
// jurisdictions that genuinely compound one tax on another.
export function taxLinesFor(store, taxableCents) {
  // An empty/missing stacked list falls back to the legacy single default
  // rate (that's what the settings page documents: "No stacked rates — the
  // default rate below applies"). The "No tax" preset therefore has to clear
  // the default rate as well — see applyPreset.
  const rates =
    store.taxRates && store.taxRates.length > 0
      ? store.taxRates
      : [{ name: 'Tax', rate: Number(store.taxRate) || 0 }];
  let priorTax = 0;
  return rates
    .filter((r) => Number(r.rate) > 0)
    .map((r) => {
      const rate = Number(r.rate);
      // A compound row is calculated on the taxable amount *plus* every tax
      // row above it; plain rows always use the original taxable amount.
      const onBase = r.compound ? taxableCents + priorTax : taxableCents;
      const cents = Math.round((onBase * rate) / 100);
      priorTax += cents;
      const line = { name: r.name || 'Tax', rate, cents };
      if (r.compound) line.compound = true;
      return line;
    });
}

// Tax presets — one tap fills in the tax rows. Rates are per-store settings:
// nothing here is a default; a new store starts with the generic Tax 1 /
// Tax 2 slots at 0% (see the store-creation flow below) and the owner edits
// names and rates to match local rules. Bilingual presets: labelFr/nameFr
// used when the UI language is French.
export const TAX_PRESETS = [
  { id: 'custom', label: 'Custom rates\u2026', labelFr: 'Taux personnalis\u00e9s\u2026', rates: null },
  { id: 'none', label: 'No tax', labelFr: 'Aucune taxe', rates: [] },
  {
    id: 'single', label: 'Single tax', labelFr: 'Taxe unique',
    rates: [{ name: 'Tax 1', nameFr: 'Taxe 1', rate: 0 }],
  },
  {
    id: 'stacked2', label: 'Two stacked taxes (each on the pre-tax subtotal)', labelFr: 'Deux taxes cumul\u00e9es (chacune sur le sous-total avant taxes)',
    rates: [{ name: 'Tax 1', nameFr: 'Taxe 1', rate: 0 }, { name: 'Tax 2', nameFr: 'Taxe 2', rate: 0 }],
  },
];
// ---------------------------------------------------------------------------
// Preset update process. When a preset's correct definition changes — a rate
// changes or the *calculation method* is corrected — bump that preset's
// `version` above and add an entry here with the superseded definition's
// signature ([rate, compound][]). Shops whose stored rates still match an
// outdated signature get a banner in POS Settings (owner/manager) showing old
// vs new and the effective date; applying the corrected rates requires an
// explicit Save. A preset change NEVER rewrites a shop's stored rates
// silently.
// ---------------------------------------------------------------------------
export const OUTDATED_PRESETS = [
  // No superseded presets ship with the generic build. Entries look like:
  // { id: 'preset-id', oldSig: [[5, false], [9.975, true]], noteKey: 'pos.tabs2.taxPresetOldNote' },
];
export const outdatedPresetFor = (rows) => {
  const sig = JSON.stringify(
    (rows || [])
      .filter((r) => Number(r.rate) > 0)
      .map((r) => [Number(r.rate), r.compound === true])
  );
  return OUTDATED_PRESETS.find((o) => JSON.stringify(o.oldSig) === sig) || null;
};
// Pick the display label / tax name for the current UI language.
export const presetLabel = (p, lang) => (lang === 'fr' ? p.labelFr || p.label : p.label);
export const presetRateName = (r, lang) => (lang === 'fr' ? r.nameFr || r.name : r.name);

export const taxTotalFor = (store, taxableCents) =>
  taxLinesFor(store, taxableCents).reduce((s, l) => s + l.cents, 0);
