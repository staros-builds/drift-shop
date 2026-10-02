import React, { useRef, useState } from 'react';
import { Minus, Maximize2, Minimize2, X } from 'lucide-react';
import { getApp } from '../../apps/registry.jsx';
import { useWindows, TASKBAR_HEIGHT } from '../../os/WindowsContext.jsx';
import { useNotifications } from '../../os/NotificationsContext.jsx';
import { useSettings } from '../../os/SettingsContext.jsx';
import { winTitle } from '../../lib/appTitle.js';

import AppErrorBoundary from './AppErrorBoundary.jsx';

/** Per-app crash bulkhead: one app's crash can never blank the OS.
 * (Implementation lives in AppErrorBoundary.jsx; kept here as the mount
 * point so every registry app window gets it.) */

const desktopRect = () => {
  const el = document.getElementById('drift-desktop-area');
  if (el) {
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
  }
  return { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight - TASKBAR_HEIGHT };
};

/** Pointer distance (px) from a desktop-area edge that arms a snap preview. */
const SNAP_ZONE = 12;

/**
 * Which snap zone the pointer is in, or null. Top edge → maximize,
 * left/right edges → that half. Bounds are viewport coords from desktopRect().
 */
const snapEdgeAt = (clientX, clientY, bounds) => {
  if (clientY - bounds.top <= SNAP_ZONE) return 'maximize';
  if (clientX - bounds.left <= SNAP_ZONE) return 'left';
  if (bounds.right - clientX <= SNAP_ZONE) return 'right';
  return null;
};

const HANDLES = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];

const handleCursor = {
  n: 'cursor-ns-resize',
  s: 'cursor-ns-resize',
  e: 'cursor-ew-resize',
  w: 'cursor-ew-resize',
  ne: 'cursor-nesw-resize',
  sw: 'cursor-nesw-resize',
  nw: 'cursor-nwse-resize',
  se: 'cursor-nwse-resize',
};

const handlePos = {
  n: 'left-3 right-3 top-0 h-3 -translate-y-1/2',
  s: 'left-3 right-3 bottom-0 h-3 translate-y-1/2',
  e: 'top-3 bottom-3 right-0 w-3 translate-x-1/2',
  w: 'top-3 bottom-3 left-0 w-3 -translate-x-1/2',
  ne: 'right-0 top-0 h-5 w-5 translate-x-1/2 -translate-y-1/2',
  nw: 'left-0 top-0 h-5 w-5 -translate-x-1/2 -translate-y-1/2',
  se: 'bottom-0 right-0 h-6 w-6 translate-x-1/3 translate-y-1/3',
  sw: 'bottom-0 left-0 h-5 w-5 -translate-x-1/2 translate-y-1/2',
};

/** Small diagonal grip shown in the bottom-right corner so resizing is discoverable. */
function ResizeGrip() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" className="opacity-60">
      <g stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
        <line x1="12" y1="4" x2="4" y2="12" />
        <line x1="12" y1="8" x2="8" y2="12" />
        <line x1="12" y1="12" x2="12" y2="12" />
      </g>
    </svg>
  );
}

/**
 * A single OS window. Draggable by the title bar, resizable from edges and
 * corners, constrained to the desktop area. Renders the app's component with
 * its saved props plus windowApi { close, setTitle }.
 */
