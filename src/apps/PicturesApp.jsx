import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Image as ImageIcon, ChevronLeft, ChevronRight, ZoomIn, ZoomOut,
  Maximize2, Play, Pause, X, RefreshCw, FolderOpen,
} from 'lucide-react';
import { backend } from '../lib/backend/current.js';
import { useNotifications } from '../os/NotificationsContext.jsx';
import { useLang } from '../lib/i18n.jsx';
import { useWindows } from '../os/WindowsContext.jsx';
import {
  scanMedia, mediaUrl, formatSize, IMAGE_EXT,
} from './mediaLib.js';

const SLIDE_DELAYS = [2000, 5000, 10000];

/** Thumbnail that resolves its own URL lazily (avoids N signed-URL requests up front). */
function Thumb({ entry, selected, onOpen }) {
  const [url, setUrl] = useState(null);
  useEffect(() => {
    let live = true;
    mediaUrl(entry.path)
      .then((r) => {
        if (live) setUrl(r.url);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [entry.path]);

  return (
    <button
      type="button"
      onClick={onOpen}
      title={entry.name}
      className={`group flex aspect-square flex-col overflow-hidden rounded-os border bg-surface transition-shadow duration-160 hover:shadow-win ${
        selected ? 'border-accent ring-2 ring-accent/40' : 'border-osborder'
      }`}
    >
      <span className="flex min-h-0 flex-1 items-center justify-center overflow-hidden">
        {url ? (
          <img
            src={url}
            alt={entry.name}
            loading="lazy"
            className="h-full w-full object-cover"
            draggable={false}
          />
        ) : (
          <ImageIcon size={28} className="text-muted" />
        )}
      </span>
      <span className="truncate px-2 py-1 text-left text-xs text-muted group-hover:text-ink">
        {entry.name}
      </span>
    </button>
  );
}

export default function PicturesApp({ windowApi, path: initialPath }) {
  const { t } = useLang();
  const { push } = useNotifications();
  const { openWindow } = useWindows();
  const [images, setImages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [viewIndex, setViewIndex] = useState(null); // null = grid
  const [viewUrl, setViewUrl] = useState('');
  const [zoom, setZoom] = useState(1);
  const [fit, setFit] = useState(true);
  const [dims, setDims] = useState(null);
  const [slideshow, setSlideshow] = useState(false);
  const [slideDelay, setSlideDelay] = useState(5000);
  const [refreshTick, setRefreshTick] = useState(0);
  const dragState = useRef(null);
  const viewToken = useRef(0); // guards openViewer against out-of-order resolves

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const found = await scanMedia(IMAGE_EXT);
      setImages(found);
    } catch (err) {
      setError(err?.message || 'Could not scan for pictures.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load, refreshTick]);

  // Open a specific file directly (e.g. from Files or Helm): { path } prop.
  useEffect(() => {
    if (!initialPath || images.length === 0) return;
    const i = images.findIndex((e) => e.path === initialPath);
    if (i >= 0) openViewer(i);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPath, images]);

  useEffect(() => {
    windowApi?.setTitle?.(
      viewIndex == null
        ? 'Pictures'
        : `Pictures — ${images[viewIndex]?.name || ''}`
    );
  }, [viewIndex, images, windowApi]);

  const openViewer = useCallback(
    async (i) => {
      const entry = images[i];
      if (!entry) return;
      const token = ++viewToken.current;
      setViewIndex(i);
      setZoom(1);
      setFit(true);
      setDims(null);
      setViewUrl('');
      try {
        const r = await mediaUrl(entry.path);
        // A faster tap can open the next picture while this one is still
        // resolving — drop the stale result so the URL always matches the index.
        if (viewToken.current !== token) return;
        setViewUrl(r.url);
      } catch (err) {
        if (viewToken.current !== token) return;
        push('Error', `Could not open picture: ${err?.message || err}`);
        setViewIndex(null);
      }
    },
    [images, push]
  );

  const step = useCallback(
    (dir) => {
      if (viewIndex == null || images.length === 0) return;
      openViewer((viewIndex + dir + images.length) % images.length);
    },
    [viewIndex, images, openViewer]
  );

  // Slideshow advance.
  useEffect(() => {
    if (!slideshow || viewIndex == null) return;
    const t = setInterval(() => step(1), slideDelay);
    return () => clearInterval(t);
  }, [slideshow, slideDelay, viewIndex, step]);

  // Keyboard: arrows navigate, +/- zoom, F fit, space slideshow, Esc close.
  useEffect(() => {
    if (viewIndex == null) return;
    const onKey = (e) => {
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
      if (e.key === 'ArrowRight') step(1);
      else if (e.key === 'ArrowLeft') step(-1);
      else if (e.key === '+' || e.key === '=') setZoom((z) => Math.min(8, +(z + 0.25).toFixed(2)));
      else if (e.key === '-' || e.key === '_') setZoom((z) => Math.max(0.25, +(z - 0.25).toFixed(2)));
      else if (e.key === '0') {
        setZoom(1);
        setFit(true);
      } else if (e.key === 'f' || e.key === 'F') setFit((f) => !f);
      else if (e.key === ' ') {
        e.preventDefault();
        setSlideshow((s) => !s);
      } else if (e.key === 'Escape') {
        setSlideshow(false);
        setViewIndex(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [viewIndex, step]);

  // Wheel zoom (ctrl/cmd) and pan by drag when zoomed.
  const onWheel = (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    setFit(false);
    setZoom((z) =>
      Math.min(8, Math.max(0.25, +(z * (e.deltaY < 0 ? 1.1 : 1 / 1.1)).toFixed(2)))
    );
  };
  const onPointerDown = (e) => {
    if (zoom <= 1) return;
    dragState.current = { x: e.clientX, y: e.clientY, sx: e.currentTarget.scrollLeft, sy: e.currentTarget.scrollTop };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e) => {
    const d = dragState.current;
    if (!d) return;
    e.currentTarget.scrollLeft = d.sx - (e.clientX - d.x);
    e.currentTarget.scrollTop = d.sy - (e.clientY - d.y);
  };
  const onPointerUp = () => {
    dragState.current = null;
  };

  const entry = viewIndex != null ? images[viewIndex] : null;
  const barBtn =
    'flex min-h-[44px] min-w-[44px] items-center justify-center rounded-os px-2 text-sm transition-colors duration-160 hover:bg-surface disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent';

  return (
    <div className="flex h-full flex-col bg-paper text-ink">
      {viewIndex == null ? (
        <>
          {/* Toolbar */}
          <div className="flex items-center justify-between border-b border-osborder bg-surface px-3 py-2">
            <p className="text-sm font-medium">
              {loading ? 'Scanning…' : `${images.length} picture${images.length === 1 ? '' : 's'}`}
            </p>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => openWindow('files')}
                className="flex min-h-[44px] items-center gap-1.5 rounded-os border border-osborder bg-paper px-3 text-sm transition-colors duration-160 hover:bg-surface"
              >
                <FolderOpen size={15} /> Open Files
              </button>
              <button
                type="button"
                onClick={() => setRefreshTick((t) => t + 1)}
                title={t('media.rescanPictures')}
                aria-label={t('media.rescan')}
                className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-os border border-osborder bg-paper transition-colors duration-160 hover:bg-surface"
              >
                <RefreshCw size={15} />
              </button>
            </div>
          </div>
          {/* Grid */}
          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            {error && <p className="py-8 text-center text-sm text-red-700">{error}</p>}
            {!error && loading && (
              <p className="py-8 text-center text-sm text-muted">Looking for pictures…</p>
            )}
            {!error && !loading && images.length === 0 && (
              <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
                <ImageIcon size={40} className="text-muted" />
                <p className="text-sm font-medium">No pictures yet</p>
                <p className="max-w-xs text-sm text-muted">
                  Upload images (PNG, JPG, GIF, WebP…) in the Files app and
                  they’ll show up here automatically.
                </p>
                <button
                  type="button"
                  onClick={() => openWindow('files')}
                  className="mt-1 flex min-h-[44px] items-center gap-1.5 rounded-os bg-accent px-4 text-sm font-medium text-white"
                >
                  <FolderOpen size={15} /> Open Files
                </button>
              </div>
            )}
            {images.length > 0 && (
              <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-5">
                {images.map((e, i) => (
                  <Thumb key={e.path} entry={e} onOpen={() => openViewer(i)} />
                ))}
              </div>
            )}
          </div>
        </>
      ) : (
        <>
          {/* Viewer toolbar */}
          <div className="flex flex-wrap items-center gap-1 border-b border-osborder bg-surface px-2 py-1.5">
            <button type="button" onClick={() => step(-1)} title={t('media.previous')} aria-label={t('media.previous')} className={barBtn}>
              <ChevronLeft size={18} />
            </button>
            <button type="button" onClick={() => step(1)} title={t('media.next')} aria-label={t('media.next')} className={barBtn}>
              <ChevronRight size={18} />
            </button>
            <span className="mx-1 hidden min-w-0 flex-1 truncate text-sm text-muted sm:block">
              {entry?.name}
              {dims ? ` · ${dims.w}×${dims.h}` : ''}
              {entry ? ` · ${formatSize(entry.size)}` : ''}
            </span>
            <button type="button" onClick={() => { setFit(false); setZoom((z) => Math.min(8, +(z + 0.25).toFixed(2))); }} title={t('media.zoomIn')} aria-label={t('media.zoomIn')} className={barBtn}>
              <ZoomIn size={17} />
            </button>
            <button type="button" onClick={() => { setFit(false); setZoom((z) => Math.max(0.25, +(z - 0.25).toFixed(2))); }} title={t('media.zoomOut')} aria-label={t('media.zoomOut')} className={barBtn}>
              <ZoomOut size={17} />
            </button>
            <button type="button" onClick={() => { setZoom(1); setFit((f) => !f); }} title={t('media.fitToScreen')} aria-label={t('media.fitToScreen')} className={barBtn}>
              <Maximize2 size={16} />
            </button>
            <select
              value={slideDelay}
              onChange={(e) => setSlideDelay(Number(e.target.value))}
              title={t('media.slideshowDelay')}
              aria-label={t('media.slideshowDelay')}
              className="min-h-[44px] rounded-os border border-osborder bg-paper px-2 text-sm text-ink"
            >
              {SLIDE_DELAYS.map((d) => (
                <option key={d} value={d}>{d / 1000}s</option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => setSlideshow((s) => !s)}
              title={slideshow ? 'Pause slideshow (Space)' : 'Start slideshow (Space)'}
              aria-label={slideshow ? 'Pause slideshow' : 'Start slideshow'}
              className={`${barBtn} ${slideshow ? 'text-accent' : ''}`}
            >
              {slideshow ? <Pause size={17} /> : <Play size={17} />}
            </button>
            <button
              type="button"
              onClick={() => { setSlideshow(false); setViewIndex(null); }}
              title={t('media.backToGrid')}
              aria-label={t('media.closeViewer')}
              className={barBtn}
            >
              <X size={17} />
            </button>
          </div>
          {/* Viewer stage */}
          <div
            className="relative min-h-0 flex-1 overflow-auto bg-black"
            onWheel={onWheel}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
          >
            <div className="flex min-h-full min-w-full items-center justify-center p-4">
              {viewUrl ? (
                <img
                  src={viewUrl}
                  alt={entry?.name || 'picture'}
                  draggable={false}
                  onLoad={(e) =>
                    setDims({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })
                  }
                  style={
                    fit
                      ? { maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }
                      : { transform: `scale(${zoom})`, transformOrigin: 'center center' }
                  }
                  className="select-none shadow-win"
                />
              ) : (
                <p className="text-sm text-white/70">Loading…</p>
              )}
            </div>
            {!fit && (
              <span className="absolute bottom-3 right-3 rounded-os bg-black/60 px-2 py-1 text-xs text-white">
                {Math.round(zoom * 100)}%
              </span>
            )}
          </div>
        </>
      )}
    </div>
  );
}
