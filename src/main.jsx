import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import './index.css';
import { captureInstallPrompt, registerServiceWorker } from './lib/pwa.js';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

// PWA: capture the install prompt for the Settings "Install" button, and
// register the offline service worker. Both are best-effort and silent.
captureInstallPrompt();
if (typeof window !== 'undefined') {
  window.addEventListener('load', () => {
    registerServiceWorker();
  });
}
