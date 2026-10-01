import React, { createContext, useContext, useEffect, useState, useCallback, useRef } from 'react';
import { backend } from '../lib/backend/current.js';
import { useAuth } from './AuthContext.jsx';
import { getQueueDepth } from '../lib/offlineQueue.js';
import { getCrashCount } from '../components/os/RootErrorBoundary.jsx';

const SystemHealthContext = createContext(null);

/**
 * System health self-check. Runs lightweight checks against the backend
 * on mount and every 60 seconds, exposing a tri-state status:
 *
 * - 'ok'      (green):  all checks pass — no issues detected
 * - 'warning' (orange): non-critical degradation (slow response, etc.)
 * - 'error'   (red):    critical failure — backend unreachable, auth expired, etc.
 *
 * Checks:
 * 1. backend.reachable — can we talk to Supabase at all?
 * 2. auth.session     — is there a valid session?
 * 3. db.read         — can we read a core table?
 * 4. queue.depth     — offline queue depth (nuclear failsafe)
 * 5. storage.write   — localStorage writable? (nuclear failsafe)
 * 6. crashes.recent  — crash loop detected? (nuclear failsafe)
 *
 * The taskbar renders a colored dot; clicking it opens a detail panel.
 */

const CHECK_INTERVAL_MS = 60000;
const SLOW_THRESHOLD_MS = 3000;

async function checkBackend() {
  const start = Date.now();
  try {
    // Lightweight: ask the backend for its own note/status. Falls back to
    // a raw Supabase ping if the backend doesn't expose one.
    if (backend.ping) {
      await backend.ping();
    } else if (backend.supabase) {
      const { error } = await backend.supabase.from('profiles').select('id').limit(1);
      if (error) throw error;
    } else {
      // No backend handle — try a minimal fetch to the Supabase URL if known.
      throw new Error('no backend handle');
    }
    const ms = Date.now() - start;
    return { ok: true, ms, slow: ms > SLOW_THRESHOLD_MS };
  } catch (e) {
    return { ok: false, ms: Date.now() - start, error: e?.message || String(e) };
  }
}

async function checkAuth() {
  try {
    if (backend?.supabase?.auth?.getSession) {
      const { data, error } = await backend.supabase.auth.getSession();
      if (error) throw error;
      const session = data?.session;
      if (!session) return { ok: false, error: 'no session' };
      // Flag sessions expiring within 5 minutes as a warning.
      const expiresAt = session.expires_at ? session.expires_at * 1000 : 0;
      const msLeft = expiresAt - Date.now();
      if (msLeft > 0 && msLeft < 5 * 60 * 1000) {
        return { ok: true, warning: 'session expiring soon', msLeft };
      }
      return { ok: true };
    }
    // Backend without a supabase handle — can't check, treat as unknown-ok.
    return { ok: true, skipped: true };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

async function checkDbRead() {
  const start = Date.now();
  try {
    if (backend?.supabase) {
      // Read one row from a core table the app always needs.
      const { error } = await backend.supabase.from('pos_stores').select('id').limit(1);
      if (error) throw error;
      return { ok: true, ms: Date.now() - start };
    }
    return { ok: true, skipped: true };
  } catch (e) {
    return { ok: false, ms: Date.now() - start, error: e?.message || String(e) };
  }
}

// NUCLEAR FAILSAFE: check offline queue depth. Queued sales are a promise
// the system must keep — surface them in health status.
function checkQueue() {
  try {
    const depth = getQueueDepth();
    if (depth > 0) {
      return { ok: true, warning: `${depth} sale(s) queued offline`, depth };
    }
    return { ok: true, depth: 0 };
  } catch {
    return { ok: true, skipped: true };
  }
}

// NUCLEAR FAILSAFE: check localStorage health. If we can't write, cart
// recovery and offline queue are broken — that's a critical failure.
function checkStorage() {
  try {
    const key = 'lfdd_health_probe';
    localStorage.setItem(key, '1');
    localStorage.removeItem(key);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: 'localStorage unavailable: ' + (e?.message || String(e)) };
  }
}

// NUCLEAR FAILSAFE: check crash loop status. If we've crashed recently,
// the user should know the system is in a degraded state.
function checkCrashLoop() {
  try {
    const count = getCrashCount();
    if (count >= 2) {
      return { ok: true, warning: `${count} recent crashes detected`, count };
    }
    return { ok: true, count: 0 };
  } catch {
    return { ok: true, skipped: true };
  }
}

function deriveStatus(results) {
  // Any critical failure -> error. Any warning/slow -> warning. Else ok.
  const hasError = Object.values(results).some((r) => r && r.ok === false);
  if (hasError) return 'error';
  const hasWarning =
    Object.values(results).some((r) => r && (r.warning || r.slow));
  if (hasWarning) return 'warning';
  return 'ok';
}

export function SystemHealthProvider({ children }) {
  const { user } = useAuth();
  const [results, setResults] = useState(null);
  const [status, setStatus] = useState('ok');
  const [lastChecked, setLastChecked] = useState(null);
  const [checking, setChecking] = useState(false);
  const mountedRef = useRef(true);

  const runChecks = useCallback(async () => {
    if (!mountedRef.current) return;
    setChecking(true);
    try {
      const [backendRes, authRes, dbRes] = await Promise.all([
        checkBackend(),
        checkAuth(),
        checkDbRead(),
      ]);
      // NUCLEAR FAILSAFE: synchronous local checks (queue, storage, crashes).
      const queueRes = checkQueue();
      const storageRes = checkStorage();
      const crashRes = checkCrashLoop();
      if (!mountedRef.current) return;
      const next = {
        backend: backendRes,
        auth: authRes,
        db: dbRes,
        queue: queueRes,
        storage: storageRes,
        crashes: crashRes,
      };
      setResults(next);
      setStatus(deriveStatus(next));
      setLastChecked(new Date());
    } finally {
      if (mountedRef.current) setChecking(false);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    runChecks();
    const t = setInterval(runChecks, CHECK_INTERVAL_MS);
    // Re-check when the tab regains focus — catches sleep/wake disconnects.
    const onFocus = () => runChecks();
    const onOnline = () => runChecks();
    window.addEventListener('focus', onFocus);
    window.addEventListener('online', onOnline);
    return () => {
      mountedRef.current = false;
      clearInterval(t);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('online', onOnline);
    };
  }, [runChecks]);

  // Re-run when the user changes (login/logout invalidates auth check).
  useEffect(() => {
    runChecks();
  }, [user?.id, runChecks]); // eslint-disable-line react-hooks/exhaustive-deps

  const value = {
    status,       // 'ok' | 'warning' | 'error'
    results,      // { backend, auth, db } detail objects
    lastChecked,  // Date | null
    checking,     // bool — a check run is in flight
    refresh: runChecks,
  };

  return (
    <SystemHealthContext.Provider value={value}>
      {children}
    </SystemHealthContext.Provider>
  );
}

export function useSystemHealth() {
  const ctx = useContext(SystemHealthContext);
  if (!ctx) throw new Error('useSystemHealth must be used inside SystemHealthProvider');
  return ctx;
}

/** Human-readable status metadata (colors live in the component). */
export const HEALTH_META = {
  ok:      { dot: '#22c55e', labelKey: 'health.ok' },
  warning: { dot: '#f59e0b', labelKey: 'health.warning' },
  error:   { dot: '#ef4444', labelKey: 'health.error' },
};
