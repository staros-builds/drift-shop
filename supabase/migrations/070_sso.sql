-- ============================================================================
-- 070 — One login: email signup + confirmation
-- ============================================================================
-- Jesse's "one login" requirement (2026-10-01): signup is by EMAIL with a
-- confirmation email; one self-made login opens everything across all
-- mirrors and services, for shop owners AND customers.
--
-- What this migration does:
--   1. No-lockout backfill: when the Supabase project enables "Confirm
--      email", every EXISTING auth user (master admin, legacy username
--      accounts on synthetic emails, anonymous guest users) gets
--      email_confirmed_at backfilled from created_at — nobody's login breaks.
--   2. profiles.account_kind ('owner' | 'customer' | null): classifies new
--      email signups from their signup metadata. Null = legacy/staff/guest,
--      evaluated exactly as before.
--   3. shop_customers + link_shop_customer(p_slug): per-shop customer
--      identity for the storefront (customers worker builds orders on top).
--   4. pos_invites.invited_email + join_pos_store enforcement: email-targeted
--      invites can only be claimed by that address.
--   5. factory_reset(): redefined with shop_customers in the truncate list
--      (42 -> 43 tables) and the reseeded master classified as 'owner'.
--
-- Client companion: src/lib/authFlow.js, backend signUpWithEmail(),
-- LoginScreen email signup + CheckEmail panel, StorefrontPublic customer
-- chip. Runbook: docs/one-login-email-signup.md.
-- ============================================================================

-- ---------- 1. Confirmation backfill (no-lockout) ----------
-- Supabase's "Confirm email" switch only affects FUTURE signups, but this
-- backfill makes the invariant explicit and auditable: no auth.users row
-- may have a NULL email_confirmed_at after this migration runs.
update auth.users
   set email_confirmed_at = coalesce(email_confirmed_at, created_at)
 where email_confirmed_at is null;

-- ---------- 2. Account classification ----------
alter table public.profiles add column if not exists account_kind text;
comment on column public.profiles.account_kind is
  'owner = signed up via email to run a shop (setup access); customer = signed up via a shop storefront (storefront only); null = legacy/staff/guest (evaluated as before)';

-- handle_new_user() (last defined in 012): now also records account_kind
-- from the signup metadata, validated against the two known kinds.
create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer
set search_path = public
as $$
declare
  is_first  boolean;
  uname     text;
  is_g      boolean;
  attempt   int := 0;
  uname_try text;
  kind      text;
begin
  select count(*) = 0 into is_first from public.profiles;
  is_g := coalesce((new.raw_user_meta_data ->> 'is_guest')::boolean, false);
  kind := nullif(new.raw_user_meta_data ->> 'account_kind', '');
  if kind not in ('owner', 'customer') then
    kind := null;
  end if;
  uname := coalesce(
    nullif(new.raw_user_meta_data ->> 'username', ''),
    nullif(split_part(new.email, '@', 1), ''),
    'guest'
  );
  -- Retry with a random suffix when the username is already taken; without
  -- this a collision aborts the entire signup with a 500.
  uname_try := uname;
  loop
    begin
      insert into public.profiles
        (id, username, role, is_guest, trial_started_at, trial_ends_at, account_kind)
      values
        (new.id, uname_try,
         case
           when is_first then 'admin'
           when new.email is not null and lower(new.email) = 'admin@drift-shop.app' then 'admin'
           else 'standard'
         end,
         is_g,
         case when is_g then now() else null end,
         case when is_g then now() + interval '30 minutes' else null end,
         kind);
      exit;
    exception when unique_violation then
      attempt := attempt + 1;
      if attempt > 5 then
        raise;
      end if;
      uname_try := uname || '_' || substr(md5(random()::text), 1, 6);
    end;
  end loop;
  insert into public.user_settings (user_id) values (new.id);
  insert into public.vfs_folders (user_id, parent_id, name)
  values (new.id, null, 'root');
  insert into public.spaces (user_id, name, sort_order)
  values (new.id, 'Main', 0),
         (new.id, 'Focus', 1),
         (new.id, 'Play', 2);
  return new;
end $$;

