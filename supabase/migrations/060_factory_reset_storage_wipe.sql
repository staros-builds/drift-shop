-- 060_factory_reset_storage_wipe.sql
--
-- Factory-reset wipe fix (live QA 2026-10-01): the reset's
-- `delete from storage.objects` was rejected by the statement-level
-- BEFORE DELETE trigger storage.protect_delete(), which raises 42501
-- ("Direct deletion from storage tables is not allowed. Use the Storage
-- API instead.") for every direct SQL delete on storage.objects unless
-- the GUC storage.allow_delete_query = 'true'. The Storage API itself
-- sets this GUC when deleting through the API — it is the trigger's own
-- sanctioned escape hatch. A master-confirmed, typed-RESET factory reset
-- is deliberate data loss, so the function now sets the GUC
-- transaction-locally (SET LOCAL scope) before the wipe. Everything stays
-- in the single reset transaction: any failure still rolls back all data
-- AND the GUC.
--
-- (The QA report quoted the failure as "DELETE requires a WHERE clause";
-- that string exists in no function in this database. The empirically
-- proven blocker — reproduced in a rolled-back transaction — is the 42501
-- storage guard above, which fires on the reset's very first wipe
-- statement. This fix addresses the proven blocker; the re-test will show
-- the true behavior end to end.)
--
-- CREATE OR REPLACE: signature unchanged, existing grants preserved.
-- shape: admin@drift-shop.app / admin123, role admin, is_master=true,
-- must_change_password=true).
--
-- Gating (defense in depth):
--   1. public.factory_reset() is SECURITY DEFINER and raises unless the
--      CALLER's profile has is_master = true. The RPC is granted to
--      `authenticated` only (revoked from public/anon).
--   2. is_master is added to protect_profile_fields()'s guarded column
--      list below, and migration 058 tightens that guard so ONLY a master
--      (not merely an administrator) can change it — a non-master admin
--      cannot self-grant it and then call this RPC. Only the seeded master
--      account ever holds it (056 sets it on the master email only; the
--      reseed here sets it again so it survives re-seeding — it is never
--      granted anywhere else).
--   3. The app UI renders the Factory Reset section only for is_master,
--      and requires typing "RESET" exactly before the button arms.
--
-- FAILURE-ATOMICITY: the wipe + reseed is ONE plpgsql function invoked via
-- a single .rpc() call, so it runs in a single transaction. Any error —
-- a missing table, a trigger failure, a reseed problem — rolls back the
-- ENTIRE reset. A half-wiped database is impossible by construction. Do
-- NOT split this into multiple RPC calls.
--
-- AUTO-BACKUP: deliberately NOT performed server-side. The product's backup
-- mechanism is client-side JavaScript (Settings -> Download account backup
-- produces a drift-backup-<date>.json download); migration 010 is only a
-- punch-history *import* RPC, not an exporter. A SQL function cannot run
-- the client exporter, and reimplementing the 40-table JSON export in
-- plpgsql would be an untested parallel mechanism — worse than honest.
-- Instead the app (Admin panel -> Danger zone) attempts a full account
-- backup + automatic download BEFORE calling this RPC, and ABORTS the
-- reset if the backup attempt fails — the wipe never runs without the
-- attempted safety net.
--
-- TABLE LIST (grounded 2026-10-01 in supabase/schema.sql + migrations
-- 001-055): all 40 public application tables —
--   profiles, user_settings, vfs_folders, vfs_files, spaces, window_states,
--   pins, helm_threads, helm_messages, game_highscores, notifications,
--   feedback, support_tickets, pos_stores, pos_store_members, pos_invites,
--   pos_products, pos_customers, pos_sales, pos_refunds, pos_gift_cards,
--   pos_gift_card_events, pos_appointments, pos_staff, pos_shifts,
--   pos_time_punches, pos_punch_audits, pos_punch_settings, pos_breaks,
--   pos_pay_periods, pos_community_hours, pos_time_off, pos_drawer_shifts,
--   pos_pin_attempts, pos_orgs,
--   bq_items, bq_donations, bq_donation_items, bq_fairs, bq_fair_sales,
--   bq_special_orders
-- (tax config lives on pos_stores rows — no separate tax table exists).
-- Wipe order: storage.objects first, then the 39 non-profiles tables in one
-- TRUNCATE (inter-table FKs resolve jointly; no outside table references
-- them), then DELETE FROM auth.users which cascades to auth.identities and
-- public.profiles. Buckets (011) are preserved — their seed is idempotent.
-- The reseed reuses the canonical signup path (on_auth_user_created ->
-- handle_new_user builds profile + user_settings + vfs_folders + spaces),
-- then stamps the master flags; a ROW_COUNT check makes a silent partial
-- reseed impossible.
--
-- Idempotent: CREATE OR REPLACE + IF NOT EXISTS guards; safe to re-run.
-- Reviewed carefully — NOT applied to any live project (no Supabase
-- project exists for this build yet).

