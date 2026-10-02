import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Plus, Search, Pencil, Trash2, Save, X, Link2, FileText, StickyNote, Paperclip, Image,
} from 'lucide-react';
import { backend } from '../lib/backend/current.js';
import { useNotifications } from '../os/NotificationsContext.jsx';
import { useLang } from '../lib/i18n.jsx';
import { ConfirmDialog } from '../components/os/dialogs.jsx';
import { shrinkImageFile } from '../lib/imageShrink.js';

const KINDS = [
  { id: 'all', key: 'all' },
  { id: 'text', key: 'text' },
  { id: 'link', key: 'link' },
  { id: 'note', key: 'note' },
  { id: 'file', key: 'file' },
  { id: 'image', key: 'image' },
];

const COMPOSER_KINDS = [
  { id: 'text', key: 'text', icon: FileText },
  { id: 'link', key: 'link', icon: Link2 },
  { id: 'note', key: 'note', icon: StickyNote },
  { id: 'file', key: 'file', icon: Paperclip },
  { id: 'image', key: 'image', icon: Image },
];

function kindIcon(kind) {
  if (kind === 'link') return Link2;
  if (kind === 'file') return Paperclip;
  if (kind === 'image') return Image;
  if (kind === 'note') return StickyNote;
  return FileText;
}

function formatBytes(n) {
  const bytes = Number(n) || 0;
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Read a File/Blob as a data: URL. */
function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Could not read the file.'));
    reader.readAsDataURL(file);
  });
}

/**
 * Resolves a file/image pin's bytes to a usable URL via backend.pins.fileUrl()
 * (data: URL in local mode, fresh signed URL in cloud mode) and renders it.
 */
