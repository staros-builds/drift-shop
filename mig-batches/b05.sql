-- BATCH b05 : schema.sql part B (007 time clock + 009 appointments)
-- ===== FILE: supabase/schema.sql [lines 494-738] ======
-- ---------- 007: PIN-verified time clock (secure revision) ----------
-- 007_time_clock.sql
-- PIN-verified employee time clock for the POS suite (secure revision).
--
-- All punch writes go through SECURITY DEFINER RPCs that verify the staff
-- PIN server-side — the table itself allows NO direct writes, so a client
-- can never punch in as someone else, edit hours, or bypass the PIN.
--
--   pos_time_punches: one row per shift segment — id, store_id,
--     staff_id (null if the staff row was deleted), punch_in,
--     punch_out (null = currently clocked in), created_at.
--   pos_punch_audits: manager correction/deletion log — punch_id, action
--     ('correct' | 'delete'), edited_by, old/new punch_in/out, created_at.
--
-- RPCs:
--   pos_clock_in(p_store_id, p_pin_hash)    — verify PIN, open a shift.
--   pos_clock_out(p_store_id, p_pin_hash)   — verify PIN, close the shift.
--   pos_punch_correct(p_punch_id, p_punch_in, p_punch_out) — owner/manager
--     correction; the old values are written to pos_punch_audits.
--   pos_punch_delete(p_punch_id)            — owner/manager delete; logged.
--
-- Reads: any store member may read punches (the shared terminal shows hours)
-- and managers may read the audit log.

create table if not exists public.pos_time_punches (
  id         uuid primary key default gen_random_uuid(),
  store_id   uuid not null references public.pos_stores(id) on delete cascade,
  staff_id   uuid references public.pos_staff(id) on delete set null,
  punch_in   timestamptz not null default now(),
  punch_out  timestamptz,
  created_at timestamptz not null default now(),
  check (punch_out is null or punch_out > punch_in)
);

create index if not exists pos_punches_store on public.pos_time_punches (store_id, punch_in desc);
create index if not exists pos_punches_staff on public.pos_time_punches (staff_id, punch_in desc);

