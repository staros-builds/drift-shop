-- 044: Harden pos_sales against hostile / tampered clients.
--
-- HOLE: backend.pos.recordSale does a direct INSERT of client-computed
-- amounts. The only server-side checks were RLS membership and the method
-- enum. Any team member (cashier) with a valid session could bypass the UI
-- and write, via the API: negative totals, discount 20x the subtotal,
-- under-tendered cash sales, negative tendered/change, negative quantities
-- or prices inside the items JSON, fractional quantities, non-array items,
-- or spoofed created_by attribution. Proven 11/12 hostile inserts ACCEPTED
-- against the real 002+004 DDL (harness pos-hostile-test.mjs).
--
-- FIX:
--   1. CHECK constraints: every money column on pos_sales must be >= 0.
--      (The UI already clamps totals at 0; legitimate sales always satisfy
--      this. $0 sales remain legal.)
--   2. BEFORE INSERT OR UPDATE trigger: items must be a non-empty JSON
--      array and every line must carry a positive integer qty, a
--      non-negative priceCents, and an itemDiscountCents within
--      [0, price*qty].
--   3. BEFORE INSERT trigger: created_by is forced to auth.uid(), so the
--      books always attribute a sale to its true actor (no spoofing).
--
-- NOTE: verify no existing rows violate these constraints before applying:
--   select count(*) from public.pos_sales
--    where subtotal_cents < 0 or discount_cents < 0 or tax_cents < 0
--       or total_cents < 0 or tendered_cents < 0 or change_cents < 0
--       or discount_cents > subtotal_cents
--       or jsonb_typeof(items) <> 'array' or jsonb_array_length(items) = 0;

alter table public.pos_sales
  add constraint pos_sales_money_nonneg
  check (
    subtotal_cents  >= 0 and
    discount_cents  >= 0 and
    tax_cents       >= 0 and
    total_cents     >= 0 and
    tendered_cents  >= 0 and
    change_cents    >= 0 and
    -- A cart discount can never exceed the sale's subtotal. (The UI caps
    -- percent discounts at 100% and amount discounts at the subtotal.)
    discount_cents  <= subtotal_cents
  );

create or replace function public.pos_sales_validate_items()
returns trigger
language plpgsql
as $$
declare
  it         jsonb;
  v_qty_txt  text;
  v_price_txt text;
  v_disc_txt text;
  v_qty      numeric;
  v_price    numeric;
  v_disc     numeric;
  v_idx      int := 0;
begin
  if new.items is null or jsonb_typeof(new.items) <> 'array'
     or jsonb_array_length(new.items) = 0 then
    raise exception 'sale must contain at least one line item';
  end if;
  for it in select * from jsonb_array_elements(new.items) loop
    v_idx := v_idx + 1;
    if jsonb_typeof(it) <> 'object' then
      raise exception 'sale line % is not an object', v_idx;
    end if;
    v_qty_txt := it->>'qty';
    if v_qty_txt is null or v_qty_txt !~ '^[0-9]+$' then
      raise exception 'sale line % has invalid qty', v_idx;
    end if;
    v_qty := v_qty_txt::numeric;
    if v_qty <= 0 then
      raise exception 'sale line % qty must be positive', v_idx;
    end if;
    v_price_txt := it->>'priceCents';
    if v_price_txt is null or v_price_txt !~ '^[0-9]+(\.[0-9]+)?$' then
      raise exception 'sale line % has invalid priceCents', v_idx;
    end if;
    v_price := v_price_txt::numeric;
    v_disc_txt := coalesce(it->>'itemDiscountCents', '0');
    if v_disc_txt !~ '^[0-9]+(\.[0-9]+)?$' then
      raise exception 'sale line % has invalid itemDiscountCents', v_idx;
    end if;
    v_disc := v_disc_txt::numeric;
    if v_disc > v_price * v_qty then
      raise exception 'sale line % discount exceeds line gross', v_idx;
    end if;
  end loop;
  return new;
end;
$$;

drop trigger if exists pos_sales_validate_items on public.pos_sales;
create trigger pos_sales_validate_items
  before insert or update on public.pos_sales
  for each row execute function public.pos_sales_validate_items();

create or replace function public.pos_sales_force_creator()
returns trigger
language plpgsql
as $$
begin
  -- Attribution integrity: a sale is always stamped with its true actor.
  new.created_by := auth.uid();
  return new;
end;
$$;

drop trigger if exists pos_sales_force_creator on public.pos_sales;
create trigger pos_sales_force_creator
  before insert on public.pos_sales
  for each row execute function public.pos_sales_force_creator();
