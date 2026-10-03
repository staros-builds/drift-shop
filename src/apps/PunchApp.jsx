import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import {
  Clock3, Users, BarChart3, KeyRound, UserPlus, Pencil, Trash2,
  AlertCircle, Check, X, History, CalendarDays, CalendarClock,
  CircleDollarSign, Settings, Coffee, Play, Pause, Download, Lock,
  HeartHandshake, Printer,
} from 'lucide-react';
import { backend } from '../lib/backend/current.js';
import { useLang, localeTag, tagFor } from '../lib/i18n.jsx';
import { sha256hex } from '../lib/sha256.js';

/* ------------------------------------------------------------------ */
/* Certificates (Attestations) — standalone employee time clock (FR/EN). */
/* Reuses the tested backend.pos time-clock + staff-PIN APIs; every     */
/* punch re-verifies the PIN server-side. The Certificates app is the   */
/* system of record: breaks, schedule, time-off, pay-period approval    */
/* and the payroll export all live here (the POS clock tab keeps only   */
/* basic in/out + corrections).                                         */
/* ------------------------------------------------------------------ */

const canManage = (role) => role === 'owner' || role === 'manager';
const PAD_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'];
const MS_MIN = 60000;
const OT_WEEK_MS = 40 * 60 * MS_MIN; // Québec CNESST: overtime past 40 h/week at 1.5×

function fmtTime(iso) {
  return new Date(iso).toLocaleTimeString(localeTag(), { hour: 'numeric', minute: '2-digit' });
}
function fmtDay(iso, lang) {
  // NUCLEAR FAILSAFE: guard against null/invalid dates (was "Invalid Date").
  if (!iso) return '—';
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '—';
  const loc = tagFor(lang);
  return d.toLocaleDateString(loc, { weekday: 'short', month: 'short', day: 'numeric' });
}
function fmtDur(ms) {
  // NUCLEAR FAILSAFE: guard against NaN (was "NaN min").
  if (!Number.isFinite(ms)) return '—';
  const m = Math.max(0, Math.round(ms / MS_MIN));
  const h = Math.floor(m / 60);
  return h > 0 ? `${h}h ${String(m % 60).padStart(2, '0')}` : `${m} min`;
}
// ISO -> "YYYY-MM-DDTHH:MM" for <input type="datetime-local">.
function toLocalInput(iso) {
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
// "YYYY-MM-DD" -> local midnight ISO.
// NUCLEAR FAILSAFE: returns null on null/malformed input — NEVER guesses a
// date (the old fallback returned the current instant, silently querying the
// wrong day). Callers must handle null explicitly.
function dayStartISO(ymd) {
  if (!ymd || typeof ymd !== 'string') return null;
  const [y, m, d] = ymd.split('-').map(Number);
  if (![y, m, d].every((n) => Number.isFinite(n))) return null;
  const dt = new Date(y, m - 1, d, 0, 0, 0);
  if (!Number.isFinite(dt.getTime())) return null;
  return dt.toISOString();
}
function dayEndISO(ymd) {
  // NUCLEAR FAILSAFE: same fail-closed contract as dayStartISO.
  if (!ymd || typeof ymd !== 'string') return null;
  const [y, m, d] = ymd.split('-').map(Number);
  if (![y, m, d].every((n) => Number.isFinite(n))) return null;
  const dt = new Date(y, m - 1, d + 1, 0, 0, 0);
  if (!Number.isFinite(dt.getTime())) return null;
  return dt.toISOString();
}
function todayYMD() {
  return localYMD(new Date());
}
function localYMD(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function addDaysYMD(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + n);
  return localYMD(dt);
}
// 0..6 days since week start.
function dowIndex(date, weekStart) {
  const dow = date.getDay(); // 0 = Sunday
  return weekStart === 'sunday' ? dow : (dow + 6) % 7;
}
function weekStartOf(ymd, weekStart) {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() - dowIndex(dt, weekStart));
  return localYMD(dt);
}
function weekDates(weekStartYmd) {
  return Array.from({ length: 7 }, (_, i) => addDaysYMD(weekStartYmd, i));
}

/* ------------------ payroll math (net of unpaid breaks) ------------- */

// Net worked ms for one punch: punch length minus unpaid breaks taken
// inside it (paid breaks are worked time; unpaid breaks are not).
function punchNetMs(p, breaks, nowMs) {
  // NUCLEAR FAILSAFE: guard against corrupt punch data. If punchIn is invalid,
  // return 0 instead of NaN — NaN would silently poison weeklyPay totals.
  const pin = new Date(p.punchIn).getTime();
  if (!Number.isFinite(pin)) return 0;
  const pout = p.punchOut ? new Date(p.punchOut).getTime() : nowMs;
  if (!Number.isFinite(pout)) return 0;
  let ms = Math.max(0, pout - pin);
  for (const b of breaks) {
    if (b.punchId !== p.id || b.type !== 'unpaid') continue;
    const bs = Math.max(new Date(b.start).getTime(), pin);
    const be = Math.min(b.end ? new Date(b.end).getTime() : pout, pout);
    // Guard against NaN from corrupt break data.
    if (!Number.isFinite(bs) || !Number.isFinite(be)) continue;
    ms -= Math.max(0, be - bs);
  }
  const result = Math.max(0, ms);
  return Number.isFinite(result) ? result : 0;
}

// Per staff: regular + overtime ms, grouped into weekStart-aligned weeks.
// excludeStaffIds: staff never counted (e.g. community-service workers,
// whose unpaid hours must stay out of payroll and overtime entirely).
// Punches that span a week boundary are split at the boundary so each
// week's hours (and overtime) are correct.
// Returns [{ staffId, name, regMs, otMs, shifts }].
function weeklyPay(punches, breaks, weekStart, nowMs, excludeStaffIds = null) {
  const weeks = new Map();
  const addMs = (staffId, staffName, wk, ms) => {
    const key = `${wk}|${staffId}`;
    if (!weeks.has(key)) weeks.set(key, { staffId, name: staffName, ms: 0, shifts: 0 });
    weeks.get(key).ms += ms;
  };
  for (const p of punches) {
    if (excludeStaffIds && excludeStaffIds.has(p.staffId)) continue;
    const net = punchNetMs(p, breaks, nowMs);
    // Count the shift in the week it started (for the shift tally).
    const startWk = weekStartOf(localYMD(new Date(p.punchIn)), weekStart);
    const key = `${startWk}|${p.staffId}`;
    if (!weeks.has(key)) weeks.set(key, { staffId: p.staffId, name: p.staffName, ms: 0, shifts: 0 });
    weeks.get(key).shifts += 1;
    if (net <= 0) continue;
    // Split net ms across week boundaries, proportional to time in each week.
    const pin = new Date(p.punchIn).getTime();
    const pout = p.punchOut ? new Date(p.punchOut).getTime() : nowMs;
    if (!Number.isFinite(pin) || !Number.isFinite(pout) || pout <= pin) {
      addMs(p.staffId, p.staffName, startWk, net);
      continue;
    }
    const total = pout - pin;
    // Find the week-start boundaries strictly inside (pin, pout].
    const bounds = [];
    {
      // Start from the week containing pin, then step week by week.
      let wkStart = weekStartOf(localYMD(new Date(pin)), weekStart);
      for (;;) {
        const nextWk = addDaysYMD(wkStart, 7);
        const [y, m, d] = nextWk.split('-').map(Number);
        const b = new Date(y, m - 1, d).getTime();
        if (!Number.isFinite(b) || b <= pin || b >= pout) break;
        bounds.push(b);
        wkStart = nextWk;
        if (bounds.length > 520) break; // sanity: ~10 years of weeks
      }
    }
    if (bounds.length === 0) {
      addMs(p.staffId, p.staffName, startWk, net);
      continue;
    }
    let prev = pin;
    for (const b of [...bounds, pout]) {
      const segMs = b - prev;
      if (segMs > 0) {
        const wk = weekStartOf(localYMD(new Date(prev)), weekStart);
        addMs(p.staffId, p.staffName, wk, Math.round((net * segMs) / total));
      }
      prev = b;
    }
  }
  const staff = new Map();
  for (const w of weeks.values()) {
    const reg = Math.min(w.ms, OT_WEEK_MS);
    const ot = Math.max(0, w.ms - OT_WEEK_MS);
    const cur = staff.get(w.staffId) || { staffId: w.staffId, name: w.name, regMs: 0, otMs: 0, shifts: 0 };
    cur.regMs += reg;
    cur.otMs += ot;
    cur.shifts += w.shifts;
    staff.set(w.staffId, cur);
  }
  return [...staff.values()].sort((a, b) => b.regMs + b.otMs - (a.regMs + a.otMs));
}

function breakMinutesFor(breaks, staffId, nowMs) {
  let paid = 0;
  let unpaid = 0;
  for (const b of breaks) {
    if (b.staffId !== staffId) continue;
    const dur = Math.max(0, (b.end ? new Date(b.end).getTime() : nowMs) - new Date(b.start).getTime());
    if (b.type === 'paid') paid += dur;
    else unpaid += dur;
  }
  return { paidMin: Math.round(paid / MS_MIN), unpaidMin: Math.round(unpaid / MS_MIN) };
}

/* Default punch settings — used when the backend returns null/undefined.
   NUCLEAR FAILSAFE: prevents crashes in 4 tabs that read settings.weekStart etc. */
const DEFAULT_PUNCH_SETTINGS = {
  weekStart: 'monday',
  graceMin: 15,
  overtimeAfterHrs: 40,
  breakRules: [],
};

/* ----------------------- review exceptions ------------------------ */

function shiftStartMs(shift) {
  // NUCLEAR FAILSAFE: guard against malformed shift rows. Returns NaN for
  // invalid input instead of throwing — callers must handle NaN.
  try {
    if (!shift?.ymd || !shift?.start) return NaN;
    const [y, mo, d] = String(shift.ymd).split('-').map(Number);
    const [hh, mm] = String(shift.start).split(':').map(Number);
    if (![y, mo, d, hh, mm].every((n) => Number.isFinite(n))) return NaN;
    return new Date(y, mo - 1, d, hh, mm).getTime();
  } catch {
    return NaN;
  }
}

// Late arrival (punch-in past shift start + grace), missed punch (open
// punch left from a previous day or running absurdly long), edited
// entries (audit trail), overlong breaks.
function findExceptions({ punches, shifts, audits, breaks, graceMin, nowMs }) {
  const out = [];
  const graceMs = graceMin * MS_MIN;
  const shiftByDay = new Map();
  for (const s of shifts) {
    const k = `${s.staffId}|${s.ymd}`;
    if (!shiftByDay.has(k)) shiftByDay.set(k, s);
  }
  const editedIds = new Set();
  for (const a of audits) {
    if ((a.action === 'correct' || a.action === 'delete') && a.punchId) editedIds.add(a.punchId);
  }
  const today = localYMD(new Date(nowMs));
  for (const p of punches) {
    const ymd = localYMD(new Date(p.punchIn));
    const sh = shiftByDay.get(`${p.staffId}|${ymd}`);
    if (sh) {
      const shiftMs = shiftStartMs(sh);
      // NUCLEAR FAILSAFE: skip late check if shift data is malformed (NaN).
      if (Number.isFinite(shiftMs)) {
        const lateMs = new Date(p.punchIn).getTime() - shiftMs - graceMs;
        if (lateMs > 0) out.push({ type: 'late', staffName: p.staffName, at: p.punchIn, lateMs });
      }
    }
    if (!p.punchOut) {
      const age = nowMs - new Date(p.punchIn).getTime();
      // NUCLEAR FAILSAFE: overnight shifts (22:00-06:00) legitimately span midnight.
      // Only flag as "missed" based on the 16-hour age check, not on the calendar day.
      // The old `ymd < today` clause generated false "missed punch" exceptions every night
      // for workers on overnight shifts.
      if (age > 16 * 3600 * 1000) out.push({ type: 'missed', staffName: p.staffName, at: p.punchIn });
    }
    if (editedIds.has(p.id)) out.push({ type: 'edited', staffName: p.staffName, at: p.punchIn });
  }
  for (const b of breaks) {
    if (!b.allottedMin) continue;
    const dur = (b.end ? new Date(b.end).getTime() : nowMs) - new Date(b.start).getTime();
    const over = dur - b.allottedMin * MS_MIN;
    if (over > 0) out.push({ type: 'breakOver', staffName: b.staffName, at: b.start, overMs: over, allottedMin: b.allottedMin });
  }
  return out.sort((a, b) => new Date(b.at) - new Date(a.at));
}

function escHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Daily net hours per punch list (attestation): [{ ymd, ms, firstIn, lastOut }].
function dailyHours(punches, breaks, nowMs) {
  const byDay = new Map();
  for (const p of punches) {
    const ymd = localYMD(new Date(p.punchIn));
    const cur = byDay.get(ymd) || { ymd, ms: 0, firstIn: null, lastOut: null };
    cur.ms += punchNetMs(p, breaks, nowMs);
    const pin = new Date(p.punchIn).getTime();
    if (cur.firstIn == null || pin < cur.firstIn) cur.firstIn = pin;
    const pout = p.punchOut ? new Date(p.punchOut).getTime() : null;
    if (pout != null && (cur.lastOut == null || pout > cur.lastOut)) cur.lastOut = pout;
    byDay.set(ymd, cur);
  }
  return [...byDay.values()].sort((a, b) => (a.ymd < b.ymd ? -1 : 1));
}

