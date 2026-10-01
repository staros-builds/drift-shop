import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import { captureInstallPrompt, registerServiceWorker } from './lib/pwa.js';
import { BRAND } from './lib/brand.js';

const root = ReactDOM.createRoot(document.getElementById('root'));

// A throw during module evaluation (e.g. missing VITE_SUPABASE_URL /
// VITE_SUPABASE_ANON_KEY at build time, when the backend singleton is
// created) would otherwise leave a completely blank page with no error UI.
// Load the app dynamically so a boot failure renders an honest,
// actionable message instead of silence.
function renderBootError(err) {
  const message = String((err && err.message) || err || 'Unknown boot error');
  const missingConfig = /VITE_SUPABASE_URL|VITE_SUPABASE_ANON_KEY|not configured/i.test(message);
  bootCard(
    missingConfig ? 'The cloud backend is not configured.' : 'The app could not start.',
    missingConfig ? (
      <>
        This build of {BRAND.name} was made without its Supabase
        connection settings. Rebuild with{' '}
        <code>VITE_SUPABASE_URL</code> and{' '}
        <code>VITE_SUPABASE_ANON_KEY</code> set, then reload.
      </>
    ) : (
      <>Something went wrong while starting the app:</>
    ),
    missingConfig ? null : message,
  );
}

/* ------------------------------------------------------------------ */
/* Startup self-checks (nuclear resiliency).                           */
/*                                                                     */
/* Before the app bundle even loads, we verify with a timeout that:    */
/*   1. the backend is reachable (any HTTP response from the host),     */
/*   2. a known table exists (basic schema sanity).                    */
/*                                                                     */
/* A failure never leaves a blank page: the user gets a clear status   */
/* screen with Retry, plus "Continue offline" — because the POS is      */
/* designed to sell offline and queue sales for later sync. Blocking   */
/* boot on a dead network would turn an outage into a closed shop.      */
/* ------------------------------------------------------------------ */

const SELF_CHECK_TIMEOUT_MS = 12000;

function bootCard(title, body, detail, actions) {
  root.render(
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#f7f3ec',
        color: '#2b2620',
        fontFamily: 'Georgia, serif',
        padding: 24,
      }}
    >
      <div
        style={{
          maxWidth: 560,
          background: '#fffdf8',
          border: '1px solid #d8cfc0',
          borderRadius: 12,
          padding: 32,
          boxShadow: '0 8px 30px rgba(60,50,35,.12)',
        }}
      >
        <div style={{ fontSize: 22, marginBottom: 8 }}>{BRAND.name}</div>
        <div style={{ fontSize: 15, fontWeight: 'bold', marginBottom: 8 }}>{title}</div>
        <div style={{ fontSize: 14, lineHeight: 1.55, marginBottom: 8 }}>{body}</div>
        {detail ? (
          <pre
            style={{
              fontSize: 12,
              background: '#f3ede1',
              border: '1px solid #e2d9c8',
              borderRadius: 8,
              padding: 12,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              maxHeight: 180,
              overflow: 'auto',
            }}
          >
            {detail}
          </pre>
        ) : null}
        {actions ? <div style={{ display: 'flex', gap: 10, marginTop: 14, flexWrap: 'wrap' }}>{actions}</div> : null}
        <div style={{ fontSize: 13, marginTop: 14, color: '#6b6257' }}>
          {BRAND.taglineEn}
          <br />
          {BRAND.taglineFr}
        </div>
      </div>
    </div>,
  );
}

const bootBtn = (label, onClick, primary) => (
  <button
    type="button"
    onClick={onClick}
    style={{
      fontSize: 14,
      fontWeight: 600,
      padding: '9px 18px',
      borderRadius: 8,
      cursor: 'pointer',
      border: primary ? 'none' : '1px solid #d8cfc0',
      background: primary ? '#b4542a' : '#fffdf8',
      color: primary ? '#fff' : '#2b2620',
    }}
  >
    {label}
  </button>
);

function renderChecking() {
  bootCard(
    'Checking the cloud connection… / Vérification de la connexion infonuagique…',
    <>
      Making sure the backend is reachable before the app starts.
      <br />
      On s'assure que le serveur est joignable avant de démarrer l'appli.
    </>,
    null,
    null,
  );
}

function renderCheckFailed({ schemaProblem, detail }) {
  const title = schemaProblem
    ? 'Backend reachable, but the database looks wrong / Serveur joignable, mais la base de données semble incorrecte'
    : 'Could not reach the backend / Connexion au serveur impossible';
  const msg = schemaProblem ? (
    <>
      The server answered, but a required database table was not found. The
      backend may be misconfigured or pointing at the wrong project.
      <br />
      Le serveur a répondu, mais une table requise est introuvable. Le serveur
      est peut-être mal configuré ou pointe vers le mauvais projet.
    </>
  ) : (
    <>
      The app could not reach its cloud backend. Check your internet connection,
      then try again.
      <br />
      L'appli n'a pas pu joindre son serveur infonuagique. Vérifiez votre
      connexion Internet, puis réessayez.
    </>
  );
  const note = (
    <>
      <div style={{ fontSize: 13, color: '#6b6257', marginTop: 10 }}>
        Sales made offline are saved on this device and sync when the connection
        returns — the shop can keep selling.
        <br />
        Les ventes hors ligne sont enregistrées sur cet appareil et se
        synchronisent au retour de la connexion.
      </div>
    </>
  );
  bootCard(
    title,
    <>
      {msg}
      {note}
    </>,
    detail || null,
    <>
      {bootBtn('Retry / Réessayer', () => window.location.reload(), true)}
      {bootBtn('Continue offline / Continuer hors ligne', () => bootApp(false))}
    </>,
  );
}

