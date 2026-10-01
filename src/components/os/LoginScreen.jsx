import React, { useState, useEffect, useRef } from 'react';
import { LogIn, UserPlus, AlertCircle, Timer, X, Languages, KeyRound, MailQuestion, CheckCircle2 } from 'lucide-react';
import { useAuth, TRIAL_USED_KEY } from '../../os/AuthContext.jsx';
import { useLang } from '../../lib/i18n.jsx';
import { backend } from '../../lib/backend/current.js';
import { DriftMark } from './BootScreen.jsx';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function Field({ label, type = 'text', value, onChange, autoComplete, placeholder }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-muted">{label}</span>
      <input
        type={type}
        value={value}
        autoComplete={autoComplete}
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-os border border-osborder bg-paper px-3 py-2 text-sm text-ink outline-none duration-160 focus:border-accent"
      />
    </label>
  );
}

function LangToggle() {
  const { lang, setLang, t } = useLang();
  return (
    <div
      className="flex items-center gap-1 rounded-os bg-paper p-0.5"
      role="group"
      aria-label={t('lang.label')}
      title={t('lang.label')}
    >
      <Languages size={13} className="ml-1.5 text-muted" />
      {[
        { id: 'fr', label: 'FR' },
        { id: 'en', label: 'EN' },
      ].map((l) => (
        <button
          key={l.id}
          type="button"
          onClick={() => setLang(l.id)}
          aria-pressed={lang === l.id}
          className={`rounded-os px-2 py-1 text-xs font-semibold duration-160 ${
            lang === l.id ? 'bg-surface text-ink shadow-os' : 'text-muted hover:text-ink'
          }`}
        >
          {l.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Blocking "choose a new password" screen shown right after landing from a
 * password-reset email link (the recovery session is already active).
 * Rendered by the app shell instead of the desktop until done/cancelled.
 */
export function SetNewPasswordScreen({ onDone }) {
  const { t } = useLang();
  const { signOut } = useAuth();
  const [pw, setPw] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await backend.auth.updateOwnPassword(pw);
      await backend.auth.clearRecoveryPending();
      onDone();
    } catch (err) {
      setError(err.message || t('login.errGeneric'));
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    try {
      await backend.auth.clearRecoveryPending();
      await signOut();
    } finally {
      onDone();
    }
  };

  return (
    <div className="fixed inset-0 overflow-y-auto bg-paper">
      <div className="flex min-h-full items-center justify-center p-4">
        <div className="w-full max-w-sm rounded-os border border-osborder bg-surface p-5 shadow-os sm:p-8">
          <div className="flex flex-col items-center">
            <span className="text-accent"><DriftMark size={36} /></span>
            <h1 className="mt-2 text-xl font-light tracking-tight text-ink">{t('login.newPasswordTitle')}</h1>
          </div>
          <form onSubmit={submit} className="mt-4 space-y-2">
            <Field
              label={t('login.newPasswordLabel')}
              type="password"
              value={pw}
              onChange={setPw}
              autoComplete="new-password"
            />
            {error && (
              <div role="alert" className="flex items-start gap-2 rounded-os border border-osborder bg-paper px-3 py-2 text-sm text-ink">
                <AlertCircle size={16} className="mt-0.5 shrink-0 text-accent" />
                <span>{error}</span>
              </div>
            )}
            <button
              type="submit"
              disabled={busy || pw.length < 8}
              className="flex w-full items-center justify-center gap-2 rounded-os bg-accent px-4 py-2 text-sm font-semibold text-accentink duration-160 hover:opacity-90 disabled:opacity-50"
            >
              <KeyRound size={16} />
              {busy ? t('common.working') : t('login.newPasswordSet')}
            </button>
            <button
              type="button"
              onClick={cancel}
              disabled={busy}
              className="w-full rounded-os px-4 py-2 text-center text-xs font-medium text-muted duration-160 hover:text-ink disabled:opacity-50"
            >
              {t('login.backToSignIn')}
            </button>
          </form>
          <p className="mt-4 text-center text-xs text-muted">© {new Date().getFullYear()} {t('brand.name')}</p>
        </div>
      </div>
    </div>
  );
}

/**
 * Blocking, NON-DISMISSIBLE "change your password" gate shown by the app
 * shell right after sign-in when the profile's must_change_password flag is
 * set (the master account seeded by migration 056, or any account an admin
 * flags). There is deliberately no close/back button: the user cannot reach
 * the desktop until a new password is chosen. On success the auth context
 * clears the flag and the shell proceeds. Same password rules as signup
 * (min length, no all-spaces, no common/repeating passwords).
 */
export function ForcePasswordChangeModal({ onDone }) {
  const { t } = useLang();
  const { completePasswordChange } = useAuth();
  const [pw, setPw] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    if (pw !== confirm) {
      setError(t('login.forceChangeMismatch'));
      return;
    }
    setBusy(true);
    try {
      await completePasswordChange(pw);
      onDone();
    } catch (err) {
      const byCode = {
        'weak-password': 'login.errPassword',
        'common-password': 'login.errPasswordCommon',
        'repeating-password': 'login.errPasswordRepeating',
      };
      if (err && err.code && byCode[err.code]) {
        setError(t(byCode[err.code]));
      } else {
        setError(err.message || t('login.errGeneric'));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 overflow-y-auto bg-paper" role="dialog" aria-modal="true" aria-label={t('login.forceChangeTitle')}>
      <div className="flex min-h-full items-center justify-center p-4">
        <div className="w-full max-w-sm rounded-os border border-osborder bg-surface p-5 shadow-os sm:p-8">
          <div className="flex flex-col items-center">
            <span className="text-accent"><DriftMark size={36} /></span>
            <h1 className="mt-2 text-xl font-light tracking-tight text-ink">{t('login.forceChangeTitle')}</h1>
            <p className="mt-2 text-center text-sm text-muted">{t('login.forceChangeBody')}</p>
          </div>
          <form onSubmit={submit} className="mt-4 space-y-2">
            <Field
              label={t('login.newPasswordLabel')}
              type="password"
              value={pw}
              onChange={setPw}
              autoComplete="new-password"
            />
            <Field
              label={t('login.forceChangeConfirm')}
              type="password"
              value={confirm}
              onChange={setConfirm}
              autoComplete="new-password"
            />
            {error && (
              <div role="alert" className="flex items-start gap-2 rounded-os border border-osborder bg-paper px-3 py-2 text-sm text-ink">
                <AlertCircle size={16} className="mt-0.5 shrink-0 text-accent" />
                <span>{error}</span>
              </div>
            )}
            <button
              type="submit"
              disabled={busy || pw.length < 8 || confirm.length < 8}
              className="flex w-full items-center justify-center gap-2 rounded-os bg-accent px-4 py-2 text-sm font-semibold text-accentink duration-160 hover:opacity-90 disabled:opacity-50"
            >
              <KeyRound size={16} />
              {busy ? t('common.working') : t('login.newPasswordSet')}
            </button>
          </form>
          <p className="mt-4 text-center text-xs text-muted">© {new Date().getFullYear()} {t('brand.name')}</p>
        </div>
      </div>
    </div>
  );
}

/**
 * "Forgot password?" dialog with two paths:
 *  1. Email reset link — for accounts that have a real email address.
 *  2. Help ticket — for username-only accounts with no email; the shop
 *     admin sees it in the support inbox and resets the password.
 */
function ForgotPasswordDialog({ onClose }) {
  const { t } = useLang();
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');

  const sendEmail = async () => {
    setError('');
    setBusy(true);
    try {
      await backend.auth.requestPasswordReset(email);
      setNote(t('login.recoverySent'));
    } catch (e) {
      const msg = String(e?.message || '');
      // Map the backend's English validation to the user's language.
      setError(/valid email address|adresse courriel valide/i.test(msg) ? t('login.errEmail') : (msg || t('login.errGeneric')));
    } finally {
      setBusy(false);
    }
  };

  const sendTicket = async () => {
    setError('');
    setBusy(true);
    try {
      await backend.support.createPublicTicket({
        username,
        subject: 'Password reset request',
        message,
      });
      setNote(t('login.ticketSent'));
    } catch (e) {
      setError(e.message || t('login.errTicket'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={t('login.recoveryTitle')}
    >
      <div
        className="max-h-[90vh] w-full max-w-sm overflow-y-auto rounded-os border border-osborder bg-surface p-5 shadow-oswin"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-2">
          <h2 className="text-base font-semibold text-ink">{t('login.recoveryTitle')}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('common.close')}
            className="rounded-os p-1 text-muted duration-160 hover:bg-paper hover:text-ink"
          >
            <X size={16} />
          </button>
        </div>

        {note ? (
          <p className="mt-3 text-sm leading-relaxed text-ink">{note}</p>
        ) : (
          <>
            <p className="mt-3 text-xs leading-relaxed text-muted">{t('login.recoveryEmailHint')}</p>
            <div className="mt-2 space-y-2">
              <Field
                label={t('login.recoveryEmailLabel')}
                value={email}
                onChange={setEmail}
                autoComplete="email"
                placeholder={t('login.emailPlaceholder')}
              />
              <button
                type="button"
                onClick={sendEmail}
                disabled={busy}
                className="flex w-full items-center justify-center gap-2 rounded-os bg-accent px-4 py-2 text-sm font-semibold text-accentink duration-160 hover:opacity-90 disabled:opacity-50"
              >
                <MailQuestion size={16} />
                {busy ? t('common.working') : t('login.recoverySend')}
              </button>
            </div>

            <div className="my-4 flex items-center gap-3 text-xs text-muted">
              <span className="h-px flex-1 bg-osborder" />
              {t('common.or')}
              <span className="h-px flex-1 bg-osborder" />
            </div>

            <p className="text-xs leading-relaxed text-muted">{t('login.recoveryNoEmailHint')}</p>
            <div className="mt-2 space-y-2">
              <Field
                label={t('login.ticketUsername')}
                value={username}
                onChange={setUsername}
                autoComplete="username"
                placeholder={t('login.ticketUsernamePh')}
              />
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-muted">{t('login.ticketMessage')}</span>
                <textarea
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  placeholder={t('login.ticketMessagePh')}
                  rows={3}
                  className="w-full rounded-os border border-osborder bg-paper px-3 py-2 text-sm text-ink outline-none duration-160 focus:border-accent"
                />
              </label>
              <button
                type="button"
                onClick={sendTicket}
                disabled={busy}
                className="flex w-full items-center justify-center gap-2 rounded-os border border-osborder bg-paper px-4 py-2 text-sm font-medium text-ink duration-160 hover:border-accent disabled:opacity-50"
              >
                <KeyRound size={16} className="text-accent" />
                {busy ? t('common.working') : t('login.ticketSend')}
              </button>
            </div>
          </>
        )}

        {error && (
          <div role="alert" className="mt-3 flex items-start gap-2 rounded-os border border-osborder bg-paper px-3 py-2 text-sm text-ink">
            <AlertCircle size={16} className="mt-0.5 shrink-0 text-accent" />
            <span>{error}</span>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Sign in / create account / guest trial. Real validation, real errors.
 * Cloud-only: one login, one user list. A bare username is mapped to a
 * synthetic email behind the scenes (see AuthContext), so users can sign
 * in with a username or an email address.
 */
export default function LoginScreen() {
  const { signIn, signUp, signInGuest, accessBlock, clearAccessBlock } = useAuth();
  const { t, lang } = useLang();
  const [mode, setMode] = useState('signin'); // 'signin' | 'signup'
  // Single identifier field: accepts a username OR an email address.
  // We detect which one by the presence of '@' — no toggle needed.
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [forgotOpen, setForgotOpen] = useState(false);
  // Synchronous guard against rapid double-clicks: React state updates are
  // async, so `busy` alone can't stop two submits dispatched before the
  // re-render. The ref blocks synchronously.
  const busyRef = useRef(false);
  // The 30-minute free trial is one per device. Once used, the free option
  // is removed from the login screen on this device.
  const [trialAvailable, setTrialAvailable] = useState(() => {
    try {
      return !localStorage.getItem(TRIAL_USED_KEY);
    } catch {
      return true;
    }
  });
  // One-time notice after a factory reset: the reset wiped every account
  // (including the session just used), so the login screen explains why the
  // user is suddenly signed out. Read + cleared on mount.
  const [resetNotice, setResetNotice] = useState(() => {
    try {
      if (localStorage.getItem('driftshop_factory_reset_notice') === '1') {
        localStorage.removeItem('driftshop_factory_reset_notice');
        return true;
      }
    } catch {
      /* non-fatal */
    }
    return false;
  });

  // Security: never retain a password on the login screen. This runs on every
  // mount (including after logout) and defeats both React state reuse and
  // browser autofill on shared shop terminals.
  useEffect(() => {
    setPassword('');
  }, []);

  // Clear a stale error when the language changes: the stored message was
  // translated for the previous language and would otherwise persist
  // untranslated.
  useEffect(() => {
    setError('');
  }, [lang]);

  // The identifier accepts a username OR an email.
  const isEmail = identifier.includes('@');
  const useUsername = !isEmail;

  const validate = () => {
    const id = identifier.trim();
    if (!id) return t('login.errIdentifier');
    if (isEmail && !EMAIL_RE.test(id)) return t('login.errEmail');
    if (useUsername && id.length < 2) return t('login.errUsername');
    if (useUsername && id.length > 64) return t('login.errUsernameTooLong');
    // A username made only of symbols would sanitize to nothing — reject early.
    if (useUsername && !/[a-zA-Z0-9]/.test(id)) return t('login.errUsernameInvalid');
    if (password.length < 8) return t('login.errPassword');
    if (!/\S/.test(password)) return t('login.errPasswordBlank');
    return '';
  };

  const submit = async (e) => {
    e.preventDefault();
    // Block duplicate submits dispatched before React re-renders (rapid clicks).
    if (busyRef.current) return;
    const v = validate();
    if (v) {
      setError(v);
      return;
    }
    setError('');
    setBusy(true);
    busyRef.current = true;
    const id = identifier.trim();
    try {
      if (mode === 'signup') {
        await signUp(id, password, useUsername ? id : undefined);
      } else {
        await signIn(id, password);
      }
    } catch (err) {
      setError(friendlyAuthError(err));
    } finally {
      setBusy(false);
      busyRef.current = false;
    }
  };

  // Map backend auth errors to the user's language.
  const friendlyAuthError = (err) => {
    const byCode = {
      'invalid-email': 'login.errEmail',
      'weak-password': 'login.errPassword',
      'common-password': 'login.errPasswordCommon',
      'repeating-password': 'login.errPasswordRepeating',
      'username-too-short': 'login.errUsername',
      'username-too-long': 'login.errUsernameTooLong',
      'username-required': 'login.errUsernameRequired',
      'username-invalid': 'login.errUsernameInvalid',
      'profile-missing': 'login.errProfileMissing',
      'email-taken': 'login.errEmailTaken',
      'username-taken': 'login.errUsernameTaken',
      'invalid-credentials': 'login.errInvalidCreds',
    };
    if (err && err.code && byCode[err.code]) return t(byCode[err.code]);
    const msg = String(err?.message || '');
    if (/already exists|déjà/i.test(msg) && /email|courriel/i.test(msg)) return t('login.errEmailTaken');
    if (/taken|pris/i.test(msg) && /username|utilisateur/i.test(msg)) return t('login.errUsernameTaken');
    // Backend throws English ("Enter a valid email address.", "Sign in failed:
    // Invalid login credentials") — map them to the user's language.
    if (/common-password/i.test(msg)) return t('login.errPasswordCommon');
    if (/repeating-password/i.test(msg)) return t('login.errPasswordRepeating');
    if (/username-too-long/i.test(msg)) return t('login.errUsernameTooLong');
    if (/username-invalid/i.test(msg)) return t('login.errUsernameInvalid');
    if (/profile-missing/i.test(msg)) return t('login.errProfileMissing');
    if (/valid email address|adresse courriel valide/i.test(msg)) return t('login.errEmail');
    if (/invalid/i.test(msg) && /email|username|password|credentials|mot de passe|identifiants/i.test(msg)) return t('login.errInvalidCreds');
    // Never surface raw database/PostgREST internals (e.g. "Cannot coerce
    // the result to a single JSON object") — fall back to a generic message.
    if (/coerce|postgrest|supabase|database|sql/i.test(msg)) return t('login.errGeneric');
    return msg || t('login.errGeneric');
  };

  const guest = async () => {
    if (busyRef.current) return;
    setError('');
    setBusy(true);
    busyRef.current = true;
    try {
      await signInGuest();
      setTrialAvailable(false);
    } catch (err) {
      setError(err.message || t('login.errGuest'));
    } finally {
      setBusy(false);
      busyRef.current = false;
    }
  };

  return (
    <div className="fixed inset-0 overflow-y-auto bg-paper">
      <div className="flex min-h-full items-center justify-center p-4">
      <div className="w-full max-w-sm rounded-os border border-osborder bg-surface p-5 shadow-os sm:p-8 [@media(max-height:660px)]:px-5 [@media(max-height:660px)]:py-4">
        <div className="flex items-start justify-between">
          <div className="w-16" />
          <div className="flex flex-col items-center">
            <span className="text-accent">
              <DriftMark size={36} />
            </span>
            <h1 className="mt-2 text-2xl font-light tracking-tight text-ink">{t('brand.name')}</h1>
            <p className="mt-1 text-center text-sm text-muted">{t('brand.tagline')}</p>
          </div>
          <LangToggle />
        </div>

        <p className="mt-4 text-center text-xs text-muted">
          {t('login.cloudHint')}
        </p>

        <div className="mt-3 grid grid-cols-2 gap-1 rounded-os bg-paper p-1">
          {[
            { id: 'signin', label: t('login.signIn') },
            { id: 'signup', label: t('login.signUp') },
          ].map((b) => (
            <button
              key={b.id}
              type="button"
              onClick={() => {
                setMode(b.id);
                setError('');
              }}
              className={`rounded-os px-3 py-1.5 text-sm font-medium duration-160 ${
                mode === b.id ? 'bg-surface text-ink shadow-os' : 'text-muted hover:text-ink'
              }`}
            >
              {b.label}
            </button>
          ))}
        </div>

        {accessBlock && (
          <div role="alert" className="mb-4 flex items-start gap-2 rounded-os border border-osborder bg-paper px-3 py-2.5 text-sm text-ink">
            <AlertCircle size={16} className="mt-0.5 shrink-0 text-accent" />
            <span className="min-w-0 flex-1">
              <span className="block font-medium">{t(accessBlock.titleKey)}</span>
              <span className="block text-muted">
                {(() => {
                  let msg = t(accessBlock.messageKey);
                  if (accessBlock.messageParams) {
                    for (const [k, v] of Object.entries(accessBlock.messageParams)) {
                      msg = msg.replace(`{${k}}`, v);
                    }
                  }
                  return msg;
                })()}
              </span>
            </span>
            <button
              type="button"
              onClick={clearAccessBlock}
              aria-label={t('common.close')}
              className="rounded-os p-1 text-muted duration-160 hover:bg-surface hover:text-ink"
            >
              <X size={14} />
            </button>
          </div>
        )}

        <form onSubmit={submit} className="mt-3 space-y-2">
          {resetNotice && (
            <div role="status" className="flex items-start gap-2 rounded-os border border-osborder bg-paper px-3 py-2.5 text-sm text-ink">
              <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-accent" />
              <span>{t('adminUsers.factoryResetDoneNotice')}</span>
            </div>
          )}
          <Field
            label={t('login.identifier')}
            value={identifier}
            onChange={setIdentifier}
            autoComplete="username"
            placeholder={t('login.identifierPlaceholder')}
          />
          <Field
            label={t('login.password')}
            type="password"
            value={password}
            onChange={setPassword}
            autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
          />

          {mode === 'signin' && (
            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => setForgotOpen(true)}
                className="text-xs font-medium text-accent duration-160 hover:underline"
              >
                {t('login.forgotPassword')}
              </button>
            </div>
          )}

          {error && (
            <div role="alert" className="flex items-start gap-2 rounded-os border border-osborder bg-paper px-3 py-2 text-sm text-ink">
              <AlertCircle size={16} className="mt-0.5 shrink-0 text-accent" />
              <span>{error}</span>
            </div>
          )}

          <button
            type="submit"
            disabled={busy}
            aria-busy={busy}
            className="flex w-full items-center justify-center gap-2 rounded-os bg-accent px-4 py-2 text-sm font-semibold text-accentink duration-160 hover:opacity-90 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
          >
            {mode === 'signup' ? <UserPlus size={16} /> : <LogIn size={16} />}
            {busy ? t('common.working') : mode === 'signup' ? t('login.createAccount') : t('login.signIn')}
          </button>
        </form>

        {trialAvailable && (
          <>
            <div className="my-3 flex items-center gap-3 text-xs text-muted">
              <span className="h-px flex-1 bg-osborder" />
              {t('common.or')}
              <span className="h-px flex-1 bg-osborder" />
            </div>

            <button
              type="button"
              onClick={guest}
              disabled={busy}
              className="flex w-full items-center justify-center gap-2 rounded-os border border-osborder bg-paper px-4 py-2 text-sm font-medium text-ink duration-160 hover:border-accent disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
            >
              <Timer size={16} className="text-accent" />
              {t('login.tryTrial')}
            </button>
            <p className="mt-1 text-center text-xs text-muted">
              {t('login.tryTrialHint')}
            </p>
          </>
        )}

        <p className="mt-4 text-center text-xs text-muted">© {new Date().getFullYear()} {t('brand.name')}</p>
      </div>
      </div>
      {forgotOpen && <ForgotPasswordDialog onClose={() => setForgotOpen(false)} />}
    </div>
  );
}
