#!/usr/bin/env python3
"""Generate 10 km hex/circle grids inside districts using PostGIS."""

from __future__ import annotations

import os
import sys
from pathlib import Path

import psycopg2

DATABASE_URL = os.environ.get("DATABASE_URL", "postgresql://mapsr:mapsr@localhost:5433/mapsr")
CELL_RADIUS_M = 5000
MIN_AREA_M2 = 25000


def utm_srid(lon: float, lat: float) -> int:
    zone = int((lon + 180) / 6) + 1
    return (32600 if lat >= 0 else 32700) + zone


HEX_SQL = """
WITH district_row AS (
    SELECT
        "DISTRICT" AS district,
        "STATE_UT" AS state_ut,
        geometry AS geom,
        ST_Transform(
            geometry,
            %(utm)s
        ) AS geom_utm
    FROM india_admin_boundary.district
    WHERE "DISTRICT" = %(district)s
      AND ("STATE_UT" = %(state_ut)s OR %(state_ut)s IS NULL)
    LIMIT 1
),
hexes AS (
    SELECT (ST_HexagonGrid(%(radius)s, ST_Envelope(geom_utm))).geom AS cell_utm
    FROM district_row
),
clipped AS (
    SELECT
        d.district,
        d.state_ut,
        ST_Transform(ST_Intersection(h.cell_utm, d.geom_utm), 4326) AS geom
    FROM hexes h
    CROSS JOIN district_row d
    WHERE ST_Intersects(h.cell_utm, d.geom_utm)
      AND ST_Area(ST_Intersection(h.cell_utm, d.geom_utm)) > %(min_area)s
)
INSERT INTO india_admin_boundary.grid_cell (district, state_ut, grid_type, cell_radius_m, geometry)
SELECT district, state_ut, 'hex', %(radius)s, geom
FROM clipped
ON CONFLICT DO NOTHING;
"""


CIRCLE_SQL = """
WITH district_row AS (
    SELECT
        "DISTRICT" AS district,
        "STATE_UT" AS state_ut,
        geometry AS geom,
        ST_Transform(
            geometry,
            %(utm)s
        ) AS geom_utm
    FROM india_admin_boundary.district
    WHERE "DISTRICT" = %(district)s
      AND ("STATE_UT" = %(state_ut)s OR %(state_ut)s IS NULL)
    LIMIT 1
),
squares AS (
    SELECT (ST_SquareGrid(%(diameter)s, ST_Envelope(geom_utm))).geom AS sq_utm
    FROM district_row
),
circles AS (
    SELECT ST_Buffer(ST_Centroid(sq_utm), %(radius)s) AS cell_utm
    FROM squares
),
clipped AS (
    SELECT
        d.district,
        d.state_ut,
        ST_Transform(ST_Intersection(c.cell_utm, d.geom_utm), 4326) AS geom
    FROM circles c
    CROSS JOIN district_row d
    WHERE ST_Intersects(c.cell_utm, d.geom_utm)
      AND ST_Area(ST_Intersection(c.cell_utm, d.geom_utm)) > %(min_area)s
)
INSERT INTO india_admin_boundary.grid_cell (district, state_ut, grid_type, cell_radius_m, geometry)
SELECT district, state_ut, 'circle', %(radius)s, geom
FROM clipped
ON CONFLICT DO NOTHING;
"""


def main() -> None:
    conn = psycopg2.connect(DATABASE_URL)
    conn.autocommit = False

    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT "DISTRICT", "STATE_UT",
                   ST_X(ST_Centroid(geometry)) AS lon,
                   ST_Y(ST_Centroid(geometry)) AS lat
            FROM india_admin_boundary.district
            ORDER BY "STATE_UT", "DISTRICT"
            """
        )
        districts = cur.fetchall()

        total = len(districts)
        for idx, (district, state_ut, lon, lat) in enumerate(districts, start=1):
            params = {
                "district": district,
                "state_ut": state_ut,
                "utm": utm_srid(lon, lat),
                "radius": CELL_RADIUS_M,
                "diameter": CELL_RADIUS_M * 2,
                "min_area": MIN_AREA_M2,
            }
            cur.execute(HEX_SQL, params)
            cur.execute(CIRCLE_SQL, params)
            conn.commit()
            if idx % 25 == 0 or idx == total:
                print(f"  {idx}/{total} districts processed", flush=True)

        cur.execute("SELECT grid_type, COUNT(*) FROM india_admin_boundary.grid_cell GROUP BY grid_type ORDER BY grid_type")
        for grid_type, count in cur.fetchall():
            print(f"{grid_type}: {count} cells")

    conn.close()


if __name__ == "__main__":
    main()
