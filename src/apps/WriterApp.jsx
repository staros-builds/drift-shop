import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Bold, Italic, Underline, Strikethrough, List, ListOrdered,
  AlignLeft, AlignCenter, AlignRight, AlignJustify,
  Heading1, Heading2, Heading3, Pilcrow, Eraser,
  FilePlus2, FolderOpen, Save,
} from 'lucide-react';
import { backend } from '../lib/backend/current.js';
import { useNotifications } from '../os/NotificationsContext.jsx';
import { OFFICE_EXT, readDoc, saveDoc, baseName, stripExt } from './office/util.js';
import { OpenDocModal, NameModal } from './office/DocDialogs.jsx';
import { ConfirmDialog, SaveStatePill } from '../components/os/dialogs.jsx';
import { useLang } from '../lib/i18n.jsx';

const EXT = OFFICE_EXT.writer;

const FONT_SIZES = [12, 14, 16, 18, 20, 24, 28, 32];
const FORMAT_CMDS = [
  'bold',
  'italic',
  'underline',
  'strikeThrough',
  'insertUnorderedList',
  'insertOrderedList',
];

function ToolBtn({ title, onClick, active, children }) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={`rounded-os p-1.5 transition-colors duration-160 hover:bg-surface ${
        active ? 'bg-surface text-accent' : 'text-ink'
      }`}
    >
      {children}
    </button>
  );
}

function Divider() {
  return <span className="mx-1 h-5 w-px bg-osborder" />;
}

