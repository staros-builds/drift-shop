import { createBackend } from './index.js';

// Singleton backend for the whole app.
//
// Drift Shop is cloud-only: the app always boots against the Supabase adapter.
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
