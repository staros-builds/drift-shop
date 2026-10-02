# API compatibility audit — every external service, one contract each

_October 1, 2026. Branch `ds-apicheck`. Purpose: Jesse's directive — "make
sure all the third party websites and services that interact with my
platform [have] the right compatible APIs put in place so there's no
issues with communication."_

How to read this file:

- **Verified-how** says how each contract was checked: `code-read` (the
  code in this repo/branch does exactly this), `official docs` (vendor
  documentation or vendor-maintained sources, checked October 1, 2026),
  or **UNVERIFIED** — in which case the row carries the exact probe to
  run on merge/setup day. Nothing is marked verified on the strength of
  a search snippet alone.
- **Fallback** says what the product does when that contract breaks.
- Companion patches for sibling branches (ds-mesh, ds-x10,
  ds-cloudbackup, ds-sso) are listed at the end — this branch cannot
  carry them, but the merge is not done until they land.

---

## 1. Supabase (the shop database, auth, and file storage)

| Contract used | Version / assumption | Verified-how | Fallback |
| --- | --- | --- | --- |
| `@supabase/supabase-js` client (Auth, PostgREST, Storage) | package.json `^2.47.0`; lockfile pins **2.117.2** (auth-js / postgrest-js / storage-js / realtime-js all 2.117.2) | code-read (`package-lock.json`, `src/lib/backend/supabase.js`) | Pinned by lockfile; upgrades are deliberate, never floating |
| Auth APIs: `signUp`, `signInWithPassword`, `signInAnonymously`, `resetPasswordForEmail`, `exchangeCodeForSession`, `updateUser`, `getSession`, `getUser`, `onAuthStateChange`, `signOut` | Current v2 API surface; no removed v1 calls | code-read (all call sites in `supabase.js`) | Coded errors mapped to plain language by `friendlyAuthError` (login) |
| **Client key family**: legacy JWT `anon` key **or** new `sb_publishable_…` key | Supabase is retiring JWT keys (end of 2026); projects created after Nov 2025 have **only** `sb_publishable_` / `sb_secret_` | official docs + vendor SDK sources, Oct 1 2026 | Boot config check accepts both families; a wrong key still fails honestly (see below) |
| **Secret key refusal**: `sb_secret_…` must never be the app key | It bypasses all row security; shipping it in a browser bundle is a full data breach | code-read (fixed on this branch, `configCheck.js`) | Boot stops with the config-problem screen naming the mistake in plain words |
| Key header rule: key on `apikey` header; `Authorization: Bearer` only for real JWTs (user sessions, legacy keys) | New opaque keys sent as Bearer are rejected as invalid tokens | official docs + supabase-js PR history, Oct 1 2026 | Boot probe uses `probeHeaders()` (fixed on this branch); SDK handles the rest itself |
| PostgREST RPCs (30 unique functions, e.g. `factory_reset`, `pos_apply_sale_stock`, `join_pos_store`) | SECURITY DEFINER functions in `supabase/migrations/`; `.rpc()` calls only | code-read | Capability probes degrade features silently when a migration is missing |
| Storage REST: SDK `upload/download/remove/createSignedUrl` + one raw XHR upload (`storageXhr.js`) | `POST /storage/v1/object/{bucket}/{path}`, `apikey` + user-JWT `Authorization`, `x-upsert`, FormData | code-read; mirrors the Storage API the SDK itself uses | SDK path used everywhere except the progress-reporting upload |
| Realtime (WebSocket channels) | **Not used anywhere in the app** — phoenix is bundled by the SDK but no channel is ever opened | code-read (repo-wide search) | None needed; no WS contract to break |
| Migration SQL: `pgcrypto` in the `extensions` schema, SECURITY DEFINER RPCs | Standard on every fresh Supabase project | code-read (migrations 019/020/049) | Buyer runs migrations in numeric order (`.env.example`, fixed on this branch) |
| Anonymous sign-in (guest/trial) | Requires the project's "Allow anonymous sign-ins" dashboard toggle | code-read (`signInAnonymously`, `supabase.js:613`) | **UNVERIFIED** on a fresh project — Probe P1 below |