// One worker's attestation section: header + daily table + totals.
function attestationSection({ t, lang, workerName, org, days, totalMs, assignedHours }) {
  const h2 = (ms) => (ms / 3600000).toFixed(2);
  const loc = tagFor(lang);
  const fDay = (ymd) => {
    // NUCLEAR FAILSAFE: guard against null/malformed dates in attestation print.
    if (!ymd || typeof ymd !== 'string') return '—';
    const [y, m, d] = ymd.split('-').map(Number);
    if (![y, m, d].every((n) => Number.isFinite(n))) return '—';
    return new Date(y, m - 1, d).toLocaleDateString(loc, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  };
  const fTime = (ms) => (ms == null ? '—' : new Date(ms).toLocaleTimeString(loc, { hour: 'numeric', minute: '2-digit' }));
  const rows = days.length === 0
    ? `<tr><td colspan="4" style="text-align:center;color:#666">—</td></tr>`
    : days.map((d) => `
    <tr><td>${escHtml(fDay(d.ymd))}</td><td>${fTime(d.firstIn)}</td><td>${fTime(d.lastOut)}</td><td class="num">${h2(d.ms)}</td></tr>`).join('');
  const remaining = Math.max(0, assignedHours - totalMs / 3600000);
  return `
  <h2>${escHtml(workerName)}</h2>
  ${org ? `<p class="meta"><b>${escHtml(t('punch.attestationOrg'))} :</b> ${escHtml(org)}</p>` : ''}
  <h3>${escHtml(t('punch.attestationDaily'))}</h3>
  <table>
    <thead><tr><th>${escHtml(t('punch.shiftDate'))}</th><th>${escHtml(t('punch.shiftStart'))}</th><th>${escHtml(t('punch.shiftEnd'))}</th><th class="num">${escHtml(t('punch.completedHours'))} (h)</th></tr></thead>
    <tbody>${rows}</tbody>
    <tfoot><tr><td colspan="3">${escHtml(t('punch.csvTotalRow'))}</td><td class="num">${h2(totalMs)}</td></tr></tfoot>
  </table>
  <div class="totals">
    <p class="meta"><b>${escHtml(t('punch.assignedHours'))} :</b> ${assignedHours.toFixed(2)} h</p>
    <p class="meta"><b>${escHtml(t('punch.remainingHours'))} :</b> ${remaining.toFixed(2)} h</p>
  </div>`;
}

// Full A4 attestation document (FR/EN) with signature block — one worker
// or a whole organization group (sectionsHtml).
function attestationDoc({ t, lang, storeName, subtitle, periodFrom, periodTo, sectionsHtml }) {
  const loc = tagFor(lang);
  return `<!DOCTYPE html>
<html lang="${tagFor(lang)}"><head><meta charset="utf-8">
<title>${escHtml(t('punch.attestationTitle'))}</title>
<style>
  @page { size: A4; margin: 18mm 15mm; }
  body { font-family: Georgia, 'Times New Roman', serif; color: #111; font-size: 12pt; line-height: 1.45; }
  h1 { font-size: 20pt; margin: 0 0 4pt; }
  h2 { font-size: 14pt; margin: 20pt 0 6pt; border-bottom: 1px solid #999; padding-bottom: 4pt; }
  h3 { font-size: 12pt; margin: 12pt 0 4pt; }
  .meta { margin: 2pt 0; }
  .meta b { display: inline-block; min-width: 230px; }
  table { width: 100%; border-collapse: collapse; margin-top: 6pt; font-size: 11pt; }
  th, td { border: 1px solid #666; padding: 5pt 8pt; text-align: left; }
  th { background: #eee; }
  td.num, th.num { text-align: right; }
  tfoot td { font-weight: bold; }
  .totals { margin-top: 8pt; }
  .sigs { display: flex; gap: 40pt; margin-top: 48pt; page-break-inside: avoid; }
  .sig { flex: 1; border-top: 1px solid #111; padding-top: 4pt; font-size: 10pt; }
  .foot { margin-top: 18pt; font-size: 9pt; color: #555; }
  .worker { page-break-inside: avoid; }
</style></head><body>
  <h1>${escHtml(t('punch.attestationTitle'))}</h1>
  <p class="meta"><b>${escHtml(storeName)}</b></p>
  ${subtitle ? `<p class="meta">${subtitle}</p>` : ''}
  <p class="meta"><b>${escHtml(t('punch.period'))} :</b> ${escHtml(periodFrom)} → ${escHtml(periodTo)}</p>
  ${sectionsHtml}
  <div class="sigs">
    <div class="sig">${escHtml(t('punch.attestationSigManager'))}<br><br>${escHtml(t('punch.attestationDate'))} : _______________</div>
    <div class="sig">${escHtml(t('punch.attestationSigWorker'))}<br><br>${escHtml(t('punch.attestationDate'))} : _______________</div>
  </div>
  <p class="foot">${escHtml(t('punch.attestationGenerated', { day: new Date().toLocaleDateString(loc) }))}</p>
</body></html>`;
}

function printHtmlDoc(html) {
  const iframe = document.createElement('iframe');
  iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden;';
  document.body.appendChild(iframe);
  try {
    const doc = iframe.contentDocument || iframe.contentWindow.document;
    doc.open();
    doc.write(html);
    doc.close();
    setTimeout(() => {
      try {
        iframe.contentWindow.focus();
        iframe.contentWindow.print();
      } catch {
        /* print dialog unavailable */
      }
    }, 350);
  } finally {
    setTimeout(() => iframe.remove(), 4000);
  }
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-os border border-osborder bg-paper p-5 shadow-oswin"
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

/* ------------------ time-off request modal (shared) ------------------ */

function kindKey(k) {
  return `punch.kind${k === 'sick' ? 'Sick' : k === 'unpaid' ? 'Unpaid' : 'Vacation'}`;
}

function TimeOffRequestModal({ store, staffList, presetStaff, pinHash, onClose, onDone }) {
  const { t } = useLang();
  const [staffId, setStaffId] = useState(presetStaff?.id || staffList[0]?.id || '');
  const [from, setFrom] = useState(todayYMD());
  const [to, setTo] = useState(todayYMD());
  const [kind, setKind] = useState('vacation');
  const [reason, setReason] = useState('');
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!from || !to) return;
    setBusy(true);
    setError('');
    try {
      const hash = pinHash || (await sha256hex(pin));
      await backend.pos.submitTimeOff(store.id, hash, { from, to, kind, reason });
      onDone?.();
    } catch (err) {
      setError(err.message === 'Invalid PIN.' ? t('punch.pinInvalid') : err.message === 'PIN_THROTTLED' ? t('punch.pinThrottled') : (err.message || t('punch.requestFail')));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={t('punch.newRequest')} onClose={onClose}>
      <div className="space-y-3">
        {presetStaff ? (
          <p className="text-sm font-medium text-ink">{presetStaff.name}</p>
        ) : (
          <p className="text-xs text-muted">{t('punch.requestPinHint')}</p>
        )}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-muted">{t('punch.requestFrom')}</label>
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={inputCls} />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted">{t('punch.requestTo')}</label>
            <input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} className={inputCls} />
          </div>
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-muted">{t('punch.kindLabel')}</label>
          <select value={kind} onChange={(e) => setKind(e.target.value)} className={inputCls}>
            <option value="vacation">{t('punch.kindVacation')}</option>
            <option value="sick">{t('punch.kindSick')}</option>
            <option value="unpaid">{t('punch.kindUnpaid')}</option>
          </select>
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-muted">{t('punch.reason')}</label>
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t('punch.reasonPh')} className={inputCls} />
        </div>
        {!pinHash && (
          <div>
            <label className="mb-1 block text-xs font-medium text-muted">{t('punch.requestPin')}</label>
            <input
              type="password"
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/[^0-9]/g, '').slice(0, 8))}
              inputMode="numeric"
              placeholder={t('punch.pinPh')}
              className={inputCls}
            />
          </div>
        )}
        <ErrorNote message={error} />
        <button
          type="button"
          onClick={submit}
          disabled={busy || (!pinHash && pin.length < 4)}
          className="w-full rounded-os bg-accent px-4 py-2.5 text-sm font-semibold text-accentink hover:opacity-90 disabled:opacity-50"
        >
          {busy ? t('punch.recording') : t('punch.newRequest')}
        </button>
      </div>
    </Modal>
  );
}

/* ------------------------- punch terminal ------------------------- */

