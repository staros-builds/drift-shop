// Nuclear QA — browser matrix (§1 boot/config failures, §2 displays, storefront).
// Serves the QA dist locally; failure variants served on adjacent ports.
// Usage: node tests/nuclear/browser-matrix.mjs
// Requires: ds-serve instances on 8895 (stub), 8896 (dead-url), 8897 (good build)
// and local-proxy on 8899 for Supabase access.
import puppeteer from '/home/hatch/workspace/harnesses/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SHOTS = '/home/hatch/workspace/build3/wt-qa/tests/nuclear/shots/';
const VIEWPORTS = [
  { width: 800, height: 600, tag: '800x600' },
  { width: 390, height: 844, tag: '390x844' },
  { width: 1366, height: 768, tag: '1366x768' },
  { width: 1920, height: 1080, tag: '1920x1080' },
];
const results = [];
let pass = 0, fail = 0, blocked = 0;
function rec(status, name, detail = '') {
  results.push({ status, name, detail: String(detail).slice(0, 220) });
  if (status === 'PASS') pass++; else if (status === 'FAIL') fail++; else blocked++;
  console.log(`${status}  ${name}${detail ? ' — ' + String(detail).slice(0, 160) : ''}`);
}

async function launch(extraArgs = []) {
  return puppeteer.launch({
    executablePath: '/opt/meta-chromium/chrome',
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage',
      '--proxy-server=http://127.0.0.1:8899', ...extraArgs],
  });
}
function collectors(page, cspOnly = false) {
  const errs = [], csp = [];
  page.on('pageerror', (e) => errs.push('PAGEERROR: ' + String(e.message).slice(0, 150)));
  page.on('console', (m) => {
    if (m.type() === 'error') errs.push('CONSOLE: ' + m.text().slice(0, 150));
  });
  page.evaluateOnNewDocument(() => {
    window.__cspViolations = [];
    document.addEventListener('securitypolicyviolation', (e) => {
      window.__cspViolations.push(`${e.violatedDirective} :: ${String(e.blockedURI).slice(0, 80)}`);
    });
  });
  return { errs, csp };
}
async function pageMetrics(page) {
  return page.evaluate(() => ({
    hScroll: document.documentElement.scrollWidth > window.innerWidth + 1,
    scrollW: document.documentElement.scrollWidth,
    innerW: window.innerWidth,
    rootEmpty: (() => { const el = document.getElementById('root'); return !el || el.innerHTML.trim().length < 50; })(),
    text: (document.body.innerText || '').slice(0, 600),
  }));
}

// ---------------- good build: login at 4 viewports ----------------
{
  const browser = await launch();
  for (const vp of VIEWPORTS) {
    const page = await browser.newPage();
    await page.setViewport({ width: vp.width, height: vp.height });
    const { errs } = collectors(page);
    await page.goto('http://dsshopqa.test/drift-shop/', { waitUntil: 'networkidle2', timeout: 45000 }).catch((e) => errs.push('NAV: ' + e.message.slice(0, 100)));
    await sleep(4000);
    const m = await pageMetrics(page);
    const cspV = await page.evaluate(() => window.__cspViolations || []);
    const marker = /sign in|username|password|drift|vendra/i.test(m.text);
    rec(!m.rootEmpty ? 'PASS' : 'FAIL', `login renders @ ${vp.tag}`, `marker=${marker} hScroll=${m.hScroll} scrollW=${m.scrollW}`);
    rec(!m.hScroll ? 'PASS' : 'FAIL', `login no horizontal scroll @ ${vp.tag}`, `scrollW=${m.scrollW} innerW=${m.innerW}`);
    // Benign by design: boot self-check HEADs /rest/v1/ and treats 401/403 as
    // 'reachable' (src/main.jsx ~222-254). Ignore that one probe response.
    const realErrs = errs.filter((e) => !/favicon/i.test(e) && !/status of 401/i.test(e));
    rec(realErrs.length === 0 ? 'PASS' : 'FAIL', `login console clean @ ${vp.tag}`, realErrs.slice(0, 3).join(' | ') || 'clean (only the expected boot-check 401 probe)');
    rec(cspV.length === 0 ? 'PASS' : 'FAIL', `login CSP violations @ ${vp.tag}`, cspV.slice(0, 3).join(' | ') || 'none');
    await page.screenshot({ path: `${SHOTS}login-${vp.tag}.png` });
    await page.close();
  }
  await browser.close();
}

