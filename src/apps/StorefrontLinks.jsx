import React from 'react';
import {
  Facebook,
  Instagram,
  Mail,
  MessageCircle,
  Music2,
  Navigation,
  ShoppingBag,
  Star,
} from 'lucide-react';
import { storefrontLinks } from '../lib/integrations.js';
import { fr } from '../lib/locales/fr.js';
import { en } from '../lib/locales/en.js';
import { es } from '../lib/locales/es.js';
import { pt } from '../lib/locales/pt.js';

// The connect-links row on the public storefront (migration 071):
// buttons built from links the shop owner pasted in the Admin panel.
// This component ONLY renders links that integrations.js validated
// (http/https), and renders nothing when the shop added none — so it
// is safe to mount unconditionally under the contact section.
//
// Self-contained inline styles, matching StorefrontPublic: the public
// page carries no theme. Labels come from the locale files via the
// `lang` chosen by StorefrontPublic (the page runs outside the app,
// no useLang there).
const LABELS = {
  order: { icon: ShoppingBag, key: 'linkOrder' },
  whatsapp: { icon: MessageCircle, key: 'linkWhatsapp' },
  directions: { icon: Navigation, key: 'linkDirections' },
  review: { icon: Star, key: 'linkReview' },
  facebook: { icon: Facebook, text: 'Facebook' },
  instagram: { icon: Instagram, text: 'Instagram' },
  tiktok: { icon: Music2, text: 'TikTok' },
  newsletter: { icon: Mail, key: 'linkNewsletter' },
};

const PUB = {
  fr: fr.storefront.public,
  en: en.storefront.public,
  es: es.storefront.public,
  pt: pt.storefront.public,
};

const styles = {
  section: { marginTop: 32 },
  row: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 10,
    justifyContent: 'center',
  },
  link: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 7,
    fontSize: 14,
    fontWeight: 600,
    color: '#26221c',
    border: '1px solid #c9bda6',
    borderRadius: 999,
    padding: '8px 16px',
    textDecoration: 'none',
    background: '#fffdf8',
  },
  address: {
    marginTop: 10,
    textAlign: 'center',
    fontSize: 13,
    color: '#6d6252',
  },
};

export default function StorefrontLinks({ shop, lang = 'fr' }) {
  const P = PUB[lang] || PUB.fr;
  const s = shop || {};
  const links = storefrontLinks({
    order_url: s.links?.order_url,
    whatsapp_phone: s.links?.whatsapp_phone,
    directions_url: s.links?.directions_url,
    review_url: s.links?.review_url,
    facebook_url: s.links?.facebook_url,
    instagram_url: s.links?.instagram_url,
    tiktok_url: s.links?.tiktok_url,
    newsletter_url: s.links?.newsletter_url,
    address: s.address,
  });
  const address = String(s.address || '').trim();
  if (links.length === 0 && !address) return null;

  return (
    <section style={styles.section}>
      {links.length > 0 && (
        <div style={styles.row}>
          {links.map(({ key, href }) => {
            const Icon = LABELS[key].icon;
            return (
              <a
                key={key}
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                style={styles.link}
              >
                <Icon size={15} aria-hidden />
                {LABELS[key].key ? P[LABELS[key].key] : LABELS[key].text}
              </a>
            );
          })}
        </div>
      )}
      {address && <p style={styles.address}>{address}</p>}
    </section>
  );
}
