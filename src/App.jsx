import React, { useEffect, useMemo, useRef, useState } from "react";
import L from "leaflet";
import { Chart } from "chart.js/auto";
import * as XLSX from "xlsx";

const CA_BOUNDS = {
  minLat: 32,
  maxLat: 42,
  minLon: -125,
  maxLon: -114
};

const CACHE_KEY = "caQuakesReactCacheV1";
const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const MIN_MAGNITUDE = 2.0;

const VIEW_LABELS = {
  all: "All Quakes",
  m4: "Stronger (M4+)",
  tsunami: "Tsunami-Flagged"
};

const RANGE_LABELS = {
  "24h": "24 Hours",
  "30d": "30 Days",
  "5y": "5 Years"
};

export default function App() {
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("Loading latest data...");
  const [lastUpdated, setLastUpdated] = useState(null);
  const [view, setView] = useState("all");
  const [range, setRange] = useState("5y");
  const [selected, setSelected] = useState(null);

  const mapRef = useRef(null);
  const markersLayerRef = useRef(null);
  const chartRef = useRef(null);
  const chartCanvasRef = useRef(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const viewParam = params.get("view");
    const rangeParam = params.get("range");

    if (["all", "m4", "tsunami"].includes(viewParam)) {
      setView(viewParam);
    }
    if (["24h", "30d", "5y"].includes(rangeParam)) {
      setRange(rangeParam);
    }
  }, []);

  useEffect(() => {
    const params = new URLSearchParams();
    params.set("view", view);
    params.set("range", range);
    window.history.replaceState({}, "", `${window.location.pathname}?${params.toString()}`);
  }, [view, range]);

  useEffect(() => {
    const map = L.map("quake-map", {
      zoomControl: true,
      minZoom: 4,
      maxZoom: 11,
      preferCanvas: true
    });

    mapRef.current = map;

    L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
      attribution: '&copy; OpenStreetMap contributors &copy; CARTO'
    }).addTo(map);

    const bounds = L.latLngBounds(
      [CA_BOUNDS.minLat, CA_BOUNDS.minLon],
      [CA_BOUNDS.maxLat, CA_BOUNDS.maxLon]
    );
    map.fitBounds(bounds.pad(0.08));

    markersLayerRef.current = L.layerGroup().addTo(map);

    return () => {
      map.remove();
    };
  }, []);

  const filtered = useMemo(() => {
    const now = new Date();
    const rangeStart = getRangeStart(now, range);

    let output = events.filter((event) => event.time >= rangeStart && event.time <= now);

    if (view === "m4") {
      output = output.filter((event) => event.mag >= 4);
    }

    if (view === "tsunami") {
      output = output.filter((event) => event.tsunamiFlag);
    }

    return output;
  }, [events, range, view]);

  useEffect(() => {
    if (!markersLayerRef.current) {
      return;
    }

    const layer = markersLayerRef.current;
    layer.clearLayers();

    filtered.forEach((event) => {
      const marker = L.circleMarker([event.lat, event.lon], {
        radius: getRadius(event.mag),
        weight: 1,
        color: "#1d3557",
        fillColor: getColor(event.mag),
        fillOpacity: 0.8
      });

      marker.bindPopup(`
        <strong>${escapeHtml(event.place)}</strong><br/>
        How strong was it? <strong>M ${event.mag.toFixed(1)}</strong><br/>
        When did it happen? ${event.time.toLocaleString()}<br/>
        Could it make a tsunami? <strong>${event.tsunamiFlag ? "Yes (flagged)" : "No"}</strong>
      `);

      marker.on("click", () => setSelected(event));
      marker.addTo(layer);
    });
  }, [filtered]);

  useEffect(() => {
    if (!chartCanvasRef.current) {
      return;
    }

    const buckets = [0, 0, 0, 0];
    filtered.forEach((event) => {
      if (event.mag < 3) buckets[0] += 1;
      else if (event.mag < 4) buckets[1] += 1;
      else if (event.mag < 5) buckets[2] += 1;
      else buckets[3] += 1;
    });

    if (!chartRef.current) {
      chartRef.current = new Chart(chartCanvasRef.current, {
        type: "bar",
        data: {
          labels: ["2.0-2.9", "3.0-3.9", "4.0-4.9", "5.0+"],
          datasets: [
            {
              data: buckets,
              backgroundColor: ["#84dcc6", "#ffd166", "#f4a261", "#ef476f"],
              borderRadius: 10,
              borderWidth: 0
            }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { display: false }
          },
          scales: {
            x: {
              ticks: { color: "#d7e3ff" },
              grid: { color: "rgba(215, 227, 255, 0.12)" }
            },
            y: {
              beginAtZero: true,
              ticks: { precision: 0, color: "#d7e3ff" },
              grid: { color: "rgba(215, 227, 255, 0.12)" }
            }
          }
        }
      });
    } else {
      chartRef.current.data.datasets[0].data = buckets;
      chartRef.current.update();
    }
  }, [filtered]);

  useEffect(() => {
    let active = true;

    async function loadData() {
      setLoading(true);
      setError("");

      const cached = readCache();
      const now = new Date();
      const hasCached = cached && Array.isArray(cached.events) && cached.events.length > 0;

      if (hasCached) {
        const deserialized = deserialize(cached.events);
        if (!active) return;

        setEvents(deserialized);
        setLastUpdated(new Date(cached.lastUpdatedAt || cached.cachedAt));
        setStatus("Using saved data from this browser.");
        setLoading(false);
      }

      const isFresh = hasCached && now.getTime() - Number(cached.cachedAt || 0) < ONE_WEEK_MS;
      if (isFresh) {
        return;
      }

      try {
        const start = hasCached ? new Date(getLatestTimeMs(deserialize(cached.events)) + 1000) : getFiveYearsAgo(now);
        const newest = await fetchInChunks(start, now);
        const base = hasCached ? deserialize(cached.events) : [];
        const merged = mergeById(base, newest);

        if (!active) return;

        setEvents(merged);
        setLastUpdated(new Date());
        setStatus("Connected to USGS live data.");
        writeCache(merged, new Date());
      } catch (fetchError) {
        if (!active) return;
        setError("Could not update from USGS right now.");
        setStatus(hasCached ? "Showing last saved data." : "No data available yet.");
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    }

    loadData();
    const interval = setInterval(loadData, 5 * 60 * 1000);

    return () => {
      active = false;
      clearInterval(interval);
    };
  }, []);

  const summary = useMemo(() => {
    const count = filtered.length;
    const maxMag = count ? Math.max(...filtered.map((e) => e.mag)) : 0;
    const avg = count ? filtered.reduce((sum, e) => sum + e.mag, 0) / count : 0;
    const tsunamiCount = filtered.filter((e) => e.tsunamiFlag).length;
    return { count, maxMag, avg, tsunamiCount };
  }, [filtered]);

  function handleRefresh() {
    localStorage.removeItem(CACHE_KEY);
    window.location.reload();
  }

  function handleExport() {
    if (!filtered.length) {
      setError("No earthquakes match this filter yet, so there is nothing to export.");
      return;
    }

    const rows = filtered.map((event) => ({
      place: event.place,
      magnitude: Number(event.mag.toFixed(1)),
      time_local: event.time.toLocaleString(),
      tsunami_flagged: event.tsunamiFlag ? "Yes" : "No",
      latitude: event.lat,
      longitude: event.lon
    }));

    const workbook = XLSX.utils.book_new();
    const worksheet = XLSX.utils.json_to_sheet(rows);
    XLSX.utils.book_append_sheet(workbook, worksheet, "Earthquakes");
    const fileName = `california-earthquakes-${toISO(new Date())}.xlsx`;
    XLSX.writeFile(workbook, fileName, { compression: true });
  }

  return (
    <main className="page">
      <section className="hero card">
        <h1>California Earthquake + Tsunami Explorer</h1>
        <p className="priority">Priority: Ms. Belfour&apos;s 3rd Grade Class in Playa Vista</p>
        <p>
          Live map for learning plate tectonics, earthquakes, and tsunami risk signals. This view loads California
          earthquakes above magnitude {MIN_MAGNITUDE.toFixed(1)}.
        </p>
      </section>

      <section className="card controls">
        <div>
          <h3>Map View</h3>
          <div className="chips">
            {Object.keys(VIEW_LABELS).map((key) => (
              <button key={key} className={key === view ? "chip active" : "chip"} onClick={() => setView(key)}>
                {VIEW_LABELS[key]}
              </button>
            ))}
          </div>
        </div>

        <div>
          <h3>Time Window</h3>
          <div className="chips">
            {Object.keys(RANGE_LABELS).map((key) => (
              <button key={key} className={key === range ? "chip active" : "chip"} onClick={() => setRange(key)}>
                {RANGE_LABELS[key]}
              </button>
            ))}
          </div>
        </div>

        <div className="actions">
          <button className="action" onClick={handleRefresh}>Refresh Latest Data</button>
          <button className="action secondary" onClick={handleExport}>Download Excel File</button>
        </div>

        <div className="statusRow">
          <span>{status}</span>
          {lastUpdated ? <span>Last update: {lastUpdated.toLocaleString()}</span> : <span>Last update: not yet</span>}
          <span>Filter: {VIEW_LABELS[view]} | {RANGE_LABELS[range]}</span>
        </div>
      </section>

      {error ? <p className="errorBox">{error}</p> : null}

      <section className="mainGrid">
        <article className="card mapCard">
          <div id="quake-map" />
        </article>

        <aside className="card sideCard">
          <h2>Classroom Snapshot</h2>
          <div className="stats">
            <div><span>Quakes on screen</span><strong>{summary.count}</strong></div>
            <div><span>Biggest quake</span><strong>{summary.maxMag.toFixed(1)}</strong></div>
            <div><span>Average strength</span><strong>{summary.avg.toFixed(1)}</strong></div>
            <div><span>Tsunami-flagged</span><strong>{summary.tsunamiCount}</strong></div>
          </div>

          <div className="selected">
            {selected ? (
              <>
                <h3>Selected Earthquake</h3>
                <p><strong>Place:</strong> {selected.place}</p>
                <p><strong>How strong was it?</strong> M {selected.mag.toFixed(1)}</p>
                <p><strong>When did it happen?</strong> {selected.time.toLocaleString()}</p>
                <p><strong>Could it make a tsunami?</strong> {selected.tsunamiFlag ? "Yes (flagged by USGS)" : "No"}</p>
              </>
            ) : (
              <p>Click any map circle to inspect an earthquake.</p>
            )}
          </div>

          <div className="explainer">
            California is near active plate boundaries. Plates can lock, slide, and release energy as earthquakes. Some
            underwater quakes can create conditions that may generate tsunamis.
          </div>
        </aside>
      </section>

      <section className="card chartCard">
        <h2>How many earthquakes are in each group?</h2>
        <div className="chartWrap">
          <canvas ref={chartCanvasRef} />
        </div>
        {!loading && filtered.length === 0 ? <p>No quakes match this filter right now.</p> : null}
      </section>

      <footer className="footer">
        <p>Author: JJ Espinoza (parent at the school) - jj.espinoza.la@gmail.com</p>
        <p>Questions about the application are welcome by email.</p>
      </footer>

      {loading ? (
        <div className="loadingOverlay">
          <div className="loadingCard">Loading earthquake data...</div>
        </div>
      ) : null}
    </main>
  );
}

