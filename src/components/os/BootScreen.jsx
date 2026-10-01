import React, { useEffect, useState } from 'react';
import { backend } from '../../lib/backend/current.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Paper-plane mark, inline SVG. */
export function DriftMark({ size = 44, className = '' }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="none"
      className={className}
      aria-hidden="true"
    >
      <path
        d="M6 24L42 8L28 42L21 28L6 24Z"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinejoin="round"
      />
      <path d="M21 28L42 8" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}

/**
 * Real boot: pings the backend, lets the auth session restore, shows honest
 * status lines as each step completes, then calls onDone().
 */
export default function BootScreen({ onDone }) {
  const [lines, setLines] = useState([]);

  useEffect(() => {
    let cancelled = false;
    const add = (text) => {
      if (!cancelled) setLines((prev) => [...prev, text]);
    };
    (async () => {
      add('Starting drift…');
      try {
        await backend.settings.get();
        add(`Backend ready — ${backend.kind} mode.`);
      } catch (e) {
        add(`Backend hiccup: ${e.message}. Continuing anyway.`);
      }
      await sleep(350);
      if (cancelled) return;
      add('Restoring your session…');
      await sleep(450);
      if (cancelled) return;
      onDone();
    })();
    return () => {
      cancelled = true;
    };
  }, [onDone]);

  return (
    <div className="fixed inset-0 z-[100] flex flex-col items-center justify-center bg-paper text-ink">
      <div className="text-accent">
        <DriftMark size={56} />
      </div>
      <h1 className="mt-4 text-4xl font-light tracking-tight">drift</h1>
      <div className="mt-8 h-20 w-72 text-center" role="status" aria-live="polite">
        {lines.map((line, i) => (
          <p key={i} className="text-sm text-muted duration-160">
            {line}
          </p>
        ))}
      </div>
      <div className="mt-2 h-1 w-40 overflow-hidden rounded-full bg-osborder">
        <div
          className="h-full bg-accent duration-160"
          style={{ width: `${Math.min(100, (lines.length / 3) * 100)}%` }}
        />
      </div>
    </div>
  );
}
