"""Generate 10 km road-network grids using OpenStreetMap drivable roads."""

from __future__ import annotations

import json
import os
from typing import Any

import osmnx as ox
import psycopg2
from psycopg2.extras import Json, execute_batch
from pyproj import Transformer
from shapely.geometry import mapping, shape
from shapely.ops import substring, transform

DATABASE_URL = os.environ.get("DATABASE_URL", "postgresql://mapsr:mapsr@localhost:5433/mapsr")

ROAD_SEGMENT_M = 10_000
ROAD_BUFFER_M = 450
MIN_CELL_AREA_M2 = 5_000
HIGHWAY_FILTER = '["highway"~"motorway|trunk|primary|secondary|tertiary"]'
INSERT_SQL = """
    INSERT INTO india_admin_boundary.grid_cell
        (district, state_ut, grid_type, cell_radius_m, geometry)
    VALUES (
        %s, %s, 'road', %s,
        ST_SetSRID(ST_GeomFromGeoJSON(%s), 4326)
    )
    ON CONFLICT DO NOTHING
"""


def _segment_cells_along_edge(geom, length: float) -> list:
    if length <= 0 or geom is None:
        return []
    segments = []
    start = 0.0
    while start < length:
        end = min(start + ROAD_SEGMENT_M, length)
        if end - start < 500:
            break
        seg = substring(geom, start, end)
        if not seg.is_empty:
            segments.append(seg)
        start = end
    return segments


def _fetch_district_geom(cur, district: str, state_ut: str | None) -> tuple | None:
    cur.execute(
        """
        SELECT "DISTRICT", "STATE_UT", ST_AsGeoJSON(geometry) AS geom
        FROM india_admin_boundary.district
        WHERE "DISTRICT" = %s
          AND (%s IS NULL OR "STATE_UT" = %s)
        LIMIT 1
        """,
        (district, state_ut, state_ut),
    )
    row = cur.fetchone()
    if not row:
        cur.execute(
            """
            SELECT "DISTRICT", "STATE_UT", ST_AsGeoJSON(geometry) AS geom
            FROM india_admin_boundary.district
            WHERE "DISTRICT" = %s
            LIMIT 1
            """,
            (district,),
        )
        row = cur.fetchone()
    return row


def generate_road_grid_for_district(district: str, state_ut: str | None = None) -> dict[str, Any]:
    ox.settings.use_cache = True
    ox.settings.log_console = False
    ox.settings.timeout = 180

    conn = psycopg2.connect(DATABASE_URL)
    try:
        with conn.cursor() as cur:
            row = _fetch_district_geom(cur, district, state_ut)
            if not row:
                return {"district": district, "cells": 0, "error": "District not found"}

            district_name, state_name, geom_json = row
            district_poly = shape(json.loads(geom_json))

            try:
                G = ox.graph_from_polygon(
                    district_poly,
                    network_type="drive",
                    simplify=True,
                    truncate_by_edge=True,
                    custom_filter=HIGHWAY_FILTER,
                )
            except Exception as exc:
                return {"district": district_name, "cells": 0, "error": f"No road network: {exc}"}

            if G.number_of_edges() == 0:
                return {"district": district_name, "cells": 0, "error": "No major roads found in district"}

            G = ox.project_graph(G)
            crs = G.graph["crs"]
            to_wgs = Transformer.from_crs(crs, "EPSG:4326", always_xy=True).transform

            batch: list[tuple] = []
            for _u, _v, _k, data in G.edges(keys=True, data=True):
                geom = data.get("geometry")
                if geom is None:
                    continue
                length = float(geom.length)
                if length <= 0 or length > 500_000:
                    continue
                for seg in _segment_cells_along_edge(geom, length):
                    corridor = seg.buffer(ROAD_BUFFER_M)
                    if corridor.is_empty or corridor.area < MIN_CELL_AREA_M2:
                        continue

                    corridor_wgs = transform(to_wgs, corridor)
                    clipped = corridor_wgs.intersection(district_poly)
                    if clipped.is_empty:
                        continue

                    parts = clipped.geoms if hasattr(clipped, "geoms") else [clipped]
                    for part in parts:
                        if part.is_empty:
                            continue
                        batch.append(
                            (
                                district_name,
                                state_name,
                                ROAD_SEGMENT_M / 2,
                                Json(mapping(part)),
                            )
                        )

            if batch:
                execute_batch(cur, INSERT_SQL, batch, page_size=200)

            conn.commit()
            return {
                "district": district_name,
                "state_ut": state_name,
                "cells": len(batch),
                "segment_km": ROAD_SEGMENT_M / 1000,
            }
    finally:
        conn.close()


def ensure_road_grids(
    district: str | None,
    state: str | None = None,
    irad_code: str | None = None,
) -> list[dict[str, Any]]:
    if not district:
        return []

    conn = psycopg2.connect(DATABASE_URL)
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT COUNT(*) FROM india_admin_boundary.grid_cell
                WHERE grid_type = 'road' AND district = %s
                """,
                (district,),
            )
            if cur.fetchone()[0] > 0:
                return []

            state_ut = None
            cur.execute(
                """
                SELECT "STATE_UT" FROM india_admin_boundary.district
                WHERE "DISTRICT" = %s
                  AND (%s IS NULL OR "STATE_UT" = %s OR "IRAD_ST_CODE" = %s)
                LIMIT 1
                """,
                (district, state, state, irad_code),
            )
            row = cur.fetchone()
            if row:
                state_ut = row[0]
    finally:
        conn.close()

    return [generate_road_grid_for_district(district, state_ut)]
