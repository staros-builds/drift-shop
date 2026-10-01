/**
 * Offline queue sync — drains queued operations when connectivity returns.
 *
 * Nuclear rule: a queued sale is a PROMISE. The system must keep that promise
 * automatically, without requiring the user to remember or manually retry.
 *
 * This module:
 * - Listens for 'online' events and queue changes
 * - Drains the queue one by one (in order, oldest first)
 * - Uses idempotency keys so retries are safe
 * - Marks failures with error info; user can retry or discard from the UI
 */

import { getQueue, dequeue, markFailed, isOnline } from './offlineQueue.js';

let syncing = false;
let syncListeners = [];

/**
 * Register a callback for sync status changes.
 * Callback receives: { syncing: bool, depth: number, lastError: string|null }
 */
export function onSyncStatus(callback) {
  syncListeners.push(callback);
  return () => {
    syncListeners = syncListeners.filter((cb) => cb !== callback);
  };
}

function notify(status) {
  for (const cb of syncListeners) {
    try {
      cb(status);
    } catch {}
  }
}

/**
 * Drain the queue. Each item is processed by the handler function.
 * Handler signature: async (item) => void (throws on failure)
 */
export async function syncQueue(handler) {
  if (syncing) return; // already syncing — don't start another
  if (!isOnline()) return; // offline — wait for connectivity

  syncing = true;
  notify({ syncing: true, depth: getQueue().length, lastError: null });

  try {
    let queue = getQueue();
    // Process oldest first (FIFO — sales must sync in order).
    queue.sort((a, b) => a.enqueuedAt - b.enqueuedAt);

    for (const item of queue) {
      // Re-check online before each item (might have dropped mid-sync).
      if (!isOnline()) break;

      try {
        await handler(item);
        // Success — remove from queue.
        dequeue(item.id);
        notify({ syncing: true, depth: getQueue().length, lastError: null });
      } catch (err) {
        // Failure — mark with error, continue to next item.
        // Don't block the whole queue on one bad item.
        markFailed(item.id, err?.message || 'Sync failed');
        notify({ syncing: true, depth: getQueue().length, lastError: err?.message });
        console.error('[driftshop] queue sync failed for item', item.id, err);
      }
    }
  } finally {
    syncing = false;
    notify({ syncing: false, depth: getQueue().length, lastError: null });
  }
}

/**
 * Start automatic sync. Call once at app boot.
 * - Syncs immediately if online and queue is non-empty
 * - Syncs on 'online' event
 * - Syncs when queue changes (new item added while online)
 *
 * NUCLEAR FAILSAFE: idempotent — calling startAutoSync twice does NOT
 * install duplicate listeners/intervals (the old code leaked a setInterval
 * and two window listeners per mount). Returns a stop() function for cleanup.
 */
let autoSyncStarted = false;
let autoSyncStop = null;
export function startAutoSync(handler) {
  if (autoSyncStarted) return autoSyncStop || (() => {});
  autoSyncStarted = true;

  const trySync = () => {
    if (isOnline() && getQueue().length > 0) {
      syncQueue(handler).catch(() => {});
    }
  };

  // Initial sync (in case queue has items from a previous session).
  // Delay 5s to let the app boot fully.
  const bootTimer = setTimeout(trySync, 5000);

  // Sync when we come back online.
  window.addEventListener('online', trySync);

  // Sync when a new item is queued (if we're online, process immediately).
  window.addEventListener('driftshop:queue-changed', trySync);

  // Periodic retry: every 60s, try to drain (catches items that failed).
  const retryTimer = setInterval(trySync, 60000);

  autoSyncStop = () => {
    clearTimeout(bootTimer);
    clearInterval(retryTimer);
    window.removeEventListener('online', trySync);
    window.removeEventListener('driftshop:queue-changed', trySync);
    autoSyncStarted = false;
    autoSyncStop = null;
  };
  return autoSyncStop;
}
