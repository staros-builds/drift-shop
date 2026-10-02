-- 035_refund_atomicity.sql
--
-- Hardens pos_refund_sale (created in 034) against three money-integrity
-- defects found in adversarial review:
--
-- 1. DUPLICATE LINE INDEXES. A forged request could list the same
--    line_index twice; each entry was validated only against persisted
--    earlier refunds, so the second copy slipped past the remaining-qty
--    check and the sale could be over-refunded. The request is now
--    normalized first: quantities for the same line_index are summed, and
--    the summed quantity is validated once against what remains.
--
-- 2. SWALLOWED PERSISTENCE FAILURES. Pass 2 wrapped every refund-row
--    insert in `exception when others` and converted failures into
--    warnings — a failed insert could roll back one line's subtransaction
--    while the RPC kept going, and (worse) the store-credit gift card was
--    issued BEFORE the per-line loop, so credit could exist without
--    matching refund rows. Refund-row inserts are no longer wrapped: any
--    persistence failure aborts the whole transaction, and the gift card
--    rolls back with it. Restock "not found" cases (product/catalogue
--    item deleted after the sale) stay as warnings — the refund itself is
--    still valid — but genuine SQL errors propagate and abort.
--
-- 3. NO IDEMPOTENCY. A retry, double submit or racing duplicate request
--    could create a second refund for the same intent. The RPC now takes
--    an optional p_idem_key: the first call stores it on its refund rows,
--    and any later call with the same key on the same sale replays the
--    original result instead of writing new rows. A partial unique index
--    on (sale_id, idem_key, line_index) makes the race window impossible
--    even under concurrency (the sale-row lock already serializes callers).

alter table public.pos_refunds
  add column if not exists idem_key text;

-- Idempotency is per (sale, key, line): a multi-line refund writes one
-- row per line sharing the same key, so the unique index must include
-- line_index. (An earlier draft keyed only (sale_id, idem_key) and
-- rejected the second row of any multi-line refund.)
drop index if exists public.pos_refunds_idem;
create unique index pos_refunds_idem
  on public.pos_refunds (sale_id, idem_key, line_index)
  where idem_key is not null;

-- Drop the 034 4-argument overload so the new 5-argument signature (with
-- its p_idem_key default) is the only candidate — no ambiguity for
-- PostgREST or direct callers.
drop function if exists public.pos_refund_sale(uuid, jsonb, text, boolean);

create or replace function public.pos_refund_sale(
  p_sale_id uuid, p_lines jsonb, p_reason text default '',
  p_as_credit boolean default false, p_idem_key text default null
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
  v_agg       jsonb := '{}'::jsonb; -- line_index -> {index, qty} (duplicates summed)
  v_ccode     text := null;  -- store-credit gift card code
  v_ccard_id  uuid := null;
  ln          jsonb;
  kv          record;
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

  -- Idempotency replay: a retry with the same key on the same sale gets
  -- the original result back instead of a second refund. The unique index
  -- on (sale_id, idem_key) plus the sale-row lock above close the race.
  if p_idem_key is not null and btrim(p_idem_key) <> ''
     and exists (select 1 from public.pos_refunds r
                  where r.sale_id = p_sale_id and r.idem_key = p_idem_key) then
    select jsonb_build_object(
             'refund', jsonb_build_object(
               'refundedCents', coalesce(sum(r.refunded_cents), 0),
               'lines', coalesce(jsonb_agg(
                 jsonb_build_object('index', r.line_index, 'qty', r.qty)
                 order by r.line_index), '[]'::jsonb),
               'duplicate', true),
             'creditNote', (select jsonb_build_object('code', g.code)
                              from public.pos_refunds r2
                              join public.pos_gift_cards g on g.id = r2.credit_card_id
                             where r2.sale_id = p_sale_id
                               and r2.idem_key = p_idem_key
                             limit 1),
             'warnings', '[]'::jsonb)
      into ln
      from public.pos_refunds r
     where r.sale_id = p_sale_id and r.idem_key = p_idem_key;
    return ln;
  end if;

  -- Normalize: sum quantities for duplicate line indexes so a forged
  -- request can never slip the same line past the remaining-qty check
  -- twice. Malformed entries are rejected here, before any write.
  for ln in select * from jsonb_array_elements(p_lines) loop
    v_idx     := public._safe_int(ln->>'index', -1);
    v_req_qty := public._safe_int(ln->>'qty', 0);
    if v_idx < 0 or v_idx >= jsonb_array_length(v_items) then
      raise exception 'refund line % is not on this sale', v_idx;
    end if;
    if v_req_qty <= 0 then
      raise exception 'refund quantity must be positive';
    end if;
    if v_agg ? v_idx::text then
      v_agg := jsonb_set(v_agg, array[v_idx::text, 'qty'],
        to_jsonb(((v_agg->v_idx::text->>'qty')::int) + v_req_qty));
    else
      v_agg := v_agg || jsonb_build_object(v_idx::text,
        jsonb_build_object('index', v_idx, 'qty', v_req_qty));
    end if;
  end loop;

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

  -- Pass 1: validate every aggregated line and accumulate the selected
  -- net. Mirrors the UI estimate exactly: netOf = price*qty -
  -- itemDiscount, selectedNet = round((netOf/qty) * refundQty), refund =
  -- round((selectedNet/sub) * totalCents). Any failure aborts before any
  -- write or credit issuance.
  for kv in select * from jsonb_each(v_agg) loop
    ln := kv.value;
    v_idx     := (ln->>'index')::int;
    v_req_qty := (ln->>'qty')::int;
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
  -- Issued inside the same transaction: any later failure rolls it back,
  -- so credit can never exist without its matching refund rows.
  if p_as_credit and v_refunded > 0 then
    select c.code, c.id into v_ccode, v_ccard_id
      from public.pos_giftcard_issue(
        v_store, v_refunded::int, 'Refund #' || v_number::text) c;
  end if;

  -- Pass 2: write refund rows (per-line cents allocated with the rounding
  -- remainder on the last row so the rows sum to exactly v_refunded) and
  -- restock. Refund-row inserts are NOT wrapped in exception handlers: a
  -- persistence failure aborts the entire RPC and rolls back the gift
  -- card above. Only "product no longer exists" restock cases become
  -- warnings — the refund itself stays valid.
  v_n := jsonb_array_length(v_out_lines);
  for ln in select * from jsonb_array_elements(v_out_lines) loop
    i := i + 1;
    v_idx      := (ln->>'index')::int;
    v_req_qty  := (ln->>'qty')::int;
    v_line_sel := (ln->>'lineSelNet')::bigint;
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
      (store_id, sale_id, line_index, qty, refunded_cents, method, reason,
       credit_card_id, created_by, idem_key)
    values
      (v_store, p_sale_id, v_idx, v_req_qty, v_row_cents,
       case when p_as_credit then 'credit' else 'cash' end,
       nullif(btrim(coalesce(p_reason, '')), ''), v_ccard_id, auth.uid(),
       nullif(btrim(coalesce(p_idem_key, '')), ''));

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
  end loop;

  return jsonb_build_object(
    'refund', jsonb_build_object('refundedCents', v_refunded, 'lines', v_out_lines),
    'creditNote', case when v_ccode is null then null
                      else jsonb_build_object('code', v_ccode) end,
    'warnings', v_warnings);
end;
$$;

revoke all on function public.pos_refund_sale(uuid, jsonb, text, boolean, text) from public, anon;
grant execute on function public.pos_refund_sale(uuid, jsonb, text, boolean, text) to authenticated;
