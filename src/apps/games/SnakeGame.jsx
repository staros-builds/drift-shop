import { useCallback, useEffect, useRef, useState } from 'react';
import { Play, Pause, ChevronUp, ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react';
import { GameBar, ResultBanner } from './ChessGame.jsx';
import { recordBest, useScores } from './scores.js';
import { useAuth } from '../../os/AuthContext.jsx';
import { useLang } from '../../lib/i18n.jsx';

const N = 20;
const DIRS = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
const OPP = { up: 'down', down: 'up', left: 'right', right: 'left' };

const rndCell = (snake) => {
  for (;;) {
    const x = Math.floor(Math.random() * N);
    const y = Math.floor(Math.random() * N);
    if (!snake.some(([sx, sy]) => sx === x && sy === y)) return [x, y];
  }
};

export default function SnakeGame({ onExit }) {
  const { user } = useAuth();
  const { t } = useLang();
  const [scores] = useScores(user?.id);
  const [snake, setSnake] = useState(() => [[10, 10], [9, 10], [8, 10]]);
  const [food, setFood] = useState(() => rndCell([[10, 10], [9, 10], [8, 10]]));
  const [dir, setDir] = useState('right');
  const [running, setRunning] = useState(false);
  const [over, setOver] = useState(false);
  const [score, setScore] = useState(0);
  const dirQueue = useRef([]);
  const dirRef = useRef(dir);
  // The game-loop interval below does not re-run when `dir` changes, so it
  // must read/write through this ref — a captured `dir` goes stale after the
  // first queued turn and then validates later turns against the wrong
  // direction (dropping valid turns or allowing instant 180° reversals).
  dirRef.current = dir;
  const touchStart = useRef(null);

  const best = scores?.snake?.best || 0;

  const reset = useCallback(() => {
    const s = [[10, 10], [9, 10], [8, 10]];
    setSnake(s);
    setFood(rndCell(s));
    dirRef.current = 'right';
    setDir('right');
    dirQueue.current = [];
    setScore(0);
    setOver(false);
    setRunning(true);
  }, []);

  const queueDir = useCallback((d) => {
    const last = dirQueue.current[dirQueue.current.length - 1] || dirRef.current;
    if (d !== last && d !== OPP[last]) dirQueue.current.push(d);
    setRunning((r) => (over ? r : true));
  }, [over]);

  // Keyboard
  useEffect(() => {
    const map = {
      ArrowUp: 'up', w: 'up', W: 'up',
      ArrowDown: 'down', s: 'down', S: 'down',
      ArrowLeft: 'left', a: 'left', A: 'left',
      ArrowRight: 'right', d: 'right', D: 'right',
    };
    const h = (e) => {
      const d = map[e.key];
      if (d) { e.preventDefault(); queueDir(d); }
      if (e.key === ' ') { e.preventDefault(); setRunning((r) => !r); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [queueDir]);

  // Game loop
  useEffect(() => {
    if (!running || over) return;
    const speed = Math.max(70, 160 - Math.floor(score / 50) * 8);
    const t = setInterval(() => {
      setSnake((prev) => {
        let d = dirRef.current;
        while (dirQueue.current.length) {
          const nd = dirQueue.current.shift();
          if (nd !== d && nd !== OPP[d]) { d = nd; break; }
        }
        dirRef.current = d;
        setDir(d);
        const [dx, dy] = DIRS[d];
        const head = [prev[0][0] + dx, prev[0][1] + dy];
        // Wall / self collision
        if (head[0] < 0 || head[0] >= N || head[1] < 0 || head[1] >= N ||
            prev.some(([x, y], i) => i < prev.length - 1 && x === head[0] && y === head[1])) {
          setOver(true);
          setRunning(false);
          setScore((sc) => {
            recordBest('snake', sc);
            return sc;
          });
          return prev;
        }
        const ate = head[0] === food[0] && head[1] === food[1];
        const next = [head, ...prev];
        if (ate) {
          setFood(rndCell(next));
          setScore((sc) => sc + 10);
        } else {
          next.pop();
        }
        return next;
      });
    }, speed);
    return () => clearInterval(t);
  }, [running, over, food, score]);

  const onTouchStart = (e) => {
    touchStart.current = [e.touches[0].clientX, e.touches[0].clientY];
  };
  const onTouchEnd = (e) => {
    if (!touchStart.current) return;
    const dx = e.changedTouches[0].clientX - touchStart.current[0];
    const dy = e.changedTouches[0].clientY - touchStart.current[1];
    touchStart.current = null;
    if (Math.max(Math.abs(dx), Math.abs(dy)) < 24) return;
    queueDir(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up'));
  };

  const cells = new Set(snake.map(([x, y]) => y * N + x));

  return (
    <div className="flex h-full flex-col gap-3 p-4">
      <GameBar
        title={t('games.nameSnake')}
        onExit={onExit}
        onNew={reset}
        onUndo={null}
        t={t}
        extra={
          <button
            type="button"
            onClick={() => !over && setRunning((r) => !r)}
            className="flex items-center gap-1 rounded-os border border-osborder bg-surface px-2 py-1.5 text-xs text-ink hover:bg-paper"
          >
            {running ? <Pause size={14} /> : <Play size={14} />} {running ? t('games.pause') : t('games.play')}
          </button>
        }
      />
      <div className="flex items-center gap-4 text-xs text-muted">
        <span>{t('games.scoreLabel')} <b className="text-ink">{score}</b></span>
        <span>{t('games.bestLabel')} <b className="text-ink">{Math.max(best, score)}</b></span>
        {!running && !over && <span>{t('games.pressStart')}</span>}
      </div>
      {over && <ResultBanner t={t} over={{ result: 'gameover' }} label={t('games.gameOverScore', { score })} onNew={reset} />}
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3">
        <div
          className="grid aspect-square w-full max-w-[min(100%,calc(100vh-330px))] select-none overflow-hidden rounded-os border border-osborder bg-surface shadow-os"
          style={{ gridTemplateColumns: `repeat(${N}, 1fr)`, minWidth: 260, touchAction: 'none' }}
          onTouchStart={onTouchStart}
          onTouchEnd={onTouchEnd}
        >
          {Array.from({ length: N * N }, (_, i) => {
            const x = i % N, y = Math.floor(i / N);
            const isHead = snake[0][0] === x && snake[0][1] === y;
            const isBody = cells.has(i) && !isHead;
            const isFood = food[0] === x && food[1] === y;
            return (
              <div key={i} className="flex items-center justify-center">
                {isHead && <div className="h-[86%] w-[86%] rounded-[30%] bg-accent" />}
                {isBody && <div className="h-[80%] w-[80%] rounded-[30%] bg-accent/60" />}
                {isFood && <div className="h-[70%] w-[70%] rounded-full bg-red-500" />}
              </div>
            );
          })}
        </div>
        <div className="grid grid-cols-3 gap-1">
          <span />
          <DPadBtn onPress={() => queueDir('up')} label={t('games.dirUp')}><ChevronUp size={20} /></DPadBtn>
          <span />
          <DPadBtn onPress={() => queueDir('left')} label={t('games.dirLeft')}><ChevronLeft size={20} /></DPadBtn>
          <DPadBtn onPress={() => queueDir('down')} label={t('games.dirDown')}><ChevronDown size={20} /></DPadBtn>
          <DPadBtn onPress={() => queueDir('right')} label={t('games.dirRight')}><ChevronRight size={20} /></DPadBtn>
        </div>
      </div>
    </div>
  );
}

export function DPadBtn({ children, onPress, label }) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onPress}
      className="flex h-12 w-12 items-center justify-center rounded-os border border-osborder bg-surface text-ink shadow-sm active:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
    >
      {children}
    </button>
  );
}
