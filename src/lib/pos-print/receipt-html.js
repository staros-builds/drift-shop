/* HTML receipt for the browser-print transport.
 * Mirrors the on-screen ReceiptModal layout, styled for narrow receipt paper
 * (80mm / 58mm). Full Unicode is preserved here (unlike the ESC/POS path).
 */

import { fmtMoney, RECEIPT_LABELS_EN } from './escpos.js';
import { localeTag } from '../localeTag.js';

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function renderReceiptHtml({ sale, store, paperWidth = 80, header = '', footer = 'Thank you — come again!', labels = {} }) {
  const L = { ...RECEIPT_LABELS_EN, ...labels };
  const cur = store.currency || '$';
  const dt = new Date(sale.createdAt || Date.now());
  const dateStr = dt.toLocaleDateString(localeTag()) + ' ' + dt.toLocaleTimeString(localeTag(), { hour: '2-digit', minute: '2-digit' });
  const widthMm = paperWidth === 58 ? 58 : 80;

  const items = (sale.items || []).map((i) => `
      <div class="item">
        <div class="row"><span>${i.qty} × ${esc(i.name)}${i.variantName ? ` (${esc(i.variantName)})` : ''}</span><span>${esc(fmtMoney(i.priceCents * i.qty, cur))}</span></div>
        ${i.itemDiscountCents > 0 ? `<div class="row dim"><span>${esc(L.itemDiscount)}</span><span>−${esc(fmtMoney(i.itemDiscountCents, cur))}</span></div>` : ''}
      </div>`).join('');

  const taxes = (sale.taxLines || []).map((t) => `
      <div class="row"><span>${esc(t.name)} (${esc(t.rate)}%)</span><span>${esc(fmtMoney(t.cents, cur))}</span></div>`).join('');

  const payment = sale.method === 'cash' ? `
      <div class="row"><span>${esc(L.cashTendered)}</span><span>${esc(fmtMoney(sale.tenderedCents, cur))}</span></div>
      <div class="row"><span>${esc(L.change)}</span><span>${esc(fmtMoney(sale.changeCents, cur))}</span></div>` : `
      <div class="row"><span>${esc(L.paidBy)}</span><span>${esc(sale.method === 'card' ? L.card : L.other)}</span></div>`;

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Receipt #${esc(sale.number ?? '')}</title>
<style>
  @page { size: ${widthMm}mm auto; margin: 0; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 4mm 3mm; font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 11px; color: #000; width: ${widthMm}mm; }
  h1 { font-size: 16px; text-align: center; margin: 0 0 2mm; }
  .center { text-align: center; }
  .dim { color: #333; }
  .meta { font-size: 10px; }
  hr { border: none; border-top: 1px dashed #000; margin: 2.5mm 0; }
  .row { display: flex; justify-content: space-between; gap: 2mm; padding: 0.4mm 0; }
  .item { padding: 0.4mm 0; }
  .total { font-size: 14px; font-weight: bold; }
  .footer { margin-top: 3mm; text-align: center; font-size: 10px; }
  @media screen { body { background: #fff; border: 1px solid #ccc; margin: 8px auto; } }
</style></head><body>
  <h1>${esc(store.name || 'Store')}</h1>
  ${header ? `<div class="center meta">${esc(header).replace(/\n/g, '<br>')}</div><hr>` : ''}
  <div class="meta"><div class="row"><span>${esc(dateStr)}</span><span>${esc(L.sale)} #${esc(sale.number ?? '')}</span></div>
  ${sale.cashierName ? `<div>${esc(L.cashier)}: ${esc(sale.cashierName)}</div>` : ''}
  ${sale.customerName ? `<div>${esc(L.customer)}: ${esc(sale.customerName)}</div>` : ''}
  ${sale.orgName ? `<div>${esc(L.org)}: ${esc(sale.orgName)}</div>` : ''}
  ${sale.orgTaxExempt ? `<div><strong>${esc(sale.orgType === 'obnl' ? L.taxExemptNonprofit : L.taxExemptGeneric)}</strong></div>` : ''}</div>
  <hr>
  ${items}
  <hr>
  <div class="row"><span>${esc(L.subtotal)}</span><span>${esc(fmtMoney(sale.subtotalCents, cur))}</span></div>
  ${sale.discountCents > 0 ? `<div class="row"><span>${esc(L.discount)}</span><span>−${esc(fmtMoney(sale.discountCents, cur))}</span></div>` : ''}
  ${taxes}
  <div class="row total"><span>${esc(L.total)}</span><span>${esc(fmtMoney(sale.totalCents, cur))}</span></div>
  ${sale.taxExempt ? `<div class="center dim" style="margin-top:2mm"><b>Exonéré de taxes / Tax exempt</b></div>` : ''}
  <hr>
  ${payment}
  <div class="footer">${esc(footer).replace(/\n/g, '<br>')}</div>
</body></html>`;
}
