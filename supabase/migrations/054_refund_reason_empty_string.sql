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
    RAISE EXCEPTION 'Target expression not found in function definition';
  END IF;

  EXECUTE v_new;
END $$;
