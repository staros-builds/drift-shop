import { useSyncExternalStore } from 'react';
import {
  Pencil, Image, Radio, Calculator, Map as MapIcon, MapPin, Disc3, ClipboardList,
  ListChecks, CalendarCheck, FileText, Paintbrush, Shapes, CloudSun, Cloud,
  Timer, BookOpen, Code, Terminal, Newspaper, Gamepad2, Headphones,
  Clapperboard, Cookie, Blocks, StickyNote,
} from 'lucide-react';
import { backend } from './backend/current.js';

/**
 * Web apps: websites installed into Drift like real OS apps (Roku-style).
 *
 * The catalog below was verified live (2026-09-28) with curl: every entry
 * qualifies only if X-Frame-Options is absent (or ALLOWALL) and there is no
 * blocking CSP frame-ancestors. Entries marked LOGIN REQUIRED render their
 * login page inside the viewer — sign-in itself happens on the site's own
 * domain. Headers only were verified; rendering/login behavior is covered
 * by the viewer's fallback banner.
 *
 * Installed ids persist per user via backend.files ('/System/webapps.json') —
 * the settings adapters whitelist keys, so settings storage can't be used here.
 */

export const WEBAPP_CATALOG = [
  { id: 'excalidraw', title: 'Excalidraw', url: 'https://excalidraw.com', icon: Pencil, category: 'Drawing', description: 'Whiteboard for sketches and diagrams. No login needed.' },
  { id: 'photopea', title: 'Photopea', url: 'https://www.photopea.com', icon: Image, category: 'Drawing', description: 'Photoshop-class image editor in the browser. No login needed.', big: true },
  { id: 'jspaint', title: 'JS Paint', url: 'https://jspaint.app', icon: Paintbrush, category: 'Drawing', description: 'Faithful MS Paint remake. No login needed.' },
  { id: 'tldraw', title: 'tldraw', url: 'https://www.tldraw.com', icon: Shapes, category: 'Drawing', description: 'Infinite-canvas whiteboard. No login needed.' },
  { id: 'radiogarden', title: 'Radio Garden', url: 'https://radio.garden', icon: Radio, category: 'Radio', description: 'Spin the globe and listen to live world radio.' },
  { id: 'desmos', title: 'Desmos Calculator', url: 'https://www.desmos.com/calculator', icon: Calculator, category: 'Utilities', description: 'Scientific and graphing calculator.' },
  { id: 'pomofocus', title: 'Pomofocus', url: 'https://pomofocus.io', icon: Timer, category: 'Utilities', description: 'Pomodoro focus timer. No login needed.' },
  { id: 'mapycz', title: 'Mapy.cz', url: 'https://mapy.cz', icon: MapIcon, category: 'Maps', description: 'Full OSM-based maps with an English version.' },
  { id: 'osmembed', title: 'OpenStreetMap', url: 'https://www.openstreetmap.org/export/embed.html', icon: MapPin, category: 'Maps', description: 'Official OSM embed map (the main site blocks framing).' },
  { id: 'bandcamp', title: 'Bandcamp', url: 'https://bandcamp.com', icon: Disc3, category: 'Music', description: 'Music discovery and streaming. Tap play to start (autoplay policy).' },
  { id: 'audius', title: 'Audius', url: 'https://audius.co', icon: Headphones, category: 'Music', description: 'Decentralized music streaming. No login needed.' },
  { id: 'odysee', title: 'Odysee', url: 'https://odysee.com', icon: Clapperboard, category: 'Video', description: 'Video platform. Playback needs a click (autoplay policy).' },
  { id: 'trello', title: 'Trello', url: 'https://trello.com', icon: ClipboardList, category: 'Office', description: 'Kanban boards. LOGIN REQUIRED to be useful.' },
  { id: 'todoist', title: 'Todoist', url: 'https://todoist.com', icon: ListChecks, category: 'Office', description: 'Task manager. LOGIN REQUIRED.' },
  { id: 'ticktick', title: 'TickTick', url: 'https://ticktick.com', icon: CalendarCheck, category: 'Office', description: 'Tasks, calendar and pomodoro. LOGIN REQUIRED.' },
  { id: 'stackedit', title: 'StackEdit', url: 'https://stackedit.io', icon: FileText, category: 'Notes', description: 'Markdown editor with cloud sync.' },
  { id: 'dillinger', title: 'Dillinger', url: 'https://dillinger.io', icon: StickyNote, category: 'Notes', description: 'Markdown editor with live preview. No login needed.' },
  { id: 'wttr', title: 'wttr.in', url: 'https://wttr.in', icon: CloudSun, category: 'Weather', description: 'Instant weather in a quirky plain-text style.' },
  { id: 'openweather', title: 'OpenWeatherMap', url: 'https://openweathermap.org', icon: Cloud, category: 'Weather', description: 'Fuller weather site with maps.' },
  { id: 'devdocs', title: 'DevDocs', url: 'https://devdocs.io', icon: BookOpen, category: 'Dev tools', description: 'Fast API documentation browser.' },
  { id: 'jsfiddle', title: 'JSFiddle', url: 'https://jsfiddle.net', icon: Code, category: 'Dev tools', description: 'Code playground for quick experiments.' },
  { id: 'stackblitz', title: 'StackBlitz', url: 'https://stackblitz.com', icon: Terminal, category: 'Dev tools', description: 'In-browser IDE. LOGIN REQUIRED to save work.' },
  { id: 'npr', title: 'NPR', url: 'https://www.npr.org', icon: Newspaper, category: 'News', description: 'Major news site that permits framing.' },
  { id: 'game2048', title: '2048', url: 'https://2048game.com', icon: Gamepad2, category: 'Games', description: 'The classic sliding-tile puzzle. No login needed.' },
  { id: 'cookieclicker', title: 'Cookie Clicker', url: 'https://orteil.dashnet.org/cookieclicker/', icon: Cookie, category: 'Games', description: 'The original idle game. No login needed.' },
  { id: 'tetris', title: 'Tetris', url: 'https://tetris.com/play-tetris', icon: Blocks, category: 'Games', description: 'Official Tetris in the browser. No login needed.' },
];

