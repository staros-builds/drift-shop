-- 080_oauth_account_kind.sql
--
-- Post-OAuth account classification (Jesse, 2026-10-01): social sign-in
-- (Google/GitHub via Supabase signInWithOAuth) cannot carry signup metadata
-- the way email signup does, so migration 070's handle_new_user() trigger
-- records profiles.account_kind = NULL for fresh OAuth users. A fresh OAuth
-- OWNER would then miss the accessPolicy.js setup carve-out
-- (account_kind === 'owner') and hit the unpaid-access gate.
--
-- This migration adds public.classify_oauth_profile(p_kind), a SECURITY
-- DEFINER function the client calls once after the OAuth callback lands
-- (consumeAuthCallback in src/lib/backend/supabase.js). It stamps
-- account_kind = 'owner' | 'customer' from the pending auth flow
-- (?authflow=owner|customer carried on the OAuth redirect URL, same as the
-- email flow) — but ONLY when the profile's account_kind is currently NULL.
--
-- Safety properties (deliberate):
--   - Never overwrites an existing classification: an email-signed-up owner
--     who later signs in with Google keeps 'owner'; a customer stays
--     'customer'. No downgrade, no upgrade, no customer->owner escalation.
--   - OAuth owner classification grants nothing email signup doesn't: anyone
--     can already sign up by email as an owner (public flow), so stamping
--     'owner' from the OAuth landing is equivalent, not an escalation. Shop
--     licensing, trial, lock, and admin checks are untouched.
--   - Callable by any authenticated user, but the WHERE account_kind IS NULL
--     guard makes it a no-op for every classified account — the blast radius
--     is exactly one NULL row: the caller's own fresh OAuth profile.
--   - The protect_profile_fields trigger does not guard account_kind, and
--     SECURITY DEFINER avoids depending on any particular profiles UPDATE
--     RLS policy.
--
-- Idempotent: CREATE OR REPLACE. Safe to re-run. Expand-only: no existing
-- object is altered. Factory reset needs no change (profiles rows are wiped
-- and re-seeded; the function is schema, not data).

create or replace function public.classify_oauth_profile(p_kind text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid;
  v_kind text;
begin
  if p_kind not in ('owner', 'customer') then
    raise exception 'classify_oauth_profile: kind must be ''owner'' or ''customer''';
  end if;
  v_uid := auth.uid();
  if v_uid is null then
    raise exception 'classify_oauth_profile: sign in required';
  end if;
  -- Stamp only an unclassified profile. Matched-row or not, return the
  -- profile's current classification so the client can route on it.
  update public.profiles
     set account_kind = p_kind
   where id = v_uid
     and account_kind is null;
  select account_kind into v_kind from public.profiles where id = v_uid;
  return v_kind;
end $$;

grant execute on function public.classify_oauth_profile(text) to authenticated;

comment on function public.classify_oauth_profile(text) is
  'Post-OAuth callback classification: stamps profiles.account_kind (owner|customer) for a fresh OAuth signup exactly once — only when currently NULL. Never overwrites an existing classification.';
