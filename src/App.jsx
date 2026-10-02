import React, { useCallback, useEffect, useRef, useState } from 'react';
import { backend } from './lib/backend/current.js';
import { licenseGateDecision } from './lib/licensing.js';
import { LanguageProvider, useLang } from './lib/i18n.jsx';
import { AuthProvider, useAuth } from './os/AuthContext.jsx';
import { SettingsProvider } from './os/SettingsContext.jsx';
import { NotificationsProvider } from './os/NotificationsContext.jsx';
import { SystemHealthProvider } from './os/SystemHealthContext.jsx';
import { ToastProvider, useToasts } from './os/ToastContext.jsx';
import { isUpdateBlocked, isUpdateSnoozed, snoozeUpdate } from './lib/updateGuard.js';
import { POSModeProvider } from './os/POSModeContext.jsx';
import { WindowsProvider } from './os/WindowsContext.jsx';
import Spotlight from './components/os/Spotlight.jsx';
import GlobalShortcuts from './components/os/GlobalShortcuts.jsx';
import EasterEggHost from './components/os/EasterEgg.jsx';
import BootScreen from './components/os/BootScreen.jsx';
import LoginScreen, { SetNewPasswordScreen, ForcePasswordChangeModal } from './components/os/LoginScreen.jsx';
import Desktop from './components/os/Desktop.jsx';
import { PunchKiosk, POSKiosk } from './components/os/DeviceKiosks.jsx';
import Window from './components/os/Window.jsx';
import TouchHome, { TouchStatusBar } from './components/os/TouchHome.jsx';
import { useWindows } from './os/WindowsContext.jsx';
import { useSettings } from './os/SettingsContext.jsx';
import RootErrorBoundary, { getCrashCount, recordCleanBoot } from './components/os/RootErrorBoundary.jsx';
import AppErrorBoundary from './components/os/AppErrorBoundary.jsx';
import SafeModeScreen from './components/os/SafeModeScreen.jsx';
import LicenseLockScreen from './components/LicenseLockScreen.jsx';

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
// License gate (licensing 072): after the access checks, a signed-in
// user whose shops are ALL locked (trial over, no active key) lands on
// the lock screen instead of their shell. They stay signed in: unlock,
// support and backup download all live on that screen. The check FAILS
// OPEN — a hiccup reading status must never lock out a working shop;
// the database itself still refuses sales for a truly locked shop
// (pos_sales_license_guard). Master/admin accounts are never gated.
function useLicenseGate(profile) {
  const [decision, setDecision] = useState(null); // null = first check pending
  const profileRef = useRef(profile);
  profileRef.current = profile;

  const refresh = useCallback(async () => {
    try {
      if (typeof backend.license?.myStatus !== 'function') {
        setDecision({ locked: false });
        return;
      }
      const rows = await backend.license.myStatus();
      setDecision(licenseGateDecision(rows, profileRef.current));
    } catch {
      setDecision((prev) => prev ?? { locked: false });
    }
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 60_000);
    const onVis = () => {
      if (!document.hidden) refresh();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [refresh]);

  return { decision, refresh };
}

function Shell() {
  const { user, loading, profile, accessChecked, authEpoch, signOut } = useAuth();
  const { settings } = useSettings();
  const [booted, setBooted] = useState(false);
  const [recovery, setRecovery] = useState(false);
  const license = useLicenseGate(profile);

  // Auth email landing (one login, 2026-10-01): consumeAuthCallback routes
  // every email-link landing — signup confirmations (owner → desktop/shop
  // setup; customer → back to the shop page) and password resets (forced
  // new-password screen). Also honors the recovery-pending flag from an
  // earlier landing.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let wantRecovery = false;
      try {
        const res = await backend.auth.consumeAuthCallback();
        if (res && res.kind === 'recovery') {
          wantRecovery = true;
        } else if (res && res.kind === 'confirmed') {
          const flow = res.flow || {};
          if (flow.kind === 'customer' && flow.slug) {
            // Customer confirmed: back to the shop page. Full navigation so
            // main.jsx boots the storefront route on the way in.
            const base = import.meta.env?.BASE_URL || '/';
            const root = window.location.origin + (base.endsWith('/') ? base : base + '/');
            window.location.replace(root + '#/store/' + encodeURIComponent(flow.slug));
            return;
          }
          // Owner confirmed: the session is active; the shell below proceeds
          // to the desktop (setup access) once the auth listener settles.
        } else if (!res || res.kind === 'none') {
          wantRecovery = backend.auth.recoveryPending();
        }
      } catch {
        wantRecovery = false;
      }
      if (!cancelled) setRecovery(wantRecovery);
    })();
    return () => { cancelled = true; };
  }, []);

  if (!booted || loading) {
    return <BootScreen onDone={() => setBooted(true)} />;
  }
  if (recovery && user) {
    return (
      <AppErrorBoundary label="password reset">
        <SetNewPasswordScreen onDone={() => setRecovery(false)} />
      </AppErrorBoundary>
    );
  }
  if (!user) {
    // Key on the auth epoch so every sign-out remounts the login screen
    // with empty credential fields (no retained password). The per-region
    // boundary keeps a login-screen crash from taking down the shell —
    // the root boundary is the last resort, not the first.
    return (
      <AppErrorBoundary label="login">
        <LoginScreen key={`login-${authEpoch}`} />
      </AppErrorBoundary>
    );
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
    return (
      <AppErrorBoundary label="password change">
        <ForcePasswordChangeModal onDone={() => {}} />
      </AppErrorBoundary>
    );
  }
  // License lock (see useLicenseGate). Placed after the password gate
  // and before every shell — including the kiosks: a locked shop's
  // till lands here too, and the database blocks its sales regardless.
  if (license.decision === null) {
    return (
      <div className="flex h-full items-center justify-center bg-surface text-sm text-muted">
        Loading…
      </div>
    );
  }
  if (license.decision.locked) {
    return (
      <AppErrorBoundary label="license lock">
        <LicenseLockScreen
          stores={license.decision.stores}
          onUnlocked={license.refresh}
          onSignOut={signOut}
        />
      </AppErrorBoundary>
    );
  }
  if (accountType === 'punch') {
    return (
      <AppErrorBoundary label="punch kiosk">
        <PunchKiosk />
      </AppErrorBoundary>
    );
  }
  if (accountType === 'pos') {
    return (
      <AppErrorBoundary label="POS kiosk">
        <POSKiosk />
      </AppErrorBoundary>
    );
  }
  if (settings?.touch_mode) {
    return <TouchShell />;
  }
  return <Desktop />;
}

