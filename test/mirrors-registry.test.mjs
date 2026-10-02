/**
 * Unit tests for the app-mirror registry (deploy/emit-matrix.mjs +
 * deploy/mirrors.json). Run: node test/mirrors-registry.test.mjs
 *
 * The registry is what the one-release fan-out deploys from. These
 * checks guard the design rules: x10 maximum, no host may need code
 * changes (identical dist everywhere), secrets are names only, the
 * committed registry lists SELECTED doors only (dropped hosts live in
 * docs/redundancy.md's survey, not here), and a dropped host without
 * a reason is refused wherever one is written.
 */
import assert from 'node:assert/strict';
import { loadRegistry, validateRegistry, MAX_HOSTS, DEPLOY_TYPES } from '../deploy/emit-matrix.mjs';

let n = 0;
function check(name, fn) {
  n++;
  try {
    fn();
    console.log(`  ok ${n} - ${name}`);
  } catch (e) {
    console.error(`  FAIL ${n} - ${name}: ${e.message}`);
    process.exitCode = 1;
  }
}

const host = (over = {}) => ({
  id: 'example',
  provider: 'Example',
  status: 'ready',
  deploy: { type: 'surge', codeChanges: 'none' },
  requiredSecrets: ['EXAMPLE_TOKEN'],
  requiredVars: [],
  ...over,
});

const SELECTED_DOORS = [
  'github-pages',
  'cloudflare-pages',
  'firebase-hosting',
  'surge',
  'netlify',
  'render',
  'bitbucket',
  'github-root-site',
  'neocities',
  'sevalla',
];

check('the committed registry validates and holds exactly the ten selected doors', () => {
  const hosts = loadRegistry(new URL('../deploy/mirrors.json', import.meta.url).pathname);
  assert.equal(hosts.length, 10);
  assert.deepEqual(hosts.map((h) => h.id), SELECTED_DOORS);
  assert.equal(hosts[0].id, 'github-pages');
  assert.equal(hosts[0].status, 'live');
});

check('exactly three doors are live and the other seven are pending-account', () => {
  const hosts = loadRegistry(new URL('../deploy/mirrors.json', import.meta.url).pathname);
  const live = hosts.filter((h) => h.status === 'live').map((h) => h.id);
  assert.deepEqual(live.sort(), ['cloudflare-pages', 'github-pages', 'netlify']);
  assert.equal(hosts.filter((h) => h.status === 'pending-account').length, 7);
});

check('the committed registry contains zero dropped entries (dropped hosts live in docs/redundancy.md)', () => {
  const hosts = loadRegistry(new URL('../deploy/mirrors.json', import.meta.url).pathname);
  assert.equal(hosts.filter((h) => h.status === 'dropped').length, 0);
  for (const droppedId of ['gitlab-pages', 'vercel', 'azure-static-web-apps', 'deno-deploy']) {
    assert.ok(!hosts.some((h) => h.id === droppedId), `${droppedId} must not be a registry entry`);
  }
});

check('no host in the registry may require code changes', () => {
  const hosts = loadRegistry(new URL('../deploy/mirrors.json', import.meta.url).pathname);
  for (const h of hosts) assert.equal(h.deploy.codeChanges, 'none', `${h.id} violates the identical-dist rule`);
});

check('the new deploy types are known mechanisms', () => {
  for (const t of ['bitbucket-git', 'github-root-git', 'neocities-api']) {
    assert.ok(DEPLOY_TYPES.includes(t), `${t} missing from DEPLOY_TYPES`);
    assert.doesNotThrow(() => validateRegistry({ hosts: [host({ deploy: { type: t, codeChanges: 'none' } })] }));
  }
  // Sevalla stays dashboard-wired: external, and it must stay out of the
  // Actions matrix filter's way (emit-matrix excludes 'external').
  const sevalla = loadRegistry(new URL('../deploy/mirrors.json', import.meta.url).pathname).find((h) => h.id === 'sevalla');
  assert.equal(sevalla.deploy.type, 'external');
});

check('dropped hosts must carry a reason', () => {
  const hosts = loadRegistry(new URL('../deploy/mirrors.json', import.meta.url).pathname);
  for (const h of hosts.filter((x) => x.status === 'dropped')) assert.ok(h.dropReason, `${h.id} dropped silently`);
});

check('a dropped host without a reason is refused', () => {
  assert.throws(
    () => validateRegistry({ hosts: [host({ status: 'dropped' })] }),
    /dropReason/,
  );
  assert.doesNotThrow(() =>
    validateRegistry({ hosts: [host({ status: 'dropped', dropReason: 'terms forbid commercial use' })] }),
  );
});

check('an eleventh host is refused (x10 is the ceiling)', () => {
  const many = { hosts: [] };
  for (let i = 0; i < MAX_HOSTS + 1; i++) many.hosts.push(host({ id: `h${i}` }));
  assert.throws(() => validateRegistry(many), /Too many hosts/);
});

check('a host demanding code changes is refused', () => {
  assert.throws(
    () => validateRegistry({ hosts: [host({ deploy: { type: 'surge', codeChanges: 'patch CSP per host' } })] }),
    /identical dist/,
  );
});

check('secret values can never be smuggled into the registry', () => {
  assert.throws(() => validateRegistry({ hosts: [host({ requiredSecrets: ['sk-live-123'] })] }), /ENV-STYLE names/);
});

check('duplicate host ids are refused', () => {
  assert.throws(() => validateRegistry({ hosts: [host(), host()] }), /unique/);
});

console.log(process.exitCode ? '\nmirrors-registry: FAILURES above' : '\nmirrors-registry: all passed');
