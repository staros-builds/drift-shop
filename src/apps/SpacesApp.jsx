import { useEffect, useRef, useState } from 'react';
import { Plus, Pencil, Trash2, Check, X, LayoutGrid, Move } from 'lucide-react';
import { useWindows } from '../os/WindowsContext.jsx';
import { useNotifications } from '../os/NotificationsContext.jsx';
import { ConfirmDialog, PromptDialog } from '../components/os/dialogs.jsx';
import { useLang } from '../lib/i18n.jsx';

const WALLPAPERS = [
  { id: '', key: 'global' },
  { id: 'paper-grain', key: 'grain' },
  { id: 'linen', key: 'linen' },
  { id: 'dusk', key: 'dusk' },
  { id: 'plain', key: 'plain' },
  { id: 'img-dawn', key: 'dawn' },
  { id: 'img-ink', key: 'ink' },
  { id: 'img-garden', key: 'garden' },
  { id: 'img-harbor', key: 'harbor' },
];

export default function SpacesApp({ windowApi }) {
  const { t } = useLang();
  const { push } = useNotifications();
  const { spaces, activeSpaceId, visibleWindows, setActiveSpace, setWindowSpace, createSpace, renameSpace, updateSpace, deleteSpace } = useWindows();
  const [renamingId, setRenamingId] = useState(null);
  const [renameValue, setRenameValue] = useState('');
  const [showNewPrompt, setShowNewPrompt] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(null); // space object awaiting delete confirm
  // Guards against double-commit when Enter (keydown) is followed by blur.
  const renameCommitted = useRef(false);

  useEffect(() => {
    windowApi?.setTitle?.(t('apps.spaces'));
  }, [windowApi, t]);

  // In-app prompt replaces window.prompt() so it works in every browser
  // and under automation. Behavior matches the old prompt: an empty name
  // is rejected with an error, cancelling does nothing.
  const submitNewSpace = async (name) => {
    const trimmed = String(name ?? '').trim();
    setShowNewPrompt(false);
    if (!trimmed) {
      push(t('spaces.notifError'), t('spaces.errNameRequired'));
      return;
    }
    // Reject overlong names (UI would truncate, confusing users)
    if (trimmed.length > 50) {
      push(t('spaces.notifError'), t('spaces.errNameTooLong'));
      return;
    }
    // Reject case-insensitive duplicates (e.g. "Work" vs "work")
    if (spaces.some((s) => (s.name || '').toLowerCase() === trimmed.toLowerCase())) {
      push(t('spaces.notifError'), t('spaces.errNameExists'));
      return;
    }
    try {
      await createSpace(trimmed);
    } catch (err) {
      // The real backend error (e.g. the 8-space maximum) is surfaced here.
      push(t('spaces.notifError'), `${t('spaces.errCreate')}: ${err?.message || err}`);
    }
  };

  const startRename = (space) => {
    renameCommitted.current = false;
    setRenamingId(space.id);
    setRenameValue(space.name);
  };

  const commitRename = async () => {
    if (renameCommitted.current) return;
    renameCommitted.current = true;
    const space = spaces.find((s) => s.id === renamingId);
    const value = renameValue.trim();
    setRenamingId(null);
    if (!space || !value || value === space.name) return;
    // Validate rename: length and case-insensitive duplicates (excluding self)
    if (value.length > 50) {
      push(t('spaces.notifError'), t('spaces.errNameTooLong'));
      return;
    }
    if (spaces.some((s) => s.id !== space.id && (s.name || '').toLowerCase() === value.toLowerCase())) {
      push(t('spaces.notifError'), t('spaces.errNameExists'));
      return;
    }
    try {
      await renameSpace(space.id, value);
    } catch (err) {
      push(t('spaces.notifError'), `${t('spaces.errRename')}: ${err?.message || err}`);
    }
  };

  const handleDelete = async (space) => {
    try {
      await deleteSpace(space.id);
    } catch (err) {
      push(t('spaces.notifError'), `${t('spaces.errDelete')}: ${err?.message || err}`);
    }
  };

  // Topmost non-minimized window in the active space — the one a
  // "move focused window here" action will send to another space.
  const focusedWindow = visibleWindows
    .filter((w) => !w.minimized)
    .reduce((top, w) => (!top || w.z > top.z ? w : top), null);

  const handleMoveFocusedHere = (space) => {
    if (!focusedWindow) {
      push(t('apps.spaces'), t('spaces.noFocus'));
      return;
    }
    setWindowSpace(focusedWindow.id, space.id);
    setActiveSpace(space.id);
  };

  const handleWallpaper = async (space, wallpaperId) => {
    try {
      await updateSpace(space.id, { wallpaper: wallpaperId || null });
    } catch (err) {
      push(t('spaces.notifError'), `${t('spaces.errWallpaper')}: ${err?.message || err}`);
    }
  };

  return (
    <div className="flex h-full flex-col bg-paper text-ink">
      <div className="flex items-center justify-between border-b border-osborder bg-surface px-3 py-2">
        <p className="text-sm text-muted">
          {t('spaces.count', { n: spaces.length })}
        </p>
        <button
          onClick={() => setShowNewPrompt(true)}
          disabled={spaces.length >= 8}
          className="flex items-center gap-1.5 rounded-os bg-accent px-3 py-1.5 text-sm text-accentink transition-opacity duration-160 disabled:opacity-40"
        >
          <Plus size={15} /> {t('spaces.newSpace')}
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {spaces.length === 0 ? (
          <div className="py-10 text-center">
            <LayoutGrid size={28} className="mx-auto mb-2 text-muted" />
            <p className="text-sm text-muted">{t('spaces.empty')}</p>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {spaces.map((space) => {
              const isActive = space.id === activeSpaceId;
              const isRenaming = renamingId === space.id;
              return (
                <div
                  key={space.id}
                  onClick={() => { if (!isRenaming) setActiveSpace(space.id); }}
                  className={`group cursor-pointer rounded-os border p-3 transition-colors duration-160 ${
                    isActive
                      ? 'border-accent bg-surface shadow-os'
                      : 'border-osborder bg-surface hover:border-accent'
                  }`}
                >
                  <div className="mb-2 flex h-12 items-center justify-center rounded-os bg-paper">
                    <LayoutGrid size={20} className="text-muted" />
                  </div>
                  {isRenaming ? (
                    <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                      <input
                        autoFocus
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') commitRename();
                          if (e.key === 'Escape') setRenamingId(null);
                        }}
                        onBlur={commitRename}
                        className="min-w-0 flex-1 rounded-os border border-osborder bg-paper px-1.5 py-1 text-sm text-ink outline-none"
                      />
                      <button onClick={commitRename} title={t('spaces.saveName')} aria-label={t('spaces.saveAria')} className="rounded-os p-1 text-muted hover:text-ink">
                        <Check size={15} />
                      </button>
                      <button onClick={() => setRenamingId(null)} title={t('dialogs.cancel')} aria-label={t('spaces.cancelAria')} className="rounded-os p-1 text-muted hover:text-ink">
                        <X size={15} />
                      </button>
                    </div>
                  ) : (
                    <div className="flex items-center justify-between gap-1">
                      <p className="truncate text-sm font-medium">
                        {space.name}
                        {isActive && <span className="ml-1.5 text-xs font-normal text-muted">{t('spaces.active')}</span>}
                      </p>
                      <div className="flex shrink-0 opacity-0 transition-opacity duration-160 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100">
                        <button
                          title={t('spaces.rename')}
                          aria-label={t('spaces.renameSpace')}
                          onClick={(e) => { e.stopPropagation(); startRename(space); }}
                          className="rounded-os p-1 text-muted hover:text-ink"
                        >
                          <Pencil size={14} />
                        </button>
                        <button
                          title={t('spaces.delete')}
                          aria-label={t('spaces.delSpace')}
                          onClick={(e) => { e.stopPropagation(); setConfirmDelete(space); }}
                          className="rounded-os p-1 text-muted hover:text-ink"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </div>
                  )}
                  <div className="mt-2" onClick={(e) => e.stopPropagation()}>
                    <select
                      value={space.wallpaper || ''}
                      onChange={(e) => handleWallpaper(space, e.target.value)}
                      title={t('spaces.spaceWallpaper')}
                      className="w-full rounded-os border border-osborder bg-paper px-1.5 py-1 text-xs text-muted outline-none"
                    >
                      {WALLPAPERS.map((w) => (
                        <option key={w.id} value={w.id}>
                          {t(`spaces.wallpaper.${w.key}`)}
                        </option>
                      ))}
                    </select>
                  </div>
                  {!isActive && (
                    <button
                      onClick={(e) => { e.stopPropagation(); handleMoveFocusedHere(space); }}
                      disabled={!focusedWindow}
                      title={
                        focusedWindow
                          ? t('spaces.moveTitle', { win: focusedWindow.title, space: space.name })
                          : t('spaces.noFocus')
                      }
                      className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-os border border-osborder bg-paper px-2 py-1.5 text-xs text-muted transition-colors duration-160 hover:text-ink disabled:opacity-40"
                    >
                      <Move size={13} /> {t('spaces.moveHere')}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
      {showNewPrompt && (
        <PromptDialog
          title={t('spaces.newSpace')}
          label={t('spaces.spaceName')}
          placeholder={t('spaces.workPh')}
          submitLabel={t('spaces.create')}
          onSubmit={submitNewSpace}
          onCancel={() => setShowNewPrompt(false)}
        />
      )}
      {confirmDelete && (
        <ConfirmDialog
          title={t('spaces.delTitle', { name: confirmDelete.name })}
          message={t('spaces.delMsg')}
          confirmLabel={t('spaces.delete')}
          cancelLabel={t('spaces.keep')}
          danger
          onConfirm={() => {
            const space = confirmDelete;
            setConfirmDelete(null);
            handleDelete(space);
          }}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
    </div>
  );
}
