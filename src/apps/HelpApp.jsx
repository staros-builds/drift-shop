import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Search, Rocket, Monitor, LayoutGrid, Smartphone, Palette, LifeBuoy,
  Folder, Globe, PenLine, Table, Presentation, Pin, Compass, Store,
  Gamepad2, ShoppingCart, Settings as SettingsIcon, ChevronDown,
  Lightbulb, TriangleAlert, ExternalLink, RotateCcw, X, Keyboard,
  MessageCircleQuestion, Star, Send, CheckCircle2, BookOpen, FileText,
  Newspaper, Tag, CalendarDays, KeyRound,
} from 'lucide-react';
import { useWindows } from '../os/WindowsContext.jsx';
import { SHORTCUTS, availableShortcuts } from '../os/shortcuts.js';
import { backend } from '../lib/backend/current.js';
import { localeTag, useLang } from '../lib/i18n.jsx';
import { BRAND } from '../lib/brand.js';

/* ------------------------------------------------------------------ */
/* Content blocks: { t:'p'|'steps'|'tip'|'warn'|'shortcuts', text|items } */
/* 'shortcuts' renders the live SHORTCUTS list so docs never drift.    */
/* ------------------------------------------------------------------ */

const SPOTLIGHT_KEYS = (() => {
  const s = SHORTCUTS.find((x) => x.id === 'spotlight');
  return s ? `${s.keys} (${s.keysMac} on Mac)` : 'Ctrl+K';
})();

/* ------------------------------------------------------------------ */
/* Help content — localized. Text lives in the locale files under      */
/* `helpContent`; this builds the SECTIONS structure from t().        */
/* `{brand}` / `{spotlight}` placeholders are filled from JS values.   */
/* ------------------------------------------------------------------ */

