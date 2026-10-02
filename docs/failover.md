# Vendra — manual failover runbook

**Purpose:** bring Vendra back online on a brand-new Supabase project when the primary database is truly gone. Read this once *before* you need it; under stress, follow the numbered steps in order and don't improvise.

**Last verified:** 2026-10-02. Primary: Supabase project `mkbozzeucotbxilkpapd` (Canada Central). Copies: Neon `vendra-neon-standby` (Frankfurt, warm), Aiven `vendra-vault` (Amsterdam, cold vault).

**Iron rules — do not break these:**
1. There is exactly **one live writer** at all times. Never point the app at a new database while the old one might still accept writes — that's how you get two diverging sets of sales numbers.
2. The Neon/Aiven copies are **data-survival copies, not hot standbys**. Supabase Auth, Storage, and Realtime don't exist on plain Postgres, so you cannot just repoint the app at Neon/Aiven. Recovery means a fresh Supabase project + restore + repoint the mirrors. Expect roughly 30–60 minutes of focused work.
3. Confirm with **two independent signals** before failing over (see §1). Failing over on a hunch is worse than waiting.

---

## 1. Is the primary really down? (check in this order)

1. Open the app on **two different mirrors** (e.g. `https://vendra-1f2.pages.dev/` and `https://vendra-shop.netlify.app/`). If one loads and the other doesn't, it's a hosting problem, not the database — stop here.
2. Check **https://status.supabase.com** for an incident affecting the project's region.
3. Open the repo's **Actions tab → `db-sync-neon-aiven` → latest runs**. If the hourly job is failing to reach the primary, that's independent confirmation from a different network. One red run can be transient — look for 2–3 in a row.
4. Try logging into the **Supabase dashboard** directly (different network path than the database port).
5. Rule out your own network: retry on mobile data vs. wifi, or have someone in another location try.

If steps 1–5 point at the database and not at you, move to §2.

## 2. Decision: wait or fail over?

- **WAIT** if any of these are true: the status page shows an incident with an ETA; the outage is under ~1 hour; the sync workflow reached the primary recently. Do nothing to the copies — the hourly sync keeps them fresh, and failing over early risks split-brain.
- **FAIL OVER** (§3) if: the dashboard has been unreachable for several hours with no ETA; the project was suspended or deleted; the status page confirms a major regional failure with no recovery estimate.

## 3. Recovery (numbered)

### What you need in hand before starting
- Supabase account login (project owner), GitHub repo admin access, Neon account access, Aiven account access.
- All connection strings are in the repo's Actions secrets (`PRIMARY_DATABASE_URL`, `NEON_DATABASE_URL`, `AIVEN_DATABASE_URL`); the Neon/Aiven dashboards show them too.
- A machine with `pg_dump`/`pg_restore` **version 17 or newer** (the primary is Postgres 17; older clients refuse to dump it).

### Step 1 — Pick the freshest source (newest wins)
1. **(a) Newest automated backup dump**, if one exists as a downloadable file — check the Actions tab for backup artifacts and compare its timestamp.
2. **(b) The Neon warm copy** — freshness = timestamp of the last green `db-sync-neon-aiven` run (in practice ≤ 1 hour old).
3. **(c) The Aiven cold vault** — same freshness check as (b).

Default to **Neon** unless (a) exists and is newer. Record which source you chose and its timestamp — everything you restore is only as new as that moment.

### Step 2 — Create the new Supabase project
1. Supabase dashboard → **New project**. Name it `vendra-primary-2` (or similar). Region: same as before (**Canada Central**) if available, otherwise nearest.
2. Set a **strong database password** and record it immediately somewhere safe — you need it in Steps 3–4.
3. Wait for provisioning to finish. Record: **Project URL** (`https://<new-ref>.supabase.co`), **anon key**, **service_role key** (Project Settings → API), and the DB host (`db.<new-ref>.supabase.co`).
4. Do **not** run any app migrations — the restore brings the schema with it.

### Step 3 — Get a working dump file
- From a stored dump file: download it and confirm it's non-empty (`ls -la`).
- From Neon: `pg_dump -Fc --no-owner --no-privileges -f /tmp/vendra-failover.dump "$NEON_DATABASE_URL"`
- From Aiven: same command with `"$AIVEN_DATABASE_URL"`.
- Refuse to continue if the dump file is empty — never restore from an empty file.

