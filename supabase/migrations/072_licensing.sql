-- 072_licensing.sql — Shop licensing: 30-day trial, soft lock,
-- support-tab purchase path, serial-key unlock.
--
-- OWNER MODEL (Jesse's licensing spec, 2026-10-01):
--   1. A shop gets 30 days of full use from the moment it exists.
--   2. After that the app LOCKS. Nothing is ever deleted; the shop's data
--      sits untouched behind the lock screen.
--   3. A locked shop can reach the platform owner through the Support tab
--      to arrange a purchase (support_tickets.scope = 'platform').
--   4. The platform owner (the is_master account) generates one-time keys
--      ("serial numbers"); the shop owner types one into their dashboard
--      to unlock — lifetime, or a term of N months.
--
-- WHAT ALREADY EXISTED (audit): per-USER is_paid / is_locked /
-- trial_ends_at (migration 006, a 30-minute guest trial + manual admin
-- paid flag, enforced by src/os/accessPolicy.js), the support-ticket
-- system (008), the is_master platform-master account (056, helper in
-- 063). This migration adds the missing SHOP-level layer on top; the
-- per-user flags are untouched and keep working independently.
--
-- TABLES
--   shop_licenses            one row per shop: trial window, plan, and
--                            the key that unlocked it. Effective status
--                            (trial | active | locked) is COMPUTED from
--                            the clock, never trusted from the client.
--   license_keys             platform-issued keys. Only a SHA-256 hash
--                            of the key is stored — the raw key exists
--                            once, in the generate RPC's return value.
--                            Single-use: redeemed_at binds it forever.
--   license_redeem_attempts  throttle ledger for the redeem RPC.
--
-- RPCs (all security definer, all re-check the caller server-side)
--   license_effective_status(store)  -> 'none' | 'trial' | 'active' | 'locked'
--   my_license_status()              -> caller's shops + effective status
--   redeem_license_key(key, store?)  -> validates, single-use claim,
--                                       owner-only, throttled
--   generate_license_keys(n, plan, months) -> PLATFORM MASTER ONLY;
--                                       returns the raw keys ONCE
--   list_license_keys(limit)         -> PLATFORM MASTER ONLY; hashes and
--                                       raw keys are never returned
--   revoke_license_key(id)           -> PLATFORM MASTER ONLY
--
-- ENFORCEMENT BEYOND THE UI: a BEFORE INSERT trigger on pos_sales
-- refuses to record a sale for a locked shop, so no client (old build,
-- kiosk, direct API) can ring up sales behind the lock. Voids/refunds
-- of existing sales stay allowed — they correct the books, they don't
-- sell anything.
--
-- TRIAL LENGTH: 30 days, stamped by handle_new_pos_store() below as
-- now() + interval '30 days'. This SQL is the authority;
-- src/lib/licensing.js mirrors it as TRIAL_DAYS for UI wording.
--
-- FACTORY-RESET NOTE (for the coordinator): factory_reset() (057/062)
-- truncates an explicit table list. Add public.license_keys and
-- public.license_redeem_attempts to that list when this lands —
-- shop_licenses cascades away with pos_stores, but an unredeemed key
-- must NOT survive a reset (it would outlive the deployment it was
-- issued to), and attempt rows reference no cascading FK.
--
-- Idempotent: safe to re-run (IF NOT EXISTS / CREATE OR REPLACE /
-- DROP ... IF EXISTS throughout).

-- ---------- 1. license_keys ----------
create table if not exists public.license_keys (
  id                uuid primary key default gen_random_uuid(),
  -- SHA-256 (hex) of the normalized key: 16 chars, alphabet
  -- ABCDEFGHJKMNPQRSTUVWXYZ23456789 (no 0/O/1/I/L look-alikes).
  key_hash          text not null unique,
  -- Last 4 characters of the raw key, so the owner can recognize a key
  -- in a list ("ends in AB3D") without the key itself being recoverable.
  key_hint          text not null,
  plan              text not null check (plan in ('lifetime', 'term')),
  term_months       integer check (term_months is null or (term_months between 1 and 120)),
  batch_id          uuid not null default gen_random_uuid(),
  created_by        uuid references auth.users(id) on delete set null,
  created_at        timestamptz not null default now(),
  redeemed_store_id uuid references public.pos_stores(id) on delete set null,
  redeemed_by       uuid references auth.users(id) on delete set null,
  redeemed_at       timestamptz,
  revoked_at        timestamptz,
  check ((plan = 'lifetime' and term_months is null) or (plan = 'term' and term_months is not null))
);
create index if not exists license_keys_created on public.license_keys (created_at desc);
create index if not exists license_keys_batch on public.license_keys (batch_id);
alter table public.license_keys enable row level security;
-- No policies on purpose: every read/write goes through the
-- security-definer RPCs below, which check is_master() / ownership
-- themselves. Direct table access is denied to everyone.

-- ---------- 2. shop_licenses ----------
create table if not exists public.shop_licenses (
  store_id               uuid primary key references public.pos_stores(id) on delete cascade,
  -- Base state. 'locked' is also written directly when the platform
  -- owner revokes a redeemed key.
  status                 text not null default 'trial'
                           check (status in ('trial', 'active', 'locked')),
  trial_started_at       timestamptz not null default now(),
  trial_ends_at          timestamptz not null default (now() + interval '30 days'),
  license_key_id         uuid references public.license_keys(id) on delete set null,
  plan                   text check (plan in ('lifetime', 'term')),
  activated_at           timestamptz,
  -- End of the current paid term; NULL means lifetime (never expires).
  current_period_ends_at timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);
alter table public.shop_licenses enable row level security;

-- Members may READ their own shop's license row (the gate and Settings
-- show status from it). Writes happen only inside the RPCs.
drop policy if exists "shop_licenses_member_select" on public.shop_licenses;
create policy "shop_licenses_member_select"
  on public.shop_licenses for select
  to authenticated
  using (public.is_pos_member(store_id));

