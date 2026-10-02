import { backend } from '../../lib/backend/current.js';

// Shared helpers for the office apps (Writer / Sheets / Slides).
// Documents live in /Documents as text files with distinctive extensions so
// Files can route double-clicks to the right app.

export const OFFICE_EXT = {
  writer: '.drift-doc',
  sheets: '.drift-sheet',
  slides: '.drift-slides',
};

export function baseName(path) {
  const i = path.lastIndexOf('/');
  return path.slice(i + 1);
}

export function dirName(path) {
  const i = path.lastIndexOf('/');
  return i <= 0 ? '/' : path.slice(0, i);
}

export function stripExt(name, ext) {
  return name.toLowerCase().endsWith(ext) ? name.slice(0, -ext.length) : name;
}

export async function ensureDocuments() {
  try {
    await backend.files.mkdir('/Documents');
  } catch {
    /* already exists */
  }
}

export async function listOfficeFiles(ext) {
  await ensureDocuments();
  const out = [];
  async function walk(path) {
    let entries;
    try {
      entries = await backend.files.list(path);
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.type === 'folder') await walk(e.path);
      else if (e.name.toLowerCase().endsWith(ext)) out.push(e);
    }
  }
  await walk('/Documents');
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

export async function readDoc(path) {
  const { text } = await backend.files.read(path);
  return text;
}

export async function saveDoc(path, text) {
  await ensureDocuments();
  return backend.files.write(path, text);
}

let nameSeq = 0;
export function untitledName(ext, label) {
  nameSeq += 1;
  return `/Documents/${label} ${nameSeq}${ext}`;
}
