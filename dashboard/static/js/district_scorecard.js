const map = L.map("map", { zoomControl: false, preferCanvas: true }).setView([29.05, 76.4], 8);
initMapMeasure(map);

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 18,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
}).addTo(map);

L.control.zoom({ position: "topright" }).addTo(map);

const METRIC_LABELS = {
  accident_count: "Accident count",
  weighted_severity_score: "Severity-weighted score",
  hospital_count: "Hospital count",
  avg_road_km_to_hospital: "Avg. road-km to nearest hospital",
  accidents_per_hospital: "Accidents per hospital",
  unreachable_count: "Accidents with no hospital ≤ 50 km",
};

const METRIC_NOTES = {
  accident_count: "Total synthetic accidents recorded in this district.",
  weighted_severity_score: "Fatal x5 + Grievous x3 + Minor(Hosp) x2 + Minor(Non-Hosp) x1 + Non-Injury x0.5.",
  hospital_count: "Real hospitals (geolocations.sql) located in this district.",
  avg_road_km_to_hospital: "Average OSRM road-route distance from each accident to its nearest qualifying hospital.",
  accidents_per_hospital: "Accident count divided by hospital count — higher means more strain per facility.",
  unreachable_count: "Accidents where no hospital was found within 50 km by road.",
};

let districtScores = {};
let districtLayer = null;
let currentMetric = "accident_count";

function setStatus(message, isError = false) {
  const el = document.getElementById("status-line");
  el.textContent = message;
  el.classList.toggle("error", isError);
}

