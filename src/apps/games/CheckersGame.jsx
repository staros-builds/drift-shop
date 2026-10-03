import { useEffect, useMemo, useRef, useState } from 'react';
import { Users, Bot } from 'lucide-react';
import { GameBar, ResultBanner } from './ChessGame.jsx';
import { recordResult } from './scores.js';
import { useLang } from '../../lib/i18n.jsx';

const W = 'w', B = 'b';
const opp = (c) => (c === W ? B : W);
const DIRS = { w: [[-1, -1], [-1, 1]], b: [[1, -1], [1, 1]], k: [[-1, -1], [-1, 1], [1, -1], [1, 1]] };

function initialBoard() {
  const b = new Array(64).fill(null);
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 8; c++)
      if ((r + c) % 2 === 1) b[r * 8 + c] = { c: B, k: false };
  for (let r = 5; r < 8; r++)
    for (let c = 0; c < 8; c++)
      if ((r + c) % 2 === 1) b[r * 8 + c] = { c: W, k: false };
  return b;
}

const newState = () => ({ board: initialBoard(), turn: W, mustFrom: -1, winner: null, quiet: 0 });

function pieceCaptures(board, from) {
  const p = board[from];
  if (!p) return [];
  const r = Math.floor(from / 8), c = from % 8;
  const out = [];
  for (const [dr, dc] of DIRS[p.k ? 'k' : p.c]) {
    const mr = r + dr, mc = c + dc, tr = r + 2 * dr, tc = c + 2 * dc;
    if (tr < 0 || tr > 7 || tc < 0 || tc > 7) continue;
    const mid = board[mr * 8 + mc];
    if (mid && mid.c !== p.c && !board[tr * 8 + tc]) {
      out.push({ from, to: tr * 8 + tc, captured: mr * 8 + mc });
    }
  }
  return out;
}

function pieceQuiets(board, from) {
  const p = board[from];
  if (!p) return [];
  const r = Math.floor(from / 8), c = from % 8;
  const out = [];
  for (const [dr, dc] of DIRS[p.k ? 'k' : p.c]) {
    const tr = r + dr, tc = c + dc;
    if (tr < 0 || tr > 7 || tc < 0 || tc > 7) continue;
    if (!board[tr * 8 + tc]) out.push({ from, to: tr * 8 + tc, captured: -1 });
  }
  return out;
}

/** All legal moves for color. Returns { moves, mustCapture }. */
function legalMoves(state, color) {
  const { board } = state;
  const froms = state.mustFrom >= 0 ? [state.mustFrom] : [...Array(64).keys()].filter((i) => board[i]?.c === color);
  let caps = [];
  for (const f of froms) caps.push(...pieceCaptures(board, f));
  if (caps.length) return { moves: caps, mustCapture: true };
  if (state.mustFrom >= 0) return { moves: [], mustCapture: false };
  const quiets = [];
  for (const f of froms) quiets.push(...pieceQuiets(board, f));
  return { moves: quiets, mustCapture: false };
}

function applyMove(state, m) {
  const board = state.board.slice();
  const p = { ...board[m.from] };
  board[m.from] = null;
  if (m.captured >= 0) board[m.captured] = null;
  const r = Math.floor(m.to / 8);
  const crowned = !p.k && ((p.c === W && r === 0) || (p.c === B && r === 7));
  if (crowned) p.k = true;
  board[m.to] = p;
  // Multi-jump: same piece must continue capturing (unless crowned — turn ends)
  let mustFrom = -1;
  if (m.captured >= 0 && !crowned && pieceCaptures(board, m.to).length) {
    mustFrom = m.to;
  }
  const nextTurn = mustFrom >= 0 ? state.turn : opp(state.turn);
  const ns = { board, turn: nextTurn, mustFrom, winner: null, quiet: (m.captured >= 0 || crowned) ? 0 : state.quiet + 1 };
  // Draw by 80 quiet plies (no capture or promotion).
  if (ns.quiet >= 80) ns.winner = 'draw';
  // The mover wins when the turn passes and the enemy has no pieces or no moves.
  if (mustFrom < 0 && !ns.winner) {
    const enemy = opp(state.turn);
    const enemyPieces = board.some((x) => x?.c === enemy);
    const enemyMoves = legalMoves({ board, turn: enemy, mustFrom: -1 }, enemy).moves.length;
    if (!enemyPieces || enemyMoves === 0) ns.winner = state.turn;
  }
  return ns;
}

