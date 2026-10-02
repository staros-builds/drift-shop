import { Folder, Pin, LayoutGrid, Compass, Settings, PenLine, Table, Presentation, ShoppingCart, Store, LifeBuoy, Calculator, FileText, ClipboardList, ShieldCheck, CalendarDays, Timer, LibraryBig } from 'lucide-react';
import AdminPanel from './AdminPanel.jsx';
import FilesApp from './FilesApp.jsx';
import PinboardApp from './PinboardApp.jsx';
import SpacesApp from './SpacesApp.jsx';
import HelmApp from './HelmApp.jsx';
import SettingsApp from './SettingsApp.jsx';
import WriterApp from './WriterApp.jsx';
import SheetsApp from './SheetsApp.jsx';
import SlidesApp from './SlidesApp.jsx';
import POSApp from './POSApp.jsx';
import PunchApp from './PunchApp.jsx';
import BouquinerieApp from './BouquinerieApp.jsx';
import StoreApp from './StoreApp.jsx';
import HelpApp from './HelpApp.jsx';
import CalculatorApp from './CalculatorApp.jsx';
import PdfViewerApp from './PdfViewerApp.jsx';
import ClipboardApp from './ClipboardApp.jsx';
import AppointmentsApp from './AppointmentsApp.jsx';
import WebAppViewer from './WebAppViewer.jsx';
import { getInstalledIds, getWebApp } from '../lib/webapps.js';

// App registry. Each entry: { id, title, icon (lucide component), component,
// defaultSize: {w,h}, category }.
// `category` is shown as a subtitle in menus.
// component: null and must never be clickable — the shell renders them disabled.
export const APPS = [
  { id: 'files', title: 'Fichiers', titleEn: 'Files',    icon: Folder,     component: FilesApp,    defaultSize: { w: 720, h: 480 },  category: 'Organize', multiWindow: true },
  { id: 'pinboard', title: 'Pense-bête', titleEn: 'Pinboard', icon: Pin,         component: PinboardApp, defaultSize: { w: 760, h: 520 },  category: 'Organize' },
  { id: 'spaces', title: 'Espaces', titleEn: 'Spaces',   icon: LayoutGrid,  component: SpacesApp,   defaultSize: { w: 640, h: 440 },  category: 'Organize' },
  { id: 'helm', title: 'Helm', titleEn: 'Helm',     icon: Compass,     component: HelmApp,     defaultSize: { w: 720, h: 520 },  category: 'Discover' },
  { id: 'writer', title: 'Rédaction', titleEn: 'Writer',   icon: PenLine,    component: WriterApp,   defaultSize: { w: 880, h: 620 },  category: 'Office', multiWindow: true },
  { id: 'sheets', title: 'Tableaux', titleEn: 'Sheets',   icon: Table,      component: SheetsApp,   defaultSize: { w: 940, h: 620 },  category: 'Office', multiWindow: true },
  { id: 'slides', title: 'Présentations', titleEn: 'Slides',   icon: Presentation, component: SlidesApp, defaultSize: { w: 940, h: 620 },  category: 'Office', multiWindow: true },
  { id: 'store', title: "Magasin d'applis", titleEn: 'App Store', icon: Store,    component: StoreApp,    defaultSize: { w: 900, h: 620 },  category: 'Discover' },
  { id: 'pos', title: 'Point de vente', titleEn: 'Point of Sale', icon: ShoppingCart, component: POSApp, defaultSize: { w: 1020, h: 640 }, category: 'Business' },
  { id: 'punch', title: 'Attestations', titleEn: 'Certificates', icon: Timer, component: PunchApp, defaultSize: { w: 900, h: 620 }, category: 'Business' },
  { id: 'bouquinerie', title: 'Catalogue', titleEn: 'Catalogue', icon: LibraryBig, component: BouquinerieApp, defaultSize: { w: 1020, h: 640 }, category: 'Business' },
  { id: 'appointments', title: 'Rendez-vous', titleEn: 'Appointments', icon: CalendarDays, component: AppointmentsApp, defaultSize: { w: 1020, h: 640 }, category: 'Business' },
  { id: 'settings', title: 'Réglages', titleEn: 'Settings', icon: Settings,    component: SettingsApp, defaultSize: { w: 640, h: 520 }, category: 'System' },
  { id: 'help', title: 'Aide', titleEn: 'Help & Guide', icon: LifeBuoy, component: HelpApp, defaultSize: { w: 880, h: 620 }, category: 'System' },
  { id: 'calculator', title: 'Calculatrice', titleEn: 'Calculator', icon: Calculator, component: CalculatorApp, defaultSize: { w: 340, h: 500 }, category: 'System' },
  { id: 'pdfviewer', title: 'Lecteur PDF', titleEn: 'PDF Viewer', icon: FileText, component: PdfViewerApp, defaultSize: { w: 900, h: 680 }, category: 'System' },
  { id: 'clipboard', title: 'Presse-papiers', titleEn: 'Clipboard', icon: ClipboardList, component: ClipboardApp, defaultSize: { w: 640, h: 560 }, category: 'System' },
  { id: 'admin', title: 'Admin', titleEn: 'Admin', icon: ShieldCheck, component: AdminPanel, defaultSize: { w: 900, h: 620 }, category: 'System', adminOnly: true },
];

