import React, { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '../../os/AuthContext.jsx';
import { useLang } from '../../lib/i18n.jsx';
import { createKonamiMatcher, isEditableTarget, UNLOCK_EVENT } from '../../lib/easterEgg.js';

/**
 * The hidden DUSKFALL easter egg.
 *
 * The game component is imported with a dynamic import() ONLY after
 * the secret trigger fires, so Vite emits it as its own chunk that
 * the boot bundle never fetches during normal use. The overlay is a
 * fixed layer rendered above the shell: the desktop/POS tree below
 * is never unmounted, so whatever the user was doing (an open POS
 * cart included) is exactly where they left it when the game closes.
 *
 * The game is fully sandboxed: it reads no shop data, calls no
 * backend, and keeps its high score in localStorage.
 */

// Lazy: this is the only reference to the game in the shell, and it
// is a dynamic import — Rollup splits it (plus the engine) into a
// separate chunk fetched on trigger only.
const DuskfallGame = React.lazy(() => import('../../apps/games/DuskfallGame.jsx'));

function useSecretTrigger(enabled, onUnlock) {
  const matcherRef = useRef(null);
  if (!matcherRef.current) matcherRef.current = createKonamiMatcher();

  useEffect(() => {
    if (!enabled) return undefined;
    const matcher = matcherRef.current;
    matcher.reset();
    const onKey = (e) => {
      if (e.defaultPrevented || e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
      if (isEditableTarget(e.target)) {
        matcher.reset();
        return;
      }
      if (matcher.feed(e.code)) onUnlock();
    };
    const onTapUnlock = () => onUnlock();
    window.addEventListener('keydown', onKey);
    window.addEventListener(UNLOCK_EVENT, onTapUnlock);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener(UNLOCK_EVENT, onTapUnlock);
    };
  }, [enabled, onUnlock]);
}

export default function EasterEggHost() {
  const { user, profile, accessChecked } = useAuth();
  const { t } = useLang();
  const [open, setOpen] = useState(false);
  const openRef = useRef(false);
  openRef.current = open;

  // Device kiosks (punch clock / locked POS terminals) never get the
  // trigger: kiosk shells already suppress all desktop chrome so no
  // shortcut can reach past them, and the game must never become an
  // escape hatch on a customer-facing terminal.
  const accountType = profile?.account_type || 'full';
  const kiosk = !!user && accessChecked && (accountType === 'punch' || accountType === 'pos');

  const unlock = useCallback(() => {
    if (!openRef.current) setOpen(true);
  }, []);
  const close = useCallback(() => setOpen(false), []);

  useSecretTrigger(!kiosk && !open && !profile?.must_change_password, unlock);

  // Attribute high scores to the signed-in user (the game reads this
  // id); guests play as 'guest'. localStorage only — no backend.
  useEffect(() => {
    if (open) {
      try {
        window.__driftUserId = user?.id || 'guest';
      } catch {
        /* noop */
      }
    }
  }, [open, user]);

  if (kiosk || !open) return null;

  return (
    <div
      className="fixed inset-0 z-[900]"
      role="dialog"
      aria-modal="true"
      aria-label="DUSKFALL"
      data-easter-egg="duskfall"
    >
      <Suspense
        fallback={
          <div className="flex h-full items-center justify-center bg-[#0b0708] text-sm text-[#a89880]">
            {t('egg.loading')}
          </div>
        }
      >
        <DuskfallGame onExit={close} />
      </Suspense>
    </div>
  );
}
