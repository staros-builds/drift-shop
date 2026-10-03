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
 * render on anything that can open a link. Strings follow the visitor's
 * browser language (FR/EN/ES/PT), defaulting to English — never two
 * languages stacked on screen at once.
 *
 * Variants:
 *   'notfound' — no shop at this address (the default)
 *   'loading'  — still asking; one calm line, no spinner tricks
 *   'error'    — the lookup itself failed (connection trouble); offers
 *                a Try again reload, mirroring StorefrontPublic.
 */

// One language at a time, picked from the visitor's browser setting.
function pickLang() {
  try {
    const l = (typeof navigator !== 'undefined' && navigator.language ? navigator.language : 'en').toLowerCase();
    if (l.startsWith('fr')) return 'fr';
    if (l.startsWith('es')) return 'es';
    if (l.startsWith('pt')) return 'pt';
    return 'en';
  } catch {
    return 'en';
  }
}

const STRINGS = {
  en: {
    loading: 'Loading…',
    notfoundTitle: 'There is no shop page at this address.',
    notfoundBody: 'The address may be mistyped, or the shop has not published its page yet.',
    home: 'Go to the main site',
    errorTitle: 'We couldn’t load this page.',
    errorBody: 'Please check your internet connection, then tap Try again.',
    retry: 'Try again',
  },
  fr: {
    loading: 'Chargement…',
    notfoundTitle: 'Il n’y a pas de page de boutique à cette adresse.',
    notfoundBody: 'L’adresse contient peut-être une faute, ou la boutique n’a pas encore publié sa page.',
    home: 'Aller au site principal',
    errorTitle: 'Impossible de charger cette page.',
    errorBody: 'Vérifiez votre connexion Internet, puis touchez Réessayer.',
    retry: 'Réessayer',
  },
  es: {
    loading: 'Cargando…',
    notfoundTitle: 'No hay página de tienda en esta dirección.',
    notfoundBody: 'La dirección puede estar mal escrita o la tienda aún no ha publicado su página.',
    home: 'Ir al sitio principal',
    errorTitle: 'No pudimos cargar esta página.',
    errorBody: 'Revisa tu conexión a internet y toca Reintentar.',
    retry: 'Reintentar',
  },
  pt: {
    loading: 'Carregando…',
    notfoundTitle: 'Não há página de loja neste endereço.',
    notfoundBody: 'O endereço pode estar errado ou a loja ainda não publicou sua página.',
    home: 'Ir para o site principal',
    errorTitle: 'Não conseguimos carregar esta página.',
    errorBody: 'Verifique sua conexão e toque em Tentar de novo.',
    retry: 'Tentar de novo',
  },
};

export default function ShopNotFound({ variant = 'notfound', homeUrl = null }) {
  const home = homeUrl || `${window.location.origin}/`;
  const s = STRINGS[pickLang()] || STRINGS.en;

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
          {s.loading}
        </p>
      )}

      {variant === 'notfound' && (
        <>
          <p style={{ fontWeight: 700, fontSize: 19, margin: '0 0 10px', lineHeight: 1.45 }}>
            {s.notfoundTitle}
          </p>
          <p style={{ fontSize: 15, color: '#6d6252', margin: '0 0 22px', lineHeight: 1.6, maxWidth: 460 }}>
            {s.notfoundBody}
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
            {s.home}
          </a>
        </>
      )}

      {variant === 'error' && (
        <>
          <p style={{ fontWeight: 700, fontSize: 17, margin: '0 0 10px', lineHeight: 1.45 }}>
            {s.errorTitle}
          </p>
          <p style={{ fontSize: 15, color: '#6d6252', margin: '0 0 22px', lineHeight: 1.6, maxWidth: 460 }}>
            {s.errorBody}
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
            {s.retry}
          </button>
        </>
      )}
    </div>
  );
}
