# Release rules — "new updates can't break anything previous"

Owner rule (2026-10-01), permanent and platform-wide: **every update
must be safe over anything that came before it.** A shop on any older
build, any older backup, or any older database must keep working after
an update — never stranded, never forced into data loss.

## The five rules

1. **Migrations are expand-only and idempotent.** Add tables, columns,
   indexes, functions; never drop, rename, or narrow anything in the
   same release that starts using the replacement. Every migration
   must run cleanly twice in a row (the nuclear gate runs each new
   migration twice) and must be safe against a database that already
   has some of it. Deleting something needs two releases: stop using
   it in release N, remove it in release N+2 at the earliest.
2. **The app capability-probes, never assumes.** New SQL objects are
   reached only after a probe (the `posHas*` / `*Available()` pattern).
   Against a pre-migration schema the app degrades honestly — the
   feature hides or explains itself; it never crashes or half-works.
   `driftshop_*` internal identifiers (localStorage keys, the
   `drift-backup` marker, storage paths) are NEVER renamed: renaming
   one orphans every existing shop's local state.
3. **Old backups always restore.** `validateBackup` accepts every
   format ever shipped (the restore warnings `legacy-backup` and
   `newer-version` exist for exactly this). A backup exported from any
   older build — including the current live demo build — must restore
   into the newest build. Adding a field is fine; requiring a field an
   old backup lacks is not (default it).
4. **People are never locked out by an update.** Legacy staff PINs
   (SHA-256-only rows) keep working and upgrade transparently on next
   use (migration 069). Trial state, carts (POS draft +
   `driftshop:cart:<slug>`), and license state survive rebuilds. A
   locked shop can always download its own backup.
5. **Auto-update only at safe moments.** The app may reload itself for
   an update only when nothing is in progress: no sale recording, no
   restore running, no non-empty cart (see `src/lib/updateGuard.js`).
   Otherwise it offers "Refresh now" and waits. The "Later" button is
   the permanent escape hatch — snoozes auto-apply for that build for
   the session; the manual path always remains.

## The pipeline (one release, every mirror)

`.github/workflows/release.yml` runs on every push to `main`:

1. **Test gate** — `npm test` must pass or nothing ships.
2. **Build** — one `npm run build` with the production env; the bundle
   is byte-verified (`verify-bundle.mjs`): a build without the Supabase
   env silently emits a hollow ~146 KB stub, so exit code alone is
   never trusted.
3. **Migrations** — only expand-only idempotent files, applied in
   order, only when the DB secret exists; otherwise skipped loudly
   (they remain a deliberate manual step, never a surprise).
4. **Deploy** — the identical dist goes to every mirror in
   `deploy/mirrors.json` whose account secrets exist (inert until
   then). GitHub Pages (`master` branch) is the primary mirror.
5. **Smoke check** — each deployed mirror's `/build.json` must report
   the release's `buildId`. A failure fails the run loudly and says
   why in the Action log; the previous good build stays live on any
   mirror the deploy did not reach (a failed smoke check never
   unpublishes — the fix is a new commit, and the app on devices keeps
   running the last good build it booted).

Bad-deploy safety net on the device side: repeated boot crashes trip
the existing safe-mode screen instead of a blank page, and the service
worker keeps serving the last shell it cached.

## Compatibility window

The app supports the live schema and the previous release's schema.
Migrations land *before* a build that needs them (expand first, use
second), and a build must still boot and sell against the
pre-migration schema (verified in the nuclear gate). Two releases back
is best-effort, not promised.

## Version handshake

Every build stamps `dist/build.json` (`buildId` = commit SHA) and the
app detects a newer live build by polling `index.html`. A device
running an older build is a normal, supported state — the server-side
rules above are what keep it safe until its safe-moment update lands.
