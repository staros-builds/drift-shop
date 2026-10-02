import { useCallback, useEffect, useState } from 'react';
import {
  FilePlus2, FolderOpen, Save, Plus, Copy, Trash2,
  ChevronUp, ChevronDown, Play, X, ChevronLeft, ChevronRight,
} from 'lucide-react';
import { backend } from '../lib/backend/current.js';
import { useNotifications } from '../os/NotificationsContext.jsx';
import { OFFICE_EXT, readDoc, saveDoc, baseName, stripExt } from './office/util.js';
import { OpenDocModal, NameModal } from './office/DocDialogs.jsx';
import { ConfirmDialog, SaveStatePill } from '../components/os/dialogs.jsx';
import { useLang } from '../lib/i18n.jsx';

const EXT = OFFICE_EXT.slides;

const BG_CHOICES = [
  { key: 'paper', value: '#fdfcf9' },
  { key: 'ink', value: '#1c1a17' },
  { key: 'persimmon', value: '#e8641c' },
  { key: 'sage', value: '#7d8c6f' },
  { key: 'sky', value: '#3f6f9e' },
  { key: 'dusk', value: '#4a3f5c' },
];

function makeSlide(titleText, bodyText) {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    layout: 'bullets',
    title: titleText,
    body: bodyText,
    bg: '#fdfcf9',
  };
}

function isDark(bg) {
  const dark = ['#1c1a17', '#4a3f5c', '#3f6f9e'];
  return dark.includes(bg);
}

