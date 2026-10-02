-- 077_pin_throttle_revoke.sql — QA minor m-1: pos_pin_throttle_check was
-- probe-able by any authenticated user (it exposes whether a shop is
-- currently PIN-throttled). Migrations 033/041 revoked from public+anon,
-- but Supabase default privileges grant EXECUTE to the authenticated
-- role at creation; a FROM PUBLIC revoke never removes those.
--
-- Deliberately NO re-grant: every caller is a SECURITY DEFINER function
-- (023 staff login, 033/039 punch RPCs, 069 pos_staff_login2) invoking
-- it via PERFORM as the function owner. Verified: zero client-side
-- references to this function under src/.
-- Idempotent: safe to re-run.

revoke all on function public.pos_pin_throttle_check(uuid) from public, anon, authenticated;
