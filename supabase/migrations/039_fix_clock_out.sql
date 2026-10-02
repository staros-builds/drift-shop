-- Migration 039: Fix live pos_clock_out (s.staff_id bug)
-- The live pos_clock_out has "select s.id, s.staff_id, s.name" which fails
-- because pos_staff has no staff_id column. Replace with the correct 033 version.

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
