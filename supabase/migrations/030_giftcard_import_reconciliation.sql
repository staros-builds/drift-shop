-- 030_giftcard_import_reconciliation.sql
--
-- Fix: pos_giftcard_import could leave a card's stored balance_cents
-- disagreeing with its imported ledger history (e.g. card said 500, last
-- ledger event said 0). Normal gift-card operations maintain the invariant
--   card.balance_cents = last_event.balance_after_cents
-- atomically; the import must restore it too.
--
-- Reconciliation policy (ledger wins):
--   * After importing a card's events, if any non-'issued' events were
--     imported for that card, set the card's balance_cents to the latest
--     event's balance_after_cents (by created_at, id tiebreak).
--   * If no non-issued events were imported, the supplied card balance
--     stands (the ledger holds only the replayed issuance).
--   * Void cards always stay at 0.
--
-- The import report gains a `balances_reconciled` count so a restore can
-- surface when ledger truth overrode a supplied card balance.

create or replace function public.pos_giftcard_import(
  p_store_id uuid, p_cards jsonb, p_events jsonb, p_sale_remap jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_role      text;
  c           jsonb;
  e           jsonb;
  v_old_id    text;
  v_new_id    uuid;
  v_code      text;
  v_initial   int;
  v_balance   int;
  v_status    text;
  v_card_map  jsonb := '{}'::jsonb;
  v_cards_ins int := 0;
  v_cards_skip int := 0;
  v_events_ins int := 0;
  v_events_skip int := 0;
  v_reconciled int := 0;
  v_sale_id   uuid;
  v_last_bal  int;
  r_map       record;
begin
  if auth.uid() is null then
    raise exception 'sign in to import gift cards';
  end if;
  select m.role into v_role
    from public.pos_store_members m
   where m.store_id = p_store_id and m.user_id = auth.uid();
  if v_role not in ('owner', 'manager') then
    raise exception 'only managers can import gift cards';
  end if;
  perform public.require_account_type('full', 'staff');

  for c in select * from jsonb_array_elements(coalesce(p_cards, '[]'::jsonb)) loop
    v_old_id := c->>'id';
    v_code := btrim(coalesce(c->>'code', ''));
    if v_code = '' then continue; end if;
    select gc.id into v_new_id
      from public.pos_gift_cards gc
     where gc.store_id = p_store_id and gc.code = v_code;
    if v_new_id is not null then
      v_cards_skip := v_cards_skip + 1;
      -- Card already exists: its history is already in the ledger. Do NOT
      -- map its old ID, so events for it are skipped below. Replaying them
      -- would duplicate ledger entries (especially events without stable
      -- UUIDs, which get fresh random IDs on every import).
    else
      v_initial := greatest(1, public._safe_int(c->>'initial_cents', 1));
      v_balance := greatest(0, public._safe_int(c->>'balance_cents', 0));
      v_status := case when c->>'status' = 'void' then 'void' else 'active' end;
      if v_status = 'void' then v_balance := 0; end if;
      -- Strict UUID format check: the loose [0-9a-fA-F-]{36} pattern accepts
      -- malformed strings (e.g. all dashes) that fail the ::uuid cast.
      if (c->>'id') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
         and not exists (select 1 from public.pos_gift_cards where id = (c->>'id')::uuid) then
        v_new_id := (c->>'id')::uuid;
      else
        v_new_id := gen_random_uuid();
      end if;
      insert into public.pos_gift_cards
            (id, store_id, code, initial_cents, balance_cents, note, status, sold_at, created_at)
      values (v_new_id, p_store_id, v_code, v_initial, v_balance,
              coalesce(c->>'note', ''), v_status,
              coalesce(public._safe_timestamptz(c->>'sold_at'), now()),
              coalesce(public._safe_timestamptz(c->>'created_at'), now()));
      -- Replay issuance so the ledger stays append-only and truthful.
      insert into public.pos_gift_card_events
            (store_id, card_id, kind, amount_cents, balance_after_cents, created_at)
      values (p_store_id, v_new_id, 'issued', v_initial, v_initial,
              coalesce(public._safe_timestamptz(c->>'created_at'), now()));
      v_cards_ins := v_cards_ins + 1;
      if v_old_id is not null then
        v_card_map := v_card_map || jsonb_build_object(v_old_id, v_new_id::text);
      end if;
    end if;
  end loop;

  for e in select * from jsonb_array_elements(coalesce(p_events, '[]'::jsonb)) loop
    if (e->>'kind') = 'issued' then continue; end if; -- replayed above
    if (e->>'kind') not in ('redeemed', 'credited', 'voided') then continue; end if;
    if (e->>'card_id') is null then continue; end if;
    begin
      v_new_id := (v_card_map ->> (e->>'card_id'))::uuid;
    exception when others then
      continue;
    end;
    if v_new_id is null then continue; end if;
    if (e->>'id') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
       and exists (select 1 from public.pos_gift_card_events where id = (e->>'id')::uuid) then
      v_events_skip := v_events_skip + 1;
      continue;
    end if;
    -- Resolve sale_id: prefer the remap, else use the UUID only if it
    -- actually exists in this store. A dangling reference becomes NULL
    -- (not an FK violation that aborts the import).
    v_sale_id := null;
    if p_sale_remap ? coalesce(e->>'sale_id', '') then
      begin
        v_sale_id := (p_sale_remap ->> (e->>'sale_id'))::uuid;
      exception when others then
        v_sale_id := null;
      end;
    elsif (e->>'sale_id') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
      if exists (select 1 from public.pos_sales s where s.id = (e->>'sale_id')::uuid and s.store_id = p_store_id) then
        v_sale_id := (e->>'sale_id')::uuid;
      end if;
    end if;
    insert into public.pos_gift_card_events
          (id, store_id, card_id, kind, amount_cents, balance_after_cents, sale_id, created_at)
    values (
      case when (e->>'id') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then (e->>'id')::uuid else gen_random_uuid() end,
      p_store_id, v_new_id, e->>'kind',
      greatest(1, public._safe_int(e->>'amount_cents', 1)),
      greatest(0, public._safe_int(e->>'balance_after_cents', 0)),
      v_sale_id,
      coalesce(public._safe_timestamptz(e->>'created_at'), now()));
    v_events_ins := v_events_ins + 1;
  end loop;

  -- Reconcile: the ledger is the append-only source of truth. For every
  -- card inserted above that received non-issued events, set its stored
  -- balance to the latest event's balance_after_cents so the card and its
  -- history can never disagree after a restore. Cards with only the
  -- replayed issuance keep their supplied balance. Void cards stay at 0.
  for r_map in select key as old_id, value as new_id_text from jsonb_each_text(v_card_map) loop
    begin
      v_new_id := r_map.new_id_text::uuid;
    exception when others then
      continue;
    end;
    select e.balance_after_cents into v_last_bal
      from public.pos_gift_card_events e
     where e.card_id = v_new_id
       and e.kind <> 'issued'
     order by e.created_at desc, e.id desc
     limit 1;
    if found then
      update public.pos_gift_cards gc
         set balance_cents = v_last_bal
       where gc.id = v_new_id
         and gc.status <> 'void'
         and gc.balance_cents is distinct from v_last_bal;
      if found then
        v_reconciled := v_reconciled + 1;
      end if;
    end if;
  end loop;

  return jsonb_build_object(
    'cards_inserted', v_cards_ins, 'cards_skipped', v_cards_skip,
    'events_inserted', v_events_ins, 'events_skipped', v_events_skip,
    'balances_reconciled', v_reconciled);
end;
$$;

revoke all on function public.pos_giftcard_import(uuid, jsonb, jsonb, jsonb) from public, anon;
grant execute on function public.pos_giftcard_import(uuid, jsonb, jsonb, jsonb) to authenticated;
