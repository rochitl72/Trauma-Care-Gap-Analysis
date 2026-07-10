// Generic "accident vs facility, road-route reach" view with a user-adjustable distance threshold.
// Configured per-page via window.REACH_CONFIG:
//   dataUrl            - API endpoint returning { default_threshold_km, max_threshold_km, features: [...] }
//   facilityLayerUrl   - API endpoint returning all-facility GeoJSON (optional layer toggle)
//   facilityLabel      - e.g. "Hospital", "Ambulance", "Blood bank"
//   facilityColor      - marker fill color for the "all facilities" layer
//   statLabels         - { green: "...", red: "..." } sidebar labels
//
// Each accident feature carries a `candidates` array (nearest facilities by actual road
// distance, precomputed via OSRM). The threshold is applied client-side against that list,
// so dragging the slider needs zero network calls.

const CONFIG = window.REACH_CONFIG || {};
const MIN_THRESHOLD_KM = 5;
let THRESHOLD_KM = 50;
let MAX_THRESHOLD_KM = 75;

const map = L.map("map", { zoomControl: false, preferCanvas: true }).setView([29.05, 76.4], 8);
initMapMeasure(map);

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 18,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
}).addTo(map);

L.control.zoom({ position: "topright" }).addTo(map);

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
let facilityLayer = L.layerGroup().addTo(map);
let lastSelected = null;

function setStatus(message, isError = false) {
  const el = document.getElementById("status-line");
  el.textContent = message;
  el.classList.toggle("error", isError);
}

const ALERT_TRIANGLE_SVG =
  '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/>';

function dangerRadarIcon(status, severity) {
  const color = status === "green" ? "#16a34a" : "#dc2626";
  const sevColor = SEVERITY_COLORS[severity] || "#f59e0b";
  return L.divIcon({
    className: "accident-marker-wrap",
    html: `<div class="accident-marker" style="--radar-color:${color}">
             <div class="radar-ring"></div>
             <div class="radar-core"></div>
             <div class="danger-icon" style="--severity-color:${sevColor}">
               <svg viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${ALERT_TRIANGLE_SVG}</svg>
             </div>
           </div>`,
    iconSize: [30, 30],
    iconAnchor: [15, 15],
  });
}

// Derive reachability status against the current threshold from the precomputed candidate list.
function evaluate(feature) {
  const candidates = feature.candidates || [];
  if (!candidates.length) {
    return { status: "red", nearest: null };
  }
  const qualifying = candidates.filter((c) => c.road_km <= THRESHOLD_KM);
  if (qualifying.length) {
    return { status: "green", nearest: qualifying[0] }; // candidates pre-sorted ascending by road_km
  }
  return { status: "red", nearest: candidates[0] };
}

