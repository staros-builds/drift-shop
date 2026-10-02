// Nuclear QA — cleanup for live-api.mjs: deletes the NUCLEARQA shops
// (cascades products/sales/appointments/gift cards/profiles-of-shop) as their
// owners. Auth users (nuclearqa-*) remain until the pre-ship factory reset.
// Usage: node tests/nuclear/cleanup.mjs
import fs from 'node:fs';

const cfg = JSON.parse(fs.readFileSync('/tmp/ds-env.json', 'utf8'));
const state = JSON.parse(fs.readFileSync('/tmp/ds-qa-state.json', 'utf8'));
const URL_ = cfg.url, KEY = cfg.key;

async function del(token, id, label) {
  const r = await fetch(`${URL_}/rest/v1/pos_stores?id=eq.${id}`, {
    method: 'DELETE',
    headers: { apikey: KEY, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
  });
  const t = await r.text();
  console.log(`${label}: http=${r.status} ${t.slice(0, 120)}`);
}
await del(state.A.token, state.SA, 'delete shop A');
await del(state.B.token, state.SB, 'delete shop B');

// verify residuals
for (const [tok, store, label] of [[state.A.token, state.SA, 'A'], [state.B.token, state.SB, 'B']]) {
  const r = await fetch(`${URL_}/rest/v1/pos_products?store_id=eq.${store}&select=id`, {
    headers: { apikey: KEY, Authorization: `Bearer ${tok}` },
  });
  console.log(`residual products shop ${label}: ${await r.text()}`);
}
console.log('cleanup done (auth users nuclearqa-* remain for factory reset)');