export default function Window({ win }) {
  const { closeWindow, focusWindow, minimizeWindow, toggleMaximize, snapWindow, snapPreview, setSnapPreview, moveWindow, resizeWindow, setWindowTitle } =
    useWindows();
  const { push } = useNotifications();
  const { settings } = useSettings();
  const uiStyle = settings?.ui_style || 'drift';
  const drag = useRef(null);
  const [, forceTick] = useState(0);

  const app = (() => {
    try {
      return getApp(win.appId);
    } catch {
      return null; // e.g. a web app uninstalled while its window was open
    }
  })();
  if (!app) {
    return (
      <div className="drift-window absolute flex flex-col items-center justify-center gap-2 overflow-hidden rounded-os border border-osborder bg-surface p-6 text-center shadow-win"
        style={{ left: win.x, top: win.y, width: win.w, height: win.h, zIndex: win.z, display: win.minimized ? 'none' : 'flex' }}>
        <p className="text-sm font-medium text-ink">This app was uninstalled.</p>
        <button type="button" onClick={() => closeWindow(win.id)}
          className="rounded-os bg-accent px-4 py-2 text-sm text-accentink hover:opacity-90">
          Close window
        </button>
      </div>
    );
  }
  const AppComponent = app.component;
  const Icon = app.icon;

  const windowApi = {
    close: () => closeWindow(win.id),
    setTitle: (t) => setWindowTitle(win.id, t),
  };

  // ---- drag ----
  const onTitlePointerDown = (e) => {
    if (e.button !== 0 || win.maximized) return;
    if (e.target.closest('[data-win-btn]')) return;
    focusWindow(win.id);
    // A snapped window unsnaps on drag: restore the pre-snap bounds (stored
    // by snapWindow) and drag those, so the window follows the cursor from
    // where it was, not from the snapped half.
    let ox = win.x;
    let oy = win.y;
    if (win.snapped) {
      const p = win.prev || {};
      ox = p.x ?? win.x;
      oy = p.y ?? win.y;
      snapWindow(win.id, 'restore');
    }
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const bounds = desktopRect();
    drag.current = {
      kind: 'move',
      startX: e.clientX,
      startY: e.clientY,
      origX: ox,
      origY: oy,
      bounds,
      w: win.w,
      h: win.h,
    };
  };

  // ---- resize ----
  const onHandlePointerDown = (dir) => (e) => {
    if (e.button !== 0 || win.maximized) return;
    e.stopPropagation();
    focusWindow(win.id);
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    drag.current = {
      kind: 'resize',
      dir,
      startX: e.clientX,
      startY: e.clientY,
      origX: win.x,
      origY: win.y,
      origW: win.w,
      origH: win.h,
      bounds: desktopRect(),
    };
  };

  const onPointerMove = (e) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (d.kind === 'move') {
      const nx = Math.min(Math.max(d.origX + dx, d.bounds.left), d.bounds.right - 120);
      const ny = Math.min(Math.max(d.origY + dy, d.bounds.top), d.bounds.bottom - 48);
      moveWindow(win.id, nx - d.bounds.left, ny - d.bounds.top);
      // Snap zones: near the left/right edge arms a half-screen preview,
      // near the top edge a fullscreen one. Only re-render on change.
      // The edge is also stashed on the drag ref so the drop handler can't
      // miss it if a re-render hasn't committed yet.
      const edge = snapEdgeAt(e.clientX, e.clientY, d.bounds);
      d.edge = edge;
      setSnapPreview((prev) =>
        prev && prev.winId === win.id && prev.edge === edge ? prev : edge ? { winId: win.id, edge } : null
      );
    } else {
      let { origX: nx, origY: ny, origW: nw, origH: nh } = d;
      const dir = d.dir;
      if (dir.includes('e')) nw = d.origW + dx;
      if (dir.includes('s')) nh = d.origH + dy;
      if (dir.includes('w')) {
        nw = d.origW - dx;
        nx = d.origX + dx;
      }
      if (dir.includes('n')) {
        nh = d.origH - dy;
        ny = d.origY + dy;
      }
      nw = Math.max(240, nw);
      nh = Math.max(160, nh);
      if (dir.includes('w')) nx = d.origX + (d.origW - nw);
      if (dir.includes('n')) ny = d.origY + (d.origH - nh);
      // Clamp within the desktop bounds.
      const b = d.bounds;
      nx = Math.min(Math.max(nx, b.left), b.right - 120);
      ny = Math.min(Math.max(ny, b.top), b.bottom - 48);
      nw = Math.min(nw, b.right - nx);
      nh = Math.min(nh, b.bottom - ny);
      if (nx !== d.origX || ny !== d.origY) {
        moveWindow(win.id, nx - b.left, ny - b.top);
      }
      resizeWindow(win.id, nw, nh);
    }
  };

  // Titlebar drop: apply an armed snap, otherwise keep the dragged position
  // (already applied incrementally by moveWindow during the drag).
  const onTitlePointerUp = () => {
    const d = drag.current;
    drag.current = null;
    setSnapPreview(null);
    if (!d || d.kind !== 'move') return;
    // Prefer the edge stashed on the drag ref (immune to render timing);
    // fall back to the shared preview state.
    const edge = d.edge ?? (snapPreview && snapPreview.winId === win.id ? snapPreview.edge : null);
    if (edge === 'left' || edge === 'right') {
      snapWindow(win.id, edge);
    } else if (edge === 'maximize') {
      toggleMaximize(win.id); // existing maximize path (stores prev bounds)
    }
  };

  const onPointerUp = () => {
    drag.current = null;
    setSnapPreview(null);
  };

  const btn =
    'flex h-7 w-9 items-center justify-center text-muted duration-160 hover:bg-osborder/60 hover:text-ink';

  // ---- Touch mode: fullscreen app with a slim top bar (no drag/resize chrome).
  // The TouchShell stacks these; the topmost (highest z) covers the rest.
  if (settings?.touch_mode) {
    return (
      <div
        className="absolute inset-0 flex-col bg-paper"
        style={{ display: win.minimized ? 'none' : 'flex', zIndex: 400 + win.z }}
        onPointerDown={() => focusWindow(win.id)}
      >
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-osborder bg-surface pl-4 pr-1">
          <span className="text-muted">
            <Icon size={18} strokeWidth={2} />
          </span>
          <span className="flex-1 truncate text-[17px] font-semibold text-ink">{winTitle(win)}</span>
          <button
            type="button"
            aria-label="Close"
            onClick={() => closeWindow(win.id)}
            className="flex h-11 w-11 items-center justify-center rounded-full text-ink active:bg-osborder/60"
          >
            <X size={22} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-hidden">
          <AppErrorBoundary
            label={winTitle(win)}
            onError={(err) => {
              push('Error', `“${winTitle(win)}” crashed: ${err.message}`);
              forceTick((n) => n + 1);
            }}
          >
            <AppComponent {...win.props} windowApi={windowApi} appEntry={app} />
          </AppErrorBoundary>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`drift-window absolute flex flex-col overflow-hidden bg-surface shadow-win ${
        uiStyle === 'macosx' ? 'mac-window' : 'rounded-os border border-osborder'
      }`}
      style={{
        left: win.x,
        top: win.y,
        width: win.w,
        height: win.h,
        zIndex: win.z,
        display: win.minimized ? 'none' : 'flex',
      }}
      onPointerDown={() => focusWindow(win.id)}
    >
      {/* Title bar — chrome varies by interface style. */}
      {uiStyle === 'macosx' ? (
        <div
          className="mac-titlebar mac-traffic-group flex h-9 shrink-0 select-none items-center gap-2 px-3"
          style={{ touchAction: 'none', cursor: win.maximized ? 'default' : 'move' }}
          onPointerDown={onTitlePointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onTitlePointerUp}
          onDoubleClick={() => toggleMaximize(win.id)}
        >
          <div className="flex items-center gap-2" onPointerDown={(e) => e.stopPropagation()}>
            <button type="button" aria-label="Close" title="Close" onClick={() => closeWindow(win.id)} className="mac-traffic mac-traffic-close">
              <span className="glyph">×</span>
            </button>
            <button type="button" aria-label="Minimize" title="Minimize" onClick={() => minimizeWindow(win.id)} className="mac-traffic mac-traffic-min">
              <span className="glyph">–</span>
            </button>
            <button
              type="button"
              aria-label={win.maximized ? 'Restore' : 'Zoom'}
              title="Zoom"
              onClick={() => toggleMaximize(win.id)}
              className="mac-traffic mac-traffic-zoom"
            >
              <span className="glyph">+</span>
            </button>
          </div>
          <span className="flex-1 truncate text-center text-[13px] font-medium">{winTitle(win)}</span>
          {/* Spacer balances the traffic lights so the title stays centered. */}
          <span className="w-[52px] shrink-0" aria-hidden="true" />
        </div>
      ) : (
        <div
          className="flex h-10 shrink-0 select-none items-center gap-2 border-b border-osborder bg-paper px-3"
          style={{ touchAction: 'none', cursor: win.maximized ? 'default' : 'move' }}
          onPointerDown={onTitlePointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onTitlePointerUp}
          onDoubleClick={() => toggleMaximize(win.id)}
        >
          <span className="text-muted">
            <Icon size={16} strokeWidth={2} />
          </span>
          <span className="flex-1 truncate text-sm font-medium text-ink">{winTitle(win)}</span>
          <div className="flex items-center" onPointerDown={(e) => e.stopPropagation()}>
            <button type="button" data-win-btn aria-label="Minimize" title="Minimize" className={btn} onClick={() => minimizeWindow(win.id)}>
              <Minus size={15} />
            </button>
            <button
              type="button"
              data-win-btn
              aria-label={win.maximized ? 'Restore' : 'Maximize'}
              title={win.maximized ? 'Restore' : 'Maximize'}
              className={btn}
              onClick={() => toggleMaximize(win.id)}
            >
              {win.maximized ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
            </button>
            <button
              type="button"
              data-win-btn
              aria-label="Close"
              title="Close"
              className={
                uiStyle === 'windows11'
                  ? `${btn} hover:!bg-[#e81123] hover:!text-white`
                  : `${btn} hover:!bg-accent hover:!text-accentink`
              }
              onClick={() => closeWindow(win.id)}
            >
              <X size={15} />
            </button>
          </div>
        </div>
      )}

      {/* App content */}
      <div className="min-h-0 flex-1 overflow-hidden">
        <AppErrorBoundary
          label={winTitle(win)}
          onError={(err) => {
            push('Error', `“${winTitle(win)}” crashed: ${err.message}`);
            forceTick((n) => n + 1);
          }}
        >
          <AppComponent {...win.props} windowApi={windowApi} appEntry={app} />
        </AppErrorBoundary>
      </div>

      {/* Resize handles */}
      {!win.maximized && (
        <div className="pointer-events-none absolute bottom-1 right-1 z-10 text-muted" aria-hidden="true">
          <ResizeGrip />
        </div>
      )}
      {!win.maximized &&
        HANDLES.map((dir) => (
          <div
            key={dir}
            className={`absolute z-10 ${handlePos[dir]} ${handleCursor[dir]}`}
            style={{ touchAction: 'none' }}
            onPointerDown={onHandlePointerDown(dir)}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
          />
        ))}
    </div>
  );
}
