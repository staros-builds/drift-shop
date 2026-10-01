-- 019_password_reset_tickets.sql
-- Logged-out password-reset / help requests + admin password-reset RPC.
--
-- 1. support_tickets.user_id becomes nullable so people who cannot sign in
--    (e.g. username-only accounts with no email address) can file a help
--    request from the login screen. Their account username is stored in the
--    new `username` column; admins see and resolve it through the existing
--    ticket inbox. No account-existence check is performed on purpose: the
--    response is identical whether or not the username exists (no
--    username enumeration).
-- 2. admin_reset_password(uuid, text): SECURITY DEFINER RPC letting a global
--    admin set a new password for any auth user. Used by the Admin panel
--    "Reset password" action on password-reset tickets. Invalidates the
--    user's existing sessions so the old password stops working everywhere.

-- ---------- logged-out tickets ----------
alter table public.support_tickets alter column user_id drop not null;

alter table public.support_tickets
  add column if not exists username text
  check (username is null or char_length(username) between 1 and 60);

-- Anonymous (logged-out) visitors may FILE a help request. They cannot read
-- any tickets. The username column is required so the admin knows which
-- account the request is about.
drop policy if exists "support_tickets_insert_anon" on public.support_tickets;
create policy "support_tickets_insert_anon"
  on public.support_tickets for insert
  to anon
  with check (
    user_id is null
    and username is not null
    and char_length(subject) between 1 and 200
    and char_length(message) between 1 and 5000
  );

-- ---------- admin password reset ----------
create extension if not exists pgcrypto with schema extensions;

create or replace function public.admin_reset_password(target_user_id uuid, new_password text)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if not public.is_admin() then
    raise exception 'not authorized';
  end if;
  if new_password is null
     or char_length(new_password) < 8
     or char_length(new_password) > 200 then
    raise exception 'password must be between 8 and 200 characters';
  end if;
  if not exists (select 1 from auth.users where id = target_user_id) then
    raise exception 'user not found';
  end if;
  update auth.users
     set encrypted_password = crypt(new_password, gen_salt('bf')),
         updated_at = now()
   where id = target_user_id;
  -- Invalidate existing sessions so the old password stops working everywhere.
  -- NOTE: auth.refresh_tokens.user_id is character varying in this schema,
  -- so cast the uuid parameter (uuid = varchar has no operator -> 42883).
  delete from auth.refresh_tokens where user_id = target_user_id::text;
end;
$$;

revoke all on function public.admin_reset_password(uuid, text) from public, anon;
grant execute on function public.admin_reset_password(uuid, text) to authenticated;
