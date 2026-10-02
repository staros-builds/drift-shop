-- 017: allow deleting a store (migration 016 follow-up)
--
-- Bug: guard_pos_last_owner() (migration 002) fires on the cascade delete of
-- pos_store_members when a store is deleted, and blocks it because the owner's
-- row disappears with "no other owners left". Result: no store with an owner
-- could ever be deleted through the app.
--
-- Fix: a BEFORE DELETE trigger on pos_stores stamps the doomed store's id in a
-- transaction-local setting; the guard skips member rows whose parent store is
-- itself being deleted. The setting lives only for the current transaction and
-- cannot be set through the API/RLS, so the last-owner protection is unchanged
-- for member removes, demotions, and self-leaves.

begin;

create or replace function public.mark_pos_store_deleting()
returns trigger
language plpgsql security definer as $$
begin
  perform set_config('app.deleting_store', old.id::text, true);
  return old;
end $$;

drop trigger if exists pos_stores_mark_deleting on public.pos_stores;
create trigger pos_stores_mark_deleting
  before delete on public.pos_stores
  for each row execute function public.mark_pos_store_deleting();

create or replace function public.guard_pos_last_owner()
returns trigger
language plpgsql security definer as $$
declare
  owners_left integer;
begin
  -- The parent store itself is being deleted; its member rows go with it.
  if current_setting('app.deleting_store', true) = old.store_id::text then
    if TG_OP = 'DELETE' then return old; end if;
    return new;
  end if;
  if old.role = 'owner' and (TG_OP = 'DELETE' or new.role <> 'owner') then
    select count(*) into owners_left
    from public.pos_store_members
    where store_id = old.store_id and role = 'owner'
      and not (user_id = old.user_id);
    if owners_left = 0 then
      raise exception 'a store must keep at least one owner';
    end if;
  end if;
  if TG_OP = 'DELETE' then return old; end if;
  return new;
end $$;

commit;
