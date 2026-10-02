-- 065: Special orders can link to a saved customer (all-in-one integration).
--
-- BEFORE: bq_special_orders carried only free-text customer_name /
-- customer_phone, so an order could never be tied back to the shop's
-- customer file (pos_customers) — no shared history, no click-to-fill.
--
-- NOW: an optional customer_id link. The free-text name/phone columns stay
-- and remain the snapshot shown on the order: picking a customer fills
-- them in (still editable for this order's contact), and deleting the
-- customer later keeps the order's own name/phone while clearing the link
-- (ON DELETE SET NULL). Walk-ins keep working exactly as before — the
-- link is never required.

alter table public.bq_special_orders
  add column if not exists customer_id uuid references public.pos_customers(id) on delete set null;

create index if not exists bq_special_orders_customer_id_idx
  on public.bq_special_orders (customer_id)
  where customer_id is not null;
