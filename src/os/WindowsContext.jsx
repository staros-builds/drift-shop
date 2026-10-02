import React, { createContext, useContext, useEffect, useRef, useState, useCallback } from 'react';
import { backend } from '../lib/backend/current.js';
import { getApp } from '../apps/registry.jsx';
import { ensureWebApps } from '../lib/webapps.js';
import { useAuth } from './AuthContext.jsx';
import { playSound } from '../lib/sound.js';
import { appTitle } from '../lib/appTitle.js';

const WindowsContext = createContext(null);

/** Height of the taskbar; maximized windows fill the area above it. */
export const TASKBAR_HEIGHT = 56;

/**
 * Live bounds of the desktop area (excludes the taskbar, whatever edge it
 * is docked to). Window x/y are relative to the area's top-left, so the
 * returned x/y are always 0/0 when the element exists.
 */
export const areaRect = () => {
  if (typeof window !== 'undefined') {
    const el = document.getElementById('drift-desktop-area');
    if (el) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) return { x: 0, y: 0, w: r.width, h: r.height };
    }
    return { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight - TASKBAR_HEIGHT };
  }
  return { x: 0, y: 0, w: 1280, h: 800 - TASKBAR_HEIGHT };
};

const CASCADE_ORIGIN = { x: 336, y: 90 };
const CASCADE_STEP = 30;
const MIN_W = 240;
const MIN_H = 160;

/**
 * Clamp a window's bounds so it always fits inside the desktop area.
 * Applied on open, restore, manual resize, and viewport changes, so a
 * window is never stranded off-screen — e.g. a layout saved on a
 * 1920px display restoring on an 800x600 one, or a cascade origin that
 * would push a wide window past the right edge. Maximized windows are
 * left alone (the renderer sizes them). At least a 120px grab strip of
 * the title bar is always kept on-screen.
 */
const fitWinToArea = (win, area) => {
  if (win.maximized) return win;
  const w = Math.min(Math.max(win.w || MIN_W, MIN_W), Math.max(MIN_W, area.w - 16));
  const h = Math.min(Math.max(win.h || MIN_H, MIN_H), Math.max(MIN_H, area.h - 16));
  const maxX = Math.max(0, area.w - 120);
  const maxY = Math.max(0, area.h - 48);
  const x = Math.min(Math.max(win.x || 0, 0), maxX);
  const y = Math.min(Math.max(win.y || 0, 0), maxY);
  // Pull fully-visible windows back inside when they fit.
  const fx = Math.min(x, Math.max(0, area.w - w));
  const fy = Math.min(y, Math.max(0, area.h - h));
  return { ...win, x: Math.round(fx), y: Math.round(fy), w: Math.round(w), h: Math.round(h) };
};

/**
 * Window manager. Window: { id, appId, title, x, y, w, h, z,
 * minimized, maximized, snapped, prev, props, spaceId }.
 * - maximized: fills the desktop area; prev holds pre-maximize bounds.
 * - snapped: 'left' | 'right' while snapped to a screen half; prev holds
 *   the pre-snap bounds so a drag or Alt+Down restores them.
 * (spaceId is internal bookkeeping so visibleWindows can be "active space
 * only".)
 */
