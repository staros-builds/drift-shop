// Brand configuration — the ONE file a buyer edits to rebrand the product.
//
// Every user-visible product name, tagline, accounts domain, storage prefix,
// and hosting base path derives from here (plus the locale files in
// src/lib/locales/, which import BRAND for the name/tagline).
//
// To sell this under your own name: change `name` (and the taglines /
// accountsDomain if you like), rebuild, redeploy. No other source changes
// are needed for the rebrand.
export const BRAND = {
  // Product name shown on the login screen, window titles, toasts, manual…
  name: 'Vendra',
  // Tagline under the product name (login screen, crash screen footer).
  taglineEn: 'Point of sale, catalogue, team and files — in one calm app.',
  taglineFr: 'Caisse, catalogue, équipe et fichiers — dans une seule appli.',
  // Synthetic email domain used to map bare usernames to emails for
  // Supabase auth (users only ever see their username). Must be a domain
  // shape Supabase's email validation accepts on signup.
  accountsDomain: 'drift-shop.app',
  // Prefix for localStorage keys, window events, console tags and the
  // service-worker cache name. Change only for a fresh install — existing
  // installs keep their data under the old prefix.
  storagePrefix: 'driftshop',
  // Directory the app itself is served from (e.g. '/drift-shop/' on
  // GitHub Pages, '/' on root-hosted mirrors), derived at runtime from
  // the page URL — the build is host-agnostic, so there is NO fixed
  // subpath to keep in sync. All app routes are hash routes, so the
  // current document's directory IS the app root.
  appBasePath: () => {
    try {
      const p = window.location.pathname || '/';
      return p.endsWith('/') ? p : p.slice(0, p.lastIndexOf('/') + 1);
    } catch {
      return '/';
    }
  },
  // The product's own domain (the "apex"), e.g. 'driftshop.example.com'.
  // When set, every shop automatically gets a free address under it —
  // <their-web-address-name>.<<apexDomain>> — that opens their public
  // storefront with zero setup (see docs/custom-domains.md). Leave empty
  // to turn automatic addresses off; shops can still connect a domain of
  // their own either way. One line, set once, never per-shop.
  apexDomain: '',
  // Where a shop's own domain must point (the CNAME target we show them in
  // Admin -> Storefront -> "Your web addresses"), e.g. the Cloudflare
  // Pages hostname that fronts this build. Deployment-specific like
  // apexDomain; empty hides the target line in the instructions.
  hostCnameTarget: '',
  // Google sign-in key (OAuth client ID) for the optional cloud backup in
  // Settings → Data. Free and safe to ship in the build — it only says
  // which app is asking; Google still checks the site address. Leave empty
  // to keep cloud backup off (Settings says so in plain words and the
  // download backup keeps working). One-time setup: docs/cloud-backup.md.
  googleClientId: '',
};

export default BRAND;