function showDetails(feature) {
  lastSelected = feature;
  const panel = document.getElementById("feature-details");
  panel.classList.remove("empty");
  const { status, nearest } = evaluate(feature);
  const label = CONFIG.facilityLabel || "Facility";
  const statusLabel = status === "green"
    ? `<span style="color:#16a34a">Reachable</span> &mdash; ${label.toLowerCase()} within ${THRESHOLD_KM} km by road`
    : `<span style="color:#dc2626">Unreachable</span> &mdash; no ${label.toLowerCase()} within ${THRESHOLD_KM} km by road`;

  let hospHtml = `No ${label.toLowerCase()} candidates found nearby.`;
  if (nearest) {
    hospHtml = `${nearest.name || "Unnamed"} ${nearest.type ? "(" + nearest.type + ")" : ""}<br/>
                ${nearest.district_name}, road distance: <b>${nearest.road_km} km</b>`;
  }

  panel.innerHTML = `
    <div class="detail-title">${feature.accident_id_sp}</div>
    <div class="detail-type">${feature.severity}</div>
    <dl>
      <dt>District / Station</dt><dd>${feature.district_name} &middot; ${feature.station_name}</dd>
      <dt>Status</dt><dd>${statusLabel}</dd>
      <dt>Nearest ${label.toLowerCase()}</dt><dd>${hospHtml}</dd>
      <dt>Candidates precomputed</dt><dd>${(feature.candidates || []).length}</dd>
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

  let shownCount = 0;
  let greenCount = 0;
  let redCount = 0;

  accidentData.forEach((f) => {
    const { status } = evaluate(f);
    if (status === "green") greenCount += 1;
    else redCount += 1;

    if (!showAccidents) return;
    if (status === "green" && !showGreen) return;
    if (status === "red" && !showRed) return;

    const latlng = [f.latitude, f.longitude];
    const marker = L.marker(latlng, { icon: dangerRadarIcon(status, f.severity) });
    marker.on("click", () => showDetails(f));
    accidentLayer.addLayer(marker);
    shownCount += 1;

    if (showRadius) {
      L.circle(latlng, {
        radius: THRESHOLD_KM * 1000,
        color: status === "green" ? "#16a34a" : "#dc2626",
        weight: 1,
        fillOpacity: 0.03,
        dashArray: "4 6",
      }).addTo(radiusLayer);
    }
  });

  document.getElementById("count-accidents").textContent = String(shownCount);
  document.getElementById("stat-total").textContent = String(accidentData.length);
  document.getElementById("stat-green").textContent = String(greenCount);
  document.getElementById("stat-red").textContent = String(redCount);

  if (lastSelected) showDetails(lastSelected);
}

function facilityBadgeIcon() {
  const color = CONFIG.facilityColor || "#0d9488";
  const inner = CONFIG.facilityIconSvg || "";
  return L.divIcon({
    className: "facility-badge-wrap",
    html: `<div class="facility-badge" style="--badge-color:${color}">
             <svg viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>
           </div>`,
    iconSize: [24, 24],
    iconAnchor: [12, 12],
    popupAnchor: [0, -12],
  });
}

async function loadFacilities() {
  const enabled = document.getElementById("layer-facilities").checked;
  facilityLayer.clearLayers();
  if (!enabled || !CONFIG.facilityLayerUrl) {
    document.getElementById("count-facilities").textContent = "0";
    return;
  }
  const response = await fetch(CONFIG.facilityLayerUrl);
  const data = await response.json();
  const icon = facilityBadgeIcon();
  const layer = L.geoJSON(data, {
    pointToLayer: (feature, latlng) =>
      L.marker(latlng, { icon }).bindPopup(
        `<b>${feature.properties.hospital_name || feature.properties.vehicle_no || feature.properties.blood_centre_name || CONFIG.facilityLabel}</b><br/>${feature.properties.hosp_type || feature.properties.vehicle_type || ""}<br/>${feature.properties.district_name || ""}`
      ),
  });
  facilityLayer.addLayer(layer);
  document.getElementById("count-facilities").textContent = data.properties?.count || data.features?.length || 0;
}

function renderSeverityLegend() {
  const el = document.getElementById("severity-legend");
  if (!el) return;
  el.innerHTML = Object.entries(SEVERITY_COLORS)
    .map(
      ([label, color]) =>
        `<div class="row"><span class="swatch-sm" style="background:${color}"></span>${label}</div>`
    )
    .join("");
}

// Builds the legend's facility preview from the exact same CONFIG.facilityColor /
// facilityIconSvg the real map markers use (facilityBadgeIcon above), so the legend
// can never drift out of sync with what's actually drawn on the map.
function renderFacilityLegendBadge() {
  const el = document.getElementById("facility-legend-badge");
  if (!el) return;
  const color = CONFIG.facilityColor || "#0d9488";
  const inner = CONFIG.facilityIconSvg || "";
  el.innerHTML = `<span class="legend-facility-badge" style="--badge-color:${color}">
    <svg viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>
  </span>`;
}

function setThreshold(km, { silent = false } = {}) {
  const clamped = Math.max(MIN_THRESHOLD_KM, Math.min(MAX_THRESHOLD_KM, Math.round(km)));
  THRESHOLD_KM = clamped;

  const slider = document.getElementById("threshold-slider");
  const number = document.getElementById("threshold-number");
  if (slider && Number(slider.value) !== clamped) slider.value = String(clamped);
  if (number && Number(number.value) !== clamped) number.value = String(clamped);

  document.querySelectorAll(".threshold-presets button").forEach((btn) => {
    btn.classList.toggle("active", Number(btn.dataset.km) === clamped);
  });

  document.querySelectorAll(".threshold-live").forEach((el) => {
    el.textContent = String(clamped);
  });
  const statThreshold = document.getElementById("stat-threshold");
  if (statThreshold) statThreshold.textContent = `${clamped} km`;

  if (!silent) renderAccidents();
}

function initThresholdControl() {
  const slider = document.getElementById("threshold-slider");
  const number = document.getElementById("threshold-number");
  if (!slider || !number) return;

  slider.min = String(MIN_THRESHOLD_KM);
  slider.max = String(MAX_THRESHOLD_KM);
  slider.value = String(THRESHOLD_KM);
  number.min = String(MIN_THRESHOLD_KM);
  number.max = String(MAX_THRESHOLD_KM);
  number.value = String(THRESHOLD_KM);

  slider.addEventListener("input", () => setThreshold(Number(slider.value)));
  number.addEventListener("change", () => setThreshold(Number(number.value)));
  number.addEventListener("input", () => {
    if (number.value !== "") setThreshold(Number(number.value));
  });

  // Mouse-wheel scroll over the slider nudges it up/down.
  slider.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      setThreshold(THRESHOLD_KM + (e.deltaY < 0 ? 1 : -1));
    },
    { passive: false }
  );

  document.querySelectorAll(".threshold-presets button").forEach((btn) => {
    btn.addEventListener("click", () => setThreshold(Number(btn.dataset.km)));
  });
}

async function init() {
  renderSeverityLegend();
  renderFacilityLegendBadge();
  setStatus(`Loading accident/${(CONFIG.facilityLabel || "facility").toLowerCase()} analysis...`);

  if (CONFIG.statLabels) {
    const greenLabel = document.querySelector("#stat-green")?.parentElement?.querySelector(".stat-label");
    const redLabel = document.querySelector("#stat-red")?.parentElement?.querySelector(".stat-label");
    if (greenLabel && CONFIG.statLabels.green) greenLabel.textContent = CONFIG.statLabels.green;
    if (redLabel && CONFIG.statLabels.red) redLabel.textContent = CONFIG.statLabels.red;
  }

  try {
    const response = await fetch(CONFIG.dataUrl);
    const data = await response.json();
    if (data.error && !(data.features && data.features.length)) {
      setStatus(data.error, true);
      return;
    }
    accidentData = data.features || [];
    MAX_THRESHOLD_KM = data.max_threshold_km || MAX_THRESHOLD_KM;
    THRESHOLD_KM = data.default_threshold_km || THRESHOLD_KM;

    initThresholdControl();

    if (accidentData.length) {
      const bounds = L.latLngBounds(accidentData.map((f) => [f.latitude, f.longitude]));
      map.fitBounds(bounds, { padding: [40, 40] });
    }

    renderAccidents();
    setStatus(`${accidentData.length} accidents analyzed against real Haryana ${(CONFIG.facilityLabel || "facility").toLowerCase()} locations (OSRM road-route distance). Drag the threshold to re-evaluate instantly.`);

    fetch("/api/pipeline/status")
      .then((r) => r.json())
      .then((status) => {
        if (status.state === "running") {
          setStatus(`A dataset recompute is in progress — this view may show stale results until it finishes. (Check the Data panel on Boundaries & Facilities.)`, true);
        }
      })
      .catch(() => {});
  } catch (err) {
    console.error(err);
    setStatus("Failed to load accident safety data.", true);
  }
}

document.getElementById("layer-accidents").addEventListener("change", renderAccidents);
document.getElementById("layer-radius").addEventListener("change", renderAccidents);
document.getElementById("filter-green").addEventListener("change", renderAccidents);
document.getElementById("filter-red").addEventListener("change", renderAccidents);
document.getElementById("layer-facilities").addEventListener("change", loadFacilities);

init().catch((err) => {
  console.error(err);
  setStatus("Failed to initialize map.", true);
});
