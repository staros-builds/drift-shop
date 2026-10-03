/**
 * Account recovery settings section (Settings app).
 *
 * Email-independent recovery management for the signed-in user:
 *  - Recovery codes: generate a set of one-time codes, shown exactly once
 *    (copy/print), each usable once to reset the password with no email.
 *  - Security questions: 3 questions + answers (answers salted+hashed).
 *
 * Shown inside SettingsApp as the "Account recovery" section. When
 * migration 098 is not applied yet, shows the friendly "needs a small
 * system update" note instead of raw errors.
 */
import { useCallback, useEffect, useState } from 'react';
import { KeyRound, HelpCircle, Copy, Printer, Check, X, RefreshCw, ShieldCheck } from 'lucide-react';
import { backend } from '../lib/backend/current.js';
import { useLang } from '../lib/i18n.jsx';
import { useNotifications } from '../os/NotificationsContext.jsx';

const PRESET_KEYS = ['qPet', 'qStreet', 'qTeacher', 'qFood', 'qCity', 'qMotherMaiden', 'qCar', 'qBook'];
const CUSTOM_VALUE = '__custom__';

function questionText(key, t) {
  if (key === CUSTOM_VALUE) return t('recovery.customQuestion');
  return t(`recovery.${key}`);
}

function ShowOnceModal({ codes, onDone, t }) {
  const [copied, setCopied] = useState(false);
  const copyAll = async () => {
    try {
      await navigator.clipboard.writeText(codes.join('\n'));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard unavailable — user can select manually */
    }
  };
  const print = () => {
    const w = window.open('', '_blank', 'width=600,height=700');
    if (!w) return;
    const rows = codes.map((c) => `<div style="font-family:monospace;font-size:22px;letter-spacing:2px;margin:10px 0;">${c}</div>`).join('');
    w.document.write(`<html><head><title>${t('recovery.codesTitle')}</title></head><body style="padding:40px;"><h2>${t('recovery.codesShowOnceTitle')}</h2><p>${t('recovery.codesShowOnceBody')}</p>${rows}<script>window.print()</script></body></html>`);
    w.document.close();
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true" aria-label={t('recovery.codesShowOnceTitle')}>
      <div className="w-full max-w-sm rounded-os border border-osborder bg-surface p-5 shadow-oswin">
        <div className="flex items-start justify-between gap-2">
          <h3 className="text-base font-semibold text-ink">{t('recovery.codesShowOnceTitle')}</h3>
          <ShieldCheck size={18} className="shrink-0 text-accent" />
        </div>
        <p className="mt-2 text-xs leading-relaxed text-muted">{t('recovery.codesShowOnceBody')}</p>
        <div className="mt-3 select-all break-all rounded-os border border-osborder bg-paper p-3 font-mono text-sm tracking-widest text-ink">
          {codes.map((c) => (
            <div key={c} className="py-0.5">{c}</div>
          ))}
        </div>
        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
          <button
            type="button"
            onClick={copyAll}
            className="flex flex-1 items-center justify-center gap-2 rounded-os border border-osborder bg-paper px-3 py-2 text-sm text-ink duration-160 hover:border-accent"
          >
            {copied ? <Check size={15} /> : <Copy size={15} />}
            {copied ? t('recovery.codesCopied') : t('recovery.copyCodes')}
          </button>
          <button
            type="button"
            onClick={print}
            className="flex flex-1 items-center justify-center gap-2 rounded-os border border-osborder bg-paper px-3 py-2 text-sm text-ink duration-160 hover:border-accent"
          >
            <Printer size={15} />
            {t('recovery.printCodes')}
          </button>
        </div>
        <button
          type="button"
          onClick={onDone}
          className="mt-3 w-full rounded-os bg-accent px-4 py-2 text-sm font-semibold text-accentink duration-160 hover:opacity-90"
        >
          {t('recovery.codesDone')}
        </button>
      </div>
    </div>
  );
}

