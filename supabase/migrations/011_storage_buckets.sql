-- 011_storage_buckets.sql — Supabase Storage buckets backing Drift file uploads.
--
-- What broke (2026-09-29): the app uploads binary files (Files app, Videos app)
-- to the `user-files` bucket and custom wallpapers to `user-wallpapers`, under
-- paths prefixed with the owner's auth user id — but neither bucket existed in
-- the project, so every binary upload failed. A second, client-side bug
-- (FilesApp cleared the file input before snapshotting its live FileList, so
-- uploads silently no-op'd) was fixed in the app code alongside this migration.
--
-- This migration is idempotent: safe to run on fresh projects and on projects
-- where the buckets/policies were already created by hand.
--
-- Security model: both buckets are private, and the four policies below give an
-- authenticated user access only to objects whose first path segment equals
-- their own auth.uid() — the app always uploads to `<uid>/...`. Cross-user
-- reads/writes are rejected by RLS (verified: upload to another user's path
-- fails, own path succeeds).

-- Buckets (private).
insert into storage.buckets (id, name, public)
values ('user-files', 'user-files', false),
       ('user-wallpapers', 'user-wallpapers', false)
on conflict (id) do nothing;

-- Owner-only access policies on storage.objects. Dropped first so re-runs
-- converge instead of erroring on duplicate policy names.
drop policy if exists "users own objects (select)" on storage.objects;
drop policy if exists "users own objects (insert)" on storage.objects;
drop policy if exists "users own objects (update)" on storage.objects;
drop policy if exists "users own objects (delete)" on storage.objects;

create policy "users own objects (select)"
  on storage.objects for select to authenticated
  using ((storage.foldername(name))[1] = (auth.uid())::text);

create policy "users own objects (insert)"
  on storage.objects for insert to authenticated
  with check ((storage.foldername(name))[1] = (auth.uid())::text);

create policy "users own objects (update)"
  on storage.objects for update to authenticated
  using ((storage.foldername(name))[1] = (auth.uid())::text)
  with check ((storage.foldername(name))[1] = (auth.uid())::text);

create policy "users own objects (delete)"
  on storage.objects for delete to authenticated
  using ((storage.foldername(name))[1] = (auth.uid())::text);
