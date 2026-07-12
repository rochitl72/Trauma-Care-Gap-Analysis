const map = L.map("map", { zoomControl: false, preferCanvas: true }).setView([22.5, 79], 5);
initMapMeasure(map);

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 18,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
}).addTo(map);

L.control.zoom({ position: "topright" }).addTo(map);

let stateLayer = null;
let districtLayer = null;
let stateLabelLayer = null;
let districtLabelLayer = null;
let radarLayer = null;
let radarLoadToken = 0;
let ambulanceLayer = null;
let bloodbankLayer = null;
let hospitalLayer = null;
let geoLoadToken = 0;
let geoDataAvailable = false;
let allStates = [];
let allDistricts = [];
let districtsByState = {};
let districtIndex = new Map();
let stateIndex = new Map();
let summaryData = null;
let highlightedLayer = null;

const FIELD_LABELS = {
  STATE: "State / UT",
  STATE_UT: "State / UT",
  DISTRICT: "District",
  iradSTcode: "IRAD state code",
  iradSTname: "IRAD state name",
  IRAD_ST_CODE: "IRAD state code",
  IRAD_ST_NAME: "IRAD state name",
  IRAD_DT_CODE: "IRAD district code",
  IRAD_DT_NAME: "IRAD district name",
  Dist_LGD: "LGD district code",
  STATE_LGD: "LGD state code",
  Shape_Leng: "Perimeter",
  Shape_Area: "Area",
  OBJECTID: "Object ID",
  grid_type: "Grid type",
  cell_id: "Cell ID",
  cell_radius_m: "Cell radius (m)",
  cell_diameter_m: "Cell diameter (m)",
  district_name: "District",
  vehicle_no: "Vehicle number",
  vehicle_make: "Vehicle make",
  vehicle_type: "Vehicle type",
  stationed_at: "Stationed at",
  health_facility_name: "Health facility",
  blood_centre_name: "Blood centre",
  blood_centre_address: "Address",
  hospital_name: "Hospital",
  hosp_type: "Hospital type",
  layer: "Layer",
};

// Hospital types withheld from the map. Kept in sync with db.EXCLUDED_HOSP_TYPES
// on the backend (which is the primary filter); this is a defensive fallback.
const EXCLUDED_HOSP_TYPES = new Set(["Empanelled Private Hospital"]);

const stateStyle = {
  color: "#22c55e",
  weight: 2,
  fillColor: "#22c55e",
  fillOpacity: 0.14,
};

const districtStyle = {
  color: "#f59e0b",
  weight: 1,
  fillColor: "#f59e0b",
  fillOpacity: 0.1,
};

const highlightStyle = {
  color: "#3b82f6",
  weight: 3,
  fillColor: "#3b82f6",
  fillOpacity: 0.28,
};

const hiddenStyle = {
  opacity: 0,
  fillOpacity: 0,
  weight: 0,
};

const hexRadarStyle = {
  color: "#a78bfa",
  weight: 1,
  fillColor: "#8b5cf6",
  fillOpacity: 0.22,
};

const circleRadarStyle = {
  color: "#38bdf8",
  weight: 1,
  fillColor: "#0ea5e9",
  fillOpacity: 0.2,
};

const roadRadarStyle = {
  color: "#f87171",
  weight: 1.5,
  fillColor: "#ef4444",
  fillOpacity: 0.18,
};

// One badge icon per facility category — matches the reach-view pages. Subtype
// (vehicle_type, hosp_type, etc.) is no longer color-coded on the map; it shows
// up in the click details panel via formatProps() instead, same as any other
// property.
const HOSPITAL_ICON_SVG = '<rect x="3.5" y="3.5" width="17" height="17" rx="2.5"/><path d="M12 7.5v9M7.5 12h9"/>';
const AMBULANCE_ICON_SVG =
  '<path d="M3 13.5l1.3-4.2A2 2 0 0 1 6.2 8H15l3 4h1.5a1 1 0 0 1 1 1v3.5a1 1 0 0 1-1 1H19"/><path d="M3 13.5V17a1 1 0 0 0 1 1h1.5"/><circle cx="7.5" cy="18" r="1.8"/><circle cx="17" cy="18" r="1.8"/><path d="M9 10.5v3M7.5 12h3"/>';
