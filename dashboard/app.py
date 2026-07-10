import csv
import json
import os

from flask import Flask, jsonify, render_template, request
from werkzeug.middleware.proxy_fix import ProxyFix

import dataset_manager
import grid_reach
import reach_pipeline
from db import (
    districts_geojson,
    geolocation_geojson,
    geolocations_summary,
    grid_collection,
    states_geojson,
    summary_payload,
)
from road_grid_generator import ensure_road_grids

app = Flask(__name__, static_folder="static", template_folder="templates")

# Sits behind the nginx "frontend" container / any edge proxy in front of it
# (docker-compose.yml, nginx/nginx.conf) when deployed at tcg.coers.in. Without
# this, url_for(..., _external=True) or request.url would resolve to the
# internal container host/scheme instead of the real public one.
app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)

DATA_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data")
ACCIDENT_SAFETY_FILE = os.path.join(DATA_DIR, "accident_hospital_safety_v2.json")
AMBULANCE_SAFETY_FILE = os.path.join(DATA_DIR, "accident_ambulance_safety_v2.json")
BLOODBANK_SAFETY_FILE = os.path.join(DATA_DIR, "accident_bloodbank_safety_v2.json")
DISTRICT_SCORECARD_FILE = os.path.join(DATA_DIR, "district_scorecard_v2.json")


def _load_json_file(path: str, not_found_payload: dict):
    if not os.path.exists(path):
        return jsonify(not_found_payload), 404
    with open(path) as f:
        return jsonify(json.load(f))


@app.route("/")
def index():
    return render_template("index.html", active="boundaries")


@app.route("/accident-safety")
def accident_safety_view():
    return render_template("accident_safety.html", active="accident")


@app.route("/api/accident-safety")
def accident_safety_data():
    return _load_json_file(
        ACCIDENT_SAFETY_FILE,
        {"error": "accident_hospital_safety_v2.json not found in /data. Run the precompute script first.", "default_threshold_km": 50, "max_threshold_km": 75, "features": []},
    )


@app.route("/ambulance-reach")
def ambulance_reach_view():
    return render_template("ambulance_reach.html", active="ambulance")


@app.route("/api/ambulance-reach")
def ambulance_reach_data():
    return _load_json_file(
        AMBULANCE_SAFETY_FILE,
        {"error": "accident_ambulance_safety_v2.json not found in /data. Run the precompute script first.", "default_threshold_km": 50, "max_threshold_km": 75, "features": []},
    )


@app.route("/bloodbank-reach")
def bloodbank_reach_view():
    return render_template("bloodbank_reach.html", active="bloodbank")


@app.route("/api/bloodbank-reach")
def bloodbank_reach_data():
    return _load_json_file(
        BLOODBANK_SAFETY_FILE,
        {"error": "accident_bloodbank_safety_v2.json not found in /data. Run the precompute script first.", "default_threshold_km": 50, "max_threshold_km": 75, "features": []},
    )


@app.route("/severity-heatmap")
def severity_heatmap_view():
    return render_template("severity_heatmap.html", active="heatmap")


@app.route("/api/accidents")
def accidents_data():
    path = dataset_manager.get_active_accidents_path()
    if not os.path.exists(path):
        return jsonify({"error": "No accidents dataset found in /data.", "features": []}), 404

    with open(path, encoding="utf-8-sig") as f:
        rows = list(csv.DictReader(f))
    features = [
        {
            "accident_id_sp": r["accident_id_sp"],
            "latitude": float(r["latitude_sp"]),
            "longitude": float(r["longitude_sp"]),
            "severity": r["severity"],
            "district_name": r["district_name"],
            "station_name": r["station_name"],
        }
        for r in rows
    ]
    return jsonify({"features": features})


@app.route("/api/dataset")
def dataset_state():
    return jsonify(dataset_manager.get_dataset_state())


@app.route("/api/accidents/upload", methods=["POST"])
def accidents_upload():
    file = request.files.get("file")
    if not file or not file.filename:
        return jsonify({"error": "No file provided."}), 400

    raw = file.read()
    try:
        state = dataset_manager.save_uploaded_csv(file.filename, raw)
    except dataset_manager.DatasetValidationError as exc:
        return jsonify({"error": str(exc)}), 400

    started = reach_pipeline.run_pipeline_async()
    return jsonify({"dataset": state, "recompute_started": started})


