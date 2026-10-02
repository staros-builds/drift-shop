#!/usr/bin/env node
/**
 * The whole safety net in one command — probe, copy, verify.
 *
 *   node tools/sync/sync.mjs [--mode seed|sync] [--with-auth] [--live] [--keep-dump]
 *
 * What it does, in order:
 *   1. Probe: are BOTH backends reachable right now? (The two databases
 *      "talk to each other" through this job — it hears both sides and
 *      compares what they say.)
 *   2. Copy: pg_dump the primary, restore it into the standby. The
 *      standby is OVERWRITTEN — it is a safety copy, never a second
 *      till. Only the primary ever takes real sales; that is what
 *      keeps the two from ever disagreeing (see docs/backend-mesh.md).
 *   3. Verify: row counts on both sides must match. A mismatch exits
 *      non-zero so schedulers (GitHub Actions) raise the alarm.
 *
 * DRY RUN BY DEFAULT: prints every command, writes nothing anywhere.
 * --live requires SYNC_ALLOW_WRITE=1 in the environment.
 * Exit codes: 0 ok · 1 unreachable/mismatch (ALARM) · 2 bad config.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readConfig, describeConfig } from './lib/env.mjs';
import { probe, discoverTables, fetchCounts } from './lib/rest.mjs';
import { compareCounts, formatReport } from './lib/verify.mjs';
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const get = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
};
const mode = get('--mode') || 'sync';
const withAuth = args.includes('--with-auth');
const live = args.includes('--live');
const keepDump = args.includes('--keep-dump');

const cfg = readConfig();
console.log(`Backend mesh sync — mode=${mode}${withAuth ? ' +auth' : ''}, ${live ? 'LIVE' : 'DRY RUN'}`);
if (cfg.missing.length) {
  console.log(`Missing environment variables: ${cfg.missing.join(', ')}`);
  console.log('(Placeholders are fine for a dry run; a live run needs them all. See docs/backend-mesh.md.)');
}

// --- 1. Probe both backends -------------------------------------------
let probeFailed = false;
for (const [name, side] of [['PRIMARY', cfg.primary], ['STANDBY', cfg.standby]]) {
  if (!side.url || !side.anonKey) {
    console.log(`probe ${name}: skipped (not configured)`);
    continue;
  }
  const r = await probe(side.url, side.anonKey);
  console.log(`probe ${name}: ${r.ok ? `reachable (${r.detail}, ${r.ms} ms)` : `UNREACHABLE (${r.detail})`}`);
  if (!r.ok) probeFailed = true;
}
if (probeFailed) {
  console.error('A backend cannot be reached — not attempting a copy. Treat this as an alarm.');
  process.exit(1);
}

// --- 2. Copy primary -> standby ---------------------------------------
const workDir = mkdtempSync(join(tmpdir(), 'drift-sync-'));
const dumpFile = join(workDir, `drift-${mode}.sql`);
const runTool = (script, scriptArgs) =>
  spawnSync(process.execPath, [new URL(`./${script}`, import.meta.url).pathname, ...scriptArgs], {
    stdio: 'inherit',
    env: process.env,
  }).status ?? 1;

try {
  const expArgs = ['--out', dumpFile, '--mode', mode, ...(withAuth ? ['--with-auth'] : []), ...(live ? ['--live'] : [])];
  const resArgs = ['--in', dumpFile, '--mode', mode, ...(withAuth ? ['--with-auth'] : []), ...(live ? ['--live'] : [])];
  if (runTool('export.mjs', expArgs) !== 0) {
    console.error('Export failed — standby untouched.');
    process.exit(1);
  }
  if (live && runTool('restore.mjs', resArgs) !== 0) {
    console.error('Restore failed — the standby may be half-loaded. Do NOT fail over to it.');
    process.exit(1);
  }
  if (!live) runTool('restore.mjs', resArgs); // prints its dry-run plan
} finally {
  if (!keepDump) rmSync(workDir, { recursive: true, force: true });
  else console.log(`Dump kept at ${dumpFile} — it contains the whole database; keep it private, delete it soon.`);
}

// --- 3. Verify the copies agree ---------------------------------------
if (cfg.primary.serviceKey && cfg.standby.serviceKey && cfg.primary.url && cfg.standby.url) {
  const fallback = JSON.parse(readFileSync(new URL('./tables.json', import.meta.url), 'utf8'));
  const countsFor = async (side) => {
    const tables = (await discoverTables(side.url, side.serviceKey)) || fallback;
    return fetchCounts(side.url, side.serviceKey, tables);
  };
  const result = compareCounts(await countsFor(cfg.primary), await countsFor(cfg.standby), {
    // Sales written while the dump was running legitimately lag a few
    // rows. Anything beyond 5 rows on one table deserves a look.
    tolerance: 5,
  });
  console.log(formatReport(result, { at: new Date().toISOString() }));
  if (!result.ok && live) {
    console.error('VERIFY FAILED after a live sync — alarm. Re-run; if it persists, do not trust the standby.');
    process.exit(1);
  }
  if (!result.ok) console.log('(Dry run: a mismatch here just describes the current gap between the two databases.)');
} else {
  console.log('Row-count verify skipped: service keys not configured for both projects.');
}
console.log(live ? 'Sync complete.' : 'DRY RUN complete — nothing was changed. Add --live (with SYNC_ALLOW_WRITE=1) to copy for real.');