drop trigger if exists shop_licenses_touch on public.shop_licenses;
create trigger shop_licenses_touch
  before update on public.shop_licenses
  for each row execute function public.touch_updated_at();

-- ---------- 3. redeem-attempt throttle ledger ----------
create table if not exists public.license_redeem_attempts (
  id           bigint generated always as identity primary key,
  user_id      uuid not null,
  attempted_at timestamptz not null default now(),
  succeeded    boolean not null default false
);
create index if not exists license_attempts_user_time
  on public.license_redeem_attempts (user_id, attempted_at desc);
alter table public.license_redeem_attempts enable row level security;
-- No policies: only the redeem RPC touches this table.

-- ---------- 4. effective status ----------
create or replace function public.license_effective_status(p_store_id uuid)
returns text
language sql security definer stable
set search_path = public
as $$
  select case
    when l.store_id is null then 'none'
    when l.status = 'active'
         and (l.current_period_ends_at is null or l.current_period_ends_at > now())
      then 'active'
    when l.status = 'trial' and l.trial_ends_at > now() then 'trial'
    else 'locked'
  end
  from (select 1) _
  left join public.shop_licenses l on l.store_id = p_store_id
  limit 1;
$$;

-- ---------- 5. my shops + license status ----------
create or replace function public.my_license_status()
returns table (
  store_id               uuid,
  store_name             text,
  my_role                text,
  effective_status       text,
  trial_ends_at          timestamptz,
  current_period_ends_at timestamptz,
  plan                   text
)
language sql security definer stable
set search_path = public
as $$
  select s.id,
         s.name,
         m.role,
         public.license_effective_status(s.id),
         l.trial_ends_at,
         l.current_period_ends_at,
         l.plan
  from public.pos_store_members m
  join public.pos_stores s on s.id = m.store_id
  left join public.shop_licenses l on l.store_id = s.id
  where m.user_id = auth.uid()
  order by s.created_at;
