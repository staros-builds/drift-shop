import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  Newspaper, Plus, Pencil, Trash2, Search, X, Image as ImageIcon,
  Eye, EyeOff, Tag, Phone, Mail, User, AlertCircle, Store as StoreIcon,
} from 'lucide-react';
import { backend } from '../lib/backend/current.js';
import { useLang, localeTag } from '../lib/i18n.jsx';
import { useNotifications } from '../os/NotificationsContext.jsx';
import { ConfirmDialog } from '../components/os/dialogs.jsx';
import { shrinkImageFile } from '../lib/imageShrink.js';

/* ------------------------------------------------------------------ */
/* Classifieds — Kijiji-style bulletin-board ads per shop.             */
/*                                                                     */
/* Shop owners post ads (for sale, free stuff, services, wanted, …).   */
/* Each ad starts as a draft; publishing it makes it appear on the     */
/* shop's public storefront through the public_classifieds() RPC.      */
/*                                                                     */
/* Storage: backend.classifieds (migration 097). Until 097 is applied  */
/* the app shows a friendly "needs a small system update" note instead */
/* of raw errors (same capability-probe pattern as POS HR features).   */
/* ------------------------------------------------------------------ */

const cl = () => backend.classifieds;

function fmtDate(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleDateString(localeTag(), {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return '—';
  }
}

function fmtPrice(priceCents, t) {
  if (priceCents === null || priceCents === undefined) return t('classifieds.priceContact');
  if (Number(priceCents) === 0) return t('classifieds.priceFree');
  return (
    new Intl.NumberFormat(localeTag(), {
      style: 'currency',
      currency: 'CAD',
    }).format(Number(priceCents) / 100)
  );
}

function catKey(cat) {
  const map = {
    'for-sale': 'catForSale',
    free: 'catFree',
    services: 'catServices',
    wanted: 'catWanted',
    jobs: 'catJobs',
    events: 'catEvents',
    announcements: 'catAnnouncements',
  };
  return map[cat] || 'catForSale';
}

function ErrorNote({ message }) {
  if (!message) return null;
  return (
    <p className="flex items-start gap-2 rounded-os border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-600">
      <AlertCircle size={14} className="mt-0.5 shrink-0" /> {message}
    </p>
  );
}

function Modal({ title, onClose, children }) {
  const { t } = useLang();
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-os border border-osborder bg-paper p-5 shadow-oswin"
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-base font-semibold text-ink">{title}</h3>
          <button
            type="button"
            onClick={onClose}
            className="rounded-os p-1.5 text-muted hover:bg-surface hover:text-ink"
            aria-label={t('common.close')}
          >
            <X size={16} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

const inputCls =
  'w-full rounded-os border border-osborder bg-surface px-3 py-2 text-sm text-ink placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-accent/60';
const labelCls = 'mb-1 block text-xs font-medium text-muted';

function AdForm({ initial, onSave, onClose, saving }) {
  const { t } = useLang();
  const { push } = useNotifications();
  const [title, setTitle] = useState(initial?.title ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [price, setPrice] = useState(
    initial?.priceCents === null || initial?.priceCents === undefined
      ? ''
      : String(Number(initial.priceCents) / 100)
  );
  const [category, setCategory] = useState(initial?.category ?? 'for-sale');
  const [photoData, setPhotoData] = useState(initial?.photoData ?? null);
  const [contactName, setContactName] = useState(initial?.contactName ?? '');
  const [contactPhone, setContactPhone] = useState(initial?.contactPhone ?? '');
  const [contactEmail, setContactEmail] = useState(initial?.contactEmail ?? '');
  const [formError, setFormError] = useState('');
  const fileRef = useRef(null);

  const pickPhoto = async (file) => {
    if (!file) return;
    try {
      const shrunk = await shrinkImageFile(file);
      setPhotoData(shrunk.dataUrl || shrunk);
      setFormError('');
    } catch (err) {
      push(t('classifieds.appName'), `${t('classifieds.errPhoto')}: ${err?.message || err}`);
    }
  };

  const submit = async (publish) => {
    setFormError('');
    if (!title.trim()) {
      setFormError(t('classifieds.errTitleRequired'));
      return;
    }
    let priceCents = null;
    if (String(price).trim() !== '') {
      const n = Math.round(Number(price) * 100);
      if (!Number.isFinite(n) || n < 0) {
        setFormError(t('classifieds.errSave'));
        return;
      }
      priceCents = n;
    }
    await onSave({
      title: title.trim(),
      description: description.trim(),
      priceCents,
      category,
      photoData,
      contactName: contactName.trim(),
      contactPhone: contactPhone.trim(),
      contactEmail: contactEmail.trim(),
      status: publish ? 'published' : 'draft',
    });
  };

  return (
    <div className="space-y-4">
      <ErrorNote message={formError} />
      <div>
        <label className={labelCls} htmlFor="cl-title">{t('classifieds.titleLabel')}</label>
        <input
          id="cl-title"
          className={inputCls}
          value={title}
          maxLength={120}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={t('classifieds.titlePlaceholder')}
        />
      </div>
      <div>
        <label className={labelCls} htmlFor="cl-desc">{t('classifieds.descriptionLabel')}</label>
        <textarea
          id="cl-desc"
          className={`${inputCls} min-h-24`}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={t('classifieds.descriptionPlaceholder')}
        />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className={labelCls} htmlFor="cl-price">{t('classifieds.priceLabel')}</label>
          <input
            id="cl-price"
            className={inputCls}
            inputMode="decimal"
            value={price}
            onChange={(e) => setPrice(e.target.value.replace(/[^0-9.]/g, ''))}
            placeholder={t('classifieds.pricePlaceholder')}
          />
        </div>
        <div>
          <label className={labelCls} htmlFor="cl-cat">{t('classifieds.categoryLabel')}</label>
          <select
            id="cl-cat"
            className={inputCls}
            value={category}
            onChange={(e) => setCategory(e.target.value)}
          >
            {cl().categories().map((c) => (
              <option key={c} value={c}>
                {t(`classifieds.${catKey(c)}`)}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div>
        <span className={labelCls}>{t('classifieds.photoLabel')}</span>
        <div className="flex items-center gap-3">
          {photoData ? (
            <img
              src={photoData}
              alt=""
              className="h-20 w-20 rounded-os border border-osborder object-cover"
            />
          ) : (
            <div className="flex h-20 w-20 items-center justify-center rounded-os border border-dashed border-osborder text-muted">
              <ImageIcon size={24} />
            </div>
          )}
          <div className="flex flex-col gap-2">
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="rounded-os border border-osborder px-3 py-1.5 text-sm hover:bg-surface"
            >
              {photoData ? t('classifieds.photoChange') : t('classifieds.photoLabel')}
            </button>
            {photoData && (
              <button
                type="button"
                onClick={() => setPhotoData(null)}
                className="rounded-os px-3 py-1.5 text-sm text-red-600 hover:bg-red-500/10"
              >
                {t('classifieds.photoRemove')}
              </button>
            )}
          </div>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="hidden"
            aria-label={t('classifieds.photoLabel')}
            onChange={(e) => {
              const files = Array.from(e.target.files || []);
              e.target.value = '';
              if (files[0]) pickPhoto(files[0]);
            }}
          />
        </div>
      </div>
      <fieldset>
        <legend className="mb-1 text-xs font-medium text-muted">{t('classifieds.contactNameLabel')}</legend>
        <p className="mb-2 text-xs text-muted">{t('classifieds.contactHint')}</p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="relative">
            <User size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
            <input
              className={`${inputCls} pl-9`}
              value={contactName}
              onChange={(e) => setContactName(e.target.value)}
              placeholder={t('classifieds.contactNameLabel')}
              aria-label={t('classifieds.contactNameLabel')}
            />
          </div>
          <div className="relative">
            <Phone size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
            <input
              className={`${inputCls} pl-9`}
              value={contactPhone}
              onChange={(e) => setContactPhone(e.target.value)}
              placeholder={t('classifieds.contactPhoneLabel')}
              aria-label={t('classifieds.contactPhoneLabel')}
            />
          </div>
          <div className="relative">
            <Mail size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
            <input
              className={`${inputCls} pl-9`}
              value={contactEmail}
              onChange={(e) => setContactEmail(e.target.value)}
              placeholder={t('classifieds.contactEmailLabel')}
              aria-label={t('classifieds.contactEmailLabel')}
            />
          </div>
        </div>
      </fieldset>
      <div className="flex flex-wrap justify-end gap-2 pt-2">
        <button
          type="button"
          onClick={onClose}
          className="rounded-os border border-osborder px-4 py-2 text-sm hover:bg-surface"
        >
          {t('dialogs.cancel')}
        </button>
        <button
          type="button"
          disabled={saving}
          onClick={() => submit(false)}
          className="rounded-os border border-osborder px-4 py-2 text-sm font-medium hover:bg-surface disabled:opacity-50"
        >
          {initial ? t('classifieds.saveChanges') : t('classifieds.saveDraft')}
        </button>
        {(!initial || initial.status === 'draft') && (
          <button
            type="button"
            disabled={saving}
            onClick={() => submit(true)}
            className="rounded-os bg-accent px-4 py-2 text-sm font-medium text-white hover:brightness-110 disabled:opacity-50"
          >
            {t('classifieds.publishAd')}
          </button>
        )}
      </div>
    </div>
  );
}

function AdCard({ ad, onEdit, onDelete, onToggleStatus }) {
  const { t } = useLang();
  const published = ad.status === 'published';
  return (
    <article className="flex flex-col overflow-hidden rounded-os border border-osborder bg-surface">
      {ad.photoData ? (
        <img src={ad.photoData} alt="" className="h-40 w-full object-cover" loading="lazy" />
      ) : (
        <div className="flex h-40 w-full items-center justify-center bg-paper text-muted">
          <Newspaper size={32} strokeWidth={1.5} />
        </div>
      )}
      <div className="flex flex-1 flex-col gap-2 p-3">
        <div className="flex items-start justify-between gap-2">
          <h4 className="text-sm font-semibold text-ink">{ad.title}</h4>
          <span
            className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${
              published ? 'bg-green-600/15 text-green-700' : 'bg-amber-500/15 text-amber-700'
            }`}
          >
            {published ? t('classifieds.statusPublished') : t('classifieds.statusDraft')}
          </span>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted">
          <Tag size={12} />
          <span>{t(`classifieds.${catKey(ad.category)}`)}</span>
          <span aria-hidden="true">·</span>
          <span>{t('classifieds.postedOn', { date: fmtDate(ad.createdAt) })}</span>
        </div>
        <p className="text-base font-bold text-accent">{fmtPrice(ad.priceCents, t)}</p>
        {ad.description && (
          <p className="line-clamp-3 whitespace-pre-line text-xs text-muted">{ad.description}</p>
        )}
        <div className="mt-auto flex flex-wrap gap-1 pt-2">
          <button
            type="button"
            onClick={() => onToggleStatus(ad)}
            className="flex items-center gap-1 rounded-os border border-osborder px-2 py-1 text-xs hover:bg-paper"
            aria-label={published ? t('classifieds.unpublish') : t('classifieds.publish')}
            title={published ? t('classifieds.unpublish') : t('classifieds.publish')}
          >
            {published ? <EyeOff size={13} /> : <Eye size={13} />}
            {published ? t('classifieds.unpublish') : t('classifieds.publish')}
          </button>
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

export default function ClassifiedsApp() {
  const { t } = useLang();
  const { push } = useNotifications();
  const [available, setAvailable] = useState(null);
  const [stores, setStores] = useState([]);
  const [storeId, setStoreId] = useState('');
  const [ads, setAds] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [tab, setTab] = useState('published');
  const [search, setSearch] = useState('');
  const [catFilter, setCatFilter] = useState('all');
  const [editing, setEditing] = useState(null); // null | 'new' | ad
  const [deleting, setDeleting] = useState(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const ok = await cl().available();
      setAvailable(ok);
      if (!ok) return;
      const ss = await backend.pos.listStores();
      setStores(ss);
      const sid = ss[0]?.id ?? '';
      setStoreId((prev) => prev || sid);
      if (sid) {
        setAds(await cl().list(sid));
      }
    } catch (err) {
      setError(`${t('classifieds.errLoad')}: ${err?.message || err}`);
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    load();
  }, [load]);

  const changeStore = useCallback(
    async (sid) => {
      setStoreId(sid);
      setError('');
      try {
        setAds(await cl().list(sid));
      } catch (err) {
        setError(`${t('classifieds.errLoad')}: ${err?.message || err}`);
      }
    },
    [t]
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return ads.filter((ad) => {
      if (tab === 'published' && ad.status !== 'published') return false;
      if (tab === 'drafts' && ad.status !== 'draft') return false;
      if (catFilter !== 'all' && ad.category !== catFilter) return false;
      if (
        q &&
        !`${ad.title} ${ad.description}`.toLowerCase().includes(q)
      )
        return false;
      return true;
    });
  }, [ads, tab, search, catFilter]);

  const saveAd = useCallback(
    async (values) => {
      setSaving(true);
      try {
        if (editing && editing !== 'new') {
          await cl().update(editing.id, values);
        } else {
          await cl().create(storeId, values);
        }
        setAds(await cl().list(storeId));
        setEditing(null);
        push(
          t('classifieds.appName'),
          values.status === 'published' && (!editing || editing === 'new' || editing.status === 'draft')
            ? t('classifieds.publishSuccess')
            : t('classifieds.saveSuccess')
        );
      } catch (err) {
        push(t('classifieds.appName'), `${t('classifieds.errSave')}: ${err?.message || err}`);
      } finally {
        setSaving(false);
      }
    },
    [editing, storeId, push, t]
  );

  const toggleStatus = useCallback(
    async (ad) => {
      const next = ad.status === 'published' ? 'draft' : 'published';
      try {
        await cl().update(ad.id, { status: next });
        setAds(await cl().list(storeId));
        push(
          t('classifieds.appName'),
          next === 'published' ? t('classifieds.publishSuccess') : t('classifieds.unpublishSuccess')
        );
      } catch (err) {
        push(t('classifieds.appName'), `${t('classifieds.errSave')}: ${err?.message || err}`);
      }
    },
    [storeId, push, t]
  );

  const confirmDelete = useCallback(async () => {
    if (!deleting) return;
    try {
      await cl().remove(deleting.id);
      setAds(await cl().list(storeId));
      push(t('classifieds.appName'), t('classifieds.deleteSuccess'));
    } catch (err) {
      push(t('classifieds.appName'), `${t('classifieds.errDelete')}: ${err?.message || err}`);
    } finally {
      setDeleting(null);
    }
  }, [deleting, storeId, push, t]);

  if (available === false) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
        <Newspaper size={40} className="text-muted" strokeWidth={1.5} />
        <h2 className="text-lg font-semibold text-ink">{t('classifieds.needsUpdateTitle')}</h2>
        <p className="max-w-md text-sm text-muted">{t('classifieds.needsUpdateBody')}</p>
      </div>
    );
  }

  const emptyKey =
    search.trim() || catFilter !== 'all'
      ? 'emptySearch'
      : tab === 'published'
        ? 'emptyPublished'
        : tab === 'drafts'
          ? 'emptyDrafts'
          : 'emptyAll';

  return (
    <div className="flex h-full flex-col gap-3 p-4">
      {/* header */}
      <div className="flex flex-wrap items-center gap-2">
        <Newspaper size={20} className="text-accent" />
        <div className="mr-auto">
          <h2 className="text-base font-semibold text-ink">{t('classifieds.appName')}</h2>
          <p className="text-xs text-muted">{t('classifieds.appTagline')}</p>
        </div>
        {stores.length > 1 && (
          <label className="flex items-center gap-2 text-xs text-muted">
            <StoreIcon size={14} />
            <select
              className="rounded-os border border-osborder bg-surface px-2 py-1.5 text-sm text-ink"
              value={storeId}
              onChange={(e) => changeStore(e.target.value)}
              aria-label={t('classifieds.appName')}
            >
              {stores.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <button
          type="button"
          onClick={() => setEditing('new')}
          disabled={!storeId || loading}
          className="flex items-center gap-1.5 rounded-os bg-accent px-3 py-2 text-sm font-medium text-white hover:brightness-110 disabled:opacity-50"
        >
          <Plus size={15} /> {t('classifieds.newAd')}
        </button>
      </div>

      {/* tabs + filters */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex rounded-os border border-osborder" role="tablist" aria-label={t('classifieds.statusLabel')}>
          {[
            ['published', 'tabPublished'],
            ['drafts', 'tabDrafts'],
            ['all', 'tabAll'],
          ].map(([id, key]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              onClick={() => setTab(id)}
              className={`px-3 py-1.5 text-sm ${
                tab === id ? 'bg-accent font-medium text-white' : 'text-muted hover:text-ink'
              } ${id === 'published' ? 'rounded-l-os' : ''} ${id === 'all' ? 'rounded-r-os' : ''}`}
            >
              {t(`classifieds.${key}`)}
            </button>
          ))}
        </div>
        <div className="relative min-w-40 flex-1">
          <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input
            className={`${inputCls} pl-9`}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('classifieds.searchPlaceholder')}
            aria-label={t('classifieds.searchPlaceholder')}
          />
        </div>
        <select
          className="rounded-os border border-osborder bg-surface px-2 py-2 text-sm text-ink"
          value={catFilter}
          onChange={(e) => setCatFilter(e.target.value)}
          aria-label={t('classifieds.categoryLabel')}
        >
          <option value="all">{t('classifieds.allCategories')}</option>
          {cl().categories().map((c) => (
            <option key={c} value={c}>
              {t(`classifieds.${catKey(c)}`)}
            </option>
          ))}
        </select>
      </div>

      <ErrorNote message={error} />

      {/* body */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading ? (
          <p className="p-8 text-center text-sm text-muted">…</p>
        ) : !storeId ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
            <StoreIcon size={36} className="text-muted" strokeWidth={1.5} />
            <h3 className="font-semibold text-ink">{t('classifieds.noStoresTitle')}</h3>
            <p className="max-w-sm text-sm text-muted">{t('classifieds.noStoresBody')}</p>
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
            <Newspaper size={36} className="text-muted" strokeWidth={1.5} />
            <p className="max-w-sm text-sm text-muted">{t(`classifieds.${emptyKey}`)}</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {filtered.map((ad) => (
              <AdCard
                key={ad.id}
                ad={ad}
                onEdit={setEditing}
                onDelete={setDeleting}
                onToggleStatus={toggleStatus}
              />
            ))}
          </div>
        )}
      </div>

      <p className="text-center text-[11px] text-muted">{t('classifieds.hideAppHint')}</p>

      {/* editor modal */}
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

      {/* delete confirm */}
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
