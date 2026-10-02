-- 085_fix_giftcard_void_restore.sql
-- Fixes 083: pos_giftcard_redemptions does not exist. Redemptions live in
-- pos_gift_card_events (kind='redeemed'). Also restores the gift-card
-- SOLD-line void branch that 083 deleted (prevents double-spend).

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
  v_evt      record;
  v_new_bal  int;
  v_gcid     uuid;
  v_gcbalance int;
  v_gcinitial int;
  v_gcstatus  text;
begin
  if auth.uid() is null then
    raise exception 'sign in to void sales';
  end if;

  perform public.require_account_type('full', 'staff');

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

  -- H4 (fixed): Restore gift-card balances for redemptions linked to this sale.
  -- Redemptions are recorded in pos_gift_card_events with kind='redeemed'.
  -- Guard against double-credit: skip if a matching 'credited' event exists.
  for v_evt in
    select e.card_id, e.amount_cents
      from public.pos_gift_card_events e
     where e.sale_id = p_sale_id
       and e.kind = 'redeemed'
       and not exists (
         select 1 from public.pos_gift_card_events c
          where c.sale_id = p_sale_id and c.kind = 'credited'
            and c.card_id = e.card_id and c.amount_cents = e.amount_cents)
  loop
  begin
    update public.pos_gift_cards
       set balance_cents = balance_cents + v_evt.amount_cents
     where id = v_evt.card_id and store_id = v_store
    returning balance_cents into v_new_bal;
    if not found then
      raise exception 'gift card % not found', v_evt.card_id;
    end if;
    insert into public.pos_gift_card_events
      (store_id, card_id, kind, amount_cents, balance_after_cents, sale_id, actor)
    values (v_store, v_evt.card_id, 'credited', v_evt.amount_cents, v_new_bal, p_sale_id, auth.uid());
  exception
    when others then
      v_warnings := v_warnings || jsonb_build_object(
        'line', 'gift card',
        'issue', 'could not restore gift card balance — ' || sqlerrm
      );
  end;
  end loop;

  -- Restock each line (existing logic from 083, plus restored gift-card SOLD branch).
  for it in select * from jsonb_array_elements(v_items) loop
  begin
    v_qty  := greatest(0, public._safe_int(it->>'qty', 0));
    v_name := coalesce(it->>'name', 'item');
    if v_qty = 0 then
      continue;
    end if;

    -- Gift-card sale line: void the card itself when untouched. A used card
    -- keeps its remaining balance — voiding it would destroy customer money.
    -- (Restored from 028; 083 dropped this branch.)
    if it->>'productId' ~ '^giftcard:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
      v_gcid := split_part(it->>'productId', ':', 2)::uuid;
      select c.balance_cents, c.initial_cents, c.status
        into v_gcbalance, v_gcinitial, v_gcstatus
        from public.pos_gift_cards c
       where c.id = v_gcid and c.store_id = v_store
       for update;
      if not found then
        v_warnings := v_warnings || jsonb_build_object('line', v_name, 'issue', 'gift card record missing — verify manually');
      elsif v_gcstatus = 'void' then
        null; -- already void; nothing to do
      elsif v_gcbalance = v_gcinitial then
        update public.pos_gift_cards set status = 'void', balance_cents = 0 where id = v_gcid;
        insert into public.pos_gift_card_events (store_id, card_id, kind, amount_cents, balance_after_cents, sale_id, actor)
        values (v_store, v_gcid, 'voided', v_gcinitial, 0, p_sale_id, auth.uid());
      else
        v_warnings := v_warnings || jsonb_build_object('line', v_name, 'issue', 'card was already used — its remaining balance stays valid; handle manually');
      end if;
      continue;
    end if;

    if it->>'productId' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
      v_pid := (it->>'productId')::uuid;
      update public.pos_products
         set stock = stock + v_qty, updated_at = now()
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