function getRangeStart(now, range) {
  const d = new Date(now);
  if (range === "24h") d.setHours(d.getHours() - 24);
  else if (range === "30d") d.setDate(d.getDate() - 30);
  else d.setFullYear(d.getFullYear() - 5);
  return d;
}

function getFiveYearsAgo(now) {
  const d = new Date(now);
  d.setFullYear(d.getFullYear() - 5);
  return d;
}

function getLatestTimeMs(events) {
  if (!events.length) return 0;
  return events.reduce((max, event) => Math.max(max, event.time.getTime()), 0);
}

function mergeById(base, incoming) {
  const map = new Map();
  base.forEach((event) => map.set(event.id, event));
  incoming.forEach((event) => map.set(event.id, event));
  return Array.from(map.values()).sort((a, b) => b.time.getTime() - a.time.getTime());
}

async function fetchInChunks(start, end) {
  const chunks = chunkDates(start, end, 180);
  const all = [];

  for (const chunk of chunks) {
    const rows = await fetchChunk(chunk.start, chunk.end);
    all.push(...rows);
  }

  return all;
}

function chunkDates(start, end, daysPerChunk) {
  const out = [];
  let cursor = new Date(start);

  while (cursor <= end) {
    const chunkEnd = new Date(cursor);
    chunkEnd.setDate(chunkEnd.getDate() + daysPerChunk);
    if (chunkEnd > end) chunkEnd.setTime(end.getTime());

    out.push({ start: new Date(cursor), end: new Date(chunkEnd) });
    cursor = new Date(chunkEnd);
    cursor.setDate(cursor.getDate() + 1);
  }

  return out;
}

