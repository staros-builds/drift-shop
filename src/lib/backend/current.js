import { createBackend, buildDefaultBackendConfig } from './index.js';
import {
  backendDirectoryUrlFromEnv,
  loadBackendDirectory,
  resolveBackendForSlug,
} from './directory.js';

// Singleton backend for the whole app.
//
// Vendra is cloud-only: the app always boots against the Supabase adapter.
// The old Cloud / This device toggle has been removed — there is one login,
// one user list, and data follows the account on every device.
//
// Every module imports this singleton.

export const backend = createBackend('supabase');
export const backendKind = backend.kind;

/**
 * Always 'cloud'. Kept so callers that display the mode keep working.
 */
export function getBackendMode() {
  return 'cloud';
}

/* ------------------------------------------------------------------ */
/* Backend directory groundwork (scale)                                */
/*                                                                     */
/* backendForSlug() is the future entry point for sharding: once a   */
/* backend directory is configured (VITE_BACKEND_DIRECTORY_URL       */
/* pointing at a static JSON, see ./directory.js), a shop's public   */
/* storefront page can be served by whichever project holds that      */
/* shop. Until then — and for every slug the directory does not       */
/* know — it returns the singleton above, so nothing behaves          */
/* differently today. Adapters for non-default backends are created   */
/* once and cached by backend id. NOT wired into any screen yet:      */
/* StorefrontPublic still reads through the singleton.                */
/* ------------------------------------------------------------------ */

function envValue(name) {
  try {
    return import.meta.env?.[name] ?? null;
  } catch {
    return null;
  }
}

let directoryPromise = null;
function loadConfiguredDirectory() {
  if (!directoryPromise) {
    const url = backendDirectoryUrlFromEnv({
      VITE_BACKEND_DIRECTORY_URL: envValue('VITE_BACKEND_DIRECTORY_URL'),
    });
    directoryPromise = url ? loadBackendDirectory(url) : Promise.resolve(null);
  }
  return directoryPromise;
}

const slugBackendCache = new Map();

/**
 * The backend adapter that serves one shop's storefront slug. With no
 * directory configured (today, everywhere) this is the singleton.
 */
export async function backendForSlug(slug) {
  const directory = await loadConfiguredDirectory();
  if (!directory) return backend;
  const fallback = buildDefaultBackendConfig();
  const resolved = resolveBackendForSlug(slug, directory, fallback);
  if (resolved.source === 'build-default' || !resolved.url || !resolved.anonKey) {
    return backend;
  }
  const cached = slugBackendCache.get(resolved.backendId);
  if (cached) return cached;
  const created = createBackend('supabase', { url: resolved.url, key: resolved.anonKey });
  slugBackendCache.set(resolved.backendId, created);
  return created;
}
