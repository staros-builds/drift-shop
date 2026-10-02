-- Migration 042: Database-level shift end-after-start enforcement.
--
-- The JS backend wrapper validates that shift end > start, but there is no
-- database constraint. A direct SQL insert could create an invalid shift
-- with end <= start. This adds a CHECK constraint for defense-in-depth.

-- First, fix any existing invalid rows (set end = start + 1 hour if invalid).
-- This is a safety measure; in practice there should be none.
update public.pos_shifts
set "end" = (
  select to_char(
    (('2000-01-01 ' || start)::timestamp + interval '1 hour')::time,
    'HH24:MI'
  )
)
where "end" <= start;

-- Add the check constraint.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'pos_shifts_end_after_start'
    and conrelid = 'public.pos_shifts'::regclass
  ) then
    alter table public.pos_shifts
      add constraint pos_shifts_end_after_start
      check ("end" > start);
  end if;
end $$;

-- Verify.
do $$
declare
  v_has boolean;
begin
  select exists (
    select 1 from pg_constraint
    where conname = 'pos_shifts_end_after_start'
    and conrelid = 'public.pos_shifts'::regclass
  ) into v_has;
  if not v_has then
    raise exception 'migration 042 failed: constraint not created';
  end if;
  raise notice 'migration 042 applied: pos_shifts_end_after_start constraint active';
end $$;
