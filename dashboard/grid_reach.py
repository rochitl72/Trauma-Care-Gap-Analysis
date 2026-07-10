"""On-demand road-route distance from hex/circle grid cells to the nearest
hospital, for the Grid Analysis view.

Grid cells (hex/circle, 10 km diameter) already live in PostGIS per district
(see db.grid_collection). This takes those cells, finds each cell's centroid,
and asks OSRM for the real road-route distance to nearby hospitals — the same
approach reach_pipeline.py uses for individual accidents, just applied to
grid centroids instead of accident points.

Computed per-district on first request and cached to disk (a full state-wide
sweep across every district x both grid types would mean thousands of OSRM
calls up front for districts nobody's looked at yet).
"""

from __future__ import annotations

import json
import os
import re
import time
from datetime import datetime, timezone
from typing import Any

from shapely.geometry import shape

import reach_pipeline
from db import grid_collection

DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data")
DATA_DIR = os.path.abspath(DATA_DIR)
CACHE_DIR = os.path.join(DATA_DIR, "grid_reach")


def _cache_path(grid_type: str, district: str) -> str:
    safe = re.sub(r"[^A-Za-z0-9_-]+", "_", district.strip()) or "unknown"
    return os.path.join(CACHE_DIR, f"{grid_type}__{safe}.json")


def _cell_centroid(geometry: dict) -> tuple[float, float]:
    geom = shape(geometry)
    c = geom.centroid
    return c.y, c.x  # lat, lon


def compute_grid_reach(grid_type: str, district: str) -> dict:
    collection = grid_collection(grid_type, district=district)
    features = collection.get("features", [])
    hospitals = reach_pipeline._load_facilities("public.haryana_hosp")

    out_features: list[dict[str, Any]] = []
    for feature in features:
        lat, lon = _cell_centroid(feature["geometry"])

        scored = []
        for h in hospitals:
            d = reach_pipeline._haversine_km(lat, lon, h["latitude"], h["longitude"])
            if d <= reach_pipeline.STRAIGHT_BUFFER_KM:
                scored.append((d, h))
        scored.sort(key=lambda x: x[0])
        candidates = [h for _, h in scored[: reach_pipeline.CANDIDATE_SEND_CAP]]

        kept = []
        if candidates:
            road_distances = reach_pipeline._osrm_table(lat, lon, candidates)
            if road_distances:
                paired = []
                for h, d_m in zip(candidates, road_distances):
                    if d_m is None:
                        continue
                    paired.append((d_m / 1000.0, h))
                paired.sort(key=lambda x: x[0])
                for road_km, h in paired[: reach_pipeline.CANDIDATE_KEEP_CAP]:
                    kept.append(
                        {
                            "name": str(h.get("hospital_name", "") or "").strip(),
                            "type": str(h.get("hosp_type", "") or ""),
                            "district_name": h.get("district_name", ""),
                            "latitude": h["latitude"],
                            "longitude": h["longitude"],
                            "road_km": round(road_km, 2),
                        }
                    )

        props = dict(feature.get("properties") or {})
        props["centroid_lat"] = lat
        props["centroid_lon"] = lon
        props["candidates"] = kept
        out_features.append({"type": "Feature", "properties": props, "geometry": feature["geometry"]})
        time.sleep(0.1)

    return {
        "schema": "v2",
        "type": "FeatureCollection",
        "grid_type": grid_type,
        "district": district,
        "default_threshold_km": reach_pipeline.DEFAULT_THRESHOLD_KM,
        "max_threshold_km": reach_pipeline.STRAIGHT_BUFFER_KM,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "cell_diameter_km": (collection.get("properties") or {}).get("cell_diameter_km", 10.0),
        "features": out_features,
    }


def get_grid_reach(grid_type: str, district: str, force: bool = False) -> dict:
    os.makedirs(CACHE_DIR, exist_ok=True)
    path = _cache_path(grid_type, district)
    if not force and os.path.exists(path):
        with open(path) as f:
            return json.load(f)

    payload = compute_grid_reach(grid_type, district)
    with open(path, "w") as f:
        json.dump(payload, f, indent=2)
    return payload
