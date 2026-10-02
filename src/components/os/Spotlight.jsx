import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { usePOSMode } from '../../os/POSModeContext.jsx';
import { Search, LayoutGrid, Folder, FileText, Pin, CornerDownLeft, Zap, Volume2, VolumeX, Settings, PenLine, Keyboard } from 'lucide-react';
import { listLaunchableApps } from '../../apps/registry.jsx';
import { backend } from '../../lib/backend/current.js';
import { useWindows } from '../../os/WindowsContext.jsx';
import { useSettings } from '../../os/SettingsContext.jsx';
import { useAuth } from '../../os/AuthContext.jsx';
import { isEnabled as soundOn, setEnabled as setSoundOn, playSound } from '../../lib/sound.js';
import {
  SPOTLIGHT_EVENT,
  searchFiles,
  openFileWithApp,
  pinLabel,
} from '../../os/shortcuts.js';
import { appTitle } from '../../lib/appTitle.js';
import { useLang } from '../../lib/i18n.jsx';

const DEBOUNCE_MS = 150;
const MAX_PER_GROUP = 8;

/**
 * Spotlight — global search overlay. NOT wired into the tree; the
 * coordinator mounts it once inside the authenticated app root, next to
 * other OS overlays. It opens itself when GlobalShortcuts fires
 * SPOTLIGHT_EVENT (Ctrl/Cmd+K).
 *
 * Three result groups: Apps, Files, Pins. Keyboard: Up/Down to move,
 * Enter to open, Escape to close.
 */
