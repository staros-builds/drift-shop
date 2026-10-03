-- 098_account_recovery.sql
-- Email-independent account recovery.
--
-- The email backend is not the most reliable part of the platform, so
-- account recovery must NOT depend on it. This migration adds three
-- email-free recovery paths plus a shop-owner assisted reset:
--
-- 1. RECOVERY CODES — the account holder generates a set of one-time codes
--    (while signed in) and stores them somewhere safe. Each code is
--    SHA-256-hashed before it ever reaches the database; only hashes are
--    stored. Redeeming a code (logged out) sets a new password.
-- 2. SECURITY QUESTIONS — the holder sets 3 questions + answers (answers
--    are salted + SHA-256 hashed). Answering all three (logged out) sets a
--    new password.
-- 3. SHOP-OWNER ASSISTED RESET — a store owner/manager can reset passwords
--    for their shop's team login accounts, no email involved.
-- 4. MASTER RECOVERY KEY — the master account uses the same recovery-code
--    mechanism; the client shows the codes once after the forced first-
--    login password change.
--
-- Security properties (deliberate):
--  - Redeem RPCs are callable by anon (logged-out users need them) but are
--    enumeration-safe: unknown login, no codes set up, and wrong code all
--    produce the IDENTICAL error message.
--  - Rate limiting: 10 failed attempts per login per 15 minutes, then the
--    RPC refuses until the window passes. Codes carry ~62 bits of entropy
--    (12 chars from a 32-char alphabet), so 10 guesses per 15 min is
--    negligible.
--  - Recovery codes are single-use (used_at set atomically with the redeem).
--  - Every successful redeem kills all existing sessions (refresh tokens
--    deleted), exactly like admin_reset_password.
--  - shop_reset_staff_password refuses to touch global admins and the
--    master account — a shop owner can only reset their own team's
--    non-privileged accounts.
--  - The email reset flow is untouched and keeps working; the UI simply
--    de-emphasizes it.

create extension if not exists pgcrypto with schema extensions;

-- ---------- recovery codes ----------
create table if not exists public.recovery_codes (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  -- SHA-256 hex of the normalized code (client hashes before insert; the
  -- server never sees a plaintext code at rest).
  code_hash  text not null check (char_length(code_hash) = 64),
  created_at timestamptz not null default now(),
  used_at    timestamptz,
  label      text not null default 'recovery' check (char_length(label) between 1 and 40)
);
create index if not exists recovery_codes_user on public.recovery_codes (user_id) where used_at is null;
alter table public.recovery_codes enable row level security;

-- Owners can see and (re)generate their own codes. used_at is written only
-- by the redeem RPC (security definer, bypasses RLS); clients can never
-- un-burn a code.
drop policy if exists "recovery_codes_owner_select" on public.recovery_codes;
create policy "recovery_codes_owner_select"
  on public.recovery_codes for select
  to authenticated
  using (user_id = auth.uid());

drop policy if exists "recovery_codes_owner_insert" on public.recovery_codes;
create policy "recovery_codes_owner_insert"
  on public.recovery_codes for insert
  to authenticated
  with check (user_id = auth.uid() and used_at is null);

drop policy if exists "recovery_codes_owner_delete" on public.recovery_codes;
create policy "recovery_codes_owner_delete"
  on public.recovery_codes for delete
  to authenticated
  using (user_id = auth.uid());

