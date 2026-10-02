import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Play, Pause, Square, SkipBack, SkipForward, Volume2, VolumeX,
  Maximize, Minimize, ListVideo, X, Camera, Captions, Repeat,
  StepForward, SlidersHorizontal, FolderOpen, History, ChevronRight, Download, Upload,
} from 'lucide-react';
import { backend } from '../lib/backend/current.js';
import { useNotifications } from '../os/NotificationsContext.jsx';
import { useWindows } from '../os/WindowsContext.jsx';
import { PromptDialog } from '../components/os/dialogs.jsx';
import {
  scanMedia, mediaUrl, safePlay, formatTime, baseOf,
  parseSrt, cueAt, pushHistory, getHistory, VIDEO_EXT,
} from './mediaLib.js';

const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];
const ASPECTS = [
  { id: 'fit', label: 'Fit' },
  { id: 'fill', label: 'Fill (crop)' },
  { id: 'stretch', label: 'Stretch' },
  { id: '16:9', label: '16:9' },
  { id: '4:3', label: '4:3' },
  { id: '1:1', label: '1:1' },
];
const VOL_KEY = 'drift:video:volume';

// Two playlist entries describe the same file when they share a storage path
// (library entries) or blob URL (dropped files) and a name.
const sameEntry = (a, b) =>
  !!a && !!b && (a.path || a.url) === (b.path || b.url) && a.name === b.name;

