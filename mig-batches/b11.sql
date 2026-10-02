-- BATCH b11

-- ===== FILE: supabase/migrations/030_*.sql ======
-- 030_giftcard_import_reconciliation.sql
--
-- Fix: pos_giftcard_import could leave a card's stored balance_cents
-- disagreeing with its imported ledger history (e.g. card said 500, last
-- ledger event said 0). Normal gift-card operations maintain the invariant
--   card.balance_cents = last_event.balance_after_cents
-- atomically; the import must restore it too.
--
-- Reconciliation policy (ledger wins):
--   * After importing a card's events, if any non-'issued' events were
--     imported for that card, set the card's balance_cents to the latest
--     event's balance_after_cents (by created_at, id tiebreak).
--   * If no non-issued events were imported, the supplied card balance
--     stands (the ledger holds only the replayed issuance).
--   * Void cards always stay at 0.
--
-- The import report gains a `balances_reconciled` count so a restore can
-- surface when ledger truth overrode a supplied card balance.

create or replace function public.pos_giftcard_import(
  p_store_id uuid, p_cards jsonb, p_events jsonb, p_sale_remap jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_role      text;
  c           jsonb;
  e           jsonb;
  v_old_id    text;
  v_new_id    uuid;
  v_code      text;
  v_initial   int;
  v_balance   int;
  v_status    text;
  v_card_map  jsonb := '{}'::jsonb;
  v_cards_ins int := 0;
  v_cards_skip int := 0;
  v_events_ins int := 0;
  v_events_skip int := 0;
  v_reconciled int := 0;
  v_sale_id   uuid;
  v_last_bal  int;
  r_map       record;
begin
  if auth.uid() is null then
    raise exception 'sign in to import gift cards';
  end if;
  select m.role into v_role
    from public.pos_store_members m
   where m.store_id = p_store_id and m.user_id = auth.uid();
  if v_role not in ('owner', 'manager') then
    raise exception 'only managers can import gift cards';
  end if;
  perform public.require_account_type('full', 'staff');

  for c in select * from jsonb_array_elements(coalesce(p_cards, '[]'::jsonb)) loop
    v_old_id := c->>'id';
    v_code := btrim(coalesce(c->>'code', ''));
    if v_code = '' then continue; end if;
    select gc.id into v_new_id
      from public.pos_gift_cards gc
     where gc.store_id = p_store_id and gc.code = v_code;
    if v_new_id is not null then
      v_cards_skip := v_cards_skip + 1;
      -- Card already exists: its history is already in the ledger. Do NOT
      -- map its old ID, so events for it are skipped below. Replaying them
      -- would duplicate ledger entries (especially events without stable
      -- UUIDs, which get fresh random IDs on every import).
    else
      v_initial := greatest(1, public._safe_int(c->>'initial_cents', 1));
      v_balance := greatest(0, public._safe_int(c->>'balance_cents', 0));
      v_status := case when c->>'status' = 'void' then 'void' else 'active' end;
      if v_status = 'void' then v_balance := 0; end if;
      -- Strict UUID format check: the loose [0-9a-fA-F-]{36} pattern accepts
      -- malformed strings (e.g. all dashes) that fail the ::uuid cast.
      if (c->>'id') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
         and not exists (select 1 from public.pos_gift_cards where id = (c->>'id')::uuid) then
        v_new_id := (c->>'id')::uuid;
      else
        v_new_id := gen_random_uuid();
      end if;
      insert into public.pos_gift_cards
            (id, store_id, code, initial_cents, balance_cents, note, status, sold_at, created_at)
      values (v_new_id, p_store_id, v_code, v_initial, v_balance,
              coalesce(c->>'note', ''), v_status,
              coalesce(public._safe_timestamptz(c->>'sold_at'), now()),
              coalesce(public._safe_timestamptz(c->>'created_at'), now()));
      -- Replay issuance so the ledger stays append-only and truthful.
      insert into public.pos_gift_card_events
            (store_id, card_id, kind, amount_cents, balance_after_cents, created_at)
      values (p_store_id, v_new_id, 'issued', v_initial, v_initial,
              coalesce(public._safe_timestamptz(c->>'created_at'), now()));
      v_cards_ins := v_cards_ins + 1;
      if v_old_id is not null then
        v_card_map := v_card_map || jsonb_build_object(v_old_id, v_new_id::text);
      end if;
    end if;
  end loop;

  for e in select * from jsonb_array_elements(coalesce(p_events, '[]'::jsonb)) loop
    if (e->>'kind') = 'issued' then continue; end if; -- replayed above
    if (e->>'kind') not in ('redeemed', 'credited', 'voided') then continue; end if;
    if (e->>'card_id') is null then continue; end if;
    begin
      v_new_id := (v_card_map ->> (e->>'card_id'))::uuid;
    exception when others then
      continue;
    end;
    if v_new_id is null then continue; end if;
    if (e->>'id') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
       and exists (select 1 from public.pos_gift_card_events where id = (e->>'id')::uuid) then
      v_events_skip := v_events_skip + 1;
      continue;
    end if;
    -- Resolve sale_id: prefer the remap, else use the UUID only if it
    -- actually exists in this store. A dangling reference becomes NULL
    -- (not an FK violation that aborts the import).
    v_sale_id := null;
    if p_sale_remap ? coalesce(e->>'sale_id', '') then
      begin
        v_sale_id := (p_sale_remap ->> (e->>'sale_id'))::uuid;
      exception when others then
        v_sale_id := null;
      end;
    elsif (e->>'sale_id') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
      if exists (select 1 from public.pos_sales s where s.id = (e->>'sale_id')::uuid and s.store_id = p_store_id) then
        v_sale_id := (e->>'sale_id')::uuid;
      end if;
    end if;
    insert into public.pos_gift_card_events
          (id, store_id, card_id, kind, amount_cents, balance_after_cents, sale_id, created_at)
    values (
      case when (e->>'id') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then (e->>'id')::uuid else gen_random_uuid() end,
      p_store_id, v_new_id, e->>'kind',
      greatest(1, public._safe_int(e->>'amount_cents', 1)),
      greatest(0, public._safe_int(e->>'balance_after_cents', 0)),
      v_sale_id,
      coalesce(public._safe_timestamptz(e->>'created_at'), now()));
    v_events_ins := v_events_ins + 1;
  end loop;

  -- Reconcile: the ledger is the append-only source of truth. For every
  -- card inserted above that received non-issued events, set its stored
  -- balance to the latest event's balance_after_cents so the card and its
  -- history can never disagree after a restore. Cards with only the
  -- replayed issuance keep their supplied balance. Void cards stay at 0.
  for r_map in select key as old_id, value as new_id_text from jsonb_each_text(v_card_map) loop
    begin
      v_new_id := r_map.new_id_text::uuid;
    exception when others then
      continue;
    end;
    select e.balance_after_cents into v_last_bal
      from public.pos_gift_card_events e
     where e.card_id = v_new_id
       and e.kind <> 'issued'
     order by e.created_at desc, e.id desc
     limit 1;
    if found then
      update public.pos_gift_cards gc
         set balance_cents = v_last_bal
       where gc.id = v_new_id
         and gc.status <> 'void'
         and gc.balance_cents is distinct from v_last_bal;
      if found then
        v_reconciled := v_reconciled + 1;
      end if;
    end if;
  end loop;

  return jsonb_build_object(
    'cards_inserted', v_cards_ins, 'cards_skipped', v_cards_skip,
    'events_inserted', v_events_ins, 'events_skipped', v_events_skip,
    'balances_reconciled', v_reconciled);
end;
$$;

revoke all on function public.pos_giftcard_import(uuid, jsonb, jsonb, jsonb) from public, anon;
grant execute on function public.pos_giftcard_import(uuid, jsonb, jsonb, jsonb) to authenticated;

-- ===== FILE: supabase/migrations/031_*.sql ======
-- 031_punch_hr_tables.sql
--
-- Backend tables for the Poinçon (time clock) HR features. The Poinçon app
-- was written against these APIs but the tables/RPCs were never created,
-- so the Feuilles/Horaire/Congés/Paie/Réglages tabs failed with
-- "… is not a function". This migration completes the backend.
--
--   pos_breaks: paid/unpaid break segments inside a punch. Writes go through
--     PIN-verifying SECURITY DEFINER RPCs (same model as pos_time_punches).
--   pos_shifts: scheduled shifts (staff_id, date, HH:MM start/end, note).
--   pos_time_off: vacation/sick/unpaid requests (pending → approved/denied).
--   pos_pay_periods: approved (locked) pay periods for payroll.
--   pos_punch_settings: per-store terminal settings (week start, break
--     lengths, grace minutes). One row per store.
--
-- RLS follows the team model: members read; managers write, except breaks
-- (PIN-verified RPCs) and time-off requests (any member may file their own,
-- PIN-verified; only managers decide).

-- ============ pos_breaks ============

create table if not exists public.pos_breaks (
  id         uuid primary key default gen_random_uuid(),
  store_id   uuid not null references public.pos_stores(id) on delete cascade,
  staff_id   uuid not null references public.pos_staff(id) on delete cascade,
  punch_id   uuid references public.pos_time_punches(id) on delete set null,
  type       text not null check (type in ('paid', 'unpaid')),
  start      timestamptz not null default now(),
  "end"      timestamptz,
  created_at timestamptz not null default now(),
  check ("end" is null or "end" > start)
);
create index if not exists pos_breaks_store on public.pos_breaks (store_id, start desc);
create index if not exists pos_breaks_staff on public.pos_breaks (staff_id, start desc);
-- Race-safe: at most one open break per staff member.
create unique index if not exists pos_breaks_one_open
  on public.pos_breaks (staff_id) where "end" is null;

alter table public.pos_breaks enable row level security;

-- Reads: any member sees breaks (the shared terminal shows who's on break).
-- There are intentionally NO direct insert/update/delete policies: every
-- write goes through the RPCs below, which verify the staff PIN server-side.
drop policy if exists "pos_breaks_member_select" on public.pos_breaks;
create policy "pos_breaks_member_select"
  on public.pos_breaks for select
  using (public.is_pos_member(store_id));
drop policy if exists "pos_breaks_member_insert" on public.pos_breaks;
drop policy if exists "pos_breaks_member_update" on public.pos_breaks;
drop policy if exists "pos_breaks_member_delete" on public.pos_breaks;

-- Start a break: verify PIN, require an open punch, one open break max.
create or replace function public.pos_break_start(p_store_id uuid, p_pin_hash text, p_type text)
returns table (id uuid, staff_id uuid, punch_id uuid, type text, start timestamptz)
language plpgsql security definer
set search_path = public
as $$
declare
  v_staff_id uuid;
  v_punch_id uuid;
  v_break_id uuid;
  v_start    timestamptz;
begin
  if auth.uid() is null then
    raise exception 'sign in to start a break';
  end if;
  if not public.is_pos_member(p_store_id) then
    raise exception 'not a member of this store';
  end if;
  if p_type not in ('paid', 'unpaid') then
    raise exception 'break type must be paid or unpaid';
  end if;
  select s.id into v_staff_id
  from public.pos_staff s
  where s.store_id = p_store_id and s.active and s.pin_hash = p_pin_hash
  limit 1;
  if not found then
    raise exception 'invalid PIN';
  end if;
  select p.id into v_punch_id
  from public.pos_time_punches p
  where p.staff_id = v_staff_id and p.punch_out is null
  order by p.punch_in desc
  limit 1;
  if not found then
    raise exception 'Not punched in.';
  end if;
  insert into public.pos_breaks (store_id, staff_id, punch_id, type)
  values (p_store_id, v_staff_id, v_punch_id, p_type)
  returning pos_breaks.id, pos_breaks.start
  into v_break_id, v_start;
  return query select v_break_id, v_staff_id, v_punch_id, p_type, v_start;
exception
  when unique_violation then
    raise exception 'a break is already open';
end $$;

-- End the currently open break for the PIN holder.
create or replace function public.pos_break_end(p_store_id uuid, p_pin_hash text)
returns table (id uuid, staff_id uuid, punch_id uuid, type text, start timestamptz, "end" timestamptz)
language plpgsql security definer
set search_path = public
as $$
declare
  v_staff_id uuid;
  v_row      public.pos_breaks%rowtype;
begin
  if auth.uid() is null then
    raise exception 'sign in to end a break';
  end if;
  if not public.is_pos_member(p_store_id) then
    raise exception 'not a member of this store';
  end if;
  select s.id into v_staff_id
  from public.pos_staff s
  where s.store_id = p_store_id and s.active and s.pin_hash = p_pin_hash
  limit 1;
  if not found then
    raise exception 'invalid PIN';
  end if;
  update public.pos_breaks
  set "end" = now()
  where pos_breaks.staff_id = v_staff_id and pos_breaks."end" is null
  returning pos_breaks.* into v_row;
  if not found then
    raise exception 'no open break';
  end if;
  return query select v_row.id, v_row.staff_id, v_row.punch_id, v_row.type, v_row.start, v_row."end";
end $$;

-- ============ pos_shifts (schedule) ============

create table if not exists public.pos_shifts (
  id         uuid primary key default gen_random_uuid(),
  store_id   uuid not null references public.pos_stores(id) on delete cascade,
  staff_id   uuid not null references public.pos_staff(id) on delete cascade,
  ymd        date not null,
  start      text not null check (start ~ '^[0-2][0-9]:[0-5][0-9]$'),
  "end"      text not null check ("end" ~ '^[0-2][0-9]:[0-5][0-9]$'),
  note       text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists pos_shifts_store_date on public.pos_shifts (store_id, ymd);
create index if not exists pos_shifts_staff_date on public.pos_shifts (staff_id, ymd);

alter table public.pos_shifts enable row level security;

drop policy if exists "pos_shifts_member_select" on public.pos_shifts;
create policy "pos_shifts_member_select"
  on public.pos_shifts for select
  using (public.is_pos_member(store_id));

drop policy if exists "pos_shifts_manager_insert" on public.pos_shifts;
create policy "pos_shifts_manager_insert"
  on public.pos_shifts for insert
  with check (public.pos_role(store_id) in ('owner', 'manager'));

drop policy if exists "pos_shifts_manager_update" on public.pos_shifts;
create policy "pos_shifts_manager_update"
  on public.pos_shifts for update
  using (public.pos_role(store_id) in ('owner', 'manager'))
  with check (public.pos_role(store_id) in ('owner', 'manager'));

drop policy if exists "pos_shifts_manager_delete" on public.pos_shifts;
create policy "pos_shifts_manager_delete"
  on public.pos_shifts for delete
  using (public.pos_role(store_id) in ('owner', 'manager'));

-- ============ pos_time_off ============

create table if not exists public.pos_time_off (
  id          uuid primary key default gen_random_uuid(),
  store_id    uuid not null references public.pos_stores(id) on delete cascade,
  staff_id    uuid not null references public.pos_staff(id) on delete cascade,
  kind        text not null check (kind in ('vacation', 'sick', 'unpaid')),
  from_date   date not null,
  to_date     date not null check (to_date >= from_date),
  reason      text not null default '',
  status      text not null default 'pending' check (status in ('pending', 'approved', 'denied')),
  decided_by  text,
  decided_at  timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists pos_time_off_store on public.pos_time_off (store_id, from_date);
create index if not exists pos_time_off_staff on public.pos_time_off (staff_id, from_date);

alter table public.pos_time_off enable row level security;

-- Any member reads requests; any member may file one (the backend verifies
-- the staff PIN, so requests are always filed as the PIN holder).
drop policy if exists "pos_time_off_member_select" on public.pos_time_off;
create policy "pos_time_off_member_select"
  on public.pos_time_off for select
  using (public.is_pos_member(store_id));

drop policy if exists "pos_time_off_member_insert" on public.pos_time_off;
create policy "pos_time_off_member_insert"
  on public.pos_time_off for insert
  with check (public.is_pos_member(store_id));

-- Only owners/managers decide or remove requests.
drop policy if exists "pos_time_off_manager_update" on public.pos_time_off;
create policy "pos_time_off_manager_update"
  on public.pos_time_off for update
  using (public.pos_role(store_id) in ('owner', 'manager'))
  with check (public.pos_role(store_id) in ('owner', 'manager'));

drop policy if exists "pos_time_off_manager_delete" on public.pos_time_off;
create policy "pos_time_off_manager_delete"
  on public.pos_time_off for delete
  using (public.pos_role(store_id) in ('owner', 'manager'));

-- File a time-off request as the PIN holder. The PIN is verified
-- server-side so pin_hash never needs a broad read policy; any store
-- member may file their own request, only managers decide.
create or replace function public.pos_timeoff_submit(
  p_store_id uuid, p_pin_hash text, p_kind text, p_from date, p_to date, p_reason text
)
returns table (id uuid)
language plpgsql security definer
set search_path = public
as $$
declare
  v_staff_id uuid;
  v_id       uuid;
begin
  if auth.uid() is null then
    raise exception 'sign in to request time off';
  end if;
  if not public.is_pos_member(p_store_id) then
    raise exception 'not a member of this store';
  end if;
  if p_kind not in ('vacation', 'sick', 'unpaid') then
    raise exception 'request kind must be vacation, sick or unpaid';
  end if;
  if p_to < p_from then
    raise exception 'the end date is before the start date';
  end if;
  select s.id into v_staff_id
  from public.pos_staff s
  where s.store_id = p_store_id and s.active and s.pin_hash = p_pin_hash
  limit 1;
  if not found then
    raise exception 'invalid PIN';
  end if;
  insert into public.pos_time_off (store_id, staff_id, kind, from_date, to_date, reason)
  values (p_store_id, v_staff_id, p_kind, p_from, p_to, coalesce(p_reason, ''))
  returning pos_time_off.id into v_id;
  return query select v_id;
end $$;

-- ============ pos_pay_periods ============

create table if not exists public.pos_pay_periods (
  id          uuid primary key default gen_random_uuid(),
  store_id    uuid not null references public.pos_stores(id) on delete cascade,
  from_date   date not null,
  to_date     date not null check (to_date >= from_date),
  status      text not null default 'open' check (status in ('open', 'approved')),
  approved_by text,
  approved_at timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists pos_pay_periods_store on public.pos_pay_periods (store_id, from_date);

alter table public.pos_pay_periods enable row level security;

drop policy if exists "pos_pay_periods_member_select" on public.pos_pay_periods;
create policy "pos_pay_periods_member_select"
  on public.pos_pay_periods for select
  using (public.is_pos_member(store_id));

drop policy if exists "pos_pay_periods_manager_insert" on public.pos_pay_periods;
create policy "pos_pay_periods_manager_insert"
  on public.pos_pay_periods for insert
  with check (public.pos_role(store_id) in ('owner', 'manager'));

drop policy if exists "pos_pay_periods_manager_update" on public.pos_pay_periods;
create policy "pos_pay_periods_manager_update"
  on public.pos_pay_periods for update
  using (public.pos_role(store_id) in ('owner', 'manager'))
  with check (public.pos_role(store_id) in ('owner', 'manager'));

drop policy if exists "pos_pay_periods_manager_delete" on public.pos_pay_periods;
create policy "pos_pay_periods_manager_delete"
  on public.pos_pay_periods for delete
  using (public.pos_role(store_id) in ('owner', 'manager'));

-- ============ pos_punch_settings ============
create table if not exists public.pos_punch_settings (
  store_id         uuid primary key references public.pos_stores(id) on delete cascade,
  week_start       text not null default 'monday' check (week_start in ('monday', 'sunday')),
  paid_break_min   integer not null default 15 check (paid_break_min >= 0 and paid_break_min <= 480),
  unpaid_break_min integer not null default 30 check (unpaid_break_min >= 0 and unpaid_break_min <= 480),
  grace_min        integer not null default 15 check (grace_min >= 0 and grace_min <= 480),
  updated_at       timestamptz not null default now()
);

alter table public.pos_punch_settings enable row level security;

drop policy if exists "pos_punch_settings_member_select" on public.pos_punch_settings;
create policy "pos_punch_settings_member_select"
  on public.pos_punch_settings for select
  using (public.is_pos_member(store_id));

drop policy if exists "pos_punch_settings_manager_upsert" on public.pos_punch_settings;
create policy "pos_punch_settings_manager_upsert"
  on public.pos_punch_settings for insert
  with check (public.pos_role(store_id) in ('owner', 'manager'));

drop policy if exists "pos_punch_settings_manager_update" on public.pos_punch_settings;
create policy "pos_punch_settings_manager_update"
  on public.pos_punch_settings for update
  using (public.pos_role(store_id) in ('owner', 'manager'))
  with check (public.pos_role(store_id) in ('owner', 'manager'));

-- ===== FILE: supabase/migrations/032_*.sql ======
-- 032_ambiguous_column_fix.sql
--
-- Fix "column reference is ambiguous" in RETURNS TABLE functions whose OUT
-- parameters (id, punch_out, balance_cents) shadow table column names.
-- Found live 2026-09-30: pos_clock_out failed on every punch-out
-- ("Punching out failed: column reference "id" is ambiguous").
-- The same pattern is fixed proactively in pos_punch_correct,
-- pos_giftcard_redeem, pos_giftcard_credit and pos_giftcard_void, which
-- share the identical defect (they would fail the same way on first use).
-- Fix: qualify every column reference with its table name. CREATE OR REPLACE
-- preserves the existing grants; no grant changes needed.

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
  -- Registers don't punch: only punch pads and the desktop may clock out.
  perform public.require_account_type('full', 'staff', 'punch');
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
  limit 1
  for update;
  if not found then
    raise exception 'not punched in';
  end if;
  update public.pos_time_punches
  set punch_out = now()
  where pos_time_punches.id = v_punch_id and pos_time_punches.punch_out is null
  returning pos_time_punches.punch_out into v_punch_out;
  if not found then
    raise exception 'not punched in';
  end if;
  return query select v_punch_id, v_staff_id, v_staff_name, v_punch_in, v_punch_out;
end $$;


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
  where pos_time_punches.id = p_punch_id;
  return query select p_punch_id, v_staff_id, p_punch_in, p_punch_out;
end $$;

create or replace function public.pos_giftcard_redeem(
  p_card_id uuid, p_amount_cents integer, p_sale_id uuid default null
)
returns table (id uuid, code text, balance_cents integer)
language plpgsql security definer
set search_path = public
as $$
declare
  v_store   uuid;
  v_balance integer;
  v_status  text;
begin
  if auth.uid() is null then
    raise exception 'sign in to redeem gift cards';
  end if;
  if coalesce(p_amount_cents, 0) <= 0 then
    raise exception 'amount must be positive';
  end if;
  select c.store_id, c.balance_cents, c.status
    into v_store, v_balance, v_status
    from public.pos_gift_cards c
   where c.id = p_card_id
   for update;
  if not found then
    raise exception 'gift card not found';
  end if;
  if not public.is_pos_member(v_store) then
    raise exception 'not a member of this store';
  end if;
  -- Punch-pad device sessions must never touch gift-card value.
  perform public.require_account_type('full', 'staff', 'pos');
  if v_status <> 'active' then
    raise exception 'gift card is void';
  end if;
  if v_balance < p_amount_cents then
    raise exception 'insufficient gift card balance';
  end if;
  update public.pos_gift_cards
     set balance_cents = pos_gift_cards.balance_cents - p_amount_cents
   where pos_gift_cards.id = p_card_id;
  insert into public.pos_gift_card_events (store_id, card_id, kind, amount_cents, balance_after_cents, sale_id, actor)
  values (v_store, p_card_id, 'redeemed', p_amount_cents, v_balance - p_amount_cents, p_sale_id, auth.uid());
  return query
    select c.id, c.code, c.balance_cents
      from public.pos_gift_cards c where c.id = p_card_id;
end;
$$;

create or replace function public.pos_giftcard_credit(
  p_card_id uuid, p_amount_cents integer, p_sale_id uuid default null
)
returns table (id uuid, code text, balance_cents integer)
language plpgsql security definer
set search_path = public
as $$
declare
  v_store   uuid;
  v_balance integer;
  v_initial integer;
  v_status  text;
  v_new     integer;
begin
  if auth.uid() is null then
    raise exception 'sign in to credit gift cards';
  end if;
  if coalesce(p_amount_cents, 0) <= 0 then
    raise exception 'amount must be positive';
  end if;
  select c.store_id, c.balance_cents, c.initial_cents, c.status
    into v_store, v_balance, v_initial, v_status
    from public.pos_gift_cards c
   where c.id = p_card_id
   for update;
  if not found then
    raise exception 'gift card not found';
  end if;
  if not public.is_pos_member(v_store) then
    raise exception 'not a member of this store';
  end if;
  -- Punch-pad device sessions must never touch gift-card value.
  perform public.require_account_type('full', 'staff', 'pos');
  if v_status <> 'active' then
    raise exception 'gift card is void';
  end if;
  v_new := least(v_initial, v_balance + p_amount_cents);
  update public.pos_gift_cards
     set balance_cents = v_new
   where pos_gift_cards.id = p_card_id;
  insert into public.pos_gift_card_events (store_id, card_id, kind, amount_cents, balance_after_cents, sale_id, actor)
  values (v_store, p_card_id, 'credited', p_amount_cents, v_new, p_sale_id, auth.uid());
  return query
    select c.id, c.code, c.balance_cents
      from public.pos_gift_cards c where c.id = p_card_id;
end;
$$;

create or replace function public.pos_giftcard_void(p_card_id uuid)
returns table (id uuid, code text, balance_cents integer)
language plpgsql security definer
set search_path = public
as $$
declare
  v_store   uuid;
  v_balance integer;
  v_initial integer;
  v_status  text;
begin
  if auth.uid() is null then
    raise exception 'sign in to void gift cards';
  end if;
  select c.store_id, c.balance_cents, c.initial_cents, c.status
    into v_store, v_balance, v_initial, v_status
    from public.pos_gift_cards c
   where c.id = p_card_id
   for update;
  if not found then
    raise exception 'gift card not found';
  end if;
  if public.pos_role(v_store) not in ('owner', 'manager') then
    raise exception 'only managers can void gift cards';
  end if;
  if v_status <> 'active' then
    raise exception 'gift card is already void';
  end if;
  if v_balance <> v_initial then
    raise exception 'card has been used — void is not allowed; its remaining balance stays valid';
  end if;
  update public.pos_gift_cards
     set status = 'void', balance_cents = 0
   where pos_gift_cards.id = p_card_id;
  insert into public.pos_gift_card_events (store_id, card_id, kind, amount_cents, balance_after_cents, actor)
  values (v_store, p_card_id, 'voided', v_initial, 0, auth.uid());
  return query
    select c.id, c.code, c.balance_cents
      from public.pos_gift_cards c where c.id = p_card_id;
end;
$$;


-- ===== FILE: supabase/migrations/033_*.sql ======
-- 033_punch_hardening.sql
--
-- Production hardening for the Poinçon (time clock) backend, from the
-- 2026-09-30 adversarial review:
--
--   1. PIN brute-force throttle on the five Poinçon PIN RPCs. Migration 023
--      throttled only pos_staff_login; pos_clock_in, pos_clock_out,
--      pos_break_start, pos_break_end and pos_timeoff_submit still allowed
--      unlimited PIN guesses. They now share the pos_pin_attempts log:
--      15 failures per store inside 10 minutes -> cooldown. The failure
--      row is INSERTed and the function RETURNS an empty set (never
--      "insert then raise" — the raise would roll the log row back; see
--      the critical note in 023). The client already maps an empty result
--      to "Invalid PIN", so behaviour is unchanged.
--   2. Approved (locked) pay periods now block punch corrections and
--      deletions. The Timesheets UI was already written to expect a
--      'Pay period is locked.' error (lockedErr mapper) but no migration
--      ever raised it — a manager could silently rewrite approved payroll.
--   3. Punching out auto-closes any open break at clock-out time. Before,
--      the break stayed open forever, inflating paid-break totals and
--      blocking the next break via the one-open-break unique index.
--   4. Shift times tightened to real clock hours (00:00-23:59). The old
--      check '^[0-2][0-9]:[0-5][0-9]$' accepted 24:00-29:59.
--   5. Direct INSERT into pos_time_off removed. Any member could insert a
--      request with a forged staff_id, bypassing the PIN check. Requests
--      now go only through pos_timeoff_submit (PIN-verified RPC), the same
--      model as pos_breaks and pos_time_punches.

-- ============ 1. shared throttle helper ============

create or replace function public.pos_pin_throttle_check(p_store_id uuid)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_failures int;
begin
  -- Housekeeping: drop yesterday's rows so the table stays tiny.
  -- (On the throttled path below this delete rolls back with the raise —
  -- harmless, it just runs on the next non-throttled call.)
  delete from public.pos_pin_attempts
   where attempted_at < now() - interval '1 day';
  -- 15 failures in 10 minutes -> cool down. Nothing has been written yet
  -- on this path, so the raise is safe here.
  select count(*) into v_failures
    from public.pos_pin_attempts
   where store_id = p_store_id
     and not success
     and attempted_at > now() - interval '10 minutes';
  if v_failures >= 15 then
    raise exception 'too many PIN attempts — wait a couple of minutes and try again';
  end if;
end $$;

revoke all on function public.pos_pin_throttle_check(uuid) from public, anon;

-- ============ 1a. pos_clock_in (throttled; was 029) ============

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
  perform public.pos_pin_throttle_check(p_store_id);
  -- Registers don't punch: only punch pads and the desktop may clock in.
  perform public.require_account_type('full', 'staff', 'punch');
  select s.id, s.name into v_staff_id, v_staff_name
  from public.pos_staff s
  where s.store_id = p_store_id and s.active and s.pin_hash = p_pin_hash
  limit 1;
  if not found then
    -- Failed PIN: log it and return an empty set. NO RAISE — the client
    -- maps "no rows" to "Invalid PIN" and the insert commits, which is
    -- what makes the throttle above actually work.
    insert into public.pos_pin_attempts (store_id, success)
    values (p_store_id, false);
    return;
  end if;
  -- Success resets the failure counter for the store.
  delete from public.pos_pin_attempts
   where store_id = p_store_id and not success;
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

-- ============ 1b. pos_clock_out (throttled + auto-close breaks; was 032) ============

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
  perform public.pos_pin_throttle_check(p_store_id);
  -- Registers don't punch: only punch pads and the desktop may clock out.
  perform public.require_account_type('full', 'staff', 'punch');
  select s.id, s.name into v_staff_id, v_staff_name
  from public.pos_staff s
  where s.store_id = p_store_id and s.active and s.pin_hash = p_pin_hash
  limit 1;
  if not found then
    -- Failed PIN: log it and return an empty set (see pos_clock_in).
    insert into public.pos_pin_attempts (store_id, success)
    values (p_store_id, false);
    return;
  end if;
  -- Success resets the failure counter for the store.
  delete from public.pos_pin_attempts
   where store_id = p_store_id and not success;
  select p.id, p.punch_in into v_punch_id, v_punch_in
  from public.pos_time_punches p
  where p.store_id = p_store_id and p.staff_id = v_staff_id and p.punch_out is null
  limit 1
  for update;
  if not found then
    raise exception 'not punched in';
  end if;
  update public.pos_time_punches
  set punch_out = now()
  where pos_time_punches.id = v_punch_id and pos_time_punches.punch_out is null
  returning pos_time_punches.punch_out into v_punch_out;
  if not found then
    raise exception 'not punched in';
  end if;
  -- An open break ends with the shift: close it at clock-out time so it
  -- neither inflates paid-break totals nor blocks the next break.
  update public.pos_breaks
  set "end" = v_punch_out
  where pos_breaks.staff_id = v_staff_id and pos_breaks."end" is null;
  return query select v_punch_id, v_staff_id, v_staff_name, v_punch_in, v_punch_out;
end $$;

-- ============ 1c. pos_break_start (throttled; was 031) ============

create or replace function public.pos_break_start(p_store_id uuid, p_pin_hash text, p_type text)
returns table (id uuid, staff_id uuid, punch_id uuid, type text, start timestamptz)
language plpgsql security definer
set search_path = public
as $$
declare
  v_staff_id uuid;
  v_punch_id uuid;
  v_break_id uuid;
  v_start    timestamptz;
begin
  if auth.uid() is null then
    raise exception 'sign in to start a break';
  end if;
  if not public.is_pos_member(p_store_id) then
    raise exception 'not a member of this store';
  end if;
  perform public.pos_pin_throttle_check(p_store_id);
  if p_type not in ('paid', 'unpaid') then
    raise exception 'break type must be paid or unpaid';
  end if;
  select s.id into v_staff_id
  from public.pos_staff s
  where s.store_id = p_store_id and s.active and s.pin_hash = p_pin_hash
  limit 1;
  if not found then
    -- Failed PIN: log it and return an empty set (see pos_clock_in).
    insert into public.pos_pin_attempts (store_id, success)
    values (p_store_id, false);
    return;
  end if;
  -- Success resets the failure counter for the store.
  delete from public.pos_pin_attempts
   where store_id = p_store_id and not success;
  select p.id into v_punch_id
  from public.pos_time_punches p
  where p.staff_id = v_staff_id and p.punch_out is null
  order by p.punch_in desc
  limit 1;
  if not found then
    raise exception 'Not punched in.';
  end if;
  insert into public.pos_breaks (store_id, staff_id, punch_id, type)
  values (p_store_id, v_staff_id, v_punch_id, p_type)
  returning pos_breaks.id, pos_breaks.start
  into v_break_id, v_start;
  return query select v_break_id, v_staff_id, v_punch_id, p_type, v_start;
exception
  when unique_violation then
    raise exception 'a break is already open';
end $$;

-- ============ 1d. pos_break_end (throttled; was 031) ============

create or replace function public.pos_break_end(p_store_id uuid, p_pin_hash text)
returns table (id uuid, staff_id uuid, punch_id uuid, type text, start timestamptz, "end" timestamptz)
language plpgsql security definer
set search_path = public
as $$
declare
  v_staff_id uuid;
  v_row      public.pos_breaks%rowtype;
begin
  if auth.uid() is null then
    raise exception 'sign in to end a break';
  end if;
  if not public.is_pos_member(p_store_id) then
    raise exception 'not a member of this store';
  end if;
  perform public.pos_pin_throttle_check(p_store_id);
  select s.id into v_staff_id
  from public.pos_staff s
  where s.store_id = p_store_id and s.active and s.pin_hash = p_pin_hash
  limit 1;
  if not found then
    -- Failed PIN: log it and return an empty set (see pos_clock_in).
    insert into public.pos_pin_attempts (store_id, success)
    values (p_store_id, false);
    return;
  end if;
  -- Success resets the failure counter for the store.
  delete from public.pos_pin_attempts
   where store_id = p_store_id and not success;
  update public.pos_breaks
  set "end" = now()
  where pos_breaks.staff_id = v_staff_id and pos_breaks."end" is null
  returning pos_breaks.* into v_row;
  if not found then
    raise exception 'no open break';
  end if;
  return query select v_row.id, v_row.staff_id, v_row.punch_id, v_row.type, v_row.start, v_row."end";
end $$;

-- ============ 1e. pos_timeoff_submit (throttled; was 031) ============

create or replace function public.pos_timeoff_submit(
  p_store_id uuid, p_pin_hash text, p_kind text, p_from date, p_to date, p_reason text
)
returns table (id uuid)
language plpgsql security definer
set search_path = public
as $$
declare
  v_staff_id uuid;
  v_id       uuid;
begin
  if auth.uid() is null then
    raise exception 'sign in to request time off';
  end if;
  if not public.is_pos_member(p_store_id) then
    raise exception 'not a member of this store';
  end if;
  perform public.pos_pin_throttle_check(p_store_id);
  if p_kind not in ('vacation', 'sick', 'unpaid') then
    raise exception 'request kind must be vacation, sick or unpaid';
  end if;
  if p_to < p_from then
    raise exception 'the end date is before the start date';
  end if;
  select s.id into v_staff_id
  from public.pos_staff s
  where s.store_id = p_store_id and s.active and s.pin_hash = p_pin_hash
  limit 1;
  if not found then
    -- Failed PIN: log it and return an empty set (see pos_clock_in).
    insert into public.pos_pin_attempts (store_id, success)
    values (p_store_id, false);
    return;
  end if;
  -- Success resets the failure counter for the store.
  delete from public.pos_pin_attempts
   where store_id = p_store_id and not success;
  insert into public.pos_time_off (store_id, staff_id, kind, from_date, to_date, reason)
  values (p_store_id, v_staff_id, p_kind, p_from, p_to, coalesce(p_reason, ''))
  returning pos_time_off.id into v_id;
  return query select v_id;
end $$;

-- ============ 2. locked periods block punch edits (was 032 / 007) ============

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
  if exists (
    select 1 from public.pos_pay_periods pp
    where pp.store_id = v_store_id
      and pp.status = 'approved'
      and (v_old_in::date) between pp.from_date and pp.to_date
  ) then
    raise exception 'Pay period is locked.';
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
  where pos_time_punches.id = p_punch_id;
  return query select p_punch_id, v_staff_id, p_punch_in, p_punch_out;
end $$;

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
  if exists (
    select 1 from public.pos_pay_periods pp
    where pp.store_id = v_store_id
      and pp.status = 'approved'
      and (v_old_in::date) between pp.from_date and pp.to_date
  ) then
    raise exception 'Pay period is locked.';
  end if;
  insert into public.pos_punch_audits
    (store_id, punch_id, action, edited_by, old_punch_in, old_punch_out)
  values
    (v_store_id, p_punch_id, 'delete', auth.uid(), v_old_in, v_old_out);
  delete from public.pos_time_punches where id = p_punch_id;
end $$;

-- ============ 4. shift times must be real clock hours ============

alter table public.pos_shifts drop constraint if exists pos_shifts_start_check;
alter table public.pos_shifts
  add constraint pos_shifts_start_check check (start ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$');
alter table public.pos_shifts drop constraint if exists pos_shifts_end_check;
alter table public.pos_shifts
  add constraint pos_shifts_end_check check ("end" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$');

-- ============ 5. time-off requests only via the PIN-verified RPC ============

drop policy if exists "pos_time_off_member_insert" on public.pos_time_off;

-- Keep the grants from 007/023/029 on the redefined functions.
revoke all on function public.pos_clock_in(uuid, text) from public, anon;
revoke all on function public.pos_clock_out(uuid, text) from public, anon;
revoke all on function public.pos_break_start(uuid, text, text) from public, anon;
revoke all on function public.pos_break_end(uuid, text) from public, anon;
revoke all on function public.pos_timeoff_submit(uuid, text, text, date, date, text) from public, anon;
revoke all on function public.pos_punch_correct(uuid, timestamptz, timestamptz) from public, anon;
revoke all on function public.pos_punch_delete(uuid) from public, anon;
grant execute on function public.pos_clock_in(uuid, text) to authenticated;
grant execute on function public.pos_clock_out(uuid, text) to authenticated;
grant execute on function public.pos_break_start(uuid, text, text) to authenticated;
grant execute on function public.pos_break_end(uuid, text) to authenticated;
grant execute on function public.pos_timeoff_submit(uuid, text, text, date, date, text) to authenticated;
grant execute on function public.pos_punch_correct(uuid, timestamptz, timestamptz) to authenticated;
grant execute on function public.pos_punch_delete(uuid) to authenticated;

-- ===== FILE: supabase/migrations/034_*.sql ======
-- 034_pos_refunds.sql
--
-- Refunds for POS sales. The refund dialog in the POS Rapports tab was
-- written against backend.pos.refundSale, but the method and its backend
-- were never implemented — confirming a refund crashed with a TypeError.
-- This migration completes the backend and lights the feature up behind a
-- dedicated `refunds` capability (carved out of the posUpgrades bundle the
-- same way gift cards were), instead of leaving it hidden forever.
--
--   pos_refunds: one row per refunded sale line (line_index + qty), so the
--     UI can show remaining refundable quantities and a double refund —
--     double-click, retry or race — is rejected server-side.
--   pos_refund_sale(p_sale_id, p_lines, p_reason, p_as_credit): atomic RPC.
--     Locks the sale row (concurrent refunds serialize), validates each
--     line against already-refunded quantities, computes the refund with
--     the same proportional math as the UI estimate (each line gets its
--     net share of the receipt total: discount + promo + tax allocated
--     proportionally), restocks inventory, and — for the "to credit"
--     method — issues a gift card as store credit (redeemable at tender
--     via the existing gift-card flow).
--
-- Writes go only through the RPC (no direct write policies), same model
-- as pos_breaks / pos_time_punches. Only owners/managers may refund,
-- mirroring pos_void_sale.

create table if not exists public.pos_refunds (
  id             uuid primary key default gen_random_uuid(),
  store_id       uuid not null references public.pos_stores(id) on delete cascade,
  sale_id        uuid not null references public.pos_sales(id) on delete cascade,
  line_index     int  not null check (line_index >= 0),
  qty            int  not null check (qty > 0),
  refunded_cents int  not null check (refunded_cents >= 0),
  method         text not null check (method in ('cash', 'credit')),
  reason         text not null default '',
  credit_card_id uuid references public.pos_gift_cards(id) on delete set null,
  created_by     uuid references auth.users(id) on delete set null,
  created_at     timestamptz not null default now()
);
create index if not exists pos_refunds_sale on public.pos_refunds (sale_id, line_index);
create index if not exists pos_refunds_store on public.pos_refunds (store_id, created_at desc);

alter table public.pos_refunds enable row level security;

-- Reads: members see refunds on their sales history. No direct
-- insert/update/delete policies: every write goes through pos_refund_sale.
drop policy if exists "pos_refunds_member_select" on public.pos_refunds;
create policy "pos_refunds_member_select"
  on public.pos_refunds for select
  using (public.is_pos_member(store_id));
drop policy if exists "pos_refunds_member_insert" on public.pos_refunds;
drop policy if exists "pos_refunds_member_update" on public.pos_refunds;
drop policy if exists "pos_refunds_member_delete" on public.pos_refunds;

create or replace function public.pos_refund_sale(
  p_sale_id uuid, p_lines jsonb, p_reason text default '', p_as_credit boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_store     uuid;
  v_number    bigint;
  v_items     jsonb;
  v_total     bigint;
  v_role      text;
  v_warnings  jsonb := '[]'::jsonb;
  v_sub       bigint := 0;   -- sum of line nets (price*qty - line discount)
  v_sel_net   bigint := 0;   -- selected (refunded) portion of v_sub
  v_refunded  bigint := 0;   -- final refund in cents
  v_out_lines jsonb := '[]'::jsonb;
  v_ccode     text := null;  -- store-credit gift card code
  v_ccard_id  uuid := null;
  ln          jsonb;
  v_idx       int;
  v_req_qty   int;
  v_already   int;
  v_remain    int;
  it          jsonb;
  v_line_qty  int;
  v_price     int;
  v_disc      int;
  v_line_net  bigint;
  v_line_sel  bigint;
  v_row_cents bigint;
  v_allocated bigint := 0;
  v_pid       uuid;
  v_bqid      uuid;
  v_bqstatus  text;
  v_name      text;
  i           int := 0;
  v_n         int;
begin
  if auth.uid() is null then
    raise exception 'sign in to refund sales';
  end if;
  -- Punch pads must never move money out.
  perform public.require_account_type('full', 'staff');

  -- Lock the sale row: concurrent refunds serialize here.
  select s.store_id, s.number, coalesce(s.items, '[]'::jsonb), s.total_cents
    into v_store, v_number, v_items, v_total
    from public.pos_sales s
   where s.id = p_sale_id
   for update;
  if not found then
    raise exception 'sale not found';
  end if;

  if not public.is_pos_member(v_store) then
    raise exception 'not a member of this store';
  end if;
  v_role := public.pos_role(v_store);
  if v_role not in ('owner', 'manager') then
    raise exception 'only managers can refund sales';
  end if;

  if (select s.voided from public.pos_sales s where s.id = p_sale_id) then
    raise exception 'sale is voided';
  end if;

  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'no refund lines given';
  end if;

  -- The proportional denominator: net over ALL sale lines (not just the
  -- selected ones). This mirrors the UI estimate exactly — using only the
  -- selected lines here would refund the whole receipt total for a partial
  -- return. It must stay the original full-sale net (not the remaining
  -- unrefunded net), otherwise a second partial refund would over-refund.
  for it in select * from jsonb_array_elements(v_items) loop
    v_sub := v_sub + (
      public._safe_int(it->>'priceCents', 0)::bigint
        * greatest(1, public._safe_int(it->>'qty', 0))
      - public._safe_int(it->>'itemDiscountCents', 0));
  end loop;

  -- Pass 1: validate every line and accumulate the selected net.
  -- Mirrors the UI estimate exactly: netOf = price*qty - itemDiscount,
  -- selectedNet = round((netOf/qty) * refundQty), refund =
  -- round((selectedNet/sub) * totalCents).
  for ln in select * from jsonb_array_elements(p_lines) loop
    v_idx     := public._safe_int(ln->>'index', -1);
    v_req_qty := public._safe_int(ln->>'qty', 0);
    if v_idx < 0 or v_idx >= jsonb_array_length(v_items) then
      raise exception 'refund line % is not on this sale', v_idx;
    end if;
    if v_req_qty <= 0 then
      raise exception 'refund quantity must be positive';
    end if;
    it := v_items -> v_idx;
    v_line_qty := greatest(1, public._safe_int(it->>'qty', 0));
    select coalesce(sum(r.qty), 0) into v_already
      from public.pos_refunds r
     where r.sale_id = p_sale_id and r.line_index = v_idx;
    v_remain := public._safe_int(it->>'qty', 0) - v_already;
    if v_req_qty > v_remain then
      raise exception 'only % of "%" can still be refunded',
        v_remain, coalesce(it->>'name', 'item');
    end if;
    v_price := public._safe_int(it->>'priceCents', 0);
    v_disc  := public._safe_int(it->>'itemDiscountCents', 0);
    v_line_net := (v_price::bigint * v_line_qty) - v_disc;
    v_line_sel := round((v_line_net::numeric / v_line_qty) * v_req_qty);
    v_sel_net := v_sel_net + v_line_sel;
    v_out_lines := v_out_lines || jsonb_build_object(
      'index', v_idx, 'qty', v_req_qty, 'lineSelNet', v_line_sel);
  end loop;

  v_refunded := case when v_sub > 0
    then round((v_sel_net::numeric / v_sub) * v_total)
    else 0 end;
  if v_refunded < 0 then
    v_refunded := 0;
  end if;

  -- "To credit": issue a gift card as store credit (redeemable at tender).
  if p_as_credit and v_refunded > 0 then
    select c.code, c.id into v_ccode, v_ccard_id
      from public.pos_giftcard_issue(
        v_store, v_refunded::int, 'Refund #' || v_number::text) c;
  end if;

  -- Pass 2: write refund rows (per-line cents allocated with the rounding
  -- remainder on the last row so the rows sum to exactly v_refunded) and
  -- restock. A per-line exception handler isolates corrupt lines as
  -- warnings; the transaction — refund rows plus every healthy restock —
  -- stays atomic.
  v_n := jsonb_array_length(v_out_lines);
  for ln in select * from jsonb_array_elements(v_out_lines) loop
    i := i + 1;
    v_idx     := (ln->>'index')::int;
    v_req_qty := (ln->>'qty')::int;
    v_line_sel := (ln->>'lineSelNet')::bigint;
    begin
      if i < v_n and v_sel_net > 0 then
        v_row_cents := round((v_line_sel::numeric / v_sel_net) * v_refunded);
      else
        v_row_cents := v_refunded - v_allocated; -- last row takes the remainder
      end if;
      if v_row_cents < 0 then
        v_row_cents := 0;
      end if;
      v_allocated := v_allocated + v_row_cents;

      insert into public.pos_refunds
        (store_id, sale_id, line_index, qty, refunded_cents, method, reason, credit_card_id, created_by)
      values
        (v_store, p_sale_id, v_idx, v_req_qty, v_row_cents,
         case when p_as_credit then 'credit' else 'cash' end,
         nullif(btrim(coalesce(p_reason, '')), ''), v_ccard_id, auth.uid());

      -- Restock the refunded line (gift-card lines are value, not stock).
      it := v_items -> v_idx;
      v_name := coalesce(it->>'name', 'item');
      if it->>'productId' ~ '^giftcard:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
        null; -- gift-card value is not inventory; nothing to restock
      elsif it->>'productId' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
        v_pid := (it->>'productId')::uuid;
        update public.pos_products
           set stock = stock + v_req_qty, updated_at = now()
         where id = v_pid and store_id = v_store and track_stock;
        if not found then
          if not exists (select 1 from public.pos_products where id = v_pid and store_id = v_store) then
            v_warnings := v_warnings || jsonb_build_object('line', v_name, 'issue', 'product no longer exists — quantity not restored');
          end if;
        end if;
      end if;

      -- Bouquinerie catalogue item.
      if it->>'bqItemId' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
        v_bqid := (it->>'bqItemId')::uuid;
        v_bqstatus := it->>'bqStatus';
        if v_bqstatus not in ('store', 'fair', 'sorting') then
          v_bqstatus := null; -- old sales did not record it; restore qty only
        end if;
        update public.bq_items
           set qty        = qty + v_req_qty,
               status     = case
                              when status = 'sold' and v_bqstatus is not null then v_bqstatus
                              else status
                            end,
               updated_at = now()
         where id = v_bqid and store_id = v_store;
        if not found then
          v_warnings := v_warnings || jsonb_build_object('line', v_name, 'issue', 'catalogue item no longer exists — quantity not restored');
        elsif v_bqstatus is null then
          v_warnings := v_warnings || jsonb_build_object('line', v_name, 'issue', 'quantity restored but shelf status unknown — verify where the item belongs');
        end if;
      end if;
    exception
      when others then
        v_warnings := v_warnings || jsonb_build_object('line', coalesce(v_name, 'item'), 'issue', 'could not record refund line — ' || sqlerrm);
    end;
  end loop;

  return jsonb_build_object(
    'refund', jsonb_build_object('refundedCents', v_refunded, 'lines', v_out_lines),
    'creditNote', case when v_ccode is null then null
                      else jsonb_build_object('code', v_ccode) end,
    'warnings', v_warnings);
end;
$$;

revoke all on function public.pos_refund_sale(uuid, jsonb, text, boolean) from public, anon;
grant execute on function public.pos_refund_sale(uuid, jsonb, text, boolean) to authenticated;
