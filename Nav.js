// =====================================================================
//  MARS NAVIGATION — route planner, turn-by-turn guidance and HUD
//
//  Planning:
//   1. A grid (about 90 x 90 cells) is laid over the area between start and end.
//   2. The real elevation of every cell is read from the Mars elevation service.
//   3. Each cell gets a cost: distance x (1 + slope penalty). Cells that are too
//      steep (> maxSlopeDeg) or inside a hazard zone (+ a safety margin) are blocked.
//   4. A* search finds the cheapest path, simplified into turn points.
//      If no path fits, the search area is enlarged and tried again.
//  Guidance (Waze-style):
//   - Turn instructions at each turn point ("Turn left in 1.2 km").
//   - Follow camera from behind the astronaut/rover, heading-up.
//   - Compass arrow head gets wider when climbing, narrower when descending.
//  Hazards: points with "kind": "hazard" in mission.geojson ("radius_km" sets the size)
//  plus any placed with the ADD HAZARD button (radius chosen in the panel).
//  In hazard mode, clicking inside an existing hazard removes it.
// =====================================================================

const MARS_RADIUS_KM = 3396.19;
const KM_PER_DEG = (Math.PI * MARS_RADIUS_KM) / 180;   // ≈ 59.27 km per degree of latitude

const NAV_SETTINGS = {
  gridSize: 90,          // cells along the longer side of the search area
  maxSlopeDeg: 20,       // steeper than this = impassable
  slopeWeight: 0.15,     // extra cost per degree of slope
  hazardRadiusKm: 2,     // default radius for new hazards (changed from the panel)
  autoRecompute: false,  // re-plan by itself when start/end/hazards change (button in the panel)
  // ---- online hazard data, fetched only for the area of the route being planned ----
  useCraters: true,      // USGS Robbins crater database (craters ≥ 1 km)
  craterMinKm: 1,        // ignore craters smaller than this
  craterMaxKm: 8,        // craters up to this size are no-go zones; bigger ones (like Jezero)
                         // are left to the slope check, since their floors can be driven on
  craterMargin: 1.15,    // no-go radius = crater radius × this (covers the rim)
  craterViewMaxDeg: 8,
  // ---- radiation estimate (galactic cosmic rays) ----
  // Reference: Curiosity RAD, 0.67 mSv/day dose equivalent at Gale Crater (−4.4 km).
  // Dose falls as the air column above grows, so it is scaled with surface pressure,
  // which follows elevation: P ∝ exp(−h / scale height).
  radDoseRef: 0.67,      // mSv/day at the reference elevation
  radRefElevM: -4400,    // reference elevation (Gale Crater)
  radScaleHeightM: 11100,// Mars atmospheric scale height
  radExponent: 0.35,     // how strongly dose follows pressure (dose ∝ pressure^−exponent)   // crater layer loads the visible area only when the view is narrower than this
  minTurnDeg: 10,        // smaller direction changes are "continue straight" (no instruction)
  pathSmoothing: true,   // straighten the grid zigzag wherever the straight line is still safe
  simplifyCells: 0.5,    // bends smaller than this (in grid cells) don't become turn points
  // ---- simulation + camera (editable in the ⚙ SETTINGS panel, saved in the browser) ----
  speedKmh: 8,           // vehicle speed; also used for ETA
  timeWarp: 60,          // simulation runs this many times faster than real time
  camAltBaseM: 150,      // camera height above the vehicle at 0 km/h
  camAltPerKmh: 12,      // extra camera height per km/h  → faster = higher = wider view
  camTiltBase: 72,       // camera pitch on level ground (0 = straight down, 90 = horizon)
  camPitchGain: 1.5,     // extra pitch per degree of slope: climbing looks up, descending looks down
  camTiltMin: 45,
  camTiltMax: 85,
  camSmoothing: 0.08     // 0.02 = very smooth/slow camera, 0.5 = snappy
};

// Shown in the settings panel: [key, label, min, max, step, unit]
const NAV_SETTINGS_UI = [
  ["— SIMULATION —"],
  ["speedKmh", "Vehicle speed", 1, 120, 1, "km/h"],
  ["timeWarp", "Time warp", 1, 600, 1, "×"],
  ["— POV ZOOM vs SPEED —"],
  ["camAltBaseM", "Base camera height", 20, 1500, 10, "m"],
  ["camAltPerKmh", "Height per km/h", 0, 60, 1, "m"],
  ["— POV PITCH vs CLIMB —"],
  ["camTiltBase", "Pitch on level ground", 20, 88, 1, "°"],
  ["camPitchGain", "Pitch change per ° of slope", 0, 6, 0.1, "×"],
  ["camTiltMin", "Minimum pitch", 10, 85, 1, "°"],
  ["camTiltMax", "Maximum pitch", 30, 89, 1, "°"],
  ["camSmoothing", "Camera responsiveness", 0.02, 0.5, 0.01, ""],
  ["— TURN GUIDANCE —"],
  ["pathSmoothing", "Straighten path (remove grid zigzag)", "bool"],
  ["minTurnDeg", "Minimum angle for an instruction", 5, 60, 1, "°"],
  ["simplifyCells", "Ignore wiggles smaller than", 0.25, 3, 0.25, "cells"],
  ["— ROUTE PLANNING —"],
  ["maxSlopeDeg", "Max drivable slope", 5, 45, 1, "°"],
  ["slopeWeight", "Slope avoidance", 0, 1, 0.01, ""],
  ["— ONLINE HAZARD DATA (fetched per route) —"],
  ["useCraters", "Avoid craters (USGS database)", "bool"],
  ["craterMinKm", "Smallest crater to avoid", 1, 10, 0.5, "km"],
  ["craterMaxKm", "Largest crater to avoid", 2, 50, 1, "km"],
  ["craterMargin", "Rim safety factor", 1, 1.6, 0.05, "×"],
  ["craterViewMaxDeg", "Crater layer: load when view narrower than", 2, 20, 1, "°"],
  ["— RADIATION ESTIMATE —"],
  ["radDoseRef", "Dose at Gale Crater (RAD)", 0.1, 2, 0.01, "mSv/day"],
  ["radExponent", "Sensitivity to air column", 0, 1, 0.01, ""]
];

// Restore saved settings (browser storage may be unavailable: ignore then)
const NAV_DEFAULTS = { ...NAV_SETTINGS };
// Saved settings carry a version; when a default changes, older saved values of it are dropped.
const NAV_SETTINGS_VERSION = 2;
const CHANGED_DEFAULTS = { 2: ["minTurnDeg"] };
try {
  const saved = JSON.parse(localStorage.getItem("marsNavSettings") || "{}");
  for (let v = (saved._v || 1) + 1; v <= NAV_SETTINGS_VERSION; v++) (CHANGED_DEFAULTS[v] || []).forEach(k => delete saved[k]);
  delete saved._v;
  Object.assign(NAV_SETTINGS, saved);
} catch (e) {}

