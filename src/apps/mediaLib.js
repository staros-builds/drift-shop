import { backend } from '../lib/backend/current.js';

export const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;
export const VIDEO_EXT = /\.(mp4|webm|ogv|ogg|mov|m4v)$/i;
export const AUDIO_EXT = /\.(mp3|wav|oga|ogg|m4a|aac|flac|opus)$/i;

function joinPath(dir, name) {
  return dir === '/' ? `/${name}` : `${dir}/${name}`;
}
export function baseOf(path) {
  const i = path.lastIndexOf('/');
  return path.slice(i + 1);
}

/**
 * Recursively scan the VFS for files matching extRe (breadth-first, capped).
 * Returns entry objects { name, path, type, size, mime, updatedAt }.
 */
export async function scanMedia(extRe, { maxFiles = 1000 } = {}) {
  const out = [];
  const queue = ['/'];
  let guard = 0;
  while (queue.length > 0 && out.length < maxFiles && guard < 5000) {
    guard += 1;
    const dir = queue.shift();
    let entries;
    try {
      entries = await backend.files.list(dir);
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.type === 'folder') {
        queue.push(e.path);
      } else if (extRe.test(e.name)) {
        out.push(e);
        if (out.length >= maxFiles) break;
      }
    }
  }
  return out;
}

// URL cache: backend.files.fileUrl() gives an object URL (local) or a fresh
// signed URL (Supabase). Cache per path so thumbnails + viewer don't refetch.
const urlCache = new Map();
export async function mediaUrl(path) {
  if (urlCache.has(path)) return urlCache.get(path);
  const rec = await backend.files.fileUrl(path); // { url, mime, name }
  urlCache.set(path, rec);
  return rec;
}

/** play() that never throws: jsdom and some browsers can reject. */
export function safePlay(el) {
  if (!el || typeof el.play !== 'function') return;
  try {
    const p = el.play();
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch {
    /* not implemented / interrupted — ignore */
  }
}

export function formatTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '0:00';
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(r).padStart(2, '0')}`;
}

export function formatSize(bytes) {
  if (bytes == null || Number.isNaN(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const HIST_KEY = 'drift:media:history:v1';
function readHist() {
  try {
    return JSON.parse(localStorage.getItem(HIST_KEY) || '{}');
  } catch {
    return {};
  }
}
/** Remember a played file (kind: 'video' | 'audio'). Keeps the last 20. */
export function pushHistory(kind, entry) {
  try {
    const all = readHist();
    const list = (all[kind] || []).filter((h) => h.path !== entry.path);
    list.unshift({ path: entry.path, name: entry.name, at: Date.now() });
    all[kind] = list.slice(0, 20);
    localStorage.setItem(HIST_KEY, JSON.stringify(all));
  } catch {
    /* storage unavailable — history is best-effort */
  }
}
export function getHistory(kind) {
  return readHist()[kind] || [];
}

/** Parse an .srt file into [{ start, end, text }]. */
export function parseSrt(text) {
  const cues = [];
  const toSec = (t) => {
    const m = t.match(/(\d+):(\d+):(\d+)[,.](\d+)/);
    if (!m) return null;
    return (
      Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000
    );
  };
  const blocks = String(text || '')
    .replace(/\r/g, '')
    .split(/\n\s*\n/);
  for (const b of blocks) {
    const lines = b.split('\n').filter((l) => l.trim() !== '');
    if (lines.length < 2) continue;
    const timing = lines.length >= 3 ? lines[1] : lines[0];
    const parts = timing.split('-->');
    if (parts.length !== 2) continue;
    const start = toSec(parts[0].trim());
    const end = toSec(parts[1].trim());
    if (start == null || end == null) continue;
    const textLines = lines.length >= 3 ? lines.slice(2) : lines.slice(1);
    cues.push({ start, end, text: textLines.join('\n') });
  }
  cues.sort((a, b) => a.start - b.start);
  return cues;
}

/** Find the active cue at time t (binary-friendly linear scan is fine). */
export function cueAt(cues, t) {
  for (const c of cues) {
    if (t >= c.start && t <= c.end) return c;
  }
  return null;
}

export { joinPath };
