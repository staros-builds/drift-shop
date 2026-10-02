import { useCallback, useEffect, useRef, useState } from 'react';
import { KeyRound, Loader2, Lock, X } from 'lucide-react';
import POSApp from '../../apps/POSApp.jsx';
import { usePOSMode } from '../../os/POSModeContext.jsx';
import { backend } from '../../lib/backend/current.js';

/**
 * POS Mode overlay: covers the entire shell (taskbar included) and shows
 * ONLY the point of sale. Staff sign in with their staff PINs inside the POS
 * as usual. Exiting requires an owner/manager staff PIN — verified through
 * the backend, never stored on the device.
 *
 * The lock survives reloads (localStorage), so restarting the browser is
 * not a way around it. It is per-device: other signed-in devices stay
 * unlocked, which is also how a forgotten manager PIN gets reset
 * (POS → Team on another device).
 */

const PIN_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'];

function ExitPinDialog({ storeName, onClose, onUnlocked }) {
  const { posLock } = usePOSMode();
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const dialogRef = useRef(null);

  // Escape must NOT close this — that would hand employees an exit.
  // Focus the dialog when it opens.
  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  const submit = useCallback(
    async (value) => {
      const code = value ?? pin;
      if (!/^\d{4,8}$/.test(code) || busy) return;
      setBusy(true);
      setError('');
      try {
        const staff = await backend.pos.staffLogin(posLock.storeId, code);
        if (staff.role !== 'owner' && staff.role !== 'manager') {
          setError('That PIN belongs to a cashier. A manager or owner PIN is required to exit POS Mode.');
          setPin('');
          return;
        }
        onUnlocked();
      } catch (err) {
        setError(err?.message || 'Could not verify that PIN.');
        setPin('');
      } finally {
        setBusy(false);
      }
    },
    [pin, busy, posLock, onUnlocked]
  );

  const press = (d) => {
    if (busy) return;
    setError('');
    setPin((prev) => (prev + d).slice(0, 8));
  };

  return (
    <div
      className="fixed inset-0 z-[130] flex items-center justify-center bg-ink/50 p-4"
      onMouseDown={(e) => {
        // Backdrop clicks do NOT close: the register stays locked.
        e.stopPropagation();
      }}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Exit POS Mode"
        className="w-full max-w-xs rounded-os border border-osborder bg-surface p-5 shadow-win outline-none"
      >
        <div className="mb-1 flex items-center justify-center">
          <span className="flex h-11 w-11 items-center justify-center rounded-full bg-paper text-accent">
            <Lock size={20} />
          </span>
        </div>
        <h3 className="text-center text-sm font-semibold text-ink">Exit POS Mode</h3>
        <p className="mt-1 text-center text-xs text-muted">
          {storeName ? `${storeName} · ` : ''}Enter a manager or owner staff PIN to unlock this device.
        </p>

        <div className="mb-3 mt-4 flex justify-center gap-2" aria-label="PIN entry">
          {Array.from({ length: 8 }).map((_, i) => (
            <span
              key={i}
              className={`h-3 w-3 rounded-full border ${
                i < pin.length ? 'border-accent bg-accent' : 'border-osborder'
              }`}
            />
          ))}
        </div>

        <div className="grid grid-cols-3 gap-2">
          {PIN_KEYS.slice(0, 9).map((d) => (
            <button
              key={d}
              type="button"
              disabled={busy}
              onClick={() => press(d)}
              className="rounded-os border border-osborder bg-paper py-2.5 text-lg font-semibold text-ink hover:border-accent disabled:opacity-50"
            >
              {d}
            </button>
          ))}
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setPin('');
              setError('');
            }}
            aria-label="Clear PIN"
            className="flex items-center justify-center rounded-os border border-osborder bg-paper py-2.5 text-muted hover:border-accent hover:text-ink disabled:opacity-50"
          >
            <X size={18} />
          </button>
          <button
            key="0"
            type="button"
            disabled={busy}
            onClick={() => press('0')}
            className="rounded-os border border-osborder bg-paper py-2.5 text-lg font-semibold text-ink hover:border-accent disabled:opacity-50"
          >
            0
          </button>
          <button
            type="button"
            disabled={busy || pin.length < 4}
            onClick={() => submit()}
            aria-label="Unlock"
            className="flex items-center justify-center rounded-os bg-accent py-2.5 font-semibold text-accentink hover:opacity-90 disabled:opacity-50"
          >
            {busy ? <Loader2 size={18} className="animate-spin" /> : <KeyRound size={18} />}
          </button>
        </div>

        {error && (
          <p role="alert" className="mt-3 text-center text-xs font-medium text-red-700">
            {error}
          </p>
        )}
        <p className="mt-3 text-center text-[11px] leading-snug text-muted">
          Forgot the manager PIN? Reset it in POS → Team on another signed-in device.
        </p>
        <button
          type="button"
          onClick={onClose}
          className="mt-3 w-full rounded-os border border-osborder bg-paper py-2 text-xs font-medium text-muted hover:text-ink"
        >
          Back to register
        </button>
      </div>
    </div>
  );
}

export default function POSModeOverlay() {
  const { posLock, exitPOSMode } = usePOSMode();
  const [exitOpen, setExitOpen] = useState(false);

  if (!posLock) return null;

  return (
    <div className="absolute inset-0 z-[110]" data-pos-overlay="true" aria-label="POS Mode — register locked">
      <div className="h-full w-full">
        <POSApp kiosk kioskStoreId={posLock.storeId} />
      </div>

      {/* Subtle exit affordance: quiet until hovered, never in the way of sales. */}
      {!exitOpen && (
        <button
          type="button"
          onClick={() => setExitOpen(true)}
          title="Exit POS Mode (manager PIN required)"
          aria-label="Exit POS Mode (manager PIN required)"
          className="absolute bottom-3 right-3 flex items-center gap-1.5 rounded-full border border-osborder bg-surface/90 px-2.5 py-1.5 text-[11px] font-medium text-muted opacity-40 shadow-win backdrop-blur transition-opacity hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <Lock size={13} />
          <span className="hidden sm:inline">POS Mode</span>
        </button>
      )}

      {exitOpen && (
        <ExitPinDialog
          storeName={posLock.storeName}
          onClose={() => setExitOpen(false)}
          onUnlocked={exitPOSMode}
        />
      )}
    </div>
  );
}
