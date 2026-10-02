# SEO & positioning — Vendra

Status: shipped with the `ds-seo` change (landing pages, sitemap, robots, storefront meta/JSON-LD, generator + tests). Owner decisions still open are in §10 — nothing in this doc or on the landing pages goes around them.

Read with: `docs/research/keywords-raw.md` (SERP evidence, 2026-10-01), `docs/research/competitors-raw.md` (vendor-verified prices, 2026-10-01), `docs/marketing-ops.md` (the $0 launch plan this feeds).

## 1. What shipped

| Piece | Where | Notes |
|---|---|---|
| Static landing pages, EN/FR/ES/PT | `landing/src/{en,fr,es,pt}.html` → built to `dist/landing/` | Hand-written HTML, no JS, system fonts. Screenshot figures are labelled placeholders until the final-UI screenshot pass. |
| Generator | `scripts/build-landing.mjs` | Runs after `vite build` (`npm run build`). Fails the build on unreplaced tokens or unparseable JSON-LD. |
| Config | `landing/landing.config.json` | `siteOrigin`, `basePath`, `appHref`, `demoSlug`, per-language paths. Brand name is read from `src/lib/brand.js`, so the approved rename flips the landing automatically. |
| Sitemap | `dist/sitemap.xml` | All 4 languages with hreflang alternates (`xhtml:link`), generated — never hand-edited. |
| Robots | `dist/robots.txt` | `Allow: /` + sitemap pointer. |
| Storefront meta + JSON-LD | `src/lib/storefrontSeo.js`, applied in `src/apps/StorefrontPublic.jsx` | Title, description, OG/Twitter, canonical, `Store` JSON-LD once shop data loads; all injected nodes removed on unmount. |
| Storefront semantics | `StorefrontPublic.jsx` | Product grid is now `<ul>/<li>`, section headings are `<h2>`, about/products sections carry aria-labels. Visual output unchanged. |
| Tests | `test/landing.test.mjs`, `test/storefront-seo.test.mjs` | Generator output, schema honesty (no invented prices/ratings), token safety. |

The SPA build is untouched by the generator: it only *adds* files after Vite finishes, so the app, the `#/store/<slug>` flow, and `public/404.html` redirect handling behave exactly as before.

## 2. Serving model (root index vs app entry)

The app is a client-rendered SPA served from a sub-path today (`/drift-shop/` on GitHub Pages). Crawlers reading the app entry see an empty shell — that is precisely why the landing exists as separate static files.

- **Today (GitHub Pages project site):** the build emits landing pages at `/drift-shop/landing/`, `/drift-shop/landing/fr/` etc., `sitemap.xml` and `robots.txt` at `/drift-shop/`. The landing links into the app with a relative `appHref: "../"` and to the demo shop at `../#/store/demo-cafe`. Nothing about the SPA's own URLs changes.
- **At the brand domain (when the owner registers one):** promote `dist/landing/*` to the domain root and serve the app under `/app/` (or keep the app at its existing path and point `appHref` there). Set `siteOrigin` + `basePath` in `landing.config.json` and rebuild — canonical URLs, hreflang, sitemap and robots all regenerate from those two values. One config change, no template edits.
- Until the domain exists, canonical/sitemap URLs carry the placeholder origin `https://YOUR-SHOP-DOMAIN.example` from the config. **Search Console submission waits for the real domain** — submitting a sitemap full of placeholder URLs would be worse than not submitting.

## 3. Competitor landscape (verified 2026-10-01)

Full sourcing in `docs/research/competitors-raw.md`. USD, per location unless noted. "Vendor" = the company's own page; "secondary" = consistent reputable coverage.

