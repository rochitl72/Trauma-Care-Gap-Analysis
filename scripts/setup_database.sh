#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

export DATABASE_URL="${DATABASE_URL:-postgresql://mapsr:mapsr@localhost:5433/mapsr}"

PSQL=(psql "$DATABASE_URL" -v ON_ERROR_STOP=1)

echo "==> Waiting for PostgreSQL..."
for _ in $(seq 1 30); do
  if "${PSQL[@]}" -c "SELECT 1" >/dev/null 2>&1; then
    break
  fi
  sleep 2
done
"${PSQL[@]}" -c "SELECT 1" >/dev/null

echo "==> Enabling PostGIS..."
"${PSQL[@]}" -c "CREATE EXTENSION IF NOT EXISTS postgis;"
"${PSQL[@]}" -c "CREATE SCHEMA IF NOT EXISTS india_admin_boundary;"

sanitize_sql() {
  grep -v 'transaction_timeout' "$1" | grep -v 'OWNER TO postgres'
}

DISTRICT_COUNT=$("${PSQL[@]}" -tAc "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='india_admin_boundary' AND table_name='district';" | tr -d ' ')

if [[ "$DISTRICT_COUNT" == "0" ]]; then
  echo "==> Loading state boundaries..."
  sanitize_sql "state 1.sql" | "${PSQL[@]}"
  echo "==> Loading district boundaries..."
  sanitize_sql district.sql | "${PSQL[@]}"
else
  ROWS=$("${PSQL[@]}" -tAc 'SELECT COUNT(*) FROM india_admin_boundary.district;' | tr -d ' ')
  echo "==> District table already loaded ($ROWS rows)"
fi

echo "==> Creating grid tables..."
"${PSQL[@]}" -f scripts/sql/002_grid_schema.sql
"${PSQL[@]}" -f scripts/sql/003_road_grid_type.sql

GRID_COUNT=$("${PSQL[@]}" -tAc "SELECT COUNT(*) FROM india_admin_boundary.grid_cell;" | tr -d ' ')
if [[ "$GRID_COUNT" == "0" ]]; then
  echo "==> Generating 10 km grids in PostGIS (first run, may take a few minutes)..."
  python3 scripts/generate_grids_postgis.py
else
  echo "==> Grid cells already present ($GRID_COUNT rows)"
fi

GEO_TABLE=$("${PSQL[@]}" -tAc "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='public' AND table_name='haryana_ambulance';" | tr -d ' ')
if [[ "$GEO_TABLE" == "0" ]]; then
  echo "==> Loading Haryana geolocations (ambulance, blood banks, hospitals)..."
  sanitize_sql geolocations.sql | "${PSQL[@]}"
else
  AMB=$("${PSQL[@]}" -tAc 'SELECT COUNT(*) FROM public.haryana_ambulance;' | tr -d ' ')
  echo "==> Geolocation tables already loaded ($AMB ambulances)"
fi

"${PSQL[@]}" -f scripts/sql/004_geolocations_indexes.sql

echo "==> Database ready."
