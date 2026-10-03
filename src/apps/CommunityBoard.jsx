import React, { useEffect, useMemo, useState } from 'react';
import { backend } from '../lib/backend/current.js';
import { BRAND } from '../lib/brand.js';
import { getLang, tagFor } from '../lib/localeTag.js';
import { classifieds } from '../lib/locales/classifieds.js';

/**
 * Public community board (#/community) — Kijiji-style browsing of the
 * FREE customer-tier ads (migration 098).
 *
 * Standalone page like StorefrontPublic: no desktop chrome, no login
 * required, self-contained inline styles so it renders cleanly on a
 * phone. Data comes from the public_customer_classifieds() RPC — a
 * security-definer function that only returns published, non-expired
 * customer ads. Ads are clearly labeled as neighbor-posted (not shops).
 *
 * Same Craigslist patterns as the storefront: green prices, photo-first
 * cards, relative timestamps, favorites + hide (localStorage, no
 * account), and inline safety tips.
 */

const ACCENT = '#b4542a';
const CL_GREEN = '#15803d';

function cc(key, vars) {
  const lang = getLang();
  const dict = (classifieds[lang] || classifieds.fr)[key] ?? classifieds.en[key] ?? key;
  let s = String(dict);
  if (vars) {
    for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
  }
  return s;
}

function ccCat(category) {
  const map = {
    'for-sale': 'catForSale',
    free: 'catFree',
    services: 'catServices',
    wanted: 'catWanted',
    jobs: 'catJobs',
    events: 'catEvents',
    announcements: 'catAnnouncements',
  };
  return cc(map[category] || 'catForSale');
}

function ccRelative(iso) {
  if (!iso) return '';
  try {
    const then = new Date(iso).getTime();
    if (!Number.isFinite(then)) return '';
    const diffSec = Math.round((then - Date.now()) / 1000);
    const rtf = new Intl.RelativeTimeFormat(tagFor(getLang()), { numeric: 'auto' });
    const abs = Math.abs(diffSec);
    if (abs < 60) return rtf.format(diffSec, 'second');
    const mins = Math.round(diffSec / 60);
    if (Math.abs(mins) < 60) return rtf.format(mins, 'minute');
    const hours = Math.round(mins / 60);
    if (Math.abs(hours) < 24) return rtf.format(hours, 'hour');
    const days = Math.round(hours / 24);
    if (Math.abs(days) < 30) return rtf.format(days, 'day');
    const months = Math.round(days / 30);
    if (Math.abs(months) < 12) return rtf.format(months, 'month');
    return rtf.format(Math.round(months / 12), 'year');
  } catch {
    return '';
  }
}

const CATEGORIES = ['for-sale', 'free', 'services', 'wanted', 'jobs', 'events', 'announcements'];

