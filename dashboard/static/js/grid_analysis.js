// Grid Analysis view: accidents AND 10km hex/circle grid cells, both evaluated
// against real road-route distance to the nearest hospital, for one selected
// district at a time. Shares the same adjustable-threshold pattern as the
// other reach views (reach_view.js) but is self-contained since it drives
// two different feature types (points + polygons) off two different endpoints.

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

const DISTRICT_ALIASES = {
  MEWAT: "NUH",
  HISSAR: "HISAR",
  SONEPAT: "SONIPAT",
  NARNAUL: "MAHENDRAGARH",
  "N U H": "NUH",
  JAGADHRI: "YAMUNANAGAR",
  "YAMUNA NAGAR": "YAMUNANAGAR",
};

const ALERT_TRIANGLE_SVG =
  '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/>';
const HOSPITAL_SVG = '<rect x="3.5" y="3.5" width="17" height="17" rx="2.5"/><path d="M12 7.5v9M7.5 12h9"/>';

let allAccidents = [];
let districtAccidents = [];
let gridFeatures = [];
let selected = null; // { kind: "accident"|"cell", data }

const gridLayer = L.layerGroup().addTo(map);
const centroidLayer = L.layerGroup().addTo(map);
const accidentLayer = L.layerGroup().addTo(map);
const facilityLayer = L.layerGroup().addTo(map);

function formatCoord(value) {
  return typeof value === "number" ? value.toFixed(5) : "—";
}

function setStatus(message, isError = false) {
  const el = document.getElementById("status-line");
  el.textContent = message;
  el.classList.toggle("error", isError);
}

