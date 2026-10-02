// Minimal but complete chess engine: legal move generation, check /
// checkmate / stalemate detection, castling, en passant, promotion,
// fifty-move + repetition + insufficient-material draws, SAN notation,
// and a small alpha-beta AI.
//
// Board: Array(64), index = row*8+col, row 0 = rank 8 (black home).
// Piece: { t: 'p'|'n'|'b'|'r'|'q'|'k', c: 'w'|'b' }.

export const W = 'w';
export const B = 'b';

const FILES = 'abcdefgh';
const KNIGHT_D = [[-2, -1], [-2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1]];
const KING_D = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]];
const DIAG = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
const ORTHO = [[-1, 0], [1, 0], [0, -1], [0, 1]];
const VALUES = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 };

// Simple piece-square tables (from white's perspective, row 0 = rank 8).
const PST = {
  p: [
    0, 0, 0, 0, 0, 0, 0, 0,
    50, 50, 50, 50, 50, 50, 50, 50,
    10, 10, 20, 30, 30, 20, 10, 10,
    5, 5, 10, 25, 25, 10, 5, 5,
    0, 0, 0, 20, 20, 0, 0, 0,
    5, -5, -10, 0, 0, -10, -5, 5,
    5, 10, 10, -20, -20, 10, 10, 5,
    0, 0, 0, 0, 0, 0, 0, 0,
  ],
  n: [
    -50, -40, -30, -30, -30, -30, -40, -50,
    -40, -20, 0, 0, 0, 0, -20, -40,
    -30, 0, 10, 15, 15, 10, 0, -30,
    -30, 5, 15, 20, 20, 15, 5, -30,
    -30, 0, 15, 20, 20, 15, 0, -30,
    -30, 5, 10, 15, 15, 10, 5, -30,
    -40, -20, 0, 5, 5, 0, -20, -40,
    -50, -40, -30, -30, -30, -30, -40, -50,
  ],
  b: [
    -20, -10, -10, -10, -10, -10, -10, -20,
    -10, 0, 0, 0, 0, 0, 0, -10,
    -10, 0, 5, 10, 10, 5, 0, -10,
    -10, 5, 5, 10, 10, 5, 5, -10,
    -10, 0, 10, 10, 10, 10, 0, -10,
    -10, 10, 10, 10, 10, 10, 10, -10,
    -10, 5, 0, 0, 0, 0, 5, -10,
    -20, -10, -10, -10, -10, -10, -10, -20,
  ],
  r: [
    0, 0, 0, 0, 0, 0, 0, 0,
    5, 10, 10, 10, 10, 10, 10, 5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    0, 0, 0, 5, 5, 0, 0, 0,
  ],
  q: [
    -20, -10, -10, -5, -5, -10, -10, -20,
    -10, 0, 0, 0, 0, 0, 0, -10,
    -10, 0, 5, 5, 5, 5, 0, -10,
    -5, 0, 5, 5, 5, 5, 0, -5,
    0, 0, 5, 5, 5, 5, 0, -5,
    -10, 5, 5, 5, 5, 5, 0, -10,
    -10, 0, 5, 0, 0, 0, 0, -10,
    -20, -10, -10, -5, -5, -10, -10, -20,
  ],
  k: [
    -30, -40, -40, -50, -50, -40, -40, -30,
    -30, -40, -40, -50, -50, -40, -40, -30,
    -30, -40, -40, -50, -50, -40, -40, -30,
    -30, -40, -40, -50, -50, -40, -40, -30,
    -20, -30, -30, -40, -40, -30, -30, -20,
    -10, -20, -20, -20, -20, -20, -20, -10,
    20, 20, 0, 0, 0, 0, 20, 20,
    20, 30, 10, 0, 0, 10, 30, 20,
  ],
};

export const sqName = (i) => FILES[i % 8] + (8 - Math.floor(i / 8));
const onBoard = (r, c) => r >= 0 && r < 8 && c >= 0 && c < 8;
const opp = (c) => (c === W ? B : W);

export function initialState() {
  const board = new Array(64).fill(null);
  const back = ['r', 'n', 'b', 'q', 'k', 'b', 'n', 'r'];
  for (let c = 0; c < 8; c++) {
    board[c] = { t: back[c], c: B };
    board[8 + c] = { t: 'p', c: B };
    board[48 + c] = { t: 'p', c: W };
    board[56 + c] = { t: back[c], c: W };
  }
  const s = {
    board, turn: W,
    castling: { wk: true, wq: true, bk: true, bq: true },
    ep: -1, half: 0, full: 1, keys: [],
  };
  s.keys = [posKey(s)];
  return s;
}

