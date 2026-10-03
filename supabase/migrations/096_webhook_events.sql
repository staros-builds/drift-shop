-- 096_webhook_events.sql
-- Idempotency ledger for webhook events.
-- Prevents double-processing when providers retry delivery.

create table if not exists public.webhook_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null,           -- 'lemonsqueezy' | 'stripe'
  event_id text not null,            -- provider's unique event ID
  order_id uuid,                     -- vendra order that was marked paid
  event_type text,                   -- e.g. 'order_created', 'checkout.session.completed'
  created_at timestamptz not null default now(),
  unique (provider, event_id)
);

-- Only service_role (Edge Functions) writes here; no public access needed.
revoke all on public.webhook_events from public, anon, authenticated;
