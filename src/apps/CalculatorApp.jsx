import { useEffect, useState } from 'react';
import {
  Delete, Copy, Check, History, X, Trash2, Divide,
} from 'lucide-react';
import { useLang } from '../lib/i18n.jsx';

// Safe number formatting: strips float artifacts (0.1 + 0.2 → "0.3") and
// keeps very large/small results readable without scientific noise.
function fmt(n, errLabel = 'Error') {
  if (typeof n !== 'number' || Number.isNaN(n) || !Number.isFinite(n)) return errLabel;
  if (n === 0) return '0';
  const r = Number(n.toPrecision(12));
  let s = String(r);
  if (s.replace(/[^0-9]/g, '').length > 15) s = r.toExponential(5);
  return s;
}

// Two-pass evaluator over [{t:'n',v:'12.5'},{t:'o',v:'+'},…].
// × ÷ bind tighter than + −; left-associative. Throws on ÷ 0.
function evaluate(tokens) {
  const nums = [];
  const ops = [];
  let cur = parseFloat(tokens[0].v);
  for (let i = 1; i < tokens.length; i += 2) {
    const op = tokens[i].v;
    const next = parseFloat(tokens[i + 1].v);
    if (op === '×' || op === '÷') {
      if (op === '÷' && next === 0) throw new Error('zero');
      cur = op === '×' ? cur * next : cur / next;
    } else {
      nums.push(cur);
      ops.push(op);
      cur = next;
    }
  }
  nums.push(cur);
  let total = nums[0];
  for (let i = 0; i < ops.length; i++) {
    total = ops[i] === '+' ? total + nums[i + 1] : total - nums[i + 1];
  }
  return total;
}

function exprString(tokens, errLabel) {
  return tokens.map((t) => (t.t === 'n' ? fmt(parseFloat(t.v), errLabel) : ` ${t.v} `)).join('');
}

