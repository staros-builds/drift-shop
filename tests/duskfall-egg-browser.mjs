/**
 * duskfall-egg-browser.mjs — live play-through of the hidden DUSKFALL
 * easter egg in a real Chromium, against the production build.
 *
 * Serves wt-egg/dist on :8930 (proxy: egg.test), opens the login screen
 * (QA: CONNECT tunnels relay via the egress proxy; the build uses the
 * real backend host with a shape-valid dummy anon key, so the boot
 * self-check gets 401s, treats the host as reachable, and proceeds to
 * the login screen. No account is signed in, no data is read or
 * written.), then:
 *
 *  1. proves the game chunk is NOT fetched during a normal boot;
 *  2. fires the Konami code → overlay opens, chunk fetched lazily;
 *  3. title → Enter Sector 1 → canvas renders, frames advance;
 *  4. movement changes the view, Space fires (ammo drops);
 *  5. pause → Quit → overlay closes, login field state intact;
 *  6. re-open → Esc on title closes;
 *  7. 390px viewport: no horizontal overflow, layout sane;
 *  8. asserts zero non-network page errors throughout;
 *  9. rough heap trend over ~60s of active play (memory-leak proxy).
 *
 * Screenshots → tests/evidence/browser-*.png
 * Run: node tests/duskfall-egg-browser.mjs
 */
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const puppeteer = await (async () => {
  try { return (await import('puppeteer-core')).default; }
  catch {
    // durable harnesses live in ~/workspace/harnesses with their own
    // node_modules (ESM resolves relative to this file, not cwd)
    return (await import('file:///home/hatch/workspace/harnesses/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js')).default;
  }
})();

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const EVIDENCE = path.join(ROOT, 'tests', 'evidence');
const APP_URL = 'http://egg.test/';
fs.mkdirSync(EVIDENCE, { recursive: true });

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.map': 'application/json' };

