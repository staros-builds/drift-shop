// Byte-level bundle gate: a Vite build WITHOUT VITE_SUPABASE_URL /
// VITE_SUPABASE_ANON_KEY silently emits a ~146 KB boot stub while
// exiting 0 (the config checks constant-fold and the whole app is
// dead-code-eliminated). Never ship on exit code alone — verify the
// real app chunks exist and are plausibly sized.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const dist = process.argv[2] || 'dist';
const assets = join(dist, 'assets');
let files = [];
try {
  files = readdirSync(assets);
} catch {
  console.error(`[verify] no dist/assets at ${assets}`);
  process.exit(1);
}
const js = files.filter((f) => f.endsWith('.js'));
const sizes = js.map((f) => ({ f, bytes: statSync(join(assets, f)).size }));
const total = sizes.reduce((a, b) => a + b.bytes, 0);
const biggest = sizes.sort((a, b) => b.bytes - a.bytes)[0];
console.log(`[verify] ${js.length} js chunks, total ${(total / 1024).toFixed(0)} KiB, biggest ${biggest.f} ${(biggest.bytes / 1024).toFixed(0)} KiB`);

// The real app entry chunk is 1 MB+; the hollow stub is ~146 KB total.
if (total < 400 * 1024) {
  console.error('[verify] FAIL: bundle too small — this is the empty boot stub. Were VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY set?');
  process.exit(1);
}
// build.json must be present and parse (release smoke checks read it).
try {
  const bj = JSON.parse(readFileSync(join(dist, 'build.json'), 'utf8'));
  if (!bj.buildId) throw new Error('no buildId');
  console.log(`[verify] build.json ok (buildId=${bj.buildId})`);
} catch (e) {
  console.error(`[verify] FAIL: dist/build.json missing/invalid: ${e.message}`);
  process.exit(1);
}
console.log('[verify] bundle OK');
