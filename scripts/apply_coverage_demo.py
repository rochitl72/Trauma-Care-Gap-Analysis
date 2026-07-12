#!/usr/bin/env python3
"""Apply (or revert) an ILLUSTRATIVE coverage-gap demo for the Grid Analysis view.

WHY THIS EXISTS
---------------
With the real hospital data, every grid cell and accident in Haryana is within
~22 km of a hospital by road, so at a 50 km reach threshold everything is
'reachable' (green) — which is accurate. To *demonstrate* the tool's red/green
coverage-gap visual at 50 km+, this script deliberately marks a share of cells
and accidents as unreachable.

The data it writes is NOT a real finding — it is labelled demo data
(`coverage_demo: true` on every modified feature). Present it as a capability
demonstration, not as an actual coverage analysis.

WHAT IT TOUCHES
---------------
- data/accident_hospital_safety_v2.json  (accident dots — git-tracked, ships)
- data/grid_reach/hex__<DISTRICT>.json    (hex cells — local cache, git-ignored,
  regenerated if the district is force-recomputed)

For each target district it selects the most *peripheral* ~PCT of features
(farthest from the district's centre) and rewrites their nearest-hospital
road distance into the (threshold, 75] band, so they read RED at 50 km and turn
GREEN again if the threshold is dragged to 75 — a nice live story.

USAGE
-----
    python3 scripts/apply_coverage_demo.py --apply
    python3 scripts/apply_coverage_demo.py --revert     # restore originals
"""

from __future__ import annotations

import argparse
import json
import math
import os
import shutil

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
GRID_DIR = os.path.join(DATA, "grid_reach")
ACCIDENT_FILE = os.path.join(DATA, "accident_hospital_safety_v2.json")
BACKUP_DIR = os.path.join(DATA, "coverage_demo_backups")

# Districts to affect. Grid cells are only changed for districts that already
# have a cached grid_reach file; accidents are changed for any of these that
# appear in the accident dataset.
TARGET_DISTRICTS = [
    "FARIDABAD", "PALWAL",                       # GST/GT-Road south
    "SONIPAT", "PANIPAT", "KARNAL",              # GT-Road north belt
    "KURUKSHETRA", "AMBALA",                     # GT-Road north belt
]

RED_FRACTION = 0.35          # ~30-40% of features go red
RED_KM_LOW, RED_KM_HIGH = 55.0, 72.0   # red at 50-53, green again by 75


def _haversine(lat1, lon1, lat2, lon2):
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def _backup(path):
    os.makedirs(BACKUP_DIR, exist_ok=True)
    dest = os.path.join(BACKUP_DIR, os.path.basename(path))
    if not os.path.exists(dest):           # keep the first (pristine) copy only
        shutil.copy2(path, dest)


def _restore(path):
    src = os.path.join(BACKUP_DIR, os.path.basename(path))
    if os.path.exists(src):
        shutil.copy2(src, path)
        return True
    return False


def _make_red(candidates, target_km):
    """Rewrite a candidate list so the nearest hospital is `target_km` away."""
    if not candidates:
        return []
    out = []
    for i, c in enumerate(candidates[:3]):
        nc = dict(c)
        nc["road_km"] = round(target_km + i * 4.0, 2)
        out.append(nc)
    return out


def _apply_to_features(features, centroid_getter, mark):
    """Select the most peripheral RED_FRACTION of features and make them red."""
    pts = [centroid_getter(f) for f in features]
    valid = [(i, p) for i, p in enumerate(pts) if p is not None]
    if not valid:
        return 0
    clat = sum(p[0] for _, p in valid) / len(valid)
    clon = sum(p[1] for _, p in valid) / len(valid)
    ranked = sorted(valid, key=lambda ip: _haversine(clat, clon, ip[1][0], ip[1][1]), reverse=True)
    n_red = max(1, round(len(ranked) * RED_FRACTION))
    red = ranked[:n_red]
    for rank, (idx, _) in enumerate(red):
        # most peripheral -> farthest (reddest); scale across the red band
        frac = 1 - (rank / max(1, n_red - 1)) if n_red > 1 else 0.0
        target = RED_KM_LOW + frac * (RED_KM_HIGH - RED_KM_LOW)
        mark(features[idx], target)
    return n_red


def apply():
    # --- accidents (priority 1: synthetic data) ---
    _backup(ACCIDENT_FILE)
    adata = json.load(open(ACCIDENT_FILE, encoding="utf-8"))
    by_dist = {}
    for f in adata["features"]:
        by_dist.setdefault((f.get("district_name") or "").upper(), []).append(f)

    def acc_centroid(f):
        try:
            return (float(f["latitude"]), float(f["longitude"]))
        except (KeyError, TypeError, ValueError):
            return None

    def acc_mark(f, target):
        f["candidates"] = _make_red(f.get("candidates") or [], target)
        f["coverage_demo"] = True

    acc_total = 0
    for dist in TARGET_DISTRICTS:
        feats = by_dist.get(dist, [])
        if feats:
            acc_total += _apply_to_features(feats, acc_centroid, acc_mark)
    json.dump(adata, open(ACCIDENT_FILE, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    print(f"accidents: marked {acc_total} red across {ACCIDENT_FILE}")

    # --- grid cells (per district cache; git-ignored, local demo) ---
    def cell_centroid(f):
        p = f.get("properties") or {}
        lat, lon = p.get("centroid_lat"), p.get("centroid_lon")
        return (lat, lon) if isinstance(lat, (int, float)) and isinstance(lon, (int, float)) else None

    def cell_mark(f, target):
        p = f.setdefault("properties", {})
        p["candidates"] = _make_red(p.get("candidates") or [], target)
        p["coverage_demo"] = True

    for dist in TARGET_DISTRICTS:
        path = os.path.join(GRID_DIR, f"hex__{dist}.json")
        if not os.path.exists(path):
            print(f"grid cells: {dist:12s} — no cache yet (open it once in the app, then re-run) — skipped")
            continue
        _backup(path)
        gdata = json.load(open(path, encoding="utf-8"))
        n = _apply_to_features(gdata.get("features", []), cell_centroid, cell_mark)
        json.dump(gdata, open(path, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
        print(f"grid cells: {dist:12s} — marked {n}/{len(gdata.get('features', []))} red")


def revert():
    restored = []
    for name in os.listdir(BACKUP_DIR) if os.path.isdir(BACKUP_DIR) else []:
        target = ACCIDENT_FILE if name == os.path.basename(ACCIDENT_FILE) else os.path.join(GRID_DIR, name)
        if _restore(target):
            restored.append(name)
    print("reverted:", ", ".join(restored) if restored else "nothing to restore")


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--apply", action="store_true", help="apply the demo coverage gaps")
    g.add_argument("--revert", action="store_true", help="restore original data from backups")
    args = ap.parse_args()
    if args.apply:
        apply()
    else:
        revert()


if __name__ == "__main__":
    main()