function QuestionRow({ index, value, customText, answer, onChange, t }) {
  const set = (patch) => onChange(index, { ...value, ...patch });
  return (
    <div className="rounded-os border border-osborder bg-paper p-3">
      <label className="block text-xs font-medium text-muted">{t('recovery.questionLabel', { n: index + 1 })}</label>
      <select
        value={value.preset}
        onChange={(e) => set({ preset: e.target.value })}
        className="mt-1 w-full rounded-os border border-osborder bg-surface px-3 py-2 text-sm text-ink outline-none duration-160 focus:border-accent"
      >
        <option value="">—</option>
        {PRESET_KEYS.map((k) => (
          <option key={k} value={k}>{questionText(k, t)}</option>
        ))}
        <option value={CUSTOM_VALUE}>{t('recovery.customQuestion')}</option>
      </select>
      {value.preset === CUSTOM_VALUE && (
        <input
          value={customText}
          onChange={(e) => set({ customText: e.target.value })}
          placeholder={t('recovery.customQuestion')}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          className="mt-2 w-full rounded-os border border-osborder bg-surface px-3 py-2 text-sm text-ink outline-none duration-160 focus:border-accent"
        />
      )}
      <label className="mt-2 block text-xs font-medium text-muted">{t('recovery.answerLabel')}</label>
      <input
        value={answer}
        onChange={(e) => set({ answer: e.target.value })}
        type="password"
        autoComplete="off"
        placeholder={t('recovery.answerPh')}
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        className="mt-1 w-full rounded-os border border-osborder bg-surface px-3 py-2 text-sm text-ink outline-none duration-160 focus:border-accent"
      />
    </div>
  );
}

