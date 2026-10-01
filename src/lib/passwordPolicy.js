/**
 * Shared password-strength policy for user-chosen passwords.
 *
 * Supabase only enforces a minimum length on its side, so the app layers
 * its own sanity rules here. Every surface that lets a user pick a
 * password (signup, the forced first-login change, admin-created
 * accounts) must call assertSanePassword — never duplicate this list.
 *
 * Throws a coded Error (.code is one of 'weak-password',
 * 'common-password', 'repeating-password'); the login screens map codes
 * to localized strings.
 */
export function assertSanePassword(password) {
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
}
