// Writes public/build.json just before `vite build` (public/ is copied
// into dist/, so dist/build.json ships with every build). The release
// workflow fetches each mirror's /build.json after deploy and compares
// buildId — the post-deploy smoke check. buildId is the git SHA when
// available so a mirror can be tied to an exact commit.
import { execSync } from 'node:child_process';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';

let sha = process.env.GITHUB_SHA || '';
if (!sha) {
  try {
    sha = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
  } catch {
    sha = '';
  }
}
let version = '0.0.0';
try {
  version = JSON.parse(readFileSync('package.json', 'utf8')).version || version;
} catch {
  /* keep default */
}
const buildId = (sha || `local-${Date.now()}`).slice(0, 40);
const payload = { buildId, builtAt: new Date().toISOString(), product: 'vendra', version };
mkdirSync('public', { recursive: true });
writeFileSync('public/build.json', JSON.stringify(payload, null, 2) + '\n');
console.log(`[build] buildId=${buildId}`);
