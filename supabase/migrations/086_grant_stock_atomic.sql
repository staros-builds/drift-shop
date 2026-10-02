-- 086_grant_stock_atomic.sql
-- H2: 084 created pos_adjust_stock_atomic with revoke-only (no grant),
-- making it uncallable. Add the missing grant.

grant execute on function public.pos_adjust_stock_atomic(uuid, uuid, int) to authenticated;
