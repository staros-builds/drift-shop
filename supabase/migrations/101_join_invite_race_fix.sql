-- 101_join_invite_race_fix.sql
--
-- Fix race condition in join_pos_store: two concurrent joins could both
-- pass the `uses < max_uses` check and exceed the limit.
--
-- The fix: lock the invite row with FOR UPDATE before checking, so
-- concurrent transactions serialize on the row.
--
-- Idempotent: safe to re-run.

create or replace function public.join_pos_store(p_code text)
returns uuid
language plpgsql security definer
set search_path = public
as $$
declare
  inv record;
begin
  if auth.uid() is null then
    raise exception 'sign in to join a store';
  end if;
  -- FOR UPDATE locks the row: concurrent joins serialize here instead of
  -- both passing the uses < max_uses check.
  select * into inv from public.pos_invites
  where code = upper(trim(p_code))
    and (expires_at is null or expires_at > now())
    and (max_uses is null or uses < max_uses)
  for update;
  if not found then
    raise exception 'invite code not found or expired';
  end if;
  if exists (
    select 1 from public.pos_store_members
    where store_id = inv.store_id and user_id = auth.uid()
  ) then
    return inv.store_id; -- idempotent
  end if;
  insert into public.pos_store_members (store_id, user_id, role)
  values (inv.store_id, auth.uid(), inv.role);
  update public.pos_invites set uses = uses + 1 where id = inv.id;
  return inv.store_id;
end $$;
