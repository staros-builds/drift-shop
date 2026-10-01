// Shared Bouquinerie validation + CSV helpers (no DOM, no React).
// Used by both the local JSON backend and the Supabase adapter so the two
// stay byte-identical on validation, duplicate detection, and CSV shape.

export const BQ_KINDS = ['book', 'item'];
export const BQ_SOURCES = ['donation', 'purchase', 'supplier'];
export const BQ_STATUSES = ['store', 'sorting', 'fair', 'sold', 'donated', 'recycled'];
export const BQ_ORDER_STATUSES = ['requested', 'ordered', 'received', 'cancelled'];

/** Canonical ISBN: strip hyphens/spaces, uppercase. */
export function normIsbn(v) {
  return String(v ?? '').replace(/[-\s]/g, '').toUpperCase() || null;
}

/** Canonical text for duplicate comparison (accents/punctuation-insensitive). */
export function normText(v) {
  return String(v ?? '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim() || null;
}

/**
 * Validate + normalize a catalogue item. Throws on bad input.
 * genId() supplies ids for new rows (lets each backend use its own scheme).
 */
export function cleanBqItem(raw, genId) {
  const o = raw && typeof raw === 'object' ? raw : {};
  const title = String(o.title ?? '').trim().slice(0, 300);
  if (!title) throw new Error('Title is required.');
  const kind = BQ_KINDS.includes(o.kind) ? o.kind : 'book';
  const isbn = normIsbn(o.isbn);
  if (isbn && !/^(?:\d{9}[\dX]|\d{13})$/.test(isbn)) throw new Error('ISBN must be 10 or 13 digits.');
  const qty = Math.max(0, Math.floor(Number(o.qty) || 0));
  const price = Math.max(0, Math.round((Number(o.price) || 0) * 100) / 100);
  const now = new Date().toISOString();
  return {
    id: o.id || (genId ? genId() : `bq-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`),
    kind,
    title,
    author: String(o.author ?? '').trim().slice(0, 200) || null,
    isbn,
    category: String(o.category ?? '').trim().slice(0, 120) || null,
    isNew: o.isNew === true,
    condition: String(o.condition ?? '').trim().slice(0, 200) || null,
    qty,
    price,
    shelf: String(o.shelf ?? '').trim().slice(0, 80) || null,
    source: BQ_SOURCES.includes(o.source) ? o.source : 'donation',
    status: BQ_STATUSES.includes(o.status) ? o.status : 'sorting',
    abeRef: String(o.abeRef ?? '').trim().slice(0, 120) || null,
    abeStatus: String(o.abeStatus ?? '').trim().slice(0, 80) || null,
    notes: String(o.notes ?? '').trim().slice(0, 2000) || null,
    createdAt: o.createdAt || now,
    updatedAt: now,
  };
}

export function bqCsvHeaders() {
  return ['kind', 'title', 'author', 'isbn', 'category', 'is_new', 'condition', 'qty', 'price', 'shelf', 'source', 'status', 'abe_ref', 'abe_status', 'notes'];
}

const csvEsc = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

/** Catalogue items (camelCase) → RFC-4180 CSV string. */
export function bqExportCsv(items) {
  const lines = [bqCsvHeaders().join(',')];
  for (const x of items || []) {
    lines.push([
      x.kind, x.title, x.author, x.isbn, x.category, x.isNew ? '1' : '0',
      x.condition, x.qty, x.price, x.shelf, x.source, x.status,
      x.abeRef, x.abeStatus, x.notes,
    ].map(csvEsc).join(','));
  }
  return lines.join('\r\n');
}

/**
 * Parse CSV text into { rows, errors } without writing anything.
 * Rows are cleaned catalogue items (no ids — the importer assigns them).
 */
export function bqParseCsv(text, genId) {
  const rows = [];
  const errors = [];
  const src = String(text ?? '').replace(/^﻿/, '');
  if (!src.trim()) { errors.push('The file is empty.'); return { rows, errors }; }
  const records = [];
  let cur = [''], field = '', inQ = false;
  const pushField = () => { cur[cur.length - 1] = field; field = ''; };
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQ) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else inQ = false;
      } else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { pushField(); cur.push(''); }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      pushField(); records.push(cur); cur = [''];
    } else field += c;
  }
  pushField();
  if (cur.length > 1 || cur[0] !== '') records.push(cur);
  if (!records.length) { errors.push('No rows found.'); return { rows, errors }; }
  const header = records[0].map((h) => String(h).trim().toLowerCase());
  const want = bqCsvHeaders();
  const missing = want.filter((h) => !header.includes(h));
  if (missing.length) errors.push('Missing columns: ' + missing.join(', '));
  const idx = Object.fromEntries(header.map((h, i) => [h, i]));
  const get = (rec, h) => (idx[h] !== undefined ? (rec[idx[h]] ?? '').trim() : '');
  for (let r = 1; r < records.length; r++) {
    const rec = records[r];
    if (rec.every((c) => !String(c).trim())) continue;
    try {
      rows.push(cleanBqItem({
        kind: get(rec, 'kind') || 'book',
        title: get(rec, 'title'),
        author: get(rec, 'author'),
        isbn: get(rec, 'isbn'),
        category: get(rec, 'category'),
        isNew: ['1', 'true', 'yes', 'oui'].includes(get(rec, 'is_new').toLowerCase()),
        condition: get(rec, 'condition'),
        qty: get(rec, 'qty'),
        price: get(rec, 'price'),
        shelf: get(rec, 'shelf'),
        source: get(rec, 'source'),
        status: get(rec, 'status'),
        abeRef: get(rec, 'abe_ref'),
        abeStatus: get(rec, 'abe_status'),
        notes: get(rec, 'notes'),
      }, genId));
    } catch (e) {
      errors.push('Row ' + (r + 1) + ': ' + (e.message || 'invalid'));
    }
  }
  return { rows, errors };
}
