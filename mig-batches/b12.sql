-- BATCH b12

-- ===== FILE: supabase/migrations/035_*.sql ======
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

-- ===== FILE: supabase/migrations/036_*.sql ======
-- 036_require_account_type_fail_closed.sql
--
-- Security hardening: public.require_account_type() was fail-OPEN for
-- callers with no profile row (or a NULL account_type).
--
--   if not public.caller_account_type() = any (p_allowed) then raise ...
--
-- When caller_account_type() returns NULL, `NULL = any (...)` is NULL,
-- `not NULL` is NULL, and PL/pgSQL treats `IF NULL` as false — so the
-- exception was never raised and a NULL-type caller sailed through every
-- account-type gate (refunds, voids, gift cards, stock, punch, ...).
-- The comment above caller_account_type() says "fail closed", but the
-- code did the opposite.
--
-- The fixed version raises unless the caller's type is non-null AND in
-- the allowed list. Legitimate callers always have a non-null
-- account_type ('full', 'staff', 'pos', 'punch'), so behavior is unchanged
-- for them; only previously-silent NULL callers are now blocked.

create or replace function public.require_account_type(variadic p_allowed text[])
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_type text := public.caller_account_type();
begin
  if v_type is null or not (v_type = any (p_allowed)) then
    raise exception 'account type % cannot perform this action',
      coalesce(v_type, 'unknown');
  end if;
end;
$$;

-- ===== FILE: supabase/migrations/037_*.sql ======
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

-- ===== FILE: supabase/migrations/038_*.sql ======
-- 038: Fix pay-period lock bypass in pos_punch_correct.
--
-- BUG: pos_punch_correct checked only the OLD punch_in date against locked
-- pay periods. A manager could move a punch INTO a locked period by changing
-- its date (e.g., Sept 28 -> Sept 15 where Sept 1-15 is approved/locked).
-- The check must cover the new dates as well.
--
-- FIX: Check old punch_in, new punch_in, AND new punch_out against locked
-- periods. If any of them falls in a locked period, reject.

create or replace function public.pos_punch_correct(
  p_punch_id uuid, p_punch_in timestamptz, p_punch_out timestamptz
)
returns table (id uuid, staff_id uuid, punch_in timestamptz, punch_out timestamptz)
language plpgsql security definer
set search_path = public
as $$
declare
  v_store_id  uuid;
  v_staff_id  uuid;
  v_old_in    timestamptz;
  v_old_out   timestamptz;
begin
  if auth.uid() is null then
    raise exception 'sign in to correct punches';
  end if;
  select p.store_id, p.staff_id, p.punch_in, p.punch_out
  into v_store_id, v_staff_id, v_old_in, v_old_out
  from public.pos_time_punches p
  where p.id = p_punch_id
  limit 1;
  if not found then
    raise exception 'punch not found';
  end if;
  if not public.pos_role(v_store_id) in ('owner', 'manager') then
    raise exception 'managers only';
  end if;
  -- Lock check covers old AND new dates: moving a punch into (or out of)
  -- a locked period is forbidden.
  if exists (
    select 1 from public.pos_pay_periods pp
    where pp.store_id = v_store_id
      and pp.status = 'approved'
      and ((v_old_in::date) between pp.from_date and pp.to_date
           or (p_punch_in::date) between pp.from_date and pp.to_date
           or (p_punch_out::date) between pp.from_date and pp.to_date)
  ) then
    raise exception 'Pay period is locked.';
  end if;
  if p_punch_out is not null and p_punch_out <= p_punch_in then
    raise exception 'punch out must be after punch in';
  end if;
  insert into public.pos_punch_audits
    (store_id, punch_id, action, edited_by, old_punch_in, old_punch_out, new_punch_in, new_punch_out)
  values
    (v_store_id, p_punch_id, 'correct', auth.uid(),
     v_old_in, v_old_out, p_punch_in, p_punch_out);
  update public.pos_time_punches
  set punch_in = p_punch_in, punch_out = p_punch_out
  where pos_time_punches.id = p_punch_id;
  return query select p_punch_id, v_staff_id, p_punch_in, p_punch_out;
end $$;

-- ===== FILE: supabase/migrations/039_*.sql ======
-- Migration 039: Fix live pos_clock_out (s.staff_id bug)
-- The live pos_clock_out has "select s.id, s.staff_id, s.name" which fails
-- because pos_staff has no staff_id column. Replace with the correct 033 version.

create or replace function public.pos_clock_out(p_store_id uuid, p_pin_hash text)
returns table (id uuid, staff_id uuid, staff_name text, punch_in timestamptz, punch_out timestamptz)
language plpgsql security definer
set search_path = public
as $$
declare
  v_staff_id   uuid;
  v_staff_name text;
  v_punch_id   uuid;
  v_punch_in   timestamptz;
  v_punch_out  timestamptz;
begin
  if auth.uid() is null then
    raise exception 'sign in to punch out';
  end if;
  if not public.is_pos_member(p_store_id) then
    raise exception 'not a member of this store';
  end if;
  perform public.pos_pin_throttle_check(p_store_id);
  -- Registers don't punch: only punch pads and the desktop may clock out.
  perform public.require_account_type('full', 'staff', 'punch');
  select s.id, s.name into v_staff_id, v_staff_name
  from public.pos_staff s
  where s.store_id = p_store_id and s.active and s.pin_hash = p_pin_hash
  limit 1;
  if not found then
    -- Failed PIN: log it and return an empty set (see pos_clock_in).
    insert into public.pos_pin_attempts (store_id, success)
    values (p_store_id, false);
    return;
  end if;
  -- Success resets the failure counter for the store.
  delete from public.pos_pin_attempts
   where store_id = p_store_id and not success;
  select p.id, p.punch_in into v_punch_id, v_punch_in
  from public.pos_time_punches p
  where p.store_id = p_store_id and p.staff_id = v_staff_id and p.punch_out is null
  limit 1
  for update;
  if not found then
    raise exception 'not punched in';
  end if;
  update public.pos_time_punches
  set punch_out = now()
  where pos_time_punches.id = v_punch_id and pos_time_punches.punch_out is null
  returning pos_time_punches.punch_out into v_punch_out;
  if not found then
    raise exception 'not punched in';
  end if;
  -- An open break ends with the shift: close it at clock-out time so it
  -- neither inflates paid-break totals nor blocks the next break.
  update public.pos_breaks
  set "end" = v_punch_out
  where pos_breaks.staff_id = v_staff_id and pos_breaks."end" is null;
  return query select v_punch_id, v_staff_id, v_staff_name, v_punch_in, v_punch_out;
end $$;
