import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { X } from 'lucide-react';

const ToastContext = createContext(null);
let toastSeq = 0;

const DEFAULT_TIMEOUT_MS = 6000;
const MAX_STACK = 4;

/**
 * Toast system — transient bottom-right notifications, distinct from the
 * notification center (NotificationsContext), which is a persistent list.
 *
 * API: const { pushToast } = useToasts();
 *      pushToast({ title, message, actionLabel, onAction, timeoutMs })
 * actionLabel/onAction are optional (e.g. an Undo button); toasts
 * auto-dismiss after timeoutMs (default 6000ms) and are Escape-dismissable.
 */
export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);

  const dismiss = useCallback((id) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const pushToast = useCallback(
    ({ title, message, actionLabel, onAction, timeoutMs }) => {
      const id = `toast-${Date.now()}-${(toastSeq += 1)}`;
      const ms =
        typeof timeoutMs === 'number' && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
      setToasts((prev) => [
        ...prev.slice(-(MAX_STACK - 1)),
        { id, title, message, actionLabel, onAction },
      ]);
      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, ms);
      return id;
    },
    []
  );

  // Escape dismisses the most recent toast. Guard against inputs that
  // already handled the key (their own keydown handlers run first and may
  // set defaultPrevented).
  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      setToasts((prev) => (prev.length > 0 ? prev.slice(0, -1) : prev));
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <ToastContext.Provider value={{ pushToast, dismissToast: dismiss }}>
      {children}
      <div
        aria-live="polite"
        className="pointer-events-none fixed bottom-4 right-4 z-[200] flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            role="status"
            className="pointer-events-auto flex items-start gap-3 rounded-os border border-osborder bg-surface p-3 shadow-win"
          >
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-ink">{t.title}</p>
              {t.message ? <p className="mt-0.5 text-sm text-muted">{t.message}</p> : null}
              {t.actionLabel && t.onAction ? (
                <button
                  type="button"
                  onClick={() => {
                    dismiss(t.id);
                    t.onAction();
                  }}
                  className="mt-2 rounded-os bg-accent px-3 py-1 text-sm font-medium text-white transition-opacity duration-160 hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                >
                  {t.actionLabel}
                </button>
              ) : null}
            </div>
            <button
              type="button"
              onClick={() => dismiss(t.id)}
              aria-label="Dismiss notification"
              className="rounded-os p-1 text-muted transition-colors duration-160 hover:bg-paper hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              <X size={14} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToasts() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToasts must be used inside a <ToastProvider>.');
  return ctx;
}
