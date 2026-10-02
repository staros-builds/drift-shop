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
