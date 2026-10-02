/**
 * Environment config for the sync tools + secret-safe logging helpers.
 *
 * Everything is read from environment variables — locally from your
 * shell, in automation from GitHub Actions secrets. Nothing is read
 * from files, and nothing secret is ever printed: database URLs are
 * redacted before they reach a log line.
 *
 * Expected variables (see docs/backend-mesh.md):
 *   PRIMARY_URL / PRIMARY_ANON_KEY / PRIMARY_SERVICE_KEY
 *   STANDBY_URL / STANDBY_ANON_KEY / STANDBY_SERVICE_KEY
 *   PRIMARY_DB_URL / STANDBY_DB_URL     (postgres connection strings)
 */

function pick(env, ...names) {
  for (const name of names) {
    const v = env[name];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

/** Mask the password in a postgres:// URL for safe log output. */
export function redactDbUrl(raw) {
  const s = String(raw || '');
  if (!s) return '(not set)';
  try {
    const u = new URL(s);
    if (u.password) u.password = '***';
    return u.toString();
  } catch {
    // Not a parseable URL — never echo it back; it may hold a password.
    return '(set, not a readable URL — not printed)';
  }
}

/** Mask a key for safe log output: length + shape only, never bytes. */
export function redactKey(raw) {
  const s = String(raw || '');
  if (!s) return '(not set)';
  return `(set, ${s.split('.').length} part(s), ${s.length} chars)`;
}

export function readConfig(env = process.env) {
  const primary = {
    url: pick(env, 'PRIMARY_URL', 'PRIMARY_SUPABASE_URL'),
    anonKey: pick(env, 'PRIMARY_ANON_KEY', 'PRIMARY_SUPABASE_ANON_KEY'),
    serviceKey: pick(env, 'PRIMARY_SERVICE_KEY', 'PRIMARY_SUPABASE_SERVICE_KEY'),
    dbUrl: pick(env, 'PRIMARY_DB_URL', 'PRIMARY_DATABASE_URL'),
  };
  const standby = {
    url: pick(env, 'STANDBY_URL', 'STANDBY_SUPABASE_URL'),
    anonKey: pick(env, 'STANDBY_ANON_KEY', 'STANDBY_SUPABASE_ANON_KEY'),
    serviceKey: pick(env, 'STANDBY_SERVICE_KEY', 'STANDBY_SUPABASE_SERVICE_KEY'),
    dbUrl: pick(env, 'STANDBY_DB_URL', 'STANDBY_DATABASE_URL'),
  };
  const missing = [];
  for (const [side, cfg] of [['PRIMARY', primary], ['STANDBY', standby]]) {
    for (const [field, varName] of [
      ['url', `${side}_URL`],
      ['anonKey', `${side}_ANON_KEY`],
      ['serviceKey', `${side}_SERVICE_KEY`],
      ['dbUrl', `${side}_DB_URL`],
    ]) {
      if (!cfg[field]) missing.push(varName);
    }
  }
  return { primary, standby, missing };
}

/**
 * Print the config situation (redacted). Returns true when every
 * variable needed for `need` ('rest' | 'db') is present.
 */
export function describeConfig(cfg, need = 'rest') {
  const fields = need === 'db' ? ['dbUrl'] : ['url', 'anonKey', 'serviceKey'];
  let complete = true;
  for (const [side, c] of [['PRIMARY', cfg.primary], ['STANDBY', cfg.standby]]) {
    for (const f of fields) {
      const shown = f === 'dbUrl' ? redactDbUrl(c[f]) : f === 'url' ? c[f] || '(not set)' : redactKey(c[f]);
      console.log(`  ${side} ${f}: ${shown}`);
      if (!c[f]) complete = false;
    }
  }
  return complete;
}
