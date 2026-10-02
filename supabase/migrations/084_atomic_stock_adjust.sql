-- 084_atomic_stock_adjust.sql
-- M9: Atomic stock adjustment to replace racy read-modify-write.
--
-- pos_adjust_stock_atomic(p_product_id, p_store_id, p_delta) atomically
-- adjusts stock without a separate read, eliminating the race where two
-- concurrent adjustments could overwrite each other.

create or replace function public.pos_adjust_stock_atomic(
  p_product_id uuid,
  p_store_id uuid,
  p_delta int
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_new_stock int;
begin
  if auth.uid() is null then
    raise exception 'sign in to adjust stock';
  end if;

  perform public.require_account_type('full', 'staff');

  -- Atomic update: the database handles the arithmetic, no read needed.
  update public.pos_products
     set stock = greatest(0, stock + p_delta),
         updated_at = now()
   where id = p_product_id and store_id = p_store_id
  returning stock into v_new_stock;

  if not found then
    raise exception 'product not found';
  end if;

  return jsonb_build_object('product_id', p_product_id, 'new_stock', v_new_stock);
end;
$$;

revoke all on function public.pos_adjust_stock_atomic(uuid, uuid, int) from public, anon;
