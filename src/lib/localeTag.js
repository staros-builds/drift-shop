// Standalone locale helpers — no React, safe for pure modules
// (receipt printers, helm, QR, etc.).
export const LANG_KEY = 'driftshop:lang';

/** Every language the UI ships in. */
export const LANGS = ['fr', 'en', 'es', 'pt'];

export function getLang() {
  try {
    const v = localStorage.getItem(LANG_KEY);
    return LANGS.includes(v) ? v : 'fr';
  } catch {
    return 'fr';
  }
}

/** BCP-47 tag for Intl date/number formatting and <html lang>. */
export function tagFor(lang) {
  switch (lang) {
    case 'en': return 'en-CA';
    case 'es': return 'es-419'; // neutral Latin-American Spanish
    case 'pt': return 'pt-BR'; // Brazilian Portuguese
    default: return 'fr-CA';
  }
}

/** BCP-47 tag for Intl date/number formatting. */
export function localeTag() {
  return tagFor(getLang());
}
