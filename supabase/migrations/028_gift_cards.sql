-- 028_gift_cards.sql
--
-- Gift cards: issue, redeem, credit (rollback), void, full audit ledger.
--
-- Concurrency is the whole game here: two registers redeeming the same
-- card at the same moment must never double-spend. Every balance mutation
-- goes through a SECURITY DEFINER RPC that locks the card row
-- (FOR UPDATE) and checks-then-updates in ONE transaction. There are no
-- direct INSERT/UPDATE/DELETE RLS policies on these tables at all — the
-- RPCs are the only writers, so the lock discipline cannot be bypassed.
--
-- Tables:
--   pos_gift_cards        one row per card (code unique per store)
--   pos_gift_card_events  append-only ledger: issued/redeemed/credited/voided
--
-- RPCs (all require store membership; void requires owner/manager):
--   pos_giftcard_issue(p_store_id, p_amount_cents, p_note)
--   pos_giftcard_redeem(p_card_id, p_amount_cents)
--   pos_giftcard_credit(p_card_id, p_amount_cents)   -- rollback / correction
--   pos_giftcard_void(p_card_id)                     -- manager+, only if untouched
--   pos_giftcard_lookup(p_store_id, p_code)
--   pos_giftcard_history(p_card_id)

create table if not exists public.pos_gift_cards (
  id            uuid primary key default gen_random_uuid(),
  store_id      uuid not null references public.pos_stores(id) on delete cascade,
  code          text not null,
  initial_cents integer not null check (initial_cents > 0),
  balance_cents integer not null check (balance_cents >= 0),
  note          text not null default '',
  status        text not null default 'active' check (status in ('active', 'void')),
  sold_at       timestamptz not null default now(),
  sold_by       uuid,
  created_at    timestamptz not null default now(),
  constraint pos_gift_cards_code_store_unique unique (store_id, code)
);
create index if not exists pos_gift_cards_store_status
  on public.pos_gift_cards (store_id, status, balance_cents);
alter table public.pos_gift_cards enable row level security;

create table if not exists public.pos_gift_card_events (
  id                uuid primary key default gen_random_uuid(),
  store_id          uuid not null references public.pos_stores(id) on delete cascade,
  card_id           uuid not null references public.pos_gift_cards(id) on delete cascade,
  kind              text not null check (kind in ('issued', 'redeemed', 'credited', 'voided')),
  amount_cents      integer not null check (amount_cents > 0),
  balance_after_cents integer not null check (balance_after_cents >= 0),
  sale_id           uuid references public.pos_sales(id) on delete set null,
  actor             uuid,
  created_at        timestamptz not null default now()
);
create index if not exists pos_gift_card_events_card
  on public.pos_gift_card_events (card_id, created_at);
alter table public.pos_gift_card_events enable row level security;

-- Read-only RLS: any member can read cards and their ledger. All writes go
-- through the RPCs below (deliberately NO insert/update/delete policies).
drop policy if exists "pos_gift_cards_member_select" on public.pos_gift_cards;
create policy "pos_gift_cards_member_select"
  on public.pos_gift_cards for select
  using (public.is_pos_member(store_id));

drop policy if exists "pos_gift_card_events_member_select" on public.pos_gift_card_events;
create policy "pos_gift_card_events_member_select"
  on public.pos_gift_card_events for select
  using (public.is_pos_member(store_id));

-- Issue a card. The code is generated server-side (GC-XXXXXXXX) and the
-- unique constraint + retry loop guarantees no two cards share a code even
-- under concurrent issuance.
create or replace function public.pos_giftcard_issue(
  p_store_id uuid, p_amount_cents integer, p_note text default ''
)
returns table (id uuid, code text, balance_cents integer, initial_cents integer)
language plpgsql security definer
set search_path = public
as $$
declare
  v_code  text;
  v_id    uuid;
  v_tries int := 0;
  alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
