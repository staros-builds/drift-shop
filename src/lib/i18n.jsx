import React, { createContext, useContext, useState, useCallback, useMemo } from 'react';
import { fr } from './locales/fr.js';
import { en } from './locales/en.js';

/* ------------------------------------------------------------------ */
/* Bilingual system (FR/EN toggle) for the Drift Shop build.                  */
/*                                                                      */
/* - LanguageProvider wraps the whole app; setLang() re-renders the     */
/*   tree so every surface updates instantly.                           */
/* - Choice persists in localStorage ('driftshop:lang'), default French.     */
/* - getLang() is the imperative escape hatch for non-component code    */
/*   (e.g. appTitle() used at window-open time).                        */
/* ------------------------------------------------------------------ */

import { LANG_KEY, getLang, localeTag } from './localeTag.js';
import { resiliency } from './locales/resiliency.js'; // resiliency UI strings, merged below (kept out of en.js/fr.js)
export { LANG_KEY, getLang, localeTag };
const DICTS = { fr: { ...fr, resiliency: resiliency.fr }, en: { ...en, resiliency: resiliency.en } };

function lookup(dict, key) {
  return key.split('.').reduce((o, k) => (o && o[k] !== undefined ? o[k] : undefined), dict);
}

const LanguageContext = createContext(null);

export function LanguageProvider({ children }) {
  const [lang, setLangState] = useState(getLang);

  const applyHtmlLang = useCallback((l) => {
    // Keep <html lang> honest for screen readers (initial mount + changes).
    try {
      document.documentElement.lang = l === 'en' ? 'en-CA' : 'fr-CA';
    } catch {
      /* noop */
    }
  }, []);

  React.useEffect(() => {
    applyHtmlLang(lang);
  }, [lang, applyHtmlLang]);

  const setLang = useCallback((l) => {
    const next = l === 'en' ? 'en' : 'fr';
    setLangState(next);
    try {
      localStorage.setItem(LANG_KEY, next);
    } catch {
      /* private mode — session-only */
    }
    applyHtmlLang(next);
  }, [applyHtmlLang]);

  const t = useCallback(
    (key, vars) => {
      let s = lookup(DICTS[lang], key);
      if (s === undefined) s = lookup(fr, key);
      if (typeof s !== 'string') return key;
      if (vars) {
        for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
      }
      return s;
    },
    [lang]
  );

  const value = useMemo(() => ({ lang, setLang, t }), [lang, setLang, t]);
  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

export function useLang() {
  const ctx = useContext(LanguageContext);
  if (!ctx) return { lang: getLang(), setLang: () => {}, t: (k) => k };
  return ctx;
}
