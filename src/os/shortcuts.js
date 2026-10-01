import { backend } from '../lib/backend/current.js';
import { getApp } from '../apps/registry.jsx';

/* ============================================================================
 * Drift keyboard shortcut layer + shared search helpers.
 *
 * SHORTCUTS is the single source of truth for the OS-level shortcuts that
 * GlobalShortcuts dispatches. HelpApp imports this list so the docs never
 * drift from the implementation.
 *
 * Entry shape: { id, keys, keysMac, description, action, combo, requires? }
 *   - keys/keysMac: human-readable combo ("Ctrl+K" / "⌘K").
 *   - action: stable id dispatched by GlobalShortcuts.
 *   - combo: { key, ctrlOrCmd?: bool, alt?: bool, shift?: bool } matched
 *     against the KeyboardEvent. Letters are matched case-insensitively.
 *   - requires(winCtx)? : optional predicate against the useWindows() value.
 *     Entries whose requires() fails are treated as unbound (no dispatch,
 *     hidden from Help) — used for features another agent may add later.
 *
 * Also home to the shared bounded file scan + open-routing used by
 * Spotlight and the Start menu.
 * ========================================================================== */

const hasSnap = (win) => win && typeof win.snapWindow === 'function';

export const SHORTCUTS = [
  {
    id: 'spotlight',
    keys: 'Ctrl+K',
    keysMac: '⌘K',
    description: 'Open global search',
    action: 'spotlight',
    combo: { key: 'k', ctrlOrCmd: true },
  },
  {
    id: 'snap-left',
    keys: 'Alt+Left',
    keysMac: '⌥←',
    description: 'Snap the focused window to the left half',
    action: 'snap-left',
    combo: { key: 'ArrowLeft', alt: true },
    requires: hasSnap,
  },
  {
    id: 'snap-right',
    keys: 'Alt+Right',
    keysMac: '⌥→',
    description: 'Snap the focused window to the right half',
    action: 'snap-right',
    combo: { key: 'ArrowRight', alt: true },
    requires: hasSnap,
  },
  {
    id: 'snap-max',
    keys: 'Alt+Up',
    keysMac: '⌥↑',
    description: 'Maximize the focused window',
    action: 'snap-max',
    combo: { key: 'ArrowUp', alt: true },
    requires: hasSnap,
  },
];

/** Custom event fired when the spotlight shortcut is pressed. */
export const SPOTLIGHT_EVENT = 'drift:open-spotlight';

export function openSpotlight() {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(SPOTLIGHT_EVENT));
  }
}

function comboMatches(e, combo) {
  if (!combo) return false;
  const wantKey = String(combo.key);
  const gotKey = String(e.key || '');
  const keyOk =
    wantKey.length === 1 ? gotKey.toLowerCase() === wantKey.toLowerCase() : gotKey === wantKey;
  if (!keyOk) return false;
  if (combo.ctrlOrCmd) {
    return (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey;
  }
  return (
    !!e.altKey === !!combo.alt &&
    !!e.shiftKey === !!combo.shift &&
    !e.ctrlKey &&
    !e.metaKey
  );
}

/**
 * Find the shortcut entry matching a keydown event. `winCtx` is the
 * useWindows() value (or anything the `requires` predicates inspect);
 * entries whose requires() fails are skipped. Returns null when nothing
 * matches.
 */
export function findShortcutForEvent(e, winCtx) {
  if (!e) return null;
  for (const s of SHORTCUTS) {
    if (!comboMatches(e, s.combo)) continue;
    if (typeof s.requires === 'function' && !s.requires(winCtx)) continue;
    return s;
  }
  return null;
}

/** Subset of SHORTCUTS that are currently available (for Help docs). */
export function availableShortcuts(winCtx) {
  return SHORTCUTS.filter((s) => typeof s.requires !== 'function' || s.requires(winCtx));
}

/* ------------------------------------------------------------------ */
/* Shared search helpers (Spotlight + Start menu)                      */
/* ------------------------------------------------------------------ */

/**
 * Bounded recursive file scan for search. Breadth-first from '/', capped
 * at maxDepth levels and maxTotal entries scanned, returning at most
 * maxResults matches (name substring, case-insensitive — folders too).
 * Backend failures are swallowed: the caller decides how to present the
 * absence of file results.
 */
export async function searchFiles(query, { maxDepth = 4, maxTotal = 200, maxResults = 12 } = {}) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];
  const results = [];
  let scanned = 0;
  const queue = [{ path: '/', depth: 0 }];
  while (queue.length > 0 && scanned < maxTotal && results.length < maxResults) {
    const { path, depth } = queue.shift();
    let children;
    try {
      children = await backend.files.list(path);
    } catch {
      continue; // quiet skip — a dead branch must not kill the scan
    }
    if (!Array.isArray(children)) continue;
    for (const child of children) {
      if (scanned >= maxTotal || results.length >= maxResults) break;
      scanned += 1;
      if (child && typeof child.name === 'string' && child.name.toLowerCase().includes(q)) {
        results.push(child);
      }
      if (child && child.type === 'folder' && depth < maxDepth) {
        queue.push({ path: child.path, depth: depth + 1 });
      }
    }
  }
  return results;
}

/** App id for a file path, following FilesApp's openEntry routing. */
export function appIdForPath(path) {
  const lower = String(path || '').toLowerCase();
  if (lower.endsWith('.drift-doc')) return 'writer';
  if (lower.endsWith('.drift-sheet')) return 'sheets';
  if (lower.endsWith('.drift-slides')) return 'slides';
  if (/\.(png|jpe?g|gif|webp|bmp|svg|avif|ico)$/.test(lower)) return 'pictures';
  if (/\.(mp4|webm|ogv|mov|mkv|avi|m4v)$/.test(lower)) return 'video';
  if (/\.(mp3|wav|ogg|oga|m4a|flac|opus|weba)$/.test(lower)) return 'music';
  if (/\.pdf$/.test(lower)) return 'pdfviewer';
  return null;
}

/**
 * Open a file entry with the right app (mirrors FilesApp.openEntry).
 * Folders and anything without a dedicated app fall back to Files.
 * Unknown/unregistered app ids (e.g. pdfviewer before it's added) also
 * fall back to Files instead of throwing.
 */
export function openFileWithApp(entry, openWindow) {
  if (!entry || typeof openWindow !== 'function') return;
  if (entry.type === 'folder') {
    openWindow('files');
    return;
  }
  const appId = appIdForPath(entry.path);
  if (appId) {
    try {
      const app = getApp(appId);
      if (!app.comingSoon && app.component) {
        openWindow(appId, { path: entry.path });
        return;
      }
    } catch {
      /* unknown app id — fall through to Files */
    }
  }
  openWindow('files');
}

/** Small presentational helper: an icon-agnostic label for a pin result. */
export function pinLabel(pin) {
  if (!pin) return 'Untitled pin';
  if (pin.title && String(pin.title).trim()) return String(pin.title);
  const body = String(pin.body || '').trim();
  if (body) return body.length > 80 ? `${body.slice(0, 80)}…` : body;
  if (pin.url) return String(pin.url);
  return 'Untitled pin';
}
