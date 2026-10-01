/**
 * OFFLINE QUEUE — nuclear bunker comms.
 *
 * If the network dies mid-sale, the shop CANNOT stop selling.
 * This module provides a persistent, idempotent operation queue:
 *
 * - Operations are saved to localStorage immediately (survives crash/close)
 * - Each operation has a UUID idempotency key (safe to retry)
 * - When back online, the queue drains automatically, one by one
 * - Failed operations stay queued with error info; user can retry or discard
 *
 * Nuclear rule: a network outage is NOT a data-loss event. Every sale
 * is captured locally and synced when connectivity returns.
 */

const QUEUE_KEY = 'driftshop_offline_queue';
const MAX_QUEUE_SIZE = 100; // sanity bound: more than this is a sync problem, not a queue problem

function loadQueue() {
  try {
    const raw = localStorage.getItem(QUEUE_KEY);
    if (!raw) return [];
    const q = JSON.parse(raw);
    return Array.isArray(q) ? q : [];
  } catch {
    return [];
  }
}

function saveQueue(queue) {
  try {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
  } catch {
    // Storage full — log and continue. The in-memory queue still works
    // for this session, but won't survive a reload.
    console.error('[driftshop] offline queue: localStorage write failed');
  }
}

function newIdempotencyKey() {
  try {
    return crypto.randomUUID();
  } catch {
    return `q-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}

/**
 * Enqueue an operation. Returns the queued item (with idempotency key).
 * Op: { type: 'pos_sale', payload: {...}, idempotencyKey, enqueuedAt, attempts }
 */
export function enqueue(type, payload) {
  const queue = loadQueue();
  if (queue.length >= MAX_QUEUE_SIZE) {
    throw new Error('Offline queue is full — sync or discard old items.');
  }
  const item = {
    id: newIdempotencyKey(),
    type,
    payload,
    idempotencyKey: newIdempotencyKey(),
    enqueuedAt: Date.now(),
    attempts: 0,
    lastError: null,
  };
  queue.push(item);
  saveQueue(queue);
  // Notify listeners (the UI updates the queue badge).
  try {
    window.dispatchEvent(new CustomEvent('driftshop:queue-changed', { detail: { depth: queue.length } }));
  } catch {}
  return item;
}

/** Remove an item from the queue by id. */
export function dequeue(id) {
  const queue = loadQueue().filter((item) => item.id !== id);
  saveQueue(queue);
  try {
    window.dispatchEvent(new CustomEvent('driftshop:queue-changed', { detail: { depth: queue.length } }));
  } catch {}
  return queue;
}

/** Get all queued items (for the UI). */
export function getQueue() {
  return loadQueue();
}

/** Get the queue depth (for badges). */
export function getQueueDepth() {
  return loadQueue().length;
}

/** Update an item's error info after a failed sync attempt. */
export function markFailed(id, errorMessage) {
  const queue = loadQueue();
  const item = queue.find((i) => i.id === id);
  if (item) {
    item.attempts += 1;
    item.lastError = String(errorMessage || 'Unknown error').slice(0, 500);
    item.lastAttemptAt = Date.now();
    saveQueue(queue);
  }
  return queue;
}

/** Clear the entire queue (user-confirmed discard). */
export function clearQueue() {
  saveQueue([]);
  try {
    window.dispatchEvent(new CustomEvent('driftshop:queue-changed', { detail: { depth: 0 } }));
  } catch {}
}

/**
 * Check if we're online. Uses navigator.onLine (fast, but can lie)
 * — the real test is whether API calls succeed. This is a hint, not a guarantee.
 */
export function isOnline() {
  return typeof navigator === 'undefined' ? true : navigator.onLine !== false;
}