const BLOODBANK_ICON_SVG = '<path d="M12 3.5s6 6.8 6 11a6 6 0 0 1-12 0c0-4.2 6-11 6-11z"/>';

function facilityBadgeIcon(color, svgInner) {
  return L.divIcon({
    className: "facility-badge-wrap",
    html: `<div class="facility-badge" style="--badge-color:${color}">
             <svg viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${svgInner}</svg>
           </div>`,
    iconSize: [24, 24],
    iconAnchor: [12, 12],
    popupAnchor: [0, -12],
  });
}

const HOSPITAL_BADGE = facilityBadgeIcon("#0d9488", HOSPITAL_ICON_SVG);
const AMBULANCE_BADGE = facilityBadgeIcon("#2563eb", AMBULANCE_ICON_SVG);
const BLOODBANK_BADGE = facilityBadgeIcon("#b91c1c", BLOODBANK_ICON_SVG);

// Legend previews reuse the exact same color + SVG as the real map badges above,
// so the legend can't drift out of sync with what's actually drawn on the map.
function renderFacilityLegendBadges() {
  const targets = [
    ["legend-badge-hospital", "#0d9488", HOSPITAL_ICON_SVG],
    ["legend-badge-ambulance", "#2563eb", AMBULANCE_ICON_SVG],
    ["legend-badge-bloodbank", "#b91c1c", BLOODBANK_ICON_SVG],
  ];
  targets.forEach(([id, color, svgInner]) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.innerHTML = `<span class="legend-facility-badge" style="--badge-color:${color}">
      <svg viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${svgInner}</svg>
    </span>`;
  });
}

function isHaryanaFilter(stateName) {
  if (!stateName) return true;
  return stateName.toLowerCase().includes("haryana");
}

function setGeoStatus(message, isError = false) {
  const el = document.getElementById("geo-status");
  if (!el) return;
  el.textContent = message;
  el.classList.toggle("error", isError);
}

function bindPointFeature(layer, label) {
  layer.on("click", (e) => {
    L.DomEvent.stopPropagation(e);
    showDetails(layer, label);
  });
}

async function loadGeoLayer(layerName, layerGroup, icon, label) {
  const filters = getFilters();
  const params = new URLSearchParams();
  if (filters.state) params.set("state", filters.state);
  if (filters.district) params.set("district", filters.district);

  const response = await fetch(`/api/geolocations/${layerName}?${params.toString()}`);
  const data = await response.json();

  // Defensive second layer: the backend already withholds these hospital types
  // (db.EXCLUDED_HOSP_TYPES), but drop them here too so they can never reach the
  // map even if the API is ever changed to return them.
  if (layerName === "hospitals" && Array.isArray(data.features)) {
    data.features = data.features.filter(
      (f) => !EXCLUDED_HOSP_TYPES.has((f.properties || {}).hosp_type)
    );
  }

  layerGroup.clearLayers();

  const layer = L.geoJSON(data, {
    pointToLayer: (feature, latlng) => {
      const marker = L.marker(latlng, { icon });
      bindPointFeature(marker, label);
      return marker;
    },
  });
  layerGroup.addLayer(layer);
  return data.properties?.count || data.features?.length || 0;
}