function posKey(s) {
  let k = '';
  for (let i = 0; i < 64; i++) {
    const p = s.board[i];
    k += p ? (p.c === W ? p.t.toUpperCase() : p.t) : '.';
  }
  const c = s.castling;
  k += (c.wk ? 'K' : '') + (c.wq ? 'Q' : '') + (c.bk ? 'k' : '') + (c.bq ? 'q' : '');
  k += s.ep + s.turn;
  return k;
}

function kingSquare(board, color) {
  for (let i = 0; i < 64; i++) {
    const p = board[i];
    if (p && p.t === 'k' && p.c === color) return i;
  }
  return -1;
}

/** Is square `sq` attacked by color `by`? */
export function isAttacked(board, sq, by) {
  const r = Math.floor(sq / 8), c = sq % 8;
  // Pawns
  const pr = by === W ? r + 1 : r - 1;
  for (const dc of [-1, 1]) {
    if (onBoard(pr, c + dc)) {
      const p = board[pr * 8 + c + dc];
      if (p && p.c === by && p.t === 'p') return true;
    }
  }
  // Knights
  for (const [dr, dc] of KNIGHT_D) {
    if (onBoard(r + dr, c + dc)) {
      const p = board[(r + dr) * 8 + c + dc];
      if (p && p.c === by && p.t === 'n') return true;
    }
  }
  // King
  for (const [dr, dc] of KING_D) {
    if (onBoard(r + dr, c + dc)) {
      const p = board[(r + dr) * 8 + c + dc];
      if (p && p.c === by && p.t === 'k') return true;
    }
  }
  // Sliders
  const rays = [
    [DIAG, ['b', 'q']],
    [ORTHO, ['r', 'q']],
  ];
  for (const [dirs, types] of rays) {
    for (const [dr, dc] of dirs) {
      let nr = r + dr, nc = c + dc;
      while (onBoard(nr, nc)) {
        const p = board[nr * 8 + nc];
        if (p) {
          if (p.c === by && types.includes(p.t)) return true;
          break;
        }
        nr += dr; nc += dc;
      }
    }
  }
  return false;
}

export function inCheck(state, color) {
  return isAttacked(state.board, kingSquare(state.board, color), opp(color));
}

/** Pseudo-legal moves for the piece on `from` (ignores king safety). */
function pseudoMoves(s, from) {
  const p = s.board[from];
  if (!p) return [];
  const r = Math.floor(from / 8), c = from % 8;
  const moves = [];
  const add = (to, extra = {}) => moves.push({ from, to, piece: p.t, color: p.c, captured: s.board[to] ? s.board[to].t : null, ...extra });
  const slide = (dirs) => {
    for (const [dr, dc] of dirs) {
      let nr = r + dr, nc = c + dc;
      while (onBoard(nr, nc)) {
        const t = board2(nr, nc);
        if (!s.board[t]) add(t);
        else {
          if (s.board[t].c !== p.c) add(t);
          break;
        }
        nr += dr; nc += dc;
      }
    }
  };
  const board2 = (rr, cc) => rr * 8 + cc;

  if (p.t === 'p') {
    const dir = p.c === W ? -1 : 1;
    const startRow = p.c === W ? 6 : 1;
    const promoRow = p.c === W ? 0 : 7;
    const one = r + dir;
    if (onBoard(one, c) && !s.board[board2(one, c)]) {
      if (one === promoRow) {
        for (const pr of ['q', 'r', 'b', 'n']) add(board2(one, c), { promotion: pr });
      } else {
        add(board2(one, c));
        const two = r + 2 * dir;
        if (r === startRow && !s.board[board2(two, c)]) add(board2(two, c), { doublePush: true });
      }
    }
    for (const dc of [-1, 1]) {
      const nr = r + dir, nc = c + dc;
      if (!onBoard(nr, nc)) continue;
      const t = board2(nr, nc);
      const target = s.board[t];
      if (target && target.c !== p.c) {
        if (nr === promoRow) {
          for (const pr of ['q', 'r', 'b', 'n']) add(t, { promotion: pr });
        } else add(t);
      } else if (t === s.ep) {
        add(t, { enPassant: true, captured: 'p' });
      }
    }
  } else if (p.t === 'n') {
    for (const [dr, dc] of KNIGHT_D) {
      if (!onBoard(r + dr, c + dc)) continue;
      const t = board2(r + dr, c + dc);
      if (!s.board[t] || s.board[t].c !== p.c) add(t);
    }
  } else if (p.t === 'b') slide(DIAG);
  else if (p.t === 'r') slide(ORTHO);
  else if (p.t === 'q') slide([...DIAG, ...ORTHO]);
  else if (p.t === 'k') {
    for (const [dr, dc] of KING_D) {
      if (!onBoard(r + dr, c + dc)) continue;
      const t = board2(r + dr, c + dc);
      if (!s.board[t] || s.board[t].c !== p.c) add(t);
    }
    // Castling
    const home = p.c === W ? 7 : 0;
    if (r === home && c === 4) {
      const k = s.castling;
      const ks = p.c === W ? k.wk : k.bk;
      const qs = p.c === W ? k.wq : k.bq;
      const enemy = opp(p.c);
      if (ks && !s.board[home * 8 + 5] && !s.board[home * 8 + 6] &&
          !isAttacked(s.board, from, enemy) &&
          !isAttacked(s.board, home * 8 + 5, enemy) &&
          !isAttacked(s.board, home * 8 + 6, enemy)) {
        add(home * 8 + 6, { castle: 'k' });
      }
      if (qs && !s.board[home * 8 + 3] && !s.board[home * 8 + 2] && !s.board[home * 8 + 1] &&
          !isAttacked(s.board, from, enemy) &&
          !isAttacked(s.board, home * 8 + 3, enemy) &&
          !isAttacked(s.board, home * 8 + 2, enemy)) {
        add(home * 8 + 2, { castle: 'q' });
      }
    }
  }
  return moves;
}

