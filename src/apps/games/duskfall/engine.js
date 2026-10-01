/**
 * DUSKFALL — an original first-person corridor crawler in the DOOM-like
 * raycaster tradition. Every texture, sprite, map, sound and name here is
 * generated in code for this project; nothing is taken from any existing
 * game. The engine below is 100% DOM-free so it can be unit-tested in Node:
 * rendering writes into a caller-supplied Uint8ClampedArray pixel buffer.
 */

// ---------------------------------------------------------------- textures

/** Deterministic PRNG so generated art is stable across runs. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** RGBA pixel buffer helpers. Pixels are [r,g,b,a] rows. */
export function makeBuf(w, h) {
  return { w, h, data: new Uint8ClampedArray(w * h * 4) };
}
export function setPx(buf, x, y, r, g, b, a = 255) {
  if (x < 0 || y < 0 || x >= buf.w || y >= buf.h) return;
  const i = (y * buf.w + x) * 4;
  buf.data[i] = r; buf.data[i + 1] = g; buf.data[i + 2] = b; buf.data[i + 3] = a;
}
export function fillRect(buf, x, y, w, h, r, g, b, a = 255) {
  for (let j = y; j < y + h; j++)
    for (let i = x; i < x + w; i++) setPx(buf, i, j, r, g, b, a);
}
function ellipse(buf, cx, cy, rx, ry, r, g, b, a = 255) {
  for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++)
    for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
      const dx = (x - cx) / rx, dy = (y - cy) / ry;
      if (dx * dx + dy * dy <= 1) setPx(buf, x, y, r, g, b, a);
    }
}
const vary = (rnd, base, amt) => Math.max(0, Math.min(255, base + ((rnd() * 2 - 1) * amt) | 0));

function genWallBrick() {
  const b = makeBuf(64, 64), rnd = mulberry32(11);
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
    const row = (y / 8) | 0, off = row % 2 ? 8 : 0;
    const mortar = y % 8 === 7 || (x + off) % 16 === 15;
    const v = mortar ? [38, 24, 22] : [vary(rnd, 104, 14), vary(rnd, 46, 10), vary(rnd, 36, 8)];
    setPx(b, x, y, v[0], v[1], v[2]);
  }
  return b;
}
function genWallTech() {
  const b = makeBuf(64, 64), rnd = mulberry32(22);
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
    let v = [vary(rnd, 56, 8), vary(rnd, 68, 8), vary(rnd, 62, 8)];
    if (y % 16 === 15) v = [30, 36, 34];
    if (y % 16 === 0) v = [80, 94, 88];
    if ((x < 3 || x > 60) && y % 8 < 4) v = [36, 42, 40];
    setPx(b, x, y, v[0], v[1], v[2]);
  }
  // rivets
  for (const [x, y] of [[6, 6], [57, 6], [6, 57], [57, 57], [32, 32]])
    ellipse(b, x, y, 2, 2, 120, 130, 124);
  return b;
}
function genWallStone() {
  const b = makeBuf(64, 64), rnd = mulberry32(33);
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
    const row = (y / 16) | 0, off = row % 2 ? 16 : 0;
    const mortar = y % 16 === 15 || (x + off) % 32 === 31;
    const v = mortar ? [40, 40, 44] : [vary(rnd, 92, 12), vary(rnd, 92, 12), vary(rnd, 98, 12)];
    setPx(b, x, y, v[0], v[1], v[2]);
  }
  return b;
}
function genDoorBase(tint) {
  const b = makeBuf(64, 64), rnd = mulberry32(44);
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
    let v = [vary(rnd, 74, 8), vary(rnd, 78, 8), vary(rnd, 84, 8)];
    if (x === 31 || x === 32) v = [28, 30, 34];           // center seam
    if (y % 21 === 20) v = [46, 50, 56];                  // slats
    if (y > 52) v = ((x + y) % 12 < 6) ? [150, 120, 30] : [40, 40, 44]; // hazard stripe
    if (tint) { v = [Math.min(255, v[0] + tint[0]), Math.min(255, v[1] + tint[1]), Math.min(255, v[2] + tint[2])]; }
    setPx(b, x, y, v[0], v[1], v[2]);
  }
  // frame
  fillRect(b, 0, 0, 3, 64, 24, 26, 30); fillRect(b, 61, 0, 3, 64, 24, 26, 30);
  return b;
}
function genExit() {
  const b = makeBuf(64, 64), rnd = mulberry32(55);
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
    const glow = Math.max(0, 1 - Math.abs(y - 32) / 26) * Math.max(0, 1 - Math.abs(x - 32) / 30);
    const flicker = 0.85 + rnd() * 0.15;
    const g = (40 + glow * 180 * flicker) | 0;
    setPx(b, x, y, (g * 0.25) | 0, Math.min(255, g), (g * 0.3) | 0);
  }
  fillRect(b, 8, 6, 48, 4, 120, 255, 150); fillRect(b, 8, 54, 48, 4, 120, 255, 150);
  return b;
}

export const TEX = {
  wall0: genWallBrick(),
  wall1: genWallTech(),
  wall2: genWallStone(),
  door: genDoorBase(null),
  doorR: genDoorBase([90, -10, -10]),
  doorB: genDoorBase([-10, -10, 90]),
  exit: genExit(),
};

// ------------------------------------------------------------------ sprites
// All sprites are original pixel art drawn in code. Transparent = alpha 0.

function blankSprite(w, h) {
  const b = makeBuf(w, h);
  b.data.fill(0);
  return b;
}

