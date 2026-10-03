/**
 * CLOUD BACKUP — optional second copy of the whole-account backup in the
 * shop owner's OWN free cloud storage (Google Drive first).
 *
 * Why Google Drive: every shop owner already knows "Sign in with Google",
 * a free Google account comes with 15 GB (room for hundreds of these JSON
 * backups), and the Drive API works straight from the browser — no server,
 * no client secret, nothing of ours in the middle. The token comes from
 * Google Identity Services with the narrow `drive.file` scope: Vendra
 * can only see and change the backup files it creates itself, never the
 * owner's photos, email, or other Drive files.
 *
 * The connection lights up only when BRAND.googleClientId is set (one-time,
 * free, done by whoever ships the product — see docs/cloud-backup.md).
 * Until then Settings shows an honest "not switched on yet" note and the
 * Download account backup button remains the always-available fallback.
 *
 * Connection model (beginner-honest): signing in lasts for this browser
 * session (Google signs you back in with one tap after that). Automatic
 * weekly backups only run while the app is open with a live Google
 * session — they never throw surprise sign-in popups. Nothing here ever
 * asks for, sees, or stores the owner's Google password.
 *
 * Pure helpers (filename/rotation/due-date/multipart/error mapping) are
 * exported for unit tests; every Google-touching function takes the token
 * explicitly so nothing is hidden in globals.
 */

import { BRAND } from './brand.js';

export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
export const BACKUP_FOLDER_NAME = `${BRAND.name} backups`;
export const KEEP_CLOUD_BACKUPS = 5;
export const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const GIS_SRC = 'https://accounts.google.com/gsi/client';
const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';
const STATE_KEY = `${BRAND.storagePrefix}_cloud_backup`;
const TOKEN_KEY = `${BRAND.storagePrefix}_gdrive_token`;

export class CloudBackupError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code; // 'unconfigured' | 'auth' | 'full' | 'network' | 'busy' | 'missing' | 'badfile' | 'http'
  }
}

/** True when this copy of the product ships with a Google sign-in key. */
export function isCloudBackupConfigured() {
  return Boolean(BRAND.googleClientId && String(BRAND.googleClientId).trim());
}

/* ------------------------------------------------------------------ */
/* Pure helpers (unit-tested)                                          */
/* ------------------------------------------------------------------ */

/** Sortable, filesystem-safe backup filename, e.g. drift-backup-20261001-183015.json (UTC). */
export function backupFileName(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return (
    `drift-backup-${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}` +
    `-${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}.json`
  );
}

export function isBackupFileName(name) {
  return typeof name === 'string' && /^drift-backup-\d{8}-\d{6}\.json$/.test(name);
}

/**
 * Which old backups to delete so only the newest `keep` remain.
 * `files`: [{ id, name, createdTime }] — anything that is not one of our
 * backup filenames is left completely alone. Returns file ids.
 */
export function planRotation(files, keep = KEEP_CLOUD_BACKUPS) {
  const mine = (Array.isArray(files) ? files : []).filter((f) => f && f.id && isBackupFileName(f.name));
  const sorted = [...mine].sort((a, b) => {
    const ta = Date.parse(a.createdTime || '') || 0;
    const tb = Date.parse(b.createdTime || '') || 0;
    if (tb !== ta) return tb - ta;
    return String(b.name).localeCompare(String(a.name));
  });
  return sorted.slice(Math.max(0, keep)).map((f) => f.id);
}

/** Is the weekly automatic backup due? An unreadable last date counts as due. */
export function weeklyBackupDue({ enabled, lastAt, now = Date.now(), intervalMs = WEEK_MS } = {}) {
  if (!enabled) return false;
  if (!lastAt) return true;
  const last = Date.parse(lastAt);
  if (!Number.isFinite(last)) return true;
  return now - last >= intervalMs;
}

