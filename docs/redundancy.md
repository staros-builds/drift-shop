# Drift Shop — x10 redundancy: the ten-layer survival map

*Status: architecture + automation landed on this branch. What runs
today: the GitHub Pages door (live) and the single-target sync tools.
What is built and waiting: the active-active mirror fan-out, the
multi-target sync, keep-alive, scheduled backups, and the client
database failover — all inert until the owner creates the accounts and
pastes the secrets (checklist at the end). Everything is free-tier,
managed services only, no self-hosting, no credit card anywhere.*

*Companions: [backend-mesh.md](backend-mesh.md) is the database-sync
design this extends (read its split-brain section before touching
anything here). [capacity.md](capacity.md) (companion branch) owns
the "how many shops fit" math; this doc owns "what survives". The
buyer manual's short version of the door story is quoted below.*

*All vendor numbers in this doc were verified against official
docs/pricing pages on 2026-10-01. Free tiers move — re-run the survey
before promising any number to a buyer.*

## For the manual (beginner words, EN + FR)

> **EN — Why your shop has many doors.** Your shop's pages are kept
> in several places at once, like a shop with doors on different
> streets. If one street is closed for repairs, you walk in through
> another door — it is the same shop inside, with the same shelves
> and the same till, because everything about your shop is kept in
> one safe place that all the doors share. If a door will not open,
> try the next address on your shop's list. Your products and sales
> are never inside the door itself, so a broken door loses nothing.
> Behind the scenes your shop's information is also copied, every
> hour, to spare systems in other places, and checked copy by copy —
> if a copy ever disagrees, we hear about it before you do.
>
> **FR — Pourquoi votre boutique a plusieurs portes.** Les pages de
> votre boutique sont gardées à plusieurs endroits en même temps,
> comme une boutique avec des portes sur différentes rues. Si une
> rue est fermée pour travaux, vous entrez par une autre porte —
> c'est la même boutique à l'intérieur, avec les mêmes tablettes et
> la même caisse, parce que tout ce qui concerne votre boutique est
> gardé dans un seul endroit sûr que toutes les portes partagent. Si
> une porte ne s'ouvre pas, essayez l'adresse suivante sur la liste
> de votre boutique. Vos produits et vos ventes ne sont jamais dans
> la porte elle-même : une porte brisée ne fait rien perdre. En
> arrière-plan, les informations de votre boutique sont aussi
> copiées, chaque heure, vers des systèmes de secours situés
> ailleurs, et vérifiées copie par copie — si une copie n'est pas
> d'accord, nous l'apprenons avant vous.

## The ten survival layers — and what the user notices when one dies

The design goal: **NOTHING** for every single-component death that
$0 physics allows. Where it is impossible, the real floor is stated
without gloss (see "True floors" after the table).

| # | Layer | When this dies, the user notices… |
|---|-------|-----------------------------------|
| 1 | App door: Cloudflare Pages (primary commercial door) | **NOTHING** — every release pushes the identical build to all doors at once (active-active); behind the apex Worker even the address stays the same. |
| 2 | App door: Firebase Hosting (Spark) | **NOTHING** — same reason. |
| 3 | App door: Surge | **NOTHING** — same reason. |
| 4 | App doors: Netlify + Render (quota-tight backups) | **NOTHING** — if they die of quota exhaustion, the other doors don't care. |
| 5 | GitHub Pages (docs/manual mirror + legacy app door) | **NOTHING for the shop** — the manual PDF also lives in the repo and in the app. See the ToS note below: the commercial app's primary door moves off Pages. |
| 6 | Primary database (the ONE writer) | **A message, then degraded mode**: at boot the honest "couldn't reach" card, or — with a standby configured — the app opens the backup copy **read-only** with a banner (browsing works; sales and edits pause with an honest bilingual message). Writes wait for the human failover (~10 min). True zero-downtime *writes* are impossible at $0 — named below. |
| 7 | A warm standby database | **NOTHING** — the primary is untouched; the next hourly sync run alarms; the slot is re-created and re-seeded. |
| 8 | All live database copies at once | **A message + a wait**: restore the newest dump file into a fresh project (30–60 min of human work), rebuild, redeploy. Loss = dump age (≤ 1 week at the default cadence). |
| 9 | Scheduled backup exports failing | **NOTHING today** — the alarm fires. Risk accrues only if the owner ignores the alarm, which is stated plainly, not hidden. |
| 10 | The watchers (keep-alive, sync alarms, this runbook) | **NOTHING immediately** — which is the scary one: silence looks like health. Mitigated because failed GitHub Actions *always* email the owner, and the 3-day keep-alive is independent of the sync. |

