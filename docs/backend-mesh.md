# Drift Shop — backend mesh: primary database + hot standby

*Status: tooling built and dry-run-safe. The standby project itself is
not created yet — one owner step remains (see "One-time setup"). Until
then the scheduled job no-ops cleanly. Everything here is free tier,
managed services only, no self-hosting.*

*Companion doc: [redundancy.md](redundancy.md) covers the page mirrors
(GitHub Pages / Cloudflare Pages / Netlify) and the in-app
Backup → Restore last-resort path. This doc is the layer underneath:
keeping a second **database** continuously copied so a failover does
not need the restore step at all.*

## The idea in one paragraph

There is ONE live database (the **primary**): every till, phone, and
storefront page reads and writes there, so there is only ever one
stock count, one sales history, one truth. A second database project
(the **standby**, in a different region) receives a full copy on a
schedule — hourly — and is otherwise never used for real work. An
hourly job checks that both databases are reachable, copies primary →
standby, then counts the rows on both sides and raises an alarm if
they disagree. If the primary ever dies, we rebuild the app pointing
at the standby (about 10 minutes) and shops keep selling. The two
databases "talk to each other" through that job: it hears both sides,
compares them, and shouts when something is off.

## Why not two live databases that both take sales?

Because they would disagree, and nobody could fix it. If two tills
sell the last $12.50 widget into two different databases, each one
thinks the other sale never happened; when the copies are later
merged, the stock count, the refunds, and the day's totals cannot
all be true at once. This is called *split-brain*, and no free
managed service offers the machinery that prevents it (that machinery
is consensus/replication software that costs real money). What $0
buys instead — and what actually protects a shop — is: never lose
the data, notice immediately when one side is sick, and switch to
the copy on purpose, once, with the numbers verified first. One
writer, one verified copy, a written switch procedure.

## What is protected, and what is not (honest list)

Copied every sync run:

- Every row of every table in the `public` schema — products, sales,
  refunds, customers, staff, shifts, appointments, gift cards, the lot.
- Optionally (default ON in the scheduled job): `auth.users` +
  `auth.identities`, so staff **logins keep working after failover**
  (password *hashes* travel; nobody's password is ever readable).

Not copied — stated plainly:

- **Uploaded file contents** (the storage bucket). Database rows
  describing files are copied; the files themselves live only in the
  primary's storage. At $0 there is no free cross-project storage
  mirror; the in-app Backup (Settings → Backup) includes file
  contents and stays the remedy for files. See redundancy.md.
- **Sign-in sessions.** Tokens are signed with the primary's secret;
  after a failover everyone simply signs in again.
- **Schema changes are not automatic.** `sync` mode copies data only.
  After new migrations land on the primary, run one `seed` run
  (workflow_dispatch → mode `seed`, or `sync.mjs --mode seed`)
  so the standby's tables match — the row-count check will name any
  missing table and fail the run until you do.

## How the sync works

```
        ┌──────────────────── GitHub Actions (hourly, minute :07) ───────────────────┐
        │  probe both REST endpoints ──► pg_dump PRIMARY ──► psql load ──► row counts │
        │  any failure or mismatch = failed run = GitHub emails the repo owner       │
        └────────────────────────────────────────────────────────────────────────────┘
   PRIMARY (live, the only writer) ──────────────► STANDBY (hot copy, different region)
        ▲                                                        │ restore
        └──────────── failover = rebuild app with standby env ◄─┘ (~10 min, by hand)
```

Why `pg_dump` and not the in-app backup format? The Settings backup
(`src/lib/accountBackup.js`) is a *per-user* export: it carries the
signed-in user's own rows, caps file binaries (25 MB each / 200 MB
total), and restores store-by-store through import RPCs. That is the
right tool for "an owner keeps a copy of their shop" — and the wrong
tool for cloning a whole backend: it cannot carry other users' rows,
policies, functions, or sequences, so the clone would not behave
identically. `pg_dump --schema=public` copies the schema and every
row byte-for-byte; the standby then answers the same REST API the
moment the app is rebuilt against it. The two tools complement each
other: pg_dump mesh for provider death, in-app backup for an owner
who wants their data in their own hands.

Tools (`tools/sync/`, all dry-run by default — they print commands
and touch nothing until `--live` AND `SYNC_ALLOW_WRITE=1`):

