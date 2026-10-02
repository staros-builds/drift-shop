-- 078_factory_reset_final.sql
--
-- THE single final factory_reset() definition for the merged build.
-- Migrations 070/071/074 deliberately do NOT define it: an incomplete
-- mid-sequence TRUNCATE list would break the whole reset on re-run
-- once later tables exist (TRUNCATE refuses while a referencing table
-- is missing from the command). This definition covers ALL 51 public
-- tables: the 42 of migration 063, plus shop_customers (070),
-- online_customers/online_orders/online_order_items (071), license_keys/
-- shop_licenses/license_redeem_attempts (072), custom_domains (074) and
-- pos_stock_applications (075). Body carried from 063/070: master gate,
-- storage cleanup, auth wipe, and the 056 master reseed (now classified
-- account_kind 'owner'). Idempotent (CREATE OR REPLACE): safe to
-- re-run. factory_reset() is only guaranteed from this migration on.
--

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
  -- WHERE true: Supabase preloads the safeupdate extension for the API
  -- roles, which rejects unqualified DELETEs ("DELETE requires a WHERE
  -- clause") even inside SECURITY DEFINER functions. This is "every row",
  -- stated explicitly.
  delete from storage.objects where true;

  -- TRUNCATE list covers ALL 51 public tables (verified against pg_tables).
  -- profiles: must be listed because its device_store_id FK references
  -- pos_stores — Postgres blocks truncating a table referenced by ANY foreign
  -- key unless the referencing table is truncated in the same command, even
  -- when the referencing table is empty. profiles is re-seeded below by the
  -- auth.users insert via the handle_new_user trigger. The only FK
  -- referencing profiles is its own self-reference
  -- (profiles_created_by_fkey), which TRUNCATE tolerates in a single command.
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
    public.pos_time_punches, public.profiles, public.shop_customers,
    public.online_customers, public.online_orders, public.online_order_items,
    public.license_keys, public.shop_licenses, public.license_redeem_attempts,
    public.custom_domains, public.pos_stock_applications,
    public.spaces,
    public.storefront_profiles, public.support_tickets,
    public.user_settings, public.vfs_files, public.vfs_folders,
    public.window_states;

  -- Cascades to auth.identities and public.profiles (both ON DELETE CASCADE).
  -- Application tables above are already empty, so their user_id FKs cannot
  -- block this regardless of their ON DELETE action.
  -- WHERE true: see the safeupdate note above — unqualified DELETEs are
  -- rejected for the API roles even inside SECURITY DEFINER functions.
  delete from auth.users where true;

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
          jsonb_build_object('username', 'admin', 'is_guest', false, 'account_kind', 'owner'),
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
