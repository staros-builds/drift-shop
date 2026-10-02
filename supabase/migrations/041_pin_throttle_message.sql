-- 041_pin_throttle_message.sql
--
-- Fixes the PIN throttle error message. The throttle triggers after 15
-- failed attempts in 10 minutes, and the cooldown lasts until those
-- failures age out of the 10-minute window. The old message said "wait
-- a couple of minutes" which was misleading — the actual wait is up to
-- 10 minutes. The message now states the real duration.

create or replace function public.pos_pin_throttle_check(p_store_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_failures int;
begin
  delete from public.pos_pin_attempts
   where attempted_at < now() - interval '1 day';
  select count(*) into v_failures
    from public.pos_pin_attempts
   where store_id = p_store_id
     and not success
     and attempted_at > now() - interval '10 minutes';
  if v_failures >= 15 then
    raise exception 'too many PIN attempts — wait 10 minutes and try again';
  end if;
end $$;

revoke all on function public.pos_pin_throttle_check(uuid) from public, anon;
