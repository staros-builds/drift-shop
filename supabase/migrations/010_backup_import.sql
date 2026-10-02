-- 010_backup_import.sql — account backup/restore: manager-only bulk import
-- of time-clock history (punches + correction audits).
--
-- Why an RPC: migration 007 deliberately removed every direct
-- insert/update/delete RLS policy on pos_time_punches and
-- pos_punch_audits — all punch writes go through the PIN-verified
-- pos_clock_in / pos_clock_out RPCs. Restoring a backup therefore needs a
-- server-side import path too. This RPC is manager/owner-only and merges by
-- row ID: rows already present are skipped (on conflict do nothing), so a
-- restore never duplicates or overwrites live punches.
--
-- Backup semantics:
--   - Only store members can call it; only owner/manager roles may import.
--   - store_id on every imported row is forced to p_store_id (the caller
--     cannot smuggle rows into another store).
--   - The open-shift unique index is respected: if the staff member already
--     has an open shift in the live database, the backup's open shift is
--     skipped (the live shift wins).
--   - Punch check constraint (punch_out > punch_in) still applies.
-- Apply exactly once, after 007.

create or replace function public.pos_punch_history_import(
  p_store_id uuid,
  p_punches  jsonb,
  p_audits   jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_punches int := 0;
  v_audits  int := 0;
  r jsonb;
begin
  if auth.uid() is null then
    raise exception 'sign in required';
  end if;
  if not public.is_pos_member(p_store_id) then
    raise exception 'not a member of this store';
  end if;
  if public.pos_role(p_store_id) not in ('owner', 'manager') then
    raise exception 'managers only';
  end if;

  for r in
    select * from jsonb_array_elements(coalesce(p_punches, '[]'::jsonb))
  loop
    if r is null or (r ->> 'id') is null or (r ->> 'staff_id') is null
       or (r ->> 'punch_in') is null then
      continue;
    end if;
    -- Live open shift wins over a backup's open shift for the same employee.
    if (r ->> 'punch_out') is null then
      if exists (
        select 1 from public.pos_time_punches
        where store_id = p_store_id
          and staff_id = (r ->> 'staff_id')::uuid
          and punch_out is null
      ) then
        continue;
      end if;
    end if;
    insert into public.pos_time_punches
      (id, store_id, staff_id, punch_in, punch_out, created_at)
    values
      ((r ->> 'id')::uuid,
       p_store_id,
       (r ->> 'staff_id')::uuid,
       (r ->> 'punch_in')::timestamptz,
       nullif(r ->> 'punch_out', '')::timestamptz,
       coalesce((r ->> 'created_at')::timestamptz, now()))
    on conflict (id) do nothing;
    if found then
      v_punches := v_punches + 1;
    end if;
  end loop;

  for r in
    select * from jsonb_array_elements(coalesce(p_audits, '[]'::jsonb))
  loop
    if r is null or (r ->> 'id') is null then
      continue;
    end if;
    insert into public.pos_punch_audits
      (id, store_id, punch_id, action, edited_by,
       old_punch_in, old_punch_out, new_punch_in, new_punch_out, created_at)
    values
      ((r ->> 'id')::uuid,
       p_store_id,
       nullif(r ->> 'punch_id', '')::uuid,
       coalesce(r ->> 'action', 'correct'),
       auth.uid(), -- re-attribute to the importer: the backup's user may not exist here
       nullif(r ->> 'old_punch_in', '')::timestamptz,
       nullif(r ->> 'old_punch_out', '')::timestamptz,
       nullif(r ->> 'new_punch_in', '')::timestamptz,
       nullif(r ->> 'new_punch_out', '')::timestamptz,
       coalesce((r ->> 'created_at')::timestamptz, now()))
    on conflict (id) do nothing;
    if found then
      v_audits := v_audits + 1;
    end if;
  end loop;

  return jsonb_build_object('punches', v_punches, 'audits', v_audits);
end;
$$;

grant execute on function public.pos_punch_history_import(uuid, jsonb, jsonb)
  to authenticated;
