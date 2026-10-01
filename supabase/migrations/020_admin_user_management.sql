-- 020_admin_user_management.sql
--
-- Admin-managed accounts: the shop owner can add and remove login accounts
-- from Admin -> Accounts without touching the dashboard.
--
-- admin_create_user(p_username, p_password, p_role default 'standard',
--                   p_account_type default 'full', p_store_id default null) -> uuid
--   SECURITY DEFINER, global-admin only. Creates an auth user with a
--   bcrypt-hashed password; the existing handle_new_user() trigger builds
--   the profile (role 'standard'), promoted to 'admin' when requested.
--   Usernames map to <name>@lfdd.app exactly like client signup.
--   New accounts are marked paid (they are the owner's own staff/devices,
--   not SaaS customers) and record who created them. Staff/device accounts
--   join the chosen shop as cashier, so the existing team RLS is the
--   server-side boundary for everything they can do.
--   NOTE: the auth.identities row is required or password sign-in fails —
--   its shape mirrors what GoTrue writes for email signups.
--
-- admin_delete_user(target_user_id)
--   SECURITY DEFINER, global-admin only. Refuses self-deletion and deleting
--   the last admin account. Cleans up shop memberships, support-ticket
--   authorship (detached, history kept), per-user app data, the profile,
--   then the auth user. Any unexpected FK reference aborts the whole
--   transaction with a clear error -- never a partial delete.

create extension if not exists pgcrypto with schema extensions;

-- Profile columns for the account hierarchy. (These live here rather than
-- in 022_device_accounts.sql because admin_create_user below writes them;
-- 022 remains as an idempotent guard.)
alter table public.profiles
  add column if not exists account_type text not null default 'full'
    check (account_type in ('full', 'staff', 'pos', 'punch')),
  add column if not exists created_by uuid references public.profiles(id) on delete set null,
  add column if not exists device_store_id uuid references public.pos_stores(id) on delete set null;

-- ---------- device capability helpers ----------
-- A device session token is a full cashier session on shared hardware, so
-- the server — not the kiosk UI — is the boundary for what each account
-- type may do. These helpers let the RPCs below refuse out-of-role calls.
-- SECURITY: defaults to NULL (not 'full') when the profile row is missing.
-- A missing profile means something is wrong (trigger failed, race during
-- signup) — fail closed, never grant full access by default.
create or replace function public.caller_account_type()
returns text
language sql security definer stable
set search_path = public
as $$
  select p.account_type from public.profiles p where p.id = auth.uid()
$$;

-- Raise unless the caller's account type is one of the allowed types.
-- Usage inside an RPC: perform public.require_account_type('full', 'staff');
create or replace function public.require_account_type(variadic p_allowed text[])
returns void
language plpgsql security definer
set search_path = public
as $$
begin
  if not public.caller_account_type() = any (p_allowed) then
    raise exception 'account type % cannot perform this action', public.caller_account_type();
  end if;
end;
$$;


-- ---------- create a login account ----------
create or replace function public.admin_create_user(p_username text, p_password text, p_role text default 'standard',
                                                    p_account_type text default 'full', p_store_id uuid default null,
                                                    p_shop_role text default 'cashier')
returns uuid
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_id uuid := gen_random_uuid();
  v_instance_id uuid;
  v_username text;
  v_email text;
  v_role text := coalesce(p_role, 'standard');
  v_acct text := coalesce(p_account_type, 'full');
  v_shop_role text := coalesce(p_shop_role, 'cashier');
begin
  if not public.is_admin() then
    raise exception 'not authorized';
  end if;
  -- instance_id identifies the GoTrue instance; copy it from any existing
  -- user (verified nullable on the live auth.users table 2026-09-29, but
  -- setting it matches what GoTrue writes for normal signups).
  select u.instance_id into v_instance_id from auth.users u limit 1;
  -- Mirror the client signup sanitizer (AuthContext toCloudEmail).
  v_username := lower(regexp_replace(trim(coalesce(p_username, '')), '[^a-z0-9._-]', '', 'g'));
  if v_username is null or char_length(v_username) < 3 or char_length(v_username) > 64 then
    raise exception 'username must be 3-64 characters (letters, numbers, dot, underscore, dash)';
  end if;
  if p_password is null or char_length(p_password) < 8 or char_length(p_password) > 200 then
    raise exception 'password must be between 8 and 200 characters';
  end if;
  if v_role not in ('standard', 'admin') then
    raise exception 'role must be standard or admin';
  end if;
  -- Only full desktop accounts may be admins: staff and device accounts are
  -- operated by employees or left unattended, so the admin role is refused
  -- for them even if someone calls this RPC directly.
  if v_role = 'admin' and v_acct <> 'full' then
    raise exception 'only full desktop accounts can be administrators';
  end if;
  if v_acct not in ('full', 'staff', 'pos', 'punch') then
    raise exception 'account type must be full, staff, pos or punch';
  end if;
  if v_shop_role not in ('manager', 'cashier') then
    raise exception 'shop role must be manager or cashier';
  end if;
  -- Device and staff accounts are never admins: they are operated by
  -- employees or left unattended on shop hardware.
  if v_acct in ('pos', 'punch', 'staff') then
    v_role := 'standard';
  end if;
  -- Device accounts are always cashier in the shop: a punch pad or register
  -- must never manage the team, no matter what the caller passes.
  if v_acct in ('pos', 'punch') then
    v_shop_role := 'cashier';
  end if;
  if p_store_id is not null and not exists (select 1 from public.pos_stores where id = p_store_id) then
    raise exception 'shop not found';
  end if;
  if exists (select 1 from public.profiles where username = v_username) then
    raise exception 'username is already taken';
  end if;
  v_email := v_username || '@lfdd.app';
  insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
                          raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  values (v_instance_id, v_id, 'authenticated', 'authenticated', v_email,
          extensions.crypt(p_password, extensions.gen_salt('bf')),
          now(),
          '{"provider":"email","providers":["email"]}'::jsonb,
          jsonb_build_object('username', v_username, 'is_guest', false),
          now(), now());
  -- GoTrue resolves password sign-in through auth.identities; without this
  -- row the new account can never sign in. Shape mirrors a normal email
  -- signup. NOTE: auth.identities.email is GENERATED ALWAYS as
  -- lower(identity_data->>'email') — it must NOT appear in the INSERT
  -- column list, or the insert fails with "cannot insert a non-DEFAULT
  -- value into column email".
  insert into auth.identities (id, user_id, identity_data, provider, provider_id, last_sign_in_at, created_at, updated_at)
  values (gen_random_uuid(), v_id,
          jsonb_build_object('sub', v_id::text, 'email', v_email),
          'email', v_id::text,
          now(), now(), now());
  -- handle_new_user() created the profile as 'standard'; stamp the admin
  -- fields in one update (protect_profile_fields allows it: we are admin).
  update public.profiles
     set role = v_role,
         is_paid = true,
         account_type = v_acct,
         created_by = auth.uid(),
         device_store_id = p_store_id
   where id = v_id;
  -- Staff and device accounts join the shop as cashier: team RLS is the
  -- server-side boundary for everything they may read or write.
  if p_store_id is not null and v_acct in ('staff', 'pos', 'punch') then
    insert into public.pos_store_members (store_id, user_id, role)
    values (p_store_id, v_id, v_shop_role)
    on conflict (store_id, user_id) do update set role = excluded.role;
  end if;
  return v_id;