/** Multipart/related body (metadata part + media part) for Drive uploads. */
export function buildMultipartBody(metadata, content, boundary) {
  return (
    `--${boundary}\r\n` +
    'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
    JSON.stringify(metadata) +
    '\r\n' +
    `--${boundary}\r\n` +
    'Content-Type: application/json\r\n\r\n' +
    content +
    '\r\n' +
    `--${boundary}--`
  );
}

/** Map a Drive HTTP failure to a stable code the UI turns into plain words. */
export function classifyDriveError(status, parsed) {
  const reason = parsed?.error?.errors?.[0]?.reason || parsed?.error?.status || '';
  if (status === 401) return 'auth';
  if (status === 403 && /storageQuotaExceeded|quotaExceeded/i.test(reason)) return 'full';
  if (status === 403 && /rateLimit/i.test(reason)) return 'busy';
  if (status === 403) return 'auth'; // stale grant / missing scope: signing in again is the fix
  if (status === 404) return 'missing';
  if (status === 429) return 'busy';
  return 'http';
}

/* ------------------------------------------------------------------ */
/* Device-local state (never the token's home for long)                */
/* ------------------------------------------------------------------ */

/** { auto: bool, lastAt: ISO|null, lastName: string|null } — survives restarts. */
export function getCloudBackupState() {
  try {
    const raw = localStorage.getItem(STATE_KEY);
    const s = raw ? JSON.parse(raw) : null;
    return { auto: Boolean(s?.auto), lastAt: s?.lastAt || null, lastName: s?.lastName || null };
  } catch {
    return { auto: false, lastAt: null, lastName: null };
  }
}

export function setCloudBackupState(patch) {
  const next = { ...getCloudBackupState(), ...patch };
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify(next));
  } catch {
    /* private mode — session-only */
  }
  return next;
}

function saveToken(token, expiresAt) {
  try {
    sessionStorage.setItem(TOKEN_KEY, JSON.stringify({ token, expiresAt }));
  } catch {
    /* session-only anyway */
  }
}

function readToken() {
  try {
    const raw = sessionStorage.getItem(TOKEN_KEY);
    const s = raw ? JSON.parse(raw) : null;
    if (s && s.token && Number(s.expiresAt) > Date.now()) return s.token;
  } catch {
    /* fall through */
  }
  return null;
}

function clearToken() {
  try {
    sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* noop */
  }
}

/** True when a live Google session token is on hand (no popup needed). */
export function isGoogleDriveConnected() {
  return Boolean(readToken());
}

/* ------------------------------------------------------------------ */
/* Google Identity Services (loaded on demand, only when configured)   */
/* ------------------------------------------------------------------ */

let gisPromise = null;

function loadGis() {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return Promise.reject(new CloudBackupError('http', 'Google sign-in is not available here.'));
  }
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  if (gisPromise) return gisPromise;
  gisPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = GIS_SRC;
    s.async = true;
    s.defer = true;
    s.onload = () => resolve();
    s.onerror = () => {
      gisPromise = null;
      reject(new CloudBackupError('network', 'Could not load Google sign-in.'));
    };
    document.head.appendChild(s);
  });
  return gisPromise;
}

/** Run the Google consent flow; resolves to a token or null (never throws). */
function requestToken() {
  return loadGis().then(
    () =>
      new Promise((resolve) => {
        let settled = false;
        const done = (v) => {
          if (!settled) {
            settled = true;
            resolve(v);
          }
        };
        try {
          const client = window.google.accounts.oauth2.initTokenClient({
            client_id: String(BRAND.googleClientId).trim(),
            scope: DRIVE_SCOPE,
            callback: (resp) => {
              if (resp && resp.access_token) {
                const expiresAt = Date.now() + (Number(resp.expires_in) || 3600) * 1000 - 30000;
                saveToken(resp.access_token, expiresAt);
                done(resp.access_token);
              } else {
                done(null);
              }
            },
            error_callback: () => done(null),
          });
          client.requestAccessToken({ prompt: '' });
        } catch {
          done(null);
        }
      })
  );
}

/**
 * A usable token. Non-interactive calls only reuse the live session token
 * (popups on app start would be awful); interactive ones may open Google.
 */
