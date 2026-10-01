import { useCallback, useEffect, useRef, useState } from 'react';
import { localeTag, useLang } from '../lib/i18n.jsx';
import {
  ClipboardList, ClipboardPaste, Plus, Search, Trash2, X, Check, StickyNote,
} from 'lucide-react';

/**
 * Clipboard history. Plain app component — the coordinator adds the
 * registry entry (id 'clipboard').
 *
 * - Captures text pasted (Ctrl/Cmd+V) while the app is open.
 * - "Capture from clipboard" reads via navigator.clipboard.readText()
 *   with graceful messaging when permission is denied.
 * - Manual notes, search, click-to-copy-back, per-item delete, Clear all.
 * - Persisted per-device in localStorage ('drift.clipboard.v1'), capped at
 *   100 items and ~200KB total (oldest dropped first). Quota/parse errors
 *   are contained and never crash the app.
 */

const STORAGE_KEY = 'drift.clipboard.v1';
const MAX_ITEMS = 100;
const MAX_BYTES = 200 * 1024;

function loadItems() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((i) => i && typeof i.text === 'string')
      .map((i) => ({
        id: String(i.id || ''),
        text: i.text,
        kind: i.kind === 'note' ? 'note' : 'text',
        createdAt: Number(i.createdAt) || 0,
      }))
      .filter((i) => i.id)
      .slice(0, MAX_ITEMS);
  } catch {
    return []; // corrupt JSON — start fresh, never crash
  }
}

/** Persist newest-first; drop oldest past the caps. Returns stored items. */
function persistItems(items) {
  let next = items.slice(0, MAX_ITEMS);
  const write = (arr) => localStorage.setItem(STORAGE_KEY, JSON.stringify(arr));
  try {
    let json = JSON.stringify(next);
    while (json.length > MAX_BYTES && next.length > 1) {
      next = next.slice(0, -1); // drop oldest
      json = JSON.stringify(next);
    }
    write(next);
    return { items: next, trimmed: json.length > MAX_BYTES };
  } catch {
    // Quota: halve and retry once, then give up quietly.
    try {
      next = next.slice(0, Math.max(1, Math.floor(next.length / 2)));
      write(next);
      return { items: next, trimmed: true };
    } catch {
      return { items: next, trimmed: true, failed: true };
    }
  }
}

const makeItem = (text, kind) => ({
  id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  text,
  kind,
  createdAt: Date.now(),
});

function formatWhen(ts) {
  try {
    return new Date(ts).toLocaleString(localeTag(), {
      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    });
  } catch {
    return '';
  }
}

function isTypingTarget(t) {
  if (!t || typeof t.closest !== 'function') return false;
  const tag = (t.tagName || '').toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || t.isContentEditable;
}