end;
$$;

revoke all on function public.admin_create_user(text, text, text, text, uuid, text) from public, anon;
grant execute on function public.admin_create_user(text, text, text, text, uuid, text) to authenticated;

-- ---------- remove a login account ----------
create or replace function public.admin_delete_user(target_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if not public.is_admin() then
    raise exception 'not authorized';
  end if;
  if target_user_id is null then
    raise exception 'user id required';
  end if;
  if target_user_id = auth.uid() then
    raise exception 'you cannot delete your own account';
  end if;
  if not exists (select 1 from auth.users where id = target_user_id) then
    raise exception 'user not found';
  end if;
  if exists (select 1 from public.profiles where id = target_user_id and role = 'admin')
     and (select count(*) from public.profiles where role = 'admin') <= 1 then
    raise exception 'cannot delete the last admin account';
  end if;
  -- Shop relations (pos_store_members also cascades; explicit is harmless).
  delete from public.pos_store_members where user_id = target_user_id;
  -- Support tickets keep their history; detach the author instead.
  update public.support_tickets set user_id = null where user_id = target_user_id;
  -- Bouquinerie catalogue rows are durable shop data: their owner_id FK
  -- cascades on auth.users delete, so reassign them to the admin doing the
  -- deletion instead of silently wiping the shop's books, donations, fairs
  -- and special orders. (Junction rows follow their parents.)
  update public.bq_items          set owner_id = auth.uid() where owner_id = target_user_id;
  update public.bq_donations      set owner_id = auth.uid() where owner_id = target_user_id;
  update public.bq_fairs          set owner_id = auth.uid() where owner_id = target_user_id;
  update public.bq_special_orders set owner_id = auth.uid() where owner_id = target_user_id;
  -- Per-user app data seeded by handle_new_user().
  delete from public.user_settings where user_id = target_user_id;
  delete from public.vfs_folders where user_id = target_user_id;
  delete from public.spaces where user_id = target_user_id;
  -- Identity last: profile, then the auth user.
  delete from public.profiles where id = target_user_id;
  delete from auth.users where id = target_user_id;
  -- Any other FK reference aborts here and rolls everything back.
end;
$$;

revoke all on function public.admin_delete_user(uuid) from public, anon;
grant execute on function public.admin_delete_user(uuid) to authenticated;

-- ---------- change an account's role ----------
-- Used by Admin -> Users (make admin / make standard). Guards the last
-- admin against demotion; self-role changes are refused (use the dashboard
-- if you really mean it).
create or replace function public.admin_set_role(target_user_id uuid, new_role text)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if not public.is_admin() then
    raise exception 'not authorized';
  end if;
  if target_user_id is null then
    raise exception 'user id required';
  end if;
  if new_role not in ('admin', 'standard') then
    raise exception 'role must be admin or standard';
  end if;
  if target_user_id = auth.uid() then
    raise exception 'you cannot change your own role here';
  end if;
  if not exists (select 1 from public.profiles where id = target_user_id) then
    raise exception 'user not found';
  end if;
  -- Device/staff accounts are limited-capability logins: promoting one to
  -- global admin would hand a shared kiosk or punch terminal full control
  -- of the system. Change the account type first if that is intended.
  if new_role = 'admin'
     and exists (select 1 from public.profiles
                  where id = target_user_id
                    and account_type in ('staff', 'pos', 'punch')) then
    raise exception 'cannot promote a staff or device account to admin: change its account type to full first';
  end if;
  if new_role = 'standard'
     and exists (select 1 from public.profiles where id = target_user_id and role = 'admin')
     and (select count(*) from public.profiles where role = 'admin') <= 1 then
    raise exception 'cannot demote the last admin account';
  end if;
  update public.profiles set role = new_role where id = target_user_id;
end;
$$;

revoke all on function public.admin_set_role(uuid, text) from public, anon;
grant execute on function public.admin_set_role(uuid, text) to authenticated;