const HIST_KEY = 'lfdd:calculator:history:v1';
const HIST_KEY_LEGACY = 'drift:calculator:history:v1';
function readHist() {
  try {
    // Migrate legacy drift: key once, then use lfdd: going forward.
    let raw = localStorage.getItem(HIST_KEY);
    if (raw == null) {
      raw = localStorage.getItem(HIST_KEY_LEGACY);
      if (raw != null) {
        try { localStorage.setItem(HIST_KEY, raw); } catch {}
        try { localStorage.removeItem(HIST_KEY_LEGACY); } catch {}
      }
    }
    const v = JSON.parse(raw || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

const ZERO = '0';
const MAX_DIGITS = 14;

export default function CalculatorApp({ windowApi }) {
  const { t } = useLang();
  const [tokens, setTokens] = useState([]); // committed number/op pairs
  const [entry, setEntry] = useState(ZERO); // current input, shown verbatim
  const [fresh, setFresh] = useState(false); // last action was =
  const [error, setError] = useState(null);
  const [showHist, setShowHist] = useState(false);
  const [hist, setHist] = useState(readHist);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    windowApi?.setTitle?.(t('apps.calculator'));
  }, [windowApi, t]);

  const pushHist = (expr, result) => {
    setHist((h) => {
      const next = [{ expr, result, at: Date.now() }, ...h].slice(0, 30);
      try {
        localStorage.setItem(HIST_KEY, JSON.stringify(next));
      } catch {
        /* storage unavailable — history is best-effort */
      }
      return next;
    });
  };

  const clearAll = () => {
    setTokens([]);
    setEntry(ZERO);
    setFresh(false);
    setError(null);
  };

  const clearHist = () => {
    setHist([]);
    try {
      localStorage.removeItem(HIST_KEY);
    } catch {
      /* ignore */
    }
  };

  const resetIfNeeded = () => {
    if (error) clearAll();
    else if (fresh) {
      setTokens([]);
      setFresh(false);
    }
  };

  const inputDigit = (d) => {
    resetIfNeeded();
    setEntry((e) => {
      const digits = e.replace(/[^0-9]/g, '');
      if (digits.length >= MAX_DIGITS) return e;
      if (e === ZERO) return d;
      if (e === '-0') return `-${d}`;
      return e + d;
    });
  };

  const inputDot = () => {
    resetIfNeeded();
    setEntry((e) => (e.includes('.') ? e : `${e}.`));
  };

  const inputOp = (op) => {
    if (error) return;
    if (fresh) {
      setTokens([{ t: 'n', v: entry }, { t: 'o', v: op }]);
      setEntry('');
      setFresh(false);
      return;
    }
    setTokens((ts) => {
      if (entry !== '') return [...ts, { t: 'n', v: entry }, { t: 'o', v: op }];
      if (ts.length > 0 && ts[ts.length - 1].t === 'o') {
        return [...ts.slice(0, -1), { t: 'o', v: op }];
      }
      if (ts.length === 0) return [{ t: 'n', v: ZERO }, { t: 'o', v: op }];
      return ts;
    });
    setEntry('');
  };

  const equals = () => {
    if (error) return;
    const toks = [...tokens];
    if (entry !== '' && entry !== '-') {
      toks.push({ t: 'n', v: entry });
    } else if (toks.length >= 2 && toks[toks.length - 1].t === 'o') {
      // Trailing operator (e.g. "5 + ="): repeat the last operand, like iOS.
      toks.push({ t: 'n', v: toks[toks.length - 2].v });
    }
    while (toks.length > 0 && toks[toks.length - 1].t === 'o') toks.pop();
    if (toks.length < 3) return; // nothing to compute
    try {
      const result = fmt(evaluate(toks), t('calculator.error'));
      pushHist(`${exprString(toks, t('calculator.error'))} =`, result);
      setTokens([]);
      setEntry(result);
      setFresh(true);
    } catch {
      setError(t('calculator.divByZero'));
    }
  };

  const backspace = () => {
    if (error || fresh) {
      clearAll();
      return;
    }
    setEntry((e) => {
      if (e.length <= 1) return ZERO;
      const next = e.slice(0, -1);
      return next === '-' || next === '' ? ZERO : next;
    });
  };

  const negate = () => {
    if (error) return;
    if (fresh) setFresh(false);
    setEntry((e) => {
      if (e === '' || e === ZERO) return e;
      return e.startsWith('-') ? e.slice(1) : `-${e}`;
    });
  };

  const percent = () => {
    if (error) return;
    if (fresh) setFresh(false);
    setEntry((e) => (e === '' ? e : fmt(parseFloat(e) / 100, t('calculator.error'))));
  };

  const copyResult = async () => {
    const text = error || entry;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
      } catch {
        /* clipboard unavailable */
      }
      ta.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  const reuse = (result) => {
    setTokens([]);
    setEntry(result);
    setFresh(true);
    setError(null);
    setShowHist(false);
  };

  // Keyboard: digits, operators, Enter (=), Escape (clear), Backspace.
  useEffect(() => {
    const onKey = (e) => {
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
      const k = e.key;
      if (k >= '0' && k <= '9') inputDigit(k);
      else if (k === '.') inputDot();
      else if (k === '+') inputOp('+');
      else if (k === '-') inputOp('−');
      else if (k === '*' || k === 'x' || k === 'X') inputOp('×');
      else if (k === '/') {
        e.preventDefault();
        inputOp('÷');
      } else if (k === 'Enter' || k === '=') {
        e.preventDefault();
        equals();
      } else if (k === 'Escape') clearAll();
      else if (k === 'Backspace') backspace();
      else if (k === '%') percent();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tokens, entry, fresh, error]);

  const expr = exprString(tokens, t('calculator.error'));
  const btn =
    'flex min-h-[44px] items-center justify-center rounded-os transition-colors duration-160 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1';
  const digitBtn = `${btn} bg-surface text-xl text-ink hover:bg-osborder/40`;
  const utilBtn = `${btn} bg-surface text-base font-semibold text-ink hover:bg-osborder/40`;
  const opBtn = `${btn} bg-accent/10 text-xl font-semibold text-accent hover:bg-accent/20`;
  const eqBtn = `${btn} bg-accent text-xl font-semibold text-white hover:brightness-95`;

  return (
    <div className="relative flex h-full flex-col bg-paper text-ink">
      {/* Toolbar */}
      <div className="flex items-center justify-between border-b border-osborder bg-surface px-2 py-1.5">
        <button
          type="button"
          onClick={() => setShowHist((s) => !s)}
          aria-label={showHist ? t('calculator.histHide') : t('calculator.histShow')}
          aria-expanded={showHist}
          title={t('calculator.histTitle')}
          className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-os px-2 text-sm transition-colors duration-160 hover:bg-paper focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <History size={17} />
        </button>
        <button
          type="button"
          onClick={copyResult}
          aria-label={t('calculator.copyResult')}
          title={t('calculator.copyResult')}
          className="flex min-h-[44px] min-w-[44px] items-center gap-1.5 rounded-os px-3 text-sm transition-colors duration-160 hover:bg-paper focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          {copied ? <Check size={16} className="text-accent" /> : <Copy size={16} />}
          <span className="text-muted">{copied ? t('calculator.copied') : t('calculator.copy')}</span>
        </button>
      </div>

      {/* Display */}
      <div className="px-4 pb-1 pt-3 text-right" aria-live="polite">
        <p className="min-h-[20px] truncate text-sm text-muted" aria-hidden="true">
          {fresh && expr ? `${expr} =` : expr}
        </p>
        <p
          className={`truncate text-5xl font-semibold tracking-tight ${
            error ? 'text-red-700' : 'text-ink'
          }`}
        >
          {error || entry || ZERO}
        </p>
      </div>

      {/* Keypad */}
      <div className="grid flex-1 grid-cols-4 grid-rows-5 gap-1.5 p-3">
        <button type="button" onClick={clearAll} aria-label={t('calculator.clearAll')} className={utilBtn}>AC</button>
        <button type="button" onClick={negate} aria-label={t('calculator.toggleSign')} className={utilBtn}>+/−</button>
        <button type="button" onClick={percent} aria-label={t('calculator.percent')} className={utilBtn}>%</button>
        <button type="button" onClick={() => inputOp('÷')} aria-label={t('calculator.divide')} className={opBtn}><Divide size={20} /></button>

        <button type="button" onClick={() => inputDigit('7')} aria-label="7" className={digitBtn}>7</button>
        <button type="button" onClick={() => inputDigit('8')} aria-label="8" className={digitBtn}>8</button>
        <button type="button" onClick={() => inputDigit('9')} aria-label="9" className={digitBtn}>9</button>
        <button type="button" onClick={() => inputOp('×')} aria-label={t('calculator.multiply')} className={opBtn}><X size={20} /></button>

        <button type="button" onClick={() => inputDigit('4')} aria-label="4" className={digitBtn}>4</button>
        <button type="button" onClick={() => inputDigit('5')} aria-label="5" className={digitBtn}>5</button>
        <button type="button" onClick={() => inputDigit('6')} aria-label="6" className={digitBtn}>6</button>
        <button type="button" onClick={() => inputOp('−')} aria-label={t('calculator.subtract')} className={opBtn}>−</button>

        <button type="button" onClick={() => inputDigit('1')} aria-label="1" className={digitBtn}>1</button>
        <button type="button" onClick={() => inputDigit('2')} aria-label="2" className={digitBtn}>2</button>
        <button type="button" onClick={() => inputDigit('3')} aria-label="3" className={digitBtn}>3</button>
        <button type="button" onClick={() => inputOp('+')} aria-label={t('calculator.add')} className={opBtn}>+</button>

        <button type="button" onClick={() => inputDigit('0')} aria-label="0" className={`${digitBtn} col-span-2`}>0</button>
        <button type="button" onClick={inputDot} aria-label={t('calculator.decimal')} className={digitBtn}>.</button>
        <button type="button" onClick={equals} aria-label={t('calculator.equals')} className={eqBtn}>=</button>
      </div>

      {/* Backspace row (kept out of the 4-wide grid for touch targets) */}
      <div className="px-3 pb-3">
        <button
          type="button"
          onClick={backspace}
          aria-label={t('calculator.backspace')}
          title={t('calculator.backspace')}
          className="flex min-h-[44px] w-full items-center justify-center gap-2 rounded-os bg-surface text-sm text-muted transition-colors duration-160 hover:bg-osborder/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <Delete size={16} /> {t('calculator.delete')}
        </button>
      </div>

      {/* History tape */}
      {showHist && (
        <div className="absolute inset-0 z-10 flex flex-col bg-paper">
          <div className="flex items-center justify-between border-b border-osborder bg-surface px-3 py-2">
            <p className="text-sm font-medium">{t('calculator.histTitle')}</p>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={clearHist}
                aria-label={t('calculator.clearHist')}
                title={t('calculator.clearHist')}
                disabled={hist.length === 0}
                className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-os text-sm text-muted transition-colors duration-160 hover:bg-paper disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                <Trash2 size={16} />
              </button>
              <button
                type="button"
                onClick={() => setShowHist(false)}
                aria-label={t('calculator.closeHist')}
                className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-os text-sm text-muted transition-colors duration-160 hover:bg-paper focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                <X size={17} />
              </button>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {hist.length === 0 ? (
              <p className="py-10 text-center text-sm text-muted">
                {t('calculator.noHist')}
              </p>
            ) : (
              hist.map((h, i) => (
                <button
                  key={`${h.at}-${i}`}
                  type="button"
                  onClick={() => reuse(h.result)}
                  title={t('calculator.reuseResult')}
                  aria-label={t('calculator.reuseAria', { result: h.result, expr: h.expr })}
                  className="mb-1.5 flex min-h-[44px] w-full flex-col items-end rounded-os border border-osborder bg-surface px-3 py-1.5 text-right transition-colors duration-160 hover:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                >
                  <span className="max-w-full truncate text-xs text-muted">{h.expr}</span>
                  <span className="max-w-full truncate text-lg font-semibold text-ink">{h.result}</span>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
