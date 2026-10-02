-- Drift file uploads: binary uploads (Files app images/PDFs, pin attachments)
-- go to the user-files bucket under "<uid>/vfs/..." and "<uid>/pins/...".
-- These permissive policies OR-combine with any existing ones, so they only
-- widen access for a user's own prefix — never for anyone else's.
-- Idempotent: safe to re-run.

DROP POLICY IF EXISTS "drift_user_files_insert" ON storage.objects;
CREATE POLICY "drift_user_files_insert"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'user-files'
  AND (storage.foldername(name))[1] = auth.uid()::text
);

DROP POLICY IF EXISTS "drift_user_files_select" ON storage.objects;
CREATE POLICY "drift_user_files_select"
ON storage.objects FOR SELECT TO authenticated
USING (
  bucket_id = 'user-files'
  AND (storage.foldername(name))[1] = auth.uid()::text
);

DROP POLICY IF EXISTS "drift_user_files_update" ON storage.objects;
CREATE POLICY "drift_user_files_update"
ON storage.objects FOR UPDATE TO authenticated
USING (
  bucket_id = 'user-files'
  AND (storage.foldername(name))[1] = auth.uid()::text
)
WITH CHECK (
  bucket_id = 'user-files'
  AND (storage.foldername(name))[1] = auth.uid()::text
);

DROP POLICY IF EXISTS "drift_user_files_delete" ON storage.objects;
CREATE POLICY "drift_user_files_delete"
ON storage.objects FOR DELETE TO authenticated
USING (
  bucket_id = 'user-files'
  AND (storage.foldername(name))[1] = auth.uid()::text
);
