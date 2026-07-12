"""Recomputes hospital/ambulance/blood-bank road-route reach + the district
scorecard against whichever accidents CSV is currently active.

Runs in a background thread so uploading a new dataset doesn't block the
request — the frontend polls get_status() until it reports "done".
"""

from __future__ import annotations

import csv
import json
import math
import os
import threading
import time
import urllib.request
from datetime import datetime, timezone
from typing import Any

from dataset_manager import get_active_accidents_path
from db import fetch_all

DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data")
DATA_DIR = os.path.abspath(DATA_DIR)

STRAIGHT_BUFFER_KM = 75.0
CANDIDATE_SEND_CAP = 25
CANDIDATE_KEEP_CAP = 12
# Coverage measured against the 22 District Hospitals only. At a 20 km road
# reach every district's rural periphery falls outside coverage, so unreachable
# (red) areas appear in all 22 Haryana districts.
DEFAULT_THRESHOLD_KM = 20.0
OSRM_URL = "https://router.project-osrm.org/table/v1/driving/{coords}?sources=0&annotations=distance"
OSRM_ROUTE_URL = (
    "https://router.project-osrm.org/route/v1/driving/{coords}?overview=full&geometries=geojson"
)

FACILITY_JOBS = [
    {
        "key": "hospital",
        "table": "public.haryana_hosp",
        "name_col": "hospital_name",
        "type_col": "hosp_type",
        "out_file": "accident_hospital_safety_v2.json",
    },
    {
        "key": "ambulance",
        "table": "public.haryana_ambulance",
        "name_col": "vehicle_no",
        "type_col": "vehicle_type",
        "out_file": "accident_ambulance_safety_v2.json",
    },
    {
        "key": "bloodbank",
        "table": "public.haryana_bloodbanks",
        "name_col": "blood_centre_name",
        "type_col": None,
        "out_file": "accident_bloodbank_safety_v2.json",
    },
]

DISTRICT_ALIASES = {
    "MEWAT": "NUH",
    "HISSAR": "HISAR",
    "SONEPAT": "SONIPAT",
    "NARNAUL": "MAHENDRAGARH",
    "N U H": "NUH",
    "JAGADHRI": "YAMUNANAGAR",
    "YAMUNA NAGAR": "YAMUNANAGAR",
}

SEVERITIES = [
    "Fatal",
    "Grievous Injury",
    "Minor Injury Hospitalized",
    "Minor Injury Non-Hospitalized",
    "Non-Injury",
]
SEVERITY_WEIGHTS = {"Fatal": 5, "Grievous Injury": 3, "Minor Injury Hospitalized": 2, "Minor Injury Non-Hospitalized": 1, "Non-Injury": 0.5}

_lock = threading.Lock()
_status: dict[str, Any] = {
    "state": "idle",
    "facility": None,
    "progress": {"done": 0, "total": 0},
    "started_at": None,
    "finished_at": None,
    "error": None,
}


def get_status() -> dict[str, Any]:
    with _lock:
        return dict(_status)


def _set_status(**kwargs) -> None:
    with _lock:
        _status.update(kwargs)


def _norm_district(name: str) -> str:
    n = (name or "").strip().upper()
    n = n.replace("YAMUNA NAGAR", "YAMUNANAGAR")
    return DISTRICT_ALIASES.get(n, n)


def _haversine_km(lat1, lon1, lat2, lon2) -> float:
    r = 6371.0088
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def _load_facilities(table: str) -> list[dict]:
    rows = fetch_all(
        f'SELECT * FROM {table} WHERE latitude IS NOT NULL AND longitude IS NOT NULL'
    )
    return [dict(r) for r in rows]


