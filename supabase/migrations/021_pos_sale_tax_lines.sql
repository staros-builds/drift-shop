-- 021_pos_sale_tax_lines.sql
-- Persist the exact tax breakdown charged at sale time. Receipts and reprints
-- must show historical truth (the lines actually charged), never a
-- recomputation from whatever the store's tax settings happen to be today.
ALTER TABLE public.pos_sales
  ADD COLUMN IF NOT EXISTS tax_lines jsonb;