function fetchWithTimeout(url, options, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...options, signal: ctrl.signal }).finally(() => clearTimeout(timer));
}

/**
 * Returns { reachable, schemaOk, detail }.
 * - reachable: the host answered HTTP at all (even a 401/404).
 * - schemaOk: a known table (pos_stores) exists. 'unknown' when RLS hides
 *   it from the anon key — that still means the backend is fine.
 */
async function runSelfChecks(url, key) {
  const base = String(url).replace(/\/+$/, '');
  // 1. Reachability: any HTTP response proves host + network.
  let reachable = false;
  let reachDetail = '';
  try {
    const res = await fetchWithTimeout(
      `${base}/rest/v1/`,
      { method: 'HEAD', headers: { apikey: key } },
      SELF_CHECK_TIMEOUT_MS,
    );
    reachable = true;
    reachDetail = `HTTP ${res.status}`;
  } catch (err) {
    reachable = false;
    reachDetail = err?.name === 'AbortError' ? 'timed out' : String(err?.message || err);
  }
  if (!reachable) return { reachable: false, schemaOk: 'unknown', detail: reachDetail };

  // 2. Schema sanity: probe a table every install must have.
  try {
    const res = await fetchWithTimeout(
      `${base}/rest/v1/pos_stores?select=id&limit=1`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` } },
      SELF_CHECK_TIMEOUT_MS,
    );
    if (res.ok) return { reachable: true, schemaOk: true, detail: '' };
    // 401/403: RLS hides the table from anon — backend is fine, unverifiable.
    if (res.status === 401 || res.status === 403) {
      return { reachable: true, schemaOk: 'unknown', detail: '' };
    }
    let body = '';
    try {
      body = await res.text();
    } catch {}
    // PostgREST: table missing -> 404 + PGRST205 "Could not find the table".
    const tableMissing = res.status === 404 && /PGRST205|Could not find the table/i.test(body);
    if (tableMissing) {
      return { reachable: true, schemaOk: false, detail: body.slice(0, 300) };
    }
    // Any other HTTP answer: backend is alive; don't block boot on it.
    return { reachable: true, schemaOk: 'unknown', detail: `HTTP ${res.status}` };
  } catch (err) {
    // Reachable a moment ago; a flaky second probe shouldn't hard-fail boot.
    return { reachable: true, schemaOk: 'unknown', detail: String(err?.message || err) };
  }
}

function bootApp() {
  import('./App.jsx')
    .then(({ default: App }) => {
      root.render(
        <React.StrictMode>
          <App />
        </React.StrictMode>,
      );
    })
    .catch(renderBootError);
}

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

// Public storefront: #/store/<slug> renders the shop's customer-facing
// page INSTEAD of the desktop — no login, no self-check gate. Checked
// before the app boot flow; the component renders its own honest
// loading / not-found states, and its only data door is the
// public_storefront() RPC (migration 063).
const storefrontMatch =
  typeof window !== 'undefined'
    ? window.location.hash.match(/^#\/store\/([^/?#]+)\/?$/)
    : null;

if (storefrontMatch && SUPABASE_URL && SUPABASE_ANON_KEY) {
  let slug = storefrontMatch[1];
  try { slug = decodeURIComponent(slug); } catch { /* keep the raw slug */ }
  import('./apps/StorefrontPublic.jsx')
    .then(({ default: StorefrontPublic }) => {
      root.render(
        <React.StrictMode>
          <StorefrontPublic slug={slug} />
        </React.StrictMode>,
      );
    })
    .catch(renderBootError);
} else if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  // Honest not-configured screen — unchanged behavior, composed with the
  // new self-check flow below.
  renderBootError(new Error('VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY not configured'));
} else {
  renderChecking();
  runSelfChecks(SUPABASE_URL, SUPABASE_ANON_KEY)
    .then(({ reachable, schemaOk, detail }) => {
      if (!reachable) {
        renderCheckFailed({ schemaProblem: false, detail });
      } else if (schemaOk === false) {
        renderCheckFailed({ schemaProblem: true, detail });
      } else {
        bootApp();
      }
    })
    .catch((err) => {
      // The check harness itself broke — say so loudly instead of a blank page.
      renderCheckFailed({ schemaProblem: false, detail: `self-check error: ${err?.message || err}` });
    });
}

// PWA: capture the install prompt for the Settings "Install" button, and
// register the offline service worker. Both are best-effort and silent.
captureInstallPrompt();
if (typeof window !== 'undefined') {
  window.addEventListener('load', () => {
    registerServiceWorker();
  });
}
