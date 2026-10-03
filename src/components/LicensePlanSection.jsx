import React, { useCallback, useEffect, useState } from 'react';
import { KeyRound } from 'lucide-react';
import { backend } from '../lib/backend/current.js';
import { useLang, localeTag } from '../lib/i18n.jsx';
import { groupKeyInput, isValidKeyFormat, daysLeft, TRIAL_DAYS } from '../lib/licensing.js';
import SupportPanel from './SupportPanel.jsx';

const inputCls =
  'w-full rounded-os border border-osborder bg-paper px-3 py-2 text-sm font-semibold uppercase tracking-widest text-ink outline-none placeholder:text-muted focus:border-accent';

const ERR_KEYS = {
  'not-found': 'licensing.errKeyNotFound',
  used: 'licensing.errKeyUsed',
  'too-many': 'licensing.errTooMany',
  'not-owner': 'licensing.errNotOwner',
  'no-shop': 'licensing.errNoShop',
  'sign-in': 'licensing.errSignIn',
};

function fmtDate(iso) {
  try {
    return new Date(iso).toLocaleDateString(localeTag(), {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  } catch {
    return '';
  }
}

/**
 * Settings → "Your plan" (licensing 072): per-shop license status, the
 * gentle last-days countdown, key entry for owners, and the Support
 * form that reaches the platform owner. Renders nothing until the
 * licensing migration is live (capability probe, same pattern as the
 * rest of the app) so older databases keep their exact old Settings.
 */
export default function LicensePlanSection() {
  const { t } = useLang();
  const [available, setAvailable] = useState(false);
  const [rows, setRows] = useState([]);
  const [key, setKey] = useState('');
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    try {
      if (!(await backend.license.available())) {
        setAvailable(false);
        return;
      }
      const mine = await backend.license.myStatus();
      setAvailable(true);
      setRows(Array.isArray(mine) ? mine : []);
      setTarget((prev) => {
        const owned = (Array.isArray(mine) ? mine : []).filter((r) => r.my_role === 'owner');
        if (prev && owned.some((r) => r.store_id === prev)) return prev;
        const locked = owned.find((r) => r.effective_status === 'locked');
        return (locked || owned[0])?.store_id || '';
      });
    } catch {
      /* plan section stays hidden on any read failure */
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (!available) return null;

  const owned = rows.filter((r) => r.my_role === 'owner');
  // Key entry is only useful while at least one owned shop still needs
  // unlocking. Once every owned shop is active, hide the field so a
  // redeemed key doesn't leave a stale entry box behind (QA backlog).
  const needsKey = owned.some((r) => r.effective_status !== 'active');

  const statusLine = (r) => {
    if (r.effective_status === 'trial') {
      const d = daysLeft(r.trial_ends_at);
      return (
        <>
          <p className="text-sm font-medium text-ink">
            {d === 1
              ? t('licensing.planTrialOne')
              : t('licensing.planTrial', { days: d })}
          </p>
          <p className="mt-0.5 text-sm text-muted">
            {t('licensing.planTrialEnds', { date: fmtDate(r.trial_ends_at) })}
          </p>
        </>
      );
    }
    if (r.effective_status === 'active') {
      return (
        <p className="text-sm font-medium text-ink">
          {r.current_period_ends_at
            ? t('licensing.planActiveTerm', {
                date: fmtDate(r.current_period_ends_at),
                days: daysLeft(r.current_period_ends_at),
              })
            : t('licensing.planActiveLifetime')}
        </p>
      );
    }
    return <p className="text-sm font-medium text-ink">{t('licensing.planLocked')}</p>;
  };

  const redeem = async () => {
    if (!isValidKeyFormat(key)) {
      setError(t('licensing.errKeyFormat'));
      return;
    }
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await backend.license.redeemKey(key, target || null);
      setKey('');
      setNotice(t('licensing.unlockSuccess'));
      await load();
    } catch (e) {
      setError(t(ERR_KEYS[e?.code] || 'licensing.errGeneric'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <section className="rounded-os border border-osborder bg-surface p-4">
        <h3 className="text-sm font-semibold text-ink">{t('licensing.planTitle')}</h3>
        <div className="mt-3 space-y-3">
          {rows.length === 0 && (
            <p className="text-sm text-muted">{t('licensing.planNoShop', { days: TRIAL_DAYS })}</p>
          )}
          {rows.map((r) => (
            <div key={r.store_id} className="rounded-os border border-osborder bg-paper px-3 py-2.5">
              <p className="text-sm font-semibold text-ink">{r.store_name}</p>
              <div className="mt-0.5">{statusLine(r)}</div>
            </div>
          ))}

          {needsKey && (
            <div>
              <p className="text-sm text-muted">{t('licensing.planKeyHelp')}</p>
              {owned.length > 1 && (
                <select
                  value={target}
                  onChange={(e) => setTarget(e.target.value)}
                  className="mt-2 w-full rounded-os border border-osborder bg-paper px-3 py-2 text-sm text-ink outline-none focus:border-accent"
                >
                  {owned.map((r) => (
                    <option key={r.store_id} value={r.store_id}>
                      {t('licensing.planUnlockFor', { name: r.store_name })}
                    </option>
                  ))}
                </select>
              )}
              <div className="mt-2 flex gap-2">
                <input
                  value={key}
                  onChange={(e) => setKey(groupKeyInput(e.target.value))}
                  placeholder={t('licensing.keyPlaceholder')}
                  maxLength={19}
                  autoComplete="off"
                  autoCapitalize="characters"
                  autoCorrect="off"
                  spellCheck={false}
                  className={inputCls}
                />
                <button
                  type="button"
                  onClick={redeem}
                  disabled={busy}
                  className="flex shrink-0 items-center gap-2 rounded-os bg-accent px-4 py-2 text-sm font-semibold text-accentink duration-160 hover:opacity-90 disabled:opacity-50"
                >
                  <KeyRound size={14} />
                  {busy ? t('licensing.unlocking') : t('licensing.unlockButton')}
                </button>
              </div>
              {error && <p className="mt-2 text-sm text-red-700">{error}</p>}
            </div>
          )}
          {notice && <p className="mt-2 text-sm font-medium text-emerald-700">{notice}</p>}
        </div>
      </section>

      <section className="mt-4">
        <p className="mb-2 text-sm text-muted">{t('licensing.planSupportBody')}</p>
        <SupportPanel scope="platform" storeId={owned[0]?.store_id || null} />
      </section>
    </>
  );
}
