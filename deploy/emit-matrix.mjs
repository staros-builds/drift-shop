#!/usr/bin/env node
/**
 * Emit the GitHub Actions deploy matrix from deploy/mirrors.json.
 *
 *   node deploy/emit-matrix.mjs            # {"include":[...]} for hosts the workflow can deploy
 *   node deploy/emit-matrix.mjs --check    # validate the registry, print a summary, no matrix
 *
 * The registry is the ONE place that lists the mirror hosts. Rules
 * enforced here (and by test/mirrors-registry.test.mjs):
 *   - at most 10 hosts (x10 is the whole design);
 *   - unique ids; deploy.type one of the known mechanisms;
 *   - NO host may require code changes: every entry must attest
 *     "codeChanges": "none" (same dist everywhere, relative base);
 *   - secrets/vars are NAMES only — values never live in the file.
 */
import { readFileSync } from 'node:fs';

export const MAX_HOSTS = 10;
export const DEPLOY_TYPES = [
  'github-pages', // actions/deploy-pages (primary today)
  'cloudflare-pages', // wrangler pages deploy
  'netlify-cli', // netlify deploy --prod --dir=dist
  'surge', // surge dist <domain>
  'firebase', // firebase deploy --only hosting
  'deno-deployctl', // deployctl deploy
  'render-hook', // curl a deploy-hook URL (host builds from git itself)
  'gitlab-ci', // built by .gitlab-ci.yml on GitLab; listed for completeness
  'external', // any other dashboard-wired host (documented per host)
];

export function loadRegistry(file) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`Cannot read mirrors registry (${file}): ${err.message}`);
  }
  return validateRegistry(parsed);
}

export function validateRegistry(parsed) {
  if (!parsed || !Array.isArray(parsed.hosts)) throw new Error('Mirrors registry must be an object with a "hosts" array.');
  const hosts = parsed.hosts;
  if (!hosts.length) throw new Error('Mirrors registry lists no hosts.');
  if (hosts.length > MAX_HOSTS) throw new Error(`Too many hosts: ${hosts.length}. The design is x${MAX_HOSTS} — consolidate instead of adding an eleventh door.`);
  const ids = new Set();
  for (const h of hosts) {
    if (!h || typeof h !== 'object') throw new Error('Every host must be an object.');
    if (!h.id || ids.has(h.id)) throw new Error(`Host ids must be present and unique (problem at "${h && h.id}").`);
    ids.add(h.id);
    if (!h.provider) throw new Error(`Host "${h.id}": provider is required.`);
    if (!h.deploy || !DEPLOY_TYPES.includes(h.deploy.type)) {
      throw new Error(`Host "${h.id}": deploy.type must be one of ${DEPLOY_TYPES.join(', ')}.`);
    }
    if (h.deploy.codeChanges !== 'none') {
      throw new Error(`Host "${h.id}": deploy.codeChanges must be "none" — every host serves the identical dist; a host needing code changes does not belong in the registry.`);
    }
    for (const [field, list] of [['requiredSecrets', h.requiredSecrets], ['requiredVars', h.requiredVars]]) {
      if (list === undefined) continue;
      if (!Array.isArray(list) || list.some((s) => typeof s !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(s))) {
        throw new Error(`Host "${h.id}": ${field} must be an array of ENV-STYLE names (values never live in this file).`);
      }
    }
    if (!['live', 'ready', 'pending-account', 'dropped'].includes(h.status)) {
      throw new Error(`Host "${h.id}": status must be live | ready | pending-account | dropped.`);
    }
    if (h.status === 'dropped' && !h.dropReason) throw new Error(`Host "${h.id}": dropped hosts need a dropReason (honesty beats hope — say why).`);
  }
  return hosts;
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const file = new URL('./mirrors.json', import.meta.url).pathname;
  try {
    const hosts = loadRegistry(file);
    if (process.argv.includes('--check')) {
      console.log(`mirrors.json OK: ${hosts.length} host(s)`);
      for (const h of hosts) console.log(`  ${h.id} — ${h.provider} [${h.status}] via ${h.deploy.type}`);
    } else {
      const include = hosts
        .filter((h) => h.status !== 'dropped' && !['github-pages', 'gitlab-ci', 'external'].includes(h.deploy.type))
        .map((h) => ({ id: h.id, type: h.deploy.type }));
      console.log(JSON.stringify({ include }));
    }
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }
}
