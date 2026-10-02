import { useEffect, useRef, useState } from 'react';
import { Flag, Bomb } from 'lucide-react';
import { GameBar, ResultBanner } from './ChessGame.jsx';
import { recordMinesweeperTime, fmtTime } from './scores.js';

const LEVELS = {
  beginner: { label: 'Easy', rows: 9, cols: 9, mines: 10 },
  intermediate: { label: 'Medium', rows: 16, cols: 16, mines: 40 },
  expert: { label: 'Hard', rows: 16, cols: 30, mines: 99 },
};

function neighbors(rows, cols, r, c) {
  const out = [];
  for (let dr = -1; dr <= 1; dr++)
    for (let dc = -1; dc <= 1; dc++) {
      if (!dr && !dc) continue;
      const nr = r + dr, nc = c + dc;
      if (nr >= 0 && nr < rows && nc >= 0 && nc < cols) out.push([nr, nc]);
    }
  return out;
}

function plantMines(rows, cols, mines, safeR, safeC) {
  const set = new Set();
  while (set.size < mines) {
    const r = Math.floor(Math.random() * rows);
    const c = Math.floor(Math.random() * cols);
    if (Math.abs(r - safeR) <= 1 && Math.abs(c - safeC) <= 1) continue; // safe zone
    set.add(r * cols + c);
  }
  return set;
}

function countAt(mines, rows, cols, r, c) {
  let n = 0;
  for (const [nr, nc] of neighbors(rows, cols, r, c)) if (mines.has(nr * cols + nc)) n++;
  return n;
}

// Classic minesweeper hues, shifted to the 500/400 range so the numbers stay
// readable on the paper cell in both the light and dark themes.
const NUM_COLORS = ['', 'text-blue-500', 'text-green-500', 'text-red-500', 'text-indigo-400', 'text-amber-500', 'text-teal-400', 'text-ink', 'text-gray-500'];

