#!/usr/bin/env node
/**
 * Landing page generator — builds the static, crawler-readable brand
 * home (EN/FR/ES/PT) into dist/landing/, plus sitemap.xml and
 * robots.txt at the dist root.
 *
 * Why a separate static page at all: the app is a client-rendered SPA
 * behind a hash route, so view-source of the app entry shows crawlers
 * an empty shell. The landing pages are plain hand-written HTML that
 * any crawler, messenger preview, or no-JS browser can read, and they
 * link INTO the app (config `appHref`). The SPA build is untouched:
 * this script only ADDS files after `vite build` finishes. See
 * docs/seo-positioning.md for the serving layouts (GitHub Pages
 * sub-path today, brand root domain later) and the config keys in
 * landing/landing.config.json.
 *
 * Tokens in landing/src/*.html: {{BRAND_NAME}}, {{SITE_ORIGIN}},
 * {{PAGE_URL}}, {{APP_HREF}}, {{DEMO_URL}}, {{ALTERNATES}},
 * {{UNLOCK_PRICE_LINE}}. The build FAILS if any token survives
 * substitution or any JSON-LD block does not parse — a half-rendered
 * landing must never ship silently.
 *
 * Usage: node scripts/build-landing.mjs [--out DIR]   (default: dist)
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const LANGS = ['en', 'fr', 'es', 'pt'];
const LOCALES = { en: 'en_US', fr: 'fr_CA', es: 'es_419', pt: 'pt_BR' };

function absUrl(config, pagePath) {
  const origin = String(config.siteOrigin || '').replace(/\/+$/, '');
  const base = String(config.basePath || '/').replace(/\/?$/, '/');
  return `${origin}${base}${pagePath}`.replace(/([^:])\/{2,}/g, '$1/');
}

export function alternatesBlock(config) {
  const lines = LANGS.map(
    (lang) =>
      `  <link rel="alternate" hreflang="${lang}" href="${absUrl(config, config.pages[lang])}" />`,
  );
  lines.push(
    `  <link rel="alternate" hreflang="x-default" href="${absUrl(config, config.pages.en)}" />`,
  );
  return lines.join('\n');
}

export function renderSitemap(config, lastmod, blogSlugs = []) {
  const urls = LANGS.map((lang) => {
    const loc = absUrl(config, config.pages[lang]);
    const alternates = [
      ...LANGS.map(
        (l) =>
          `    <xhtml:link rel="alternate" hreflang="${l}" href="${absUrl(config, config.pages[l])}"/>`,
      ),
      `    <xhtml:link rel="alternate" hreflang="x-default" href="${absUrl(config, config.pages.en)}"/>`,
    ].join('\n');
    return [
      '  <url>',
      `    <loc>${loc}</loc>`,
      `    <lastmod>${lastmod}</lastmod>`,
      alternates,
      '  </url>',
    ].join('\n');
  }).join('\n');
  // Blog URLs (no hreflang alternates — English only for now)
  const origin = String(config.siteOrigin || '').replace(/\/+$/, '');
  const blogUrls = blogSlugs.map((slug) => [
    '  <url>',
    `    <loc>${origin}/blog/${slug}/</loc>`,
    `    <lastmod>${lastmod}</lastmod>`,
    '  </url>',
  ].join('\n')).join('\n');
  const blogIndex = blogSlugs.length ? [
    '  <url>',
    `    <loc>${origin}/blog/</loc>`,
    `    <lastmod>${lastmod}</lastmod>`,
    '  </url>',
  ].join('\n') : '';
  const aboutUrl = [
    '  <url>',
    `    <loc>${origin}/about/</loc>`,
    `    <lastmod>${lastmod}</lastmod>`,
    '  </url>',
  ].join('\n');
  const allUrls = [urls, blogUrls, blogIndex, aboutUrl].filter(Boolean).join('\n');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">',
    allUrls,
    '</urlset>',
    '',
  ].join('\n');
}

export function renderRobots(config) {
  return [
    '# Vendra landing — every crawler is welcome; the app itself lives',
    '# behind the link on these pages and needs no separate entry.',
    'User-agent: *',
    'Allow: /',
    '',
    `Sitemap: ${absUrl(config, 'sitemap.xml')}`,
    '',
  ].join('\n');
}

async function brandName(root, config) {
  if (config.brandNameOverride) return config.brandNameOverride;
  try {
    const src = await readFile(path.join(root, 'src/lib/brand.js'), 'utf8');
    const m = src.match(/\bname:\s*'([^']+)'/);
    if (m) return m[1];
  } catch { /* fall through to the approved product name */ }
  return 'Vendra';
}

