/**
 * Offline checks for the Cloudflare front-door Worker.
 * Run: node test/front-door-worker.test.mjs
 */
import assert from 'node:assert/strict';
import {
  buildOriginUrl,
  shouldRetryStatus,
  isRetryableMethod,
  handleRequest,
} from '../cloudflare/front-door-worker.js';

let n = 0;
function check(name, fn) {
  n++;
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ok ${n} - ${name}`))
    .catch((e) => {
      console.error(`  FAIL ${n} - ${name}: ${e.message}`);
      process.exitCode = 1;
    });
}

console.log('front-door-worker');

await check('buildOriginUrl preserves path + query and swaps only the host', () => {
  assert.equal(
    buildOriginUrl('https://mariebakery.vendra.example/#/store/x?a=1', 'vendra.pages.dev'),
    'https://vendra.pages.dev/#/store/x?a=1'
  );
  assert.equal(
    buildOriginUrl('http://vendra.example:8443/assets/app.js?v=2', 'vendra.pages.dev'),
    'https://vendra.pages.dev/assets/app.js?v=2'
  );
});

await check('retry policy: only 5xx, only GET/HEAD', () => {
  assert.equal(shouldRetryStatus(500), true);
  assert.equal(shouldRetryStatus(503), true);
  assert.equal(shouldRetryStatus(404), false);
  assert.equal(shouldRetryStatus(200), false);
  assert.equal(isRetryableMethod('GET'), true);
  assert.equal(isRetryableMethod('HEAD'), true);
  assert.equal(isRetryableMethod('POST'), false);
});

await check('missing ORIGIN_HOST fails honestly with 503', async () => {
  const res = await handleRequest(new Request('https://vendra.example/'), {}, async () => {
    throw new Error('must not fetch without an origin');
  });
  assert.equal(res.status, 503);
  assert.match(await res.text(), /not configured/);
});

await check('GET retries once on 5xx then returns the second response', async () => {
  let calls = 0;
  const res = await handleRequest(new Request('https://shop.vendra.example/'), { ORIGIN_HOST: 'vendra.pages.dev' }, async () => {
    calls++;
    return new Response(calls === 1 ? 'bad' : 'good', {
      status: calls === 1 ? 502 : 200,
      headers: { 'content-type': 'text/plain' },
    });
  });
  assert.equal(calls, 2);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'good');
});

await check('GET does not retry 4xx', async () => {
  let calls = 0;
  const res = await handleRequest(new Request('https://shop.vendra.example/nope'), { ORIGIN_HOST: 'vendra.pages.dev' }, async () => {
    calls++;
    return new Response('missing', { status: 404, headers: { 'content-type': 'text/plain' } });
  });
  assert.equal(calls, 1);
  assert.equal(res.status, 404);
});

await check('POST is never retried on 5xx (a sale must not double-submit)', async () => {
  let calls = 0;
  const res = await handleRequest(
    new Request('https://vendra.example/rest/v1/rpc', { method: 'POST', body: '{}' }),
    { ORIGIN_HOST: 'vendra.pages.dev' },
    async () => {
      calls++;
      return new Response('oops', { status: 500, headers: { 'content-type': 'text/plain' } });
    }
  );
  assert.equal(calls, 1);
  assert.equal(res.status, 500);
});

await check('HTML responses are marked no-cache; assets keep origin headers', async () => {
  const html = await handleRequest(new Request('https://vendra.example/'), { ORIGIN_HOST: 'vendra.pages.dev' }, async () =>
    new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=31536000' } }));
  assert.equal(html.headers.get('cache-control'), 'no-cache');
  assert.equal(html.headers.get('x-vendra-front-door'), 'cloudflare-worker');

  const asset = await handleRequest(new Request('https://vendra.example/assets/app-abc.js'), { ORIGIN_HOST: 'vendra.pages.dev' }, async () =>
    new Response('js', { status: 200, headers: { 'content-type': 'text/javascript', 'cache-control': 'public, max-age=31536000, immutable' } }));
  assert.equal(asset.headers.get('cache-control'), 'public, max-age=31536000, immutable');
});

console.log(`\n${n} checks done`);
