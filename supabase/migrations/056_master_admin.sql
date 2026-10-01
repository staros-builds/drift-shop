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
-- Idempotent: the master email is checked first. Re-running after a
-- successful seed is a NO-OP — the exists-branch only stamps the flags
-- when the account is not already the master (is_master = false), so a
-- re-run never re-arms must_change_password after the owner already
-- changed the default password, and never downgrades anything else.
-- (First-seed path always sets must_change_password = true.)
-- Reviewed carefully — it has NOT been applied to any live project
-- (no Supabase project exists for this build yet); the buyer runs
-- supabase/migrations/ 001-058 in order in the SQL editor during setup.
--
-- TRIGGER BYPASS: the privileged UPDATEs below change guarded columns
-- (is_paid, is_master, and defensively role). During migrations
-- auth.uid() is NULL, so public.is_admin() is false and the BEFORE UPDATE
-- trigger protect_profile_fields on public.profiles would raise
-- 'Only an administrator can change account status fields.' — rolling the
-- whole DO block back. The UPDATEs therefore run with the
-- protect_profile_fields and profiles_guard_role triggers DISABLEd and
-- are re-ENABLEd immediately after. ALTER ... DISABLE TRIGGER is
-- transactional DDL, so any failure rolls the triggers back to enabled
-- along with everything else. Migrations run as the table owner, which is
-- required for DISABLE TRIGGER. handle_new_user() already builds the
-- profile row with role 'admin' (profiles empty, and the master email is
-- special-cased), so the role stamp is normally a no-op — the guard_role
-- disable is belt-and-braces for determinism.
--
-- must_change_password is deliberately NOT added to the
-- protect_profile_fields() trigger's guarded column list (migration 006):
-- the account owner must be able to clear their OWN flag after choosing a
-- new password, and the column only gates a client-side first-login prompt,
-- never a server-side privilege.
--
-- is_master IS a privilege: it is added to protect_profile_fields()'s
-- guarded columns in migration 057, and migration 058 tightens that guard
-- so ONLY a master (not merely an admin) can change it; the
-- factory_reset() RPC additionally requires it. It is set true ONLY for
-- this seeded master account (both seed paths below key on the master
-- email, and only when the account is not already the master) and the
-- factory-reset reseed in 057 sets it true again — it must survive
-- re-seeding, never be granted anywhere else.

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
  v_rows         int;
begin
  if exists (select 1 from auth.users where lower(email) = lower(c_master_email)) then
    -- Already seeded (or the buyer created their own account on this
    -- email): stamp it as a paid, unlocked admin that must change its
    -- password — but ONLY if it is not already the master, so re-running
    -- after a successful seed is a strict no-op (never re-arms
    -- must_change_password after the owner changed the password).
    -- is_master is set here too: only the master email ever reaches this
    -- path, so only the master account can hold the factory-reset
    -- privilege. Guarded columns require the trigger bypass (see header).
    alter table public.profiles disable trigger protect_profile_fields;
    alter table public.profiles disable trigger profiles_guard_role;
    update public.profiles
       set role = 'admin',
           is_paid = true,
           is_locked = false,
           disabled_until = null,
           must_change_password = true,
           is_master = true
     where id in (select id from auth.users where lower(email) = lower(c_master_email))
       and is_master = false;
    get diagnostics v_rows = row_count;
    alter table public.profiles enable trigger protect_profile_fields;
    alter table public.profiles enable trigger profiles_guard_role;
    if v_rows = 0 then
      raise notice '056: master account already seeded — no-op.';
    else
      raise notice '056: existing account on the master email elevated to master.';
    end if;
    return;
  end if;

  -- instance_id identifies the GoTrue instance; copy it from any existing
  -- user (verified nullable on the live auth.users table 2026-09-29, but
  -- setting it matches what GoTrue writes for normal signups). On a fresh
  -- project with no users yet, fall back to auth.instances. A NULL
  -- instance_id breaks GoTrue sign-in entirely ("invalid credentials" with
  -- a perfectly good password hash), so refuse to seed rather than insert
  -- a broken user.
  select u.instance_id into v_instance_id from auth.users u limit 1;
  if v_instance_id is null then
    select i.id into v_instance_id from auth.instances i limit 1;
  end if;
  if v_instance_id is null then
    raise exception '056: could not determine auth instance_id — cannot seed master user';
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
  -- pre-existing profiles. Guarded columns require the trigger bypass
  -- (see header): without it protect_profile_fields() raises because
  -- auth.uid() is NULL during migrations, rolling back the whole seed.
  -- is_master=true ONLY here: the seeded master account alone holds the
  -- factory-reset privilege.
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
  alter table public.profiles enable trigger protect_profile_fields;
  alter table public.profiles enable trigger profiles_guard_role;
  raise notice '056: master account seeded (admin@drift-shop.app).';
end $$;
