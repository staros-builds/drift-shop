import React, { useEffect, useMemo, useState } from 'react';
import { Search, Check, Plus, Trash2, ExternalLink } from 'lucide-react';
import {
  WEBAPP_CATALOG, WEBAPP_CATEGORIES, ensureWebApps, useWebApps,
  installWebApp, uninstallWebApp, getWebApp,
} from '../lib/webapps.js';
import { useAuth } from '../os/AuthContext.jsx';
import { useNotifications } from '../os/NotificationsContext.jsx';
import { useLang } from '../lib/i18n.jsx';
import { useWindows } from '../os/WindowsContext.jsx';

/**
 * App Store (Roku-style): browse a curated catalog of framing-friendly
 * websites, install them as first-class OS apps (Start menu + desktop),
 * and uninstall them. Installed ids persist per user via backend.files.
 */

function AppIcon({ entry, size = 20 }) {
  const Icon = entry.icon;
  return (
    <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-os border border-osborder bg-paper text-ink shadow-os">
      <Icon size={size} strokeWidth={1.75} />
    </span>
  );
}

export default function StoreApp() {
  const { t } = useLang();
  const { user } = useAuth();
  const { push } = useNotifications();
  const { openWindow } = useWindows();
  const installedIds = useWebApps();
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('All');
  const [busy, setBusy] = useState(null);
  // The installed list arrives asynchronously — show an explicit loading row
  // instead of silently rendering "nothing installed" while it resolves.
  const [installsReady, setInstallsReady] = useState(false);

  useEffect(() => {
    let live = true;
    setInstallsReady(false);
    ensureWebApps(user?.id).finally(() => {
      if (live) setInstallsReady(true);
    });
    return () => {
      live = false;
    };
  }, [user?.id]);

  const q = query.trim().toLowerCase();
  const catalog = useMemo(
    () =>
      WEBAPP_CATALOG.filter(
        (e) =>
          (category === 'All' || e.category === category) &&
          (!q ||
            e.title.toLowerCase().includes(q) ||
            e.description.toLowerCase().includes(q) ||
            e.category.toLowerCase().includes(q))
      ),
    [q, category]
  );
  const installed = useMemo(
    () => installedIds.map(getWebApp).filter(Boolean),
    [installedIds]
  );

  const doInstall = async (id) => {
    setBusy(id);
    try {
      await installWebApp(id, user?.id);
      push(t('storeApp.installed'), t('storeApp.addedToMenu', { title: getWebApp(id)?.title || id }));
    } catch (e) {
      push(t('storeApp.error'), t('storeApp.installFailed', { error: e.message }));
    } finally {
      setBusy(null);
    }
  };

  const doUninstall = async (id) => {
    setBusy(id);
    try {
      await uninstallWebApp(id, user?.id);
    } catch (e) {
      push(t('storeApp.error'), t('storeApp.uninstallFailed', { error: e.message }));
    } finally {
      setBusy(null);
    }
  };

  const card = (entry) => {
    const isInstalled = installedIds.includes(entry.id);
    const working = busy === entry.id;
    return (
      <div
        key={entry.id}
        className="flex items-start gap-3 rounded-os border border-osborder bg-surface p-3"
      >
        <AppIcon entry={entry} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-ink">{entry.title}</p>
          <p className="text-[11px] uppercase tracking-wide text-muted">{t(`storeApp.categories.${entry.category}`) || entry.category}</p>
          <p className="mt-1 line-clamp-2 text-xs text-muted">{t(`storeApp.descriptions.${entry.id}`) || entry.description}</p>
        </div>
        {isInstalled ? (
          <span className="flex shrink-0 items-center gap-1 rounded-os bg-accent/15 px-2.5 py-1.5 text-xs font-medium text-accent">
            <Check size={13} /> {t('storeApp.installed')}
          </span>
        ) : (
          <button
            type="button"
            disabled={working}
            onClick={() => doInstall(entry.id)}
            className="flex min-h-[44px] shrink-0 items-center gap-1 rounded-os bg-accent px-2.5 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
          >
            <Plus size={13} /> {working ? t('storeApp.installing') : t('storeApp.install')}
          </button>
        )}
      </div>
    );
  };

  return (
    <div className="flex h-full flex-col bg-paper text-ink">
      <div className="border-b border-osborder p-4 pb-3">
        <h2 className="text-lg font-semibold">{t('storeApp.title')}</h2>
        <p className="mt-0.5 text-xs text-muted">
          {t('storeApp.subtitle')}
        </p>
        <div className="mt-3 flex items-center gap-2 rounded-os border border-osborder bg-surface px-3 py-2 focus-within:border-accent">
          <Search size={15} className="shrink-0 text-muted" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('storeApp.searchPh')}
            aria-label={t('storeApp.searchPh')}
            className="w-full bg-transparent text-sm outline-none placeholder:text-muted"
          />
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {['All', ...WEBAPP_CATEGORIES].map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setCategory(c)}
              aria-pressed={category === c}
              className={`flex min-h-[36px] items-center rounded-full px-3 py-1 text-xs font-medium duration-160 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
                category === c
                  ? 'bg-accent text-white'
                  : 'border border-osborder bg-surface text-muted hover:text-ink'
              }`}
            >
              {c === 'All' ? t('storeApp.all') : (t(`storeApp.categories.${c}`) || c)}
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {!installsReady ? (
          <p className="mb-6 text-sm text-muted" role="status">{t('storeApp.loading')}</p>
        ) : installed.length > 0 && (
          <div className="mb-6">
            <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted">
              {t('storeApp.installedCount', { n: installed.length })}
            </h3>
            <div className="grid gap-2 sm:grid-cols-2">
              {installed.map((entry) => (
                <div
                  key={entry.id}
                  className="flex items-center gap-3 rounded-os border border-osborder bg-surface p-3"
                >
                  <AppIcon entry={entry} size={18} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-ink">{entry.title}</p>
                    <p className="truncate text-[11px] text-muted">{entry.category}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      try {
                        openWindow(`webapp:${entry.id}`);
                      } catch (e) {
                        push('Error', `Could not open: ${e.message}`);
                      }
                    }}
                    title={t('storeApp.openTitle', { title: entry.title })}
                    className="flex min-h-[44px] shrink-0 items-center gap-1 rounded-os bg-accent px-2 py-1.5 text-xs font-medium text-white hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
                  >
                    <ExternalLink size={13} /> {t('storeApp.open')}
                  </button>
                  <button
                    type="button"
                    disabled={busy === entry.id}
                    onClick={() => doUninstall(entry.id)}
                    title={t('storeApp.uninstallTitle', { title: entry.title })}
                    className="flex min-h-[44px] shrink-0 items-center gap-1 rounded-os px-2 py-1.5 text-xs text-muted hover:bg-paper hover:text-ink disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                  >
                    <Trash2 size={13} /> {t('storeApp.uninstall')}
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted">
          {t('storeApp.catalogCount', { n: catalog.length })}
        </h3>
        {catalog.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-8 text-center">
            <p className="text-sm text-muted">{t('storeApp.noMatch', { query })}</p>
            <button
              type="button"
              onClick={() => { setQuery(''); setCategory('All'); }}
              className="flex min-h-[44px] items-center rounded-os border border-osborder bg-surface px-4 text-sm text-ink hover:bg-paper focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              {t('storeApp.clearSearch')}
            </button>
          </div>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2">
            {catalog.map(card)}
          </div>
        )}
      </div>
    </div>
  );
}
