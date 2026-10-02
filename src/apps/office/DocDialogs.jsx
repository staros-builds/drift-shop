import { useEffect, useState } from 'react';
import { X, FileText } from 'lucide-react';
import { listOfficeFiles, stripExt, baseName } from './util.js';
import { localeTag, useLang } from '../../lib/i18n.jsx';

function ModalShell({ title, onClose, children }) {
  const { t } = useLang();
  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-ink/30 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-md rounded-os border border-osborder bg-surface shadow-win">
        <div className="flex items-center justify-between border-b border-osborder px-4 py-3">
          <h3 className="text-sm font-semibold text-ink">{title}</h3>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('dialogs.closeDialog')}
            className="rounded-os p-1 text-muted hover:bg-paper hover:text-ink"
          >
            <X size={16} />
          </button>
        </div>
        <div className="p-4">{children}</div>
      </div>
    </div>
  );
}

/** List the user's saved documents for one office app. */
export function OpenDocModal({ ext, app, onPick, onClose }) {
  const { t } = useLang();
  const [docs, setDocs] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    listOfficeFiles(ext)
      .then((d) => {
        if (live) setDocs(d);
      })
      .catch((err) => {
        if (live) setError(err?.message || t('office.errList'));
      });
    return () => {
      live = false;
    };
  }, [ext, t]);

  return (
    <ModalShell title={t('office.openDoc', { app: t(`apps.${app}`) })} onClose={onClose}>
      {error && <p className="mb-2 text-sm text-red-700">{error}</p>}
      {docs === null && !error && <p className="text-sm text-muted">{t('office.loading')}</p>}
      {docs !== null && docs.length === 0 && (
        <p className="text-sm text-muted">
          {t('office.noDocs', { app: t(`apps.${app}`) })}
        </p>
      )}
      {docs !== null && docs.length > 0 && (
        <ul className="max-h-72 divide-y divide-osborder overflow-y-auto rounded-os border border-osborder">
          {docs.map((d) => (
            <li key={d.path}>
              <button
                type="button"
                onClick={() => onPick(d.path)}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-ink hover:bg-paper"
              >
                <FileText size={15} className="shrink-0 text-muted" />
                <span className="min-w-0 flex-1 truncate">{stripExt(baseName(d.path), ext)}</span>
                <span className="shrink-0 text-xs text-muted">
                  {d.updatedAt ? new Date(d.updatedAt).toLocaleDateString(localeTag()) : ''}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </ModalShell>
  );
}

/** Ask for a document name (Save As / untitled save). When `ext` is given, the
 *  name is checked against existing files first and the user is asked to
 *  confirm before overwriting — in the modal itself, never window.confirm(),
 *  so it works in every browser and under automation. */
export function NameModal({ initial, title, ext, onSave, onClose }) {
  const { t } = useLang();
  const [name, setName] = useState(initial || '');
  const [checking, setChecking] = useState(false);
  const [clashName, setClashName] = useState(null); // name awaiting overwrite confirm

  const submit = async () => {
    const clean = name.trim().replace(/[\\/]/g, '');
    if (!clean || checking) return;
    if (ext) {
      setChecking(true);
      try {
        const files = await listOfficeFiles(ext);
        const clash = files.some((d) => d.path === `/Documents/${clean}${ext}`);
        if (clash) {
          // Ask inside the modal instead of window.confirm(): the native
          // dialog is auto-dismissed by automated browsers (treated as
          // "cancel"), which left the dialog stuck open with no save.
          setClashName(clean);
          setChecking(false);
          return;
        }
      } catch {
        /* listing failed — let the save proceed rather than blocking it */
      }
      setChecking(false);
    }
    onSave(clean);
  };

  if (clashName) {
    return (
      <ModalShell title={title} onClose={onClose}>
        <p className="text-sm text-ink">
          {t('office.clash', { name: clashName })}
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={() => setClashName(null)}
            // eslint-disable-next-line jsx-a11y/no-autofocus
            autoFocus
            className="rounded-os border border-osborder px-3 py-1.5 text-sm text-ink hover:bg-paper"
          >
            {t('office.keepEditing')}
          </button>
          <button
            type="button"
            onClick={() => {
              setClashName(null);
              onSave(clashName);
            }}
            className="rounded-os bg-accent px-4 py-1.5 text-sm font-medium text-white"
          >
            {t('office.overwrite')}
          </button>
        </div>
      </ModalShell>
    );
  }

  return (
    <ModalShell title={title} onClose={onClose}>
      <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted">
        {t('office.docName')}
      </label>
      <input
        // eslint-disable-next-line jsx-a11y/no-autofocus
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit();
          if (e.key === 'Escape') onClose();
        }}
        className="w-full rounded-os border border-osborder bg-paper px-3 py-2 text-sm text-ink outline-none focus:border-accent"
        placeholder={t('office.myDoc')}
      />
      <div className="mt-4 flex justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          className="rounded-os border border-osborder px-3 py-1.5 text-sm text-ink hover:bg-paper"
        >
          {t('dialogs.cancel')}
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={!name.trim() || checking}
          className="rounded-os bg-accent px-4 py-1.5 text-sm font-medium text-white disabled:opacity-50"
        >
          {t('office.save')}
        </button>
      </div>
    </ModalShell>
  );
}
