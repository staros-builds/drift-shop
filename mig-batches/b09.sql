-- BATCH b09

-- ===== FILE: supabase/migrations/020_*.sql ======
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

-- ===== FILE: supabase/migrations/021_*.sql ======
-- 021_pos_sale_tax_lines.sql
-- Persist the exact tax breakdown charged at sale time. Receipts and reprints
-- must show historical truth (the lines actually charged), never a
-- recomputation from whatever the store's tax settings happen to be today.
ALTER TABLE public.pos_sales
  ADD COLUMN IF NOT EXISTS tax_lines jsonb;

-- ===== FILE: supabase/migrations/022_*.sql ======
-- 022_device_accounts.sql
--
-- Sub-account hierarchy for the shop owner.
--
-- NOTE: the profiles.account_type / created_by / device_store_id columns
-- were moved into 020_admin_user_management.sql (admin_create_user writes
-- them, so they must exist before 020's function can run). The ALTER below
-- is kept as an idempotent guard; the trigger extension is the live part.
-- profiles.account_type: what this login account is for.
--   'full'   — a complete desktop, everything the role allows (default;
--               this is what the owner has).
--   'staff'  — shop staff: the regular desktop, flagged as staff, created
--               under the owner and auto-joined to the shop as cashier.
--   'pos'    — a POS-register device: signs straight into a locked,
--               fullscreen point of sale for one shop. No desktop.
--   'punch'  — a punch-pad device (back-room tablet): signs straight into
--               the clock in/out pad for one shop. No desktop.
--
-- profiles.created_by: the admin account that created this account
--   (NULL for the original / self-signed-up accounts).
-- profiles.device_store_id: the shop a device account is bound to
--   (also set for staff when a shop is picked at creation).
--
-- The device accounts are ordinary store members (role 'cashier'), so every
-- data rule they hit is the same team RLS + PIN-verifying RPCs the shop
-- already enforces — the kiosk UI being minimal is a convenience, the
-- server is the actual boundary.

alter table public.profiles
  add column if not exists account_type text not null default 'full'
    check (account_type in ('full', 'staff', 'pos', 'punch')),
  add column if not exists created_by uuid references public.profiles(id) on delete set null,
  add column if not exists device_store_id uuid references public.pos_stores(id) on delete set null;

-- Only an administrator may change these fields; the existing
-- protect_profile_fields() trigger is extended to cover them.
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
  then
    raise exception 'Only an administrator can change account status fields.';
  end if;
  return new;
end $$;

drop trigger if exists protect_profile_fields on public.profiles;
create trigger protect_profile_fields
  before update on public.profiles
  for each row execute function public.protect_profile_fields();

-- ===== FILE: supabase/migrations/023_*.sql ======
-- 023_pin_throttle.sql
--
-- Server-side brute-force protection for staff PINs.
--
-- Staff PINs are short (4-8 digits) and the punch pad / POS kiosk sit
-- unattended in the shop, so guessing must be expensive: after 15 failed
-- PIN attempts for a store inside 10 minutes, every further PIN attempt
-- for that store is rejected for a short cooldown. A successful PIN entry
-- resets the counter, so one forgetful employee can't lock the shop out.
--
-- Only aggregate counters are stored (store + timestamp + outcome) — never
-- the attempted PIN or its hash, so the log itself is useless to an
-- attacker. No RLS policies: only SECURITY DEFINER functions touch it.

create table if not exists public.pos_pin_attempts (
  store_id     uuid not null references public.pos_stores(id) on delete cascade,
  attempted_at timestamptz not null default now(),
  success      boolean not null default false
);
create index if not exists pos_pin_attempts_store_time
  on public.pos_pin_attempts (store_id, attempted_at);
alter table public.pos_pin_attempts enable row level security;

-- Throttled replacement of the 004 pos_staff_login (same signature,
-- same grants). The throttle lives inside the definer so it cannot be
-- bypassed by calling the RPC differently.
--
-- CRITICAL correctness note: a failed attempt MUST be logged with a plain
-- INSERT followed by a normal RETURN (empty set), never "insert then raise".
-- In PostgreSQL, raising an exception aborts the whole statement and rolls
-- the failure row back with it — the throttle would never trigger. The
-- client already treats an empty result as "invalid PIN", so behaviour is
-- unchanged while the log actually persists.
create or replace function public.pos_staff_login(p_store_id uuid, p_pin_hash text)
returns table (id uuid, name text, role text)
language plpgsql security definer
set search_path = public
as $$
declare
  v_failures int;
begin
  if auth.uid() is null then
    raise exception 'sign in to use staff PINs';
  end if;
  if not public.is_pos_member(p_store_id) then
    raise exception 'not a member of this store';
  end if;
  -- Housekeeping: drop yesterday's rows so the table stays tiny.
  -- (On the throttled path below this delete rolls back with the raise —
  -- harmless, it just runs on the next non-throttled call.)
  delete from public.pos_pin_attempts
   where attempted_at < now() - interval '1 day';
  -- Throttle: 15 failures in 10 minutes -> cool down. Nothing has been
  -- written yet on this path, so the raise is safe here.
  select count(*) into v_failures
    from public.pos_pin_attempts
   where store_id = p_store_id
     and not success
     and attempted_at > now() - interval '10 minutes';
  if v_failures >= 15 then
    raise exception 'too many PIN attempts — wait a couple of minutes and try again';
  end if;
  -- NOTE: "if not found" must be checked immediately after the RETURN QUERY,
  -- because FOUND is reset by every subsequent SQL statement.
  return query
    select s.id, s.name, s.role
    from public.pos_staff s
    where s.store_id = p_store_id
      and s.active
      and s.pin_hash = p_pin_hash
    limit 1;
  if not found then
    -- Failed attempt: log it and return an empty set. NO RAISE — the client
    -- maps "no rows" to "invalid PIN" and the insert commits, which is what
    -- makes the throttle above actually work.
    insert into public.pos_pin_attempts (store_id, success)
    values (p_store_id, false);
    return;
  end if;
  -- Success resets the failure counter for the store.
  delete from public.pos_pin_attempts
   where store_id = p_store_id and not success;
  insert into public.pos_pin_attempts (store_id, success)
  values (p_store_id, true);
end $$;

revoke all on function public.pos_staff_login(uuid, text) from public;
grant execute on function public.pos_staff_login(uuid, text) to authenticated;

-- ===== FILE: supabase/migrations/024_*.sql ======
-- 024_atomic_void_sale.sql
--
-- One-transaction void: marking the sale voided and restocking inventory
-- must succeed or fail TOGETHER. The old client flow marked the sale voided
-- first and restocked afterwards, so a failed restock (or a crash in
-- between) left a voided sale with wrong inventory. It also never restored
-- Bouquinerie catalogue quantities at all.
--
-- pos_void_sale(p_sale_id, p_reason) — SECURITY DEFINER, owner/manager only:
--   1. Locks the sale row (FOR UPDATE): concurrent voids serialize here,
--      so a double-click or retry can never restock twice.
--   2. Raises 'sale is already voided' if it was voided first — the caller
--      must surface that instead of silently succeeding.
--   3. Marks the sale voided (voided, voided_at, voided_by, void_reason).
--   4. Restocks pos_products lines (track_stock only) and bq_items lines
--      (qty plus pre-sale status, recorded on the sale line as bqStatus).
--   5. Returns { voided: true, warnings: [...] }. A line that cannot be
--      restocked (product deleted since the sale, corrupt line data) is
--      reported as a warning — the void itself still commits, because the
--      sale genuinely happened and the books must say so. Staff reconcile
--      the warning instead of inventory silently drifting.

-- Safe helpers (defined here because 024 is the first migration that uses
-- _safe_int; 026 and 028 also use these. CREATE OR REPLACE is idempotent.)
create or replace function public._safe_timestamptz(p_text text)
returns timestamptz
language plpgsql immutable
set search_path = public
as $$
begin
  if p_text is null or btrim(p_text) = '' then
    return null;
  end if;
  return p_text::timestamptz;
exception when others then
  return null;
end;
$$;

create or replace function public._safe_int(p_text text, p_default int)
returns int
language plpgsql immutable
set search_path = public
as $$
begin
  if p_text is null or btrim(p_text) = '' then
    return p_default;
  end if;
  return btrim(p_text)::int;
exception when others then
  return p_default;
end;
$$;

revoke all on function public._safe_timestamptz(text) from public, anon;
grant execute on function public._safe_timestamptz(text) to authenticated;
revoke all on function public._safe_int(text, int) from public, anon;
grant execute on function public._safe_int(text, int) to authenticated;

create or replace function public.pos_void_sale(p_sale_id uuid, p_reason text default '')
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_store    uuid;
  v_items    jsonb;
  v_role     text;
  v_warnings jsonb := '[]'::jsonb;
  it         jsonb;
  v_qty      int;
  v_pid      uuid;
  v_bqid     uuid;
  v_bqstatus text;
  v_name     text;
begin
  if auth.uid() is null then
    raise exception 'sign in to void sales';
  end if;

  -- Device accounts can never void, even if a membership row were
  -- misconfigured with a manager role: the account type is the hard
  -- boundary, membership is only the second check.
  perform public.require_account_type('full', 'staff');

  -- Lock the sale row: concurrent voids serialize here.
  select s.store_id, coalesce(s.items, '[]'::jsonb)
    into v_store, v_items
    from public.pos_sales s
   where s.id = p_sale_id
   for update;
  if not found then
    raise exception 'sale not found';
  end if;

  select m.role into v_role
    from public.pos_store_members m
   where m.store_id = v_store and m.user_id = auth.uid();
  if v_role is null then
    raise exception 'not a member of this store';
  end if;
  if v_role not in ('owner', 'manager') then
    raise exception 'only managers can void sales';
  end if;

  if (select s.voided from public.pos_sales s where s.id = p_sale_id) then
    raise exception 'sale is already voided';
  end if;

  update public.pos_sales
     set voided      = true,
         voided_at   = now(),
         voided_by   = auth.uid(),
         void_reason = nullif(btrim(coalesce(p_reason, '')), '')
   where id = p_sale_id;

  -- Restock each line. A per-line exception handler isolates corrupt lines
  -- (bad UUID text, deleted product) as warnings; the transaction — void
  -- mark plus every healthy restock — stays atomic.
  for it in select * from jsonb_array_elements(v_items) loop
  begin
    v_qty  := greatest(0, public._safe_int(it->>'qty', 0));
    v_name := coalesce(it->>'name', 'item');
    if v_qty = 0 then
      continue;
    end if;

    -- POS catalogue product (uuid text guarded: garbage becomes a warning,
    -- never an abort).
    if it->>'productId' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
      v_pid := (it->>'productId')::uuid;
      update public.pos_products
         set stock = stock + v_qty, updated_at = now()
       where id = v_pid and store_id = v_store and track_stock;
      if not found then
        -- Product deleted or stock-tracking off: nothing to restock.
        -- (Stock-tracking-off products never decremented, so warn only when
        -- the product itself is gone.)
        if not exists (select 1 from public.pos_products where id = v_pid and store_id = v_store) then
          v_warnings := v_warnings || jsonb_build_object('line', v_name, 'issue', 'product no longer exists — quantity not restored');
        end if;
      end if;
    end if;

    -- Bouquinerie catalogue item.
    if it->>'bqItemId' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
      v_bqid := (it->>'bqItemId')::uuid;
      v_bqstatus := it->>'bqStatus';
      if v_bqstatus not in ('store', 'fair', 'sorting') then
        v_bqstatus := null; -- old sales did not record it; restore qty only
      end if;
      update public.bq_items
         set qty        = qty + v_qty,
             status     = case
                            when status = 'sold' and v_bqstatus is not null then v_bqstatus
                            else status
                          end,
             updated_at = now()
       where id = v_bqid and store_id = v_store;
      if not found then
        v_warnings := v_warnings || jsonb_build_object('line', v_name, 'issue', 'catalogue item no longer exists — quantity not restored');
      elsif v_bqstatus is null then
        v_warnings := v_warnings || jsonb_build_object('line', v_name, 'issue', 'quantity restored but shelf status unknown — verify where the item belongs');
      end if;
    end if;
  exception
    when others then
      v_warnings := v_warnings || jsonb_build_object('line', coalesce(v_name, 'item'), 'issue', 'could not restock — ' || sqlerrm);
  end;
  end loop;

  return jsonb_build_object('voided', true, 'warnings', v_warnings);
end;
$$;

revoke all on function public.pos_void_sale(uuid, text) from public, anon;
grant execute on function public.pos_void_sale(uuid, text) to authenticated;
