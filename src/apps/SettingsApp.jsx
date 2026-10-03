import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Download, Upload, Sun, Moon, MonitorSmartphone, Check, X, HardDrive, RefreshCw, Maximize, Trash2, LayoutGrid, ArrowUp, ArrowDown, ArrowLeft, ArrowRight, CloudUpload, CloudDownload, Link2, Unlink } from 'lucide-react';
import { backend } from '../lib/backend/current.js';
import { exportAccountBackup, downloadBackupFile, importAccountBackup } from '../lib/accountBackup.js';
import { validateBackup } from '../lib/backupRestore.js';
import {
  CloudBackupError,
  backUpNowToDrive,
  connectGoogleDrive,
  disconnectGoogleDrive,
  downloadCloudBackup,
  ensureGoogleDriveToken,
  getCloudBackupState,
  getDriveAbout,
  isCloudBackupConfigured,
  isGoogleDriveConnected,
  listCloudBackups,
  maybeAutoCloudBackup,
  setCloudBackupState,
} from '../lib/cloudBackup.js';
import { useSettings } from '../os/SettingsContext.jsx';
import { useNotifications } from '../os/NotificationsContext.jsx';
import { useAuth } from '../os/AuthContext.jsx';
import { useLang, localeTag } from '../lib/i18n.jsx';
import { appTitle } from '../lib/appTitle.js';
import { ConfirmDialog } from '../components/os/dialogs.jsx';
import LicensePlanSection from '../components/LicensePlanSection.jsx';
import RecoverySettings from '../components/RecoverySettings.jsx';
import ProfileSettings from '../components/ProfileSettings.jsx';
import { isEnabled as soundOn, setEnabled as setSoundOn, playSound, getVolume, setVolume } from '../lib/sound.js';
import { UNLOCK_EVENT } from '../lib/easterEgg.js';
import { listLaunchableApps } from './registry.jsx';
// NOTE: do not import APPS here — registry.jsx imports SettingsApp, so this
// module evaluates while the registry is still initializing and reading APPS
// throws "Cannot access before initialization", blanking the whole boot.
import { ensureWebApps, useWebApps, uninstallWebApp } from '../lib/webapps.js';
import {
  hasInstallPrompt,
  installInstructions,
  isInstalled,
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
  const [erasing, setErasing] = useState(false);
  const [confirmErase, setConfirmErase] = useState(false);
  // Restore from backup (owner): pick a backup file, review what is
  // inside, type RESTORE to confirm, safety backup first, then restore.
  const [restoreOpen, setRestoreOpen] = useState(false);
  const [restorePick, setRestorePick] = useState(null); // { name, data, validation }
  const [restoreWord, setRestoreWord] = useState('');
  const [restoreBusy, setRestoreBusy] = useState(''); // '' | 'safety' | 'restoring'
  const [restoreStep, setRestoreStep] = useState('');
  const [restoreResult, setRestoreResult] = useState(null); // { report } | { error }
  const restoreInputRef = useRef(null);
  const [soundTick, setSoundTick] = useState(0); // re-render the sound toggle
  void soundTick;
  // Easter egg: 7 quick taps on the About version line opens the hidden
  // game. Visually identical to a plain version label — no menu entry,
  // no hint.
  const versionTapsRef = useRef({ count: 0, last: 0 });
  const tapVersion = () => {
    const now = Date.now();
    const s = versionTapsRef.current;
    s.count = now - s.last < 1200 ? s.count + 1 : 1;
    s.last = now;
    if (s.count >= 7) {
      s.count = 0;
      window.dispatchEvent(new CustomEvent(UNLOCK_EVENT));
    }
  };
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
  const [isFullscreen, setIsFullscreen] = useState(false);

  // Cloud backup (optional Google Drive second copy — lib/cloudBackup.js)
  const [cloudBusy, setCloudBusy] = useState(''); // ''|'connect'|'backup'|'list'|'restore:<id>'
  const [cloudConnected, setCloudConnected] = useState(() => isGoogleDriveConnected());
  const [cloudAbout, setCloudAbout] = useState(null);
  const [cloudState, setCloudStateUi] = useState(() => getCloudBackupState());
  const [driveListOpen, setDriveListOpen] = useState(false);
  const [driveFiles, setDriveFiles] = useState(null); // null = not loaded yet

  // On open: surface an existing Google session, then quietly run the
  // weekly automatic backup if one is due (silent by design — no popups).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!isCloudBackupConfigured()) return;
      if (isGoogleDriveConnected()) {
        const token = await ensureGoogleDriveToken();
        if (token && !cancelled) {
          const about = await getDriveAbout(token);
          if (!cancelled) {
            setCloudConnected(true);
            setCloudAbout(about);
          }
        }
      }
      const ran = await maybeAutoCloudBackup(exportAccountBackup);
      if (ran && !cancelled) {
        const s = getCloudBackupState();
        setCloudStateUi(s);
        push(t('settings.cloudBackup.doneTitle'), t('settings.cloudBackup.doneBody', { name: s.lastName || '' }));
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Install app (PWA install + service worker update status)
  const [installState, setInstallState] = useState('unknown'); // unknown|installed|prompt|manual
  const [showInstallHelp, setShowInstallHelp] = useState(false);
  const [swUpdate, setSwUpdate] = useState(false);

  const refreshInstallState = useCallback(() => {
    if (isInstalled()) setInstallState('installed');
    else if (hasInstallPrompt()) setInstallState('prompt');
    else setInstallState('manual');
  }, []);

  useEffect(() => {
    refreshInstallState();
    const onAvail = () => {
      refreshInstallState();
    };
    const onChanged = () => {
      refreshInstallState();
    };
    window.addEventListener('drift:install-available', onAvail);
    window.addEventListener('drift:install-changed', onChanged);
    // Service worker: flag when a newer build is waiting behind this one
    // so Settings can offer a reload onto the latest version.
    let cancelled = false;
    registerServiceWorker().then((reg) => {
      if (cancelled || !reg) return;
      const checkWaiting = () => {
        if (reg.waiting) setSwUpdate(true);
      };
      checkWaiting();
      reg.addEventListener('updatefound', checkWaiting);
    });
    return () => {
      cancelled = true;
      window.removeEventListener('drift:install-available', onAvail);
      window.removeEventListener('drift:install-changed', onChanged);
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

  // ---- whole-account backup (v2.2.0) ---------------------------------------
  // Implemented in src/lib/accountBackup.js so the factory-reset flow can
  // reuse the exact same export code path; exportData below is the thin
  // Settings button wrapper around it.
  const exportData = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const dump = await exportAccountBackup();
      downloadBackupFile(dump, `vendra-backup-${new Date().toISOString().slice(0, 10)}.json`);
      push(t('settings.sections.backupComplete'), t('settings.sections.backupCompleteBody'));
    } catch (err) {
      push(t('settings.sections.backupFailed'), err?.message || t('settings.sections.backupFailedBody'));
    } finally {
      setExporting(false);
    }
  };

  // ---- restore from backup (owner) -----------------------------------------
  // Same merge semantics as the master restore: settings/profile/files
  // are overwritten, shop rows merge by ID (nothing deleted), pins and
  // conversations are added only when the account has none. A safety
  // backup of the current state is downloaded before anything changes.
  const onRestoreFile = async (file) => {
    setRestoreResult(null);
    setRestoreWord('');
    setRestorePick(null);
    if (!file) return;
    let data;
    try {
      data = JSON.parse(await file.text());
    } catch {
      push(t('settings.restore.title'), t('settings.restore.fileInvalid'));
      return;
    }
    const validation = validateBackup(data);
    if (!validation.ok) {
      const code = validation.fatal?.[0] || 'not-a-backup';
      push(
        t('settings.restore.title'),
        t(code === 'wrong-file' ? 'settings.restore.wrongFile' : 'settings.restore.notABackup')
      );
      return;
    }
    setRestorePick({ name: file.name, data, validation });
    setRestoreOpen(true);
  };

  const doRestore = async () => {
    if (!restorePick || restoreBusy) return;
    setRestoreResult(null);
    // Safety net first: download how things are right now. If this
    // fails, stop before touching anything.
    setRestoreBusy('safety');
    setRestoreStep('');
    try {
      const dump = await exportAccountBackup();
      downloadBackupFile(dump, `vendra-before-restore-${new Date().toISOString().slice(0, 10)}.json`);
    } catch {
      setRestoreBusy('');
      setRestoreResult({ error: t('settings.restore.safetyFailed') });
      return;
    }
    setRestoreBusy('restoring');
    try {
      const { report } = await importAccountBackup(restorePick.data, {
        onProgress: (s) => setRestoreStep(s),
      });
      setRestoreResult({ report });
      try {
        updateSettings({});
      } catch {
        /* settings context refresh is best effort */
      }
    } catch (err) {
      const msg = String(err?.message || err);
      const code = msg.startsWith('not-a-backup:') ? msg.slice('not-a-backup:'.length) : null;
      setRestoreResult({
        error: code
          ? t(code === 'wrong-file' ? 'settings.restore.wrongFile' : 'settings.restore.notABackup')
          : msg,
      });
    } finally {
      setRestoreBusy('');
    }
  };

  const closeRestore = () => {
    setRestoreOpen(false);
    setRestorePick(null);
    setRestoreWord('');
    setRestoreStep('');
    setRestoreResult(null);
  };

  const fmtRestoreDate = (iso) => {
    if (!iso) return '';
    try {
      return new Intl.DateTimeFormat(localeTag(), { dateStyle: 'long' }).format(new Date(iso));
    } catch {
      return String(iso).slice(0, 10);
    }
  };

  const renderRestoreWarnings = (warnings) =>
    (warnings || []).map((w, i) => {
      const key = {
        'legacy-backup': 'settings.restore.warnLegacy',
        'newer-version': 'settings.restore.warnNewer',
        'partial-backup': 'settings.restore.warnPartial',
        'unknown-table': 'settings.restore.warnUnknownTable',
        'store-export-error': 'settings.restore.warnStoreError',
        'table-export-error': 'settings.restore.warnTableError',
        'files-not-embedded': 'settings.restore.warnFilesNotEmbedded',
      }[w.code];
      if (!key) return null;
      return (
        <li key={i} className="text-xs leading-relaxed text-ink">
          {t(key, { table: w.table || '', store: w.store || '', count: w.count ?? '', version: w.version || '' })}
        </li>
      );
    });

  const renderRestoreDialog = () => {
    if (!restoreOpen) return null;
    const armed = restoreWord === 'RESTORE' && !!restorePick && !restoreBusy;
    const s = restorePick?.validation?.summary;
    const totals = s?.totals || {};
    const busyLabel = restoreBusy === 'safety'
      ? t('settings.restore.stepSafety')
      : restoreBusy === 'restoring'
        ? t('settings.restore.stepRestoring', { step: t(`settings.restore.step${restoreStep.charAt(0).toUpperCase()}${restoreStep.slice(1).replace(/-([a-z])/g, (_, c) => c.toUpperCase())}`, { defaultValue: restoreStep }) })
        : '';
    return (
      <div
        className="fixed inset-0 z-[70] flex items-center justify-center bg-ink/30 p-4"
        onMouseDown={(e) => { if (e.target === e.currentTarget && !restoreBusy) closeRestore(); }}
      >
        <div role="dialog" aria-modal="true" aria-label={t('settings.restore.title')} className="max-h-[85vh] w-full max-w-md overflow-y-auto rounded-os border border-osborder bg-surface shadow-win">
          <div className="flex items-center justify-between border-b border-osborder px-4 py-3">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-ink">
              <Upload size={16} className="shrink-0 text-accent" aria-hidden="true" />
              {t('settings.restore.title')}
            </h3>
            {!restoreBusy && (
              <button
                type="button"
                onClick={closeRestore}
                aria-label={t('dialogs.closeDialog')}
                className="rounded-os p-1 text-muted hover:bg-paper hover:text-ink"
              >
                <X size={16} />
              </button>
            )}
          </div>
          <div className="p-4">
            {restoreResult?.error ? (
              <>
                <p className="text-sm font-semibold text-red-700">{t('settings.restore.failedTitle')}</p>
                <p className="mt-2 text-xs leading-relaxed text-ink">{restoreResult.error}</p>
                <div className="mt-4 flex justify-end">
                  <button type="button" onClick={closeRestore} className="rounded-os bg-accent px-4 py-1.5 text-sm font-medium text-accentink">
                    {t('settings.restore.closeButton')}
                  </button>
                </div>
              </>
            ) : restoreResult?.report ? (
              <>
                <p className="flex items-center gap-2 text-sm font-semibold text-ink">
                  <Check size={16} className="text-accent" /> {t('settings.restore.doneTitle')}
                </p>
                <p className="mt-2 text-xs leading-relaxed text-ink">
                  {t('settings.restore.doneSummary', {
                    stores: (restoreResult.report.posReports || []).length,
                    files: restoreResult.report.filesRestored || 0,
                    pins: restoreResult.report.pinsRestored || 0,
                    threads: restoreResult.report.threadsRestored || 0,
                    spaces: restoreResult.report.spacesRestored || 0,
                  })}
                </p>
                {(() => {
                  const problems = [];
                  for (const pr of restoreResult.report.posReports || []) {
                    for (const [, msg] of Object.entries(pr.errors || {})) {
                      if (msg) problems.push(`${pr.name}: ${msg}`);
                    }
                    if (pr.error) problems.push(`${pr.name}: ${pr.error}`);
                  }
                  for (const f of restoreResult.report.filesSkipped || []) problems.push(`${f.path} (${f.reason})`);
                  for (const f of restoreResult.report.shopFilesSkipped || []) problems.push(`${f.path} (${f.reason})`);
                  for (const e of restoreResult.report.errors || []) problems.push(e);
                  if (!problems.length) return null;
                  return (
                    <>
                      <p className="mt-3 text-xs font-semibold text-red-700">{t('settings.restore.doneProblems')}</p>
                      <ul className="mt-1 list-disc space-y-1 pl-5">
                        {problems.slice(0, 12).map((p, i) => (
                          <li key={i} className="text-xs leading-relaxed text-ink">{p}</li>
                        ))}
                      </ul>
                    </>
                  );
                })()}
                <div className="mt-4 flex justify-end">
                  <button type="button" onClick={closeRestore} className="rounded-os bg-accent px-4 py-1.5 text-sm font-medium text-accentink">
                    {t('settings.restore.closeButton')}
                  </button>
                </div>
              </>
            ) : restoreBusy ? (
              <>
                <p className="text-sm font-semibold text-ink">{busyLabel}</p>
                <p className="mt-2 text-xs text-muted">{t('settings.restore.pointSafety')}</p>
              </>
            ) : (
              <>
                {s?.exportedAt && (
                  <p className="text-xs font-semibold text-ink">{t('settings.restore.savedOn', { date: fmtRestoreDate(s.exportedAt) })}</p>
                )}
                <p className="mt-1 text-xs leading-relaxed text-ink">
                  {t('settings.restore.countsLine', {
                    stores: totals.stores || 0,
                    products: totals.products || 0,
                    sales: totals.sales || 0,
                    files: s?.files || 0,
                    pins: s?.pins || 0,
                  })}
                </p>
                {(restorePick?.validation?.warnings?.length > 0) && (
                  <>
                    <p className="mt-3 text-xs font-semibold text-ink">{t('settings.restore.warningsTitle')}</p>
                    <ul className="mt-1 list-disc space-y-1 pl-5">
                      {renderRestoreWarnings(restorePick.validation.warnings)}
                    </ul>
                  </>
                )}
                <p className="mt-3 text-xs font-semibold text-ink">{t('settings.restore.intro')}</p>
                <ul className="mt-1 list-disc space-y-1 pl-5">
                  <li className="text-xs leading-relaxed text-ink">{t('settings.restore.pointSettings')}</li>
                  <li className="text-xs leading-relaxed text-ink">{t('settings.restore.pointShops')}</li>
                  <li className="text-xs leading-relaxed text-ink">{t('settings.restore.pointPins')}</li>
                  <li className="text-xs leading-relaxed text-ink">{t('settings.restore.pointSafety')}</li>
                </ul>
                <label className="mt-4 block text-xs font-medium text-ink">
                  {t('settings.restore.typeToConfirm')}
                  <input
                    value={restoreWord}
                    onChange={(e) => setRestoreWord(e.target.value)}
                    placeholder="RESTORE"
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                    className="mt-1 w-full rounded-os border border-osborder bg-paper px-3 py-2 text-sm text-ink outline-none focus:border-accent"
                  />
                </label>
                <div className="mt-4 flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={closeRestore}
                    className="rounded-os border border-osborder px-3 py-1.5 text-sm text-ink hover:bg-paper"
                  >
                    {t('dialogs.cancel')}
                  </button>
                  <button
                    type="button"
                    onClick={doRestore}
                    disabled={!armed}
                    className="rounded-os bg-accent px-4 py-1.5 text-sm font-medium text-accentink disabled:opacity-40"
                  >
                    {t('settings.restore.confirmButton')}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    );
  };
  // S2: wipe everything, gated on a single explicit danger dialog.
  // Resetting settings to defaults also clears welcome_seen, so the welcome
  // guide replays once — a full wipe is a fresh start.
  // --- Cloud backup (Google Drive) -------------------------------------

  const cloudErrorToast = (err) => {
    const code = err?.code;
    if (code === 'auth') push(t('settings.cloudBackup.errSigninTitle'), t('settings.cloudBackup.errSigninBody'));
    else if (code === 'full') push('Error', t('settings.cloudBackup.errFull'));
    else if (code === 'network') push('Error', t('settings.cloudBackup.errOffline'));
    else if (code === 'badfile') push('Error', t('settings.cloudBackup.errBadFile'));
    else push('Error', t('settings.cloudBackup.errGeneric', { msg: err?.message || String(err) }));
  };

  const handleCloudConnect = async () => {
    setCloudBusy('connect');
    try {
      const { about } = await connectGoogleDrive();
      setCloudConnected(true);
      setCloudAbout(about);
    } catch (err) {
      cloudErrorToast(err);
    } finally {
      setCloudBusy('');
    }
  };

  const handleCloudBackupNow = async () => {
    setCloudBusy('backup');
    try {
      const data = await exportAccountBackup();
      const { name } = await backUpNowToDrive(data, { interactive: true });
      setCloudConnected(true);
      setCloudStateUi(getCloudBackupState());
      push(t('settings.cloudBackup.doneTitle'), t('settings.cloudBackup.doneBody', { name }));
    } catch (err) {
      cloudErrorToast(err);
    } finally {
      setCloudBusy('');
    }
  };

  const handleCloudDisconnect = () => {
    disconnectGoogleDrive();
    setCloudConnected(false);
    setCloudAbout(null);
    setDriveListOpen(false);
    setDriveFiles(null);
  };

  const handleToggleDriveRestore = async () => {
    if (driveListOpen) {
      setDriveListOpen(false);
      return;
    }
    setDriveListOpen(true);
    setCloudBusy('list');
    try {
      const token = await ensureGoogleDriveToken({ interactive: true });
      if (!token) throw new CloudBackupError('auth', 'Google sign-in is needed.');
      const files = await listCloudBackups(token);
      setCloudConnected(true);
      setDriveFiles(files);
    } catch (err) {
      cloudErrorToast(err);
    } finally {
      setCloudBusy('');
    }
  };

  const handleRestoreDriveFile = async (f) => {
    setCloudBusy(`restore:${f.id}`);
    try {
      const token = await ensureGoogleDriveToken({ interactive: true });
      if (!token) throw new CloudBackupError('auth', 'Google sign-in is needed.');
      const data = await downloadCloudBackup(token, f.id);
      // Drive is a SOURCE, never a restore path of its own. Putting a
      // backup back runs through the owner-only master restore (Admin →
      // Users → Restore a backup: validate → type RESTORE → safety
      // backup → wipe → re-import). So: validate the Drive copy with the
      // same checker, save that exact file onto this device, and point
      // the owner at the master flow — they pick this file there.
      const validation = validateBackup(data);
      if (!validation.ok) throw new CloudBackupError('badfile', 'That backup file could not be read, so nothing was restored.');
      downloadBackupFile(data, f.name || 'drift-backup.json');
      setDriveListOpen(false);
      push(
        t('settings.cloudBackup.restoreReadyTitle'),
        t('settings.cloudBackup.restoreReadyBody', { name: f.name || 'drift-backup.json' }),
      );
    } catch (err) {
      cloudErrorToast(err);
    } finally {
      setCloudBusy('');
    }
  };

  const handleCloudAutoToggle = () => {
    setCloudStateUi(setCloudBackupState({ auto: !cloudState.auto }));
  };

  const formatWhen = (iso) => {
    try {
      return new Intl.DateTimeFormat(localeTag(), { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
    } catch {
      return iso || '';
    }
  };

  const cloudCard = (
    <div className="mt-4 rounded-os border border-osborder bg-surface p-4">
      <h3 className="text-sm font-semibold text-ink">{t('settings.cloudBackup.title')}</h3>
      <p className="mt-1 text-xs text-muted">{t('settings.cloudBackup.intro')}</p>
      <p className="mt-1 text-xs text-muted">{t('settings.cloudBackup.privacy')}</p>
      {!isCloudBackupConfigured() ? (
        <p className="mt-3 rounded-os border border-osborder px-3 py-2 text-xs text-muted">{t('settings.cloudBackup.notReady')}</p>
      ) : !cloudConnected ? (
        <div className="mt-3">
          <button
            type="button"
            onClick={handleCloudConnect}
            disabled={cloudBusy !== ''}
            className="flex min-h-[44px] items-center gap-2 rounded-os bg-accent px-4 py-2 text-sm font-medium text-white transition-opacity duration-160 hover:opacity-90 disabled:opacity-50"
          >
            <Link2 size={15} />
            {cloudBusy === 'connect' ? t('settings.cloudBackup.connecting') : t('settings.cloudBackup.connect')}
          </button>
        </div>
      ) : (
        <>
          <div className="mt-3 flex items-center gap-2 text-sm text-ink">
            <Check size={15} className="shrink-0 text-accent" />
            <span>
              {t('settings.cloudBackup.connected')}
              {cloudAbout?.email ? <span className="text-muted"> · {cloudAbout.email}</span> : null}
            </span>
          </div>
          {cloudAbout?.limit ? (
            <p className="mt-1 text-xs text-muted">
              {t('settings.cloudBackup.storageLine', { used: formatBytes(cloudAbout.usage || 0), total: formatBytes(cloudAbout.limit) })}
            </p>
          ) : null}
          <p className="mt-1 text-xs text-muted">
            {cloudState.lastAt ? t('settings.cloudBackup.lastBackup', { when: formatWhen(cloudState.lastAt) }) : t('settings.cloudBackup.neverBackedUp')}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={handleCloudBackupNow}
              disabled={cloudBusy !== ''}
              className="flex min-h-[44px] items-center gap-2 rounded-os bg-accent px-4 py-2 text-sm font-medium text-white transition-opacity duration-160 hover:opacity-90 disabled:opacity-50"
            >
              <CloudUpload size={15} />
              {cloudBusy === 'backup' ? t('settings.cloudBackup.backingUp') : t('settings.cloudBackup.backupNow')}
            </button>
            <button
              type="button"
              onClick={handleToggleDriveRestore}
              disabled={cloudBusy !== ''}
              className="flex min-h-[44px] items-center gap-2 rounded-os border border-osborder px-4 py-2 text-sm font-medium text-ink transition-colors duration-160 hover:bg-surface disabled:opacity-50"
            >
              <CloudDownload size={15} />
              {t('settings.cloudBackup.restore')}
            </button>
            <button
              type="button"
              onClick={handleCloudDisconnect}
              disabled={cloudBusy !== ''}
              className="flex min-h-[44px] items-center gap-2 rounded-os border border-osborder px-4 py-2 text-sm font-medium text-ink transition-colors duration-160 hover:bg-surface disabled:opacity-50"
            >
              <Unlink size={15} />
              {t('settings.cloudBackup.disconnect')}
            </button>
          </div>
          <p className="mt-1 text-xs text-muted">{t('settings.cloudBackup.disconnectHint')}</p>
          <button
            type="button"
            onClick={handleCloudAutoToggle}
            role="switch"
            aria-checked={!!cloudAuto}
            className="mt-2 flex min-h-[44px] w-full items-center gap-3 rounded-os border border-osborder px-4 py-3 text-left transition-colors duration-160 hover:bg-surface"
          >
            <span className="flex-1">
              <span className="block text-sm font-medium text-ink">{t('settings.cloudBackup.auto')}</span>
              <span className="block text-xs text-muted">{t('settings.cloudBackup.autoHint')}</span>
            </span>
            <span className={`flex h-7 w-12 shrink-0 items-center rounded-full p-1 transition-colors duration-160 ${cloudState.auto ? 'bg-accent' : 'bg-osborder'}`}>
              <span className={`h-5 w-5 rounded-full bg-white shadow transition-transform duration-160 ${cloudState.auto ? 'translate-x-5' : 'translate-x-0'}`} />
            </span>
          </button>
          {driveListOpen && (
            <div className="mt-3">
              {cloudBusy === 'list' ? (
                <p className="text-xs text-muted">{t('settings.cloudBackup.restoreLoading')}</p>
              ) : !driveFiles || driveFiles.length === 0 ? (
                <p className="text-xs text-muted">{t('settings.cloudBackup.restoreNone')}</p>
              ) : (
                <>
                  <p className="text-xs text-muted">{t('settings.cloudBackup.restorePick')}</p>
                  <div className="mt-2 flex flex-col gap-2">
                    {driveFiles.map((f, i) => (
                      <button
                        key={f.id}
                        type="button"
                        onClick={() => handleRestoreDriveFile(f)}
                        disabled={cloudBusy !== ''}
                        className="flex min-h-[44px] items-center gap-2 rounded-os border border-osborder px-4 py-2 text-sm text-ink transition-colors duration-160 hover:bg-surface disabled:opacity-50"
                      >
                        <CloudDownload size={15} className="shrink-0" />
                        <span className="flex-1 text-left">
                          <span className="block font-medium">{formatWhen(f.createdTime)}</span>
                          <span className="block text-xs text-muted">
                            {f.name}
                            {f.size ? ` · ${formatBytes(Number(f.size))}` : ''}
                          </span>
                        </span>
                        {i === 0 && (
                          <span className="rounded-full bg-accent px-2 py-0.5 text-xs font-medium text-white">{t('settings.cloudBackup.newest')}</span>
                        )}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );

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
      push('Data erased', 'All Vendra data was permanently deleted.');
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
              { id: 'es', label: t('lang.spanish') },
              { id: 'pt', label: t('lang.portuguese') },
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

        {/* Account recovery — email-independent (recovery codes, security questions) */}
        <RecoverySettings />

        {/* Profile — username change */}
        <ProfileSettings />

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
            role="switch"
            aria-checked={!!settings?.touch_mode}
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
            role="switch"
            aria-checked={soundOn()}
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
                aria-label={t('settings.soundVolumeAria')}
                className="h-2 flex-1 cursor-pointer appearance-none rounded-full bg-osborder accent-accent"
              />
              <span className="w-10 text-right text-sm text-muted">{Math.round(volume * 100)}%</span>
            </div>
          )}

          <p className="mb-2 mt-4 text-sm font-medium">{t('settings.fields.interfaceStyle')}</p>
          <div className="grid grid-cols-3 gap-2">
            {[
              { id: 'drift', label: t('brand.name'), blurb: t('settings.fields.styleDriftBlurb') },
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
                    role="switch"
                    aria-checked={!!onDesktop}
                  >
                    {pill(onDesktop, 'Desktop')}
                  </button>
                  <button
                    type="button"
                    onClick={() => toggleStartMenu(app.id)}
                    title={inStart ? 'Hide from Start menu' : 'Show in Start menu'}
                    aria-label={`${inStart ? 'Hide' : 'Show'} ${appTitle(app)} in Start menu`}
                    role="switch"
                    aria-checked={!!inStart}
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
            {t('settings.desktopBlurb')}
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
              <Download size={15} /> {exporting ? t('settings.backingUp') : t('settings.downloadBackup')}
            </button>
            <button
              onClick={() => restoreInputRef.current?.click()}
              disabled={exporting || !!restoreBusy}
              className="flex items-center gap-2 rounded-os border border-osborder bg-surface px-4 py-2 text-sm text-muted transition-colors duration-160 hover:text-ink disabled:opacity-40"
            >
              <Upload size={15} /> {t('settings.restore.button')}
            </button>
            <input
              ref={restoreInputRef}
              type="file"
              accept="application/json,.json"
              className="hidden"
              aria-hidden="true"
              tabIndex={-1}
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (f) onRestoreFile(f);
              }}
            />
            <button
              onClick={() => setConfirmErase(true)}
              disabled={erasing}
              className="flex items-center gap-2 rounded-os border border-osborder bg-surface px-4 py-2 text-sm text-muted transition-colors duration-160 hover:text-ink disabled:opacity-40"
            >
              <Trash2 size={15} /> {erasing ? t('settings.erasing') : t('settings.eraseAllData')}
            </button>
          </div>
          <p className="mt-2 text-xs text-muted">
            {t('settings.backupBlurb')}
          </p>
          {cloudCard}
        </section>

        {/* Plan + support (licensing 072): license status, countdown,
            key entry, and the purchase/support channel. The component
            renders nothing until the licensing migration is live. */}
        <div className="mb-8">
          <LicensePlanSection />
        </div>

        {/* Install app */}
        <section className="mb-8">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted">{t('settings.sections.installApp')}</h2>
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
              {installInstructions(t)}
            </p>
          )}
          <p className="mt-2 text-xs text-muted">
            {t('settings.sections.installNote')}
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
            {t('settings.welcomeGuideBlurb')}
          </p>
        </section>

        {/* About */}
        <section>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted">{t('settings.sections.about')}</h2>
          <dl className="rounded-os border border-osborder bg-surface text-sm">
            <div className="flex justify-between border-b border-osborder px-3 py-2">
              <dt className="text-muted">{t('settings.fields.version')}</dt>
              <dd onClick={tapVersion} className="select-none text-base font-bold text-accent">v{import.meta.env.VITE_APP_VERSION || '2.1'}</dd>
            </div>
            <div className="flex justify-between border-b border-osborder px-3 py-2">
              <dt className="text-muted">{t('settings.fields.copyright')}</dt>
              <dd>© {new Date().getFullYear()} {t('brand.name')}</dd>
            </div>
            <div className="flex justify-between border-b border-osborder px-3 py-2">
              <dt className="text-muted">{t('settings.sections.backend')}</dt>
              <dd>{backend.kind}</dd>
            </div>
            <div className="flex justify-between border-b border-osborder px-3 py-2">
              <dt className="text-muted">{t('settings.fields.modeNote')}</dt>
              <dd className="max-w-[60%] text-right text-xs">
                {t('settings.fields.modeNoteText')}
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
                  title={t('settings.recomputeStorage')}
                  aria-label={t('settings.recomputeStorage')}
                  className="rounded-os p-1 text-muted transition-colors duration-160 hover:text-ink"
                >
                  <RefreshCw size={13} />
                </button>
              </dd>
            </div>
          </dl>
        </section>
      </div>
      {confirmErase && (
        <ConfirmDialog
          title={t('settings.eraseConfirmTitle')}
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
      {renderRestoreDialog()}
    </div>
  );
}