$$;

-- ---------- 6. trial stamp on shop creation + backfill ----------
-- handle_new_pos_store (migration 002) makes the creator the owner;
-- extended here to open the 30-day trial at the same moment.
create or replace function public.handle_new_pos_store()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  insert into public.pos_store_members (store_id, user_id, role)
  values (new.id, new.created_by, 'owner')
  on conflict do nothing;
  insert into public.shop_licenses (store_id, status, trial_started_at, trial_ends_at)
  values (new.id, 'trial', now(), now() + interval '30 days')
  on conflict (store_id) do nothing;
  return new;
end $$;

-- Shops that already exist get a full fresh trial from the day this
-- migration is applied (generous on purpose: nobody loses days because
-- licensing switched on mid-flight).
insert into public.shop_licenses (store_id, status, trial_started_at, trial_ends_at)
select id, 'trial', now(), now() + interval '30 days'
from public.pos_stores
on conflict (store_id) do nothing;

-- ---------- 7. key generation (platform master ONLY) ----------
create or replace function public.generate_license_keys(
  p_count       integer,
  p_plan        text,
  p_term_months integer default null
)
returns table (raw_key text, plan text, term_months integer)
language plpgsql security definer
set search_path = public
as $$
declare
  c_alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  v_batch uuid := gen_random_uuid();
  v_raw   text;
  v_bytes bytea;
  i       integer;
  j       integer;
begin
  if not public.is_master() then
    raise exception 'license-not-master';
  end if;
  if p_count is null or p_count < 1 or p_count > 100 then
    raise exception 'license-bad-count';
  end if;
  if p_plan not in ('lifetime', 'term') then
    raise exception 'license-bad-plan';
  end if;
  if p_plan = 'term' and (p_term_months is null or p_term_months < 1 or p_term_months > 120) then
    raise exception 'license-bad-term';
  end if;

  for i in 1..p_count loop
    -- Retry loop only for the (astronomically unlikely) hash collision.
    for j in 1..5 loop
      v_bytes := extensions.gen_random_bytes(16);
      v_raw := '';
      for k in 0..15 loop
        v_raw := v_raw || substr(c_alphabet, (get_byte(v_bytes, k) % 31) + 1, 1);
      end loop;
      begin
        insert into public.license_keys
          (key_hash, key_hint, plan, term_months, batch_id, created_by)
        values (
          encode(extensions.digest(v_raw, 'sha256'), 'hex'),
          right(v_raw, 4),
          p_plan,
          case when p_plan = 'term' then p_term_months else null end,
          v_batch,
          auth.uid()
        );
        exit; -- inserted
      exception when unique_violation then
        if j = 5 then raise; end if;
      end;
    end loop;
    -- Hand the raw key back ONCE, grouped for humans. It is never
    -- stored and can never be shown again (only its hash remains).
    raw_key := substr(v_raw, 1, 4) || '-' || substr(v_raw, 5, 4) || '-' ||
               substr(v_raw, 9, 4) || '-' || substr(v_raw, 13, 4);
    plan := p_plan;
    term_months := case when p_plan = 'term' then p_term_months else null end;
    return next;
  end loop;
end $$;

-- ---------- 8. redemption ----------
create or replace function public.redeem_license_key(
  p_key      text,
  p_store_id uuid default null
)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_uid     uuid := auth.uid();
  v_clean   text;
  v_key     record;
  v_store   uuid;
  v_fails   integer;
  v_attempt bigint;
