// Conformance runner: local adapter (node, localStorage stubbed).
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};

const { runConformance } = await import('./conformance.js');
const { createLocalBackend } = await import('../src/lib/backend/local.js');

const summary = await runConformance(createLocalBackend, {
  label: 'local',
  auth: { mode: 'signup', email: 'conf-local@test.dev', password: 'password123', username: 'conf' },
});
process.exit(summary.failed.length ? 1 : 0);
