/**
 * Tests for the landing generator (scripts/build-landing.mjs).
 * Run: node test/landing.test.mjs
 *
 * The landing pages are the only crawler-readable surface of the
 * product, so the checks lock the SEO plumbing: one page per language,
 * unique title/description per page, canonical + hreflang alternates,
 * parseable SoftwareApplication and FAQPage JSON-LD, a sitemap that
 * lists every language with alternates, and robots pointing at it.
 * Also locked: the generator only ADDS files (landing/, sitemap.xml,
 * robots.txt) — it must never touch the SPA build output.
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildLanding } from '../scripts/build-landing.mjs';

let n = 0;
async function check(name, fn) {
  n++;
  try {
    await fn();
    console.log(`  ok ${n} - ${name}`);
  } catch (e) {
    console.error(`  FAIL ${n} - ${name}: ${e.message}`);
    process.exitCode = 1;
  }
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = await mkdtemp(path.join(tmpdir(), 'vendra-landing-'));
const written = await buildLanding({ root, out });

const pages = {};
for (const lang of ['en', 'fr', 'es', 'pt']) {
  const rel = lang === 'en' ? 'landing/index.html' : `landing/${lang}/index.html`;
  pages[lang] = await readFile(path.join(out, rel), 'utf8');
}
const sitemap = await readFile(path.join(out, 'sitemap.xml'), 'utf8');
const robots = await readFile(path.join(out, 'robots.txt'), 'utf8');

await check('generator writes 4 pages + sitemap + robots, nothing else', () => {
  assert.equal(written.length, 6);
  for (const f of written) {
    const rel = path.relative(out, f);
    assert.ok(
      rel.startsWith('landing/') || rel === 'sitemap.xml' || rel === 'robots.txt',
      `unexpected write: ${rel}`,
    );
  }
});

await check('every page has title, description, canonical, OG and hreflang', () => {
  for (const [lang, html] of Object.entries(pages)) {
    assert.match(html, /<title>.{10,}<\/title>/, `${lang} title`);
    assert.match(html, /<meta name="description" content=".{40,}"/, `${lang} description`);
    assert.match(html, /<link rel="canonical" href="https?:\/\/[^"]*landing\//, `${lang} canonical`);
    assert.match(html, /property="og:title"/, `${lang} og:title`);
    assert.match(html, /property="og:description"/, `${lang} og:description`);
    for (const l of ['en', 'fr', 'es', 'pt', 'x-default']) {
      assert.ok(html.includes(`hreflang="${l}"`), `${lang} missing hreflang ${l}`);
    }
  }
});

await check('html lang attributes match their language', () => {
  assert.ok(pages.en.includes('<html lang="en">'));
  assert.ok(pages.fr.includes('<html lang="fr">'));
  assert.ok(pages.es.includes('<html lang="es">'));
  assert.ok(pages.pt.includes('<html lang="pt-BR">'));
});

await check('titles are unique per language', () => {
  const titles = Object.values(pages).map((h) => h.match(/<title>(.*?)<\/title>/)[1]);
  assert.equal(new Set(titles).size, 4, titles.join(' | '));
});

await check('JSON-LD blocks parse and carry both schema types', () => {
  for (const [lang, html] of Object.entries(pages)) {
    const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
    assert.equal(blocks.length, 2, `${lang} should have SoftwareApplication + FAQPage`);
    const types = blocks.map((b) => JSON.parse(b[1])['@type']);
    assert.deepEqual(types.sort(), ['FAQPage', 'SoftwareApplication']);
    const app = blocks.map((b) => JSON.parse(b[1])).find((d) => d['@type'] === 'SoftwareApplication');
    assert.ok(!('offers' in app), 'no offers node until the owner sets a real price');
  }
});

await check('no template tokens survive substitution', () => {
  for (const [lang, html] of Object.entries(pages)) {
    assert.ok(!/\{\{[A-Z_]+\}\}/.test(html), `${lang} has a leftover token`);
  }
});

await check('sitemap lists all 4 languages with alternates; robots points at it', () => {
  for (const lang of ['en', 'fr', 'es', 'pt']) {
    assert.ok(sitemap.includes(`landing/${lang === 'en' ? '' : lang + '/'}</loc>`) || sitemap.includes('landing/</loc>'), `sitemap missing ${lang}`);
    assert.ok(sitemap.includes(`hreflang="${lang}"`), `sitemap alternates missing ${lang}`);
  }
  assert.ok(sitemap.includes('hreflang="x-default"'), 'sitemap missing x-default alternate');
  assert.match(sitemap, /<urlset[^>]*xmlns:xhtml/);
  assert.match(robots, /Sitemap: https?:\/\/\S+sitemap\.xml/);
  assert.match(robots, /Allow: \//);
});

await check('pages link into the app and the demo shop, not away', () => {
  for (const [lang, html] of Object.entries(pages)) {
    assert.ok(html.includes('href="../"') || html.includes('href="./"'), `${lang} app link`);
    assert.ok(html.includes('#/store/demo-cafe'), `${lang} demo link`);
  }
});
