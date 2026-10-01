-- BATCH b06

-- ===== FILE: supabase/migrations/005_*.sql ======
-- 005_welcome_tour_seen.sql
-- The app persists the feature-tour dismissal flag (welcome_tour_seen) via
-- the settings upsert. Ensure the column exists; safe to run when it
-- already does (e.g. databases created after the flag was introduced).
alter table public.user_settings
  add column if not exists welcome_tour_seen boolean not null default false;

-- ===== FILE: supabase/migrations/006_*.sql ======
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

-- ===== FILE: supabase/migrations/007_*.sql ======
-- 007_time_clock.sql
-- PIN-verified employee time clock for the POS suite (secure revision).
--
-- All punch writes go through SECURITY DEFINER RPCs that verify the staff
-- PIN server-side — the table itself allows NO direct writes, so a client
-- can never punch in as someone else, edit hours, or bypass the PIN.
--
--   pos_time_punches: one row per shift segment — id, store_id,
--     staff_id (null if the staff row was deleted), punch_in,
--     punch_out (null = currently clocked in), created_at.
--   pos_punch_audits: manager correction/deletion log — punch_id, action
--     ('correct' | 'delete'), edited_by, old/new punch_in/out, created_at.
--
-- RPCs:
--   pos_clock_in(p_store_id, p_pin_hash)    — verify PIN, open a shift.
--   pos_clock_out(p_store_id, p_pin_hash)   — verify PIN, close the shift.
--   pos_punch_correct(p_punch_id, p_punch_in, p_punch_out) — owner/manager
--     correction; the old values are written to pos_punch_audits.
--   pos_punch_delete(p_punch_id)            — owner/manager delete; logged.
--
-- Reads: any store member may read punches (the shared terminal shows hours)
-- and managers may read the audit log.

create table if not exists public.pos_time_punches (
  id         uuid primary key default gen_random_uuid(),
  store_id   uuid not null references public.pos_stores(id) on delete cascade,
  staff_id   uuid references public.pos_staff(id) on delete set null,
  punch_in   timestamptz not null default now(),
  punch_out  timestamptz,
  created_at timestamptz not null default now(),
  check (punch_out is null or punch_out > punch_in)
);

create index if not exists pos_punches_store on public.pos_time_punches (store_id, punch_in desc);
create index if not exists pos_punches_staff on public.pos_time_punches (staff_id, punch_in desc);

