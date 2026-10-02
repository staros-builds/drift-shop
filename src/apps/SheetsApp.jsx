import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FilePlus2, FolderOpen, Save, Bold } from 'lucide-react';
import { backend } from '../lib/backend/current.js';
import { useNotifications } from '../os/NotificationsContext.jsx';
import { OFFICE_EXT, readDoc, saveDoc, baseName, stripExt } from './office/util.js';
import { OpenDocModal, NameModal } from './office/DocDialogs.jsx';
import { ConfirmDialog, SaveStatePill } from '../components/os/dialogs.jsx';
import { localeTag, useLang } from '../lib/i18n.jsx';

const EXT = OFFICE_EXT.sheets;
const DEFAULT_ROWS = 60;
const DEFAULT_COLS = 26;

// ---------------------------------------------------------------------------
// Formula engine: =1+2, =A1*2, =SUM(A1:A10), =IF(B2>5,"big","small") …
// ---------------------------------------------------------------------------
class FormulaError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}
const ferr = (code) => new FormulaError(code);

function tokenize(expr) {
  const tokens = [];
  let i = 0;
  while (i < expr.length) {
    const ch = expr[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (/[0-9.]/.test(ch)) {
      const m = /^[0-9]*\.?[0-9]+/.exec(expr.slice(i));
      if (!m) throw ferr('#NAME?');
      tokens.push({ t: 'num', v: parseFloat(m[0]) });
      i += m[0].length;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let s = '';
      while (j < expr.length && expr[j] !== '"') { s += expr[j]; j++; }
      if (expr[j] !== '"') throw ferr('#VALUE!');
      tokens.push({ t: 'str', v: s });
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(expr.slice(i));
      tokens.push({ t: 'id', v: m[0].toUpperCase() });
      i += m[0].length;
      continue;
    }
    const two = expr.slice(i, i + 2);
    if (two === '<=' || two === '>=' || two === '<>') {
      tokens.push({ t: 'op', v: two });
      i += 2;
      continue;
    }
    if ('+-*/%^(),:&<>='.includes(ch)) {
      tokens.push({
        t: ch === ',' ? 'comma' : ch === '(' || ch === ')' ? 'paren' : ch === ':' ? 'colon' : 'op',
        v: ch,
      });
      i++;
      continue;
    }
    throw ferr('#NAME?');
  }
  return tokens;
}

function colLettersToIndex(letters) {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}
function isCellId(id) {
  return /^\$?[A-Z]{1,3}\$?[0-9]{1,7}$/.test(id);
}
function idToRC(id) {
  const m = /^\$?([A-Z]{1,3})\$?([0-9]{1,7})$/.exec(id);
  return { r: parseInt(m[2], 10) - 1, c: colLettersToIndex(m[1]) };
}
export function rcToRef(r, c) {
  let n = c + 1;
  let s = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return `${s}${r + 1}`;
}

const toNum = (v) => {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v == null || v === '') return 0;
  const n = parseFloat(v);
  if (Number.isNaN(n)) throw ferr('#VALUE!');
  return n;
};
const toStr = (v) => {
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (v == null) return '';
  return String(v);
};
const toBool = (v) => {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') {
    const u = v.toUpperCase();
    if (u === 'TRUE') return true;
    if (u === 'FALSE' || u === '') return false;
    throw ferr('#VALUE!');
  }
  return !!v;
};
const flat = (args) => {
  const out = [];
  for (const a of args) {
    if (Array.isArray(a)) out.push(...a.flat());
    else out.push(a);
  }
  return out;
};

