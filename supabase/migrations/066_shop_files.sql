-- 066_shop_files.sql — Shared shop files: every shop gets its own file area
-- that all shop members can see, alongside each member's private files.
--
-- SCOPE DECISION (deliberate, not a default): existing vfs rows keep
-- store_id = NULL, which means "personal, exactly as today". Nothing that
-- was private becomes shared by this migration. A file only enters shop
-- scope when a shop member creates/uploads it while looking at the Shop
-- files area. A row with a non-null store_id belongs to that shop's shared
-- area; its user_id is the creator's (attribution), so deleting the
-- creator's auth account cascades their attributed shop rows — accepted,
-- matching the existing vfs foreign-key design.
--
-- Security model (mirrors migration 016's team pattern):
-- - Personal rows: the existing *_owner_all policies (user_id = auth.uid()).
-- - Shop rows: any shop member may read and create; rename/delete need
--   the row owner or an owner/manager role (pos_role()).
-- - Binary bytes: the user-files bucket stays private; the new storage
--   policies admit objects under shop/<store-id>/... for members only.
--   The CASE in the storage policies is load-bearing: Postgres does not
--   guarantee AND evaluation order, and casting a non-uuid path segment
--   would error the whole query — so the uuid cast only ever runs after a
--   uuid-shape check matched.
--
-- Idempotent: safe to run on fresh projects and on projects where earlier
-- attempts already created these objects.

-- ---------- columns ----------
alter table public.vfs_folders
  add column if not exists store_id uuid references public.pos_stores(id) on delete set null;
alter table public.vfs_files
  add column if not exists store_id uuid references public.pos_stores(id) on delete set null;

create index if not exists vfs_folders_store on public.vfs_folders (store_id);
create index if not exists vfs_files_store on public.vfs_files (store_id);

-- One shop root per store; sibling-name uniqueness inside shop scope.
-- (The existing vfs_folders_unique is keyed on user_id, which would allow
-- two different members to create same-named siblings in the same shop.)
create unique index if not exists vfs_folders_shop_root_unique
  on public.vfs_folders (store_id)
  where store_id is not null and parent_id is null;
create unique index if not exists vfs_folders_shop_unique
  on public.vfs_folders (
    store_id,
    coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid),
    name
  )
  where store_id is not null;
-- vfs_files_unique (folder_id, name) needs no shop variant: folder ids are
-- globally unique uuids, so scoping by folder already scopes by shop.

-- ---------- RLS: vfs_folders ----------
drop policy if exists "vfs_folders_shop_select" on public.vfs_folders;
drop policy if exists "vfs_folders_shop_insert" on public.vfs_folders;
drop policy if exists "vfs_folders_shop_update" on public.vfs_folders;
drop policy if exists "vfs_folders_shop_delete" on public.vfs_folders;

create policy "vfs_folders_shop_select"
  on public.vfs_folders for select
  using (store_id is not null and public.is_pos_member(store_id));

create policy "vfs_folders_shop_insert"
  on public.vfs_folders for insert
  with check (store_id is not null and user_id = auth.uid() and public.is_pos_member(store_id));

create policy "vfs_folders_shop_update"
  on public.vfs_folders for update
  using (
    store_id is not null
    and (user_id = auth.uid() or public.pos_role(store_id) in ('owner', 'manager'))
  );

create policy "vfs_folders_shop_delete"
  on public.vfs_folders for delete
  using (
    store_id is not null
    and (user_id = auth.uid() or public.pos_role(store_id) in ('owner', 'manager'))
  );

-- ---------- RLS: vfs_files ----------
drop policy if exists "vfs_files_shop_select" on public.vfs_files;
drop policy if exists "vfs_files_shop_insert" on public.vfs_files;
drop policy if exists "vfs_files_shop_update" on public.vfs_files;
drop policy if exists "vfs_files_shop_delete" on public.vfs_files;

create policy "vfs_files_shop_select"
  on public.vfs_files for select
  using (store_id is not null and public.is_pos_member(store_id));

create policy "vfs_files_shop_insert"
  on public.vfs_files for insert
  with check (store_id is not null and user_id = auth.uid() and public.is_pos_member(store_id));

create policy "vfs_files_shop_update"
  on public.vfs_files for update
  using (
    store_id is not null
    and (user_id = auth.uid() or public.pos_role(store_id) in ('owner', 'manager'))
  );

create policy "vfs_files_shop_delete"
  on public.vfs_files for delete
  using (
    store_id is not null
    and (user_id = auth.uid() or public.pos_role(store_id) in ('owner', 'manager'))
  );

-- ---------- storage.objects: shop/<store-id>/... in the user-files bucket ----------
-- Existing "users own objects" policies (migration 011) stay untouched;
-- these add shop access without widening personal access.
drop policy if exists "shop objects (select)" on storage.objects;
drop policy if exists "shop objects (insert)" on storage.objects;
drop policy if exists "shop objects (update)" on storage.objects;
drop policy if exists "shop objects (delete)" on storage.objects;

create policy "shop objects (select)"
  on storage.objects for select to authenticated
  using (
    (storage.foldername(name))[1] = 'shop'
    and case
      when (storage.foldername(name))[2] ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      then public.is_pos_member(((storage.foldername(name))[2])::uuid)
      else false
    end
  );

create policy "shop objects (insert)"
  on storage.objects for insert to authenticated
  with check (
    (storage.foldername(name))[1] = 'shop'
    and case
      when (storage.foldername(name))[2] ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      then public.is_pos_member(((storage.foldername(name))[2])::uuid)
      else false
    end
  );

create policy "shop objects (update)"
  on storage.objects for update to authenticated
  using (
    (storage.foldername(name))[1] = 'shop'
    and case
      when (storage.foldername(name))[2] ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      then public.is_pos_member(((storage.foldername(name))[2])::uuid)
      else false
    end
  )
  with check (
    (storage.foldername(name))[1] = 'shop'
    and case
      when (storage.foldername(name))[2] ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      then public.is_pos_member(((storage.foldername(name))[2])::uuid)
      else false
    end
  );

create policy "shop objects (delete)"
  on storage.objects for delete to authenticated
  using (
    (storage.foldername(name))[1] = 'shop'
    and case
      when (storage.foldername(name))[2] ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      then public.is_pos_member(((storage.foldername(name))[2])::uuid)
      else false
    end
  );
