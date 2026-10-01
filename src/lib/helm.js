import { localeTag } from './localeTag.js';
/**
 * Drift Helm — local deterministic command parser + tool definitions.
 *
 * Two engines:
 * - Local (on-device): understands a documented set of command patterns,
 *   executes them against the REAL app functions passed in via ctx, and
 *   reports what actually happened through tool receipts. Replies about OS
 *   state (apps, spaces, files, pins, windows) come ONLY from ctx tool
 *   results — state is never invented. It also does live web lookups
 *   (keyless public sources), remembers facts as tagged pins, does
 *   arithmetic, and answers from a built-in troubleshooting guide. Unknown
 *   input gets an honest "I don't know that one" reply, never a fabricated
 *   answer.
 * - Cloud smart: open questions are answered conversationally by a free
 *   public AI service (see cloudAnswer). Local commands always run on-device
 *   first, so the cloud never touches OS state.
 *
 * ctx = { openApp, closeApp, listWindows, minimizeApp, focusApp,
 *         closeAllWindows, goToSpace, listSpaces, setTheme, setWallpaper,
 *         setTaskbar, setUiStyle, createPin, searchPins, listFiles,
 *         readFile, writeFile, resolveAppId, engineMode, osContext,
 *         recentHistory, memoryRemember, memoryRecall, memoryForget }
 *   All ctx functions are async. resolveAppId(input) -> app id or null.
 *   engineMode is 'local' or 'cloud'. osContext() -> string describing live
 *   OS state for the cloud prompt. recentHistory() -> [{role, content}].
 */

export const HELM_TOOLS = [
  {
    name: 'open_app',
    description: 'Open an app by its id (e.g. files, pinboard, helm, settings) or a webapp: id.',
    params: ['app_id'],
  },
  {
    name: 'close_app',
    description: 'Close every open window of an app by its id.',
    params: ['app_id'],
  },
  {
    name: 'list_windows',
    description: 'List currently open windows (title, app, minimized).',
    params: [],
  },
  {
    name: 'minimize_app',
    description: "Minimize every open window of an app by its id.",
    params: ['app_id'],
  },
  {
    name: 'focus_app',
    description: "Bring an app's most recent window to the front (unminimizes).",
    params: ['app_id'],
  },
  {
    name: 'close_all_windows',
    description: 'Close every open window.',
    params: [],
  },
  {
    name: 'go_to_space',
    description: 'Switch to a space by name or 1-based index.',
    params: ['name_or_index'],
  },
  {
    name: 'list_spaces',
    description: 'List the available spaces.',
    params: [],
  },
  {
    name: 'set_theme',
    description: "Set the visual theme: 'daybreak' (light paper) or 'nightshift' (dark).",
    params: ['name'],
  },
  {
    name: 'set_wallpaper',
    description: "Set the wallpaper: 'paper-grain', 'linen', 'dusk', 'plain', 'img-dawn', 'img-ink', 'img-garden' or 'img-harbor'.",
    params: ['id'],
  },
  {
    name: 'set_taskbar',
    description: "Dock the taskbar to an edge: 'top', 'bottom', 'left' or 'right'.",
    params: ['position'],
  },
  {
    name: 'set_ui_style',
    description: "Set the interface style: 'drift', 'windows11' or 'macosx'.",
    params: ['style'],
  },
  {
    name: 'create_pin',
    description: 'Save a pin to the Pinboard capture tray.',
    params: ['title', 'body', 'tags'],
  },
  {
    name: 'search_pins',
    description: "Ranked search over the user's saved pins.",
    params: ['query'],
  },
  {
    name: 'list_files',
    description: 'List files and folders at a VFS path.',
    params: ['path'],
  },
  {
    name: 'read_file',
    description: 'Read a text file from the VFS.',
    params: ['path'],
  },
  {
    name: 'write_file',
    description: 'Create or overwrite a text file at a VFS path.',
    params: ['path', 'text'],
  },
  {
    name: 'find_file',
    description: 'Search the file system for a file by name (substring, breadth-limited).',
    params: ['name'],
  },
  {
    name: 'get_time',
    description: 'Get the current date and time.',
    params: [],
  },
  {
    name: 'web_search',
    description: 'Look up information on the public web (keyless public sources: DuckDuckGo instant answers, Wikipedia).',
    params: ['query'],
  },
  {
    name: 'remember',
    description: 'Remember a fact the user stated, stored as a tagged pin.',
    params: ['fact'],
  },
  {
    name: 'recall_memory',
    description: 'Recall remembered facts, optionally filtered by a query.',
    params: ['query'],
  },
  {
    name: 'forget_memory',
    description: 'Forget remembered facts matching a query, or all of them.',
    params: ['query'],
  },
  {
    name: 'cloud_answer',
    description: 'Answer an open question with the cloud smart engine (free public AI service).',
    params: ['question'],
  },
  {
    name: 'troubleshoot',
    description: 'Help with a Drift problem from the built-in troubleshooting guide.',
    params: ['topic'],
  },
];

const THEMES = { nightshift: 'Nightshift (dark)', daybreak: 'Daybreak (light)' };
const WALLPAPERS = ['paper-grain', 'linen', 'dusk', 'plain'];
const TASKBAR_POSITIONS = ['top', 'bottom', 'left', 'right'];
const UI_STYLES = { drift: 'Drift', windows11: 'Windows 11', macosx: 'Mac OS X 10.6' };

/**
 * Short human label for a tool execution, rendered as a receipt chip.
 * formatToolReceipt(tool, args, result, t?) -> string, e.g. 'Opened Files'.
 * Pass the i18n t() as the 4th argument to localize the chip.
 */
