-- 100_platform_settings.sql
--
-- Platform-owner controls (master admin): adjustable settings for the free
-- customer tier, account recovery, and classifieds moderation.
--
--   * platform_settings table (key/value, master-only via RPCs)
--   * the customer-ads guard trigger now reads its limits from the table
--     instead of hardcoded numbers, so the master can tune them live
--   * master-only RPCs: get/set settings, list + remove customer ads
--     (moderation), reset a user's recovery data, recovery adoption stats
--   * a public (anon-safe) RPC exposing only the non-secret policy values
--     the client needs to display limits honestly
--
-- Idempotent: safe to re-run.

begin;

-- ================= 1. settings table =================
create table if not exists public.platform_settings (
  key        text primary key,
  value      text not null,
  updated_at timestamptz not null default now(),
  updated_by uuid
);
alter table public.platform_settings enable row level security;
-- No direct policies: only the master-gated RPCs below touch this table.
-- (No policies = deny all for anon/authenticated; security-definer RPCs
-- bypass RLS.)

-- ================= 2. defaults (never overwrite existing) =================
insert into public.platform_settings (key, value) values
  ('customer_ads_enabled',      'true'),
  ('customer_ads_max_active',   '15'),
  ('customer_ads_max_per_day',  '5'),
  ('customer_ads_expiry_days',  '60'),
  ('recovery_enabled',          'true'),
  ('recovery_codes_count',      '8'),
  ('recovery_max_attempts',     '10'),
  ('recovery_window_minutes',   '15')
on conflict (key) do nothing;

-- ================= 3. setting reader (with fallback) =================
-- SECURITY DEFINER so triggers and RPCs can read it despite the table's
-- deny-all RLS (only RPCs are the client-facing door).
create or replace function public.platform_setting(p_key text, p_default text)
returns text
language sql stable security definer
set search_path = public
as $$
  select coalesce(
    (select s.value from public.platform_settings s where s.key = p_key),
    p_default
  );
$$;
-- (grants for this function live in section 7 with the rest)

-- ================= 4. customer-ads guard: limits now come from settings ====
-- Same logic as 099, but max_active / max_per_day / expiry_days are read
-- from platform_settings (falling back to the original 15 / 5 / 60 when
-- the table is missing or a key is absent). Also honors the master
-- kill-switch customer_ads_enabled=false.
create or replace function public.classified_ads_customer_guard()
returns trigger
language plpgsql
as $$
declare
  v_active    integer;
  v_today     integer;
  v_max_active integer;
  v_max_day    integer;
  v_expiry     integer;
  v_enabled    text;
begin
  if new.owner_type <> 'customer' then
    return new;
  end if;

  v_enabled := public.platform_setting('customer_ads_enabled', 'true');
  if lower(v_enabled) <> 'true' then
    raise exception 'CUSTOMER_TIER_DISABLED'
      using errcode = 'P0001';
  end if;

  v_max_active := greatest(1, coalesce(nullif(public.platform_setting('customer_ads_max_active', '15'), '')::integer, 15));
  v_max_day    := greatest(1, coalesce(nullif(public.platform_setting('customer_ads_max_per_day', '5'), '')::integer, 5));
  v_expiry     := greatest(1, coalesce(nullif(public.platform_setting('customer_ads_expiry_days', '60'), '')::integer, 60));

  -- Active ads: published and not expired. Drafts don't count.
  select count(*) into v_active
  from public.classified_ads
  where owner_type = 'customer'
    and user_id = new.user_id
    and status = 'published'
    and (expires_at is null or expires_at > now())
    and (TG_OP = 'INSERT' or id <> new.id);

  if v_active >= v_max_active then
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
    if v_today >= v_max_day then
      raise exception 'CUSTOMER_LIMIT_DAILY'
        using errcode = 'P0001';
    end if;
  end if;

  -- Expiry: a customer ad that becomes published gets v_expiry days.
  -- Renewing (re-publishing an expired ad) resets the clock.
  if new.status = 'published'
     and (new.expires_at is null
          or new.expires_at <= now()
          or (TG_OP = 'UPDATE' and old.status <> 'published')) then
    new.expires_at := now() + (v_expiry::text || ' days')::interval;
  end if;

  return new;
end $$;

-- ================= 5. recovery rate limit: also tunable =================
create or replace function public.recovery_check_rate_limit(p_login_key text)
returns boolean
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_row     public.recovery_attempts%rowtype;
  v_max     integer;
  v_window  integer;
