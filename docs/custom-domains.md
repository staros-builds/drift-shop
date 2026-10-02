# Per-shop nice URLs — research, architecture, and setup

Every shop gets a real web address of its own. Two tiers, both serving the
same public storefront page from the same database:

1. **Automatic subdomain** — `<shop-name>.<product-domain>` (e.g.
   `mariebakery.<product>.us.kg`). Zero setup for the shop: the address
   exists the moment they pick their storefront name and publish.
2. **Their own domain** — the buyer already bought a domain (e.g.
   `mymarieshop.ca`) and points it at us with one CNAME record. The shop's
   page answers on that domain too.

This doc records what each free host can and cannot do (verified against
vendor docs, October 2026), the DNS architecture that makes tier 1 work
with no per-shop effort, and the exact setup steps — operator side
(one-time) and buyer side (beginner words, ready to paste into the manual).

---

## Research verdict — can each host serve `*.<apex>`?

### Cloudflare Pages — NO wildcard custom domains; YES per-hostname

Cloudflare's own known-issues page: *"It is currently not possible to add
a custom domain with a wildcard, for example, `*.domain.com`."*
(https://github.com/maxmood96/cloudflare-docs/blob/HEAD/src/content/docs/pages/platform/known-issues.mdx)

Each hostname must be attached to the Pages project individually
(dashboard or API). Free-plan limit: **100 custom domains per project**
(https://developers.cloudflare.com/pages/platform/limits/). So Pages
alone cannot do tier 1 — every shop subdomain would be a manual
dashboard action. Pages CAN, however, be the origin behind the wildcard.

### Cloudflare Workers — YES wildcards (routes), fronts the origin

Worker **routes** accept wildcard patterns (`*.<apex>/*`); a tiny Worker
fetches the Pages origin and returns its bytes. The browser still sees
`<shop>.<apex>` in the address bar, and the app reads
`window.location.hostname` client-side — which is all the app needs.
The Worker code now lives in `cloudflare/front-door-worker.js` (with
`cloudflare/wrangler.example.toml`); it is implemented and unit-tested
locally, but not deployed until the apex and Cloudflare account exist.
It retries only idempotent GET/HEAD requests on network failure or 5xx,
never retries 4xx as another origin, and never retries a POST.
(Worker *custom domains* are exact-hostname only; routes are the wildcard
mechanism: https://github.com/sagargupta16/deploy-guide/blob/HEAD/guides/cloudflare-workers.md)

Free quotas that matter: 100,000 Worker requests/day
(https://github.com/sodeom/sodeom/blob/HEAD/CLOUDFLARE_WORKER_SETUP.md),
and free Universal SSL covers exactly one subdomain level
(`*.<apex>` covers `<shop>.<apex>`; deeper names are not covered:
https://github.com/anothersava/claude-code-common/blob/HEAD/claude/learnings/cloudflare-workers-push-to-a-pulling-app.md).
One level is precisely our shape.

### GitHub Pages — NO (single custom domain per site)

A GitHub Pages site takes ONE custom domain (the CNAME file); there is
no wildcard serving for project sites, and GitHub explicitly warns
against wildcard DNS pointed at Pages because anyone could then host a
site at one of your subdomains
(https://github.com/fulldecent/blog.phor.net/blob/HEAD/source/_posts/2021-05-01-github-pages-wildcard-vulnerability.md,
quoting GitHub's docs). Verdict: GitHub Pages stays a build mirror; it
cannot front the nice-URL story.

### Cloudflare for SaaS — the scale path for buyer domains

For tier 2 at scale, Cloudflare for SaaS registers each buyer hostname
via API against a fallback origin: **first 100 custom hostnames included
on the free plan**, then $0.10/hostname/month
(https://github.com/madfam-org/enclii/blob/HEAD/docs/infrastructure/CLOUDFLARE.md;
price snapshot via https://github.com/custom-domain-app/awesome-custom-domains).
Launch does not need it: attaching each buyer domain as an exact Pages
custom domain (above) is free within the same 100-per-project budget.
For-SaaS is the documented upgrade path when buyer domains outgrow it —
operator work, invisible to buyers.

**Bottom line:** the nice-URL front door is Cloudflare (zone + wildcard
route + Worker in front of Pages). GitHub Pages and Netlify mirrors keep
serving the app at their own addresses; shops' addresses live on the
apex, which only the Cloudflare front serves.

---

## Architecture

```
 mariebakery.<apex> ──► Cloudflare DNS  *.<apex>  (proxied)
                            │
                            ▼
                    Worker route  *.<apex>/*
                    (fetch Pages origin, return bytes)
                            │
                            ▼
                    Cloudflare Pages  <project>.pages.dev
                    (same build as every mirror)
                            │
        app boots, reads window.location.hostname
        resolveHostname() → { storefront, slug: "mariebakery" }
        public_storefront(slug) RPC ──► Supabase (published shops only)
```

- **The apex itself** (`<apex>`, `www.<apex>`) boots the normal app
  (sign-in, POS, admin).
- **A shop subdomain** renders that slug's storefront directly. Unknown
  or unpublished names get the friendly "no shop page at this address"
  page — served by the app, in beginner words, EN/FR.
- **Deeper names** (`blog.mariebakery.<apex>`) are never shops (and the
  one-level wildcard certificate wouldn't cover them anyway): friendly
  dead-end page, no lookup.
- **A buyer's own domain** is answered by the same Cloudflare front (see
  below); the app asks `public_storefront_by_host(hostname)` which
  published shop owns it, and renders that storefront. The first real
  serve stamps `custom_domains.verified_at` — that stamp is what turns
  the admin's "Not live yet" into "Working", so the status can never lie.

### One-time operator setup (per product, never per shop)

1. Put the apex domain's DNS on Cloudflare (NS delegation) — needed for
   the wildcard route and the free wildcard certificate.
2. Cloudflare Pages project serving this repo's build. **Build with
   `vite build --base=/`** for the domain-fronted deployment: the
   `/drift-shop/` base path exists for the GitHub Pages project site,
   and asset URLs must sit at the domain root instead.
3. DNS: proxied wildcard record `*` → the Pages hostname, plus the Worker
   in `cloudflare/front-door-worker.js` deployed with route `*.<apex>/*`
   fetching the Pages origin (and the apex routed to the same origin).
   Copy `cloudflare/wrangler.example.toml` to `wrangler.toml` and set
   `ORIGIN_HOST` to the Pages hostname. Set `BRAND.apexDomain` and
   `BRAND.hostCnameTarget` (the Pages hostname buyers point CNAMEs at),
   rebuild, redeploy.
4. That's it. Every future shop subdomain works with zero further setup.

### Buyer-owned domains (per domain, minutes)

1. Buyer registers the name in Admin → Storefront → "Your web
   addresses" (stored in `custom_domains`).
2. Buyer adds one CNAME record at their registrar:
   `their-domain` → `BRAND.hostCnameTarget`. (For a `www.` name they add
   the record for `www`; the app treats each hostname separately.)
3. Operator (or, later, the for-SaaS automation) attaches the exact
   hostname to the Pages project so Cloudflare provisions its
   certificate — free, within the 100-per-project budget.
4. DNS propagates, the certificate issues, the first visitor's load
   stamps `verified_at`, and the admin screen flips to "Working" on its
   own. Typical wait: minutes to an hour.

## Security posture

- The hostname only ever chooses which **public** page to render. The
  storefront RPCs re-check publication server-side; there is no anon
  table access, and nothing about a hostname can sign anyone in, open
  the admin, or elevate a session. Arriving on a shop address shows the
  shop's public page, full stop.
- Slug rules are the database's own (`^[a-z0-9][a-z0-9-]{0,62}$`,
  migration 063), mirrored exactly in the client resolver and tested
  against adversarial hosts (ports, case, trailing dots, lookalike
  domains, deep subdomains).
- `custom_domains` writes follow the owner/manager + master RLS pattern;
  the public lookup is a SECURITY DEFINER RPC that returns only a slug
  and only for published storefronts.
- Factory reset wipes `custom_domains` with everything else (draft
  migration 078 carries the final wipe list).

## Honest limits

- **HTTPS on a brand-new buyer domain takes a few minutes** (certificate
  provisioning). Automatic subdomains are instant (wildcard
  certificate). The admin screen's waiting state exists for exactly this.
- **One level only.** `<shop>.<apex>` — no `blog.<shop>.<apex>`. By
  design, and by the free certificate's shape.
- **Wildcard DNS is a loaded tool on GitHub Pages** (anyone-can-host
  risk), which is why the apex lives on Cloudflare and Pages never sees
  the wildcard.
- **100 free hostnames per Pages project** bounds tier 2 at launch;
  Cloudflare for SaaS is the documented next rung (first 100 there are
  free too) — still $0 until roughly a hundred buyer domains.
- **The apex is a product decision.** `BRAND.apexDomain` stays empty
  until the owner picks the product name/domain; with it empty, tier 1
  is off and the hash links + tier 2 still work.
- If the apex DNS ever leaves Cloudflare, tier 1 addresses stop
  resolving. The hash link (`<app>/#/store/<slug>`) always keeps working.

---

## For the manual — buyer steps (EN / FR, screenshots to follow)

**EN — Your free address.** Your shop already has a web address: it is
your shop name followed by the product's address (for example
`mariebakery.example.com`). You will find it in Admin → Storefront →
"Your web addresses". It works right away — put it on your signs,
receipts and social media. Nothing to set up.

**EN — Use your own domain name.** If you bought your own domain name
(like `mymarieshop.ca`): 1) In Admin → Storefront → "Your web
addresses", type the name and press "Connect this domain". 2) Go to the
website where you bought the domain and add one line: a CNAME record
pointing to the address shown on that screen. 3) Wait a little — usually
under an hour. The same screen will say "Working" by itself when your
address is live.

**FR — Votre adresse gratuite.** Votre commerce a déjà une adresse web :
c’est le nom de votre boutique suivi de l’adresse du produit (par
exemple `mariebakery.example.com`). Vous la trouverez dans Admin →
Vitrine → « Vos adresses web ». Elle fonctionne tout de suite — mettez-la
sur vos affiches, vos reçus et vos réseaux sociaux. Rien à installer.

**FR — Utiliser votre propre nom de domaine.** Si vous avez acheté votre
propre nom de domaine (comme `maboulangerie.ca`) : 1) Dans Admin →
Vitrine → « Vos adresses web », écrivez le nom et appuyez sur « Brancher
ce domaine ». 2) Allez sur le site où vous avez acheté le domaine et
ajoutez une seule ligne : un enregistrement CNAME qui pointe vers
l’adresse affichée à cet écran. 3) Attendez un peu — habituellement moins
d’une heure. Le même écran dira « Fonctionne » tout seul quand votre
adresse sera en ligne.
