import { useEffect, useRef, useState } from 'react';
import {
  Play, Pause, RotateCcw, X, Volume2, VolumeX, Skull,
  ChevronUp, ChevronDown, ChevronLeft, ChevronRight, Crosshair, DoorOpen, Repeat,
} from 'lucide-react';
import { Game, renderFrame, LEVELS } from './duskfall/engine.js';
import { playSound, isEnabled, setEnabled, initAudio } from '../../lib/sound.js';
import { recordBest, useScores } from './scores.js';
import { useAuth } from '../../os/AuthContext.jsx';
import { useLang } from '../../lib/i18n.jsx';

const QUALITY = {
  high: { w: 480, labelKey: 'duskHigh' },
  med: { w: 368, labelKey: 'duskMedium' },
  low: { w: 288, labelKey: 'duskLow' },
};

const EVENT_SOUNDS = {
  shoot: (ev) => playSound(ev.weapon === 'shotgun' ? 'duskShotgun' : 'duskPistol'),
  empty: () => playSound('duskEmpty'),
  enemyHit: () => playSound('duskHit'),
  enemyDie: () => playSound('duskDie'),
  playerHurt: () => playSound('duskHurt'),
  spit: () => playSound('duskSpit'),
  pickup: (ev) => playSound(ev.kind === 'keyR' || ev.kind === 'keyB' ? 'duskKey' : 'duskPickup'),
  door: () => playSound('duskDoor'),
  denied: () => playSound('duskDenied'),
  weapon: () => playSound('click'),
  levelClear: () => playSound('duskWin'),
  win: () => playSound('duskWin'),
  lose: () => playSound('duskLose'),
};

const blankInput = () => ({
  fwd: false, back: false, strafeL: false, strafeR: false,
  turnL: false, turnR: false, run: false, fire: false,
  use: false, weapon1: false, weapon2: false,
});

