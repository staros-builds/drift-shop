-- 005_welcome_tour_seen.sql
-- The app persists the feature-tour dismissal flag (welcome_tour_seen) via
-- the settings upsert. Ensure the column exists; safe to run when it
-- already does (e.g. databases created after the flag was introduced).
alter table public.user_settings
  add column if not exists welcome_tour_seen boolean not null default false;