function buildSections(t) {
  const V = { brand: BRAND.name, spotlight: SPOTLIGHT_KEYS };
  const T = (key) => t(key, V);
  return [
    {
      id: 'start',
      title: T('helpContent.sections.start.title'),
      icon: Rocket,
      articles: [
        {
          id: 'accounts',
          title: T('helpContent.sections.start.articles.accounts.title'),
          keywords: T('helpContent.sections.start.articles.accounts.keywords'),
          blocks: [
            { t: 'p', text: T('helpContent.sections.start.articles.accounts.b0') },
            { t: 'steps', items: [
              T('helpContent.sections.start.articles.accounts.b1.0'),
              T('helpContent.sections.start.articles.accounts.b1.1'),
              T('helpContent.sections.start.articles.accounts.b1.2'),
            ] },
            { t: 'tip', text: T('helpContent.sections.start.articles.accounts.b2') },
          ],
        },
        {
          id: 'cloud',
          title: T('helpContent.sections.start.articles.cloud.title'),
          keywords: T('helpContent.sections.start.articles.cloud.keywords'),
          blocks: [
            { t: 'p', text: T('helpContent.sections.start.articles.cloud.b0') },
            { t: 'steps', items: [
              T('helpContent.sections.start.articles.cloud.b1.0'),
              T('helpContent.sections.start.articles.cloud.b1.1'),
            ] },
            { t: 'tip', text: T('helpContent.sections.start.articles.cloud.b2') },
          ],
        },
        {
          id: 'recovery',
          title: T('helpContent.sections.start.articles.recovery.title'),
          keywords: T('helpContent.sections.start.articles.recovery.keywords'),
          blocks: [
            { t: 'p', text: T('helpContent.sections.start.articles.recovery.b0') },
            { t: 'steps', items: [
              T('helpContent.sections.start.articles.recovery.b1.0'),
              T('helpContent.sections.start.articles.recovery.b1.1'),
              T('helpContent.sections.start.articles.recovery.b1.2'),
            ] },
            { t: 'tip', text: T('helpContent.sections.start.articles.recovery.b2') },
          ],
        },
      ],
    },
    {
      id: 'desktop',
      title: T('helpContent.sections.desktop.title'),
      icon: Monitor,
      articles: [
        {
          id: 'icons',
          title: T('helpContent.sections.desktop.articles.icons.title'),
          keywords: T('helpContent.sections.desktop.articles.icons.keywords'),
          blocks: [
            { t: 'p', text: T('helpContent.sections.desktop.articles.icons.b0') },
            { t: 'steps', items: [
              T('helpContent.sections.desktop.articles.icons.b1.0'),
              T('helpContent.sections.desktop.articles.icons.b1.1'),
              T('helpContent.sections.desktop.articles.icons.b1.2'),
              T('helpContent.sections.desktop.articles.icons.b1.3'),
            ] },
          ],
        },
        {
          id: 'taskbar',
          title: T('helpContent.sections.desktop.articles.taskbar.title'),
          keywords: T('helpContent.sections.desktop.articles.taskbar.keywords'),
          blocks: [
            { t: 'p', text: T('helpContent.sections.desktop.articles.taskbar.b0') },
            { t: 'steps', items: [
              T('helpContent.sections.desktop.articles.taskbar.b1.0'),
              T('helpContent.sections.desktop.articles.taskbar.b1.1'),
              T('helpContent.sections.desktop.articles.taskbar.b1.2'),
              T('helpContent.sections.desktop.articles.taskbar.b1.3'),
            ] },
          ],
        },
        {
          id: 'windows',
          title: T('helpContent.sections.desktop.articles.windows.title'),
          keywords: T('helpContent.sections.desktop.articles.windows.keywords'),
          blocks: [
            { t: 'p', text: T('helpContent.sections.desktop.articles.windows.b0') },
            { t: 'steps', items: [
              T('helpContent.sections.desktop.articles.windows.b1.0'),
              T('helpContent.sections.desktop.articles.windows.b1.1'),
              T('helpContent.sections.desktop.articles.windows.b1.2'),
            ] },
            { t: 'tip', text: T('helpContent.sections.desktop.articles.windows.b2') },
          ],
        },
        {
          id: 'spaces',
          title: T('helpContent.sections.desktop.articles.spaces.title'),
          keywords: T('helpContent.sections.desktop.articles.spaces.keywords'),
          appId: 'spaces',
          blocks: [
            { t: 'p', text: T('helpContent.sections.desktop.articles.spaces.b0') },
            { t: 'steps', items: [
              T('helpContent.sections.desktop.articles.spaces.b1.0'),
              T('helpContent.sections.desktop.articles.spaces.b1.1'),
              T('helpContent.sections.desktop.articles.spaces.b1.2'),
            ] },
          ],
        },
      ],
    },
    {
      id: 'apps',
      title: T('helpContent.sections.apps.title'),
      icon: LayoutGrid,
      articles: [
        {
          id: 'g-files',
          title: T('helpContent.sections.apps.articles.g-files.title'),
          keywords: T('helpContent.sections.apps.articles.g-files.keywords'),
          appId: 'files',
          blocks: [
            { t: 'p', text: T('helpContent.sections.apps.articles.g-files.b0') },
            { t: 'steps', items: [
              T('helpContent.sections.apps.articles.g-files.b1.0'),
              T('helpContent.sections.apps.articles.g-files.b1.1'),
              T('helpContent.sections.apps.articles.g-files.b1.2'),
              T('helpContent.sections.apps.articles.g-files.b1.3'),
            ] },
          ],
        },
        {
          id: 'g-writer',
          title: T('helpContent.sections.apps.articles.g-writer.title'),
          keywords: T('helpContent.sections.apps.articles.g-writer.keywords'),
          appId: 'writer',
          blocks: [
            { t: 'p', text: T('helpContent.sections.apps.articles.g-writer.b0') },
            { t: 'steps', items: [
              T('helpContent.sections.apps.articles.g-writer.b1.0'),
              T('helpContent.sections.apps.articles.g-writer.b1.1'),
              T('helpContent.sections.apps.articles.g-writer.b1.2'),
            ] },
          ],
        },
        {
          id: 'g-sheets',
          title: T('helpContent.sections.apps.articles.g-sheets.title'),
          keywords: T('helpContent.sections.apps.articles.g-sheets.keywords'),
          appId: 'sheets',
          blocks: [
            { t: 'p', text: T('helpContent.sections.apps.articles.g-sheets.b0') },
            { t: 'steps', items: [
              T('helpContent.sections.apps.articles.g-sheets.b1.0'),
              T('helpContent.sections.apps.articles.g-sheets.b1.1'),
            ] },
          ],
        },
        {
          id: 'g-slides',
          title: T('helpContent.sections.apps.articles.g-slides.title'),
          keywords: T('helpContent.sections.apps.articles.g-slides.keywords'),
          appId: 'slides',
          blocks: [
            { t: 'p', text: T('helpContent.sections.apps.articles.g-slides.b0') },
            { t: 'steps', items: [
              T('helpContent.sections.apps.articles.g-slides.b1.0'),
              T('helpContent.sections.apps.articles.g-slides.b1.1'),
              T('helpContent.sections.apps.articles.g-slides.b1.2'),
            ] },
          ],
        },
        {
          id: 'g-pinboard',
          title: T('helpContent.sections.apps.articles.g-pinboard.title'),
          keywords: T('helpContent.sections.apps.articles.g-pinboard.keywords'),
          appId: 'pinboard',
          blocks: [
            { t: 'p', text: T('helpContent.sections.apps.articles.g-pinboard.b0') },
            { t: 'steps', items: [
              T('helpContent.sections.apps.articles.g-pinboard.b1.0'),
              T('helpContent.sections.apps.articles.g-pinboard.b1.1'),
              T('helpContent.sections.apps.articles.g-pinboard.b1.2'),
            ] },
          ],
        },
        {
          id: 'g-helm',
          title: T('helpContent.sections.apps.articles.g-helm.title'),
          keywords: T('helpContent.sections.apps.articles.g-helm.keywords'),
          appId: 'helm',
          blocks: [
            { t: 'p', text: T('helpContent.sections.apps.articles.g-helm.b0') },
            { t: 'steps', items: [
              T('helpContent.sections.apps.articles.g-helm.b1.0'),
              T('helpContent.sections.apps.articles.g-helm.b1.1'),
              T('helpContent.sections.apps.articles.g-helm.b1.2'),
            ] },
            { t: 'warn', text: T('helpContent.sections.apps.articles.g-helm.b2') },
          ],
        },
        {
          id: 'g-store',
          title: T('helpContent.sections.apps.articles.g-store.title'),
          keywords: T('helpContent.sections.apps.articles.g-store.keywords'),
          appId: 'store',
          blocks: [
            { t: 'p', text: T('helpContent.sections.apps.articles.g-store.b0') },
            { t: 'steps', items: [
              T('helpContent.sections.apps.articles.g-store.b1.0'),
              T('helpContent.sections.apps.articles.g-store.b1.1'),
              T('helpContent.sections.apps.articles.g-store.b1.2'),
            ] },
            { t: 'tip', text: T('helpContent.sections.apps.articles.g-store.b2') },
          ],
        },
        {
          id: 'g-pos',
          title: T('helpContent.sections.apps.articles.g-pos.title'),
          keywords: T('helpContent.sections.apps.articles.g-pos.keywords'),
          appId: 'pos',
          blocks: [
            { t: 'p', text: T('helpContent.sections.apps.articles.g-pos.b0') },
            { t: 'steps', items: [
              T('helpContent.sections.apps.articles.g-pos.b1.0'),
              T('helpContent.sections.apps.articles.g-pos.b1.1'),
              T('helpContent.sections.apps.articles.g-pos.b1.2'),
            ] },
            { t: 'tip', text: T('helpContent.sections.apps.articles.g-pos.b2') },
          ],
        },
        {
          id: 'g-punch',
          title: T('helpContent.sections.apps.articles.g-punch.title'),
          keywords: T('helpContent.sections.apps.articles.g-punch.keywords'),
          appId: 'punch',
          blocks: [
            { t: 'p', text: T('helpContent.sections.apps.articles.g-punch.b0') },
            { t: 'steps', items: [
              T('helpContent.sections.apps.articles.g-punch.b1.0'),
              T('helpContent.sections.apps.articles.g-punch.b1.1'),
              T('helpContent.sections.apps.articles.g-punch.b1.2'),
              T('helpContent.sections.apps.articles.g-punch.b1.3'),
            ] },
            { t: 'tip', text: T('helpContent.sections.apps.articles.g-punch.b2') },
          ],
        },
        {
          id: 'g-catalogue',
          title: T('helpContent.sections.apps.articles.g-catalogue.title'),
          keywords: T('helpContent.sections.apps.articles.g-catalogue.keywords'),
          appId: 'bouquinerie',
          blocks: [
            { t: 'p', text: T('helpContent.sections.apps.articles.g-catalogue.b0') },
            { t: 'steps', items: [
              T('helpContent.sections.apps.articles.g-catalogue.b1.0'),
              T('helpContent.sections.apps.articles.g-catalogue.b1.1'),
              T('helpContent.sections.apps.articles.g-catalogue.b1.2'),
              T('helpContent.sections.apps.articles.g-catalogue.b1.3'),
            ] },
          ],
        },
        {
          id: 'g-appointments',
          title: T('helpContent.sections.apps.articles.g-appointments.title'),
          keywords: T('helpContent.sections.apps.articles.g-appointments.keywords'),
          appId: 'appointments',
          blocks: [
            { t: 'p', text: T('helpContent.sections.apps.articles.g-appointments.b0') },
            { t: 'steps', items: [
              T('helpContent.sections.apps.articles.g-appointments.b1.0'),
              T('helpContent.sections.apps.articles.g-appointments.b1.1'),
              T('helpContent.sections.apps.articles.g-appointments.b1.2'),
            ] },
            { t: 'tip', text: T('helpContent.sections.apps.articles.g-appointments.b2') },
          ],
        },
        {
          id: 'g-classifieds',
          title: T('helpContent.sections.apps.articles.g-classifieds.title'),
          keywords: T('helpContent.sections.apps.articles.g-classifieds.keywords'),
          appId: 'classifieds',
          blocks: [
            { t: 'p', text: T('helpContent.sections.apps.articles.g-classifieds.b0') },
            { t: 'steps', items: [
              T('helpContent.sections.apps.articles.g-classifieds.b1.0'),
              T('helpContent.sections.apps.articles.g-classifieds.b1.1'),
              T('helpContent.sections.apps.articles.g-classifieds.b1.2'),
            ] },
            { t: 'tip', text: T('helpContent.sections.apps.articles.g-classifieds.b2') },
          ],
        },
        {
          id: 'g-mylistings',
          title: T('helpContent.sections.apps.articles.g-mylistings.title'),
          keywords: T('helpContent.sections.apps.articles.g-mylistings.keywords'),
          appId: 'mylistings',
          blocks: [
            { t: 'p', text: T('helpContent.sections.apps.articles.g-mylistings.b0') },
            { t: 'steps', items: [
              T('helpContent.sections.apps.articles.g-mylistings.b1.0'),
              T('helpContent.sections.apps.articles.g-mylistings.b1.1'),
              T('helpContent.sections.apps.articles.g-mylistings.b1.2'),
            ] },
            { t: 'tip', text: T('helpContent.sections.apps.articles.g-mylistings.b2') },
          ],
        },
        {
          id: 'g-settings',
          title: T('helpContent.sections.apps.articles.g-settings.title'),
          keywords: T('helpContent.sections.apps.articles.g-settings.keywords'),
          appId: 'settings',
          blocks: [
            { t: 'p', text: T('helpContent.sections.apps.articles.g-settings.b0') },
            { t: 'steps', items: [
              T('helpContent.sections.apps.articles.g-settings.b1.0'),
              T('helpContent.sections.apps.articles.g-settings.b1.1'),
              T('helpContent.sections.apps.articles.g-settings.b1.2'),
            ] },
          ],
        },
        {
          id: 'g-calculator',
          title: T('helpContent.sections.apps.articles.g-calculator.title'),
          keywords: T('helpContent.sections.apps.articles.g-calculator.keywords'),
          appId: 'calculator',
          blocks: [
            { t: 'p', text: T('helpContent.sections.apps.articles.g-calculator.b0') },
            { t: 'steps', items: [
              T('helpContent.sections.apps.articles.g-calculator.b1.0'),
              T('helpContent.sections.apps.articles.g-calculator.b1.1'),
              T('helpContent.sections.apps.articles.g-calculator.b1.2'),
            ] },
          ],
        },
        {
          id: 'g-pdfviewer',
          title: T('helpContent.sections.apps.articles.g-pdfviewer.title'),
          keywords: T('helpContent.sections.apps.articles.g-pdfviewer.keywords'),
          appId: 'pdfviewer',
          blocks: [
            { t: 'p', text: T('helpContent.sections.apps.articles.g-pdfviewer.b0') },
            { t: 'steps', items: [
              T('helpContent.sections.apps.articles.g-pdfviewer.b1.0'),
              T('helpContent.sections.apps.articles.g-pdfviewer.b1.1'),
              T('helpContent.sections.apps.articles.g-pdfviewer.b1.2'),
            ] },
          ],
        },
        {
          id: 'g-clipboard',
          title: T('helpContent.sections.apps.articles.g-clipboard.title'),
          keywords: T('helpContent.sections.apps.articles.g-clipboard.keywords'),
          appId: 'clipboard',
          blocks: [
            { t: 'p', text: T('helpContent.sections.apps.articles.g-clipboard.b0') },
            { t: 'steps', items: [
              T('helpContent.sections.apps.articles.g-clipboard.b1.0'),
              T('helpContent.sections.apps.articles.g-clipboard.b1.1'),
              T('helpContent.sections.apps.articles.g-clipboard.b1.2'),
            ] },
          ],
        },
        {
          id: 'g-admin',
          title: T('helpContent.sections.apps.articles.g-admin.title'),
          keywords: T('helpContent.sections.apps.articles.g-admin.keywords'),
          appId: 'admin',
          blocks: [
            { t: 'p', text: T('helpContent.sections.apps.articles.g-admin.b0') },
            { t: 'steps', items: [
              T('helpContent.sections.apps.articles.g-admin.b1.0'),
              T('helpContent.sections.apps.articles.g-admin.b1.1'),
              T('helpContent.sections.apps.articles.g-admin.b1.2'),
            ] },
          ],
        },
      ],
    },
    {
      id: 'shortcuts',
      title: T('helpContent.sections.shortcuts.title'),
      icon: Keyboard,
      articles: [
        {
          id: 'kb-shortcuts',
          title: T('helpContent.sections.shortcuts.articles.kb-shortcuts.title'),
          keywords: T('helpContent.sections.shortcuts.articles.kb-shortcuts.keywords'),
          blocks: [
            { t: 'p', text: T('helpContent.sections.shortcuts.articles.kb-shortcuts.b0') },
            { t: 'shortcuts' },
            { t: 'tip', text: T('helpContent.sections.shortcuts.articles.kb-shortcuts.b2') },
          ],
        },
        {
          id: 'kb-search',
          title: T('helpContent.sections.shortcuts.articles.kb-search.title'),
          keywords: T('helpContent.sections.shortcuts.articles.kb-search.keywords'),
          blocks: [
            { t: 'p', text: T('helpContent.sections.shortcuts.articles.kb-search.b0') },
            { t: 'steps', items: [
              T('helpContent.sections.shortcuts.articles.kb-search.b1.0'),
              T('helpContent.sections.shortcuts.articles.kb-search.b1.1'),
              T('helpContent.sections.shortcuts.articles.kb-search.b1.2'),
            ] },
            { t: 'p', text: T('helpContent.sections.shortcuts.articles.kb-search.b2') },
            { t: 'tip', text: T('helpContent.sections.shortcuts.articles.kb-search.b3') },
          ],
        },
      ],
    },
    {
      id: 'touch',
      title: T('helpContent.sections.touch.title'),
      icon: Smartphone,
      articles: [
        {
          id: 'touch-mode',
          title: T('helpContent.sections.touch.articles.touch-mode.title'),
          keywords: T('helpContent.sections.touch.articles.touch-mode.keywords'),
          blocks: [
            { t: 'p', text: T('helpContent.sections.touch.articles.touch-mode.b0') },
            { t: 'steps', items: [
              T('helpContent.sections.touch.articles.touch-mode.b1.0'),
              T('helpContent.sections.touch.articles.touch-mode.b1.1'),
              T('helpContent.sections.touch.articles.touch-mode.b1.2'),
              T('helpContent.sections.touch.articles.touch-mode.b1.3'),
            ] },
          ],
        },
      ],
    },
    {
      id: 'styles',
      title: T('helpContent.sections.styles.title'),
      icon: Palette,
      articles: [
        {
          id: 'ui-style',
          title: T('helpContent.sections.styles.articles.ui-style.title'),
          keywords: T('helpContent.sections.styles.articles.ui-style.keywords'),
          blocks: [
            { t: 'p', text: T('helpContent.sections.styles.articles.ui-style.b0') },
            { t: 'steps', items: [
              T('helpContent.sections.styles.articles.ui-style.b1.0'),
              T('helpContent.sections.styles.articles.ui-style.b1.1'),
              T('helpContent.sections.styles.articles.ui-style.b1.2'),
            ] },
          ],
        },
      ],
    },
    {
      id: 'faq',
      title: T('helpContent.sections.faq.title'),
      icon: LifeBuoy,
      articles: [
        {
          id: 'faq-website',
          title: T('helpContent.sections.faq.articles.faq-website.title'),
          keywords: T('helpContent.sections.faq.articles.faq-website.keywords'),
          blocks: [
            { t: 'p', text: T('helpContent.sections.faq.articles.faq-website.b0') },
            { t: 'steps', items: [
              T('helpContent.sections.faq.articles.faq-website.b1.0'),
              T('helpContent.sections.faq.articles.faq-website.b1.1'),
            ] },
          ],
        },
        {
          id: 'faq-save',
          title: T('helpContent.sections.faq.articles.faq-save.title'),
          keywords: T('helpContent.sections.faq.articles.faq-save.keywords'),
          blocks: [
            { t: 'p', text: T('helpContent.sections.faq.articles.faq-save.b0') },
            { t: 'steps', items: [
              T('helpContent.sections.faq.articles.faq-save.b1.0'),
              T('helpContent.sections.faq.articles.faq-save.b1.1'),
            ] },
            { t: 'tip', text: T('helpContent.sections.faq.articles.faq-save.b2') },
          ],
        },
        {
          id: 'faq-find',
          title: T('helpContent.sections.faq.articles.faq-find.title'),
          keywords: T('helpContent.sections.faq.articles.faq-find.keywords'),
          blocks: [
            { t: 'steps', items: [
              T('helpContent.sections.faq.articles.faq-find.b0.0'),
              T('helpContent.sections.faq.articles.faq-find.b0.1'),
              T('helpContent.sections.faq.articles.faq-find.b0.2'),
            ] },
          ],
        },
        {
          id: 'faq-slow',
          title: T('helpContent.sections.faq.articles.faq-slow.title'),
          keywords: T('helpContent.sections.faq.articles.faq-slow.keywords'),
          blocks: [
            { t: 'steps', items: [
              T('helpContent.sections.faq.articles.faq-slow.b0.0'),
              T('helpContent.sections.faq.articles.faq-slow.b0.1'),
              T('helpContent.sections.faq.articles.faq-slow.b0.2'),
            ] },
          ],
        },
        {
          id: 'faq-tour',
          title: T('helpContent.sections.faq.articles.faq-tour.title'),
          keywords: T('helpContent.sections.faq.articles.faq-tour.keywords'),
          blocks: [
            { t: 'p', text: T('helpContent.sections.faq.articles.faq-tour.b0') },
            { t: 'steps', items: [
              T('helpContent.sections.faq.articles.faq-tour.b1.0'),
            ] },
            { t: 'tip', text: T('helpContent.sections.faq.articles.faq-tour.b2'), isTour: true },
          ],
        },
      ],
    },
    {
      id: 'manual',
      title: T('helpContent.sections.manual.title'),
      icon: BookOpen,
      keywords: T('helpContent.sections.manual.keywords'),
      articles: [
        {
          id: 'manual-pdf',
          title: T('helpContent.sections.manual.articles.manual-pdf.title'),
          keywords: T('helpContent.sections.manual.articles.manual-pdf.keywords'),
          blocks: [
            { t: 'p', text: T('helpContent.sections.manual.articles.manual-pdf.b0') },
            { t: 'steps', items: [
              T('helpContent.sections.manual.articles.manual-pdf.b1.0'),
              T('helpContent.sections.manual.articles.manual-pdf.b1.1'),
              T('helpContent.sections.manual.articles.manual-pdf.b1.2'),
            ] },
            { t: 'pdf', text: T('helpContent.sections.manual.articles.manual-pdf.b2') },
            { t: 'tip', text: T('helpContent.sections.manual.articles.manual-pdf.b3') },
          ],
        },
      ],
    },
    {
      id: 'contact',
      title: T('helpContent.sections.contact.title'),
      icon: MessageCircleQuestion,
      keywords: T('helpContent.sections.contact.keywords'),
      custom: 'contact',
      articles: [
      ],
    },
  ];
}

