import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CalendarDays, ChevronLeft, ChevronRight, Plus, X, Search, Clock,
  Phone, Trash2, Cloud, Check, UserPlus,
} from 'lucide-react';
import { backend } from '../lib/backend/current.js';
import { localeTag, useLang } from '../lib/i18n.jsx';

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const DAY_START = 7;   // 7am
const DAY_END = 21;    // 9pm
const DURATIONS = [15, 30, 45, 60, 90, 120];

const statusMeta = (t) => ({
  scheduled: { label: t('appointments.statusLabel.scheduled'), chip: 'bg-osborder/60 text-muted', dot: 'bg-muted' },
  confirmed: { label: t('appointments.statusLabel.confirmed'), chip: 'bg-sky-500/15 text-sky-600', dot: 'bg-sky-500' },
  completed: { label: t('appointments.statusLabel.completed'), chip: 'bg-green-500/15 text-green-600', dot: 'bg-green-500' },
  cancelled: { label: t('appointments.statusLabel.cancelled'), chip: 'bg-osborder/40 text-muted', dot: 'bg-osborder' },
  no_show: { label: t('appointments.statusLabel.noShow'), chip: 'bg-red-500/15 text-red-600', dot: 'bg-red-500' },
});

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}
function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
function startOfWeek(d) {
  const x = startOfDay(d);
  const dow = (x.getDay() + 6) % 7; // Monday-first
  return addDays(x, -dow);
}
function fmtTime(iso) {
  return new Date(iso).toLocaleTimeString(localeTag(), { hour: 'numeric', minute: '2-digit' });
}
function fmtDay(d) {
  return new Date(d).toLocaleDateString(localeTag(), { weekday: 'short', month: 'short', day: 'numeric' });
}
function toDateInput(d) {
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
}
function toTimeInput(d) {
  const x = new Date(d);
  return `${String(x.getHours()).padStart(2, '0')}:${String(x.getMinutes()).padStart(2, '0')}`;
}
function combineLocal(dateStr, timeStr) {
  return new Date(`${dateStr}T${timeStr}:00`);
}
function sameDay(a, b) {
  const x = new Date(a), y = new Date(b);
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
}

/* ------------------------------------------------------------------ */
/* Editor dialog                                                       */
/* ------------------------------------------------------------------ */

