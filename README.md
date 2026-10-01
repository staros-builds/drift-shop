# Drift

A calm, paper-and-ink personal cloud desktop — *"your desktop, everywhere you are."*

Shared frontend for StarOS **build 3** (bolt.new + Supabase) and **build 4** (Replit + Postgres).
Vite + React 18 + Tailwind CSS, plain JSX.

## Quick start

```bash
npm install
npm run dev      # local device mode (localStorage backend)
npm run build    # production build to dist/
```

## Backend

Selected with `VITE_DRIFT_BACKEND` (see `.env.example`):

| Value      | What it is |
| ---------- | ---------- |
| `local`    | localStorage-backed adapter, honestly labeled "local device mode" |
| `supabase` | Supabase adapter (schema in `../build3-supabase-schema.md`); degrades to local with a note when env vars are absent |
| `replit`   | stub — TODO: wire Replit Postgres REST API |

Interface definition: `src/lib/backend/index.js`. Contracts: `CONTRACTS.md`.

## Design docs

- `../build4-fork-design.md` — product vision (Spaces, Pinboard, Helm)
- `../build3-supabase-schema.md` — Supabase schema for build 3

## Honesty rules

Every clickable control does something real. No lorem ipsum, no fake data,
no simulated backends. Unwired features are absent or honestly labeled.
