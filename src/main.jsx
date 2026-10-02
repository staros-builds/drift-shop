import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import { captureInstallPrompt, registerServiceWorker } from './lib/pwa.js';
import { BRAND } from './lib/brand.js';
import { validateBackendConfig } from './lib/backend/configCheck.js';
import {
  readEndpointConfig,
  hasFallback,
  selectEndpointAtBoot,
  setActiveEndpoint,
} from './lib/dbEndpoints.js';
import { resiliency } from './lib/locales/resiliency.js';

// Boot screens render before React/i18n exist, so pick the language the
// user last chose (same persisted key) and show that language only.
const bootLang = (() => {
  try {
    const v = localStorage.getItem('driftshop:lang');
    return ['fr', 'en', 'es', 'pt'].includes(v) ? v : 'fr';
  } catch {
    return 'fr';
  }
})();
const BT = resiliency[bootLang].boot;
// Boot-error texts not covered by resiliency (per-language variants).
const BOOT_ERROR_TEXT = {
  en: {
    missingTitle: 'This copy was built without its connection settings.',
    startTitle: 'The app could not start.',
    startBody: 'Something went wrong while starting the app:',
  },
  fr: {
    missingTitle: 'Cette copie a été construite sans ses réglages de connexion.',
    startTitle: "L'application n'a pas pu démarrer.",
    startBody: "Quelque chose s'est mal passé au démarrage de l'appli :",
  },
  es: {
    missingTitle: 'Esta copia se creó sin sus ajustes de conexión.',
    startTitle: 'La aplicación no pudo iniciar.',
    startBody: 'Algo salió mal al iniciar la aplicación:',
  },
  pt: {
    missingTitle: 'Esta cópia foi criada sem as configurações de conexão.',
    startTitle: 'O aplicativo não conseguiu iniciar.',
    startBody: 'Algo deu errado ao iniciar o aplicativo:',
  },
};
const BET = BOOT_ERROR_TEXT[bootLang];
import { resolveHostname, lookupSlugForHost } from './lib/hostnameResolve.js';

// Deep-link restore (moved from index.html, 2026-10-01 hardening):
// public/404.html stashes the originally requested URL in sessionStorage
// ('driftshop_spa_redirect') and bounces to the app root; restore it
// before ANY routing reads window.location. This used to be an inline
// <script> in index.html, but the Content-Security-Policy added there
// bans inline scripts (script-src 'self'), so it runs here instead —
// module scripts execute before the boot flow below reads the hash.
// history.replaceState does not reload, so this is transparent.
try {
  const pending = window.sessionStorage.getItem('driftshop_spa_redirect');
  if (pending) {
    window.sessionStorage.removeItem('driftshop_spa_redirect');
    window.history.replaceState(null, '', pending);
  }
} catch { /* storage unavailable (private mode): deep link just lands home */ }

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
    missingConfig ? BET.missingTitle : BET.startTitle,
    missingConfig ? (
      <>
        {BT.missingConfigBody.replace('{BRAND}', BRAND.name)}{' '}
        <code>VITE_SUPABASE_URL</code> / <code>VITE_SUPABASE_ANON_KEY</code>
      </>
    ) : (
      <>{BET.startBody}</>
    ),
    missingConfig ? null : message,
  );
}

/* ------------------------------------------------------------------ */
/* Startup self-checks (nuclear resiliency).                           */
/*                                                                     */
/* Before the app bundle even loads, we verify:                        */
/*   0. the baked-in config is well-formed (complete API key, valid    */
/*      Supabase URL) — a malformed build stops here instead of        */
/*      failing sign-in later with a misleading raw error,             */
/*   1. the backend is reachable (any HTTP response from the host),     */
/*   2. a known table exists (basic schema sanity).                    */
/*                                                                     */
/* A failure never leaves a blank page: the user gets a clear status   */
/* screen with Retry. Drift Shop is cloud-only — there is no offline   */
/* mode, so a dead network means boot waits rather than starting a     */
/* session that cannot reach the one shared database.                  */
/* ------------------------------------------------------------------ */


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
  bootCard(BT.checking, <>{BT.checkingHint}</>, null, null);
}

function renderConfigProblem(problems) {
  // The build's baked-in connection settings are malformed (e.g. an API
  // key truncated during the build). Presence checks pass but every
  // sign-in would fail with a misleading raw error, so boot stops here
  // with the plain-language category instead. The detail lines describe
  // the config's SHAPE only — validateBackendConfig never echoes key
  // material.
  bootCard(
    BT.configTitle,
    <>{BT.configMessage}</>,
    problems && problems.length ? problems.join('\n') : null,
    <>{bootBtn(BT.retry, () => window.location.reload(), true)}</>,
  );
}

