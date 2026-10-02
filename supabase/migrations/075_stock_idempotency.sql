-- 075_stock_idempotency.sql — M-1 (nuclear QA): stock must be applied
-- EXACTLY once per (store_id, idempotency_key).
--
-- Migration 050 made the sale ROW idempotent (unique index on
-- (store_id, idempotency_key)), but pos_apply_sale_stock (026) has no
-- memory: a checkout whose first response was lost retries, the sale row
-- dedupes, and stock silently decrements a second time. This migration
-- adds the marker + claim-first RPC from the merge-round SQL review.
-- Idempotent: safe to re-run.
--
-- Back-compat: the existing 2-arg pos_apply_sale_stock(uuid, jsonb)
-- keeps its exact behavior (NULL-key legacy path), so every current
-- caller works unchanged; new callers pass the sale's idempotency key.

-- Marker table: one row per applied (store, key). RLS on, no policies:
-- only the SECURITY DEFINER function below touches it.
create table if not exists public.pos_stock_applications (
  store_id        uuid not null references public.pos_stores(id) on delete cascade,
  idempotency_key text not null
    check (char_length(idempotency_key) between 1 and 128),
  sale_id         uuid references public.pos_sales(id) on delete set null,
  results         jsonb,
  applied_at      timestamptz not null default now(),
  primary key (store_id, idempotency_key)
);
alter table public.pos_stock_applications enable row level security;

create or replace function public.pos_apply_sale_stock_once(
  p_store_id uuid,
  p_lines jsonb,
  p_idempotency_key text,
  p_sale_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_key      text := nullif(btrim(coalesce(p_idempotency_key, '')), '');
  v_claimed  timestamptz;
  v_prev     jsonb;
  v_applied  jsonb;
  v_results  jsonb;
begin
  -- No key: documented legacy path (exactly the old 026 behavior).
  if v_key is null then
    return public.pos_apply_sale_stock(p_store_id, p_lines);
  end if;

  -- Claim-first: the speculative insert waits for a concurrent winner,
  -- so its stored results are visible when we read them back.
  insert into public.pos_stock_applications (store_id, idempotency_key, sale_id)
  values (p_store_id, v_key, p_sale_id)
  on conflict do nothing
  returning applied_at into v_claimed;

  if v_claimed is null then
    select results into v_prev
      from public.pos_stock_applications
     where store_id = p_store_id and idempotency_key = v_key;
    return jsonb_build_object(
      'results', coalesce(v_prev, '[]'::jsonb),
      'already_applied', true
    );
  end if;

  -- We hold the claim: apply the 026 decrement inside this transaction.
  v_applied := public.pos_apply_sale_stock(p_store_id, p_lines);
  v_results := coalesce(v_applied -> 'results', '[]'::jsonb);
  update public.pos_stock_applications
     set results = v_results
   where store_id = p_store_id and idempotency_key = v_key;
  return jsonb_build_object('results', v_results, 'already_applied', false);
end;
$$;

revoke all on function public.pos_apply_sale_stock_once(uuid, jsonb, text, uuid) from public, anon;
grant execute on function public.pos_apply_sale_stock_once(uuid, jsonb, text, uuid) to authenticated;