export default function ClipboardApp({ windowApi }) {
  const { t } = useLang();
  const [items, setItems] = useState(loadItems);
  const [query, setQuery] = useState('');
  const [noteDraft, setNoteDraft] = useState('');
  const [notice, setNotice] = useState(null); // { kind: 'info'|'error', text }
  const [copiedId, setCopiedId] = useState(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const noticeTimer = useRef(null);
  const copiedTimer = useRef(null);
  const confirmTimer = useRef(null);
  const rootRef = useRef(null);

  useEffect(() => {
    windowApi?.setTitle?.(t('apps.clipboard'));
  }, [windowApi, t]);

  useEffect(() => () => {
    clearTimeout(noticeTimer.current);
    clearTimeout(copiedTimer.current);
    clearTimeout(confirmTimer.current);
  }, []);

  const flashNotice = useCallback((kind, text, ms = 5000) => {
    setNotice({ kind, text });
    clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), ms);
  }, []);

  const addText = useCallback(
    (text, kind = 'text') => {
      const clean = String(text || '');
      if (!clean.trim()) return;
      setItems((prev) => {
        if (prev[0] && prev[0].text === clean) return prev; // skip double-capture
        const { items: stored } = persistItems([makeItem(clean, kind), ...prev]);
        return stored;
      });
    },
    []
  );

  // Capture pastes only when the paste happens inside this app's own window
  // (but not into its search/note fields — those are the user typing, not capturing).
  // This prevents accidentally capturing passwords pasted into other apps.
  useEffect(() => {
    const onPaste = (e) => {
      if (!rootRef.current?.contains(e.target)) return;
      if (isTypingTarget(e.target)) return;
      const text = e.clipboardData?.getData('text');
      if (text && text.trim()) addText(text, 'text');
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [addText]);

  const captureFromClipboard = async () => {
    if (!navigator.clipboard || typeof navigator.clipboard.readText !== 'function') {
      flashNotice('error', t('clipboard.errReadNA'));
      return;
    }
    try {
      const text = await navigator.clipboard.readText();
      if (text && text.trim()) {
        addText(text, 'text');
        flashNotice('info', t('clipboard.captured'));
      } else {
        flashNotice('info', t('clipboard.emptyClip'));
      }
    } catch {
      flashNotice('error', t('clipboard.errReadBlocked'));
    }
  };

  const addNote = () => {
    if (!noteDraft.trim()) return;
    addText(noteDraft, 'note');
    setNoteDraft('');
  };

  const copyBack = async (item) => {
    if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') {
      flashNotice('error', t('clipboard.errWriteNA'));
      return;
    }
    try {
      await navigator.clipboard.writeText(item.text);
      setCopiedId(item.id);
      clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopiedId(null), 1600);
    } catch {
      flashNotice('error', t('clipboard.errWriteBlocked'));
    }
  };

  const deleteItem = (id) => {
    setItems((prev) => {
      const { items: stored } = persistItems(prev.filter((i) => i.id !== id));
      return stored;
    });
  };

  const clearAll = () => {
    if (!confirmClear) {
      setConfirmClear(true);
      clearTimeout(confirmTimer.current);
      confirmTimer.current = setTimeout(() => setConfirmClear(false), 4000);
      return;
    }
    clearTimeout(confirmTimer.current);
    setConfirmClear(false);
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* removal is best-effort */
    }
    setItems([]);
  };

  const q = query.trim().toLowerCase();
  const visible = q ? items.filter((i) => i.text.toLowerCase().includes(q)) : items;

  return (
    <div ref={rootRef} className="flex h-full flex-col bg-paper text-ink">
      {/* Toolbar */}
      <div className="border-b border-osborder bg-surface p-3">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={captureFromClipboard}
            className="flex min-h-[44px] items-center gap-2 rounded-os bg-accent px-4 text-sm font-medium text-white duration-160 hover:opacity-90"
          >
            <ClipboardPaste size={16} /> {t('clipboard.capture')}
          </button>
          <div className="relative min-w-0 flex-1">
            <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('clipboard.searchPh')}
              aria-label={t('clipboard.searchAria')}
              className="w-full min-h-[44px] rounded-os border border-osborder bg-paper py-2 pl-9 pr-8 text-sm text-ink outline-none placeholder:text-muted focus:border-accent"
            />
            {query && (
              <button
                type="button" aria-label={t('clipboard.clearSearch')} onClick={() => setQuery('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded-os p-2 text-muted hover:text-ink"
              >
                <X size={16} />
              </button>
            )}
          </div>
          {items.length > 0 && (
            <button
              type="button"
              onClick={clearAll}
              className={`flex min-h-[44px] items-center gap-2 rounded-os border px-4 text-sm font-medium duration-160 ${
                confirmClear
                  ? 'border-accent bg-accent/15 text-ink'
                  : 'border-osborder bg-paper text-muted hover:text-ink'
              }`}
            >
              <Trash2 size={16} /> {confirmClear ? t('clipboard.confirmClear') : t('clipboard.clearAll')}
            </button>
          )}
        </div>

        {/* Add note */}
        <div className="mt-2 flex gap-2">
          <input
            value={noteDraft}
            onChange={(e) => setNoteDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') addNote();
            }}
            placeholder={t('clipboard.notePh')}
            aria-label={t('clipboard.noteAria')}
            className="min-w-0 flex-1 rounded-os border border-osborder bg-paper px-3 py-2.5 text-sm text-ink outline-none placeholder:text-muted focus:border-accent"
          />
          <button
            type="button"
            onClick={addNote}
            disabled={!noteDraft.trim()}
            className="flex min-h-[44px] items-center gap-1.5 rounded-os border border-osborder bg-paper px-4 text-sm font-medium text-ink duration-160 hover:opacity-90 disabled:opacity-40"
          >
            <Plus size={16} /> {t('clipboard.addNote')}
          </button>
        </div>

        {notice && (
          <p
            role="status"
            className={`mt-2 rounded-os border px-3 py-2 text-sm ${
              notice.kind === 'error'
                ? 'border-accent/40 bg-accent/10 text-ink'
                : 'border-osborder bg-paper text-muted'
            }`}
          >
            {notice.text}
          </p>
        )}
      </div>

      {/* Items */}
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {items.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
            <span className="flex h-14 w-14 items-center justify-center rounded-2xl border border-osborder bg-surface text-muted">
              <ClipboardList size={26} strokeWidth={1.5} />
            </span>
            <p className="mt-2 text-sm font-medium text-ink">{t('clipboard.emptyTitle')}</p>
            <p className="max-w-sm text-sm text-muted">{t('clipboard.emptyHint')}</p>
          </div>
        ) : visible.length === 0 ? (
          <p className="px-2 py-10 text-center text-sm text-muted">
            {t('clipboard.noMatches', { q: query.trim() })}
          </p>
        ) : (
          <ul className="space-y-2">
            {visible.map((item) => (
              <li
                key={item.id}
                className="group flex items-stretch gap-2 rounded-os border border-osborder bg-surface"
              >
                <button
                  type="button"
                  onClick={() => copyBack(item)}
                  title={t('clipboard.copyBack')}
                  className="flex min-h-[56px] min-w-0 flex-1 items-start gap-2.5 rounded-os px-3 py-2.5 text-left duration-160 hover:bg-paper"
                >
                  <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-paper text-muted">
                    {item.kind === 'note' ? <StickyNote size={14} /> : <ClipboardList size={14} />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="line-clamp-3 whitespace-pre-wrap break-words text-sm text-ink">
                      {item.text}
                    </span>
                    <span className="mt-1 block text-xs text-muted">{formatWhen(item.createdAt)}</span>
                  </span>
                  <span className="mt-1 flex w-16 shrink-0 items-center justify-end text-xs font-medium text-accent">
                    {copiedId === item.id ? (
                      <span className="flex items-center gap-1"><Check size={14} /> {t('clipboard.copied')}</span>
                    ) : (
                      <span className="opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100">{t('clipboard.copy')}</span>
                    )}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => deleteItem(item.id)}
                  aria-label={t('clipboard.deleteItem')}
                  title={t('clipboard.delete')}
                  className="flex w-11 shrink-0 items-center justify-center rounded-r-os text-muted duration-160 hover:bg-paper hover:text-ink"
                >
                  <Trash2 size={16} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <p className="border-t border-osborder bg-surface px-4 py-2 text-xs text-muted">
        {t('clipboard.count', { n: items.length, max: MAX_ITEMS })}
      </p>
    </div>
  );
}