@app.route("/api/accidents/reset", methods=["POST"])
def accidents_reset():
    state = dataset_manager.reset_dataset()
    started = reach_pipeline.run_pipeline_async()
    return jsonify({"dataset": state, "recompute_started": started})


@app.route("/api/pipeline/status")
def pipeline_status():
    return jsonify(reach_pipeline.get_status())


@app.route("/district-scorecard")
def district_scorecard_view():
    return render_template("district_scorecard.html", active="scorecard")


@app.route("/api/district-scorecard")
def district_scorecard_data():
    return _load_json_file(
        DISTRICT_SCORECARD_FILE,
        {"error": "district_scorecard_v2.json not found in /data. Run the precompute script first.", "districts": []},
    )


@app.route("/grid-analysis")
def grid_analysis_view():
    return render_template("grid_analysis.html", active="grid-analysis")


@app.route("/api/grid-reach")
def grid_reach_data():
    grid_type = request.args.get("grid_type", "hex")
    district = request.args.get("district") or None
    force = request.args.get("force") == "1"

    if grid_type not in {"hex", "circle"}:
        return jsonify({"error": "grid_type must be hex or circle"}), 400
    if not district:
        return jsonify(
            {"error": "Select a district before loading grid analysis.", "requires_district": True}
        ), 400

    try:
        payload = grid_reach.get_grid_reach(grid_type, district, force=force)
    except Exception as exc:  # noqa: BLE001 — surface any failure to the UI
        return jsonify({"error": f"Failed to compute grid reach: {exc}"}), 500
    return jsonify(payload)


@app.route("/api/summary")
def summary():
    return jsonify(summary_payload())


@app.route("/api/grids/<grid_type>")
def grids(grid_type: str):
    if grid_type not in {"hex", "circle", "road"}:
        return jsonify({"error": "grid_type must be hex, circle, or road"}), 400

    state = request.args.get("state") or None
    district = request.args.get("district") or None
    irad_code = request.args.get("irad_code") or None

    if not state and not district:
        return jsonify(
            {
                "error": "Select a state or district filter before loading radar grids.",
                "requires_filter": True,
            }
        ), 400

    if grid_type == "road" and not district:
        return jsonify(
            {
                "error": "Road-distance grid requires a district selection (downloads OSM roads per district).",
                "requires_district": True,
            }
        ), 400

    if grid_type == "road":
        ensure_road_grids(district=district, state=state, irad_code=irad_code)

    collection = grid_collection(grid_type, state=state, district=district, irad_code=irad_code)
    if grid_type == "road":
        collection["properties"]["distance_mode"] = "road_network"
        collection["properties"]["spacing_km"] = 10.0
        collection["properties"]["source"] = "postgis+osm"
    return jsonify(collection)


@app.route("/api/geolocations/<layer>")
def geolocations(layer: str):
    if layer not in {"ambulance", "bloodbanks", "hospitals"}:
        return jsonify({"error": "layer must be ambulance, bloodbanks, or hospitals"}), 400
    state = request.args.get("state") or None
    district = request.args.get("district") or None
    return jsonify(geolocation_geojson(layer, state=state, district=district))


@app.route("/api/geolocations")
def geolocations_meta():
    return jsonify(geolocations_summary())


@app.route("/api/measure/route")
def measure_route():
    try:
        lat1 = float(request.args["lat1"])
        lon1 = float(request.args["lon1"])
        lat2 = float(request.args["lat2"])
        lon2 = float(request.args["lon2"])
    except (KeyError, TypeError, ValueError):
        return jsonify({"error": "lat1, lon1, lat2, lon2 are required as numbers"}), 400
    return jsonify(reach_pipeline.measure_route(lat1, lon1, lat2, lon2))


@app.route("/data/state.geojson")
def state_geojson():
    return jsonify(states_geojson())


@app.route("/data/districts.geojson")
def districts_geojson_route():
    state = request.args.get("state") or None
    return jsonify(districts_geojson(state=state))


if __name__ == "__main__":
    # This block only runs the Flask dev server, used for local development
    # (start.sh). The production container (docker-compose.yml) runs gunicorn
    # instead — see dashboard/Dockerfile — which never executes this block,
    # so FLASK_DEBUG here has no effect on the deployed site.
    port = int(os.environ.get("PORT", 5050))
    debug = os.environ.get("FLASK_DEBUG", "1") == "1"
    app.run(debug=debug, port=port, host="0.0.0.0", threaded=True)
