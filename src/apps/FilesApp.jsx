import { useCallback, useEffect, useRef, useState } from 'react';
import {
  FilePlus, FolderPlus, Upload, Pencil, Trash2, ChevronRight,
  FileText, Folder as FolderIcon, Save, X, FileWarning, Download, ExternalLink,
  Copy, FolderInput, Loader2, AlertCircle,
  ArrowLeft, ArrowRight, ArrowUp,
} from 'lucide-react';
import { backend } from '../lib/backend/current.js';
import { useLang } from '../lib/i18n.jsx';
import { UploadJobsPanel } from './UploadJobsPanel.jsx';
import { useNotifications } from '../os/NotificationsContext.jsx';
import { useToasts } from '../os/ToastContext.jsx';
import { useWindows } from '../os/WindowsContext.jsx';

function joinPath(dir, name) {
  return dir === '/' ? `/${name}` : `${dir}/${name}`;
}
function parentOf(path) {
  const i = path.lastIndexOf('/');
  return i <= 0 ? '/' : path.slice(0, i);
}
function baseOf(path) {
  const i = path.lastIndexOf('/');
  return path.slice(i + 1);
}
function formatSize(bytes) {
  if (bytes == null || Number.isNaN(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Split "photo.png" -> { stem: "photo", ext: ".png" }; "README" -> { stem: "README", ext: "" }. */
function splitName(name) {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return { stem: name, ext: '' };
  return { stem: name.slice(0, dot), ext: name.slice(dot) };
}

/**
 * Copy a file or folder to destPath.
 *
 * Files: text goes through read+write; binary goes through the exact same
 * byte path the preview/download panel uses (fileUrl -> fetch -> Blob ->
 * upload), so bytes survive the copy on both adapters. Folders recurse.
 */
async function copyEntry(entry, destPath) {
  if (entry.type === 'folder') {
    await backend.files.mkdir(destPath);
    const children = await backend.files.list(entry.path);
    for (const child of children) {
      await copyEntry(child, joinPath(destPath, child.name));
    }
    return;
  }
  try {
    const { text } = await backend.files.read(entry.path);
    await backend.files.write(destPath, text);
  } catch (err) {
    if (err?.code !== 'IS_BINARY') throw err;
    // Binary: resolve the bytes exactly like the preview panel does, then
    // re-upload under the new name. fetch() handles both the local data URL
    // and the Supabase signed URL.
    const { url } = await backend.files.fileUrl(entry.path);
    const blob = await (await fetch(url)).blob();
    await backend.files.upload(destPath, blob);
  }
}

/** Preview/download panel for binary files (images, PDFs, …). */
function BinaryPanel({ path, size, onClose }) {
  const { t } = useLang();
  const [resolved, setResolved] = useState(null); // { url, mime, name }
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    setResolved(null);
    setError('');
    backend.files
      .fileUrl(path)
      .then((r) => {
        if (live) setResolved(r);
      })
      .catch((err) => {
        if (live) setError(err?.message || t('files.errLoadFile'));
      });
    return () => {
      live = false;
    };
  }, [path]);

  const name = baseOf(path);
  const isImage = resolved?.mime?.startsWith('image/');

  return (
    <div className="flex w-1/2 min-w-0 flex-col bg-paper">
      <div className="flex items-center justify-between border-b border-osborder px-4 py-2">
        <p className="min-w-0 flex-1 truncate text-sm font-medium">{name}</p>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('files.binary.closePreview')}
          className="rounded-os p-1 text-muted hover:bg-surface hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          <X size={16} />
        </button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 overflow-y-auto p-6 text-center">
        {error && <p className="text-sm text-red-700 dark:text-red-400">{error}</p>}
        {!error && !resolved && <p className="text-sm text-muted">{t('files.binary.loading')}</p>}
        {resolved && isImage && (
          <img
            src={resolved.url}
            alt={name}
            className="max-h-72 max-w-full rounded-os border border-osborder object-contain"
          />
        )}
        {resolved && !isImage && <FileWarning size={32} className="text-muted" />}
        {resolved && (
          <>
            <p className="text-xs text-muted">
              {resolved.mime || t('files.binary.file')} · {t('files.binary.size')}: {formatSize(size)}
            </p>
            <div className="flex gap-2">
              <a
                href={resolved.url}
                download={resolved.name || name}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-1.5 rounded-os bg-accent px-3 py-1.5 text-sm font-medium text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              >
                <Download size={15} /> {t('files.binary.download')}
              </a>
              <a
                href={resolved.url}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-1.5 rounded-os border border-osborder px-3 py-1.5 text-sm transition-colors duration-160 hover:bg-surface focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              >
                <ExternalLink size={15} /> {t('files.binary.open')}
              </a>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** Destination picker for "Move to": a navigable folder list in a modal. */
function MoveDialog({ entry, startDir, onConfirm, onClose }) {
  const { t } = useLang();
  const [dir, setDir] = useState(startDir);
  const [folders, setFolders] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    setFolders(null);
    setError('');
    backend.files
      .list(dir)
      .then((list) => {
        if (!live) return;
        // Hide the entry itself and its descendants — the backend refuses
        // moving a folder into itself anyway, so don't offer it.
        const prefix = entry.type === 'folder' ? `${entry.path}/` : null;
        setFolders(
          list
            .filter((e) => e.type === 'folder')
            .map((e) => e.name)
            .filter((name) => {
              const p = joinPath(dir, name);
              return p !== entry.path && (!prefix || !p.startsWith(prefix));
            })
        );
      })
      .catch((err) => {
        if (live) setError(err?.message || t('files.errListFolders'));
      });
    return () => {
      live = false;
    };
  }, [dir, entry]);

  const alreadyHere = dir === parentOf(entry.path);
  const label = dir === '/' ? t('files.home') : dir;

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-ink/30 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-[80%] w-80 flex-col rounded-os border border-osborder bg-surface shadow-win">
        <div className="border-b border-osborder px-4 py-3">
          <h3 className="truncate text-sm font-semibold text-ink">{t('files.move.title', { name: entry.name })}</h3>
          <p className="truncate text-xs text-muted">{label}</p>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 py-1">
          {dir !== '/' && (
            <button
              type="button"
              onClick={() => setDir(parentOf(dir))}
              aria-label={t('files.move.goParent')}
              className="flex w-full items-center gap-2 rounded-os px-2 py-1.5 text-sm text-muted hover:bg-paper hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              <FolderIcon size={15} /> …
            </button>
          )}
          {folders === null && !error && (
            <p className="px-2 py-4 text-center text-sm text-muted">{t('files.loading')}</p>
          )}
          {error && <p className="px-2 py-4 text-center text-sm text-red-700 dark:text-red-400">{error}</p>}
          {folders !== null && folders.length === 0 && (
            <p className="px-2 py-4 text-center text-sm text-muted">{t('files.move.noSub')}</p>
          )}
          {folders !== null &&
            folders.map((name) => (
              <button
                key={name}
                type="button"
                onClick={() => setDir(joinPath(dir, name))}
                className="flex w-full items-center gap-2 rounded-os px-2 py-1.5 text-sm hover:bg-paper focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              >
                <FolderIcon size={15} className="shrink-0 text-muted" />
                <span className="truncate">{name}</span>
              </button>
            ))}
        </div>
        <div className="flex justify-end gap-2 border-t border-osborder px-3 py-2.5">
          <button
            type="button"
            onClick={onClose}
            className="rounded-os border border-osborder px-3 py-1.5 text-sm transition-colors duration-160 hover:bg-paper focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            {t('dialogs.cancel')}
          </button>
          <button
            type="button"
            onClick={() => onConfirm(dir)}
            disabled={alreadyHere}
            title={alreadyHere ? t('files.move.alreadyHere') : t('files.move.moveToTitle', { label })}
            className="rounded-os bg-accent px-3 py-1.5 text-sm font-medium text-white transition-opacity duration-160 disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            {t('files.move.moveHere')}
          </button>
        </div>
      </div>
    </div>
  );
}

/** In-app replacement for window.prompt(): asks for a file/folder name. */
function NamePromptDialog({ kind, onSubmit, onClose, checkExists }) {
  const { t } = useLang();
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const raw = value.trim();
    if (!raw) {
      setError(t('files.nameRequired'));
      return;
    }
    // Reject path separators loudly instead of silently stripping them —
    // silent mutation confuses users ("I typed a/b, where did my slash go?").
    // Control chars (0x00-0x1F, 0x7F) break storage paths, logs, and UIs.
    if (/[/\\]/.test(raw)) {
      setError(t('files.nameNoSlashes'));
      return;
    }
    const name = raw;
    if (/[\x00-\x1f\x7f]/.test(name)) {
      setError(t('files.nameInvalid'));
      return;
    }
    if (!name) {
      setError(t('files.nameRequired'));
      return;
    }
    // NUCLEAR FAILSAFE: 255-char max. Supabase storage paths and most
    // filesystems break beyond this; reject instead of truncating silently.
    if (name.length > 255) {
      setError(t('files.nameTooLong'));
      return;
    }
    // Reject '.' and '..' — these are path traversal risks, not valid names.
    if (name === '.' || name === '..') {
      setError(t('files.nameInvalid'));
      return;
    }
    // NUCLEAR FAILSAFE: collision check inline — the dialog stays open with
    // the error visible instead of closing and toasting (easy to miss).
    if (checkExists) {
      setBusy(true);
      try {
        if (await checkExists(name)) {
          setError(t('files.nameExists', { name }));
          setBusy(false);
          return;
        }
      } catch {
        setError(t('files.listFail'));
        setBusy(false);
        return;
      }
      setBusy(false);
    }
    onSubmit(name);
  };

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-ink/30 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-80 rounded-os border border-osborder bg-surface shadow-win">
        <div className="border-b border-osborder px-4 py-3">
          <h3 className="text-sm font-semibold text-ink">
            {kind === 'folder' ? t('files.namePrompt.newFolder') : t('files.namePrompt.newFile')}
          </h3>
        </div>
        <div className="p-4">
          <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted">
            {t('files.namePrompt.nameLabel')}
          </label>
          <input
            // eslint-disable-next-line jsx-a11y/no-autofocus
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit();
              if (e.key === 'Escape') onClose();
            }}
            className="w-full rounded-os border border-osborder bg-paper px-3 py-2 text-sm text-ink outline-none focus:border-accent"
            placeholder={kind === 'folder' ? t('files.namePrompt.myFolder') : t('files.namePrompt.myFile')}
          />
          {error && <p className="mt-2 text-sm text-red-700 dark:text-red-400">{error}</p>}
          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-os border border-osborder px-3 py-1.5 text-sm transition-colors duration-160 hover:bg-paper focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              {t('dialogs.cancel')}
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={!value.trim() || busy}
              className="rounded-os bg-accent px-4 py-1.5 text-sm font-medium text-white disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              {t('files.namePrompt.create')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** In-app replacement for window.confirm(): delete confirmation. */
