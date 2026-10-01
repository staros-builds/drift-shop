-- 055_void_refunded_sale_guard.sql
--
-- Server-side guard: a sale with ANY refunds can never be voided.
--
-- The refund rows are the audit trail for real money handed back to the
-- customer. Voiding a refunded sale silently erased those rows from
-- Reports/History (found by adversarial testing: sale voided after a full
-- refund left zero trace of the cash that went back out, and restocked
-- inventory for a sale whose money was already returned).
--
-- Invariant enforced: a sale is either voided (never happened) or refunded
-- (happened, money returned) — never both. (Refunding a voided sale was
-- already blocked by the refund hardening in 040/034.)
--
-- Two layers:
--   1. pos_void_sale RPC raises 'sale has refunds and cannot be voided'
--      right after the row lock, before touching anything.
--   2. A BEFORE UPDATE trigger on pos_sales.voided rejects the
--      false -> true transition whenever pos_refunds rows exist for the
--      sale. This covers the pos_void_sale RPC (which UPDATEs pos_sales),
--      the legacy direct-update client path, and any hand-rolled SQL —
--      the rule lives in the database, not the UI.
--
-- NOTE: deliberately NOT rewriting pos_void_sale here — migration 028
-- replaced that RPC with gift-card-aware logic, and a CREATE OR REPLACE
-- from the older 024 body would clobber it. The trigger fires inside the
-- RPC's UPDATE, so the RPC is covered without touching its body.

-- The trigger backstop.
create or replace function public.pos_sales_block_void_with_refunds()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(new.voided, false) = true and coalesce(old.voided, false) = false then
    if exists (select 1 from public.pos_refunds r where r.sale_id = new.id) then
      raise exception 'sale has refunds and cannot be voided';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_pos_sales_no_void_with_refunds on public.pos_sales;
create trigger trg_pos_sales_no_void_with_refunds
  before update of voided on public.pos_sales
  for each row
  execute function public.pos_sales_block_void_with_refunds();
