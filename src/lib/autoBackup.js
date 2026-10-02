/**
 * AUTO-BACKUP — snapshot before destructive actions.
 *
 * Nuclear rule: a destructive action (void a gift card, delete a punch,
 * factory reset) must never be the moment data becomes unrecoverable.
 * This module takes a one-call, best-effort snapshot of the store's data
 * BEFORE the action runs, using the existing exportStore() mechanism
 * (the same dump the manual backup produces).
 *
 * CLOUD-ONLY CONTRACT: snapshots live IN MEMORY ONLY — a session-scoped
 * ring of at most 3. Nothing is written to localStorage or anywhere else
 * on this device: the cloud database is the only data store, and an
 * un-downloaded snapshot vanishes the moment this session ends. The real
 * protection is the owner's downloaded backup file; factory reset's
 * safety net is the auto-downloaded account backup (which aborts the
 * reset if it fails), not this session cache.
 *
 * Everything here is best-effort and time-boxed: a backup that fails or
 * times out must NEVER block the action it protects.
 */

import { backend } from './backend/current.js';

const LEGACY_SNAP_KEY = 'driftshop_auto_backups';
try {
  // Purge any snapshot ring stored by older builds: business data must not
  // live on this device.
  localStorage.removeItem(LEGACY_SNAP_KEY);
} catch {
  /* storage unavailable — nothing to purge */
}

const MAX_SNAPS = 3; // ring buffer: oldest snapshot is evicted
const SNAPSHOT_TIMEOUT_MS = 15000;
const FRESH_ENOUGH_MS = 5 * 60 * 1000; // skip if a fresh snapshot already exists

// Session-only store. Never persisted — this dies with the tab.
const sessionSnaps = [];

function withTimeout(promise, ms, label) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * Take a snapshot of a store's data right now. Returns the snapshot
 * descriptor { label, at, tables } or null if it failed (never throws).
 * The snapshot is kept only in memory for this session.
 */
export async function snapshotStore(storeId, label) {
  if (!storeId) return null;
  try {
    const dump = await withTimeout(
      backend.pos.exportStore(storeId),
      SNAPSHOT_TIMEOUT_MS,
      'auto-backup exportStore'
    );
    const snap = {
      label: String(label || 'auto-backup'),
      at: new Date().toISOString(),
      storeId,
      dump,
    };
    sessionSnaps.push(snap);
    while (sessionSnaps.length > MAX_SNAPS) sessionSnaps.shift();
    console.info(`[driftshop] auto-backup: session snapshot "${snap.label}" saved`);
    return snap;
  } catch (err) {
    // Best-effort: a failed snapshot must not block the action it protects.
    console.warn('[driftshop] auto-backup snapshot failed:', err?.message || err);
    return null;
  }
}

/**
 * Snapshot before a destructive action, skipping when a fresh snapshot
 * already exists (so rapid successive deletes don't each pay for an export).
 * Never throws; never blocks the caller longer than the timeout.
 */
export async function snapshotBeforeDestructive(storeId, label) {
  try {
    const latest = sessionSnaps[sessionSnaps.length - 1];
    if (latest && latest.storeId === storeId && Date.now() - new Date(latest.at).getTime() < FRESH_ENOUGH_MS) {
      return latest;
    }
  } catch {}
  return snapshotStore(storeId, label);
}

/** List saved auto-backup snapshots (newest last). Never throws. */
export function listAutoBackups() {
  try {
    return sessionSnaps.map((s) => ({ label: s.label, at: s.at, storeId: s.storeId }));
  } catch {
    return [];
  }
}

/**
 * Download one snapshot as a JSON file (same shape as exportStore, so the
 * existing importStore restore path can consume it). Index counts from the
 * oldest (0) — use listAutoBackups() to pick.
 */
export function downloadAutoBackup(index) {
  const snap = sessionSnaps[index];
  if (!snap) throw new Error('No such auto-backup snapshot.');
  const blob = new Blob([JSON.stringify(snap.dump, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = `driftshop-auto-backup-${snap.storeId}-${snap.at.slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
  return snap;
}

/** Discard all auto-backup snapshots held in this session. */
export function clearAutoBackups() {
  sessionSnaps.length = 0;
}