def measure_route(lat1: float, lon1: float, lat2: float, lon2: float) -> dict[str, Any]:
    """Straight-line and OSRM driving distance between two map points."""
    straight_km = round(_haversine_km(lat1, lon1, lat2, lon2), 2)
    coords = f"{lon1},{lat1};{lon2},{lat2}"
    url = OSRM_ROUTE_URL.format(coords=coords)
    road_km: float | None = None
    duration_s: float | None = None
    route_geometry: dict | None = None
    for _ in range(3):
        try:
            with urllib.request.urlopen(url, timeout=20) as resp:
                data = json.loads(resp.read())
            if data.get("code") == "Ok" and data.get("routes"):
                route = data["routes"][0]
                road_km = round(route["distance"] / 1000.0, 2)
                duration_s = round(route.get("duration", 0), 0)
                route_geometry = route.get("geometry")
                break
        except Exception:
            time.sleep(1.0)
    return {
        "straight_km": straight_km,
        "road_km": road_km,
        "duration_s": duration_s,
        "route_geometry": route_geometry,
        "osrm_ok": road_km is not None,
    }


def _osrm_table(lat: float, lon: float, candidates: list[dict]) -> list[float] | None:
    coords = [f"{lon},{lat}"] + [f"{h['longitude']},{h['latitude']}" for h in candidates]
    url = OSRM_URL.format(coords=";".join(coords))
    for _ in range(3):
        try:
            with urllib.request.urlopen(url, timeout=15) as resp:
                data = json.loads(resp.read())
            if data.get("code") == "Ok":
                return data["distances"][0][1:]
            return None
        except Exception:
            time.sleep(1.0)
    return None


def _read_active_accidents() -> list[dict]:
    with open(get_active_accidents_path(), encoding="utf-8-sig") as f:
        return list(csv.DictReader(f))


def _run_facility_job(job: dict, accidents: list[dict]) -> None:
    facilities = _load_facilities(job["table"])
    features = []

    for i, acc in enumerate(accidents):
        _set_status(facility=job["key"], progress={"done": i, "total": len(accidents)})

        alat, alon = float(acc["latitude_sp"]), float(acc["longitude_sp"])
        scored = []
        for h in facilities:
            d = _haversine_km(alat, alon, h["latitude"], h["longitude"])
            if d <= STRAIGHT_BUFFER_KM:
                scored.append((d, h))
        scored.sort(key=lambda x: x[0])
        candidates = [h for _, h in scored[:CANDIDATE_SEND_CAP]]

        kept = []
        if candidates:
            road_distances = _osrm_table(alat, alon, candidates)
            if road_distances:
                paired = []
                for h, d_m in zip(candidates, road_distances):
                    if d_m is None:
                        continue
                    paired.append((d_m / 1000.0, h))
                paired.sort(key=lambda x: x[0])
                for road_km, h in paired[:CANDIDATE_KEEP_CAP]:
                    kept.append(
                        {
                            "name": str(h.get(job["name_col"], "") or "").strip(),
                            "type": str(h.get(job["type_col"], "") or "") if job["type_col"] else "",
                            "district_name": h.get("district_name", ""),
                            "latitude": h["latitude"],
                            "longitude": h["longitude"],
                            "road_km": round(road_km, 2),
                        }
                    )
        features.append(
            {
                "accident_id_sp": acc["accident_id_sp"],
                "latitude": alat,
                "longitude": alon,
                "severity": acc["severity"],
                "district_name": acc["district_name"],
                "station_name": acc["station_name"],
                "candidates": kept,
            }
        )
        time.sleep(0.1)

    payload = {
        "schema": "v2",
        "default_threshold_km": DEFAULT_THRESHOLD_KM,
        "max_threshold_km": STRAIGHT_BUFFER_KM,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "features": features,
    }
    with open(os.path.join(DATA_DIR, job["out_file"]), "w") as f:
        json.dump(payload, f, indent=2)


