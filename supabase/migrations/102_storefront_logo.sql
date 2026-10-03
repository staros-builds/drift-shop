-- 102_storefront_logo.sql
--
-- Shop logo for the public storefront. The owner uploads a logo in the
-- storefront editor; it is stored as shrunk data (same pattern as
-- classified_ads.photo_data) and served through the public_storefront()
-- RPC so anonymous visitors see it.
--
-- Idempotent: safe to re-run.

begin;

-- 1. column
alter table public.storefront_profiles
  add column if not exists logo_data text;

-- 2. RPC: include the logo in the public payload.
-- CREATE OR REPLACE carried from migration 063 with ONE addition:
-- 'logo' in the shop object.
create or replace function public.public_storefront(p_slug text)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_row      public.storefront_profiles%rowtype;
  v_products jsonb;
begin
  select * into v_row
  from public.storefront_profiles
  where slug = lower(btrim(coalesce(p_slug, '')))
    and published = true;
  if not found then
    return null;
  end if;

  select coalesce(
           jsonb_agg(
             jsonb_build_object('name', p.name, 'price', p.price_cents)
             order by p.name
           ),
           '[]'::jsonb
         )
    into v_products
  from public.pos_products p
  where p.store_id = v_row.store_id
    and p.public_visible = true
    and p.active = true;

  return jsonb_build_object(
    'shop', jsonb_build_object(
      'display_name', v_row.display_name,
      'tagline', v_row.tagline,
      'about', v_row.about,
      'hours', v_row.hours,
      'contact_email', v_row.contact_email,
      'contact_phone', v_row.contact_phone,
      'accent_color', v_row.accent_color,
      'show_prices', v_row.show_prices,
      'logo', v_row.logo_data
    ),
    'products', v_products
  );
end $$;

revoke all on function public.public_storefront(text) from public;
grant execute on function public.public_storefront(text) to anon, authenticated;

commit;
