import React, { useEffect, useRef, useState } from 'react';
import {
  RotateCw, ExternalLink, CircleHelp, FileText, ArrowLeft, Loader2,
} from 'lucide-react';

/**
 * WebAppViewer: renders one installed web app — the site in a full-size
 * iframe. Sites that refuse framing (X-Frame-Options / CSP frame-ancestors)
 * get a plain-language panel, never jargon and never a blank window:
 * one short sentence, one big "Open in new tab", one "Try text version".
 * Receives the registry entry via the `appEntry` prop (entry.webApp).
 */

const LOAD_TIMEOUT_MS = 12000;

const chromeBtn =
  'flex shrink-0 items-center gap-1.5 rounded-os px-2 py-1.5 text-xs text-muted hover:bg-surface hover:text-ink disabled:opacity-40';

export default function WebAppViewer({ appEntry }) {
  const site = appEntry?.webApp;
  const [src, setSrc] = useState(site?.url || '');
  const [reloadKey, setReloadKey] = useState(0);
  // 'loading' | 'ready' | 'help' (framing-refusal panel) | 'stalled'
  const [status, setStatus] = useState('loading');
  const [textMode, setTextMode] = useState(null); // { original } when reading the text version
  const timerRef = useRef(null);

  const clearTimer = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  useEffect(() => clearTimer, []);

  // Every navigation (re)starts the loading watchdog: if the iframe never
  // reports a load, the page is probably refusing to be framed or the
  // network is down — say so in plain words instead of showing a blank box.
  useEffect(() => {
    if (!src) return;
    clearTimer();
    setStatus('loading');
    timerRef.current = setTimeout(() => {
      setStatus((s) => (s === 'loading' ? 'stalled' : s));
    }, LOAD_TIMEOUT_MS);
    return clearTimer;
  }, [src, reloadKey]);

  if (!site) {
    return (
      <div className="flex h-full items-center justify-center bg-paper p-6 text-center">
        <p className="text-sm text-muted">This web app is no longer in the catalog.</p>
      </div>
    );
  }

  const SiteIcon = site.icon;

  const handleLoad = () => {
    clearTimer();
    // Note: a framing refusal still fires onLoad in some browsers, so a
    // successful load event doesn't prove the page is visible — the
    // "Page isn't showing?" button is always available as the honest escape.
    setStatus((s) => (s === 'loading' ? 'ready' : s));
  };

  const reload = () => {
    setTextMode(null);
    setReloadKey((k) => k + 1);
  };

  const originalUrl = textMode?.original || src;

  const openExternal = () => {
    if (originalUrl) window.open(originalUrl, '_blank', 'noopener');
  };

  const tryTextVersion = () => {
    if (!originalUrl) return;
    setTextMode({ original: originalUrl });
    setSrc(`https://r.jina.ai/${originalUrl}`);
  };

  const backToOriginal = () => {
    if (textMode) {
      setSrc(textMode.original);
      setTextMode(null);
    } else {
      setStatus('loading');
      setReloadKey((k) => k + 1);
    }
  };

  const showHelp = () => setStatus('help');

  return (
    <div className="flex h-full flex-col bg-paper text-ink">
      {/* Viewer chrome */}
      <div className="flex items-center gap-1 border-b border-osborder bg-surface px-2 py-1">
        <span className="flex min-w-0 flex-1 items-center gap-2 px-1">
          {SiteIcon ? <SiteIcon size={15} className="shrink-0 text-muted" /> : null}
          <span className="truncate text-xs font-medium">{site.title}</span>
          {textMode && (
            <span className="shrink-0 rounded-full bg-accent/15 px-2 py-0.5 text-[10px] font-medium text-accent">
              Text version
            </span>
          )}
        </span>
        <button type="button" onClick={reload} aria-label="Reload" title="Reload" className={chromeBtn}>
          <RotateCw size={14} />
        </button>
        <button type="button" onClick={openExternal} aria-label="Open this site in a new browser tab" title="Open this site in a new browser tab" className={chromeBtn}>
          <ExternalLink size={14} /> <span className="hidden sm:inline">New tab</span>
        </button>
        <button
          type="button"
          onClick={showHelp}
          aria-label="The page isn't showing? Get options"
          title="The page isn't showing? Get options"
          className={chromeBtn}
        >
          <CircleHelp size={14} /> <span className="hidden sm:inline">Page isn&apos;t showing?</span>
        </button>
      </div>

      {/* Plain-language banner while reading the text version */}
      {textMode && (
        <div className="flex items-center gap-2 border-b border-osborder bg-accent/10 px-3 py-1.5">
          <FileText size={13} className="shrink-0 text-accent" />
          <p className="min-w-0 flex-1 truncate text-[11px] text-ink/80">
            You&apos;re reading a simplified text version — pictures, buttons and logins won&apos;t work here.
          </p>
          <button
            type="button"
            onClick={backToOriginal}
            className="flex shrink-0 items-center gap-1 rounded-os border border-osborder bg-paper px-2 py-1 text-[11px] hover:bg-surface"
          >
            <ArrowLeft size={12} /> Back to the real page
          </button>
        </div>
      )}

      {/* Body */}
      <div className="relative min-h-0 flex-1">
        {(status === 'help' || status === 'stalled') && (
          <div className="absolute inset-0 z-10 flex items-center justify-center overflow-y-auto bg-paper p-6">
            <div className="w-full max-w-sm text-center">
              {SiteIcon ? (
                <span className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-os border border-osborder bg-surface text-ink">
                  <SiteIcon size={26} strokeWidth={1.75} />
                </span>
              ) : null}
              <h3 className="text-base font-semibold">{site.title}</h3>
              <p className="mt-2 text-sm text-muted">
                {status === 'stalled'
                  ? 'This page is taking too long to appear — it may be refusing to load inside LFDD, or your connection may be down.'
                  : 'This site doesn\u2019t allow itself to be shown inside LFDD.'}
              </p>
              <p className="mt-1 text-xs text-muted">
                That&apos;s the site&apos;s choice — Drift can&apos;t override it. The full site works fine in a regular browser tab.
              </p>
              <button
                type="button"
                onClick={openExternal}
                className="mt-5 flex w-full items-center justify-center gap-2 rounded-os bg-accent px-4 py-3 text-sm font-semibold text-white hover:opacity-90"
              >
                <ExternalLink size={16} /> Open {site.title} in a new tab
              </button>
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  onClick={tryTextVersion}
                  className="flex flex-1 items-center justify-center gap-1.5 rounded-os border border-osborder bg-surface px-3 py-2 text-xs font-medium hover:bg-paper"
                >
                  <FileText size={13} /> Try text version
                </button>
                <button
                  type="button"
                  onClick={backToOriginal}
                  className="flex flex-1 items-center justify-center gap-1.5 rounded-os border border-osborder bg-surface px-3 py-2 text-xs font-medium hover:bg-paper"
                >
                  <RotateCw size={13} /> Try loading it again
                </button>
              </div>
            </div>
          </div>
        )}

        {status === 'loading' && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-paper">
            {SiteIcon ? (
              <span className="flex h-14 w-14 items-center justify-center rounded-os border border-osborder bg-surface text-ink">
                <SiteIcon size={26} strokeWidth={1.75} />
              </span>
            ) : null}
            <p className="text-sm font-medium">{site.title}</p>
            <p className="flex items-center gap-2 text-xs text-muted">
              <Loader2 size={14} className="animate-spin" /> Loading…
            </p>
          </div>
        )}

        <iframe
          key={`${src}::${reloadKey}`}
          src={src}
          title={site.title}
          onLoad={handleLoad}
          // Popups escape the sandbox into real browser tabs, so links that
          // open new windows behave like a normal browser. Top-level
          // navigation stays blocked (no allow-top-navigation): a link that
          // tries to break out simply won't — use "New tab" above instead.
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
          className="min-h-0 h-full w-full border-0 bg-white"
        />
      </div>
    </div>
  );
}