function genHusk(frame) {
  const s = blankSprite(48, 56), rnd = mulberry32(101 + frame);
  const bob = frame ? 2 : 0;
  ellipse(s, 24, 30 + bob, 15, 20, 122, 72, 42);          // body
  ellipse(s, 24, 28 + bob, 12, 16, 140, 86, 52);          // torso highlight
  ellipse(s, 24, 14 + bob, 10, 9, 122, 72, 42);           // head
  // glowing eyes
  fillRect(s, 17, 11 + bob, 5, 4, 255, 140, 30);
  fillRect(s, 26, 11 + bob, 5, 4, 255, 140, 30);
  if (frame) fillRect(s, 20, 18 + bob, 8, 4, 60, 20, 14); // open jaw
  else fillRect(s, 21, 19 + bob, 6, 2, 60, 20, 14);
  // arms
  fillRect(s, 6, 26 + bob, 6, 18, 110, 64, 38);
  fillRect(s, 36, 26 + (frame ? 0 : bob), 6, 18, 110, 64, 38);
  // claws
  for (let i = 0; i < 3; i++) {
    setPx(s, 7 + i * 2, 44 + bob, 220, 220, 210);
    setPx(s, 37 + i * 2, 44 + (frame ? 0 : bob), 220, 220, 210);
  }
  void rnd;
  return s;
}

function genSpitter(frame) {
  const s = blankSprite(48, 56), rnd = mulberry32(202 + frame);
  ellipse(s, 24, 32, 16, 18, 58, 138, 66);               // body
  ellipse(s, 24, 30, 12, 14, 74, 160, 80);
  ellipse(s, 24, 14, 11, 10, 58, 138, 66);               // head
  fillRect(s, 16, 11, 6, 5, 255, 230, 60);               // eyes
  fillRect(s, 26, 11, 6, 5, 255, 230, 60);
  // maw — wider on attack frame
  const mh = frame ? 10 : 5;
  ellipse(s, 24, 24, 7, mh, 30, 12, 14);
  ellipse(s, 24, 24, 4, Math.max(2, mh - 3), 200, 60, 60);
  // spikes
  for (let i = 0; i < 5; i++) {
    const x = 10 + i * 7;
    fillRect(s, x, 40 + (i % 2), 3, 8 - (i % 2) * 3, 40, 100, 48);
  }
  void rnd;
  return s;
}

function genPickup(kind) {
  const s = blankSprite(32, 32);
  if (kind === 'bullets') {
    fillRect(s, 6, 12, 20, 14, 60, 52, 40);
    for (let i = 0; i < 4; i++) fillRect(s, 8 + i * 5, 6, 3, 8, 200, 160, 80);
    fillRect(s, 6, 12, 20, 3, 90, 78, 60);
  } else if (kind === 'shells') {
    fillRect(s, 6, 12, 20, 14, 120, 30, 26);
    for (let i = 0; i < 4; i++) { fillRect(s, 8 + i * 5, 6, 3, 8, 180, 40, 36); fillRect(s, 8 + i * 5, 6, 3, 2, 220, 200, 120); }
    fillRect(s, 6, 12, 20, 3, 150, 50, 44);
  } else if (kind === 'medkit') {
    fillRect(s, 5, 10, 22, 16, 225, 225, 220);
    fillRect(s, 13, 12, 6, 12, 200, 40, 40);
    fillRect(s, 9, 15, 14, 6, 200, 40, 40);
    fillRect(s, 5, 10, 22, 3, 180, 180, 175);
  } else if (kind === 'armor') {
    for (let y = 0; y < 24; y++) {
      const wdt = 12 - Math.abs(y - 12);
      fillRect(s, 16 - wdt / 2, 4 + y, wdt, 1, 70, 140, 230);
    }
    fillRect(s, 14, 8, 4, 12, 150, 210, 255);
  } else if (kind === 'keyR' || kind === 'keyB') {
    const c = kind === 'keyR' ? [230, 60, 60] : [70, 130, 235];
    ellipse(s, 11, 11, 6, 6, c[0], c[1], c[2]);
    ellipse(s, 11, 11, 3, 3, 20, 20, 24);
    fillRect(s, 15, 9, 12, 4, c[0], c[1], c[2]);
    fillRect(s, 22, 13, 3, 4, c[0], c[1], c[2]);
    fillRect(s, 26, 13, 3, 6, c[0], c[1], c[2]);
  }
  return s;
}

function genPistol(flash) {
  const s = blankSprite(96, 72);
  if (flash) {
    const rnd = mulberry32(7);
    for (let i = 0; i < 46; i++) {
      const a = rnd() * Math.PI * 2, r = 6 + rnd() * 22;
      const x = 48 + Math.cos(a) * r, y = 14 + Math.sin(a) * r * 0.7;
      setPx(s, x | 0, y | 0, 255, 200 - ((rnd() * 90) | 0), 60);
      setPx(s, (x + 1) | 0, y | 0, 255, 170, 40);
    }
    ellipse(s, 48, 14, 7, 6, 255, 240, 180);
  }
  fillRect(s, 40, 18, 16, 26, 52, 54, 60);      // slide
  fillRect(s, 40, 18, 16, 4, 90, 94, 102);       // slide top
  fillRect(s, 44, 44, 10, 22, 96, 62, 38);       // grip
  fillRect(s, 44, 44, 10, 3, 60, 38, 24);
  fillRect(s, 52, 30, 10, 5, 40, 42, 48);        // trigger guard
  return s;
}

