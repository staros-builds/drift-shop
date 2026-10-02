-- 081: backend_status heartbeat table (expand-only, safe over 080).
-- Written by the hourly db-sync-neon-aiven workflow so the app (and Jesse)
-- can see sync health without asking. Single-row table (id=1).
-- Public read (admins view it in AdminPanel); no public write — only the
-- workflow writes, using the database connection string (bypasses RLS as owner).

CREATE TABLE IF NOT EXISTS public.backend_status (
  id int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  checked_at timestamptz NOT NULL,
  run_url text,
  primary_ok boolean NOT NULL DEFAULT true,
  primary_latency_ms int,
  neon_ok boolean,
  neon_mismatches int,
  aiven_ok boolean,
  aiven_mismatches int,
  tables_checked int,
  last_backup_at timestamptz,
  backup_ok boolean,
  note text
);

ALTER TABLE public.backend_status ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS backend_status_read ON public.backend_status;
CREATE POLICY backend_status_read ON public.backend_status
  FOR SELECT USING (true);

INSERT INTO public.backend_status (id, checked_at, primary_ok, note)
VALUES (1, now(), true, 'seeded; awaiting first sync run')
ON CONFLICT (id) DO NOTHING;