begin
  if auth.uid() is null then
    raise exception 'sign in to issue gift cards';
  end if;
  if not public.is_pos_member(p_store_id) then
    raise exception 'not a member of this store';
  end if;
  -- Punch-pad device sessions must never touch gift-card value.
  perform public.require_account_type('full', 'staff', 'pos');
  if coalesce(p_amount_cents, 0) <= 0 then
    raise exception 'amount must be positive';
  end if;
  if p_amount_cents > 100000000 then
    raise exception 'amount too large';
  end if;
  loop
    v_tries := v_tries + 1;
    -- 31 unambiguous chars (no I/L/O/0/1): index 1..31.
    select 'GC-' || string_agg(substr(alphabet, (random() * 30)::int + 1, 1), '' order by g)
      into v_code
      from generate_series(1, 8) g;
    begin
      insert into public.pos_gift_cards (store_id, code, initial_cents, balance_cents, note, sold_by)
      values (p_store_id, v_code, p_amount_cents, p_amount_cents, coalesce(p_note, ''), auth.uid())
      returning pos_gift_cards.id into v_id;
      insert into public.pos_gift_card_events (store_id, card_id, kind, amount_cents, balance_after_cents, actor)
      values (p_store_id, v_id, 'issued', p_amount_cents, p_amount_cents, auth.uid());
      exit;
    exception when unique_violation then
      if v_tries >= 10 then
        raise exception 'could not generate a unique card code';
      end if;
      -- retry with a fresh code
    end;
  end loop;
  return query
    select c.id, c.code, c.balance_cents, c.initial_cents
      from public.pos_gift_cards c where c.id = v_id;
end;
$$;

-- Redeem: lock the row, verify, decrement — atomically. A second concurrent
-- redeem waits on the lock, then sees the reduced balance: no double-spend.
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
     set balance_cents = balance_cents - p_amount_cents
   where id = p_card_id;
  insert into public.pos_gift_card_events (store_id, card_id, kind, amount_cents, balance_after_cents, sale_id, actor)
  values (v_store, p_card_id, 'redeemed', p_amount_cents, v_balance - p_amount_cents, p_sale_id, auth.uid());
  return query
    select c.id, c.code, c.balance_cents
      from public.pos_gift_cards c where c.id = p_card_id;
end;
$$;

-- Credit back (sale rollback / correction). Capped at the initial value so
-- a credit can never mint money beyond what was sold.
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
   where id = p_card_id;
  insert into public.pos_gift_card_events (store_id, card_id, kind, amount_cents, balance_after_cents, sale_id, actor)
  values (v_store, p_card_id, 'credited', p_amount_cents, v_new, p_sale_id, auth.uid());
  return query
    select c.id, c.code, c.balance_cents
      from public.pos_gift_cards c where c.id = p_card_id;
end;
$$;

-- Void a card: manager+ only, and only when it was never touched
-- (balance == initial). A partially-used card keeps its remaining balance
-- on the books; voiding it would destroy customer money.
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
   where id = p_card_id;
  insert into public.pos_gift_card_events (store_id, card_id, kind, amount_cents, balance_after_cents, actor)
  values (v_store, p_card_id, 'voided', v_initial, 0, auth.uid());
  return query
    select c.id, c.code, c.balance_cents
      from public.pos_gift_cards c where c.id = p_card_id;
end;
$$;

-- Tender lookup by code (case-insensitive, trims whitespace).
create or replace function public.pos_giftcard_lookup(p_store_id uuid, p_code text)
returns table (id uuid, code text, balance_cents integer, status text)
language plpgsql security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'sign in to look up gift cards';
  end if;
  if not public.is_pos_member(p_store_id) then
    raise exception 'not a member of this store';
  end if;
  -- Punch-pad device sessions must never touch gift-card value.
  perform public.require_account_type('full', 'staff', 'pos');
  return query
    select c.id, c.code, c.balance_cents, c.status
      from public.pos_gift_cards c
     where c.store_id = p_store_id
       and upper(btrim(c.code)) = upper(btrim(coalesce(p_code, '')))
     limit 1;
