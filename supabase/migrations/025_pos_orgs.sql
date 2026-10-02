-- 025_pos_orgs.sql
--
-- Organization accounts: businesses, non-profits, schools and institutions
-- the shop bills. Organizations can be flagged tax-exempt, in which case
-- their sales are recorded tax-free (ticket-level exemption) and the
-- receipt says so.
--
-- Historical truth: pos_sales carries a snapshot of the org at sale time
-- (org_id, org_name, org_type, org_tax_exempt). Renaming or deleting the
-- org later never rewrites history; the receipt reprint uses the snapshot.

create table if not exists public.pos_orgs (
  id         uuid primary key default gen_random_uuid(),
  store_id   uuid not null references public.pos_stores(id) on delete cascade,
  name       text not null,
  type       text not null default 'entreprise'
             check (type in ('entreprise', 'obnl', 'ecole', 'institution')),
  contact    text,
  tax_exempt boolean not null default false,
  notes      text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists pos_orgs_store on public.pos_orgs (store_id, name);
alter table public.pos_orgs enable row level security;

-- RLS: same team model as pos_customers — any member reads/adds, only
-- owner/manager edits/removes.
drop policy if exists "pos_orgs_member_select" on public.pos_orgs;
create policy "pos_orgs_member_select"
  on public.pos_orgs for select
  using (public.is_pos_member(store_id));

drop policy if exists "pos_orgs_member_insert" on public.pos_orgs;
create policy "pos_orgs_member_insert"
  on public.pos_orgs for insert
  with check (public.is_pos_member(store_id));

drop policy if exists "pos_orgs_manager_update" on public.pos_orgs;
create policy "pos_orgs_manager_update"
  on public.pos_orgs for update
  using (public.pos_role(store_id) in ('owner', 'manager'))
  with check (public.pos_role(store_id) in ('owner', 'manager'));

drop policy if exists "pos_orgs_manager_delete" on public.pos_orgs;
create policy "pos_orgs_manager_delete"
  on public.pos_orgs for delete
  using (public.pos_role(store_id) in ('owner', 'manager'));

-- Sale-time org snapshot. org_id is set-null on delete so removing an org
-- never deletes sales; the name/type/exempt snapshot stays for the books.
alter table public.pos_sales
  add column if not exists org_id         uuid references public.pos_orgs(id) on delete set null,
  add column if not exists org_name       text,
  add column if not exists org_type       text,
  add column if not exists org_tax_exempt boolean not null default false;
create index if not exists pos_sales_org on public.pos_sales (store_id, org_id);
