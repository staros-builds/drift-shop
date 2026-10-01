import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Search, Power, ChevronRight, ChevronLeft, User, Folder, FileText, Pin } from 'lucide-react';
import { listLaunchableApps } from '../../apps/registry.jsx';
import { ensureWebApps, useWebApps } from '../../lib/webapps.js';
import { useWindows } from '../../os/WindowsContext.jsx';
import { useAuth } from '../../os/AuthContext.jsx';
import { useNotifications } from '../../os/NotificationsContext.jsx';
import { useSettings } from '../../os/SettingsContext.jsx';
import { backend } from '../../lib/backend/current.js';
import { searchFiles, openFileWithApp, pinLabel } from '../../os/shortcuts.js';
import { appTitle } from '../../lib/appTitle.js';
import { useLang } from '../../lib/i18n.jsx';

/**
 * Start menu, Windows 11 style in Drift's paper-and-ink theme: a floating
 * centered frosted panel with search on top, a Pinned app grid, an
 * All-apps alphabetical list view, a Recommended (recent) section, and a
 * footer with the user chip + sign out. Installed web apps appear in the
 * Pinned grid alongside static registry apps.
 */

const MAX_RECENTS = 6;

function loadRecents(key) {
  try {
    const raw = localStorage.getItem(key);
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

const isDisabled = (app) => app.comingSoon || !app.component;

export default function StartMenu({ onClose }) {
  const { lang, t } = useLang();
  const { openWindow } = useWindows();
  const { user, signOut, isAdmin } = useAuth();
  const { push } = useNotifications();
  const [query, setQuery] = useState('');
  const [view, setView] = useState('pinned'); // 'pinned' | 'all'
  const ref = useRef(null);
  const inputRef = useRef(null);

  // Installed web apps feed the menu; re-renders when installs change.
  const installedIds = useWebApps();
  useEffect(() => {
    ensureWebApps(user?.id);
  }, [user?.id]);

  // Apps hidden via Settings > Apps never appear here — including search.
  const { settings } = useSettings();
  const hiddenStart = new Set(settings?.hidden_from_start || []);

  const apps = useMemo(
    () => listLaunchableApps(isAdmin).filter((a) => !hiddenStart.has(a.id)),
    [installedIds, settings?.hidden_from_start, isAdmin] // eslint-disable-line react-hooks/exhaustive-deps
  );

  const recentsKey = `drift:recent-apps:${user?.id || 'anon'}`;
  const [recents, setRecents] = useState(() => loadRecents(recentsKey));

  useEffect(() => {
    inputRef.current?.focus();
    const onDown = (e) => {
      if (e.key === 'Escape') onClose();
    };
    const onClick = (e) => {
      if (ref.current && !ref.current.contains(e.target)) onClose();
    };
    window.addEventListener('keydown', onDown);
    window.addEventListener('pointerdown', onClick);
    return () => {
      window.removeEventListener('keydown', onDown);
      window.removeEventListener('pointerdown', onClick);
    };
  }, [onClose]);

  // Reload recents when the signed-in user changes.
  useEffect(() => {
    setRecents(loadRecents(recentsKey));
  }, [recentsKey]);

  const q = query.trim().toLowerCase();
  const matches = (a) =>
    !q ||
    a.title.toLowerCase().includes(q) ||
    a.id.toLowerCase().includes(q) ||
    (a.category || '').toLowerCase().includes(q);

  // Files + Pins search (debounced, bounded). Runs only while a query is
  // active; failures are swallowed quietly with a small note.
  const [fileHits, setFileHits] = useState([]);
  const [pinHits, setPinHits] = useState([]);
  const [extraSearching, setExtraSearching] = useState(false);
  const [filesUnavailable, setFilesUnavailable] = useState(false);
  const searchRun = useRef(0);
  useEffect(() => {
    const raw = query.trim();
    if (!raw) {
      setFileHits([]);
      setPinHits([]);
      setExtraSearching(false);
      return;
    }
    setExtraSearching(true);
    const id = ++searchRun.current;
    const t = setTimeout(async () => {
      const [fileRes, pinRes] = await Promise.allSettled([
        searchFiles(raw, { maxResults: 8 }),
        backend.pins.search(raw, {}).then((r) => (Array.isArray(r) ? r.slice(0, 8) : [])),
      ]);
      if (searchRun.current !== id) return;
      if (fileRes.status === 'fulfilled') {
        setFileHits(fileRes.value);
        setFilesUnavailable(false);
      } else {
        setFileHits([]);
        setFilesUnavailable(true);
      }
      setPinHits(pinRes.status === 'fulfilled' ? pinRes.value : []);
      setExtraSearching(false);
    }, 200);
    return () => clearTimeout(t);
  }, [query]);

  const openFile = (entry) => {
    try {
      openFileWithApp(entry, openWindow);
      onClose();
    } catch (e) {
      push('Error', e.message);
    }
  };
  const openPinboard = () => {
    try {
      openWindow('pinboard');
      onClose();
    } catch (e) {
      push('Error', e.message);
    }
  };

  const pinnedApps = useMemo(() => apps.filter(matches), [apps, q]); // eslint-disable-line react-hooks/exhaustive-deps
  const allApps = useMemo(
    () => apps.filter(matches).slice().sort((a, b) => a.title.localeCompare(b.title)),
    [apps, q] // eslint-disable-line react-hooks/exhaustive-deps
  );
  const recentApps = useMemo(
    () =>
      recents
        .map((id) => apps.find((a) => a.id === id))
        .filter((a) => a && !isDisabled(a))
        .slice(0, MAX_RECENTS),
    [recents, apps]
  );

  const open = (app) => {
    if (isDisabled(app)) return;
    try {
      openWindow(app.id);
      setRecents((prev) => {
        const next = [app.id, ...prev.filter((r) => r !== app.id)].slice(0, MAX_RECENTS);
        try {
          localStorage.setItem(recentsKey, JSON.stringify(next));
        } catch {
          /* recents are a nicety — never break launching */
        }
        return next;
      });
      onClose();
    } catch (e) {
      push('Error', e.message);
    }
  };

  const doSignOut = async () => {
    try {
      await signOut();
    } catch (e) {
      push('Error', e.message);
    }
  };

  const renderTile = (app) => {
    const Icon = app.icon;
    const disabled = isDisabled(app);
    return (
      <button
        key={app.id}
        type="button"
        disabled={disabled}
        onClick={() => open(app)}
        title={appTitle(app)}
        className={`group flex flex-col items-center gap-1.5 rounded-xl p-3 duration-160 ${
          disabled ? 'cursor-not-allowed opacity-50' : 'hover:bg-paper'
        }`}
      >
        <span className="relative flex h-12 w-12 items-center justify-center rounded-xl border border-osborder bg-paper text-ink shadow-os">
          <Icon size={22} strokeWidth={1.75} />
          {app.comingSoon && (
            <span className="absolute -bottom-1.5 rounded-full border border-osborder bg-surface px-1.5 text-[9px] font-semibold uppercase tracking-wide text-muted">
              Soon
            </span>
          )}
        </span>
        <span className="line-clamp-2 max-w-full text-center text-xs font-medium leading-tight text-ink">
          {appTitle(app)}
        </span>
      </button>
    );
  };

  const renderRow = (app) => {
    const Icon = app.icon;
    const disabled = isDisabled(app);
    return (
      <button
        key={app.id}
        type="button"
        disabled={disabled}
        onClick={() => open(app)}
        className={`flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left duration-160 ${
          disabled ? 'cursor-not-allowed opacity-50' : 'hover:bg-paper'
        }`}
      >
        <span className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-osborder bg-paper text-ink">
          <Icon size={18} strokeWidth={1.75} />
          {app.comingSoon && (
            <span className="absolute -bottom-1.5 rounded-full border border-osborder bg-surface px-1 text-[8px] font-semibold uppercase tracking-wide text-muted">
              Soon
            </span>
          )}
        </span>
        <span className="line-clamp-2 min-w-0 flex-1 break-words text-sm font-medium leading-snug text-ink">{appTitle(app)}</span>
        {!disabled && <span className="shrink-0 text-[11px] text-muted">{app.category ? (t('categories.' + app.category) !== 'categories.' + app.category ? t('categories.' + app.category) : app.category) : ''}</span>}
      </button>
    );
  };

  const displayName = user?.username || user?.email || 'Guest';
  const initial = (displayName.trim()[0] || '?').toUpperCase();

  return (
    // Positioned by the Taskbar wrapper (bottom/top/left/right); this panel
    // itself is just a fixed-size sheet.
    <div
      ref={ref}
      className="flex max-h-[72vh] w-[600px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-2xl border border-osborder shadow-win backdrop-blur-xl"
      style={{ backgroundColor: 'color-mix(in srgb, var(--os-surface) 88%, transparent)' }}
    >
      {/* Search */}
      <div className="p-4 pb-2">
        <div className="flex items-center gap-2 rounded-full border border-osborder bg-paper px-4 py-2.5 shadow-os">
          <Search size={16} className="shrink-0 text-muted" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search apps, settings, and more…"
            className="w-full bg-transparent text-sm text-ink outline-none placeholder:text-muted"
          />
        </div>
      </div>

      {/* Body */}
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-2">
        {view === 'all' ? (
          <>
            <div className="flex items-center justify-between pb-1 pt-2">
              <p className="px-1 text-[13px] font-semibold text-ink">All apps</p>
              <button
                type="button"
                onClick={() => setView('pinned')}
                className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-muted hover:bg-paper hover:text-ink"
              >
                <ChevronLeft size={14} /> Back
              </button>
            </div>
            {allApps.length === 0 && fileHits.length === 0 && pinHits.length === 0 && !extraSearching ? (
              <p className="px-3 py-8 text-center text-sm text-muted">Nothing matches “{query}”.</p>
            ) : (
              <div className="flex flex-col gap-0.5 pb-2">{allApps.map(renderRow)}</div>
            )}
          </>
        ) : (
          <>
            <div className="flex items-center justify-between pb-1 pt-2">
              <p className="px-1 text-[13px] font-semibold text-ink">Pinned</p>
              <button
                type="button"
                onClick={() => setView('all')}
                className="flex items-center gap-1 rounded-lg border border-osborder bg-paper px-2.5 py-1 text-xs font-medium text-ink shadow-os hover:opacity-90"
              >
                All apps <ChevronRight size={14} />
              </button>
            </div>
            {pinnedApps.length === 0 && fileHits.length === 0 && pinHits.length === 0 && !extraSearching ? (
              <p className="px-3 py-8 text-center text-sm text-muted">Nothing matches “{query}”.</p>
            ) : (
              <div className="grid grid-cols-4 gap-1 pb-1 sm:grid-cols-6">
                {pinnedApps.map(renderTile)}
              </div>
            )}

            {recentApps.length > 0 && !q && (
              <>
                <p className="px-1 pb-1 pt-3 text-[13px] font-semibold text-ink">Recommended</p>
                <div className="grid grid-cols-1 gap-0.5 pb-2 sm:grid-cols-2">
                  {recentApps.map(renderRow)}
                </div>
              </>
            )}
          </>
        )}

        {/* Files + Pins results, beneath apps, while searching */}
        {q && (
          <>
            {fileHits.length > 0 && (
              <>
                <p className="px-1 pb-1 pt-3 text-[13px] font-semibold text-ink">Files</p>
                <div className="flex flex-col gap-0.5 pb-1">
                  {fileHits.map((entry) => (
                    <button
                      key={entry.path}
                      type="button"
                      onClick={() => openFile(entry)}
                      className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left duration-160 hover:bg-paper"
                    >
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-osborder bg-paper text-ink">
                        {entry.type === 'folder' ? <Folder size={18} strokeWidth={1.75} /> : <FileText size={18} strokeWidth={1.75} />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-ink">{entry.name}</span>
                        <span className="block truncate text-[11px] text-muted">{entry.path}</span>
                      </span>
                    </button>
                  ))}
                </div>
              </>
            )}
            {filesUnavailable && fileHits.length === 0 && (
              <p className="px-3 py-1 text-xs text-muted">File search is unavailable right now.</p>
            )}
            {pinHits.length > 0 && (
              <>
                <p className="px-1 pb-1 pt-3 text-[13px] font-semibold text-ink">Pins</p>
                <div className="flex flex-col gap-0.5 pb-1">
                  {pinHits.map((pin, i) => (
                    <button
                      key={pin.id || i}
                      type="button"
                      onClick={openPinboard}
                      className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left duration-160 hover:bg-paper"
                    >
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-osborder bg-paper text-ink">
                        <Pin size={18} strokeWidth={1.75} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-ink">{pinLabel(pin)}</span>
                        <span className="block text-[11px] text-muted">
                          {pin.kind ? pin.kind[0].toUpperCase() + pin.kind.slice(1) : 'Pin'} · Pinboard
                        </span>
                      </span>
                    </button>
                  ))}
                </div>
              </>
            )}
            {extraSearching && (fileHits.length > 0 || pinHits.length > 0) && (
              <p className="px-3 py-1 text-xs text-muted">Searching files & pins…</p>
            )}
          </>
        )}
      </div>

      {/* Footer */}
      <div
        className="flex items-center gap-3 border-t border-osborder px-5 py-3"
        style={{ backgroundColor: 'color-mix(in srgb, var(--os-paper, var(--os-surface)) 55%, transparent)' }}
      >
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent/15 text-sm font-semibold text-accent">
          {user?.username || user?.email ? initial : <User size={16} />}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">
          {displayName}
          {user?.isGuest && <span className="ml-1 text-xs font-normal text-muted">(trial)</span>}
        </span>
        <button
          type="button"
          onClick={doSignOut}
          title="Sign out"
          aria-label="Sign out"
          className="flex h-9 w-9 items-center justify-center rounded-full text-muted duration-160 hover:bg-paper hover:text-ink"
        >
          <Power size={16} />
        </button>
      </div>
    </div>
  );
}
