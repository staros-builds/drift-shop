import { useEffect, useRef, useState } from 'react';
import {
  FileText, ZoomIn, ZoomOut, Download, ExternalLink,
  RefreshCw, FolderOpen, Loader2, TriangleAlert,
} from 'lucide-react';
import { backend } from '../lib/backend/current.js';
import { useWindows } from '../os/WindowsContext.jsx';
import { useLang } from '../lib/i18n.jsx';
import { baseOf } from './mediaLib.js';

const ZOOM_MIN = 25;
const ZOOM_MAX = 400;
const ZOOM_STEP = 25;
const PDF_LOAD_TIMEOUT_MS = 30000; // 30s: corrupt/wrong-MIME PDFs may never fire onLoad

/**
 * Fires onTimeout if the PDF iframe hasn't loaded within PDF_LOAD_TIMEOUT_MS.
 * Prevents an infinite loading spinner on corrupt files.
 */
function PdfLoadTimeout({ onTimeout }) {
  useEffect(() => {
    const timer = setTimeout(onTimeout, PDF_LOAD_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [onTimeout]);
  return null;
}

/**
 * PDF Viewer. Opens { path } (e.g. from Files via openWindow('pdfviewer',
 * { path })) in Chromium's native PDF viewer.
 *
 * URL ownership: unlike mediaLib.mediaUrl() (which caches and never
 * revokes), this component calls backend.files.fileUrl() directly so the
 * returned URL belongs to this window. Only blob: URLs are revoked, on
 * path change and unmount (SettingsApp export pattern).
 */
export default function PdfViewerApp({ windowApi, path }) {
  const { t } = useLang();
  const { openWindow } = useWindows();
  const [rec, setRec] = useState(null); // { url, mime, name }
  const [status, setStatus] = useState(path ? 'loading' : 'empty');
  const [frameReady, setFrameReady] = useState(false);
  const [zoom, setZoom] = useState(100);
  const [reloadKey, setReloadKey] = useState(0);
  const [retryTick, setRetryTick] = useState(0);
  const urlRef = useRef(null);

  useEffect(() => {
    if (!path) {
      setStatus('empty');
      setRec(null);
      return;
    }
    let cancelled = false;
    setStatus('loading');
    setFrameReady(false);
    setRec(null);
    backend.files
      .fileUrl(path)
      .then((r) => {
        if (cancelled) return;
        urlRef.current = r?.url || null;
        setRec(r);
        setStatus('ready');
      })
      .catch(() => {
        if (!cancelled) setStatus('error');
      });
    return () => {
      cancelled = true;
      const u = urlRef.current;
      urlRef.current = null;
      if (u && u.startsWith('blob:')) {
        try {
          URL.revokeObjectURL(u);
        } catch {
          /* already revoked — ignore */
        }
      }
    };
  }, [path, retryTick]);

  const name = rec?.name || (path ? baseOf(path) : '');

  useEffect(() => {
    windowApi?.setTitle?.(name ? t('pdfviewer.titleWith', { name }) : t('apps.pdfviewer'));
  }, [name, windowApi, t]);

  const bumpZoom = (dir) =>
    setZoom((z) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z + dir * ZOOM_STEP)));

  // Chromium's native viewer honors #zoom=NN on the fragment.
  const src = rec ? `${rec.url.split('#')[0]}#zoom=${zoom}` : '';

  const barBtn =
    'flex min-h-[44px] min-w-[44px] items-center justify-center rounded-os px-2 text-sm transition-colors duration-160 hover:bg-paper disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent';

  // No file selected.
  if (status === 'empty') {
    return (
      <div className="flex h-full flex-col bg-paper text-ink">
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-os border border-osborder bg-surface text-muted">
            <FileText size={26} strokeWidth={1.75} />
          </span>
          <p className="text-sm font-medium">{t('pdfviewer.noPdf')}</p>
          <p className="max-w-xs text-sm text-muted">{t('pdfviewer.noPdfHint')}</p>
          <button
            type="button"
            onClick={() => openWindow('files')}
            className="mt-1 flex min-h-[44px] items-center gap-1.5 rounded-os bg-accent px-4 text-sm font-medium text-white transition-colors duration-160 hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            <FolderOpen size={15} /> {t('pdfviewer.openFiles')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-paper text-ink">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-1 border-b border-osborder bg-surface px-2 py-1.5">
        <span className="mx-1 min-w-0 flex-1 truncate text-sm font-medium" title={name}>
          {status === 'loading' ? t('pdfviewer.opening') : name}
        </span>
        {status === 'ready' && (
          <>
            <button type="button" onClick={() => bumpZoom(-1)} disabled={zoom <= ZOOM_MIN} title={t('pdfviewer.zoomOut')} aria-label={t('pdfviewer.zoomOut')} className={barBtn}>
              <ZoomOut size={17} />
            </button>
            <button
              type="button"
              onClick={() => setZoom(100)}
              title={t('pdfviewer.resetZoom')}
              aria-label={t('pdfviewer.resetZoomAria')}
              className={`${barBtn} min-w-[64px] text-muted`}
            >
              {zoom}%
            </button>
            <button type="button" onClick={() => bumpZoom(1)} disabled={zoom >= ZOOM_MAX} title={t('pdfviewer.zoomIn')} aria-label={t('pdfviewer.zoomIn')} className={barBtn}>
              <ZoomIn size={17} />
            </button>
            <a
              href={rec.url}
              download={name}
              title={t('pdfviewer.downloadPdf')}
              aria-label={t('pdfviewer.downloadPdf')}
              className={barBtn}
            >
              <Download size={17} />
            </a>
            <a
              href={rec.url}
              target="_blank"
              rel="noreferrer"
              title={t('pdfviewer.openNewTab')}
              aria-label={t('pdfviewer.openNewTab')}
              className={barBtn}
            >
              <ExternalLink size={17} />
            </a>
            <button
              type="button"
              onClick={() => {
                setFrameReady(false);
                setReloadKey((k) => k + 1);
              }}
              title={t('pdfviewer.reload')}
              aria-label={t('pdfviewer.reloadPdf')}
              className={barBtn}
            >
              <RefreshCw size={16} />
            </button>
          </>
        )}
      </div>

      {/* Stage */}
      <div className="relative min-h-0 flex-1 bg-white">
        {status === 'loading' && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-paper">
            <span className="flex h-14 w-14 items-center justify-center rounded-os border border-osborder bg-surface text-ink">
              <FileText size={26} strokeWidth={1.75} />
            </span>
            <p className="max-w-xs truncate text-sm font-medium">{name || t('pdfviewer.pdf')}</p>
            <p className="flex items-center gap-2 text-xs text-muted">
              <Loader2 size={14} className="animate-spin" /> {t('pdfviewer.loading')}
            </p>
          </div>
        )}

        {status === 'error' && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-paper p-6 text-center">
            <span className="flex h-14 w-14 items-center justify-center rounded-os border border-osborder bg-surface text-accent">
              <TriangleAlert size={26} strokeWidth={1.75} />
            </span>
            <p className="text-sm font-medium">{t('pdfviewer.errTitle')}</p>
            <div className="max-w-xs text-sm text-muted">
              <p className="mb-1">{t('pdfviewer.errTry')}</p>
              <ul className="list-disc space-y-0.5 pl-5 text-left">
                <li>{t('pdfviewer.errTip1')}</li>
                <li>{t('pdfviewer.errTip2')}</li>
                <li>{t('pdfviewer.errTip3')}</li>
              </ul>
            </div>
            <div className="mt-1 flex items-center gap-2">
              <button
                type="button"
                onClick={() => setRetryTick((t) => t + 1)}
                className="flex min-h-[44px] items-center gap-1.5 rounded-os border border-osborder bg-surface px-4 text-sm transition-colors duration-160 hover:bg-paper focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                <RefreshCw size={15} /> {t('pdfviewer.retry')}
              </button>
              <button
                type="button"
                onClick={() => openWindow('files')}
                className="flex min-h-[44px] items-center gap-1.5 rounded-os bg-accent px-4 text-sm font-medium text-white transition-colors duration-160 hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                <FolderOpen size={15} /> {t('pdfviewer.openFiles')}
              </button>
            </div>
          </div>
        )}

        {status === 'ready' && (
          <>
            <iframe
              key={`${src}::${reloadKey}`}
              src={src}
              title={name || t('pdfviewer.pdfDoc')}
              onLoad={() => setFrameReady(true)}
              className="h-full w-full border-0 bg-white"
            />
            {!frameReady && (
              <PdfLoadTimeout onTimeout={() => setStatus('error')} />
            )}
            {!frameReady && (
              <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-paper">
                <span className="flex h-14 w-14 items-center justify-center rounded-os border border-osborder bg-surface text-ink">
                  <FileText size={26} strokeWidth={1.75} />
                </span>
                <p className="max-w-xs truncate text-sm font-medium">{name}</p>
                <p className="flex items-center gap-2 text-xs text-muted">
                  <Loader2 size={14} className="animate-spin" /> {t('pdfviewer.loading')}
                </p>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