| Tool | What it does |
|---|---|
| `probe.mjs` | "Can each backend hear us?" — HTTP probe of both `/rest/v1/`, same check as the app's boot screen. Run any time. |
| `export.mjs` | `pg_dump` of the primary (`seed` = schema+data, `sync` = data only; `--with-auth` also dumps login accounts to a second file). |
| `restore.mjs` | Loads a dump into **the standby only** (it has no code path that can write to the primary). `sync` mode wipes standby tables first, then streams data in. |
| `counts.mjs` | Row counts on both sides, compared; exit 1 on mismatch. Safe to run any time (read-only). |
| `sync.mjs` | All of it in order: probe → copy → verify. This is what the scheduled job runs. |

Row counts come from PostgREST (`Prefer: count=exact`) using the
service_role keys — which is why those keys must exist as secrets and
must never be committed. Table list is discovered from each project's
`/rest/v1/` OpenAPI document; `tools/sync/tables.json` is the
fallback if discovery ever fails.

## The alarm

There is no pager at $0, so the alarm is deliberately boring and
reliable: **a failed sync run makes GitHub email the repo owner.**
That fires when either backend is unreachable, when the copy fails,
or when the post-copy row counts disagree by more than 5 rows on any
table (sales written mid-dump legitimately lag a few rows). A shop
also sees trouble first-hand: the app's boot self-check already shows
"Could not reach your shop's online account" with a Retry button when
the primary cannot be reached, and now adds, in plain words, that if
other websites work the problem is on our side and their information
is kept safe in more than one place.

## One-time setup (the owner step)

1. **Create the standby Supabase project** under the same account:
   Dashboard → New project. Choose a DIFFERENT region from the
   primary (primary is Canada Central — e.g. pick a US or EU region).
   Free tier. Save its database password in the Secure Vault.
2. **Get both projects' values** (Dashboard → Project Settings → API,
   and → Database for the connection string):
   - REST URL + `anon` key + `service_role` key for each project.
   - The **Session pooler** connection string for each project
     (Database → Connection string → Session pooler). Use the pooler:
     the direct `db.<ref>.supabase.co` address is IPv6-only on newer
     projects and GitHub's runners reach the IPv4 pooler reliably.
3. **Add GitHub repo secrets** (repo → Settings → Secrets and
   variables → Actions): `PRIMARY_SUPABASE_URL`,
   `PRIMARY_SUPABASE_ANON_KEY`, `PRIMARY_SUPABASE_SERVICE_KEY`,
   `PRIMARY_DATABASE_URL`, and the same four prefixed `STANDBY_`.
   (Names with the shorter `PRIMARY_URL` shape also work — see
   `tools/sync/lib/env.mjs`.)
4. **First copy**: Actions → db-sync → Run workflow → mode `seed`,
   with_auth on. The standby now holds schema + data + logins.
5. From then on the hourly `sync` runs by itself. Watch the first
   few runs go green; a red run emails you — that is the alarm
   working, not noise.

Local use is identical, with the same names in your shell:
`node tools/sync/probe.mjs`, then `node tools/sync/sync.mjs`
(dry run — read what it *would* do first), and only then
`SYNC_ALLOW_WRITE=1 node tools/sync/sync.mjs --live`.

## Failover runbook (~10 minutes, by hand, on purpose)

*Do this only when the primary is truly down — the app's boot screen
says it cannot reach the shop's account AND the sync job / Supabase
status page agrees. A failover moves the shop; do not rehearse it on
a live store "just to see".*

1. **Check the standby is trustworthy.** GitHub → Actions → db-sync:
   the latest run must be green. If it is red, run `counts.mjs` logic
   via Actions → Run workflow and read the summary before proceeding.
2. **Rebuild pointing at the standby:**
   `VITE_SUPABASE_URL=<standby REST URL> VITE_SUPABASE_ANON_KEY=<standby anon key> npm run build`
   The build pins the standby's address into the Content-Security-
   Policy automatically (vite.config.js substitutes it) — no file
   edits, which is also why the failover build cannot accidentally
   keep talking to the dead primary.
3. **Push / redeploy.** Commit the env change to `main`; all host
   mirrors rebuild within minutes (redundancy.md). If you cannot
   push, upload `dist/` to any one mirror by hand — one working link
   is enough to reopen.
4. **Sign in normally.** With auth sync on, the shop's real logins
   (including the master account with its real password, not the
   factory one) work as-is. If a login fails, fall back to
   redundancy.md's path: the factory `admin` / `admin123` + Restore
   from the latest in-app backup file.
