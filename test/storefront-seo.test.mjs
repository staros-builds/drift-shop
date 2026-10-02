/**
 * Unit tests for storefront SEO helpers (src/lib/storefrontSeo.js).
 * Run: node test/storefront-seo.test.mjs
 *
 * The helpers carry the storefront's search/social metadata. The checks
 * that matter are the honesty ones: no field the public_storefront()
 * RPC does not return may be invented (no prices without a currency,
 * no ratings, no structured hours from free text), and anything applied
 * to <head> must come off again cleanly on unmount.
 */
import assert from 'node:assert/strict';
import {
  metaDescription,
  sameAsLinks,
  storefrontJsonLd,
} from '../src/lib/storefrontSeo.js';

let n = 0;
function check(name, fn) {
  n++;
  try {
    fn();
    console.log(`  ok ${n} - ${name}`);
  } catch (e) {
    console.error(`  FAIL ${n} - ${name}: ${e.message}`);
    process.exitCode = 1;
  }
}

const shop = {
  display_name: 'Café du Coin',
  tagline: 'Café de quartier',
  about: 'Café de quartier\ndepuis 1998.  Terrasse l’été.',
  hours: 'Lun–Ven 7h à 17h',
  contact_email: 'bonjour@example.test',
  contact_phone: '+1 555 0100',
  address: '123 rue Principale, Gatineau',
  links: { facebook: 'https://facebook.com/cafeducoin', instagram: '', tiktok: 'notaurl' },
};
const products = [{ name: 'Croissant', price: 350 }, { name: '  Café filtre ', price: 250 }, { name: '', price: 1 }];

check('metaDescription joins tagline and about, collapses whitespace', () => {
  assert.equal(metaDescription(shop), 'Café de quartier — Café de quartier depuis 1998. Terrasse l’été.');
});

check('metaDescription truncates with an ellipsis at the cap', () => {
  const long = { tagline: 'x'.repeat(400) };
  const out = metaDescription(long, 160);
  assert.equal(out.length, 160);
  assert.ok(out.endsWith('…'));
});

check('metaDescription is empty when the shop wrote nothing', () => {
  assert.equal(metaDescription({ display_name: 'X' }), '');
});

check('sameAsLinks keeps only real http(s) profile URLs', () => {
  assert.deepEqual(sameAsLinks(shop), ['https://facebook.com/cafeducoin']);
  assert.deepEqual(sameAsLinks({}), []);
  assert.deepEqual(sameAsLinks({ links: null }), []);
});

check('storefrontJsonLd emits a Store with only RPC-backed fields', () => {
  const doc = storefrontJsonLd(shop, products, 'https://example.test/#/store/cafe-du-coin');
  assert.equal(doc['@type'], 'Store');
  assert.equal(doc.name, 'Café du Coin');
  assert.equal(doc.email, 'bonjour@example.test');
  assert.equal(doc.telephone, '+1 555 0100');
  assert.deepEqual(doc.address, { '@type': 'PostalAddress', streetAddress: '123 rue Principale, Gatineau' });
  assert.deepEqual(doc.sameAs, ['https://facebook.com/cafeducoin']);
  const items = doc.hasOfferCatalog.itemListElement;
  assert.equal(items.length, 2, 'blank product names are dropped');
  assert.equal(items[1].item.name, 'Café filtre', 'names are trimmed');
});

check('storefrontJsonLd never invents prices, currency, ratings or hours', () => {
  const raw = JSON.stringify(storefrontJsonLd(shop, products, 'https://example.test/'));
  for (const banned of ['price', 'priceCurrency', 'aggregateRating', 'openingHours', 'review']) {
    assert.ok(!raw.includes(banned), `must not contain ${banned}`);
  }
});

check('storefrontJsonLd is null without a shop name', () => {
  assert.equal(storefrontJsonLd({}, products, 'u'), null);
  assert.equal(storefrontJsonLd(null, products, 'u'), null);
});

check('storefrontJsonLd tolerates missing products and links', () => {
  const doc = storefrontJsonLd({ display_name: 'Solo Shop' }, undefined, 'u');
  assert.equal(doc.name, 'Solo Shop');
  assert.equal(doc.hasOfferCatalog, undefined);
  assert.equal(doc.sameAs, undefined);
  assert.equal(doc.address, undefined);
});
