/**
 * AUTO-BACKUP — snapshot before destructive actions.
 *
 * Nuclear rule: a destructive action (void a gift card, delete a punch,
 * factory reset) must never be the moment data becomes unrecoverable.
 * This module takes a one-call, best-effort snapshot of the store's data
 * BEFORE the action runs, using the existing exportStore() mechanism
 * (the same dump the manual backup produces).
 *
 * Snapshots are kept device-local in localStorage, bounded to the last
 * few, so they never grow without limit. They are a safety net, not a
 * replacement for the manual "Download account backup" in Settings.
 *
 * Everything here is best-effort and time-boxed: a backup that fails or
 * times out must NEVER block the action it protects.
 */

import { backend } from './backend/current.js';
import { BRAND } from './brand.js';

const SNAP_KEY = `${BRAND.storagePrefix}_auto_backups`;
const MAX_SNAPS = 3; // ring buffer: oldest snapshot is evicted
const SNAPSHOT_TIMEOUT_MS = 15000;
const FRESH_ENOUGH_MS = 5 * 60 * 1000; // skip if a fresh snapshot already exists

function loadSnaps() {
  try {
    const raw = localStorage.getItem(SNAP_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function storeSnaps(snaps) {
  const slim = snaps.slice(-MAX_SNAPS);
  const payload = JSON.stringify(slim);
  try {
    localStorage.setItem(SNAP_KEY, payload);
  } catch (err) {
    // Quota exceeded — drop the oldest and retry once; if that fails,
    // the snapshot is skipped (the action still proceeds).
    try {
      localStorage.setItem(SNAP_KEY, JSON.stringify(slim.slice(-1)));
    } catch {
      console.warn('[driftshop] auto-backup: localStorage full, snapshot skipped');
    }
  }
  return slim;
}

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
    const snaps = loadSnaps();
    snaps.push(snap);
    storeSnaps(snaps);
    console.info(`[driftshop] auto-backup: snapshot "${snap.label}" saved`);
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
    const snaps = loadSnaps();
    const latest = snaps[snaps.length - 1];
    if (latest && latest.storeId === storeId && Date.now() - new Date(latest.at).getTime() < FRESH_ENOUGH_MS) {
      return latest;
    }
  } catch {}
  return snapshotStore(storeId, label);
}

/** List saved auto-backup snapshots (newest last). Never throws. */
export function listAutoBackups() {
  try {
    return loadSnaps().map((s) => ({ label: s.label, at: s.at, storeId: s.storeId }));
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
  const snaps = loadSnaps();
  const snap = snaps[index];
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

/** Discard all auto-backup snapshots on this device. */
export function clearAutoBackups() {
  try {
    localStorage.removeItem(SNAP_KEY);
  } catch {}
}
