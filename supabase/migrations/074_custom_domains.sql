-- 074_custom_domains.sql
--
-- Per-shop nice URLs: every shop gets a real web address of its own.
--
-- Two tiers, both served by the SAME public storefront page:
-- 1. Automatic subdomain — <slug>.<apex>. Pure client-side syntax: the
--    app reads window.location.hostname, sees it under BRAND.apexDomain
--    (src/lib/brand.js, one line of config), and renders that slug's
--    storefront via the existing public_storefront() RPC. NO table, no
--    per-shop setup. Getting those hostnames to this app at all is a
--    hosting concern (wildcard DNS + a wildcard edge route), documented
--    in docs/custom-domains.md.
-- 2. The shop's own domain — the buyer bought a domain (e.g.
--    mymarieshop.ca) and points a CNAME at us. THAT needs this table:
--    custom_domains maps a hostname to a shop, and the
--    public_storefront_by_host() RPC below is the only anonymous door
--    (same pattern as public_storefront in migration 063).
--
-- Ownership proof (merge-round fix): a hostname is only SERVED after
-- the shop proves it controls the domain's DNS. Claiming generates a
-- secret token; the shop adds a DNS TXT record
--   _vendra-verify.<hostname>  ->  vendra-verify=<token>
-- and custom_domain_confirm() stamps verified_at once the record is
-- seen. The old draft stamped verified_at on first serve, which let
-- ANYONE forge "Working" by hitting the URL — gone.
--
-- What this adds:
-- - custom_domains(hostname PK, store_id, verified_at,
--   verification_token, verification_txt_name). Edited from
--   Admin -> Storefront -> "Your web addresses" by the shop's
--   owners/managers (the migration 002 write pattern) and the master
--   account. RLS is on and there is deliberately NO anon policy:
--   anonymous visitors never touch this table directly.
-- - factory_reset() is NOT redefined here: the single final 51-table
--   definition lives in migration 078.
--
-- Idempotent: IF NOT EXISTS / CREATE OR REPLACE / DROP POLICY IF EXISTS.
-- Depends on: 063 (storefront_profiles, public_storefront, is_master,
-- pos_role, is_pos_member, touch_updated_at).