function aiPick(state, color) {
  const { moves } = legalMoves(state, color);
  if (!moves.length) return null;
  let best = -Infinity, cands = [];
  for (const m of moves) {
    let v = Math.random() * 6;
    const piece = state.board[m.from];
    if (m.captured >= 0) {
      const victim = state.board[m.captured];
      v += 50 + (victim.k ? 20 : 0);
      // Prefer captures that lead to more captures
      const nb = state.board.slice();
      nb[m.from] = null; nb[m.captured] = null; nb[m.to] = piece;
      if (pieceCaptures(nb, m.to).length) v += 15;
    }
    const r = Math.floor(m.to / 8);
    if (!piece.k && ((piece.c === W && r === 0) || (piece.c === B && r === 7))) v += 25;
    if (piece.k) v += 4;
    // Central-ish preference
    const c = m.to % 8;
    v += 2 - Math.abs(3.5 - c) * 0.4;
    if (v > best + 1e-9) { best = v; cands = [m]; }
    else if (Math.abs(v - best) < 8) cands.push(m);
  }
  return cands[Math.floor(Math.random() * cands.length)];
}

export default function CheckersGame({ onExit }) {
  const { t } = useLang();
  const [state, setState] = useState(newState);
  const [selected, setSelected] = useState(null);
  const [mode, setMode] = useState('ai');
  const [aiColor, setAiColor] = useState(B);
  const [captured, setCaptured] = useState({ w: 0, b: 0 });
  const aiThinking = useRef(false);

  const { moves, mustCapture } = useMemo(() => legalMoves(state, state.turn), [state]);
  const selMoves = useMemo(() => moves.filter((m) => m.from === selected), [moves, selected]);
  const selDests = useMemo(() => new Set(selMoves.map((m) => m.to)), [selMoves]);

  useEffect(() => {
    if (state.winner || mode !== 'ai' || state.turn !== aiColor || aiThinking.current) return;
    aiThinking.current = true;
    const t = setTimeout(() => {
      const m = aiPick(state, aiColor);
      aiThinking.current = false;
      if (m) doMove(m);
    }, 400);
    return () => { aiThinking.current = false; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, mode, aiColor]);

  const doMove = (m) => {
    if (m.captured >= 0) {
      setCaptured((c) => ({ ...c, [state.turn]: c[state.turn] + 1 }));
    }
    const ns = applyMove(state, m);
    setState(ns);
    setSelected(ns.mustFrom >= 0 ? ns.mustFrom : null);
    if (ns.winner) {
      if (mode === 'ai') {
        recordResult('checkers', ns.winner === 'draw' ? 'draw' : ns.winner !== aiColor ? 'win' : 'loss');
      }
    }
  };

  const onSquare = (sq) => {
    if (state.winner) return;
    if (mode === 'ai' && state.turn === aiColor) return;
    if (state.mustFrom >= 0 && sq !== state.mustFrom && !selDests.has(sq)) return;
    const piece = state.board[sq];
    if (selected == null || (piece && piece.c === state.turn && state.mustFrom < 0)) {
      if (piece && piece.c === state.turn) {
        // Only allow selecting pieces that have a legal move
        if (moves.some((m) => m.from === sq)) setSelected(sq);
      }
      return;
    }
    if (sq === selected && state.mustFrom < 0) { setSelected(null); return; }
    const m = selMoves.find((x) => x.to === sq);
    if (m) doMove(m);
    else if (piece && piece.c === state.turn && state.mustFrom < 0 && moves.some((x) => x.from === sq)) setSelected(sq);
  };

  const newGame = (m = mode) => {
    setState(newState());
    setSelected(null);
    setCaptured({ w: 0, b: 0 });
    setMode(m);
  };

  return (
    <div className="flex h-full flex-col gap-3 p-4">
      <GameBar
        title={t('games.nameCheckers')}
        onExit={onExit}
        onNew={() => newGame()}
        onUndo={null}
        t={t}
        extra={
          <>
            <ModeBtn2 active={mode === 'ai'} onClick={() => newGame('ai')} icon={<Bot size={15} />} label={t('games.vsAI')} />
            <ModeBtn2 active={mode === '2p'} onClick={() => newGame('2p')} icon={<Users size={15} />} label={t('games.twoPlayers')} />
          </>
        }
      />
      <div className="flex flex-wrap items-center gap-3 text-xs text-muted">
        <span className={state.turn === W && !state.winner ? 'font-semibold text-ink' : ''}>{t('games.whiteToMove')}</span>
        <span className={state.turn === B && !state.winner ? 'font-semibold text-ink' : ''}>{t('games.blackToMove')}</span>
        {mustCapture && !state.winner && <span className="font-semibold text-accent">{t('games.jumpRequired')}</span>}
        {state.mustFrom >= 0 && !state.winner && <span className="font-semibold text-accent">{t('games.keepJumping')}</span>}
        <span className="ml-auto">{t('games.capturedLine', { you: mode === 'ai' ? (aiColor === B ? captured.w : captured.b) : captured.w, opp: mode === 'ai' ? (aiColor === B ? captured.b : captured.w) : captured.b })}</span>
      </div>
      {state.winner && (
        <ResultBanner
          t={t}
          over={{ result: 'win', winner: state.winner }}
          label={state.winner === 'draw' ? t('games.draw80') : t('games.winsBang', { winner: state.winner === W ? t('games.white') : t('games.black') })}
          onNew={() => newGame()}
        />
      )}
      <div className="flex min-h-0 flex-1 items-start justify-center">
        <div className="grid aspect-square w-full max-w-[min(100%,calc(100vh-280px))] select-none grid-cols-8 overflow-hidden rounded-os border border-osborder shadow-os" style={{ minWidth: 280 }}>
          {Array.from({ length: 64 }, (_, sq) => {
            const r = Math.floor(sq / 8), c = sq % 8;
            const dark = (r + c) % 2 === 1;
            const piece = state.board[sq];
            const isSel = selected === sq;
            const isDest = selDests.has(sq);
            const canSelect = piece && piece.c === state.turn && moves.some((m) => m.from === sq);
            return (
              <button
                key={sq}
                type="button"
                onClick={() => onSquare(sq)}
                className={`relative flex aspect-square items-center justify-center ${dark ? 'bg-[#a5714f]' : 'bg-[#ecdcb9]'} ${isSel ? 'ring-2 ring-inset ring-accent' : ''}`}
                aria-label={t('games.squareAria', { n: sq })}
              >
                {piece && (
                  <span
                    className={`flex h-[78%] w-[78%] items-center justify-center rounded-full border-2 shadow ${
                      piece.c === W ? 'border-[#8a6a4a] bg-[#faf7f0]' : 'border-black bg-[#2b2723]'
                    } ${canSelect ? 'cursor-pointer' : ''}`}
                  >
                    {piece.k && (
                      <span className={`text-lg font-bold ${piece.c === W ? 'text-[#a5714f]' : 'text-[#e8c87a]'}`}>K</span>
                    )}
                    {!piece.k && (
                      <span className={`h-1/3 w-1/3 rounded-full ${piece.c === W ? 'bg-[#d9c6a5]' : 'bg-black/60'}`} />
                    )}
                  </span>
                )}
                {isDest && <span className="absolute h-1/4 w-1/4 rounded-full bg-accent/70" />}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function ModeBtn2({ active, onClick, icon, label }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex min-h-[40px] items-center gap-1 rounded-os border px-2 py-1.5 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
        active ? 'border-accent bg-accent/15 text-ink' : 'border-osborder bg-surface text-muted hover:text-ink'
      }`}
    >
      {icon} {label}
    </button>
  );
}
