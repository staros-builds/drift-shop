import React, { useEffect, useRef } from 'react';
import { X, Keyboard } from 'lucide-react';
import { APPS } from '../../apps/registry.jsx';
import { DriftMark } from './BootScreen.jsx';
import { appTitle } from '../../lib/appTitle.js';
import { useLang } from '../../lib/i18n.jsx';

/**
 * First-run welcome guide. Shown once per user — any dismissal (X, Escape,
 * or "Start drifting") persists welcome_seen in settings. Reopenable any
 * time from Settings → Help.
 */
export default function WelcomeDialog({ onDone }) {
  const { t } = useLang();
  const BLURBS = t('welcome.blurbs');
  const apps = APPS.filter((a) => !a.comingSoon && a.component);
  const startRef = useRef(null);

  // Escape dismisses (same as the × button); focus starts on the primary action.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onDone();
    };
    window.addEventListener('keydown', onKey);
    startRef.current?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [onDone]);

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-ink/30 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="welcome-title"
        className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-os border border-osborder bg-surface shadow-win"
      >
        <div className="flex items-start justify-between p-6 pb-0">
          <div className="flex items-center gap-3">
            <span className="text-accent">
              <DriftMark size={40} />
            </span>
            <div>
              <h2 id="welcome-title" className="text-2xl font-light tracking-tight text-ink">{t('welcome.title')}</h2>
              <p className="text-sm text-muted">{t('welcome.subtitle')}</p>
            </div>
          </div>
          <button
            type="button"
            aria-label={t('welcome.close')}
            onClick={() => onDone()}
            className="rounded-os p-1.5 text-muted duration-160 hover:bg-paper hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            <X size={18} />
          </button>
        </div>

        <div className="p-6 pt-4">
          <p className="mb-4 text-sm text-ink">
{t('welcome.introA')}{' '}
            <span className="font-medium">{t('welcome.startMenu')}</span> {t('welcome.introB')}
          </p>

          <ul className="space-y-2">
            {apps.map((app) => {
              const Icon = app.icon;
              return (
                <li
                  key={app.id}
                  className="flex items-center gap-3 rounded-os border border-osborder bg-paper px-3 py-2.5"
                >
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-os border border-osborder bg-surface text-ink">
                    <Icon size={18} strokeWidth={1.75} />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-ink">{appTitle(app)}</span>
                    <span className="block truncate text-xs text-muted">
                      {BLURBS[app.id] || ''}
                    </span>
                  </span>
                </li>
              );
            })}
          </ul>

          <div className="mt-4 rounded-os border border-osborder bg-paper p-3">
            <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted">
              <Keyboard size={13} /> {t('welcome.shortcuts')}
            </p>
            <ul className="space-y-1 text-sm text-ink">
              <li>
                <kbd className="rounded border border-osborder bg-surface px-1.5 py-0.5 font-mono text-xs">Ctrl+1…8</kbd>
                <span className="ml-2 text-muted">{t('welcome.switchSpaces')}</span>
              </li>
              <li>
                <kbd className="rounded border border-osborder bg-surface px-1.5 py-0.5 font-mono text-xs">Ctrl+Shift+P</kbd>
                <span className="ml-2 text-muted">{t('welcome.pinThought')}</span>
              </li>
            </ul>
          </div>

          <button
            type="button"
            ref={startRef}
            onClick={() => onDone()}
            className="mt-5 w-full rounded-os bg-accent px-4 py-2.5 text-sm font-semibold text-accentink duration-160 hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
          >
            {t('welcome.start')}
          </button>
          <p className="mt-2 text-center text-xs text-muted">
            {t('welcome.replayHint')}
          </p>
        </div>
      </div>
    </div>
  );
}
