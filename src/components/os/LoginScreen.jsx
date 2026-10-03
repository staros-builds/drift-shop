import React, { useState, useEffect, useRef } from 'react';
import { LogIn, UserPlus, AlertCircle, Timer, X, Languages, KeyRound, Mail, MailQuestion, CheckCircle2, Store, ShoppingBag, ArrowRight } from 'lucide-react';
import { useAuth, TRIAL_USED_KEY } from '../../os/AuthContext.jsx';
import { useLang } from '../../lib/i18n.jsx';
import { backend } from '../../lib/backend/current.js';
import { getRestorePending } from '../../lib/backupRestore.js';
import { BRAND } from '../../lib/brand.js';
import {
  validateSignupEmail,
  resendCooldownRemaining,
  readAndClearAuthNotice,
  OAUTH_PROVIDERS,
} from '../../lib/authFlow.js';
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
        { id: 'es', label: 'ES' },
        { id: 'pt', label: 'PT' },
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
 * "Visiting a shop?" — the customer-facing door: type a shop's public web
 * address to jump to its storefront (#/store/<slug>). Shared by the Shop
 * login view (compact, at the bottom) and the Customer view (prominent,
 * front and center). Designed as a welcoming doorway: medallion icon,
 * clear value props, pill input + arrow button, and a tap-to-try example.
 */
function VisitShopPanel({ t, shopSlug, setShopSlug, visitShop, prominent }) {
  const tryExample = () => setShopSlug(t('login.visitShopExampleSlug'));
  return (
    <div className={prominent
      ? 'rounded-os border border-osborder bg-paper p-5 text-center'
      : 'mt-4 rounded-os border border-osborder bg-paper p-4 text-center'}>
      <span
        aria-hidden="true"
        className="inline-flex rounded-full p-2.5 text-accent"
        style={{ background: 'color-mix(in srgb, var(--os-accent) 12%, transparent)' }}
      >
        <Store size={prominent ? 22 : 18} />
      </span>
      <p className={`mt-2 font-semibold text-ink ${prominent ? 'text-base' : 'text-sm'}`}>
        {t('login.visitShopTitle')}
      </p>
      <p className="mx-auto mt-1 max-w-xs text-xs leading-relaxed text-muted">
        {t('login.visitShopBody')}
      </p>
      <p className="mx-auto mt-1 max-w-xs text-xs leading-relaxed text-muted">
        {t('login.visitShopPerks')}
      </p>
      <form onSubmit={visitShop} className="mx-auto mt-3 flex max-w-xs items-center gap-2">
        <input
          type="text"
          value={shopSlug}
          onChange={(e) => setShopSlug(e.target.value)}
          placeholder={t('login.shopAddressPh')}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="go"
          aria-label={t('login.visitShopTitle')}
          className="min-w-0 flex-1 rounded-full border border-osborder bg-surface px-4 py-2.5 text-sm text-ink outline-none duration-160 focus:border-accent"
        />
        <button
          type="submit"
          aria-label={t('login.visitShopBtn')}
          className="flex shrink-0 items-center gap-1.5 rounded-full bg-accent px-4 py-2.5 text-sm font-semibold text-accentink duration-160 hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-paper"
        >
          {t('login.visitShopBtn')}
          <ArrowRight size={15} />
        </button>
      </form>
      <p className="mt-2.5 text-xs text-muted">
        {t('login.visitShopTryLabel')}{' '}
        <button
          type="button"
          onClick={tryExample}
          className="rounded-full border border-osborder bg-surface px-2.5 py-0.5 font-mono text-xs text-accent duration-160 hover:border-accent"
        >
          {t('login.visitShopExampleSlug')}
        </button>
      </p>
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
  const { signIn, signUpEmail, signInOAuth, signInMagicLink, signInGuest, accessBlock, clearAccessBlock } = useAuth();
  const { t, lang } = useLang();
  const [mode, setMode] = useState('signin'); // 'signin' | 'signup'
  // Top-level audience toggle: 'shop' (owners/staff — the full login flow)
  // or 'customer' (shoppers — a lightweight door to public storefronts).
  const [audience, setAudience] = useState('shop'); // 'shop' | 'customer'
  // Single identifier field: accepts a username OR an email address.
  // We detect which one by the presence of '@' — no toggle needed.
  const [identifier, setIdentifier] = useState('');
  // Signup is email-only (one login, 2026-10-01): a real address the
  // confirmation email can reach. Sign-in keeps the legacy identifier
  // field so existing username accounts still work.
  const [signupEmail, setSignupEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [forgotOpen, setForgotOpen] = useState(false);
  // After signupWithEmail returns needs-confirmation: the check-your-email
  // panel replaces the form until the user confirms via the email link.
  const [checkEmail, setCheckEmail] = useState(null); // { email } | null
  const [magicMode, setMagicMode] = useState(false); // passwordless: email me a login link
  const [magicSent, setMagicSent] = useState(null); // { email } | null
  // "Visiting a shop?" — a customer-facing door on the welcome screen: type
  // a shop's public web address to jump to its storefront (#/store/<slug>).
  const [shopSlug, setShopSlug] = useState('');
  const [lastSentAt, setLastSentAt] = useState(0);
  const [nowTick, setNowTick] = useState(() => Date.now());
  // One-time notice from an auth callback landing (e.g. an expired
  // confirmation link). Read + cleared on mount.
  const [notice, setNotice] = useState(null);
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

  // A backup restore may be waiting for its second half (phase 1 wiped the
  // account and signed everyone out). Only READ the flag here — it must
  // survive until the owner finishes the restore in Admin → Danger zone.
  const [restoreNotice] = useState(() => {
    try {
      return getRestorePending() != null;
    } catch {
      return false;
    }
  });
  // One-time auth notice (e.g. expired confirmation link): read + cleared
  // on mount, exactly like the factory-reset notice below.
  useEffect(() => {
    const n = readAndClearAuthNotice();
    if (n && n.kind === 'expired') {
      setNotice('expired');
      setMode('signup');
    }
  }, []);

  // Tick the resend cooldown label while the check-email panel is up.
  useEffect(() => {
    if (!checkEmail) return undefined;
    const id = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, [checkEmail]);

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
      await signIn(id, password);
    } catch (err) {
      setError(friendlyAuthError(err));
    } finally {
      setBusy(false);
      busyRef.current = false;
    }
  };

  // Email-only signup (one login, 2026-10-01). The backend sends a
  // confirmation email; on needs-confirmation the check-email panel takes
  // over. On signed-in (project has confirmation off) the auth context
  // already set the user and the shell takes over.
  const submitSignup = async (e) => {
    e.preventDefault();
    if (busyRef.current) return;
    const v = validateSignupEmail(signupEmail, BRAND.accountsDomain);
    if (!v.ok) {
      setError(t(v.code === 'synthetic-domain' ? 'login.errSyntheticEmail' : 'login.errEmail'));
      return;
    }
    if (password.length < 8) {
      setError(t('login.errPassword'));
      return;
    }
    if (!/\S/.test(password)) {
      setError(t('login.errPasswordBlank'));
      return;
    }
    setError('');
    setBusy(true);
    busyRef.current = true;
    try {
      const res = await signUpEmail({
        email: v.email,
        password,
        displayName: displayName.trim() || undefined,
        kind: 'owner',
      });
      if (res && res.status === 'needs-confirmation') {
        setLastSentAt(Date.now());
        setNowTick(Date.now());
        setCheckEmail({ email: res.email });
      }
    } catch (err) {
      setError(friendlyAuthError(err));
    } finally {
      setBusy(false);
      busyRef.current = false;
    }
  };

  const resendConfirmationEmail = async () => {
    if (busyRef.current || !checkEmail) return;
    if (resendCooldownRemaining(lastSentAt, Date.now()) > 0) return;
    setError('');
    setBusy(true);
    busyRef.current = true;
    try {
      await backend.auth.resendConfirmation({ email: checkEmail.email, kind: 'owner' });
      setLastSentAt(Date.now());
      setNowTick(Date.now());
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
      'email-required': 'login.errEmail',
      'synthetic-domain': 'login.errSyntheticEmail',
      'email-not-confirmed': 'login.errEmailNotConfirmed',
      'email-rate-limited': 'login.errRateLimited',
      'link-expired': 'login.errLinkExpired',
      'weak-password': 'login.errPassword',
      'common-password': 'login.errPasswordCommon',
      'repeating-password': 'login.errPasswordRepeating',
      'username-too-short': 'login.errUsername',
      'username-too-long': 'login.errUsernameTooLong',
      'username-required': 'login.errUsernameRequired',
      'username-invalid': 'login.errUsernameInvalid',
      'profile-missing': 'login.errProfileMissing',
      'oauth-not-enabled': 'login.errOAuthNotEnabled',
      'oauth-provider-unsupported': 'login.errOAuthUnsupported',
      'email-taken': 'login.errEmailTaken',
      'username-taken': 'login.errUsernameTaken',
      'invalid-credentials': 'login.errInvalidCreds',
      'server-config': 'login.errServerConfig',
    };
    if (err && err.code && byCode[err.code]) return t(byCode[err.code]);
    const msg = String(err?.message || '');
    // The server rejecting the app's own API/access key is a SETUP
    // problem with the build, not a credential failure — never let it
    // fall through to the wrong-password message or raw backend text.
    if (/(api|access)[- ]?key/i.test(msg) && /invalid|rejected|refused|wrong/i.test(msg)) {
      return t('login.errServerConfig');
    }
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
    if (/not confirmed|non confirmé/i.test(msg)) return t('login.errEmailNotConfirmed');
    if (/rate|too many/i.test(msg) && /email|courriel|resend|renvoi/i.test(msg)) return t('login.errRateLimited');
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
      // A rejected API key is a build setup problem, never a raw backend
      // string; everything else keeps the honest guest-specific message.
      if (err && err.code === 'server-config') {
        setError(t('login.errServerConfig'));
      } else {
        setError(err.message || t('login.errGuest'));
      }
    } finally {
      setBusy(false);
      busyRef.current = false;
    }
  };

  // Social sign-in: the browser leaves for the provider and returns
  // through the auth callback. Only a refusal (provider not enabled yet)
  // comes back here as an error.
  const oauth = async (provider) => {
    if (busyRef.current) return;
    setError('');
    setBusy(true);
    busyRef.current = true;
    try {
      await signInOAuth({ provider, kind: 'owner' });
    } catch (err) {
      setError(friendlyAuthError(err));
    } finally {
      setBusy(false);
      busyRef.current = false;
    }
  };

  // Passwordless sign-in: the link doubles as signup for a new address, so
  // this lives on the sign-in side only — one obvious door, no wrong choice.
  const sendMagicLink = async (e) => {
    if (e) e.preventDefault();
    if (busyRef.current) return;
    setError('');
    setBusy(true);
    busyRef.current = true;
    try {
      const res = await signInMagicLink({ email: identifier, kind: 'owner' });
      setMagicSent({ email: res.email });
    } catch (err) {
      setError(friendlyAuthError(err));
    } finally {
      setBusy(false);
      busyRef.current = false;
    }
  };

  // "Visiting a shop?": jump to a shop's public storefront. The storefront
  // route is evaluated once at boot (main.jsx), so set the hash and reload
  // — the boot flow renders StorefrontPublic instead of the login screen.
  const visitShop = (e) => {
    e.preventDefault();
    const slug = shopSlug.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(slug)) return;
    window.location.hash = '#/store/' + encodeURIComponent(slug);
    window.location.reload();
  };

  return (
    <div className="fixed inset-0 overflow-y-auto bg-paper">
      {/* Warm welcome glow behind the card — decorative only. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-80"
        style={{ background: 'radial-gradient(60% 100% at 50% 0%, color-mix(in srgb, var(--os-accent) 14%, transparent), transparent)' }}
      />
      <div className="relative flex min-h-full items-center justify-center p-4">
      <div className="w-full max-w-sm rounded-os border border-osborder bg-surface p-5 shadow-os sm:p-8 [@media(max-height:660px)]:px-5 [@media(max-height:660px)]:py-4">
        <div className="flex items-start justify-between">
          <div className="w-16" />
          <div className="flex flex-col items-center">
            <span
              className="rounded-full p-3 text-accent"
              style={{ background: 'color-mix(in srgb, var(--os-accent) 12%, transparent)' }}
            >
              <DriftMark size={36} />
            </span>
            <h1 className="mt-2 text-2xl font-light tracking-tight text-ink">{t('brand.name')}</h1>
            <p className="mt-1 text-center text-sm text-muted">{t('brand.tagline')}</p>
          </div>
          <LangToggle />
        </div>

        {/* Audience toggle: shop owners/staff vs customers — obvious, at the top. */}
        <div
          className="mt-4 grid grid-cols-2 gap-1 rounded-os bg-paper p-1"
          role="tablist"
          aria-label={t('login.audienceLabel')}
        >
          {[
            { id: 'shop', label: t('login.audienceShop'), Icon: Store },
            { id: 'customer', label: t('login.audienceCustomer'), Icon: ShoppingBag },
          ].map((b) => (
            <button
              key={b.id}
              type="button"
              role="tab"
              aria-selected={audience === b.id}
              onClick={() => {
                if (audience === b.id) return;
                setAudience(b.id);
                // Fresh slate for the other audience: no stale errors,
                // passwords, or half-finished auth panels crossing over.
                setError('');
                setPassword('');
                setMagicMode(false);
                setMagicSent(null);
                setCheckEmail(null);
                setNotice(null);
              }}
              className={`flex items-center justify-center gap-1.5 rounded-os px-3 py-2 text-sm font-semibold duration-160 ${
                audience === b.id ? 'bg-surface text-ink shadow-os' : 'text-muted hover:text-ink'
              }`}
            >
              <b.Icon size={15} className={audience === b.id ? 'text-accent' : ''} />
              {b.label}
            </button>
          ))}
        </div>

        {audience === 'shop' ? (
        <>
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
                setCheckEmail(null);
                setMagicMode(false);
                setMagicSent(null);
                setNotice(null);
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

        {magicSent ? (
          <div className="mt-3 space-y-3">
            <div className="flex flex-col items-center text-center">
              <span className="text-accent"><CheckCircle2 size={36} /></span>
              <h2 className="mt-2 text-lg font-semibold text-ink">{t('login.magicLinkTitle')}</h2>
            </div>
            <p className="text-sm leading-relaxed text-ink">
              {t('login.magicLinkBody').replace('{email}', magicSent.email)}
            </p>
            <p className="text-xs leading-relaxed text-muted">
              {t('login.checkEmailSpam')}
            </p>
            {error && (
              <div role="alert" className="flex items-start gap-2 rounded-os border border-osborder bg-paper px-3 py-2 text-sm text-ink">
                <AlertCircle size={16} className="mt-0.5 shrink-0 text-accent" />
                <span>{error}</span>
              </div>
            )}
            <button
              type="button"
              onClick={() => { setMagicSent(null); setMagicMode(false); setError(''); }}
              disabled={busy}
              className="w-full rounded-os px-4 py-2 text-center text-xs font-medium text-muted duration-160 hover:text-ink disabled:opacity-50"
            >
              {t('login.startOver')}
            </button>
          </div>
        ) : checkEmail ? (
          <div className="mt-3 space-y-3">
            <div className="flex flex-col items-center text-center">
              <span className="text-accent"><CheckCircle2 size={36} /></span>
              <h2 className="mt-2 text-lg font-semibold text-ink">{t('login.checkEmailTitle')}</h2>
            </div>
            <p className="text-sm leading-relaxed text-ink">
              {t('login.checkEmailBody').replace('{email}', checkEmail.email)}
            </p>
            <p className="text-xs leading-relaxed text-muted">
              {t('login.checkEmailTakenNote')}
            </p>
            <p className="text-xs leading-relaxed text-muted">
              {t('login.checkEmailSpam')}
            </p>
            {error && (
              <div role="alert" className="flex items-start gap-2 rounded-os border border-osborder bg-paper px-3 py-2 text-sm text-ink">
                <AlertCircle size={16} className="mt-0.5 shrink-0 text-accent" />
                <span>{error}</span>
              </div>
            )}
            {(() => {
              const remaining = resendCooldownRemaining(lastSentAt, nowTick);
              const cooling = remaining > 0;
              return (
                <button
                  type="button"
                  onClick={resendConfirmationEmail}
                  disabled={busy || cooling}
                  className="flex w-full items-center justify-center gap-2 rounded-os bg-accent px-4 py-2 text-sm font-semibold text-accentink duration-160 hover:opacity-90 disabled:opacity-50"
                >
                  {busy ? t('common.working') : cooling
                    ? t('login.resendInSeconds').replace('{s}', String(Math.ceil(remaining / 1000)))
                    : t('login.resendEmail')}
                </button>
              );
            })()}
            <button
              type="button"
              onClick={() => { setCheckEmail(null); setError(''); }}
              disabled={busy}
              className="w-full rounded-os px-4 py-2 text-center text-xs font-medium text-muted duration-160 hover:text-ink disabled:opacity-50"
            >
              {t('login.startOver')}
            </button>
          </div>
        ) : magicMode ? (
        <form onSubmit={sendMagicLink} className="mt-3 space-y-2">
          <p className="text-sm leading-relaxed text-muted">
            {t('login.magicLinkHint')}
          </p>
          <Field
            label={t('login.signupEmailLabel')}
            type="email"
            value={identifier}
            onChange={setIdentifier}
            autoComplete="email"
            placeholder={t('login.identifierPlaceholder')}
          />

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
            <Mail size={16} />
            {busy ? t('common.working') : t('login.magicLinkBtn')}
          </button>
          <button
            type="button"
            onClick={() => { setMagicMode(false); setError(''); }}
            disabled={busy}
            className="w-full rounded-os px-4 py-2 text-center text-xs font-medium text-muted duration-160 hover:text-ink disabled:opacity-50"
          >
            {t('login.magicLinkBack')}
          </button>
        </form>
        ) : (
        <form onSubmit={mode === 'signup' ? submitSignup : submit} className="mt-3 space-y-2">
          {resetNotice && (
            <div role="status" className="flex items-start gap-2 rounded-os border border-osborder bg-paper px-3 py-2.5 text-sm text-ink">
              <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-accent" />
              <span>{t('adminUsers.factoryResetDoneNotice')}</span>
            </div>
          )}
          {restoreNotice && (
            <div role="status" className="flex items-start gap-2 rounded-os border border-osborder bg-paper px-3 py-2.5 text-sm text-ink">
              <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-accent" />
              <span>{t('adminUsers.restoreLoginNotice')}</span>
            </div>
          )}
          {notice === 'expired' && mode === 'signup' && (
            <div role="status" className="flex items-start gap-2 rounded-os border border-osborder bg-paper px-3 py-2.5 text-sm text-ink">
              <AlertCircle size={16} className="mt-0.5 shrink-0 text-accent" />
              <span>{t('login.expiredNotice')}</span>
            </div>
          )}
          {mode === 'signup' ? (
            <>
              <p className="text-xs leading-relaxed text-muted">
                {t('login.signupIsEmailOnly')}
              </p>
              <Field
                label={t('login.signupEmailLabel')}
                type="email"
                value={signupEmail}
                onChange={setSignupEmail}
                autoComplete="email"
                placeholder={t('login.emailPlaceholder')}
              />
              <Field
                label={t('login.displayName')}
                value={displayName}
                onChange={setDisplayName}
                autoComplete="nickname"
                placeholder={t('login.displayNamePlaceholder')}
              />
            </>
          ) : (
            <Field
              label={t('login.identifier')}
              value={identifier}
              onChange={setIdentifier}
              autoComplete="username"
              placeholder={t('login.identifierPlaceholder')}
            />
          )}
          <Field
            label={t('login.password')}
            type="password"
            value={password}
            onChange={setPassword}
            autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
          />

          {mode === 'signin' && !magicMode && (
            <div className="flex items-center justify-between">
              <button
                type="button"
                onClick={() => { setMagicMode(true); setError(''); }}
                className="text-xs font-medium text-accent duration-160 hover:underline"
              >
                {t('login.magicLinkBtn')}
              </button>
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
        )}

        {!checkEmail && (
          <>
            <div className="my-3 flex items-center gap-3 text-xs text-muted">
              <span className="h-px flex-1 bg-osborder" />
              {t('login.oauthOrContinue')}
              <span className="h-px flex-1 bg-osborder" />
            </div>
            <div className="space-y-2">
              {OAUTH_PROVIDERS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => oauth(p.id)}
                  disabled={busy}
                  className="flex w-full items-center justify-center gap-2 rounded-os border border-osborder bg-paper px-4 py-2 text-sm font-medium text-ink duration-160 hover:border-accent disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
                >
                  {t(p.labelKey)}
                </button>
              ))}
            </div>
          </>
        )}

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

        <VisitShopPanel t={t} shopSlug={shopSlug} setShopSlug={setShopSlug} visitShop={visitShop} />
        </>
        ) : (
        <>
        <div className="mt-4 flex flex-col items-center text-center">
          <span
            className="rounded-full p-3 text-accent"
            style={{ background: 'color-mix(in srgb, var(--os-accent) 12%, transparent)' }}
          >
            <ShoppingBag size={28} />
          </span>
          <h2 className="mt-2 text-lg font-semibold text-ink">{t('login.customerTitle')}</h2>
          <p className="mt-1 text-sm leading-relaxed text-muted">{t('login.customerBody')}</p>
        </div>

        <div className="mt-3">
          <VisitShopPanel t={t} shopSlug={shopSlug} setShopSlug={setShopSlug} visitShop={visitShop} prominent />
        </div>

        <p className="mt-3 text-center text-xs text-muted">
          {t('login.customerShopOwnerNote')}
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
