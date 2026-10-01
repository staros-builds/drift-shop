import { useState, useEffect, useCallback } from 'react';

/**
 * Arcade high scores, stored per-user in localStorage (backend-agnostic,
 * no migration needed). Shape per game:
 *   chess/checkers: { w, l, d }
 *   klondike:       { wins, best, bestTime }
 *   snake/2048:     { best }
 *   minesweeper:    { beginner, intermediate, expert } (best times, seconds)
 */

function keyFor(userId) {
  return `drift.arcade.scores.${userId || 'guest'}`;
}

export function loadScores(userId) {
  try {
    const raw = localStorage.getItem(keyFor(userId));
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveScores(userId, scores) {
  try {
    localStorage.setItem(keyFor(userId), JSON.stringify(scores));
  } catch {
    /* storage full / unavailable — scores just won't persist */
  }
}

/** React hook: live high-score table for the current user. */
export function useScores(userId) {
  const [scores, setScores] = useState(() => loadScores(userId));
  useEffect(() => {
    setScores(loadScores(userId));
  }, [userId]);
  const update = useCallback(
    (fn) => {
      setScores((prev) => {
        const next = fn(prev);
        saveScores(userId, next);
        return next;
      });
    },
    [userId]
  );
  return [scores, update];
}

/** Record a win/loss/draw for chess/checkers. */
export function recordResult(gameId, outcome /* 'win' | 'loss' | 'draw' */) {
  try {
    const userId = window.__driftUserId || 'guest';
    const all = loadScores(userId);
    const cur = all[gameId] || { w: 0, l: 0, d: 0 };
    if (outcome === 'win') cur.w += 1;
    else if (outcome === 'loss') cur.l += 1;
    else cur.d += 1;
    saveScores(userId, { ...all, [gameId]: cur });
    window.dispatchEvent(new CustomEvent('drift:scores', { detail: { gameId } }));
  } catch {
    /* ignore */
  }
}

/** Record a numeric best (snake, 2048). Returns true if it's a new best. */
export function recordBest(gameId, value) {
  try {
    const userId = window.__driftUserId || 'guest';
    const all = loadScores(userId);
    const cur = all[gameId] || { best: 0 };
    const isBest = value > (cur.best || 0);
    if (isBest) {
      saveScores(userId, { ...all, [gameId]: { ...cur, best: value } });
      window.dispatchEvent(new CustomEvent('drift:scores', { detail: { gameId } }));
    }
    return isBest;
  } catch {
    return false;
  }
}

/** Record a klondike win (score + time). */
export function recordKlondikeWin(score, seconds) {
  try {
    const userId = window.__driftUserId || 'guest';
    const all = loadScores(userId);
    const cur = all.klondike || { wins: 0, best: 0, bestTime: 0 };
    cur.wins += 1;
    if (score > (cur.best || 0)) cur.best = score;
    if (!cur.bestTime || seconds < cur.bestTime) cur.bestTime = seconds;
    saveScores(userId, { ...all, klondike: cur });
    window.dispatchEvent(new CustomEvent('drift:scores', { detail: { gameId: 'klondike' } }));
  } catch {
    /* ignore */
  }
}

/** Record a minesweeper best time for a difficulty. Returns true if new best. */
export function recordMinesweeperTime(difficulty, seconds) {
  try {
    const userId = window.__driftUserId || 'guest';
    const all = loadScores(userId);
    const cur = all.minesweeper || {};
    const prev = cur[difficulty] || 0;
    const isBest = !prev || seconds < prev;
    if (isBest) {
      saveScores(userId, { ...all, minesweeper: { ...cur, [difficulty]: seconds } });
      window.dispatchEvent(new CustomEvent('drift:scores', { detail: { gameId: 'minesweeper' } }));
    }
    return isBest;
  } catch {
    return false;
  }
}

/** One-line summary for the arcade cards. */
export function scoreSummary(gameId, scores) {
  const s = scores?.[gameId];
  if (!s) return 'Not played yet';
  switch (gameId) {
    case 'chess':
    case 'checkers':
      return `${s.w || 0}W · ${s.l || 0}L · ${s.d || 0}D`;
    case 'klondike':
      return s.wins ? `${s.wins} win${s.wins === 1 ? '' : 's'} · best ${s.best}` : 'Not won yet';
    case 'snake':
    case 'game2048':
      return s.best ? `Best: ${s.best}` : 'Not played yet';
    case 'minesweeper': {
      const parts = [];
      if (s.beginner) parts.push(`Easy ${fmtTime(s.beginner)}`);
      if (s.intermediate) parts.push(`Med ${fmtTime(s.intermediate)}`);
      if (s.expert) parts.push(`Hard ${fmtTime(s.expert)}`);
      return parts.length ? parts.join(' · ') : 'Not won yet';
    }
    default:
      return '';
  }
}

export function fmtTime(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
