// Conformance runner: supabase adapter (node).
// Needs a confirmed test user — create one in the Supabase dashboard
// (Authentication → Users → Add user, auto-confirm), run, then delete it:
//
//   VITE_SUPABASE_URL=... VITE_SUPABASE_ANON_KEY=... \
//   DRIFT_TEST_EMAIL=... DRIFT_TEST_PASSWORD=... \
//   node tests/run-supabase.js
//
// (esbuild bundles import.meta.env since plain node has no Vite env.)
import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const email = process.env.DRIFT_TEST_EMAIL;
const password = process.env.DRIFT_TEST_PASSWORD;
const envUrl = process.env.VITE_SUPABASE_URL;
const envKey = process.env.VITE_SUPABASE_ANON_KEY;
if (!email || !password || !envUrl || !envKey) {
  console.error('Set VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, DRIFT_TEST_EMAIL, DRIFT_TEST_PASSWORD.');
  process.exit(2);
}

const dir = new URL('.', import.meta.url).pathname;
writeFileSync(
  dir + 'entry-supabase.mjs',
  `import { runConformance } from './conformance.js';\n` +
    `import { createSupabaseBackend } from '../src/lib/backend/supabase.js';\n` +
    `const summary = await runConformance(createSupabaseBackend, {\n` +
    `  label: 'supabase',\n` +
    `  auth: { mode: 'signin', email: ${JSON.stringify(email)}, password: ${JSON.stringify(password)} },\n` +
    `});\n` +
    `process.exit(summary.failed.length ? 1 : 0);\n`
);
execSync(
  `npx esbuild ${dir}entry-supabase.mjs --bundle --platform=node --format=esm ` +
    `--define:import.meta.env='{"VITE_SUPABASE_URL":${JSON.stringify(envUrl)},"VITE_SUPABASE_ANON_KEY":${JSON.stringify(envKey)}}' ` +
    `--outfile=${dir}bundle-supabase.mjs --log-level=error`,
  { cwd: dir + '..', stdio: 'inherit' }
);
execSync(`node ${dir}bundle-supabase.mjs`, { stdio: 'inherit' });
