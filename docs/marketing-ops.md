# Marketing operations — the $0 launch and growth plan

Who runs this: Cooper, end to end, under Jesse's approvals (claims, price, big moves — see §9). Budget: $0. Everything below uses free tiers and free channels only; anything that costs money is named and **skipped**, not quietly assumed.

State of play at handoff: the landing page (EN/FR/ES/PT), `sitemap.xml`, and `robots.txt` ship with the SEO build. No marketing accounts exist yet. The account-creation step (§2) is gated on Jesse re-providing the project password through the Secure Vault — nothing here starts until that gate clears.

Honesty rules binding on every item in this plan:

- **No fake reviews, ratings, testimonials, user counts, or awards. Ever.** Every review on every platform must come from a real user who used the product. Where a platform allows incentivized reviews, we still don't incentivize undisclosed — asks are plain: "if it helped your shop, a review helps us."
- **No invented price.** The unlock price is Jesse's call. Until he sets it, copy says "one unlock key, no monthly software bill" or carries the `[PRICE]` placeholder. The word "free" describes the 30-day trial only, never the whole product.
- **Claims only what ships today** (see `docs/seo-positioning.md` for the verified feature list and the gap list). Roadmap items — integrated card processing above all — are labelled "planned, not yet available" wherever they appear.
- **No astroturfing, no bought links, no upvote rings, no alt accounts posing as customers.** If a channel's rules forbid something, we don't do it, even slowly.
- Shop pages and shop data are never used in marketing without that shop owner's written say-so. No real shop appears in a screenshot or demo without permission.

---

## 1. Channels at a glance

| Channel | Cost | Why | Status at handoff |
|---|---|---|---|
| Landing page + Search Console + Bing Webmaster Tools | $0 | The front door; the only owned surface search engines can fully read | Ships with this build; submit at account step |
| Capterra / GetApp / Software Advice (one Gartner Digital Markets profile) | $0 basic listing | The exact directories ranking on page 1 for our buyer queries in EN and FR | Not created — account step |
| G2 free profile | $0 | Second directory network; buyers cross-check | Not created — account step |
| AlternativeTo, SaaSHub, SourceForge | $0 | "Square alternative" listing pages capture switching intent | Not created — account step |
| Product Hunt | $0 | Launch-day spike + a durable listing page | Not created — account step |
| Reddit (value-first participation) | $0 | Shop owners ask "what POS should I use" here weekly | No account yet; rules vary per subreddit — see §5 |
| Facebook groups (shop-owner communities) | $0 | Where a large share of small-shop owners actually talk shop | Requires joining with a real account; rules per group |
| YouTube | $0 | "How to" videos rank for years (already in FR/ES SERPs) | Not created — account step |
| TikTok / Instagram Reels | $0 | Short shop-tip clips; same footage as YouTube Shorts | Not created — account step |
| LinkedIn company page | $0 | Trust anchor; directory listings and buyers check it exists | Not created — account step |
| Umami Cloud (free tier) + Microsoft Clarity | $0 | Landing analytics and heatmaps that respect the $0 rule | Not created — account step |

Not on the list, deliberately: paid ads anywhere, sponsored directory placement, SEO agencies, link brokers, "PR" distribution services, influencer fees. All cost money or credibility we don't have.

## 2. Account creation (one sitting, after the password gate)

Created under Jesse's or Cooper's project email, the same window as the infrastructure accounts (Cloudflare, Netlify, standby Supabase, domain, mail). One password manager entry per service, captured through the Secure Vault — never in chat, never in files.

