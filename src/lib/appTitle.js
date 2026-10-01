import { getLang } from './i18n.jsx';
import { getApp } from '../apps/registry.jsx';

// Resolve an app's display title for the current language without needing
// a React hook at every render site. Components re-render on language
// change (LanguageProvider sits at the root), so reading the persisted
// choice during render always yields the fresh value.
export function appTitle(app) {
  if (!app) return '';
  if (getLang() === 'en' && app.titleEn) return app.titleEn;
  return app.title;
}

// Window chrome: resolve the title from the window's appId so open windows
// rename themselves live when the language toggles. Custom per-window
// titles (props.title) keep precedence.
export function winTitle(win) {
  if (!win) return '';
  if (win.props && win.props.title) return win.props.title;
  try {
    const t = appTitle(getApp(win.appId));
    if (t) return t;
  } catch {
    /* unknown app — fall through to the stored title */
  }
  return win.title || '';
}
