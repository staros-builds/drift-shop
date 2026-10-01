-- 016_bouquinerie_shared_shop.sql
--
-- The Bouquinerie (catalogue, donations, fairs, special orders) moves from
-- per-owner isolation to the shared shop model: every bq table gets a
-- store_id pointing at pos_stores, and RLS is re-based on pos_store_members
-- (roles owner/manager/cashier) using the existing is_pos_member()/pos_role()
-- helpers. Staff on different accounts now see and work the same data.
--
-- Permission model (mirrors pos_products/pos_sales):
--   SELECT ............ any store member
--   INSERT/UPDATE ..... any store member (daily operational work)
--   DELETE ............ owner/manager only (destructive)
--   fair sales ........ members INSERT (ringing a sale); manager+ UPDATE/DELETE
--   link tables ....... members, both linked rows must be visible (014 rule kept)
--
-- Also: last-owner protection on pos_store_members — the final owner of a
-- store can neither be removed nor demoted, so a shop can never be orphaned.
--
-- Idempotent: safe to re-run. Run in the Supabase dashboard SQL editor,
-- ideally as a single transaction.

begin;

-- ================= 1. store_id columns =================
alter table public.bq_items
  add column if not exists store_id uuid references public.pos_stores(id) on delete cascade;
alter table public.bq_donations
  add column if not exists store_id uuid references public.pos_stores(id) on delete cascade;
alter table public.bq_donation_items
  add column if not exists store_id uuid references public.pos_stores(id) on delete cascade;
alter table public.bq_fairs
  add column if not exists store_id uuid references public.pos_stores(id) on delete cascade;
alter table public.bq_fair_sales
  add column if not exists store_id uuid references public.pos_stores(id) on delete cascade;
alter table public.bq_special_orders
  add column if not exists store_id uuid references public.pos_stores(id) on delete cascade;

-- ================= 2. backfill existing rows =================
-- Every pre-existing row belongs to the shop's store (earliest created).
-- Fresh installs have no bq rows yet, so the backfill is skipped entirely
-- instead of raising on the empty pos_stores table.
do $$
declare
  sid uuid;
  orphans int;
begin
  select count(*) into orphans from (
    select 1 from public.bq_items          where store_id is null union all
    select 1 from public.bq_donations      where store_id is null union all
    select 1 from public.bq_donation_items where store_id is null union all
    select 1 from public.bq_fairs          where store_id is null union all
    select 1 from public.bq_fair_sales     where store_id is null union all
    select 1 from public.bq_special_orders where store_id is null
  ) o;
  if orphans = 0 then
    return;
  end if;
  select id into sid from public.pos_stores order by created_at asc limit 1;
  if sid is null then
    raise exception '016: no pos_stores row found — create the shop store first';
  end if;
  update public.bq_items          set store_id = sid where store_id is null;
  update public.bq_donations      set store_id = sid where store_id is null;
  update public.bq_donation_items set store_id = sid where store_id is null;
  update public.bq_fairs          set store_id = sid where store_id is null;
  update public.bq_fair_sales     set store_id = sid where store_id is null;
  update public.bq_special_orders set store_id = sid where store_id is null;
end $$;

-- ================= 3. not null + indexes =================
alter table public.bq_items           alter column store_id set not null;
alter table public.bq_donations       alter column store_id set not null;
alter table public.bq_donation_items  alter column store_id set not null;
alter table public.bq_fairs           alter column store_id set not null;
alter table public.bq_fair_sales      alter column store_id set not null;
alter table public.bq_special_orders  alter column store_id set not null;

create index if not exists bq_items_store          on public.bq_items (store_id);
create index if not exists bq_donations_store      on public.bq_donations (store_id);
create index if not exists bq_donation_items_store on public.bq_donation_items (store_id);
create index if not exists bq_fairs_store          on public.bq_fairs (store_id);
create index if not exists bq_fair_sales_store     on public.bq_fair_sales (store_id);
create index if not exists bq_special_orders_store on public.bq_special_orders (store_id);

-- ================= 4. drop owner-based policies =================
drop policy if exists "bq_items_owner_all"          on public.bq_items;
drop policy if exists "bq_donations_owner_all"       on public.bq_donations;
drop policy if exists "bq_donation_items_owner_all"  on public.bq_donation_items;
drop policy if exists "bq_fairs_owner_all"           on public.bq_fairs;
drop policy if exists "bq_fair_sales_owner_all"      on public.bq_fair_sales;
drop policy if exists "bq_special_orders_owner_all"  on public.bq_special_orders;

-- ================= 5. store-member policies =================

-- ----- bq_items -----
drop policy if exists "bq_items_member_select" on public.bq_items;
create policy "bq_items_member_select" on public.bq_items
  for select using (public.is_pos_member(store_id));

drop policy if exists "bq_items_member_insert" on public.bq_items;
create policy "bq_items_member_insert" on public.bq_items
  for insert with check (public.is_pos_member(store_id));

drop policy if exists "bq_items_member_update" on public.bq_items;
create policy "bq_items_member_update" on public.bq_items
  for update
  using (public.is_pos_member(store_id))
  with check (public.is_pos_member(store_id));

drop policy if exists "bq_items_manager_delete" on public.bq_items;
create policy "bq_items_manager_delete" on public.bq_items
  for delete using (public.pos_role(store_id) in ('owner', 'manager'));

-- ----- bq_donations -----
drop policy if exists "bq_donations_member_select" on public.bq_donations;
create policy "bq_donations_member_select" on public.bq_donations
  for select using (public.is_pos_member(store_id));

