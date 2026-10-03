-- 091_stripe_shop_payments.sql
-- Add optional Stripe payment integration per shop.
-- Shop owners can connect their own Stripe payment link to accept
-- online payments. Same pattern as Lemon Squeezy (089).

alter table public.storefront_profiles
  add column if not exists stripe_enabled boolean not null default false,
  add column if not exists stripe_checkout_url text;

comment on column public.storefront_profiles.stripe_enabled is
  'Shop owner opted into Stripe online payments';
comment on column public.storefront_profiles.stripe_checkout_url is
  'Shop owner''s Stripe payment link for online orders';