async function fetchChunk(start, end) {
  const url = new URL("https://earthquake.usgs.gov/fdsnws/event/1/query");
  url.searchParams.set("format", "geojson");
  url.searchParams.set("starttime", toISO(start));
  url.searchParams.set("endtime", toISO(end));
  url.searchParams.set("minlatitude", String(CA_BOUNDS.minLat));
  url.searchParams.set("maxlatitude", String(CA_BOUNDS.maxLat));
  url.searchParams.set("minlongitude", String(CA_BOUNDS.minLon));
  url.searchParams.set("maxlongitude", String(CA_BOUNDS.maxLon));
  url.searchParams.set("minmagnitude", MIN_MAGNITUDE.toFixed(1));
  url.searchParams.set("orderby", "time-asc");

  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`USGS error ${response.status}: ${text.slice(0, 120)}`);
  }

  const payload = await response.json();
  const features = Array.isArray(payload.features) ? payload.features : [];

  return features.map(normalize).filter(isCaliforniaEvent);
}

function normalize(feature) {
  const props = feature.properties || {};
  const coords = feature.geometry?.coordinates || [];
  return {
    id: feature.id || `${coords[0]}-${coords[1]}-${props.time}`,
    mag: Number(props.mag),
    place: String(props.place || "Unknown location"),
    time: new Date(props.time),
    tsunamiFlag: Number(props.tsunami) === 1,
    lon: Number(coords[0]),
    lat: Number(coords[1])
  };
}