function initNav({ map, getView, MARS_SR, loadModules, craterLayer, getGazetteer }) {
  const state = {
    mode: null,           // "start" | "end" | "hazard" | null
    start: null, end: null,
    hazards: [],          // manual + mission.geojson hazards: { x, y, radiusKm, name }
    autoHazards: [],      // hazards fetched online for the current route area (craters)
    route: null,          // { path, cum, waypoints, maneuvers, stats }
    sim: null,
    follow: true,
    track: false          // overview mode: keep the vehicle centered
  };

  let GraphicsLayer, Graphic, Multipoint, Camera, layer, elevation;
  const ready = (async () => {
    [GraphicsLayer, Graphic, Multipoint, Camera] = await loadModules([
      "esri/layers/GraphicsLayer", "esri/Graphic", "esri/geometry/Multipoint", "esri/Camera"
    ]);
    layer = new GraphicsLayer({ title: "Navigation", elevationInfo: { mode: "on-the-ground" } });
    map.add(layer);
    elevation = map.ground.layers.getItemAt(0);
    await loadMissionHazards();
    redraw(); updateHud();
  })();

  // ---------- UI wiring ----------
  const $ = (id) => document.getElementById(id);
  const setMode = (m) => {
    state.mode = state.mode === m ? null : m;
    ["btnStart", "btnEnd", "btnHazard"].forEach(id => $(id).classList.remove("active"));
    if (state.mode) $({ start: "btnStart", end: "btnEnd", hazard: "btnHazard" }[state.mode]).classList.add("active");
    status(state.mode === "hazard" ? "Click to place a hazard · click inside one to remove it"
         : state.mode ? `Search a name or click on the map to place the ${state.mode === "end" ? "destination" : "start"}` : "Ready");
    if (state.mode === "start" || state.mode === "end") openSearch(state.mode); else closeSearch();
  };

  // ---------- search by name (SET START / SET DESTINATION) ----------
  let searchList = null, searchHits = [], searchSel = 0;
  const norm = (t) => (t || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

  async function openSearch(which) {
    $("searchTitle").firstChild.textContent = `// SEARCH ${which === "end" ? "DESTINATION" : "START"} `;
    const fly = $("searchFly"), b = $(which === "end" ? "btnEnd" : "btnStart").getBoundingClientRect();
    fly.style.left = ($("left").getBoundingClientRect().right + 10) + "px";
    fly.style.top = Math.max(10, Math.min(b.top - 30, window.innerHeight - 420)) + "px";
    fly.classList.add("open"); fly.setAttribute("aria-hidden", "false");
    $("routeFly")?.classList.remove("open"); $("btnRouteMenu")?.classList.remove("open");
    $("searchInput").value = "";
    $("searchResults").replaceChildren();
    setTimeout(() => $("searchInput").focus(), 50);
    if (!searchList && getGazetteer) {
      $("searchResults").innerHTML = '<div class="sr none">Loading names…</div>';
      searchList = (await getGazetteer()).map(p => ({ ...p, key: norm(p.name) }));
      runSearch();
    }
  }
  function closeSearch() { $("searchFly").classList.remove("open"); $("searchFly").setAttribute("aria-hidden", "true"); }

  function runSearch() {
    const q = norm($("searchInput").value.trim());
    const box = $("searchResults");
    box.replaceChildren();
    if (!q || !searchList) return;
    // rank: exact name, name starts with, a word starts with, contains; then bigger features first
    const score = (k) => k === q ? 0 : k.startsWith(q) ? 1 : (" " + k).includes(" " + q) ? 2 : k.includes(q) ? 3 : 9;
    searchHits = searchList.map(p => ({ p, s: score(p.key) })).filter(h => h.s < 9)
      .sort((a, b) => a.s - b.s || b.p.size - a.p.size || a.p.name.localeCompare(b.p.name)).slice(0, 15).map(h => h.p);
    searchSel = 0;
    if (!searchHits.length) { box.innerHTML = '<div class="sr none">No match — try another spelling</div>'; return; }
    searchHits.forEach((p, i) => {
      const row = document.createElement("div");
      row.className = "sr" + (i === 0 ? " sel" : "");
      const at = p.key.indexOf(q);
      const name = document.createElement("div"); name.className = "n";
      name.append(p.name.slice(0, at), Object.assign(document.createElement("b"), { textContent: p.name.slice(at, at + q.length) }),
                  p.name.slice(at + q.length));
      const meta = document.createElement("div"); meta.className = "m";
      meta.textContent = `${p.kind}${p.info ? " · " + p.info : ""} · ${fmt({ x: p.x, y: p.y })}`;
      row.append(name, meta);
      row.onclick = () => choosePlace(p);
      row.onmouseenter = () => { searchSel = i; highlight(); };
      box.append(row);
    });
  }
  const highlight = () => [...$("searchResults").children].forEach((r, i) => {
    r.classList.toggle("sel", i === searchSel); if (i === searchSel) r.scrollIntoView({ block: "nearest" }); });

  function choosePlace(p) {
    const which = state.mode;
    if (which !== "start" && which !== "end") return;
    const pt = { x: p.x, y: p.y };
    if (which === "start") state.start = pt; else state.end = pt;
    setMode(null);                 // closes the search too
    stopSim(); updateHud(); redraw();
    status(`${which === "end" ? "Destination" : "Start"}: ${p.name}`);
    // show the chosen place (keeps the overview fit when both points are set)
    const v = getView();
    if (state.start && state.end && !state.follow) showOverview();
    else if (v?.ready) v.goTo({ target: { type: "point", x: p.x, y: p.y, spatialReference: MARS_SR },
                                 scale: Math.max(250000, (p.size < 1e5 ? p.size : 20) * 20000) }, { duration: 1000 }).catch(() => {});
    inputsChanged();
  }

  $("searchInput").addEventListener("input", runSearch);
  $("searchInput").addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { searchSel = Math.min(searchHits.length - 1, searchSel + 1); highlight(); e.preventDefault(); }
    else if (e.key === "ArrowUp") { searchSel = Math.max(0, searchSel - 1); highlight(); e.preventDefault(); }
    else if (e.key === "Enter" && searchHits[searchSel]) choosePlace(searchHits[searchSel]);
    else if (e.key === "Escape") setMode(null);
  });
  $("btnSearchClose").onclick = () => setMode(null);
  $("btnStart").onclick = () => setMode("start");
  $("btnEnd").onclick = () => setMode("end");
  $("btnHazard").onclick = () => setMode("hazard");
  $("btnRoute").onclick = () => computeRoute();
  $("btnSim").onclick = () => toggleSimulation();
  // Camera modes:
  //  FOLLOW CAM      Waze-like, behind the vehicle, heading-up
  //  ROUTE OVERVIEW  straight down, north-up, with two options:
  //     ⛶ FIT ROUTE      zoom so the whole route fits between the HUD panels (also done on entering)
  //     ⌖ TRACK VEHICLE  keep the vehicle centered while driving, at whatever zoom you choose
  function setCamMode(mode) {
    state.follow = mode === "follow";
    $("btnFollow").classList.toggle("active", state.follow);
    $("btnOverview").classList.toggle("active", !state.follow);
  $("overviewOpts").hidden = state.follow;
    $("overviewOpts").hidden = state.follow;
    const v = getView();
    if (!v) return;
    v.padding = { top: 0, left: 0, right: 0, bottom: 0 };
    if (state.follow) {
      if (state.sim?.pos) followCamera(state.sim.pos, state.sim.smoothHeading ?? state.sim.heading,
                                       state.sim.smoothTilt ?? NAV_SETTINGS.camTiltBase, state.sim.grade || 0);
    } else if (state.track && (state.sim?.pos || state.start)) {
      trackVehicle(state.sim?.pos || state.start, true);
    } else {
      showOverview();
    }
  }
  $("btnFit").onclick = () => { state.track = false; $("btnTrack").classList.remove("active"); showOverview(); };
  $("btnTrack").onclick = () => {
    state.track = !state.track;
    $("btnTrack").classList.toggle("active", state.track);
    if (state.track) trackVehicle(state.sim?.pos || state.start, true);
  };
  $("btnFollow").onclick = () => setCamMode("follow");
  $("btnOverview").onclick = () => setCamMode("overview");
  $("btnFollow").classList.toggle("active", state.follow);
  $("btnOverview").classList.toggle("active", !state.follow);
  const showAuto = () => {
    $("btnAuto").textContent = `↻ AUTO RECOMPUTE: ${NAV_SETTINGS.autoRecompute ? "ON" : "OFF"}`;
    $("btnAuto").classList.toggle("active", NAV_SETTINGS.autoRecompute);
  };
  $("btnAuto").onclick = () => {
    NAV_SETTINGS.autoRecompute = !NAV_SETTINGS.autoRecompute;
    showAuto(); saveSettings();
    if (NAV_SETTINGS.autoRecompute && state.route?.stale) computeRoute();
  };
  showAuto();

  // Something changed after the route was planned: re-plan, or flag the route as outdated
  function inputsChanged() {
    if (!state.start || !state.end) return;
    if (NAV_SETTINGS.autoRecompute || !state.route) { if (NAV_SETTINGS.autoRecompute) computeRoute(); return; }
    state.route.stale = true;
    $("btnRoute").classList.add("pulse");
    $("btnRouteMenu").classList.add("pulse");
    status("Route outdated — press COMPUTE ROUTE");
    updateHud(); redraw();
  }
  $("hazardRadius").value = String(NAV_SETTINGS.hazardRadiusKm);
  $("hazardRadius").onchange = (e) => { NAV_SETTINGS.hazardRadiusKm = parseFloat(e.target.value); };
  $("btnClear").onclick = () => {
    stopSim(); state.start = state.end = state.route = null;
    state.hazards = state.hazards.filter(h => h.fromFile);
    state.autoHazards = [];
    craterLayer?.setBlocked([]);
    $("btnRoute").classList.remove("pulse"); $("btnRouteMenu").classList.remove("pulse");
    updateHud(); redraw(); status("Cleared");
  };

  // ---------- ROUTE sub-window (slides out next to ROUTE CONTROL) ----------
  function placeFly() {
    const b = $("btnRouteMenu").getBoundingClientRect(), l = $("left").getBoundingClientRect();
    const fly = $("routeFly");
    fly.style.left = (l.right + 10) + "px";
    fly.style.top = Math.max(10, Math.min(b.top - 30, window.innerHeight - fly.offsetHeight - 10)) + "px";
  }
  const setFly = (open) => {
    $("routeFly").classList.toggle("open", open);
    $("routeFly").setAttribute("aria-hidden", String(!open));
    $("btnRouteMenu").classList.toggle("open", open);
    if (open) placeFly();
  };
  $("btnRouteMenu").onclick = () => setFly(!$("routeFly").classList.contains("open"));
  $("btnRouteFlyClose").onclick = () => setFly(false);
  window.addEventListener("resize", () => { if ($("routeFly").classList.contains("open")) placeFly(); });
  $("left").addEventListener("scroll", () => { if ($("routeFly").classList.contains("open")) placeFly(); });

  // ---------- export / import (JSON) ----------
  const ROUTE_FORMAT = "mars-nav-route";
  const r6 = (v) => Math.round(v * 1e6) / 1e6;

  function exportRoute() {
    if (!state.route) return;
    const data = getRouteData();
    downloadJson(data);
  }

  // Everything needed to rebuild the route (used by the export)
  function getRouteData() {
    if (!state.route) return null;
    const st = state.route.stats;
    return {
      format: ROUTE_FORMAT, version: 1,
      name: `Route ${fmt(state.start)} → ${fmt(state.end)}`,
      exported: new Date().toISOString(),
      crs: { wkid: MARS_SR.wkid, name: "GCS Mars 2000 (sphere)", units: "degrees; elevation in meters" },
      start: { lon: r6(state.start.x), lat: r6(state.start.y) },
      end: { lon: r6(state.end.x), lat: r6(state.end.y) },
      hazards: state.hazards.map(h => ({ lon: r6(h.x), lat: r6(h.y), radius_km: h.radiusKm, name: h.name,
                                         source: h.fromFile ? "mission.geojson" : "manual" })),
      craters_avoided: state.autoHazards.map(h => ({ id: h.id, lon: r6(h.x), lat: r6(h.y),
                                                     no_go_radius_km: Math.round(h.radiusKm * 1000) / 1000 })),
      planning: Object.fromEntries(["maxSlopeDeg", "slopeWeight", "pathSmoothing", "minTurnDeg", "simplifyCells",
        "useCraters", "craterMinKm", "craterMaxKm", "craterMargin", "speedKmh"].map(k => [k, NAV_SETTINGS[k]])),
      stats: { distance_km: +st.dist.toFixed(3), straight_km: +st.straight.toFixed(3), eta_h: +st.etaH.toFixed(3),
               gain_m: Math.round(st.gain), loss_m: Math.round(st.loss), max_slope_deg: +st.maxSlope.toFixed(2),
               dose_msv_est: +st.doseMSv.toFixed(4) },
      maneuvers: state.route.maneuvers.map(m => ({ index: m.i, at_km: +m.at.toFixed(3), turn_deg: Math.round(m.delta),
                                                   instruction: m.text, icon: m.icon })),
      path: state.route.path.map(p => [r6(p[0]), r6(p[1]), Math.round(p[2] * 10) / 10])   // [lon, lat, elevation m]
    };
  }

  function downloadJson(data) {
    const blob = new Blob([JSON.stringify(data, null, 1)], { type: "application/json" });
    const a = document.createElement("a");
    const t = new Date(), pad = (n) => String(n).padStart(2, "0");
    a.download = `mars-route-${t.getFullYear()}${pad(t.getMonth() + 1)}${pad(t.getDate())}-${pad(t.getHours())}${pad(t.getMinutes())}.json`;
    a.href = URL.createObjectURL(blob);
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    status(`Exported ${a.download}`);
  }

  async function importRoute(file) {
    try {
      const data = JSON.parse(await file.text());
      await applyRouteData(data);
      status(`Imported route · ${state.route.stats.dist.toFixed(1)} km · ${state.route.maneuvers.length - 1} turns`);
    } catch (err) {
      console.error("Import failed:", err);
      status("Import failed: " + err.message);
    }
  }

  async function applyRouteData(data) {
    {
      if (data.format !== ROUTE_FORMAT) throw new Error("not a Mars route file (format field missing)");
      if (!Array.isArray(data.path) || data.path.length < 2) throw new Error("the file has no route path");
      if (data.crs?.wkid && data.crs.wkid !== MARS_SR.wkid) console.warn("Route file uses another coordinate system:", data.crs);
      await ready;
      stopSim();
      state.start = { x: data.start.lon, y: data.start.lat };
      state.end = { x: data.end.lon, y: data.end.lat };
      // hazards: keep mission.geojson ones, add the file's manual ones
      state.hazards = state.hazards.filter(h => h.fromFile).concat(
        (data.hazards || []).filter(h => h.source !== "mission.geojson")
          .map(h => ({ x: h.lon, y: h.lat, radiusKm: h.radius_km, name: h.name || "Hazard" })));
      state.autoHazards = (data.craters_avoided || []).map(c => ({ x: c.lon, y: c.lat, radiusKm: c.no_go_radius_km,
        name: "Crater", auto: true, id: c.id }));
      craterLayer?.addCraters?.((data.craters_avoided || []).map(c => ({ id: c.id, x: c.lon, y: c.lat,
        d: (2 * c.no_go_radius_km) / (data.planning?.craterMargin || NAV_SETTINGS.craterMargin) })));
      craterLayer?.setBlocked(state.autoHazards.map(h => h.id));
      // rebuild the route from the saved path; keep the saved turn instructions
      const path = data.path.map(p => [p[0], p[1], p[2] ?? 0]);
      state.route = buildRoute({ path, tol: 1e-9 });
      if (Array.isArray(data.maneuvers) && data.maneuvers.length) {
        state.route.maneuvers = data.maneuvers.map(m => ({ i: m.index, at: state.route.cum[m.index] ?? m.at_km,
          delta: m.turn_deg || 0, ...(m.turn_deg ? describeTurn(m.turn_deg) : {}),
          text: m.instruction, icon: m.icon, short: (m.instruction || "").toUpperCase() }));
      }
      $("btnRoute").classList.remove("pulse"); $("btnRouteMenu").classList.remove("pulse");
      updateHud(); redraw();
      if (!state.follow) showOverview();
    }
  }

  $("btnExport").onclick = exportRoute;
  $("btnImport").onclick = () => $("fileImport").click();
  $("fileImport").onchange = (e) => { const f = e.target.files[0]; if (f) importRoute(f); e.target.value = ""; };

  function status(msg) { $("navStatus").textContent = msg; }

  // Called every time a 2D or 3D view is created
  function attach(view) {
    craterLayer?.attach(view);
    view.on("click", (e) => {
      if (!state.mode || !e.mapPoint) return;
      e.stopPropagation();   // don't open popups while placing points
      const p = { x: e.mapPoint.x, y: e.mapPoint.y };
      const placed = state.mode;
      if (placed === "start") state.start = p;
      if (placed === "end") state.end = p;
      if (placed === "hazard") {
        const hit = state.hazards.findIndex(h => distKm(p, h) <= h.radiusKm);
        if (hit >= 0) state.hazards.splice(hit, 1);
        else state.hazards.push({ ...p, radiusKm: NAV_SETTINGS.hazardRadiusKm,
                                  name: `Hazard ${NAV_SETTINGS.hazardRadiusKm} km` });
      }
      if (placed !== "hazard") setMode(null);   // stay in hazard mode to place several
      stopSim();
      updateHud(); redraw();
      inputsChanged();
    });
  }

  async function loadMissionHazards() {
    try {
      const gj = await (await fetch("mission.geojson")).json();
      for (const f of gj.features) {
        if (f.properties?.kind === "hazard" && f.geometry?.type === "Point") {
          const [x, y] = f.geometry.coordinates;
          state.hazards.push({ x, y, radiusKm: f.properties.radius_km || NAV_SETTINGS.hazardRadiusKm,
                               name: f.properties.name || "Hazard", fromFile: true });
        }
      }
    } catch (e) { /* no mission file: fine */ }
  }

  // ---------- geometry helpers (lon/lat degrees on a sphere) ----------
  const toR = Math.PI / 180;
  const distKm = (a, b) => {
    const dLat = (b.y - a.y) * toR, dLon = (b.x - a.x) * toR;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.y * toR) * Math.cos(b.y * toR) * Math.sin(dLon / 2) ** 2;
    return 2 * MARS_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
  };
  const bearing = (a, b) => {
    const y = Math.sin((b.x - a.x) * toR) * Math.cos(b.y * toR);
    const x = Math.cos(a.y * toR) * Math.sin(b.y * toR) - Math.sin(a.y * toR) * Math.cos(b.y * toR) * Math.cos((b.x - a.x) * toR);
    return (Math.atan2(y, x) / toR + 360) % 360;
  };
  // point moved distKm along a bearing (small distances, flat approximation is fine)
  const offset = (p, bearingDeg, dKm) => ({
    x: p.x + (dKm * Math.sin(bearingDeg * toR)) / (KM_PER_DEG * Math.cos(p.y * toR)),
    y: p.y + (dKm * Math.cos(bearingDeg * toR)) / KM_PER_DEG
  });
  const circle = (c, rKm, n = 48) => {
    const ring = [];
    for (let i = 0; i <= n; i++) { const q = offset(c, (i / n) * 360, rKm); ring.push([q.x, q.y]); }
    return ring;
  };
  const P = (a) => ({ x: a[0], y: a[1] });

  // Estimated radiation dose rate (mSv/day) at an elevation in meters
  const radRate = (zM) => NAV_SETTINGS.radDoseRef *
    Math.exp(NAV_SETTINGS.radExponent * (zM - NAV_SETTINGS.radRefElevM) / NAV_SETTINGS.radScaleHeightM);
  // Estimated dose (mSv) received while driving the route at the set speed
  function routeDose(route) {
    let dose = 0;
    for (let i = 1; i < route.path.length; i++) {
      const hours = (route.cum[i] - route.cum[i - 1]) / NAV_SETTINGS.speedKmh;
      dose += (hours / 24) * radRate((route.path[i][2] + route.path[i - 1][2]) / 2);
    }
    return dose;
  }

  // ---------- route planning ----------
  async function computeRoute() {
    await ready;
    if (!state.start || !state.end) { status("Set a start and a destination first"); return; }
    stopSim();
    $("btnRoute").disabled = true;
    try {
      let result = null;
      // Try a normal search area first; if hazards/terrain block it, widen the area
      for (const padFactor of [0.35, 0.8, 1.6]) {
        status(padFactor === 0.35 ? "Reading terrain…" : "Blocked — widening search area…");
        result = await searchPath(padFactor);
        if (result) break;
      }
      if (!result) {
        state.route = null; redraw(); updateHud();
        status("No safe route — terrain too steep or blocked by hazards");
        return;
      }
      state.route = buildRoute(result);
      $("btnRoute").classList.remove("pulse"); $("btnRouteMenu").classList.remove("pulse");
      updateHud(); redraw();
      if (!state.follow) showOverview();
      const avoided = [...state.hazards, ...state.autoHazards].filter(h => h.nearRoute).length;
      status(`Route ready · ${state.route.maneuvers.length - 1} turns · ${avoided} hazard zone(s) near the route avoided` +
             (state.autoHazards.length ? ` · ${state.autoHazards.length} crater(s) checked` : ""));
    } catch (err) {
      console.error("Route failed:", err);
      status("Route failed: " + err.message);
    } finally {
      $("btnRoute").disabled = false;
    }
  }

  async function searchPath(padFactor) {
    const { start, end } = state;
    const span = Math.max(Math.abs(end.x - start.x), Math.abs(end.y - start.y));
    const pad = Math.max(0.1, padFactor * span);
    const xmin = Math.min(start.x, end.x) - pad, xmax = Math.max(start.x, end.x) + pad;
    const ymin = Math.min(start.y, end.y) - pad, ymax = Math.max(start.y, end.y) + pad;
    const N = NAV_SETTINGS.gridSize;
    const aspect = ((xmax - xmin) * Math.cos(((ymin + ymax) / 2) * toR)) / (ymax - ymin);
    const cols = aspect >= 1 ? N : Math.max(10, Math.round(N * aspect));
    const rows = aspect >= 1 ? Math.max(10, Math.round(N / aspect)) : N;
    const dx = (xmax - xmin) / (cols - 1), dy = (ymax - ymin) / (rows - 1);
    const cellPos = (r, c) => ({ x: xmin + c * dx, y: ymin + r * dy });
    const idx = (r, c) => r * cols + c;

    // Elevation for every grid cell, in one request
    const pts = [];
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) { const q = cellPos(r, c); pts.push([q.x, q.y]); }
    const res = await elevation.queryElevation(new Multipoint({ points: pts, spatialReference: MARS_SR }),
                                               { demResolution: "finest-contiguous" });
    const z = res.geometry.points.map(p => p[2]);

    // Online hazard data, only for this search area
    state.autoHazards = await fetchCraterHazards({ xmin, ymin, xmax, ymax });
    const allHazards = [...state.hazards, ...state.autoHazards];

    // Hazard zones are blocked with a safety margin of one grid cell, so the
    // straight segments between cells can't cut through the edge of a zone.
    const cellKm = Math.max(dx * KM_PER_DEG * Math.cos(((ymin + ymax) / 2) * toR), dy * KM_PER_DEG);
    const margin = cellKm * 0.75;
    const blocked = new Uint8Array(rows * cols);
    allHazards.forEach(h => h.nearRoute = false);
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const p = cellPos(r, c);
      for (const h of allHazards) if (distKm(p, h) <= h.radiusKm + margin) { blocked[idx(r, c)] = 1; break; }
    }
    const toCell = (p) => [Math.round((p.y - ymin) / dy), Math.round((p.x - xmin) / dx)];
    const s = toCell(start), g = toCell(end);
    blocked[idx(...s)] = 0; blocked[idx(...g)] = 0;   // never block the endpoints themselves

    status("Searching path…");
    const path = aStar({ rows, cols, z, blocked, cellPos, start: s, goal: g });
    if (!path) return null;
    // Elevation anywhere inside the grid (bilinear interpolation between cells)
    const zAt = (r, c) => {
      const r0 = Math.max(0, Math.min(rows - 2, Math.floor(r))), c0 = Math.max(0, Math.min(cols - 2, Math.floor(c)));
      const fr = Math.min(1, Math.max(0, r - r0)), fc = Math.min(1, Math.max(0, c - c0));
      const z00 = z[idx(r0, c0)], z01 = z[idx(r0, c0 + 1)], z10 = z[idx(r0 + 1, c0)], z11 = z[idx(r0 + 1, c0 + 1)];
      return (z00 * (1 - fc) + z01 * fc) * (1 - fr) + (z10 * (1 - fc) + z11 * fc) * fr;
    };
    const posAt = (r, c) => ({ x: xmin + c * dx, y: ymin + r * dy });

    // Is the straight line between two grid positions safe? Sampled every 1/3 cell:
    // no blocked cell (hazard) and no slope above the limit between samples.
    const segSafe = (a, b) => {
      const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) * 3));
      let prev = null;
      for (let k = 0; k <= n; k++) {
        const r = a[0] + (b[0] - a[0]) * (k / n), c = a[1] + (b[1] - a[1]) * (k / n);
        const rr = Math.round(r), cc = Math.round(c);
        if (blocked[idx(rr, cc)]) return false;
        const cur = { ...posAt(r, c), z: zAt(r, c) };
        if (prev) {
          const d = distKm(prev, cur) * 1000;
          if (d > 0 && Math.abs(Math.atan((cur.z - prev.z) / d)) / toR > NAV_SETTINGS.maxSlopeDeg) return false;
        }
        prev = cur;
      }
      return true;
    };

    // Path smoothing ("string pulling"): from each corner, jump to the farthest later
    // point of the grid path that can be reached in a safe straight line.
    let corners = path;
    if (NAV_SETTINGS.pathSmoothing && path.length > 2) {
      corners = [path[0]];
      let i = 0;
      while (i < path.length - 1) {
        let j = path.length - 1;
        while (j > i + 1 && !segSafe(path[i], path[j])) j--;
        corners.push(path[j]);
        i = j;
      }
    }

    // Re-sample the straight segments about once per cell, so distances, the
    // elevation profile and climb/descent readings stay detailed.
    const full = [];
    for (let k = 0; k < corners.length - 1; k++) {
      const a = corners[k], b = corners[k + 1];
      const n = Math.max(1, Math.round(Math.hypot(b[0] - a[0], b[1] - a[1])));
      for (let m = 0; m < n; m++) {
        const r = a[0] + (b[0] - a[0]) * (m / n), c = a[1] + (b[1] - a[1]) * (m / n);
        const p = posAt(r, c);
        full.push([p.x, p.y, zAt(r, c)]);
      }
    }
    const last = corners[corners.length - 1];
    full.push([posAt(...last).x, posAt(...last).y, zAt(...last)]);
    full[0] = [start.x, start.y, full[0][2]];
    full[full.length - 1] = [end.x, end.y, full[full.length - 1][2]];

    // Which hazards does the route pass close to (within 2 radii)?
    for (const h of allHazards) h.nearRoute = full.some(p => distKm(P(p), h) <= h.radiusKm * 2 + cellKm);
    return { path: full, tol: Math.max(dx, dy) * NAV_SETTINGS.simplifyCells };
  }

  // ---------- online hazard data (fetched on demand) ----------
  // The crater layer (craters.js) downloads only the craters inside the route's search
  // box, once; the planner turns the ones in the size range into no-go zones.
  async function fetchCraterHazards(b) {
    if (!NAV_SETTINGS.useCraters || !craterLayer) { craterLayer?.setBlocked([]); return []; }
    let craters;
    try {
      status("Fetching crater data for this area…");
      craters = await craterLayer.getForBbox(b);
    } catch (err) {
      console.warn("Crater data unavailable, planning without it:", err);
      status("Crater data unavailable — planning with terrain and manual hazards only");
      return [];
    }
    const { craterMinKm, craterMaxKm, craterMargin } = NAV_SETTINGS;
    const hazards = craters
      .filter(c => c.d >= craterMinKm && c.d <= craterMaxKm)
      .map(c => ({ x: c.x, y: c.y, radiusKm: (c.d / 2) * craterMargin, name: `Crater ${c.d.toFixed(1)} km`,
                   auto: true, id: c.id }))
      // a start or destination inside a crater: that crater can't be a no-go zone
      .filter(h => distKm(state.start, h) > h.radiusKm && distKm(state.end, h) > h.radiusKm);
    craterLayer.setBlocked(hazards.map(h => h.id));
    return hazards;
  }

  function aStar({ rows, cols, z, blocked, cellPos, start, goal }) {
    const { maxSlopeDeg, slopeWeight } = NAV_SETTINGS;
    const n = rows * cols, idx = (r, c) => r * cols + c;
    const g = new Float64Array(n).fill(Infinity), came = new Int32Array(n).fill(-1);
    const closed = new Uint8Array(n);
    const goalP = cellPos(goal[0], goal[1]);
    const h = (r, c) => distKm(cellPos(r, c), goalP);
    const heap = [];
    const push = (f, i) => { heap.push([f, i]); let k = heap.length - 1; while (k > 0) { const p = (k - 1) >> 1; if (heap[p][0] <= heap[k][0]) break; [heap[p], heap[k]] = [heap[k], heap[p]]; k = p; } };
    const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let k = 0; for (;;) { const l = 2 * k + 1, r = l + 1; let m = k; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === k) break; [heap[m], heap[k]] = [heap[k], heap[m]]; k = m; } } return top; };

    const s = idx(start[0], start[1]), t = idx(goal[0], goal[1]);
    g[s] = 0; push(h(start[0], start[1]), s);
    const dirs = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];
    while (heap.length) {
      const [, cur] = pop();
      if (cur === t) break;
      if (closed[cur]) continue;
      closed[cur] = 1;
      const r = Math.floor(cur / cols), c = cur % cols, pc = cellPos(r, c);
      for (const [dr, dc] of dirs) {
        const nr = r + dr, nc = c + dc;
        if (nr < 0 || nc < 0 || nr >= rows || nc >= cols) continue;
        const ni = idx(nr, nc);
        if (blocked[ni] || closed[ni]) continue;
        const d = distKm(pc, cellPos(nr, nc));
        const slope = Math.abs(Math.atan((z[ni] - z[cur]) / (d * 1000)) / toR);
        if (slope > maxSlopeDeg) continue;
        const cost = g[cur] + d * (1 + slopeWeight * slope);
        if (cost < g[ni]) { g[ni] = cost; came[ni] = cur; push(cost + h(nr, nc), ni); }
      }
    }
    if (g[t] === Infinity) return null;
    const out = [];
    for (let k = t; k !== -1; k = came[k]) out.push([Math.floor(k / cols), k % cols]);
    return out.reverse();
  }

  // Douglas–Peucker simplification → indices of turn points
  function simplifyIdx(pts, tol) {
    if (pts.length < 3) return pts.map((_, i) => i);
    const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
    const stack = [[0, pts.length - 1]];
    while (stack.length) {
      const [a, b] = stack.pop();
      let maxD = 0, mi = -1;
      const [x1, y1] = pts[a], [x2, y2] = pts[b];
      for (let i = a + 1; i < b; i++) {
        const [x, y] = pts[i];
        const d = Math.abs((y2 - y1) * x - (x2 - x1) * y + x2 * y1 - y2 * x1) / (Math.hypot(y2 - y1, x2 - x1) || 1e-12);
        if (d > maxD) { maxD = d; mi = i; }
      }
      if (maxD > tol) { keep[mi] = 1; stack.push([a, mi], [mi, b]); }
    }
    return [...keep].map((k, i) => k ? i : -1).filter(i => i >= 0);
  }

  // Route + statistics + turn-by-turn maneuvers
  function buildRoute({ path, tol }) {
    const cum = [0];
    for (let i = 1; i < path.length; i++) cum.push(cum[i - 1] + distKm(P(path[i - 1]), P(path[i])));
    let gain = 0, loss = 0, maxSlope = 0;
    for (let i = 1; i < path.length; i++) {
      const d = cum[i] - cum[i - 1], dz = path[i][2] - path[i - 1][2];
      if (dz > 0) gain += dz; else loss -= dz;
      if (d > 0) maxSlope = Math.max(maxSlope, Math.abs(Math.atan(dz / (d * 1000)) / toR));
    }
    const dist = cum[cum.length - 1];

    // Turn points → maneuvers. Turns smaller than minTurnDeg are merged into "continue".
    let wIdx = simplifyIdx(path, tol);
    const maneuvers = [];
    for (let k = 1; k < wIdx.length - 1; k++) {
      const a = P(path[wIdx[k - 1]]), b = P(path[wIdx[k]]), c = P(path[wIdx[k + 1]]);
      const delta = ((bearing(b, c) - bearing(a, b) + 540) % 360) - 180;   // + = right, − = left
      if (Math.abs(delta) < NAV_SETTINGS.minTurnDeg) continue;
      maneuvers.push({ i: wIdx[k], at: cum[wIdx[k]], delta, ...describeTurn(delta) });
    }
    maneuvers.push({ i: path.length - 1, at: dist, delta: 0, icon: "◎", text: "Arrive at destination", short: "ARRIVE" });
    const route = {
      path, cum, maneuvers,
      stats: { dist, straight: distKm(state.start, state.end), gain, loss, maxSlope, etaH: dist / NAV_SETTINGS.speedKmh }
    };
    route.stats.doseMSv = routeDose(route);
    return route;
  }

  function describeTurn(delta) {
    const a = Math.abs(delta), side = delta > 0 ? "right" : "left";
    if (a < 45)  return { icon: delta > 0 ? "↗" : "↖", text: `Bear ${side}`,        short: `BEAR ${side.toUpperCase()}` };
    if (a < 120) return { icon: delta > 0 ? "↱" : "↰", text: `Turn ${side}`,        short: `TURN ${side.toUpperCase()}` };
    return              { icon: delta > 0 ? "↷" : "↶", text: `Sharp ${side}`,       short: `SHARP ${side.toUpperCase()}` };
  }

  // ---------- drawing ----------
  const CYAN = [57, 215, 255];
  let simHalo = null, simArrow = null;

  function redraw() {
    if (!layer) return;
    layer.removeAll();
    simHalo = simArrow = null;
    const sr = MARS_SR;

    for (const hz of state.hazards) {
      layer.add(new Graphic({
        geometry: { type: "polygon", rings: [circle(hz, hz.radiusKm)], spatialReference: sr },
        symbol: { type: "simple-fill", color: [255, 60, 60, 0.18], outline: { color: [255, 80, 80, 0.9], width: 1.5, style: "dash" } }
      }));
      layer.add(new Graphic({
        geometry: { type: "point", x: hz.x, y: hz.y, spatialReference: sr },
        symbol: { type: "text", text: `⚠ ${hz.name.toUpperCase()} · R ${hz.radiusKm} KM`, color: [255, 110, 110], haloColor: "black", haloSize: 1,
                  font: { size: 9, family: "monospace", weight: "bold" } }
      }));
    }

    // crater zones are drawn by the crater layer (craters.js)

    if (state.route?.stale) {
      // outdated route: grey and dashed until COMPUTE ROUTE is pressed
      layer.add(new Graphic({ geometry: { type: "polyline", paths: [state.route.path.map(p => [p[0], p[1]])], spatialReference: sr },
        symbol: { type: "simple-line", color: [180, 190, 200, 0.8], width: 3, style: "dash" } }));
    } else if (state.route) {
      const paths = [state.route.path.map(p => [p[0], p[1]])];
      layer.add(new Graphic({ geometry: { type: "polyline", paths, spatialReference: sr },
        symbol: { type: "simple-line", color: [...CYAN, 0.35], width: 10, cap: "round", join: "round" } }));
      layer.add(new Graphic({ geometry: { type: "polyline", paths, spatialReference: sr },
        symbol: { type: "simple-line", color: [240, 252, 255, 1], width: 3, cap: "round", join: "round" } }));
      if (!state.route.stale) state.route.maneuvers.slice(0, -1).forEach((m) => {
        const w = state.route.path[m.i];
        layer.add(new Graphic({ geometry: { type: "point", x: w[0], y: w[1], spatialReference: sr },
          symbol: { type: "simple-marker", style: "circle", size: 16, color: [0, 0, 0, 0.35], outline: { color: [...CYAN, 1], width: 2 } } }));
        layer.add(new Graphic({ geometry: { type: "point", x: w[0], y: w[1], spatialReference: sr },
          symbol: { type: "text", text: m.icon, color: [...CYAN, 1], haloColor: "black", haloSize: 1,
                    font: { size: 11, weight: "bold" } } }));
      });
    }

    const pin = (p, color, text) => {
      if (!p) return;
      layer.add(new Graphic({ geometry: { type: "point", x: p.x, y: p.y, spatialReference: sr },
        symbol: { type: "simple-marker", style: "circle", size: 18, color: [...color, 0.25], outline: { color: [...color, 1], width: 2 } } }));
      layer.add(new Graphic({ geometry: { type: "point", x: p.x, y: p.y, spatialReference: sr },
        symbol: { type: "simple-marker", style: "circle", size: 6, color: [...color, 1], outline: null } }));
      layer.add(new Graphic({ geometry: { type: "point", x: p.x, y: p.y, spatialReference: sr },
        symbol: { type: "text", text, color: [...color, 1], haloColor: "black", haloSize: 1, yoffset: 16,
                  font: { size: 10, family: "monospace", weight: "bold" } } }));
    };
    pin(state.start, [120, 255, 170], "START");
    pin(state.end, CYAN, "DESTINATION");
    updateSimGraphic();
  }

  // The moving vehicle has its own two graphics that are only moved each frame.
  function updateSimGraphic() {
    if (!layer) return;
    if (!state.sim?.pos) {
      if (simHalo) { layer.removeMany([simHalo, simArrow]); simHalo = simArrow = null; }
      return;
    }
    const geometry = { type: "point", x: state.sim.pos.x, y: state.sim.pos.y, spatialReference: MARS_SR };
    if (!simHalo) {
      simHalo = new Graphic({ geometry, symbol: { type: "simple-marker", style: "circle", size: 34,
        color: [...CYAN, 0.12], outline: { color: [...CYAN, 0.9], width: 1.5 } } });
      simArrow = new Graphic({ geometry, symbol: { type: "simple-marker", style: "path",
        path: "M0 -12 L8 10 L0 5 L-8 10 Z", size: 18, color: [...CYAN, 1], outline: { color: "white", width: 1 } } });
      layer.addMany([simHalo, simArrow]);
    }
    simHalo.geometry = geometry;
    simArrow.geometry = geometry;
    // In 2D the map turns heading-up while following, so the arrow then points up
    const view = getView();
    const mapRot = view && view.type === "2d" ? (view.rotation || 0) : 0;
    const sym = simArrow.symbol.clone(); sym.angle = (state.sim.heading + mapRot) % 360; simArrow.symbol = sym;
  }

  // ---------- HUD ----------
  const fmt = (p) => p ? `${p.y >= 0 ? "N" : "S"} ${Math.abs(p.y).toFixed(3)}°  ${p.x >= 0 ? "E" : "W"} ${Math.abs(p.x).toFixed(3)}°` : "— not set —";
  const fmtKm = (km) => km >= 1 ? `${km.toFixed(1)} km` : `${Math.round(km * 1000 / 10) * 10} m`;
  const fmtTime = (h) => { const m = Math.round(h * 60); return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`; };

  function updateHud() {
    $("hudStart").textContent = fmt(state.start);
    $("hudDest").textContent = fmt(state.end);
    const s = state.route?.stats;
    $("hudDist").textContent = s ? fmtKm(s.dist) : "--";
    $("hudStraight").textContent = s ? fmtKm(s.straight) : (state.start && state.end ? fmtKm(distKm(state.start, state.end)) : "--");
    $("hudEta").textContent = s ? fmtTime(s.etaH) : "--";
    $("hudGain").textContent = s ? `+${Math.round(s.gain)} / -${Math.round(s.loss)} m` : "--";
    $("hudSlope").textContent = s ? s.maxSlope.toFixed(1) + "°" : "--";
    $("hudDose").textContent = s ? `${s.doseMSv.toFixed(3)} mSv` : "--";
    if (!state.sim) $("hudRad").textContent = state.route ? `${radRate(state.route.path[0][2]).toFixed(2)} mSv/day` : "--";
    $("hudHazards").textContent = state.autoHazards.length
      ? `${state.hazards.length} + ${state.autoHazards.length} craters` : state.hazards.length;
    $("btnSim").disabled = !state.route;
    $("btnExport").disabled = !state.route || !!state.route.stale;
    $("routeInfo").textContent = state.route
      ? `${state.route.stale ? "Outdated — recompute before exporting. " : ""}${fmtKm(state.route.stats.dist)} · ${state.route.path.length} points · ${state.route.maneuvers.length - 1} turns`
      : "No route yet.";
    if (!state.sim) {
      const hd = state.route ? bearing(P(state.route.path[0]), P(state.route.path[Math.min(3, state.route.path.length - 1)]))
               : state.start && state.end ? bearing(state.start, state.end) : 0;
      $("hudHeading").textContent = state.start && state.end ? Math.round(hd) + "°" : "--";
      setCompass(hd, 0);
      updateGuidance(0);
    }
    setProgress(state.sim ? state.sim.t : 0);
    drawProfile();
  }

  // Compass: needle = heading. Arrow head width follows the grade: wider climbing, narrower descending.
  function setCompass(headingDeg, gradeDeg) {
    const base = 7;
    const half = Math.max(2, Math.min(16, base * (1 + gradeDeg / 8)));
    const needle = $("compassNeedle");
    needle.style.transform = `rotate(${headingDeg}deg)`;
    needle.style.setProperty("--half", half + "px");
    needle.style.setProperty("--needle", gradeDeg > 1 ? "#ffb347" : gradeDeg < -1 ? "#7fffd4" : "#39d7ff");
    const g = $("gradeText");
    g.textContent = Math.abs(gradeDeg) < 0.5 ? "LEVEL" : `${gradeDeg > 0 ? "▲ CLIMB" : "▼ DESCENT"} ${Math.abs(gradeDeg).toFixed(1)}°`;
    g.style.color = gradeDeg > 1 ? "#ffb347" : gradeDeg < -1 ? "#7fffd4" : "";
  }

  // Next instruction ("Turn left in 1.2 km") and the one after it
  function updateGuidance(dAlong) {
    const box = $("guidance");
    if (!state.route) { box.hidden = true; return; }
    box.hidden = false;
    const ms = state.route.maneuvers;
    const k = ms.findIndex(m => m.at > dAlong + 0.005);
    const next = ms[k >= 0 ? k : ms.length - 1], after = k >= 0 ? ms[k + 1] : null;
    const rem = Math.max(0, next.at - dAlong);
    $("gIcon").textContent = next.icon;
    $("gText").textContent = next === ms[ms.length - 1] ? "Destination" : next.text;
    $("gDist").textContent = rem < 0.02 ? "NOW" : `in ${fmtKm(rem)}`;
    $("gThen").textContent = after ? `then ${after.icon} ${after.text.toLowerCase()} · ${fmtKm(after.at - next.at)}` : "";
    box.classList.toggle("soon", rem < 0.3 && rem >= 0.02);
  }

  function setProgress(t) {
    $("progFill").style.width = (t * 100).toFixed(1) + "%";
    const s = state.route?.stats;
    $("progText").textContent = s ? `${fmtKm(s.dist * t)} / ${fmtKm(s.dist)}  ·  remaining ${fmtTime(s.etaH * (1 - t))}` : "NO ROUTE";
  }

  function drawProfile() {
    const cv = $("profile"), ctx = cv.getContext("2d");
    const w = cv.width = cv.clientWidth * devicePixelRatio, h = cv.height = cv.clientHeight * devicePixelRatio;
    ctx.clearRect(0, 0, w, h);
    const p = state.route?.path;
    if (!p) { ctx.fillStyle = "rgba(57,215,255,.4)"; ctx.font = `${11 * devicePixelRatio}px monospace`; ctx.fillText("ELEVATION PROFILE — no route", 8, h / 2); return; }
    const cum = state.route.cum, total = cum[cum.length - 1] || 1;
    const zs = p.map(q => q[2]), zmin = Math.min(...zs), zmax = Math.max(...zs), span = Math.max(1, zmax - zmin);
    const X = (i) => (cum[i] / total) * (w - 10) + 5, Y = (v) => h - 6 - ((v - zmin) / span) * (h - 22);
    ctx.beginPath(); ctx.moveTo(X(0), h);
    zs.forEach((v, i) => ctx.lineTo(X(i), Y(v)));
    ctx.lineTo(X(p.length - 1), h); ctx.closePath();
    ctx.fillStyle = "rgba(57,215,255,.15)"; ctx.fill();
    ctx.beginPath(); zs.forEach((v, i) => i ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(i), Y(v)));
    ctx.strokeStyle = "#39d7ff"; ctx.lineWidth = 1.5 * devicePixelRatio; ctx.stroke();
    if (state.sim) {
      const x = 5 + state.sim.t * (w - 10);
      ctx.strokeStyle = "#fff"; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
    }
    ctx.fillStyle = "#9fe9ff"; ctx.font = `${10 * devicePixelRatio}px monospace`;
    ctx.fillText(`${Math.round(zmax)} m`, 6, 12 * devicePixelRatio);
    ctx.fillText(`${Math.round(zmin)} m`, 6, h - 4);
  }

  // ---------- drive simulation + follow camera ----------
  // Distance advances by speed × time warp, so speed changes apply immediately.
  // The button pauses/resumes; changing the route or CLEAR resets it.
  function toggleSimulation() {
    if (!state.route) return;
    if (state.sim?.running) {                       // pause
      state.sim.running = false;
      $("btnSim").textContent = "▶ RESUME";
      status("Paused");
      return;
    }
    const total = state.route.stats.dist;
    if (!state.sim || state.sim.d >= total) {
      state.sim = { d: 0, t: 0, heading: 0, smoothHeading: null, smoothTilt: null };
    }
    state.sim.running = true;
    state.sim.last = performance.now();
    $("btnSim").textContent = "❚❚ PAUSE";
    status("Navigating…");
    requestAnimationFrame(step);
  }

  // Vehicle position, heading and grade (next ~300 m) at a distance along the route
  function poseAt(d) {
    const { path, cum } = state.route;
    let i = 1; while (i < cum.length - 1 && cum[i] < d) i++;
    const f = (d - cum[i - 1]) / ((cum[i] - cum[i - 1]) || 1);
    const a = path[i - 1], b = path[i];
    const pos = { x: a[0] + (b[0] - a[0]) * f, y: a[1] + (b[1] - a[1]) * f, z: a[2] + (b[2] - a[2]) * f };
    const heading = bearing(P(a), P(b));
    let j = i; while (j < cum.length - 1 && cum[j] - d < 0.3) j++;
    const ahead = Math.max(0.05, cum[j] - d);
    const grade = Math.atan((path[j][2] - pos.z) / (ahead * 1000)) / toR;
    return { pos, heading, grade };
  }

  function step(now) {
    const sim = state.sim;
    if (!sim?.running || !state.route) return;
    const { path, cum } = state.route;
    const total = cum[cum.length - 1];
    const dtH = Math.min(0.25, (now - sim.last) / 1000) / 3600;   // hours of real time (capped if the tab slept)
    sim.last = now;
    sim.d = Math.min(total, sim.d + NAV_SETTINGS.speedKmh * NAV_SETTINGS.timeWarp * dtH);
    const d = sim.d, t = d / total;

    const { pos, heading, grade } = poseAt(d);

    // Smoothed camera heading and pitch
    const k = NAV_SETTINGS.camSmoothing;
    const sh = sim.smoothHeading ?? heading;
    const smoothHeading = (sh + (((heading - sh + 540) % 360) - 180) * k + 360) % 360;
    const targetTilt = Math.max(NAV_SETTINGS.camTiltMin, Math.min(NAV_SETTINGS.camTiltMax,
                         NAV_SETTINGS.camTiltBase + NAV_SETTINGS.camPitchGain * grade));
    const st = sim.smoothTilt ?? targetTilt;
    const smoothTilt = st + (targetTilt - st) * k;

    Object.assign(sim, { pos, heading, smoothHeading, smoothTilt, t, grade });
    $("hudHeading").textContent = Math.round(heading) + "°";
    $("hudRad").textContent = `${radRate(pos.z).toFixed(2)} mSv/day`;
    setCompass(heading, grade);
    updateGuidance(d);
    setProgress(t); drawProfile(); updateSimGraphic(); updateCamReadout();
    if (state.follow) followCamera(pos, smoothHeading, smoothTilt, grade);
    else if (state.track) trackVehicle(pos);

    if (d < total) requestAnimationFrame(step);
    else {
      sim.running = false;
      $("btnSim").textContent = "▶ RESTART";
      status("Destination reached");
    }
  }

  // Camera height grows with speed (faster = zoomed out, like Waze on a highway)
  const camAltitude = () => NAV_SETTINGS.camAltBaseM + NAV_SETTINGS.camAltPerKmh * NAV_SETTINGS.speedKmh;

  function updateCamReadout() {
    $("hudSpeed").textContent = `${NAV_SETTINGS.speedKmh} km/h · ${NAV_SETTINGS.timeWarp}×`;
    const tilt = state.sim?.smoothTilt ?? NAV_SETTINGS.camTiltBase;
    $("hudCam").textContent = `${Math.round(camAltitude())} m · ${Math.round(tilt)}°`;
  }

  // Free screen area between the HUD panels, in pixels from each edge of the map
  function hudPadding(view) {
    const vr = view.container.getBoundingClientRect();
    const box = (id) => { const el = document.getElementById(id); return el && !el.hidden ? el.getBoundingClientRect() : null; };
    const L = box("left"), R = box("right"), T = box("guidance") || box("topbar"), B = box("bottom");
    let pad = {
      left: L ? Math.max(0, L.right - vr.left) + 20 : 40,
      right: R ? Math.max(0, vr.right - R.left) + 20 : 40,
      top: T ? Math.max(0, T.bottom - vr.top) + 20 : 40,
      bottom: B ? Math.max(0, vr.bottom - B.top) + 20 : 40
    };
    // never let the panels take more than 70 % of the screen (small windows)
    const kx = Math.min(1, 0.7 * vr.width / Math.max(1, pad.left + pad.right));
    const ky = Math.min(1, 0.7 * vr.height / Math.max(1, pad.top + pad.bottom));
    return { W: vr.width, H: vr.height, left: pad.left * kx, right: pad.right * kx, top: pad.top * ky, bottom: pad.bottom * ky };
  }

  // Route overview: straight down, north-up, the route (or start/end) fitted between the panels.
  // The camera is computed directly (zoom from the route size, center shifted for the panels),
  // which works the same in 2D and 3D.
  function showOverview() {
    const view = getView();
    if (!view || !view.ready) return;
    const pts = state.route ? state.route.path
              : [state.start, state.end].filter(Boolean).map(p => [p.x, p.y, 0]);
    if (!pts.length) { status("Nothing to fit yet — set a start and destination"); return; }
    const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    const spanXm = Math.max(500, (Math.max(...xs) - Math.min(...xs)) * KM_PER_DEG * Math.cos(cy * toR) * 1000);
    const spanYm = Math.max(500, (Math.max(...ys) - Math.min(...ys)) * KM_PER_DEG * 1000);
    const pad = hudPadding(view);
    const availW = Math.max(100, pad.W - pad.left - pad.right), availH = Math.max(100, pad.H - pad.top - pad.bottom);
    const mPerPx = Math.max(spanXm / availW, spanYm / availH) * 1.15;          // 15 % margin
    // move the camera so the route's center lands in the middle of the free area
    const shiftE = -((pad.left - pad.right) / 2) * mPerPx / 1000;              // km east
    const shiftN = ((pad.top - pad.bottom) / 2) * mPerPx / 1000;               // km north
    const c = offset(offset({ x: cx, y: cy }, 90, shiftE), 0, shiftN);
    const zMean = pts.reduce((s, p) => s + (p[2] || 0), 0) / pts.length;

    if (view.type === "3d") {
      const fov = (view.camera?.fov || 55) * toR;                              // camera field of view
      const alt = (Math.max(pad.W, pad.H) / 2) * mPerPx / Math.tan(fov / 2);
      view.goTo(new Camera({
        position: { type: "point", x: c.x, y: c.y, z: zMean + alt, spatialReference: MARS_SR },
        heading: 0, tilt: 0
      }), { duration: 1200 }).catch(() => {});
    } else {
      view.goTo({ center: { type: "point", x: c.x, y: c.y, spatialReference: MARS_SR },
                  scale: mPerPx * 96 / 0.0254, rotation: 0 }, { duration: 1200 }).catch(() => {});
    }
  }

  // Overview + TRACK: keep the vehicle centered, north-up, straight down, keeping the user's zoom
  function trackVehicle(pos, animate = false) {
    const view = getView();
    if (!view || !view.ready || !pos) return;
    const z = pos.z ?? 0;
    if (view.type === "3d") {
      const cur = view.camera;
      // current height above the vehicle = the zoom the user picked (mouse wheel still works)
      const h = cur && cur.tilt < 5 ? Math.max(300, cur.position.z - z) : 15000;
      const cam = new Camera({ position: { type: "point", x: pos.x, y: pos.y, z: z + h, spatialReference: MARS_SR },
                               heading: 0, tilt: 0 });
      if (animate) view.goTo(cam, { duration: 800 }).catch(() => {}); else view.camera = cam;
    } else {
      const center = { type: "point", x: pos.x, y: pos.y, spatialReference: MARS_SR };
      if (animate) view.goTo({ center, rotation: 0 }, { duration: 800 }).catch(() => {});
      else { view.center = center; if (view.rotation) view.rotation = 0; }
    }
  }

  // Waze-style camera: 3D = behind and above the vehicle looking forward; 2D = heading-up.
  function followCamera(pos, heading, tilt, grade) {
    const view = getView();
    if (!view || !view.ready) return;
    const alt = camAltitude();
    if (view.type === "3d") {
      // Look-at point lies alt·tan(tilt) ahead of the camera; put the camera ~60 % of
      // that distance behind the vehicle so it sits in the lower part of the screen.
      const lookKm = (alt * Math.tan(Math.min(tilt, 85) * toR)) / 1000;
      const backKm = lookKm * 0.6;
      const camPos = offset(pos, (heading + 180) % 360, backKm);
      // Stay above rising ground behind/ahead when climbing steeply
      const lift = Math.max(0, Math.tan(grade * toR) * backKm * 1000);
      view.camera = new Camera({
        position: { type: "point", x: camPos.x, y: camPos.y, z: pos.z + alt + lift, spatialReference: MARS_SR },
        heading, tilt
      });
    } else {
      view.center = { type: "point", x: pos.x, y: pos.y, spatialReference: MARS_SR };
      view.rotation = (360 - heading) % 360;   // heading-up
      view.scale = alt * 60;                   // same speed → zoom rule as in 3D
    }
  }

  function stopSim() {
    if (state.sim) state.sim.running = false;
    state.sim = null;
    $("btnSim").textContent = "▶ SIMULATE";
    updateSimGraphic();
    const v = getView();
    if (v && v.type === "2d" && v.rotation) v.rotation = 0;   // back to north-up
  }

  // ---------- settings panel ----------
  function buildSettings() {
    const box = $("settingsBody");
    box.replaceChildren();
    for (const [key, label, min, max, stepV, unit] of NAV_SETTINGS_UI) {
      if (!label) {   // section header
        const h = document.createElement("div"); h.className = "set-h"; h.textContent = key; box.append(h); continue;
      }
      const row = document.createElement("label"); row.className = "set-row";
      const name = document.createElement("span"); name.textContent = label;
      const val = document.createElement("span"); val.className = "set-val";
      const input = document.createElement("input");
      const isBool = min === "bool";
      if (isBool) Object.assign(input, { type: "checkbox", checked: !!NAV_SETTINGS[key] });
      else Object.assign(input, { type: "range", min, max, step: stepV, value: NAV_SETTINGS[key] });
      const show = () => { val.textContent = isBool ? (NAV_SETTINGS[key] ? "ON" : "OFF") : `${NAV_SETTINGS[key]} ${unit}`; };
      input.oninput = () => {
        NAV_SETTINGS[key] = isBool ? input.checked : parseFloat(input.value);
        if (["useCraters", "craterMinKm", "craterMaxKm", "craterMargin", "maxSlopeDeg", "slopeWeight",
             "pathSmoothing", "minTurnDeg", "simplifyCells"].includes(key)) inputsChanged();
        if (key === "camTiltMin" && NAV_SETTINGS.camTiltMin > NAV_SETTINGS.camTiltMax) NAV_SETTINGS.camTiltMax = NAV_SETTINGS.camTiltMin;
        show(); applySettings();
      };
      show();
      if (isBool) row.classList.add("bool");
      row.append(name, val, input); box.append(row);
    }
  }
  let saveTimer = null;
  function applySettings() {
    if (state.route) {
      state.route.stats.etaH = state.route.stats.dist / NAV_SETTINGS.speedKmh;
      state.route.stats.doseMSv = routeDose(state.route);   // slower = longer exposure
      $("hudDose").textContent = `${state.route.stats.doseMSv.toFixed(3)} mSv`;
    }
    updateCamReadout();
    if (!state.sim) updateHud(); else setProgress(state.sim.t);
    saveSettings();
  }
  function saveSettings() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { try { localStorage.setItem("marsNavSettings", JSON.stringify({ ...NAV_SETTINGS, _v: NAV_SETTINGS_VERSION })); } catch (e) {} }, 300);
  }
  $("btnSettings").onclick = () => { $("settings").hidden = !$("settings").hidden; };
  $("btnSettingsClose").onclick = () => { $("settings").hidden = true; };
  $("btnSettingsReset").onclick = () => { Object.assign(NAV_SETTINGS, NAV_DEFAULTS); buildSettings(); applySettings(); };
  // Keyboard: + / - change speed by 5 km/h while driving
  window.addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT") return;
    if (e.key === "+" || e.key === "=") NAV_SETTINGS.speedKmh = Math.min(120, NAV_SETTINGS.speedKmh + 5);
    else if (e.key === "-") NAV_SETTINGS.speedKmh = Math.max(1, NAV_SETTINGS.speedKmh - 5);
    else return;
    buildSettings(); applySettings();
  });
  buildSettings();
  updateCamReadout();

  updateHud();
  return { attach, computeRoute, state, settings: NAV_SETTINGS };
}