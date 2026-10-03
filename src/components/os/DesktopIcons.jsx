import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Clock } from 'lucide-react';
import { APPS, listLaunchableApps } from '../../apps/registry.jsx';
import { ensureWebApps, useWebApps } from '../../lib/webapps.js';
import { useWindows } from '../../os/WindowsContext.jsx';
import { useAuth } from '../../os/AuthContext.jsx';
import { useNotifications } from '../../os/NotificationsContext.jsx';
import { useSettings } from '../../os/SettingsContext.jsx';
import { appTitle } from '../../lib/appTitle.js';

export const openableApps = APPS.filter((a) => !a.comingSoon && a.component);
const comingSoon = APPS.filter((a) => a.comingSoon);

// Icon tile metrics for the auto-layout grid and drag clamping.
const TILE_W = 96; // w-24
const TILE_H = 96; // icon + label
const CELL_W = 104;
const CELL_H = 104;
const PAD = 16;

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), Math.max(lo, hi));

/**
 * Desktop app icons. Freely positionable: drag any icon anywhere on the
 * desktop and it stays there — positions persist per device via
 * settings.icon_positions ({ [appId]: { x, y } }). Icons without a saved
 * position auto-fill a tidy column-major grid.
 *
 * Single-click selects, double-click opens. Visibility is controlled by
 * settings.desktop_icons (null = every app). Managed in Settings > Apps.
 *
 * The container is absolutely positioned to fill the desktop area (which
 * sits above/beside the taskbar), so icons can never slide underneath it.
 */
