import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ShieldCheck, RefreshCw, Lock, LockOpen, BadgeDollarSign,
  Search, ShieldAlert, Cloud, MessageCircleQuestion, Star, Send,
  Users, UserPlus, KeyRound, Trash2, X, Check, Pencil, Plus, CheckCircle2,
  Store,
} from 'lucide-react';
import { backend } from '../lib/backend/current.js';
import { useAuth } from '../os/AuthContext.jsx';
import { localeTag, useLang } from '../lib/i18n.jsx';

const FIVE_MIN_MS = 5 * 60 * 1000;

function fmtLeft(iso) {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return 'expired';
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return m > 0 ? `${m}m ${s}s left` : `${s}s left`;
}

function fmtDate(iso) {
  return new Date(iso).toLocaleString(localeTag(), {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

function statusOf(p) {
  if (p.role === 'admin') return { label: 'Admin · unlimited', tone: 'admin' };
  if (p.is_locked) return { label: 'Locked', tone: 'bad' };
  if (p.disabled_until && new Date(p.disabled_until).getTime() > Date.now()) {
    return { label: `Disabled · ${fmtLeft(p.disabled_until)}`, tone: 'warn' };
  }
  if (p.is_guest) {
    if (p.trial_ends_at && new Date(p.trial_ends_at).getTime() > Date.now()) {
      return { label: `Trial · ${fmtLeft(p.trial_ends_at)}`, tone: 'trial' };
    }
    return { label: 'Trial expired', tone: 'muted' };
  }
  if (p.is_paid) return { label: 'Paid', tone: 'good' };
  return { label: 'Unpaid', tone: 'muted' };
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

  const localeTag = () => (lang === 'fr' ? 'fr-CA' : 'en-CA');

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

  const save = useCallback(async (t, patch, label) => {
    setError('');
    setSaving(t.id);
    try {
      await backend.support.adminUpdateTicket(t.id, patch);
      const rows = await backend.support.adminListTickets();
      setTickets(Array.isArray(rows) ? rows : []);
    } catch (e) {
      setError(t('adminAccounts.errTicketAction', { label, msg: e.message || e }));
    } finally {
      setSaving(null);
    }
  }, []);

  const visible = filter === 'all' ? tickets : (Array.isArray(tickets) ? tickets : []).filter((t) => t.status !== 'resolved');
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
export default function AdminPanel() {
  const { user } = useAuth();
  const { t } = useLang();
  const cloud =
    typeof backend.auth?.adminListProfiles === 'function' &&
    typeof backend.support?.adminListTickets === 'function';
  const [role, setRole] = useState(null);
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
      } catch {
        setRole(null);
      } finally {
        setLoading(false);
      }
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
  if (!admin) {
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
      { id: 'accounts', label: t('adminUsers.tabAccounts'), icon: ShieldCheck },
      { id: 'shops', label: t('adminUsers.tabShops'), icon: Users },
      { id: 'tickets', label: t('adminUsers.tabSupport'), icon: MessageCircleQuestion },
      { id: 'feedback', label: t('adminUsers.tabFeedback'), icon: Star },
    ] : []),
  ];

  return (
    <div className="flex h-full flex-col bg-surface text-ink">
      <div className="flex items-center gap-2 border-b border-osborder px-4 pt-3">
        <span className="text-accent"><ShieldCheck size={20} /></span>
        <h2 className="mr-2 text-sm font-semibold">{t('adminAccounts.admin')}</h2>
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setSection(t.id)}
            className={`flex items-center gap-1.5 border-b-2 px-3 py-2 text-xs font-medium duration-160 ${
              section === t.id
                ? 'border-accent text-ink'
                : 'border-transparent text-muted hover:text-ink'
            }`}
          >
            <t.icon size={14} />
            {t.label}
          </button>
        ))}
      </div>

      {section === 'accounts' && <AccountsSection user={user} />}
      {section === 'shops' && <ShopsSection />}
      {section === 'tickets' && <TicketsSection />}
      {section === 'feedback' && <FeedbackSection />}
    </div>
  );
}
