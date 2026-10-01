/**
 * PWA install + offline helpers.
 *
 * - registerServiceWorker(): registers /sw.js once; resolves with the
 *   registration (or null when unsupported / failed). Safe to call once at
 *   boot — it never throws.
 * - beforeinstallprompt capture: the browser fires it when the app is
 *   installable. We stash it so Settings can show a real "Install" button.
 * - isInstalled(): standalone display mode (Android/desktop) or
 *   navigator.standalone (iOS).
 * - installInstructions(): plain-language fallback per platform.
 */

let deferredPrompt = null;
let promptListenerAttached = false;

export function captureInstallPrompt() {
  if (promptListenerAttached || typeof window === 'undefined') return;
  promptListenerAttached = true;
  window.addEventListener('beforeinstallprompt', (e) => {
    // Hold the prompt so the user installs on their tap, not the browser's.
    e.preventDefault();
    deferredPrompt = e;
    window.dispatchEvent(new CustomEvent('drift:install-available'));
  });
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    window.dispatchEvent(new CustomEvent('drift:install-changed'));
  });
}

export function hasInstallPrompt() {
  return !!deferredPrompt;
}

export async function promptInstall() {
  if (!deferredPrompt) return false;
  const p = deferredPrompt;
  deferredPrompt = null;
  try {
    await p.prompt();
    const { outcome } = await p.userChoice.catch(() => ({ outcome: 'dismissed' }));
    window.dispatchEvent(new CustomEvent('drift:install-changed'));
    return outcome === 'accepted';
  } catch {
    return false;
  }
}

export function isInstalled() {
  if (typeof window === 'undefined') return false;
  try {
    if (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) return true;
  } catch {
    /* ignore */
  }
  // iOS Safari
  return window.navigator.standalone === true;
}

export function isIOS() {
  if (typeof window === 'undefined' || !window.navigator) return false;
  const ua = window.navigator.userAgent || '';
  const platform = window.navigator.platform || '';
  return (
    /iPad|iPhone|iPod/.test(ua) ||
    (platform === 'MacIntel' && window.navigator.maxTouchPoints > 1)
  );
}

export function installInstructions() {
  if (isIOS()) {
    return 'On iPhone/iPad: tap Share, then “Add to Home Screen”. Drift will open full-screen like a native app.';
  }
  return 'In your browser menu choose “Install Drift” (or “Add to Home Screen” on Android). Drift will open in its own window like a native app.';
}

let swPromise = null;

export function registerServiceWorker() {
  if (swPromise) return swPromise;
  swPromise = (async () => {
    try {
      if (typeof window === 'undefined' || !('serviceWorker' in window.navigator)) return null;
      // Use import.meta.env.BASE_URL so the SW registers correctly when the
      // app is served from a subpath (e.g. /lfdd/ on GitHub Pages).
      const base = import.meta.env.BASE_URL || '/';
      const swUrl = base.endsWith('/') ? `${base}sw.js` : `${base}/sw.js`;
      const reg = await window.navigator.serviceWorker.register(swUrl);
      return reg;
    } catch {
      return null;
    }
  })();
  return swPromise;
}

/** True once a service worker controls this page (offline shell is live). */
export function isOfflineReady() {
  try {
    return !!(typeof window !== 'undefined' && window.navigator.serviceWorker && window.navigator.serviceWorker.controller);
  } catch {
    return false;
  }
}
