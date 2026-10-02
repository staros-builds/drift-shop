-- 059_admin_create_user_fixes.sql
--
-- Fixes to public.admin_create_user() found during live QA (2026-10-01):
--
-- 1. EMAIL DOMAIN MISMATCH (the login breaker): the function built login
--    emails as <name>@lfdd.app — a build-2 leftover. The drift-shop client
--    maps usernames to <name>@drift-shop.app (src/lib/brand.js
--    accountsDomain, via src/lib/loginId.js). Every account created through
--    Admin -> Comptes therefore existed under an email the login form never
--    looks up, so GoTrue returned "invalid credentials" for all of them.
--    Fixed to '@drift-shop.app', matching 056/057 and the client.
--
-- 2. FRAGILE instance_id: the old code copied instance_id from an arbitrary
--    existing auth.users row (SELECT ... LIMIT 1, no ORDER BY). GoTrue's
--    password grant requires the nil UUID
--    00000000-0000-0000-0000-000000000000 (see 056/057). Hardcode it, exactly
--    like the factory-reset reseed does.
--
-- 3. TOKEN COLUMNS: the old INSERT left confirmation_token / recovery_token /
--    email_change_token_* / phone_change_token / reauthentication_token NULL.
--    Hosted GoTrue returns HTTP 500 on password grants when these are NULL
--    (found while repairing the 056 seed). Seed them as empty strings, the
--    same known-good shape 056/057 use.
--
-- The function signature is unchanged; CREATE OR REPLACE keeps existing
-- grants. Already-created broken accounts (if any remain) still carry the
-- wrong @lfdd.app email and must be recreated — their rows are harmless
-- otherwise.

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
  -- instance_id identifies the GoTrue instance. GoTrue's password grant
  -- filters users with "instance_id = uuid.Nil", so every created user MUST
  -- carry the nil UUID 00000000-0000-0000-0000-000000000000. (Previously this
  -- copied the value from an arbitrary existing row via SELECT ... LIMIT 1
  -- with no ORDER BY — fragile and wrong if that row ever diverged.)
  v_instance_id uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  v_username text;
  v_email text;
  v_role text := coalesce(p_role, 'standard');
  v_acct text := coalesce(p_account_type, 'full');
  v_shop_role text := coalesce(p_shop_role, 'cashier');
begin
  if not public.is_admin() then
    raise exception 'not authorized';
  end if;
  -- Mirror the client signup sanitizer (src/lib/loginId.js).
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
  -- The login email domain MUST match the client's username->email mapping
  -- (BRAND.accountsDomain = 'drift-shop.app'). A build-2 leftover used
  -- '@lfdd.app' here, which made every created account unfindable at login.
  v_email := v_username || '@drift-shop.app';
  insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
                          raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
                          confirmation_token, recovery_token,
                          email_change_token_current, email_change_token_new, email_change,
                          phone_change_token, phone_change, reauthentication_token)
  values (v_instance_id, v_id, 'authenticated', 'authenticated', v_email,
          extensions.crypt(p_password, extensions.gen_salt('bf')),
          now(),
          '{"provider":"email","providers":["email"]}'::jsonb,
          jsonb_build_object('username', v_username, 'is_guest', false),
          now(), now(),
          '', '',
          '', '', '',
          '', '', '');
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
