-- VFS duplicate prevention: unique constraints + cleanup
-- Prevents the "JSON object requested, multiple (or no) rows returned" crashes
-- from concurrent folder/file creation races.

-- 1. Clean up existing duplicate personal roots: keep the oldest per user,
--    reparent its children to the surviving root, then delete the extras.
DO $$
DECLARE
  r RECORD;
  keeper UUID;
  dup RECORD;
BEGIN
  FOR r IN
    SELECT user_id FROM vfs_folders
    WHERE parent_id IS NULL
    GROUP BY user_id HAVING COUNT(*) > 1
  LOOP
    -- Oldest root wins
    SELECT id INTO keeper FROM vfs_folders
    WHERE user_id = r.user_id AND parent_id IS NULL
    ORDER BY created_at ASC LIMIT 1;
    FOR dup IN
      SELECT id FROM vfs_folders
      WHERE user_id = r.user_id AND parent_id IS NULL AND id <> keeper
    LOOP
      -- Reparent child folders and files to the keeper
      UPDATE vfs_folders SET parent_id = keeper WHERE parent_id = dup.id;
      UPDATE vfs_files SET folder_id = keeper WHERE folder_id = dup.id;
      DELETE FROM vfs_folders WHERE id = dup.id;
    END LOOP;
  END LOOP;
END $$;

-- 2. Partial unique index: one personal root per user (NULL parent_id).
--    A plain UNIQUE(user_id, parent_id) cannot work because NULLs are distinct.
CREATE UNIQUE INDEX IF NOT EXISTS vfs_folders_user_root
  ON vfs_folders(user_id) WHERE parent_id IS NULL;

-- 3. Prevent duplicate names within the same parent (personal scope).
CREATE UNIQUE INDEX IF NOT EXISTS vfs_folders_user_parent_name
  ON vfs_folders(user_id, parent_id, name) WHERE parent_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS vfs_files_user_folder_name
  ON vfs_files(user_id, folder_id, name);

-- 4. Same for store-scoped VFS (if tables exist).
DO $$
BEGIN
  IF to_regclass('public.vfs_folders') IS NOT NULL THEN
    -- store roots: one per store
    IF NOT EXISTS (
      SELECT 1 FROM pg_indexes WHERE indexname = 'vfs_folders_store_root'
    ) THEN
      CREATE UNIQUE INDEX vfs_folders_store_root
        ON vfs_folders(store_id) WHERE parent_id IS NULL AND store_id IS NOT NULL;
    END IF;
  END IF;
END $$;
