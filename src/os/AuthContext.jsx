import React, { createContext, useContext, useEffect, useState, useCallback, useRef } from 'react';
import { backend } from '../lib/backend/current.js';
import { evaluateAccess, ACCESS_CHECK_MS, TRIAL_USED_KEY } from './accessPolicy.js';
import { loginIdToEmail } from '../lib/loginId.js';
import { assertSanePassword } from '../lib/passwordPolicy.js';
import { savePendingFlow, clearPendingFlow } from '../lib/authFlow.js';

const AuthContext = createContext(null);

/**
 * Auth state for the Vendra OS shell.
 * loading stays true until the first getUser()/onAuthChange settles.
 * All auth errors propagate as thrown Errors — LoginScreen displays them.
 *
 * accessBlock is set when the account may not use the OS (locked, temporarily
 * disabled, trial expired). The user is signed out and LoginScreen shows the
 * reason. clearAccessBlock dismisses the banner (the block itself is enforced
 * server-side, so dismissing never grants access).
 */
export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [accessBlock, setAccessBlock] = useState(null);
  const [isAdmin, setIsAdmin] = useState(false);
  // The caller's profile row (account_type, device_store_id, ...). The Shell
  // reads account_type to route device accounts to their kiosk instead of
  // the desktop. Null until the first access check completes.
  const [profile, setProfile] = useState(null);
  // True once the first access check has completed (successfully or not),
  // so the Shell can wait for the profile before choosing desktop vs kiosk.
  const [accessChecked, setAccessChecked] = useState(false);
  // Monotonic counter bumped on every sign-out. Used as a React key on the
  // login screen to guarantee fresh (empty) credential fields after logout.
  const [authEpoch, setAuthEpoch] = useState(0);
  const userRef = useRef(null);
  userRef.current = user;
  // True while an explicit signIn/signUp/signInGuest is in progress. The
  // onAuthStateChange listener skips setUser during this window so a blocked
  // account can't flash the desktop via the listener race.
  const explicitAuthRef = useRef(false);

  // Fetch the caller's profile and enforce the access rule.
  // Backends without getAccessProfile skip enforcement (defensive).
  // Takes the user explicitly so sign-in flows check the new session
  // deterministically instead of racing the state update.
  const runAccessCheck = useCallback(async (explicitUser) => {
    const u = explicitUser !== undefined ? explicitUser : userRef.current;
    if (!u) {
      setIsAdmin(false);
      return null;
    }
    if (typeof backend.auth.getAccessProfile !== 'function') {
      setIsAdmin(false);
      return null;
    }
    let profile = null;
    try {
      // Pass the explicit UID to avoid cachedUser race during sign-in.
      profile = await backend.auth.getAccessProfile(u.id);
    } catch (e) {
      // Do NOT sign out on transient read errors — that would wipe the
      // session globally across all tabs (including a storefront customer
      // tab). Show the verify-failed block and let the user retry; only
      // sign out on positive evidence the account is gone/blocked.
      console.error('[drift] access check failed (session preserved):', e);
      setIsAdmin(false);
      setAccessChecked(false);
      setAccessBlock({
        kind: 'verify-failed',
        title: 'Could not verify account',
        message: 'We could not verify your account status. Check your connection and try again.',
      });
      setAuthEpoch((ep) => ep + 1);
      return { kind: 'verify-failed' };
    }
    // Customer accounts never use the desktop shell (they sign in on shop
    // storefronts). If a customer session arrives here via multi-tab
    // BroadcastChannel sync, leave it completely alone — signing out would
    // destroy the customer's storefront session in every tab.
    if (profile && profile.account_kind === 'customer') {
      return null;
    }
    // The fetched profile is the shell's source of truth for admin-only
    // surfaces (Admin app listing, openWindow gate) and for device-account
    // kiosk routing in App.jsx.
    setProfile(profile);
    setIsAdmin(profile?.role === 'admin');
    setAccessChecked(true);
    const block = evaluateAccess(profile);
    if (block) {
      try {
        await backend.auth.signOut();
      } catch (e) {
        console.error('[drift] sign-out during access block failed:', e);
      }
      setUser(null);
      setProfile(null);
      setAccessChecked(false);
      setAccessBlock(block);
      setAuthEpoch((e) => e + 1);
      if (block.kind === 'expired') {
        try {
          localStorage.setItem(TRIAL_USED_KEY, '1');
        } catch {}
      }
    }
    return block;
  }, []);

  const clearAccessBlock = useCallback(() => {
    setAccessBlock(null);
    // Bump the auth epoch so the login screen remounts with empty fields.
    // A blocked sign-in must not leave the password lingering in the form
    // on a shared shop terminal.
    setAuthEpoch((e) => e + 1);
  }, []);

  useEffect(() => {
    let settled = false;
    const settle = (next) => {
      // Skip during explicit sign-in/up: that flow manages user state itself
      // after the access check, and we must not flash the desktop via this
      // listener race.
      if (explicitAuthRef.current) return;
      setUser(next || null);
      if (!settled) {
        settled = true;
        setLoading(false);
      }
    };
    try {
      settle(backend.auth.getUser());
    } catch (e) {
      console.error('[drift] auth restore failed:', e);
      settle(null);
    }
    const unsub = backend.auth.onAuthChange((next) => settle(next));
    return () => {
      if (typeof unsub === 'function') unsub();
    };
  }, []);

  // Enforce access on every new session (fresh sign-in or restored session)
  // and re-check periodically while signed in, so an admin lock, a temporary
  // disable, or a trial expiry takes effect promptly.
  const userId = user?.id;
  useEffect(() => {
    if (!userId) return;
    let alive = true;
    runAccessCheck();
    const timer = setInterval(() => {
      if (alive) runAccessCheck();
    }, ACCESS_CHECK_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [userId, runAccessCheck]);

  // Password-strength policy lives in src/lib/passwordPolicy.js (shared with
  // the forced first-login password change). Imported above as assertSanePassword.

  // The profile row is created by a database trigger when the auth user is
  // inserted. It should exist by the time signup returns, but if the read
  // races the trigger the access check would fail open on the missing row
  // and let an unpaid account straight into the desktop. Poll briefly so the
  // gate always sees the real profile. Pass the explicit UID to avoid
  // cachedUser race during sign-in.
  const waitForAccessProfile = useCallback(async (uid, timeoutMs = 6000) => {
    const start = Date.now();
    for (;;) {
      try {
        await backend.auth.getAccessProfile(uid);
        return;
      } catch (e) {
        if (Date.now() - start >= timeoutMs) {
          // Don't leak the raw backend error (e.g. PostgREST internals) —
          // throw a coded error the UI can localize.
          const friendly = new Error('profile-missing');
          friendly.code = 'profile-missing';
          throw friendly;
        }
        await new Promise((r) => setTimeout(r, 250));
      }
    }
  }, []);

  const signUp = useCallback(async (email, password, username) => {
    assertSanePassword(password);
    const cloudEmail = loginIdToEmail(email);
    const displayName = username || (email.includes('@') ? email.split('@')[0] : email.trim()) || 'user';
    explicitAuthRef.current = true;
    try {
      const { user: u } = await backend.auth.signUp({ email: cloudEmail, password, username: displayName });
      // Do NOT setUser yet: run the access check first so a blocked account
      // never flashes the desktop. runAccessCheck signs out and sets the block
      // message on failure; we only setUser if access is granted.
      setAccessBlock(null);
      setAccessChecked(false);
      await waitForAccessProfile(u.id);
      const block = await runAccessCheck(u);
      if (!block) {
        setUser(u);
      }
      return u;
    } finally {
      explicitAuthRef.current = false;
    }
  }, [runAccessCheck, waitForAccessProfile]);

  // One-login email signup (2026-10-01): real email + confirmation email.
  // kind: 'owner' (default, in-app signup) | 'customer' (from a shop page).
  // Returns { status: 'needs-confirmation', email } — the caller shows the
  // check-your-email panel — or { status: 'signed-in', user } when the
  // project has confirmation off, in which case the normal access-checked
  // sign-in path runs. The pending flow is saved BEFORE the backend call so
  // the confirmation landing can route even if this tab is closed.
  const signUpEmail = useCallback(async ({ email, password, displayName, kind, slug }) => {
    assertSanePassword(password);
    const accountKind = kind === 'customer' ? 'customer' : 'owner';
    savePendingFlow({ kind: accountKind, slug });
    explicitAuthRef.current = true;
    try {
      const res = await backend.auth.signUpWithEmail({
        email,
        password,
        displayName,
        kind: accountKind,
        slug,
      });
      if (res.status === 'signed-in') {
        const u = res.user;
        setAccessBlock(null);
        setAccessChecked(false);
        await waitForAccessProfile(u.id);
        const block = await runAccessCheck(u);
        if (!block) setUser(u);
        clearPendingFlow();
        return { status: 'signed-in', user: u };
      }
      return res;
    } catch (e) {
      // Don't leave a stale pending record behind a failed signup — the
      // next confirmation landing would otherwise misroute.
      clearPendingFlow();
      throw e;
    } finally {
      explicitAuthRef.current = false;
    }
  }, [runAccessCheck, waitForAccessProfile]);

  const signIn = useCallback(async (email, password) => {
    explicitAuthRef.current = true;
    try {
      const { user: u } = await backend.auth.signIn({ email: loginIdToEmail(email), password });
      // Do NOT setUser yet: run the access check first so a blocked account
      // never flashes the desktop. runAccessCheck signs out and sets the block
      // message on failure; we only setUser if access is granted.
      setAccessBlock(null);
      setAccessChecked(false);
      const block = await runAccessCheck(u);
      if (!block) {
        setUser(u);
      }
      return u;
    } finally {
      explicitAuthRef.current = false;
    }
  }, [runAccessCheck]);

  // Social sign-in (Google/GitHub): saves the pending flow first so the
  // provider round trip lands in the right place (owner → desktop,
  // customer → their shop), then hands off to the backend. The browser
  // normally navigates away; a refusal (provider not enabled yet) clears
  // the pending record and throws a coded error for the UI.
  const signInOAuth = useCallback(async ({ provider, kind, slug }) => {
    const accountKind = kind === 'customer' ? 'customer' : 'owner';
    savePendingFlow({ kind: accountKind, slug });
    explicitAuthRef.current = true;
    try {
      return await backend.auth.signInWithOAuth({ provider, kind: accountKind, slug });
    } catch (e) {
      clearPendingFlow();
      throw e;
    } finally {
      explicitAuthRef.current = false;
    }
  }, []);

  // Passwordless sign-in ("email me a login link"): saves the pending flow
  // first so the link landing routes like a confirmation (owner → desktop,
  // customer → their shop), then asks the backend to send the link. The
  // browser stays put; only a send failure comes back here as an error.
  const signInMagicLink = useCallback(async ({ email, kind, slug }) => {
    const accountKind = kind === 'customer' ? 'customer' : 'owner';
    savePendingFlow({ kind: accountKind, slug });
    explicitAuthRef.current = true;
    try {
      return await backend.auth.signInWithMagicLink({ email, kind: accountKind, slug });
    } catch (e) {
      clearPendingFlow();
      throw e;
    } finally {
      explicitAuthRef.current = false;
    }
  }, []);

  const signInGuest = useCallback(async () => {
    if (typeof backend.auth.signInGuest !== 'function') {
      throw new Error('Guest sign-in is not available with this backend.');
    }
    explicitAuthRef.current = true;
    try {
      const { user: u } = await backend.auth.signInGuest();
      // Do NOT setUser yet: run the access check first so a blocked/expired
      // trial never flashes the desktop.
      setAccessBlock(null);
      try {
        localStorage.setItem(TRIAL_USED_KEY, '1');
      } catch {}
      await waitForAccessProfile(u.id);
      const block = await runAccessCheck(u);
      if (!block) {
        setUser(u);
      }
      return u;
    } finally {
      explicitAuthRef.current = false;
    }
  }, [runAccessCheck, waitForAccessProfile]);

  const signOut = useCallback(async () => {
    await backend.auth.signOut();
    setUser(null);
    setIsAdmin(false);
    setProfile(null);
    setAccessChecked(false);
    // Bump the auth epoch so the login screen remounts fresh (no retained
    // password) even if React would otherwise reuse the component instance.
    setAuthEpoch((e) => e + 1);
  }, []);

  // Forced first-login password change (master account seeded by migration
  // 056, or any account an admin flags with must_change_password). Enforces
  // the shared password policy, updates the auth password, then clears the
  // flag and merges the profile so the shell gate opens. Throws coded
  // Errors (same codes as signup) — the modal localizes them.
  const completePasswordChange = useCallback(async (newPassword) => {
    assertSanePassword(newPassword);
    if (typeof backend.auth.updateOwnPassword !== 'function'
        || typeof backend.auth.clearMustChangePassword !== 'function') {
      throw new Error('Password change is not available with this backend.');
    }
    await backend.auth.updateOwnPassword(newPassword);
    await backend.auth.clearMustChangePassword();
    setProfile((p) => (p ? { ...p, must_change_password: false } : p));
  }, []);

  const value = { user, loading, signUp, signUpEmail, signIn, signInOAuth, signInMagicLink, signInGuest, signOut, completePasswordChange, accessBlock, clearAccessBlock, isAdmin, profile, accessChecked, authEpoch };
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>.');
  return ctx;
}

// Re-exported for unit tests.
export { evaluateAccess, ACCESS_CHECK_MS, TRIAL_USED_KEY };
