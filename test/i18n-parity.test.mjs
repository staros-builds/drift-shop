/**
 * Locale parity tests: every shipped language must expose EXACTLY the same
 * nested key set as English (the source of truth), so a missing translation
 * fails here instead of silently falling back at runtime.
 *
 * Run: node test/i18n-parity.test.mjs
 * (Hooked into the normal test flow — run all test/*.test.mjs before a build.)
 */
import assert from 'node:assert/strict';
import { en } from '../src/lib/locales/en.js';
import { fr } from '../src/lib/locales/fr.js';
import { es } from '../src/lib/locales/es.js';
import { pt } from '../src/lib/locales/pt.js';
import { resiliency } from '../src/lib/locales/resiliency.js';
import { recovery } from '../src/lib/locales/recovery.js';
import { platform } from '../src/lib/locales/platform.js';

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

/** Recursively collect every key path of a dictionary, including arrays. */
function keySet(obj, prefix = '', out = new Set()) {
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    out.add(path);
    if (v && typeof v === 'object') keySet(v, path, out);
  }
  return out;
}

/** String leaf paths only — used to assert every leaf is a non-empty string. */
function leafEntries(obj, prefix = '', out = []) {
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object') leafEntries(v, path, out);
    else out.push([path, v]);
  }
  return out;
}

function assertParity(langName, dict) {
  const enKeys = keySet(en);
  const langKeys = keySet(dict);
  const missing = [...enKeys].filter((k) => !langKeys.has(k));
  const extra = [...langKeys].filter((k) => !enKeys.has(k));
  assert.deepEqual(
    { missing, extra },
    { missing: [], extra: [] },
    `${langName} key set differs from en (missing: ${missing.slice(0, 8).join(', ') || 'none'}…; extra: ${extra.slice(0, 8).join(', ') || 'none'}…)`
  );
  // Every leaf must be a non-empty string (a slipped number/object breaks t()).
  const bad = leafEntries(dict).filter(([, v]) => typeof v !== 'string' || v.trim() === '');
  assert.deepEqual(bad.map(([k]) => k), [], `${langName} has non-string or empty leaves`);
}

console.log('i18nParity');

check('fr matches en key set exactly', () => assertParity('fr', fr));
check('es matches en key set exactly', () => assertParity('es', es));
check('pt matches en key set exactly', () => assertParity('pt', pt));

check('resiliency strings exist for all four languages with identical keys', () => {
  for (const lang of ['en', 'fr', 'es', 'pt']) {
    assert.ok(resiliency[lang], `resiliency.${lang} missing`);
  }
  const enKeys = keySet(resiliency.en);
  for (const lang of ['fr', 'es', 'pt']) {
    assert.deepEqual(keySet(resiliency[lang]), enKeys, `resiliency.${lang} key set differs from en`);
  }
});

check('recovery strings exist for all four languages with identical keys', () => {
  for (const lang of ['en', 'fr', 'es', 'pt']) {
    assert.ok(recovery[lang], `recovery.${lang} missing`);
  }
  const enKeys = keySet(recovery.en);
  for (const lang of ['fr', 'es', 'pt']) {
    assert.deepEqual(keySet(recovery[lang]), enKeys, `recovery.${lang} key set differs from en`);
  }
  for (const lang of ['en', 'fr', 'es', 'pt']) {
    const bad = leafEntries(recovery[lang]).filter(([, v]) => typeof v !== 'string' || v.trim() === '');
    assert.deepEqual(bad.map(([k]) => k), [], `recovery.${lang} has non-string or empty leaves`);
  }
});

console.log(process.exitCode ? 'FAILED' : 'all i18n parity tests passed');

check('platform strings exist for all four languages with identical keys', () => {
  for (const lang of ['en', 'fr', 'es', 'pt']) {
    assert.ok(platform[lang], `platform.${lang} missing`);
  }
  const enKeys = keySet(platform.en);
  for (const lang of ['fr', 'es', 'pt']) {
    assert.deepEqual(keySet(platform[lang]), enKeys, `platform.${lang} key set differs from en`);
  }
  for (const lang of ['en', 'fr', 'es', 'pt']) {
    const bad = leafEntries(platform[lang]).filter(([, v]) => typeof v !== 'string' || v.trim() === '');
    assert.deepEqual(bad.map(([k]) => k), [], `platform.${lang} has non-string or empty leaves`);
  }
});