-- Race-safe: at most one open shift per staff member, enforced by the
-- database itself (two terminals punching the same PIN at once can't both win).
create unique index if not exists pos_punches_one_open
  on public.pos_time_punches (staff_id) where punch_out is null;

create table if not exists public.pos_punch_audits (
  id           uuid primary key default gen_random_uuid(),
  store_id     uuid not null references public.pos_stores(id) on delete cascade,
  punch_id     uuid,
  action       text not null check (action in ('correct', 'delete')),
  edited_by    uuid references auth.users(id) on delete set null,
  old_punch_in timestamptz,
  old_punch_out timestamptz,
  new_punch_in timestamptz,
  new_punch_out timestamptz,
  created_at   timestamptz not null default now()
);

create index if not exists pos_punch_audits_store on public.pos_punch_audits (store_id, created_at desc);

alter table public.pos_time_punches enable row level security;
alter table public.pos_punch_audits enable row level security;

-- Reads: any member sees punches; only owners/managers see the audit log.
-- There are intentionally NO insert/update/delete policies: every write goes
-- through the RPCs below, which run as SECURITY DEFINER and verify the PIN
-- (or the manager role) on the server.
drop policy if exists "pos_punches_member_select" on public.pos_time_punches;
create policy "pos_punches_member_select"
  on public.pos_time_punches for select
  using (public.is_pos_member(store_id));

drop policy if exists "pos_punches_member_insert" on public.pos_time_punches;
drop policy if exists "pos_punches_member_update" on public.pos_time_punches;
drop policy if exists "pos_punches_member_delete" on public.pos_time_punches;

drop policy if exists "pos_punch_audits_manager_select" on public.pos_punch_audits;
create policy "pos_punch_audits_manager_select"
  on public.pos_punch_audits for select
  using (public.pos_role(store_id) in ('owner', 'manager'));

-- ---------- RPCs ----------

-- Verify the PIN and open a shift for that staff member only.
create or replace function public.pos_clock_in(p_store_id uuid, p_pin_hash text)
returns table (id uuid, staff_id uuid, staff_name text, punch_in timestamptz)
language plpgsql security definer
set search_path = public
as $$
declare
  v_staff_id   uuid;
  v_staff_name text;
  v_punch_id   uuid;
  v_punch_in   timestamptz;
begin
  if auth.uid() is null then
    raise exception 'sign in to punch in';
  end if;
  if not public.is_pos_member(p_store_id) then
    raise exception 'not a member of this store';
  end if;
  select s.id, s.name into v_staff_id, v_staff_name
  from public.pos_staff s
  where s.store_id = p_store_id and s.active and s.pin_hash = p_pin_hash
  limit 1;
  if not found then
    raise exception 'invalid PIN';
  end if;
  if exists (
    select 1 from public.pos_time_punches p
    where p.staff_id = v_staff_id and p.punch_out is null
  ) then
    raise exception 'already punched in';
  end if;
  insert into public.pos_time_punches (store_id, staff_id)
  values (p_store_id, v_staff_id)
  returning pos_time_punches.id, pos_time_punches.punch_in
  into v_punch_id, v_punch_in;
  return query select v_punch_id, v_staff_id, v_staff_name, v_punch_in;
exception
  when unique_violation then
    raise exception 'already punched in';
end $$;

-- Verify the PIN and close that staff member's open shift.
create or replace function public.pos_clock_out(p_store_id uuid, p_pin_hash text)
returns table (id uuid, staff_id uuid, staff_name text, punch_in timestamptz, punch_out timestamptz)
language plpgsql security definer
set search_path = public
as $$
declare
  v_staff_id   uuid;
  v_staff_name text;
  v_punch_id   uuid;
  v_punch_in   timestamptz;
  v_punch_out  timestamptz;
begin
  if auth.uid() is null then
    raise exception 'sign in to punch out';
  end if;
  if not public.is_pos_member(p_store_id) then
    raise exception 'not a member of this store';
  end if;
  select s.id, s.name into v_staff_id, v_staff_name
  from public.pos_staff s
  where s.store_id = p_store_id and s.active and s.pin_hash = p_pin_hash
  limit 1;
  if not found then
    raise exception 'invalid PIN';
  end if;
  select p.id, p.punch_in into v_punch_id, v_punch_in
  from public.pos_time_punches p
  where p.store_id = p_store_id and p.staff_id = v_staff_id and p.punch_out is null
  limit 1;
  if not found then
    raise exception 'not punched in';
  end if;
  update public.pos_time_punches
  set punch_out = now()
  where id = v_punch_id
  returning punch_out into v_punch_out;
  return query select v_punch_id, v_staff_id, v_staff_name, v_punch_in, v_punch_out;
end $$;

-- Owner/manager correction of a punch, with the old values audited.
create or replace function public.pos_punch_correct(
  p_punch_id uuid, p_punch_in timestamptz, p_punch_out timestamptz
)
returns table (id uuid, staff_id uuid, punch_in timestamptz, punch_out timestamptz)
language plpgsql security definer
set search_path = public
as $$
declare
  v_store_id  uuid;
  v_staff_id  uuid;
  v_old_in    timestamptz;
  v_old_out   timestamptz;
begin
  if auth.uid() is null then
    raise exception 'sign in to correct punches';
  end if;
  select p.store_id, p.staff_id, p.punch_in, p.punch_out
  into v_store_id, v_staff_id, v_old_in, v_old_out
  from public.pos_time_punches p
  where p.id = p_punch_id
  limit 1;
  if not found then
    raise exception 'punch not found';
  end if;
  if not public.pos_role(v_store_id) in ('owner', 'manager') then
    raise exception 'managers only';
  end if;
  if p_punch_out is not null and p_punch_out <= p_punch_in then
    raise exception 'punch out must be after punch in';
  end if;
  insert into public.pos_punch_audits
    (store_id, punch_id, action, edited_by, old_punch_in, old_punch_out, new_punch_in, new_punch_out)
  values
    (v_store_id, p_punch_id, 'correct', auth.uid(),
     v_old_in, v_old_out, p_punch_in, p_punch_out);
  update public.pos_time_punches
  set punch_in = p_punch_in, punch_out = p_punch_out
  where id = p_punch_id;
  return query select p_punch_id, v_staff_id, p_punch_in, p_punch_out;
end $$;

-- Owner/manager deletion of a punch, audited.
create or replace function public.pos_punch_delete(p_punch_id uuid)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_store_id uuid;
  v_old_in   timestamptz;
  v_old_out  timestamptz;
begin
  if auth.uid() is null then
    raise exception 'sign in to delete punches';
  end if;
  select p.store_id, p.punch_in, p.punch_out
  into v_store_id, v_old_in, v_old_out
  from public.pos_time_punches p
  where p.id = p_punch_id
  limit 1;
  if not found then
    raise exception 'punch not found';
  end if;
  if not public.pos_role(v_store_id) in ('owner', 'manager') then
    raise exception 'managers only';
  end if;
  insert into public.pos_punch_audits
    (store_id, punch_id, action, edited_by, old_punch_in, old_punch_out)
  values
    (v_store_id, p_punch_id, 'delete', auth.uid(), v_old_in, v_old_out);
  delete from public.pos_time_punches where id = p_punch_id;
end $$;

revoke all on function public.pos_clock_in(uuid, text) from public;
grant execute on function public.pos_clock_in(uuid, text) to authenticated;
revoke all on function public.pos_clock_out(uuid, text) from public;
grant execute on function public.pos_clock_out(uuid, text) to authenticated;
revoke all on function public.pos_punch_correct(uuid, timestamptz, timestamptz) from public;
grant execute on function public.pos_punch_correct(uuid, timestamptz, timestamptz) to authenticated;
revoke all on function public.pos_punch_delete(uuid) from public;
grant execute on function public.pos_punch_delete(uuid) to authenticated;



-- ===== FILE: supabase/schema.sql [lines 843-1010] ======
-- ---------- 009: appointments (POS customer database) ----------
-- 009_appointments.sql
-- Appointment scheduling tied into the POS customer database.
--
--   pos_appointments: store_id, customer_id -> pos_customers (who it's for),
--     staff_id -> pos_staff (who it's with), title (service), notes,
--     starts_at / ends_at, status
--     (scheduled | confirmed | completed | cancelled | no_show),
--     created_by, created_at, updated_at.
--
-- RLS mirrors the POS pattern: any store member can read/book/update
-- appointments; only owners/managers can delete them.

create table if not exists public.pos_appointments (
  id          uuid primary key default gen_random_uuid(),
  store_id    uuid not null references public.pos_stores(id) on delete cascade,
  customer_id uuid references public.pos_customers(id) on delete set null,
  staff_id    uuid references public.pos_staff(id) on delete set null,
  title       text not null check (char_length(title) between 1 and 120),
  notes       text,
  starts_at   timestamptz not null,
  ends_at     timestamptz not null check (ends_at > starts_at),
  status      text not null default 'scheduled'
                check (status in ('scheduled', 'confirmed', 'completed',
                                  'cancelled', 'no_show')),
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists pos_appointments_store_time
  on public.pos_appointments (store_id, starts_at);
create index if not exists pos_appointments_customer
  on public.pos_appointments (customer_id, starts_at);

alter table public.pos_appointments enable row level security;

drop policy if exists "pos_appointments_member_select" on public.pos_appointments;
create policy "pos_appointments_member_select"
  on public.pos_appointments for select
  using (public.is_pos_member(store_id));

drop policy if exists "pos_appointments_member_insert" on public.pos_appointments;
create policy "pos_appointments_member_insert"
  on public.pos_appointments for insert
  with check (public.is_pos_member(store_id));

drop policy if exists "pos_appointments_member_update" on public.pos_appointments;
create policy "pos_appointments_member_update"
  on public.pos_appointments for update
  using (public.is_pos_member(store_id))
  with check (public.is_pos_member(store_id));

drop policy if exists "pos_appointments_manager_delete" on public.pos_appointments;
create policy "pos_appointments_manager_delete"
  on public.pos_appointments for delete
  using (public.pos_role(store_id) in ('owner', 'manager'));
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