begin
  -- Lazy cleanup of stale rows (older than a day).
  delete from public.recovery_attempts where last_attempt_at < now() - interval '1 day';
  v_max    := greatest(1, coalesce(nullif(public.platform_setting('recovery_max_attempts', '10'), '')::integer, 10));
  v_window := greatest(1, coalesce(nullif(public.platform_setting('recovery_window_minutes', '15'), '')::integer, 15));
  select * into v_row from public.recovery_attempts where login_key = p_login_key;
  if not found then
    return true;
  end if;
  -- v_max failures inside a rolling v_window-minute window blocks further attempts.
  if v_row.attempts >= v_max and v_row.last_attempt_at > now() - (v_window::text || ' minutes')::interval then
    return false;
  end if;
  -- Window passed: reset the counter.
  if v_row.last_attempt_at <= now() - (v_window::text || ' minutes')::interval then
    delete from public.recovery_attempts where login_key = p_login_key;
  end if;
  return true;
end;
$$;

-- ================= 6. master-only RPCs =================

-- All platform settings as one object. Master only.
create or replace function public.platform_get_settings()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_out jsonb;
begin
  if not public.is_master() then
    raise exception 'not authorized';
  end if;
  select coalesce(jsonb_object_agg(s.key, s.value), '{}'::jsonb)
    into v_out
    from public.platform_settings s;
  return v_out;
end;
$$;

