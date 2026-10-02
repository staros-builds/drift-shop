-- 031_punch_hr_tables.sql
--
-- Backend tables for the Poinçon (time clock) HR features. The Poinçon app
-- was written against these APIs but the tables/RPCs were never created,
-- so the Feuilles/Horaire/Congés/Paie/Réglages tabs failed with
-- "… is not a function". This migration completes the backend.
--
--   pos_breaks: paid/unpaid break segments inside a punch. Writes go through
--     PIN-verifying SECURITY DEFINER RPCs (same model as pos_time_punches).
--   pos_shifts: scheduled shifts (staff_id, date, HH:MM start/end, note).
--   pos_time_off: vacation/sick/unpaid requests (pending → approved/denied).
--   pos_pay_periods: approved (locked) pay periods for payroll.
--   pos_punch_settings: per-store terminal settings (week start, break
--     lengths, grace minutes). One row per store.
--
-- RLS follows the team model: members read; managers write, except breaks
-- (PIN-verified RPCs) and time-off requests (any member may file their own,
-- PIN-verified; only managers decide).

-- ============ pos_breaks ============

create table if not exists public.pos_breaks (
  id         uuid primary key default gen_random_uuid(),
  store_id   uuid not null references public.pos_stores(id) on delete cascade,
  staff_id   uuid not null references public.pos_staff(id) on delete cascade,
  punch_id   uuid references public.pos_time_punches(id) on delete set null,
  type       text not null check (type in ('paid', 'unpaid')),
  start      timestamptz not null default now(),
  "end"      timestamptz,
  created_at timestamptz not null default now(),
  check ("end" is null or "end" > start)
);
create index if not exists pos_breaks_store on public.pos_breaks (store_id, start desc);
create index if not exists pos_breaks_staff on public.pos_breaks (staff_id, start desc);
-- Race-safe: at most one open break per staff member.
create unique index if not exists pos_breaks_one_open
  on public.pos_breaks (staff_id) where "end" is null;

alter table public.pos_breaks enable row level security;