**Fixed on this branch:** `configCheck.js` accepts `sb_publishable_…`
keys (previously a fresh-project buyer hit the misleading "looks cut off"
error), refuses `sb_secret_…` with its own plain-language problem, and
`probeHeaders()` stops the boot schema probe from sending a publishable
key as a Bearer token. `.env.example` now tells buyers which key to copy.
Tests: `test/config-check.test.mjs` (+8 checks).

**UNVERIFIED — Probe P1 (fresh-project day):** create a throwaway
Supabase project, copy its `sb_publishable_` key into a build, and
confirm: (a) boot self-check passes, (b) email signup + sign-in work,
(c) guest/trial entry works (proves the anonymous sign-in toggle state),
(d) a deliberately wrong publishable key produces the honest
"connection settings look wrong" screen, not a raw error.

## 2. Standby sync tooling (ds-mesh — read from that branch)

| Contract used | Version / assumption | Verified-how | Fallback |
| --- | --- | --- | --- |
| PostgREST reachability `GET /rest/v1/`, OpenAPI table discovery, HEAD count with `Prefer: count=exact` + `Content-Range` | PostgREST v12–v16 all still return `Content-Range` counts for HEAD | official changelog review, Oct 1 2026 (no HEAD removal through v16) | Any-HTTP-response reachability rule; counts are advisory |
| `pg_dump --no-owner --no-privileges --format=plain` (+`--clean --if-exists` seed; data-only sync) | Supabase direct DB or Session-pooler URI (direct `db.<ref>` is IPv6-only; CI runners are IPv4 — pooler required) | code-read (`tools/sync/export.mjs`, `sync.mjs`) | Dry-run by default; `--live` needs `SYNC_ALLOW_WRITE=1` |
| Auth copy: `auth.users` + `auth.identities` only, **never sessions** | Users sign in again after a failover — accepted, documented | code-read | — |
| GitHub Actions hourly sync (`db-sync.yml`) | `actions/checkout@v4`, apt `postgresql-client`, inert until secrets exist | code-read | No-op green until a standby exists |

