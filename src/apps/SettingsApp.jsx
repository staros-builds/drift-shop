import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Download, Upload, Sun, Moon, MonitorSmartphone, Check, HardDrive, RefreshCw, Maximize, Trash2, LayoutGrid, ArrowUp, ArrowDown, ArrowLeft, ArrowRight } from 'lucide-react';
import { backend } from '../lib/backend/current.js';
import { getPrinterConfig, savePrinterConfig } from '../lib/pos-print/index.js';
import { useSettings } from '../os/SettingsContext.jsx';
import { useNotifications } from '../os/NotificationsContext.jsx';
import { useAuth } from '../os/AuthContext.jsx';
import { useLang } from '../lib/i18n.jsx';
import { appTitle } from '../lib/appTitle.js';
import { ConfirmDialog } from '../components/os/dialogs.jsx';
import { isEnabled as soundOn, setEnabled as setSoundOn, playSound, getVolume, setVolume } from '../lib/sound.js';
import { listLaunchableApps } from './registry.jsx';
// NOTE: do not import APPS here — registry.jsx imports SettingsApp, so this
// module evaluates while the registry is still initializing and reading APPS
// throws "Cannot access before initialization", blanking the whole boot.
import { ensureWebApps, useWebApps, uninstallWebApp } from '../lib/webapps.js';
import {
  hasInstallPrompt,
  installInstructions,
  isInstalled,
  isOfflineReady,
  promptInstall,
  registerServiceWorker,
} from '../lib/pwa.js';

const THEME_MODES_UI = [
  { id: 'light', labelKey: 'settings.themeModes.light', icon: Sun },
  { id: 'dark', labelKey: 'settings.themeModes.dark', icon: Moon },
  { id: 'system', labelKey: 'settings.themeModes.system', icon: MonitorSmartphone },
];

const ACCENTS = [
  { id: 'default', labelKey: 'settings.accents.default', value: null },
  { id: 'amber', labelKey: 'settings.accents.amber', value: '#D97706' },
  { id: 'sage', labelKey: 'settings.accents.sage', value: '#5F7161' },
  { id: 'slate', labelKey: 'settings.accents.slate', value: '#475569' },
  { id: 'plum', labelKey: 'settings.accents.plum', value: '#7C3AED' },
];

const WALLPAPERS = [
  { id: 'paper-grain', labelKey: 'settings.wallpapers.paperGrain', preview: 'repeating-linear-gradient(45deg,#f3efe7,#f3efe7 6px,#ece7db 6px,#ece7db 7px)' },
  { id: 'linen', labelKey: 'settings.wallpapers.linen', preview: 'repeating-linear-gradient(0deg,#efece4,#efece4 3px,#e8e4d9 3px,#e8e4d9 4px)' },
  { id: 'dusk', labelKey: 'settings.wallpapers.dusk', preview: 'linear-gradient(135deg,#1e2430,#2b3242)' },
  { id: 'plain', labelKey: 'settings.wallpapers.plain', preview: '#f6f3ec' },
  { id: 'img-dawn', labelKey: 'settings.wallpapers.persimmonDawn', preview: "url('/wallpapers/drift-dawn.jpg') center/cover" },
  { id: 'img-ink', labelKey: 'settings.wallpapers.inkDrift', preview: "url('/wallpapers/drift-ink.jpg') center/cover" },
  { id: 'img-garden', labelKey: 'settings.wallpapers.paperGarden', preview: "url('/wallpapers/drift-garden.jpg') center/cover" },
  { id: 'img-harbor', labelKey: 'settings.wallpapers.duskHarbor', preview: "url('/wallpapers/drift-harbor.jpg') center/cover" },
];

