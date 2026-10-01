import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Search, Rocket, Monitor, LayoutGrid, Smartphone, Palette, LifeBuoy,
  Folder, Globe, PenLine, Table, Presentation, Pin, Compass, Store,
  Gamepad2, ShoppingCart, Settings as SettingsIcon, ChevronDown,
  Lightbulb, TriangleAlert, ExternalLink, RotateCcw, X, Keyboard,
  MessageCircleQuestion, Star, Send, CheckCircle2, BookOpen, FileText,
} from 'lucide-react';
import { useWindows } from '../os/WindowsContext.jsx';
import { SHORTCUTS, availableShortcuts } from '../os/shortcuts.js';
import { backend } from '../lib/backend/current.js';
import { localeTag, useLang } from '../lib/i18n.jsx';

/* ------------------------------------------------------------------ */
/* Content blocks: { t:'p'|'steps'|'tip'|'warn'|'shortcuts', text|items } */
/* 'shortcuts' renders the live SHORTCUTS list so docs never drift.    */
/* ------------------------------------------------------------------ */

const SPOTLIGHT_KEYS = (() => {
  const s = SHORTCUTS.find((x) => x.id === 'spotlight');
  return s ? `${s.keys} (${s.keysMac} on Mac)` : 'Ctrl+K';
})();

