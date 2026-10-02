-- 076_appointment_no_overlap.sql — QA schema FAIL: the same staff member
-- could be double-booked (overlap check was client-side only).
--
-- Server-side guard: a BEFORE INSERT/UPDATE trigger serializes on the
-- staff row, then refuses an overlapping active appointment for the
-- same (store, staff). Trigger path chosen over a btree_gist exclusion
-- constraint so the rule holds on every Postgres (no extension
-- dependency); semantics are identical, and back-to-back appointments
-- stay legal ('[)' range logic: ends_at = next starts_at is fine).
-- Cancelled/completed/no-show rows free the slot; unassigned
-- (staff_id NULL) appointments are exempt. Idempotent: safe to re-run.

create index if not exists pos_appointments_store_staff_starts
  on public.pos_appointments (store_id, staff_id, starts_at);

create or replace function public.pos_appointments_no_overlap()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.staff_id is null or new.status not in ('scheduled', 'confirmed') then
    return new;
  end if;

  -- Serialize concurrent bookings for this staff member.
  perform 1 from public.pos_staff where id = new.staff_id for update;

  if exists (
    select 1
      from public.pos_appointments a
     where a.store_id = new.store_id
       and a.staff_id = new.staff_id
       and a.id <> new.id
       and a.status in ('scheduled', 'confirmed')
       and a.starts_at < new.ends_at
       and new.starts_at < a.ends_at
  ) then
    raise exception 'appointment overlaps an existing booking for this staff member';
  end if;

  return new;
end;
$$;

drop trigger if exists pos_appointments_no_overlap on public.pos_appointments;
create trigger pos_appointments_no_overlap
  before insert or update of staff_id, starts_at, ends_at, status
  on public.pos_appointments
  for each row execute function public.pos_appointments_no_overlap();