async function loadGeoLayers() {
  const token = ++geoLoadToken;
  if (!geoDataAvailable) {
    setGeoStatus("Geolocation data not loaded — run start.sh to import geolocations.sql");
    return;
  }

  const showAmbulance = document.getElementById("layer-ambulance").checked;
  const showBlood = document.getElementById("layer-bloodbanks").checked;
  const showHosp = document.getElementById("layer-hospitals").checked;
  const filters = getFilters();

  if (!showAmbulance && !showBlood && !showHosp) {
    ambulanceLayer.clearLayers();
    bloodbankLayer.clearLayers();
    hospitalLayer.clearLayers();
    setGeoStatus("Haryana facility layers off");
    return;
  }

  if (!isHaryanaFilter(filters.state)) {
    ambulanceLayer.clearLayers();
    bloodbankLayer.clearLayers();
    hospitalLayer.clearLayers();
    setGeoStatus("Facility data is for Haryana only — select Haryana or clear state filter.", true);
    return;
  }

  setGeoStatus("Loading Haryana facilities...");

  try {
    const tasks = [];
    if (showAmbulance) {
      tasks.push(loadGeoLayer("ambulance", ambulanceLayer, AMBULANCE_BADGE, "Ambulance"));
    } else ambulanceLayer.clearLayers();

    if (showBlood) {
      tasks.push(loadGeoLayer("bloodbanks", bloodbankLayer, BLOODBANK_BADGE, "Blood bank"));
    } else bloodbankLayer.clearLayers();

    if (showHosp) {
      tasks.push(loadGeoLayer("hospitals", hospitalLayer, HOSPITAL_BADGE, "Hospital"));
    } else hospitalLayer.clearLayers();

    const counts = await Promise.all(tasks);
    if (token !== geoLoadToken) return;

    const names = [];
    let i = 0;
    if (showAmbulance) {
      const n = counts[i++];
      document.getElementById("count-ambulance").textContent = String(n);
      names.push(`${n} ambulances`);
    } else document.getElementById("count-ambulance").textContent = "0";

    if (showBlood) {
      const n = counts[i++];
      document.getElementById("count-bloodbanks").textContent = String(n);
      names.push(`${n} blood banks`);
    } else document.getElementById("count-bloodbanks").textContent = "0";

    if (showHosp) {
      const n = counts[i++];
      document.getElementById("count-hospitals").textContent = String(n);
      names.push(`${n} hospitals`);
    } else document.getElementById("count-hospitals").textContent = "0";

    setGeoStatus(`Showing ${names.join(" · ")}`);
  } catch (err) {
    if (token !== geoLoadToken) return;
    console.error(err);
    setGeoStatus("Failed to load facility markers.", true);
  }
}

function getRadarType() {
  return document.querySelector('input[name="radar-type"]:checked')?.value || "hex";
}

function setRadarStatus(message, isError = false) {
  const el = document.getElementById("radar-status");
  el.textContent = message;
  el.classList.toggle("error", isError);
}

function getSelectedIradCode(stateName) {
  if (!stateName || !summaryData) return null;
  const state = summaryData.states.find((s) => s.name === stateName);
  return state?.irad_code || null;
}

async function loadRadarGrid() {
  const enabled = document.getElementById("layer-radar").checked;
  const filters = getFilters();
  const gridType = getRadarType();
  const token = ++radarLoadToken;

  if (!enabled) {
    if (radarLayer) radarLayer.clearLayers();
    setRadarStatus("Radar grid off");
    return;
  }

  if (!filters.state && !filters.district) {
    setRadarStatus("Select a state or district to load radar grids.", true);
    document.getElementById("layer-radar").checked = false;
    return;
  }

  if (gridType === "road" && !filters.district) {
    setRadarStatus("Road 10 km grid needs a district selected (loads OSM roads).", true);
    document.getElementById("layer-radar").checked = false;
    return;
  }

  setRadarStatus(
    gridType === "road"
      ? `Loading road network grid for ${titleCase(filters.district)} (first load may take 1–2 min)...`
      : `Loading ${gridType} radar cells...`
  );

  const params = new URLSearchParams();
  if (filters.state) params.set("state", filters.state);
  if (filters.district) params.set("district", filters.district);
  const iradCode = getSelectedIradCode(filters.state);
  if (iradCode) params.set("irad_code", iradCode);

  try {
    const response = await fetch(`/api/grids/${gridType}?${params.toString()}`);
    const data = await response.json();
    if (token !== radarLoadToken) return;

    if (!response.ok) {
      setRadarStatus(data.error || "Failed to load radar grid.", true);
      return;
    }

    const style =
      gridType === "hex" ? hexRadarStyle : gridType === "circle" ? circleRadarStyle : roadRadarStyle;
    radarLayer.clearLayers();

    const layer = L.geoJSON(data, {
      style,
      onEachFeature: (feature, cellLayer) => {
        cellLayer.on("click", (e) => {
          L.DomEvent.stopPropagation(e);
          showDetails(cellLayer, gridType === "hex" ? "Hex cell" : gridType === "circle" ? "Circle cell" : "Road cell");
        });
      },
    });
    radarLayer.addLayer(layer);

    const meta = data.properties || {};
    const spacing = meta.spacing_km ? `${meta.spacing_km} km along roads` : `${meta.cell_diameter_km || 10} km diameter`;
    setRadarStatus(
      `${meta.cells || 0} ${gridType} cells across ${meta.districts || 0} district(s) · ${spacing}`
    );
  } catch (err) {
    if (token !== radarLoadToken) return;
    console.error(err);
    setRadarStatus("Failed to load radar grid.", true);
  }
}

