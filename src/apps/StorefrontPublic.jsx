import React, { useEffect, useState } from 'react';
import { backend } from '../lib/backend/current.js';
import { BRAND } from '../lib/brand.js';

/**
 * Public storefront page (#/store/<slug>) — the customer-facing web page
 * for one shop, the Comelin-style "website" half of Drift Shop.
 *
 * main.jsx renders this INSTEAD of the desktop when the URL hash matches
 * #/store/<slug>: no login, no app chrome, no self-check gate. Data comes
 * from the public_storefront() RPC (migration 063) — a security-definer
 * function that is the ONLY anonymous door to shop data. It serves the
 * same pos_products rows the POS sells from (filtered to the products the
 * shop left public_visible, which defaults to ON), and only while the
 * shop's storefront profile is published. Unknown or unpublished slugs
 * get NULL back, so this page shows an honest "not available" state
 * instead of leaking anything.
 *
 * The header carries a plain staff login button: shop staff follow it to
 * the normal app entry (same origin, brand base path, no storefront
 * hash) and sign in there.
 *
 * Self-contained inline styles on purpose: the page must render cleanly
 * on a phone without the desktop theme.
 */

const FALLBACK_ACCENT = '#b4542a';

function money(cents) {
  return `$${(Number(cents || 0) / 100).toFixed(2)}`;
}

function accentOf(value) {
  return /^#[0-9a-fA-F]{6}$/.test(String(value || '')) ? value : FALLBACK_ACCENT;
}

const styles = {
  page: {
    minHeight: '100vh',
    background: '#f7f3ec',
    color: '#26221c',
    fontFamily:
      'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
    margin: 0,
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    padding: '12px 16px',
    background: '#fffdf8',
    borderBottom: '1px solid #e2d9c8',
  },
  headerName: { fontWeight: 700, fontSize: 15, letterSpacing: 0.2, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  loginBtn: {
    flexShrink: 0,
    fontSize: 13,
    fontWeight: 600,
    color: '#26221c',
    background: '#fffdf8',
    border: '1px solid #c9bda6',
    borderRadius: 999,
    padding: '7px 14px',
    textDecoration: 'none',
  },
  main: { maxWidth: 960, margin: '0 auto', padding: '0 16px 48px' },
  hero: { padding: '36px 0 8px', textAlign: 'center' },
  heroRule: { width: 56, height: 4, borderRadius: 2, margin: '0 auto 18px' },
  h1: { fontSize: 34, lineHeight: 1.15, margin: '0 0 8px', fontWeight: 800 },
  tagline: { fontSize: 17, color: '#6d6252', margin: '0 auto', maxWidth: 640 },
  section: { marginTop: 32 },
  sectionText: { whiteSpace: 'pre-line', fontSize: 15, lineHeight: 1.65, color: '#3d372e', maxWidth: 720, margin: '0 auto', textAlign: 'center' },
  card: {
    background: '#fffdf8',
    border: '1px solid #e2d9c8',
    borderRadius: 14,
    padding: '16px 18px',
    maxWidth: 720,
    margin: '0 auto',
  },
  cardTitle: { fontSize: 12, fontWeight: 700, letterSpacing: 1.2, textTransform: 'uppercase', color: '#8a7d68', margin: '0 0 8px' },
  cardBody: { whiteSpace: 'pre-line', fontSize: 15, lineHeight: 1.6, margin: 0 },
  contactRow: { display: 'flex', flexWrap: 'wrap', gap: 10, justifyContent: 'center', marginTop: 4 },
  contactLink: {
    fontSize: 14,
    fontWeight: 600,
    color: '#26221c',
    border: '1px solid #c9bda6',
    borderRadius: 999,
    padding: '8px 16px',
    textDecoration: 'none',
    background: '#fffdf8',
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))',
    gap: 12,
    marginTop: 16,
  },
  product: {
    background: '#fffdf8',
    border: '1px solid #e2d9c8',
    borderRadius: 14,
    padding: '16px 14px',
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    minHeight: 76,
  },
  productName: { fontSize: 15, fontWeight: 600, lineHeight: 1.35 },
  productPrice: { fontSize: 15, fontWeight: 800, marginTop: 'auto' },
  center: { textAlign: 'center', padding: '72px 16px', color: '#6d6252', fontSize: 15, lineHeight: 1.6 },
  footer: {
    borderTop: '1px solid #e2d9c8',
    padding: '18px 16px 26px',
    textAlign: 'center',
    fontSize: 12,
    color: '#8a7d68',
  },
};