// Receipt chips shown under assistant messages. The optional 4th argument is
// the i18n t() from the Helm UI — when provided, chips render in the current
// UI language; without it they stay English (backwards-compatible).
export function formatToolReceipt(tool, args = {}, result, t) {
  const L = (key, vars, fallback) => {
    if (typeof t === 'function') return t(`helm.receipts.${key}`, vars);
    let out = fallback;
    for (const [k, v] of Object.entries(vars || {})) out = out.replace(`{${k}}`, String(v));
    return out;
  };
  switch (tool) {
    case 'open_app':
      return L('opened', { x: args.app_title || args.app_id }, 'Opened {x}');
    case 'close_app':
      return L('closed', { x: args.app_title || args.app_id }, 'Closed {x}');
    case 'list_windows':
      return L('listedWindows', {}, 'Listed open windows');
    case 'minimize_app':
      return L('minimized', { x: args.app_title || args.app_id }, 'Minimized {x}');
    case 'focus_app':
      return L('focused', { x: args.app_title || args.app_id }, 'Focused {x}');
    case 'close_all_windows':
      return L('closedAll', { n: result?.closed ?? 'all' }, 'Closed {n} windows');
    case 'go_to_space':
      return L('switchedSpace', { x: result?.name || args.name_or_index }, 'Switched to {x}');
    case 'list_spaces':
      return L('listedSpaces', {}, 'Listed spaces');
    case 'set_theme':
      return L('themeSet', { x: THEMES[args.name] || args.name }, 'Theme set to {x}');
    case 'set_wallpaper':
      return L('wallpaperSet', { x: args.id }, 'Wallpaper set to {x}');
    case 'set_taskbar':
      return L('taskbar', { x: args.position }, 'Taskbar moved to the {x}');
    case 'set_ui_style':
      return L('uiStyle', { x: UI_STYLES[args.style] || args.style }, 'Interface style set to {x}');
    case 'create_pin':
      return L('pinned', { x: args.title }, 'Pinned "{x}"');
    case 'search_pins':
      return L('searchedPins', { x: args.query }, 'Searched pins for "{x}"');
    case 'list_files':
      return L('listedPath', { x: args.path }, 'Listed {x}');
    case 'read_file':
      return L('readPath', { x: args.path }, 'Read {x}');
    case 'write_file':
      return L('wrotePath', { x: args.path }, 'Wrote {x}');
    case 'find_file':
      return L('searchedFiles', { x: args.name }, 'Searched files for "{x}"');
    case 'get_time':
      return L('checkedTime', {}, 'Checked the time');
    case 'web_search':
      return L('searchedWeb', { x: args.query }, 'Searched the web for "{x}"');
    case 'remember':
      return L('remembered', {}, 'Remembered that');
    case 'recall_memory':
      return args.query
        ? L('recalled', { x: args.query }, 'Recalled memories about "{x}"')
        : L('recalledAll', {}, 'Recalled memories');
    case 'forget_memory':
      return L('forgot', {}, 'Forgot memories');
    case 'cloud_answer':
      return L('cloudAnswer', {}, 'Answered with cloud smart mode');
    case 'troubleshoot':
      return L('helped', { x: args.topic }, 'Helped with "{x}"');
    default:
      return tool;
  }
}

const HELP_TEXT =
  "Here's what I can do:\n" +
  '• Apps: "open <app>", "close <app>", "minimize <app>", "what windows are open", "close all windows"\n' +
  '• Look & feel: "dark mode" / "light mode", "move the taskbar to the left", "switch to the Mac look" (or Windows 11, or Drift)\n' +
  '• Spaces: "list spaces", "go to space <name>"\n' +
  '• Files: "list files in <path>", "read file <path>", "find file <name>", "new note <text>", "create file <name> with <text>"\n' +
  '• Pins: "pin this: <text>", "search pins for <query>"\n' +
  '• Memory: "remember that <fact>", "what do you remember", "forget <thing>"\n' +
  '• Math: "what is 12 * 8"\n' +
  '• Web: "search the web for <topic>" — or just ask me a question and I\'ll look it up\n' +
  '• Problems: describe it, e.g. "my upload keeps failing"\n' +
  '• Cloud smart mode (Settings → Helm) handles open-ended questions conversationally.';

const UNKNOWN_REPLY =
  "Hmm, that one's not in my playbook — and I'd rather say so than fake it. " +
  'I can open and wrangle apps, change the theme and taskbar, hop between spaces, dig through ' +
  'files and pins, remember things for you, do math, or look stuff up on the web. Try "help" ' +
  'for the full list, or flip on Cloud smart mode in Settings → Helm and ask me anything.';

const GREETING_REPLIES = [
  'Hey. What do you need?',
  'Hey — what are we working on?',
  "Hi there. What's up?",
];
const THANKS_REPLIES = ['Anytime.', 'You got it.', 'Happy to help.'];
// Deterministic pick (same input -> same reply).
const pick = (arr, seed) => arr[Math.abs(seed) % arr.length];

// Tag used for memory pins. They show in the Pinboard like any other pin so
// the user can see and delete what Helm remembers.
export const MEMORY_TAG = 'helm-memory';

/**
 * webLookup(query) -> { answer, sources: [{ title, url }] }
 * Live public-web lookup with no API key: DuckDuckGo instant answers first,
 * Wikipedia search + intro extract as fallback. Throws an honest error when
 * nothing is found or the network is unreachable.
 */