function titleCase(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function normalize(value) {
  return String(value || "").trim().toLowerCase();
}

function getFilters() {
  return {
    state: document.getElementById("state-filter").value,
    district: document.getElementById("district-filter").value,
    search: document.getElementById("district-search").value.trim().toLowerCase(),
  };
}

function districtMatchesFilters(props, filters) {
  const stateCode = props.IRAD_ST_CODE || "";
  const stateName = props.STATE_UT || "";
  const districtName = props.DISTRICT || "";

  if (filters.state) {
    const selected = summaryData.states.find((s) => s.name === filters.state);
    const codeMatch = selected && stateCode === selected.irad_code;
    const nameMatch = stateName === filters.state;
    if (!codeMatch && !nameMatch) return false;
  }

  if (filters.district && districtName !== filters.district) return false;

  if (filters.search) {
    const haystack = [
      districtName,
      stateName,
      props.Dist_LGD,
      props.IRAD_DT_CODE,
      props.IRAD_DT_NAME,
      props.IRAD_ST_CODE,
      props.IRAD_ST_NAME,
    ]
      .map(normalize)
      .join(" ");
    if (!haystack.includes(filters.search)) return false;
  }

  return true;
}

function stateMatchesFilters(props, filters) {
  if (!filters.state && !filters.search && !filters.district) return true;
  if (filters.state) {
    const nameMatch = props.STATE === filters.state;
    const selected = summaryData.states.find((s) => s.name === filters.state);
    const codeMatch = selected && props.iradSTcode === selected.irad_code;
    return nameMatch || codeMatch;
  }
  if (filters.district || filters.search) {
    return allDistricts.some(
      (feature) =>
        districtMatchesFilters(feature.properties, filters) &&
        (feature.properties.IRAD_ST_CODE === props.iradSTcode ||
          feature.properties.STATE_UT === props.STATE)
    );
  }
  return true;
}

function formatProps(props, type) {
  const rows = Object.entries(props)
    .filter(([, value]) => value !== null && value !== "")
    .map(([key, value]) => {
      const label = FIELD_LABELS[key] || key;
      return `<dt>${label}</dt><dd>${value}</dd>`;
    })
    .join("");
  const title = type === "State" ? props.STATE || props.iradSTname : props.DISTRICT;
  return `<div class="detail-title">${titleCase(title)}</div><div class="detail-type">${type}</div><dl>${rows}</dl>`;
}

function showDetails(layer, type) {
  // Point markers (ambulance/hospital/blood bank badges) are L.Marker instances and
  // have no setStyle — only polygon layers (state/district/grid cells) get the
  // click highlight recolor.
  if (highlightedLayer && highlightedLayer !== layer && typeof highlightedLayer.setStyle === "function") {
    highlightedLayer.setStyle(highlightedLayer._baseStyle);
  }
  highlightedLayer = layer;
  if (typeof layer.setStyle === "function") {
    layer.setStyle(highlightStyle);
  }
  const panel = document.getElementById("feature-details");
  panel.classList.remove("empty");
  panel.innerHTML = formatProps(layer.feature.properties, type);
}

function makeLabel(text, className) {
  return L.marker([0, 0], {
    interactive: false,
    keyboard: false,
    icon: L.divIcon({
      className: `map-label ${className}`,
      html: `<span>${text}</span>`,
      iconSize: null,
    }),
  });
}

function bindLayer(layer, type) {
  layer._baseStyle = type === "State" ? { ...stateStyle } : { ...districtStyle };
  layer.on("click", (e) => {
    L.DomEvent.stopPropagation(e);
    showDetails(layer, type);
  });
  layer.on("mouseover", () => {
    if (highlightedLayer !== layer) {
      layer.setStyle({ ...layer._baseStyle, weight: layer._baseStyle.weight + 1, fillOpacity: 0.22 });
    }
  });
  layer.on("mouseout", () => {
    if (highlightedLayer !== layer) {
      layer.setStyle(layer._baseStyle);
    }
  });
}

function populateDistrictSelect(stateName) {
  const select = document.getElementById("district-filter");
  const current = select.value;
  select.innerHTML = '<option value="">All districts</option>';

  let rows = summaryData.districts;
  if (stateName) {
    const selected = summaryData.states.find((s) => s.name === stateName);
    rows =
      districtsByState[stateName] ||
      (selected
        ? summaryData.districts.filter((d) => d.irad_state_code === selected.irad_code)
        : summaryData.districts.filter((d) => normalize(d.state) === normalize(stateName)));
  }

  rows.forEach((row) => {
    const option = document.createElement("option");
    option.value = row.district;
    option.textContent = titleCase(row.district);
    select.appendChild(option);
  });

  select.disabled = rows.length === 0;
  if ([...select.options].some((opt) => opt.value === current)) {
    select.value = current;
  }
}

function renderFilterChips(filters) {
  const chips = [];
  if (filters.state) chips.push({ key: "state", label: `State: ${titleCase(filters.state)}` });
  if (filters.district) chips.push({ key: "district", label: `District: ${titleCase(filters.district)}` });
  if (filters.search) chips.push({ key: "search", label: `Search: ${filters.search}` });

  const container = document.getElementById("filter-chips");
  container.innerHTML = chips
    .map(
      (chip) =>
        `<button type="button" class="chip" data-key="${chip.key}">${chip.label}<span aria-hidden="true">×</span></button>`
    )
    .join("");

  container.querySelectorAll(".chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      const key = chip.dataset.key;
      if (key === "state") {
        document.getElementById("state-filter").value = "";
        populateDistrictSelect("");
      } else if (key === "district") {
        document.getElementById("district-filter").value = "";
      } else if (key === "search") {
        document.getElementById("district-search").value = "";
      }
      applyFilters();
    });
  });

  const active = document.getElementById("active-filters");
  active.textContent = chips.length ? `${chips.length} filter${chips.length > 1 ? "s" : ""} active` : "No filters active";
}