export default function MinesweeperGame({ onExit }) {
  const [level, setLevel] = useState('beginner');
  const cfg = LEVELS[level];
  const [mines, setMines] = useState(null); // Set of idx, planted on first click
  const [revealed, setRevealed] = useState(() => new Set());
  const [flags, setFlags] = useState(() => new Set());
  const [over, setOver] = useState(null); // 'won' | 'lost'
  const [seconds, setSeconds] = useState(0);
  const [flagMode, setFlagMode] = useState(false);
  const started = useRef(false);
  const longPress = useRef(null);

  const total = cfg.rows * cfg.cols;

  useEffect(() => {
    if (!started.current || over) return;
    const t = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [over, level]);

  const reset = (lv = level) => {
    setLevel(lv);
    setMines(null);
    setRevealed(new Set());
    setFlags(new Set());
    setOver(null);
    setSeconds(0);
    started.current = false;
  };

  const reveal = (r, c, mineSet, rev) => {
    const stack = [[r, c]];
    while (stack.length) {
      const [cr, cc] = stack.pop();
      const idx = cr * cfg.cols + cc;
      if (rev.has(idx)) continue;
      rev.add(idx);
      if (countAt(mineSet, cfg.rows, cfg.cols, cr, cc) === 0) {
        for (const [nr, nc] of neighbors(cfg.rows, cfg.cols, cr, cc)) {
          if (!rev.has(nr * cfg.cols + nc)) stack.push([nr, nc]);
        }
      }
    }
  };

  const checkWin = (rev, mineSet) => {
    if (rev.size === total - mineSet.size) {
      setOver('won');
      recordMinesweeperTime(level, seconds);
    }
  };

  const open = (r, c) => {
    if (over) return;
    const idx = r * cfg.cols + c;
    if (revealed.has(idx) || flags.has(idx)) return;
    let mineSet = mines;
    if (!mineSet) {
      mineSet = plantMines(cfg.rows, cfg.cols, cfg.mines, r, c);
      setMines(mineSet);
      started.current = true;
    }
    if (mineSet.has(idx)) {
      setOver('lost');
      // Reveal every mine for the classic game-over board
      setRevealed((prev) => new Set([...prev, ...mineSet]));
      return;
    }
    const rev = new Set(revealed);
    reveal(r, c, mineSet, rev);
    setRevealed(rev);
    checkWin(rev, mineSet);
  };

  const toggleFlag = (r, c) => {
    if (over) return;
    const idx = r * cfg.cols + c;
    if (revealed.has(idx)) return;
    if (!started.current) return; // plant mines on first open, not flag
    setFlags((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else if (next.size < cfg.mines) next.add(idx);
      return next;
    });
  };

  const onCell = (r, c) => (flagMode ? toggleFlag(r, c) : open(r, c));
  const onContext = (e, r, c) => { e.preventDefault(); toggleFlag(r, c); };
  const onTouchStart = (r, c) => {
    longPress.current = setTimeout(() => { toggleFlag(r, c); longPress.current = 'fired'; }, 450);
  };
  const onTouchEnd = (r, c) => {
    if (longPress.current === 'fired') { longPress.current = null; return; }
    clearTimeout(longPress.current);
    longPress.current = null;
  };
  // A pending long-press must never fire after the component is gone, and a
  // cancelled touch (incoming call, gesture takeover) shouldn't plant a flag.
  useEffect(() => () => clearTimeout(longPress.current), []);

  const exploded = over === 'lost';
  const cellSize = cfg.cols > 16 ? 'h-6 w-6 text-[10px]' : 'h-8 w-8 text-xs sm:h-9 sm:w-9 sm:text-sm';

  return (
    <div className="flex h-full flex-col gap-3 p-4">
      <GameBar
        title="Minesweeper"
        onExit={onExit}
        onNew={() => reset()}
        onUndo={null}
        extra={
          <>
            {Object.entries(LEVELS).map(([id, l]) => (
              <button
                key={id}
                type="button"
                onClick={() => reset(id)}
                className={`min-h-[40px] rounded-os border px-2 py-1.5 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${level === id ? 'border-accent bg-accent/15 text-ink' : 'border-osborder bg-surface text-muted hover:text-ink'}`}
              >
                {l.label}
              </button>
            ))}
            <button
              type="button"
              onClick={() => setFlagMode((f) => !f)}
              className={`flex min-h-[40px] items-center gap-1 rounded-os border px-2 py-1.5 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${flagMode ? 'border-accent bg-accent/15 text-ink' : 'border-osborder bg-surface text-muted hover:text-ink'}`}
              title="Flag mode: tap places flags"
            >
              <Flag size={14} /> {flagMode ? 'Flagging' : 'Flag'}
            </button>
          </>
        }
      />
      <div className="flex items-center gap-4 text-xs text-muted">
        <span>Mines: <b className="text-ink">{cfg.mines - flags.size}</b></span>
        <span>Time: <b className="text-ink">{fmtTime(seconds)}</b></span>
        <span className="hidden sm:inline">Left-click: open · Right-click / long-press: flag</span>
      </div>
      {over && (
        <ResultBanner
          over={{ result: over }}
          label={over === 'won' ? `Cleared in ${fmtTime(seconds)}!` : 'Boom! You hit a mine.'}
          onNew={() => reset()}
        />
      )}
      <div className="min-h-0 flex-1 overflow-auto">
        <div
          className="inline-grid select-none gap-px rounded-os border border-osborder bg-osborder p-px shadow-os"
          style={{ gridTemplateColumns: `repeat(${cfg.cols}, minmax(0, 1fr))` }}
        >
          {Array.from({ length: total }, (_, i) => {
            const r = Math.floor(i / cfg.cols), c = i % cfg.cols;
            const isRev = revealed.has(i);
            const isFlag = flags.has(i);
            const isMine = mines?.has(i);
            const n = isRev && mines ? countAt(mines, cfg.rows, cfg.cols, r, c) : 0;
            return (
              <button
                key={i}
                type="button"
                onClick={() => onCell(r, c)}
                onContextMenu={(e) => onContext(e, r, c)}
                onTouchStart={() => onTouchStart(r, c)}
                onTouchEnd={() => onTouchEnd(r, c)}
                onTouchCancel={() => onTouchEnd(r, c)}
                className={`${cellSize} flex items-center justify-center font-bold ${
                  isRev
                    ? isMine
                      ? 'bg-red-500/80'
                      : 'bg-paper'
                    : 'bg-surface hover:bg-paper active:bg-paper'
                }`}
                aria-label={`cell ${r},${c}`}
              >
                {isRev ? (
                  isMine ? <Bomb size={14} className="text-ink" /> : n > 0 ? <span className={NUM_COLORS[n]}>{n}</span> : null
                ) : isFlag ? (
                  <Flag size={14} className="text-accent" />
                ) : null}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