const FUNCS = {
  SUM: (...a) => flat(a).reduce((s, v) => s + toNum(v), 0),
  AVERAGE: (...a) => {
    const vs = flat(a).filter((v) => v !== '' && v != null);
    if (!vs.length) throw ferr('#DIV/0!');
    return vs.reduce((s, v) => s + toNum(v), 0) / vs.length;
  },
  MIN: (...a) => {
    const vs = flat(a).filter((v) => v !== '' && v != null);
    if (!vs.length) throw ferr('#VALUE!');
    return Math.min(...vs.map(toNum));
  },
  MAX: (...a) => {
    const vs = flat(a).filter((v) => v !== '' && v != null);
    if (!vs.length) throw ferr('#VALUE!');
    return Math.max(...vs.map(toNum));
  },
  COUNT: (...a) => flat(a).filter((v) => typeof v === 'number' || (typeof v === 'string' && v !== '' && !Number.isNaN(parseFloat(v)))).length,
  COUNTA: (...a) => flat(a).filter((v) => v !== '' && v != null).length,
  ABS: (x) => Math.abs(toNum(x)),
  INT: (x) => Math.trunc(toNum(x)),
  ROUND: (x, n = 0) => {
    const p = Math.pow(10, toNum(n));
    return Math.round(toNum(x) * p) / p;
  },
  SQRT: (x) => {
    const n = toNum(x);
    if (n < 0) throw ferr('#VALUE!');
    return Math.sqrt(n);
  },
  IF: (c, t, f) => (toBool(c) ? t : f),
  AND: (...a) => flat(a).every(toBool),
  OR: (...a) => flat(a).some(toBool),
  NOT: (x) => !toBool(x),
  LEN: (x) => toStr(x).length,
  UPPER: (x) => toStr(x).toUpperCase(),
  LOWER: (x) => toStr(x).toLowerCase(),
  TRIM: (x) => toStr(x).trim(),
  CONCAT: (...a) => flat(a).map(toStr).join(''),
};
FUNCS.AVG = FUNCS.AVERAGE;

function parseAndEval(expr, ctx) {
  const tokens = tokenize(expr);
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];

  function parseExpr() {
    return parseCompare();
  }
  function parseCompare() {
    let left = parseConcat();
    const t = peek();
    if (t && t.t === 'op' && ['=', '<>', '<', '>', '<=', '>='].includes(t.v)) {
      next();
      const right = parseConcat();
      const a = left;
      const b = right;
      const bothNum =
        (typeof a === 'number' || typeof a === 'boolean') &&
        (typeof b === 'number' || typeof b === 'boolean');
      const cmp = bothNum ? toNum(a) - toNum(b) : toStr(a).localeCompare(toStr(b));
      switch (t.v) {
        case '=': return cmp === 0;
        case '<>': return cmp !== 0;
        case '<': return cmp < 0;
        case '>': return cmp > 0;
        case '<=': return cmp <= 0;
        case '>=': return cmp >= 0;
        default: throw ferr('#VALUE!');
      }
    }
    return left;
  }
  function parseConcat() {
    let left = parseAddSub();
    while (peek() && peek().t === 'op' && peek().v === '&') {
      next();
      left = toStr(left) + toStr(parseAddSub());
    }
    return left;
  }
  function parseAddSub() {
    let left = parseMulDiv();
    for (;;) {
      const t = peek();
      if (!t || t.t !== 'op' || (t.v !== '+' && t.v !== '-')) return left;
      next();
      const right = parseMulDiv();
      left = t.v === '+' ? toNum(left) + toNum(right) : toNum(left) - toNum(right);
    }
  }
  function parseMulDiv() {
    let left = parsePower();
    for (;;) {
      const t = peek();
      if (!t || t.t !== 'op' || (t.v !== '*' && t.v !== '/')) return left;
      next();
      const right = parsePower();
      if (t.v === '*') left = toNum(left) * toNum(right);
      else {
        if (toNum(right) === 0) throw ferr('#DIV/0!');
        left = toNum(left) / toNum(right);
      }
    }
  }
  function parsePower() {
    const base = parsePostfix();
    const t = peek();
    if (t && t.t === 'op' && t.v === '^') {
      next();
      return Math.pow(toNum(base), toNum(parsePower()));
    }
    return base;
  }
  function parsePostfix() {
    let left = parseUnary();
    // Trailing % is postfix percent (spreadsheet convention), not modulo:
    // =50% → 0.5, =A1% → A1/100
    while (peek() && peek().t === 'op' && peek().v === '%') {
      next();
      left = toNum(left) / 100;
    }
    return left;
  }
  function parseUnary() {
    const t = peek();
    if (t && t.t === 'op' && (t.v === '-' || t.v === '+')) {
      next();
      const v = parseUnary();
      return t.v === '-' ? -toNum(v) : toNum(v);
    }
    return parsePrimary();
  }
  function parsePrimary() {
    const t = next();
    if (!t) throw ferr('#VALUE!');
    if (t.t === 'num' || t.t === 'str') return t.v;
    if (t.t === 'paren' && t.v === '(') {
      const v = parseExpr();
      const c = next();
      if (!c || c.t !== 'paren' || c.v !== ')') throw ferr('#VALUE!');
      return v;
    }
    if (t.t === 'id') {
      if (t.v === 'TRUE') return true;
      if (t.v === 'FALSE') return false;
      // Function call
      if (peek() && peek().t === 'paren' && peek().v === '(') {
        next();
        const args = [];
        if (!(peek() && peek().t === 'paren' && peek().v === ')')) {
          for (;;) {
            args.push(parseExpr());
            const s = peek();
            if (s && s.t === 'comma') { next(); continue; }
            break;
          }
        }
        const c = next();
        if (!c || c.t !== 'paren' || c.v !== ')') throw ferr('#VALUE!');
        const fn = FUNCS[t.v];
        if (!fn) throw ferr('#NAME?');
        return fn(...args);
      }
      // Range A1:B3
      if (peek() && peek().t === 'colon') {
        next();
        const end = next();
        if (!end || end.t !== 'id' || !isCellId(t.v) || !isCellId(end.v)) throw ferr('#REF!');
        return ctx.range(t.v, end.v);
      }
      if (isCellId(t.v)) return ctx.cell(t.v);
      throw ferr('#NAME?');
    }
    throw ferr('#VALUE!');
  }

  const result = parseExpr();
  if (pos < tokens.length) throw ferr('#VALUE!');
  return result;
}

