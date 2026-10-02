/**
 * duskfall-egg.test.mjs — proof the hidden game is real, original, and
 * completable. Runs in plain Node (the engine is DOM-free):
 *
 *  1. Deterministic bot play-through: BFS navigation with door/key
 *     logic + combat, from Sector 1 start to the final SURFACED win.
 *  2. Level validity (borders sealed, one start/exit, all objectives
 *     reachable — engine's own reachableCells flood fill).
 *  3. Konami matcher unit checks (sequence, wrong key, overlap, timeout).
 *  4. Original-IP scan: no id Software name/assets referenced anywhere
 *     in the game surface.
 *
 * Run: node tests/duskfall-egg.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Game, LEVELS, reachableCells, renderFrame } from '../src/apps/games/duskfall/engine.js';
import { createKonamiMatcher, KONAMI_SEQUENCE } from '../src/lib/easterEgg.js';

/**
 * Write a 24-bit BMP from an RGBA buffer — zero dependencies, so the
 * play-through can leave real renderer frames on disk as evidence.
 */
function writeBMP(rgba, w, h, outPath) {
  const rowSize = Math.ceil((w * 3) / 4) * 4;
  const px = Buffer.alloc(rowSize * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const si = (y * w + x) * 4;
      const di = (h - 1 - y) * rowSize + x * 3;
      px[di] = rgba[si + 2]; px[di + 1] = rgba[si + 1]; px[di + 2] = rgba[si];
    }
  }
  const head = Buffer.alloc(54);
  head.write('BM'); head.writeUInt32LE(54 + px.length, 2);
  head.writeUInt32LE(54, 10); head.writeUInt32LE(40, 14);
  head.writeInt32LE(w, 18); head.writeInt32LE(h, 22);
  head.writeUInt16LE(1, 26); head.writeUInt16LE(24, 28);
  fs.writeFileSync(outPath, Buffer.concat([head, px]));
}

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const EVIDENCE = path.join(ROOT, 'tests', 'evidence');
fs.mkdirSync(EVIDENCE, { recursive: true });
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('PASS', name); }
  else { fail++; console.log('FAIL', name, extra); }
};

// ---------------------------------------------------------------
let passCount = () => pass;

// Tile codes mirror engine.js's internal T table (not exported).
const T_WALL = [1, 2, 3], T_DOOR_R = 5, T_DOOR_B = 6, T_EXIT = 7;

function passable(g, x, y) {
  const t = g.tileAt(x, y);
  if (T_WALL.includes(t)) return false;
  if (t === T_DOOR_R) return g.keys.red;
  if (t === T_DOOR_B) return g.keys.blue;
  return true;
}

function bfsPath(g, tx, ty) {
  const sx = Math.floor(g.px), sy = Math.floor(g.py);
  const key = (x, y) => y * g.gw + x;
  const prev = new Map([[key(sx, sy), null]]);
  const q = [[sx, sy]];
  while (q.length) {
    const [x, y] = q.shift();
    if (x === tx && y === ty) {
      const pathCells = [];
      let k = key(x, y), cx = x, cy = y;
      while (k !== null && k !== undefined) {
        pathCells.push([cx, cy]);
        const p = prev.get(k);
        if (!p) break;
        [cx, cy] = p;
        k = key(cx, cy);
      }
      return pathCells.reverse();
    }
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= g.gw || ny >= g.gh) continue;
      const k = key(nx, ny);
      if (prev.has(k) || !passable(g, nx, ny)) continue;
      prev.set(k, [x, y]);
      q.push([nx, ny]);
    }
  }
  return null;
}

const blankInput = () => ({
  fwd: false, back: false, strafeL: false, strafeR: false,
  turnL: false, turnR: false, run: false, fire: false,
  use: false, weapon1: false, weapon2: false,
});