const UI_SCALES = [90, 100, 110, 125, 150];

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export default function SettingsApp({ windowApi }) {
  const { push } = useNotifications();
  const { settings, updateSettings, themeMode, setThemeMode } = useSettings();
  const { user } = useAuth();
  const { lang, setLang, t } = useLang();
  const [storageBytes, setStorageBytes] = useState(null);
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [erasing, setErasing] = useState(false);
  const [confirmErase, setConfirmErase] = useState(false);
  const [soundTick, setSoundTick] = useState(0); // re-render the sound toggle
  void soundTick;
  const [volume, setVolumeState] = useState(() => getVolume());
  const flipSound = () => {
    setSoundOn(!soundOn());
    setSoundTick((t) => t + 1);
    playSound('click');
  };
  const changeVolume = (v) => {
    setVolume(v);
    setVolumeState(getVolume());
    playSound('click');
  };
  const [pendingImport, setPendingImport] = useState(null); // parsed backup awaiting replace-confirm
  const [isFullscreen, setIsFullscreen] = useState(false);
  const fileInputRef = useRef(null);

  // Download & offline (PWA install + service worker status)
  const [installState, setInstallState] = useState('unknown'); // unknown|installed|prompt|manual
  const [showInstallHelp, setShowInstallHelp] = useState(false);
  const [offlineReady, setOfflineReady] = useState(() => isOfflineReady());
  const [swUpdate, setSwUpdate] = useState(false);

  const refreshInstallState = useCallback(() => {
    if (isInstalled()) setInstallState('installed');
    else if (hasInstallPrompt()) setInstallState('prompt');
    else setInstallState('manual');
  }, []);

  useEffect(() => {
    refreshInstallState();
    setOfflineReady(isOfflineReady());
    const onAvail = () => {
      refreshInstallState();
    };
    const onChanged = () => {
      refreshInstallState();
    };
    window.addEventListener('drift:install-available', onAvail);
    window.addEventListener('drift:install-changed', onChanged);
    // Service worker: mark offline-ready once it controls the page, and
    // flag when a newer build is waiting behind this one.
    let cancelled = false;
    registerServiceWorker().then((reg) => {
      if (cancelled || !reg) return;
      const checkWaiting = () => {
        if (reg.waiting) setSwUpdate(true);
        setOfflineReady(isOfflineReady());
      };
      checkWaiting();
      reg.addEventListener('updatefound', checkWaiting);
      const onController = () => setOfflineReady(isOfflineReady());
      window.navigator.serviceWorker?.addEventListener('controllerchange', onController);
    });
    const t = setInterval(() => setOfflineReady(isOfflineReady()), 5000);
    return () => {
      cancelled = true;
      window.removeEventListener('drift:install-available', onAvail);
      window.removeEventListener('drift:install-changed', onChanged);
      clearInterval(t);
    };
  }, [refreshInstallState]);

  const handleInstall = async () => {
    const accepted = await promptInstall();
    if (!accepted) setShowInstallHelp(true);
    refreshInstallState();
  };

  // Installed web apps feed the Apps manager; re-renders when installs change.
  const installedIds = useWebApps();
  useEffect(() => {
    ensureWebApps(user?.id);
  }, [user?.id]);
  const manageableApps = useMemo(() => listLaunchableApps(), [installedIds]);
  const manageableIds = useMemo(
    () => manageableApps.filter((a) => !a.comingSoon && a.component).map((a) => a.id),
    [manageableApps]
  );
  const comingSoonApps = useMemo(() => manageableApps.filter((a) => a.comingSoon), [manageableApps]);

  useEffect(() => {
    windowApi?.setTitle?.('Settings');
  }, [windowApi]);

  // Fullscreen toggle state, synced via 'fullscreenchange' so the user
  // exiting with Esc (or any other path) is reflected in the UI.
  useEffect(() => {
    const onChange = () => setIsFullscreen(!!document.fullscreenElement);
    onChange();
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const toggleFullscreen = async () => {
    try {
      if (!document.documentElement.requestFullscreen) {
        throw new Error('Fullscreen is not supported in this browser.');
      }
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        await document.documentElement.requestFullscreen();
      }
    } catch (err) {
      push('Error', `Could not toggle fullscreen: ${err?.message || err}`);
    }
  };

  // Real byte computation: text lengths of all files + pin body lengths.
  const computeStorage = useCallback(async () => {
    const enc = new TextEncoder();
    const sizeOf = (s) => enc.encode(s || '').length;
    let total = 0;
    try {
      const walk = async (path) => {
        const entries = await backend.files.list(path);
        for (const e of entries) {
          if (e.type === 'folder') {
            await walk(e.path);
          } else {
            try {
              const { text } = await backend.files.read(e.path);
              total += sizeOf(text);
            } catch {
              total += e.size || 0; // binary: fall back to recorded size
            }
          }
        }
      };
      await walk('/');
      const pins = await backend.pins.list({});
      total += pins.reduce((sum, p) => sum + sizeOf(p.body), 0);
    } catch (err) {
      push('Error', `Could not compute storage: ${err?.message || err}`);
      return;
    }
    setStorageBytes(total);
  }, [push]);

  useEffect(() => { computeStorage(); }, [computeStorage]);

  const pickTheme = async (id) => {
    try {
      await setThemeMode(id);
    } catch (err) {
      push('Error', `Could not change theme: ${err?.message || err}`);
    }
  };

  const pickAccent = async (accent) => {
    try {
      await updateSettings({ accent_override: accent.value });
    } catch (err) {
      push('Error', `Could not change accent: ${err?.message || err}`);
    }
  };

  const pickWallpaper = async (id) => {
    try {
      await updateSettings({ wallpaper: id });
    } catch (err) {
      push('Error', `Could not change wallpaper: ${err?.message || err}`);
    }
  };

  const pickEngine = async (engine) => {
    try {
      await updateSettings({ ai_engine: engine });
    } catch (err) {
      push('Error', `Could not change Helm engine: ${err?.message || err}`);
    }
  };

  const pickScale = async (scale) => {
    try {
      await updateSettings({ ui_scale: scale });
    } catch (err) {
      push('Error', `Could not change interface scale: ${err?.message || err}`);
    }
  };

  const toggleTouchMode = async () => {
    try {
      await updateSettings({ touch_mode: !settings?.touch_mode });
    } catch (err) {
      push('Error', `Could not change touch mode: ${err?.message || err}`);
    }
  };

  const shownIconIds = settings?.desktop_icons ?? manageableIds;
  const toggleDesktopIcon = async (appId) => {
    const next = shownIconIds.includes(appId)
      ? shownIconIds.filter((id) => id !== appId)
      : [...shownIconIds, appId];
    try {
      await updateSettings({ desktop_icons: next });
    } catch (err) {
      push('Error', `Could not update desktop icons: ${err?.message || err}`);
    }
  };
  const setAllDesktopIcons = async (on) => {
    try {
      await updateSettings({ desktop_icons: on ? manageableIds : [] });
    } catch (err) {
      push('Error', `Could not update desktop icons: ${err?.message || err}`);
    }
  };

  const hiddenFromStart = settings?.hidden_from_start ?? [];
  const toggleStartMenu = async (appId) => {
    const next = hiddenFromStart.includes(appId)
      ? hiddenFromStart.filter((id) => id !== appId)
      : [...hiddenFromStart, appId];
    try {
      await updateSettings({ hidden_from_start: next });
    } catch (err) {
      push('Error', `Could not update Start menu apps: ${err?.message || err}`);
    }
  };

  const uninstallApp = async (app) => {
    const shortId = app.id.replace(/^webapp:/, '');
    try {
      await uninstallWebApp(shortId, user?.id);
      // Scrub the removed id out of the visibility/order settings.
      const clean = (arr) => (arr ?? []).filter((id) => id !== app.id);
      await updateSettings({
        desktop_icons: settings?.desktop_icons ? clean(settings.desktop_icons) : null,
        hidden_from_start: clean(settings?.hidden_from_start),
        desktop_icon_order: clean(settings?.desktop_icon_order),
      });
      push('Uninstalled', `${app.title} was removed from your apps.`);
    } catch (err) {
      push('Error', `Could not uninstall: ${err?.message || err}`);
    }
  };

  const pickTaskbarPosition = async (pos) => {
    try {
      await updateSettings({ taskbar_position: pos });
    } catch (err) {
      push('Error', `Could not move taskbar: ${err?.message || err}`);
    }
  };

  const pickUiStyle = async (style) => {
    try {
      await updateSettings({ ui_style: style });
    } catch (err) {
      push('Error', `Could not change interface style: ${err?.message || err}`);
    }
  };

  // ---- whole-account backup (v2.1.0) ---------------------------------------
  // Binary files ride along as data URLs so a restore is byte-identical.
  // Caps keep one huge video from blowing up the backup: files over 25 MB
  // each (or 200 MB of binaries total) are recorded as skipped, never fatal.
  const MAX_BACKUP_FILE_BYTES = 25 * 1024 * 1024;
  const MAX_BACKUP_BINARY_TOTAL = 200 * 1024 * 1024;

  // FileReader-free data URL encoding: arrayBuffer + chunked btoa works on
  // native Blobs everywhere (FileReader has interop quirks with non-DOM
  // Blob implementations in some runtimes).
  const blobToDataUrl = async (blob) => {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let bin = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return `data:${blob.type || 'application/octet-stream'};base64,${btoa(bin)}`;
  };

  const dataUrlToBlob = (dataUrl) => {
    const comma = dataUrl.indexOf(',');
    const head = comma >= 0 ? dataUrl.slice(0, comma) : '';
    const b64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
    const mime = /data:(.*?);base64/.exec(head)?.[1] || 'application/octet-stream';
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  };

  const exportData = async () => {
    setExporting(true);
    try {
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

      const data = {
        exportedAt: new Date().toISOString(),
        version: '2.1.0',
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
        support,
      };

      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `drift-backup-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      push(t('settings.sections.backupComplete'), t('settings.sections.backupCompleteBody'));
    } catch (err) {
      push('Error', `Could not export data: ${err?.message || err}`);
    } finally {
      setExporting(false);
    }
  };

  const hasExistingData = async () => {
    const [root, pins, threads] = await Promise.all([
      backend.files.list('/'),
      backend.pins.list({}),
      backend.helm.threads(),
    ]);
    return root.length > 0 || pins.length > 0 || threads.length > 0;
  };

  // The destructive half of importData: wipes the current tree and restores
  // the parsed backup. Throws on failure so both entry points report the
  // same way.
  const runImport = async (data) => {
    const report = {
      filesRestored: 0, filesSkipped: [],
      pinsRestored: 0, pinErrors: 0,
      spacesRestored: 0, profileNote: null,
      highscoresRestored: 0, notificationsRestored: 0,
    };

    // Settings first: an invalid settings object aborts before any wipe.
    // Applied through the context so the live UI updates too.
    await updateSettings(data.settings);

    // Profile: display identity only (never roles/paid/lock state).
    if (data.profile && typeof data.profile === 'object' && backend.profile?.update) {
      try {
        const patch = {};
        if (data.profile.username !== undefined) patch.username = data.profile.username;
        if (data.profile.displayName !== undefined) patch.displayName = data.profile.displayName;
        if (data.profile.avatarUrl !== undefined) patch.avatarUrl = data.profile.avatarUrl;
        const res = await backend.profile.update(patch);
        if (res?.usernameConflict) {
          report.profileNote = `username "${data.profile.username}" was taken — profile restored with your current username`;
        }
      } catch (err) {
        report.profileNote = `profile not restored (${err?.message || err})`;
      }
    }

    // Files: wipe the current tree, then restore parent-first (export order).
    // Text restores inline; embedded binaries re-upload byte-identical;
    // skipped binaries are reported, never fatal.
    const rootEntries = await backend.files.list('/');
    for (const e of rootEntries) await backend.files.remove(e.path);
    for (const f of data.files) {
      try {
        if (f.type === 'folder') {
          await backend.files.mkdir(f.path); // idempotent — safe if a parent was auto-created
        } else if (typeof f.text === 'string') {
          await backend.files.write(f.path, f.text);
          report.filesRestored++;
        } else if (f.binary && typeof f.data === 'string') {
          await backend.files.upload(f.path, dataUrlToBlob(f.data));
          report.filesRestored++;
        } else {
          // Skipped (too large / not embedded): the bytes can't be restored,
          // but the parent folder is still created so the tree structure
          // survives the round trip. The summary tells the user what was lost.
          try {
            const parent = f.path.slice(0, f.path.lastIndexOf('/')) || '/';
            if (parent !== '/' && f.path) await backend.files.mkdir(parent);
          } catch { /* best effort — the skip report matters, not the folder */ }
          report.filesSkipped.push({ path: f.path, reason: f.skipped || f.note || 'binary not embedded in backup' });
        }
      } catch (err) {
        report.filesSkipped.push({ path: f.path, reason: err?.message || String(err) });
      }
    }

    // Pins: wipe, then re-create (ids are regenerated). File/image pins
    // carry their bytes as dataUrl — without it create() would throw.
    const oldPins = await backend.pins.list({});
    for (const p of oldPins) await backend.pins.remove(p.id);
    for (const p of data.pins) {
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
        report.pinErrors++;
      }
    }

    // Helm threads: wipe, then re-create with their messages in order
    // (user/assistant/tool roles and toolCalls preserved).
    const oldThreads = await backend.helm.threads();
    for (const t of oldThreads) await backend.helm.removeThread(t.id);
    for (const t of data.helmThreads) {
      const thread = await backend.helm.createThread(t.title || 'Conversation');
      for (const m of t.messages || []) {
        await backend.helm.addMessage(thread.id, {
          role: m.role,
          content: m.content,
          toolCalls: m.toolCalls,
        });
      }
    }

    // Spaces: replace the whole set in one shot (names, wallpaper, accent,
    // icon, window layouts). replaceAll never trips the starter-space
    // reseed, so a backup containing Main/Focus/Play restores cleanly.
    if (Array.isArray(data.spaces) && data.spaces.length > 0) {
      if (backend.spaces.replaceAll) {
        const restored = await backend.spaces.replaceAll(data.spaces);
        report.spacesRestored = restored.length;
      } else {
        report.profileNote = (report.profileNote ? report.profileNote + '; ' : '') +
          'spaces not restored (backend too old)';
      }
    }

    // Highscores + notifications: merge-only (never wipe), idempotent.
    try {
      if (backend.highscores?.importAll && Array.isArray(data.highscores)) {
        report.highscoresRestored = (await backend.highscores.importAll(data.highscores)).inserted;
      }
    } catch { /* non-fatal */ }
    try {
      if (backend.notifications?.importAll && Array.isArray(data.notifications)) {
        report.notificationsRestored = (await backend.notifications.importAll(data.notifications)).inserted;
      }
    } catch { /* non-fatal */ }

    // POS stores + support: merge-only restores (never wipe). Each store
    // dump is imported by ID — missing rows are added, existing rows are
    // left untouched. Returns a per-store report for the summary.
    const posReports = [];
    for (const dump of Array.isArray(data.posStores) ? data.posStores : []) {
      if (!dump || typeof dump !== 'object' || dump.__exportError) {
        posReports.push({ name: dump?.store?.name || 'store', error: dump?.__exportError || 'bad dump' });
        continue;
      }
      try {
        const r = await backend.pos.importStore(dump);
        posReports.push({ name: dump.store?.name || 'store', ...r });
        // Restore the device-local printer prefs the backup carried.
        if (dump.printer && typeof dump.printer === 'object' && r.storeId) {
          try { savePrinterConfig(r.storeId, dump.printer); } catch { /* best effort */ }
        }
      } catch (err) {
        posReports.push({ name: dump.store?.name || 'store', error: err?.message || String(err) });
      }
    }
    const supportReport = { tickets: null, feedback: null };
    if (data.support && typeof data.support === 'object') {
      try {
        if (backend.support?.importMine) {
          supportReport.tickets = await backend.support.importMine(data.support.tickets);
        }
      } catch (err) {
        supportReport.tickets = { error: err?.message || String(err) };
      }
      try {
        if (backend.feedback?.importMine) {
          supportReport.feedback = await backend.feedback.importMine(data.support.feedback);
        }
      } catch (err) {
        supportReport.feedback = { error: err?.message || String(err) };
      }
    }
    return { posReports, supportReport, ...report };
  };

  // Human-readable summary of a restore: the replace-half counts plus the
  // merge-half (POS stores + support) report.

  // Human-readable summary of a restore: the replace-half counts plus the
  // merge-half (POS stores + support) report.
  const summarizeRestore = ({ posReports = [], supportReport = {}, filesRestored = 0, filesSkipped = [],
      pinsRestored = 0, pinErrors = 0, spacesRestored = 0, profileNote = null,
      highscoresRestored = 0, notificationsRestored = 0 } = {}) => {
    const parts = [];
    parts.push(`${filesRestored} file${filesRestored === 1 ? '' : 's'} restored`);
    if (filesSkipped.length > 0) parts.push(`${filesSkipped.length} file${filesSkipped.length === 1 ? '' : 's'} skipped (${filesSkipped[0].reason})`);
    parts.push(`${pinsRestored} pin${pinsRestored === 1 ? '' : 's'} restored`);
    if (pinErrors > 0) parts.push(`${pinErrors} pin${pinErrors === 1 ? '' : 's'} could not be restored`);
    if (spacesRestored > 0) parts.push(`${spacesRestored} space${spacesRestored === 1 ? '' : 's'} restored with layouts`);
    if (profileNote) parts.push(profileNote);
    if (highscoresRestored > 0) parts.push(`${highscoresRestored} highscore${highscoresRestored === 1 ? '' : 's'} restored`);
    if (notificationsRestored > 0) parts.push(`${notificationsRestored} notification${notificationsRestored === 1 ? '' : 's'} restored`);
    for (const r of posReports) {
      if (r.error) {
        parts.push(`${r.name}: restore failed (${r.error})`);
        continue;
      }
      const n = Object.values(r.inserted || {}).reduce((a, b) => a + b, 0);
      const label = r.store === 'created' ? 'new store restored' : 'merged';
      parts.push(n > 0 ? `${r.name}: ${label}, ${n} record${n === 1 ? '' : 's'} added` : `${r.name}: already up to date`);
      // Surface per-table partial failures so a half-restored table can't
      // pass silently (e.g. gift cards failed but sales succeeded).
      for (const [t, msg] of Object.entries(r.errors || {})) {
        if (msg) parts.push(`${r.name}: ${t} had errors (${msg})`);
      }
    }
    const t = supportReport.tickets;
    if (t && !t.error && t.inserted) parts.push(`${t.inserted} support request${t.inserted === 1 ? '' : 's'} restored`);
    const f = supportReport.feedback;
    if (f && !f.error && f.inserted) parts.push(`${f.inserted} feedback note${f.inserted === 1 ? '' : 's'} restored`);
    for (const [k, v] of [['tickets', t], ['feedback', f]]) {
      if (v && v.error) parts.push(`${k} restore failed (${v.error})`);
    }
    return parts.length ? parts.join('. ') + '.' : 'No store or support data in this backup.';
  };

  // Continuation for the import replace gate: runs when the user confirms
  // the in-app dialog.
  const confirmImport = () => {
    const data = pendingImport?.data;
    setPendingImport(null);
    if (!data) return;
    setImporting(true);
    runImport(data)
      .then(async (summary) => {
        push(t('settings.sections.importComplete'), t('settings.sections.importCompleteBody') + summarizeRestore(summary));
        await computeStorage();
      })
      .catch((err) => push('Error', `Could not import data: ${err?.message || err}`))
      .finally(() => setImporting(false));
  };

  // S1: restore a drift-backup-<date>.json backup produced by exportData.
  // Export shape (v2.1.0): { exportedAt, version, kind: 'drift-backup',
  //   settings, profile: { username, displayName, avatarUrl } | null,
  //   spaces: [{ name, icon, wallpaper, accent, windowStates: [...] }],
  //   files: [{path,type:'folder'} | {path,type:'file',text}
  //          | {path,type:'file',binary:true,data,mime,sizeBytes}
  //          | {path,type:'file',binary:true,skipped|note}],
  //   pins: [...] (file/image pins carry dataUrl),
  //   helmThreads: [{...thread, messages: [...]}],
  //   highscores: [...], notifications: [...] (merge-only),
  //   posStores: [store dumps from backend.pos.exportStore] (v2+),
  //   support: { tickets: [...], feedback: [...] } (v2+, cloud only) }
  // v2.0.0 backups (no profile/highscores/notifications, binaries as stubs)
  // and v1 backups (version '0.1.0', no posStores/support) still restore.
  const importData = async (file) => {
    if (!file) return;
    setImporting(true);
    try {
      let data;
      try {
        data = JSON.parse(await file.text());
      } catch {
        throw new Error('That file is not valid JSON.');
      }
      const valid =
        data && typeof data === 'object' &&
        Array.isArray(data.files) &&
        Array.isArray(data.pins) &&
        Array.isArray(data.helmThreads) &&
        Array.isArray(data.spaces) &&
        data.settings && typeof data.settings === 'object' &&
        (data.profile === undefined || (data.profile && typeof data.profile === 'object')) &&
        (data.highscores === undefined || Array.isArray(data.highscores)) &&
        (data.notifications === undefined || Array.isArray(data.notifications)) &&
        (data.posStores === undefined || Array.isArray(data.posStores)) &&
        (data.support === undefined || (data.support && typeof data.support === 'object'));
      if (!valid) {
        throw new Error('Not a LFDD backup file — expected settings, spaces, files, pins, and helmThreads.');
      }

      if (await hasExistingData()) {
        // Replacing live data is gated on an in-app confirmation (never
        // window.confirm()): the parsed backup waits in pendingImport and
        // the import resumes when the user confirms.
        setImporting(false);
        setPendingImport({ data });
        return;
      }

      const summary = await runImport(data);

      push(t('settings.sections.importComplete'), t('settings.sections.importCompleteBody') + summarizeRestore(summary));
    } catch (err) {
      push('Error', `Could not import data: ${err?.message || err}`);
    } finally {
      setImporting(false);
    }
  };

  // S2: wipe everything, gated on a single explicit danger dialog.
  // Resetting settings to defaults also clears welcome_seen, so the welcome
  // guide replays once — a full wipe is a fresh start.
  const eraseAllData = async () => {
    setErasing(true);
    try {
      const rootEntries = await backend.files.list('/');
      for (const e of rootEntries) await backend.files.remove(e.path);
      const pins = await backend.pins.list({});
      for (const p of pins) await backend.pins.remove(p.id);
      const threads = await backend.helm.threads();
      for (const t of threads) await backend.helm.removeThread(t.id);
      const spaces = await backend.spaces.list();
      for (const s of spaces) await backend.spaces.remove(s.id);
      await updateSettings({
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
      });
      try {
        window.localStorage.removeItem('drift:welcome_tour_seen');
      } catch { /* ignore */ }
      push('Data erased', 'All LFDD data was permanently deleted.');
      setStorageBytes(0);
    } catch (err) {
      push('Error', `Could not erase data: ${err?.message || err}`);
    } finally {
      setErasing(false);
    }
  };

  return (
    <div className="h-full overflow-y-auto bg-paper text-ink">
      <div className="mx-auto max-w-xl p-5">
        {/* Language */}
        <section className="mb-8">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted">{t('settings.language')}</h2>
          <p className="mb-2 text-xs text-muted">{t('settings.languageHint')}</p>
          <div className="grid grid-cols-2 gap-2">
            {[
              { id: 'fr', label: t('lang.french') },
              { id: 'en', label: t('lang.english') },
            ].map((l) => {
              const active = lang === l.id;
              return (
                <button
                  key={l.id}
                  type="button"
                  onClick={() => setLang(l.id)}
                  className={`flex items-center justify-center gap-2 rounded-os border px-3 py-2.5 text-sm transition-colors duration-160 ${
                    active ? 'border-accent bg-surface shadow-os' : 'border-osborder hover:bg-surface'
                  }`}
                >
                  <span className={`font-medium ${active ? 'text-accent' : 'text-ink'}`}>{l.label}</span>
                  {active && <Check size={12} className="text-accent" />}
                </button>
              );
            })}
          </div>
        </section>

        {/* Appearance */}
        <section className="mb-8">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted">{t('settings.sections.appearance')}</h2>

          <p className="mb-2 text-sm font-medium">{t('settings.fields.theme')}</p>
          <div className="mb-2 flex gap-2">
            {THEME_MODES_UI.map((mode) => {
              const Icon = mode.icon;
              const active = themeMode === mode.id;
              return (
                <button
                  key={mode.id}
                  onClick={() => pickTheme(mode.id)}
                  className={`flex flex-1 items-center justify-center gap-2 rounded-os border px-3 py-2.5 text-sm transition-colors duration-160 ${
                    active ? 'border-accent bg-surface shadow-os' : 'border-osborder hover:bg-surface'
                  }`}
                >
                  <Icon size={16} className={active ? 'text-accent' : 'text-muted'} />
                  {t(mode.labelKey)}
                  {active && <Check size={14} className="text-accent" />}
                </button>
              );
            })}
          </div>
          <p className="mb-4 text-xs text-muted">{t('settings.fields.themeSystemHint')}</p>

          <p className="mb-2 text-sm font-medium">{t('settings.fields.accentColor')}</p>
          <div className="mb-4 flex flex-wrap gap-2">
            {ACCENTS.map((a) => {
              const active = (settings?.accent_override || null) === a.value;
              return (
                <button
                  key={a.id}
                  onClick={() => pickAccent(a)}
                  title={t(a.labelKey)}
                  className={`flex items-center gap-2 rounded-os border px-3 py-1.5 text-sm transition-colors duration-160 ${
                    active ? 'border-accent shadow-os' : 'border-osborder hover:bg-surface'
                  }`}
                >
                  <span
                    className="h-4 w-4 rounded-full border border-osborder"
                    style={{ background: a.value || 'var(--os-accent, #D65F2C)' }}
                  />
                  {t(a.labelKey)}
                </button>
              );
            })}
          </div>

          <p className="mb-2 text-sm font-medium">{t('settings.fields.wallpaper')}</p>
          <div className="grid grid-cols-4 gap-2">
            {WALLPAPERS.map((w) => {
              const active = settings?.wallpaper === w.id;
              return (
                <button
                  key={w.id}
                  onClick={() => pickWallpaper(w.id)}
                  className={`overflow-hidden rounded-os border transition-colors duration-160 ${
                    active ? 'border-accent shadow-os' : 'border-osborder hover:border-accent'
                  }`}
                >
                  <div className="h-14 w-full" style={{ background: w.preview }} />
                  <div className="flex items-center justify-center gap-1 bg-surface px-1 py-1.5 text-xs">
                    {t(w.labelKey)}
                    {active && <Check size={12} className="text-accent" />}
                  </div>
                </button>
              );
            })}
          </div>

          <p className="mb-2 mt-4 text-sm font-medium">{t('settings.fields.touchMode')}</p>
          <button
            type="button"
            onClick={toggleTouchMode}
            className="flex min-h-[44px] w-full items-center gap-3 rounded-os border border-osborder px-4 py-3 text-left transition-colors duration-160 hover:bg-surface"
          >
            <span className="flex-1">
              <span className="block text-sm font-medium text-ink">{t('settings.fields.touchMode')}</span>
              <span className="block text-xs text-muted">
                {t('settings.homeScreenDesc')}
              </span>
            </span>
            <span
              className={`flex h-7 w-12 shrink-0 items-center rounded-full p-1 transition-colors duration-160 ${
                settings?.touch_mode ? 'bg-accent' : 'bg-osborder'
              }`}
            >
              <span
                className={`h-5 w-5 rounded-full bg-white shadow transition-transform duration-160 ${
                  settings?.touch_mode ? 'translate-x-5' : 'translate-x-0'
                }`}
              />
            </span>
          </button>

          <p className="mb-2 mt-4 text-sm font-medium">{t('settings.fields.interfaceSounds')}</p>
          <button
            type="button"
            onClick={flipSound}
            className="flex min-h-[44px] w-full items-center gap-3 rounded-os border border-osborder px-4 py-3 text-left transition-colors duration-160 hover:bg-surface"
          >
            <span className="flex-1">
              <span className="block text-sm font-medium text-ink">{t('settings.fields.interfaceSounds')}</span>
              <span className="block text-xs text-muted">
                {t('settings.chimesDesc')}
              </span>
            </span>
            <span
              className={`flex h-7 w-12 shrink-0 items-center rounded-full p-1 transition-colors duration-160 ${
                soundOn() ? 'bg-accent' : 'bg-osborder'
              }`}
            >
              <span
                className={`h-5 w-5 rounded-full bg-white shadow transition-transform duration-160 ${
                  soundOn() ? 'translate-x-5' : 'translate-x-0'
                }`}
              />
            </span>
          </button>
          {soundOn() && (
            <div className="mt-2 flex items-center gap-3 rounded-os border border-osborder px-4 py-3">
              <span className="text-sm font-medium text-ink">{t('settings.fields.volume')}</span>
              <input
                type="range"
                min={0}
                max={100}
                value={Math.round(volume * 100)}
                onChange={(e) => changeVolume(Number(e.target.value) / 100)}
                aria-label="Interface sound volume"
                className="h-2 flex-1 cursor-pointer appearance-none rounded-full bg-osborder accent-accent"
              />
              <span className="w-10 text-right text-sm text-muted">{Math.round(volume * 100)}%</span>
            </div>
          )}

          <p className="mb-2 mt-4 text-sm font-medium">{t('settings.fields.interfaceStyle')}</p>
          <div className="grid grid-cols-3 gap-2">
            {[
              { id: 'drift', label: 'LFDD', blurb: t('settings.fields.styleDriftBlurb') },
              { id: 'windows11', label: 'Windows 11', blurb: t('settings.fields.styleWinBlurb') },
              { id: 'macosx', label: 'Mac OS X', blurb: t('settings.fields.styleMacBlurb') },
            ].map((s) => {
              const active = (settings?.ui_style || 'drift') === s.id;
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => pickUiStyle(s.id)}
                  className={`flex flex-col items-center gap-1 rounded-os border px-3 py-2.5 text-sm transition-colors duration-160 ${
                    active ? 'border-accent bg-surface shadow-os' : 'border-osborder hover:bg-surface'
                  }`}
                >
                  <span className={`font-medium ${active ? 'text-accent' : 'text-ink'}`}>{s.label}</span>
                  <span className="text-center text-[11px] leading-tight text-muted">{s.blurb}</span>
                  {active && <Check size={12} className="text-accent" />}
                </button>
              );
            })}
          </div>

          <p className="mb-2 mt-4 text-sm font-medium">{t('settings.fields.taskbarPosition')}</p>
          <p className="mb-2 text-xs text-muted">{t('settings.fields.taskbarHint')}</p>
          <div className="grid grid-cols-4 gap-2">
            {[
              { id: 'top', label: 'Top', icon: ArrowUp },
              { id: 'bottom', label: 'Bottom', icon: ArrowDown },
              { id: 'left', label: 'Left', icon: ArrowLeft },
              { id: 'right', label: 'Right', icon: ArrowRight },
            ].map((p) => {
              const Icon = p.icon;
              const active = (settings?.taskbar_position || 'bottom') === p.id;
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => pickTaskbarPosition(p.id)}
                  className={`flex flex-col items-center gap-1 rounded-os border px-3 py-2.5 text-sm transition-colors duration-160 ${
                    active ? 'border-accent bg-surface shadow-os' : 'border-osborder hover:bg-surface'
                  }`}
                >
                  <Icon size={16} className={active ? 'text-accent' : 'text-muted'} />
                  {p.label}
                  {active && <Check size={12} className="text-accent" />}
                </button>
              );
            })}
          </div>
        </section>

        {/* Display */}
        <section className="mb-8">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted">{t('settings.sections.display')}</h2>

          <p className="mb-2 text-sm font-medium">{t('settings.fields.fullscreen')}</p>
          <div className="mb-4 flex gap-2">
            <button
              onClick={toggleFullscreen}
              className={`flex flex-1 items-center justify-center gap-2 rounded-os border px-3 py-2.5 text-sm transition-colors duration-160 ${
                isFullscreen ? 'border-accent bg-surface shadow-os' : 'border-osborder hover:bg-surface'
              }`}
            >
              <Maximize size={16} className={isFullscreen ? 'text-accent' : 'text-muted'} />
              {isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
              {isFullscreen && <Check size={14} className="text-accent" />}
            </button>
          </div>

          <p className="mb-2 text-sm font-medium">{t('settings.fields.interfaceScale')}</p>
          <div className="mb-2 flex gap-2">
            {UI_SCALES.map((s) => {
              const active = (settings?.ui_scale ?? 100) === s;
              return (
                <button
                  key={s}
                  onClick={() => pickScale(s)}
                  className={`flex flex-1 items-center justify-center gap-1 rounded-os border px-3 py-2 text-sm transition-colors duration-160 ${
                    active ? 'border-accent bg-surface shadow-os' : 'border-osborder hover:bg-surface'
                  }`}
                >
                  {s}%
                  {active && <Check size={14} className="text-accent" />}
                </button>
              );
            })}
          </div>
          <p className="mb-4 text-xs text-muted">{t('settings.fields.scaleHint')}</p>
        </section>

        {/* Apps */}
        <section className="mb-8">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted">{t('settings.sections.apps')}</h2>
          <div className="mb-3 flex gap-2">
            <button
              type="button"
              onClick={() => setAllDesktopIcons(true)}
              className="rounded-os border border-osborder px-3 py-1.5 text-sm hover:bg-surface"
            >
              {t('settings.showAll')}
            </button>
            <button
              type="button"
              onClick={() => setAllDesktopIcons(false)}
              className="rounded-os border border-osborder px-3 py-1.5 text-sm hover:bg-surface"
            >
              {t('settings.hideAll')}
            </button>
            <button
              type="button"
              onClick={async () => {
                try {
                  await updateSettings({ icon_positions: {} });
                  push('Desktop icons', 'Icon positions reset to the tidy grid.');
                } catch (e) {
                  push('Error', `Could not reset icon positions: ${e?.message || e}`);
                }
              }}
              className="rounded-os border border-osborder px-3 py-1.5 text-sm hover:bg-surface"
            >
              {t('settings.resetIcons')}
            </button>
          </div>
          <div className="overflow-hidden rounded-os border border-osborder">
            {manageableApps.filter((a) => !a.comingSoon && a.component).map((app, i) => {
              const Icon = app.icon;
              const onDesktop = shownIconIds.includes(app.id);
              const inStart = !hiddenFromStart.includes(app.id);
              const isWeb = app.id.startsWith('webapp:');
              const pill = (on, label) => (
                <span className="flex flex-col items-center gap-0.5">
                  <span
                    className={`flex h-5 w-9 items-center rounded-full p-0.5 transition-colors duration-160 ${
                      on ? 'bg-accent' : 'bg-osborder'
                    }`}
                  >
                    <span
                      className={`h-4 w-4 rounded-full bg-white shadow transition-transform duration-160 ${
                        on ? 'translate-x-4' : 'translate-x-0'
                      }`}
                    />
                  </span>
                  <span className="text-[10px] text-muted">{label}</span>
                </span>
              );
              return (
                <div
                  key={app.id}
                  className={`flex items-center gap-3 px-4 py-2.5 text-sm ${
                    i > 0 ? 'border-t border-osborder' : ''
                  }`}
                >
                  <span
                    className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-os border ${
                      onDesktop || inStart ? 'border-osborder bg-paper text-ink' : 'border-osborder text-muted'
                    }`}
                  >
                    <Icon size={16} strokeWidth={1.75} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className={`block truncate ${onDesktop || inStart ? 'text-ink' : 'text-muted'}`}>
                      {appTitle(app)}
                    </span>
                    {isWeb && (
                      <span className="text-[10px] uppercase tracking-wide text-muted">{t('settings.sections.webapp')}</span>
                    )}
                  </span>
                  <button
                    type="button"
                    onClick={() => toggleDesktopIcon(app.id)}
                    title={onDesktop ? 'Hide from desktop' : 'Show on desktop'}
                    aria-label={`${onDesktop ? 'Hide' : 'Show'} ${appTitle(app)} on desktop`}
                  >
                    {pill(onDesktop, 'Desktop')}
                  </button>
                  <button
                    type="button"
                    onClick={() => toggleStartMenu(app.id)}
                    title={inStart ? 'Hide from Start menu' : 'Show in Start menu'}
                    aria-label={`${inStart ? 'Hide' : 'Show'} ${appTitle(app)} in Start menu`}
                  >
                    {pill(inStart, 'Start')}
                  </button>
                  {isWeb && (
                    <button
                      type="button"
                      onClick={() => uninstallApp(app)}
                      title={`Uninstall ${appTitle(app)}`}
                      aria-label={`Uninstall ${appTitle(app)}`}
                      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-os text-muted transition-colors duration-160 hover:bg-paper hover:text-ink"
                    >
                      <Trash2 size={15} />
                    </button>
                  )}
                </div>
              );
            })}
            {comingSoonApps.map((app) => {
              const Icon = app.icon;
              return (
                <div
                  key={app.id}
                  className="flex items-center gap-3 border-t border-osborder px-4 py-2.5 text-sm opacity-60"
                  title={`${appTitle(app)} — coming soon`}
                >
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-os border border-osborder text-muted">
                    <Icon size={16} strokeWidth={1.75} />
                  </span>
                  <span className="min-w-0 flex-1 truncate text-muted">{appTitle(app)}</span>
                  <span className="text-[10px] uppercase tracking-wide text-muted">{t('settings.fields.comingSoon')}</span>
                </div>
              );
            })}
          </div>
          <p className="mt-2 text-xs text-muted">
            Desktop controls the desktop icons (drag them to reorder); Start controls the Start
            menu and the touch home screen. You can also right-click the desktop: right-click an
            icon to remove it, right-click empty space to add one back.
          </p>
        </section>

        {/* Helm */}
        <section className="mb-8">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted">{t('settings.sections.helm')}</h2>
          <div className="flex gap-2">
            {[
              { id: 'local', label: 'Local (on-device)' },
              { id: 'cloud', label: 'Cloud smart' },
            ].map((e) => {
              const active = settings?.ai_engine === e.id;
              return (
                <button
                  key={e.id}
                  onClick={() => pickEngine(e.id)}
                  className={`flex flex-1 items-center justify-center gap-2 rounded-os border px-3 py-2.5 text-sm transition-colors duration-160 ${
                    active ? 'border-accent bg-surface shadow-os' : 'border-osborder hover:bg-surface'
                  }`}
                >
                  {e.label}
                  {active && <Check size={14} className="text-accent" />}
                </button>
              );
            })}
          </div>
          <p className="mt-2 rounded-os border border-osborder bg-surface px-3 py-2 text-xs text-muted">
            {settings?.ai_engine === 'cloud'
              ? 'Cloud smart mode: open questions are answered conversationally by a free public AI service. Your messages are sent to that service — don\'t share passwords or private info. Commands (open apps, pins, files, theme) still run on-device.'
              : 'Local mode: everything runs on-device. Questions are answered with live web lookups (DuckDuckGo, Wikipedia); nothing is sent to an AI service.'}
          </p>
        </section>

        {/* Data */}
        <section className="mb-8">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted">{t('settings.sections.data')}</h2>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={exportData}
              disabled={exporting}
              className="flex items-center gap-2 rounded-os bg-accent px-4 py-2 text-sm text-accentink transition-opacity duration-160 disabled:opacity-40"
            >
              <Download size={15} /> {exporting ? 'Backing up…' : 'Download account backup'}
            </button>
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={importing}
              className="flex items-center gap-2 rounded-os border border-osborder bg-surface px-4 py-2 text-sm transition-colors duration-160 hover:border-accent disabled:opacity-40"
            >
              <Upload size={15} /> {importing ? 'Restoring…' : 'Restore backup'}
            </button>
            <button
              onClick={() => setConfirmErase(true)}
              disabled={erasing}
              className="flex items-center gap-2 rounded-os border border-osborder bg-surface px-4 py-2 text-sm text-muted transition-colors duration-160 hover:text-ink disabled:opacity-40"
            >
              <Trash2 size={15} /> {erasing ? 'Erasing…' : 'Erase all data'}
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".json,application/json"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                importData(f);
              }}
            />
          </div>
          <p className="mt-2 text-xs text-muted">
            Downloads one backup file with your whole account: settings, profile, files
            (including binary files), pins, spaces with their window layouts, Helm threads,
            highscores, notifications, every POS store (products, sales, customers, staff,
            time-clock history, appointments, drawer shifts), plus your support requests and
            feedback. Restoring merges store data by ID — it adds what's missing and never deletes
            anything. Keep the file somewhere safe: it contains private data such as staff PINs.
            Erasing deletes everything permanently.
          </p>
        </section>

        {/* Download & offline */}
        <section className="mb-8">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted">{t('settings.sections.downloadOffline')}</h2>
          <div className="flex flex-wrap gap-2">
            {installState === 'installed' ? (
              <button
                type="button"
                disabled
                className="flex cursor-default items-center gap-2 rounded-os border border-osborder bg-surface px-4 py-2 text-sm text-muted"
              >
                <Check size={15} /> {t('settings.driftInstalled')}
              </button>
            ) : installState === 'prompt' ? (
              <button
                type="button"
                onClick={handleInstall}
                className="flex items-center gap-2 rounded-os bg-accent px-4 py-2 text-sm text-accentink transition-opacity duration-160 hover:opacity-90"
              >
                <Download size={15} /> {t('settings.downloadDrift')}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setShowInstallHelp((v) => !v)}
                className="flex items-center gap-2 rounded-os border border-osborder bg-surface px-4 py-2 text-sm transition-colors duration-160 hover:border-accent"
              >
                <Download size={15} /> {t('settings.howToDownload')}
              </button>
            )}
            {swUpdate && (
              <button
                type="button"
                onClick={() => window.location.reload()}
                className="flex items-center gap-2 rounded-os border border-osborder bg-surface px-4 py-2 text-sm transition-colors duration-160 hover:border-accent"
              >
                <RefreshCw size={15} /> {t('settings.reloadLatest')}
              </button>
            )}
          </div>
          {(showInstallHelp || installState === 'manual') && installState !== 'installed' && (
            <p className="mt-2 rounded-os border border-osborder bg-paper px-3 py-2 text-xs text-muted">
              {installInstructions()}
            </p>
          )}
          <p className="mt-2 text-xs text-muted">
            {offlineReady ? t('settings.sections.offlineReady') : t('settings.sections.offlinePreparing')}{' '}
            {t('settings.sections.offlineNote')}
          </p>
        </section>

        {/* Help */}
        <section className="mb-8">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted">{t('settings.sections.help')}</h2>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => window.dispatchEvent(new CustomEvent('drift:show-welcome'))}
              className="flex items-center gap-2 rounded-os border border-osborder bg-surface px-4 py-2 text-sm transition-colors duration-160 hover:border-accent"
            >
              {t('settings.showWelcome')}
            </button>
            <button
              onClick={() => window.dispatchEvent(new CustomEvent('drift:show-tour'))}
              className="flex items-center gap-2 rounded-os border border-osborder bg-surface px-4 py-2 text-sm transition-colors duration-160 hover:border-accent"
            >
              {t('settings.replayTour')}
            </button>
          </div>
          <p className="mt-2 text-xs text-muted">
            The welcome guide is the first-run greeting; the feature tour walks through the desktop, apps, and settings.
          </p>
        </section>

        {/* About */}
        <section>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted">{t('settings.sections.about')}</h2>
          <dl className="rounded-os border border-osborder bg-surface text-sm">
            <div className="flex justify-between border-b border-osborder px-3 py-2">
              <dt className="text-muted">{t('settings.fields.version')}</dt>
              <dd>0.1.0</dd>
            </div>
            <div className="flex justify-between border-b border-osborder px-3 py-2">
              <dt className="text-muted">{t('settings.fields.copyright')}</dt>
              <dd>© {new Date().getFullYear()} Librairie Louis-Fréchette</dd>
            </div>
            <div className="flex justify-between border-b border-osborder px-3 py-2">
              <dt className="text-muted">{t('settings.sections.backend')}</dt>
              <dd>{backend.kind}</dd>
            </div>
            <div className="flex justify-between border-b border-osborder px-3 py-2">
              <dt className="text-muted">{t('settings.fields.modeNote')}</dt>
              <dd className="max-w-[60%] text-right text-xs">
                {t('login.cloudHint')}
              </dd>
            </div>
            <div className="flex items-center justify-between px-3 py-2">
              <dt className="flex items-center gap-1.5 text-muted">
                <HardDrive size={14} /> {t('settings.storageUsed')}
              </dt>
              <dd className="flex items-center gap-2">
                {storageBytes == null ? 'computing…' : formatBytes(storageBytes)}
                <button
                  onClick={computeStorage}
                  title="Recompute storage used"
                  aria-label="Recompute storage used"
                  className="rounded-os p-1 text-muted transition-colors duration-160 hover:text-ink"
                >
                  <RefreshCw size={13} />
                </button>
              </dd>
            </div>
          </dl>
        </section>
      </div>
      {pendingImport && (
        <ConfirmDialog
          title="Replace your current data?"
          message="Importing will REPLACE your current files, pins, Helm threads, spaces, and settings with this backup. POS stores, support requests, and feedback are merged instead — missing records are added, nothing is deleted. This cannot be undone."
          confirmLabel="Replace and import"
          cancelLabel="Keep my data"
          danger
          onConfirm={confirmImport}
          onCancel={() => setPendingImport(null)}
        />
      )}
      {confirmErase && (
        <ConfirmDialog
          title="Erase everything?"
          message="This permanently deletes files, pins, Helm threads, spaces, and settings. This cannot be undone."
          confirmLabel="Erase everything"
          cancelLabel="Keep my data"
          danger
          onConfirm={() => {
            setConfirmErase(false);
            eraseAllData();
          }}
          onCancel={() => setConfirmErase(false)}
        />
      )}
    </div>
  );
}