### True floors — where zero downtime is impossible at $0 (named)

- **Database write failover: ~10 minutes, human.** Automatic writer
  promotion is refused on purpose: two writers = split-brain
  inventory and sales, and only a person can tell "the primary is
  dead" from "my network is down". The floor for *reads* is ~10–30
  seconds (boot probe → read-only standby); for *writes* it is the
  runbook. RPO = sync interval (≤ 1 h default, ≤ 15 min opt-in).
- **All-copies data loss: 30–60 minutes, human**, RPO = newest dump
  age. This is what layers 8–9 of the data stack exist to bound.
- **Worker request cap: 100,000 requests/day** (Cloudflare Workers
  Free). Past it, Cloudflare errors and the one-address property
  breaks — the doors' native addresses keep working, which is why
  setup never hides them.
- **Paused-project revival: minutes, human** (dashboard unpause +
  resync). Cold archives are not hot standbys — the doc never calls
  them that.
- **DNS/apex changes: minutes of propagation.** No $0 DNS does
  instant global failover.

## Mechanism A — active-active mirrors (BUILT)

The doors are not cold standbys to "activate later". Every release
(`.github/workflows/deploy-mirrors.yml`, the one release action)
builds **once**, fingerprints the `dist` (sha256 of every file, in
the run summary), and pushes the **same artifact** to every host in
`deploy/mirrors.json` whose secrets exist — simultaneously. A single
host death is invisible to everyone except someone pinned to that
host's exact address, and the apex Worker (mechanism B) removes even
that. Hosts without secrets no-op green with a notice.

Why the identical build runs everywhere, unchanged (all in the repo):
relative asset base (`base: './'`), hash routes (`#/...` — the
server only ever serves `index.html`), and one backend address baked
per release. `deploy/emit-matrix.mjs --check` validates the
registry; `test/mirrors-registry.test.mjs` enforces the rules (≤ 10
hosts, unique ids, `codeChanges: "none"` for every host, secrets as
names only, dropped hosts must say why).

### Host survey (verified against vendor docs, 2026-10-01)

Of ten surveyed hosts, **five** can carry the commercial app at $0
with no card. The other five are dropped *with the reasons written
in the registry* — the slots stay documented so the survey never has
to be repeated blind.

| Host | Verdict | Binding constraint (verified) |
|------|---------|-------------------------------|
| Cloudflare Pages | ✅ **Primary commercial door** | 500 builds/mo; static requests + bandwidth **unlimited**; 20k files/site; 25 MiB max file |
| Firebase Hosting (Spark) | ✅ Mirror | 10 GB storage, **10 GB/mo transfer** — then disabled till next month. Never upgrade to Blaze (card). `login:ci` tokens deprecated → service-account auth |
| Surge | ✅ Mirror | **No published quota** — unquantified fair-use risk, not a hard number. Custom domains + certs free (0.40 notes) |
| Netlify | ⚠️ Backup door | New accounts: **300 credits/mo** ≈ ~20 deploys *or* ~15 GB bandwidth, then the project pauses till next cycle |
| Render (static) | ⚠️ Backup door | **5 GB/mo** outbound (cut from 100 GB in Apr 2026), 500 build min/mo; no card = suspension, not billing |
| GitHub Pages | 📄 Docs/manual mirror + legacy app door | **ToS bars commercial SaaS/e-commerce hosting** (see note) |
| GitLab Pages | ❌ Dropped | CI requires identity verification — risk-scored, possibly phone/card for new accounts |
| Vercel (Hobby) | ❌ Dropped | Hobby = non-commercial personal use only (fair-use guidelines, Sep 2026) |
| Azure Static Web Apps | ❌ Dropped | Account creation requires a credit/debit card + forced pay-as-you-go within 30 days |
| Deno Deploy | ❌ Dropped | Full free limits gated behind card verification since Sep 2025; no-card tier unpublished |