/** Apply a move; returns a NEW state. Assumes the move is legal. */
export function applyMove(s, m) {
  const board = s.board.slice();
  const piece = board[m.from];
  board[m.from] = null;
  if (m.enPassant) {
    const capR = Math.floor(m.to / 8) + (piece.c === W ? 1 : -1);
    board[capR * 8 + (m.to % 8)] = null;
  }
  board[m.to] = m.promotion ? { t: m.promotion, c: piece.c } : piece;
  if (m.castle) {
    const home = piece.c === W ? 7 : 0;
    if (m.castle === 'k') {
      board[home * 8 + 5] = board[home * 8 + 7];
      board[home * 8 + 7] = null;
    } else {
      board[home * 8 + 3] = board[home * 8 + 0];
      board[home * 8 + 0] = null;
    }
  }
  const castling = { ...s.castling };
  // Lose rights when king/rook moves or a rook is captured
  if (piece.t === 'k') {
    if (piece.c === W) { castling.wk = false; castling.wq = false; }
    else { castling.bk = false; castling.bq = false; }
  }
  const loseRookRight = (sq, color) => {
    const home = color === W ? 7 : 0;
    if (sq === home * 8 + 0) { if (color === W) castling.wq = false; else castling.bq = false; }
    if (sq === home * 8 + 7) { if (color === W) castling.wk = false; else castling.bk = false; }
  };
  if (piece.t === 'r') loseRookRight(m.from, piece.c);
  if (m.captured === 'r') loseRookRight(m.to, opp(piece.c));

  const ep = m.doublePush ? (m.from + m.to) / 2 : -1;
  const half = (piece.t === 'p' || m.captured) ? 0 : s.half + 1;
  const next = {
    board, turn: opp(s.turn), castling, ep, half,
    full: s.full + (s.turn === B ? 1 : 0),
    keys: s.keys.slice(),
  };
  next.keys.push(posKey(next));
  return next;
}

/** All legal moves for `color` (optionally only from one square). */
export function legalMoves(s, color, from = null) {
  const out = [];
  for (let i = 0; i < 64; i++) {
    if (from != null && i !== from) continue;
    const p = s.board[i];
    if (!p || p.c !== color) continue;
    for (const m of pseudoMoves(s, i)) {
      const ns = applyMove(s, m);
      if (!inCheck(ns, color)) out.push(m);
    }
  }
  return out;
}

function insufficientMaterial(board) {
  const minors = [];
  for (let i = 0; i < 64; i++) {
    const p = board[i];
    if (!p || p.t === 'k') continue;
    if (p.t === 'p' || p.t === 'r' || p.t === 'q') return false;
    minors.push({ ...p, sq: i });
  }
  if (minors.length === 0) return true;
  if (minors.length === 1) return true; // K+minor vs K
  if (minors.length === 2 && minors[0].c !== minors[1].c && minors[0].t === 'b' && minors[1].t === 'b') {
    // K+B vs K+B with bishops on same color
    const c1 = (Math.floor(minors[0].sq / 8) + (minors[0].sq % 8)) % 2;
    const c2 = (Math.floor(minors[1].sq / 8) + (minors[1].sq % 8)) % 2;
    if (c1 === c2) return true;
  }
  return false;
}

