import React, { useEffect, useRef, useState } from 'react';
import { backend } from './lib/backend/current.js';
import { LanguageProvider, useLang } from './lib/i18n.jsx';
import { AuthProvider, useAuth } from './os/AuthContext.jsx';
import { SettingsProvider } from './os/SettingsContext.jsx';
import { NotificationsProvider } from './os/NotificationsContext.jsx';
import { SystemHealthProvider } from './os/SystemHealthContext.jsx';
import { ToastProvider, useToasts } from './os/ToastContext.jsx';
import { POSModeProvider } from './os/POSModeContext.jsx';
import { WindowsProvider } from './os/WindowsContext.jsx';
import Spotlight from './components/os/Spotlight.jsx';
import GlobalShortcuts from './components/os/GlobalShortcuts.jsx';
import BootScreen from './components/os/BootScreen.jsx';
import LoginScreen, { SetNewPasswordScreen, ForcePasswordChangeModal } from './components/os/LoginScreen.jsx';
import Desktop from './components/os/Desktop.jsx';
import { PunchKiosk, POSKiosk } from './components/os/DeviceKiosks.jsx';
import Window from './components/os/Window.jsx';
import TouchHome, { TouchStatusBar } from './components/os/TouchHome.jsx';
import { useWindows } from './os/WindowsContext.jsx';
import { useSettings } from './os/SettingsContext.jsx';
import RootErrorBoundary, { getCrashCount, recordCleanBoot } from './components/os/RootErrorBoundary.jsx';
import SafeModeScreen from './components/os/SafeModeScreen.jsx';

// Crash-loop SCRAM threshold: if the app crashed this many times in a row,
// boot into safe mode instead of attempting a normal boot.
const SAFE_MODE_THRESHOLD = 3;

// Touch mode shell: iOS-style status bar + home screen, with apps opening
// fullscreen above it. Tapping the home indicator closes the top app.
function TouchShell() {
  const { visibleWindows, closeWindow } = useWindows();
  const open = visibleWindows.filter((w) => !w.minimized);
  const top = open.length ? open.reduce((a, b) => (b.z > a.z ? b : a)) : null;

  return (
    <div className="fixed inset-0 flex flex-col bg-paper text-ink">
      <TouchStatusBar />
      <div className="relative min-h-0 flex-1">
        <div className="absolute inset-0">
          <TouchHome />
        </div>
        {open.map((win) => (
          <Window key={win.id} win={win} />
        ))}
        {top && (
          <button
            type="button"
            aria-label="Back to home screen"
            onClick={() => closeWindow(top.id)}
            className="absolute inset-x-0 bottom-0 z-[600] flex h-11 items-end justify-center pb-2"
          >
            <span className="h-1.5 w-36 rounded-full bg-ink/40" />
          </button>
        )}
      </div>
    </div>
  );
}

// Boot state machine: boot -> (session? desktop : login).
// Every screen here is real: BootScreen performs actual backend init and
// session restore; LoginScreen performs real auth; Desktop is the OS.
//
// Device accounts never see the desktop: a 'punch' account boots straight
// into the punch-pad kiosk and a 'pos' account into the locked point of
// sale. The routing is driven by the account type on the profile, so a
// page reload restores the same kiosk — there is no client-side state to
// clear as an escape route.
function Shell() {
  const { user, loading, profile, accessChecked, authEpoch } = useAuth();
  const { settings } = useSettings();
  const [booted, setBooted] = useState(false);
  const [recovery, setRecovery] = useState(false);

  // Password-reset email landing: consume ?code= (or #type=recovery), and
  // honor the pending flag from an earlier landing, so the user is forced
  // through the choose-a-new-password screen instead of the desktop.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let want = false;
      try {
        const url = new URL(window.location.href);
        if (url.searchParams.has('code') || (url.hash || '').includes('type=recovery')) {
          want = await backend.auth.consumeRecoveryCode();
        } else {
          want = backend.auth.recoveryPending();
        }
      } catch {
        want = false;
      }
      if (!cancelled) setRecovery(want);
    })();
    return () => { cancelled = true; };
  }, []);

  if (!booted || loading) {
    return <BootScreen onDone={() => setBooted(true)} />;
  }
  if (recovery && user) {
    return <SetNewPasswordScreen onDone={() => setRecovery(false)} />;
  }
  if (!user) {
    // Key on the auth epoch so every sign-out remounts the login screen
    // with empty credential fields (no retained password).
    return <LoginScreen key={`login-${authEpoch}`} />;
  }
  if (!accessChecked) {
    // The profile (and its account_type) is still loading — never flash the
    // wrong shell. If the read failed, accessChecked is still set and we
    // fail open to the desktop below, exactly as before.
    return (
      <div className="flex h-full items-center justify-center bg-surface text-sm text-muted">
        Loading…
      </div>
    );
  }
  const accountType = profile?.account_type || 'full';
  // Forced first-login password change (master account seeded by migration
  // 056, or any account an admin flags): blocking, non-dismissible. The
  // modal clears the flag through the auth context on success, so the
  // shell simply proceeds past this gate.
  if (profile?.must_change_password) {
    return <ForcePasswordChangeModal onDone={() => {}} />;
  }
  if (accountType === 'punch') {
    return <PunchKiosk />;
  }
  if (accountType === 'pos') {
    return <POSKiosk />;
  }
  if (settings?.touch_mode) {
    return <TouchShell />;
  }
  return <Desktop />;
}

