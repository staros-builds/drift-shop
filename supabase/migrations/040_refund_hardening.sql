-- 040_refund_hardening.sql
--
-- Hardens pos_refund_sale against three money-integrity defects found in
-- adversarial review:
--
-- 1. IDEMPOTENCY KEY REUSE WITH CHANGED PAYLOAD. The 035 replay logic
--    returned the original result for any call with a matching key, even
--    if the payload (lines, amounts, credit flag) was different. A caller
--    could accidentally (or maliciously) reuse a key with a different
--    refund and get a silent wrong result. The RPC now stores a SHA-256
--    hash of the normalized request payload alongside the key. On replay,
--    the hash must match exactly; a mismatch raises an exception instead
--    of replaying.
--
-- 2. UNBOUNDED IDEMPOTENCY KEY LENGTH. A caller could send a multi-
--    megabyte key, bloating the index and logs. Keys are now limited to
--    128 characters (validated in the RPC and enforced by a CHECK
--    constraint).
--
-- 3. SEQUENTIAL ROUNDING OVER-REFUND. Each partial refund rounds its
--    proportional share independently. Across multiple partial refunds,
--    the rounded pieces can sum to 1 cent more than the sale total
--    (observed: 5519-cent sale refunded as 2300 + 1150 + 2070 = 5520).
--    The RPC now caps the cumulative refunded total at the sale total:
--    if this refund would push the cumulative sum over, it is reduced to
--    exactly fill the remaining amount (or rejected if nothing remains).

-- Store the payload hash for idempotency verification.
alter table public.pos_refunds
  add column if not exists payload_hash text;

-- Bound idempotency key length (defense in depth: RPC also validates).
alter table public.pos_refunds
  drop constraint if exists pos_refunds_idem_key_length;
alter table public.pos_refunds
  add constraint pos_refunds_idem_key_length
  check (idem_key is null or char_length(idem_key) <= 128);

-- Index the hash for replay lookups (partial: only rows with a key).
drop index if exists public.pos_refunds_idem_hash;
create index pos_refunds_idem_hash
  on public.pos_refunds (sale_id, idem_key)
  where idem_key is not null;

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
  -- 040 additions
  v_idem_key  text;
  v_payload_hash text;
  v_existing_hash text;
  v_cumulative bigint := 0;
  v_already_refunded bigint := 0;
begin
  if auth.uid() is null then
    raise exception 'sign in to refund sales';
  end if;
  perform public.require_account_type('full', 'staff');

  -- Normalize and validate the idempotency key FIRST (before any lock).
  v_idem_key := nullif(btrim(coalesce(p_idem_key, '')), '');
  if v_idem_key is not null and char_length(v_idem_key) > 128 then
    raise exception 'idempotency key too long (max 128 characters)';
  end if;

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

  -- Normalize: sum quantities for duplicate line indexes. Malformed
  -- entries are rejected here, before any write. This ALSO produces the
  -- canonical payload used for the idempotency hash — duplicates are
  -- summed, so key reuse with reordered or duplicated lines still hashes
  -- the same if the effective refund is identical.
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

  -- Compute the payload hash from the NORMALIZED request: sorted
  -- aggregated lines + credit flag + sale id. Identical effective
  -- requests hash identically; any material change hashes differently.
  v_payload_hash := encode(
    digest(
      p_sale_id::text || '|' ||
      (select string_agg(agg.key || ':' || (agg.value->>'qty'), ',' order by agg.key)
         from jsonb_each(v_agg) agg) || '|' ||
      coalesce(p_as_credit, false)::text,
      'sha256'),
    'hex');

  -- Idempotency replay: a retry with the same key AND same payload hash
  -- gets the original result back. Same key with a DIFFERENT hash is a
  -- programming error — reject loudly instead of replaying silently.
  if v_idem_key is not null then
    select r.payload_hash into v_existing_hash
      from public.pos_refunds r
     where r.sale_id = p_sale_id and r.idem_key = v_idem_key
     limit 1;
    if found then
      if v_existing_hash is distinct from v_payload_hash then
        raise exception 'idempotency key was already used with a different refund request';
      end if;
      -- Hashes match: replay the original result.
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
                                 and r2.idem_key = v_idem_key
                               limit 1),
               'warnings', '[]'::jsonb)
        into ln
        from public.pos_refunds r
       where r.sale_id = p_sale_id and r.idem_key = v_idem_key;
      return ln;
    end if;
  end if;

  -- The proportional denominator: net over ALL sale lines.
  for it in select * from jsonb_array_elements(v_items) loop
    v_sub := v_sub + (
      public._safe_int(it->>'priceCents', 0)::bigint
        * greatest(1, public._safe_int(it->>'qty', 0))
      - public._safe_int(it->>'itemDiscountCents', 0));
  end loop;

  -- Pass 1: validate every aggregated line and accumulate selected net.
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

  -- 040: Cumulative cap. Sum all prior refunds for this sale; if this
  -- refund would push the total over the sale total, clamp it to the
  -- remaining amount. If nothing remains, reject.
  select coalesce(sum(r.refunded_cents), 0) into v_already_refunded
    from public.pos_refunds r
   where r.sale_id = p_sale_id;
  if v_already_refunded >= v_total then
    raise exception 'sale has already been fully refunded';
  end if;
  if v_already_refunded + v_refunded > v_total then
    v_refunded := v_total - v_already_refunded;
    v_warnings := v_warnings || jsonb_build_object(
      'issue', 'refund amount reduced to avoid exceeding the sale total');
  end if;

  -- "To credit": issue gift card as store credit (same transaction).
  if p_as_credit and v_refunded > 0 then
    select c.code, c.id into v_ccode, v_ccard_id
      from public.pos_giftcard_issue(
        v_store, v_refunded::int, 'Refund #' || v_number::text) c;
  end if;

  -- Pass 2: write refund rows (per-line cents with remainder on last row)
  -- and restock. Refund-row inserts are NOT wrapped: any failure aborts.
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
       credit_card_id, created_by, idem_key, payload_hash)
    values
      (v_store, p_sale_id, v_idx, v_req_qty, v_row_cents,
       case when p_as_credit then 'credit' else 'cash' end,
       nullif(btrim(coalesce(p_reason, '')), ''), v_ccard_id, auth.uid(),
       v_idem_key, v_payload_hash);

    -- Restock the refunded line (gift-card lines are value, not stock).
    it := v_items -> v_idx;
    v_name := coalesce(it->>'name', 'item');
    if it->>'productId' ~ '^giftcard:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
      null;
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

  return jsonb_build_object(
    'refund', jsonb_build_object('refundedCents', v_refunded, 'lines', v_out_lines),
    'creditNote', case when v_ccode is null then null
                      else jsonb_build_object('code', v_ccode) end,
    'warnings', v_warnings);
end;
$$;

revoke all on function public.pos_refund_sale(uuid, jsonb, text, boolean, text) from public, anon;
grant execute on function public.pos_refund_sale(uuid, jsonb, text, boolean, text) to authenticated;