function PinAttachment({ pin }) {
  const { t } = useLang();
  const { push } = useNotifications();
  const [url, setUrl] = useState(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    setUrl(null);
    setFailed(false);
    backend.pins
      .fileUrl(pin)
      .then((u) => { if (alive) setUrl(u); })
      .catch((err) => {
        if (!alive) return;
        setFailed(true);
        push(t('pinboard.notifError'), `${t('pinboard.errAttach')}: ${err?.message || err}`);
      });
    return () => { alive = false; };
  }, [pin.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (failed) {
    return <p className="mb-1 text-sm text-muted">{t('pinboard.attachErr')}</p>;
  }
  if (!url) {
    return <div className="mb-1 h-16 animate-pulse rounded-os bg-paper" />;
  }
  if (pin.kind === 'image') {
    return (
      <a href={url} target="_blank" rel="noreferrer" className="mb-1 block">
        <img
          src={url}
          alt={pin.title || t('pinboard.pinnedImage')}
          className="max-h-48 w-full rounded-os border border-osborder object-cover"
        />
      </a>
    );
  }
  return (
    <a
      href={url}
      download={pin.title || t('pinboard.file')}
      target="_blank"
      rel="noreferrer"
      className="mb-1 flex items-center gap-2 rounded-os border border-osborder bg-paper px-2.5 py-2 text-sm text-ink transition-colors duration-160 hover:border-accent"
    >
      <Paperclip size={15} className="shrink-0 text-muted" />
      <span className="min-w-0 flex-1 truncate">{pin.title || t('pinboard.file')}</span>
      {pin.sizeBytes ? (
        <span className="shrink-0 text-xs text-muted">{formatBytes(pin.sizeBytes)}</span>
      ) : null}
    </a>
  );
}

function parseTags(raw) {
  return raw.split(',').map((t) => t.trim()).filter(Boolean);
}

export default function PinboardApp({ windowApi, composer: composerProp }) {
  const { t } = useLang();
  const { push } = useNotifications();
  const [pins, setPins] = useState(null); // null = still loading
  const [tags, setTags] = useState([]);
  const [kindFilter, setKindFilter] = useState('all');
  const [tagFilter, setTagFilter] = useState('');
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [composerOpen, setComposerOpen] = useState(Boolean(composerProp));
  const [editingId, setEditingId] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null); // pin object awaiting delete confirm

  // Composer form
  const [cKind, setCKind] = useState('text');
  const [cTitle, setCTitle] = useState('');
  const [cBody, setCBody] = useState('');
  const [cUrl, setCUrl] = useState('');
  const [cTags, setCTags] = useState('');
  const [cFile, setCFile] = useState(null); // { name, dataUrl, mime, size } for file/image kinds
  const [creating, setCreating] = useState(false); // drives the disabled UI
  const creatingRef = useRef(false); // synchronous double-submit lock (state is too slow: both clicks dispatch before re-render)
  const titleRef = useRef(null);
  const fileInputRef = useRef(null);

  // Edit form
  const [eTitle, setETitle] = useState('');
  const [eBody, setEBody] = useState('');
  const [eUrl, setEUrl] = useState('');
  const [eTags, setETags] = useState('');
  const [eFile, setEFile] = useState(null); // replacement file for file/image pins

  const fail = useCallback(
    (key, err) => push(t('pinboard.notifError'), `${t(key)}: ${err?.message || err}`),
    [push, t]
  );

  const load = useCallback(async () => {
    try {
      const kind = kindFilter === 'all' ? undefined : kindFilter;
      const tag = tagFilter || undefined;
      const q = debouncedQuery.trim();
      const result = q
        ? await backend.pins.search(q, { kind, tag })
        : await backend.pins.list({ kind, tag });
      setPins(result);
    } catch (err) {
      fail('pinboard.errLoad', err);
      setPins([]);
    }
  }, [kindFilter, tagFilter, debouncedQuery, fail]);

  const loadTags = useCallback(async () => {
    try {
      setTags(await backend.pins.tags());
    } catch {
      setTags([]);
    }
  }, []);

  // Debounce the search box
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query), 300);
    return () => clearTimeout(t);
  }, [query]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { loadTags(); }, [loadTags]);

  useEffect(() => {
    windowApi?.setTitle?.(t('apps.pinboard'));
  }, [windowApi, t]);

  useEffect(() => {
    if (composerOpen && titleRef.current) titleRef.current.focus();
  }, [composerOpen]);

  const resetComposer = () => {
    setCKind('text');
    setCTitle('');
    setCBody('');
    setCUrl('');
    setCTags('');
    setCFile(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handlePickFile = async (e, forEdit = false) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      // Pinboard imports are stored as data URLs — shrink photos to a
      // sensible size BEFORE encoding so both the upload and the
      // stored copy stay small. Returns the original for anything
      // else (and on any failure), so picking a file never breaks.
      const working = await shrinkImageFile(file);
      const dataUrl = await readAsDataUrl(working);
      const info = { name: file.name, dataUrl, mime: working?.type || file.type || '', size: working?.size ?? file.size };
      if (forEdit) setEFile(info);
      else {
        setCFile(info);
        // Default the title to the file name when the user hasn't typed one.
        setCTitle((t) => t || file.name);
      }
    } catch (err) {
      fail('pinboard.errReadFile', err);
    }
  };

  const handleCreate = async (e) => {
    e.preventDefault();
    if (creatingRef.current) return; // block double-submit synchronously
    const isFileKind = cKind === 'file' || cKind === 'image';
    if (isFileKind && !cFile) {
      fail('pinboard.errCreate', new Error(t('pinboard.chooseFile')));
      return;
    }
    // Block javascript:/data: URLs (stored XSS) — only http(s) allowed for link pins
    if (cKind === 'link') {
      const u = cUrl.trim();
      if (u && !/^https?:\/\//i.test(u)) {
        fail('pinboard.errCreate', new Error(t('pinboard.errLinkUrl')));
        return;
      }
    }
    creatingRef.current = true;
    setCreating(true);
    try {
      await backend.pins.create({
        kind: cKind,
        title: cTitle.trim() || (isFileKind && cFile ? cFile.name : ''),
        body: isFileKind ? undefined : (cKind === 'link' ? '' : cBody),
        url: cKind === 'link' ? cUrl.trim() : '',
        tags: parseTags(cTags),
        sourceApp: 'pinboard',
        ...(isFileKind && cFile
          ? { dataUrl: cFile.dataUrl, mime: cFile.mime, sizeBytes: cFile.size }
          : {}),
      });
      resetComposer();
      setComposerOpen(false);
      await load();
      await loadTags();
    } catch (err) {
      fail('pinboard.errCreate', err);
    } finally {
      creatingRef.current = false;
      setCreating(false);
    }
  };

  const startEdit = (pin) => {
    setEditingId(pin.id);
    setETitle(pin.title || '');
    setEBody(pin.body || '');
    setEUrl(pin.url || '');
    setETags((pin.tags || []).join(', '));
    setEFile(null);
  };

  const handleUpdate = async (id, pin) => {
    if (!eTitle.trim()) {
      fail('pinboard.errUpdate', new Error(t('pinboard.enterTitle')));
      return;
    }
    // Block javascript:/data: URLs on edit too (stored XSS)
    if (pin.kind === 'link') {
      const u = eUrl.trim();
      if (u && !/^https?:\/\//i.test(u)) {
        fail('pinboard.errUpdate', new Error(t('pinboard.errLinkUrl')));
        return;
      }
    }
    try {
      const isFileKind = pin.kind === 'file' || pin.kind === 'image';
      await backend.pins.update(id, {
        title: eTitle.trim(),
        // Never edit the data URL / file URL as text; only replace via picker.
        ...(isFileKind ? {} : { body: eBody, url: pin.kind === 'link' ? eUrl.trim() : '' }),
        tags: parseTags(eTags),
        ...(isFileKind && eFile
          ? { dataUrl: eFile.dataUrl, mime: eFile.mime, sizeBytes: eFile.size }
          : {}),
      });
      setEditingId(null);
      await load();
      await loadTags();
    } catch (err) {
      fail('pinboard.errUpdate', err);
    }
  };

  const handleDelete = async (pin) => {
    try {
      await backend.pins.remove(pin.id);
      await load();
      await loadTags();
    } catch (err) {
      fail('pinboard.errDelete', err);
    }
  };

  return (
    <div className="flex h-full flex-col bg-paper text-ink">
      {/* Toolbar: search + tag filter + new */}
      <div className="flex flex-wrap items-center gap-2 border-b border-osborder bg-surface px-3 py-2">
        <div className="flex min-w-0 flex-1 items-center gap-2 rounded-os border border-osborder bg-paper px-2 py-1.5">
          <Search size={15} className="shrink-0 text-muted" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('pinboard.searchPh')}
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted"
          />
          {query && (
            <button onClick={() => setQuery('')} className="text-muted hover:text-ink">
              <X size={14} />
            </button>
          )}
        </div>
        <select
          value={tagFilter}
          onChange={(e) => setTagFilter(e.target.value)}
          className="rounded-os border border-osborder bg-paper px-2 py-1.5 text-sm text-ink"
          title={t('pinboard.filterTag')}
        >
          <option value="">{t('pinboard.allTags')}</option>
          {tags.map((t) => (
            <option key={t} value={t}>#{t}</option>
          ))}
        </select>
        <button
          onClick={() => setComposerOpen((v) => !v)}
          className="flex items-center gap-1.5 rounded-os bg-accent px-3 py-1.5 text-sm text-accentink"
        >
          <Plus size={15} /> {t('pinboard.newPin')}
        </button>
      </div>

      {/* Kind chips */}
      <div className="flex gap-1.5 border-b border-osborder px-3 py-2">
        {KINDS.map((k) => (
          <button
            key={k.id}
            onClick={() => setKindFilter(k.id)}
            className={`rounded-os px-3 py-1 text-sm transition-colors duration-160 ${
              kindFilter === k.id
                ? 'bg-accent text-accentink'
                : 'border border-osborder text-muted hover:text-ink'
            }`}
          >
            {t(`pinboard.kinds.${k.key}`)}
          </button>
        ))}
      </div>

      {/* Composer */}
      {composerOpen && (
        <form onSubmit={handleCreate} className="border-b border-osborder bg-surface px-3 py-3">
          <div className="mb-2 flex gap-1.5">
            {COMPOSER_KINDS.map((k) => {
              const Icon = k.icon;
              return (
                <button
                  key={k.id}
                  type="button"
                  onClick={() => setCKind(k.id)}
                  className={`flex items-center gap-1.5 rounded-os px-3 py-1.5 text-sm transition-colors duration-160 ${
                    cKind === k.id ? 'bg-accent text-accentink' : 'border border-osborder text-muted hover:text-ink'
                  }`}
                >
                  <Icon size={14} /> {t(`pinboard.composer.${k.key}`)}
                </button>
              );
            })}
          </div>
          <input
            ref={titleRef}
            value={cTitle}
            onChange={(e) => setCTitle(e.target.value)}
            placeholder={t('pinboard.titlePh')}
            required
            className="mb-2 w-full rounded-os border border-osborder bg-paper px-2.5 py-1.5 text-sm outline-none placeholder:text-muted"
          />
          {cKind === 'link' ? (
            <input
              value={cUrl}
              onChange={(e) => setCUrl(e.target.value)}
              placeholder="https://…"
              required
              className="mb-2 w-full rounded-os border border-osborder bg-paper px-2.5 py-1.5 text-sm outline-none placeholder:text-muted"
            />
          ) : cKind === 'file' || cKind === 'image' ? (
            <div className="mb-2">
              <input
                ref={fileInputRef}
                type="file"
                accept={cKind === 'image' ? 'image/*' : '*/*'}
                onChange={(e) => handlePickFile(e, false)}
                className="w-full text-sm text-ink file:mr-2 file:rounded-os file:border file:border-osborder file:bg-paper file:px-3 file:py-1.5 file:text-sm file:text-ink"
              />
              {cFile && (
                <p className="mt-1 text-xs text-muted">
                  {cFile.name} · {formatBytes(cFile.size)}{cFile.mime ? ` · ${cFile.mime}` : ''}
                </p>
              )}
            </div>
          ) : (
            <textarea
              value={cBody}
              onChange={(e) => setCBody(e.target.value)}
              placeholder={cKind === 'note' ? t('pinboard.notePh') : t('pinboard.textPh')}
              rows={3}
              className="mb-2 w-full resize-y rounded-os border border-osborder bg-paper px-2.5 py-1.5 text-sm outline-none placeholder:text-muted"
            />
          )}
          <input
            value={cTags}
            onChange={(e) => setCTags(e.target.value)}
            placeholder={t('pinboard.tagsPh')}
            className="mb-2 w-full rounded-os border border-osborder bg-paper px-2.5 py-1.5 text-sm outline-none placeholder:text-muted"
          />
          <div className="flex items-center justify-end">
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => { resetComposer(); setComposerOpen(false); }}
                className="rounded-os border border-osborder px-3 py-1.5 text-sm transition-colors duration-160 hover:bg-paper"
              >
                {t('dialogs.cancel')}
              </button>
              <button
                type="submit"
                disabled={creating}
                className="rounded-os bg-accent px-3 py-1.5 text-sm text-accentink disabled:opacity-50"
              >
                {creating ? t('pinboard.pinning') : t('pinboard.pinIt')}
              </button>
            </div>
          </div>
        </form>
      )}

      {/* Pin list */}
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {pins === null ? (
          <div className="py-10 text-center">
            <p className="text-sm text-muted">{t('pinboard.loading')}</p>
          </div>
        ) : pins.length === 0 ? (
          <div className="py-10 text-center">
            <StickyNote size={28} className="mx-auto mb-2 text-muted" />
            <p className="text-sm text-muted">
              {debouncedQuery.trim() || kindFilter !== 'all' || tagFilter
                ? t('pinboard.noMatch')
                : t('pinboard.empty')}
            </p>
          </div>
        ) : (
          <ul className="grid grid-cols-1 gap-2 md:grid-cols-2">
            {pins.map((pin) => {
              const Icon = kindIcon(pin.kind);
              const isEditing = editingId === pin.id;
              return (
                <li
                  key={pin.id}
                  className="rounded-os border border-osborder bg-surface p-3 shadow-os"
                >
                  {isEditing ? (
                    <div>
                      <input
                        value={eTitle}
                        onChange={(e) => setETitle(e.target.value)}
                        className="mb-2 w-full rounded-os border border-osborder bg-paper px-2 py-1.5 text-sm outline-none"
                      />
                      {pin.kind === 'link' ? (
                        <input
                          value={eUrl}
                          onChange={(e) => setEUrl(e.target.value)}
                          className="mb-2 w-full rounded-os border border-osborder bg-paper px-2 py-1.5 text-sm outline-none"
                        />
                      ) : pin.kind === 'file' || pin.kind === 'image' ? (
                        <div className="mb-2">
                          <p className="mb-1 text-xs text-muted">
                            {formatBytes(pin.sizeBytes)}{pin.mime ? ` · ${pin.mime}` : ''}
                          </p>
                          <input
                            type="file"
                            accept={pin.kind === 'image' ? 'image/*' : '*/*'}
                            onChange={(e) => handlePickFile(e, true)}
                            className="w-full text-sm text-ink file:mr-2 file:rounded-os file:border file:border-osborder file:bg-paper file:px-3 file:py-1.5 file:text-sm file:text-ink"
                          />
                          {eFile && (
                            <p className="mt-1 text-xs text-muted">
                              {t('pinboard.replaceWith', { name: eFile.name, size: formatBytes(eFile.size) })}
                            </p>
                          )}
                        </div>
                      ) : (
                        <textarea
                          value={eBody}
                          onChange={(e) => setEBody(e.target.value)}
                          rows={3}
                          className="mb-2 w-full resize-y rounded-os border border-osborder bg-paper px-2 py-1.5 text-sm outline-none"
                        />
                      )}
                      <input
                        value={eTags}
                        onChange={(e) => setETags(e.target.value)}
                        placeholder={t('pinboard.tagsPh')}
                        className="mb-2 w-full rounded-os border border-osborder bg-paper px-2 py-1.5 text-sm outline-none placeholder:text-muted"
                      />
                      <div className="flex justify-end gap-2">
                        <button
                          onClick={() => setEditingId(null)}
                          className="flex items-center gap-1 rounded-os border border-osborder px-2.5 py-1 text-sm transition-colors duration-160 hover:bg-paper"
                        >
                          <X size={13} /> {t('dialogs.cancel')}
                        </button>
                        <button
                          onClick={() => handleUpdate(pin.id, pin)}
                          className="flex items-center gap-1 rounded-os bg-accent px-2.5 py-1 text-sm text-accentink"
                        >
                          <Save size={13} /> {t('pinboard.save')}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div>
                      <div className="mb-1 flex items-start justify-between gap-2">
                        <div className="flex min-w-0 items-center gap-1.5">
                          <Icon size={15} className="shrink-0 text-muted" />
                          <h3 className="truncate text-sm font-medium">{pin.title || t('pinboard.untitled')}</h3>
                        </div>
                        <div className="flex shrink-0 gap-1">
                          <button
                            title={t('pinboard.edit')}
                            aria-label={t('pinboard.editPin')}
                            onClick={() => startEdit(pin)}
                            className="rounded-os p-1 text-muted transition-colors duration-160 hover:text-ink"
                          >
                            <Pencil size={14} />
                          </button>
                          <button
                            title={t('pinboard.delete')}
                            aria-label={t('pinboard.delPin')}
                            onClick={() => setConfirmDelete(pin)}
                            className="rounded-os p-1 text-muted transition-colors duration-160 hover:text-ink"
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </div>
                      {pin.kind === 'link' && pin.url ? (
                        // Sanitize at render time: legacy rows may contain javascript:/data: URLs
                        // from before the create-time validation. Only http(s) renders as a link.
                        /^https?:\/\//i.test(pin.url) ? (
                          <a
                            href={pin.url}
                            target="_blank"
                            rel="noreferrer"
                            className="mb-1 block truncate text-sm text-accent underline"
                          >
                            {pin.url}
                          </a>
                        ) : (
                          <p className="mb-1 block truncate text-sm text-muted">
                            {pin.url}
                          </p>
                        )
                      ) : pin.kind === 'image' || pin.kind === 'file' ? (
                        <PinAttachment pin={pin} />
                      ) : (
                        pin.body && (
                          <p className="mb-1 line-clamp-4 whitespace-pre-wrap text-sm text-ink">
                            {pin.body}
                          </p>
                        )
                      )}
                      {(pin.tags?.length > 0) && (
                        <div className="mt-1 flex flex-wrap gap-1">
                          {pin.tags.map((t) => (
                            <button
                              key={t}
                              onClick={() => setTagFilter(t)}
                              className="rounded-os bg-paper px-1.5 py-0.5 text-xs text-muted transition-colors duration-160 hover:text-ink"
                            >
                              #{t}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
      {confirmDelete && (
        <ConfirmDialog
          title={t('pinboard.delTitle')}
          message={t('pinboard.delMsg', { title: confirmDelete.title || t('pinboard.untitledLower') })}
          confirmLabel={t('pinboard.delete')}
          cancelLabel={t('pinboard.keep')}
          danger
          onConfirm={() => {
            const pin = confirmDelete;
            setConfirmDelete(null);
            handleDelete(pin);
          }}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
    </div>
  );
}