export function WindowsProvider({ children }) {
  const { user, isAdmin } = useAuth();
  const [spaces, setSpaces] = useState([]);
  const [activeSpaceId, setActiveSpaceId] = useState(null);
  const [windows, setWindows] = useState([]);
  // Transient drag state for window snapping: { winId, edge } where edge is
  // 'left' | 'right' | 'maximize'. Set by the dragged Window, rendered as a
  // ghost overlay by Desktop. Never persisted.
  const [snapPreview, setSnapPreview] = useState(null);

  const zTop = useRef(0);
  const idSeq = useRef(0);
  const readyRef = useRef(false); // true after login restore completes
  const persistTimer = useRef(null);
  const windowsRef = useRef([]);
  const activeSpaceIdRef = useRef(null);
  const isAdminRef = useRef(false);
  useEffect(() => {
    isAdminRef.current = isAdmin;
  }, [isAdmin]);

  useEffect(() => {
    windowsRef.current = windows;
  }, [windows]);
  useEffect(() => {
    activeSpaceIdRef.current = activeSpaceId;
  }, [activeSpaceId]);

  const schedulePersist = useCallback(() => {
    if (!readyRef.current) return;
    clearTimeout(persistTimer.current);
    persistTimer.current = setTimeout(async () => {
      try {
        const sid = activeSpaceIdRef.current;
        if (!sid) return;
        const open = windowsRef.current.filter((w) => w.spaceId === sid);
        for (const w of open) {
          await backend.spaces.saveWindowState(sid, {
            appId: w.appId,
            x: Math.round(w.x),
            y: Math.round(w.y),
            w: Math.round(w.w),
            h: Math.round(w.h),
            z: w.z,
            minimized: !!w.minimized,
            props: w.props || {},
          });
        }
      } catch (e) {
        console.error('[drift] window layout persist failed:', e);
      }
    }, 800);
  }, []);

  // Login: load spaces, restore each space's saved windows (minimized=false).
  // Logout: clear everything and disarm persistence.
  useEffect(() => {
    if (!user) {
      readyRef.current = false;
      clearTimeout(persistTimer.current);
      setSpaces([]);
      setActiveSpaceId(null);
      setWindows([]);
      setSnapPreview(null);
      zTop.current = 0;
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        // Web-app windows can only be restored after the installed list
        // loads — otherwise getApp() (now install-aware) would drop them.
        await ensureWebApps(user?.id);
        if (cancelled) return;
        const list = await backend.spaces.list();
        if (cancelled) return;
        setSpaces(list);
        const first = list[0] || null;
        setActiveSpaceId(first ? first.id : null);

        let maxZ = 0;
        const restored = [];
        for (const space of list) {
          const states = await backend.spaces.getWindowStates(space.id);
          if (cancelled) return;
          for (const st of states) {
            let app = null;
            try {
              app = getApp(st.appId);
            } catch {
              app = null;
            }
            if (!app || app.comingSoon || !app.component) continue;
            // A persisted admin window must not restore for a non-admin
            // (e.g. role revoked while the window state lingered).
            if (app.adminOnly && !isAdminRef.current) continue;
            maxZ = Math.max(maxZ, st.z || 0);
            restored.push({
              id: `win-${++idSeq.current}`,
              appId: st.appId,
              title: (st.props && st.props.title) || appTitle(app),
              x: typeof st.x === 'number' ? st.x : CASCADE_ORIGIN.x,
              y: typeof st.y === 'number' ? st.y : CASCADE_ORIGIN.y,
              w: st.w || (app.defaultSize && app.defaultSize.w) || 640,
              h: st.h || (app.defaultSize && app.defaultSize.h) || 440,
              z: st.z || 0,
              minimized: false,
              maximized: false,
              props: st.props || {},
              spaceId: space.id,
            });
          }
        }
        if (cancelled) return;
        zTop.current = maxZ;
        // Clamp restored bounds to the current viewport: a layout saved on
        // a large display must not restore stranded off-screen on 800x600.
        const area = areaRect();
        setWindows(restored.map((w) => fitWinToArea(w, area)));
        readyRef.current = true;
      } catch (e) {
        console.error('[drift] window restore failed:', e);
        readyRef.current = true;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const openWindow = useCallback(
    (appId, props = {}) => {
      let app = null;
      try {
        app = getApp(appId);
      } catch {
        app = null;
      }
      if (!app) throw new Error(`Unknown app: ${appId}`);
      if (app.adminOnly && !isAdminRef.current) {
        throw new Error(`"${appTitle(app)}" is only available to administrators.`);
      }
      if (app.comingSoon || !app.component) {
        throw new Error(`"${appTitle(app)}" is coming soon and can't be opened yet.`);
      }
      // initialMaximized is consumed by the window manager (e.g. TV Mode
      // launches apps fullscreen); it is not passed to the app component.
      const { initialMaximized, ...appProps } = props || {};
      const spaceId = activeSpaceIdRef.current;
      if (!spaceId) throw new Error('No active space to open the window in.');

      // Single-instance default: if this app already has a window in the
      // current space, focus it (un-minimize, bring to front) instead of
      // stacking a duplicate. This applies to multi-window apps too: a bare
      // icon/taskbar launch ("show me the app") focuses, while launches
      // carrying content props (a file path, the pinboard composer) always
      // open fresh so the requested content actually appears. Multi-document
      // workflows still work: opening a file from Files passes { path } and
      // gets its own window.
      const { title: _t, ...contentProps } = appProps;
      if (Object.keys(contentProps).length === 0) {
        const existing = windowsRef.current.find((w) => w.spaceId === spaceId && w.appId === appId);
        if (existing) {
          const fz = ++zTop.current;
          setWindows((prev) => prev.map((w) => (w.id === existing.id ? { ...w, z: fz, minimized: false } : w)));
          schedulePersist();
          return existing.id;
        }
      }

      const inSpace = windowsRef.current.filter((w) => w.spaceId === spaceId);
      const off = (inSpace.length % 6) * CASCADE_STEP;
      const area = areaRect();
      const dw = Math.min((app.defaultSize && app.defaultSize.w) || 640, Math.max(MIN_W, area.w - 40));
      const dh = Math.min((app.defaultSize && app.defaultSize.h) || 440, Math.max(MIN_H, area.h - 40));
      // Clamp the cascade origin so wide windows never open past the edge
      // on small displays (e.g. 800x600).
      const dx = Math.min(CASCADE_ORIGIN.x + off, Math.max(0, area.w - dw));
      const dy = Math.min(CASCADE_ORIGIN.y + off, Math.max(0, area.h - dh));
      const z = ++zTop.current;

      const win = {
        id: `win-${++idSeq.current}`,
        appId,
        title: props.title || appTitle(app),
        x: dx,
        y: dy,
        w: dw,
        h: dh,
        z,
        minimized: false,
        maximized: !!initialMaximized,
        props: appProps,
        spaceId,
      };
      setWindows((prev) => [...prev, win]);
      schedulePersist();
      playSound('windowOpen');
      return win.id;
    },
    [schedulePersist]
  );

  const closeWindow = useCallback(
    (id) => {
      const win = windowsRef.current.find((w) => w.id === id);
      setWindows((prev) => prev.filter((w) => w.id !== id));
      if (win) {
        playSound('windowClose');
        // Drop its persisted state so it doesn't restore on next login.
        backend.spaces.removeWindowState(win.spaceId, win.appId).catch((e) => {
          console.error('[drift] removeWindowState failed:', e);
        });
        schedulePersist();
      }
    },
    [schedulePersist]
  );

  const focusWindow = useCallback(
    (id) => {
      const z = ++zTop.current;
      setWindows((prev) => prev.map((w) => (w.id === id ? { ...w, z, minimized: false } : w)));
      schedulePersist();
    },
    [schedulePersist]
  );

  const minimizeWindow = useCallback(
    (id) => {
      setWindows((prev) => prev.map((w) => (w.id === id ? { ...w, minimized: true } : w)));
      schedulePersist();
    },
    [schedulePersist]
  );

  const toggleMaximize = useCallback(
    (id) => {
      setWindows((prev) =>
        prev.map((w) => {
          if (w.id !== id) return w;
          if (w.maximized) {
            const p = w.prev || {};
            return {
              ...w,
              maximized: false,
              snapped: null,
              x: p.x ?? w.x,
              y: p.y ?? w.y,
              w: p.w ?? w.w,
              h: p.h ?? w.h,
              prev: undefined,
            };
          }
          return {
            ...w,
            maximized: true,
            snapped: null,
            prev: { x: w.x, y: w.y, w: w.w, h: w.h },
            // Maximized windows fill the desktop area (never the taskbar),
            // whatever edge the taskbar is docked to.
            x: 0,
            y: 0,
            w: areaRect().w,
            h: areaRect().h,
          };
        })
      );
      schedulePersist();
    },
    [schedulePersist]
  );

  /**
   * Snap a window: 'left' | 'right' fills that half of the desktop area,
   * 'maximize' fills the whole area, 'restore' returns to the pre-snap /
   * pre-maximize bounds (no-op when neither is set). Snapping unminimizes.
   * Pre-existing prev bounds are kept when re-snapping or maximizing from
   * a snapped/maximized state, so restore always returns to the original
   * free-floating geometry.
   */
  const snapWindow = useCallback(
    (id, edge) => {
      const area = areaRect();
      setWindows((prev) =>
        prev.map((w) => {
          if (w.id !== id || w.minimized) return w;
          if (edge === 'restore') {
            if (!w.maximized && !w.snapped) return w;
            const p = w.prev || {};
            return {
              ...w,
              maximized: false,
              snapped: null,
              x: p.x ?? w.x,
              y: p.y ?? w.y,
              w: p.w ?? w.w,
              h: p.h ?? w.h,
              prev: undefined,
            };
          }
          if (edge === 'maximize') {
            if (w.maximized) return w;
            return {
              ...w,
              maximized: true,
              snapped: null,
              prev: w.snapped || w.maximized ? w.prev : { x: w.x, y: w.y, w: w.w, h: w.h },
              x: 0,
              y: 0,
              w: area.w,
              h: area.h,
            };
          }
          if (edge !== 'left' && edge !== 'right') return w;
          const prevBounds =
            w.snapped || w.maximized ? w.prev || { x: w.x, y: w.y, w: w.w, h: w.h } : { x: w.x, y: w.y, w: w.w, h: w.h };
          const halfW = Math.floor(area.w / 2);
          return {
            ...w,
            maximized: false,
            minimized: false,
            snapped: edge,
            prev: prevBounds,
            x: edge === 'left' ? 0 : area.w - halfW,
            y: 0,
            w: halfW,
            h: area.h,
          };
        })
      );
      schedulePersist();
    },
    [schedulePersist]
  );

  const moveWindow = useCallback(
    (id, x, y) => {
      // A manual move leaves the snapped/maximized layout — drop the flag
      // (maximized windows are still immovable via this path).
      setWindows((prev) =>
        prev.map((w) => (w.id === id && !w.maximized ? { ...w, x, y, snapped: null } : w))
      );
      schedulePersist();
    },
    [schedulePersist]
  );

  const setWindowSpace = useCallback(
    (id, spaceId) => {
      const win = windowsRef.current.find((w) => w.id === id);
      if (!win || !spaceId || win.spaceId === spaceId) return;
      setWindows((prev) => prev.map((w) => (w.id === id ? { ...w, spaceId } : w)));
      // Drop the stale persisted state in the old space so the window doesn't
      // restore there, and save it directly into its new space — the debounced
      // persist only covers the active space.
      backend.spaces
        .removeWindowState(win.spaceId, win.appId)
        .then(() =>
          backend.spaces.saveWindowState(spaceId, {
            appId: win.appId,
            x: Math.round(win.x),
            y: Math.round(win.y),
            w: Math.round(win.w),
            h: Math.round(win.h),
            z: win.z,
            minimized: !!win.minimized,
            props: win.props || {},
          })
        )
        .catch((e) => {
          console.error('[drift] setWindowSpace persist failed:', e);
        });
      schedulePersist();
    },
    [schedulePersist]
  );

  const resizeWindow = useCallback(
    (id, w, h) => {
      const area = areaRect();
      const nw = Math.min(Math.max(MIN_W, Math.round(w)), Math.max(MIN_W, area.w - 16));
      const nh = Math.min(Math.max(MIN_H, Math.round(h)), Math.max(MIN_H, area.h - 16));
      setWindows((prev) =>
        prev.map((win) => {
          if (win.id !== id || win.maximized) return win;
          // Keep the window inside the area after growing it.
          const nx = Math.min(win.x, Math.max(0, area.w - nw));
          const ny = Math.min(win.y, Math.max(0, area.h - nh));
          return { ...win, w: nw, h: nh, x: nx, y: ny, snapped: null };
        })
      );
      schedulePersist();
    },
    [schedulePersist]
  );

  // Viewport shrank (browser zoom, display change, window resize): pull
  // every non-maximized window back inside the desktop area so none is
  // stranded off-screen. Debounced; no-ops when nothing is out of bounds.
  useEffect(() => {
    let t = null;
    const onResize = () => {
      clearTimeout(t);
      t = setTimeout(() => {
        const area = areaRect();
        setWindows((prev) => {
          let changed = false;
          const next = prev.map((w) => {
            const f = fitWinToArea(w, area);
            if (f.x !== w.x || f.y !== w.y || f.w !== w.w || f.h !== w.h) changed = true;
            return f;
          });
          return changed ? next : prev;
        });
      }, 150);
    };
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      clearTimeout(t);
    };
  }, []);

  const setWindowTitle = useCallback((id, title) => {
    if (typeof title !== 'string' || !title.trim()) return;
    setWindows((prev) => prev.map((w) => (w.id === id ? { ...w, title: title.trim() } : w)));
  }, []);

  const setActiveSpace = useCallback((id) => {
    setActiveSpaceId(id);
  }, []);

  const createSpace = useCallback(async (name) => {
    const space = await backend.spaces.create(name); // throws at 8
    setSpaces((prev) => [...prev, space].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0)));
    return space;
  }, []);

  const renameSpace = useCallback(async (id, name) => {
    const space = await backend.spaces.rename(id, name);
    setSpaces((prev) => prev.map((s) => (s.id === id ? space : s)));
    return space;
  }, []);

  const updateSpace = useCallback(async (id, patch) => {
    const space = await backend.spaces.update(id, patch);
    setSpaces((prev) => prev.map((s) => (s.id === id ? space : s)));
    return space;
  }, []);

  const deleteSpace = useCallback(async (id) => {
    const remaining = spaces.filter((s) => s.id !== id);
    const main = remaining.find((s) => (s.name || '').toLowerCase() === 'main') || remaining[0] || null;
    await backend.spaces.remove(id); // backend moves that space's states to Main
    setSpaces(remaining);
    if (main) {
      setWindows((prev) => prev.map((w) => (w.spaceId === id ? { ...w, spaceId: main.id } : w)));
      if (activeSpaceIdRef.current === id) setActiveSpaceId(main.id);
    } else {
      setWindows((prev) => prev.filter((w) => w.spaceId !== id));
      if (activeSpaceIdRef.current === id) setActiveSpaceId(null);
    }
  }, [spaces]);

  // Windows belonging to the active space (minimized ones are kept mounted
  // but hidden, so minimize preserves app state without unmounting).
  const visibleWindows = windows.filter((w) => w.spaceId === activeSpaceId);

  const value = {
    windows,
    visibleWindows,
    spaces,
    activeSpaceId,
    openWindow,
    closeWindow,
    focusWindow,
    minimizeWindow,
    toggleMaximize,
    snapWindow,
    snapPreview,
    setSnapPreview,
    moveWindow,
    resizeWindow,
    setWindowTitle,
    setWindowSpace,
    setActiveSpace,
    createSpace,
    renameSpace,
    updateSpace,
    deleteSpace,
  };
  return <WindowsContext.Provider value={value}>{children}</WindowsContext.Provider>;
}

export function useWindows() {
  const ctx = useContext(WindowsContext);
  if (!ctx) throw new Error('useWindows must be used inside <WindowsProvider>.');
  return ctx;
}
