import { useCallback, useEffect } from 'react';
import { useWindows } from '../../os/WindowsContext.jsx';
import { usePOSMode } from '../../os/POSModeContext.jsx';
import { findShortcutForEvent, openSpotlight } from '../../os/shortcuts.js';

/**
 * Global keyboard shortcut layer. NOT wired into the tree; the coordinator
 * mounts it once inside the authenticated app root.
 *
 * Registers a single window keydown listener, ignores events originating
 * from inputs / textareas / contentEditable elements (except Escape, which
 * is left for the focused UI to handle), and dispatches the matching
 * SHORTCUTS action. Snap actions are defensive: they run only when the
 * WindowsContext exposes a snapWindow(id, dir) helper (typeof check), so
 * this component is safe to mount before snap lands.
 */

function isEditableTarget(target) {
  if (!target || typeof target.closest !== 'function') return false;
  if (target.isContentEditable) return true;
  const tag = (target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
  return !!target.closest('[contenteditable="true"]');
}

/** The focused window: highest z among non-minimized windows in this space. */
function focusedWindow(windows) {
  let best = null;
  for (const w of windows || []) {
    if (w.minimized) continue;
    if (!best || (w.z || 0) > (best.z || 0)) best = w;
  }
  return best;
}

const SNAP_DIR = { 'snap-left': 'left', 'snap-right': 'right', 'snap-max': 'max' };

export default function GlobalShortcuts() {
  const win = useWindows();
  const { isPOSLocked } = usePOSMode();

  const onKeyDown = useCallback(
    (e) => {
      // POS Mode: the register owns the keyboard. No Spotlight, no space
      // switching, no snapping — staff can't reach the rest of the system.
      if (isPOSLocked) return;

      // Never hijack typing; Escape is still allowed through so overlays
      // and menus keep their own Escape behavior.
      if (isEditableTarget(e.target) && e.key !== 'Escape') return;

      const shortcut = findShortcutForEvent(e, win);
      if (!shortcut) return;

      if (shortcut.action === 'spotlight') {
        e.preventDefault();
        openSpotlight();
        return;
      }

      const dir = SNAP_DIR[shortcut.action];
      if (dir) {
        // Defensive: requires() already filtered, but double-check before
        // calling — and only steal the key when there's a window to snap
        // (Alt+Left/Right is browser back/forward otherwise).
        if (typeof win.snapWindow !== 'function') return;
        const target = focusedWindow(win.visibleWindows);
        if (!target) return;
        e.preventDefault();
        try {
          win.snapWindow(target.id, dir);
        } catch {
          /* snapping must never throw out of a global handler */
        }
      }
    },
    [win, isPOSLocked]
  );

  useEffect(() => {
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onKeyDown]);

  return null;
}