/** 'playing' | { over, result, winner } */
export function gameStatus(s) {
  const moves = legalMoves(s, s.turn);
  const check = inCheck(s, s.turn);
  if (moves.length === 0) {
    return check
      ? { over: true, result: 'checkmate', winner: opp(s.turn) }
      : { over: true, result: 'stalemate', winner: null };
  }
  if (s.half >= 100) return { over: true, result: 'fifty-move rule', winner: null };
  if (insufficientMaterial(s.board)) return { over: true, result: 'insufficient material', winner: null };
  const reps = s.keys.filter((k) => k === s.keys[s.keys.length - 1]).length;
  if (reps >= 3) return { over: true, result: 'threefold repetition', winner: null };
  return { over: false, check };
}

export function toSAN(s, m) {
  if (m.castle) return m.castle === 'k' ? 'O-O' : 'O-O-O';
  const ns = applyMove(s, m);
  const st = gameStatus(ns);
  const suffix = st.over && st.result === 'checkmate' ? '#' : (inCheck(ns, ns.turn) ? '+' : '');
  if (m.piece === 'p') {
    const cap = m.captured ? FILES[m.from % 8] + 'x' : '';
    const promo = m.promotion ? '=' + m.promotion.toUpperCase() : '';
    return cap + sqName(m.to) + promo + suffix;
  }
  let san = m.piece.toUpperCase().replace('N', 'N');
  // Disambiguation
  const others = [];
  for (let i = 0; i < 64; i++) {
    if (i === m.from) continue;
    const p = s.board[i];
    if (!p || p.t !== m.piece || p.c !== m.color) continue;
    const ms = legalMoves(s, m.color, i);
    if (ms.some((x) => x.to === m.to)) others.push(i);
  }
  if (others.length) {
    const sameFile = others.some((i) => i % 8 === m.from % 8);
    const sameRank = others.some((i) => Math.floor(i / 8) === Math.floor(m.from / 8));
    if (!sameFile) san += FILES[m.from % 8];
    else if (!sameRank) san += String(8 - Math.floor(m.from / 8));
    else san += sqName(m.from);
  }
  if (m.captured) san += 'x';
  san += sqName(m.to);
  return san + suffix;
}

// ---- AI: negamax with alpha-beta, depth 2, tiny randomness ----

function evaluate(board) {
  let score = 0;
  for (let i = 0; i < 64; i++) {
    const p = board[i];
    if (!p) continue;
    const idx = p.c === W ? i : (7 - Math.floor(i / 8)) * 8 + (i % 8);
    const v = VALUES[p.t] + (PST[p.t] ? PST[p.t][idx] : 0);
    score += p.c === W ? v : -v;
  }
  return score;
}

function orderedMoves(s, color) {
  const ms = legalMoves(s, color);
  // MVV-LVA-ish ordering for better pruning
  for (const m of ms) {
    m._s = (m.captured ? 10 * VALUES[m.captured] - VALUES[m.piece] : 0) + (m.promotion ? 800 : 0);
  }
  ms.sort((a, b) => b._s - a._s);
  return ms;
}

function negamax(s, depth, alpha, beta, colorSign) {
  const st = gameStatus(s);
  if (st.over) {
    if (st.result === 'checkmate') return -100000 - depth; // prefer faster mate
    return 0;
  }
  if (depth === 0) return colorSign * evaluate(s.board);
  let best = -Infinity;
  for (const m of orderedMoves(s, s.turn)) {
    const v = -negamax(applyMove(s, m), depth - 1, -beta, -alpha, -colorSign);
    if (v > best) best = v;
    if (best > alpha) alpha = best;
    if (alpha >= beta) break;
  }
  return best;
}

export function aiBestMove(s, color, depth = 2) {
  const ms = orderedMoves(s, color);
  if (!ms.length) return null;
  let best = -Infinity;
  let candidates = [];
  for (const m of ms) {
    const v = -negamax(applyMove(s, m), depth - 1, -Infinity, Infinity, color === W ? -1 : 1);
    const jitter = Math.random() * 12;
    const score = v + jitter;
    if (score > best + 1e-9) { best = score; candidates = [m]; }
    else if (Math.abs(score - best) < 25) candidates.push(m);
  }
  return candidates[Math.floor(Math.random() * candidates.length)];
}

export const PIECE_GLYPH = {
  wk: '♔', wq: '♕', wr: '♖', wb: '♗', wn: '♘', wp: '♙',
  bk: '♚', bq: '♛', br: '♜', bb: '♝', bn: '♞', bp: '♟',
};
