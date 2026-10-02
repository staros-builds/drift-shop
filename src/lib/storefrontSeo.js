/**
 * Storefront SEO helpers — pure functions behind the client-side search
 * metadata StorefrontPublic injects once the shop data loads.
 *
 * Honest scope (see docs/seo-positioning.md): the storefront is a
 * client-rendered hash route (#/store/<slug>), so this metadata serves
 * link previews (messengers, social) and the crawlers that run
 * JavaScript. It is NOT a substitute for crawlable pages — that limit
 * is documented, not hidden.
 *
 * Claims discipline: only fields the public_storefront() RPC actually
 * returns are emitted (display_name, tagline, about, hours,
 * contact_email, contact_phone, address, links, products[].name/price).
 * Products are listed by NAME only: the RPC carries no currency, so an
 * Offer with priceCurrency would invent data we do not have.
 */

/** Trim a free-text field to a meta-description-sized string. */
export function metaDescription(shop, max = 160) {
  const raw = [shop?.tagline, shop?.about]
    .map((s) => String(s || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join(' — ');
  if (!raw) return '';
  if (raw.length <= max) return raw;
  return `${raw.slice(0, max - 1).trimEnd()}…`;
}

/** Social/profile links the RPC exposes, as schema.org sameAs URLs. */
export function sameAsLinks(shop) {
  const links = shop?.links || {};
  return ['facebook', 'instagram', 'tiktok']
    .map((k) => String(links[k] || '').trim())
    .filter((u) => /^https?:\/\//i.test(u));
}

/**
 * LocalBusiness/Store JSON-LD for one shop page. `url` is the page the
 * visitor is on (the canonical storefront URL). Fields with no data are
 * omitted rather than filled with guesses — no prices, no currency, no
 * ratings, no structured opening hours (the RPC's hours are free text
 * and cannot be mapped to openingHoursSpecification honestly).
 */
export function storefrontJsonLd(shop, products, url) {
  const name = String(shop?.display_name || '').trim();
  if (!name) return null;
  const doc = {
    '@context': 'https://schema.org',
    '@type': 'Store',
    name,
    url,
  };
  const description = metaDescription(shop, 300);
  if (description) doc.description = description;
  const email = String(shop?.contact_email || '').trim();
  if (email) doc.email = email;
  const phone = String(shop?.contact_phone || '').trim();
  if (phone) doc.telephone = phone;
  const address = String(shop?.address || '').trim();
  if (address) doc.address = { '@type': 'PostalAddress', streetAddress: address };
  const sameAs = sameAsLinks(shop);
  if (sameAs.length) doc.sameAs = sameAs;
  const items = (Array.isArray(products) ? products : [])
    .map((p) => String(p?.name || '').trim())
    .filter(Boolean)
    .slice(0, 50)
    .map((productName, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      item: { '@type': 'Product', name: productName },
    }));
  if (items.length) {
    doc.hasOfferCatalog = {
      '@type': 'OfferCatalog',
      name,
      itemListElement: items,
    };
  }
  return doc;
}

/**
 * Upsert one <meta> tag in <head> and return the element, so callers can
 * remove exactly what they added on unmount. `attr` is 'name' or
 * 'property'.
 */
export function upsertMeta(doc, attr, key, content) {
  if (!content) return null;
  const selector = `meta[${attr}="${key}"]`;
  let el = doc.head.querySelector(selector);
  if (!el) {
    el = doc.createElement('meta');
    el.setAttribute(attr, key);
    el.setAttribute('data-vendra-seo', '1');
    doc.head.appendChild(el);
  }
  el.setAttribute('content', content);
  return el;
}

/** Upsert the canonical <link> the same managed way. */
export function upsertCanonical(doc, href) {
  if (!href) return null;
  let el = doc.head.querySelector('link[rel="canonical"]');
  if (!el) {
    el = doc.createElement('link');
    el.setAttribute('rel', 'canonical');
    el.setAttribute('data-vendra-seo', '1');
    doc.head.appendChild(el);
  }
  el.setAttribute('href', href);
  return el;
}

/**
 * Apply title + description + Open Graph/Twitter + JSON-LD for a loaded
 * shop. Returns a cleanup function that removes every element this call
 * added and restores the previous <title> — the storefront unmounts
 * when the visitor follows the staff-login link, and a leaked shop name
 * in the app shell's title would be wrong.
 */
export function applyStorefrontSeo({ shop, products, url, brandName }) {
  if (typeof document === 'undefined') return () => {};
  const added = [];
  const prevTitle = document.title;
  const name = String(shop?.display_name || '').trim();
  if (!name) return () => {};
  document.title = brandName && brandName !== name ? `${name} · ${brandName}` : name;

  const description = metaDescription(shop);
  added.push(upsertMeta(document, 'name', 'description', description));
  added.push(upsertMeta(document, 'property', 'og:type', 'website'));
  added.push(upsertMeta(document, 'property', 'og:title', name));
  added.push(upsertMeta(document, 'property', 'og:description', description));
  added.push(upsertMeta(document, 'property', 'og:url', url));
  added.push(upsertMeta(document, 'name', 'twitter:card', 'summary'));
  added.push(upsertMeta(document, 'name', 'twitter:title', name));
  added.push(upsertMeta(document, 'name', 'twitter:description', description));
  added.push(upsertCanonical(document, url));

  const jsonLd = storefrontJsonLd(shop, products, url);
  if (jsonLd) {
    // JSON-LD data block, built via DOM APIs from module code: the app
    // CSP bans inline <script> in index.html, and a script element
    // carrying application/ld+json is never executed anyway.
    const script = document.createElement('script');
    script.type = 'application/ld+json';
    script.setAttribute('data-vendra-seo', '1');
    script.textContent = JSON.stringify(jsonLd);
    document.head.appendChild(script);
    added.push(script);
  }

  return () => {
    for (const el of added) {
      if (el && el.parentNode) el.parentNode.removeChild(el);
    }
    document.title = prevTitle;
  };
}