// Private forward proxy on 8930 serving this worktree's dist as
// http://egg.test/ — Chromium is launched with --proxy-server, which
// also sidesteps Chromium's local-network access checks for
// loopback servers. All other hosts (incl. the dummy Supabase
// backend) are short-circuited so backend traffic fails fast.
const PROXY_PORT = 8930;
const proxy = http.createServer((req, res) => {
  let url;
  try { url = new URL(req.url); } catch { url = null; }
  const host = url ? url.hostname : (req.headers.host || '').split(':')[0];
  if (host === 'egg.test') {
    let p = decodeURIComponent(url ? url.pathname : req.url.split('?')[0]);
    if (p === '/drift-shop' || p === '/drift-shop/') p = '/';
    else if (p.startsWith('/drift-shop/')) p = p.slice('/drift-shop'.length);
    if (p === '/') p = '/index.html';
    const file = path.join(DIST, path.normalize(p).replace(/^(\.\.[\\/\\\\])+/, ''));
    fs.readFile(file, (err, data) => {
      if (err) {
        fs.readFile(path.join(DIST, 'index.html'), (e2, d2) => {
          if (e2) { res.writeHead(404); res.end('nf'); return; }
          res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(d2);
        });
        return;
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(data);
    });
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/plain', 'Connection': 'close' });
  res.end('');
});
// CONNECT tunnels relay through the VM egress proxy (same pattern as
// ~/workspace/harnesses/local-proxy.mjs) so the app's boot self-check
// reaches the real backend host. The dummy anon key yields 401s —
// the self-check accepts any HTTP answer as "reachable".
const EGRESS = new URL(process.env.HTTPS_PROXY || process.env.https_proxy || '');
const EG_HOST = EGRESS.hostname;
const EG_PORT = Number(EGRESS.port) || 3128;
const EG_AUTH = EGRESS.username
  ? 'Basic ' + Buffer.from(`${decodeURIComponent(EGRESS.username)}:${decodeURIComponent(EGRESS.password)}`).toString('base64')
  : null;

function relayConnect(targetHost, targetPort, clientSocket, head) {
  const proxySocket = net.connect(EG_PORT, EG_HOST, () => {
    const authLine = EG_AUTH ? `Proxy-Authorization: ${EG_AUTH}\r\n` : '';
    proxySocket.write(`CONNECT ${targetHost}:${targetPort || 443} HTTP/1.1\r\nHost: ${targetHost}\r\n${authLine}\r\n`);
  });
  let established = false;
  let buf = '';
  const onData = (chunk) => {
    if (established) return;
    buf += chunk.toString('latin1');
    if (buf.includes('\r\n\r\n')) {
      const status = buf.split('\r\n')[0];
      if (/^HTTP\/1\.[01] 200/.test(status)) {
        established = true;
        proxySocket.removeListener('data', onData);
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        proxySocket.pipe(clientSocket);
        clientSocket.pipe(proxySocket);
        if (head && head.length) proxySocket.write(head);
      } else {
        clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
        clientSocket.destroy();
        proxySocket.destroy();
      }
    }
  };
  proxySocket.on('data', onData);
  proxySocket.on('error', () => {
    if (!established) { clientSocket.destroy(); }
  });
  clientSocket.on('error', () => proxySocket.destroy());
}
proxy.on('connect', (req, clientSocket, head) => {
  const [targetHost, targetPort] = req.url.split(':');
  relayConnect(targetHost, targetPort, clientSocket, head);
});
await new Promise((r) => proxy.listen(PROXY_PORT, '127.0.0.1', r));
console.log('proxy up on', PROXY_PORT, 'serving', DIST, 'as egg.test');

const browser = await puppeteer.launch({
  executablePath: '/opt/meta-chromium/chrome',
  headless: 'new',
  args: [
    '--no-sandbox', '--disable-dev-shm-usage', '--proxy-server=http://127.0.0.1:8930',
    '--autoplay-policy=no-user-gesture-required',
    '--enable-precise-memory-info',
  ],
});

const failures = [];
const check = (name, cond, extra = '') => {
  console.log(cond ? 'PASS' : 'FAIL', name, extra);
  if (!cond) failures.push(name);
};

const page = await browser.newPage();
await page.setViewport({ width: 800, height: 600 });

const pageErrors = [];
const consoleErrors = [];
const requests = [];
page.on('pageerror', (e) => pageErrors.push(String(e && e.message || e)));
page.on('console', (m) => {
  if (m.type() === 'error') {
    const t = m.text();
    if (/dummyqa|net::|Failed to fetch|NetworkError|supabase|status of 401/i.test(t)) return; // expected: dummy anon key gets 401s
    consoleErrors.push(t);
  }
});
page.on('request', (r) => requests.push({ url: r.url(), t: Date.now() }));
const gameChunkFetched = () => requests.some((r) => /uskfall/i.test(r.url));
const shots = async (name) => { await page.screenshot({ path: path.join(EVIDENCE, name) }); console.log('   shot →', name); };

await page.goto(APP_URL, { waitUntil: 'networkidle2', timeout: 60000 });
await page.waitForFunction(
  () => /se connecter|sign in/i.test(document.body.textContent || ''),
  { timeout: 30000 },
);
console.log('login screen up');
check('game chunk NOT fetched during normal boot', !gameChunkFetched());

// state-preservation probe: type into the login field, must survive the egg
const probe = await page.evaluate(() => {
  const inputs = [...document.querySelectorAll('input')].filter((i) => i.offsetParent !== null && /text|email/i.test(i.type || 'text'));
  return inputs.length ? inputs.map((i) => i.placeholder || i.name || i.type).join('|') : null;
});
console.log('   login inputs:', probe);
await page.evaluate(() => {
  const i = [...document.querySelectorAll('input')].find((el) => el.offsetParent !== null);
  if (i) { i.focus(); document.execCommand('insertText', false, 'egg-probe-user'); i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true })); }
});
const probeBefore = await page.evaluate(() => {
  const i = [...document.querySelectorAll('input')].find((el) => el.offsetParent !== null);
  return i ? i.value : null;
});
console.log('   probe value before:', JSON.stringify(probeBefore));

