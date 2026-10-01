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