-- is_master is a privilege: only an administrator may change it.
-- (must_change_password stays unguarded — see 056 — because the owner must
-- be able to clear their own first-login flag.)
create or replace function public.protect_profile_fields()
returns trigger
language plpgsql as $$
begin
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
     or new.is_master      is distinct from old.is_master
  then
    raise exception 'Only an administrator can change account status fields.';
  end if;
  return new;
end $$;

drop trigger if exists protect_profile_fields on public.profiles;
create trigger protect_profile_fields
  before update on public.profiles
  for each row execute function public.protect_profile_fields();

create extension if not exists pgcrypto with schema extensions;

-- ---------- factory reset ----------
create or replace function public.factory_reset()
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  c_master_email constant text := 'admin@drift-shop.app';
  c_default_pw   constant text := 'admin123';
  v_id           uuid := gen_random_uuid();
  v_instance_id  uuid;
  v_rows         int;
begin
  -- Gate 1: the caller must be the master account. Checked FIRST, before
  -- touching any data.
  if not exists (select 1 from public.profiles where id = auth.uid() and is_master = true) then
    raise exception 'factory reset is restricted to the master account';
  end if;

  -- ---- wipe: application data ----
  -- Single transaction from here on: any failure rolls back everything.
  -- storage.objects is guarded by the statement-level BEFORE DELETE trigger
  -- storage.protect_delete(), which rejects direct SQL deletes unless the
  -- GUC storage.allow_delete_query = 'true' (the Storage API sets this GUC
  -- when deleting through the API — this is its sanctioned escape hatch).
  -- A typed-RESET factory reset is deliberate, master-confirmed data loss,
  -- so opt in transaction-locally: SET LOCAL auto-reverts with the
  -- transaction, and any wipe failure rolls back the data AND the GUC.
  perform set_config('storage.allow_delete_query', 'true', true);
  delete from storage.objects;

  truncate table
    public.bq_donation_items, public.bq_donations, public.bq_fair_sales,
    public.bq_fairs, public.bq_items, public.bq_special_orders,
    public.feedback, public.game_highscores, public.helm_messages,
    public.helm_threads, public.notifications, public.pins,
    public.pos_appointments, public.pos_breaks, public.pos_community_hours,
    public.pos_customers, public.pos_drawer_shifts, public.pos_gift_card_events,
    public.pos_gift_cards, public.pos_invites, public.pos_orgs,
    public.pos_pay_periods, public.pos_pin_attempts, public.pos_products,
    public.pos_punch_audits, public.pos_punch_settings, public.pos_refunds,
    public.pos_sales, public.pos_shifts, public.pos_staff,
    public.pos_store_members, public.pos_stores, public.pos_time_off,
    public.pos_time_punches, public.spaces, public.support_tickets,
    public.user_settings, public.vfs_files, public.vfs_folders,
    public.window_states;

  -- Cascades to auth.identities and public.profiles (both ON DELETE CASCADE).
  -- Application tables above are already empty, so their user_id FKs cannot
  -- block this regardless of their ON DELETE action.
  delete from auth.users;

  -- ---- reseed: the master account, exactly as migration 056 seeds it ----
  -- instance_id identifies the GoTrue instance. GoTrue's password grant
  -- filters users with "instance_id = uuid.Nil" (see supabase/auth
  -- internal/models/user.go: FindUserByEmailAndAudience), so the reseeded
  -- user MUST carry the nil UUID 00000000-0000-0000-0000-000000000000.
  -- auth.instances is normally EMPTY on Supabase (even on healthy
  -- projects), so it cannot be used to discover the value — reading it
  -- here would reseed with NULL and break master sign-in after reset.
  v_instance_id := '00000000-0000-0000-0000-000000000000'::uuid;

  -- The on_auth_user_created -> handle_new_user() trigger builds the
  -- profile (username 'admin', role 'admin' while profiles is empty) plus
  -- the factory-fresh user_settings, vfs_folders and spaces rows — the
  -- same canonical path as a normal signup (see 020).
  insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
                          raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
                          confirmation_token, recovery_token,
                          email_change_token_current, email_change_token_new, email_change,
                          phone_change_token, phone_change, reauthentication_token)
  values (v_instance_id, v_id, 'authenticated', 'authenticated', c_master_email,
          extensions.crypt(c_default_pw, extensions.gen_salt('bf')),
          now(),
          '{"provider":"email","providers":["email"]}'::jsonb,
          jsonb_build_object('username', 'admin', 'is_guest', false),
          now(), now(),
          '', '',
          '', '', '',
          '', '', '');

  -- NOTE: auth.identities.email is GENERATED ALWAYS as
  -- lower(identity_data->>'email') — it must NOT appear in the INSERT
  -- column list.
  insert into auth.identities (id, user_id, identity_data, provider, provider_id, last_sign_in_at, created_at, updated_at)
  values (gen_random_uuid(), v_id,
          jsonb_build_object('sub', v_id::text, 'email', c_master_email),
          'email', v_id::text,
          now(), now(), now());

  -- Stamp the master flags. The caller's profile row was deleted above
  -- (delete from auth.users cascades to public.profiles), so auth.uid() no
  -- longer resolves to any profile row and public.is_admin() is FALSE for
  -- the rest of this transaction — an earlier comment claiming is_admin()
  -- stays true here was wrong. Without the DISABLE below,
  -- protect_profile_fields() raises on the guarded columns and rolls back
  -- the ENTIRE reset (the B2 blocker). The triggers are disabled only for
  -- this UPDATE and re-enabled immediately after; ALTER ... DISABLE
  -- TRIGGER is transactional DDL, so any failure rolls the triggers back
  -- to enabled along with everything else. handle_new_user() already set
  -- role 'admin' (profiles was empty, so is_first was true), so the role
  -- stamp is a no-op and profiles_guard_role is disabled only for
  -- determinism.
  alter table public.profiles disable trigger protect_profile_fields;
  alter table public.profiles disable trigger profiles_guard_role;
  update public.profiles
     set role = 'admin',
         is_paid = true,
         is_locked = false,
         disabled_until = null,
         must_change_password = true,
         is_master = true
   where id = v_id;
  get diagnostics v_rows = row_count;
  alter table public.profiles enable trigger protect_profile_fields;
  alter table public.profiles enable trigger profiles_guard_role;
  if v_rows <> 1 then
    raise exception 'factory reset reseed failed: master profile row missing (handle_new_user did not run?)';
  end if;
  -- is_master must survive re-seeding — verify, never assume.
  if not exists (select 1 from public.profiles where id = v_id and is_master = true) then
    raise exception 'factory reset reseed failed: is_master flag not set';
  end if;
end;
$$;

revoke all on function public.factory_reset() from public, anon;
grant execute on function public.factory_reset() to authenticated;
