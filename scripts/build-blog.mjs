#!/usr/bin/env node
/**
 * Blog builder — converts markdown posts in landing/blog-src/ into
 * SEO-optimized static HTML pages in dist/blog/, plus a blog index.
 * Runs as part of the landing build pipeline.
 *
 * Usage: node scripts/build-blog.mjs [--out DIR]  (default: dist)
 */
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// SEO titles and descriptions per post slug
const POST_META = {
  'affordable-pos-system-small-business': {
    title: 'Affordable POS System for Small Business | Vendra',
    desc: 'Looking for an affordable POS system? Compare costs, features, and find the best value for your small business. Vendra: $350/year, no transaction fees.',
  },
  'square-alternative-independent-retailers': {
    title: 'Best Square Alternative for Independent Retailers | Vendra',
    desc: 'Square getting too expensive? Compare Square alternatives for independent retailers. Vendra offers POS, inventory & more at $350/year flat.',
  },
  'best-pos-bookstores': {
    title: 'Best POS System for Bookstores | Vendra',
    desc: "What's the best POS for bookstores? Features that matter, pricing compared, and why Vendra at $350/year is built for independent bookshops.",
  },
  'how-to-choose-pos-small-shop': {
    title: 'How to Choose a POS System for Your Small Shop | Vendra',
    desc: 'Choosing a POS system? This guide covers features, pricing, and pitfalls. Vendra: the beginner-friendly POS at $350/year.',
  },
  'pos-system-no-monthly-fees': {
    title: 'POS System with No Monthly Fees | Vendra',
    desc: 'Tired of monthly POS fees? Compare no-monthly-fee POS options. Vendra: $350/year flat, no monthly billing, no transaction fees.',
  },
  'multilingual-pos-system': {
    title: 'Multilingual POS System (EN/FR/ES/PT) | Vendra',
    desc: 'Need a POS in French, Spanish, or Portuguese? Vendra ships with 4 languages built in. $350/year, no extra charge.',
  },
  'pos-barbershops': {
    title: 'POS System for Barbershops | Vendra',
    desc: 'Best POS for barbershops? Appointment booking, staff management & payments. Vendra does it all at $350/year.',
  },
  'inventory-management-small-retail': {
    title: 'Inventory Management for Small Retail | Vendra',
    desc: "Small retail inventory management doesn't need enterprise software. Vendra: stock tracking, alerts & more at $350/year.",
  },
  'how-much-pos-system-cost-2026': {
    title: 'How Much Does a POS System Cost in 2026? | Vendra',
    desc: "POS system costs compared: Square, Lightspeed, Shopify vs Vendra's $350/year. See the real numbers for 2026.",
  },
  'offline-pos-system': {
    title: 'Offline POS System Guide | Vendra',
    desc: 'What to look for in an offline-capable POS system. Test Vendra free for 30 days and see how it handles your shop.',
  },
};

function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function mdToHtml(md) {
  const lines = md.split('\n');
  const out = [];
  let inList = false;
  for (const line of lines) {
    const s = line.trim();
    if (s.startsWith('### ')) {
      if (inList) { out.push('</ul>'); inList = false; }
      out.push(`<h3>${esc(s.slice(4))}</h3>`);
    } else if (s.startsWith('## ')) {
      if (inList) { out.push('</ul>'); inList = false; }
      out.push(`<h2>${esc(s.slice(3))}</h2>`);
    } else if (s.startsWith('# ')) {
      if (inList) { out.push('</ul>'); inList = false; }
      out.push(`<h1>${esc(s.slice(2))}</h1>`);
    } else if (s.startsWith('- ') || s.startsWith('* ')) {
      if (!inList) { out.push('<ul>'); inList = true; }
      let t = s.slice(2);
      t = t.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
      t = t.replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2">$1</a>');
      out.push(`<li>${t}</li>`);
    } else if (s === '') {
      if (inList) { out.push('</ul>'); inList = false; }
      out.push('');
    } else {
      if (inList) { out.push('</ul>'); inList = false; }
      let t = s;
      t = t.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
      t = t.replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2">$1</a>');
      out.push(`<p>${t}</p>`);
    }
  }
  if (inList) out.push('</ul>');
  return out.join('\n');
}