end;
$$;

-- Full audit ledger for one card, newest last.
create or replace function public.pos_giftcard_history(p_card_id uuid)
returns table (kind text, amount_cents integer, balance_after_cents integer, created_at timestamptz, sale_number integer)
language plpgsql security definer
set search_path = public
as $$
declare
  v_store uuid;
begin
  if auth.uid() is null then
    raise exception 'sign in to view gift card history';
  end if;
  select c.store_id into v_store from public.pos_gift_cards c where c.id = p_card_id;
  if not found then
    raise exception 'gift card not found';
  end if;
  if not public.is_pos_member(v_store) then
    raise exception 'not a member of this store';
  end if;
  -- Punch-pad device sessions must never touch gift-card value.
  perform public.require_account_type('full', 'staff', 'pos');
  return query
    select e.kind, e.amount_cents, e.balance_after_cents, e.created_at, s.number
      from public.pos_gift_card_events e
      left join public.pos_sales s on s.id = e.sale_id
     where e.card_id = p_card_id
     order by e.created_at asc;
end;
$$;

revoke all on function public.pos_giftcard_issue(uuid, integer, text) from public, anon;
revoke all on function public.pos_giftcard_redeem(uuid, integer, uuid) from public, anon;
revoke all on function public.pos_giftcard_credit(uuid, integer, uuid) from public, anon;
revoke all on function public.pos_giftcard_void(uuid) from public, anon;
revoke all on function public.pos_giftcard_lookup(uuid, text) from public, anon;
revoke all on function public.pos_giftcard_history(uuid) from public, anon;
grant execute on function public.pos_giftcard_issue(uuid, integer, text) to authenticated;
grant execute on function public.pos_giftcard_redeem(uuid, integer, uuid) to authenticated;
grant execute on function public.pos_giftcard_credit(uuid, integer, uuid) to authenticated;
grant execute on function public.pos_giftcard_void(uuid) to authenticated;
grant execute on function public.pos_giftcard_lookup(uuid, text) to authenticated;
grant execute on function public.pos_giftcard_history(uuid) to authenticated;

-- Voiding a gift-card SALE voids the card itself when it was never touched.
-- A partially-used card keeps its balance (the money is real); the void
-- reports a warning so staff handle it instead of silently destroying value.
create or replace function public.pos_void_sale(p_sale_id uuid, p_reason text default '')
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_store    uuid;
  v_items    jsonb;
  v_role     text;
  v_warnings jsonb := '[]'::jsonb;
  it         jsonb;
  v_qty      int;
  v_pid      uuid;
  v_bqid     uuid;
  v_bqstatus text;
  v_name     text;
  v_gcid     uuid;
  v_gcbalance int;
  v_gcinitial int;
  v_gcstatus  text;