function TerminalTab({ store, onPunched }) {
  const { t, lang } = useLang();
  const [who, setWho] = useState(null); // PIN-verified staff { id, name, role, pinHash }
  const [pin, setPin] = useState('');
  const [openPunch, setOpenPunch] = useState(null);
  const [openBreak, setOpenBreak] = useState(null);
  const [presence, setPresence] = useState([]); // who's-in entries + absentees
  const [settings, setSettings] = useState({ weekStart: 'monday', paidBreakMin: 15, unpaidBreakMin: 30, graceMin: 15 });
  const [showLeave, setShowLeave] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [nowTick, setNowTick] = useState(Date.now());
  const actionLock = useRef(false); // synchronous double-submit lock for punch/break actions

  const roleLabel = (r) => t(`punch.role${r === 'owner' ? 'Owner' : r === 'manager' ? 'Manager' : r === 'cashier' ? 'Cashier' : 'Unknown'}`);

  useEffect(() => {
    const id = setInterval(() => setNowTick(Date.now()), 30000);
    return () => clearInterval(id);
  }, []);

  const loadSettings = useCallback(async () => {
    try {
      setSettings(await backend.pos.getPunchSettings(store.id));
    } catch {
      /* keep defaults */
    }
  }, [store.id]);

  // Live "who's in": on time / late / on break / absent vs today's schedule.
  const loadPresence = useCallback(async () => {
    try {
      const dayStart = new Date();
      dayStart.setHours(0, 0, 0, 0);
      const ymd = todayYMD();
      const [punches, shifts, breaks, stRaw, staffList] = await Promise.all([
        backend.pos.listPunches(store.id, { from: dayStart.toISOString(), limit: 500 }),
        backend.pos.listShifts(store.id, { from: ymd, to: ymd }),
        backend.pos.listBreaks(store.id, { from: dayStart.toISOString() }),
        backend.pos.getPunchSettings(store.id).catch(() => ({ graceMin: 15 })),
        backend.pos.listStaff(store.id).catch(() => []),
      ]);
      // NUCLEAR FAILSAFE: null-guard settings (catch handles rejections, not falsy resolutions).
      const st = stRaw || { graceMin: 15 };
      const workerTypeOf = new Map(staffList.map((s) => [s.id, s.workerType === 'community' ? 'community' : 'employee']));
      const seen = new Map();
      for (const p of punches) {
        if (!p.punchOut && !seen.has(p.staffId)) seen.set(p.staffId, p);
      }
      const shiftByStaff = new Map();
      for (const s of shifts) {
        if (!shiftByStaff.has(s.staffId)) shiftByStaff.set(s.staffId, s);
      }
      const openBreakByStaff = new Map();
      for (const b of breaks) {
        if (!b.end && !openBreakByStaff.has(b.staffId)) openBreakByStaff.set(b.staffId, b);
      }
      const entries = [];
      for (const p of seen.values()) {
        const sh = shiftByStaff.get(p.staffId);
        const ob = openBreakByStaff.get(p.staffId);
        let status = 'ontime';
        if (ob) status = 'break';
        else if (sh && new Date(p.punchIn).getTime() > shiftStartMs(sh) + st.graceMin * MS_MIN) status = 'late';
        entries.push({ kind: 'staff', staffId: p.staffId, staffName: p.staffName, workerType: workerTypeOf.get(p.staffId) || 'employee', punchIn: p.punchIn, shift: sh, break: ob, status });
      }
      // Absent: scheduled today, shift already started, nobody clocked in.
      const nowMs = Date.now();
      for (const s of shifts) {
        if (seen.has(s.staffId)) continue;
        if (shiftStartMs(s) <= nowMs) {
          entries.push({ kind: 'absent', staffId: s.staffId, staffName: s.staffName, shift: s, status: 'absent' });
        }
      }
      const order = { late: 0, break: 1, ontime: 2, absent: 3 };
      entries.sort((a, b) => order[a.status] - order[b.status]);
      setPresence(entries);
    } catch {
      setPresence([]);
    }
  }, [store.id]);

  const loadOpenBreak = useCallback(async (staffId) => {
    try {
      setOpenBreak(await backend.pos.getOpenBreak(store.id, staffId));
    } catch {
      setOpenBreak(null);
    }
  }, [store.id]);

  useEffect(() => { loadPresence(); loadSettings(); }, [loadPresence, loadSettings]);

  const press = (d) => setPin((p) => (p.length >= 8 ? p : p + d));

  const submitPin = async () => {
    if (pin.length < 4) return;
    setBusy(true);
    setError('');
    try {
      const staff = await backend.pos.staffLogin(store.id, pin);
      setWho(staff);
      setPin('');
      setOpenPunch(await backend.pos.getOpenPunch(store.id, staff.id));
      await loadOpenBreak(staff.id);
    } catch (err) {
      setError(err.message === 'Invalid PIN.' ? t('punch.pinInvalid') : err.message === 'PIN_THROTTLED' ? t('punch.pinThrottled') : (err.message || t('punch.pinVerifyFail')));
    } finally {
      setBusy(false);
    }
  };

  const punch = async () => {
    if (!who) return;
    if (actionLock.current) return; // block rapid double-click double punches
    actionLock.current = true;
    setBusy(true);
    setError('');
    try {
      if (openPunch) {
        await backend.pos.clockOut(store.id, who.pinHash);
        setOpenPunch(null);
        setOpenBreak(null); // clocking out ends any running break (server-side too)
      } else {
        setOpenPunch(await backend.pos.clockIn(store.id, who.pinHash));
      }
      await loadPresence();
      onPunched?.();
    } catch (err) {
      setError(err.message || t('punch.punchFail'));
    } finally {
      actionLock.current = false;
      setBusy(false);
    }
  };

  const toggleBreak = async (type) => {
    if (!who) return;
    if (actionLock.current) return; // block rapid double-click double breaks
    actionLock.current = true;
    setBusy(true);
    setError('');
    try {
      if (openBreak) {
        await backend.pos.endBreak(store.id, who.pinHash);
        setOpenBreak(null); // ended break object is truthy — clear explicitly
      } else {
        setOpenBreak(await backend.pos.startBreak(store.id, who.pinHash, type));
      }
      await loadPresence();
      onPunched?.();
    } catch (err) {
      setError(err.message === 'Not punched in.' ? t('punch.notOnShift') : (err.message || t('punch.breakFail')));
    } finally {
      actionLock.current = false;
      setBusy(false);
    }
  };

  const switchPerson = () => {
    setWho(null);
    setOpenPunch(null);
    setOpenBreak(null);
    setPin('');
    setError('');
  };

  const statusMeta = {
    ontime: { dot: 'bg-emerald-500', label: t('punch.statusOnTime') },
    late: { dot: 'bg-red-500', label: t('punch.statusLate') },
    break: { dot: 'bg-amber-500', label: t('punch.statusOnBreak') },
    absent: { dot: 'bg-muted', label: t('punch.statusAbsent') },
  };

  const breakOver = openBreak && openBreak.allottedMin > 0
    && (nowTick - new Date(openBreak.start).getTime()) > openBreak.allottedMin * MS_MIN;

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="rounded-os border border-osborder bg-paper p-4">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-ink">
          <Clock3 size={15} className="text-accent" /> {t('punch.terminalTitle')}
        </h3>
        <p className="mt-0.5 text-xs text-muted">{t('punch.terminalHint')}</p>
        <div className="mt-3"><ErrorNote message={error} /></div>

        {!who ? (
          <div className="mt-2">
            <div className="mb-3 flex justify-center" aria-label={t('punch.pinLabel')}>
              <div className="flex gap-2">
                {Array.from({ length: 8 }).map((_, i) => (
                  <div
                    key={i}
                    className={`h-4 w-4 rounded-full border ${
                      i < pin.length ? 'border-accent bg-accent' : 'border-osborder'
                    }`}
                  />
                ))}
              </div>
            </div>
            <div className="mx-auto grid max-w-[240px] grid-cols-3 gap-2">
              {PAD_KEYS.map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => press(d)}
                  className="rounded-os bg-surface py-3 text-xl font-semibold text-ink duration-160 hover:bg-osborder/40"
                >
                  {d}
                </button>
              ))}
              <button
                type="button"
                onClick={() => setPin((p) => p.slice(0, -1))}
                aria-label={t('punch.pinLabel')}
                className="rounded-os bg-surface py-3 text-sm font-semibold text-muted duration-160 hover:text-ink"
              >
                ⌫
              </button>
              <button
                type="button"
                onClick={submitPin}
                disabled={busy || pin.length < 4}
                className="rounded-os bg-accent py-3 text-sm font-semibold text-accentink duration-160 hover:opacity-90 disabled:opacity-40"
              >
                {busy ? '…' : 'OK'}
              </button>
              <button
                type="button"
                onClick={() => setPin('')}
                className="rounded-os bg-surface py-3 text-sm font-semibold text-muted duration-160 hover:text-ink"
              >
                {t('punch.clearPad')}
              </button>
            </div>
          </div>
        ) : (
          <div className="mt-3 rounded-os border border-osborder bg-surface p-4 text-center">
            <p className="text-lg font-semibold text-ink">{who.name}</p>
            <p className="text-xs text-muted">{roleLabel(who.role)}</p>
            {openPunch ? (
              <p className="mt-2 text-sm text-ink">
                {t('punch.onShiftSince')} <span className="font-medium">{fmtTime(openPunch.punchIn)}</span>
                <span className="text-muted"> · {fmtDur(nowTick - new Date(openPunch.punchIn).getTime())} {t('punch.soFar')}</span>
              </p>
            ) : (
              <p className="mt-2 text-sm text-muted">{t('punch.notOnShift')}</p>
            )}

            {openPunch && !openBreak && (
              <div className="mt-3 grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => toggleBreak('paid')}
                  disabled={busy}
                  className="flex items-center justify-center gap-1.5 rounded-os border border-osborder px-3 py-2 text-xs font-semibold text-ink hover:border-accent disabled:opacity-50"
                >
                  <Coffee size={14} /> {t('punch.breakStartPaid')} ({settings.paidBreakMin} min)
                </button>
                <button
                  type="button"
                  onClick={() => toggleBreak('unpaid')}
                  disabled={busy}
                  className="flex items-center justify-center gap-1.5 rounded-os border border-osborder px-3 py-2 text-xs font-semibold text-ink hover:border-accent disabled:opacity-50"
                >
                  <Coffee size={14} /> {t('punch.breakStartUnpaid')} ({settings.unpaidBreakMin} min)
                </button>
              </div>
            )}

            {openPunch && openBreak && (
              <div className={`mt-3 rounded-os border px-3 py-2.5 ${breakOver ? 'border-red-500/40 bg-red-500/10' : 'border-amber-500/40 bg-amber-500/10'}`}>
                <p className="flex items-center justify-center gap-1.5 text-sm font-medium text-ink">
                  <Pause size={14} /> {t('punch.statusOnBreak')} · {fmtDur(nowTick - new Date(openBreak.start).getTime())}
                </p>
                {breakOver && (
                  <p className="mt-1 text-xs font-medium text-red-600">
                    {t('punch.breakOverWarn', { min: openBreak.allottedMin })}
                  </p>
                )}
                <button
                  type="button"
                  onClick={() => toggleBreak()}
                  disabled={busy}
                  className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-os bg-amber-500/20 px-3 py-2 text-xs font-semibold text-ink hover:bg-amber-500/30 disabled:opacity-50"
                >
                  <Play size={14} /> {t('punch.breakEnd')}
                </button>
              </div>
            )}

            <button
              type="button"
              onClick={punch}
              disabled={busy}
              className={`mt-3 w-full rounded-os px-4 py-3 text-base font-semibold duration-160 disabled:opacity-50 ${
                openPunch
                  ? 'bg-red-500/15 text-red-600 hover:bg-red-500/25'
                  : 'bg-accent text-accentink hover:opacity-90'
              }`}
            >
              {busy ? t('punch.recording') : openPunch ? t('punch.clockOut') : t('punch.clockIn')}
            </button>
            <button
              type="button"
              onClick={() => setShowLeave(true)}
              className="mt-2 w-full py-1 text-xs font-medium text-muted hover:text-ink"
            >
              {t('punch.newRequest')}
            </button>
            <button
              type="button"
              onClick={switchPerson}
              className="mt-1 w-full py-1 text-xs text-muted hover:text-ink"
            >
              {t('punch.notYou', { name: who.name })} {t('punch.switchPerson')}
            </button>
          </div>
        )}
      </div>

      <div className="rounded-os border border-osborder bg-paper p-4">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-ink">
          <Users size={15} className="text-accent" /> {t('punch.onShiftNow')}
        </h3>
        {presence.length === 0 ? (
          <p className="py-6 text-center text-xs text-muted">{t('punch.nobodyOnShift')}</p>
        ) : (
          <ul className="mt-2 divide-y divide-osborder">
            {presence.map((p) => {
              const meta = statusMeta[p.status];
              return (
                <li key={`${p.status}-${p.staffId}`} className="flex items-center justify-between gap-2 py-2">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${meta.dot}`} />
                    <span className="truncate text-sm text-ink">{p.staffName}</span>
                    {p.workerType === 'community' && (
                      <span className="shrink-0 rounded-full bg-accent/15 px-1.5 py-0.5 text-[10px] font-medium text-accent">
                        {t('punch.typeCommunity')}
                      </span>
                    )}
                    <span className="shrink-0 text-[11px] font-medium text-muted">{meta.label}</span>
                  </span>
                  <span className="shrink-0 text-xs text-muted">
                    {p.kind === 'staff' ? (
                      <>
                        {t('punch.since')} {fmtTime(p.punchIn)}
                        {p.status === 'break' && p.break && (
                          <> · {t(`punch.break${p.break.type === 'paid' ? 'PaidWord' : 'UnpaidWord'}`)} {fmtDur(nowTick - new Date(p.break.start).getTime())}</>
                        )}
                      </>
                    ) : (
                      <>{t('punch.shiftStart')}: {p.shift.start}</>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {showLeave && who && (
        <TimeOffRequestModal
          store={store}
          staffList={[]}
          presetStaff={who}
          pinHash={who.pinHash}
          onClose={() => setShowLeave(false)}
          onDone={() => { setShowLeave(false); onPunched?.(); }}
        />
      )}
    </div>
  );
}

/* --------------------------- timesheets --------------------------- */

function auditLabel(t, a) {
  switch (a.action) {
    case 'delete': return t('punch.auditDelete');
    case 'period_approve': return t('punch.auditApprove');
    case 'period_unlock': return t('punch.auditUnlock');
    case 'timeoff_request': return t('punch.auditTimeOffReq');
    case 'timeoff_decide': return t('punch.auditTimeOffDec');
    default: return t('punch.auditCorrection');
  }
}

function auditDetail(t, a) {
  if (a.action === 'period_approve' || a.action === 'period_unlock') {
    return t('punch.periodRange', { from: a.periodFrom, to: a.periodTo });
  }
  if (a.action === 'timeoff_request' || a.action === 'timeoff_decide') {
    const kind = t(kindKey(a.kind));
    const who = a.staffName ? ` — ${a.staffName}` : '';
    return `${kind}: ${a.fromYmd} → ${a.toYmd}${who}`;
  }
  return (
    <span className="block">
      {a.oldPunchIn ? fmtTime(a.oldPunchIn) : '—'}–{a.oldPunchOut ? fmtTime(a.oldPunchOut) : '…'}
      {' → '}
      {a.newPunchIn ? fmtTime(a.newPunchIn) : '—'}–{a.newPunchOut ? fmtTime(a.newPunchOut) : '…'}
    </span>
  );
}

function auditActor(t, a) {
  if (a.editedBy === 'owner') return t('punch.roleOwner');
  if (a.editedBy === 'manager') return t('punch.roleManager');
  return a.editedBy || t('punch.managerWord');
}

function TimesheetTab({ store, refreshKey }) {
  const { t, lang } = useLang();
  const [punches, setPunches] = useState([]);
  const [breaks, setBreaks] = useState([]);
  const [settings, setSettings] = useState({ weekStart: 'monday' });
  const [staffList, setStaffList] = useState([]);
  const [from, setFrom] = useState(todayYMD());
  const [to, setTo] = useState(todayYMD());
  const [preset, setPreset] = useState('today');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [nowTick, setNowTick] = useState(Date.now());
  const [correcting, setCorrecting] = useState(null);
  const [corrIn, setCorrIn] = useState('');
  const [corrOut, setCorrOut] = useState('');
  const [showAudits, setShowAudits] = useState(false);
  const [audits, setAudits] = useState([]);
  const [showLeave, setShowLeave] = useState(false);
  const [confirmDeletePunch, setConfirmDeletePunch] = useState(null);

  const manager = canManage(store.role);

  const load = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      // NUCLEAR FAILSAFE: fail closed on invalid range dates — never query
      // with a guessed range.
      const fromISO = dayStartISO(from);
      const toISO = dayEndISO(to);
      if (!fromISO || !toISO) throw new Error(t('punch.invalidRange'));
      const [rows, br, st, staff] = await Promise.all([
        backend.pos.listPunches(store.id, { from: fromISO, to: toISO, limit: 1000 }),
        backend.pos.listBreaks(store.id, { from: fromISO, to: toISO }),
        backend.pos.getPunchSettings(store.id),
        backend.pos.listStaff(store.id).catch(() => []),
      ]);
      setPunches(rows);
      setBreaks(br);
      setSettings(st || DEFAULT_PUNCH_SETTINGS);
      setStaffList(staff.filter((s) => s.active !== false));
    } catch (err) {
      setError(err.message === 'Pay period is locked.' ? t('punch.periodLockedErr') : (err.message || t('punch.loadFail')));
    } finally {
      setBusy(false);
    }
  }, [store.id, from, to, t]);

  useEffect(() => { load(); }, [load, refreshKey]);
  useEffect(() => {
    const id = setInterval(() => setNowTick(Date.now()), 60000);
    return () => clearInterval(id);
  }, []);

  const applyPreset = (id) => {
    setPreset(id);
    const today = todayYMD();
    if (id === 'today') { setFrom(today); setTo(today); }
    if (id === 'week') {
      const d = new Date();
      d.setDate(d.getDate() - 6);
      const pad = (n) => String(n).padStart(2, '0');
      setFrom(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`);
      setTo(today);
    }
  };

  // Regular vs overtime per employee (Québec 40 h/week rule), net of unpaid breaks.
  // Community-service hours are tracked separately and excluded here.
  const communityIds = useMemo(
    () => new Set(staffList.filter((s) => s.workerType === 'community').map((s) => s.id)),
    [staffList]
  );
  const totals = useMemo(
    () => weeklyPay(punches, breaks, settings.weekStart, nowTick, communityIds),
    [punches, breaks, settings.weekStart, nowTick, communityIds]
  );
  const communityTotals = useMemo(() => {
    const byId = {};
    for (const p of punches) {
      if (!communityIds.has(p.staffId)) continue;
      const ms = punchNetMs(p, breaks, nowTick);
      // NUCLEAR FAILSAFE: include staffName so community workers show names (not blank).
      if (!byId[p.staffId]) byId[p.staffId] = { staffId: p.staffId, name: p.staffName || '', ms: 0, breaks: 0, shifts: 0 };
      byId[p.staffId].ms += ms;
      byId[p.staffId].shifts += 1;
    }
    for (const b of breaks) {
      if (!communityIds.has(b.staffId)) continue;
      if (byId[b.staffId]) byId[b.staffId].breaks += 1;
    }
    return Object.values(byId);
  }, [punches, breaks, nowTick, communityIds]);

  const lockedErr = (err) => (err.message === 'Pay period is locked.' ? t('punch.periodLockedErr') : (err.message || t('punch.punchFail')));

  // NUCLEAR FAILSAFE: localize backend correction error codes (see
  // correctPunch in supabase.js). Raw English DB messages never reach the user.
  const corrErr = (err) => {
    const m = err?.message || '';
    switch (m) {
      case 'CORR_PERIOD_LOCKED': return t('punch.periodLockedErr');
      case 'CORR_EXCEEDS_24H': return t('punch.corrExceeds24h');
      case 'CORR_OUT_BEFORE_IN': return t('punch.corrOutAfterIn');
      case 'CORR_IN_FUTURE': return t('punch.corrInFuture');
      case 'CORR_OUT_FUTURE': return t('punch.corrOutFuture');
      case 'CORR_NOT_FOUND': return t('punch.corrNotFound');
      case 'CORR_MANAGERS_ONLY': return t('punch.managersOnly');
      case 'CORR_SIGNIN': return t('punch.corrSignin');
      default: return lockedErr(err);
    }
  };

  const openCorrect = (p) => {
    setCorrecting(p);
    setCorrIn(toLocalInput(p.punchIn));
    setCorrOut(p.punchOut ? toLocalInput(p.punchOut) : '');
    setError('');
  };

  const saveCorrection = async () => {
    if (!correcting) return;
    setBusy(true);
    setError('');
    try {
      // NUCLEAR FAILSAFE: validate datetimes BEFORE converting. An empty or
      // malformed input used to throw a raw "Invalid time value" RangeError.
      const inMs = Date.parse(corrIn);
      if (!corrIn || Number.isNaN(inMs)) throw new Error(t('punch.corrInvalidIn'));
      let outISO = null;
      if (corrOut) {
        const outMs = Date.parse(corrOut);
        if (Number.isNaN(outMs)) throw new Error(t('punch.corrInvalidOut'));
        outISO = new Date(outMs).toISOString();
      }
      await backend.pos.correctPunch(store.id, correcting.id, {
        punchIn: new Date(inMs).toISOString(),
        punchOut: outISO,
      });
      setCorrecting(null);
      await load();
    } catch (err) {
      setError(corrErr(err));
    } finally {
      setBusy(false);
    }
  };

  const removePunch = async (p) => {
    if (!p) return;
    setBusy(true);
    setError('');
    try {
      await backend.pos.deletePunch(store.id, p.id);
      await load();
    } catch (err) {
      setError(lockedErr(err));
    } finally {
      setBusy(false);
    }
  };

  const toggleAudits = async () => {
    if (!showAudits) {
      try {
        setAudits(await backend.pos.listPunchAudits(store.id, { limit: 50 }));
      } catch {
        setAudits([]);
      }
    }
    setShowAudits(!showAudits);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 rounded-os border border-osborder bg-paper p-3">
        <div className="flex gap-1 rounded-os bg-surface p-0.5">
          {[
            { id: 'today', label: t('punch.today') },
            { id: 'week', label: t('punch.last7') },
            { id: 'custom', label: t('punch.custom') },
          ].map((r) => (
            <button
              key={r.id}
              type="button"
              onClick={() => applyPreset(r.id)}
              className={`rounded-os px-2.5 py-1 text-xs font-medium duration-160 ${
                preset === r.id ? 'bg-paper text-ink shadow-os' : 'text-muted hover:text-ink'
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>
        {preset === 'custom' && (
          <div className="flex items-center gap-2 text-xs text-muted">
            <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} className={inputCls + ' w-auto'} />
            <span>→</span>
            <input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} className={inputCls + ' w-auto'} />
          </div>
        )}
        <button
          type="button"
          onClick={load}
          disabled={busy}
          className="rounded-os border border-osborder px-3 py-1.5 text-xs font-medium text-ink hover:border-accent disabled:opacity-50"
        >
          {busy ? '…' : t('common.refresh')}
        </button>
        <button
          type="button"
          onClick={() => setShowLeave(true)}
          className="rounded-os border border-osborder px-3 py-1.5 text-xs font-medium text-ink hover:border-accent"
        >
          {t('punch.newRequest')}
        </button>
        {manager && (
          <button
            type="button"
            onClick={toggleAudits}
            className="ml-auto flex items-center gap-1.5 rounded-os px-2 py-1.5 text-xs font-medium text-muted hover:bg-surface hover:text-ink"
          >
            <History size={13} /> {showAudits ? t('punch.hideAuditLog') : t('punch.auditLog')}
          </button>
        )}
      </div>

      <ErrorNote message={error} />

      <div className="rounded-os border border-osborder bg-paper p-4">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-ink">
          <BarChart3 size={15} className="text-accent" /> {t('punch.hoursByEmployee')}
        </h3>
        <p className="mt-0.5 text-[11px] text-muted">{t('punch.otNote')}</p>
        {totals.length === 0 ? (
          <p className="py-3 text-center text-xs text-muted">{t('punch.noPunches')}</p>
        ) : (
          <ul className="divide-y divide-osborder">
            {totals.map((x) => (
              <li key={x.staffId} className="flex items-center justify-between gap-2 py-2">
                <span className="min-w-0 text-sm text-ink">
                  <span className="truncate">{x.name}</span>
                  <span className="ml-1.5 text-xs text-muted">
                    {x.shifts} {x.shifts === 1 ? t('punch.shift') : t('punch.shifts')}
                  </span>
                </span>
                <span className="shrink-0 text-right text-xs text-muted">
                  {fmtDur(x.regMs)} <span className="font-medium text-muted">{t('punch.regularShort')}</span>
                  {x.otMs > 0 && (
                    <span className="ml-2 font-semibold text-accent">
                      {fmtDur(x.otMs)} {t('punch.overtimeShort')}
                    </span>
                  )}
                  <span className="ml-2 text-sm font-semibold text-ink">{fmtDur(x.regMs + x.otMs)}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {communityTotals.length > 0 && (
        <div className="rounded-os border border-osborder bg-paper p-4">
          <h3 className="text-sm font-semibold text-ink">{t('punch.communitySectionPunch')}</h3>
          <p className="mt-0.5 text-[11px] text-muted">{t('punch.communityPunchNote')}</p>
          <ul className="divide-y divide-osborder">
            {communityTotals.map((x) => {
              const s = staffList.find((st) => st.id === x.staffId);
              return (
                <li key={x.staffId} className="flex items-center justify-between gap-2 py-2">
                  <span className="min-w-0 text-sm text-ink">
                    <span className="truncate">{x.name}</span>
                    {s && s.organization && (
                      <span className="ml-1.5 text-xs text-muted">{s.organization}</span>
                    )}
                    <span className="ml-1.5 text-xs text-muted">
                      {x.shifts} {x.shifts === 1 ? t('punch.shift') : t('punch.shifts')}
                    </span>
                  </span>
                  <span className="shrink-0 text-sm font-semibold text-ink">{fmtDur(x.ms)}</span>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {showAudits && manager && (
        <div className="rounded-os border border-osborder bg-paper p-4">
          <h3 className="text-sm font-semibold text-ink">{t('punch.auditLog')}</h3>
          {audits.length === 0 ? (
            <p className="py-3 text-center text-xs text-muted">{t('punch.noAudits')}</p>
          ) : (
            <ul className="mt-2 space-y-2">
              {audits.map((a) => (
                <li key={a.id} className="rounded-os bg-surface px-3 py-2 text-xs text-muted">
                  <span className="font-medium text-ink">{auditLabel(t, a)}</span>
                  {' '}· {auditActor(t, a)} · {a.createdAt ? `${fmtDay(a.createdAt, lang)} ${fmtTime(a.createdAt)}` : '—'}
                  <span className="block">{auditDetail(t, a)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="rounded-os border border-osborder bg-paper p-4">
        <h3 className="mb-2 text-sm font-semibold text-ink">{t('punch.punches')}</h3>
        {punches.length === 0 ? (
          <p className="py-3 text-center text-xs text-muted">{t('punch.noPunches')}</p>
        ) : (
          <ul className="divide-y divide-osborder">
            {punches.map((p) => (
              <li key={p.id} className="flex items-center justify-between gap-2 py-2">
                <div className="min-w-0">
                  <p className="truncate text-sm text-ink">
                    {p.staffName}
                    <span className="ml-1.5 text-xs text-muted">{fmtDay(p.punchIn, lang)}</span>
                  </p>
                  <p className="text-xs text-muted">
                    {fmtTime(p.punchIn)} → {p.punchOut ? fmtTime(p.punchOut) : <span className="font-medium text-accent">{t('punch.onShiftBadge')}</span>}
                    <span className="ml-1.5">
                      ({fmtDur(punchNetMs(p, breaks, nowTick))})
                    </span>
                  </p>
                </div>
                {manager && (
                  <div className="flex shrink-0 gap-1">
                    <button
                      type="button"
                      onClick={() => openCorrect(p)}
                      className="rounded-os p-1.5 text-muted hover:bg-surface hover:text-ink"
                      aria-label={t('punch.correct')}
                    >
                      <Pencil size={14} />
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmDeletePunch(p)}
                      className="rounded-os p-1.5 text-muted hover:bg-red-500/10 hover:text-red-600"
                      aria-label={t('common.delete')}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {correcting && (
        <Modal title={t('punch.correctTitle', { name: correcting.staffName })} onClose={() => setCorrecting(null)}>
          <div className="space-y-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-muted">{t('punch.punchInLabel')}</label>
              <input type="datetime-local" value={corrIn} onChange={(e) => setCorrIn(e.target.value)} className={inputCls} />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted">{t('punch.punchOutLabel')}</label>
              <input type="datetime-local" value={corrOut} onChange={(e) => setCorrOut(e.target.value)} className={inputCls} />
            </div>
            <p className="text-[11px] text-muted">{t('punch.auditNote')}</p>
            <button
              type="button"
              onClick={saveCorrection}
              disabled={busy || !corrIn}
              className="w-full rounded-os bg-accent px-4 py-2.5 text-sm font-semibold text-accentink hover:opacity-90 disabled:opacity-50"
            >
              {busy ? t('punch.recording') : t('punch.saveCorrection')}
            </button>
          </div>
        </Modal>
      )}

      {showLeave && (
        <TimeOffRequestModal
          store={store}
          staffList={staffList}
          onClose={() => setShowLeave(false)}
          onDone={() => setShowLeave(false)}
        />
      )}

      {confirmDeletePunch && (
        <Modal title={t('punch.deletePunchTitle')} onClose={() => setConfirmDeletePunch(null)}>
          <p className="text-sm text-muted">
            {t('punch.deleteConfirm', { name: confirmDeletePunch.staffName, day: fmtDay(confirmDeletePunch.punchIn, lang) })}
          </p>
          <div className="mt-4 flex gap-2">
            <button
              type="button"
              onClick={() => setConfirmDeletePunch(null)}
              className="flex-1 rounded-os border border-osborder px-4 py-2 text-sm font-medium text-ink hover:border-accent"
            >
              {t('common.cancel')}
            </button>
            <button
              type="button"
              onClick={() => { const p = confirmDeletePunch; setConfirmDeletePunch(null); removePunch(p); }}
              disabled={busy}
              className="flex-1 rounded-os bg-red-500/15 px-4 py-2.5 text-sm font-semibold text-red-600 hover:bg-red-500/25 disabled:opacity-50"
            >
              {busy ? '…' : t('common.delete')}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

/* --------------------------- scheduling --------------------------- */

function ShiftModal({ store, staffList, shifts = [], initial, onClose, onSaved }) {
  const { t } = useLang();
  const [staffId, setStaffId] = useState(initial?.staffId || staffList[0]?.id || '');
  const [ymd, setYmd] = useState(initial?.ymd || todayYMD());
  const [start, setStart] = useState(initial?.start || '09:00');
  const [end, setEnd] = useState(initial?.end || '17:00');
  const [note, setNote] = useState(initial?.note || '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const save = async () => {
    if (!staffId || !ymd || !start || !end) return;
    // Block overlapping shifts for the same staff on the same day.
    // Overnight shifts (end <= start) span into the next day; treat them as
    // [start, 24:00) for overlap purposes on the start day.
    const toMin = (hhmm) => {
      const [h, m] = hhmm.split(':').map(Number);
      return h * 60 + m;
    };
    const ns = toMin(start), ne = toMin(end);
    const nEnd = ne <= ns ? 24 * 60 : ne; // overnight wraps
    const overlap = shifts.some((s) => {
      if (s.staffId !== staffId || s.ymd !== ymd) return false;
      if (initial?.id && s.id === initial.id) return false; // editing self
      const es = toMin(s.start), ee = toMin(s.end);
      const eEnd = ee <= es ? 24 * 60 : ee;
      return ns < eEnd && es < nEnd;
    });
    if (overlap) {
      setError(t('punch.shiftOverlap', 'This staff member already has a shift overlapping this time.'));
      return;
    }
    setBusy(true);
    setError('');
    try {
      await backend.pos.saveShift(store.id, { id: initial?.id, staffId, ymd, start, end, note });
      onSaved?.();
    } catch (err) {
      const msg = err.message === 'Shift end time must differ from start time.' ? t('punch.shiftEndDiffers') : (err.message || t('punch.shiftFail'));
      setError(msg);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!initial?.id) return;
    setBusy(true);
    setError('');
    try {
      await backend.pos.deleteShift(store.id, initial.id);
      onSaved?.();
    } catch (err) {
      setError(err.message || t('punch.shiftFail'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
    <Modal title={initial?.id ? t('punch.editShift') : t('punch.addShift')} onClose={onClose}>
      <div className="space-y-3">
        <div>
          <label className="mb-1 block text-xs font-medium text-muted">{t('punch.shiftWho')}</label>
          <select value={staffId} onChange={(e) => setStaffId(e.target.value)} className={inputCls}>
            {staffList.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-muted">{t('punch.shiftDate')}</label>
          <input type="date" value={ymd} onChange={(e) => setYmd(e.target.value)} className={inputCls} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-muted">{t('punch.shiftStart')}</label>
            <input type="time" value={start} onChange={(e) => setStart(e.target.value)} className={inputCls} />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted">{t('punch.shiftEnd')}</label>
            <input type="time" value={end} onChange={(e) => setEnd(e.target.value)} className={inputCls} />
          </div>
        </div>
        {/* NUCLEAR FAILSAFE: overnight shifts (end <= start = next day) are supported. */}
        <p className="text-xs text-muted">{t('punch.shiftOvernightHint')}</p>
        <div>
          <label className="mb-1 block text-xs font-medium text-muted">{t('punch.shiftNote')}</label>
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('punch.shiftNotePh')} className={inputCls} />
        </div>
        <ErrorNote message={error} />
        <div className="flex gap-2">
          {initial?.id && (
            <button
              type="button"
              onClick={() => setConfirmDelete(true)}
              disabled={busy}
              className="rounded-os bg-red-500/15 px-4 py-2.5 text-sm font-semibold text-red-600 hover:bg-red-500/25 disabled:opacity-50"
            >
              {t('common.delete')}
            </button>
          )}
          <button
            type="button"
            onClick={save}
            disabled={busy}
            className="flex-1 rounded-os bg-accent px-4 py-2.5 text-sm font-semibold text-accentink hover:opacity-90 disabled:opacity-50"
          >
            {busy ? t('punch.recording') : t('common.save')}
          </button>
        </div>
      </div>
    </Modal>
      {confirmDelete && (
        <Modal title={t('punch.deleteShiftTitle')} onClose={() => setConfirmDelete(false)}>
          <p className="text-sm text-muted">{t('punch.deleteShiftConfirm')}</p>
          <div className="mt-4 flex gap-2">
            <button
              type="button"
              onClick={() => setConfirmDelete(false)}
              className="flex-1 rounded-os border border-osborder px-4 py-2 text-sm font-medium text-ink hover:border-accent"
            >
              {t('common.cancel')}
            </button>
            <button
              type="button"
              onClick={() => { setConfirmDelete(false); remove(); }}
              disabled={busy}
              className="flex-1 rounded-os bg-red-500/15 px-4 py-2.5 text-sm font-semibold text-red-600 hover:bg-red-500/25 disabled:opacity-50"
            >
              {busy ? '…' : t('common.delete')}
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}

function ScheduleTab({ store, refreshKey }) {
  const { t, lang } = useLang();
  const [staff, setStaff] = useState([]);
  const [shifts, setShifts] = useState([]);
  const [settings, setSettings] = useState({ weekStart: 'monday' });
  const [wkStart, setWkStart] = useState(() => weekStartOf(todayYMD(), 'monday'));
  const [editing, setEditing] = useState(null); // shift row or { staffId, ymd }
  const [error, setError] = useState('');

  const manager = canManage(store.role);
  const days = useMemo(() => weekDates(wkStart), [wkStart]);

  const load = useCallback(async () => {
    setError('');
    try {
      const st = await backend.pos.getPunchSettings(store.id);
      setSettings(st || DEFAULT_PUNCH_SETTINGS);
      const [staffRows, shiftRows] = await Promise.all([
        backend.pos.listStaff(store.id),
        backend.pos.listShifts(store.id, { from: days[0], to: days[6] }),
      ]);
      setStaff(staffRows.filter((s) => s.active !== false));
      setShifts(shiftRows);
    } catch (err) {
      setError(err.message || t('punch.loadFail'));
    }
  }, [store.id, days, t]);

  useEffect(() => { load(); }, [load, refreshKey]);
  // Re-anchor the week when the week-start setting changes.
  useEffect(() => {
    setWkStart((cur) => weekStartOf(cur, settings.weekStart));
  }, [settings.weekStart]);

  const byCell = useMemo(() => {
    const m = new Map();
    for (const s of shifts) {
      const k = `${s.staffId}|${s.ymd}`;
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(s);
    }
    return m;
  }, [shifts]);

  const today = todayYMD();

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 rounded-os border border-osborder bg-paper p-3">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-ink">
          <CalendarDays size={15} className="text-accent" /> {t('punch.scheduleTitle')}
        </h3>
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={() => setWkStart((w) => addDaysYMD(w, -7))}
            className="rounded-os border border-osborder px-2.5 py-1 text-xs font-medium text-ink hover:border-accent"
            aria-label="←"
          >
            ←
          </button>
          <button
            type="button"
            onClick={() => setWkStart(weekStartOf(todayYMD(), settings.weekStart))}
            className="rounded-os border border-osborder px-2.5 py-1 text-xs font-medium text-ink hover:border-accent"
          >
            {t('punch.thisWeek')}
          </button>
          <button
            type="button"
            onClick={() => setWkStart((w) => addDaysYMD(w, 7))}
            className="rounded-os border border-osborder px-2.5 py-1 text-xs font-medium text-ink hover:border-accent"
            aria-label="→"
          >
            →
          </button>
        </div>
      </div>

      <ErrorNote message={error} />
      {!manager && <p className="text-[11px] text-muted">{t('punch.readonlyHint')}</p>}

      <div className="overflow-x-auto rounded-os border border-osborder bg-paper">
        <table className="w-full min-w-[720px] border-collapse text-xs">
          <thead>
            <tr className="border-b border-osborder">
              <th className="sticky left-0 bg-paper px-3 py-2 text-left font-semibold text-ink">{t('punch.shiftWho')}</th>
              {days.map((d) => (
                <th key={d} className={`px-2 py-2 text-center font-semibold ${d === today ? 'text-accent' : 'text-muted'}`}>
                  {fmtDay(dayStartISO(d), lang)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {staff.map((s) => (
              <tr key={s.id} className="border-b border-osborder/60 last:border-0">
                <td className="sticky left-0 bg-paper px-3 py-2 font-medium text-ink">{s.name}</td>
                {days.map((d) => {
                  const cell = byCell.get(`${s.id}|${d}`) || [];
                  return (
                    <td key={d} className="px-1.5 py-1.5 align-top">
                      <div className="space-y-1">
                        {cell.map((sh) => (
                          <button
                            key={sh.id}
                            type="button"
                            disabled={!manager}
                            onClick={() => setEditing(sh)}
                            title={sh.note || ''}
                            className={`block w-full rounded-os px-2 py-1 text-left text-[11px] font-medium ${
                              manager ? 'bg-accent/15 text-ink hover:bg-accent/25' : 'bg-surface text-ink'
                            }`}
                          >
                            {sh.start}–{sh.end}
                            {sh.note && <span className="block truncate font-normal text-muted">{sh.note}</span>}
                          </button>
                        ))}
                        {manager && (
                          <button
                            type="button"
                            onClick={() => setEditing({ staffId: s.id, ymd: d })}
                            className="block w-full rounded-os border border-dashed border-osborder px-2 py-1 text-[11px] text-muted hover:border-accent hover:text-ink"
                            aria-label={t('punch.addShift')}
                          >
                            +
                          </button>
                        )}
                      </div>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        {staff.length === 0 && (
          <p className="py-6 text-center text-xs text-muted">{t('punch.noStaff')}</p>
        )}
      </div>

      {editing && (
        <ShiftModal
          store={store}
          staffList={staff}
          shifts={shifts}
          initial={editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); }}
        />
      )}
    </div>
  );
}

/* ---------------------------- time off ---------------------------- */

function TimeOffTab({ store, refreshKey }) {
  const { t, lang } = useLang();
  const [requests, setRequests] = useState([]);
  const [staffList, setStaffList] = useState([]);
  const [showNew, setShowNew] = useState(false);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState(null);

  const manager = canManage(store.role);

  const load = useCallback(async () => {
    setError('');
    try {
      const [req, staff] = await Promise.all([
        backend.pos.listTimeOff(store.id),
        backend.pos.listStaff(store.id).catch(() => []),
      ]);
      setRequests(req);
      setStaffList(staff.filter((s) => s.active !== false));
    } catch (err) {
      setError(err.message || t('punch.loadFail'));
    }
  }, [store.id, t]);

  useEffect(() => { load(); }, [load, refreshKey]);

  const decide = async (id, approved) => {
    setBusyId(id);
    setError('');
    try {
      await backend.pos.decideTimeOff(store.id, id, { approved, decidedBy: store.role });
      await load();
    } catch (err) {
      setError(err.message || t('punch.decideFail'));
    } finally {
      setBusyId(null);
    }
  };

  const pending = requests.filter((r) => r.status === 'pending');
  const history = requests.filter((r) => r.status !== 'pending');

  const statusBadge = (s) => (
    <span className={`rounded-os px-1.5 py-0.5 text-[11px] font-medium ${
      s === 'approved' ? 'bg-emerald-500/15 text-emerald-700'
      : s === 'denied' ? 'bg-red-500/15 text-red-600'
      : 'bg-amber-500/15 text-amber-700'
    }`}>
      {t(`punch.${s}`)}
    </span>
  );

  const renderRow = (r) => (
    <li key={r.id} className="flex items-center justify-between gap-2 py-2.5">
      <div className="min-w-0">
        <p className="text-sm font-medium text-ink">
          {r.staffName} {statusBadge(r.status)}
        </p>
        <p className="text-xs text-muted">
          {t(kindKey(r.kind))} · {fmtDay(dayStartISO(r.from), lang)} → {fmtDay(dayStartISO(r.to), lang)}
          {r.reason && <span className="block truncate">{r.reason}</span>}
        </p>
      </div>
      {manager && r.status === 'pending' && (
        <div className="flex shrink-0 gap-1.5">
          <button
            type="button"
            onClick={() => decide(r.id, false)}
            disabled={busyId === r.id}
            className="rounded-os bg-red-500/15 px-2.5 py-1.5 text-xs font-semibold text-red-600 hover:bg-red-500/25 disabled:opacity-50"
          >
            {t('punch.deny')}
          </button>
          <button
            type="button"
            onClick={() => decide(r.id, true)}
            disabled={busyId === r.id}
            className="flex items-center gap-1 rounded-os bg-accent px-2.5 py-1.5 text-xs font-semibold text-accentink hover:opacity-90 disabled:opacity-50"
          >
            <Check size={13} /> {t('punch.approve')}
          </button>
        </div>
      )}
    </li>
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-ink">
          <CalendarClock size={15} className="text-accent" /> {t('punch.timeOffTitle')}
        </h3>
        <button
          type="button"
          onClick={() => setShowNew(true)}
          className="rounded-os bg-accent px-3 py-1.5 text-xs font-semibold text-accentink hover:opacity-90"
        >
          {t('punch.newRequest')}
        </button>
      </div>

      <ErrorNote message={error} />

      <div className="rounded-os border border-osborder bg-paper p-4">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted">{t('punch.pendingTitle')}</h4>
        {pending.length === 0 ? (
          <p className="py-3 text-center text-xs text-muted">{t('punch.noRequests')}</p>
        ) : (
          <ul className="divide-y divide-osborder">{pending.map(renderRow)}</ul>
        )}
      </div>

      <div className="rounded-os border border-osborder bg-paper p-4">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted">{t('punch.historyTitle')}</h4>
        {history.length === 0 ? (
          <p className="py-3 text-center text-xs text-muted">{t('punch.noRequests')}</p>
        ) : (
          <ul className="divide-y divide-osborder">{history.map(renderRow)}</ul>
        )}
      </div>

      {showNew && (
        <TimeOffRequestModal
          store={store}
          staffList={staffList}
          onClose={() => setShowNew(false)}
          onDone={() => { setShowNew(false); load(); }}
        />
      )}
    </div>
  );
}

/* ------------------------- payroll / pay -------------------------- */

function PayTab({ store, refreshKey }) {
  const { t, lang } = useLang();
  const [punches, setPunches] = useState([]);
  const [breaks, setBreaks] = useState([]);
  const [shifts, setShifts] = useState([]);
  const [audits, setAudits] = useState([]);
  const [periods, setPeriods] = useState([]);
  const [staffList, setStaffList] = useState([]);
  const [orgInput, setOrgInput] = useState('');
  const [orgFilter, setOrgFilter] = useState('all');
  const [settings, setSettings] = useState({ weekStart: 'monday', graceMin: 15 });
  const [wkStart, setWkStart] = useState(() => weekStartOf(todayYMD(), 'monday'));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [nowTick, setNowTick] = useState(Date.now());
  const [confirmApprove, setConfirmApprove] = useState(false);
  const [confirmUnlock, setConfirmUnlock] = useState(null);

  const manager = canManage(store.role);
  const days = useMemo(() => weekDates(wkStart), [wkStart]);

  const load = useCallback(async () => {
    setError('');
    try {
      const st = await backend.pos.getPunchSettings(store.id);
      setSettings(st || DEFAULT_PUNCH_SETTINGS);
      // NUCLEAR FAILSAFE: fail closed on invalid week dates.
      const wkFrom = dayStartISO(days[0]);
      const wkTo = dayEndISO(days[6]);
      if (!wkFrom || !wkTo) throw new Error(t('punch.invalidRange'));
      const [rows, br, sh, au, pp, staff] = await Promise.all([
        backend.pos.listPunches(store.id, { from: wkFrom, to: wkTo, limit: 2000 }),
        backend.pos.listBreaks(store.id, { from: wkFrom, to: wkTo }),
        backend.pos.listShifts(store.id, { from: days[0], to: days[6] }),
        backend.pos.listPunchAudits(store.id, { limit: 200 }),
        backend.pos.listPayPeriods(store.id),
        backend.pos.listStaff(store.id).catch(() => []),
      ]);
      setPunches(rows);
      setBreaks(br);
      setShifts(sh);
      setAudits(au.filter((a) => {
        // NUCLEAR FAILSAFE: numeric timestamp comparison — the old
        // lexicographic string comparison broke on non-ISO formats.
        const t0 = Date.parse(wkFrom);
        const t1 = Date.parse(wkTo);
        const ta = a.createdAt ? Date.parse(a.createdAt) : NaN;
        return Number.isFinite(t0) && Number.isFinite(t1) && Number.isFinite(ta) && t0 <= ta && ta < t1;
      }));
      setPeriods(pp);
      setStaffList(staff);
    } catch (err) {
      setError(err.message || t('punch.loadFail'));
    }
  }, [store.id, days, t]);

  useEffect(() => { load(); }, [load, refreshKey]);
  useEffect(() => {
    const id = setInterval(() => setNowTick(Date.now()), 60000);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    setWkStart((cur) => weekStartOf(cur, settings.weekStart));
  }, [settings.weekStart]);

  const communityIds = useMemo(
    () => new Set(staffList.filter((s) => s.workerType === 'community').map((s) => s.id)),
    [staffList]
  );

  const summary = useMemo(
    () => weeklyPay(punches, breaks, settings.weekStart, nowTick, communityIds),
    [punches, breaks, settings.weekStart, nowTick, communityIds]
  );
  const exceptions = useMemo(
    () => findExceptions({ punches, shifts, audits, breaks, graceMin: settings.graceMin, nowMs: nowTick }),
    [punches, shifts, audits, breaks, settings.graceMin, nowTick]
  );

  const lockedPeriod = periods.find((p) => p.status === 'approved' && p.from <= days[0] && days[6] <= p.to);

  const byLabel = (name) => (name === 'owner' ? t('punch.roleOwner') : name === 'manager' ? t('punch.roleManager') : name);

  const approve = async () => {
    setBusy(true);
    setError('');
    try {
      // NUCLEAR FAILSAFE: record WHO approved (username/email). If no user
      // identity is available, REFUSE — an approval attributed to "manager"
      // makes the audit trail useless. Fail closed, never guess.
      const me = backend.auth.getUser?.()?.user;
      const approvedBy = me?.user_metadata?.username || me?.email || '';
      if (!approvedBy) throw new Error(t('punch.approveNoIdentity'));
      await backend.pos.approvePeriod(store.id, { from: days[0], to: days[6], approvedBy });
      await load();
    } catch (err) {
      setError(err.message || t('punch.punchFail'));
    } finally {
      setBusy(false);
    }
  };

  const unlock = async (p) => {
    if (!p) return;
    setBusy(true);
    setError('');
    try {
      await backend.pos.unlockPeriod(store.id, p.id);
      await load();
    } catch (err) {
      setError(err.message || t('punch.punchFail'));
    } finally {
      setBusy(false);
    }
  };

  const exportCsv = () => {
    try {
      if (summary.length === 0) {
        setError(t('punch.exportEmpty'));
        return;
      }
      const h2 = (ms) => (ms / 3600000).toFixed(2);
      const q = (v) => `"${String(v).replace(/"/g, '""')}"`;
      const header = [t('punch.csvEmployee'), t('punch.csvRegular'), t('punch.csvOvertime'), t('punch.csvTotal'), t('punch.csvPaidBreaks'), t('punch.csvUnpaidBreaks')];
      const lines = [header.map(q).join(';')];
      let tReg = 0, tOt = 0, tPaid = 0, tUnpaid = 0;
      for (const s of summary) {
        const bm = breakMinutesFor(breaks, s.staffId, nowTick);
        tReg += s.regMs; tOt += s.otMs; tPaid += bm.paidMin; tUnpaid += bm.unpaidMin;
        lines.push([q(s.name), h2(s.regMs), h2(s.otMs), h2(s.regMs + s.otMs), bm.paidMin, bm.unpaidMin].join(';'));
      }
      lines.push([q(t('punch.csvTotalRow')), h2(tReg), h2(tOt), h2(tReg + tOt), tPaid, tUnpaid].join(';'));
      const blob = new Blob(["\uFEFF" + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `certificates-payroll-${days[0]}_${days[6]}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    } catch (err) {
      setError(err.message || t('punch.exportFail'));
    }
  };

  const excLine = (e) => {
    if (e.type === 'late') return `${t('punch.lateArrival')}: ${e.staffName} — ${t('punch.lateBy', { dur: fmtDur(e.lateMs) })}`;
    if (e.type === 'missed') return `${t('punch.missedPunch')}: ${e.staffName}`;
    if (e.type === 'edited') return `${t('punch.editedEntry')}: ${e.staffName}`;
    return `${t('punch.breakOverdue')}: ${e.staffName} (+${fmtDur(e.overMs)})`;
  };

  /* ---- community service: separate tracking + attestations ---- */
  const communityStaff = useMemo(
    () => staffList.filter((s) => s.workerType === 'community'),
    [staffList]
  );
  const orgOptions = useMemo(() => {
    const set = new Set();
    for (const s of communityStaff) {
      if (s.organization) set.add(s.organization);
    }
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [communityStaff]);
  const communityRows = useMemo(() => {
    const rows = communityStaff.map((s) => {
      let ms = 0;
      for (const p of punches) {
        if (p.staffId === s.id) ms += punchNetMs(p, breaks, nowTick);
      }
      return { staffId: s.id, name: s.name, organization: s.organization || '', assignedHours: s.assignedHours || 0, ms };
    });
    const f = orgFilter === 'all' ? null : orgFilter;
    return rows.filter((r) => !f || r.organization === f);
  }, [communityStaff, punches, breaks, nowTick, orgFilter]);

  const workerSectionHtml = (c) => {
    const staffPunches = punches.filter((p) => p.staffId === c.staffId);
    const staffBreaks = breaks.filter((b) => b.staffId === c.staffId);
    const daysList = dailyHours(staffPunches, staffBreaks, nowTick);
    const totalMs = daysList.reduce((a, d) => a + d.ms, 0);
    const orgName = orgInput.trim() || c.organization || '';
    return attestationSection({
      t, lang, workerName: c.name, org: orgName,
      days: daysList, totalMs, assignedHours: c.assignedHours,
    });
  };

  const doAttestation = (c) => {
    try {
      printHtmlDoc(attestationDoc({
        t, lang,
        storeName: store.name,
        subtitle: null,
        periodFrom: fmtDay(dayStartISO(days[0]), lang),
        periodTo: fmtDay(dayStartISO(days[6]), lang),
        sectionsHtml: `<div class="worker">${workerSectionHtml(c)}</div>`,
      }));
    } catch (err) {
      setError(err.message || t('punch.printFail'));
    }
  };

  const doGroupAttestation = () => {
    try {
      const orgName = orgFilter === 'all' ? '' : orgFilter;
      const subtitle = orgName
        ? `<b>${escHtml(t('punch.attestationOrg'))} :</b> ${escHtml(orgName)}`
        : `<b>${escHtml(t('punch.communitySection'))}</b>`;
      printHtmlDoc(attestationDoc({
        t, lang,
        storeName: store.name,
        subtitle,
        periodFrom: fmtDay(dayStartISO(days[0]), lang),
        periodTo: fmtDay(dayStartISO(days[6]), lang),
        sectionsHtml: communityRows.map((c) => `<div class="worker">${workerSectionHtml(c)}</div>`).join(''),
      }));
    } catch (err) {
      setError(err.message || t('punch.printFail'));
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 rounded-os border border-osborder bg-paper p-3">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-ink">
          <CircleDollarSign size={15} className="text-accent" /> {t('punch.payTitle')}
        </h3>
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={() => setWkStart((w) => addDaysYMD(w, -7))}
            className="rounded-os border border-osborder px-2.5 py-1 text-xs font-medium text-ink hover:border-accent"
            aria-label="←"
          >
            ←
          </button>
          <span className="px-1 text-xs font-medium text-ink">
            {t('punch.period')}: {fmtDay(dayStartISO(days[0]), lang)} → {fmtDay(dayStartISO(days[6]), lang)}
          </span>
          <button
            type="button"
            onClick={() => setWkStart((w) => addDaysYMD(w, 7))}
            className="rounded-os border border-osborder px-2.5 py-1 text-xs font-medium text-ink hover:border-accent"
            aria-label="→"
          >
            →
          </button>
        </div>
      </div>

      <ErrorNote message={error} />

      {lockedPeriod ? (
        <div className="flex flex-wrap items-center gap-2 rounded-os border border-emerald-500/30 bg-emerald-500/10 px-3 py-2.5">
          <Lock size={14} className="text-emerald-700" />
          <p className="text-xs font-medium text-emerald-700">
            {t('punch.locked')} · {t('punch.approvedByLine', { name: byLabel(lockedPeriod.approvedBy), day: fmtDay(lockedPeriod.approvedAt, lang) })}
          </p>
          <p className="w-full text-[11px] text-muted">{t('punch.lockedHint')}</p>
          {manager && (
            <button
              type="button"
              onClick={() => setConfirmUnlock(lockedPeriod)}
              disabled={busy}
              className="rounded-os border border-osborder px-2.5 py-1 text-xs font-medium text-ink hover:border-accent disabled:opacity-50"
            >
              {t('punch.unlock')}
            </button>
          )}
        </div>
      ) : (
        manager && (
          <button
            type="button"
            onClick={() => setConfirmApprove(true)}
            disabled={busy || summary.length === 0}
            className="flex items-center gap-1.5 rounded-os bg-accent px-4 py-2 text-sm font-semibold text-accentink hover:opacity-90 disabled:opacity-50"
          >
            <Lock size={14} /> {busy ? t('punch.recording') : t('punch.approveLock')}
          </button>
        )
      )}

      <div className="rounded-os border border-osborder bg-paper p-4">
        <div className="flex items-center justify-between">
          <h4 className="text-sm font-semibold text-ink">{t('punch.exceptions')}</h4>
          <button
            type="button"
            onClick={exportCsv}
            className="flex items-center gap-1.5 rounded-os border border-osborder px-3 py-1.5 text-xs font-semibold text-ink hover:border-accent"
          >
            <Download size={13} /> {t('punch.exportCsv')}
          </button>
        </div>
        {exceptions.length === 0 ? (
          <p className="py-3 text-center text-xs text-muted">{t('punch.noExceptions')}</p>
        ) : (
          <ul className="mt-2 space-y-1.5">
            {exceptions.map((e, i) => (
              <li key={i} className="flex items-center gap-2 rounded-os bg-surface px-3 py-1.5 text-xs text-ink">
                <AlertCircle size={13} className="shrink-0 text-amber-600" />
                <span className="min-w-0">
                  {excLine(e)}
                  <span className="ml-1.5 text-muted">{fmtDay(e.at, lang)} {fmtTime(e.at)}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="rounded-os border border-osborder bg-paper p-4">
        <h4 className="text-sm font-semibold text-ink">{t('punch.hoursByEmployee')}</h4>
        <p className="mt-0.5 text-[11px] text-muted">{t('punch.otNote')}</p>
        {summary.length === 0 ? (
          <p className="py-3 text-center text-xs text-muted">{t('punch.noPunches')}</p>
        ) : (
          <div className="mt-2 overflow-x-auto">
            <table className="w-full min-w-[560px] border-collapse text-xs">
              <thead>
                <tr className="border-b border-osborder text-left text-muted">
                  <th className="py-1.5 pr-2 font-semibold">{t('punch.csvEmployee')}</th>
                  <th className="py-1.5 pr-2 text-right font-semibold">{t('punch.regularHours')}</th>
                  <th className="py-1.5 pr-2 text-right font-semibold">{t('punch.overtimeHours')}</th>
                  <th className="py-1.5 pr-2 text-right font-semibold">{t('punch.csvTotal')}</th>
                  <th className="py-1.5 text-right font-semibold">{t('punch.csvPaidBreaks')} / {t('punch.csvUnpaidBreaks')}</th>
                </tr>
              </thead>
              <tbody>
                {summary.map((s) => {
                  const bm = breakMinutesFor(breaks, s.staffId, nowTick);
                  return (
                    <tr key={s.staffId} className="border-b border-osborder/60 last:border-0">
                      <td className="py-2 pr-2 font-medium text-ink">{s.name}</td>
                      <td className="py-2 pr-2 text-right text-ink">{fmtDur(s.regMs)}</td>
                      <td className={`py-2 pr-2 text-right font-semibold ${s.otMs > 0 ? 'text-accent' : 'text-muted'}`}>
                        {s.otMs > 0 ? fmtDur(s.otMs) : '—'}
                      </td>
                      <td className="py-2 pr-2 text-right font-semibold text-ink">{fmtDur(s.regMs + s.otMs)}</td>
                      <td className="py-2 text-right text-muted">{bm.paidMin} / {bm.unpaidMin}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="rounded-os border border-osborder bg-paper p-4">
        <div className="flex flex-wrap items-center gap-2">
          <h4 className="text-sm font-semibold text-ink">{t('punch.communitySectionPunch')}</h4>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-1.5 text-xs text-muted">
              {t('punch.orgFilter')}
              <select
                value={orgFilter}
                onChange={(e) => setOrgFilter(e.target.value)}
                className={inputCls + ' w-auto py-1 text-xs'}
              >
                <option value="all">{t('punch.orgAll')}</option>
                {orgOptions.map((o) => (
                  <option key={o} value={o}>{o}</option>
                ))}
              </select>
            </label>
            <input
              value={orgInput}
              onChange={(e) => setOrgInput(e.target.value)}
              placeholder={t('punch.attestationOrgPh')}
              className={inputCls + ' w-44 py-1 text-xs'}
            />
            <button
              type="button"
              onClick={doGroupAttestation}
              disabled={communityRows.length === 0}
              className="rounded-os border border-osborder px-3 py-1.5 text-xs font-semibold text-ink hover:border-accent disabled:opacity-50"
            >
              {t('punch.groupAttestation')}
            </button>
          </div>
        </div>
        <p className="mt-0.5 text-[11px] text-muted">{t('punch.communityPunchNote')}</p>
        {communityRows.length === 0 ? (
          <p className="py-3 text-center text-xs text-muted">{t('punch.noCommunity')}</p>
        ) : (
          <ul className="mt-2 divide-y divide-osborder">
            {communityRows.map((c) => (
              <li key={c.staffId} className="flex items-center justify-between gap-2 py-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-ink">
                    {c.name}
                    {c.organization && <span className="ml-1.5 text-xs font-normal text-muted">{c.organization}</span>}
                  </p>
                  <p className="text-xs text-muted">
                    {t('punch.completedHours')}: {fmtDur(c.ms)}
                    {c.assignedHours > 0 && (
                      <span className="ml-1.5">
                        · {t('punch.remainingHours')}: {fmtDur(Math.max(0, c.assignedHours * 3600000 - c.ms))}
                      </span>
                    )}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => doAttestation(c)}
                  className="shrink-0 rounded-os border border-osborder px-3 py-1.5 text-xs font-semibold text-ink hover:border-accent"
                >
                  {t('punch.attestation')}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="rounded-os border border-osborder bg-paper p-4">
        <h4 className="text-sm font-semibold text-ink">{t('punch.periodsTitle')}</h4>
        {periods.length === 0 ? (
          <p className="py-3 text-center text-xs text-muted">{t('punch.noPeriods')}</p>
        ) : (
          <ul className="mt-2 divide-y divide-osborder">
            {periods.map((p) => (
              <li key={p.id} className="flex items-center justify-between gap-2 py-2">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-ink">
                    {fmtDay(dayStartISO(p.from), lang)} → {fmtDay(dayStartISO(p.to), lang)}
                  </p>
                  <p className="text-xs text-muted">
                    {t('punch.approvedByLine', { name: byLabel(p.approvedBy), day: fmtDay(p.approvedAt, lang) })}
                  </p>
                </div>
                {manager && (
                  <button
                    type="button"
                    onClick={() => setConfirmUnlock(p)}
                    disabled={busy}
                    className="shrink-0 rounded-os border border-osborder px-2.5 py-1 text-xs font-medium text-ink hover:border-accent disabled:opacity-50"
                  >
                    {t('punch.unlock')}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {confirmApprove && (
        <Modal title={t('punch.approvePeriodTitle')} onClose={() => setConfirmApprove(false)}>
          <p className="text-sm text-muted">
            {t('punch.approveConfirm', { from: days[0], to: days[6] })}
          </p>
          <div className="mt-4 flex gap-2">
            <button
              type="button"
              onClick={() => setConfirmApprove(false)}
              className="flex-1 rounded-os border border-osborder px-4 py-2 text-sm font-medium text-ink hover:border-accent"
            >
              {t('common.cancel')}
            </button>
            <button
              type="button"
              onClick={() => { setConfirmApprove(false); approve(); }}
              disabled={busy}
              className="flex-1 rounded-os bg-accent px-4 py-2.5 text-sm font-semibold text-accentink hover:opacity-90 disabled:opacity-50"
            >
              {busy ? t('punch.recording') : t('punch.approveLock')}
            </button>
          </div>
        </Modal>
      )}

      {confirmUnlock && (
        <Modal title={t('punch.unlockPeriodTitle')} onClose={() => setConfirmUnlock(null)}>
          <p className="text-sm text-muted">{t('punch.unlockConfirm')}</p>
          <div className="mt-4 flex gap-2">
            <button
              type="button"
              onClick={() => setConfirmUnlock(null)}
              className="flex-1 rounded-os border border-osborder px-4 py-2 text-sm font-medium text-ink hover:border-accent"
            >
              {t('common.cancel')}
            </button>
            <button
              type="button"
              onClick={() => { const p = confirmUnlock; setConfirmUnlock(null); unlock(p); }}
              disabled={busy}
              className="flex-1 rounded-os bg-accent px-4 py-2.5 text-sm font-semibold text-accentink hover:opacity-90 disabled:opacity-50"
            >
              {busy ? t('punch.recording') : t('punch.unlock')}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

/* ------------------------- community service ------------------------ */
// Travaux communautaires: unpaid volunteer hours, tracked SEPARATELY from
// payroll. Printable per-person attestations, grouped by organization.

function fmtMinutes(m) {
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return h > 0 ? `${h}h ${String(mm).padStart(2, '0')}` : `${mm} min`;
}

// Full A4 community-service attestation for one person over a period,
// entries grouped by organization. Reuses printHtmlDoc; visually matches
// the payroll attestation but is a separate document.
function communityAttestationDoc({ t, lang, storeName, personName, periodFrom, periodTo, groups, totalMinutes }) {
  const loc = tagFor(lang);
  const fDay = (ymd) => {
    // NUCLEAR FAILSAFE: guard against null/malformed dates in attestation print.
    if (!ymd || typeof ymd !== 'string') return '—';
    const [y, m, d] = ymd.split('-').map(Number);
    if (![y, m, d].every((n) => Number.isFinite(n))) return '—';
    return new Date(y, m - 1, d).toLocaleDateString(loc, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  };
  const fMin = (m) => {
    const h = Math.floor(m / 60);
    return h > 0 ? `${h} h ${String(m % 60).padStart(2, '0')}` : `${m} min`;
  };
  const sections = groups.length === 0
    ? `<p>${escHtml(t('punch.community.noEntries'))}</p>`
    : groups.map((g) => `
  <div class="worker">
  <h2>${escHtml(t('punch.community.certOrg'))} : ${escHtml(g.orgName || t('punch.community.certNoOrg'))}</h2>
  <table>
    <thead><tr><th>${escHtml(t('punch.community.certDate'))}</th><th class="num">${escHtml(t('punch.community.certHours'))}</th><th>${escHtml(t('punch.community.certNotes'))}</th></tr></thead>
    <tbody>
      ${g.entries.map((e) => `<tr><td>${escHtml(fDay(e.date))}</td><td class="num">${fMin(e.minutes)}</td><td>${escHtml(e.notes || '—')}</td></tr>`).join('')}
    </tbody>
    <tfoot><tr><td>${escHtml(t('punch.community.certTotal'))}</td><td class="num">${fMin(g.minutes)}</td><td></td></tr></tfoot>
  </table>
  </div>`).join('');
  return `<!DOCTYPE html>
<html lang="${tagFor(lang)}"><head><meta charset="utf-8">
<title>${escHtml(t('punch.community.certTitle'))} — ${escHtml(personName)}</title>
<style>
  @page { size: A4; margin: 18mm 15mm; }
  body { font-family: Georgia, 'Times New Roman', serif; color: #111; font-size: 12pt; line-height: 1.45; }
  h1 { font-size: 20pt; margin: 0 0 4pt; }
  h2 { font-size: 14pt; margin: 20pt 0 6pt; border-bottom: 1px solid #999; padding-bottom: 4pt; }
  .meta { margin: 2pt 0; }
  .person { font-size: 16pt; font-weight: bold; margin: 10pt 0; }
  table { width: 100%; border-collapse: collapse; margin-top: 6pt; font-size: 11pt; }
  th, td { border: 1px solid #666; padding: 5pt 8pt; text-align: left; }
  th { background: #eee; }
  td.num, th.num { text-align: right; }
  tfoot td { font-weight: bold; }
  .totals { margin-top: 10pt; font-size: 13pt; }
  .sigs { display: flex; gap: 40pt; margin-top: 48pt; page-break-inside: avoid; }
  .sig { flex: 1; border-top: 1px solid #111; padding-top: 4pt; font-size: 10pt; }
  .foot { margin-top: 18pt; font-size: 9pt; color: #555; }
  .worker { page-break-inside: avoid; }
</style></head><body>
  <h1>${escHtml(t('punch.community.certTitle'))}</h1>
  <p class="meta"><b>${escHtml(storeName)}</b> ${escHtml(t('punch.community.certLine1'))}</p>
  <p class="person">${escHtml(personName)}</p>
  <p>${escHtml(t('punch.community.certLine2'))}</p>
  <p class="meta"><b>${escHtml(t('punch.community.period'))} :</b> ${escHtml(periodFrom)} → ${escHtml(periodTo)}</p>
  ${sections}
  <div class="totals"><p class="meta"><b>${escHtml(t('punch.community.certTotal'))} :</b> ${fMin(totalMinutes)}</p></div>
  <div class="sigs">
    <div class="sig">${escHtml(t('punch.community.certSign1'))}</div>
    <div class="sig">${escHtml(t('punch.community.certSign2'))}</div>
  </div>
  <p class="foot">${escHtml(t('punch.community.certIssued'))} ${escHtml(new Date().toLocaleDateString(loc))}</p>
</body></html>`;
}

function CommunityTab({ store }) {
  const { t, lang } = useLang();
  const manager = canManage(store.role);
  const [entries, setEntries] = useState([]);
  const [orgs, setOrgs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [unsupported, setUnsupported] = useState(false);
  // Entry form.
  const [person, setPerson] = useState('');
  const [date, setDate] = useState(todayYMD());
  const [hours, setHours] = useState('');
  const [mins, setMins] = useState('');
  const [orgId, setOrgId] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(null); // entry being edited
  // Period filter + attestation.
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [certPerson, setCertPerson] = useState('');
  const [deleting, setDeleting] = useState(null);
  const [confirmDeleteEntry, setConfirmDeleteEntry] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [es, os] = await Promise.all([
        backend.pos.listCommunityHours(store.id, { from: from || null, to: to || null }),
        backend.pos.listOrgs(store.id).catch(() => []),
      ]);
      setEntries(es);
      setOrgs(os);
      setUnsupported(false);
    } catch (err) {
      if (/latest database update/i.test(err.message || '')) setUnsupported(true);
      else setError(err.message || t('punch.loadFail'));
    } finally {
      setLoading(false);
    }
  }, [store.id, from, to, t]);

  useEffect(() => { load(); }, [load]);

  const knownNames = useMemo(() => {
    const seen = new Map();
    for (const e of entries) {
      const k = ((e.personName || "").trim()).toLowerCase();
      if (k && !seen.has(k)) seen.set(k, ((e.personName || "").trim()));
    }
    return [...seen.values()].sort((a, b) => a.localeCompare(b));
  }, [entries]);

  const people = useMemo(() => {
    const by = new Map();
    for (const e of entries) {
      const k = ((e.personName || "").trim()).toLowerCase();
      if (!by.has(k)) by.set(k, { name: ((e.personName || "").trim()), minutes: 0, entries: 0 });
      const p = by.get(k);
      p.minutes += e.minutes;
      p.entries += 1;
    }
    return [...by.values()].sort((a, b) => b.minutes - a.minutes);
  }, [entries]);

  const resetForm = () => {
    setPerson(''); setDate(todayYMD()); setHours(''); setMins('');
    setOrgId(''); setNotes(''); setEditing(null);
  };

  const startEdit = (e) => {
    setEditing(e);
    setPerson(e.personName);
    setDate(e.date);
    setHours(String(Math.floor(e.minutes / 60)));
    setMins(String(e.minutes % 60));
    setOrgId(e.orgId || '');
    setNotes(e.notes || '');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const submit = async () => {
    setError('');
    const totalMin = Math.round(Number(hours) || 0) * 60 + Math.round(Number(mins) || 0);
    // NUCLEAR FAILSAFE: validate community hours entry. Reject 0-minute entries
    // and empty dates — these are meaningless rows that pollute the data.
    const trimmedPerson = (person || '').trim();
    if (!trimmedPerson) {
      setError(t('punch.community.nameRequired'));
      setSaving(false);
      return;
    }
    if (totalMin <= 0) {
      setError(t('punch.community.minutesRequired'));
      setSaving(false);
      return;
    }
    if (!date) {
      setError(t('punch.community.dateRequired'));
      setSaving(false);
      return;
    }
    setSaving(true);
    try {
      await backend.pos.saveCommunityHours(store.id, {
        id: editing?.id || null,
        personName: trimmedPerson,
        date,
        minutes: totalMin,
        orgId: orgId || null,
        notes,
      });
      resetForm();
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (e) => {
    if (!e) return;
    setDeleting(e.id);
    setError('');
    try {
      await backend.pos.deleteCommunityHours(store.id, e.id);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setDeleting(null);
    }
  };

  const printCert = () => {
    const name = (certPerson || '').trim();
    if (!name) return;
    const k = name.toLowerCase();
    const mine = entries.filter((e) => ((e.personName || "").trim()).toLowerCase() === k)
      .sort((a, b) => (a.date < b.date ? -1 : 1));
    const byOrg = new Map();
    for (const e of mine) {
      const ok = e.orgName || '';
      if (!byOrg.has(ok)) byOrg.set(ok, { orgName: e.orgName, entries: [], minutes: 0 });
      const g = byOrg.get(ok);
      g.entries.push(e);
      g.minutes += e.minutes;
    }
    const groups = [...byOrg.values()].sort((a, b) => (a.orgName || '').localeCompare(b.orgName || ''));
    const total = mine.reduce((s, e) => s + e.minutes, 0);
    const loc = tagFor(lang);
    const fRange = (ymd) => {
      if (!ymd) return '—';
      const [y, m, d] = ymd.split('-').map(Number);
      return new Date(y, m - 1, d).toLocaleDateString(loc);
    };
    printHtmlDoc(communityAttestationDoc({
      t, lang, storeName: store.name, personName: name,
      periodFrom: fRange(from), periodTo: fRange(to),
      groups, totalMinutes: total,
    }));
  };

  if (loading) {
    return <p className="text-sm text-muted">{t('common.loading')}</p>;
  }
  if (unsupported) {
    return (
      <div className="rounded-os border border-osborder bg-paper p-6 text-center">
        <p className="text-sm font-medium text-ink">{t('punch.community.title')}</p>
        <p className="mt-1 text-xs text-muted">{t('punch.community.needUpdate')}</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-base font-semibold text-ink">{t('punch.community.title')}</h2>
        <p className="mt-1 max-w-2xl text-xs text-muted">{t('punch.community.hint')}</p>
        <p className="mt-1 max-w-2xl text-xs text-muted">{t('punch.community.hintPunch')}</p>
      </div>
      <ErrorNote message={error} />

      {/* Log hours */}
      <div className="rounded-os border border-osborder bg-paper p-4">
        <h3 className="mb-3 text-sm font-semibold text-ink">
          {editing ? t('punch.community.edit') : t('punch.community.add')}
        </h3>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <label className="col-span-2 block sm:col-span-1">
            <span className="mb-1 block text-xs font-medium text-muted">{t('punch.community.person')}</span>
            <input
              value={person} onChange={(e) => setPerson(e.target.value)}
              placeholder={t('punch.community.personPh')}
              list="community-names" className={inputCls}
              autoCapitalize="words" autoCorrect="off" spellCheck="false"
            />
            <datalist id="community-names">
              {knownNames.map((n) => <option key={n} value={n} />)}
            </datalist>
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted">{t('punch.community.date')}</span>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={inputCls} />
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-muted">{t('punch.community.hours')}</span>
              <input type="number" min="0" max="24" value={hours} onChange={(e) => setHours(e.target.value)} placeholder="0" className={inputCls} inputMode="numeric" />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-muted">{t('punch.community.minutes')}</span>
              <input type="number" min="0" max="59" value={mins} onChange={(e) => setMins(e.target.value)} placeholder="0" className={inputCls} inputMode="numeric" />
            </label>
          </div>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted">{t('punch.community.org')}</span>
            <select value={orgId} onChange={(e) => setOrgId(e.target.value)} className={inputCls}>
              <option value="">{t('punch.community.noOrg')}</option>
              {orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          </label>
          <label className="col-span-2 block">
            <span className="mb-1 block text-xs font-medium text-muted">{t('punch.community.notes')}</span>
            <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder={t('punch.community.notesPh')} className={inputCls} maxLength={1000} />
          </label>
        </div>
        <div className="mt-3 flex gap-2">
          <button
            type="button" onClick={submit} disabled={saving || !person.trim()}
            className="rounded-os bg-accent px-4 py-2 text-sm font-semibold text-accentink hover:opacity-90 disabled:opacity-60"
          >
            {saving ? t('punch.community.saving') : editing ? t('punch.community.edit') : t('punch.community.add')}
          </button>
          {editing && (
            <button type="button" onClick={resetForm} className="rounded-os border border-osborder bg-paper px-4 py-2 text-sm font-medium text-ink hover:border-accent">
              {t('common.cancel')}
            </button>
          )}
        </div>
      </div>

      {/* Period + attestation */}
      <div className="rounded-os border border-osborder bg-paper p-4">
        <h3 className="mb-3 text-sm font-semibold text-ink">{t('punch.community.attestation')}</h3>
        <div className="flex flex-wrap items-end gap-3">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted">{t('punch.community.period')} — {t('common.from')}</span>
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={inputCls} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted">{t('common.to')}</span>
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className={inputCls} />
          </label>
          <label className="block min-w-48 flex-1">
            <span className="mb-1 block text-xs font-medium text-muted">{t('punch.community.person')}</span>
            <select value={certPerson} onChange={(e) => setCertPerson(e.target.value)} className={inputCls}>
              <option value="">—</option>
              {people.map((p) => <option key={p.name} value={p.name}>{p.name} ({fmtMinutes(p.minutes)})</option>)}
            </select>
          </label>
          <button
            type="button" onClick={printCert} disabled={!certPerson}
            className="rounded-os bg-accent px-4 py-2 text-sm font-semibold text-accentink hover:opacity-90 disabled:opacity-60"
          >
            {t('punch.community.print')}
          </button>
        </div>
      </div>

      {/* People totals */}
      <div className="rounded-os border border-osborder bg-paper p-4">
        <h3 className="mb-3 text-sm font-semibold text-ink">{t('punch.community.people')}</h3>
        {people.length === 0 ? (
          <p className="text-xs text-muted">{t('punch.community.noEntries')}</p>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {people.map((p) => (
              <button
                key={p.name} type="button"
                onClick={() => setCertPerson(p.name)}
                className={`rounded-os border p-3 text-left transition-colors ${certPerson === p.name ? 'border-accent bg-accent/10' : 'border-osborder hover:border-accent'}`}
              >
                <p className="text-sm font-semibold text-ink">{p.name}</p>
                <p className="mt-0.5 text-xs text-muted">{fmtMinutes(p.minutes)} · {p.entries} {t('punch.community.entries').toLowerCase()}</p>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Entry list */}
      <div className="rounded-os border border-osborder bg-paper p-4">
        <h3 className="mb-3 text-sm font-semibold text-ink">{t('punch.community.entries')}</h3>
        {entries.length === 0 ? (
          <p className="text-xs text-muted">{t('punch.community.noEntries')}</p>
        ) : (
          <ul className="divide-y divide-osborder">
            {entries.map((e) => (
              <li key={e.id} className="flex items-center justify-between gap-3 py-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-ink">
                    {e.personName} <span className="font-normal text-muted">· {fmtMinutes(e.minutes)} · {e.date}</span>
                  </p>
                  <p className="truncate text-xs text-muted">
                    {[e.orgName, e.notes].filter(Boolean).join(' — ') || '—'}
                  </p>
                </div>
                {manager && (
                  <div className="flex shrink-0 gap-1">
                    <button type="button" onClick={() => startEdit(e)} className="rounded-os p-1.5 text-muted hover:bg-surface hover:text-ink" aria-label={t('punch.community.edit')}>
                      <Pencil size={14} />
                    </button>
                    <button
                      type="button" onClick={() => setConfirmDeleteEntry(e)} disabled={deleting === e.id}
                      className="rounded-os p-1.5 text-muted hover:bg-surface hover:text-red-600 disabled:opacity-60" aria-label={t('punch.community.delete')}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {confirmDeleteEntry && (
        <Modal title={t('punch.community.deleteTitle')} onClose={() => setConfirmDeleteEntry(null)}>
          <p className="text-sm text-muted">
            {t('punch.community.deleteConfirm', { name: confirmDeleteEntry.personName, date: confirmDeleteEntry.date })}
          </p>
          <div className="mt-4 flex gap-2">
            <button
              type="button"
              onClick={() => setConfirmDeleteEntry(null)}
              className="flex-1 rounded-os border border-osborder px-4 py-2 text-sm font-medium text-ink hover:border-accent"
            >
              {t('common.cancel')}
            </button>
            <button
              type="button"
              onClick={() => { const e = confirmDeleteEntry; setConfirmDeleteEntry(null); remove(e); }}
              disabled={deleting}
              className="flex-1 rounded-os bg-red-500/15 px-4 py-2.5 text-sm font-semibold text-red-600 hover:bg-red-500/25 disabled:opacity-50"
            >
              {deleting ? '…' : t('common.delete')}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

/* ------------------------------ settings ---------------------------- */

function SettingsTab({ store }) {  const { t } = useLang();
  const [form, setForm] = useState({ weekStart: 'monday', paidBreakMin: 15, unpaidBreakMin: 30, graceMin: 15 });
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  const manager = canManage(store.role);

  const load = useCallback(async () => {
    try {
      // NUCLEAR FAILSAFE: null-guard settings (prevents crash on settings.weekStart).
      const st = await backend.pos.getPunchSettings(store.id);
      setForm(st || DEFAULT_PUNCH_SETTINGS);
    } catch (err) {
      setError(err.message || t('punch.loadFail'));
    }
  }, [store.id, t]);

  useEffect(() => { load(); }, [load]);

  const save = async () => {
    setBusy(true);
    setError('');
    setSaved(false);
    // NUCLEAR FAILSAFE: validate numeric settings — REJECT invalid values
    // instead of silently clamping them (clamping hid user mistakes and made
    // "what you see" differ from "what was saved"). Valid: 0–480 minutes.
    const checkMin = (v) => {
      if (v === '' || v == null) return NaN;
      const n = Number(v);
      return Number.isFinite(n) && n >= 0 && n <= 480 ? Math.round(n) : NaN;
    };
    const paidBreakMin = checkMin(form.paidBreakMin);
    const unpaidBreakMin = checkMin(form.unpaidBreakMin);
    const graceMin = checkMin(form.graceMin);
    if (!Number.isFinite(paidBreakMin) || !Number.isFinite(unpaidBreakMin) || !Number.isFinite(graceMin)) {
      setBusy(false);
      setError(t('punch.settingsBadMinutes'));
      return;
    }
    const otRaw = form.overtimeAfterHrs;
    const overtimeAfterHrs = otRaw === '' || otRaw == null ? NaN : Number(otRaw);
    if (!Number.isFinite(overtimeAfterHrs) || overtimeAfterHrs <= 0) {
      setBusy(false);
      setError(t('punch.settingsBadOT'));
      return;
    }
    const sanitized = { ...form, paidBreakMin, unpaidBreakMin, graceMin, overtimeAfterHrs };
    try {
      setForm(await backend.pos.savePunchSettings(store.id, sanitized));
      setSaved(true);
    } catch (err) {
      setError(err.message || t('punch.settingsFail'));
    } finally {
      setBusy(false);
    }
  };

  if (!manager) {
    return (
      <div className="rounded-os border border-osborder bg-paper p-8 text-center">
        <KeyRound size={24} className="mx-auto text-muted" />
        <p className="mt-2 text-sm font-medium text-ink">{t('punch.restricted')}</p>
        <p className="mt-1 text-xs text-muted">{t('punch.restrictedHint')}</p>
      </div>
    );
  }

  return (
    <div className="max-w-md space-y-4">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-ink">
        <Settings size={15} className="text-accent" /> {t('punch.settingsTitle')}
      </h3>
      <ErrorNote message={error} />
      {saved && (
        <p className="rounded-os border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-700">
          {t('punch.settingsSaved')}
        </p>
      )}
      <div className="rounded-os border border-osborder bg-paper p-4 space-y-3">
        <div>
          <label className="mb-1 block text-xs font-medium text-muted">{t('punch.weekStart')}</label>
          <select
            value={form.weekStart}
            onChange={(e) => setForm((f) => ({ ...f, weekStart: e.target.value }))}
            className={inputCls}
          >
            <option value="monday">{t('punch.weekMonday')}</option>
            <option value="sunday">{t('punch.weekSunday')}</option>
          </select>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-muted">{t('punch.paidBreakLen')}</label>
            <input
              type="number" min={5} max={180} inputMode="numeric"
              value={form.paidBreakMin}
              onChange={(e) => setForm((f) => ({ ...f, paidBreakMin: Number(e.target.value) }))}
              className={inputCls}
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted">{t('punch.unpaidBreakLen')}</label>
            <input
              type="number" min={5} max={240} inputMode="numeric"
              value={form.unpaidBreakMin}
              onChange={(e) => setForm((f) => ({ ...f, unpaidBreakMin: Number(e.target.value) }))}
              className={inputCls}
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted">{t('punch.gracePeriod')}</label>
            <input
              type="number" min={0} max={60} inputMode="numeric"
              value={form.graceMin}
              onChange={(e) => setForm((f) => ({ ...f, graceMin: Number(e.target.value) }))}
              className={inputCls}
            />
          </div>
        </div>
        <button
          type="button"
          onClick={save}
          disabled={busy}
          className="w-full rounded-os bg-accent px-4 py-2.5 text-sm font-semibold text-accentink hover:opacity-90 disabled:opacity-50"
        >
          {busy ? t('punch.recording') : t('common.save')}
        </button>
      </div>
    </div>
  );
}

/* ------------------------------ staff ----------------------------- */

function StaffTab({ store }) {
  const { t } = useLang();
  const [staff, setStaff] = useState([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(null); // null | 'new' | staff row
  const [form, setForm] = useState({ name: '', role: 'cashier', pin: '', active: true, workerType: 'employee', assignedHours: '', organization: '' });
  const [confirmDelete, setConfirmDelete] = useState(null);

  const manager = canManage(store.role);
  const roleLabel = (r) => t(`punch.role${r === 'owner' ? 'Owner' : r === 'manager' ? 'Manager' : r === 'cashier' ? 'Cashier' : 'Unknown'}`);

  const load = useCallback(async () => {
    try {
      setStaff(await backend.pos.listStaff(store.id));
    } catch (err) {
      setError(err.message || t('punch.loadFail'));
    }
  }, [store.id, t]);

  useEffect(() => { load(); }, [load]);

  const openNew = () => {
    setForm({ name: '', role: 'cashier', pin: '', active: true, workerType: 'employee', assignedHours: '', organization: '' });
    setEditing('new');
    setError('');
  };
  const openEdit = (s) => {
    setForm({
      name: s.name, role: s.role, pin: '', active: s.active !== false,
      workerType: s.workerType === 'community' ? 'community' : 'employee',
      assignedHours: s.assignedHours ? String(s.assignedHours) : '',
      organization: s.organization || '',
    });
    setEditing(s);
    setError('');
  };

  const save = async () => {
    if (!form.name.trim()) return setError(t('punch.nameRequired'));
    if (editing === 'new' && !/^\d{4,8}$/.test(form.pin)) {
      return setError(t('punch.pinRule'));
    }
    if (form.pin && !/^\d{4,8}$/.test(form.pin)) {
      return setError(t('punch.pinRule'));
    }
    setBusy(true);
    setError('');
    try {
      await backend.pos.saveStaff(store.id, {
        ...(editing !== 'new' ? { id: editing.id } : {}),
        name: form.name.trim(),
        role: form.role,
        active: form.active,
        workerType: form.workerType,
        assignedHours: form.workerType === 'community' ? Math.max(0, Number(form.assignedHours) || 0) : 0,
        organization: form.workerType === 'community' ? form.organization.trim().slice(0, 120) : '',
        ...(form.pin ? { pin: form.pin } : {}),
      });
      setEditing(null);
      await load();
    } catch (err) {
      setError(err.message === 'PIN_TOO_COMMON' ? t('punch.pinTooCommon') : (err.message || t('punch.punchFail')));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!confirmDelete) return;
    setBusy(true);
    setError('');
    try {
      await backend.pos.deleteStaff(store.id, confirmDelete.id);
      setConfirmDelete(null);
      await load();
    } catch (err) {
      setError(err.message || t('punch.punchFail'));
    } finally {
      setBusy(false);
    }
  };

  if (!manager) {
    return (
      <div className="rounded-os border border-osborder bg-paper p-8 text-center">
        <KeyRound size={24} className="mx-auto text-muted" />
        <p className="mt-2 text-sm font-medium text-ink">{t('punch.restricted')}</p>
        <p className="mt-1 text-xs text-muted">{t('punch.restrictedHint')}</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-ink">
          <Users size={15} className="text-accent" /> {t('punch.staffTitle')}
        </h3>
        <button
          type="button"
          onClick={openNew}
          className="flex items-center gap-1.5 rounded-os bg-accent px-3 py-1.5 text-xs font-semibold text-accentink hover:opacity-90"
        >
          <UserPlus size={13} /> {t('punch.addEmployee')}
        </button>
      </div>

      <ErrorNote message={error} />

      {staff.length === 0 ? (
        <p className="rounded-os border border-osborder bg-paper py-8 text-center text-xs text-muted">
          {t('punch.noStaff')}
        </p>
      ) : (
        <ul className="divide-y divide-osborder rounded-os border border-osborder bg-paper">
          {staff.map((s) => (
            <li key={s.id} className="flex items-center justify-between gap-2 px-4 py-2.5">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-ink">
                  {s.name}
                  {s.active === false && <span className="ml-2 text-[11px] font-normal text-muted">{t('punch.inactive')}</span>}
                </p>
                <p className="text-xs text-muted">
                  {roleLabel(s.role)}
                  {s.workerType === 'community' && (
                    <span className="ml-1.5 rounded-full bg-accent/15 px-2 py-0.5 text-[11px] font-medium text-accent">
                      {t('punch.typeCommunity')}
                    </span>
                  )}
                  {s.workerType === 'community' && s.organization && (
                    <span className="ml-1.5 text-[11px]">{t('punch.referredBy')} : {s.organization}</span>
                  )}
                </p>
              </div>
              <div className="flex shrink-0 gap-1">
                <button
                  type="button"
                  onClick={() => openEdit(s)}
                  className="rounded-os p-1.5 text-muted hover:bg-surface hover:text-ink"
                  aria-label={t('common.edit')}
                >
                  <Pencil size={14} />
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmDelete(s)}
                  className="rounded-os p-1.5 text-muted hover:bg-red-500/10 hover:text-red-600"
                  aria-label={t('common.delete')}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {editing && (
        <Modal title={editing === 'new' ? t('punch.newEmployee') : t('punch.editEmployee', { name: editing.name })} onClose={() => setEditing(null)}>
          <div className="space-y-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-muted">{t('common.name')}</label>
              <input
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder={t('punch.namePh')}
                autoFocus
                className={inputCls}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-xs font-medium text-muted">{t('punch.role')}</label>
                <select value={form.role} onChange={(e) => setForm((f) => ({ ...f, role: e.target.value }))} className={inputCls}>
                  <option value="cashier">{t('punch.roleCashier')}</option>
                  <option value="manager">{t('punch.roleManager')}</option>
                  <option value="owner">{t('punch.roleOwner')}</option>
                </select>
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-muted">
                  {t('punch.pinLabel')} {editing === 'new' ? '' : t('punch.pinKeep')}
                </label>
                <input
                  value={form.pin}
                  onChange={(e) => setForm((f) => ({ ...f, pin: e.target.value.replace(/[^0-9]/g, '').slice(0, 8) }))}
                  placeholder={t('punch.pinPh')}
                  inputMode="numeric"
                  className={inputCls}
                />
              </div>
            </div>
            <label className="flex cursor-pointer items-center gap-2 text-sm text-ink">
              <input
                type="checkbox"
                checked={form.active}
                onChange={(e) => setForm((f) => ({ ...f, active: e.target.checked }))}
                className="h-4 w-4"
              />
              {t('punch.active')}
            </label>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted">{t('punch.workerType')}</label>
              <select
                value={form.workerType}
                onChange={(e) => setForm((f) => ({ ...f, workerType: e.target.value }))}
                className={inputCls}
              >
                <option value="employee">{t('punch.typeEmployee')}</option>
                <option value="community">{t('punch.typeCommunity')}</option>
              </select>
            </div>
            {form.workerType === 'community' && (
              <>
                <p className="-mt-1 text-[11px] text-muted">{t('punch.typeCommunityHint')}</p>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="mb-1 block text-xs font-medium text-muted">{t('punch.assignedHours')}</label>
                    <input
                      value={form.assignedHours}
                      onChange={(e) => setForm((f) => ({ ...f, assignedHours: e.target.value.replace(/[^0-9.]/g, '') }))}
                      placeholder={t('punch.assignedHoursPh')}
                      inputMode="decimal"
                      className={inputCls}
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-muted">{t('punch.referredBy')}</label>
                    <input
                      value={form.organization}
                      onChange={(e) => setForm((f) => ({ ...f, organization: e.target.value.slice(0, 120) }))}
                      placeholder={t('punch.referredByPh')}
                      className={inputCls}
                    />
                  </div>
                </div>
              </>
            )}
            <ErrorNote message={error} />
            <button
              type="button"
              onClick={save}
              disabled={busy}
              className="w-full rounded-os bg-accent px-4 py-2.5 text-sm font-semibold text-accentink hover:opacity-90 disabled:opacity-50"
            >
              {busy ? t('punch.recording') : editing === 'new' ? t('punch.addEmployee') : t('common.save')}
            </button>
          </div>
        </Modal>
      )}

      {confirmDelete && (
        <Modal title={t('punch.deleteStaffTitle')} onClose={() => setConfirmDelete(null)}>
          <p className="text-sm text-muted">
            {t('punch.deleteStaffBody', { name: confirmDelete.name })}
          </p>
          <div className="mt-4 flex gap-2">
            <button
              type="button"
              onClick={() => setConfirmDelete(null)}
              className="flex-1 rounded-os border border-osborder px-4 py-2 text-sm font-medium text-ink hover:border-accent"
            >
              {t('common.cancel')}
            </button>
            <button
              type="button"
              onClick={remove}
              disabled={busy}
              className="flex-1 rounded-os bg-red-500/15 px-4 py-2 text-sm font-semibold text-red-600 hover:bg-red-500/25 disabled:opacity-50"
            >
              {busy ? '…' : t('common.delete')}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

/* -------------------------------- app ------------------------------- */

export default function PunchApp() {
  const { t } = useLang();
  const [tab, setTab] = useState('poincon');
  const [store, setStore] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);

  const TABS = [
    { id: 'poincon', label: t('punch.tabs.terminal'), icon: Clock3 },
    { id: 'feuilles', label: t('punch.tabs.timesheet'), icon: BarChart3 },
    { id: 'horaire', label: t('punch.tabs.schedule'), icon: CalendarDays },
    { id: 'conges', label: t('punch.tabs.timeoff'), icon: CalendarClock },
    { id: 'paie', label: t('punch.tabs.pay'), icon: CircleDollarSign },
    { id: 'employes', label: t('punch.tabs.staff'), icon: Users },
    { id: 'benevolat', label: t('punch.tabs.community'), icon: HeartHandshake },
    { id: 'reglages', label: t('punch.tabs.settings'), icon: Settings },
  ];

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (!backend.pos) throw new Error(t('punch.backendUnsupported'));
        const stores = await backend.pos.listStores();
        if (cancelled) return;
        if (!stores || stores.length === 0) {
          setError(t('punch.noStore'));
        } else {
          setStore(stores[0]);
        }
      } catch (err) {
        if (!cancelled) setError(err.message || t('punch.loadFail'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [t]);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-muted">{t('common.loading')}</p>
      </div>
    );
  }

  if (error || !store) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="max-w-sm text-center">
          <Clock3 size={28} className="mx-auto text-muted" />
          <p className="mt-2 text-sm font-medium text-ink">{t('punch.unavailable')}</p>
          <p className="mt-1 text-xs text-muted">{error || t('punch.noStore')}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-osborder bg-paper px-3 pt-2">
        {TABS.map((tb) => (
          <button
            key={tb.id}
            type="button"
            onClick={() => setTab(tb.id)}
            className={`flex shrink-0 items-center gap-1.5 rounded-t-os border-b-2 px-3 py-2 text-sm font-medium duration-160 ${
              tab === tb.id
                ? 'border-accent text-ink'
                : 'border-transparent text-muted hover:text-ink'
            }`}
          >
            <tb.icon size={14} /> {tb.label}
          </button>
        ))}
        <span className="ml-auto hidden items-center pb-2 text-[11px] text-muted sm:flex">
          {store.name}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto bg-paper/60 p-4">
        {tab === 'poincon' && <TerminalTab store={store} onPunched={() => setRefreshKey((k) => k + 1)} />}
        {tab === 'feuilles' && <TimesheetTab store={store} refreshKey={refreshKey} />}
        {tab === 'horaire' && <ScheduleTab store={store} refreshKey={refreshKey} />}
        {tab === 'conges' && <TimeOffTab store={store} refreshKey={refreshKey} />}
        {tab === 'paie' && <PayTab store={store} refreshKey={refreshKey} />}
        {tab === 'employes' && <StaffTab store={store} />}
        {tab === 'benevolat' && <CommunityTab store={store} />}
        {tab === 'reglages' && <SettingsTab store={store} />}
      </div>
    </div>
  );
}