function genShotgun(flash) {
  const s = blankSprite(128, 72);
  if (flash) {
    const rnd = mulberry32(9);
    for (let i = 0; i < 70; i++) {
      const a = rnd() * Math.PI * 2, r = 8 + rnd() * 30;
      const x = 64 + Math.cos(a) * r, y = 12 + Math.sin(a) * r * 0.7;
      setPx(s, x | 0, y | 0, 255, 190 - ((rnd() * 80) | 0), 50);
    }
    ellipse(s, 64, 12, 10, 8, 255, 235, 170);
  }
  fillRect(s, 56, 16, 16, 30, 58, 60, 66);       // barrel
  fillRect(s, 56, 16, 16, 5, 96, 100, 108);
  fillRect(s, 58, 46, 12, 20, 110, 72, 44);       // pump + stock
  fillRect(s, 44, 50, 14, 16, 96, 62, 38);
  return s;
}

export const SPR = {
  husk: [genHusk(0), genHusk(1)],
  spitter: [genSpitter(0), genSpitter(1)],
  pickups: {
    bullets: genPickup('bullets'), shells: genPickup('shells'),
    medkit: genPickup('medkit'), armor: genPickup('armor'),
    keyR: genPickup('keyR'), keyB: genPickup('keyB'),
  },
  pistol: [genPistol(false), genPistol(true)],
  shotgun: [genShotgun(false), genShotgun(true)],
};

// ------------------------------------------------------------------- levels
// Legend: # % O walls | D door | R/B keyed doors | E exit | P player
//         H husk | S spitter | r/b keycards
//         1 bullets | 2 shells | + medkit | A armor | (space) empty

export const LEVELS = [
  {
    name: 'Intake',
    map: [
      '###############',
      '#P   #        #',
      '#    #    1   #',
      '# H  D        #',
      '#    #    +   #',
      '#    #        #',
      '#    #        #',
      '#  1 #        #',
      '#    #    E   #',
      '#    #        #',
      '#    #        #',
      '#    #        #',
      '#    #        #',
      '#    #        #',
      '###############',
    ],
  },
  {
    name: 'Crossflow',
    map: [
      '####################',
      '#P  2 #     # r    #',
      '#     #     #      #',
      '#  H  D  S  D   H  #',
      '#     #     #      #',
      '#  1  #  +  #  A   #',
      '#     #     #      #',
      '#########R##########',
      '#     #     #      #',
      '#  H  #  S  #  H   #',
      '#     #     #      #',
      '#  +  D  1  D   2  #',
      '#     #     #      #',
      '#     #  E  #      #',
      '####################',
    ],
  },
  {
    name: 'The Deep',
    map: [
      '####################',
      '#P    #     #      #',
      '#  H  #  S  #  b   #',
      '#     D     D      #',
      '#  2  #     #  1   #',
      '#     #     #      #',
      '#########B##########',
      '#     #     #      #',
      '#  H  #  H  #  S   #',
      '#     D     D      #',
      '#  +  #  A  #  2   #',
      '#     #     #      #',
      '#  S  #     #  H   #',
      '#     #  E  #      #',
      '####################',
    ],
  },
];

// ------------------------------------------------------------------ game state

const T = { EMPTY: 0, W0: 1, W1: 2, W2: 3, DOOR: 4, DOOR_R: 5, DOOR_B: 6, EXIT: 7 };
const FOV = (66 * Math.PI) / 180;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const normAng = (a) => { while (a > Math.PI) a -= Math.PI * 2; while (a < -Math.PI) a += Math.PI * 2; return a; };

const ENEMY_DEFS = {
  husk:    { hp: 40, speed: 2.1, radius: 0.3, score: 50,  melee: true },
  spitter: { hp: 65, speed: 1.6, radius: 0.3, score: 100, melee: false },
};
const WEAPONS = {
  pistol:  { cooldown: 0.3,  pellets: 1, dmg: [14, 24], spread: 0.025, ammo: 'bullets' },
  shotgun: { cooldown: 0.95, pellets: 6, dmg: [7, 13],  spread: 0.11,  ammo: 'shells' },
};

export class Game {
  constructor() {
    this.rnd = mulberry32(1234567);
    this.events = [];
    this.fov = FOV;
    this.time = 0;
    this.score = 0;
    this.kills = 0;
    this.levelIndex = 0;
    this.state = 'playing'; // playing | clear | dead | win
    this.message = ''; this.messageT = 0;
    this.loadLevel(0, true);
  }

