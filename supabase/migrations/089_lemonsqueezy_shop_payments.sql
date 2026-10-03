-- 089_lemonsqueezy_shop_payments.sql
-- Add optional Lemon Squeezy payment integration per shop.
-- Shop owners can connect their own Lemon Squeezy store to accept
-- online payments from their customers. All fields optional; when
-- not configured, the storefront stays pay-at-pickup.

alter table public.storefront_profiles
  add column if not exists ls_enabled boolean not null default false,
  add column if not exists ls_checkout_url text,
  add column if not exists ls_store_url text;

-- Validate checkout URL format when provided (must be https)
-- Done in app code; DB just stores the value.

comment on column public.storefront_profiles.ls_enabled is
  'Shop owner opted into Lemon Squeezy online payments';
comment on column public.storefront_profiles.ls_checkout_url is
  'Shop owner''s Lemon Squeezy checkout/payment link for online orders';
comment on column public.storefront_profiles.ls_store_url is
  'Shop owner''s Lemon Squeezy store URL (for reference)';