begin
  if v_uid is null then
    raise exception 'license-sign-in-required';
  end if;

  -- Throttle: 8 failed tries per rolling hour locks redemption for the
  -- rest of that hour. Successful tries don't count against the user.
  select count(*) into v_fails
  from public.license_redeem_attempts
  where user_id = v_uid
    and not succeeded
    and attempted_at > now() - interval '1 hour';
  if v_fails >= 8 then
    raise exception 'license-too-many-attempts';
  end if;

  insert into public.license_redeem_attempts (user_id, succeeded)
  values (v_uid, false)
  returning id into v_attempt;

  -- Normalize exactly like the client: uppercase, letters/digits only.
  v_clean := upper(regexp_replace(coalesce(p_key, ''), '[^A-Za-z0-9]', '', 'g'));
  if char_length(v_clean) <> 16 then
    return jsonb_build_object('ok', false, 'error', 'license-key-not-found');
  end if;

  select * into v_key
  from public.license_keys
  where key_hash = encode(extensions.digest(v_clean, 'sha256'), 'hex');

  if not found or v_key.revoked_at is not null then
    -- One message for "no such key" and "revoked": don't teach a
    -- guesser which keys exist. (The UI wording covers both honestly:
    -- "that key doesn't work — check it or ask for a new one".)
    return jsonb_build_object('ok', false, 'error', 'license-key-not-found');
  end if;

  -- Which shop does this unlock? An explicit target must be owned by
  -- the caller; otherwise prefer the caller's locked shop (that is why
  -- they are typing a key), falling back to their earliest shop.
  if p_store_id is not null then
    if public.pos_role(p_store_id) is distinct from 'owner' then
      return jsonb_build_object('ok', false, 'error', 'license-not-owner');
    end if;
    v_store := p_store_id;
  else
    select m.store_id into v_store
    from public.pos_store_members m
    where m.user_id = v_uid and m.role = 'owner'
    order by (public.license_effective_status(m.store_id) = 'locked') desc,
             m.joined_at
    limit 1;
    if v_store is null then
      return jsonb_build_object('ok', false, 'error', 'license-no-shop');
    end if;
  end if;

  -- Idempotent re-type: this key already unlocked this shop.
  if v_key.redeemed_at is not null and v_key.redeemed_store_id = v_store then
    update public.license_redeem_attempts set succeeded = true where id = v_attempt;
    return jsonb_build_object(
      'ok', true,
      'store_id', v_store,
      'status', public.license_effective_status(v_store),
      'plan', v_key.plan,
      'already_redeemed', true
    );
  end if;

  -- Atomic single-use claim: the WHERE clause is the race guard — two
  -- shops typing the same key at the same moment, exactly one wins.
  update public.license_keys
  set redeemed_store_id = v_store,
      redeemed_by = v_uid,
      redeemed_at = now()
  where id = v_key.id and redeemed_at is null and revoked_at is null;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'license-key-used');
  end if;

  insert into public.shop_licenses
    (store_id, status, license_key_id, plan, activated_at, current_period_ends_at)
  values (
    v_store,
    'active',
    v_key.id,
    v_key.plan,
    now(),
    case when v_key.plan = 'term'
         then now() + make_interval(months => v_key.term_months)
         else null end
  )
  on conflict (store_id) do update
    set status = 'active',
        license_key_id = excluded.license_key_id,
        plan = excluded.plan,
        activated_at = excluded.activated_at,
        current_period_ends_at = excluded.current_period_ends_at;

  update public.license_redeem_attempts set succeeded = true where id = v_attempt;

  return jsonb_build_object(
    'ok', true,
    'store_id', v_store,
    'status', 'active',
    'plan', v_key.plan,
    'current_period_ends_at',
      (select current_period_ends_at from public.shop_licenses where store_id = v_store)
  );
end $$;

-- ---------- 9. key list + revoke (platform master ONLY) ----------
create or replace function public.list_license_keys(p_limit integer default 200)
returns table (
  id                uuid,
  key_hint          text,
  plan              text,
  term_months       integer,
  batch_id          uuid,
  created_at        timestamptz,
  redeemed_store_id uuid,
  redeemed_store_name text,
  redeemed_at       timestamptz,
  revoked_at        timestamptz
)
language plpgsql security definer
set search_path = public
as $$
begin
  if not public.is_master() then
    raise exception 'license-not-master';
  end if;
  return query
    select k.id, k.key_hint, k.plan, k.term_months, k.batch_id, k.created_at,
           k.redeemed_store_id, s.name, k.redeemed_at, k.revoked_at
    from public.license_keys k
    left join public.pos_stores s on s.id = k.redeemed_store_id
    order by k.created_at desc
    limit least(coalesce(p_limit, 200), 500);