function SlideCanvas({ slide, scale = 1 }) {
  const dark = isDark(slide.bg);
  const fg = dark ? '#fdfcf9' : '#1c1a17';
  const sub = dark ? '#fdfcf999' : '#1c1a1799';
  return (
    <div
      className="flex aspect-video w-full flex-col justify-center overflow-hidden rounded-os p-[6%]"
      style={{ backgroundColor: slide.bg, color: fg, fontSize: `${15 * scale}px` }}
    >
      {slide.layout === 'blank' ? (
        <div className="whitespace-pre-wrap" style={{ fontSize: `${17 * scale}px` }}>
          {slide.body || ' '}
        </div>
      ) : (
        <>
          <div className="font-semibold leading-tight" style={{ fontSize: `${slide.layout === 'title' ? 34 * scale : 26 * scale}px` }}>
            {slide.title || ' '}
          </div>
          {slide.layout === 'title' ? (
            <div className="mt-[3%]" style={{ color: sub, fontSize: `${17 * scale}px` }}>
              {slide.body || ' '}
            </div>
          ) : (
            <ul className="mt-[3%] list-disc space-y-[1.5%] pl-[5%]" style={{ fontSize: `${16 * scale}px` }}>
              {(slide.body || '').split('\n').filter((l) => l.trim()).map((line, i) => (
                <li key={i}>{line}</li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

export default function SlidesApp({ windowApi, path }) {
  const { t } = useLang();
  const { push } = useNotifications();
  const blankSlide = useCallback(
    () => makeSlide(t('slides.newTitle'), t('slides.newBody')),
    [t]
  );
  const [slides, setSlides] = useState(() => [blankSlide()]);
  const [active, setActive] = useState(0);
  const [deckPath, setDeckPath] = useState(path || null);
  const [title, setTitle] = useState(() => t('slides.untitled'));
  const [dirty, setDirty] = useState(false);
  const [saveState, setSaveState] = useState('saved'); // 'saved' | 'saving' | 'dirty'
  const [confirmDiscard, setConfirmDiscard] = useState(null); // 'new' | 'open' | null
  const [showOpen, setShowOpen] = useState(false);
  const [showName, setShowName] = useState(false);
  const [presenting, setPresenting] = useState(false);
  const [presentIdx, setPresentIdx] = useState(0);

  const fail = useCallback((key, err) => push(t('slides.notifError'), `${t(key)}: ${err?.message || err}`), [push, t]);

  const markDirty = useCallback(() => {
    setDirty(true);
    setSaveState('dirty');
  }, []);

  const loadPath = useCallback(
    async (p) => {
      try {
        const text = await readDoc(p);
        const data = JSON.parse(text || '{}');
        const loaded = Array.isArray(data.slides) && data.slides.length ? data.slides : [blankSlide()];
        setSlides(loaded);
        setActive(0);
        setDeckPath(p);
        setTitle(data.title || stripExt(baseName(p), EXT));
        setDirty(false);
        setSaveState('saved');
        setShowOpen(false);
      } catch (err) {
        fail('slides.errOpen', err);
      }
    },
    [fail, blankSlide]
  );

  useEffect(() => {
    if (path) loadPath(path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    windowApi.setTitle(dirty ? `${title} • — ${t('apps.slides')}` : `${title} — ${t('apps.slides')}`);
  }, [title, dirty, windowApi, t]);

  const patchSlide = useCallback(
    (idx, patch) => {
      setSlides((prev) => prev.map((s, i) => (i === idx ? { ...s, ...patch } : s)));
      markDirty();
    },
    [markDirty]
  );

  const addSlide = useCallback(() => {
    setSlides((prev) => {
      const next = [...prev];
      next.splice(active + 1, 0, blankSlide());
      return next;
    });
    setActive((a) => a + 1);
    markDirty();
  }, [active, markDirty, blankSlide]);

  const duplicateSlide = useCallback(() => {
    setSlides((prev) => {
      const next = [...prev];
      const copy = { ...prev[active], id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}` };
      next.splice(active + 1, 0, copy);
      return next;
    });
    setActive((a) => a + 1);
    markDirty();
  }, [active, markDirty]);

  const deleteSlide = useCallback(() => {
    setSlides((prev) => {
      if (prev.length <= 1) return [blankSlide()];
      return prev.filter((_, i) => i !== active);
    });
    setActive((a) => Math.max(0, a - 1));
    markDirty();
  }, [active, markDirty, blankSlide]);

  const moveSlide = useCallback(
    (dir) => {
      setSlides((prev) => {
        const j = active + dir;
        if (j < 0 || j >= prev.length) return prev;
        const next = [...prev];
        [next[active], next[j]] = [next[j], next[active]];
        return next;
      });
      setActive((a) => Math.min(slides.length - 1, Math.max(0, a + dir)));
      markDirty();
    },
    [active, slides.length, markDirty]
  );

  const doSave = useCallback(
    async (targetPath) => {
      setSaveState('saving');
      try {
        await saveDoc(targetPath, JSON.stringify({ version: 1, title, slides }, null, 1));
        setDeckPath(targetPath);
        setTitle(stripExt(baseName(targetPath), EXT));
        setDirty(false);
        setSaveState('saved');
        setShowName(false);
        push(t('slides.notifSaved'), t('slides.savedMsg', { name: stripExt(baseName(targetPath), EXT) }));
      } catch (err) {
        setSaveState('dirty');
        fail('slides.errSave', err);
      }
    },
    [fail, push, slides, title, t]
  );

  const handleSave = useCallback(() => {
    if (deckPath) doSave(deckPath);
    else setShowName(true);
  }, [deckPath, doSave]);

  // "Discard unsaved changes?" is an in-app dialog now (never
  // window.confirm()) so it works in every browser and under automation.
  const doNew = useCallback(() => {
    setSlides([blankSlide()]);
    setActive(0);
    setDeckPath(null);
    setTitle(t('slides.untitled'));
    setDirty(false);
    setSaveState('saved');
  }, [blankSlide, t]);

  const handleNew = useCallback(() => {
    if (dirty) setConfirmDiscard('new');
    else doNew();
  }, [dirty, doNew]);

  const handleOpenRequest = useCallback(() => {
    if (dirty) setConfirmDiscard('open');
    else setShowOpen(true);
  }, [dirty]);

  const confirmDiscardAction = useCallback(() => {
    const action = confirmDiscard;
    setConfirmDiscard(null);
    if (action === 'new') doNew();
    else if (action === 'open') setShowOpen(true);
  }, [confirmDiscard, doNew]);

  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        handleSave();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handleSave]);

  // Present-mode keyboard.
  useEffect(() => {
    if (!presenting) return;
    const onKey = (e) => {
      if (e.key === 'Escape') setPresenting(false);
      else if (e.key === 'ArrowRight' || e.key === ' ') {
        e.preventDefault();
        setPresentIdx((i) => Math.min(slides.length - 1, i + 1));
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        setPresentIdx((i) => Math.max(0, i - 1));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [presenting, slides.length]);

  const slide = slides[active] || blankSlide();

  return (
    <div className="flex h-full flex-col bg-paper text-ink">
      <div className="flex flex-wrap items-center gap-1 border-b border-osborder bg-surface px-3 py-2">
        <button type="button" onClick={handleNew} title={t('slides.newTitleAttr')}
          className="flex items-center gap-1.5 rounded-os px-2 py-1.5 text-sm hover:bg-paper">
          <FilePlus2 size={15} /> {t('slides.new')}
        </button>
        <button type="button" onClick={handleOpenRequest} title={t('slides.openTitle')}
          className="flex items-center gap-1.5 rounded-os px-2 py-1.5 text-sm hover:bg-paper">
          <FolderOpen size={15} /> {t('slides.open')}
        </button>
        <button type="button" onClick={handleSave} title={t('slides.saveTitle')}
          className="flex items-center gap-1.5 rounded-os bg-accent px-3 py-1.5 text-sm font-medium text-white">
          <Save size={15} /> {t('slides.save')}
        </button>
        <button
          type="button"
          onClick={() => setShowName(true)}
          title={t('slides.saveAsTitle')}
          className="flex items-center gap-1.5 rounded-os px-2 py-1.5 text-sm hover:bg-paper"
        >
          <Save size={15} /> {t('slides.saveAs')}
        </button>
        <span className="mx-1 h-5 w-px bg-osborder" />
        <button type="button" onClick={addSlide} title={t('slides.addSlide')}
          className="flex items-center gap-1 rounded-os px-2 py-1.5 text-sm hover:bg-paper">
          <Plus size={15} /> {t('slides.slide')}
        </button>
        <button type="button" onClick={duplicateSlide} title={t('slides.dupSlide')} aria-label={t('slides.dupSlide')}
          className="rounded-os p-1.5 hover:bg-paper">
          <Copy size={15} />
        </button>
        <button type="button" onClick={deleteSlide} title={t('slides.delSlide')} aria-label={t('slides.delSlide')}
          className="rounded-os p-1.5 hover:bg-paper">
          <Trash2 size={15} />
        </button>
        <button type="button" onClick={() => moveSlide(-1)} title={t('slides.moveUp')} aria-label={t('slides.moveUp')}
          className="rounded-os p-1.5 hover:bg-paper">
          <ChevronUp size={15} />
        </button>
        <button type="button" onClick={() => moveSlide(1)} title={t('slides.moveDown')} aria-label={t('slides.moveDown')}
          className="rounded-os p-1.5 hover:bg-paper">
          <ChevronDown size={15} />
        </button>
        <span className="mx-2 hidden min-w-0 flex-1 truncate text-center text-sm font-medium sm:block">
          {title}
          {dirty && <span className="text-accent"> •</span>}
        </span>
        <SaveStatePill state={saveState} />
        <button
          type="button"
          onClick={() => { setPresentIdx(active); setPresenting(true); }}
          className="flex items-center gap-1.5 rounded-os border border-osborder px-3 py-1.5 text-sm hover:bg-paper"
        >
          <Play size={15} /> {t('slides.present')}
        </button>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* Thumbnails */}
        <div className="w-40 shrink-0 space-y-2 overflow-y-auto border-r border-osborder bg-surface p-2">
          {slides.map((s, i) => (
            <button
              key={s.id}
              type="button"
              onClick={() => setActive(i)}
              className={`block w-full rounded-os border-2 p-1 text-left ${
                i === active ? 'border-accent' : 'border-transparent hover:border-osborder'
              }`}
            >
              <SlideCanvas slide={s} scale={0.32} />
              <span className="mt-1 block text-center text-[11px] text-muted">{i + 1}</span>
            </button>
          ))}
        </div>

        {/* Editor */}
        <div className="flex min-w-0 flex-1 flex-col overflow-y-auto p-4 sm:p-6">
          <div className="mx-auto w-full max-w-3xl">
            <SlideCanvas slide={slide} scale={1} />
            <div className="mt-4 space-y-3">
              <div>
                <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted">
                  {t('slides.layout')}
                </label>
                <div className="flex gap-2">
                  {['title', 'bullets', 'blank'].map((id) => (
                    <button
                      key={id}
                      type="button"
                      onClick={() => patchSlide(active, { layout: id })}
                      className={`rounded-os border px-3 py-1.5 text-sm ${
                        slide.layout === id
                          ? 'border-accent bg-accent/10 text-accent'
                          : 'border-osborder hover:bg-surface'
                      }`}
                    >
                      {t(`slides.layout${id.charAt(0).toUpperCase() + id.slice(1)}`)}
                    </button>
                  ))}
                </div>
              </div>
              {slide.layout !== 'blank' && (
                <div>
                  <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted">
                    {t('slides.titleLabel')}
                  </label>
                  <input
                    value={slide.title}
                    onChange={(e) => patchSlide(active, { title: e.target.value })}
                    className="w-full rounded-os border border-osborder bg-surface px-3 py-2 text-sm outline-none focus:border-accent"
                  />
                </div>
              )}
              <div>
                <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted">
                  {slide.layout === 'blank' ? t('slides.contentLabel') : slide.layout === 'title' ? t('slides.subtitleLabel') : t('slides.bulletsLabel')}
                </label>
                <textarea
                  value={slide.body}
                  onChange={(e) => patchSlide(active, { body: e.target.value })}
                  rows={slide.layout === 'blank' ? 8 : 5}
                  className="w-full rounded-os border border-osborder bg-surface px-3 py-2 text-sm outline-none focus:border-accent"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted">
                  {t('slides.bg')}
                </label>
                <div className="flex gap-2">
                  {BG_CHOICES.map((b) => (
                    <button
                      key={b.value}
                      type="button"
                      title={t(`slides.bg${b.key.charAt(0).toUpperCase() + b.key.slice(1)}`)}
                      aria-label={t('slides.bgName', { name: t(`slides.bg${b.key.charAt(0).toUpperCase() + b.key.slice(1)}`) })}
                      onClick={() => patchSlide(active, { bg: b.value })}
                      className={`h-8 w-8 rounded-os border-2 ${
                        slide.bg === b.value ? 'border-accent' : 'border-osborder'
                      }`}
                      style={{ backgroundColor: b.value }}
                    />
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Present mode */}
      {presenting && (
        <div className="fixed inset-0 z-[80] flex flex-col bg-black"
          onClick={() => setPresentIdx((i) => Math.min(slides.length - 1, i + 1))}>
          <div className="flex items-center justify-between p-4 text-white/70">
            <span className="text-sm">
              {t('slides.presentHint', { i: presentIdx + 1, n: slides.length })}
            </span>
            <button
              type="button"
              aria-label={t('slides.exitPresent')}
              onClick={(e) => { e.stopPropagation(); setPresenting(false); }}
              className="rounded-os p-2 hover:bg-white/10"
            >
              <X size={20} />
            </button>
          </div>
          <div className="flex min-h-0 flex-1 items-center justify-center p-6 sm:p-12">
            <div className="w-full max-w-5xl">
              <SlideCanvas slide={slides[presentIdx]} scale={2.2} />
            </div>
          </div>
          <div className="flex items-center justify-center gap-4 p-4">
            <button
              type="button"
              aria-label={t('slides.prevSlide')}
              onClick={(e) => { e.stopPropagation(); setPresentIdx((i) => Math.max(0, i - 1)); }}
              className="rounded-os bg-white/10 p-3 text-white hover:bg-white/20"
            >
              <ChevronLeft size={20} />
            </button>
            <button
              type="button"
              aria-label={t('slides.nextSlide')}
              onClick={(e) => { e.stopPropagation(); setPresentIdx((i) => Math.min(slides.length - 1, i + 1)); }}
              className="rounded-os bg-white/10 p-3 text-white hover:bg-white/20"
            >
              <ChevronRight size={20} />
            </button>
          </div>
        </div>
      )}

      {showOpen && (
        <OpenDocModal ext={EXT} app="slides" onPick={loadPath} onClose={() => setShowOpen(false)} />
      )}
      {showName && (
        <NameModal
          initial={title === t('slides.untitled') ? '' : title}
          title={t('slides.saveAsDialog')}
          ext={EXT}
          onSave={(name) => doSave(`/Documents/${name}${EXT}`)}
          onClose={() => setShowName(false)}
        />
      )}
      {confirmDiscard && (
        <ConfirmDialog
          title={t('slides.discardTitle')}
          message={confirmDiscard === 'open' ? t('slides.discardOpen') : t('slides.discardNew')}
          confirmLabel={t('slides.discardConfirm')}
          cancelLabel={t('slides.keepEditing')}
          danger
          onConfirm={confirmDiscardAction}
          onCancel={() => setConfirmDiscard(null)}
        />
      )}
    </div>
  );
}
