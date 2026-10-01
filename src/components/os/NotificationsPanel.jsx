import React, { useEffect, useRef } from 'react';
import { X, BellOff, CheckCheck } from 'lucide-react';
import { useNotifications } from '../../os/NotificationsContext.jsx';
import { localeTag } from '../../lib/i18n.jsx';

/**
 * Notifications panel: rows mark read on click, × dismisses for real,
 * "Clear all" deletes everything for real. Honest empty state.
 */
export default function NotificationsPanel({ onClose }) {
  const { notifications, markRead, dismiss, clearAll } = useNotifications();
  const ref = useRef(null);

  useEffect(() => {
    const onDown = (e) => {
      if (e.key === 'Escape') onClose();
    };
    const onClick = (e) => {
      if (ref.current && !ref.current.contains(e.target)) onClose();
    };
    window.addEventListener('keydown', onDown);
    window.addEventListener('pointerdown', onClick);
    return () => {
      window.removeEventListener('keydown', onDown);
      window.removeEventListener('pointerdown', onClick);
    };
  }, [onClose]);

  const timeAgo = (ts) => {
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return '';
    const s = Math.floor((Date.now() - d.getTime()) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return d.toLocaleDateString(localeTag());
  };

  return (
    <div
      ref={ref}
      className="absolute bottom-16 right-3 z-50 flex max-h-[60vh] w-80 flex-col overflow-hidden rounded-os border border-osborder bg-surface shadow-win"
    >
      <div className="flex items-center justify-between border-b border-osborder px-4 py-2.5">
        <h2 className="text-sm font-semibold text-ink">Notifications</h2>
        {notifications.length > 0 && (
          <button
            type="button"
            onClick={() => clearAll()}
            className="flex items-center gap-1 text-xs font-medium text-muted duration-160 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded-os"
          >
            <CheckCheck size={13} />
            Clear all
          </button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {notifications.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
            <BellOff size={22} className="text-muted" />
            <p className="text-sm text-muted">No notifications</p>
          </div>
        ) : (
          notifications.map((n) => (
            <div
              key={n.id}
              role="button"
              tabIndex={0}
              aria-label={`${n.title}${n.read ? '' : ' (unread)'}`}
              onClick={() => {
                if (!n.read) markRead(n.id);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  if (!n.read) markRead(n.id);
                }
              }}
              className={`group flex cursor-pointer items-start gap-3 border-b border-osborder/60 px-4 py-3 duration-160 hover:bg-paper focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent ${
                n.read ? 'opacity-70' : ''
              }`}
            >
              <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${n.read ? 'bg-osborder' : 'bg-accent'}`} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-ink">{n.title}</p>
                {n.body && <p className="mt-0.5 line-clamp-2 text-xs text-muted">{n.body}</p>}
                <p className="mt-1 text-[11px] text-muted">{timeAgo(n.createdAt)}</p>
              </div>
              <button
                type="button"
                aria-label={`Dismiss: ${n.title}`}
                onClick={(e) => {
                  e.stopPropagation();
                  dismiss(n.id);
                }}
                // Always visible on touch (no hover there); appears on hover
                // or keyboard focus on desktop.
                className="rounded p-1 text-muted duration-160 hover:bg-osborder/60 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:opacity-100 sm:opacity-0 sm:group-hover:opacity-100"
              >
                <X size={14} />
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
