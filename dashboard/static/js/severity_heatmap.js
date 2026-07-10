const map = L.map("map", { zoomControl: false, preferCanvas: true }).setView([29.05, 76.4], 8);
initMapMeasure(map);

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 18,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
}).addTo(map);

L.control.zoom({ position: "topright" }).addTo(map);

const SEVERITY_WEIGHTS = {
  Fatal: 1.0,
  "Grievous Injury": 0.7,
  "Minor Injury Hospitalized": 0.5,
  "Minor Injury Non-Hospitalized": 0.3,
  "Non-Injury": 0.15,
};

const SEVERITY_COLORS = {
  Fatal: "#dc2626",
  "Grievous Injury": "#f97316",
  "Minor Injury Hospitalized": "#eab308",
  "Minor Injury Non-Hospitalized": "#84cc16",
  "Non-Injury": "#94a3b8",
};

// Cool-to-hot gradient tuned to read clearly against the light OSM basemap —
// the old purple start blended into a gray smudge at low density.
const HEAT_GRADIENT = {
  0.0: "#bae6fd",
  0.25: "#38bdf8",
  0.45: "#0d9488",
  0.65: "#eab308",
  0.85: "#f97316",
  1.0: "#dc2626",
};

const MIN_SPREAD = 10;
const MAX_SPREAD = 60;
let spreadPx = 30;

let accidents = [];
let heatLayer = null;
let pointLayer = L.layerGroup().addTo(map);
const activeSeverities = new Set(Object.keys(SEVERITY_WEIGHTS));

function setStatus(message, isError = false) {
  const el = document.getElementById("status-line");
  el.textContent = message;
  el.classList.toggle("error", isError);
}

function renderSeverityFilters() {
  const el = document.getElementById("severity-filters");
  el.innerHTML = Object.keys(SEVERITY_WEIGHTS)
    .map(
      (sev) => `
      <label class="toggle">
        <input type="checkbox" class="sev-filter" data-sev="${sev}" checked />
        <span><i class="dot" style="background:${SEVERITY_COLORS[sev]};box-shadow:0 0 6px ${SEVERITY_COLORS[sev]}88"></i> ${sev}</span>
      </label>`
    )
    .join("");

  el.querySelectorAll(".sev-filter").forEach((cb) => {
    cb.addEventListener("change", () => {
      if (cb.checked) activeSeverities.add(cb.dataset.sev);
      else activeSeverities.delete(cb.dataset.sev);
      render();
    });
  });
}

function showDetails(f) {
  const panel = document.getElementById("feature-details");
  panel.classList.remove("empty");
  panel.innerHTML = `
    <div class="detail-title">${f.accident_id_sp}</div>
    <div class="detail-type">${f.severity}</div>
    <dl>
      <dt>District / Station</dt><dd>${f.district_name} &middot; ${f.station_name}</dd>
    </dl>
  `;
}

function setSpread(px, { silent = false } = {}) {
  spreadPx = Math.max(MIN_SPREAD, Math.min(MAX_SPREAD, Math.round(px)));

  const slider = document.getElementById("spread-slider");
  const number = document.getElementById("spread-number");
  if (slider && Number(slider.value) !== spreadPx) slider.value = String(spreadPx);
  if (number && Number(number.value) !== spreadPx) number.value = String(spreadPx);

  document.querySelectorAll(".threshold-presets button").forEach((btn) => {
    btn.classList.toggle("active", Number(btn.dataset.px) === spreadPx);
  });

  if (!silent) render();
}

function render() {
  const filtered = accidents.filter((f) => activeSeverities.has(f.severity));
  const weightBySeverity = document.getElementById("weight-severity").checked;
  const showPoints = document.getElementById("show-points").checked;

  if (heatLayer) map.removeLayer(heatLayer);
  const heatPoints = filtered.map((f) => [
    f.latitude,
    f.longitude,
    weightBySeverity ? SEVERITY_WEIGHTS[f.severity] ?? 0.3 : 0.5,
  ]);
  heatLayer = L.heatLayer(heatPoints, {
    radius: spreadPx,
    blur: Math.round(spreadPx * 0.75),
    maxZoom: 12,
    minOpacity: 0.3,
    gradient: HEAT_GRADIENT,
  }).addTo(map);

  pointLayer.clearLayers();
  if (showPoints) {
    filtered.forEach((f) => {
      const marker = L.circleMarker([f.latitude, f.longitude], {
        radius: 5,
        color: "#fff",
        weight: 1,
        fillColor: SEVERITY_COLORS[f.severity] || "#94a3b8",
        fillOpacity: 0.9,
      });
      marker.on("click", () => showDetails(f));
      pointLayer.addLayer(marker);
    });
  }

  document.getElementById("stat-total").textContent = String(filtered.length);
  document.getElementById("stat-fatal").textContent = String(
    filtered.filter((f) => f.severity === "Fatal").length
  );
}

function initSpreadControl() {
  const slider = document.getElementById("spread-slider");
  const number = document.getElementById("spread-number");
  if (!slider || !number) return;

  slider.addEventListener("input", () => setSpread(Number(slider.value)));
  number.addEventListener("change", () => setSpread(Number(number.value)));
  number.addEventListener("input", () => {
    if (number.value !== "") setSpread(Number(number.value));
  });
  slider.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      setSpread(spreadPx + (e.deltaY < 0 ? 1 : -1));
    },
    { passive: false }
  );
  document.querySelectorAll(".threshold-presets button").forEach((btn) => {
    btn.addEventListener("click", () => setSpread(Number(btn.dataset.px)));
  });
}

async function init() {
  renderSeverityFilters();
  initSpreadControl();
  setStatus("Loading accidents...");
  try {
    const response = await fetch("/api/accidents");
    const data = await response.json();
    if (data.error) {
      setStatus(data.error, true);
      return;
    }
    accidents = data.features || [];
    setStatus(`${accidents.length} accidents loaded.`);
    if (accidents.length) {
      const bounds = L.latLngBounds(accidents.map((f) => [f.latitude, f.longitude]));
      map.fitBounds(bounds, { padding: [40, 40] });
    }
    render();
  } catch (err) {
    console.error(err);
    setStatus("Failed to load accident data.", true);
  }
}

document.getElementById("weight-severity").addEventListener("change", render);
document.getElementById("show-points").addEventListener("change", render);

init();