function validate(name, html) {
  const leftover = html.match(/\{\{[A-Z_]+\}\}/);
  if (leftover) throw new Error(`${name}: unreplaced token ${leftover[0]}`);
  for (const m of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    try {
      JSON.parse(m[1]);
    } catch (e) {
      throw new Error(`${name}: JSON-LD does not parse: ${e.message}`);
    }
  }
  return html;
}

export async function buildLanding({ root, out }) {
  const config = JSON.parse(await readFile(path.join(root, 'landing/landing.config.json'), 'utf8'));
  const name = await brandName(root, config);
  const lastmod = new Date().toISOString().slice(0, 10);
  const written = [];

  // Collect blog slugs for sitemap
  let blogSlugs = [];
  try {
    const { readdir } = await import('node:fs/promises');
    blogSlugs = (await readdir(path.join(root, 'landing', 'blog-src')))
      .filter(f => f.endsWith('.md'))
      .map(f => f.replace(/\.md$/, ''));
  } catch { /* no blog source */ }

  for (const lang of LANGS) {
    const src = await readFile(path.join(root, `landing/src/${lang}.html`), 'utf8');
    const pageUrl = absUrl(config, config.pages[lang]);
    const demoUrl = `${config.appHref}#/store/${config.demoSlug || 'demo-cafe'}`;
    const html = validate(
      `${lang}.html`,
      src
        .replaceAll('{{BRAND_NAME}}', name)
        .replaceAll('{{SITE_ORIGIN}}', String(config.siteOrigin || '').replace(/\/+$/, ''))
        .replaceAll('{{PAGE_URL}}', pageUrl)
        .replaceAll('{{APP_HREF}}', config.appHref || '../')
        .replaceAll('{{DEMO_URL}}', demoUrl)
        .replaceAll('{{ALTERNATES}}', alternatesBlock(config))
        .replaceAll('{{OG_LOCALE}}', LOCALES[lang])
        // The unlock price is the owner's to set. Until he does, every
        // language frames the model without a number; docs flag this
        // line as owner-to-confirm (see docs/seo-positioning.md).
        .replaceAll('{{UNLOCK_PRICE_LINE}}', UNLOCK_PRICE_LINES[lang]),
    );
    const dest = path.join(out, config.pages[lang], 'index.html');
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, html);
    written.push(dest);
  }

  const sitemap = path.join(out, 'sitemap.xml');
  await writeFile(sitemap, renderSitemap(config, lastmod, blogSlugs));
  written.push(sitemap);
  const robots = path.join(out, 'robots.txt');
  await writeFile(robots, renderRobots(config));
  written.push(robots);

  // About page (entity building for SEO)
  try {
    const aboutSrc = await readFile(path.join(root, 'landing', 'about-src.html'), 'utf8');
    const aboutDir = path.join(out, 'about');
    await mkdir(aboutDir, { recursive: true });
    const aboutDest = path.join(aboutDir, 'index.html');
    await writeFile(aboutDest, aboutSrc);
    written.push(aboutDest);
  } catch { /* no about page source */ }

  return written;
}

const UNLOCK_PRICE_LINES = {
  en: 'one unlock key at $350/year — and no monthly software bill, ever',
  fr: 'une seule clé d’activation à 350 $/an — et aucun abonnement mensuel, jamais',
  es: 'una sola clave de activación por $350/año, sin pagos mensuales de software, nunca',
  pt: 'uma única chave de ativação por $350/ano — e nenhuma mensalidade de software, nunca',
};

const isCli = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isCli) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const outArg = process.argv.indexOf('--out');
  const out = outArg >= 0 ? path.resolve(process.argv[outArg + 1]) : path.join(root, 'dist');
  buildLanding({ root, out })
    .then((files) => {
      console.log(`landing: wrote ${files.length} files to ${out}`);
      files.forEach((f) => console.log(`  ${path.relative(root, f)}`));
    })
    .catch((err) => {
      console.error(`landing: FAILED: ${err.message}`);
      process.exitCode = 1;
    });
}