export async function webLookup(query) {
  const q = String(query || '').trim().replace(/[?.!]+$/, '');
  if (!q) throw new Error('EMPTY_QUERY');

  // 1) DuckDuckGo instant answers (keyless, CORS-open).
  try {
    const res = await fetch(
      `https://api.duckduckgo.com/?q=${encodeURIComponent(q)}&format=json&no_html=1&skip_disambig=1`
    );
    if (res.ok) {
      const ddg = await res.json();
      if (ddg && ddg.AbstractText) {
        return {
          answer: ddg.AbstractText,
          sources: [
            {
              title: ddg.AbstractSource || 'DuckDuckGo',
              url: ddg.AbstractURL || `https://duckduckgo.com/?q=${encodeURIComponent(q)}`,
            },
          ],
        };
      }
    }
  } catch {
    // Network or parse failure — fall through to Wikipedia, and if that
    // fails too the honest error below covers it.
  }

  // 2) Wikipedia search + intro extract (keyless, CORS-open with origin=*).
  let searchJson;
  try {
    const sRes = await fetch(
      `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(q)}&srlimit=3&format=json&origin=*`
    );
    if (!sRes.ok) throw new Error('bad status');
    searchJson = await sRes.json();
  } catch {
    throw new Error(
      `I couldn't reach the web to look up "${q}" — check your connection and try again.`
    );
  }
  const hit = searchJson?.query?.search?.[0];
  if (!hit) throw new Error(`I couldn't find anything on the web for "${q}".`);

  const pageTitle = hit.title;
  let extract = '';
  try {
    const eRes = await fetch(
      `https://en.wikipedia.org/w/api.php?action=query&prop=extracts&exintro&explaintext&titles=${encodeURIComponent(pageTitle)}&format=json&origin=*`
    );
    if (eRes.ok) {
      const eJson = await eRes.json();
      const pages = eJson?.query?.pages || {};
      extract = String(Object.values(pages)[0]?.extract || '').trim();
    }
  } catch {
    // fall through — extract stays empty
  }
  if (!extract) throw new Error(`I found "${pageTitle}" but couldn't read a summary.`);
  const short = extract.length > 900 ? `${extract.slice(0, 900).trimEnd()}…` : extract;
  return {
    answer: short,
    sources: [
      {
        title: `${pageTitle} — Wikipedia`,
        url: `https://en.wikipedia.org/wiki/${encodeURIComponent(pageTitle.replace(/ /g, '_'))}`,
      },
    ],
  };
}

// Compact Drift briefing baked into the cloud system prompt so cloud mode
// can genuinely help with Drift problems without inventing OS state.
const CLOUD_SYSTEM =
  'You are Helm, the in-OS companion inside Drift, a calm paper-and-ink cloud desktop OS. ' +
  'Talk like a friendly shop assistant: warm, direct, a little playful, real opinions, zero corporate filler. ' +
  'Never open with "Great question!" or "I\'d be happy to help!" — just help. ' +
  'Be concise and plain-spoken. You cannot see the user\'s files, pins, or screen beyond the live context below — ' +
  'never invent their contents; if you don\'t know, say so honestly and offer the closest useful thing. ' +
  'For doing things in Drift, give the exact command the user can say to you, e.g. "open files", "pin this: buy milk", ' +
  '"search the web for mars rovers", "dark mode", "move the taskbar to the left", "switch to the mac look". ' +
  'Never ask for or repeat passwords. ' +
  'Troubleshooting reference: accounts and data are separate between the Cloud and This-device login modes — if files seem missing, check the login mode. ' +
  'Uploads accept any file type up to 500 MB per file. If a website shows blank inside an App Store web app it blocks embedding: use "Try text view" or open it in a new tab. ' +
  'In Point of Sale, cashiers only see their own sales; managers and owners see everything. ' +
  'If an app misbehaves, closing and reopening it (or reloading the page) fixes most issues.';

/**
 * cloudAnswer(text, opts) -> string
 * Conversational answer from the cloud smart engine: a free public AI
 * service, no key required. opts: { history: [{role, content}], osContext }
 * Throws an honest error on network/API failure or non-text responses.
 */
export async function cloudAnswer(text, opts = {}) {
  const userText = String(text || '').trim().slice(0, 1500);
  if (!userText) throw new Error('Nothing to answer.');
  const history = Array.isArray(opts.history) ? opts.history.slice(-6) : [];
  const osContext = typeof opts.osContext === 'string' ? opts.osContext : '';
  const historyBlock = history
    .map((m) => `${m.role === 'user' ? 'User' : 'Helm'}: ${String(m.content || '').slice(0, 500)}`)
    .join('\n');
  const prompt =
    `${CLOUD_SYSTEM}\n\n` +
    (osContext ? `Live OS context (don't claim to see beyond this):\n${osContext}\n\n` : '') +
    (historyBlock ? `Recent conversation:\n${historyBlock}\n\n` : '') +
    `User: ${userText}\nHelm:`;
  let res;
  try {
    res = await fetch(`https://text.pollinations.ai/${encodeURIComponent(prompt)}`, {
      headers: { Accept: 'text/plain' },
    });
  } catch {
    throw new Error("I couldn't reach the cloud engine — check your connection and try again.");
  }
  if (!res.ok) throw new Error(`The cloud engine returned an error (${res.status}). Try again in a moment.`);
  const raw = await res.text();
  const answer = raw.trim();
  // The endpoint occasionally returns an HTML error page instead of text.
  if (!answer) throw new Error('The cloud engine returned an empty answer. Try again.');
  if (/^\s*(<!doctype|<html)/i.test(answer)) {
    throw new Error('The cloud engine returned a web page instead of an answer. Try again in a moment.');
  }
  return answer;
}

/**
 * calcExpr(src) -> number|null
 * Tiny safe arithmetic parser (+ - * / % ^, parentheses, decimals).
 * Returns null when the input isn't a valid expression; never evals.
 */
