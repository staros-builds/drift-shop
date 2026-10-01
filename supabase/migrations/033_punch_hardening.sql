-- 033_punch_hardening.sql
--
-- Production hardening for the Poinçon (time clock) backend, from the
-- 2026-09-30 adversarial review:
--
--   1. PIN brute-force throttle on the five Poinçon PIN RPCs. Migration 023
--      throttled only pos_staff_login; pos_clock_in, pos_clock_out,
--      pos_break_start, pos_break_end and pos_timeoff_submit still allowed
--      unlimited PIN guesses. They now share the pos_pin_attempts log:
--      15 failures per store inside 10 minutes -> cooldown. The failure
--      row is INSERTed and the function RETURNS an empty set (never
--      "insert then raise" — the raise would roll the log row back; see
--      the critical note in 023). The client already maps an empty result
--      to "Invalid PIN", so behaviour is unchanged.
--   2. Approved (locked) pay periods now block punch corrections and
--      deletions. The Timesheets UI was already written to expect a
--      'Pay period is locked.' error (lockedErr mapper) but no migration
--      ever raised it — a manager could silently rewrite approved payroll.
--   3. Punching out auto-closes any open break at clock-out time. Before,
--      the break stayed open forever, inflating paid-break totals and
--      blocking the next break via the one-open-break unique index.
--   4. Shift times tightened to real clock hours (00:00-23:59). The old
--      check '^[0-2][0-9]:[0-5][0-9]$' accepted 24:00-29:59.
--   5. Direct INSERT into pos_time_off removed. Any member could insert a
--      request with a forged staff_id, bypassing the PIN check. Requests
--      now go only through pos_timeoff_submit (PIN-verified RPC), the same
--      model as pos_breaks and pos_time_punches.

-- ============ 1. shared throttle helper ============

create or replace function public.pos_pin_throttle_check(p_store_id uuid)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_failures int;
begin
  -- Housekeeping: drop yesterday's rows so the table stays tiny.
  -- (On the throttled path below this delete rolls back with the raise —
  -- harmless, it just runs on the next non-throttled call.)
  delete from public.pos_pin_attempts
   where attempted_at < now() - interval '1 day';
  -- 15 failures in 10 minutes -> cool down. Nothing has been written yet
  -- on this path, so the raise is safe here.
  select count(*) into v_failures
    from public.pos_pin_attempts
   where store_id = p_store_id
     and not success
     and attempted_at > now() - interval '10 minutes';
  if v_failures >= 15 then
    raise exception 'too many PIN attempts — wait a couple of minutes and try again';
  end if;
end $$;

revoke all on function public.pos_pin_throttle_check(uuid) from public, anon;

-- ============ 1a. pos_clock_in (throttled; was 029) ============

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
  perform public.pos_pin_throttle_check(p_store_id);
  -- Registers don't punch: only punch pads and the desktop may clock in.
  perform public.require_account_type('full', 'staff', 'punch');
  select s.id, s.name into v_staff_id, v_staff_name
  from public.pos_staff s
  where s.store_id = p_store_id and s.active and s.pin_hash = p_pin_hash
  limit 1;
  if not found then
    -- Failed PIN: log it and return an empty set. NO RAISE — the client
    -- maps "no rows" to "Invalid PIN" and the insert commits, which is
    -- what makes the throttle above actually work.
    insert into public.pos_pin_attempts (store_id, success)
    values (p_store_id, false);
    return;
  end if;
  -- Success resets the failure counter for the store.
  delete from public.pos_pin_attempts
   where store_id = p_store_id and not success;
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

-- ============ 1b. pos_clock_out (throttled + auto-close breaks; was 032) ============

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
  perform public.pos_pin_throttle_check(p_store_id);
  -- Registers don't punch: only punch pads and the desktop may clock out.
  perform public.require_account_type('full', 'staff', 'punch');
  select s.id, s.name into v_staff_id, v_staff_name
  from public.pos_staff s
  where s.store_id = p_store_id and s.active and s.pin_hash = p_pin_hash
  limit 1;
  if not found then
    -- Failed PIN: log it and return an empty set (see pos_clock_in).
    insert into public.pos_pin_attempts (store_id, success)
    values (p_store_id, false);
    return;
  end if;
  -- Success resets the failure counter for the store.
  delete from public.pos_pin_attempts
   where store_id = p_store_id and not success;
  select p.id, p.punch_in into v_punch_id, v_punch_in
  from public.pos_time_punches p
  where p.store_id = p_store_id and p.staff_id = v_staff_id and p.punch_out is null
  limit 1
  for update;
  if not found then
    raise exception 'not punched in';
  end if;
  update public.pos_time_punches
  set punch_out = now()
  where pos_time_punches.id = v_punch_id and pos_time_punches.punch_out is null
  returning pos_time_punches.punch_out into v_punch_out;
  if not found then
    raise exception 'not punched in';
  end if;
  -- An open break ends with the shift: close it at clock-out time so it
  -- neither inflates paid-break totals nor blocks the next break.
  update public.pos_breaks
  set "end" = v_punch_out
  where pos_breaks.staff_id = v_staff_id and pos_breaks."end" is null;
  return query select v_punch_id, v_staff_id, v_staff_name, v_punch_in, v_punch_out;
