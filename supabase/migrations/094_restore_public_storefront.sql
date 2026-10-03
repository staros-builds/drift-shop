-- 094_restore_public_storefront.sql
-- Restore full public_storefront() definition that was simplified by 090/092.
-- 090/092 dropped: currency, tax rates, social/contact links, product id/stock/track_stock.
-- This restores everything from 071 plus the payment fields from 090/092.

create or replace function public.public_storefront(p_slug text)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_row      public.storefront_profiles%rowtype;
  v_products jsonb;
  v_store    record;
begin
  select * into v_row
  from public.storefront_profiles
  where slug = lower(btrim(coalesce(p_slug, '')))
    and published = true;
  if not found then
    return null;
  end if;

  select s.name, s.currency, s.tax_rate, s.tax_rates
    into v_store
  from public.pos_stores s
  where s.id = v_row.store_id;

  select coalesce(
           jsonb_agg(
             jsonb_build_object(
               'id', p.id,
               'name', p.name,
               'price', p.price_cents,
               'track_stock', coalesce(p.track_stock, false),
               'stock', coalesce(p.stock, 0)
             )
             order by p.name
           ),
           '[]'::jsonb
         )
    into v_products
  from public.pos_products p
  where p.store_id = v_row.store_id
    and p.active = true
    and coalesce(p.public_visible, true) = true;

  return jsonb_build_object(
    'shop', jsonb_build_object(
      'name', v_store.name,
      'display_name', v_row.display_name,
      'tagline', v_row.tagline,
      'about', v_row.about,
      'hours', v_row.hours,
      'contact_email', v_row.contact_email,
      'contact_phone', v_row.contact_phone,
      'accent_color', v_row.accent_color,
      'show_prices', v_row.show_prices,
      'currency', v_store.currency,
      'online_ordering', jsonb_build_object(
        'enabled', coalesce(v_row.online_ordering, false),
        'note', v_row.ordering_note
      ),
      'tax', jsonb_build_object(
        'rates', coalesce(v_store.tax_rates, '[]'::jsonb),
        'legacy_rate', coalesce(v_store.tax_rate, 0)
      ),
      'address', v_row.address,
      'facebook_url', v_row.facebook_url,
      'instagram_url', v_row.instagram_url,
      'tiktok_url', v_row.tiktok_url,
      'whatsapp_phone', v_row.whatsapp_phone,
      'review_url', v_row.review_url,
      'directions_url', v_row.directions_url,
      'order_url', v_row.order_url,
      'newsletter_url', v_row.newsletter_url,
      'payments', jsonb_build_object(
        'lemonsqueezy', jsonb_build_object(
          'enabled', coalesce(v_row.ls_enabled, false),
          'checkout_url', case
            when coalesce(v_row.ls_enabled, false) and v_row.ls_checkout_url ~ '^https://'
            then v_row.ls_checkout_url
            else null
          end
        ),
        'stripe', jsonb_build_object(
          'enabled', coalesce(v_row.stripe_enabled, false),
          'checkout_url', case
            when coalesce(v_row.stripe_enabled, false) and v_row.stripe_checkout_url ~ '^https://'
            then v_row.stripe_checkout_url
            else null
          end
        )
      )
    ),
    'products', v_products
  );
end $$;

revoke all on function public.public_storefront(text) from public;
grant execute on function public.public_storefront(text) to anon, authenticated;