  loadLevel(idx, fresh) {
    const L = LEVELS[idx];
    this.levelIndex = idx;
    this.gh = L.map.length; this.gw = L.map[0].length;
    this.grid = new Uint8Array(this.gw * this.gh);
    this.doors = new Map();
    this.enemies = []; this.pickups = [];
    this.state = 'playing';
    for (let y = 0; y < this.gh; y++) {
      const row = L.map[y];
      for (let x = 0; x < this.gw; x++) {
        const c = row[x]; let t = T.EMPTY;
        if (c === '#') t = T.W0; else if (c === '%') t = T.W1; else if (c === 'O') t = T.W2;
        else if (c === 'D') t = T.DOOR; else if (c === 'R') t = T.DOOR_R; else if (c === 'B') t = T.DOOR_B;
        else if (c === 'E') { t = T.EXIT; this.exit = { x, y }; }
        else if (c === 'P') { this.px = x + 0.5; this.py = y + 0.5; this.angle = 0; }
        else if (c === 'H' || c === 'S') {
          const type = c === 'H' ? 'husk' : 'spitter';
          this.enemies.push({ x: x + 0.5, y: y + 0.5, type, hp: ENEMY_DEFS[type].hp, state: 'chase', cool: 0.5 + this.rnd(), windup: 0, painT: 0, flashT: 0, deathT: 0, animT: this.rnd() * 2, attackT: 0 });
        } else if ('12+Arb'.includes(c)) {
          const kind = { 1: 'bullets', 2: 'shells', '+': 'medkit', A: 'armor', r: 'keyR', b: 'keyB' }[c];
          this.pickups.push({ x: x + 0.5, y: y + 0.5, kind, taken: false, bob: this.rnd() * 6 });
        }
        this.grid[y * this.gw + x] = t;
        if (t === T.DOOR || t === T.DOOR_R || t === T.DOOR_B)
          this.doors.set(x + ',' + y, { x, y, type: t, openT: 0, target: 0 });
      }
    }
    if (fresh) {
      this.hp = 100; this.armor = 0; this.weapon = 'pistol';
      this.bullets = 50; this.shells = 0;
      this.keys = { red: false, blue: false };
      this.score = 0; this.kills = 0;
    } else {
      // carry a little mercy between levels
      this.bullets = Math.max(this.bullets, 20);
    }
    this.fireCd = 0; this.flashT = 0; this.hurtT = 0; this.bobT = 0;
    this.say(idx === 0 && fresh ? 'Find the exit. Press E to open doors.' : 'Level ' + (idx + 1) + ': ' + L.name);
  }

  nextLevel() { this.loadLevel(this.levelIndex + 1, false); }
  get levelName() { return LEVELS[this.levelIndex].name; }

  say(text) { this.message = text; this.messageT = 2.6; }
  emit(type, data) { this.events.push({ type, ...(data || {}) }); }

  tileAt(tx, ty) {
    if (tx < 0 || ty < 0 || tx >= this.gw || ty >= this.gh) return T.W0;
    return this.grid[ty * this.gw + tx];
  }
  doorAt(tx, ty) { return this.doors.get(tx + ',' + ty) || null; }
  solidAt(tx, ty) {
    const t = this.tileAt(tx, ty);
    if (t >= T.W0 && t <= T.W2) return true;
    if (t === T.DOOR || t === T.DOOR_R || t === T.DOOR_B) {
      const d = this.doorAt(tx, ty);
      return !d || d.openT < 0.7;
    }
    return false;
  }
  circleHit(x, y, r) {
    const x0 = Math.floor(x - r), x1 = Math.floor(x + r);
    const y0 = Math.floor(y - r), y1 = Math.floor(y + r);
    for (let ty = y0; ty <= y1; ty++)
      for (let tx = x0; tx <= x1; tx++) if (this.solidAt(tx, ty)) return true;
    return false;
  }

  /** DDA raycast. Returns { dist (perpendicular), side, tile, wallX 0..1, door, mapX, mapY }. */
  cast(ox, oy, dx, dy, maxDist) {
    let mapX = Math.floor(ox), mapY = Math.floor(oy);
    const dDX = Math.abs(dx) < 1e-9 ? 1e9 : Math.abs(1 / dx);
    const dDY = Math.abs(dy) < 1e-9 ? 1e-9 + 1e9 : Math.abs(1 / dy);
    let stepX, stepY, sDX, sDY;
    if (dx < 0) { stepX = -1; sDX = (ox - mapX) * dDX; } else { stepX = 1; sDX = (mapX + 1 - ox) * dDX; }
    if (dy < 0) { stepY = -1; sDY = (oy - mapY) * dDY; } else { stepY = 1; sDY = (mapY + 1 - oy) * dDY; }
    let side = 0, dist = 0;
    for (let i = 0; i < 64; i++) {
      if (sDX < sDY) { dist = sDX; sDX += dDX; mapX += stepX; side = 0; }
      else { dist = sDY; sDY += dDY; mapY += stepY; side = 1; }
      if (dist > maxDist) break;
      const t = this.tileAt(mapX, mapY);
      if (t >= T.W0 && t <= T.W2) break;
      if (t === T.EXIT) break;
      if (t === T.DOOR || t === T.DOOR_R || t === T.DOOR_B) {
        const d = this.doorAt(mapX, mapY);
        if (!d || d.openT < 0.8) break; // closed door stops the ray
      }
    }
    // perpendicular distance (fisheye-free)
    const perp = side === 0 ? sDX - dDX : sDY - dDY;
    let wallX = side === 0 ? oy + perp * dy : ox + perp * dx;
    wallX -= Math.floor(wallX);
    const t = this.tileAt(mapX, mapY);
    const door = (t === T.DOOR || t === T.DOOR_R || t === T.DOOR_B) ? this.doorAt(mapX, mapY) : null;
    return { dist: Math.min(perp, maxDist), side, tile: t, wallX, door, mapX, mapY };
  }

  hasLOS(x0, y0, x1, y1) {
    const dx = x1 - x0, dy = y1 - y0;
    const d = Math.hypot(dx, dy);
    if (d < 1e-6) return true;
    const hit = this.cast(x0, y0, dx / d, dy / d, d);
    return hit.dist >= d - 0.35;
  }

  // ------------------------------------------------------------------ actions

  tryUse() {
    const dx = Math.cos(this.angle), dy = Math.sin(this.angle);
    const hit = this.cast(this.px, this.py, dx, dy, 1.7);
    if (!hit.door) return;
    const d = hit.door;
    if (d.type === T.DOOR_R && !this.keys.red) { this.say('Need the RED keycard.'); this.emit('denied'); return; }
    if (d.type === T.DOOR_B && !this.keys.blue) { this.say('Need the BLUE keycard.'); this.emit('denied'); return; }
    d.target = d.target > 0.5 ? 0 : 1;
    this.emit('door');
  }

