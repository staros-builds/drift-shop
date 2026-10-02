-- ============================================================
-- 067 (renumbered at the final merge; drafted as 070). The
-- "migration 067" comments at posHasBusinessPreset in
-- src/lib/backend/supabase.js name this file. Expand-only + idempotent:
-- safe to re-run.
-- ============================================================
-- Business-type presets (universal build): record which setup a shop
-- runs on the store row itself.
--
--   NULL          = the owner has never picked a business type
--   'general'     = picked, all-purpose default setup
--   'retail' | 'restaurant' | 'services' | 'convenience'
--
-- The layout bundle a preset applies lives in per-user settings; this
-- column is only the store-level record of the choice (support
-- visibility, shown in Admin → Business type). Safe to add: existing
-- rows stay NULL ("not chosen yet"), the app feature-probes the
-- column (posHasBusinessPreset) and keeps working without it.
--
-- No new policies needed: pos_stores reads already ride the member
-- select policy and pos_stores_manager_update (migration 002) already
-- restricts UPDATE to owner/manager roles.
-- ============================================================

alter table public.pos_stores
  add column if not exists business_preset text;

alter table public.pos_stores
  drop constraint if exists pos_stores_business_preset_check;
alter table public.pos_stores
  add constraint pos_stores_business_preset_check
  check (
    business_preset is null
    or business_preset in ('general', 'retail', 'restaurant', 'services', 'convenience')
  );

comment on column public.pos_stores.business_preset is
  'Universal business-type preset chosen by the shop owner (null = never chosen). Layout bundles live in per-user settings; this is the store-level record.';