function displayValue(v) {
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return '#NUM!';
    const r = Math.round(v * 1e10) / 1e10;
    return String(r);
  }
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (v == null) return '';
  return String(v);
}

// ---------------------------------------------------------------------------
// Sheets app
// ---------------------------------------------------------------------------
export default function SheetsApp({ windowApi, path }) {
  const { t } = useLang();
  const { push } = useNotifications();
  const [cells, setCells] = useState({});
  // Per-cell formatting: { [ref]: { bold?: true, numFmt?: 'general'|'currency'|'percent' } }
  const [formats, setFormats] = useState({});
  const [rows] = useState(DEFAULT_ROWS);
  const [cols] = useState(DEFAULT_COLS);
  const [sel, setSel] = useState({ r: 0, c: 0 });
  const [editing, setEditing] = useState(false);
  const [editVal, setEditVal] = useState('');
  const [sheetPath, setSheetPath] = useState(path || null);
  const [title, setTitle] = useState(() => t('sheets.untitled'));
  const [dirty, setDirty] = useState(false);
  const [saveState, setSaveState] = useState('saved'); // 'saved' | 'saving' | 'dirty'
  const [confirmDiscard, setConfirmDiscard] = useState(null); // 'new' | 'open' | null
  const [showOpen, setShowOpen] = useState(false);
  const [showName, setShowName] = useState(false);
  const gridRef = useRef(null);
  const cellInputRef = useRef(null);
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;

  const fail = useCallback((key, err) => push(t('sheets.notifError'), `${t(key)}: ${err?.message || err}`), [push, t]);

  const markDirty = useCallback(() => {
    setDirty(true);
    setSaveState('dirty');
  }, []);

  // Computed values with memoization + cycle detection.
  const getComputed = useMemo(() => {
    const cache = {};
    const visiting = new Set();
    const evalRaw = (raw) => {
      if (raw == null || raw === '') return '';
      if (raw[0] === '=') return parseAndEval(raw.slice(1), ctx);
      if (raw.trim() !== '' && !Number.isNaN(Number(raw))) return Number(raw);
      return raw;
    };
    const ctx = {
      cell: (ref) => {
        const { r, c } = idToRC(ref);
        const key = rcToRef(r, c);
        if (cache[key] !== undefined) return cache[key];
        if (visiting.has(key)) throw ferr('#CIRC!');
        visiting.add(key);
        let v;
        try {
          v = evalRaw(cells[key]);
        } finally {
          visiting.delete(key);
        }
        cache[key] = v;
        return v;
      },
      range: (a, b) => {
        const s = idToRC(a);
        const e = idToRC(b);
        const out = [];
        for (let r = Math.min(s.r, e.r); r <= Math.max(s.r, e.r); r++) {
          for (let c = Math.min(s.c, e.c); c <= Math.max(s.c, e.c); c++) {
            out.push(ctx.cell(rcToRef(r, c)));
          }
        }
        return out;
      },
    };
    return (ref) => {
      try {
        return { value: ctx.cell(ref), error: null };
      } catch (err) {
        return { value: null, error: err instanceof FormulaError ? err.code : '#ERR' };
      }
    };
  }, [cells]);

  const loadPath = useCallback(
    async (p) => {
      try {
        const text = await readDoc(p);
        const data = JSON.parse(text || '{}');
        setCells(data.cells || {});
        setFormats(data.formats || {});
        setSheetPath(p);
        setTitle(data.title || stripExt(baseName(p), EXT));
        setDirty(false);
        setSaveState('saved');
        setSel({ r: 0, c: 0 });
        setShowOpen(false);
      } catch (err) {
        fail('sheets.errOpen', err);
      }
    },
    [fail]
  );

  useEffect(() => {
    if (path) loadPath(path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    windowApi.setTitle(dirty ? `${title} • — ${t('apps.sheets')}` : `${title} — ${t('apps.sheets')}`);
  }, [title, dirty, windowApi, t]);

  const commitEdit = useCallback(
    (value) => {
      const ref = rcToRef(sel.r, sel.c);
      const v = value ?? editVal;
      setCells((prev) => {
        const next = { ...prev };
        if (v === '') delete next[ref];
        else next[ref] = v;
        return next;
      });
      if (v === '') {
        // Clearing a cell also clears its formatting.
        setFormats((prev) => {
          if (!prev[ref]) return prev;
          const next = { ...prev };
          delete next[ref];
          return next;
        });
      }
      setEditing(false);
      setDirty(true);
      setSaveState('dirty');
    },
    [editVal, sel]
  );

  const startEdit = useCallback(
    (initial) => {
      const ref = rcToRef(sel.r, sel.c);
      setEditVal(initial !== undefined ? initial : cells[ref] ?? '');
      setEditing(true);
    },
    [cells, sel]
  );

  const moveSel = useCallback(
    (dr, dc) => {
      setSel((s) => ({
        r: Math.min(rows - 1, Math.max(0, s.r + dr)),
        c: Math.min(cols - 1, Math.max(0, s.c + dc)),
      }));
      setEditing(false);
    },
    [rows, cols]
  );

  const doSave = useCallback(
    async (targetPath) => {
      setSaveState('saving');
      try {
        await saveDoc(
          targetPath,
          JSON.stringify({ version: 1, title, rows, cols, cells, formats }, null, 1)
        );
        setSheetPath(targetPath);
        setTitle(stripExt(baseName(targetPath), EXT));
        setDirty(false);
        setSaveState('saved');
        setShowName(false);
        push(t('sheets.notifSaved'), t('sheets.savedMsg', { name: stripExt(baseName(targetPath), EXT) }));
      } catch (err) {
        setSaveState('dirty');
        fail('sheets.errSave', err);
      }
    },
    [cells, cols, fail, formats, push, rows, title, t]
  );

  const handleSave = useCallback(() => {
    if (sheetPath) doSave(sheetPath);
    else setShowName(true);
  }, [sheetPath, doSave]);

  // "Discard unsaved changes?" is an in-app dialog now (never
  // window.confirm()) so it works in every browser and under automation.
  const doNew = useCallback(() => {
    setCells({});
    setFormats({});
    setSheetPath(null);
    setTitle(t('sheets.untitled'));
    setDirty(false);
    setSaveState('saved');
    setSel({ r: 0, c: 0 });
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

  const toggleBold = useCallback(() => {
    const ref = rcToRef(sel.r, sel.c);
    setFormats((prev) => {
      const cur = { ...(prev[ref] || {}) };
      const next = { ...prev };
      if (cur.bold) delete cur.bold;
      else cur.bold = true;
      if (Object.keys(cur).length) next[ref] = cur;
      else delete next[ref];
      return next;
    });
    markDirty();
  }, [sel.r, sel.c, markDirty]);

  const setNumFmt = useCallback((fmt) => {
    const ref = rcToRef(sel.r, sel.c);
    setFormats((prev) => {
      const cur = { ...(prev[ref] || {}) };
      const next = { ...prev };
      if (fmt === 'general') delete cur.numFmt;
      else cur.numFmt = fmt;
      if (Object.keys(cur).length) next[ref] = cur;
      else delete next[ref];
      return next;
    });
    markDirty();
  }, [sel.r, sel.c, markDirty]);

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

  useEffect(() => {
    if (editing && cellInputRef.current) {
      cellInputRef.current.focus();
      cellInputRef.current.select();
    }
  }, [editing, sel]);

  const onGridKeyDown = (e) => {
    if (editing) return; // the cell input handles its own keys
    const k = e.key;
    if (k === 'ArrowUp') { e.preventDefault(); moveSel(-1, 0); }
    else if (k === 'ArrowDown' || k === 'Enter') { e.preventDefault(); moveSel(1, 0); }
    else if (k === 'ArrowLeft') { e.preventDefault(); moveSel(0, -1); }
    else if (k === 'ArrowRight' || k === 'Tab') { e.preventDefault(); moveSel(0, 1); }
    else if (k === 'Delete' || k === 'Backspace') {
      e.preventDefault();
      const ref = rcToRef(sel.r, sel.c);
      setCells((prev) => {
        const next = { ...prev };
        delete next[ref];
        return next;
      });
      setFormats((prev) => {
        if (!prev[ref]) return prev;
        const next = { ...prev };
        delete next[ref];
        return next;
      });
      markDirty();
    } else if (k === 'F2') { e.preventDefault(); startEdit(); }
    else if (k.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      startEdit(k);
    }
  };

  const selRef = rcToRef(sel.r, sel.c);
  const selRaw = cells[selRef] ?? '';

  const colHeaders = [];
  for (let c = 0; c < cols; c++) colHeaders.push(rcToRef(0, c).replace(/[0-9]/g, ''));

  return (
    <div className="flex h-full flex-col bg-paper text-ink">
      <div className="flex flex-wrap items-center gap-1 border-b border-osborder bg-surface px-3 py-2">
        <button type="button" onClick={handleNew} title={t('sheets.newTitle')}
          className="flex items-center gap-1.5 rounded-os px-2 py-1.5 text-sm hover:bg-paper">
          <FilePlus2 size={15} /> {t('sheets.new')}
        </button>
        <button type="button" onClick={handleOpenRequest} title={t('sheets.openTitle')}
          className="flex items-center gap-1.5 rounded-os px-2 py-1.5 text-sm hover:bg-paper">
          <FolderOpen size={15} /> {t('sheets.open')}
        </button>
        <button type="button" onClick={handleSave} title={t('sheets.saveTitle')}
          className="flex items-center gap-1.5 rounded-os bg-accent px-3 py-1.5 text-sm font-medium text-white">
          <Save size={15} /> {t('sheets.save')}
        </button>
        <button
          type="button"
          onClick={() => setShowName(true)}
          title={t('sheets.saveAsTitle')}
          className="flex items-center gap-1.5 rounded-os px-2 py-1.5 text-sm hover:bg-paper"
        >
          <Save size={15} /> {t('sheets.saveAs')}
        </button>
        <span className="mx-1 h-5 w-px shrink-0 bg-osborder" aria-hidden="true" />
        <button type="button" onClick={toggleBold} title={t('sheets.bold')} aria-label={t('sheets.bold')}
          className={`flex items-center rounded-os px-2 py-1.5 text-sm ${formats[selRef]?.bold ? 'bg-accent text-white' : 'hover:bg-paper'}`}>
          <Bold size={15} />
        </button>
        <select value={formats[selRef]?.numFmt || 'general'} onChange={(e) => setNumFmt(e.target.value)}
          title={t('sheets.numFmt')} aria-label={t('sheets.numFmt')}
          className="rounded-os border border-osborder bg-paper px-1.5 py-1 text-sm">
          <option value="general">{t('sheets.fmtGeneral')}</option>
          <option value="currency">{t('sheets.fmtCurrency')}</option>
          <option value="percent">{t('sheets.fmtPercent')}</option>
        </select>
        <span className="mx-2 hidden min-w-0 flex-1 truncate text-center text-sm font-medium sm:block">
          {title}
          {dirty && <span className="text-accent"> •</span>}
        </span>
        <SaveStatePill state={saveState} />
      </div>

      {/* Formula bar */}
      <div className="flex items-center gap-2 border-b border-osborder bg-surface px-3 py-1.5">
        <span className="w-14 shrink-0 rounded-os border border-osborder bg-paper px-2 py-1 text-center text-xs font-semibold">
          {selRef}
        </span>
        <span className="shrink-0 text-sm italic text-muted">fx</span>
        <input
          value={editing ? editVal : selRaw}
          onChange={(e) => {
            if (!editing) startEdit();
            setEditVal(e.target.value);
          }}
          onFocus={() => { if (!editing) startEdit(); }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { commitEdit(); moveSel(1, 0); gridRef.current?.focus(); }
            if (e.key === 'Escape') { setEditing(false); }
          }}
          onBlur={() => { if (editing) commitEdit(); }}
          className="min-w-0 flex-1 rounded-os border border-osborder bg-paper px-2 py-1 font-mono text-sm outline-none focus:border-accent"
          placeholder={t('sheets.fxPh')}
        />
      </div>

      {/* Grid */}
      <div ref={gridRef} tabIndex={0} onKeyDown={onGridKeyDown}
        className="min-h-0 flex-1 overflow-auto outline-none">
        <table className="border-collapse">
          <thead className="sticky top-0 z-10">
            <tr>
              <th className="sticky left-0 z-20 w-10 border border-osborder bg-surface px-1 py-1 text-xs text-muted" />
              {colHeaders.map((h, c) => (
                <th key={c}
                  className={`w-24 border border-osborder px-1 py-1 text-xs font-medium ${sel.c === c ? 'bg-accent/15 text-accent' : 'bg-surface text-muted'}`}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: rows }, (_, r) => (
              <tr key={r}>
                <td className={`sticky left-0 z-10 border border-osborder px-1 py-0.5 text-center text-xs ${sel.r === r ? 'bg-accent/15 font-semibold text-accent' : 'bg-surface text-muted'}`}>
                  {r + 1}
                </td>
                {Array.from({ length: cols }, (_, c) => {
                  const ref = rcToRef(r, c);
                  const isSel = sel.r === r && sel.c === c;
                  const raw = cells[ref];
                  const fmt = formats[ref] || {};
                  let shown = '';
                  let isErr = false;
                  let numVal = null;
                  if (raw != null && raw !== '') {
                    if (raw[0] === '=') {
                      const { value, error } = getComputed(ref);
                      if (error) { shown = error; isErr = true; }
                      else {
                        if (typeof value === 'number') numVal = value;
                        shown = displayValue(value);
                      }
                    } else {
                      shown = raw;
                      if (raw.trim() !== '' && !Number.isNaN(Number(raw))) numVal = Number(raw);
                    }
                    if (!isErr && numVal != null) {
                      if (fmt.numFmt === 'currency') {
                        shown = '$' + numVal.toLocaleString(localeTag(), { minimumFractionDigits: 2, maximumFractionDigits: 2 });
                      } else if (fmt.numFmt === 'percent') {
                        shown = `${Math.round(numVal * 100 * 1e10) / 1e10}%`;
                      }
                    }
                  }
                  return (
                    <td key={c}
                      onClick={() => { setSel({ r, c }); setEditing(false); gridRef.current?.focus(); }}
                      onDoubleClick={() => startEdit()}
                      className={`h-7 w-24 cursor-cell truncate border border-osborder px-1.5 text-sm ${
                        isSel ? 'bg-accent/15 outline outline-2 outline-accent' : 'bg-paper'
                      } ${isErr ? 'text-red-700' : 'text-ink'}${fmt.bold ? ' font-bold' : ''}`}
                      title={raw ?? ''}>
                      {isSel && editing ? (
                        <input
                          ref={cellInputRef}
                          value={editVal}
                          onChange={(e) => setEditVal(e.target.value)}
                          onKeyDown={(e) => {
                            e.stopPropagation();
                            if (e.key === 'Enter') { commitEdit(); moveSel(1, 0); }
                            else if (e.key === 'Tab') { e.preventDefault(); commitEdit(); moveSel(0, 1); }
                            else if (e.key === 'Escape') setEditing(false);
                          }}
                          onBlur={() => commitEdit()}
                          className="w-full bg-transparent font-mono text-sm outline-none"
                        />
                      ) : (
                        <span className="font-mono">{shown}</span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between border-t border-osborder bg-surface px-3 py-1.5 text-xs text-muted">
        <span>{t('sheets.cell', { ref: selRef })}</span>
        <span>=SUM(A1:A10), =AVERAGE(B1:B10), =IF(A1&gt;5,&quot;yes&quot;,&quot;no&quot;)</span>
        <span>{dirty ? t('sheets.unsaved') : t('dialogs.saved')}</span>
      </div>

      {showOpen && (
        <OpenDocModal ext={EXT} app="sheets" onPick={loadPath} onClose={() => setShowOpen(false)} />
      )}
      {showName && (
        <NameModal
          initial={title === t('sheets.untitled') ? '' : title}
          title={t('sheets.saveAsDialog')}
          ext={EXT}
          onSave={(name) => doSave(`/Documents/${name}${EXT}`)}
          onClose={() => setShowName(false)}
        />
      )}
      {confirmDiscard && (
        <ConfirmDialog
          title={t('sheets.discardTitle')}
          message={confirmDiscard === 'open' ? t('sheets.discardOpen') : t('sheets.discardNew')}
          confirmLabel={t('sheets.discardConfirm')}
          cancelLabel={t('sheets.keepEditing')}
          danger
          onConfirm={confirmDiscardAction}
          onCancel={() => setConfirmDiscard(null)}
        />
      )}
    </div>
  );
}