export default function DesktopIcons({ selectedId, onSelect }) {
  const { openWindow } = useWindows();
  const { push } = useNotifications();
  const { settings, updateSettings } = useSettings();
  const { user, isAdmin } = useAuth();
  const installedIds = useWebApps();
  const containerRef = useRef(null);
  const dragRef = useRef(null);
  const lastDragEnd = useRef(0);
  const [desk, setDesk] = useState({ w: 1280, h: 800 });
  const [ghost, setGhost] = useState(null); // { id, x, y } while dragging

  useEffect(() => {
    ensureWebApps(user?.id);
  }, [user?.id]);

  // Measure the desktop area so icons clamp inside it.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      setDesk({ w: Math.max(320, r.width), h: Math.max(240, r.height) });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Static apps plus installed web apps (App Store).
  const allOpenable = useMemo(
    () => listLaunchableApps(isAdmin).filter((a) => !a.comingSoon && a.component),
    [installedIds, isAdmin]
  );

  const shownIds = settings?.desktop_icons ?? null;
  const unordered = shownIds ? allOpenable.filter((a) => shownIds.includes(a.id)) : allOpenable;

  // Deterministic base order: the user's saved order, unknown ids at the end.
  const visible = useMemo(() => {
    const order = settings?.desktop_icon_order ?? [];
    const rank = new Map(order.map((id, i) => [id, i]));
    return [...unordered].sort((a, b) => {
      const ra = rank.has(a.id) ? rank.get(a.id) : Number.MAX_SAFE_INTEGER;
      const rb = rank.has(b.id) ? rank.get(b.id) : Number.MAX_SAFE_INTEGER;
      return ra - rb;
    });
  }, [unordered, settings?.desktop_icon_order]);

  // Resolve every icon to an { x, y }: saved position wins, the rest
  // auto-fill a column-major grid skipping occupied cells.
  const layout = useMemo(() => {
    const placed = new Map();
    const occupied = new Set();
    const cellKey = (c, r) => `${c}:${r}`;
    const maxX = Math.max(PAD, desk.w - TILE_W - PAD);
    const maxY = Math.max(PAD, desk.h - TILE_H - PAD);
    const saved = settings?.icon_positions ?? {};
    for (const app of visible) {
      const p = saved[app.id];
      if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
        const x = clamp(Math.round(p.x), PAD, maxX);
        const y = clamp(Math.round(p.y), PAD, maxY);
        placed.set(app.id, { x, y });
        occupied.add(cellKey(Math.floor(x / CELL_W), Math.floor(y / CELL_H)));
      }
    }
    const rows = Math.max(1, Math.floor((desk.h - PAD) / CELL_H));
    let cursor = 0;
    const nextFree = () => {
      for (;;) {
        const col = Math.floor(cursor / rows);
        const row = cursor % rows;
        cursor += 1;
        const k = cellKey(col, row);
        if (!occupied.has(k)) {
          occupied.add(k);
          return {
            x: clamp(PAD + col * CELL_W, PAD, maxX),
            y: clamp(PAD + row * CELL_H, PAD, maxY),
          };
        }
      }
    };
    for (const app of visible) {
      if (!placed.has(app.id)) placed.set(app.id, nextFree());
    }
    // "Coming soon" tiles (if any) park at the end of the grid, static.
    const soonLayout = new Map();
    for (const app of comingSoon) soonLayout.set(app.id, nextFree());
    return { placed, soon: soonLayout };
  }, [visible, settings?.icon_positions, desk]);

  const open = (app) => {
    try {
      openWindow(app.id);
    } catch (e) {
      push('Error', e.message);
    }
  };

  const savePosition = async (id, x, y) => {
    try {
      await updateSettings({
        icon_positions: { ...(settings?.icon_positions ?? {}), [id]: { x, y } },
      });
    } catch (e) {
      push('Error', `Could not save icon position: ${e.message}`);
    }
  };

  const posOf = (id) => (ghost?.id === id ? { x: ghost.x, y: ghost.y } : layout.placed.get(id));

  const beginDrag = (app) => (e) => {
    if (e.button != null && e.button !== 0) return;
    const start = layout.placed.get(app.id) || { x: PAD, y: PAD };
    dragRef.current = {
      id: app.id,
      startX: e.clientX,
      startY: e.clientY,
      origX: start.x,
      origY: start.y,
      moved: false,
    };
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* older browsers — drag still works without capture */
    }
  };

  const moveDrag = (app) => (e) => {
    const d = dragRef.current;
    if (!d || d.id !== app.id) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (!d.moved && Math.hypot(dx, dy) < 6) return; // click threshold
    d.moved = true;
    const el = containerRef.current;
    const r = el ? el.getBoundingClientRect() : { width: desk.w, height: desk.h };
    setGhost({
      id: app.id,
      x: clamp(Math.round(d.origX + dx), PAD, Math.max(PAD, r.width - TILE_W - PAD)),
      y: clamp(Math.round(d.origY + dy), PAD, Math.max(PAD, r.height - TILE_H - PAD)),
    });
  };

  const endDrag = (app) => async (e) => {
    const d = dragRef.current;
    dragRef.current = null;
    setGhost(null);
    if (!d || d.id !== app.id) return;
    if (d.moved) {
      lastDragEnd.current = Date.now();
      const el = containerRef.current;
      const r = el ? el.getBoundingClientRect() : { width: desk.w, height: desk.h };
      const x = clamp(
        Math.round(d.origX + (e.clientX - d.startX)),
        PAD,
        Math.max(PAD, r.width - TILE_W - PAD)
      );
      const y = clamp(
        Math.round(d.origY + (e.clientY - d.startY)),
        PAD,
        Math.max(PAD, r.height - TILE_H - PAD)
      );
      await savePosition(app.id, x, y);
    }
  };

  const handleClick = (app, selected) => () => {
    // A real drag just ended — don't treat the release as a select click.
    if (Date.now() - lastDragEnd.current < 350) return;
    onSelect(selected ? null : app.id);
  };

  const tile = (base) =>
    `flex w-24 touch-none select-none flex-col items-center gap-1.5 rounded-os p-2 duration-160 ${base}`;

  // z-0 on the icons layer: icons live in their own stacking level BELOW all
  // windows (windows start at z=1). Without this, each icon's local z-index
  // (10/20/30) competes with windows and icons paint over apps.
  return (
    <div ref={containerRef} className="pointer-events-auto absolute inset-0 z-0 overflow-hidden p-0">
      {visible.map((app) => {
        const Icon = app.icon;
        const selected = selectedId === app.id;
        const dragging = ghost?.id === app.id;
        const { x, y } = posOf(app.id) || { x: PAD, y: PAD };
        return (
          <button
            key={app.id}
            type="button"
            data-app-icon={app.id}
            title={`${appTitle(app)} — drag to move, double-click to open`}
            onClick={handleClick(app, selected)}
            onDoubleClick={() => open(app)}
            onPointerDown={beginDrag(app)}
            onPointerMove={moveDrag(app)}
            onPointerUp={endDrag(app)}
            onPointerCancel={endDrag(app)}
            style={{
              position: 'absolute',
              left: x,
              top: y,
              zIndex: dragging ? 30 : selected ? 20 : 10,
              cursor: dragging ? 'grabbing' : 'grab',
            }}
            className={tile(
              `${selected ? 'bg-accent/15 ring-1 ring-accent' : 'hover:bg-surface/70'} ${
                dragging ? 'scale-105 opacity-90 shadow-lg ring-2 ring-accent' : ''
              }`
            )}
          >
            <span
              className={`flex h-11 w-11 items-center justify-center rounded-os border border-osborder bg-surface text-ink shadow-os ${
                selected ? 'border-accent' : ''
              }`}
            >
              <Icon size={22} strokeWidth={1.75} />
            </span>
            <span className="line-clamp-2 w-28 -mx-2 break-words text-center text-xs font-medium leading-tight text-ink">{appTitle(app)}</span>
          </button>
        );
      })}

      {comingSoon.map((app) => {
        const Icon = app.icon;
        const { x, y } = layout.soon.get(app.id) || { x: PAD, y: PAD };
        return (
          <div
            key={app.id}
            className={tile('cursor-default opacity-60')}
            style={{ position: 'absolute', left: x, top: y }}
            title={`${appTitle(app)} — coming soon`}
            aria-disabled="true"
          >
            <span className="relative flex h-11 w-11 items-center justify-center rounded-os border border-osborder bg-surface text-muted">
              <Icon size={22} strokeWidth={1.75} />
              <span className="absolute -bottom-1 -right-1 rounded-full bg-paper p-0.5 text-muted">
                <Clock size={12} />
              </span>
            </span>
            <span className="max-w-full truncate text-xs font-medium text-muted">{appTitle(app)}</span>
            <span className="text-[10px] text-muted">coming soon</span>
          </div>
        );
      })}
    </div>
  );
}
