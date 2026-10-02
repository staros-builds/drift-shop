-- 071_customer_orders.sql — Customer accounts + online ordering
-- (renumbered at the final merge; simultaneous draft numbers from
-- several feature branches now run 067-078).
--
-- Customer accounts + online ordering for published storefronts.
--
-- Model (Jesse's requirement): the customer signs up / signs in with an
-- EMAIL on the shop's public website (no traditional usernames on the
-- storefront — same rule as staff signup). One login opens the shop's
-- page: the customer browses as a guest, signs in to order, and sees
-- "My orders" in plain words. Orders land in the shop's POS as an
-- "Online orders" inbox; a cashier accepts/prepares/completes them, and
-- converts a completed pickup to a real sale with one tap — stock is
-- decremented EXACTLY once (by pos_apply_sale_stock, the same atomic
-- function the till uses), and the sale shows in History and Reports with
-- channel = 'online'.
--
-- What is deliberately NOT here (honest, by design):
-- - Guest checkout: every order ties to an authenticated auth user.
--   Anonymous order spam is a moderation nightmare the shop can't
--   staff; the contract says customers log in to shop.
-- - Online payment: pay-at-pickup is the honest default. Card payment
--   arrives with the payments workstream; we DO NOT fake it. The
--   converted sale records 'cash' or 'card' like a normal till sale.
-- - Stock is NOT decremented at order time: it is checked at order time
--   (out-of-stock lines are rejected with the product name) and
--   decremented once at convert-to-sale, so a cancelled order never
--   leaves phantom deductions.
-- - customer prices are snapshotted at order time: a later price change
--   never rewrites what the customer agreed to.

-- ---------------------------------------------------------------------------
-- 1. Storefront switches: online ordering toggle + pickup note.
-- ---------------------------------------------------------------------------
alter table public.storefront_profiles
  add column if not exists online_ordering boolean not null default false;
alter table public.storefront_profiles
  add column if not exists ordering_note text;

comment on column public.storefront_profiles.online_ordering is
  'When true, signed-in customers can place online orders on the published storefront.';
comment on column public.storefront_profiles.ordering_note is
  'Plain-words pickup/preparation note shown on the storefront (e.g. "Usually ready in 2 hours.").';

-- Per-shop customer-facing order counter (mirrors pos_stores.sale_seq).
alter table public.pos_stores
  add column if not exists online_order_seq bigint not null default 0;

-- ---------------------------------------------------------------------------
-- 2. online_customers: one row per (shop, auth user).
-- ---------------------------------------------------------------------------
create table if not exists public.online_customers (
  id             uuid primary key default gen_random_uuid(),
  store_id       uuid not null references public.pos_stores(id) on delete cascade,
  user_id        uuid not null references auth.users(id) on delete cascade,
  pos_customer_id uuid references public.pos_customers(id) on delete set null,
  display_name   text,
  phone          text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (store_id, user_id)
);
create index if not exists online_customers_store on public.online_customers (store_id);
create index if not exists online_customers_user on public.online_customers (user_id);

alter table public.online_customers enable row level security;

-- A customer sees their own profile(s); shop staff see their own shop's.
drop policy if exists online_customers_select on public.online_customers;
create policy online_customers_select on public.online_customers
  for select to authenticated
  using (user_id = auth.uid() or public.is_pos_member(store_id));

-- Profiles are written through the RPCs below (validated, membership
-- checked); no direct insert/update/delete policy for anyone.
grant select on public.online_customers to authenticated;

-- ---------------------------------------------------------------------------
-- 3. online_orders + online_order_items.
-- ---------------------------------------------------------------------------
create table if not exists public.online_orders (
  id                 uuid primary key default gen_random_uuid(),
  store_id           uuid not null references public.pos_stores(id) on delete cascade,
  online_customer_id uuid not null references public.online_customers(id) on delete cascade,
  pos_customer_id    uuid references public.pos_customers(id) on delete set null,
  number             int not null,
  status             text not null default 'received'
                       check (status in ('received', 'preparing', 'ready', 'done', 'cancelled')),
  customer_name      text,
  customer_phone     text,
  pickup_note        text,
  subtotal_cents     int not null default 0,
  tax_cents          int not null default 0,
  total_cents        int not null default 0,
  tax_lines          jsonb not null default '[]'::jsonb,
  sale_id            uuid references public.pos_sales(id) on delete set null,
  idempotency_key    text,
  placed_at          timestamptz not null default now(),
  status_at          timestamptz not null default now(),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (store_id, number),
  unique (store_id, idempotency_key)
);
create index if not exists online_orders_store_status on public.online_orders (store_id, status, placed_at desc);
create index if not exists online_orders_customer on public.online_orders (online_customer_id, placed_at desc);

