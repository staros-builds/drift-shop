-- ============================================================
-- Drift POS — feature upgrade (migration 004)
-- Run AFTER 003_pos_rls_fixes.sql in the Supabase dashboard SQL editor.
-- This file is NOT applied automatically — the app ships the SQL only.
-- Adds:
--   * pos_products: cost_cents, stock, track_stock, low_stock_threshold,
--     variants (jsonb), image_url
--   * pos_stores: tax_rates (jsonb stacked named rates; legacy tax_rate
--     remains the fallback when empty)
--   * pos_sales: cashier_name, cashier_id, customer_id, staff_pin_id,
--     void_reason; method gains 'other'
--   * pos_customers: simple customer directory per store
--   * pos_staff: per-store staff with SHA-256-hashed PINs for shared-
--     device cashier login (via pos_staff_login RPC; pin_hash is never
--     readable by non-managers)
--   * pos_drawer_shifts: cash drawer open/close counts with variance
-- Idempotent: safe to re-run (IF NOT EXISTS / DROP IF EXISTS).
-- ============================================================

-- ---------- Products: richer catalog ----------
alter table public.pos_products
  add column if not exists cost_cents bigint not null default 0;
alter table public.pos_products
  add column if not exists stock integer not null default 0;
alter table public.pos_products
  add column if not exists track_stock boolean not null default false;
alter table public.pos_products
  add column if not exists low_stock_threshold integer not null default 0;
alter table public.pos_products
  add column if not exists variants jsonb not null default '[]';
alter table public.pos_products
  add column if not exists image_url text;

-- ---------- Stores: stacked named tax rates ----------
alter table public.pos_stores
  add column if not exists tax_rates jsonb not null default '[]';

-- ---------- Sales: attribution + customer + void reason ----------
alter table public.pos_sales
  add column if not exists cashier_name text;
alter table public.pos_sales
  add column if not exists cashier_id uuid references auth.users(id) on delete set null;
alter table public.pos_sales
  add column if not exists void_reason text;

-- allow 'other' tender type alongside cash/card
alter table public.pos_sales drop constraint if exists pos_sales_method_check;
alter table public.pos_sales
  add constraint pos_sales_method_check
  check (method in ('cash', 'card', 'other'));

-- ---------- Customers ----------
create table if not exists public.pos_customers (
  id         uuid primary key default gen_random_uuid(),
  store_id   uuid not null references public.pos_stores(id) on delete cascade,
  name       text not null,
  phone      text,
  email      text,
  notes      text,
  created_at timestamptz not null default now()
);
create index if not exists pos_customers_store on public.pos_customers (store_id, name);
alter table public.pos_customers enable row level security;

alter table public.pos_sales
  add column if not exists customer_id uuid references public.pos_customers(id) on delete set null;
create index if not exists pos_sales_customer on public.pos_sales (customer_id);

-- ---------- Staff (PIN login for shared devices) ----------
create table if not exists public.pos_staff (
  id         uuid primary key default gen_random_uuid(),
  store_id   uuid not null references public.pos_stores(id) on delete cascade,
  name       text not null,
  pin_hash   text not null, -- sha256 hex of the PIN; never sent to non-managers
  role       text not null default 'cashier' check (role in ('owner', 'manager', 'cashier')),
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  unique (store_id, name)
);
create index if not exists pos_staff_store on public.pos_staff (store_id, active);
alter table public.pos_staff enable row level security;

alter table public.pos_sales
  add column if not exists staff_pin_id uuid references public.pos_staff(id) on delete set null;

-- ---------- Drawer shifts ----------
create table if not exists public.pos_drawer_shifts (
  id                uuid primary key default gen_random_uuid(),
  store_id          uuid not null references public.pos_stores(id) on delete cascade,
  opened_by         uuid references auth.users(id) on delete set null,
  opened_by_name    text,
  opened_at         timestamptz not null default now(),
  open_amount_cents bigint not null default 0,
  closed_at         timestamptz,
  closed_by         uuid references auth.users(id) on delete set null,
  close_amount_cents bigint,
  expected_cents    bigint,
  note              text
);
create index if not exists pos_drawer_shifts_store on public.pos_drawer_shifts (store_id, opened_at desc);
alter table public.pos_drawer_shifts enable row level security;

