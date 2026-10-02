#!/usr/bin/env node
/**
 * Multi-target fan-out for the backend mesh — probe/copy/verify the
 * primary into EVERY configured standby target from targets.json.
 *
 *   node tools/sync/sync-all.mjs [--mode seed|sync] [--with-auth] [--live] [--keep-dump]
 *   node tools/sync/sync-all.mjs --list            # who is configured, no probing
 *   node tools/sync/sync-all.mjs --emit-matrix     # GitHub Actions matrix JSON (sync-ready targets)
 *
 * For each target it runs the existing single-target sync.mjs with
 * STANDBY_* mapped from the target's prefixed env vars (see
 * lib/targets.mjs). sync.mjs itself is untouched: probe -> pg_dump ->
 * restore -> row-count verify, per target, one at a time.
 *
 * ONE WRITER, ALWAYS: targets only receive copies. Nothing here ever
 * writes to the primary, and restore.mjs has no code path that can.
 *
 * DRY RUN BY DEFAULT (inherited from sync.mjs): prints per-target
 * plans, writes nothing. --live still requires SYNC_ALLOW_WRITE=1.
 * Exit codes: 0 all targets ok (or none configured) · 1 a target
 * failed (ALARM) · 2 bad config.
 */
import { spawnSync } from 'node:child_process';
import { loadTargets, targetConfig, childEnvFor, describeTarget, targetReadiness } from './lib/targets.mjs';

const args = process.argv.slice(2);
const get = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
};
const mode = get('--mode') || 'sync';
const withAuth = args.includes('--with-auth');
const live = args.includes('--live');
const keepDump = args.includes('--keep-dump');
const targetsFile = get('--targets') || new URL('./targets.json', import.meta.url).pathname;

let targets;
try {
  targets = loadTargets(targetsFile);
} catch (err) {
  console.error(err.message);
  process.exit(2);
}

const configured = targets
  .map((t) => targetConfig(process.env, t))
  .filter((cfg) => targetReadiness(cfg) !== 'skip');

if (args.includes('--list')) {
  console.log(`Targets registry: ${targets.length} slot(s), ${configured.length} configured.`);
  for (const t of targets) console.log('  ' + describeTarget(targetConfig(process.env, t)));
  process.exit(0);
}

if (args.includes('--emit-matrix')) {
  const ready = configured.filter((cfg) => targetReadiness(cfg) === 'sync');
  console.log(JSON.stringify({ include: ready.map((cfg) => ({ id: cfg.id, prefix: cfg.prefix })) }));
  process.exit(0);
}

if (!configured.length) {
  console.log('No standby targets configured — nothing to sync. Set <PREFIX>_URL / _ANON_KEY / _SERVICE_KEY / _DB_URL for a target in tools/sync/targets.json (see docs/redundancy.md).');
  process.exit(0);
}

console.log(`Backend mesh sync-all — mode=${mode}${withAuth ? ' +auth' : ''}, ${live ? 'LIVE' : 'DRY RUN'} — ${configured.length} target(s)`);
let failed = 0;
for (const cfg of configured) {
  const target = targets.find((t) => t.id === cfg.id);
  console.log(`\n=== ${describeTarget(cfg)} ===`);
  if (targetReadiness(cfg) !== 'sync') {
    console.log(`Skipping ${cfg.id}: only partially configured (probe-only). Full sync needs ${cfg.prefix}_URL, ${cfg.prefix}_ANON_KEY, ${cfg.prefix}_SERVICE_KEY and ${cfg.prefix}_DB_URL.`);
    continue;
  }
  const childArgs = ['--mode', mode, ...(withAuth ? ['--with-auth'] : []), ...(live ? ['--live'] : []), ...(keepDump ? ['--keep-dump'] : [])];
  const res = spawnSync(process.execPath, [new URL('./sync.mjs', import.meta.url).pathname, ...childArgs], {
    stdio: 'inherit',
    env: childEnvFor(process.env, target),
  });
  const status = res.status ?? 1;
  if (status !== 0) {
    failed++;
    console.error(`Target ${cfg.id} finished with exit ${status} — it does NOT hold a verified copy right now.`);
  }
}

if (failed) {
  console.error(`\nsync-all: ${failed} of ${configured.length} target(s) FAILED — alarm. The failed copies must not be used for failover until a green run.`);
  process.exit(1);
}
console.log(`\nsync-all: every configured target holds a verified copy.`);