export function calcExpr(src) {
  const s = String(src || '').replace(/\s+/g, '');
  if (!s || !/^[0-9+\-*/().%^]+$/.test(s) || !/\d/.test(s) || !/[+\-*/%^()]/.test(s)) return null;
  let pos = 0;
  const peek = () => s[pos];
  function parseExpr() {
    let v = parseTerm();
    while (peek() === '+' || peek() === '-') {
      const op = s[pos++];
      const r = parseTerm();
      v = op === '+' ? v + r : v - r;
    }
    return v;
  }
  function parseTerm() {
    let v = parseFactor();
    while (peek() === '*' || peek() === '/' || peek() === '%') {
      const op = s[pos++];
      const r = parseFactor();
      v = op === '*' ? v * r : op === '/' ? v / r : v % r;
    }
    return v;
  }
  function parseFactor() {
    let sign = 1;
    while (peek() === '+' || peek() === '-') {
      if (s[pos++] === '-') sign = -sign;
    }
    let v = parsePrimary();
    if (peek() === '^') {
      pos++;
      v = Math.pow(v, parseFactor()); // right-associative
    }
    return sign * v;
  }
  function parsePrimary() {
    if (peek() === '(') {
      pos++;
      const v = parseExpr();
      if (peek() !== ')') throw new Error('bad');
      pos++;
      return v;
    }
    const m = /^[0-9]*\.?[0-9]+/.exec(s.slice(pos));
    if (!m) throw new Error('bad');
    pos += m[0].length;
    return parseFloat(m[0]);
  }
  try {
    const v = parseExpr();
    if (pos !== s.length || !Number.isFinite(v)) return null;
    return v;
  } catch {
    return null;
  }
}

// Built-in troubleshooting guide: keyword -> plain-language fix. Checked
// when the user describes a problem; cloud mode is the fallback for
// anything not covered here.
const TROUBLESHOOTING = [
  {
    keys: ['log in', 'login', 'sign in', 'password', 'locked out', "can't get in"],
    title: 'signing in',
    answer:
      'Use the username or email and password you registered with. There\'s no self-serve password reset yet, so if you\'re stuck, ' +
      'tell me exactly what the login screen says and we\'ll figure it out.',
  },
  {
    keys: ['upload', 'file too large', 'failed to upload', "won't upload"],
    title: 'uploads',
    answer:
      'Uploads accept any file type up to 500 MB per file. If one fails: check the size, ' +
      'check your connection, and make sure you\'re still signed in. Big files take a while — give it a minute before retrying.',
  },
  {
    keys: ['web app', 'blank page', 'website', "won't load", 'embedding', 'youtube', 'video'],
    title: 'websites not loading in a web app',
    answer:
      'Some sites refuse to be embedded — that\'s your browser enforcing their rules, not Drift being broken. When a page stays blank, ' +
      'hit "Try text view" for a readable version, or "Open in new tab" to see it properly. YouTube, Vimeo, Twitch and Google Docs links ' +
      'get converted to their embeddable versions automatically.',
  },
  {
    keys: ['files missing', 'files gone', 'disappeared', 'where are my files', 'lost my'],
    title: 'missing files',
    answer:
      'Files live separately in each login mode — Cloud files and This-device files are two different sets. If yours seem gone, ' +
      'you\'re probably in the other mode: sign out and back in with the right one. Drift never deletes files on its own.',
  },
  {
    keys: ['pos', 'sale', 'register', 'cashier', 'checkout', 'receipt'],
    title: 'Point of Sale',
    answer:
      'In Point of Sale, cashiers only see their own sales — managers and owners see everything, so check your role if sales look missing. ' +
      'Each store keeps its own products and sale numbering, and receipts can be reprinted from History.',
  },
  {
    keys: ['slow', 'frozen', 'stuck', 'crash', 'not responding', 'blank screen', 'white screen'],
    title: 'an app misbehaving',
    answer:
      'Close the window and reopen the app — that fixes the vast majority of these. If the whole desktop acts up, reload the page; ' +
      'your data is saved. In Cloud mode, a dropped connection can also cause weirdness, so check you\'re still online.',
  },
  {
    keys: ['theme', 'wallpaper', 'dark mode', 'light mode', 'not saving', 'settings'],
    title: 'settings not sticking',
    answer:
      'Theme, wallpaper and the rest save per account. If a change doesn\'t stick, make sure you\'re signed in and give the save a beat ' +
      'before closing the window. You can also just tell me — "dark mode", "move the taskbar to the left" — and I\'ll set it directly.',
  },
];