function updateDistrictTable(rows) {
  const tbody = document.getElementById("district-table");
  const limited = rows.slice(0, 250);
  document.getElementById("table-count").textContent = String(rows.length);

  tbody.innerHTML = limited
    .map(
      (row) =>
        `<tr data-district="${row.district}" data-state="${row.state}">
          <td>${titleCase(row.district)}</td>
          <td>${titleCase(row.state)}</td>
          <td>${row.lgd || "—"}</td>
          <td>${row.irad_district_code || "—"}</td>
        </tr>`
    )
    .join("");

  tbody.querySelectorAll("tr").forEach((tr) => {
    tr.addEventListener("click", () => {
      const key = `${tr.dataset.state}::${tr.dataset.district}`;
      const layer = districtIndex.get(key);
      if (layer) {
        showDetails(layer, "District");
        map.fitBounds(layer.getBounds(), { padding: [40, 40], maxZoom: 10 });
      }
    });
  });
}

function updateLabels() {
  const showStateLabels = document.getElementById("labels-states").checked;
  const showDistrictLabels = document.getElementById("labels-districts").checked;
  const zoom = map.getZoom();
  const filters = getFilters();

  stateLabelLayer.clearLayers();
  districtLabelLayer.clearLayers();

  if (showStateLabels && stateLayer) {
    stateLayer.eachLayer((layer) => {
      if (!stateMatchesFilters(layer.feature.properties, filters)) return;
      const name = layer.feature.properties.STATE;
      const label = makeLabel(titleCase(name), "state-label");
      label.setLatLng(layer.getBounds().getCenter());
      stateLabelLayer.addLayer(label);
    });
  }

  if (showDistrictLabels && districtLayer && zoom >= 7) {
    districtLayer.eachLayer((group) => {
      group.eachLayer((layer) => {
        const name = layer.feature.properties.DISTRICT;
        const label = makeLabel(titleCase(name), "district-label");
        label.setLatLng(layer.getBounds().getCenter());
        districtLabelLayer.addLayer(label);
      });
    });
  }
}

