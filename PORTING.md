# Porting map: StarOS originals → Drift

Build 1 (staros-classic) is the library; builds 3/4 (Drift) are the borrowers.
An original ports only after its source file is extracted AND verified
(screenshot ground truth, gutter-count matched, esbuild-parsed). Ports adapt
to Drift's paper-and-ink design, the backend contract (`CONTRACTS.md`), and
the app registry — they are never blind copy-pastes.

## Games → Drift GamesArcade

Drift's registry currently lists chess/checkers/klondike as non-clickable
"coming soon" tiles. Each flips to a real game when its original lands.

| Original file | Drift target | Status |
|---|---|---|
| src/apps/games/Chess.jsx | GamesArcade (chess) | awaiting extraction |
| src/apps/games/Checkers.jsx | GamesArcade (checkers) | awaiting extraction |
| src/apps/games/Tetris.jsx | GamesArcade | awaiting extraction |
| src/apps/games/Snake.jsx | GamesArcade | awaiting extraction |
| src/apps/games/Minesweeper.jsx | GamesArcade | awaiting extraction |
| src/apps/games/Solitaire.jsx | GamesArcade (klondike) | awaiting extraction |
| src/apps/games/Breakout.jsx | GamesArcade | awaiting extraction |
| src/apps/games/Pong.jsx | GamesArcade | awaiting extraction |
| src/apps/games/Flappy.jsx | GamesArcade | awaiting extraction |
| src/apps/games/Game2048.jsx | GamesArcade | awaiting extraction |
| src/apps/games/Memory.jsx | GamesArcade | awaiting extraction |
| src/apps/games/TicTacToe.jsx | GamesArcade | awaiting extraction |
| src/apps/games/SpaceShooter3D.jsx | GamesArcade | awaiting extraction |

High scores persist via `backend.highscores` (already live in local + supabase).

## Tools → Drift apps

| Original file | Drift target | Status |
|---|---|---|
| src/apps/Terminal.jsx | HelmApp tool patterns | original's commands inform Helm's local toolset; awaiting extraction |
| src/apps/Calculator.jsx | — | small; rebuild natively if wanted (not scheduled) |
| src/apps/aol/AolBrowser.jsx | — | AOL stays in builds 1 & 2 only — NOT ported |

## Rules

1. Extracted source is read-only reference. Port = rewrite against the Drift
   contract, keeping behavior and feel, not JSX internals.
2. Every ported game/app must pass `npm run build` and a play-through check
   (real interaction, no simulated moves) before its tile goes live.
3. Update this file's Status column as extractions land and ports ship.
