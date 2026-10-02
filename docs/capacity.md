# Drift Shop — Capacity audit: how many shops fit, what breaks first, and the road beyond

Written 2026-10-01 alongside the scale-groundwork branch (`ds-scale`).
Beginner-honest: every number below either comes from a vendor source
(linked, with the date checked) or is labelled as an estimate with its
method shown. Prices and quotas change; re-check the sources before
spending anything.

**The one-sentence answer:** on today's $0 stack, a single free backend
project comfortably holds **a few dozen real shops**; the database size
limit (500 MB) is what fills up first, then photo storage (1 GB) — and
the first *hard* wall is not technical at all: a Supabase account may
only keep **2 active free projects**, so cheap sharding across projects
runs out almost immediately. The groundwork in this branch (backend
directory, image shrinking, per-shop usage readout) removes the
*technical* blockers; the remaining steps are accounts and, eventually,
one $25/month bill.

---

## 1. The stack today, in one picture

| Piece | Where it runs | What it does |
|---|---|---|
| The app (what staff and shoppers open) | GitHub Pages (+ Cloudflare/Netlify mirrors being set up separately) | One static build, ~1.7 MB of code that browsers cache; the public shop page alone is ~66 KB |
| The backend (accounts, sales, files) | One Supabase project, Canada Central (Postgres + Auth + Storage) | Every shop's data lives here, separated by shop (`store_id`) and guarded by row-level security |
| Shop web pages | The same app, at `#/store/<shop-address>` | Read through one locked-down public function (`public_storefront`); anonymous visitors see name + price only |

Everything a shop does — sales, products, customers, appointments,
files — lands in that **one** Supabase project. That is deliberate
(the apps all cross-reference the same data), and it is also the thing
this audit sizes.

## 2. The verified free limits (checked 2026-10-01)

### Supabase, Free plan — $0

Source: <https://supabase.com/pricing> (fetched 2026-10-01).

| Quota | Free limit | Why it matters here |
|---|---|---|
| Users (monthly active) | 50,000 | Each shop has a handful of staff — thousands of shops before this binds |
| Database size | 500 MB | **The first real ceiling** — every sale ever recorded lives in it |
| File storage | 1 GB | Photos/files shops upload; second ceiling |
| Data leaving Supabase (egress) | 5 GB + 5 GB cached / month | API answers are tiny JSON; comfortable |
| Biggest single upload | 50 MB (platform-wide on Free) | Our app allows picking files up to 500 MB, but on the free plan anything over 50 MB is refused by the platform — sellers should keep files under 50 MB today |
| Active projects per account | **2** ("Free projects are paused after 1 week of inactivity. Limit of 2 active projects.") | **The hard wall for free sharding** — see §5 |

Two more, from Supabase's docs/pricing details: free projects **pause
after 1 week of inactivity** (a busy shop keeps its project warm by
using it; a sleeping standby needs a keep-alive ping), and Pro starts
at **$25/month per organization** — 8 GB database, 100 GB file storage,
250 GB egress, daily backups, no pausing.

On the 2-project cap, Supabase's billing FAQ (official docs, fetched
2026-10-01) is precise: *"You are entitled to two active free projects.
Paused projects do not count towards your quota,"* and the count
follows the person: projects in **any** organization where you are
Owner or Admin count. Making extra organizations under the same person
does **not** multiply the allowance. Other *people* can own their own
free projects — that is how a second free project pair can exist
legitimately, but it splits account ownership, and the product should
not be designed around borrowed quotas.

### GitHub Pages — $0

Source: <https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits>
(fetched 2026-10-01).

| Limit | Value |
|---|---|
| Published site size | 1 GB (we use ~3 MB) |
| Bandwidth | 100 GB/month, *soft* limit |
| Builds | 10/hour soft (our deploy workflow is exempt — custom Actions) |

One honest warning from that same GitHub page: GitHub says Pages *"is
not intended for or allowed to be used as a free web-hosting service
to run your online business, e-commerce site, or any other website
primarily directed at facilitating commercial transactions or
providing SaaS."* Many projects serve demos from Pages without issue,
but the product's public home should treat Pages as one mirror among
several — the Cloudflare Pages / Netlify mirrors (set up under the
redundancy work) are the safer front doors at real scale, and they are
equally $0.

