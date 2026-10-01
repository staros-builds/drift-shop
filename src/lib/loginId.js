/**
 * Username -> synthetic email mapping for cloud auth.
 *
 * Cloud mode accepts bare usernames: we map them to a synthetic email on
 * the brand's reserved accounts domain (see brand.js) so Supabase auth works
 * unchanged. The user only ever sees their username.
 * Note: a `.local` domain is rejected by Supabase's email validation on
 * signup, so the domain must be a real-looking one (it never receives mail).
 *
 * Pure logic (unit-tested in test/login-id.test.mjs) — throws loud Errors
 * with .code instead of silently mangling bad input.
 */

import { BRAND } from './brand.js';

// Map a login identifier to the email Supabase auth expects.
// Bare usernames become <username>@<brand accounts domain>; anything
// containing '@' is treated as an email and passed through unchanged.
export function loginIdToEmail(identifier) {
  const id = identifier.trim();
  if (!id) {
    const e = new Error('username-required');
    e.code = 'username-required';
    throw e;
  }
  if (id.includes('@')) return id;
  // Validate: only allow letters/numbers/dots/underscores/dashes.
  // Reject loudly if the username contains anything else (spaces, emoji,
  // special chars) instead of silently stripping them — silent stripping
  // causes confusing collisions (e.g. "test user" and "test!user" both
  // becoming "testuser").
  const lower = id.toLowerCase();
  if (!/^[a-z0-9._-]+$/.test(lower)) {
    const e = new Error('username-invalid');
    e.code = 'username-invalid';
    throw e;
  }
  // Reject overlong usernames loudly instead of silently truncating —
  // silent truncation causes confusing collisions ("a"×64 vs "a"×79
  // becoming the same account).
  if (lower.length > 64) {
    const e = new Error('username-too-long');
    e.code = 'username-too-long';
    throw e;
  }
  const safe = lower.slice(0, 64);
  // A username that sanitizes to nothing (e.g. "!@#$") must not silently
  // collapse into a shared fallback identity — reject it loudly.
  if (!safe) {
    const e = new Error('username-invalid');
    e.code = 'username-invalid';
    throw e;
  }
  return `${safe}@${BRAND.accountsDomain}`;
}
