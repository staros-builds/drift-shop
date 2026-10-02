-- 012_guest_username_collision.sql
--
-- Make handle_new_user() resilient to guest username collisions.
--
-- Root cause (2026-09-29): guest usernames came from a client-generated tag.
-- crypto.randomUUID() requires a secure context; on plain-HTTP pages the
-- fallback sliced 6 chars off a timestamp whose leading digits are stable for
-- ~an hour, so every anonymous signup in that window sent the SAME username.
-- The plain INSERT below then raised 23505 on profiles_username_key and
-- GoTrue returned HTTP 500 "Database error creating anonymous user" for
-- every signup after the first one claimed the name.
--
-- The client now generates collision-safe tags, but the trigger is the last
-- line of defense: on a username collision it retries with a random suffix
-- instead of aborting the whole signup.

create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer as $$
declare
  is_first  boolean;
  uname     text;
  is_g      boolean;
  attempt   int := 0;
  uname_try text;
begin
  select count(*) = 0 into is_first from public.profiles;
  is_g := coalesce((new.raw_user_meta_data ->> 'is_guest')::boolean, false);
  uname := coalesce(
    nullif(new.raw_user_meta_data ->> 'username', ''),
    nullif(split_part(new.email, '@', 1), ''),
    'guest'
  );
  -- Retry with a random suffix when the username is already taken; without
  -- this a collision aborts the entire signup with a 500.
  uname_try := uname;
  loop
    begin
      insert into public.profiles
        (id, username, role, is_guest, trial_started_at, trial_ends_at)
      values
        (new.id, uname_try,
         case
           when is_first then 'admin'
           when new.email is not null and lower(new.email) = 'admin@drift-shop.app' then 'admin'
           else 'standard'
         end,
         is_g,
         case when is_g then now() else null end,
         case when is_g then now() + interval '30 minutes' else null end);
      exit;
    exception when unique_violation then
      attempt := attempt + 1;
      if attempt > 5 then
        raise;
      end if;
      uname_try := uname || '_' || substr(md5(random()::text), 1, 6);
    end;
  end loop;
  insert into public.user_settings (user_id) values (new.id);
  insert into public.vfs_folders (user_id, parent_id, name)
  values (new.id, null, 'root');
  insert into public.spaces (user_id, name, sort_order)
  values (new.id, 'Main', 0),
         (new.id, 'Focus', 1),
         (new.id, 'Play', 2);
  return new;
end $$;
