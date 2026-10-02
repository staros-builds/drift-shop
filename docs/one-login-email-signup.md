# One login: email signup + confirmation

Jesse's requirement (2026-10-01): **no traditional usernames — signup is by
EMAIL with a CONFIRMATION EMAIL proving the person is real; one self-made
login seamlessly opens everything** across all mirrors and synchronized
services. For business owners AND customers (customers log in on the shop
owner's public website).

Branch: `ds-sso`. Client companion to migration `073_draft_sso.sql`.

## How it works

```
Signup (email + password + name)
  → Supabase Auth sends a CONFIRMATION EMAIL (emailRedirectTo =
    <app>/?authflow=owner|customer[&shop=<slug>])
  → user clicks the link → back to the app with ?code= (PKCE)
  → consumeAuthCallback() exchanges the code, reads the markers:
      authflow=owner    → session active → desktop (setup access:
                          owner accounts pass the per-user gate so they can
                          CREATE their shop; the shop's 30-day trial starts
                          at shop creation — licensing model)
      authflow=customer&shop=<slug>
                        → session active → routed back to #/store/<slug> →
                          link_shop_customer() links the account to the shop
      authflow=recovery → forced choose-a-new-password screen
      ?code= with no markers (links sent before this change)
                        → pending-flow record? confirmation : recovery
                          (legacy behavior preserved)
      #error=…&error_code=otp_expired
                        → login screen shows the "link expired" notice
```

The DB trigger `handle_new_user()` (extended in 073) classifies the account
from the signup metadata into `profiles.account_kind`:

- `'owner'` — signed up via email to run a shop. Passes the per-user
  `evaluateAccess` unpaid gate (setup access); locked/disabled checks still
  apply.
- `'customer'` — signed up from a shop's storefront. Stays behind the
  desktop's unpaid gate (correct: the storefront is their home).
- `NULL` — legacy username accounts, staff, guests: evaluated exactly as
  before.

## Seamlessness matrix

| Surface | Identity | Notes |
|---|---|---|
| Every app mirror (GitHub Pages, Cloudflare, Netlify…) | Same Supabase project = **one identity** | The confirmation link's `emailRedirectTo` uses `window.location.origin`, so confirming from any mirror lands back on that mirror. |
| Sessions across mirrors | **Per host** (Supabase stores the session in that origin's localStorage) | Sign in once per mirror; each session refreshes independently. This is inherent to browser storage, not a bug. |
| Shop subdomains (`<shop>.vendra…`) | Same project, same identity | Staff sign-in from a shop page bounces to the apex app and back; the redirect-URL allowlist must cover subdomains (`https://*.vendra…/**`). |
| DB failover (mesh) | `auth.users` + `auth.identities` are copied to the standby | Sessions do NOT survive failover (tokens are signed by the primary's secret) — users sign in again. Owner setup stays gated on account creation. |
| Customers | `shop_customers(store_id, user_id, display_name)` + `link_shop_customer(p_slug)` RPC | Idempotent; only published storefronts accept links. **Contract for the customers worker:** build orders on top of `shop_customers`; the row is created on the customer's first signed-in visit. |

## Owner setup runbook (Supabase dashboard)

Do these in order. The backfill (step 1) must land **before** flipping the
"Confirm email" switch (step 2).

1. **Apply migration 073.** Section 1 backfills `email_confirmed_at` for
   every existing auth user (master admin, legacy username accounts on
   synthetic `@drift-shop.app` emails, anonymous guest users) so enabling
   confirmation never breaks a current login.
2. **Authentication → Providers → Email → enable "Confirm email".**
3. **Authentication → URL Configuration → Site URL:** set the production
   URL (not localhost).
4. **Redirect URLs allowlist:** add one wildcard entry per host, e.g.
   `https://<mirror-host>/**` and `https://*.vendra…/**` for shop
   subdomains. Supabase supports `*`/`**` wildcards with `.` and `/`
   separators. The app always lands email links on
   `<origin><basePath>?authflow=…`, which these patterns cover.
5. **SMTP (do not skip):** the built-in sender is **2 emails/hour,
   team addresses only — not production**
   ([docs](https://supabase.com/docs/guides/auth/auth-smtp)). The $0 path
   is **Resend free**: 3,000 emails/month (100/day cap), used as Supabase
   custom SMTP (`smtp.resend.com`, port 465, username `resend`, API key as
   the password) — [pricing](https://resend.com/pricing), checked
   2026-10-01. You must verify a sending domain (SPF/DKIM/DMARC DNS
   records); without one, Resend only delivers to your own account email.
   With custom SMTP the project starts at **30 emails/hour** (adjustable).
6. **Enable leaked-password protection** (Authentication → Policies).
7. Keep **"Allow anonymous sign-ins" ON** — the 30-minute guest trial
   needs it.

## Honest limits (all verified 2026-10-01)

- Built-in sender: **2 emails/hour, pre-authorized (team) addresses only**.
  Until Resend (or another SMTP) is wired, confirmation emails effectively
  don't reach real users. ([Supabase SMTP docs](https://supabase.com/docs/guides/auth/auth-smtp))
- Signup/sign-in/recover/resend: **30 requests / 5 minutes per IP**;
  per-user resend window **60 s** (the UI enforces the cooldown).
  ([rate limits](https://supabase.com/docs/guides/auth/rate-limits))
- Confirmation links expire after **1 hour** (the OTP-expiry setting).
  Expired links show the login screen's "link expired" notice with a
  resend path.
- **Enumeration-safe by default:** signing up with an already-registered
  email returns no error and no session — the UI always shows the same
  "check your inbox" panel, and adds the honest note that no new account
  was created if the address is taken.
- Synthetic `@drift-shop.app` addresses are **rejected at signup**: they
  can never receive mail and would collide with legacy username accounts.
  Legacy username sign-IN keeps working unchanged.

## Invites

`pos_invites.invited_email` (073 §4): when set, `join_pos_store()` only
lets the account holding that address claim the code. Untargeted invites
behave exactly as before. **Honest limit:** delivering the invite *by
email* (a link that lands the invitee in the app) needs the Supabase
Admin API or an edge function — the column + claim enforcement land here;
the sending UI is follow-up work.

## Factory reset

073 redefines `factory_reset()` with `shop_customers` in the truncate
list (42 → 43 tables) and classifies the reseeded master as
`account_kind = 'owner'`. The wipe list stays verified-against-pg_tables;
**every future table must be added here** or reset leaves data behind.

## i18n

New `login.*` strings ship in EN + FR (typographic `’` in fr.js, per the
standing lesson). **ES/PT mirrors are owed** at the ds-i18n merge, or the
parity test fails.

## Manual verification checklist (when the dashboard switch flips)

1. Fresh owner signup → confirmation email arrives → click → lands on
   desktop → POS shows the create-shop setup screen.
2. Create the shop → licensing trial opens (licensing branch).
3. Expired link (wait 1h or tamper) → "link expired" notice → resend works
   after the 60 s cooldown.
4. Customer: shop page → Create account → confirm on a *different device*
   → lands back on the shop page, signed in, linked (check
   `shop_customers`).
5. Legacy `admin` username sign-in still works (confirmation backfill).
6. Password-reset flow still forces the new-password screen (regression).
7. Factory reset on a scratch project → master reseeds, `shop_customers`
   empty, no leftover rows.

## Social sign-in (added 2026-10-01, Jesse's direction)

Email + password stays, but the login and storefront account sheets also
offer **Continue with Google** and **Continue with GitHub**. The app side
is done: `signInWithOAuth({ provider, kind, slug })` starts the provider
round trip with the same `?authflow=owner|customer[&shop=<slug>]` redirect
as an email confirmation, so owners land on the desktop and customers land
back on their shop; a provider that is not enabled yet surfaces the plain
"isn't switched on yet" message instead of a raw error.

Operator steps to switch a provider ON (Supabase dashboard, per provider):

1. **Google:** Google Cloud Console → create an OAuth client (Web) for the
   project. Authorized redirect URI is the Supabase callback:
   `https://<project-ref>.supabase.co/auth/v1/callback`. Put the client ID
   + secret into Supabase → Authentication → Providers → Google → enable.
2. **GitHub:** GitHub → Settings → Developer settings → OAuth Apps → New.
   Homepage = the primary app address; Authorization callback URL = the
   same Supabase callback above. Put the client ID + secret into Supabase →
   Authentication → Providers → GitHub → enable.
3. The app's own Redirect URLs allowlist (step 4 above) already covers the
   return trip — every live mirror pattern must be present or the user
   lands on an error after the provider.
4. Test once per provider: sign up fresh, confirm you land signed-in, sign
   out, sign back in with the same service. An OAuth-created profile has
   `account_kind = NULL` (no signup metadata) and is treated as a legacy
   account by the access gate; the customer shop link is stamped by the
   storefront visit, exactly like email customers.

Apple/Microsoft/Facebook are intentionally not wired: Apple needs a paid
developer account, and the others add app-review/tenant setup that breaks
the $0 rule. The provider list lives in one place
(`OAUTH_PROVIDERS` in `src/lib/authFlow.js`) so adding one later is a
list entry plus its dashboard switch.
