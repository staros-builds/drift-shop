-- 095_webhook_secrets.sql
-- Add per-shop webhook signing secrets for Lemon Squeezy and Stripe.
-- These are used by the Edge Functions to verify webhook signatures.

alter table public.storefront_profiles
  add column if not exists ls_webhook_secret text,
  add column if not exists stripe_webhook_secret text;

-- The secrets are sensitive; only the shop owner should see them.
-- The Edge Functions use service_role so they can read them.
comment on column public.storefront_profiles.ls_webhook_secret is 'Lemon Squeezy webhook signing secret (from LS dashboard → Settings → Webhooks)';
comment on column public.storefront_profiles.stripe_webhook_secret is 'Stripe webhook endpoint secret (from Stripe dashboard → Developers → Webhooks)';
