-- 036_require_account_type_fail_closed.sql
--
-- Security hardening: public.require_account_type() was fail-OPEN for
-- callers with no profile row (or a NULL account_type).
--
--   if not public.caller_account_type() = any (p_allowed) then raise ...
--
-- When caller_account_type() returns NULL, `NULL = any (...)` is NULL,
-- `not NULL` is NULL, and PL/pgSQL treats `IF NULL` as false — so the
-- exception was never raised and a NULL-type caller sailed through every
-- account-type gate (refunds, voids, gift cards, stock, punch, ...).
-- The comment above caller_account_type() says "fail closed", but the
-- code did the opposite.
--
-- The fixed version raises unless the caller's type is non-null AND in
-- the allowed list. Legitimate callers always have a non-null
-- account_type ('full', 'staff', 'pos', 'punch'), so behavior is unchanged
-- for them; only previously-silent NULL callers are now blocked.

create or replace function public.require_account_type(variadic p_allowed text[])
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_type text := public.caller_account_type();
begin
  if v_type is null or not (v_type = any (p_allowed)) then
    raise exception 'account type % cannot perform this action',
      coalesce(v_type, 'unknown');
  end if;
end;
$$;
