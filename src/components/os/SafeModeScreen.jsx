import React, { useState } from 'react';
import { useLang } from '../../lib/i18n.jsx';
import { DriftMark } from './BootScreen.jsx';
import { resetCrashCount, getCrashCount } from './RootErrorBoundary.jsx';

/**
 * SAFE MODE — the nuclear SCRAM screen.
 *
 * When the app has crashed on boot 3+ times in a row, we do NOT attempt
 * a normal boot (which would just crash again). Instead we render this
 * minimal, dependency-light recovery screen:
 *
 * - Diagnostics: crash count, last good boot, user agent, online status
 * - "Try normal mode": resets the counter and reloads (user's choice)
 * - "Clear local data": wipes localStorage + caches, then reloads.
 *   Cloud data is untouched — the user just signs in again.
 *
 * This component deliberately avoids heavy dependencies (no backend,
 * no WindowsContext) so it can render even when the main app cannot.
 */
export default function SafeModeScreen() {
  const { t } = useLang();
  const [confirming, setConfirming] = useState(false);

  const diagnostics = (() => {
    let lastOk = null;
    let crashCount = 0;
    try {
      crashCount = getCrashCount();
      lastOk = localStorage.getItem('lfdd_last_boot_ok');
    } catch {}
    return {
      crashCount,
      lastOk: lastOk ? new Date(Number(lastOk)).toLocaleString() : '—',
      online: typeof navigator !== 'undefined' ? (navigator.onLine ? 'yes' : 'no') : '?',
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent.slice(0, 120) : '?',
      url: typeof window !== 'undefined' ? window.location.href : '?',
    };
  })();

  const handleTryNormal = () => {
    resetCrashCount();
    try {
      window.location.reload();
    } catch {}
  };

  const handleClearData = async () => {
    if (!confirming) {
      setConfirming(true);
      return;
    }
    // Wipe localStorage (but keep the crash counter reset so we boot normally).
    try {
      const keepLang = localStorage.getItem('lfdd_lang');
      localStorage.clear();
      if (keepLang) localStorage.setItem('lfdd_lang', keepLang);
    } catch {}
    // Wipe caches (service worker, etc.)
    try {
      if ('caches' in window) {
        const names = await caches.keys();
        await Promise.all(names.map((n) => caches.delete(n)));
      }
    } catch {}
    // Unregister service workers (a bad cached bundle could be the cause).
    try {
      if ('serviceWorker' in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map((r) => r.unregister()));
      }
    } catch {}
    try {
      window.location.reload();
    } catch {}
  };

  return (
    <div className="fixed inset-0 overflow-y-auto bg-paper">
      <div className="flex min-h-full items-center justify-center p-4">
        <div className="w-full max-w-md rounded-os border-2 border-amber-500 bg-surface p-5 shadow-os sm:p-8">
          <div className="flex flex-col items-center text-center">
            <span className="text-amber-600">
              <DriftMark size={36} />
            </span>
            <h1 className="mt-2 text-xl font-light tracking-tight text-ink">
              {t('crash.safeTitle')}
            </h1>
            <p className="mt-2 text-sm leading-relaxed text-muted">
              {t('crash.safeMessage')}
            </p>
          </div>

          <div className="mt-4 rounded-os border border-osborder bg-paper p-3">
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
              {t('crash.safeDiagnostics')}
            </h2>
            <dl className="space-y-1 text-xs">
              <div className="flex justify-between gap-2">
                <dt className="text-muted">Crashes:</dt>
                <dd className="font-mono text-ink">{diagnostics.crashCount}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-muted">Last good boot:</dt>
                <dd className="font-mono text-ink">{diagnostics.lastOk}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-muted">Online:</dt>
                <dd className="font-mono text-ink">{diagnostics.online}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-muted">URL:</dt>
                <dd className="truncate font-mono text-ink">{diagnostics.url}</dd>
              </div>
            </dl>
          </div>

          <div className="mt-4 space-y-2">
            <button
              type="button"
              onClick={handleTryNormal}
              className="w-full rounded-os bg-accent px-4 py-2 text-sm font-semibold text-accentink duration-160 hover:opacity-90"
            >
              {t('crash.safeTryNormal')}
            </button>
            <button
              type="button"
              onClick={handleClearData}
              className={`w-full rounded-os border px-4 py-2 text-sm font-medium duration-160 ${
                confirming
                  ? 'border-red-500 bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300'
                  : 'border-osborder bg-paper text-ink hover:border-red-400'
              }`}
            >
              {confirming ? t('crash.safeClearConfirm') : t('crash.safeClearData')}
            </button>
            {confirming && (
              <button
                type="button"
                onClick={() => setConfirming(false)}
                className="w-full rounded-os px-4 py-1 text-xs text-muted hover:text-ink"
              >
                {t('dialogs.cancel')}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