create table if not exists public.online_order_items (
  id               uuid primary key default gen_random_uuid(),
  order_id         uuid not null references public.online_orders(id) on delete cascade,
  product_id       uuid references public.pos_products(id) on delete set null,
  name             text not null,
  qty              int not null check (qty between 1 and 999),
  unit_price_cents int not null check (unit_price_cents >= 0),
  line_total_cents int not null check (line_total_cents >= 0),
  created_at       timestamptz not null default now()
);
create index if not exists online_order_items_order on public.online_order_items (order_id);

alter table public.online_orders enable row level security;
alter table public.online_order_items enable row level security;

-- Orders/items are read-only for clients: written only through the RPCs.
-- A customer sees ONLY their own orders; shop staff see their shop's.
drop policy if exists online_orders_select on public.online_orders;
create policy online_orders_select on public.online_orders
  for select to authenticated
  using (
    public.is_pos_member(store_id)
    or exists (
      select 1 from public.online_customers c
      where c.id = online_orders.online_customer_id
        and c.user_id = auth.uid()
    )
  );

drop policy if exists online_order_items_select on public.online_order_items;
create policy online_order_items_select on public.online_order_items
  for select to authenticated
  using (
    exists (
      select 1 from public.online_orders o
      where o.id = online_order_items.order_id
    )
  );

grant select on public.online_orders to authenticated;
grant select on public.online_order_items to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Server-side tax mirror of src/lib/taxMath.js taxLinesFor().
--    Stacked rows apply to the pre-tax subtotal; a row flagged compound
--    applies to the subtotal plus the tax rows above it. Empty stacked
--    list falls back to the store's legacy single tax_rate.
-- ---------------------------------------------------------------------------
create or replace function public.online_order_tax_lines(p_store_id uuid, p_subtotal int)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_tax_rate  numeric;
  v_rates     jsonb;
  r           record;
  v_rate      numeric;
  v_compound  boolean;
  v_prior     int := 0;
  v_tax       int := 0;
  v_base      int;
  v_cents     int;
  v_lines     jsonb := '[]'::jsonb;
begin
  select s.tax_rate, s.tax_rates into v_tax_rate, v_rates
    from public.pos_stores s where s.id = p_store_id;
  if v_rates is null or jsonb_typeof(v_rates) <> 'array' or jsonb_array_length(v_rates) = 0 then
    v_rates := jsonb_build_array(jsonb_build_object('name', 'Tax', 'rate', coalesce(v_tax_rate, 0)));
  end if;
  for r in select value from jsonb_array_elements(v_rates) loop
    v_rate := greatest(0, coalesce((r.value->>'rate')::numeric, 0));
    v_compound := coalesce((r.value->>'compound')::boolean, false);
    if v_rate > 0 then
      v_base := p_subtotal + (case when v_compound then v_prior else 0 end);
      v_cents := round(v_base * v_rate / 100)::int;
      v_tax := v_tax + v_cents;
      v_prior := v_prior + v_cents;
      v_lines := v_lines || jsonb_build_object(
        'name', coalesce(nullif(r.value->>'name', ''), 'Tax'),
        'rate', v_rate,
        'cents', v_cents,
        'compound', v_compound
      );
    end if;
  end loop;
  return jsonb_build_object('lines', v_lines, 'total', v_tax);
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Shared helpers (private — no grant; called by the RPCs below).
-- ---------------------------------------------------------------------------
-- Resolve the published, ordering-enabled shop for a public slug.
-- Raises ONLINE_SHOP_NOT_FOUND / ONLINE_ORDERING_OFF on failure.
create or replace function public.online_store_for_slug(p_slug text)
returns uuid
language plpgsql security definer
set search_path = public
as $$
declare
  v_store_id uuid;
  v_enabled  boolean;
begin
  select sp.store_id, sp.online_ordering into v_store_id, v_enabled
    from public.storefront_profiles sp
   where sp.slug = lower(btrim(p_slug)) and sp.published = true;
  if v_store_id is null then
    raise exception 'ONLINE_SHOP_NOT_FOUND';
  end if;
  if not coalesce(v_enabled, false) then
    raise exception 'ONLINE_ORDERING_OFF';
  end if;
  return v_store_id;
