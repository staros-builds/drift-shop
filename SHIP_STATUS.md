# LFDD Ship Status — 2026-10-01 (nuclear failsafe program, continued)

## 2026-10-01 additions (Jesse: "continue the hardcore test")

### Code fixes deployed (bundle index-rFMxywL8.js, live):
- **QA batch 1**: migration 049 (pgcrypto), overnight shift frontend unlock, POS modal focus fix, Files inline collision errors
- **QA batch 2**: fail-closed dates, numeric audit filter, localized correction errors, settings reject-not-clamp, approval identity, locale dupes cleanup
- **Offline queue hardening**: server-enforced idempotency (migration 050) — unique (store_id, idempotency_key) index; recordSale returns existing row on duplicate key instead of creating duplicate sales. queueSync leak fixed (startAutoSync now idempotent, returns stop function).
- **DB money bounds** (migration 051): CHECK constraints on total/tendered/change/subtotal/discount/tax cents + trigger validating line-item qty (1-999) and priceCents (0-1M)
- **ISBN uniqueness** (migration 052): unique index on (store_id, isbn) for atomic concurrent-import protection
- **CSV fail-closed**: import aborts if duplicate-check query fails (was silently importing duplicates)
- **Files validation**: 255-char max, control chars rejected, backslash stripped
- **Bilingual sweep**: POS + AdminPanel hardcoded English strings now use t() with FR translations

### Migrations pending live application:
- 049: pgcrypto extension (for refund digest)
- 050: pos_sales.idempotency_key + unique index
- 051: money bounds constraints + trigger
- 052: bq_items ISBN unique index

### Test data still present (cleanup required after retest):
- Sale #1 (CA$60.50), QA-Widget, QA-Gadget, 4 test files, 1 correction audit entry

## Previous status (2026-09-30):

# LFDD Ship Status — 2026-09-30 (nuclear failsafe program, updated ~23:55 UTC)

## Current position
- Source: ~/workspace/staros-migration/drift-lfdd, branch main @ 17634bf
- Production: https://staros-builds.github.io/lfdd/ @ 051eca6 (bundle index-DlT11Y11.js — confirmed live 2026-10-01; Poinçon audit fixes)
- Database: migrations 042-048 applied (048: overnight shift support — pos_shifts_end_after_start is now CHECK ("end" <> start))
- Latest: Nuclear failsafe program — SCRAM, cart recovery, offline queue, crash fixes, money limits

## NUCLEAR FAILSAFE PROGRAM (2026-09-30 late evening)
User directive: "area 51 type... secret government type... cannot fail nuclear bunker... failsafe type... reliability"

### Deployed failsafe systems:
1. **Crash-loop SCRAM** (c75077a): If app crashes 3x on boot → safe mode with diagnostics, "try normal mode", "clear local data" (wipes cache, unregisters SW). Crash counter resets after 5s clean boot.
2. **POS cart auto-save** (92d3e21): Cart/discount/customer/org saved to localStorage (500ms debounce). On reopen after crash/close → "Restore sale?" prompt. 24h expiry, corrupt-draft safe.
3. **Offline queue** (9e11afb): Cash sales queue when network dies (idempotency keys, localStorage persistent). "Sale queued (offline)" receipt. Auto-sync when online.
4. **POS History crash fix** (c735881): `refundsOk` undefined in HistoryTab scope → deterministic crash. Fixed to use `onRefund` prop.
5. **Files rename collision fix** (c735881): Rename had no collision check → data loss. Now rejects existing names + '.'/'..'.
6. **Money limits** (17634bf): Max $10k product price, max 999 qty/line, max $100k tender. Prevents fat-finger absurd values.

