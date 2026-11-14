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
  speedKmh: 8,           // rover speed used for ETA
  simSeconds: 60,        // real-time length of the drive simulation
  minTurnDeg: 20,        // smaller direction changes are "continue straight"
  camAltitudeM: 450,     // follow camera height above the vehicle
  camTilt: 72            // follow camera tilt (0 = looking straight down)
};

function initNav({ map, getView, MARS_SR, loadModules }) {
  const state = {
    mode: null,           // "start" | "end" | "hazard" | null
    start: null, end: null,
    hazards: [],          // { x, y, radiusKm, name }
    route: null,          // { path, cum, waypoints, maneuvers, stats }
    sim: null,
    follow: true
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
         : state.mode ? `Click on the map to place the ${state.mode === "end" ? "destination" : "start"}` : "Ready");
  };
  $("btnStart").onclick = () => setMode("start");
  $("btnEnd").onclick = () => setMode("end");
  $("btnHazard").onclick = () => setMode("hazard");
  $("btnRoute").onclick = () => computeRoute();
  $("btnSim").onclick = () => toggleSimulation();
  $("btnFollow").onclick = () => {
    state.follow = !state.follow;
    $("btnFollow").classList.toggle("active", state.follow);
  };
  $("btnFollow").classList.toggle("active", state.follow);
  $("hazardRadius").value = String(NAV_SETTINGS.hazardRadiusKm);
  $("hazardRadius").onchange = (e) => { NAV_SETTINGS.hazardRadiusKm = parseFloat(e.target.value); };
  $("btnClear").onclick = () => {
    stopSim(); state.start = state.end = state.route = null;
    state.hazards = state.hazards.filter(h => h.fromFile);
    updateHud(); redraw(); status("Cleared");
  };

  function status(msg) { $("navStatus").textContent = msg; }

  // Called every time a 2D or 3D view is created
  function attach(view) {
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
      // Re-plan automatically whenever start, end or hazards change
      if (state.start && state.end) computeRoute();
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
      updateHud(); redraw();
      const avoided = state.hazards.filter(h => h.nearRoute).length;
      status(`Route ready · ${state.route.maneuvers.length - 1} turns · ${avoided} hazard zone(s) avoided nearby`);
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

    // Hazard zones are blocked with a safety margin of one grid cell, so the
    // straight segments between cells can't cut through the edge of a zone.
    const cellKm = Math.max(dx * KM_PER_DEG * Math.cos(((ymin + ymax) / 2) * toR), dy * KM_PER_DEG);
    const margin = cellKm * 0.75;
    const blocked = new Uint8Array(rows * cols);
    state.hazards.forEach(h => h.nearRoute = false);
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const p = cellPos(r, c);
      for (const h of state.hazards) if (distKm(p, h) <= h.radiusKm + margin) { blocked[idx(r, c)] = 1; break; }
    }
    const toCell = (p) => [Math.round((p.y - ymin) / dy), Math.round((p.x - xmin) / dx)];
    const s = toCell(start), g = toCell(end);
    blocked[idx(...s)] = 0; blocked[idx(...g)] = 0;   // never block the endpoints themselves

    status("Searching path…");
    const path = aStar({ rows, cols, z, blocked, cellPos, start: s, goal: g });
    if (!path) return null;
    const full = path.map(([r, c]) => { const p = cellPos(r, c); return [p.x, p.y, z[idx(r, c)]]; });
    full[0] = [start.x, start.y, full[0][2]];
    full[full.length - 1] = [end.x, end.y, full[full.length - 1][2]];

    // Which hazards does the route pass close to (within 2 radii)?
    for (const h of state.hazards) h.nearRoute = full.some(p => distKm(P(p), h) <= h.radiusKm * 2 + cellKm);
    return { path: full, tol: Math.max(dx, dy) * 1.5 };
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
    return {
      path, cum, maneuvers,
      stats: { dist, straight: distKm(state.start, state.end), gain, loss, maxSlope, etaH: dist / NAV_SETTINGS.speedKmh }
    };
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

    if (state.route) {
      const paths = [state.route.path.map(p => [p[0], p[1]])];
      layer.add(new Graphic({ geometry: { type: "polyline", paths, spatialReference: sr },
        symbol: { type: "simple-line", color: [...CYAN, 0.35], width: 10, cap: "round", join: "round" } }));
      layer.add(new Graphic({ geometry: { type: "polyline", paths, spatialReference: sr },
        symbol: { type: "simple-line", color: [240, 252, 255, 1], width: 3, cap: "round", join: "round" } }));
      state.route.maneuvers.slice(0, -1).forEach((m) => {
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
    $("hudHazards").textContent = state.hazards.length;
    $("btnSim").disabled = !state.route;
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
  function toggleSimulation() {
    if (state.sim?.running) { stopSim(); updateHud(); return; }
    if (!state.route) return;
    const { path, cum } = state.route;
    const total = cum[cum.length - 1];
    const startT = state.sim?.t && state.sim.t < 1 ? state.sim.t : 0;
    const t0 = performance.now() - startT * NAV_SETTINGS.simSeconds * 1000;
    state.sim = { running: true, t: startT, heading: 0, smoothHeading: null };
    $("btnSim").textContent = "■ STOP";
    status("Navigating…");

    const step = (now) => {
      if (!state.sim?.running) return;
      const t = Math.min(1, (now - t0) / (NAV_SETTINGS.simSeconds * 1000));
      const d = t * total;
      let i = 1; while (i < cum.length - 1 && cum[i] < d) i++;
      const f = (d - cum[i - 1]) / ((cum[i] - cum[i - 1]) || 1);
      const a = path[i - 1], b = path[i];
      const pos = { x: a[0] + (b[0] - a[0]) * f, y: a[1] + (b[1] - a[1]) * f, z: a[2] + (b[2] - a[2]) * f };
      const heading = bearing(P(a), P(b));

      // Grade over the next ~300 m (smoother than a single grid step)
      let j = i; while (j < cum.length - 1 && cum[j] - d < 0.3) j++;
      const ahead = Math.max(0.05, cum[j] - d);
      const grade = Math.atan((path[j][2] - pos.z) / (ahead * 1000)) / toR;

      // Smooth the camera heading so it doesn't snap at every grid step
      const sh = state.sim.smoothHeading ?? heading;
      const diff = ((heading - sh + 540) % 360) - 180;
      const smooth = (sh + diff * 0.08 + 360) % 360;

      Object.assign(state.sim, { pos, heading, smoothHeading: smooth, t, d, grade });
      $("hudHeading").textContent = Math.round(heading) + "°";
      setCompass(heading, grade);
      updateGuidance(d);
      setProgress(t); drawProfile(); updateSimGraphic();
      if (state.follow) followCamera(pos, smooth);

      if (t < 1) requestAnimationFrame(step);
      else {
        state.sim.running = false;
        $("btnSim").textContent = "▶ SIMULATE";
        status("Destination reached");
      }
    };
    requestAnimationFrame(step);
  }

  // Waze-style camera: 3D = behind and above the vehicle looking forward; 2D = heading-up, zoomed in.
  function followCamera(pos, heading) {
    const view = getView();
    if (!view || !view.ready) return;
    if (view.type === "3d") {
      const { camAltitudeM, camTilt } = NAV_SETTINGS;
      const backKm = (camAltitudeM * Math.tan(camTilt * toR)) / 1000 * 0.6;
      const camPos = offset(pos, (heading + 180) % 360, backKm);
      view.camera = new Camera({
        position: { type: "point", x: camPos.x, y: camPos.y, z: pos.z + camAltitudeM, spatialReference: MARS_SR },
        heading, tilt: camTilt
      });
    } else {
      view.center = { type: "point", x: pos.x, y: pos.y, spatialReference: MARS_SR };
      view.rotation = (360 - heading) % 360;   // heading-up
      if (view.scale > 120000) view.scale = 60000;
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

  updateHud();
  return { attach, computeRoute, state, settings: NAV_SETTINGS };
}