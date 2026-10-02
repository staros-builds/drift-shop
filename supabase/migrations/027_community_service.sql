-- 027_community_service.sql
--
-- Community-service hours (travaux communautaires), tracked SEPARATELY from
-- payroll. People doing community service are not employees: they may not
-- be in pos_staff at all, so each entry carries a free-text person name
-- with an optional link to a staff row and an optional organization
-- (attestations group hours by organization).
--
-- An attestation is a printable per-person summary over a date range:
-- total hours plus the entry table grouped by organization. The app builds
-- it from these rows; nothing is stored beyond the entries themselves.

create table if not exists public.pos_community_hours (
  id          uuid primary key default gen_random_uuid(),
  store_id    uuid not null references public.pos_stores(id) on delete cascade,
  person_name text not null check (btrim(person_name) <> ''),
  staff_id    uuid references public.pos_staff(id) on delete set null,
  org_id      uuid references public.pos_orgs(id) on delete set null,
  service_date date not null default current_date,
  minutes     integer not null check (minutes > 0 and minutes <= 1440),
  notes       text not null default '',
  recorded_by uuid,
  created_at  timestamptz not null default now()
);
create index if not exists pos_community_hours_store_person
  on public.pos_community_hours (store_id, person_name, service_date);
create index if not exists pos_community_hours_store_date
  on public.pos_community_hours (store_id, service_date);
alter table public.pos_community_hours enable row level security;

-- RLS: same team model as pos_orgs — any member reads/adds, only
-- owner/manager edits/removes. Community-service records are legal-adjacent
-- documents; ordinary cashiers must not rewrite history.
drop policy if exists "pos_community_hours_member_select" on public.pos_community_hours;
create policy "pos_community_hours_member_select"
  on public.pos_community_hours for select
  using (public.is_pos_member(store_id));

drop policy if exists "pos_community_hours_member_insert" on public.pos_community_hours;
create policy "pos_community_hours_member_insert"
  on public.pos_community_hours for insert
  with check (public.is_pos_member(store_id));

drop policy if exists "pos_community_hours_manager_update" on public.pos_community_hours;
create policy "pos_community_hours_manager_update"
  on public.pos_community_hours for update
  using (public.pos_role(store_id) in ('owner', 'manager'))
  with check (public.pos_role(store_id) in ('owner', 'manager'));

drop policy if exists "pos_community_hours_manager_delete" on public.pos_community_hours;
create policy "pos_community_hours_manager_delete"
  on public.pos_community_hours for delete
  using (public.pos_role(store_id) in ('owner', 'manager'));
