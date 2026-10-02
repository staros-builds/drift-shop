-- BATCH b08

-- ===== FILE: supabase/migrations/015_*.sql ======
-- 015: harden updated_at on bouquinerie tables.
-- The bq_touch_updated_at() trigger only fires BEFORE UPDATE, so a client
-- can backdate updated_at on INSERT (verified 2026-09-29: inserting
-- updated_at='1900-01-01' stored it verbatim). The stated intent is
-- "keep updated_at honest" — fire on INSERT too.
drop trigger if exists bq_items_touch on public.bq_items;
create trigger bq_items_touch
  before insert or update on public.bq_items
  for each row execute function public.bq_touch_updated_at();

drop trigger if exists bq_special_orders_touch on public.bq_special_orders;
create trigger bq_special_orders_touch
  before insert or update on public.bq_special_orders
  for each row execute function public.bq_touch_updated_at();

-- ===== FILE: supabase/migrations/016_*.sql ======
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

-- ===== FILE: supabase/migrations/017_*.sql ======
-- 017: allow deleting a store (migration 016 follow-up)
--
-- Bug: guard_pos_last_owner() (migration 002) fires on the cascade delete of
-- pos_store_members when a store is deleted, and blocks it because the owner's
-- row disappears with "no other owners left". Result: no store with an owner
-- could ever be deleted through the app.
--
-- Fix: a BEFORE DELETE trigger on pos_stores stamps the doomed store's id in a
-- transaction-local setting; the guard skips member rows whose parent store is
-- itself being deleted. The setting lives only for the current transaction and
-- cannot be set through the API/RLS, so the last-owner protection is unchanged
-- for member removes, demotions, and self-leaves.

begin;

create or replace function public.mark_pos_store_deleting()
returns trigger
language plpgsql security definer as $$
begin
  perform set_config('app.deleting_store', old.id::text, true);
  return old;
end $$;

drop trigger if exists pos_stores_mark_deleting on public.pos_stores;
create trigger pos_stores_mark_deleting
  before delete on public.pos_stores
  for each row execute function public.mark_pos_store_deleting();

create or replace function public.guard_pos_last_owner()
returns trigger
language plpgsql security definer as $$
declare
  owners_left integer;
begin
  -- The parent store itself is being deleted; its member rows go with it.
  if current_setting('app.deleting_store', true) = old.store_id::text then
    if TG_OP = 'DELETE' then return old; end if;
    return new;
  end if;
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

commit;

-- ===== FILE: supabase/migrations/018_*.sql ======
-- 018: close manager->owner escalation + invite join race (migration 002 follow-up)
--
-- Hole 1 (verified adversarially 2026-09-29): pos_members_manager_insert let any
-- owner OR manager insert a member row with ANY role, including 'owner'. The
-- invite flow correctly caps invite roles at manager/cashier (CHECK constraint
-- on pos_invites.role), but a manager could bypass invites entirely and insert
-- an accomplice's brand-new account directly as 'owner' via the API.
-- Fix: managers may only insert 'manager'/'cashier' rows; only owners can
-- grant 'owner'.
--
-- Hole 2 (race): join_pos_store() read the invite row, checked
-- (max_uses is null or uses < max_uses), then incremented uses -- with no row
-- lock. Two concurrent joins on a max_uses=1 invite could both pass the check.
-- Fix: SELECT ... FOR UPDATE serializes joins on the same invite.

begin;

-- ---------- Hole 1: only owners can grant 'owner' ----------
drop policy if exists "pos_members_manager_insert" on public.pos_store_members;
create policy "pos_members_manager_insert"
  on public.pos_store_members for insert
  with check (
    public.pos_role(store_id) = 'owner'
    or (public.pos_role(store_id) = 'manager' and role in ('manager', 'cashier'))
  );

-- ---------- Hole 2: serialize concurrent joins on one invite ----------
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
    and (max_uses is null or uses < max_uses)
  for update;
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

commit;

-- ===== FILE: supabase/migrations/019_*.sql ======
-- 019_password_reset_tickets.sql
-- Logged-out password-reset / help requests + admin password-reset RPC.
--
-- 1. support_tickets.user_id becomes nullable so people who cannot sign in
--    (e.g. username-only accounts with no email address) can file a help
--    request from the login screen. Their account username is stored in the
--    new `username` column; admins see and resolve it through the existing
--    ticket inbox. No account-existence check is performed on purpose: the
--    response is identical whether or not the username exists (no
--    username enumeration).
-- 2. admin_reset_password(uuid, text): SECURITY DEFINER RPC letting a global
--    admin set a new password for any auth user. Used by the Admin panel
--    "Reset password" action on password-reset tickets. Invalidates the
--    user's existing sessions so the old password stops working everywhere.

-- ---------- logged-out tickets ----------
alter table public.support_tickets alter column user_id drop not null;

alter table public.support_tickets
  add column if not exists username text
  check (username is null or char_length(username) between 1 and 60);

-- Anonymous (logged-out) visitors may FILE a help request. They cannot read
-- any tickets. The username column is required so the admin knows which
-- account the request is about.
drop policy if exists "support_tickets_insert_anon" on public.support_tickets;
create policy "support_tickets_insert_anon"
  on public.support_tickets for insert
  to anon
  with check (
    user_id is null
    and username is not null
    and char_length(subject) between 1 and 200
    and char_length(message) between 1 and 5000
  );

-- ---------- admin password reset ----------
create extension if not exists pgcrypto with schema extensions;

create or replace function public.admin_reset_password(target_user_id uuid, new_password text)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if not public.is_admin() then
    raise exception 'not authorized';
  end if;
  if new_password is null
     or char_length(new_password) < 8
     or char_length(new_password) > 200 then
    raise exception 'password must be between 8 and 200 characters';
  end if;
  if not exists (select 1 from auth.users where id = target_user_id) then
    raise exception 'user not found';
  end if;
  update auth.users
     set encrypted_password = crypt(new_password, gen_salt('bf')),
         updated_at = now()
   where id = target_user_id;
  -- Invalidate existing sessions so the old password stops working everywhere.
  -- NOTE: auth.refresh_tokens.user_id is character varying in this schema,
  -- so cast the uuid parameter (uuid = varchar has no operator -> 42883).
  delete from auth.refresh_tokens where user_id = target_user_id::text;
end;
$$;

revoke all on function public.admin_reset_password(uuid, text) from public, anon;
grant execute on function public.admin_reset_password(uuid, text) to authenticated;