function playThrough() {
  const g = new Game();
  const DT = 1 / 60;
  const MAX_STEPS = 60 * 1200; // 20 minutes of game time, hard cap
  let steps = 0, clears = 0, stuckFrames = 0, lastX = g.px, lastY = g.py, sidestep = 0;
  let lastDoorKey = null; // rising edge: tap use once per door, then wait for it to slide
  const frameBuf = new Uint8ClampedArray(240 * 135 * 4);

  while (steps < MAX_STEPS) {
    g.events.splice(0);
    if (g.state === 'win') break;
    if (g.state === 'dead') return { won: false, why: `died on level ${g.levelIndex + 1} hp=0 kills=${g.kills}`, steps };
    if (g.state === 'clear') {
      clears++;
      renderFrame(g, frameBuf, 240, 135);
      writeBMP(frameBuf, 240, 135, path.join(EVIDENCE, `duskfall-bot-clear-l${clears}.bmp`));
      g.nextLevel();
      continue;
    }

    const inp = blankInput();

    // combat: nearest visible enemy gets faced and shot
    let foe = null, foeD = Infinity;
    for (const e of g.enemies) {
      if (e.state === 'dying') continue;
      const d = Math.hypot(e.x - g.px, e.y - g.py);
      if (d < foeD && d < 8 && g.hasLOS(g.px, g.py, e.x, e.y)) { foe = e; foeD = d; }
    }

    let route = null;
    if (foe && foeD < 6.5) {
      g.angle = Math.atan2(foe.y - g.py, foe.x - g.px);
      inp.fire = true;
    } else {
      route = bfsPath(g, g.exit.x, g.exit.y);
      if (!route) {
        // fetch whichever keycard we lack and can reach
        for (const kind of ['keyR', 'keyB']) {
          const p = g.pickups.find((pk) => pk.kind === kind && !pk.taken);
          if (p) { route = bfsPath(g, Math.floor(p.x), Math.floor(p.y)); if (route) break; }
        }
      }
      if (!route && g.hp < 70) {
        const m = g.pickups.find((pk) => pk.kind === 'medkit' && !pk.taken);
        if (m) route = bfsPath(g, Math.floor(m.x), Math.floor(m.y));
      }
      if (!route) return { won: false, why: `no route on level ${g.levelIndex + 1} at ${g.px.toFixed(1)},${g.py.toFixed(1)}`, steps };
    }

    if (route && route.length > 1) {
      const [wx, wy] = route[1];
      const cx = wx + 0.5, cy = wy + 0.5;
      const dx = cx - g.px, dy = cy - g.py;
      const dist = Math.hypot(dx, dy);
      const door = g.doorAt(wx, wy);
      g.angle = Math.atan2(dy, dx);
      if (door && g.solidAt(wx, wy)) {
        // face the door and TAP use once (tryUse toggles open/close —
        // holding it would flip the door forever), then wait.
        const dk = wx + ',' + wy;
        if (dk !== lastDoorKey && dist < 1.8) { inp.use = true; lastDoorKey = dk; }
        inp.run = false;
      } else {
        lastDoorKey = null;
        if (dist > 0.12) {
          inp.fwd = true; inp.run = true;
          if (sidestep > 0) { inp.strafeR = true; sidestep--; }
        }
      }
    }

    g.update(DT, inp);
    steps++;

    // renderer must survive the whole run; capture real frames as evidence
    if (steps % 900 === 0) renderFrame(g, frameBuf, 240, 135);
    if (g.levelIndex === 0 && steps === 3600) {
      renderFrame(g, frameBuf, 240, 135);
      writeBMP(frameBuf, 240, 135, path.join(EVIDENCE, 'duskfall-bot-l1-midgame.bmp'));
    }

    // stuck detection → brief sidestep
    if (steps % 30 === 0) {
      if (Math.hypot(g.px - lastX, g.py - lastY) < 0.02 && !foe) {
        stuckFrames += 30;
        if (stuckFrames >= 90) { sidestep = 25; stuckFrames = 0; }
      } else stuckFrames = 0;
      lastX = g.px; lastY = g.py;
    }
  }
  return {
    won: g.state === 'win',
    why: g.state === 'win' ? '' : `state=${g.state} after ${steps} steps`,
    steps, clears, score: g.score, kills: g.kills, hp: Math.round(g.hp), game: g,
  };
}