-- ---------- security questions ----------
create table if not exists public.security_questions (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  -- Random per-user salt (hex); answers are sha256(salt || '|' || normalized_answer).
  salt         text not null check (char_length(salt) >= 16),
  -- JSON array of 3 question descriptors: [{ "key": "preset:pet" | "custom:<text>" }]
  questions    jsonb not null,
  -- Array of 3 hex hashes, parallel to questions.
  answer_hashes text[] not null check (array_length(answer_hashes, 1) = 3),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
alter table public.security_questions enable row level security;

drop policy if exists "security_questions_owner_all" on public.security_questions;
create policy "security_questions_owner_all"
  on public.security_questions for all
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- ---------- redeem rate limiting ----------
-- Keyed by normalized login string (so nonexistent logins are throttled
-- too, without leaking which logins exist). Rows older than a day are
-- cleaned lazily inside the redeem RPCs.
create table if not exists public.recovery_attempts (
  login_key      text primary key,
  attempts       integer not null default 0 check (attempts >= 0),
  last_attempt_at timestamptz not null default now()
);
alter table public.recovery_attempts enable row level security;
-- No direct client access: only the security-definer RPCs touch this table.
-- (No policies = deny all for anon/authenticated; the RPCs bypass RLS.)

-- ---------- helpers ----------
-- Resolve a login identifier (email OR username) to an auth user id.
-- Returns NULL when nothing matches. Usernames are matched case-
-- insensitively against profiles.username; emails against auth.users.email.
create or replace function public.recovery_resolve_login(p_login text)
returns uuid
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_login text := lower(trim(coalesce(p_login, '')));
  v_id uuid;
begin
  if v_login = '' then
    return null;
  end if;
  if position('@' in v_login) > 0 then
    select u.id into v_id from auth.users u where lower(u.email) = v_login limit 1;
  else
    select p.id into v_id from public.profiles p where lower(p.username) = v_login limit 1;
  end if;
  return v_id;
end;
$$;

-- Shared password-setter: validates, bcrypt-hashes, kills sessions.
create or replace function public.recovery_set_password(p_user_id uuid, p_new_password text)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if p_new_password is null
     or char_length(p_new_password) < 8
     or char_length(p_new_password) > 200
     or p_new_password !~ '\S' then
    raise exception 'password must be 8-200 characters and not blank';
  end if;
  if not exists (select 1 from auth.users where id = p_user_id) then
    raise exception 'user not found';
  end if;
  update auth.users
set encrypted_password=<redacted>
         updated_at = now()
   where id = p_user_id;
  delete from auth.refresh_tokens where user_id = p_user_id::text;
end;
$$;

-- Rate-limit gate. Returns true when the login may attempt a redeem.
create or replace function public.recovery_check_rate_limit(p_login_key text)
returns boolean
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_row public.recovery_attempts%rowtype;
begin
  -- Lazy cleanup of stale rows (older than a day).
  delete from public.recovery_attempts where last_attempt_at < now() - interval '1 day';
  select * into v_row from public.recovery_attempts where login_key = p_login_key;
  if not found then
    return true;
  end if;
  -- 10 failures inside a rolling 15-minute window blocks further attempts.
  if v_row.attempts >= 10 and v_row.last_attempt_at > now() - interval '15 minutes' then
    return false;
  end if;
  -- Window passed: reset the counter.
  if v_row.last_attempt_at <= now() - interval '15 minutes' then
    delete from public.recovery_attempts where login_key = p_login_key;
  end if;
  return true;
end;
$$;

create or replace function public.recovery_note_failure(p_login_key text)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  insert into public.recovery_attempts (login_key, attempts, last_attempt_at)
  values (p_login_key, 1, now())
  on conflict (login_key)
  do update set attempts = public.recovery_attempts.attempts + 1,
                  last_attempt_at = now();
end;
$$;

create or replace function public.recovery_note_success(p_login_key text)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  delete from public.recovery_attempts where login_key = p_login_key;
end;
$$;

-- ---------- redeem a recovery code (logged out) ----------
-- Enumeration-safe: unknown login, no codes, and wrong code all raise the
-- same 'invalid credentials' error.
create or replace function public.redeem_recovery_code(p_login text, p_code text, p_new_password text)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_login_key text := lower(trim(coalesce(p_login, '')));
  v_code text := upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g'));
  v_hash text;
  v_user_id uuid;
  v_code_id uuid;
begin
  if not public.recovery_check_rate_limit(v_login_key) then
    raise exception 'too many attempts, try again later';
  end if;

  v_hash := encode(digest(v_code, 'sha256'), 'hex');
  v_user_id := public.recovery_resolve_login(v_login_key);

  if v_user_id is not null then
    select rc.id into v_code_id
      from public.recovery_codes rc
     where rc.user_id = v_user_id
       and rc.used_at is null
       and rc.code_hash = v_hash
     limit 1;
  end if;

  if v_code_id is null then
    perform public.recovery_note_failure(v_login_key);
    -- Deliberately identical for unknown login / no codes / wrong code.
    raise exception 'invalid credentials';
  end if;

  -- Single-use: burn the code in the same statement flow as the redeem.
  update public.recovery_codes set used_at = now() where id = v_code_id and used_at is null;
  if not found then
    perform public.recovery_note_failure(v_login_key);
    raise exception 'invalid credentials';
  end if;

  perform public.recovery_set_password(v_user_id, p_new_password);
  perform public.recovery_note_success(v_login_key);
end;
$$;

-- ---------- security questions: read questions (logged out) ----------
-- Returns the 3 question descriptors for a login, or an empty array. The
-- questions themselves are not secret (the answers are); this lets the
-- login screen show the right prompts without an account.
create or replace function public.get_recovery_questions(p_login text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_user_id uuid;
  v_q jsonb;
begin
  v_user_id := public.recovery_resolve_login(p_login);
  if v_user_id is null then
    return '[]'::jsonb;
  end if;
  select sq.questions into v_q from public.security_questions sq where sq.user_id = v_user_id;
  if v_q is null then
    return '[]'::jsonb;
  end if;
  return v_q;
end;
$$;

-- ---------- redeem security answers (logged out) ----------
-- p_answers: JSON array of 3 answer strings, parallel to the stored
-- questions. All three must match (case/whitespace-insensitive).
create or replace function public.redeem_security_answers(p_login text, p_answers jsonb, p_new_password text)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_login_key text := lower(trim(coalesce(p_login, '')));
  v_user_id uuid;
  v_salt text;
  v_hashes text[];
  v_ok boolean := false;
  v_i int;
  v_ans text;
  v_h text;
begin
  if not public.recovery_check_rate_limit(v_login_key) then
    raise exception 'too many attempts, try again later';
  end if;

  if jsonb_typeof(p_answers) <> 'array' or jsonb_array_length(p_answers) <> 3 then
    perform public.recovery_note_failure(v_login_key);
    raise exception 'invalid credentials';
  end if;

  v_user_id := public.recovery_resolve_login(v_login_key);
  if v_user_id is not null then
    select sq.salt, sq.answer_hashes into v_salt, v_hashes
      from public.security_questions sq where sq.user_id = v_user_id;
  end if;

  if v_salt is not null then
    v_ok := true;
    for v_i in 0..2 loop
      v_ans := coalesce(p_answers ->> v_i, '');
      -- Normalize exactly like the client: lowercase, trim, collapse
      -- inner whitespace.
      v_ans := lower(regexp_replace(trim(v_ans), '\s+', ' ', 'g'));
      v_h := encode(digest(v_salt || '|' || v_ans, 'sha256'), 'hex');
      if v_h <> v_hashes[v_i + 1] then
        v_ok := false;
      end if;
    end loop;
  end if;

  if not v_ok then
    perform public.recovery_note_failure(v_login_key);
    raise exception 'invalid credentials';
  end if;

  perform public.recovery_set_password(v_user_id, p_new_password);
  perform public.recovery_note_success(v_login_key);
end;
$$;

-- ---------- shop-owner assisted reset ----------
-- A store owner/manager resets a team login account's password. The target
-- must belong to the same store (pos_store_members or device_store_id) and
-- must NOT be a global admin or the master account.
create or replace function public.shop_reset_staff_password(p_target_user_id uuid, p_new_password text)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_caller uuid := auth.uid();
  v_store_id uuid;
  v_target_role text;
  v_is_master boolean;
begin
  if v_caller is null then
    raise exception 'not authorized';
  end if;
  if p_target_user_id is null then
    raise exception 'user not found';
  end if;

  -- Find a store where the caller is owner/manager AND the target belongs.
  select m.store_id into v_store_id
    from public.pos_store_members m
    join public.pos_store_members tm
      on tm.store_id = m.store_id and tm.user_id = p_target_user_id
   where m.user_id = v_caller and m.role in ('owner', 'manager')
   limit 1;

  if v_store_id is null then
    -- Fallback: target's device account is pinned to a store the caller manages.
    select p.device_store_id into v_store_id
      from public.profiles p
     where p.id = p_target_user_id
       and p.device_store_id is not null
       and public.pos_role(p.device_store_id) in ('owner', 'manager')
     limit 1;
  end if;

  if v_store_id is null then
    raise exception 'not authorized';
  end if;

  -- Never let a shop owner reset a privileged account.
  select p.role, p.is_master into v_target_role, v_is_master
    from public.profiles p where p.id = p_target_user_id;
  if v_target_role = 'admin' or coalesce(v_is_master, false) then
    raise exception 'not authorized';
  end if;

  perform public.recovery_set_password(p_target_user_id, p_new_password);
end;
$$;

-- ---------- shop-owner team listing ----------
-- Login accounts a store owner/manager may assist: team members of the
-- store (pos_store_members) plus device accounts pinned to it.
create or replace function public.shop_list_team_logins(p_store_id uuid)
returns table (user_id uuid, username text, display_name text, shop_role text, account_type text, created_at timestamptz)
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if auth.uid() is null then
    raise exception 'not authorized';
  end if;
  if public.pos_role(p_store_id) not in ('owner', 'manager') then
    raise exception 'not authorized';
  end if;
  return query
    select p.id, p.username, p.display_name,
           coalesce(m.role, 'cashier') as shop_role,
           p.account_type, p.created_at
      from public.profiles p
      left join public.pos_store_members m
        on m.user_id = p.id and m.store_id = p_store_id
     where (m.store_id = p_store_id or p.device_store_id = p_store_id)
       and p.id <> auth.uid()
     order by p.username;
end;
$$;

-- ---------- grants ----------
-- Logged-out redeem path: callable by anon AND authenticated.
revoke all on function public.recovery_resolve_login(text) from public, anon;
revoke all on function public.recovery_set_password(uuid, text) from public, anon;
revoke all on function public.recovery_check_rate_limit(text) from public, anon;
revoke all on function public.recovery_note_failure(text) from public, anon;
revoke all on function public.recovery_note_success(text) from public, anon;

revoke all on function public.redeem_recovery_code(text, text, text) from public, anon;
grant execute on function public.redeem_recovery_code(text, text, text) to anon, authenticated;

revoke all on function public.get_recovery_questions(text) from public, anon;
grant execute on function public.get_recovery_questions(text) to anon, authenticated;

revoke all on function public.redeem_security_answers(text, jsonb, text) from public, anon;
grant execute on function public.redeem_security_answers(text, jsonb, text) to anon, authenticated;

revoke all on function public.shop_reset_staff_password(uuid, text) from public, anon;
grant execute on function public.shop_reset_staff_password(uuid, text) to authenticated;

revoke all on function public.shop_list_team_logins(uuid) from public, anon;
grant execute on function public.shop_list_team_logins(uuid) to authenticated;
