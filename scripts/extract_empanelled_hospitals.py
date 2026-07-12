#!/usr/bin/env python3
"""Extract the hospitals withheld from the public map layer and save them to a
backup file so the data is preserved outside the live table.

Withheld types are defined by db.EXCLUDED_HOSP_TYPES (currently
"Empanelled Private Hospital"). These rows are NOT deleted from
public.haryana_hosp — this script only reads them out and writes a GeoJSON
backup to data/hospitals_empanelled_private.json.

Run it any time after the database is loaded:

    DATABASE_URL=postgresql://mapsr:mapsr@localhost:5433/mapsr \
        python3 scripts/extract_empanelled_hospitals.py
"""

from __future__ import annotations

import json
import os
import sys

# db.py lives in the dashboard/ package; make it importable when this script is
# run from the repo root.
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "dashboard"))

import db  # noqa: E402

OUTPUT_PATH = os.path.join(ROOT, "data", "hospitals_empanelled_private.json")


def main() -> int:
    collection = db.excluded_hospitals_geojson()
    if collection.get("error"):
        print(f"ERROR: {collection['error']}", file=sys.stderr)
        return 1

    count = collection.get("properties", {}).get("count", len(collection.get("features", [])))

    # Safety: these rows have been physically removed from geolocations.sql, so
    # a live DB loaded from the current dump returns 0 here. Never overwrite an
    # existing backup with fewer records than it already holds — that would
    # silently destroy the preserved data.
    if os.path.exists(OUTPUT_PATH):
        try:
            existing = len(json.load(open(OUTPUT_PATH, encoding="utf-8")).get("features", []))
        except (ValueError, OSError):
            existing = 0
        if count < existing:
            print(
                f"Refusing to overwrite {OUTPUT_PATH}: DB has {count} record(s) "
                f"but the existing backup holds {existing}. The empanelled rows "
                f"are already removed from the dataset; backup left untouched.",
                file=sys.stderr,
            )
            return 0

    os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)
    with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
        json.dump(collection, f, ensure_ascii=False, indent=2)

    types = ", ".join(db.EXCLUDED_HOSP_TYPES)
    print(f"Preserved {count} hospital(s) of type [{types}] -> {OUTPUT_PATH}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