function aspectStyle(mode) {
  switch (mode) {
    case 'fill':
      return { width: '100%', height: '100%', objectFit: 'cover' };
    case 'stretch':
      return { width: '100%', height: '100%', objectFit: 'fill' };
    case '16:9':
      return { aspectRatio: '16 / 9', maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' };
    case '4:3':
      return { aspectRatio: '4 / 3', maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' };
    case '1:1':
      return { aspectRatio: '1 / 1', maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' };
    default:
      return { width: '100%', height: '100%', objectFit: 'contain' };
  }
}

export default function VideoApp({ windowApi, path: initialPath }) {
  const { push } = useNotifications();
  const { openWindow } = useWindows();
  const videoRef = useRef(null);
  const stageRef = useRef(null);
  const srtInputRef = useRef(null);
  const audioGraph = useRef(null); // { ctx, delay } for audio-delay

  const [playlist, setPlaylist] = useState([]); // { name, path?, url?, mime?, external? }
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
      const v = Number(localStorage.getItem(VOL_KEY));
      return Number.isFinite(v) && v >= 0 && v <= 1 ? v : 0.8;
    } catch {
      // storage blocked (private mode etc.) — fall back to a sane default
      return 0.8;
    }
  });
  const [muted, setMuted] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [ab, setAb] = useState(null); // { a, b } | null
  const [abMark, setAbMark] = useState(null); // pending A mark
  const [aspect, setAspect] = useState('fit');
  const [loopAll, setLoopAll] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showSidebar, setShowSidebar] = useState(true);
  const [showExtended, setShowExtended] = useState(false);
  const [sideTab, setSideTab] = useState('playlist'); // playlist | recent
  const [cues, setCues] = useState([]);
  const [subName, setSubName] = useState('');
  const [activeCue, setActiveCue] = useState(null);
  const [audioDelay, setAudioDelay] = useState(0); // ms, 0..1000
  const [dragOver, setDragOver] = useState(false);
  const [recent, setRecent] = useState(() => getHistory('video'));
  const [tick, setTick] = useState(0);
  const [loadTick, setLoadTick] = useState(0); // bump to retry a failed load
  const [saveLinkOpen, setSaveLinkOpen] = useState(false);
  // null | { phase:'downloading', received, total } | { phase:'saving' } | { phase:'error', message }
  const [saveStatus, setSaveStatus] = useState(null);
  const [selectName, setSelectName] = useState(null); // saved file to auto-select after rescan
  const uploadInputRef = useRef(null);
  const scanSeq = useRef(0);
  const playlistRef = useRef(playlist);

  const current = index >= 0 ? playlist[index] : null;
  playlistRef.current = playlist;

  // ---- library scan -------------------------------------------------------
  const scan = useCallback(async () => {
    const seq = ++scanSeq.current;
    setLoading(true);
    setScanError('');
    try {
      const found = await scanMedia(VIDEO_EXT);
      // A newer scan superseded this one — drop the stale result.
      if (scanSeq.current !== seq) return;
      setPlaylist((prev) => {
        const externals = prev.filter((p) => p.external);
        const next = [
          ...externals,
          ...found.map((e) => ({ name: e.name, path: e.path, mime: e.mime })),
        ];
        // Keep entry identity across no-op rescans so a rescan doesn't
        // restart playback or re-push history for the current item.
        if (next.length === prev.length && next.every((p, i) => sameEntry(p, prev[i]))) {
          return prev;
        }
        return next;
      });
    } catch (err) {
      if (scanSeq.current !== seq) return;
      setScanError(err?.message || 'Could not scan for videos.');
    } finally {
      if (scanSeq.current === seq) setLoading(false);
    }
  }, []);
  useEffect(() => { scan(); }, [scan, tick]);

  // ---- resolve + load the current item ------------------------------------
  useEffect(() => {
    if (!current) {
      setUrl('');
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
            pushHistory('video', current);
            setRecent(getHistory('video'));
          }
        }
      } catch (err) {
        if (live) setLoadError(err?.message || 'Could not load video.');
      }
    };
    go();
    return () => { live = false; };
  }, [current, loadTick]);

  // Deep-link: open a specific VFS path (Files / Helm can pass { path }).
  useEffect(() => {
    if (!initialPath || playlist.length === 0 || index !== -1) return;
    const i = playlist.findIndex((p) => p.path === initialPath);
    if (i >= 0) setIndex(i);
  }, [initialPath, playlist, index]);

  useEffect(() => {
    windowApi?.setTitle?.(current ? `Video — ${current.name}` : 'Video');
  }, [current, windowApi]);

  // ---- element wiring ------------------------------------------------------
  const video = () => videoRef.current;

  useEffect(() => {
    const v = video();
    if (!v) return;
    v.volume = muted ? 0 : volume;
  }, [volume, muted, url]);

  useEffect(() => {
    const v = video();
    if (v) v.playbackRate = speed;
  }, [speed, url]);

  useEffect(() => {
    try {
      localStorage.setItem(VOL_KEY, String(volume));
    } catch { /* ignore */ }
  }, [volume]);

  useEffect(() => {
    const onFs = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);

  const togglePlay = useCallback(() => {
    const v = video();
    if (!v || !url) return;
    if (v.paused) safePlay(v);
    else v.pause();
  }, [url]);

  const stop = useCallback(() => {
    const v = video();
    if (!v) return;
    v.pause();
    v.currentTime = 0;
  }, []);

  const playAt = useCallback((i) => {
    if (i < 0) return;
    setIndex(i);
    // autoplay after src swaps in
    requestAnimationFrame(() => requestAnimationFrame(() => safePlay(video())));
  }, []);

  const next = useCallback(() => {
    if (playlist.length === 0) return;
    playAt(index + 1 < playlist.length ? index + 1 : loopAll ? 0 : index);
  }, [index, playlist.length, loopAll, playAt]);

  const prev = useCallback(() => {
    if (playlist.length === 0) return;
    const v = video();
    if (v && v.currentTime > 3) {
      v.currentTime = 0;
      return;
    }
    playAt(index - 1 >= 0 ? index - 1 : loopAll ? playlist.length - 1 : index);
  }, [index, playlist.length, loopAll, playAt]);

  const onEnded = useCallback(() => {
    setPlaying(false);
    if (index + 1 < playlist.length) playAt(index + 1);
    else if (loopAll && playlist.length > 0) playAt(0);
  }, [index, playlist.length, loopAll, playAt]);

  const onTimeUpdate = useCallback(() => {
    const v = video();
    if (!v) return;
    const t = v.currentTime;
    setTime(t);
    if (ab && t >= ab.b) v.currentTime = ab.a;
    setActiveCue(cues.length ? cueAt(cues, t) : null);
  }, [ab, cues]);

  const seekBy = useCallback((d) => {
    const v = video();
    if (!v || !Number.isFinite(v.duration)) return;
    v.currentTime = Math.min(Math.max(0, v.currentTime + d), v.duration || 0);
  }, []);

  const frameStep = useCallback(() => {
    const v = video();
    if (!v) return;
    v.pause();
    v.currentTime = Math.min(v.duration || 0, v.currentTime + 1 / 30);
  }, []);

  const toggleFullscreen = useCallback(() => {
    const el = stageRef.current;
    if (!el) return;
    if (document.fullscreenElement) {
      document.exitFullscreen?.().catch(() => {});
    } else {
      el.requestFullscreen?.().catch(() => push('Error', 'Fullscreen was blocked.'));
    }
  }, [push]);

  // ---- audio delay via Web Audio (engaged only when > 0) --------------------
  const setDelay = useCallback((ms) => {
    const v = video();
    setAudioDelay(ms);
    if (!v || ms <= 0) {
      if (audioGraph.current) {
        try {
          audioGraph.current.delay.delayTime.value = 0;
        } catch { /* ignore */ }
      }
      return;
    }
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) throw new Error('Web Audio is unavailable.');
      if (!audioGraph.current) {
        const ctx = new AC();
        const src = ctx.createMediaElementSource(v);
        const delay = ctx.createDelay(2.0);
        const gain = ctx.createGain();
        src.connect(delay);
        delay.connect(gain);
        gain.connect(ctx.destination);
        audioGraph.current = { ctx, delay };
      }
      const g = audioGraph.current;
      g.ctx.resume?.().catch(() => {});
      g.delay.delayTime.value = ms / 1000;
    } catch (err) {
      push('Error', `Audio delay unavailable: ${err?.message || err}`);
      setAudioDelay(0);
    }
  }, [push]);

  // ---- snapshot -------------------------------------------------------------
  const snapshot = useCallback(() => {
    const v = video();
    if (!v || !v.videoWidth) {
      push('Error', 'Nothing to capture yet.');
      return;
    }
    try {
      const canvas = document.createElement('canvas');
      canvas.width = v.videoWidth;
      canvas.height = v.videoHeight;
      canvas.getContext('2d').drawImage(v, 0, 0);
      canvas.toBlob(async (blob) => {
        if (!blob) {
          push('Error', 'Snapshot failed.');
          return;
        }
        try {
          await backend.files.mkdir('/Snapshots').catch(() => {});
          const stamp = new Date().toISOString().replace(/[:.]/g, '-');
          const dest = `/Snapshots/snapshot-${stamp}.png`;
          await backend.files.upload(dest, blob);
          push('Snapshot saved', `Saved to ${dest}.`);
        } catch (err) {
          push('Error', `Could not save snapshot: ${err?.message || err}`);
        }
      }, 'image/png');
    } catch (err) {
      push('Error', `Snapshot failed: ${err?.message || err}`);
    }
  }, [push]);

  // ---- subtitles -------------------------------------------------------------
  const loadSubtitles = useCallback(
    async (file) => {
      if (!file) return;
      try {
        const text = await file.text();
        const parsed = parseSrt(text);
        if (parsed.length === 0) {
          push('Error', 'No cues found in that subtitle file.');
          return;
        }
        setCues(parsed);
        setSubName(file.name);
        push('Subtitles', `Loaded ${parsed.length} cues from ${file.name}.`);
      } catch (err) {
        push('Error', `Could not read subtitles: ${err?.message || err}`);
      }
    },
    [push]
  );

  // ---- drag & drop ------------------------------------------------------------
  const onDrop = useCallback((e) => {
    e.preventDefault();
    setDragOver(false);
    const files = Array.from(e.dataTransfer?.files || []);
    if (files.length === 0) return;
    const adds = files
      .filter((f) => VIDEO_EXT.test(f.name) || (f.type || '').startsWith('video/'))
      .map((f) => ({ name: f.name, url: URL.createObjectURL(f), external: true }));
    if (adds.length === 0) {
      push('Error', 'No playable video files in that drop.');
      return;
    }
    // setState is not allowed inside another setState updater — play the
    // first dropped file using the latest playlist length from the ref.
    setIndex(playlistRef.current.length);
    setPlaylist((prev) => [...prev, ...adds]);
    requestAnimationFrame(() => requestAnimationFrame(() => safePlay(video())));
  }, [push]);

  // ---- save video from a direct link ------------------------------------------
  // Unique name inside /Videos (backend.files.upload overwrites on collision).
  const uniqueVideoName = useCallback(async (name) => {
    let existing = [];
    try {
      existing = await backend.files.list('/Videos');
    } catch {
      existing = [];
    }
    const taken = new Set(existing.map((e) => e.name));
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    let finalName = name;
    for (let n = 2; taken.has(finalName); n += 1) finalName = `${stem} (${n})${ext}`;
    return finalName;
  }, []);

  // Upload picked video files straight into /Videos (the mobile path —
  // drag & drop doesn't exist on phones).
  const uploadPickedVideos = useCallback(async (fileList) => {
    const files = Array.from(fileList || []).filter(
      (f) => VIDEO_EXT.test(f.name || '') || (f.type || '').startsWith('video/')
    );
    if (files.length === 0) {
      push('Error', 'No video files in that selection.');
      return;
    }
    let ok = 0;
    let firstPath = null;
    for (const f of files) {
      try {
        const clean = (f.name || 'video').replace(/\//g, '').slice(0, 80) || 'video';
        const finalName = await uniqueVideoName(clean);
        const dest = `/Videos/${finalName}`;
        await backend.files.upload(dest, f);
        if (!firstPath) firstPath = dest;
        ok += 1;
      } catch (err) {
        push('Error', `Couldn’t upload “${f.name}”: ${err?.message || 'upload failed.'}`);
      }
    }
    if (ok > 0) {
      if (firstPath) setSelectName(firstPath);
      setTick((t) => t + 1);
      push('Uploaded', `${ok} video${ok === 1 ? '' : 's'} added to your library.`);
    }
  }, [push, uniqueVideoName]);
  // Note: this intentionally works with direct video file links (MP4/WebM/…),
  // not YouTube — YouTube's terms forbid downloading, and grabbing its
  // streams would need a server this static build doesn't have.
  const saveFromLink = useCallback(async (raw) => {
    const input = (raw || '').trim();
    let u;
    try {
      u = new URL(input);
    } catch {
      setSaveStatus({ phase: 'error', message: 'That doesn’t look like a link — paste a full https:// address.' });
      return;
    }
    if (!/^https?:$/.test(u.protocol)) {
      setSaveStatus({ phase: 'error', message: 'Only http(s) links can be saved.' });
      return;
    }
    if (/(^|\.)youtube\.com$/.test(u.hostname) || /(^|\.)youtu\.be$/.test(u.hostname)) {
      setSaveStatus({
        phase: 'error',
        message: 'YouTube doesn’t allow its videos to be downloaded — this saver works with direct video file links (MP4, WebM, …).',
      });
      return;
    }
    setSaveStatus({ phase: 'downloading', received: 0, total: 0 });
    try {
      let res;
      try {
        res = await fetch(u.toString());
      } catch {
        throw new Error('Couldn’t download that link — the site blocks other apps from fetching its files, or you’re offline.');
      }
      if (!res.ok) throw new Error(`The link returned an error (${res.status}).`);
      const ct = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      if (!ct.startsWith('video/') && !VIDEO_EXT.test(u.pathname)) {
        throw new Error('That link doesn’t point to a video file — this saver works with direct MP4/WebM links.');
      }
      const total = Number(res.headers.get('content-length')) || 0;
      let blob;
      if (res.body && typeof res.body.getReader === 'function') {
        const reader = res.body.getReader();
        const chunks = [];
        let received = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          received += value.length;
          setSaveStatus({ phase: 'downloading', received, total });
        }
        blob = new Blob(chunks, { type: ct || 'video/mp4' });
      } else {
        blob = await res.blob();
      }
      if (blob.size === 0) throw new Error('The download came back empty.');

      // Filename: content-disposition wins, else the URL's last segment.
      let name = 'video';
      const cd = res.headers.get('content-disposition') || '';
      const cdm = cd.match(/filename\*?=(?:UTF-8''|")?([^";\n]+)/i);
      if (cdm) {
        try { name = decodeURIComponent(cdm[1].replace(/"/g, '').trim()); } catch { /* keep default */ }
      } else {
        const seg = u.pathname.split('/').filter(Boolean).pop();
        if (seg) name = decodeURIComponent(seg);
      }
      name = name.split('?')[0].replace(/\//g, '').slice(0, 80) || 'video';
      if (!VIDEO_EXT.test(name)) {
        name += ct === 'video/webm' ? '.webm' : ct === 'video/ogg' ? '.ogv' : '.mp4';
      }

      setSaveStatus({ phase: 'saving' });
      const finalName = await uniqueVideoName(name);

      await backend.files.upload(`/Videos/${finalName}`, blob);
      setSelectName(`/Videos/${finalName}`);
      setSaveStatus(null);
      setTick((t) => t + 1); // rescan the library; the effect below auto-selects
      push('Saved', `Saved “${finalName}” to your Videos.`);
    } catch (err) {
      setSaveStatus({ phase: 'error', message: err?.message || 'Couldn’t save that video.' });
    }
  }, [push, uniqueVideoName]);

  // After the rescan triggered by a save, jump to the new video.
  useEffect(() => {
    if (!selectName) return;
    const i = playlistRef.current.findIndex((p) => p.path === selectName);
    if (i >= 0) {
      setIndex(i);
      setSelectName(null);
    }
  }, [playlist, selectName]);

  // ---- keyboard shortcuts ------------------------------------------------------
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
      else if (k === 'f' || k === 'F') toggleFullscreen();
      else if (k === 'm' || k === 'M') setMuted((m) => !m);
      else if (k === 'n' || k === 'N') next();
      else if (k === 'p' || k === 'P') prev();
      else if (k === '[') setSpeed((s) => SPEEDS[Math.max(0, SPEEDS.indexOf(s) - 1)] ?? s);
      else if (k === ']') setSpeed((s) => SPEEDS[Math.min(SPEEDS.length - 1, (SPEEDS.indexOf(s) === -1 ? 3 : SPEEDS.indexOf(s)) + 1)] ?? s);
      else if (k === 's' || k === 'S') snapshot();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [togglePlay, seekBy, toggleFullscreen, next, prev, snapshot]);

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
      <div className="flex min-h-0 flex-1">
        {/* Stage */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div ref={stageRef} className="relative flex min-h-0 flex-1 items-center justify-center bg-black">
            {url ? (
              <video
                ref={videoRef}
                src={url}
                crossOrigin="anonymous"
                preload="metadata"
                playsInline
                style={aspectStyle(aspect)}
                className="max-h-full"
                onPlay={() => setPlaying(true)}
                onPause={() => setPlaying(false)}
                onTimeUpdate={onTimeUpdate}
                onLoadedMetadata={(e) => {
                  setDuration(e.currentTarget.duration || 0);
                  e.currentTarget.playbackRate = speed;
                }}
                onEnded={onEnded}
                onError={() => setLoadError('This video could not be played.')}
                onClick={togglePlay}
              />
            ) : (
              <div className="flex flex-col items-center gap-3 p-8 text-center">
                {loadError ? (
                  <>
                    <p className="text-sm text-red-400">{loadError}</p>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setLoadTick((t) => t + 1)}
                        className="flex min-h-[44px] items-center rounded-os bg-accent px-4 text-sm font-medium text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
                      >
                        Try again
                      </button>
                      <button
                        type="button"
                        onClick={() => next()}
                        className="flex min-h-[44px] items-center rounded-os border border-white/20 px-4 text-sm text-white/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
                      >
                        Next video
                      </button>
                    </div>
                    <p className="max-w-xs text-xs text-white/50">
                      If the file was moved or deleted, pick another video from the playlist.
                    </p>
                  </>
                ) : (
                  <>
                    <ListVideo size={40} className="text-white/40" />
                    <p className="text-sm font-medium text-white/80">
                      {loading ? 'Finding your videos…' : 'No video selected'}
                    </p>
                    <p className="max-w-xs text-xs text-white/50">
                      {playlist.length === 0 && !loading
                        ? 'Upload MP4/WebM files in the Files app — or drag and drop video files right here.'
                        : 'Pick a video from the playlist, or drag and drop files here to play them.'}
                    </p>
                  </>
                )}
              </div>
            )}
            {/* Subtitle overlay */}
            {activeCue && (
              <div className="pointer-events-none absolute inset-x-0 bottom-16 flex justify-center px-8">
                <p className="whitespace-pre-line rounded bg-black/70 px-3 py-1.5 text-center text-base text-white">
                  {activeCue.text}
                </p>
              </div>
            )}
            {dragOver && (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center border-4 border-dashed border-accent bg-ink/60">
                <p className="text-lg font-medium text-white">Drop videos to play</p>
              </div>
            )}
            {/* Save-from-link status */}
            {saveStatus && (
              <div className="absolute bottom-4 left-1/2 w-max max-w-[90%] -translate-x-1/2 rounded-os border border-osborder bg-surface px-4 py-3 text-ink shadow-os-win">
                {saveStatus.phase === 'error' ? (
                  <div className="flex max-w-xs flex-col gap-2">
                    <p className="text-sm font-medium">Couldn’t save that video</p>
                    <p className="text-xs text-muted">{saveStatus.message}</p>
                    <button
                      type="button"
                      onClick={() => setSaveStatus(null)}
                      className="self-end rounded-os border border-osborder px-3 py-1.5 text-xs hover:bg-paper"
                    >
                      Dismiss
                    </button>
                  </div>
                ) : (
                  <div className="flex w-64 flex-col gap-2">
                    <p className="text-sm font-medium">
                      {saveStatus.phase === 'saving' ? 'Saving to your Videos…' : 'Downloading…'}
                    </p>
                    <div className="h-2 overflow-hidden rounded-full bg-osborder">
                      {saveStatus.total > 0 ? (
                        <div
                          className="h-full rounded-full bg-accent transition-[width] duration-200"
                          style={{ width: `${Math.min(100, (saveStatus.received / saveStatus.total) * 100)}%` }}
                        />
                      ) : (
                        <div className="h-full w-1/3 animate-pulse rounded-full bg-accent" />
                      )}
                    </div>
                    <p className="text-xs tabular-nums text-muted">
                      {saveStatus.total > 0
                        ? `${(saveStatus.received / 1048576).toFixed(1)} of ${(saveStatus.total / 1048576).toFixed(1)} MB`
                        : saveStatus.phase === 'saving'
                          ? 'Almost done…'
                          : `${(saveStatus.received / 1048576).toFixed(1)} MB so far`}
                    </p>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Control bar */}
          <div className="border-t border-osborder bg-surface px-3 pb-2 pt-2">
            {/* Seek */}
            <div className="flex items-center gap-2">
              <span className="w-12 shrink-0 text-right text-xs tabular-nums text-muted">{formatTime(time)}</span>
              <input
                type="range"
                min={0}
                max={duration || 0}
                step={0.1}
                value={Math.min(time, duration || 0)}
                onChange={(e) => { const v = video(); if (v) v.currentTime = Number(e.target.value); }}
                aria-label="Seek"
                className="h-2 min-h-0 flex-1 cursor-pointer accent-accent"
                style={{ background: `linear-gradient(to right, var(--accent) ${seekPct}%, transparent ${seekPct}%)` }}
              />
              <span className="w-12 shrink-0 text-xs tabular-nums text-muted">{formatTime(duration)}</span>
            </div>
            {/* Buttons */}
            <div className="mt-1 flex flex-wrap items-center gap-0.5">
              <button type="button" onClick={togglePlay} title="Play/Pause (Space)" aria-label={playing ? 'Pause' : 'Play'} className={ctl} disabled={!url}>
                {playing ? <Pause size={20} /> : <Play size={20} />}
              </button>
              <button type="button" onClick={stop} title="Stop" aria-label="Stop" className={ctl} disabled={!url}>
                <Square size={16} />
              </button>
              <button type="button" onClick={prev} title="Previous (P)" aria-label="Previous" className={ctl} disabled={playlist.length === 0}>
                <SkipBack size={18} />
              </button>
              <button type="button" onClick={next} title="Next (N)" aria-label="Next" className={ctl} disabled={playlist.length === 0}>
                <SkipForward size={18} />
              </button>
              <span className="mx-1 hidden h-6 w-px bg-osborder sm:block" />
              <button
                type="button"
                onClick={() => setMuted((m) => !m)}
                title="Mute (M)"
                aria-label={muted ? 'Unmute' : 'Mute'}
                className={ctl}
              >
                {muted || volume === 0 ? <VolumeX size={18} /> : <Volume2 size={18} />}
              </button>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={muted ? 0 : volume}
                onChange={(e) => { setMuted(false); setVolume(Number(e.target.value)); }}
                aria-label="Volume"
                title="Volume (↑/↓)"
                className="h-2 w-24 min-h-0 cursor-pointer accent-accent"
              />
              <span className="mx-1 hidden h-6 w-px bg-osborder sm:block" />
              <button
                type="button"
                onClick={() => setLoopAll((l) => !l)}
                title="Loop playlist"
                aria-label="Loop playlist"
                aria-pressed={loopAll}
                className={`${ctl} ${loopAll ? 'text-accent' : ''}`}
              >
                <Repeat size={17} />
              </button>
              <button
                type="button"
                onClick={() => setShowExtended((s) => !s)}
                title="Extended controls (speed, A-B loop, aspect, snapshot, subtitles)"
                aria-label="Extended controls"
                aria-expanded={showExtended}
                className={`${ctl} ${showExtended ? 'text-accent' : ''}`}
              >
                <SlidersHorizontal size={17} />
              </button>
              <span className="min-w-0 flex-1" />
              <button
                type="button"
                onClick={() => uploadInputRef.current?.click()}
                title="Upload videos from this device into your library"
                aria-label="Upload videos"
                className={ctl}
              >
                <Upload size={18} />
              </button>
              <input
                ref={uploadInputRef}
                type="file"
                accept="video/*,.mkv"
                multiple
                className="hidden"
                onChange={(e) => { const picked = Array.from(e.target.files || []); e.target.value = ''; void uploadPickedVideos(picked); }}
              />
              <button
                type="button"
                onClick={() => { setSaveStatus(null); setSaveLinkOpen(true); }}
                title="Save video from link — paste a direct MP4/WebM link to download it into your library"
                aria-label="Save video from link"
                className={ctl}
              >
                <Download size={18} />
              </button>
              <button
                type="button"
                onClick={() => setShowSidebar((s) => !s)}
                title="Toggle playlist"
                aria-label="Toggle playlist"
                className={`${ctl} ${showSidebar ? 'text-accent' : ''}`}
              >
                <ListVideo size={18} />
              </button>
              <button type="button" onClick={toggleFullscreen} title="Fullscreen (F)" aria-label="Fullscreen" className={ctl}>
                {isFullscreen ? <Minimize size={18} /> : <Maximize size={18} />}
              </button>
            </div>

            {/* Extended panel */}
            {showExtended && (
              <div className="mt-2 flex flex-wrap items-center gap-2 rounded-os border border-osborder bg-paper p-2">
                <span className="text-xs font-medium uppercase tracking-wide text-muted">Speed</span>
                <button type="button" onClick={() => setSpeed((s) => SPEEDS[Math.max(0, SPEEDS.indexOf(s) - 1)] ?? s)} title="Slower ([)" aria-label="Slower" className={extBtn}>−</button>
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
                <button type="button" onClick={() => setSpeed((s) => SPEEDS[Math.min(SPEEDS.length - 1, SPEEDS.indexOf(s) + 1)] ?? s)} title="Faster (])" aria-label="Faster" className={extBtn}>+</button>

                <span className="mx-1 h-6 w-px bg-osborder" />
                <span className="text-xs font-medium uppercase tracking-wide text-muted">A-B</span>
                <button
                  type="button"
                  onClick={() => { const v = video(); if (v) { setAbMark(v.currentTime); setAb(null); } }}
                  title="Set loop start (A)"
                  className={`${extBtn} ${abMark != null && !ab ? 'border-accent text-accent' : ''}`}
                >
                  A{abMark != null ? ` ${formatTime(abMark)}` : ''}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const v = video();
                    if (v && abMark != null && v.currentTime > abMark) {
                      setAb({ a: abMark, b: v.currentTime });
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
                  <button type="button" onClick={() => { setAb(null); setAbMark(null); }} title="Clear A-B loop" aria-label="Clear loop" className={extBtn}>
                    <X size={14} /> {ab ? `${formatTime(ab.a)}–${formatTime(ab.b)}` : 'Clear'}
                  </button>
                )}

                <span className="mx-1 h-6 w-px bg-osborder" />
                <span className="text-xs font-medium uppercase tracking-wide text-muted">Aspect</span>
                <select
                  value={aspect}
                  onChange={(e) => setAspect(e.target.value)}
                  aria-label="Aspect ratio"
                  className="min-h-[44px] rounded-os border border-osborder bg-paper px-2 text-sm"
                >
                  {ASPECTS.map((a) => (
                    <option key={a.id} value={a.id}>{a.label}</option>
                  ))}
                </select>

                <button type="button" onClick={frameStep} title="Step one frame forward" className={extBtn}>
                  <StepForward size={15} /> Frame
                </button>
                <button type="button" onClick={snapshot} title="Take snapshot (S) — saves a PNG to /Snapshots" className={extBtn}>
                  <Camera size={15} /> Snapshot
                </button>
                <button type="button" onClick={() => srtInputRef.current?.click()} title="Load subtitle file (.srt)" className={`${extBtn} ${cues.length ? 'border-accent text-accent' : ''}`}>
                  <Captions size={15} /> {subName || 'Subtitles'}
                </button>
                {cues.length > 0 && (
                  <button type="button" onClick={() => { setCues([]); setSubName(''); }} title="Remove subtitles" aria-label="Remove subtitles" className={extBtn}>
                    <X size={14} />
                  </button>
                )}
                <label className="flex min-h-[44px] items-center gap-2 rounded-os border border-osborder bg-paper px-2.5 text-xs" title="Delay the audio to sync it with the picture">
                  <span className="font-medium uppercase tracking-wide text-muted">Audio delay</span>
                  <input
                    type="range"
                    min={0}
                    max={1000}
                    step={25}
                    value={audioDelay}
                    onChange={(e) => setDelay(Number(e.target.value))}
                    aria-label="Audio delay in milliseconds"
                    className="h-2 w-24 min-h-0 cursor-pointer accent-accent"
                  />
                  <span className="w-14 tabular-nums text-muted">{audioDelay}ms</span>
                </label>
                <input
                  ref={srtInputRef}
                  type="file"
                  accept=".srt"
                  className="hidden"
                  onChange={(e) => { loadSubtitles(e.target.files?.[0]); e.target.value = ''; }}
                />
              </div>
            )}
          </div>
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
                      <p className="text-xs text-muted">No videos found. Upload MP4/WebM files in Files, drop them here, or save one from a link.</p>
                      <div className="flex flex-wrap justify-center gap-2">
                        <button
                          type="button"
                          onClick={() => openWindow('files')}
                          className="flex min-h-[44px] items-center gap-1.5 rounded-os bg-accent px-3 text-xs font-medium text-white"
                        >
                          <FolderOpen size={14} /> Open Files
                        </button>
                        <button
                          type="button"
                          onClick={() => { setSaveStatus(null); setSaveLinkOpen(true); }}
                          className="flex min-h-[44px] items-center gap-1.5 rounded-os border border-osborder bg-paper px-3 text-xs text-ink"
                        >
                          <Download size={14} /> Save from link
                        </button>
                      </div>
                    </div>
                  )}
                  {playlist.map((p, i) => (
                    <button
                      key={`${p.path || p.url}-${i}`}
                      type="button"
                      onClick={() => playAt(i)}
                      className={`flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm ${i === index ? 'bg-accent/10 font-medium text-ink' : 'hover:bg-paper'}`}
                    >
                      {i === index && playing ? <Pause size={14} className="shrink-0 text-accent" /> : <Play size={14} className="shrink-0 text-muted" />}
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
                          // Re-add from VFS if it still exists.
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
      {saveLinkOpen && (
        <PromptDialog
          title="Save video from link"
          label="Direct link to a video file"
          placeholder="https://example.com/video.mp4"
          submitLabel="Save video"
          onSubmit={(v) => { setSaveLinkOpen(false); void saveFromLink(v); }}
          onCancel={() => setSaveLinkOpen(false)}
        />
      )}
    </div>
  );
}
