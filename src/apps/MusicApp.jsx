import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Play, Pause, Square, SkipBack, SkipForward, Volume2, VolumeX,
  Repeat, Repeat1, Shuffle, ListMusic, X, FolderOpen, History,
  ChevronRight, AudioLines, Gauge,
} from 'lucide-react';
import { useNotifications } from '../os/NotificationsContext.jsx';
import { useWindows } from '../os/WindowsContext.jsx';
import {
  scanMedia, mediaUrl, safePlay, formatTime,
  pushHistory, getHistory, AUDIO_EXT,
} from './mediaLib.js';

const BANDS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
const PRESETS = {
  Flat: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  Rock: [4, 3, 2, 1, -1, 1, 2, 3, 4, 5],
  Pop: [3, 4, 5, 3, 1, 0, 1, 2, 4, 5],
  Jazz: [3, 2, 1, 2, 3, 3, 2, 1, 2, 3],
  Classical: [4, 3, 2, 2, 1, 1, 2, 3, 4, 5],
  'Bass boost': [7, 6, 5, 3, 1, 0, 0, 0, 0, 0],
  'Treble boost': [0, 0, 0, 0, 0, 1, 3, 5, 6, 7],
  Vocal: [-2, -1, 1, 3, 4, 4, 3, 1, 0, -1],
};
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];
const VOL_KEY = 'driftshop:music:volume';
const EQ_KEY = 'driftshop:music:eq';
const VOL_KEY_LEGACY = 'drift:music:volume';
const EQ_KEY_LEGACY = 'drift:music:eq';

// Read a localStorage key, migrating from the legacy drift: key once.
function readStoredKey(key, legacyKey) {
  try {
    let v = localStorage.getItem(key);
    if (v == null && legacyKey) {
      v = localStorage.getItem(legacyKey);
      if (v != null) {
        try { localStorage.setItem(key, v); } catch {}
        try { localStorage.removeItem(legacyKey); } catch {}
      }
    }
    return v;
  } catch {
    return null;
  }
}

// Two playlist entries describe the same file when they share a storage path
// (library entries) or blob URL (dropped files) and a name.
const sameEntry = (a, b) =>
  !!a && !!b && (a.path || a.url) === (b.path || b.url) && a.name === b.name;

/**
 * Music keeps playing while its window is minimized: minimized windows are
 * hidden with display:none, not unmounted, so the <audio> element and the
 * Web Audio graph survive. Closing the window unmounts the app and stops
 * playback (cleanup below disconnects the graph and pauses the element).
 */