export default function DuskfallGame({ onExit }) {
  const { user } = useAuth();
  const { t } = useLang();
  const [scores] = useScores(user?.id);
  const best = scores?.duskfall?.best || 0;

  const [screen, setScreen] = useState('title'); // title|playing|paused|dead|win
  const [hud, setHud] = useState(null);
  const [msg, setMsg] = useState('');
  const [quality, setQuality] = useState('high');
  const [muted, setMuted] = useState(!isEnabled());
  const [newBest, setNewBest] = useState(false);
  const [clearInfo, setClearInfo] = useState(null);

  const wrapRef = useRef(null);
  const canvasRef = useRef(null);
  const gameRef = useRef(null);
  const inputRef = useRef(blankInput());
  const rafRef = useRef(0);
  const lastRef = useRef(0);
  const bufRef = useRef(null);
  const imgRef = useRef(null);
  const ctxRef = useRef(null);
  const screenRef = useRef(screen);
  const qualityRef = useRef(quality);
  const emaRef = useRef(16);
  const slowFramesRef = useRef(0);
  const clearTimerRef = useRef(0);
  const mouseTurnRef = useRef(0);
  const pauseRef = useRef(null);
  screenRef.current = screen;
  qualityRef.current = quality;

  const syncHud = (g) => {
    const next = {
      hp: Math.ceil(g.hp), armor: Math.ceil(g.armor),
      bullets: g.bullets, shells: g.shells, weapon: g.weapon,
      score: g.score, kills: g.kills,
      level: g.levelIndex + 1, levelName: g.levelName,
      total: LEVELS.length,
      red: g.keys.red, blue: g.keys.blue,
      enemiesLeft: g.enemies.filter((e) => e.state !== 'dying').length,
    };
    setHud((prev) => {
      if (prev && Object.keys(next).every((k) => prev[k] === next[k])) return prev;
      return next;
    });
    setMsg((prev) => (g.messageT > 0 ? g.message : prev === '' ? '' : prev));
    if (g.messageT <= 0) setMsg((prev) => (prev === '' ? prev : ''));
  };

  const finishRun = (g, won) => {
    const isBest = recordBest('duskfall', g.score);
    setNewBest(isBest);
    setScreen(won ? 'win' : 'dead');
  };

  const startLoop = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const q = QUALITY[qualityRef.current];
    const W = q.w, H = Math.round((q.w * 9) / 16);
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d');
    ctxRef.current = ctx;
    imgRef.current = ctx.createImageData(W, H);
    bufRef.current = imgRef.current.data;
    lastRef.current = performance.now();
    cancelAnimationFrame(rafRef.current);
    const loop = (t) => {
      if (screenRef.current !== 'playing') return;
      const g = gameRef.current;
      if (!g) return;
      const dtms = t - lastRef.current;
      lastRef.current = t;
      const dt = Math.min(0.05, dtms / 1000);
      // adaptive quality: sustained slow frames step down a level
      emaRef.current = emaRef.current * 0.95 + dtms * 0.05;
      if (emaRef.current > 30) {
        slowFramesRef.current++;
        if (slowFramesRef.current > 90) {
          slowFramesRef.current = 0;
          if (qualityRef.current === 'high') { setQuality('med'); restartWithQuality('med'); return; }
          if (qualityRef.current === 'med') { setQuality('low'); restartWithQuality('low'); return; }
        }
      } else slowFramesRef.current = 0;

      if (mouseTurnRef.current) g.angle += mouseTurnRef.current * dt * 1.9;
      g.update(dt, inputRef.current);
      for (const ev of g.events.splice(0)) {
        const fn = EVENT_SOUNDS[ev.type];
        if (fn) { try { fn(ev); } catch { /* never break the loop */ } }
      }
      renderFrame(g, bufRef.current, W, H);
      ctx.putImageData(imgRef.current, 0, 0);
      syncHud(g);
      if (g.state === 'dead') { finishRun(g, false); return; }
      if (g.state === 'win') { finishRun(g, true); return; }
      if (g.state === 'clear' && !clearTimerRef.current) {
        setClearInfo({ level: g.levelIndex + 1, score: g.score });
        clearTimerRef.current = setTimeout(() => {
          clearTimerRef.current = 0;
          setClearInfo(null);
          g.nextLevel();
          if (screenRef.current === 'playing') { lastRef.current = performance.now(); rafRef.current = requestAnimationFrame(loop); }
        }, 2400);
      }
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
  };

  const restartWithQuality = (q) => {
    qualityRef.current = q;
    startLoop();
  };

  const startGame = () => {
    try { initAudio(); } catch { /* ignore */ }
    clearTimeout(clearTimerRef.current); clearTimerRef.current = 0;
    setClearInfo(null); setNewBest(false);
    inputRef.current = blankInput();
    gameRef.current = new Game();
    emaRef.current = 16; slowFramesRef.current = 0;
    setScreen('playing');
    setTimeout(() => { startLoop(); wrapRef.current?.focus(); }, 30);
  };

  const togglePause = () => {
    mouseTurnRef.current = 0;
    if (screenRef.current === 'playing') {
      setScreen('paused');
      cancelAnimationFrame(rafRef.current);
      inputRef.current = blankInput();
    } else if (screenRef.current === 'paused') {
      setScreen('playing');
      setTimeout(() => { lastRef.current = performance.now(); startLoop(); wrapRef.current?.focus(); }, 30);
    }
  };
  pauseRef.current = togglePause;

  useEffect(() => () => {
    cancelAnimationFrame(rafRef.current);
    clearTimeout(clearTimerRef.current);
  }, []);

  // Grab keyboard focus on mount so game keys work immediately, and
  // pause automatically whenever the tab/window loses visibility —
  // the game must never keep running (or firing) in the background.
  useEffect(() => {
    wrapRef.current?.focus();
    const onVis = () => {
      if (document.hidden && screenRef.current === 'playing') pauseRef.current?.();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  const setKey = (code, down) => {
    const inp = inputRef.current;
    switch (code) {
      case 'KeyW': case 'ArrowUp': inp.fwd = down; break;
      case 'KeyS': case 'ArrowDown': inp.back = down; break;
      case 'KeyA': inp.strafeL = down; break;
      case 'KeyD': inp.strafeR = down; break;
      case 'ArrowLeft': inp.turnL = down; break;
      case 'ArrowRight': inp.turnR = down; break;
      case 'ShiftLeft': case 'ShiftRight': inp.run = down; break;
      case 'Space': inp.fire = down; break;
      default: break;
    }
  };

  const onKeyDown = (e) => {
    if (screenRef.current !== 'playing') {
      if (e.code === 'Escape') { e.preventDefault(); onExit?.(); return; }
      if ((e.code === 'Enter' || e.code === 'Space') && (screenRef.current === 'title' || screenRef.current === 'dead' || screenRef.current === 'win')) {
        e.preventDefault(); startGame();
      }
      return;
    }
    const gameKeys = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'KeyE', 'Digit1', 'Digit2'];
    if (gameKeys.includes(e.code)) e.preventDefault();
    if (e.code === 'Escape' || e.code === 'KeyP') { togglePause(); return; }
    if (!e.repeat) {
      if (e.code === 'KeyE') inputRef.current.use = true;
      if (e.code === 'Digit1') inputRef.current.weapon1 = true;
      if (e.code === 'Digit2') inputRef.current.weapon2 = true;
    }
    setKey(e.code, true);
  };
  const onKeyUp = (e) => setKey(e.code, false);

  const toggleMute = () => {
    const next = !isEnabled();
    setEnabled(next);
    setMuted(!next);
  };

  // Mouse look + fire (desktop): moving the mouse toward the edges
  // of the viewport steers, clicking the view fires. Only the canvas
  // itself fires — clicks on HUD buttons never discharge a weapon.
  const onPointerDown = (e) => {
    if (e.pointerType !== 'mouse' || e.button !== 0) return;
    if (screenRef.current !== 'playing') return;
    if (e.target === canvasRef.current) inputRef.current.fire = true;
  };
  const onPointerUp = (e) => {
    if (e.pointerType === 'mouse') inputRef.current.fire = false;
  };
  const onPointerMove = (e) => {
    if (e.pointerType !== 'mouse' || screenRef.current !== 'playing') {
      if (e.pointerType === 'mouse') mouseTurnRef.current = 0;
      return;
    }
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect || !rect.width) return;
    const rel = (e.clientX - rect.left) / rect.width - 0.5;
    mouseTurnRef.current = Math.abs(rel) < 0.09 ? 0 : Math.max(-1, Math.min(1, rel * 2.2));
  };
  const onPointerLeave = () => {
    mouseTurnRef.current = 0;
    inputRef.current.fire = false;
  };

  const hold = (name) => ({
    onPointerDown: (e) => { e.preventDefault(); inputRef.current[name] = true; },
    onPointerUp: () => { inputRef.current[name] = false; },
    onPointerLeave: () => { inputRef.current[name] = false; },
    onPointerCancel: () => { inputRef.current[name] = false; },
  });
  const tap = (fn) => ({
    onPointerDown: (e) => { e.preventDefault(); fn(); },
  });

  const isTouch = typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
  const inGame = screen === 'playing' || screen === 'paused';

  return (
    <div className="flex h-full flex-col bg-[#0b0708] text-[#e8ded2]">
      {/* top bar */}
      <div className="flex items-center gap-2 border-b border-[#2a1d18] px-3 py-2">
        <button onClick={onExit} className="rounded p-1.5 text-[#a89880] hover:bg-[#1d1310] hover:text-white" aria-label={t('egg.close')} title={`${t('egg.close')} (Esc)`}>
          <X size={16} />
        </button>
        <Skull size={16} className="text-[#c0392b]" />
        <span className="text-sm font-bold tracking-[0.2em]">DUSKFALL</span>
        {best > 0 && <span className="ml-1 rounded bg-[#1d1310] px-2 py-0.5 text-xs text-[#a89880]">{t('games.duskBest', { n: best })}</span>}
        <div className="ml-auto flex items-center gap-2">
          <label className="text-xs text-[#a89880]" htmlFor="dusk-quality">{t('games.duskDetail')}</label>
          <select
            id="dusk-quality"
            value={quality}
            onChange={(e) => { setQuality(e.target.value); if (screenRef.current === 'playing') restartWithQuality(e.target.value); }}
            className="rounded border border-[#2a1d18] bg-[#1d1310] px-1.5 py-1 text-xs"
          >
            {Object.entries(QUALITY).map(([k, v]) => <option key={k} value={k}>{t('games.' + v.labelKey)}</option>)}
          </select>
          <button onClick={toggleMute} className="rounded p-1.5 text-[#a89880] hover:bg-[#1d1310] hover:text-white" aria-label={muted ? t('games.duskUnmute') : t('games.duskMute')} title={muted ? t('games.duskUnmute') : t('games.duskMute')}>
            {muted ? <VolumeX size={16} /> : <Volume2 size={16} />}
          </button>
          {inGame && (
            <button onClick={togglePause} className="rounded p-1.5 text-[#a89880] hover:bg-[#1d1310] hover:text-white" aria-label={screen === 'paused' ? t('games.duskResume') : t('games.duskPause')}>
              {screen === 'paused' ? <Play size={16} /> : <Pause size={16} />}
            </button>
          )}
        </div>
      </div>

      {/* game viewport */}
      <div
        ref={wrapRef}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onPointerMove={onPointerMove}
        onPointerLeave={onPointerLeave}
        onBlur={() => { if (screenRef.current === 'playing') togglePause(); }}
        className="relative flex-1 select-none overflow-hidden bg-black outline-none"
        style={{ touchAction: 'none', cursor: inGame ? 'crosshair' : undefined }}
      >
        <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" style={{ imageRendering: 'pixelated' }} />

        {/* HUD */}
        {inGame && hud && (
          <>
            <div className="pointer-events-none absolute left-2 top-2 flex flex-col gap-1.5">
              <div className="rounded bg-black/60 px-2 py-1">
                <div className="text-[10px] uppercase tracking-wider text-[#a89880]">{t('games.duskHealth')}</div>
                <div className="h-2.5 w-32 overflow-hidden rounded-sm bg-[#2a1410]">
                  <div className={`h-full transition-all ${hud.hp > 50 ? 'bg-[#7bc47f]' : hud.hp > 25 ? 'bg-[#e0a83c]' : 'bg-[#c0392b]'}`} style={{ width: `${hud.hp}%` }} />
                </div>
                <div className="mt-0.5 text-sm font-bold leading-none">{hud.hp}<span className="ml-2 text-xs font-normal text-[#7fa8d0]">🛡 {hud.armor}</span></div>
              </div>
              <div className="rounded bg-black/60 px-2 py-1 text-xs">
                <span className={`font-bold ${hud.weapon === 'pistol' ? 'text-[#e8ded2]' : 'text-[#a89880]'}`}>1 {t('games.duskPistol')} <span className="text-[#e0a83c]">{hud.bullets}</span></span>
                <span className="mx-1.5 text-[#5a4a3c]">|</span>
                <span className={`font-bold ${hud.weapon === 'shotgun' ? 'text-[#e8ded2]' : 'text-[#a89880]'}`}>2 {t('games.duskScattergun')} <span className="text-[#e0a83c]">{hud.shells}</span></span>
              </div>
            </div>
            <div className="pointer-events-none absolute right-2 top-2 flex flex-col items-end gap-1">
              <div className="rounded bg-black/60 px-2 py-1 text-right text-xs">
                <div className="font-bold text-[#e8ded2]">{t('games.duskLevel', { level: hud.level, total: hud.total, name: hud.levelName })}</div>
                <div className="text-[#e0a83c]">{t('games.duskScoreKills', { score: hud.score, kills: hud.kills })}</div>
              </div>
              {(hud.red || hud.blue) && (
                <div className="flex gap-1">
                  {hud.red && <span className="rounded bg-black/60 px-1.5 py-0.5 text-[11px] font-bold text-[#e06a6a]">{t('games.duskKeyRed')}</span>}
                  {hud.blue && <span className="rounded bg-black/60 px-1.5 py-0.5 text-[11px] font-bold text-[#7fa8d0]">{t('games.duskKeyBlue')}</span>}
                </div>
              )}
            </div>
            {msg && (
              <div className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 whitespace-nowrap rounded bg-black/70 px-3 py-1 text-sm text-[#e8ded2]">
                {msg}
              </div>
            )}
          </>
        )}

        {/* touch controls */}
        {isTouch && screen === 'playing' && (
          <>
            <div className="absolute bottom-4 left-3 grid grid-cols-3 gap-1.5 opacity-80">
              <span />
              <button aria-label={t('games.duskMoveForward')} className="rounded-lg bg-white/10 p-3 text-white active:bg-white/25" {...hold('fwd')}><ChevronUp size={22} /></button>
              <span />
              <button aria-label={t('games.duskTurnLeft')} className="rounded-lg bg-white/10 p-3 text-white active:bg-white/25" {...hold('turnL')}><ChevronLeft size={22} /></button>
              <button aria-label={t('games.duskMoveBack')} className="rounded-lg bg-white/10 p-3 text-white active:bg-white/25" {...hold('back')}><ChevronDown size={22} /></button>
              <button aria-label={t('games.duskTurnRight')} className="rounded-lg bg-white/10 p-3 text-white active:bg-white/25" {...hold('turnR')}><ChevronRight size={22} /></button>
            </div>
            <div className="absolute bottom-4 right-3 flex items-end gap-1.5 opacity-80">
              <button aria-label={t('games.duskUseDoor')} className="rounded-lg bg-white/10 p-3 text-white active:bg-white/25" {...tap(() => { inputRef.current.use = true; })}><DoorOpen size={22} /></button>
              <button aria-label={t('games.duskSwitchWeapon')} className="rounded-lg bg-white/10 p-3 text-white active:bg-white/25" {...tap(() => { const g = gameRef.current; if (g) { g.weapon = g.weapon === 'pistol' ? 'shotgun' : 'pistol'; playSound('click'); } })}><Repeat size={22} /></button>
              <button aria-label={t('games.duskFire')} className="rounded-full bg-[#c0392b]/70 p-5 text-white active:bg-[#c0392b]" {...hold('fire')}><Crosshair size={26} /></button>
            </div>
          </>
        )}

        {/* level-clear banner */}
        {clearInfo && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/50">
            <div className="text-center">
              <div className="text-3xl font-black tracking-[0.25em] text-[#e0a83c]">{t('games.duskSectorClear')}</div>
              <div className="mt-2 text-sm text-[#a89880]">{t('games.duskDescending', { n: clearInfo.score })}</div>
            </div>
          </div>
        )}

        {/* title screen */}
        {screen === 'title' && (
          <div className="absolute inset-0 flex items-center justify-center bg-[#0b0708]/95 p-4">
            <div className="max-w-md text-center">
              <Skull size={40} className="mx-auto text-[#c0392b]" />
              <h1 className="mt-2 text-4xl font-black tracking-[0.3em] text-[#e8ded2]">DUSKFALL</h1>
              <p className="mt-3 text-sm leading-relaxed text-[#a89880]">
                {t('games.duskStory')}
              </p>
              <p className="mt-2 text-xs italic text-[#5a4a3c]">{t('egg.found')}</p>
              <div className="mx-auto mt-4 grid max-w-xs grid-cols-2 gap-x-4 gap-y-1 text-left text-xs text-[#a89880]">
                <span><b className="text-[#e8ded2]">WASD</b> {t('games.duskMoveStrafe')}</span>
                <span><b className="text-[#e8ded2]">← →</b> {t('games.duskTurn')}</span>
                <span><b className="text-[#e8ded2]">Space</b> {t('games.duskFireKey')}</span>
                <span><b className="text-[#e8ded2]">E</b> {t('games.duskOpenDoors')}</span>
                <span><b className="text-[#e8ded2]">1 / 2</b> {t('games.duskWeapons')}</span>
                <span><b className="text-[#e8ded2]">Shift</b> {t('games.duskRun')} · <b className="text-[#e8ded2]">P</b> {t('games.duskPauseKey')}</span>
              </div>
              <button
                onClick={startGame}
                className="mt-5 inline-flex items-center gap-2 rounded bg-[#c0392b] px-6 py-2.5 text-sm font-bold text-white hover:bg-[#a93226]"
              >
                <Play size={16} /> {t('games.duskEnter')}
              </button>
              {best > 0 && <div className="mt-2 text-xs text-[#a89880]">{t('games.duskBestScore', { n: best })}</div>}
            </div>
          </div>
        )}

        {/* paused */}
        {screen === 'paused' && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/70">
            <div className="text-center">
              <div className="text-2xl font-black tracking-[0.25em]">{t('games.duskPaused')}</div>
              <div className="mt-4 flex justify-center gap-2">
                <button onClick={togglePause} className="inline-flex items-center gap-2 rounded bg-[#c0392b] px-4 py-2 text-sm font-bold text-white hover:bg-[#a93226]">
                  <Play size={15} /> {t('games.duskResume')}
                </button>
                <button onClick={startGame} className="inline-flex items-center gap-2 rounded border border-[#2a1d18] px-4 py-2 text-sm text-[#a89880] hover:text-white">
                  <RotateCcw size={15} /> {t('games.duskRestart')}
                </button>
                <button onClick={onExit} className="inline-flex items-center gap-2 rounded border border-[#2a1d18] px-4 py-2 text-sm text-[#a89880] hover:text-white">
                  <X size={15} /> {t('egg.quit')}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* dead */}
        {screen === 'dead' && hud && (
          <div className="absolute inset-0 flex items-center justify-center bg-[#1a0505]/90 p-4">
            <div className="text-center">
              <div className="text-4xl font-black tracking-[0.2em] text-[#c0392b]">{t('games.duskDied')}</div>
              <div className="mt-3 text-sm text-[#a89880]">{t('games.duskSectorStats', { level: hud.level, kills: hud.kills, score: hud.score })}</div>
              {newBest && <div className="mt-1 text-sm font-bold text-[#e0a83c]">{t('games.duskNewBest')}</div>}
              <div className="mt-4 flex justify-center gap-2">
                <button onClick={startGame} className="inline-flex items-center gap-2 rounded bg-[#c0392b] px-5 py-2 text-sm font-bold text-white hover:bg-[#a93226]">
                  <RotateCcw size={15} /> {t('games.duskTryAgain')}
                </button>
                <button onClick={onExit} className="rounded border border-[#2a1d18] px-4 py-2 text-sm text-[#a89880] hover:text-white">{t('egg.quit')}</button>
              </div>
            </div>
          </div>
        )}

        {/* win */}
        {screen === 'win' && hud && (
          <div className="absolute inset-0 flex items-center justify-center bg-[#0b0708]/95 p-4">
            <div className="text-center">
              <div className="text-4xl font-black tracking-[0.2em] text-[#7bc47f]">{t('games.duskSurfaced')}</div>
              <p className="mt-3 text-sm text-[#a89880]">{t('games.duskSurfacedText')}</p>
              <div className="mt-2 text-sm text-[#a89880]">{t('games.duskKillsFinal', { kills: hud.kills, score: hud.score })}</div>
              {newBest && <div className="mt-1 text-sm font-bold text-[#e0a83c]">{t('games.duskNewBest')}</div>}
              <div className="mt-4 flex justify-center gap-2">
                <button onClick={startGame} className="inline-flex items-center gap-2 rounded bg-[#c0392b] px-5 py-2 text-sm font-bold text-white hover:bg-[#a93226]">
                  <RotateCcw size={15} /> {t('games.playAgain')}
                </button>
                <button onClick={onExit} className="rounded border border-[#2a1d18] px-4 py-2 text-sm text-[#a89880] hover:text-white">{t('egg.quit')}</button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* footer hints */}
      <div className="hidden border-t border-[#2a1d18] px-3 py-1.5 text-[11px] text-[#5a4a3c] sm:block">
        {t('games.duskFooter')}
      </div>
    </div>
  );
}
