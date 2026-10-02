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