// blur out of the field (Konami ignores keystrokes aimed at text fields)
await page.mouse.click(400, 560);
await new Promise((r) => setTimeout(r, 300));

const konami = ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'b', 'a'];
for (const k of konami) { await page.keyboard.press(k); await new Promise((r) => setTimeout(r, 60)); }
await page.waitForSelector('[data-easter-egg="duskfall"]', { timeout: 15000 });
console.log('overlay opened');
check('game chunk fetched lazily on trigger', gameChunkFetched());
await page.waitForFunction(() => /DUSKFALL/.test(document.body.textContent || ''), { timeout: 15000 });
await shots('browser-title-800.png');

// start Sector 1
await page.evaluate(() => {
  const b = [...document.querySelectorAll('button')].find((x) => /enter sector 1/i.test(x.textContent || ''));
  if (b) b.click();
});
await page.waitForSelector('canvas', { timeout: 15000 });
await new Promise((r) => setTimeout(r, 1500));
await shots('browser-midgame-800.png');

const canvasShot = async () => {
  const c = await page.$('canvas');
  return c ? await c.screenshot({ encoding: 'binary' }) : null;
};
// frames advance while playing
const f1 = await canvasShot();
await new Promise((r) => setTimeout(r, 600));
const f2 = await canvasShot();
check('rendered frames advance', f1 && f2 && !f1.equals(f2), `f1=${f1?.length} f2=${f2?.length}`);

// movement changes the view: hold W, view must differ from standing still
await page.keyboard.down('KeyW');
await new Promise((r) => setTimeout(r, 1500));
await page.keyboard.up('KeyW');
const f3 = await canvasShot();
check('WASD movement changes the view', f2 && f3 && !f2.equals(f3));

// firing consumes ammo
const ammo = () => page.evaluate(() => {
  const m = (document.body.textContent || '').match(/Pistol\s*(\d+)/);
  return m ? parseInt(m[1], 10) : null;
});
const ammoBefore = await ammo();
for (let i = 0; i < 3; i++) { await page.keyboard.press('Space'); await new Promise((r) => setTimeout(r, 400)); }
const ammoAfter = await ammo();
console.log(`   ammo ${ammoBefore} → ${ammoAfter}`);
check('Space fires and consumes ammo', ammoBefore != null && ammoAfter != null && ammoAfter < ammoBefore);

// heap trend over ~45s of active play (leak proxy): hold W with a
// slight zigzag so the player keeps wandering the sector
const heap = () => page.evaluate(() => (performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : -1));
await page.keyboard.down('KeyW');
await page.keyboard.down('ArrowLeft');
await new Promise((r) => setTimeout(r, 5000));
const h1 = await heap();
await new Promise((r) => setTimeout(r, 17000));
await page.keyboard.up('ArrowLeft');
await page.keyboard.down('ArrowRight');
await new Promise((r) => setTimeout(r, 23000));
await page.keyboard.up('ArrowRight');
await page.keyboard.up('KeyW');
const h2 = await heap();
console.log(`   heap: ${h1}MB → ${h2}MB over ~45s of active play`);
check('heap stays roughly flat during play', h1 > 0 && h2 > 0 && h2 - h1 < 40, `Δ=${h2 - h1}MB`);

// exit via the always-visible X close button (works from any screen)
await page.evaluate(() => {
  const b = [...document.querySelectorAll('button')].find((x) => /close game|fermer le jeu/i.test(x.getAttribute('aria-label') || ''));
  if (b) b.click();
});
await page.waitForFunction(() => !document.querySelector('[data-easter-egg="duskfall"]'), { timeout: 8000 });
check('X close button exits the game', true);

