// =====================================================================
//  MARS NAVIGATION — route planner + HUD overlay
//  Pick a start and a destination on the map; the planner finds a path that
//  avoids steep terrain and hazard zones, draws it, and can simulate the drive.
//
//  How the route is found:
//   1. A grid (about 90 x 90 cells) is laid over the area between start and end.
//   2. The real elevation of every cell is read from the Mars elevation service.
//   3. Each cell gets a cost: distance x (1 + slope penalty). Cells that are too
//      steep (> maxSlopeDeg) or inside a hazard circle are blocked.
//   4. A* search finds the cheapest path; it is then simplified into waypoints.
//  Hazards: points with "kind": "hazard" in mission.geojson ("radius_km" sets the size)
//  plus any you place with the "Hazard" button.
// =====================================================================

const MARS_RADIUS_KM = 3396.19;
const KM_PER_DEG = (Math.PI * MARS_RADIUS_KM) / 180;   // ≈ 59.27 km per degree of latitude

const NAV_SETTINGS = {
  gridSize: 90,          // cells along the longer side of the search area
  maxSlopeDeg: 20,       // steeper than this = impassable
  slopeWeight: 0.15,     // extra cost per degree of slope
  hazardRadiusKm: 2,     // size of hazards placed with the button
  speedKmh: 8,           // rover speed used for ETA and simulation
  simSeconds: 40         // real-time length of the drive simulation
};

