/**
 * Unit tests for the app-mirror registry (deploy/emit-matrix.mjs +
 * deploy/mirrors.json). Run: node test/mirrors-registry.test.mjs
 *
 * The registry is what the one-release fan-out deploys from. These
 * checks guard the design rules: x10 maximum, no host may need code
 * changes (identical dist everywhere), secrets are names only, and
 * dropped hosts must say why.
 */
import assert from 'node:assert/strict';
import { loadRegistry, validateRegistry, MAX_HOSTS } from '../deploy/emit-matrix.mjs';

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

check('the committed registry validates and holds the ten surveyed hosts', () => {
  const hosts = loadRegistry(new URL('../deploy/mirrors.json', import.meta.url).pathname);
  assert.equal(hosts.length, 10);
  assert.equal(hosts[0].id, 'github-pages');
  assert.equal(hosts[0].status, 'live');
});

check('no host in the registry may require code changes', () => {
  const hosts = loadRegistry(new URL('../deploy/mirrors.json', import.meta.url).pathname);
  for (const h of hosts) assert.equal(h.deploy.codeChanges, 'none', `${h.id} violates the identical-dist rule`);
});

check('dropped hosts must carry a reason', () => {
  const hosts = loadRegistry(new URL('../deploy/mirrors.json', import.meta.url).pathname);
  for (const h of hosts.filter((x) => x.status === 'dropped')) assert.ok(h.dropReason, `${h.id} dropped silently`);
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