// AppUpdateCheck: Drift Shop is a static deploy — a new publish only changes the
// bundle filename referenced by index.html. Poll the freshly-served
// index.html (cache-busted so the service worker can't hand back a stale
// copy) and toast when the live bundle differs from the booted one, so
// terminals pick up new builds with one tap instead of a manual hard
// refresh. Silent when offline.
function AppUpdateCheck() {
  const { t } = useLang();
  const { pushToast } = useToasts();
  const announcedRef = useRef(null);
  useEffect(() => {
    let cancelled = false;
    const currentScript = document.querySelector('script[src*="assets/index-"]');
    const currentFile = currentScript?.getAttribute('src')?.split('/').pop() || '';
    const check = async () => {
      try {
        const res = await fetch(`index.html?__driftshop_build=${Date.now()}`, { cache: 'no-store' });
        if (!res.ok || cancelled) return;
        const html = await res.text();
        const m = html.match(/assets\/index-([A-Za-z0-9_-]+)\.js/);
        if (!m) return;
        const liveFile = `index-${m[1]}.js`;
        if (currentFile && liveFile !== currentFile && announcedRef.current !== liveFile) {
          announcedRef.current = liveFile;
          pushToast({
            title: t('app.updateAvailableTitle'),
            message: t('app.updateAvailableMsg'),
            actionLabel: t('app.refreshNow'),
            onAction: () => window.location.reload(),
            timeoutMs: 120000,
          });
        }
      } catch {
        // Offline or unreachable — the service worker serves the cached
        // shell; say nothing and try again later.
      }
    };
    check();
    const id = setInterval(check, 5 * 60 * 1000);
    const onVisible = () => {
      if (document.visibilityState === 'visible') check();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [pushToast, t]);
  return null;
}

// Chrome around the Shell: device kiosks get no desktop chrome at all —
// no Spotlight, no global shortcuts — so keyboard shortcuts can't be used
// to reach past the kiosk. (The browser's own shortcuts are outside what a
// web page can lock down; unattended tablets should use the OS guided
// access / kiosk mode for that layer.)
function Chrome() {
  const { user, profile, accessChecked } = useAuth();
  const accountType = profile?.account_type || 'full';
  const kiosk = !!user && accessChecked && (accountType === 'punch' || accountType === 'pos');
  return (
    <WindowsProvider>
      <Shell />
      {!kiosk && <Spotlight />}
      {!kiosk && <GlobalShortcuts />}
    </WindowsProvider>
  );
}

export default function App() {
  const [backendNote] = useState(() => backend.note);

  useEffect(() => {
    if (backendNote) {
      // Surface backend degradation honestly in the console; the Desktop
      // shows it in About/Settings too.
      console.info('[drift] backend:', backendNote);
    }
  }, [backendNote]);

  // NUCLEAR SCRAM: if the app has crashed on boot repeatedly, do NOT attempt
  // a normal boot (it would just crash again). Render the minimal safe-mode
  // recovery screen instead. The user can try normal mode or clear data.
  const [safeMode] = useState(() => {
    try {
      return getCrashCount() >= SAFE_MODE_THRESHOLD;
    } catch {
      return false;
    }
  });

  // If we boot successfully and stay up for 5 seconds, the crash loop is
  // over — reset the counter. This runs only in normal (non-safe) mode.
  useEffect(() => {
    if (safeMode) return;
    const timer = setTimeout(() => {
      recordCleanBoot();
    }, 5000);
    return () => clearTimeout(timer);
  }, [safeMode]);

  if (safeMode) {
    return (
      <LanguageProvider>
        <SafeModeScreen />
      </LanguageProvider>
    );
  }

  return (
    <LanguageProvider>
    <RootErrorBoundary>
    <ToastProvider>
    <AppUpdateCheck />
    <POSModeProvider>
    <AuthProvider>
      <SettingsProvider>
        <NotificationsProvider>
          <SystemHealthProvider>
          <Chrome />
          </SystemHealthProvider>
        </NotificationsProvider>
      </SettingsProvider>
    </AuthProvider>
    </POSModeProvider>
    </ToastProvider>
    </RootErrorBoundary>
    </LanguageProvider>
  );
}