**Required companion patch (merge day):** `tools/sync/lib/rest.mjs`
(and ds-x10's `tools/targets/lib/*`) send the service key as
`Authorization: Bearer <key>`. With an `sb_secret_…` key that is
rejected as an invalid JWT. Change to: `sb_…` keys go on the `apikey`
header **only**; legacy JWT service keys may ride both headers. Exact
rule implemented in `configCheck.probeHeaders()` on this branch — port
it. **Probe P2:** against the standby project, `curl -H "apikey:
sb_secret_…" <standby>/rest/v1/pos_stores?select=id&limit=1` returns
200/401-from-RLS (either proves the key was accepted); a 401 "invalid
token" body proves the header shape is still wrong.

## 3. Static mirror hosts (the app doors)

| Contract used | Version / assumption | Verified-how | Fallback |
| --- | --- | --- | --- |
| One host-agnostic `dist/`: relative Vite base `./`, hash routes, relative manifest/icon paths | Same bytes run at a domain root or any subpath | code-read; fixed on this branch (`vite.config.js`, `index.html`, `brand.appBasePath()`) | — |
| CSP delivered as `<meta>` (GitHub Pages cannot set headers) with the Supabase origin substituted at build time from `VITE_SUPABASE_URL` | `%SUPABASE_ORIGIN%` / `%SUPABASE_ORIGIN_WS%` placeholders (this branch's `vite.config.js`) | code-read; byte-check the built `dist/index.html` after every build | Fallback origin = current production project |
| SPA fallback: `public/404.html` derives the app root from the path; Netlify/Cloudflare use their own redirect rules | First-segment rule for GitHub Pages project sites | code-read; fixed on this branch | Hash routes mean deep links survive regardless |
| Service worker: same-origin GET shell cache only, per-build cache version | Never caches API/business data (cloud-only) | code-read (`public/sw.js`); stale "works offline" wording removed on this branch | Boot self-check still refuses to open the app without a connection |
| Host facts (from ds-x10's verified registry, Oct 1 2026) | GitHub Pages' terms bar commercial SaaS hosting → commercial primary door is Cloudflare Pages; Netlify post-2025-09-04 accounts get 300 credits/mo | official docs (via ds-x10 report) | Up to ten doors; losing any one door loses nothing |

## 4. Cloudflare Worker (future one-address failover)

Not built yet. Contract assumptions recorded so the build is right the
first time: Workers free tier (100k req/day) fronts the static mirrors;
wildcard route `*.<product-domain>/*` resolves shop subdomains
(Cloudflare Pages alone cannot do wildcard custom domains); health
checks pick a live mirror. **UNVERIFIED — Probe P3 (domain day):**
after registration, confirm the wildcard route serves two different
shop subdomains and that killing one mirror still serves the address.

## 5. Google Drive cloud backup (ds-cloudbackup — read from that branch)

| Contract used | Version / assumption | Verified-how | Fallback |
| --- | --- | --- | --- |
| Google Identity Services token client (`accounts.google.com/gsi/client`) | `initTokenClient`, scope `https://www.googleapis.com/auth/drive.file` only (files the app itself creates) | code-read | Feature is inert with a plain message until `BRAND.googleClientId` is set |
| Drive v3 REST: `files` list/create, `about`, resumable upload (`uploadType=resumable` session + single PUT) | Resumable protocol allows a single-request PUT body; 5 MB multipart cap avoided | code-read (`cloudBackup.js`) | Local backup download always available |
| Rotation: keep newest 5, filename `drift-backup-YYYYMMDD-HHMMSS.json` | Token in `sessionStorage` only, never persisted | code-read | Weekly quiet backup only with a live session |
| Error mapping: 401→auth, 403 quota→full, 403 rate→busy, 404→missing, 429→busy | Drive's documented error shape | code-read (`classifyDriveError`) | Human-readable `CloudBackupError` kinds |

**UNVERIFIED — Probe P4 (OAuth day):** with a real Google Cloud OAuth
client: connect, upload one backup, list it, download it back, restore
it, confirm rotation keeps 5. Note the testing-mode caveat: an
unverified Google app serves test users only and expires tokens weekly.

## 6. Resend SMTP for confirmation email (ds-sso plan — read from that branch)

Contract: Supabase custom SMTP → `smtp.resend.com:465`, username
`resend`, API key as password; sending domain must be verified
(SPF/DKIM/DMARC) in Resend or mail only reaches the account owner.
Free tier 3,000/mo, 100/day; Supabase custom SMTP starts at 30
emails/hour (adjustable). Supabase's built-in sender (2/hr, team-only)
is **not** production-usable. Redirect allowlist needs
`https://<host>/**` per mirror.
**UNVERIFIED — Probe P5 (setup day):** flip Supabase's "Confirm email"
on, send one real signup, confirm the confirmation email arrives,
click it on a second device, and land signed-in on the right screen
(owner → desktop, customer → the shop's storefront).

## 7. GitHub (repo, Pages, Actions)

| Contract used | Verified-how | Fallback |
| --- | --- | --- |
| `actions/checkout@v4`, `actions/setup-node@v4` (node 20) in mirror/sync workflows | code-read (ds-mesh/ds-x10 branches); v4 lines still supported | Workflows no-op green without secrets |
| Pages deploy of `dist/` (current live demo) | live today | Mirrors (section 3); Pages is not the commercial primary door (ToS, section 3) |
| Repo variables `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` (+ fallback pairs, ds-x10) | code-read (ds-x10 workflow) | A build without them boots to the honest not-configured screen, never a silent stub |

## 8. Payment processors — PLANNED contract, research only (nothing live)

No code, no keys, no accounts yet. The contract the first merchant-pay
slice will be built against:

- **Shape:** processor-hosted checkout (Stripe Checkout / Square
  hosted checkout) on the **merchant's own** connected account
  (Stripe Connect direct charges / Square OAuth). Funds settle to the
  merchant; the platform never touches the money and takes no fee.
- **Amounts:** integer smallest-unit (cents) — matches the app's
  existing money convention.
- **Trust boundary:** payment state is only believed from
  **signature-verified webhooks** (`whsec_…` signing secret / Square
  signature key, HMAC over the raw body), never from browser redirects.
- **Versioning:** pin the processor API version (`Stripe-Version` /
  Square `Square-Version`) in one constant; bump deliberately.
- **Idempotency:** processor idempotency keys derived from the app's
  sale/order id, so a retried checkout never double-charges.
- **UNVERIFIED — Probe P6 (build day):** in the processor's sandbox,
  run one hosted checkout end-to-end, confirm the webhook signature
  verifies, and confirm funds land in the connected (merchant) test
  account with zero platform balance.

## 9. Buyer custom domains + hostname resolution (ds-domains — read)

| Contract used | Verified-how | Fallback |
| --- | --- | --- |
| `hostnameResolve.js`: lowercase, trailing-dot and `:port` stripping, IPv6 brackets, label rules (1–63 chars, ≤253 total, punycode passes), one-level subdomains, reserved `www` | code-read + its 60 tests on that branch | Any bad input falls back to the app home — never a blank page |
| `<shop>.<product-domain>` via the section-4 Worker; buyer's own domain via CNAME → draft migration `custom_domains` + `public_storefront_by_host` RPC | code-read | Shops keep working on the platform address |
| TLS expectations: host-issued certs on Pages/Netlify; Cloudflare for SaaS is the 100+-domain path | docs on that branch | **UNVERIFIED — Probe P7 (domain day):** point one real buyer-style CNAME at the address and confirm cert issuance + storefront resolution |

---

## Merge-day checklist (in order)

1. P1 — fresh-project publishable-key round trip (Supabase).
2. Port the `probeHeaders` rule into ds-mesh/ds-x10 sync tooling; P2.
3. Reconcile this branch's `vite.config.js` / `index.html` / `404.html` /
   `sw.js` with ds-redundancy + ds-x10 (same semantics; take either,
   keep the CSP placeholders and the publishable-key code).
4. P4 — Drive connect/upload/restore once the OAuth client exists;
   Drive backups must restore through the NEW master restore flow
   (ds-restore), not the removed Settings path.
5. P5 — Resend SMTP + "Confirm email" flip, in that order (the ds-sso
   no-lockout backfill migration must land BEFORE the flip).
6. P3/P7 — once the Vendra domain exists: Worker wildcard + one CNAME.
7. P6 — payments sandbox, when the merchant-pay slice is built.

## Known gaps (not fixed here, deliberately)

- **Rate-limit wording:** there is no global 429 mapping. Supabase's
  "too many requests" can still surface as raw backend text outside the
  login screen (which has `friendlyAuthError`). Recommended follow-up:
  one shared error mapper ("the shop's online account is busy — wait a
  moment and try again" / FR equivalent), with ES/PT keys owed. The
  POS already translates network failures for cashiers
  (`POSApp.jsx:725`).
- **Sync-tool header rule:** section 2's companion patch is required
  before the first standby sync runs with an `sb_secret_…` key.

_ES/PT note: strings added on this branch live in the boot/config
screens (hardcoded EN/FR pairs, matching existing style). The
`login.errServerConfig` keys already exist EN/FR; ES/PT equivalents
for the new key-family messages are owed at the locale-parity merge._
