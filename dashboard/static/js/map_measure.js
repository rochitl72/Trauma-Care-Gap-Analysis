/**
 * Shared two-point distance tool for all Leaflet map views.
 * Straight-line (haversine) + OSRM road route via /api/measure/route.
 */
function initMapMeasure(map) {
  const toggle = document.getElementById("measure-toggle");
  const statusEl = document.getElementById("measure-status");
  const resultsEl = document.getElementById("measure-results");
  const straightEl = document.getElementById("measure-straight");
  const roadEl = document.getElementById("measure-road");
  const durationEl = document.getElementById("measure-duration");
  const clearBtn = document.getElementById("measure-clear");
  const mapEl = document.getElementById("map");

  if (!toggle || !map) return;

  let active = false;
  let clickCount = 0;
  let points = [];
  let markers = [];
  let straightLine = null;
  let roadLine = null;
  let popup = null;

  const measurePane = map.createPane("measurePane");
  measurePane.style.zIndex = 650;

  function setStatus(text, isError) {
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.classList.toggle("error", Boolean(isError));
  }

  function formatKm(km) {
    if (km == null || Number.isNaN(km)) return "—";
    return `${Number(km).toFixed(2)} km`;
  }

  function formatDuration(seconds) {
    if (seconds == null || Number.isNaN(seconds)) return "—";
    const s = Math.round(seconds);
    if (s < 60) return `${s} sec`;
    const m = Math.floor(s / 60);
    const rem = s % 60;
    if (m < 60) return rem ? `${m} min ${rem} sec` : `${m} min`;
    const h = Math.floor(m / 60);
    const rm = m % 60;
    return rm ? `${h} hr ${rm} min` : `${h} hr`;
  }

  function clearMeasurement() {
    clickCount = 0;
    points = [];
    markers.forEach((m) => map.removeLayer(m));
    markers = [];
    if (straightLine) {
      map.removeLayer(straightLine);
      straightLine = null;
    }
    if (roadLine) {
      map.removeLayer(roadLine);
      roadLine = null;
    }
    if (popup) {
      map.closePopup(popup);
      popup = null;
    }
    if (resultsEl) resultsEl.classList.add("hidden");
    if (straightEl) straightEl.textContent = "—";
    if (roadEl) roadEl.textContent = "—";
    if (durationEl) durationEl.textContent = "—";
    if (clearBtn) clearBtn.disabled = true;
    if (active) setStatus("Click first point on the map.");
  }

  function pointMarker(latlng, label) {
    return L.circleMarker(latlng, {
      pane: "measurePane",
      radius: 7,
      color: "#0f172a",
      weight: 2,
      fillColor: label === "A" ? "#2563eb" : "#dc2626",
      fillOpacity: 1,
    }).bindTooltip(label, { permanent: true, direction: "top", offset: [0, -8], className: "measure-point-label" });
  }

  function haversineKm(a, b) {
    const R = 6371.0088;
    const p1 = (a.lat * Math.PI) / 180;
    const p2 = (b.lat * Math.PI) / 180;
    const dLat = ((b.lat - a.lat) * Math.PI) / 180;
    const dLon = ((b.lng - a.lng) * Math.PI) / 180;
    const x =
      Math.sin(dLat / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(x));
  }

  async function completeMeasurement() {
    const [a, b] = points;
    const straightKm = haversineKm(a, b);

    straightLine = L.polyline([a, b], {
      pane: "measurePane",
      color: "#64748b",
      weight: 2,
      dashArray: "8 6",
      opacity: 0.9,
    }).addTo(map);

    if (straightEl) straightEl.textContent = formatKm(straightKm);
    if (roadEl) roadEl.textContent = "Loading…";
    if (durationEl) durationEl.textContent = "Loading…";
    if (resultsEl) resultsEl.classList.remove("hidden");
    if (clearBtn) clearBtn.disabled = false;
    setStatus("Measuring road route…");

    const params = new URLSearchParams({
      lat1: String(a.lat),
      lon1: String(a.lng),
      lat2: String(b.lat),
      lon2: String(b.lng),
    });

    try {
      const resp = await fetch(`/api/measure/route?${params}`);
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || "Route request failed");

      if (roadEl) roadEl.textContent = data.osrm_ok ? formatKm(data.road_km) : "Unavailable";
      if (durationEl) durationEl.textContent = data.osrm_ok ? formatDuration(data.duration_s) : "—";

      if (data.route_geometry) {
        roadLine = L.geoJSON(data.route_geometry, {
          pane: "measurePane",
          style: { color: "#0d9488", weight: 4, opacity: 0.95 },
        }).addTo(map);
      }

      const mid = L.latLng((a.lat + b.lat) / 2, (a.lng + b.lng) / 2);
      const roadText = data.osrm_ok ? formatKm(data.road_km) : "road N/A";
      popup = L.popup({ className: "measure-popup", closeButton: true, autoClose: false })
        .setLatLng(mid)
        .setContent(
          `<strong>Distance scale</strong><br/>Straight: <b>${formatKm(data.straight_km ?? straightKm)}</b><br/>Road: <b>${roadText}</b>`
        )
        .openOn(map);

      setStatus("Measurement complete. Clear or click again to start over.");
      clickCount = 2;
    } catch (err) {
      console.error(err);
      if (roadEl) roadEl.textContent = "Unavailable";
      if (durationEl) durationEl.textContent = "—";
      setStatus("Straight-line shown; road route could not be loaded.", true);
    }
  }

  function onMapClick(e) {
    if (!active) return;
    L.DomEvent.stop(e);

    if (clickCount >= 2) clearMeasurement();

    const latlng = e.latlng;
    points.push(latlng);
    const label = clickCount === 0 ? "A" : "B";
    markers.push(pointMarker(latlng, label).addTo(map));
    clickCount += 1;

    if (clickCount === 1) {
      setStatus("Click second point on the map.");
      return;
    }

    completeMeasurement();
  }

  function setActive(on) {
    active = on;
    mapEl?.classList.toggle("measure-active", on);
    if (on) {
      map.on("click", onMapClick);
      clearMeasurement();
      setStatus("Click first point on the map.");
    } else {
      map.off("click", onMapClick);
      clearMeasurement();
      setStatus("Off — enable, then click two points.");
    }
  }

  toggle.addEventListener("change", () => setActive(toggle.checked));
  clearBtn?.addEventListener("click", () => {
    clearMeasurement();
    if (active) setStatus("Click first point on the map.");
  });
}
