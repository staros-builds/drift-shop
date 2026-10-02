import { useEffect, useId, useState } from 'react';
import { AlertTriangle, Check, Loader2, X } from 'lucide-react';
import { useLang } from '../../lib/i18n.jsx';

/**
 * Shared OS dialogs: ConfirmDialog, PromptDialog, and SaveStatePill.
 *
 * Presentational only — each call site owns its open/close state and renders
 * `{state && <ConfirmDialog ... />}`. The visual shell intentionally mirrors
 * the office DocDialogs modal so dialogs look native to the OS.
 */

const FOCUS_RING =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface';

function DialogShell({ title, titleId, danger, onClose, children }) {
  const { t } = useLang();
  // Escape closes; clicks on the backdrop (not the panel) close too.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-ink/30 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="w-full max-w-md rounded-os border border-osborder bg-surface shadow-win"
      >
        <div className="flex items-center justify-between border-b border-osborder px-4 py-3">
          <h3 id={titleId} className="flex items-center gap-2 text-sm font-semibold text-ink">
            {danger && <AlertTriangle size={16} className="shrink-0 text-red-700" aria-hidden="true" />}
            {title}
          </h3>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('dialogs.closeDialog')}
            className={`rounded-os p-1 text-muted hover:bg-paper hover:text-ink ${FOCUS_RING}`}
          >
            <X size={16} />
          </button>
        </div>
        <div className="p-4">{children}</div>
      </div>
    </div>
  );
}

/**
 * Yes/no confirmation. Initial focus lands on the safe (cancel) button —
 * always, including danger dialogs — so Enter never confirms destruction.
 */
export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  cancelLabel,
  danger = false,
  onConfirm,
  onCancel,
}) {
  const { t } = useLang();
  const titleId = useId();
  const confirmText = confirmLabel ?? t('dialogs.confirm');
  const cancelText = cancelLabel ?? t('dialogs.cancel');
  return (
    <DialogShell title={title} titleId={titleId} danger={danger} onClose={onCancel}>
      <p className="text-sm text-ink">{message}</p>
      <div className="mt-5 flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          // eslint-disable-next-line jsx-a11y/no-autofocus
          autoFocus
          className={`rounded-os border border-osborder px-3 py-1.5 text-sm text-ink hover:bg-paper ${FOCUS_RING}`}
        >
          {cancelText}
        </button>
        <button
          type="button"
          onClick={onConfirm}
          className={`rounded-os px-4 py-1.5 text-sm font-medium text-white ${FOCUS_RING} ${
            danger ? 'bg-red-700 hover:bg-red-800' : 'bg-accent'
          }`}
        >
          {confirmText}
        </button>
      </div>
    </DialogShell>
  );
}

/**
 * Single-line text prompt. Enter submits, Escape cancels, and the input is
 * focused when the dialog opens.
 */
export function PromptDialog({
  title,
  label,
  initialValue = '',
  placeholder = '',
  submitLabel,
  onSubmit,
  onCancel,
}) {
  const { t } = useLang();
  const titleId = useId();
  const submitText = submitLabel ?? t('dialogs.ok');
  const [value, setValue] = useState(initialValue);

  const submit = () => {
    onSubmit(value);
  };

  return (
    <DialogShell title={title} titleId={titleId} onClose={onCancel}>
      <label htmlFor={`${titleId}-input`} className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted">
        {label}
      </label>
      <input
        id={`${titleId}-input`}
        // eslint-disable-next-line jsx-a11y/no-autofocus
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit();
        }}
        placeholder={placeholder}
        className={`w-full rounded-os border border-osborder bg-paper px-3 py-2 text-sm text-ink outline-none placeholder:text-muted focus:border-accent ${FOCUS_RING}`}
      />
      <div className="mt-4 flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className={`rounded-os border border-osborder px-3 py-1.5 text-sm text-ink hover:bg-paper ${FOCUS_RING}`}
        >
          {t('dialogs.cancel')}
        </button>
        <button
          type="button"
          onClick={submit}
          className={`rounded-os bg-accent px-4 py-1.5 text-sm font-medium text-white ${FOCUS_RING}`}
        >
          {submitText}
        </button>
      </div>
    </DialogShell>
  );
}

export { FOCUS_RING };

/**
 * Uniform save-state indicator for Writer / Sheets / Slides toolbars.
 * state: 'saved' | 'saving' | 'dirty'.
 */
export function SaveStatePill({ state }) {
  const { t } = useLang();
  return (
    <span
      aria-live="polite"
      className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-osborder bg-paper px-2.5 py-1 text-xs text-muted"
    >
      {state === 'saving' && (
        <>
          <Loader2 size={12} className="animate-spin" aria-hidden="true" />
          {t('dialogs.saving')}
        </>
      )}
      {state === 'dirty' && (
        <>
          <span className="h-1.5 w-1.5 rounded-full bg-accent" aria-hidden="true" />
          {t('dialogs.unsaved')}
        </>
      )}
      {state !== 'saving' && state !== 'dirty' && (
        <>
          <Check size={12} aria-hidden="true" />
          {t('dialogs.saved')}
        </>
      )}
    </span>
  );
}