drop policy if exists "bq_donations_member_insert" on public.bq_donations;
create policy "bq_donations_member_insert" on public.bq_donations
  for insert with check (public.is_pos_member(store_id));

drop policy if exists "bq_donations_member_update" on public.bq_donations;
create policy "bq_donations_member_update" on public.bq_donations
  for update
  using (public.is_pos_member(store_id))
  with check (public.is_pos_member(store_id));

drop policy if exists "bq_donations_manager_delete" on public.bq_donations;
create policy "bq_donations_manager_delete" on public.bq_donations
  for delete using (public.pos_role(store_id) in ('owner', 'manager'));

-- ----- bq_donation_items -----
-- Both linked rows must be visible to the caller (014 cross-linking rule,
-- now expressed through store membership instead of owner_id).
drop policy if exists "bq_donation_items_member_select" on public.bq_donation_items;
create policy "bq_donation_items_member_select" on public.bq_donation_items
  for select using (
    public.is_pos_member(store_id)
    and exists (select 1 from public.bq_donations d where d.id = donation_id)
    and exists (select 1 from public.bq_items i where i.id = item_id)
  );

drop policy if exists "bq_donation_items_member_write" on public.bq_donation_items;
create policy "bq_donation_items_member_write" on public.bq_donation_items
  for insert with check (
    public.is_pos_member(store_id)
    and exists (select 1 from public.bq_donations d where d.id = donation_id)
    and exists (select 1 from public.bq_items i where i.id = item_id)
  );

drop policy if exists "bq_donation_items_member_update" on public.bq_donation_items;
create policy "bq_donation_items_member_update" on public.bq_donation_items
  for update
  using (public.is_pos_member(store_id))
  with check (
    public.is_pos_member(store_id)
    and exists (select 1 from public.bq_donations d where d.id = donation_id)
    and exists (select 1 from public.bq_items i where i.id = item_id)
  );

drop policy if exists "bq_donation_items_member_delete" on public.bq_donation_items;
create policy "bq_donation_items_member_delete" on public.bq_donation_items
  for delete using (public.is_pos_member(store_id));

-- ----- bq_fairs -----
drop policy if exists "bq_fairs_member_select" on public.bq_fairs;
create policy "bq_fairs_member_select" on public.bq_fairs
  for select using (public.is_pos_member(store_id));

drop policy if exists "bq_fairs_member_insert" on public.bq_fairs;
create policy "bq_fairs_member_insert" on public.bq_fairs
  for insert with check (public.is_pos_member(store_id));

drop policy if exists "bq_fairs_member_update" on public.bq_fairs;
create policy "bq_fairs_member_update" on public.bq_fairs
  for update
  using (public.is_pos_member(store_id))
  with check (public.is_pos_member(store_id));

drop policy if exists "bq_fairs_manager_delete" on public.bq_fairs;
create policy "bq_fairs_manager_delete" on public.bq_fairs
  for delete using (public.pos_role(store_id) in ('owner', 'manager'));

-- ----- bq_fair_sales -----
-- Any member can ring a sale; corrections are manager+.
drop policy if exists "bq_fair_sales_member_select" on public.bq_fair_sales;
create policy "bq_fair_sales_member_select" on public.bq_fair_sales
  for select using (
    public.is_pos_member(store_id)
    and exists (select 1 from public.bq_fairs f where f.id = fair_id)
    and (item_id is null or exists (select 1 from public.bq_items i where i.id = item_id))
  );

drop policy if exists "bq_fair_sales_member_insert" on public.bq_fair_sales;
create policy "bq_fair_sales_member_insert" on public.bq_fair_sales
  for insert with check (
    public.is_pos_member(store_id)
    and exists (select 1 from public.bq_fairs f where f.id = fair_id)
    and (item_id is null or exists (select 1 from public.bq_items i where i.id = item_id))
  );

drop policy if exists "bq_fair_sales_manager_update" on public.bq_fair_sales;
create policy "bq_fair_sales_manager_update" on public.bq_fair_sales
  for update
  using (public.pos_role(store_id) in ('owner', 'manager'))
  with check (
    public.pos_role(store_id) in ('owner', 'manager')
    and exists (select 1 from public.bq_fairs f where f.id = fair_id)
    and (item_id is null or exists (select 1 from public.bq_items i where i.id = item_id))
  );

drop policy if exists "bq_fair_sales_manager_delete" on public.bq_fair_sales;
create policy "bq_fair_sales_manager_delete" on public.bq_fair_sales
  for delete using (public.pos_role(store_id) in ('owner', 'manager'));

-- ----- bq_special_orders -----
drop policy if exists "bq_special_orders_member_select" on public.bq_special_orders;
create policy "bq_special_orders_member_select" on public.bq_special_orders
  for select using (public.is_pos_member(store_id));

drop policy if exists "bq_special_orders_member_insert" on public.bq_special_orders;
create policy "bq_special_orders_member_insert" on public.bq_special_orders
  for insert with check (public.is_pos_member(store_id));

drop policy if exists "bq_special_orders_member_update" on public.bq_special_orders;
create policy "bq_special_orders_member_update" on public.bq_special_orders
  for update
  using (public.is_pos_member(store_id))
  with check (public.is_pos_member(store_id));

drop policy if exists "bq_special_orders_manager_delete" on public.bq_special_orders;
create policy "bq_special_orders_manager_delete" on public.bq_special_orders
  for delete using (public.pos_role(store_id) in ('owner', 'manager'));

-- ================= 6. last-owner protection =================
-- Already enforced by migration 002's pos_members_guard_owner trigger on
-- pos_store_members, so no new trigger is needed here.

commit;