export default function Spotlight() {
  const { lang, t } = useLang();
  const { openWindow } = useWindows();
  const { settings } = useSettings();
  const { isAdmin } = useAuth();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [files, setFiles] = useState([]);
  const [pins, setPins] = useState([]);
  const [pending, setPending] = useState(false);
  const [filesUnavailable, setFilesUnavailable] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef(null);
  const runId = useRef(0);

  const close = useCallback(() => {
    setOpen(false);
    setQuery('');
    setFiles([]);
    setPins([]);
    setActive(0);
    setPending(false);
  }, []);

  // Open via the global shortcut event (toggles).
  // POS Mode: the register stays locked — never open over it.
  const { isPOSLocked } = usePOSMode();
  const isPOSLockedRef = useRef(isPOSLocked);
  isPOSLockedRef.current = isPOSLocked;
  useEffect(() => {
    const onEvent = () => {
      if (!isPOSLockedRef.current) setOpen((was) => !was);
    };
    window.addEventListener(SPOTLIGHT_EVENT, onEvent);
    return () => window.removeEventListener(SPOTLIGHT_EVENT, onEvent);
  }, []);

  // Fresh state on every open.
  useEffect(() => {
    if (open) {
      setQuery('');
      setFiles([]);
      setPins([]);
      setActive(0);
      setPending(false);
      setFilesUnavailable(false);
    }
  }, [open]);

  // Focus the input whenever the overlay opens.
  useEffect(() => {
    if (open) {
      const t = setTimeout(() => inputRef.current?.focus(), 30);
      return () => clearTimeout(t);
    }
  }, [open ]);

  // Apps hidden via Settings > Apps never appear here — matches Start menu.
  const hiddenStart = useMemo(() => new Set(settings?.hidden_from_start || []), [settings?.hidden_from_start]);

  const apps = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return listLaunchableApps(isAdmin)
      .filter((a) => !hiddenStart.has(a.id) && !a.comingSoon && a.component)
      .filter(
        (a) =>
          a.title.toLowerCase().includes(q) ||
          a.id.toLowerCase().includes(q) ||
          (a.category || '').toLowerCase().includes(q)
      )
      .slice(0, MAX_PER_GROUP);
  }, [query, hiddenStart, isAdmin]);

  // Debounced async search for files + pins.
  useEffect(() => {
    const q = query.trim();
    if (!open || !q) {
      setPending(false);
      return;
    }
    setPending(true);
    const id = ++runId.current;
    const t = setTimeout(async () => {
      const [fileRes, pinRes] = await Promise.allSettled([
        searchFiles(q, { maxResults: MAX_PER_GROUP }),
        backend.pins.search(q, {}).then((r) => (Array.isArray(r) ? r.slice(0, MAX_PER_GROUP) : [])),
      ]);
      if (runId.current !== id) return; // stale run — a newer query is in flight
      if (fileRes.status === 'fulfilled') {
        setFiles(fileRes.value);
        setFilesUnavailable(false);
      } else {
        setFiles([]);
        setFilesUnavailable(true); // quiet note, not an error dialog
      }
      setPins(pinRes.status === 'fulfilled' ? pinRes.value : []);
      setPending(false);
      setActive(0);
    }, DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [query, open]);

  // System actions — the command-palette side of Spotlight.
  const [, bumpSound] = useReducer((x) => x + 1, 0);
  const actions = useMemo(() => {
    const muted = !soundOn();
    const all = [
      {
        id: 'toggle-sound',
        title: muted ? 'Unmute interface sounds' : 'Mute interface sounds',
        subtitle: 'Interface sound',
        keywords: 'sound audio mute unmute volume chime quiet',
        icon: muted ? VolumeX : Volume2,
        run: () => {
          setSoundOn(muted);
          bumpSound();
          if (muted) playSound('success');
        },
      },
      {
        id: 'open-settings',
        title: 'Open Settings',
        subtitle: 'System action',
        keywords: 'settings preferences options wallpaper theme',
        icon: Settings,
        run: () => openWindow('settings'),
      },
      {
        id: 'new-note',
        title: 'New note',
        subtitle: 'Pinboard composer',
        keywords: 'note new write pinboard compose',
        icon: PenLine,
        run: () => openWindow('pinboard', { composer: true }),
      },
      {
        id: 'shortcuts',
        title: 'Keyboard shortcuts',
        subtitle: 'Help & Guide',
        keywords: 'keyboard shortcuts keys help cheatsheet hotkeys',
        icon: Keyboard,
        run: () => openWindow('help'),
      },
    ];
    const q = query.trim().toLowerCase();
    if (!q) return all;
    return all.filter(
      (a) =>
        a.title.toLowerCase().includes(q) ||
        a.subtitle.toLowerCase().includes(q) ||
        a.keywords.includes(q)
    );
  }, [query, openWindow]);

  // Flat navigation order across groups: actions, apps, files, pins.
  const items = useMemo(() => {
    const list = [];
    actions.forEach((action) => list.push({ kind: 'action', action }));
    apps.forEach((app) => list.push({ kind: 'app', app }));
    files.forEach((entry) => list.push({ kind: 'file', entry }));
    pins.forEach((pin) => list.push({ kind: 'pin', pin }));
    return list;
  }, [actions, apps, files, pins]);

  const clampedActive = items.length === 0 ? 0 : Math.min(active, items.length - 1);

  const activate = useCallback(
    (item) => {
      if (!item) return;
      try {
        if (item.kind === 'app') openWindow(item.app.id);
        else if (item.kind === 'file') openFileWithApp(item.entry, openWindow);
        else if (item.kind === 'pin') openWindow('pinboard');
        else if (item.kind === 'action') item.action.run();
      } catch {
        /* launching from search must never throw */
      }
      close();
    },
    [openWindow, close]
  );

  const onKeyDown = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && !e.altKey && String(e.key).toLowerCase() === 'k') {
      e.preventDefault();
      e.stopPropagation();
      close(); // Ctrl+K toggles
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      if (items.length === 0) return;
      setActive((a) =>
        e.key === 'ArrowDown' ? (a + 1) % items.length : (a - 1 + items.length) % items.length
      );
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      activate(items[clampedActive]);
    }
  };

  if (!open) return null;

  const q = query.trim();
  const showEmpty = q && !pending && items.length === 0;

  const rowClass = (i) =>
    `flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left duration-120 ${
      i === clampedActive ? 'bg-accent/15' : 'hover:bg-paper'
    }`;

  let cursor = 0;
  const renderGroup = (title, Icon, list, renderRow) => {
    if (list.length === 0) return null;
    const start = cursor;
    cursor += list.length;
    return (
      <div key={title} className="pb-1">
        <p className="flex items-center gap-1.5 px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-muted">
          <Icon size={12} /> {title}
        </p>
        {list.map((it, i) => renderRow(it, start + i))}
      </div>
    );
  };

  return (
    <div
      className="fixed inset-0 z-[400] flex items-start justify-center bg-black/30 p-4 pt-[16vh]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Global search"
        className="flex max-h-[70vh] w-[560px] max-w-full flex-col overflow-hidden rounded-2xl border border-osborder bg-surface shadow-win"
      >
        <div className="flex items-center gap-2 border-b border-osborder px-4 py-3">
          <Search size={18} className="shrink-0 text-muted" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search apps, files, pins, and actions…"
            aria-label="Search apps, files, pins, and actions"
            className="w-full bg-transparent text-[15px] text-ink outline-none placeholder:text-muted"
          />
          {pending && <span className="shrink-0 text-xs text-muted">Searching…</span>}
          <kbd className="hidden shrink-0 rounded-md border border-osborder bg-paper px-1.5 py-0.5 text-[10px] text-muted sm:block">
            esc
          </kbd>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          {renderGroup('Actions', Zap, actions, (action, i) => {
            const ActionIcon = action.icon;
            return (
              <button key={action.id} type="button" className={rowClass(i)}
                onMouseEnter={() => setActive(i)} onMouseDown={(e) => { e.preventDefault(); activate({ kind: 'action', action }); }}>
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-osborder bg-paper text-ink">
                  <ActionIcon size={16} strokeWidth={1.75} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-ink">{action.title}</span>
                  <span className="block text-xs text-muted">{action.subtitle}</span>
                </span>
                {i === clampedActive && <CornerDownLeft size={14} className="shrink-0 text-muted" />}
              </button>
            );
          })}

          {renderGroup('Apps', LayoutGrid, apps, (app, i) => {
            const AppIcon = app.icon;
            return (
              <button key={app.id} type="button" className={rowClass(i)}
                onMouseEnter={() => setActive(i)} onMouseDown={(e) => { e.preventDefault(); activate({ kind: 'app', app }); }}>
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-osborder bg-paper text-ink">
                  <AppIcon size={16} strokeWidth={1.75} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-ink">{appTitle(app)}</span>
                  <span className="block text-xs text-muted">{app.category ? (t('categories.' + app.category) !== 'categories.' + app.category ? t('categories.' + app.category) : app.category) : t('common.appWord')}</span>
                </span>
                {i === clampedActive && <CornerDownLeft size={14} className="shrink-0 text-muted" />}
              </button>
            );
          })}

          {renderGroup('Files', FileText, files, (entry, i) => (
            <button key={entry.path} type="button" className={rowClass(i)}
              onMouseEnter={() => setActive(i)} onMouseDown={(e) => { e.preventDefault(); activate({ kind: 'file', entry }); }}>
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-osborder bg-paper text-ink">
                {entry.type === 'folder' ? <Folder size={16} /> : <FileText size={16} />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-ink">{entry.name}</span>
                <span className="block truncate text-xs text-muted">{entry.path}</span>
              </span>
              {i === clampedActive && <CornerDownLeft size={14} className="shrink-0 text-muted" />}
            </button>
          ))}
          {q && filesUnavailable && files.length === 0 && (
            <p className="px-3 py-1 text-xs text-muted">File search is unavailable right now.</p>
          )}

          {renderGroup('Pins', Pin, pins, (pin, i) => (
            <button key={pin.id || i} type="button" className={rowClass(i)}
              onMouseEnter={() => setActive(i)} onMouseDown={(e) => { e.preventDefault(); activate({ kind: 'pin', pin }); }}>
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-osborder bg-paper text-ink">
                <Pin size={16} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-ink">{pinLabel(pin)}</span>
                <span className="block text-xs text-muted">
                  {pin.kind ? pin.kind[0].toUpperCase() + pin.kind.slice(1) : 'Pin'} · Pinboard
                </span>
              </span>
              {i === clampedActive && <CornerDownLeft size={14} className="shrink-0 text-muted" />}
            </button>
          ))}

          {showEmpty && (
            <p className="px-3 py-8 text-center text-sm text-muted">
              No results for “{q}”. Try a different word.
            </p>
          )}
          {!q && actions.length === 0 && (
            <p className="px-3 py-6 text-center text-sm text-muted">
              Type to search your apps, files, pins, and actions.
            </p>
          )}
        </div>

        <div className="flex items-center gap-4 border-t border-osborder px-4 py-2 text-[11px] text-muted">
          <span><kbd className="rounded border border-osborder bg-paper px-1">↑↓</kbd> navigate</span>
          <span><kbd className="rounded border border-osborder bg-paper px-1">↵</kbd> open</span>
          <span><kbd className="rounded border border-osborder bg-paper px-1">esc</kbd> close</span>
        </div>
      </div>
    </div>
  );
}
