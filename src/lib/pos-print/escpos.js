import { localeTag } from '../localeTag.js';
/* ESC/POS command builder + receipt composer for Vendra POS.
 *
 * Pure module (no DOM, no browser APIs): builds the exact byte stream sent to
 * thermal receipt printers. Works with any ESC/POS-compatible printer
 * (Epson TM-series, XPrinter, Star in ESC/POS mode, most generic 58/80mm
 * thermal printers) over USB (WebUSB), serial (Web Serial) or a bridge
 * such as QZ Tray.
 *
 * Cash drawers almost always connect to the printer's DK (drawer-kick)
 * port, so opening the drawer = sending the kick pulse to the printer.
 */

export const PAPER_COLS = { 80: 42, 58: 32 };

// Standard drawer-kick pulse timings (t1=25*2ms on, t2=250*2ms off).
export const KICK_T1 = 0x19;
export const KICK_T2 = 0xfa;

/* ------------------------------------------------------------------ */
/* Text encoding: thermal printers speak 7-bit-ish code pages. We      */
/* transliterate common Latin accents/symbols to ASCII so French       */
/* (Québec!) receipts stay readable instead of printing garbage.       */
/* The browser-print path keeps full Unicode via HTML.                 */
/* ------------------------------------------------------------------ */

const TRANSLIT = {
  à: 'a', á: 'a', â: 'a', ä: 'a', ã: 'a', å: 'a', æ: 'ae',
  ç: 'c', è: 'e', é: 'e', ê: 'e', ë: 'e',
  ì: 'i', í: 'i', î: 'i', ï: 'i',
  ñ: 'n', ò: 'o', ó: 'o', ô: 'o', ö: 'o', õ: 'o', ø: 'o', œ: 'oe',
  ù: 'u', ú: 'u', û: 'u', ü: 'u',
  ý: 'y', ÿ: 'y', ß: 'ss', ð: 'd', þ: 'th',
  À: 'A', Á: 'A', Â: 'A', Ä: 'A', Ã: 'A', Å: 'A', Æ: 'AE',
  Ç: 'C', È: 'E', É: 'E', Ê: 'E', Ë: 'E',
  Ì: 'I', Í: 'I', Î: 'I', Ï: 'I',
  Ñ: 'N', Ò: 'O', Ó: 'O', Ô: 'O', Ö: 'O', Õ: 'O', Ø: 'O', Œ: 'OE',
  Ù: 'U', Ú: 'U', Û: 'U', Ü: 'U', Ý: 'Y',
  '€': 'EUR', '£': 'GBP', '¥': 'JPY', '©': '(c)', '®': '(r)',
  '°': 'o', '«': '"', '»': '"', '‘': "'", '’': "'", '“': '"', '”': '"',
  '–': '-', '—': '-', '…': '...', '•': '*', '·': '-', '×': 'x', '÷': '/',
};

export function encodeText(str) {
  const out = [];
  for (const ch of String(str ?? '')) {
    const code = ch.codePointAt(0);
    if (code < 128) {
      // Drop control bytes (except newline/tab): a raw ESC in a product
      // name must never reach the printer as a command byte.
      if (code === 10 || code === 9 || code >= 32) out.push(code);
    } else if (TRANSLIT[ch] !== undefined) {
      for (const c of TRANSLIT[ch]) out.push(c.charCodeAt(0));
    } else {
      out.push(63); // '?'
    }
  }
  return Uint8Array.from(out);
}

/* ------------------------------------------------------------------ */
/* Builder                                                             */
/* ------------------------------------------------------------------ */

export class EscPos {
  constructor() {
    this.parts = [];
  }
  raw(...bytes) {
    this.parts.push(Uint8Array.from(bytes));
    return this;
  }
  text(str) {
    this.parts.push(encodeText(str));
    return this;
  }
  line(str = '') {
    this.parts.push(encodeText(str + '\n'));
    return this;
  }
  init() { return this.raw(0x1b, 0x40); }
  align(n) { return this.raw(0x1b, 0x61, n); } // 0 left, 1 center, 2 right
  bold(on = true) { return this.raw(0x1b, 0x45, on ? 1 : 0); }
  doubleSize(on = true) { return this.raw(0x1d, 0x21, on ? 0x11 : 0x00); }
  feed(n = 3) { return this.raw(0x1b, 0x64, Math.max(0, Math.min(255, n))); }
  cut() { return this.raw(0x1d, 0x56, 0x42, 0x00); } // partial cut
  /** Kick the cash drawer on the printer's DK port (pin 0 or 1). */
  drawerKick(pin = 0) { return this.raw(0x1b, 0x70, pin ? 1 : 0, KICK_T1, KICK_T2); }
  /** QR code (model 2). data must be ASCII. */
  qr(data, size = 6) {
    const bytes = encodeText(data);
    const pL = (bytes.length + 3) & 0xff;
    const pH = ((bytes.length + 3) >> 8) & 0xff;
    return this
      .raw(0x1d, 0x28, 0x6b, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00) // model 2
      .raw(0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x43, Math.max(1, Math.min(16, size))) // module size
      .raw(0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x45, 0x31) // error correction M
      .raw(0x1d, 0x28, 0x6b, pL, pH, 0x31, 0x50, 0x30)
      .raw(...bytes)
      .raw(0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x51, 0x30); // print
  }
  bytes() {
    const total = this.parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let o = 0;
    for (const p of this.parts) { out.set(p, o); o += p.length; }
    return out;
  }
}

export function drawerKickBytes(pin = 0) {
  return new EscPos().drawerKick(pin).bytes();
}

/* ------------------------------------------------------------------ */
/* Receipt composer                                                    */
/* ------------------------------------------------------------------ */

function rule(width) { return '-'.repeat(width); }