// AppUpdateCheck: Vendra is a static deploy — a new publish only changes the
// bundle filename referenced by index.html. Poll the freshly-served
// index.html (cache-busted so the service worker can't hand back a stale
// copy) and react when the live bundle differs from the booted one.
// Silent when offline.
//
// Safe-moment auto-update (owner rule): when a new build appears AND
// nothing is in progress (no sale recording, no restore running, no
// non-empty cart anywhere — see lib/updateGuard.js), the app updates
// ITSELF after a short announced countdown. Otherwise it offers the
// manual refresh toast and keeps re-checking until the moment turns
// safe. "Later" snoozes auto-apply for that build for the session —
// the forced-update escape hatch; the manual path always remains.
function AppUpdateCheck() {
  const { t } = useLang();
  const { pushToast } = useToasts();
  const announcedRef = useRef(null);
  const pendingRef = useRef(null); // live build id waiting for a safe moment
  useEffect(() => {
    let cancelled = false;
    const currentScript = document.querySelector('script[src*="assets/index-"]');
    const currentFile = currentScript?.getAttribute('src')?.split('/').pop() || '';

    const tryApply = () => {
      const liveFile = pendingRef.current;
      if (!liveFile || cancelled) return;
      if (isUpdateSnoozed(liveFile)) return; // escape hatch
      if (isUpdateBlocked()) return; // wait for a safe moment
      window.location.reload();
    };

    const check = async () => {
      try {
        const res = await fetch(`index.html?__driftshop_build=${Date.now()}`, { cache: 'no-store' });
        if (!res.ok || cancelled) return;
        const html = await res.text();
        const m = html.match(/assets\/index-([A-Za-z0-9_-]+)\.js/);
        if (!m) return;
        const liveFile = `index-${m[1]}.js`;
        if (!currentFile || liveFile === currentFile) return;
        pendingRef.current = liveFile;
        if (announcedRef.current === liveFile) {
          tryApply();
          return;
        }
        announcedRef.current = liveFile;
        if (!isUpdateBlocked() && !isUpdateSnoozed(liveFile)) {
          // Safe right now: announce, then let tryApply fire on the
          // next ticks (2s grace in case work starts this instant).
          pushToast({
            title: t('app.updateAutoTitle'),
            message: t('app.updateAutoMsg'),
            actionLabel: t('app.updateLater'),
            onAction: () => snoozeUpdate(liveFile),
            timeoutMs: 15000,
          });
          setTimeout(tryApply, 2000);
          setTimeout(tryApply, 8000);
        } else {
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
    // While an update waits for a safe moment, re-check every 20s so it
    // lands promptly once the till/cart/restore frees up.
    const fastId = setInterval(() => {
      if (pendingRef.current) tryApply();
    }, 20 * 1000);
    const onVisible = () => {
      if (document.visibilityState === 'visible') check();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      clearInterval(id);
      clearInterval(fastId);
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
      {/* Hidden easter egg (Konami / Settings-About taps). The host
          self-suppresses on device kiosks even if chrome is on. */}
      <EasterEggHost />
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