end $$;

create or replace function public.revoke_license_key(p_key_id uuid)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_key record;
begin
  if not public.is_master() then
    raise exception 'license-not-master';
  end if;
  select * into v_key from public.license_keys where id = p_key_id;
  if not found then
    raise exception 'license-key-missing';
  end if;
  if v_key.revoked_at is not null then
    return; -- already revoked: no-op
  end if;
  update public.license_keys set revoked_at = now() where id = p_key_id;
  -- A revoked key that had already unlocked a shop locks that shop
  -- again (e.g. a refunded or charged-back purchase). Its data is
  -- untouched; the owner can unlock with a fresh key.
  if v_key.redeemed_store_id is not null then
    update public.shop_licenses
    set status = 'locked', license_key_id = null, plan = null,
        current_period_ends_at = null
    where store_id = v_key.redeemed_store_id;
  end if;
end $$;

-- ---------- 10. POS hard enforcement ----------
-- Sales stop the moment a shop is locked — at the database, so no
-- client can talk its way around the lock screen. Refunds and voids
-- update existing rows and stay allowed on purpose.
create or replace function public.guard_pos_sale_license()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  if public.license_effective_status(new.store_id) = 'locked' then
    raise exception 'license-locked: this shop is locked — unlock it to make sales';
  end if;
  return new;
end $$;

drop trigger if exists pos_sales_license_guard on public.pos_sales;
create trigger pos_sales_license_guard
  before insert on public.pos_sales
  for each row execute function public.guard_pos_sale_license();

-- ---------- 11. support routing: shop vs platform ----------
-- scope = 'shop'     -> the shop's own admins (existing behavior)
-- scope = 'platform' -> the platform owner: purchase requests from the
--                       lock screen and the Settings Support tab.
alter table public.support_tickets
  add column if not exists scope text not null default 'shop'
    check (scope in ('shop', 'platform'));
alter table public.support_tickets
  add column if not exists store_id uuid references public.pos_stores(id) on delete set null;
create index if not exists support_tickets_scope
  on public.support_tickets (scope, status, created_at desc);

-- The platform master reads and answers platform tickets even where a
-- shop admin layer sits between (existing admin policies keep working
-- alongside these).
drop policy if exists "support_tickets_master_platform_select" on public.support_tickets;
create policy "support_tickets_master_platform_select"
  on public.support_tickets for select
  to authenticated
  using (scope = 'platform' and public.is_master());

drop policy if exists "support_tickets_master_platform_update" on public.support_tickets;
create policy "support_tickets_master_platform_update"
  on public.support_tickets for update
  to authenticated
  using (scope = 'platform' and public.is_master())
  with check (scope = 'platform' and public.is_master());

-- ---------- grants ----------
-- RPCs are the only door; make sure the authenticated role can call
-- them (each function still verifies the caller itself).
revoke all on function public.license_effective_status(uuid) from public, anon;
revoke all on function public.my_license_status() from public, anon;
revoke all on function public.redeem_license_key(text, uuid) from public, anon;
revoke all on function public.generate_license_keys(integer, text, integer) from public, anon;
revoke all on function public.list_license_keys(integer) from public, anon;
revoke all on function public.revoke_license_key(uuid) from public, anon;
grant execute on function public.license_effective_status(uuid) to authenticated;
grant execute on function public.my_license_status() to authenticated;
grant execute on function public.redeem_license_key(text, uuid) to authenticated;
grant execute on function public.generate_license_keys(integer, text, integer) to authenticated;
grant execute on function public.list_license_keys(integer) to authenticated;
grant execute on function public.revoke_license_key(uuid) to authenticated;
