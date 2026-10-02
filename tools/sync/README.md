# tools/sync — backend mesh tools

Keeps a second Supabase project (the **standby**) as an hourly,
verified copy of the live one (**primary**), so a dead provider costs
about ten minutes and at most one hour of re-typed sales — never the
shop's data. Full design, setup, and failover runbook:
[docs/backend-mesh.md](../../docs/backend-mesh.md).

Every tool is **dry-run by default**: it prints the exact commands
and changes nothing. Writing requires BOTH `--live` and
`SYNC_ALLOW_WRITE=1` in the environment.

```bash
node tools/sync/probe.mjs    # are both backends reachable? (read-only)
node tools/sync/counts.mjs   # do the row counts agree?     (read-only)
node tools/sync/sync.mjs     # probe -> copy -> verify      (dry run)
SYNC_ALLOW_WRITE=1 node tools/sync/sync.mjs --live --mode sync
```

Needed environment variables (locally or as GitHub Actions secrets):
`PRIMARY_URL`, `PRIMARY_ANON_KEY`, `PRIMARY_SERVICE_KEY`,
`PRIMARY_DB_URL` and the same four with `STANDBY_`
(`*_SUPABASE_URL` / `*_DATABASE_URL` spellings also accepted — see
`lib/env.mjs`). Secrets are never printed; database URLs are redacted
to `***` in all output.

Unit tests for the count-comparison logic:
`node test/sync-verify.test.mjs`.
