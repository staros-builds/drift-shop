import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Clock3, KeyRound, Loader2, Lock, LogOut, X } from 'lucide-react';
import POSApp from '../../apps/POSApp.jsx';
import { useAuth } from '../../os/AuthContext.jsx';
import { backend } from '../../lib/backend/current.js';
import { useLang } from '../../lib/i18n.jsx';

/**
 * Device kiosks: fullscreen, single-purpose screens for device accounts.
 *
 * A 'punch' account boots straight into PunchKiosk (clock in/out only).
 * A 'pos' account boots straight into POSKiosk (locked point of sale).
 * Neither renders the desktop, taskbar, Spotlight, or global shortcuts —
 * App.jsx withholds those chrome components for kiosk accounts.
 *
 * Exiting a kiosk always requires a manager/owner STAFF PIN (verified
 * server-side through pos_staff_login) and then signs the device account
 * out entirely — there is no desktop to "go back" to. Reloading the page
 * restores the same kiosk because the routing is driven by the account
 * type, not by client-side state.
 */

const PIN_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];

// How many wrong PINs before the pad itself cools down (the server enforces
// its own 15-failures-per-10-minutes throttle in migration 023 regardless).
const KIOSK_MAX_TRIES = 3;
const KIOSK_COOLDOWN_MS = 20_000;