  fire() {
    if (this.fireCd > 0 || this.state !== 'playing') return;
    const w = WEAPONS[this.weapon];
    if (this[w.ammo] <= 0) { this.emit('empty'); this.fireCd = 0.25; return; }
    this[w.ammo]--;
    this.fireCd = w.cooldown;
    this.flashT = 0.07;
    this.emit('shoot', { weapon: this.weapon });
    const dx = Math.cos(this.angle), dy = Math.sin(this.angle);
    for (let p = 0; p < w.pellets; p++) {
      const a = this.angle + (this.rnd() - 0.5) * w.spread * 2;
      const cdx = Math.cos(a), cdy = Math.sin(a);
      const wallD = this.cast(this.px, this.py, cdx, cdy, 24).dist;
      let best = null, bestD = Infinity;
      for (const e of this.enemies) {
        if (e.state === 'dying') continue;
        const rx = e.x - this.px, ry = e.y - this.py;
        const along = rx * cdx + ry * cdy;
        if (along < 0.25 || along > wallD) continue;
        const perp = Math.abs(rx * cdy - ry * cdx);
        if (perp < 0.34 && along < bestD) { best = e; bestD = along; }
      }
      if (best) {
        const dmg = w.dmg[0] + ((this.rnd() * (w.dmg[1] - w.dmg[0] + 1)) | 0);
        const fall = clamp(1 - bestD / 26, 0.45, 1);
        this.damageEnemy(best, Math.round(dmg * fall));
      }
    }
  }

  damageEnemy(e, dmg) {
    if (e.state === 'dying') return;
    e.hp -= dmg; e.flashT = 0.09;
    if (e.hp <= 0) {
      e.state = 'dying'; e.deathT = 0;
      this.kills++;
      this.score += ENEMY_DEFS[e.type].score;
      this.emit('enemyDie');
    } else {
      this.emit('enemyHit');
      if (this.rnd() < (e.type === 'husk' ? 0.35 : 0.2)) e.painT = 0.18;
    }
  }

  damagePlayer(dmg) {
    if (this.state !== 'playing') return;
    if (this.armor > 0) {
      const saved = Math.min(this.armor, Math.floor(dmg / 3));
      this.armor -= saved; dmg -= saved;
    }
    this.hp -= dmg;
    this.hurtT = 0.4;
    this.emit('playerHurt');
    if (this.hp <= 0) {
      this.hp = 0; this.state = 'dead';
      this.emit('lose');
    }
  }

  collect(p) {
    p.taken = true;
    this.score += 10;
    if (p.kind === 'bullets') { this.bullets = Math.min(200, this.bullets + 10); this.say('Picked up bullets.'); }
    else if (p.kind === 'shells') { this.shells = Math.min(60, this.shells + 4); this.say('Picked up shells.'); }
    else if (p.kind === 'medkit') { this.hp = Math.min(100, this.hp + 25); this.say('Medkit: +25 health.'); }
    else if (p.kind === 'armor') { this.armor = Math.min(100, this.armor + 50); this.say('Armor shard: +50 armor.'); }
    else if (p.kind === 'keyR') { this.keys.red = true; this.say('Picked up the RED keycard.'); }
    else if (p.kind === 'keyB') { this.keys.blue = true; this.say('Picked up the BLUE keycard.'); }
    this.emit('pickup', { kind: p.kind });
  }

  // ------------------------------------------------------------------ update

