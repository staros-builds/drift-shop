-- BATCH b01 : schema.sql part A (base sections 1-6 + bootstrap + 008 support/feedback)
-- ===== FILE: supabase/schema.sql [lines 1-493] ======
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


-- ===== FILE: supabase/schema.sql [lines 739-842] ======
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