end;
$$;
revoke all on function public.online_store_for_slug(text) from public, anon, authenticated;

-- Ensure the caller's per-shop customer profile; link/create the matching
-- pos_customers directory row so the shop's POS customer list grows
-- automatically when a customer orders.
create or replace function public.online_customer_ensure(p_store_id uuid, p_name text, p_phone text)
returns uuid
language plpgsql security definer
set search_path = public
as $$
declare
  v_uid       uuid := auth.uid();
  v_email     text;
  v_cust_id   uuid;
  v_pos_id    uuid;
  v_name      text := nullif(btrim(coalesce(p_name, '')), '');
  v_phone     text := nullif(btrim(coalesce(p_phone, '')), '');
begin
  if v_uid is null then
    raise exception 'ONLINE_NEEDS_SIGNIN';
  end if;
  if v_name is null then
    raise exception 'ONLINE_NAME_REQUIRED';
  end if;
  select u.email into v_email from auth.users u where u.id = v_uid;

  select oc.id, oc.pos_customer_id into v_cust_id, v_pos_id
    from public.online_customers oc
   where oc.store_id = p_store_id and oc.user_id = v_uid;
  if v_cust_id is null then
    insert into public.online_customers (store_id, user_id, display_name, phone)
      values (p_store_id, v_uid, v_name, v_phone)
      returning id into v_cust_id;
  else
    update public.online_customers
       set display_name = coalesce(display_name, v_name),
           phone = coalesce(phone, v_phone),
           updated_at = now()
     where id = v_cust_id;
  end if;

  -- Link (or create) the POS customer directory row.
  if v_pos_id is null then
    select pc.id into v_pos_id
      from public.pos_customers pc
     where pc.store_id = p_store_id
       and v_email is not null and lower(pc.email) = lower(v_email)
     limit 1;
    if v_pos_id is null then
      insert into public.pos_customers (store_id, name, phone, email)
        values (p_store_id, v_name, v_phone, v_email)
        returning id into v_pos_id;
    end if;
    update public.online_customers set pos_customer_id = v_pos_id where id = v_cust_id;
  end if;
  return v_cust_id;
end;
$$;
revoke all on function public.online_customer_ensure(uuid, text, text) from public, anon, authenticated;

-- Serialize one order (order + items) for clients.
create or replace function public.online_order_json(p_order_id uuid)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v jsonb;
begin
  select jsonb_build_object(
      'id', o.id,
      'store_id', o.store_id,
      'number', o.number,
      'status', o.status,
      'customer_name', o.customer_name,
      'customer_phone', o.customer_phone,
      'pickup_note', o.pickup_note,
      'subtotal_cents', o.subtotal_cents,
      'tax_cents', o.tax_cents,
      'total_cents', o.total_cents,
      'tax_lines', o.tax_lines,
      'sale_id', o.sale_id,
      'placed_at', o.placed_at,
      'status_at', o.status_at,
      'items', coalesce((
        select jsonb_agg(jsonb_build_object(
            'id', i.id,
            'product_id', i.product_id,
            'name', i.name,
            'qty', i.qty,
            'unit_price_cents', i.unit_price_cents,
            'line_total_cents', i.line_total_cents
          ) order by i.created_at)
        from public.online_order_items i where i.order_id = o.id
      ), '[]'::jsonb)
    ) into v
    from public.online_orders o where o.id = p_order_id;
  return v;