function applyFilters({ fit = true } = {}) {
  const filters = getFilters();
  districtIndex.clear();

  const filteredDistricts = allDistricts.filter((feature) => districtMatchesFilters(feature.properties, filters));

  districtLayer.clearLayers();
  filteredDistricts.forEach((feature) => {
    const layer = L.geoJSON(feature, { style: districtStyle });
    layer.eachLayer((l) => bindLayer(l, "District"));
    districtLayer.addLayer(layer);
    const key = `${feature.properties.STATE_UT}::${feature.properties.DISTRICT}`;
    districtIndex.set(key, layer.getLayers()[0]);
  });

  let visibleStates = 0;
  if (stateLayer) {
    stateLayer.eachLayer((layer) => {
      const visible = stateMatchesFilters(layer.feature.properties, filters);
      layer.setStyle(visible ? stateStyle : hiddenStyle);
      if (visible) visibleStates += 1;
    });
  }

  document.getElementById("visible-count").textContent = `${visibleStates} states · ${filteredDistricts.length} districts`;

  updateDistrictTable(
    filteredDistricts.map((f) => ({
      district: f.properties.DISTRICT,
      state: f.properties.STATE_UT,
      lgd: f.properties.Dist_LGD,
      irad_district_code: f.properties.IRAD_DT_CODE,
    }))
  );

  renderFilterChips(filters);
  updateLabels();
  loadRadarGrid();
  loadGeoLayers();

  if (fit) {
    if (filters.district && filteredDistricts.length === 1) {
      const layer = districtIndex.get(
        `${filteredDistricts[0].properties.STATE_UT}::${filteredDistricts[0].properties.DISTRICT}`
      );
      if (layer) map.fitBounds(layer.getBounds(), { padding: [40, 40], maxZoom: 11 });
    } else if (filteredDistricts.length > 0) {
      const group = L.featureGroup(districtLayer.getLayers());
      map.fitBounds(group.getBounds(), { padding: [30, 30], maxZoom: filters.state ? 8 : 5 });
    } else if (visibleStates > 0) {
      const visible = [];
      stateLayer.eachLayer((layer) => {
        if (stateMatchesFilters(layer.feature.properties, filters)) visible.push(layer);
      });
      if (visible.length) {
        map.fitBounds(L.featureGroup(visible).getBounds(), { padding: [30, 30], maxZoom: filters.state ? 7 : 5 });
      }
    }
  }
}

function clearFilters() {
  document.getElementById("state-filter").value = "";
  document.getElementById("district-filter").value = "";
  document.getElementById("district-search").value = "";
  populateDistrictSelect("");
  applyFilters();
}

