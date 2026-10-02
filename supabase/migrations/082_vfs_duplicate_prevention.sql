-- VFS duplicate prevention: unique constraints + cleanup
-- Prevents the "JSON object requested, multiple (or no) rows returned" crashes
-- from concurrent folder/file creation races.
--
-- FIXED: Personal root cleanup now explicitly excludes store_id IS NOT NULL,
-- so legitimate shop roots owned by the same user are never merged or deleted.

-- 1. Clean up existing duplicate PERSONAL roots: keep the oldest per user,
--    reparent its children to the surviving root, then delete the extras.
--    CRITICAL: Only touches personal rows (store_id IS NULL). Shop roots
--    (store_id IS NOT NULL) are left completely alone.
DO $$
DECLARE
  r RECORD;
  keeper UUID;
  dup RECORD;
BEGIN
  FOR r IN
    SELECT user_id FROM vfs_folders
    WHERE parent_id IS NULL AND store_id IS NULL
    GROUP BY user_id HAVING COUNT(*) > 1
  LOOP
    -- Oldest root wins
    SELECT id INTO keeper FROM vfs_folders
    WHERE user_id = r.user_id AND parent_id IS NULL AND store_id IS NULL
    ORDER BY created_at ASC LIMIT 1;
    FOR dup IN
      SELECT id FROM vfs_folders
      WHERE user_id = r.user_id AND parent_id IS NULL AND store_id IS NULL AND id <> keeper
    LOOP
      -- Reparent child folders and files to the keeper
      UPDATE vfs_folders SET parent_id = keeper WHERE parent_id = dup.id;
      UPDATE vfs_files SET folder_id = keeper WHERE folder_id = dup.id;
      DELETE FROM vfs_folders WHERE id = dup.id;
    END LOOP;
  END LOOP;
END $$;

-- 2. Partial unique index: one personal root per user (NULL parent_id, NULL store_id).
--    A plain UNIQUE(user_id, parent_id) cannot work because NULLs are distinct.
CREATE UNIQUE INDEX IF NOT EXISTS vfs_folders_user_root
  ON vfs_folders(user_id) WHERE parent_id IS NULL AND store_id IS NULL;

-- 3. Prevent duplicate names within the same parent (personal scope only).
CREATE UNIQUE INDEX IF NOT EXISTS vfs_folders_user_parent_name
  ON vfs_folders(user_id, parent_id, name) WHERE parent_id IS NOT NULL AND store_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS vfs_files_user_folder_name
  ON vfs_files(user_id, folder_id, name) WHERE store_id IS NULL;

-- 4. Same for store-scoped VFS.
DO $$
BEGIN
  IF to_regclass('public.vfs_folders') IS NOT NULL THEN
    -- store roots: one per store (explicitly store-scoped)
    IF NOT EXISTS (
      SELECT 1 FROM pg_indexes WHERE indexname = 'vfs_folders_store_root'
    ) THEN
      CREATE UNIQUE INDEX vfs_folders_store_root
        ON vfs_folders(store_id) WHERE parent_id IS NULL AND store_id IS NOT NULL;
    END IF;
    -- store folder names: unique per parent within a store
    IF NOT EXISTS (
      SELECT 1 FROM pg_indexes WHERE indexname = 'vfs_folders_store_parent_name'
    ) THEN
      CREATE UNIQUE INDEX vfs_folders_store_parent_name
        ON vfs_folders(store_id, parent_id, name) WHERE parent_id IS NOT NULL AND store_id IS NOT NULL;
    END IF;
    -- store file names: unique per folder within a store
    IF NOT EXISTS (
      SELECT 1 FROM pg_indexes WHERE indexname = 'vfs_files_store_folder_name'
    ) THEN
      CREATE UNIQUE INDEX vfs_files_store_folder_name
        ON vfs_files(store_id, folder_id, name) WHERE store_id IS NOT NULL;
    END IF;
  END IF;
END $$;