  update(dt, input) {
    this.time += dt;
    if (this.messageT > 0) this.messageT -= dt;
    if (this.hurtT > 0) this.hurtT -= dt;
    if (this.flashT > 0) this.flashT -= dt;
    if (this.fireCd > 0) this.fireCd -= dt;
    for (const d of this.doors.values()) {
      const tgt = d.target;
      d.openT += clamp(tgt - d.openT, -dt * 1.4, dt * 1.4);
    }
    if (this.state !== 'playing') return;

    // --- player movement
    const run = input.run ? 1 : 0;
    const speed = run ? 5.2 : 3.4;
    let moving = false;
    if (input.turnL) this.angle -= 2.6 * dt;
    if (input.turnR) this.angle += 2.6 * dt;
    this.angle = normAng(this.angle);
    const fx = Math.cos(this.angle), fy = Math.sin(this.angle);
    let mx = 0, my = 0;
    if (input.fwd) { mx += fx; my += fy; moving = true; }
    if (input.back) { mx -= fx; my -= fy; moving = true; }
    if (input.strafeL) { mx += fy; my -= fx; moving = true; }
    if (input.strafeR) { mx -= fy; my += fx; moving = true; }
    if (mx || my) {
      const l = Math.hypot(mx, my); mx = (mx / l) * speed * dt; my = (my / l) * speed * dt;
      const r = 0.22;
      if (!this.circleHit(this.px + mx, this.py, r)) this.px += mx;
      if (!this.circleHit(this.px, this.py + my, r)) this.py += my;
      this.bobT += dt * (run ? 11 : 8);
    }
    void moving;
    if (input.use) { input.use = false; this.tryUse(); }
    if (input.weapon1) { input.weapon1 = false; if (this.weapon !== 'pistol') { this.weapon = 'pistol'; this.emit('weapon'); } }
    if (input.weapon2) { input.weapon2 = false; if (this.weapon !== 'shotgun') { this.weapon = 'shotgun'; this.emit('weapon'); } }
    if (input.fire) this.fire();

    // --- pickups & exit
    for (const p of this.pickups) {
      p.bob += dt * 3;
      if (!p.taken && Math.hypot(p.x - this.px, p.y - this.py) < 0.55) this.collect(p);
    }
    if (Math.hypot(this.exit.x + 0.5 - this.px, this.exit.y + 0.5 - this.py) < 0.55) {
      this.score += 250 + this.hp;
      if (this.levelIndex >= LEVELS.length - 1) {
        this.state = 'win'; this.emit('win');
      } else {
        this.state = 'clear'; this.emit('levelClear');
      }
      return;
    }

    // --- enemies
    for (const e of this.enemies) {
      if (e.state === 'dying') { e.deathT += dt; continue; }
      e.animT += dt;
      if (e.flashT > 0) e.flashT -= dt;
      if (e.attackT > 0) e.attackT -= dt;
      if (e.painT > 0) { e.painT -= dt; continue; }
      const def = ENEMY_DEFS[e.type];
      const dx = this.px - e.x, dy = this.py - e.y;
      const dist = Math.hypot(dx, dy);
      const los = this.hasLOS(e.x, e.y, this.px, this.py);
      e.cool -= dt;
      if (e.type === 'husk') {
        if (dist < 0.9 && los) {
          if (e.cool <= 0) {
            e.attackT = 0.28; e.cool = 1.0;
            this.damagePlayer(6 + ((this.rnd() * 7) | 0));
            this.emit('enemyAttack');
          }
        } else if (los || dist < 7) {
          const s = def.speed * dt / Math.max(dist, 0.001);
          const r = def.radius;
          if (!this.circleHit(e.x + dx * s, e.y, r)) e.x += dx * s;
          if (!this.circleHit(e.x, e.y + dy * s, r)) e.y += dy * s;
        }
      } else {
        // spitter: keeps distance, winds up a ranged strike
        if (e.windup > 0) {
          e.windup -= dt;
          if (e.windup <= 0) {
            e.cool = 1.5 + this.rnd();
            if (this.hasLOS(e.x, e.y, this.px, this.py)) {
              this.damagePlayer(5 + ((this.rnd() * 6) | 0));
              this.emit('spit');
            }
          }
        } else if (los && dist < 9 && e.cool <= 0) {
          e.windup = 0.45;
          this.emit('spitWindup');
        } else if (!los || dist > 6) {
          const s = def.speed * dt / Math.max(dist, 0.001);
          const r = def.radius;
          if (!this.circleHit(e.x + dx * s, e.y, r)) e.x += dx * s;
          if (!this.circleHit(e.x, e.y + dy * s, r)) e.y += dy * s;
        }
      }
    }
    // separation so enemies don't stack
    for (let i = 0; i < this.enemies.length; i++) {
      const a = this.enemies[i];
      if (a.state === 'dying') continue;
      for (let j = i + 1; j < this.enemies.length; j++) {
        const b = this.enemies[j];
        if (b.state === 'dying') continue;
        const dx = b.x - a.x, dy = b.y - a.y;
        const d = Math.hypot(dx, dy);
        if (d > 0.001 && d < 0.55) {
          const push = (0.55 - d) * 0.5;
          const nx = dx / d, ny = dy / d;
          if (!this.circleHit(a.x - nx * push, a.y - ny * push, 0.28)) { a.x -= nx * push; a.y -= ny * push; }
          if (!this.circleHit(b.x + nx * push, b.y + ny * push, 0.28)) { b.x += nx * push; b.y += ny * push; }
        }
      }
    }
  }
}

// ------------------------------------------------------------------ renderer
// Writes a full frame into `out` (Uint8ClampedArray, W*H*4). No canvas needed.

function texForTile(t) {
  if (t === T.W0) return TEX.wall0;
  if (t === T.W1) return TEX.wall1;
  if (t === T.W2) return TEX.wall2;
  if (t === T.DOOR) return TEX.door;
  if (t === T.DOOR_R) return TEX.doorR;
  if (t === T.DOOR_B) return TEX.doorB;
  if (t === T.EXIT) return TEX.exit;
  return TEX.wall0;
}

function drawSpriteBuf(out, W, H, spr, x0, y0, drawW, drawH, zbuf, dist, opts) {
  const tint = opts && opts.tint;
  const sink = (opts && opts.sink) || 0;
  const dropout = (opts && opts.dropout) || 0;
  const rnd = opts && opts.rnd;
  const yStart = Math.floor(y0 + sink);
  for (let sx = 0; sx < drawW; sx++) {
    const colX = Math.floor(x0 + sx);
    if (colX < 0 || colX >= W) continue;
    if (zbuf && zbuf[colX] <= dist) continue;
    const texX = clamp(Math.floor((sx / drawW) * spr.w), 0, spr.w - 1);
    for (let sy = 0; sy < drawH; sy++) {
      const colY = yStart + sy;
      if (colY < 0 || colY >= H) continue;
      const texY = clamp(Math.floor((sy / drawH) * spr.h), 0, spr.h - 1);
      const ti = (texY * spr.w + texX) * 4;
      if (spr.data[ti + 3] < 128) continue;
      if (dropout > 0 && rnd && rnd() < dropout) continue;
      const i = (colY * W + colX) * 4;
      let r = spr.data[ti], g = spr.data[ti + 1], b = spr.data[ti + 2];
      if (tint) { r = Math.min(255, r + tint[0]); g = Math.min(255, g + tint[1]); b = Math.min(255, b + tint[2]); }
      out[i] = r; out[i + 1] = g; out[i + 2] = b; out[i + 3] = 255;
    }
  }
}