// ---------------- corrupt localStorage ----------------
{
  const browser = await launch();
  const page = await browser.newPage();
  await page.setViewport({ width: 1366, height: 768 });
  await page.evaluateOnNewDocument(() => {
    try {
      localStorage.setItem('driftshop_settings', '{corrupt json');
      localStorage.setItem('driftshop_session', 'x'.repeat(200000));
      localStorage.setItem('driftshop_cart', '[object Object]');
    } catch {}
  });
  const { errs } = collectors(page);
  await page.goto('http://dsshopqa.test/drift-shop/', { waitUntil: 'networkidle2', timeout: 45000 }).catch(() => {});
  await sleep(4000);
  const m = await pageMetrics(page);
  rec(!m.rootEmpty ? 'PASS' : 'FAIL', 'corrupt localStorage still boots to login', `rootEmpty=${m.rootEmpty}`);
  await browser.close();
}

// ---------------- slow 3G: boot card appears, no long blank ----------------
{
  const browser = await launch();
  const page = await browser.newPage();
  await page.setViewport({ width: 1366, height: 768 });
  const cdp = await page.createCDPSession();
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false, downloadThroughput: 400 * 1024 / 8, uploadThroughput: 400 * 1024 / 8, latency: 400,
  });
  const t0 = Date.now();
  await page.goto('http://dsshopqa.test/drift-shop/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(2500);
  const m = await pageMetrics(page);
  const firstPaint = /checking|loading|sign in|drift/i.test(m.text);
  rec(firstPaint && !m.rootEmpty ? 'PASS' : 'FAIL', 'slow-3G: meaningful content within ~2.5s (no blank)', `text="${m.text.slice(0, 80)}"`);
  await browser.close();
}

