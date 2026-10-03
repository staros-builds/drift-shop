import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Tag, Plus, Pencil, Trash2, Search, X, Eye, EyeOff,
  RefreshCw, AlertCircle, Sparkles,
} from 'lucide-react';
import { backend } from '../lib/backend/current.js';
import { useLang } from '../lib/i18n.jsx';
import { useNotifications } from '../os/NotificationsContext.jsx';
import { ConfirmDialog } from '../components/os/dialogs.jsx';
import {
  Modal, ErrorNote, AdForm,
  fmtPrice, fmtRelative, fmtDateTime, catKey, shortId, PRICE_GREEN,
} from './ClassifiedsApp.jsx';

/* ------------------------------------------------------------------ */
/* My listings — free customer tier for classifieds (Kijiji-style).   */
/*                                                                     */
/* Any signed-in user can post personal ads without owning a shop.    */
/* Limits are enforced SERVER-SIDE (migration 099 trigger):            */
/*   * 15 active (published, non-expired) ads per user                 */
/*   * 5 new ads per user per calendar day                             */
/*   * published ads expire after 60 days (renewable)                  */
/* Shop ads (Classifieds app) are unaffected: unlimited, no expiry.    */
/* ------------------------------------------------------------------ */

const cl = () => backend.classifieds;

function isExpired(ad) {
  if (ad.status !== 'published') return false;
  if (!ad.expiresAt) return false;
  return new Date(ad.expiresAt).getTime() <= Date.now();
}

function daysLeft(ad) {
  if (!ad.expiresAt) return null;
  const ms = new Date(ad.expiresAt).getTime() - Date.now();
  return Math.max(0, Math.ceil(ms / 86400000));
}

function ExpiryBadge({ ad }) {
  const { t } = useLang();
  if (ad.status !== 'published') return null;
  if (isExpired(ad)) {
    return (
      <span className="shrink-0 rounded-full bg-red-600/15 px-2 py-0.5 text-[11px] font-medium text-red-700">
        {t('classifieds.custExpired')}
      </span>
    );
  }
  const d = daysLeft(ad);
  if (d === null) return null;
  return (
    <span className="shrink-0 rounded-full bg-sky-600/15 px-2 py-0.5 text-[11px] font-medium text-sky-700">
      {d <= 1 ? t('classifieds.custExpiresInOne') : t('classifieds.custExpiresIn', { days: d })}
    </span>
  );
}

function UpgradeCard({ reason }) {
  const { t } = useLang();
  return (
    <div className="flex items-start gap-3 rounded-os border border-accent/40 bg-accent/10 p-4">
      <Sparkles size={20} className="mt-0.5 shrink-0 text-accent" />
      <div className="min-w-0">
        <h3 className="text-sm font-semibold text-ink">{t('classifieds.custUpgradeTitle')}</h3>
        {reason && <p className="mt-1 text-xs text-ink/80">{reason}</p>}
        <p className="mt-1 text-xs text-muted">{t('classifieds.custUpgradeBody')}</p>
        <a
          href="https://vendra-1f2.pages.dev/"
          target="_blank"
          rel="noreferrer"
          className="mt-2 inline-block rounded-os bg-accent px-3 py-1.5 text-xs font-medium text-white hover:brightness-110"
        >
          {t('classifieds.custUpgradeCta')}
        </a>
      </div>
    </div>
  );
}

