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
  name: 'Drift Shop',
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
  // Subpath the built app is served from (e.g. GitHub Pages project site).
  // Must match vite.config.js `base`.
  basePath: '/drift-shop/',
};

export default BRAND;
