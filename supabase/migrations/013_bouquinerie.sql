-- 013_bouquinerie.sql
-- Bouquinerie à Dédé inventory for the LFDD build: book + thrift catalogue,
-- donation intake, sorting triage, book-fair sales, and special orders.
--
-- Single-shop model: every row belongs to one owner (auth.users). RLS keeps
-- each owner's rows private; there are no cross-user reads.
--
--   bq_items           — catalogue: books and general thrift items.
--   bq_donations       — donation batches (optional donor, received/sorted).
--   bq_donation_items  — which catalogue items came from which donation.
--   bq_fairs           — Foire du livre à Dédé events.
--   bq_fair_sales      — items sold at a fair (for revenue totals).
--   bq_special_orders  — customer special orders (requested → received).
--
-- Item status flow: 'sorting' → 'store' | 'fair' | 'donated' | 'recycled';
-- 'sold' is set when an item sells (in store or at a fair).

create table if not exists public.bq_items (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references auth.users(id) on delete cascade,
  kind        text not null default 'book' check (kind in ('book', 'item')),
  title       text not null,
  author      text,
  isbn        text,
  category    text,
  is_new      boolean not null default false,
  condition   text,
  qty         integer not null default 1 check (qty >= 0),
  price       numeric(10,2) not null default 0 check (price >= 0),
  shelf       text,
  source      text not null default 'donation'
              check (source in ('donation', 'purchase', 'supplier')),
  status      text not null default 'sorting'
              check (status in ('store', 'sorting', 'fair', 'sold', 'donated', 'recycled')),
  abe_ref     text,
  abe_status  text,
  notes       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists bq_items_owner on public.bq_items (owner_id, updated_at desc);
create index if not exists bq_items_isbn on public.bq_items (owner_id, isbn) where isbn is not null;
create index if not exists bq_items_status on public.bq_items (owner_id, status);

create table if not exists public.bq_donations (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references auth.users(id) on delete cascade,
  donor_name  text,
  received_at date not null default current_date,
  item_count  integer not null default 0 check (item_count >= 0),
  state       text not null default 'received' check (state in ('received', 'sorted')),
  notes       text,
  created_at  timestamptz not null default now()
);

create index if not exists bq_donations_owner on public.bq_donations (owner_id, received_at desc);

create table if not exists public.bq_donation_items (
  donation_id uuid not null references public.bq_donations(id) on delete cascade,
  item_id     uuid not null references public.bq_items(id) on delete cascade,
  primary key (donation_id, item_id)
);

create table if not exists public.bq_fairs (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references auth.users(id) on delete cascade,
  name        text not null default 'Foire du livre à Dédé',
  fair_date   date not null default current_date,
  beneficiary text,
  notes       text,
  created_at  timestamptz not null default now()
);

create index if not exists bq_fairs_owner on public.bq_fairs (owner_id, fair_date desc);

create table if not exists public.bq_fair_sales (
  id         uuid primary key default gen_random_uuid(),
  fair_id    uuid not null references public.bq_fairs(id) on delete cascade,
  item_id    uuid references public.bq_items(id) on delete set null,
  title      text not null,
  qty        integer not null default 1 check (qty > 0),
  unit_price numeric(10,2) not null default 0 check (unit_price >= 0),
  sold_at    timestamptz not null default now()
);

create index if not exists bq_fair_sales_fair on public.bq_fair_sales (fair_id, sold_at desc);

create table if not exists public.bq_special_orders (
  id             uuid primary key default gen_random_uuid(),
  owner_id       uuid not null references auth.users(id) on delete cascade,
  customer_name  text not null,
  customer_phone text,
  title          text not null,
  author         text,
  notes          text,
  status         text not null default 'requested'
                 check (status in ('requested', 'ordered', 'received', 'cancelled')),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists bq_special_orders_owner
  on public.bq_special_orders (owner_id, status, updated_at desc);

-- Keep updated_at honest.
create or replace function public.bq_touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists bq_items_touch on public.bq_items;
create trigger bq_items_touch
  before update on public.bq_items
  for each row execute function public.bq_touch_updated_at();

drop trigger if exists bq_special_orders_touch on public.bq_special_orders;
create trigger bq_special_orders_touch
  before update on public.bq_special_orders
  for each row execute function public.bq_touch_updated_at();

-- ---------- RLS: owners see only their own rows ----------

alter table public.bq_items enable row level security;
alter table public.bq_donations enable row level security;
alter table public.bq_donation_items enable row level security;
alter table public.bq_fairs enable row level security;
alter table public.bq_fair_sales enable row level security;
alter table public.bq_special_orders enable row level security;

drop policy if exists "bq_items_owner_all" on public.bq_items;
create policy "bq_items_owner_all" on public.bq_items
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

drop policy if exists "bq_donations_owner_all" on public.bq_donations;
create policy "bq_donations_owner_all" on public.bq_donations
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

drop policy if exists "bq_donation_items_owner_all" on public.bq_donation_items;
create policy "bq_donation_items_owner_all" on public.bq_donation_items
  for all using (
    exists (select 1 from public.bq_donations d
            where d.id = donation_id and d.owner_id = auth.uid())
  ) with check (
    exists (select 1 from public.bq_donations d
            where d.id = donation_id and d.owner_id = auth.uid())
  );

drop policy if exists "bq_fairs_owner_all" on public.bq_fairs;
create policy "bq_fairs_owner_all" on public.bq_fairs
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

drop policy if exists "bq_fair_sales_owner_all" on public.bq_fair_sales;
create policy "bq_fair_sales_owner_all" on public.bq_fair_sales
  for all using (
    exists (select 1 from public.bq_fairs f
            where f.id = fair_id and f.owner_id = auth.uid())
  ) with check (
    exists (select 1 from public.bq_fairs f
            where f.id = fair_id and f.owner_id = auth.uid())
  );

drop policy if exists "bq_special_orders_owner_all" on public.bq_special_orders;
create policy "bq_special_orders_owner_all" on public.bq_special_orders
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());