/** Registry entry for an installed web app: id 'webapp:<id>'. */
export function webAppEntry(site) {
  return {
    id: `webapp:${site.id}`,
    title: site.title,
    icon: site.icon,
    component: WebAppViewer,
    defaultSize: site.big ? { w: 1200, h: 760 } : { w: 1000, h: 660 },
    category: 'Web Apps',
    webApp: site,
  };
}

export function getApp(id) {
  if (typeof id === 'string' && id.startsWith('webapp:')) {
    const short = id.slice('webapp:'.length);
    const site = getWebApp(short);
    if (!site) throw new Error(`Unknown app: ${id}`);
    // Uninstalled while a window was open (or a stale persisted state):
    // fail loudly so the shell can say so instead of rendering a ghost.
    if (!getInstalledIds().includes(short)) throw new Error(`"${site.title}" is not installed.`);
    return webAppEntry(site);
  }
  const app = APPS.find((a) => a.id === id);
  if (!app) throw new Error(`Unknown app: ${id}`);
  return app;
}

/**
 * Every app the user can launch right now: the static registry plus
 * installed web apps. Used by the Start menu, desktop icons, and search.
 *
 * Apps flagged adminOnly (the Admin panel) are only listed when isAdmin —
 * and openWindow() refuses them for anyone else, so hiding is never the
 * only protection.
 */
export function listLaunchableApps(isAdmin = false) {
  const web = getInstalledIds()
    .map((id) => {
      const site = getWebApp(id);
      return site ? webAppEntry(site) : null;
    })
    .filter(Boolean);
  return [...APPS, ...web].filter((a) => !a.adminOnly || isAdmin);
}

// Fuzzy match for Helm: id or title, case-insensitive, trim whitespace.
// Also matches installed web apps by title. Returns the app id, or null
// when nothing matches.
export function resolveAppId(input) {
  if (input == null) return null;
  const q = String(input).trim().toLowerCase();
  if (!q) return null;
  const exact = APPS.find((a) => a.id === q || a.title.toLowerCase() === q);
  if (exact) return exact.id;
  const webExact = getInstalledIds()
    .map(getWebApp)
    .find((s) => s && (s.id === q || s.title.toLowerCase() === q));
  if (webExact) return `webapp:${webExact.id}`;
  const partial = APPS.find(
    (a) => a.id.includes(q) || a.title.toLowerCase().includes(q)
  );
  if (partial) return partial.id;
  const webPartial = getInstalledIds()
    .map(getWebApp)
    .find((s) => s && (s.id.includes(q) || s.title.toLowerCase().includes(q)));
  return webPartial ? `webapp:${webPartial.id}` : null;
}
