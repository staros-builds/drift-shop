-- 088_stock_atomic_membership.sql
-- H1: pos_adjust_stock_atomic checked account type but not store membership.
-- A staff user from Store A could adjust Store B's stock. Add membership check.

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
  v_role text;
begin
  if auth.uid() is null then
    raise exception 'sign in to adjust stock';
  end if;

  perform public.require_account_type('full', 'staff');

  -- H1 fix: verify the caller is a member of this store.
  select m.role into v_role
    from public.pos_store_members m
   where m.store_id = p_store_id and m.user_id = auth.uid();
  if v_role is null then
    raise exception 'not a member of this store';
  end if;

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
grant execute on function public.pos_adjust_stock_atomic(uuid, uuid, int) to authenticated;
