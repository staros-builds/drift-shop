import { createContext, useCallback, useContext, useMemo, useState } from 'react';

/**
 * POS Mode (register lockdown) state.
 *
 * When a shop owner locks a device into POS Mode, the whole Vendra shell is
 * covered by a fullscreen overlay that shows ONLY the point of sale. Staff
 * sign in with their staff PINs inside the POS as usual; everything else —
 * desktop, taskbar, Start menu, Spotlight, spaces, global shortcuts — is
 * unreachable until a manager/owner staff PIN unlocks it.
 *
 * The lock is per-device (localStorage) on purpose: locking the counter
 * tablet must not lock the owner's phone, and a forgotten manager PIN can
 * always be reset from POS → Team on another signed-in device.
 */

const POS_LOCK_KEY = 'drift:pos_lock';

const POSModeContext = createContext(null);

function readLock() {
  try {
    const raw = localStorage.getItem(POS_LOCK_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.storeId !== 'string' || !parsed.storeId) return null;
    return {
      storeId: parsed.storeId,
      storeName: typeof parsed.storeName === 'string' ? parsed.storeName : '',
      enteredAt: typeof parsed.enteredAt === 'number' ? parsed.enteredAt : Date.now(),
    };
  } catch {
    // localStorage unavailable (private mode) — no lock can persist.
    return null;
  }
}

export function POSModeProvider({ children }) {
  const [posLock, setPosLock] = useState(readLock);

  const enterPOSMode = useCallback((storeId, storeName) => {
    const lock = {
      storeId,
      storeName: storeName || '',
      enteredAt: Date.now(),
    };
    try {
      localStorage.setItem(POS_LOCK_KEY, JSON.stringify(lock));
    } catch {
      // Storage blocked — the in-memory lock still holds for this session.
    }
    setPosLock(lock);
  }, []);

  const exitPOSMode = useCallback(() => {
    try {
      localStorage.removeItem(POS_LOCK_KEY);
    } catch {
      /* already gone or storage blocked */
    }
    setPosLock(null);
  }, []);

  const value = useMemo(
    () => ({ posLock, isPOSLocked: !!posLock, enterPOSMode, exitPOSMode }),
    [posLock, enterPOSMode, exitPOSMode]
  );

  return <POSModeContext.Provider value={value}>{children}</POSModeContext.Provider>;
}

export function usePOSMode() {
  const ctx = useContext(POSModeContext);
  if (!ctx) throw new Error('usePOSMode must be used inside <POSModeProvider>');
  return ctx;
}
