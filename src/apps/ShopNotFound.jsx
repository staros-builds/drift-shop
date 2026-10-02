import React from 'react';
import { BRAND } from '../lib/brand.js';

/**
 * "No shop at this address" — the friendly dead end for shop URLs.
 *
 * Reached when a visitor lands on a shop-shaped address that has no
 * published shop behind it: an unknown or mistyped subdomain under the
 * product's apex, or a custom domain with no live mapping. Deliberately
 * honest and calm: say plainly that no shop page lives here, and point
 * at the main site. Never a raw 404, never a spinner forever.
 *
 * Self-contained inline styles, same as StorefrontPublic: this page must
 * render on anything that can open a link. Strings are stacked EN/FR
 * like the storefront page (ES/PT follow the same treatment when those
 * storefront strings are picked up in the i18n pass).
 *
 * Variants:
 *   'notfound' — no shop at this address (the default)
 *   'loading'  — still asking; one calm line, no spinner tricks
 *   'error'    — the lookup itself failed (connection trouble); offers
 *                a Try again reload, mirroring StorefrontPublic.
 */
export default function ShopNotFound({ variant = 'notfound', homeUrl = null }) {
  const home = homeUrl || `${window.location.origin}/`;

  return (
    <div
      style={{
        minHeight: '100vh',
        background: '#f7f3ec',
        color: '#26221c',
        fontFamily:
          'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '48px 20px',
        textAlign: 'center',
      }}
    >
      <p style={{ fontSize: 13, fontWeight: 700, letterSpacing: 1.6, color: '#8a7d68', margin: '0 0 14px' }}>
        {BRAND.name.toUpperCase()}
      </p>

      {variant === 'loading' && (
        <p style={{ fontSize: 15, color: '#6d6252', margin: 0, lineHeight: 1.6 }}>
          Loading… / Chargement…
        </p>
      )}

      {variant === 'notfound' && (
        <>
          <p style={{ fontWeight: 700, fontSize: 19, margin: '0 0 10px', lineHeight: 1.45 }}>
            There is no shop page at this address.
            <br />
            Il n’y a pas de page de boutique à cette adresse.
          </p>
          <p style={{ fontSize: 15, color: '#6d6252', margin: '0 0 22px', lineHeight: 1.6, maxWidth: 460 }}>
            The address may be mistyped, or the shop has not published its
            page yet.
            <br />
            L’adresse contient peut-être une faute, ou la boutique n’a pas
            encore publié sa page.
          </p>
          <a
            href={home}
            style={{
              fontSize: 14,
              fontWeight: 600,
              color: '#26221c',
              background: '#fffdf8',
              border: '1px solid #c9bda6',
              borderRadius: 999,
              padding: '9px 18px',
              textDecoration: 'none',
            }}
          >
            Go to the main site / Aller au site principal
          </a>
        </>
      )}

      {variant === 'error' && (
        <>
          <p style={{ fontWeight: 700, fontSize: 17, margin: '0 0 10px', lineHeight: 1.45 }}>
            We couldn’t load this page.
            <br />
            Impossible de charger cette page.
          </p>
          <p style={{ fontSize: 15, color: '#6d6252', margin: '0 0 22px', lineHeight: 1.6, maxWidth: 460 }}>
            Please check your internet connection, then tap Try again.
            <br />
            Vérifiez votre connexion Internet, puis touchez Réessayer.
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            style={{
              fontSize: 14,
              fontWeight: 600,
              color: '#26221c',
              background: '#fffdf8',
              border: '1px solid #c9bda6',
              borderRadius: 999,
              padding: '9px 18px',
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            Try again / Réessayer
          </button>
        </>
      )}
    </div>
  );
}