1. **Google account touchpoints:** Search Console (verify the domain property), YouTube channel ("Vendra" — name, handle, and banner from the brand kit once the rename lands), Google Business-style assets are *not* applicable (we're software, not a local shop).
2. **Bing Webmaster Tools** — one-click import from Search Console.
3. **Gartner Digital Markets vendor profile** (capterra.com/vendors) — one profile syndicates to Capterra, GetApp, and Software Advice. ⚠️ Ownership changed hands in 2026 (G2 acquired the three properties from Gartner in February 2026) — re-verify the syndication and signup route at execution time before assuming one form covers all three.
4. **G2** free product profile. Skip every paid tier (badges start around thousands per year).
5. **Product Hunt** personal account (company accounts aren't allowed; the launch runs from a personal profile). Start following makers and commenting genuinely for a few weeks before launch day — a day-one account that only self-promotes is visible and ineffective.
6. **Reddit** account — aged through genuine participation (§5) well before any product mention.
7. **Umami Cloud** free (Hobby) tier property for the landing site; **Microsoft Clarity** project for heatmaps/session replay on the landing pages only (never inside shops' data — the app is not instrumented with third-party analytics).
8. **LinkedIn** company page; **TikTok** and **Instagram** brand accounts; **Facebook Page** ("Vendra") — needed because group participation and the Page reinforce each other, and buyers look for a pulse.

Record nothing but service + username in the project tracker. Passwords and recovery codes live only in the vault.

## 3. The demo shop — our best salesperson

Before launch day, build one fully stocked **demo shop** visitors can look at without signing up: a fictional café ("Café Démo / Demo Café") with ~20 products, prices, opening hours, and its public shop page published. It proves the three pillars in 30 seconds: one app does the till, the stock, and the web page; a beginner can read every label; there is no monthly bill hanging over it.

Rules for the demo: fictional name, fictional products, no real person's data. The landing page links to it ("See a real shop page"). Reset it to a clean state whenever QA or walkthroughs dirty it, using the same backup-restore flow buyers get — which itself becomes a quiet proof point.

## 4. Directory listings (week 1–2 after accounts)

Submit in this order; each listing reuses the same vetted copy block (what it is / who it's for / pricing model stated honestly / screenshots from the final UI).

1. **Capterra network** (Capterra + GetApp + Software Advice): category "Point of Sale". Pricing field: free trial 30 days, then one-time unlock — if the form forces a monthly figure, list the trial truthfully and put the model in the description; never enter a fake monthly price. Expect a review/verification queue — submit first because it's slowest.
2. **G2**: same copy; claim the profile, add screenshots, link the website. No paid badges.
3. **AlternativeTo**: list as an alternative to Square, Lightspeed, Shopify POS, Loyverse — this is where "no monthly fee POS" switchers browse.
4. **SaaSHub** and **SourceForge**: quick submissions, same assets.
5. **FR B2B surfaces** (from the keyword research): HelloPro and Techni-Contact own "logiciel gestion magasin"; ChoisirPro ranks for "caisse enregistreuse gratuite". These are lead-gen marketplaces — read their terms at submission; if a free listing requires a devis/quote flow we can't fulfil honestly, skip and note why.
6. **PT surface**: Doutor Balança (drbalanca.com.br) ranks "PDV grátis" category pages — submit the PT listing there.
7. **Listicle outreach (earned, not bought):** FitSmallBusiness, TechnologyAdvice, TechRepublic, independant.io (FR) run the "best POS" roundups that own EN/FR page 1. Send a short, factual pitch: what it is, the pricing model, a demo link, screenshots. No payment for placement, ever; if a roundup is pay-to-play on inspection, walk away and note it.

After approval: keep listings current at every release (features, screenshots, languages). A stale listing with old screenshots quietly tells buyers the product is abandoned.

## 5. Community playbook (Reddit, Facebook groups, forums)

The rule everywhere: **be a helpful member first; the product earns mentions, it doesn't plant them.** Ratio target: at least 9 genuinely helpful contributions for every 1 mention of Vendra, and every mention discloses "I built this" in the first lines.

**Where (verify each community's rules in its sidebar/about before posting anything — rules change and several restrict promotion):**

- **r/smallbusiness** (~2.5M members): self-promotion stance is not spelled out in the rule datasets we checked — read the sidebar at execution; participate in "what tools do you use" threads with disclosure.
- **r/SideProject** (~800k): explicitly welcomes project posts — the right home for a launch post ("I built a POS with no monthly fee — feedback wanted").
- **r/Entrepreneur, r/ecommerce, r/sales, r/freelance:** promotion is restricted or banned — answer questions helpfully there if at all; never pitch.
- **Niche trade communities** (cafés, restaurants, retail, food trucks, salons): find the current ones at execution, read 2 weeks of posts before contributing, answer the recurring pains (till costs, stock spreadsheets, staff PINs) with real advice. Only mention Vendra where it directly answers the question asked.
- **Facebook groups for shop owners** (local and trade): join with the real profile/Page as the group requires, read the group rules — most ban naked ads but welcome "I made this, feedback please" posts from members who contribute. Group rules can't be verified without joining; confirm per group at execution and respect admin calls instantly.
- **Indie Hackers / maker communities**: build-in-public posts fit here (what we shipped, what broke, what it costs to run at $0) — the audience respects the constraint story.

**How to post:** answer the person's actual question first; disclose ownership; link only when the link *is* the answer (demo shop, manual page); stay in the thread and answer follow-ups within the first hours; never argue with critics — note real complaints as product feedback and thank the poster. Never buy, borrow, or coordinate upvotes (account-ending on Reddit and Product Hunt alike). Never post from alternate accounts. If a mod removes something, ask politely what format would be allowed and accept the answer.

**Content seeds from real support questions:** every recurring question in the Support tab becomes (a) a manual improvement, (b) a short FAQ/landing answer, (c) a community answer draft. One real answer, three homes.

## 6. Product Hunt launch (single launch day, prepared 3–4 weeks out)

- **Cost: $0.** Launching is free; anyone charging us for "hunting" or upvotes is banned from the plan (purchased upvotes get products buried and accounts flagged).
- **Timing:** launch at 12:01 a.m. Pacific, Tuesday–Thursday. Relaunches need roughly six months between them, so the first shot carries the real feature set, not a teaser.
- **Assets:** name + one-line tagline ("The shop app with no monthly bill — till, stock, and your shop's web page in one"), 3–5 final-UI screenshots, the 60–90 second walkthrough video (§7), first comment from the maker telling the true story: built for one real shop first, $0 infrastructure, 30 days free then one unlock, data never held hostage.
- **Behaviour:** ask people to *visit and comment*, never to upvote. Answer every comment the same day. Post the launch in our own channels (§8) once, without begging language.
- **Maker prep (weeks before):** the hunting account has real activity — comments on other launches, follows — so launch day isn't its first day alive.

## 7. Content engine (2 posts/week + 1 video/week at full cadence)

Everything is written once in EN, adapted (not machine-dumped) into FR, ES, PT — the keyword research is explicit that each language searches differently (EN "free POS software", FR "caisse enregistreuse gratuite / logiciel de caisse", ES "software punto de venta gratis", PT "sistema de gestão para lojas / PDV grátis"). Every piece answers one real buyer question and ends with one honest next step (try the demo shop, read the manual chapter, start the 30-day trial).

**The first 10 pieces (titles are working titles):**

1. **"What does a POS really cost per year? Square, Lightspeed, Shopify vs one unlock"** — the math post. Competitor figures from the sourced comparison table in `docs/seo-positioning.md`, each with its source date; our side shows `[PRICE]` until Jesse sets it. EN + FR ("Combien coûte un logiciel de point de vente ?" — a question the FR SERP literally ranks unanswered).
2. **"Vendra vs Square"** — honest two-column page: where Square wins (integrated payments today, hardware ecosystem), where we win (no monthly bill, one app for shop types Square splits into separate products, four languages, your data downloadable always). No dunking; accuracy is the brand.
3. **"Vendra vs Lightspeed"** — same treatment for the retail-heavy rival; their depth (matrix SKUs, purchase orders) named plainly as beyond us today.
4. **"The no-monthly-fee POS, explained"** — how the trial → soft-lock → unlock model works, why locked data is never deleted, how to download your backup while locked. This page carries the trust argument; it links the manual's backup/restore chapter.
5. **"Free POS software: what 'free' actually gets you"** — a buyer's guide to the word: free tiers with processing margins, trials that delete, open-source you host yourself, and our model. Ranks against the head EN query without pretending we're a $0-forever product.
6. **FR: "Caisse enregistreuse gratuite : ce qu'il faut vérifier avant de choisir"** — beginner checklist (languages, backup, what happens when the trial ends), including the honest line that Vendra is **not** NF525-certified fiscal software and what that means for a French shop. Honesty here is the differentiator, not a footnote.
7. **ES: "Software punto de venta gratis: guía honesta para tiendas y cafés"** — neutral Latin-American Spanish; names that we don't issue CFDI facturas (a Mexican shop needing SAT invoicing needs that clearly), and what we do instead (receipts, records, exports).
8. **PT: "Sistema de gestão para lojas com PDV: o que uma loja pequena realmente precisa"** — gestão framing per the PT research; honest note that we don't emit NFC-e/NF-e.
9. **"One app for the whole shop: till, stock, appointments, and your web page"** — the flexibility pillar as a tour, one section per shop type (café, retail, services, convenience), each tied to a real screen from the demo shop. ES/PT versions split by the verticals those SERPs actually use (cafés y kioscos; lojas e lanchonetes).
10. **"Your shop's data is yours: backups, restore, and never losing your shop"** — the survival story: download everything, put it back, locked shops included. Doubles as the trust asset linked from directories and the lock screen.

**Video (YouTube, mirrored as Shorts/Reels/TikTok cuts):**

- **The walkthrough (6–8 min):** the exact script outline — (1) the pain: monthly POS bills and a stock spreadsheet that lies; (2) create a shop and pick your type of shop; (3) add three products; (4) ring up a sale on the till (touch mode on); (5) watch stock move; (6) open your shop's public web page — same products, already there; (7) download a backup and put it back; (8) the honest close: 30 days free, then one unlock, your data is never deleted. Recorded on the final UI with the demo shop, captioned in the video's language (captions are free on YouTube and matter for accessibility + search).
- **Weekly shorts (30–60 s, phone-shot is fine):** one beginner tip per clip, from the content list above ("How to see what you sold today", "Your shop page updates itself — look"). One shoot produces the EN clip; FR/ES/PT captions/subtitle versions follow the same footage.
- **ES and FR demo videos aren't optional garnish:** YouTube results sit on page 1 for ES/FR "gratis/gratuit" queries — a Spanish walkthrough is a ranking asset, scheduled in the first month.

## 8. Owned channels (after accounts exist)

- **LinkedIn page:** company basics, the landing link, one post per content piece, release notes. Low effort, exists mainly so directories and cautious buyers find a pulse.
- **YouTube channel:** §7. Descriptions carry the trial link and the manual link; pinned comment states the pricing model plainly.
- **TikTok / Instagram:** the shorts cadence; bio links to the landing page; reply to comments like a person. Shop-owner hashtags in each language, no hashtag walls.
- **Facebook Page + group participation:** §5. The Page posts releases and content; group work is participation, not broadcasting.
- **Email:** there is no list and no budget for one; the in-product Support tab is the support channel, and product news rides the channels above. If a free-tier newsletter ever starts, it uses a provider's free tier with double opt-in from an actual signup form — never harvested addresses.

## 9. Metrics (all $0 tooling)

- **Google Search Console** (primary truth): impressions and clicks by query and language; which of "free POS / caisse gratuite / punto de venta gratis / PDV grátis" clusters start showing us; landing page indexation; storefront-host crawl stats where the future per-shop domains allow property verification.
- **Bing Webmaster Tools:** same, cheaper to check monthly; Bing feeds DuckDuckGo and Copilot answers, so a listing there is quiet extra reach.
- **Umami Cloud free tier:** landing visits, outbound clicks to the app/trial, per-language page split. Privacy-friendly and cookie-light — matches the product's posture.
- **Microsoft Clarity (free):** heatmaps on the landing pages only — where beginners stall before the trial button. Fix what it shows; don't admire it.
- **Product numbers, from the product itself:** trials started, trials that reach day 7 active, unlock keys redeemed (sales), Support-tab questions by theme. The licensing system already knows redemptions; that's the revenue line.
- **Directory dashboards:** Capterra/G2 profile views and click-throughs, checked monthly when updating listings.

Review rhythm: weekly 15-minute numbers pass (Search Console + Umami + trials); monthly listing/claims audit (§10) and competitor-price recheck — vendor prices change, and our comparison pages must never carry a stale rival price as fact.

## 10. Guardrails & approval gates

- **Jesse approves:** the unlock price (and any price appearing anywhere), every comparative claim about a named rival, anything touching real shops' names/data, press or partnership outreach, and any spend at all (standing budget: $0).
- **Claims audit (monthly, and before every launch):** re-verify competitor prices from vendor pages; re-check directory facts (ownership/syndication changed at least once already in 2026); confirm the feature list on every public page still matches the shipped app (payment-processing language gets special attention until it truly exists).
- **Reviews:** ask happy users plainly, once, inside the product's own surfaces ("if Vendra earned it, a review on Capterra helps other shops find us") — no incentives, no gating (don't pre-screen unhappy users away from reviewing), no staff reviews, no review swaps.
- **Community accounts** follow §5's disclosure and ratio rules; a single astroturfing incident would cost more trust than a year of reach buys. When in doubt, don't post.
- **Privacy:** no analytics inside customer shops or on shop pages beyond what the platform needs to run; marketing tracking lives on *our* landing pages only. Demo-shop data is fictional by construction.

## 11. Sequence

- **Pre-launch (weeks −4 to −1):** password gate → accounts (§2) → sitemap submitted to Search Console + Bing → directory submissions in (§4 order; Capterra first for its queue) → demo shop stocked (§3) → walkthrough video recorded → comparison + guide pages 1–4 published → Reddit/maker accounts warmed through genuine participation → Product Hunt coming-soon presence.
- **Launch week:** Product Hunt day (§6); "Show HN" only if the demo shop can be tried without signup friction that would draw (fair) fire — decide at the time; launch posts to warmed communities in their allowed formats; directories go live/have been submitted; LinkedIn + video announcements once each.
- **First 30 days:** content cadence live (§7; pieces 5–10 staggered), first ES + FR videos, weekly metrics pass, first honest review asks to real trial users who've had a genuinely good run, Support-tab questions feeding the content queue.
- **Day 30+:** monthly claims audit; directory listing refresh with new screenshots; revisit "Show HN" and listicle outreach with real traction numbers (never invented ones); expand the vertical guides as real shops teach us what they ask.

## Sources (all accessed 2026-10-01; re-verify at execution — see §10)

- Product Hunt launch mechanics & rules: Product Hunt's launch guidance as summarized at dev.to ("How to get featured on Product Hunt: Your launch guide"), and nocodewebsitebuilder.com's 2026 maker's guide — launching is free; launch from a personal account; never ask for upvotes; best slot 12:01 a.m. Pacific; ~6 months between relaunches.
- Capterra network: Capterra vendor signup (capterra.com/vendors/sign-up); syndication of one Gartner Digital Markets profile across Capterra/GetApp/Software Advice per trustsignals.com's Capterra listing guide; ownership change (G2 acquired Capterra/GetApp/Software Advice from Gartner, February 2026) per en.wikipedia.org/wiki/Software_Advice.
- Directories list curation: github.com/shoaibdigitallogix/awesome-saas-directories and github.com/whatsuppiyush/backlink-claude-skill (free-listing scope for AlternativeTo, SaaSHub, SourceForge, TrustRadius basic; G2 free profile, paid badges ~$2,999/yr skipped).
- Analytics at $0: Umami Cloud free Hobby tier per its pricing coverage (setupanalytics.com), vs Plausible from $9/mo with no free plan (ossalt.com comparison); Microsoft Clarity free and unlimited (vendor docs). Plausible excluded: not $0.
- Reddit rules dataset: leadsrover.io's subreddit self-promotion rules compilation (member counts and promo stances for r/smallbusiness, r/SideProject, r/Entrepreneur, r/ecommerce, r/sales, r/freelance as of access) — sidebar verification still required at execution.
- Search tooling: Google Search Console and Bing Webmaster Tools are free; Bing import from Search Console and Bing's role in Yahoo/DuckDuckGo/Copilot results per mediaofficers.com's setup guide.
- Keyword/channel evidence (which directories and video surfaces rank per language; FR/ES/PT directory names): `docs/research/keywords-raw.md` (2026-10-01) and `docs/seo-positioning.md`.