// fresh session: pause → Quit → overlay closes, login state intact
for (const k of konami) { await page.keyboard.press(k); await new Promise((r) => setTimeout(r, 60)); }
await page.waitForSelector('[data-easter-egg="duskfall"]', { timeout: 15000 });
await page.evaluate(() => {
  const b = [...document.querySelectorAll('button')].find((x) => /enter sector 1/i.test(x.textContent || ''));
  if (b) b.click();
});
await page.waitForSelector('canvas', { timeout: 15000 });
await new Promise((r) => setTimeout(r, 1500));
await page.keyboard.press('p');
await page.waitForFunction(() => /PAUSED/.test(document.body.textContent || ''), { timeout: 8000 });
console.log('paused');
await page.evaluate(() => {
  const b = [...document.querySelectorAll('button')].find((x) => /^(quitter|quit)$/i.test((x.textContent || '').trim()));
  if (b) b.click();
});
await page.waitForFunction(() => !document.querySelector('[data-easter-egg="duskfall"]'), { timeout: 8000 });
check('Quit closes the overlay', true);
const probeAfter = await page.evaluate(() => {
  const i = [...document.querySelectorAll('input')].find((el) => el.offsetParent !== null);
  return i ? i.value : null;
});
console.log('   probe value after:', JSON.stringify(probeAfter));
check('login field state intact after enter/exit', probeAfter === probeBefore, `${JSON.stringify(probeBefore)} → ${JSON.stringify(probeAfter)}`);

// re-open, Esc on the title screen closes
for (const k of konami) { await page.keyboard.press(k); await new Promise((r) => setTimeout(r, 60)); }
await page.waitForSelector('[data-easter-egg="duskfall"]', { timeout: 15000 });
await page.keyboard.press('Escape');
await page.waitForFunction(() => !document.querySelector('[data-easter-egg="duskfall"]'), { timeout: 8000 });
check('Esc on title closes the game', true);

// ---- 390px viewport: mobile layout + event trigger path ----
const mob = await browser.newPage();
await mob.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
mob.on('pageerror', (e) => pageErrors.push('mobile: ' + String(e && e.message || e)));
await mob.goto(APP_URL, { waitUntil: 'networkidle2', timeout: 60000 });
await mob.waitForFunction(() => /se connecter|sign in/i.test(document.body.textContent || ''), { timeout: 30000 });
// same UNLOCK_EVENT the Settings → About 7-tap handler dispatches
await mob.evaluate(() => window.dispatchEvent(new CustomEvent('drift:secret-game')));
await mob.waitForSelector('[data-easter-egg="duskfall"]', { timeout: 15000 });
await mob.evaluate(() => {
  const b = [...document.querySelectorAll('button')].find((x) => /enter sector 1/i.test(x.textContent || ''));
  if (b) b.click();
});
await mob.waitForSelector('canvas', { timeout: 15000 });
await new Promise((r) => setTimeout(r, 1500));
await mob.screenshot({ path: path.join(EVIDENCE, 'browser-midgame-390.png') });
console.log('   shot → browser-midgame-390.png');
const overflow = await mob.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
check('390px: no horizontal overflow in game', overflow <= 1, `overflow=${overflow}px`);
const touchUI = await mob.evaluate(() => document.querySelectorAll('[data-easter-egg] button').length);
check('390px: touch controls present', touchUI > 4, `${touchUI} buttons`);

console.log('page errors:', pageErrors.length ? pageErrors : 'none');
console.log('console errors:', consoleErrors.length ? consoleErrors : 'none');
check('zero non-network page errors', pageErrors.length === 0, JSON.stringify(pageErrors.slice(0, 3)));
check('zero non-network console errors', consoleErrors.length === 0, JSON.stringify(consoleErrors.slice(0, 3)));

await browser.close();
proxy.close();
console.log(failures.length ? `\n${failures.length} FAILURES: ${failures.join(', ')}` : '\nALL BROWSER CHECKS PASSED');
process.exit(failures.length ? 1 : 0);