function EditorDialog({ initial, customers, staff, appointments, canDelete, onClose, onSaved, onDeleted }) {
  const { t } = useLang();
  const editing = !!initial?.id;
  const [title, setTitle] = useState(initial?.title || '');
  const [customerId, setCustomerId] = useState(initial?.customerId || '');
  const [custSearch, setCustSearch] = useState(initial?.customerName || '');
  const [custOpen, setCustOpen] = useState(false);
  const [newCust, setNewCust] = useState(false);
  const [newCustName, setNewCustName] = useState('');
  const [newCustPhone, setNewCustPhone] = useState('');
  const [staffId, setStaffId] = useState(initial?.staffId || '');
  const [date, setDate] = useState(toDateInput(initial?.startsAt || initial?.presetStart || new Date()));
  const [time, setTime] = useState(toTimeInput(initial?.startsAt || initial?.presetStart || new Date()));
  const [duration, setDuration] = useState(() => {
    if (initial?.startsAt && initial?.endsAt) {
      return Math.round((new Date(initial.endsAt) - new Date(initial.startsAt)) / 60000);
    }
    return 60;
  });
  const [notes, setNotes] = useState(initial?.notes || '');
  const [status, setStatus] = useState(initial?.status || 'scheduled');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const custBoxRef = useRef(null);

  useEffect(() => {
    const onDoc = (e) => {
      if (custBoxRef.current && !custBoxRef.current.contains(e.target)) setCustOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  const matches = useMemo(() => {
    const q = custSearch.trim().toLowerCase();
    const list = q
      ? customers.filter((c) => c.name.toLowerCase().includes(q) || (c.phone || '').includes(q))
      : customers;
    return list.slice(0, 6);
  }, [customers, custSearch]);

  const startsAt = useMemo(() => {
    try { return combineLocal(date, time); } catch { return null; }
  }, [date, time]);
  const endsAt = useMemo(() => {
    if (!startsAt || Number.isNaN(startsAt.getTime())) return null;
    return new Date(startsAt.getTime() + Number(duration) * 60000);
  }, [startsAt, duration]);

  const overlap = useMemo(() => {
    if (!startsAt || !endsAt) return null;
    return appointments.find((a) => {
      if (editing && a.id === initial.id) return false;
      // If both have staff assigned, only flag overlap for the same staff.
      // If either is unassigned, flag any time overlap (prevents double-booking
      // the room/slot when staff isn't tracked).
      if (staffId && a.staffId && a.staffId !== staffId) return false;
      if (a.status === 'cancelled') return false;
      const s = new Date(a.startsAt), e = new Date(a.endsAt);
      return startsAt < e && endsAt > s;
    }) || null;
  }, [appointments, startsAt, endsAt, staffId, editing, initial]);

  const staffName = staffId ? (staff.find((s) => s.id === staffId)?.name || '') : '';

  const save = async () => {
    setError('');
    if (!title.trim()) { setError(t('appointments.errTitle')); return; }
    if (!startsAt || Number.isNaN(startsAt.getTime())) { setError(t('appointments.errDateTime')); return; }
    // Block double-booking: the overlap warning above is not enough, the
    // save itself must refuse when the slot is taken.
    if (overlap) {
      setError(t('appointments.errOverlap', { title: overlap.title }));
      return;
    }
    setSaving(true);
    try {
      let cid = customerId || null;
      if (newCust) {
        const name = newCustName.trim();
        if (!name) throw new Error(t('appointments.errCustName'));
        const created = await backend.pos.saveCustomer(initial.storeId, {
          name, phone: newCustPhone.trim(),
        });
        cid = created.id;
      }
      const saved = await backend.pos.saveAppointment(initial.storeId, {
        id: editing ? initial.id : undefined,
        customerId: cid,
        staffId: staffId || null,
        title: title.trim(),
        notes: notes.trim(),
        startsAt: startsAt.toISOString(),
        endsAt: endsAt.toISOString(),
        status,
      });
      onSaved(saved);
    } catch (e) {
      setError(e.message || t('appointments.errSave'));
    } finally {
      setSaving(false);
    }
  };

  const remove = () => {
    if (!editing || !canDelete || saving) return;
    // In-app confirmation (window.confirm is unreliable in embedded browsers).
    setConfirmDelete(true);
  };

  const doRemove = async () => {
    setConfirmDelete(false);
    setSaving(true);
    try {
      await backend.pos.deleteAppointment(initial.storeId, initial.id);
      onDeleted(initial.id);
    } catch (e) {
      setError(e.message || t('appointments.errDelete'));
      setSaving(false);
    }
  };

  const inputCls =
    'w-full rounded-os border border-osborder bg-paper px-3 py-2 text-sm text-ink outline-none placeholder:text-muted focus:border-accent';

  return (
    <>
    <div className="absolute inset-0 z-20 flex items-center justify-center bg-ink/30 p-4" onClick={onClose}>
      <div
        className="max-h-full w-full max-w-md overflow-y-auto rounded-os bg-surface p-5 shadow-os"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={editing ? t('appointments.editAppt') : t('appointments.newAppt')}
      >
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-base font-semibold text-ink">{editing ? t('appointments.editAppt') : t('appointments.newAppt')}</h3>
          <button type="button" onClick={onClose} aria-label={t('common.close')} className="rounded-os p-1 text-muted hover:bg-paper hover:text-ink">
            <X size={18} />
          </button>
        </div>

        {error && <p role="alert" className="mb-3 text-sm text-red-600">{error}</p>}

        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-muted">{t('appointments.service')}</label>
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t('appointments.servicePh')}
              maxLength={120} className={inputCls} />
          </div>

          <div ref={custBoxRef} className="relative">
            <label className="mb-1 block text-xs font-medium text-muted">{t('appointments.customerLabel')}</label>
            {newCust ? (
              <div className="space-y-2 rounded-os border border-osborder bg-paper p-2.5">
                <input value={newCustName} onChange={(e) => setNewCustName(e.target.value)} placeholder={t('appointments.customerNamePh')}
                  className={inputCls} />
                <input value={newCustPhone} onChange={(e) => setNewCustPhone(e.target.value)} placeholder={t('appointments.phonePh')}
                  className={inputCls} />
                <button type="button" onClick={() => setNewCust(false)} className="text-xs text-muted hover:text-ink">
                  {t('appointments.pickExisting')}
                </button>
              </div>
            ) : customerId ? (
              <div className="flex items-center justify-between rounded-os border border-osborder bg-paper px-3 py-2">
                <span className="text-sm text-ink">{custSearch || t('appointments.customerFallback')}</span>
                <button type="button" aria-label={t('appointments.clearCustomer')}
                  onClick={() => { setCustomerId(''); setCustSearch(''); }}
                  className="rounded-os p-1 text-muted hover:text-ink">
                  <X size={14} />
                </button>
              </div>
            ) : (
              <>
                <div className="relative">
                  <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
                  <input value={custSearch}
                    onChange={(e) => { setCustSearch(e.target.value); setCustOpen(true); }}
                    onFocus={() => setCustOpen(true)}
                    placeholder={t('appointments.searchCustomers')}
                    className={`${inputCls} pl-9`} />
                </div>
                {custOpen && (
                  <ul className="absolute z-10 mt-1 max-h-44 w-full overflow-y-auto rounded-os border border-osborder bg-surface shadow-os">
                    {matches.map((c) => (
                      <li key={c.id}>
                        <button type="button"
                          onClick={() => { setCustomerId(c.id); setCustSearch(c.name); setCustOpen(false); }}
                          className="flex w-full items-center justify-between px-3 py-2 text-left text-sm text-ink hover:bg-paper">
                          <span className="truncate">{c.name}</span>
                          {c.phone && <span className="ml-2 shrink-0 text-xs text-muted">{c.phone}</span>}
                        </button>
                      </li>
                    ))}
                    <li>
                      <button type="button" onClick={() => { setNewCust(true); setCustOpen(false); }}
                        className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-sm font-medium text-accent hover:bg-paper">
                        <UserPlus size={14} /> {t('appointments.newCustomer')}
                      </button>
                    </li>
                  </ul>
                )}
              </>
            )}
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-muted">{t('appointments.withStaff')}</label>
            <select value={staffId} onChange={(e) => setStaffId(e.target.value)} className={inputCls}>
              <option value="">{t('appointments.anyone')}</option>
              {staff.filter((s) => s.active !== false).map((s) => (
                <option key={s.id} value={s.id}>{s.name}{s.role ? ` · ${s.role}` : ''}</option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-3 gap-2">
            <div>
              <label className="mb-1 block text-xs font-medium text-muted">{t('appointments.date')}</label>
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={inputCls} />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted">{t('appointments.start')}</label>
              <input type="time" value={time} onChange={(e) => setTime(e.target.value)} className={inputCls} />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted">{t('appointments.length')}</label>
              <select value={duration} onChange={(e) => setDuration(Number(e.target.value))} className={inputCls}>
                {DURATIONS.map((d) => (
                  <option key={d} value={d}>{d >= 60 ? `${d / 60}h` : `${d}m`}</option>
                ))}
              </select>
            </div>
          </div>

          {overlap && (
            <p className="rounded-os bg-amber-500/10 px-3 py-2 text-xs text-amber-600">
              {t('appointments.overlap', { staff: staffName || t('appointments.thisStaff'), title: overlap.title, range: fmtTime(overlap.startsAt) + '–' + fmtTime(overlap.endsAt) })}
            </p>
          )}

          <div>
            <label className="mb-1 block text-xs font-medium text-muted">{t('appointments.notes')}</label>
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2}
              placeholder={t('appointments.notesPh')} className={`${inputCls} resize-y`} />
          </div>

          {editing && (
            <div>
              <label className="mb-1 block text-xs font-medium text-muted">{t('appointments.status')}</label>
              <select value={status} onChange={(e) => setStatus(e.target.value)} className={inputCls}>
                {Object.entries(statusMeta(t)).map(([k, m]) => (
                  <option key={k} value={k}>{m.label}</option>
                ))}
              </select>
            </div>
          )}
        </div>

        <div className="mt-5 flex items-center justify-between gap-2">
          {editing && canDelete ? (
            <button type="button" onClick={remove} disabled={saving}
              className="flex items-center gap-1.5 rounded-os px-3 py-2 text-sm font-medium text-red-600 hover:bg-red-500/10 disabled:opacity-50">
              <Trash2 size={15} /> {t('common.delete')}
            </button>
          ) : <span />}
          <div className="flex gap-2">
            <button type="button" onClick={onClose}
              className="rounded-os border border-osborder px-4 py-2 text-sm font-medium text-ink hover:border-accent">
              {t('common.cancel')}
            </button>
            <button type="button" onClick={save} disabled={saving}
              className="flex items-center gap-1.5 rounded-os bg-accent px-4 py-2 text-sm font-semibold text-accentink hover:opacity-90 disabled:opacity-50">
              <Check size={15} /> {saving ? t('appointments.saving') : editing ? t('common.save') : t('appointments.book')}
            </button>
          </div>
        </div>
      </div>
    </div>
    {confirmDelete && (
      <div className="fixed inset-0 z-30 flex items-center justify-center bg-ink/40 p-4"
        onClick={() => setConfirmDelete(false)}>
        <div className="w-80 rounded-os border border-osborder bg-surface shadow-os"
          onClick={(e) => e.stopPropagation()} role="alertdialog"
          aria-label={t('common.delete')}>
          <div className="border-b border-osborder px-4 py-3">
            <h3 className="text-sm font-semibold text-ink">{t('common.delete')}</h3>
          </div>
          <div className="p-4">
            <p className="text-sm text-ink">{t('appointments.deleteConfirm', { title: initial.title })}</p>
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" onClick={() => setConfirmDelete(false)}
                className="rounded-os border border-osborder px-3 py-1.5 text-sm hover:bg-paper">
                {t('common.cancel')}
              </button>
              <button type="button" onClick={doRemove}
                className="rounded-os bg-red-700 px-4 py-1.5 text-sm font-medium text-white hover:bg-red-800">
                {t('common.delete')}
              </button>
            </div>
          </div>
        </div>
      </div>
    )}
  </>
  );
}

/* ------------------------------------------------------------------ */
/* Views                                                               */
/* ------------------------------------------------------------------ */

function ApptBlock({ appt, onOpen, compact }) {
  const { t } = useLang();
  const meta = statusMeta(t)[appt.status] || statusMeta(t).scheduled;
  return (
    <button type="button" onClick={() => onOpen(appt)}
      className={`block w-full rounded-os border-l-4 bg-paper px-2 py-1 text-left shadow-os duration-160 hover:brightness-95 ${meta.dot.replace('bg-', 'border-')}`}
      title={`${appt.title} · ${fmtTime(appt.startsAt)}–${fmtTime(appt.endsAt)}`}>
      <p className={`truncate text-xs font-semibold text-ink ${appt.status === 'cancelled' ? 'line-through' : ''}`}>
        {appt.title}
      </p>
      {!compact && (
        <>
          <p className="truncate text-[11px] text-muted">{fmtTime(appt.startsAt)}–{fmtTime(appt.endsAt)}</p>
          {(appt.customerName || appt.staffName) && (
            <p className="truncate text-[11px] text-muted">
              {[appt.customerName, appt.staffName].filter(Boolean).join(' · ')}
            </p>
          )}
        </>
      )}
    </button>
  );
}

function DayView({ date, appointments, onSlotClick, onOpen }) {
  const { t } = useLang();
  const hours = [];
  for (let h = DAY_START; h < DAY_END; h++) hours.push(h);
  const dayAppts = appointments.filter((a) => sameDay(a.startsAt, date));
  const pxPerMin = 1.1;
  const top = (iso) => {
    const d = new Date(iso);
    return (d.getHours() * 60 + d.getMinutes() - DAY_START * 60) * pxPerMin;
  };
  const height = (a) => Math.max(28, (new Date(a.endsAt) - new Date(a.startsAt)) / 60000 * pxPerMin - 4);

  return (
    <div className="relative overflow-y-auto" style={{ height: '100%' }}>
      <div className="relative" style={{ height: hours.length * 60 * pxPerMin }}>
        {hours.map((h) => (
          <button key={h} type="button"
            onClick={() => onSlotClick(new Date(date.getFullYear(), date.getMonth(), date.getDate(), h, 0))}
            className="group absolute flex w-full border-t border-osborder text-left hover:bg-paper/60"
            style={{ top: (h - DAY_START) * 60 * pxPerMin, height: 60 * pxPerMin }}>
            <span className="w-14 shrink-0 px-2 pt-1 text-[11px] text-muted">
              {new Date(2000, 0, 1, h).toLocaleTimeString(localeTag(), { hour: 'numeric' })}
            </span>
            <span className="mt-2 hidden text-[11px] text-accent opacity-0 group-hover:opacity-100">+ {t('appointments.book')}</span>
          </button>
        ))}
        {dayAppts.map((a) => {
          const t = top(a.startsAt);
          if (t < 0) return null;
          return (
            <div key={a.id} className="absolute left-16 right-2" style={{ top: t, height: height(a) }}>
              <ApptBlock appt={a} onOpen={onOpen} />
            </div>
          );
        })}
        {dayAppts.some((a) => top(a.startsAt) < 0) && (
          <button
            type="button"
            onClick={() => setView('upcoming')}
            className="absolute inset-x-0 top-0 z-10 bg-amber-100 px-3 py-1.5 text-center text-xs font-medium text-amber-800 hover:bg-amber-200 dark:bg-amber-900/40 dark:text-amber-200"
          >
            {t('appointments.earlierHidden')}
          </button>
        )}
        {dayAppts.length === 0 && (
          <p className="pointer-events-none absolute inset-x-0 top-1/3 text-center text-sm text-muted">
            {t('appointments.nothingBooked')}
          </p>
        )}
      </div>
    </div>
  );
}

function WeekView({ weekStart, appointments, onDayClick, onOpen }) {
  const days = [...Array(7)].map((_, i) => addDays(weekStart, i));
  return (
    <div className="grid h-full grid-cols-7 gap-px overflow-hidden bg-osborder">
      {days.map((d) => {
        const isToday = sameDay(d, new Date());
        const list = appointments.filter((a) => sameDay(a.startsAt, d)).slice(0, 8);
        return (
          <div key={d.toISOString()} className="flex min-h-0 flex-col bg-surface">
            <button type="button" onClick={() => onDayClick(d)}
              className={`border-b border-osborder px-1 py-2 text-center hover:bg-paper ${isToday ? 'bg-accent/10' : ''}`}>
              <span className="block text-[10px] uppercase text-muted">
                {d.toLocaleDateString(localeTag(), { weekday: 'short' })}
              </span>
              <span className={`text-sm font-semibold ${isToday ? 'text-accent' : 'text-ink'}`}>{d.getDate()}</span>
            </button>
            <div className="min-h-0 flex-1 space-y-1 overflow-y-auto p-1">
              {list.map((a) => (
                <ApptBlock key={a.id} appt={a} onOpen={onOpen} compact />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function UpcomingView({ appointments, onOpen, onStatus }) {
  const { t } = useLang();
  const now = new Date();
  const list = appointments
    .filter((a) => new Date(a.endsAt) >= now && a.status !== 'cancelled')
    .slice(0, 60);
  const groups = [];
  for (const a of list) {
    const last = groups[groups.length - 1];
    if (last && sameDay(last.day, a.startsAt)) last.items.push(a);
    else groups.push({ day: a.startsAt, items: [a] });
  }
  if (groups.length === 0) {
    return <p className="p-8 text-center text-sm text-muted">{t('appointments.noUpcoming')}</p>;
  }
  return (
    <div className="overflow-y-auto p-3">
      {groups.map((g) => (
        <div key={g.day} className="mb-4">
          <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted">{fmtDay(g.day)}</p>
          <ul className="space-y-1.5">
            {g.items.map((a) => {
              const meta = statusMeta(t)[a.status] || statusMeta(t).scheduled;
              return (
                <li key={a.id} className="flex items-center gap-3 rounded-os border border-osborder bg-paper px-3 py-2">
                  <span className={`h-8 w-1 shrink-0 rounded-full ${meta.dot}`} />
                  <button type="button" onClick={() => onOpen(a)} className="min-w-0 flex-1 text-left">
                    <span className="block truncate text-sm font-medium text-ink">
                      {fmtTime(a.startsAt)} · {a.title}
                    </span>
                    <span className="block truncate text-xs text-muted">
                      {[a.customerName, a.staffName].filter(Boolean).join(' · ') || '—'}
                    </span>
                  </button>
                  <span className={`hidden shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium sm:inline ${meta.chip}`}>
                    {meta.label}
                  </span>
                  {a.status === 'scheduled' && (
                    <button type="button" onClick={() => onStatus(a, 'confirmed')}
                      className="shrink-0 rounded-os border border-osborder px-2 py-1 text-[11px] font-medium text-ink hover:border-accent">
                      {t('appointments.confirm')}
                    </button>
                  )}
                  {(a.status === 'scheduled' || a.status === 'confirmed') && (
                    <button type="button" onClick={() => onStatus(a, 'completed')}
                      className="shrink-0 rounded-os border border-osborder px-2 py-1 text-[11px] font-medium text-ink hover:border-accent">
                      {t('appointments.done')}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* App                                                                 */
/* ------------------------------------------------------------------ */

export default function AppointmentsApp({ windowApi }) {
  const { t } = useLang();
  const [stores, setStores] = useState([]);
  const [storeId, setStoreId] = useState(null);
  const [caps, setCaps] = useState(null);
  const [view, setView] = useState('day');
  const [anchor, setAnchor] = useState(() => startOfDay(new Date()));
  const [appointments, setAppointments] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [staff, setStaff] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editor, setEditor] = useState(null); // { id?, presetStart?, storeId, ... }

  useEffect(() => {
    windowApi?.setTitle?.(t('appointments.title'));
  }, [windowApi]);

  const store = stores.find((s) => s.id === storeId) || null;
  const canDelete = !store || ['owner', 'manager'].includes(store.role);

  const loadAll = useCallback(async (sid) => {
    setError('');
    setLoading(true);
    try {
      const [cap, appts, custs, stf] = await Promise.all([
        backend.pos.capabilities(),
        backend.pos.listAppointments(sid, {
          from: addDays(startOfWeek(new Date()), -7).toISOString(),
          to: addDays(new Date(), 60).toISOString(),
        }).catch(() => []),
        backend.pos.listCustomers(sid).catch(() => []),
        backend.pos.listStaff(sid).catch(() => []),
      ]);
      setCaps(cap);
      setAppointments(appts);
      setCustomers(custs);
      setStaff(stf);
    } catch (e) {
      setError(e.message || t('appointments.errLoad'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const list = await backend.pos.listStores();
        setStores(list);
        const first = list[0]?.id || null;
        setStoreId(first);
        if (first) await loadAll(first);
        else setLoading(false);
      } catch (e) {
        setError(e.message || t('appointments.errStores'));
        setLoading(false);
      }
    })();
  }, [loadAll]);

  const switchStore = async (sid) => {
    setStoreId(sid);
    setAppointments([]);
    await loadAll(sid);
  };

  const refresh = useCallback(async () => {
    if (!storeId) return;
    try {
      const appts = await backend.pos.listAppointments(storeId, {
        from: addDays(startOfWeek(new Date()), -7).toISOString(),
        to: addDays(new Date(), 60).toISOString(),
      });
      setAppointments(appts);
      setCustomers(await backend.pos.listCustomers(storeId).catch(() => []));
    } catch (e) {
      setError(e.message || t('appointments.errRefresh'));
    }
  }, [storeId]);

  const openNew = (presetStart) => setEditor({ presetStart, storeId });
  const openEdit = (appt) => setEditor({ ...appt, storeId });

  const onSaved = async () => {
    setEditor(null);
    await refresh();
  };
  const onDeleted = async () => {
    setEditor(null);
    await refresh();
  };
  const onStatus = async (appt, status) => {
    setError('');
    try {
      await backend.pos.saveAppointment(storeId, { ...appt, status });
      await refresh();
    } catch (e) {
      setError(e.message || t('appointments.errStatus'));
    }
  };

  const weekStart = startOfWeek(anchor);
  const title =
    view === 'day' ? fmtDay(anchor)
    : view === 'week' ? t('appointments.weekOf', { day: fmtDay(weekStart) })
    : t('appointments.upcoming');

  const step = (dir) => {
    if (view === 'day') setAnchor(addDays(anchor, dir));
    else if (view === 'week') setAnchor(addDays(anchor, dir * 7));
  };

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center bg-surface text-sm text-muted">
        {t('appointments.loading')}
      </div>
    );
  }

  if (caps && caps.appointments === false) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 bg-surface p-8 text-center">
        <Cloud size={28} className="text-muted" />
        <p className="text-sm font-medium text-ink">{t('appointments.needMigration')}</p>
        <p className="max-w-xs text-xs text-muted">
          {t('appointments.applyMigration')}
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-surface text-ink">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-2 border-b border-osborder px-4 py-2.5">
        <span className="text-accent"><CalendarDays size={20} /></span>
        <h2 className="mr-1 text-sm font-semibold">{t('appointments.title')}</h2>
        {stores.length > 1 && (
          <select
            value={storeId || ''}
            onChange={(e) => switchStore(e.target.value)}
            className="rounded-os border border-osborder bg-paper px-2 py-1 text-xs text-ink outline-none focus:border-accent"
            aria-label={t('appointments.store')}
          >
            {stores.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        )}
        <div className="flex gap-1 rounded-os bg-paper p-0.5">
          {[['day', t('appointments.day')], ['week', t('appointments.week')], ['upcoming', t('appointments.upcoming')]].map(([id, label]) => (
            <button key={id} type="button" onClick={() => setView(id)}
              className={`rounded-os px-2.5 py-1 text-xs font-medium duration-160 ${view === id ? 'bg-surface text-ink shadow-os' : 'text-muted hover:text-ink'}`}>
              {label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1">
          {view !== 'upcoming' && (
            <>
              <button type="button" onClick={() => step(-1)} aria-label={t('appointments.previous')}
                className="rounded-os p-1.5 text-muted hover:bg-paper hover:text-ink">
                <ChevronLeft size={16} />
              </button>
              <button type="button" onClick={() => setAnchor(startOfDay(new Date()))}
                className="rounded-os px-2 py-1 text-xs font-medium text-muted hover:bg-paper hover:text-ink">
                {t('appointments.today')}
              </button>
              <button type="button" onClick={() => step(1)} aria-label={t('appointments.next')}
                className="rounded-os p-1.5 text-muted hover:bg-paper hover:text-ink">
                <ChevronRight size={16} />
              </button>
            </>
          )}
          <span className="ml-1 text-xs font-medium text-muted">{title}</span>
        </div>
        <span className="flex-1" />
        <button type="button" onClick={() => openNew(new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate(), 9, 0))}
          className="flex items-center gap-1.5 rounded-os bg-accent px-3 py-1.5 text-xs font-semibold text-accentink duration-160 hover:opacity-90">
          <Plus size={14} /> {t('appointments.newAppt')}
        </button>
      </div>

      {error && (
        <div className="border-b border-osborder bg-paper px-4 py-2 text-xs text-red-600">{error}</div>
      )}

      {/* Body */}
      <div className="min-h-0 flex-1">
        {view === 'day' && (
          <DayView date={anchor} appointments={appointments} onSlotClick={openNew} onOpen={openEdit} />
        )}
        {view === 'week' && (
          <WeekView weekStart={weekStart} appointments={appointments}
            onDayClick={(d) => { setAnchor(startOfDay(d)); setView('day'); }} onOpen={openEdit} />
        )}
        {view === 'upcoming' && (
          <UpcomingView appointments={appointments} onOpen={openEdit} onStatus={onStatus} />
        )}
      </div>

      {editor && (
        <EditorDialog
          initial={editor}
          customers={customers}
          staff={staff}
          appointments={appointments}
          canDelete={canDelete}
          onClose={() => setEditor(null)}
          onSaved={onSaved}
          onDeleted={onDeleted}
        />
      )}
    </div>
  );
}
