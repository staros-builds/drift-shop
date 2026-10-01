-- 045: Persist promo / tender-adjustment / loyalty data on pos_sales.
--
-- HOLE: the POS computes promoCode, promoDiscountCents, tender adjustments
-- (gift-card / loyalty / deposit redemptions covering part of the ticket)
-- and loyalty earned/redeemed for every sale, but backend.pos.recordSale
-- silently DROPPED all of it — the insert payload only carried
-- subtotal/discount/tax/total/method/tendered/change. A sale with a $20
-- promo recorded subtotal=10000, discount=0, total=8000: the $20 vanishes
-- from the books (reports undercount discounts, reprints can't show the
-- promo, and tender reconciliation can't see gift-card/loyalty coverage).
--
-- FIX: additive nullable/defaulted columns + the recordSale payload starts
-- sending them (behind a capability probe, same pattern as tax_lines /
-- org columns, so old DBs without 045 keep working).

alter table public.pos_sales
  add column if not exists promo_code              text,
  add column if not exists promo_discount_cents     bigint not null default 0,
  add column if not exists tender_adjustments       jsonb  not null default '[]',
  add column if not exists loyalty_earned            int    not null default 0,
  add column if not exists loyalty_redeemed_points   int    not null default 0;

alter table public.pos_sales
  add constraint pos_sales_promo_nonneg
  check (
    promo_discount_cents    >= 0 and
    loyalty_earned          >= 0 and
    loyalty_redeemed_points >= 0
  );