export default function WriterApp({ windowApi, path }) {
  const { t } = useLang();
  const { push } = useNotifications();
  const editorRef = useRef(null);
  const [docPath, setDocPath] = useState(path || null);
  const [title, setTitle] = useState(() => t('writer.untitled'));
  const [dirty, setDirty] = useState(false);
  const [saveState, setSaveState] = useState('saved'); // 'saved' | 'saving' | 'dirty'
  const [confirmDiscard, setConfirmDiscard] = useState(null); // 'new' | 'open' | null
  const [words, setWords] = useState(0);
  const [showOpen, setShowOpen] = useState(false);
  const [showName, setShowName] = useState(false);
  const [foreColor, setForeColor] = useState('#1a1a1a');
  const [hiColor, setHiColor] = useState('#ffe58a');
  const [fmtState, setFmtState] = useState({});
  const [fontSize, setFontSize] = useState(16);
  const savedRangeRef = useRef(null);
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;
  // Tracks whether the user has typed anything. A fresh document mounts with
  // placeholder HTML; saving before any edit must not persist the placeholder.
  const hasEditedRef = useRef(false);
  const PLACEHOLDER_HTML = t('writer.starter');
  const clearPlaceholder = useCallback(() => {
    const el = editorRef.current;
    if (!el || hasEditedRef.current) return;
    hasEditedRef.current = true;
    if (el.innerHTML === PLACEHOLDER_HTML) el.innerHTML = '<p><br></p>';
  }, []);

  const fail = useCallback((key, err) => push(t('writer.notifError'), `${t(key)}: ${err?.message || err}`), [push, t]);

  const syncStats = useCallback(() => {
    const el = editorRef.current;
    if (!el) return;
    const text = el.innerText || '';
    setWords(text.trim() ? text.trim().split(/\s+/).length : 0);
  }, []);

  const markDirty = useCallback(() => {
    setDirty(true);
    setSaveState('dirty');
    syncStats();
  }, [syncStats]);

  // Reflect the current selection's formatting in the toolbar (W1).
  const syncFmtState = useCallback(() => {
    const el = editorRef.current;
    if (!el) return;
    const next = {};
    for (const c of FORMAT_CMDS) {
      try {
        next[c] = document.queryCommandState(c);
      } catch {
        next[c] = false;
      }
    }
    setFmtState((prev) => {
      for (const c of FORMAT_CMDS) {
        if (prev[c] !== next[c]) return next;
      }
      return prev;
    });
    try {
      const px = parseInt(document.queryCommandValue('fontSize'), 10);
      if (FONT_SIZES.includes(px)) setFontSize(px);
    } catch {
      /* leave the current size selection */
    }
  }, []);

  // Toolbar controls that can't keep editor focus (e.g. <select>) restore the
  // last-known editor selection before running a command.
  const restoreSelection = useCallback(() => {
    const el = editorRef.current;
    if (!el) return;
    const r = savedRangeRef.current;
    el.focus();
    if (r) {
      const sel = document.getSelection();
      if (sel) {
        sel.removeAllRanges();
        sel.addRange(r);
      }
    }
  }, []);

  // H3: Sanitize document HTML on load to prevent stored XSS.
  // Strips script/style/iframe/object/embed tags, event handler attributes,
  // and javascript: URLs. Runs in a detached DOM node, never the live editor.
  const sanitizeHtml = (dirty) => {
    if (!dirty || typeof dirty !== 'string') return '<p><br></p>';
    try {
      const tmp = document.createElement('div');
      tmp.innerHTML = dirty;
      // Remove dangerous elements entirely.
      tmp.querySelectorAll('script, style, iframe, object, embed, link, meta, base, form').forEach((el) => el.remove());
      // Strip event handlers and javascript: URLs from all remaining elements.
      const walker = document.createTreeWalker(tmp, NodeFilter.SHOW_ELEMENT);
      let node;
      while ((node = walker.nextNode())) {
        for (const attr of Array.from(node.attributes)) {
          const name = attr.name.toLowerCase();
          const val = attr.value.toLowerCase().trim();
          if (name.startsWith('on') || val.startsWith('javascript:') || val.startsWith('data:text/html')) {
            node.removeAttribute(attr.name);
          }
        }
      }
      return tmp.innerHTML || '<p><br></p>';
    } catch {
      return '<p><br></p>';
    }
  };

  const loadPath = useCallback(
    async (p) => {
      try {
        const html = await readDoc(p);
        if (editorRef.current) editorRef.current.innerHTML = sanitizeHtml(html);
        setDocPath(p);
        setTitle(stripExt(baseName(p), EXT));
        setDirty(false);
        setSaveState('saved');
        syncStats();
        setShowOpen(false);
      } catch (err) {
        fail('writer.errOpen', err);
      }
    },
    [fail, syncStats]
  );

  // Open with a path prop (e.g. double-clicked in Files).
  useEffect(() => {
    if (path) loadPath(path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    windowApi.setTitle(dirty ? `${title} • — ${t('apps.writer')}` : `${title} — ${t('apps.writer')}`);
  }, [title, dirty, windowApi, t]);

  // Font size via execCommand('fontSize') only accepts 1-7 and ignores px values.
  // Instead, wrap the selection in a span with an explicit font-size style.
  const applyFontSize = useCallback(
    (px) => {
      restoreSelection();
      const el = editorRef.current;
      const sel = document.getSelection();
      if (!el || !sel || sel.rangeCount === 0) return;
      el.focus();
      const range = sel.getRangeAt(0);
      // Clear placeholder on first real edit
      if (!hasEditedRef.current) clearPlaceholder();
      if (range.collapsed) {
        // No selection: style future typing by inserting an empty styled span + ZWSP
        const span = document.createElement('span');
        span.style.fontSize = `${px}px`;
        span.textContent = '\u200b';
        range.insertNode(span);
        const nr = document.createRange();
        nr.setStart(span.firstChild, 1);
        nr.collapse(true);
        sel.removeAllRanges();
        sel.addRange(nr);
        savedRangeRef.current = nr.cloneRange();
      } else {
        const span = document.createElement('span');
        span.style.fontSize = `${px}px`;
        try {
          range.surroundContents(span);
        } catch {
          span.appendChild(range.extractContents());
          range.insertNode(span);
        }
        sel.removeAllRanges();
        const nr = document.createRange();
        nr.selectNodeContents(span);
        sel.addRange(nr);
        savedRangeRef.current = nr.cloneRange();
      }
      markDirty();
      syncFmtState();
    },
    [restoreSelection, markDirty, syncFmtState]
  );

  const cmd = useCallback(
    (c, v = null) => {
      const el = editorRef.current;
      if (el) el.focus();
      document.execCommand('styleWithCSS', false, true);
      document.execCommand(c, false, v);
      syncFmtState();
      markDirty();
    },
    [markDirty, syncFmtState]
  );

  // Track the caret/selection: keep the toolbar's active states current and
  // remember the editor range so <select> controls can restore it (W1).
  useEffect(() => {
    const onSel = () => {
      syncFmtState();
      const sel = document.getSelection();
      const el = editorRef.current;
      if (sel && sel.rangeCount > 0 && el && el.contains(sel.anchorNode)) {
        try {
          savedRangeRef.current = sel.getRangeAt(0).cloneRange();
        } catch {
          /* ignore */
        }
      }
    };
    document.addEventListener('selectionchange', onSel);
    return () => document.removeEventListener('selectionchange', onSel);
  }, [syncFmtState]);

  const doSave = useCallback(
    async (targetPath) => {
      const el = editorRef.current;
      // Never persist the untouched placeholder as document content
      const html = !hasEditedRef.current ? '<p><br></p>' : el ? el.innerHTML : '';
      setSaveState('saving');
      try {
        await saveDoc(targetPath, html);
        setDocPath(targetPath);
        setTitle(stripExt(baseName(targetPath), EXT));
        setDirty(false);
        setSaveState('saved');
        setShowName(false);
        push(t('writer.notifSaved'), t('writer.savedMsg', { name: stripExt(baseName(targetPath), EXT) }));
      } catch (err) {
        setSaveState('dirty');
        fail('writer.errSave', err);
      }
    },
    [fail, push]
  );

  const handleSave = useCallback(() => {
    if (docPath) doSave(docPath);
    else setShowName(true);
  }, [docPath, doSave]);

  // "Discard unsaved changes?" is an in-app dialog now (never
  // window.confirm()) so it works in every browser and under automation.
  const doNew = useCallback(() => {
    if (editorRef.current) editorRef.current.innerHTML = '<p><br></p>';
    setDocPath(null);
    setTitle(t('writer.untitled'));
    setDirty(false);
    setSaveState('saved');
    setWords(0);
  }, []);

  const handleNew = useCallback(() => {
    if (dirtyRef.current) setConfirmDiscard('new');
    else doNew();
  }, [doNew]);

  const handleOpenRequest = useCallback(() => {
    if (dirtyRef.current) setConfirmDiscard('open');
    else setShowOpen(true);
  }, []);

  const confirmDiscardAction = useCallback(() => {
    const action = confirmDiscard;
    setConfirmDiscard(null);
    if (action === 'new') doNew();
    else if (action === 'open') setShowOpen(true);
  }, [confirmDiscard, doNew]);

  // Ctrl+S saves.
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

  return (
    <div className="flex h-full flex-col bg-paper text-ink">
      {/* Menu bar */}
      <div className="flex flex-wrap items-center gap-1 border-b border-osborder bg-surface px-3 py-2">
        <button
          type="button"
          onClick={handleNew}
          title={t('writer.newTitle')}
          className="flex items-center gap-1.5 rounded-os px-2 py-1.5 text-sm hover:bg-paper"
        >
          <FilePlus2 size={15} /> {t('writer.new')}
        </button>
        <button
          type="button"
          onClick={handleOpenRequest}
          title={t('writer.openTitle')}
          className="flex items-center gap-1.5 rounded-os px-2 py-1.5 text-sm hover:bg-paper"
        >
          <FolderOpen size={15} /> {t('writer.open')}
        </button>
        <button
          type="button"
          onClick={handleSave}
          title={t('writer.saveTitle')}
          className="flex items-center gap-1.5 rounded-os bg-accent px-3 py-1.5 text-sm font-medium text-white"
        >
          <Save size={15} /> {t('writer.save')}
        </button>
        <button
          type="button"
          onClick={() => setShowName(true)}
          title={t('writer.saveAsTitle')}
          className="flex items-center gap-1.5 rounded-os px-2 py-1.5 text-sm hover:bg-paper"
        >
          <Save size={15} /> {t('writer.saveAs')}
        </button>
        <span className="mx-2 hidden min-w-0 flex-1 truncate text-center text-sm font-medium sm:block">
          {title}
          {dirty && <span className="text-accent"> •</span>}
        </span>
        <span className="text-xs text-muted">
          {words} {words === 1 ? t('writer.wordOne') : t('writer.wordMany')}
        </span>
        <SaveStatePill state={saveState} />
      </div>

      {/* Format toolbar */}
      <div className="flex flex-wrap items-center gap-0.5 border-b border-osborder bg-surface px-3 py-1.5">
        <ToolBtn title={t('writer.bold')} active={fmtState.bold} onClick={() => cmd('bold')}>
          <Bold size={15} />
        </ToolBtn>
        <ToolBtn title={t('writer.italic')} active={fmtState.italic} onClick={() => cmd('italic')}>
          <Italic size={15} />
        </ToolBtn>
        <ToolBtn title={t('writer.underline')} active={fmtState.underline} onClick={() => cmd('underline')}>
          <Underline size={15} />
        </ToolBtn>
        <ToolBtn title={t('writer.strike')} active={fmtState.strikeThrough} onClick={() => cmd('strikeThrough')}>
          <Strikethrough size={15} />
        </ToolBtn>
        <Divider />
        <ToolBtn title={t('writer.h1')} onClick={() => cmd('formatBlock', 'h1')}>
          <Heading1 size={15} />
        </ToolBtn>
        <ToolBtn title={t('writer.h2')} onClick={() => cmd('formatBlock', 'h2')}>
          <Heading2 size={15} />
        </ToolBtn>
        <ToolBtn title={t('writer.h3')} onClick={() => cmd('formatBlock', 'h3')}>
          <Heading3 size={15} />
        </ToolBtn>
        <ToolBtn title={t('writer.normal')} onClick={() => cmd('formatBlock', 'p')}>
          <Pilcrow size={15} />
        </ToolBtn>
        <Divider />
        <select
          title={t('writer.fontSize')}
          aria-label={t('writer.fontSize')}
          value={fontSize}
          onChange={(e) => {
            const px = parseInt(e.target.value, 10);
            setFontSize(px);
            applyFontSize(px);
          }}
          className="cursor-pointer rounded-os border border-osborder bg-paper px-1.5 py-1 text-sm text-ink outline-none hover:bg-surface"
        >
          {FONT_SIZES.map((s) => (
            <option key={s} value={s}>
              {s}px
            </option>
          ))}
        </select>
        <Divider />
        <ToolBtn title={t('writer.bulletList')} active={fmtState.insertUnorderedList} onClick={() => cmd('insertUnorderedList')}>
          <List size={15} />
        </ToolBtn>
        <ToolBtn title={t('writer.numberedList')} active={fmtState.insertOrderedList} onClick={() => cmd('insertOrderedList')}>
          <ListOrdered size={15} />
        </ToolBtn>
        <Divider />
        <ToolBtn title={t('writer.alignLeft')} onClick={() => cmd('justifyLeft')}>
          <AlignLeft size={15} />
        </ToolBtn>
        <ToolBtn title={t('writer.alignCenter')} onClick={() => cmd('justifyCenter')}>
          <AlignCenter size={15} />
        </ToolBtn>
        <ToolBtn title={t('writer.alignRight')} onClick={() => cmd('justifyRight')}>
          <AlignRight size={15} />
        </ToolBtn>
        <ToolBtn title={t('writer.justify')} onClick={() => cmd('justifyFull')}>
          <AlignJustify size={15} />
        </ToolBtn>
        <Divider />
        <label title={t('writer.textColor')} className="flex cursor-pointer items-center gap-1 rounded-os p-1.5 hover:bg-surface">
          <span className="text-sm font-bold" style={{ color: foreColor }}>
            A
          </span>
          <input
            type="color"
            value={foreColor}
            onChange={(e) => {
              setForeColor(e.target.value);
              restoreSelection();
              cmd('foreColor', e.target.value);
            }}
            className="h-5 w-6 cursor-pointer bg-transparent"
          />
        </label>
        <label title={t('writer.hiColor')} className="flex cursor-pointer items-center gap-1 rounded-os p-1.5 hover:bg-surface">
          <span className="px-1 text-sm font-bold" style={{ backgroundColor: hiColor }}>
            A
          </span>
          <input
            type="color"
            value={hiColor}
            onChange={(e) => {
              setHiColor(e.target.value);
              restoreSelection();
              cmd('hiliteColor', e.target.value);
            }}
            className="h-5 w-6 cursor-pointer bg-transparent"
          />
        </label>
        <ToolBtn title={t('writer.clearFmt')} onClick={() => cmd('removeFormat')}>
          <Eraser size={15} />
        </ToolBtn>
      </div>

      {/* Page */}
      <div className="min-h-0 flex-1 overflow-y-auto bg-osborder/40 p-4 sm:p-6">
        <div
          ref={editorRef}
          contentEditable
          spellCheck
          onInput={() => {
            clearPlaceholder();
            hasEditedRef.current = true;
            markDirty();
            syncFmtState();
          }}
          className="mx-auto min-h-full w-full max-w-3xl rounded-os border border-osborder bg-surface p-6 text-ink shadow-win outline-none sm:p-10 [&_h1]:mb-2 [&_h1]:text-3xl [&_h1]:font-semibold [&_h2]:mb-2 [&_h2]:text-2xl [&_h2]:font-semibold [&_h3]:mb-1 [&_h3]:text-xl [&_h3]:font-semibold [&_li]:ml-6 [&_ol]:list-decimal [&_p]:mb-2 [&_ul]:list-disc"
          dangerouslySetInnerHTML={{
            __html: PLACEHOLDER_HTML,
          }}
        />
      </div>

      {showOpen && (
        <OpenDocModal
          ext={EXT}
          app="writer"
          onPick={loadPath}
          onClose={() => setShowOpen(false)}
        />
      )}
      {showName && (
        <NameModal
          initial={title === t('writer.untitled') ? '' : title}
          title={t('writer.saveAsDialog')}
          ext={EXT}
          onSave={(name) => doSave(`/Documents/${name}${EXT}`)}
          onClose={() => setShowName(false)}
        />
      )}
      {confirmDiscard && (
        <ConfirmDialog
          title={t('writer.discardTitle')}
          message={confirmDiscard === 'open' ? t('writer.discardOpen') : t('writer.discardNew')}
          confirmLabel={t('writer.discardConfirm')}
          cancelLabel={t('writer.keepEditing')}
          danger
          onConfirm={confirmDiscardAction}
          onCancel={() => setConfirmDiscard(null)}
        />
      )}
    </div>
  );
}