function fmtTime(ts, lang) {
  try {
    return new Date(ts).toLocaleTimeString(lang === 'fr' ? 'fr-CA' : 'en-CA', {
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return '';
  }
}

function fmtDuration(ms, t) {
  const mins = Math.max(1, Math.round(ms / 60000));
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h === 0) return t('kiosk.minutes', { n: m });
  return t('kiosk.hoursMinutes', { h, m });
}

/* ---------------- shared PIN pad ---------------- */

function PinPad({ onSubmit, busy, disabled, autoFocusKey }) {
  const { t } = useLang();
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const wrapRef = useRef(null);

  useEffect(() => {
    setPin('');
    setError('');
    wrapRef.current?.querySelector('button')?.focus();
  }, [autoFocusKey]);

  const press = (d) => {
    if (busy || disabled) return;
    setError('');
    setPin((prev) => (prev + d).slice(0, 8));
  };

  const submit = async (value) => {
    const code = value ?? pin;
    if (!/^\d{4,8}$/.test(code) || busy || disabled) return;
    setError('');
    try {
      await onSubmit(code);
      setPin('');
    } catch (err) {
      setError(err?.message || t('kiosk.pinFailed'));
      setPin('');
    }
  };

  // Physical keyboards: digits type, Backspace deletes, Enter submits.
  const onKeyDown = (e) => {
    if (busy || disabled) return;
    if (/^[0-9]$/.test(e.key)) press(e.key);
    else if (e.key === 'Backspace') setPin((p) => p.slice(0, -1));
    else if (e.key === 'Enter') submit();
  };

  return (
    <div ref={wrapRef} onKeyDown={onKeyDown} className="w-full max-w-xs">
      <div className="mb-4 flex justify-center gap-2" aria-label={t('kiosk.pinEntry')}>
        {Array.from({ length: 8 }).map((_, i) => (
          <span
            key={i}
            className={`h-3.5 w-3.5 rounded-full border-2 ${
              i < pin.length ? 'border-accent bg-accent' : 'border-osborder'
            }`}
          />
        ))}
      </div>
      <div className="grid grid-cols-3 gap-2.5">
        {PIN_KEYS.map((d) => (
          <button
            key={d}
            type="button"
            disabled={busy || disabled}
            onClick={() => press(d)}
            className="rounded-os border border-osborder bg-paper py-4 text-2xl font-semibold text-ink duration-160 hover:border-accent disabled:opacity-50"
          >
            {d}
          </button>
        ))}
        <button
          type="button"
          disabled={busy || disabled}
          onClick={() => {
            setPin('');
            setError('');
          }}
          aria-label={t('kiosk.clear')}
          className="flex items-center justify-center rounded-os border border-osborder bg-paper py-4 text-muted duration-160 hover:border-accent hover:text-ink disabled:opacity-50"
        >
          <X size={22} />
        </button>
        <button
          key="0"
          type="button"
          disabled={busy || disabled}
          onClick={() => press('0')}
          className="rounded-os border border-osborder bg-paper py-4 text-2xl font-semibold text-ink duration-160 hover:border-accent disabled:opacity-50"
        >
          0
        </button>
        <button
          type="button"
          disabled={busy || disabled || pin.length < 4}
          onClick={() => submit()}
          aria-label={t('kiosk.ok')}
          className="flex items-center justify-center rounded-os bg-accent py-4 font-semibold text-accentink duration-160 hover:opacity-90 disabled:opacity-50"
        >
          {busy ? <Loader2 size={22} className="animate-spin" /> : <Check size={22} />}
        </button>
      </div>
      {error && (
        <p role="alert" className="mt-3 text-center text-sm font-medium text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}

/* ---------------- manager-PIN exit dialog ---------------- */

function KioskExitDialog({ storeId, storeName, onClose, onUnlocked }) {
  const { t } = useLang();
  const [busy, setBusy] = useState(false);
  const dialogRef = useRef(null);

  // Escape must NOT close this — that would hand staff an exit.
  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  const submit = useCallback(
    async (code) => {
      if (busy) return;
      setBusy(true);
      try {
        const staff = await backend.pos.staffLogin(storeId, code);
        if (staff.role !== 'owner' && staff.role !== 'manager') {
          throw new Error(t('kiosk.exitNotManager'));
        }
        onUnlocked();
      } finally {
        setBusy(false);
      }
    },
    [busy, storeId, onUnlocked, t]
  );

  return (
    <div
      className="fixed inset-0 z-[130] flex items-center justify-center bg-ink/60 p-4"
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={t('kiosk.exitTitle')}
        className="flex w-full max-w-xs flex-col items-center rounded-os border border-osborder bg-surface p-5 shadow-win outline-none"
      >
        <span className="flex h-11 w-11 items-center justify-center rounded-full bg-paper text-accent">
          <Lock size={20} />
        </span>
        <h3 className="mt-2 text-sm font-semibold text-ink">{t('kiosk.exitTitle')}</h3>
        <p className="mt-1 text-center text-xs text-muted">
          {storeName ? `${storeName} · ` : ''}
          {t('kiosk.exitHint')}
        </p>
        <div className="mt-4 w-full">
          <PinPad onSubmit={submit} busy={busy} autoFocusKey={storeId} />
        </div>
        <button
          type="button"
          onClick={onClose}
          className="mt-4 w-full rounded-os border border-osborder bg-paper py-2 text-xs font-medium text-muted duration-160 hover:text-ink"
        >
          {t('kiosk.back')}
        </button>
      </div>
    </div>
  );
}

/* ---------------- store resolution ---------------- */

function useKioskStore() {
  const { profile } = useAuth();
  const [store, setStore] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await backend.pos.listStores();
        if (cancelled) return;
        const wanted = profile?.device_store_id;
        const found = (list || []).find((s) => s.id === wanted) || (list || [])[0] || null;
        if (!found) {
          setError('no-store');
        } else {
          setStore(found);
        }
      } catch (err) {
        if (!cancelled) setError(err?.message || 'Could not load the shop.');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [profile?.device_store_id]);

  return { store, error };
}

function KioskShell({ icon, title, subtitle, children, onExit }) {
  const { t } = useLang();
  const [exitOpen, setExitOpen] = useState(false);
  return (
    <div className="relative flex h-full flex-col bg-surface text-ink" data-kiosk="true">
      <header className="flex items-center gap-3 border-b border-osborder px-5 py-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-full bg-accent/15 text-accent">
          {icon}
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-base font-semibold">{title}</h1>
          {subtitle && <p className="truncate text-xs text-muted">{subtitle}</p>}
        </div>
        <ClockTick />
      </header>
      <main className="flex min-h-0 flex-1 flex-col items-center justify-center gap-5 overflow-y-auto p-6">
        {children}
      </main>
      {!exitOpen && (
        <button
          type="button"
          onClick={() => setExitOpen(true)}
          title={t('kiosk.exitTitle')}
          aria-label={t('kiosk.exitTitle')}
          className="absolute bottom-3 right-3 flex items-center gap-1.5 rounded-full border border-osborder bg-surface/90 px-2.5 py-1.5 text-[11px] font-medium text-muted opacity-40 shadow-win backdrop-blur transition-opacity hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <LogOut size={13} />
        </button>
      )}
      {exitOpen && (
        <KioskExit
          onClose={() => setExitOpen(false)}
          onExit={onExit}
        />
      )}
    </div>
  );
}

// Small wrapper so the exit dialog always gets the resolved store.
function KioskExit({ onClose, onExit }) {
  const { store } = useKioskStore();
  const { signOut } = useAuth();
  const [signingOut, setSigningOut] = useState(false);
  if (!store || signingOut) {
    return (
      <div className="fixed inset-0 z-[130] flex items-center justify-center bg-ink/60 p-4">
        <Loader2 size={24} className="animate-spin text-paper" />
      </div>
    );
  }
  return (
    <KioskExitDialog
      storeId={store.id}
      storeName={store.name}
      onClose={onClose}
      onUnlocked={async () => {
        setSigningOut(true);
        try {
          await onExit();
        } finally {
          await signOut();
        }
      }}
    />
  );
}

function ClockTick() {
  const { lang } = useLang();
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 10000);
    return () => clearInterval(id);
  }, []);
  return (
    <p className="shrink-0 text-sm font-medium tabular-nums text-muted">
      {now.toLocaleTimeString(lang === 'fr' ? 'fr-CA' : 'en-CA', {
        hour: 'numeric',
        minute: '2-digit',
      })}
    </p>
  );
}

/* ---------------- punch kiosk ---------------- */

export function PunchKiosk() {
  const { t, lang } = useLang();
  const { store, error } = useKioskStore();
  const [phase, setPhase] = useState('pin'); // pin | working | done
  const [who, setWho] = useState(null); // { id, name, role, pinHash }
  const [openPunch, setOpenPunch] = useState(null);
  const [result, setResult] = useState(null); // { action: 'in'|'out', at, durationMs }
  const [busy, setBusy] = useState(false);
  const [failures, setFailures] = useState(0);
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const resetTimer = useRef(null);

  const cooledDown = Date.now() < cooldownUntil;

  // The cooldown is time-based: without this timer the screen would stay
  // stuck on "wait a moment" after the period ends, because nothing else
  // re-renders. Wake up just after expiry so the PIN pad unlocks on its own.
  const [, setNow] = useState(0);
  useEffect(() => {
    if (!cooldownUntil) return;
    const ms = cooldownUntil - Date.now();
    if (ms <= 0) return;
    const id = setTimeout(() => setNow(Date.now()), ms + 50);
    return () => clearTimeout(id);
  }, [cooldownUntil]);

  const backToPin = useCallback(() => {
    setWho(null);
    setOpenPunch(null);
    setResult(null);
    setPhase('pin');
  }, []);

  // After a successful punch, show the confirmation, then reset for the
  // next person. The timer is cleared on unmount or on manual reset.
  useEffect(() => () => clearTimeout(resetTimer.current), []);
  const scheduleReset = useCallback(() => {
    clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(backToPin, 6000);
  }, [backToPin]);

  const verifyPin = async (code) => {
    if (!store) throw new Error(t('kiosk.noStore'));
    if (cooledDown) throw new Error(t('kiosk.cooldown'));
    setBusy(true);
    try {
      const staff = await backend.pos.staffLogin(store.id, code);
      setFailures(0);
      const open = await backend.pos.getOpenPunch(store.id, staff.id).catch(() => null);
      setWho(staff);
      setOpenPunch(open);
      setPhase('working');
    } catch (err) {
      const n = failures + 1;
      setFailures(n);
      if (n >= KIOSK_MAX_TRIES) {
        setCooldownUntil(Date.now() + KIOSK_COOLDOWN_MS);
        setFailures(0);
      }
      throw err;
    } finally {
      setBusy(false);
    }
  };

  const punch = async () => {
    if (!who || !store || busy) return;
    setBusy(true);
    try {
      if (openPunch) {
        const done = await backend.pos.clockOut(store.id, who.pinHash);
        const at = done?.punchOut || new Date().toISOString();
        const ms = new Date(at).getTime() - new Date(openPunch.punchIn).getTime();
        setResult({ action: 'out', at, durationMs: ms });
      } else {
        const started = await backend.pos.clockIn(store.id, who.pinHash);
        setResult({ action: 'in', at: started?.punchIn || new Date().toISOString(), durationMs: 0 });
      }
      setPhase('done');
      scheduleReset();
    } catch (err) {
      // The server is the source of truth (e.g. "already punched in"):
      // surface its verdict and refresh the status instead of guessing.
      const open = await backend.pos.getOpenPunch(store.id, who.id).catch(() => openPunch);
      setOpenPunch(open);
      throw err;
    } finally {
      setBusy(false);
    }
  };

  if (error) {
    return (
      <KioskShell
        icon={<Clock3 size={20} />}
        title={t('kiosk.punchTitle')}
        onExit={() => {}}
      >
        <p role="alert" className="max-w-xs text-center text-sm text-red-700">
          {error === 'no-store' ? t('kiosk.noStore') : error}
        </p>
      </KioskShell>
    );
  }
  if (!store) {
    return (
      <KioskShell
        icon={<Clock3 size={20} />}
        title={t('kiosk.punchTitle')}
        onExit={() => {}}
      >
        <Loader2 size={28} className="animate-spin text-muted" />
      </KioskShell>
    );
  }

  return (
    <KioskShell
      icon={<Clock3 size={20} />}
      title={store.name}
      subtitle={t('kiosk.punchTitle')}
      onExit={() => {}}
    >
      {phase === 'pin' && (
        <>
          <p className="max-w-xs text-center text-sm text-muted">{t('kiosk.enterPin')}</p>
          {cooledDown ? (
            <p role="alert" className="max-w-xs text-center text-sm font-medium text-red-700">
              {t('kiosk.cooldown')}
            </p>
          ) : (
            <PinPad onSubmit={verifyPin} busy={busy} autoFocusKey={failures} />
          )}
        </>
      )}

      {phase === 'working' && who && (
        <PunchAction
          who={who}
          openPunch={openPunch}
          busy={busy}
          onPunch={punch}
          onSwitch={backToPin}
        />
      )}

      {phase === 'done' && result && who && (
        <div className="flex w-full max-w-xs flex-col items-center text-center">
          <span
            className={`flex h-16 w-16 items-center justify-center rounded-full ${
              result.action === 'in' ? 'bg-green-500/15 text-green-700' : 'bg-accent/15 text-accent'
            }`}
          >
            {result.action === 'in' ? <Check size={30} /> : <LogOut size={26} />}
          </span>
          <h2 className="mt-3 text-lg font-semibold">
            {result.action === 'in'
              ? t('kiosk.clockedIn', { name: who.name })
              : t('kiosk.clockedOut', { name: who.name })}
          </h2>
          <p className="mt-1 text-sm text-muted">
            {fmtTime(result.at, lang)}
            {result.action === 'out' && result.durationMs > 0 && (
              <> · {fmtDuration(result.durationMs, t)}</>
            )}
          </p>
          <button
            type="button"
            onClick={backToPin}
            className="mt-5 rounded-os border border-osborder bg-paper px-4 py-2 text-xs font-medium text-ink duration-160 hover:border-accent"
          >
            {t('kiosk.nextPerson')}
          </button>
        </div>
      )}
    </KioskShell>
  );
}

function PunchAction({ who, openPunch, busy, onPunch, onSwitch }) {
  const { t, lang } = useLang();
  const [error, setError] = useState('');
  const clockedIn = !!openPunch;

  const go = async () => {
    setError('');
    try {
      await onPunch();
    } catch (err) {
      setError(err?.message || t('kiosk.punchFailed'));
    }
  };

  return (
    <div className="flex w-full max-w-xs flex-col items-center text-center">
      <p className="text-sm text-muted">{t('kiosk.hi')}</p>
      <h2 className="mt-1 text-2xl font-semibold">{who.name}</h2>
      {clockedIn && openPunch?.punchIn && (
        <p className="mt-1 text-sm text-muted">
          {t('kiosk.since', { time: fmtTime(openPunch.punchIn, lang) })}
        </p>
      )}
      <button
        type="button"
        disabled={busy}
        onClick={go}
        className={`mt-6 w-full rounded-os py-5 text-xl font-bold text-white shadow-win duration-160 hover:opacity-90 disabled:opacity-50 ${
          clockedIn ? 'bg-accent' : 'bg-green-600'
        }`}
      >
        {busy ? (
          <Loader2 size={26} className="mx-auto animate-spin" />
        ) : clockedIn ? (
          t('kiosk.clockOut')
        ) : (
          t('kiosk.clockIn')
        )}
      </button>
      {error && (
        <p role="alert" className="mt-3 text-sm font-medium text-red-700">
          {error}
        </p>
      )}
      <button
        type="button"
        onClick={onSwitch}
        className="mt-4 text-xs font-medium text-muted underline-offset-2 hover:text-ink hover:underline"
      >
        {t('kiosk.notYou')}
      </button>
    </div>
  );
}

/* ---------------- POS kiosk ---------------- */

export function POSKiosk() {
  const { t } = useLang();
  const { store, error } = useKioskStore();

  if (error || !store) {
    return (
      <KioskShell
        icon={<KeyRound size={20} />}
        title={t('kiosk.posTitle')}
        onExit={() => {}}
      >
        {error ? (
          <p role="alert" className="max-w-xs text-center text-sm text-red-700">
            {error === 'no-store' ? t('kiosk.noStore') : error}
          </p>
        ) : (
          <Loader2 size={28} className="animate-spin text-muted" />
        )}
      </KioskShell>
    );
  }

  // POSApp already knows kiosk mode (fixed store, no switching, no manager
  // chrome). The exit affordance lives here so the register never unlocks
  // itself: a manager/owner staff PIN signs the device account out.
  return (
    <div className="h-full w-full" data-kiosk="true">
      <POSApp kiosk kioskStoreId={store.id} />
      <KioskExitButton />
    </div>
  );
}

function KioskExitButton() {
  const { t } = useLang();
  const [exitOpen, setExitOpen] = useState(false);
  return (
    <>
      {!exitOpen && (
        <button
          type="button"
          onClick={() => setExitOpen(true)}
          title={t('kiosk.exitTitle')}
          aria-label={t('kiosk.exitTitle')}
          className="absolute bottom-3 right-3 z-[105] flex items-center gap-1.5 rounded-full border border-osborder bg-surface/90 px-2.5 py-1.5 text-[11px] font-medium text-muted opacity-40 shadow-win backdrop-blur transition-opacity hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <Lock size={13} />
          <span className="hidden sm:inline">{t('kiosk.posMode')}</span>
        </button>
      )}
      {exitOpen && <KioskExit onClose={() => setExitOpen(false)} onExit={() => {}} />}
    </>
  );
}
