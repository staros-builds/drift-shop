import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { Check, ChevronRight } from 'lucide-react';
import { useSettings } from '../../os/SettingsContext.jsx';
import { useWindows } from '../../os/WindowsContext.jsx';
import { useNotifications } from '../../os/NotificationsContext.jsx';
import { useAuth } from '../../os/AuthContext.jsx';
import DesktopIcons from './DesktopIcons.jsx';
import Window from './Window.jsx';
import Taskbar from './Taskbar.jsx';
import StartMenu from './StartMenu.jsx';
import WelcomeDialog from './WelcomeDialog.jsx';
import WelcomeTour from './WelcomeTour.jsx';
import POSModeOverlay from './POSModeOverlay.jsx';
import AppErrorBoundary from './AppErrorBoundary.jsx';
import { usePOSMode } from '../../os/POSModeContext.jsx';
import MacMenuBar from './styles/MacMenuBar.jsx';
import MacDock from './styles/MacDock.jsx';
import { listLaunchableApps } from '../../apps/registry.jsx';
import { ensureWebApps, useWebApps } from '../../lib/webapps.js';
import { initAudio, playSound } from '../../lib/sound.js';
import { appTitle } from '../../lib/appTitle.js';

const isEditable = (el) =>
  el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);

/** Built-in wallpapers (ids mirror Settings > Wallpaper). */
const WALLPAPERS = [
  { id: 'paper-grain', label: 'Paper grain' },
  { id: 'linen', label: 'Linen' },
  { id: 'dusk', label: 'Dusk' },
  { id: 'plain', label: 'Plain' },
  { id: 'img-dawn', label: 'Persimmon dawn' },
  { id: 'img-ink', label: 'Ink drift' },
  { id: 'img-garden', label: 'Paper garden' },
  { id: 'img-harbor', label: 'Dusk harbor' },
];

/**
 * The desktop: wallpaper layer, icons, windows, taskbar.
 * Global keys: Ctrl+1..8 switch spaces; Ctrl+Alt+Left/Right cycle spaces;
 * Ctrl+Shift+P opens the Pinboard composer; Alt+Left/Right/Up/Down snaps
 * the focused window (left half / right half / maximize / restore).
 */
