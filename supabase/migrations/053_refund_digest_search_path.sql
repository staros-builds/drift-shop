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