export async function ensureGoogleDriveToken({ interactive = false } = {}) {
  const existing = readToken();
  if (existing) return existing;
  if (!interactive) return null;
  return requestToken().catch(() => null);
}

/** Connect (interactive). Returns { about } — about may be null if Drive is shy. */
export async function connectGoogleDrive() {
  if (!isCloudBackupConfigured()) {
    throw new CloudBackupError('unconfigured', 'Cloud backup is not switched on for this copy.');
  }
  const token = await ensureGoogleDriveToken({ interactive: true });
  if (!token) throw new CloudBackupError('auth', 'Google sign-in did not finish.');
  const about = await getDriveAbout(token);
  return { token, about };
}

/** Disconnect: revoke at Google and forget the token here. Files stay put. */
export function disconnectGoogleDrive() {
  const token = readToken();
  if (token && typeof window !== 'undefined' && window.google?.accounts?.oauth2?.revoke) {
    try {
      window.google.accounts.oauth2.revoke(token, () => {});
    } catch {
      /* revoke is best-effort */
    }
  }
  clearToken();
}

/* ------------------------------------------------------------------ */
/* Drive REST (token passed explicitly everywhere)                     */
/* ------------------------------------------------------------------ */

async function driveFetch(token, url, options = {}) {
  let resp;
  try {
    resp = await fetch(url, {
      ...options,
      headers: { Authorization: `Bearer ${token}`, ...(options.headers || {}) },
    });
  } catch {
    throw new CloudBackupError('network', 'Could not reach Google Drive.');
  }
  return resp;
}

async function driveJson(token, url, options = {}) {
  const resp = await driveFetch(token, url, options);
  const text = await resp.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON error body */
  }
  if (!resp.ok) {
    throw new CloudBackupError(classifyDriveError(resp.status, json), json?.error?.message || `Google Drive error (${resp.status})`);
  }
  return json;
}

/** Owner display name / email + storage quota, or null when unavailable. */
export async function getDriveAbout(token) {
  try {
    const json = await driveJson(token, `${DRIVE_API}/about?fields=user,storageQuota`);
    return {
      email: json?.user?.emailAddress || null,
      name: json?.user?.displayName || null,
      limit: Number(json?.storageQuota?.limit) || null,
      usage: Number(json?.storageQuota?.usage) || null,
    };
  } catch {
    return null;
  }
}

