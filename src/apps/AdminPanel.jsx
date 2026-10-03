import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ShieldCheck, RefreshCw, Lock, LockOpen, BadgeDollarSign,
  Search, ShieldAlert, Cloud, MessageCircleQuestion, Star, Send,
  Users, UserPlus, KeyRound, Trash2, X, Check, Pencil, Plus, CheckCircle2,
  Store, Globe, ExternalLink, LayoutGrid, ShoppingBag, UtensilsCrossed,
  CalendarDays, Fuel, Upload,
} from 'lucide-react';
import { backend } from '../lib/backend/current.js';
import { BRAND } from '../lib/brand.js';
import { exportAccountBackup, downloadBackupFile } from '../lib/accountBackup.js';
import { snapshotBeforeDestructive } from '../lib/autoBackup.js';
import { useAuth } from '../os/AuthContext.jsx';
import { useSettings } from '../os/SettingsContext.jsx';
import { validateBackup, getRestorePending, setRestorePending, clearRestorePending, getRestoreHistory, recordRestoreHistory } from '../lib/backupRestore.js';
import { runBackupRestore } from '../lib/restoreImport.js';
import { acquireUpdateLock } from '../lib/updateGuard.js';
import { BUSINESS_PRESET_IDS, BUSINESS_PRESETS, isBusinessPreset, presetSettingsPatch } from '../lib/businessPresets.js';
import { savePrinterConfig } from '../lib/pos-print/index.js';
import { localeTag, useLang, tagFor } from '../lib/i18n.jsx';

const FIVE_MIN_MS = 5 * 60 * 1000;

