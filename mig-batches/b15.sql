-- BATCH b15

-- ===== FILE: supabase/migrations/050_*.sql ======
-- Migration 050: Server-enforced idempotency for POS sale recording
--
-- NUCLEAR FAILSAFE: the offline queue generates client-side idempotency keys,
-- but nothing on the server enforced them. A sale could commit server-side,
-- lose its response (network blip), then be queued and replayed as a DUPLICATE
-- sale — a money bug. This migration adds a server-side unique idempotency key
-- so replays are safe: the second insert with the same key is rejected, and
-- the frontend treats the rejection as "already recorded" (returns the
-- existing sale).
--
-- The key is scoped per store (store_id, idempotency_key) so two shops can
-- never collide, and NULL keys (normal online sales) are exempt from the
-- unique index.

ALTER TABLE pos_sales ADD COLUMN IF NOT EXISTS idempotency_key text;

-- Bound key length (defense in depth: the frontend also validates).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'pos_sales' AND constraint_name = 'pos_sales_idempotency_key_len'
  ) THEN
    ALTER TABLE pos_sales
      ADD CONSTRAINT pos_sales_idempotency_key_len
      CHECK (idempotency_key IS NULL OR (char_length(idempotency_key) BETWEEN 1 AND 128));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS pos_sales_store_idempotency_key
  ON pos_sales(store_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- ===== FILE: supabase/migrations/051_*.sql ======
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

-- ===== FILE: supabase/migrations/052_*.sql ======
-- Migration 052: Atomic ISBN uniqueness for Bouquinerie imports
--
-- NUCLEAR FAILSAFE: the CSV import's duplicate check was list-then-insert
-- (TOCTOU) — two concurrent imports could both pass the check and insert
-- the same ISBN twice. This unique index makes ISBN uniqueness atomic at
-- the database level: the second concurrent insert is rejected, and the
-- frontend treats the rejection as "already imported" (skipped).
--
-- Scoped per store; NULL/empty ISBNs are exempt (those use the
-- title+author heuristic, which can't be a unique constraint because
-- legitimate duplicate copies exist).

CREATE UNIQUE INDEX IF NOT EXISTS bq_items_store_isbn_unique
  ON bq_items(store_id, isbn)
  WHERE isbn IS NOT NULL AND btrim(isbn) <> '';

-- ===== FILE: supabase/migrations/053_*.sql ======
-- 053_refund_digest_search_path.sql
--
-- FIX: pos_refund_sale calls digest() unqualified, but pgcrypto is installed
-- in the `extensions` schema (Supabase default), and the function pins
-- `set search_path = public`. Result: "function digest(text, unknown) does
-- not exist" on every refund. Add `extensions` to the function's search_path.
--
-- This is a metadata-only change; the function body is untouched.

ALTER FUNCTION public.pos_refund_sale(uuid, jsonb, text, boolean, text)
  SET search_path = public, extensions;

-- ===== FILE: supabase/migrations/054_*.sql ======
-- 054_refund_reason_empty_string.sql
--
-- FIX: pos_refund_sale uses nullif(btrim(coalesce(p_reason, '')), '')
-- which converts empty reasons to NULL, violating the NOT NULL constraint
-- on pos_refunds.reason. The UI labels reason as "(optional)", so empty
-- must insert as ''.
--
-- Surgical fix: replace the nullif wrapper with plain coalesce in the
-- live function definition.

DO $$
DECLARE
  v_def text;
  v_new text;
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_def
  FROM pg_proc
  WHERE proname = 'pos_refund_sale'
    AND pronamespace = 'public'::regnamespace;

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'pos_refund_sale function not found';
  END IF;

  v_new := replace(
    v_def,
    'nullif(btrim(coalesce(p_reason, '''')), '''')',
    'btrim(coalesce(p_reason, ''''))'
  );

  IF v_new = v_def THEN
    -- Target not found: the function may already carry the fixed expression
    -- (e.g. installed by 046 on fresh installs). Only raise when neither the
    -- old nor the fixed expression is present.
    IF position('btrim(coalesce(p_reason, ''''))' in v_def) = 0 THEN
      RAISE EXCEPTION 'Target expression not found in function definition';
    END IF;
    RETURN;
  END IF;

  EXECUTE v_new;
END $$;