export default function RecoverySettings() {
  const { t } = useLang();
  const { push } = useNotifications();
  const [available, setAvailable] = useState(null);
  const [codeCount, setCodeCount] = useState(null);
  const [questionsSet, setQuestionsSet] = useState(null);
  const [busy, setBusy] = useState(false);
  const [showOnce, setShowOnce] = useState(null);
  const [confirmRegen, setConfirmRegen] = useState(false);
  const [editingQuestions, setEditingQuestions] = useState(false);
  const [qState, setQState] = useState([
    { preset: '', customText: '', answer: '' },
    { preset: '', customText: '', answer: '' },
    { preset: '', customText: '', answer: '' },
  ]);
  const [qError, setQError] = useState('');

  const refresh = useCallback(async () => {
    try {
      const ok = await backend.recovery.isAvailable();
      setAvailable(ok);
      if (!ok) return;
      const [n, qs] = await Promise.all([
        backend.recovery.unusedCodeCount().catch(() => null),
        backend.recovery.getMyQuestions().catch(() => null),
      ]);
      setCodeCount(n);
      setQuestionsSet(Array.isArray(qs) ? qs.length > 0 : null);
    } catch {
      setAvailable(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const doGenerate = async (replace) => {
    setBusy(true);
    try {
      const codes = await backend.recovery.generateCodes();
      setShowOnce(codes);
      setConfirmRegen(false);
      await refresh();
    } catch (e) {
      push(e?.code === 'recovery-needs-update' ? t('recovery.needsUpdateBody') : (e.message || String(e)));
    } finally {
      setBusy(false);
    }
  };

  const qRowChange = (i, row) => setQState((s) => s.map((r, j) => (j === i ? row : r)));

  const saveQuestions = async () => {
    setQError('');
    const items = [];
    for (const r of qState) {
      const question = r.preset === CUSTOM_VALUE ? `custom:${r.customText.trim()}` : r.preset;
      items.push({ question, answer: r.answer });
    }
    setBusy(true);
    try {
      await backend.recovery.setSecurityQuestions(items);
      setEditingQuestions(false);
      setQState([
        { preset: '', customText: '', answer: '' },
        { preset: '', customText: '', answer: '' },
        { preset: '', customText: '', answer: '' },
      ]);
      push(t('recovery.questionsSaved'));
      await refresh();
    } catch (e) {
      const c = e?.code || '';
      if (c === 'security-questions-question-required' || c === 'security-questions-question-count') setQError(t('recovery.errQuestionRequired'));
      else if (c === 'security-questions-answer-too-short') setQError(t('recovery.errAnswerShort'));
      else if (c === 'security-questions-question-duplicate') setQError(t('recovery.errQuestionDuplicate'));
      else setQError(e.message || String(e));
    } finally {
      setBusy(false);
    }
  };

  if (available === false) {
    return (
      <section className="mb-8">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted">{t('recovery.sectionTitle')}</h2>
        <p className="text-xs leading-relaxed text-muted">{t('recovery.needsUpdateBody')}</p>
      </section>
    );
  }

  return (
    <section className="mb-8">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted">{t('recovery.sectionTitle')}</h2>
      <p className="mb-4 max-w-prose text-xs leading-relaxed text-muted">{t('recovery.sectionBody')}</p>

      {/* Recovery codes */}
      <div className="mb-4 rounded-os border border-osborder bg-surface p-4">
        <div className="flex items-center gap-2">
          <KeyRound size={16} className="text-accent" />
          <h3 className="text-sm font-semibold text-ink">{t('recovery.codesTitle')}</h3>
        </div>
        <p className="mt-2 text-xs leading-relaxed text-muted">{t('recovery.codesBody')}</p>
        <p className="mt-2 text-xs text-muted">
          {codeCount === null ? '…' : codeCount === 0 ? t('recovery.codesNone') : t('recovery.codesCount', { n: codeCount })}
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          {codeCount === 0 || codeCount === null ? (
            <button
              type="button"
              onClick={() => doGenerate(false)}
              disabled={busy || available !== true}
              className="flex items-center gap-2 rounded-os bg-accent px-4 py-2 text-sm font-semibold text-accentink duration-160 hover:opacity-90 disabled:opacity-40"
            >
              <KeyRound size={15} />
              {busy ? t('recovery.working') : t('recovery.generateCodes')}
            </button>
          ) : confirmRegen ? (
            <>
              <span className="w-full text-xs text-muted">{t('recovery.confirmRegenerate')}</span>
              <button
                type="button"
                onClick={() => doGenerate(true)}
                disabled={busy}
                className="flex items-center gap-2 rounded-os bg-accent px-4 py-2 text-sm font-semibold text-accentink duration-160 hover:opacity-90 disabled:opacity-40"
              >
                <RefreshCw size={15} />
                {busy ? t('recovery.working') : t('recovery.regenerateCodes')}
              </button>
              <button
                type="button"
                onClick={() => setConfirmRegen(false)}
                className="flex items-center gap-2 rounded-os border border-osborder bg-paper px-4 py-2 text-sm text-muted duration-160 hover:text-ink"
              >
                <X size={15} />
                {t('recovery.close')}
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmRegen(true)}
              disabled={busy}
              className="flex items-center gap-2 rounded-os border border-osborder bg-paper px-4 py-2 text-sm text-ink duration-160 hover:border-accent disabled:opacity-40"
            >
              <RefreshCw size={15} />
              {t('recovery.regenerateCodes')}
            </button>
          )}
        </div>
      </div>

      {/* Security questions */}
      <div className="rounded-os border border-osborder bg-surface p-4">
        <div className="flex items-center gap-2">
          <HelpCircle size={16} className="text-accent" />
          <h3 className="text-sm font-semibold text-ink">{t('recovery.questionsTitle')}</h3>
        </div>
        <p className="mt-2 text-xs leading-relaxed text-muted">{t('recovery.questionsBody')}</p>
        {!editingQuestions ? (
          <>
            <p className="mt-2 text-xs text-muted">
              {questionsSet === null ? '…' : questionsSet ? t('recovery.questionsSet') : t('recovery.questionsNotSet')}
            </p>
            <button
              type="button"
              onClick={() => { setEditingQuestions(true); setQError(''); }}
              disabled={busy || available !== true}
              className="mt-3 flex items-center gap-2 rounded-os border border-osborder bg-paper px-4 py-2 text-sm text-ink duration-160 hover:border-accent disabled:opacity-40"
            >
              <HelpCircle size={15} />
              {questionsSet ? t('recovery.changeQuestions') : t('recovery.setupQuestions')}
            </button>
          </>
        ) : (
          <div className="mt-3 space-y-2">
            {qState.map((r, i) => (
              <QuestionRow key={i} index={i} value={r} customText={r.customText} answer={r.answer} onChange={qRowChange} t={t} />
            ))}
            {qError && <p role="alert" className="text-xs text-ink">{qError}</p>}
            <div className="flex flex-wrap gap-2 pt-1">
              <button
                type="button"
                onClick={saveQuestions}
                disabled={busy}
                className="flex items-center gap-2 rounded-os bg-accent px-4 py-2 text-sm font-semibold text-accentink duration-160 hover:opacity-90 disabled:opacity-40"
              >
                <Check size={15} />
                {busy ? t('recovery.working') : t('recovery.saveQuestions')}
              </button>
              <button
                type="button"
                onClick={() => setEditingQuestions(false)}
                className="flex items-center gap-2 rounded-os border border-osborder bg-paper px-4 py-2 text-sm text-muted duration-160 hover:text-ink"
              >
                <X size={15} />
                {t('recovery.close')}
              </button>
            </div>
          </div>
        )}
      </div>

      {showOnce && (
        <ShowOnceModal codes={showOnce} onDone={() => { setShowOnce(null); refresh(); }} t={t} />
      )}
    </section>
  );
}