const SECTIONS = [
  {
    id: 'start', title: 'Getting started', icon: Rocket,
    articles: [
      {
        id: 'accounts', title: 'Sign in, create an account, or try as a guest',
        keywords: 'sign in login account guest password trial username email',
        blocks: [
          { t: 'p', text: 'LFDD uses one cloud login — your username or email works on every device.' },
          { t: 'steps', items: [
            'Sign in: enter your username or email and your password.',
            'Create account: pick this once — your files, notes, and settings then follow you to any device.',
            'Try free for 30 minutes: full access for half an hour, no account needed — one trial per device.',
          ] },
          { t: 'tip', text: 'Forgot your password? Choose “Forgot password?” on the login screen to get a reset link by email.' },
        ],
      },
      {
        id: 'cloud', title: 'Your cloud account',
        keywords: 'cloud sync offline account storage',
        blocks: [
          { t: 'p', text: 'Everything lives in your cloud account. Sign in on any device and your desktop — files, apps, sales — is waiting for you.' },
          { t: 'steps', items: [
            'One login, one account: your username or email works everywhere.',
            'Your data follows you: start a sale on the shop computer, finish it on your phone.',
          ] },
          { t: 'tip', text: 'One account per person — your sales, files, and settings follow you to any device you sign in on.' },
        ],
      },
    ],
  },
  {
    id: 'desktop', title: 'Tour of the desktop', icon: Monitor,
    articles: [
      {
        id: 'icons', title: 'Desktop icons',
        keywords: 'icons desktop double click open drag arrange remove',
        blocks: [
          { t: 'p', text: 'Every app lives on your desktop as an icon.' },
          { t: 'steps', items: [
            'Single-click an icon to select it.',
            'Double-click (or double-tap) to open the app.',
            'Drag icons to rearrange them — your layout is remembered.',
            'Right-click an icon and choose "Remove from desktop" to hide it. Nothing is deleted; bring it back any time from Settings → Apps.',
          ] },
        ],
      },
      {
        id: 'taskbar', title: 'Taskbar, dock & Start menu',
        keywords: 'taskbar dock start menu search pinned launch',
        blocks: [
          { t: 'p', text: 'The bar at the screen edge is your command center.' },
          { t: 'steps', items: [
            'Open the Start menu from the start button to search and launch any app.',
            'Pinned apps sit in the Start menu for one-click access.',
            'Open apps appear on the taskbar — click one to bring its window forward.',
            'In Settings → Appearance you can move the taskbar to any screen edge, or switch the whole look to Windows 11 or Mac OS X 10.6 style.',
          ] },
        ],
      },
      {
        id: 'windows', title: 'Windows',
        keywords: 'window resize drag minimize maximize close snap',
        blocks: [
          { t: 'p', text: 'Apps open in windows you fully control.' },
          { t: 'steps', items: [
            'Drag the title bar to move a window.',
            'Drag any edge or corner to resize it.',
            'Use the title-bar buttons to minimize, maximize, or close.',
          ] },
          { t: 'tip', text: 'On a phone or tablet, turn on Touch mode in Settings → Appearance: apps go full-screen with big touch targets.' },
        ],
      },
      {
        id: 'spaces', title: 'Spaces (virtual desktops)',
        keywords: 'spaces virtual desktops workspaces switch organize',
        appId: 'spaces',
        blocks: [
          { t: 'p', text: 'Spaces are separate desktops for different parts of your life — e.g. Work, School, Play.' },
          { t: 'steps', items: [
            'Open Spaces to create, rename, and delete spaces.',
            'Each space keeps its own open windows.',
            'Switch spaces from the Spaces app or the taskbar.',
          ] },
        ],
      },
    ],
  },
  {
    id: 'apps', title: 'Apps guide', icon: LayoutGrid,
    articles: [
      {
        id: 'g-files', title: 'Files', appId: 'files',
        keywords: 'files upload download folder documents storage',
        blocks: [
          { t: 'p', text: 'Your documents, uploads, and folders. The same files on every device when you use the Cloud.' },
          { t: 'steps', items: [
            'Upload: click Upload (or drag files in) — documents, photos, PDFs, anything.',
            'Double-click a file to preview it; use Download to save a copy.',
            'New folder / Rename / Delete are in the toolbar. Deleted files ask first.',
            'Office files (Writer, Sheets, Slides) save straight into Files.',
          ] },
        ],
      },
      {
        id: 'g-writer', title: 'Writer', appId: 'writer',
        keywords: 'writer documents word text formatting',
        blocks: [
          { t: 'p', text: 'Documents with rich formatting — headings, bold, lists, and more.' },
          { t: 'steps', items: [
            'Type to write; format with the toolbar.',
            'Save stores the document in Files. Save As creates a copy under a new name.',
            'If you try to close with unsaved changes, you will be asked first.',
          ] },
        ],
      },
      {
        id: 'g-sheets', title: 'Sheets', appId: 'sheets',
        keywords: 'sheets spreadsheet excel formulas cells',
        blocks: [
          { t: 'p', text: 'Spreadsheets with real formulas, saved to your Files.' },
          { t: 'steps', items: [
            'Click a cell and type. Start with = for a formula, e.g. =SUM(A1:A5).',
            'Save stores the sheet; Save As makes a copy under a new name.',
          ] },
        ],
      },
      {
        id: 'g-slides', title: 'Slides', appId: 'slides',
        keywords: 'slides presentation powerpoint present',
        blocks: [
          { t: 'p', text: 'Presentations with a full-screen present mode.' },
          { t: 'steps', items: [
            'Add slides, pick layouts, and type your content.',
            'Present plays the slideshow full-screen.',
            'Save As keeps a copy under a new name without touching the original.',
          ] },
        ],
      },
      {
        id: 'g-pinboard', title: 'Pinboard', appId: 'pinboard',
        keywords: 'pinboard notes capture quick search',
        blocks: [
          { t: 'p', text: 'Your capture tray: quick notes, links, and files with full-text search.' },
          { t: 'steps', items: [
            'Pin anything in seconds — it is saved instantly.',
            'Search finds text inside your pins.',
            'Helm can also save things here for you.',
          ] },
        ],
      },
      {
        id: 'g-helm', title: 'Helm (your assistant)', appId: 'helm',
        keywords: 'helm assistant ai help ask chat',
        blocks: [
          { t: 'p', text: 'Helm is the assistant built into LFDD. Ask it to open apps, find things, look things up, and get work done.' },
          { t: 'steps', items: [
            'Type what you want: "open Files", "turn on dark mode", "remember that I like tea".',
            'Local mode answers from your device; Cloud smart mode can look things up online.',
            'Helm remembers things you tell it and can recall them later.',
          ] },
          { t: 'warn', text: 'Cloud smart mode uses a free public service — never send passwords or private data there.' },
        ],
      },
      {
        id: 'g-store', title: 'App Store', appId: 'store',
        keywords: 'app store install web apps add remove uninstall',
        blocks: [
          { t: 'p', text: 'Add web apps — drawing tools, maps, music, and more — as first-class LFDD apps.' },
          { t: 'steps', items: [
            'Browse or search the catalog, then click Install.',
            'Installed apps appear in your Start menu and desktop, and open in their own windows.',
            'Uninstall any time from the store or Settings → Apps.',
          ] },
          { t: 'tip', text: 'Every app in the store is checked to actually work. If one misbehaves, uninstall it and try another.' },
        ],
      },
      {
        id: 'g-pos', title: 'Point of Sale', appId: 'pos',
        keywords: 'pos point of sale shop store checkout products inventory',
        blocks: [
          { t: 'p', text: 'A complete shop till: products, checkout, receipts, and reports.' },
          { t: 'steps', items: [
            'Set up your store, then add products with prices and stock.',
            'Ring up sales in Checkout — cash and card, with change calculated.',
            'Refunds, staff PINs, and daily sales reports are built in.',
          ] },
          { t: 'tip', text: 'Staff sign in on different devices and share the same store.' },
        ],
      },
      {
        id: 'g-punch', title: 'Poinçon (time clock)', appId: 'punch',
        keywords: 'poincon punch time clock staff hours payroll schedule shifts breaks',
        blocks: [
          { t: 'p', text: 'Staff punch in and out with their PIN; managers handle schedules, corrections, and payroll.' },
          { t: 'steps', items: [
            'Punch in/out from the time clock with your staff PIN; add breaks as needed.',
            'Managers build the weekly schedule — overlapping shifts for the same person are blocked.',
            'Corrections fix mistakes (wrong time, missed punch) and are logged.',
            'Payroll approval reviews the hours before they count.',
          ] },
          { t: 'tip', text: 'Community-service hours are tracked separately from paid hours, with printable attestations.' },
        ],
      },
      {
        id: 'g-bouquinerie', title: 'Bouquinerie (bookshop)', appId: 'bouquinerie',
        keywords: 'bouquinerie bookshop catalogue books donations fairs special orders',
        blocks: [
          { t: 'p', text: 'The second-hand bookshop: catalogue, donations, fair days, and special orders.' },
          { t: 'steps', items: [
            'Catalogue: add books with price, quantity, and shelf location; import many at once from CSV.',
            'Donations: record donated books and where they go.',
            'Fair days: track sales made at book fairs separately from the shop.',
            'Special orders: note down what a customer is looking for.',
          ] },
        ],
      },
      {
        id: 'g-settings', title: 'Settings', appId: 'settings',
        keywords: 'settings personalize theme wallpaper appearance apps',
        blocks: [
          { t: 'p', text: 'Make LFDD yours.' },
          { t: 'steps', items: [
            'Appearance: light/dark mode, accent color, wallpaper, interface style, taskbar position, touch mode.',
            'Apps: choose which apps show on the desktop and in the Start menu.',
            'Your data: import, export, or erase everything.',
          ] },
        ],
      },
    ],
  },
  {
    id: 'shortcuts', title: 'Shortcuts & search', icon: Keyboard,
    articles: [
      {
        id: 'kb-shortcuts', title: 'Keyboard shortcuts',
        keywords: 'keyboard shortcuts hotkeys keys snap window',
        blocks: [
          { t: 'p', text: 'These shortcuts work anywhere on the desktop. Shortcuts never steal keystrokes while you are typing.' },
          { t: 'shortcuts' },
          { t: 'tip', text: 'Already-used combos are never claimed: Ctrl+1…8 switches spaces, Ctrl+Alt+Left/Right cycles spaces, and Ctrl+Shift+P opens the Pinboard composer.' },
        ],
      },
      {
        id: 'kb-search', title: 'Search: Spotlight and the Start menu',
        keywords: 'search spotlight find file pin global',
        blocks: [
          { t: 'p', text: `Press ${SPOTLIGHT_KEYS} anywhere to open Spotlight, the global search overlay. It searches your apps, your files, and your pins at once.` },
          { t: 'steps', items: [
            'Type to search — results appear grouped as Apps, Files, and Pins.',
            'Use ↑ and ↓ to move, Enter to open, Esc to close.',
            'Opening a file launches the right app for it (photos in Pictures, documents in Writer, and so on). Opening a pin takes you to the Pinboard.',
          ] },
          { t: 'p', text: 'The Start menu search box does the same: matching apps appear first, with matching Files and Pins grouped underneath.' },
          { t: 'tip', text: 'Apps you hid in Settings → Apps are left out of search results too.' },
        ],
      },
    ],
  },
  {
    id: 'touch', title: 'Touch mode', icon: Smartphone,
    articles: [
      {
        id: 'touch-mode', title: 'Using LFDD on a phone or tablet',
        keywords: 'touch mobile phone tablet ios android fullscreen',
        blocks: [
          { t: 'p', text: 'Touch mode turns LFDD into a phone-style home screen: big icons, swipeable pages, a dock, and full-screen apps.' },
          { t: 'steps', items: [
            'Turn it on in Settings → Appearance → Touch mode (it switches on automatically on small touch screens).',
            'Tap an icon to open the app full-screen.',
            'Tap the X or the home bar at the bottom to go back to the home screen.',
            'Turn it off any time to get the desktop back.',
          ] },
        ],
      },
    ],
  },
  {
    id: 'styles', title: 'Interface styles', icon: Palette,
    articles: [
      {
        id: 'ui-style', title: 'LFDD, Windows 11, or Mac OS X 10.6 looks',
        keywords: 'interface style theme windows mac dock taskbar appearance',
        blocks: [
          { t: 'p', text: 'Pick the look you like in Settings → Appearance → Interface style. Everything keeps working — only the chrome changes.' },
          { t: 'steps', items: [
            'LFDD: the classic calm paper-and-ink desktop.',
            'Windows 11: centered taskbar and familiar window buttons.',
            'Mac OS X 10.6: top menu bar, glass Dock with magnification, and traffic-light window buttons.',
          ] },
        ],
      },
    ],
  },
  {
    id: 'faq', title: 'FAQ & troubleshooting', icon: LifeBuoy,
    articles: [
      {
        id: 'faq-website', title: 'A website will not load in a web app',
        keywords: 'website won\'t load blank blocked embed iframe',
        blocks: [
          { t: 'p', text: 'Some websites refuse to be shown inside other pages. That is the site\'s own security setting.' },
          { t: 'steps', items: [
            'Try the "simplified view" or "text view" fallback if one is offered.',
            'Otherwise use "Open in new tab" — the site always works in its own tab.',
          ] },
        ],
      },
      {
        id: 'faq-save', title: 'I forgot to save my document',
        keywords: 'forgot save unsaved lost document',
        blocks: [
          { t: 'p', text: 'Writer, Sheets, and Slides warn you before closing with unsaved changes, so just re-open the app — your work is usually still there.' },
          { t: 'steps', items: [
            'Reopen the app from the desktop or Start menu.',
            'Save (or Save As) right away to keep it.',
          ] },
          { t: 'tip', text: 'Get in the habit of pressing Save after big edits — it only takes a second.' },
        ],
      },
      {
        id: 'faq-find', title: 'I cannot find my file',
        keywords: 'find file lost search where',
        blocks: [
          { t: 'steps', items: [
            'Open Files and check each folder — new uploads land in the main folder.',
            'Use the Pinboard search if it was a note or link.',
            'Ask Helm: "find my budget spreadsheet".',
          ] },
        ],
      },
      {
        id: 'faq-slow', title: 'Something feels slow or stuck',
        keywords: 'slow stuck frozen reload refresh',
        blocks: [
          { t: 'steps', items: [
            'Close windows you are not using.',
            'Reload the page in your browser — in the Cloud, everything is saved and comes back.',
            'If one app misbehaves, close just that window and reopen it.',
          ] },
        ],
      },
      {
        id: 'faq-tour', title: 'Replay the welcome tour',
        keywords: 'tour welcome replay help start over',
        blocks: [
          { t: 'p', text: 'Want the guided tour again? You can replay it any time.' },
          { t: 'steps', items: [
            'Click the button below to replay the welcome tour.',
          ] },
          { t: 'tip', text: 'This Help app is always here too — open it from the Start menu whenever you need it.', isTour: true },
        ],
      },
    ],
  },
  {
    id: 'manual', title: 'User manual', icon: BookOpen,
    keywords: 'manual guide pdf documentation booklet handbook',
    articles: [
      {
        id: 'manual-pdf', title: 'The complete user manual (PDF)',
        keywords: 'manual pdf guide download print booklet full documentation',
        blocks: [
          { t: 'p', text: 'The full bilingual user manual ships inside LFDD — the same complete guide, covering every app from Point of Sale to Bouquinerie.' },
          { t: 'steps', items: [
            'Click the button below to open the manual as a PDF in a new tab.',
            'Use your browser\'s find-in-page (Ctrl+F / ⌘F) to search inside the PDF.',
            'Or just type in the search box at the top of this Help app — it searches the manual\'s full text too, and each result opens the PDF at the right page.',
          ] },
          { t: 'pdf', text: 'Open the full user manual (PDF)' },
          { t: 'tip', text: 'The manual works offline once opened — your browser keeps a copy.' },
        ],
      },
    ],
  },
  {
    id: 'contact', title: 'Contact & feedback', icon: MessageCircleQuestion,
    keywords: 'contact support help buy pay purchase feedback message owner',
    custom: 'contact', articles: [],
  },
];

const APP_TITLES = { files: 'Files', spaces: 'Spaces', writer: 'Writer', sheets: 'Sheets', slides: 'Slides', pinboard: 'Pinboard', helm: 'Helm', store: 'App Store', pos: 'Point of Sale', settings: 'Settings' };

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
          onClick={() => window.open('manual/lfdd-user-manual.pdf', '_blank', 'noopener')}
          className="flex items-center gap-2 rounded-os bg-accent px-4 py-2 text-sm font-semibold text-white duration-160 hover:opacity-90"
        >
          <FileText size={16} /> {block.text || 'Open the user manual (PDF)'}
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
  const [busy, setBusy] = useState(null);
  const [notice, setNotice] = useState(null); // { ok, text }

  const load = useCallback(async () => {
    try {
      setTickets(await backend.support.listMyTickets());
    } catch {
      /* tickets are a bonus; the forms still work */
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
    []
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
                      window.open(`manual/lfdd-user-manual.pdf#page=${a.page}`, '_blank', 'noopener');
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
