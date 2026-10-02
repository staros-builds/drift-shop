#!/usr/bin/env node
/**
 * Keep-alive + health ping for every database in the mesh.
 *
 *   node tools/sync/keepalive.mjs [--targets FILE]
 *
 * Why this exists: free Supabase projects are PAUSED after a stretch
 * of inactivity (see docs/redundancy.md for the exact current terms).
 * The hourly sync already touches the primary and every sync-ready
 * target, which keeps those projects awake. This ping covers the
 * quiet gaps: slots that are created but not yet sync-ready, periods
 * when the sync workflow is disabled (e.g. after a failover), and a
 * cheap independent health signal for every backend at once.
 *
 * It probes PRIMARY and every target with a URL + anon key using the
 * same /rest/v1/ check as the app's boot screen (any HTTP answer =
 * the project is awake and reachable). A probe is PostgREST work, so
 * it also proves the project's API layer — not just DNS — is alive.
 *
 * Anon keys only. No service keys, no database URLs, no writes.
 * Exit 0 = everything configured answered · 1 = something did not
 * (ALARM) · 2 = nothing configured.
 */
import { loadTargets, targetConfig, targetReadiness } from './lib/targets.mjs';
import { readConfig } from './lib/env.mjs';
import { probe } from './lib/rest.mjs';

const args = process.argv.slice(2);
const get = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
};
const targetsFile = get('--targets') || new URL('./targets.json', import.meta.url).pathname;

const cfg = readConfig();
const sides = [];
if (cfg.primary.url && cfg.primary.anonKey) sides.push({ id: 'primary (live)', url: cfg.primary.url, anonKey: cfg.primary.anonKey });

let targets = [];
try {
  targets = loadTargets(targetsFile);
} catch (err) {
  console.error(err.message);
  process.exit(2);
}
for (const t of targets) {
  const c = targetConfig(process.env, t);
  if (targetReadiness(c) !== 'skip') sides.push({ id: c.id, url: c.url, anonKey: c.anonKey });
}

if (!sides.length) {
  console.log('Nothing configured to ping (set PRIMARY_URL/PRIMARY_ANON_KEY or any target <PREFIX>_URL + _ANON_KEY).');
  process.exit(2);
}

let failed = 0;
for (const side of sides) {
  const r = await probe(side.url, side.anonKey);
  console.log(`${side.id}: ${r.ok ? `awake (${r.detail}, ${r.ms} ms)` : `NO ANSWER (${r.detail})`} — ${side.url}`);
  if (!r.ok) failed++;
}
if (failed) {
  console.error(`keepalive: ${failed} backend(s) did not answer — alarm. A paused or dead standby cannot take over; check the projects.`);
  process.exit(1);
}
console.log('keepalive: every configured backend answered.');
