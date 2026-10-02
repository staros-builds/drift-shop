-- 023_pin_throttle.sql
--
-- Server-side brute-force protection for staff PINs.
--
-- Staff PINs are short (4-8 digits) and the punch pad / POS kiosk sit
-- unattended in the shop, so guessing must be expensive: after 15 failed
-- PIN attempts for a store inside 10 minutes, every further PIN attempt
-- for that store is rejected for a short cooldown. A successful PIN entry
-- resets the counter, so one forgetful employee can't lock the shop out.
--
-- Only aggregate counters are stored (store + timestamp + outcome) — never
-- the attempted PIN or its hash, so the log itself is useless to an
-- attacker. No RLS policies: only SECURITY DEFINER functions touch it.

create table if not exists public.pos_pin_attempts (
  store_id     uuid not null references public.pos_stores(id) on delete cascade,
  attempted_at timestamptz not null default now(),
  success      boolean not null default false
);
create index if not exists pos_pin_attempts_store_time
  on public.pos_pin_attempts (store_id, attempted_at);
alter table public.pos_pin_attempts enable row level security;

-- Throttled replacement of the 004 pos_staff_login (same signature,
-- same grants). The throttle lives inside the definer so it cannot be
-- bypassed by calling the RPC differently.
--
-- CRITICAL correctness note: a failed attempt MUST be logged with a plain
-- INSERT followed by a normal RETURN (empty set), never "insert then raise".
-- In PostgreSQL, raising an exception aborts the whole statement and rolls
-- the failure row back with it — the throttle would never trigger. The
-- client already treats an empty result as "invalid PIN", so behaviour is
-- unchanged while the log actually persists.
create or replace function public.pos_staff_login(p_store_id uuid, p_pin_hash text)
returns table (id uuid, name text, role text)
language plpgsql security definer
set search_path = public
as $$
declare
  v_failures int;
begin
  if auth.uid() is null then
    raise exception 'sign in to use staff PINs';
  end if;
  if not public.is_pos_member(p_store_id) then
    raise exception 'not a member of this store';
  end if;
  -- Housekeeping: drop yesterday's rows so the table stays tiny.
  -- (On the throttled path below this delete rolls back with the raise —
  -- harmless, it just runs on the next non-throttled call.)
  delete from public.pos_pin_attempts
   where attempted_at < now() - interval '1 day';
  -- Throttle: 15 failures in 10 minutes -> cool down. Nothing has been
  -- written yet on this path, so the raise is safe here.
  select count(*) into v_failures
    from public.pos_pin_attempts
   where store_id = p_store_id
     and not success
     and attempted_at > now() - interval '10 minutes';
  if v_failures >= 15 then
    raise exception 'too many PIN attempts — wait a couple of minutes and try again';
  end if;
  -- NOTE: "if not found" must be checked immediately after the RETURN QUERY,
  -- because FOUND is reset by every subsequent SQL statement.
  return query
    select s.id, s.name, s.role
    from public.pos_staff s
    where s.store_id = p_store_id
      and s.active
      and s.pin_hash = p_pin_hash
    limit 1;
  if not found then
    -- Failed attempt: log it and return an empty set. NO RAISE — the client
    -- maps "no rows" to "invalid PIN" and the insert commits, which is what
    -- makes the throttle above actually work.
    insert into public.pos_pin_attempts (store_id, success)
    values (p_store_id, false);
    return;
  end if;
  -- Success resets the failure counter for the store.
  delete from public.pos_pin_attempts
   where store_id = p_store_id and not success;
  insert into public.pos_pin_attempts (store_id, success)
  values (p_store_id, true);
end $$;

revoke all on function public.pos_staff_login(uuid, text) from public;
grant execute on function public.pos_staff_login(uuid, text) to authenticated;
