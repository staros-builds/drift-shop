#!/usr/bin/env node
/**
 * Export the primary database with pg_dump.
 *
 *   node tools/sync/export.mjs --out FILE.sql [--mode seed|sync] [--with-auth] [--live]
 *
 * Modes:
 *   seed  full public schema + data (CREATE + COPY, with DROPs). Used
 *         for the first load of a fresh standby and after migrations.
 *   sync  data-only COPY stream for public tables. The hourly mode:
 *         restore.mjs wipes the standby's public tables, loads this.
 *
 * --with-auth produces a SECOND file (FILE.sql -> FILE.auth.sql) with
 * auth.users + auth.identities so logins survive a failover. Sessions
 * are never copied: tokens are signed with the primary's secret and
 * the standby would reject them — users sign in again after failover.
 *
 * DRY RUN BY DEFAULT: prints the exact commands, runs nothing.
 * Add --live (and SYNC_ALLOW_WRITE=1) to actually run them.
 * Needs PRIMARY_DB_URL (postgres connection string; use the project's
 * Session pooler URI — see docs/backend-mesh.md).
 */
import { spawnSync } from 'node:child_process';
import { readConfig, redactDbUrl } from './lib/env.mjs';

const args = process.argv.slice(2);
const get = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
};
const out = get('--out');
const mode = get('--mode') || 'sync';
const withAuth = args.includes('--with-auth');
const live = args.includes('--live');

if (!out || !['seed', 'sync'].includes(mode)) {
  console.error('Usage: node tools/sync/export.mjs --out FILE.sql [--mode seed|sync] [--with-auth] [--live]');
  process.exit(2);
}

const cfg = readConfig();
if (!cfg.primary.dbUrl) {
  console.error('PRIMARY_DB_URL is not set (see docs/backend-mesh.md).');
  process.exit(2);
}

const authOut = out.replace(/(\.sql)?$/, '.auth.sql');
const commands = [];
const mainArgs = ['--no-owner', '--no-privileges', '--format=plain'];
if (mode === 'seed') mainArgs.push('--schema=public', '--clean', '--if-exists');
else mainArgs.push('--data-only', '--schema=public');
commands.push({ label: `dump primary (${mode})`, argv: ['pg_dump', ...mainArgs, '--file', out, cfg.primary.dbUrl] });
if (withAuth) {
  commands.push({
    label: 'dump primary auth users (logins)',
    argv: ['pg_dump', '--no-owner', '--no-privileges', '--format=plain', '--data-only', '--schema=auth',
      '--table=auth.users', '--table=auth.identities', '--file', authOut, cfg.primary.dbUrl],
  });
}

function printable(argv) {
  return argv.map((a) => (a === cfg.primary.dbUrl ? redactDbUrl(a) : a)).join(' ');
}

if (!live) {
  console.log('DRY RUN — nothing was executed. Commands that would run:');
  for (const c of commands) console.log(`  [${c.label}] ${printable(c.argv)}`);
  console.log('Add --live (and SYNC_ALLOW_WRITE=1) to run them for real.');
  process.exit(0);
}
if (process.env.SYNC_ALLOW_WRITE !== '1') {
  console.error('Refusing to write: set SYNC_ALLOW_WRITE=1 together with --live.');
  process.exit(2);
}
for (const c of commands) {
  console.log(`Running: [${c.label}] ${printable(c.argv)}`);
  const r = spawnSync(c.argv[0], c.argv.slice(1), { stdio: 'inherit' });
  if (r.error) {
    console.error(`Could not run pg_dump (${r.error.message}). Is postgresql-client installed?`);
    process.exit(1);
  }
  if ((r.status ?? 1) !== 0) process.exit(r.status ?? 1);
}
