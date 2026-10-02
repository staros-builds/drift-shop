-- 073_restore_history_import.sql
--
-- Backup restore history imports for the two POS history tables that have
-- NO direct-write RLS by design:
--   - pos_refunds (migration 034): every write normally goes through
--     pos_refund_sale(), which RE-EXECUTES a refund (restock + new gift
--     card). Replaying a backup's cash refunds through it would produce
--     the wrong state, and replaying a store-credit refund would issue a
--     SECOND gift card for the same money.
--   - pos_breaks (migration 031): every write normally goes through the
--     PIN-verified break RPCs, which start/end live breaks — they cannot
--     write historical rows.
--
-- This migration follows the exact pattern of pos_punch_history_import
-- (migration 010) and pos_giftcard_import (migration 028): SECURITY DEFINER
-- RPCs, gated to master / owner / manager, inserting rows with their
-- original IDs, skipping IDs already present (idempotent by construction),
-- and skipping rows whose referenced records are not in this store.
--
-- Both functions return jsonb counts: { inserted, skipped }.
--
-- Idempotent: CREATE OR REPLACE; safe to re-run.

create extension if not exists pgcrypto with schema extensions;

-- ---------- pos_refund_history_import ----------
create or replace function public.pos_refund_history_import(
  p_store_id uuid,
  p_refunds jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_role    text;
  r         jsonb;
  v_id      uuid;
  v_sale_id uuid;
  v_card_id uuid;
  v_ins     int := 0;
  v_skip    int := 0;
begin
  if auth.uid() is null then
    raise exception 'sign in to restore refunds';
  end if;
  if not coalesce(public.is_master(), false) then
    select m.role into v_role
      from public.pos_store_members m
     where m.store_id = p_store_id and m.user_id = auth.uid();
    if v_role not in ('owner', 'manager') then
      raise exception 'only managers can restore refunds';
    end if;
  end if;
  perform public.require_account_type('full', 'staff');

  for r in select * from jsonb_array_elements(coalesce(p_refunds, '[]'::jsonb)) loop
    -- Rows without a real UUID cannot be re-attributed safely.
    if (r->>'id') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
      v_skip := v_skip + 1;
      continue;
    end if;
    v_id := (r->>'id')::uuid;
    if exists (select 1 from public.pos_refunds where id = v_id) then
      v_skip := v_skip + 1;
      continue;
    end if;
    -- The refund must belong to a sale that actually exists in this store.
    v_sale_id := null;
    if (r->>'sale_id') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
      select s.id into v_sale_id
        from public.pos_sales s
       where s.id = (r->>'sale_id')::uuid and s.store_id = p_store_id;
    end if;
    if v_sale_id is null then
      v_skip := v_skip + 1;
      continue;
    end if;
    -- Store credit card: kept only if that card exists in this store,
    -- otherwise NULL (the refund still restores; the link does not lie).
    v_card_id := null;
    if (r->>'credit_card_id') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
      select gc.id into v_card_id
        from public.pos_gift_cards gc
       where gc.id = (r->>'credit_card_id')::uuid and gc.store_id = p_store_id;
    end if;
    begin
      insert into public.pos_refunds
            (id, store_id, sale_id, line_index, qty, refunded_cents,
             method, reason, credit_card_id, created_by, created_at)
      values (v_id, p_store_id, v_sale_id,
              greatest(0, public._safe_int(r->>'line_index', 0)),
              greatest(1, public._safe_int(r->>'qty', 1)),
              greatest(0, public._safe_int(r->>'refunded_cents', 0)),
              case when r->>'method' = 'credit' then 'credit' else 'cash' end,
              coalesce(r->>'reason', ''),
              v_card_id,
              auth.uid(),
              coalesce(public._safe_timestamptz(r->>'created_at'), now()));
      v_ins := v_ins + 1;
    exception when others then
      -- A row that violates a check constraint is skipped, never fatal:
      -- the rest of the history still restores.
      v_skip := v_skip + 1;
    end;
  end loop;

  return jsonb_build_object('inserted', v_ins, 'skipped', v_skip);
end;
$$;

-- ---------- pos_break_history_import ----------
create or replace function public.pos_break_history_import(
  p_store_id uuid,
  p_breaks jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_role     text;
  r          jsonb;
  v_id       uuid;
  v_staff_id uuid;
  v_punch_id uuid;
  v_ins      int := 0;
  v_skip     int := 0;
begin
  if auth.uid() is null then
    raise exception 'sign in to restore break history';
  end if;
  if not coalesce(public.is_master(), false) then
    select m.role into v_role
      from public.pos_store_members m
     where m.store_id = p_store_id and m.user_id = auth.uid();
    if v_role not in ('owner', 'manager') then
      raise exception 'only managers can restore break history';
    end if;
  end if;
  perform public.require_account_type('full', 'staff');

  for r in select * from jsonb_array_elements(coalesce(p_breaks, '[]'::jsonb)) loop
    if (r->>'id') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
      v_skip := v_skip + 1;
      continue;
    end if;
    v_id := (r->>'id')::uuid;
    if exists (select 1 from public.pos_breaks where id = v_id) then
      v_skip := v_skip + 1;
      continue;
    end if;
    -- A break belongs to a staff row that must exist in this store.
    v_staff_id := null;
    if (r->>'staff_id') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
      select s.id into v_staff_id
        from public.pos_staff s
       where s.id = (r->>'staff_id')::uuid and s.store_id = p_store_id;
    end if;
    if v_staff_id is null then
      v_skip := v_skip + 1;
      continue;
    end if;
    v_punch_id := null;
    if (r->>'punch_id') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
      select p.id into v_punch_id
        from public.pos_time_punches p
       where p.id = (r->>'punch_id')::uuid and p.store_id = p_store_id;
    end if;
    begin
      insert into public.pos_breaks
            (id, store_id, staff_id, punch_id, type, start, "end", created_at)
      values (v_id, p_store_id, v_staff_id, v_punch_id,
              case when r->>'type' = 'paid' then 'paid' else 'unpaid' end,
              coalesce(public._safe_timestamptz(r->>'start'), now()),
              public._safe_timestamptz(r->>'end'),
              coalesce(public._safe_timestamptz(r->>'created_at'), now()));
      v_ins := v_ins + 1;
    exception when others then
      -- Includes the one-open-break-per-staff unique index: skipped,
      -- never fatal.
      v_skip := v_skip + 1;
    end;
  end loop;

  return jsonb_build_object('inserted', v_ins, 'skipped', v_skip);
end;
$$;

revoke all on function public.pos_refund_history_import(uuid, jsonb) from public, anon;
revoke all on function public.pos_break_history_import(uuid, jsonb) from public, anon;
grant execute on function public.pos_refund_history_import(uuid, jsonb) to authenticated;
grant execute on function public.pos_break_history_import(uuid, jsonb) to authenticated;