begin
  if auth.uid() is null then
    raise exception 'sign in to void sales';
  end if;
  -- Device accounts can never void, even if a membership row were
  -- misconfigured with a manager role: the account type is the hard
  -- boundary, membership is only the second check.
  perform public.require_account_type('full', 'staff');

  -- Lock the sale row: concurrent voids serialize here.
  select s.store_id, coalesce(s.items, '[]'::jsonb)
    into v_store, v_items
    from public.pos_sales s
   where s.id = p_sale_id
   for update;
  if not found then
    raise exception 'sale not found';
  end if;

  select m.role into v_role
    from public.pos_store_members m
   where m.store_id = v_store and m.user_id = auth.uid();
  if v_role is null then
    raise exception 'not a member of this store';
  end if;
  if v_role not in ('owner', 'manager') then
    raise exception 'only managers can void sales';
  end if;

  if (select s.voided from public.pos_sales s where s.id = p_sale_id) then
    raise exception 'sale is already voided';
  end if;

  update public.pos_sales
     set voided      = true,
         voided_at   = now(),
         voided_by   = auth.uid(),
         void_reason = nullif(btrim(coalesce(p_reason, '')), '')
   where id = p_sale_id;

  -- Restock each line. A per-line exception handler isolates corrupt lines
  -- (bad UUID text, deleted product) as warnings; the transaction — void
  -- mark plus every healthy restock — stays atomic.
  for it in select * from jsonb_array_elements(v_items) loop
  begin
    v_qty  := greatest(0, public._safe_int(it->>'qty', 0));
    v_name := coalesce(it->>'name', 'item');
    if v_qty = 0 then
      continue;
    end if;

    -- Gift-card sale line: void the card itself when untouched. A used card
    -- keeps its remaining balance — voiding it would destroy customer money.
    if it->>'productId' ~ '^giftcard:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
      v_gcid := split_part(it->>'productId', ':', 2)::uuid;
      select c.balance_cents, c.initial_cents, c.status
        into v_gcbalance, v_gcinitial, v_gcstatus
        from public.pos_gift_cards c
       where c.id = v_gcid and c.store_id = v_store
       for update;
      if not found then
        v_warnings := v_warnings || jsonb_build_object('line', v_name, 'issue', 'gift card record missing — verify manually');
      elsif v_gcstatus = 'void' then
        null; -- already void; nothing to do
      elsif v_gcbalance = v_gcinitial then
        update public.pos_gift_cards set status = 'void', balance_cents = 0 where id = v_gcid;
        insert into public.pos_gift_card_events (store_id, card_id, kind, amount_cents, balance_after_cents, sale_id, actor)
        values (v_store, v_gcid, 'voided', v_gcinitial, 0, p_sale_id, auth.uid());
      else
        v_warnings := v_warnings || jsonb_build_object('line', v_name, 'issue', 'card was already used — its remaining balance stays valid; handle manually');
      end if;
      continue;
    end if;

    -- POS catalogue product (uuid text guarded: garbage becomes a warning,
    -- never an abort).
    if it->>'productId' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
      v_pid := (it->>'productId')::uuid;
      update public.pos_products
         set stock = stock + v_qty, updated_at = now()
       where id = v_pid and store_id = v_store and track_stock;
      if not found then
        -- Product deleted or stock-tracking off: nothing to restock.
        -- (Stock-tracking-off products never decremented, so warn only when
        -- the product itself is gone.)
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
         set qty        = qty + v_qty,
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
      v_warnings := v_warnings || jsonb_build_object('line', coalesce(v_name, 'item'), 'issue', 'could not restock — ' || sqlerrm);
  end;
  end loop;

  return jsonb_build_object('voided', true, 'warnings', v_warnings);
end;
$$;

revoke all on function public.pos_void_sale(uuid, text) from public, anon;
grant execute on function public.pos_void_sale(uuid, text) to authenticated;

-- Cancel a freshly issued card when the matching sale failed to record.
-- Without this, a crash between pos_giftcard_issue and the sale insert
-- leaves an active card with value and no sale on the books. Only an
-- untouched card (balance = initial, still active) issued within the last
-- 30 minutes can be cancelled, and only by the staff member who issued it
-- or a manager/owner — so nobody can silently kill a customer's card.
create or replace function public.pos_giftcard_cancel_issue(p_card_id uuid)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_store   uuid;
  v_balance integer;
  v_initial integer;
  v_status  text;
  v_sold_by uuid;
  v_sold_at timestamptz;
  v_role    text;
