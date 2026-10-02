-- 018: close manager->owner escalation + invite join race (migration 002 follow-up)
--
-- Hole 1 (verified adversarially 2026-09-29): pos_members_manager_insert let any
-- owner OR manager insert a member row with ANY role, including 'owner'. The
-- invite flow correctly caps invite roles at manager/cashier (CHECK constraint
-- on pos_invites.role), but a manager could bypass invites entirely and insert
-- an accomplice's brand-new account directly as 'owner' via the API.
-- Fix: managers may only insert 'manager'/'cashier' rows; only owners can
-- grant 'owner'.
--
-- Hole 2 (race): join_pos_store() read the invite row, checked
-- (max_uses is null or uses < max_uses), then incremented uses -- with no row
-- lock. Two concurrent joins on a max_uses=1 invite could both pass the check.
-- Fix: SELECT ... FOR UPDATE serializes joins on the same invite.

begin;

-- ---------- Hole 1: only owners can grant 'owner' ----------
drop policy if exists "pos_members_manager_insert" on public.pos_store_members;
create policy "pos_members_manager_insert"
  on public.pos_store_members for insert
  with check (
    public.pos_role(store_id) = 'owner'
    or (public.pos_role(store_id) = 'manager' and role in ('manager', 'cashier'))
  );

-- ---------- Hole 2: serialize concurrent joins on one invite ----------
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

commit;
