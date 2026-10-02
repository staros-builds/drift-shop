/**
 * Unit tests for the multi-target standby registry (tools/sync/lib/targets.mjs).
 * Run: node test/sync-targets.test.mjs
 *
 * The registry is committed to the repo and names up to 9 standby
 * slots; this guards the rules that keep it safe: metadata only
 * (secrets can never be committed here), unique ids/prefixes, PRIMARY
 * never a target, and correct env mapping onto the STANDBY_* names
 * the single-target tools read.
 */
import assert from 'node:assert/strict';
import { loadTargets, validateTargets, targetConfig, childEnvFor, targetReadiness, MAX_TARGETS } from '../tools/sync/lib/targets.mjs';

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

const good = () => ({
  targets: [
    { id: 'standby-1', envPrefix: 'STANDBY', role: 'hot-standby' },
    { id: 'standby-2', envPrefix: 'STANDBY2', role: 'hot-standby' },
  ],
});

check('valid registry passes and returns the targets', () => {
  const t = validateTargets(good());
  assert.equal(t.length, 2);
});

check('the committed targets.json is valid and holds 9 slots (10 databases with the primary)', () => {
  const t = loadTargets(new URL('../tools/sync/targets.json', import.meta.url).pathname);
  assert.equal(t.length, MAX_TARGETS);
  assert.equal(t[0].envPrefix, 'STANDBY');
});

check('secrets material in the registry is refused', () => {
  const bad = good();
  bad.targets[0].url = 'https://example.supabase.co';
  assert.throws(() => validateTargets(bad), /not allowed/);
  const bad2 = good();
  bad2.targets[0].serviceKey = 'sekret';
  assert.throws(() => validateTargets(bad2), /not allowed/);
});

check('duplicate ids and prefixes are refused', () => {
  const a = good();
  a.targets[1].id = 'standby-1';
  assert.throws(() => validateTargets(a), /Duplicate target id/);
  const b = good();
  b.targets[1].envPrefix = 'STANDBY';
  assert.throws(() => validateTargets(b), /Duplicate envPrefix/);
});

check('PRIMARY can never be a target', () => {
  const bad = good();
  bad.targets[0].envPrefix = 'PRIMARY';
  assert.throws(() => validateTargets(bad), /reserved/);
});

check('more than 9 targets is refused (10 databases is the whole design)', () => {
  const many = { targets: [] };
  for (let i = 1; i <= MAX_TARGETS + 1; i++) many.targets.push({ id: `standby-${i}`, envPrefix: `STANDBY${i}` });
  assert.throws(() => validateTargets(many), /Too many targets/);
});

check('targetConfig reads the prefixed vars, both URL spellings', () => {
  const env = {
    STANDBY2_URL: 'https://two.supabase.co',
    STANDBY2_ANON_KEY: 'a.b.c',
    STANDBY2_SERVICE_KEY: 'd.e.f',
    STANDBY2_DATABASE_URL: 'postgres://db.example/two',
  };
  const cfg = targetConfig(env, { id: 'standby-2', envPrefix: 'STANDBY2' });
  assert.equal(cfg.url, 'https://two.supabase.co');
  assert.equal(cfg.dbUrl, 'postgres://db.example/two');
  assert.equal(targetReadiness(cfg), 'sync');
});

check('readiness: empty slot skips, url+anon probes, full set syncs', () => {
  assert.equal(targetReadiness({ url: '', anonKey: '' }), 'skip');
  assert.equal(targetReadiness({ url: 'https://x', anonKey: 'a' }), 'probe');
  assert.equal(targetReadiness({ url: 'https://x', anonKey: 'a', serviceKey: 's', dbUrl: 'postgres://x' }), 'sync');
});

check('childEnvFor maps the target onto STANDBY_* and leaves PRIMARY_* alone', () => {
  const env = {
    PRIMARY_URL: 'https://live.supabase.co',
    PRIMARY_DB_URL: 'postgres://db.example/live',
    STANDBY9_URL: 'https://nine.supabase.co',
    STANDBY9_ANON_KEY: 'n.o.p',
    STANDBY9_SERVICE_KEY: 'q.r.s',
    STANDBY9_DB_URL: 'postgres://db.example/nine',
  };
  const child = childEnvFor(env, { id: 'standby-9', envPrefix: 'STANDBY9' });
  assert.equal(child.STANDBY_URL, 'https://nine.supabase.co');
  assert.equal(child.STANDBY_DB_URL, 'postgres://db.example/nine');
  assert.equal(child.PRIMARY_URL, 'https://live.supabase.co');
  assert.equal(env.STANDBY_URL, undefined, 'caller env must not be mutated');
});

console.log(process.exitCode ? '\nsync-targets: FAILURES above' : '\nsync-targets: all passed');