| | Square | Shopify POS | Lightspeed Retail (R) | Clover | **Vendra** |
|---|---|---|---|---|---|
| Entry price | $0 free tier (vendor) | $39/mo ($29 annual) + POS Lite included (vendor) | "from $89/mo" (vendor); tiers $89/$149/$289 annual (secondary) | Bundles from $16/mo × 36 mo (vendor) | **30 days free, then one unlock key — price owner's to set** |
| Paid tiers | Plus $49, Premium $149 /mo/location (vendor) | POS Pro +$89/mo/location (vendor) | Core $179, Plus $339 monthly (secondary) | Software continues monthly even with hardware bought upfront (vendor) | No tiers, no per-location or per-register rent |
| Buy-once license | No | No | No | No | **Yes — the unlock key** |
| In-person card rate | 2.6%+15¢ (Free) → 2.4%+15¢ (Premium) (vendor) | 2.6%+10¢ (Basic) → 2.4%+10¢ (Advanced) (vendor) | 2.6%+10¢ (secondary) | 2.6%+10¢ Basic; 2.3%+10¢ up (vendor) | No built-in processing today (see §6) |
| Own processor | Not listed as an option (vendor page silent) | Allowed with 2%/1%/0.6% surcharge (vendor) | Allowed with a reported $200+/mo fee (secondary) | Not at published direct rates | Shops keep their own merchant account — funds never pass through us |
| Hardware | BYOD + optional Square kit | BYOD + Shopify kit | BYOD iPad/Android | **Proprietary only** | Any phone/tablet/computer with a browser |
| EN/FR/ES/PT UI | EN/FR/ES; PT not listed (secondary) | **All four incl. PT-BR (vendor)** | EN/FR/ES; PT not listed (secondary) | Unverified | **All four** |
| Offline card sales | Yes, with 24h/72h limits and seller liability (vendor) | Yes if pre-activated, capped (vendor) | Basic sales only (secondary) | Yes, queue-and-sync (secondary) | **No — cloud-only, stated plainly everywhere** |

Where rivals genuinely beat us today (say so when asked, never paper over):