function isCaliforniaEvent(event) {
  if (!Number.isFinite(event.lat) || !Number.isFinite(event.lon) || !Number.isFinite(event.mag)) {
    return false;
  }

  const inBounds = event.lat >= CA_BOUNDS.minLat && event.lat <= CA_BOUNDS.maxLat && event.lon >= CA_BOUNDS.minLon && event.lon <= CA_BOUNDS.maxLon;
  if (!inBounds) return false;

  const place = event.place.toLowerCase();
  const caHint = /,\s*ca\b/i.test(event.place) || place.includes("california");
  const excluded = place.includes("baja california");

  return caHint && !excluded;
}

function getColor(mag) {
  if (mag < 3) return "#84dcc6";
  if (mag < 4) return "#ffd166";
  if (mag < 5) return "#f4a261";
  return "#ef476f";
}

function getRadius(mag) {
  return Math.max(4, Math.min(16, 3 + mag * 1.8));
}

function writeCache(events, updatedAt) {
  const payload = {
    cachedAt: Date.now(),
    lastUpdatedAt: updatedAt.getTime(),
    events: serialize(events)
  };
  localStorage.setItem(CACHE_KEY, JSON.stringify(payload));
}

function readCache() {
  const raw = localStorage.getItem(CACHE_KEY);
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw);
    if (!parsed?.events || !Array.isArray(parsed.events)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function serialize(events) {
  return events.map((event) => ({
    id: event.id,
    mag: event.mag,
    place: event.place,
    timeMs: event.time.getTime(),
    tsunamiFlag: event.tsunamiFlag,
    lon: event.lon,
    lat: event.lat
  }));
}

function deserialize(rows) {
  return rows
    .map((row) => ({
      id: row.id,
      mag: Number(row.mag),
      place: String(row.place || "Unknown location"),
      time: new Date(Number(row.timeMs)),
      tsunamiFlag: Boolean(row.tsunamiFlag),
      lon: Number(row.lon),
      lat: Number(row.lat)
    }))
    .filter((event) => !Number.isNaN(event.time.getTime()));
}

function toISO(date) {
  return date.toISOString().slice(0, 10);
}

function escapeHtml(input) {
  return String(input)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
