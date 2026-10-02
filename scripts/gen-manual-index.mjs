// Generates public/manual/manual-index.json from the finalized manual PDF.
// One entry per page: page number + plain text. Run AFTER the manual PDF is
// copied into public/manual/vendra-manual.pdf.
// Usage: node scripts/gen-manual-index.mjs
import { execFileSync } from 'child_process';
import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pdf = join(root, 'public/manual/vendra-manual.pdf');
const out = join(root, 'public/manual/manual-index.json');

const info = execFileSync('pdfinfo', [pdf], { encoding: 'utf8' });
const pages = parseInt(info.match(/Pages:\s+(\d+)/)[1], 10);
const entries = [];
for (let p = 1; p <= pages; p++) {
  const text = execFileSync('pdftotext', ['-f', String(p), '-l', String(p), '-layout', pdf, '-'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const flat = text.replace(/\s+/g, ' ').trim();
  // Title = first substantial line of the page (usually the heading).
  const firstLine = (text.split('\n').map((l) => l.trim()).find((l) => l.length > 3) || `Page ${p}`).slice(0, 80);
  entries.push({ page: p, title: firstLine, text: flat });
}
writeFileSync(out, JSON.stringify({ version: 1, pages, entries }));
console.log(`wrote ${out}: ${pages} pages`);
