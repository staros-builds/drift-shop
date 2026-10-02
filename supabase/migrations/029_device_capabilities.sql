-- 029_device_capabilities.sql
-- Server-side capability boundaries for account types, applied to functions
-- and policies that already exist live (migrations 002/004/007).
--
-- Threat model: a device session token sits on shared, often unattended
-- hardware. The kiosk UI hides everything else, but the token itself is a
-- full cashier session — anyone who extracts it (or escapes the kiosk)
-- could call any permitted RPC directly. So the server refuses out-of-role
-- calls regardless of what the client shows:
--   punch accounts: punch clock in/out only — never sales, gift cards, stock
--   pos accounts:   register work only — never punch in/out, never void
-- (migrations 024/026/028 already carry these guards for their own RPCs;
--  the helpers live in 020.)

-- A POS register must never punch staff in or out: buddy-punching via a
-- stolen register token is a payroll fraud vector. Punch pads (punch) and
-- the desktop (full/staff) keep working; the PIN throttle from 023 still
-- applies at the staffLogin step before these are reached.
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
  -- Registers don't punch: only punch pads and the desktop may clock in.
  perform public.require_account_type('full', 'staff', 'punch');
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
  -- Registers don't punch: only punch pads and the desktop may clock out.
  perform public.require_account_type('full', 'staff', 'punch');
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
  limit 1
  for update;
  if not found then
    raise exception 'not punched in';
  end if;
  update public.pos_time_punches
  set punch_out = now()
  where id = v_punch_id and punch_out is null
  returning punch_out into v_punch_out;
  if not found then
    raise exception 'not punched in';
  end if;
  return query select v_punch_id, v_staff_id, v_staff_name, v_punch_in, v_punch_out;
end $$;

revoke all on function public.pos_clock_in(uuid, text) from public, anon;
revoke all on function public.pos_clock_out(uuid, text) from public, anon;
grant execute on function public.pos_clock_in(uuid, text) to authenticated;
grant execute on function public.pos_clock_out(uuid, text) to authenticated;

-- A punch pad must never record sales: its token could otherwise fabricate
-- sales (and move inventory/cash figures) via a direct API call.
drop policy if exists "pos_sales_member_insert" on public.pos_sales;
create policy "pos_sales_member_insert"
  on public.pos_sales for insert
  with check (
    public.is_pos_member(store_id)
    and public.caller_account_type() <> 'punch'
  );
