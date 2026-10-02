/**
 * Standby-target registry for the multi-copy database mesh.
 *
 * The single-target tools (probe/export/restore/counts/sync) read the
 * PRIMARY_* and STANDBY_* environment variables. This module is the
 * fan-out layer on top: a small committed registry (targets.json,
 * metadata only) names up to 9 standby slots, each with an env-var
 * PREFIX. A target's secrets live under <PREFIX>_URL,
 * <PREFIX>_ANON_KEY, <PREFIX>_SERVICE_KEY and <PREFIX>_DB_URL (the
 * _SUPABASE_URL / _DATABASE_URL spellings are also accepted, exactly
 * like lib/env.mjs). childEnvFor() maps one target onto the STANDBY_*
 * names so sync.mjs can run once per target, unchanged.
 *
 * There is still only ever ONE writer: every target is a read-only
 * copy of the primary. This module never writes anywhere itself.
 */
import { readFileSync } from 'node:fs';
import { redactDbUrl, redactKey } from './env.mjs';

export const MAX_TARGETS = 9; // primary + 9 = 10 databases

const PREFIX_RE = /^[A-Z][A-Z0-9_]*$/;
const ID_RE = /^[a-z][a-z0-9-]*$/;
// targets.json is committed to the repo: refuse anything that looks
// like real connection material so a secret can never land here by
// accident.
const FORBIDDEN_FIELDS = ['url', 'anonKey', 'serviceKey', 'dbUrl', 'password', 'key', 'token'];

function pick(env, ...names) {
  for (const name of names) {
    const v = env[name];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

/** Load + validate the registry file. Throws with a plain message. */
export function loadTargets(file) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`Cannot read targets registry (${file}): ${err.message}`);
  }
  return validateTargets(parsed);
}

/** Validate registry shape (also usable on an in-memory object). */
export function validateTargets(parsed) {
  if (!parsed || !Array.isArray(parsed.targets)) {
    throw new Error('Targets registry must be an object with a "targets" array.');
  }
  const targets = parsed.targets;
  if (!targets.length) throw new Error('Targets registry lists no targets.');
  if (targets.length > MAX_TARGETS) {
    throw new Error(`Too many targets: ${targets.length}. Max is ${MAX_TARGETS} (primary + ${MAX_TARGETS} copies = 10 databases).`);
  }
  const ids = new Set();
  const prefixes = new Set();
  for (const t of targets) {
    if (!t || typeof t !== 'object') throw new Error('Every target must be an object.');
    for (const f of FORBIDDEN_FIELDS) {
      if (f in t) throw new Error(`Target "${t.id || '?'}": field "${f}" is not allowed in targets.json — secrets belong in environment variables, never in this committed file.`);
    }
    if (!ID_RE.test(t.id || '')) throw new Error(`Bad target id "${t.id}": lowercase slug like "standby-2" expected.`);
    if (ids.has(t.id)) throw new Error(`Duplicate target id "${t.id}".`);
    ids.add(t.id);
    if (!PREFIX_RE.test(t.envPrefix || '')) throw new Error(`Target "${t.id}": bad envPrefix "${t.envPrefix}" (uppercase env-var prefix like STANDBY2 expected).`);
    if (t.envPrefix === 'PRIMARY') throw new Error(`Target "${t.id}": envPrefix PRIMARY is reserved for the live database — targets are copies only.`);
    if (prefixes.has(t.envPrefix)) throw new Error(`Duplicate envPrefix "${t.envPrefix}".`);
    prefixes.add(t.envPrefix);
  }
  return targets;
}

/** Read one target's values out of the environment. */
export function targetConfig(env, target) {
  const p = target.envPrefix;
  return {
    id: target.id,
    prefix: p,
    url: pick(env, `${p}_URL`, `${p}_SUPABASE_URL`),
    anonKey: pick(env, `${p}_ANON_KEY`, `${p}_SUPABASE_ANON_KEY`),
    serviceKey: pick(env, `${p}_SERVICE_KEY`, `${p}_SUPABASE_SERVICE_KEY`),
    dbUrl: pick(env, `${p}_DB_URL`, `${p}_DATABASE_URL`),
  };
}

/**
 * What can we do with this target right now?
 *   'skip'     — no address configured at all (slot not created yet)
 *   'probe'    — address + anon key: reachable check / keep-alive ping
 *   'sync'     — everything present: full copy + verify
 */
export function targetReadiness(cfg) {
  if (!cfg.url) return 'skip';
  if (cfg.url && cfg.anonKey && cfg.serviceKey && cfg.dbUrl) return 'sync';
  return 'probe';
}

/**
 * Build the child-process environment that points the single-target
 * tools (sync.mjs etc.) at this target: PRIMARY_* passes through
 * untouched; STANDBY_* is filled from the target's prefixed vars.
 */
export function childEnvFor(env, target) {
  const cfg = targetConfig(env, target);
  const child = { ...env };
  child.STANDBY_URL = cfg.url;
  child.STANDBY_ANON_KEY = cfg.anonKey;
  child.STANDBY_SERVICE_KEY = cfg.serviceKey;
  child.STANDBY_DB_URL = cfg.dbUrl;
  return child;
}

/** Redacted one-line description of a target's configuration. */
export function describeTarget(cfg) {
  return `${cfg.id} [${cfg.prefix}] url=${cfg.url || '(not set)'} anonKey=${redactKey(cfg.anonKey)} serviceKey=${redactKey(cfg.serviceKey)} dbUrl=${redactDbUrl(cfg.dbUrl)} readiness=${targetReadiness(cfg)}`;
}
