import React, { createContext, useContext, useEffect, useState, useCallback, useRef } from 'react';
import { backend } from '../lib/backend/current.js';
import { evaluateAccess, ACCESS_CHECK_MS, TRIAL_USED_KEY } from './accessPolicy.js';

const AuthContext = createContext(null);

/**
 * Auth state for the Drift OS shell.
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
      // Fail CLOSED on read errors: if we cannot verify the profile, do not
      // grant desktop access. A fail-open here let unpaid/blocked accounts
      // into a dead desktop with no valid session. Sign out to clear any
      // stale session and show a clear message.
      console.error('[drift] access check failed, signing out:', e);
      try {
        await backend.auth.signOut();
      } catch {}
      setUser(null);
      setProfile(null);
      setIsAdmin(false);
      setAccessChecked(false);
      setAccessBlock({
        kind: 'verify-failed',
        title: 'Could not verify account',
        message: 'We could not verify your account status. Check your connection and try signing in again.',
      });
      setAuthEpoch((ep) => ep + 1);
      return { kind: 'verify-failed' };
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

  // Cloud mode accepts usernames too: we map a bare username to a synthetic
  // email on a reserved domain so Supabase auth works unchanged. The user
  // only ever sees their username. Note: @lfdd.local is rejected by Supabase's
  // email validation on signup, so we use @lfdd.app (passes validation).
  const toCloudEmail = (identifier) => {
    const id = identifier.trim();
    if (!id) {
      const e = new Error('username-required');
      e.code = 'username-required';
      throw e;
    }
    if (id.includes('@')) return id;
    // Validate: only allow letters/numbers/dots/underscores/dashes.
    // Reject loudly if the username contains anything else (spaces, emoji,
    // special chars) instead of silently stripping them — silent stripping
    // causes confusing collisions (e.g. "test user" and "test!user" both
    // becoming "testuser").
    const lower = id.toLowerCase();
    if (!/^[a-z0-9._-]+$/.test(lower)) {
      const e = new Error('username-invalid');
      e.code = 'username-invalid';
      throw e;
    }
    // Reject overlong usernames loudly instead of silently truncating —
    // silent truncation causes confusing collisions ("a"×64 vs "a"×79
    // becoming the same account).
    if (lower.length > 64) {
      const e = new Error('username-too-long');
      e.code = 'username-too-long';
      throw e;
    }
    const safe = lower.slice(0, 64);
    // A username that sanitizes to nothing (e.g. "!@#$") must not silently
    // collapse into a shared fallback identity — reject it loudly.
    if (!safe) {
      const e = new Error('username-invalid');
      e.code = 'username-invalid';
      throw e;
    }
    return `${safe}@lfdd.app`;
  };

  const assertSanePassword = (password) => {
    // Supabase only enforces min length; an all-spaces password would pass.
    // Require at least one non-whitespace character (idiot-proofing).
    if (!password || !/\S/.test(password)) {
      const e = new Error('weak-password');
      e.code = 'weak-password';
      throw e;
    }
    // Reject common weak passwords that meet length but are trivially guessable.
    const weak = [
      'password', 'password123', '12345678', 'qwerty123', 'letmein123',
      'welcome123', 'admin123', 'abc12345', 'password1', '123456789',
    ];
    if (weak.includes(password.toLowerCase())) {
      const e = new Error('common-password');
      e.code = 'common-password';
      throw e;
    }
    // Reject low-entropy passwords: all same character ("aaaaaaaa"), or a
    // short pattern repeated ("abcabcabc", "123123123"). These pass length
    // checks but are trivially guessable.
    const lower = password.toLowerCase();
    if (/^(.)\1+$/.test(lower)) {
      const e = new Error('repeating-password');
      e.code = 'repeating-password';
      throw e;
    }
    // Check for repeated patterns of length 1-4 covering the whole password.
    for (let len = 1; len <= 4; len++) {
      if (lower.length % len !== 0) continue;
      const pattern = lower.slice(0, len);
      if (pattern.repeat(lower.length / len) === lower && lower.length / len >= 3) {
        const e = new Error('repeating-password');
        e.code = 'repeating-password';
        throw e;
      }
    }
  };

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
    const cloudEmail = toCloudEmail(email);
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

  const signIn = useCallback(async (email, password) => {
    explicitAuthRef.current = true;
    try {
      const { user: u } = await backend.auth.signIn({ email: toCloudEmail(email), password });
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

  const value = { user, loading, signUp, signIn, signInGuest, signOut, accessBlock, clearAccessBlock, isAdmin, profile, accessChecked, authEpoch };
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>.');
  return ctx;
}

// Re-exported for unit tests.
export { evaluateAccess, ACCESS_CHECK_MS, TRIAL_USED_KEY };