function DeleteConfirmDialog({ entry, onConfirm, onClose }) {
  const { t } = useLang();
  const kind = entry.type === 'folder' ? 'folder and everything in it' : 'file';
  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-ink/30 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-80 rounded-os border border-osborder bg-surface shadow-win">
        <div className="border-b border-osborder px-4 py-3">
          <h3 className="text-sm font-semibold text-ink">{entry.type === 'folder' ? t('files.delConfirm.folderTitle') : t('files.delConfirm.fileTitle')}</h3>
        </div>
        <div className="p-4">
          <p className="text-sm text-ink">
            {entry.type === 'folder'
              ? t('files.delConfirm.folderMsg', { name: entry.name })
              : t('files.delConfirm.fileMsg', { name: entry.name })}
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              // eslint-disable-next-line jsx-a11y/no-autofocus
              autoFocus
              className="rounded-os border border-osborder px-3 py-1.5 text-sm transition-colors duration-160 hover:bg-paper focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              {t('dialogs.cancel')}
            </button>
            <button
              type="button"
              onClick={onConfirm}
              onKeyDown={(e) => {
                if (e.key === 'Enter') onConfirm();
              }}
              className="rounded-os bg-red-700 px-4 py-1.5 text-sm font-medium text-white hover:bg-red-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              {t('files.delete')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * In-app replacement for window.confirm(): a generic yes/no dialog.
 * Used anywhere the app needs a destructive/discard confirmation without
 * touching the native confirm().
 */
function ConfirmDialog({ title, message, confirmLabel, onConfirm, onClose }) {
  const { t } = useLang();
  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-ink/30 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="w-80 rounded-os border border-osborder bg-surface shadow-win"
      >
        <div className="border-b border-osborder px-4 py-3">
          <h3 className="text-sm font-semibold text-ink">{title}</h3>
        </div>
        <div className="p-4">
          <p className="text-sm text-ink">{message}</p>
          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              // eslint-disable-next-line jsx-a11y/no-autofocus
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Escape') onClose();
              }}
              className="rounded-os border border-osborder px-3 py-1.5 text-sm transition-colors duration-160 hover:bg-paper focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              {t('dialogs.cancel')}
            </button>
            <button
              type="button"
              onClick={onConfirm}
              className="rounded-os bg-accent px-4 py-1.5 text-sm font-medium text-white transition-opacity duration-160 hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              {confirmLabel || t('dialogs.confirm')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Explorer-style address bar: an editable path field. Enter commits. */
