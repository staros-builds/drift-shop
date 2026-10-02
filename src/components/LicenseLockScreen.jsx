import React, { useState } from 'react';
import { Download, KeyRound, Lock, LogOut } from 'lucide-react';
import { backend } from '../lib/backend/current.js';
import { useLang } from '../lib/i18n.jsx';
import { groupKeyInput, isValidKeyFormat } from '../lib/licensing.js';
import { exportAccountBackup, downloadBackupFile } from '../lib/accountBackup.js';
import SupportPanel from './SupportPanel.jsx';

const inputCls =
  'w-full rounded-os border border-osborder bg-paper px-3 py-2.5 text-center text-base font-semibold uppercase tracking-widest text-ink outline-none placeholder:text-muted focus:border-accent';

// RPC error codes (backend.license) -> one plain sentence each.
const ERR_KEYS = {
  'not-found': 'licensing.errKeyNotFound',
  used: 'licensing.errKeyUsed',
  'too-many': 'licensing.errTooMany',
  'not-owner': 'licensing.errNotOwner',
  'no-shop': 'licensing.errNoShop',
  'sign-in': 'licensing.errSignIn',
};

/**
 * The soft-lock screen (licensing 072). Shown instead of the desktop
 * when every shop the user belongs to is locked. The user stays SIGNED
 * IN — unlocking, support and backup download all happen from here.
 * Data is never deleted by a lock; this screen says so, plainly.
 */
export default function LicenseLockScreen({ stores = [], onUnlocked, onSignOut }) {
  const { t } = useLang();
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [backingUp, setBackingUp] = useState(false);

  const ownedLocked = (Array.isArray(stores) ? stores : []).filter((s) => s.my_role === 'owner');
  const isOwner = ownedLocked.length > 0;
  const firstStoreId = ownedLocked[0]?.store_id || stores[0]?.store_id || null;

  const redeem = async () => {
    if (!isValidKeyFormat(key)) {
      setError(t('licensing.errKeyFormat'));
      return;
    }
    setBusy(true);
    setError('');
    try {
      await backend.license.redeemKey(key);
      setDone(true);
      // Let the success line land, then re-run the gate: if other
      // shops are still locked the screen stays (one key, one shop);
      // otherwise the shell opens the app.
      setTimeout(() => onUnlocked?.(), 900);
    } catch (e) {
      setError(t(ERR_KEYS[e?.code] || 'licensing.errGeneric'));
    } finally {
      setBusy(false);
    }
  };

  const downloadBackup = async () => {
    if (backingUp) return;
    setBackingUp(true);
    try {
      const data = await exportAccountBackup();
      downloadBackupFile(data, `drift-backup-${new Date().toISOString().slice(0, 10)}.json`);
    } catch {
      /* the button simply didn't produce a file; the data is untouched */
    } finally {
      setBackingUp(false);
    }
  };

  return (
    <div className="flex h-full items-start justify-center overflow-y-auto bg-paper px-4 py-8 text-ink">
      <div className="w-full max-w-lg space-y-4">
        <div className="rounded-os border border-osborder bg-surface p-5 text-center">
          <Lock size={28} className="mx-auto text-accent" />
          <h1 className="mt-2 text-lg font-bold">{t('licensing.lockTitle')}</h1>
          <p className="mt-1.5 text-sm leading-relaxed text-muted">{t('licensing.lockBody')}</p>
          {(Array.isArray(stores) ? stores : []).map((s) => (
            <p key={s.store_id} className="mt-1 text-sm font-medium text-ink">
              {t('licensing.lockShopLine', { name: s.store_name || '' })}
            </p>
          ))}
        </div>

        {isOwner ? (
          <div className="rounded-os border border-osborder bg-surface p-4">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-ink">
              <KeyRound size={15} className="text-accent" /> {t('licensing.keyLabel')}
            </h2>
            <p className="mt-1 text-sm leading-relaxed text-muted">{t('licensing.lockOwnerHelp')}</p>
            <div className="mt-3 space-y-2.5">
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
              <p className="text-center text-xs text-muted">{t('licensing.keyHint')}</p>
              {error && <p className="text-center text-sm text-red-700">{error}</p>}
              {done && (
                <p className="text-center text-sm font-medium text-emerald-700">
                  {t('licensing.unlockSuccess')}
                </p>
              )}
              <button
                type="button"
                onClick={redeem}
                disabled={busy || done}
                className="flex w-full items-center justify-center gap-2 rounded-os bg-accent px-4 py-2.5 text-sm font-semibold text-accentink duration-160 hover:opacity-90 disabled:opacity-50"
              >
                <KeyRound size={14} />
                {busy ? t('licensing.unlocking') : t('licensing.unlockButton')}
              </button>
            </div>
          </div>
        ) : (
          <div className="rounded-os border border-osborder bg-surface p-4">
            <p className="text-sm leading-relaxed text-muted">{t('licensing.lockStaffHelp')}</p>
          </div>
        )}

        <SupportPanel scope="platform" storeId={firstStoreId} heading={t('licensing.supportTitle')} />

        <div className="rounded-os border border-osborder bg-surface p-4">
          <p className="text-sm leading-relaxed text-muted">{t('licensing.downloadBackupHelp')}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={downloadBackup}
              disabled={backingUp}
              className="flex items-center gap-2 rounded-os border border-osborder bg-paper px-4 py-2 text-sm font-medium text-ink duration-160 hover:border-accent disabled:opacity-50"
            >
              <Download size={14} />
              {t('licensing.downloadBackup')}
            </button>
            <button
              type="button"
              onClick={() => onSignOut?.()}
              className="flex items-center gap-2 rounded-os border border-osborder bg-paper px-4 py-2 text-sm font-medium text-ink duration-160 hover:border-accent"
            >
              <LogOut size={14} />
              {t('licensing.signOut')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
