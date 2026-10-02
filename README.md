# Vendra

A calm, paper-and-ink small-business hub — point of sale, product catalogue,
appointments, files, staff time clock with printable certificates, and team
management in one app. Bilingual (EN/FR). Vite + React 18 + Tailwind, plain JSX.

## Quick start

```bash
npm install
npm run dev      # needs VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY (see .env.example)
npm run build    # production build to dist/ (served from the /drift-shop/ base path)
```

## Backend — cloud-only

Vendra always boots against Supabase. There is no local/offline device
mode and no backend toggle: one login, one user list, data follows the
account on every device.

`VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` must be set at build time
(see `.env.example`). A build made without them does not boot into a blank
page — it renders an honest "cloud backend is not configured" screen.

- Backend interface: `src/lib/backend/index.js`
- Adapter contract: `CONTRACTS.md`
- Supabase schema: `supabase/migrations/` (apply in order) + `supabase/schema.sql`
- Singleton: `src/lib/backend/current.js` (`backend`, `getBackendMode()` → `'cloud'`)

## First-run setup & master account

Setting up a fresh install (also in the PDF manual under Help, "First-run
setup"):

1. Create a free project at supabase.com → Dashboard → New project.
2. In the SQL editor, run every file in `supabase/migrations/` in order,
   from `001` to `057`. Migration `056_master_admin.sql` creates the
   built-in master admin account and `057_factory_reset.sql` adds the
   master-only factory reset (both idempotent — re-running is a no-op).
   `supabase/schema.sql` is a consolidated snapshot kept in sync with the
   migrations.
3. Copy the project's URL and anon key (Project Settings → API) into a
   `.env` file as `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`
   (see `.env.example`).
4. `npm install && npm run build`, then deploy `dist/` to any static host.

First sign-in: username `admin`, password `admin123`. The app **requires**
a new password before the desktop opens — the default is temporary, change
it immediately (min 8 characters, no common/repeating passwords). The flag
lives on `profiles.must_change_password` (added by 056); an admin can set
it on any account to force the same change-password gate.

Rebranding note: the master email `admin@drift-shop.app` must match
`BRAND.accountsDomain` in `src/lib/brand.js` — bare usernames are mapped
to `<username>@<accountsDomain>` at sign-in (`src/lib/loginId.js`). If you
change the domain, update the email in migration 056 before running it.

### Factory reset (master account only)

The master account — and only the master account (`profiles.is_master`,
set by migration 056 and guarded server-side) — has a **Factory reset**
action in the Admin panel → Danger zone tab. It permanently deletes every
account, every row of application data (POS, catalogue, appointments,
files, certificates, team/orgs, settings), and every stored file, then
reseeds the master account — the build returns to the exact state it
ships in.

- The button arms only after typing `RESET` exactly; the screen states
  plainly that **no automatic backup is taken** (the backup mechanism is
  client-side) — download account backups from Settings → Backup first.
- The wipe + reseed runs in a single database transaction
  (`public.factory_reset()`, migration 057): any failure rolls everything
  back instead of leaving a half-wiped database.
- After the reset you are signed out (your user row was deleted); sign
  back in with `admin` / `admin123` and choose a new password again.

## Brand config — one file to rebrand

`src/lib/brand.js` — every user-visible product name, tagline, accounts
domain, storage prefix, and hosting base path derives from `BRAND`:

- `name` — product name (login screen, titles, manual, …)
- `taglineEn` / `taglineFr` — taglines
- `accountsDomain` — synthetic email domain for the username→email login
  mapping (`src/lib/loginId.js`; users only ever type their username)
- `storagePrefix` — localStorage keys, window events, service-worker cache
- `basePath` — hosting subpath (must match `vite.config.js` `base`)

Locale files (`src/lib/locales/en.js`, `fr.js`) import `BRAND` for the
name/tagline; all other user-visible copy lives in the locales.

## Tests

Pure-logic unit tests run in plain node, no backend needed:

```bash
node test/tax-math.test.mjs       # POS stacked-tax math + presets
node test/login-id.test.mjs       # username -> @accountsDomain mapping
node test/access-policy.test.mjs  # account lock/disable/trial policy
```

Backend conformance (`tests/conformance.js`) runs against a live Supabase
project: `tests/run-supabase.js` (needs `VITE_SUPABASE_URL`,
`VITE_SUPABASE_ANON_KEY`, `DRIFT_TEST_EMAIL`, `DRIFT_TEST_PASSWORD`).

## Honesty rules

Every clickable control does something real. No lorem ipsum, no fake data,
no simulated backends. Errors are thrown as real `Error`s and surfaced in
the UI — never fake success. Tax-rate changes never apply silently: shops
whose stored rates match a superseded preset get an explicit-save banner.
