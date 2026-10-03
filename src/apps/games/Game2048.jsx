import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronUp, ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react';
import { GameBar, ResultBanner } from './ChessGame.jsx';
import { DPadBtn } from './SnakeGame.jsx';
import { recordBest, useScores } from './scores.js';
import { useAuth } from '../../os/AuthContext.jsx';
import { useLang } from '../../lib/i18n.jsx';

const SIZE = 4;

const TILE_STYLE = {
  2: 'bg-[#eee4da] text-[#776e65]',
  4: 'bg-[#ede0c8] text-[#776e65]',
  8: 'bg-[#f2b179] text-white',
  16: 'bg-[#f59563] text-white',
  32: 'bg-[#f67c5f] text-white',
  64: 'bg-[#f65e3b] text-white',
  128: 'bg-[#edcf72] text-white',
  256: 'bg-[#edcc61] text-white',
  512: 'bg-[#edc850] text-white',
  1024: 'bg-[#edc53f] text-white',
  2048: 'bg-[#edc22e] text-white',
};
const tileClass = (v) =>
  TILE_STYLE[v] || 'bg-[#3c3a32] text-white';

function emptyBoard() {
  return Array.from({ length: SIZE }, () => Array(SIZE).fill(0));
}

function spawn(board) {
  const empt = [];
  for (let r = 0; r < SIZE; r++)
    for (let c = 0; c < SIZE; c++) if (!board[r][c]) empt.push([r, c]);
  if (!empt.length) return board;
  const [r, c] = empt[Math.floor(Math.random() * empt.length)];
  const nb = board.map((row) => row.slice());
  nb[r][c] = Math.random() < 0.9 ? 2 : 4;
  return nb;
}

function slideRowLeft(row) {
  const nums = row.filter((v) => v);
  const out = [];
  let gained = 0;
  for (let i = 0; i < nums.length; i++) {
    if (i + 1 < nums.length && nums[i] === nums[i + 1]) {
      const v = nums[i] * 2;
      out.push(v);
      gained += v;
      i++;
    } else out.push(nums[i]);
  }
  while (out.length < SIZE) out.push(0);
  return { row: out, gained };
}

function move(board, dir) {
  // Rotate so the move direction becomes "left", slide, rotate back.
  const rot = { left: 0, up: 3, right: 2, down: 1 }[dir];
  let b = board.map((r) => r.slice());
  for (let i = 0; i < rot; i++) b = rotateCW(b);
  let gained = 0, moved = false;
  b = b.map((row) => {
    const { row: nr, gained: g } = slideRowLeft(row);
    gained += g;
    if (nr.some((v, c) => v !== row[c])) moved = true;
    return nr;
  });
  for (let i = 0; i < (4 - rot) % 4; i++) b = rotateCW(b);
  return { board: b, gained, moved };
}

function rotateCW(b) {
  const n = b.length;
  return Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, c) => b[n - 1 - c][r]));
}

function canMove(board) {
  for (let r = 0; r < SIZE; r++)
    for (let c = 0; c < SIZE; c++) {
      if (!board[r][c]) return true;
      if (c + 1 < SIZE && board[r][c] === board[r][c + 1]) return true;
      if (r + 1 < SIZE && board[r][c] === board[r + 1][c]) return true;
    }
  return false;
}

export default function Game2048({ onExit }) {
  const { user } = useAuth();
  const { t } = useLang();
  const [scores] = useScores(user?.id);
  const [board, setBoard] = useState(() => spawn(spawn(emptyBoard())));
  const [score, setScore] = useState(0);
  const [over, setOver] = useState(false);
  const [won, setWon] = useState(false);
  const [keepGoing, setKeepGoing] = useState(false);
  const touchStart = useRef(null);
  const stateRef = useRef({ board, score, over, won });
  stateRef.current = { board, score, over, won };

  const best = scores?.game2048?.best || 0;

  const reset = useCallback(() => {
    setBoard(spawn(spawn(emptyBoard())));
    setScore(0);
    setOver(false);
    setWon(false);
    setKeepGoing(false);
  }, []);

  const doMove = useCallback((dir) => {
    const s = stateRef.current;
    if (s.over || (s.won && !keepGoing)) return;
    const { board: nb, gained, moved } = move(s.board, dir);
    if (!moved) return;
    const sb = spawn(nb);
    const ns = s.score + gained;
    setBoard(sb);
    setScore(ns);
    recordBest('game2048', ns);
    if (!s.won && sb.some((row) => row.includes(2048))) setWon(true);
    if (!canMove(sb)) setOver(true);
  }, [keepGoing]);

  useEffect(() => {
    const h = (e) => {
      const map = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };
      const d = map[e.key];
      if (d) { e.preventDefault(); doMove(d); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [doMove]);

  const onTouchStart = (e) => {
    touchStart.current = [e.touches[0].clientX, e.touches[0].clientY];
  };
  const onTouchEnd = (e) => {
    if (!touchStart.current) return;
    const dx = e.changedTouches[0].clientX - touchStart.current[0];
    const dy = e.changedTouches[0].clientY - touchStart.current[1];
    touchStart.current = null;
    if (Math.max(Math.abs(dx), Math.abs(dy)) < 24) return;
    doMove(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up'));
  };

  return (
    <div className="flex h-full flex-col gap-3 p-4">
      <GameBar title="2048" onExit={onExit} onNew={reset} onUndo={null} t={t} />
      <div className="flex items-center gap-4 text-xs text-muted">
        <span>{t('games.scoreLabel')} <b className="text-ink">{score}</b></span>
        <span>{t('games.bestLabel')} <b className="text-ink">{Math.max(best, score)}</b></span>
        <span className="hidden sm:inline">{t('games.swipeHint')}</span>
      </div>
      {won && !keepGoing && !over && (
        <ResultBanner t={t} over={{ result: 'win' }} label={t('games.made2048')} onNew={() => { setKeepGoing(true); }} />
      )}
      {over && <ResultBanner t={t} over={{ result: 'gameover' }} label={t('games.noMovesLeft', { score })} onNew={reset} />}
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3">
        <div
          className="grid aspect-square w-full max-w-[min(100%,calc(100vh-360px))] select-none gap-2 rounded-os bg-[#bbada0] p-2 shadow-os"
          style={{ gridTemplateColumns: `repeat(${SIZE}, 1fr)`, minWidth: 260, touchAction: 'none' }}
          onTouchStart={onTouchStart}
          onTouchEnd={onTouchEnd}
        >
          {board.flat().map((v, i) => (
            <div
              key={i}
              className={`flex aspect-square items-center justify-center rounded-md font-bold ${
                v === 0 ? 'bg-[#cdc1b4]/60' : tileClass(v)
              } ${v >= 1024 ? 'text-lg sm:text-2xl' : 'text-xl sm:text-3xl'}`}
            >
              {v > 0 ? v : ''}
            </div>
          ))}
        </div>
        <div className="grid grid-cols-3 gap-1">
          <span />
          <DPadBtn onPress={() => doMove('up')} label={t('games.dirUp')}><ChevronUp size={20} /></DPadBtn>
          <span />
          <DPadBtn onPress={() => doMove('left')} label={t('games.dirLeft')}><ChevronLeft size={20} /></DPadBtn>
          <DPadBtn onPress={() => doMove('down')} label={t('games.dirDown')}><ChevronDown size={20} /></DPadBtn>
          <DPadBtn onPress={() => doMove('right')} label={t('games.dirRight')}><ChevronRight size={20} /></DPadBtn>
        </div>
      </div>
    </div>
  );
}
