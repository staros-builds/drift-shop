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
