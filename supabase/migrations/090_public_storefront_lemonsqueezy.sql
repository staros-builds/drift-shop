-- 090_public_storefront_lemonsqueezy.sql
-- Expose Lemon Squeezy payment option in the public storefront API.
-- When a shop has ls_enabled=true and a valid checkout URL, the
-- storefront shows a "Pay online" button after order placement.

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
      'online_ordering', jsonb_build_object(
        'enabled', coalesce(v_row.online_ordering, false),
        'note', v_row.ordering_note
      ),
      'payments', jsonb_build_object(
        'lemonsqueezy', jsonb_build_object(
          'enabled', coalesce(v_row.ls_enabled, false),
          'checkout_url', case
            when coalesce(v_row.ls_enabled, false) and v_row.ls_checkout_url ~ '^https://'
            then v_row.ls_checkout_url
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