// ---------------- dead-DB-URL build ----------------
{
  const browser = await launch();
  const page = await browser.newPage();
  await page.setViewport({ width: 1366, height: 768 });
  const { errs } = collectors(page);
  await page.goto('http://dsshopdead.test/drift-shop/', { waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {});
  await sleep(6000);
  const m = await pageMetrics(page);
  const honest = /couldn|can.t reach|unreachable|check your|connection|internet|offline/i.test(m.text);
  rec(!m.rootEmpty ? 'PASS' : 'FAIL', 'dead-DB URL: no blank page', `rootEmpty=${m.rootEmpty}`);
  rec(honest ? 'PASS' : 'FAIL', 'dead-DB URL: plain-language failure card', `text="${m.text.slice(0, 120)}"`);
  await page.screenshot({ path: `${SHOTS}boot-deadurl.png` });
  await browser.close();
}

// ---------------- missing-config (stub) build ----------------
{
  const browser = await launch();
  const page = await browser.newPage();
  await page.setViewport({ width: 1366, height: 768 });
  await page.goto('http://dsshopstub.test/drift-shop/', { waitUntil: 'networkidle2', timeout: 45000 }).catch(() => {});
  await sleep(4000);
  const m = await pageMetrics(page);
  const honest = /not configured|missing|setup|configuration|connection settings/i.test(m.text);
  rec(!m.rootEmpty ? 'PASS' : 'FAIL', 'missing config: no blank page (boot stub card)', `rootEmpty=${m.rootEmpty}`);
  rec(honest ? 'PASS' : 'FAIL', 'missing config: plain-language setup card', `text="${m.text.slice(0, 120)}"`);
  await page.screenshot({ path: `${SHOTS}boot-noconfig.png` });
  await browser.close();
}

// ---------------- JS disabled ----------------
{
  const browser = await launch();
  const page = await browser.newPage();
  await page.setJavaScriptEnabled(false);
  await page.goto('http://dsshopqa.test/drift-shop/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await sleep(1500);
  const bodyText = await page.evaluate(() => (document.body.innerText || '').trim());
  rec(bodyText.length > 20 ? 'PASS' : 'FAIL', 'DOCUMENT: JS disabled shows noscript message (no <noscript> in index.html = blank)', `body="${bodyText.slice(0, 100)}"`);
  await browser.close();
}

// ---------------- storefront heavy-test at 4 viewports ----------------
{
  const browser = await launch();
  for (const vp of VIEWPORTS) {
    const page = await browser.newPage();
    await page.setViewport({ width: vp.width, height: vp.height });
    const { errs } = collectors(page);
    await page.goto('http://dsshopqa.test/drift-shop/#/store/heavy-test', { waitUntil: 'networkidle2', timeout: 45000 }).catch(() => {});
    await sleep(4000);
    const m = await pageMetrics(page);
    const hasProduct = /heavy widget|\$12\.50/i.test(m.text);
    rec(hasProduct ? 'PASS' : 'FAIL', `storefront heavy-test renders @ ${vp.tag}`, `hScroll=${m.hScroll}`);
    rec(!m.hScroll ? 'PASS' : 'FAIL', `storefront no h-scroll @ ${vp.tag}`, `scrollW=${m.scrollW} innerW=${m.innerW}`);
    await page.screenshot({ path: `${SHOTS}storefront-${vp.tag}.png` });
    await page.close();
  }
  await browser.close();
}

// ---------------- storefront long-name injection (in-page fetch stub) ----------------
// NOTE: puppeteer request-interception fails on the RPC CORS preflight; an
// in-page fetch stub installed pre-bundle is the reliable injection path.
{
  const browser = await launch();
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844 });
  await page.evaluateOnNewDocument(() => {
    const realFetch = window.fetch.bind(window);
    window.__rpcHits = 0;
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input?.url || '';
      if (url.includes('public_storefront')) {
        window.__rpcHits++;
        const payload = {
          shop: { display_name: 'S'.repeat(300), tagline: 't', about: 'a'.repeat(200), hours: '9-5', contact_email: null, contact_phone: null, accent_color: null, show_prices: true },
          products: [{ name: 'X'.repeat(500), price: 1250 }, { name: 'Normal Item', price: 500 }],
        };
        return Promise.resolve(new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } }));
      }
      return realFetch(input, init);
    };
  });
  await page.goto('http://dsshopqa.test/drift-shop/#/store/heavy-test', { waitUntil: 'networkidle2', timeout: 45000 }).catch(() => {});
  await sleep(3000);
  const r = await page.evaluate(() => {
    const h1 = document.querySelector('h1');
    const xEl = [...document.querySelectorAll('*')].find((el) => el.textContent && el.textContent.includes('XXXX'));
    let node = xEl, worst = 0;
    while (node) { worst = Math.max(worst, node.scrollWidth - node.clientWidth); node = node.parentElement; }
    return {
      hits: window.__rpcHits,
      bodyHScroll: document.documentElement.scrollWidth > window.innerWidth + 1,
      scrollW: document.documentElement.scrollWidth, innerW: window.innerWidth,
      h1Ov: h1 ? h1.scrollWidth - h1.clientWidth : null,
      xxxPresent: !!xEl, worstAncestorOv: worst,
    };
  });
  const overflowed = r.bodyHScroll || (r.h1Ov || 0) > 4 || r.worstAncestorOv > 4;
  rec(r.xxxPresent ? (overflowed ? 'FAIL' : 'PASS') : 'FAIL',
    'storefront 500-char product/shop name does not overflow (fetch-stubbed RPC)',
    `rendered=${r.xxxPresent} bodyHScroll=${r.bodyHScroll} scrollW=${r.scrollW} h1Ov=${r.h1Ov}px worst=${r.worstAncestorOv}px`);
  await page.screenshot({ path: `${SHOTS}storefront-longname-390.png` });
  await browser.close();
}


// ---------------- blocked: authenticated UI flows ----------------
rec('BLOCKED', 'FR end-to-end purchase path in browser', 'signup blocked: live project requires email confirmation (mailer_autoconfirm=false) and synthetic @drift-shop.app inboxes cannot receive mail');
rec('BLOCKED', 'POS/admin/touch-mode viewport sweeps (logged-in)', 'no demo credentials; admin login unknown to QA by design');
rec('BLOCKED', 'FR hardcoded-string visual pass in POS', 'requires logged-in FR session');

console.log(`\nBROWSER MATRIX: pass=${pass} fail=${fail} blocked=${blocked}`);
process.exit(0);
