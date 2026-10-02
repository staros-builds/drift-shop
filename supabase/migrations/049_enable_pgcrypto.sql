-- Migration 049: Enable pgcrypto for refund idempotency hashing
--
-- NUCLEAR FAILSAFE: migrations 040 (refund hardening) and 046 (gift-card void
-- restore) use digest(..., 'sha256') for idempotency payload hashing, but the
-- pgcrypto extension was never enabled in this project. Live QA proved refunds
-- fail with "function digest(text, unknown) does not exist". This migration
-- enables the extension so refunds work.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
