/**
 * ACCOUNT BACKUP — whole-account export shared by Settings and the
 * factory-reset pre-wipe safety net.
 *
 * exportAccountBackup() builds the exact same dump as Settings → "Download
 * account backup" (kind 'drift-backup', version '2.2.0'): settings, profile,
 * spaces + window states, files (text inline, binaries as data URLs with
 * caps), pins, Helm threads, high scores, notifications, per-store POS
 * dumps, shared shop files per store (migration 066), and the user's own
 * support tickets + feedback.
 *
 * It THROWS on failure — callers that must not proceed without a backup
 * (the factory-reset flow) treat a throw as an abort signal.
 *
 * downloadBackupFile(dump, filename) triggers the browser download; it is
 * the same code path as the manual Settings button.
 */

import { backend } from './backend/current.js';
import { getPrinterConfig } from './pos-print/index.js';

// Binary files ride along as data URLs so a restore is byte-identical.
// Caps keep one huge video from blowing up the backup: files over 25 MB
// each (or 200 MB of binaries total) are recorded as skipped, never fatal.
const MAX_BACKUP_FILE_BYTES = 25 * 1024 * 1024;
const MAX_BACKUP_BINARY_TOTAL = 200 * 1024 * 1024;

// FileReader-free data URL encoding: arrayBuffer + chunked btoa works on
// native Blobs everywhere (FileReader has interop quirks with non-DOM
// Blob implementations in some runtimes).
async function blobToDataUrl(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return `data:${blob.type || 'application/octet-stream'};base64,${btoa(bin)}`;
}

