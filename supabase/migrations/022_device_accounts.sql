-- 022_device_accounts.sql
--
-- Sub-account hierarchy for the shop owner.
--
-- NOTE: the profiles.account_type / created_by / device_store_id columns
-- were moved into 020_admin_user_management.sql (admin_create_user writes
-- them, so they must exist before 020's function can run). The ALTER below
-- is kept as an idempotent guard; the trigger extension is the live part.
-- profiles.account_type: what this login account is for.
--   'full'   — a complete desktop, everything the role allows (default;
--               this is what the owner has).
--   'staff'  — shop staff: the regular desktop, flagged as staff, created
--               under the owner and auto-joined to the shop as cashier.
--   'pos'    — a POS-register device: signs straight into a locked,
--               fullscreen point of sale for one shop. No desktop.
--   'punch'  — a punch-pad device (back-room tablet): signs straight into
--               the clock in/out pad for one shop. No desktop.
--
-- profiles.created_by: the admin account that created this account
--   (NULL for the original / self-signed-up accounts).
-- profiles.device_store_id: the shop a device account is bound to
--   (also set for staff when a shop is picked at creation).
--
-- The device accounts are ordinary store members (role 'cashier'), so every
-- data rule they hit is the same team RLS + PIN-verifying RPCs the shop
-- already enforces — the kiosk UI being minimal is a convenience, the
-- server is the actual boundary.

alter table public.profiles
  add column if not exists account_type text not null default 'full'
    check (account_type in ('full', 'staff', 'pos', 'punch')),
  add column if not exists created_by uuid references public.profiles(id) on delete set null,
  add column if not exists device_store_id uuid references public.pos_stores(id) on delete set null;

-- Only an administrator may change these fields; the existing
-- protect_profile_fields() trigger is extended to cover them.
create or replace function public.protect_profile_fields()
returns trigger
language plpgsql as $$
begin
  if public.is_admin() then
    return new;
  end if;
  if new.role             is distinct from old.role
     or new.is_paid        is distinct from old.is_paid
     or new.is_locked      is distinct from old.is_locked
     or new.disabled_until is distinct from old.disabled_until
     or new.trial_started_at is distinct from old.trial_started_at
     or new.trial_ends_at    is distinct from old.trial_ends_at
     or new.is_guest       is distinct from old.is_guest
     or new.account_type   is distinct from old.account_type
     or new.created_by     is distinct from old.created_by
     or new.device_store_id is distinct from old.device_store_id
  then
    raise exception 'Only an administrator can change account status fields.';
  end if;
  return new;
end $$;

drop trigger if exists protect_profile_fields on public.profiles;
create trigger protect_profile_fields
  before update on public.profiles
  for each row execute function public.protect_profile_fields();