end;
$$;
revoke all on function public.online_order_json(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 6. Customer RPCs (granted to authenticated only).
-- ---------------------------------------------------------------------------
create or replace function public.online_profile_get(p_slug text)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_store_id uuid;
  v_uid      uuid := auth.uid();
  v          jsonb;
begin
  if v_uid is null then raise exception 'ONLINE_NEEDS_SIGNIN'; end if;
  select sp.store_id into v_store_id
    from public.storefront_profiles sp
   where sp.slug = lower(btrim(p_slug)) and sp.published = true;
  if v_store_id is null then raise exception 'ONLINE_SHOP_NOT_FOUND'; end if;
  select jsonb_build_object(
      'display_name', oc.display_name,
      'phone', oc.phone
    ) into v
    from public.online_customers oc
   where oc.store_id = v_store_id and oc.user_id = v_uid;
  return v;
end;
$$;
grant execute on function public.online_profile_get(text) to authenticated;

create or replace function public.online_profile_save(p_slug text, p_name text, p_phone text)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_store_id uuid;
  v_uid      uuid := auth.uid();
  v_cust_id  uuid;
begin
  if v_uid is null then raise exception 'ONLINE_NEEDS_SIGNIN'; end if;
  select sp.store_id into v_store_id
    from public.storefront_profiles sp
   where sp.slug = lower(btrim(p_slug)) and sp.published = true;
  if v_store_id is null then raise exception 'ONLINE_SHOP_NOT_FOUND'; end if;
  v_cust_id := public.online_customer_ensure(v_store_id, p_name, p_phone);
  return jsonb_build_object('ok', true);
end;
$$;
grant execute on function public.online_profile_save(text, text, text) to authenticated;

-- Place an order. EVERYTHING is re-derived from the database:
-- products, prices, stock and taxes are never taken from the client.
-- Stable error codes (client maps them to plain words):
--   ONLINE_NEEDS_SIGNIN, ONLINE_SHOP_NOT_FOUND, ONLINE_ORDERING_OFF,
--   ONLINE_BAD_ITEMS, ONLINE_NAME_REQUIRED, ONLINE_ITEM_UNAVAILABLE,
--   ONLINE_OUT_OF_STOCK, ONLINE_TOO_MANY_ORDERS
create or replace function public.online_order_place(
  p_slug text, p_items jsonb, p_pickup_note text, p_name text, p_phone text,
  p_idempotency_key text)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_store_id  uuid;
  v_uid       uuid := auth.uid();
  v_cust_id   uuid;
  v_pos_id    uuid;
  v_name      text := nullif(btrim(coalesce(p_name, '')), '');
  v_phone     text := nullif(btrim(coalesce(p_phone, '')), '');
  v_note      text := nullif(btrim(coalesce(p_pickup_note, '')), '');
  v_key       text := nullif(btrim(coalesce(p_idempotency_key, '')), '');
  v_lines     jsonb := '[]'::jsonb;
  it          record;
  v_pid       uuid;
  v_qty       int;
  v_prior_qty int := 0;
  v_prod      record;
  v_subtotal  int := 0;
  v_taxobj    jsonb;
  v_total     int;
  v_number    int;
  v_order_id  uuid;
  v_recent    int;
begin
  if v_uid is null then raise exception 'ONLINE_NEEDS_SIGNIN'; end if;
  v_store_id := public.online_store_for_slug(p_slug);

  -- Idempotent retry: a repeated call with the same key returns the
  -- original order instead of a second order. Scoped to the CALLER
  -- (merge-round fix): an idempotency key must never become a way to
  -- read another customer's order.
  if v_key is not null then
    select o.id into v_order_id
      from public.online_orders o
      join public.online_customers c on c.id = o.online_customer_id
     where o.store_id = v_store_id and o.idempotency_key = v_key
       and c.user_id = v_uid;
    if v_order_id is not null then
      return public.online_order_json(v_order_id);
    end if;
  end if;

  -- Order spam sanity: at most 5 orders per customer per shop per 10 min.
  select count(*) into v_recent
    from public.online_orders o
    join public.online_customers c on c.id = o.online_customer_id
   where o.store_id = v_store_id and c.user_id = v_uid
     and o.placed_at > now() - interval '10 minutes';
  if v_recent >= 5 then raise exception 'ONLINE_TOO_MANY_ORDERS'; end if;

  -- Validate the item list: array, 1..50 lines, uuid product ids,
  -- integer qty clamped to 1..999.
  if p_items is null or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) < 1 or jsonb_array_length(p_items) > 50 then
    raise exception 'ONLINE_BAD_ITEMS';
  end if;

  v_cust_id := public.online_customer_ensure(v_store_id, v_name, v_phone);
  select oc.pos_customer_id into v_pos_id
    from public.online_customers oc where oc.id = v_cust_id;

  for it in select value from jsonb_array_elements(p_items) loop
    begin
      v_pid := (it.value->>'product_id')::uuid;
    exception when others then
      raise exception 'ONLINE_BAD_ITEMS';
    end;
    v_qty := public._safe_int(it.value->>'qty', 0);
    if v_qty < 1 or v_qty > 999 then raise exception 'ONLINE_BAD_ITEMS'; end if;

    select p.id, p.name, p.price_cents, p.active, p.public_visible,
           p.track_stock, coalesce(p.stock, 0) as stock
      into v_prod
      from public.pos_products p
     where p.id = v_pid and p.store_id = v_store_id
     for update;
    if not found or not coalesce(v_prod.active, true)
       or coalesce(v_prod.public_visible, true) = false then
      raise exception 'ONLINE_ITEM_UNAVAILABLE';
    end if;
    -- Duplicate lines for one product share the same on-hand stock:
    -- check the CUMULATIVE quantity, not each line in isolation.
    v_prior_qty := (
      select coalesce(sum((l->>'qty')::int), 0)
        from jsonb_array_elements(v_lines) l
       where (l->>'product_id') = v_prod.id::text
    );
    if coalesce(v_prod.track_stock, false) and v_prod.stock < v_qty + v_prior_qty then
      -- One plain code; the client asks the shop for the product name
      -- from its own price book. (Names are NOT trusted from the client.)
      raise exception 'ONLINE_OUT_OF_STOCK';
    end if;

    v_subtotal := v_subtotal + (greatest(0, coalesce(v_prod.price_cents, 0)) * v_qty);
    v_lines := v_lines || jsonb_build_object(
      'product_id', v_prod.id,
      'name', v_prod.name,
      'qty', v_qty,
      'unit_price_cents', greatest(0, coalesce(v_prod.price_cents, 0)),
      'line_total_cents', greatest(0, coalesce(v_prod.price_cents, 0)) * v_qty
    );
  end loop;

  -- Taxes, exactly like the till's taxLinesFor().
  v_taxobj := public.online_order_tax_lines(v_store_id, v_subtotal);
  v_total := v_subtotal + ((v_taxobj->>'total')::int);

  -- Per-shop order number.
  update public.pos_stores
     set online_order_seq = coalesce(online_order_seq, 0) + 1
   where id = v_store_id
   returning online_order_seq into v_number;

  -- Two concurrent first-calls with the same key: one wins the INSERT,
  -- the loser gets the idempotent return instead of a raw
  -- unique_violation (merge-round fix).
  begin
    insert into public.online_orders (
        store_id, online_customer_id, pos_customer_id, number,
        customer_name, customer_phone, pickup_note,
        subtotal_cents, tax_cents, total_cents, tax_lines, idempotency_key
      ) values (
        v_store_id, v_cust_id, v_pos_id, v_number,
        v_name, v_phone, v_note,
        v_subtotal, (v_taxobj->>'total')::int, v_total, v_taxobj->'lines', v_key
      )
      returning id into v_order_id;
  exception when unique_violation then
    if v_key is null then raise; end if;
    select o.id into v_order_id
      from public.online_orders o
      join public.online_customers c on c.id = o.online_customer_id
     where o.store_id = v_store_id and o.idempotency_key = v_key
       and c.user_id = v_uid;
    if v_order_id is null then raise; end if;
    return public.online_order_json(v_order_id);
  end;

  for it in select value from jsonb_array_elements(v_lines) loop
    insert into public.online_order_items (
        order_id, product_id, name, qty, unit_price_cents, line_total_cents
      ) values (
        v_order_id,
        (it.value->>'product_id')::uuid,
        it.value->>'name',
        (it.value->>'qty')::int,
        (it.value->>'unit_price_cents')::int,
        (it.value->>'line_total_cents')::int
      );
  end loop;

  return public.online_order_json(v_order_id);
