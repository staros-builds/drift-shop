-- 079_online_order_items_rls_fix.sql
--
-- Security fix for the online_order_items read policy.
--
-- Migration 071 originally allowed any authenticated user to read every
-- online_order_items row as long as some parent order existed. That is too
-- broad: order items must be visible only to (a) staff of the shop that owns
-- the order, or (b) the customer who placed that order. This migration is the
-- repo copy of the live hotfix already applied to the production project, so
-- fresh installs and re-runs converge on the same safe policy.
--
-- Idempotent: DROP POLICY IF EXISTS + CREATE POLICY. Safe to re-run.

drop policy if exists online_order_items_select on public.online_order_items;
create policy online_order_items_select on public.online_order_items
  for select to authenticated
  using (
    exists (
      select 1 from public.online_orders o
      where o.id = online_order_items.order_id
        and (
          public.is_pos_member(o.store_id)
          or exists (
            select 1 from public.online_customers c
            where c.id = o.online_customer_id and c.user_id = auth.uid()
          )
        )
    )
  );
