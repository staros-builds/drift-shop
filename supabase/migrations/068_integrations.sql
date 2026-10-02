-- 068 (renumbered at the final merge; drafted as 071). Idempotent:
-- safe to re-run. ORDERING: this file re-issues public_storefront();
-- migration 071 (customer orders) re-issues it again afterwards —
-- never re-run this file's storefront section after 071 has landed
-- without re-running 071 too.
--
-- Web-service connections for the public storefront: the shops paste
-- links they already have — Facebook, Instagram, TikTok, a WhatsApp
-- number, a Google review link, an order-online page (DoorDash, Uber
-- Eats, SkipTheDishes, their own…), an email sign-up form — plus their
-- street address, and the public page turns them into tidy buttons.
-- No account is created and no server of ours sits in the middle: the
-- links are validated in the app (http/https only) and re-validated at
-- render time, so a bad link simply never shows.
--
-- What this adds:
-- - storefront_profiles: street address + link columns (all optional
--   text). Same table, same RLS — no new policies, no anon access:
--   anonymous visitors still only reach the public_storefront() RPC.
-- - public_storefront(): re-issued from 063 with 'address' and a
--   'links' object added to the shop payload. The links object carries
--   the RAW field values; the app builds and validates the final hrefs
--   (src/lib/integrations.js), so a value that stops validating never
--   renders.
-- - No factory_reset() change: no new table, so the 063/062 wipe list
--   already covers these columns (they die with the profile row).
--
-- Idempotent: ADD COLUMN IF NOT EXISTS / CREATE OR REPLACE.

alter table public.storefront_profiles
  add column if not exists address        text,
  add column if not exists facebook_url   text,
  add column if not exists instagram_url  text,
  add column if not exists tiktok_url     text,
  add column if not exists whatsapp_phone text,
  add column if not exists review_url     text,
  add column if not exists directions_url text,
  add column if not exists order_url      text,
  add column if not exists newsletter_url text;

-- ---------- public storefront RPC (the only anonymous door) ----------
-- Body is migration 063's, with 'address' and 'links' added to the
-- shop object. Everything else (published-only gate, visible+active
-- products, NULL for unknown slugs) is unchanged.
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
      'address', v_row.address,
      'links', jsonb_strip_nulls(jsonb_build_object(
        'facebook_url', v_row.facebook_url,
        'instagram_url', v_row.instagram_url,
        'tiktok_url', v_row.tiktok_url,
        'whatsapp_phone', v_row.whatsapp_phone,
        'review_url', v_row.review_url,
        'directions_url', v_row.directions_url,
        'order_url', v_row.order_url,
        'newsletter_url', v_row.newsletter_url
      ))
    ),
    'products', v_products
  );
end $$;

revoke all on function public.public_storefront(text) from public;
grant execute on function public.public_storefront(text) to anon, authenticated;

-- ---------------------------------------------------------------------
-- Merge-round hardening (SQL review, 2026-10-01): make the link scheme
-- guarantee server-side, not only app-side. A manager could otherwise
-- store a javascript: URL via direct API writes; the render layer would
-- drop it, but the database should never hold it in the first place.
-- Guarded DO blocks keep this migration safely re-runnable.
-- ---------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'storefront_profiles_links_http') then
    alter table public.storefront_profiles
      add constraint storefront_profiles_links_http check (
        (facebook_url   is null or facebook_url   ~* '^https?://') and
        (instagram_url  is null or instagram_url  ~* '^https?://') and
        (tiktok_url     is null or tiktok_url     ~* '^https?://') and
        (review_url     is null or review_url     ~* '^https?://') and
        (directions_url is null or directions_url ~* '^https?://') and
        (order_url      is null or order_url      ~* '^https?://') and
        (newsletter_url is null or newsletter_url ~* '^https?://')
      );
  end if;
end $$;
