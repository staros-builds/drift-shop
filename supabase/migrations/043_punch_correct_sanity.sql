-- 043: Harden pos_punch_correct against absurd/future shift times.
--
-- BUG (found 2026-09-30 during adversarial testing): pos_punch_correct only
-- checked that punch_out > punch_in. A manager could set punch_in = 2020-01-01,
-- punch_out = 2030-01-01 (10-year shift) and payroll math would sum it uncapped.
-- Future-dated punches were also accepted silently.
--
-- FIX: reject corrections where punch_in is more than 1 day in the future,
-- where the shift exceeds 24 hours, or where punch_out is in the future.

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
  -- Lock check covers old AND new dates: moving a punch into (or out of)
  -- a locked period is forbidden.
  if exists (
    select 1 from public.pos_pay_periods pp
    where pp.store_id = v_store_id
      and pp.status = 'approved'
      and ((v_old_in::date) between pp.from_date and pp.to_date
           or (p_punch_in::date) between pp.from_date and pp.to_date
           or (p_punch_out::date) between pp.from_date and pp.to_date)
  ) then
    raise exception 'Pay period is locked.';
  end if;
  if p_punch_out is not null and p_punch_out <= p_punch_in then
    raise exception 'punch out must be after punch in';
  end if;
  -- NEW: sanity checks against absurd/future times (043).
  if p_punch_in > now() + interval '1 day' then
    raise exception 'punch in cannot be in the future';
  end if;
  if p_punch_out is not null and p_punch_out > now() + interval '1 day' then
    raise exception 'punch out cannot be in the future';
  end if;
  if p_punch_out is not null and (p_punch_out - p_punch_in) > interval '24 hours' then
    raise exception 'shift cannot exceed 24 hours';
  end if;
  insert into public.pos_punch_audits
    (store_id, punch_id, action, edited_by, old_punch_in, old_punch_out, new_punch_in, new_punch_out)
  values
    (v_store_id, p_punch_id, 'correct', auth.uid(),
     v_old_in, v_old_out, p_punch_in, p_punch_out);
  update public.pos_time_punches
  set punch_in = p_punch_in, punch_out = p_punch_out
  where pos_time_punches.id = p_punch_id;
  return query
  select p.id, p.staff_id, p.punch_in, p.punch_out
  from public.pos_time_punches p
  where p.id = p_punch_id;
end $$;
