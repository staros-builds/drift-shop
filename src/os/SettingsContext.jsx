import React, { createContext, useContext, useEffect, useState, useCallback, useRef } from 'react';
import { backend } from '../lib/backend/current.js';
import { useAuth } from './AuthContext.jsx';
import { loadThemeMode, saveThemeMode, resolveTheme, THEME_MODES } from '../lib/theme.js';

const SettingsContext = createContext(null);

/**
 * First-run default for touch mode: on when the device reports a coarse
 * (touch) pointer and the screen is phone-sized. Evaluated once at module
 * load; afterwards the stored setting (or the user's toggle) wins.
 */
function detectTouchMode() {
  try {
    return (
      typeof window !== 'undefined' &&
      window.matchMedia('(pointer: coarse)').matches &&
      window.innerWidth < 820
    );
  } catch {
    return false;
  }
}

const DEFAULTS = {
  visual_theme: 'daybreak',
  wallpaper: 'paper-grain',
  accent_override: null,
  ai_engine: 'local',
  ui_scale: 100,
  icon_positions: {},
  desktop_icons: null, // null = show every app; otherwise an array of app ids
  hidden_from_start: [], // app ids hidden from the Start menu / TouchHome
  desktop_icon_order: [], // app ids in the user's preferred desktop order
  taskbar_position: 'bottom', // 'top' | 'bottom' | 'left' | 'right'
  ui_style: 'drift', // 'drift' | 'windows11' | 'macosx'
  touch_mode: detectTouchMode(),
  welcome_seen: false,
  welcome_tour_seen: false,
};

function applyToDocument(s, mode) {
  const theme = resolveTheme(mode || 'light');
  document.documentElement.dataset.theme = theme;
  if (s.accent_override) {
    document.documentElement.style.setProperty('--os-accent', s.accent_override);
  } else {
    document.documentElement.style.removeProperty('--os-accent');
  }
}

/**
 * OS settings. Loads from backend.settings on login, applies the resolved
 * theme to documentElement.dataset.theme and the accent override to
 * --os-accent.
 *
 * Theme mode ('light' | 'dark' | 'system') is a per-user, per-device
 * preference in localStorage; the backend visual_theme always holds the
 * *effective* theme ('daybreak' | 'nightshift') so Helm and backend
 * defaults stay consistent. When the mode is 'system', OS light/dark
 * changes are followed live via matchMedia.
 */
export function SettingsProvider({ children }) {
  const { user } = useAuth();
  const [settings, setSettings] = useState(DEFAULTS);
  const [themeMode, setThemeModeState] = useState('light');
  const [loading, setLoading] = useState(true);
  // Which user's settings are currently in `settings`. Guards against a
  // stale-DEFAULTS flash: on logout settings reset to DEFAULTS with
  // loading=false, and on the next login there's a window where the new
  // fetch hasn't completed yet. Consumers must check loadedUid === user.id
  // before acting on values like welcome_seen.
  const [loadedUid, setLoadedUid] = useState(null);
  const userRef = useRef(user);
  userRef.current = user;
  const themeModeRef = useRef('light');
  // Marks backend writes that originate from the theme-mode machinery
  // (mode picker / OS change follower) so they aren't reinterpreted as a
  // manual theme choice below.
  const systemWriteRef = useRef(false);

  const setMode = useCallback((m) => {
    themeModeRef.current = m;
    setThemeModeState(m);
  }, []);

  const updateSettings = useCallback(
    async (patch) => {
      try {
        const next = await backend.settings.update(patch);
        const merged = { ...DEFAULTS, ...next };
        if (patch && typeof patch.visual_theme === 'string' && !systemWriteRef.current) {
          // An explicit visual_theme write (theme picker elsewhere, Helm's
          // set_theme): treat it as a manual choice so 'system' mode can't
          // clobber it the next time the OS theme changes.
          const m = patch.visual_theme === 'nightshift' ? 'dark' : 'light';
          setMode(m);
          saveThemeMode(userRef.current?.id, m);
        }
        setSettings(merged);
        applyToDocument(merged, themeModeRef.current);
        return merged;
      } finally {
        systemWriteRef.current = false;
      }
    },
    [setMode]
  );

  useEffect(() => {
    let cancelled = false;
    const mode = loadThemeMode(user?.id);
    setMode(mode);
    if (!user) {
      setSettings(DEFAULTS);
      applyToDocument(DEFAULTS, mode);
      setLoadedUid(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    (async () => {
      try {
        const s = await backend.settings.get();
        if (cancelled) return;
        if (s) {
          const merged = { ...DEFAULTS, ...s };
          setSettings(merged);
          setLoadedUid(userRef.current?.id ?? null);
          applyToDocument(merged, mode);
          // Keep the stored effective theme in sync with the mode, so Helm
          // and other visual_theme readers see the real theme.
          const effective = resolveTheme(mode);
          if (merged.visual_theme !== effective) {
            try {
              const next = await backend.settings.update({ visual_theme: effective });
              if (!cancelled) {
                const synced = { ...DEFAULTS, ...next };
                setSettings(synced);
                applyToDocument(synced, mode);
              }
            } catch (e) {
              console.error('[drift] theme sync failed:', e);
            }
          }
        }
      } catch (e) {
        console.error('[drift] settings load failed:', e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user?.id, setMode]); // eslint-disable-line react-hooks/exhaustive-deps

  // Follow the OS light/dark setting while the theme mode is 'system'.
  useEffect(() => {
    let mq = null;
    try {
      mq = window.matchMedia('(prefers-color-scheme: dark)');
    } catch {
      return undefined;
    }
    if (!mq || typeof mq.addEventListener !== 'function') return undefined;
    const onChange = () => {
      if (themeModeRef.current !== 'system') return;
      systemWriteRef.current = true;
      updateSettings({ visual_theme: mq.matches ? 'nightshift' : 'daybreak' }).catch((e) =>
        console.error('[drift] system theme apply failed:', e)
      );
    };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [updateSettings]);

  /** Set the theme mode; resolves and persists the effective theme. */
  const setThemeMode = useCallback(
    async (mode) => {
      const m = THEME_MODES.includes(mode) ? mode : 'light';
      setMode(m);
      saveThemeMode(userRef.current?.id, m);
      systemWriteRef.current = true;
      await updateSettings({ visual_theme: resolveTheme(m) });
    },
    [updateSettings, setMode]
  );

  const value = {
    settings,
    loading,
    loadedUid,
    updateSettings,
    theme: settings.visual_theme,
    themeMode,
    setThemeMode,
  };
  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings() {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error('useSettings must be used inside <SettingsProvider>.');
  return ctx;
}
