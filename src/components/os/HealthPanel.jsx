import React, { useEffect, useRef } from 'react';
import { RefreshCw, CheckCircle2, AlertTriangle, XCircle, MinusCircle } from 'lucide-react';
import { useSystemHealth, HEALTH_META } from '../../os/SystemHealthContext.jsx';
import { useLang, localeTag } from '../../lib/i18n.jsx';

/**
 * HealthPanel: flyout showing the self-check details.
 * Opened from the taskbar status dot. Lists each check with
 * pass/warn/fail state, latency, and last-checked time.
 */

function CheckRow({ name, result }) {
  const { t } = useLang();
  if (!result) {
    return (
      <div className="flex items-center gap-2.5 py-1.5">
        <MinusCircle size={16} className="shrink-0 text-muted" />
        <span className="flex-1 text-sm text-muted">{name}</span>
        <span className="text-xs text-muted">{t('health.pending')}</span>
      </div>
    );
  }
  const Icon = result.ok ? (result.warning || result.slow ? AlertTriangle : CheckCircle2) : XCircle;
  const color = result.ok ? (result.warning || result.slow ? 'text-amber-500' : 'text-green-500') : 'text-red-500';
  let detail = '';
  if (result.ms != null) detail = `${result.ms} ms`;
  if (result.warning) detail = result.warning;
  if (result.slow && result.ok) detail = `${result.ms} ms (${t('health.slow')})`;
  if (!result.ok && result.error) detail = result.error;
  if (result.skipped) detail = t('health.skipped');

  return (
    <div className="flex items-center gap-2.5 py-1.5">
      <Icon size={16} className={`shrink-0 ${color}`} />
      <span className="flex-1 text-sm text-ink">{name}</span>
      <span className="max-w-40 truncate text-xs text-muted" title={detail}>{detail}</span>
    </div>
  );
}

export default function HealthPanel({ onClose, anchorRef }) {
  const ref = useRef(null);
  const { t } = useLang();
  const { status, results, lastChecked, checking, refresh } = useSystemHealth();
  const meta = HEALTH_META[status];

  useEffect(() => {
    ref.current?.focus();
    const onDown = (e) => {
      if (e.key === 'Escape') onClose();
    };
    const onPointer = (e) => {
      if (ref.current && !ref.current.contains(e.target) && !anchorRef?.current?.contains(e.target)) {
        onClose();
      }
    };
    window.addEventListener('keydown', onDown);
    window.addEventListener('pointerdown', onPointer);
    return () => {
      window.removeEventListener('keydown', onDown);
      window.removeEventListener('pointerdown', onPointer);
    };
  }, [onClose, anchorRef]);

  const statusLabel = t(meta.labelKey);
  const statusColor = status === 'ok' ? 'text-green-500' : status === 'warning' ? 'text-amber-500' : 'text-red-500';

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={t('health.title')}
      tabIndex={-1}
      className="w-72 rounded-os border border-osborder bg-surface p-3 shadow-win outline-none"
    >
      <div className="mb-1 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span
            className="h-3 w-3 rounded-full"
            style={{ backgroundColor: meta.dot, boxShadow: `0 0 6px ${meta.dot}` }}
            aria-hidden
          />
          <span className={`text-sm font-semibold ${statusColor}`}>{statusLabel}</span>
        </div>
        <button
          type="button"
          onClick={refresh}
          disabled={checking}
          aria-label={t('health.recheck')}
          title={t('health.recheck')}
          className="flex h-8 w-8 items-center justify-center rounded-os text-muted duration-160 hover:bg-paper hover:text-ink disabled:opacity-50"
        >
          <RefreshCw size={15} className={checking ? 'animate-spin' : ''} />
        </button>
      </div>

      {lastChecked && (
        <div className="mb-2 text-[11px] text-muted">
          {t('health.lastChecked')}: {lastChecked.toLocaleTimeString(localeTag())}
        </div>
      )}

      <div className="divide-y divide-osborder">
        <CheckRow name={t('health.checkBackend')} result={results?.backend} />
        <CheckRow name={t('health.checkAuth')} result={results?.auth} />
        <CheckRow name={t('health.checkDb')} result={results?.db} />
      </div>

      <div className="mt-2 text-[11px] leading-snug text-muted">
        {status === 'ok' && t('health.descOk')}
        {status === 'warning' && t('health.descWarning')}
        {status === 'error' && t('health.descError')}
      </div>
    </div>
  );
}