function twoCol(left, right, width) {
  const l = String(left ?? '');
  const r = String(right ?? '');
  if (l.length + r.length + 1 <= width) {
    return l + ' '.repeat(width - l.length - r.length) + r;
  }
  // Wrap the left side; right side stays on the last line.
  const lines = [];
  let rest = l;
  const firstWidth = width - r.length - 1;
  while (rest.length > width) {
    lines.push(rest.slice(0, width));
    rest = rest.slice(width);
  }
  if (rest.length > firstWidth && lines.length === 0) {
    lines.push(rest.slice(0, firstWidth));
    rest = rest.slice(firstWidth);
  }
  lines.push(rest + ' '.repeat(Math.max(1, firstWidth - rest.length + (r.length ? 0 : 0))) + r);
  return lines.join('\n');
}

export function fmtMoney(cents, currency = '$') {
  const sign = cents < 0 ? '-' : '';
  const v = Math.abs(cents);
  return `${sign}${currency}${(v / 100).toFixed(2)}`;
}

/**
 * Compose a printable receipt.
 * sale: { number, createdAt, items:[{qty,name,variantName,priceCents,itemDiscountCents}],
 *         subtotalCents, discountCents, taxLines:[{name,rate,cents}], totalCents,
 *         method, tenderedCents, changeCents, cashierName, customerName }
 * store: { name, currency }
 * opts: { paperWidth: 80|58, header, footer, qrText, labels }
 * labels overrides the English defaults below (pass translated labels).
 */
export const RECEIPT_LABELS_EN = {
  sale: 'Sale',
  cashier: 'Cashier',
  customer: 'Customer',
  org: 'Org',
  taxExemptNonprofit: 'Tax exempt — non-profit organization',
  taxExemptGeneric: 'Tax exempt — tax-exempt organization',
  itemDiscount: 'Item discount',
  subtotal: 'Subtotal',
  discount: 'Discount',
  total: 'TOTAL',
  cashTendered: 'Cash tendered',
  change: 'Change',
  paidBy: 'Paid by',
  card: 'Card',
  other: 'Other',
};
export function buildReceipt({ sale, store, paperWidth = 80, header = '', footer = 'Thank you — come again!', qrText = '', labels = {} }) {
  const L = { ...RECEIPT_LABELS_EN, ...labels };
  const width = PAPER_COLS[paperWidth] || PAPER_COLS[80];
  const cur = store.currency || '$';
  const p = new EscPos();
  p.init();

  // Header
  p.align(1).doubleSize(true).bold(true);
  p.line(store.name || 'Store');
  p.doubleSize(false).bold(false);
  if (header) {
    for (const hl of String(header).split('\n').slice(0, 4)) p.line(hl);
  }
  p.line(rule(width));

  // Meta (left aligned)
  p.align(0);
  const dt = new Date(sale.createdAt || Date.now());
  const dateStr = dt.toLocaleDateString(localeTag()) + ' ' + dt.toLocaleTimeString(localeTag(), { hour: '2-digit', minute: '2-digit' });
  p.line(twoCol(dateStr, `${L.sale} #${sale.number ?? ''}`, width));
  if (sale.cashierName) p.line(`${L.cashier}: ${sale.cashierName}`);
  if (sale.customerName) p.line(`${L.customer}: ${sale.customerName}`);
  if (sale.orgName) p.line(`${L.org}: ${sale.orgName}`);
  if (sale.orgTaxExempt) p.line(sale.orgType === 'obnl' ? L.taxExemptNonprofit : L.taxExemptGeneric);
  p.line(rule(width));

  // Items
  for (const i of sale.items || []) {
    const name = `${i.qty} x ${i.name}${i.variantName ? ` (${i.variantName})` : ''}`;
    p.line(twoCol(name, fmtMoney(i.priceCents * i.qty, cur), width));
    if (i.itemDiscountCents > 0) {
      p.line(twoCol('  ' + L.itemDiscount, '-' + fmtMoney(i.itemDiscountCents, cur), width));
    }
  }
  p.line(rule(width));

  // Totals
  p.line(twoCol(L.subtotal, fmtMoney(sale.subtotalCents, cur), width));
  if (sale.discountCents > 0) p.line(twoCol(L.discount, '-' + fmtMoney(sale.discountCents, cur), width));
  for (const t of sale.taxLines || []) {
    p.line(twoCol(`${t.name} (${t.rate}%)`, fmtMoney(t.cents, cur), width));
  }
  p.bold(true).doubleSize(true);
  // Double-width mode: each character occupies two columns, so the padded
  // line must target half the paper width or it wraps on real printers.
  p.line(twoCol(L.total, fmtMoney(sale.totalCents, cur), Math.floor(width / 2)));
  p.doubleSize(false).bold(false);
  // Tax-exempt organization sales carry the exemption on the receipt.
  if (sale.taxExempt) {
    p.align(1);
    p.line('Exonere de taxes / Tax exempt');
    p.align(0);
  }
  p.line(rule(width));

  // Payment
  if (sale.method === 'cash') {
    p.line(twoCol(L.cashTendered, fmtMoney(sale.tenderedCents, cur), width));
    p.line(twoCol(L.change, fmtMoney(sale.changeCents, cur), width));
  } else {
    const label = sale.method === 'card' ? L.card : L.other;
    p.line(twoCol(L.paidBy, label, width));
  }

  // QR (optional — e.g. feedback URL or sale id)
  if (qrText) {
    p.feed(1).align(1).qr(qrText).align(0);
  }

  // Footer
  p.feed(1).align(1);
  for (const fl of String(footer).split('\n').slice(0, 4)) p.line(fl);
  p.align(0).feed(4).cut();
  return p.bytes();
}
