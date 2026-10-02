-- BATCH b03 : migrations/003
-- ===== FILE: supabase/migrations/003_*.sql ======
-- ============================================================
-- Drift POS — RLS fixes (migration 003)
-- Run AFTER 002_pos_stores.sql in the Supabase dashboard SQL editor.
-- Idempotent: safe to re-run.
-- ============================================================

-- ---------- 1. Let the creator see their own store ----------
-- Root cause of "new row violates row-level security policy for table
-- pos_stores" on INSERT...RETURNING: the AFTER INSERT trigger
-- handle_new_pos_store() adds the creator as owner, but the RETURNING
-- clause's SELECT-policy check (is_pos_member(id)) cannot see that
-- trigger-created membership row in the RETURNING evaluation context,
-- so the check fails even though the insert policy passed and a plain
-- SELECT afterwards succeeds. Adding `created_by = auth.uid()` lets the
-- creator's own row pass the check directly — no membership lookup
-- needed, no snapshot subtlety. Members still see stores via
-- is_pos_member(); nothing else changes.
drop policy if exists "pos_stores_member_select" on public.pos_stores;
create policy "pos_stores_member_select"
  on public.pos_stores for select
  using (
    public.is_pos_member(id)
    or created_by = auth.uid()
  );

-- ---------- 2. Harden guest/anonymous bootstrap usernames ----------
-- handle_new_user() derived the profile username from metadata, falling
-- back to the email prefix — but anonymous (guest) users have no email,
-- so an anonymous sign-in without username metadata inserted a NULL
-- username and violated the NOT NULL constraint ("Database error
-- creating anonymous user"). Fall back to a 'Guest <id-fragment>'
-- username, which is unique per user by construction (unlike the
-- app's random 6-char tag, which could also collide on the unique
-- username index).
create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer as $$
declare
  is_first boolean;
  uname    text;
begin
  select count(*) = 0 into is_first from public.profiles;
  uname := coalesce(
    nullif(new.raw_user_meta_data ->> 'username', ''),
    nullif(split_part(new.email, '@', 1), ''),
    'Guest ' || substr(new.id::text, 1, 8)
  );
  insert into public.profiles (id, username, role, is_guest)
  values (new.id, uname,
          case when is_first then 'admin' else 'standard' end,
          coalesce((new.raw_user_meta_data ->> 'is_guest')::boolean, false))
  on conflict (id) do nothing;
  insert into public.user_settings (user_id) values (new.id)
  on conflict (user_id) do nothing;
  insert into public.vfs_folders (user_id, parent_id, name)
  values (new.id, null, 'root')
  on conflict do nothing;
  insert into public.spaces (user_id, name, sort_order)
  values (new.id, 'Main', 0),
         (new.id, 'Focus', 1),
         (new.id, 'Play', 2)
  on conflict do nothing;
  return new;
end $$;