-- Race-safe: at most one open shift per staff member, enforced by the
-- database itself (two terminals punching the same PIN at once can't both win).
create unique index if not exists pos_punches_one_open
  on public.pos_time_punches (staff_id) where punch_out is null;

create table if not exists public.pos_punch_audits (
  id           uuid primary key default gen_random_uuid(),
  store_id     uuid not null references public.pos_stores(id) on delete cascade,
  punch_id     uuid,
  action       text not null check (action in ('correct', 'delete')),
  edited_by    uuid references auth.users(id) on delete set null,
  old_punch_in timestamptz,
  old_punch_out timestamptz,
  new_punch_in timestamptz,
  new_punch_out timestamptz,
  created_at   timestamptz not null default now()
);

create index if not exists pos_punch_audits_store on public.pos_punch_audits (store_id, created_at desc);

alter table public.pos_time_punches enable row level security;
alter table public.pos_punch_audits enable row level security;

-- Reads: any member sees punches; only owners/managers see the audit log.
-- There are intentionally NO insert/update/delete policies: every write goes
-- through the RPCs below, which run as SECURITY DEFINER and verify the PIN
-- (or the manager role) on the server.
drop policy if exists "pos_punches_member_select" on public.pos_time_punches;
create policy "pos_punches_member_select"
  on public.pos_time_punches for select
  using (public.is_pos_member(store_id));

drop policy if exists "pos_punches_member_insert" on public.pos_time_punches;
drop policy if exists "pos_punches_member_update" on public.pos_time_punches;
drop policy if exists "pos_punches_member_delete" on public.pos_time_punches;

drop policy if exists "pos_punch_audits_manager_select" on public.pos_punch_audits;
create policy "pos_punch_audits_manager_select"
  on public.pos_punch_audits for select
  using (public.pos_role(store_id) in ('owner', 'manager'));

-- ---------- RPCs ----------

-- Verify the PIN and open a shift for that staff member only.
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

-- Verify the PIN and close that staff member's open shift.
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
  limit 1;
  if not found then
    raise exception 'not punched in';
  end if;
  update public.pos_time_punches
  set punch_out = now()
  where id = v_punch_id
  returning punch_out into v_punch_out;
  return query select v_punch_id, v_staff_id, v_staff_name, v_punch_in, v_punch_out;
end $$;

-- Owner/manager correction of a punch, with the old values audited.
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
  where id = p_punch_id;
  return query select p_punch_id, v_staff_id, p_punch_in, p_punch_out;
end $$;

-- Owner/manager deletion of a punch, audited.
create or replace function public.pos_punch_delete(p_punch_id uuid)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_store_id uuid;
  v_old_in   timestamptz;
  v_old_out  timestamptz;
begin
  if auth.uid() is null then
    raise exception 'sign in to delete punches';
  end if;
  select p.store_id, p.punch_in, p.punch_out
  into v_store_id, v_old_in, v_old_out
  from public.pos_time_punches p
  where p.id = p_punch_id
  limit 1;
  if not found then
    raise exception 'punch not found';
  end if;
  if not public.pos_role(v_store_id) in ('owner', 'manager') then
    raise exception 'managers only';
  end if;
  insert into public.pos_punch_audits
    (store_id, punch_id, action, edited_by, old_punch_in, old_punch_out)
  values
    (v_store_id, p_punch_id, 'delete', auth.uid(), v_old_in, v_old_out);
  delete from public.pos_time_punches where id = p_punch_id;
end $$;

revoke all on function public.pos_clock_in(uuid, text) from public;
grant execute on function public.pos_clock_in(uuid, text) to authenticated;
revoke all on function public.pos_clock_out(uuid, text) from public;
grant execute on function public.pos_clock_out(uuid, text) to authenticated;
revoke all on function public.pos_punch_correct(uuid, timestamptz, timestamptz) from public;
grant execute on function public.pos_punch_correct(uuid, timestamptz, timestamptz) to authenticated;
revoke all on function public.pos_punch_delete(uuid) from public;
grant execute on function public.pos_punch_delete(uuid) to authenticated;

-- ===== FILE: supabase/migrations/008_*.sql ======
-- 008_support_tickets_feedback.sql
-- Support tickets + user feedback, surfaced in the Admin panel.
--
-- Anyone signed in (including trial guests) can file a support ticket —
-- e.g. "I want to buy / pay for Drift" — and send feedback. Users see only
-- their own rows; administrators see and manage everything from the
-- Admin panel (status workflow + replies for tickets, reviewed flag for
-- feedback).
--
--   support_tickets: id, user_id, subject, message, status
--                    (open | in_progress | resolved), admin_response,
--                    created_at, updated_at
--   feedback:        id, user_id, message, rating (1-5, optional),
--                    reviewed, created_at

-- Defensive: is_admin() is defined in schema.sql; recreate it here so
-- databases built from migrations alone have it too.
create or replace function public.is_admin()
returns boolean
language sql security definer stable as $$
  select exists (
    select 1 from public.profiles where id = auth.uid() and role = 'admin'
  );
$$;

-- ---------- support tickets ----------
create table if not exists public.support_tickets (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users(id) on delete cascade,
  subject        text not null check (char_length(subject) between 1 and 200),
  message        text not null check (char_length(message) between 1 and 5000),
  status         text not null default 'open'
                   check (status in ('open', 'in_progress', 'resolved')),
  admin_response text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists support_tickets_user
  on public.support_tickets (user_id, created_at desc);
create index if not exists support_tickets_status
  on public.support_tickets (status, created_at desc);

alter table public.support_tickets enable row level security;

drop policy if exists "support_tickets_insert_own" on public.support_tickets;
create policy "support_tickets_insert_own"
  on public.support_tickets for insert
  to authenticated
  with check (user_id = auth.uid());

drop policy if exists "support_tickets_select_own_or_admin" on public.support_tickets;
create policy "support_tickets_select_own_or_admin"
  on public.support_tickets for select
  to authenticated
  using (user_id = auth.uid() or public.is_admin());

-- Only admins may change status / write a response. Users cannot edit or
-- delete their tickets after filing.
drop policy if exists "support_tickets_admin_update" on public.support_tickets;
create policy "support_tickets_admin_update"
  on public.support_tickets for update
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- ---------- feedback ----------
create table if not exists public.feedback (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  message    text not null check (char_length(message) between 1 and 5000),
  rating     smallint check (rating between 1 and 5),
  reviewed   boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists feedback_user
  on public.feedback (user_id, created_at desc);
create index if not exists feedback_reviewed
  on public.feedback (reviewed, created_at desc);

alter table public.feedback enable row level security;

drop policy if exists "feedback_insert_own" on public.feedback;
create policy "feedback_insert_own"
  on public.feedback for insert
  to authenticated
  with check (user_id = auth.uid());

drop policy if exists "feedback_select_own_or_admin" on public.feedback;
create policy "feedback_select_own_or_admin"
  on public.feedback for select
  to authenticated
  using (user_id = auth.uid() or public.is_admin());

-- Only admins may mark feedback reviewed.
drop policy if exists "feedback_admin_update" on public.feedback;
create policy "feedback_admin_update"
  on public.feedback for update
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- ===== FILE: supabase/migrations/009_*.sql ======
-- 009_appointments.sql
-- Appointment scheduling tied into the POS customer database.
--
--   pos_appointments: store_id, customer_id -> pos_customers (who it's for),
--     staff_id -> pos_staff (who it's with), title (service), notes,
--     starts_at / ends_at, status
--     (scheduled | confirmed | completed | cancelled | no_show),
--     created_by, created_at, updated_at.
--
-- RLS mirrors the POS pattern: any store member can read/book/update
-- appointments; only owners/managers can delete them.

create table if not exists public.pos_appointments (
  id          uuid primary key default gen_random_uuid(),
  store_id    uuid not null references public.pos_stores(id) on delete cascade,
  customer_id uuid references public.pos_customers(id) on delete set null,
  staff_id    uuid references public.pos_staff(id) on delete set null,
  title       text not null check (char_length(title) between 1 and 120),
  notes       text,
  starts_at   timestamptz not null,
  ends_at     timestamptz not null check (ends_at > starts_at),
  status      text not null default 'scheduled'
                check (status in ('scheduled', 'confirmed', 'completed',
                                  'cancelled', 'no_show')),
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists pos_appointments_store_time
  on public.pos_appointments (store_id, starts_at);
create index if not exists pos_appointments_customer
  on public.pos_appointments (customer_id, starts_at);

alter table public.pos_appointments enable row level security;

drop policy if exists "pos_appointments_member_select" on public.pos_appointments;
create policy "pos_appointments_member_select"
  on public.pos_appointments for select
  using (public.is_pos_member(store_id));

drop policy if exists "pos_appointments_member_insert" on public.pos_appointments;
create policy "pos_appointments_member_insert"
  on public.pos_appointments for insert
  with check (public.is_pos_member(store_id));

drop policy if exists "pos_appointments_member_update" on public.pos_appointments;
create policy "pos_appointments_member_update"
  on public.pos_appointments for update
  using (public.is_pos_member(store_id))
  with check (public.is_pos_member(store_id));

drop policy if exists "pos_appointments_manager_delete" on public.pos_appointments;
create policy "pos_appointments_manager_delete"
  on public.pos_appointments for delete
  using (public.pos_role(store_id) in ('owner', 'manager'));