function fmtBytes(n) {
  const bytes = Number(n) || 0;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function fmtDate(iso) {
  return new Date(iso).toLocaleString(localeTag(), {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

const TONE = {
  admin: 'bg-accent/15 text-accent',
  good: 'bg-green-500/15 text-green-600',
  bad: 'bg-red-500/15 text-red-600',
  warn: 'bg-amber-500/15 text-amber-600',
  trial: 'bg-sky-500/15 text-sky-600',
  muted: 'bg-osborder/60 text-muted',
};

const TICKET_STATUS = {
  open: { labelKey: 'admin.ticketOpen', tone: 'bad' },
  in_progress: { labelKey: 'admin.ticketInProgress', tone: 'warn' },
  resolved: { labelKey: 'admin.ticketResolved', tone: 'good' },
};

/* ---------------- accounts section ---------------- */

/* ---------------- unified accounts section (cloud) ----------------
 * One screen for everything about sign-in accounts: list, create
 * (with account type + shop), reset passwords, promote/demote,
 * lock/unlock, delete.
 */
const ACCOUNT_TYPES = ['full', 'staff', 'pos', 'punch'];

function AccountsSection({ user }) {
  const { t, lang } = useLang();
  const [users, setUsers] = useState([]);
  const [stores, setStores] = useState([]);
  const [memberships, setMemberships] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [acting, setActing] = useState(null);
  const actingRef = useRef(null); // synchronous double-submit lock (state-based `acting` is too slow for rapid double-clicks)
  const [query, setQuery] = useState('');
  // create dialog
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [newPass, setNewPass] = useState('');
  const [newType, setNewType] = useState('staff');
  const [newStore, setNewStore] = useState('');
  const [newShopRole, setNewShopRole] = useState('cashier');
  const [newAdmin, setNewAdmin] = useState(false);
  const [createdCreds, setCreatedCreds] = useState(null);
  // reset + delete + role dialogs
  const [resetFor, setResetFor] = useState(null);
  const [resetPass, setResetPass] = useState('');
  const [deleteFor, setDeleteFor] = useState(null);
  const [roleFor, setRoleFor] = useState(null); // { user, role }

  const load = useCallback(async () => {
    setError('');
    setLoading(true);
    try {
      const [u, s, m] = await Promise.all([
        backend.auth.adminListUsers(),
        backend.pos.listStores().catch(() => []),
        backend.pos.adminListMemberships().catch(() => []),
      ]);
      setUsers(u);
      setStores(s || []);
      setMemberships(m || []);
    } catch (e) {
      setError(e.message || t('err.loadAccounts'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const refresh = useCallback(async () => {
    setError('');
    try {
      const [u, s, m] = await Promise.all([
        backend.auth.adminListUsers(),
        backend.pos.listStores().catch(() => []),
        backend.pos.adminListMemberships().catch(() => []),
      ]);
      setUsers(u);
      setStores(s || []);
      setMemberships(m || []);
    } catch (e) {
      setError(e.message || t('err.loadAccounts'));
    }
  }, []);

  const needsShop = newType !== 'full';
  const createValid =
    /^[a-z0-9._-]{3,32}$/.test(newName.trim().toLowerCase()) &&
    newPass.length >= 8 &&
    (!needsShop || newStore);

  const create = useCallback(async () => {
    if (!createValid || acting || actingRef.current) return;
    actingRef.current = 'new';
    setError('');
    setActing('new');
    try {
      await backend.auth.adminCreateUser({
        username: newName.trim().toLowerCase(),
        password: newPass,
        role: newType === 'full' && newAdmin ? 'admin' : 'standard',
        accountType: newType,
        storeId: needsShop ? newStore : null,
        shopRole: newType === 'staff' ? newShopRole : 'cashier',
      });
      setCreatedCreds({
        username: newName.trim().toLowerCase(),
        password: newPass,
        type: newType,
        storeName: (stores.find((s) => s.id === newStore) || {}).name || '',
      });
      setNewName(''); setNewPass(''); setNewType('staff');
      setNewStore(''); setNewShopRole('cashier'); setNewAdmin(false);
      await refresh();
    } catch (e) {
      setError(t('adminAccounts.errCreateAccount', { msg: e.message || e }));
    } finally {
      actingRef.current = null;
      setActing(null);
    }
  }, [createValid, acting, newName, newPass, newType, newAdmin, needsShop, newStore, newShopRole, stores, refresh]);

  const doReset = useCallback(async () => {
    if (!resetFor || resetPass.length < 8 || acting || actingRef.current) return;
    actingRef.current = resetFor.id;
    setError('');
    setActing(resetFor.id);
    try {
      await backend.auth.adminResetPassword(resetFor.id, resetPass);
    } catch (e) {
      setError(t('adminAccounts.errResetPassword', { msg: e.message || e }));
    } finally {
      actingRef.current = null;
      setActing(null);
      setResetFor(null);
      setResetPass('');
    }
  }, [resetFor, resetPass, acting]);

  const doDelete = useCallback(async () => {
    if (!deleteFor || acting || actingRef.current) return;
    actingRef.current = deleteFor.id;
    setError('');
    setActing(deleteFor.id);
    try {
      await backend.auth.adminDeleteUser(deleteFor.id);
      await refresh();
    } catch (e) {
      setError(t('adminAccounts.errDeleteAccount', { msg: e.message || e }));
    } finally {
      actingRef.current = null;
      setActing(null);
      setDeleteFor(null);
    }
  }, [deleteFor, acting, refresh]);

  const setRole = useCallback(async (u, role) => {
    if (acting || actingRef.current) return;
    // Open the confirmation dialog; the actual change happens in doSetRole.
    setRoleFor({ user: u, role });
  }, [acting]);

  const doSetRole = useCallback(async () => {
    if (!roleFor || acting || actingRef.current) return;
    const { user: u, role } = roleFor;
    actingRef.current = u.id;
    setError('');
    setActing(u.id);
    try {
      await backend.auth.adminUpdateUser(u.id, { role });
      await refresh();
    } catch (e) {
      setError(t('adminAccounts.errChangeRole', { msg: e.message || e }));
    } finally {
      actingRef.current = null;
      setActing(null);
      setRoleFor(null);
    }
  }, [roleFor, acting, refresh]);

  const setLocked = useCallback(async (u, locked) => {
    if (acting || actingRef.current) return;
    actingRef.current = u.id;
    setError('');
    setActing(u.id);
    try {
      await backend.auth.adminUpdateUser(u.id, { disabled: locked });
      await refresh();
    } catch (e) {
      setError(t('adminAccounts.errUpdateAccount', { msg: e.message || e }));
    } finally {
      actingRef.current = null;
      setActing(null);
    }
  }, [acting, refresh]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return users;
    return users.filter((u) => (u.username || '').toLowerCase().includes(q));
  }, [users, query]);

  const typeBadge = (u) => {
    const map = {
      full: { label: t('adminAccounts.typeFull'), cls: 'bg-osborder/60 text-muted' },
      staff: { label: t('adminAccounts.typeStaff'), cls: 'bg-sky-500/15 text-sky-600' },
      pos: { label: t('adminAccounts.typePos'), cls: 'bg-amber-500/15 text-amber-700' },
      punch: { label: t('adminAccounts.typePunch'), cls: 'bg-green-500/15 text-green-700' },
    };
    return map[u.accountType] || map.full;
  };

  // Shop assignments for one account: [{ storeName, role }]. Device accounts
  // (pos/punch) may also carry device_store_id on the profile.
  const shopsFor = (u) => {
    const out = memberships
      .filter((m) => m.userId === u.id)
      .map((m) => ({ storeName: m.storeName, role: m.role }));
    if (out.length === 0 && u.deviceStoreId) {
      const s = stores.find((x) => x.id === u.deviceStoreId);
      if (s) out.push({ storeName: s.name, role: 'cashier' });
    }
    return out;
  };

  const roleLabel = (role) =>
    role === 'owner' ? t('adminAccounts.roleOwner')
    : role === 'manager' ? t('adminAccounts.roleManager')
    : t('adminAccounts.roleCashier');

  const localeTag = () => tagFor(lang);

  return (
    <>
      <div className="flex items-center gap-2 border-b border-osborder px-4 py-2.5">
        <p className="min-w-0 flex-1 text-xs text-muted" title={t('adminAccounts.accountsHint')}>
          {loading ? t('common.loading') : `${filtered.length} / ${users.length}`}
        </p>
        <div className="relative">
          <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('adminAccounts.searchAccounts')}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            className="w-36 rounded-os border border-osborder bg-paper py-1.5 pl-8 pr-2 text-xs text-ink outline-none focus:border-accent"
          />
        </div>
        <button
          type="button"
          onClick={() => { setShowCreate(true); setCreatedCreds(null); }}
          className="flex items-center gap-1.5 rounded-os bg-accent px-2.5 py-1.5 text-xs font-semibold text-accentink duration-160 hover:opacity-90"
        >
          <Plus size={13} />
          {t('adminAccounts.newAccount')}
        </button>
        <button
          type="button"
          onClick={load}
          disabled={loading}
          title={t('adminAccounts.refresh')}
          className="flex items-center gap-1.5 rounded-os border border-osborder bg-paper px-2.5 py-1.5 text-xs font-medium text-ink duration-160 hover:border-accent disabled:opacity-50"
        >
          <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      <p className="border-b border-osborder bg-paper px-4 py-2 text-[11px] leading-relaxed text-muted">
        {t('adminAccounts.accountsHint')}
      </p>

      {error && (
        <div className="border-b border-osborder bg-paper px-4 py-2 text-xs text-red-600">{error}</div>
      )}

      <div className="flex-1 overflow-y-auto p-3">
        {filtered.length === 0 ? (
          <p className="p-6 text-center text-xs text-muted">
            {users.length === 0 ? t('adminAccounts.noAccounts') : t('adminAccounts.noMatch')}
          </p>
        ) : (
          <ul className="space-y-2">
            {filtered.map((u) => {
              const isSelf = user && u.id === user.id;
              const busy = acting === u.id;
              const tb = typeBadge(u);
              return (
                <li key={u.id} className="rounded-os border border-osborder bg-paper px-3 py-2.5">
                  <div className="flex items-center gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-ink">
                        {u.displayName || u.username}
                        {isSelf && <span className="ml-1.5 text-xs font-normal text-muted">{t('adminAccounts.you')}</span>}
                      </p>
                      <p className="mt-0.5 text-[11px] text-muted">
                        {t('adminAccounts.joinedOn')} {new Date(u.createdAt).toLocaleDateString(localeTag())}
                        {u.createdBy === user?.id && ` · ${t('adminAccounts.createdByYou')}`}
                      </p>
                      {shopsFor(u).length > 0 && (
                        <p className="mt-0.5 flex flex-wrap items-center gap-1 text-[11px] text-muted">
                          <Store size={11} className="shrink-0" />
                          {shopsFor(u).map((s, i) => (
                            <span key={i} className="mr-1">
                              {s.storeName} · {roleLabel(s.role)}
                              {i < shopsFor(u).length - 1 && <span className="ml-1">·</span>}
                            </span>
                          ))}
                        </p>
                      )}
                    </div>
                    <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${tb.cls}`}>
                      {tb.label}
                    </span>
                    {u.role === 'admin' && (
                      <span className="shrink-0 rounded-full bg-accent/15 px-2 py-0.5 text-[11px] font-medium text-accent">
                        {t('adminAccounts.admin')}
                      </span>
                    )}
                    {u.disabled && (
                      <span className="shrink-0 rounded-full bg-red-500/15 px-2 py-0.5 text-[11px] font-medium text-red-600">
                        {t('adminAccounts.locked')}
                      </span>
                    )}
                  </div>
                  {!isSelf && (
                    <div className="mt-2 flex flex-wrap gap-1.5 border-t border-osborder pt-2">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => { setResetFor(u); setResetPass(''); }}
                        className="flex items-center gap-1 rounded-os border border-osborder px-2 py-1 text-[11px] font-medium text-ink duration-160 hover:border-accent disabled:opacity-50"
                      >
                        <KeyRound size={12} />
                        {t('adminAccounts.resetPassword')}
                      </button>
                      {u.accountType === 'full' && u.role !== 'admin' && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => setRole(u, 'admin')}
                          className="flex items-center gap-1 rounded-os border border-osborder px-2 py-1 text-[11px] font-medium text-ink duration-160 hover:border-accent disabled:opacity-50"
                        >
                          <ShieldCheck size={12} />
                          {t('adminAccounts.makeAdmin')}
                        </button>
                      )}
                      {u.accountType === 'full' && u.role === 'admin' && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => setRole(u, 'standard')}
                          className="flex items-center gap-1 rounded-os border border-osborder px-2 py-1 text-[11px] font-medium text-ink duration-160 hover:border-accent disabled:opacity-50"
                        >
                          <ShieldCheck size={12} />
                          {t('adminAccounts.makeStandard')}
                        </button>
                      )}
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => setLocked(u, !u.disabled)}
                        title={t('adminAccounts.lockHint')}
                        className="flex items-center gap-1 rounded-os border border-osborder px-2 py-1 text-[11px] font-medium text-ink duration-160 hover:border-accent disabled:opacity-50"
                      >
                        {u.disabled ? <LockOpen size={12} /> : <Lock size={12} />}
                        {u.disabled ? t('adminAccounts.unlock') : t('adminAccounts.lock')}
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => setDeleteFor(u)}
                        className="flex items-center gap-1 rounded-os border border-red-300 px-2 py-1 text-[11px] font-medium text-red-600 duration-160 hover:border-red-500 disabled:opacity-50"
                      >
                        <Trash2 size={12} />
                        {t('adminAccounts.deleteAccount')}
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* ---------- create dialog ---------- */}
      {showCreate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => { setShowCreate(false); setCreatedCreds(null); }}>
          <div
            className="max-h-[90vh] w-full max-w-sm overflow-y-auto rounded-os border border-osborder bg-paper p-4 shadow-oswin"
            onClick={(e) => e.stopPropagation()}
          >
            {createdCreds ? (
              <>
                <h3 className="flex items-center gap-2 text-sm font-semibold text-ink">
                  <CheckCircle2 size={16} className="text-green-600" />
                  {t('adminAccounts.createdTitle')}
                </h3>
                <div className="mt-3 rounded-os border border-osborder bg-surface p-3">
                  <p className="text-sm font-semibold text-ink">{createdCreds.username}</p>
                  <p className="mt-1 select-all font-mono text-sm text-ink">{createdCreds.password}</p>
                  <p className="mt-1 text-[11px] text-muted">
                    {typeBadge({ accountType: createdCreds.type }).label}
                    {createdCreds.storeName ? ` · ${createdCreds.storeName}` : ''}
                  </p>
                </div>
                <p className="mt-2 text-[11px] font-medium leading-relaxed text-amber-700">
                  {t('adminAccounts.createdBody')}
                </p>
                <button
                  type="button"
                  onClick={() => { setShowCreate(false); setCreatedCreds(null); }}
                  className="mt-3 w-full rounded-os bg-accent px-2.5 py-2 text-xs font-semibold text-accentink duration-160 hover:opacity-90"
                >
                  {t('adminAccounts.done')}
                </button>
              </>
            ) : (
              <>
                <h3 className="text-sm font-semibold text-ink">{t('adminAccounts.newAccount')}</h3>

                <label className="mt-3 block text-[11px] font-medium text-muted">
                  {t('adminAccounts.username')}
                  <input
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    placeholder="marie"
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                    autoComplete="off"
                    className="mt-1 w-full rounded-os border border-osborder bg-surface px-2.5 py-1.5 text-xs text-ink outline-none focus:border-accent"
                  />
                </label>
                <p className="mt-1 text-[11px] text-muted">{t('adminAccounts.usernameHint')}</p>

                <label className="mt-3 block text-[11px] font-medium text-muted">
                  {t('adminAccounts.password')}
                  <input
                    type="password"
                    value={newPass}
                    onChange={(e) => setNewPass(e.target.value)}
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                    autoComplete="new-password"
                    className="mt-1 w-full rounded-os border border-osborder bg-surface px-2.5 py-1.5 text-xs text-ink outline-none focus:border-accent"
                  />
                </label>
                <p className="mt-1 text-[11px] text-muted">{t('adminAccounts.passwordHint')}</p>

                <p className="mt-4 text-[11px] font-medium text-muted">{t('adminAccounts.accountType')}</p>
                <div className="mt-1 space-y-1.5">
                  {ACCOUNT_TYPES.map((at) => (
                    <label
                      key={at}
                      className={`flex cursor-pointer items-start gap-2 rounded-os border p-2 duration-160 ${
                        newType === at ? 'border-accent bg-accent/5' : 'border-osborder'
                      }`}
                    >
                      <input
                        type="radio"
                        name="acct-type"
                        checked={newType === at}
                        onChange={() => {
                          setNewType(at);
                          if (at === 'full') { setNewStore(''); setNewShopRole('cashier'); }
                          if (at !== 'staff') setNewShopRole('cashier');
                          if (at !== 'full') setNewAdmin(false);
                        }}
                        className="mt-0.5 accent-[#b3541e]"
                      />
                      <span>
                        <span className="block text-xs font-semibold text-ink">
                          {t(`adminAccounts.type${at[0].toUpperCase()}${at.slice(1)}`)}
                        </span>
                        <span className="block text-[11px] leading-relaxed text-muted">
                          {t(`adminAccounts.type${at[0].toUpperCase()}${at.slice(1)}Hint`)}
                        </span>
                      </span>
                    </label>
                  ))}
                </div>

                {needsShop && (
                  <>
                    <label className="mt-3 block text-[11px] font-medium text-muted">
                      {t('adminAccounts.shop')}
                      <select
                        value={newStore}
                        onChange={(e) => setNewStore(e.target.value)}
                        className="mt-1 w-full rounded-os border border-osborder bg-surface px-2.5 py-1.5 text-xs text-ink outline-none focus:border-accent"
                      >
                        <option value="">{t('adminAccounts.shopRequired')}</option>
                        {stores.map((s) => (
                          <option key={s.id} value={s.id}>{s.name}</option>
                        ))}
                      </select>
                    </label>
                    <p className="mt-1 text-[11px] text-muted">{t('adminAccounts.shopHint')}</p>
                  </>
                )}

                {newType === 'staff' && (
                  <>
                    <label className="mt-3 block text-[11px] font-medium text-muted">
                      {t('adminAccounts.shopRole')}
                      <select
                        value={newShopRole}
                        onChange={(e) => setNewShopRole(e.target.value)}
                        className="mt-1 w-full rounded-os border border-osborder bg-surface px-2.5 py-1.5 text-xs text-ink outline-none focus:border-accent"
                      >
                        <option value="cashier">{t('adminAccounts.roleCashier')}</option>
                        <option value="manager">{t('adminAccounts.roleManager')}</option>
                      </select>
                    </label>
                    <p className="mt-1 text-[11px] text-muted">{t('adminAccounts.shopRoleHint')}</p>
                  </>
                )}

                {newType === 'full' && (
                  <label className="mt-3 flex cursor-pointer items-start gap-2">
                    <input
                      type="checkbox"
                      checked={newAdmin}
                      onChange={(e) => setNewAdmin(e.target.checked)}
                      className="mt-0.5 accent-[#b3541e]"
                    />
                    <span>
                      <span className="block text-xs font-semibold text-ink">{t('adminAccounts.makeAdmin')}</span>
                      <span className="block text-[11px] leading-relaxed text-muted">{t('adminAccounts.makeAdminHint')}</span>
                    </span>
                  </label>
                )}

                <div className="mt-4 flex gap-1.5">
                  <button
                    type="button"
                    disabled={!createValid || acting === 'new'}
                    onClick={create}
                    className="flex-1 rounded-os bg-accent px-2.5 py-2 text-xs font-semibold text-accentink duration-160 hover:opacity-90 disabled:opacity-50"
                  >
                    {acting === 'new' ? '…' : t('adminAccounts.create')}
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowCreate(false)}
                    className="rounded-os border border-osborder px-2.5 py-2 text-xs font-medium text-ink duration-160 hover:border-accent"
                  >
                    {t('adminAccounts.cancel')}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* ---------- reset password dialog ---------- */}
      {resetFor && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setResetFor(null)}>
          <div className="w-full max-w-xs rounded-os border border-osborder bg-paper p-4 shadow-oswin" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-sm font-semibold text-ink">{t('adminAccounts.resetTitle', { name: resetFor.username })}</h3>
            <p className="mt-1 text-[11px] leading-relaxed text-muted">{t('adminAccounts.resetBody')}</p>
            <input
              type="password"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              value={resetPass}
              onChange={(e) => setResetPass(e.target.value)}
              placeholder={t('adminAccounts.newPassword')}
              autoComplete="new-password"
              className="mt-3 w-full rounded-os border border-osborder bg-surface px-2.5 py-1.5 text-xs text-ink outline-none focus:border-accent"
            />
            <div className="mt-3 flex gap-1.5">
              <button
                type="button"
                disabled={acting === resetFor.id || resetPass.length < 8}
                onClick={doReset}
                className="flex-1 rounded-os bg-accent px-2.5 py-1.5 text-xs font-semibold text-accentink duration-160 hover:opacity-90 disabled:opacity-50"
              >
                {t('adminAccounts.apply')}
              </button>
              <button
                type="button"
                onClick={() => setResetFor(null)}
                className="rounded-os border border-osborder px-2.5 py-1.5 text-xs font-medium text-ink duration-160 hover:border-accent"
              >
                {t('adminAccounts.cancel')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ---------- delete confirm dialog ---------- */}
      {deleteFor && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setDeleteFor(null)}>
          <div className="w-full max-w-xs rounded-os border border-osborder bg-paper p-4 shadow-oswin" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-sm font-semibold text-ink">
              {t('adminAccounts.deleteConfirmTitle', { name: deleteFor.username })}
            </h3>
            <p className="mt-1 text-[11px] leading-relaxed text-muted">{t('adminAccounts.deleteConfirmBody')}</p>
            <div className="mt-3 flex gap-1.5">
              <button
                type="button"
                disabled={acting === deleteFor.id}
                onClick={doDelete}
                className="flex-1 rounded-os bg-red-600 px-2.5 py-1.5 text-xs font-semibold text-white duration-160 hover:opacity-90 disabled:opacity-50"
              >
                {t('adminAccounts.delete')}
              </button>
              <button
                type="button"
                onClick={() => setDeleteFor(null)}
                className="rounded-os border border-osborder px-2.5 py-1.5 text-xs font-medium text-ink duration-160 hover:border-accent"
              >
                {t('adminAccounts.cancel')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ---------- role change confirm dialog ---------- */}
      {roleFor && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setRoleFor(null)}>
          <div className="w-full max-w-xs rounded-os border border-osborder bg-paper p-4 shadow-oswin" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-sm font-semibold text-ink">
              {roleFor.role === 'admin'
                ? t('adminAccounts.promoteConfirmTitle', { name: roleFor.user.username })
                : t('adminAccounts.demoteConfirmTitle', { name: roleFor.user.username })}
            </h3>
            <p className="mt-1 text-[11px] leading-relaxed text-muted">
              {roleFor.role === 'admin'
                ? t('adminAccounts.promoteConfirmBody')
                : t('adminAccounts.demoteConfirmBody')}
            </p>
            <div className="mt-3 flex gap-1.5">
              <button
                type="button"
                disabled={acting === roleFor.user.id}
                onClick={doSetRole}
                className="flex-1 rounded-os bg-accent px-2.5 py-1.5 text-xs font-semibold text-accentink duration-160 hover:opacity-90 disabled:opacity-50"
              >
                {roleFor.role === 'admin' ? t('adminAccounts.makeAdmin') : t('adminAccounts.makeStandard')}
              </button>
              <button
                type="button"
                onClick={() => setRoleFor(null)}
                className="rounded-os border border-osborder px-2.5 py-1.5 text-xs font-medium text-ink duration-160 hover:border-accent"
              >
                {t('adminAccounts.cancel')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}


function TicketsSection() {
  const { t } = useLang();
  const [tickets, setTickets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(null);
  const [responses, setResponses] = useState({});
  const [filter, setFilter] = useState('open'); // 'open' | 'all'
  const [scopeFilter, setScopeFilter] = useState('all'); // 'all' | 'platform' | 'shop' (072: purchase/unlock inbox)
  // username (lowercased) -> profile, for one-click password resets on
  // logged-out tickets.
  const [profilesByName, setProfilesByName] = useState({});
  const [resetFor, setResetFor] = useState(null); // { profile, ticket }
  const [resetPass, setResetPass] = useState('');

  const load = useCallback(async () => {
    setError('');
    setLoading(true);
    try {
      const rows = await backend.support.adminListTickets();
      setTickets(Array.isArray(rows) ? rows : []);
      const profiles = await backend.auth.adminListProfiles();
      const byName = {};
      for (const p of profiles) {
        if (p.username) byName[String(p.username).toLowerCase()] = p;
      }
      setProfilesByName(byName);
      setResponses((prev) => {
        const next = { ...prev };
        const safeRows = Array.isArray(rows) ? rows : [];
        for (const t of safeRows) if (!(t.id in next)) next[t.id] = t.admin_response || '';
        return next;
      });
    } catch (e) {
      setError(e.message || t('err.loadTickets'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const save = useCallback(async (ticket, patch, label) => {
    setError('');
    setSaving(ticket.id);
    try {
      await backend.support.adminUpdateTicket(ticket.id, patch);
      const rows = await backend.support.adminListTickets();
      setTickets(Array.isArray(rows) ? rows : []);
    } catch (e) {
      setError(t('adminAccounts.errTicketAction', { label, msg: e.message || e }));
    } finally {
      setSaving(null);
    }
  }, []);

  const visible = (filter === 'all' ? tickets : (Array.isArray(tickets) ? tickets : []).filter((t) => t.status !== 'resolved'))
    .filter((tk) => scopeFilter === 'all' || (tk.scope || 'shop') === scopeFilter);
  const openCount = (Array.isArray(tickets) ? tickets : []).filter((t) => t.status === 'open').length;

  const doTicketReset = useCallback(async () => {
    if (!resetFor || resetPass.length < 8) return;
    const { profile, ticket } = resetFor;
    setError('');
    setSaving(ticket.id);
    try {
      await backend.auth.adminResetPassword(profile.id, resetPass);
      // Mark it in progress so it's clear the reset was actioned.
      await backend.support.adminUpdateTicket(ticket.id, { status: 'in_progress' });
      const rows = await backend.support.adminListTickets();
      setTickets(Array.isArray(rows) ? rows : []);
    } catch (e) {
      setError(t('adminAccounts.errResetPassword', { msg: e.message || e }));
    } finally {
      setSaving(null);
      setResetFor(null);
      setResetPass('');
    }
  }, [resetFor, resetPass]);

  return (
    <>
      <div className="flex items-center gap-2 border-b border-osborder px-4 py-2.5">
        <p className="min-w-0 flex-1 text-xs text-muted">
          {loading ? t('common.loading') : t('admin.ticketCounts', { n: tickets.length, open: openCount })}
        </p>
        <div className="flex gap-1 rounded-os bg-paper p-0.5">
          {[['open', t('admin.needsReply')], ['all', t('admin.allFilter')]].map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setFilter(id)}
              className={`rounded-os px-2.5 py-1 text-xs font-medium duration-160 ${filter === id ? 'bg-surface text-ink shadow-os' : 'text-muted hover:text-ink'}`}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="flex gap-1 rounded-os bg-paper p-0.5">
          {[
            ['all', t('licensing.ticketsScopeAll')],
            ['platform', t('licensing.ticketsScopePlatform')],
            ['shop', t('licensing.ticketsScopeShop')],
          ].map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setScopeFilter(id)}
              className={`rounded-os px-2.5 py-1 text-xs font-medium duration-160 ${scopeFilter === id ? 'bg-surface text-ink shadow-os' : 'text-muted hover:text-ink'}`}
            >
              {label}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={load}
          disabled={loading}
          className="flex items-center gap-1.5 rounded-os border border-osborder bg-paper px-2.5 py-1.5 text-xs font-medium text-ink duration-160 hover:border-accent disabled:opacity-50"
        >
          <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
          {t('admin.refresh')}
        </button>
      </div>

      {error && (
        <div className="border-b border-osborder bg-paper px-4 py-2 text-xs text-red-600">{error}</div>
      )}

      <div className="flex-1 overflow-y-auto p-3">
        {visible.length === 0 ? (
          <p className="p-6 text-center text-xs text-muted">
            {tickets.length === 0 ? t('admin.noTicketsYet') : t('admin.nothingNeedsReply')}
          </p>
        ) : (
          <ul className="space-y-2">
            {visible.map((ticket) => {
              const st = TICKET_STATUS[ticket.status] || TICKET_STATUS.open;
              const busy = saving === ticket.id;
              return (
                <li key={ticket.id} className="rounded-os border border-osborder bg-paper px-3 py-2.5">
                  <div className="flex items-center gap-2">
                    <p className="min-w-0 flex-1 truncate text-sm font-medium text-ink">{ticket.subject}</p>
                    <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${TONE[st.tone]}`}>
                      {t(st.labelKey)}
                    </span>
                  </div>
                  <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted">
                    <span>{ticket.username} · {fmtDate(ticket.created_at)}</span>
                    <span className="rounded-full bg-surface px-2 py-0.5 font-medium ring-1 ring-osborder">
                      {ticket.scope === 'platform'
                        ? t('licensing.ticketsPlatformBadge')
                        : t('licensing.ticketsShopBadge')}
                    </span>
                    {!ticket.user_id && (
                      <span className="rounded-full bg-surface px-2 py-0.5 font-medium ring-1 ring-osborder">
                        {t('admin.notSignedIn')}
                      </span>
                    )}
                  </p>
                  <p className="mt-1.5 whitespace-pre-wrap text-sm text-ink">{ticket.message}</p>
                  <div className="mt-2 border-t border-osborder pt-2">
                    <label className="mb-1 block text-[11px] font-medium text-muted">
                      Your reply {ticket.admin_response && <span className="font-normal">(sent {fmtDate(ticket.updated_at)})</span>}
                    </label>
                    <textarea
                      value={responses[ticket.id] ?? ''}
                      onChange={(e) => setResponses((p) => ({ ...p, [ticket.id]: e.target.value }))}
                      rows={2}
                      placeholder="Write a reply…"
                      className="w-full rounded-os border border-osborder bg-surface px-2.5 py-1.5 text-xs text-ink outline-none focus:border-accent"
                    />
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                      <select
                        value={ticket.status}
                        disabled={busy}
                        onChange={(e) => save(ticket, { status: e.target.value }, 'Status change')}
                        className="rounded-os border border-osborder bg-surface px-2 py-1 text-xs text-ink outline-none focus:border-accent disabled:opacity-50"
                        aria-label="Ticket status"
                      >
                        <option value="open">{t('adminAccounts.tickets.statusOpen')}</option>
                        <option value="in_progress">{t('adminAccounts.tickets.statusInProgress')}</option>
                        <option value="resolved">{t('adminAccounts.tickets.statusResolved')}</option>
                      </select>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => save(ticket, { admin_response: responses[ticket.id] ?? '', status: 'resolved' }, 'Reply')}
                        className="flex items-center gap-1 rounded-os bg-accent px-2.5 py-1 text-xs font-semibold text-accentink duration-160 hover:opacity-90 disabled:opacity-50"
                      >
                        <Send size={12} />
                        {busy ? 'Saving…' : 'Reply & resolve'}
                      </button>
                      {(responses[ticket.id] ?? '') !== (ticket.admin_response || '') && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => save(ticket, { admin_response: responses[ticket.id] ?? '' }, 'Reply save')}
                          className="rounded-os border border-osborder px-2.5 py-1 text-xs font-medium text-ink duration-160 hover:border-accent disabled:opacity-50"
                        >
                          {t('admin.saveReplyOnly')}
                        </button>
                      )}
                      {(() => {
                        if (ticket.user_id || ticket.status === 'resolved') return null;
                        const match = profilesByName[String(ticket.username || '').toLowerCase()];
                        return match ? (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => { setResetFor({ profile: match, ticket }); setResetPass(''); }}
                            className="flex items-center gap-1 rounded-os border border-osborder px-2 py-1 text-xs font-medium text-ink duration-160 hover:border-accent disabled:opacity-50"
                          >
                            <KeyRound size={12} />
                            {t('admin.resetPassword')}
                          </button>
                        ) : (
                          <span className="text-[11px] text-muted">{t('admin.noAccountMatch', { username: ticket.username })}</span>
                        );
                      })()}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {resetFor && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setResetFor(null)}>
          <div className="w-full max-w-xs rounded-os border border-osborder bg-paper p-4 shadow-oswin" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-sm font-semibold text-ink">{t('admin.resetPasswordFor', { username: resetFor.profile.username })}</h3>
            <p className="mt-1 text-[11px] leading-relaxed text-muted">
              {t('admin.resetExplainer')}
            </p>
            <input
              type="password"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              value={resetPass}
              onChange={(e) => setResetPass(e.target.value)}
              placeholder={t('admin.newPasswordPh')}
              autoComplete="new-password"
              className="mt-3 w-full rounded-os border border-osborder bg-surface px-2.5 py-1.5 text-xs text-ink outline-none focus:border-accent"
            />
            <div className="mt-3 flex gap-1.5">
              <button
                type="button"
                disabled={saving === resetFor.ticket.id || resetPass.length < 8}
                onClick={doTicketReset}
                className="flex-1 rounded-os bg-accent px-2.5 py-1.5 text-xs font-semibold text-accentink duration-160 hover:opacity-90 disabled:opacity-50"
              >
                {t('admin.apply')}
              </button>
              <button
                type="button"
                onClick={() => setResetFor(null)}
                className="rounded-os border border-osborder px-2.5 py-1.5 text-xs font-medium text-ink duration-160 hover:border-accent"
              >
                {t('common.cancel')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/* ---------------- feedback section ---------------- */

function FeedbackSection() {
  const { t } = useLang();
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(null);
  const [filter, setFilter] = useState('new'); // 'new' | 'all'

  const load = useCallback(async () => {
    setError('');
    setLoading(true);
    try {
      setItems(await backend.feedback.adminList());
    } catch (e) {
      setError(e.message || t('err.loadFeedback'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const toggle = useCallback(async (f) => {
    setError('');
    setSaving(f.id);
    try {
      await backend.feedback.adminSetReviewed(f.id, !f.reviewed);
      setItems(await backend.feedback.adminList());
    } catch (e) {
      setError(t('adminAccounts.errFeedbackUpdate', { msg: e.message || e }));
    } finally {
      setSaving(null);
    }
  }, []);

  const visible = filter === 'all' ? items : items.filter((f) => !f.reviewed);
  const newCount = items.filter((f) => !f.reviewed).length;

  return (
    <>
      <div className="flex items-center gap-2 border-b border-osborder px-4 py-2.5">
        <p className="min-w-0 flex-1 text-xs text-muted">
          {loading ? t('common.loading') : `${items.length} messages · ${newCount} new`}
        </p>
        <div className="flex gap-1 rounded-os bg-paper p-0.5">
          {[['new', 'New'], ['all', 'All']].map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setFilter(id)}
              className={`rounded-os px-2.5 py-1 text-xs font-medium duration-160 ${filter === id ? 'bg-surface text-ink shadow-os' : 'text-muted hover:text-ink'}`}
            >
              {label}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={load}
          disabled={loading}
          className="flex items-center gap-1.5 rounded-os border border-osborder bg-paper px-2.5 py-1.5 text-xs font-medium text-ink duration-160 hover:border-accent disabled:opacity-50"
        >
          <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
          {t('admin.refresh')}
        </button>
      </div>

      {error && (
        <div className="border-b border-osborder bg-paper px-4 py-2 text-xs text-red-600">{error}</div>
      )}

      <div className="flex-1 overflow-y-auto p-3">
        {visible.length === 0 ? (
          <p className="p-6 text-center text-xs text-muted">
            {items.length === 0 ? 'No feedback yet.' : 'All caught up.'}
          </p>
        ) : (
          <ul className="space-y-2">
            {visible.map((f) => (
              <li key={f.id} className="rounded-os border border-osborder bg-paper px-3 py-2.5">
                <div className="flex items-center gap-2">
                  <p className="min-w-0 flex-1 text-[11px] text-muted">
                    {f.username} · {fmtDate(f.created_at)}
                  </p>
                  {f.rating != null && (
                    <span className="flex shrink-0 items-center gap-0.5" title={`${f.rating} out of 5`}>
                      {[1, 2, 3, 4, 5].map((s) => (
                        <Star
                          key={s}
                          size={12}
                          className={s <= f.rating ? 'fill-accent text-accent' : 'text-osborder'}
                        />
                      ))}
                    </span>
                  )}
                </div>
                <p className="mt-1 whitespace-pre-wrap text-sm text-ink">{f.message}</p>
                <div className="mt-2 border-t border-osborder pt-2">
                  <button
                    type="button"
                    disabled={saving === f.id}
                    onClick={() => toggle(f)}
                    className="rounded-os border border-osborder px-2.5 py-1 text-xs font-medium text-ink duration-160 hover:border-accent disabled:opacity-50"
                  >
                    {f.reviewed ? 'Mark as new' : 'Mark reviewed'}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}


/* ---------------- shops: store + team management ---------------- */

/**
 * Shops — manage the pos_stores this admin belongs to: rename, team
 * members (roles, removals), and invite codes. Mirrors the POS Team tab
 * so shop management doesn't require opening the POS app.
 */
function ShopsSection() {
  const { t } = useLang();
  const { user } = useAuth();
  const selfId = user?.id ?? null;
  const [stores, setStores] = useState([]);
  const [storeId, setStoreId] = useState('');
  const [members, setMembers] = useState([]);
  const [invites, setInvites] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const teamLock = useRef(false); // synchronous double-submit lock for team/invite actions
  const [inviteRole, setInviteRole] = useState('cashier');
  const [filesUsage, setFilesUsage] = useState(null);
  const [renameName, setRenameName] = useState('');
  const [confirmRemove, setConfirmRemove] = useState(null);

  const store = stores.find((s) => s.id === storeId) || null;
  const manager = store && (store.role === 'owner' || store.role === 'manager');
  const isOwner = store && store.role === 'owner';

  const loadStores = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const list = await backend.pos.listStores();
      setStores(list);
      if (list.length > 0 && !list.some((s) => s.id === storeId)) {
        setStoreId(list[0].id);
        setRenameName(list[0].name || '');
      }
    } catch (err) {
      setError(err.message || t('adminUsers.loadFail'));
    } finally {
      setLoading(false);
    }
  }, [storeId, t]);

  const loadTeam = useCallback(async (sid) => {
    if (!sid) { setMembers([]); setInvites([]); return; }
    try {
      const [ms, invs] = await Promise.all([
        backend.pos.listMembers(sid),
        backend.pos.listInvites(sid).catch(() => []),
      ]);
      setMembers(ms);
      setInvites(invs);
    } catch (err) {
      setError(err.message || t('adminUsers.loadFail'));
    }
  }, [t]);

  useEffect(() => { loadStores(); }, [loadStores]);
  useEffect(() => { if (storeId) loadTeam(storeId); }, [storeId, loadTeam]);
  useEffect(() => {
    // Per-shop storage readout (Files → Shop files): summed from
    // vfs_files.size_bytes, members only (RLS). Silent no-op on
    // failure — a missing readout must never break the Shops tab.
    if (!storeId) { setFilesUsage(null); return; }
    let cancelled = false;
    backend.shopFiles.usageBytes(storeId)
      .then((u) => { if (!cancelled) setFilesUsage(u); })
      .catch(() => { if (!cancelled) setFilesUsage(null); });
    return () => { cancelled = true; };
  }, [storeId]);

  const otherOwnersRemain = (userId) =>
    members.some((m) => m.role === 'owner' && m.userId !== userId);
  const blockIfLastOwner = (member) => {
    if (member.role === 'owner' && !otherOwnersRemain(member.userId)) {
      setError(t('adminUsers.shopsLastOwner'));
      return true;
    }
    return false;
  };

  const doSetRole = async (member, next) => {
    if (next === member.role) return;
    if (blockIfLastOwner(member)) return;
    if (teamLock.current) return;
    teamLock.current = true;
    setBusy(true);
    setError('');
    try {
      await backend.pos.setMemberRole(storeId, member.userId, next);
      await loadTeam(storeId);
    } catch (err) {
      setError(t('adminUsers.actionFail') + (err.message || ''));
    } finally {
      teamLock.current = false;
      setBusy(false);
    }
  };

  const doRemove = async (member) => {
    if (blockIfLastOwner(member)) { setConfirmRemove(null); return; }
    if (teamLock.current) return;
    teamLock.current = true;
    setBusy(true);
    setError('');
    try {
      await backend.pos.removeMember(storeId, member.userId);
      setConfirmRemove(null);
      await loadTeam(storeId);
    } catch (err) {
      setError(t('adminUsers.actionFail') + (err.message || ''));
    } finally {
      teamLock.current = false;
      setBusy(false);
    }
  };

  const doCreateInvite = async () => {
    if (teamLock.current) return;
    teamLock.current = true;
    setBusy(true);
    setError('');
    try {
      await backend.pos.createInvite(storeId, { role: inviteRole });
      await loadTeam(storeId);
    } catch (err) {
      setError(t('adminUsers.actionFail') + (err.message || ''));
    } finally {
      teamLock.current = false;
      setBusy(false);
    }
  };

  const doRevokeInvite = async (inviteId) => {
    if (teamLock.current) return;
    teamLock.current = true;
    setBusy(true);
    setError('');
    try {
      await backend.pos.revokeInvite(storeId, inviteId);
      await loadTeam(storeId);
    } catch (err) {
      setError(t('adminUsers.actionFail') + (err.message || ''));
    } finally {
      teamLock.current = false;
      setBusy(false);
    }
  };

  const doRename = async () => {
    const name = renameName.trim();
    if (!name || !store || name === store.name) return;
    setBusy(true);
    setError('');
    try {
      await backend.pos.updateStore(storeId, { name });
      await loadStores();
    } catch (err) {
      setError(t('adminUsers.actionFail') + (err.message || ''));
    } finally {
      setBusy(false);
    }
  };

  const copyCode = (code) => {
    try { navigator.clipboard.writeText(code); } catch { /* visible to copy by hand */ }
  };

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-sm text-muted">
        {t('common.loading')}
      </div>
    );
  }

  if (stores.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
        <Users size={28} className="text-muted" />
        <p className="text-sm font-medium text-ink">{t('adminUsers.shopsEmpty')}</p>
        <p className="max-w-xs text-xs text-muted">{t('adminUsers.shopsEmptyHint')}</p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-4">
      {error && (
        <div className="rounded-os border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-700">
          {error}
        </div>
      )}

      {/* Store picker + rename */}
      <section className="rounded-os border border-osborder bg-paper p-3">
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={storeId}
            onChange={(e) => {
              setStoreId(e.target.value);
              const s = stores.find((x) => x.id === e.target.value);
              setRenameName(s?.name || '');
            }}
            className="rounded-os border border-osborder bg-surface px-2 py-1.5 text-sm text-ink"
            aria-label={t('adminUsers.tabShops')}
          >
            {stores.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} · {s.role}
              </option>
            ))}
          </select>
          {manager && (
            <>
              <input
                value={renameName}
                onChange={(e) => setRenameName(e.target.value)}
                placeholder={t('adminUsers.shopsRenamePlaceholder')}
                className="min-w-0 flex-1 rounded-os border border-osborder bg-surface px-2 py-1.5 text-sm text-ink"
              />
              <button
                type="button"
                onClick={doRename}
                disabled={busy || !renameName.trim() || renameName.trim() === store?.name}
                className="rounded-os bg-accent px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
              >
                {t('adminUsers.shopsRename')}
              </button>
            </>
          )}
        </div>
        {filesUsage && (
          <p className="mt-2 text-xs text-muted">
            {t('adminUsers.shopsFilesUsage', { size: fmtBytes(filesUsage.bytes), n: filesUsage.files })}
          </p>
        )}
      </section>

      {/* Members */}
      <section>
        <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold text-ink">
          <Users size={15} className="text-accent" />
          {t('adminUsers.shopsMembers')} · {members.length}
        </h3>
        <div className="space-y-2">
          {members.map((m) => (
            <div key={m.userId} className="flex items-center gap-3 rounded-os border border-osborder bg-paper px-4 py-2.5">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-os bg-accent/15 text-sm font-bold text-accent">
                {(m.username || '?').slice(0, 1).toUpperCase()}
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-ink">
                  {m.username}
                  {m.userId === selfId && <span className="ml-2 text-xs text-muted">({t('adminUsers.shopsYou')})</span>}
                </p>
                <p className="text-xs text-muted">{m.role}</p>
              </div>
              {isOwner && m.userId !== selfId && (
                <select
                  value={m.role}
                  disabled={busy}
                  onChange={(e) => doSetRole(m, e.target.value)}
                  className="rounded-os border border-osborder bg-surface px-2 py-1 text-xs text-ink"
                  aria-label={t('adminUsers.shopsChangeRole')}
                >
                  <option value="owner">{t('punch.roleOwner')}</option>
                  <option value="manager">{t('punch.roleManager')}</option>
                  <option value="cashier">{t('punch.roleCashier')}</option>
                </select>
              )}
              {(m.userId === selfId || isOwner) && (
                <button
                  type="button"
                  onClick={() => setConfirmRemove(m)}
                  disabled={busy}
                  className="rounded-os p-1.5 text-muted hover:bg-red-500/10 hover:text-red-600 disabled:opacity-50"
                  aria-label={m.userId === selfId ? t('adminUsers.shopsLeave') : t('adminUsers.shopsRemove')}
                >
                  <Trash2 size={15} />
                </button>
              )}
            </div>
          ))}
        </div>
        {confirmRemove && (
          <div className="mt-2 rounded-os border border-red-500/40 bg-red-500/10 p-3 text-xs">
            <p className="font-medium text-red-700">
              {confirmRemove.userId === selfId ? t('adminUsers.shopsLeaveConfirm') : t('adminUsers.shopsRemoveConfirm', { name: confirmRemove.username })}
            </p>
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                onClick={() => doRemove(confirmRemove)}
                disabled={busy}
                className="rounded-os bg-red-600 px-3 py-1.5 font-medium text-white disabled:opacity-50"
              >
                {t('adminUsers.confirm')}
              </button>
              <button
                type="button"
                onClick={() => setConfirmRemove(null)}
                className="rounded-os border border-osborder px-3 py-1.5 text-ink"
              >
                {t('common.cancel')}
              </button>
            </div>
          </div>
        )}
      </section>

      {/* Invite codes */}
      {manager && (
        <section>
          <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold text-ink">
            <KeyRound size={15} className="text-accent" />
            {t('adminUsers.shopsInvites')}
          </h3>
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <select
              value={inviteRole}
              onChange={(e) => setInviteRole(e.target.value)}
              className="rounded-os border border-osborder bg-surface px-2 py-1.5 text-xs text-ink"
            >
              <option value="cashier">{t('punch.roleCashier')}</option>
              <option value="manager">{t('punch.roleManager')}</option>
            </select>
            <button
              type="button"
              onClick={doCreateInvite}
              disabled={busy}
              className="flex items-center gap-1.5 rounded-os bg-accent px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
            >
              <UserPlus size={14} /> {t('adminUsers.shopsNewInvite')}
            </button>
          </div>
          <div className="space-y-2">
            {invites.map((inv) => (
              <div key={inv.id} className="flex items-center gap-3 rounded-os border border-osborder bg-paper px-4 py-2">
                <button
                  type="button"
                  onClick={() => copyCode(inv.code)}
                  className="font-mono text-sm font-bold tracking-widest text-accent hover:underline"
                  title={t('adminUsers.shopsCopyCode')}
                >
                  {inv.code}
                </button>
                <span className="text-xs text-muted">{inv.role}</span>
                <span className="ml-auto text-xs text-muted">
                  {t('adminUsers.shopsUses', { uses: inv.uses ?? 0, max: inv.maxUses ?? '∞' })}
                </span>
                <button
                  type="button"
                  onClick={() => doRevokeInvite(inv.id)}
                  disabled={busy}
                  className="rounded-os p-1.5 text-muted hover:bg-red-500/10 hover:text-red-600 disabled:opacity-50"
                  aria-label={t('adminUsers.shopsRevoke')}
                >
                  <X size={14} />
                </button>
              </div>
            ))}
            {invites.length === 0 && (
              <p className="text-xs text-muted">{t('adminUsers.shopsNoInvites')}</p>
            )}
          </div>
        </section>
      )}
    </div>
  );
}

/* ---------------- shell ---------------- */

/**
 * Admin — account administration, support tickets, and user feedback.
 * Admin-only: the component gates on the caller's profile role, and every
 * mutation is enforced again server-side by RLS. Cloud mode only.
 */
/* ---------------- factory reset (master account only) ----------------
 * One action wiping the build back to factory state: every account, every
 * row of application data, every stored file — then the master account is
 * reseeded (migration 057). Destructive by design:
 *  - rendered only when the caller's profile has is_master = true;
 *  - the server-side factory_reset() RPC re-verifies is_master and runs
 *    the wipe+reseed in a single transaction (failure-atomic);
 *  - the button arms only after typing RESET exactly;
 *  - BEFORE the wipe, the app attempts a full account backup (the same
 *    export as Settings -> Backup) and auto-downloads it; if the backup
 *    attempt fails the reset is ABORTED with a loud error and nothing is
 *    deleted (fail-safe direction — never wipe without the attempted
 *    safety net). A best-effort in-session snapshot of each store is also
 *    captured first via snapshotBeforeDestructive() (memory-only — it
 *    never touches this device's storage).
 * After the RPC resolves the caller's own user row is gone, so we sign out
 * and leave a one-time notice flag for the login screen.
 */
function DangerSection() {
  const { t } = useLang();
  const { signOut } = useAuth();
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const armed = confirm === 'RESET';
  const resetLockRef = useRef(false); // synchronous double-submit lock

  const doReset = async () => {
    if (!armed || busy || resetLockRef.current) return;
    resetLockRef.current = true;
    setBusy(true);
    setError('');
    try {
      // Pre-reset safety net: attempt a full account
      // backup BEFORE the wipe, using the exact same export mechanism as
      // Settings → Backup, and auto-download it. If the backup attempt
      // fails, ABORT the reset with a loud bilingual error — fail-safe
      // direction: never wipe without the attempted safety net.
      try {
        // Best-effort device-local snapshots first (never throw, never block).
        try {
          const stores = (await backend.pos.listStores().catch(() => [])) || [];
          for (const s of stores) {
            await snapshotBeforeDestructive(s.id, 'pre-factory-reset');
          }
        } catch {
          /* best effort only */
        }
        const dump = await exportAccountBackup();
        downloadBackupFile(
          dump,
          `drift-shop-pre-reset-backup-${new Date().toISOString().slice(0, 10)}.json`
        );
      } catch (bErr) {
        throw new Error(
          `${t('adminUsers.factoryResetBackupFailed')}${bErr?.message ? ` (${bErr.message})` : ''}`
        );
      }
      await backend.auth.factoryReset();
      try {
        localStorage.setItem('driftshop_factory_reset_notice', '1');
      } catch {
        /* non-fatal */
      }
      try {
        await signOut();
      } catch {
        // The user row is gone; if sign-out itself fails, a reload lands
        // on the login screen with the dead session discarded.
        window.location.reload();
      }
    } catch (e) {
      setError(e?.message || t('adminUsers.factoryResetFailed'));
    } finally {
      resetLockRef.current = false;
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-4">
      <section className="rounded-os border border-red-500/50 bg-paper p-4">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-red-700">
          <ShieldAlert size={16} />
          {t('adminUsers.factoryResetTitle')}
        </h3>
        <div className="mt-2 space-y-2 text-xs leading-relaxed text-ink">
          <p>{t('adminUsers.factoryResetWhat')}</p>
          <p className="font-semibold text-red-700">{t('adminUsers.factoryResetIrreversible')}</p>
          <p>{t('adminUsers.factoryResetNoBackup')}</p>
          <p className="text-muted">{t('adminUsers.factoryResetSession')}</p>
        </div>
        {error && (
          <div role="alert" className="mt-3 rounded-os border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-700">
            {error}
          </div>
        )}
        <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center">
          <input
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            placeholder="RESET"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            aria-label={t('adminUsers.factoryResetTypeLabel')}
            className="w-full rounded-os border border-osborder bg-surface px-3 py-2 text-sm text-ink outline-none duration-160 focus:border-red-500 sm:max-w-[12rem]"
          />
          <button
            type="button"
            onClick={doReset}
            disabled={!armed || busy}
            className="flex items-center justify-center gap-2 rounded-os bg-red-600 px-4 py-2 text-sm font-semibold text-white duration-160 hover:bg-red-700 disabled:opacity-40"
          >
            <Trash2 size={15} />
            {busy ? t('adminUsers.factoryResetWorking') : t('adminUsers.factoryResetButton')}
          </button>
        </div>
        <p className="mt-2 text-xs text-muted">{t('adminUsers.factoryResetTypeHint')}</p>
      </section>

      <RestoreSection />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Backup restore (owner/master-only). Phase 1: pick a backup file,    */
/* see in plain words what is inside, type RESTORE, then the app       */
/* saves a fresh backup of the current state, wipes via the SAME       */
/* factory_reset() path as above, and signs the user out. Phase 2      */
/* (after signing back in as master): pick the file once more and      */
/* runBackupRestore() puts everything into the fresh install.          */
/* ------------------------------------------------------------------ */
function RestoreSection() {
  const { t } = useLang();
  const { signOut } = useAuth();

  // Phase 1 — pick + validate + confirm + safety backup + wipe.
  const [picked, setPicked] = useState(null);
  const [confirmWord, setConfirmWord] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const phase1InputRef = useRef(null);

  // Phase 2 — shown when a restore is waiting (flag set by phase 1).
  const [pending] = useState(() => getRestorePending());
  const [finishPicked, setFinishPicked] = useState(null);
  const [finishBusy, setFinishBusy] = useState(false);
  const [finishError, setFinishError] = useState('');
  const [finishReport, setFinishReport] = useState(null);
  const finishInputRef = useRef(null);

  const armed = confirmWord === 'RESTORE' && !!picked;

  const readBackupFile = async (file) => {
    if (!file) return null;
    let data;
    try {
      data = JSON.parse(await file.text());
    } catch {
      return { parseError: true };
    }
    const validation = validateBackup(data);
    if (!validation.ok) {
      return { fatal: validation.fatal?.[0] || 'not-a-backup' };
    }
    return { data, validation };
  };

  const onPhase1File = async (file) => {
    setError('');
    setPicked(null);
    setConfirmWord('');
    const res = await readBackupFile(file);
    if (!res) return;
    if (res.parseError) { setError(t('adminUsers.restoreFileInvalid')); return; }
    if (res.fatal) {
      setError(res.fatal === 'wrong-file' ? t('adminUsers.restoreWrongFile') : t('adminUsers.restoreNotABackup'));
      return;
    }
    setPicked(res);
  };

  const doPhase1 = async () => {
    if (!armed || busy || resetLockRef.current) return;
    resetLockRef.current = true;
    const releaseRestoreLock = acquireUpdateLock('backup-restore');
    setBusy(true);
    setError('');
    // (d) Safety net first: save how things are right now. If this
    // fails, abort — never wipe without the safety backup.
    const beforeName = `drift-shop-before-restore-${new Date().toISOString().slice(0, 10)}.json`;
    try {
      const dump = await exportAccountBackup();
      downloadBackupFile(dump, beforeName);
    } catch (bErr) {
      releaseRestoreLock();
      resetLockRef.current = false;
      setBusy(false);
      setError(t('adminUsers.restoreSafetyFailed'));
      return;
    }
    // Remember the restore is waiting, so phase 2 can greet the user
    // after they sign back in as master.
    setRestorePending({ beforeFilename: beforeName });
    // (e) Wipe via the same factory_reset() path as the factory reset.
    try {
      await backend.auth.factoryReset();
    } catch (e) {
      clearRestorePending();
      releaseRestoreLock();
      resetLockRef.current = false;
      setBusy(false);
      setError(t('adminUsers.restoreWipeFailed'));
      return;
    }
    try {
      localStorage.setItem('driftshop_factory_reset_notice', '1');
    } catch {
      /* non-fatal */
    }
    try {
      await signOut();
    } catch {
      window.location.reload();
    }
    releaseRestoreLock();
  };

  const onFinishFile = async (file) => {
    setFinishError('');
    setFinishPicked(null);
    const res = await readBackupFile(file);
    if (!res) return;
    if (res.parseError) { setFinishError(t('adminUsers.restoreFileInvalid')); return; }
    if (res.fatal) {
      setFinishError(res.fatal === 'wrong-file' ? t('adminUsers.restoreWrongFile') : t('adminUsers.restoreNotABackup'));
      return;
    }
    setFinishPicked(res);
  };

  const doPhase2 = async () => {
    if (!finishPicked || finishBusy) return;
    // Never let an app self-update reload the app mid-restore.
    const releaseRestoreLock = acquireUpdateLock('backup-restore');
    setFinishBusy(true);
    setFinishError('');
    try {
      const report = await runBackupRestore(finishPicked.data, { backend });
      setFinishReport(report);
      clearRestorePending();
      // Prevent re-running restore on the same file (duplicate rows).
      setFinishPicked(null);
      // L7: Record in persistent history.
      try {
        recordRestoreHistory({
          filename: finishPicked.name,
          tableCount: report?.restoredTables?.length || 0,
        });
      } catch {}
    } catch (err) {
      setFinishError(err?.message || String(err));
    } finally {
      releaseRestoreLock();
      setFinishBusy(false);
    }
  };

  const fmtSavedOn = (iso) => {
    if (!iso) return '';
    try {
      return new Intl.DateTimeFormat(localeTag(), { dateStyle: 'long' }).format(new Date(iso));
    } catch {
      return String(iso).slice(0, 10);
    }
  };

  const renderWarnings = (warnings) =>
    (warnings || []).map((w, i) => {
      const key = {
        'legacy-backup': 'adminUsers.restoreWarnLegacy',
        'newer-version': 'adminUsers.restoreWarnNewer',
        'partial-backup': 'adminUsers.restoreWarnPartial',
        'unknown-table': 'adminUsers.restoreWarnUnknownTable',
        'store-export-error': 'adminUsers.restoreWarnStoreError',
        'table-export-error': 'adminUsers.restoreWarnTableError',
        'files-not-embedded': 'adminUsers.restoreWarnFilesNotEmbedded',
      }[w.code];
      if (!key) return null;
      return (
        <p key={i} className="text-xs leading-relaxed text-ink">
          {t(key, { table: w.table || '', store: w.store || '', count: w.count ?? '' })}
        </p>
      );
    });

  const summaryBlock = (validation) => {
    const s = validation?.summary;
    if (!s) return null;
    return (
      <div className="mt-3 space-y-1 rounded-os border border-osborder bg-surface px-3 py-2">
        {s.exportedAt && (
          <p className="text-xs font-semibold text-ink">{t('adminUsers.restoreSavedOn', { date: fmtSavedOn(s.exportedAt) })}</p>
        )}
        {s.stores.map((st, i) => (
          <p key={i} className="text-xs leading-relaxed text-ink">
            {t('adminUsers.restoreShopLine', {
              name: st.name,
              products: st.products,
              sales: st.sales,
              refunds: st.refunds,
              customers: st.customers,
              staff: st.staff,
              appointments: st.appointments,
              giftCards: st.giftCards,
            })}
          </p>
        ))}
        <p className="text-xs leading-relaxed text-ink">
          {t('adminUsers.restoreCountsLine', {
            files: s.files,
            shopFiles: s.shopFiles,
            pins: s.pins,
            threads: s.threads,
            spaces: s.spaces,
          })}
        </p>
        {renderWarnings(validation.warnings)}
      </div>
    );
  };

  const doneBlock = () => {
    if (!finishReport) return null;
    const r = finishReport;
    const skippedExisting = (r.pinsSkippedAsExisting || 0) + (r.threadsSkippedAsExisting || 0);
    const problems = [];
    for (const pr of r.posReports || []) {
      for (const [table, msg] of Object.entries(pr.errors || {})) {
        if (msg) problems.push(`${pr.name}: ${table} — ${msg}`);
      }
    }
    for (const f of r.filesSkipped || []) problems.push(`${f.path} (${f.reason})`);
    for (const f of r.shopFilesSkipped || []) problems.push(`${f.path} (${f.reason})`);
    for (const e of r.errors || []) problems.push(e);
    if (r.supportReport?.tickets?.error) problems.push(r.supportReport.tickets.error);
    if (r.supportReport?.feedback?.error) problems.push(r.supportReport.feedback.error);
    return (
      <div className="mt-3 space-y-1 rounded-os border border-osborder bg-surface px-3 py-2">
        <p className="flex items-center gap-2 text-xs font-semibold text-ink">
          <CheckCircle2 size={14} /> {t('adminUsers.restoreDoneTitle')}
        </p>
        {(r.posReports || []).map((pr, i) => {
          if (pr.error) {
            return (
              <p key={i} className="text-xs leading-relaxed text-red-700">
                {t('adminUsers.restoreDoneStoreFailed', { name: pr.name, error: pr.error })}
              </p>
            );
          }
          const count = Object.values(pr.inserted || {}).reduce((a, b) => a + b, 0);
          return (
            <p key={i} className="text-xs leading-relaxed text-ink">
              {t('adminUsers.restoreDoneStore', { name: pr.name, count })}
            </p>
          );
        })}
        {r.filesRestored > 0 && <p className="text-xs leading-relaxed text-ink">{t('adminUsers.restoreDoneFiles', { count: r.filesRestored })}</p>}
        {r.shopFilesRestored > 0 && <p className="text-xs leading-relaxed text-ink">{t('adminUsers.restoreDoneShopFiles', { count: r.shopFilesRestored })}</p>}
        {r.pinsRestored > 0 && <p className="text-xs leading-relaxed text-ink">{t('adminUsers.restoreDonePins', { count: r.pinsRestored })}</p>}
        {r.threadsRestored > 0 && <p className="text-xs leading-relaxed text-ink">{t('adminUsers.restoreDoneThreads', { count: r.threadsRestored })}</p>}
        {r.spacesRestored > 0 && <p className="text-xs leading-relaxed text-ink">{t('adminUsers.restoreDoneSpaces', { count: r.spacesRestored })}</p>}
        {skippedExisting > 0 && <p className="text-xs leading-relaxed text-ink">{t('adminUsers.restoreDoneSkipped', { count: skippedExisting })}</p>}
        {problems.length > 0 && (
          <>
            <p className="pt-1 text-xs font-semibold text-red-700">{t('adminUsers.restoreProblemsTitle')}</p>
            {problems.map((p, i) => (
              <p key={i} className="text-xs leading-relaxed text-red-700">{t('adminUsers.restoreProblemLine', { text: p })}</p>
            ))}
          </>
        )}
        {pending?.beforeFilename && (
          <p className="text-xs leading-relaxed text-muted">{t('adminUsers.restoreUndoHint', { filename: pending.beforeFilename })}</p>
        )}
        <p className="text-xs leading-relaxed text-muted">{t('adminUsers.restoreRestartNote')}</p>
      </div>
    );
  };

  return (
    <>
      {pending && !finishReport && (
        <section className="rounded-os border border-amber-500/60 bg-paper p-4">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-amber-700">
            <Upload size={16} />
            {t('adminUsers.restorePendingTitle')}
          </h3>
          <p className="mt-2 text-xs leading-relaxed text-ink">{t('adminUsers.restorePendingBody')}</p>
          {finishError && (
            <div role="alert" className="mt-3 rounded-os border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-700">
              {finishError}
            </div>
          )}
          <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
            <button
              type="button"
              onClick={() => finishInputRef.current?.click()}
              disabled={finishBusy}
              className="flex items-center justify-center gap-2 rounded-os border border-osborder bg-surface px-4 py-2 text-sm text-ink duration-160 hover:border-amber-500 disabled:opacity-40"
            >
              <Upload size={15} />
              {t('adminUsers.restorePendingPick')}
            </button>
            <button
              type="button"
              onClick={doPhase2}
              disabled={!finishPicked || finishBusy}
              className="flex items-center justify-center gap-2 rounded-os bg-accent px-4 py-2 text-sm font-semibold text-accentink duration-160 disabled:opacity-40"
            >
              {finishBusy ? t('adminUsers.restorePendingRunning') : t('adminUsers.restorePendingRun')}
            </button>
          </div>
          <input
            ref={finishInputRef}
            type="file"
            accept=".json,application/json"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              onFinishFile(f);
            }}
          />
          {finishPicked && summaryBlock(finishPicked.validation)}
        </section>
      )}
      {finishReport && (
        <section className="rounded-os border border-osborder bg-paper p-4">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-ink">
            <Upload size={16} />
            {t('adminUsers.restoreTitle')}
          </h3>
          {doneBlock()}
        </section>
      )}

      <section className="rounded-os border border-red-500/50 bg-paper p-4">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-red-700">
          <Upload size={16} />
          {t('adminUsers.restoreTitle')}
        </h3>
        <p className="mt-2 text-xs leading-relaxed text-ink">{t('adminUsers.restoreIntro')}</p>
        <p className="mt-2 text-xs leading-relaxed text-ink">{t('adminUsers.restoreHowItWorks')}</p>
        {error && (
          <div role="alert" className="mt-3 rounded-os border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-700">
            {error}
          </div>
        )}
        <div className="mt-3">
          <button
            type="button"
            onClick={() => phase1InputRef.current?.click()}
            disabled={busy}
            className="flex items-center justify-center gap-2 rounded-os border border-osborder bg-surface px-4 py-2 text-sm text-ink duration-160 hover:border-red-500 disabled:opacity-40"
          >
            <Upload size={15} />
            {t('adminUsers.restorePickButton')}
          </button>
          <input
            ref={phase1InputRef}
            type="file"
            accept=".json,application/json"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              onPhase1File(f);
            }}
          />
        </div>
        {picked && summaryBlock(picked.validation)}
        {picked && (
          <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center">
            <input
              value={confirmWord}
              onChange={(e) => setConfirmWord(e.target.value)}
              placeholder="RESTORE"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              aria-label={t('adminUsers.restoreTypeLabel')}
              className="w-full rounded-os border border-osborder bg-surface px-3 py-2 text-sm text-ink outline-none duration-160 focus:border-red-500 sm:max-w-[12rem]"
            />
            <button
              type="button"
              onClick={doPhase1}
              disabled={!armed || busy}
              className="flex items-center justify-center gap-2 rounded-os bg-red-600 px-4 py-2 text-sm font-semibold text-white duration-160 hover:bg-red-700 disabled:opacity-40"
            >
              <Upload size={15} />
              {busy ? t('adminUsers.restoreWorking') : t('adminUsers.restoreEraseButton')}
            </button>
          </div>
        )}
        {picked && <p className="mt-2 text-xs text-muted">{t('adminUsers.restoreTypeHint')}</p>}
      </section>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Storefront editor (migration 063). Owners/managers shape the shop's */
/* public web page here; once published, the page is served to anyone  */
/* by the anon public_storefront() RPC. Visibility lives on the POS     */
/* products themselves (public_visible, default on) — products created  */
/* in the POS show up automatically.                                    */
/* ------------------------------------------------------------------ */
function StorefrontSection() {
  const { t } = useLang();
  const [stores, setStores] = useState([]);
  const [storeId, setStoreId] = useState('');
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [linksReady, setLinksReady] = useState(true);
  const [domainsReady, setDomainsReady] = useState(true);
  const [domains, setDomains] = useState([]);
  const [newDomain, setNewDomain] = useState('');
  const [domainMsg, setDomainMsg] = useState('');
  const [domainErr, setDomainErr] = useState('');
  const [domainBusy, setDomainBusy] = useState(false);
  const [ordersReady, setOrdersReady] = useState(true);
  const lock = useRef(false);
  const [form, setForm] = useState({
    slug: '', displayName: '', tagline: '', about: '', hours: '',
    contactEmail: '', contactPhone: '', accentColor: '',
    published: false, showPrices: true,
    address: '', facebookUrl: '', instagramUrl: '', tiktokUrl: '',
    whatsappPhone: '', reviewUrl: '', directionsUrl: '', orderUrl: '',
    newsletterUrl: '', onlineOrdering: false, orderingNote: '',
    lsEnabled: false, lsCheckoutUrl: '', lsStoreUrl: '', lsWebhookSecret: '',
    stripeEnabled: false, stripeCheckoutUrl: '', stripeWebhookSecret: '',
  });

  // Full slug (saved form): the DB rule is ^[a-z0-9][a-z0-9-]{0,62}$ —
  // no leading/trailing hyphen.
  const slugify = (s) =>
    String(s || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 63);
  // While-typing form (QA S-2): cleaning on every keystroke ate the
  // hyphen a shop owner just typed ("marie-" became "marie"). Keep
  // hyphens (even trailing) while typing; slugify() settles it on
  // blur and on save.
  const slugifyTyping = (s) =>
    String(s || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/-{2,}/g, '-')
      .slice(0, 63);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const ready = await backend.pos.storefrontLinksReady();
        if (!cancelled) setLinksReady(ready !== false);
      } catch {
        if (!cancelled) setLinksReady(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const ready = await backend.pos.customDomainsReady();
        if (!cancelled) setDomainsReady(ready !== false);
      } catch {
        if (!cancelled) setDomainsReady(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const ready = await backend.pos.onlineOrdersReady();
        if (!cancelled) setOrdersReady(ready !== false);
      } catch {
        if (!cancelled) setOrdersReady(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!storeId || !domainsReady) { setDomains([]); return; }
    let cancelled = false;
    (async () => {
      try {
        const list = await backend.pos.listCustomDomains(storeId);
        if (!cancelled) { setDomains(list || []); setDomainErr(''); }
      } catch (e) {
        if (!cancelled) setDomainErr(e.message || t('domains.loadFail'));
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId, domainsReady]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const list = (await backend.pos.listStores()) || [];
        if (cancelled) return;
        const mine = list.filter((s) => s.role === 'owner' || s.role === 'manager');
        setStores(mine);
        setStoreId((cur) => (mine.some((s) => s.id === cur) ? cur : mine[0]?.id || ''));
      } catch (e) {
        if (!cancelled) setError(e.message || t('storefront.loadFail'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!storeId) { setProducts([]); return; }
    let cancelled = false;
    (async () => {
      try {
        const [prof, prods] = await Promise.all([
          backend.pos.getStorefrontProfile(storeId),
          backend.pos.listProducts(storeId).catch(() => []),
        ]);
        if (cancelled) return;
        const store = stores.find((s) => s.id === storeId);
        setError('');
        setSaved(false);
        if (prof) {
          setForm({
            slug: prof.slug || '',
            displayName: prof.display_name || '',
            tagline: prof.tagline || '',
            about: prof.about || '',
            hours: prof.hours || '',
            contactEmail: prof.contact_email || '',
            contactPhone: prof.contact_phone || '',
            accentColor: prof.accent_color || '',
            published: !!prof.published,
            showPrices: prof.show_prices !== false,
            address: prof.address || '',
            facebookUrl: prof.facebook_url || '',
            instagramUrl: prof.instagram_url || '',
            tiktokUrl: prof.tiktok_url || '',
            whatsappPhone: prof.whatsapp_phone || '',
            reviewUrl: prof.review_url || '',
            directionsUrl: prof.directions_url || '',
            orderUrl: prof.order_url || '',
            newsletterUrl: prof.newsletter_url || '',
            onlineOrdering: !!prof.online_ordering,
            orderingNote: prof.ordering_note || '',
            lsEnabled: !!prof.ls_enabled,
            lsCheckoutUrl: prof.ls_checkout_url || '',
            lsStoreUrl: prof.ls_store_url || '',
            lsWebhookSecret: prof.ls_webhook_secret || '',
            stripeEnabled: !!prof.stripe_enabled,
            stripeCheckoutUrl: prof.stripe_checkout_url || '',
            stripeWebhookSecret: prof.stripe_webhook_secret || '',
          });
        } else {
          setForm({
            slug: slugify(store?.name || ''),
            displayName: store?.name || '',
            tagline: '', about: '', hours: '',
            contactEmail: '', contactPhone: '', accentColor: '',
            published: false, showPrices: true,
            onlineOrdering: false, orderingNote: '',
            lsEnabled: false, lsCheckoutUrl: '', lsStoreUrl: '', lsWebhookSecret: '',
            stripeEnabled: false, stripeCheckoutUrl: '', stripeWebhookSecret: '',
          });
        }
        setProducts(prods || []);
      } catch (e) {
        if (!cancelled) setError(e.message || t('storefront.loadFail'));
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId, stores]);

  const save = async () => {
    if (!storeId || lock.current) return;
    if (!form.slug.trim()) { setError(t('storefront.needSlug')); return; }
    const cleanSlug = slugify(form.slug);
    if (cleanSlug !== form.slug) setForm((f) => ({ ...f, slug: cleanSlug }));
    lock.current = true;
    setBusy(true); setError(''); setSaved(false);
    try {
      await backend.pos.saveStorefrontProfile(storeId, { ...form, slug: cleanSlug });
      setSaved(true);
    } catch (e) {
      setError(t('storefront.saveFail') + (e.message || ''));
    } finally {
      lock.current = false; setBusy(false);
    }
  };

  const toggleProduct = async (p) => {
    const next = !p.publicVisible;
    setProducts((prev) => prev.map((x) => (x.id === p.id ? { ...x, publicVisible: next } : x)));
    try {
      await backend.pos.setProductPublicVisible(storeId, p.id, next);
    } catch (e) {
      setError(t('storefront.saveFail') + (e.message || ''));
      setProducts((prev) => prev.map((x) => (x.id === p.id ? { ...x, publicVisible: !next } : x)));
    }
  };

  const addDomain = async () => {
    if (!storeId || domainBusy) return;
    setDomainErr(''); setDomainMsg('');
    const raw = newDomain.trim().toLowerCase().replace(/^https?:\/\//, '').split('/')[0];
    const apex = String(BRAND.apexDomain || '').trim().toLowerCase();
    if (apex && (raw === apex || raw.endsWith(`.${apex}`))) {
      setDomainErr(t('domains.isApex'));
      return;
    }
    setDomainBusy(true);
    try {
      const added = await backend.pos.addCustomDomain(storeId, newDomain);
      setDomains((prev) => [...prev.filter((d) => d.hostname !== added.hostname), added]);
      setNewDomain('');
      setDomainMsg(t('domains.connected'));
    } catch (e) {
      if (e.message === 'DOMAIN_INVALID') setDomainErr(t('domains.badDomain'));
      else if (e.message === 'DOMAIN_TAKEN') setDomainErr(t('domains.domainTaken'));
      else setDomainErr(e.message || t('domains.loadFail'));
    } finally {
      setDomainBusy(false);
    }
  };

  const verifyDomain = async (domain) => {
    if (!storeId || domainBusy) return;
    setDomainErr(''); setDomainMsg('');
    setDomainBusy(true);
    try {
      const ok = await backend.pos.confirmCustomDomain(storeId, domain);
      if (ok) {
        setDomains((prev) => prev.map((d) => (d.hostname === domain.hostname ? { ...d, verifiedAt: new Date().toISOString() } : d)));
        setDomainMsg(t('domains.nowWorking'));
      } else {
        setDomainErr(t('domains.verifyNotYet'));
      }
    } catch (e) {
      setDomainErr(t('domains.verifyNotYet'));
    } finally {
      setDomainBusy(false);
    }
  };

  const removeDomain = async (hostname) => {
    if (!storeId || domainBusy) return;
    setDomainErr(''); setDomainMsg('');
    setDomainBusy(true);
    try {
      await backend.pos.removeCustomDomain(storeId, hostname);
      setDomains((prev) => prev.filter((d) => d.hostname !== hostname));
      setDomainMsg(t('domains.removed'));
    } catch (e) {
      setDomainErr(e.message || t('domains.loadFail'));
    } finally {
      setDomainBusy(false);
    }
  };

  const field = (key) => ({
    value: form[key],
    onChange: (e) => { setForm((f) => ({ ...f, [key]: e.target.value })); setSaved(false); },
  });

  const inputCls = 'h-9 w-full rounded-os border border-osborder bg-surface px-2.5 text-sm outline-none';
  const labelCls = 'mb-1 block text-xs font-semibold text-muted';
  const publicLink = form.slug
    ? `${window.location.origin}${BRAND.appBasePath()}#/store/${form.slug}`
    : '';

  return (
    <div className="space-y-4">
      <section className="rounded-os border border-osborder bg-paper p-4">
        <h3 className="text-base font-semibold text-ink">{t('storefront.title')}</h3>
        <p className="mt-1 text-xs text-muted">{t('storefront.intro')}</p>
        {!!error && (
          <div className="mt-3 rounded-os border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">{error}</div>
        )}
        {loading ? (
          <p className="mt-3 text-sm text-muted">{t('common.loading')}</p>
        ) : stores.length === 0 ? (
          <div className="mt-3">
            <p className="text-sm text-ink">{t('storefront.noStores')}</p>
            <p className="mt-1 text-xs text-muted">{t('storefront.noStoresHint')}</p>
          </div>
        ) : (
          <div className="mt-4 space-y-4">
            {stores.length > 1 && (
              <div>
                <label className={labelCls}>{t('storefront.storeLabel')}</label>
                <select
                  value={storeId}
                  onChange={(e) => setStoreId(e.target.value)}
                  className={inputCls}
                >
                  {stores.map((s) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
              </div>
            )}

            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className={labelCls}>{t('storefront.displayName')}</label>
                <input {...field('displayName')} className={inputCls} />
              </div>
              <div>
                <label className={labelCls}>{t('storefront.tagline')}</label>
                <input {...field('tagline')} className={inputCls} />
              </div>
            </div>

            <div>
              <label className={labelCls}>{t('storefront.slug')}</label>
              <input
                {...field('slug')}
                onChange={(e) => { setForm((f) => ({ ...f, slug: slugifyTyping(e.target.value) })); setSaved(false); }}
                onBlur={(e) => { const v = slugify(e.target.value); if (v !== form.slug) setForm((f) => ({ ...f, slug: v })); }}
                className={inputCls}
                placeholder="my-shop"
              />
              <p className="mt-1 text-xs text-muted">{t('storefront.slugHint')}</p>
            </div>

            {!!publicLink && (
              <div>
                <label className={labelCls}>{t('storefront.publicLink')}</label>
                <div className="flex items-center gap-2">
                  <code className="min-w-0 flex-1 truncate rounded-os border border-osborder bg-surface px-2.5 py-2 text-xs text-ink">{publicLink}</code>
                  <a
                    href={publicLink}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-os border border-osborder bg-surface px-3 text-xs font-semibold text-ink"
                  >
                    <ExternalLink size={13} /> {t('storefront.openPage')}
                  </a>
                </div>
              </div>
            )}

            {/* Per-shop nice URLs (migration 074). The free address
                is automatic — it is just the shop's slug under the product
                domain (BRAND.apexDomain). The own-domain part registers
                names in custom_domains; nothing here touches the saved
                profile form above. */}
            <div className="border-t border-osborder pt-4">
              <h4 className="text-sm font-semibold text-ink">{t('domains.sectionTitle')}</h4>

              {!!BRAND.apexDomain && (
                <div className="mt-3">
                  <label className={labelCls}>{t('domains.autoTitle')}</label>
                  {form.slug ? (
                    <>
                      <div className="flex items-center gap-2">
                        <code className="min-w-0 flex-1 truncate rounded-os border border-osborder bg-surface px-2.5 py-2 text-xs text-ink">
                          {`https://${form.slug}.${BRAND.apexDomain}`}
                        </code>
                        <a
                          href={`https://${form.slug}.${BRAND.apexDomain}`}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-os border border-osborder bg-surface px-3 text-xs font-semibold text-ink"
                        >
                          <ExternalLink size={13} /> {t('storefront.openPage')}
                        </a>
                      </div>
                      <p className="mt-1 text-xs text-muted">{t('domains.autoText')}</p>
                    </>
                  ) : (
                    <p className="text-xs text-muted">{t('domains.autoNeedSlug')}</p>
                  )}
                </div>
              )}

              <div className="mt-4">
                <label className={labelCls}>{t('domains.ownTitle')}</label>
                <p className="text-xs text-muted">{t('domains.ownIntro')}</p>
                {!domainsReady && (
                  <p className="mt-2 rounded-os border border-osborder bg-surface px-3 py-2 text-xs text-muted">
                    {t('domains.notReady')}
                  </p>
                )}
                <div className="mt-2 space-y-1 text-xs text-muted">
                  <p className="font-semibold text-ink">{t('domains.stepsTitle')}</p>
                  <p>{t('domains.step1')}</p>
                  <p>{BRAND.hostCnameTarget ? t('domains.step2', { target: BRAND.hostCnameTarget }) : t('domains.step2NoTarget')}</p>
                  <p>{t('domains.step3')}</p>
                </div>

                {!!domainErr && (
                  <div className="mt-3 rounded-os border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">{domainErr}</div>
                )}
                {!!domainMsg && (
                  <p className="mt-3 text-xs font-semibold text-emerald-700">{domainMsg}</p>
                )}

                <div className="mt-3 flex items-center gap-2">
                  <input
                    value={newDomain}
                    onChange={(e) => { setNewDomain(e.target.value); setDomainMsg(''); }}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addDomain(); } }}
                    disabled={!domainsReady || domainBusy}
                    placeholder={t('domains.domainPh')}
                    className={inputCls}
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                  />
                  <button
                    type="button"
                    onClick={addDomain}
                    disabled={!domainsReady || domainBusy || !newDomain.trim()}
                    className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-os bg-accent px-3 text-xs font-semibold text-white disabled:opacity-50"
                  >
                    <Globe size={13} /> {t('domains.connect')}
                  </button>
                </div>

                {domains.length === 0 ? (
                  <p className="mt-3 text-xs text-muted">{t('domains.noneYet')}</p>
                ) : (
                  <ul className="mt-3 divide-y divide-osborder/60">
                    {domains.map((d) => (
                      <li key={d.hostname} className="py-2">
                        <div className="flex items-center gap-3">
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm text-ink">{d.hostname}</span>
                            <span className={`text-xs font-semibold ${d.verifiedAt ? 'text-emerald-700' : 'text-muted'}`}>
                              {d.verifiedAt ? t('domains.working') : t('domains.waiting')}
                            </span>
                          </span>
                          {!d.verifiedAt && (
                            <button
                              type="button"
                              onClick={() => verifyDomain(d)}
                              disabled={domainBusy}
                              className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-os bg-accent px-2.5 text-xs font-semibold text-white disabled:opacity-50"
                            >
                              {t('domains.checkNow')}
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => removeDomain(d.hostname)}
                            disabled={domainBusy}
                            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-os border border-osborder bg-surface px-2.5 text-xs font-semibold text-ink disabled:opacity-50"
                          >
                            <Trash2 size={12} /> {t('domains.remove')}
                          </button>
                        </div>
                        {!d.verifiedAt && !!d.txtValue && (
                          <div className="mt-2 rounded-os border border-osborder bg-surface px-3 py-2">
                            <p className="text-xs text-muted">{t('domains.verifyIntro')}</p>
                            <p className="mt-2 text-xs text-muted">{t('domains.verifyName')}</p>
                            <code className="block break-all rounded-os bg-paper px-2 py-1 text-xs text-ink">{d.txtName}</code>
                            <p className="mt-2 text-xs text-muted">{t('domains.verifyValue')}</p>
                            <code className="block break-all rounded-os bg-paper px-2 py-1 text-xs text-ink">{d.txtValue}</code>
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>

            <div>
              <label className={labelCls}>{t('storefront.about')}</label>
              <textarea {...field('about')} rows={3} className="w-full rounded-os border border-osborder bg-surface px-2.5 py-2 text-sm outline-none" />
            </div>

            <div>
              <label className={labelCls}>{t('storefront.hours')}</label>
              <textarea
                {...field('hours')}
                rows={2}
                placeholder={t('storefront.hoursPlaceholder')}
                className="w-full rounded-os border border-osborder bg-surface px-2.5 py-2 text-sm outline-none"
              />
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className={labelCls}>{t('storefront.contactEmail')}</label>
                <input {...field('contactEmail')} type="email" className={inputCls} />
              </div>
              <div>
                <label className={labelCls}>{t('storefront.contactPhone')}</label>
                <input {...field('contactPhone')} type="tel" className={inputCls} />
              </div>
            </div>

            <div>
              <label className={labelCls}>{t('storefront.accentColor')}</label>
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  aria-label={t('storefront.accentColor')}
                  value={/^#[0-9a-fA-F]{6}$/.test(form.accentColor) ? form.accentColor : '#b4542a'}
                  onChange={(e) => { setForm((f) => ({ ...f, accentColor: e.target.value })); setSaved(false); }}
                  className="h-9 w-12 cursor-pointer rounded-os border border-osborder bg-surface p-1"
                />
                <input {...field('accentColor')} placeholder="#b4542a" className="h-9 w-32 rounded-os border border-osborder bg-surface px-2.5 text-sm outline-none" />
              </div>
            </div>

            {/* Web-service links (migration 071, draft): the owner pastes
                links they already have; the public page shows buttons.
                Fields are disabled until the columns exist so nothing
                typed here is silently lost on an un-updated database. */}
            <div className="border-t border-osborder pt-4">
              <h4 className="text-sm font-semibold text-ink">{t('integrations.linksTitle')}</h4>
              <p className="mt-1 text-xs text-muted">{t('integrations.linksIntro')}</p>
              {!linksReady && (
                <p className="mt-2 rounded-os border border-osborder bg-surface px-3 py-2 text-xs text-muted">
                  {t('integrations.notReady')}
                </p>
              )}
              <div className="mt-3 space-y-3">
                <div>
                  <label className={labelCls}>{t('integrations.address')}</label>
                  <input {...field('address')} disabled={!linksReady} placeholder={t('integrations.addressPh')} className={inputCls} />
                  <p className="mt-1 text-xs text-muted">{t('integrations.addressHelp')}</p>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <label className={labelCls}>{t('integrations.order')}</label>
                    <input {...field('orderUrl')} disabled={!linksReady} placeholder="https://…" className={inputCls} />
                    <p className="mt-1 text-xs text-muted">{t('integrations.orderHelp')}</p>
                  </div>
                  <div>
                    <label className={labelCls}>{t('integrations.whatsapp')}</label>
                    <input {...field('whatsappPhone')} disabled={!linksReady} placeholder="1 819 555 1234" className={inputCls} />
                    <p className="mt-1 text-xs text-muted">{t('integrations.whatsappHelp')}</p>
                  </div>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <label className={labelCls}>{t('integrations.facebook')}</label>
                    <input {...field('facebookUrl')} disabled={!linksReady} placeholder="https://…" className={inputCls} />
                    <p className="mt-1 text-xs text-muted">{t('integrations.facebookHelp')}</p>
                  </div>
                  <div>
                    <label className={labelCls}>{t('integrations.instagram')}</label>
                    <input {...field('instagramUrl')} disabled={!linksReady} placeholder="https://…" className={inputCls} />
                    <p className="mt-1 text-xs text-muted">{t('integrations.instagramHelp')}</p>
                  </div>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <label className={labelCls}>{t('integrations.tiktok')}</label>
                    <input {...field('tiktokUrl')} disabled={!linksReady} placeholder="https://…" className={inputCls} />
                    <p className="mt-1 text-xs text-muted">{t('integrations.tiktokHelp')}</p>
                  </div>
                  <div>
                    <label className={labelCls}>{t('integrations.review')}</label>
                    <input {...field('reviewUrl')} disabled={!linksReady} placeholder="https://…" className={inputCls} />
                    <p className="mt-1 text-xs text-muted">{t('integrations.reviewHelp')}</p>
                  </div>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <label className={labelCls}>{t('integrations.newsletter')}</label>
                    <input {...field('newsletterUrl')} disabled={!linksReady} placeholder="https://…" className={inputCls} />
                    <p className="mt-1 text-xs text-muted">{t('integrations.newsletterHelp')}</p>
                  </div>
                  <div>
                    <label className={labelCls}>{t('integrations.directions')}</label>
                    <input {...field('directionsUrl')} disabled={!linksReady} placeholder="https://…" className={inputCls} />
                    <p className="mt-1 text-xs text-muted">{t('integrations.directionsHelp')}</p>
                  </div>
                </div>
              </div>
            </div>

            {/* Online ordering (migration 071): the owner opt-in that
                lets customers sign in on the public page and send orders
                into the till's Online-orders inbox. The toggle and note are
                disabled until the migration is applied so nothing typed
                here is silently lost on an un-updated database. */}
            <div className="border-t border-osborder pt-4">
              <h4 className="text-sm font-semibold text-ink">{t('onlineOrders.settingsTitle')}</h4>
              <p className="mt-1 text-xs text-muted">{t('onlineOrders.settingsIntro')}</p>
              {!ordersReady && (
                <p className="mt-2 rounded-os border border-osborder bg-surface px-3 py-2 text-xs text-muted">
                  {t('integrations.notReady')}
                </p>
              )}
              <label className="mt-2 flex cursor-pointer items-start gap-2 text-sm text-ink">
                <input
                  type="checkbox"
                  checked={!!form.onlineOrdering}
                  disabled={!ordersReady}
                  onChange={(e) => { setForm((f) => ({ ...f, onlineOrdering: e.target.checked })); setSaved(false); }}
                  className="mt-0.5 h-4 w-4 accent-[#b4542a]"
                />
                <span>
                  {t('onlineOrders.settingsOn')}
                  <span className="block text-xs font-normal text-muted">{t('onlineOrders.settingsOnHint')}</span>
                </span>
              </label>
              <div className="mt-2">
                <label className={labelCls}>{t('onlineOrders.settingsNote')}</label>
                <input
                  {...field('orderingNote')}
                  disabled={!ordersReady}
                  placeholder={t('onlineOrders.settingsNotePh')}
                  maxLength={200}
                  className={inputCls}
                />
                <p className="mt-1 text-xs text-muted">{t('onlineOrders.settingsNoteHelp')}</p>
              </div>
              {/* Lemon Squeezy online payments (optional) */}
              <div className="mt-4 rounded-os border border-osborder bg-surface p-3">
                <label className="flex cursor-pointer items-start gap-2 text-sm text-ink">
                  <input
                    type="checkbox"
                    checked={!!form.lsEnabled}
                    disabled={!ordersReady}
                    onChange={(e) => { setForm((f) => ({ ...f, lsEnabled: e.target.checked })); setSaved(false); }}
                    className="mt-0.5 h-4 w-4 accent-[#b4542a]"
                  />
                  <span>
                    <span className="font-medium">Accept online payments via Lemon Squeezy</span>
                    <span className="block text-xs font-normal text-muted">
                      Optional. Connect your own Lemon Squeezy store so customers can pay online.
                      Leave off to stay pay-at-pickup.
                    </span>
                  </span>
                </label>
                {form.lsEnabled && (
                  <div className="mt-3 space-y-3">
                    <div>
                      <label className={labelCls}>Lemon Squeezy checkout URL</label>
                      <input
                        {...field('lsCheckoutUrl')}
                        disabled={!ordersReady}
                        placeholder="https://your-store.lemonsqueezy.com/checkout/..."
                        maxLength={500}
                        className={inputCls}
                      />
                      <p className="mt-1 text-xs text-muted">
                        Paste your Lemon Squeezy checkout or payment link. Customers will be sent here after placing an order.
                      </p>
                    </div>
                    <div>
                      <label className={labelCls}>Lemon Squeezy store URL (optional)</label>
                      <input
                        {...field('lsStoreUrl')}
                        disabled={!ordersReady}
                        placeholder="https://your-store.lemonsqueezy.com"
                        maxLength={500}
                        className={inputCls}
                      />
                    </div>
                    <div>
                      <label className={labelCls}>Lemon Squeezy webhook secret</label>
                      <input
                        {...field('lsWebhookSecret')}
                        disabled={!ordersReady}
                        type="password"
                        placeholder="whsec_..."
                        maxLength={500}
                        className={inputCls}
                        autoComplete="off"
                      />
                      <p className="mt-1 text-xs text-muted">
                        From Lemon Squeezy → Settings → Webhooks → your webhook → Signing secret.
                        Required for automatic payment confirmation. Vendra verifies every webhook
                        signature with this secret.
                      </p>
                      <p className="mt-2 text-xs text-muted">
                        <span className="font-medium">Webhook URL to use in Lemon Squeezy:</span><br />
                        <code className="break-all rounded bg-muted/20 px-1 py-0.5 text-[11px]">https://mkbozzeucotbxilkpapd.supabase.co/functions/v1/ls-webhook</code>
                      </p>
                    </div>
                  </div>
                )}
              </div>
              {/* Stripe online payments (optional) */}
              <div className="mt-4 rounded-os border border-osborder bg-surface p-3">
                <label className="flex cursor-pointer items-start gap-2 text-sm text-ink">
                  <input
                    type="checkbox"
                    checked={!!form.stripeEnabled}
                    disabled={!ordersReady}
                    onChange={(e) => { setForm((f) => ({ ...f, stripeEnabled: e.target.checked })); setSaved(false); }}
                    className="mt-0.5 h-4 w-4 accent-[#b4542a]"
                  />
                  <span>
                    <span className="font-medium">Accept online payments via Stripe</span>
                    <span className="block text-xs font-normal text-muted">
                      Optional. Connect your own Stripe payment link so customers can pay online.
                      Lower fees than Lemon Squeezy, but you handle tax compliance yourself.
                    </span>
                  </span>
                </label>
                {form.stripeEnabled && (
                  <div className="mt-3">
                    <label className={labelCls}>Stripe payment link</label>
                    <input
                      {...field('stripeCheckoutUrl')}
                      disabled={!ordersReady}
                      placeholder="https://buy.stripe.com/..."
                      maxLength={500}
                      className={inputCls}
                    />
                    <p className="mt-1 text-xs text-muted">
                      Paste your Stripe payment link. Customers will be sent here after placing an order.
                    </p>
                    <div className="mt-3">
                      <label className={labelCls}>Stripe webhook secret</label>
                      <input
                        {...field('stripeWebhookSecret')}
                        disabled={!ordersReady}
                        type="password"
                        placeholder="whsec_..."
                        maxLength={500}
                        className={inputCls}
                        autoComplete="off"
                      />
                      <p className="mt-1 text-xs text-muted">
                        From Stripe → Developers → Webhooks → your endpoint → Signing secret.
                        Required for automatic payment confirmation. Vendra verifies every webhook
                        signature with this secret.
                      </p>
                      <p className="mt-2 text-xs text-muted">
                        <span className="font-medium">Webhook URL to use in Stripe:</span><br />
                        <code className="break-all rounded bg-muted/20 px-1 py-0.5 text-[11px]">https://mkbozzeucotbxilkpapd.supabase.co/functions/v1/stripe-webhook</code>
                      </p>
                    </div>
                  </div>
                )}
              </div>
            </div>

            <div className="space-y-2">
              <label className="flex cursor-pointer items-start gap-2 text-sm text-ink">
                <input
                  type="checkbox"
                  checked={form.published}
                  onChange={(e) => { setForm((f) => ({ ...f, published: e.target.checked })); setSaved(false); }}
                  className="mt-0.5 h-4 w-4 accent-[#b4542a]"
                />
                <span>
                  {t('storefront.published')}
                  <span className="block text-xs font-normal text-muted">{t('storefront.publishedHint')}</span>
                </span>
              </label>
              <label className="flex cursor-pointer items-center gap-2 text-sm text-ink">
                <input
                  type="checkbox"
                  checked={form.showPrices}
                  onChange={(e) => { setForm((f) => ({ ...f, showPrices: e.target.checked })); setSaved(false); }}
                  className="h-4 w-4 accent-[#b4542a]"
                />
                {t('storefront.showPrices')}
              </label>
            </div>

            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={save}
                disabled={busy}
                className="h-9 rounded-os bg-accent px-4 text-sm font-semibold text-white disabled:opacity-50"
              >
                {busy ? t('common.loading') : t('storefront.save')}
              </button>
              {saved && <span className="text-xs font-semibold text-emerald-700">{t('storefront.saved')}</span>}
            </div>
          </div>
        )}
      </section>

      {stores.length > 0 && storeId && (
        <section className="rounded-os border border-osborder bg-paper p-4">
          <h3 className="text-sm font-semibold text-ink">{t('storefront.products')}</h3>
          <p className="mt-1 text-xs text-muted">{t('storefront.productsHint')}</p>
          {products.length === 0 ? (
            <p className="mt-3 text-sm text-muted">{t('storefront.noProducts')}</p>
          ) : (
            <ul className="mt-3 divide-y divide-osborder/60">
              {products.map((p) => (
                <li key={p.id} className="flex items-center gap-3 py-2">
                  <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5">
                    <input
                      type="checkbox"
                      checked={!!p.publicVisible}
                      onChange={() => toggleProduct(p)}
                      className="h-4 w-4 shrink-0 accent-[#b4542a]"
                    />
                    <span className="min-w-0">
                      <span className="block truncate text-sm text-ink">{p.name}</span>
                      <span className="block text-xs text-muted">
                        ${(Number(p.priceCents || 0) / 100).toFixed(2)} · {p.publicVisible ? t('storefront.visible') : t('storefront.hidden')}
                      </span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Business type: the universal-setup chooser. One build serves every  */
/* shop; the owner picks the closest business type and the preset      */
/* applies a bundle of EXISTING settings (desktop/Start layout, touch  */
/* mode, one device-local receipt suggestion) and records the choice   */
/* on the store row (pos_stores.business_preset, migration 067). */
/* Only owner/manager stores are listed; the database enforces the     */
/* same roles on update (pos_stores_manager_update). Presets never     */
/* touch products, prices, taxes or sales. See src/lib/businessPresets */
/* ------------------------------------------------------------------ */
const PRESET_ICONS = {
  general: LayoutGrid,
  retail: ShoppingBag,
  restaurant: UtensilsCrossed,
  services: CalendarDays,
  convenience: Fuel,
};

function BusinessSection() {
  const { t } = useLang();
  const { updateSettings } = useSettings();
  const [stores, setStores] = useState([]);
  const [storeId, setStoreId] = useState('');
  const [supported, setSupported] = useState(true);
  const [choice, setChoice] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  const lock = useRef(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const [list, caps] = await Promise.all([
          backend.pos.listStores(),
          backend.pos.capabilities().catch(() => null),
        ]);
        if (cancelled) return;
        // Shops that never picked a type come first — that's the setup queue.
        const mine = (list || [])
          .filter((s) => s.role === 'owner' || s.role === 'manager')
          .sort((a, b) => Number(isBusinessPreset(a.businessPreset)) - Number(isBusinessPreset(b.businessPreset)));
        setStores(mine);
        setStoreId((cur) => (mine.some((s) => s.id === cur) ? cur : mine[0]?.id || ''));
        setSupported(!caps || caps.businessPreset !== false);
      } catch (e) {
        if (!cancelled) setError(e.message || t('presets.loadFail'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const store = stores.find((s) => s.id === storeId) || null;
  const recorded = store && isBusinessPreset(store.businessPreset) ? store.businessPreset : null;

  useEffect(() => {
    // Pre-pick the shop's recorded type, or the safe "a bit of
    // everything" default — a first-timer can simply press the button.
    setChoice(recorded || 'general');
    setSaved('');
    setError('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId]);

  const apply = async () => {
    if (!storeId || !isBusinessPreset(choice) || lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    setSaved('');
    try {
      if (supported) {
        await backend.pos.updateStore(storeId, { businessPreset: choice });
        setStores((prev) => prev.map((s) => (s.id === storeId ? { ...s, businessPreset: choice } : s)));
      }
      await updateSettings(presetSettingsPatch(choice));
      if (BUSINESS_PRESETS[choice].suggestAutoPrint) {
        // Device-local receipt suggestion for this store's printer on
        // THIS machine only — hardware config never leaves the device.
        try { savePrinterConfig(storeId, { autoPrint: true }); } catch { /* storage unavailable */ }
      }
      setSaved(supported ? t('presets.applied') : t('presets.appliedNoRecord'));
    } catch (e) {
      setError(t('presets.saveFail') + (e.message || ''));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };

  const inputCls = 'h-9 w-full rounded-os border border-osborder bg-surface px-2.5 text-sm outline-none';
  const labelCls = 'mb-1 block text-xs font-semibold text-muted';

  return (
    <div className="space-y-4">
      <section className="rounded-os border border-osborder bg-paper p-4">
        <h3 className="text-base font-semibold text-ink">{t('presets.title')}</h3>
        <p className="mt-1 text-xs text-muted">{t('presets.intro')}</p>
        {!!error && (
          <div className="mt-3 rounded-os border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">{error}</div>
        )}
        {loading ? (
          <p className="mt-3 text-sm text-muted">{t('common.loading')}</p>
        ) : stores.length === 0 ? (
          <div className="mt-3">
            <p className="text-sm text-ink">{t('presets.noStores')}</p>
            <p className="mt-1 text-xs text-muted">{t('presets.noStoresHint')}</p>
          </div>
        ) : (
          <div className="mt-4 space-y-4">
            {stores.length > 1 && (
              <div>
                <label className={labelCls}>{t('presets.storeLabel')}</label>
                <select value={storeId} onChange={(e) => setStoreId(e.target.value)} className={inputCls}>
                  {stores.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}{isBusinessPreset(s.businessPreset) ? '' : ` — ${t('presets.notChosen')}`}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {store && !recorded && (
              <div className="rounded-os border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700">
                {t('presets.notChosenHint')}
              </div>
            )}
            {!supported && (
              <div className="rounded-os border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700">
                {t('presets.needDbUpdate')}
              </div>
            )}

            <div className="grid gap-3 sm:grid-cols-2">
              {BUSINESS_PRESET_IDS.map((id) => {
                const Icon = PRESET_ICONS[id];
                const selected = choice === id;
                return (
                  <button
                    key={id}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => { setChoice(id); setSaved(''); }}
                    className={`rounded-os border p-3.5 text-left duration-160 ${
                      selected
                        ? 'border-accent bg-accent/10 ring-1 ring-accent'
                        : 'border-osborder bg-surface hover:border-accent/50'
                    }`}
                  >
                    <span className="flex items-center gap-2">
                      <Icon size={17} className="shrink-0 text-accent" />
                      <span className="text-sm font-semibold text-ink">{t(`presets.${id}Name`)}</span>
                      {recorded === id && (
                        <span className="ml-auto shrink-0 rounded-full bg-accent/15 px-2 py-0.5 text-[10px] font-semibold text-accent">
                          {t('presets.current')}
                        </span>
                      )}
                    </span>
                    <span className="mt-1.5 block text-xs leading-relaxed text-muted">{t(`presets.${id}Desc`)}</span>
                  </button>
                );
              })}
            </div>

            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={apply}
                disabled={busy || !isBusinessPreset(choice)}
                className="h-9 rounded-os bg-accent px-4 text-sm font-semibold text-white disabled:opacity-50"
              >
                {busy ? t('common.loading') : t('presets.apply')}
              </button>
              {saved && <span className="text-xs font-semibold text-emerald-700">{saved}</span>}
            </div>

            <p className="text-xs leading-relaxed text-muted">{t('presets.note')}</p>
          </div>
        )}
      </section>
    </div>
  );
}

/**
 * PLATFORM MASTER ONLY — unlock-key generator (licensing 072).
 * Jesse makes keys here after arranging a sale (support inbox, platform
 * scope), then hands one key to the shop owner. Raw keys exist ONLY in
 * the list right after generation: the database keeps a SHA-256 hash,
 * so a lost key can never be shown again — make a new one instead.
 */
function KeysSection() {
  const { t } = useLang();
  const [count, setCount] = useState(5);
  const [plan, setPlan] = useState('lifetime');
  const [months, setMonths] = useState(12);
  const [generating, setGenerating] = useState(false);
  const [freshKeys, setFreshKeys] = useState([]);
  const [copied, setCopied] = useState('');
  const [keys, setKeys] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [confirmRevoke, setConfirmRevoke] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await backend.license.listKeys();
      setKeys(Array.isArray(rows) ? rows : []);
      setError('');
    } catch (e) {
      setError(t('licensing.keysLoadError'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => { load(); }, [load]);

  const generate = async () => {
    const n = Math.max(1, Math.min(100, Math.floor(Number(count) || 0)));
    if (!n) return;
    setGenerating(true);
    setError('');
    try {
      const rows = await backend.license.generateKeys(n, plan, plan === 'term' ? Number(months) : null);
      setFreshKeys((Array.isArray(rows) ? rows : []).map((r) => r.raw_key).filter(Boolean));
      await load();
    } catch (e) {
      setError(t('licensing.keysLoadError'));
    } finally {
      setGenerating(false);
    }
  };

  const copyText = async (text, marker) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(marker);
      setTimeout(() => setCopied(''), 2000);
    } catch { /* clipboard unavailable: user can select the text manually */ }
  };

  const revoke = async (id) => {
    try {
      await backend.license.revokeKey(id);
      setConfirmRevoke(null);
      await load();
    } catch (e) {
      setError(t('licensing.keysLoadError'));
    }
  };

  const statusOf = (k) =>
    k.revoked_at
      ? t('licensing.keysStatusRevoked')
      : k.redeemed_at
        ? t('licensing.keysStatusUsed')
        : t('licensing.keysStatusReady');

  return (
    <div className="flex-1 overflow-y-auto p-4">
      <div className="mx-auto max-w-2xl space-y-4">
        <div className="rounded-os border border-osborder bg-paper p-4">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-ink">
            <KeyRound size={15} className="text-accent" /> {t('licensing.keysTitle')}
          </h3>
          <p className="mt-1 text-sm leading-relaxed text-muted">{t('licensing.keysIntro')}</p>

          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-muted">{t('licensing.keysCount')}</span>
              <input
                type="number"
                min={1}
                max={100}
                value={count}
                onChange={(e) => setCount(e.target.value)}
                className="w-full rounded-os border border-osborder bg-surface px-3 py-2 text-sm text-ink outline-none focus:border-accent"
              />
            </label>
            <label className="block sm:col-span-2">
              <span className="mb-1 block text-xs font-medium text-muted">{t('licensing.keysPlan')}</span>
              <select
                value={plan}
                onChange={(e) => setPlan(e.target.value)}
                className="w-full rounded-os border border-osborder bg-surface px-3 py-2 text-sm text-ink outline-none focus:border-accent"
              >
                <option value="lifetime">{t('licensing.keysPlanLifetime')}</option>
                <option value="term">{t('licensing.keysPlanTerm')}</option>
              </select>
            </label>
          </div>
          {plan === 'term' && (
            <label className="mt-3 block max-w-[12rem]">
              <span className="mb-1 block text-xs font-medium text-muted">{t('licensing.keysMonths')}</span>
              <input
                type="number"
                min={1}
                max={120}
                value={months}
                onChange={(e) => setMonths(e.target.value)}
                className="w-full rounded-os border border-osborder bg-surface px-3 py-2 text-sm text-ink outline-none focus:border-accent"
              />
            </label>
          )}
          <button
            type="button"
            onClick={generate}
            disabled={generating}
            className="mt-3 flex items-center gap-2 rounded-os bg-accent px-4 py-2 text-sm font-semibold text-accentink duration-160 hover:opacity-90 disabled:opacity-50"
          >
            <KeyRound size={14} />
            {generating ? t('licensing.keysGenerating') : t('licensing.keysGenerate')}
          </button>
          {error && <p className="mt-2 text-sm text-red-700">{error}</p>}
        </div>

        {freshKeys.length > 0 && (
          <div className="rounded-os border-2 border-accent bg-paper p-4">
            <h4 className="text-sm font-semibold text-ink">{t('licensing.keysMadeTitle')}</h4>
            <p className="mt-1 text-sm leading-relaxed text-red-700">{t('licensing.keysMadeWarning')}</p>
            <ul className="mt-3 space-y-1.5">
              {freshKeys.map((k) => (
                <li key={k} className="flex items-center gap-2">
                  <code className="min-w-0 flex-1 truncate rounded-os bg-surface px-3 py-2 text-sm font-bold tracking-widest text-ink">
                    {k}
                  </code>
                  <button
                    type="button"
                    onClick={() => copyText(k, k)}
                    className="shrink-0 rounded-os border border-osborder bg-surface px-3 py-2 text-xs font-medium text-ink duration-160 hover:border-accent"
                  >
                    {copied === k ? t('licensing.keysCopied') : t('licensing.keysCopy')}
                  </button>
                </li>
              ))}
            </ul>
            <button
              type="button"
              onClick={() => copyText(freshKeys.join('\n'), '__all__')}
              className="mt-3 rounded-os border border-osborder bg-surface px-3 py-2 text-xs font-medium text-ink duration-160 hover:border-accent"
            >
              {copied === '__all__' ? t('licensing.keysCopied') : t('licensing.keysCopyAll')}
            </button>
          </div>
        )}

        <div className="rounded-os border border-osborder bg-paper p-4">
          <h4 className="text-sm font-semibold text-ink">{t('licensing.keysListTitle')}</h4>
          {loading ? (
            <p className="mt-2 text-sm text-muted">{t('common.loading')}</p>
          ) : keys.length === 0 ? (
            <p className="mt-2 text-sm text-muted">{t('licensing.keysEmpty')}</p>
          ) : (
            <ul className="mt-3 space-y-2">
              {keys.map((k) => (
                <li key={k.id} className="flex flex-wrap items-center gap-2 rounded-os border border-osborder bg-surface px-3 py-2.5">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-ink">
                      {t('licensing.keysEndsWith', { hint: k.key_hint })}
                    </span>
                    <span className="block text-[11px] text-muted">
                      {k.plan === 'term'
                        ? t('licensing.keysTermShort', { months: k.term_months })
                        : t('licensing.keysLifetimeShort')}
                      {' · '}
                      {fmtDate(k.created_at)}
                      {k.redeemed_store_name ? ` · ${k.redeemed_store_name}` : ''}
                    </span>
                  </span>
                  <span className="shrink-0 rounded-full bg-paper px-2 py-0.5 text-[11px] font-medium text-muted ring-1 ring-osborder">
                    {statusOf(k)}
                  </span>
                  {!k.revoked_at &&
                    (confirmRevoke === k.id ? (
                      <span className="flex shrink-0 items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => revoke(k.id)}
                          className="rounded-os bg-red-600 px-2.5 py-1 text-[11px] font-semibold text-white duration-160 hover:opacity-90"
                        >
                          {t('licensing.keysRevoke')}
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmRevoke(null)}
                          className="rounded-os border border-osborder bg-paper px-2.5 py-1 text-[11px] font-medium text-ink duration-160 hover:border-accent"
                        >
                          {t('common.cancel')}
                        </button>
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setConfirmRevoke(k.id)}
                        title={t('licensing.keysRevokeConfirm')}
                        className="shrink-0 rounded-os border border-osborder bg-paper px-2.5 py-1 text-[11px] font-medium text-muted duration-160 hover:border-accent hover:text-ink"
                      >
                        {t('licensing.keysRevoke')}
                      </button>
                    ))}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

export default function AdminPanel() {
  const { user } = useAuth();
  const { t } = useLang();
  const cloud =
    typeof backend.auth?.adminListProfiles === 'function' &&
    typeof backend.support?.adminListTickets === 'function';
  const [role, setRole] = useState(null);
  const [isMaster, setIsMaster] = useState(false);
  const [ownsStore, setOwnsStore] = useState(false);
  const [section, setSection] = useState('accounts');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!cloud) {
      setLoading(false);
      return;
    }
    (async () => {
      try {
        const me = await backend.auth.getAccessProfile();
        setRole(me.role);
        setIsMaster(!!me.is_master);
      } catch {
        setRole(null);
        setIsMaster(false);
      } finally {
        setLoading(false);
      }
      // Store owners/managers get the Storefront tab even without admin
      // rights (the existing per-store role check, migration 002 roles).
      try {
        const mine = (await backend.pos.listStores()) || [];
        setOwnsStore(mine.some((s) => s.role === 'owner' || s.role === 'manager'));
      } catch { /* panel still works without it */ }
    })();
  }, [cloud]);

  if (!cloud) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
        <Cloud size={28} className="text-muted" />
        <p className="text-sm font-medium text-ink">{t('adminUsers.adminUnavailable')}</p>
        <p className="max-w-xs text-xs text-muted">{t('adminUsers.adminUnavailableHint')}</p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-sm text-muted">
        {t('common.loading')}
      </div>
    );
  }

  const admin = role === 'admin';
  const canStorefront = admin || ownsStore;
  if (!admin && !canStorefront) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
        <ShieldAlert size={28} className="text-accent" />
        <p className="text-sm font-medium text-ink">{t('adminUsers.adminOnly')}</p>
        <p className="max-w-xs text-xs text-muted">{t('adminUsers.adminOnlyHint')}</p>
      </div>
    );
  }

  const tabs = [
    ...(cloud ? [
      ...(admin ? [
        { id: 'accounts', label: t('adminUsers.tabAccounts'), icon: ShieldCheck },
        { id: 'shops', label: t('adminUsers.tabShops'), icon: Users },
        { id: 'tickets', label: t('adminUsers.tabSupport'), icon: MessageCircleQuestion },
        { id: 'feedback', label: t('adminUsers.tabFeedback'), icon: Star },
        // Factory reset is master-only: the tab renders solely for the
        // seeded master account (the RPC re-verifies server-side).
        ...(isMaster ? [{ id: 'danger', label: t('adminUsers.dangerTab'), icon: ShieldAlert }] : []),
        // Unlock keys (072): same master-only gate; generate/revoke
        // RPCs re-verify is_master() server-side too.
        ...(isMaster ? [{ id: 'keys', label: t('licensing.keysTab'), icon: KeyRound }] : []),
      ] : []),
      ...(canStorefront ? [{ id: 'storefront', label: t('storefront.tab'), icon: Globe }] : []),
      ...(canStorefront ? [{ id: 'business', label: t('presets.tab'), icon: Store }] : []),
    ] : []),
  ];
  const cur = tabs.some((x) => x.id === section) ? section : (tabs[0]?.id || 'accounts');

  return (
    <div className="flex h-full flex-col bg-surface text-ink">
      {/* L9: horizontal scroll on narrow windows so tabs don't clip */}
      <div className="flex items-center gap-2 overflow-x-auto border-b border-osborder px-4 pt-3">
        <span className="shrink-0 text-accent"><ShieldCheck size={20} /></span>
        <h2 className="mr-2 shrink-0 text-sm font-semibold">{t('adminAccounts.admin')}</h2>
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setSection(t.id)}
            className={`flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-xs font-medium duration-160 ${
              cur === t.id
                ? 'border-accent text-ink'
                : 'border-transparent text-muted hover:text-ink'
            }`}
          >
            <t.icon size={14} />
            {t.label}
          </button>
        ))}
      </div>

      {cur === 'accounts' && admin && <AccountsSection user={user} />}
      {cur === 'shops' && admin && <ShopsSection />}
      {cur === 'tickets' && admin && <TicketsSection />}
      {cur === 'feedback' && admin && <FeedbackSection />}
      {cur === 'danger' && isMaster && <DangerSection />}
      {cur === 'keys' && isMaster && <KeysSection />}
      {cur === 'storefront' && canStorefront && <StorefrontSection />}
      {cur === 'business' && canStorefront && <BusinessSection />}
    </div>
  );
}