export async function exportAccountBackup() {
  // Files: text inline; binary embedded as data URLs (with caps).
  const files = [];
  let binaryBytes = 0;
  const walk = async (path) => {
    const entries = await backend.files.list(path);
    for (const e of entries) {
      if (e.type === 'folder') {
        files.push({ path: e.path, type: 'folder' });
        await walk(e.path);
      } else {
        try {
          const { text } = await backend.files.read(e.path);
          files.push({ path: e.path, type: 'file', text });
        } catch (err) {
          if (err?.code !== 'IS_BINARY') {
            files.push({ path: e.path, type: 'file', binary: true, note: err?.code || 'unreadable' });
            continue;
          }
          const size = e.size || 0;
          if (size > MAX_BACKUP_FILE_BYTES || binaryBytes + size > MAX_BACKUP_BINARY_TOTAL) {
            files.push({ path: e.path, type: 'file', binary: true, skipped: 'too large for backup', sizeBytes: size, mime: e.mime });
            continue;
          }
          try {
            const blob = await backend.files.downloadBlob(e.path);
            binaryBytes += blob.size;
            files.push({
              path: e.path, type: 'file', binary: true,
              data: await blobToDataUrl(blob), mime: e.mime, sizeBytes: blob.size,
            });
          } catch (bErr) {
            files.push({ path: e.path, type: 'file', binary: true, note: bErr?.message || 'unreadable' });
          }
        }
      }
    }
  };
  await walk('/');

  // Pins: file/image pins resolve their bytes to a data URL so the
  // image survives the round trip (local pins already carry it in body).
  const pins = [];
  for (const p of await backend.pins.list({})) {
    const out = { ...p };
    if ((p.kind === 'file' || p.kind === 'image') && backend.pins.fileData) {
      try {
        out.dataUrl = await backend.pins.fileData(p);
      } catch {
        out.dataUrl = null;
      }
    }
    pins.push(out);
  }

  // Spaces: full layout — wallpaper/accent/icon plus window states.
  const spaces = [];
  for (const s of await backend.spaces.list()) {
    let windowStates = [];
    try {
      windowStates = await backend.spaces.getWindowStates(s.id);
    } catch {
      windowStates = [];
    }
    spaces.push({ name: s.name, icon: s.icon, wallpaper: s.wallpaper, accent: s.accent, windowStates });
  }

  const threads = await backend.helm.threads();
  const threadsWithMessages = [];
  for (const t of threads) {
    threadsWithMessages.push({ ...t, messages: await backend.helm.messages(t.id) });
  }

  // POS stores: whole-store dumps (products, sales, customers, staff,
  // time-clock history, appointments, drawer shifts). One bad store
  // never sinks the export — its error is recorded on the dump.
  const posStores = [];
  try {
    const stores = await backend.pos.listStores();
    for (const s of stores) {
      try {
        const dump = await backend.pos.exportStore(s.id);
        // Device-local printer prefs ride along so a restored account
        // keeps its receipt layout (hardware itself stays per-device).
        try { dump.printer = getPrinterConfig(s.id); } catch { /* best effort */ }
        posStores.push(dump);
      } catch (err) {
        posStores.push({ storeId: s.id, store: { id: s.id, name: s.name }, tables: {}, __exportError: err?.message || String(err) });
      }
    }
  } catch (err) {
    posStores.push({ storeId: null, store: null, tables: {}, __exportError: err?.message || String(err) });
  }

  // Shared shop files (migration 066): the walk above only sees the
  // user's private files (files.list is owner-scoped), so each shop's
  // shared area is walked separately under its own store id. One bad
  // store never sinks the export — its error is recorded on the entry,
  // exactly like the POS dumps below.
  const shopFiles = [];
  const walkShop = async (storeId, out) => {
    let binaryBytes = 0;
    const walk = async (path) => {
      const entries = await backend.shopFiles.list(storeId, path);
      for (const e of entries) {
        if (e.type === 'folder') {
          out.push({ path: e.path, type: 'folder' });
          await walk(e.path);
        } else {
          try {
            const { text } = await backend.shopFiles.read(storeId, e.path);
            out.push({ path: e.path, type: 'file', text });
          } catch (err) {
            if (err?.code !== 'IS_BINARY') {
              out.push({ path: e.path, type: 'file', binary: true, note: err?.code || 'unreadable' });
              continue;
            }
            const size = e.size || 0;
            if (size > MAX_BACKUP_FILE_BYTES || binaryBytes + size > MAX_BACKUP_BINARY_TOTAL) {
              out.push({ path: e.path, type: 'file', binary: true, skipped: 'too large for backup', sizeBytes: size, mime: e.mime });
              continue;
            }
            try {
              const blob = await backend.shopFiles.downloadBlob(storeId, e.path);
              binaryBytes += blob.size;
              out.push({
                path: e.path, type: 'file', binary: true,
                data: await blobToDataUrl(blob), mime: e.mime, sizeBytes: blob.size,
              });
            } catch (bErr) {
              out.push({ path: e.path, type: 'file', binary: true, note: bErr?.message || 'unreadable' });
            }
          }
        }
      }
    };
    await walk('/');
  };
  try {
    const stores = await backend.pos.listStores();
    for (const s of stores) {
      const entry = { storeId: s.id, storeName: s.name, files: [] };
      try {
        await walkShop(s.id, entry.files);
      } catch (err) {
        entry.__exportError = err?.message || String(err);
      }
      shopFiles.push(entry);
    }
  } catch (err) {
    shopFiles.push({ storeId: null, storeName: null, files: [], __exportError: err?.message || String(err) });
  }

  // Support tickets + feedback (cloud only; the user's own rows).
  let support = null;
  try {
    const [tickets, feedback] = await Promise.all([
      backend.support?.exportMine ? backend.support.exportMine() : [],
      backend.feedback?.exportMine ? backend.feedback.exportMine() : [],
    ]);
    support = { tickets, feedback };
  } catch {
    support = null;
  }

  return {
    exportedAt: new Date().toISOString(),
    version: '2.2.0',
    kind: 'drift-backup',
    settings: await backend.settings.get(),
    profile: backend.profile?.get ? await backend.profile.get().catch(() => null) : null,
    spaces,
    files,
    pins,
    helmThreads: threadsWithMessages,
    highscores: backend.highscores?.exportAll ? await backend.highscores.exportAll().catch(() => []) : [],
    notifications: backend.notifications?.exportAll ? await backend.notifications.exportAll().catch(() => []) : [],
    posStores,
    shopFiles,
    support,
  };
}

/** Trigger a download of a backup dump (same code path as the manual Settings button). */
export function downloadBackupFile(dump, filename) {
  const blob = new Blob([JSON.stringify(dump, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename || `drift-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
}
