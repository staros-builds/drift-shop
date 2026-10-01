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
          maxWidth: 520,
          background: '#fffdf8',
          border: '1px solid #d8cfc0',
          borderRadius: 12,
          padding: 32,
          boxShadow: '0 8px 30px rgba(60,50,35,.12)',
        }}
      >
        <div style={{ fontSize: 22, marginBottom: 8 }}>{BRAND.name}</div>
        <div style={{ fontSize: 15, fontWeight: 'bold', marginBottom: 8 }}>
          {missingConfig
            ? 'The cloud backend is not configured.'
            : 'The app could not start.'}
        </div>
        <div style={{ fontSize: 14, lineHeight: 1.55, marginBottom: 8 }}>
          {missingConfig ? (
            <>
              This build of {BRAND.name} was made without its Supabase
              connection settings. Rebuild with{' '}
              <code>VITE_SUPABASE_URL</code> and{' '}
              <code>VITE_SUPABASE_ANON_KEY</code> set, then reload.
            </>
          ) : (
            <>Something went wrong while starting the app:</>
          )}
        </div>
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
          {message}
        </pre>
        <div style={{ fontSize: 13, marginTop: 12, color: '#6b6257' }}>
          {BRAND.taglineEn}
          <br />
          {BRAND.taglineFr}
        </div>
      </div>
    </div>,
  );
}

import('./App.jsx')
  .then(({ default: App }) => {
    root.render(
      <React.StrictMode>
        <App />
      </React.StrictMode>,
    );
  })
  .catch(renderBootError);

// PWA: capture the install prompt for the Settings "Install" button, and
// register the offline service worker. Both are best-effort and silent.
captureInstallPrompt();
if (typeof window !== 'undefined') {
  window.addEventListener('load', () => {
    registerServiceWorker();
  });
}
