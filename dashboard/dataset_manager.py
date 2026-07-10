"""Tracks which accidents CSV is 'active' for every accident/reach view.

The shipped demo file (haryana_synthetic_accidents.csv) is never modified.
Uploading a replacement writes to accidents_active.csv instead, and a small
JSON marker records which one is currently in use. Removing the upload
deletes that override and reports back to the default.
"""

from __future__ import annotations

import csv
import io
import json
import os
from datetime import datetime, timezone
from typing import Any

DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data")
DATA_DIR = os.path.abspath(DATA_DIR)

DEFAULT_CSV = os.path.join(DATA_DIR, "haryana_synthetic_accidents.csv")
ACTIVE_CSV = os.path.join(DATA_DIR, "accidents_active.csv")
STATE_FILE = os.path.join(DATA_DIR, "dataset_state.json")

REQUIRED_COLUMNS = [
    "accident_id_sp",
    "year",
    "latitude_sp",
    "longitude_sp",
    "severity",
    "state_name",
    "district_name",
    "station_name",
    "state_code",
    "district_code",
    "station_code",
]


class DatasetValidationError(Exception):
    pass


def _default_state() -> dict[str, Any]:
    return {"source": "default", "filename": None, "uploaded_at": None, "row_count": None}


def get_dataset_state() -> dict[str, Any]:
    if not os.path.exists(STATE_FILE):
        return _default_state()
    try:
        with open(STATE_FILE) as f:
            state = json.load(f)
    except (json.JSONDecodeError, OSError):
        return _default_state()

    if state.get("source") == "custom" and not os.path.exists(ACTIVE_CSV):
        # Marker says custom but the file's gone missing — fall back safely.
        return _default_state()
    return state


def get_active_accidents_path() -> str:
    state = get_dataset_state()
    if state.get("source") == "custom" and os.path.exists(ACTIVE_CSV):
        return ACTIVE_CSV
    return DEFAULT_CSV


def _validate_csv_bytes(raw: bytes) -> int:
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise DatasetValidationError(f"File isn't valid UTF-8 text: {exc}") from exc

    reader = csv.DictReader(io.StringIO(text))
    if reader.fieldnames is None:
        raise DatasetValidationError("File appears to be empty.")

    missing = [c for c in REQUIRED_COLUMNS if c not in reader.fieldnames]
    if missing:
        raise DatasetValidationError(
            "Missing required column(s): " + ", ".join(missing) + ". "
            f"Expected: {', '.join(REQUIRED_COLUMNS)}"
        )

    row_count = 0
    for row_count, row in enumerate(reader, start=1):
        # Spot-check lat/lon parse cleanly — the most common way a "same schema"
        # file quietly isn't.
        try:
            float(row["latitude_sp"])
            float(row["longitude_sp"])
        except (TypeError, ValueError) as exc:
            raise DatasetValidationError(
                f"Row {row_count}: latitude_sp/longitude_sp must be numeric ({exc})"
            ) from exc

    if row_count == 0:
        raise DatasetValidationError("File has a header row but no data rows.")

    return row_count


def save_uploaded_csv(filename: str, raw: bytes) -> dict[str, Any]:
    """Validate an uploaded CSV against the required schema and make it active.

    Raises DatasetValidationError with a human-readable message on any mismatch.
    """
    row_count = _validate_csv_bytes(raw)

    os.makedirs(DATA_DIR, exist_ok=True)
    with open(ACTIVE_CSV, "wb") as f:
        f.write(raw)

    state = {
        "source": "custom",
        "filename": filename,
        "uploaded_at": datetime.now(timezone.utc).isoformat(),
        "row_count": row_count,
    }
    with open(STATE_FILE, "w") as f:
        json.dump(state, f, indent=2)
    return state


def reset_dataset() -> dict[str, Any]:
    if os.path.exists(ACTIVE_CSV):
        os.remove(ACTIVE_CSV)
    state = _default_state()
    with open(STATE_FILE, "w") as f:
        json.dump(state, f, indent=2)
    return state
