-- 014_bouquinerie_hardening.sql
-- Hardening fixes from the 2026-09-29 adversarial stress test.
--
-- Fixes:
--   1. bq_donation_items: cross-owner linking. The old policy checked only
--      that the DONATION belonged to the caller, so user A could link user B's
--      catalogue item into A's donation. The policy now requires BOTH the
--      donation and the item to belong to the authenticated user.
--   2. bq_fair_sales: same class of bug. The old policy checked only the FAIR's
--      ownership, so user A could record a sale of user B's item under A's own
--      fair. When item_id is set, the item must also belong to the caller.
--   3. Blank-but-not-NULL text: bq_items.title='', bq_special_orders.customer_name='',
--      bq_fairs.name='', bq_fair_sales.title='' were all accepted (201). Required
--      human-readable fields now reject empty/whitespace-only strings.
--
-- Idempotent: safe to re-run. Run in the Supabase dashboard SQL editor.
-- NOTE: if any existing rows violate the new non-blank constraints, the
-- ALTER TABLE will fail listing the offending row — clean those rows first.

-- ---------- 1. donation_items: both sides must belong to caller ----------
drop policy if exists "bq_donation_items_owner_all" on public.bq_donation_items;
create policy "bq_donation_items_owner_all" on public.bq_donation_items
  for all using (
    exists (select 1 from public.bq_donations d
            where d.id = donation_id and d.owner_id = auth.uid())
    and exists (select 1 from public.bq_items i
            where i.id = item_id and i.owner_id = auth.uid())
  ) with check (
    exists (select 1 from public.bq_donations d
            where d.id = donation_id and d.owner_id = auth.uid())
    and exists (select 1 from public.bq_items i
            where i.id = item_id and i.owner_id = auth.uid())
  );

-- ---------- 2. fair_sales: item must belong to caller when set ----------
drop policy if exists "bq_fair_sales_owner_all" on public.bq_fair_sales;
create policy "bq_fair_sales_owner_all" on public.bq_fair_sales
  for all using (
    exists (select 1 from public.bq_fairs f
            where f.id = fair_id and f.owner_id = auth.uid())
    and (item_id is null
         or exists (select 1 from public.bq_items i
                    where i.id = item_id and i.owner_id = auth.uid()))
  ) with check (
    exists (select 1 from public.bq_fairs f
            where f.id = fair_id and f.owner_id = auth.uid())
    and (item_id is null
         or exists (select 1 from public.bq_items i
                    where i.id = item_id and i.owner_id = auth.uid()))
  );

-- ---------- 3. non-blank constraints on required text ----------
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'bq_items_title_nonblank') then
    alter table public.bq_items
      add constraint bq_items_title_nonblank check (length(btrim(title)) > 0);
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'bq_fairs_name_nonblank') then
    alter table public.bq_fairs
      add constraint bq_fairs_name_nonblank check (length(btrim(name)) > 0);
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'bq_fair_sales_title_nonblank') then
    alter table public.bq_fair_sales
      add constraint bq_fair_sales_title_nonblank check (length(btrim(title)) > 0);
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'bq_special_orders_customer_nonblank') then
    alter table public.bq_special_orders
      add constraint bq_special_orders_customer_nonblank check (length(btrim(customer_name)) > 0);
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'bq_special_orders_title_nonblank') then
    alter table public.bq_special_orders
      add constraint bq_special_orders_title_nonblank check (length(btrim(title)) > 0);
  end if;
end $$;

-- donor_name is optional (nullable); only forbid whitespace-only when present.
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'bq_donations_donor_nonblank') then
    alter table public.bq_donations
      add constraint bq_donations_donor_nonblank
      check (donor_name is null or length(btrim(donor_name)) > 0);
  end if;
end $$;