function findTroubleshooting(low) {
  const problemIntent = /\b(problem|issue|trouble|not working|doesn'?t work|won'?t|cannot|can'?t|broken|error|fail(?:ed|ing|ure)?|fix|help me|wrong)\b/i.test(low);
  if (!problemIntent) return null;
  const hit = TROUBLESHOOTING.find((t) => t.keys.some((k) => low.includes(k)));
  return hit || null;
}

const GREETINGS = /^(hi|hello|hey|yo|good morning|good afternoon|good evening|howdy)\b[!.]*$/i;
const THANKS = /^(thanks|thank you|thx|cheers|much appreciated)\b[!.]*$/i;

/**
 * Breadth-limited filename search over the VFS using ctx.listFiles.
 * Never throws — returns [] on backend errors.
 */
async function findFileInVfs(ctx, name) {
  const q = String(name || '').toLowerCase().trim();
  if (!q || typeof ctx.listFiles !== 'function') return [];
  const hits = [];
  const queue = ['/'];
  const seen = new Set(['/']);
  let steps = 0;
  while (queue.length && hits.length < 20 && steps < 400) {
    const dir = queue.shift();
    steps += 1;
    let entries;
    try {
      entries = await ctx.listFiles(dir);
    } catch {
      continue;
    }
    for (const e of entries || []) {
      const p = dir === '/' ? `/${e.name}` : `${dir}/${e.name}`;
      if (String(e.name || '').toLowerCase().includes(q)) {
        hits.push({ path: p, type: e.type });
      }
      if (e.type === 'folder' && !seen.has(p) && queue.length < 200) {
        seen.add(p);
        queue.push(p);
      }
    }
  }
  return hits;
}

function sanitizePath(raw) {
  let p = String(raw || '').trim();
  if (!p) return null;
  if (!p.startsWith('/')) p = `/${p}`;
  if (p.includes('..')) return null;
  return p;
}

/**
 * runLocalHelm(text, ctx) -> { reply, receipts: [{ tool, label, ok }] }
 * Deterministic: same input + same ctx results => same output. Every tool
 * call is wrapped so failures produce an honest error reply, never a lie.
 */
export async function runLocalHelm(text, ctx) {
  const input = String(text ?? '').trim();
  const receipts = [];

  // Executes a tool against ctx, records the receipt, returns { ok, result, error }.
  const run = async (tool, args, fn) => {
    try {
      const result = await fn();
      receipts.push({ tool, label: formatToolReceipt(tool, args, result), ok: true });
      return { ok: true, result };
    } catch (err) {
      receipts.push({ tool, label: formatToolReceipt(tool, args), ok: false });
      return { ok: false, error: err };
    }
  };

  const fail = (op) => {
    const msg = op.error?.message || 'something went wrong on my end';
    return `That didn't work — ${msg.endsWith('.') ? msg : `${msg}.`}`;
  };

  // Resolve an app name/id/title to an id, or null.
  const resolve = (raw) => (typeof ctx.resolveAppId === 'function' ? ctx.resolveAppId(raw) : null);

  if (!input) {
    return { reply: 'I\'m listening — what do you need? Try "help" for ideas.', receipts };
  }

  const low = input.toLowerCase();

  // ---- help ----------------------------------------------------------------
  if (/^(help|what can you do|commands|helm)\s*[?.!]*$/i.test(input)) {
    return { reply: HELP_TEXT, receipts };
  }

  // ---- time ----------------------------------------------------------------
  if (/\b(what time|what's the time|current time|get time|time is it|what day is it|today's date)\b/i.test(low)) {
    const n = new Date();
    await run('get_time', {}, async () => ({ iso: n.toISOString() }));
    const time = n.toLocaleTimeString(localeTag(), { hour: 'numeric', minute: '2-digit' });
    const date = n.toLocaleDateString(localeTag(), { weekday: 'long', month: 'long', day: 'numeric' });
    return { reply: `It's ${time} on ${date}.`, receipts };
  }

  // ---- interface style ------------------------------------------------------
  let m = low.match(/\bwindows\s?11\b[^.?!]{0,30}\b(look|style|mode|theme)\b/) ||
          low.match(/\b(look|style|mode|theme|switch to|use)\b[^.?!]{0,30}\bwindows\s?11\b/);
  if (m) {
    const r = await run('set_ui_style', { style: 'windows11' }, () => ctx.setUiStyle('windows11'));
    return { reply: r.ok ? 'Windows 11 mode. Very official.' : fail(r), receipts };
  }
  m = low.match(/\b(mac(\s?os)?(\s?x)?|apple|snow\s?leopard)\b[^.?!]{0,30}\b(look|style|mode|theme)\b/) ||
      low.match(/\b(look|style|mode|theme|switch to|go)\b[^.?!]{0,30}\bmac\b/);
  if (m) {
    const r = await run('set_ui_style', { style: 'macosx' }, () => ctx.setUiStyle('macosx'));
    return { reply: r.ok ? 'Mac look engaged. Glass dock and all.' : fail(r), receipts };
  }
  m = low.match(/\bdrift\b[^.?!]{0,30}\b(look|style|mode|theme)\b/) ||
      low.match(/\bdefault\b[^.?!]{0,20}\b(look|style|theme)\b/);
  if (m) {
    const r = await run('set_ui_style', { style: 'drift' }, () => ctx.setUiStyle('drift'));
    return { reply: r.ok ? 'Back to classic Drift.' : fail(r), receipts };
  }

  // ---- taskbar position -----------------------------------------------------
  m = low.match(/\btaskbar\b[^.?!]{0,40}\b(top|bottom|left|right)\b/);
  if (m && typeof ctx.setTaskbar === 'function') {
    const position = m[1];
    if (!TASKBAR_POSITIONS.includes(position)) {
      return { reply: `The taskbar can go ${TASKBAR_POSITIONS.join(', ')}. Pick one.`, receipts };
    }
    const r = await run('set_taskbar', { position }, () => ctx.setTaskbar(position));
    return { reply: r.ok ? `Taskbar's on the ${position} now.` : fail(r), receipts };
  }

  // ---- theme ---------------------------------------------------------------
  m = low.match(/\b(dark mode|night ?shift|dark theme|lights out|go dark)\b/);
  if (m) {
    const r = await run('set_theme', { name: 'nightshift' }, () => ctx.setTheme('nightshift'));
    return { reply: r.ok ? 'Nightshift it is — easy on the eyes.' : fail(r), receipts };
  }
  m = low.match(/\b(light mode|day ?break|light theme|lights on|go light)\b/);
  if (m) {
    const r = await run('set_theme', { name: 'daybreak' }, () => ctx.setTheme('daybreak'));
    return { reply: r.ok ? 'Daybreak — back to paper and ink.' : fail(r), receipts };
  }

  // ---- wallpaper ------------------------------------------------------------
  m = input.match(/\bwallpaper\s*(?:to\s+|is\s+)?(paper-grain|linen|dusk|plain|img-dawn|img-ink|img-garden|img-harbor)\b/i);
  if (m) {
    const id = m[1].toLowerCase();
    const r = await run('set_wallpaper', { id }, () => ctx.setWallpaper(id));
    return { reply: r.ok ? `Wallpaper set to ${id}. Nice choice.` : fail(r), receipts };
  }
  if (/\b(set|change|use)\b.*\bwallpaper\b/i.test(low)) {
    return {
      reply: `Which wallpaper? The options are: ${WALLPAPERS.join(', ')}.`,
      receipts,
    };
  }

  // ---- list windows ---------------------------------------------------------
  if (/^(what windows are open|list windows|show windows|open windows|which windows)\b[?.!]*$/i.test(input)) {
    const r = await run('list_windows', {}, () => ctx.listWindows());
    if (!r.ok) return { reply: fail(r), receipts };
    const wins = r.result || [];
    if (wins.length === 0) return { reply: 'No windows open right now. Clean desk.', receipts };
    const lines = wins.map((w) => `• ${w.title}${w.minimized ? ' (minimized)' : ''}`);
    return { reply: `Open windows:\n${lines.join('\n')}`, receipts };
  }

  // ---- list spaces ----------------------------------------------------------
  if (/^(list|show|what)\s+spaces?\b[?.!]*$/i.test(input)) {
    const r = await run('list_spaces', {}, () => ctx.listSpaces());
    if (!r.ok) return { reply: fail(r), receipts };
    const spaces = r.result || [];
    if (spaces.length === 0) return { reply: "You don't have any spaces yet.", receipts };
    const names = spaces.map((s) => s.name).join(', ');
    return { reply: `Your spaces: ${names}. Say "go to space <name>" to hop over.`, receipts };
  }

  // ---- minimize / focus app ---------------------------------------------------
  m = input.match(/^(?:minimize|minimise|hide)\s+(.+?)\s*[?.!]*$/i);
  if (m && typeof ctx.minimizeApp === 'function') {
    const raw = m[1].trim();
    const appId = resolve(raw);
    if (!appId) return { reply: `I don't know an app called "${raw}".`, receipts };
    const r = await run('minimize_app', { app_id: appId, app_title: raw }, () => ctx.minimizeApp(appId));
    return { reply: r.ok ? (r.result?.minimized > 0 ? `Minimized ${raw}.` : `${raw} has no open windows to minimize.`) : fail(r), receipts };
  }
  m = input.match(/^(?:focus|bring to front)\s+(.+?)\s*[?.!]*$/i) ||
      input.match(/^show\s+me\s+(?:the\s+)?(.+?)\s*[?.!]*$/i);
  if (m && typeof ctx.focusApp === 'function') {
    const raw = m[1].trim();
    const appId = resolve(raw);
    if (!appId) return { reply: `I don't know an app called "${raw}".`, receipts };
    const r = await run('focus_app', { app_id: appId, app_title: raw }, () => ctx.focusApp(appId));
    return { reply: r.ok ? (r.result?.focused ? `${raw} is front and center.` : `${raw} isn't open — say "open ${raw}" first.`) : fail(r), receipts };
  }

  // ---- close all windows ------------------------------------------------------
  if (/^(?:close|quit)\s+all(?:\s+windows?)?\s*[?.!]*$/i.test(input)) {
    const r = await run('close_all_windows', {}, () => ctx.closeAllWindows());
    if (!r.ok) return { reply: fail(r), receipts };
    const n = r.result?.closed ?? 0;
    return { reply: n > 0 ? `Closed ${n} window${n === 1 ? '' : 's'}. Fresh slate.` : 'Nothing was open.', receipts };
  }

  // ---- close app ------------------------------------------------------------------
  m = input.match(/^(?:close|quit)\s+(.+?)\s*[?.!]*$/i);
  if (m) {
    const raw = m[1].trim();
    const appId = resolve(raw);
    if (!appId) {
      return { reply: `I don't know an app called "${raw}".`, receipts };
    }
    const r = await run('close_app', { app_id: appId, app_title: raw }, () => ctx.closeApp(appId));
    return { reply: r.ok ? (r.result?.closed > 0 ? `Closed ${raw}.` : `${raw} wasn't open.`) : fail(r), receipts };
  }

  // ---- open app ---------------------------------------------------------------------
  m = input.match(/^open\s+(.+?)\s*[?.!]*$/i);
  if (m) {
    const raw = m[1].trim();
    const appId = resolve(raw);
    if (!appId) {
      return {
        reply:
          `I don't know an app called "${raw}". Try "open files", "open pinboard", ` +
          `"open helm" or "open settings" — or "read file <path>" for a file.`,
        receipts,
      };
    }
    const r = await run('open_app', { app_id: appId, app_title: raw }, () => ctx.openApp(appId));
    return { reply: r.ok ? `Opening ${raw}.` : fail(r), receipts };
  }

  // ---- go to space ---------------------------------------------------------------------
  m = input.match(/^(?:go\s+to|switch\s+to|goto)\s+(?:the\s+)?space\s+(.+?)\s*[?.!]*$/i) ||
      input.match(/^space\s+(.+?)\s*[?.!]*$/i);
  if (m) {
    const asked = m[1].trim();
    const r = await run('go_to_space', { name_or_index: asked }, () => ctx.goToSpace(asked));
    if (!r.ok) {
      // Offer the actual spaces so the user can pick one that exists.
      let hint = '';
      try {
        const spaces = typeof ctx.listSpaces === 'function' ? await ctx.listSpaces() : [];
        if (spaces.length) hint = ` Your spaces: ${spaces.map((s) => s.name).join(', ')}.`;
      } catch { /* hint stays empty */ }
      return { reply: `That didn't work — ${r.error?.message || 'unknown error'}.${hint}`, receipts };
    }
    const name = r.result?.name || asked;
    return { reply: `Over to ${name}.`, receipts };
  }

  // ---- pin this --------------------------------------------------------------
  m = input.match(/^pin this:\s*([\s\S]+)$/i);
  if (m) {
    const body = m[1].trim();
    if (!body) return { reply: 'There was nothing after "pin this:" — give me some text to pin.', receipts };
    const title = body.length > 48 ? `${body.slice(0, 45).trimEnd()}…` : body;
    const r = await run('create_pin', { title, body, tags: [] }, () =>
      ctx.createPin({ title, body, tags: [] })
    );
    return { reply: r.ok ? `Pinned "${title}".` : fail(r), receipts };
  }

  // ---- search pins -------------------------------------------------------------
  m = input.match(/^(?:search|find)\s+pins?\s+(?:for\s+)?([\s\S]+)$/i);
  if (m) {
    const query = m[1].trim().replace(/[?.!]+$/, '');
    const r = await run('search_pins', { query }, () => ctx.searchPins(query));
    if (!r.ok) return { reply: fail(r), receipts };
    const hits = r.result || [];
    if (hits.length === 0) return { reply: `No pins matched "${query}".`, receipts };
    const shown = hits.slice(0, 5).map((p) => `"${p.title}"`).join(', ');
    const more = hits.length > 5 ? `, and ${hits.length - 5} more` : '';
    return {
      reply: `Found ${hits.length} pin${hits.length === 1 ? '' : 's'}: ${shown}${more}.`,
      receipts,
    };
  }

  // ---- new note ------------------------------------------------------------------
  if (/^(?:new|write|make)\s+note\s*[:\-]?\s*$/.test(input) && typeof ctx.writeFile === 'function') {
    return { reply: 'What should the note say?', receipts };
  }
  m = input.match(/^(?:new|write|make)\s+note\s*[:\-]?\s*([\s\S]+)$/i);
  if (m && typeof ctx.writeFile === 'function') {
    const text = m[1].trim();
    if (!text) return { reply: 'What should the note say?', receipts };
    const stamp = new Date().toISOString().slice(0, 16).replace('T', '-').replace(/:/g, '');
    const path = `/Notes/note-${stamp}.txt`;
    const r = await run('write_file', { path, text }, () => ctx.writeFile(path, text));
    return { reply: r.ok ? `Note saved to ${path}.` : fail(r), receipts };
  }

  // ---- create file ---------------------------------------------------------------
  m = input.match(/^create\s+(?:a\s+)?file\s+(\S+?)(?:\s+(?:with|containing)\s+|\s*:\s*)([\s\S]+)$/i);
  if (m && typeof ctx.writeFile === 'function') {
    const path = sanitizePath(m[1]);
    const text = m[2].trim();
    if (!path) return { reply: "That path doesn't look right — use something like /Notes/todo.txt, no \"..\" allowed.", receipts };
    if (!text) return { reply: 'What should go in the file?', receipts };
    const r = await run('write_file', { path, text }, () => ctx.writeFile(path, text));
    return { reply: r.ok ? `Wrote ${path}.` : fail(r), receipts };
  }

  // ---- find file ------------------------------------------------------------------
  m = input.match(/^(?:find|search for)\s+(?:the\s+)?file\s+(.+?)\s*[?.!]*$/i);
  if (m) {
    const name = m[1].trim();
    const r = await run('find_file', { name }, () => findFileInVfs(ctx, name));
    if (!r.ok) return { reply: fail(r), receipts };
    const hits = r.result || [];
    if (hits.length === 0) return { reply: `Couldn't find any file matching "${name}".`, receipts };
    const shown = hits.slice(0, 10).map((h) => h.path).join(', ');
    const more = hits.length > 10 ? `, and ${hits.length - 10} more` : '';
    return { reply: `Found: ${shown}${more}.`, receipts };
  }

  // ---- read file ---------------------------------------------------------------
  m = input.match(/^read\s+(?:the\s+)?(?:file\s+)?(.+?)\s*[?.!]*$/i);
  if (m) {
    const path = m[1].trim();
    const r = await run('read_file', { path }, () => ctx.readFile(path));
    if (!r.ok) return { reply: fail(r), receipts };
    const text = String(r.result?.text ?? '');
    const snippet = text.length > 600 ? `${text.slice(0, 600)}…` : text;
    return {
      reply: snippet ? `Contents of ${path}:\n${snippet}` : `${path} is empty.`,
      receipts,
    };
  }

  // ---- list files ---------------------------------------------------------------
  m = input.match(/^(?:list|show)\s+files?(?:\s+in\s+(.+?))?\s*[?.!]*$/i);
  if (m) {
    const path = (m[1] || '/').trim();
    const r = await run('list_files', { path }, () => ctx.listFiles(path));
    if (!r.ok) return { reply: fail(r), receipts };
    const entries = r.result || [];
    if (entries.length === 0) return { reply: `${path} is empty.`, receipts };
    const names = entries.map((e) => `${e.name}${e.type === 'folder' ? '/' : ''}`).join(', ');
    return { reply: `In ${path}: ${names}`, receipts };
  }

  // ---- greetings ------------------------------------------------------------
  if (GREETINGS.test(input)) {
    return { reply: pick(GREETING_REPLIES, input.length), receipts };
  }
  if (THANKS.test(input)) {
    return { reply: pick(THANKS_REPLIES, input.length), receipts };
  }

  // ---- arithmetic ----------------------------------------------------------
  m = input.match(/^(?:what is|what's|calculate|compute|solve)\s+(.+?)\s*[?.!]*$/i);
  if (m) {
    const value = calcExpr(m[1]);
    if (value !== null) {
      const pretty = Number.isInteger(value) ? String(value) : String(Math.round(value * 1e10) / 1e10);
      return { reply: `${m[1].trim()} = ${pretty}`, receipts };
    }
    return {
      reply: 'I couldn\'t parse that calculation — try something like "what is (12 + 8) * 3".',
      receipts,
    };
  }

  // ---- memory: remember ------------------------------------------------------
  m = input.match(/^(?:remember|note down|don't forget|dont forget)(?:\s+that)?\s*[:\-]?\s*([\s\S]+)$/i);
  if (m && typeof ctx.memoryRemember === 'function') {
    const fact = m[1].trim().replace(/[?.!]+$/, '');
    if (!fact) return { reply: 'What should I remember? Tell me the fact after "remember that".', receipts };
    const title = fact.length > 48 ? `${fact.slice(0, 45).trimEnd()}…` : fact;
    const r = await run('remember', { fact }, () => ctx.memoryRemember({ title, body: fact }));
    return {
      reply: r.ok
        ? `Got it — I'll remember that. It's on your Pinboard (tagged ${MEMORY_TAG}) if you ever want to see or delete it.`
        : fail(r),
      receipts,
    };
  }
  if (/^remember\s*[?.!]*$/i.test(input)) {
    return { reply: 'What should I remember? Tell me the fact after "remember that".', receipts };
  }

  // ---- memory: recall ----------------------------------------------------------
  m = input.match(/^(?:what do you remember|what have i told you|list (?:your )?memories|do you remember)([\s\S]*)$/i);
  if (m && typeof ctx.memoryRecall === 'function') {
    const query = m[1].trim().replace(/^[?.!\s]+|[?.!\s]+$/g, '');
    const r = await run('recall_memory', { query }, () => ctx.memoryRecall(query));
    if (!r.ok) return { reply: fail(r), receipts };
    const mems = r.result || [];
    if (mems.length === 0) {
      return {
        reply: query
          ? `I don't remember anything about "${query}". Tell me with "remember that …".`
          : 'Nothing in my memory yet. Tell me something with "remember that …".',
        receipts,
      };
    }
    const list = mems.slice(0, 8).map((p) => `• ${p.body || p.title}`).join('\n');
    const more = mems.length > 8 ? `\n…and ${mems.length - 8} more.` : '';
    return { reply: `Here's what I've got:\n${list}${more}`, receipts };
  }

  // ---- memory: forget ------------------------------------------------------------
  if (/^forget\s*[?.!]*$/i.test(input)) {
    return { reply: 'What should I forget? Name a memory, or say "forget everything".', receipts };
  }
  m = input.match(/^forget\s+(everything|all|it all|all memories)$/i);
  if (m && typeof ctx.memoryForget === 'function') {
    const r = await run('forget_memory', { query: '' }, () => ctx.memoryForget(''));
    return { reply: r.ok ? 'Done — wiped everything I was remembering.' : fail(r), receipts };
  }
  m = input.match(/^forget\s+(?:that\s+)?([\s\S]+?)\s*[?.!]*$/i);
  if (m && typeof ctx.memoryForget === 'function') {
    const query = m[1].trim();
    const r = await run('forget_memory', { query }, () => ctx.memoryForget(query));
    if (!r.ok) return { reply: fail(r), receipts };
    const n = r.result?.forgotten ?? 0;
    return {
      reply: n > 0 ? `Forgot ${n} thing${n === 1 ? '' : 's'} about "${query}".` : `I wasn't remembering anything about "${query}".`,
      receipts,
    };
  }

  // ---- explicit web search ----------------------------------------------------------
  if (/^(?:search(?: the)? web|web search|look up|google)\s*(?:for\s*)?[?.!]*$/i.test(input)) {
    return { reply: 'What do you want me to look up? Give me a topic.', receipts };
  }
  m = input.match(/^(?:search(?: the)? web|web search|look up|google)\s+(?:for\s+)?([\s\S]+?)\s*[?.!]*$/i);
  if (m) {
    const query = m[1].trim();
    if (!query) return { reply: 'What do you want me to look up? Give me a topic.', receipts };
    const r = await run('web_search', { query }, () => webLookup(query));
    if (!r.ok) {
      return { reply: r.error?.message === 'EMPTY_QUERY' ? 'What do you want me to look up? Give me a topic.' : fail(r), receipts };
    }
    const { answer, sources } = r.result;
    const src = sources.map((s) => s.title).join(', ');
    return { reply: `${answer}\n\n— Source: ${src} (live web lookup)`, receipts };
  }

  // ---- troubleshooting ----------------------------------------------------------
  const trouble = findTroubleshooting(low);
  if (trouble) {
    await run('troubleshoot', { topic: trouble.title }, async () => trouble);
    return {
      reply:
        `Here's what usually fixes ${trouble.title}:\n${trouble.answer}\n\n` +
        "If that doesn't sort it, tell me exactly what you're seeing and we'll dig deeper.",
      receipts,
    };
  }

  // ---- open questions: cloud smart mode, else live web lookup -----------------------
  const looksLikeQuestion =
    /^(who|what|when|where|why|how|which|whom|whose)\b/i.test(low) ||
    (/\?\s*$/.test(input) && /^(is|are|was|were|do|does|did|can|could|will|would|has|have|should)\b/i.test(low));
  if (looksLikeQuestion) {
    const question = input.trim();
    const cloudMode = ctx.engineMode === 'cloud';
    if (cloudMode) {
      const opts = {
        history: typeof ctx.recentHistory === 'function' ? ctx.recentHistory() : [],
        osContext: typeof ctx.osContext === 'function' ? ctx.osContext() : '',
      };
      const r = await run('cloud_answer', { question }, () => cloudAnswer(question, opts));
      if (r.ok) return { reply: r.result, receipts };
      // Cloud failed — fall back to a sourced web lookup rather than nothing.
      const w = await run('web_search', { query: question }, () => webLookup(question));
      if (w.ok) {
        const { answer, sources } = w.result;
        const src = sources.map((s) => s.title).join(', ');
        return {
          reply: `Cloud mode's unreachable right now, so here's a web lookup instead:\n\n${answer}\n\n— Source: ${src}`,
          receipts,
        };
      }
      return { reply: `${fail(r)} (And the web lookup failed too — check your connection.)`, receipts };
    }
    const r = await run('web_search', { query: question }, () => webLookup(question));
    if (!r.ok) return { reply: fail(r), receipts };
    const { answer, sources } = r.result;
    const src = sources.map((s) => s.title).join(', ');
    const hint =
      "\n\n(Tip: turn on Cloud smart mode in Settings → Helm and I'll answer open questions conversationally.)";
    return { reply: `${answer}\n\n— Source: ${src} (live web lookup)${hint}`, receipts };
  }

  return { reply: UNKNOWN_REPLY, receipts };
}
