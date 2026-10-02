#!/usr/bin/env bash
# Vendra — verify the hourly re-sync: per-table row counts on the primary
# must equal both copies. Any mismatch (or unreachable backend) exits 1,
# which fails the workflow and triggers GitHub's failure email = the alarm.
#
# Exports for the heartbeat step: NEON_OK, AIVEN_OK (true/false),
# NEON_MM, AIVEN_MM (mismatch counts), TABLES (tables checked).
#
# Needs: PRIMARY_DATABASE_URL, NEON_DATABASE_URL, AIVEN_DATABASE_URL.
# The vault schema is excluded: it belongs to the Supabase-only
# supabase_vault extension, which is deliberately not copied.

set -u

NEON_MM=0; AIVEN_MM=0; TABLES=0
NEON_OK=true; AIVEN_OK=true

tables=$(psql "$PRIMARY_DATABASE_URL" -t -A -c \
  "SELECT schemaname||'.'||tablename FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema','vault') ORDER BY 1;") \
  || { echo "::error::Primary unreachable for table list."; exit 1; }

for t in $tables; do
  s=${t%%.*}; tbl=${t#*.}
  q="SELECT count(*) FROM \"$s\".\"$tbl\";"
  c1=$(psql "$PRIMARY_DATABASE_URL" -t -A -c "$q" 2>/dev/null || echo ERR)
  c2=$(psql "$NEON_DATABASE_URL"     -t -A -c "$q" 2>/dev/null || echo ERR)
  c3=$(psql "$AIVEN_DATABASE_URL"    -t -A -c "$q" 2>/dev/null || echo ERR)
  TABLES=$((TABLES+1))
  if [ "$c1" != "$c2" ]; then
    echo "MISMATCH(neon) $t primary=$c1 neon=$c2"
    NEON_MM=$((NEON_MM+1))
  fi
  if [ "$c1" != "$c3" ]; then
    echo "MISMATCH(aiven) $t primary=$c1 aiven=$c3"
    AIVEN_MM=$((AIVEN_MM+1))
  fi
  [ "$c2" = "ERR" ] && NEON_OK=false
  [ "$c3" = "ERR" ] && AIVEN_OK=false
done

{
  echo "NEON_OK=$NEON_OK"
  echo "AIVEN_OK=$AIVEN_OK"
  echo "NEON_MM=$NEON_MM"
  echo "AIVEN_MM=$AIVEN_MM"
  echo "TABLES=$TABLES"
} >> "$GITHUB_ENV"

if [ "$NEON_MM" != "0" ] || [ "$AIVEN_MM" != "0" ] || [ "$NEON_OK" != "true" ] || [ "$AIVEN_OK" != "true" ]; then
  echo "::error::Row-count mismatch between primary and copies — investigate before the next run."
  exit 1
fi
echo "OK: all $TABLES tables match across primary, Neon, and Aiven."
