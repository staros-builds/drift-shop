import { useEffect, useRef, useState } from 'react';
import { Undo2, Wand2, RotateCcw } from 'lucide-react';
import { GameBar, ResultBanner } from './ChessGame.jsx';
import { recordKlondikeWin, fmtTime } from './scores.js';

const SUITS = ['S', 'H', 'D', 'C'];
const SUIT_GLYPH = { S: '♠', H: '♥', D: '♦', C: '♣' };
const RANK_LABEL = { 1: 'A', 11: 'J', 12: 'Q', 13: 'K' };
const red = (c) => c.suit === 'H' || c.suit === 'D';

let uid = 1;
function newDeck() {
  const d = [];
  for (const suit of SUITS)
    for (let rank = 1; rank <= 13; rank++)
      d.push({ id: uid++, suit, rank, faceUp: false });
  // Fisher-Yates
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

function deal(drawCount) {
  const deck = newDeck();
  const tableau = Array.from({ length: 7 }, () => []);
  for (let col = 0; col < 7; col++) {
    for (let k = 0; k <= col; k++) {
      const card = deck.pop();
      card.faceUp = k === col;
      tableau[col].push(card);
    }
  }
  return {
    stock: deck, // top = end of array
    waste: [],
    foundations: [[], [], [], []],
    tableau,
    moves: 0,
    score: 0,
    startTime: Date.now(),
    elapsed: 0,
    won: false,
    drawCount,
    redeals: 0,
  };
}

const clone = (s) => JSON.parse(JSON.stringify(s));

function topOf(pile) {
  return pile.length ? pile[pile.length - 1] : null;
}

function canOnTableau(cards, col) {
  const c0 = cards[0];
  const t = topOf(col);
  if (!t) return c0.rank === 13;
  return t.faceUp && red(t) !== red(c0) && t.rank === c0.rank + 1;
}

function canOnFoundation(card, f) {
  const t = topOf(f);
  if (!t) return card.rank === 1;
  return t.suit === card.suit && card.rank === t.rank + 1;
}

export default function KlondikeGame({ onExit }) {
  const [state, setState] = useState(() => deal(1));
  const [sel, setSel] = useState(null); // { from: 'waste'|'tableau'|'foundation', col, idx }
  const [drawCount, setDrawCount] = useState(1);
  const undoStack = useRef([]);
  const stateRef = useRef(state);
  stateRef.current = state;

  const pushUndo = (s) => {
    undoStack.current.push(clone(s));
    if (undoStack.current.length > 120) undoStack.current.shift();
  };

  // Timer
  useEffect(() => {
    if (state.won) return;
    const t = setInterval(() => {
      setState((s) => (s.won ? s : { ...s, elapsed: Math.floor((Date.now() - s.startTime) / 1000) }));
    }, 1000);
    return () => clearInterval(t);
  }, [state.won, state.startTime]);

  // Side effects (undo snapshot, win recording) must NOT live inside the
  // setState updater: StrictMode double-invokes updaters in dev, which would
  // push duplicate undo snapshots and record the win twice. Read the latest
  // state from the ref and set the computed next state directly.
  const mutate = (fn, scoreDelta = 0) => {
    const s = stateRef.current;
    if (s.won) return;
    pushUndo(s);
    const ns = clone(s);
    fn(ns);
    ns.moves += 1;
    ns.score = Math.max(0, ns.score + scoreDelta);
    if (ns.foundations.every((f) => f.length === 13)) {
      ns.won = true;
      recordKlondikeWin(ns.score, ns.elapsed);
    }
    setSel(null);
    // Publish the next state to the ref synchronously so two mutations in
    // the same tick compose instead of the second one clobbering the first.
    stateRef.current = ns;
    setState(ns);
  };

  const flipExposed = (ns) => {
    for (const col of ns.tableau) {
      const t = topOf(col);
      if (t && !t.faceUp) {
        t.faceUp = true;
        ns.score = Math.max(0, ns.score + 5);
      }
    }
  };

  const onStock = () => {
    if (state.won) return;
    if (state.stock.length) {
      mutate((ns) => {
        for (let i = 0; i < ns.drawCount && ns.stock.length; i++) {
          const c = ns.stock.pop();
          c.faceUp = true;
          ns.waste.push(c);
        }
      });
    } else if (state.waste.length) {
      mutate((ns) => {
        while (ns.waste.length) {
          const c = ns.waste.pop();
          c.faceUp = false;
          ns.stock.push(c);
        }
        ns.redeals += 1;
      }, state.redeals > 0 ? -20 : 0);
    }
  };

  const selectedCards = () => {
    if (!sel) return null;
    if (sel.from === 'waste') {
      const t = topOf(state.waste);
      return t ? { cards: [t], single: true } : null;
    }
    if (sel.from === 'foundation') {
      const t = topOf(state.foundations[sel.col]);
      return t ? { cards: [t], single: true } : null;
    }
    const col = state.tableau[sel.col];
    const cards = col.slice(sel.idx);
    if (!cards.length || !cards[0].faceUp) return null;
    return { cards, single: cards.length === 1 };
  };

  const tryMoveSelection = (to, toCol) => {
    const sc = selectedCards();
    if (!sc) return false;
    if (to === 'tableau') {
      const col = state.tableau[toCol];
      if (sel.from === 'tableau' && sel.col === toCol) return false;
      if (!canOnTableau(sc.cards, col)) return false;
      const delta = sc.single ? (sel.from === 'waste' ? 5 : 0) : 0;
      mutate((ns) => {
        removeSel(ns);
        ns.tableau[toCol].push(...sc.cards.map((c) => ({ ...c })));
        flipExposed(ns);
      }, delta);
      return true;
    }
    if (to === 'foundation') {
      if (!sc.single) return false;
      const f = state.foundations[toCol];
      if (!canOnFoundation(sc.cards[0], f)) return false;
      const delta = sel.from === 'waste' ? 10 : sel.from === 'tableau' ? 10 : 0;
      mutate((ns) => {
        removeSel(ns);
        ns.foundations[toCol].push({ ...sc.cards[0] });
        flipExposed(ns);
      }, delta);
      return true;
    }
    return false;
  };

  const removeSel = (ns) => {
    if (sel.from === 'waste') ns.waste.pop();
    else if (sel.from === 'foundation') ns.foundations[sel.col].pop();
    else ns.tableau[sel.col].splice(sel.idx);
  };

  const onCardClick = (from, col, idx) => {
    if (state.won) return;
    if (!sel) {
      // Select
      if (from === 'waste') {
        if (state.waste.length) setSel({ from, col: -1, idx: state.waste.length - 1 });
      } else if (from === 'foundation') {
        if (state.foundations[col].length) setSel({ from, col, idx: state.foundations[col].length - 1 });
      } else {
        const pile = state.tableau[col];
        if (idx < pile.length && pile[idx].faceUp) setSel({ from, col, idx });
      }
      return;
    }
    // Clicking the selected card again deselects
    if (sel.from === from && sel.col === col && (from !== 'tableau' || sel.idx === idx)) {
      setSel(null);
      return;
    }
    // Try move to tableau column / foundation
    if (from === 'tableau') {
      if (tryMoveSelection('tableau', col)) return;
    } else if (from === 'foundation') {
      if (tryMoveSelection('foundation', col)) return;
    }
    // Otherwise reselect
    setSel(null);
    onCardClickNoSel(from, col, idx);
  };

  const onCardClickNoSel = (from, col, idx) => {
    if (from === 'waste') {
      if (state.waste.length) setSel({ from, col: -1, idx: state.waste.length - 1 });
    } else if (from === 'foundation') {
      if (state.foundations[col].length) setSel({ from, col, idx: state.foundations[col].length - 1 });
    } else {
      const pile = state.tableau[col];
      if (idx < pile.length && pile[idx].faceUp) setSel({ from, col, idx });
    }
  };

  const onEmptyClick = (to, toCol) => {
    if (!sel || state.won) return;
    tryMoveSelection(to, toCol);
  };

  const autoFoundation = (from, col, idx) => {
    if (state.won) return;
    let card = null;
    if (from === 'waste') card = topOf(state.waste);
    else if (from === 'foundation') return;
    else {
      const pile = state.tableau[col];
      if (idx !== pile.length - 1) return; // only top card
      card = topOf(pile);
    }
    if (!card || !card.faceUp) return;
    const fi = state.foundations.findIndex((f) => canOnFoundation(card, f));
    if (fi < 0) return;
    mutate((ns) => {
      let c;
      if (from === 'waste') c = ns.waste.pop();
      else c = ns.tableau[col].pop();
      const fidx = ns.foundations.findIndex((f) => canOnFoundation(c, f));
      ns.foundations[fidx].push(c);
      flipExposed(ns);
    }, 10);
  };

  const canAutoFinish =
    !state.won &&
    state.stock.length === 0 &&
    state.waste.length === 0 &&
    state.tableau.every((col) => col.every((c) => c.faceUp));

  const autoFinish = () => {
    if (!canAutoFinish) return;
    pushUndo(state);
    const ns = clone(state);
    let moved = true;
    while (moved) {
      moved = false;
      for (let col = 0; col < 7; col++) {
        const c = topOf(ns.tableau[col]);
        if (!c) continue;
        const fi = ns.foundations.findIndex((f) => canOnFoundation(c, f));
        if (fi >= 0) {
          ns.foundations[fi].push(ns.tableau[col].pop());
          ns.score += 10;
          moved = true;
        }
      }
    }
    ns.moves += 1;
    if (ns.foundations.every((f) => f.length === 13)) {
      ns.won = true;
      recordKlondikeWin(ns.score, ns.elapsed);
    }
    setSel(null);
    stateRef.current = ns;
    setState(ns);
  };

  const undo = () => {
    const prev = undoStack.current.pop();
    if (!prev) return;
    setSel(null);
    const ns = { ...prev, startTime: Date.now() - prev.elapsed * 1000 };
    stateRef.current = ns;
    setState(ns);
  };

  const newGame = (dc = drawCount) => {
    undoStack.current = [];
    setSel(null);
    setDrawCount(dc);
    const ns = deal(dc);
    stateRef.current = ns;
    setState(ns);
  };

  const isSel = (from, col, idx) =>
    sel && sel.from === from && sel.col === col && (from !== 'tableau' || sel.idx === idx);

  return (
    <div className="flex h-full flex-col gap-3 p-4">
      <GameBar
        title="Klondike"
        onExit={onExit}
        onNew={() => newGame()}
        onUndo={undo}
        undoDisabled={false}
        extra={
          <>
            <div className="flex items-center gap-1 text-xs text-muted">
              Draw:
              {[1, 3].map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => newGame(d)}
                  className={`rounded-os border px-2 py-1.5 ${drawCount === d ? 'border-accent bg-accent/15 text-ink' : 'border-osborder bg-surface hover:bg-paper'}`}
                >
                  {d}
                </button>
              ))}
            </div>
            {canAutoFinish && (
              <button type="button" onClick={autoFinish} className="flex items-center gap-1 rounded-os border border-accent/50 bg-accent/10 px-2 py-1.5 text-xs font-medium text-ink hover:bg-accent/20">
                <Wand2 size={14} /> Auto-finish
              </button>
            )}
          </>
        }
      />
      <div className="flex flex-wrap items-center gap-4 text-xs text-muted">
        <span>Score: <b className="text-ink">{state.score}</b></span>
        <span>Moves: <b className="text-ink">{state.moves}</b></span>
        <span>Time: <b className="text-ink">{fmtTime(state.elapsed)}</b></span>
        {state.won && <span className="font-semibold text-accent">You win!</span>}
      </div>
      {state.won && (
        <ResultBanner
          over={{ result: 'win' }}
          label={`You win! Score ${state.score} · ${state.moves} moves · ${fmtTime(state.elapsed)}`}
          onNew={() => newGame()}
        />
      )}
      <div className="min-h-0 flex-1 overflow-auto">
        {/* Top row: stock, waste, foundations */}
        <div className="mb-4 flex items-start justify-between gap-2">
          <div className="flex gap-3">
            <PileSlot label={state.stock.length ? `${state.stock.length}` : null} onClick={onStock}>
              {state.stock.length > 0 ? <CardBack /> : <RotateCcw size={20} className="opacity-50" />}
            </PileSlot>
            <div className="flex">
              {state.waste.slice(-3).map((c, i, arr) => (
                <div key={c.id} className={i > 0 ? '-ml-8' : ''} style={{ zIndex: i }}>
                  <CardView
                    card={c}
                    selected={isSel('waste', -1, 0) && i === arr.length - 1}
                    onClick={i === arr.length - 1 ? () => onCardClick('waste', -1, 0) : undefined}
                    onDoubleClick={i === arr.length - 1 ? () => autoFoundation('waste') : undefined}
                  />
                </div>
              ))}
              {state.waste.length === 0 && <PileSlot />}
            </div>
          </div>
          <div className="flex gap-3">
            {state.foundations.map((f, fi) => {
              const t = topOf(f);
              return (
                <PileSlot key={fi} onClick={() => onEmptyClick('foundation', fi)} suit={fi}>
                  {t && (
                    <CardView
                      card={t}
                      selected={isSel('foundation', fi, 0)}
                      onClick={() => onCardClick('foundation', fi, 0)}
                    />
                  )}
                </PileSlot>
              );
            })}
          </div>
        </div>
        {/* Tableau */}
        <div className="flex justify-between gap-2">
          {state.tableau.map((col, ci) => (
            <div key={ci} className="flex-1" style={{ minWidth: 0 }}>
              {col.length === 0 ? (
                <PileSlot onClick={() => onEmptyClick('tableau', ci)} king />
              ) : (
                <div className="flex flex-col">
                  {col.map((c, idx) => (
                    <div key={c.id} className={idx > 0 ? '-mt-7 sm:-mt-9' : ''} style={{ zIndex: idx }}>
                      <CardView
                        card={c}
                        selected={isSel('tableau', ci, idx) || (sel?.from === 'tableau' && sel.col === ci && idx >= sel.idx)}
                        onClick={() => onCardClick('tableau', ci, idx)}
                        onDoubleClick={() => autoFoundation('tableau', ci, idx)}
                      />
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function PileSlot({ children, onClick, label, suit, king }) {
  // A div with button semantics (not a <button>) so card buttons can nest inside.
  const slotName = king
    ? 'empty column'
    : suit != null
      ? `empty ${['spades', 'hearts', 'diamonds', 'clubs'][suit]} foundation`
      : label
        ? `stock pile, ${label} cards remaining`
        : 'empty waste pile';
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick?.(); } }}
      className="card-slot flex h-20 w-14 cursor-pointer items-center justify-center rounded-md border-2 border-dashed border-osborder/70 bg-surface/40 text-lg text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent sm:h-24 sm:w-16"
      aria-label={slotName}
    >
      {children || label || (king ? <span className="opacity-50">K</span> : suit != null ? <span className="opacity-30">{SUIT_GLYPH[SUITS[suit]]}</span> : null)}
    </div>
  );
}

function CardBack() {
  return (
    <div className="h-20 w-14 rounded-md border border-osborder bg-gradient-to-br from-accent/70 to-accent/40 shadow-sm sm:h-24 sm:w-16" />
  );
}

export function CardView({ card, onClick, onDoubleClick, selected }) {
  if (!card.faceUp) {
    return (
      <button type="button" onClick={onClick} className="block" aria-label="face-down card">
        <CardBack />
      </button>
    );
  }
  const isRed = red(card);
  return (
    <button
      type="button"
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      className={`block h-20 w-14 rounded-md border bg-paper text-left shadow-sm sm:h-24 sm:w-16 ${
        selected ? 'border-accent ring-2 ring-accent' : 'border-osborder'
      }`}
      aria-label={`${RANK_LABEL[card.rank] || card.rank} of ${card.suit}`}
    >
      <span className={`flex flex-col items-center justify-center pt-1 text-sm font-bold leading-tight sm:text-base ${isRed ? 'text-red-600' : 'text-ink'}`}>
        {RANK_LABEL[card.rank] || card.rank}
        <span className="text-lg leading-none sm:text-xl">{SUIT_GLYPH[card.suit]}</span>
      </span>
    </button>
  );
}
