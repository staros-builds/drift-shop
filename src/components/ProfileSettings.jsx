/**
 * Profile settings section (Settings app).
 *
 * Lets the signed-in user change their own username via the
 * auth.changeOwnUsername backend method (validation + dedup handled
 * server-side). Mobile-responsive, all 4 locales.
 */
import { useEffect, useState } from 'react';
import { UserRound, Check, Loader2 } from 'lucide-react';
import { backend } from '../lib/backend/current.js';
import { useLang } from '../lib/i18n.jsx';
import { useNotifications } from '../os/NotificationsContext.jsx';

export default function ProfileSettings() {
  const { t } = useLang();
  const { push } = useNotifications();
  const [current, setCurrent] = useState(null); // null = loading
  const [loadError, setLoadError] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const profile = await backend.auth.getAccessProfile();
        if (!cancelled) {
          setCurrent(profile?.username ?? '');
          setDraft(profile?.username ?? '');
        }
      } catch {
        if (!cancelled) setLoadError(true);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const save = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const saved = await backend.auth.changeOwnUsername(draft);
      setCurrent(saved);
      setDraft(saved);
      push(t('settings.fields.usernameSaved'), saved);
    } catch (err) {
      setError(String(err?.message || err));
    } finally {
      setBusy(false);
    }
  };

  const changed = current !== null && draft.trim().toLowerCase() !== current;

  return (
    <section className="mb-8" aria-label={t('settings.sections.profile')}>
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted">
        {t('settings.sections.profile')}
      </h2>
      {loadError ? (
        <p className="text-sm text-muted">{t('settings.fields.usernameLoadFailed')}</p>
      ) : current === null ? (
        <div className="flex items-center gap-2 text-sm text-muted">
          <Loader2 size={15} className="animate-spin" />
          <span aria-hidden="true">…</span>
        </div>
      ) : (
        <div className="rounded-os border border-osborder bg-surface p-4">
          <div className="flex items-center gap-2">
            <UserRound size={16} className="shrink-0 text-accent" />
            <label htmlFor="profile-username" className="text-sm font-medium text-ink">
              {t('settings.fields.username')}
            </label>
          </div>
          <p className="mt-1 text-xs text-muted">{t('settings.fields.usernameHint')}</p>
          <div className="mt-2 flex flex-col gap-2 sm:flex-row">
            <input
              id="profile-username"
              type="text"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              maxLength={64}
              autoComplete="username"
              className="w-full rounded-os border border-osborder bg-paper px-3 py-2 text-sm text-ink outline-none placeholder:text-muted focus:border-accent"
            />
            <button
              type="button"
              onClick={save}
              disabled={busy || !changed}
              className="flex shrink-0 items-center justify-center gap-2 rounded-os bg-accent px-4 py-2 text-sm font-semibold text-accentink duration-160 hover:opacity-90 disabled:opacity-40"
            >
              {busy ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />}
              {busy ? t('settings.fields.changingUsername') : t('settings.fields.changeUsername')}
            </button>
          </div>
          {error && (
            <p className="mt-2 text-xs text-red-600" role="alert">{error}</p>
          )}
        </div>
      )}
    </section>
  );
}
