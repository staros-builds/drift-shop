-- 058_master_column_guard.sql
--
-- Close a privilege-escalation hole in protect_profile_fields().
--
-- The hole: migration 057 added is_master to the trigger's guarded column
-- list, but the guard was the blanket "if public.is_admin() then return
-- new" early-return — so ANY administrator could run
--   update public.profiles set is_master = true where id = <own id>
-- (allowed by the profiles_admin_all RLS policy) and then call the
-- master-only factory_reset() RPC. is_master is the factory-reset
-- privilege; mere admin-ness must not be able to grant it.
--
-- The fix: changing the is_master column now requires the CALLER to be a
-- master themselves, checked FIRST — before the admin early-return, so a
-- non-master admin can never slip through. All other guarded columns keep
-- the existing admin-only rule; must_change_password stays unguarded
-- (see 056: the owner must clear their own first-login flag).
--
-- No legitimate flow breaks:
--   - the only writers of is_master are migrations 056 (seed) and 057
--     (factory-reset reseed), and BOTH run their privileged UPDATEs with
--     protect_profile_fields DISABLEd (see their headers), so the tighter
--     check never fires for them;
--   - handle_new_user() creates profile rows via INSERT (this is a BEFORE
--     UPDATE trigger) and never sets is_master (it keeps the false
--     default);
--   - the app never writes is_master from the client (grep the tree: only
--     reads in AdminPanel.jsx / supabase.js).
--
-- Idempotent: CREATE OR REPLACE on the function only (the trigger already
-- exists and calls the function by name); safe to re-run. NOT yet applied
-- to any live project (no Supabase project exists for this build); the
-- buyer runs supabase/migrations/ 001-058 in order in the SQL editor.

create or replace function public.protect_profile_fields()
returns trigger
language plpgsql as $$
begin
  -- is_master is the factory-reset privilege: only a master may grant or
  -- revoke it. This check comes FIRST, before the admin early-return, so a
  -- non-master administrator cannot self-grant is_master (privilege
  -- escalation) and then call factory_reset().
  if new.is_master is distinct from old.is_master then
    if not exists (
      select 1 from public.profiles where id = auth.uid() and is_master = true
    ) then
      raise exception 'Only the master account can change the is_master flag.';
    end if;
  end if;

  if public.is_admin() then
    return new;
  end if;

  if new.role             is distinct from old.role
     or new.is_paid        is distinct from old.is_paid
     or new.is_locked      is distinct from old.is_locked
     or new.disabled_until is distinct from old.disabled_until
     or new.trial_started_at is distinct from old.trial_started_at
     or new.trial_ends_at    is distinct from old.trial_ends_at
     or new.is_guest       is distinct from old.is_guest
     or new.account_type   is distinct from old.account_type
     or new.created_by     is distinct from old.created_by
     or new.device_store_id is distinct from old.device_store_id
  then
    raise exception 'Only an administrator can change account status fields.';
  end if;
  return new;
end $$;
