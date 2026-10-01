import React, { useState, useEffect, useCallback, useRef, useContext, createContext } from 'react';
import {
  LibraryBig, BookOpen, Package, HandHeart, ArrowLeftRight, Tent,
  ClipboardList, Plus, Pencil, Trash2, AlertCircle, X, Search,
  Download, Upload, Check, ChevronDown, ShoppingBag, Store, KeyRound,
} from 'lucide-react';
import { backend } from '../lib/backend/current.js';
import { useLang, localeTag } from '../lib/i18n.jsx';

/* ------------------------------------------------------------------ */
/* Bouquinerie — bookstore + thrift inventory for LFDD (FR/EN).         */
/* Catalogue (books & thrift items), donation intake, sorting triage,  */
/* Foire du livre sales, special orders, CSV import/export bridge.     */
/* Shared-shop model (migration 016): one pos_store per shop; roles    */
/* owner/manager/cashier. Destructive deletes are manager+.            */
/* ------------------------------------------------------------------ */

const bq = () => backend.bouquinerie;

// Shop permissions for the tab components below. canDelete is false for
// cashiers (RLS enforces it server-side; this just hides the buttons).
const BqPerms = createContext({ canDelete: true });
const useBqPerms = () => useContext(BqPerms);

function fmtDate(ymd) {
  if (!ymd) return '—';
  const d = ymd.length <= 10 ? new Date(ymd + 'T12:00:00') : new Date(ymd);
  return d.toLocaleDateString(localeTag(), { year: 'numeric', month: 'short', day: 'numeric' });
}
function fmtMoney(n) {
  return new Intl.NumberFormat(localeTag(), { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(n) || 0) + ' $';
}

/** In-app delete confirmation (window.confirm is unreliable in embedded browsers). */
function ConfirmDeleteDialog({ title, message, onConfirm, onClose }) {
  const { t } = useLang();
  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-ink/30 p-4"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-80 rounded-os border border-osborder bg-surface shadow-win">
        <div className="border-b border-osborder px-4 py-3">
          <h3 className="text-sm font-semibold text-ink">{title}</h3>
        </div>
        <div className="p-4">
          <p className="text-sm text-ink">{message}</p>
          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              autoFocus
              className="rounded-os border border-osborder px-3 py-1.5 text-sm hover:bg-paper"
            >
              {t('dialogs.cancel')}
            </button>
            <button
              type="button"
              onClick={onConfirm}
              className="rounded-os bg-red-700 px-4 py-1.5 text-sm font-medium text-white hover:bg-red-800"
            >
              {t('common.delete')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function todayYMD() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function ErrorNote({ message }) {
  if (!message) return null;
  return (
    <p className="flex items-start gap-2 rounded-os border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-600">
      <AlertCircle size={14} className="mt-0.5 shrink-0" /> {message}
    </p>
  );
}

function Modal({ title, onClose, children, wide }) {
  const { t } = useLang();
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className={`max-h-[90vh] w-full ${wide ? 'max-w-2xl' : 'max-w-md'} overflow-y-auto rounded-os border border-osborder bg-paper p-5 shadow-oswin`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-base font-semibold text-ink">{title}</h3>
          <button type="button" onClick={onClose} className="rounded-os p-1.5 text-muted hover:bg-surface hover:text-ink" aria-label={t('common.close')}>
            <X size={16} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

const inputCls =
  'w-full rounded-os border border-osborder bg-surface px-3 py-2 text-sm text-ink placeholder:text-muted/70 focus:border-accent focus:outline-none';
const labelCls = 'mb-1 block text-xs font-medium text-muted';
const btnPrimary =
  'rounded-os bg-accent px-4 py-2 text-sm font-semibold text-accentink hover:opacity-90 disabled:opacity-50';
const btnGhost =
  'rounded-os border border-osborder px-3 py-1.5 text-xs font-medium text-ink hover:border-accent disabled:opacity-50';

function Seg({ options, value, onChange }) {
  return (
    <div className="flex gap-1 rounded-os bg-surface p-0.5">
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          onClick={() => onChange(o.id)}
          className={`rounded-os px-2.5 py-1 text-xs font-medium duration-160 ${
            value === o.id ? 'bg-paper text-ink shadow-os' : 'text-muted hover:text-ink'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function StatusBadge({ status }) {
  const { t } = useLang();
  const map = {
    store: 'bg-emerald-500/15 text-emerald-700',
    sorting: 'bg-amber-500/15 text-amber-700',
    fair: 'bg-purple-500/15 text-purple-700',
    sold: 'bg-surface text-muted',
    donated: 'bg-sky-500/15 text-sky-700',
    recycled: 'bg-surface text-muted line-through',
  };
  const label = {
    store: t('inventory.stStock'),
    sorting: t('inventory.stTriage'),
    fair: t('inventory.stFair'),
    sold: t('inventory.stSold'),
    donated: t('inventory.stDonated'),
    recycled: t('inventory.stRecycled'),
  }[status] || status;
  return (
    <span className={`inline-block rounded-os px-2 py-0.5 text-[11px] font-medium ${map[status] || 'bg-surface text-muted'}`}>
      {label}
    </span>
  );
}

/* ------------------------------ catalogue ------------------------------ */

const EMPTY_ITEM = {
  kind: 'book', title: '', author: '', isbn: '', category: '', isNew: false,
  condition: '', qty: 1, price: 0, shelf: '', source: 'donation', status: 'sorting',
  abeRef: '', abeStatus: '', notes: '',
};

function ItemModal({ item, donationId, onClose, onSaved }) {
  const { t } = useLang();
  const [form, setForm] = useState(item ? { ...EMPTY_ITEM, ...item } : { ...EMPTY_ITEM });
  const [dupes, setDupes] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const save = async (force) => {
    setError('');
    setBusy(true);
    try {
      if (!force) {
        const found = await bq().findDuplicates({
          isbn: form.isbn, title: form.title, author: form.author,
          excludeId: item?.id,
        });
        if (found && found.length > 0) {
          setDupes(found);
          setBusy(false);
          return;
        }
      }
      const saved = await bq().saveItem({ ...form, id: item?.id });
      if (donationId) await bq().linkDonationItems(donationId, [saved.id]);
      onSaved(saved);
    } catch (err) {
      setError(bqErr(t, err, 'inventory.errorPrefix'));
    } finally {
      setBusy(false);
    }
  };

  const wearOpts = [
    { id: '', label: '—' },
    { id: 'like-new', label: t('inventory.wearLikeNew') },
    { id: 'very-good', label: t('inventory.wearVeryGood') },
    { id: 'good', label: t('inventory.wearGood') },
    { id: 'acceptable', label: t('inventory.wearAcceptable') },
  ];

  return (
    <Modal title={item ? t('inventory.editItem') : t('inventory.newItem')} onClose={onClose} wide>
      <div className="space-y-3">
        <div>
          <label className={labelCls}>{t('inventory.kind')}</label>
          <Seg
            options={[
              { id: 'book', label: t('inventory.kindBook') },
              { id: 'item', label: t('inventory.kindGeneral') },
            ]}
            value={form.kind}
            onChange={(v) => set('kind', v)}
          />
        </div>
        <div>
          <label className={labelCls}>{t('inventory.titleField')}</label>
          <input
            value={form.title} onChange={(e) => set('title', e.target.value)}
            placeholder={form.kind === 'book' ? t('inventory.titlePhBook') : t('inventory.titlePhGeneral')}
            autoFocus className={inputCls}
          />
        </div>
        {form.kind === 'book' && (
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>{t('inventory.author')}</label>
              <input value={form.author} onChange={(e) => set('author', e.target.value)} placeholder={t('inventory.authorPh')} className={inputCls} />
            </div>
            <div>
              <label className={labelCls}>{t('inventory.isbn')}</label>
              <input
                value={form.isbn}
                onChange={(e) => set('isbn', e.target.value)}
                onBlur={(e) => set('isbn', e.target.value.replace(/[\s-]/g, ''))}
                placeholder="978…" inputMode="numeric" className={inputCls}
              />
            </div>
          </div>
        )}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={labelCls}>{t('inventory.category')}</label>
            <input value={form.category} onChange={(e) => set('category', e.target.value)} className={inputCls} />
          </div>
          <div>
            <label className={labelCls}>{t('inventory.location')}</label>
            <input value={form.shelf} onChange={(e) => set('shelf', e.target.value)} placeholder={t('inventory.locationPh')} className={inputCls} />
          </div>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <div>
            <label className={labelCls}>{t('inventory.condition')}</label>
            <Seg
              options={[
                { id: false, label: t('inventory.condUsed') },
                { id: true, label: t('inventory.condNew') },
              ]}
              value={form.isNew}
              onChange={(v) => set('isNew', v)}
            />
          </div>
          <div>
            <label className={labelCls}>{t('inventory.wear')}</label>
            <select value={form.condition || ''} onChange={(e) => set('condition', e.target.value)} className={inputCls}>
              {wearOpts.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
            </select>
          </div>
          <div>
            <label className={labelCls}>{t('inventory.source')}</label>
            <select value={form.source} onChange={(e) => set('source', e.target.value)} className={inputCls}>
              <option value="donation">{t('inventory.srcDonation')}</option>
              <option value="purchase">{t('inventory.srcPurchase')}</option>
              <option value="supplier">{t('inventory.srcSupplier')}</option>
            </select>
          </div>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <div>
            <label className={labelCls}>{t('inventory.qty')}</label>
            <input type="number" min="0" inputMode="numeric" value={form.qty} onChange={(e) => set('qty', e.target.value)} className={inputCls} />
          </div>
          <div>
            <label className={labelCls}>{t('inventory.price')}</label>
            <input type="number" min="0" step="0.01" inputMode="decimal" value={form.price} onChange={(e) => set('price', e.target.value)} className={inputCls} />
          </div>
          <div>
            <label className={labelCls}>{t('inventory.status')}</label>
            <select value={form.status} onChange={(e) => set('status', e.target.value)} className={inputCls}>
              <option value="sorting">{t('inventory.stTriage')}</option>
              <option value="store">{t('inventory.stStock')}</option>
              <option value="fair">{t('inventory.stFair')}</option>
              <option value="sold">{t('inventory.stSold')}</option>
              <option value="donated">{t('inventory.stDonated')}</option>
              <option value="recycled">{t('inventory.stRecycled')}</option>
            </select>
          </div>
        </div>
        {form.kind === 'book' && (
          <div className="grid grid-cols-2 gap-3 rounded-os border border-osborder p-3">
            <p className="col-span-2 text-xs font-semibold text-muted">{t('inventory.abebooks')}</p>
            <div>
              <label className={labelCls}>{t('inventory.abRef')}</label>
              <input value={form.abeRef} onChange={(e) => set('abeRef', e.target.value)} className={inputCls} />
            </div>
            <div>
              <label className={labelCls}>{t('inventory.status')}</label>
              <select value={form.abeStatus || ''} onChange={(e) => set('abeStatus', e.target.value)} className={inputCls}>
                <option value="">{t('inventory.abNone')}</option>
                <option value="prep">{t('inventory.abPrep')}</option>
                <option value="listed">{t('inventory.abListed')}</option>
                <option value="sold">{t('inventory.abSold')}</option>
              </select>
            </div>
          </div>
        )}
        <div>
          <label className={labelCls}>{t('inventory.notes')}</label>
          <textarea value={form.notes} onChange={(e) => set('notes', e.target.value)} rows={2} className={inputCls} />
        </div>

        {dupes && (
          <div className="rounded-os border border-amber-500/40 bg-amber-500/10 p-3">
            <p className="flex items-center gap-1.5 text-xs font-semibold text-amber-700">
              <AlertCircle size={13} /> {t('inventory.duplicate')} — {t('inventory.duplicateHint')}
            </p>
            <ul className="mt-1.5 space-y-1">
              {dupes.slice(0, 5).map((d) => (
                <li key={d.id} className="text-xs text-ink">
                  <span className="font-medium">{d.title}</span>
                  {d.author && <span className="text-muted"> — {d.author}</span>}
                  {d.isbn && <span className="ml-1 text-muted">[{d.isbn}]</span>}
                </li>
              ))}
            </ul>
            <div className="mt-2.5 flex gap-2">
              <button type="button" onClick={() => { setDupes(null); }} className={btnGhost}>
                {t('common.cancel')}
              </button>
              <button
                type="button" disabled={busy}
                onClick={() => { setDupes(null); save(true); }}
                className="rounded-os bg-amber-500/20 px-3 py-1.5 text-xs font-semibold text-amber-700 hover:bg-amber-500/30 disabled:opacity-50"
              >
                {t('inventory.dupSaveAnyway')}
              </button>
            </div>
          </div>
        )}

        <ErrorNote message={error} />
        <div className="flex gap-2">
          <button type="button" onClick={onClose} className={`${btnGhost} flex-1 px-4 py-2 text-sm`}>
            {t('common.cancel')}
          </button>
          <button type="button" onClick={() => save(false)} disabled={busy || !form.title.trim()} className={`${btnPrimary} flex-1`}>
            {busy ? t('common.working') : t('common.save')}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function CsvImportModal({ onClose, onImported }) {
  const { t } = useLang();
  const [preview, setPreview] = useState(null); // { rows, errors }
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const fileRef = useRef(null);
  const importLock = useRef(false); // synchronous double-submit lock: double-click must not import twice

  const pick = () => fileRef.current?.click();
  const onFile = (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    const rd = new FileReader();
    rd.onload = () => {
      try {
        setPreview(bq().parseCsv(String(rd.result || '')));
      } catch (err) {
        setError(t('inventory.importFail'));
      }
    };
    rd.onerror = () => setError(t('inventory.importFail'));
    rd.readAsText(f, 'utf-8');
  };

  const doImport = async () => {
    if (!preview || preview.rows.length === 0) return;
    if (importLock.current) return; // block rapid double-click double import
    importLock.current = true;
    setBusy(true);
    setError('');
    try {
      const r = await bq().importCsvRows(preview.rows);
      // Show skipped duplicates if any were filtered out
      const msg = r.skipped > 0
        ? t('inventory.importDoneSkipped', { n: r.inserted, s: r.skipped })
        : t('inventory.importDone', { n: r.inserted });
      onImported(msg);
    } catch (err) {
      setError(err.message || t('inventory.importFail'));
    } finally {
      importLock.current = false;
      setBusy(false);
    }
  };

  return (
    <Modal title={t('inventory.importPreview')} onClose={onClose} wide>
      <input ref={fileRef} type="file" accept=".csv,text/csv" className="hidden" onChange={onFile} />
      {!preview ? (
        <div className="space-y-3">
          <p className="text-xs text-muted">{t('inventory.ioHint')}</p>
          <button type="button" onClick={pick} className={btnPrimary}>
            {t('inventory.dropHint')}
          </button>
          <ErrorNote message={error} />
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-ink">{t('inventory.rowsReady', { n: preview.rows.length })}</p>
          {preview.rows.length > 0 && (
            <ul className="max-h-48 space-y-1 overflow-y-auto rounded-os bg-surface p-2">
              {preview.rows.slice(0, 50).map((r, i) => (
                <li key={i} className="text-xs text-ink">
                  <span className="font-medium">{r.title}</span>
                  {r.author && <span className="text-muted"> — {r.author}</span>}
                </li>
              ))}
              {preview.rows.length > 50 && <li className="text-xs text-muted">…</li>}
            </ul>
          )}
          {preview.errors.length > 0 && (
            <div className="rounded-os border border-red-500/30 bg-red-500/10 p-2">
              <p className="text-xs font-semibold text-red-600">{t('inventory.importErrorsTitle')}</p>
              <ul className="mt-1 max-h-24 space-y-0.5 overflow-y-auto">
                {preview.errors.map((e, i) => <li key={i} className="text-xs text-red-600">{e}</li>)}
              </ul>
            </div>
          )}
          {preview.rows.length === 0 && <p className="text-xs text-muted">{t('inventory.noValidRows')}</p>}
          <ErrorNote message={error} />
          <div className="flex gap-2">
            <button type="button" onClick={() => setPreview(null)} className={`${btnGhost} flex-1 px-4 py-2 text-sm`}>
              {t('common.cancel')}
            </button>
            <button
              type="button" onClick={doImport} disabled={busy || preview.rows.length === 0}
              className={`${btnPrimary} flex-1`}
            >
              {busy ? t('common.working') : t('inventory.confirmImport')}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}

function CatalogTab() {
  const { canDelete } = useBqPerms();
  const { t } = useLang();
  const [items, setItems] = useState([]);
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [kind, setKind] = useState('');
  const [status, setStatus] = useState('');
  const [source, setSource] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(undefined); // undefined=closed, null=new, item=edit
  const [showImport, setShowImport] = useState(false);
  const [notice, setNotice] = useState('');
  const [pendingDelete, setPendingDelete] = useState(null);

  useEffect(() => {
    const id = setTimeout(() => setDebounced(query), 300);
    return () => clearTimeout(id);
  }, [query]);

  const load = useCallback(async () => {
    setError('');
    try {
      const list = await bq().listItems({
        query: debounced || undefined,
        kind: kind || undefined,
        status: status || undefined,
        source: source || undefined,
      });
      setItems(list);
    } catch (err) {
      setError(bqErr(t, err, 'inventory.errorPrefix'));
    } finally {
      setLoading(false);
    }
  }, [debounced, kind, status, source, t]);

  useEffect(() => { load(); }, [load]);

  const remove = async (it) => {
    setPendingDelete(it);
  };

  const confirmRemove = async () => {
    const it = pendingDelete;
    setPendingDelete(null);
    if (!it) return;
    try {
      await bq().deleteItem(it.id);
      load();
    } catch (err) {
      setError(bqErr(t, err, 'inventory.errorPrefix'));
    }
  };

  const doExport = async () => {
    try {
      const csv = await bq().exportCsv();
      const blob = new Blob(["\uFEFF" + csv], { type: 'text/csv;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `bouquinerie-catalogue-${todayYMD()}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    } catch (err) {
      setError(bqErr(t, err, 'inventory.errorPrefix'));
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 rounded-os border border-osborder bg-paper p-3">
        <div className="relative min-w-44 flex-1">
          <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input
            value={query} onChange={(e) => setQuery(e.target.value)}
            placeholder={t('inventory.searchPh')}
            className={inputCls + ' pl-9'}
          />
        </div>
        <select value={kind} onChange={(e) => setKind(e.target.value)} className={inputCls + ' w-auto'} aria-label={t('inventory.kind')}>
          <option value="">{t('common.all')} · {t('inventory.kind')}</option>
          <option value="book">{t('inventory.kindBook')}</option>
          <option value="item">{t('inventory.kindGeneral')}</option>
        </select>
        <select value={status} onChange={(e) => setStatus(e.target.value)} className={inputCls + ' w-auto'} aria-label={t('inventory.status')}>
          <option value="">{t('common.all')} · {t('inventory.status')}</option>
          <option value="store">{t('inventory.stStock')}</option>
          <option value="sorting">{t('inventory.stTriage')}</option>
          <option value="fair">{t('inventory.stFair')}</option>
          <option value="sold">{t('inventory.stSold')}</option>
          <option value="donated">{t('inventory.stDonated')}</option>
          <option value="recycled">{t('inventory.stRecycled')}</option>
        </select>
        <select value={source} onChange={(e) => setSource(e.target.value)} className={inputCls + ' w-auto'} aria-label={t('inventory.source')}>
          <option value="">{t('common.all')} · {t('inventory.source')}</option>
          <option value="donation">{t('inventory.srcDonation')}</option>
          <option value="purchase">{t('inventory.srcPurchase')}</option>
          <option value="supplier">{t('inventory.srcSupplier')}</option>
        </select>
        <button type="button" onClick={() => setEditing(null)} className={`${btnPrimary} flex items-center gap-1.5`}>
          <Plus size={14} /> {t('common.add')}
        </button>
        <button type="button" onClick={doExport} className={`${btnGhost} flex items-center gap-1.5`}>
          <Download size={13} /> {t('inventory.exportCsv')}
        </button>
        <button type="button" onClick={() => setShowImport(true)} className={`${btnGhost} flex items-center gap-1.5`}>
          <Upload size={13} /> {t('inventory.importCsv')}
        </button>
      </div>

      <ErrorNote message={error} />
      {notice && (
        <p className="flex items-center gap-1.5 rounded-os border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-700">
          <Check size={14} /> {notice}
        </p>
      )}

      {loading ? (
        <p className="py-8 text-center text-sm text-muted">{t('common.loading')}</p>
      ) : items.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted">{t('inventory.noItems')}</p>
      ) : (
        <ul className="divide-y divide-osborder rounded-os border border-osborder bg-paper">
          {items.map((it) => (
            <li key={it.id} className="flex items-center gap-3 px-3 py-2.5">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-os bg-surface text-muted">
                {it.kind === 'book' ? <BookOpen size={16} /> : <Package size={16} />}
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-ink">
                  {it.title}
                  {it.author && <span className="ml-1.5 font-normal text-muted">{it.author}</span>}
                </p>
                <p className="truncate text-xs text-muted">
                  {it.qty} × {fmtMoney(it.price)}
                  {it.shelf && <span className="ml-1.5">· {it.shelf}</span>}
                  {it.isbn && <span className="ml-1.5">· {it.isbn}</span>}
                </p>
              </div>
              <StatusBadge status={it.status} />
              <div className="flex shrink-0 gap-1">
                <button type="button" onClick={() => setEditing(it)} className="rounded-os p-1.5 text-muted hover:bg-surface hover:text-ink" aria-label={t('common.edit')}>
                  <Pencil size={14} />
                </button>
                {canDelete && (
                  <button type="button" onClick={() => remove(it)} className="rounded-os p-1.5 text-muted hover:bg-red-500/10 hover:text-red-600" aria-label={t('common.delete')}>
                    <Trash2 size={14} />
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {editing !== undefined && (
        <ItemModal
          item={editing}
          onClose={() => setEditing(undefined)}
          onSaved={() => { setEditing(undefined); setNotice(''); load(); }}
        />
      )}
      {showImport && (
        <CsvImportModal
          onClose={() => setShowImport(false)}
          onImported={(msg) => { setShowImport(false); setNotice(msg); load(); }}
        />
      )}
      {pendingDelete && (
        <ConfirmDeleteDialog
          title={t('inventory.deleteItem')}
          message={t('inventory.deleteItemMsg', { name: pendingDelete.title || pendingDelete.name || '' })}
          onConfirm={confirmRemove}
          onClose={() => setPendingDelete(null)}
        />
      )}
    </div>
  );
}

/* ------------------------------ donations ------------------------------ */

function DonationModal({ onClose, onSaved }) {
  const { t } = useLang();
  const [form, setForm] = useState({ donorName: '', receivedAt: todayYMD(), itemCount: '', notes: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const save = async () => {
    setBusy(true);
    setError('');
    try {
      const saved = await bq().saveDonation({
        donorName: form.donorName,
        receivedAt: form.receivedAt,
        itemCount: form.itemCount === '' ? null : Number(form.itemCount),
        notes: form.notes,
        state: 'received',
      });
      onSaved(saved);
    } catch (err) {
      setError(bqErr(t, err, 'inventory.errorPrefix'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={t('inventory.newDonation')} onClose={onClose}>
      <div className="space-y-3">
        <div>
          <label className={labelCls}>{t('inventory.donor')}</label>
          <input value={form.donorName} onChange={(e) => set('donorName', e.target.value)} placeholder={t('inventory.donorPh')} autoFocus className={inputCls} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={labelCls}>{t('inventory.receivedOn')}</label>
            <input type="date" value={form.receivedAt} onChange={(e) => set('receivedAt', e.target.value)} className={inputCls} />
          </div>
          <div>
            <label className={labelCls}>{t('inventory.itemCount')}</label>
            <input type="number" min="0" inputMode="numeric" value={form.itemCount} onChange={(e) => set('itemCount', e.target.value)} className={inputCls} />
          </div>
        </div>
        <div>
          <label className={labelCls}>{t('inventory.notes')}</label>
          <textarea value={form.notes} onChange={(e) => set('notes', e.target.value)} rows={2} className={inputCls} />
        </div>
        <ErrorNote message={error} />
        <button type="button" onClick={save} disabled={busy} className={`${btnPrimary} w-full py-2.5`}>
          {busy ? t('common.working') : t('common.save')}
        </button>
      </div>
    </Modal>
  );
}

function DonationsTab() {
  const { canDelete } = useBqPerms();
  const { t } = useLang();
  const [donations, setDonations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showNew, setShowNew] = useState(false);
  const [openId, setOpenId] = useState(null);
  const [linked, setLinked] = useState({}); // donationId -> items
  const [addFor, setAddFor] = useState(null); // donation row -> ItemModal
  const [pendingDelete, setPendingDelete] = useState(null);

  const load = useCallback(async () => {
    setError('');
    try {
      setDonations(await bq().listDonations());
    } catch (err) {
      setError(bqErr(t, err, 'inventory.errorPrefix'));
    } finally {
      setLoading(false);
    }
  }, [t]);
  useEffect(() => { load(); }, [load]);

  const toggle = async (d) => {
    if (openId === d.id) { setOpenId(null); return; }
    setOpenId(d.id);
    try {
      const items = await bq().donationItems(d.id);
      setLinked((m) => ({ ...m, [d.id]: items }));
    } catch (err) {
      setError(bqErr(t, err, 'inventory.errorPrefix'));
    }
  };

  const markSorted = async (d) => {
    try {
      await bq().saveDonation({ ...d, state: 'sorted' });
      load();
    } catch (err) {
      setError(bqErr(t, err, 'inventory.errorPrefix'));
    }
  };

  const remove = async (d) => {
    setPendingDelete(d);
  };

  const confirmRemove = async () => {
    const d = pendingDelete;
    setPendingDelete(null);
    if (!d) return;
    try {
      await bq().deleteDonation(d.id);
      load();
    } catch (err) {
      setError(bqErr(t, err, 'inventory.errorPrefix'));
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between rounded-os border border-osborder bg-paper p-3">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-ink">
          <HandHeart size={15} className="text-accent" /> {t('inventory.donationsTitle')}
        </h3>
        <button type="button" onClick={() => setShowNew(true)} className={`${btnPrimary} flex items-center gap-1.5`}>
          <Plus size={14} /> {t('inventory.newDonation')}
        </button>
      </div>
      <ErrorNote message={error} />
      {loading ? (
        <p className="py-8 text-center text-sm text-muted">{t('common.loading')}</p>
      ) : donations.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted">{t('inventory.noDonations')}</p>
      ) : (
        <ul className="space-y-2">
          {donations.map((d) => {
            const open = openId === d.id;
            const items = linked[d.id] || [];
            return (
              <li key={d.id} className="rounded-os border border-osborder bg-paper">
                <div className="flex items-center gap-3 px-3 py-2.5">
                  <button type="button" onClick={() => toggle(d)} className="min-w-0 flex-1 text-left">
                    <span className="flex items-center gap-1.5 text-sm font-medium text-ink">
                      <ChevronDown size={14} className={`shrink-0 text-muted transition-transform ${open ? '' : '-rotate-90'}`} />
                      <span className="truncate">{d.donorName || t('inventory.anonymous')}</span>
                    </span>
                    <span className="ml-5 block text-xs text-muted">
                      {fmtDate(d.receivedAt)}
                      {d.itemCount != null && d.itemCount !== '' && <span> · {d.itemCount} {t('inventory.itemCount').toLowerCase()}</span>}
                    </span>
                  </button>
                  <span className={`rounded-os px-2 py-0.5 text-[11px] font-medium ${
                    d.state === 'sorted' ? 'bg-emerald-500/15 text-emerald-700' : 'bg-amber-500/15 text-amber-700'
                  }`}>
                    {d.state === 'sorted' ? t('inventory.donSorted') : t('inventory.donReceived')}
                  </span>
                  {d.state !== 'sorted' && (
                    <button type="button" onClick={() => markSorted(d)} className={btnGhost}>
                      {t('inventory.triageDone')}
                    </button>
                  )}
                  {canDelete && (
                    <button
                      type="button" onClick={() => remove(d)}
                      className="rounded-os p-1.5 text-muted hover:bg-red-500/10 hover:text-red-600"
                      aria-label={t('common.delete')}
                    >
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>
                {open && (
                  <div className="border-t border-osborder px-3 py-2">
                    <div className="mb-2 flex items-center justify-between">
                      <p className="text-xs font-semibold text-muted">{t('inventory.batchItems')}</p>
                      <button type="button" onClick={() => setAddFor(d)} className={`${btnGhost} flex items-center gap-1`}>
                        <Plus size={12} /> {t('inventory.createItemForBatch')}
                      </button>
                    </div>
                    {items.length === 0 ? (
                      <p className="pb-2 text-xs text-muted">{t('inventory.noItems')}</p>
                    ) : (
                      <ul className="space-y-1 pb-1">
                        {items.map((it) => (
                          <li key={it.id} className="flex items-center justify-between gap-2 text-xs">
                            <span className="truncate text-ink">
                              <span className="font-medium">{it.title}</span>
                              {it.author && <span className="text-muted"> — {it.author}</span>}
                            </span>
                            <StatusBadge status={it.status} />
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {showNew && <DonationModal onClose={() => setShowNew(false)} onSaved={() => { setShowNew(false); load(); }} />}
      {addFor && (
        <ItemModal
          donationId={addFor.id}
          onClose={() => setAddFor(null)}
          onSaved={(saved) => {
            setAddFor(null);
            setLinked((m) => ({ ...m, [addFor.id]: [...(m[addFor.id] || []), saved] }));
          }}
        />
      )}
      {pendingDelete && (
        <ConfirmDeleteDialog
          title={t('inventory.deleteDonation')}
          message={t('inventory.deleteDonationMsg', { name: pendingDelete.donor || '' })}
          onConfirm={confirmRemove}
          onClose={() => setPendingDelete(null)}
        />
      )}
    </div>
  );
}

/* ------------------------------- sorting ------------------------------- */

function SortingTab({ refreshKey }) {
  const { t } = useLang();
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      setItems(await bq().listItems({ status: 'sorting' }));
    } catch (err) {
      setError(bqErr(t, err, 'inventory.errorPrefix'));
    } finally {
      setLoading(false);
    }
  }, [t]);
  useEffect(() => { load(); }, [load, refreshKey]);

  const route = async (it, status) => {
    try {
      await bq().saveItem({ ...it, status });
      setItems((xs) => xs.filter((x) => x.id !== it.id));
    } catch (err) {
      setError(bqErr(t, err, 'inventory.errorPrefix'));
    }
  };

  const routes = [
    { id: 'store', label: t('inventory.routeShop') },
    { id: 'fair', label: t('inventory.routeFair') },
    { id: 'donated', label: t('inventory.routeDonate') },
    { id: 'recycled', label: t('inventory.routeRecycle') },
  ];

  return (
    <div className="space-y-3">
      <div className="rounded-os border border-osborder bg-paper p-3">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-ink">
          <ArrowLeftRight size={15} className="text-accent" /> {t('inventory.triageTitle')}
        </h3>
        <p className="mt-0.5 text-xs text-muted">{t('inventory.triageHint')}</p>
      </div>
      <ErrorNote message={error} />
      {loading ? (
        <p className="py-8 text-center text-sm text-muted">{t('common.loading')}</p>
      ) : items.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted">{t('inventory.noTriage')}</p>
      ) : (
        <ul className="divide-y divide-osborder rounded-os border border-osborder bg-paper">
          {items.map((it) => (
            <li key={it.id} className="px-3 py-2.5">
              <p className="truncate text-sm font-medium text-ink">
                {it.title}
                {it.author && <span className="ml-1.5 font-normal text-muted">{it.author}</span>}
              </p>
              <p className="text-xs text-muted">
                {it.qty} × {fmtMoney(it.price)}
                {it.shelf && <span className="ml-1.5">· {it.shelf}</span>}
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <span className="text-[11px] font-medium text-muted">{t('inventory.route')} :</span>
                {routes.map((r) => (
                  <button key={r.id} type="button" onClick={() => route(it, r.id)} className={btnGhost}>
                    {r.label}
                  </button>
                ))}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* -------------------------------- fair -------------------------------- */

function FairModal({ onClose, onSaved }) {
  const { t } = useLang();
  const [form, setForm] = useState({ name: '', fairDate: todayYMD(), beneficiary: '', notes: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const save = async () => {
    setBusy(true);
    setError('');
    try {
      const saved = await bq().saveFair(form);
      onSaved(saved);
    } catch (err) {
      setError(bqErr(t, err, 'inventory.errorPrefix'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={t('inventory.newFairDay')} onClose={onClose}>
      <div className="space-y-3">
        <div>
          <label className={labelCls}>{t('inventory.fairNameLabel')}</label>
          <input value={form.name} onChange={(e) => set('name', e.target.value)} autoFocus className={inputCls} />
        </div>
        <div>
          <label className={labelCls}>{t('inventory.fairDate')}</label>
          <input type="date" value={form.fairDate} onChange={(e) => set('fairDate', e.target.value)} className={inputCls} />
        </div>
        <div>
          <label className={labelCls}>{t('inventory.beneficiary')}</label>
          <input value={form.beneficiary} onChange={(e) => set('beneficiary', e.target.value)} placeholder={t('inventory.beneficiaryPh')} className={inputCls} />
        </div>
        <div>
          <label className={labelCls}>{t('inventory.notes')}</label>
          <textarea value={form.notes} onChange={(e) => set('notes', e.target.value)} rows={2} className={inputCls} />
        </div>
        <ErrorNote message={error} />
        <button type="button" onClick={save} disabled={busy} className={`${btnPrimary} w-full py-2.5`}>
          {busy ? t('common.working') : t('common.save')}
        </button>
      </div>
    </Modal>
  );
}

function SaleModal({ fair, onClose, onSaved }) {
  const { t } = useLang();
  const [sellable, setSellable] = useState([]);
  const [itemId, setItemId] = useState('');
  const [title, setTitle] = useState('');
  const [qty, setQty] = useState(1);
  const [unitPrice, setUnitPrice] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const all = await bq().listItems({});
        if (!cancelled) setSellable(all.filter((i) => (i.status === 'store' || i.status === 'fair') && Number(i.qty) > 0));
      } catch {
        if (!cancelled) setSellable([]);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const pick = (id) => {
    setItemId(id);
    const it = sellable.find((i) => i.id === id);
    if (it) {
      setTitle(it.title);
      setUnitPrice(String(it.price ?? ''));
    }
  };

  const save = async () => {
    setError('');
    if (!title.trim()) {
      setError(t('inventory.saleItemRequired'));
      return;
    }
    setBusy(true);
    try {
      await bq().recordFairSale(fair.id, {
        itemId: itemId || null,
        title: title.trim(),
        qty: Math.max(1, Number(qty) || 1),
        unitPrice: Number(unitPrice) || 0,
      });
      onSaved();
    } catch (err) {
      setError(bqErr(t, err, 'inventory.errorPrefix'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={t('inventory.saleTitle')} onClose={onClose}>
      <div className="space-y-3">
        <div>
          <label className={labelCls}>{t('inventory.saleChooseItem')}</label>
          <select value={itemId} onChange={(e) => pick(e.target.value)} className={inputCls}>
            <option value="">— {t('inventory.saleCustom')} —</option>
            {sellable.map((i) => (
              <option key={i.id} value={i.id}>
                {i.title} ({i.qty} × {fmtMoney(i.price)})
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={labelCls}>{t('inventory.titleField')}</label>
          <input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus className={inputCls} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={labelCls}>{t('common.quantity')}</label>
            <input type="number" min="1" inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value)} className={inputCls} />
          </div>
          <div>
            <label className={labelCls}>{t('common.price')}</label>
            <input type="number" min="0" step="0.01" inputMode="decimal" value={unitPrice} onChange={(e) => setUnitPrice(e.target.value)} className={inputCls} />
          </div>
        </div>
        <ErrorNote message={error} />
        <div className="flex items-center justify-between rounded-os bg-surface px-3 py-2">
          <span className="text-xs text-muted">{t('common.total')}</span>
          <span className="text-sm font-semibold text-ink">{fmtMoney((Number(qty) || 0) * (Number(unitPrice) || 0))}</span>
        </div>
        <button type="button" onClick={save} disabled={busy} className={`${btnPrimary} w-full py-2.5`}>
          {busy ? t('common.working') : t('common.save')}
        </button>
      </div>
    </Modal>
  );
}

function FairTab() {
  const { canDelete } = useBqPerms();
  const { t } = useLang();
  const [fairs, setFairs] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [sales, setSales] = useState([]);
  const [totals, setTotals] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showNew, setShowNew] = useState(false);
  const [showSale, setShowSale] = useState(false);
  const [pendingDelete, setPendingDelete] = useState(null);

  const loadFairs = useCallback(async () => {
    setError('');
    try {
      const list = await bq().listFairs();
      setFairs(list);
      if (list.length > 0 && !selectedId) setSelectedId(list[0].id);
      if (list.length === 0) { setSelectedId(null); setSales([]); setTotals(null); }
    } catch (err) {
      setError(bqErr(t, err, 'inventory.errorPrefix'));
    } finally {
      setLoading(false);
    }
  }, [t]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { loadFairs(); }, [loadFairs]);

  const loadDetail = useCallback(async (fairId) => {
    if (!fairId) return;
    try {
      const [s, tot] = await Promise.all([bq().listFairSales(fairId), bq().fairTotals(fairId)]);
      setSales(s);
      setTotals(tot);
    } catch (err) {
      setError(bqErr(t, err, 'inventory.errorPrefix'));
    }
  }, [t]);
  useEffect(() => { loadDetail(selectedId); }, [selectedId, loadDetail]);

  const selected = fairs.find((f) => f.id === selectedId);

  const remove = async (f) => {
    setPendingDelete(f);
  };

  const confirmRemove = async () => {
    const f = pendingDelete;
    setPendingDelete(null);
    if (!f) return;
    try {
      await bq().deleteFair(f.id);
      if (selectedId === f.id) { setSelectedId(null); setSales([]); setTotals(null); }
      loadFairs();
    } catch (err) {
      setError(bqErr(t, err, 'inventory.errorPrefix'));
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between rounded-os border border-osborder bg-paper p-3">
        <div>
          <h3 className="flex items-center gap-2 text-sm font-semibold text-ink">
            <Tent size={15} className="text-accent" /> {t('inventory.fairTitle')}
          </h3>
          <p className="mt-0.5 text-xs text-muted">{t('inventory.fairHint')}</p>
        </div>
        <button type="button" onClick={() => setShowNew(true)} className={`${btnPrimary} flex shrink-0 items-center gap-1.5`}>
          <Plus size={14} /> {t('inventory.newFairDay')}
        </button>
      </div>
      <ErrorNote message={error} />
      {loading ? (
        <p className="py-8 text-center text-sm text-muted">{t('common.loading')}</p>
      ) : fairs.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted">{t('inventory.noFairs')}</p>
      ) : (
        <div className="grid gap-3 md:grid-cols-[220px_1fr]">
          <ul className="space-y-1.5">
            {fairs.map((f) => (
              <li key={f.id}>
                <div className={`flex items-center gap-1 rounded-os border px-2.5 py-2 ${
                  f.id === selectedId ? 'border-accent bg-surface' : 'border-osborder bg-paper'
                }`}>
                  <button type="button" onClick={() => setSelectedId(f.id)} className="min-w-0 flex-1 text-left">
                    <p className="truncate text-sm font-medium text-ink">{f.name || fmtDate(f.fairDate)}</p>
                    <p className="text-xs text-muted">{fmtDate(f.fairDate)}</p>
                  </button>
                  {canDelete && (
                    <button
                      type="button" onClick={() => remove(f)}
                      className="rounded-os p-1 text-muted hover:bg-red-500/10 hover:text-red-600"
                      aria-label={t('common.delete')}
                    >
                      <Trash2 size={13} />
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
          <div className="rounded-os border border-osborder bg-paper p-3">
            {selected ? (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h4 className="text-sm font-semibold text-ink">{selected.name || fmtDate(selected.fairDate)}</h4>
                    <p className="text-xs text-muted">
                      {fmtDate(selected.fairDate)}
                      {selected.beneficiary && <span> · {t('inventory.beneficiary')}: {selected.beneficiary}</span>}
                    </p>
                  </div>
                  <button type="button" onClick={() => setShowSale(true)} className={`${btnPrimary} flex items-center gap-1.5`}>
                    <ShoppingBag size={14} /> {t('inventory.saleTitle')}
                  </button>
                </div>
                {totals && (
                  <div className="grid grid-cols-2 gap-2">
                    <div className="rounded-os bg-surface px-3 py-2">
                      <p className="text-[11px] text-muted">{t('inventory.itemsSold')}</p>
                      <p className="text-lg font-semibold text-ink">{totals.itemsSold}</p>
                    </div>
                    <div className="rounded-os bg-surface px-3 py-2">
                      <p className="text-[11px] text-muted">{t('inventory.revenue')}</p>
                      <p className="text-lg font-semibold text-ink">{fmtMoney(totals.revenue)}</p>
                    </div>
                  </div>
                )}
                <h5 className="text-xs font-semibold text-muted">{t('inventory.salesTitle')}</h5>
                {sales.length === 0 ? (
                  <p className="py-3 text-center text-xs text-muted">{t('inventory.noSales')}</p>
                ) : (
                  <ul className="divide-y divide-osborder">
                    {sales.map((s) => (
                      <li key={s.id} className="flex items-center justify-between gap-2 py-1.5 text-xs">
                        <span className="min-w-0 flex-1 truncate text-ink">
                          <span className="font-medium">{s.title}</span>
                          <span className="ml-1.5 text-muted">{s.qty} × {fmtMoney(s.unitPrice)}</span>
                        </span>
                        <span className="font-semibold text-ink">{fmtMoney((Number(s.qty) || 0) * (Number(s.unitPrice) || 0))}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ) : (
              <p className="py-8 text-center text-xs text-muted">{t('inventory.selectFairHint')}</p>
            )}
          </div>
        </div>
      )}
      {showNew && <FairModal onClose={() => setShowNew(false)} onSaved={(f) => { setShowNew(false); setSelectedId(f.id); loadFairs(); }} />}
      {showSale && selected && (
        <SaleModal
          fair={selected}
          onClose={() => setShowSale(false)}
          onSaved={() => { setShowSale(false); loadDetail(selectedId); }}
        />
      )}
      {pendingDelete && (
        <ConfirmDeleteDialog
          title={t('inventory.deleteFair')}
          message={t('inventory.deleteFairMsg', { name: pendingDelete.label || pendingDelete.date || '' })}
          onConfirm={confirmRemove}
          onClose={() => setPendingDelete(null)}
        />
      )}
    </div>
  );
}

/* -------------------------------- orders ------------------------------- */

const ORDER_FLOW = ['requested', 'ordered', 'received'];

function OrderModal({ order, onClose, onSaved }) {
  const { t } = useLang();
  const [form, setForm] = useState(order ? { ...order } : {
    customerName: '', customerPhone: '', title: '', author: '', notes: '', status: 'requested',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const save = async () => {
    setBusy(true);
    setError('');
    try {
      const saved = await bq().saveOrder(form);
      onSaved(saved);
    } catch (err) {
      setError(bqErr(t, err, 'inventory.errorPrefix'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={order ? t('inventory.editOrder') : t('inventory.newOrder')} onClose={onClose}>
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={labelCls}>{t('common.customer')}</label>
            <input value={form.customerName} onChange={(e) => set('customerName', e.target.value)} placeholder={t('inventory.customerPh')} autoFocus className={inputCls} />
          </div>
          <div>
            <label className={labelCls}>{t('common.phone')}</label>
            <input value={form.customerPhone} onChange={(e) => set('customerPhone', e.target.value)} placeholder={t('inventory.phonePh')} className={inputCls} />
          </div>
        </div>
        <div>
          <label className={labelCls}>{t('inventory.wantedTitle')}</label>
          <input value={form.title} onChange={(e) => set('title', e.target.value)} className={inputCls} />
        </div>
        <div>
          <label className={labelCls}>{t('inventory.author')}</label>
          <input value={form.author} onChange={(e) => set('author', e.target.value)} className={inputCls} />
        </div>
        <div>
          <label className={labelCls}>{t('inventory.notes')}</label>
          <textarea value={form.notes} onChange={(e) => set('notes', e.target.value)} rows={2} className={inputCls} />
        </div>
        <ErrorNote message={error} />
        <button type="button" onClick={save} disabled={busy || !form.title.trim()} className={`${btnPrimary} w-full py-2.5`}>
          {busy ? t('common.working') : t('common.save')}
        </button>
      </div>
    </Modal>
  );
}

function OrdersTab() {
  const { canDelete } = useBqPerms();
  const { t } = useLang();
  const [orders, setOrders] = useState([]);
  const [filter, setFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(undefined);
  const [pendingDelete, setPendingDelete] = useState(null);

  const load = useCallback(async () => {
    setError('');
    try {
      setOrders(await bq().listOrders({ status: filter || undefined }));
    } catch (err) {
      setError(bqErr(t, err, 'inventory.errorPrefix'));
    } finally {
      setLoading(false);
    }
  }, [filter, t]);
  useEffect(() => { load(); }, [load]);

  const osLabel = (s) => ({
    requested: t('inventory.osRequested'),
    ordered: t('inventory.osOrdered'),
    received: t('inventory.osReceived'),
    cancelled: t('inventory.osCancelled'),
  }[s] || s);

  const advance = async (o) => {
    const next = ORDER_FLOW[ORDER_FLOW.indexOf(o.status) + 1];
    if (!next) return;
    try {
      await bq().saveOrder({ ...o, status: next });
      load();
    } catch (err) {
      setError(bqErr(t, err, 'inventory.errorPrefix'));
    }
  };

  const cancelOrder = async (o) => {
    try {
      await bq().saveOrder({ ...o, status: 'cancelled' });
      load();
    } catch (err) {
      setError(bqErr(t, err, 'inventory.errorPrefix'));
    }
  };

  const remove = async (o) => {
    setPendingDelete(o);
  };

  const confirmRemove = async () => {
    const o = pendingDelete;
    setPendingDelete(null);
    if (!o) return;
    try {
      await bq().deleteOrder(o.id);
      load();
    } catch (err) {
      setError(bqErr(t, err, 'inventory.errorPrefix'));
    }
  };

  const chips = [
    { id: '', label: t('common.all') },
    { id: 'requested', label: t('inventory.osRequested') },
    { id: 'ordered', label: t('inventory.osOrdered') },
    { id: 'received', label: t('inventory.osReceived') },
    { id: 'cancelled', label: t('inventory.osCancelled') },
  ];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 rounded-os border border-osborder bg-paper p-3">
        <h3 className="mr-auto flex items-center gap-2 text-sm font-semibold text-ink">
          <ClipboardList size={15} className="text-accent" /> {t('inventory.ordersTitle')}
        </h3>
        <Seg options={chips} value={filter} onChange={setFilter} />
        <button type="button" onClick={() => setEditing(null)} className={`${btnPrimary} flex items-center gap-1.5`}>
          <Plus size={14} /> {t('inventory.newOrder')}
        </button>
      </div>
      <ErrorNote message={error} />
      {loading ? (
        <p className="py-8 text-center text-sm text-muted">{t('common.loading')}</p>
      ) : orders.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted">{t('inventory.noOrders')}</p>
      ) : (
        <ul className="divide-y divide-osborder rounded-os border border-osborder bg-paper">
          {orders.map((o) => (
            <li key={o.id} className="flex items-center gap-3 px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-ink">
                  {o.title}
                  {o.author && <span className="ml-1.5 font-normal text-muted">{o.author}</span>}
                </p>
                <p className="truncate text-xs text-muted">
                  {o.customerName}
                  {o.customerPhone && <span className="ml-1.5">· {o.customerPhone}</span>}
                </p>
              </div>
              <span className={`rounded-os px-2 py-0.5 text-[11px] font-medium ${
                o.status === 'received' ? 'bg-emerald-500/15 text-emerald-700'
                : o.status === 'cancelled' ? 'bg-red-500/10 text-red-600'
                : 'bg-amber-500/15 text-amber-700'
              }`}>
                {osLabel(o.status)}
              </span>
              <div className="flex shrink-0 items-center gap-1">
                {ORDER_FLOW.includes(o.status) && ORDER_FLOW.indexOf(o.status) < ORDER_FLOW.length - 1 && (
                  <button type="button" onClick={() => advance(o)} className={btnGhost} title={t('inventory.advance')}>
                    <Check size={13} /> {t('inventory.advance')}
                  </button>
                )}
                {o.status !== 'cancelled' && o.status !== 'received' && (
                  <button type="button" onClick={() => cancelOrder(o)} className={btnGhost}>
                    {t('inventory.cancelOrder')}
                  </button>
                )}
                <button type="button" onClick={() => setEditing(o)} className="rounded-os p-1.5 text-muted hover:bg-surface hover:text-ink" aria-label={t('common.edit')}>
                  <Pencil size={14} />
                </button>
                {canDelete && (
                  <button type="button" onClick={() => remove(o)} className="rounded-os p-1.5 text-muted hover:bg-red-500/10 hover:text-red-600" aria-label={t('common.delete')}>
                    <Trash2 size={14} />
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {editing !== undefined && (
        <OrderModal
          order={editing}
          onClose={() => setEditing(undefined)}
          onSaved={() => { setEditing(undefined); load(); }}
        />
      )}
      {pendingDelete && (
        <ConfirmDeleteDialog
          title={t('inventory.deleteOrder')}
          message={t('inventory.deleteOrderMsg', { name: pendingDelete.customer || '' })}
          onConfirm={confirmRemove}
          onClose={() => setPendingDelete(null)}
        />
      )}
    </div>
  );
}

/* --------------------------------- app --------------------------------- */

// Map coded backend errors to localized messages; fall back to raw message.
function bqErr(t, err, fallbackKey) {
  const code = err && err.code;
  if (code === 'bq_customer_required') return t('inventory.errCustomerRequired');
  if (code === 'bq_title_required') return t('inventory.errTitleRequired');
  if (code === 'bq_no_shop') return t('inventory.errNoShop');
  if (code === 'bq_not_member') return t('inventory.errNotMember');
  if (code === 'bq_not_found') return t('inventory.errNotFound');
  if (code === '42501' || /row-level security|permission denied/i.test(err?.message || '')) {
    return t('inventory.errDeleteManagerOnly');
  }
  return (err && err.message) || t(fallbackKey || 'inventory.errorPrefix');
}

export default function BouquinerieApp() {
  const { t } = useLang();
  const [tab, setTab] = useState('catalog');
  const [supported, setSupported] = useState(true);
  const [sortKey, setSortKey] = useState(0);
  // Shop membership (migration 016): 'loading' | 'ready' | 'none'
  const [shopState, setShopState] = useState('loading');
  const [shopRole, setShopRole] = useState(null);
  const [shopName, setShopName] = useState('');
  const [shops, setShops] = useState([]); // all my shops (for the switcher)
  const [activeShopId, setActiveShopId] = useState(null);
  const [shopKey, setShopKey] = useState(0); // bump to reload every tab on switch
  const [joinCode, setJoinCode] = useState('');
  const [joinBusy, setJoinBusy] = useState(false);
  const [joinError, setJoinError] = useState('');

  const resolveShop = useCallback(async () => {
    setShopState('loading');
    try {
      const [list, s] = await Promise.all([bq().myStores(), bq().myStore()]);
      if (s) {
        setShops(list.length ? list : [{ id: s.id, role: s.role, name: s.name }]);
        setActiveShopId(s.id);
        setShopRole(s.role);
        setShopName(s.name || '');
        setShopState('ready');
      } else {
        setShops([]);
        setActiveShopId(null);
        setShopState('none');
      }
    } catch {
      // Don't pretend "no shop" when the load itself failed — show the error
      // with a retry instead of a misleading join-code screen.
      setShopState('error');
    }
  }, []);

  useEffect(() => {
    setSupported(!!backend.bouquinerie);
  }, []);
  useEffect(() => { resolveShop(); }, [resolveShop]);

  const doJoin = async () => {
    const code = joinCode.trim();
    if (!code) return;
    setJoinBusy(true);
    setJoinError('');
    try {
      const storeId = await backend.pos.joinStore(code);
      setJoinCode('');
      if (storeId) await bq().setActiveStore(storeId).catch(() => bq().refreshStore());
      else await bq().refreshStore();
      await resolveShop();
    } catch (err) {
      setJoinError(err.message || t('inventory.noShop.joinFailed'));
    } finally {
      setJoinBusy(false);
    }
  };

  const doSwitchShop = async (id) => {
    if (!id || id === activeShopId) return;
    try {
      await bq().setActiveStore(id);
      setShopKey((k) => k + 1); // remount tabs so every list reloads in the new shop
      await resolveShop();
    } catch (err) {
      setJoinError(err.message || t('inventory.noShop.joinFailed'));
    }
  };

  const TABS = [
    { id: 'catalog', label: t('inventory.tabs.catalog'), icon: LibraryBig },
    { id: 'donations', label: t('inventory.tabs.donations'), icon: HandHeart },
    { id: 'sorting', label: t('inventory.tabs.triage'), icon: ArrowLeftRight },
    { id: 'fair', label: t('inventory.tabs.fair'), icon: Tent },
    { id: 'orders', label: t('inventory.tabs.orders'), icon: ClipboardList },
  ];

  if (!supported) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="max-w-sm text-center">
          <LibraryBig size={28} className="mx-auto text-muted" />
          <p className="mt-2 text-sm font-medium text-ink">{t('inventory.title')}</p>
          <p className="mt-1 text-xs text-muted">{t('inventory.backendUnsupported')}</p>
        </div>
      </div>
    );
  }

  if (shopState === 'loading') {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <p className="text-sm text-muted">{t('common.loading')}</p>
      </div>
    );
  }

  // The shop list failed to load (network/backend error). Show it plainly
  // with a retry — never pretend the user has no shop.
  if (shopState === 'error') {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="w-full max-w-sm rounded-os border border-osborder bg-paper p-6 text-center">
          <p className="text-sm font-semibold text-ink">{t('common.loadFailed')}</p>
          <p className="mt-1 text-xs text-muted">{t('common.loadFailedHint')}</p>
          <button
            type="button"
            onClick={resolveShop}
            className="mt-4 rounded-os bg-accent px-4 py-2 text-sm font-medium text-white"
          >
            {t('common.retry')}
          </button>
        </div>
      </div>
    );
  }

  // Signed in, but no shop has claimed this account yet. The owner creates
  // an invite code in the POS app; the code joins this device to the shop.
  if (shopState === 'none') {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="w-full max-w-sm rounded-os border border-osborder bg-paper p-6 text-center">
          <Store size={28} className="mx-auto text-accent" />
          <p className="mt-3 text-sm font-semibold text-ink">{t('inventory.noShop.title')}</p>
          <p className="mt-1 text-xs text-muted">{t('inventory.noShop.hint')}</p>
          <div className="mt-4 flex gap-2">
            <div className="relative flex-1">
              <KeyRound size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
              <input
                value={joinCode}
                onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
                onKeyDown={(e) => { if (e.key === 'Enter') doJoin(); }}
                placeholder={t('inventory.noShop.codePlaceholder')}
                className="w-full rounded-os border border-osborder bg-surface py-2 pl-8 pr-2 text-sm uppercase tracking-widest text-ink placeholder:normal-case placeholder:tracking-normal"
                aria-label={t('inventory.noShop.codePlaceholder')}
              />
            </div>
            <button
              type="button"
              onClick={doJoin}
              disabled={joinBusy || !joinCode.trim()}
              className="rounded-os bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              {joinBusy ? '…' : t('inventory.noShop.join')}
            </button>
          </div>
          {joinError && <p className="mt-2 text-xs text-red-600">{joinError}</p>}
          <button
            type="button"
            onClick={resolveShop}
            className="mt-3 text-xs text-muted underline hover:text-ink"
          >
            {t('inventory.noShop.retry')}
          </button>
        </div>
      </div>
    );
  }

  const canDelete = shopRole === 'owner' || shopRole === 'manager';

  return (
    <BqPerms.Provider value={{ canDelete }}>
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-osborder bg-paper px-3 pt-2">
        {TABS.map((tb) => (
          <button
            key={tb.id}
            type="button"
            onClick={() => { setTab(tb.id); if (tb.id === 'sorting') setSortKey((k) => k + 1); }}
            className={`flex shrink-0 items-center gap-1.5 rounded-t-os border-b-2 px-3 py-2 text-sm font-medium duration-160 ${
              tab === tb.id
                ? 'border-accent text-ink'
                : 'border-transparent text-muted hover:text-ink'
            }`}
          >
            <tb.icon size={14} /> {tb.label}
          </button>
        ))}
        {shopName && (
          <span className="ml-auto flex shrink-0 items-center gap-1.5 px-2 py-2 text-xs text-muted" title={shopRole}>
            <Store size={13} />
            {shops.length > 1 ? (
              <select
                value={activeShopId || ''}
                onChange={(e) => doSwitchShop(e.target.value)}
                className="max-w-[12rem] cursor-pointer bg-transparent font-semibold text-ink outline-none"
                aria-label={t('inventory.shop.switcher')}
                title={t('inventory.shop.switcher')}
              >
                {shops.map((s) => (
                  <option key={s.id} value={s.id}>{s.name || t('inventory.shop.unnamed')}</option>
                ))}
              </select>
            ) : (
              <span className="font-semibold text-ink">{shopName}</span>
            )}
          </span>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto bg-paper/60 p-4">
        {tab === 'catalog' && <CatalogTab key={'catalog:' + shopKey} />}
        {tab === 'donations' && <DonationsTab key={'donations:' + shopKey} />}
        {tab === 'sorting' && <SortingTab key={'sorting:' + shopKey + ':' + sortKey} refreshKey={sortKey} />}
        {tab === 'fair' && <FairTab key={'fair:' + shopKey} />}
        {tab === 'orders' && <OrdersTab key={'orders:' + shopKey} />}
      </div>
    </div>
    </BqPerms.Provider>
  );
}
