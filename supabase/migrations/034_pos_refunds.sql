-- 034_pos_refunds.sql
--
-- Refunds for POS sales. The refund dialog in the POS Rapports tab was
-- written against backend.pos.refundSale, but the method and its backend
-- were never implemented — confirming a refund crashed with a TypeError.
-- This migration completes the backend and lights the feature up behind a
-- dedicated `refunds` capability (carved out of the posUpgrades bundle the
-- same way gift cards were), instead of leaving it hidden forever.
--
--   pos_refunds: one row per refunded sale line (line_index + qty), so the
--     UI can show remaining refundable quantities and a double refund —
--     double-click, retry or race — is rejected server-side.
--   pos_refund_sale(p_sale_id, p_lines, p_reason, p_as_credit): atomic RPC.
--     Locks the sale row (concurrent refunds serialize), validates each
--     line against already-refunded quantities, computes the refund with
--     the same proportional math as the UI estimate (each line gets its
--     net share of the receipt total: discount + promo + tax allocated
--     proportionally), restocks inventory, and — for the "to credit"
--     method — issues a gift card as store credit (redeemable at tender
--     via the existing gift-card flow).
--
-- Writes go only through the RPC (no direct write policies), same model
-- as pos_breaks / pos_time_punches. Only owners/managers may refund,
-- mirroring pos_void_sale.

create table if not exists public.pos_refunds (
  id             uuid primary key default gen_random_uuid(),
  store_id       uuid not null references public.pos_stores(id) on delete cascade,
  sale_id        uuid not null references public.pos_sales(id) on delete cascade,
  line_index     int  not null check (line_index >= 0),
  qty            int  not null check (qty > 0),
  refunded_cents int  not null check (refunded_cents >= 0),
  method         text not null check (method in ('cash', 'credit')),
  reason         text not null default '',
  credit_card_id uuid references public.pos_gift_cards(id) on delete set null,
  created_by     uuid references auth.users(id) on delete set null,
  created_at     timestamptz not null default now()
);
create index if not exists pos_refunds_sale on public.pos_refunds (sale_id, line_index);
create index if not exists pos_refunds_store on public.pos_refunds (store_id, created_at desc);

alter table public.pos_refunds enable row level security;

-- Reads: members see refunds on their sales history. No direct
-- insert/update/delete policies: every write goes through pos_refund_sale.
drop policy if exists "pos_refunds_member_select" on public.pos_refunds;
create policy "pos_refunds_member_select"
  on public.pos_refunds for select
  using (public.is_pos_member(store_id));
drop policy if exists "pos_refunds_member_insert" on public.pos_refunds;
drop policy if exists "pos_refunds_member_update" on public.pos_refunds;
drop policy if exists "pos_refunds_member_delete" on public.pos_refunds;

