-- 038: Fix pay-period lock bypass in pos_punch_correct.
--
-- BUG: pos_punch_correct checked only the OLD punch_in date against locked
-- pay periods. A manager could move a punch INTO a locked period by changing
-- its date (e.g., Sept 28 -> Sept 15 where Sept 1-15 is approved/locked).
-- The check must cover the new dates as well.
--
-- FIX: Check old punch_in, new punch_in, AND new punch_out against locked
-- periods. If any of them falls in a locked period, reject.

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
