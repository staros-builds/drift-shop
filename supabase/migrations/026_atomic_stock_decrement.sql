-- 026_atomic_stock_decrement.sql
--
-- Atomic inventory decrement for completed sales.
--
-- The old flow was client read-then-write: read stock, subtract, write back.
-- Two terminals selling the last copy at the same moment both read 1, both
-- wrote 0 — or worse, interleaved writes lost a decrement entirely. This
-- RPC performs every decrement in ONE transaction with row locks, so
-- concurrent sales serialize and no decrement is ever lost.
--
-- pos_apply_sale_stock(p_store_id, p_lines jsonb)
--   p_lines: [{ "product_id": uuid|null, "bq_item_id": uuid|null,
--               "qty": int, "name": text }]
--   Only lines with a valid id and qty > 0 are applied. Returns
--   { "results": [{ "key": text, "name": text, "stock": int,
--                   "oversold": bool }] } — oversold means the sale took more
--   than was on hand (stock floored at 0); the sale itself stands, but the
--   client surfaces the warning so staff recount instead of silently
--   drifting. Any store member (cashier included) may call it: selling is
--   exactly what cashiers do.
--
-- NOTE: this does not reserve stock at "add to cart" time — it makes the
-- post-sale decrement atomic. Oversell is reported, not prevented; the
-- register must never refuse a completed sale because of a race.

create or replace function public.pos_apply_sale_stock(p_store_id uuid, p_lines jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  ln         jsonb;
  v_qty      int;
  v_pid      uuid;
  v_bqid     uuid;
  v_name     text;
  v_stock    int;
  v_track    boolean;
  v_results  jsonb := '[]'::jsonb;
begin
  if auth.uid() is null then
    raise exception 'sign in to update stock';
  end if;
  if not public.is_pos_member(p_store_id) then
    raise exception 'not a member of this store';
  end if;
  -- Punch-pad devices must never adjust stock directly.
  perform public.require_account_type('full', 'staff', 'pos');

  for ln in select * from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) loop
  begin
    v_qty  := greatest(0, public._safe_int(ln->>'qty', 0));
    v_name := coalesce(ln->>'name', 'item');
    if v_qty = 0 then
      continue;
    end if;

    -- POS catalogue product.
    if ln->>'product_id' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
      v_pid := (ln->>'product_id')::uuid;
      select p.stock, p.track_stock into v_stock, v_track
        from public.pos_products p
       where p.id = v_pid and p.store_id = p_store_id
       for update;
      if found and coalesce(v_track, false) then
        update public.pos_products
           set stock = greatest(0, v_stock - v_qty), updated_at = now()
         where id = v_pid;
        v_results := v_results || jsonb_build_object(
          'key', 'product:' || v_pid::text,
          'name', v_name,
          'stock', greatest(0, v_stock - v_qty),
          'oversold', v_qty > v_stock
        );
      end if;
    end if;

    -- Bouquinerie catalogue item (one-of-a-kind books: hitting 0 marks sold).
    if ln->>'bq_item_id' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
      v_bqid := (ln->>'bq_item_id')::uuid;
      select b.qty into v_stock
        from public.bq_items b
       where b.id = v_bqid and b.store_id = p_store_id
       for update;
      if found then
        update public.bq_items
           set qty = greatest(0, v_stock - v_qty),
               status = case when greatest(0, v_stock - v_qty) = 0 then 'sold' else status end,
               updated_at = now()
         where id = v_bqid;
        v_results := v_results || jsonb_build_object(
          'key', 'bq:' || v_bqid::text,
          'name', v_name,
          'stock', greatest(0, v_stock - v_qty),
          'oversold', v_qty > v_stock
        );
      end if;
    end if;
  exception
    when others then
      v_results := v_results || jsonb_build_object(
        'key', coalesce(ln->>'product_id', ln->>'bq_item_id', 'unknown'),
        'name', coalesce(v_name, 'item'),
        'stock', null,
        'oversold', false,
        'error', sqlerrm
      );
  end;
  end loop;

  return jsonb_build_object('results', v_results);
end;
$$;

revoke all on function public.pos_apply_sale_stock(uuid, jsonb) from public, anon;
grant execute on function public.pos_apply_sale_stock(uuid, jsonb) to authenticated;
