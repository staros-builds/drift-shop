/* QR code helper — wraps the vendored qrcode-generator (MIT) with a tiny
 * Vendra-flavored API. Used for digital receipts in POS and anywhere else a
 * scannable code is handy. Pure functions; safe to call anywhere.
 */
import qrcode from 'qrcode-generator';
import { localeTag } from './localeTag.js';

/**
 * Build a QR code as an SVG string.
 * @param {string} text — payload (keep under ~400 chars for easy scanning)
 * @param {{ size?: number, margin?: number, dark?: string, light?: string }} opts
 */
export function qrSvg(text, opts = {}) {
  const { size = 160, margin = 2, dark = '#1a1a1a', light = '#ffffff' } = opts;
  const qr = qrcode(0, 'M'); // 0 = auto version, M = 15% error correction
  qr.addData(String(text ?? ''));
  qr.make();
  const count = qr.getModuleCount();
  const cell = (size - margin * 2) / count;
  let rects = '';
  for (let r = 0; r < count; r++) {
    for (let c = 0; c < count; c++) {
      if (qr.isDark(r, c)) {
        const x = (margin + c * cell).toFixed(2);
        const y = (margin + r * cell).toFixed(2);
        rects += `<rect x="${x}" y="${y}" width="${(cell + 0.5).toFixed(2)}" height="${(cell + 0.5).toFixed(2)}"/>`;
      }
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="QR code">` +
    `<rect width="${size}" height="${size}" fill="${light}"/>` +
    `<g fill="${dark}">${rects}</g></svg>`
  );
}

/** QR code as a data: URL (handy for <img> tags). */
export function qrDataUrl(text, opts = {}) {
  const svg = qrSvg(text, opts);
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/**
 * Compact digital-receipt payload: human-readable lines so any QR scanner
 * shows a usable receipt without a network round-trip.
 */
export function receiptQrText({ sale, store }) {
  const fmt = (c) => `${store?.currency || '$'}${(c / 100).toFixed(2)}`;
  const lines = [
    store?.name || 'Receipt',
    `Sale #${sale?.number ?? '?'}`,
    new Date(sale?.createdAt || Date.now()).toLocaleString(localeTag()),
    ...((sale?.items || []).map((i) => `${i.qty}x ${i.name} ${fmt(i.priceCents * i.qty - (i.itemDiscountCents || 0))}`)),
    `TOTAL ${fmt(sale?.totalCents || 0)}`,
  ];
  return lines.join('\n');
}