function initNav({ map, getView, MARS_SR, loadModules }) {
  const state = {
    mode: null,           // "start" | "end" | "hazard" | null
    start: null, end: null,
    hazards: [],          // { x, y, radiusKm, name }
    route: null,          // { path: [[x,y,z]...], waypoints, stats }
    sim: null
  };

  let GraphicsLayer, Graphic, Multipoint, layer, elevation;
  const ready = (async () => {
    [GraphicsLayer, Graphic, Multipoint] = await loadModules([
      "esri/layers/GraphicsLayer", "esri/Graphic", "esri/geometry/Multipoint"
    ]);
    layer = new GraphicsLayer({ title: "Navigation", elevationInfo: { mode: "on-the-ground" }, listMode: "show" });
    map.add(layer);
    elevation = map.ground.layers.getItemAt(0);
    await loadMissionHazards();
    redraw();
  })();

  // ---------- UI wiring ----------
  const $ = (id) => document.getElementById(id);
  const setMode = (m) => {
    state.mode = state.mode === m ? null : m;
    ["btnStart", "btnEnd", "btnHazard"].forEach(id => $(id).classList.remove("active"));
    if (state.mode) $({ start: "btnStart", end: "btnEnd", hazard: "btnHazard" }[state.mode]).classList.add("active");
    status(state.mode ? `Click on the map to place the ${state.mode === "end" ? "destination" : state.mode}` : "Ready");
  };
  $("btnStart").onclick = () => setMode("start");
  $("btnEnd").onclick = () => setMode("end");
  $("btnHazard").onclick = () => setMode("hazard");
  $("btnRoute").onclick = () => computeRoute();
  $("btnSim").onclick = () => toggleSimulation();
  $("btnClear").onclick = () => { stopSim(); state.start = state.end = state.route = null; state.hazards = state.hazards.filter(h => h.fromFile); updateHud(); redraw(); status("Cleared"); };

  function status(msg) { $("navStatus").textContent = msg; }

  // Called every time a 2D or 3D view is created
  function attach(view) {
    view.on("click", (e) => {
      if (!state.mode || !e.mapPoint) return;
      e.stopPropagation();   // don't open popups while placing points
      const p = { x: e.mapPoint.x, y: e.mapPoint.y };
      if (state.mode === "start") state.start = p;
      if (state.mode === "end") state.end = p;
      if (state.mode === "hazard") state.hazards.push({ ...p, radiusKm: NAV_SETTINGS.hazardRadiusKm, name: "Hazard" });
      const placed = state.mode;
      setMode(null);
      state.route = null; stopSim();
      updateHud(); redraw();
      if (state.start && state.end && placed !== "hazard") computeRoute();
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
  const distKm = (a, b) => {
    const toR = Math.PI / 180;
    const dLat = (b.y - a.y) * toR, dLon = (b.x - a.x) * toR;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.y * toR) * Math.cos(b.y * toR) * Math.sin(dLon / 2) ** 2;
    return 2 * MARS_RADIUS_KM * Math.asin(Math.sqrt(h));
  };
  const bearing = (a, b) => {
    const toR = Math.PI / 180;
    const y = Math.sin((b.x - a.x) * toR) * Math.cos(b.y * toR);
    const x = Math.cos(a.y * toR) * Math.sin(b.y * toR) - Math.sin(a.y * toR) * Math.cos(b.y * toR) * Math.cos((b.x - a.x) * toR);
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  };
  const circle = (c, rKm, n = 48) => {
    const ring = [];
    const dLat = rKm / KM_PER_DEG, dLon = rKm / (KM_PER_DEG * Math.cos(c.y * Math.PI / 180));
    for (let i = 0; i <= n; i++) {
      const t = (i / n) * 2 * Math.PI;
      ring.push([c.x + dLon * Math.cos(t), c.y + dLat * Math.sin(t)]);
    }
    return ring;
  };

  // ---------- route planning ----------
  async function computeRoute() {
    await ready;
    if (!state.start || !state.end) { status("Set a start and a destination first"); return; }
    stopSim();
    status("Reading terrain…");
    $("btnRoute").disabled = true;
    try {
      const { start, end } = state;
      // Search area: box around start/end with 35% padding (at least ~6 km)
      const pad = Math.max(0.1, 0.35 * Math.max(Math.abs(end.x - start.x), Math.abs(end.y - start.y)));
      const xmin = Math.min(start.x, end.x) - pad, xmax = Math.max(start.x, end.x) + pad;
      const ymin = Math.min(start.y, end.y) - pad, ymax = Math.max(start.y, end.y) + pad;
      const N = NAV_SETTINGS.gridSize;
      const aspect = ((xmax - xmin) * Math.cos(((ymin + ymax) / 2) * Math.PI / 180)) / (ymax - ymin);
      const cols = aspect >= 1 ? N : Math.max(10, Math.round(N * aspect));
      const rows = aspect >= 1 ? Math.max(10, Math.round(N / aspect)) : N;
      const dx = (xmax - xmin) / (cols - 1), dy = (ymax - ymin) / (rows - 1);

      // Elevation for every grid cell, in one request
      const pts = [];
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) pts.push([xmin + c * dx, ymin + r * dy]);
      const mp = new Multipoint({ points: pts, spatialReference: MARS_SR });
      const res = await elevation.queryElevation(mp, { demResolution: "finest-contiguous" });
      const z = res.geometry.points.map(p => p[2]);

      // Blocked cells (hazards)
      const blocked = new Uint8Array(rows * cols);
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
        const p = { x: xmin + c * dx, y: ymin + r * dy };
        if (state.hazards.some(h => distKm(p, h) <= h.radiusKm)) blocked[r * cols + c] = 1;
      }

      const idx = (r, c) => r * cols + c;
      const toCell = (p) => [Math.round((p.y - ymin) / dy), Math.round((p.x - xmin) / dx)];
      const [sr, sc] = toCell(start), [er, ec] = toCell(end);
      blocked[idx(sr, sc)] = 0; blocked[idx(er, ec)] = 0;   // never block the endpoints themselves

      const cellPos = (r, c) => ({ x: xmin + c * dx, y: ymin + r * dy });
      status("Searching path…");
      const path = aStar({ rows, cols, z, blocked, cellPos, start: [sr, sc], goal: [er, ec] });
      if (!path) {
        state.route = null; redraw(); updateHud();
        status("No safe route found — terrain too steep or blocked by hazards");
        return;
      }

      const full = path.map(([r, c]) => { const p = cellPos(r, c); return [p.x, p.y, z[idx(r, c)]]; });
      full[0] = [start.x, start.y, full[0][2]];
      full[full.length - 1] = [end.x, end.y, full[full.length - 1][2]];

      // Stats
      let dist = 0, gain = 0, loss = 0, maxSlope = 0;
      for (let i = 1; i < full.length; i++) {
        const a = { x: full[i - 1][0], y: full[i - 1][1] }, b = { x: full[i][0], y: full[i][1] };
        const d = distKm(a, b), dz = full[i][2] - full[i - 1][2];
        dist += d;
        if (dz > 0) gain += dz; else loss -= dz;
        if (d > 0) maxSlope = Math.max(maxSlope, Math.abs(Math.atan(dz / (d * 1000)) * 180 / Math.PI));
      }
      const straight = distKm(start, end);
      state.route = {
        path: full,
        waypoints: simplify(full, Math.max(dx, dy) * 1.5),
        stats: { dist, straight, gain, loss, maxSlope, etaH: dist / NAV_SETTINGS.speedKmh }
      };
      updateHud(); redraw();
      status(`Route ready · ${state.route.waypoints.length - 2} turn points · avoids ${state.hazards.length} hazard(s)`);
    } catch (err) {
      console.error("Route failed:", err);
      status("Route failed: " + err.message);
    } finally {
      $("btnRoute").disabled = false;
    }
  }

  function aStar({ rows, cols, z, blocked, cellPos, start, goal }) {
    const { maxSlopeDeg, slopeWeight } = NAV_SETTINGS;
    const n = rows * cols, idx = (r, c) => r * cols + c;
    const g = new Float64Array(n).fill(Infinity), came = new Int32Array(n).fill(-1);
    const closed = new Uint8Array(n);
    const goalP = cellPos(goal[0], goal[1]);
    const h = (r, c) => distKm(cellPos(r, c), goalP);
    // Small binary heap
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
        const slope = Math.abs(Math.atan((z[ni] - z[cur]) / (d * 1000)) * 180 / Math.PI);
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

  // Douglas–Peucker simplification → turn points
  function simplify(pts, tol) {
    if (pts.length < 3) return pts.slice();
    const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
    const stack = [[0, pts.length - 1]];
    while (stack.length) {
      const [a, b] = stack.pop();
      let maxD = 0, mi = -1;
      const [x1, y1] = pts[a], [x2, y2] = pts[b];
      for (let i = a + 1; i < b; i++) {
        const [x, y] = pts[i];
        const num = Math.abs((y2 - y1) * x - (x2 - x1) * y + x2 * y1 - y2 * x1);
        const den = Math.hypot(y2 - y1, x2 - x1) || 1e-12;
        const d = num / den;
        if (d > maxD) { maxD = d; mi = i; }
      }
      if (maxD > tol) { keep[mi] = 1; stack.push([a, mi], [mi, b]); }
    }
    return pts.filter((_, i) => keep[i]);
  }

  // ---------- drawing ----------
  const CYAN = [57, 215, 255];
  function redraw() {
    if (!layer) return;
    layer.removeAll();
    simHalo = simArrow = null;
    const sr = MARS_SR;

    for (const hz of state.hazards) {
      layer.add(new Graphic({
        geometry: { type: "polygon", rings: [circle(hz, hz.radiusKm)], spatialReference: sr },
        symbol: { type: "simple-fill", color: [255, 60, 60, 0.18], outline: { color: [255, 80, 80, 0.9], width: 1.5, style: "dash" } },
        attributes: { name: hz.name }
      }));
      layer.add(new Graphic({
        geometry: { type: "point", x: hz.x, y: hz.y, spatialReference: sr },
        symbol: { type: "text", text: "⚠ " + hz.name.toUpperCase(), color: [255, 110, 110], haloColor: "black", haloSize: 1,
                  font: { size: 9, family: "monospace", weight: "bold" } }
      }));
    }

    if (state.route) {
      const paths = [state.route.path.map(p => [p[0], p[1]])];
      // glow + core line
      layer.add(new Graphic({ geometry: { type: "polyline", paths, spatialReference: sr },
        symbol: { type: "simple-line", color: [...CYAN, 0.35], width: 9, cap: "round", join: "round" } }));
      layer.add(new Graphic({ geometry: { type: "polyline", paths, spatialReference: sr },
        symbol: { type: "simple-line", color: [240, 252, 255, 1], width: 3, cap: "round", join: "round" } }));
      // turn-point rings
      state.route.waypoints.slice(1, -1).forEach((w, i) => {
        layer.add(new Graphic({ geometry: { type: "point", x: w[0], y: w[1], spatialReference: sr },
          symbol: { type: "simple-marker", style: "circle", size: 14, color: [0, 0, 0, 0], outline: { color: [...CYAN, 1], width: 2 } } }));
        layer.add(new Graphic({ geometry: { type: "point", x: w[0], y: w[1], spatialReference: sr },
          symbol: { type: "text", text: `WP${i + 1}`, color: [...CYAN, 1], haloColor: "black", haloSize: 1, yoffset: 12,
                    font: { size: 9, family: "monospace", weight: "bold" } } }));
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

  }

  // The moving vehicle is kept in its own two graphics and only moved each frame
  // (redrawing everything 60 times a second would be slow, especially in 3D).
  let simHalo = null, simArrow = null;
  function updateSimGraphic() {
    if (!layer) return;
    if (!state.sim?.pos) {
      if (simHalo) { layer.removeMany([simHalo, simArrow]); simHalo = simArrow = null; }
      return;
    }
    const geometry = { type: "point", x: state.sim.pos[0], y: state.sim.pos[1], spatialReference: MARS_SR };
    if (!simHalo) {
      simHalo = new Graphic({ geometry, symbol: { type: "simple-marker", style: "circle", size: 34,
        color: [...CYAN, 0.12], outline: { color: [...CYAN, 0.9], width: 1.5 } } });
      simArrow = new Graphic({ geometry, symbol: { type: "simple-marker", style: "path",
        path: "M0 -12 L8 10 L0 5 L-8 10 Z", size: 18, color: [...CYAN, 1], outline: { color: "white", width: 1 } } });
      layer.addMany([simHalo, simArrow]);
    }
    simHalo.geometry = geometry;
    simArrow.geometry = geometry;
    const sym = simArrow.symbol.clone(); sym.angle = state.sim.heading; simArrow.symbol = sym;
  }

  // ---------- HUD ----------
  const fmt = (p) => p ? `${p.y >= 0 ? "N" : "S"} ${Math.abs(p.y).toFixed(3)}°  ${p.x >= 0 ? "E" : "W"} ${Math.abs(p.x).toFixed(3)}°` : "— not set —";
  function updateHud() {
    $("hudStart").textContent = fmt(state.start);
    $("hudDest").textContent = fmt(state.end);
    const s = state.route?.stats;
    $("hudDist").textContent = s ? s.dist.toFixed(1) + " km" : "--";
    $("hudStraight").textContent = s ? s.straight.toFixed(1) + " km" : (state.start && state.end ? distKm(state.start, state.end).toFixed(1) + " km" : "--");
    $("hudEta").textContent = s ? fmtTime(s.etaH) : "--";
    $("hudGain").textContent = s ? `+${Math.round(s.gain)} / -${Math.round(s.loss)} m` : "--";
    $("hudSlope").textContent = s ? s.maxSlope.toFixed(1) + "°" : "--";
    $("hudHeading").textContent = state.start && state.end ? Math.round(bearing(state.start, state.end)) + "°" : "--";
    $("hudHazards").textContent = state.hazards.length;
    if (!state.sim && state.start && state.end) $("compassNeedle").style.transform = `rotate(${bearing(state.start, state.end)}deg)`;
    $("btnSim").disabled = !state.route;
    setProgress(state.sim ? state.sim.t : 0);
    drawProfile();
  }
  const fmtTime = (h) => { const m = Math.round(h * 60); return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`; };

  function setProgress(t) {
    $("progFill").style.width = (t * 100).toFixed(1) + "%";
    const s = state.route?.stats;
    $("progText").textContent = s ? `${(s.dist * t).toFixed(1)} / ${s.dist.toFixed(1)} km  ·  remaining ${fmtTime(s.etaH * (1 - t))}` : "NO ROUTE";
  }

  function drawProfile() {
    const cv = $("profile"), ctx = cv.getContext("2d");
    const w = cv.width = cv.clientWidth * devicePixelRatio, h = cv.height = cv.clientHeight * devicePixelRatio;
    ctx.clearRect(0, 0, w, h);
    const p = state.route?.path;
    if (!p) { ctx.fillStyle = "rgba(57,215,255,.4)"; ctx.font = `${11 * devicePixelRatio}px monospace`; ctx.fillText("ELEVATION PROFILE — no route", 8, h / 2); return; }
    const zs = p.map(q => q[2]), zmin = Math.min(...zs), zmax = Math.max(...zs), span = Math.max(1, zmax - zmin);
    const X = (i) => (i / (p.length - 1)) * (w - 10) + 5, Y = (v) => h - 6 - ((v - zmin) / span) * (h - 22);
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

  // ---------- drive simulation ----------
  function toggleSimulation() {
    if (state.sim?.running) { stopSim(); updateHud(); redraw(); return; }
    if (!state.route) return;
    const p = state.route.path;
    const cum = [0];
    for (let i = 1; i < p.length; i++) cum.push(cum[i - 1] + distKm({ x: p[i - 1][0], y: p[i - 1][1] }, { x: p[i][0], y: p[i][1] }));
    const total = cum[cum.length - 1];
    const t0 = performance.now() - (state.sim?.t || 0) * NAV_SETTINGS.simSeconds * 1000;
    state.sim = { running: true, t: state.sim?.t || 0 };
    $("btnSim").textContent = "■ STOP";
    const step = (now) => {
      if (!state.sim?.running) return;
      const t = Math.min(1, (now - t0) / (NAV_SETTINGS.simSeconds * 1000));
      const d = t * total;
      let i = 1; while (i < cum.length - 1 && cum[i] < d) i++;
      const f = (d - cum[i - 1]) / ((cum[i] - cum[i - 1]) || 1);
      const a = p[i - 1], b = p[i];
      state.sim.pos = [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
      state.sim.heading = bearing({ x: a[0], y: a[1] }, { x: b[0], y: b[1] });
      state.sim.t = t;
      $("hudHeading").textContent = Math.round(state.sim.heading) + "°";
      $("compassNeedle").style.transform = `rotate(${state.sim.heading}deg)`;
      setProgress(t); drawProfile(); updateSimGraphic();
      if (t < 1) requestAnimationFrame(step);
      else { state.sim.running = false; $("btnSim").textContent = "▶ SIMULATE"; status("Destination reached"); }
    };
    requestAnimationFrame(step);
    status("Simulating drive…");
  }
  function stopSim() {
    if (state.sim) state.sim.running = false;
    state.sim = null;
    updateSimGraphic();
    $("btnSim").textContent = "▶ SIMULATE";
    $("compassNeedle").style.transform = "rotate(0deg)";
  }

  updateHud();
  return { attach, computeRoute, state, settings: NAV_SETTINGS };
}