#!/usr/bin/env node
/**
 * Row counts for both backends, compared — "does the safety copy
 * match the live database?"
 *
 *   node tools/sync/counts.mjs [--tolerance N]
 *
 * Needs the service_role keys (RLS hides tables from the anon key).
 * Table list: discovered from each project's /rest/v1/ OpenAPI doc,
 * falling back to tools/sync/tables.json. Read-only — never writes.
 * Exits 1 when the copies do not match (alarm signal for schedulers).
 */
import { readFileSync } from 'node:fs';
import { readConfig } from './lib/env.mjs';
import { discoverTables, fetchCounts } from './lib/rest.mjs';
import { compareCounts, formatReport } from './lib/verify.mjs';

const args = process.argv.slice(2);
const tolIdx = args.indexOf('--tolerance');
const tolerance = tolIdx >= 0 ? Number.parseInt(args[tolIdx + 1], 10) || 0 : 0;

const cfg = readConfig();
if (!cfg.primary.serviceKey || !cfg.standby.serviceKey || !cfg.primary.url || !cfg.standby.url) {
  console.error('counts.mjs needs PRIMARY_URL, PRIMARY_SERVICE_KEY, STANDBY_URL and STANDBY_SERVICE_KEY (see docs/backend-mesh.md).');
  process.exit(2);
}

const fallback = JSON.parse(readFileSync(new URL('./tables.json', import.meta.url), 'utf8'));
async function countsFor(side) {
  const tables = (await discoverTables(side.url, side.serviceKey)) || fallback;
  return fetchCounts(side.url, side.serviceKey, tables);
}

const [primaryCounts, standbyCounts] = [await countsFor(cfg.primary), await countsFor(cfg.standby)];
const result = compareCounts(primaryCounts, standbyCounts, { tolerance });
console.log(formatReport(result, { at: new Date().toISOString() }));
process.exit(result.ok ? 0 : 1);
