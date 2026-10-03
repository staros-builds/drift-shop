-- 103_backup_coverage_import.sql
--
-- Backup/restore coverage for tables that exportStore/importStore missed:
--   - online_order_items  (line items of online orders; the orders were
--     backed up but their items were not — a real data-loss gap)
--   - online_customers / shop_customers (customer account links)
--   - pos_stock_applications (stock idempotency dedup keys)
--
-- All three write paths are blocked by RLS for direct client writes, so
-- restore goes through these manager-only SECURITY DEFINER RPCs, following
-- the pos_giftcard_import (028) / pos_punch_history_import (010) pattern.
--
-- Idempotent: safe to re-run. Merge-only: existing rows are never
-- overwritten or deleted.

-- ---------------------------------------------------------------------------
-- 0. online_orders import (headers; items are step 1 below)
--
-- The export has captured online_orders since migration 071, but no import
-- path ever existed — a restored shop lost its entire online order history
-- despite the backup comment promising otherwise. This RPC closes that gap.
-- ---------------------------------------------------------------------------
create or replace function public.pos_online_orders_import(
  p_store_id uuid, p_orders jsonb
)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_role   text;
  o        jsonb;
  v_id     uuid;
  v_ins    int := 0;
  v_skip   int := 0;
  v_num    int;