function AddressBar({ path, onGo }) {
  const { t } = useLang();
  const [text, setText] = useState(path);
  const [editing, setEditing] = useState(false);

  // Follow external navigation while the user isn't typing.
  useEffect(() => {
    if (!editing) setText(path);
  }, [path, editing]);

  const commit = () => {
    setEditing(false);
    let p = text.trim();
    if (!p) {
      setText(path);
      return;
    }
    if (!p.startsWith('/')) p = `/${p}`;
    p = p.replace(/\/{2,}/g, '/');
    if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
    if (p !== path) onGo(p);
    else setText(path);
  };

  return (
    <div className="flex items-center gap-2 border-b border-osborder bg-surface px-3 py-1.5">
      <span className="shrink-0 text-xs font-medium uppercase tracking-wide text-muted">
        {t('files.address.label')}
      </span>
      <input
        aria-label={t('files.address.label')}
        value={text}
        spellCheck={false}
        onFocus={() => setEditing(true)}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          if (e.key === 'Escape') {
            setText(path);
            setEditing(false);
            e.target.blur();
          }
        }}
        onBlur={() => {
          setEditing(false);
          setText(path);
        }}
        className="min-w-0 flex-1 rounded-os border border-osborder bg-paper px-2 py-1 font-mono text-sm text-ink outline-none focus:border-accent"
      />
      <button
        type="button"
        onClick={commit}
        onMouseDown={(e) => e.preventDefault()}
        aria-label={t('files.address.goTitle')}
        title={t('files.address.goTitle')}
        className="shrink-0 rounded-os border border-osborder bg-paper px-3 py-1 text-sm transition-colors duration-160 hover:bg-surface focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        {t('files.address.go')}
      </button>
    </div>
  );
}

/**
 * Explorer-style folder tree (left pane). Children load lazily per expanded
 * folder; the cache is dropped whenever `treeBump` changes (a mutation
 * happened) so renames/moves/deletes show up.
 */
