import React, { useEffect, useMemo, useRef, useState } from 'react';
import { listLaunchableApps } from '../../apps/registry.jsx';
import { ensureWebApps, useWebApps } from '../../lib/webapps.js';
import { useAuth } from '../../os/AuthContext.jsx';
import { useWindows } from '../../os/WindowsContext.jsx';
import { useNotifications } from '../../os/NotificationsContext.jsx';
import { useSettings } from '../../os/SettingsContext.jsx';
import { appTitle } from '../../lib/appTitle.js';
import { localeTag } from '../../lib/i18n.jsx';

/** iOS-style tile gradients, picked deterministically per app id. */
const TILE_GRADIENTS = [
  'linear-gradient(145deg, #5eead4, #0ea5e9)',
  'linear-gradient(145deg, #60a5fa, #2563eb)',
  'linear-gradient(145deg, #a78bfa, #7c3aed)',
  'linear-gradient(145deg, #f472b6, #db2777)',
  'linear-gradient(145deg, #fb923c, #ea580c)',
  'linear-gradient(145deg, #facc15, #ca8a04)',
  'linear-gradient(145deg, #4ade80, #16a34a)',
  'linear-gradient(145deg, #2dd4bf, #0d9488)',
  'linear-gradient(145deg, #f87171, #dc2626)',
  'linear-gradient(145deg, #94a3b8, #475569)',
];

function tileGradient(id) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return TILE_GRADIENTS[h % TILE_GRADIENTS.length];
}

/** Live clock for the status bar; refreshes well within a minute. */
function useClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 15000);
    return () => clearInterval(t);
  }, []);
  return now;
}

/** iOS-style status bar: live clock left, Drift wordmark right. */
export function TouchStatusBar() {
  const now = useClock();
  const time = now.toLocaleTimeString(localeTag(), { hour: 'numeric', minute: '2-digit' });
  return (
    <div className="flex h-11 shrink-0 items-center justify-between px-5">
      <span className="text-[15px] font-semibold text-ink">{time}</span>
      <span className="text-xs font-medium uppercase tracking-[0.2em] text-muted">Drift</span>
    </div>
  );
}

const DOCK_IDS = ['files', 'pictures', 'helm', 'store'];
const PAGE_SIZE = 20; // 4 columns x 5 rows

/**
 * Apple-ish home screen for touch devices: paged app grid with scroll-snap
 * and pagination dots, plus a translucent dock. Tap an icon to open the app
 * fullscreen; the shell's home indicator (or the window's X) goes back home.
 */
export default function TouchHome() {
  const { user, isAdmin } = useAuth();
  const { openWindow } = useWindows();
  const { push } = useNotifications();
  const installedIds = useWebApps();
  const scrollRef = useRef(null);
  const [page, setPage] = useState(0);

  // TouchHome mounts instead of DesktopIcons in touch mode, so it owns the
  // installed-web-apps fetch here.
  useEffect(() => {
    ensureWebApps(user?.id);
  }, [user?.id]);

  const { settings } = useSettings();
  const apps = useMemo(() => {
    const hidden = new Set(settings?.hidden_from_start || []);
    return listLaunchableApps(isAdmin).filter((a) => !a.comingSoon && a.component && !hidden.has(a.id));
  }, [installedIds, settings?.hidden_from_start, isAdmin]); // eslint-disable-line react-hooks/exhaustive-deps

  const pages = useMemo(() => {
    const out = [];
    for (let i = 0; i < apps.length; i += PAGE_SIZE) out.push(apps.slice(i, i + PAGE_SIZE));
    return out.length ? out : [[]];
  }, [apps]);

  const dockApps = useMemo(() => {
    const picked = DOCK_IDS.map((id) => apps.find((a) => a.id === id)).filter(Boolean);
    for (const a of apps) {
      if (picked.length >= 4) break;
      if (!picked.includes(a)) picked.push(a);
    }
    return picked.slice(0, 4);
  }, [apps]);

  const open = (app) => {
    try {
      openWindow(app.id);
    } catch (e) {
      push('Error', e.message);
    }
  };

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el || el.clientWidth === 0) return;
    setPage(Math.round(el.scrollLeft / el.clientWidth));
  };

  const goToPage = (i) => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ left: i * el.clientWidth, behavior: 'smooth' });
  };

  const tile = (app) => {
    const Icon = app.icon;
    return (
      <button
        key={app.id}
        type="button"
        onClick={() => open(app)}
        aria-label={`Open ${appTitle(app)}`}
        className="flex min-h-[44px] min-w-[44px] flex-col items-center gap-1.5 rounded-[16px] px-1 py-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <span
          className="flex h-[60px] w-[60px] items-center justify-center rounded-[16px] text-white shadow-os"
          style={{ background: tileGradient(app.id) }}
        >
          <Icon size={28} strokeWidth={1.75} />
        </span>
        <span className="max-w-[76px] truncate text-xs font-medium text-ink">{appTitle(app)}</span>
      </button>
    );
  };

  return (
    <div className="flex h-full flex-col">
      {apps.length === 0 ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-8 text-center">
          <p className="text-base font-medium text-ink">No apps to show</p>
          <p className="max-w-xs text-sm text-muted">
            Every app is hidden right now. Unhide them in Settings → Apps to get your home screen back.
          </p>
          <button
            type="button"
            onClick={() => openWindow('settings')}
            className="mt-1 flex min-h-[44px] items-center rounded-os bg-accent px-5 text-sm font-medium text-accentink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-paper"
          >
            Open Settings
          </button>
        </div>
      ) : (
      <>
      {/* Paged app grid */}
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="flex min-h-0 flex-1 snap-x snap-mandatory overflow-x-auto overflow-y-hidden"
      >
        {pages.map((items, i) => (
          <div key={i} className="w-full shrink-0 snap-center overflow-y-auto px-4 pb-2 pt-4">
            <div className="grid grid-cols-4 content-start gap-x-2 gap-y-4">
              {items.map(tile)}
            </div>
          </div>
        ))}
      </div>

      {/* Pagination dots */}
      {pages.length > 1 && (
        <div className="flex shrink-0 items-center justify-center gap-2 pb-2 pt-1">
          {pages.map((_, i) => (
            <button
              key={i}
              type="button"
              aria-label={`Go to page ${i + 1}`}
              onClick={() => goToPage(i)}
              className="flex h-[24px] w-[24px] items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              <span
                className={`h-2 w-2 rounded-full transition-colors ${
                  i === page ? 'bg-ink' : 'bg-ink/25'
                }`}
              />
            </button>
          ))}
        </div>
      )}

      {/* Dock */}
      <div className="shrink-0 px-4 pb-4">
        <div className="flex items-center justify-around rounded-[24px] border border-osborder/60 bg-surface/70 px-2 py-2.5 shadow-win backdrop-blur-xl">
          {dockApps.map((app) => {
            const Icon = app.icon;
            return (
              <button
                key={app.id}
                type="button"
                onClick={() => open(app)}
                aria-label={`Open ${appTitle(app)}`}
                title={appTitle(app)}
                className="flex h-[60px] w-[60px] items-center justify-center rounded-[16px] text-white shadow-os active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-paper"
                style={{ background: tileGradient(app.id) }}
              >
                <Icon size={28} strokeWidth={1.75} />
              </button>
            );
          })}
        </div>
      </div>
      </>
      )}
    </div>
  );
}