function titleCase(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function normDistrict(name) {
  let n = String(name || "").trim().toUpperCase();
  n = n.replace("YAMUNA NAGAR", "YAMUNANAGAR");
  return DISTRICT_ALIASES[n] || n;
}

function evaluateCandidates(candidates) {
  const list = candidates || [];
  if (!list.length) return { status: "red", nearest: null };
  const qualifying = list.filter((c) => c.road_km <= THRESHOLD_KM);
  if (qualifying.length) return { status: "green", nearest: qualifying[0] };
  return { status: "red", nearest: list[0] };
}

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

function facilityBadgeIcon() {
  return L.divIcon({
    className: "facility-badge-wrap",
    html: `<div class="facility-badge" style="--badge-color:#0d9488">
             <svg viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${HOSPITAL_SVG}</svg>
           </div>`,
    iconSize: [24, 24],
    iconAnchor: [12, 12],
    popupAnchor: [0, -12],
  });
}

function renderSeverityLegend() {
  const el = document.getElementById("severity-legend");
  if (!el) return;
  el.innerHTML = Object.entries(SEVERITY_COLORS)
    .map(([label, color]) => `<div class="row"><span class="swatch-sm" style="background:${color}"></span>${label}</div>`)
    .join("");
}

function renderFacilityLegendBadge() {
  const el = document.getElementById("facility-legend-badge");
  if (!el) return;
  el.innerHTML = `<span class="legend-facility-badge" style="--badge-color:#0d9488">
    <svg viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${HOSPITAL_SVG}</svg>
  </span>`;
}

function showAccidentDetails(f) {
  selected = { kind: "accident", data: f };
  const panel = document.getElementById("feature-details");
  panel.classList.remove("empty");
  const { status, nearest } = evaluateCandidates(f.candidates);
  const statusLabel =
    status === "green"
      ? `<span style="color:#16a34a">Reachable</span> &mdash; hospital within ${THRESHOLD_KM} km by road`
      : `<span style="color:#dc2626">Unreachable</span> &mdash; no hospital within ${THRESHOLD_KM} km by road`;
  let hospHtml = "No hospital candidates found nearby.";
  if (nearest) {
    hospHtml = `${nearest.name || "Unnamed"} ${nearest.type ? "(" + nearest.type + ")" : ""}<br/>${nearest.district_name}, road distance: <b>${nearest.road_km} km</b>`;
  }
  panel.innerHTML = `
    <div class="detail-title">${f.accident_id_sp}</div>
    <div class="detail-type">Accident &middot; ${f.severity}</div>
    <dl>
      <dt>District / Station</dt><dd>${f.district_name} &middot; ${f.station_name}</dd>
      <dt>Status</dt><dd>${statusLabel}</dd>
      <dt>Nearest hospital</dt><dd>${hospHtml}</dd>
      <dt>Candidates precomputed</dt><dd>${(f.candidates || []).length}</dd>
    </dl>
  `;
}

function showCellDetails(feature, status) {
  selected = { kind: "cell", data: feature };
  const panel = document.getElementById("feature-details");
  panel.classList.remove("empty");
  const props = feature.properties || {};
  const { nearest } = evaluateCandidates(props.candidates);
  const statusLabel =
    status === "green"
      ? `<span style="color:#16a34a">Reachable</span> &mdash; hospital within ${THRESHOLD_KM} km by road`
      : `<span style="color:#dc2626">Unreachable</span> &mdash; no hospital within ${THRESHOLD_KM} km by road`;
  let hospHtml = "No hospital candidates found nearby.";
  if (nearest) {
    hospHtml = `${nearest.name || "Unnamed"} ${nearest.type ? "(" + nearest.type + ")" : ""}<br/>${nearest.district_name}, road distance: <b>${nearest.road_km} km</b>`;
  }
  panel.innerHTML = `
    <div class="detail-title">Grid cell</div>
    <div class="detail-type">${props.grid_type === "circle" ? "Circle" : "Hexagon"} &middot; ${props.cell_diameter_m ? (props.cell_diameter_m / 1000).toFixed(0) : 10} km diameter</div>
    <dl>
      <dt>District</dt><dd>${props.DISTRICT || ""}</dd>
      <dt>Centroid (lat, lon)</dt><dd>${formatCoord(props.centroid_lat)}, ${formatCoord(props.centroid_lon)}</dd>
      <dt>Status</dt><dd>${statusLabel}</dd>
      <dt>Nearest hospital (from centroid)</dt><dd>${hospHtml}</dd>
      <dt>Candidates precomputed</dt><dd>${(props.candidates || []).length}</dd>
    </dl>
  `;
}

function renderGrid() {
  gridLayer.clearLayers();
  const show = document.getElementById("layer-grid").checked;
  const onlyUnreachable = document.getElementById("only-unreachable").checked;

  let redCount = 0;
  gridFeatures.forEach((f) => {
    const { status } = evaluateCandidates((f.properties || {}).candidates);
    if (status === "red") redCount += 1;
    if (!show) return;
    if (onlyUnreachable && status === "green") return;

    const layer = L.geoJSON(f, {
      style: {
        color: status === "green" ? "#16a34a" : "#dc2626",
        weight: 1.3,
        fillColor: status === "green" ? "#16a34a" : "#dc2626",
        fillOpacity: status === "green" ? 0.16 : 0.34,
      },
    });
    layer.eachLayer((cellLayer) => {
      cellLayer.on("click", (e) => {
        L.DomEvent.stopPropagation(e);
        showCellDetails(f, status);
      });
    });
    gridLayer.addLayer(layer);
  });

  document.getElementById("stat-cells-total").textContent = String(gridFeatures.length);
  document.getElementById("stat-cells-red").textContent = String(redCount);
  document.getElementById("count-grid").textContent = String(show ? gridFeatures.length : 0);
}

function renderCentroids() {
  centroidLayer.clearLayers();
  const show = document.getElementById("layer-centroids").checked;
  if (!show) {
    document.getElementById("count-centroids").textContent = "0";
    return;
  }

  const onlyUnreachable = document.getElementById("only-unreachable").checked;
  let plotted = 0;
  gridFeatures.forEach((f) => {
    const props = f.properties || {};
    if (typeof props.centroid_lat !== "number" || typeof props.centroid_lon !== "number") return;
    const { status } = evaluateCandidates(props.candidates);
    if (onlyUnreachable && status === "green") return;

    const marker = L.circleMarker([props.centroid_lat, props.centroid_lon], {
      radius: 4,
      color: "#ffffff",
      weight: 1.5,
      fillColor: "#16324f",
      fillOpacity: 0.95,
    });
    marker.bindTooltip(
      `${formatCoord(props.centroid_lat)}, ${formatCoord(props.centroid_lon)}`,
      { direction: "top", offset: [0, -4], className: "centroid-tip" }
    );
    marker.on("click", (e) => {
      L.DomEvent.stopPropagation(e);
      showCellDetails(f, status);
    });
    centroidLayer.addLayer(marker);
    plotted += 1;
  });

  document.getElementById("count-centroids").textContent = String(plotted);
}

function renderAccidents() {
  accidentLayer.clearLayers();
  const show = document.getElementById("layer-accidents").checked;

  let redCount = 0;
  districtAccidents.forEach((f) => {
    const { status } = evaluateCandidates(f.candidates);
    if (status === "red") redCount += 1;
    if (!show) return;

    const marker = L.marker([f.latitude, f.longitude], { icon: dangerRadarIcon(status, f.severity) });
    marker.on("click", () => showAccidentDetails(f));
    accidentLayer.addLayer(marker);
  });

  document.getElementById("stat-accidents-total").textContent = String(districtAccidents.length);
  document.getElementById("stat-accidents-red").textContent = String(redCount);
  document.getElementById("count-accidents").textContent = String(show ? districtAccidents.length : 0);
}

async function loadFacilities() {
  const enabled = document.getElementById("layer-facilities").checked;
  facilityLayer.clearLayers();
  if (!enabled) {
    document.getElementById("count-facilities").textContent = "0";
    return;
  }
  const response = await fetch("/api/geolocations/hospitals?state=Haryana");
  const data = await response.json();
  const icon = facilityBadgeIcon();
  const layer = L.geoJSON(data, {
    pointToLayer: (feature, latlng) =>
      L.marker(latlng, { icon }).bindPopup(
        `<b>${feature.properties.hospital_name || "Hospital"}</b><br/>${feature.properties.hosp_type || ""}<br/>${feature.properties.district_name || ""}`
      ),
  });
  facilityLayer.addLayer(layer);
  document.getElementById("count-facilities").textContent = data.properties?.count || data.features?.length || 0;
}

function renderAll() {
  renderGrid();
  renderCentroids();
  renderAccidents();
  if (selected) {
    if (selected.kind === "accident") showAccidentDetails(selected.data);
    else showCellDetails(selected.data, evaluateCandidates((selected.data.properties || {}).candidates).status);
  }
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

  if (!silent) renderAll();
}

function initThresholdControl() {
  const slider = document.getElementById("threshold-slider");
  const number = document.getElementById("threshold-number");
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

function getGridType() {
  return document.querySelector('input[name="grid-type"]:checked')?.value || "hex";
}

function fitToSelection() {
  const bounds = [];
  gridFeatures.forEach((f) => {
    try {
      bounds.push(L.geoJSON(f).getBounds());
    } catch (e) {
      /* ignore malformed geometry */
    }
  });
  districtAccidents.forEach((f) => bounds.push(L.latLngBounds([f.latitude, f.longitude], [f.latitude, f.longitude])));

  if (!bounds.length) return;
  let combined = bounds[0];
  bounds.slice(1).forEach((b) => (combined = combined.extend(b)));
  map.fitBounds(combined, { padding: [40, 40], maxZoom: 12 });
}

async function loadGridAnalysis() {
  const district = document.getElementById("district-select").value;
  const gridType = getGridType();
  selected = null;
  document.getElementById("feature-details").classList.add("empty");
  document.getElementById("feature-details").textContent = "Click a grid cell or accident marker to see details.";

  if (!district) {
    gridFeatures = [];
    districtAccidents = [];
    renderAll();
    setStatus("Select a district to run the analysis.");
    document.getElementById("compute-note").style.display = "none";
    return;
  }

  districtAccidents = allAccidents.filter((f) => normDistrict(f.district_name) === normDistrict(district));

  setStatus(`Loading ${gridType} grid ↔ hospital analysis for ${titleCase(district)}… first run per district can take up to a minute.`);
  document.getElementById("compute-note").style.display = "block";

  try {
    const params = new URLSearchParams({ grid_type: gridType, district });
    const response = await fetch(`/api/grid-reach?${params.toString()}`);
    const data = await response.json();
    document.getElementById("compute-note").style.display = "none";

    if (!response.ok) {
      gridFeatures = [];
      renderAll();
      setStatus(data.error || "Failed to load grid analysis.", true);
      return;
    }

    gridFeatures = data.features || [];
    MAX_THRESHOLD_KM = data.max_threshold_km || MAX_THRESHOLD_KM;
    if (THRESHOLD_KM > MAX_THRESHOLD_KM) THRESHOLD_KM = data.default_threshold_km || 50;
    document.getElementById("threshold-slider").max = String(MAX_THRESHOLD_KM);
    document.getElementById("threshold-number").max = String(MAX_THRESHOLD_KM);

    renderAll();
    fitToSelection();

    if (!gridFeatures.length) {
      setStatus(`No ${gridType} grid cells found for ${titleCase(district)} yet — try the other grid type.`, true);
    } else {
      setStatus(
        `${gridFeatures.length} ${gridType} cells and ${districtAccidents.length} accidents analyzed for ${titleCase(district)} against real hospital locations (OSRM road-route distance).`
      );
    }
  } catch (err) {
    console.error(err);
    document.getElementById("compute-note").style.display = "none";
    setStatus("Failed to load grid analysis.", true);
  }
}

async function populateDistricts() {
  const select = document.getElementById("district-select");
  const summary = await fetch("/api/summary").then((r) => r.json());

  const key = Object.keys(summary.districts_by_state || {}).find((k) => k.toLowerCase() === "haryana");
  let rows = key ? summary.districts_by_state[key] : [];
  if (!rows.length) {
    rows = (summary.districts || []).filter((d) => String(d.state || "").toLowerCase().includes("haryana"));
  }
  rows = [...rows].sort((a, b) => a.district.localeCompare(b.district));

  rows.forEach((row) => {
    const option = document.createElement("option");
    option.value = row.district;
    option.textContent = titleCase(row.district);
    select.appendChild(option);
  });
}

async function init() {
  renderSeverityLegend();
  renderFacilityLegendBadge();
  initThresholdControl();

  setStatus("Loading accident data…");
  try {
    const accData = await fetch("/api/accident-safety").then((r) => r.json());
    allAccidents = accData.features || [];
  } catch (err) {
    console.error(err);
  }

  await populateDistricts();
  setStatus("Select a district to run the analysis.");

  document.getElementById("district-select").addEventListener("change", loadGridAnalysis);
  document.querySelectorAll('input[name="grid-type"]').forEach((input) => {
    input.addEventListener("change", () => {
      if (document.getElementById("district-select").value) loadGridAnalysis();
    });
  });
  document.getElementById("layer-grid").addEventListener("change", renderGrid);
  document.getElementById("layer-centroids").addEventListener("change", renderCentroids);
  document.getElementById("only-unreachable").addEventListener("change", () => {
    renderGrid();
    renderCentroids();
  });
  document.getElementById("layer-accidents").addEventListener("change", renderAccidents);
  document.getElementById("layer-facilities").addEventListener("change", loadFacilities);
}

init().catch((err) => {
  console.error(err);
  setStatus("Failed to initialize map.", true);
});
