/**
 * Email-independent account recovery — pure client logic, no imports of
 * app state, unit-testable.
 *
 * Three recovery paths, none of which need email:
 *
 *  1. Recovery codes: the signed-in user generates N one-time codes, saves
 *     them somewhere safe, and can later redeem one (logged out) to set a
 *     new password. Codes are SHA-256 hashed client-side before insert, so
 *     the server only ever stores hashes. Each code is single-use.
 *  2. Security questions: the user picks 3 questions and answers. Answers
 *     are normalized (lowercase, trimmed, collapsed whitespace), salted,
 *     and SHA-256 hashed client-side; the server re-hashes at redeem time
 *     with the stored salt.
 *  3. Shop-owner assisted reset: a store owner/manager resets a team
 *     member's password directly (server RPC enforces the relationship).
 *
 * Code format: 12 characters from an unambiguous 32-char alphabet
 * (no 0/O, 1/I/L), grouped XXXX-XXXX-XXXX for readability. 12 chars ×
 * 5 bits = 60 bits of entropy; combined with the server's 10-attempts-
 * per-15-minutes rate limit, brute force is infeasible.
 */

import { sha256hex } from './sha256.js';

// Unambiguous alphabet: no 0/O, 1/I/L, 2/Z confusion pairs.
export const RECOVERY_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ3456789';
export const RECOVERY_CODE_LENGTH = 12;
export const RECOVERY_CODE_COUNT = 8;
export const SECURITY_QUESTION_COUNT = 3;

/** Generate one recovery code, e.g. "XK7D-Q2M9-PL4Z". */
export function generateRecoveryCode(randFn) {
  const rand = randFn || defaultRandomBytes;
  const bytes = rand(RECOVERY_CODE_LENGTH);
  let raw = '';
  for (let i = 0; i < RECOVERY_CODE_LENGTH; i++) {
    raw += RECOVERY_CODE_ALPHABET[bytes[i] % RECOVERY_CODE_ALPHABET.length];
  }
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
}

/** Generate a set of unique recovery codes. */
export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT, randFn) {
  const codes = new Set();
  let guard = 0;
  while (codes.size < count && guard < count * 50) {
    codes.add(generateRecoveryCode(randFn));
    guard++;
  }
  return [...codes];
}

function defaultRandomBytes(n) {
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    return crypto.getRandomValues(new Uint8Array(n));
  }
  // Non-secure fallback (should never happen in a browser build); the
  // server-side rate limit still bounds guessing.
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.floor(Math.random() * 256);
  return out;
}

/**
 * Normalize a user-typed code for comparison: strip dashes/spaces,
 * uppercase. "xk7d q2m9 pl4z" -> "XK7DQ2M9PL4Z".
 */
export function normalizeRecoveryCode(input) {
  return String(input ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** True when the input looks like a well-formed recovery code. */
export function isPlausibleRecoveryCode(input) {
  const n = normalizeRecoveryCode(input);
  if (n.length !== RECOVERY_CODE_LENGTH) return false;
  return [...n].every((ch) => RECOVERY_CODE_ALPHABET.includes(ch));
}

/** SHA-256 hex of the normalized code (what gets stored server-side). */
export async function hashRecoveryCode(code) {
  return sha256hex(normalizeRecoveryCode(code));
}

/** 16 random bytes as hex — per-user salt for security answers. */
export function generateSalt(randFn) {
  const rand = randFn || defaultRandomBytes;
  const bytes = rand(16);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Normalize a security answer exactly like the server does:
 * lowercase, trim, collapse inner whitespace runs to a single space.
 */
export function normalizeSecurityAnswer(answer) {
  return String(answer ?? '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

/** SHA-256 hex of "salt|normalized-answer" (what gets stored). */
export async function hashSecurityAnswer(answer, salt) {
  return sha256hex(`${salt}|${normalizeSecurityAnswer(answer)}`);
}

/**
 * Validate a security-questions setup payload before sending.
 * Returns { ok: true } or { ok: false, code }.
 */
export function validateSecurityQuestions(items) {
  if (!Array.isArray(items) || items.length !== SECURITY_QUESTION_COUNT) {
    return { ok: false, code: 'question-count' };
  }
  const seen = new Set();
  for (const it of items) {
    const q = String(it?.question ?? '').trim();
    const a = normalizeSecurityAnswer(it?.answer);
    if (!q) return { ok: false, code: 'question-required' };
    if (a.length < 2) return { ok: false, code: 'answer-too-short' };
    const key = q.toLowerCase();
    if (seen.has(key)) return { ok: false, code: 'question-duplicate' };
    seen.add(key);
  }
  return { ok: true };
}

/**
 * Validate a redeem attempt client-side (cheap mistakes caught before the
 * server rate limiter sees them).
 */
export function validateRedeemInput({ login, newPassword }) {
  if (!String(login ?? '').trim()) return { ok: false, code: 'login-required' };
  const pw = String(newPassword ?? '');
  if (pw.length < 8 || pw.length > 200 || !/\S/.test(pw)) {
    return { ok: false, code: 'password-invalid' };
  }
  return { ok: true };
}