def _recompute_district_scorecard(accidents: list[dict]) -> None:
    _set_status(facility="scorecard", progress={"done": 0, "total": 1})

    district_rows = fetch_all(
        'SELECT DISTINCT "DISTRICT" FROM india_admin_boundary.district WHERE UPPER("STATE_UT") = \'HARYANA\''
    )
    haryana_districts = sorted({r["DISTRICT"] for r in district_rows})

    hospitals = _load_facilities("public.haryana_hosp")

    with open(os.path.join(DATA_DIR, "accident_hospital_safety_v2.json")) as f:
        safety_v2 = json.load(f)["features"]

    per_district = {
        d: {
            "district": d,
            "accident_count": 0,
            "severity_counts": {s: 0 for s in SEVERITIES},
            "hospital_count": 0,
            "road_km_sum": 0.0,
            "road_km_n": 0,
            "unreachable_count": 0,
        }
        for d in haryana_districts
    }

    def _row_for(d):
        if d not in per_district:
            per_district[d] = {
                "district": d,
                "accident_count": 0,
                "severity_counts": {s: 0 for s in SEVERITIES},
                "hospital_count": 0,
                "road_km_sum": 0.0,
                "road_km_n": 0,
                "unreachable_count": 0,
            }
        return per_district[d]

    for a in accidents:
        row = _row_for(_norm_district(a["district_name"]))
        row["accident_count"] += 1
        if a["severity"] in row["severity_counts"]:
            row["severity_counts"][a["severity"]] += 1

    for h in hospitals:
        d = _norm_district(h.get("district_name", ""))
        if d in per_district:
            per_district[d]["hospital_count"] += 1

    for f in safety_v2:
        d = _norm_district(f["district_name"])
        if d not in per_district:
            continue
        candidates = f.get("candidates") or []
        if not candidates:
            per_district[d]["unreachable_count"] += 1
            continue
        nearest_km = candidates[0]["road_km"]
        per_district[d]["road_km_sum"] += nearest_km
        per_district[d]["road_km_n"] += 1
        if nearest_km > DEFAULT_THRESHOLD_KM:
            per_district[d]["unreachable_count"] += 1

    rows = []
    for d, row in per_district.items():
        weighted = sum(SEVERITY_WEIGHTS[s] * c for s, c in row["severity_counts"].items())
        avg_road_km = round(row["road_km_sum"] / row["road_km_n"], 2) if row["road_km_n"] else None
        accidents_per_hospital = round(row["accident_count"] / row["hospital_count"], 2) if row["hospital_count"] else None
        rows.append(
            {
                "district": d,
                "accident_count": row["accident_count"],
                "severity_counts": row["severity_counts"],
                "weighted_severity_score": round(weighted, 1),
                "hospital_count": row["hospital_count"],
                "avg_road_km_to_hospital": avg_road_km,
                "accidents_per_hospital": accidents_per_hospital,
                "unreachable_count": row["unreachable_count"],
            }
        )
    rows.sort(key=lambda r: r["district"])

    payload = {
        "schema": "v2",
        "unreachable_threshold_km": DEFAULT_THRESHOLD_KM,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "formula": {
            "weighted_severity_score": "Fatal x5 + Grievous Injury x3 + Minor Injury Hospitalized x2 + Minor Injury Non-Hospitalized x1 + Non-Injury x0.5, summed per district",
            "avg_road_km_to_hospital": "Mean, across the district's accidents, of each accident's nearest hospital by actual OSRM road distance",
            "accidents_per_hospital": "accident_count / hospital_count",
            "unreachable_count": f"Accidents whose nearest hospital by road is more than {DEFAULT_THRESHOLD_KM:.0f} km away (or has no candidate hospital at all)",
        },
        "districts": rows,
    }
    with open(os.path.join(DATA_DIR, "district_scorecard_v2.json"), "w") as f:
        json.dump(payload, f, indent=2)


def _run_pipeline() -> None:
    try:
        _set_status(
            state="running",
            facility=None,
            progress={"done": 0, "total": 0},
            started_at=datetime.now(timezone.utc).isoformat(),
            finished_at=None,
            error=None,
        )
        accidents = _read_active_accidents()
        for job in FACILITY_JOBS:
            _run_facility_job(job, accidents)
        _recompute_district_scorecard(accidents)
        _set_status(state="done", facility=None, finished_at=datetime.now(timezone.utc).isoformat())
    except Exception as exc:  # noqa: BLE001 — surface any failure to the UI
        _set_status(state="error", error=str(exc), finished_at=datetime.now(timezone.utc).isoformat())


def run_pipeline_async() -> bool:
    """Kick off a recompute in the background. Returns False if one's already running."""
    with _lock:
        if _status["state"] == "running":
            return False
    thread = threading.Thread(target=_run_pipeline, daemon=True)
    thread.start()
    return True
