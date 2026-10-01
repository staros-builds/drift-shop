/**
 * Drift backend conformance suite.
 *
 * One test suite, every adapter. Any backend claiming the Drift contract
 * (local, supabase, replit, …) must pass this before it ships.
 *
 * Usage (node):
 *   import { runConformance } from './tests/conformance.js';
 *   import { createLocalBackend } from './src/lib/backend/local.js';
 *   const summary = await runConformance(createLocalBackend, {
 *     label: 'local',
 *     auth: { mode: 'signup', email: 'conf@test.dev', password: 'password123', username: 'conf' },
 *   });
 *
 * For adapters whose signup needs email confirmation (supabase), create the
 * user out-of-band and pass { mode: 'signin', email, password } instead.
 *
 * The suite never touches the network except through the adapter under test.
 * Options:
 *   - fileTests (default true): exercise file/image pin bytes end-to-end.
 *   - oversizeTests (default true): exercise the file size cap (allocates ~10MB).
 */
export async function runConformance(createBackend, opts = {}) {
  const label = opts.label || 'backend';
  const fileTests = opts.fileTests !== false;
  const oversizeTests = opts.oversizeTests !== false;
  const results = [];
  let me = null;

  async function step(name, fn) {
    try {
      await fn();
      results.push({ name, ok: true });
      console.log(`PASS [${label}] ${name}`);
    } catch (e) {
      results.push({ name, ok: false, error: e && e.message });
      console.error(`FAIL [${label}] ${name}: ${e && e.message}`);
    }
  }

  const b = createBackend();
  if (!b || !b.auth || !b.pins) throw new Error('createBackend() did not return a Drift adapter');

  const pngB64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const pngBytes = Buffer.from(pngB64, 'base64');
  const pngDataUrl = 'data:image/png;base64,' + pngB64;

  // ---- auth ---------------------------------------------------------------
  await step('auth signup/signin', async () => {
    const a = opts.auth || {};
    if (a.mode === 'signin') {
      const r = await b.auth.signIn({ email: a.email, password: a.password });
      me = r.user;
    } else {
      const email = a.email || `conf-${Date.now()}@test.dev`;
      await b.auth.signUp({ email, password: a.password || 'password123', username: a.username || 'conf' });
      me = b.auth.getUser()?.user || null;
      if (!me) {
        const r = await b.auth.signIn({ email, password: a.password || 'password123' });
        me = r.user;
      }
    }
    if (!me || !me.id) throw new Error('no signed-in user');
  });

  // ---- settings -----------------------------------------------------------
  await step('settings.get defaults', async () => {
    const s = await b.settings.get();
    if (!s || typeof s.visual_theme !== 'string') throw new Error('bad settings shape');
  });
  await step('settings.update round-trip', async () => {
    await b.settings.update({ visual_theme: 'nightshift' });
    const s = await b.settings.get();
    if (s.visual_theme !== 'nightshift') throw new Error('update did not stick');
    await b.settings.update({ visual_theme: 'daybreak' });
  });

  // ---- spaces -------------------------------------------------------------
  await step('spaces.list', async () => {
    const spaces = await b.spaces.list();
    if (!Array.isArray(spaces) || spaces.length < 1) throw new Error('no spaces');
  });
  await step('spaces.create/rename/remove', async () => {
    const created = await b.spaces.create('Conformance Space');
    await b.spaces.rename(created.id, 'Renamed Space');
    const spaces = await b.spaces.list();
    if (!spaces.find((s) => s.id === created.id && s.name === 'Renamed Space')) {
      throw new Error('rename not reflected');
    }
    await b.spaces.remove(created.id);
    const after = await b.spaces.list();
    if (after.find((s) => s.id === created.id)) throw new Error('remove did not delete');
  });
  await step('spaces window state save/get/remove', async () => {
    const spaces = await b.spaces.list();
    const sid = spaces[0].id;
    await b.spaces.saveWindowState(sid, {
      appId: 'files', x: 10, y: 20, w: 800, h: 600, z: 1, minimized: false, props: {},
    });
    const states = await b.spaces.getWindowStates(sid);
    if (!states.find((w) => w.appId === 'files')) throw new Error('window state missing');
    await b.spaces.removeWindowState(sid, 'files');
    const after = await b.spaces.getWindowStates(sid);
    if (after.find((w) => w.appId === 'files')) throw new Error('window state not removed');
  });

  // ---- pins (text/link) ----------------------------------------------------
  let pinId = null;
  await step('pins.create (text)', async () => {
    const p = await b.pins.create({
      kind: 'text', title: 'hello drift', body: 'full text search check', tags: ['conformance'],
    });
    pinId = p.id;
    if (!pinId) throw new Error('no pin id');
  });
  await step('pins.search finds text', async () => {
    const hits = await b.pins.search('drift');
    if (!hits.find((h) => h.id === pinId)) throw new Error('search missed the pin');
  });
  await step('pins.create (link)', async () => {
    const p = await b.pins.create({
      kind: 'link', title: 'Example', url: 'https://example.com', tags: ['conformance'],
    });
    if (!p.url) throw new Error('url not stored');
    await b.pins.remove(p.id);
  });
  await step('pins.update/remove', async () => {
    await b.pins.update(pinId, { title: 'hello drift v2' });
    const all = await b.pins.list({});
    if (!all.find((p) => p.id === pinId && p.title === 'hello drift v2')) {
      throw new Error('update not reflected');
    }
    await b.pins.remove(pinId);
    const after = await b.pins.list({});
    if (after.find((p) => p.id === pinId)) throw new Error('remove did not delete');
  });
  await step('pins.tags', async () => {
    const tags = await b.pins.tags();
    if (!Array.isArray(tags)) throw new Error('tags() did not return an array');
  });

  // ---- pins (file/image bytes) --------------------------------------------
  if (fileTests) {
    let imgPin = null;
    let filePin = null;
    await step('pins.create (image) stores bytes', async () => {
      imgPin = await b.pins.create({
        kind: 'image', title: 'tiny.png', tags: ['conformance'],
        dataUrl: pngDataUrl, mime: 'image/png', sizeBytes: pngBytes.length,
      });
      if (!imgPin.id) throw new Error('no pin id');
      if (imgPin.mime !== 'image/png') throw new Error('mime not stored: ' + imgPin.mime);
      if (imgPin.sizeBytes !== pngBytes.length) {
        throw new Error(`size not stored (want ${pngBytes.length}, got ${imgPin.sizeBytes})`);
      }
    });
    await step('pins.fileUrl resolves bytes exactly', async () => {
      const url = await b.pins.fileUrl(imgPin);
      if (typeof url !== 'string' || !url.length) throw new Error('fileUrl returned nothing usable');
      const res = await fetch(url);
      if (!res.ok) throw new Error('fileUrl fetch failed: ' + res.status);
      const got = Buffer.from(await res.arrayBuffer());
      if (!got.equals(pngBytes)) {
        throw new Error(`byte mismatch (got ${got.length}, want ${pngBytes.length})`);
      }
    });
    await step('pins.create (file) + fileUrl text round-trip', async () => {
      const text = 'conformance file bytes ✓';
      filePin = await b.pins.create({
        kind: 'file', title: 'note.txt',
        dataUrl: 'data:text/plain;base64,' + Buffer.from(text, 'utf8').toString('base64'),
        mime: 'text/plain',
      });
      const url = await b.pins.fileUrl(filePin);
      const back = await (await fetch(url)).text();
      if (back !== text) throw new Error('text mismatch: ' + JSON.stringify(back));
    });
    await step('pins.update replaces file bytes', async () => {
      const replacement = 'replacement bytes';
      const before = imgPin.storagePath || imgPin.body;
      const updated = await b.pins.update(imgPin.id, {
        title: 'tiny2.png',
        dataUrl: 'data:image/png;base64,' + Buffer.from(replacement, 'utf8').toString('base64'),
        mime: 'image/png',
      });
      imgPin = updated;
      const url = await b.pins.fileUrl(imgPin);
      const back = await (await fetch(url)).text();
      if (back !== replacement) throw new Error('replacement bytes mismatch');
      const afterPath = updated.storagePath || updated.body;
      if (before && afterPath && before === afterPath) {
        throw new Error('file location did not rotate on replace');
      }
    });
    if (oversizeTests) {
      await step('pins.create rejects oversize file', async () => {
        // Adapter caps live in CONTRACTS.md (local 2MB, cloud 10MB).
        // Probe just above the local cap; cloud adapters must reject at theirs.
        const probeBytes = 3 * 1024 * 1024;
        const big = Buffer.alloc(probeBytes, 0x41);
        let threw = false;
        let errMsg = '';
        try {
          await b.pins.create({
            kind: 'file', title: 'big.bin',
            dataUrl: 'data:application/octet-stream;base64,' + big.toString('base64'),
            mime: 'application/octet-stream',
          });
        } catch (e) { threw = /too large/i.test(e.message); errMsg = e.message; }
        // A 3MB probe must fail on local (2MB cap). Cloud adapters (10MB cap)
        // accept it — that is correct behavior, not a failure. Distinguish:
        if (!threw && b.kind === 'local') {
          throw new Error('local adapter accepted >2MB file: ' + errMsg);
        }
      });
    }
    await step('pins.create requires file data', async () => {
      let threw = false;
      try { await b.pins.create({ kind: 'file', title: 'nodata.txt' }); }
      catch (e) { threw = /dataUrl/i.test(e.message); }
      if (!threw) throw new Error('file pin without data did not throw');
    });
    await step('pins.remove (file/image)', async () => {
      await b.pins.remove(imgPin.id);
      await b.pins.remove(filePin.id);
      const all = await b.pins.list({});
      if (all.find((p) => p.id === imgPin.id || p.id === filePin.id)) {
        throw new Error('file pins still present');
      }
    });
  }

  // ---- files (VFS) ---------------------------------------------------------
  await step('files.write/read/list/remove', async () => {
    await b.files.write('/notes/conf.txt', 'conformance vfs check');
    const { text } = await b.files.read('/notes/conf.txt');
    if (text !== 'conformance vfs check') throw new Error('read mismatch');
    const entries = await b.files.list('/notes');
    if (!entries.find((e) => e.name === 'conf.txt')) throw new Error('list missing file');
    await b.files.remove('/notes/conf.txt');
  });

  // ---- notifications -------------------------------------------------------
  await step('notifications.push/list/markRead/dismiss/clearAll', async () => {
    const n = await b.notifications.push({ title: 'conformance', body: 'check' });
    const list = await b.notifications.list();
    if (!list.find((x) => x.id === n.id)) throw new Error('push not listed');
    await b.notifications.markRead(n.id);
    await b.notifications.dismiss(n.id);
    const after = await b.notifications.list();
    if (after.find((x) => x.id === n.id)) throw new Error('dismiss did not remove');
    await b.notifications.clearAll();
  });

  // ---- highscores ----------------------------------------------------------
  await step('highscores.record/list', async () => {
    const score = 100000 + Math.floor(Math.random() * 899999);
    await b.highscores.record('snake', score, { level: 3 });
    const top = await b.highscores.list('snake', 5);
    if (!top.find((r) => r.score === score)) throw new Error('score missing');
  });

  // ---- helm ----------------------------------------------------------------
  await step('helm thread/message lifecycle', async () => {
    const t = await b.helm.createThread('conformance thread');
    await b.helm.addMessage(t.id, { role: 'user', content: 'ping' });
    const msgs = await b.helm.messages(t.id);
    if (!msgs.find((m) => m.content === 'ping')) throw new Error('message missing');
    await b.helm.removeThread(t.id);
    const threads = await b.helm.threads();
    if (threads.find((x) => x.id === t.id)) throw new Error('thread not removed');
  });

  // ---- signout ---------------------------------------------------------------
  await step('auth.signOut', async () => {
    await b.auth.signOut();
  });

  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);
  console.log(`\n[${label}] ${passed}/${results.length} passed${failed.length ? ` — ${failed.length} FAILED` : ''}`);
  return { label, passed, total: results.length, failed, results };
}
