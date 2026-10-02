// Storefront long-name overflow test via in-page fetch stub (installed
// before the app bundle loads). Robust against CORS/preflight quirks.
import puppeteer from '/home/hatch/workspace/harnesses/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SHOTS = '/home/hatch/workspace/build3/wt-qa/tests/nuclear/shots/';
const browser = await puppeteer.launch({
  executablePath: '/opt/meta-chromium/chrome', headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--proxy-server=http://127.0.0.1:8899'],
});
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
      return Promise.resolve(new Response(JSON.stringify(payload), {
        status: 200, headers: { 'content-type': 'application/json' },
      }));
    }
    return realFetch(input, init);
  };
});
const errs = [];
page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 120)));
await page.goto('http://dsshopqa.test/drift-shop/#/store/heavy-test', { waitUntil: 'networkidle2', timeout: 45000 }).catch(() => {});
await sleep(3000);
const r = await page.evaluate(() => {
  const h1 = document.querySelector('h1');
  const xEl = [...document.querySelectorAll('*')].find((el) => el.textContent && el.textContent.includes('XXXX'));
  let node = xEl, chain = [];
  while (node && chain.length < 8) {
    chain.push({ tag: node.tagName, sw: node.scrollWidth, cw: node.clientWidth, ov: node.scrollWidth - node.clientWidth });
    node = node.parentElement;
  }
  return {
    hits: window.__rpcHits, errsLen: 0,
    bodyTextHead: (document.body.innerText || '').slice(0, 100),
    bodyHScroll: document.documentElement.scrollWidth > window.innerWidth + 1,
    scrollW: document.documentElement.scrollWidth, innerW: window.innerWidth,
    h1: h1 ? { sw: h1.scrollWidth, cw: h1.clientWidth, ov: h1.scrollWidth - h1.clientWidth } : null,
    xxxPresent: !!xEl, chain,
    pageErrors: window.__errs || [],
  };
});
console.log(JSON.stringify(r, null, 2), 'pageerrors:', errs);
const overflowed = r.bodyHScroll || (r.h1 && r.h1.ov > 4) || (r.chain.some((c) => c.ov > 4));
console.log(r.xxxPresent
  ? (overflowed ? 'RESULT: FAIL — 500-char names overflow (layout defect, incl. page h-scroll)'
    : 'RESULT: PASS — 500-char names contained')
  : 'RESULT: INCONCLUSIVE — payload not rendered');
await page.screenshot({ path: `${SHOTS}storefront-longname-390.png` });
await browser.close();
