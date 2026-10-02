# Vendra — Build 3 baseline (2026-10-01)

Generic, unbranded, shippable spin-off of the hardened bookstore build (build 2).
The tree is the fully-hardened code with all branding stripped and
shop-specific pieces generalized; every build-2 hardening fix is preserved.

## Brand config (one file to rebrand)

`src/lib/brand.js` — `BRAND` object:

- `name`: `'Vendra'` (login screen, toasts, titles, manual)
- `taglineEn` / `taglineFr`: product taglines
- `accountsDomain`: `'drift-shop.app'` — synthetic email domain for the
  username→email login mapping (`src/os/AuthContext.jsx`)
- `storagePrefix`: `'driftshop'` — localStorage keys, window events,
  console tags, service-worker cache names
- `basePath`: `'/drift-shop/'` — hosting subpath (matches `vite.config.js`)

Locale files (`src/lib/locales/en.js`, `fr.js`) import `BRAND` for the
name/tagline; all other user-visible copy lives in the locales (EN/FR).

## Generalized vs build 2

- Module renames (user-facing only; internal ids/table names unchanged):
  Bouquinerie → **Catalogue**, Poinçon → **Certificates** (EN) / **Attestations** (FR).
- Taxes: generic presets (Custom / No tax / Single tax / Two stacked taxes);
  new stores start with Tax 1 / Tax 2 slots at 0%. Stacked-tax math,
  per-store settings storage, and the explicit-save preset-update banner are
  unchanged. No jurisdiction defaults.
- Overtime note and fair-day hint generalized (no locale-specific defaults).
- Login placeholders use `marie@exemple.ca`-style neutral examples.
- Service worker cache prefix `driftshop-`, app-update probe
  `?__driftshop_build=`, base path `/drift-shop/`.
- Built-in manual replaced with a short generic getting-started guide:
  `public/manual/vendra-manual.pdf` + regenerated `manual-index.json`.

## Backend bundle

`supabase/migrations/001–055` ship as the backend setup bundle (unchanged,
internal names kept). `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` come
only from env — see `.env.example`. Never point this tree at the build-2
project; never deploy over the build-2 site.

## Build

`npm install && npm run build` — production build must complete with zero errors.