- **Integrated card processing.** Square/Shopify/Lightspeed/Clover process cards natively; we record sales and the shop uses its own reader/merchant account. Integrated processing (Stripe Connect / Square-class, shops' own accounts) is roadmap, and every public page says "planned, not yet available."
- **Offline selling.** They queue sales offline (with real limits and decline risk, per their own docs); we cannot sell offline at all. We don't chase "offline POS" keywords (§5) and the FAQ answers this head-on.
- **Depth for complex retail.** Lightspeed's matrix SKUs, purchase orders, vendor catalogs; Shopify's omnichannel/1,000-location machinery. Our presets cover the five shop types a small shop actually runs; certified fuel-pump control is out of scope, and we don't claim otherwise.
- **Fiscal certification.** NF525/LNE (FR), CFDI (ES-MX), NFC-e (PT-BR) are bought-and-searched features we do not have. The FR/ES/PT landing FAQs state this in the open — a shop legally needing certified fiscal invoicing needs it, and hiding that would poison trust and returns alike.

## 4. Positioning map

The owner's mandate: show up as *"the most flexible and user-friendly platform"*, best value, vs the Square/Lightspeed/Shopify class. Superlatives we can't evidence stay off public copy; instead each pillar is written as a checkable fact.

| Pillar | What we say (evidence-framed) | Evidence today | Where it shows |
|---|---|---|---|
| **Flexibility** | "One app for your whole shop" — till, stock, customers, gift cards, appointments, reports, team, files, and a public web page; five shop-type presets (general, retail, restaurant/food, services, convenience) that re-shape the screens without touching data. | Module set + `businessPresets` shipped; presets are non-destructive and reversible. Gaps (tips, tables/kitchen, age checks, deposits) documented in §3 — never claimed. | Landing hero + features; keyword clusters "one app / todo en uno / tout-en-un" |
| **Beginner-easy** | "Made to be easy" — plain-language labels, big optional touch mode, step-by-step picture manual, honest error cards instead of blank pages, forced first-login password change. | Manual (25 pp EN/FR, screenshot pass pending final UI), boot self-check cards, beginner-proofing pass across UI. | Landing "How it works"; manual; demo shop |
| **Best value** | "One unlock, no monthly software bill" — 30 full days free; then a single unlock key; locked shops keep their data forever and can always download it. The comparison table puts our model next to sourced monthly rents. | Licensing model built (trial → soft-lock → serial unlock; backup available while locked). **Unlock price unset — see §10.** | Landing price section; cost-content pieces (marketing-ops §7) |

Tone note: the copy never calls rivals bad. It puts prices and models side by side (sourced, dated, "check before you decide") and lets arithmetic argue. "Blow everybody out of the water" happens through the math and the honesty, not adjectives.

## 5. Keyword clusters (from `docs/research/keywords-raw.md`)

No volume numbers exist at $0 tooling; signals are SERP composition and buyer phrasing, quoted in the research file. Category words differ per language — never translate literally.

| Language | Head terms (target) | Intent phrases to answer | Notes |
|---|---|---|---|
| EN | "free POS software", "POS system for small business", "no monthly fee POS" | "best free POS software for small businesses", "how much does a POS system cost", "pay once / no subscription" (visible in the Etsy-style long tail) | "Best…" page 1 is 5 affiliate listicles — directory listings (Capterra/G2) + listicle outreach matter more than out-writing them. "Shop management software" is an auto-repair SERP — do not target. |
| FR | "logiciel de caisse", "logiciel point de vente (PDV)", "caisse enregistreuse gratuite" | "combien coûte un logiciel de point de vente ?" (ranks with no good answer — content gap we fill), "version gratuite sans limite de temps", "gratuit et sans engagement" | Fiscal riders (NF525) accompany "gratuit" everywhere — our FAQ handles it honestly instead of implying certification. "Logiciel gestion magasin" is a B2B-quote SERP (HelloPro/Techni-Contact) — different intent, directory play only. |
| ES (neutral LatAm) | "software / sistema punto de venta gratis", "punto de venta para [vertical]" (cafés, kioscos, bodegas, minimarket) | "punto de venta abarrotes", "cómo elegir un punto de venta gratis", "plan gratuito de por vida" | Page 1 is Google Play + YouTube: Spanish demo video is a ranking asset, not garnish. Bare "programa para tiendas" means government programs — never use. "TPV" is Spain-ambiguous (bank terminals) — qualify with "software". |
| PT-BR | "sistema de gestão / ERP para lojas" (head frame), "PDV grátis", "frente de caixa grátis/gratuita" | "sistema PDV gratuito", "frente de caixa para loja" | PT buyers frame the category as gestão/ERP with PDV as a module — landing PT copy follows this. The bottom-of-market rival is an Excel spreadsheet; beginner messaging wins there. |

Deliberately **not** targeted: "offline POS / hors ligne / fuera de línea / sem conexão" clusters (we are cloud-only), fiscal-certification terms as features (NF525/CFDI/NFC-e — FAQ honesty only), pump/fuel-control terms (out of scope), and any "free POS" framing that implies the product is free forever — "free" attaches to the 30-day trial only.

## 6. The SPA / storefront SEO reality (honest scope)

What a crawler sees today:

- **Landing pages** — fully crawlable static HTML with schema. This is the product's search face, and it is complete as shipped.
- **Shop storefront pages** (`#/store/<slug>`, also the per-shop subdomain/custom-domain direction) — client-rendered behind a hash route. JS-executing crawlers (Google) can render them; most social/messaging preview bots do not run JS, and **the hash fragment is never sent to a server**, so per-shop server-side meta is impossible at this URL shape. What we do client-side after data loads: real `<title>`, meta description from the shop's own tagline/about, OG/Twitter cards, canonical, and `Store` JSON-LD (name, description, email, phone, address, socials, product names). That fixes tab titles, JS-crawler indexing, and any preview path that does execute JS.
- What client-side meta **cannot** fix: link previews in WhatsApp/Facebook/iMessage for shop pages (those bots fetch the raw SPA shell), and any crawler without JS. We do not claim otherwise anywhere.

Mitigation ladder, in order of $0 feasibility:

1. **Shipped:** landing as the canonical brand home; storefront client-side meta/JSON-LD; semantic markup; sitemap covering the 4 landing languages.
2. **Next, when the per-shop domain work lands (`ds-domains`):** path-based shop URLs (`<shop>.<domain>` root) still serve the same SPA — previews remain shell-limited, but URLs become shareable and brandable. Google indexing improves via rendering; preview bots still see the shell.
3. **Later (needs a build step, still $0):** per-shop **pre-rendered preview snapshots** — at publish time, generate a static HTML snapshot per published shop (name, tagline, products, JSON-LD, OG) served at a stable path, with the live page one tap away. This is the first rung that actually fixes social previews. Static hosts (GitHub Pages/Cloudflare Pages) can serve generated files with zero runtime. Track as a follow-up build task; do not promise a date publicly.
4. **Redirect/edge options** (Cloudflare Workers-class) only become available with the custom domain; evaluate then, not before.

Structured-data honesty in the store JSON-LD (`src/lib/storefrontSeo.js`): products are listed by **name only** (the RPC returns no currency, so an `Offer` would invent it); hours stay out (free text can't become `openingHoursSpecification` truthfully); no ratings/reviews/price ranges are emitted, ever. If the RPC later exposes currency and structured hours, offers can be added then.

## 7. Copy rules (binding on landing, directories, content)

- Plain language first; every pillar claim framed as a checkable fact (feature that ships, price dated and sourced, model explained).
- "Free" = the 30-day trial, always with the model next to it. Never "free POS" standing alone for the product.
- No invented price: the token `{{UNLOCK_PRICE_LINE}}` renders "one unlock key — and no monthly software bill, ever" (+ translations) until the owner sets the price (§10). The SoftwareApplication JSON-LD deliberately carries **no `offers` node** until then.
- No fake reviews, ratings, user counts, awards; no superlatives ("best", "#1", "most") as bare claims; rival names only in the sourced comparison context with the "not connected with" footer note.
- Roadmap items (integrated card processing, preset gaps, snapshot previews) are labelled "planned, not yet available" wherever mentioned — or not mentioned.
- Competitor prices carry "from each company's own website, October 2026 — they can change" and are re-verified monthly (marketing-ops §10).

## 8. Owner decisions needed (SEO/positioning subset)

1. **Unlock price.** Once set: fill the landing token (`UNLOCK_PRICE_LINE` values in `scripts/build-landing.mjs`), add `offers` to the SoftwareApplication JSON-LD, and set directory pricing fields. Until then every surface uses the no-monthly-bill framing.
2. **Canonical domain.** `landing.config.json` `siteOrigin`/`basePath` placeholders must become real before Search Console submission and before directory listings link anywhere. (Domain choice itself rides the address/email stack already researched; `vendra.us.kg` pending registration and trademark check by the rebrand workstream.)
3. **Demo shop.** Landing links to `#/store/demo-cafe` (config `demoSlug`). The demo shop must exist and be stocked (marketing-ops §3) before launch traffic arrives, or the "See a demo shop page" button 404s into the honest missing-page state.
4. **Brand flip.** Landing templates follow `src/lib/brand.js` automatically; the day `name` becomes "Vendra" there, the landing, titles and schema follow with one rebuild.

## 9. Merge & release notes

- Files in this change: `landing/`, `scripts/build-landing.mjs`, `test/landing.test.mjs`, `test/storefront-seo.test.mjs`, `src/lib/storefrontSeo.js`, plus surgical edits to `src/apps/StorefrontPublic.jsx` and `package.json` (build script). No `index.html`, `brand.js`, migration, or LFDD changes — nothing here should conflict with the rebrand, domains, or i18n branches.
- **Known stale item for the coordinator (not fixed here to avoid colliding with the rebrand):** `index.html`'s meta description still says "works offline" — false since the cloud-only decision — and its `<title>`/description are the pre-rename product copy. One-line fix at merge/rebrand time.
- The app CSP (`script-src 'self'`) is respected: all JSON-LD (landing is static HTML outside the SPA shell; storefront blocks are created via DOM APIs from module code), no inline app scripts added.
- Build gate: `npm run build` now runs the landing generator after Vite; a broken template (bad token, bad JSON-LD) fails the build loudly instead of shipping a broken page. Supabase env vars are still required for a real bundle (see AGENTS.md hollow-stub warning).

## 10. Sources

All accessed 2026-10-01. Verbatim URLs in `docs/research/competitors-raw.md` (Square/Shopify/Lightspeed/Clover: vendor pricing, product, support and help pages; secondary corroboration from TechRepublic, FitSmallBusiness, NerdWallet, G2 directory data) and `docs/research/keywords-raw.md` (page-1 SERP scrapes, 15 queries across EN/FR/ES/PT, with result composition and buyer phrasing). Marketing channel sources (Product Hunt rules, Capterra/G2 syndication and its February 2026 ownership change, Umami/Plausible/Clarity free tiers, Reddit rule datasets, Search Console/Bing) are listed at the foot of `docs/marketing-ops.md` and must be re-verified at execution time, per the monthly claims audit there.
