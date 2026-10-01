-- 006_admin_trials.sql
-- Account administration + 30-minute free trial.
--
-- New profile columns:
--   is_paid          - administrator marks an account paid (manual; no payment
--                      processing yet). Paid accounts have full access.
--   is_locked        - administrator lock. Locked accounts are signed out and
--                      cannot sign back in until unlocked.
--   disabled_until   - temporary disable: the account cannot sign in (and an
--                      active session is ended) until this timestamp passes.
--                      The admin panel sets it to now() + 5 minutes.
--   trial_started_at / trial_ends_at - 30-minute free-trial window, stamped by
--                      handle_new_user() for guest (anonymous) sign-ups.
--
-- Access rule enforced by the app (AuthContext watchdog):
--   admin role            -> unlimited, always allowed
--   is_locked             -> blocked until an admin unlocks
--   disabled_until future -> blocked until it passes
--   is_paid               -> allowed
--   trial_ends_at future  -> allowed (guest trial)
--   otherwise             -> blocked (trial over / awaiting activation)
--
-- A BEFORE UPDATE trigger guarantees only an administrator can change the
-- protected columns; the existing "users can update their own row" RLS policy
-- stays for harmless fields (username, display_name, avatar_url).

-- ---------- 1. Columns ----------
alter table public.profiles
  add column if not exists is_paid          boolean     not null default false,
  add column if not exists is_locked        boolean     not null default false,
  add column if not exists disabled_until    timestamptz,
  add column if not exists trial_started_at  timestamptz,
  add column if not exists trial_ends_at     timestamptz;

-- ---------- 2. Guest trial window + owner admin in handle_new_user ----------
create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer as $$
declare
  is_first boolean;
  uname    text;
  is_g     boolean;
begin
  select count(*) = 0 into is_first from public.profiles;
  is_g := coalesce((new.raw_user_meta_data ->> 'is_guest')::boolean, false);
  uname := coalesce(
    nullif(new.raw_user_meta_data ->> 'username', ''),
    nullif(split_part(new.email, '@', 1), ''),
    'guest'
  );
  insert into public.profiles
    (id, username, role, is_guest, trial_started_at, trial_ends_at)
  values
    (new.id, uname,
     case
       when is_first then 'admin'
       when new.email is not null and lower(new.email) = 'admin@drift-shop.app' then 'admin'
       else 'standard'
     end,
     is_g,
     case when is_g then now() else null end,
     case when is_g then now() + interval '30 minutes' else null end);
  insert into public.user_settings (user_id) values (new.id);
  insert into public.vfs_folders (user_id, parent_id, name)
  values (new.id, null, 'root');
  insert into public.spaces (user_id, name, sort_order)
  values (new.id, 'Main', 0),
         (new.id, 'Focus', 1),
         (new.id, 'Play', 2);
  return new;
end $$;

-- ---------- 3. Owner account: admin + paid, whatever exists today ----------
update public.profiles
set role = 'admin',
    is_paid = true,
    is_locked = false,
    disabled_until = null
where id in (select id from auth.users where lower(email) = 'admin@drift-shop.app');

-- ---------- 4. Only admins may change account-status columns ----------
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
  then
    raise exception 'Only an administrator can change account status fields.';
  end if;
  return new;
end $$;

drop trigger if exists protect_profile_fields on public.profiles;
create trigger protect_profile_fields
  before update on public.profiles
  for each row execute function public.protect_profile_fields();