function FolderTree({ cwd, onNavigate, treeBump }) {
  const { t } = useLang();
  const [expanded, setExpanded] = useState(() => new Set(['/']));
  const [kids, setKids] = useState({}); // path -> [child folder names]
  const [failed, setFailed] = useState({}); // path -> true (list failed)

  // Drop cached children on any tree mutation.
  useEffect(() => {
    setKids({});
    setFailed({});
  }, [treeBump]);

  // Keep the ancestor chain of the current folder expanded.
  useEffect(() => {
    setExpanded((prev) => {
      const next = new Set(prev);
      let p = cwd;
      for (;;) {
        next.add(p);
        if (p === '/') break;
        p = parentOf(p);
      }
      return next;
    });
  }, [cwd]);

  // Lazily fetch children for expanded folders we haven't loaded.
  useEffect(() => {
    let live = true;
    const wanted = [...expanded].filter((p) => !(p in kids) && !(p in failed));
    if (wanted.length === 0) return undefined;
    (async () => {
      for (const p of wanted) {
        try {
          const list = await backend.files.list(p);
          if (!live) return;
          const names = list
            .filter((e) => e.type === 'folder')
            .map((e) => e.name)
            .sort((a, b) => a.localeCompare(b));
          setKids((k) => (p in k ? k : { ...k, [p]: names }));
        } catch {
          if (!live) return;
          setFailed((f) => (p in f ? f : { ...f, [p]: true }));
        }
      }
    })();
    return () => {
      live = false;
    };
  }, [expanded, kids, failed, treeBump]);

  const toggle = (p) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });
  };

  const renderNode = (p, depth) => {
    const name = p === '/' ? t('files.home') : baseOf(p);
    const isOpen = expanded.has(p);
    const isCurrent = p === cwd;
    const children = kids[p] || [];
    return (
      <div key={p} role="treeitem" aria-expanded={isOpen} aria-selected={isCurrent}>
        <div className="flex min-w-0 items-center">
          <button
            type="button"
            onClick={() => toggle(p)}
            aria-label={isOpen ? t('files.tree.collapse', { name }) : t('files.tree.expand', { name })}
            className="shrink-0 rounded-os p-0.5 text-muted hover:bg-surface hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            <ChevronRight
              size={14}
              className={`transition-transform duration-160 ${isOpen ? 'rotate-90' : ''}`}
            />
          </button>
          <button
            type="button"
            onClick={() => onNavigate(p)}
            aria-label={t('files.tree.open', { name })}
            title={p}
            className={`flex min-w-0 flex-1 items-center gap-1.5 rounded-os px-1.5 py-1 text-left text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
              isCurrent ? 'bg-accent font-medium text-accentink' : 'text-ink hover:bg-surface'
            }`}
          >
            <FolderIcon size={15} className="shrink-0" />
            <span className="truncate">{name}</span>
          </button>
        </div>
        {isOpen && (
          <div style={{ paddingLeft: 14 }}>
            {children.map((n) => renderNode(joinPath(p, n), depth + 1))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div
      role="tree"
      aria-label={t('files.tree.folders')}
      className="h-full overflow-y-auto border-r border-osborder bg-surface px-1.5 py-2"
    >
      {renderNode('/', 0)}
    </div>
  );
}

export default function FilesApp({ windowApi }) {
  const { t } = useLang();
  const { push } = useNotifications();
  const { pushToast } = useToasts();
  const { openWindow } = useWindows();
  const [cwd, setCwd] = useState('/');
  const [entries, setEntries] = useState([]);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState('');
  const [selected, setSelected] = useState(null);
  // Explorer-style navigation history: Back / Forward walk this stack.
  // navRef mirrors navState so rapid clicks compute from current values.
  const [navState, setNavState] = useState({ hist: ['/'], idx: 0 });
  const navRef = useRef(navState);
  const applyNav = (next, target) => {
    navRef.current = next;
    setNavState(next);
    setCwd(target);
  };
  // Bumped after every tree mutation so the folder tree drops its cache.
  const [treeBump, setTreeBump] = useState(0);
  const bumpTree = useCallback(() => setTreeBump((b) => b + 1), []);
  const [renaming, setRenaming] = useState(null); // entry name being renamed inline
  const [renameValue, setRenameValue] = useState('');
  const [editor, setEditor] = useState(null); // { path, text, original }
  const [binaryView, setBinaryView] = useState(null); // { path, size }
  const [moveEntry, setMoveEntry] = useState(null); // entry awaiting a destination pick
  const [namePrompt, setNamePrompt] = useState(null); // 'file' | 'folder' | null — new name dialog
  const [deleteTarget, setDeleteTarget] = useState(null); // entry awaiting delete confirmation
  const [dirtyPrompt, setDirtyPrompt] = useState(null); // { title, message, confirmLabel, onConfirm } | null
  const [uploadJobs, setUploadJobs] = useState([]); // [{ id, name, status: 'uploading'|'done'|'error', error }]
  const fileInputRef = useRef(null);
  // Guards the rename commit so Enter (keydown) + blur can't fire it twice.
  const renameCommitRef = useRef(false);
  // Drag-and-drop upload overlay state.
  const [dragActive, setDragActive] = useState(false);
  const dragCounter = useRef(0);

  const fail = useCallback(
    (key, err) => push(t('files.notifError'), `${t(key)}: ${err?.message || err}`),
    [push, t]
  );

  // Generation guard: if the user navigates again while a listing is in
  // flight, the stale response is dropped instead of overwriting the
  // current folder's entries.
  const listGen = useRef(0);
  const refresh = useCallback(
    async (path) => {
      const gen = ++listGen.current;
      setListLoading(true);
      setListError('');
      try {
        const list = await backend.files.list(path);
        if (gen !== listGen.current) return; // stale — a newer listing won
        setEntries(list);
        setSelected(null);
      } catch (err) {
        if (gen !== listGen.current) return;
        setListError(err?.message || t('files.errListFolder'));
        fail('files.errList', err);
      } finally {
        if (gen === listGen.current) setListLoading(false);
      }
    },
    [fail]
  );

  useEffect(() => {
    refresh(cwd);
  }, [cwd, refresh]);

  useEffect(() => {
    windowApi?.setTitle?.(cwd === '/' ? t('apps.files') : t('files.titleWith', { name: cwd }));
  }, [cwd, windowApi, t]);

  const dirty = editor && editor.text !== editor.original;

  // Runs `action` once unsaved editor changes are dealt with: if the editor
  // is dirty, an in-app ConfirmDialog (never window.confirm()) asks whether
  // to discard them; on confirm the changes are dropped and `action` runs.
  const withCleanEditor = (action) => {
    if (!dirty) {
      action();
      return;
    }
    setDirtyPrompt({
      title: t('files.discardTitle'),
      message: t('files.discardMsg', { name: baseOf(editor.path) }),
      confirmLabel: t('files.discardConfirm'),
      onConfirm: () => {
        setDirtyPrompt(null);
        setEditor(null);
        action();
      },
    });
  };

  const navigate = (path) => {
    withCleanEditor(() => {
      setEditor(null);
      setBinaryView(null);
      const n = navRef.current;
      const truncated = n.hist.slice(0, n.idx + 1);
      // Navigating to the current folder is a no-op (no duplicate entry).
      if (truncated[truncated.length - 1] === path) return;
      applyNav({ hist: [...truncated, path], idx: truncated.length }, path);
    });
  };

  // Walk the history stack without pushing (Back / Forward buttons).
  const travel = (delta) => {
    withCleanEditor(() => {
      setEditor(null);
      setBinaryView(null);
      const n = navRef.current;
      const idx = Math.min(Math.max(n.idx + delta, 0), n.hist.length - 1);
      const target = n.hist[idx];
      if (target === undefined || target === cwd) return;
      applyNav({ hist: n.hist, idx }, target);
    });
  };
  const goBack = () => travel(-1);
  const goForward = () => travel(1);
  const goUp = () => {
    if (cwd !== '/') navigate(parentOf(cwd));
  };

  // Address bar: verify the folder exists before navigating, so a typo
  // shows a notice instead of stranding the view on a dead path.
  const goToAddress = async (path) => {
    try {
      await backend.files.list(path);
    } catch (err) {
      push(t('files.notifNotFound'), t('files.notFoundMsg', { path }));
      return;
    }
    navigate(path);
  };

  // New file / folder go through an in-app dialog (NamePromptDialog), never
  // window.prompt(), so they work in every browser and under automation.
  const handleNamePromptSubmit = async (name) => {
    const kind = namePrompt; // 'file' | 'folder'
    setNamePrompt(null);
    try {
      // Defense in depth: the dialog already checked, but re-check here in
      // case the folder changed between dialog open and submit.
      const existing = new Set((await backend.files.list(cwd)).map((e) => e.name));
      if (existing.has(name)) {
        fail(kind === 'folder' ? 'files.errCreateFolder' : 'files.errCreateFile',
          new Error(t('files.nameExists', { name })));
        return;
      }
      if (kind === 'folder') {
        await backend.files.mkdir(joinPath(cwd, name));
      } else {
        await backend.files.write(joinPath(cwd, name), '');
      }
      await refresh(cwd);
      bumpTree();
    } catch (err) {
      fail(kind === 'folder' ? 'files.errCreateFolder' : 'files.errCreateFile', err);
    }
  };

  // Upload: text files are stored as editable text, everything else goes up
  // as binary (images, PDFs, videos, …) with preview/download support.
  // No type allowlist — any file kind is accepted, up to the backend size cap.
  // The backends do single-shot uploads with no progress events, so instead
  // of faking percentages the panel shows each file's real state:
  // uploading / done / failed (with the actual error).
  const TEXT_EXTENSIONS =
    /\.(txt|md|markdown|json|js|jsx|ts|tsx|html|htm|css|csv|xml|yaml|yml|log|ini|cfg|toml|sql|py|sh)$/i;
  const uploadFiles = async (fileList) => {
    const picked = Array.from(fileList || []);
    if (picked.length === 0) return;
    const jobs = picked.map((file, i) => ({
      id: `up-${Date.now()}-${i}`,
      name: file.name || t('files.uploadedDefault'),
      status: 'uploading',
      error: '',
      // progress: null = indeterminate (local backend / no byte events);
      // number 0..1 = real cloud upload percentage.
      progress: null,
    }));
    setUploadJobs((prev) => [...prev, ...jobs]);
    let ok = 0;
    for (let i = 0; i < picked.length; i++) {
      const file = picked[i];
      const jobId = jobs[i].id;
      const mark = (status, error = '') =>
        setUploadJobs((js) => js.map((j) => (j.id === jobId ? { ...j, status, error } : j)));
      // Real byte progress from the cloud backend (xhr upload events).
      // The local backend never calls this, so progress stays null and the
      // panel shows an honest indeterminate bar rather than a fake percent.
      const onProgress = (sent, total) =>
        setUploadJobs((js) =>
          js.map((j) =>
            j.id === jobId
              ? { ...j, progress: total > 0 ? Math.min(1, Math.max(0, sent / total)) : null }
              : j
          )
        );
      try {
        const rawName = file.name.replace(/\//g, '') || t('files.uploadedDefault');
        // NUCLEAR FAILSAFE: reject '.' and '..' as filenames (path traversal).
        // NUCLEAR FAILSAFE: check for collision before uploading. Uploading
        // over an existing file would silently destroy data.
        const name = (rawName === '.' || rawName === '..') ? t('files.uploadedDefault') : rawName;
        const dest = joinPath(cwd, name);
        const existing = await backend.files.list(cwd).catch(() => []);
        if (existing.some((e) => e.name.toLowerCase() === name.toLowerCase())) {
          fail('files.errUploadCollision', new Error(name));
          continue;
        }
        const looksText =
          (file.type && file.type.startsWith('text/')) ||
          file.type === 'application/json' ||
          TEXT_EXTENSIONS.test(name);
        if (looksText) {
          const text = await file.text();
          await backend.files.write(dest, text);
        } else {
          await backend.files.upload(dest, file, onProgress);
        }
        ok += 1;
        mark('done');
      } catch (err) {
        mark('error', err?.message || t('files.errUpload'));
      }
    }
    if (ok > 0) {
      const where = cwd === '/' ? t('apps.files') : cwd;
      push(t('files.notifUploaded'), ok === 1 ? t('files.uploadedOne', { where }) : t('files.uploadedMany', { n: ok, where }));
      await refresh(cwd);
      bumpTree();
    }
  };
  const handleUploadPick = async (e) => {
    // Snapshot the list FIRST: e.target.files is a *live* FileList — clearing
    // the input's value below empties it, so Array.from() must run before.
    const picked = Array.from(e.target.files || []);
    e.target.value = '';
    await uploadFiles(picked);
  };

  const handleDragEnter = (e) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current += 1;
    if (e.dataTransfer?.types?.includes('Files')) setDragActive(true);
  };
  const handleDragOver = (e) => {
    e.preventDefault();
    e.stopPropagation();
  };
  const handleDragLeave = (e) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current -= 1;
    if (dragCounter.current <= 0) {
      dragCounter.current = 0;
      setDragActive(false);
    }
  };
  const handleDrop = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current = 0;
    setDragActive(false);
    await uploadFiles(e.dataTransfer?.files);
  };

  const openEntry = (entry) => {
    const path = entry.path;
    if (entry.type === 'folder') {
      navigate(path);
      return;
    }
    // Office documents open in their apps.
    const lower = path.toLowerCase();
    if (lower.endsWith('.drift-doc')) {
      openWindow('writer', { path });
      return;
    }
    if (lower.endsWith('.drift-sheet')) {
      openWindow('sheets', { path });
      return;
    }
    if (lower.endsWith('.drift-slides')) {
      openWindow('slides', { path });
      return;
    }
    // Media files open in their dedicated apps (Pictures / Video / Music).
    if (/\.(png|jpe?g|gif|webp|bmp|svg|avif|ico)$/.test(lower)) {
      openWindow('pictures', { path });
      return;
    }
    if (/\.(mp4|webm|ogv|mov|mkv|avi|m4v)$/.test(lower)) {
      openWindow('video', { path });
      return;
    }
    if (/\.(mp3|wav|ogg|oga|m4a|flac|opus|weba)$/.test(lower)) {
      openWindow('music', { path });
      return;
    }
    // PDFs open in the PDF viewer app.
    if (lower.endsWith('.pdf')) {
      openWindow('pdfviewer', { path });
      return;
    }
    withCleanEditor(async () => {
      try {
        const { text } = await backend.files.read(path);
        setBinaryView(null);
        setEditor({ path, text, original: text });
      } catch (err) {
        if (err?.code === 'IS_BINARY') {
          setEditor(null);
          setBinaryView({ path, size: entry.size });
        } else {
          fail('files.errOpen', err);
        }
      }
    });
  };

  const handleSaveEditor = async () => {
    if (!editor) return;
    try {
      await backend.files.write(editor.path, editor.text);
      setEditor({ ...editor, original: editor.text });
      await refresh(cwd);
    } catch (err) {
      fail('files.errSave', err);
    }
  };

  const handleCancelEditor = () => {
    withCleanEditor(() => setEditor(null));
  };

  const startRename = (entry) => {
    renameCommitRef.current = false;
    setRenaming(entry.name);
    setRenameValue(entry.name);
  };

  const commitRename = async () => {
    // Enter commits and the input unmounts, which fires blur on the stale
    // closure — the guard makes the second call a no-op so the rename
    // runs exactly once.
    if (renameCommitRef.current) return;
    renameCommitRef.current = true;
    try {
      const rawName = renameValue.trim();
      // Reject slashes loudly — silent stripping confuses users.
      if (/[/\\]/.test(rawName)) {
        fail('files.errRename', new Error(t('files.nameNoSlashes')));
        setRenaming(null);
        return;
      }
      const name = rawName;
      setRenaming(null);
      if (!name || name === renaming) return;
      // NUCLEAR FAILSAFE: reject '.'/'..' (path traversal) and existing names
      // (collision = silent data loss / overwrite).
      if (name === '.' || name === '..') {
        fail('files.errRename', new Error(t('files.nameInvalid')));
        return;
      }
      if (entries.some((e) => e.name === name)) {
        fail('files.errRename', new Error(t('files.nameExists', { name })));
        return;
      }
      const entry = entries.find((e) => e.name === renaming);
      if (!entry) return;
      const newPath = joinPath(parentOf(entry.path), name);
      await backend.files.rename(entry.path, newPath);
      if (editor && editor.path === entry.path) {
        setEditor((ed) => ({ ...ed, path: newPath }));
      }
      await refresh(cwd);
      bumpTree();
    } catch (err) {
      fail('files.errRename', err);
    } finally {
      renameCommitRef.current = false;
    }
  };

  const handleCopy = async (entry) => {
    try {
      const existing = new Set((await backend.files.list(cwd)).map((e) => e.name));
      const { stem, ext } = splitName(entry.name);
      let candidate = t('files.copyName', { stem, ext });
      let n = 2;
      while (existing.has(candidate)) {
        candidate = t('files.copyNameN', { stem, ext, n });
        n += 1;
      }
      await copyEntry(entry, joinPath(cwd, candidate));
      push(t('files.notifCopied'), t('files.copiedMsg', { name: entry.name, candidate }));
      await refresh(cwd);
      bumpTree();
    } catch (err) {
      fail('files.errCopy', err);
    }
  };

  const handleMoveConfirm = async (destDir) => {
    const entry = moveEntry;
    setMoveEntry(null);
    if (!entry) return;
    const destPath = joinPath(destDir, entry.name);
    if (destPath === entry.path) return;
    // NUCLEAR FAILSAFE: check for collision before moving. Moving onto an
    // existing entry would silently destroy data.
    try {
      const destEntries = await backend.files.list(destDir);
      const existing = new Set(destEntries.map((e) => e.name.toLowerCase()));
      if (existing.has(entry.name.toLowerCase())) {
        fail('files.errMoveCollision');
        return;
      }
    } catch (err) {
      fail('files.errMove', err);
      return;
    }
    try {
      await backend.files.rename(entry.path, destPath);
      // Keep any open panes pointing at the moved entry.
      const rebase = (p) =>
        p === entry.path || (entry.type === 'folder' && p.startsWith(`${entry.path}/`))
          ? destPath + p.slice(entry.path.length)
          : p;
      setEditor((ed) => (ed ? { ...ed, path: rebase(ed.path) } : ed));
      setBinaryView((bv) => (bv ? { ...bv, path: rebase(bv.path) } : bv));
      push(t('files.notifMoved'), t('files.movedMsg', { name: entry.name, where: destDir === '/' ? t('files.home') : destDir }));
      await refresh(cwd);
      bumpTree();
    } catch (err) {
      fail('files.errMove', err);
    }
  };

  // Delete is a two-step flow: the toolbar button, row trash icon, or Delete
  // key stages the entry in deleteTarget, and DeleteConfirmDialog asks for
  // confirmation in-app (never window.confirm(), so it works everywhere).
  // For FILES the contents are stashed before deleting so a toast can offer
  // Undo (folders are deleted without undo — said honestly in the dialog).
  const selectedEntry = entries.find((e) => e.name === selected) || null;

  // Files over this are not stashed for undo — re-reading tens of megabytes
  // just to delete them is wasteful. The delete still proceeds, without Undo.
  const UNDO_STASH_LIMIT = 25 * 1024 * 1024;

  // Stash a file's contents so a delete can be undone. Text goes through
  // read() (large text stored via the binary path decodes back to text);
  // genuine binary goes through fileUrl -> fetch -> Blob. Returns null when
  // the file can't be stashed — the delete still proceeds, just without Undo.
  const stashFileContents = async (entry) => {
    if (entry.type !== 'file') return null;
    if (entry.size != null && entry.size > UNDO_STASH_LIMIT) return null;
    try {
      const { text } = await backend.files.read(entry.path);
      return { kind: 'text', text };
    } catch (err) {
      if (err?.code !== 'IS_BINARY') return null;
      try {
        const { url } = await backend.files.fileUrl(entry.path);
        const res = await fetch(url);
        if (!res.ok) return null;
        return { kind: 'binary', blob: await res.blob() };
      } catch {
        return null;
      }
    }
  };

  const confirmDelete = async () => {
    const entry = deleteTarget;
    setDeleteTarget(null);
    if (!entry) return;
    const stash = await stashFileContents(entry);
    try {
      await backend.files.remove(entry.path);
      if (editor?.path === entry.path) setEditor(null);
      if (binaryView?.path === entry.path) setBinaryView(null);
      await refresh(cwd);
      bumpTree();
      if (stash) {
        pushToast({
          title: t('files.deletedTitle', { name: entry.name }),
          message: '',
          actionLabel: t('files.undo'),
          onAction: async () => {
            try {
              if (stash.kind === 'text') {
                await backend.files.write(entry.path, stash.text);
              } else {
                await backend.files.upload(entry.path, stash.blob);
              }
              await refresh(cwd);
              push(t('files.notifRestored'), t('files.restoredMsg', { name: entry.name }));
            } catch (err) {
              fail('files.errRestore', err);
            }
          },
        });
      }
    } catch (err) {
      fail('files.errDelete', err);
    }
  };

  const onListKeyDown = (e) => {
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
    if (renaming) return;
    if (e.key === 'Delete') {
      if (selectedEntry) {
        e.preventDefault();
        setDeleteTarget(selectedEntry);
      }
      return;
    }
    // Explorer-style keys: Enter opens, F2 renames, Backspace goes up.
    if (e.key === 'Enter' && selectedEntry) {
      e.preventDefault();
      openEntry(selectedEntry);
      return;
    }
    if (e.key === 'F2' && selectedEntry) {
      e.preventDefault();
      startRename(selectedEntry);
      return;
    }
    if (e.key === 'Backspace') {
      e.preventDefault();
      goUp();
    }
  };

  return (
    <div
      className="relative flex h-full flex-col bg-paper text-ink"
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {dragActive && (
        <div className="pointer-events-none absolute inset-0 z-50 flex flex-col items-center justify-center gap-3 border-4 border-dashed border-accent bg-accent/10 backdrop-blur-[1px]">
          <Upload size={44} className="text-accent" />
          <p className="text-lg font-semibold text-ink">{t('files.dragTitle')}</p>
          <p className="text-sm text-ink/60">{t('files.dragSub', { where: cwd === '/' ? t('apps.files') : cwd })}</p>
        </div>
      )}
      {/* Toolbar: navigation + actions */}
      <div className="flex items-center gap-1.5 border-b border-osborder bg-surface px-3 py-2">
        <button
          onClick={goBack}
          disabled={navState.idx <= 0}
          aria-label={t('files.back')}
          title={t('files.back')}
          className="rounded-os p-1.5 text-ink transition-colors duration-160 hover:bg-paper disabled:opacity-35 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          <ArrowLeft size={17} />
        </button>
        <button
          onClick={goForward}
          disabled={navState.idx >= navState.hist.length - 1}
          aria-label={t('files.forward')}
          title={t('files.forward')}
          className="rounded-os p-1.5 text-ink transition-colors duration-160 hover:bg-paper disabled:opacity-35 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          <ArrowRight size={17} />
        </button>
        <button
          onClick={goUp}
          disabled={cwd === '/'}
          aria-label={t('files.up')}
          title={t('files.upTitle')}
          className="rounded-os p-1.5 text-ink transition-colors duration-160 hover:bg-paper disabled:opacity-35 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          <ArrowUp size={17} />
        </button>
        <span aria-hidden className="mx-1 h-5 w-px shrink-0 bg-osborder" />
        <button
          onClick={() => setNamePrompt('file')}
          className="flex items-center gap-1.5 rounded-os border border-osborder bg-paper px-2.5 py-1.5 text-sm transition-colors duration-160 hover:bg-surface focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          <FilePlus size={15} /> {t('files.newFile')}
        </button>
        <button
          onClick={() => setNamePrompt('folder')}
          className="flex items-center gap-1.5 rounded-os border border-osborder bg-paper px-2.5 py-1.5 text-sm transition-colors duration-160 hover:bg-surface focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          <FolderPlus size={15} /> {t('files.newFolder')}
        </button>
        <button
          onClick={() => fileInputRef.current?.click()}
          title={t('files.uploadTitle')}
          className="flex items-center gap-1.5 rounded-os bg-accent px-2.5 py-1.5 text-sm font-medium text-white transition-colors duration-160 hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          <Upload size={15} /> {t('files.upload')}
        </button>
        <button
          onClick={() => selectedEntry && setDeleteTarget(selectedEntry)}
          disabled={!selectedEntry}
          title={selectedEntry ? t('files.delSelTitle', { name: selectedEntry.name }) : t('files.delNoneTitle')}
          aria-label={selectedEntry ? t('files.delSelAria', { name: selectedEntry.name }) : t('files.delNoneAria')}
          className="flex items-center gap-1.5 rounded-os border border-osborder bg-paper px-2.5 py-1.5 text-sm transition-colors duration-160 hover:bg-surface disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          <Trash2 size={15} /> {t('files.delete')}
        </button>
        <input ref={fileInputRef} type="file" multiple className="hidden" onChange={handleUploadPick} />
      </div>

      {/* Address bar */}
      <AddressBar path={cwd} onGo={goToAddress} />

      {/* Body */}
      <div className="flex min-h-0 flex-1">
        {/* Folder tree */}
        <div className="hidden w-44 shrink-0 sm:block md:w-52">
          <FolderTree cwd={cwd} onNavigate={navigate} treeBump={treeBump} />
        </div>
        <div
          className={`${editor || binaryView ? 'w-1/2 border-r border-osborder' : 'w-full'} min-w-0 overflow-y-auto outline-none`}
          tabIndex={0}
          onKeyDown={onListKeyDown}
          title={t('files.listTip')}
        >
          {listError ? (
            <div className="flex flex-col items-center gap-3 px-4 py-12 text-center">
              <AlertCircle size={32} className="text-red-700 dark:text-red-400" />
              <div>
                <p className="text-sm font-medium text-ink">{t('files.errOpenFolder')}</p>
                <p className="mt-1 text-sm text-muted">{listError}</p>
              </div>
              <button
                type="button"
                onClick={() => refresh(cwd)}
                className="rounded-os bg-accent px-3 py-1.5 text-sm font-medium text-white transition-opacity duration-160 hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              >
                {t('files.tryAgain')}
              </button>
            </div>
          ) : listLoading && entries.length === 0 ? (
            <div className="flex items-center justify-center gap-2 px-4 py-12 text-sm text-muted">
              <Loader2 size={16} className="animate-spin" aria-hidden />
              <span role="status">{t('files.loadingFolder')}</span>
            </div>
          ) : entries.length === 0 ? (
            <div className="flex flex-col items-center gap-3 px-4 py-12 text-center">
              <FolderIcon size={40} className="text-muted/60" aria-hidden />
              <div>
                <p className="text-sm font-medium text-ink">{t('files.emptyTitle')}</p>
                <p className="mt-1 text-sm text-muted">{t('files.emptyHint')}</p>
              </div>
              <div className="flex flex-wrap justify-center gap-2">
                <button
                  type="button"
                  onClick={() => setNamePrompt('file')}
                  className="flex items-center gap-1.5 rounded-os border border-osborder bg-surface px-2.5 py-1.5 text-sm transition-colors duration-160 hover:bg-paper focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                >
                  <FilePlus size={15} /> {t('files.newFile')}
                </button>
                <button
                  type="button"
                  onClick={() => setNamePrompt('folder')}
                  className="flex items-center gap-1.5 rounded-os border border-osborder bg-surface px-2.5 py-1.5 text-sm transition-colors duration-160 hover:bg-paper focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                >
                  <FolderPlus size={15} /> {t('files.newFolder')}
                </button>
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="flex items-center gap-1.5 rounded-os bg-accent px-2.5 py-1.5 text-sm font-medium text-white transition-opacity duration-160 hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                >
                  <Upload size={15} /> {t('files.upload')}
                </button>
              </div>
            </div>
          ) : (
            <ul>
              {entries.map((entry) => {
                const isSel = selected === entry.name;
                const isRenaming = renaming === entry.name;
                return (
                  <li key={entry.path}>
                    <div
                      onClick={() => setSelected(entry.name)}
                      onDoubleClick={() => openEntry(entry)}
                      className={`flex cursor-default items-center gap-2 px-3 py-1.5 text-sm ${
                        isSel ? 'bg-accent text-accentink' : 'hover:bg-surface'
                      }`}
                    >
                      {entry.type === 'folder' ? (
                        <FolderIcon size={16} className={isSel ? 'text-accentink' : 'text-muted'} />
                      ) : (
                        <FileText size={16} className={isSel ? 'text-accentink' : 'text-muted'} />
                      )}
                      {isRenaming ? (
                        <input
                          autoFocus
                          value={renameValue}
                          onChange={(e) => setRenameValue(e.target.value)}
                          onBlur={commitRename}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') commitRename();
                            if (e.key === 'Escape') setRenaming(null);
                          }}
                          onClick={(e) => e.stopPropagation()}
                          className="min-w-0 flex-1 rounded-os border border-osborder bg-paper px-1 text-sm text-ink"
                        />
                      ) : (
                        <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                      )}
                      {isSel && !isRenaming && (
                        <span className="flex shrink-0 items-center gap-1">
                          <button
                            title={t('files.moveToTitle')}
                            aria-label={t('files.moveAria', { name: entry.name })}
                            onClick={(e) => { e.stopPropagation(); setMoveEntry(entry); }}
                            className="rounded-os p-1 hover:bg-ink/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                          >
                            <FolderInput size={13} />
                          </button>
                          <button
                            title={t('files.copyTitle')}
                            aria-label={t('files.copyAria', { name: entry.name })}
                            onClick={(e) => { e.stopPropagation(); handleCopy(entry); }}
                            className="rounded-os p-1 hover:bg-ink/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                          >
                            <Copy size={13} />
                          </button>
                          <button
                            title={t('files.renameTitle')}
                            aria-label={t('files.renameAria', { name: entry.name })}
                            onClick={(e) => { e.stopPropagation(); startRename(entry); }}
                            className="rounded-os p-1 hover:bg-ink/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                          >
                            <Pencil size={13} />
                          </button>
                          <button
                            title={t('files.delTitle')}
                            aria-label={t('files.delAria', { name: entry.name })}
                            onClick={(e) => { e.stopPropagation(); setDeleteTarget(entry); }}
                            className="rounded-os p-1 hover:bg-ink/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                          >
                            <Trash2 size={13} />
                          </button>
                        </span>
                      )}
                      <span className={`shrink-0 text-xs ${isSel ? 'text-accentink' : 'text-muted'}`}>
                        {entry.type === 'folder' ? '' : formatSize(entry.size)}
                      </span>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* Editor pane */}
        {editor && (
          <div className="flex w-1/2 min-w-0 flex-col">
            <div className="flex items-center justify-between border-b border-osborder bg-surface px-3 py-2">
              <span className="truncate text-sm font-medium">
                {baseOf(editor.path)}
                {dirty && <span className="ml-1 text-accent">*</span>}
              </span>
              <div className="flex items-center gap-2">
                <button
                  onClick={handleSaveEditor}
                  disabled={!dirty}
                  className="flex items-center gap-1.5 rounded-os bg-accent px-3 py-1.5 text-sm text-accentink transition-opacity duration-160 disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                >
                  <Save size={14} /> {t('files.save')}
                </button>
                <button
                  onClick={handleCancelEditor}
                  className="flex items-center gap-1.5 rounded-os border border-osborder px-3 py-1.5 text-sm transition-colors duration-160 hover:bg-paper focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                >
                  <X size={14} /> {t('files.close')}
                </button>
              </div>
            </div>
            <textarea
              value={editor.text}
              onChange={(e) => setEditor((ed) => ({ ...ed, text: e.target.value }))}
              spellCheck={false}
              className="min-h-0 flex-1 resize-none bg-paper p-3 font-mono text-sm text-ink outline-none"
            />
          </div>
        )}

        {/* Binary panel */}
        {binaryView && (
          <BinaryPanel
            path={binaryView.path}
            size={binaryView.size}
            onClose={() => setBinaryView(null)}
          />
        )}
      </div>

      {/* Status bar */}
      <div className="flex shrink-0 items-center justify-between gap-3 border-t border-osborder bg-surface px-3 py-1 text-xs text-muted">
        <span aria-live="polite">
          {listLoading ? t('files.loading') : entries.length === 1 ? t('files.objectsOne') : t('files.objectsMany', { n: entries.length })}
        </span>
        <span className="min-w-0 truncate">
          {selectedEntry
            ? `${selectedEntry.name}${selectedEntry.type === 'file' ? ` · ${formatSize(selectedEntry.size)}` : ''}`
            : cwd === '/'
              ? t('files.home')
              : cwd}
        </span>
      </div>

      {/* Dedicated uploader queue: per-file state + real progress (see UploadJobsPanel). */}
      <UploadJobsPanel jobs={uploadJobs} onDismiss={() => setUploadJobs([])} />

      {/* Move-to destination picker */}
      {moveEntry && (
        <MoveDialog
          entry={moveEntry}
          startDir={cwd}
          onConfirm={handleMoveConfirm}
          onClose={() => setMoveEntry(null)}
        />
      )}

      {/* New file / folder name dialog */}
      {namePrompt && (
        <NamePromptDialog
          kind={namePrompt}
          onSubmit={handleNamePromptSubmit}
          onClose={() => setNamePrompt(null)}
          checkExists={async (name) => {
            const existing = new Set((await backend.files.list(cwd)).map((e) => e.name));
            return existing.has(name);
          }}
        />
      )}

      {/* Delete confirmation dialog */}
      {deleteTarget && (
        <DeleteConfirmDialog
          entry={deleteTarget}
          onConfirm={confirmDelete}
          onClose={() => setDeleteTarget(null)}
        />
      )}

      {/* Discard-unsaved-changes dialog (replaces window.confirm) */}
      {dirtyPrompt && (
        <ConfirmDialog
          title={dirtyPrompt.title}
          message={dirtyPrompt.message}
          confirmLabel={dirtyPrompt.confirmLabel}
          onConfirm={dirtyPrompt.onConfirm}
          onClose={() => setDirtyPrompt(null)}
        />
      )}
    </div>
  );
}