const styles = {
  page: {
    minHeight: '100vh',
    background: '#f7f3ec',
    color: '#26221c',
    fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: 12,
    rowGap: 10,
    padding: '12px 16px',
    background: '#fffdf8',
    borderBottom: '1px solid #e2d9c8',
  },
  brand: { fontWeight: 800, fontSize: 16, color: '#26221c', textDecoration: 'none' },
  headerBtns: { display: 'flex', gap: 8, alignItems: 'center' },
  ghostBtn: {
    fontSize: 13, fontWeight: 600, color: '#26221c', background: '#fffdf8',
    border: '1px solid #c9bda6', borderRadius: 999, padding: '7px 14px',
    textDecoration: 'none', cursor: 'pointer', fontFamily: 'inherit',
  },
  solidBtn: {
    fontSize: 13, fontWeight: 700, color: '#fffdf8', background: ACCENT,
    border: 'none', borderRadius: 999, padding: '8px 16px',
    textDecoration: 'none', cursor: 'pointer', fontFamily: 'inherit',
  },
  main: { maxWidth: 960, margin: '0 auto', padding: '0 16px 48px' },
  hero: { padding: '36px 0 8px', textAlign: 'center' },
  h1: { fontSize: 'clamp(24px, 6vw, 30px)', lineHeight: 1.15, margin: '0 0 8px', fontWeight: 800 },
  tagline: { fontSize: 15, color: '#6d6252', margin: '0 auto', maxWidth: 640 },
  toolbar: { display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 20, alignItems: 'center' },
  search: {
    flex: '1 1 200px', fontSize: 14, padding: '9px 14px', borderRadius: 999,
    border: '1px solid #c9bda6', background: '#fffdf8', fontFamily: 'inherit',
  },
  chips: { display: 'flex', gap: 6, overflowX: 'auto', padding: '12px 0 4px' },
  chip: (active) => ({
    flexShrink: 0, fontSize: 12, fontWeight: 600, padding: '7px 13px', borderRadius: 999,
    border: active ? `1px solid ${ACCENT}` : '1px solid #c9bda6',
    background: active ? ACCENT : '#fffdf8',
    color: active ? '#fffdf8' : '#6d6252', cursor: 'pointer', fontFamily: 'inherit',
  }),
  grid: {
    display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
    gap: 14, listStyle: 'none', margin: '16px 0 0', padding: 0,
  },
  card: {
    background: '#fffdf8', border: '1px solid #e2d9c8', borderRadius: 14,
    overflow: 'hidden', display: 'flex', flexDirection: 'column',
  },
  photoWrap: { position: 'relative' },
  photo: { width: '100%', height: 170, objectFit: 'cover', display: 'block' },
  noPhoto: {
    width: '100%', height: 170, display: 'flex', alignItems: 'center',
    justifyContent: 'center', background: '#efe9db', color: '#a89c86', fontSize: 30,
  },
  priceBadge: {
    position: 'absolute', bottom: 8, left: 8, background: CL_GREEN, color: '#fff',
    borderRadius: 999, padding: '4px 10px', fontSize: 13, fontWeight: 800,
  },
  sellerBadge: {
    position: 'absolute', top: 8, left: 8, background: 'rgba(38,34,28,0.75)', color: '#fff',
    borderRadius: 999, padding: '2px 9px', fontSize: 11, fontWeight: 700,
  },
  cardBody: { padding: '10px 14px 14px', display: 'flex', flexDirection: 'column', gap: 4, flex: 1 },
  cardTop: { display: 'flex', alignItems: 'center', gap: 6 },
  cat: { fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.8, color: '#8a7d68', flex: 1 },
  iconBtn: {
    border: 'none', background: 'transparent', cursor: 'pointer',
    fontSize: 17, lineHeight: 1, padding: 2, fontFamily: 'inherit',
  },
  title: { fontSize: 15, fontWeight: 700, margin: 0 },
  price: { fontSize: 16, fontWeight: 800, color: CL_GREEN, margin: 0 },
  meta: { fontSize: 12, color: '#a89c86' },
  desc: { fontSize: 13, color: '#6d6252', margin: 0, display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' },
  contact: { fontSize: 12, color: '#8a7d68', margin: 0 },
  empty: { textAlign: 'center', padding: '48px 16px', color: '#6d6252', fontSize: 15 },
  safety: { fontSize: 12, color: '#a89c86', marginTop: 12, textAlign: 'center' },
  cta: {
    marginTop: 32, textAlign: 'center', background: '#fffdf8',
    border: '1px solid #e2d9c8', borderRadius: 14, padding: '24px 20px',
  },
};

function fmtPrice(cents) {
  if (cents === null || cents === undefined) return cc('priceContact');
  if (Number(cents) === 0) return cc('priceFree');
  return `$${(Number(cents) / 100).toFixed(2)}`;
}

export default function CommunityBoard() {
  const [ads, setAds] = useState(null); // null = loading
  const [search, setSearch] = useState('');
  const [cat, setCat] = useState('all');
  const [favs, setFavs] = useState(() => {
    try { return JSON.parse(localStorage.getItem('driftshop:community:fav') || '[]'); } catch { return []; }
  });
  const [hidden, setHidden] = useState(() => {
    try { return JSON.parse(localStorage.getItem('driftshop:community:hidden') || '[]'); } catch { return []; }
  });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await backend.classifieds.customerPublicList();
        if (!cancelled) setAds(Array.isArray(list) ? list : []);
      } catch {
        if (!cancelled) setAds([]);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const persist = (key, val) => {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch { /* ignore */ }
  };

  const toggleFav = (id) => {
    setFavs((prev) => {
      const next = prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id];
      persist('driftshop:community:fav', next);
      return next;
    });
  };

  const hideAd = (id) => {
    setHidden((prev) => {
      const next = prev.includes(id) ? prev : [...prev, id];
      persist('driftshop:community:hidden', next);
      return next;
    });
  };

  const unhide = () => {
    setHidden([]);
    persist('driftshop:community:hidden', []);
  };

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (ads || []).filter((a) => {
      if (hidden.includes(a.id)) return false;
      if (cat !== 'all' && a.category !== cat) return false;
      if (q && !`${a.title} ${a.description}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [ads, search, cat, hidden]);

  const homeHref = `${window.location.origin}${window.location.pathname}#/`;

  return (
    <div style={styles.page}>
      <header style={styles.header}>
        <a href={homeHref} style={styles.brand}>{BRAND?.name || 'Vendra'}</a>
        <div style={styles.headerBtns}>
          <a href={homeHref} style={styles.ghostBtn}>{cc('communityBackHome')}</a>
          <a href={homeHref} style={styles.solidBtn}>{cc('newAd')}</a>
        </div>
      </header>
      <main style={styles.main}>
        <div style={styles.hero}>
          <h1 style={styles.h1}>{cc('communityTitle')}</h1>
          <p style={styles.tagline}>{cc('communitySub')}</p>
        </div>

        <div style={styles.toolbar}>
          <input
            style={styles.search}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={cc('searchPlaceholder')}
            aria-label={cc('searchPlaceholder')}
          />
        </div>
        <div style={styles.chips} role="group" aria-label={cc('categoryLabel')}>
          {['all', ...CATEGORIES].map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setCat(c)}
              aria-pressed={cat === c}
              style={styles.chip(cat === c)}
            >
              {c === 'all' ? cc('allCategories') : ccCat(c)}
            </button>
          ))}
        </div>

        {ads === null ? (
          <p style={styles.empty}>…</p>
        ) : filtered.length === 0 ? (
          <p style={styles.empty}>{cc('communityEmpty')}</p>
        ) : (
          <ul style={styles.grid}>
            {filtered.map((a) => {
              const price = fmtPrice(a.price_cents);
              const contact = [a.contact_name, a.contact_phone, a.contact_email].filter(Boolean).join(' · ');
              const fav = favs.includes(a.id);
              const rel = ccRelative(a.created_at);
              return (
                <li key={a.id} style={styles.card}>
                  <div style={styles.photoWrap}>
                    {a.photo_data ? (
                      <img src={a.photo_data} alt="" style={styles.photo} loading="lazy" />
                    ) : (
                      <div style={styles.noPhoto}>📰</div>
                    )}
                    <span style={styles.priceBadge}>{price}</span>
                    <span style={styles.sellerBadge}>{cc('communitySellerLabel')}</span>
                  </div>
                  <div style={styles.cardBody}>
                    <div style={styles.cardTop}>
                      <span style={styles.cat}>{ccCat(a.category)}</span>
                      <button
                        type="button"
                        onClick={() => toggleFav(a.id)}
                        aria-label={fav ? cc('unfavorite') : cc('favorite')}
                        aria-pressed={fav}
                        title={fav ? cc('unfavorite') : cc('favorite')}
                        style={{ ...styles.iconBtn, color: fav ? '#c81e1e' : '#a89c86' }}
                      >
                        {fav ? '♥' : '♡'}
                      </button>
                      <button
                        type="button"
                        onClick={() => hideAd(a.id)}
                        aria-label={cc('hideAd')}
                        title={cc('hideAd')}
                        style={{ ...styles.iconBtn, color: '#a89c86', fontSize: 13 }}
                      >
                        ✕
                      </button>
                    </div>
                    <p style={styles.title}>{a.title}</p>
                    <p style={styles.price}>{price}</p>
                    {rel ? <span style={styles.meta}>{rel}</span> : null}
                    {a.description ? <p style={styles.desc}>{a.description}</p> : null}
                    {contact ? <p style={styles.contact}>{cc('contactAd', { contact })}</p> : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {hidden.length > 0 && (
          <p style={styles.safety}>
            {cc('hiddenAds', { count: hidden.length })}{' '}
            <button
              type="button"
              onClick={unhide}
              style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: ACCENT, fontSize: 12, textDecoration: 'underline', padding: 0, fontFamily: 'inherit' }}
            >
              {cc('showHidden')}
            </button>
          </p>
        )}

        <p style={styles.safety}>⚠ {cc('storefrontSafety')}</p>

        <div style={styles.cta}>
          <h2 style={{ fontSize: 18, fontWeight: 800, margin: '0 0 6px' }}>{cc('custAppTagline')}</h2>
          <p style={{ fontSize: 14, color: '#6d6252', margin: '0 0 12px' }}>{cc('custPublishedNote')}</p>
          <a href={homeHref} style={styles.solidBtn}>{cc('newAd')}</a>
        </div>
      </main>
    </div>
  );
}
