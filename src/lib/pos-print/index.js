/* POS printer manager: per-store configuration, receipt printing, cash drawer.
 *
 * Config is device-local (localStorage, keyed by store id) — hardware
 * belongs to the machine, not the cloud account. Included in whole-account
 * backups so a restored account keeps its receipt preferences.
 */

import { buildReceipt } from './escpos.js';
import { renderReceiptHtml } from './receipt-html.js';
import { getTransport, forgetDevices } from './transports.js';

export const DEFAULT_PRINTER_CONFIG = {
  transport: 'browser',
  paperWidth: 80,
  baudRate: 9600,
  qzPrinterName: '',
  copies: 1,
  autoPrint: false,
  autoDrawerCash: true,
  drawerPin: 0,
  header: '',
  footer: 'Thank you — come again!',
};

const keyFor = (storeId) => `drift:pos-printer:${storeId}`;

export function getPrinterConfig(storeId) {
  try {
    const raw = localStorage.getItem(keyFor(storeId));
    if (!raw) return { ...DEFAULT_PRINTER_CONFIG };
    return { ...DEFAULT_PRINTER_CONFIG, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_PRINTER_CONFIG };
  }
}

export function savePrinterConfig(storeId, patch) {
  const next = { ...getPrinterConfig(storeId), ...patch };
  try {
    localStorage.setItem(keyFor(storeId), JSON.stringify(next));
  } catch { /* storage full/blocked — keep running without persistence */ }
  return next;
}

export function clearPrinterDevices() {
  forgetDevices();
}

/** taxLines: computed by the POS app for the receipt (same as the modal). */
export function saleForReceipt(recorded, taxLines) {
  return {
    number: recorded.number,
    createdAt: recorded.createdAt,
    items: recorded.items || [],
    subtotalCents: recorded.subtotalCents,
    discountCents: recorded.discountCents,
    taxLines: taxLines || [],
    totalCents: recorded.totalCents,
    method: recorded.method,
    tenderedCents: recorded.tenderedCents,
    changeCents: recorded.changeCents,
    cashierName: recorded.cashierName,
    customerName: recorded.customerName,
    // Organization snapshot at sale time (historical truth for the receipt —
    // never re-read from the live org row).
    orgName: recorded.orgName || null,
    orgType: recorded.orgType || null,
    orgTaxExempt: !!recorded.orgTaxExempt,
  };
}

export async function printReceipt({ sale, store, taxLines, config, labels = {} }) {
  const cfg = config || getPrinterConfig(store.id);
  const transport = getTransport(cfg.transport);
  if (!transport.isSupported()) {
    throw new Error(`“${transport.label}” is not available in this browser on this device.`);
  }
  if (cfg.transport === 'browser') {
    const html = renderReceiptHtml({ sale: saleForReceipt(sale, taxLines), store, paperWidth: cfg.paperWidth, header: cfg.header, footer: cfg.footer, labels });
    await transport.printHtml(html);
    return { via: 'browser' };
  }
  const bytes = buildReceipt({
    sale: saleForReceipt(sale, taxLines),
    store,
    paperWidth: cfg.paperWidth,
    header: cfg.header,
    footer: cfg.footer,
    labels,
  });
  const copies = Math.max(1, Math.min(5, cfg.copies || 1));
  for (let i = 0; i < copies; i++) {
    await transport.printBytes(bytes, { baudRate: cfg.baudRate, qzPrinterName: cfg.qzPrinterName, copies: 1 });
  }
  return { via: cfg.transport, bytes: bytes.length, copies };
}

/** Open the cash drawer through the printer's DK port. */
export async function openCashDrawer({ store, config }) {
  const cfg = config || getPrinterConfig(store.id);
  const transport = getTransport(cfg.transport);
  if (!transport.isSupported()) {
    throw new Error(`“${transport.label}” is not available in this browser on this device.`);
  }
  await transport.openDrawer(cfg.drawerPin, { baudRate: cfg.baudRate, qzPrinterName: cfg.qzPrinterName });
  return { via: cfg.transport };
}

/** Print a small self-test receipt (no sale needed). */
export async function testPrint({ store, config }) {
  const cfg = config || getPrinterConfig(store.id);
  const demoSale = {
    number: 'TEST',
    createdAt: new Date().toISOString(),
    items: [
      { qty: 1, name: 'Test item', priceCents: 100, itemDiscountCents: 0 },
      { qty: 2, name: 'Café crème', variantName: 'Large', priceCents: 250, itemDiscountCents: 50 },
    ],
    subtotalCents: 600,
    discountCents: 0,
    taxLines: [{ name: 'GST', rate: 5, cents: 30 }],
    totalCents: 630,
    method: 'cash',
    tenderedCents: 1000,
    changeCents: 370,
    cashierName: 'Test',
    customerName: null,
  };
  return printReceipt({ sale: demoSale, store, taxLines: demoSale.taxLines, config: cfg });
}

export function transportCapabilities() {
  const out = {};
  for (const [id, t] of Object.entries({ browser: getTransport('browser'), webusb: getTransport('webusb'), serial: getTransport('serial'), qz: getTransport('qz') })) {
    let supported = false;
    try { supported = t.isSupported(); } catch { supported = false; }
    out[id] = { label: t.label, hint: t.hint, supported };
  }
  return out;
}
