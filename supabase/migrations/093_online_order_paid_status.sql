-- 093_online_order_paid_status.sql
-- Add 'paid' as a valid online order status for webhook payment confirmation.
-- Flow: received → paid → preparing → ready → done
-- (paid means customer paid online, shop hasn't started preparing yet)

create or replace function public.online_order_set_status(p_order_id uuid, p_status text)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_status text := lower(btrim(coalesce(p_status, '')));
  o        record;
begin
  -- Webhook calls use service_role (no auth.uid), staff calls use auth.uid
  -- Allow service_role to bypass the signin check for webhook updates
  if auth.uid() is null and current_setting('request.jwt.claims', true)::jsonb->>'role' != 'service_role' then
    raise exception 'ONLINE_NEEDS_SIGNIN';
  end if;
  select id, store_id, status into o
    from public.online_orders where id = p_order_id for update;
  if not found then raise exception 'ONLINE_ORDER_NOT_FOUND'; end if;
  -- Service role (webhook) bypasses membership check; staff still needs it
  if current_setting('request.jwt.claims', true)::jsonb->>'role' != 'service_role' then
    if not public.is_pos_member(o.store_id) then raise exception 'ONLINE_FORBIDDEN'; end if;
  end if;
  if not (
       (o.status = 'received'   and v_status in ('paid', 'preparing', 'ready', 'cancelled'))
    or (o.status = 'paid'       and v_status in ('preparing', 'ready', 'cancelled'))
    or (o.status = 'preparing'  and v_status in ('ready', 'cancelled'))
    or (o.status = 'ready'      and v_status in ('done', 'cancelled'))
  ) then
    raise exception 'ONLINE_BAD_STATUS';
  end if;
  update public.online_orders
     set status = v_status, status_at = now(), updated_at = now()
   where id = p_order_id;
  return public.online_order_json(p_order_id);
end;
$$;