-- ---------- custom domains ----------
create table if not exists public.custom_domains (
  hostname    text primary key
    check (char_length(hostname) between 4 and 253
           and hostname ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$'
           and hostname <> 'localhost'
           and hostname not like '%.localhost'
           and hostname !~ '^[0-9.]+$'),
  store_id    uuid not null references public.pos_stores(id) on delete cascade,
  verified_at timestamptz,
  verification_token text not null
    default encode(extensions.gen_random_bytes(16), 'hex')
    check (char_length(verification_token) between 16 and 64),
  verification_txt_name text generated always as
    ('_vendra-verify.' || hostname) stored,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
alter table public.custom_domains enable row level security;

create index if not exists custom_domains_store_idx
  on public.custom_domains (store_id);

drop trigger if exists custom_domains_touch on public.custom_domains;
create trigger custom_domains_touch
  before update on public.custom_domains
  for each row execute function public.touch_updated_at();

-- ---------- RLS: custom_domains ----------
-- Same shape as storefront_profiles (063): members may read their shop's
-- rows (the editor shows them); writes are owner/manager or master.
-- NO anon policy, on purpose — the public only ever reaches a shop
-- through the SECURITY DEFINER RPC below.
drop policy if exists "custom_domains_member_select" on public.custom_domains;
create policy "custom_domains_member_select"
  on public.custom_domains for select
  using (public.is_pos_member(store_id) or public.is_master());

drop policy if exists "custom_domains_manager_insert" on public.custom_domains;
create policy "custom_domains_manager_insert"
  on public.custom_domains for insert
  with check (public.pos_role(store_id) in ('owner', 'manager') or public.is_master());

drop policy if exists "custom_domains_manager_update" on public.custom_domains;
create policy "custom_domains_manager_update"
  on public.custom_domains for update
  using (public.pos_role(store_id) in ('owner', 'manager') or public.is_master())
  with check (public.pos_role(store_id) in ('owner', 'manager') or public.is_master());

drop policy if exists "custom_domains_owner_delete" on public.custom_domains;
create policy "custom_domains_owner_delete"
  on public.custom_domains for delete
  using (public.pos_role(store_id) = 'owner' or public.is_master());

-- ---------- hostname normalization (one rule, used everywhere) ----
create or replace function public.domain_normalize(p_host text)
returns text
language sql
immutable
set search_path = public
as $$
  select case
    when v = '' then ''
    else v
  end
  from (
    select regexp_replace(
             regexp_replace(lower(btrim(coalesce(p_host, ''))), ':\d+$', ''),
             '\.$', '') as v
  ) q;
$$;

-- ---------- claim + confirm (the DNS TXT challenge) ------------------
-- Claiming (owner/manager or master) returns the TXT record to add.
-- Re-claiming your own unverified hostname hands out a FRESH token.
-- A hostname verified (or even claimed) by another shop cannot be
-- taken over here — the master account resolves disputes by deleting
-- the row in the admin.
create or replace function public.custom_domain_claim(
  p_store_id uuid,
  p_hostname text
)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_host  text := public.domain_normalize(p_hostname);
  v_row   public.custom_domains%rowtype;
  v_token text := encode(extensions.gen_random_bytes(16), 'hex');
begin
  if auth.uid() is null then raise exception 'sign in first'; end if;
  if not (public.pos_role(p_store_id) in ('owner', 'manager') or public.is_master()) then
    raise exception 'only the shop owner or manager can connect a domain';
  end if;
  if v_host = '' or v_host !~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$'
     or char_length(v_host) < 4 or char_length(v_host) > 253
     or v_host = 'localhost' or v_host like '%.localhost' or v_host ~ '^[0-9.]+$' then
    raise exception 'DOMAIN_INVALID';
  end if;

  select * into v_row from public.custom_domains where hostname = v_host;
  if found then
    if v_row.store_id <> p_store_id then
      raise exception 'DOMAIN_TAKEN';
    end if;
    -- Our own row: keep the verification state, refresh the token only
    -- while unverified (a verified domain needs no new record).
    if v_row.verified_at is null then
      update public.custom_domains
         set verification_token = v_token
       where hostname = v_host
       returning * into v_row;
    end if;
  else
    insert into public.custom_domains (hostname, store_id, verification_token)
    values (v_host, p_store_id, v_token)
    returning * into v_row;
  end if;

  return jsonb_build_object(
    'hostname', v_row.hostname,
    'txt_name', v_row.verification_txt_name,
    'txt_value', 'vendra-verify=' || v_row.verification_token,
    'verified_at', v_row.verified_at
  );
end $$;

-- Confirming: the client checks DNS (it has internet access; SQL does
-- not) and presents the token it saw. Only the shop's own token —
-- visible solely to its members — can confirm, so an outsider cannot
-- forge verification, and only whoever controls the DNS zone can make
-- the check pass honestly.
create or replace function public.custom_domain_confirm(
  p_store_id uuid,
  p_hostname text,
  p_txt_value text
)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_host text := public.domain_normalize(p_hostname);
  v_row  public.custom_domains%rowtype;
begin
  if auth.uid() is null then raise exception 'sign in first'; end if;
  if not (public.pos_role(p_store_id) in ('owner', 'manager') or public.is_master()) then
    raise exception 'only the shop owner or manager can verify a domain';
  end if;

  select * into v_row
    from public.custom_domains
   where hostname = v_host and store_id = p_store_id;
  if not found then raise exception 'DOMAIN_NOT_CLAIMED'; end if;

  if v_row.verified_at is null then
    if coalesce(p_txt_value, '') <> 'vendra-verify=' || v_row.verification_token then
      return jsonb_build_object('verified', false, 'reason', 'txt-not-seen');
    end if;
    update public.custom_domains
       set verified_at = now()
     where hostname = v_host
     returning * into v_row;
  end if;

  return jsonb_build_object(
    'verified', true,
    'hostname', v_row.hostname,
    'verified_at', v_row.verified_at
  );
end $$;

revoke all on function public.domain_normalize(text) from public, anon, authenticated;
revoke all on function public.custom_domain_claim(uuid, text) from public, anon;
revoke all on function public.custom_domain_confirm(uuid, text, text) from public, anon;
grant execute on function public.custom_domain_claim(uuid, text) to authenticated;
grant execute on function public.custom_domain_confirm(uuid, text, text) to authenticated;

-- ---------- public lookup: hostname -> slug (the only anonymous door) --
-- Answers with the slug ONLY when the mapping exists, has passed the
-- DNS challenge (verified_at set), AND the shop's storefront is
-- published. An unverified claim exposes nothing.
create or replace function public.public_storefront_by_host(p_host text)
returns text
language plpgsql security definer
set search_path = public
as $$
declare
  v_host text := public.domain_normalize(p_host);
  v_slug text;
begin
  if v_host = '' then
    return null;
  end if;

  select sp.slug into v_slug
  from public.custom_domains cd
  join public.storefront_profiles sp on sp.store_id = cd.store_id
  where cd.hostname = v_host
    and cd.verified_at is not null
    and sp.published = true;

  return v_slug;
end $$;

revoke all on function public.public_storefront_by_host(text) from public;
grant execute on function public.public_storefront_by_host(text) to anon, authenticated;

-- factory_reset(): NOT defined here. The single final definition
-- (every public table, master reseed incl. account_kind) lives in
-- migration 078. Defining it mid-sequence would strand an
-- incomplete TRUNCATE list that breaks on re-run once the later
-- tables exist (FK-guarded TRUNCATE is all-or-nothing).


revoke all on function public.factory_reset() from public, anon;
grant execute on function public.factory_reset() to authenticated;
