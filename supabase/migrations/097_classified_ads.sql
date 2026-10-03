-- 097_classified_ads.sql
--
-- Kijiji-style classified ads, per shop (shared-shop model).
-- Shop owners post ads (for sale, free stuff, services, wanted, jobs,
-- events, announcements); each ad is a draft until published, and
-- published ads appear on the shop's public storefront through the
-- public_classifieds() RPC below (security definer, like
-- public_storefront()).
--
-- Permission model (mirrors pos_products / bq_items):
--   SELECT ............ any store member (+ anon for published ads)
--   INSERT/UPDATE ..... any store member (daily operational work)
--   DELETE ............ owner/manager only (destructive)
--
-- Idempotent: safe to re-run.

begin;

-- ================= 1. table =================
create table if not exists public.classified_ads (
  id            uuid primary key default gen_random_uuid(),
  store_id      uuid not null references public.pos_stores(id) on delete cascade,
  user_id       uuid not null,
  title         text not null check (char_length(btrim(title)) between 1 and 120),
  description   text not null default '',
  price_cents   integer check (price_cents is null or price_cents >= 0),
  category      text not null default 'for-sale'
                check (category in ('for-sale','free','services','wanted','jobs','events','announcements')),
  photo_data    text,                       -- shrunk data: URL (see imageShrink.js)
  contact_name  text not null default '',
  contact_phone text not null default '',
  contact_email text not null default '',
  status        text not null default 'draft' check (status in ('draft','published')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

alter table public.classified_ads enable row level security;

drop trigger if exists classified_ads_touch on public.classified_ads;
create trigger classified_ads_touch
  before update on public.classified_ads
  for each row execute function public.touch_updated_at();

create index if not exists classified_ads_store on public.classified_ads (store_id);
create index if not exists classified_ads_store_status on public.classified_ads (store_id, status);

-- ================= 2. RLS =================
-- Store members manage their shop's ads; the public (anon) may read
-- published ads only (the storefront RPC is security definer and
-- bypasses RLS, this policy covers any direct public read path).
drop policy if exists "classified_ads_member_select" on public.classified_ads;
create policy "classified_ads_member_select" on public.classified_ads
  for select using (public.is_pos_member(store_id));

drop policy if exists "classified_ads_public_select" on public.classified_ads;
create policy "classified_ads_public_select" on public.classified_ads
  for select to anon using (status = 'published');

drop policy if exists "classified_ads_member_insert" on public.classified_ads;
create policy "classified_ads_member_insert" on public.classified_ads
  for insert with check (public.is_pos_member(store_id));

drop policy if exists "classified_ads_member_update" on public.classified_ads;
create policy "classified_ads_member_update" on public.classified_ads
  for update
  using (public.is_pos_member(store_id))
  with check (public.is_pos_member(store_id));

drop policy if exists "classified_ads_manager_delete" on public.classified_ads;
create policy "classified_ads_manager_delete" on public.classified_ads
  for delete using (public.pos_role(store_id) in ('owner', 'manager'));

-- ================= 3. public RPC =================
-- Published classifieds for a shop's public storefront, by slug.
-- Returns [] for unknown/unpublished storefronts (never null, so the
-- storefront UI can render unconditionally).
create or replace function public.public_classifieds(p_slug text)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_store_id uuid;
  v_ads      jsonb;
begin
  select sp.store_id into v_store_id
  from public.storefront_profiles sp
  where sp.slug = lower(btrim(coalesce(p_slug, '')))
    and sp.published = true;
  if not found then
    return '[]'::jsonb;
  end if;

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
               'created_at', a.created_at
             )
             order by a.created_at desc
           ),
           '[]'::jsonb
         )
    into v_ads
  from public.classified_ads a
  where a.store_id = v_store_id
    and a.status = 'published';

  return v_ads;
end $$;

revoke all on function public.public_classifieds(text) from public;
grant execute on function public.public_classifieds(text) to anon, authenticated;

commit;