create or replace function public.pos_refund_sale(
  p_sale_id uuid, p_lines jsonb, p_reason text default '', p_as_credit boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_store     uuid;
  v_number    bigint;
  v_items     jsonb;
  v_total     bigint;
  v_role      text;
  v_warnings  jsonb := '[]'::jsonb;
  v_sub       bigint := 0;   -- sum of line nets (price*qty - line discount)
  v_sel_net   bigint := 0;   -- selected (refunded) portion of v_sub
  v_refunded  bigint := 0;   -- final refund in cents
  v_out_lines jsonb := '[]'::jsonb;
  v_ccode     text := null;  -- store-credit gift card code
  v_ccard_id  uuid := null;
  ln          jsonb;
  v_idx       int;
  v_req_qty   int;
  v_already   int;
  v_remain    int;
  it          jsonb;
  v_line_qty  int;
  v_price     int;
  v_disc      int;
  v_line_net  bigint;
  v_line_sel  bigint;
  v_row_cents bigint;
  v_allocated bigint := 0;
  v_pid       uuid;
  v_bqid      uuid;
  v_bqstatus  text;
  v_name      text;
  i           int := 0;
  v_n         int;
begin
  if auth.uid() is null then
    raise exception 'sign in to refund sales';
  end if;
  -- Punch pads must never move money out.
  perform public.require_account_type('full', 'staff');

  -- Lock the sale row: concurrent refunds serialize here.
  select s.store_id, s.number, coalesce(s.items, '[]'::jsonb), s.total_cents
    into v_store, v_number, v_items, v_total
    from public.pos_sales s
   where s.id = p_sale_id
   for update;
  if not found then
    raise exception 'sale not found';
  end if;

  if not public.is_pos_member(v_store) then
    raise exception 'not a member of this store';
  end if;
  v_role := public.pos_role(v_store);
  if v_role not in ('owner', 'manager') then
    raise exception 'only managers can refund sales';
  end if;

  if (select s.voided from public.pos_sales s where s.id = p_sale_id) then
    raise exception 'sale is voided';
  end if;

  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'no refund lines given';
  end if;

  -- The proportional denominator: net over ALL sale lines (not just the
  -- selected ones). This mirrors the UI estimate exactly — using only the
  -- selected lines here would refund the whole receipt total for a partial
  -- return. It must stay the original full-sale net (not the remaining
  -- unrefunded net), otherwise a second partial refund would over-refund.
  for it in select * from jsonb_array_elements(v_items) loop
    v_sub := v_sub + (
      public._safe_int(it->>'priceCents', 0)::bigint
        * greatest(1, public._safe_int(it->>'qty', 0))
      - public._safe_int(it->>'itemDiscountCents', 0));
  end loop;

  -- Pass 1: validate every line and accumulate the selected net.
  -- Mirrors the UI estimate exactly: netOf = price*qty - itemDiscount,
  -- selectedNet = round((netOf/qty) * refundQty), refund =
  -- round((selectedNet/sub) * totalCents).
  for ln in select * from jsonb_array_elements(p_lines) loop
    v_idx     := public._safe_int(ln->>'index', -1);
    v_req_qty := public._safe_int(ln->>'qty', 0);
    if v_idx < 0 or v_idx >= jsonb_array_length(v_items) then
      raise exception 'refund line % is not on this sale', v_idx;
    end if;
    if v_req_qty <= 0 then
      raise exception 'refund quantity must be positive';
    end if;
    it := v_items -> v_idx;
    v_line_qty := greatest(1, public._safe_int(it->>'qty', 0));
    select coalesce(sum(r.qty), 0) into v_already
      from public.pos_refunds r
     where r.sale_id = p_sale_id and r.line_index = v_idx;
    v_remain := public._safe_int(it->>'qty', 0) - v_already;
    if v_req_qty > v_remain then
      raise exception 'only % of "%" can still be refunded',
        v_remain, coalesce(it->>'name', 'item');
    end if;
    v_price := public._safe_int(it->>'priceCents', 0);
    v_disc  := public._safe_int(it->>'itemDiscountCents', 0);
    v_line_net := (v_price::bigint * v_line_qty) - v_disc;
    v_line_sel := round((v_line_net::numeric / v_line_qty) * v_req_qty);
    v_sel_net := v_sel_net + v_line_sel;
    v_out_lines := v_out_lines || jsonb_build_object(
      'index', v_idx, 'qty', v_req_qty, 'lineSelNet', v_line_sel);
  end loop;

  v_refunded := case when v_sub > 0
    then round((v_sel_net::numeric / v_sub) * v_total)
    else 0 end;
  if v_refunded < 0 then
    v_refunded := 0;
  end if;

  -- "To credit": issue a gift card as store credit (redeemable at tender).
  if p_as_credit and v_refunded > 0 then
    select c.code, c.id into v_ccode, v_ccard_id
      from public.pos_giftcard_issue(
        v_store, v_refunded::int, 'Refund #' || v_number::text) c;
  end if;

  -- Pass 2: write refund rows (per-line cents allocated with the rounding
  -- remainder on the last row so the rows sum to exactly v_refunded) and
  -- restock. A per-line exception handler isolates corrupt lines as
  -- warnings; the transaction — refund rows plus every healthy restock —
  -- stays atomic.
  v_n := jsonb_array_length(v_out_lines);
  for ln in select * from jsonb_array_elements(v_out_lines) loop
    i := i + 1;
    v_idx     := (ln->>'index')::int;
    v_req_qty := (ln->>'qty')::int;
    v_line_sel := (ln->>'lineSelNet')::bigint;
    begin
      if i < v_n and v_sel_net > 0 then
        v_row_cents := round((v_line_sel::numeric / v_sel_net) * v_refunded);
      else
        v_row_cents := v_refunded - v_allocated; -- last row takes the remainder
      end if;
      if v_row_cents < 0 then
        v_row_cents := 0;
      end if;
      v_allocated := v_allocated + v_row_cents;

      insert into public.pos_refunds
        (store_id, sale_id, line_index, qty, refunded_cents, method, reason, credit_card_id, created_by)
      values
        (v_store, p_sale_id, v_idx, v_req_qty, v_row_cents,
         case when p_as_credit then 'credit' else 'cash' end,
         nullif(btrim(coalesce(p_reason, '')), ''), v_ccard_id, auth.uid());

      -- Restock the refunded line (gift-card lines are value, not stock).
      it := v_items -> v_idx;
      v_name := coalesce(it->>'name', 'item');
      if it->>'productId' ~ '^giftcard:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
        null; -- gift-card value is not inventory; nothing to restock
      elsif it->>'productId' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
        v_pid := (it->>'productId')::uuid;
        update public.pos_products
           set stock = stock + v_req_qty, updated_at = now()
         where id = v_pid and store_id = v_store and track_stock;
        if not found then
          if not exists (select 1 from public.pos_products where id = v_pid and store_id = v_store) then
            v_warnings := v_warnings || jsonb_build_object('line', v_name, 'issue', 'product no longer exists — quantity not restored');
          end if;
        end if;
      end if;

      -- Bouquinerie catalogue item.
      if it->>'bqItemId' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
        v_bqid := (it->>'bqItemId')::uuid;
        v_bqstatus := it->>'bqStatus';
        if v_bqstatus not in ('store', 'fair', 'sorting') then
          v_bqstatus := null; -- old sales did not record it; restore qty only
        end if;
        update public.bq_items
           set qty        = qty + v_req_qty,
               status     = case
                              when status = 'sold' and v_bqstatus is not null then v_bqstatus
                              else status
                            end,
               updated_at = now()
         where id = v_bqid and store_id = v_store;
        if not found then
          v_warnings := v_warnings || jsonb_build_object('line', v_name, 'issue', 'catalogue item no longer exists — quantity not restored');
        elsif v_bqstatus is null then
          v_warnings := v_warnings || jsonb_build_object('line', v_name, 'issue', 'quantity restored but shelf status unknown — verify where the item belongs');
        end if;
      end if;
    exception
      when others then
        v_warnings := v_warnings || jsonb_build_object('line', coalesce(v_name, 'item'), 'issue', 'could not record refund line — ' || sqlerrm);
    end;
  end loop;

  return jsonb_build_object(
    'refund', jsonb_build_object('refundedCents', v_refunded, 'lines', v_out_lines),
    'creditNote', case when v_ccode is null then null
                      else jsonb_build_object('code', v_ccode) end,
    'warnings', v_warnings);
end;
$$;

revoke all on function public.pos_refund_sale(uuid, jsonb, text, boolean) from public, anon;
grant execute on function public.pos_refund_sale(uuid, jsonb, text, boolean) to authenticated;