**GitHub Pages ToS note — read this before relying on the live door.**
GitHub's own Pages limits page states Pages *"is not intended for or
allowed to be used as a free web-hosting service to run your online
business, e-commerce site, or any other website that is primarily
directed at either facilitating commercial transactions or providing
commercial software as a service (SaaS)."* The current live demo door
is on GitHub Pages. The plan: move the **commercial** app's primary
door to Cloudflare Pages / Firebase Hosting; keep GitHub Pages for
the manual and docs (its intended use). The registry carries this in
`tosNote` so it can't be forgotten.

Header reality: only Netlify (`netlify.toml`, in repo), Cloudflare
(future `_headers`), and Firebase (`firebase.json`, in repo) send
real response headers; everywhere else the CSP rides in a `<meta>`
tag (no `frame-ancestors`, no HSTS). Accepted and documented since
the first mirror.

## Mechanism B — one-address health-checked failover (SPEC)

*Post-registration: once the apex domain's DNS is on Cloudflare.
Nothing here is deployed yet — the domain doesn't exist — so this is
a precise spec, not dead code.*

A free-tier Cloudflare Worker fronts the apex and the wildcard shop
subdomains. **One Worker does both jobs** — the shop-subdomain
routing from the custom-domains workstream and the failover below
are the same deployment (merge point: that Worker gains the
origin-retry loop).

- **Routes:** `apex/*` and `*.apex/*` on the same Worker.
- **Shop subdomains:** extract `<shop>` from the hostname, serve the
  app shell from the origin pool; the app resolves the shop
  client-side (domains workstream). No per-shop origin config.
- **Origin pool (in order):** Cloudflare Pages → Firebase Hosting →
  Surge → Netlify → Render. (Same provider first = lowest latency;
  quota-tight doors last.)
- **Retry policy:** on network error, timeout (8 s `AbortSignal`),
  or **5xx** → try the next origin. **Never on 4xx** — a 404 means
  the origin served; failing over would just repeat it.
- **Cache rules:** HTML (`/`, `/index.html`, and every hash-route
  path — they all serve `index.html`) → **bypass cache entirely**
  (the app shell changes per release; the service worker handles
  client-side shell caching). Hashed assets (`/assets/*`) → cache 1
  year, immutable. Icons/manifest → cache 1 hour.
- **The 100k/day cap:** Workers Free = 100,000 requests/day. Past
  it, Cloudflare errors and the one-address property breaks — the
  doors' native addresses (`*.pages.dev`, `*.web.app`, …) keep
  working, which is why setup never hides them. Math: ~30 requests
  per full app load → ~3,300 full loads/day headroom. Fine for
  launch; growth is capacity.md's subject. Optimization held in
  reserve: route only the HTML shell through the Worker later.
- **Failure modes:** all origins 5xx/timeout → serve a baked-in 503
  page listing the doors' native addresses (users go direct).
  Worker code bug → same as cap-hit (test on a staging route first).
  10 ms CPU limit: the retry loop is trivially under it.