const WEBAPP_INDEX = new Map(WEBAPP_CATALOG.map((e) => [e.id, e]));

export const WEBAPP_CATEGORIES = [...new Set(WEBAPP_CATALOG.map((e) => e.category))];

// ---- installed-list persistence (per user, both backend modes) ------------

const STORE_PATH = '/System/webapps.json';

let cachedIds = null; // null = not loaded yet
let cacheUserKey = null;
let loadPromise = null;
const listeners = new Set();

function emit() {
  for (const fn of listeners) fn();
}

function subscribeWebApps(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Sync snapshot of installed ids (empty until ensureWebApps() resolves).
 * MUST return a stable reference: useSyncExternalStore treats a new array
 * identity as "changed" and re-renders forever (React error #185 -> blank
 * page). cachedIds is only ever replaced, never mutated in place. */
const EMPTY_IDS = [];
export function getInstalledIds() {
  return cachedIds || EMPTY_IDS;
}

function validIds(ids) {
  return (Array.isArray(ids) ? ids : []).filter((x) => typeof x === 'string' && WEBAPP_INDEX.has(x));
}

/** Load (or reload for a different user) the installed list. Safe to call often. */
export function ensureWebApps(userId) {
  const key = userId || 'anon';
  if (loadPromise && cacheUserKey === key) return loadPromise;
  cacheUserKey = key;
  cachedIds = null;
  loadPromise = (async () => {
    let ids;
    try {
      const { text } = await backend.files.read(STORE_PATH);
      ids = validIds(JSON.parse(text)?.installed);
    } catch {
      ids = [];
    }
    // Cross-user race guard: if a load for another user started while this
    // one was in flight, the newer load owns the cache — drop this result.
    if (cacheUserKey !== key) return getInstalledIds();
    cachedIds = ids;
    emit();
    return getInstalledIds();
  })();
  return loadPromise;
}

async function persist() {
  try {
    await backend.files.write(STORE_PATH, JSON.stringify({ installed: cachedIds }));
  } catch (e) {
    console.error('[drift] webapps persist failed:', e);
    throw new Error(`Could not save installed apps: ${e.message}`);
  }
}

export async function installWebApp(id, userId) {
  await ensureWebApps(userId);
  if (!WEBAPP_INDEX.has(id)) throw new Error(`Unknown web app: ${id}`);
  if (!cachedIds.includes(id)) {
    const prev = cachedIds;
    cachedIds = [...cachedIds, id];
    try {
      await persist();
    } catch (e) {
      cachedIds = prev; // rollback: UI must never disagree with storage
      throw e;
    }
    emit();
  }
  return getInstalledIds();
}

export async function uninstallWebApp(id, userId) {
  await ensureWebApps(userId);
  if (cachedIds.includes(id)) {
    const prev = cachedIds;
    cachedIds = cachedIds.filter((x) => x !== id);
    try {
      await persist();
    } catch (e) {
      cachedIds = prev; // rollback: UI must never disagree with storage
      throw e;
    }
    emit();
  }
  return getInstalledIds();
}

export function isInstalled(id) {
  return getInstalledIds().includes(id);
}

/** React hook: live installed-id list, re-renders on install/uninstall. */
export function useWebApps() {
  return useSyncExternalStore(subscribeWebApps, getInstalledIds);
}

export function listCatalog() {
  return WEBAPP_CATALOG;
}

export function getWebApp(id) {
  return WEBAPP_INDEX.get(id) || null;
}