function buildAppTitles(t) {
  const o = {};
  for (const k of ['files','spaces','writer','sheets','slides','pinboard','helm','store','pos','settings']) {
    o[k] = t(`helpContent.appTitles.${k}`);
  }
  return o;
}


function Block({ block, shortcuts }) {
  const { t } = useLang();
  if (block.t === 'steps') {
    return (
      <ol className="mb-3 list-decimal space-y-1.5 pl-5 text-sm text-ink">
        {block.items.map((s, i) => <li key={i}>{s}</li>)}
      </ol>
    );
  }
  if (block.t === 'shortcuts') {
    const isMac =
      typeof navigator !== 'undefined' &&
      /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent || '');
    return (
      <ul className="mb-3 space-y-1.5">
        {(shortcuts || []).map((s) => (
          <li
            key={s.id}
            className="flex items-center justify-between gap-3 rounded-os border border-osborder bg-paper px-3 py-2"
          >
            <span className="text-sm text-ink">{s.description}</span>
            <kbd className="shrink-0 rounded-md border border-osborder bg-surface px-2 py-0.5 text-xs font-medium text-ink">
              {isMac && s.keysMac ? s.keysMac : s.keys}
            </kbd>
          </li>
        ))}
      </ul>
    );
  }
  if (block.t === 'tip') {
    return (
      <div className="mb-3 flex gap-2 rounded-os border border-osborder bg-paper p-3 text-sm text-ink">
        {block.isTour ? (
          <button
            type="button"
            onClick={() => window.dispatchEvent(new CustomEvent('drift:show-tour'))}
            className="flex items-center gap-1.5 rounded-os bg-accent px-3 py-1.5 text-sm font-medium text-white duration-160 hover:opacity-90"
          >
            <RotateCcw size={14} /> {t('help.replayTour')}
          </button>
        ) : (
          <>
            <Lightbulb size={16} className="mt-0.5 shrink-0 text-accent" />
            <span><span className="font-medium">{t('help.tip')} </span>{block.text}</span>
          </>
        )}
      </div>
    );
  }
  if (block.t === 'warn') {
    return (
      <div className="mb-3 flex gap-2 rounded-os border border-osborder bg-paper p-3 text-sm text-ink">
        <TriangleAlert size={16} className="mt-0.5 shrink-0 text-accent" />
        <span>{block.text}</span>
      </div>
    );
  }
  if (block.t === 'pdf') {
    return (
      <div className="mb-3">
        <button
          type="button"
          onClick={() => window.open('manual/vendra-manual.pdf', '_blank', 'noopener')}
          className="flex items-center gap-2 rounded-os bg-accent px-4 py-2 text-sm font-semibold text-white duration-160 hover:opacity-90"
        >
          <FileText size={16} /> {block.text || 'Open the getting-started guide (PDF)'}
        </button>
      </div>
    );
  }
  return <p className="mb-3 text-sm leading-relaxed text-ink">{block.text}</p>;
}