async function init() {
  renderFacilityLegendBadges();
  summaryData = await fetch("/api/summary").then((r) => r.json());
  districtsByState = summaryData.districts_by_state;

  document.getElementById("state-count").textContent = summaryData.state_count;
  document.getElementById("district-count").textContent = summaryData.district_count;

  if (summaryData.geolocations?.available) {
    geoDataAvailable = true;
    document.getElementById("count-ambulance").textContent = summaryData.geolocations.ambulance;
    document.getElementById("count-bloodbanks").textContent = summaryData.geolocations.bloodbanks;
    document.getElementById("count-hospitals").textContent = summaryData.geolocations.hospitals;
  }

  const stateSelect = document.getElementById("state-filter");
  summaryData.states.forEach((state) => {
    const option = document.createElement("option");
    option.value = state.name;
    option.textContent = `${titleCase(state.name)} (${state.district_count} districts)`;
    stateSelect.appendChild(option);
  });

  populateDistrictSelect("");

  // This tool's data (radar grids, facilities, accident/reach analyses) is Haryana-only,
  // so default the view there instead of opening zoomed out to all of India.
  const defaultState = summaryData.states.find((s) => s.name.toLowerCase() === "haryana");
  if (defaultState) {
    stateSelect.value = defaultState.name;
    populateDistrictSelect(defaultState.name);
  }

  // districts.geojson covers all 840 districts in India (~11MB serialized). Almost
  // everything in this app only cares about Haryana's 22, so fetch that scoped slice
  // first for a fast paint, then quietly upgrade to the full national set in the
  // background in case the person clears the state filter to browse other states.
  const scopedState = defaultState ? defaultState.name : "HARYANA";
  const [stateGeo, districtGeoScoped] = await Promise.all([
    fetch("/data/state.geojson").then((r) => r.json()),
    fetch(`/data/districts.geojson?state=${encodeURIComponent(scopedState)}`).then((r) => r.json()),
  ]);

  allStates = stateGeo.features;
  allDistricts = districtGeoScoped.features;

  stateLayer = L.geoJSON(stateGeo, { style: stateStyle });
  stateLayer.eachLayer((layer) => {
    bindLayer(layer, "State");
    stateIndex.set(layer.feature.properties.STATE, layer);
  });
  stateLayer.addTo(map);

  districtLayer = L.layerGroup().addTo(map);
  stateLabelLayer = L.layerGroup().addTo(map);
  districtLabelLayer = L.layerGroup().addTo(map);
  radarLayer = L.layerGroup().addTo(map);
  ambulanceLayer = L.layerGroup().addTo(map);
  bloodbankLayer = L.layerGroup().addTo(map);
  hospitalLayer = L.layerGroup().addTo(map);

  ["layer-ambulance", "layer-bloodbanks", "layer-hospitals"].forEach((id) => {
    document.getElementById(id).addEventListener("change", loadGeoLayers);
  });

  document.getElementById("layer-radar").addEventListener("change", loadRadarGrid);
  document.querySelectorAll('input[name="radar-type"]').forEach((input) => {
    input.addEventListener("change", () => {
      if (document.getElementById("layer-radar").checked) loadRadarGrid();
    });
  });

  document.getElementById("layer-states").addEventListener("change", (e) => {
    if (e.target.checked) stateLayer.addTo(map);
    else map.removeLayer(stateLayer);
    updateLabels();
  });

  document.getElementById("layer-districts").addEventListener("change", (e) => {
    if (e.target.checked) districtLayer.addTo(map);
    else map.removeLayer(districtLayer);
    updateLabels();
  });

  document.getElementById("labels-states").addEventListener("change", updateLabels);
  document.getElementById("labels-districts").addEventListener("change", updateLabels);

  document.getElementById("state-filter").addEventListener("change", (e) => {
    populateDistrictSelect(e.target.value);
    document.getElementById("district-filter").value = "";
    applyFilters();
  });

  document.getElementById("district-filter").addEventListener("change", () => applyFilters());
  document.getElementById("district-search").addEventListener("input", () => applyFilters({ fit: false }));
  document.getElementById("clear-filters").addEventListener("click", clearFilters);

  map.on("zoomend", updateLabels);
  map.on("moveend", updateLabels);

  applyFilters();

  // Quietly upgrade to the full national district set in the background so browsing
  // to another state still works, without making the initial paint wait on 11MB.
  fetch("/data/districts.geojson")
    .then((r) => r.json())
    .then((full) => {
      allDistricts = full.features;
      applyFilters({ fit: false });
    })
    .catch((err) => console.error("Background full-district load failed:", err));
}

init().catch((err) => {
  console.error(err);
  document.getElementById("feature-details").textContent = "Failed to load map data. Run export_geojson.py first.";
});
