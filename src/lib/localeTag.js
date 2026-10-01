// Standalone locale helpers — no React, safe for pure modules
// (receipt printers, helm, QR, etc.).
export const LANG_KEY = 'driftshop:lang';

export function getLang() {
  try {
    const v = localStorage.getItem(LANG_KEY);
    return v === 'en' ? 'en' : 'fr';
  } catch {
    return 'fr';
  }
}

/** BCP-47 tag for Intl date/number formatting: 'fr-CA' or 'en-CA'. */
export function localeTag() {
  return getLang() === 'en' ? 'en-CA' : 'fr-CA';
}