end;
$$;
grant execute on function public.online_order_place(text, jsonb, text, text, text, text) to authenticated;

create or replace function public.online_order_my_orders(p_slug text)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_store_id uuid;
  v_uid      uuid := auth.uid();
  v_cust_id  uuid;
begin
  if v_uid is null then raise exception 'ONLINE_NEEDS_SIGNIN'; end if;
  select sp.store_id into v_store_id
    from public.storefront_profiles sp
   where sp.slug = lower(btrim(p_slug)) and sp.published = true;
  if v_store_id is null then raise exception 'ONLINE_SHOP_NOT_FOUND'; end if;
  select oc.id into v_cust_id
    from public.online_customers oc
   where oc.store_id = v_store_id and oc.user_id = v_uid;
  if v_cust_id is null then return '[]'::jsonb; end if;
  return coalesce((
    select jsonb_agg(public.online_order_json(o.id) order by o.placed_at desc)
      from public.online_orders o
     where o.online_customer_id = v_cust_id
  ), '[]'::jsonb);
end;
$$;
grant execute on function public.online_order_my_orders(text) to authenticated;

create or replace function public.online_order_cancel(p_order_id uuid)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v     record;
begin
  if v_uid is null then raise exception 'ONLINE_NEEDS_SIGNIN'; end if;
  select o.id, o.status, c.user_id into v
    from public.online_orders o
    join public.online_customers c on c.id = o.online_customer_id
   where o.id = p_order_id
   for update of o;
  if not found then raise exception 'ONLINE_ORDER_NOT_FOUND'; end if;
  if v.user_id <> v_uid then raise exception 'ONLINE_FORBIDDEN'; end if;
  if v.status <> 'received' then raise exception 'ONLINE_BAD_STATUS'; end if;
  update public.online_orders
     set status = 'cancelled', status_at = now(), updated_at = now()
   where id = p_order_id;
  return public.online_order_json(p_order_id);
