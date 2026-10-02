/**
 * Tests for the boot-time database failover (src/lib/dbEndpoints.js).
 * Run: node test/db-failover.test.mjs
 *
 * THE CONTRACT UNDER TEST (see docs/redundancy.md):
 *  - default off: no fallback env -> today's behavior, untouched.
 *  - boot only: primary probed a few times before any failover.
 *  - standby sessions are READ-ONLY: every mutation path (table writes,
 *    storage uploads, mutating RPCs, auth writes) rejects with the
 *    honest bilingual error. Reads pass through.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  readEndpointConfig,
  hasFallback,
  probeEndpoint,
  selectEndpointAtBoot,
  isWriteAllowed,
  writeBlockedError,
  guardClientForStandbyRead,
  setActiveEndpoint,
  clearActiveEndpoint,
  resolveSupabaseEndpoint,
  isStandbyReadMode,
} from '../src/lib/dbEndpoints.js';

let n = 0;
const failures = [];
function check(name, fn) {
  n++;
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ok ${n} - ${name}`))
    .catch((e) => {
      failures.push(name);
      console.error(`  FAIL ${n} - ${name}: ${e.message}`);
    });
}

// --- local HTTP stubs -------------------------------------------------------

function stubServer({ headStatus = 200, tableStatus = 200, tableBody = '[{"id":1}]' } = {}) {
  const srv = http.createServer((req, res) => {
    if (req.url === '/rest/v1/' && req.method === 'HEAD') {
      res.writeHead(headStatus);
      res.end();
      return;
    }
    if (req.url.startsWith('/rest/v1/pos_stores')) {
      res.writeHead(tableStatus, { 'content-type': 'application/json' });
      res.end(tableBody);
      return;
    }
    res.writeHead(404);
    res.end('nope');
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve(srv)));
}
const addr = (srv) => `http://127.0.0.1:${srv.address().port}`;

async function main() {
  const up = await stubServer(); // healthy endpoint
  const down = 'http://127.0.0.1:1'; // nothing listens here

  await check('no fallback env -> no fallback (default off)', () => {
    const cfg = readEndpointConfig({ VITE_SUPABASE_URL: 'https://x.supabase.co', VITE_SUPABASE_ANON_KEY: 'k' });
    assert.equal(hasFallback(cfg), false);
    assert.equal(cfg.fallbacks.length, 0);
  });

  await check('fallback pair + numbered slot are read; incomplete pairs dropped', () => {
    const cfg = readEndpointConfig({
      VITE_SUPABASE_URL: 'https://x.supabase.co',
      VITE_SUPABASE_ANON_KEY: 'k',
      VITE_SUPABASE_FALLBACK_URL: 'https://s1.supabase.co',
      VITE_SUPABASE_FALLBACK_ANON_KEY: 'k1',
      VITE_SUPABASE_FALLBACK2_URL: 'https://s2.supabase.co',
      VITE_SUPABASE_FALLBACK2_ANON_KEY: 'k2',
      VITE_SUPABASE_FALLBACK3_URL: 'https://orphan.supabase.co', // no key -> dropped
    });
    assert.equal(hasFallback(cfg), true);
    assert.deepEqual(
      cfg.fallbacks.map((f) => f.url),
      ['https://s1.supabase.co', 'https://s2.supabase.co'],
    );
  });

  await check('probeEndpoint: live host ok, dead host not', async () => {
    const ok = await probeEndpoint(addr(up), 'k', 2000);
    assert.equal(ok.ok, true);
    const bad = await probeEndpoint(down, 'k', 500);
    assert.equal(bad.ok, false);
    assert.ok(bad.detail);
  });

  const fast = { primaryAttempts: 2, retryDelayMs: 0 };

  await check('primary healthy -> live, standby never probed', async () => {
    const probed = [];
    const sel = await selectEndpointAtBoot(
      { primary: { url: addr(up), key: 'k' }, fallbacks: [{ url: addr(up), key: 'k' }] },
      {
        ...fast,
        selfCheck: async (u) => {
          probed.push(u);
          return { reachable: true, schemaOk: true, detail: '' };
        },
      },
    );
    assert.equal(sel.mode, 'live');
    assert.equal(sel.url, addr(up));
    assert.equal(probed.length, 1); // fallback untouched while primary answers
  });

  await check('primary down, fallback up -> standby-read on the fallback', async () => {
    const sel = await selectEndpointAtBoot(
      { primary: { url: down, key: 'k' }, fallbacks: [{ url: addr(up), key: 'k2' }] },
      fast,
    );
    assert.equal(sel.mode, 'standby-read');
    assert.equal(sel.url, addr(up));
    assert.equal(isWriteAllowed(sel.mode), false);
    assert.equal(isWriteAllowed('live'), true);
  });

  await check('primary down, no fallback -> down (today\u2019s behavior)', async () => {
    const sel = await selectEndpointAtBoot({ primary: { url: down, key: 'k' }, fallbacks: [] }, fast);
    assert.equal(sel.mode, 'down');
    assert.ok(sel.detail);
  });

  await check('both down -> down', async () => {
    const sel = await selectEndpointAtBoot(
      { primary: { url: down, key: 'k' }, fallbacks: [{ url: down, key: 'k' }] },
      fast,
    );
    assert.equal(sel.mode, 'down');
  });

  await check('standby with broken schema is skipped, not trusted', async () => {
    const badSchema = await stubServer({ tableStatus: 404, tableBody: '{"code":"PGRST205","message":"Could not find the table"}' });
    try {
      const sel = await selectEndpointAtBoot(
        { primary: { url: down, key: 'k' }, fallbacks: [{ url: addr(badSchema), key: 'k' }] },
        fast,
      );
      assert.equal(sel.mode, 'down');
    } finally {
      badSchema.close();
    }
  });

  // --- the read-only guard ----------------------------------------------------

  const chain = {};
  for (const m of ['select', 'eq', 'limit', 'single', 'order', 'gte', 'lte', 'in', 'is', 'like', 'range', 'maybeSingle', 'throwOnError']) {
    chain[m] = () => chain;
  }
  chain.then = (res) => res('read-ok');

  const mockClient = {
    from: (_t) => chain,
    rest: { from: (_t) => chain },
    storage: {
      from: (_b) => ({
        download: async () => 'bytes',
        list: async () => [],
        upload: async () => 'uploaded?!',
        remove: async () => [],
      }),
    },
    rpc: async (name) => ({ rpc: name }),
    auth: {
      signInWithPassword: async () => 'signed-in',
      signUp: async () => 'signed-up?!',
      updateUser: async () => 'updated?!',
      resetPasswordForEmail: async () => 'sent?!',
      getSession: async () => null,
      onAuthStateChange: () => () => {},
    },
    functions: { invoke: async () => 'invoked?!' },
  };
  const guarded = guardClientForStandbyRead(mockClient);

  await check('reads pass through the guard', async () => {
    assert.equal(await guarded.from('pos_stores').select('*').limit(1), 'read-ok');
    assert.equal(await guarded.rest.from('pos_stores').select('*'), 'read-ok');
    assert.equal(await guarded.storage.from('b').download('f'), 'bytes');
    assert.deepEqual(await guarded.rpc('public_storefront', {}), { rpc: 'public_storefront' });
    assert.equal(await guarded.auth.signInWithPassword({}), 'signed-in');
  });

  await check('table writes are refused (insert/update/delete/upsert, chained)', async () => {
    for (const m of ['insert', 'update', 'delete', 'upsert']) {
      await assert.rejects(guarded.from('pos_stores')[m]({}).select().single(), /Backup-copy mode/);
      await assert.rejects(guarded.rest.from('pos_stores')[m]({}), /Backup-copy mode/);
    }
    const err = await guarded.from('t').insert({}).catch((e) => e);
    assert.equal(err.code, 'standby-read-only');
    assert.match(err.message, /Réessayer le serveur principal/);
  });

  await check('mutating RPCs are refused; read-only RPCs pass', async () => {
    await assert.rejects(guarded.rpc('pos_apply_sale_stock', {}), /Backup-copy mode/);
    await assert.rejects(guarded.rpc('pos_refund_sale', {}), /Backup-copy mode/);
    await assert.rejects(guarded.rpc('admin_create_user', {}), /Backup-copy mode/);
  });

  await check('storage uploads refused; auth writes refused', async () => {
    await assert.rejects(guarded.storage.from('b').upload('f', 'x'), /Backup-copy mode/);
    await assert.rejects(guarded.storage.from('b').remove(['f']), /Backup-copy mode/);
    await assert.rejects(guarded.auth.signUp({}), /Backup-copy mode/);
    await assert.rejects(guarded.auth.updateUser({}), /Backup-copy mode/);
    await assert.rejects(guarded.auth.resetPasswordForEmail('a@b.c'), /Backup-copy mode/);
    await assert.rejects(guarded.functions.invoke('x'), /Backup-copy mode/);
  });

  await check('writeBlockedError is bilingual with a machine-checkable code', () => {
    const err = writeBlockedError();
    assert.equal(err.code, 'standby-read-only');
    assert.match(err.message, /Backup-copy mode/);
    assert.match(err.message, /copie de secours/);
  });

  await check('active-endpoint override: default env, then set/clear', () => {
    clearActiveEndpoint();
    const d = resolveSupabaseEndpoint({ VITE_SUPABASE_URL: 'https://p.co', VITE_SUPABASE_ANON_KEY: 'k' });
    assert.equal(d.readOnly, false);
    assert.equal(d.url, 'https://p.co');
    assert.equal(isStandbyReadMode(), false);
    setActiveEndpoint({ url: 'https://s.co', key: 'k2', readOnly: true });
    const s = resolveSupabaseEndpoint({ VITE_SUPABASE_URL: 'https://p.co', VITE_SUPABASE_ANON_KEY: 'k' });
    assert.equal(s.readOnly, true);
    assert.equal(s.url, 'https://s.co');
    assert.equal(isStandbyReadMode(), true);
    clearActiveEndpoint();
    assert.equal(isStandbyReadMode(), false);
  });

  up.close();
  console.log(failures.length ? `\ndb-failover: ${failures.length} FAILURES` : '\ndb-failover: all passed');
  if (failures.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error('db-failover harness error:', e);
  process.exitCode = 1;
});