## 3. What one shop actually weighs (the footprint model)

Measured from the real schema (`schema.sql` + migrations through 066),
not guessed from the marketing page. Postgres stores each row as the
row itself plus index entries; the planning numbers below are
roughly **2× the raw field bytes**, which is the safe rule of thumb.

| Data | Planning size | Why |
|---|---|---|
| One sale (`pos_sales`, items list stored inside the row) | ~1 KB | A 3-item receipt's item list is ~400 bytes of JSON; row + indexes ≈ 1 KB |
| One product (`pos_products`) | ~0.5 KB | Name/description/barcode; the photo is a web link (URL text), costing no storage |
| One customer (`pos_customers`) | ~0.4 KB | |
| Refunds, gift cards, time punches, appointments | ~0.5 KB each | Low volume next to sales |
| Bookshop inventory item (`bq_*`) | ~0.5 KB | Big catalogues are row-count, not row-size, problems |
| Staff account overhead (settings, desktop layout, pins) | ~2–10 KB, roughly flat | Grows with chat/file *text* the person saves, not with selling |
| A shop file or photo in **file storage** | photo: ~150 KB after shrinking (was 3–5 MB raw) | Binary files live in Storage; their database row is only the label |

**Three shop profiles, one year of trading:**

| | Light shop (10 sales/day) | Typical shop (40 sales/day, 300 products) | Busy shop (150 sales/day, 20,000-item catalogue) |
|---|---|---|---|
| Sales data / year | ~4 MB | ~14 MB | ~55 MB |
| Catalogue + customers | ~0.5 MB | ~0.5 MB | ~11 MB |
| Photos/files (shrunk) | ~2 MB | ~15 MB | ~50 MB |
| **Total new data / year** | **~6 MB** | **~30 MB** (mostly files) | **~115 MB** |

## 4. What breaks first, in order

Budget: 500 MB database (a fresh project already uses a few dozen MB
for its own system tables, so plan on ~450 MB usable), 1 GB file
storage.

1. **File storage — if photos stay raw.** At 3–5 MB per phone photo,
   the 1 GB bucket holds ~250 photos: *two shops with phones full of
   product pictures could fill it.* This is why this branch adds
   automatic shrinking at upload (1600 px, JPEG): the same bucket then
   holds ~6,500 photos, and this risk drops to last place.
2. **Database — via sales history, which we never delete.** ~450 MB ÷
   ~14 MB/year of sales for a typical shop ≈ **30 typical shop-years
   per free project**. In plain terms: one free project holds roughly
   **25–40 shops in their first year**, fewer each year after (sales
   accumulate), unless old sales are archived out (see ladder, step 2).
   Busy shops and big book catalogues pull that number down; light
   shops push it toward 60+.
3. **The 2-active-free-project cap — a policy wall, not a technical
   one.** The day the platform wants a *third* free project, the
   account can't have one. This binds at "shard #3", long before
   quotas on shards #1–2 do.
4. **The inactivity pause.** A project nobody touches for a week goes
   to sleep and the first visit afterwards waits for it to wake. Shops
   that trade daily never notice; a standby/backup project needs the
   scheduled keep-alive the redundancy work adds.
5. **Not the bottleneck, honestly:** user accounts (50,000 vs a
   handful per shop), data egress (5 GB vs tiny JSON answers — the
   public shop page is one small call), GitHub Pages bandwidth
   (100 GB ÷ ~66 KB per shop-page visit ≈ 1.5 million visits/month,
   and mirrors share it), and database connections (the app talks to
   Supabase over its pooled HTTP API; it holds no per-shop persistent
   connections, and nothing in the app uses realtime channels).

## 5. The scale ladder ($0 until step 3)

**Step 0 — today (shipped).** One free project, every shop in it.
Roughly 25–40 first-year shops. Zero code or accounts needed.