-- Reads: any member sees breaks (the shared terminal shows who's on break).
-- There are intentionally NO direct insert/update/delete policies: every
-- write goes through the RPCs below, which verify the staff PIN server-side.
drop policy if exists "pos_breaks_member_select" on public.pos_breaks;
create policy "pos_breaks_member_select"
  on public.pos_breaks for select
  using (public.is_pos_member(store_id));
drop policy if exists "pos_breaks_member_insert" on public.pos_breaks;
drop policy if exists "pos_breaks_member_update" on public.pos_breaks;
drop policy if exists "pos_breaks_member_delete" on public.pos_breaks;

-- Start a break: verify PIN, require an open punch, one open break max.
create or replace function public.pos_break_start(p_store_id uuid, p_pin_hash text, p_type text)
returns table (id uuid, staff_id uuid, punch_id uuid, type text, start timestamptz)
language plpgsql security definer
set search_path = public
as $$
declare
  v_staff_id uuid;
  v_punch_id uuid;
  v_break_id uuid;
  v_start    timestamptz;
begin
  if auth.uid() is null then
    raise exception 'sign in to start a break';
  end if;
  if not public.is_pos_member(p_store_id) then
    raise exception 'not a member of this store';
  end if;
  if p_type not in ('paid', 'unpaid') then
    raise exception 'break type must be paid or unpaid';
  end if;
  select s.id into v_staff_id
  from public.pos_staff s
  where s.store_id = p_store_id and s.active and s.pin_hash = p_pin_hash
  limit 1;
  if not found then
    raise exception 'invalid PIN';
  end if;
  select p.id into v_punch_id
  from public.pos_time_punches p
  where p.staff_id = v_staff_id and p.punch_out is null
  order by p.punch_in desc
  limit 1;
  if not found then
    raise exception 'Not punched in.';
  end if;
  insert into public.pos_breaks (store_id, staff_id, punch_id, type)
  values (p_store_id, v_staff_id, v_punch_id, p_type)
  returning pos_breaks.id, pos_breaks.start
  into v_break_id, v_start;
  return query select v_break_id, v_staff_id, v_punch_id, p_type, v_start;
exception
  when unique_violation then
    raise exception 'a break is already open';
end $$;

-- End the currently open break for the PIN holder.
create or replace function public.pos_break_end(p_store_id uuid, p_pin_hash text)
returns table (id uuid, staff_id uuid, punch_id uuid, type text, start timestamptz, "end" timestamptz)
language plpgsql security definer
set search_path = public
as $$
declare
  v_staff_id uuid;
  v_row      public.pos_breaks%rowtype;
begin
  if auth.uid() is null then
    raise exception 'sign in to end a break';
  end if;
  if not public.is_pos_member(p_store_id) then
    raise exception 'not a member of this store';
  end if;
  select s.id into v_staff_id
  from public.pos_staff s
  where s.store_id = p_store_id and s.active and s.pin_hash = p_pin_hash
  limit 1;
  if not found then
    raise exception 'invalid PIN';
  end if;
  update public.pos_breaks
  set "end" = now()
  where pos_breaks.staff_id = v_staff_id and pos_breaks."end" is null
  returning pos_breaks.* into v_row;
  if not found then
    raise exception 'no open break';
  end if;
  return query select v_row.id, v_row.staff_id, v_row.punch_id, v_row.type, v_row.start, v_row."end";
end $$;

-- ============ pos_shifts (schedule) ============

create table if not exists public.pos_shifts (
  id         uuid primary key default gen_random_uuid(),
  store_id   uuid not null references public.pos_stores(id) on delete cascade,
  staff_id   uuid not null references public.pos_staff(id) on delete cascade,
  ymd        date not null,
  start      text not null check (start ~ '^[0-2][0-9]:[0-5][0-9]$'),
  "end"      text not null check ("end" ~ '^[0-2][0-9]:[0-5][0-9]$'),
  note       text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists pos_shifts_store_date on public.pos_shifts (store_id, ymd);
create index if not exists pos_shifts_staff_date on public.pos_shifts (staff_id, ymd);

alter table public.pos_shifts enable row level security;

drop policy if exists "pos_shifts_member_select" on public.pos_shifts;
create policy "pos_shifts_member_select"
  on public.pos_shifts for select
  using (public.is_pos_member(store_id));

drop policy if exists "pos_shifts_manager_insert" on public.pos_shifts;
create policy "pos_shifts_manager_insert"
  on public.pos_shifts for insert
  with check (public.pos_role(store_id) in ('owner', 'manager'));

drop policy if exists "pos_shifts_manager_update" on public.pos_shifts;
create policy "pos_shifts_manager_update"
  on public.pos_shifts for update
  using (public.pos_role(store_id) in ('owner', 'manager'))
  with check (public.pos_role(store_id) in ('owner', 'manager'));

drop policy if exists "pos_shifts_manager_delete" on public.pos_shifts;
create policy "pos_shifts_manager_delete"
  on public.pos_shifts for delete
  using (public.pos_role(store_id) in ('owner', 'manager'));

-- ============ pos_time_off ============

create table if not exists public.pos_time_off (
  id          uuid primary key default gen_random_uuid(),
  store_id    uuid not null references public.pos_stores(id) on delete cascade,
  staff_id    uuid not null references public.pos_staff(id) on delete cascade,
  kind        text not null check (kind in ('vacation', 'sick', 'unpaid')),
  from_date   date not null,
  to_date     date not null check (to_date >= from_date),
  reason      text not null default '',
  status      text not null default 'pending' check (status in ('pending', 'approved', 'denied')),
  decided_by  text,
  decided_at  timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists pos_time_off_store on public.pos_time_off (store_id, from_date);
create index if not exists pos_time_off_staff on public.pos_time_off (staff_id, from_date);

alter table public.pos_time_off enable row level security;

-- Any member reads requests; any member may file one (the backend verifies
-- the staff PIN, so requests are always filed as the PIN holder).
drop policy if exists "pos_time_off_member_select" on public.pos_time_off;
create policy "pos_time_off_member_select"
  on public.pos_time_off for select
  using (public.is_pos_member(store_id));

drop policy if exists "pos_time_off_member_insert" on public.pos_time_off;
create policy "pos_time_off_member_insert"
  on public.pos_time_off for insert
  with check (public.is_pos_member(store_id));

-- Only owners/managers decide or remove requests.
drop policy if exists "pos_time_off_manager_update" on public.pos_time_off;
create policy "pos_time_off_manager_update"
  on public.pos_time_off for update
  using (public.pos_role(store_id) in ('owner', 'manager'))
  with check (public.pos_role(store_id) in ('owner', 'manager'));

drop policy if exists "pos_time_off_manager_delete" on public.pos_time_off;
create policy "pos_time_off_manager_delete"
  on public.pos_time_off for delete
  using (public.pos_role(store_id) in ('owner', 'manager'));

-- File a time-off request as the PIN holder. The PIN is verified
-- server-side so pin_hash never needs a broad read policy; any store
-- member may file their own request, only managers decide.
create or replace function public.pos_timeoff_submit(
  p_store_id uuid, p_pin_hash text, p_kind text, p_from date, p_to date, p_reason text
)
returns table (id uuid)
language plpgsql security definer
set search_path = public
as $$
declare
  v_staff_id uuid;
  v_id       uuid;
begin
  if auth.uid() is null then
    raise exception 'sign in to request time off';
  end if;
  if not public.is_pos_member(p_store_id) then
    raise exception 'not a member of this store';
  end if;
  if p_kind not in ('vacation', 'sick', 'unpaid') then
    raise exception 'request kind must be vacation, sick or unpaid';
  end if;
  if p_to < p_from then
    raise exception 'the end date is before the start date';
  end if;
  select s.id into v_staff_id
  from public.pos_staff s
  where s.store_id = p_store_id and s.active and s.pin_hash = p_pin_hash
  limit 1;
  if not found then
    raise exception 'invalid PIN';
  end if;
  insert into public.pos_time_off (store_id, staff_id, kind, from_date, to_date, reason)
  values (p_store_id, v_staff_id, p_kind, p_from, p_to, coalesce(p_reason, ''))
  returning pos_time_off.id into v_id;
  return query select v_id;
end $$;

-- ============ pos_pay_periods ============

create table if not exists public.pos_pay_periods (
  id          uuid primary key default gen_random_uuid(),
  store_id    uuid not null references public.pos_stores(id) on delete cascade,
  from_date   date not null,
  to_date     date not null check (to_date >= from_date),
  status      text not null default 'open' check (status in ('open', 'approved')),
  approved_by text,
  approved_at timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists pos_pay_periods_store on public.pos_pay_periods (store_id, from_date);

alter table public.pos_pay_periods enable row level security;

drop policy if exists "pos_pay_periods_member_select" on public.pos_pay_periods;
create policy "pos_pay_periods_member_select"
  on public.pos_pay_periods for select
  using (public.is_pos_member(store_id));

drop policy if exists "pos_pay_periods_manager_insert" on public.pos_pay_periods;
create policy "pos_pay_periods_manager_insert"
  on public.pos_pay_periods for insert
  with check (public.pos_role(store_id) in ('owner', 'manager'));

drop policy if exists "pos_pay_periods_manager_update" on public.pos_pay_periods;
create policy "pos_pay_periods_manager_update"
  on public.pos_pay_periods for update
  using (public.pos_role(store_id) in ('owner', 'manager'))
  with check (public.pos_role(store_id) in ('owner', 'manager'));

drop policy if exists "pos_pay_periods_manager_delete" on public.pos_pay_periods;
create policy "pos_pay_periods_manager_delete"
  on public.pos_pay_periods for delete
  using (public.pos_role(store_id) in ('owner', 'manager'));

-- ============ pos_punch_settings ============
create table if not exists public.pos_punch_settings (
  store_id         uuid primary key references public.pos_stores(id) on delete cascade,
  week_start       text not null default 'monday' check (week_start in ('monday', 'sunday')),
  paid_break_min   integer not null default 15 check (paid_break_min >= 0 and paid_break_min <= 480),
  unpaid_break_min integer not null default 30 check (unpaid_break_min >= 0 and unpaid_break_min <= 480),
  grace_min        integer not null default 15 check (grace_min >= 0 and grace_min <= 480),
  updated_at       timestamptz not null default now()
);

alter table public.pos_punch_settings enable row level security;

drop policy if exists "pos_punch_settings_member_select" on public.pos_punch_settings;
create policy "pos_punch_settings_member_select"
  on public.pos_punch_settings for select
  using (public.is_pos_member(store_id));

drop policy if exists "pos_punch_settings_manager_upsert" on public.pos_punch_settings;
create policy "pos_punch_settings_manager_upsert"
  on public.pos_punch_settings for insert
  with check (public.pos_role(store_id) in ('owner', 'manager'));

drop policy if exists "pos_punch_settings_manager_update" on public.pos_punch_settings;
create policy "pos_punch_settings_manager_update"
  on public.pos_punch_settings for update
  using (public.pos_role(store_id) in ('owner', 'manager'))
  with check (public.pos_role(store_id) in ('owner', 'manager'));