export default function Desktop() {
  const { settings, loading: settingsLoading, loadedUid, updateSettings } = useSettings();
  const { visibleWindows, spaces, activeSpaceId, setActiveSpace, openWindow, closeWindow, snapWindow, updateSpace, snapPreview } =
    useWindows();
  const { push } = useNotifications();
  const { user } = useAuth();
  // Dynamic app list so installed App Store apps show up in context menus.
  const installedIds = useWebApps();
  useEffect(() => {
    ensureWebApps(user?.id);
  }, [user?.id]);
  const desktopShowable = useMemo(
    // NOTE: must match the filter DesktopIcons uses — no `a.desktop`
    // property exists on registry entries, so filtering on it yields an
    // empty set and "Remove from desktop" would wipe every icon.
    () => listLaunchableApps().filter((a) => !a.comingSoon && a.component),
    [installedIds] // eslint-disable-line react-hooks/exhaustive-deps
  );
  const [selectedId, setSelectedId] = useState(null);
  const [welcomeOpen, setWelcomeOpen] = useState(false);
  // Konami easter egg: ↑↑↓↓←→←→BA
  const { isPOSLocked } = usePOSMode();
  const konamiRef = useRef(0);
  useEffect(() => {
    const SEQ = ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'b', 'a'];
    const onKey = (e) => {
      if (isEditable(e.target)) return;
      const want = SEQ[konamiRef.current];
      if (e.key === want || (want.length === 1 && e.key.toLowerCase() === want)) {
        konamiRef.current += 1;
        if (konamiRef.current === SEQ.length) {
          konamiRef.current = 0;
          if (!isPOSLocked) {
            playSound('success');
            push('Secret unlocked', '↑↑↓↓←→←→BA — the Konami code works in Drift. You have excellent taste.');
          }
        }
      } else {
        konamiRef.current = e.key === SEQ[0] ? 1 : 0;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isPOSLocked, push]);
  // Audio unlocks on the first real user gesture (browser policy); the
  // startup chime then plays once the desktop is up.
  const audioReady = useRef(false);
  useEffect(() => {
    const unlock = () => {
      if (audioReady.current) return;
      audioReady.current = true;
      if (initAudio()) playSound('startupChime');
    };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
    return () => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
  }, []);
  const [ctxMenu, setCtxMenu] = useState(null); // { x, y, appId } | null
  const [wpOpen, setWpOpen] = useState(false); // "Change wallpaper" submenu
  const menuRef = useRef(null);
  const welcomeAutoShown = useRef(false);

  // First-run welcome: show once per user; any dismissal persists welcome_seen.
  // Belt-and-suspenders: also track dismissal in localStorage, because the
  // server settings object can be stale on rapid re-login (race between
  // updateSettings and the next settings fetch). Either flag suppresses it.
  // loadedUid MUST match the current user: on logout settings reset to
  // DEFAULTS (welcome_seen=false) with loading=false, and there's a window
  // on the next login before the new fetch completes where the check would
  // otherwise fire on stale defaults.
  useEffect(() => {
    // Per-user localStorage key: the device may be shared between accounts,
    // so a device-global key would suppress the welcome for the next user.
    const welcomeKey = user?.id ? `drift:welcome_seen:${user.id}` : null;
    let dismissedLocal = false;
    try { dismissedLocal = !!welcomeKey && localStorage.getItem(welcomeKey) === '1'; } catch {}
    const settingsReady = !settingsLoading && settings && loadedUid && loadedUid === user?.id;
    if (settingsReady && !settings.welcome_seen && !dismissedLocal && !welcomeAutoShown.current) {
      welcomeAutoShown.current = true;
      setWelcomeOpen(true);
    }
  }, [settingsLoading, settings, loadedUid, user?.id]);

  // Settings → Help can reopen the guide via the drift:show-welcome event.
  useEffect(() => {
    const show = () => setWelcomeOpen(true);
    window.addEventListener('drift:show-welcome', show);
    return () => window.removeEventListener('drift:show-welcome', show);
  }, []);

  const closeWelcome = async () => {
    setWelcomeOpen(false);
    // Any dismissal counts as seen — X, Escape, or "Start drifting".
    // (Previously only "Start drifting" persisted, so the guide nagged
    // on every boot when closed any other way.) Replayable anytime from
    // Settings → Help.
    try {
      // Per-user key (see the auto-show effect above): never leak one
      // account's dismissal to the next account on a shared device.
      if (user?.id) localStorage.setItem(`drift:welcome_seen:${user.id}`, '1');
    } catch {}
    try {
      await updateSettings({ welcome_seen: true });
    } catch (err) {
      push('Error', `Could not save preference: ${err?.message || err}`);
    }
  };

  // Desktop right-click menu: remove an icon, or add back a hidden one.
  // Dynamic list — installed App Store apps are included.
  const currentIconIds = settings.desktop_icons ?? desktopShowable.map((a) => a.id);
  const hiddenApps = desktopShowable.filter((a) => !currentIconIds.includes(a.id));

  const saveDesktopIcons = useCallback(
    async (ids) => {
      try {
        await updateSettings({ desktop_icons: ids });
      } catch (err) {
        push('Error', `Could not update desktop icons: ${err?.message || err}`);
      }
    },
    [updateSettings, push]
  );

  const onDesktopContextMenu = useCallback(
    (e) => {
      e.preventDefault();
      const iconEl = e.target.closest?.('[data-app-icon]');
      setCtxMenu({
        x: e.clientX,
        y: e.clientY,
        appId: iconEl ? iconEl.getAttribute('data-app-icon') : null,
      });
    },
    []
  );

  useEffect(() => {
    if (!ctxMenu) return;
    const onPointerDown = (e) => {
      if (e.target.closest?.('[data-ctx-menu]')) return;
      setCtxMenu(null);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') setCtxMenu(null);
    };
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [ctxMenu]);

  const hideDesktopIcon = (appId) => {
    setCtxMenu(null);
    saveDesktopIcons(currentIconIds.filter((id) => id !== appId));
  };
  const showDesktopIcon = (appId) => {
    setCtxMenu(null);
    if (!currentIconIds.includes(appId)) saveDesktopIcons([...currentIconIds, appId]);
  };

  const activeSpace = spaces.find((s) => s.id === activeSpaceId) || null;
  const wallpaper = activeSpace?.wallpaper || settings.wallpaper || 'paper-grain';

  // "Change wallpaper": same updateSettings path Settings > Wallpaper uses.
  // A per-space override (Spaces app) would shadow the global setting, so it
  // is cleared first — the chosen wallpaper always becomes visible.
  const pickWallpaper = useCallback(
    async (id) => {
      setCtxMenu(null);
      try {
        if (activeSpace?.wallpaper) await updateSpace(activeSpace.id, { wallpaper: null });
        await updateSettings({ wallpaper: id });
      } catch (err) {
        push('Error', `Could not change wallpaper: ${err?.message || err}`);
      }
    },
    [activeSpace, updateSpace, updateSettings, push]
  );

  const openDisplaySettings = useCallback(() => {
    setCtxMenu(null);
    try {
      openWindow('settings');
    } catch (err) {
      push('Error', err.message);
    }
  }, [openWindow, push]);

  // Fresh submenu state + initial focus whenever the menu opens.
  useEffect(() => {
    setWpOpen(false);
    if (ctxMenu) {
      const t = setTimeout(() => {
        menuRef.current?.querySelector('[data-menuitem]')?.focus();
      }, 0);
      return () => clearTimeout(t);
    }
  }, [ctxMenu]);

  // Arrow-key navigation for the context menu (roving focus across items).
  const onMenuKeyDown = useCallback(
    (e) => {
      const items = () => Array.from(menuRef.current?.querySelectorAll('[data-menuitem]') || []);
      const list = items();
      const idx = list.indexOf(document.activeElement);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!list.length) return;
        const next = e.key === 'ArrowDown' ? (idx + 1) % list.length : (idx - 1 + list.length) % list.length;
        list[next]?.focus();
      } else if (e.key === 'Home') {
        e.preventDefault();
        list[0]?.focus();
      } else if (e.key === 'End') {
        e.preventDefault();
        list[list.length - 1]?.focus();
      } else if (e.key === 'ArrowRight') {
        // Open the wallpaper submenu from its parent item.
        if (document.activeElement?.dataset?.wpParent !== undefined && !wpOpen) {
          e.preventDefault();
          setWpOpen(true);
          setTimeout(() => {
            menuRef.current?.querySelector('[data-wp-item]')?.focus();
          }, 0);
        }
      } else if (e.key === 'ArrowLeft') {
        // Step back out of the wallpaper submenu to its parent item.
        if (wpOpen && document.activeElement?.dataset?.wpItem !== undefined) {
          e.preventDefault();
          setWpOpen(false);
          setTimeout(() => {
            menuRef.current?.querySelector('[data-wp-parent]')?.focus();
          }, 0);
        }
      }
    },
    [wpOpen]
  );

  const onKeyDown = useCallback(
    (e) => {
      if (isEditable(e.target)) return;
      // Window snapping on the focused (topmost, non-minimized) window.
      // Alt+Arrows are free of other global shortcuts; Ctrl+Alt+Left/Right
      // stay reserved for space cycling below.
      if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.key.startsWith('Arrow')) {
        const target = visibleWindows
          .filter((w) => !w.minimized)
          .sort((a, b) => b.z - a.z)[0];
        if (!target) return;
        e.preventDefault();
        if (e.key === 'ArrowLeft') snapWindow(target.id, 'left');
        else if (e.key === 'ArrowRight') snapWindow(target.id, 'right');
        else if (e.key === 'ArrowUp') snapWindow(target.id, 'maximize');
        else if (e.key === 'ArrowDown') snapWindow(target.id, 'restore');
        return;
      }
      if (e.ctrlKey && e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        const idx = spaces.findIndex((s) => s.id === activeSpaceId);
        if (idx === -1 || spaces.length < 2) return;
        const next =
          e.key === 'ArrowRight'
            ? spaces[(idx + 1) % spaces.length]
            : spaces[(idx - 1 + spaces.length) % spaces.length];
        if (next && next.id !== activeSpaceId) {
          e.preventDefault();
          setActiveSpace(next.id);
        }
        return;
      }
      if (e.ctrlKey && !e.shiftKey && /^[1-8]$/.test(e.key)) {
        const space = spaces[Number(e.key) - 1];
        if (space && space.id !== activeSpaceId) {
          e.preventDefault();
          setActiveSpace(space.id);
        }
        return;
      }
      if (e.ctrlKey && e.shiftKey && (e.key === 'P' || e.key === 'p')) {
        e.preventDefault();
        try {
          openWindow('pinboard', { composer: true });
        } catch (err) {
          push('Error', err.message);
        }
      }
    },
    [spaces, activeSpaceId, setActiveSpace, openWindow, push, visibleWindows, snapWindow]
  );

  useEffect(() => {
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onKeyDown]);

  // Taskbar position: top/bottom keep a column layout, left/right switch
  // the shell to a row. The bar renders before or after the desktop area
  // accordingly, so icons and windows always get the remaining space.
  const taskbarPosition = settings?.taskbar_position || 'bottom';
  const barRow = taskbarPosition === 'left' || taskbarPosition === 'right';
  const barFirst = taskbarPosition === 'top' || taskbarPosition === 'left';
  // Interface style: 'drift' (default), 'windows11', or 'macosx'.
  // taskbar_position only applies to the drift style — windows11 locks the
  // taskbar bottom-centered, macosx uses the menu bar + Dock instead.
  const uiStyle = settings?.ui_style || 'drift';
  const [spotlightOpen, setSpotlightOpen] = useState(false);

  const zoomStyle = { zoom: (settings.ui_scale || 100) / 100 };
  const wpCls = wallpaper.startsWith('img-') ? `wallpaper-img wallpaper-${wallpaper}` : `wallpaper-${wallpaper}`;
  const rootCls = `fixed inset-0 flex bg-paper text-ink ${wpCls} ui-${uiStyle}`;

  // Desktop area: everything not covered by the taskbar/menu bar. Windows
  // constrain to this. (ui_scale: CSS zoom on the OS shell root — scales
  // the interface, never the monitor.)
  const desktopArea = (
    <div
      key="desktop-area"
      id="drift-desktop-area"
      className="relative min-h-0 min-w-0 flex-1 overflow-hidden"
      onPointerDown={() => setSelectedId(null)}
      onContextMenu={onDesktopContextMenu}
    >
      <DesktopIcons selectedId={selectedId} onSelect={setSelectedId} />
      {visibleWindows.map((win) => (
        <Window key={win.id} win={win} />
      ))}
      {/* Snap-preview ghost while a window is dragged into a snap zone. */}
      {snapPreview && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute top-0 z-[1000] h-full rounded-os border-2 border-accent bg-accent/15"
          style={
            snapPreview.edge === 'left'
              ? { left: 0, width: '50%' }
              : snapPreview.edge === 'right'
                ? { right: 0, width: '50%' }
                : { left: 0, width: '100%' }
          }
        />
      )}
      {uiStyle === 'macosx' && spotlightOpen && (
        <div className="absolute left-1/2 top-4 z-50 -translate-x-1/2">
          <StartMenu onClose={() => setSpotlightOpen(false)} />
        </div>
      )}
        {ctxMenu && (
          <div
            data-ctx-menu
            role="menu"
            aria-label={ctxMenu.appId ? 'Desktop icon options' : 'Desktop options'}
            ref={menuRef}
            onKeyDown={onMenuKeyDown}
            className="pointer-events-auto fixed z-[200] min-w-52 overflow-hidden rounded-os border border-osborder bg-surface py-1 shadow-win"
            style={{
              left: Math.max(8, Math.min(ctxMenu.x, window.innerWidth - 230)),
              top: Math.max(8, Math.min(ctxMenu.y, window.innerHeight - 340)),
            }}
          >
            {ctxMenu.appId ? (
              <button
                type="button"
                role="menuitem"
                data-menuitem
                onClick={() => hideDesktopIcon(ctxMenu.appId)}
                className="block w-full px-4 py-2 text-left text-sm text-ink hover:bg-paper focus-visible:bg-paper focus-visible:outline-none"
              >
                Remove from desktop
              </button>
            ) : hiddenApps.length === 0 ? (
              <div className="px-4 py-2 text-sm text-muted">All apps are on the desktop</div>
            ) : (
              <>
                <div className="px-4 pb-1 pt-1 text-xs font-medium uppercase tracking-wide text-muted">
                  Add to desktop
                </div>
                {hiddenApps.map((app) => {
                  const Icon = app.icon;
                  return (
                    <button
                      key={app.id}
                      type="button"
                      role="menuitem"
                      data-menuitem
                      onClick={() => showDesktopIcon(app.id)}
                      className="flex w-full items-center gap-2.5 px-4 py-2 text-left text-sm text-ink hover:bg-paper focus-visible:bg-paper focus-visible:outline-none"
                    >
                      <Icon size={15} className="text-muted" />
                      {appTitle(app)}
                    </button>
                  );
                })}
              </>
            )}
            <div role="separator" className="my-1 border-t border-osborder" />
            <button
              type="button"
              role="menuitem"
              data-menuitem
              data-wp-parent
              aria-haspopup="true"
              aria-expanded={wpOpen}
              onClick={() => setWpOpen((v) => !v)}
              className="flex w-full items-center gap-2.5 px-4 py-2 text-left text-sm text-ink hover:bg-paper focus-visible:bg-paper focus-visible:outline-none"
            >
              <span className="flex-1">Change wallpaper</span>
              <ChevronRight size={14} className={`text-muted transition-transform duration-160 ${wpOpen ? 'rotate-90' : ''}`} />
            </button>
            {wpOpen && (
              <div role="menu" aria-label="Wallpaper" className="border-y border-osborder bg-paper/50 py-1">
                {WALLPAPERS.map((w) => (
                  <button
                    key={w.id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={wallpaper === w.id}
                    data-menuitem
                    data-wp-item
                    onClick={() => pickWallpaper(w.id)}
                    className="flex w-full items-center gap-2.5 px-4 py-2 text-left text-sm text-ink hover:bg-paper focus-visible:bg-paper focus-visible:outline-none"
                  >
                    <span className="flex w-4 justify-center" aria-hidden="true">
                      {wallpaper === w.id && <Check size={14} className="text-accent" />}
                    </span>
                    {w.label}
                  </button>
                ))}
              </div>
            )}
            <button
              type="button"
              role="menuitem"
              data-menuitem
              onClick={openDisplaySettings}
              className="flex w-full items-center gap-2.5 px-4 py-2 text-left text-sm text-ink hover:bg-paper focus-visible:bg-paper focus-visible:outline-none"
            >
              Display settings
            </button>
          </div>
        )}
      </div>
  );

  return uiStyle === 'macosx' ? (
    // Snow Leopard: menu bar on top, floating 3D Dock at the bottom.
    <div className={`${rootCls} flex-col`} style={zoomStyle}>
      <MacMenuBar key="menubar" onSpotlight={() => setSpotlightOpen(true)} />
      {desktopArea}
      <MacDock key="dock" />

      <AppErrorBoundary label="POS kiosk overlay">
        <POSModeOverlay />
      </AppErrorBoundary>
      {welcomeOpen && <WelcomeDialog onDone={closeWelcome} />}
      <WelcomeTour />
    </div>
  ) : uiStyle === 'windows11' ? (
    // Windows 11: centered taskbar locked to the bottom.
    <div className={`${rootCls} flex-col`} style={zoomStyle}>
      {desktopArea}
      <Taskbar key="taskbar" forcePosition="bottom" centered />

      <AppErrorBoundary label="POS kiosk overlay">
        <POSModeOverlay />
      </AppErrorBoundary>
      {welcomeOpen && <WelcomeDialog onDone={closeWelcome} />}
      <WelcomeTour />
    </div>
  ) : (
    // Drift: taskbar dockable to any edge.
    <div className={`${rootCls} ${barRow ? 'flex-row' : 'flex-col'}`} style={zoomStyle}>
      {barFirst && <Taskbar key="taskbar" />}
      {desktopArea}
      {!barFirst && <Taskbar key="taskbar" />}

      <AppErrorBoundary label="POS kiosk overlay">
        <POSModeOverlay />
      </AppErrorBoundary>
      {welcomeOpen && <WelcomeDialog onDone={closeWelcome} />}
      <WelcomeTour />
    </div>
  );
}