**Step 1 — this branch's groundwork (code shipped, inert).**
- **Backend directory** (`src/lib/backend/directory.js`, tested):
  given a shop's address it answers "which backend project serves
  this shop", with the build-time project as the always-safe default.
  No directory configured → nothing changes anywhere.
- **Image shrinking at upload** (`src/lib/imageShrink.js`, wired into
  Files and Pinboard): storage grows ~20× slower.
- **Per-shop usage readout** (Admin → Shops: "Shop files: X in N
  files"): the operator can now *see* a shop approaching trouble
  instead of guessing.

**Step 2 — first shard (still $0).** Stand up a second free
  project, publish a one-page directory JSON (format in
  `docs/backend-directory.example.json`), point the build at it
  (`VITE_BACKEND_DIRECTORY_URL`), and teach the public shop page to
  ask `backendForSlug()` (already written in `current.js`) instead of
  the singleton. New shops are assigned to the emptier project at
  signup. Capacity roughly doubles: ~50–80 shops. This is the end of
  the purely-free road: the account owns exactly 2 active projects.

**Step 3 — Pro, $25/month (the first dollar, only when forced).**
What forces it, in the order you'd feel them: (a) needing a third
active project; (b) a project's database passing ~400 MB (Pro is 8 GB
= ~15× the runway, centuries of one project's sales at step-0 rates);
(c) wanting daily backups and no inactivity pausing. Per-project
compute beyond the included credit runs ~$10/month each, so a fleet
of Pro projects is a real budget line, not a rounding error — prefer
fewer, fuller projects.

**Step 4 — housekeeping that postpones every step above.**
- Archive sales older than ~2 years per shop into the owner's own
  downloadable backup and trim them from the live database (the
  backup/restore work already proves the round-trip; pruning is the
  missing half, and it is future work — nothing prunes today).
- Keep the per-shop readout visible in the master panel so assignment
  decisions are made from numbers.

## 6. How the directory works (for whoever flips the switch)

Format (`docs/backend-directory.example.json`): a static JSON naming
each backend project by a short id, its Supabase URL + **public anon
key** (the same keys already baked into every app build — publishing
them is not a leak; service-role keys must never appear anywhere near
this file), which backend is the default for new/unknown shops, and
the explicit shop→backend assignments. Resolution rules, in order:
exact shop assignment → directory default → build-time default, and
**every failure mode (offline, bad JSON, unknown project, malformed
key) lands on the build-time default** — a broken directory can never
take a working shop offline. Validation reuses the boot-time config
checker, so a directory entry with a clipped key is refused at load,
with shape-only error messages that never echo key material.
Covered by `test/backend-directory.test.mjs` (21 checks).

## 7. Plain words for the owner manual (EN / FR, when the time comes)

> **How many shops can this hold?** One free account comfortably holds
> a few dozen shops in their first year. Photos are shrunk
> automatically so they take about 20× less room. When the platform
> outgrows free accounts, shops are spread across more accounts using
> a built-in directory — nobody's data moves or changes address, and
> the first paid step is a single $25/month bill, only when needed.

> **Combien de boutiques peut-on héberger ?** Un compte gratuit
> accueille confortablement quelques dizaines de boutiques pendant
> leur première année. Les photos sont réduites automatiquement, donc
> elles prennent environ 20 fois moins de place. Quand la plateforme
> dépassera les comptes gratuits, les boutiques seront réparties sur
> d'autres comptes grâce à un annuaire intégré — les données de
> personne ne changent pas d'adresse, et la première étape payante
> est un seul abonnement de 25 $/mois, seulement au besoin.

---

### Sources (all fetched 2026-10-01)

- Supabase pricing and free-plan quotas: <https://supabase.com/pricing>
- Supabase billing FAQ (two-active-free-projects rule): official docs,
  <https://supabase.com/docs/guides/platform/billing-faq>
- GitHub Pages limits and acceptable use: <https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits>
- Footprint model: this repo's `schema.sql` and migrations (through
  066), `pos_sales` items-JSON storage shape, and the measured build
  output of this branch (App chunk 1.07 MB; storefront route ~66 KB
  gzipped). Row-size figures are planning estimates by the stated 2×
  rule, not vendor numbers.