function renderCheckFailed({ schemaProblem, detail }) {
  bootCard(
    schemaProblem ? BT.failedSchemaTitle : BT.failedTitle,
    <>{schemaProblem ? BT.failedSchemaMessage : BT.failedMessage}</>,
    detail || null,
    <>{bootBtn(BT.retry, () => window.location.reload(), true)}</>,
  );
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

const backendConfig = validateBackendConfig(SUPABASE_URL, SUPABASE_ANON_KEY);

// Endpoint selection (database failover, docs/redundancy.md): when no
// VITE_SUPABASE_FALLBACK_* is configured this is exactly the old
// behavior (probe primary once). When a standby is configured, a dead
// primary falls through to the first reachable standby in READ-ONLY
// mode — clients can never write to a standby.
const endpointConfig = readEndpointConfig(import.meta.env);

/**
 * Fixed banner shown while the app runs on a standby database copy.
 * Plain DOM (survives above the React root); reload = re-run the boot
 * probe, which returns to the primary as soon as it answers.
 */
function showStandbyBanner(detail) {
  try {
    const bar = document.createElement('div');
    bar.setAttribute('role', 'alert');
    bar.style.cssText =
      'position:fixed;top:0;left:0;right:0;z-index:99999;' +
      'background:#7a2e1d;color:#fdf8ef;font:14px/1.45 system-ui,sans-serif;' +
      'padding:10px 14px;display:flex;gap:12px;align-items:center;' +
      'box-shadow:0 2px 8px rgba(0,0,0,.25)';
    const msg = document.createElement('div');
    msg.style.cssText = 'flex:1';
    msg.textContent =
      'Backup-copy mode — the main server is unreachable, so changes are paused. ' +
      'You can keep browsing; sales and edits wait for the main server. ' +
      'Mode copie de secours — le serveur principal est injoignable, les modifications sont en pause.';
    const btn = document.createElement('button');
    btn.textContent = 'Try the main server again / Réessayer le serveur principal';
    btn.style.cssText =
      'background:#fdf8ef;color:#7a2e1d;border:0;border-radius:6px;' +
      'padding:8px 12px;font-weight:700;cursor:pointer;white-space:nowrap';
    btn.addEventListener('click', () => window.location.reload());
    bar.appendChild(msg);
    bar.appendChild(btn);
    document.body.prepend(bar);
    if (detail) console.warn('[dbEndpoints] standby-read:', detail);
  } catch {
    /* banner is best-effort; the write guard still protects the data */
  }
}

// Per-shop nice URLs: the address itself names the shop. <slug>.<apex>
// (automatic, zero setup) or the shop's own domain (looked up in the
// custom_domains table by RPC). The hostname is NEVER trusted: it only
// picks which PUBLIC page to render — storefront data still comes from
// the published-only RPCs, and the admin app always boots behind its
// normal sign-in. See src/lib/hostnameResolve.js and
// docs/custom-domains.md. Staff sign-in from a shop address goes to the
// apex app (appHome), never back to this origin.
const hostRoute =
  typeof window !== 'undefined'
    ? resolveHostname(window.location.hostname, BRAND.apexDomain)
    : { kind: 'app' };
const shopAppHome = BRAND.apexDomain ? `https://${BRAND.apexDomain}/` : null;

function renderHostedStorefront(slug) {
  import('./apps/StorefrontPublic.jsx')
    .then(({ default: StorefrontPublic }) => {
      root.render(
        <React.StrictMode>
          <StorefrontPublic slug={slug} appHome={shopAppHome} />
        </React.StrictMode>,
      );
    })
    .catch(renderBootError);
}

function renderShopNotFound(variant = 'notfound') {
  import('./apps/ShopNotFound.jsx')
    .then(({ default: ShopNotFound }) => {
      root.render(
        <React.StrictMode>
          <ShopNotFound variant={variant} homeUrl={shopAppHome} />
        </React.StrictMode>,
      );
    })
    .catch(renderBootError);
}

function renderStorefront(slug, configCheck) {
  import('./apps/StorefrontPublic.jsx')
    .then(({ default: StorefrontPublic }) => {
      root.render(
        <React.StrictMode>
          <StorefrontPublic
            slug={slug}
            configError={configCheck.status === 'ok' ? null : configCheck}
          />
        </React.StrictMode>,
      );
    })
    .catch(renderBootError);
}

if (storefrontMatch && SUPABASE_URL && SUPABASE_ANON_KEY) {
  let slug = storefrontMatch[1];
  try { slug = decodeURIComponent(slug); } catch { /* keep the raw slug */ }
  // Config-shape gate (2026-10-01 hardening): a build with a truncated or
  // wrong-project key would otherwise send every visitor into a bare RPC
  // failure. Validate the env shape first; when it is not 'ok' the page
  // goes straight to its honest error state without firing the RPC.
  // Presence is already guaranteed by the branch condition, so only the
  // 'invalid' status can occur here. (Missing env still falls through to
  // the not-configured boot card below — unchanged behavior.)
  const configCheck = validateBackendConfig(SUPABASE_URL, SUPABASE_ANON_KEY);
  if (hasFallback(endpointConfig)) {
    // The storefront is read-only, so a standby failover is seamless for
    // shoppers: probe the primary once (fast), fall back on failure.
    renderChecking();
    selectEndpointAtBoot(endpointConfig, { primaryAttempts: 1, retryDelayMs: 0 })
      .then((sel) => {
        if (sel.mode === 'standby-read') {
          setActiveEndpoint({ url: sel.url, key: sel.key, readOnly: true });
          renderStorefront(slug, configCheck);
          showStandbyBanner(sel.detail);
        } else {
          renderStorefront(slug, configCheck);
        }
      })
      .catch(() => renderStorefront(slug, configCheck));
  } else {
    renderStorefront(slug, configCheck);
  }
} else if (hostRoute.kind !== 'app' && backendConfig.status === 'ok') {
  // Shop-address hosts. Engaged only when the config is healthy — a
  // broken build on a shop address shows the honest config cards below
  // rather than a doomed RPC.
  if (hostRoute.kind === 'storefront') {
    renderHostedStorefront(hostRoute.slug);
  } else if (hostRoute.kind === 'not-found') {
    renderShopNotFound('notfound');
  } else {
    // Custom domain: ask the database which published shop owns this
    // address. Show the calm loading page while asking — never a
    // spinner-and-blank, never a guess.
    renderShopNotFound('loading');
    lookupSlugForHost({
      supabaseUrl: SUPABASE_URL,
      anonKey: SUPABASE_ANON_KEY,
      hostname: hostRoute.hostname,
    })
      .then((slug) => {
        if (slug) renderHostedStorefront(slug);
        else renderShopNotFound('notfound');
      })
      .catch(() => renderShopNotFound('error'));
  }
} else if (backendConfig.status === 'missing') {
  // Honest not-configured screen — unchanged behavior, composed with the
  // new self-check flow below.
  renderBootError(new Error('VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY not configured'));
} else if (backendConfig.status === 'invalid') {
  // Config is present but malformed (e.g. a truncated API key baked into
  // the build). Booting anyway would only surface a confusing raw
  // "Invalid API key" at sign-in — stop here and say what's wrong.
  renderConfigProblem(backendConfig.problems);
} else {
  renderChecking();
  selectEndpointAtBoot(endpointConfig)
    .then((sel) => {
      if (sel.mode === 'live') {
        bootApp();
      } else if (sel.mode === 'standby-read') {
        // Primary is really down (probed 3x); the standby answered.
        // The app boots in READ-ONLY mode: browsing works, every write
        // is refused with an honest bilingual message (the adapter's
        // guard), and the banner offers a one-tap return to the primary.
        setActiveEndpoint({ url: sel.url, key: sel.key, readOnly: true });
        bootApp();
        showStandbyBanner(sel.detail);
      } else if (sel.detail && /schema problem/.test(sel.detail)) {
        renderCheckFailed({ schemaProblem: true, detail: sel.detail });
      } else {
        renderCheckFailed({ schemaProblem: false, detail: sel.detail });
      }
    })
    .catch((err) => {
      // The check harness itself broke — say so loudly instead of a blank page.
      renderCheckFailed({ schemaProblem: false, detail: `self-check error: ${err?.message || err}` });
    });
}

// PWA: capture the install prompt for the Settings "Install" button, and
// register the service worker (app-shell asset cache only — all data
// still comes from the cloud on every use). Both are best-effort and silent.
captureInstallPrompt();
if (typeof window !== 'undefined') {
  window.addEventListener('load', () => {
    registerServiceWorker();
  });
}
