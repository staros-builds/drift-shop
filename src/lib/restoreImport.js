/**
 * RESTORE IMPORT — phase 2 of the owner restore flow.
 *
 * Phase 1 (Admin → Danger zone) validated the backup, saved a fresh
 * backup of the then-current state, wiped via the SAME factory_reset()
 * path as the factory reset, and signed the user out. Phase 2 — this
 * module — puts the backup's contents into the fresh install.
 *
 * Everything here is idempotent: sections either upsert (files, spaces,
 * store tables), dedupe by ID (stores, highscores, notifications,
 * support), or are skipped when they already exist (pins, conversations),
 * so running the same file twice never doubles the shop.
 *
 * runBackupRestore(data, { backend }) accepts an injected backend so the
 * whole orchestration can be dry-run against a fixture without a live
 * database (tests/backup-restore.test.mjs). Returns a structured report;
 * the UI turns it into plain words.
 */

import { dataUrlToBlob } from './backupRestore.js';

export async function runBackupRestore(data, { backend } = {}) {
  if (!backend) throw new Error('runBackupRestore needs a backend');
  const report = {
    settings: false,
    profileNote: null,
    filesRestored: 0,
    filesSkipped: [],
    shopFilesRestored: 0,
    shopFilesSkipped: [],
    pinsRestored: 0,
    pinsSkippedAsExisting: 0,
    threadsRestored: 0,
    threadsSkippedAsExisting: 0,
    spacesRestored: 0,
    highscoresRestored: 0,
    notificationsRestored: 0,
    posReports: [],
    supportReport: { tickets: null, feedback: null },
    errors: [],
  };

  // Settings first: a bad settings object aborts before anything else.
  if (data?.settings && typeof data.settings === 'object' && backend.settings?.update) {
    await backend.settings.update(data.settings);
    report.settings = true;
  }

  // Profile: display identity only (never roles or lock state).
  if (data?.profile && typeof data.profile === 'object' && backend.profile?.update) {
    try {
      const patch = {};
      if (data.profile.username !== undefined) patch.username = data.profile.username;
      if (data.profile.displayName !== undefined) patch.displayName = data.profile.displayName;
      if (data.profile.avatarUrl !== undefined) patch.avatarUrl = data.profile.avatarUrl;
      const res = await backend.profile.update(patch);
      if (res?.usernameConflict) {
        report.profileNote = 'username-taken';
      }
    } catch (err) {
      report.profileNote = err?.message || String(err);
    }
  }

  // POS stores FIRST: shop files and everything else hang off the store
  // IDs, which the store import preserves.
  for (const dump of Array.isArray(data?.posStores) ? data.posStores : []) {
    if (!dump || typeof dump !== 'object' || dump.__exportError) {
      report.posReports.push({ name: dump?.store?.name || 'Shop', error: dump?.__exportError || 'bad dump' });
      continue;
    }
    try {
      const r = await backend.pos.importStore(dump);
      report.posReports.push({ name: dump.store?.name || 'Shop', ...r });
      // Device-local printer prefs ride along with the store dump.
      if (dump.printer && typeof dump.printer === 'object' && r?.storeId) {
        try {
          const { savePrinterConfig } = await import('./pos-print/index.js');
          savePrinterConfig(r.storeId, dump.printer);
        } catch {
          /* best effort — printer prefs are per-device niceties */
        }
      }
    } catch (err) {
      report.posReports.push({ name: dump.store?.name || 'Shop', error: err?.message || String(err) });
    }
  }

  // Shop files (shared per store): upload what the backup embedded.
  // Runs after the stores so the store IDs in the backup resolve.
  for (const entry of Array.isArray(data?.shopFiles) ? data.shopFiles : []) {
    const storeId = entry?.storeId;
    if (!storeId || entry.__exportError) continue;
    for (const f of Array.isArray(entry.files) ? entry.files : []) {
      try {
        if (f.type === 'folder') {
          await backend.shopFiles.mkdir(storeId, f.path);
        } else if (typeof f.text === 'string') {
          await backend.shopFiles.write(storeId, f.path, f.text);
          report.shopFilesRestored++;
        } else if (f.binary && typeof f.data === 'string') {
          await backend.shopFiles.upload(storeId, f.path, dataUrlToBlob(f.data));
          report.shopFilesRestored++;
        } else {
          report.shopFilesSkipped.push({ path: f.path, reason: f.skipped || f.note || 'binary not embedded in backup' });
        }
      } catch (err) {
        report.shopFilesSkipped.push({ path: f.path, reason: err?.message || String(err) });
      }
    }
  }

  // Personal files: write/upload upsert by name, so a re-run is safe.
  for (const f of Array.isArray(data?.files) ? data.files : []) {
    try {
      if (f.type === 'folder') {
        await backend.files.mkdir(f.path);
      } else if (typeof f.text === 'string') {
        await backend.files.write(f.path, f.text);
        report.filesRestored++;
      } else if (f.binary && typeof f.data === 'string') {
        await backend.files.upload(f.path, dataUrlToBlob(f.data));
        report.filesRestored++;
      } else {
        // Bytes never made it into the backup (too large / unreadable
        // at export): recreate the parent folder so the structure
        // survives, and report the loss plainly.
        try {
          const parent = f.path.slice(0, f.path.lastIndexOf('/')) || '/';
          if (parent !== '/' && f.path) await backend.files.mkdir(parent);
        } catch {
          /* best effort — the skip report matters */
        }
        report.filesSkipped.push({ path: f.path, reason: f.skipped || f.note || 'binary not embedded in backup' });
      }
    } catch (err) {
      report.filesSkipped.push({ path: f.path, reason: err?.message || String(err) });
    }
  }

  // Pins: skipped wholesale when pins already exist — re-creating would
  // double them (pins carry no stable backup ID to dedupe on).
  try {
    const existingPins = await backend.pins.list({});
    const pins = Array.isArray(data?.pins) ? data.pins : [];
    if (existingPins.length > 0 && pins.length > 0) {
      report.pinsSkippedAsExisting = pins.length;
    } else {
      for (const p of pins) {
        const isFile = p.kind === 'file' || p.kind === 'image';
        try {
          await backend.pins.create({
            kind: p.kind || 'text',
            title: p.title,
            body: isFile ? undefined : p.body,
            url: p.url,
            tags: Array.isArray(p.tags) ? p.tags : [],
            sourceApp: p.sourceApp,
            dataUrl: isFile ? p.dataUrl || p.body : undefined,
            mime: p.mime,
            sizeBytes: p.sizeBytes,
          });
          report.pinsRestored++;
        } catch (err) {
          report.errors.push(`pin: ${err?.message || err}`);
        }
      }
    }
  } catch (err) {
    report.errors.push(`pins: ${err?.message || err}`);
  }

  // Helm conversations: same no-doubling rule as pins.
  try {
    const existingThreads = await backend.helm.threads();
    const threads = Array.isArray(data?.helmThreads) ? data.helmThreads : [];
    if (existingThreads.length > 0 && threads.length > 0) {
      report.threadsSkippedAsExisting = threads.length;
    } else {
      for (const t of threads) {
        const thread = await backend.helm.createThread(t.title || 'Conversation');
        for (const m of t.messages || []) {
          await backend.helm.addMessage(thread.id, {
            role: m.role,
            content: m.content,
            toolCalls: m.toolCalls,
          });
        }
        report.threadsRestored++;
      }
    }
  } catch (err) {
    report.errors.push(`threads: ${err?.message || err}`);
  }

  // Spaces: replaceAll swaps the whole layout set idempotently.
  if (Array.isArray(data?.spaces) && data.spaces.length > 0 && backend.spaces?.replaceAll) {
    try {
      const restored = await backend.spaces.replaceAll(data.spaces);
      report.spacesRestored = Array.isArray(restored) ? restored.length : 0;
    } catch (err) {
      report.errors.push(`spaces: ${err?.message || err}`);
    }
  }

  // Highscores + notifications: merge-only by ID/value, idempotent.
  try {
    if (backend.highscores?.importAll && Array.isArray(data?.highscores)) {
      report.highscoresRestored = (await backend.highscores.importAll(data.highscores)).inserted;
    }
  } catch (err) {
    report.errors.push(`highscores: ${err?.message || err}`);
  }
  try {
    if (backend.notifications?.importAll && Array.isArray(data?.notifications)) {
      report.notificationsRestored = (await backend.notifications.importAll(data.notifications)).inserted;
    }
  } catch (err) {
    report.errors.push(`notifications: ${err?.message || err}`);
  }

  // Support tickets + feedback (the user's own rows).
  if (data?.support && typeof data.support === 'object') {
    try {
      if (backend.support?.importMine) {
        report.supportReport.tickets = await backend.support.importMine(data.support.tickets);
      }
    } catch (err) {
      report.supportReport.tickets = { error: err?.message || String(err) };
    }
    try {
      if (backend.feedback?.importMine) {
        report.supportReport.feedback = await backend.feedback.importMine(data.support.feedback);
      }
    } catch (err) {
      report.supportReport.feedback = { error: err?.message || String(err) };
    }
  }

  return report;
}