function CustAdCard({ ad, onView, onEdit, onDelete, onRenew, onToggleStatus }) {
  const { t } = useLang();
  const published = ad.status === 'published';
  const expired = isExpired(ad);
  const stop = (e) => e.stopPropagation();
  const open = () => onView(ad);
  const onKey = (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      open();
    }
  };
  return (
    <article
      className="flex cursor-pointer flex-col overflow-hidden rounded-os border border-osborder bg-surface transition-shadow hover:shadow-oswin"
      onClick={open}
      onKeyDown={onKey}
      tabIndex={0}
      role="button"
      aria-label={`${t('classifieds.viewDetails')}: ${ad.title}`}
    >
      <div className="relative">
        {ad.photoData ? (
          <img src={ad.photoData} alt="" className="h-40 w-full object-cover" loading="lazy" />
        ) : (
          <div className="flex h-40 w-full items-center justify-center bg-paper text-muted">
            <Tag size={32} strokeWidth={1.5} />
          </div>
        )}
        <span className="absolute bottom-2 left-2 rounded-full bg-green-700 px-2.5 py-1 text-sm font-bold text-white shadow">
          {fmtPrice(ad.priceCents, t)}
        </span>
      </div>
      <div className="flex flex-1 flex-col gap-2 p-3">
        <div className="flex items-start justify-between gap-2">
          <h4 className="text-sm font-semibold text-ink">{ad.title}</h4>
          <ExpiryBadge ad={ad} />
        </div>
        <div className="flex items-center gap-2 text-xs text-muted">
          <span>{t(`classifieds.${catKey(ad.category)}`)}</span>
          <span aria-hidden="true">·</span>
          <span>{fmtRelative(ad.createdAt)}</span>
        </div>
        <p className={`text-base font-bold ${PRICE_GREEN}`}>{fmtPrice(ad.priceCents, t)}</p>
        {ad.description && (
          <p className="line-clamp-2 whitespace-pre-line text-xs text-muted">{ad.description}</p>
        )}
        <div className="mt-auto flex flex-wrap gap-1 pt-2" onClick={stop} onKeyDown={stop}>
          {expired ? (
            <button
              type="button"
              onClick={() => onRenew(ad)}
              className="flex items-center gap-1 rounded-os bg-accent px-2 py-1 text-xs font-medium text-white hover:brightness-110"
            >
              <RefreshCw size={13} /> {t('classifieds.custRenew')}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => onToggleStatus(ad)}
              className="flex items-center gap-1 rounded-os border border-osborder px-2 py-1 text-xs hover:bg-paper"
            >
              {published ? <EyeOff size={13} /> : <Eye size={13} />}
              {published ? t('classifieds.unpublish') : t('classifieds.publish')}
            </button>
          )}
          <button
            type="button"
            onClick={() => onEdit(ad)}
            className="flex items-center gap-1 rounded-os border border-osborder px-2 py-1 text-xs hover:bg-paper"
            aria-label={`${t('classifieds.editAd')}: ${ad.title}`}
          >
            <Pencil size={13} /> {t('classifieds.editAd')}
          </button>
          <button
            type="button"
            onClick={() => onDelete(ad)}
            className="flex items-center gap-1 rounded-os border border-osborder px-2 py-1 text-xs text-red-600 hover:bg-red-500/10"
            aria-label={`${t('classifieds.deleteAd')}: ${ad.title}`}
          >
            <Trash2 size={13} /> {t('classifieds.deleteAd')}
          </button>
        </div>
      </div>
    </article>
  );
}