-- ---------- RLS: pos_customers ----------
-- Any team member can read/add customers; managers can edit/remove.
drop policy if exists "pos_customers_member_select" on public.pos_customers;
create policy "pos_customers_member_select"
  on public.pos_customers for select
  using (public.is_pos_member(store_id));

drop policy if exists "pos_customers_member_insert" on public.pos_customers;
create policy "pos_customers_member_insert"
  on public.pos_customers for insert
  with check (public.is_pos_member(store_id));

drop policy if exists "pos_customers_manager_update" on public.pos_customers;
create policy "pos_customers_manager_update"
  on public.pos_customers for update
  using (public.pos_role(store_id) in ('owner', 'manager'))
  with check (public.pos_role(store_id) in ('owner', 'manager'));

drop policy if exists "pos_customers_manager_delete" on public.pos_customers;
create policy "pos_customers_manager_delete"
  on public.pos_customers for delete
  using (public.pos_role(store_id) in ('owner', 'manager'));

-- ---------- RLS: pos_staff ----------
-- pin_hash must never be readable by cashiers: only owner/manager get any
-- access to the table; cashier login goes through the pos_staff_login()
-- RPC below, which returns name/role without exposing the hash.
drop policy if exists "pos_staff_manager_all" on public.pos_staff;
create policy "pos_staff_manager_all"
  on public.pos_staff for all
  using (public.pos_role(store_id) in ('owner', 'manager'))
  with check (public.pos_role(store_id) in ('owner', 'manager'));

-- ---------- RPC: staff PIN login ----------
-- Security definer so pin_hash never needs a broad read policy. The caller
-- must already be a store member; returns the staff row (no hash) or raises.
create or replace function public.pos_staff_login(p_store_id uuid, p_pin_hash text)
returns table (id uuid, name text, role text)
language plpgsql security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'sign in to use staff PINs';
  end if;
  if not public.is_pos_member(p_store_id) then
    raise exception 'not a member of this store';
  end if;
  return query
    select s.id, s.name, s.role
    from public.pos_staff s
    where s.store_id = p_store_id
      and s.active
      and s.pin_hash = p_pin_hash
    limit 1;
  if not found then
    raise exception 'invalid PIN';
  end if;
end $$;

-- Only signed-in users may call it; the function itself enforces membership.
revoke all on function public.pos_staff_login(uuid, text) from public;
grant execute on function public.pos_staff_login(uuid, text) to authenticated;

-- ---------- RLS: pos_drawer_shifts ----------
drop policy if exists "pos_drawer_member_select" on public.pos_drawer_shifts;
create policy "pos_drawer_member_select"
  on public.pos_drawer_shifts for select
  using (public.is_pos_member(store_id));

-- any member can open a drawer count
drop policy if exists "pos_drawer_member_insert" on public.pos_drawer_shifts;
create policy "pos_drawer_member_insert"
  on public.pos_drawer_shifts for insert
  with check (public.is_pos_member(store_id));

-- only managers close / edit a shift
drop policy if exists "pos_drawer_manager_update" on public.pos_drawer_shifts;
create policy "pos_drawer_manager_update"
  on public.pos_drawer_shifts for update
  using (public.pos_role(store_id) in ('owner', 'manager'))
  with check (public.pos_role(store_id) in ('owner', 'manager'));

drop policy if exists "pos_drawer_manager_delete" on public.pos_drawer_shifts;
create policy "pos_drawer_manager_delete"
  on public.pos_drawer_shifts for delete
  using (public.pos_role(store_id) in ('owner', 'manager'));
