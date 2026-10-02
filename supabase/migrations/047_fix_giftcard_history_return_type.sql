-- Migration 047: Fix pos_giftcard_history return type
--
-- The function's RETURNS TABLE declared sale_number as integer, but
-- pos_sales.number is bigint. PostgreSQL rejects the query with:
--   "structure of query does not match function result type"
-- This broke gift-card history loading in the POS (void workflow untestable).
--
-- Return type cannot be changed via CREATE OR REPLACE — must drop first.

drop function if exists public.pos_giftcard_history(uuid);

create function public.pos_giftcard_history(p_card_id uuid)
returns table (kind text, amount_cents integer, balance_after_cents integer, created_at timestamptz, sale_number bigint)
language plpgsql security definer
set search_path = public
as $$
declare
  v_store uuid;
begin
  if auth.uid() is null then
    raise exception 'sign in to view gift card history';
  end if;
  select c.store_id into v_store from public.pos_gift_cards c where c.id = p_card_id;
  if not found then
    raise exception 'gift card not found';
  end if;
  if not public.is_pos_member(v_store) then
    raise exception 'not a member of this store';
  end if;
  -- Punch-pad device sessions must never touch gift-card value.
  perform public.require_account_type('full', 'staff', 'pos');
  return query
    select e.kind, e.amount_cents, e.balance_after_cents, e.created_at, s.number
      from public.pos_gift_card_events e
      left join public.pos_sales s on s.id = e.sale_id
     where e.card_id = p_card_id
     order by e.created_at asc;
end;
$$;

revoke all on function public.pos_giftcard_history(uuid) from public, anon;
grant execute on function public.pos_giftcard_history(uuid) to authenticated;
