-- 015: harden updated_at on bouquinerie tables.
-- The bq_touch_updated_at() trigger only fires BEFORE UPDATE, so a client
-- can backdate updated_at on INSERT (verified 2026-09-29: inserting
-- updated_at='1900-01-01' stored it verbatim). The stated intent is
-- "keep updated_at honest" — fire on INSERT too.
drop trigger if exists bq_items_touch on public.bq_items;
create trigger bq_items_touch
  before insert or update on public.bq_items
  for each row execute function public.bq_touch_updated_at();

drop trigger if exists bq_special_orders_touch on public.bq_special_orders;
create trigger bq_special_orders_touch
  before insert or update on public.bq_special_orders
  for each row execute function public.bq_touch_updated_at();
