const map = L.map("map", { zoomControl: true, preferCanvas: true }).setView([29.05, 76.4], 8);
initMapMeasure(map);

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 18,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
}).addTo(map);

const THRESHOLD_KM = 50;

const SEVERITY_COLORS = {
  Fatal: "#dc2626",
  "Grievous Injury": "#f97316",
  "Minor Injury Hospitalized": "#eab308",
  "Minor Injury Non-Hospitalized": "#84cc16",
  "Non-Injury": "#94a3b8",
};

let accidentData = [];
let accidentLayer = L.layerGroup().addTo(map);
let radiusLayer = L.layerGroup().addTo(map);
let hospitalLayer = L.layerGroup().addTo(map);
let highlighted = null;

function setStatus(message, isError = false) {
  const el = document.getElementById("status-line");
  el.textContent = message;
  el.classList.toggle("error", isError);
}

function dangerRadarIcon(status, severity) {
  const color = status === "green" ? "#22c55e" : "#ef4444";
  const sevColor = SEVERITY_COLORS[severity] || "#f59e0b";
  return L.divIcon({
    className: "accident-marker-wrap",
    html: `<div class="accident-marker" style="--radar-color:${color}">
             <div class="radar-ring"></div>
             <div class="radar-core"></div>
             <div class="danger-icon" style="color:${sevColor}">&#9888;</div>
           </div>`,
    iconSize: [30, 30],
    iconAnchor: [15, 15],
  });
}

function showDetails(feature) {
  const panel = document.getElementById("feature-details");
  panel.classList.remove("empty");
  const n = feature.nearest_hospital;
  const statusLabel = feature.status === "green"
    ? `<span style="color:#22c55e">Reachable</span> &mdash; hospital within ${THRESHOLD_KM} km by road`
    : `<span style="color:#ef4444">Unreachable</span> &mdash; no hospital within ${THRESHOLD_KM} km by road`;

  let hospHtml = "No hospital candidates found nearby.";
  if (n) {
    hospHtml = `${n.hospital_name.trim()} (${n.hosp_type || "Unknown type"})<br/>
                ${n.district_name}, road distance: <b>${n.road_km} km</b>`;
  }

  panel.innerHTML = `
    <div class="detail-title">${feature.accident_id_sp}</div>
    <div class="detail-type">${feature.severity}</div>
    <dl>
      <dt>District / Station</dt><dd>${feature.district_name} &middot; ${feature.station_name}</dd>
      <dt>Status</dt><dd>${statusLabel}</dd>
      <dt>Nearest hospital</dt><dd>${hospHtml}</dd>
      <dt>Candidates checked</dt><dd>${feature.candidates_checked}</dd>
    </dl>
  `;
}

function renderAccidents() {
  accidentLayer.clearLayers();
  radiusLayer.clearLayers();

  const showAccidents = document.getElementById("layer-accidents").checked;
  const showRadius = document.getElementById("layer-radius").checked;
  const showGreen = document.getElementById("filter-green").checked;
  const showRed = document.getElementById("filter-red").checked;

  if (!showAccidents) return;

  let shown = 0;
  accidentData.forEach((f) => {
    if (f.status === "green" && !showGreen) return;
    if (f.status === "red" && !showRed) return;

    const latlng = [f.latitude, f.longitude];
    const marker = L.marker(latlng, { icon: dangerRadarIcon(f.status, f.severity) });
    marker.on("click", () => showDetails(f));
    accidentLayer.addLayer(marker);
    shown += 1;

    if (showRadius) {
      L.circle(latlng, {
        radius: THRESHOLD_KM * 1000,
        color: f.status === "green" ? "#22c55e" : "#ef4444",
        weight: 1,
        fillOpacity: 0.03,
        dashArray: "4 6",
      }).addTo(radiusLayer);
    }
  });

  document.getElementById("count-accidents").textContent = String(shown);
}

async function loadHospitals() {
  const enabled = document.getElementById("layer-hospitals").checked;
  hospitalLayer.clearLayers();
  if (!enabled) {
    document.getElementById("count-hospitals").textContent = "0";
    return;
  }
  const response = await fetch("/api/geolocations/hospitals?state=Haryana");
  const data = await response.json();
  const layer = L.geoJSON(data, {
    pointToLayer: (feature, latlng) =>
      L.circleMarker(latlng, {
        radius: 4,
        color: "#fff",
        weight: 1,
        fillColor: "#10b981",
        fillOpacity: 0.85,
      }).bindPopup(
        `<b>${feature.properties.hospital_name || "Hospital"}</b><br/>${feature.properties.hosp_type || ""}<br/>${feature.properties.district_name || ""}`
      ),
  });
  hospitalLayer.addLayer(layer);
  document.getElementById("count-hospitals").textContent = data.properties?.count || data.features?.length || 0;
}

function renderSeverityLegend() {
  const el = document.getElementById("severity-legend");
  el.innerHTML = Object.entries(SEVERITY_COLORS)
    .map(
      ([label, color]) =>
        `<div class="row"><span class="swatch-sm" style="background:${color}"></span>${label}</div>`
    )
    .join("");
}

async function init() {
  renderSeverityLegend();
  setStatus("Loading accident/hospital analysis...");

  try {
    const response = await fetch("/api/accident-safety");
    const data = await response.json();
    if (data.error) {
      setStatus(data.error, true);
      return;
    }
    accidentData = data.features || [];

    const total = accidentData.length;
    const green = accidentData.filter((f) => f.status === "green").length;
    const red = total - green;

    document.getElementById("stat-total").textContent = String(total);
    document.getElementById("stat-green").textContent = String(green);
    document.getElementById("stat-red").textContent = String(red);
    document.getElementById("stat-threshold").textContent = `${data.threshold_km || THRESHOLD_KM} km`;

    setStatus(`${total} accidents analyzed against real Haryana hospital locations (OSRM road-route distance).`);

    if (total > 0) {
      const bounds = L.latLngBounds(accidentData.map((f) => [f.latitude, f.longitude]));
      map.fitBounds(bounds, { padding: [40, 40] });
    }

    renderAccidents();
  } catch (err) {
    console.error(err);
    setStatus("Failed to load accident safety data.", true);
  }
}

document.getElementById("layer-accidents").addEventListener("change", renderAccidents);
document.getElementById("layer-radius").addEventListener("change", renderAccidents);
document.getElementById("filter-green").addEventListener("change", renderAccidents);
document.getElementById("filter-red").addEventListener("change", renderAccidents);
document.getElementById("layer-hospitals").addEventListener("change", loadHospitals);

init().catch((err) => {
  console.error(err);
  setStatus("Failed to initialize map.", true);
});
