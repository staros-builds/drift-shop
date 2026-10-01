import { useCallback, useEffect, useRef, useState } from 'react';
import { Plus, Trash2, Send, Compass, Cpu, Cloud } from 'lucide-react';
import { backend } from '../lib/backend/current.js';
import { runLocalHelm, formatToolReceipt, MEMORY_TAG } from '../lib/helm.js';
import { resolveAppId } from './registry.jsx';
import { useWindows } from '../os/WindowsContext.jsx';
import { useSettings } from '../os/SettingsContext.jsx';
import { useNotifications } from '../os/NotificationsContext.jsx';
import { ConfirmDialog } from '../components/os/dialogs.jsx';
import { localeTag, useLang } from '../lib/i18n.jsx';

function mapThemeName(name) {
  const n = String(name || '').trim().toLowerCase();
  if (n === 'dark' || n === 'nightshift' || n === 'night') return 'nightshift';
  if (n === 'light' || n === 'daybreak' || n === 'day') return 'daybreak';
  return n;
}

// [locale key suffix, English command text] — the display text is localized,
// but the command sent to the on-device engine stays English so its parser
// understands it regardless of UI language.
const SUGGESTIONS = [
  ['sugWhat', 'What can you do?'],
  ['sugOpen', 'Open Files'],
  ['sugDark', 'Dark mode'],
  ['sugSpaces', 'List my spaces'],
  ['sugWindows', 'What windows are open?'],
  ['sugRemember', 'Remember that my favorite color is persimmon'],
];

/** Tiny markdown-ish renderer: **bold**, `code`, and • / - bullet lines. No deps. */
function renderInline(text, keyPrefix) {
  const parts = String(text).split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return parts.map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      return <strong key={`${keyPrefix}-${i}`}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      return (
        <code key={`${keyPrefix}-${i}`} className="rounded-os bg-paper px-1 text-[13px]">
          {part.slice(1, -1)}
        </code>
      );
    }
    return <span key={`${keyPrefix}-${i}`}>{part}</span>;
  });
}

function renderRich(content) {
  const lines = String(content ?? '').split('\n');
  const blocks = [];
  let bullets = [];
  const flushBullets = () => {
    if (bullets.length) {
      blocks.push(
        <ul key={`b-${blocks.length}`} className="list-disc space-y-0.5 pl-5">
          {bullets.map((b, i) => (
            <li key={i}>{renderInline(b, `bl-${blocks.length}-${i}`)}</li>
          ))}
        </ul>
      );
      bullets = [];
    }
  };
  lines.forEach((line, i) => {
    const bullet = line.match(/^\s*(?:•|-|\*)\s+(.+)$/);
    if (bullet) {
      bullets.push(bullet[1]);
    } else {
      flushBullets();
      if (line.trim() === '') {
        blocks.push(<div key={`s-${i}`} className="h-2" />);
      } else {
        blocks.push(<p key={`p-${i}`}>{renderInline(line, `p-${i}`)}</p>);
      }
    }
  });
  flushBullets();
  return <div className="space-y-1 whitespace-pre-wrap">{blocks}</div>;
}

function TypingDots() {
  const { t } = useLang();
  return (
    <span className="inline-flex items-center gap-1" aria-label={t('helm.thinking')}>
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted"
          style={{ animationDelay: `${i * 150}ms` }}
        />
      ))}
    </span>
  );
}

