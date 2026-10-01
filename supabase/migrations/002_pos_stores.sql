-- ============================================================
-- Drift POS — multi-user stores (migration 002)
-- Run AFTER schema.sql in the Supabase dashboard SQL editor.
-- Adds: pos_stores, pos_store_members (owner/manager/cashier),
-- pos_products, pos_sales (per-store numbering), pos_invites
-- (join codes), plus RLS and helper RPCs.
-- Idempotent: safe to re-run (uses IF NOT EXISTS / OR REPLACE /
-- DROP POLICY IF EXISTS where supported).
-- ============================================================

-- ---------- Stores ----------
create table if not exists public.pos_stores (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  currency   text not null default '$',
  tax_rate   numeric not null default 0 check (tax_rate >= 0 and tax_rate <= 100),
  sale_seq   bigint not null default 0,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.pos_stores enable row level security;

-- ---------- Membership ----------
create table if not exists public.pos_store_members (
  store_id  uuid not null references public.pos_stores(id) on delete cascade,
  user_id   uuid not null references auth.users(id) on delete cascade,
  role      text not null default 'cashier' check (role in ('owner', 'manager', 'cashier')),
  joined_at timestamptz not null default now(),
  primary key (store_id, user_id)
);
create index if not exists pos_store_members_user on public.pos_store_members (user_id);
alter table public.pos_store_members enable row level security;

-- ---------- Catalog ----------
create table if not exists public.pos_products (
  id          uuid primary key default gen_random_uuid(),
  store_id    uuid not null references public.pos_stores(id) on delete cascade,
  name        text not null,
  sku         text,
  price_cents bigint not null check (price_cents > 0),
  category    text,
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists pos_products_store on public.pos_products (store_id, active, name);
alter table public.pos_products enable row level security;

-- ---------- Sales ----------
create table if not exists public.pos_sales (
  id             uuid primary key default gen_random_uuid(),
  store_id       uuid not null references public.pos_stores(id) on delete cascade,
  number         bigint not null,
  items          jsonb not null default '[]',
  subtotal_cents bigint not null default 0,
  discount_cents bigint not null default 0,
  tax_cents      bigint not null default 0,
  total_cents    bigint not null default 0,
  method         text not null check (method in ('cash', 'card')),
  tendered_cents bigint not null default 0,
  change_cents   bigint not null default 0,
  created_by     uuid references auth.users(id) on delete set null,
  created_at     timestamptz not null default now(),
  voided         boolean not null default false,
  voided_at      timestamptz,
  voided_by      uuid references auth.users(id) on delete set null,
  unique (store_id, number)
);
create index if not exists pos_sales_store on public.pos_sales (store_id, created_at desc);
alter table public.pos_sales enable row level security;

-- ---------- Invite codes ----------
create table if not exists public.pos_invites (
  id         uuid primary key default gen_random_uuid(),
  store_id   uuid not null references public.pos_stores(id) on delete cascade,
  code       text not null unique,
  role       text not null default 'cashier' check (role in ('manager', 'cashier')),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  max_uses   integer check (max_uses is null or max_uses > 0),
  uses       integer not null default 0
);
alter table public.pos_invites enable row level security;

-- ---------- Helpers (security definer => bypass RLS inside, no recursion) ----------
create or replace function public.is_pos_member(p_store_id uuid)
returns boolean
language sql security definer stable as $$
  select exists (
    select 1 from public.pos_store_members
    where store_id = p_store_id and user_id = auth.uid()
  );
$$;

create or replace function public.pos_role(p_store_id uuid)
returns text
language sql security definer stable as $$
  select role from public.pos_store_members
  where store_id = p_store_id and user_id = auth.uid();
$$;

-- ---------- RLS: pos_stores ----------
drop policy if exists "pos_stores_member_select" on public.pos_stores;
create policy "pos_stores_member_select"
  on public.pos_stores for select
  using (public.is_pos_member(id));

drop policy if exists "pos_stores_create" on public.pos_stores;
create policy "pos_stores_create"
  on public.pos_stores for insert
  with check (auth.uid() is not null);

drop policy if exists "pos_stores_manager_update" on public.pos_stores;
create policy "pos_stores_manager_update"
  on public.pos_stores for update
  using (public.pos_role(id) in ('owner', 'manager'))
  with check (public.pos_role(id) in ('owner', 'manager'));

drop policy if exists "pos_stores_owner_delete" on public.pos_stores;
create policy "pos_stores_owner_delete"
  on public.pos_stores for delete
  using (public.pos_role(id) = 'owner');

-- ---------- RLS: pos_store_members ----------
drop policy if exists "pos_members_select" on public.pos_store_members;
create policy "pos_members_select"
  on public.pos_store_members for select
  using (user_id = auth.uid() or public.is_pos_member(store_id));

drop policy if exists "pos_members_manager_insert" on public.pos_store_members;
create policy "pos_members_manager_insert"
  on public.pos_store_members for insert
  with check (public.pos_role(store_id) in ('owner', 'manager'));

drop policy if exists "pos_members_owner_update" on public.pos_store_members;
create policy "pos_members_owner_update"
  on public.pos_store_members for update
  using (public.pos_role(store_id) = 'owner')
  with check (public.pos_role(store_id) = 'owner');

drop policy if exists "pos_members_leave_or_owner_delete" on public.pos_store_members;
create policy "pos_members_leave_or_owner_delete"
  on public.pos_store_members for delete
  using (user_id = auth.uid() or public.pos_role(store_id) = 'owner');

-- ---------- RLS: pos_products ----------
drop policy if exists "pos_products_member_select" on public.pos_products;
create policy "pos_products_member_select"
  on public.pos_products for select
  using (public.is_pos_member(store_id));

drop policy if exists "pos_products_manager_write" on public.pos_products;
create policy "pos_products_manager_write"
  on public.pos_products for insert
  with check (public.pos_role(store_id) in ('owner', 'manager'));

drop policy if exists "pos_products_manager_update" on public.pos_products;
create policy "pos_products_manager_update"
  on public.pos_products for update
  using (public.pos_role(store_id) in ('owner', 'manager'))
  with check (public.pos_role(store_id) in ('owner', 'manager'));

drop policy if exists "pos_products_manager_delete" on public.pos_products;
create policy "pos_products_manager_delete"
  on public.pos_products for delete
  using (public.pos_role(store_id) in ('owner', 'manager'));

-- ---------- RLS: pos_sales ----------
drop policy if exists "pos_sales_member_select" on public.pos_sales;
create policy "pos_sales_member_select"
  on public.pos_sales for select
  using (public.is_pos_member(store_id));

-- any team member can ring up a sale (cashiers included)
drop policy if exists "pos_sales_member_insert" on public.pos_sales;
create policy "pos_sales_member_insert"
  on public.pos_sales for insert
  with check (public.is_pos_member(store_id));

-- voiding is manager+ (update is only used for voiding)
drop policy if exists "pos_sales_manager_update" on public.pos_sales;
create policy "pos_sales_manager_update"
  on public.pos_sales for update
  using (public.pos_role(store_id) in ('owner', 'manager'))
  with check (public.pos_role(store_id) in ('owner', 'manager'));

-- no delete policy: sales are the books, void instead

-- ---------- RLS: pos_invites ----------
drop policy if exists "pos_invites_manager_all" on public.pos_invites;
create policy "pos_invites_manager_all"
  on public.pos_invites for all
  using (public.pos_role(store_id) in ('owner', 'manager'))
  with check (public.pos_role(store_id) in ('owner', 'manager'));

-- ---------- Triggers ----------
-- creator becomes owner
create or replace function public.handle_new_pos_store()
returns trigger
language plpgsql security definer as $$
begin
  insert into public.pos_store_members (store_id, user_id, role)
  values (new.id, new.created_by, 'owner')
  on conflict do nothing;
  return new;
end $$;

drop trigger if exists pos_stores_add_owner on public.pos_stores;
create trigger pos_stores_add_owner
  after insert on public.pos_stores
  for each row execute function public.handle_new_pos_store();

-- per-store sequential sale numbers, race-safe via row lock
create or replace function public.assign_pos_sale_number()
returns trigger
language plpgsql security definer as $$
declare
  next_num bigint;
begin
  select sale_seq + 1 into next_num
  from public.pos_stores where id = new.store_id
  for update;
  update public.pos_stores set sale_seq = next_num where id = new.store_id;
  new.number := next_num;
  return new;
end $$;

drop trigger if exists pos_sales_assign_number on public.pos_sales;
create trigger pos_sales_assign_number
  before insert on public.pos_sales
  for each row execute function public.assign_pos_sale_number();

-- never leave a store without an owner
create or replace function public.guard_pos_last_owner()
returns trigger
language plpgsql security definer as $$
declare
  owners_left integer;
begin
  if old.role = 'owner' and (TG_OP = 'DELETE' or new.role <> 'owner') then
    select count(*) into owners_left
    from public.pos_store_members
    where store_id = old.store_id and role = 'owner'
      and not (user_id = old.user_id);
    if owners_left = 0 then
      raise exception 'a store must keep at least one owner';
    end if;
  end if;
  if TG_OP = 'DELETE' then return old; end if;
  return new;
end $$;

drop trigger if exists pos_members_guard_owner on public.pos_store_members;
create trigger pos_members_guard_owner
  before update or delete on public.pos_store_members
  for each row execute function public.guard_pos_last_owner();

drop trigger if exists pos_stores_touch on public.pos_stores;
create trigger pos_stores_touch
  before update on public.pos_stores
  for each row execute function public.touch_updated_at();

drop trigger if exists pos_products_touch on public.pos_products;
create trigger pos_products_touch
  before update on public.pos_products
  for each row execute function public.touch_updated_at();

-- ---------- Join-by-code RPC ----------
-- Validates the invite and adds the caller. Security definer so the
-- invites table never needs a broad read policy.
create or replace function public.join_pos_store(p_code text)
returns uuid
language plpgsql security definer
set search_path = public
as $$
declare
  inv record;
begin
  if auth.uid() is null then
    raise exception 'sign in to join a store';
  end if;
  select * into inv from public.pos_invites
  where code = upper(trim(p_code))
    and (expires_at is null or expires_at > now())
    and (max_uses is null or uses < max_uses);
  if not found then
    raise exception 'invite code not found or expired';
  end if;
  if exists (
    select 1 from public.pos_store_members
    where store_id = inv.store_id and user_id = auth.uid()
  ) then
    return inv.store_id; -- idempotent
  end if;
  insert into public.pos_store_members (store_id, user_id, role)
  values (inv.store_id, auth.uid(), inv.role);
  update public.pos_invites set uses = uses + 1 where id = inv.id;
  return inv.store_id;
end $$;

-- ---------- Teammates can see each other's usernames ----------
drop policy if exists "profiles_select_pos_teammates" on public.profiles;
create policy "profiles_select_pos_teammates"
  on public.profiles for select
  using (exists (
    select 1
    from public.pos_store_members m1
    join public.pos_store_members m2 on m1.store_id = m2.store_id
    where m1.user_id = auth.uid()
      and m2.user_id = public.profiles.id
  ));
