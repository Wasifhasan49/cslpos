#!/usr/bin/env bash
# Runs the migrations + seed + rule checks on a throwaway local Postgres database.
# Needs psql and a running Postgres. Usage: PGHOST=/tmp PGPORT=54329 PGUSER=postgres scripts/test-db.sh
set -euo pipefail
cd "$(dirname "$0")/.."
DB=csl_pos_test
dropdb --if-exists "$DB" >/dev/null 2>&1 || true
psql -q -v ON_ERROR_STOP=1 -d postgres -c "drop role if exists anon; drop role if exists authenticated;" >/dev/null 2>&1 || true
createdb "$DB"
run() { psql -q -v ON_ERROR_STOP=1 -d "$DB" -f "$1"; }
run supabase/tests/00_supabase_stub.sql
for f in supabase/migrations/*.sql; do run "$f"; done
run supabase/seed.sql
run supabase/tests/sales_rules_test.sql
dropdb "$DB"