export default function HelmApp({ windowApi }) {
  const { t } = useLang();
  const { push } = useNotifications();
  const { windows, visibleWindows, spaces, activeSpaceId, openWindow, closeWindow, focusWindow, minimizeWindow, setActiveSpace } = useWindows();
  const { settings, updateSettings } = useSettings();
  const engineMode = settings?.ai_engine === 'cloud' ? 'cloud' : 'local';

  const [threads, setThreads] = useState([]);
  const [activeThreadId, setActiveThreadId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [confirmDeleteId, setConfirmDeleteId] = useState(null); // thread id awaiting delete confirm
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const scrollRef = useRef(null);
  const inputRef = useRef(null);
  // Command history for up/down arrows.
  const historyRef = useRef([]);
  const histIdxRef = useRef(-1);

  const fail = useCallback(
    (key, err) => push(t('dialogs.errorTitle'), `${t(key)}: ${err?.message || err}`),
    [push, t]
  );

  const loadThreads = useCallback(async () => {
    try {
      const list = await backend.helm.threads();
      setThreads(list);
      if (list.length > 0 && !list.some((t) => t.id === activeThreadId)) {
        setActiveThreadId(list[0].id);
      }
    } catch (err) {
      fail('helm.errThreads', err);
    }
  }, [activeThreadId, fail]);

  const loadMessages = useCallback(async () => {
    if (!activeThreadId) {
      setMessages([]);
      return;
    }
    try {
      setMessages(await backend.helm.messages(activeThreadId));
    } catch (err) {
      fail('helm.errMessages', err);
    }
  }, [activeThreadId, fail]);

  useEffect(() => { loadThreads(); }, [loadThreads]);
  useEffect(() => { loadMessages(); }, [loadMessages]);
  useEffect(() => {
    windowApi?.setTitle?.(t('apps.helm'));
  }, [windowApi, t]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, sending]);

  // ---- real ctx functions wired into runLocalHelm ----
  const ctx = useCallback(() => ({
    openApp: (appId) => openWindow(appId),
    closeApp: (appId) => {
      const matches = windows.filter((w) => w.appId === appId);
      matches.forEach((w) => closeWindow(w.id));
      return { closed: matches.length };
    },
    listWindows: async () =>
      visibleWindows.map((w) => ({ id: w.id, appId: w.appId, title: w.title, minimized: !!w.minimized })),
    minimizeApp: (appId) => {
      const matches = windows.filter((w) => w.appId === appId && !w.minimized);
      matches.forEach((w) => minimizeWindow(w.id));
      return { minimized: matches.length };
    },
    focusApp: (appId) => {
      const matches = windows.filter((w) => w.appId === appId);
      if (!matches.length) return { focused: false };
      const top = matches.reduce((a, b) => (a.z > b.z ? a : b));
      focusWindow(top.id);
      return { focused: true };
    },
    closeAllWindows: () => {
      const ids = windows.map((w) => w.id);
      ids.forEach((id) => closeWindow(id));
      return { closed: ids.length };
    },
    goToSpace: (nameOrIndex) => {
      const q = String(nameOrIndex).trim();
      let space = null;
      if (/^\d+$/.test(q)) {
        const idx = parseInt(q, 10) - 1;
        space = spaces[idx] || null;
      } else {
        space = spaces.find((s) => s.name.toLowerCase() === q.toLowerCase())
          || spaces.find((s) => s.name.toLowerCase().includes(q.toLowerCase()))
          || null;
      }
      if (!space) throw new Error(`No space matches "${nameOrIndex}".`);
      setActiveSpace(space.id);
      return { space: space.name };
    },
    listSpaces: async () => spaces.map((s) => ({ id: s.id, name: s.name, active: s.id === activeSpaceId })),
    setTheme: (name) => {
      const theme = mapThemeName(name);
      if (theme !== 'daybreak' && theme !== 'nightshift') {
        throw new Error(`Unknown theme "${name}". Use daybreak or nightshift.`);
      }
      return updateSettings({ visual_theme: theme }).then(() => ({ theme }));
    },
    setWallpaper: (id) => updateSettings({ wallpaper: id }).then(() => ({ wallpaper: id })),
    setTaskbar: (position) => updateSettings({ taskbar_position: position }).then(() => ({ position })),
    setUiStyle: (style) => updateSettings({ ui_style: style }).then(() => ({ style })),
    createPin: ({ title, body, tags }) =>
      backend.pins.create({ kind: 'text', title, body, tags, sourceApp: 'helm' }),
    searchPins: (query) => backend.pins.search(query),
    listFiles: (path) => backend.files.list(path),
    readFile: (path) => backend.files.read(path),
    writeFile: (path, text) => backend.files.write(path, text),
    resolveAppId,
    get_time: () => new Date(),
    engineMode,
    osContext: () => {
      const style = settings?.ui_style || 'drift';
      const theme = settings?.visual_theme || 'daybreak';
      const taskbar = settings?.touch_mode ? 'n/a (touch mode)' : settings?.taskbar_position || 'bottom';
      const spaceList = spaces.map((s) => `${s.name}${s.id === activeSpaceId ? ' (active)' : ''}`).join(', ') || 'none';
      const winList = visibleWindows.map((w) => `${w.title}${w.minimized ? ' (minimized)' : ''}`).join(', ') || 'none';
      return [
        `Time: ${new Date().toLocaleString(localeTag())}`,
        `Interface style: ${style}; theme: ${theme}; taskbar: ${taskbar}`,
        `Spaces: ${spaceList}`,
        `Open windows (active space): ${winList}`,
      ].join('\n');
    },
    // Helm memory: facts stored as pins tagged with MEMORY_TAG so they stay
    // visible (and deletable) in the Pinboard.
    memoryRemember: ({ title, body }) =>
      backend.pins.create({ kind: 'text', title, body, tags: [MEMORY_TAG], sourceApp: 'helm' }),
    memoryRecall: (query) => backend.pins.search(query, { tag: MEMORY_TAG }),
    memoryForget: async (query) => {
      const mems = await backend.pins.search(query, { tag: MEMORY_TAG });
      const targets = query ? mems : await backend.pins.list({ tag: MEMORY_TAG });
      let n = 0;
      for (const p of targets) {
        try {
          await backend.pins.remove(p.id);
          n += 1;
        } catch {
          /* keep going */
        }
      }
      return { forgotten: n };
    },
  }), [windows, visibleWindows, spaces, activeSpaceId, openWindow, closeWindow, focusWindow, minimizeWindow, setActiveSpace, updateSettings, engineMode, settings]);

  const handleNewThread = async () => {
    try {
      const thread = await backend.helm.createThread(t('helm.newConv'));
      setThreads((prev) => [thread, ...prev]);
      setActiveThreadId(thread.id);
    } catch (err) {
      fail('helm.errCreateThread', err);
    }
  };

  const handleDeleteThread = async (id) => {
    try {
      await backend.helm.removeThread(id);
      // H3: choose the next active thread from the fresh list INSIDE the
      // updater — never from the stale `threads` closure.
      setThreads((prev) => {
        const rest = prev.filter((t) => t.id !== id);
        setActiveThreadId((prevActive) =>
          prevActive === id ? (rest.length > 0 ? rest[0].id : null) : prevActive
        );
        return rest;
      });
    } catch (err) {
      fail('helm.errDeleteThread', err);
    }
  };

  const sendText = useCallback(async (rawText) => {
    const text = String(rawText ?? '').trim();
    if (!text || sending) return;
    setSending(true);
    try {
      let threadId = activeThreadId;
      if (!threadId) {
        const thread = await backend.helm.createThread(text.slice(0, 40) || 'New conversation');
        threadId = thread.id;
        setThreads((prev) => [thread, ...prev]);
        setActiveThreadId(threadId);
      }
      await backend.helm.addMessage(threadId, { role: 'user', content: text });

      // Recent conversation for cloud-mode follow-ups (user/assistant only).
      const convoSoFar = [...messages, { role: 'user', content: text }]
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .slice(-6)
        .map((m) => ({ role: m.role, content: m.content }));
      const c = ctx();
      c.recentHistory = () => convoSoFar;

      const { reply, receipts } = await runLocalHelm(text, c);

      await backend.helm.addMessage(threadId, { role: 'assistant', content: reply });
      for (const r of receipts || []) {
        const label = r.label || formatToolReceipt(r.tool, r.args, r.result, t);
        await backend.helm.addMessage(threadId, {
          role: 'tool',
          content: label,
          toolCalls: [{ tool: r.tool, args: r.args || {}, ok: r.ok !== false }],
        });
      }
      // Command history for up/down arrows.
      historyRef.current = [...historyRef.current, text].slice(-50);
      histIdxRef.current = -1;
      // H2: clear the composer only on success — a failed send leaves the
      // user's text in the input so nothing is lost.
      setInput('');
      await loadMessages();
      await loadThreads();
    } catch (err) {
      fail('helm.errAnswer', err);
    } finally {
      setSending(false);
      inputRef.current?.focus();
    }
  }, [sending, activeThreadId, messages, ctx, loadMessages, loadThreads, fail, t]);

  const handleSend = (e) => {
    e.preventDefault();
    sendText(input);
  };

  const handleInputKeyDown = (e) => {
    const hist = historyRef.current;
    if (e.key === 'ArrowUp' && hist.length > 0) {
      e.preventDefault();
      const next = histIdxRef.current === -1 ? hist.length - 1 : Math.max(0, histIdxRef.current - 1);
      histIdxRef.current = next;
      setInput(hist[next]);
    } else if (e.key === 'ArrowDown' && histIdxRef.current !== -1) {
      e.preventDefault();
      const next = histIdxRef.current + 1;
      if (next >= hist.length) {
        histIdxRef.current = -1;
        setInput('');
      } else {
        histIdxRef.current = next;
        setInput(hist[next]);
      }
    }
  };

  // Render assistant messages with their following tool receipts as chips.
  const rendered = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === 'user') {
      rendered.push(
        <div key={m.id} className="flex justify-end">
          <div className="max-w-[80%] rounded-os bg-accent px-3 py-2 text-sm text-accentink shadow-os">
            <p className="whitespace-pre-wrap">{m.content}</p>
          </div>
        </div>
      );
    } else if (m.role === 'assistant') {
      const chips = [];
      let j = i + 1;
      while (j < messages.length && messages[j].role === 'tool') {
        chips.push(messages[j]);
        j++;
      }
      i = j - 1;
      rendered.push(
        <div key={m.id} className="flex justify-start">
          <div className="max-w-[85%]">
            <div className="rounded-os border border-osborder bg-surface px-3 py-2 text-sm shadow-os">
              {renderRich(m.content)}
            </div>
            {chips.length > 0 && (
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {chips.map((c) => (
                  <span
                    key={c.id}
                    className={`rounded-os border px-2 py-0.5 text-xs ${
                      c.toolCalls?.[0]?.ok === false
                        ? 'border-red-300 bg-red-50 text-red-700'
                        : 'border-osborder bg-paper text-muted'
                    }`}
                  >
                    {c.content}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
      );
    }
    // standalone tool messages are folded into the preceding assistant message
  }

  // Engine honesty: local commands (open apps, pins, files, theme…) always run
  // on-device via runLocalHelm and never invent OS state. In cloud mode, open
  // questions go to a free public AI service (see cloudAnswer in helm.js);
  // the badge below always shows which engine is answering.

  const cloudMode = engineMode === 'cloud';

  return (
    <div className="flex h-full bg-paper text-ink">
      {/* Thread sidebar */}
      <div className="flex w-56 shrink-0 flex-col border-r border-osborder bg-surface">
        <div className="border-b border-osborder p-2">
          <button
            onClick={handleNewThread}
            className="flex w-full items-center justify-center gap-1.5 rounded-os bg-accent px-3 py-2 text-sm text-accentink"
          >
            <Plus size={15} /> {t('helm.newThread')}
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {threads.length === 0 ? (
            <p className="px-2 py-6 text-center text-xs text-muted">{t('helm.noThreads')}</p>
          ) : (
            threads.map((th) => (
              <div
                key={th.id}
                onClick={() => setActiveThreadId(th.id)}
                className={`group mb-1 flex cursor-pointer items-center justify-between gap-1 rounded-os px-2.5 py-2 text-sm transition-colors duration-160 ${
                  th.id === activeThreadId ? 'bg-paper shadow-os' : 'hover:bg-paper'
                }`}
              >
                <span className="min-w-0 flex-1 truncate">{th.title || t('helm.conversation')}</span>
                <button
                  title={t('helm.delThread')}
                  aria-label={t('helm.delThread')}
                  onClick={(e) => { e.stopPropagation(); setConfirmDeleteId(th.id); }}
                  className={`shrink-0 rounded-os p-1 text-muted transition-opacity duration-160 hover:text-ink group-hover:opacity-100 focus-within:opacity-100 ${
                    th.id === activeThreadId ? 'opacity-100' : 'opacity-0'
                  }`}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Chat pane */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center justify-between border-b border-osborder bg-surface px-3 py-2">
          <div className="flex items-center gap-2">
            <Compass size={16} className="text-muted" />
            <span className="text-sm font-medium">Helm</span>
          </div>
          <button
            type="button"
            onClick={() => openWindow('settings')}
            className="flex items-center gap-1.5 rounded-os border border-osborder px-2 py-0.5 text-xs text-muted transition-colors duration-160 hover:bg-paper hover:text-ink"
            title={cloudMode ? t('helm.cloudTip') : t('helm.deviceTip')}
          >
            {cloudMode ? <Cloud size={12} /> : <Cpu size={12} />}
            {cloudMode ? t('helm.cloudSmart') : t('helm.onDevice')}
          </button>
        </div>
        {cloudMode && (
          <p className="border-b border-osborder bg-surface px-3 py-1 text-center text-[11px] text-muted">
            {t('helm.cloudWarn')}
          </p>
        )}

        <div ref={scrollRef} className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
          {messages.length === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center text-center">
              <Compass size={32} className="mb-3 text-muted" />
              <p className="max-w-xs text-sm text-muted">
                {cloudMode ? t('helm.emptyCloud') : t('helm.emptyLocal')}
              </p>
              <div className="mt-4 flex max-w-md flex-wrap justify-center gap-2">
                {SUGGESTIONS.map(([tKey, cmd]) => (
                  <button
                    key={cmd}
                    type="button"
                    onClick={() => sendText(cmd)}
                    disabled={sending}
                    className="rounded-os border border-osborder bg-surface px-3 py-1.5 text-xs text-ink shadow-os transition-colors duration-160 hover:bg-paper disabled:opacity-40"
                  >
                    {t(`helm.${tKey}`)}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            rendered
          )}
          {sending && (
            <div className="flex justify-start">
              <div className="rounded-os border border-osborder bg-surface px-3 py-2 shadow-os">
                <TypingDots />
              </div>
            </div>
          )}
        </div>

        <form onSubmit={handleSend} className="flex gap-2 border-t border-osborder bg-surface p-3">
          <input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleInputKeyDown}
            placeholder={t('helm.askPh')}
            disabled={sending}
            className="min-w-0 flex-1 rounded-os border border-osborder bg-paper px-3 py-2 text-sm outline-none placeholder:text-muted"
          />
          <button
            type="submit"
            disabled={!input.trim() || sending}
            className="flex items-center gap-1.5 rounded-os bg-accent px-4 py-2 text-sm text-accentink transition-opacity duration-160 disabled:opacity-40"
          >
            <Send size={15} /> {t('helm.send')}
          </button>
        </form>
      </div>
      {confirmDeleteId && (
        <ConfirmDialog
          title={t('helm.delThreadTitle')}
          message={t('helm.delThreadMsg')}
          confirmLabel={t('helm.delete')}
          cancelLabel={t('helm.keep')}
          danger
          onConfirm={() => {
            const id = confirmDeleteId;
            setConfirmDeleteId(null);
            handleDeleteThread(id);
          }}
          onCancel={() => setConfirmDeleteId(null)}
        />
      )}
    </div>
  );
}