-- ---------- 3. Per-shop customer identity ----------
-- One row links a confirmed customer account to a shop. The customers
-- worker builds orders on top of this table; the storefront links the row
-- the first time a signed-in customer visits a shop page.
create table if not exists public.shop_customers (
  id           uuid primary key default gen_random_uuid(),
  store_id     uuid not null references public.pos_stores (id) on delete cascade,
  user_id      uuid not null references auth.users (id) on delete cascade,
  display_name text,
  created_at   timestamptz not null default now(),
  unique (store_id, user_id)
);
alter table public.shop_customers enable row level security;
-- Writes go through link_shop_customer() only; a signed-in user may read
-- their own links (lets the storefront chip check link state).
drop policy if exists "shop_customers_own_select" on public.shop_customers;
create policy "shop_customers_own_select"
  on public.shop_customers for select
  using (user_id = auth.uid());

-- Link the caller to a shop's customer list. Idempotent: calling it twice
-- returns the same row. Only PUBLISHED storefronts accept links — the same
-- door as the public storefront page itself.
create or replace function public.link_shop_customer(p_slug text)
returns public.shop_customers
language plpgsql security definer
set search_path = public
as $$
declare
  v_store_id uuid;
  v_name     text;
  v_row      public.shop_customers%rowtype;
begin
  if auth.uid() is null then
    raise exception 'sign in to link your account to a shop';
  end if;
  select sp.store_id into v_store_id
    from public.storefront_profiles sp
   where sp.slug = lower(btrim(coalesce(p_slug, '')))
     and sp.published = true;
  if v_store_id is null then
    raise exception 'shop not found or not published';
  end if;
  select coalesce(nullif(display_name, ''), username) into v_name
    from public.profiles
   where id = auth.uid();
  insert into public.shop_customers (store_id, user_id, display_name)
  values (v_store_id, auth.uid(), v_name)
  on conflict (store_id, user_id)
  do update set display_name = coalesce(excluded.display_name, public.shop_customers.display_name)
  returning * into v_row;
  return v_row;
end $$;

revoke all on function public.link_shop_customer(text) from public, anon;
grant execute on function public.link_shop_customer(text) to authenticated;

-- ---------- 4. Email-targeted invites ----------
-- Owner-side invite creation with an invited_email is client/UI work; the
-- column and the claim-side enforcement land here.
alter table public.pos_invites add column if not exists invited_email text;

-- join_pos_store (last defined in 002): an invite addressed to an email can
-- only be claimed by the account holding that address. Untargeted invites
-- behave exactly as before.
create or replace function public.join_pos_store(p_code text)
returns uuid
language plpgsql security definer
set search_path = public
as $$
declare
  inv           record;
  v_caller_mail text;
begin
  if auth.uid() is null then
    raise exception 'sign in to join a store';
  end if;
  select * into inv from public.pos_invites
  where code = upper(trim(p_code))
    and (expires_at is null or expires_at > now())
    and (max_uses is null or uses < max_uses);
  if not found then
    raise exception 'invite code not found or expired';
  end if;
  if inv.invited_email is not null then
    select lower(email) into v_caller_mail
      from auth.users
     where id = auth.uid();
    if v_caller_mail is distinct from lower(inv.invited_email) then
      raise exception 'this invite was sent to a different email address';
    end if;
  end if;
  if exists (
    select 1 from public.pos_store_members
    where store_id = inv.store_id and user_id = auth.uid()
  ) then
    return inv.store_id; -- idempotent
  end if;
  insert into public.pos_store_members (store_id, user_id, role)
  values (inv.store_id, auth.uid(), inv.role);
  update public.pos_invites set uses = uses + 1 where id = inv.id;
  return inv.store_id;
end $$;
-- factory_reset(): NOT defined here. The single final definition
-- (every public table, master reseed incl. account_kind) lives in
-- migration 078. Defining it mid-sequence would strand an
-- incomplete TRUNCATE list that breaks on re-run once the later
-- tables exist (FK-guarded TRUNCATE is all-or-nothing).

revoke all on function public.factory_reset() from public, anon;
grant execute on function public.factory_reset() to authenticated;
