import { useEffect, useState } from 'react';
import {
  Gamepad2, Crown, Circle, Layers, Zap, Bomb, Grid3x3, Trophy, Play,
} from 'lucide-react';
import ChessGame from './games/ChessGame.jsx';
import CheckersGame from './games/CheckersGame.jsx';
import KlondikeGame from './games/KlondikeGame.jsx';
import SnakeGame from './games/SnakeGame.jsx';
import MinesweeperGame from './games/MinesweeperGame.jsx';
import Game2048 from './games/Game2048.jsx';
import { useScores, loadScores, scoreSummary } from './games/scores.js';
import { useAuth } from '../os/AuthContext.jsx';
import { useLang } from '../lib/i18n.jsx';

const GAMES = [
  {
    id: 'chess', titleKey: 'nameChess', descKey: 'descChess', icon: Crown,
    component: ChessGame, tile: 'from-amber-500/80 to-yellow-700/80',
  },
  {
    id: 'checkers', titleKey: 'nameCheckers', descKey: 'descCheckers', icon: Circle,
    component: CheckersGame, tile: 'from-red-500/80 to-rose-700/80',
  },
  {
    id: 'klondike', titleKey: 'nameKlondike', descKey: 'descKlondike', icon: Layers,
    component: KlondikeGame, tile: 'from-emerald-500/80 to-green-700/80',
  },
  {
    id: 'snake', titleKey: 'nameSnake', descKey: 'descSnake', icon: Zap,
    component: SnakeGame, tile: 'from-lime-500/80 to-green-600/80',
  },
  {
    id: 'minesweeper', titleKey: 'nameMinesweeper', descKey: 'descMinesweeper', icon: Bomb,
    component: MinesweeperGame, tile: 'from-sky-500/80 to-blue-700/80',
  },
  {
    id: 'game2048', titleKey: null, descKey: 'desc2048', icon: Grid3x3,
    component: Game2048, tile: 'from-orange-500/80 to-amber-700/80',
  },
];

// Display title for a game entry (2048 keeps its numeric name in every language).
export function gameTitle(t, g) {
  return g.titleKey ? t('games.' + g.titleKey) : '2048';
}

export default function ArcadeApp({ windowApi }) {
  const { user } = useAuth();
  const { t } = useLang();
  const userId = user?.id || 'guest';
  const [scores, setScores] = useState(() => loadScores(userId));
  const [activeId, setActiveId] = useState(null);

  useEffect(() => {
    windowApi?.setTitle?.(t('games.arcade'));
  }, [windowApi, t]);

  // Keep the arcade card shelf fresh when a game records a score.
  useEffect(() => {
    window.__driftUserId = userId;
    setScores(loadScores(userId));
    const h = () => setScores(loadScores(window.__driftUserId));
    window.addEventListener('drift:scores', h);
    return () => window.removeEventListener('drift:scores', h);
  }, [userId]);

  const active = GAMES.find((g) => g.id === activeId);
  if (active) {
    const Game = active.component;
    return (
      <div className="flex h-full flex-col bg-paper text-ink">
        <div className="min-h-0 flex-1">
          <Game onExit={() => setActiveId(null)} />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-paper text-ink">
      <div className="border-b border-osborder bg-gradient-to-r from-indigo-600/90 via-purple-600/90 to-fuchsia-600/90 px-6 py-6 text-white">
        <div className="flex items-center gap-3">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-white/20 backdrop-blur">
            <Gamepad2 size={26} />
          </span>
          <div>
            <h1 className="text-xl font-bold tracking-tight">{t('games.arcade')}</h1>
            <p className="text-sm text-white/80">{t('games.pickGame')}</p>
          </div>
        </div>
      </div>
      <div className="grid flex-1 grid-cols-1 content-start gap-4 overflow-y-auto p-6 sm:grid-cols-2 lg:grid-cols-3">
        {GAMES.map((g) => {
          const Icon = g.icon;
          const title = gameTitle(t, g);
          const summary = scoreSummary(g.id, scores, t);
          return (
            <button
              key={g.id}
              type="button"
              onClick={() => setActiveId(g.id)}
              aria-label={t('games.playAria', { game: title, summary })}
              className="group flex min-h-[44px] flex-col gap-3 rounded-os border border-osborder bg-surface p-4 text-left shadow-os transition-transform hover:-translate-y-0.5 hover:border-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              <div className="flex items-center gap-3">
                <span className={`flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br text-white shadow ${g.tile}`}>
                  <Icon size={28} />
                </span>
                <div className="min-w-0">
                  <h2 className="text-base font-bold text-ink">{title}</h2>
                  <p className="flex items-center gap-1 text-xs text-muted">
                    <Trophy size={12} className="text-accent" />
                    {summary}
                  </p>
                </div>
                <span className="ml-auto flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent/15 text-accent transition-colors group-hover:bg-accent group-hover:text-white">
                  <Play size={16} />
                </span>
              </div>
              <p className="text-sm leading-snug text-muted">{t('games.' + g.descKey)}</p>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// Re-export for the test harness / deep links
export { GAMES };
export function useArcadeScores() {
  const { user } = useAuth();
  return useScores(user?.id);
}