export default function MusicApp({ windowApi, path: initialPath }) {
  const { push } = useNotifications();
  const { openWindow } = useWindows();
  const audioRef = useRef(null);
  const canvasRef = useRef(null);
  const vizRaf = useRef(null);
  const wa = useRef(null); // { ctx, filters, analyser, master }
  const scanSeq = useRef(0);
  const fadeTimer = useRef(null); // pending crossfade track-switch timeout
  // A pending fade must never fire after the component is gone.
  useEffect(() => () => clearTimeout(fadeTimer.current), []);

  const [playlist, setPlaylist] = useState([]);
  const [index, setIndex] = useState(-1);
  const [loading, setLoading] = useState(true);
  const [scanError, setScanError] = useState('');
  const [url, setUrl] = useState('');
  const [loadError, setLoadError] = useState('');
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(() => {
    try {
      const v = Number(readStoredKey(VOL_KEY, VOL_KEY_LEGACY));
      return Number.isFinite(v) && v >= 0 && v <= 1 ? v : 0.8;
    } catch {
      // storage blocked (private mode etc.) — fall back to a sane default
      return 0.8;
    }
  });
  const [muted, setMuted] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [shuffle, setShuffle] = useState(false);
  const [repeat, setRepeat] = useState('off'); // off | all | one
  const [ab, setAb] = useState(null);
  const [abMark, setAbMark] = useState(null);
  const [showSidebar, setShowSidebar] = useState(true);
  const [showEq, setShowEq] = useState(false);
  const [showViz, setShowViz] = useState(true);
  const [sideTab, setSideTab] = useState('playlist');
  const [recent, setRecent] = useState(() => getHistory('audio'));
  const [dragOver, setDragOver] = useState(false);
  const [tick, setTick] = useState(0);
  const [eqOn, setEqOn] = useState(() => {
    try {
      return readStoredKey(EQ_KEY, EQ_KEY_LEGACY) !== 'off';
    } catch {
      return true;
    }
  });
  const [gains, setGains] = useState(PRESETS.Flat);
  const [preset, setPreset] = useState('Flat');
  const indexRef = useRef(index);
  indexRef.current = index;
  const playlistRef = useRef(playlist);
  playlistRef.current = playlist;

  const current = index >= 0 ? playlist[index] : null;

  // ---- scan -----------------------------------------------------------------
  const scan = useCallback(async () => {
    const seq = ++scanSeq.current;
    setLoading(true);
    setScanError('');
    try {
      const found = await scanMedia(AUDIO_EXT);
      // A newer scan superseded this one — drop the stale result.
      if (scanSeq.current !== seq) return;
      setPlaylist((prev) => {
        const externals = prev.filter((p) => p.external);
        const next = [
          ...externals,
          ...found.map((e) => ({ name: e.name, path: e.path, mime: e.mime })),
        ];
        // Keep entry identity across no-op rescans so a rescan doesn't
        // restart playback or re-push history for the current track.
        if (next.length === prev.length && next.every((p, i) => sameEntry(p, prev[i]))) {
          return prev;
        }
        return next;
      });
    } catch (err) {
      if (scanSeq.current !== seq) return;
      setScanError(err?.message || 'Could not scan for music.');
    } finally {
      if (scanSeq.current === seq) setLoading(false);
    }
  }, []);
  useEffect(() => { scan(); }, [scan, tick]);

  // ---- resolve current --------------------------------------------------------
  useEffect(() => {
    if (!current) {
      setUrl('');
      setLoadError('');
      return;
    }
    let live = true;
    setLoadError('');
    setUrl('');
    setAb(null);
    setAbMark(null);
    const go = async () => {
      try {
        if (current.external && current.url) {
          if (live) setUrl(current.url);
        } else if (current.path) {
          const r = await mediaUrl(current.path);
          if (live) {
            setUrl(r.url);
            pushHistory('audio', current);
            setRecent(getHistory('audio'));
          }
        }
      } catch (err) {
        if (live) setLoadError(err?.message || 'Could not load audio.');
      }
    };
    go();
    return () => { live = false; };
  }, [current]);

  useEffect(() => {
    if (!initialPath || playlist.length === 0 || index !== -1) return;
    const i = playlist.findIndex((p) => p.path === initialPath);
    if (i >= 0) setIndex(i);
  }, [initialPath, playlist, index]);

  useEffect(() => {
    windowApi?.setTitle?.(current ? `Music — ${current.name}` : 'Music');
  }, [current, windowApi]);

  // ---- Web Audio: 10-band EQ + analyser ---------------------------------------
  const ensureGraph = useCallback(() => {
    if (wa.current) return wa.current;
    const el = audioRef.current;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!el || !AC) return null;
    try {
      const ctx = new AC();
      const src = ctx.createMediaElementSource(el);
      const filters = BANDS.map((freq) => {
        const f = ctx.createBiquadFilter();
        f.type = 'peaking';
        f.frequency.value = freq;
        f.Q.value = 1;
        f.gain.value = 0;
        return f;
      });
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.8;
      const master = ctx.createGain();
      src.connect(filters[0]);
      for (let i = 0; i < filters.length - 1; i += 1) filters[i].connect(filters[i + 1]);
      filters[filters.length - 1].connect(analyser);
      analyser.connect(master);
      master.connect(ctx.destination);
      wa.current = { ctx, filters, analyser, master };
      return wa.current;
    } catch {
      return null;
    }
  }, []);

  // Apply EQ gains (or flatten when EQ is off).
  useEffect(() => {
    const g = wa.current;
    if (!g) return;
    const t = g.ctx.currentTime;
    g.filters.forEach((f, i) => {
      f.gain.setTargetAtTime(eqOn ? gains[i] : 0, t, 0.02);
    });
  }, [gains, eqOn]);

  useEffect(() => {
    try {
      localStorage.setItem(EQ_KEY, eqOn ? 'on' : 'off');
    } catch { /* ignore */ }
  }, [eqOn]);

  // Cleanup on unmount (window closed): stop audio + close the context.
  useEffect(
    () => () => {
      try {
        audioRef.current?.pause();
      } catch { /* ignore */ }
      if (vizRaf.current) cancelAnimationFrame(vizRaf.current);
      try {
        wa.current?.ctx.close();
      } catch { /* ignore */ }
      wa.current = null;
    },
    []
  );

  // ---- transport ---------------------------------------------------------------
  const el = () => audioRef.current;

  const playAt = useCallback(
    (i) => {
      if (i < 0 || i >= playlist.length) return;
      const g = ensureGraph();
      // Quick fade to avoid clicks between tracks (simple crossfade-ish).
      if (g && playing) {
        const t = g.ctx.currentTime;
        g.master.gain.cancelScheduledValues(t);
        g.master.gain.setTargetAtTime(0.0001, t, 0.05);
        // A newer selection supersedes a pending fade — never let an old
        // timer win after the user picked something else.
        clearTimeout(fadeTimer.current);
        fadeTimer.current = setTimeout(() => {
          fadeTimer.current = null;
          setIndex(i);
          const gg = wa.current;
          if (gg) gg.master.gain.setTargetAtTime(muted ? 0.0001 : volume, gg.ctx.currentTime, 0.08);
        }, 160);
      } else {
        setIndex(i);
      }
      requestAnimationFrame(() => requestAnimationFrame(() => {
        ensureGraph()?.ctx.resume?.().catch(() => {});
        safePlay(el());
      }));
    },
    [playlist.length, ensureGraph, playing, muted, volume]
  );

  const togglePlay = useCallback(() => {
    const a = el();
    if (!a || !url) return;
    ensureGraph()?.ctx.resume?.().catch(() => {});
    if (a.paused) safePlay(a);
    else a.pause();
  }, [url, ensureGraph]);

  const stop = useCallback(() => {
    const a = el();
    if (!a) return;
    a.pause();
    a.currentTime = 0;
  }, []);

  const pickNext = useCallback(
    (i) => {
      if (playlist.length === 0) return i;
      if (shuffle) {
        if (playlist.length === 1) return i;
        let n = i;
        while (n === i) n = Math.floor(Math.random() * playlist.length);
        return n;
      }
      return i + 1 < playlist.length ? i + 1 : repeat === 'all' ? 0 : -1;
    },
    [playlist.length, shuffle, repeat]
  );

  const next = useCallback(() => {
    const n = pickNext(indexRef.current);
    if (n >= 0) playAt(n);
  }, [pickNext, playAt]);

  const prev = useCallback(() => {
    const a = el();
    if (a && a.currentTime > 3) {
      a.currentTime = 0;
      return;
    }
    const i = indexRef.current;
    playAt(i - 1 >= 0 ? i - 1 : repeat === 'all' ? playlist.length - 1 : i);
  }, [playAt, repeat, playlist.length]);

  const onEnded = useCallback(() => {
    setPlaying(false);
    if (repeat === 'one') {
      const a = el();
      if (a) {
        a.currentTime = 0;
        safePlay(a);
      }
      return;
    }
    const n = pickNext(indexRef.current);
    if (n >= 0) playAt(n);
  }, [repeat, pickNext, playAt]);

  const onTimeUpdate = useCallback(() => {
    const a = el();
    if (!a) return;
    const t = a.currentTime;
    setTime(t);
    if (ab && t >= ab.b) a.currentTime = ab.a;
  }, [ab]);

  const seekBy = useCallback((d) => {
    const a = el();
    if (!a || !Number.isFinite(a.duration)) return;
    a.currentTime = Math.min(Math.max(0, a.currentTime + d), a.duration || 0);
  }, []);

  useEffect(() => {
    const a = el();
    if (!a) return;
    a.volume = volume;
    a.muted = muted;
  }, [volume, muted, url]);

  useEffect(() => {
    const a = el();
    if (a) a.playbackRate = speed;
  }, [speed, url]);

  // Media Session (OS-level next/prev/pause).
  useEffect(() => {
    if (!('mediaSession' in navigator) || !current) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({ title: current.name, artist: 'Vendra Music' });
      navigator.mediaSession.setActionHandler('play', togglePlay);
      navigator.mediaSession.setActionHandler('pause', togglePlay);
      navigator.mediaSession.setActionHandler('previoustrack', prev);
      navigator.mediaSession.setActionHandler('nexttrack', next);
    } catch { /* ignore */ }
  }, [current, togglePlay, prev, next]);

  // ---- visualizer ----------------------------------------------------------------
  useEffect(() => {
    if (!showViz) {
      if (vizRaf.current) cancelAnimationFrame(vizRaf.current);
      return;
    }
    const canvas = canvasRef.current;
    const draw = () => {
      vizRaf.current = requestAnimationFrame(draw);
      const g = wa.current;
      if (!canvas) return;
      const ctx2d = canvas.getContext('2d');
      if (!ctx2d) return;
      const W = canvas.width;
      const H = canvas.height;
      ctx2d.clearRect(0, 0, W, H);
      if (!g || !playing) {
        ctx2d.fillStyle = 'rgba(128,128,128,0.25)';
        const bw = W / 48;
        for (let i = 0; i < 48; i += 1) {
          const h = 3 + Math.abs(Math.sin(i * 0.7)) * 6;
          ctx2d.fillRect(i * bw + 1, H - h, bw - 2, h);
        }
        return;
      }
      const data = new Uint8Array(g.analyser.frequencyBinCount);
      g.analyser.getByteFrequencyData(data);
      const bars = 48;
      const bw = W / bars;
      const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#c2410c';
      ctx2d.fillStyle = accent;
      for (let i = 0; i < bars; i += 1) {
        const v = data[Math.floor((i / bars) * data.length * 0.8)] / 255;
        const h = Math.max(2, v * H);
        ctx2d.fillRect(i * bw + 1, H - h, bw - 2, h);
      }
    };
    draw();
    return () => {
      if (vizRaf.current) cancelAnimationFrame(vizRaf.current);
    };
  }, [showViz, playing]);

  // ---- drag & drop -----------------------------------------------------------------
  const onDrop = useCallback((e) => {
    e.preventDefault();
    setDragOver(false);
    const files = Array.from(e.dataTransfer?.files || []);
    if (files.length === 0) return;
    const adds = files
      .filter((f) => AUDIO_EXT.test(f.name) || (f.type || '').startsWith('audio/'))
      .map((f) => ({ name: f.name, url: URL.createObjectURL(f), external: true }));
    if (adds.length === 0) {
      push('Error', 'No playable audio files in that drop.');
      return;
    }
    // setState is not allowed inside another setState updater — play the
    // first dropped file using the latest playlist length from the ref.
    setIndex(playlistRef.current.length);
    setPlaylist((prev) => [...prev, ...adds]);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      ensureGraph()?.ctx.resume?.().catch(() => {});
      safePlay(el());
    }));
  }, [push, ensureGraph]);

  // ---- keyboard ----------------------------------------------------------------------
  useEffect(() => {
    const onKey = (e) => {
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
      const k = e.key;
      if (k === ' ') { e.preventDefault(); togglePlay(); }
      else if (k === 'ArrowRight') seekBy(e.shiftKey ? 30 : 5);
      else if (k === 'ArrowLeft') seekBy(e.shiftKey ? -30 : -5);
      else if (k === 'ArrowUp') { e.preventDefault(); setVolume((v) => Math.min(1, +(v + 0.05).toFixed(2))); }
      else if (k === 'ArrowDown') { e.preventDefault(); setVolume((v) => Math.max(0, +(v - 0.05).toFixed(2))); }
      else if (k === 'm' || k === 'M') setMuted((m) => !m);
      else if (k === 'n' || k === 'N') next();
      else if (k === 'p' || k === 'P') prev();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [togglePlay, seekBy, next, prev]);

  const applyPreset = (name) => {
    setPreset(name);
    setGains([...PRESETS[name]]);
    setEqOn(true);
  };
  const setBand = (i, v) => {
    setPreset('Custom');
    setEqOn(true);
    setGains((g) => {
      const n = [...g];
      n[i] = v;
      return n;
    });
  };

  const ctl =
    'flex min-h-[44px] min-w-[44px] items-center justify-center rounded-os px-2 text-ink transition-colors duration-160 hover:bg-surface disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent';
  const extBtn =
    'flex min-h-[44px] items-center gap-1.5 rounded-os border border-osborder bg-paper px-2.5 text-xs transition-colors duration-160 hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent';
  const seekPct = duration > 0 ? (time / duration) * 100 : 0;

  return (
    <div
      className="flex h-full flex-col bg-paper text-ink"
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
    >
      {/* No <audio> element until there is a real track URL: an empty src
          makes the element try to load the page itself and fires onError. */}
      {url ? (
      <audio
        ref={audioRef}
        src={url}
        crossOrigin="anonymous"
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onTimeUpdate={onTimeUpdate}
        onLoadedMetadata={(e) => {
          setDuration(e.currentTarget.duration || 0);
          e.currentTarget.playbackRate = speed;
        }}
        onEnded={onEnded}
        onError={() => setLoadError('This audio file could not be played.')}
      />
      ) : null}
      <div className="flex min-h-0 flex-1">
        {/* Main column */}
        <div className="flex min-w-0 flex-1 flex-col">
          {/* Now playing + visualizer */}
          <div className="relative flex min-h-0 flex-1 flex-col items-center justify-center gap-2 overflow-hidden bg-surface p-4">
            <AudioLines size={36} className="text-muted" />
            <p className="max-w-full truncate px-4 text-center text-base font-medium">
              {current ? current.name : 'Nothing playing'}
            </p>
            {loadError && current && (
              <div className="flex items-center gap-2">
                <p className="text-xs text-red-700">{loadError}</p>
                <button
                  type="button"
                  onClick={() => next()}
                  className="flex min-h-[44px] items-center rounded-os border border-osborder bg-paper px-3 text-xs text-ink transition-colors duration-160 hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                >
                  Next track
                </button>
              </div>
            )}
            <p className="text-xs tabular-nums text-muted">
              {formatTime(time)} / {formatTime(duration)}
              {speed !== 1 ? ` · ${speed}×` : ''}
              {ab ? ` · loop ${formatTime(ab.a)}–${formatTime(ab.b)}` : ''}
            </p>
            {showViz && (
              <canvas ref={canvasRef} width={480} height={90} className="mt-1 h-[90px] w-full max-w-xl" aria-hidden="true" />
            )}
            {dragOver && (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center border-4 border-dashed border-accent bg-ink/50">
                <p className="text-lg font-medium text-white">Drop audio files to play</p>
              </div>
            )}
          </div>

          {/* Seek */}
          <div className="flex items-center gap-2 border-t border-osborder bg-surface px-3 pt-2">
            <span className="w-12 shrink-0 text-right text-xs tabular-nums text-muted">{formatTime(time)}</span>
            <input
              type="range"
              min={0}
              max={duration || 0}
              step={0.1}
              value={Math.min(time, duration || 0)}
              onChange={(e) => { const a = el(); if (a) a.currentTime = Number(e.target.value); }}
              aria-label="Seek"
              className="h-2 min-h-0 flex-1 cursor-pointer accent-accent"
            />
            <span className="w-12 shrink-0 text-xs tabular-nums text-muted">{formatTime(duration)}</span>
          </div>

          {/* Controls */}
          <div className="flex flex-wrap items-center gap-0.5 border-b border-osborder bg-surface px-3 pb-2">
            <button type="button" onClick={() => setShuffle((s) => !s)} title="Shuffle" aria-label="Shuffle" aria-pressed={shuffle} className={`${ctl} ${shuffle ? 'text-accent' : ''}`}>
              <Shuffle size={17} />
            </button>
            <button type="button" onClick={prev} title="Previous (P)" aria-label="Previous" className={ctl} disabled={playlist.length === 0}>
              <SkipBack size={19} />
            </button>
            <button type="button" onClick={togglePlay} title="Play/Pause (Space)" aria-label={playing ? 'Pause' : 'Play'} className={ctl} disabled={!url}>
              {playing ? <Pause size={22} /> : <Play size={22} />}
            </button>
            <button type="button" onClick={stop} title="Stop" aria-label="Stop" className={ctl} disabled={!url}>
              <Square size={16} />
            </button>
            <button type="button" onClick={next} title="Next (N)" aria-label="Next" className={ctl} disabled={playlist.length === 0}>
              <SkipForward size={19} />
            </button>
            <button
              type="button"
              onClick={() => setRepeat((r) => (r === 'off' ? 'all' : r === 'all' ? 'one' : 'off'))}
              title={`Repeat: ${repeat}`}
              aria-label="Repeat mode"
              className={`${ctl} ${repeat !== 'off' ? 'text-accent' : ''}`}
            >
              {repeat === 'one' ? <Repeat1 size={17} /> : <Repeat size={17} />}
            </button>
            <span className="mx-1 hidden h-6 w-px bg-osborder sm:block" />
            <button type="button" onClick={() => setMuted((m) => !m)} title="Mute (M)" aria-label={muted ? 'Unmute' : 'Mute'} className={ctl}>
              {muted || volume === 0 ? <VolumeX size={18} /> : <Volume2 size={18} />}
            </button>
            <input
              type="range" min={0} max={1} step={0.05}
              value={muted ? 0 : volume}
              onChange={(e) => { setMuted(false); setVolume(Number(e.target.value)); }}
              aria-label="Volume" title="Volume (↑/↓)"
              className="h-2 w-24 min-h-0 cursor-pointer accent-accent"
            />
            <span className="min-w-0 flex-1" />
            <button type="button" onClick={() => setShowViz((v) => !v)} title="Toggle visualizer" aria-label="Toggle visualizer" aria-pressed={showViz} className={`${ctl} ${showViz ? 'text-accent' : ''}`}>
              <AudioLines size={17} />
            </button>
            <button
              type="button"
              onClick={() => setShowEq((s) => !s)}
              title="Equalizer"
              aria-label="Equalizer"
              aria-expanded={showEq}
              className={`${ctl} ${showEq ? 'text-accent' : ''}`}
            >
              <Gauge size={17} />
            </button>
            <button
              type="button"
              onClick={() => setShowSidebar((s) => !s)}
              title="Toggle playlist"
              aria-label="Toggle playlist"
              className={`${ctl} ${showSidebar ? 'text-accent' : ''}`}
            >
              <ListMusic size={18} />
            </button>
          </div>

          {/* EQ panel */}
          {showEq && (
            <div className="border-b border-osborder bg-paper p-3">
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => setEqOn((o) => !o)}
                  aria-pressed={eqOn}
                  title="Turn the equalizer on or off (if you hear no sound on a network file, try turning it off)"
                  className={`flex min-h-[44px] items-center gap-1.5 rounded-os px-3 text-sm font-medium ${eqOn ? 'bg-accent text-white' : 'border border-osborder'}`}
                >
                  EQ {eqOn ? 'on' : 'off'}
                </button>
                <select
                  value={preset}
                  onChange={(e) => applyPreset(e.target.value)}
                  aria-label="EQ preset"
                  className="min-h-[44px] rounded-os border border-osborder bg-paper px-2 text-sm"
                >
                  {Object.keys(PRESETS).map((p) => (
                    <option key={p} value={p}>{p}</option>
                  ))}
                  {preset === 'Custom' && <option value="Custom">Custom</option>}
                </select>
                <button type="button" onClick={() => applyPreset('Flat')} className={extBtn}>
                  <X size={14} /> Flatten
                </button>
                <label className="flex min-h-[44px] items-center gap-2 text-xs" title="Playback speed">
                  <span className="font-medium uppercase tracking-wide text-muted">Speed</span>
                  <select
                    value={speed}
                    onChange={(e) => setSpeed(Number(e.target.value))}
                    aria-label="Playback speed"
                    className="min-h-[44px] rounded-os border border-osborder bg-paper px-2 text-sm"
                  >
                    {SPEEDS.map((s) => (
                      <option key={s} value={s}>{s}×</option>
                    ))}
                  </select>
                </label>
                <span className="text-xs font-medium uppercase tracking-wide text-muted">A-B</span>
                <button
                  type="button"
                  onClick={() => { const a = el(); if (a) { setAbMark(a.currentTime); setAb(null); } }}
                  title="Set loop start (A)"
                  className={`${extBtn} ${abMark != null && !ab ? 'border-accent text-accent' : ''}`}
                >
                  A{abMark != null ? ` ${formatTime(abMark)}` : ''}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const a = el();
                    if (a && abMark != null && a.currentTime > abMark) {
                      setAb({ a: abMark, b: a.currentTime });
                      setAbMark(null);
                    }
                  }}
                  disabled={abMark == null}
                  title="Set loop end (B)"
                  className={extBtn}
                >
                  B
                </button>
                {(ab || abMark != null) && (
                  <button type="button" onClick={() => { setAb(null); setAbMark(null); }} title="Clear A-B loop" className={extBtn}>
                    <X size={14} /> {ab ? `${formatTime(ab.a)}–${formatTime(ab.b)}` : 'Clear'}
                  </button>
                )}
              </div>
              <div className="grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-2">
                {BANDS.map((freq, i) => (
                  <label key={freq} className="flex items-center gap-2 text-xs">
                    <span className="w-14 shrink-0 tabular-nums text-muted">
                      {freq >= 1000 ? `${freq / 1000}k` : freq}
                    </span>
                    <input
                      type="range"
                      min={-12}
                      max={12}
                      step={1}
                      value={gains[i]}
                      onChange={(e) => setBand(i, Number(e.target.value))}
                      aria-label={`${freq} Hz band`}
                      className="h-2 min-h-0 flex-1 cursor-pointer accent-accent"
                    />
                    <span className="w-12 shrink-0 text-right tabular-nums text-muted">
                      {gains[i] > 0 ? `+${gains[i]}` : gains[i]} dB
                    </span>
                  </label>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Sidebar */}
        {showSidebar && (
          <div className="flex w-60 shrink-0 flex-col border-l border-osborder bg-surface">
            <div className="flex border-b border-osborder text-sm">
              {['playlist', 'recent'].map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setSideTab(t)}
                  className={`min-h-[44px] flex-1 px-2 capitalize ${sideTab === t ? 'border-b-2 border-accent font-medium text-ink' : 'text-muted hover:text-ink'}`}
                >
                  {t}
                </button>
              ))}
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {sideTab === 'playlist' ? (
                <>
                  {scanError && <p className="p-3 text-xs text-red-700">{scanError}</p>}
                  {loading && <p className="p-3 text-xs text-muted">Scanning…</p>}
                  {!loading && playlist.length === 0 && (
                    <div className="flex flex-col items-center gap-2 p-4 text-center">
                      <p className="text-xs text-muted">No music found. Upload audio files in Files, or drop them here.</p>
                      <button
                        type="button"
                        onClick={() => openWindow('files')}
                        className="flex min-h-[44px] items-center gap-1.5 rounded-os bg-accent px-3 text-xs font-medium text-white"
                      >
                        <FolderOpen size={14} /> Open Files
                      </button>
                    </div>
                  )}
                  {playlist.map((p, i) => (
                    <button
                      key={`${p.path || p.url}-${i}`}
                      type="button"
                      onClick={() => playAt(i)}
                      className={`flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm ${i === index ? 'bg-accent/10 font-medium text-ink' : 'hover:bg-paper'}`}
                    >
                      {i === index && playing
                        ? <Pause size={14} className="shrink-0 text-accent" />
                        : <Play size={14} className="shrink-0 text-muted" />}
                      <span className="min-w-0 flex-1 truncate">{p.name}</span>
                      {p.external && <span className="shrink-0 text-[10px] uppercase text-muted">dropped</span>}
                    </button>
                  ))}
                </>
              ) : (
                <>
                  {recent.length === 0 && <p className="p-3 text-xs text-muted">Nothing played yet.</p>}
                  {recent.map((h) => (
                    <button
                      key={h.path}
                      type="button"
                      onClick={async () => {
                        const i = playlist.findIndex((p) => p.path === h.path);
                        if (i >= 0) playAt(i);
                        else {
                          try {
                            await mediaUrl(h.path);
                            setPlaylist((prev) => [...prev, { name: h.name, path: h.path }]);
                            setIndex(playlist.length);
                          } catch {
                            push('Error', 'That file is no longer available.');
                          }
                        }
                      }}
                      className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm hover:bg-paper"
                    >
                      <History size={14} className="shrink-0 text-muted" />
                      <span className="min-w-0 flex-1 truncate">{h.name}</span>
                      <ChevronRight size={14} className="shrink-0 text-muted" />
                    </button>
                  ))}
                </>
              )}
            </div>
            <button
              type="button"
              onClick={() => setTick((t) => t + 1)}
              className="flex min-h-[44px] items-center justify-center gap-1.5 border-t border-osborder text-xs text-muted hover:text-ink"
            >
              Rescan library
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