New-project connection string shape (you'll need it below):
`postgresql://postgres:<new-db-password>@db.<new-ref>.supabase.co:5432/postgres`

### Step 4 — Restore into the new project (safe order)
Why the order matters: the new project already ships its own `auth`, `storage`, `realtime`, and `extensions` schemas (empty system tables, correct functions). Overwriting those wholesale breaks it. Restore **data into the system schemas, schema+data only for the app's own tables**:

1. **App tables (schema + data):**
   `pg_restore --no-owner -n public -d "$NEW_DB_URL" /tmp/vendra-failover.dump`
   This creates every `public.*` table with its data, RLS policies, and functions. (The `authenticated`/`anon` roles exist natively in Supabase, so policies apply cleanly.)
2. **Login accounts (data only):**
   `pg_restore --no-owner --data-only -t auth.users -t auth.identities -d "$NEW_DB_URL" /tmp/vendra-failover.dump`
   If this fails with **column errors** (Supabase version drift between old and new project): skip it — see the fallback in Step 5. Do not force it.
3. **Storage metadata (data only):**
   `pg_restore --no-owner --data-only -t storage.buckets -t storage.objects -d "$NEW_DB_URL" /tmp/vendra-failover.dump`
4. **Do NOT restore:** the `auth`/`storage`/`realtime`/`extensions` schema *definitions*, the `vault` schema, any `EVENT TRIGGER`, or the `supabase_realtime` publication. The new project already has correct versions.
5. A few `already exists` notices from pg_restore are benign. Real errors (permission denied, missing column) need attention — re-run the single failing step, don't restart everything.

### Step 5 — Verify row counts
Run this in the SQL editor on **both** the source and the new project, then diff the outputs. Every `public.*` count must match exactly; `auth.users` should match if Step 4.2 succeeded.

```sql
DO $$
DECLARE r record; c bigint;
BEGIN
  FOR r IN SELECT schemaname, tablename FROM pg_tables
           WHERE schemaname NOT IN ('pg_catalog','information_schema')
           ORDER BY 1,2 LOOP
    EXECUTE format('SELECT count(*) FROM %I.%I', r.schemaname, r.tablename) INTO c;
    RAISE NOTICE '%: %', r.schemaname||'.'||r.tablename, c;
  END LOOP;
END $$;
```

**Fallback if Step 4.2 was skipped:** foreign keys pointing at `auth.users` may complain. That's expected and consistent — users will re-register and get new accounts; all shop data is intact. Find the affected constraints with:
```sql
SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
WHERE confrelid = 'auth.users'::regclass AND contype = 'f';
```
…and drop each with `ALTER TABLE <table> DROP CONSTRAINT <name>;`.

### Step 6 — Reconfigure Auth on the new project
Dashboard → Authentication → URL Configuration:
1. **Site URL:** `https://vendra-1f2.pages.dev`
2. **Redirect URLs** — add one `https://<host>/**` entry per app origin (the two `github.io` doors share an origin, so six entries):
   - `https://vendra-1f2.pages.dev/**`
   - `https://vendra-2.pages.dev/**`
   - `https://vendra-shop.netlify.app/**`
   - `https://vendra-shop-2.netlify.app/**`
   - `https://vendra-27li.onrender.com/**`
   - `https://staros-builds.github.io/**`
3. Re-enter any enabled **OAuth provider** client IDs/secrets (Authentication → Providers) — these do **not** transfer.
4. Leave email auth and magic links enabled (defaults).

## 4. Repoint the 8 app mirrors

New values everywhere: `VITE_SUPABASE_URL=https://<new-ref>.supabase.co`, `VITE_SUPABASE_ANON_KEY=<new anon key>`.

1. **Cloudflare Pages** — `vendra-1f2.pages.dev`, `vendra-2.pages.dev`: dashboard → Workers & Pages → project → Settings → Environment variables (Production) → update both → Deployments → Retry deployment.
2. **Netlify** — `vendra-shop.netlify.app`, `vendra-shop-2.netlify.app`: Site configuration → Environment variables → update → Deploys → Trigger deploy.
3. **Render** — `vendra-27li.onrender.com`: dashboard → static site → Environment → update → Manual Deploy (env change triggers a redeploy).
4. **GitHub Pages** — `staros-builds.github.io/drift-shop/`, `staros-builds.github.io/`: these build from the repo. If the release workflow is active, update repo variables `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` (repo Settings → Secrets and variables → Actions) and run it. If building locally, rebuild with the new env vars and re-push the pages deploy branches (build the tree from a clean temp dir — never the shared working-tree index).
5. **Neocities** — `vendra.neocities.org`: front door/manual only, no app build — nothing to rebuild. Touch it only if a link hardcodes the old primary address.
6. Hard-refresh each door (bypass cache) and confirm the login screen loads on all 8.

## 5. Verification checklist (all must pass before declaring recovery)

1. Row counts match between source and new project (§3, Step 5).
2. All 8 doors load; login screen spot-checked on each.
3. Sign-in works on the primary door (password or magic link) — proves Auth + redirect URLs.
4. Create a test shop / post a test sale, confirm it appears — then **delete the test data**.
5. Upload a test file in Files — proves Storage works on the new project.
6. Spot-check known data (a real product, a real order) is present and correct.
7. Confirm old login sessions are gone (expected — everyone signs in again). Not a failure.
8. Only after 1–7: announce recovery.

## 6. What does NOT survive failover (honest list)

- **Active login sessions** — everyone signs in again.
- **OAuth provider configurations** — re-entered in §3, Step 6.
- **File bytes in Storage** (product photos, uploads): the metadata rows survive, but the actual files lived in the old project's storage backend. Old image/file URLs will 404 until re-uploaded. New uploads work immediately.
- **Dashboard-only settings**: custom SMTP, auth email templates, webhook endpoints, rate-limit tweaks.
- **Supabase Vault contents** (was empty — nothing lost).
- **Anything written to the old primary after the freshest source's timestamp** — with the hourly sync, at most ~1 hour of data. Say so plainly if asked.
- **The old project's URL and keys** — update every integration that referenced them.

## 7. Re-establish the hourly sync afterwards

1. Repo → Settings → Secrets and variables → Actions → update **`PRIMARY_DATABASE_URL`** to the new project's connection string (with the **new** DB password from §3, Step 2). If `PRIMARY_SUPABASE_URL`, `PRIMARY_SUPABASE_ANON_KEY`, or `PRIMARY_SUPABASE_SERVICE_KEY` secrets exist, update those too.
2. `NEON_DATABASE_URL` and `AIVEN_DATABASE_URL` stay as-is.
3. Actions tab → **`db-sync-neon-aiven`** → Run workflow → watch it go green. It re-seeds both copies from the new primary and verifies row counts.
4. Leave the `:23` hourly schedule alone. Two to three consecutive green runs confirm the loop is healthy.
5. Keep the old Supabase project (if accessible) untouched for a week as an extra fallback, then delete it.