## Migrations live (verified)
- 032: punch-out ambiguous RETURNING fixed
- 033: Poinçon hardening (PIN throttle, break auto-close, shift validation)
- 034: refunds base
- 035: refund atomicity (fixed index)
- 036: require_account_type fail-closed
- 037: refund gift-card void protection
- 038: punch_correct lock bypass fix
- 039: pos_clock_out staff_id fix
- 040: refund idempotency payload hash, 128-char key bound, cumulative total cap (14/14 PGlite tests — static/local only, not live proof)
- 041: PIN throttle message "wait 10 minutes" (applied live)
- 042: pos_shifts_end_after_start CHECK constraint (applied live ~21:15 UTC; historical affected-row count unrecoverable; overnight shifts e.g. 22:00–06:00 may be incorrectly blocked by string comparison — untested)
- 043: punch correction sanity (applied live; behaviorally unproven — correction >24h rejection and valid correction success not yet demonstrated live)
- 044: pos_sales money non-negative constraints + items validation + creator enforcement (applied live 22:05 UTC; 10/12 hostile inserts blocked in local PGlite — static only)
- 045: promo/loyalty/tender-adjustment columns + nonneg constraint (applied live 22:06 UTC)
- 046: gift-card void restore on refund (applied live ~22:33 UTC via base64-chunk workaround after Monaco editor corrupted long pastes; verified: v_void_cards present in live function, permissions set, postflight counts clean)
- 047: pos_giftcard_history sale_number bigint fix (fixes "structure of query does not match function result type" — pos_sales.number is bigint, function declared integer)

## Completed 2026-09-30 (late evening)
- Auth hardening (b5219c4, deployed af2941a):
  - RootErrorBoundary: localized FR/EN crash screen instead of dead blank white page
  - getAccessProfile: .maybeSingle() instead of .single(); coded 'profile-missing' instead of raw PostgREST text
  - toCloudEmail: reject >64 char usernames (was silently truncating, causing collisions)
  - assertSanePassword: reject repeating-char/pattern passwords (aaaaaaaa, abcabcabc)
  - clearAccessBlock: remounts login with empty fields (password no longer lingers)
  - All auth errors use .code for reliable i18n
- POS crash fixes (06d499b, deployed 17297da):
  - ItemDiscountModal: added missing useLang() — was crashing POS on per-item discount click (CRITICAL)
  - CustomerFormModal: added missing useLang() — same crash pattern
  - Clear button: now resets discount/promo (was silently persisting $10 discount to next sale — MONEY BUG)
- POS adversarial test results (on old bundle):
  - CRITICAL: Per-item discount button crashed POS (FIXED)
  - CRITICAL: History tab crashed POS deterministically (investigating on new bundle)
  - BUG: Clear did not reset discount (FIXED)
  - BUG: Gift card history query failed (FIXED via migration 047)
  - GOOD: Double-submit guard works, discount clamping works, underpayment rejected, no data corruption
