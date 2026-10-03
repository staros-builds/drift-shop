import { useCallback, useEffect, useRef, useState } from 'react';
import { LayoutGrid, Palette, Cloud, Check, ChevronLeft, ChevronRight, X } from 'lucide-react';
import { useSettings } from '../../os/SettingsContext.jsx';
import { VendraMark } from './BootScreen.jsx';
import { useLang } from '../../lib/i18n.jsx';

const LS_KEY = 'drift:welcome_tour_seen';
const SHOW_EVENT = 'drift:show-tour';

import { fr as frDict } from '../../lib/locales/fr.js';
import { en as enDict } from '../../lib/locales/en.js';
import { es as esDict } from '../../lib/locales/es.js';
import { pt as ptDict } from '../../lib/locales/pt.js';

const TOUR_DICTS = { fr: frDict, en: enDict, es: esDict, pt: ptDict };

// Icons are keyed by step index; titles/texts come from the locale dicts.
const STEP_ICONS = [null, LayoutGrid, Palette, Cloud, Check];

/**
 * Self-managing first-run tour overlay.
 *
 * Mount once (e.g. next to WelcomeDialog in Desktop.jsx): <WelcomeTour />
 * - Auto-shows once, right after the legacy welcome dialog is dismissed
 *   (settings.welcome_seen true, tour not yet seen).
 * - "Don't show again" / completion persists via settings (welcome_tour_seen)
 *   with a localStorage fallback so it works even if the settings key is new.
 * - Re-openable any time: window.dispatchEvent(new CustomEvent('drift:show-tour'))
 */
export function useWelcomeTourState() {
  const { settings, loading, updateSettings } = useSettings();
  const [open, setOpen] = useState(false);
  const autoShown = useRef(false);

  const seen = useCallback(() => {
    if (settings && typeof settings.welcome_tour_seen !== 'undefined') {
      return !!settings.welcome_tour_seen;
    }
    try {
      return window.localStorage.getItem(LS_KEY) === '1';
    } catch {
      return false;
    }
  }, [settings]);

  const markSeen = useCallback(async () => {
    try {
      window.localStorage.setItem(LS_KEY, '1');
    } catch { /* ignore */ }
    try {
      await updateSettings({ welcome_tour_seen: true });
    } catch { /* settings key may be new; localStorage covers it */ }
  }, [updateSettings]);

  // Auto-show once: after the old welcome dialog was dismissed, before first real use.
  useEffect(() => {
    if (loading || autoShown.current) return;
    if (settings && settings.welcome_seen && !seen()) {
      autoShown.current = true;
      setOpen(true);
    }
  }, [loading, settings, seen]);

  // Manual replay from Help & Guide.
  useEffect(() => {
    const show = () => {
      autoShown.current = true;
      setOpen(true);
    };
    window.addEventListener(SHOW_EVENT, show);
    return () => window.removeEventListener(SHOW_EVENT, show);
  }, []);

  const close = useCallback(async (persist = true) => {
    setOpen(false);
    if (persist) await markSeen();
  }, [markSeen]);

  return { open, setOpen, close, markSeen, seen };
}

export default function WelcomeTour() {
  const { lang, t } = useLang();
  const STEPS = (TOUR_DICTS[lang] || frDict).tour.steps;
  const { open, setOpen, close } = useWelcomeTourState();
  const [step, setStep] = useState(0);
  const [dontShow, setDontShow] = useState(true);
  const primaryRef = useRef(null);

  const finish = () => close(dontShow);
  const skip = () => close(dontShow);
  const skipRef = useRef(skip);
  skipRef.current = skip;

  // Restart from step 0 whenever it opens.
  useEffect(() => {
    if (open) {
      setStep(0);
      setDontShow(true);
    }
  }, [open]);

  // Escape skips; focus starts on the primary action.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') skipRef.current();
    };
    window.addEventListener('keydown', onKey);
    primaryRef.current?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  if (!open) return null;

  const last = step === STEPS.length - 1;
  const current = STEPS[step] || { title: '', text: '' };
  const Icon = STEP_ICONS[step];

  return (
    <div className="fixed inset-0 z-[95] flex items-center justify-center bg-ink/40 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('tour.ariaLabel') + ' — ' + current.title}
        className="max-h-[calc(100dvh-2rem)] w-full max-w-md overflow-y-auto rounded-os border border-osborder bg-surface shadow-win"
      >
        <div className="flex items-start justify-between p-6 pb-0">
          <div className="flex h-12 w-12 items-center justify-center rounded-os bg-accent/15 text-accent">
            {Icon ? <Icon size={24} strokeWidth={1.75} /> : <VendraMark size={28} />}
          </div>
          <button
            type="button" aria-label={t('tour.skipTour')} onClick={skip}
            className="rounded-os p-1.5 text-muted duration-160 hover:bg-paper hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            <X size={18} />
          </button>
        </div>

        <div className="p-6 pt-4">
          <h2 className="mb-2 text-xl font-medium text-ink">{current.title}</h2>
          <p className="min-h-16 text-sm leading-relaxed text-muted">{current.text}</p>

          {/* Progress dots */}
          <div className="mb-4 mt-4 flex gap-1.5">
            {STEPS.map((_, i) => (
              <span
                key={i}
                className={`h-1.5 rounded-full duration-160 ${i === step ? 'w-6 bg-accent' : i < step ? 'w-1.5 bg-accent/50' : 'w-1.5 bg-osborder'}`}
              />
            ))}
          </div>

          <label className="mb-4 flex cursor-pointer items-center gap-2 text-xs text-muted">
            <input
              type="checkbox" checked={dontShow}
              onChange={(e) => setDontShow(e.target.checked)}
              className="h-3.5 w-3.5 accent-[var(--accent)]"
            />
            {t('tour.dontShow')}
          </label>

          <div className="flex items-center justify-between">
            <button
              type="button" onClick={skip}
              className="rounded-os px-3 py-2 text-sm text-muted duration-160 hover:bg-paper hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              {t('tour.skip')}
            </button>
            <div className="flex gap-2">
              {step > 0 && (
                <button
                  type="button" onClick={() => setStep(step - 1)}
                  className="flex items-center gap-1 rounded-os border border-osborder bg-paper px-3 py-2 text-sm text-ink duration-160 hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                >
                  <ChevronLeft size={14} /> {t('tour.back')}
                </button>
              )}
              {!last ? (
                <button
                  type="button" ref={primaryRef} onClick={() => setStep(step + 1)}
                  className="flex items-center gap-1 rounded-os bg-accent px-4 py-2 text-sm font-medium text-white duration-160 hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
                >
                  {t('tour.next')} <ChevronRight size={14} />
                </button>
              ) : (
                <button
                  type="button" ref={primaryRef} onClick={finish}
                  className="rounded-os bg-accent px-4 py-2 text-sm font-medium text-white duration-160 hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
                >
                  {t('tour.start')}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}


// Re-open the tour from anywhere:
//   window.dispatchEvent(new CustomEvent(SHOW_EVENT))
export { SHOW_EVENT };
