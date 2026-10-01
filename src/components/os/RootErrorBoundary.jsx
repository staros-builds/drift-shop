import React from 'react';
import { useLang } from '../../lib/i18n.jsx';
import { DriftMark } from './BootScreen.jsx';

/**
 * Crash-loop SCRAM (nuclear failsafe).
 *
 * If the app crashes during boot 3+ times in a row, something is fundamentally
 * broken (corrupt localStorage, bad cached bundle, incompatible state). Instead
 * of crash-looping forever, we SCRAM into SAFE MODE: a minimal UI with
 * diagnostics and recovery options. The user is never stuck.
 *
 * Counters in localStorage:
 * - lfdd_crash_count: incremented on every caught crash, reset on clean boot
 * - lfdd_last_boot_ok: timestamp of last successful boot
 */
const CRASH_THRESHOLD = 3;
const CRASH_KEY = 'lfdd_crash_count';

export function getCrashCount() {
  try {
    return Number(localStorage.getItem(CRASH_KEY) || 0);
  } catch {
    return 0;
  }
}

export function recordCrash() {
  try {
    const n = getCrashCount() + 1;
    localStorage.setItem(CRASH_KEY, String(n));
    return n;
  } catch {
    return 0;
  }
}

export function recordCleanBoot() {
  try {
    localStorage.setItem(CRASH_KEY, '0');
    localStorage.setItem('lfdd_last_boot_ok', String(Date.now()));
  } catch {}
}

export function resetCrashCount() {
  try {
    localStorage.removeItem(CRASH_KEY);
  } catch {}
}

/**
 * Top-level crash catcher for the entire LFDD shell.
 *
 * If ANY uncaught error is thrown during render (login screen, desktop,
 * auth state transitions), React would otherwise unmount the whole tree
 * and leave a dead blank white page. This boundary catches it and shows
 * a localized recovery screen with a reload button — the app never dies
 * silently.
 *
 * Nuclear-facility rule: a crash is undesirable, but a SILENT crash that
 * leaves the user staring at a blank page with no recourse is unacceptable.
 */
class RootErrorBoundaryInner extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null, crashCount: 0 };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // Log for diagnostics; never show raw internals to the user.
    console.error('[lfdd] uncaught render error:', error, info?.componentStack);
    // SCRAM counter: track consecutive crashes for safe-mode tripping.
    const n = recordCrash();
    this.setState({ crashCount: n });
  }

  handleReload = () => {
    try {
      window.location.reload();
    } catch {}
  };

  handleReset = () => {
    // Clear the error and try to re-render from scratch. If the error
    // was transient (e.g. a bad auth state), this recovers without a
    // full page reload.
    this.setState({ error: null });
  };

  handleSafeMode = () => {
    // User opts into safe mode manually — set the counter to threshold
    // and reload so the App boots into SafeModeScreen.
    try {
      localStorage.setItem(CRASH_KEY, String(CRASH_THRESHOLD));
    } catch {}
    this.handleReload();
  };

  render() {
    if (!this.state.error) {
      return this.props.children;
    }
    // If we've crashed repeatedly, offer safe mode prominently.
    const showSafeMode = (this.state.crashCount || getCrashCount()) >= CRASH_THRESHOLD;
    return (
      <CrashScreen
        onReload={this.handleReload}
        onReset={this.handleReset}
        onSafeMode={this.handleSafeMode}
        showSafeMode={showSafeMode}
        crashCount={this.state.crashCount || getCrashCount()}
      />
    );
  }
}

function CrashScreen({ onReload, onReset, onSafeMode, showSafeMode, crashCount }) {
  const { t } = useLang();
  return (
    <div className="fixed inset-0 overflow-y-auto bg-paper">
      <div className="flex min-h-full items-center justify-center p-4">
        <div className="w-full max-w-sm rounded-os border border-osborder bg-surface p-5 shadow-os sm:p-8">
          <div className="flex flex-col items-center text-center">
            <span className="text-accent">
              <DriftMark size={36} />
            </span>
            <h1 className="mt-2 text-xl font-light tracking-tight text-ink">
              {t('crash.title')}
            </h1>
            <p className="mt-2 text-sm leading-relaxed text-muted">
              {t('crash.message')}
            </p>
            {crashCount >= 2 && (
              <p className="mt-2 rounded-os bg-red-50 px-3 py-1.5 text-xs text-red-700 dark:bg-red-950 dark:text-red-300">
                {t('crash.repeated', { n: crashCount })}
              </p>
            )}
          </div>
          <div className="mt-4 space-y-2">
            <button
              type="button"
              onClick={onReload}
              className="flex w-full items-center justify-center gap-2 rounded-os bg-accent px-4 py-2 text-sm font-semibold text-accentink duration-160 hover:opacity-90"
            >
              {t('crash.reload')}
            </button>
            {showSafeMode ? (
              <button
                type="button"
                onClick={onSafeMode}
                className="w-full rounded-os border-2 border-amber-500 bg-amber-50 px-4 py-2 text-sm font-semibold text-amber-800 duration-160 hover:bg-amber-100 dark:bg-amber-950 dark:text-amber-200"
              >
                {t('crash.safeMode')}
              </button>
            ) : (
              <button
                type="button"
                onClick={onReset}
                className="w-full rounded-os border border-osborder bg-paper px-4 py-2 text-sm font-medium text-ink duration-160 hover:border-accent"
              >
                {t('crash.tryAgain')}
              </button>
            )}
          </div>
          <p className="mt-4 text-center text-xs text-muted">
            © {new Date().getFullYear()} {t('brand.tagline')}
          </p>
        </div>
      </div>
    </div>
  );
}

export default function RootErrorBoundary({ children }) {
  return <RootErrorBoundaryInner>{children}</RootErrorBoundaryInner>;
}
