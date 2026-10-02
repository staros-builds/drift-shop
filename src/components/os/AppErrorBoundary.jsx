import React from 'react';
import { useLang } from '../../lib/i18n.jsx';
import { DriftMark } from './BootScreen.jsx';

/**
 * Reusable per-region error boundary ("bulkhead").
 *
 * The root boundary (RootErrorBoundary) catches crashes for the whole shell;
 * this one is mounted on individual surfaces — each desktop app window, the
 * login screen, the POS/punch kiosks, the POS kiosk overlay — so a crash in
 * one region shows a localized fallback with a retry button instead of
 * white-screening everything around it.
 *
 * Nuclear-facility rule: a crash is undesirable, but a SILENT crash that
 * leaves the user staring at a blank page with no recourse is unacceptable.
 *
 * Props:
 * - label: human-readable name of the region (used in the message)
 * - onError(error, info): optional — reported to the caller (e.g. a toast)
 */
function makeRef() {
  try {
    const t = Date.now().toString(36).toUpperCase();
    const r = crypto.getRandomValues(new Uint8Array(2));
    const hex = Array.from(r).map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
    return `RS-${t.slice(-5)}-${hex}`;
  } catch {
    return `RS-${Date.now().toString(36).toUpperCase()}`;
  }
}

class AppErrorBoundaryInner extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null, ref: null };
  }

  static getDerivedStateFromError(error) {
    return { error, ref: makeRef() };
  }

  componentDidCatch(error, info) {
    // Full details go to the console (with the reference the user sees),
    // never raw internals into the UI.
    console.error(`[driftshop] region crash (${this.props.label}, ref ${this.state.ref}):`, error, info?.componentStack);
    try {
      this.props.onError && this.props.onError(error, info);
    } catch {}
  }

  handleRetry = () => {
    this.setState({ error: null, ref: null });
  };

  handleReload = () => {
    try {
      window.location.reload();
    } catch {}
  };

  render() {
    const { error, ref } = this.state;
    if (!error) return this.props.children;
    const { strings, label } = this.props;
    return (
      <div className="flex h-full min-h-[240px] flex-col items-center justify-center gap-2 overflow-y-auto bg-surface p-6 text-center">
        <span className="text-accent">
          <DriftMark size={30} />
        </span>
        <p className="text-sm font-semibold text-ink">{strings.title}</p>
        <p className="max-w-md text-xs leading-relaxed text-muted">
          {strings.message.replace('{label}', label || 'this')}
        </p>
        <p
          className="max-w-md rounded-os bg-paper px-2.5 py-1 font-mono text-[11px] text-muted"
          title={strings.referenceHint}
        >
          {strings.reference}: {ref}
        </p>
        <div className="mt-1 flex flex-wrap items-center justify-center gap-2">
          <button
            type="button"
            onClick={this.handleRetry}
            className="rounded-os bg-accent px-4 py-1.5 text-sm font-semibold text-accentink duration-160 hover:opacity-90"
          >
            {strings.retry}
          </button>
          <button
            type="button"
            onClick={this.handleReload}
            className="rounded-os border border-osborder bg-paper px-4 py-1.5 text-sm font-medium text-ink duration-160 hover:border-accent"
          >
            {strings.reload}
          </button>
        </div>
      </div>
    );
  }
}

export default function AppErrorBoundary({ label, onError, children }) {
  const { t } = useLang();
  const strings = {
    title: t('resiliency.appCrash.title'),
    message: t('resiliency.appCrash.message'),
    retry: t('resiliency.appCrash.retry'),
    reload: t('resiliency.appCrash.reload'),
    reference: t('resiliency.appCrash.reference'),
    referenceHint: t('resiliency.appCrash.referenceHint'),
  };
  return (
    <AppErrorBoundaryInner label={label} onError={onError} strings={strings}>
      {children}
    </AppErrorBoundaryInner>
  );
}
