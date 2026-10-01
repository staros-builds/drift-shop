-- Migration 048: Fix overnight shift support (22:00-06:00)
--
-- NUCLEAR FAILSAFE: Migration 042's CHECK ("end" > start) used string comparison
-- which rejected legitimate overnight shifts (e.g., 22:00 -> 06:00, where "06:00" > "22:00"
-- is false lexicographically). The business explicitly needs overnight shifts.
--
-- This migration replaces the constraint to allow end <= start to mean "next day"
-- (overnight shift). The frontend ShiftModal already allows entering 22:00-06:00.

-- Drop the old constraint that blocks overnight shifts.
ALTER TABLE public.pos_shifts
  DROP CONSTRAINT IF EXISTS pos_shifts_end_after_start;

-- Add the corrected constraint: end must differ from start (a zero-length shift
-- is meaningless), but end <= start is allowed and means "next day" (overnight).
ALTER TABLE public.pos_shifts
  ADD CONSTRAINT pos_shifts_end_after_start
  CHECK ("end" <> start);