console.log('--- deterministic bot play-through (Sector 1 → SURFACED) ---');
const result = playThrough();
console.log(`    bot: steps=${result.steps} (${(result.steps / 60).toFixed(0)}s game time) clears=${result.clears} score=${result.score} kills=${result.kills} hp=${result.hp}`);
ok('bot completes all 3 sectors and wins', result.won, result.why);
ok('bot cleared exactly 2 sector transitions', result.clears === 2, `clears=${result.clears}`);
ok('bot scored kills (combat works)', result.kills > 0, `kills=${result.kills}`);
if (result.won) {
  const g = result.game;
  const winBuf = new Uint8ClampedArray(240 * 135 * 4);
  renderFrame(g, winBuf, 240, 135);
  writeBMP(winBuf, 240, 135, path.join(EVIDENCE, 'duskfall-bot-win.bmp'));
  console.log('    frames → tests/evidence/duskfall-bot-*.bmp');
}

// ---------------------------------------------------------------
console.log('--- level validity ---');
LEVELS.forEach((L, li) => {
  const w = L.map[0].length;
  ok(`L${li + 1} rows equal length`, L.map.every((r) => r.length === w));
  ok(`L${li + 1} border sealed`, L.map.every((r, y) => (y === 0 || y === L.map.length - 1 ? /^[#%O]+$/.test(r) : r[0] === '#' && r[r.length - 1] === '#')));
  const flat = L.map.join('');
  ok(`L${li + 1} one start + one exit`, (flat.match(/P/g) || []).length === 1 && (flat.match(/E/g) || []).length === 1);
  const g = new Game(); g.loadLevel(li, true);
  const seen = reachableCells(g);
  const missing = [];
  L.map.forEach((row, y) => [...row].forEach((c, x) => {
    if ('EHS12+Arb'.includes(c) && !seen[y * g.gw + x]) missing.push(`${c}@${x},${y}`);
  }));
  ok(`L${li + 1} every enemy/pickup/key/exit reachable`, missing.length === 0, missing.join(' '));
});

// ---------------------------------------------------------------
console.log('--- Konami matcher ---');
{
  const m = createKonamiMatcher();
  let firedAt = -1;
  KONAMI_SEQUENCE.forEach((code, i) => { if (m.feed(code, i * 100)) firedAt = i; });
  ok('full sequence fires on final key', firedAt === KONAMI_SEQUENCE.length - 1, `firedAt=${firedAt}`);

  const m2 = createKonamiMatcher();
  const wrong = [...KONAMI_SEQUENCE.slice(0, 5), 'KeyX', ...KONAMI_SEQUENCE.slice(5)];
  ok('wrong key breaks the sequence', !wrong.some((c, i) => m2.feed(c, i * 100)));

  const m3 = createKonamiMatcher();
  let ok3 = false;
  ['ArrowUp', 'ArrowUp', 'ArrowUp', ...KONAMI_SEQUENCE.slice(2)].forEach((c, i) => { if (m3.feed(c, i * 100)) ok3 = true; });
  ok('overlapping prefix still completes', ok3);

  const m4 = createKonamiMatcher(1000);
  m4.feed('ArrowUp', 0); m4.feed('ArrowUp', 100);
  let late = false;
  KONAMI_SEQUENCE.slice(2).forEach((c, i) => { if (m4.feed(c, 5000 + i * 100)) late = true; });
  ok('long pause resets progress', !late && m4.progress < KONAMI_SEQUENCE.length);
}

// ---------------------------------------------------------------
console.log('--- original IP scan ---');
{
  const files = [
    'src/apps/games/DuskfallGame.jsx',
    'src/apps/games/duskfall/engine.js',
    'src/lib/easterEgg.js',
    'src/components/os/EasterEgg.jsx',
  ];
  for (const f of files) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    ok(`${f}: no id Software IP referenced`, !/doom|id software|idsoftware/i.test(src));
  }
  ok('game title is the original DUSKFALL', /DUSKFALL/.test(fs.readFileSync(path.join(ROOT, 'src/apps/games/DuskfallGame.jsx'), 'utf8')));
}

console.log(`--- ${pass} passed, ${fail} failed ---`);
process.exit(fail ? 1 : 0);
