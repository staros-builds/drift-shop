import puppeteer from '/home/hatch/workspace/harnesses/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({
  executablePath: '/opt/meta-chromium/chrome', headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--proxy-server=http://127.0.0.1:8899'],
});
const page = await browser.newPage();
page.on('response', (res) => {
  if (res.status() >= 400) console.log(res.status(), res.request().method(), res.url().replace('mkbozzeucotbxilkpapd', 'REF'));
});
page.on('requestfailed', (r) => console.log('FAILED', r.url().slice(-110), r.failure()?.errorText));
await page.goto('http://dsshopqa.test/drift-shop/', { waitUntil: 'networkidle2', timeout: 45000 });
await sleep(5000);
console.log('--- done, body head:', (await page.evaluate(() => (document.body.innerText || '').slice(0, 100))).replace(/\n/g, ' / '));
await browser.close();
