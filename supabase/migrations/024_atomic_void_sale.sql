-- 024_atomic_void_sale.sql
--
-- One-transaction void: marking the sale voided and restocking inventory
-- must succeed or fail TOGETHER. The old client flow marked the sale voided
-- first and restocked afterwards, so a failed restock (or a crash in
-- between) left a voided sale with wrong inventory. It also never restored
-- Bouquinerie catalogue quantities at all.
--
-- pos_void_sale(p_sale_id, p_reason) — SECURITY DEFINER, owner/manager only:
--   1. Locks the sale row (FOR UPDATE): concurrent voids serialize here,
--      so a double-click or retry can never restock twice.
--   2. Raises 'sale is already voided' if it was voided first — the caller
--      must surface that instead of silently succeeding.
--   3. Marks the sale voided (voided, voided_at, voided_by, void_reason).
--   4. Restocks pos_products lines (track_stock only) and bq_items lines
--      (qty plus pre-sale status, recorded on the sale line as bqStatus).
--   5. Returns { voided: true, warnings: [...] }. A line that cannot be
--      restocked (product deleted since the sale, corrupt line data) is
--      reported as a warning — the void itself still commits, because the
--      sale genuinely happened and the books must say so. Staff reconcile
--      the warning instead of inventory silently drifting.

-- Safe helpers (defined here because 024 is the first migration that uses
-- _safe_int; 026 and 028 also use these. CREATE OR REPLACE is idempotent.)
create or replace function public._safe_timestamptz(p_text text)
returns timestamptz
language plpgsql immutable
set search_path = public
as $$
begin
  if p_text is null or btrim(p_text) = '' then
    return null;
  end if;
  return p_text::timestamptz;
exception when others then
  return null;
end;
$$;

create or replace function public._safe_int(p_text text, p_default int)
returns int
language plpgsql immutable
set search_path = public
as $$
begin
  if p_text is null or btrim(p_text) = '' then
    return p_default;
  end if;
  return btrim(p_text)::int;
exception when others then
  return p_default;
end;
$$;

revoke all on function public._safe_timestamptz(text) from public, anon;
grant execute on function public._safe_timestamptz(text) to authenticated;
revoke all on function public._safe_int(text, int) from public, anon;
grant execute on function public._safe_int(text, int) to authenticated;

create or replace function public.pos_void_sale(p_sale_id uuid, p_reason text default '')
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_store    uuid;
  v_items    jsonb;
  v_role     text;
  v_warnings jsonb := '[]'::jsonb;
  it         jsonb;
  v_qty      int;
  v_pid      uuid;
  v_bqid     uuid;
  v_bqstatus text;
  v_name     text;
begin
  if auth.uid() is null then
    raise exception 'sign in to void sales';
  end if;

  -- Device accounts can never void, even if a membership row were
  -- misconfigured with a manager role: the account type is the hard
  -- boundary, membership is only the second check.
  perform public.require_account_type('full', 'staff');

  -- Lock the sale row: concurrent voids serialize here.
  select s.store_id, coalesce(s.items, '[]'::jsonb)
    into v_store, v_items
    from public.pos_sales s
   where s.id = p_sale_id
   for update;
  if not found then
    raise exception 'sale not found';
  end if;

  select m.role into v_role
    from public.pos_store_members m
   where m.store_id = v_store and m.user_id = auth.uid();
  if v_role is null then
    raise exception 'not a member of this store';
  end if;
  if v_role not in ('owner', 'manager') then
    raise exception 'only managers can void sales';
  end if;

  if (select s.voided from public.pos_sales s where s.id = p_sale_id) then
    raise exception 'sale is already voided';
  end if;

  update public.pos_sales
     set voided      = true,
         voided_at   = now(),
         voided_by   = auth.uid(),
         void_reason = nullif(btrim(coalesce(p_reason, '')), '')
   where id = p_sale_id;

  -- Restock each line. A per-line exception handler isolates corrupt lines
  -- (bad UUID text, deleted product) as warnings; the transaction — void
  -- mark plus every healthy restock — stays atomic.
  for it in select * from jsonb_array_elements(v_items) loop
  begin
    v_qty  := greatest(0, public._safe_int(it->>'qty', 0));
    v_name := coalesce(it->>'name', 'item');
    if v_qty = 0 then
      continue;
    end if;

    -- POS catalogue product (uuid text guarded: garbage becomes a warning,
    -- never an abort).
    if it->>'productId' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
      v_pid := (it->>'productId')::uuid;
      update public.pos_products
         set stock = stock + v_qty, updated_at = now()
       where id = v_pid and store_id = v_store and track_stock;
      if not found then
        -- Product deleted or stock-tracking off: nothing to restock.
        -- (Stock-tracking-off products never decremented, so warn only when
        -- the product itself is gone.)
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
         set qty        = qty + v_qty,
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
      v_warnings := v_warnings || jsonb_build_object('line', coalesce(v_name, 'item'), 'issue', 'could not restock — ' || sqlerrm);
  end;
  end loop;

  return jsonb_build_object('voided', true, 'warnings', v_warnings);
end;
$$;

revoke all on function public.pos_void_sale(uuid, text) from public, anon;
grant execute on function public.pos_void_sale(uuid, text) to authenticated;
