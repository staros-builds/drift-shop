-- 064: Fair sales join the sales ledger (all-in-one integration).
--
-- BEFORE: bouquinerie.recordFairSale wrote only to bq_fair_sales and then
-- decremented bq_items stock with a client-side read-then-write. Fair sales
-- were invisible to POS History and Reports, had no tax/refund path, and
-- two terminals selling the same last copy could lose a stock decrement.
--
-- NOW: every fair sale is first a pos_sales row with channel = 'fair', so
-- it flows through the exact same pipeline as a register sale — atomic
-- stock decrement (pos_apply_sale_stock, migration 026), History, Reports,
-- and the normal refund RPC (migration 046 restocks bq_items lines from
-- the sale's items JSON). bq_fair_sales remains the fair-day view and
-- links 1:1 to its ledger row via sale_id.
--
-- Fair prices are final amounts: fair sales are recorded tax-free
-- (tax_cents = 0, tax_lines = []) exactly as the old fair bookkeeping
-- treated them. No tax behaviour is invented here.
--
-- Historical bq_fair_sales rows are NOT backfilled into pos_sales: that
-- would fabricate ledger rows. They keep sale_id = NULL and continue to
-- count in the fair-day totals exactly as before.

alter table public.pos_sales
  add column if not exists channel text not null default 'register',
  add column if not exists fair_id uuid references public.bq_fairs(id) on delete set null,
  add column if not exists fair_name text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'pos_sales_channel_check') then
    alter table public.pos_sales
      add constraint pos_sales_channel_check check (channel in ('register', 'fair'));
  end if;
end $$;

-- Fair-day lookups over the ledger (History badge / Reports marker read the
-- columns through the normal sales queries; this index serves fair_id
-- joins from bq_fair_sales.sale_id back-references and fair filtering).
create index if not exists pos_sales_fair_id_idx
  on public.pos_sales (fair_id)
  where fair_id is not null;

alter table public.bq_fair_sales
  add column if not exists sale_id uuid references public.pos_sales(id) on delete set null;

-- One ledger row per fair-sale record: the unique partial index makes the
-- client-side link step retry-safe (a lost response can be replayed and
-- converges on the existing link instead of duplicating it).
create unique index if not exists bq_fair_sales_sale_id_key
  on public.bq_fair_sales (sale_id)
  where sale_id is not null;
