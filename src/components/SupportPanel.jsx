import React, { useCallback, useEffect, useState } from 'react';
import { LifeBuoy, Send } from 'lucide-react';
import { backend } from '../lib/backend/current.js';
import { useLang, localeTag } from '../lib/i18n.jsx';

const inputCls =
  'w-full rounded-os border border-osborder bg-paper px-3 py-2 text-sm text-ink outline-none placeholder:text-muted focus:border-accent';

/**
 * Shared support form + "my messages" list (licensing 072).
 *
 * scope 'shop'     -> the shop's own admins (the old default).
 * scope 'platform' -> the platform owner: purchase / unlock requests
 *                     from the lock screen and Settings.
 * Used by the lock screen, Settings → Support, and anywhere else a
 * signed-in user needs to reach a human.
 */
export default function SupportPanel({ scope = 'shop', storeId = null, heading = null }) {
  const { t } = useLang();
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');
  const [tickets, setTickets] = useState([]);

  const load = useCallback(async () => {
    try {
      const rows = await backend.support.listMyTickets();
      setTickets(Array.isArray(rows) ? rows : []);
    } catch {
      setTickets([]);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const statusLabel = (s) =>
    s === 'resolved'
      ? t('licensing.supportStatusResolved')
      : s === 'in_progress'
        ? t('licensing.supportStatusProgress')
        : t('licensing.supportStatusOpen');

  const send = async () => {
    if (!subject.trim() || !message.trim() || busy) return;
    setBusy(true);
    setError('');
    setSent(false);
    try {
      await backend.support.createTicket({
        subject: subject.trim(),
        message: message.trim(),
        scope,
        storeId,
      });
      setSubject('');
      setMessage('');
      setSent(true);
      await load();
    } catch (e) {
      setError(e?.message || t('licensing.errGeneric'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-os border border-osborder bg-surface p-4">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-ink">
        <LifeBuoy size={15} className="text-accent" />
        {heading || t('licensing.planSupportTitle')}
      </h3>

      <div className="mt-3 space-y-2.5">
        <input
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          placeholder={t('licensing.supportSubjectPlaceholder')}
          maxLength={200}
          className={inputCls}
        />
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder={t('licensing.supportMessagePlaceholder')}
          rows={4}
          maxLength={5000}
          className={`${inputCls} resize-y`}
        />
        {error && <p className="text-sm text-red-700">{error}</p>}
        {sent && <p className="text-sm font-medium text-emerald-700">{t('licensing.supportSent')}</p>}
        <button
          type="button"
          onClick={send}
          disabled={busy || !subject.trim() || !message.trim()}
          className="flex w-full items-center justify-center gap-2 rounded-os bg-accent px-4 py-2 text-sm font-semibold text-accentink duration-160 hover:opacity-90 disabled:opacity-50"
        >
          <Send size={14} />
          {busy ? t('licensing.supportSending') : t('licensing.supportSend')}
        </button>
      </div>

      <div className="mt-4">
        <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
          {t('licensing.supportMine')}
        </h4>
        {tickets.length === 0 ? (
          <p className="text-sm text-muted">{t('licensing.supportEmpty')}</p>
        ) : (
          <ul className="space-y-2">
            {tickets.slice(0, 10).map((tk) => (
              <li key={tk.id} className="rounded-os border border-osborder bg-paper px-3 py-2.5">
                <div className="flex items-center gap-2">
                  <p className="min-w-0 flex-1 truncate text-sm font-medium text-ink">{tk.subject}</p>
                  <span className="shrink-0 rounded-full bg-osborder/60 px-2 py-0.5 text-[11px] font-medium text-muted">
                    {statusLabel(tk.status)}
                  </span>
                </div>
                <p className="mt-0.5 text-[11px] text-muted">
                  {new Date(tk.created_at).toLocaleDateString(localeTag(), {
                    month: 'short',
                    day: 'numeric',
                  })}
                </p>
                {tk.admin_response && (
                  <p className="mt-1.5 rounded-os bg-surface px-2.5 py-2 text-sm text-ink">
                    <span className="mb-0.5 block text-[11px] font-medium text-accent">
                      {t('licensing.supportReplyLabel')}
                    </span>
                    <span className="whitespace-pre-wrap">{tk.admin_response}</span>
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
