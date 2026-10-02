import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { listLaunchableApps } from '../../../apps/registry.jsx';
import { ensureWebApps, useWebApps } from '../../../lib/webapps.js';
import { useWindows } from '../../../os/WindowsContext.jsx';
import { useAuth } from '../../../os/AuthContext.jsx';
import { useNotifications } from '../../../os/NotificationsContext.jsx';
import { useSettings } from '../../../os/SettingsContext.jsx';
import { appTitle } from '../../../lib/appTitle.js';

const BASE_SIZE = 46;
const MAG_RADIUS = 150;
// Classic Dock behavior: shrink icons so the whole tray fits on screen when
// many apps are installed (26+ App Store apps would otherwise overflow).
const MAX_TRAY_W = 1200;

/**
 * The iconic 3D glass-shelf Dock (Snow Leopard style): perspective
 * reflective shelf, magnification on hover, glowing running-indicator dots,
 * a divider, and Trash on the right. Always bottom-centered in this style.
 *
 * Click opens/focuses; right-click a running app offers Quit.
 */
export default function MacDock() {
  const { windows, activeSpaceId, openWindow, closeWindow, focusWindow } = useWindows();
  const { settings } = useSettings();
  const { user, isAdmin } = useAuth();
  const { push } = useNotifications();
  const installedIds = useWebApps();
  const [mouseX, setMouseX] = useState(null);
  const [ctxApp, setCtxApp] = useState(null); // { x, y, appId } | null
  const trayRef = useRef(null);

  useEffect(() => {
    ensureWebApps(user?.id);
  }, [user?.id]);

  const hidden = new Set(settings?.hidden_from_start || []);
  const apps = useMemo(
    () =>
      listLaunchableApps(isAdmin).filter(
        (a) => !a.comingSoon && a.component && !hidden.has(a.id)
      ),
    [installedIds, settings?.hidden_from_start, isAdmin] // eslint-disable-line react-hooks/exhaustive-deps
  );

  const runningIds = useMemo(() => {
    const s = new Set();
    for (const w of windows) {
      if (w.spaceId === activeSpaceId && !w.minimized) s.add(w.appId);
    }
    return s;
  }, [windows, activeSpaceId]);

  useEffect(() => {
    if (!ctxApp) return;
    const close = (e) => {
      if (e.target.closest?.('[data-dock-ctx]')) return;
      setCtxApp(null);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') setCtxApp(null);
    };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [ctxApp]);

  const scaleFor = (index) => {
    if (mouseX == null) return 1;
    const center = index * (BASE_SIZE + 8) + BASE_SIZE / 2;
    const d = Math.abs(mouseX - center);
    if (d >= MAG_RADIUS) return 1;
    return 1 + 0.6 * (1 - d / MAG_RADIUS);
  };

  const activate = (app) => {
    try {
      const top = windows
        .filter((w) => w.spaceId === activeSpaceId && w.appId === app.id && !w.minimized)
        .reduce((a, b) => (!a || b.z > a.z ? b : a), null);
      if (top) focusWindow(top.id);
      else openWindow(app.id);
    } catch (e) {
      push('Error', e.message);
    }
  };

  const quit = (appId) => {
    setCtxApp(null);
    windows
      .filter((w) => w.spaceId === activeSpaceId && w.appId === appId)
      .forEach((w) => closeWindow(w.id));
  };

  const openTrash = () => {
    try {
      openWindow('files');
    } catch (e) {
      push('Error', e.message);
    }
  };

  const onTrayMove = (e) => {
    const r = trayRef.current?.getBoundingClientRect();
    if (!r) return;
    setMouseX(e.clientX - r.left);
  };

  // Shrink every icon (including Trash) when the tray would exceed the
  // viewport, so all apps stay reachable without scrolling.
  const trayScale = Math.min(1, MAX_TRAY_W / ((apps.length + 1) * (BASE_SIZE + 8)));

  const renderIcon = (app, index) => {
    const Icon = app.icon;
    const running = runningIds.has(app.id);
    const s = scaleFor(index) * trayScale;
    return (
      <div key={app.id} className="group relative flex flex-col items-center" style={{ zIndex: 10 }}>
        {/* Classic tooltip label above the icon. */}
        <span className="pointer-events-none absolute -top-8 whitespace-nowrap rounded-md bg-black/70 px-2 py-0.5 text-xs text-white opacity-0 transition-opacity group-hover:opacity-100">
          {appTitle(app)}
        </span>
        <button
          type="button"
          aria-label={`Open ${appTitle(app)}`}
          onClick={() => activate(app)}
          onContextMenu={(e) => {
            e.preventDefault();
            if (running) setCtxApp({ x: e.clientX, y: e.clientY, appId: app.id });
          }}
          className="mac-dock-icon flex items-center justify-center rounded-2xl"
          style={{
            width: BASE_SIZE,
            height: BASE_SIZE,
            transform: `scale(${s.toFixed(3)})`,
          }}
        >
          <span className="flex h-full w-full items-center justify-center rounded-2xl border border-black/20 bg-gradient-to-b from-white/90 to-white/40 text-neutral-800 shadow-[0_2px_6px_rgba(0,0,0,0.35)] backdrop-blur">
            <Icon size={26} strokeWidth={1.75} />
          </span>
        </button>
        <span className="mt-1 h-1">
          {running && <span className="mac-running-dot block" />}
        </span>
      </div>
    );
  };

  return (
    <div className="mac-dock pointer-events-none absolute inset-x-0 bottom-2 z-40 flex justify-center">
      <div
        ref={trayRef}
        onMouseMove={onTrayMove}
        onMouseLeave={() => setMouseX(null)}
        className="mac-dock-tray pointer-events-auto flex items-end gap-2 rounded-2xl px-3 pb-2 pt-3"
      >
        {apps.map(renderIcon)}
        <div className="mac-dock-divider" aria-hidden="true" />
        {/* Trash: opens Files (Vendra has no Trash folder yet). */}
        <div className="group relative flex flex-col items-center">
          <span className="pointer-events-none absolute -top-8 whitespace-nowrap rounded-md bg-black/70 px-2 py-0.5 text-xs text-white opacity-0 transition-opacity group-hover:opacity-100">
            Trash
          </span>
          <button
            type="button"
            aria-label="Open Trash (Files)"
            title="Trash"
            onClick={openTrash}
            className="mac-dock-icon flex items-center justify-center text-neutral-700"
            style={{ width: BASE_SIZE, height: BASE_SIZE, transform: `scale(${(scaleFor(apps.length) * trayScale).toFixed(3)})` }}
          >
            <Trash2 size={26} strokeWidth={1.75} />
          </button>
          <span className="mt-1 h-1" />
        </div>
      </div>

      {ctxApp && (
        <div
          data-dock-ctx
          className="pointer-events-auto fixed z-[200] min-w-40 overflow-hidden rounded-lg border border-black/20 bg-white/95 py-1 shadow-win backdrop-blur-xl dark:bg-[#2c2c2e]/95"
          style={{
            left: Math.max(8, Math.min(ctxApp.x, window.innerWidth - 180)),
            top: Math.max(8, ctxApp.y - 90),
          }}
        >
          <button
            type="button"
            onClick={() => quit(ctxApp.appId)}
            className="block w-full px-4 py-1.5 text-left text-[13px] text-black hover:bg-[#0a84ff] hover:text-white dark:text-white"
          >
            Quit
          </button>
        </div>
      )}
    </div>
  );
}
