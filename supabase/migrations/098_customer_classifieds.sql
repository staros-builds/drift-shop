-- 098_customer_classifieds.sql
--
-- Free customer tier for classifieds (Kijiji-style).
--
-- Anyone with a (free) account can post personal classified ads without
-- owning a shop. Customer ads live in the same `classified_ads` table,
-- distinguished by owner_type = 'customer' and a NULL store_id.
--
-- Anti-abuse limits, enforced SERVER-SIDE (triggers, not just UI):
--   * max 15 ACTIVE customer ads per user (published, not expired)
--   * max 5 NEW customer ads per user per calendar day
--   * customer ads expire 60 days after publishing (renewable)
--
-- Shop ads (owner_type = 'shop') are completely unaffected: no limits,
-- no expiry. The triggers only fire for owner_type = 'customer'.
--
-- Idempotent: safe to re-run.

begin;

-- ================= 1. schema =================
alter table public.classified_ads
  add column if not exists owner_type text not null default 'shop'
    check (owner_type in ('shop', 'customer'));

alter table public.classified_ads
  add column if not exists expires_at timestamptz;

-- Customer ads are personal: they have no shop. Shop ads keep store_id NOT NULL
-- in practice (the app always supplies it); relaxing the constraint is safe
-- because every shop insert path already provides a store_id.
alter table public.classified_ads
  alter column store_id drop not null;

create index if not exists classified_ads_customer
  on public.classified_ads (user_id, owner_type);

create index if not exists classified_ads_customer_active
  on public.classified_ads (user_id)
  where owner_type = 'customer' and status = 'published'
    and (expires_at is null or expires_at > now());

-- ================= 2. server-side limit enforcement =================
-- Fires only for customer ads. Raises distinct error codes the client maps
-- to friendly, translated messages.
create or replace function public.classified_ads_customer_guard()
returns trigger
language plpgsql
as $$
declare
  v_active  integer;
  v_today   integer;
begin
  if new.owner_type <> 'customer' then
    return new;
  end if;

  -- Active ads: published and not expired. Drafts don't count.
  select count(*) into v_active
  from public.classified_ads
  where owner_type = 'customer'
    and user_id = new.user_id
    and status = 'published'
    and (expires_at is null or expires_at > now())
    and (TG_OP = 'INSERT' or id <> new.id);

  if v_active >= 15 then
    raise exception 'CUSTOMER_LIMIT_ACTIVE'
      using errcode = 'P0001';
  end if;

  -- New ads per calendar day (any status counts: drafts count too, so users
  -- can't dodge the daily cap by draft-spamming).
  if TG_OP = 'INSERT' then
    select count(*) into v_today
    from public.classified_ads
    where owner_type = 'customer'
      and user_id = new.user_id
      and created_at >= date_trunc('day', now());
    if v_today >= 5 then
      raise exception 'CUSTOMER_LIMIT_DAILY'
        using errcode = 'P0001';
    end if;
  end if;

  -- Expiry: a customer ad that becomes published gets 60 days. Renewing
  -- (re-publishing an expired ad) resets the clock.
  if new.status = 'published'
     and (new.expires_at is null
          or new.expires_at <= now()
          or (TG_OP = 'UPDATE' and old.status <> 'published')) then
    new.expires_at := now() + interval '60 days';
  end if;

  return new;
end $$;

drop trigger if exists classified_ads_customer_guard on public.classified_ads;
create trigger classified_ads_customer_guard
  before insert or update on public.classified_ads
  for each row execute function public.classified_ads_customer_guard();

-- ================= 3. RLS =================
-- Customers manage their own personal ads. Shop policies from 097 are
-- untouched; they predicate on is_pos_member(store_id), which is false
-- for NULL store_id, so customer ads can never leak through them.

drop policy if exists "classified_ads_customer_select" on public.classified_ads;
create policy "classified_ads_customer_select" on public.classified_ads
  for select to authenticated
  using (owner_type = 'customer' and user_id = auth.uid());

drop policy if exists "classified_ads_customer_insert" on public.classified_ads;
create policy "classified_ads_customer_insert" on public.classified_ads
  for insert to authenticated
  with check (owner_type = 'customer' and user_id = auth.uid());

drop policy if exists "classified_ads_customer_update" on public.classified_ads;
create policy "classified_ads_customer_update" on public.classified_ads
  for update to authenticated
  using (owner_type = 'customer' and user_id = auth.uid())
  with check (owner_type = 'customer' and user_id = auth.uid());

drop policy if exists "classified_ads_customer_delete" on public.classified_ads;
create policy "classified_ads_customer_delete" on public.classified_ads
  for delete to authenticated
  using (owner_type = 'customer' and user_id = auth.uid());

-- Tighten the public read path from 097: expired ads must not be public.
drop policy if exists "classified_ads_public_select" on public.classified_ads;
create policy "classified_ads_public_select" on public.classified_ads
  for select to anon
  using (status = 'published' and (expires_at is null or expires_at > now()));

-- ================= 4. public community board RPC =================
-- Published, non-expired CUSTOMER ads for the public community board
-- (#/community). Separate from public_classifieds() so shop storefronts
-- are untouched. Clearly labeled by the client as neighbor-posted.
create or replace function public.public_customer_classifieds()
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_ads jsonb;
begin
  select coalesce(
           jsonb_agg(
             jsonb_build_object(
               'id', a.id,
               'title', a.title,
               'description', a.description,
               'price_cents', a.price_cents,
               'category', a.category,
               'photo_data', a.photo_data,
               'contact_name', a.contact_name,
               'contact_phone', a.contact_phone,
               'contact_email', a.contact_email,
               'created_at', a.created_at,
               'expires_at', a.expires_at
             )
             order by a.created_at desc
           ),
           '[]'::jsonb
         )
    into v_ads
  from public.classified_ads a
  where a.owner_type = 'customer'
    and a.status = 'published'
    and (a.expires_at is null or a.expires_at > now())
  limit 200;

  return v_ads;
end $$;

revoke all on function public.public_customer_classifieds() from public;
grant execute on function public.public_customer_classifieds() to anon, authenticated;

-- ================= 5. limit-status RPC =================
-- Lets the client show "X of 15 active · Y posts left today" without
-- reading the whole table. Only ever returns the caller's own numbers.
create or replace function public.customer_ad_limits()
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_uid    uuid := auth.uid();
  v_active integer;
  v_today  integer;
begin
  if v_uid is null then
    return jsonb_build_object('active', 0, 'today', 0);
  end if;
  select count(*) into v_active
  from public.classified_ads
  where owner_type = 'customer'
    and user_id = v_uid
    and status = 'published'
    and (expires_at is null or expires_at > now());
  select count(*) into v_today
  from public.classified_ads
  where owner_type = 'customer'
    and user_id = v_uid
    and created_at >= date_trunc('day', now());
  return jsonb_build_object('active', v_active, 'today', v_today);
end $$;

revoke all on function public.customer_ad_limits() from public;
grant execute on function public.customer_ad_limits() to authenticated;

commit;
