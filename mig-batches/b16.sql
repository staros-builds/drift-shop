-- BATCH b16

-- ===== FILE: supabase/migrations/055_*.sql ======
-- 055_void_refunded_sale_guard.sql
--
-- Server-side guard: a sale with ANY refunds can never be voided.
--
-- The refund rows are the audit trail for real money handed back to the
-- customer. Voiding a refunded sale silently erased those rows from
-- Reports/History (found by adversarial testing: sale voided after a full
-- refund left zero trace of the cash that went back out, and restocked
-- inventory for a sale whose money was already returned).
--
-- Invariant enforced: a sale is either voided (never happened) or refunded
-- (happened, money returned) — never both. (Refunding a voided sale was
-- already blocked by the refund hardening in 040/034.)
--
-- Two layers:
--   1. pos_void_sale RPC raises 'sale has refunds and cannot be voided'
--      right after the row lock, before touching anything.
--   2. A BEFORE UPDATE trigger on pos_sales.voided rejects the
--      false -> true transition whenever pos_refunds rows exist for the
--      sale. This covers the pos_void_sale RPC (which UPDATEs pos_sales),
--      the legacy direct-update client path, and any hand-rolled SQL —
--      the rule lives in the database, not the UI.
--
-- NOTE: deliberately NOT rewriting pos_void_sale here — migration 028
-- replaced that RPC with gift-card-aware logic, and a CREATE OR REPLACE
-- from the older 024 body would clobber it. The trigger fires inside the
-- RPC's UPDATE, so the RPC is covered without touching its body.

-- The trigger backstop.
create or replace function public.pos_sales_block_void_with_refunds()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(new.voided, false) = true and coalesce(old.voided, false) = false then
    if exists (select 1 from public.pos_refunds r where r.sale_id = new.id) then
      raise exception 'sale has refunds and cannot be voided';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_pos_sales_no_void_with_refunds on public.pos_sales;
create trigger trg_pos_sales_no_void_with_refunds
  before update of voided on public.pos_sales
  for each row
  execute function public.pos_sales_block_void_with_refunds();