function articleText(a) {
  const bits = [a.title, a.keywords || ''];
  for (const b of a.blocks) {
    if (b.text) bits.push(b.text);
    if (b.items) bits.push(...b.items);
  }
  return bits.join(' ').toLowerCase();
}

const CONTACT_STATUS = {
  open: 'Open',
  in_progress: 'In progress',
  resolved: 'Resolved',
};

/**
 * Contact & feedback — file a support request (e.g. "I want to buy / pay")
 * or send feedback. Cloud only: requests go to the owner's Admin panel.
 * Users see their own requests here, including the owner's replies.
 */
function ContactSection() {
  const { t } = useLang();
  // The cloud backend always supports tickets.
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [fb, setFb] = useState('');
  const [rating, setRating] = useState(0);
  const [tickets, setTickets] = useState([]);
  const [myFeedback, setMyFeedback] = useState([]);
  const [busy, setBusy] = useState(null);
  const [notice, setNotice] = useState(null); // { ok, text }

  const load = useCallback(async () => {
    try {
      setTickets(await backend.support.listMyTickets());
    } catch {
      /* tickets are a bonus; the forms still work */
    }
    try {
      setMyFeedback(await backend.feedback.listMine());
    } catch {
      /* feedback history is a bonus; the form still works */
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const sendTicket = async () => {
    setNotice(null);
    setBusy('ticket');
    try {
      await backend.support.createTicket({ subject, message });
      setSubject('');
      setMessage('');
      setNotice({ ok: true, text: 'Request sent — the owner will reply here.' });
      await load();
    } catch (e) {
      setNotice({ ok: false, text: e.message || 'Could not send. Try again.' });
    } finally {
      setBusy(null);
    }
  };

  const sendFeedback = async () => {
    setNotice(null);
    setBusy('feedback');
    try {
      await backend.feedback.submit({ message: fb, rating: rating || null });
      setFb('');
      setRating(0);
      setNotice({ ok: true, text: 'Thanks — your feedback is on its way.' });
      await load();
    } catch (e) {
      setNotice({ ok: false, text: e.message || 'Could not send. Try again.' });
    } finally {
      setBusy(null);
    }
  };

  const inputCls =
    'w-full rounded-os border border-osborder bg-paper px-3 py-2 text-sm text-ink outline-none placeholder:text-muted focus:border-accent';

  return (
    <div>
      <h2 className="mb-1 text-lg font-medium text-ink">{t('help.contactTitle')}</h2>
      <p className="mb-4 text-sm text-muted">
        Need a hand? Send a request below — the
        owner reads and replies to every one.
      </p>

      {notice && (
        <div
          role={notice.ok ? 'status' : 'alert'}
          className={`mb-3 flex items-start gap-2 rounded-os border border-osborder bg-surface px-3 py-2 text-sm ${
            notice.ok ? 'text-ink' : 'text-red-600'
          }`}
        >
          <CheckCircle2 size={16} className={`mt-0.5 shrink-0 ${notice.ok ? 'text-accent' : ''}`} />
          <span>{notice.text}</span>
        </div>
      )}

      <div className="grid gap-3 lg:grid-cols-2">
        <div className="rounded-os border border-osborder bg-surface p-4">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-ink">
            <MessageCircleQuestion size={15} className="text-accent" /> {t('help.supportRequest')}
          </h3>
          <div className="mt-3 space-y-2.5">
            <input
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Subject — e.g. Problem with the cash register"
              maxLength={200}
              className={inputCls}
            />
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="What do you need?"
              rows={4}
              maxLength={5000}
              className={`${inputCls} resize-y`}
            />
            <button
              type="button"
              onClick={sendTicket}
              disabled={busy === 'ticket' || !subject.trim() || !message.trim()}
              className="flex w-full items-center justify-center gap-2 rounded-os bg-accent px-4 py-2 text-sm font-semibold text-accentink duration-160 hover:opacity-90 disabled:opacity-50"
            >
              <Send size={14} />
              {busy === 'ticket' ? 'Sending…' : 'Send request'}
            </button>
          </div>
        </div>

        <div className="rounded-os border border-osborder bg-surface p-4">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-ink">
            <Star size={15} className="text-accent" /> {t('help.sendFeedback')}
          </h3>
          <div className="mt-3 space-y-2.5">
            <div className="flex items-center gap-1" role="radiogroup" aria-label="Rating">
              {[1, 2, 3, 4, 5].map((s) => (
                <button
                  key={s}
                  type="button"
                  role="radio"
                  aria-checked={rating === s}
                  aria-label={`${s} star${s === 1 ? '' : 's'}`}
                  onClick={() => setRating(rating === s ? 0 : s)}
                  className="rounded-os p-0.5"
                >
                  <Star
                    size={20}
                    className={s <= rating ? 'fill-accent text-accent' : 'text-osborder hover:text-muted'}
                  />
                </button>
              ))}
              <span className="ml-1 text-xs text-muted">{rating ? `${rating}/5` : 'optional'}</span>
            </div>
            <textarea
              value={fb}
              onChange={(e) => setFb(e.target.value)}
              placeholder="What do you love? What's broken? What should exist?"
              rows={4}
              maxLength={5000}
              className={`${inputCls} resize-y`}
            />
            <button
              type="button"
              onClick={sendFeedback}
              disabled={busy === 'feedback' || !fb.trim()}
              className="flex w-full items-center justify-center gap-2 rounded-os border border-osborder bg-paper px-4 py-2 text-sm font-medium text-ink duration-160 hover:border-accent disabled:opacity-50"
            >
              <Send size={14} />
              {busy === 'feedback' ? t('help.sending') : t('help.sendFeedback')}
            </button>
          </div>
        </div>
      </div>

      {tickets.length > 0 && (
        <div className="mt-4">
          <h3 className="mb-2 text-sm font-semibold text-ink">{t('help.yourRequests')}</h3>
          <ul className="space-y-2">
            {tickets.map((t) => (
              <li key={t.id} className="rounded-os border border-osborder bg-surface px-3 py-2.5">
                <div className="flex items-center gap-2">
                  <p className="min-w-0 flex-1 truncate text-sm font-medium text-ink">{t.subject}</p>
                  <span className="shrink-0 rounded-full bg-osborder/60 px-2 py-0.5 text-[11px] font-medium text-muted">
                    {CONTACT_STATUS[t.status] || t.status}
                  </span>
                </div>
                <p className="mt-0.5 text-[11px] text-muted">
                  {new Date(t.created_at).toLocaleDateString(localeTag(), { month: 'short', day: 'numeric' })}
                </p>
                {t.admin_response && (
                  <p className="mt-1.5 rounded-os bg-paper px-2.5 py-2 text-sm text-ink">
                    <span className="mb-0.5 block text-[11px] font-medium text-accent">{t('help.ownersReply')}</span>
                    <span className="whitespace-pre-wrap">{t.admin_response}</span>
                  </p>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {myFeedback.length > 0 && (
        <div className="mt-4">
          <h3 className="mb-2 text-sm font-semibold text-ink">{t('help.myFeedback')}</h3>
          <ul className="space-y-2">
            {myFeedback.map((f) => (
              <li key={f.id} className="rounded-os border border-osborder bg-surface px-3 py-2.5">
                <div className="flex items-center gap-2">
                  {f.rating != null && (
                    <span className="flex shrink-0 items-center gap-0.5" aria-label={`${f.rating}/5`}>
                      {[1, 2, 3, 4, 5].map((s) => (
                        <Star
                          key={s}
                          size={12}
                          className={s <= f.rating ? 'fill-accent text-accent' : 'text-osborder'}
                        />
                      ))}
                    </span>
                  )}
                  <p className="ml-auto shrink-0 text-[11px] text-muted">
                    {new Date(f.created_at).toLocaleDateString(localeTag(), { month: 'short', day: 'numeric' })}
                  </p>
                </div>
                <p className="mt-1 whitespace-pre-wrap text-sm text-ink">{f.message}</p>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export default function HelpApp({ windowApi }) {
  const winCtx = useWindows();
  const { t } = useLang();
  const { openWindow } = winCtx;
  const [query, setQuery] = useState('');
  const [sectionId, setSectionId] = useState('start');
  const [openArticle, setOpenArticle] = useState(null);
  // Full-text index of the built-in user-manual PDF ({title, page, text}[]).
  // Loaded lazily; search simply skips manual results until it arrives.
  const [manualIndex, setManualIndex] = useState(null);

  useEffect(() => {
    let alive = true;
    fetch('manual/manual-index.json')
      .then((r) => (r.ok ? r.json() : null))
      // Shape: { version, pages, entries: [{ page, title, text }] }.
      .then((j) => { if (alive && j && Array.isArray(j.entries)) setManualIndex(j.entries); })
      .catch(() => { /* manual search stays unavailable; the PDF still opens */ });
    return () => { alive = false; };
  }, []);

  // Localized help content — rebuilt whenever the language changes.
  const SECTIONS = useMemo(() => buildSections(t), [t]);
  const APP_TITLES = useMemo(() => buildAppTitles(t), [t]);

  // Live shortcut list (availability-aware), so the docs never drift.
  const shortcuts = useMemo(() => availableShortcuts(winCtx), [winCtx]);

  useEffect(() => {
    windowApi?.setTitle?.('Help & Guide');
  }, [windowApi]);

  const searchIndex = useMemo(
    () => SECTIONS.flatMap((s) => [
      ...s.articles.map((a) => ({ section: s, article: a, text: articleText(a) })),
      // Sections without articles (Contact) stay findable by their keywords.
      ...(s.keywords
        ? [{ section: s, article: { id: `${s.id}-section`, title: s.title, blocks: [] }, text: `${s.title} ${s.keywords}`.toLowerCase() }]
        : []),
    ]),
    [SECTIONS]
  );

  const q = query.trim().toLowerCase();
  const manualResults =
    q && manualIndex
      ? manualIndex
          .filter((e) => `${e.title} ${e.text}`.toLowerCase().includes(q))
          .slice(0, 15)
          .map((e, i) => ({
            section: { id: 'manual', title: 'User manual', icon: BookOpen },
            article: {
              id: `manual-result-${i}`,
              title: e.title,
              blocks: [],
              manual: true,
              page: e.page,
            },
            text: '',
          }))
      : [];
  const results = q
    ? [...searchIndex.filter((r) => r.text.includes(q)).slice(0, 30), ...manualResults]
    : null;

  const section = SECTIONS.find((s) => s.id === sectionId) || SECTIONS[0];

  const openApp = (appId) => {
    try { openWindow(appId); }
    catch { /* stay in help if it fails */ }
  };

  return (
    <div className="flex h-full flex-col bg-paper text-ink">
      {/* Search header */}
      <div className="border-b border-osborder bg-surface p-3">
        <div className="relative">
          <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search help — try “dark mode” or “save”"
            className="w-full rounded-os border border-osborder bg-paper py-2 pl-9 pr-8 text-sm text-ink outline-none placeholder:text-muted focus:border-accent"
          />
          {query && (
            <button
              type="button" aria-label="Clear search" onClick={() => setQuery('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded-os p-1 text-muted hover:bg-paper hover:text-ink"
            >
              <X size={14} />
            </button>
          )}
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* Section sidebar */}
        <nav className="w-44 shrink-0 overflow-y-auto border-r border-osborder bg-surface p-2">
          {SECTIONS.map((s) => {
            const Icon = s.icon;
            const active = !q && s.id === sectionId;
            return (
              <button
                key={s.id} type="button"
                onClick={() => { setSectionId(s.id); setOpenArticle(null); setQuery(''); }}
                className={`mb-0.5 flex w-full items-center gap-2 rounded-os px-2.5 py-2 text-left text-sm duration-160 ${
                  active ? 'bg-accent/15 font-medium text-ink' : 'text-muted hover:bg-paper hover:text-ink'
                }`}
              >
                <Icon size={16} className={active ? 'text-accent' : ''} />
                <span className="truncate">{s.title}</span>
              </button>
            );
          })}
        </nav>

        {/* Content */}
        <div className="min-w-0 flex-1 overflow-y-auto p-4">
          {results ? (
            <div>
              <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted">
                {results.length} result{results.length === 1 ? '' : 's'} for “{query.trim()}”
              </p>
              {results.length === 0 && (
                <p className="text-sm text-muted">{t('help.nothingFound')}</p>
              )}
              {results.map(({ section: s, article: a }) => (
                <ResultRow
                  key={a.id} section={s} article={a}
                  sub={a.manual ? `User manual · page ${a.page}` : null}
                  onOpen={() => {
                    if (a.manual) {
                      window.open(`manual/vendra-manual.pdf#page=${a.page}`, '_blank', 'noopener');
                    } else {
                      setSectionId(s.id); setOpenArticle(a.id); setQuery('');
                    }
                  }}
                />
              ))}
            </div>
          ) : section.custom === 'contact' ? (
            <ContactSection />
          ) : (
            <div>
              <h2 className="mb-3 text-lg font-medium text-ink">{section.title}</h2>
              <div className="space-y-2">
                {section.articles.map((a) => (
                  <ArticleCard key={a.id} article={a}
                    open={openArticle === a.id || (openArticle === null && section.articles[0] === a)}
                    onToggle={() => setOpenArticle(openArticle === a.id ? `__none__` : a.id)}
                    onOpenApp={a.appId ? () => openApp(a.appId) : null}
                    appTitle={a.appId ? APP_TITLES[a.appId] : null}
                    shortcuts={shortcuts} />
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ResultRow({ section, article, sub, onOpen }) {
  const Icon = section.icon;
  return (
    <button
      type="button" onClick={onOpen}
      className="mb-1.5 flex w-full items-center gap-3 rounded-os border border-osborder bg-surface p-3 text-left duration-160 hover:border-accent"
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-os bg-paper text-accent">
        <Icon size={18} />
      </span>
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium text-ink">{article.title}</span>
        <span className="block text-xs text-muted">{sub || section.title}</span>
      </span>
    </button>
  );
}

function ArticleCard({ article, open, onToggle, onOpenApp, appTitle, shortcuts }) {
  return (
    <div className="overflow-hidden rounded-os border border-osborder bg-surface">
      <button
        type="button" onClick={onToggle}
        className="flex w-full items-center justify-between gap-2 px-4 py-3 text-left duration-160 hover:bg-paper"
      >
        <span className="text-sm font-medium text-ink">{article.title}</span>
        <ChevronDown size={16} className={`shrink-0 text-muted transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="border-t border-osborder px-4 py-3">
          {article.blocks.map((b, i) => <Block key={i} block={b} shortcuts={shortcuts} />)}
          {onOpenApp && (
            <button
              type="button" onClick={onOpenApp}
              className="mt-1 flex items-center gap-1.5 rounded-os bg-accent px-3 py-1.5 text-sm font-medium text-white duration-160 hover:opacity-90"
            >
              <ExternalLink size={14} /> Open {appTitle}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
