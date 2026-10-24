#!/usr/bin/env bash
# Runs the migrations + seed + rule checks on a throwaway local Postgres database.
# Needs psql and a running Postgres. Usage: PGHOST=/tmp PGPORT=5432 scripts/test-db.sh
set -euo pipefail
cd "$(dirname "$0")/.."
DB=csl_pos_test

# The `anon` and `authenticated` roles are cluster-wide. If this is a Supabase cluster
# (`supabase start`), the stub would collide with roles Supabase's own stack depends on.
# Refuse rather than damage it.
if psql -Atd postgres -c "select 1 from pg_roles where rolname = 'supabase_admin'" 2>/dev/null | grep -q 1; then
  echo "This looks like a Supabase cluster (role 'supabase_admin' exists)." >&2
  echo "scripts/test-db.sh creates its own auth stub and must not run here." >&2
  echo "Fix: point PGHOST/PGPORT at a plain Postgres, e.g. PGHOST=/tmp PGPORT=5432" >&2
  exit 1
fi

dropdb --if-exists "$DB" >/dev/null 2>&1 || true
createdb "$DB"
run() { psql -q -v ON_ERROR_STOP=1 -d "$DB" -f "$1"; }
run supabase/tests/00_supabase_stub.sql
for f in supabase/migrations/*.sql; do run "$f"; done
run supabase/seed.sql
run supabase/tests/sales_rules_test.sql
dropdb "$DB"
echo "Database rules: all checks passed."
