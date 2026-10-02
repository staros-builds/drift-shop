#!/usr/bin/env node
/**
 * Health probe for both backends — "can each service hear the other?"
 *
 *   node tools/sync/probe.mjs
 *
 * Uses only the anon keys against /rest/v1/, exactly like the app's
 * boot self-check: any HTTP answer (even 401) means the provider is
 * alive. Prints a one-line verdict per backend and exits non-zero if
 * either is unreachable, so schedulers can alarm on it.
 */
import { readConfig } from './lib/env.mjs';
import { probe } from './lib/rest.mjs';

const cfg = readConfig();
let failed = false;
for (const [name, side] of [['PRIMARY (live)', cfg.primary], ['STANDBY (safety copy)', cfg.standby]]) {
  if (!side.url || !side.anonKey) {
    console.log(`${name}: not configured (set ${name.startsWith('PRIMARY') ? 'PRIMARY' : 'STANDBY'}_URL and _ANON_KEY)`);
    failed = true;
    continue;
  }
  const r = await probe(side.url, side.anonKey);
  console.log(`${name}: ${r.ok ? `reachable (${r.detail}, ${r.ms} ms)` : `UNREACHABLE (${r.detail})`} — ${side.url}`);
  if (!r.ok) failed = true;
}
process.exit(failed ? 1 : 0);