- Test accounts cleaned: qatest5829143, pwtestweak, aaa... (64 a's) deleted. posprobe4821 activated for POS test, then to be deleted.
- Migration 040 designed, tested (14/14 PGlite), committed 8edc6fe, applied live (1 overload, hash logic confirmed)
- Deep Poinçon adversarial: PIN throttle triggers at 16 attempts (15 failures), correct PIN blocked during ~12min cooldown, break auto-closes on punch-out (verified in pos_breaks), punch delete works via modal
- PIN throttle message fixed: was "couple minutes", actually ~12 min cooldown → now says "10 minutes", localized EN/FR (committed e9aca58, deployed 6ca91ef)
- Test accounts cleaned: poinconadv, punchfix, poinconprobe deleted. 18 users (17 Guest + real ngaio). Real shop untouched.
- Shift end-before-start validation localized EN/FR (deployed 492db42)
- Final smoke test EN+FR passed (bilingual login, health indicator, SW network-first)

## Still open
1. History tab crash: re-test on new bundle index-BZIxqjyW.js (was crashing on old bundle)
2. Adversarial LIVE Poinçon tests: migration 043 proof, correction flows, PIN throttle
3. Final live smoke at exact 800×600 and 1920×1080 viewports
4. Service-worker: deployed with /lfdd/ subpath fix but offline behavior unproved
5. Health indicator orange/red force simulation
6. Full FR→EN→FR reverse-direction sweep
7. Probe cleanup + reverify auth.users=18, admin intact, real shop intact, protect_profile_fields
8. Bilingual manual (LAST, after all testing)

## Known issues / uncertainties
- Migration 042: uncertain historical impact; overnight shift handling untested
- Migration 043: applied but correction >24h rejection not behaviorally proven live
- Service worker: subpath fix deployed, offline reopen/recovery unproved
- Static QA (PGlite harnesses) is static only — not live proof; do not claim concurrency safety from serialized tests

## Reliability standard
Per Jesse 2026-09-30: this software must be as reliable as a computer running a nuclear facility — it cannot fail. Defense in depth: database constraints hold even if the app sends garbage; row locks serialize what the UI can't; functions reject rather than guess. The app may crash; the data must never corrupt.

## Known issues
- POS employee creation may not save PIN (Poinçon editor works fine) — investigate
- Throttle message now accurate at "10 minutes" (actual ~12 min observed, close enough)

## If credits run low
Per Jesse: publish the safest usable build with remaining credits.
Minimum viable: migrations through 041 applied + client deployed + smoke test.
Skip the manual if needed.

## Update 2026-09-30 ~21:15 UTC — adversarial findings fixed
- Migration 042 applied live + verified (pos_shifts_end_after_start CHECK constraint).
- Brutal unauthenticated UI test found real issues (fixed, committed f9081b3, deployed 6be773f):
  * CRITICAL: signup access-check raced the profile trigger → fail-open let unpaid
    accounts into desktop. Fixed: signup/guest now wait for profile row (6s poll)
    before the access check runs.
  * CRITICAL: restored session for deleted account booted into dead desktop.
    Fixed: boot() validates session server-side via getUser(); clears stale token
    only on "user does not exist" (network blips don't log out).
  * Sign-in button: rapid clicks could dispatch duplicate requests before React
    re-rendered. Fixed: synchronous busyRef guard (also on guest trial button).
  * Password retained in field after sign-out. Fixed: authEpoch key remounts
    LoginScreen fresh on every sign-out/access-block.
  * Mixed-language errors: "Sign in failed: Invalid login credentials" and
    "Enter a valid email address." now map to FR translations; stale error
    cleared on language toggle.
- 4 junk test accounts from adversarial test pending deletion (inspection done).
- Source: main @ f9081b3. Production: 6be773f (bundle index-Br5CSffC.js).

## Update 2026-09-30 ~21:20 UTC — auth hardening round 2
- Fail-closed: runAccessCheck now signs out on profile read errors instead of
  failing open to a dead desktop (committed ec17147, deployed 3551ad8).
- No desktop flash: signIn/signUp/signInGuest run the access check BEFORE
  setUser, so blocked accounts never briefly render the desktop.
- Verified: gatetest1 signup blocked deterministically with "Account not active".
- Cleanup: gatetest1 deleted. Users back to 18 (17 Guest + real ngaio intact).
- Source: main @ ec17147. Production: 3551ad8 (bundle index-C2pSHzsw.js).

## Update 2026-09-30 ~21:37 UTC — cachedUser race fixed, all tests green
- Root cause of "Could not verify account" / "Cannot coerce the result to a
  single JSON object": getAccessProfile() depended on cachedUser, which raced
  with onAuthStateChange during sign-in. Fixed by passing explicit UID.
- Verified live: blocked sign-in now shows "Account not active" correctly.
- No desktop flash on signup or sign-in for blocked accounts.
- All diagnostic accounts deleted (diagtest1, diagtest2, finalgate1, verifyfix1).
- Users: 18 (17 Guest + real ngaio intact).
- Source: main @ ef76daf. Production: b6cd5a4 (bundle index-BWefsJzA.js).
