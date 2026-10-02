/* Universal business-type presets.
 *
 * One build serves any shop: at setup the owner picks the business type
 * that fits best, and the preset applies a bundle of settings that
 * ALREADY exist in the product. No per-customer code, no branches —
 * a preset is only ever:
 *
 *   1. user settings, applied through SettingsContext (backend.settings):
 *      desktop icons, Start/touch-home visibility, icon order, touch
 *      mode. These are per-user/per-device by design in this product,
 *      so a preset shapes the till it is applied on; every teammate can
 *      apply the same preset under their own sign-in.
 *   2. for counter-heavy types, one device-local receipt suggestion
 *      (automatic receipt printing for the chosen store, via
 *      src/lib/pos-print), applied on this device only.
 *   3. the chosen type, recorded on the store row itself
 *      (pos_stores.business_preset, draft migration 070) so the shop's
 *      type is visible/supportable and every terminal can show it.
 *
 * Presets deliberately do NOT touch: products, prices, sales, customers,
 * staff, store name/currency, or TAX RATES (jurisdiction-specific —
 * the owner's accountant territory; the product ships generic zero
 * rates on purpose). Applying a preset only rewrites the keys listed
 * here; anything the owner fine-tuned elsewhere stays untouched, and
 * picking "general" restores the product defaults for managed keys.
 */

export const BUSINESS_PRESET_IDS = ['general', 'retail', 'restaurant', 'services', 'convenience'];

/** Bundle per preset. App ids come from src/apps/registry.jsx.
 *  desktopIcons: null = show every app (product default).
 *  suggestAutoPrint: device-local receipt suggestion (see header). */
export const BUSINESS_PRESETS = {
  general: {
    desktopIcons: null,
    hiddenFromStart: [],
    desktopIconOrder: [],
    touchMode: false,
    suggestAutoPrint: false,
  },
  retail: {
    desktopIcons: ['pos', 'bouquinerie', 'files', 'pinboard', 'settings', 'help', 'calculator'],
    hiddenFromStart: [],
    desktopIconOrder: ['pos', 'bouquinerie', 'files', 'pinboard', 'settings', 'help', 'calculator'],
    touchMode: false,
    suggestAutoPrint: false,
  },
  restaurant: {
    desktopIcons: ['pos', 'appointments', 'bouquinerie', 'files', 'settings', 'help'],
    hiddenFromStart: ['writer', 'sheets', 'slides'],
    desktopIconOrder: ['pos', 'appointments', 'bouquinerie', 'files', 'settings', 'help'],
    touchMode: true,
    suggestAutoPrint: true,
  },
  services: {
    desktopIcons: ['appointments', 'pos', 'bouquinerie', 'files', 'pinboard', 'settings', 'help'],
    hiddenFromStart: [],
    desktopIconOrder: ['appointments', 'pos', 'bouquinerie', 'files', 'pinboard', 'settings', 'help'],
    touchMode: false,
    suggestAutoPrint: false,
  },
  convenience: {
    desktopIcons: ['pos', 'bouquinerie', 'files', 'settings', 'help'],
    hiddenFromStart: ['writer', 'sheets', 'slides'],
    desktopIconOrder: ['pos', 'bouquinerie', 'files', 'settings', 'help'],
    touchMode: true,
    suggestAutoPrint: true,
  },
};

export function isBusinessPreset(id) {
  return BUSINESS_PRESET_IDS.includes(id);
}

/** SettingsContext patch for a preset (unknown id falls back to general). */
export function presetSettingsPatch(id) {
  const p = BUSINESS_PRESETS[isBusinessPreset(id) ? id : 'general'];
  return {
    desktop_icons: p.desktopIcons ? [...p.desktopIcons] : null,
    hidden_from_start: [...p.hiddenFromStart],
    desktop_icon_order: [...p.desktopIconOrder],
    touch_mode: p.touchMode === true,
  };
}
