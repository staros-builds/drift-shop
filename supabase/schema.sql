-- ============================================================
-- Drift on Supabase — full schema (build 3)
-- Run in order in the Supabase dashboard SQL editor.
-- Source of truth: build3-supabase-schema.md
-- ============================================================

-- ---------- 2. Profiles + settings ----------
-- NOTE: the profiles table must be created BEFORE the helper functions,
-- because my_role()/is_admin() are LANGUAGE SQL and Postgres resolves
-- table references in SQL-language bodies at creation time.
create table public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  username     text unique not null,
  display_name text,
  role         text not null default 'standard'
               check (role in ('admin', 'standard')),
  is_guest     boolean not null default false,
  is_paid      boolean not null default false,
  is_locked    boolean not null default false,
  disabled_until   timestamptz,
  trial_started_at timestamptz,
  trial_ends_at    timestamptz,
  -- Forced first-login password change (see migration 056_master_admin.sql).
  -- Deliberately NOT guarded by protect_profile_fields(): the owner must be
  -- able to clear their own flag after choosing a new password.
  must_change_password boolean not null default false,
  -- Factory-reset privilege: true ONLY for the seeded master account
  -- (migrations 056/057). Guarded by protect_profile_fields().
  is_master boolean not null default false,
  avatar_url   text,
  created_at   timestamptz not null default now()
);
alter table public.profiles enable row level security;

-- ---------- 1. Helper functions (after profiles exists) ----------
create or replace function public.my_role()
returns text
language sql security definer stable as $$
  select role from public.profiles where id = auth.uid();
$$;

create or replace function public.is_admin()
returns boolean
language sql security definer stable as $$
  select exists (
    select 1 from public.profiles where id = auth.uid() and role = 'admin'
  );
$$;

create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

-- ---------- 2b. Profiles policies + role guard ----------
create policy "profiles_select_own_or_admin"
  on public.profiles for select
  using (id = auth.uid() or public.is_admin());

create policy "profiles_insert_own"
  on public.profiles for insert
  with check (id = auth.uid());

create policy "profiles_update_own_fields"
  on public.profiles for update
  using (id = auth.uid())
  with check (id = auth.uid());

create policy "profiles_admin_all"
  on public.profiles for all
  using (public.is_admin())
  with check (public.is_admin());

create or replace function public.guard_role_change()
returns trigger language plpgsql as $$
begin
  if new.role is distinct from old.role and not public.is_admin() then
    raise exception 'only admins can change roles';
  end if;
  return new;
end $$;

create trigger profiles_guard_role
  before update on public.profiles
  for each row execute function public.guard_role_change();

create table public.user_settings (
  user_id         uuid primary key references auth.users(id) on delete cascade,
  visual_theme    text not null default 'daybreak'
                  check (visual_theme in ('daybreak', 'nightshift')),
  wallpaper       text not null default 'paper-grain',
  accent_override text,
  ai_engine       text not null default 'local'
                  check (ai_engine in ('local', 'cloud')),
  icon_positions  jsonb not null default '{}',
  welcome_seen    boolean not null default false,
  welcome_tour_seen boolean not null default false,
  updated_at      timestamptz not null default now()
);
alter table public.user_settings enable row level security;

create policy "settings_owner_all"
  on public.user_settings for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create trigger user_settings_touch
  before update on public.user_settings
  for each row execute function public.touch_updated_at();

-- ---------- 3. VFS ----------
create table public.vfs_folders (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  parent_id  uuid references public.vfs_folders(id) on delete cascade,
  name       text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (id <> parent_id)
);
create unique index vfs_folders_unique
  on public.vfs_folders (user_id, coalesce(parent_id, '00000000-0000-0000-0000-000000000000'), name);
create index vfs_folders_owner on public.vfs_folders (user_id, parent_id);
alter table public.vfs_folders enable row level security;

create policy "vfs_folders_owner_all"
  on public.vfs_folders for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create trigger vfs_folders_touch
  before update on public.vfs_folders
  for each row execute function public.touch_updated_at();