5. **Make one test sale and refund it.** Check History and Reports —
   the mesh's row counts said the data was there; this proves the
   till agrees.
6. **Tell staff**: same link, same usernames; sign in again once.
7. **Stop the hourly job from overwriting your new live database**:
   the job still copies OLD primary → standby, and the standby is
   now the live one. Disable the workflow (Actions → db-sync → ⋯ →
   Disable workflow) until switch-back. *This step is easy to forget
   and is the one that matters most.*

### Switch-back (when the old primary is healthy again)

1. Run one manual sync in the *reverse* direction (swap the env
   values locally and run `sync.mjs --mode seed --live`, or export a
   fresh in-app backup from the standby and Restore it on the
   primary — the backup route needs no secret juggling).
2. Rebuild with the primary's env values, redeploy, test-sale again.
3. Re-enable the hourly workflow. The standby returns to its one
   job: being the copy.

## How much data could be lost? (manual-ready honesty)

> **EN —** Your shop's information is copied to a second, separate
> system every hour. If the main system ever fails, we switch
> everyone to the copy. The copy is at most one hour behind, so
> sales from the last hour might need to be typed in again from
> receipts — nothing older can be lost this way. What this does not
> do: it does not let two systems take sales at the same time (they
> would disagree about stock and totals, and no free service can
> keep them in agreement), and it does not switch by itself — a
> person follows a short checklist, about ten minutes, and checks
> the numbers before reopening.
>
> **FR —** Les informations de votre boutique sont copiées chaque
> heure vers un deuxième système, séparé du premier. Si le système
> principal tombe en panne, tout le monde passe à la copie. La copie
> a au plus une heure de retard : les ventes de la dernière heure
> pourraient devoir être retapées à partir des reçus — rien de plus
> ancien ne peut être perdu de cette façon. Ce que ceci ne fait pas :
> cela ne permet pas à deux systèmes de prendre des ventes en même
> temps (ils ne s'entendraient pas sur les stocks et les totaux, et
> aucun service gratuit ne peut les garder d'accord), et le passage
> ne se fait pas tout seul — une personne suit une courte liste de
> vérifications, environ dix minutes, et contrôle les chiffres avant
> de rouvrir.

(RPO in one line: **≤ 1 hour** — the sync interval. Tightening it
means a more frequent cron, which is free on a public repo; hourly
is the chosen balance against failure-email noise.)

## Costs and limits ($0, rechecked)

- Second Supabase project: free tier (500 MB DB) — same as primary.
- GitHub Actions: the hourly job runs ~1–2 minutes → roughly
  1,500 min/month. Free **and unlimited on public repos** (this repo
  is public). If the repo ever goes private, that is ~¾ of the
  2,000 free minutes — change the cron to every 3 hours then.
- PostgreSQL client tools: installed by the workflow on its runner;
  version note — if `pg_dump` ever complains about a server newer
  than itself, pin the matching client via the PGDG apt repo in the
  workflow's install step.
- No automatic failover at $0 (same conclusion as redundancy.md):
  a static page cannot retarget its own database; the switch is a
  rebuild + redeploy. Managed DNS health checks could automate the
  *link*, but the app would still need a rebuild to change databases,
  so honest-manual is the right design at this price.
- Sync runs while shops are selling: the dump is consistent
  (pg_dump reads one snapshot), the standby load is brief, and the
  verify tolerance (5 rows/table) absorbs sales written mid-copy.
  The standby is never read by the app outside a failover, so the
  copy process cannot slow a till down.

## Security notes

- `service_role` keys and database passwords live ONLY in GitHub
  Actions secrets / the owner's shell — never in the repo. The tools
  redact connection strings in every printed command (check any dry
  run: passwords show as `***`).
- `restore.mjs` can only write to `STANDBY_DB_URL`; there is no flag
  that points it at the primary. The worst a mis-run can do is
  overwrite the copy — never the live data.
- Dump files contain the entire database. The job deletes its temp
  copy; `--keep-dump` is for local debugging only — treat that file
  like the backup files the manual already warns about.

## What stays manual / owner-gated

- Creating the standby project and adding the 8 secrets (one-time,
  ~15 minutes, steps above). Agents do not create accounts.
- Pressing the failover buttons (by design — a human confirms the
  primary is really down and the counts are green first).
- `seed` re-runs after schema changes (the verify step refuses to
  stay silent about drift — a missing table fails the run).
