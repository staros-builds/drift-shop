/**
 * Account access policy — pure logic, no imports (unit-testable).
 *
 * Decide whether a profile may use the OS right now.
 * Returns null when access is fine, or { kind, title, message } when blocked.
 * Admins have unlimited access — checks never apply to them.
 */

// How often a signed-in session re-checks its account status (locks,
// temporary disables, trial expiry). 30s keeps enforcement tight without
// hammering the database.
export const ACCESS_CHECK_MS = 30_000;

// One free trial per device: once a trial starts (or expires) on this
// browser, the trial button is removed from the login screen here.
export const TRIAL_USED_KEY = 'drift:trial-used';

export function evaluateAccess(profile) {
  if (!profile) return null;
  if (profile.role === 'admin') return null;
  if (profile.is_locked) {
    return {
      kind: 'locked',
      titleKey: 'login.blockLockedTitle',
      messageKey: 'login.blockLockedMsg',
    };
  }
  if (profile.disabled_until && new Date(profile.disabled_until).getTime() > Date.now()) {
    const mins = Math.max(
      1,
      Math.ceil((new Date(profile.disabled_until).getTime() - Date.now()) / 60000)
    );
    return {
      kind: 'disabled',
      titleKey: 'login.blockDisabledTitle',
      messageKey: 'login.blockDisabledMsg',
      messageParams: { mins, plural: mins === 1 ? '' : 's' },
    };
  }
  const trialLive =
    profile.trial_ends_at && new Date(profile.trial_ends_at).getTime() > Date.now();
  if (!profile.is_paid && !trialLive) {
    if (profile.is_guest) {
      return {
        kind: 'expired',
        titleKey: 'login.blockTrialEndedTitle',
        messageKey: 'login.blockTrialEndedMsg',
      };
    }
    return {
      kind: 'unpaid',
      titleKey: 'login.blockUnpaidTitle',
      messageKey: 'login.blockUnpaidMsg',
    };
  }
  return null;
}