create table public.vfs_files (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  folder_id    uuid not null references public.vfs_folders(id) on delete cascade,
  name         text not null,
  mime_type    text not null default 'text/plain',
  size_bytes   bigint not null default 0,
  is_binary    boolean not null default false,
  content_text text,
  storage_path text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  check ((is_binary and storage_path is not null) or (not is_binary))
);
create unique index vfs_files_unique on public.vfs_files (folder_id, name);
create index vfs_files_owner on public.vfs_files (user_id, folder_id);
alter table public.vfs_files enable row level security;

create policy "vfs_files_owner_all"
  on public.vfs_files for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create trigger vfs_files_touch
  before update on public.vfs_files
  for each row execute function public.touch_updated_at();

-- ---------- 4. Spaces + window states ----------
create table public.spaces (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  name       text not null,
  icon       text not null default 'square',
  wallpaper  text,
  accent     text,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index spaces_unique_name on public.spaces (user_id, name);
create index spaces_owner on public.spaces (user_id, sort_order);
alter table public.spaces enable row level security;

create policy "spaces_owner_all"
  on public.spaces for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create trigger spaces_touch
  before update on public.spaces
  for each row execute function public.touch_updated_at();

create or replace function public.guard_space_limit()
returns trigger language plpgsql as $$
declare
  n integer;
begin
  select count(*) into n from public.spaces where user_id = new.user_id;
  if n >= 8 then
    raise exception 'maximum 8 spaces per user';
  end if;
  return new;
end $$;

create trigger spaces_guard_limit
  before insert on public.spaces
  for each row execute function public.guard_space_limit();

create table public.window_states (
  id         uuid primary key default gen_random_uuid(),
  space_id   uuid not null references public.spaces(id) on delete cascade,
  app_id     text not null,
  x          integer not null default 100,
  y          integer not null default 100,
  w          integer not null default 640,
  h          integer not null default 480,
  z          integer not null default 0,
  minimized  boolean not null default false,
  props      jsonb not null default '{}',
  updated_at timestamptz not null default now()
);
create unique index window_states_slot on public.window_states (space_id, app_id);
alter table public.window_states enable row level security;

create policy "window_states_owner_all"
  on public.window_states for all
  using (exists (
    select 1 from public.spaces s
    where s.id = window_states.space_id and s.user_id = auth.uid()
  ))
  with check (exists (
    select 1 from public.spaces s
    where s.id = window_states.space_id and s.user_id = auth.uid()
  ));

create trigger window_states_touch
  before update on public.window_states
  for each row execute function public.touch_updated_at();

-- ---------- 5. Pinboard ----------
-- to_tsvector(regconfig, text) is STABLE and array_to_string is STABLE, but
-- generated columns require IMMUTABLE expressions. Both get deterministic
-- fixed-config wrappers (plpgsql, never inlined, opaque to the check).
create or replace function public.immutable_tsvector(t text)
returns tsvector
language plpgsql immutable
set search_path = public, pg_temp
as $$ begin return to_tsvector('english', t); end $$;

create or replace function public.immutable_array_to_string(a text[], delim text)
returns text
language plpgsql immutable
set search_path = public, pg_temp
as $$ begin return array_to_string(a, delim); end $$;

create table public.pins (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  kind         text not null
               check (kind in ('text', 'link', 'file', 'image', 'note')),
  title        text not null,
  body         text,
  url          text,
  storage_path text,
  mime         text,
  size_bytes   bigint,
  tags         text[] not null default '{}',
  source_app   text,
  search       tsvector generated always as (
                 public.immutable_tsvector(
                   coalesce(title, '') || ' ' ||
                   coalesce(body, '') || ' ' ||
                   coalesce(public.immutable_array_to_string(tags, ' '), ''))
               ) stored,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  check ((kind in ('file', 'image') and storage_path is not null)
         or (kind not in ('file', 'image')))
);
create index pins_search_idx on public.pins using gin (search);
create index pins_owner_kind on public.pins (user_id, kind, created_at desc);
alter table public.pins enable row level security;

create policy "pins_owner_all"
  on public.pins for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create trigger pins_touch
  before update on public.pins
  for each row execute function public.touch_updated_at();

create or replace function public.search_pins(p_query text)
returns table (pin_id uuid, rank real)
language sql stable as $$
  select p.id,
         ts_rank(p.search, websearch_to_tsquery('english', p_query)) as rank
  from public.pins p
  where p.user_id = auth.uid()
    and p.search @@ websearch_to_tsquery('english', p_query)
  order by rank desc;
$$;

-- ---------- 6. Helm threads + messages ----------
create table public.helm_threads (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  title      text not null default 'New conversation',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index helm_threads_owner on public.helm_threads (user_id, updated_at desc);
alter table public.helm_threads enable row level security;

create policy "helm_threads_owner_all"
  on public.helm_threads for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create trigger helm_threads_touch
  before update on public.helm_threads
  for each row execute function public.touch_updated_at();

create table public.helm_messages (
  id         uuid primary key default gen_random_uuid(),
  thread_id  uuid not null references public.helm_threads(id) on delete cascade,
  role       text not null check (role in ('user', 'assistant', 'tool')),
  content    text not null,
  tool_calls jsonb,
  created_at timestamptz not null default now()
);
create index helm_messages_thread on public.helm_messages (thread_id, created_at);
alter table public.helm_messages enable row level security;

create policy "helm_messages_thread_owner_all"
  on public.helm_messages for all
  using (exists (
    select 1 from public.helm_threads t
    where t.id = helm_messages.thread_id and t.user_id = auth.uid()
  ))
  with check (exists (
    select 1 from public.helm_threads t
    where t.id = helm_messages.thread_id and t.user_id = auth.uid()
  ));

alter publication supabase_realtime add table public.helm_messages;

-- ---------- 7. Highscores + notifications ----------
create table public.game_highscores (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  game_id     text not null,
  score       integer not null,
  meta        jsonb not null default '{}',
  achieved_at timestamptz not null default now()
);
create index game_highscores_leader
  on public.game_highscores (game_id, score desc);
alter table public.game_highscores enable row level security;

create policy "highscores_owner_all"
  on public.game_highscores for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create table public.notifications (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  title      text not null,
  body       text,
  read       boolean not null default false,
  created_at timestamptz not null default now()
);
create index notifications_owner
  on public.notifications (user_id, created_at desc);
alter table public.notifications enable row level security;

create policy "notifications_owner_all"
  on public.notifications for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

alter publication supabase_realtime add table public.notifications;

-- ---------- 8. Storage buckets + policies ----------
insert into storage.buckets (id, name, public)
values ('user-files', 'user-files', false),
       ('user-wallpapers', 'user-wallpapers', false),
       ('avatars', 'avatars', true)
on conflict (id) do nothing;

create policy "user_files_owner_all"
  on storage.objects for all
  using (bucket_id = 'user-files'
         and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'user-files'
              and (storage.foldername(name))[1] = auth.uid()::text);

create policy "user_wallpapers_owner_all"
  on storage.objects for all
  using (bucket_id = 'user-wallpapers'
         and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'user-wallpapers'
              and (storage.foldername(name))[1] = auth.uid()::text);

create policy "avatars_public_read"
  on storage.objects for select
  using (bucket_id = 'avatars');

create policy "avatars_owner_write"
  on storage.objects for insert
  with check (bucket_id = 'avatars'
              and (storage.foldername(name))[1] = auth.uid()::text);

create policy "avatars_owner_update"
  on storage.objects for update
  using (bucket_id = 'avatars'
         and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'avatars'
              and (storage.foldername(name))[1] = auth.uid()::text);

create policy "avatars_owner_delete"
  on storage.objects for delete
  using (bucket_id = 'avatars'
         and (storage.foldername(name))[1] = auth.uid()::text);

-- ---------- 9. New-user bootstrap trigger ----------
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

-- Only administrators may change account-status columns (role, is_paid,
-- is_locked, disabled_until, trial_*, is_guest). The "users update their own
-- row" RLS policy stays for harmless fields.
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

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- 007: PIN-verified time clock (secure revision) ----------
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


-- ---------- 008: support tickets + user feedback (Admin panel) ----------
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

-- ---------- 009: appointments (POS customer database) ----------
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
-- 010_backup_import.sql — account backup/restore: manager-only bulk import
-- of time-clock history (punches + correction audits).
--
-- Why an RPC: migration 007 deliberately removed every direct
-- insert/update/delete RLS policy on pos_time_punches and
-- pos_punch_audits — all punch writes go through the PIN-verified
-- pos_clock_in / pos_clock_out RPCs. Restoring a backup therefore needs a
-- server-side import path too. This RPC is manager/owner-only and merges by
-- row ID: rows already present are skipped (on conflict do nothing), so a
-- restore never duplicates or overwrites live punches.
--
-- Backup semantics:
--   - Only store members can call it; only owner/manager roles may import.
--   - store_id on every imported row is forced to p_store_id (the caller
--     cannot smuggle rows into another store).
--   - The open-shift unique index is respected: if the staff member already
--     has an open shift in the live database, the backup's open shift is
--     skipped (the live shift wins).
--   - Punch check constraint (punch_out > punch_in) still applies.
-- Apply exactly once, after 007.

create or replace function public.pos_punch_history_import(
  p_store_id uuid,
  p_punches  jsonb,
  p_audits   jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_punches int := 0;
  v_audits  int := 0;
  r jsonb;
begin
  if auth.uid() is null then
    raise exception 'sign in required';
  end if;
  if not public.is_pos_member(p_store_id) then
    raise exception 'not a member of this store';
  end if;
  if public.pos_role(p_store_id) not in ('owner', 'manager') then
    raise exception 'managers only';
  end if;

  for r in
    select * from jsonb_array_elements(coalesce(p_punches, '[]'::jsonb))
  loop
    if r is null or (r ->> 'id') is null or (r ->> 'staff_id') is null
       or (r ->> 'punch_in') is null then
      continue;
    end if;
    -- Live open shift wins over a backup's open shift for the same employee.
    if (r ->> 'punch_out') is null then
      if exists (
        select 1 from public.pos_time_punches
        where store_id = p_store_id
          and staff_id = (r ->> 'staff_id')::uuid
          and punch_out is null
      ) then
        continue;
      end if;
    end if;
    insert into public.pos_time_punches
      (id, store_id, staff_id, punch_in, punch_out, created_at)
    values
      ((r ->> 'id')::uuid,
       p_store_id,
       (r ->> 'staff_id')::uuid,
       (r ->> 'punch_in')::timestamptz,
       nullif(r ->> 'punch_out', '')::timestamptz,
       coalesce((r ->> 'created_at')::timestamptz, now()))
    on conflict (id) do nothing;
    if found then
      v_punches := v_punches + 1;
    end if;
  end loop;

  for r in
    select * from jsonb_array_elements(coalesce(p_audits, '[]'::jsonb))
  loop
    if r is null or (r ->> 'id') is null then
      continue;
    end if;
    insert into public.pos_punch_audits
      (id, store_id, punch_id, action, edited_by,
       old_punch_in, old_punch_out, new_punch_in, new_punch_out, created_at)
    values
      ((r ->> 'id')::uuid,
       p_store_id,
       nullif(r ->> 'punch_id', '')::uuid,
       coalesce(r ->> 'action', 'correct'),
       auth.uid(), -- re-attribute to the importer: the backup's user may not exist here
       nullif(r ->> 'old_punch_in', '')::timestamptz,
       nullif(r ->> 'old_punch_out', '')::timestamptz,
       nullif(r ->> 'new_punch_in', '')::timestamptz,
       nullif(r ->> 'new_punch_out', '')::timestamptz,
       coalesce((r ->> 'created_at')::timestamptz, now()))
    on conflict (id) do nothing;
    if found then
      v_audits := v_audits + 1;
    end if;
  end loop;

  return jsonb_build_object('punches', v_punches, 'audits', v_audits);
end;
$$;

grant execute on function public.pos_punch_history_import(uuid, jsonb, jsonb)
  to authenticated;