-- ===== FILE: supabase/migrations/056_*.sql ======
-- 056_master_admin.sql
--
-- Master admin account for the shippable product.
--
-- What it does: creates a built-in first owner account — username "admin",
-- email admin@drift-shop.app, default password "admin123" (bcrypt-hashed via
-- pgcrypto) — so a buyer can sign in the moment their Supabase project is
-- wired up, with no dashboard user-creation needed. The account is role
-- 'admin', paid, unlocked, and carries must_change_password = true, so the
-- app forces a password change on first sign-in (the default password is
-- temporary and MUST be changed immediately).
--
-- REBRANDING NOTE: the master email MUST match the accounts domain in
-- src/lib/brand.js (BRAND.accountsDomain). Bare usernames are mapped to
-- <username>@<accountsDomain> at login (src/lib/loginId.js), so username
-- "admin" only reaches this account when the domain matches. If you change
-- BRAND.accountsDomain, update c_master_email below BEFORE running this
-- migration (or update the account's email afterwards).
--
-- Idempotent: guarded by "if not exists" on the email, so re-running is a
-- no-op. Reviewed carefully — it has NOT been applied to any live project
-- (no Supabase project exists for this build yet); the buyer runs
-- supabase/migrations/ 001-056 in order in the SQL editor during setup.
--
-- must_change_password is deliberately NOT added to the
-- protect_profile_fields() trigger's guarded column list (migration 006):
-- the account owner must be able to clear their OWN flag after choosing a
-- new password, and the column only gates a client-side first-login prompt,
-- never a server-side privilege.
--
-- is_master IS a privilege: it is added to protect_profile_fields()'s
-- guarded columns in migration 057, so only an administrator can change it
-- (and the factory_reset() RPC additionally requires it). It is set true
-- ONLY for this seeded master account (both seed paths below key on the
-- master email) and the factory-reset reseed in 057 sets it true again —
-- it must survive re-seeding, never be granted anywhere else.

create extension if not exists pgcrypto with schema extensions;

-- Profile flags consumed by the app shell after sign-in.
alter table public.profiles
  add column if not exists must_change_password boolean not null default false,
  add column if not exists is_master boolean not null default false;

do $$
declare
  c_master_email constant text := 'admin@drift-shop.app';
  c_default_pw   constant text := 'admin123';
  v_id           uuid := gen_random_uuid();
  v_instance_id  uuid;
begin
  if exists (select 1 from auth.users where lower(email) = lower(c_master_email)) then
    -- Already seeded (or the buyer created their own account on this
    -- email): still make sure it is a paid, unlocked admin that must
    -- change its password, then stop. is_master is set here too: only the
    -- master email ever reaches this path, so only the master account can
    -- hold the factory-reset privilege.
    -- NOTE: the protect_profile_fields() trigger rejects status-field
    -- changes from non-admin sessions (the dashboard SQL editor has no
    -- admin JWT), so it is bypassed for this seed UPDATE only and
    -- re-enabled before the early return.
    alter table public.profiles disable trigger protect_profile_fields;
    update public.profiles
       set role = 'admin',
           is_paid = true,
           is_locked = false,
           disabled_until = null,
           must_change_password = true,
           is_master = true
     where id in (select id from auth.users where lower(email) = lower(c_master_email));
    alter table public.profiles enable trigger protect_profile_fields;
    return;
  end if;

  -- instance_id identifies the GoTrue instance; copy it from any existing
  -- user (verified nullable on the live auth.users table 2026-09-29, but
  -- setting it matches what GoTrue writes for normal signups). On a fresh
  -- project with no users yet, fall back to auth.instances.
  select u.instance_id into v_instance_id from auth.users u limit 1;
  if v_instance_id is null then
    select i.id into v_instance_id from auth.instances i limit 1;
  end if;

  -- Shape mirrors a normal email signup (see migration 020
  -- admin_create_user): auth.users row first — the handle_new_user()
  -- trigger builds the profile row (username 'admin', role 'admin' when
  -- profiles is empty or when the email matches the master special-case).
  insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
                          raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  values (v_instance_id, v_id, 'authenticated', 'authenticated', c_master_email,
          extensions.crypt(c_default_pw, extensions.gen_salt('bf')),
          now(),
          '{"provider":"email","providers":["email"]}'::jsonb,
          jsonb_build_object('username', 'admin', 'is_guest', false),
          now(), now());

  -- GoTrue resolves password sign-in through auth.identities; without this
  -- row the new account can never sign in. Shape mirrors a normal email
  -- signup. NOTE: auth.identities.email is GENERATED ALWAYS as
  -- lower(identity_data->>'email') — it must NOT appear in the INSERT
  -- column list, or the insert fails with "cannot insert a non-DEFAULT
  -- value into column email".
  insert into auth.identities (id, user_id, identity_data, provider, provider_id, last_sign_in_at, created_at, updated_at)
  values (gen_random_uuid(), v_id,
          jsonb_build_object('sub', v_id::text, 'email', c_master_email),
          'email', v_id::text,
          now(), now(), now());

  -- Deterministic admin stamping regardless of trigger ordering or
  -- pre-existing profiles. The protect_profile_fields() trigger rejects
  -- status-field changes from non-admin sessions, so it is bypassed for
  -- this seed UPDATE only (re-enabled immediately after).
  -- is_master=true ONLY here: the seeded master account alone holds the
  -- factory-reset privilege.
  alter table public.profiles disable trigger protect_profile_fields;
  update public.profiles
     set role = 'admin',
         is_paid = true,
         is_locked = false,
         disabled_until = null,
         must_change_password = true,
         is_master = true
   where id = v_id;
  alter table public.profiles enable trigger protect_profile_fields;
end $$;

-- ===== FILE: supabase/migrations/057_*.sql ======
-- 057_factory_reset.sql
--
-- Master-only factory reset: one action that wipes the build back to the
-- exact state it ships in — every account, every row of application data,
-- every stored file — then reseeds the master admin account (migration 056
-- shape: admin@drift-shop.app / admin123, role admin, is_master=true,
-- must_change_password=true).
--
-- Gating (defense in depth):
--   1. public.factory_reset() is SECURITY DEFINER and raises unless the
--      CALLER's profile has is_master = true. The RPC is granted to
--      `authenticated` only (revoked from public/anon).
--   2. is_master is added to protect_profile_fields()'s guarded column
--      list below: only an administrator can change it through RLS, and
--      only the seeded master account ever holds it (056 sets it on the
--      master email only; the reseed here sets it again so it survives
--      re-seeding — it is never granted anywhere else).
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
-- The UI confirmation screen states plainly that no automatic backup is
-- taken and points at Settings -> Backup before proceeding.
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
  -- instance_id identifies the GoTrue instance; auth.users is empty now, so
  -- fall back to auth.instances (never wiped).
  select i.id into v_instance_id from auth.instances i limit 1;

  -- The on_auth_user_created -> handle_new_user() trigger builds the
  -- profile (username 'admin', role 'admin' while profiles is empty) plus
  -- the factory-fresh user_settings, vfs_folders and spaces rows — the
  -- same canonical path as a normal signup (see 020).
  insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
                          raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  values (v_instance_id, v_id, 'authenticated', 'authenticated', c_master_email,
          extensions.crypt(c_default_pw, extensions.gen_salt('bf')),
          now(),
          '{"provider":"email","providers":["email"]}'::jsonb,
          jsonb_build_object('username', 'admin', 'is_guest', false),
          now(), now());

  -- NOTE: auth.identities.email is GENERATED ALWAYS as
  -- lower(identity_data->>'email') — it must NOT appear in the INSERT
  -- column list.
  insert into auth.identities (id, user_id, identity_data, provider, provider_id, last_sign_in_at, created_at, updated_at)
  values (gen_random_uuid(), v_id,
          jsonb_build_object('sub', v_id::text, 'email', c_master_email),
          'email', v_id::text,
          now(), now(), now());

  -- Stamp the master flags. protect_profile_fields / guard_role_change
  -- allow this: the caller is is_master AND role admin (the profile row was
  -- just recreated as admin by handle_new_user), so public.is_admin() is
  -- true for the remainder of this transaction.
  update public.profiles
     set role = 'admin',
         is_paid = true,
         is_locked = false,
         disabled_until = null,
         must_change_password = true,
         is_master = true
   where id = v_id;
  get diagnostics v_rows = row_count;
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
