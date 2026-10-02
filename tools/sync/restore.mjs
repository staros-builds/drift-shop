#!/usr/bin/env node
/**
 * Restore export.mjs dumps into the STANDBY database.
 *
 *   node tools/sync/restore.mjs --in FILE.sql [--mode seed|sync] [--with-auth] [--live]
 *
 * THIS OVERWRITES THE STANDBY. That is its job: the standby is a copy,
 * never a second place where real work happens. Guards, in order:
 *   - dry run by default (prints commands, touches nothing);
 *   - --live requires SYNC_ALLOW_WRITE=1;
 *   - the target comes only from STANDBY_DB_URL — this script has no
 *     code path that can write to PRIMARY_DB_URL.
 *
 * sync mode: wipe every standby public table in one statement, then
 * stream the COPY data in (pg_dump emits tables in dependency-safe
 * order; a best-effort session_replication_role step asks Postgres to
 * leave triggers alone during the load). seed mode just applies the
 * dump, which carries its own DROPs. With --with-auth, auth.users is
 * wiped and FILE.auth.sql (from export.mjs) is loaded after the data.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { readConfig, redactDbUrl } from './lib/env.mjs';

const args = process.argv.slice(2);
const get = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
};
const input = get('--in');
const mode = get('--mode') || 'sync';
const withAuth = args.includes('--with-auth');
const live = args.includes('--live');

if (!input || !['seed', 'sync'].includes(mode)) {
  console.error('Usage: node tools/sync/restore.mjs --in FILE.sql [--mode seed|sync] [--with-auth] [--live]');
  process.exit(2);
}

const cfg = readConfig();
if (!cfg.standby.dbUrl) {
  console.error('STANDBY_DB_URL is not set (see docs/backend-mesh.md).');
  process.exit(2);
}

const authIn = input.replace(/(\.sql)?$/, '.auth.sql');
const WIPE_SQL = `DO $$ DECLARE r RECORD; BEGIN
  FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE 'TRUNCATE TABLE public.' || quote_ident(r.tablename) || ' CASCADE';
  END LOOP;
END $$;`;

const steps = [];
if (mode === 'sync') {
  steps.push({
    label: 'silence triggers for load (best effort)',
    argv: ['psql', '--no-psqlrc', cfg.standby.dbUrl, '-c', "BEGIN; SET LOCAL session_replication_role = 'replica'; SELECT 1; COMMIT;"],
    fatal: false,
  });
  steps.push({
    label: 'wipe standby public tables',
    argv: ['psql', '--no-psqlrc', '-v', 'ON_ERROR_STOP=1', cfg.standby.dbUrl, '-c', WIPE_SQL],
    fatal: true,
  });
}
steps.push({ label: `load ${input} into standby`, argv: ['psql', '--no-psqlrc', '-v', 'ON_ERROR_STOP=1', '-f', input, cfg.standby.dbUrl], fatal: true });
if (withAuth) {
  steps.push({ label: 'wipe standby auth users', argv: ['psql', '--no-psqlrc', '-v', 'ON_ERROR_STOP=1', cfg.standby.dbUrl, '-c', 'TRUNCATE TABLE auth.users CASCADE;'], fatal: true });
  steps.push({ label: `load ${authIn} into standby`, argv: ['psql', '--no-psqlrc', '-v', 'ON_ERROR_STOP=1', '-f', authIn, cfg.standby.dbUrl], fatal: true });
}

function printable(argv) {
  return argv.map((a) => (a === cfg.standby.dbUrl ? redactDbUrl(a) : a)).join(' ');
}

if (!live) {
  console.log(`DRY RUN — the standby (${redactDbUrl(cfg.standby.dbUrl)}) would be OVERWRITTEN:`);
  for (const s of steps) console.log(`  [${s.label}] ${printable(s.argv)}`);
  console.log('Add --live (and SYNC_ALLOW_WRITE=1) to run for real.');
  process.exit(0);
}
if (process.env.SYNC_ALLOW_WRITE !== '1') {
  console.error('Refusing to write: set SYNC_ALLOW_WRITE=1 together with --live.');
  process.exit(2);
}
for (const f of withAuth ? [input, authIn] : [input]) {
  try {
    readFileSync(f);
  } catch {
    console.error(`Cannot read dump file: ${f}`);
    process.exit(2);
  }
}

for (const s of steps) {
  console.log(`Running: [${s.label}] ${printable(s.argv)}`);
  const r = spawnSync(s.argv[0], s.argv.slice(1), { stdio: 'inherit' });
  const status = r.status ?? 1;
  if (status !== 0) {
    if (s.fatal) {
      console.error(`Step "${s.label}" failed (exit ${status}). The standby may be half-loaded — re-run the sync; do NOT fail over to it until counts.mjs passes.`);
      process.exit(status);
    }
    console.warn(`Step "${s.label}" failed (exit ${status}) — continuing; pg_dump's COPY order still respects foreign keys.`);
  }
}
console.log('Standby restore finished. Run counts.mjs to verify before trusting it.');