begin
  if auth.uid() is null then
    raise exception 'sign in to import online orders';
  end if;
  select m.role into v_role
    from public.pos_store_members m
   where m.store_id = p_store_id and m.user_id = auth.uid();
  if v_role not in ('owner', 'manager') then
    raise exception 'only managers can import online orders';
  end if;
  perform public.require_account_type('full', 'staff');

  for o in select * from jsonb_array_elements(coalesce(p_orders, '[]'::jsonb)) loop
    -- Idempotent on idempotency_key (the order's stable identity), else id.
    v_id := null;
    if btrim(coalesce(o->>'idempotency_key', '')) <> '' then
      select id into v_id from public.online_orders
       where store_id = p_store_id
         and idempotency_key = btrim(o->>'idempotency_key');
    end if;
    if v_id is null and (o->>'id') ~ '^[0-9a-fA-F-]{36}$' then
      select id into v_id from public.online_orders
       where store_id = p_store_id and id = (o->>'id')::uuid;
    end if;
    if v_id is not null then
      v_skip := v_skip + 1;
      continue;
    end if;
    v_num := public._safe_int(o->>'number', 0);
    -- Preserve the backup's UUID when valid so order items remap cleanly;
    -- otherwise the row gets a fresh ID.
    if (o->>'id') ~ '^[0-9a-fA-F-]{36}$'
       and not exists (select 1 from public.online_orders where id = (o->>'id')::uuid) then
      v_id := (o->>'id')::uuid;
    else
      v_id := gen_random_uuid();
    end if;
    insert into public.online_orders (
      id, store_id, online_customer_id, pos_customer_id, number, status,
      customer_name, customer_phone, pickup_note,
      subtotal_cents, tax_cents, total_cents, tax_lines,
      sale_id, idempotency_key, placed_at, status_at
    ) values (
      v_id, p_store_id,
      (o->>'online_customer_id')::uuid,
      (o->>'pos_customer_id')::uuid,
      v_num,
      coalesce(nullif(btrim(o->>'status'), ''), 'placed'),
      nullif(btrim(coalesce(o->>'customer_name', '')), ''),
      nullif(btrim(coalesce(o->>'customer_phone', '')), ''),
      nullif(btrim(coalesce(o->>'pickup_note', '')), ''),
      public._safe_int(o->>'subtotal_cents', 0),
      public._safe_int(o->>'tax_cents', 0),
      public._safe_int(o->>'total_cents', 0),
      coalesce(o->'tax_lines', '[]'::jsonb),
      (o->>'sale_id')::uuid,
      nullif(btrim(coalesce(o->>'idempotency_key', '')), ''),
      coalesce((o->>'placed_at')::timestamptz, now()),
      coalesce((o->>'status_at')::timestamptz, now())
    );
    v_ins := v_ins + 1;
  end loop;
  return jsonb_build_object('inserted', v_ins, 'skipped', v_skip);
end;
$$;

revoke all on function public.pos_online_orders_import(uuid, jsonb) from public, anon;
grant execute on function public.pos_online_orders_import(uuid, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 1. online_order_items import
-- ---------------------------------------------------------------------------
create or replace function public.pos_online_order_items_import(
  p_store_id uuid, p_items jsonb
)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_role      text;
  it          jsonb;
  v_order_id  uuid;
  v_ins       int := 0;
  v_skip      int := 0;
begin
  if auth.uid() is null then
    raise exception 'sign in to import order items';
  end if;
  select m.role into v_role
    from public.pos_store_members m
   where m.store_id = p_store_id and m.user_id = auth.uid();
  if v_role not in ('owner', 'manager') then
    raise exception 'only managers can import order items';
  end if;
  perform public.require_account_type('full', 'staff');

  for it in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    -- The order must belong to this store; dangling items are skipped.
    select o.id into v_order_id
      from public.online_orders o
     where o.id = (it->>'order_id')::uuid
       and o.store_id = p_store_id;
    if v_order_id is null then
      v_skip := v_skip + 1;
      continue;
    end if;
    -- Skip when an identical line already exists (idempotent re-import).
    if exists (
      select 1 from public.online_order_items i
       where i.order_id = v_order_id
         and i.product_id is not distinct from (it->>'product_id')::uuid
         and i.name = coalesce(it->>'name', '')
         and i.qty = public._safe_int(it->>'qty', 0)
         and i.unit_price_cents = public._safe_int(it->>'unit_price_cents', 0)
    ) then
      v_skip := v_skip + 1;
      continue;
    end if;
    insert into public.online_order_items
      (order_id, product_id, name, qty, unit_price_cents, line_total_cents)
    values (
      v_order_id,
      (it->>'product_id')::uuid,
      coalesce(it->>'name', ''),
      public._safe_int(it->>'qty', 0),
      public._safe_int(it->>'unit_price_cents', 0),
      public._safe_int(it->>'line_total_cents', 0)
    );
    v_ins := v_ins + 1;
  end loop;
  return jsonb_build_object('inserted', v_ins, 'skipped', v_skip);
end;
$$;

revoke all on function public.pos_online_order_items_import(uuid, jsonb) from public, anon;
grant execute on function public.pos_online_order_items_import(uuid, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. customer link import (online_customers + shop_customers)
--
-- user_id references auth.users: only links whose user still exists are
-- restored; others are skipped (reported) rather than failing the import.
-- pos_customer_id is remapped through the import batch when the linked
-- pos_customers row survived, else nulled.
-- ---------------------------------------------------------------------------
create or replace function public.pos_customer_links_import(
  p_store_id uuid, p_online jsonb, p_shop jsonb, p_customer_ids jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_role      text;
  c           jsonb;
  v_uid       uuid;
  v_ins_o     int := 0;
  v_skip_o    int := 0;
  v_ins_s     int := 0;
  v_skip_s    int := 0;
  v_pos_id    uuid;
begin
  if auth.uid() is null then
    raise exception 'sign in to import customer links';
  end if;
  select m.role into v_role
    from public.pos_store_members m
   where m.store_id = p_store_id and m.user_id = auth.uid();
  if v_role not in ('owner', 'manager') then
    raise exception 'only managers can import customer links';
  end if;
  perform public.require_account_type('full', 'staff');

  -- online_customers
  for c in select * from jsonb_array_elements(coalesce(p_online, '[]'::jsonb)) loop
    v_uid := (c->>'user_id')::uuid;
    -- The auth user must still exist, else the FK would fail.
    if v_uid is null or not exists (select 1 from auth.users u where u.id = v_uid) then
      v_skip_o := v_skip_o + 1;
      continue;
    end if;
    if exists (
      select 1 from public.online_customers oc
       where oc.store_id = p_store_id and oc.user_id = v_uid
    ) then
      v_skip_o := v_skip_o + 1;
      continue;
    end if;
    v_pos_id := (c->>'pos_customer_id')::uuid;
    -- Keep the POS link only when that customer row is in this store.
    if v_pos_id is not null and not exists (
      select 1 from public.pos_customers pc
       where pc.id = v_pos_id and pc.store_id = p_store_id
    ) then
      v_pos_id := null;
    end if;
    -- Also accept remapped IDs passed in p_customer_ids (old->new map).
    if v_pos_id is not null and p_customer_ids ? (c->>'pos_customer_id') then
      v_pos_id := (p_customer_ids->>(c->>'pos_customer_id'))::uuid;
    end if;
    insert into public.online_customers
      (store_id, user_id, pos_customer_id, display_name, phone)
    values (
      p_store_id, v_uid, v_pos_id,
      nullif(btrim(coalesce(c->>'display_name', '')), ''),
      nullif(btrim(coalesce(c->>'phone', '')), '')
    );
    v_ins_o := v_ins_o + 1;
  end loop;

  -- shop_customers
  for c in select * from jsonb_array_elements(coalesce(p_shop, '[]'::jsonb)) loop
    v_uid := (c->>'user_id')::uuid;
    if v_uid is null or not exists (select 1 from auth.users u where u.id = v_uid) then
      v_skip_s := v_skip_s + 1;
      continue;
    end if;
    if exists (
      select 1 from public.shop_customers sc
       where sc.store_id = p_store_id and sc.user_id = v_uid
    ) then
      v_skip_s := v_skip_s + 1;
      continue;
    end if;
    insert into public.shop_customers (store_id, user_id, display_name)
    values (
      p_store_id, v_uid,
      nullif(btrim(coalesce(c->>'display_name', '')), '')
    );
    v_ins_s := v_ins_s + 1;
  end loop;

  return jsonb_build_object(
    'online_inserted', v_ins_o, 'online_skipped', v_skip_o,
    'shop_inserted', v_ins_s, 'shop_skipped', v_skip_s
  );
end;
$$;

revoke all on function public.pos_customer_links_import(uuid, jsonb, jsonb, jsonb) from public, anon;
grant execute on function public.pos_customer_links_import(uuid, jsonb, jsonb, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. pos_stock_applications import (idempotency dedup keys)
-- ---------------------------------------------------------------------------
create or replace function public.pos_stock_applications_import(
  p_store_id uuid, p_rows jsonb
)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_role text;
  r      jsonb;
  v_key  text;
  v_ins  int := 0;
  v_skip int := 0;
begin
  if auth.uid() is null then
    raise exception 'sign in to import stock applications';
  end if;
  select m.role into v_role
    from public.pos_store_members m
   where m.store_id = p_store_id and m.user_id = auth.uid();
  if v_role not in ('owner', 'manager') then
    raise exception 'only managers can import stock applications';
  end if;
  perform public.require_account_type('full', 'staff');

  for r in select * from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) loop
    v_key := btrim(coalesce(r->>'idempotency_key', ''));
    if v_key = '' then
      v_skip := v_skip + 1;
      continue;
    end if;
    insert into public.pos_stock_applications
      (store_id, idempotency_key, sale_id, results, applied_at)
    values (
      p_store_id, v_key,
      (r->>'sale_id')::uuid,
      coalesce(r->'results', '{}'::jsonb),
      coalesce((r->>'applied_at')::timestamptz, now())
    )
    on conflict (store_id, idempotency_key) do nothing;
    if found then v_ins := v_ins + 1; else v_skip := v_skip + 1; end if;
  end loop;
  return jsonb_build_object('inserted', v_ins, 'skipped', v_skip);
end;
$$;

revoke all on function public.pos_stock_applications_import(uuid, jsonb) from public, anon;
grant execute on function public.pos_stock_applications_import(uuid, jsonb) to authenticated;