/** The one folder Vendra keeps its backups in (created on first use). */
export async function ensureBackupFolder(token) {
  const q = `name = '${BACKUP_FOLDER_NAME.replace(/'/g, "\\'")}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
  const list = await driveJson(token, `${DRIVE_API}/files?q=${encodeURIComponent(q)}&fields=files(id,name)&spaces=drive`);
  if (list?.files?.length) return list.files[0].id;
  const created = await driveJson(token, `${DRIVE_API}/files`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: BACKUP_FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' }),
  });
  return created.id;
}

/**
 * Upload one backup dump. Uses a resumable session: a plain multipart POST
 * is capped at 5 MB by Google and a full account backup can be far larger.
 */
export async function uploadBackupToDrive(token, dump, name = backupFileName()) {
  const folderId = await ensureBackupFolder(token);
  const content = typeof dump === 'string' ? dump : JSON.stringify(dump, null, 2);
  const metadata = { name, parents: [folderId], mimeType: 'application/json' };
  const sessionResp = await driveFetch(token, `${UPLOAD_API}/files?uploadType=resumable`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': 'application/json',
      'X-Upload-Content-Length': String(new TextEncoder().encode(content).length),
    },
    body: JSON.stringify(metadata),
  });
  if (!sessionResp.ok) {
    const json = await sessionResp.json().catch(() => null);
    throw new CloudBackupError(classifyDriveError(sessionResp.status, json), json?.error?.message || `Google Drive error (${sessionResp.status})`);
  }
  const location = sessionResp.headers.get('Location');
  if (!location) throw new CloudBackupError('http', 'Google Drive did not start the upload.');
  let putResp;
  try {
    putResp = await fetch(location, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: content });
  } catch {
    throw new CloudBackupError('network', 'Could not reach Google Drive.');
  }
  if (!putResp.ok) {
    const json = await putResp.json().catch(() => null);
    throw new CloudBackupError(classifyDriveError(putResp.status, json), json?.error?.message || `Google Drive error (${putResp.status})`);
  }
  const created = await putResp.json().catch(() => ({}));
  return { id: created?.id || null, name };
}

/** Backups in our folder, newest first (non-backup files are ignored). */
export async function listCloudBackups(token) {
  const folderId = await ensureBackupFolder(token);
  const q = `'${folderId}' in parents and trashed = false`;
  const json = await driveJson(
    token,
    `${DRIVE_API}/files?q=${encodeURIComponent(q)}&fields=files(id,name,createdTime,size)&orderBy=createdTime%20desc&pageSize=50`
  );
  return (json?.files || []).filter((f) => isBackupFileName(f?.name));
}

/** Download + parse one backup. Throws CloudBackupError('badfile') on junk. */
export async function downloadCloudBackup(token, id) {
  const resp = await driveFetch(token, `${DRIVE_API}/files/${encodeURIComponent(id)}?alt=media`);
  if (!resp.ok) {
    const json = await resp.json().catch(() => null);
    throw new CloudBackupError(classifyDriveError(resp.status, json), json?.error?.message || `Google Drive error (${resp.status})`);
  }
  const text = await resp.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new CloudBackupError('badfile', 'That backup file could not be read.');
  }
}

/** Delete all but the newest KEEP_CLOUD_BACKUPS. Best-effort per file. */
export async function rotateCloudBackups(token, backups) {
  const list = Array.isArray(backups) ? backups : await listCloudBackups(token);
  const ids = planRotation(list);
  let removed = 0;
  for (const id of ids) {
    try {
      await driveJson(token, `${DRIVE_API}/files/${encodeURIComponent(id)}`, { method: 'DELETE' });
      removed++;
    } catch {
      /* cleanup hiccups never fail a good backup */
    }
  }
  return removed;
}

/* ------------------------------------------------------------------ */
/* High-level flows used by Settings                                   */
/* ------------------------------------------------------------------ */

/**
 * Save a fresh backup to Drive now, then rotate old ones away.
 * `dump` is the exportAccountBackup() result (object or JSON string).
 */
export async function backUpNowToDrive(dump, { interactive = true } = {}) {
  if (!isCloudBackupConfigured()) {
    throw new CloudBackupError('unconfigured', 'Cloud backup is not switched on for this copy.');
  }
  const token = await ensureGoogleDriveToken({ interactive });
  if (!token) throw new CloudBackupError('auth', 'Google sign-in is needed.');
  const name = backupFileName();
  const up = await uploadBackupToDrive(token, dump, name);
  try {
    const backups = await listCloudBackups(token);
    await rotateCloudBackups(token, backups);
  } catch {
    /* rotation is housekeeping; the backup itself already landed */
  }
  setCloudBackupState({ lastAt: new Date().toISOString(), lastName: name });
  return { name, id: up.id };
}

/**
 * The automatic weekly backup. SILENT BY DESIGN: no popups, no throws —
 * it runs only when the owner already has a live Google session here and
 * a backup is due. `exportDump` is accountBackup's exportAccountBackup.
 * Returns true when a backup actually ran.
 */
export async function maybeAutoCloudBackup(exportDump) {
  try {
    if (!isCloudBackupConfigured()) return false;
    const state = getCloudBackupState();
    if (!weeklyBackupDue({ enabled: state.auto, lastAt: state.lastAt })) return false;
    const token = await ensureGoogleDriveToken({ interactive: false });
    if (!token) return false;
    const dump = await exportDump();
    await backUpNowToDrive(dump, { interactive: false });
    return true;
  } catch {
    return false;
  }
}
