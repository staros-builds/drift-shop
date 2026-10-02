-- 069_pin_kdf.sql (renumbered at the final merge; drafted as 999).
-- Idempotent: safe to re-run. It was drafted against migration 063 by
-- the hardening follow-ups worker on 2026-10-01.
--
-- Salted staff-PIN storage (phase 1 of 2).
--
-- Today pos_staff.pin_hash holds an UNSALTED SHA-256 hex of the PIN
-- (migration 004). PINs are 4–8 digits, so anyone who obtains the table
-- (a leaked backup, an over-broad future read policy) can brute-force
-- every PIN offline in seconds. Passwords already use bcrypt
-- (extensions.crypt, migration 049); PINs were the odd one out. This
-- migration moves PIN verification to per-PIN salted bcrypt WITHOUT
-- breaking a single running terminal:
--
--   1. New nullable column pos_staff.pin_kdf (bcrypt hash of the PIN).
--      pin_hash stays NOT NULL and keeps being written — the punch RPCs
--      (pos_clock_in/out, pos_break_start/end, pos_timeoff_submit) are
--      untouched in this phase and keep verifying pin_hash exactly as
--      they do today.
--   2. pos_staff_set_pin(p_staff_id, p_pin): manager-gated RPC the
--      client calls whenever a PIN is set. Writes pin_kdf (bcrypt) AND
--      pin_hash (legacy SHA-256) from the same PIN, server-side, so the
--      two can never diverge. PIN format (4–8 digits) is enforced here;
--      the common-PIN blocklist stays client-side, same trust level as
--      today's direct pin_hash writes.
--   3. pos_staff_login2(p_store_id, p_pin): drop-in replacement for
--      pos_staff_login with the SAME return shape and the SAME throttle
--      semantics as migration 023 (shared pos_pin_throttle_check helper
--      from 033/041; a failed attempt is logged with INSERT + RETURN
--      empty set, never insert-then-raise). Verification is bcrypt-first
--      per staff row; a row whose pin_kdf is still NULL falls back to
--      the legacy SHA-256 compare, and on a legacy success the row's
--      pin_kdf is backfilled immediately (opportunistic upgrade), so
--      every active PIN migrates itself the next time it is used.
--
-- Legacy strategy, plainly: existing SHA-256 rows keep working until
-- their PIN is next set (pos_staff_set_pin) or next used at login
-- (backfill above). OWNERS: to upgrade every staff PIN immediately
-- after applying this migration, re-save each staff member's PIN in
-- Admin → Staff — one pass upgrades the whole roster; anyone you skip
-- still logs in fine and upgrades on their next shift.
--
-- Wire note: pos_staff_login2 receives the PIN itself (over TLS) so the
-- server can bcrypt-verify it; the PIN is never stored, logged, or put
-- in pos_pin_attempts. The punch RPCs still receive only the legacy
-- hash, exactly as before.
--
-- Factory reset: factory_reset() truncates pos_staff (migration 057),
-- so every pin_kdf value disappears with its staff row. The empty
-- column that remains is inert; the master account reseeds through the
-- auth/bcrypt path and never had a staff PIN. No reset change needed.
--
-- PHASE 2 (future migration, NOT in this file): switch the five punch
-- RPCs to take p_pin and verify through pin_kdf, then stop writing
-- pin_hash and drop the column. Phase 1 deliberately leaves the punch
-- surface untouched so it can ship and soak independently.

-- ---------- 1. salted credential column ----------
alter table public.pos_staff
  add column if not exists pin_kdf text;

comment on column public.pos_staff.pin_kdf is
  'bcrypt (pgcrypto crypt) hash of the staff PIN; NULL = legacy SHA-256-only row, upgraded on next PIN set or successful login (migration 069, phase 1).';

