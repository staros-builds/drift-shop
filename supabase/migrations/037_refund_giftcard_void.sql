-- 037: Fix gift-card double-spend on refund.
--
-- BUG: When a gift card is sold, pos_giftcard_issue creates the card (with
-- value) and the sale records a line with productId 'giftcard:<uuid>'.
-- pos_refund_sale treated this as "value, not inventory" and did NOTHING —
-- so refunding the sale gave cash/credit AND left the gift card with its
-- full value. Buy $50 card → refund for $50 cash → still have $50 card.
--
-- FIX: When refunding a gift-card purchase line, the card is voided in the
-- same transaction. The line's refund is capped at the card's current
-- balance (a partially-spent card refunds only what's left). If the card
-- is already inactive, no void is needed. If the card is gone, warn.
--
-- This replaces the 035 version of pos_refund_sale entirely.

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
  v_sub       bigint := 0;
  v_sel_net   bigint := 0;
  v_refunded  bigint := 0;
  v_out_lines jsonb := '[]'::jsonb;
  v_agg       jsonb := '{}'::jsonb;
  v_ccode     text := null;
  v_ccard_id  uuid := null;
  v_void_cards jsonb := '[]'::jsonb; -- gift cards to void: [{id, balance, code}]
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
  v_gcard_id  uuid;
  v_gcard_bal int;
  v_gcard_status text;
  v_gcard_code text;
  v_gc        jsonb;
begin
  if auth.uid() is null then
    raise exception 'sign in to refund sales';
  end if;
  perform public.require_account_type('full', 'staff');

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

  for it in select * from jsonb_array_elements(v_items) loop
    v_sub := v_sub + (
      public._safe_int(it->>'priceCents', 0)::bigint
        * greatest(1, public._safe_int(it->>'qty', 0))
      - public._safe_int(it->>'itemDiscountCents', 0));
  end loop;

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
    v_name := coalesce(it->>'name', 'item');

    -- Gift-card purchase line: the card must be voided, otherwise the
    -- customer keeps the value AND gets the refund (double-spend).
    -- Cap the refund at the card's current balance.
    if it->>'productId' ~ '^giftcard:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
      v_gcard_id := substring(it->>'productId' from '^giftcard:(.*)$')::uuid;
      select c.balance_cents, c.status, c.code
        into v_gcard_bal, v_gcard_status, v_gcard_code
        from public.pos_gift_cards c
       where c.id = v_gcard_id and c.store_id = v_store
       for update;
      if not found then
        v_warnings := v_warnings || jsonb_build_object(
          'line', v_name, 'issue', 'gift card not found — refund proceeds, no card to void');
      elsif v_gcard_status <> 'active' then
        -- Card already void/expired: no value left, no double-spend.
        null;
      else
        if v_line_sel > v_gcard_bal then
          v_warnings := v_warnings || jsonb_build_object(
            'line', v_name, 'issue',
            'card was partially used — refund capped at remaining balance ' || v_gcard_bal::text || '¢');
          v_line_sel := v_gcard_bal;
        end if;
        v_void_cards := v_void_cards || jsonb_build_object(
          'id', v_gcard_id, 'balance', v_gcard_bal, 'code', v_gcard_code);
      end if;
    end if;

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

  if p_as_credit and v_refunded > 0 then
    select c.code, c.id into v_ccode, v_ccard_id
      from public.pos_giftcard_issue(
        v_store, v_refunded::int, 'Refund #' || v_number::text) c;
  end if;

  v_n := jsonb_array_length(v_out_lines);
  for ln in select * from jsonb_array_elements(v_out_lines) loop
    i := i + 1;
    v_idx      := (ln->>'index')::int;
    v_req_qty  := (ln->>'qty')::int;
    v_line_sel := (ln->>'lineSelNet')::bigint;
    if i < v_n and v_sel_net > 0 then
      v_row_cents := round((v_line_sel::numeric / v_sel_net) * v_refunded);
    else
      v_row_cents := v_refunded - v_allocated;
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

    it := v_items -> v_idx;
    v_name := coalesce(it->>'name', 'item');
    if it->>'productId' ~ '^giftcard:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
      null; -- handled by the void loop below; not inventory
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

    if it->>'bqItemId' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
      v_bqid := (it->>'bqItemId')::uuid;
      v_bqstatus := it->>'bqStatus';
      if v_bqstatus not in ('store', 'fair', 'sorting') then
        v_bqstatus := null;
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

  -- Void the gift cards from refunded purchase lines. Same transaction:
  -- if anything above failed, the cards stay untouched.
  for v_gc in select * from jsonb_array_elements(v_void_cards) loop
    update public.pos_gift_cards
       set status = 'void', balance_cents = 0, updated_at = now()
     where id = (v_gc->>'id')::uuid;
    insert into public.pos_gift_card_events
      (store_id, card_id, kind, amount_cents, balance_after_cents, actor)
    values
      (v_store, (v_gc->>'id')::uuid, 'voided',
       (v_gc->>'balance')::int, 0, auth.uid());
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