- **What it does NOT do:** it does not fail over the *database*
  (mechanism C is the client's job), and it is not automatic DNS —
  it's better: the address never changes at all.

## Mechanism C — client-side database auto-failover (BUILT, default off)

*Implemented in `src/lib/dbEndpoints.js`, wired in `src/main.jsx` +
`src/lib/backend/supabase.js`, tested in
`test/db-failover.test.mjs` (14/14). Default off: with no
`VITE_SUPABASE_FALLBACK_*` variables the boot is byte-for-byte
today's behavior.*

### Boot-probe order

1. Probe the **primary** up to 3 times, 1.5 s apart — a transient
   blip must never fail over.
2. Each probe is the existing self-check (reachability + `pos_stores`
   schema sanity). A standby that answers but fails its schema check
   is **skipped, not trusted**.
3. Walk the fallback list in build-config order (`VITE_SUPABASE_
   FALLBACK_URL`, `_FALLBACK2_URL`, … — the build bakes the
   promotion order; a human updates it from the sync ledger).
4. First healthy standby → the session boots in **read-only mode**:
   the adapter's client is wrapped so every write path rejects
   (`insert/update/delete/upsert`, storage uploads, mutating RPCs,
   auth writes, edge functions), reads pass through, and a fixed
   banner offers "Try the main server again" (reload = re-run the
   probe). Nothing configured or nothing answers → today's honest
   error card.

### The line — what is refused and why

- **Clients NEVER write to a standby.** The hourly sync job is the
  only writer to standby databases (primary → standby). Two writers
  = split-brain inventory and sales. This is the same rule as the
  mesh design, enforced in the client, not just in docs.
- **Mid-session primary death is NOT silently re-routed.** An
  in-flight sale that loses the primary fails honestly — the POS
  shows the existing "sale failed" state and the cart stays in
  memory for retry (the cloud-only rule). Re-sending a half-finished
  write to another database could record it twice or lose it; that
  is exactly what we refuse to do. Reads mid-session surface the
  app's existing honest error states. A reload re-runs the boot
  probe and may land on the read-only standby.
- **Promoting a standby to the new primary is a human decision**
  (the mesh runbook: pick the freshest green standby from the
  ledger, rebuild with its URL/key, redeploy all doors, re-seed the
  old primary's slot). Only a person can confirm "the primary is
  really dead" vs "my network is down", and the sync direction must
  flip with the promotion.
- **Switch-back reconciliation: there is nothing to reconcile — by
  construction.** No client ever writes to a standby, so no standby
  writes exist. When the primary recovers: reload (the probe finds
  it live), sign in again (sessions don't travel between projects),
  continue. The hourly sync resumes and re-converges the standbys.

### Sync intervals — the honest RPO story

GitHub Actions cron minimum is **5 minutes**; in practice schedule
on odd minutes (`:37`) because top-of-hour queues slip.

| Cadence | RPO | Cost at $0 | Verdict |
|---------|-----|-----------|---------|
| Hourly (current) | ≤ 1 h | 24 pg_dumps/day; trivial on shared free CPU | Default. Fine until the shop is live and busy. |
| Every 15 min (one-line cron change) | ≤ 15 min | 96 dumps/day; 4× row-count queries; 4× Actions runs (free on public repos). More Supabase activity = better pause protection (community-observed, unofficial). | Opt-in when live. |
| Every 5 min | ≈ run duration, not 5 min | The dump→restore→verify cycle approaches the interval; the concurrency group serializes overlaps, so effective freshness ≈ run duration. | Not recommended — noise without benefit. |

Shortening the interval buys **data freshness only** — failover
still needs the ~10-minute human switch, and the boot failover's
read-only mode covers browsing in the gap.

## The data half, x10 — ten named survival layers

One writer, always. The forbidden failure is split-brain
inventory/sales; everything below is *copies*, and the copies talk
to each other through the sync tooling (the conversation map
follows).

| # | Data layer | Protects against | Freshness (RPO) | Cost |
|---|-----------|------------------|-----------------|------|
| 1 | **The primary** — Supabase, Jesse's account, Canada Central | — (this is the shop's memory) | — | $0 (1 of 2 active projects) |
| 2 | **Warm standby-1** — Supabase, Jesse's account (2nd active project), us-east-1 | Primary death, region loss | ≤ 1 h (hourly sync, row-count verified) | $0 (2nd active project) |
| 3 | **Warm standby-2** — Supabase, Cooper's account (1st project), eu-west-1 | Primary + standby-1 dying; **account-level** loss (billing/ToS/account action) | ≤ 1 h | $0 (new account, no card) |
| 4 | **Warm standby-3** — Supabase, Cooper's account (2nd project), us-west-1 | Two regions down at once | ≤ 1 h | $0 |
| 5 | **Cold archives** — paused Supabase projects (slots standby-4/5), re-seeded weekly | Everything above incl. both accounts | ≤ 1 week; revive = manual unpause + resync | $0 (paused projects don't count against the 2-active cap) |
| 6 | **Hourly SQL dumps** → GitHub Releases on the private backup repo | All Supabase copies lost at once | ≤ 1 h | $0 (releases: 2 GiB/file, 1000 assets/release, no total cap, no expiry) |
| 7 | **Weekly encrypted full dumps** (schema+data+auth, AES-256) → same Releases | Dump tampering/age; auth recovery | ≤ 1 week | $0 |
| 8 | **Per-shop owner backups** — Settings → Backup download | The platform disappearing; the owner's own mistakes | Whenever the owner clicks | $0 |
| 9 | **Owner's cloud copy** — Drive-first connect-your-own (cloud-backup research) | The owner's device dying with layer 8 on it | Whenever the owner syncs | $0 (their own free storage) |
| 10 | **The sync ledger + alarms** — hourly run summaries (per-target row counts + timestamps), 3-day keep-alive, owner-email on failure, this runbook | **Silent** death of layers 2–7 (a copy that stops syncing looks healthy until you need it) | Continuous | $0 |

**The honest ceiling:** 10 *warm, synchronized* copies on free
tiers would need **5 Supabase accounts** (2 active projects per
account — verified: the cap follows the *member*, not the org; more
orgs do not multiply it). The realistic $0 fleet is **4 live copies
across Jesse's + Cooper's accounts** (layers 1–4). Layers 5–10 make
up the ten: cold archives, dump files, owner-held copies, and the
ledger that watches them all. If more accounts ever join, slots
standby-6…9 in `tools/sync/targets.json` are already named and
waiting — no code changes.

**Neon and friends are backup-only, never failover targets.** A
`pg_dump` restores fine onto Neon (1 GB/project free), but the app
speaks PostgREST + Supabase Auth + RLS (`auth.uid()`, role-switched
JWTs signed by GoTrue) — none of which exists on raw Postgres.
Making Neon serve the app would mean self-hosting PostgREST and
recreating the auth schema: real engineering, not a managed $0
drop-in, and self-hosting is out of scope. Saying otherwise would be
lying about the architecture.

**What is never copied** (unchanged from the mesh design): uploaded
file *contents* (rows about files are copied; the bytes ride the
in-app Backup), and sign-in sessions (password hashes travel with
`--with-auth`, so logins survive — sessions don't).

### The data conversation map — everything talks to each other

```
PRIMARY (Jesse, Canada Central — the ONE writer)
 │
 ├─ hourly db-sync-multi.yml ──▶ sync-all.mjs ──▶ standby-1 (Jesse, us-east-1)      [layer 2]
 │                                (pg_dump → restore,      standby-2 (Cooper, eu-west-1)   [layer 3]
 │                                 row-count verify ±5%,    standby-3 (Cooper, us-west-1)   [layer 4]
 │                                 sequential, gentle)      any failure → owner email
 │
 ├─ weekly seed mode ───────────▶ cold archives standby-4/5 (paused)               [layer 5]
 │
 ├─ hourly db-backup.yml ───────▶ dump.sql.gz ──▶ GitHub Releases (private repo)    [layer 6]
 ├─ weekly db-backup.yml ───────▶ full+auth, AES-256 ──▶ same Releases              [layer 7]
 │
 ├─ (owner clicks) ─────────────▶ owner backup file ──▶ owner's Drive              [layers 8, 9]
 │
 └─ every run ──▶ RUN SUMMARY LEDGER ──▶ per-target row counts + timestamps ──▶ owner email on failure   [layer 10]
                         │
                         │  staleness = now − last-green(target)  (> 2× interval = stale)
                         ▼
              FAILOVER RUNBOOK promotion order ──▶ human rebuilds with the freshest green copy
                         │
                         ▼ (build bakes the order)
              APP BOOT (mechanism C) ──▶ probe primary → VITE_SUPABASE_FALLBACK* in ledger order
```

- **Which copy feeds which:** only the primary feeds; standbys never
  feed each other or the primary (one direction, no loops, no
  split-brain).
- **How often:** warm standbys hourly (15-min opt-in); cold archives
  weekly; dumps hourly + weekly; owner copies on click.
- **How staleness is detected:** the ledger. Every sync run names
  every target with row counts and a timestamp; anything older than
  twice the interval is stale. The 3-day keep-alive pings every
  configured copy with anon keys only.
- **Pause-timer honesty:** Supabase pauses free projects after ~1
  week of *inactivity* and does **not** officially define activity.
  Community experience (unofficial — flagged as such): the timer
  tracks database activity, and a daily write resets it more
  reliably than reads. So the keep-alive pinger is best-effort, not
  a guarantee; the hourly sync's writes are the real keep-alive for
  warm standbys. A future `ops_heartbeat` INSERT (needs a migration)
  would make it deterministic — specified, not yet built.
- **What the app does:** mechanism C reads the ledger's promotion
  order (baked into the build as fallback order) and probes it at
  boot. The app never writes to a standby, so the conversation stays
  one-directional.

## The doors, wired (files)

- `deploy/mirrors.json` — the registry (5 verified doors, GitHub
  Pages repositioned, 4 dropped with reasons).
- `deploy/emit-matrix.mjs` — validation + matrix emission.
- `.github/workflows/deploy-mirrors.yml` — the one release action:
  build once → fingerprint → fan out to all validated doors
  simultaneously. GitHub Pages keeps its current deploy until
  `vars.MIRROR_GITHUB_PAGES=true` flips it into this workflow
  (never both at once). Firebase uses a service-account JSON
  (`FIREBASE_TOKEN` is deprecated upstream).
- `netlify.toml`, `firebase.json`, `.gitlab-ci.yml` (inert on
  GitHub; kept for verified GitLab accounts) — per-host config.
- `src/lib/dbEndpoints.js` — mechanism C (config, boot probe,
  read-only guard). `test/db-failover.test.mjs` — 14/14.
- `tools/sync/*` — the mesh tools, copied byte-identical from the
  mesh branch (merges stay trivial); `targets.json` (9 slots, 3
  warm mapped to Jesse's + Cooper's accounts); `sync-all.mjs`
  (fan-out orchestrator); `keepalive.mjs` (3-day pings).
- `.github/workflows/db-sync-multi.yml` (hourly `:37`),
  `db-keepalive.yml` (every 3 days), `db-backup.yml` (hourly dumps
  + weekly encrypted full → Releases and/or artifacts).

## Failover playbooks

**Database (~10 min, human):** confirm the primary is really down
(not your network) → read the ledger, pick the freshest green
standby → rebuild with its URL/key as `VITE_SUPABASE_URL` (+ its
fallback order) → redeploy (all doors rebuild within minutes) →
sign in (sessions don't travel — everyone signs in again) → one
test sale + refund → **disable the sync jobs until the new primary
is live, then re-point them** → re-seed the old primary's slot as a
standby once healthy → tell staff. With the apex Worker live, nobody
needs a new address.

**Address — with the Worker (post-registration):** nothing. The
Worker retries the next origin in seconds; the address never
changes. **Without the Worker:** staff use the next door on the
list; if the dead door was "home", one DNS edit repoints the apex
(minutes of propagation). The doors' native addresses always work —
that is why setup never hides them.

## Signup checks: what each account asks for (owner rule)

The owner has asked for plans that avoid human-verification gauntlets —
CAPTCHAs, phone-number checks, ID checks — wherever possible, and to flag
the ones that cannot be avoided so he can pass them himself (he rates
himself pretty good at those). Applied here:

**Needs nothing new:**

- **GitHub (live door + all the automation):** the `staros-builds` account
  already exists. No signup step remains.
- **Surge (mirror):** email + password from the command line. Historically
  one of the lowest-friction signups anywhere — no phone, no card, no
  challenge gauntlet.

**One confirmation click, possibly one human check:**

- **Cloudflare (planned primary door + the one-address Worker):** email +
  password, plus a confirmation email to click. No phone, no card.
  Cloudflare sometimes shows one of its own human checks at signup or
  first sign-in — if one appears, the owner clicks through it; everything
  after that is API tokens, no further checks.
- **Netlify (backup door):** sign up with the existing GitHub account (one
  click, no new password) or email + confirmation link. No phone, no card.
- **Render (backup door):** same shape — existing GitHub account or email.
  No card on the free tier.
- **Supabase copies 2, 3 and 4 (warm standbys):** new accounts under the
  owner's and Cooper's emails. Sign in with the existing GitHub account
  where available; otherwise email + confirmation link. No phone, no
  card. Nothing else is needed to create the projects.

**The one place a phone check might appear — flagged on purpose:**

- **Firebase (mirror):** Firebase itself asks for no card on the free
  "Spark" tier, but it lives inside a Google account. Use a Google
  account the owner already has and this step is zero. Only if a brand-new
  Google account had to be created might Google ask for phone
  verification — and that is exactly the kind of step the owner does
  himself. Do not create a new Google account for this mirror unless
  needed.

**Where this rule changed a verdict:** Azure (phone + card), Deno Deploy
(card), and GitLab (CI identity verification) were already dropped; under
the owner's rule they were never coming back. Nothing in the kept set
requires a phone number, an ID, or any verification the owner cannot
click through in under a minute.

## Accounts & secrets checklist (owner creates; agents never do)

App doors (all owner email, no card): Cloudflare
(`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`;
`CLOUDFLARE_PAGES_PROJECT`) · Netlify (`NETLIFY_AUTH_TOKEN`,
`NETLIFY_SITE_ID`) · Surge (`SURGE_LOGIN`, `SURGE_TOKEN`;
`SURGE_DOMAIN`) · Render (`RENDER_DEPLOY_HOOK_URL`) · Firebase
Spark (`FIREBASE_SERVICE_ACCOUNT` = service-account JSON;
`FIREBASE_PROJECT_ID`). Apex later: Cloudflare DNS zone + the
Worker (same account as the Pages door).

Database copies: `PRIMARY_*` (4 secrets) once, then per slot
`<PREFIX>_SUPABASE_URL`, `<PREFIX>_SUPABASE_ANON_KEY`,
`<PREFIX>_SUPABASE_SERVICE_KEY`, `<PREFIX>_DATABASE_URL`
(prefixes `STANDBY`, `STANDBY2`, `STANDBY3` warm; more as accounts
join). Backup layer: private backup repo + `BACKUP_REPO_TOKEN`,
`BACKUP_PASSPHRASE` (recommended), `vars.BACKUP_REPO`. Build
failover config (repo *variables*, safe): `VITE_SUPABASE_FALLBACK_URL`
/ `_ANON_KEY` (+ numbered pairs) — these bake the ledger's
promotion order into the app.

Every password goes in the Secure Vault; agents use values
transiently and never record them.

## Patch plan (merging with the mesh + redundancy branches)

1. `tools/sync/*` single-target tools and `docs/backend-mesh.md` are
   copied here **byte-identical** from the mesh branch — merges are
   trivial. `main.jsx`'s `runSelfChecks` moved verbatim into
   `src/lib/dbEndpoints.js` (same 12 s timeout, same logic).
2. Once `db-sync-multi.yml` and the mesh `db-sync.yml` coexist,
   delete `db-sync.yml`'s **schedule** (keep manual dispatch) or the
   file outright: multi is a strict superset (slot 1 = `STANDBY`).
   Crons are offset (:07 vs :37) so the transition can't double-run
   in the same minute.
3. `db-keepalive.yml` has no mesh counterpart; keep as is.
4. The ds-domains wildcard Worker and the mechanism-B failover
   Worker are **one deployment** — merge the origin-retry loop into
   that Worker when the apex exists.

## Interplay with capacity.md

`docs/capacity.md` (companion branch) owns ceilings — how many shops
fit in 500 MB, bandwidth per door, Worker requests per day. This doc
owns survival — what keeps running when something dies. They meet at
three numbers, deliberately duplicated in both: the 500 MB database
ceiling, the per-door bandwidth quotas above, and the Worker's
100k/day cap. Everything else lives in exactly one place.

## Honest limits (what $0 still does not buy)

- **No automatic database failover.** The switch is a short
  checklist by a person, on purpose. ~10 minutes, RPO = sync
  interval.
- **RPO > 0, always.** Hourly copies = up to an hour of sales
  re-typed from receipts; weekly dumps = up to a week if every live
  copy dies at once. The 15-minute opt-in exists; say the word.
- **Warm standbys ≠ capacity.** Four live copies don't make the
  free 500 MB database bigger; they make it survivable.
- **Free tiers move.** Every number here was verified 2026-10-01
  and will drift. The workflows fail loudly (owner email) rather
  than silently when a tier change breaks a layer.
- **The pause timer is officially undefined.** The keep-alive is
  best-effort; the sync's writes are the reliable heartbeat for
  warm standbys (community-observed, flagged as unofficial).
- **Service-worker staleness.** A device that hasn't reopened the
  app can briefly serve the pre-failover build; the per-deploy
  cache stamp self-corrects on next visit.
- **GitHub Pages can't be the commercial primary** (ToS). The move
  to Cloudflare Pages / Firebase is planned, not optional.
