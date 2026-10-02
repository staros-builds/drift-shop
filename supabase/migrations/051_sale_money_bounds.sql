-- Migration 051: Database-side money bounds for POS sales
--
-- NUCLEAR FAILSAFE: the UI enforces money limits (product ≤ CA$10,000,
-- quantity ≤ 999/line, cash tender ≤ CA$100,000), but nothing on the server
-- stopped a hostile client from inserting absurd values directly. These
-- CHECK constraints + trigger make the database reject unsafe money states
-- even if the UI is bypassed.
--
-- Bounds (all in cents):
--   total_cents:     0 .. 100,000,000   (CA$1M max single sale — generous ceiling)
--   tendered_cents:  0 .. 10,000,000    (CA$100K max cash tender, matches UI)
--   change_cents:    0 .. 10,000,000    (change can't exceed tender ceiling)
--   subtotal_cents:  0 .. 100,000,000
--   discount_cents:  0 .. 100,000,000   (discount can't exceed subtotal ceiling)
--   tax_cents:       0 .. 20,000,000    (tax can't exceed 20% of max sale)
-- Per line item (items JSONB):
--   qty:             1 .. 999           (matches UI)
--   unit price:      0 .. 1,000,000     (CA$10K max, matches UI)

DO $$
BEGIN
  -- total_cents bound
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints
                 WHERE table_name = 'pos_sales' AND constraint_name = 'pos_sales_total_cents_bound') THEN
    ALTER TABLE pos_sales ADD CONSTRAINT pos_sales_total_cents_bound
      CHECK (total_cents >= 0 AND total_cents <= 100000000);
  END IF;
  -- tendered_cents bound
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints
                 WHERE table_name = 'pos_sales' AND constraint_name = 'pos_sales_tendered_cents_bound') THEN
    ALTER TABLE pos_sales ADD CONSTRAINT pos_sales_tendered_cents_bound
      CHECK (tendered_cents >= 0 AND tendered_cents <= 10000000);
  END IF;
  -- change_cents bound
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints
                 WHERE table_name = 'pos_sales' AND constraint_name = 'pos_sales_change_cents_bound') THEN
    ALTER TABLE pos_sales ADD CONSTRAINT pos_sales_change_cents_bound
      CHECK (change_cents >= 0 AND change_cents <= 10000000);
  END IF;
  -- subtotal_cents bound
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints
                 WHERE table_name = 'pos_sales' AND constraint_name = 'pos_sales_subtotal_cents_bound') THEN
    ALTER TABLE pos_sales ADD CONSTRAINT pos_sales_subtotal_cents_bound
      CHECK (subtotal_cents >= 0 AND subtotal_cents <= 100000000);
  END IF;
  -- discount_cents bound
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints
                 WHERE table_name = 'pos_sales' AND constraint_name = 'pos_sales_discount_cents_bound') THEN
    ALTER TABLE pos_sales ADD CONSTRAINT pos_sales_discount_cents_bound
      CHECK (discount_cents >= 0 AND discount_cents <= 100000000);
  END IF;
  -- tax_cents bound
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints
                 WHERE table_name = 'pos_sales' AND constraint_name = 'pos_sales_tax_cents_bound') THEN
    ALTER TABLE pos_sales ADD CONSTRAINT pos_sales_tax_cents_bound
      CHECK (tax_cents >= 0 AND tax_cents <= 20000000);
  END IF;
END $$;

-- Per-line-item bounds on the items JSONB array.
CREATE OR REPLACE FUNCTION pos_sales_check_item_bounds()
RETURNS trigger AS $$
DECLARE
  item jsonb;
  v_qty numeric;
  v_price numeric;
BEGIN
  IF NEW.items IS NULL THEN RETURN NEW; END IF;
  IF jsonb_typeof(NEW.items) <> 'array' THEN
    RAISE EXCEPTION 'sale items must be a JSON array';
  END IF;
  FOR item IN SELECT * FROM jsonb_array_elements(NEW.items) LOOP
    v_qty := NULLIF(item->>'qty', '')::numeric;
    v_price := NULLIF(item->>'priceCents', '')::numeric;
    -- qty: tolerate missing (default 1), but reject absurd values
    IF v_qty IS NOT NULL AND (v_qty < 1 OR v_qty > 999 OR v_qty <> floor(v_qty)) THEN
      RAISE EXCEPTION 'sale line quantity must be a whole number 1..999';
    END IF;
    -- unit price (priceCents): tolerate missing (default 0), reject absurd values
    IF v_price IS NOT NULL AND (v_price < 0 OR v_price > 1000000) THEN
      RAISE EXCEPTION 'sale line unit price must be 0..1000000 cents';
    END IF;
  END LOOP;
  RETURN NEW;
EXCEPTION WHEN invalid_text_representation THEN
  RAISE EXCEPTION 'sale line qty/price must be numeric';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS pos_sales_item_bounds ON pos_sales;
CREATE TRIGGER pos_sales_item_bounds
  BEFORE INSERT OR UPDATE ON pos_sales
  FOR EACH ROW EXECUTE FUNCTION pos_sales_check_item_bounds();
