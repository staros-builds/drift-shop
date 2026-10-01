import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Search, Wifi, BatteryMedium } from 'lucide-react';
import { getApp } from '../../../apps/registry.jsx';
import { useWindows } from '../../../os/WindowsContext.jsx';
import { useAuth } from '../../../os/AuthContext.jsx';
import { useNotifications } from '../../../os/NotificationsContext.jsx';
import { DriftMark } from '../BootScreen.jsx';
import { localeTag } from '../../../lib/i18n.jsx';

function useClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

/**
 * Snow Leopard-style menu bar: white/translucent, logo mark + bold active
 * app name + simple menus on the left, Spotlight + clock + status icons on
 * the right. Every menu item is wired to a real action.
 */
export default function MacMenuBar({ onSpotlight }) {
  const { windows, activeSpaceId, openWindow, closeWindow, minimizeWindow, toggleMaximize, focusWindow } =
    useWindows();
  const { signOut } = useAuth();
  const { push } = useNotifications();
  const [openMenu, setOpenMenu] = useState(null);
  const now = useClock();
  const barRef = useRef(null);

  useEffect(() => {
    if (!openMenu) return;
    const onDown = (e) => {
      if (barRef.current && !barRef.current.contains(e.target)) setOpenMenu(null);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') setOpenMenu(null);
    };
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [openMenu]);

  const spaceWindows = windows.filter((w) => w.spaceId === activeSpaceId);
  const activeWin = spaceWindows
    .filter((w) => !w.minimized)
    .reduce((a, b) => (!a || b.z > a.z ? b : a), null);
  let activeAppName = 'Drift Shop';
  if (activeWin) {
    try {
      activeAppName = getApp(activeWin.appId).title || activeWin.title;
    } catch {
      activeAppName = activeWin.title;
    }
  }

  const openApp = (id) => {
    setOpenMenu(null);
    try {
      openWindow(id);
    } catch (e) {
      push('Error', e.message);
    }
  };
  const quitApp = (appId) => {
    setOpenMenu(null);
    spaceWindows.filter((w) => w.appId === appId).forEach((w) => closeWindow(w.id));
  };

  const menus = useMemo(() => {
    const fileItems = activeWin
      ? [
          { label: 'Close Window', fn: () => closeWindow(activeWin.id) },
          { label: `Quit ${activeAppName}`, fn: () => quitApp(activeWin.appId) },
        ]
      : [{ label: 'No window open', disabled: true }];
    return [
      {
        id: 'drift',
        label: <DriftMark size={15} />,
        aria: 'Drift Shop menu',
        items: [
          { label: 'About This Drift Shop', fn: () => openApp('settings') },
          { label: 'Settings…', fn: () => openApp('settings') },
          { sep: true },
          {
            label: 'Sign Out',
            fn: async () => {
              setOpenMenu(null);
              try {
                await signOut();
              } catch (e) {
                push('Error', e.message);
              }
            },
          },
        ],
      },
      { id: 'file', label: 'File', items: fileItems },
      {
        id: 'edit',
        label: 'Edit',
        items: [{ label: 'Preferences…', fn: () => openApp('settings') }],
      },
      {
        id: 'view',
        label: 'View',
        items: activeWin
          ? [
              { label: activeWin.maximized ? 'Restore Zoom' : 'Zoom', fn: () => toggleMaximize(activeWin.id) },
              { label: 'Minimize', fn: () => minimizeWindow(activeWin.id) },
            ]
          : [{ label: 'No window open', disabled: true }],
      },
      {
        id: 'window',
        label: 'Window',
        items:
          spaceWindows.length > 0
            ? spaceWindows.map((w) => ({
                label: `${w.id === activeWin?.id ? '✓ ' : ''}${w.title}`,
                fn: () => focusWindow(w.id),
              }))
            : [{ label: 'No windows open', disabled: true }],
      },
      {
        id: 'help',
        label: 'Help',
        items: [
          {
            label: 'Drift Shop Guide',
            fn: () => {
              setOpenMenu(null);
              window.dispatchEvent(new Event('drift:show-welcome'));
            },
          },
          { label: 'App Store', fn: () => openApp('store') },
        ],
      },
    ];
  }, [activeWin, activeAppName, spaceWindows]); // eslint-disable-line react-hooks/exhaustive-deps

  const time = now.toLocaleTimeString(localeTag(), { hour: 'numeric', minute: '2-digit' });
  const dateStr = now.toLocaleDateString(localeTag(), { weekday: 'short', month: 'short', day: 'numeric' });

  return (
    <div ref={barRef} className="mac-menubar relative z-40 flex h-8 shrink-0 items-stretch text-[13px]">
      {/* Snow Leopard order: logo, bold active-app name, then the menus. */}
      {[menus[0]].map((m) => (
        <div key={m.id} className="relative flex items-stretch">
          <button
            type="button"
            aria-label={m.aria || `${m.label} menu`}
            onClick={() => setOpenMenu(openMenu === m.id ? null : m.id)}
            onPointerEnter={() => {
              if (openMenu) setOpenMenu(m.id);
            }}
            className={`flex items-center px-3.5 ${openMenu === m.id ? 'bg-black/10' : 'hover:bg-black/5'}`}
          >
            {m.id === 'drift' ? m.label : <span className="font-medium">{m.label}</span>}
          </button>
          {openMenu === m.id && (
            <div className="absolute left-0 top-full z-50 min-w-52 overflow-hidden rounded-b-lg border border-black/20 bg-white/95 py-1 shadow-win backdrop-blur-xl dark:bg-[#2c2c2e]/95">
              {m.items.map((item, i) =>
                item.sep ? (
                  <div key={i} className="mx-2 my-1 border-t border-black/10" />
                ) : (
                  <button
                    key={i}
                    type="button"
                    disabled={item.disabled}
                    onClick={() => {
                      item.fn?.();
                      setOpenMenu(null);
                    }}
                    className={`block w-full px-4 py-1 text-left text-[13px] ${
                      item.disabled
                        ? 'cursor-default text-black/35 dark:text-white/35'
                        : 'text-black hover:bg-[#0a84ff] hover:text-white dark:text-white'
                    }`}
                  >
                    {item.label}
                  </button>
                )
              )}
            </div>
          )}
        </div>
      ))}
      {/* Bold active-app name sits right after the logo, classic Mac order. */}
      <div className="flex items-center px-1 font-bold">{activeAppName}</div>
      {menus.slice(1).map((m) => (
        <div key={m.id} className="relative flex items-stretch">
          <button
            type="button"
            aria-label={m.aria || `${m.label} menu`}
            onClick={() => setOpenMenu(openMenu === m.id ? null : m.id)}
            onPointerEnter={() => {
              if (openMenu) setOpenMenu(m.id);
            }}
            className={`flex items-center px-3.5 ${openMenu === m.id ? 'bg-black/10' : 'hover:bg-black/5'}`}
          >
            {m.id === 'drift' ? m.label : <span className="font-medium">{m.label}</span>}
          </button>
          {openMenu === m.id && (
            <div className="absolute left-0 top-full z-50 min-w-52 overflow-hidden rounded-b-lg border border-black/20 bg-white/95 py-1 shadow-win backdrop-blur-xl dark:bg-[#2c2c2e]/95">
              {m.items.map((item, i) =>
                item.sep ? (
                  <div key={i} className="mx-2 my-1 border-t border-black/10" />
                ) : (
                  <button
                    key={i}
                    type="button"
                    disabled={item.disabled}
                    onClick={() => {
                      setOpenMenu(null);
                      if (!item.disabled && item.fn) item.fn();
                    }}
                    className={`flex w-full items-center justify-between gap-6 px-4 py-1.5 text-left text-[13px] ${
                      item.disabled ? 'text-muted' : 'hover:bg-[#0a84ff] hover:text-white'
                    }`}
                  >
                    {item.label}
                  </button>
                )
              )}
            </div>
          )}
        </div>
      ))}

      <div className="flex-1" />

      {/* Right side: Spotlight, clock, status icons. */}
      <button
        type="button"
        aria-label="Spotlight search"
        title="Spotlight search"
        onClick={onSpotlight}
        className="flex items-center px-3 hover:bg-black/5"
      >
        <Search size={14} />
      </button>
      <div className="hidden items-center gap-3 px-3 sm:flex" title={now.toLocaleString(localeTag())}>
        <Wifi size={14} aria-label="Wi-Fi" />
        <BatteryMedium size={16} aria-label="Battery" />
        <span className="font-medium tabular-nums">
          {dateStr} {time}
        </span>
      </div>
    </div>
  );
}
