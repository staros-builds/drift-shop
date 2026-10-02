import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Bell, ChevronLeft, ChevronRight, Compass, LayoutGrid } from 'lucide-react';
import { getApp } from '../../apps/registry.jsx';
import { useWindows } from '../../os/WindowsContext.jsx';
import { useNotifications } from '../../os/NotificationsContext.jsx';
import { useSystemHealth, HEALTH_META } from '../../os/SystemHealthContext.jsx';
import { useLang } from '../../lib/i18n.jsx';
import HealthPanel from './HealthPanel.jsx';
import { useSettings } from '../../os/SettingsContext.jsx';
import StartMenu from './StartMenu.jsx';
import NotificationsPanel from './NotificationsPanel.jsx';
import { DriftMark } from './BootScreen.jsx';
import { winTitle } from '../../lib/appTitle.js';
import { localeTag } from '../../lib/i18n.jsx';

function useClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

// Sunday-first weekday headers, locale-aware short names.
const WEEKDAYS = Array.from({ length: 7 }, (_, i) =>
  new Date(2026, 8, 27 + i).toLocaleDateString(localeTag(), { weekday: 'short' })
);

/**
 * Small month calendar. Keyboard: Tab through the month nav buttons,
 * Escape closes. Styled with theme tokens so it renders correctly in
 * drift / windows11 / macosx styles and dark mode.
 */
function CalendarFlyout({ now, onClose, anchorRef }) {
  const ref = useRef(null);
  const [view, setView] = useState(() => new Date(now.getFullYear(), now.getMonth(), 1));
  const year = view.getFullYear();
  const month = view.getMonth();

  const firstDow = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells = [];
  for (let i = 0; i < firstDow; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);

  const isToday = (d) =>
    d !== null && now.getFullYear() === year && now.getMonth() === month && now.getDate() === d;
  const title = view.toLocaleDateString(localeTag(), { month: 'long', year: 'numeric' });

  useEffect(() => {
    ref.current?.focus();
    const onDown = (e) => {
      if (e.key === 'Escape') onClose();
    };
    const onPointer = (e) => {
      // The clock button toggles the flyout itself — don't treat it as an
      // outside click (pointerdown fires before the button's click).
      if (ref.current && !ref.current.contains(e.target) && !anchorRef?.current?.contains(e.target)) {
        onClose();
      }
    };
    window.addEventListener('keydown', onDown);
    window.addEventListener('pointerdown', onPointer);
    return () => {
      window.removeEventListener('keydown', onDown);
      window.removeEventListener('pointerdown', onPointer);
    };
  }, [onClose, anchorRef]);

  const navBtn =
    'flex h-8 w-8 items-center justify-center rounded-os text-muted duration-160 hover:bg-paper hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent';

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="Calendar"
      tabIndex={-1}
      className="w-64 rounded-os border border-osborder bg-surface p-3 shadow-win outline-none"
    >
      <div className="mb-2 flex items-center justify-between">
        <button type="button" aria-label="Previous month" className={navBtn} onClick={() => setView(new Date(year, month - 1, 1))}>
          <ChevronLeft size={16} />
        </button>
        <span className="text-sm font-semibold text-ink">{title}</span>
        <button type="button" aria-label="Next month" className={navBtn} onClick={() => setView(new Date(year, month + 1, 1))}>
          <ChevronRight size={16} />
        </button>
      </div>
      <div className="grid grid-cols-7 gap-0.5 text-center" role="presentation">
        {WEEKDAYS.map((d) => (
          <span key={d} className="pb-1 text-[10px] font-semibold uppercase tracking-wide text-muted">
            {d}
          </span>
        ))}
        {cells.map((d, i) =>
          d === null ? (
            <span key={`b${i}`} />
          ) : (
            <span
              key={d}
              aria-current={isToday(d) ? 'date' : undefined}
              className={`flex h-8 items-center justify-center rounded-os text-xs ${
                isToday(d) ? 'bg-accent font-bold text-accentink' : 'text-ink'
              }`}
            >
              {d}
            </span>
          )
        )}
      </div>
      {(year !== now.getFullYear() || month !== now.getMonth()) && (
        <button
          type="button"
          onClick={() => setView(new Date(now.getFullYear(), now.getMonth(), 1))}
          className="mt-2 w-full rounded-os py-1.5 text-xs font-medium text-accent duration-160 hover:bg-paper focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          Today
        </button>
      )}
    </div>
  );
}