function CustAdDetail({ ad, onClose, onEdit, onRenew }) {
  const { t } = useLang();
  const expired = isExpired(ad);
  const contact = [ad.contactName, ad.contactPhone, ad.contactEmail].filter(Boolean);
  return (
    <Modal title={ad.title} onClose={onClose}>
      <div className="space-y-4">
        {ad.photoData && (
          <div className="relative">
            <img src={ad.photoData} alt="" className="max-h-72 w-full rounded-os object-cover" />
            <span className="absolute bottom-2 left-2 rounded-full bg-green-700 px-2.5 py-1 text-sm font-bold text-white shadow">
              {fmtPrice(ad.priceCents, t)}
            </span>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-full bg-surface px-2.5 py-1 text-xs font-medium text-muted">
            {t(`classifieds.${catKey(ad.category)}`)}
          </span>
          <ExpiryBadge ad={ad} />
        </div>
        <p className={`text-xl font-bold ${PRICE_GREEN}`}>{fmtPrice(ad.priceCents, t)}</p>
        {ad.description && <p className="whitespace-pre-line text-sm text-ink">{ad.description}</p>}
        {contact.length > 0 && (
          <div className="rounded-os border border-osborder bg-surface p-3 text-sm">
            <p className="mb-1 text-xs font-medium text-muted">{t('classifieds.contactNameLabel')}</p>
            {contact.map((c) => (
              <p key={c} className="text-ink">{c}</p>
            ))}
          </div>
        )}
        <dl className="grid grid-cols-2 gap-2 text-xs text-muted">
          <div>
            <dt className="font-medium">{t('classifieds.postIdLabel')}</dt>
            <dd className="font-mono text-ink">{shortId(ad.id)}</dd>
          </div>
          <div>
            <dt className="font-medium">{t('classifieds.postedAtLabel')}</dt>
            <dd className="text-ink">{fmtDateTime(ad.createdAt)}</dd>
          </div>
        </dl>
        <div className="flex items-start gap-2 rounded-os border border-amber-500/30 bg-amber-500/10 px-3 py-2.5">
          <AlertCircle size={16} className="mt-0.5 shrink-0 text-amber-600" />
          <div className="text-xs">
            <p className="font-semibold text-amber-800 dark:text-amber-300">{t('classifieds.safetyTitle')}</p>
            <p className="text-amber-900/80 dark:text-amber-200/80">{t('classifieds.safetyBody')}</p>
          </div>
        </div>
        <div className="flex flex-wrap justify-end gap-2 pt-1">
          {expired && (
            <button
              type="button"
              onClick={() => { onClose(); onRenew(ad); }}
              className="flex items-center gap-1 rounded-os bg-accent px-3 py-2 text-sm font-medium text-white hover:brightness-110"
            >
              <RefreshCw size={14} /> {t('classifieds.custRenew')}
            </button>
          )}
          <button
            type="button"
            onClick={() => { onClose(); onEdit(ad); }}
            className="flex items-center gap-1 rounded-os border border-osborder px-3 py-2 text-sm hover:bg-surface"
          >
            <Pencil size={14} /> {t('classifieds.editAd')}
          </button>
        </div>
      </div>
    </Modal>
  );
}

export default function MyListingsApp() {
  const { t } = useLang();
  const { push } = useNotifications();
  const [available, setAvailable] = useState(null);
  const [ads, setAds] = useState([]);
  const [limits, setLimits] = useState(null);
  // Starts as built-in defaults; refresh() replaces with the platform
  // owner's effective settings (migration 100).
  const [limitInfo, setLimitInfo] = useState(() => ({ ...cl().customerLimitsInfo(), enabled: true }));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [tab, setTab] = useState('active');
  const [search, setSearch] = useState('');
  const [catFilter, setCatFilter] = useState('all');
  const [editing, setEditing] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const [viewing, setViewing] = useState(null);
  const [saving, setSaving] = useState(false);
  const [limitNotice, setLimitNotice] = useState(''); // 'active' | 'daily' | 'disabled' | ''

  const refresh = useCallback(async () => {
    const [list, lim, eff] = await Promise.all([
      cl().customerList(),
      cl().customerLimits(),
      cl().effectiveLimits().catch(() => cl().customerLimitsInfo()),
    ]);
    setAds(list);
    setLimits(lim);
    // Effective limits honor the platform owner's settings (migration 100).
    setLimitInfo({
      maxActive: eff.maxActive,
      maxPerDay: eff.maxPerDay,
      expiryDays: eff.expiryDays,
      enabled: eff.enabled !== false,
    });
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const ok = await cl().available();
      setAvailable(ok);
      if (!ok) return;
      await refresh();
    } catch (err) {
      setError(`${t('classifieds.errLoad')}: ${err?.message || err}`);
    } finally {
      setLoading(false);
    }
  }, [t, refresh]);

  useEffect(() => {
    load();
  }, [load]);

  const limitErrorMessage = useCallback(
    (err) => {
      if (err?.limitKind === 'disabled') {
        return t('classifieds.custTierDisabled');
      }
      if (err?.limitKind === 'active') {
        return t('classifieds.custLimitHitActive', { max: limitInfo.maxActive });
      }
      if (err?.limitKind === 'daily') {
        return t('classifieds.custLimitHitDaily', { max: limitInfo.maxPerDay });
      }
      return `${t('classifieds.errSave')}: ${err?.message || err}`;
    },
    [t, limitInfo]
  );

  const saveAd = useCallback(
    async (values) => {
      setSaving(true);
      setLimitNotice('');
      try {
        if (editing && editing !== 'new') {
          await cl().customerUpdate(editing.id, values);
        } else {
          await cl().customerCreate(values);
        }
        await refresh();
        setEditing(null);
        push(
          t('classifieds.custAppName'),
          values.status === 'published' ? t('classifieds.publishSuccess') : t('classifieds.saveSuccess')
        );
      } catch (err) {
        if (err?.limitKind) {
          setLimitNotice(err.limitKind);
          push(t('classifieds.custAppName'), limitErrorMessage(err));
        } else {
          push(t('classifieds.custAppName'), `${t('classifieds.errSave')}: ${err?.message || err}`);
        }
      } finally {
        setSaving(false);
      }
    },
    [editing, push, t, refresh, limitErrorMessage]
  );

  const toggleStatus = useCallback(
    async (ad) => {
      const next = ad.status === 'published' ? 'draft' : 'published';
      setLimitNotice('');
      try {
        await cl().customerUpdate(ad.id, { status: next });
        await refresh();
        push(t('classifieds.custAppName'), next === 'published' ? t('classifieds.publishSuccess') : t('classifieds.unpublishSuccess'));
      } catch (err) {
        if (err?.limitKind) {
          setLimitNotice(err.limitKind);
          push(t('classifieds.custAppName'), limitErrorMessage(err));
        } else {
          push(t('classifieds.custAppName'), `${t('classifieds.errSave')}: ${err?.message || err}`);
        }
      }
    },
    [push, t, refresh, limitErrorMessage]
  );

  const renewAd = useCallback(
    async (ad) => {
      setLimitNotice('');
      try {
        await cl().customerRenew(ad.id);
        await refresh();
        setViewing((v) => (v && v.id === ad.id ? { ...v, status: 'published', expiresAt: new Date(Date.now() + 60 * 86400000).toISOString() } : v));
        push(t('classifieds.custAppName'), t('classifieds.custRenewed'));
      } catch (err) {
        if (err?.limitKind) {
          setLimitNotice(err.limitKind);
          push(t('classifieds.custAppName'), limitErrorMessage(err));
        } else {
          push(t('classifieds.custAppName'), `${t('classifieds.errSave')}: ${err?.message || err}`);
        }
      }
    },
    [push, t, refresh, limitErrorMessage]
  );

  const confirmDelete = useCallback(async () => {
    if (!deleting) return;
    try {
      await cl().customerRemove(deleting.id);
      await refresh();
      push(t('classifieds.custAppName'), t('classifieds.deleteSuccess'));
    } catch (err) {
      push(t('classifieds.custAppName'), `${t('classifieds.errDelete')}: ${err?.message || err}`);
    } finally {
      setDeleting(null);
    }
  }, [deleting, push, t, refresh]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return ads.filter((ad) => {
      const expired = isExpired(ad);
      if (tab === 'active' && (ad.status !== 'published' || expired)) return false;
      if (tab === 'expired' && !expired) return false;
      if (catFilter !== 'all' && ad.category !== catFilter) return false;
      if (q && !`${ad.title} ${ad.description}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [ads, tab, search, catFilter]);

  if (available === false) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
        <Tag size={40} className="text-muted" strokeWidth={1.5} />
        <h2 className="text-lg font-semibold text-ink">{t('classifieds.needsUpdateTitle')}</h2>
        <p className="max-w-md text-sm text-muted">{t('classifieds.needsUpdateBody')}</p>
      </div>
    );
  }

  const emptyKey =
    search.trim() || catFilter !== 'all'
      ? 'custEmptySearch'
      : tab === 'active'
        ? 'custEmptyActive'
        : tab === 'expired'
          ? 'custEmptyExpired'
          : 'custEmptyAll';

  const postsLeft = limits ? Math.max(0, limitInfo.maxPerDay - limits.today) : null;

  return (
    <div className="flex h-full flex-col gap-3 p-4">
      {/* header */}
      <div className="flex flex-wrap items-center gap-2">
        <Tag size={20} className="text-accent" />
        <div className="mr-auto">
          <h2 className="text-base font-semibold text-ink">{t('classifieds.custAppName')}</h2>
          <p className="text-xs text-muted">{t('classifieds.custAppTagline')}</p>
        </div>
        <button
          type="button"
          onClick={() => setEditing('new')}
          disabled={loading}
          className="flex items-center gap-1.5 rounded-os bg-accent px-3 py-2 text-sm font-medium text-white hover:brightness-110 disabled:opacity-50"
        >
          <Plus size={15} /> {t('classifieds.newAd')}
        </button>
      </div>

      {/* limit banner */}
      {limits && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-os border border-osborder bg-surface px-3 py-2 text-xs text-muted">
          <span>
            {t('classifieds.custLimitBanner', {
              active: limits.active,
              max: limitInfo.maxActive,
              left: postsLeft,
            })}
          </span>
          <span className="ml-auto hidden sm:inline">{t('classifieds.custPublishedNote')}</span>
        </div>
      )}

      {/* upgrade prompt when a limit was just hit */}
      {limitNotice && (
        <UpgradeCard
          reason={
            limitNotice === 'disabled'
              ? t('classifieds.custTierDisabled')
              : limitNotice === 'active'
                ? t('classifieds.custLimitHitActive', { max: limitInfo.maxActive })
                : t('classifieds.custLimitHitDaily', { max: limitInfo.maxPerDay })
          }
        />
      )}

      {/* free tier paused by the platform owner */}
      {limitInfo.enabled === false && (
        <div className="rounded-os border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700">
          {t('classifieds.custTierDisabled')}
        </div>
      )}

      {/* tabs + search */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex rounded-os border border-osborder" role="tablist" aria-label={t('classifieds.statusLabel')}>
          {[
            ['active', 'custTabActive'],
            ['expired', 'custTabExpired'],
            ['all', 'custTabAll'],
          ].map(([id, key]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              onClick={() => setTab(id)}
              className={`px-3 py-1.5 text-sm ${
                tab === id ? 'bg-accent font-medium text-white' : 'text-muted hover:text-ink'
              } ${id === 'active' ? 'rounded-l-os' : ''} ${id === 'all' ? 'rounded-r-os' : ''}`}
            >
              {t(`classifieds.${key}`)}
            </button>
          ))}
        </div>
        <div className="relative min-w-40 flex-1">
          <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input
            className="w-full rounded-os border border-osborder bg-surface px-3 py-2 pl-9 text-sm text-ink placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-accent/60"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('classifieds.searchPlaceholder')}
            aria-label={t('classifieds.searchPlaceholder')}
          />
        </div>
      </div>

      {/* flat category chips */}
      <div className="flex gap-1.5 overflow-x-auto pb-1" role="group" aria-label={t('classifieds.categoryLabel')}>
        {['all', ...cl().categories()].map((c) => {
          const active = catFilter === c;
          return (
            <button
              key={c}
              type="button"
              onClick={() => setCatFilter(c)}
              aria-pressed={active}
              className={`shrink-0 rounded-full border px-3 py-1.5 text-xs font-medium ${
                active ? 'border-accent bg-accent text-white' : 'border-osborder bg-surface text-muted hover:text-ink'
              }`}
            >
              {c === 'all' ? t('classifieds.allCategories') : t(`classifieds.${catKey(c)}`)}
            </button>
          );
        })}
      </div>

      <ErrorNote message={error} />

      {/* body */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading ? (
          <p className="p-8 text-center text-sm text-muted">…</p>
        ) : filtered.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
            <Tag size={36} className="text-muted" strokeWidth={1.5} />
            <p className="max-w-sm text-sm text-muted">{t(`classifieds.${emptyKey}`)}</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {filtered.map((ad) => (
              <CustAdCard
                key={ad.id}
                ad={ad}
                onView={setViewing}
                onEdit={setEditing}
                onDelete={setDeleting}
                onRenew={renewAd}
                onToggleStatus={toggleStatus}
              />
            ))}
          </div>
        )}
      </div>

      <p className="text-center text-[11px] text-muted">{t('classifieds.hideAppHint')}</p>

      {viewing && (
        <CustAdDetail
          ad={viewing}
          onClose={() => setViewing(null)}
          onEdit={setEditing}
          onRenew={renewAd}
        />
      )}

      {editing && (
        <Modal
          title={editing === 'new' ? t('classifieds.newAd') : t('classifieds.editAd')}
          onClose={() => setEditing(null)}
        >
          <AdForm
            initial={editing === 'new' ? null : editing}
            onSave={saveAd}
            onClose={() => setEditing(null)}
            saving={saving}
          />
        </Modal>
      )}

      {deleting && (
        <ConfirmDialog
          title={t('classifieds.confirmDeleteTitle')}
          message={t('classifieds.confirmDeleteBody', { title: deleting.title })}
          confirmLabel={t('classifieds.deleteAd')}
          danger
          onConfirm={confirmDelete}
          onCancel={() => setDeleting(null)}
        />
      )}
    </div>
  );
}