end $$;

-- ============ 1c. pos_break_start (throttled; was 031) ============

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
  perform public.pos_pin_throttle_check(p_store_id);
  if p_type not in ('paid', 'unpaid') then
    raise exception 'break type must be paid or unpaid';
  end if;
  select s.id into v_staff_id
  from public.pos_staff s
  where s.store_id = p_store_id and s.active and s.pin_hash = p_pin_hash
  limit 1;
  if not found then
    -- Failed PIN: log it and return an empty set (see pos_clock_in).
    insert into public.pos_pin_attempts (store_id, success)
    values (p_store_id, false);
    return;
  end if;
  -- Success resets the failure counter for the store.
  delete from public.pos_pin_attempts
   where store_id = p_store_id and not success;
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

-- ============ 1d. pos_break_end (throttled; was 031) ============

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
  perform public.pos_pin_throttle_check(p_store_id);
  select s.id into v_staff_id
  from public.pos_staff s
  where s.store_id = p_store_id and s.active and s.pin_hash = p_pin_hash
  limit 1;
  if not found then
    -- Failed PIN: log it and return an empty set (see pos_clock_in).
    insert into public.pos_pin_attempts (store_id, success)
    values (p_store_id, false);
    return;
  end if;
  -- Success resets the failure counter for the store.
  delete from public.pos_pin_attempts
   where store_id = p_store_id and not success;
  update public.pos_breaks
  set "end" = now()
  where pos_breaks.staff_id = v_staff_id and pos_breaks."end" is null
  returning pos_breaks.* into v_row;
  if not found then
    raise exception 'no open break';
  end if;
  return query select v_row.id, v_row.staff_id, v_row.punch_id, v_row.type, v_row.start, v_row."end";
end $$;

-- ============ 1e. pos_timeoff_submit (throttled; was 031) ============

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
  perform public.pos_pin_throttle_check(p_store_id);
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
    -- Failed PIN: log it and return an empty set (see pos_clock_in).
    insert into public.pos_pin_attempts (store_id, success)
    values (p_store_id, false);
    return;
  end if;
  -- Success resets the failure counter for the store.
  delete from public.pos_pin_attempts
   where store_id = p_store_id and not success;
  insert into public.pos_time_off (store_id, staff_id, kind, from_date, to_date, reason)
  values (p_store_id, v_staff_id, p_kind, p_from, p_to, coalesce(p_reason, ''))
  returning pos_time_off.id into v_id;
  return query select v_id;
end $$;

-- ============ 2. locked periods block punch edits (was 032 / 007) ============

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
  if exists (
    select 1 from public.pos_pay_periods pp
    where pp.store_id = v_store_id
      and pp.status = 'approved'
      and (v_old_in::date) between pp.from_date and pp.to_date
  ) then
    raise exception 'Pay period is locked.';
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
  where pos_time_punches.id = p_punch_id;
  return query select p_punch_id, v_staff_id, p_punch_in, p_punch_out;
end $$;

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
  if exists (
    select 1 from public.pos_pay_periods pp
    where pp.store_id = v_store_id
      and pp.status = 'approved'
      and (v_old_in::date) between pp.from_date and pp.to_date
  ) then
    raise exception 'Pay period is locked.';
  end if;
  insert into public.pos_punch_audits
    (store_id, punch_id, action, edited_by, old_punch_in, old_punch_out)
  values
    (v_store_id, p_punch_id, 'delete', auth.uid(), v_old_in, v_old_out);
  delete from public.pos_time_punches where id = p_punch_id;
end $$;

-- ============ 4. shift times must be real clock hours ============

alter table public.pos_shifts drop constraint if exists pos_shifts_start_check;
alter table public.pos_shifts
  add constraint pos_shifts_start_check check (start ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$');
alter table public.pos_shifts drop constraint if exists pos_shifts_end_check;
alter table public.pos_shifts
  add constraint pos_shifts_end_check check ("end" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$');

-- ============ 5. time-off requests only via the PIN-verified RPC ============

drop policy if exists "pos_time_off_member_insert" on public.pos_time_off;

-- Keep the grants from 007/023/029 on the redefined functions.
revoke all on function public.pos_clock_in(uuid, text) from public, anon;
revoke all on function public.pos_clock_out(uuid, text) from public, anon;
revoke all on function public.pos_break_start(uuid, text, text) from public, anon;
revoke all on function public.pos_break_end(uuid, text) from public, anon;
revoke all on function public.pos_timeoff_submit(uuid, text, text, date, date, text) from public, anon;
revoke all on function public.pos_punch_correct(uuid, timestamptz, timestamptz) from public, anon;
revoke all on function public.pos_punch_delete(uuid) from public, anon;
grant execute on function public.pos_clock_in(uuid, text) to authenticated;
grant execute on function public.pos_clock_out(uuid, text) to authenticated;
grant execute on function public.pos_break_start(uuid, text, text) to authenticated;
grant execute on function public.pos_break_end(uuid, text) to authenticated;
grant execute on function public.pos_timeoff_submit(uuid, text, text, date, date, text) to authenticated;
grant execute on function public.pos_punch_correct(uuid, timestamptz, timestamptz) to authenticated;
grant execute on function public.pos_punch_delete(uuid) to authenticated;
