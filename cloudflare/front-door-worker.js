// Vendra Cloudflare front-door Worker.
//
// Purpose: sit in front of the Cloudflare Pages origin so the product can
// serve the apex and one-level shop subdomains (`<shop>.<apex>`) from one
// identical build. Cloudflare Pages cannot attach a wildcard custom domain,
// but Worker routes can match `*.<apex>/*`.
//
// Configuration (Worker variables, never secrets):
//   ORIGIN_HOST  e.g. "vendra.pages.dev" — the Cloudflare Pages hostname.
//
// Behaviour contract (docs/custom-domains.md):
// - Proxy the request to the Pages origin, preserving path, query, method,
//   body and headers (except Host).
// - Retry only idempotent requests (GET/HEAD), and only on a network failure
//   or a 5xx origin response. Never retry 4xx as another origin.
// - Do not cache HTML at the front door; hashed assets keep the origin's
//   cache headers.
// - The Worker chooses no shop and grants no access: the app reads the
//   hostname client-side and the public storefront RPC re-checks publication.

export function buildOriginUrl(requestUrl, originHost) {
  const url = new URL(requestUrl);
  url.protocol = 'https:';
  url.hostname = originHost;
  url.port = '';
  return url.toString();
}

export function shouldRetryStatus(status) {
  return Number.isInteger(status) && status >= 500 && status <= 599;
}

export function isRetryableMethod(method) {
  return method === 'GET' || method === 'HEAD';
}

export function isHtmlResponse(response) {
  const type = response.headers.get('content-type') || '';
  return type.toLowerCase().includes('text/html');
}

function originHeaders(request, originHost) {
  const headers = new Headers(request.headers);
  headers.set('host', originHost);
  headers.set('x-forwarded-host', new URL(request.url).host);
  headers.set('x-forwarded-proto', 'https');
  return headers;
}

async function fetchOrigin(request, originHost, fetchImpl) {
  const init = {
    method: request.method,
    headers: originHeaders(request, originHost),
    redirect: 'manual',
  };
  if (!isRetryableMethod(request.method) && request.body) {
    init.body = request.body;
    init.duplex = 'half';
  }
  return fetchImpl(buildOriginUrl(request.url, originHost), init);
}

export async function handleRequest(request, env = {}, fetchImpl = fetch) {
  const originHost = String(env.ORIGIN_HOST || '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!originHost) {
    return new Response('Vendra front door is not configured yet.\n', {
      status: 503,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    });
  }

  const retryable = isRetryableMethod(request.method);
  let response;
  try {
    response = await fetchOrigin(request, originHost, fetchImpl);
  } catch (error) {
    if (!retryable) throw error;
    response = await fetchOrigin(request, originHost, fetchImpl);
  }

  if (retryable && shouldRetryStatus(response.status)) {
    // One retry only, and only for idempotent reads. The second response is
    // returned as-is even if it is also 5xx — no retry loops at the door.
    response = await fetchOrigin(request, originHost, fetchImpl);
  }

  const headers = new Headers(response.headers);
  headers.set('x-vendra-front-door', 'cloudflare-worker');
  if (isHtmlResponse(response)) headers.set('cache-control', 'no-cache');

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export default { fetch: handleRequest };

if (typeof addEventListener === 'function') {
  addEventListener('fetch', (event) => {
    event.respondWith(handleRequest(event.request, globalThis));
  });
}
