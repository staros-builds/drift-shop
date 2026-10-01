import { X, Loader2, Check, AlertCircle } from 'lucide-react';
import { useLang } from '../lib/i18n.jsx';

/**
 * The dedicated uploader queue card shown while (and after) files upload.
 *
 * Each job: { id, name, status: 'uploading'|'done'|'error', error, progress }
 *   progress: null  -> indeterminate (the local backend has no byte events,
 *                  so no fake percentage is ever shown)
 *   progress: 0..1  -> REAL cloud upload percentage from xhr upload events
 */
export function UploadJobsPanel({ jobs, onDismiss }) {
  const { t } = useLang();
  if (!jobs || jobs.length === 0) return null;
  return (
    <div
      role="status"
      aria-label={t('files.uploads.status')}
      className="absolute bottom-3 left-3 z-40 w-72 max-w-[calc(100%-1.5rem)] rounded-os border border-osborder bg-surface shadow-win"
    >
      <div className="flex items-center justify-between border-b border-osborder px-3 py-2">
        <p className="text-sm font-medium text-ink">{t('files.uploads.title')}</p>
        <button
          type="button"
          onClick={onDismiss}
          aria-label={t('files.uploads.dismiss')}
          className="rounded-os p-1 text-muted transition-colors duration-160 hover:bg-paper hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          <X size={14} />
        </button>
      </div>
      <ul className="max-h-44 overflow-y-auto px-3 py-1">
        {jobs.map((job) => {
          const pct =
            typeof job.progress === 'number' ? Math.round(job.progress * 100) : null;
          return (
            <li key={job.id} className="py-1.5 text-sm">
              <div className="flex items-center gap-2">
                {job.status === 'uploading' && (
                  <Loader2 size={15} className="shrink-0 animate-spin text-accent" aria-hidden />
                )}
                {job.status === 'done' && (
                  <Check size={15} className="shrink-0 text-green-700 dark:text-green-400" aria-hidden />
                )}
                {job.status === 'error' && (
                  <AlertCircle size={15} className="shrink-0 text-red-700 dark:text-red-400" aria-hidden />
                )}
                <span className="min-w-0 flex-1 truncate text-ink" title={job.name}>
                  {job.name}
                </span>
                <span className="shrink-0 text-xs text-muted">
                  {job.status === 'uploading'
                    ? pct != null
                      ? `${pct}%`
                      : t('files.uploads.uploading')
                    : job.status === 'done'
                      ? t('files.uploads.done')
                      : t('files.uploads.failed')}
                </span>
              </div>
              {job.status === 'uploading' && (
                <div
                  className="ml-6 mt-1 h-1.5 overflow-hidden rounded-full bg-paper"
                  role="progressbar"
                  aria-label={t('files.uploads.progress', { name: job.name })}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={pct != null ? pct : undefined}
                >
                  {pct != null ? (
                    <div
                      className="h-full rounded-full bg-accent transition-[width] duration-200"
                      style={{ width: `${pct}%` }}
                    />
                  ) : (
                    <div className="h-full w-1/3 animate-pulse rounded-full bg-accent" />
                  )}
                </div>
              )}
              {job.status === 'error' && job.error && (
                <p className="ml-6 mt-0.5 break-words text-xs text-red-700 dark:text-red-400">
                  {job.error}
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
