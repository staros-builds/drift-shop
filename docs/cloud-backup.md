# Cloud backup — a second copy of everything, in the owner's own free storage

**Status:** built and unit-tested (Oct 1, 2026). Lights up when Jesse's one-time
Google setup below is done and the client ID is pasted into `src/lib/brand.js`.
Until then Settings → Data shows an honest "not switched on yet" note and the
Download account backup button remains the always-available path.

The idea, in plain words: a backup that lives only on the shop's counter computer
dies with that computer. Cloud backup saves the exact same backup file into the
shop owner's own Google Drive, so a lost, stolen, or drowned laptop takes nothing
with it. The owner brings their own free storage — Drift Shop never holds anyone's
data, never sees a Google password, and is never in the middle.

## What owners get (Settings → Data → "Cloud backup (extra safety)")

- **Connect Google Drive** — one tap, Google's own sign-in page. No password is
  ever typed into Drift Shop.
- **Back up now** — saves the full account backup to a "Drift Shop backups"
  folder in their Drive. Keeps the newest 5, tidies older ones away.
- **Back up by itself once a week** (optional, off by default) — runs quietly
  while the app is open with a live Google session. Never throws surprise
  sign-in popups; if the session expired it simply waits for the next visit.
- **Restore from Google Drive** — newest-first list (date, size), one tap feeds
  the file into the exact same restore path as the file picker: same checks,
  same "this replaces what you have now" confirmation, same automatic
  fresh-backup-of-current-state first (when the restore worker's flow is in).
- **Disconnect** — signs Drift Shop out of Google on that device. Backups already
  saved stay in the owner's Drive.

Privacy shape: Drift Shop asks Google for the narrow `drive.file` permission —
it can only see and change files it creates itself. Not photos, not email, not
the rest of Drive. That promise is enforced by Google, not by our good intentions.

## Why Google Drive (researched Oct 1, 2026)

| Provider | Free space | Why / why not |
|---|---|---|
| **Google Drive** | **15 GB** | **Chosen.** Sign-in owners already know ("Sign in with Google"), browser-only OAuth, no secret keys to manage, files visible in the normal Drive app. 15 GB = hundreds of backups. |
| MEGA | 20 GB | Rejected: no browser OAuth — would need password-based, zero-knowledge plumbing a beginner can't audit and we can't support. |
| pCloud | up to 10 GB | Runner-up: real OAuth2 API. Smaller ecosystem, less familiar sign-in. Possible second option later. |
| Cloudflare R2 | 10 GB | Rejected: needs API-key juggling, and the free tier still asks for a payment method on file. Fails the beginner test and the $0 test. |
| Backblaze B2 | 10 GB | Rejected: API-key management is exactly the kind of thing this product promises owners they will never see. |
| Dropbox | 2 GB | Too small to be the "forever" answer. |

Sources (accessed 2026-10-01): Google Drive Help / Google One (15 GB shared
across Drive, Gmail, Photos); mega.io (20 GB free plan); pcloud.com and
docs.pcloud.com (OAuth2 API, up to 10 GB free); developers.cloudflare.com/r2
(10 GB-month free tier); backblaze.com cloud storage pricing (first 10 GB free);
dropbox.com Basic (2 GB). Secondary comparisons cross-checked against vendor
pages where plans were ambiguous.

## Honest risks (read before selling this as "forever")

- **Free tiers are promises, not property.** Drive's 15 GB has been unchanged
  since 2013, but Google can change it. Mitigation already built in: the backup
  file is plain JSON the owner can download from Drive without Drift Shop, and
  the local Download backup always works. No lock-in, ever.
- **The 15 GB is shared** with the owner's Gmail and Google Photos. A mailbox
  stuffed with photos can block a backup. The app says exactly that in plain
  words when it happens ("storage full — free up space in Drive, Gmail, or
  Photos") instead of showing an error code.
- **Google deletes inactive personal accounts** (2+ years without use, with
  8+ months of warnings — policy since Dec 2023). An active shop signs in
  constantly, so this is a "closed shop" edge, not a live one; still documented
  for owners so nobody is surprised.
- **Until Jesse completes Google's one-time app verification** (below), the
  Google sign-in runs in "Testing" mode: only email addresses Jesse adds as
  test users can connect, and connections expire weekly. Fine for piloting;
  the verification removes both limits for free.
- **Lost Google account = lost cloud copies.** Same as losing the only set of
  keys. The manual tells owners to also download a local backup now and then.
  Layers, not single points of failure.

## Jesse's one-time setup (~15 minutes, $0) — do this once, every shop benefits

1. Go to **console.cloud.google.com** and sign in with the platform Google
   account. Create a project (name it after the product).
2. In the project: **APIs & Services → Library → Google Drive API → Enable**.
3. **APIs & Services → OAuth consent screen**: choose **External**, app name =
   the product name (this is what owners see on Google's sign-in page — one
   product, one identity), support email = the platform email. Add the scope
   `.../auth/drive.file` when asked.
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   application type **Web application**. Under **Authorized JavaScript
   origins**, add every address the app is served from — the live demo
   (`https://staros-builds.github.io`), each redundancy mirror as it arrives
   (Cloudflare Pages / Netlify), the final product address and per-shop
   subdomains when domains land, and `http://localhost:5173` for testing.
   No redirect URIs are needed (token flow).
5. Copy the **Client ID** (it looks like
   `1234567890-abcdef....apps.googleusercontent.com`). It is public by design —
   safe in the build. Paste it into `src/lib/brand.js` as `googleClientId`,
   rebuild, redeploy. Done — the Settings card switches itself on.
6. **Before selling widely:** on the consent screen, choose **Publish app** and
   submit Google's verification (free; needs a homepage + privacy-policy page
   and a short demo video of the sign-in). This lifts the Testing-mode limits
   (100 test users, weekly expiry) and removes the "unverified app" warning.

Owners never do any of this. Their whole setup is: Settings → Data →
Connect Google Drive.

## For the buyer manual (paste-ready)

**EN — "A second copy of everything, kept safe online."** Your shop's backup
normally lives on this computer. If the computer is lost or breaks, the backup
goes with it. Cloud backup keeps a second copy in your own free Google Drive.
Open **Settings**, then **Data**, then **Connect Google Drive** and sign in with
your Google account — Drift Shop never sees your password. Afterwards, tap
**Back up now** whenever you like, or turn on **Back up by itself once a week**
and forget about it. To bring everything back on a new computer, connect the
same Google account and choose **Restore from Google Drive**. Your newest 5
backups are kept automatically.

**FR — « Une deuxième copie de tout, gardée en sécurité en ligne. »** La
sauvegarde de votre boutique vit normalement sur cet ordinateur. Si l'ordinateur
est perdu ou brisé, la sauvegarde part avec lui. La sauvegarde en ligne garde
une deuxième copie dans votre Google Drive gratuit. Ouvrez **Paramètres**, puis
**Données**, puis **Brancher Google Drive** et connectez-vous avec votre compte
Google — Drift Shop ne voit jamais votre mot de passe. Ensuite, touchez
**Sauvegarder maintenant** quand vous voulez, ou activez **Sauvegarder tout
seul, une fois par semaine** et n'y pensez plus. Pour tout ramener sur un nouvel
ordinateur, branchez le même compte Google et choisissez **Restaurer depuis
Google Drive**. Vos 5 sauvegardes les plus récentes sont gardées automatiquement.

## Testing status

- `node test/cloud-backup.test.mjs` — 12 checks, all passing (filename shape,
  rotation safety incl. never touching foreign files, weekly-due logic,
  multipart body, error mapping, state defaults).
- Full build verified (bundle byte-checked: locale strings, Drive scope, CSP
  allowances all present) and boot smoke-tested in jsdom.
- Live Google round-trip (connect → upload → restore) is the one thing that
  cannot be tested until the client ID exists; it is first on the checklist
  after step 5 of the setup above.
