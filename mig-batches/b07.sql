-- BATCH b07

-- ===== FILE: supabase/migrations/010_*.sql ======
-- 010_backup_import.sql — account backup/restore: manager-only bulk import
-- of time-clock history (punches + correction audits).
--
-- Why an RPC: migration 007 deliberately removed every direct
-- insert/update/delete RLS policy on pos_time_punches and
-- pos_punch_audits — all punch writes go through the PIN-verified
-- pos_clock_in / pos_clock_out RPCs. Restoring a backup therefore needs a
-- server-side import path too. This RPC is manager/owner-only and merges by
-- row ID: rows already present are skipped (on conflict do nothing), so a
-- restore never duplicates or overwrites live punches.
--
-- Backup semantics:
--   - Only store members can call it; only owner/manager roles may import.
--   - store_id on every imported row is forced to p_store_id (the caller
--     cannot smuggle rows into another store).
--   - The open-shift unique index is respected: if the staff member already
--     has an open shift in the live database, the backup's open shift is
--     skipped (the live shift wins).
--   - Punch check constraint (punch_out > punch_in) still applies.
-- Apply exactly once, after 007.

create or replace function public.pos_punch_history_import(
  p_store_id uuid,
  p_punches  jsonb,
  p_audits   jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_punches int := 0;
  v_audits  int := 0;
  r jsonb;
begin
  if auth.uid() is null then
    raise exception 'sign in required';
  end if;
  if not public.is_pos_member(p_store_id) then
    raise exception 'not a member of this store';
  end if;
  if public.pos_role(p_store_id) not in ('owner', 'manager') then
    raise exception 'managers only';
  end if;

  for r in
    select * from jsonb_array_elements(coalesce(p_punches, '[]'::jsonb))
  loop
    if r is null or (r ->> 'id') is null or (r ->> 'staff_id') is null
       or (r ->> 'punch_in') is null then
      continue;
    end if;
    -- Live open shift wins over a backup's open shift for the same employee.
    if (r ->> 'punch_out') is null then
      if exists (
        select 1 from public.pos_time_punches
        where store_id = p_store_id
          and staff_id = (r ->> 'staff_id')::uuid
          and punch_out is null
      ) then
        continue;
      end if;
    end if;
    insert into public.pos_time_punches
      (id, store_id, staff_id, punch_in, punch_out, created_at)
    values
      ((r ->> 'id')::uuid,
       p_store_id,
       (r ->> 'staff_id')::uuid,
       (r ->> 'punch_in')::timestamptz,
       nullif(r ->> 'punch_out', '')::timestamptz,
       coalesce((r ->> 'created_at')::timestamptz, now()))
    on conflict (id) do nothing;
    if found then
      v_punches := v_punches + 1;
    end if;
  end loop;

  for r in
    select * from jsonb_array_elements(coalesce(p_audits, '[]'::jsonb))
  loop
    if r is null or (r ->> 'id') is null then
      continue;
    end if;
    insert into public.pos_punch_audits
      (id, store_id, punch_id, action, edited_by,
       old_punch_in, old_punch_out, new_punch_in, new_punch_out, created_at)
    values
      ((r ->> 'id')::uuid,
       p_store_id,
       nullif(r ->> 'punch_id', '')::uuid,
       coalesce(r ->> 'action', 'correct'),
       auth.uid(), -- re-attribute to the importer: the backup's user may not exist here
       nullif(r ->> 'old_punch_in', '')::timestamptz,
       nullif(r ->> 'old_punch_out', '')::timestamptz,
       nullif(r ->> 'new_punch_in', '')::timestamptz,
       nullif(r ->> 'new_punch_out', '')::timestamptz,
       coalesce((r ->> 'created_at')::timestamptz, now()))
    on conflict (id) do nothing;
    if found then
      v_audits := v_audits + 1;
    end if;
  end loop;

  return jsonb_build_object('punches', v_punches, 'audits', v_audits);
end;
$$;

grant execute on function public.pos_punch_history_import(uuid, jsonb, jsonb)
  to authenticated;

-- ===== FILE: supabase/migrations/011_*.sql ======
-- 011_storage_buckets.sql — Supabase Storage buckets backing Drift file uploads.
--
-- What broke (2026-09-29): the app uploads binary files (Files app, Videos app)
-- to the `user-files` bucket and custom wallpapers to `user-wallpapers`, under
-- paths prefixed with the owner's auth user id — but neither bucket existed in
-- the project, so every binary upload failed. A second, client-side bug
-- (FilesApp cleared the file input before snapshotting its live FileList, so
-- uploads silently no-op'd) was fixed in the app code alongside this migration.
--
-- This migration is idempotent: safe to run on fresh projects and on projects
-- where the buckets/policies were already created by hand.
--
-- Security model: both buckets are private, and the four policies below give an
-- authenticated user access only to objects whose first path segment equals
-- their own auth.uid() — the app always uploads to `<uid>/...`. Cross-user
-- reads/writes are rejected by RLS (verified: upload to another user's path
-- fails, own path succeeds).

-- Buckets (private).
insert into storage.buckets (id, name, public)
values ('user-files', 'user-files', false),
       ('user-wallpapers', 'user-wallpapers', false)
on conflict (id) do nothing;

-- Owner-only access policies on storage.objects. Dropped first so re-runs
-- converge instead of erroring on duplicate policy names.
drop policy if exists "users own objects (select)" on storage.objects;
drop policy if exists "users own objects (insert)" on storage.objects;
drop policy if exists "users own objects (update)" on storage.objects;
drop policy if exists "users own objects (delete)" on storage.objects;

create policy "users own objects (select)"
  on storage.objects for select to authenticated
  using ((storage.foldername(name))[1] = (auth.uid())::text);

create policy "users own objects (insert)"
  on storage.objects for insert to authenticated
  with check ((storage.foldername(name))[1] = (auth.uid())::text);

create policy "users own objects (update)"
  on storage.objects for update to authenticated
  using ((storage.foldername(name))[1] = (auth.uid())::text)
  with check ((storage.foldername(name))[1] = (auth.uid())::text);

create policy "users own objects (delete)"
  on storage.objects for delete to authenticated
  using ((storage.foldername(name))[1] = (auth.uid())::text);

-- ===== FILE: supabase/migrations/012_*.sql ======
-- 012_guest_username_collision.sql
--
-- Make handle_new_user() resilient to guest username collisions.
--
-- Root cause (2026-09-29): guest usernames came from a client-generated tag.
-- crypto.randomUUID() requires a secure context; on plain-HTTP pages the
-- fallback sliced 6 chars off a timestamp whose leading digits are stable for
-- ~an hour, so every anonymous signup in that window sent the SAME username.
-- The plain INSERT below then raised 23505 on profiles_username_key and
-- GoTrue returned HTTP 500 "Database error creating anonymous user" for
-- every signup after the first one claimed the name.
--
-- The client now generates collision-safe tags, but the trigger is the last
-- line of defense: on a username collision it retries with a random suffix
-- instead of aborting the whole signup.

create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer as $$
declare
  is_first  boolean;
  uname     text;
  is_g      boolean;
  attempt   int := 0;
  uname_try text;
begin
  select count(*) = 0 into is_first from public.profiles;
  is_g := coalesce((new.raw_user_meta_data ->> 'is_guest')::boolean, false);
  uname := coalesce(
    nullif(new.raw_user_meta_data ->> 'username', ''),
    nullif(split_part(new.email, '@', 1), ''),
    'guest'
  );
  -- Retry with a random suffix when the username is already taken; without
  -- this a collision aborts the entire signup with a 500.
  uname_try := uname;
  loop
    begin
      insert into public.profiles
        (id, username, role, is_guest, trial_started_at, trial_ends_at)
      values
        (new.id, uname_try,
         case
           when is_first then 'admin'
           when new.email is not null and lower(new.email) = 'admin@drift-shop.app' then 'admin'
           else 'standard'
         end,
         is_g,
         case when is_g then now() else null end,
         case when is_g then now() + interval '30 minutes' else null end);
      exit;
    exception when unique_violation then
      attempt := attempt + 1;
      if attempt > 5 then
        raise;
      end if;
      uname_try := uname || '_' || substr(md5(random()::text), 1, 6);
    end;
  end loop;
  insert into public.user_settings (user_id) values (new.id);
  insert into public.vfs_folders (user_id, parent_id, name)
  values (new.id, null, 'root');
  insert into public.spaces (user_id, name, sort_order)
  values (new.id, 'Main', 0),
         (new.id, 'Focus', 1),
         (new.id, 'Play', 2);
  return new;
end $$;

-- ===== FILE: supabase/migrations/013_*.sql ======
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

-- ===== FILE: supabase/migrations/014_*.sql ======
-- 014_bouquinerie_hardening.sql
-- Hardening fixes from the 2026-09-29 adversarial stress test.
--
-- Fixes:
--   1. bq_donation_items: cross-owner linking. The old policy checked only
--      that the DONATION belonged to the caller, so user A could link user B's
--      catalogue item into A's donation. The policy now requires BOTH the
--      donation and the item to belong to the authenticated user.
--   2. bq_fair_sales: same class of bug. The old policy checked only the FAIR's
--      ownership, so user A could record a sale of user B's item under A's own
--      fair. When item_id is set, the item must also belong to the caller.
--   3. Blank-but-not-NULL text: bq_items.title='', bq_special_orders.customer_name='',
--      bq_fairs.name='', bq_fair_sales.title='' were all accepted (201). Required
--      human-readable fields now reject empty/whitespace-only strings.
--
-- Idempotent: safe to re-run. Run in the Supabase dashboard SQL editor.
-- NOTE: if any existing rows violate the new non-blank constraints, the
-- ALTER TABLE will fail listing the offending row — clean those rows first.

-- ---------- 1. donation_items: both sides must belong to caller ----------
drop policy if exists "bq_donation_items_owner_all" on public.bq_donation_items;
create policy "bq_donation_items_owner_all" on public.bq_donation_items
  for all using (
    exists (select 1 from public.bq_donations d
            where d.id = donation_id and d.owner_id = auth.uid())
    and exists (select 1 from public.bq_items i
            where i.id = item_id and i.owner_id = auth.uid())
  ) with check (
    exists (select 1 from public.bq_donations d
            where d.id = donation_id and d.owner_id = auth.uid())
    and exists (select 1 from public.bq_items i
            where i.id = item_id and i.owner_id = auth.uid())
  );

-- ---------- 2. fair_sales: item must belong to caller when set ----------
drop policy if exists "bq_fair_sales_owner_all" on public.bq_fair_sales;
create policy "bq_fair_sales_owner_all" on public.bq_fair_sales
  for all using (
    exists (select 1 from public.bq_fairs f
            where f.id = fair_id and f.owner_id = auth.uid())
    and (item_id is null
         or exists (select 1 from public.bq_items i
                    where i.id = item_id and i.owner_id = auth.uid()))
  ) with check (
    exists (select 1 from public.bq_fairs f
            where f.id = fair_id and f.owner_id = auth.uid())
    and (item_id is null
         or exists (select 1 from public.bq_items i
                    where i.id = item_id and i.owner_id = auth.uid()))
  );

-- ---------- 3. non-blank constraints on required text ----------
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'bq_items_title_nonblank') then
    alter table public.bq_items
      add constraint bq_items_title_nonblank check (length(btrim(title)) > 0);
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'bq_fairs_name_nonblank') then
    alter table public.bq_fairs
      add constraint bq_fairs_name_nonblank check (length(btrim(name)) > 0);
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'bq_fair_sales_title_nonblank') then
    alter table public.bq_fair_sales
      add constraint bq_fair_sales_title_nonblank check (length(btrim(title)) > 0);
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'bq_special_orders_customer_nonblank') then
    alter table public.bq_special_orders
      add constraint bq_special_orders_customer_nonblank check (length(btrim(customer_name)) > 0);
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'bq_special_orders_title_nonblank') then
    alter table public.bq_special_orders
      add constraint bq_special_orders_title_nonblank check (length(btrim(title)) > 0);
  end if;
end $$;

-- donor_name is optional (nullable); only forbid whitespace-only when present.
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'bq_donations_donor_nonblank') then
    alter table public.bq_donations
      add constraint bq_donations_donor_nonblank
      check (donor_name is null or length(btrim(donor_name)) > 0);
  end if;
end $$;