end;
$$;
grant execute on function public.online_order_cancel(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 7. Shop-side RPCs (staff of the shop only).
-- ---------------------------------------------------------------------------
create or replace function public.online_orders_inbox(p_store_id uuid)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
begin
  if auth.uid() is null then raise exception 'ONLINE_NEEDS_SIGNIN'; end if;
  if not public.is_pos_member(p_store_id) then raise exception 'ONLINE_FORBIDDEN'; end if;
  return coalesce((
    select jsonb_agg(public.online_order_json(o.id)
                     order by o.placed_at desc)
      from public.online_orders o
     where o.store_id = p_store_id
       and o.status in ('received', 'preparing', 'ready')
  ), '[]'::jsonb);
end;
$$;
grant execute on function public.online_orders_inbox(uuid) to authenticated;

-- Archive view: done/cancelled, newest first.
create or replace function public.online_orders_archive(p_store_id uuid, p_limit int)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
begin
  if auth.uid() is null then raise exception 'ONLINE_NEEDS_SIGNIN'; end if;
  if not public.is_pos_member(p_store_id) then raise exception 'ONLINE_FORBIDDEN'; end if;
  -- LIMIT inside a subquery (merge-round fix): putting it after
  -- jsonb_agg limited the single aggregated row, i.e. did nothing.
  return coalesce((
    select jsonb_agg(public.online_order_json(sub.id)
                     order by sub.placed_at desc)
      from (
        select o.id, o.placed_at
          from public.online_orders o
         where o.store_id = p_store_id
           and o.status in ('done', 'cancelled')
         order by o.placed_at desc
         limit greatest(1, least(200, coalesce(p_limit, 50)))
      ) sub
  ), '[]'::jsonb);
end;
$$;
grant execute on function public.online_orders_archive(uuid, int) to authenticated;

create or replace function public.online_order_set_status(p_order_id uuid, p_status text)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_status text := lower(btrim(coalesce(p_status, '')));
  o        record;
begin
  if auth.uid() is null then raise exception 'ONLINE_NEEDS_SIGNIN'; end if;
  select id, store_id, status into o
    from public.online_orders where id = p_order_id for update;
  if not found then raise exception 'ONLINE_ORDER_NOT_FOUND'; end if;
  if not public.is_pos_member(o.store_id) then raise exception 'ONLINE_FORBIDDEN'; end if;
  if not (
       (o.status = 'received'   and v_status in ('preparing', 'ready', 'cancelled'))
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
grant execute on function public.online_order_set_status(uuid, text) to authenticated;

-- Convert a ready order into a real POS sale (channel = 'online').
-- Atomic: sale insert + stock decrement + order link happen in ONE
-- transaction, so stock is decremented EXACTLY once even if the cashier
-- taps twice (the second call returns the existing sale via the
-- order-linked idempotency key).
-- ONLINE_ALREADY_SOLD is never an error for the till: it just returns the
-- sale that is already on the books.
create or replace function public.online_order_convert(
  p_order_id uuid, p_method text, p_tendered_cents int)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_method   text := lower(btrim(coalesce(p_method, '')));
  o          record;
  v_sale_id  uuid;
  v_sale_num int;
  v_items    jsonb := '[]'::jsonb;
  v_lines    jsonb := '[]'::jsonb;
  it         record;
  v_tendered int;
  v_change   int;
  v_key      text;
  v_stock    jsonb;
begin
  if auth.uid() is null then raise exception 'ONLINE_NEEDS_SIGNIN'; end if;
  if v_method not in ('cash', 'card') then raise exception 'ONLINE_BAD_METHOD'; end if;

  select * into o from public.online_orders where id = p_order_id for update;
  if not found then raise exception 'ONLINE_ORDER_NOT_FOUND'; end if;
  if not public.is_pos_member(o.store_id) then raise exception 'ONLINE_FORBIDDEN'; end if;

  v_key := 'online-order:' || p_order_id::text;

  -- Idempotent: already converted (or a racing tap) → return the sale.
  if o.sale_id is not null then
    select s.id, s.number into v_sale_id, v_sale_num
      from public.pos_sales s where s.id = o.sale_id;
    return jsonb_build_object(
      'sale_id', v_sale_id, 'sale_number', v_sale_num,
      'order_number', o.number, 'status', o.status, 'already', true);
  end if;
  if o.status in ('done', 'cancelled') then
    raise exception 'ONLINE_BAD_STATUS';
  end if;

  for it in select * from public.online_order_items where order_id = p_order_id order by created_at loop
    v_items := v_items || jsonb_build_object(
      'productId', it.product_id,
      'name', it.name,
      'priceCents', it.unit_price_cents,
      'qty', it.qty);
    v_lines := v_lines || jsonb_build_object(
      'product_id', it.product_id,
      'name', it.name,
      'qty', it.qty);
  end loop;

  v_tendered := greatest(0, coalesce(p_tendered_cents, o.total_cents));
  if v_tendered < o.total_cents then raise exception 'ONLINE_UNDERPAID'; end if;
  v_change := case when v_method = 'cash' then v_tendered - o.total_cents else 0 end;

  insert into public.pos_sales (
      store_id, items, subtotal_cents, discount_cents, tax_cents,
      total_cents, method, tendered_cents, change_cents,
      created_by, customer_id, tax_lines, idempotency_key, channel
    ) values (
      o.store_id, v_items, o.subtotal_cents, 0, o.tax_cents,
      o.total_cents, v_method, v_tendered, v_change,
      auth.uid(), o.pos_customer_id, o.tax_lines, v_key, 'online'
    )
    returning id, number into v_sale_id, v_sale_num;

  -- Stock decremented by the same atomic function the till uses.
  -- Punch-pad devices are rejected inside it; oversell is floored at 0
  -- and reported per line so the till can tell the customer honestly.
  -- Migration 075's keyed variant makes it exactly-once per sale key
  -- (plpgsql late-binds: 075 lands later in the same apply sequence,
  -- before this function is ever called).
  select public.pos_apply_sale_stock_once(o.store_id, v_lines, v_key, v_sale_id) into v_stock;

  update public.online_orders
     set status = 'done', status_at = now(), updated_at = now(), sale_id = v_sale_id
   where id = p_order_id;

  return jsonb_build_object(
    'sale_id', v_sale_id, 'sale_number', v_sale_num,
    'order_number', o.number, 'status', 'done', 'already', false,
    'stock', coalesce(v_stock, '[]'::jsonb));
end;
$$;
grant execute on function public.online_order_convert(uuid, text, int) to authenticated;

-- ---------------------------------------------------------------------------
-- 8. public_storefront() v2: same contract as migration 063, plus:
--    - each product carries id / track_stock / stock (so the page can
--      disable out-of-stock lines without inventing numbers);
--    - shop carries online_ordering {enabled, note} and tax {rates,
--      legacy_rate} so the customer's cart preview matches the till's
--      totals (the server recomputes the real total anyway).
-- ---------------------------------------------------------------------------
create or replace function public.public_storefront(p_slug text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  profile record;
begin
  -- The ONLY door to shop data for anonymous visitors: one published
  -- profile, and only the products the shop left public_visible.
  -- Unpublished or unknown slugs → NULL (the page shows an honest
  -- "not available" state and learns nothing).
  select
    sp.store_id,
    sp.display_name,
    sp.tagline,
    sp.about,
    sp.hours,
    sp.contact_email,
    sp.contact_phone,
    sp.accent_color,
    sp.show_prices,
    sp.online_ordering,
    sp.ordering_note,
    s.name        as store_name,
    s.currency    as store_currency,
    s.tax_rate    as store_tax_rate,
    s.tax_rates   as store_tax_rates
  into profile
  from public.storefront_profiles sp
  join public.pos_stores s on s.id = sp.store_id
  where sp.slug = lower(btrim(p_slug))
    and sp.published = true;

  if profile.store_id is null then
    return null;
  end if;

  return jsonb_build_object(
    'shop', jsonb_build_object(
      'name', profile.store_name,
      'display_name', profile.display_name,
      'tagline', profile.tagline,
      'about', profile.about,
      'hours', profile.hours,
      'contact_email', profile.contact_email,
      'contact_phone', profile.contact_phone,
      'accent_color', profile.accent_color,
      'show_prices', profile.show_prices,
      'currency', profile.store_currency,
      'online_ordering', jsonb_build_object(
        'enabled', coalesce(profile.online_ordering, false),
        'note', profile.ordering_note
      ),
      'tax', jsonb_build_object(
        'rates', coalesce(profile.store_tax_rates, '[]'::jsonb),
        'legacy_rate', coalesce(profile.store_tax_rate, 0)
      ),
      -- web-service links, validated again at render
      'address', (select sp2.address from public.storefront_profiles sp2 where sp2.store_id = profile.store_id),
      'facebook_url', (select sp2.facebook_url from public.storefront_profiles sp2 where sp2.store_id = profile.store_id),
      'instagram_url', (select sp2.instagram_url from public.storefront_profiles sp2 where sp2.store_id = profile.store_id),
      'tiktok_url', (select sp2.tiktok_url from public.storefront_profiles sp2 where sp2.store_id = profile.store_id),
      'whatsapp_phone', (select sp2.whatsapp_phone from public.storefront_profiles sp2 where sp2.store_id = profile.store_id),
      'review_url', (select sp2.review_url from public.storefront_profiles sp2 where sp2.store_id = profile.store_id),
      'directions_url', (select sp2.directions_url from public.storefront_profiles sp2 where sp2.store_id = profile.store_id),
      'order_url', (select sp2.order_url from public.storefront_profiles sp2 where sp2.store_id = profile.store_id),
      'newsletter_url', (select sp2.newsletter_url from public.storefront_profiles sp2 where sp2.store_id = profile.store_id)
    ),
    'products', (
      select coalesce(
        jsonb_agg(
          jsonb_build_object(
            'id', p.id,
            'name', p.name,
            'price', p.price_cents,
            'track_stock', coalesce(p.track_stock, false),
            'stock', coalesce(p.stock, 0)
          )
          order by p.name
        ),
        '[]'::jsonb
      )
      from public.pos_products p
      where p.store_id = profile.store_id
        and p.active = true
        and coalesce(p.public_visible, true) = true
    )
  );
end;
$$;

-- The storefront stays readable by everyone, including anonymous visitors.
-- (re-stated after recreate so the grant survives the replace)
grant execute on function public.public_storefront(text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 9. Sales channels: the converted online sale needs its own channel.
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_constraint where conname = 'pos_sales_channel_check') then
    alter table public.pos_sales drop constraint pos_sales_channel_check;
  end if;
  alter table public.pos_sales
    add constraint pos_sales_channel_check
    check (channel in ('register', 'fair', 'online'));
end
$$;

-- ---------------------------------------------------------------------------
-- 10. factory_reset(): NOT defined here. The single final definition
-- (every public table, master reseed incl. account_kind) lives in
-- migration 078. Defining it mid-sequence would strand an
-- incomplete TRUNCATE list that breaks on re-run once the later
-- tables exist (FK-guarded TRUNCATE is all-or-nothing).


-- ---------------------------------------------------------------------------
-- ROLLBACK (keep commented; run manually if this migration must be undone)
-- ---------------------------------------------------------------------------
-- drop function if exists public.online_order_convert(uuid, text, int);
-- drop function if exists public.online_order_set_status(uuid, text);
-- drop function if exists public.online_orders_archive(uuid, int);
-- drop function if exists public.online_orders_inbox(uuid);
-- drop function if exists public.online_order_cancel(uuid);
-- drop function if exists public.online_order_my_orders(text);
-- drop function if exists public.online_order_place(text, jsonb, text, text, text, text);
-- drop function if exists public.online_profile_save(text, text, text);
-- drop function if exists public.online_profile_get(text);
-- drop function if exists public.online_order_json(uuid);
-- drop function if exists public.online_customer_ensure(uuid, text, text);
-- drop function if exists public.online_store_for_slug(text);
-- drop function if exists public.online_order_tax_lines(uuid, int);
-- drop table if exists public.online_order_items;
-- drop table if exists public.online_orders;
-- drop table if exists public.online_customers;
-- alter table public.pos_stores drop column if exists online_order_seq;
-- alter table public.storefront_profiles drop column if exists online_ordering;
-- alter table public.storefront_profiles drop column if exists ordering_note;
