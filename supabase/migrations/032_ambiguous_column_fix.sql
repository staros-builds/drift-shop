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