-- Update one setting. Master only. Keys and values are validated against
-- an allowlist so a typo can't corrupt policy.
create or replace function public.platform_set_setting(p_key text, p_value text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_key   text := trim(coalesce(p_key, ''));
  v_value text := trim(coalesce(p_value, ''));
  v_int   integer;
begin
  if not public.is_master() then
    raise exception 'not authorized';
  end if;
  case v_key
    when 'customer_ads_enabled', 'recovery_enabled' then
      if lower(v_value) not in ('true', 'false') then
        raise exception 'must be true or false';
      end if;
      v_value := lower(v_value);
    when 'customer_ads_max_active' then
      v_int := v_value::integer;
      if v_int < 1 or v_int > 200 then raise exception 'must be 1-200'; end if;
    when 'customer_ads_max_per_day' then
      v_int := v_value::integer;
      if v_int < 1 or v_int > 100 then raise exception 'must be 1-100'; end if;
    when 'customer_ads_expiry_days' then
      v_int := v_value::integer;
      if v_int < 1 or v_int > 730 then raise exception 'must be 1-730'; end if;
    when 'recovery_codes_count' then
      v_int := v_value::integer;
      if v_int < 4 or v_int > 16 then raise exception 'must be 4-16'; end if;
    when 'recovery_max_attempts' then
      v_int := v_value::integer;
      if v_int < 3 or v_int > 100 then raise exception 'must be 3-100'; end if;
    when 'recovery_window_minutes' then
      v_int := v_value::integer;
      if v_int < 1 or v_int > 1440 then raise exception 'must be 1-1440'; end if;
    else
      raise exception 'unknown setting';
  end case;
  insert into public.platform_settings (key, value, updated_at, updated_by)
  values (v_key, v_value, now(), auth.uid())
  on conflict (key) do update
    set value = excluded.value,
        updated_at = now(),
        updated_by = auth.uid();
end;
$$;

-- Public (anon-safe) subset of settings the client needs to display limits
-- honestly: policy values only, never secrets. No master check by design.
create or replace function public.platform_public_settings()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  return jsonb_build_object(
    'customer_ads_enabled',    public.platform_setting('customer_ads_enabled', 'true'),
    'customer_ads_max_active', public.platform_setting('customer_ads_max_active', '15'),
    'customer_ads_max_per_day', public.platform_setting('customer_ads_max_per_day', '5'),
    'customer_ads_expiry_days', public.platform_setting('customer_ads_expiry_days', '60'),
    'recovery_enabled',        public.platform_setting('recovery_enabled', 'true'),
    'recovery_codes_count',    public.platform_setting('recovery_codes_count', '8')
  );
end;
$$;

-- Moderation: every customer ad on the platform, newest first, with the
-- poster's username. Master only.
create or replace function public.platform_list_customer_ads(p_limit integer, p_offset integer, p_query text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ads jsonb;
  v_lim integer := greatest(1, least(200, coalesce(p_limit, 50)));
  v_off integer := greatest(0, coalesce(p_offset, 0));
  v_q   text := trim(coalesce(p_query, ''));
begin
  if not public.is_master() then
    raise exception 'not authorized';
  end if;
  select coalesce(
           jsonb_agg(
             jsonb_build_object(
               'id', a.id,
               'title', a.title,
               'description', a.description,
               'price_cents', a.price_cents,
               'category', a.category,
               'status', a.status,
               'contact_name', a.contact_name,
               'contact_phone', a.contact_phone,
               'contact_email', a.contact_email,
               'created_at', a.created_at,
               'expires_at', a.expires_at,
               'username', p.username
             )
             order by a.created_at desc
           ),
           '[]'::jsonb
         )
    into v_ads
    from public.classified_ads a
    left join public.profiles p on p.id = a.user_id
   where a.owner_type = 'customer'
     and (v_q = ''
          or a.title ilike '%' || v_q || '%'
          or coalesce(a.description, '') ilike '%' || v_q || '%'
          or coalesce(p.username, '') ilike '%' || v_q || '%')
   limit v_lim offset v_off;
  -- total count for pagination (same filter)
  return jsonb_build_object(
    'ads', v_ads,
    'total', (select count(*) from public.classified_ads a
               left join public.profiles p on p.id = a.user_id
              where a.owner_type = 'customer'
                and (v_q = ''
                     or a.title ilike '%' || v_q || '%'
                     or coalesce(a.description, '') ilike '%' || v_q || '%'
                     or coalesce(p.username, '') ilike '%' || v_q || '%')),
    'limit', v_lim,
    'offset', v_off
  );
end;
$$;

-- Moderation: remove one abusive customer ad. Master only.
create or replace function public.platform_remove_customer_ad(p_ad_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_master() then
    raise exception 'not authorized';
  end if;
  delete from public.classified_ads
   where id = p_ad_id and owner_type = 'customer';
  if not found then
    raise exception 'ad not found';
  end if;
end;
$$;

-- Support: wipe a user's recovery data (codes + security questions) so they
-- can start over. Master only. Refuses the master account itself.
create or replace function public.platform_reset_user_recovery(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_is_master boolean;
begin
  if not public.is_master() then
    raise exception 'not authorized';
  end if;
  if p_user_id is null then
    raise exception 'user not found';
  end if;
  select coalesce(p.is_master, false) into v_is_master
    from public.profiles p where p.id = p_user_id;
  if coalesce(v_is_master, false) then
    raise exception 'not authorized';
  end if;
  delete from public.recovery_codes where user_id = p_user_id;
  delete from public.security_questions where user_id = p_user_id;
end;
$$;

-- Adoption stats: how many users have recovery set up. Master only.
-- Counts only, no personal data.
create or replace function public.platform_recovery_status()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_master() then
    raise exception 'not authorized';
  end if;
  return jsonb_build_object(
    'codes_users',
    (select count(distinct user_id) from public.recovery_codes where used_at is null),
    'questions_users',
    (select count(*) from public.security_questions)
  );
end;
$$;

-- ================= 7. grants =================
-- Each function verifies is_master() itself; the public-settings reader is
-- intentionally open. Revoke-then-grant keeps re-runs clean.
revoke all on function public.platform_setting(text, text) from public, anon;
revoke all on function public.platform_get_settings() from public, anon;
revoke all on function public.platform_set_setting(text, text) from public, anon;
revoke all on function public.platform_list_customer_ads(integer, integer, text) from public, anon;
revoke all on function public.platform_remove_customer_ad(uuid) from public, anon;
revoke all on function public.platform_reset_user_recovery(uuid) from public, anon;
revoke all on function public.platform_recovery_status() from public, anon;
revoke all on function public.platform_public_settings() from public, anon;

grant execute on function public.platform_setting(text, text) to authenticated;
grant execute on function public.platform_get_settings() to authenticated;
grant execute on function public.platform_set_setting(text, text) to authenticated;
grant execute on function public.platform_list_customer_ads(integer, integer, text) to authenticated;
grant execute on function public.platform_remove_customer_ad(uuid) to authenticated;
grant execute on function public.platform_reset_user_recovery(uuid) to authenticated;
grant execute on function public.platform_recovery_status() to authenticated;
grant execute on function public.platform_public_settings() to anon, authenticated;

commit;