export default function StorefrontPublic({ slug }) {
  const [state, setState] = useState({ phase: 'loading', data: null });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data, error } = await backend.supabase.rpc('public_storefront', {
          p_slug: slug,
        });
        if (cancelled) return;
        if (error) {
          setState({ phase: 'error', data: null });
        } else if (!data) {
          setState({ phase: 'missing', data: null });
        } else {
          setState({ phase: 'ready', data });
        }
      } catch {
        if (!cancelled) setState({ phase: 'error', data: null });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [slug]);

  const appUrl = `${window.location.origin}${BRAND.basePath}`;
  const shop = state.data?.shop || {};
  const shopName = shop.display_name || BRAND.name;
  const accent = accentOf(shop.accent_color);
  const products = Array.isArray(state.data?.products) ? state.data.products : [];
  const showPrices = shop.show_prices !== false;

  return (
    <div style={styles.page}>
      <header style={styles.header}>
        <span style={styles.headerName}>{shopName}</span>
        <a href={appUrl} style={styles.loginBtn}>
          Staff login / Connexion du personnel
        </a>
      </header>

      {state.phase === 'loading' && (
        <p style={styles.center}>Loading… / Chargement…</p>
      )}

      {state.phase === 'error' && (
        <div style={styles.center}>
          <p style={{ fontWeight: 700, color: '#26221c' }}>
            We couldn’t load this page.
            <br />
            Impossible de charger cette page.
          </p>
          <p>
            Please check your connection and try again in a moment.
            <br />
            Vérifiez votre connexion et réessayez dans un instant.
          </p>
        </div>
      )}

      {state.phase === 'missing' && (
        <div style={styles.center}>
          <p style={{ fontWeight: 700, color: '#26221c', fontSize: 17 }}>
            This shop page isn’t available.
            <br />
            Cette page de boutique n’est pas disponible.
          </p>
          <p>
            It may not be published yet, or the address may be wrong.
            <br />
            Elle n’est peut-être pas encore publiée, ou l’adresse est incorrecte.
          </p>
        </div>
      )}

      {state.phase === 'ready' && (
        <main style={styles.main}>
          <div style={styles.hero}>
            <div style={{ ...styles.heroRule, background: accent }} />
            <h1 style={styles.h1}>{shopName}</h1>
            {shop.tagline ? <p style={styles.tagline}>{shop.tagline}</p> : null}
          </div>

          {shop.about ? (
            <section style={styles.section}>
              <p style={styles.sectionText}>{shop.about}</p>
            </section>
          ) : null}

          {(shop.contact_email || shop.contact_phone) && (
            <section style={styles.section}>
              <div style={styles.contactRow}>
                {shop.contact_email ? (
                  <a style={styles.contactLink} href={`mailto:${shop.contact_email}`}>
                    {shop.contact_email}
                  </a>
                ) : null}
                {shop.contact_phone ? (
                  <a style={styles.contactLink} href={`tel:${shop.contact_phone}`}>
                    {shop.contact_phone}
                  </a>
                ) : null}
              </div>
            </section>
          )}

          {products.length > 0 && (
            <section style={styles.section}>
              <div style={styles.grid}>
                {products.map((p, i) => (
                  <div key={`${p.name}-${i}`} style={styles.product}>
                    <span style={styles.productName}>{p.name}</span>
                    {showPrices ? (
                      <span style={{ ...styles.productPrice, color: accent }}>
                        {money(p.price)}
                      </span>
                    ) : null}
                  </div>
                ))}
              </div>
            </section>
          )}

          {shop.hours ? (
            <section style={styles.section}>
              <div style={styles.card}>
                <p style={styles.cardTitle}>Hours / Heures</p>
                <p style={styles.cardBody}>{shop.hours}</p>
              </div>
            </section>
          ) : null}
        </main>
      )}

      <footer style={styles.footer}>
        Powered by {BRAND.name}
      </footer>
    </div>
  );
}