// Where the Start menu / notifications panel pop out, per taskbar edge.
function menuPlacement(position) {
  switch (position) {
    case 'top':
      return 'absolute left-1/2 top-16 z-50 -translate-x-1/2';
    case 'left':
      return 'absolute left-16 top-1/2 z-50 -translate-y-1/2';
    case 'right':
      return 'absolute right-16 top-1/2 z-50 -translate-y-1/2';
    default:
      return 'absolute bottom-16 left-1/2 z-50 -translate-x-1/2';
  }
}

function panelPlacement(position) {
  switch (position) {
    case 'top':
      return 'absolute right-3 top-16 z-50';
    case 'left':
      return 'absolute bottom-3 left-16 z-50';
    case 'right':
      return 'absolute bottom-3 right-16 z-50';
    default:
      return 'absolute bottom-16 right-3 z-50';
  }
}

/**
 * Taskbar: start button, spaces rail, window buttons, notification bell,
 * Helm quick toggle, live clock. Dockable to any edge via
 * settings.taskbar_position ('top' | 'bottom' | 'left' | 'right');
 * left/right render a vertical bar.
 *
 * Props:
 * - forcePosition: override the settings position (windows11 style locks 'bottom').
 * - centered: center the start + window buttons (Windows 11 style).
 */
export default function Taskbar({ forcePosition, centered }) {
  const { windows, activeSpaceId, spaces, setActiveSpace, focusWindow, minimizeWindow, openWindow } = useWindows();
  const { unreadCount } = useNotifications();
  const { status: healthStatus } = useSystemHealth();
  const { t } = useLang();
  const { settings } = useSettings();
  const position = forcePosition || settings?.taskbar_position || 'bottom';
  const vertical = position === 'left' || position === 'right';
  const [menuOpen, setMenuOpen] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [clockOpen, setClockOpen] = useState(false);
  const [healthOpen, setHealthOpen] = useState(false);
  const clockBtnRef = useRef(null);
  const healthBtnRef = useRef(null);
  const now = useClock();

  const closeClock = useCallback(() => {
    setClockOpen(false);
    clockBtnRef.current?.focus();
  }, []);

  const spaceWindows = windows.filter((w) => w.spaceId === activeSpaceId);
  const topZ = spaceWindows.reduce((m, w) => Math.max(m, w.minimized ? -1 : w.z), -1);

  // Helm button only renders when the Helm app is actually openable —
  // no dead buttons.
  let helmOpenable = false;
  try {
    const helmApp = getApp('helm');
    helmOpenable = !!(helmApp && !helmApp.comingSoon && helmApp.component);
  } catch {
    helmOpenable = false;
  }

  const clickWindow = (win) => {
    if (win.minimized) {
      focusWindow(win.id); // restore + raise
    } else if (win.z === topZ) {
      minimizeWindow(win.id);
    } else {
      focusWindow(win.id);
    }
  };

  const toggleHelm = () => {
    const helm = spaceWindows.find((w) => w.appId === 'helm');
    if (helm) {
      focusWindow(helm.id);
    } else {
      openWindow('helm');
    }
  };

  const time = now.toLocaleTimeString(localeTag(), { hour: 'numeric', minute: '2-digit' });
  const date = now.toLocaleDateString(localeTag(), { weekday: 'short', month: 'short', day: 'numeric' });

  const startBtn = (
    <button
      type="button"
      aria-label="Start menu"
      onClick={() => {
        setPanelOpen(false);
        setClockOpen(false);
        setHealthOpen(false);
        setMenuOpen((v) => !v);
      }}
      className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-os duration-160 ${
        menuOpen ? 'bg-accent text-accentink' : 'text-accent hover:bg-paper'
      }`}
    >
      <DriftMark size={24} />
    </button>
  );

  const spacesRail = (
    <div className={`flex items-center gap-1 rounded-os bg-paper px-2 py-1 ${vertical ? 'flex-col px-1 py-2' : ''}`}>
      {spaces.slice(0, 8).map((s) => (
        <button
          key={s.id}
          type="button"
          title={s.name}
          aria-label={`Switch to ${s.name}`}
          onClick={() => setActiveSpace(s.id)}
          className={`h-2.5 w-2.5 rounded-full duration-160 ${
            s.id === activeSpaceId ? 'scale-125 bg-accent' : 'bg-osborder hover:bg-muted'
          }`}
        />
      ))}
    </div>
  );

  const windowBtns = spaceWindows.map((w) => {
    let Icon = LayoutGrid;
    try {
      Icon = getApp(w.appId).icon || LayoutGrid;
    } catch {
      /* keep fallback */
    }
    const active = !w.minimized && w.z === topZ;
    return (
      <button
        key={w.id}
        type="button"
        title={winTitle(w)}
        onClick={() => clickWindow(w)}
        className={`flex h-10 items-center gap-2 rounded-os px-2.5 duration-160 ${
          vertical ? 'w-10 justify-center px-0' : 'max-w-44 min-w-10'
        } ${
          active ? 'bg-accent/15 text-ink ring-1 ring-accent' : 'text-muted hover:bg-paper hover:text-ink'
        } ${w.minimized ? 'opacity-60' : ''}`}
      >
        <Icon size={16} className="shrink-0" />
        {!vertical && <span className="hidden truncate text-xs font-medium md:inline">{winTitle(w)}</span>}
      </button>
    );
  });

  const helmBtn = helmOpenable && (
    <button
      type="button"
      aria-label="Open Helm"
      title="Helm"
      onClick={toggleHelm}
      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-os text-muted duration-160 hover:bg-paper hover:text-ink"
    >
      <Compass size={18} />
    </button>
  );

  const bellBtn = (
    <button
      type="button"
      aria-label="Notifications"
      onClick={() => {
        setMenuOpen(false);
        setClockOpen(false);
        setHealthOpen(false);
        setPanelOpen((v) => !v);
      }}
      className={`relative flex h-10 w-10 shrink-0 items-center justify-center rounded-os duration-160 ${
        panelOpen ? 'bg-accent/15 text-ink' : 'text-muted hover:bg-paper hover:text-ink'
      }`}
    >
      <Bell size={18} />
      {unreadCount > 0 && (
        <span className="absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-bold text-accentink">
          {unreadCount > 9 ? '9+' : unreadCount}
        </span>
      )}
    </button>
  );

  // System health dot — green/amber/red self-check indicator.
  // Clicking opens the HealthPanel flyout with per-check details.
  const healthMeta = HEALTH_META[healthStatus] || HEALTH_META.ok;
  const healthBtn = (
    <button
      ref={healthBtnRef}
      type="button"
      aria-label={t('health.title')}
      aria-haspopup="dialog"
      aria-expanded={healthOpen}
      title={`${t('health.title')}: ${t(healthMeta.labelKey)}`}
      onClick={() => {
        setMenuOpen(false);
        setPanelOpen(false);
        setClockOpen(false);
        setHealthOpen((v) => !v);
      }}
      className={`relative flex h-10 w-10 shrink-0 items-center justify-center rounded-os duration-160 ${
        healthOpen ? 'bg-accent/15' : 'hover:bg-paper'
      }`}
    >
      <span
        className="h-3 w-3 rounded-full duration-160"
        style={{
          backgroundColor: healthMeta.dot,
          boxShadow: `0 0 6px ${healthMeta.dot}`,
        }}
        aria-hidden
      />
      {healthStatus !== 'ok' && (
        <span className="absolute right-1 top-1 h-2 w-2 rounded-full bg-surface" aria-hidden />
      )}
    </button>
  );

  const healthFlyout = healthOpen && (
    <div className={panelPlacement(position)}>
      <HealthPanel onClose={() => { setHealthOpen(false); healthBtnRef.current?.focus(); }} anchorRef={healthBtnRef} />
    </div>
  );

  // Live clock — a button that toggles the calendar flyout. The flyout
  // anchors next to the clock on every taskbar edge via panelPlacement().
  const clock = (
    <button
      ref={clockBtnRef}
      type="button"
      aria-label="Clock — show calendar"
      aria-haspopup="dialog"
      aria-expanded={clockOpen}
      title={now.toLocaleString(localeTag())}
      onClick={() => {
        setMenuOpen(false);
        setPanelOpen(false);
        setHealthOpen(false);
        setClockOpen((v) => !v);
      }}
      className={`select-none rounded-os duration-160 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
        clockOpen ? 'bg-accent/15' : ''
      } ${vertical ? 'hidden px-1 py-1 text-center sm:block' : 'hidden flex-col items-end px-2 py-1 sm:flex'}`}
    >
      {vertical ? (
        <span className="text-[10px] font-semibold leading-tight text-ink">{time}</span>
      ) : (
        <>
          <span className="text-sm font-semibold leading-tight text-ink">{time}</span>
          <span className="text-[11px] leading-tight text-muted">{date}</span>
        </>
      )}
    </button>
  );

  const clockFlyout = clockOpen && (
    <div className={panelPlacement(position)}>
      <CalendarFlyout now={now} onClose={closeClock} anchorRef={clockBtnRef} />
    </div>
  );

  if (vertical) {
    return (
      <div className="relative z-40 flex h-full w-14 flex-col items-center gap-2 border-osborder bg-surface px-2 py-3 shadow-os">
        {menuOpen && (
          <div className={menuPlacement(position)}>
            <StartMenu onClose={() => setMenuOpen(false)} />
          </div>
        )}
        {panelOpen && (
          <div className={panelPlacement(position)}>
            <NotificationsPanel onClose={() => setPanelOpen(false)} />
          </div>
        )}
        {healthFlyout}
        {clockFlyout}
        {startBtn}
        {spacesRail}
        <div className="flex min-h-0 flex-1 flex-col items-center gap-1 overflow-y-auto">{windowBtns}</div>
        {helmBtn}
        {healthBtn}
        {bellBtn}
        {clock}
      </div>
    );
  }

  // Centered variant (Windows 11 style): start + running apps centered,
  // spaces rail left, status right. Only used horizontally.
  if (centered && !vertical) {
    return (
      <div className="relative z-40">
        {menuOpen && (
          <div className={menuPlacement(position)}>
            <StartMenu onClose={() => setMenuOpen(false)} />
          </div>
        )}
        {panelOpen && (
          <div className={panelPlacement(position)}>
            <NotificationsPanel onClose={() => setPanelOpen(false)} />
          </div>
        )}
        {healthFlyout}
        {clockFlyout}

        <div
          className={`relative flex h-14 items-center gap-2 bg-surface px-3 shadow-os ${
            position === 'top' ? 'border-b border-osborder' : 'border-t border-osborder'
          }`}
        >
          {spacesRail}
          <div className="pointer-events-none absolute left-1/2 top-1/2 flex max-w-[70%] -translate-x-1/2 -translate-y-1/2 items-center gap-1 overflow-x-auto">
            <span className="pointer-events-auto flex items-center gap-1">
              {startBtn}
              {windowBtns}
            </span>
          </div>
          <div className="ml-auto flex items-center gap-2">
            {helmBtn}
            {healthBtn}
            {bellBtn}
            {clock}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="relative z-40">
      {menuOpen && (
        <div className={menuPlacement(position)}>
          <StartMenu onClose={() => setMenuOpen(false)} />
        </div>
      )}
      {panelOpen && (
        <div className={panelPlacement(position)}>
          <NotificationsPanel onClose={() => setPanelOpen(false)} />
        </div>
      )}
      {healthFlyout}
      {clockFlyout}

      <div
        className={`flex h-14 items-center gap-2 bg-surface px-3 shadow-os ${
          position === 'top' ? 'border-b border-osborder' : 'border-t border-osborder'
        }`}
      >
        {startBtn}
        {spacesRail}
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">{windowBtns}</div>
        {helmBtn}
        {healthBtn}
        {bellBtn}
        {clock}
      </div>
    </div>
  );
}
