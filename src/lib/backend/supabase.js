/**
 * Vendra Supabase backend adapter.
 *
 * Implements the same adapter interface as local.js against the Drift
 * Supabase schema (see ../build3-supabase-schema.md):
 *   tables: profiles, user_settings, vfs_folders, vfs_files, spaces,
 *           window_states, pins, helm_threads, helm_messages,
 *           game_highscores, notifications
 *   rpc: search_pins(p_query)
 *   storage buckets: user-files, user-wallpapers
 *
 * New-user seeding (settings row, root VFS folder, Main/Focus/Play spaces)
 * is done by the DB `handle_new_user()` trigger; the client also seeds
 * defensively where a missing row is indistinguishable from "not created yet".
 *
 * Only dependency: @supabase/supabase-js.
 */

import { createClient } from '@supabase/supabase-js';
import { resolveSupabaseEndpoint, guardClientForStandbyRead, writeBlockedError } from '../dbEndpoints.js';
import { BRAND } from '../brand.js';
import {
  validateSignupEmail,
  buildSignupRedirectTo,
  normalizeOAuthProvider,
  classifyAccountKind,
  parseAuthCallbackUrl,
  resolveConfirmedFlow,
  readPendingFlow,
  clearPendingFlow,
  setAuthNotice,
} from '../authFlow.js';
import { normIsbn, normText, cleanBqItem, bqCsvHeaders, bqExportCsv, bqParseCsv, BQ_ORDER_STATUSES } from '../bouquinerie-shared.js';
import { isBusinessPreset } from '../businessPresets.js';
import { cleanLinkFields } from '../integrations.js';
import { normalizeDomainInput, isValidHostname } from '../hostnameResolve.js';
import { storageUploadXhr } from './storageXhr.js';
import {
  generateRecoveryCodes,
  hashRecoveryCode,
  normalizeRecoveryCode,
  normalizeSecurityAnswer,
  hashSecurityAnswer,
  generateSalt,
  validateSecurityQuestions,
  validateRedeemInput,
  RECOVERY_CODE_COUNT,
} from '../recovery.js';

const MAX_SPACES = 8;

// Boot URL snapshot (taken synchronously at module load): supabase-js's
// detectSessionInUrl clears window.location.hash asynchronously during
// client init, which races the app's own auth-callback parser. Without this
// snapshot, recovery-link landings (#access_token…&type=recovery) lose their
// hash before consumeAuthCallback() reads it, and the new-password screen
// never appears. Email links always arrive via full page load, so the boot
// snapshot is the correct source of truth for the callback parser.
const BOOT_HREF = typeof window !== 'undefined' ? String(window.location.href) : '';const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB inline text; larger text rides the binary path
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // 50 MB per binary upload — the free storage plan's per-file ceiling; fail fast with a plain message instead of a platform rejection
const MAX_PIN_FILE_BYTES = 50 * 1024 * 1024; // 50 MB per file/image pin (Supabase Storage)
const PIN_FILES_BUCKET = 'user-files';

function formatBytes(n) {
  const bytes = Number(n) || 0;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Convert a data: URL to a Blob (works in browsers and Node 18+). */
async function dataUrlToBlob(dataUrl) {
  const res = await fetch(dataUrl);
  if (!res.ok) throw new Error('Could not decode file data.');
  return res.blob();
}

const DEFAULT_SETTINGS = {
  visual_theme: 'daybreak',
  wallpaper: 'paper-grain',
  accent_override: null,
  ai_engine: 'local',
  ui_scale: 100,
  icon_positions: {},
  desktop_icons: null,
  hidden_from_start: [],
  desktop_icon_order: [],
  taskbar_position: 'bottom',
  ui_style: 'drift',
  touch_mode: false,
  welcome_seen: false,
  welcome_tour_seen: false,
};

// ui_scale lives in localStorage, not the user_settings table (no schema
// change needed). Interface scale is a per-device display preference, so a
// device-local store is semantically correct and works on the live project.
const UI_SCALE_KEY = 'drift-ui-scale';
const UI_SCALES = [90, 100, 110, 125, 150];
function readUiScale() {
  try {
    const v = parseInt(localStorage.getItem(UI_SCALE_KEY), 10);
    return UI_SCALES.includes(v) ? v : 100;
  } catch {
    return 100;
  }
}
function writeUiScale(v) {
  if (!UI_SCALES.includes(v)) throw new Error('Invalid interface scale.');
  try {
    localStorage.setItem(UI_SCALE_KEY, String(v));
  } catch {
    /* storage unavailable — scale still applies for this session */
  }
}

// desktop_icons lives in localStorage, not the user_settings table (no schema
// change needed). Null = show every app; otherwise an array of app ids.
// A per-device display preference, so a device-local store is fine.
const DESKTOP_ICONS_KEY = 'drift-desktop-icons';
function readDesktopIcons() {
  try {
    const raw = localStorage.getItem(DESKTOP_ICONS_KEY);
    if (raw == null) return null;
    const v = JSON.parse(raw);
    return Array.isArray(v) && v.every((x) => typeof x === 'string') ? v : null;
  } catch {
    return null;
  }
}
function writeDesktopIcons(v) {
  if (v !== null && !(Array.isArray(v) && v.every((x) => typeof x === 'string'))) {
    throw new Error('desktop_icons must be null or an array of app ids.');
  }
  try {
    if (v === null) localStorage.removeItem(DESKTOP_ICONS_KEY);
    else localStorage.setItem(DESKTOP_ICONS_KEY, JSON.stringify(v));
  } catch {
    /* storage unavailable — icons still update for this session */
  }
}

// hidden_from_start, desktop_icon_order, and taskbar_position are per-device
// display preferences like desktop_icons/ui_scale: they live in localStorage
// (no user_settings schema change needed) and merge into settings.get().
function readIdList(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return fallback;
    const v = JSON.parse(raw);
    return Array.isArray(v) && v.every((x) => typeof x === 'string') ? v : fallback;
  } catch {
    return fallback;
  }
}
function writeIdList(key, v, label) {
  if (!(Array.isArray(v) && v.every((x) => typeof x === 'string'))) {
    throw new Error(`${label} must be an array of app ids.`);
  }
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* storage unavailable — still applies for this session */
  }
}
const HIDDEN_FROM_START_KEY = 'drift-hidden-from-start';
const ICON_ORDER_KEY = 'drift-desktop-icon-order';
const TASKBAR_POS_KEY = 'drift-taskbar-position';
const UI_STYLE_KEY = 'drift-ui-style';
const TOUCH_MODE_KEY = 'drift-touch-mode';
const TASKBAR_POSITIONS = ['top', 'bottom', 'left', 'right'];
const UI_STYLES = ['drift', 'windows11', 'macosx'];
function readTaskbarPosition() {
  try {
    const v = localStorage.getItem(TASKBAR_POS_KEY);
    return TASKBAR_POSITIONS.includes(v) ? v : 'bottom';
  } catch {
    return 'bottom';
  }
}
function writeTaskbarPosition(v) {
  if (!TASKBAR_POSITIONS.includes(v)) throw new Error('Invalid taskbar position.');
  try {
    localStorage.setItem(TASKBAR_POS_KEY, v);
  } catch {
    /* storage unavailable — still applies for this session */
  }
}
function readUiStyle() {
  try {
    const v = localStorage.getItem(UI_STYLE_KEY);
    return UI_STYLES.includes(v) ? v : 'drift';
  } catch {
    return 'drift';
  }
}
function writeUiStyle(v) {
  if (!UI_STYLES.includes(v)) throw new Error('Invalid interface style.');
  try {
    localStorage.setItem(UI_STYLE_KEY, v);
  } catch {
    /* storage unavailable — still applies for this session */
  }
}
function readTouchMode() {
  try {
    return localStorage.getItem(TOUCH_MODE_KEY) === '1';
  } catch {
    return false;
  }
}
function writeTouchMode(v) {
  try {
    localStorage.setItem(TOUCH_MODE_KEY, v === true ? '1' : '0');
  } catch {
    /* storage unavailable — still applies for this session */
  }
}

/** Hex random string that works in non-secure contexts too. crypto.randomUUID
 *  requires a secure context (plain-HTTP pages don't have it); getRandomValues
 *  does not, so prefer it and only then fall back to Math.random. */
function randomHex(n) {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
      const bytes = crypto.getRandomValues(new Uint8Array(n));
      return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('').slice(0, n);
    }
  } catch {
    /* fall through to Math.random */
  }
  let s = '';
  while (s.length < n) s += Math.random().toString(16).slice(2);
  return s.slice(0, n);
}

/** Random id generator. Named newUuid (not uid) on purpose: many functions
 *  below declare a local `uid` for the user's id, which would shadow this. */
function newUuid() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Non-secure contexts (plain HTTP) lack randomUUID. Never slice a short
  // prefix off a timestamp — its leading digits are stable for hours, which
  // once produced identical guest usernames for every signup in the hour.
  return `id-${randomHex(8)}${Date.now().toString(36)}-${randomHex(8)}`;
}

function randomPassword(length = 32) {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

function byteLength(str) {
  return new TextEncoder().encode(str).length;
}

/** Throw a clear Error when a PostgREST call failed; otherwise return data. */
function check(res, what) {
  if (res.error) throw new Error(`${what} failed: ${res.error.message}`);
  return res.data;
}

/** Blob -> data URL (backup path for pin files). */
function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Could not encode file.'));
    reader.readAsDataURL(blob);
  });
}

/**
 * Map database permission/RLS failures to a human message. Raw Postgres
 * errors ("new row violates row-level security policy…") must never reach
 * the user — they read as gibberish and leak schema details.
 */
function friendlyPosError(err, action) {
  const msg = err?.message || String(err);
  if (/row-level security|permission denied|not authorized|42501|PGRST/i.test(msg)) {
    const friendly = new Error(
      `Couldn't ${action} — your sign-in may have expired. Try signing out and back in, then try again.`
    );
    friendly.code = err?.code;
    friendly.cause = err;
    return friendly;
  }
  return err;
}

/**
 * True when Supabase rejected the request because of the API key itself
 * (HTTP 401 + "Invalid API key") rather than the user's credentials —
 * wrong passwords come back as HTTP 400 "Invalid login credentials".
 * A rejected key means the BUILD is misconfigured; reporting it as a
 * credential failure sends the user chasing the wrong problem (this
 * exact confusion happened in production with a truncated key).
 */
function isApiKeyRejection(error) {
  if (!error) return false;
  const msg = String(error.message || '');
  if (/invalid api[- ]?key|no api key/i.test(msg)) return true;
  return Number(error.status) === 401 && /api[- ]?key/i.test(msg);
}

/**
 * Build the Error thrown for a failed auth call. API-key rejections get
 * a coded error ('server-config') so the login UI can show its
 * plain-language setup-problem message instead of the raw backend text.
 */
function authFailure(prefix, error) {
  if (isApiKeyRejection(error)) {
    const e = new Error(`${prefix}: the server rejected this app's access key.`);
    e.code = 'server-config';
    return e;
  }
  return new Error(`${prefix}: ${error.message}`);
}

