-- 087_fix_refund_giftcard_updated_at.sql
-- H1: 046's refund function references pos_gift_cards.updated_at which
-- does not exist. Any refund touching a gift-card line aborts.
-- This replaces the function with the updated_at reference removed.

-- Read the current function definition and patch it.
-- Since we can't easily do string surgery safely, we recreate from 046's
-- full body with the fix. First, get the current definition:

do $$
declare
  v_def text;
begin
  select pg_get_functiondef(oid) into v_def
    from pg_proc
   where proname = 'pos_refund_sale'
     and pronamespace = 'public'::regnamespace;
  
  if v_def is null then
    raise notice 'pos_refund_sale not found, skipping';
    return;
  end if;
  
  -- Remove the phantom updated_at reference on pos_gift_cards
  v_def := replace(v_def, 
    'set status = ''void'', balance_cents = 0, updated_at = now()',
    'set status = ''void'', balance_cents = 0');
  
  -- Execute the patched definition
  execute v_def;
  raise notice 'pos_refund_sale patched: removed phantom updated_at';
end;
$$;