export function renderFrame(game, out, W, H) {
  const px = game.px, py = game.py, angle = game.angle;
  const dirX = Math.cos(angle), dirY = Math.sin(angle);
  const tanHalf = Math.tan(game.fov / 2);
  const planeX = -dirY * tanHalf, planeY = dirX * tanHalf;

  // ceiling + floor gradients
  for (let y = 0; y < H; y++) {
    let r, g, b;
    if (y < H / 2) { const t = y / (H / 2); r = 10 + 24 * t; g = 5 + 11 * t; b = 7 + 10 * t; }
    else { const t = (y - H / 2) / (H / 2); r = 13 + 36 * t; g = 10 + 31 * t; b = 10 + 27 * t; }
    const row = y * W * 4;
    for (let x = 0; x < W; x++) {
      const i = row + x * 4;
      out[i] = r; out[i + 1] = g; out[i + 2] = b; out[i + 3] = 255;
    }
  }

  // walls
  const zbuf = new Float32Array(W);
  for (let x = 0; x < W; x++) {
    const cam = (2 * x) / W - 1;
    const rdx = dirX + planeX * cam, rdy = dirY + planeY * cam;
    const hit = game.cast(px, py, rdx, rdy, 40);
    const perp = Math.max(hit.dist, 0.0001);
    zbuf[x] = perp;
    const lineH = H / perp;
    const y0 = H / 2 - lineH / 2;
    const tex = texForTile(hit.tile);
    let texX = Math.floor(hit.wallX * tex.w);
    if (hit.door) texX = Math.floor((((hit.wallX + hit.door.openT * 0.9) % 1) + 1) % 1 * tex.w);
    texX = clamp(texX, 0, tex.w - 1);
    const shade = clamp(1.12 - perp / 13, 0.22, 1) * (hit.side === 1 ? 0.74 : 1);
    const ys = Math.max(0, Math.floor(y0)), ye = Math.min(H - 1, Math.ceil(y0 + lineH));
    for (let y = ys; y <= ye; y++) {
      const texY = clamp(Math.floor(((y - y0) / lineH) * tex.h), 0, tex.h - 1);
      const ti = (texY * tex.w + texX) * 4;
      const i = (y * W + x) * 4;
      out[i] = tex.data[ti] * shade;
      out[i + 1] = tex.data[ti + 1] * shade;
      out[i + 2] = tex.data[ti + 2] * shade;
      out[i + 3] = 255;
    }
  }

  // sprites, far to near
  const list = [];
  for (const e of game.enemies) {
    if (e.deathT > 0.7) continue;
    const dx = e.x - px, dy = e.y - py;
    list.push({ kind: 'enemy', e, dist: Math.hypot(dx, dy), dx, dy });
  }
  for (const p of game.pickups) {
    if (p.taken) continue;
    const dx = p.x - px, dy = p.y - py;
    list.push({ kind: 'pickup', p, dist: Math.hypot(dx, dy), dx, dy });
  }
  list.sort((a, b) => b.dist - a.dist);
  for (const s of list) {
    const angDiff = normAng(Math.atan2(s.dy, s.dx) - angle);
    if (Math.abs(angDiff) > game.fov / 2 + 0.35) continue;
    const dist = Math.max(s.dist, 0.15);
    if (s.kind === 'enemy') {
      const e = s.e;
      const frame = e.state === 'dying' ? 1 : (e.attackT > 0 || e.windup > 0 ? 1 : ((e.animT * 5) | 0) % 2);
      const spr = e.type === 'husk' ? SPR.husk[frame] : SPR.spitter[frame];
      const size = (H / dist) * 0.95;
      const drawW = size * (spr.w / spr.h);
      const screenX = (W / 2) * (1 + angDiff / (game.fov / 2));
      drawSpriteBuf(out, W, H, spr, screenX - drawW / 2, H / 2 - size / 2 + size * 0.06, drawW, size, zbuf, dist, {
        tint: e.flashT > 0 ? [130, 20, 20] : null,
        sink: e.state === 'dying' ? e.deathT * size * 1.1 : 0,
        dropout: e.state === 'dying' ? Math.min(0.85, e.deathT * 1.6) : 0,
        rnd: game.rnd,
      });
    } else {
      const spr = SPR.pickups[s.p.kind];
      const size = (H / dist) * 0.42;
      const drawW = size * (spr.w / spr.h);
      const screenX = (W / 2) * (1 + angDiff / (game.fov / 2));
      const bobY = Math.sin(s.p.bob) * size * 0.08;
      drawSpriteBuf(out, W, H, spr, screenX - drawW / 2, H / 2 - size / 2 + size * 0.22 + bobY, drawW, size, zbuf, dist, null);
    }
  }

  // weapon
  const wset = game.weapon === 'pistol' ? SPR.pistol : SPR.shotgun;
  const wspr = wset[game.flashT > 0 ? 1 : 0];
  const wh = H * 0.44, ww = wh * (wspr.w / wspr.h);
  const bobX = Math.sin(game.bobT) * W * 0.008;
  const bobY = Math.abs(Math.cos(game.bobT)) * H * 0.012;
  drawSpriteBuf(out, W, H, wspr, W / 2 - ww / 2 + bobX, H - wh + bobY - H * 0.015, ww, wh, null, 0, null);

  // crosshair
  if (game.state === 'playing') {
    const cx = (W / 2) | 0, cy = (H / 2) | 0;
    for (let k = -2; k <= 2; k++) {
      const i1 = (cy * W + cx + k) * 4, i2 = ((cy + k) * W + cx) * 4;
      if (cx + k >= 0 && cx + k < W) { out[i1] = 225; out[i1 + 1] = 225; out[i1 + 2] = 210; }
      if (cy + k >= 0 && cy + k < H) { out[i2] = 225; out[i2 + 1] = 225; out[i2 + 2] = 210; }
    }
  }

  // minimap
  const mm = Math.min(104, (W * 0.24) | 0);
  const sc = mm / Math.max(game.gw, game.gh);
  const mx0 = W - mm - 8, my0 = 8;
  for (let y = 0; y < mm; y++) for (let x = 0; x < mm; x++) {
    const i = ((my0 + y) * W + mx0 + x) * 4;
    out[i] = 8; out[i + 1] = 8; out[i + 2] = 10; out[i + 3] = 255;
  }
  for (let ty = 0; ty < game.gh; ty++) for (let tx = 0; tx < game.gw; tx++) {
    const t = game.grid[ty * game.gw + tx];
    if (t === T.EMPTY || t === T.EXIT) continue;
    let r = 110, g = 110, b = 116;
    if (t === T.DOOR) { r = 200; g = 170; b = 60; }
    else if (t === T.DOOR_R) { r = 220; g = 70; b = 70; }
    else if (t === T.DOOR_B) { r = 80; g = 130; b = 230; }
    const sx = Math.floor(mx0 + tx * sc), sy = Math.floor(my0 + ty * sc);
    const ex = Math.floor(mx0 + (tx + 1) * sc), ey = Math.floor(my0 + (ty + 1) * sc);
    for (let y = sy; y <= ey; y++) for (let x = sx; x <= ex; x++) {
      if (x < mx0 || y < my0 || x >= mx0 + mm || y >= my0 + mm) continue;
      const i = (y * W + x) * 4;
      out[i] = r; out[i + 1] = g; out[i + 2] = b;
    }
  }
  // exit blip
  {
    const blink = (game.time * 2 | 0) % 2 === 0;
    const sx = Math.floor(mx0 + (game.exit.x + 0.5) * sc) - 1, sy = Math.floor(my0 + (game.exit.y + 0.5) * sc) - 1;
    for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) {
      const i = ((sy + y) * W + sx + x) * 4;
      out[i] = 60; out[i + 1] = blink ? 255 : 120; out[i + 2] = 90;
    }
  }
  // player arrow
  {
    const sx = Math.floor(mx0 + game.px * sc), sy = Math.floor(my0 + game.py * sc);
    for (let y = -2; y <= 2; y++) for (let x = -2; x <= 2; x++) {
      const i = ((sy + y) * W + sx + x) * 4;
      out[i] = 255; out[i + 1] = 255; out[i + 2] = 255;
    }
    const ex = Math.floor(sx + Math.cos(angle) * 6), ey = Math.floor(sy + Math.sin(angle) * 6);
    const i = (ey * W + ex) * 4;
    if (ex >= mx0 && ey >= my0 && ex < mx0 + mm && ey < my0 + mm) { out[i] = 255; out[i + 1] = 200; out[i + 2] = 80; }
  }
  // enemies on map
  for (const e of game.enemies) {
    if (e.state === 'dying') continue;
    const sx = Math.floor(mx0 + e.x * sc) - 1, sy = Math.floor(my0 + e.y * sc) - 1;
    for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) {
      const xx = sx + x, yy = sy + y;
      if (xx < mx0 || yy < my0 || xx >= mx0 + mm || yy >= my0 + mm) continue;
      const i = (yy * W + xx) * 4;
      out[i] = 235; out[i + 1] = 60; out[i + 2] = 60;
    }
  }

  // damage / low-hp vignette
  let vig = 0;
  if (game.hurtT > 0) vig = Math.max(vig, (game.hurtT / 0.4) * 0.75);
  if (game.hp <= 30 && game.state === 'playing') vig = Math.max(vig, 0.28 + 0.14 * Math.sin(game.time * 6));
  if (vig > 0.01) {
    const bw = Math.floor(W * 0.1), bh = Math.floor(H * 0.14);
    const apply = (x, y) => {
      const i = (y * W + x) * 4;
      out[i] = out[i] * (1 - vig) + 190 * vig;
      out[i + 1] = out[i + 1] * (1 - vig);
      out[i + 2] = out[i + 2] * (1 - vig);
    };
    for (let y = 0; y < H; y++) for (let x = 0; x < bw; x++) { apply(x, y); apply(W - 1 - x, y); }
    for (let y = 0; y < bh; y++) for (let x = 0; x < W; x++) { apply(x, y); apply(x, H - 1 - y); }
  }
}

// ---------------------------------------------------------------- validation
// Flood fill from the player start treating doors as passable. Used by tests
// to prove every level is completable.

export function reachableCells(game) {
  const seen = new Uint8Array(game.gw * game.gh);
  const sx = Math.floor(game.px), sy = Math.floor(game.py);
  const q = [[sx, sy]];
  seen[sy * game.gw + sx] = 1;
  while (q.length) {
    const [x, y] = q.pop();
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= game.gw || ny >= game.gh) continue;
      if (seen[ny * game.gw + nx]) continue;
      const t = game.grid[ny * game.gw + nx];
      if (t >= T.W0 && t <= T.W2) continue;
      seen[ny * game.gw + nx] = 1;
      q.push([nx, ny]);
    }
  }
  return seen;
}
