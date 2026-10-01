# Drift Shop backend contract

This file is the source of truth for the backend module boundary.
`src/lib/backend/index.js` carries the full interface docs; this file states
the hard rules.

## The one rule: cloud-only

- `BackendKinds = { SUPABASE: 'supabase' }` — the only adapter.
- `createBackend('supabase')` **throws** when `VITE_SUPABASE_URL` or
  `VITE_SUPABASE_ANON_KEY` is absent. There is no silent local fallback;
  a misconfigured build renders an honest error screen (see `src/main.jsx`)
  instead of a blank page.
- `src/lib/backend/current.js` creates the singleton at module scope:
  `export const backend = createBackend('supabase')`.
  `getBackendMode()` always returns `'cloud'`.

## Adapter shape

Every adapter exposes the SAME shape (see `src/lib/backend/index.js` for
per-method docs). All functions are async unless noted. All throw real
`Error`s on failure — never fake success.

`{ kind: 'supabase', note, auth, profile, settings, files, spaces, pins, helm, highscores, notifications, pos }`

- `note` — string or null; an honest one-liner about the mode (shown in
  About / login footnote).
- `auth` — `signUp({ email, password, username })`, `signIn({ email, password })`,
  `signInGuest()` (trial user, flagged `isGuest`), `signOut()`,
  `getUser()` (sync ok), `onAuthChange(cb)` (sync ok).
  Usernames are mapped to synthetic emails on the brand's accounts domain
  by `src/lib/loginId.js` before they reach auth — the mapping rejects
  invalid input loudly instead of silently mangling it.
- `settings` — per-user OS settings (`get` / `update`).
- `files`, `spaces`, `pins`, `helm`, `highscores`, `notifications` — the
  desktop primitives (VFS, virtual desktops + window states, capture tray,
  assistant threads, game scores, notifications).
- `pos` — stores, products, customers, sales, refunds (with reason-optional
  refunds, refund badges in History, and a void-of-refunded-sale guard),
  gift cards, loyalty, promos, staff PINs, drawer shifts, tax-rate rows per
  store. Tax math is pure and unit-tested (`src/lib/taxMath.js`,
  `test/tax-math.test.mjs`): stacked rows each apply to the pre-tax
  subtotal; a row may set `compound: true` to compound on the taxes above it.

## Files

- `src/lib/backend/index.js` — interface docs + `createBackend` + `BackendKinds`
- `src/lib/backend/current.js` — the singleton every module imports
- `src/lib/backend/supabase.js` — the adapter (implements the interface
  against `supabase/migrations/` + `supabase/schema.sql`)
- `src/lib/backend/storageXhr.js` — storage upload helper

## Shared honesty rules

- No dead buttons: a visible control either works or it isn't rendered.
- No lorem ipsum, no fake data, no simulated backends.
- Backend kind is always shown honestly (`backend.note` / `'cloud'`).
- A preset/tax change NEVER rewrites a shop's stored rates silently —
  outdated preset signatures surface an explicit-save banner.