begin
  if auth.uid() is null then
    raise exception 'sign in to cancel a gift card issue';
  end if;
  select c.store_id, c.balance_cents, c.initial_cents, c.status, c.sold_by, c.sold_at
    into v_store, v_balance, v_initial, v_status, v_sold_by, v_sold_at
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
    raise exception 'gift card is not active';
  end if;
  if v_balance <> v_initial then
    raise exception 'card has already been used — cancel refused';
  end if;
  if v_sold_at < now() - interval '30 minutes' then
    raise exception 'card is too old to auto-cancel — void it from the gift card list';
  end if;
  select m.role into v_role
    from public.pos_store_members m
   where m.store_id = v_store and m.user_id = auth.uid();
  if v_sold_by is distinct from auth.uid() and coalesce(v_role, '') not in ('owner', 'manager') then
    raise exception 'only the issuer or a manager can cancel this card';
  end if;
  update public.pos_gift_cards
     set status = 'void', balance_cents = 0
   where id = p_card_id;
  insert into public.pos_gift_card_events (store_id, card_id, kind, amount_cents, balance_after_cents, actor)
  values (v_store, p_card_id, 'voided', v_initial, 0, auth.uid());
end;
$$;

revoke all on function public.pos_giftcard_cancel_issue(uuid) from public, anon;
grant execute on function public.pos_giftcard_cancel_issue(uuid) to authenticated;

-- Annotate a redeem/credit event with the sale it belongs to. Redemptions
-- happen before the sale row exists, so the client links them afterwards,
-- best-effort: a linking failure must never fail the sale itself. Matches
-- the most recent unlinked event of that kind+amount on the card.
create or replace function public.pos_giftcard_link_sale(p_card_id uuid, p_amount_cents integer, p_sale_id uuid)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_store uuid;
  v_event uuid;
begin
  if auth.uid() is null then
    raise exception 'sign in to link a gift card event';
  end if;
  select c.store_id into v_store
    from public.pos_gift_cards c
   where c.id = p_card_id;
  if not found then
    raise exception 'gift card not found';
  end if;
  if not public.is_pos_member(v_store) then
    raise exception 'not a member of this store';
  end if;
  -- Punch-pad device sessions must never touch gift-card value.
  perform public.require_account_type('full', 'staff', 'pos');
  if not exists (select 1 from public.pos_sales s where s.id = p_sale_id and s.store_id = v_store) then
    raise exception 'sale not found';
  end if;
  select e.id into v_event
    from public.pos_gift_card_events e
   where e.card_id = p_card_id
     and e.sale_id is null
     and e.kind in ('redeemed', 'credited')
     and e.amount_cents = p_amount_cents
   order by e.created_at desc
   limit 1;
  if v_event is not null then
    update public.pos_gift_card_events set sale_id = p_sale_id where id = v_event;
  end if;
end;
$$;

revoke all on function public.pos_giftcard_link_sale(uuid, integer, uuid) from public, anon;
grant execute on function public.pos_giftcard_link_sale(uuid, integer, uuid) to authenticated;

-- Safe helpers _safe_timestamptz and _safe_int are defined in migration 024
-- (the first migration that uses them). Permissions are set here.
revoke all on function public._safe_timestamptz(text) from public, anon;
grant execute on function public._safe_timestamptz(text) to authenticated;
revoke all on function public._safe_int(text, int) from public, anon;
grant execute on function public._safe_int(text, int) to authenticated;

-- Backup restore for gift cards. Cards and their ledger have no direct-write
-- RLS (all writes go through the RPCs above), so restores go through this
-- manager-only import. Merge semantics: a card whose code already exists in
-- the store is skipped (its ledger is already there); otherwise the card is
-- re-created with its backup balance and its non-issue events are replayed
-- as audit history. Sale links are remapped through p_sale_remap.
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
  v_sale_id   uuid;
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

  return jsonb_build_object(
    'cards_inserted', v_cards_ins, 'cards_skipped', v_cards_skip,
    'events_inserted', v_events_ins, 'events_skipped', v_events_skip);
end;
$$;

revoke all on function public.pos_giftcard_import(uuid, jsonb, jsonb, jsonb) from public, anon;
grant execute on function public.pos_giftcard_import(uuid, jsonb, jsonb, jsonb) to authenticated;
