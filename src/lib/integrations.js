// Web-service connections (migration 071): the shop pastes links it
// already has (Facebook, Instagram, WhatsApp, a Google review link, an
// order-online page...) and the public storefront turns them into tidy
// buttons. There is no server of ours in the middle and no account to
// create — these helpers only clean, validate and build the links.
//
// Everything here is pure and defensive: a bad value returns '' (the
// button simply never renders) instead of throwing. URLs must be
// http/https — javascript:, data: and friends are refused — and every
// link is re-validated at render time on the public page, so a link
// that slipped past the admin form still cannot hurt a visitor.

// Only http/https links are ever kept. Returns the trimmed URL, or ''.
export function cleanHttpUrl(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  let url;
  try {
    url = new URL(raw);
  } catch {
    // Owners often paste "facebook.com/myshop" without the https:// part.
    try {
      url = new URL(`https://${raw}`);
    } catch {
      return '';
    }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
  if (!url.hostname.includes('.')) return '';
  return url.toString();
}

// WhatsApp "message us" link. Accepts a full wa.me link or a plain
// phone number ("+1 819 555 1234") and builds https://wa.me/<digits> —
// the number must carry its country code first (1 for Canada/US).
export function whatsappLink(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  if (/wa\.me\//i.test(raw)) return cleanHttpUrl(raw);
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) return '';
  return `https://wa.me/${digits}`;
}

// "Get directions" link: the owner's own link wins when they pasted
// one; otherwise Google Maps is pointed at the shop's street address.
export function directionsLink(address, overrideUrl) {
  const override = cleanHttpUrl(overrideUrl);
  if (override) return override;
  const q = String(address ?? '').trim();
  if (!q) return '';
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
}

// The link list the public storefront renders, in display order. Input
// is the flat field bag (profile row / RPC shop object); output is
// [{ key, href }] with every href already validated — invalid or empty
// entries are dropped here so the page can render blindly.
export function storefrontLinks(fields) {
  const f = fields || {};
  const links = [];
  const push = (key, href) => { if (href) links.push({ key, href }); };
  push('order', cleanHttpUrl(f.order_url));
  push('whatsapp', whatsappLink(f.whatsapp_phone));
  push('directions', directionsLink(f.address, f.directions_url));
  push('review', cleanHttpUrl(f.review_url));
  push('facebook', cleanHttpUrl(f.facebook_url));
  push('instagram', cleanHttpUrl(f.instagram_url));
  push('tiktok', cleanHttpUrl(f.tiktok_url));
  push('newsletter', cleanHttpUrl(f.newsletter_url));
  return links;
}

// Fields saved from the admin form (camelCase, as the form holds them)
// into storefront_profiles columns. Mirrors the validation above: a
// value that does not validate is stored as null, never as a bad link.
export function cleanLinkFields(form) {
  const f = form || {};
  const or = (v) => cleanHttpUrl(v) || null;
  return {
    address: String(f.address ?? '').trim() || null,
    facebook_url: or(f.facebookUrl),
    instagram_url: or(f.instagramUrl),
    tiktok_url: or(f.tiktokUrl),
    // Stored as pasted (number or wa.me link); whatsappLink() builds
    // the real href at render time, so either shape round-trips.
    whatsapp_phone: String(f.whatsappPhone ?? '').trim() || null,
    review_url: or(f.reviewUrl),
    directions_url: or(f.directionsUrl),
    order_url: or(f.orderUrl),
    newsletter_url: or(f.newsletterUrl),
  };
}

/* ------------------------------------------------------------------ */
/* Appointments → calendar (.ics) download                             */
/*                                                                     */
/* A customer appointment the shop wants on a phone calendar: the     */
/* .ics file is generated right here and downloaded — no account, no  */
/* external service, works with Apple/Google/Outlook calendars.       */
/* ------------------------------------------------------------------ */

function icsEscape(text) {
  return String(text ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

function icsDate(date) {
  // UTC basic format: 20261001T143000Z
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

export function appointmentIcs({ title, startsAt, endsAt, notes, customerName }) {
  const start = new Date(startsAt);
  const end = new Date(endsAt);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return '';
  const description = [customerName ? `Customer: ${customerName}` : '', notes || '']
    .filter(Boolean)
    .join('\n');
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Drift Shop//Appointments//EN',
    'BEGIN:VEVENT',
    `UID:${Date.now()}-${Math.random().toString(36).slice(2, 10)}@drift-shop`,
    `DTSTAMP:${icsDate(new Date())}`,
    `DTSTART:${icsDate(start)}`,
    `DTEND:${icsDate(end)}`,
    `SUMMARY:${icsEscape(title || 'Appointment')}`,
  ];
  if (description) lines.push(`DESCRIPTION:${icsEscape(description)}`);
  lines.push('END:VEVENT', 'END:VCALENDAR');
  return lines.join('\r\n');
}

// Browser download of the .ics for one appointment. Returns false when
// the dates are unusable (caller shows its own error).
export function downloadAppointmentIcs(appt) {
  const ics = appointmentIcs(appt || {});
  if (!ics) return false;
  const blob = new Blob([ics], { type: 'text/calendar;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  const slug = String(appt.title || 'appointment')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'appointment';
  a.download = `${slug}.ics`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 100);
  return true;
}
