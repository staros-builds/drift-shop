/**
 * Operation timeout — nuclear failsafe.
 *
 * No backend operation may hang forever. If the network stalls, the server
 * hangs, or a promise never resolves, the user gets a clear timeout error
 * after N seconds instead of an infinite spinner.
 *
 * Nuclear rule: a hung operation is indistinguishable from a crashed one
 * to the user. Both must fail fast with a clear message and a retry path.
 */

const DEFAULT_TIMEOUT_MS = 30000; // 30s: generous for slow networks, finite for sanity

/**
 * Race a promise against a timeout. If the timeout wins, reject with a
 * clear, localizable error (the caller maps it to t('err.timeout')).
 */
export function withTimeout(promise, ms = DEFAULT_TIMEOUT_MS, label = 'operation') {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`TIMEOUT:${label}:${ms}`));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * Check if an error is a timeout (from withTimeout).
 */
export function isTimeoutError(err) {
  return err?.message?.startsWith('TIMEOUT:') || false;
}

/**
 * Get a user-friendly timeout message key.
 */
export function timeoutMessageKey(err) {
  return isTimeoutError(err) ? 'err.timeout' : null;
}