function colorScale(value, min, max) {
  if (value === null || value === undefined) return "#334155";
  if (max === min) return "#facc15";
  const t = Math.max(0, Math.min(1, (value - min) / (max - min)));
  // green -> yellow -> red
  const stops = [
    [0.0, [34, 197, 94]],
    [0.5, [250, 204, 21]],
    [1.0, [220, 38, 38]],
  ];
  let lo = stops[0], hi = stops[stops.length - 1];
  for (let i = 0; i < stops.length - 1; i++) {
    if (t >= stops[i][0] && t <= stops[i + 1][0]) {
      lo = stops[i];
      hi = stops[i + 1];
      break;
    }
  }
  const span = hi[0] - lo[0] || 1;
  const localT = (t - lo[0]) / span;
  const rgb = lo[1].map((c, i) => Math.round(c + (hi[1][i] - c) * localT));
  return `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
}

function renderLegend(min, max) {
  const el = document.getElementById("scale-legend");
  const gradient = "linear-gradient(90deg, rgb(34,197,94), rgb(250,204,21), rgb(220,38,38))";
  el.innerHTML = `
    <div style="height:14px;border-radius:6px;background:${gradient};margin-bottom:0.4rem;"></div>
    <div style="display:flex;justify-content:space-between;font-size:0.78rem;color:var(--muted)">
      <span>${min === null ? "n/a" : min}</span>
      <span>${max === null ? "n/a" : max}</span>
    </div>
    <div style="margin-top:0.4rem;font-size:0.76rem;color:#334155;background:#0f1419;border-radius:4px;padding:2px 6px;display:inline-block">
      <i style="display:inline-block;width:10px;height:10px;background:#334155;border-radius:2px;margin-right:4px;"></i>no data
    </div>
  `;
}

function titleCase(value) {
  return String(value || "").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

function showDetails(district, row) {
  const panel = document.getElementById("feature-details");
  panel.classList.remove("empty");
  if (!row) {
    panel.innerHTML = `<div class="detail-title">${titleCase(district)}</div><div class="detail-type">No accident/hospital data</div>`;
    return;
  }
  const sev = row.severity_counts || {};
  const sevRows = Object.entries(sev)
    .map(([label, count]) => `<dt>${label}</dt><dd>${count}</dd>`)
    .join("");
  panel.innerHTML = `
    <div class="detail-title">${titleCase(district)}</div>
    <div class="detail-type">District scorecard</div>
    <dl>
      <dt>Accident count</dt><dd>${row.accident_count}</dd>
      ${sevRows}
      <dt>Severity-weighted score</dt><dd>${row.weighted_severity_score}</dd>
      <dt>Hospital count</dt><dd>${row.hospital_count}</dd>
      <dt>Avg road-km to nearest hospital</dt><dd>${row.avg_road_km_to_hospital ?? "n/a"}</dd>
      <dt>Accidents per hospital</dt><dd>${row.accidents_per_hospital ?? "n/a"}</dd>
      <dt>Accidents with no hospital &le; 50 km</dt><dd>${row.unreachable_count}</dd>
    </dl>
  `;
}

function updateTable(rows) {
  const tbody = document.getElementById("district-table");
  document.getElementById("table-count").textContent = String(rows.length);
  tbody.innerHTML = rows
    .map(
      (r) => `<tr data-district="${r.district}">
        <td>${titleCase(r.district)}</td>
        <td>${r.accident_count}</td>
        <td>${r.hospital_count}</td>
        <td>${r.avg_road_km_to_hospital ?? "—"}</td>
      </tr>`
    )
    .join("");
  tbody.querySelectorAll("tr").forEach((tr) => {
    tr.addEventListener("click", () => {
      const d = tr.dataset.district;
      showDetails(d, districtScores[d]);
      if (districtLayer) {
        districtLayer.eachLayer((l) => {
          if (l.feature.properties.DISTRICT === d) {
            map.fitBounds(l.getBounds(), { padding: [40, 40], maxZoom: 10 });
          }
        });
      }
    });
  });
}

function applyStyling() {
  if (!districtLayer) return;
  const values = Object.values(districtScores)
    .map((r) => r[currentMetric])
    .filter((v) => v !== null && v !== undefined);
  const min = values.length ? Math.min(...values) : null;
  const max = values.length ? Math.max(...values) : null;

  districtLayer.eachLayer((layer) => {
    const name = layer.feature.properties.DISTRICT;
    const row = districtScores[name];
    const value = row ? row[currentMetric] : null;
    layer.setStyle({
      color: "#1e293b",
      weight: 1,
      fillColor: colorScale(value, min, max),
      fillOpacity: 0.65,
    });
  });

  renderLegend(min, max);
  document.getElementById("metric-note").textContent = METRIC_NOTES[currentMetric] || "";
}

async function init() {
  setStatus("Loading district geometry and metrics...");
  try {
    // Scoped to Haryana server-side — the full India file is 840 districts (~11MB);
    // this view only ever renders the 22 in Haryana.
    const [districtGeo, scoreData] = await Promise.all([
      fetch("/data/districts.geojson?state=HARYANA").then((r) => r.json()),
      fetch("/api/district-scorecard").then((r) => r.json()),
    ]);

    if (scoreData.error) {
      setStatus(scoreData.error, true);
      return;
    }

    districtScores = {};
    (scoreData.districts || []).forEach((row) => {
      districtScores[row.district] = row;
    });

    const thresholdKm = scoreData.unreachable_threshold_km;
    if (thresholdKm !== undefined) {
      const note = document.getElementById("unreachable-threshold-note");
      if (note) {
        note.textContent = `Accidents whose nearest hospital by road is more than ${thresholdKm} km away, or has no candidate hospital at all.`;
      }
      const option = document.querySelector('#metric-select option[value="unreachable_count"]');
      if (option) option.textContent = `Accidents with no hospital ≤ ${thresholdKm} km`;
    }

    const haryanaFeatures = districtGeo.features.filter(
      (f) => String(f.properties.STATE_UT || "").toUpperCase() === "HARYANA"
    );

    districtLayer = L.geoJSON(
      { type: "FeatureCollection", features: haryanaFeatures },
      {
        onEachFeature: (feature, layer) => {
          const name = feature.properties.DISTRICT;
          layer.on("click", () => showDetails(name, districtScores[name]));
          layer.on("mouseover", () => layer.setStyle({ weight: 2.5 }));
          layer.on("mouseout", () => layer.setStyle({ weight: 1 }));
          layer.bindTooltip(titleCase(name), { sticky: true });
        },
      }
    ).addTo(map);

    map.fitBounds(districtLayer.getBounds(), { padding: [20, 20] });

    updateTable(
      Object.values(districtScores).sort((a, b) => b.accident_count - a.accident_count)
    );

    applyStyling();
    setStatus(`${haryanaFeatures.length} districts loaded.`);

    fetch("/api/pipeline/status")
      .then((r) => r.json())
      .then((status) => {
        if (status.state === "running") {
          setStatus("A dataset recompute is in progress — road-distance metrics may be stale until it finishes.", true);
        }
      })
      .catch(() => {});
  } catch (err) {
    console.error(err);
    setStatus("Failed to load district scorecard.", true);
  }
}

document.getElementById("metric-select").addEventListener("change", (e) => {
  currentMetric = e.target.value;
  applyStyling();
});

init();