function pageTemplate({ title, desc, canonical, baseUrl, content }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}" />
<link rel="canonical" href="${canonical}" />
<meta property="og:type" content="article" />
<meta property="og:title" content="${esc(title)}" />
<meta property="og:description" content="${esc(desc)}" />
<meta property="og:url" content="${canonical}" />
<style>
  :root{--paper:#f7f3ec;--card:#fffdf8;--ink:#26221c;--soft:#6d6252;--line:#e2d9c8;--accent:#b4542a}
  *{box-sizing:border-box}
  body{margin:0;background:var(--paper);color:var(--ink);font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;line-height:1.7}
  .wrap{max-width:720px;margin:0 auto;padding:0 20px}
  header{padding:20px 0;border-bottom:1px solid var(--line);margin-bottom:30px}
  header a{color:var(--accent);text-decoration:none;font-weight:700}
  h1{font-size:32px;line-height:1.2}
  h2{font-size:24px;margin-top:36px}
  h3{font-size:19px;margin-top:28px}
  .cta-box{background:var(--card);border:2px solid var(--accent);border-radius:12px;padding:24px;margin:32px 0;text-align:center}
  .cta-box a{display:inline-block;background:var(--accent);color:#fff;font-weight:700;text-decoration:none;border-radius:999px;padding:12px 28px;margin-top:12px}
  footer{margin:40px 0;padding:20px 0;border-top:1px solid var(--line);color:var(--soft);font-size:14px;text-align:center}
</style>
</head>
<body>
<div class="wrap">
<header><a href="${baseUrl}/landing/">&larr; Vendra</a></header>
<article>
${content}
<div class="cta-box">
<strong>Try Vendra free for 30 days</strong><br>
<span style="color:var(--soft)">POS, inventory, appointments, staff &amp; online ordering. $350/year flat.</span><br>
<a href="${baseUrl}/">Start Free Trial</a>
</div>
</article>
<footer>Vendra — Shop management for independents. $350/year, no transaction fees.</footer>
</div>
</body>
</html>`;
}

export async function buildBlog({ root, out, siteOrigin }) {
  const srcDir = path.join(root, 'landing', 'blog-src');
  const outDir = path.join(out, 'blog');
  await mkdir(outDir, { recursive: true });
  const written = [];

  let files;
  try {
    files = (await readdir(srcDir)).filter(f => f.endsWith('.md'));
  } catch {
    return written; // no blog source, skip silently
  }

  const baseUrl = siteOrigin.replace(/\/+$/, '');
  const indexItems = [];

  for (const file of files) {
    const slug = file.replace(/\.md$/, '');
    const meta = POST_META[slug] || { title: `${slug} | Vendra`, desc: 'Vendra blog post.' };
    const md = await readFile(path.join(srcDir, file), 'utf8');
    // Strip the first H1 (we use the SEO title instead)
    const mdLines = md.split('\n');
    if (mdLines[0].trim().startsWith('# ')) mdLines.shift();
    const bodyHtml = mdToHtml(mdLines.join('\n'));

    const html = pageTemplate({
      title: meta.title,
      desc: meta.desc,
      canonical: `${baseUrl}/blog/${slug}/`,
      baseUrl,
      content: bodyHtml,
    });

    const postDir = path.join(outDir, slug);
    await mkdir(postDir, { recursive: true });
    const dest = path.join(postDir, 'index.html');
    await writeFile(dest, html);
    written.push(dest);

    const short = meta.title.split(' | ')[0];
    indexItems.push({ slug, short, desc: meta.desc });
  }

  // Blog index
  const indexHtml = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Vendra Blog — POS Tips for Independent Retailers</title>
<meta name="description" content="Practical guides on choosing POS systems, managing inventory, and running your independent shop. From the makers of Vendra ($350/year)." />
<link rel="canonical" href="${baseUrl}/blog/" />
<style>
  body{font-family:ui-sans-serif,system-ui,sans-serif;max-width:720px;margin:0 auto;padding:20px;background:#f7f3ec;color:#26221c;line-height:1.7}
  a{color:#b4542a}
  li{margin:16px 0}
  .post-desc{color:#6d6252;font-size:14px}
</style>
</head>
<body>
<p><a href="${baseUrl}/landing/">&larr; Vendra</a></p>
<h1>Vendra Blog</h1>
<p>Practical guides for independent retailers.</p>
<ul>
${indexItems.map(p => `  <li><a href="${baseUrl}/blog/${p.slug}/"><strong>${esc(p.short)}</strong></a><br><span class="post-desc">${esc(p.desc)}</span></li>`).join('\n')}
</ul>
</body>
</html>`;
  const indexDest = path.join(outDir, 'index.html');
  await writeFile(indexDest, indexHtml);
  written.push(indexDest);

  return { written, slugs: files.map(f => f.replace(/\.md$/, '')) };
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isCli) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const outArg = process.argv.indexOf('--out');
  const out = outArg >= 0 ? path.resolve(process.argv[outArg + 1]) : path.join(root, 'dist');
  let siteOrigin = 'https://vendra-1f2.pages.dev';
  try {
    const cfg = JSON.parse(await readFile(path.join(root, 'landing', 'landing.config.json'), 'utf8'));
    if (cfg.siteOrigin) siteOrigin = cfg.siteOrigin;
  } catch { /* use default */ }
  buildBlog({ root, out, siteOrigin })
    .then(({ written }) => {
      console.log(`blog: wrote ${written.length} files to ${out}/blog`);
    })
    .catch((err) => {
      console.error(`blog: FAILED: ${err.message}`);
      process.exitCode = 1;
    });
}