export function createSupabaseBackend(config = null) {
  // Boot may have failed over to a standby database (docs/redundancy.md).
  // resolveSupabaseEndpoint() returns the build's env by default (today's
  // behavior); after a standby-read boot it returns the standby with
  // readOnly: true, and the client below is wrapped so every write path
  // rejects with an honest message instead of touching the standby.
  // Optional explicit connection pair (scale groundwork): lets a future
  // caller build an adapter for a DIFFERENT project than the build-time
  // one — e.g. once the backend directory (./directory.js) routes a shop
  // to its own project. With no argument, behavior is exactly the
  // endpoint resolution above. An explicit config always wins and is
  // never read-only (the caller owns that connection).
  const resolved = resolveSupabaseEndpoint();
  const url = config ? config.url : resolved.url;
  const key = config ? config.key : resolved.key;
  const readOnly = config ? false : resolved.readOnly;
  if (!url || !key) {
    throw new Error(
      'Supabase adapter needs VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY. ' +
        'Set them in your .env, or use the local backend instead.'
    );
  }
  // Storefront isolation: the public shop page (#/store/<slug>) uses a
  // separate Supabase auth storage key so customer sessions never share
  // localStorage with the owner desktop. This prevents the desktop's
  // access check (or any other tab) from signing out customers via
  // BroadcastChannel sync.
  const isStorefront = typeof window !== 'undefined' &&
    /^#\/store\//.test(window.location.hash);
  const storageKey = isStorefront
    ? `sb-${new URL(url).hostname.split('.')[0]}-storefront-auth-token`
    : undefined; // default key for desktop
  const rawClient = createClient(url, key, storageKey ? {
    auth: { storageKey },
  } : undefined);
  const client = readOnly ? guardClientForStandbyRead(rawClient) : rawClient;

  // App root URL (origin + Vite base path), the landing page for every
  // auth email link. Query markers (?authflow=…) ride on it; the
  // redirect-URL allowlist in the Supabase dashboard must cover them
  // (wildcards supported — see docs/one-login-email-signup.md).
  function appRootUrl(extraParams) {
    const base = import.meta.env?.BASE_URL || '/';
    const root = window.location.origin + (base.endsWith('/') ? base : base + '/');
    if (!extraParams) return root;
    const qs = new URLSearchParams(extraParams).toString();
    return qs ? `${root}?${qs}` : root;
  }

  /**
   * Raw storage upload over XMLHttpRequest so callers get real byte-level
   * progress (xhr.upload.onprogress). Mirrors what the Supabase client's
   * own upload() sends for a Blob body — same endpoint, same auth, same
   * RLS — implemented in ./storageXhr.js so it can be unit-tested.
   */
  async function storageUploadXhrBound({ bucket, storagePath, blob, upsert, onProgress }) {
    // The XHR path bypasses the supabase-js client, so the standby-read
    // guard must be enforced here explicitly: file uploads are writes.
    if (readOnly) throw writeBlockedError();
    const { data: sessData, error: sessErr } = await client.auth.getSession();
    if (sessErr) throw new Error('Your sign-in expired — sign out and back in, then try again.');
    return storageUploadXhr({
      url,
      apiKey: key,
      getToken: async () => sessData?.session?.access_token,
      bucket,
      storagePath,
      blob,
      upsert,
      onProgress,
    });
  }

  /** Upload pin file bytes to the user-files bucket; returns the storage path. */
  async function uploadPinFile(userId, fileName, blob) {
    const safe = String(fileName || 'file').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80) || 'file';
    const path = `${userId}/pins/${newUuid()}/${safe}`;
    const { error } = await client.storage.from(PIN_FILES_BUCKET).upload(path, blob, {
      contentType: blob.type || 'application/octet-stream',
      upsert: false,
    });
    if (error) throw new Error(`Uploading file failed: ${error.message}`);
    return path;
  }

  /** Best-effort removal of a pin's storage object; never fails the caller. */
  async function removePinFileQuietly(path) {
    if (!path) return;
    try {
      const { error } = await client.storage.from(PIN_FILES_BUCKET).remove([path]);
      if (error) console.warn('pin storage cleanup failed:', error.message);
    } catch (err) {
      console.warn('pin storage cleanup failed:', err?.message || err);
    }
  }

  // ---- auth session cache (getUser/onAuthChange are sync) -------------------
  let cachedUser = null; // { id, email, username, role, isGuest } | null
  let booted = false;
  const authListeners = new Set();
  // Monotonic token to make applySession atomic: if a newer auth event
  // arrives while a profile fetch is in flight, the stale fetch's result
  // is discarded instead of resurrecting a dead session.
  let sessionSeq = 0;

  async function applySession(session) {
    const mySeq = ++sessionSeq;
    if (!session?.user) {
      cachedUser = null;
    } else {
      const su = session.user;
      let profile = null;
      try {
        const res = await client
          .from('profiles')
          .select('username, role, is_guest')
          .eq('id', su.id)
          .maybeSingle();
        profile = res.data; // may be null if the bootstrap trigger raced us
      } catch (err) {
        console.error('profile fetch failed:', err);
      }
      // Discard if a newer auth event arrived during the fetch.
      if (mySeq !== sessionSeq) return;
      cachedUser = {
        id: su.id,
        email: su.email ?? null,
        username:
          profile?.username ??
          su.user_metadata?.username ??
          (su.email ? su.email.split('@')[0] : 'user'),
        role: profile?.role ?? 'standard',
        isGuest: !!(profile?.is_guest || su.user_metadata?.is_guest),
      };
    }
    for (const cb of authListeners) {
      try {
        cb(cachedUser);
      } catch (err) {
        console.error('auth listener failed:', err);
      }
    }
  }

  function boot() {
    if (booted) return;
    booted = true;
    client.auth.onAuthStateChange((_event, session) => {
      applySession(session).catch((err) => console.error('auth state apply failed:', err));
    });
    client.auth
      .getSession()
      .then(async ({ data }) => {
        const session = data.session;
        // Race guard: if the user signed in while the restore was in
        // flight (cachedUser already set), the restored session is stale
        // and must NOT overwrite the fresh sign-in. This hit the
        // storefront, where customers can sign in before boot's getSession
        // resolves. Only apply the restore when no sign-in has occurred.
        if (cachedUser) {
          return;
        }
        if (session?.user) {
          // Validate the restored session against the server: if the account
          // was deleted, the local token is stale and would boot into a dead
          // desktop. Force a clean logout instead. Only clear on the specific
          // "user does not exist" error — transient network failures keep the
          // session so a blip can't log a valid user out.
          const { error } = await client.auth.getUser();
          if (error && /user.*not exist|sub claim/i.test(error.message)) {
            console.warn('stored session belongs to a deleted account, clearing');
            await client.auth.signOut();
            await applySession(null);
            return;
          }
        }
        await applySession(session);
      })
      .catch((err) => console.error('session restore failed:', err));
  }

  function requireUid() {
    if (!cachedUser) throw new Error('Not signed in.');
    return cachedUser.id;
  }

  boot();

  // ---- mappers ---------------------------------------------------------------
  const mapSpace = (r) => ({
    id: r.id,
    name: r.name,
    icon: r.icon ?? 'square',
    wallpaper: r.wallpaper ?? null,
    accent: r.accent ?? null,
    sortOrder: r.sort_order ?? 0,
  });

  const mapWindowState = (r) => ({
    appId: r.app_id,
    x: r.x,
    y: r.y,
    w: r.w,
    h: r.h,
    z: r.z,
    minimized: !!r.minimized,
    props: r.props ?? {},
  });

  const mapPin = (r) => ({
    id: r.id,
    kind: r.kind,
    title: r.title,
    body: r.body ?? null,
    url: r.url ?? null,
    tags: r.tags ?? [],
    sourceApp: r.source_app ?? null,
    mime: r.mime ?? null,
    sizeBytes: r.size_bytes != null ? Number(r.size_bytes) : null,
    storagePath: r.storage_path ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  });

  const mapThread = (r) => ({
    id: r.id,
    title: r.title,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  });

  const mapMessage = (r) => ({
    id: r.id,
    role: r.role,
    content: r.content,
    toolCalls: r.tool_calls ?? null,
    createdAt: r.created_at,
  });

  // ---- VFS path helpers --------------------------------------------------------
  async function rootFolder(uid) {
    // Use limit(1) + order instead of maybeSingle(): if duplicate roots exist
    // (e.g. from a raced trigger), pick the oldest rather than throwing.
    const res = await client
      .from('vfs_folders')
      .select('id, name, updated_at')
      .eq('user_id', uid)
      .is('parent_id', null)
      .order('created_at', { ascending: true })
      .limit(1);
    if (res.error) throw new Error(`Loading the VFS root failed: ${res.error.message}`);
    if (res.data && res.data.length > 0) return res.data[0];
    // defensive: the handle_new_user trigger should have made this
    return check(
      await client
        .from('vfs_folders')
        .insert({ user_id: uid, parent_id: null, name: 'root' })
        .select('id, name, updated_at')
        .single(),
      'Creating the VFS root'
    );
  }

  function splitPath(path) {
    if (typeof path !== 'string' || !path.startsWith('/')) {
      throw new Error(`Invalid path "${path}" — paths must start with '/'.`);
    }
    return path.split('/').filter((s) => s.length > 0);
  }

  function joinPath(segments) {
    return '/' + segments.join('/');
  }

  async function resolveFolder(uid, segments, create) {
    let folder = await rootFolder(uid);
    for (const seg of segments) {
      const res = await client
        .from('vfs_folders')
        .select('id, name, updated_at')
        .eq('user_id', uid)
        .eq('parent_id', folder.id)
        .eq('name', seg)
        .maybeSingle();
      if (res.error) throw new Error(`Resolving folder "${seg}" failed: ${res.error.message}`);
      let row = res.data;
      if (!row) {
        if (!create) return null;
        row = check(
          await client
            .from('vfs_folders')
            .insert({ user_id: uid, parent_id: folder.id, name: seg })
            .select('id, name, updated_at')
            .single(),
          `Creating folder "${seg}"`
        );
      }
      folder = row;
    }
    return folder;
  }

  async function findFile(uid, folderId, name) {
    const res = await client
      .from('vfs_files')
      .select('id, name, mime_type, size_bytes, is_binary, storage_path, content_text, updated_at')
      .eq('user_id', uid)
      .eq('folder_id', folderId)
      .eq('name', name)
      .maybeSingle();
    if (res.error) throw new Error(`Looking up file "${name}" failed: ${res.error.message}`);
    return res.data;
  }

  function toEntry(row, type, path) {
    return {
      name: row.name,
      path,
      type,
      size: type === 'folder' ? 0 : Number(row.size_bytes ?? 0),
      mime: type === 'folder' ? 'inode/directory' : row.mime_type || 'text/plain',
      updatedAt: row.updated_at,
    };
  }

  // ---- auth --------------------------------------------------------------------
  async function settleSession(data, fallbackError) {
    let session = data.session;
    if (!session) {
      // signUp with email confirmation disabled returns no session here; the
      // trigger-created profile still exists, so a direct sign-in works.
      const r = await client.auth.signInWithPassword(data.credentials);
      if (r.error) throw new Error(fallbackError);
      session = r.data.session;
    }
    if (!session) throw new Error(fallbackError);
    await applySession(session);
    if (!cachedUser) throw new Error(fallbackError);
    return { user: { ...cachedUser } };
  }

  const auth = {
    async signUp({ email, password, username }) {
      const cleanEmail = String(email ?? '').trim();
      const cleanName = String(username ?? '').trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
        throw new Error('Enter a valid email address.');
      }
      if (!password || password.length < 8) throw new Error('Password must be at least 8 characters.');
      if (!cleanName) throw new Error('Username cannot be empty.');
      const { data, error } = await client.auth.signUp({
        email: cleanEmail,
        password,
        options: { data: { username: cleanName, is_guest: false } },
      });
      if (error) throw authFailure('Sign up failed', error);
      return settleSession(
        { session: data.session, credentials: { email: cleanEmail, password } },
        'Account created. Check your email to confirm it, then sign in.'
      );
    },

    // One-login email signup (2026-10-01): owners AND customers sign up with
    // a REAL email address. Supabase sends a confirmation email; the link
    // lands back here (see consumeAuthCallback) carrying ?authflow= so the
    // app knows where to resume.
    //
    // Returns { status: 'signed-in', user } when the project has "Confirm
    // email" OFF (or the address was already confirmed), or
    // { status: 'needs-confirmation', email } when a confirmation email is
    // on its way. Enumeration-safe: Supabase answers the same way for an
    // already-registered address (placeholder user, no session, no error),
    // so the UI can show one honest "check your inbox" message either way.
    //
    // kind: 'owner' (default) | 'customer'. slug: the shop page a customer
    // signed up from (routes them back after confirming).
    async signUpWithEmail({ email, password, displayName, kind, slug }) {
      const v = validateSignupEmail(email, BRAND.accountsDomain);
      if (!v.ok) {
        const e = new Error(v.code);
        e.code = v.code;
        throw e;
      }
      if (!password || password.length < 8) throw new Error('Password must be at least 8 characters.');
      const name = String(displayName ?? '').trim() || v.email.split('@')[0];
      const accountKind = kind === 'customer' ? 'customer' : 'owner';
      const redirectTo = buildSignupRedirectTo({
        origin: window.location.origin,
        basePath: import.meta.env?.BASE_URL || '/',
        kind: accountKind,
        slug,
      });
      const { data, error } = await client.auth.signUp({
        email: v.email,
        password,
        options: {
          data: { username: name, is_guest: false, account_kind: accountKind },
          emailRedirectTo: redirectTo,
        },
      });
      if (error) throw authFailure('Sign up failed', error);
      if (data.session) {
        await applySession(data.session);
        if (!cachedUser) throw new Error('Sign up failed: no session was established.');
        return { status: 'signed-in', user: { ...cachedUser } };
      }
      return { status: 'needs-confirmation', email: v.email };
    },

    // Resend the signup confirmation email. Supabase enforces a 60s
    // per-user window and hourly project limits (see docs rate limits);
    // rate rejections surface as the coded 'email-rate-limited' error.
    async resendConfirmation({ email, kind, slug }) {
      const v = validateSignupEmail(email, BRAND.accountsDomain);
      if (!v.ok) {
        const e = new Error(v.code);
        e.code = v.code;
        throw e;
      }
      const accountKind = kind === 'customer' ? 'customer' : 'owner';
      const redirectTo = buildSignupRedirectTo({
        origin: window.location.origin,
        basePath: import.meta.env?.BASE_URL || '/',
        kind: accountKind,
        slug,
      });
      const { error } = await client.auth.resend({
        type: 'signup',
        email: v.email,
        options: { emailRedirectTo: redirectTo },
      });
      if (error) {
        if (error.status === 429 || /rate|too many/i.test(error.message || '')) {
          const e = new Error('email-rate-limited');
          e.code = 'email-rate-limited';
          throw e;
        }
        throw new Error(`Could not resend the confirmation email: ${error.message}`);
      }
    },

    async signIn({ email, password }) {
      const { data, error } = await client.auth.signInWithPassword({
        email: String(email ?? '').trim(),
        password: password ?? '',
      });
      if (error) {
        // Unconfirmed email: coded so the login screen can say "check your
        // inbox" instead of the generic wrong-password message.
        if (error.code === 'email_not_confirmed' || /email not confirmed/i.test(error.message || '')) {
          const e = authFailure('Sign in failed', error);
          e.code = 'email-not-confirmed';
          throw e;
        }
        throw authFailure('Sign in failed', error);
      }
      await applySession(data.session);
      // If applySession was discarded by a concurrent boot() restore with a
      // stale null session (sequence token), force-set from the fresh session
      // data — the sign-in just succeeded, so the session is valid.
      if (!cachedUser && data.session?.user) {
        const su = data.session.user;
        cachedUser = {
          id: su.id,
          email: su.email ?? null,
          username: su.user_metadata?.username ?? (su.email ? su.email.split('@')[0] : 'user'),
          role: 'standard',
          isGuest: !!su.user_metadata?.is_guest,
        };
        // Bump the sequence so the stale boot restore can't overwrite us.
        sessionSeq++;
        for (const cb of authListeners) {
          try { cb(cachedUser); } catch (err) { console.error('auth listener failed:', err); }
        }
      }
      if (!cachedUser) throw new Error('Sign in failed: no session was established.');
      return { user: { ...cachedUser } };
    },

    // Social sign-in (Jesse, 2026-10-01): email + password stays, and users
    // may also continue with Google or GitHub. This starts the provider
    // round trip; the browser leaves for the provider and returns through
    // consumeAuthCallback() with the same ?authflow= routing as an email
    // confirmation link, so an owner lands on the desktop and a customer
    // lands back on their shop. The provider must be enabled in Supabase
    // Auth → Providers; when it is not, Supabase's refusal is mapped to the
    // coded 'oauth-not-enabled' error so the UI can say so plainly.
    async signInWithOAuth({ provider, kind, slug }) {
      const p = normalizeOAuthProvider(provider);
      if (!p) {
        const e = new Error('oauth-provider-unsupported');
        e.code = 'oauth-provider-unsupported';
        throw e;
      }
      const accountKind = kind === 'customer' ? 'customer' : 'owner';
      const redirectTo = buildSignupRedirectTo({
        origin: window.location.origin,
        basePath: import.meta.env?.BASE_URL || '/',
        kind: accountKind,
        slug,
      });
      const { error } = await client.auth.signInWithOAuth({
        provider: p,
        options: { redirectTo },
      });
      if (error) {
        if (/provider is not enabled|not enabled|unsupported provider/i.test(error.message || '')) {
          const e = new Error('oauth-not-enabled');
          e.code = 'oauth-not-enabled';
          throw e;
        }
        throw authFailure('Social sign in failed', error);
      }
      return { status: 'redirect' };
    },

    // Passwordless sign-in (Jesse, 2026-10-02 — maximum login ease): "email
    // me a login link". No password to remember or type; Supabase emails a
    // one-time sign-in link. Like signUpWithEmail and signInWithOAuth, the
    // link lands back here carrying ?authflow=owner|customer[&shop=], so it
    // reuses the exact same callback routing and post-OAuth classification:
    // an owner lands on the desktop, a customer lands back on their shop.
    // For a brand-new address Supabase creates the account on first click,
    // so this doubles as the simplest possible signup — the classification
    // stamps it from the flow, exactly like an OAuth signup.
    // Returns { status: 'link-sent', email }.
    async signInWithMagicLink({ email, kind, slug }) {
      const v = validateSignupEmail(email, BRAND.accountsDomain);
      if (!v.ok) {
        const e = new Error(v.code);
        e.code = v.code;
        throw e;
      }
      const accountKind = kind === 'customer' ? 'customer' : 'owner';
      const redirectTo = buildSignupRedirectTo({
        origin: window.location.origin,
        basePath: import.meta.env?.BASE_URL || '/',
        kind: accountKind,
        slug,
      });
      const { error } = await client.auth.signInWithOtp({
        email: v.email,
        options: { emailRedirectTo: redirectTo },
      });
      if (error) {
        if (error.status === 429 || /rate|too many/i.test(error.message || '')) {
          const e = new Error('email-rate-limited');
          e.code = 'email-rate-limited';
          throw e;
        }
        throw new Error(`Could not send the sign-in link: ${error.message}`);
      }
      return { status: 'link-sent', email: v.email };
    },

    // Guest trial via Supabase anonymous sign-in: a real auth user (real UID, so
    // RLS applies normally) flagged is_guest. Needs "Allow anonymous sign-ins"
    // enabled in Supabase Auth settings. (The old guest-xxx@drift.local sign-up
    // was rejected by Supabase email validation — anonymous sign-in is the
    // provider-native trial flow.)
    async signInGuest() {
      // 10 hex chars via getRandomValues (secure-context independent): the
      // old 6-char slice of a timestamp fallback was hour-stable on plain
      // HTTP and collided on profiles_username_key, 500ing every signup.
      const tag = randomHex(10);
      // Friendly display name: adjective + animal + 4 digits (e.g. "Guest Sunny Fox 1234")
      // The full hex tag stays in the metadata for uniqueness.
      const adjectives = ['Sunny', 'Clever', 'Brave', 'Kind', 'Swift', 'Calm', 'Bright', 'Bold', 'Gentle', 'Wise'];
      const animals = ['Fox', 'Owl', 'Bear', 'Wolf', 'Hawk', 'Deer', 'Robin', 'Badger', 'Otter', 'Lynx'];
      const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
      const animal = animals[Math.floor(Math.random() * animals.length)];
      const num = Math.floor(1000 + Math.random() * 9000);
      const friendlyName = `Guest ${adj} ${animal} ${num}`;
      const { data, error } = await client.auth.signInAnonymously({
        options: { data: { username: friendlyName, is_guest: true, guest_tag: tag } },
      });
      if (error) throw authFailure('Guest sign-in failed', error);
      return settleSession(
        { session: data.session, credentials: null },
        'Guest sign-in needs anonymous sign-ins enabled in Supabase Auth settings.'
      );
    },

    async signOut() {
      const { error } = await client.auth.signOut();
      if (error) throw new Error(`Sign out failed: ${error.message}`);
      // onAuthStateChange will clear cachedUser; do it eagerly too
      cachedUser = null;
      bqClearStoreCache();
      for (const cb of authListeners) {
        try {
          cb(null);
        } catch (err) {
          console.error('auth listener failed:', err);
        }
      }
    },

    getUser() {
      return cachedUser ? { user: { ...cachedUser } } : null;
    },

    onAuthChange(cb) {
      authListeners.add(cb);
      try {
        cb(cachedUser ? { ...cachedUser } : null);
      } catch (err) {
        console.error('auth listener failed:', err);
      }
      return () => authListeners.delete(cb);
    },

    // ---- account access (trials, paid, locks) ---------------------------------
    // The caller's own profile row: role, paid/lock state, trial window.
    // RLS "profiles_select_own_or_admin" allows reading your own row.
    // Accepts an optional explicit UID to avoid depending on the cachedUser
    // (which can race with onAuthStateChange during sign-in).
    async getAccessProfile(uidOverride) {
      const uid = uidOverride || requireUid();
      const { data, error } = await client
        .from('profiles')
        .select('id, username, role, is_guest, is_paid, is_locked, disabled_until, trial_started_at, trial_ends_at, created_at, account_type, device_store_id, must_change_password, is_master, account_kind')
        .eq('id', uid)
        .maybeSingle();
      if (error) throw new Error(`Loading account status failed: ${error.message}`);
      if (!data) {
        // The profile row is created by a DB trigger on signup. If it's not
        // there yet (trigger lag) or was never created, fail with a coded
        // error the UI can localize — never surface raw PostgREST text.
        const e = new Error('profile-missing');
        e.code = 'profile-missing';
        throw e;
      }
      return data;
    },

    // ---- administration (admin role only; enforced by RLS + trigger) ---------
    async adminListProfiles() {
      const { data, error } = await client
        .from('profiles')
        .select('id, username, display_name, role, is_guest, is_paid, is_locked, disabled_until, trial_started_at, trial_ends_at, created_at, account_type, created_by, device_store_id')
        .order('created_at', { ascending: false });
      if (error) throw new Error(`Listing accounts failed: ${error.message}`);
      return data ?? [];
    },

    // patch may contain is_paid, is_locked, disabled_until (ISO string|null).
    // The protect_profile_fields trigger rejects non-admin changes server-side.
    async adminUpdateProfile(id, patch) {
      if (!id) throw new Error('adminUpdateProfile needs a profile id.');
      const allowed = ['is_paid', 'is_locked', 'disabled_until'];
      const clean = {};
      for (const k of allowed) if (k in patch) clean[k] = patch[k];
      if (Object.keys(clean).length === 0) throw new Error('Nothing to update.');
      const { error } = await client.from('profiles').update(clean).eq('id', id);
      if (error) throw new Error(`Updating account failed: ${error.message}`);
    },

    // Admin-initiated password reset for any account (used on password-reset
    // support tickets). Server-side RPC checks the caller is a global admin,
    // enforces 8-200 chars, and invalidates the target's sessions.
    async adminResetPassword(userId, newPassword) {
      if (!userId) throw new Error('adminResetPassword needs a user id.');
      const { error } = await client.rpc('admin_reset_password', {
        target_user_id: userId,
        new_password: newPassword ?? '',
      });
      if (error) throw new Error(`Password reset failed: ${error.message}`);
    },

    // Factory reset (master account ONLY): wipes every account, every row
    // of application data and every stored file, then reseeds the master
    // account — the build returns to the exact state it ships in. The
    // server-side factory_reset() RPC verifies the caller is_master and
    // runs the wipe+reseed in a single transaction (failure-atomic). The
    // caller's own user row is deleted, so the app must sign out right
    // after this resolves. No automatic backup is taken server-side (the
    // backup mechanism is client-side) — the UI attempts a full account
    // backup + auto-download BEFORE calling this RPC and aborts the reset
    // if the backup attempt fails.
    async factoryReset() {
      const { error } = await client.rpc('factory_reset');
      if (error) throw new Error(`Factory reset failed: ${error.message}`);
    },

    // ---- Admin -> Users tab -------------------------------------------------
    // The Users tab (AdminPanel) manages login accounts: list, create,
    // delete, role, and lock. These back the buttons that previously called
    // functions that did not exist.

    // UI shape: { id, username, role, isGuest, disabled, createdAt, accountType, createdBy, deviceStoreId }.
    async adminListUsers() {
      const profiles = await this.adminListProfiles();
      return profiles.map((p) => ({
        id: p.id,
        username: p.username,
        displayName: p.display_name,
        role: p.role,
        isGuest: !!p.is_guest,
        disabled: !!p.is_locked,
        disabled_until: p.disabled_until || null,
        createdAt: p.created_at,
        accountType: p.account_type || 'full',
        createdBy: p.created_by || null,
        deviceStoreId: p.device_store_id || null,
      }));
    },

    async adminCreateUser({ username, password, role, accountType, storeId, shopRole }) {
      const { data, error } = await client.rpc('admin_create_user', {
        p_username: username,
        p_password: password,
        p_role: role || 'standard',
        p_account_type: accountType || 'full',
        p_store_id: storeId || null,
        p_shop_role: shopRole || 'cashier',
      });
      if (error) throw new Error(`Creating account failed: ${error.message}`);
      return data;
    },

    async adminDeleteUser(userId) {
      if (!userId) throw new Error('adminDeleteUser needs a user id.');
      const { error } = await client.rpc('admin_delete_user', {
        target_user_id: userId,
      });
      if (error) throw new Error(`Deleting account failed: ${error.message}`);
    },

    // patch: { role: 'admin'|'standard' } and/or { disabled: bool }.
    async adminUpdateUser(userId, patch) {
      if (!userId) throw new Error('adminUpdateUser needs a user id.');
      const p = patch || {};
      if (p.role !== undefined) {
        const { error } = await client.rpc('admin_set_role', {
          target_user_id: userId,
          new_role: p.role,
        });
        if (error) throw new Error(`Changing role failed: ${error.message}`);
      }
      if (p.disabled !== undefined) {
        await this.adminUpdateProfile(userId, { is_locked: !!p.disabled });
      }
    },

    // Change the signed-in admin's own password (verifies the current one).
    async changeOwnPassword({ currentPassword, newPassword }) {
      const { data: { user } } = await client.auth.getUser();
      if (!user?.email) throw new Error('Not signed in.');
      const next = String(newPassword ?? '');
      if (next.length < 8 || next.length > 200 || !/\S/.test(next)) {
        throw new Error('New password must be 8-200 characters and not blank.');
      }
      const { error: verifyError } = await client.auth.signInWithPassword({
        email: user.email,
        password: currentPassword,
      });
      if (verifyError) throw new Error('Current password is incorrect.');
      const { error } = await client.auth.updateUser({ password: next });
      if (error) throw new Error(`Changing password failed: ${error.message}`);
    },

    // Change the signed-in admin's own username.
    async changeOwnUsername(newUsername) {
      const { data: { user } } = await client.auth.getUser();
      if (!user) throw new Error('Not signed in.');
      const clean = String(newUsername ?? '').trim().toLowerCase()
        .replace(/[^a-z0-9._-]/g, '').slice(0, 64);
      if (clean.length < 3) throw new Error('Username must be at least 3 characters (letters, numbers, dot, underscore, dash).');
      const { error } = await client.from('profiles').update({ username: clean }).eq('id', user.id);
      if (error) {
        if (/duplicate|unique/i.test(error.message)) throw new Error('That username is already taken.');
        throw new Error(`Renaming failed: ${error.message}`);
      }
      return clean;
    },

    // ---- self-service password recovery (logged out) -------------------------
    // Sends a reset link to a real email address. Supabase replies the same
    // way whether or not the address has an account (no enumeration).
    async requestPasswordReset(email) {
      const clean = String(email ?? '').trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) {
        throw new Error('Enter a valid email address.');
      }
      // authflow=recovery marks the landing so consumeAuthCallback can tell
      // a password reset apart from a signup confirmation (both arrive as
      // ?code=).
      const redirectTo = appRootUrl({ authflow: 'recovery' });
      const { error } = await client.auth.resetPasswordForEmail(clean, { redirectTo });
      if (error) throw new Error(`Could not send reset email: ${error.message}`);
    },

    // Auth callback landing (one login, 2026-10-01). Consumes the URL after
    // an email link brings the user back — signup confirmations AND
    // password-recovery links both arrive here. Signup links carry
    // ?authflow=owner|customer (set as emailRedirectTo by signUpWithEmail);
    // recovery links carry ?authflow=recovery (set by requestPasswordReset);
    // links sent before this change carry no marker and fall back to the
    // same-device pending-flow record, then to legacy recovery semantics.
    //
    // Returns one of:
    //   { kind: 'confirmed', flow: { kind: 'owner'|'customer'|null, slug } }
    //   { kind: 'recovery' }            — force the new-password screen
    //   { kind: 'error', errorCode }     — e.g. errorCode 'otp_expired'
    //   { kind: 'none' }                — no callback in this URL
    //
    // One-time URL markers (code, authflow, error params) are stripped from
    // the address bar so a refresh never replays the landing.
    async consumeAuthCallback() {
      // Parse the boot-URL snapshot, NOT the live window.location.href:
      // supabase-js may already have cleared the hash by the time this runs.
      const parsed = parseAuthCallbackUrl(BOOT_HREF || (typeof window !== 'undefined' ? window.location.href : ''));

      const cleanUrl = () => {
        try {
          const url = new URL(window.location.href);
          for (const k of ['code', 'authflow', 'shop', 'error', 'error_code', 'error_description']) {
            url.searchParams.delete(k);
          }
          const hp = new URLSearchParams((url.hash || '').replace(/^#/, ''));
          for (const k of ['error', 'error_code', 'error_description', 'access_token', 'refresh_token', 'expires_in', 'token_type', 'type']) {
            hp.delete(k);
          }
          const rest = hp.toString();
          url.hash = rest ? `#${rest}` : '';
          window.history.replaceState(null, '', url.pathname + url.search + url.hash);
        } catch {
          /* non-fatal */
        }
      };

      if (parsed.kind === 'error') {
        cleanUrl();
        if (parsed.errorCode === 'otp_expired') {
          setAuthNotice({ kind: 'expired' });
        }
        return parsed;
      }

      if (parsed.kind === 'code' || parsed.kind === 'signup-implicit') {
        // Which flow? The URL's authflow marker wins (it survives
        // cross-device); the pending record is the same-device fallback.
        // An explicit authflow=recovery marker always wins over a stale
        // pending signup record.
        let authflow = parsed.authflow || null;
        let urlSlug = null;
        try {
          urlSlug = new URL(window.location.href).searchParams.get('shop');
        } catch {
          /* non-fatal */
        }
        if (authflow !== 'recovery' && !authflow) {
          const pending = readPendingFlow();
          if (pending) authflow = pending.kind;
        }
        const isSignup =
          authflow !== 'recovery' &&
          (authflow === 'owner' ||
            authflow === 'customer' ||
            parsed.kind === 'signup-implicit' ||
            !!readPendingFlow());
        if (parsed.kind === 'code') {
          const { data, error } = await client.auth.exchangeCodeForSession(parsed.code);
          cleanUrl();
          if (error) {
            if (isSignup) {
              if (/expired|invalid/i.test(error.message || '')) {
                setAuthNotice({ kind: 'expired' });
              }
              const e = new Error(`This confirmation link is invalid or expired: ${error.message}`);
              e.code = 'link-expired';
              throw e;
            }
            throw new Error(`This reset link is invalid or expired: ${error.message}`);
          }
          if (!data?.session) return { kind: 'none' };
        } else {
          // Implicit flow: supabase-js already turned the hash into a
          // session during client init.
          cleanUrl();
        }
        if (!isSignup) {
          // Unmarked ?code= with no signup markers anywhere: legacy
          // recovery semantics (exactly the pre-change behavior).
          try {
            localStorage.setItem('driftshop_recovery_pending', '1');
          } catch {
            /* non-fatal */
          }
          return { kind: 'recovery' };
        }
        let flow = resolveConfirmedFlow(authflow, urlSlug);
        if (!flow.kind) {
          // Cross-device confirm with no markers anywhere: the profile's
          // account_kind (stamped at signup by the DB trigger) answers.
          try {
            const { data: sess } = await client.auth.getSession();
            const uid = sess?.session?.user?.id;
            if (uid) {
              const p = await auth.getAccessProfile(uid);
              if (p?.account_kind === 'owner' || p?.account_kind === 'customer') {
                flow = { kind: p.account_kind, slug: flow.slug };
              }
            }
          } catch {
            /* best-effort */
          }
        }
        if (flow.kind === 'owner' || flow.kind === 'customer') {
          // Post-OAuth classification (2026-10-01): signInWithOAuth cannot
          // carry signup metadata, so fresh OAuth users land with
          // profiles.account_kind = NULL. Stamp it from the flow exactly
          // once; classifyAccountKind() + the RPC's WHERE account_kind IS
          // NULL guard make this a strict no-op for email signups (trigger
          // already stamped) and for already-classified accounts. Customer
          // shop routing (flow.slug) is untouched — the storefront still
          // links via linkShopCustomer after this returns.
          // Best-effort: the landing must never break because classification
          // failed; accessPolicy re-evaluates on the next profile load.
          try {
            const { data: sess } = await client.auth.getSession();
            const uid = sess?.session?.user?.id;
            if (uid) {
              const p = await auth.getAccessProfile(uid);
              if (classifyAccountKind(p?.account_kind, flow.kind)) {
                await client.rpc('classify_oauth_profile', { p_kind: flow.kind });
              }
            }
          } catch {
            /* best-effort: login proceeds, profile check happens on load */
          }
        }
        clearPendingFlow();
        return { kind: 'confirmed', flow };
      }

      if (parsed.kind === 'recovery-implicit') {
        cleanUrl();
        try {
          localStorage.setItem('driftshop_recovery_pending', '1');
        } catch {
          /* non-fatal */
        }
        clearPendingFlow();
        return { kind: 'recovery' };
      }

      return { kind: 'none' };
    },

    // True when a previous recovery-link landing is still waiting for the
    // user to choose a new password.
    recoveryPending() {
      try {
        return localStorage.getItem('driftshop_recovery_pending') === '1';
      } catch {
        return false;
      }
    },

    async clearRecoveryPending() {
      try {
        localStorage.removeItem('driftshop_recovery_pending');
      } catch {
        /* non-fatal */
      }
    },

    // Sets a new password for the currently signed-in (recovery) session.
    async updateOwnPassword(newPassword) {
      const pw = String(newPassword ?? '');
      if (pw.length < 8) throw new Error('Password must be at least 8 characters.');
      if (!/\S/.test(pw)) throw new Error('Password cannot be blank.');
      const { error } = await client.auth.updateUser({ password: pw });
      if (error) throw new Error(`Could not set new password: ${error.message}`);
    },

    // Clear the forced first-login password-change flag after the user has
    // chosen a new password (migration 056 seeds it true for the master
    // account). RLS + the protect_profile_fields trigger intentionally allow
    // a user to clear their OWN flag: it only gates a client-side prompt,
    // never a privilege.
    async clearMustChangePassword() {
      const uid = requireUid();
      const { error } = await client
        .from('profiles')
        .update({ must_change_password: false })
        .eq('id', uid);
      if (error) throw new Error(`Could not clear password-change flag: ${error.message}`);
    },
  };

  // ---- recovery: email-independent account recovery (migration 098) ------------
  // Three paths, none needing email:
  //   1. recovery codes (one-time, hashed at rest, single-use),
  //   2. security questions (salted + hashed answers),
  //   3. shop-owner assisted reset for team login accounts.
  // Every method degrades to a friendly "needs system update" error when
  // migration 098 has not been applied yet (capability probe pattern).
  const recovery = {
    /**
     * True when the recovery tables/RPCs exist (migration 098 applied) AND
     * the platform owner has not disabled recovery (migration 100 setting
     * recovery_enabled). Every UI entry point goes through this, so the
     * master kill-switch takes effect everywhere at once.
     */
    async isAvailable() {
      try {
        const s = await platformPublicSettings();
        if (String(s.recovery_enabled).toLowerCase() !== 'true') return false;
      } catch {
        /* settings unreadable: fall through to the table probe */
      }
      try {
        const { error } = await client.from('recovery_codes').select('id').limit(1);
        return !error || !/42P01|does not exist/i.test(error.message || '');
      } catch {
        return false;
      }
    },

    _needMigration() {
      const e = new Error('recovery-needs-update');
      e.code = 'recovery-needs-update';
      throw e;
    },

    _mapRedeemError(e) {
      const msg = String(e?.message || '');
      if (/too many attempts/i.test(msg)) {
        const err = new Error('recovery-rate-limited');
        err.code = 'recovery-rate-limited';
        throw err;
      }
      if (/invalid credentials/i.test(msg)) {
        const err = new Error('recovery-invalid');
        err.code = 'recovery-invalid';
        throw err;
      }
      if (/42P01|does not exist/i.test(msg)) {
        return this._needMigration();
      }
      throw e;
    },

    /** How many recovery codes to generate (platform setting, default 8). */
    async codesCount() {
      try {
        const s = await platformPublicSettings();
        const n = parseInt(s.recovery_codes_count, 10);
        return Number.isFinite(n) ? Math.max(4, Math.min(16, n)) : RECOVERY_CODE_COUNT;
      } catch {
        return RECOVERY_CODE_COUNT;
      }
    },

    /**
     * Generate a fresh set of recovery codes for the signed-in user.
     * Old unused codes are deleted first. Returns the PLAINTEXT codes —
     * the caller must show them to the user exactly once.
     */
    async generateCodes() {
      const uid = requireUid();
      const codes = generateRecoveryCodes(await this.codesCount());
      const rows = [];
      for (const code of codes) {
        rows.push({ user_id: uid, code_hash: await hashRecoveryCode(code), label: 'recovery' });
      }
      // Replace any previous codes (old ones stop working).
      const del = await client.from('recovery_codes').delete().eq('user_id', uid);
      if (del.error) {
        if (/42P01|does not exist/i.test(del.error.message || '')) this._needMigration();
        throw new Error(`Could not replace recovery codes: ${del.error.message}`);
      }
      const { error } = await client.from('recovery_codes').insert(rows);
      if (error) {
        if (/42P01|does not exist/i.test(error.message || '')) this._needMigration();
        throw new Error(`Could not save recovery codes: ${error.message}`);
      }
      return codes;
    },

    /** How many unused recovery codes the signed-in user has left (null when 098 missing). */
    async unusedCodeCount() {
      const uid = requireUid();
      const { count, error } = await client
        .from('recovery_codes')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', uid)
        .is('used_at', null);
      if (error) {
        if (/42P01|does not exist/i.test(error.message || '')) return null;
        throw new Error(`Could not check recovery codes: ${error.message}`);
      }
      return count ?? 0;
    },

    /**
     * Set (or replace) the signed-in user's security questions.
     * items: [{ question, answer } x3]. Answers are salted+hashed
     * client-side; the server only stores hashes.
     */
    async setSecurityQuestions(items) {
      const v = validateSecurityQuestions(items);
      if (!v.ok) {
        const e = new Error(`security-questions-${v.code}`);
        e.code = `security-questions-${v.code}`;
        throw e;
      }
      const uid = requireUid();
      const salt = generateSalt();
      const questions = items.map((it) => ({ key: String(it.question).trim().slice(0, 200) }));
      const answer_hashes = [];
      for (const it of items) answer_hashes.push(await hashSecurityAnswer(it.answer, salt));
      const { error } = await client.from('security_questions').upsert(
        {
          user_id: uid,
          salt,
          questions,
          answer_hashes,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'user_id' }
      );
      if (error) {
        if (/42P01|does not exist/i.test(error.message || '')) this._needMigration();
        throw new Error(`Could not save security questions: ${error.message}`);
      }
    },

    /** The signed-in user's security questions (prompts only, no answers). Null when 098 missing. */
    async getMyQuestions() {
      const uid = requireUid();
      const { data, error } = await client
        .from('security_questions')
        .select('questions')
        .eq('user_id', uid)
        .maybeSingle();
      if (error) {
        if (/42P01|does not exist/i.test(error.message || '')) return null;
        throw new Error(`Could not load security questions: ${error.message}`);
      }
      return Array.isArray(data?.questions) ? data.questions : [];
    },

    /** Logged out: fetch the security-question prompts for a login id. */
    async getQuestionsForLogin(login) {
      try {
        const { data, error } = await client.rpc('get_recovery_questions', {
          p_login: String(login ?? ''),
        });
        if (error) throw error;
        return Array.isArray(data) ? data : [];
      } catch (e) {
        if (/42P01|does not exist/i.test(e?.message || '')) this._needMigration();
        throw e;
      }
    },

    /** Logged out: redeem a recovery code to set a new password. */
    async redeemCode({ login, code, newPassword }) {
      const v = validateRedeemInput({ login, newPassword });
      if (!v.ok) {
        const e = new Error(`redeem-${v.code}`);
        e.code = `redeem-${v.code}`;
        throw e;
      }
      if (!normalizeRecoveryCode(code)) {
        const e = new Error('redeem-code-required');
        e.code = 'redeem-code-required';
        throw e;
      }
      try {
        const { error } = await client.rpc('redeem_recovery_code', {
          p_login: String(login).trim(),
          p_code: normalizeRecoveryCode(code),
          p_new_password: String(newPassword),
        });
        if (error) throw error;
      } catch (e) {
        this._mapRedeemError(e);
      }
    },

    /** Logged out: answer security questions to set a new password. */
    async redeemAnswers({ login, answers, newPassword }) {
      const v = validateRedeemInput({ login, newPassword });
      if (!v.ok) {
        const e = new Error(`redeem-${v.code}`);
        e.code = `redeem-${v.code}`;
        throw e;
      }
      if (!Array.isArray(answers) || answers.length !== 3) {
        const e = new Error('redeem-answers-required');
        e.code = 'redeem-answers-required';
        throw e;
      }
      try {
        const { error } = await client.rpc('redeem_security_answers', {
          p_login: String(login).trim(),
          p_answers: answers.map((a) => String(a ?? '')),
          p_new_password: String(newPassword),
        });
        if (error) throw error;
      } catch (e) {
        this._mapRedeemError(e);
      }
    },

    /**
     * Shop owner/manager: list the shop's team login accounts.
     * The server enforces the owner/manager relationship.
     */
    async listTeamLogins(storeId) {
      if (!storeId) throw new Error('listTeamLogins needs a store id.');
      const { data, error } = await client.rpc('shop_list_team_logins', {
        p_store_id: storeId,
      });
      if (error) {
        if (/42P01|does not exist/i.test(error.message || '')) this._needMigration();
        if (/not authorized/i.test(error.message || '')) {
          const e = new Error('team-no-permission');
          e.code = 'team-no-permission';
          throw e;
        }
        throw new Error(`Could not load team accounts: ${error.message}`);
      }
      return (Array.isArray(data) ? data : []).map((r) => ({
        userId: r.user_id,
        username: r.username,
        displayName: r.display_name,
        shopRole: r.shop_role,
        accountType: r.account_type,
        createdAt: r.created_at,
      }));
    },

    /** Shop owner/manager: reset a team member's password (no email). */
    async resetTeamPassword(userId, newPassword) {
      if (!userId) throw new Error('resetTeamPassword needs a user id.');
      const pw = String(newPassword ?? '');
      if (pw.length < 8 || pw.length > 200 || !/\S/.test(pw)) {
        const e = new Error('redeem-password-invalid');
        e.code = 'redeem-password-invalid';
        throw e;
      }
      const { error } = await client.rpc('shop_reset_staff_password', {
        p_target_user_id: userId,
        p_new_password: pw,
      });
      if (error) {
        if (/42P01|does not exist/i.test(error.message || '')) this._needMigration();
        if (/not authorized/i.test(error.message || '')) {
          const e = new Error('team-no-permission');
          e.code = 'team-no-permission';
          throw e;
        }
        throw new Error(`Password reset failed: ${error.message}`);
      }
    },
  };

  // ---- profile: display identity (backup/restore) --------------------------------
  // Harmless display fields only — role/paid/lock/trial are guarded by the
  // protect_profile_fields trigger and never travel in a backup.
  const profile = {
    async get() {
      const uid = requireUid();
      const { data, error } = await client
        .from('profiles')
        .select('username, display_name, avatar_url')
        .eq('id', uid)
        .maybeSingle();
      if (error) throw new Error(`Loading profile failed: ${error.message}`);
      return {
        username: data?.username ?? null,
        displayName: data?.display_name ?? null,
        avatarUrl: data?.avatar_url ?? null,
      };
    },

    async update(patch) {
      const uid = requireUid();
      const clean = {};
      if (patch.displayName !== undefined) {
        // Trim: a whitespace-only display name would otherwise persist as
        // invisible blank text throughout the UI. Empty -> null (no name).
        const dn = String(patch.displayName ?? '').trim();
        clean.display_name = dn || null;
      }
      if (patch.avatarUrl !== undefined) clean.avatar_url = patch.avatarUrl || null;
      if (patch.username !== undefined) {
        const name = String(patch.username ?? '').trim();
        if (!name) throw new Error('Username cannot be empty.');
        clean.username = name;
      }
      if (Object.keys(clean).length === 0) return this.get();
      const { error } = await client.from('profiles').update(clean).eq('id', uid);
      if (error) {
        // Username taken on the new account — restore everything else and
        // report the conflict instead of failing the whole profile.
        if (clean.username && /duplicate|unique/i.test(error.message)) {
          delete clean.username;
          const retry = await client.from('profiles').update(clean).eq('id', uid);
          if (retry.error) throw new Error(`Updating profile failed: ${retry.error.message}`);
          const p = await this.get();
          p.usernameConflict = true;
          return p;
        }
        throw new Error(`Updating profile failed: ${error.message}`);
      }
      return this.get();
    },
  };

  // ---- settings ------------------------------------------------------------------
  const settings = {
    async get() {
      const uid = requireUid();
      const res = await client
        .from('user_settings')
        .select('visual_theme, wallpaper, accent_override, ai_engine, icon_positions, welcome_seen, welcome_tour_seen')
        .eq('user_id', uid)
        .maybeSingle();
      if (res.error) throw new Error(`Loading settings failed: ${res.error.message}`);
      return {
        ...DEFAULT_SETTINGS,
        ...(res.data ?? {}),
        ui_scale: readUiScale(),
        desktop_icons: readDesktopIcons(),
        hidden_from_start: readIdList(HIDDEN_FROM_START_KEY, []),
        desktop_icon_order: readIdList(ICON_ORDER_KEY, []),
        taskbar_position: readTaskbarPosition(),
        ui_style: readUiStyle(),
        touch_mode: readTouchMode(),
      };
    },

    async update(patch) {
      if (!patch || typeof patch !== 'object') throw new Error('Settings patch must be an object.');
      const uid = requireUid();
      const allowed = ['visual_theme', 'wallpaper', 'accent_override', 'ai_engine', 'icon_positions', 'welcome_seen', 'welcome_tour_seen', 'desktop_icons', 'hidden_from_start', 'desktop_icon_order'];
      const clean = {};
      let uiScale = null;
      let desktopIcons = null;
      let desktopIconsTouched = false;
      for (const [key, value] of Object.entries(patch)) {
        if (key === 'ui_scale') {
          uiScale = value;
          continue;
        }
        if (key === 'desktop_icons') {
          desktopIcons = value;
          desktopIconsTouched = true;
          continue;
        }
        if (key === 'hidden_from_start') {
          writeIdList(HIDDEN_FROM_START_KEY, value, 'hidden_from_start');
          continue;
        }
        if (key === 'desktop_icon_order') {
          writeIdList(ICON_ORDER_KEY, value, 'desktop_icon_order');
          continue;
        }
        if (key === 'taskbar_position') {
          writeTaskbarPosition(value);
          continue;
        }
        if (key === 'ui_style') {
          writeUiStyle(value);
          continue;
        }
        if (key === 'touch_mode') {
          writeTouchMode(value);
          continue;
        }
        if (!allowed.includes(key)) throw new Error(`Unknown setting: "${key}".`);
        clean[key] = value;
      }
      if (uiScale !== null && uiScale !== undefined) writeUiScale(uiScale);
      if (desktopIconsTouched) writeDesktopIcons(desktopIcons);
      if (Object.keys(clean).length === 0) {
        const current = await this.get();
        return current;
      }
      const row = check(
        await client
          .from('user_settings')
          .upsert({ user_id: uid, ...clean }, { onConflict: 'user_id' })
          .select('visual_theme, wallpaper, accent_override, ai_engine, icon_positions, welcome_seen, welcome_tour_seen')
          .single(),
        'Saving settings'
      );
      return {
        ...DEFAULT_SETTINGS,
        ...row,
        ui_scale: readUiScale(),
        desktop_icons: readDesktopIcons(),
        hidden_from_start: readIdList(HIDDEN_FROM_START_KEY, []),
        desktop_icon_order: readIdList(ICON_ORDER_KEY, []),
        taskbar_position: readTaskbarPosition(),
        ui_style: readUiStyle(),
        touch_mode: readTouchMode(),
      };
    },
  };

  // ---- files -----------------------------------------------------------------------
  const files = {
    async list(path) {
      const uid = requireUid();
      const segs = splitPath(path);
      const folder = await resolveFolder(uid, segs, false);
      if (!folder) throw new Error(`Folder not found: ${path}`);
      const subfolders = check(
        await client
          .from('vfs_folders')
          .select('id, name, updated_at')
          .eq('user_id', uid)
          .eq('parent_id', folder.id)
          .order('name'),
        'Listing folders'
      );
      const subfiles = check(
        await client
          .from('vfs_files')
          .select('id, name, mime_type, size_bytes, updated_at')
          .eq('user_id', uid)
          .eq('folder_id', folder.id)
          .order('name'),
        'Listing files'
      );
      const base = joinPath(segs);
      return [
        ...subfolders.map((f) => toEntry(f, 'folder', `${base}/${f.name}`)),
        ...subfiles.map((f) => toEntry(f, 'file', `${base}/${f.name}`)),
      ];
    },

    async read(path) {
      const uid = requireUid();
      const segs = splitPath(path);
      if (segs.length === 0) throw new Error('Cannot read the root folder.');
      const parent = await resolveFolder(uid, segs.slice(0, -1), false);
      if (!parent) throw new Error(`File not found: ${path}`);
      const name = segs[segs.length - 1];
      const file = await findFile(uid, parent.id, name);
      if (!file) {
        // distinguish "it's a folder" from "nothing here"
        const maybeFolder = await resolveFolder(uid, segs, false);
        if (maybeFolder) throw new Error(`${path} is a folder.`);
        throw new Error(`File not found: ${path}`);
      }
      if (file.is_binary) {
        if (file.mime_type && file.mime_type.startsWith('text/') && file.storage_path) {
          // Large text stored via the binary path — decode the bytes back to
          // text so big files reopen instead of throwing IS_BINARY.
          const { data, error } = await client.storage
            .from(PIN_FILES_BUCKET)
            .download(file.storage_path);
          if (error) throw new Error(`Could not load file: ${error.message}`);
          return { text: await data.text() };
        }
        const err = new Error(`Cannot preview binary file: ${path}`);
        err.code = 'IS_BINARY';
        throw err;
      }
      return { text: file.content_text ?? '' };
    },

    // Raw bytes for any file (binary or text) — the backup path to a
    // base64 data URL. Storage-backed files download from the bucket;
    // inline text rows are re-encoded from their stored content.
    async downloadBlob(path) {
      const uid = requireUid();
      const segs = splitPath(path);
      if (segs.length === 0) throw new Error('Cannot download the root folder.');
      const parent = await resolveFolder(uid, segs.slice(0, -1), false);
      if (!parent) throw new Error(`File not found: ${path}`);
      const file = await findFile(uid, parent.id, segs[segs.length - 1]);
      if (!file) throw new Error(`File not found: ${path}`);
      if (file.storage_path) {
        const { data, error } = await client.storage.from(PIN_FILES_BUCKET).download(file.storage_path);
        if (error) throw new Error(`Could not download file: ${error.message}`);
        return data;
      }
      return new Blob([file.content_text ?? ''], { type: file.mime_type || 'text/plain' });
    },

    async write(path, text) {
      if (typeof text !== 'string') throw new Error('write() accepts text only.');
      const bytes = byteLength(text);
      if (bytes > MAX_FILE_BYTES) {
        // Large text: ride the binary upload path (text/plain Blob,
        // is_binary=true) instead of failing — read() decodes it back to
        // text above, so big files save AND reopen. 50 MB cap still applies.
        return this.upload(path, new Blob([text], { type: 'text/plain' }));
      }
      const uid = requireUid();
      const segs = splitPath(path);
      if (segs.length === 0) throw new Error('Cannot write to the root folder.');
      const parent = await resolveFolder(uid, segs.slice(0, -1), true);
      const name = segs[segs.length - 1];
      const existing = await findFile(uid, parent.id, name);
      const oldStoragePath = existing?.storage_path || null;
      const payload = {
        user_id: uid,
        folder_id: parent.id,
        name,
        mime_type: 'text/plain',
        size_bytes: bytes,
        is_binary: false,
        content_text: text,
        storage_path: null,
      };
      let row;
      if (existing) {
        row = check(
          await client.from('vfs_files').update(payload).eq('id', existing.id).select().single(),
          'Saving file'
        );
      } else {
        row = check(await client.from('vfs_files').insert(payload).select().single(), 'Creating file');
      }
      // Delete the old storage object ONLY after the DB write succeeded —
      // otherwise a DB failure would orphan the row pointing at deleted bytes.
      if (oldStoragePath) await removePinFileQuietly(oldStoragePath);
      return toEntry(row, 'file', path);
    },

    // Binary upload: bytes go to the private user-files bucket (same as pin
    // files); the vfs_files row keeps is_binary=true + storage_path.
    // Binary upload for cloud mode. onProgress(sentBytes, totalBytes) is
    // optional; when given, the bytes go up over XMLHttpRequest (the
    // Supabase client's fetch-based upload exposes no progress events) so
    // the UI can show a REAL percentage — never a fake one.
    async upload(path, blob, onProgress) {
      if (!(blob instanceof Blob)) throw new Error('upload() needs a file or blob.');
      if (blob.size > MAX_UPLOAD_BYTES) {
        throw new Error(
          `File too large (${Math.round(blob.size / 1024 / 1024)} MB) — uploads are limited to 50 MB.`
        );
      }
      const uid = requireUid();
      const segs = splitPath(path);
      if (segs.length === 0) throw new Error('Cannot upload to the root folder.');
      const parent = await resolveFolder(uid, segs.slice(0, -1), true);
      const name = segs[segs.length - 1];
      const safe = name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80) || 'file';
      const storagePath = `${uid}/vfs/${newUuid()}/${safe}`;
      try {
        await storageUploadXhrBound({
          bucket: PIN_FILES_BUCKET,
          storagePath,
          blob,
          upsert: false,
          onProgress: typeof onProgress === 'function' ? onProgress : null,
        });
      } catch (err) {
        throw new Error(`Uploading file failed: ${err?.message || 'upload failed.'}`);
      }
      const existing = await findFile(uid, parent.id, name);
      const oldStoragePath = existing?.storage_path || null;
      const payload = {
        user_id: uid,
        folder_id: parent.id,
        name,
        mime_type: blob.type || 'application/octet-stream',
        size_bytes: blob.size,
        is_binary: true,
        content_text: null,
        storage_path: storagePath,
      };
      let row;
      try {
        if (existing) {
          row = check(
            await client.from('vfs_files').update(payload).eq('id', existing.id).select().single(),
            'Saving file'
          );
        } else {
          row = check(
            await client.from('vfs_files').insert(payload).select().single(),
            'Uploading file'
          );
        }
      } catch (dbErr) {
        // M11: DB failed after storage upload — delete the orphaned object.
        await removePinFileQuietly(storagePath);
        throw dbErr;
      }
      // Delete the old storage object ONLY after the DB write succeeded.
      if (oldStoragePath) await removePinFileQuietly(oldStoragePath);
      return toEntry(row, 'file', path);
    },

    // Resolve a fresh signed URL for a binary file's bytes.
    async fileUrl(path) {
      const uid = requireUid();
      const segs = splitPath(path);
      if (segs.length === 0) throw new Error('Cannot resolve the root folder.');
      const parent = await resolveFolder(uid, segs.slice(0, -1), false);
      if (!parent) throw new Error(`File not found: ${path}`);
      const file = await findFile(uid, parent.id, segs[segs.length - 1]);
      if (!file?.storage_path) throw new Error('This file has no downloadable bytes.');
      const { data, error } = await client.storage
        .from(PIN_FILES_BUCKET)
        .createSignedUrl(file.storage_path, 3600);
      if (error) throw new Error(`Could not load file: ${error.message}`);
      return { url: data.signedUrl, mime: file.mime_type, name: file.name };
    },

    async mkdir(path) {
      const uid = requireUid();
      const segs = splitPath(path);
      if (segs.length === 0) return toEntry(await rootFolder(uid), 'folder', '/');
      const folder = await resolveFolder(uid, segs, true);
      return toEntry(folder, 'folder', path);
    },

    async remove(path) {
      const uid = requireUid();
      const segs = splitPath(path);
      if (segs.length === 0) throw new Error('Cannot remove the root folder.');
      const parent = await resolveFolder(uid, segs.slice(0, -1), false);
      if (!parent) throw new Error(`Nothing found at ${path}.`);
      const name = segs[segs.length - 1];
      const file = await findFile(uid, parent.id, name);
      if (file) {
        check(await client.from('vfs_files').delete().eq('id', file.id), 'Deleting file');
        if (file.storage_path) await removePinFileQuietly(file.storage_path);
        return;
      }
      const folder = await resolveFolder(uid, segs, false);
      if (!folder) throw new Error(`Nothing found at ${path}.`);
      // M12: Collect descendant files' storage paths BEFORE the cascade
      // delete, so their bytes don't orphan in the bucket.
      const storagePaths = [];
      try {
        const folderIds = [folder.id];
        const queue = [folder.id];
        while (queue.length > 0) {
          const fid = queue.shift();
          const { data: children } = await client
            .from('vfs_folders')
            .select('id')
            .eq('user_id', uid)
            .eq('parent_id', fid);
          for (const c of (children || [])) {
            folderIds.push(c.id);
            queue.push(c.id);
          }
        }
        const { data: files } = await client
          .from('vfs_files')
          .select('storage_path')
          .eq('user_id', uid)
          .in('folder_id', folderIds)
          .not('storage_path', 'is', null);
        for (const f of (files || [])) {
          if (f.storage_path) storagePaths.push(f.storage_path);
        }
      } catch {}
      // cascade deletes children server-side
      check(await client.from('vfs_folders').delete().eq('id', folder.id), 'Deleting folder');
      // Clean up orphaned storage objects.
      for (const sp of storagePaths) {
        await removePinFileQuietly(sp);
      }
    },

    async rename(oldPath, newPath) {
      const uid = requireUid();
      const oldSegs = splitPath(oldPath);
      const newSegs = splitPath(newPath);
      if (oldSegs.length === 0 || newSegs.length === 0) {
        throw new Error('Cannot rename the root folder.');
      }
      if (oldPath === newPath) return;
      const oldParent = await resolveFolder(uid, oldSegs.slice(0, -1), false);
      if (!oldParent) throw new Error(`Nothing found at ${oldPath}.`);
      const oldName = oldSegs[oldSegs.length - 1];
      const file = await findFile(uid, oldParent.id, oldName);
      const folder = file ? null : await resolveFolder(uid, oldSegs, false);
      if (!file && !folder) throw new Error(`Nothing found at ${oldPath}.`);
      const newParent = await resolveFolder(uid, newSegs.slice(0, -1), true);
      const newName = newSegs[newSegs.length - 1];
      if (await findFile(uid, newParent.id, newName)) {
        throw new Error(`A file named "${newName}" already exists there.`);
      }
      const collidingFolder = check(
        await client
          .from('vfs_folders')
          .select('id')
          .eq('user_id', uid)
          .eq('parent_id', newParent.id)
          .eq('name', newName)
          .maybeSingle(),
        'Checking for a name clash'
      );
      if (collidingFolder) throw new Error(`A folder named "${newName}" already exists there.`);
      if (folder) {
        // refuse to move a folder into itself or one of its descendants:
        // walk the destination's ancestor chain and compare ids
        const np = check(
          await client.from('vfs_folders').select('parent_id').eq('id', newParent.id).single(),
          'Resolving destination'
        );
        let ancestorId = np.parent_id;
        let guard = 0;
        while (ancestorId && guard++ < 100) {
          if (ancestorId === folder.id) throw new Error('Cannot move a folder into itself.');
          const a = check(
            await client.from('vfs_folders').select('parent_id').eq('id', ancestorId).single(),
            'Resolving destination'
          );
          ancestorId = a.parent_id;
        }
        check(
          await client
            .from('vfs_folders')
            .update({ name: newName, parent_id: newParent.id })
            .eq('id', folder.id),
          'Renaming folder'
        );
      } else {
        check(
          await client
            .from('vfs_files')
            .update({ name: newName, folder_id: newParent.id })
            .eq('id', file.id),
          'Renaming file'
        );
      }
    },
  };

  // ---- shop files (migration 066+) ----------------------------------------------
  // Shop scope is the files namespace with the owner key swapped: rows carry
  // store_id instead of being matched on user_id, so every member of the
  // shop sees the same area. Personal rows are untouched — they keep
  // store_id = NULL and remain visible only to their owner.
  let vfsShopProbe = null;
  async function vfsHasShopScope() {
    if (vfsShopProbe !== null) return vfsShopProbe;
    try {
      const res = await client.from('vfs_folders').select('store_id').limit(1);
      vfsShopProbe = !res.error || !/42703|does not exist/i.test(res.error.message || '');
    } catch {
      vfsShopProbe = false;
    }
    return vfsShopProbe;
  }
  async function requireShopScope() {
    if (!(await vfsHasShopScope())) {
      throw new Error(
        'Shop files need a database update to work. Ask the shop owner to run the latest update, then try again. / ' +
          'Les fichiers de la boutique nécessitent une mise à jour de la base de données. Demandez au propriétaire de la boutique d\u2019appliquer la dernière mise à jour, puis réessayez.'
      );
    }
  }

  // Lazily created shared root for a store. Race-safe: two members creating
  // at once converge on one row via the shop-root unique index.
  async function shopRootFolder(storeId) {
    await requireShopScope();
    // Use limit(1) instead of maybeSingle(): if duplicate shop roots exist,
    // pick the oldest rather than throwing.
    const firstRes = await client
      .from('vfs_folders')
      .select('id, name, updated_at')
      .eq('store_id', storeId)
      .is('parent_id', null)
      .order('created_at', { ascending: true })
      .limit(1);
    const first = check(firstRes, 'Loading the shop folder');
    if (first && first.length > 0) return first[0];
    try {
      return check(
        await client
          .from('vfs_folders')
          .insert({ user_id: requireUid(), parent_id: null, name: 'shop', store_id: storeId })
          .select('id, name, updated_at')
          .single(),
        'Creating the shop folder'
      );
    } catch (err) {
      if (!/23505|duplicate|unique/i.test(err?.message || '')) throw err;
      return check(
        await client
          .from('vfs_folders')
          .select('id, name, updated_at')
          .eq('store_id', storeId)
          .is('parent_id', null)
          .maybeSingle(),
        'Loading the shop folder'
      );
    }
  }

  async function shopResolveFolder(storeId, segments, create) {
    await requireShopScope();
    let folder = await shopRootFolder(storeId);
    for (const seg of segments) {
      const res = await client
        .from('vfs_folders')
        .select('id, name, updated_at')
        .eq('store_id', storeId)
        .eq('parent_id', folder.id)
        .eq('name', seg)
        .maybeSingle();
      if (res.error) throw new Error(`Resolving folder "${seg}" failed: ${res.error.message}`);
      let row = res.data;
      if (!row) {
        if (!create) return null;
        row = check(
          await client
            .from('vfs_folders')
            .insert({ user_id: requireUid(), parent_id: folder.id, name: seg, store_id: storeId })
            .select('id, name, updated_at')
            .single(),
          `Creating folder "${seg}"`
        );
      }
      folder = row;
    }
    return folder;
  }

  async function shopFindFile(storeId, folderId, name) {
    const res = await client
      .from('vfs_files')
      .select('id, name, mime_type, size_bytes, is_binary, storage_path, content_text, updated_at')
      .eq('store_id', storeId)
      .eq('folder_id', folderId)
      .eq('name', name)
      .maybeSingle();
    if (res.error) throw new Error(`Looking up file "${name}" failed: ${res.error.message}`);
    return res.data;
  }

  const shopFiles = {
    async list(storeId, path) {
      const segs = splitPath(path);
      const folder = await shopResolveFolder(storeId, segs, false);
      if (!folder) throw new Error(`Folder not found: ${path}`);
      const subfolders = check(
        await client
          .from('vfs_folders')
          .select('id, name, updated_at')
          .eq('store_id', storeId)
          .eq('parent_id', folder.id)
          .order('name'),
        'Listing folders'
      );
      const subfiles = check(
        await client
          .from('vfs_files')
          .select('id, name, mime_type, size_bytes, updated_at')
          .eq('store_id', storeId)
          .eq('folder_id', folder.id)
          .order('name'),
        'Listing files'
      );
      const base = joinPath(segs);
      return [
        ...subfolders.map((f) => toEntry(f, 'folder', `${base}/${f.name}`)),
        ...subfiles.map((f) => toEntry(f, 'file', `${base}/${f.name}`)),
      ];
    },

    async read(storeId, path) {
      const segs = splitPath(path);
      if (segs.length === 0) throw new Error('Cannot read the root folder.');
      const parent = await shopResolveFolder(storeId, segs.slice(0, -1), false);
      if (!parent) throw new Error(`File not found: ${path}`);
      const file = await shopFindFile(storeId, parent.id, segs[segs.length - 1]);
      if (!file) {
        const maybeFolder = await shopResolveFolder(storeId, segs, false);
        if (maybeFolder) throw new Error(`${path} is a folder.`);
        throw new Error(`File not found: ${path}`);
      }
      if (file.is_binary) {
        if (file.mime_type && file.mime_type.startsWith('text/') && file.storage_path) {
          const { data, error } = await client.storage
            .from(PIN_FILES_BUCKET)
            .download(file.storage_path);
          if (error) throw new Error(`Could not load file: ${error.message}`);
          return { text: await data.text() };
        }
        const err = new Error(`Cannot preview binary file: ${path}`);
        err.code = 'IS_BINARY';
        throw err;
      }
      return { text: file.content_text ?? '' };
    },

    async downloadBlob(storeId, path) {
      const segs = splitPath(path);
      if (segs.length === 0) throw new Error('Cannot download the root folder.');
      const parent = await shopResolveFolder(storeId, segs.slice(0, -1), false);
      if (!parent) throw new Error(`File not found: ${path}`);
      const file = await shopFindFile(storeId, parent.id, segs[segs.length - 1]);
      if (!file) throw new Error(`File not found: ${path}`);
      if (file.storage_path) {
        const { data, error } = await client.storage.from(PIN_FILES_BUCKET).download(file.storage_path);
        if (error) throw new Error(`Could not download file: ${error.message}`);
        return data;
      }
      return new Blob([file.content_text ?? ''], { type: file.mime_type || 'text/plain' });
    },

    async write(storeId, path, text) {
      if (typeof text !== 'string') throw new Error('write() accepts text only.');
      const bytes = byteLength(text);
      if (bytes > MAX_FILE_BYTES) {
        return this.upload(storeId, path, new Blob([text], { type: 'text/plain' }));
      }
      const segs = splitPath(path);
      if (segs.length === 0) throw new Error('Cannot write to the root folder.');
      const parent = await shopResolveFolder(storeId, segs.slice(0, -1), true);
      const name = segs[segs.length - 1];
      const existing = await shopFindFile(storeId, parent.id, name);
      if (existing?.storage_path) await removePinFileQuietly(existing.storage_path);
      const payload = {
        user_id: requireUid(),
        store_id: storeId,
        folder_id: parent.id,
        name,
        mime_type: 'text/plain',
        size_bytes: bytes,
        is_binary: false,
        content_text: text,
        storage_path: null,
      };
      let row;
      if (existing) {
        row = check(
          await client.from('vfs_files').update(payload).eq('id', existing.id).select().single(),
          'Saving file'
        );
      } else {
        row = check(await client.from('vfs_files').insert(payload).select().single(), 'Creating file');
      }
      return toEntry(row, 'file', path);
    },

    // Binary upload for shop scope. Bytes go to the private user-files
    // bucket under shop/<store-id>/…; the vfs_files row keeps the same
    // is_binary=true + storage_path shape as personal files.
    async upload(storeId, path, blob, onProgress) {
      if (!(blob instanceof Blob)) throw new Error('upload() needs a file or blob.');
      if (blob.size > MAX_UPLOAD_BYTES) {
        throw new Error(
          `File too large (${Math.round(blob.size / 1024 / 1024)} MB) — uploads are limited to 50 MB.`
        );
      }
      const segs = splitPath(path);
      if (segs.length === 0) throw new Error('Cannot upload to the root folder.');
      const parent = await shopResolveFolder(storeId, segs.slice(0, -1), true);
      const name = segs[segs.length - 1];
      const safe = name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80) || 'file';
      const storagePath = `shop/${storeId}/${newUuid()}/${safe}`;
      try {
        await storageUploadXhrBound({
          bucket: PIN_FILES_BUCKET,
          storagePath,
          blob,
          upsert: false,
          onProgress: typeof onProgress === 'function' ? onProgress : null,
        });
      } catch (err) {
        throw new Error(`Uploading file failed: ${err?.message || 'upload failed.'}`);
      }
      const existing = await shopFindFile(storeId, parent.id, name);
      if (existing?.storage_path) await removePinFileQuietly(existing.storage_path);
      const payload = {
        user_id: requireUid(),
        store_id: storeId,
        folder_id: parent.id,
        name,
        mime_type: blob.type || 'application/octet-stream',
        size_bytes: blob.size,
        is_binary: true,
        content_text: null,
        storage_path: storagePath,
      };
      let row;
      if (existing) {
        row = check(
          await client.from('vfs_files').update(payload).eq('id', existing.id).select().single(),
          'Saving file'
        );
      } else {
        row = check(
          await client.from('vfs_files').insert(payload).select().single(),
          'Uploading file'
        );
      }
      return toEntry(row, 'file', path);
    },

    // Resolve a fresh signed URL for a binary file's bytes.
    async fileUrl(storeId, path) {
      const segs = splitPath(path);
      if (segs.length === 0) throw new Error('Cannot resolve the root folder.');
      const parent = await shopResolveFolder(storeId, segs.slice(0, -1), false);
      if (!parent) throw new Error(`File not found: ${path}`);
      const file = await shopFindFile(storeId, parent.id, segs[segs.length - 1]);
      if (!file?.storage_path) throw new Error('This file has no downloadable bytes.');
      const { data, error } = await client.storage
        .from(PIN_FILES_BUCKET)
        .createSignedUrl(file.storage_path, 3600);
      if (error) throw new Error(`Could not load file: ${error.message}`);
      return { url: data.signedUrl, mime: file.mime_type, name: file.name };
    },

    // Per-shop storage readout (Admin → Shops): how much the shop's
    // shared files take up. size_bytes is recorded for every file at
    // upload (inline text and storage-backed alike), so summing it is
    // honest without listing a single byte of content. RLS limits the
    // rows to shop members — a non-member sees an empty sum.
    async usageBytes(storeId) {
      const rows = check(
        await client.from('vfs_files').select('size_bytes').eq('store_id', storeId),
        'Measuring shop files'
      );
      let bytes = 0;
      for (const r of rows) bytes += Number(r.size_bytes) || 0;
      return { bytes, files: rows.length };
    },

    async mkdir(storeId, path) {
      const segs = splitPath(path);
      if (segs.length === 0) return toEntry(await shopRootFolder(storeId), 'folder', '/');
      const folder = await shopResolveFolder(storeId, segs, true);
      return toEntry(folder, 'folder', path);
    },

    async remove(storeId, path) {
      const segs = splitPath(path);
      if (segs.length === 0) throw new Error('Cannot remove the root folder.');
      const parent = await shopResolveFolder(storeId, segs.slice(0, -1), false);
      if (!parent) throw new Error(`Nothing found at ${path}.`);
      const name = segs[segs.length - 1];
      const file = await shopFindFile(storeId, parent.id, name);
      if (file) {
        check(await client.from('vfs_files').delete().eq('id', file.id), 'Deleting file');
        if (file.storage_path) await removePinFileQuietly(file.storage_path);
        return;
      }
      const folder = await shopResolveFolder(storeId, segs, false);
      if (!folder) throw new Error(`Nothing found at ${path}.`);
      // cascade deletes children server-side
      check(await client.from('vfs_folders').delete().eq('id', folder.id), 'Deleting folder');
    },

    async rename(storeId, oldPath, newPath) {
      const oldSegs = splitPath(oldPath);
      const newSegs = splitPath(newPath);
      if (oldSegs.length === 0 || newSegs.length === 0) {
        throw new Error('Cannot rename the root folder.');
      }
      if (oldPath === newPath) return;
      const oldParent = await shopResolveFolder(storeId, oldSegs.slice(0, -1), false);
      if (!oldParent) throw new Error(`Nothing found at ${oldPath}.`);
      const oldName = oldSegs[oldSegs.length - 1];
      const file = await shopFindFile(storeId, oldParent.id, oldName);
      const folder = file ? null : await shopResolveFolder(storeId, oldSegs, false);
      if (!file && !folder) throw new Error(`Nothing found at ${oldPath}.`);
      const newParent = await shopResolveFolder(storeId, newSegs.slice(0, -1), true);
      const newName = newSegs[newSegs.length - 1];
      if (await shopFindFile(storeId, newParent.id, newName)) {
        throw new Error(`A file named "${newName}" already exists there.`);
      }
      const collidingFolder = check(
        await client
          .from('vfs_folders')
          .select('id')
          .eq('store_id', storeId)
          .eq('parent_id', newParent.id)
          .eq('name', newName)
          .maybeSingle(),
        'Checking for a name clash'
      );
      if (collidingFolder) throw new Error(`A folder named "${newName}" already exists there.`);
      if (folder) {
        // refuse to move a folder into itself or one of its descendants:
        // walk the destination's ancestor chain and compare ids
        const np = check(
          await client.from('vfs_folders').select('parent_id').eq('id', newParent.id).single(),
          'Resolving destination'
        );
        let ancestorId = np.parent_id;
        let guard = 0;
        while (ancestorId && guard++ < 100) {
          if (ancestorId === folder.id) throw new Error('Cannot move a folder into itself.');
          const a = check(
            await client.from('vfs_folders').select('parent_id').eq('id', ancestorId).single(),
            'Resolving destination'
          );
          ancestorId = a.parent_id;
        }
        check(
          await client
            .from('vfs_folders')
            .update({ name: newName, parent_id: newParent.id })
            .eq('id', folder.id),
          'Renaming folder'
        );
      } else {
        check(
          await client
            .from('vfs_files')
            .update({ name: newName, folder_id: newParent.id })
            .eq('id', file.id),
          'Renaming file'
        );
      }
    },
  };

  // ---- spaces ------------------------------------------------------------------------
  async function listSpacesOrSeed(uid) {
    let rows = check(
      await client.from('spaces').select('*').eq('user_id', uid).order('sort_order'),
      'Listing spaces'
    );
    if (rows.length === 0) {
      // defensive: handle_new_user() should have seeded these
      rows = check(
        await client
          .from('spaces')
          .insert([
            { user_id: uid, name: 'Main', icon: 'square', sort_order: 0 },
            { user_id: uid, name: 'Focus', icon: 'circle', sort_order: 1 },
            { user_id: uid, name: 'Play', icon: 'triangle', sort_order: 2 },
          ])
          .select('*'),
        'Seeding starter spaces'
      );
    }
    return rows;
  }

  const spaces = {
    async list() {
      const uid = requireUid();
      return (await listSpacesOrSeed(uid)).map(mapSpace);
    },

    async create(name) {
      const uid = requireUid();
      const clean = String(name ?? '').trim();
      if (!clean) throw new Error('Space name cannot be empty.');
      const existing = await listSpacesOrSeed(uid);
      if (existing.length >= MAX_SPACES) throw new Error('maximum 8 spaces per user');
      if (existing.some((s) => s.name.toLowerCase() === clean.toLowerCase())) {
        throw new Error(`A space named "${clean}" already exists.`);
      }
      const row = check(
        await client
          .from('spaces')
          .insert({
            user_id: uid,
            name: clean,
            icon: 'square',
            sort_order: Math.max(...existing.map((s) => s.sort_order), -1) + 1,
          })
          .select('*')
          .single(),
        'Creating space'
      );
      return mapSpace(row);
    },

    async rename(id, name) {
      const uid = requireUid();
      const clean = String(name ?? '').trim();
      if (!clean) throw new Error('Space name cannot be empty.');
      const existing = await listSpacesOrSeed(uid);
      if (existing.some((s) => s.id !== id && s.name.toLowerCase() === clean.toLowerCase())) {
        throw new Error(`A space named "${clean}" already exists.`);
      }
      const row = check(
        await client.from('spaces').update({ name: clean }).eq('id', id).eq('user_id', uid).select('*').single(),
        'Renaming space'
      );
      return mapSpace(row);
    },

    async update(id, patch) {
      const uid = requireUid();
      const row = {};
      if (patch.wallpaper !== undefined) row.wallpaper = patch.wallpaper || null;
      if (patch.accent !== undefined) row.accent = patch.accent || null;
      if (patch.icon !== undefined) row.icon = patch.icon || 'square';
      const updated = check(
        await client.from('spaces').update(row).eq('id', id).eq('user_id', uid).select('*').single(),
        'Updating space'
      );
      return mapSpace(updated);
    },

    async remove(id) {
      const uid = requireUid();
      const existing = await listSpacesOrSeed(uid);
      const target = existing.find((s) => s.id === id);
      if (!target) throw new Error('Space not found.');
      const mergeTarget =
        existing.find((s) => s.id !== id && s.name === 'Main') || existing.find((s) => s.id !== id);
      const moving = check(
        await client.from('window_states').select('id, app_id').eq('space_id', id),
        'Loading window states'
      );
      if (mergeTarget && moving.length > 0) {
        // real merge: clear conflicting slots on the target, then re-point rows
        const ids = moving.map((w) => w.app_id);
        check(
          await client.from('window_states').delete().eq('space_id', mergeTarget.id).in('app_id', ids),
          'Merging window states'
        );
        check(
          await client.from('window_states').update({ space_id: mergeTarget.id }).eq('space_id', id),
          'Merging window states'
        );
      } else {
        check(await client.from('window_states').delete().eq('space_id', id), 'Clearing window states');
      }
      check(await client.from('spaces').delete().eq('id', id).eq('user_id', uid), 'Deleting space');
      const remaining = existing.filter((s) => s.id !== id);
      if (remaining.length === 0) {
        // the OS always needs at least one space — re-seed
        await listSpacesOrSeed(uid);
      }
    },

    // Import-only: replace the whole space set (names, wallpaper, accent,
    // icon, sort order, window layouts) in one shot. The wipe + inserts run
    // without touching listSpacesOrSeed, so the defensive reseed never fires
    // mid-restore and a backup containing Main/Focus/Play restores cleanly.
    async replaceAll(entries) {
      const uid = requireUid();
      const clean = [];
      const seen = new Set();
      for (const s of Array.isArray(entries) ? entries : []) {
        const name = String(s?.name || 'Space').trim() || 'Space';
        if (seen.has(name.toLowerCase())) continue;
        seen.add(name.toLowerCase());
        if (clean.length >= MAX_SPACES) break;
        clean.push(s);
      }
      if (clean.length === 0) throw new Error('replaceAll needs at least one space.');
      const rows = check(await client.from('spaces').select('id').eq('user_id', uid), 'Listing spaces');
      const ids = rows.map((r) => r.id);
      if (ids.length > 0) {
        check(await client.from('window_states').delete().in('space_id', ids), 'Clearing window states');
        check(await client.from('spaces').delete().in('id', ids), 'Clearing spaces');
      }
      const inserted = check(
        await client
          .from('spaces')
          .insert(
            clean.map((s, i) => ({
              user_id: uid,
              name: String(s.name || 'Space').trim() || 'Space',
              icon: s.icon || 'square',
              wallpaper: s.wallpaper || null,
              accent: s.accent || null,
              sort_order: i,
            }))
          )
          .select('*'),
        'Restoring spaces'
      );
      const wsRows = [];
      inserted.forEach((row, i) => {
        for (const ws of Array.isArray(clean[i].windowStates) ? clean[i].windowStates : []) {
          if (!ws || !ws.appId) continue;
          wsRows.push({
            space_id: row.id,
            app_id: ws.appId,
            x: ws.x ?? 100,
            y: ws.y ?? 100,
            w: ws.w ?? 640,
            h: ws.h ?? 480,
            z: ws.z ?? 0,
            minimized: !!ws.minimized,
            props: ws.props ?? {},
          });
        }
      });
      if (wsRows.length > 0) {
        check(await client.from('window_states').insert(wsRows), 'Restoring window states');
      }
      return inserted.map(mapSpace);
    },

    async getWindowStates(spaceId) {
      requireUid();
      const rows = check(
        await client.from('window_states').select('*').eq('space_id', spaceId),
        'Loading window states'
      );
      return rows.map(mapWindowState);
    },

    async saveWindowState(spaceId, ws) {
      requireUid();
      if (!ws || !ws.appId) throw new Error('Window state requires an appId.');
      check(
        await client.from('window_states').upsert(
          {
            space_id: spaceId,
            app_id: ws.appId,
            x: ws.x ?? 100,
            y: ws.y ?? 100,
            w: ws.w ?? 640,
            h: ws.h ?? 480,
            z: ws.z ?? 0,
            minimized: !!ws.minimized,
            props: ws.props ?? {},
          },
          { onConflict: 'space_id,app_id' }
        ),
        'Saving window state'
      );
    },

    async removeWindowState(spaceId, appId) {
      requireUid();
      check(
        await client.from('window_states').delete().eq('space_id', spaceId).eq('app_id', appId),
        'Removing window state'
      );
    },
  };

  // ---- pins ----------------------------------------------------------------------------
  const pins = {
    async list({ kind, tag, limit } = {}) {
      requireUid();
      let q = client.from('pins').select('*').order('created_at', { ascending: false });
      if (kind) q = q.eq('kind', kind);
      if (tag) q = q.contains('tags', [tag]);
      if (typeof limit === 'number') q = q.limit(limit);
      return check(await q, 'Listing pins').map(mapPin);
    },

    async search(query, { kind, tag } = {}) {
      requireUid();
      if (!query || !query.trim()) return this.list({ kind, tag });
      const ranked = check(
        await client.rpc('search_pins', { p_query: query }),
        'Searching pins'
      );
      if (!ranked || ranked.length === 0) return [];
      const rankById = new Map(ranked.map((r) => [r.pin_id, r.rank]));
      const rows = check(
        await client.from('pins').select('*').in('id', [...rankById.keys()]),
        'Loading ranked pins'
      );
      return rows
        .map(mapPin)
        .filter((p) => (!kind || p.kind === kind) && (!tag || p.tags.includes(tag)))
        .sort((a, b) => rankById.get(b.id) - rankById.get(a.id));
    },

    async create({ kind, title, body, url, tags, sourceApp, dataUrl, mime, sizeBytes, ...extra }) {
      const uid = requireUid();
      const isFile = kind === 'file' || kind === 'image';
      // File/image pins: bytes go to the private user-files bucket. The caller
      // may pass a dataUrl (uploaded here) or a pre-uploaded storage_path.
      // body stays null — clients resolve a fresh signed URL via pins.fileUrl().
      let storagePath = extra.storage_path ?? null;
      let fileMime = mime ?? extra.mime ?? null;
      let fileSize = sizeBytes ?? extra.size_bytes ?? null;
      if (isFile && !storagePath) {
        if (!dataUrl || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) {
          throw new Error('File pins need file data (dataUrl).');
        }
        const blob = await dataUrlToBlob(dataUrl);
        if (blob.size > MAX_PIN_FILE_BYTES) {
          throw new Error(
            `File too large (${formatBytes(blob.size)} > ${formatBytes(MAX_PIN_FILE_BYTES)}).`
          );
        }
        fileMime = fileMime || blob.type || 'application/octet-stream';
        // Trust the actual bytes, not the caller's declared size.
        fileSize = blob.size;
        storagePath = await uploadPinFile(uid, title, blob);
      }
      const row = check(
        await client
          .from('pins')
          .insert({
            user_id: uid,
            kind,
            title: String(title ?? '').trim() || 'Untitled pin',
            body: isFile ? null : body ?? null,
            url: url ?? null,
            tags: Array.isArray(tags) ? tags.map(String) : [],
            source_app: sourceApp ?? null,
            storage_path: storagePath,
            mime: fileMime,
            size_bytes: fileSize,
          })
          .select('*')
          .single(),
        'Creating pin'
      );
      return mapPin(row);
    },

    async update(id, patch) {
      const uid = requireUid();
      const allowed = [
        'kind', 'title', 'body', 'url', 'tags',
        'source_app', 'storage_path', 'mime', 'size_bytes',
      ];
      const clean = {};
      for (const [key, value] of Object.entries(patch ?? {})) {
        const col =
          key === 'sourceApp' ? 'source_app'
          : key === 'sizeBytes' ? 'size_bytes'
          : key;
        if (col === 'dataUrl') continue; // handled below
        if (!allowed.includes(col)) throw new Error(`Unknown pin field: "${key}".`);
        clean[col] = value;
      }
      // Replacing the file on a file/image pin: upload the new bytes, drop the old object.
      if (patch.dataUrl) {
        const existing = check(
          await client.from('pins').select('storage_path').eq('id', id).maybeSingle(),
          'Loading pin'
        );
        const blob = await dataUrlToBlob(patch.dataUrl);
        if (blob.size > MAX_PIN_FILE_BYTES) {
          throw new Error(
            `File too large (${formatBytes(blob.size)} > ${formatBytes(MAX_PIN_FILE_BYTES)}).`
          );
        }
        const newPath = await uploadPinFile(uid, clean.title || patch.title || 'file', blob);
        clean.storage_path = newPath;
        clean.body = null;
        clean.mime = blob.type || 'application/octet-stream';
        clean.size_bytes = blob.size;
        const row = check(
          await client.from('pins').update(clean).eq('id', id).select('*').single(),
          'Updating pin'
        );
        await removePinFileQuietly(existing?.storage_path);
        return mapPin(row);
      }
      const row = check(
        await client.from('pins').update(clean).eq('id', id).select('*').single(),
        'Updating pin'
      );
      return mapPin(row);
    },

    async remove(id) {
      requireUid();
      const existing = check(
        await client.from('pins').select('storage_path').eq('id', id).maybeSingle(),
        'Loading pin'
      );
      check(await client.from('pins').delete().eq('id', id), 'Deleting pin');
      await removePinFileQuietly(existing?.storage_path);
    },

    // Resolve a directly usable (signed, 1h) URL for a file/image pin's bytes.
    // The user-files bucket is private, so URLs are minted fresh on demand —
    // never stored, never stale.
    async fileUrl(pin) {
      requireUid();
      const path = pin?.storagePath;
      if (!path) {
        if (pin?.body && /^(https?:|data:)/.test(pin.body)) return pin.body;
        throw new Error('This pin has no file attached.');
      }
      const { data, error } = await client.storage
        .from(PIN_FILES_BUCKET)
        .createSignedUrl(path, 3600);
      if (error) throw new Error(`Could not load file: ${error.message}`);
      return data.signedUrl;
    },

    // Backup path: the raw data URL for a file/image pin's bytes.
    async fileData(pin) {
      const url = await this.fileUrl(pin);
      if (url.startsWith('data:')) return url;
      const res = await fetch(url);
      if (!res.ok) throw new Error('Could not download pin file.');
      return blobToDataUrl(await res.blob());
    },

    async tags() {
      requireUid();
      const rows = check(await client.from('pins').select('tags'), 'Loading pin tags');
      const set = new Set();
      for (const r of rows) for (const t of r.tags || []) set.add(t);
      return [...set].sort((a, b) => a.localeCompare(b));
    },
  };

  // ---- helm ------------------------------------------------------------------------------
  const helm = {
    async threads() {
      requireUid();
      const rows = check(
        await client.from('helm_threads').select('*').order('updated_at', { ascending: false }),
        'Loading threads'
      );
      return rows.map(mapThread);
    },

    async createThread(title) {
      const uid = requireUid();
      const row = check(
        await client
          .from('helm_threads')
          .insert({ user_id: uid, title: String(title ?? '').trim() || 'New conversation' })
          .select('*')
          .single(),
        'Creating thread'
      );
      return mapThread(row);
    },

    async messages(threadId) {
      requireUid();
      const rows = check(
        await client
          .from('helm_messages')
          .select('*')
          .eq('thread_id', threadId)
          .order('created_at', { ascending: true }),
        'Loading messages'
      );
      return rows.map(mapMessage);
    },

    async addMessage(threadId, { role, content, toolCalls }) {
      requireUid();
      if (!['user', 'assistant', 'tool'].includes(role)) {
        throw new Error(`Invalid message role "${role}".`);
      }
      const row = check(
        await client
          .from('helm_messages')
          .insert({
            thread_id: threadId,
            role,
            content: content ?? '',
            tool_calls: toolCalls ?? null,
          })
          .select('*')
          .single(),
        'Saving message'
      );
      // bump the thread so threads() order stays fresh (touch trigger also covers this)
      await client
        .from('helm_threads')
        .update({ updated_at: new Date().toISOString() })
        .eq('id', threadId);
      return mapMessage(row);
    },

    async removeThread(id) {
      requireUid();
      // messages cascade-delete server-side
      check(await client.from('helm_threads').delete().eq('id', id), 'Deleting thread');
    },
  };

  // ---- highscores ----------------------------------------------------------------------------
  const highscores = {
    async list(gameId, limit = 10) {
      requireUid();
      const rows = check(
        await client
          .from('game_highscores')
          .select('score, meta, achieved_at')
          .eq('game_id', gameId)
          .order('score', { ascending: false })
          .limit(limit),
        'Loading highscores'
      );
      return rows.map((r) => ({ score: r.score, meta: r.meta ?? {}, achievedAt: r.achieved_at }));
    },

    async record(gameId, score, meta = {}) {
      const uid = requireUid();
      if (!gameId) throw new Error('gameId is required.');
      if (typeof score !== 'number' || !Number.isFinite(score)) {
        throw new Error('Score must be a finite number.');
      }
      check(
        await client.from('game_highscores').insert({ user_id: uid, game_id: gameId, score, meta }),
        'Recording highscore'
      );
    },

    // Whole-account backup: every score row.
    async exportAll() {
      requireUid();
      const rows = check(await client.from('game_highscores').select('game_id, score, meta, achieved_at'), 'Exporting highscores');
      return rows.map((r) => ({ gameId: r.game_id, score: r.score, meta: r.meta ?? {}, achievedAt: r.achieved_at }));
    },

    // Merge-only restore: deduplicated on gameId+score+achievedAt so
    // re-importing the same backup is idempotent.
    async importAll(rows) {
      const uid = requireUid();
      const existing = check(
        await client.from('game_highscores').select('game_id, score, achieved_at'),
        'Loading highscores'
      );
      const seen = new Set(existing.map((r) => `${r.game_id}|${r.score}|${r.achieved_at}`));
      const fresh = [];
      for (const r of Array.isArray(rows) ? rows : []) {
        if (!r || !r.gameId || typeof r.score !== 'number' || !Number.isFinite(r.score)) continue;
        const achievedAt = r.achievedAt || new Date().toISOString();
        const key = `${r.gameId}|${r.score}|${achievedAt}`;
        if (seen.has(key)) continue;
        seen.add(key);
        fresh.push({
          user_id: uid,
          game_id: String(r.gameId),
          score: r.score,
          meta: r.meta ?? {},
          achieved_at: achievedAt,
        });
      }
      if (fresh.length > 0) {
        check(await client.from('game_highscores').insert(fresh), 'Restoring highscores');
      }
      return { inserted: fresh.length };
    },
  };

  // ---- notifications --------------------------------------------------------------------------
  const notifications = {
    async list() {
      requireUid();
      const rows = check(
        await client.from('notifications').select('*').order('created_at', { ascending: false }),
        'Loading notifications'
      );
      return rows.map((r) => ({
        id: r.id,
        title: r.title,
        body: r.body ?? null,
        read: !!r.read,
        createdAt: r.created_at,
      }));
    },

    async push({ title, body }) {
      const uid = requireUid();
      const clean = String(title ?? '').trim();
      if (!clean) throw new Error('Notification title cannot be empty.');
      const row = check(
        await client
          .from('notifications')
          .insert({ user_id: uid, title: clean, body: body ?? null })
          .select('*')
          .single(),
        'Pushing notification'
      );
      return { id: row.id, title: row.title, body: row.body ?? null, read: !!row.read, createdAt: row.created_at };
    },

    async markRead(id) {
      requireUid();
      check(await client.from('notifications').update({ read: true }).eq('id', id), 'Marking notification read');
    },

    async dismiss(id) {
      requireUid();
      check(await client.from('notifications').delete().eq('id', id), 'Dismissing notification');
    },

    async clearAll() {
      const uid = requireUid();
      check(await client.from('notifications').delete().eq('user_id', uid), 'Clearing notifications');
    },

    // Whole-account backup: merge-only restore keyed on notification id,
    // so re-importing the same backup is idempotent.
    async exportAll() {
      return this.list();
    },

    async importAll(rows) {
      const uid = requireUid();
      const existing = check(await client.from('notifications').select('id'), 'Loading notifications');
      const ids = new Set(existing.map((r) => String(r.id)));
      const fresh = [];
      for (const r of Array.isArray(rows) ? rows : []) {
        if (!r || typeof r.title !== 'string' || !r.title.trim()) continue;
        const row = { user_id: uid, title: r.title.trim(), body: r.body ?? null, read: !!r.read };
        if (r.id != null && !ids.has(String(r.id))) {
          row.id = r.id;
          ids.add(String(r.id));
        }
        if (r.createdAt) row.created_at = r.createdAt;
        fresh.push(row);
      }
      if (fresh.length > 0) {
        check(await client.from('notifications').insert(fresh), 'Restoring notifications');
      }
      return { inserted: fresh.length };
    },
  };

  // ---- classifieds: Kijiji-style ads per shop ----------------------------------
  // Migration 097 capability probe: the classified_ads table + the
  // public_classifieds() RPC. Until 097 is applied, the app shows a
  // friendly "needs a small system update" note instead of raw errors.
  let classifiedsAvail = null;
  async function classifiedsAvailable() {
    if (classifiedsAvail !== null) return classifiedsAvail;
    try {
      const res = await client.from('classified_ads').select('id').limit(1);
      classifiedsAvail =
        !res.error || !/42P01|PGRST205|does not exist/i.test(res.error.message || '');
    } catch {
      classifiedsAvail = false;
    }
    return classifiedsAvail;
  }

  const mapClassifiedAd = (r) => ({
    id: r.id,
    storeId: r.store_id,
    userId: r.user_id,
    ownerType: r.owner_type ?? 'shop',
    title: r.title,
    description: r.description ?? '',
    priceCents: r.price_cents ?? null,
    category: r.category ?? 'for-sale',
    photoData: r.photo_data ?? null,
    contactName: r.contact_name ?? '',
    contactPhone: r.contact_phone ?? '',
    contactEmail: r.contact_email ?? '',
    status: r.status ?? 'draft',
    expiresAt: r.expires_at ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  });

  /** Free-tier limits for customer (personal) classifieds. Kijiji-style. */
  const CUSTOMER_MAX_ACTIVE = 15;
  const CUSTOMER_MAX_PER_DAY = 5;
  const CUSTOMER_EXPIRY_DAYS = 60;

  const CLASSIFIED_CATEGORIES = [
    'for-sale',
    'free',
    'services',
    'wanted',
    'jobs',
    'events',
    'announcements',
  ];

  const classifieds = {
    /** True once migration 097 has been applied. */
    async available() {
      return classifiedsAvailable();
    },

    categories() {
      return [...CLASSIFIED_CATEGORIES];
    },

    async list(storeId, { status } = {}) {
      requireUid();
      if (!(await classifiedsAvailable())) throw new Error('classifieds-unavailable');
      if (!storeId) throw new Error('list needs a storeId.');
      let q = client
        .from('classified_ads')
        .select('*')
        .eq('store_id', storeId)
        .order('created_at', { ascending: false });
      if (status === 'draft' || status === 'published') q = q.eq('status', status);
      return check(await q, 'Listing classified ads').map(mapClassifiedAd);
    },

    async create(storeId, ad) {
      const uid = requireUid();
      if (!(await classifiedsAvailable())) throw new Error('classifieds-unavailable');
      if (!storeId) throw new Error('create needs a storeId.');
      const title = String(ad?.title ?? '').trim();
      if (!title) throw new Error('Ad title cannot be empty.');
      const category = CLASSIFIED_CATEGORIES.includes(ad?.category) ? ad.category : 'for-sale';
      const status = ad?.status === 'published' ? 'published' : 'draft';
      let priceCents = null;
      if (ad?.priceCents !== null && ad?.priceCents !== undefined && ad?.priceCents !== '') {
        const n = Math.round(Number(ad.priceCents));
        if (!Number.isFinite(n) || n < 0) throw new Error('Price must be a positive number.');
        priceCents = n;
      }
      const row = check(
        await client
          .from('classified_ads')
          .insert({
            store_id: storeId,
            user_id: uid,
            title: title.slice(0, 120),
            description: String(ad?.description ?? ''),
            price_cents: priceCents,
            category,
            photo_data: ad?.photoData || null,
            contact_name: String(ad?.contactName ?? ''),
            contact_phone: String(ad?.contactPhone ?? ''),
            contact_email: String(ad?.contactEmail ?? ''),
            status,
          })
          .select('*')
          .single(),
        'Creating classified ad'
      );
      return mapClassifiedAd(row);
    },

    async update(id, patch) {
      requireUid();
      if (!(await classifiedsAvailable())) throw new Error('classifieds-unavailable');
      if (!id) throw new Error('update needs an id.');
      const clean = {};
      if (patch?.title !== undefined) {
        const t = String(patch.title).trim();
        if (!t) throw new Error('Ad title cannot be empty.');
        clean.title = t.slice(0, 120);
      }
      if (patch?.description !== undefined) clean.description = String(patch.description);
      if (patch?.priceCents !== undefined) {
        if (patch.priceCents === null || patch.priceCents === '') {
          clean.price_cents = null;
        } else {
          const n = Math.round(Number(patch.priceCents));
          if (!Number.isFinite(n) || n < 0) throw new Error('Price must be a positive number.');
          clean.price_cents = n;
        }
      }
      if (patch?.category !== undefined && CLASSIFIED_CATEGORIES.includes(patch.category)) {
        clean.category = patch.category;
      }
      if (patch?.photoData !== undefined) clean.photo_data = patch.photoData || null;
      if (patch?.contactName !== undefined) clean.contact_name = String(patch.contactName);
      if (patch?.contactPhone !== undefined) clean.contact_phone = String(patch.contactPhone);
      if (patch?.contactEmail !== undefined) clean.contact_email = String(patch.contactEmail);
      if (patch?.status === 'draft' || patch?.status === 'published') clean.status = patch.status;
      if (Object.keys(clean).length === 0) throw new Error('Nothing to update.');
      const row = check(
        await client.from('classified_ads').update(clean).eq('id', id).select('*').single(),
        'Updating classified ad'
      );
      return mapClassifiedAd(row);
    },

    async remove(id) {
      requireUid();
      if (!(await classifiedsAvailable())) throw new Error('classifieds-unavailable');
      if (!id) throw new Error('remove needs an id.');
      // RLS restricts deletes to owner/manager; this gives a clean error first.
      check(await client.from('classified_ads').delete().eq('id', id), 'Deleting classified ad');
    },

    /**
     * Published ads for a shop's PUBLIC storefront, by slug.
     * Uses the public_classifieds() RPC (migration 097); returns [] when
     * the migration is not applied yet or the slug is unknown.
     */
    async publicList(slug) {
      const clean = String(slug ?? '').trim().toLowerCase();
      if (!clean) return [];
      try {
        const { data, error } = await client.rpc('public_classifieds', { p_slug: clean });
        if (error) {
          if (/42883|PGRST202|does not exist/i.test(error.message || '')) return [];
          throw new Error(`Loading public classifieds: ${error.message}`);
        }
        return Array.isArray(data) ? data : [];
      } catch (err) {
        if (/42883|PGRST202|does not exist/i.test(err?.message || '')) return [];
        throw err;
      }
    },

    // ---- free customer tier (migration 099, Kijiji-style) -------------------
    // Personal ads: no shop required. Limits are enforced SERVER-SIDE by the
    // classified_ads_customer_guard trigger; these methods map the trigger's
    // error codes to friendly, UI-translatable error names.

    /** Limit constants, exposed for UI display (enforcement is in the DB). */
    customerLimitsInfo() {
      return {
        maxActive: CUSTOMER_MAX_ACTIVE,
        maxPerDay: CUSTOMER_MAX_PER_DAY,
        expiryDays: CUSTOMER_EXPIRY_DAYS,
      };
    },

    /** Map the DB trigger's limit errors to friendly error names. */
    _mapCustomerLimitError(err) {
      const msg = String(err?.message || '');
      if (/CUSTOMER_TIER_DISABLED/.test(msg)) {
        const e = new Error('customer-tier-disabled');
        e.limitKind = 'disabled';
        throw e;
      }
      if (/CUSTOMER_LIMIT_ACTIVE/.test(msg)) {
        const e = new Error('customer-limit-active');
        e.limitKind = 'active';
        throw e;
      }
      if (/CUSTOMER_LIMIT_DAILY/.test(msg)) {
        const e = new Error('customer-limit-daily');
        e.limitKind = 'daily';
        throw e;
      }
      throw err;
    },

    /** The caller's own personal ads (any status). */
    async customerList() {
      const uid = requireUid();
      if (!(await classifiedsAvailable())) throw new Error('classifieds-unavailable');
      const q = client
        .from('classified_ads')
        .select('*')
        .eq('owner_type', 'customer')
        .eq('user_id', uid)
        .order('created_at', { ascending: false });
      return check(await q, 'Listing personal ads').map(mapClassifiedAd);
    },

    /** Current usage vs limits for the free tier. */
    async customerLimits() {
      requireUid();
      if (!(await classifiedsAvailable())) throw new Error('classifieds-unavailable');
      try {
        const { data, error } = await client.rpc('customer_ad_limits');
        if (error) throw error;
        return {
          active: Number(data?.active ?? 0),
          today: Number(data?.today ?? 0),
          maxActive: CUSTOMER_MAX_ACTIVE,
          maxPerDay: CUSTOMER_MAX_PER_DAY,
          expiryDays: CUSTOMER_EXPIRY_DAYS,
        };
      } catch (err) {
        // Migration 099 not applied yet: report zeros so the UI degrades.
        if (/42883|PGRST202|does not exist/i.test(err?.message || '')) {
          return { active: 0, today: 0, maxActive: CUSTOMER_MAX_ACTIVE, maxPerDay: CUSTOMER_MAX_PER_DAY, expiryDays: CUSTOMER_EXPIRY_DAYS };
        }
        throw err;
      }
    },

    async customerCreate(ad) {
      const uid = requireUid();
      if (!(await classifiedsAvailable())) throw new Error('classifieds-unavailable');
      const title = String(ad?.title ?? '').trim();
      if (!title) throw new Error('Ad title cannot be empty.');
      const category = CLASSIFIED_CATEGORIES.includes(ad?.category) ? ad.category : 'for-sale';
      const status = ad?.status === 'published' ? 'published' : 'draft';
      let priceCents = null;
      if (ad?.priceCents !== null && ad?.priceCents !== undefined && ad?.priceCents !== '') {
        const n = Math.round(Number(ad.priceCents));
        if (!Number.isFinite(n) || n < 0) throw new Error('Price must be a positive number.');
        priceCents = n;
      }
      try {
        const row = check(
          await client
            .from('classified_ads')
            .insert({
              store_id: null,
              user_id: uid,
              owner_type: 'customer',
              title: title.slice(0, 120),
              description: String(ad?.description ?? ''),
              price_cents: priceCents,
              category,
              photo_data: ad?.photoData || null,
              contact_name: String(ad?.contactName ?? ''),
              contact_phone: String(ad?.contactPhone ?? ''),
              contact_email: String(ad?.contactEmail ?? ''),
              status,
            })
            .select('*')
            .single(),
          'Creating personal ad'
        );
        return mapClassifiedAd(row);
      } catch (err) {
        this._mapCustomerLimitError(err);
      }
    },

    async customerUpdate(id, patch) {
      requireUid();
      if (!(await classifiedsAvailable())) throw new Error('classifieds-unavailable');
      if (!id) throw new Error('update needs an id.');
      const clean = {};
      if (patch?.title !== undefined) {
        const t = String(patch.title).trim();
        if (!t) throw new Error('Ad title cannot be empty.');
        clean.title = t.slice(0, 120);
      }
      if (patch?.description !== undefined) clean.description = String(patch.description);
      if (patch?.priceCents !== undefined) {
        if (patch.priceCents === null || patch.priceCents === '') {
          clean.price_cents = null;
        } else {
          const n = Math.round(Number(patch.priceCents));
          if (!Number.isFinite(n) || n < 0) throw new Error('Price must be a positive number.');
          clean.price_cents = n;
        }
      }
      if (patch?.category !== undefined && CLASSIFIED_CATEGORIES.includes(patch.category)) {
        clean.category = patch.category;
      }
      if (patch?.photoData !== undefined) clean.photo_data = patch.photoData || null;
      if (patch?.contactName !== undefined) clean.contact_name = String(patch.contactName);
      if (patch?.contactPhone !== undefined) clean.contact_phone = String(patch.contactPhone);
      if (patch?.contactEmail !== undefined) clean.contact_email = String(patch.contactEmail);
      if (patch?.status === 'draft' || patch?.status === 'published') clean.status = patch.status;
      if (Object.keys(clean).length === 0) throw new Error('Nothing to update.');
      try {
        const row = check(
          await client
            .from('classified_ads')
            .update(clean)
            .eq('id', id)
            .eq('owner_type', 'customer')
            .select('*')
            .single(),
          'Updating personal ad'
        );
        return mapClassifiedAd(row);
      } catch (err) {
        this._mapCustomerLimitError(err);
      }
    },

    /** Renew an expired (or expiring) ad: re-publish resets the 60-day clock. */
    async customerRenew(id) {
      return this.customerUpdate(id, { status: 'published' });
    },

    async customerRemove(id) {
      requireUid();
      if (!(await classifiedsAvailable())) throw new Error('classifieds-unavailable');
      if (!id) throw new Error('remove needs an id.');
      check(
        await client.from('classified_ads').delete().eq('id', id).eq('owner_type', 'customer'),
        'Deleting personal ad'
      );
    },

    /**
     * Public community board: published, non-expired CUSTOMER ads.
     * Uses the public_customer_classifieds() RPC (migration 099);
     * returns [] when the migration is not applied yet.
     */
    async customerPublicList() {
      try {
        const { data, error } = await client.rpc('public_customer_classifieds');
        if (error) {
          if (/42883|PGRST202|does not exist/i.test(error.message || '')) return [];
          throw new Error(`Loading community ads: ${error.message}`);
        }
        return Array.isArray(data) ? data : [];
      } catch (err) {
        if (/42883|PGRST202|does not exist/i.test(err?.message || '')) return [];
        throw err;
      }
    },

    /**
     * Effective free-tier limits, honoring the platform owner's settings
     * (migration 100, platform_public_settings). Falls back to the built-in
     * defaults when the migration is not applied yet. Cached per session;
     * the admin panel invalidates after saving.
     */
    async effectiveLimits() {
      return platformPublicSettings().then((s) => ({
        enabled: String(s.customer_ads_enabled).toLowerCase() === 'true',
        maxActive: Math.max(1, parseInt(s.customer_ads_max_active, 10) || CUSTOMER_MAX_ACTIVE),
        maxPerDay: Math.max(1, parseInt(s.customer_ads_max_per_day, 10) || CUSTOMER_MAX_PER_DAY),
        expiryDays: Math.max(1, parseInt(s.customer_ads_expiry_days, 10) || CUSTOMER_EXPIRY_DAYS),
      }));
    },
  };

  // ---- platform: master-owner controls (migration 100) ---------------------
  // Adjustable platform policy (free-tier limits, recovery knobs) plus
  // moderation tools. Everything master-gated server-side via is_master();
  // the client degrades to built-in defaults until migration 100 is applied.
  const PLATFORM_DEFAULTS = {
    customer_ads_enabled: 'true',
    customer_ads_max_active: String(CUSTOMER_MAX_ACTIVE),
    customer_ads_max_per_day: String(CUSTOMER_MAX_PER_DAY),
    customer_ads_expiry_days: String(CUSTOMER_EXPIRY_DAYS),
    recovery_enabled: 'true',
    recovery_codes_count: String(RECOVERY_CODE_COUNT),
    recovery_max_attempts: '10',
    recovery_window_minutes: '15',
  };

  let platformAvail = null;
  async function platformAvailable() {
    if (platformAvail !== null) return platformAvail;
    try {
      const { error } = await client.rpc('platform_public_settings');
      platformAvail = !error || !/42883|PGRST202|does not exist/i.test(error.message || '');
    } catch {
      platformAvail = false;
    }
    return platformAvail;
  }

  // Cached public settings (safe subset, anon-readable RPC). The admin
  // panel clears this after every save so the UI picks up new values.
  let platformPublicCache = null;
  async function platformPublicSettings() {
    if (platformPublicCache) return platformPublicCache;
    try {
      const { data, error } = await client.rpc('platform_public_settings');
      if (error) throw error;
      platformPublicCache = { ...PLATFORM_DEFAULTS, ...(data || {}) };
    } catch {
      platformPublicCache = { ...PLATFORM_DEFAULTS };
    }
    return platformPublicCache;
  }
  function invalidatePlatformCache() {
    platformPublicCache = null;
  }

  const platform = {
    /** True once migration 100 has been applied. */
    async available() {
      return platformAvailable();
    },

    /** Full settings object (master only). Merged over defaults. */
    async getSettings() {
      try {
        const { data, error } = await client.rpc('platform_get_settings');
        if (error) throw error;
        return { ...PLATFORM_DEFAULTS, ...(data || {}) };
      } catch (e) {
        if (/42883|PGRST202|does not exist/i.test(e?.message || '')) {
          return { ...PLATFORM_DEFAULTS };
        }
        throw new Error(`Loading platform settings: ${e.message || e}`);
      }
    },

    /** Update one setting (master only). Invalidates the public cache. */
    async setSetting(key, value) {
      try {
        const { error } = await client.rpc('platform_set_setting', {
          p_key: String(key ?? ''),
          p_value: String(value ?? ''),
        });
        if (error) throw error;
        invalidatePlatformCache();
      } catch (e) {
        if (/42883|PGRST202|does not exist/i.test(e?.message || '')) {
          const err = new Error('platform-needs-update');
          err.code = 'platform-needs-update';
          throw err;
        }
        if (/not authorized/i.test(e?.message || '')) {
          const err = new Error('platform-not-authorized');
          err.code = 'platform-not-authorized';
          throw err;
        }
        throw new Error(`Saving setting: ${e.message || e}`);
      }
    },

    /** Moderation: every customer ad on the platform (master only). */
    async listCustomerAds({ limit = 50, offset = 0, query = '' } = {}) {
      const { data, error } = await client.rpc('platform_list_customer_ads', {
        p_limit: limit,
        p_offset: offset,
        p_query: String(query ?? ''),
      });
      if (error) throw new Error(`Loading customer ads: ${error.message}`);
      const d = data || {};
      return {
        ads: (Array.isArray(d.ads) ? d.ads : []).map(mapClassifiedAd).map((a, i) => ({
          ...a,
          username: (Array.isArray(d.ads) ? d.ads : [])[i]?.username ?? null,
        })),
        total: Number(d.total ?? 0),
        limit: Number(d.limit ?? limit),
        offset: Number(d.offset ?? offset),
      };
    },

    /** Moderation: permanently remove one abusive customer ad (master only). */
    async removeCustomerAd(id) {
      const { error } = await client.rpc('platform_remove_customer_ad', { p_ad_id: id });
      if (error) throw new Error(`Removing ad: ${error.message}`);
    },

    /** Support: wipe a user's recovery data so they can start over (master only). */
    async resetUserRecovery(userId) {
      const { error } = await client.rpc('platform_reset_user_recovery', { p_user_id: userId });
      if (error) {
        if (/not authorized/i.test(error.message || '')) {
          const e = new Error('platform-not-authorized');
          e.code = 'platform-not-authorized';
          throw e;
        }
        throw new Error(`Resetting recovery: ${error.message}`);
      }
    },

    /** Adoption stats: counts only, no personal data (master only). */
    async recoveryStatus() {
      try {
        const { data, error } = await client.rpc('platform_recovery_status');
        if (error) throw error;
        return {
          codesUsers: Number(data?.codes_users ?? 0),
          questionsUsers: Number(data?.questions_users ?? 0),
        };
      } catch (e) {
        if (/42883|PGRST202|does not exist/i.test(e?.message || '')) {
          return { codesUsers: 0, questionsUsers: 0 };
        }
        throw new Error(`Loading recovery status: ${e.message || e}`);
      }
    },
  };

  // ---- pos: multi-user point of sale ----------------------------------------------
  // Stores are shared across Vendra users: pos_stores + pos_store_members
  // (roles owner/manager/cashier), pos_products, pos_sales (per-store
  // sequential numbers assigned by a DB trigger), pos_invites (join codes).
  const mapPosStore = (r) => ({
    id: r.id,
    name: r.name,
    currency: r.currency ?? '$',
    taxRate: Number(r.tax_rate ?? 0),
    taxRates: Array.isArray(r.tax_rates) ? r.tax_rates : [],
    // migration 067: chosen business-type preset; null both when
    // never chosen and on pre-migration databases (capabilities() tells
    // the two apart via the posHasBusinessPreset probe).
    businessPreset: r.business_preset ?? null,
    createdAt: r.created_at,
  });

  const mapPosProduct = (r) => ({
    id: r.id,
    name: r.name,
    sku: r.sku ?? '',
    priceCents: Number(r.price_cents),
    category: r.category ?? '',
    active: !!r.active,
    // migration 063: public-storefront visibility. The column defaults
    // TRUE so a product created in the POS flows to the shop's published
    // storefront automatically; absent on pre-063 databases (treat as on).
    publicVisible: r.public_visible == null ? true : !!r.public_visible,
    createdAt: r.created_at,
    // migration 004 fields — defaulted so pre-004 databases keep working
    costCents: Number(r.cost_cents ?? 0),
    stock: Number(r.stock ?? 0),
    trackStock: !!r.track_stock,
    lowStockThreshold: Number(r.low_stock_threshold ?? 0),
    variants: Array.isArray(r.variants) ? r.variants : [],
    imageUrl: r.image_url ?? '',
  });

  const mapPosSale = (r) => ({
    id: r.id,
    number: Number(r.number),
    items: r.items ?? [],
    subtotalCents: Number(r.subtotal_cents),
    discountCents: Number(r.discount_cents),
    taxCents: Number(r.tax_cents),
    totalCents: Number(r.total_cents),
    method: r.method,
    tenderedCents: Number(r.tendered_cents),
    changeCents: Number(r.change_cents),
    createdBy: r.created_by ?? null,
    createdAt: r.created_at,
    voided: !!r.voided,
    voidedAt: r.voided_at ?? null,
    // migration 004 fields
    cashierName: r.cashier_name ?? null,
    cashierId: r.cashier_id ?? null,
    staffPinId: r.staff_pin_id ?? null,
    customerId: r.customer_id ?? null,
    customerName: r.pos_customers?.name ?? null,
    voidReason: r.void_reason ?? null,
    // migration 021: the exact tax lines charged at sale time (historical
    // truth for receipts/reprints — never recomputed from current settings)
    // tax_lines: null = legacy sale with no snapshot (receipt falls back to a
    // controlled recompute); [] = genuinely tax-free at sale time. The two
    // must never be conflated — see ReceiptModal.
    taxLines: Array.isArray(r.tax_lines) ? r.tax_lines : null,
    // migration 025: organization snapshot at sale time (historical truth —
    // never re-read from the live org row for receipts).
    orgId: r.org_id ?? null,
    orgName: r.org_name ?? null,
    orgType: r.org_type ?? null,
    orgTaxExempt: !!r.org_tax_exempt,
    // migration 045: promo / tender-adjustment / loyalty snapshot at sale
    // time (historical truth for reprints and reports).
    promoCode: r.promo_code ?? null,
    promoDiscountCents: Number(r.promo_discount_cents ?? 0),
    adjustments: Array.isArray(r.tender_adjustments) ? r.tender_adjustments : [],
    loyaltyEarned: Number(r.loyalty_earned ?? 0),
    loyaltyRedeemed: Number(r.loyalty_redeemed_points ?? 0),
    // migration 064: sales channel. 'register' = till sale, 'fair' = book
    // fair sale (see bouquinerie.recordFairSale). fairName is the fair's
    // name snapshotted at sale time (historical truth, like orgName).
    channel: r.channel === 'fair' ? 'fair' : 'register',
    fairId: r.fair_id ?? null,
    fairName: r.fair_name ?? null,
  });

  // SHA-256 hex for staff PINs (PINs are never stored or sent in the clear).
  // Shared module: uses crypto.subtle in secure contexts, pure-JS fallback
  // on plain-HTTP origins where crypto.subtle is unavailable.
  async function sha256hex(s) {
    return (await import('../sha256.js')).sha256hex(s);
  }

  // Migration 004 capability probe. The app must keep working on databases
  // where 004 hasn't been applied yet: when the probe fails we fall back to
  // the 002/003 column set and the UI hides v4-only features.
  let posV4 = null;
  async function posHasV4() {
    if (posV4 !== null) return posV4;
    try {
      const res = await client.from('pos_products').select('cost_cents').limit(1);
      posV4 = !res.error || !/42703|does not exist/i.test(res.error.message || '');
    } catch {
      posV4 = false;
    }
    return posV4;
  }

  // Salted-PIN capability probe (migration 069, phase 1): when the
  // pin_kdf column exists, PIN sets also write a bcrypt hash via
  // pos_staff_set_pin and logins go through pos_staff_login2. Databases
  // without the migration keep the exact legacy SHA-256 behavior.
  let posPinKdf = null;
  async function posHasPinKdf() {
    if (posPinKdf !== null) return posPinKdf;
    try {
      const res = await client.from('pos_staff').select('pin_kdf').limit(1);
      posPinKdf = !res.error || !/42703|does not exist/i.test(res.error.message || '');
    } catch {
      posPinKdf = false;
    }
    return posPinKdf;
  }

  // Draft migration 070 capability probe: pos_stores.business_preset
  // records which universal business-type preset a shop runs. Older
  // databases simply don't have it — the preset then applies layout-only
  // and Admin says the database update is due. (Coordinator: if the
  // final migration number differs from 070, update this comment.)
  let posPreset = null;
  async function posHasBusinessPreset() {
    if (posPreset !== null) return posPreset;
    try {
      const res = await client.from('pos_stores').select('business_preset').limit(1);
      posPreset = !res.error || !/42703|PGRST204|does not exist|Could not find/i.test(res.error.message || '');
    } catch {
      posPreset = false;
    }
    return posPreset;
  }

  // Migration 021 capability probe: pos_sales.tax_lines holds the exact tax
  // breakdown charged at sale time. Older databases simply don't persist it
  // (receipts fall back to the legacy recompute path).
  let posTaxLines = null;
  async function posHasTaxLines() {
    if (posTaxLines !== null) return posTaxLines;
    try {
      const res = await client.from('pos_sales').select('tax_lines').limit(1);
      posTaxLines = !res.error || !/42703|does not exist/i.test(res.error.message || '');
    } catch {
      posTaxLines = false;
    }
    return posTaxLines;
  }

  // Migration 024 capability probe: the pos_void_sale RPC voids + restocks
  // atomically. Probe with the nil UUID: a missing function raises 42883,
  // an existing one raises our own 'sale not found' / auth validation.
  let posV24 = null;
  async function posHasV24() {
    if (posV24 !== null) return posV24;
    try {
      const { error } = await client.rpc('pos_void_sale', {
        p_sale_id: '00000000-0000-0000-0000-000000000000',
        p_reason: '',
      });
      const msg = `${error?.code || ''} ${error?.message || ''}`;
      posV24 = !error || !/42883|does not exist/i.test(msg);
    } catch {
      posV24 = false;
    }
    return posV24;
  }

  // Migration 025 capability probe: pos_orgs holds organization accounts and
  // pos_sales carries the org snapshot columns.
  let posOrgs = null;
  async function posHasOrgs() {
    if (posOrgs !== null) return posOrgs;
    try {
      const res = await client.from('pos_orgs').select('id').limit(1);
      posOrgs = !res.error || !/42703|42P01|does not exist/i.test(res.error.message || '');
    } catch {
      posOrgs = false;
    }
    return posOrgs;
  }

  // Migration 045 capability probe: pos_sales carries the promo /
  // tender-adjustment / loyalty snapshot columns.
  let posPromoCols = null;
  async function posHasPromoCols() {
    if (posPromoCols !== null) return posPromoCols;
    try {
      const res = await client.from('pos_sales').select('promo_code').limit(1);
      posPromoCols = !res.error || !/42703|does not exist/i.test(res.error.message || '');
    } catch {
      posPromoCols = false;
    }
    return posPromoCols;
  }

  // Migration 050 capability probe: pos_sales.idempotency_key column.
  let posSaleIdemCol = null;
  async function posHasSaleIdemCol() {
    if (posSaleIdemCol !== null) return posSaleIdemCol;
    try {
      const res = await client.from('pos_sales').select('idempotency_key').limit(1);
      posSaleIdemCol = !res.error || !/42703|does not exist/i.test(res.error.message || '');
    } catch {
      posSaleIdemCol = false;
    }
    return posSaleIdemCol;
  }

  // Migration 064 capability probe: pos_sales.channel / fair_id / fair_name.
  // When true, fair sales are written into the ledger; when false, the
  // bouquinerie falls back to the legacy bq_fair_sales-only bookkeeping.
  let posSaleChannel = null;
  async function posHasSaleChannel() {
    if (posSaleChannel !== null) return posSaleChannel;
    try {
      const res = await client.from('pos_sales').select('channel').limit(1);
      posSaleChannel = !res.error || !/42703|does not exist/i.test(res.error.message || '');
    } catch {
      posSaleChannel = false;
    }
    return posSaleChannel;
  }

  // Migration 027 capability probe: pos_community_hours table.
  let posCommunity = null;  async function posHasCommunity() {
    if (posCommunity !== null) return posCommunity;
    try {
      const res = await client.from('pos_community_hours').select('id').limit(1);
      posCommunity = !res.error || !/42703|42P01|does not exist/i.test(res.error.message || '');
    } catch {
      posCommunity = false;
    }
    return posCommunity;
  }

  // Migration 028 capability probe: pos_gift_cards table. When true, the
  // gift-card UI lights up (it is independent of the wider posUpgrades
  // tender suite, whose other backends are still unimplemented).
  let posGiftCards = null;
  async function posHasGiftCards() {
    if (posGiftCards !== null) return posGiftCards;
    try {
      const res = await client.from('pos_gift_cards').select('id').limit(1);
      posGiftCards = !res.error || !/42703|42P01|does not exist/i.test(res.error.message || '');
    } catch {
      posGiftCards = false;
    }
    return posGiftCards;
  }

  // Migration 072 capability probes (refund/break history import RPCs),
  // same pattern as posHasBackupImport: call with an empty payload — a
  // missing function errors, a gate answer means the function exists.
  let posRefundHistoryImport = null;
  async function posHasRefundHistoryImport() {
    if (posRefundHistoryImport !== null) return posRefundHistoryImport;
    try {
      const res = await client.rpc('pos_refund_history_import', {
        p_store_id: '00000000-0000-0000-0000-000000000000',
        p_refunds: [],
      });
      posRefundHistoryImport = !res.error || /not a member|managers only|only managers/i.test(res.error.message || '');
    } catch {
      posRefundHistoryImport = false;
    }
    return posRefundHistoryImport;
  }
  let posBreakHistoryImport = null;
  async function posHasBreakHistoryImport() {
    if (posBreakHistoryImport !== null) return posBreakHistoryImport;
    try {
      const res = await client.rpc('pos_break_history_import', {
        p_store_id: '00000000-0000-0000-0000-000000000000',
        p_breaks: [],
      });
      posBreakHistoryImport = !res.error || /not a member|managers only|only managers/i.test(res.error.message || '');
    } catch {
      posBreakHistoryImport = false;
    }
    return posBreakHistoryImport;
  }

  // Migration 034 capability probe: pos_refunds table. When true, the
  // refund UI lights up (carved out of the posUpgrades bundle the same way
  // gift cards were — the rest of that bundle is still unimplemented).
  let posRefunds = null;
  async function posHasRefunds() {
    if (posRefunds !== null) return posRefunds;
    try {
      const res = await client.from('pos_refunds').select('id').limit(1);
      posRefunds = !res.error || !/42703|42P01|does not exist/i.test(res.error.message || '');
    } catch {
      posRefunds = false;
    }
    return posRefunds;
  }

  const mapPosOrg = (r) => ({
    id: r.id,
    storeId: r.store_id,
    name: r.name,
    type: r.type ?? 'entreprise',
    contact: r.contact ?? '',
    taxExempt: !!r.tax_exempt,
    notes: r.notes ?? '',
    createdAt: r.created_at,
  });

  // Migration 026 capability probe: pos_apply_sale_stock decrements
  // inventory atomically. Probe with an empty line set: a missing function
  // raises 42883, an existing one returns an empty result set.
  let posV26 = null;
  async function posHasV26() {
    if (posV26 !== null) return posV26;
    try {
      const { error } = await client.rpc('pos_apply_sale_stock', {
        p_store_id: '00000000-0000-0000-0000-000000000000',
        p_lines: [],
      });
      const msg = `${error?.code || ''} ${error?.message || ''}`;
      posV26 = !error || !/42883|does not exist/i.test(msg);
    } catch {
      posV26 = false;
    }
    return posV26;
  }

  // Migration 075 capability probe: pos_apply_sale_stock_once applies
  // stock exactly once per idempotency key (M-1 fix).
  let posStockOnce = null;
  async function posHasStockOnce() {
    if (posStockOnce !== null) return posStockOnce;
    try {
      const { error } = await client.rpc('pos_apply_sale_stock_once', {
        p_store_id: '00000000-0000-0000-0000-000000000000',
        p_lines: [],
        p_idempotency_key: 'probe',
      });
      const msg = `${error?.code || ''} ${error?.message || ''}`;
      posStockOnce = !error || !/42883|does not exist/i.test(msg);
    } catch {
      posStockOnce = false;
    }
    return posStockOnce;
  }

  // Migration 071: customer accounts + online ordering RPCs.
  let posOnlineOrders = null;
  async function posHasOnlineOrders() {
    if (posOnlineOrders !== null) return posOnlineOrders;
    try {
      const { error } = await client.rpc('online_orders_inbox', {
        p_store_id: '00000000-0000-0000-0000-000000000000',
      });
      // The zero UUID is never a real store, so reaching the RPC's own
      // authorization errors proves the function exists; a missing
      // function (42883) means the migration is not applied.
      const msg = `${error?.code || ''} ${error?.message || ''}`;
      posOnlineOrders =
        !error ||
        /ONLINE_NEEDS_SIGNIN|ONLINE_FORBIDDEN|not a member/i.test(msg);
    } catch {
      posOnlineOrders = false;
    }
    return posOnlineOrders;
  }

  const POS_INVITE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  // Column allowlists for account-backup import: rows are picked down to
  // known columns so a backup from a newer/older schema (or another
  // backend's shape) can never inject unknown columns into an insert.
  const POS_IMPORT_COLUMNS = {
    pos_products: ['id', 'store_id', 'name', 'sku', 'price_cents', 'category', 'active', 'public_visible', 'cost_cents', 'track_stock', 'stock', 'low_stock_threshold', 'image_url', 'variants', 'created_at'],
    pos_sales: ['id', 'store_id', 'number', 'items', 'subtotal_cents', 'discount_cents', 'tax_cents', 'total_cents', 'method', 'tendered_cents', 'change_cents', 'created_by', 'created_at', 'voided', 'voided_at', 'voided_by', 'tax_lines', 'org_id', 'org_name', 'org_type', 'org_tax_exempt', 'channel', 'fair_id', 'fair_name'],
    pos_customers: ['id', 'store_id', 'name', 'phone', 'email', 'notes', 'created_at'],
    pos_staff: ['id', 'store_id', 'name', 'pin_hash', 'role', 'active', 'created_at'],
    pos_appointments: ['id', 'store_id', 'customer_id', 'staff_id', 'title', 'notes', 'starts_at', 'ends_at', 'status', 'created_by', 'created_at', 'updated_at'],
    pos_drawer_shifts: ['id', 'store_id', 'opened_by', 'opened_by_name', 'opened_at', 'open_amount_cents', 'closed_at', 'closed_by', 'close_amount_cents', 'expected_cents', 'note'],
    pos_orgs: ['id', 'store_id', 'name', 'type', 'contact', 'tax_exempt', 'notes', 'created_at', 'updated_at'],
    pos_community_hours: ['id', 'store_id', 'person_name', 'staff_id', 'org_id', 'service_date', 'minutes', 'notes', 'recorded_by', 'created_at'],
    // Time-clock HR (migration 031). staff_id references are resolved by
    // insert order (staff is imported above) — a row pointing at staff
    // that did not survive the import fails its FK and is skipped by the
    // row-by-row fallback, never fatal.
    pos_shifts: ['id', 'store_id', 'staff_id', 'ymd', 'start', 'end', 'note', 'created_at'],
    pos_time_off: ['id', 'store_id', 'staff_id', 'kind', 'from_date', 'to_date', 'reason', 'status', 'decided_by', 'decided_at', 'created_at'],
    pos_pay_periods: ['id', 'store_id', 'from_date', 'to_date', 'status', 'approved_by', 'approved_at', 'created_at'],
    // pos_punch_settings (PK is store_id, no id column) and
    // storefront_profiles (upsert by store_id) are handled by dedicated
    // steps in importStore — not by the generic id-keyed sanitizer.
    // Gift cards restore through the manager-only pos_giftcard_import RPC
    // (no direct-write RLS exists by design); columns listed here so the
    // generic sanitizer still normalizes rows before the RPC call.
    pos_gift_cards: ['id', 'store_id', 'code', 'initial_cents', 'balance_cents', 'note', 'status', 'sold_at', 'sold_by', 'created_at'],
    pos_gift_card_events: ['id', 'store_id', 'card_id', 'kind', 'amount_cents', 'balance_after_cents', 'sale_id', 'actor', 'created_at'],
    // Catalogue (book-oriented inventory, migration 013/016): the whole-account
    // backup promise covers these too. owner_id is re-attributed to the
    // importer via POS_IMPORT_USER_COLS.
    bq_items: ['id', 'store_id', 'owner_id', 'kind', 'title', 'author', 'isbn', 'category', 'is_new', 'condition', 'qty', 'price', 'shelf', 'source', 'status', 'abe_ref', 'abe_status', 'notes', 'created_at', 'updated_at'],
    bq_donations: ['id', 'store_id', 'owner_id', 'donor_name', 'received_at', 'item_count', 'state', 'notes', 'created_at'],
    bq_fairs: ['id', 'store_id', 'owner_id', 'name', 'fair_date', 'beneficiary', 'notes', 'created_at'],
    bq_fair_sales: ['id', 'store_id', 'fair_id', 'item_id', 'title', 'qty', 'unit_price', 'sold_at', 'sale_id'],
    bq_special_orders: ['id', 'store_id', 'owner_id', 'customer_name', 'customer_phone', 'title', 'author', 'notes', 'status', 'created_at', 'updated_at', 'customer_id'],
    // bq_donation_items is a junction table (donation_id, item_id) with no
    // id/store_id — handled specially in importStore step 3b, not here.
  };
  // Columns that reference auth.users — always re-attributed to the
  // importing user (or nulled), never to a user from another account.
  const POS_IMPORT_USER_COLS = ['created_by', 'voided_by', 'opened_by', 'closed_by', 'sold_by', 'actor', 'recorded_by', 'owner_id'];
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const freshUuid = () =>
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
          const r = (Math.random() * 16) | 0;
          return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
        });
  // Normalize a backup row's top-level keys to snake_case so dumps from the
  // local backend (camelCase) import cleanly. Nested jsonb (sale items,
  // product variants) passes through untouched — the cloud adapter stores
  // those nested keys in camelCase natively.
  const snakeRow = (row) => {
    const out = {};
    for (const [k, v] of Object.entries(row ?? {})) {
      out[String(k).replace(/([A-Z])/g, (m) => `_${m.toLowerCase()}`)] = v;
    }
    return out;
  };  function makeInviteCode(length = 8) {
    const bytes = crypto.getRandomValues(new Uint8Array(length));
    return Array.from(
      bytes,
      (b) => POS_INVITE_ALPHABET[b % POS_INVITE_ALPHABET.length]
    ).join('');
  }

  // Feature probe for migration 009 (appointments). Dedicated probe rather
  // than reusing posHasV4, so appointments light up exactly when their own
  // migration is applied.
  let posAppts = null;
  async function posHasAppts() {
    if (posAppts !== null) return posAppts;
    try {
      const res = await client.from('pos_appointments').select('id').limit(1);
      posAppts = !res.error || !/42703|does not exist/i.test(res.error.message || '');
    } catch {
      posAppts = false;
    }
    return posAppts;
  }

  // Feature probe for migration 010 (backup import RPC).
  let posBackupImport = null;
  async function posHasBackupImport() {
    if (posBackupImport !== null) return posBackupImport;
    try {
      const res = await client.rpc('pos_punch_history_import', {
        p_store_id: '00000000-0000-0000-0000-000000000000',
        p_punches: [],
        p_audits: [],
      });
      // The probe call can never succeed vacuously (the zero UUID is not a
      // real store): reaching the RPC's own authorization errors ('not a
      // member', 'managers only') proves the function exists. Anything else
      // — missing function, or 'sign in required' when logged out — is false.
      const m = res.error ? res.error.message || '' : '';
      posBackupImport = !res.error || /not a member|managers only/i.test(m);
    } catch {
      posBackupImport = false;
    }
    return posBackupImport;
  }

  // Feature probe for migration 007 (PIN-verified time clock RPCs).
  let posClock = null;
  let posHR = null;
  async function posHasClock() {
    if (posClock !== null) return posClock;
    try {
      const res = await client.from('pos_time_punches').select('id').limit(1);
      posClock = !res.error || !/42703|does not exist/i.test(res.error.message || '');
    } catch {
      posClock = false;
    }
    return posClock;
  }

  // Migration 031 capability probe: breaks / shifts / time-off / pay periods
  // / punch settings. Until 031 is applied, the HR tabs show a friendly
  // "needs migration" message instead of raw errors.
  async function posHasHR() {
    if (posHR !== null) return posHR;
    try {
      const res = await client.from('pos_breaks').select('id').limit(1);
      posHR = !res.error || !/42703|does not exist/i.test(res.error.message || '');
    } catch {
      posHR = false;
    }
    return posHR;
  }

  // Owner/manager check for HR writes (schedule, settings, pay periods,
  // time-off decisions). RLS enforces this too; this gives a clean error.
  async function posRequireManager(storeId) {
    let role = null;
    try {
      const res = await client.rpc('pos_role', { p_store_id: storeId });
      role = res.data ?? null;
    } catch { /* fall through to error below */ }
    if (role !== 'owner' && role !== 'manager') {
      throw new Error('Only owners and managers can do that.');
    }
    return role;
  }

  // The clock RPCs raise plain-English errors ('invalid PIN',
  // 'already punched in', 'not punched in', 'managers only', …) — pass them
  // through instead of wrapping them in a generic message.
  // Migration 068 capability probe: storefront_profiles carries
  // the web-service link columns (Facebook, WhatsApp, review link...).
  // Until it is applied, the admin form keeps the fields disabled and the
  // save omits them — the rest of the profile keeps working exactly as
  // on a 063 database.
  let sfLinks = null;
  async function storefrontHasLinks() {
    if (sfLinks !== null) return sfLinks;
    try {
      const res = await client.from('storefront_profiles').select('facebook_url').limit(1);
      sfLinks = !res.error || !/42703|PGRST204|does not exist/i.test(res.error.message || '');
    } catch {
      sfLinks = false;
    }
    return sfLinks;
  }

  // Migration 074 capability probe: the custom_domains table
  // (per-shop own-domain names). Until it is applied, the admin form
  // shows its "turns on after a small system update" note and never
  // fires a doomed query — the storefront itself keeps working.
  let sfDomains = null;
  async function customDomainsExist() {
    if (sfDomains !== null) return sfDomains;
    try {
      const res = await client.from('custom_domains').select('hostname').limit(1);
      sfDomains = !res.error || !/42P01|PGRST205|does not exist/i.test(res.error.message || '');
    } catch {
      sfDomains = false;
    }
    return sfDomains;
  }

  function mapClockError(msg) {
    const m = String(msg || '');
    const short = m.replace(/^.*:\s*/, '').trim();
    return short || 'Could not record the punch.';
  }

  function mapAppointment(r) {
    return {
      id: r.id,
      customerId: r.customer_id ?? null,
      customerName: r.pos_customers?.name ?? null,
      customerPhone: r.pos_customers?.phone ?? '',
      staffId: r.staff_id ?? null,
      staffName: r.pos_staff?.name ?? null,
      title: r.title,
      notes: r.notes ?? '',
      startsAt: r.starts_at,
      endsAt: r.ends_at,
      status: r.status,
      createdAt: r.created_at,
    };
  }

  const pos = {
    // Feature probe for migration 004 — the UI hides v4-only features
    // (variants, inventory, customers, staff PINs, drawer, stacked taxes,
    // 'other' tender) until the migration has been applied.
    async capabilities() {
      return { v4: await posHasV4(), appointments: await posHasAppts(), timeClock: await posHasClock(), backupImport: await posHasBackupImport(), giftCards: await posHasGiftCards(), refunds: await posHasRefunds(), orgs: await posHasOrgs(), businessPreset: await posHasBusinessPreset(), onlineOrders: await posHasOnlineOrders() };
    },

    async listStores() {
      const uid = requireUid();
      const v4 = await posHasV4();
      const hasPreset = await posHasBusinessPreset();
      const storeCols =
        (v4
          ? 'id, name, currency, tax_rate, tax_rates, created_at'
          : 'id, name, currency, tax_rate, created_at') +
        (hasPreset ? ', business_preset' : '');
      const rows = check(
        await client
          .from('pos_store_members')
          .select(`role, joined_at, pos_stores(${storeCols})`)
          .eq('user_id', uid)
          .order('joined_at'),
        'Loading stores'
      );
      const stores = [];
      for (const r of rows) {
        const s = r.pos_stores;
        if (!s) continue;
        const countRes = await client
          .from('pos_store_members')
          .select('user_id', { count: 'exact', head: true })
          .eq('store_id', s.id);
        stores.push({
          ...mapPosStore(s),
          role: r.role,
          joinedAt: r.joined_at,
          memberCount: countRes.count ?? 1,
        });
      }
      return stores;
    },

    async createStore({ name, currency, taxRate }) {
      const uid = requireUid();
      const clean = String(name ?? '').trim();
      if (!clean) throw new Error('Store name cannot be empty.');
      let row;
      try {
        row = check(
          await client
            .from('pos_stores')
            .insert({
              name: clean,
              currency: String(currency ?? '$').trim() || '$',
              tax_rate: Math.min(100, Math.max(0, Number(taxRate) || 0)),
              created_by: uid,
            })
            .select('id, name, currency, tax_rate, created_at')
            .single(),
          'Creating store'
        );
      } catch (err) {
        // Never leak raw database/RLS errors to the user.
        throw friendlyPosError(err, 'create the store');
      }
      // the handle_new_pos_store trigger adds the creator as owner
      return {
        ...mapPosStore(row),
        role: 'owner',
        joinedAt: new Date().toISOString(),
        memberCount: 1,
      };
    },

    async updateStore(storeId, patch = {}) {
      const clean = {};
      if (patch.name !== undefined) {
        const name = String(patch.name).trim();
        if (!name) throw new Error('Store name cannot be empty.');
        clean.name = name;
      }
      if (patch.currency !== undefined) clean.currency = String(patch.currency).trim() || '$';
      if (patch.taxRate !== undefined) {
        clean.tax_rate = Math.min(100, Math.max(0, Number(patch.taxRate) || 0));
      }
      if (patch.taxRates !== undefined && (await posHasV4())) {
        const rates = Array.isArray(patch.taxRates) ? patch.taxRates : [];
        clean.tax_rates = rates
          .map((t) => ({
            name: String(t.name ?? '').trim().slice(0, 24) || 'Tax',
            rate: Math.min(100, Math.max(0, Number(t.rate) || 0)),
            compound: t.compound === true,
          }))
          .filter((t) => t.rate > 0);
      }
      if (patch.businessPreset !== undefined && (await posHasBusinessPreset())) {
        // validated against the known preset ids; anything else clears
        // back to "never chosen" rather than storing junk on the row.
        clean.business_preset = isBusinessPreset(patch.businessPreset) ? patch.businessPreset : null;
      }
      const v4 = await posHasV4();
      const hasPreset = await posHasBusinessPreset();
      const row = check(
        await client
          .from('pos_stores')
          .update(clean)
          .eq('id', storeId)
          .select(
            (v4 ? 'id, name, currency, tax_rate, tax_rates, created_at' : 'id, name, currency, tax_rate, created_at') +
              (hasPreset ? ', business_preset' : '')
          )
          .single(),
        'Saving store settings'
      );
      return mapPosStore(row);
    },

    async deleteStore(storeId) {
      const uid = requireUid();
      check(await client.from('pos_stores').delete().eq('id', storeId), 'Deleting store');
      // If this was the active catalogue shop, forget it so the next
      // resolve picks a shop the user still belongs to.
      try {
        if (typeof localStorage !== 'undefined' && localStorage.getItem(bqActiveStoreKey(uid)) === storeId) {
          localStorage.removeItem(bqActiveStoreKey(uid));
        }
      } catch { /* storage unavailable — harmless */ }
      bqClearStoreCache();
    },

    async createInvite(storeId, { role = 'cashier', maxUses = null, expiresInHours = null } = {}) {
      const uid = requireUid();
      if (!['manager', 'cashier'].includes(role)) {
        throw new Error('Invite role must be manager or cashier.');
      }
      for (let attempt = 0; attempt < 5; attempt++) {
        const code = makeInviteCode();
        const res = await client
          .from('pos_invites')
          .insert({
            store_id: storeId,
            code,
            role,
            created_by: uid,
            max_uses: maxUses,
            expires_at: expiresInHours
              ? new Date(Date.now() + expiresInHours * 3600 * 1000).toISOString()
              : null,
          })
          .select('id, code, role, created_at, expires_at, max_uses, uses')
          .single();
        if (!res.error) {
          const r = res.data;
          return {
            id: r.id,
            code: r.code,
            role: r.role,
            createdAt: r.created_at,
            expiresAt: r.expires_at,
            maxUses: r.max_uses,
            uses: r.uses,
          };
        }
        if (res.error.code !== '23505') {
          throw new Error(`Creating invite failed: ${res.error.message}`);
        }
        // code collision — retry with a fresh code
      }
      throw new Error('Could not generate a unique invite code — try again.');
    },

    async listInvites(storeId) {
      const rows = check(
        await client
          .from('pos_invites')
          .select('*')
          .eq('store_id', storeId)
          .order('created_at', { ascending: false }),
        'Loading invites'
      );
      return rows.map((r) => ({
        id: r.id,
        code: r.code,
        role: r.role,
        createdAt: r.created_at,
        expiresAt: r.expires_at,
        maxUses: r.max_uses,
        uses: r.uses,
      }));
    },

    async revokeInvite(storeId, inviteId) {
      check(
        await client.from('pos_invites').delete().eq('id', inviteId).eq('store_id', storeId),
        'Revoking invite'
      );
    },

    async joinStore(code) {
      const clean = String(code ?? '').trim().toUpperCase();
      if (!clean) throw new Error('Enter an invite code.');
      return check(await client.rpc('join_pos_store', { p_code: clean }), 'Joining store');
    },

    async listMembers(storeId) {
      const rows = check(
        await client
          .from('pos_store_members')
          .select('role, joined_at, user_id')
          .eq('store_id', storeId)
          .order('joined_at'),
        'Loading team'
      );
      // profiles has no FK from pos_store_members (user_id -> auth.users), so
      // fetch usernames in a second query; the pos_teammates RLS policy
      // allows members to see each other's profiles.
      const ids = rows.map((r) => r.user_id);
      let byId = {};
      if (ids.length > 0) {
        const profs = check(
          await client.from('profiles').select('id, username, display_name').in('id', ids),
          'Loading teammate names'
        );
        byId = Object.fromEntries(profs.map((p) => [p.id, p]));
      }
      return rows.map((r) => ({
        userId: r.user_id,
        username: byId[r.user_id]?.username ?? byId[r.user_id]?.display_name ?? 'Teammate',
        role: r.role,
        joinedAt: r.joined_at,
      }));
    },

    // Every membership the caller can see (RLS: members see their own stores'
    // rosters). Used by the admin Accounts screen to show each account's
    // shop assignments and shop roles.
    async adminListMemberships() {
      const rows = check(
        await client
          .from('pos_store_members')
          .select('user_id, store_id, role, pos_stores(id, name)')
          .order('joined_at'),
        'Loading shop assignments'
      );
      return (rows || []).map((r) => ({
        userId: r.user_id,
        storeId: r.store_id,
        role: r.role,
        storeName: r.pos_stores?.name || '',
      }));
    },

    async setMemberRole(storeId, userId, role) {
      if (!['owner', 'manager', 'cashier'].includes(role)) throw new Error('Unknown role.');
      // select() the row back: without it a no-op update (RLS-blocked or
      // unknown member) would look like success.
      const rows = check(
        await client
          .from('pos_store_members')
          .update({ role })
          .eq('store_id', storeId)
          .eq('user_id', userId)
          .select('user_id'),
        'Updating role'
      );
      if (!rows || rows.length === 0) {
        throw new Error('Updating role failed: member not found or not permitted.');
      }
    },

    async removeMember(storeId, userId) {
      const rows = check(
        await client
          .from('pos_store_members')
          .delete()
          .eq('store_id', storeId)
          .eq('user_id', userId)
          .select('user_id'),
        'Removing team member'
      );
      if (!rows || rows.length === 0) {
        throw new Error('Removing team member failed: member not found or not permitted.');
      }
    },

    async listProducts(storeId) {
      const rows = check(
        await client.from('pos_products').select('*').eq('store_id', storeId).order('name'),
        'Loading products'
      );
      return rows.map(mapPosProduct);
    },

    async saveProduct(storeId, product) {
      const v4 = await posHasV4();
      const clean = {
        store_id: storeId,
        name: String(product.name ?? '').trim(),
        sku: String(product.sku ?? '').trim() || null,
        price_cents: Math.round(Number(product.priceCents)),
        category: String(product.category ?? '').trim() || null,
        active: product.active !== false,
      };
      if (v4) {
        clean.cost_cents = Math.max(0, Math.round(Number(product.costCents) || 0));
        clean.track_stock = !!product.trackStock;
        clean.stock = Math.max(0, Math.round(Number(product.stock) || 0));
        clean.low_stock_threshold = Math.max(0, Math.round(Number(product.lowStockThreshold) || 0));
        clean.image_url = String(product.imageUrl ?? '').trim() || null;
        clean.variants = (Array.isArray(product.variants) ? product.variants : [])
          .map((v, i) => ({
            id: String(v.id ?? `v${i}`),
            name: String(v.name ?? '').trim().slice(0, 40) || `Option ${i + 1}`,
            priceDeltaCents: Math.round(Number(v.priceDeltaCents) || 0),
            sku: String(v.sku ?? '').trim() || null,
          }))
          .filter((v) => v.name);
      }
      if (!clean.name) throw new Error('Product name cannot be empty.');
      if (!Number.isFinite(clean.price_cents) || clean.price_cents <= 0) {
        throw new Error('Price must be above zero.');
      }
      let row;
      if (product.id) {
        row = check(
          await client
            .from('pos_products')
            .update(clean)
            .eq('id', product.id)
            .eq('store_id', storeId)
            .select('*')
            .single(),
          'Saving product'
        );
      } else {
        row = check(
          await client.from('pos_products').insert(clean).select('*').single(),
          'Adding product'
        );
      }
      return mapPosProduct(row);
    },

    async deleteProduct(storeId, id) {
      check(
        await client.from('pos_products').delete().eq('id', id).eq('store_id', storeId),
        'Deleting product'
      );
    },

    // ---- storefront (migration 063): the shop's public web page ----
    // The storefront reads THIS database: the profile edited here and the
    // products' public_visible flags are exactly what the
    // public_storefront() RPC serves to anonymous visitors once the shop
    // publishes its page. Products default to visible, so a product
    // created in the POS appears on the website with no extra step.

    async getStorefrontProfile(storeId) {
      const rows = check(
        await client
          .from('storefront_profiles')
          .select('*')
          .eq('store_id', storeId)
          .limit(1),
        'Loading storefront'
      );
      return rows[0] || null;
    },

    // Migration 068: does the storefront link/address column set
    // exist yet? The admin form disables its link fields while it doesn't.
    async storefrontLinksReady() {
      return storefrontHasLinks();
    },

    async saveStorefrontProfile(storeId, p) {
      const clean = {
        store_id: storeId,
        slug: String(p.slug ?? '').trim().toLowerCase(),
        display_name: String(p.displayName ?? '').trim() || null,
        tagline: String(p.tagline ?? '').trim() || null,
        about: String(p.about ?? '').trim() || null,
        hours: String(p.hours ?? '').trim() || null,
        contact_email: String(p.contactEmail ?? '').trim() || null,
        contact_phone: String(p.contactPhone ?? '').trim() || null,
        accent_color: String(p.accentColor ?? '').trim() || null,
        published: !!p.published,
        show_prices: p.showPrices !== false,
      };
      // Web-service link columns (071, draft). Omitted entirely until the
      // columns exist, so a 063 database keeps saving exactly as before;
      // values that do not validate are stored as null, never as a bad link.
      if (await storefrontHasLinks()) {
        Object.assign(clean, cleanLinkFields(p));
      }
      // Online-ordering columns (migration 071). Omitted until the columns
      // exist, so pre-073 databases keep saving exactly as before.
      if (await posHasOnlineOrders()) {
        clean.online_ordering = !!p.onlineOrdering;
        clean.ordering_note = String(p.orderingNote ?? '').trim() || null;
      }
      // Lemon Squeezy columns (migration 089). Omitted until the columns exist.
      try {
        const { data: lsCheck } = await client
          .from('storefront_profiles')
          .select('ls_enabled')
          .limit(0);
        // If we get here without error, columns exist
        clean.ls_enabled = !!p.lsEnabled;
        const checkoutUrl = String(p.lsCheckoutUrl ?? '').trim();
        clean.ls_checkout_url = /^https:\/\//i.test(checkoutUrl) ? checkoutUrl : null;
        const storeUrl = String(p.lsStoreUrl ?? '').trim();
        clean.ls_store_url = /^https:\/\//i.test(storeUrl) ? storeUrl : null;
        // Webhook secret (migration 095)
        try {
          const secret = String(p.lsWebhookSecret ?? '').trim();
          clean.ls_webhook_secret = secret || null;
        } catch { /* column may not exist yet */ }
      } catch {
        // Columns don't exist yet, skip
      }
      // Stripe columns (migration 091). Omitted until the columns exist.
      try {
        const { data: stripeCheck } = await client
          .from('storefront_profiles')
          .select('stripe_enabled')
          .limit(0);
        clean.stripe_enabled = !!p.stripeEnabled;
        const stripeUrl = String(p.stripeCheckoutUrl ?? '').trim();
        clean.stripe_checkout_url = /^https:\/\//i.test(stripeUrl) ? stripeUrl : null;
        // Webhook secret (migration 095)
        try {
          const secret = String(p.stripeWebhookSecret ?? '').trim();
          clean.stripe_webhook_secret = secret || null;
        } catch { /* column may not exist yet */ }
      } catch {
        // Columns don't exist yet, skip
      }
      if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(clean.slug)) {
        throw new Error(
          'Storefront address must use lowercase letters, numbers and dashes only.'
        );
      }
      const row = check(
        await client
          .from('storefront_profiles')
          .upsert(clean, { onConflict: 'store_id' })
          .select('*')
          .single(),
        'Saving storefront'
      );
      return row;
    },

    async setProductPublicVisible(storeId, productId, visible) {
      const row = check(
        await client
          .from('pos_products')
          .update({ public_visible: !!visible })
          .eq('id', productId)
          .eq('store_id', storeId)
          .select('*')
          .single(),
        'Updating product visibility'
      );
      return mapPosProduct(row);
    },

    // ---- Per-shop own domains (migration 074) ----
    // A shop that bought its own domain name points a CNAME at us and
    // registers the name here; public_storefront_by_host() then serves
    // its published storefront on that hostname. RLS does the policing
    // (owner/manager writes); this layer normalizes and explains.

    async customDomainsReady() {
      return customDomainsExist();
    },

    async listCustomDomains(storeId) {
      const rows = check(
        await client
          .from('custom_domains')
          .select('hostname, verified_at, verification_token, verification_txt_name, created_at')
          .eq('store_id', storeId)
          .order('created_at', { ascending: true }),
        'Loading your domain names'
      );
      return (rows || []).map((r) => ({
        hostname: r.hostname,
        verifiedAt: r.verified_at || null,
        txtName: r.verification_txt_name || `_vendra-verify.${r.hostname}`,
        txtValue: r.verification_token ? `vendra-verify=${r.verification_token}` : '',
        createdAt: r.created_at || null,
      }));
    },

    // Claim a hostname (migration 074): the server hands out the DNS
    // TXT record that proves this shop controls the domain. The shop
    // is NOT live on the name until confirmCustomDomain() sees it.
    async addCustomDomain(storeId, rawHostname) {
      const hostname = normalizeDomainInput(rawHostname);
      if (!isValidHostname(hostname)) {
        throw new Error('DOMAIN_INVALID');
      }
      const { data, error } = await client.rpc('custom_domain_claim', {
        p_store_id: storeId,
        p_hostname: hostname,
      });
      if (error) {
        if (/DOMAIN_TAKEN/i.test(error.message || '')) throw new Error('DOMAIN_TAKEN');
        if (/DOMAIN_INVALID/i.test(error.message || '')) throw new Error('DOMAIN_INVALID');
        throw new Error(`Connecting the domain failed: ${error.message}`);
      }
      return {
        hostname: data.hostname,
        verifiedAt: data.verified_at || null,
        txtName: data.txt_name,
        txtValue: data.txt_value,
        createdAt: null,
      };
    },

    // Verify a claimed hostname: look up the TXT record over DNS-over-
    // HTTPS (the browser has internet; SQL does not) and, if it matches
    // the shop's secret token, ask the server to stamp it verified.
    // Resolves true once verified; false while DNS has not caught up.
    async confirmCustomDomain(storeId, domain) {
      const txtName = domain.txtName || `_vendra-verify.${domain.hostname}`;
      const res = await fetch(
        `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(txtName)}&type=TXT`,
        { headers: { Accept: 'application/dns-json' } }
      );
      if (!res.ok) throw new Error('DNS_LOOKUP_FAILED');
      const body = await res.json().catch(() => null);
      const answers = (body && Array.isArray(body.Answer)) ? body.Answer : [];
      const seen = answers
        .map((a) => String(a.data || '').replace(/^"|"$/g, '').replace(/"\s*"/g, ''))
        .find((v) => v === domain.txtValue);
      if (!seen) return false;
      const { data, error } = await client.rpc('custom_domain_confirm', {
        p_store_id: storeId,
        p_hostname: domain.hostname,
        p_txt_value: seen,
      });
      if (error) throw new Error(error.message || 'DOMAIN_CONFIRM_FAILED');
      return !!(data && data.verified);
    },

    async removeCustomDomain(storeId, hostname) {
      check(
        await client
          .from('custom_domains')
          .delete()
          .eq('store_id', storeId)
          .eq('hostname', hostname),
        'Removing the domain name'
      );
    },

    // ---- online ordering (migration 071) ----
    // Customer orders placed on the published storefront. Shop staff see
    // the inbox in the POS; every write goes through the validated RPCs
    // (status transitions, idempotent convert-to-sale) — the tables have
    // no direct-write RLS policies at all.
    async onlineOrdersReady() {
      return posHasOnlineOrders();
    },

    // Open orders: received / preparing / ready, newest first.
    async listOnlineOrders(storeId) {
      const { data, error } = await client.rpc('online_orders_inbox', {
        p_store_id: storeId,
      });
      if (error) throw new Error(error.message);
      return Array.isArray(data) ? data : [];
    },

    // Finished orders: done / cancelled, newest first.
    async archiveOnlineOrders(storeId, limit = 50) {
      const { data, error } = await client.rpc('online_orders_archive', {
        p_store_id: storeId,
        p_limit: limit,
      });
      if (error) throw new Error(error.message);
      return Array.isArray(data) ? data : [];
    },

    // Number of brand-new ('received') orders — the inbox badge.
    async countNewOnlineOrders(storeId) {
      const res = await client
        .from('online_orders')
        .select('id', { count: 'exact', head: true })
        .eq('store_id', storeId)
        .eq('status', 'received');
      if (res.error) return 0;
      return res.count ?? 0;
    },

    async setOnlineOrderStatus(orderId, status) {
      const { data, error } = await client.rpc('online_order_set_status', {
        p_order_id: orderId,
        p_status: status,
      });
      if (error) throw new Error(error.message);
      return data;
    },

    // Record the pickup as a real till sale (channel 'online') and mark
    // the order done — one atomic RPC. Returns { sale_id, sale_number,
    // order_number, stock: [...] } where stock may carry oversold flags
    // for lines that went below zero (floored at 0 by the till's stock
    // function).
    async convertOnlineOrder(orderId, { method, tenderedCents }) {
      const { data, error } = await client.rpc('online_order_convert', {
        p_order_id: orderId,
        p_method: method,
        p_tendered_cents: tenderedCents == null ? null : Math.round(tenderedCents),
      });
      if (error) throw new Error(error.message);
      return data;
    },

    async listSales(storeId, { limit = 200 } = {}) {
      const v4 = await posHasV4();
      const rows = check(
        await client
          .from('pos_sales')
          .select(v4 ? '*, pos_customers(name)' : '*')
          .eq('store_id', storeId)
          .order('created_at', { ascending: false })
          .limit(limit),
        'Loading sales'
      );
      const sales = rows.map(mapPosSale);
      // Attach refund history (migration 034) so the refund dialog can show
      // remaining refundable quantities and already-refunded badges. The
      // per-line `key` matches the dialog's refundKeyOf
      // (productId::variantId::lineIndex).
      if (await posHasRefunds()) {
        try {
          const ids = sales.map((s) => s.id);
          if (ids.length) {
            const rrows = check(
              await client
                .from('pos_refunds')
                .select('id, sale_id, line_index, qty, refunded_cents, method, reason, created_at')
                .in('sale_id', ids)
                .order('created_at', { ascending: true }),
              'Loading refunds'
            );
            const bySale = new Map();
            for (const r of rrows || []) {
              if (!bySale.has(r.sale_id)) bySale.set(r.sale_id, []);
              bySale.get(r.sale_id).push({
                id: r.id,
                lineIndex: r.line_index,
                qty: r.qty,
                refundedCents: Number(r.refunded_cents) || 0,
                method: r.method,
                reason: r.reason || '',
                createdAt: r.created_at,
              });
            }
            for (const s of sales) {
              const list = bySale.get(s.id) || [];
              s.refunds = list.map((r) => {
                const it = (s.items || [])[r.lineIndex] || {};
                return {
                  ...r,
                  lines: [{ key: `${it.productId || ''}::${it.variantId || ''}::${r.lineIndex}`, index: r.lineIndex, qty: r.qty }],
                };
              });
            }
          }
        } catch {
          for (const s of sales) s.refunds = s.refunds || [];
        }
      }
      return sales;
    },

    async recordSale(storeId, sale) {
      const uid = requireUid();
      const v4 = await posHasV4();
      const allowed = v4 ? ['cash', 'card', 'other'] : ['cash', 'card'];
      if (!allowed.includes(sale.method)) throw new Error('Unknown payment method.');
      // NUCLEAR FAILSAFE: server-enforced idempotency (migration 050). If a
      // caller supplies a UUID idempotency key, the unique index on
      // (store_id, idempotency_key) makes replays safe. A duplicate key means
      // the sale was ALREADY recorded — return the existing row instead of
      // creating a duplicate.
      const idemKey = sale.idempotencyKey ? String(sale.idempotencyKey).slice(0, 128) : null;
      const payload = {
        store_id: storeId,
        items: sale.items ?? [],
        subtotal_cents: sale.subtotalCents ?? 0,
        discount_cents: sale.discountCents ?? 0,
        tax_cents: sale.taxCents ?? 0,
        total_cents: sale.totalCents ?? 0,
        method: sale.method,
        tendered_cents: sale.tenderedCents ?? 0,
        change_cents: sale.changeCents ?? 0,
        created_by: uid,
      };
      if (v4) {
        payload.cashier_name = sale.cashierName ? String(sale.cashierName).slice(0, 80) : null;
        payload.cashier_id = sale.cashierId ?? null;
        payload.staff_pin_id = sale.staffPinId ?? null;
        payload.customer_id = sale.customerId ?? null;
      }
      // Idempotency key goes on every insert when present (migration 050).
      // Pre-050 servers don't have the column — the probe below guards it.
      const hasIdemCol = idemKey ? await posHasSaleIdemCol() : false;
      if (hasIdemCol) payload.idempotency_key = idemKey;
      // Persist the exact tax lines charged (migration 021) so receipts and
      // reprints show historical truth instead of recomputing from the
      // store's current tax settings.
      if (await posHasTaxLines()) {
        payload.tax_lines = Array.isArray(sale.taxLines)
          ? sale.taxLines.map((l) => ({
              name: String(l.name ?? 'Tax').slice(0, 24),
              rate: Number(l.rate) || 0,
              cents: Math.round(Number(l.cents) || 0),
              compound: l.compound === true,
            }))
          : [];
      }
      // Organization snapshot (migration 025): the org's name/type/exempt
      // state at sale time, so reprints and the books keep history even if
      // the org is renamed or deleted later.
      if (await posHasOrgs()) {
        payload.org_id = sale.orgId ?? null;
        payload.org_name = sale.orgName ? String(sale.orgName).slice(0, 120) : null;
        payload.org_type = sale.orgType ? String(sale.orgType).slice(0, 24) : null;
        payload.org_tax_exempt = !!sale.taxExempt;
      }
      // Promo / tender-adjustment / loyalty snapshot (migration 045): these
      // were previously computed but silently dropped from the insert, so
      // promos vanished from the books. Sanitized the same way as tax_lines.
      if (await posHasPromoCols()) {
        payload.promo_code = sale.promoCode ? String(sale.promoCode).slice(0, 64) : null;
        payload.promo_discount_cents = Math.max(0, Math.round(Number(sale.promoDiscountCents) || 0));
        payload.tender_adjustments = Array.isArray(sale.adjustments)
          ? sale.adjustments.map((a) => ({
              kind: String(a.kind ?? 'other').slice(0, 24),
              refId: a.refId || null,
              code: a.code ? String(a.code).slice(0, 64) : null,
              label: String(a.label ?? a.kind ?? 'adjustment').slice(0, 120),
              cents: Math.max(0, Math.round(Number(a.cents) || 0)),
              points: a.points != null ? Math.max(0, Math.round(Number(a.points) || 0)) : null,
            }))
          : [];
        payload.loyalty_earned = Math.max(0, Math.round(Number(sale.loyaltyEarned) || 0));
        payload.loyalty_redeemed_points = Math.max(0, Math.round(Number(sale.loyaltyRedeemed) || 0));
      }
      // Sales channel (migration 064): fair sales are first-class ledger
      // rows marked channel='fair' with the fair snapshot, so History,
      // Reports and refunds treat them like any other sale. Register sales
      // simply don't pass these fields.
      if (await posHasSaleChannel()) {
        payload.channel = sale.channel === 'fair' ? 'fair' : 'register';
        payload.fair_id = sale.fairId ?? null;
        payload.fair_name = sale.fairName ? String(sale.fairName).slice(0, 120) : null;
      }
      let replayed = false;
      const row = await (async () => {
        try {
          return check(
            await client
              .from('pos_sales')
              .insert(payload)
              .select(v4 ? '*, pos_customers(name)' : '*')
              .single(),
            'Recording sale'
          );
        } catch (err) {
          // NUCLEAR FAILSAFE: idempotent replay. If the insert hit the
          // (store_id, idempotency_key) unique index, this exact sale was
          // already recorded (e.g. the first attempt committed but its
          // response was lost). Return the existing row — do NOT duplicate.
          const msg = String(err?.message || '');
          if (hasIdemCol && /duplicate key|unique constraint|23505|pos_sales_store_idempotency_key/i.test(msg)) {
            const { data, error } = await client
              .from('pos_sales')
              .select(v4 ? '*, pos_customers(name)' : '*')
              .eq('store_id', storeId)
              .eq('idempotency_key', idemKey)
              .maybeSingle();
            if (!error && data) {
              replayed = true;
              return data;
            }
          }
          throw err;
        }
      })();
      // Decrement tracked stock atomically (migration 026). Best-effort: a
      // stock failure must not lose the sale record itself — but oversold
      // lines are returned so the caller can warn instead of guessing.
      // M-1 (nuclear QA): on an idempotent REPLAY the stock was already
      // applied by the first attempt — never apply it twice. When the
      // server has migration 075, the idempotency key is also passed so
      // the database enforces exactly-once even across lost responses.
      let stockResult = { results: [] };
      if (v4 && Array.isArray(sale.items) && !replayed) {
        try {
          stockResult = await this.applySaleStock(storeId, sale.items, idemKey);
        } catch (err) {
          console.error('[drift] stock decrement failed:', err);
        }
      }
      const mapped = mapPosSale(row); // number assigned by the DB trigger
      // Oversold / failed stock lines ride along so the receipt can warn.
      mapped.stockWarnings = (stockResult.results || []).filter((r) => r.oversold || r.error);
      return mapped;
    },

    // Reduce stock for tracked products referenced by sale items.
    // Atomic post-sale stock decrement (migration 026): every line is
    // decremented in ONE server transaction with row locks, so two
    // registers selling the last copy at the same moment can't lose a
    // decrement. Returns { results: [{ key, name, stock, oversold, error? }] }
    // — oversold lines are reported so the UI can warn, never silent.
    // Falls back to the legacy client read-then-write on pre-026 servers.
    async applySaleStock(storeId, lines, idempotencyKey = null) {
      const v26 = await posHasV26();
      const clean = (lines || [])
        .map((l) => ({
          product_id: l.productId && !String(l.productId).startsWith('bq:') ? l.productId : null,
          bq_item_id: l.bqItemId || null,
          qty: Math.max(0, Math.round(Number(l.qty) || 0)),
          name: String(l.name || 'item').slice(0, 120),
        }))
        .filter((l) => (l.product_id || l.bq_item_id) && l.qty > 0);
      if (clean.length === 0) return { results: [] };
      if (v26) {
        // Migration 075: keyed stock application is exactly-once. Older
        // servers (or keyless calls) keep the 026 path unchanged.
        if (idempotencyKey && (await posHasStockOnce())) {
          const { data, error } = await client.rpc('pos_apply_sale_stock_once', {
            p_store_id: storeId,
            p_lines: clean,
            p_idempotency_key: String(idempotencyKey).slice(0, 128),
          });
          if (error) throw new Error(`Updating stock failed: ${error.message}`);
          return data || { results: [] };
        }
        const { data, error } = await client.rpc('pos_apply_sale_stock', {
          p_store_id: storeId,
          p_lines: clean,
        });
        if (error) throw new Error(`Updating stock failed: ${error.message}`);
        return data || { results: [] };
      }
      // Legacy path: best-effort client read-then-write.
      await this.decrementStockForItems(storeId, clean.map((l) => ({ productId: l.product_id, qty: l.qty })));
      return { results: [] };
    },

    async decrementStockForItems(storeId, items) {
      const byProduct = new Map();
      for (const i of items || []) {
        if (!i.productId || !i.qty) continue;
        byProduct.set(i.productId, (byProduct.get(i.productId) || 0) + i.qty);
      }
      for (const [productId, qty] of byProduct) {
        const prod = check(
          await client
            .from('pos_products')
            .select('id, stock, track_stock')
            .eq('id', productId)
            .eq('store_id', storeId)
            .single(),
          'Reading stock'
        );
        if (prod && prod.track_stock) {
          check(
            await client
              .from('pos_products')
              .update({ stock: Math.max(0, Number(prod.stock) - qty) })
              .eq('id', productId),
            'Updating stock'
          );
        }
      }
    },

    async adjustStock(storeId, productId, delta) {
      if (!(await posHasV4())) throw new Error('Inventory needs migration 004 — ask a manager to apply it.');
      const deltaInt = Math.round(Number(delta) || 0);
      // M9: Use atomic RPC when available (migration 084), falling back to
      // the legacy read-modify-write for older servers.
      try {
        const { data, error } = await client.rpc('pos_adjust_stock_atomic', {
          p_product_id: productId,
          p_store_id: storeId,
          p_delta: deltaInt,
        });
        if (!error && data) {
          const row = check(
            await client.from('pos_products').select('*').eq('id', productId).single(),
            'Reading stock'
          );
          return row;
        }
      } catch {}
      // Legacy fallback: racy read-modify-write (pre-084 server).
      const prod = check(
        await client
          .from('pos_products')
          .select('id, stock')
          .eq('id', productId)
          .eq('store_id', storeId)
          .single(),
        'Reading stock'
      );
      const row = check(
        await client
          .from('pos_products')
          .update({ stock: Math.max(0, Number(prod.stock) + deltaInt) })
          .eq('id', productId)
          .select('*')
          .single(),
        'Adjusting stock'
      );
      return mapPosProduct(row);
    },

    // Atomic server-side void (migration 024): the sale is marked voided and
    // inventory restocked in ONE transaction. Returns { voided, warnings } —
    // warnings name lines whose stock could not be restored (deleted product,
    // unknown shelf status) so staff can reconcile instead of guessing.
    // Throws on: not manager, already voided, sale not found.
    async voidSale(storeId, id, reason = '') {
      const v24 = await posHasV24();
      if (v24) {
        const { data, error } = await client.rpc('pos_void_sale', {
          p_sale_id: id,
          p_reason: String(reason ?? '').trim().slice(0, 200),
        });
        if (error) {
          const msg = String(error.message || '');
          if (/already voided/i.test(msg)) throw new Error('That sale was already voided.');
          if (/only managers/i.test(msg)) throw new Error('Only managers can void sales.');
          if (/has refunds/i.test(msg)) throw new Error('This sale has refunds and can’t be voided — the refund is the permanent record.');
          throw new Error(`Voiding sale failed: ${msg}`);
        }
        return data || { voided: true, warnings: [] };
      }
      // Legacy path (pre-024 server): claim-then-restock.
      const uid = requireUid();
      // M5: Legacy path must also refuse to void sales with refunds.
      const { data: saleCheck } = await client
        .from('pos_sales')
        .select('id, refunds')
        .eq('id', id)
        .eq('store_id', storeId)
        .single();
      if (saleCheck?.refunds && Array.isArray(saleCheck.refunds) && saleCheck.refunds.length > 0) {
        throw new Error('This sale has refunds and can’t be voided — the refund is the permanent record.');
      }
      const v4 = await posHasV4();
      const patch = { voided: true, voided_at: new Date().toISOString(), voided_by: uid };
      if (v4 && String(reason ?? '').trim()) patch.void_reason = String(reason).trim().slice(0, 200);
      if (v4) {
        // Atomically claim the void: only the first caller flips voided from
        // false to true. A second caller (double-click, retry, race) gets zero
        // rows back and must NOT restock again.
        const claimed = check(
          await client
            .from('pos_sales')
            .update(patch)
            .eq('id', id)
            .eq('store_id', storeId)
            .eq('voided', false)
            .select('id,items'),
          'Voiding sale'
        );
        if (claimed && claimed.length > 0) {
          try {
            const negated = (claimed[0].items || []).map((i) => ({ ...i, qty: -(i.qty || 0) }));
            await this.decrementStockForItems(storeId, negated);
          } catch (err) {
            console.error('[drift] restock on void failed:', err);
          }
        }
        return { voided: true, warnings: [] };
      }
      check(
        await client
          .from('pos_sales')
          .update(patch)
          .eq('id', id)
          .eq('store_id', storeId),
        'Voiding sale'
      );
      return { voided: true, warnings: [] };
    },

    /* ----- customers ----- */
    async listCustomers(storeId) {
      if (!(await posHasV4())) return [];
      const rows = check(
        await client.from('pos_customers').select('*').eq('store_id', storeId).order('name'),
        'Loading customers'
      );
      return rows.map((r) => ({
        id: r.id,
        name: r.name,
        phone: r.phone ?? '',
        email: r.email ?? '',
        notes: r.notes ?? '',
        createdAt: r.created_at,
      }));
    },

    async saveCustomer(storeId, customer) {
      if (!(await posHasV4())) throw new Error('Customers need migration 004 — ask a manager to apply it.');
      const clean = {
        store_id: storeId,
        name: String(customer.name ?? '').trim(),
        phone: String(customer.phone ?? '').trim() || null,
        email: String(customer.email ?? '').trim() || null,
        notes: String(customer.notes ?? '').trim() || null,
      };
      if (!clean.name) throw new Error('Customer name cannot be empty.');
      let row;
      if (customer.id) {
        row = check(
          await client.from('pos_customers').update(clean).eq('id', customer.id).eq('store_id', storeId).select('*').single(),
          'Saving customer'
        );
      } else {
        row = check(
          await client.from('pos_customers').insert(clean).select('*').single(),
          'Adding customer'
        );
      }
      return {
        id: row.id, name: row.name, phone: row.phone ?? '', email: row.email ?? '',
        notes: row.notes ?? '', createdAt: row.created_at,
      };
    },

    async deleteCustomer(storeId, id) {
      if (!(await posHasV4())) throw new Error('Customers need migration 004 — ask a manager to apply it.');
      check(
        await client.from('pos_customers').delete().eq('id', id).eq('store_id', storeId),
        'Deleting customer'
      );
    },

    /* ----- organizations ----- */
    async listOrgs(storeId) {
      if (!(await posHasOrgs())) return [];
      const rows = check(
        await client.from('pos_orgs').select('*').eq('store_id', storeId).order('name'),
        'Loading organizations'
      );
      return rows.map(mapPosOrg);
    },

    async saveOrg(storeId, org) {
      if (!(await posHasOrgs())) throw new Error('Organizations need the latest database update — ask a manager to apply it.');
      const clean = {
        store_id: storeId,
        name: String(org.name ?? '').trim(),
        type: ['entreprise', 'obnl', 'ecole', 'institution'].includes(org.type) ? org.type : 'entreprise',
        contact: String(org.contact ?? '').trim() || null,
        tax_exempt: !!org.taxExempt,
        notes: String(org.notes ?? '').trim() || null,
        updated_at: new Date().toISOString(),
      };
      if (!clean.name) throw new Error('Organization name cannot be empty.');
      let row;
      if (org.id) {
        row = check(
          await client.from('pos_orgs').update(clean).eq('id', org.id).eq('store_id', storeId).select('*').single(),
          'Saving organization'
        );
      } else {
        row = check(
          await client.from('pos_orgs').insert(clean).select('*').single(),
          'Saving organization'
        );
      }
      return mapPosOrg(row);
    },

    async deleteOrg(storeId, id) {
      if (!(await posHasOrgs())) throw new Error('Organizations need the latest database update — ask a manager to apply it.');
      // Sales keep their org snapshot (org_id set-nulls, name/type/exempt
      // stay), so deleting an org never rewrites history.
      check(
        await client.from('pos_orgs').delete().eq('id', id).eq('store_id', storeId),
        'Deleting organization'
      );
    },

    /* ----- community service hours (travaux communautaires) ----- */
    // Tracked separately from payroll. People are identified by name (they
    // are usually not employees); entries can link a staff row and/or an
    // organization for grouped attestations.
    async listCommunityHours(storeId, { from = null, to = null } = {}) {
      if (!(await posHasCommunity())) return [];
      let q = client
        .from('pos_community_hours')
        .select('id, person_name, staff_id, org_id, service_date, minutes, notes, created_at, pos_orgs(name)')
        .eq('store_id', storeId)
        .order('service_date', { ascending: false })
        .order('created_at', { ascending: false })
        .limit(2000);
      if (from) q = q.gte('service_date', from);
      if (to) q = q.lte('service_date', to);
      const rows = check(await q, 'Loading community-service hours');
      return (rows || []).map((r) => ({
        id: r.id,
        personName: r.person_name,
        staffId: r.staff_id,
        orgId: r.org_id,
        orgName: r.pos_orgs?.name || null,
        date: r.service_date,
        minutes: r.minutes,
        notes: r.notes || '',
        createdAt: r.created_at,
      }));
    },

    async saveCommunityHours(storeId, entry) {
      if (!(await posHasCommunity())) throw new Error('Community service needs the latest database update — ask a manager to apply it.');
      const name = String(entry.personName || '').trim();
      if (!name) throw new Error('Enter the person\u2019s name.');
      const minutes = Math.round(Number(entry.minutes) || 0);
      if (minutes <= 0 || minutes > 1440) throw new Error('Hours must be between a minute and 24 hours.');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.date || '')) throw new Error('Pick a valid date.');
      const payload = {
        store_id: storeId,
        person_name: name.slice(0, 120),
        staff_id: entry.staffId || null,
        org_id: entry.orgId || null,
        service_date: entry.date,
        minutes,
        notes: String(entry.notes || '').slice(0, 1000),
      };
      if (entry.id) {
        const rows = check(
          await client.from('pos_community_hours').update(payload).eq('id', entry.id).eq('store_id', storeId).select('id'),
          'Updating hours entry'
        );
        if (!rows || rows.length === 0) throw new Error('Entry not found or you lack permission.');
        return entry.id;
      }
      let recordedBy = null;
      try { recordedBy = (await client.auth.getUser()).data?.user?.id || null; } catch { /* anonymous */ }
      const rows = check(
        await client.from('pos_community_hours').insert({ ...payload, recorded_by: recordedBy }).select('id').single(),
        'Recording hours'
      );
      return rows.id;
    },

    async deleteCommunityHours(storeId, id) {
      if (!(await posHasCommunity())) throw new Error('Community service needs the latest database update — ask a manager to apply it.');
      // RLS restricts this to owner/manager; a 0-row delete means denied.
      const rows = check(
        await client.from('pos_community_hours').delete().eq('id', id).eq('store_id', storeId).select('id'),
        'Deleting hours entry'
      );
      if (!rows || rows.length === 0) throw new Error('Entry not found or you lack permission.');
    },

    /* ----- gift cards (migration 028) ----- */
    // Every balance mutation runs in a server RPC that locks the card row —
    // concurrent redemptions serialize, so a card can never be double-spent.
    async listGiftCards(storeId, { outstandingOnly = false } = {}) {
      if (!(await posHasGiftCards())) return [];
      let q = client
        .from('pos_gift_cards')
        .select('id, code, initial_cents, balance_cents, note, status, sold_at')
        .eq('store_id', storeId)
        .order('sold_at', { ascending: false })
        .limit(500);
      if (outstandingOnly) q = q.eq('status', 'active').gt('balance_cents', 0);
      const rows = check(await q, 'Loading gift cards');
      return (rows || []).map((r) => ({
        id: r.id,
        code: r.code,
        initialCents: r.initial_cents,
        balanceCents: r.balance_cents,
        note: r.note || '',
        status: r.status,
        soldAt: r.sold_at,
      }));
    },

    async sellGiftCard(storeId, { amountCents, note = '' }) {
      if (!(await posHasGiftCards())) throw new Error('Gift cards need the latest database update — ask a manager to apply it.');
      const cents = Math.round(Number(amountCents) || 0);
      if (cents <= 0) throw new Error('Amount must be positive.');
      const rows = check(
        await client.rpc('pos_giftcard_issue', {
          p_store_id: storeId,
          p_amount_cents: cents,
          p_note: String(note || '').slice(0, 500),
        }),
        'Issuing gift card'
      );
      const r = Array.isArray(rows) ? rows[0] : rows;
      if (!r) throw new Error('Could not issue the gift card.');
      return { id: r.id, code: r.code, initialCents: r.initial_cents, balanceCents: r.balance_cents };
    },

    async redeemGiftCard(storeId, id, amountCents) {
      if (!(await posHasGiftCards())) throw new Error('Gift cards need the latest database update — ask a manager to apply it.');
      const cents = Math.round(Number(amountCents) || 0);
      if (cents <= 0) throw new Error('Amount must be positive.');
      const rows = check(
        await client.rpc('pos_giftcard_redeem', { p_card_id: id, p_amount_cents: cents }),
        'Redeeming gift card'
      );
      const r = Array.isArray(rows) ? rows[0] : rows;
      if (!r) throw new Error('Could not redeem the gift card.');
      return { id: r.id, code: r.code, balanceCents: r.balance_cents };
    },

    // Rollback / correction: puts money back, capped at the initial value so
    // a credit can never mint money beyond what was sold.
    async creditGiftCard(storeId, id, amountCents) {
      if (!(await posHasGiftCards())) throw new Error('Gift cards need the latest database update — ask a manager to apply it.');
      const cents = Math.round(Number(amountCents) || 0);
      if (cents <= 0) throw new Error('Amount must be positive.');
      const rows = check(
        await client.rpc('pos_giftcard_credit', { p_card_id: id, p_amount_cents: cents }),
        'Crediting gift card'
      );
      const r = Array.isArray(rows) ? rows[0] : rows;
      if (!r) throw new Error('Could not credit the gift card.');
      return { id: r.id, code: r.code, balanceCents: r.balance_cents };
    },

    // Manager+ only, server-enforced; only untouched cards can be voided.
    async voidGiftCard(storeId, id) {
      if (!(await posHasGiftCards())) throw new Error('Gift cards need the latest database update — ask a manager to apply it.');
      const rows = check(
        await client.rpc('pos_giftcard_void', { p_card_id: id }),
        'Voiding gift card'
      );
      const r = Array.isArray(rows) ? rows[0] : rows;
      if (!r) throw new Error('Could not void the gift card.');
      return { id: r.id, code: r.code, balanceCents: r.balance_cents };
    },

    // Safe rollback when a card was issued but its sale failed to record.
    // Server restricts this to untouched cards issued in the last 30 min by
    // the caller (or a manager), so it can't kill a customer's real card.
    async cancelGiftCardIssue(storeId, id) {
      if (!(await posHasGiftCards())) throw new Error('Gift cards need the latest database update — ask a manager to apply it.');
      check(
        await client.rpc('pos_giftcard_cancel_issue', { p_card_id: id }),
        'Cancelling gift card issue'
      );
    },

    // Best-effort audit link: tie a redeem/credit event back to its sale.
    // Never throws — a linking failure must not fail the sale itself.
    async linkGiftCardSale(storeId, id, amountCents, saleId) {
      try {
        if (!(await posHasGiftCards())) return;
        await client.rpc('pos_giftcard_link_sale', {
          p_card_id: id,
          p_amount_cents: Math.round(Number(amountCents) || 0),
          p_sale_id: saleId,
        });
      } catch (err) {
        console.error('[drift] gift card sale link failed:', err);
      }
    },

    async lookupTenderCode(storeId, code) {
      if (!(await posHasGiftCards())) throw new Error('Gift cards need the latest database update — ask a manager to apply it.');
      const rows = check(
        await client.rpc('pos_giftcard_lookup', { p_store_id: storeId, p_code: String(code || '') }),
        'Looking up code'
      );
      const r = Array.isArray(rows) ? rows[0] : rows;
      if (!r || r.status !== 'active' || r.balance_cents <= 0) {
        throw new Error('No active gift card matches that code.');
      }
      return {
        kind: 'giftcard',
        id: r.id,
        code: r.code,
        label: 'Gift card',
        balanceCents: r.balance_cents,
      };
    },

    // Append-only audit ledger for one card, oldest first.
    async giftCardHistory(storeId, id) {
      if (!(await posHasGiftCards())) return [];
      const rows = check(
        await client.rpc('pos_giftcard_history', { p_card_id: id }),
        'Loading gift card history'
      );
      return (Array.isArray(rows) ? rows : []).map((r) => ({
        kind: r.kind,
        amountCents: r.amount_cents,
        balanceAfterCents: r.balance_after_cents,
        createdAt: r.created_at,
        saleNumber: r.sale_number ?? null,
      }));
    },

    /* ----- refunds (migration 034) ----- */
    // Refunds run in one atomic server RPC: the sale row is locked,
    // each line is validated against already-refunded quantities (so a
    // double-click, retry or race can never over-refund), the refund is
    // computed with the same proportional math as the UI estimate, stock
    // is restocked, and "to credit" issues a gift card as store credit
    // (redeemable at tender through the gift-card flow). Manager-only,
    // server-enforced — mirroring pos_void_sale.
    async refundSale(storeId, saleId, { lines, reason = '', asCreditNote = false, idemKey = null }) {
      if (!(await posHasRefunds())) throw new Error('Refunds need the latest database update — ask a manager to apply it.');
      // Normalize the UI's {lineIndex, qty} line shape to the RPC's
      // {index, qty} shape at this boundary.
      const clean = (Array.isArray(lines) ? lines : [])
        .map((l) => ({
          index: Math.max(0, Math.round(Number(l.lineIndex ?? l.index) || 0)),
          qty: Math.max(0, Math.round(Number(l.qty) || 0)),
        }))
        .filter((l) => l.qty > 0);
      if (!clean.length) throw new Error('Select at least one line to refund.');
      const res = check(
        await client.rpc('pos_refund_sale', {
          p_sale_id: saleId,
          p_lines: clean,
          p_reason: String(reason || '').slice(0, 500),
          p_as_credit: !!asCreditNote,
          p_idem_key: idemKey || null,
        }),
        'Refunding sale'
      );
      const r = Array.isArray(res) ? res[0] : res;
      if (!r || !r.refund) throw new Error('Could not refund the sale.');
      return {
        refund: {
          refundedCents: Number(r.refund.refundedCents) || 0,
          lines: (r.refund.lines || []).map((l) => ({ index: l.index, qty: l.qty })),
        },
        creditNote: r.creditNote ? { code: r.creditNote.code } : null,
        warnings: Array.isArray(r.warnings) ? r.warnings : [],
      };
    },

    /* ----- staff PINs ----- */
    async listStaff(storeId) {
      if (!(await posHasV4())) return [];
      let rows;
      try {
        rows = check(
          await client.from('pos_staff').select('id, name, role, active, created_at').eq('store_id', storeId).order('name'),
          'Loading staff'
        );
      } catch (err) {
        throw friendlyPosError(err, 'load staff');
      }
      return rows.map((r) => ({
        id: r.id, name: r.name, role: r.role, active: !!r.active, createdAt: r.created_at,
      }));
    },

    async saveStaff(storeId, staff) {
      if (!(await posHasV4())) throw new Error('Staff PINs need migration 004 — ask a manager to apply it.');
      const name = String(staff.name ?? '').trim();
      if (!name) throw new Error('Staff name cannot be empty.');
      const role = ['owner', 'manager', 'cashier'].includes(staff.role) ? staff.role : 'cashier';
      const clean = { store_id: storeId, name, role, active: staff.active !== false };
      if (staff.pin) {
        const pinStr = String(staff.pin);
        if (!/^\d{4,8}$/.test(pinStr)) throw new Error('PIN must be 4–8 digits.');
        // Block common/guessable PINs (adversarial testing 2026-09-30).
        const commonPins = new Set([
          '1234', '0000', '1111', '1212', '7777', '1004', '2000', '4444',
          '2222', '6969', '9999', '3333', '5555', '6666', '8888', '12345',
          '123456', '1234567', '12345678', '000000', '111111',
        ]);
        if (commonPins.has(pinStr)) throw new Error('PIN_TOO_COMMON');
        clean.pin_hash = await sha256hex(staff.pin);
      } else if (!staff.id) {
        throw new Error('Set a PIN for the new staff member.');
      }
      let res;
      if (staff.id) {
        res = await client.from('pos_staff').update(clean).eq('id', staff.id).eq('store_id', storeId).select('id, name, role, active, created_at').single();
      } else {
        res = await client.from('pos_staff').insert(clean).select('id, name, role, active, created_at').single();
      }
      let row;
      try {
        row = check(res, 'Saving staff');
      } catch (err) {
        throw friendlyPosError(err, 'save staff');
      }
      if (staff.pin && (await posHasPinKdf())) {
        // Salted-KDF upgrade (migration 069, phase 1): the row just
        // saved carries the legacy pin_hash, so the punch RPCs keep
        // working no matter what; this RPC adds the bcrypt hash
        // server-side (and rewrites pin_hash from the same PIN, so the
        // two can never diverge). Best-effort on purpose: if the RPC
        // fails, the legacy hash the save already wrote is fully valid —
        // the PIN simply upgrades on the next save instead.
        try {
          check(
            await client.rpc('pos_staff_set_pin', {
              p_staff_id: row.id,
              p_pin: String(staff.pin),
            }),
            'Setting staff PIN'
          );
        } catch (err) {
          console.warn('salted PIN write failed (legacy hash still active):', err?.message || err);
        }
      }
      return { id: row.id, name: row.name, role: row.role, active: !!row.active, createdAt: row.created_at };
    },

    async deleteStaff(storeId, id) {
      if (!(await posHasV4())) throw new Error('Staff PINs need migration 004 — ask a manager to apply it.');
      try {
        check(
          await client.from('pos_staff').delete().eq('id', id).eq('store_id', storeId),
          'Deleting staff'
        );
      } catch (err) {
        throw friendlyPosError(err, 'delete staff');
      }
    },

    // Shared-device cashier login. Returns { id, name, role } — never the hash.
    async staffLogin(storeId, pin) {
      if (!(await posHasV4())) throw new Error('Staff PINs need migration 004 — ask a manager to apply it.');
      if (!/^\d{4,8}$/.test(String(pin ?? ''))) throw new Error('Enter the 4–8 digit PIN.');
      const pinHash = await sha256hex(pin);
      let rows;
      try {
        // Salted-KDF login (migration 069, phase 1): the server
        // bcrypt-verifies the PIN (and backfills legacy rows). The
        // credential we keep for punching stays the locally computed
        // SHA-256 — phase 1 leaves every punch RPC untouched. Without
        // the migration, the exact legacy path runs.
        rows = (await posHasPinKdf())
          ? check(
              await client.rpc('pos_staff_login2', {
                p_store_id: storeId,
                p_pin: String(pin),
              }),
              'Staff sign-in'
            )
          : check(
              await client.rpc('pos_staff_login', { p_store_id: storeId, p_pin_hash: pinHash }),
              'Staff sign-in'
            );
      } catch (err) {
        if (/too many PIN attempts/i.test(err.message)) throw new Error('PIN_THROTTLED');
        if (/invalid PIN|not a member|sign in/i.test(err.message)) throw new Error('Invalid PIN.');
        throw friendlyPosError(err, 'sign in staff');
      }
      const r = Array.isArray(rows) ? rows[0] : rows;
      if (!r) throw new Error('Invalid PIN.');
      // pinHash is returned so the terminal can punch in/out without asking
      // for the PIN again; every punch RPC re-verifies it server-side.
      return { id: r.id, name: r.name, role: r.role, pinHash };
    },

    /* ----- time clock (secure: all writes via PIN-verifying RPCs) ----- */
    // The currently open punch for a staff member (clocked in, not yet out).
    async getOpenPunch(storeId, staffId) {
      if (!(await posHasClock())) return null;
      let rows;
      try {
        rows = check(
          await client
            .from('pos_time_punches')
            .select('id, staff_id, punch_in, punch_out')
            .eq('store_id', storeId)
            .eq('staff_id', staffId)
            .is('punch_out', null)
            .order('punch_in', { ascending: false })
            .limit(1),
          'Checking clock status'
        );
      } catch (err) {
        throw friendlyPosError(err, 'check clock status');
      }
      const r = Array.isArray(rows) ? rows[0] : rows;
      return r ? { id: r.id, staffId: r.staff_id, punchIn: r.punch_in, punchOut: r.punch_out } : null;
    },

    // Punch in — the PIN hash is verified server-side by pos_clock_in, which
    // opens a shift for that staff member only. The partial unique index
    // makes double-punches race-safe.
    async clockIn(storeId, pinHash) {
      if (!(await posHasClock())) throw new Error('Time clock needs migration 007 — apply it in your Supabase SQL editor.');
      let rows;
      try {
        rows = check(
          await client.rpc('pos_clock_in', { p_store_id: storeId, p_pin_hash: pinHash }),
          'Punching in'
        );
      } catch (err) {
        if (/already punched in|invalid PIN|not a member|sign in/i.test(err.message)) throw new Error(mapClockError(err.message));
        throw friendlyPosError(err, 'punch in');
      }
      const r = Array.isArray(rows) ? rows[0] : rows;
      // Empty set means the PIN did not match (the RPC logs the failure for
      // throttling and returns no rows instead of raising, so the log row
      // is not rolled back).
      if (!r) throw new Error('Invalid PIN.');
      return { id: r.id, staffId: r.staff_id, punchIn: r.punch_in, punchOut: null };
    },

    async clockOut(storeId, pinHash) {
      if (!(await posHasClock())) throw new Error('Time clock needs migration 007 — apply it in your Supabase SQL editor.');
      let rows;
      try {
        rows = check(
          await client.rpc('pos_clock_out', { p_store_id: storeId, p_pin_hash: pinHash }),
          'Punching out'
        );
      } catch (err) {
        if (/not punched in|invalid PIN|not a member|sign in/i.test(err.message)) throw new Error(mapClockError(err.message));
        throw friendlyPosError(err, 'punch out');
      }
      const r = Array.isArray(rows) ? rows[0] : rows;
      // Empty set means the PIN did not match (see clockIn).
      if (!r) throw new Error('Invalid PIN.');
      return { id: r.id, staffId: r.staff_id, punchIn: r.punch_in, punchOut: r.punch_out };
    },

    // Owner/manager correction of a punch's times; the old values are
    // written to pos_punch_audits by the RPC.
    async correctPunch(storeId, punchId, { punchIn, punchOut }) {
      if (!(await posHasClock())) throw new Error('Time clock needs migration 007 — apply it in your Supabase SQL editor.');
      let rows;
      try {
        rows = check(
          await client.rpc('pos_punch_correct', {
            p_punch_id: punchId,
            p_punch_in: punchIn,
            p_punch_out: punchOut,
          }),
          'Correcting punch'
        );
      } catch (err) {
        // NUCLEAR FAILSAFE: map every known pos_punch_correct error to a
        // stable machine-readable code so the UI can localize it. Raw
        // English DB messages must never reach the user.
        const m = String(err?.message || '');
        const code =
          /pay period is locked/i.test(m) ? 'CORR_PERIOD_LOCKED' :
          /shift cannot exceed 24 hours/i.test(m) ? 'CORR_EXCEEDS_24H' :
          /punch out must be after punch in/i.test(m) ? 'CORR_OUT_BEFORE_IN' :
          /punch in cannot be in the future/i.test(m) ? 'CORR_IN_FUTURE' :
          /punch out cannot be in the future/i.test(m) ? 'CORR_OUT_FUTURE' :
          /punch not found/i.test(m) ? 'CORR_NOT_FOUND' :
          /managers only/i.test(m) ? 'CORR_MANAGERS_ONLY' :
          /sign in to correct/i.test(m) ? 'CORR_SIGNIN' : null;
        if (code) {
          const coded = new Error(code);
          coded.cause = err;
          throw coded;
        }
        throw friendlyPosError(err, 'correct the punch');
      }
      const r = Array.isArray(rows) ? rows[0] : rows;
      return r ? { id: r.id, staffId: r.staff_id, punchIn: r.punch_in, punchOut: r.punch_out } : null;
    },

    async deletePunch(storeId, punchId) {
      if (!(await posHasClock())) throw new Error('Time clock needs migration 007 — apply it in your Supabase SQL editor.');
      try {
        check(
          await client.rpc('pos_punch_delete', { p_punch_id: punchId }),
          'Deleting punch'
        );
      } catch (err) {
        if (/managers only|punch not found/i.test(err.message)) throw new Error(mapClockError(err.message));
        throw friendlyPosError(err, 'delete the punch');
      }
    },

    // Recent corrections/deletions for managers.
    async listPunchAudits(storeId, { limit = 50 } = {}) {
      if (!(await posHasClock())) return [];
      let rows;
      try {
        rows = check(
          await client
            .from('pos_punch_audits')
            .select('id, punch_id, action, edited_by, old_punch_in, old_punch_out, new_punch_in, new_punch_out, created_at')
            .eq('store_id', storeId)
            .order('created_at', { ascending: false })
            .limit(limit),
          'Loading punch audit log'
        );
      } catch {
        return [];
      }
      return (rows ?? []).map((r) => ({
        id: r.id,
        punchId: r.punch_id,
        action: r.action,
        oldPunchIn: r.old_punch_in,
        oldPunchOut: r.old_punch_out,
        newPunchIn: r.new_punch_in,
        newPunchOut: r.new_punch_out,
        createdAt: r.created_at,
      }));
    },

    // Punches in a window, newest first, with staff names. from/to are ISO strings.
    async listPunches(storeId, { from = null, to = null, limit = 500 } = {}) {
      if (!(await posHasClock())) return [];
      let q = client
        .from('pos_time_punches')
        .select('id, staff_id, punch_in, punch_out, pos_staff(name)')
        .eq('store_id', storeId)
        .order('punch_in', { ascending: false })
        .limit(limit);
      if (from) q = q.gte('punch_in', from);
      if (to) q = q.lt('punch_in', to);
      let rows;
      try {
        rows = check(await q, 'Loading time punches');
      } catch (err) {
        throw friendlyPosError(err, 'load time punches');
      }
      return (rows ?? []).map((r) => ({
        id: r.id,
        staffId: r.staff_id,
        staffName: r.pos_staff?.name || 'Former staff',
        punchIn: r.punch_in,
        punchOut: r.punch_out,
      }));
    },

    /* ----- punch HR: breaks, shifts, time off, pay periods, settings (031) ----- */
    // Start a paid/unpaid break. PIN-verified server-side by pos_break_start;
    // requires the staffer to be currently punched in.
    async startBreak(storeId, pinHash, type) {
      if (!(await posHasHR())) throw new Error('Breaks need migration 031 — apply it in your Supabase SQL editor.');
      const t = type === 'paid' ? 'paid' : 'unpaid';
      let rows;
      try {
        rows = check(
          await client.rpc('pos_break_start', { p_store_id: storeId, p_pin_hash: pinHash, p_type: t }),
          'Starting break'
        );
      } catch (err) {
        if (/invalid PIN/i.test(err.message)) throw new Error('Invalid PIN.');
        if (/Not punched in/i.test(err.message)) throw new Error('Not punched in.');
        if (/already open/i.test(err.message)) throw new Error('A break is already open.');
        throw friendlyPosError(err, 'start the break');
      }
      const r = Array.isArray(rows) ? rows[0] : rows;
      // Empty set means the PIN did not match (see clockIn).
      if (!r) throw new Error('Invalid PIN.');
      return { id: r.id, staffId: r.staff_id, punchId: r.punch_id, type: r.type, start: r.start, end: null };
    },

    // End the currently open break for the PIN holder.
    async endBreak(storeId, pinHash) {
      if (!(await posHasHR())) throw new Error('Breaks need migration 031 — apply it in your Supabase SQL editor.');
      let rows;
      try {
        rows = check(
          await client.rpc('pos_break_end', { p_store_id: storeId, p_pin_hash: pinHash }),
          'Ending break'
        );
      } catch (err) {
        if (/invalid PIN/i.test(err.message)) throw new Error('Invalid PIN.');
        if (/no open break/i.test(err.message)) throw new Error('No open break.');
        throw friendlyPosError(err, 'end the break');
      }
      const r = Array.isArray(rows) ? rows[0] : rows;
      // Empty set means the PIN did not match (see clockIn).
      if (!r) throw new Error('Invalid PIN.');
      return { id: r.id, staffId: r.staff_id, punchId: r.punch_id, type: r.type, start: r.start, end: r.end };
    },

    // The currently open break for a staff member (null when none).
    async getOpenBreak(storeId, staffId) {
      if (!(await posHasHR())) return null;
      let rows;
      try {
        rows = check(
          await client
            .from('pos_breaks')
            .select('id, staff_id, punch_id, type, start')
            .eq('store_id', storeId)
            .eq('staff_id', staffId)
            .is('end', null)
            .order('start', { ascending: false })
            .limit(1),
          'Checking break status'
        );
      } catch (err) {
        throw friendlyPosError(err, 'check break status');
      }
      const r = Array.isArray(rows) ? rows[0] : rows;
      return r ? { id: r.id, staffId: r.staff_id, punchId: r.punch_id, type: r.type, start: r.start, end: null } : null;
    },

    // Break segments in a time range (for payroll math: unpaid breaks are
    // subtracted from punch time).
    async listBreaks(storeId, { from = null, to = null } = {}) {
      if (!(await posHasHR())) return [];
      let q = client
        .from('pos_breaks')
        .select('id, staff_id, punch_id, type, start, end')
        .eq('store_id', storeId)
        .order('start', { ascending: true });
      if (from) q = q.gte('start', from);
      if (to) q = q.lt('start', to);
      let rows;
      try {
        rows = check(await q, 'Loading breaks');
      } catch (err) {
        throw friendlyPosError(err, 'load breaks');
      }
      return (rows ?? []).map((r) => ({
        id: r.id,
        staffId: r.staff_id,
        punchId: r.punch_id,
        type: r.type,
        start: r.start,
        end: r.end,
      }));
    },

    // Scheduled shifts for a date range (inclusive YYYY-MM-DD strings).
    async listShifts(storeId, { from = null, to = null } = {}) {
      if (!(await posHasHR())) return [];
      let q = client
        .from('pos_shifts')
        .select('id, staff_id, ymd, start, end, note, pos_staff(name)')
        .eq('store_id', storeId)
        .order('ymd', { ascending: true })
        .order('start', { ascending: true });
      if (from) q = q.gte('ymd', from);
      if (to) q = q.lte('ymd', to);
      let rows;
      try {
        rows = check(await q, 'Loading schedule');
      } catch (err) {
        throw friendlyPosError(err, 'load the schedule');
      }
      return (rows ?? []).map((r) => ({
        id: r.id,
        staffId: r.staff_id,
        staffName: r.pos_staff?.name || 'Former staff',
        ymd: r.ymd,
        start: r.start,
        end: r.end,
        note: r.note || '',
      }));
    },

    // Create or update a scheduled shift (owner/manager only).
    async saveShift(storeId, { id = null, staffId, ymd, start, end, note = '' }) {
      if (!(await posHasHR())) throw new Error('Scheduling needs migration 031 — apply it in your Supabase SQL editor.');
      await posRequireManager(storeId);
      if (!staffId || !ymd || !start || !end) throw new Error('Shift needs a staff member, date, start and end.');
      const startStr = String(start).slice(0, 5);
      const endStr = String(end).slice(0, 5);
      // NUCLEAR FAILSAFE: overnight shifts allowed — end <= start means "next day"
      // (e.g. 22:00 -> 06:00). Only a zero-length shift is rejected. Matches the
      // DB constraint from migration 048: CHECK ("end" <> start).
      if (endStr === startStr) throw new Error('Shift end time must differ from start time.');
      const clean = {
        store_id: storeId,
        staff_id: staffId,
        ymd,
        start: startStr,
        end: endStr,
        note: String(note ?? ''),
      };
      let rows;
      try {
        if (id) {
          rows = check(
            await client.from('pos_shifts').update(clean).eq('id', id).eq('store_id', storeId).select('id'),
            'Saving shift'
          );
        } else {
          rows = check(
            await client.from('pos_shifts').insert(clean).select('id'),
            'Saving shift'
          );
        }
      } catch (err) {
        throw friendlyPosError(err, 'save the shift');
      }
      const r = Array.isArray(rows) ? rows[0] : rows;
      return r ? { id: r.id } : null;
    },

    // Delete a scheduled shift (owner/manager only).
    async deleteShift(storeId, id) {
      if (!(await posHasHR())) throw new Error('Scheduling needs migration 031 — apply it in your Supabase SQL editor.');
      await posRequireManager(storeId);
      try {
        check(await client.from('pos_shifts').delete().eq('id', id).eq('store_id', storeId), 'Deleting shift');
      } catch (err) {
        throw friendlyPosError(err, 'delete the shift');
      }
      return true;
    },

    // Per-store punch terminal settings; defaults when no row saved yet.
    async getPunchSettings(storeId) {
      const defaults = { weekStart: 'monday', paidBreakMin: 15, unpaidBreakMin: 30, graceMin: 15 };
      if (!(await posHasHR())) return { ...defaults };
      let rows;
      try {
        rows = check(
          await client.from('pos_punch_settings').select('*').eq('store_id', storeId).limit(1),
          'Loading punch settings'
        );
      } catch (err) {
        throw friendlyPosError(err, 'load punch settings');
      }
      const r = Array.isArray(rows) ? rows[0] : rows;
      if (!r) return { ...defaults };
      return {
        weekStart: r.week_start === 'sunday' ? 'sunday' : 'monday',
        paidBreakMin: r.paid_break_min ?? 15,
        unpaidBreakMin: r.unpaid_break_min ?? 30,
        graceMin: r.grace_min ?? 15,
      };
    },

    // Save per-store punch terminal settings (owner/manager only).
    async savePunchSettings(storeId, form) {
      if (!(await posHasHR())) throw new Error('Punch settings need migration 031 — apply it in your Supabase SQL editor.');
      await posRequireManager(storeId);
      // NUCLEAR FAILSAFE: reject invalid values instead of silently clamping.
      // Valid range: 0–480 minutes. The UI validates first; this is the
      // server-side backstop against direct API abuse.
      const num = (v, name) => {
        const n = Number(v);
        if (!Number.isFinite(n) || n < 0 || n > 480) throw new Error(`Invalid punch setting: ${name} must be 0–480 minutes.`);
        return Math.round(n);
      };
      const clean = {
        store_id: storeId,
        week_start: form.weekStart === 'sunday' ? 'sunday' : 'monday',
        paid_break_min: num(form.paidBreakMin, 'paid_break_min'),
        unpaid_break_min: num(form.unpaidBreakMin, 'unpaid_break_min'),
        grace_min: num(form.graceMin, 'grace_min'),
        updated_at: new Date().toISOString(),
      };
      let rows;
      try {
        rows = check(
          await client.from('pos_punch_settings').upsert(clean, { onConflict: 'store_id' }).select('*'),
          'Saving punch settings'
        );
      } catch (err) {
        throw friendlyPosError(err, 'save punch settings');
      }
      const r = Array.isArray(rows) ? rows[0] : rows;
      return {
        weekStart: r.week_start === 'sunday' ? 'sunday' : 'monday',
        paidBreakMin: r.paid_break_min ?? 15,
        unpaidBreakMin: r.unpaid_break_min ?? 30,
        graceMin: r.grace_min ?? 15,
      };
    },

    // Time-off requests, newest first, with staff names.
    async listTimeOff(storeId) {
      if (!(await posHasHR())) return [];
      let rows;
      try {
        rows = check(
          await client
            .from('pos_time_off')
            .select('id, staff_id, kind, from_date, to_date, reason, status, decided_by, decided_at, created_at, pos_staff(name)')
            .eq('store_id', storeId)
            .order('created_at', { ascending: false }),
          'Loading time-off requests'
        );
      } catch (err) {
        throw friendlyPosError(err, 'load time-off requests');
      }
      return (rows ?? []).map((r) => ({
        id: r.id,
        staffId: r.staff_id,
        staffName: r.pos_staff?.name || 'Former staff',
        kind: r.kind,
        from: r.from_date,
        to: r.to_date,
        reason: r.reason || '',
        status: r.status,
        decidedBy: r.decided_by || null,
        decidedAt: r.decided_at || null,
        createdAt: r.created_at,
      }));
    },

    // File a time-off request as the PIN holder (PIN verified server-side).
    async submitTimeOff(storeId, pinHash, { from, to, kind, reason = '' }) {
      if (!(await posHasHR())) throw new Error('Time-off requests need migration 031 — apply it in your Supabase SQL editor.');
      const k = ['vacation', 'sick', 'unpaid'].includes(kind) ? kind : 'vacation';
      let rows;
      try {
        rows = check(
          await client.rpc('pos_timeoff_submit', {
            p_store_id: storeId,
            p_pin_hash: pinHash,
            p_kind: k,
            p_from: from,
            p_to: to,
            p_reason: String(reason ?? ''),
          }),
          'Requesting time off'
        );
      } catch (err) {
        if (/invalid PIN/i.test(err.message)) throw new Error('Invalid PIN.');
        if (/before the start/i.test(err.message)) throw new Error('The end date is before the start date.');
        throw friendlyPosError(err, 'request time off');
      }
      const r = Array.isArray(rows) ? rows[0] : rows;
      // Empty set means the PIN did not match (see clockIn) — never treat
      // it as a filed request.
      if (!r) throw new Error('Invalid PIN.');
      return { id: r.id };
    },

    // Approve or deny a time-off request (owner/manager only).
    async decideTimeOff(storeId, id, { approved, decidedBy = '' }) {
      if (!(await posHasHR())) throw new Error('Time-off requests need migration 031 — apply it in your Supabase SQL editor.');
      await posRequireManager(storeId);
      try {
        check(
          await client
            .from('pos_time_off')
            .update({
              status: approved ? 'approved' : 'denied',
              decided_by: String(decidedBy ?? ''),
              decided_at: new Date().toISOString(),
            })
            .eq('id', id)
            .eq('store_id', storeId),
          'Deciding time-off request'
        );
      } catch (err) {
        throw friendlyPosError(err, 'decide the request');
      }
      return true;
    },

    // Pay periods, newest first.
    async listPayPeriods(storeId) {
      if (!(await posHasHR())) return [];
      let rows;
      try {
        rows = check(
          await client
            .from('pos_pay_periods')
            .select('id, from_date, to_date, status, approved_by, approved_at, created_at')
            .eq('store_id', storeId)
            .order('from_date', { ascending: false }),
          'Loading pay periods'
        );
      } catch (err) {
        throw friendlyPosError(err, 'load pay periods');
      }
      return (rows ?? []).map((r) => ({
        id: r.id,
        from: r.from_date,
        to: r.to_date,
        status: r.status,
        approvedBy: r.approved_by || null,
        approvedAt: r.approved_at || null,
        createdAt: r.created_at,
      }));
    },

    // Approve (lock) a pay period (owner/manager only). Re-approving the same
    // range updates the existing row instead of duplicating it.
    async approvePeriod(storeId, { from, to, approvedBy = '' }) {
      if (!(await posHasHR())) throw new Error('Pay periods need migration 031 — apply it in your Supabase SQL editor.');
      await posRequireManager(storeId);
      if (!from || !to) throw new Error('Pay period needs a start and end date.');
      const now = new Date().toISOString();
      let rows;
      try {
        const existing = check(
          await client
            .from('pos_pay_periods')
            .select('id')
            .eq('store_id', storeId)
            .eq('from_date', from)
            .eq('to_date', to)
            .limit(1),
          'Checking pay period'
        );
        const ex = Array.isArray(existing) ? existing[0] : existing;
        if (ex) {
          rows = check(
            await client
              .from('pos_pay_periods')
              .update({ status: 'approved', approved_by: String(approvedBy ?? ''), approved_at: now })
              .eq('id', ex.id)
              .select('id'),
            'Approving pay period'
          );
        } else {
          rows = check(
            await client
              .from('pos_pay_periods')
              .insert({ store_id: storeId, from_date: from, to_date: to, status: 'approved', approved_by: String(approvedBy ?? ''), approved_at: now })
              .select('id'),
            'Approving pay period'
          );
        }
      } catch (err) {
        throw friendlyPosError(err, 'approve the pay period');
      }
      const r = Array.isArray(rows) ? rows[0] : rows;
      return r ? { id: r.id } : null;
    },

    // Unlock (re-open) a pay period (owner/manager only).
    async unlockPeriod(storeId, id) {
      if (!(await posHasHR())) throw new Error('Pay periods need migration 031 — apply it in your Supabase SQL editor.');
      await posRequireManager(storeId);
      try {
        check(
          await client.from('pos_pay_periods').delete().eq('id', id).eq('store_id', storeId),
          'Unlocking pay period'
        );
      } catch (err) {
        throw friendlyPosError(err, 'unlock the pay period');
      }
      return true;
    },

    /* ----- appointments (tied to the POS customer database) ----- */
    async listAppointments(storeId, { from = null, to = null, limit = 500 } = {}) {
      if (!(await posHasAppts())) return [];
      let q = client
        .from('pos_appointments')
        .select(
          'id, customer_id, staff_id, title, notes, starts_at, ends_at, status, created_at,' +
            ' pos_customers(name, phone), pos_staff(name)'
        )
        .eq('store_id', storeId)
        .order('starts_at', { ascending: true })
        .limit(limit);
      if (from) q = q.gte('starts_at', from);
      if (to) q = q.lt('starts_at', to);
      let rows;
      try {
        rows = check(await q, 'Loading appointments');
      } catch (err) {
        throw friendlyPosError(err, 'load appointments');
      }
      return (rows ?? []).map(mapAppointment);
    },

    async saveAppointment(storeId, appt) {
      if (!(await posHasAppts()))
        throw new Error('Appointments need migration 009 — apply it in your Supabase SQL editor.');
      const clean = {
        store_id: storeId,
        customer_id: appt.customerId || null,
        staff_id: appt.staffId || null,
        title: String(appt.title ?? '').trim().slice(0, 120),
        notes: String(appt.notes ?? '').trim() || null,
        starts_at: appt.startsAt,
        ends_at: appt.endsAt,
        status: ['scheduled', 'confirmed', 'completed', 'cancelled', 'no_show'].includes(appt.status)
          ? appt.status
          : 'scheduled',
        updated_at: new Date().toISOString(),
      };
      if (!clean.title) throw new Error('Give the appointment a title.');
      if (!clean.starts_at || !clean.ends_at || new Date(clean.ends_at) <= new Date(clean.starts_at)) {
        throw new Error('Pick a valid start and end time.');
      }
      const returning =
        'id, customer_id, staff_id, title, notes, starts_at, ends_at, status, created_at,' +
        ' pos_customers(name, phone), pos_staff(name)';
      let row;
      try {
        if (appt.id) {
          row = check(
            await client
              .from('pos_appointments')
              .update(clean)
              .eq('id', appt.id)
              .eq('store_id', storeId)
              .select(returning)
              .single(),
            'Saving appointment'
          );
        } else {
          row = check(
            await client.from('pos_appointments').insert(clean).select(returning).single(),
            'Booking appointment'
          );
        }
      } catch (err) {
        throw friendlyPosError(err, 'save the appointment');
      }
      return mapAppointment(row);
    },

    async deleteAppointment(storeId, id) {
      if (!(await posHasAppts()))
        throw new Error('Appointments need migration 009 — apply it in your Supabase SQL editor.');
      try {
        check(
          await client.from('pos_appointments').delete().eq('id', id).eq('store_id', storeId),
          'Deleting appointment'
        );
      } catch (err) {
        throw friendlyPosError(err, 'delete the appointment');
      }
    },

    /* ----- cash drawer ----- */
    async listDrawerShifts(storeId, { limit = 50 } = {}) {
      if (!(await posHasV4())) return [];
      const rows = check(
        await client
          .from('pos_drawer_shifts')
          .select('*')
          .eq('store_id', storeId)
          .order('opened_at', { ascending: false })
          .limit(limit),
        'Loading drawer shifts'
      );
      return rows.map((r) => ({
        id: r.id,
        openedByName: r.opened_by_name ?? null,
        openedAt: r.opened_at,
        openAmountCents: Number(r.open_amount_cents) || 0,
        closedAt: r.closed_at ?? null,
        closeAmountCents: r.close_amount_cents == null ? null : Number(r.close_amount_cents),
        expectedCents: r.expected_cents == null ? null : Number(r.expected_cents),
        note: r.note ?? '',
      }));
    },

    async openDrawer(storeId, { amountCents = 0, byName = '' } = {}) {
      if (!(await posHasV4())) throw new Error('Drawer counts need migration 004 — ask a manager to apply it.');
      const uid = requireUid();
      // M1: Prevent concurrent open shifts — check for an existing open shift first.
      const { data: existingOpen } = await client
        .from('pos_drawer_shifts')
        .select('id')
        .eq('store_id', storeId)
        .is('closed_at', null)
        .limit(1);
      if (existingOpen && existingOpen.length > 0) {
        throw new Error('A drawer shift is already open. Close it before opening a new one.');
      }
      const row = check(
        await client
          .from('pos_drawer_shifts')
          .insert({
            store_id: storeId,
            opened_by: uid,
            opened_by_name: String(byName ?? '').slice(0, 80) || null,
            open_amount_cents: Math.max(0, Math.round(Number(amountCents) || 0)),
          })
          .select('*')
          .single(),
        'Opening drawer'
      );
      return {
        id: row.id, openedByName: row.opened_by_name ?? null, openedAt: row.opened_at,
        openAmountCents: Number(row.open_amount_cents) || 0, closedAt: null,
        closeAmountCents: null, expectedCents: null, note: '',
      };
    },

    async closeDrawer(storeId, shiftId, { amountCents = 0, expectedCents = null, note = '', byName = '' } = {}) {
      if (!(await posHasV4())) throw new Error('Drawer counts need migration 004 — ask a manager to apply it.');
      const uid = requireUid();
      try {
        // M2: Guard against re-closing an already-closed shift.
        const res = await client
          .from('pos_drawer_shifts')
          .update({
            closed_at: new Date().toISOString(),
            closed_by: uid,
            close_amount_cents: Math.max(0, Math.round(Number(amountCents) || 0)),
            expected_cents: expectedCents == null ? null : Math.round(Number(expectedCents) || 0),
            note: String(note ?? '').slice(0, 200) || null,
          })
          .eq('id', shiftId)
          .eq('store_id', storeId)
          .is('closed_at', null)
          .select('id');
        check(res, 'Closing drawer');
        if (!res.data || res.data.length === 0) {
          throw new Error('This drawer shift is already closed.');
        }
      } catch (err) {
        throw friendlyPosError(err, 'close the drawer');
      }
    },

    /* ---------- account backup: whole-store export / merge import --------- */
    // exportStore dumps one store as raw DB rows for the account backup
    // file. Staff rows include PIN hashes — readable only by owner/manager
    // per RLS, so a cashier's export simply omits what they cannot see.
    // Per-table failures are recorded on the dump, never fatal.
    async exportStore(storeId) {
      const dump = { storeId, exportedAt: new Date().toISOString(), store: null, tables: {} };
      dump.store = check(
        await client.from('pos_stores').select('*').eq('id', storeId).single(),
        'Exporting store'
      );
      const tables = [
        'pos_products', 'pos_sales', 'pos_customers', 'pos_staff',
        'pos_time_punches', 'pos_punch_audits', 'pos_appointments', 'pos_drawer_shifts',
        'pos_orgs', 'pos_community_hours', 'pos_gift_cards', 'pos_gift_card_events',
        // Refund history (migration 034) is business data too: without
        // these rows a restored shop's books no longer reconcile.
        'pos_refunds',
        // Time-clock HR (migration 031): scheduled shifts, time off, pay
        // periods, punch settings, break segments.
        'pos_shifts', 'pos_time_off', 'pos_pay_periods', 'pos_punch_settings', 'pos_breaks',
        // The shop's public storefront page (migration 063).
        'storefront_profiles',
        'bq_items', 'bq_donations', 'bq_donation_items', 'bq_fairs', 'bq_fair_sales', 'bq_special_orders',
        // Customer online orders (migration 071): without these, a restored
        // shop loses its entire online order history.
        'online_orders',
        // M14: Shop memberships and license state — without these, restored
        // shops lose team members and re-lock (trial/paid state gone).
        'pos_store_members', 'shop_licenses',
      ];
      for (const t of tables) {
        try {
          dump.tables[t] = check(
            await client.from(t).select('*').eq('store_id', storeId).limit(10000),
            `Exporting ${t}`
          );
        } catch (err) {
          dump.tables[t] = { __exportError: err?.message || String(err) };
        }
      }
      return dump;
    },

    // importStore restores a dump produced by exportStore. It is strictly
    // merge-only: the store is created only if missing (the importer becomes
    // owner via the handle_new_pos_store trigger), rows already present by
    // ID are skipped, and nothing is ever deleted or overwritten. Punch
    // history goes through the manager-only pos_punch_history_import RPC
    // (migration 010) because punches have no direct-write RLS policy.
    async importStore(dump) {
      const uid = requireUid();
      const report = { storeId: null, store: 'existing', inserted: {}, skipped: {}, errors: {} };
      const bump = (t, n, key) => {
        if (n) report[key][t] = (report[key][t] || 0) + n;
      };

      const rawStore = dump?.store ?? {};
      const rawStoreId = String(rawStore.id ?? dump?.storeId ?? '');
      const storeId = UUID_RE.test(rawStoreId) ? rawStoreId : freshUuid();
      report.storeId = storeId;

      // 1. Ensure the store row exists.
      const { data: existingStore } = await client
        .from('pos_stores')
        .select('id')
        .eq('id', storeId)
        .maybeSingle();
      if (!existingStore) {
        const v4 = await posHasV4();
        const row = {
          id: storeId,
          name: String(rawStore.name ?? 'Restored store').slice(0, 80) || 'Restored store',
          currency: String(rawStore.currency ?? '$').slice(0, 8) || '$',
          tax_rate: Math.min(100, Math.max(0, Number(rawStore.tax_rate ?? rawStore.taxRate) || 0)),
          created_by: uid,
        };
        if (v4 && rawStore.tax_rates !== undefined) row.tax_rates = rawStore.tax_rates;
        const { error } = await client.from('pos_stores').insert(row);
        if (error) throw new Error(`Could not restore the store: ${error.message}`);
        report.store = 'created';
      }

      // 2. Sanitize rows: valid UUIDs, known columns only, user references
      // re-attributed to the importer. Invalid IDs get fresh UUIDs and are
      // remembered so foreign keys can be rewritten.
      const remap = new Map();
      const tables = dump?.tables ?? {};
      const cleanRows = {};
      for (const [t, cols] of Object.entries(POS_IMPORT_COLUMNS)) {
        const raw = tables[t];
        if (!Array.isArray(raw)) continue;
        cleanRows[t] = [];
        for (const r of raw) {
          if (!r || typeof r !== 'object' || Array.isArray(r)) continue;
          const s = snakeRow(r);
          const oldId = String(s.id ?? '');
          const id = UUID_RE.test(oldId) ? oldId : freshUuid();
          if (oldId && id !== oldId) remap.set(oldId, id);
          const picked = { id, store_id: storeId };
          for (const c of cols) {
            if (c === 'id' || c === 'store_id') continue;
            if (s[c] !== undefined) picked[c] = s[c];
          }
          for (const u of POS_IMPORT_USER_COLS) {
            if (picked[u] === undefined) continue;
            if (picked[u] === uid) continue;
            // owner_id is NOT NULL on catalogue tables: re-attribute the
            // catalogue to the importer instead of nulling (which would
            // violate the constraint and drop the row). All other user
            // columns are nullable, so nulling is safe for them.
            picked[u] = u === 'owner_id' ? uid : null;
          }
          cleanRows[t].push(picked);
        }
      }
      // Build ID sets for FK validation: a reference is only kept if its
      // target actually exists in this backup batch. A syntactically valid
      // UUID pointing at a record that isn't in the backup (deleted, or
      // from a partial backup) would violate the FK constraint on insert.
      const idSet = (t) => new Set((cleanRows[t] ?? []).map((r) => r.id));
      const validCustomers = idSet('pos_customers');
      const validStaff = idSet('pos_staff');
      const validOrgs = idSet('pos_orgs');
      const validFairs = idSet('bq_fairs');
      const validItems = idSet('bq_items');
      const fixRef = (v, validIds) => {
        if (v == null || v === '') return null;
        const s = String(v);
        const mapped = remap.has(s) ? remap.get(s) : (UUID_RE.test(s) ? s : null);
        if (mapped == null) return null;
        // If a valid-ID set was provided, the reference must point at a
        // record that's actually in this backup, else null it.
        if (validIds && !validIds.has(mapped)) return null;
        return mapped;
      };
      for (const a of cleanRows.pos_appointments ?? []) {
        a.customer_id = fixRef(a.customer_id, validCustomers);
        a.staff_id = fixRef(a.staff_id, validStaff);
      }
      for (const h of cleanRows.pos_community_hours ?? []) {
        h.staff_id = fixRef(h.staff_id, validStaff);
        h.org_id = fixRef(h.org_id, validOrgs);
      }
      // Sales keep their org snapshot columns (name/type/exempt stay even
      // if the org is gone), but org_id must point at a real org in this
      // store: remap it through this batch's ID map, else null it so the
      // row can't reference another store's organization.
      for (const s of cleanRows.pos_sales ?? []) {
        s.org_id = fixRef(s.org_id, validOrgs);
      }
      for (const s of cleanRows.bq_fair_sales ?? []) {
        s.fair_id = fixRef(s.fair_id, validFairs);
        s.item_id = fixRef(s.item_id, validItems);
      }

      // 3. Merge-insert each table: skip IDs already present, bulk insert,
      // fall back to row-by-row so one bad row can't sink the table.
      const mergeTable = async (t) => {
        const rows = cleanRows[t] ?? [];
        if (!rows.length) return;
        let have = new Set();
        try {
          const { data } = await client.from(t).select('id').eq('store_id', storeId);
          have = new Set((data ?? []).map((r) => r.id));
        } catch {
          /* table may not exist pre-migration — surfaces on insert */
        }
        const missing = rows.filter((r) => !have.has(r.id));
        bump(t, rows.length - missing.length, 'skipped');
        if (!missing.length) return;
        const { error } = await client.from(t).insert(missing);
        if (!error) {
          bump(t, missing.length, 'inserted');
          return;
        }
        let ok = 0;
        const errs = [];
        for (const r of missing) {
          const { error: e } = await client.from(t).insert(r);
          if (e) errs.push(e.message);
          else ok++;
        }
        bump(t, ok, 'inserted');
        bump(t, missing.length - ok, 'skipped');
        if (errs.length) {
          report.errors[t] = errs[0] + (errs.length > 1 ? ` (+${errs.length - 1} more)` : '');
        }
      };
      // Gift cards have no direct-write RLS by design — they restore through
      // the manager-only pos_giftcard_import RPC (step 5), after sales so
      // sale links resolve.
      const RPC_ONLY_TABLES = new Set(['pos_gift_cards', 'pos_gift_card_events']);
      for (const t of Object.keys(POS_IMPORT_COLUMNS)) {
        if (RPC_ONLY_TABLES.has(t)) continue;
        try {
          await mergeTable(t);
        } catch (err) {
          report.errors[t] = err?.message || String(err);
        }
      }

      // 3b. Donation-item links (bq_donation_items): junction table with no
      // id/store_id. Remap both FKs; skip links whose donation or item
      // didn't survive the import (dangling links are meaningless).
      const rawLinks = Array.isArray(tables.bq_donation_items) ? tables.bq_donation_items : [];
      if (rawLinks.length) {
        try {
          const [donations, items] = await Promise.all([
            client.from('bq_donations').select('id').eq('store_id', storeId),
            client.from('bq_items').select('id').eq('store_id', storeId),
          ]);
          const donationIds = new Set((donations.data ?? []).map((r) => r.id));
          const itemIds = new Set((items.data ?? []).map((r) => r.id));
          // Also accept IDs from this import batch (not yet committed
          // above if the merge ran row-by-row — re-check via cleanRows).
          for (const r of cleanRows.bq_donations ?? []) donationIds.add(r.id);
          for (const r of cleanRows.bq_items ?? []) itemIds.add(r.id);
          const links = [];
          const seen = new Set();
          for (const r of rawLinks) {
            if (!r || typeof r !== 'object') continue;
            const s = snakeRow(r);
            const did = fixRef(s.donation_id ?? s.donationId);
            const iid = fixRef(s.item_id ?? s.itemId);
            if (!did || !iid || !donationIds.has(did) || !itemIds.has(iid)) continue;
            const key = `${did}|${iid}`;
            if (seen.has(key)) continue;
            seen.add(key);
            links.push({ donation_id: did, item_id: iid });
          }
          if (links.length) {
            // Skip links already present.
            const { data: existing } = await client
              .from('bq_donation_items')
              .select('donation_id, item_id')
              .in('donation_id', [...new Set(links.map((l) => l.donation_id))]);
            const haveLinks = new Set((existing ?? []).map((r) => `${r.donation_id}|${r.item_id}`));
            const missing = links.filter((l) => !haveLinks.has(`${l.donation_id}|${l.item_id}`));
            bump('bq_donation_items', links.length - missing.length, 'skipped');
            if (missing.length) {
              const { error } = await client.from('bq_donation_items').insert(missing);
              if (error) throw error;
              bump('bq_donation_items', missing.length, 'inserted');
            }
          }
        } catch (err) {
          report.errors.bq_donation_items = err?.message || String(err);
        }
      }

      // 4. Punch history via the manager-only RPC (migration 010).
      const rawPunches = Array.isArray(tables.pos_time_punches) ? tables.pos_time_punches : [];
      const rawAudits = Array.isArray(tables.pos_punch_audits) ? tables.pos_punch_audits : [];
      if (rawPunches.length || rawAudits.length) {
        if (!(await posHasBackupImport())) {
          report.errors.punches =
            'Time-clock history needs migration 010 applied — ask a manager to apply it.';
        } else {
          let staffIds = new Set();
          try {
            const { data } = await client.from('pos_staff').select('id').eq('store_id', storeId);
            staffIds = new Set((data ?? []).map((r) => r.id));
          } catch {
            /* non-fatal */
          }
          for (const r of cleanRows.pos_staff ?? []) staffIds.add(r.id);
          const punches = [];
          for (const r of rawPunches) {
            if (!r || typeof r !== 'object') continue;
            const s = snakeRow(r);
            if (!s.punch_in && !s.punchIn) continue;
            let staffId = fixRef(s.staff_id ?? s.staffId);
            if (!staffId || !staffIds.has(staffId)) staffId = null; // keep the punch, drop the dangling link
            punches.push({
              id: UUID_RE.test(String(s.id ?? '')) ? String(s.id) : freshUuid(),
              staff_id: staffId,
              punch_in: s.punch_in ?? s.punchIn,
              punch_out: s.punch_out ?? s.punchOut ?? null,
              created_at: s.created_at ?? s.createdAt ?? null,
            });
          }
          const audits = [];
          for (const r of rawAudits) {
            if (!r || typeof r !== 'object') continue;
            const s = snakeRow(r);
            audits.push({
              id: UUID_RE.test(String(s.id ?? '')) ? String(s.id) : freshUuid(),
              punch_id: fixRef(s.punch_id ?? s.punchId),
              action: ['correct', 'delete'].includes(s.action) ? s.action : 'correct',
              old_punch_in: s.old_punch_in ?? s.oldPunchIn ?? null,
              old_punch_out: s.old_punch_out ?? s.oldPunchOut ?? null,
              new_punch_in: s.new_punch_in ?? s.newPunchIn ?? null,
              new_punch_out: s.new_punch_out ?? s.newPunchOut ?? null,
              created_at: s.created_at ?? s.createdAt ?? null,
            });
          }
          try {
            const { data, error } = await client.rpc('pos_punch_history_import', {
              p_store_id: storeId,
              p_punches: punches,
              p_audits: audits,
            });
            if (error) throw error;
            bump('pos_time_punches', data?.punches ?? 0, 'inserted');
            bump('pos_punch_audits', data?.audits ?? 0, 'inserted');
          } catch (err) {
            report.errors.punches = err?.message || String(err);
          }
        }
      }

      // 5. Gift cards via the manager-only RPC (migration 028): no
      // direct-write RLS exists by design. Runs after sales so the sale-id
      // remap is complete.
      const giftCards = cleanRows.pos_gift_cards ?? [];
      const giftEvents = cleanRows.pos_gift_card_events ?? [];
      if (giftCards.length || giftEvents.length) {
        if (!(await posHasGiftCards())) {
          report.errors.giftCards =
            'Gift cards need migration 028 applied — ask a manager to apply it.';
        } else {
          try {
            const saleRemap = {};
            for (const [k, v] of remap) saleRemap[k] = v;
            const { data, error } = await client.rpc('pos_giftcard_import', {
              p_store_id: storeId,
              p_cards: giftCards,
              p_events: giftEvents,
              p_sale_remap: saleRemap,
            });
            if (error) throw error;
            bump('pos_gift_cards', data?.cards_inserted ?? 0, 'inserted');
            bump('pos_gift_cards', data?.cards_skipped ?? 0, 'skipped');
            bump('pos_gift_card_events', data?.events_inserted ?? 0, 'inserted');
            bump('pos_gift_card_events', data?.events_skipped ?? 0, 'skipped');
          } catch (err) {
            report.errors.giftCards = err?.message || String(err);
          }
        }
      }

      // 6. Refund history via the master/manager RPC (migration 072):
      // pos_refunds has no direct-write RLS by design, and replaying
      // refunds through pos_refund_sale() would re-execute them (new
      // gift cards, wrong restock). Runs after sales AND gift cards so
      // both references resolve. Rows are the BACKUP's raw rows (not the
      // generic sanitizer's output — the table is not in
      // POS_IMPORT_COLUMNS); the RPC validates sale/card existence itself.
      const rawRefunds = Array.isArray(tables.pos_refunds) ? tables.pos_refunds : [];
      if (rawRefunds.length) {
        if (!(await posHasRefundHistoryImport())) {
          report.errors.refunds =
            'Refund records are in this backup but could not be put back yet: the shop copy needs the latest update (refund restore). Everything else restored normally. / ' +
            'Les remboursements sont dans la sauvegarde mais ne peuvent pas encore être remis : cette copie du magasin a besoin de la dernière mise à jour. Tout le reste a été restauré normalement.';
        } else {
          try {
            const { data, error } = await client.rpc('pos_refund_history_import', {
              p_store_id: storeId,
              p_refunds: rawRefunds.map((r) => snakeRow(r)),
            });
            if (error) throw error;
            bump('pos_refunds', data?.inserted ?? 0, 'inserted');
            bump('pos_refunds', data?.skipped ?? 0, 'skipped');
          } catch (err) {
            report.errors.refunds = err?.message || String(err);
          }
        }
      }

      // 7. Break history via the master/manager RPC (migration 072):
      // pos_breaks writes are PIN-verified RPCs in live use, so history
      // restore has its own path. Runs after staff AND punches.
      const rawBreaks = Array.isArray(tables.pos_breaks) ? tables.pos_breaks : [];
      if (rawBreaks.length) {
        if (!(await posHasBreakHistoryImport())) {
          report.errors.breaks =
            'Time-clock break records are in this backup but could not be put back yet: the shop copy needs the latest update (break restore). Everything else restored normally. / ' +
            'Les pauses de l’horodateur sont dans la sauvegarde mais ne peuvent pas encore être remises : cette copie du magasin a besoin de la dernière mise à jour. Tout le reste a été restauré normalement.';
        } else {
          try {
            const { data, error } = await client.rpc('pos_break_history_import', {
              p_store_id: storeId,
              p_breaks: rawBreaks.map((r) => snakeRow(r)),
            });
            if (error) throw error;
            bump('pos_breaks', data?.inserted ?? 0, 'inserted');
            bump('pos_breaks', data?.skipped ?? 0, 'skipped');
          } catch (err) {
            report.errors.breaks = err?.message || String(err);
          }
        }
      }

      // 8. Punch settings (migration 031): one row per store, PK is
      // store_id (no id column) — upsert by store_id through RLS.
      const punchSettings = Array.isArray(tables.pos_punch_settings)
        ? tables.pos_punch_settings[0]
        : null;
      if (punchSettings && typeof punchSettings === 'object') {
        try {
          const s = snakeRow(punchSettings);
          const row = { store_id: storeId };
          for (const c of ['week_start', 'paid_break_min', 'unpaid_break_min', 'grace_min']) {
            if (s[c] !== undefined) row[c] = s[c];
          }
          const { error } = await client
            .from('pos_punch_settings')
            .upsert(row, { onConflict: 'store_id' });
          if (error) throw error;
          bump('pos_punch_settings', 1, 'inserted');
        } catch (err) {
          report.errors.punchSettings = err?.message || String(err);
        }
      }

      // 9. Storefront profile (migration 063, link fields from the
      // integrations draft): one row per store — upsert by store_id.
      // The link columns may not exist on older copies, so a column
      // error retries with the core columns only.
      const storefrontRows = Array.isArray(tables.storefront_profiles)
        ? tables.storefront_profiles
        : [];
      const sfRow = storefrontRows.find((r) => r && typeof r === 'object');
      if (sfRow) {
        try {
          const s = snakeRow(sfRow);
          const CORE = ['slug', 'display_name', 'tagline', 'about', 'hours', 'contact_email', 'contact_phone', 'accent_color', 'published', 'show_prices'];
          const LINKS = ['address', 'facebook_url', 'instagram_url', 'tiktok_url', 'whatsapp_phone', 'review_url', 'directions_url', 'order_url', 'newsletter_url'];
          const build = (cols) => {
            const out = { store_id: storeId };
            if (UUID_RE.test(String(s.id ?? ''))) out.id = s.id;
            for (const c of cols) if (s[c] !== undefined) out[c] = s[c];
            return out;
          };
          let res = await client
            .from('storefront_profiles')
            .upsert(build([...CORE, ...LINKS]), { onConflict: 'store_id' });
          if (res.error && /42703|does not exist|column/i.test(res.error.message || '')) {
            res = await client
              .from('storefront_profiles')
              .upsert(build(CORE), { onConflict: 'store_id' });
          }
          if (res.error) throw res.error;
          bump('storefront_profiles', 1, 'inserted');
        } catch (err) {
          report.errors.storefront = err?.message || String(err);
        }
      }
      return report;
    },
  };

  /* ---------------- Catalogue inventory (cloud, migration 013) ---------------- */
  let bqReady = null;
  async function bqHasTables() {
    if (bqReady !== null) return bqReady;
    try {
      const res = await client.from('bq_items').select('id').limit(1);
      bqReady = !res.error || !/42P01|does not exist/i.test(res.error.message || '');
    } catch {
      bqReady = false;
    }
    return bqReady;
  }
  function bqNeed() {
    throw new Error('The catalogue needs migration 013 — ask a manager to apply it.');
  }

  // Migration 064 capability probe: bq_fair_sales.sale_id (the 1:1 link
  // from a fair-sale record to its pos_sales ledger row). Pre-064 databases
  // keep the legacy fair-only bookkeeping.
  let bqFairSaleLink = null;
  async function bqHasFairSaleLink() {
    if (bqFairSaleLink !== null) return bqFairSaleLink;
    try {
      const res = await client.from('bq_fair_sales').select('sale_id').limit(1);
      bqFairSaleLink = !res.error || !/42703|does not exist/i.test(res.error.message || '');
    } catch {
      bqFairSaleLink = false;
    }
    return bqFairSaleLink;
  }

  const mapBqFairSale = (s) => ({
    id: s.id, fairId: s.fair_id, itemId: s.item_id, title: s.title,
    qty: s.qty, unitPrice: Number(s.unit_price), soldAt: s.sold_at,
    saleId: s.sale_id ?? null,
  });

  // Migration 065 capability probe: bq_special_orders.customer_id (the
  // optional link from a special order to the shop's customer file).
  let bqOrderCustomer = null;
  async function bqHasOrderCustomer() {
    if (bqOrderCustomer !== null) return bqOrderCustomer;
    try {
      const res = await client.from('bq_special_orders').select('customer_id').limit(1);
      bqOrderCustomer = !res.error || !/42703|does not exist/i.test(res.error.message || '');
    } catch {
      bqOrderCustomer = false;
    }
    return bqOrderCustomer;
  }

  /* ---------------- Shared shop (migration 016) ----------------
   * Catalogue data belongs to a pos_store; store membership
   * (pos_store_members, roles owner/manager/cashier) governs access.
   * Active-shop context: a user in several shops works in exactly one at
   * a time. The choice persists per account on this device; every query
   * is explicitly scoped to it, and RLS enforces the rest. */
  let bqStoresCache = null; // [{ id, role, name, joinedAt }] | null
  let bqStoresPromise = null;
  function bqClearStoreCache() {
    bqStoresCache = null;
    bqStoresPromise = null;
  }
  function bqActiveStoreKey(uid) {
    return 'driftshop:bq:active_store:' + uid;
  }
  function bqMyStores() {
    if (bqStoresCache !== null || bqStoresPromise) return bqStoresPromise || Promise.resolve(bqStoresCache);
    bqStoresPromise = (async () => {
      try {
        const uid = requireUid();
        const res = await client
          .from('pos_store_members')
          .select('store_id, role, joined_at, pos_stores(name)')
          .eq('user_id', uid)
          .order('joined_at', { ascending: true });
        if (res.error) throw new Error(res.error.message);
        bqStoresCache = (res.data || []).map((r) => ({
          id: r.store_id, role: r.role, name: r.pos_stores?.name ?? null, joinedAt: r.joined_at,
        }));
      } catch {
        bqStoresCache = [];
      }
      bqStoresPromise = null;
      return bqStoresCache;
    })();
    return bqStoresPromise;
  }
  /** The single shop this user is currently working in (or null). */
  async function bqMyStore() {
    const stores = await bqMyStores();
    if (!stores.length) return null;
    let pick = null;
    try {
      const uid = requireUid();
      const saved = localStorage.getItem(bqActiveStoreKey(uid));
      if (saved) pick = stores.find((s) => s.id === saved) || null;
    } catch { /* storage unavailable — fall through to default */ }
    if (!pick) {
      pick = stores[0]; // earliest membership
      try {
        const uid = requireUid();
        localStorage.setItem(bqActiveStoreKey(uid), pick.id);
      } catch { /* ignore */ }
    }
    return pick;
  }
  async function bqRequireStoreId() {
    const s = await bqMyStore();
    if (!s) {
      const e = new Error('No shop assigned to this account yet — ask the owner for an invite code.');
      e.code = 'bq_no_shop';
      throw e;
    }
    return s.id;
  }
  /** Update payloads must never move a row between shops or owners. */
  function bqStripImmutable(payload) {
    const p = { ...payload };
    delete p.id;
    delete p.owner_id;
    delete p.store_id;
    return p;
  }

  const bqItemCols = 'id, kind, title, author, isbn, category, is_new, condition, qty, price, shelf, source, status, abe_ref, abe_status, notes, created_at, updated_at';
  const mapBqItem = (r) => r && {
    id: r.id, kind: r.kind, title: r.title, author: r.author, isbn: r.isbn,
    category: r.category, isNew: !!r.is_new, condition: r.condition, qty: r.qty,
    price: Number(r.price), shelf: r.shelf, source: r.source, status: r.status,
    abeRef: r.abe_ref, abeStatus: r.abe_status, notes: r.notes,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
  const unmapBqItem = (c, ownerId, storeId) => ({
    ...(c.id ? { id: c.id } : {}),
    owner_id: ownerId, store_id: storeId, kind: c.kind, title: c.title, author: c.author, isbn: c.isbn,
    category: c.category, is_new: c.isNew, condition: c.condition, qty: c.qty,
    price: c.price, shelf: c.shelf, source: c.source, status: c.status,
    abe_ref: c.abeRef, abe_status: c.abeStatus, notes: c.notes,
  });

  const bouquinerie = {
    /** The shop (pos_store) this user is currently working in, with their role — or null. */
    async myStore() {
      if (!(await bqHasTables())) return null;
      return bqMyStore();
    },
    /** Every shop this user belongs to (for the shop switcher). */
    async myStores() {
      if (!(await bqHasTables())) return [];
      return bqMyStores();
    },
    /** Switch the active shop. Must be a member; persists per account on this device. */
    async setActiveStore(storeId) {
      if (!(await bqHasTables())) bqNeed();
      const stores = await bqMyStores();
      const pick = stores.find((s) => s.id === storeId);
      if (!pick) {
        const e = new Error('Not a member of that shop.');
        e.code = 'bq_not_member';
        throw e;
      }
      try {
        localStorage.setItem(bqActiveStoreKey(requireUid()), pick.id);
      } catch { /* ignore */ }
      bqClearStoreCache();
      return bqMyStore();
    },
    /** Clear cached shops and re-resolve (e.g. after joining a store). */
    async refreshStore() {
      bqClearStoreCache();
      return bqMyStore();
    },

    async listItems(filter = {}) {
      if (!(await bqHasTables())) return [];
      const storeId = await bqRequireStoreId();
      let q = client.from('bq_items').select(bqItemCols).eq('store_id', storeId).order('updated_at', { ascending: false });
      if (filter.status) q = q.eq('status', filter.status);
      if (filter.kind) q = q.eq('kind', filter.kind);
      if (filter.source) q = q.eq('source', filter.source);
      const rows = check(await q, 'Loading catalogue');
      const nq = normText(filter.query);
      const list = (rows || []).map(mapBqItem);
      if (!nq) return list;
      const qIsbn = nq.replace(/\s/g, '').toUpperCase();
      return list.filter((x) =>
        normText(x.title)?.includes(nq) || normText(x.author)?.includes(nq) ||
        (x.isbn && qIsbn && x.isbn.includes(qIsbn)));
    },

    async getItem(id) {
      if (!(await bqHasTables())) return null;
      const storeId = await bqRequireStoreId();
      const row = check(await client.from('bq_items').select(bqItemCols).eq('id', id).eq('store_id', storeId).maybeSingle(), 'Loading item');
      return mapBqItem(row);
    },

    async saveItem(raw) {
      if (!(await bqHasTables())) bqNeed();
      const ownerId = requireUid();
      const storeId = await bqRequireStoreId();
      const clean = cleanBqItem(raw, () => crypto.randomUUID());
      let row;
      if (raw && raw.id) {
        const payload = bqStripImmutable(unmapBqItem(clean, ownerId, storeId));
        row = check(await client.from('bq_items').update(payload).eq('id', raw.id).eq('store_id', storeId).select(bqItemCols).single(), 'Saving item');
      } else {
        const payload = unmapBqItem(clean, ownerId, storeId);
        row = check(await client.from('bq_items').insert(payload).select(bqItemCols).single(), 'Saving item');
      }
      return mapBqItem(row);
    },

    async deleteItem(id) {
      if (!(await bqHasTables())) bqNeed();
      requireUid();
      const storeId = await bqRequireStoreId();
      check(await client.from('bq_items').delete().eq('id', id).eq('store_id', storeId), 'Deleting item');
      return true;
    },

    async findDuplicates({ isbn, title, author, excludeId } = {}) {
      if (!(await bqHasTables())) return [];
      const storeId = await bqRequireStoreId();
      const nIsbn = normIsbn(isbn);
      const nTitle = normText(title);
      const nAuthor = normText(author);
      if (!nIsbn && !nTitle) return [];
      let rows;
      if (nIsbn) {
        rows = check(await client.from('bq_items').select(bqItemCols).eq('store_id', storeId).eq('isbn', nIsbn), 'Checking duplicates');
      } else {
        rows = check(await client.from('bq_items').select(bqItemCols).eq('store_id', storeId), 'Checking duplicates');
      }
      return (rows || []).map(mapBqItem).filter((x) => {
        if (excludeId && x.id === excludeId) return false;
        if (nIsbn && x.isbn === nIsbn) return true;
        if (nTitle && normText(x.title) === nTitle) {
          if (nAuthor || normText(x.author)) return normText(x.author) === nAuthor;
          return true;
        }
        return false;
      });
    },

    /* ----- donations ----- */
    async listDonations() {
      if (!(await bqHasTables())) return [];
      const storeId = await bqRequireStoreId();
      const rows = check(await client.from('bq_donations')
        .select('id, donor_name, received_at, item_count, state, notes, created_at')
        .eq('store_id', storeId)
        .order('received_at', { ascending: false }), 'Loading donations');
      return (rows || []).map((r) => ({
        id: r.id, donorName: r.donor_name, receivedAt: r.received_at,
        itemCount: r.item_count, state: r.state, notes: r.notes, createdAt: r.created_at,
      }));
    },

    async saveDonation(raw) {
      if (!(await bqHasTables())) bqNeed();
      const ownerId = requireUid();
      const storeId = await bqRequireStoreId();
      const o = raw && typeof raw === 'object' ? raw : {};
      const payload = {
        owner_id: ownerId,
        store_id: storeId,
        donor_name: String(o.donorName ?? '').trim().slice(0, 200) || null,
        received_at: o.receivedAt || new Date().toISOString().slice(0, 10),
        item_count: Math.max(0, Math.floor(Number(o.itemCount) || 0)),
        state: o.state === 'sorted' ? 'sorted' : 'received',
        notes: String(o.notes ?? '').trim().slice(0, 2000) || null,
      };
      let row;
      if (o.id) {
        const upd = bqStripImmutable(payload);
        row = check(await client.from('bq_donations').update(upd).eq('id', o.id).eq('store_id', storeId)
          .select('id, donor_name, received_at, item_count, state, notes, created_at').single(), 'Saving donation');
      } else {
        row = check(await client.from('bq_donations').insert(payload)
          .select('id, donor_name, received_at, item_count, state, notes, created_at').single(), 'Saving donation');
      }
      return { id: row.id, donorName: row.donor_name, receivedAt: row.received_at, itemCount: row.item_count, state: row.state, notes: row.notes, createdAt: row.created_at };
    },

    async deleteDonation(id) {
      if (!(await bqHasTables())) bqNeed();
      requireUid();
      const storeId = await bqRequireStoreId();
      check(await client.from('bq_donations').delete().eq('id', id).eq('store_id', storeId), 'Deleting donation');
      return true;
    },

    async donationItems(donationId) {
      if (!(await bqHasTables())) return [];
      const storeId = await bqRequireStoreId();
      const links = check(await client.from('bq_donation_items').select('item_id').eq('donation_id', donationId).eq('store_id', storeId), 'Loading donation items');
      const ids = (links || []).map((l) => l.item_id).filter(Boolean);
      if (!ids.length) return [];
      const rows = check(await client.from('bq_items').select(bqItemCols).in('id', ids).eq('store_id', storeId), 'Loading donation items');
      return (rows || []).map(mapBqItem);
    },

    async linkDonationItems(donationId, itemIds) {
      if (!(await bqHasTables())) bqNeed();
      requireUid();
      const storeId = await bqRequireStoreId();
      // Defense in depth: only link a donation that lives in the active shop.
      const don = check(await client.from('bq_donations').select('id').eq('id', donationId).eq('store_id', storeId).maybeSingle(), 'Checking donation');
      if (!don) { const e = new Error('Donation not found in this shop.'); e.code = 'bq_not_found'; throw e; }
      const rows = (itemIds || []).map((itemId) => ({ donation_id: donationId, item_id: itemId, store_id: storeId }));
      if (!rows.length) return true;
      check(await client.from('bq_donation_items').upsert(rows, { onConflict: 'donation_id,item_id', ignoreDuplicates: true }), 'Linking donation items');
      return true;
    },

    /* ----- fairs ----- */
    async listFairs() {
      if (!(await bqHasTables())) return [];
      const storeId = await bqRequireStoreId();
      const rows = check(await client.from('bq_fairs')
        .select('id, name, fair_date, beneficiary, notes, created_at')
        .eq('store_id', storeId)
        .order('fair_date', { ascending: false }), 'Loading fairs');
      return (rows || []).map((r) => ({
        id: r.id, name: r.name, fairDate: r.fair_date, beneficiary: r.beneficiary, notes: r.notes, createdAt: r.created_at,
      }));
    },

    async saveFair(raw) {
      if (!(await bqHasTables())) bqNeed();
      const ownerId = requireUid();
      const storeId = await bqRequireStoreId();
      const o = raw && typeof raw === 'object' ? raw : {};
      const payload = {
        owner_id: ownerId,
        store_id: storeId,
        name: String(o.name ?? '').trim().slice(0, 200) || 'Foire du livre',
        fair_date: o.fairDate || new Date().toISOString().slice(0, 10),
        beneficiary: String(o.beneficiary ?? '').trim().slice(0, 300) || null,
        notes: String(o.notes ?? '').trim().slice(0, 2000) || null,
      };
      let row;
      if (o.id) {
        const upd = bqStripImmutable(payload);
        row = check(await client.from('bq_fairs').update(upd).eq('id', o.id).eq('store_id', storeId)
          .select('id, name, fair_date, beneficiary, notes, created_at').single(), 'Saving fair');
      } else {
        row = check(await client.from('bq_fairs').insert(payload)
          .select('id, name, fair_date, beneficiary, notes, created_at').single(), 'Saving fair');
      }
      return { id: row.id, name: row.name, fairDate: row.fair_date, beneficiary: row.beneficiary, notes: row.notes, createdAt: row.created_at };
    },

    async deleteFair(id) {
      if (!(await bqHasTables())) bqNeed();
      requireUid();
      const storeId = await bqRequireStoreId();
      check(await client.from('bq_fairs').delete().eq('id', id).eq('store_id', storeId), 'Deleting fair');
      return true;
    },

    async recordFairSale(fairId, { itemId, title, qty = 1, unitPrice = 0, method = 'cash', idempotencyKey = null } = {}) {
      if (!(await bqHasTables())) bqNeed();
      requireUid();
      const storeId = await bqRequireStoreId();
      // Defense in depth: only record a sale for a fair in the active shop.
      // The fair's name is fetched too: migration 064 snapshots it onto the
      // ledger row (fair_name), the same pattern as the org snapshot.
      const fair = check(await client.from('bq_fairs').select('id, name').eq('id', fairId).eq('store_id', storeId).maybeSingle(), 'Checking fair');
      if (!fair) { const e = new Error('Fair not found in this shop.'); e.code = 'bq_not_found'; throw e; }
      const q = Math.max(1, Math.floor(Number(qty) || 1));
      const p = Math.max(0, Math.round((Number(unitPrice) || 0) * 100) / 100);
      const cleanTitle = String(title ?? '').trim().slice(0, 300) || 'Article';

      // Legacy path (pre-064 database): fair-only bookkeeping, unchanged —
      // the app keeps working until the migration is applied.
      if (!(await posHasSaleChannel())) {
        const sale = check(await client.from('bq_fair_sales').insert({
          fair_id: fairId, item_id: itemId || null, store_id: storeId,
          title: cleanTitle,
          qty: q, unit_price: p,
        }).select('id, fair_id, item_id, title, qty, unit_price, sold_at').single(), 'Recording sale');
        if (itemId) {
          const item = await this.getItem(itemId);
          if (item) {
            const nextQty = Math.max(0, item.qty - q);
            await this.saveItem({ ...item, qty: nextQty, status: nextQty === 0 ? 'sold' : item.status });
          }
        }
        return { id: sale.id, fairId: sale.fair_id, itemId: sale.item_id, title: sale.title, qty: sale.qty, unitPrice: Number(sale.unit_price), soldAt: sale.sold_at };
      }

      // Ledger path (migration 064): the fair sale is a first-class
      // pos_sales row (channel='fair'), so it gets the same atomic stock
      // decrement, History/Reports visibility and refund path as a
      // register sale. bq_fair_sales keeps the fair-day view, linked 1:1
      // to the ledger row via sale_id.
      const priceCents = Math.round(p * 100);
      const totalCents = q * priceCents;
      // The ledger enforces per-line money bounds (migrations 044/051) —
      // fail here with a plain message instead of a raw database error.
      if (q > 999 || priceCents > 1000000 || totalCents > 10000000) {
        throw new Error('That quantity or price is too big for one sale. Please lower it and try again.');
      }
      const idem = idempotencyKey ? String(idempotencyKey).slice(0, 128) : null;
      let sale = null;
      // Idempotent replay: if this exact attempt already reached the
      // ledger (e.g. its response was lost), reuse that row. We must NOT
      // call pos.recordSale again here — its own replay path re-applies
      // stock, which would double-decrement.
      if (idem && (await posHasSaleIdemCol())) {
        const prev = await client.from('pos_sales').select('*')
          .eq('store_id', storeId).eq('idempotency_key', idem).maybeSingle();
        if (!prev.error && prev.data) {
          sale = mapPosSale(prev.data);
          sale.stockWarnings = [];
        }
      }
      if (!sale) {
        const item = itemId ? await this.getItem(itemId) : null;
        const line = itemId
          ? {
              productId: `bq:${itemId}`,
              bqItemId: itemId,
              // Pre-sale shelf status, so a refund puts the item back
              // exactly where it was — same shape as POS catalogue lines.
              ...(item?.status ? { bqStatus: item.status } : {}),
              name: cleanTitle, priceCents, qty: q,
            }
          : { productId: null, name: cleanTitle, priceCents, qty: q };
        sale = await pos.recordSale(storeId, {
          items: [line],
          subtotalCents: totalCents,
          discountCents: 0,
          // Fair prices are final amounts — recorded tax-free, exactly as
          // the old fair bookkeeping treated them.
          taxCents: 0,
          taxLines: [],
          totalCents,
          method: ['cash', 'card', 'other'].includes(method) ? method : 'cash',
          tenderedCents: totalCents,
          changeCents: 0,
          channel: 'fair',
          fairId,
          fairName: fair.name || null,
          ...(idem ? { idempotencyKey: idem } : {}),
        });
      }
      // Link the fair-day record to its ledger row (retry-safe: the
      // unique partial index on sale_id converges replays on one link).
      const link = await this.ensureFairSaleLink({
        fairId, itemId: itemId || null, storeId, title: cleanTitle,
        qty: q, unitPrice: p, saleId: sale.id,
      });
      return { ...link, sale };
    },

    // Migration 064: link a fair-day record to its pos_sales ledger row.
    // Safe to call again after a lost response — the existing link is
    // returned instead of creating a duplicate.
    async ensureFairSaleLink({ fairId, itemId, storeId, title, qty, unitPrice, saleId }) {
      const cols = 'id, fair_id, item_id, title, qty, unit_price, sold_at, sale_id';
      const found = await client.from('bq_fair_sales').select(cols)
        .eq('sale_id', saleId).eq('store_id', storeId).maybeSingle();
      if (!found.error && found.data) return mapBqFairSale(found.data);
      const ins = await client.from('bq_fair_sales').insert({
        fair_id: fairId, item_id: itemId || null, store_id: storeId,
        title, qty, unit_price: unitPrice, sale_id: saleId,
      }).select(cols).single();
      if (ins.error) {
        // Lost a race with a concurrent retry — the link exists now.
        if (/23505|duplicate key|unique/i.test(ins.error.message || '')) {
          const again = await client.from('bq_fair_sales').select(cols)
            .eq('sale_id', saleId).eq('store_id', storeId).maybeSingle();
          if (!again.error && again.data) return mapBqFairSale(again.data);
        }
        throw new Error(ins.error.message || 'Recording sale failed.');
      }
      return mapBqFairSale(ins.data);
    },

    async listFairSales(fairId) {
      if (!(await bqHasTables())) return [];
      const storeId = await bqRequireStoreId();
      const linked = await bqHasFairSaleLink();
      const cols = linked
        ? 'id, fair_id, item_id, title, qty, unit_price, sold_at, sale_id'
        : 'id, fair_id, item_id, title, qty, unit_price, sold_at';
      const rows = check(await client.from('bq_fair_sales')
        .select(cols)
        .eq('fair_id', fairId).eq('store_id', storeId).order('sold_at', { ascending: false }), 'Loading fair sales');
      const sales = (rows || []).map((s) => ({
        ...mapBqFairSale(s),
        refundedCents: 0,
        voided: false,
      }));
      // Migration 064: for ledger-linked rows, surface the refund/void
      // state from the sales ledger so the fair-day view agrees with
      // History. Legacy (unlinked) rows keep counting exactly as before.
      const saleIds = sales.map((s) => s.saleId).filter(Boolean);
      if (saleIds.length) {
        const [ledgerRes, refundRes] = await Promise.all([
          client.from('pos_sales').select('id, voided').in('id', saleIds),
          client.from('pos_refunds').select('sale_id, refunded_cents').in('sale_id', saleIds),
        ]);
        if (!ledgerRes.error) {
          const voidedById = new Map((ledgerRes.data || []).map((r) => [r.id, !!r.voided]));
          for (const s of sales) if (s.saleId) s.voided = !!voidedById.get(s.saleId);
        }
        if (!refundRes.error) {
          const refundedBySale = new Map();
          for (const r of refundRes.data || []) {
            refundedBySale.set(r.sale_id, (refundedBySale.get(r.sale_id) || 0) + (Number(r.refunded_cents) || 0));
          }
          for (const s of sales) if (s.saleId) s.refundedCents = refundedBySale.get(s.saleId) || 0;
        }
      }
      return sales;
    },

    async fairTotals(fairId) {
      const sales = await this.listFairSales(fairId);
      // Voided ledger sales no longer count, and refunds are netted out —
      // the fair-day totals now agree with Reports. Legacy (unlinked)
      // rows carry no refund state and count exactly as before.
      const live = sales.filter((s) => !s.voided);
      return {
        itemsSold: live.reduce((n, s) => n + (s.qty || 0), 0),
        revenue: Math.round(live.reduce((n, s) => n + (s.qty || 0) * (s.unitPrice || 0) - (s.refundedCents || 0) / 100, 0) * 100) / 100,
        salesCount: live.length,
      };
    },

    /* ----- special orders ----- */
    async listOrders(filter = {}) {
      if (!(await bqHasTables())) return [];
      const storeId = await bqRequireStoreId();
      const custCol = (await bqHasOrderCustomer()) ? ', customer_id' : '';
      let q = client.from('bq_special_orders')
        .select(`id, customer_name, customer_phone, title, author, notes, status, created_at, updated_at${custCol}`)
        .eq('store_id', storeId)
        .order('updated_at', { ascending: false });
      if (filter.status) q = q.eq('status', filter.status);
      const rows = check(await q, 'Loading special orders');
      return (rows || []).map((r) => ({
        id: r.id, customerName: r.customer_name, customerPhone: r.customer_phone,
        title: r.title, author: r.author, notes: r.notes, status: r.status,
        customerId: r.customer_id ?? null,
        createdAt: r.created_at, updatedAt: r.updated_at,
      }));
    },

    async saveOrder(raw) {
      if (!(await bqHasTables())) bqNeed();
      const ownerId = requireUid();
      const storeId = await bqRequireStoreId();
      const o = raw && typeof raw === 'object' ? raw : {};
      const customerName = String(o.customerName ?? '').trim().slice(0, 200);
      const title = String(o.title ?? '').trim().slice(0, 300);
      if (!customerName) { const e = new Error('Customer name is required.'); e.code = 'bq_customer_required'; throw e; }
      if (!title) { const e = new Error('Title is required.'); e.code = 'bq_title_required'; throw e; }
      const payload = {
        owner_id: ownerId,
        store_id: storeId,
        customer_name: customerName,
        customer_phone: String(o.customerPhone ?? '').trim().slice(0, 40) || null,
        title,
        author: String(o.author ?? '').trim().slice(0, 200) || null,
        notes: String(o.notes ?? '').trim().slice(0, 2000) || null,
        status: BQ_ORDER_STATUSES.includes(o.status) ? o.status : 'requested',
      };
      // Migration 065: optional link to the shop's customer file. The
      // name/phone above stay the order's own snapshot (they are what was
      // picked or typed, and remain editable per order); the link only
      // has to point at a real customer of THIS shop.
      const hasCustCol = await bqHasOrderCustomer();
      if (hasCustCol) {
        const customerId = o.customerId || null;
        if (customerId) {
          const cust = check(await client.from('pos_customers').select('id')
            .eq('id', customerId).eq('store_id', storeId).maybeSingle(), 'Checking customer');
          if (!cust) { const e = new Error('Customer not found in this shop.'); e.code = 'bq_customer_gone'; throw e; }
        }
        payload.customer_id = customerId;
      }
      const rowCols = `id, customer_name, customer_phone, title, author, notes, status, created_at, updated_at${hasCustCol ? ', customer_id' : ''}`;
      let row;
      if (o.id) {
        const upd = bqStripImmutable(payload);
        row = check(await client.from('bq_special_orders').update(upd).eq('id', o.id).eq('store_id', storeId)
          .select(rowCols).single(), 'Saving order');
      } else {
        row = check(await client.from('bq_special_orders').insert(payload)
          .select(rowCols).single(), 'Saving order');
      }
      return {
        id: row.id, customerName: row.customer_name, customerPhone: row.customer_phone,
        title: row.title, author: row.author, notes: row.notes, status: row.status,
        customerId: row.customer_id ?? null,
        createdAt: row.created_at, updatedAt: row.updated_at,
      };
    },

    async deleteOrder(id) {
      if (!(await bqHasTables())) bqNeed();
      requireUid();
      const storeId = await bqRequireStoreId();
      check(await client.from('bq_special_orders').delete().eq('id', id).eq('store_id', storeId), 'Deleting order');
      return true;
    },

    /* ----- CSV bridge ----- */
    csvHeaders() {
      return bqCsvHeaders();
    },

    async exportCsv() {
      const items = await this.listItems();
      return bqExportCsv(items);
    },

    parseCsv(text) {
      return bqParseCsv(text, () => crypto.randomUUID());
    },

    async importCsvRows(rows) {
      if (!(await bqHasTables())) bqNeed();
      const ownerId = requireUid();
      const storeId = await bqRequireStoreId();
      const payloads = (rows || []).map((c) => unmapBqItem({ ...c, id: crypto.randomUUID() }, ownerId, storeId));
      if (!payloads.length) return { inserted: 0, skipped: 0 };
      // Prevent duplicate imports: skip rows that match an existing item by ISBN,
      // or by title+author when no ISBN is present. Re-importing the same CSV
      // must not create duplicates.
      // NUCLEAR FAILSAFE: fail CLOSED. If the existing-items query errors, we
      // must NOT proceed with an empty dedup set (that would silently import
      // duplicates). Throw instead.
      const { data: existing, error: existingErr } = await client
        .from('bq_items')
        .select('isbn, title, author')
        .eq('store_id', storeId);
      if (existingErr) {
        throw new Error(`Import aborted: could not check for duplicates (${existingErr.message})`);
      }
      const existingIsbns = new Set((existing || []).map((e) => (e.isbn || '').trim()).filter(Boolean));
      const existingTitleAuthor = new Set(
        (existing || []).map((e) => `${(e.title || '').trim().toLowerCase()}|${(e.author || '').trim().toLowerCase()}`)
      );
      const seenIsbns = new Set();
      const seenTitleAuthor = new Set();
      const toInsert = [];
      let skipped = 0;
      for (const p of payloads) {
        const isbn = (p.isbn || '').trim();
        const taKey = `${(p.title || '').trim().toLowerCase()}|${(p.author || '').trim().toLowerCase()}`;
        // Check against DB and against rows already in this batch
        if (isbn) {
          if (existingIsbns.has(isbn) || seenIsbns.has(isbn)) { skipped++; continue; }
          seenIsbns.add(isbn);
        } else {
          if (existingTitleAuthor.has(taKey) || seenTitleAuthor.has(taKey)) { skipped++; continue; }
          seenTitleAuthor.add(taKey);
        }
        toInsert.push(p);
      }
      if (toInsert.length) {
        // NUCLEAR FAILSAFE: the unique index from migration 052 is the atomic
        // backstop for concurrent imports. If the bulk insert hits it (a
        // concurrent import won the race), fall back to row-by-row inserts so
        // conflicts become "skipped" instead of failing the whole batch.
        try {
          check(await client.from('bq_items').insert(toInsert), 'Importing CSV');
        } catch (err) {
          const msg = String(err?.message || '');
          if (!/duplicate key|unique constraint|23505|bq_items_store_isbn_unique/i.test(msg)) throw err;
          let inserted = 0;
          for (const p of toInsert) {
            try {
              check(await client.from('bq_items').insert(p), 'Importing CSV row');
              inserted++;
            } catch (rowErr) {
              const rowMsg = String(rowErr?.message || '');
              if (/duplicate key|unique constraint|23505|bq_items_store_isbn_unique/i.test(rowMsg)) {
                skipped++;
              } else {
                throw rowErr;
              }
            }
          }
          return { inserted, skipped };
        }
      }
      return { inserted: toInsert.length, skipped };
    },
  };

  /* ---------------- support tickets + feedback (cloud only) ---------------- */
  // Users (including trial guests) file tickets — e.g. "I want to buy/pay" —
  // and send feedback. Users see only their own rows; the admin panel lists
  // and manages everything (RLS enforces both sides).
  const support = {
    // Migration 072 probe: support_tickets.scope ('shop' | 'platform')
    // routes purchase/unlock messages to the platform owner. Older
    // databases don't have the column yet — tickets keep working exactly
    // as before (scope silently stays 'shop').
    async createTicket({ subject, message, scope, storeId }) {
      const uid = requireUid();
      const clean = {
        user_id: uid,
        subject: String(subject ?? '').trim().slice(0, 200),
        message: String(message ?? '').trim().slice(0, 5000),
      };
      if (!clean.subject) throw new Error('Give your request a subject.');
      if (!clean.message) throw new Error('Describe what you need.');
      const withScope = { ...clean };
      if (scope === 'platform' || scope === 'shop') withScope.scope = scope;
      if (storeId) withScope.store_id = storeId;
      let res = await client
        .from('support_tickets')
        .insert(withScope)
        .select('id, subject, message, status, admin_response, created_at')
        .single();
      if (res.error && /scope|store_id|42703|PGRST204|does not exist|Could not find/i.test(res.error.message || '')) {
        res = await client
          .from('support_tickets')
          .insert(clean)
          .select('id, subject, message, status, admin_response, created_at')
          .single();
      }
      if (res.error) throw new Error(`Sending failed: ${res.error.message}`);
      return res.data;
    },

    // Logged-out help request (e.g. "I forgot my password and have no email
    // on my account"). Filed WITHOUT signing in: user_id stays null and the
    // account username is stored in the username column for the admin.
    // Deliberately never checks whether the username exists — the reply is
    // identical either way, so usernames can't be enumerated through this.
    async createPublicTicket({ username, subject, message }) {
      const cleanName = String(username ?? '').trim().slice(0, 60);
      const cleanSubject = String(subject ?? '').trim().slice(0, 200) || 'Password reset request';
      const cleanMessage = String(message ?? '').trim().slice(0, 5000);
      if (cleanName.length < 2) throw new Error('Enter your username.');
      if (!/[a-zA-Z0-9]/.test(cleanName)) throw new Error('That username does not look valid.');
      if (cleanMessage.length < 10) throw new Error('Please describe the problem (at least 10 characters).');
      // Cheap device-side rate limit against ticket spam (server can't
      // throttle anonymous callers by identity).
      try {
        const last = Number(localStorage.getItem('driftshop_ticket_last') || 0);
        if (Date.now() - last < 120000) {
          throw new Error('Please wait a couple of minutes before sending another request.');
        }
      } catch (e) {
        if (/couple of minutes/.test(e.message)) throw e;
      }
      const { error } = await client.from('support_tickets').insert({
        user_id: null,
        username: cleanName,
        subject: cleanSubject,
        message: cleanMessage,
      });
      if (error) throw new Error(`Sending failed: ${error.message}`);
      try {
        localStorage.setItem('driftshop_ticket_last', String(Date.now()));
      } catch {
        /* non-fatal */
      }
    },

    async listMyTickets() {
      const uid = requireUid();
      const base = 'id, subject, message, status, admin_response, created_at, updated_at';
      let res = await client
        .from('support_tickets')
        .select(`${base}, scope, store_id`)
        .eq('user_id', uid)
        .order('created_at', { ascending: false })
        .limit(50);
      if (res.error && /scope|store_id|42703|PGRST204|does not exist|Could not find/i.test(res.error.message || '')) {
        res = await client
          .from('support_tickets')
          .select(base)
          .eq('user_id', uid)
          .order('created_at', { ascending: false })
          .limit(50);
      }
      if (res.error) throw new Error(`Loading your requests failed: ${res.error.message}`);
      return res.data ?? [];
    },

    // Attach a display name per ticket (separate query: tickets reference
    // auth.users, not profiles, so PostgREST can't auto-join).
    async _usernames(ids) {
      const names = {};
      if (!ids.length) return names;
      const { data } = await client.from('profiles').select('id, username, display_name').in('id', ids);
      for (const p of data ?? []) names[p.id] = p.display_name || p.username || 'user';
      return names;
    },

    async adminListTickets() {
      const base = 'id, user_id, username, subject, message, status, admin_response, created_at, updated_at';
      let res = await client
        .from('support_tickets')
        .select(`${base}, scope, store_id`)
        .order('created_at', { ascending: false })
        .limit(200);
      if (res.error && /scope|store_id|42703|PGRST204|does not exist|Could not find/i.test(res.error.message || '')) {
        res = await client
          .from('support_tickets')
          .select(base)
          .order('created_at', { ascending: false })
          .limit(200);
      }
      if (res.error) throw new Error(`Loading support tickets failed: ${res.error.message}`);
      const rows = res.data ?? [];
      const ids = [...new Set(rows.map((r) => r.user_id).filter(Boolean))];
      const names = await this._usernames(ids);
      return rows.map((r) => ({
        ...r,
        // Logged-out tickets carry the claimed account username directly;
        // signed-in tickets resolve through profiles as before.
        username: r.username || names[r.user_id] || 'user',
      }));
    },

    async adminUpdateTicket(id, patch) {
      if (!id) throw new Error('adminUpdateTicket needs a ticket id.');
      const clean = {};
      if ('status' in patch) {
        if (!['open', 'in_progress', 'resolved'].includes(patch.status)) throw new Error('Bad status.');
        clean.status = patch.status;
      }
      if ('admin_response' in patch) {
        clean.admin_response = String(patch.admin_response ?? '').trim().slice(0, 5000) || null;
      }
      if (Object.keys(clean).length === 0) throw new Error('Nothing to update.');
      clean.updated_at = new Date().toISOString();
      const { error } = await client.from('support_tickets').update(clean).eq('id', id);
      if (error) throw new Error(`Updating ticket failed: ${error.message}`);
    },

    // Account backup: the user's own tickets (admin responses included —
    // it's their own thread). Merge-only on import.
    async exportMine() {
      const uid = requireUid();
      const { data, error } = await client
        .from('support_tickets')
        .select('id, subject, message, status, admin_response, created_at, updated_at')
        .eq('user_id', uid)
        .limit(1000);
      if (error) throw new Error(`Exporting your requests failed: ${error.message}`);
      return data ?? [];
    },

    async importMine(tickets) {
      const uid = requireUid();
      const rows = Array.isArray(tickets) ? tickets : [];
      if (!rows.length) return { inserted: 0, skipped: 0 };
      const { data: existing } = await client.from('support_tickets').select('id').eq('user_id', uid);
      const have = new Set((existing ?? []).map((r) => r.id));
      const missing = rows
        .filter((r) => r && r.id && !have.has(r.id))
        .map((r) => ({
          id: UUID_RE.test(String(r.id)) ? r.id : freshUuid(),
          user_id: uid,
          subject: String(r.subject ?? '').slice(0, 200) || '(restored)',
          message: String(r.message ?? '').slice(0, 5000),
          status: ['open', 'in_progress', 'resolved'].includes(r.status) ? r.status : 'open',
          admin_response: r.admin_response ? String(r.admin_response).slice(0, 5000) : null,
          created_at: r.created_at ?? new Date().toISOString(),
          updated_at: r.updated_at ?? new Date().toISOString(),
        }));
      if (missing.length) {
        const { error } = await client.from('support_tickets').insert(missing);
        if (error) throw new Error(`Restoring requests failed: ${error.message}`);
      }
      return { inserted: missing.length, skipped: rows.length - missing.length };
    },
  };

  const feedback = {
    async submit({ message, rating = null }) {
      const uid = requireUid();
      const clean = {
        user_id: uid,
        message: String(message ?? '').trim().slice(0, 5000),
        rating: rating == null ? null : Math.min(5, Math.max(1, Number(rating) || 0)) || null,
      };
      if (!clean.message) throw new Error('Write a little something first.');
      const { data, error } = await client
        .from('feedback')
        .insert(clean)
        .select('id, message, rating, created_at')
        .single();
      if (error) throw new Error(`Sending failed: ${error.message}`);
      return data;
    },

    async listMine() {
      const uid = requireUid();
      const { data, error } = await client
        .from('feedback')
        .select('id, message, rating, created_at')
        .eq('user_id', uid)
        .order('created_at', { ascending: false })
        .limit(50);
      if (error) throw new Error(`Loading your feedback failed: ${error.message}`);
      return data ?? [];
    },

    // Account backup: the user's own feedback. Merge-only on import.
    async exportMine() {
      const uid = requireUid();
      const { data, error } = await client
        .from('feedback')
        .select('id, message, rating, created_at')
        .eq('user_id', uid)
        .limit(1000);
      if (error) throw new Error(`Exporting your feedback failed: ${error.message}`);
      return data ?? [];
    },

    async importMine(items) {
      const uid = requireUid();
      const rows = Array.isArray(items) ? items : [];
      if (!rows.length) return { inserted: 0, skipped: 0 };
      const { data: existing } = await client.from('feedback').select('id').eq('user_id', uid);
      const have = new Set((existing ?? []).map((r) => r.id));
      const missing = rows
        .filter((r) => r && r.id && !have.has(r.id))
        .map((r) => ({
          id: UUID_RE.test(String(r.id)) ? r.id : freshUuid(),
          user_id: uid,
          message: String(r.message ?? '').slice(0, 5000),
          rating: r.rating == null ? null : Math.min(5, Math.max(1, Number(r.rating) || 0)) || null,
          created_at: r.created_at ?? new Date().toISOString(),
        }))
        .filter((r) => r.message);
      if (missing.length) {
        const { error } = await client.from('feedback').insert(missing);
        if (error) throw new Error(`Restoring feedback failed: ${error.message}`);
      }
      return { inserted: missing.length, skipped: rows.length - missing.length };
    },

    async adminList() {
      const { data, error } = await client
        .from('feedback')
        .select('id, user_id, message, rating, reviewed, created_at')
        .order('created_at', { ascending: false })
        .limit(200);
      if (error) throw new Error(`Loading feedback failed: ${error.message}`);
      const rows = data ?? [];
      const names = await support._usernames([...new Set(rows.map((r) => r.user_id))]);
      return rows.map((r) => ({ ...r, username: names[r.user_id] || 'user' }));
    },

    async adminSetReviewed(id, reviewed) {
      if (!id) throw new Error('adminSetReviewed needs a feedback id.');
      const { error } = await client.from('feedback').update({ reviewed: !!reviewed }).eq('id', id);
      if (error) throw new Error(`Updating feedback failed: ${error.message}`);
    },
  };

  /* ---------------- shop licensing (migration 072) ---------------- */
  // 30-day trial per shop, then a soft lock. The database computes the
  // effective status; keys are validated server-side (only their
  // SHA-256 hash is ever stored). Everything here degrades to "feature
  // off" until migration 072 is applied: available() probes once, and
  // the app gate simply never locks.
  let licenseProbe = null;
  async function licensingAvailable() {
    if (licenseProbe !== null) return licenseProbe;
    try {
      const res = await client.from('shop_licenses').select('store_id').limit(1);
      licenseProbe = !res.error;
    } catch {
      licenseProbe = false;
    }
    return licenseProbe;
  }

  // RPC failures raise coded exceptions (see migration 072). Map them to
  // stable client codes so the UI can show one plain sentence per case.
  function licenseError(error) {
    const msg = String(error?.message || error || '');
    const code = msg.includes('license-too-many-attempts')
      ? 'too-many'
      : msg.includes('license-key-used')
        ? 'used'
        : msg.includes('license-not-owner')
          ? 'not-owner'
          : msg.includes('license-no-shop')
            ? 'no-shop'
            : msg.includes('license-sign-in-required')
              ? 'sign-in'
              : msg.includes('license-not-master')
                ? 'not-master'
                : msg.includes('license-key')
                  ? 'not-found'
                  : 'generic';
    const err = new Error(code);
    err.code = code;
    return err;
  }

  const license = {
    available: licensingAvailable,

    /** The caller's shops with server-computed license status. */
    async myStatus() {
      if (!(await licensingAvailable())) return [];
      const { data, error } = await client.rpc('my_license_status');
      if (error) throw licenseError(error);
      return data ?? [];
    },

    /**
     * Redeem a one-time key. storeId optional: the RPC picks the
     * caller's locked shop when omitted. Resolves to the RPC jsonb
     * ({ store_id, status, plan, current_period_ends_at? }).
     */
    async redeemKey(rawKey, storeId = null) {
      const args = { p_key: String(rawKey ?? '') };
      if (storeId) args.p_store_id = storeId;
      const { data, error } = await client.rpc('redeem_license_key', args);
      if (error) throw licenseError(error);
      // Failures come back as jsonb (not exceptions) so the server-side
      // throttle counter survives them; rethrow in the coded shape.
      if (data && data.ok === false) throw licenseError(new Error(String(data.error || 'license-key')));
      return data;
    },

    /** PLATFORM MASTER ONLY. Returns the raw keys — shown once, never stored. */
    async generateKeys(count, plan, termMonths = null) {
      const args = { p_count: count, p_plan: plan };
      if (plan === 'term') args.p_term_months = termMonths;
      const { data, error } = await client.rpc('generate_license_keys', args);
      if (error) throw licenseError(error);
      return data ?? [];
    },

    /** PLATFORM MASTER ONLY. Hints + status only; raw keys never come back. */
    async listKeys(limit = 200) {
      const { data, error } = await client.rpc('list_license_keys', { p_limit: limit });
      if (error) throw licenseError(error);
      return data ?? [];
    },

    /** PLATFORM MASTER ONLY. Revoking a used key locks that shop again. */
    async revokeKey(keyId) {
      const { error } = await client.rpc('revoke_license_key', { p_key_id: keyId });
      if (error) throw licenseError(error);
    },
  };

  // ---- customer: per-shop customer identity -----------------------------------
  // One login for customers too (2026-10-01): a confirmed customer account
  // links itself to a shop's customer list (public.shop_customers) the
  // first time they visit the shop page. The customers worker builds orders
  // on top of this table.
  const customer = {
    // Link the signed-in user to a shop's customer list. Idempotent —
    // returns the link row. Throws for unpublished/unknown slugs.
    async linkShopCustomer(slug) {
      const clean = String(slug ?? '').trim();
      if (!clean) throw new Error('linkShopCustomer needs a shop slug.');
      const { data, error } = await client.rpc('link_shop_customer', { p_slug: clean });
      if (error) throw new Error(`Could not link your account to this shop: ${error.message}`);
      return data;
    },
  };

  return {
    kind: 'supabase',
    note: null,
    /** Raw Supabase client — exposed for system health checks and diagnostics. */
    supabase: client,
    auth,
    recovery,
    profile,
    settings,
    files,
    shopFiles,
    spaces,
    pins,
    helm,
    highscores,
    notifications,
    pos,
    bouquinerie,
    classifieds,
    support,
    feedback,
    license,
    customer,
    platform,
  };
}