-- ---------- 2. manager-gated PIN setter ----------
-- Gate mirrors the pos_staff table policy (pos_staff_manager_all,
-- migration 004): only the store's owners/managers may write staff rows,
-- so only they may set PINs. Both credential columns are written from
-- the same PIN in one statement — they cannot diverge.
create or replace function public.pos_staff_set_pin(p_staff_id uuid, p_pin text)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_store_id uuid;
begin
  if auth.uid() is null then
    raise exception 'sign in to set staff PINs';
  end if;
  select s.store_id into v_store_id
    from public.pos_staff s
   where s.id = p_staff_id;
  if v_store_id is null then
    raise exception 'staff member not found';
  end if;
  if public.pos_role(v_store_id) not in ('owner', 'manager') then
    raise exception 'only owners and managers can set staff PINs';
  end if;
  if p_pin is null or p_pin !~ '^\d{4,8}$' then
    raise exception 'PIN must be 4-8 digits';
  end if;
  update public.pos_staff
     set pin_kdf  = extensions.crypt(p_pin, extensions.gen_salt('bf')),
         pin_hash = encode(extensions.digest(p_pin, 'sha256'), 'hex')
   where id = p_staff_id;
end $$;

-- ---------- 3. salted login (bcrypt-first, legacy fallback) ----------
-- Same contract as migration 023's pos_staff_login: member-gated,
-- throttled (shared helper, 033/041 message), empty result set on a bad
-- PIN (the failure row must commit — see the critical note in 023),
-- success wipes the failure counter.
create or replace function public.pos_staff_login2(p_store_id uuid, p_pin text)
returns table (id uuid, name text, role text)
language plpgsql security definer
set search_path = public
as $$
declare
  v_legacy  text := encode(extensions.digest(coalesce(p_pin, ''), 'sha256'), 'hex');
  v_staff   record;
  v_matched boolean := false;
  v_legacy_match boolean := false;
begin
  if auth.uid() is null then
    raise exception 'sign in to use staff PINs';
  end if;
  if not public.is_pos_member(p_store_id) then
    raise exception 'not a member of this store';
  end if;
  perform public.pos_pin_throttle_check(p_store_id);
  -- First match wins, in creation order — the same "some staff member
  -- with this PIN" semantics the legacy single-hash lookup had. bcrypt
  -- rows verify against pin_kdf; rows not yet upgraded verify against
  -- the legacy hash and are flagged for backfill below.
  for v_staff in
    select s.id, s.name, s.role, s.pin_hash, s.pin_kdf
      from public.pos_staff s
     where s.store_id = p_store_id
       and s.active
     order by s.created_at, s.id
  loop
    if v_staff.pin_kdf is not null then
      if extensions.crypt(p_pin, v_staff.pin_kdf) = v_staff.pin_kdf then
        v_matched := true;
        exit;
      end if;
    elsif v_staff.pin_hash = v_legacy then
      v_matched := true;
      v_legacy_match := true;
      exit;
    end if;
  end loop;
  if not v_matched then
    -- Failed attempt: log it and return an empty set. NO RAISE (023).
    insert into public.pos_pin_attempts (store_id, success)
    values (p_store_id, false);
    return;
  end if;
  if v_legacy_match then
    -- Opportunistic upgrade: this PIN just proved itself, so give the
    -- row its salted hash now. pin_hash stays (phase 1 — punch RPCs
    -- still verify it).
    update public.pos_staff
       set pin_kdf = extensions.crypt(p_pin, extensions.gen_salt('bf'))
     where id = v_staff.id
       and pin_kdf is null;
  end if;
  -- Success resets the failure counter for the store (023 semantics).
  delete from public.pos_pin_attempts
   where store_id = p_store_id and not success;
  insert into public.pos_pin_attempts (store_id, success)
  values (p_store_id, true);
  return query select v_staff.id, v_staff.name, v_staff.role;
end $$;

-- ---------- grants (house style: authenticated only) ----------
revoke all on function public.pos_staff_set_pin(uuid, text) from public, anon;
revoke all on function public.pos_staff_login2(uuid, text) from public, anon;
grant execute on function public.pos_staff_set_pin(uuid, text) to authenticated;
grant execute on function public.pos_staff_login2(uuid, text) to authenticated;
