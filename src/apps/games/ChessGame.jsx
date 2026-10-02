import { useEffect, useMemo, useRef, useState } from 'react';
import { RotateCcw, Flag, Undo2, Users, Bot, ArrowLeftRight, ArrowLeft } from 'lucide-react';
import {
  W, B, initialState, legalMoves, applyMove, gameStatus, toSAN, aiBestMove,
  PIECE_GLYPH, sqName,
} from './chessEngine.js';
import { recordResult } from './scores.js';

export default function ChessGame({ onExit }) {
  const [state, setState] = useState(() => initialState());
  const [selected, setSelected] = useState(null);
  const [history, setHistory] = useState([]); // { san, state }
  const [mode, setMode] = useState('ai'); // 'ai' | '2p'
  const [aiColor, setAiColor] = useState(B);
  const [flipped, setFlipped] = useState(false);
  const [promo, setPromo] = useState(null); // { from, to, moves }
  const [over, setOver] = useState(null);
  const aiThinking = useRef(false);

  const turnMoves = useMemo(
    () => (over ? [] : legalMoves(state, state.turn, selected)),
    [state, selected, over]
  );
  const dests = useMemo(() => new Set(turnMoves.map((m) => m.to)), [turnMoves]);
  const inCheckNow = useMemo(() => {
    const st = gameStatus(state);
    return !st.over && st.check;
  }, [state]);

  // AI move effect
  useEffect(() => {
    if (over || mode !== 'ai' || state.turn !== aiColor || aiThinking.current) return;
    aiThinking.current = true;
    const t = setTimeout(() => {
      const m = aiBestMove(state, aiColor);
      aiThinking.current = false;
      if (m) doMove(m);
      else setOver(gameStatus(state));
    }, 350);
    return () => { aiThinking.current = false; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, mode, aiColor, over]);

  const doMove = (m) => {
    const san = toSAN(state, m);
    const ns = applyMove(state, m);
    const st = gameStatus(ns);
    setHistory((h) => [...h, { san, color: state.turn, prev: state }]);
    setState(ns);
    setSelected(null);
    setPromo(null);
    if (st.over) {
      setOver(st);
      if (mode === 'ai') {
        if (st.result === 'checkmate') recordResult('chess', st.winner !== aiColor ? 'win' : 'loss');
        else recordResult('chess', 'draw');
      }
    }
  };

  const onSquare = (sq) => {
    if (over || promo) return;
    if (mode === 'ai' && state.turn === aiColor) return;
    const piece = state.board[sq];
    if (selected == null) {
      if (piece && piece.c === state.turn) setSelected(sq);
      return;
    }
    if (sq === selected) { setSelected(null); return; }
    if (piece && piece.c === state.turn) { setSelected(sq); return; }
    const cand = turnMoves.filter((m) => m.to === sq);
    if (!cand.length) { setSelected(null); return; }
    if (cand[0].promotion) setPromo({ from: selected, to: sq, moves: cand });
    else doMove(cand[0]);
  };

  const newGame = (newMode = mode, newAiColor = aiColor) => {
    setState(initialState());
    setHistory([]);
    setSelected(null);
    setPromo(null);
    setOver(null);
    setMode(newMode);
    setAiColor(newAiColor);
  };

  const undo = () => {
    if (aiThinking.current || history.length === 0) return;
    const steps = mode === 'ai' ? 2 : 1;
    const idx = history.length - steps;
    const target = idx <= 0 ? initialState() : history[idx].prev;
    setHistory(history.slice(0, Math.max(0, idx)));
    setState(target);
    setSelected(null);
    setPromo(null);
    setOver(null);
  };

  const resign = () => {
    if (over) return;
    const winner = state.turn === W ? B : W;
    setOver({ over: true, result: 'resignation', winner });
    if (mode === 'ai') recordResult('chess', winner !== aiColor ? 'win' : 'loss');
  };

  const rows = flipped ? [7, 6, 5, 4, 3, 2, 1, 0] : [0, 1, 2, 3, 4, 5, 6, 7];
  const cols = flipped ? [7, 6, 5, 4, 3, 2, 1, 0] : [0, 1, 2, 3, 4, 5, 6, 7];

  return (
    <div className="flex h-full flex-col gap-3 p-4">
      <GameBar
        title="Chess"
        onExit={onExit}
        onNew={() => newGame()}
        onUndo={undo}
        undoDisabled={history.length === 0}
        onResign={resign}
        extra={
          <>
            <ModeBtn active={mode === 'ai'} onClick={() => newGame('ai')} icon={<Bot size={15} />} label="vs AI" />
            <ModeBtn active={mode === '2p'} onClick={() => newGame('2p')} icon={<Users size={15} />} label="2 players" />
            {mode === 'ai' && (
              <button
                type="button"
                onClick={() => newGame('ai', aiColor === W ? B : W)}
                className="flex items-center gap-1 rounded-os border border-osborder bg-surface px-2 py-1.5 text-xs text-ink hover:bg-paper"
                title="Switch sides"
              >
                <ArrowLeftRight size={14} />
                {aiColor === B ? 'You: White' : 'You: Black'}
              </button>
            )}
            <button
              type="button"
              onClick={() => setFlipped((f) => !f)}
              className="rounded-os border border-osborder bg-surface px-2 py-1.5 text-xs text-ink hover:bg-paper"
            >
              Flip
            </button>
          </>
        }
      />
      {over && <ResultBanner over={over} mode={mode} aiColor={aiColor} onNew={() => newGame()} />}
      <div className="flex min-h-0 flex-1 items-start justify-center gap-4">
        <div
          className="grid aspect-square w-full max-w-[min(100%,calc(100vh-260px))] select-none grid-cols-8 overflow-hidden rounded-os border border-osborder shadow-os"
          style={{ minWidth: 280 }}
        >
          {rows.map((r) =>
            cols.map((c) => {
              const sq = r * 8 + c;
              const piece = state.board[sq];
              const light = (r + c) % 2 === 1;
              const isSel = selected === sq;
              const isDest = dests.has(sq);
              const isCap = isDest && piece;
              return (
                <button
                  key={sq}
                  type="button"
                  onClick={() => onSquare(sq)}
                  className={`relative flex aspect-square items-center justify-center text-[clamp(20px,4.5vmin,38px)] leading-none ${
                    light ? 'bg-[#ecdcb9]' : 'bg-[#a5714f]'
                  } ${isSel ? 'ring-2 ring-inset ring-accent' : ''}`}
                  aria-label={sqName(sq) + (piece ? ` ${piece.c === W ? 'white' : 'black'} ${piece.t}` : '')}
                >
                  {piece && (
                    <span
                      className={piece.c === W ? 'text-[#faf7f0] [text-shadow:0_1px_2px_rgba(0,0,0,0.55)]' : 'text-[#1c1a17] [text-shadow:0_1px_1px_rgba(255,255,255,0.25)]'}
                    >
                      {PIECE_GLYPH[piece.c + piece.t]}
                    </span>
                  )}
                  {isDest && !isCap && (
                    <span className="absolute h-1/4 w-1/4 rounded-full bg-accent/60" />
                  )}
                  {isCap && <span className="absolute inset-0 rounded-none ring-4 ring-inset ring-accent/70" />}
                  {inCheckNow && piece && piece.t === 'k' && piece.c === state.turn && (
                    <span className="absolute inset-0 bg-red-500/40" />
                  )}
                </button>
              );
            })
          )}
        </div>
        <MoveList history={history} />
      </div>
      {promo && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setPromo(null)}>
          <div className="flex gap-2 rounded-os border border-osborder bg-paper p-4 shadow-os" onClick={(e) => e.stopPropagation()}>
            {promo.moves.map((m) => (
              <button
                key={m.promotion}
                type="button"
                onClick={() => doMove(m)}
                className="flex h-16 w-16 items-center justify-center rounded-os border border-osborder bg-surface text-4xl hover:border-accent"
              >
                <span className={state.turn === W ? 'text-[#faf7f0] [text-shadow:0_1px_2px_rgba(0,0,0,0.55)]' : 'text-[#1c1a17]'}>
                  {PIECE_GLYPH[state.turn + m.promotion]}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function GameBar({ title, onExit, onNew, onUndo, undoDisabled, onResign, extra }) {
  const btn =
    'flex min-h-[40px] items-center gap-1 rounded-os border border-osborder bg-surface px-2 py-1.5 text-xs text-ink hover:bg-paper disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent';
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-sm font-semibold text-ink">{title}</span>
      <div className="ml-auto flex flex-wrap items-center gap-2">
        {extra}
        {onUndo && (
          <button type="button" onClick={onUndo} disabled={undoDisabled} className={btn} title="Undo">
            <Undo2 size={14} /> Undo
          </button>
        )}
        <button type="button" onClick={onNew} className={btn} title="New game">
          <RotateCcw size={14} /> New
        </button>
        {onResign && (
          <button type="button" onClick={onResign} className={btn} title="Resign">
            <Flag size={14} /> Resign
          </button>
        )}
        {onExit && (
          <button type="button" onClick={onExit} data-testid="game-back" className={btn} title="Back to Arcade">
            <ArrowLeft size={14} /> Back
          </button>
        )}
      </div>
    </div>
  );
}

function ModeBtn({ active, onClick, icon, label }) {
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

export function ResultBanner({ over, onNew, label }) {
  let text = label || '';
  if (!text) {
    if (over.result === 'checkmate') text = over.winner === W ? 'Checkmate — White wins' : 'Checkmate — Black wins';
    else if (over.result === 'stalemate') text = 'Stalemate — draw';
    else if (over.result === 'resignation') text = `Resignation — ${over.winner === W ? 'White' : 'Black'} wins`;
    else text = `Draw — ${over.result}`;
  }
  return (
    <div className="flex items-center justify-between gap-2 rounded-os border border-accent/40 bg-accent/10 px-3 py-2">
      <span className="text-sm font-medium text-ink">{text}</span>
      <button type="button" onClick={onNew} className="flex items-center gap-1 rounded-os bg-accent px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90">
        <RotateCcw size={14} /> Play again
      </button>
    </div>
  );
}

function MoveList({ history }) {
  const ref = useRef(null);
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [history.length]);
  const pairs = [];
  for (let i = 0; i < history.length; i += 2) pairs.push([history[i], history[i + 1]]);
  return (
    <div ref={ref} className="hidden w-40 shrink-0 self-stretch overflow-y-auto rounded-os border border-osborder bg-surface p-2 sm:block" style={{ maxHeight: '100%' }}>
      {pairs.length === 0 && <p className="text-xs text-muted">No moves yet.</p>}
      <table className="w-full text-xs">
        <tbody>
          {pairs.map((pr, i) => (
            <tr key={i} className="text-ink">
              <td className="pr-1 text-muted">{i + 1}.</td>
              <td className="pr-2 font-medium">{pr[0]?.san}</td>
              <td className="font-medium">{pr[1]?.san || ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
