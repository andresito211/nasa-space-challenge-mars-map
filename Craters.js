// =====================================================================
//  CRATERS LAYER — USGS Robbins crater database (craters ≥ 1 km), loaded on demand
//
//  It is a normal map layer ("Craters (USGS)" in the LAYERS tab) and loads data only
//  for what you look at:
//   - the route planner asks for the craters inside its search area (one request),
//   - when you are zoomed in (view narrower than craterViewMaxDeg), the craters of the
//     visible area are loaded in 2° x 2° tiles, each tile only once.
//  Everything fetched is kept in memory, so nothing is downloaded twice.
//
//  Display, made to stay readable on long routes:
//   - orange dotted zones = craters the route planner avoids,
//   - thin outlines       = other craters,
//   - labels: big craters first, small ones only when zoomed in, and labels that would
//     overlap are hidden automatically (ArcGIS label deconfliction).
// =====================================================================

function initCraterLayer({ map, MARS_SR, loadModules, settings }) {
  const API = "https://astrogeology.usgs.gov/pygeoapi/collections/mars/robbinsv1/items";
  const TILE = 2;                       // degrees
  const MAX_SHOWN = 20000;              // safety cap for the layer
  const store = new Map();              // craterid → { id, x, y, d }
  const bboxCache = new Map();          // bbox string → [ids]
  const tilesDone = new Set();
  let blockedIds = new Set();
  let FeatureLayer, Graphic, GroupLayer, reactiveUtils, group, view = null, rebuildTimer = null;

  const toR = Math.PI / 180, KM_PER_DEG = (Math.PI * 3396.19) / 180;
  const circle = (c, rKm, n = 32) => {
    const ring = [];
    for (let i = 0; i <= n; i++) {
      const t = (i / n) * 2 * Math.PI;
      ring.push([c.x + (rKm * Math.cos(t)) / (KM_PER_DEG * Math.cos(c.y * toR)), c.y + (rKm * Math.sin(t)) / KM_PER_DEG]);
    }
    return ring;
  };

  const ready = (async () => {
    [FeatureLayer, Graphic, GroupLayer, reactiveUtils] = await loadModules([
      "esri/layers/FeatureLayer", "esri/Graphic", "esri/layers/GroupLayer", "esri/core/reactiveUtils"
    ]);
    group = new GroupLayer({ title: "Craters (USGS)", visibilityMode: "inherited" });
    map.add(group);
    reactiveUtils.watch(() => group.visible, (vis) => { if (vis) loadView(); });
  })();

  async function fetchBbox(xmin, ymin, xmax, ymax) {
    const bbox = [xmin, ymin, xmax, ymax].map(v => v.toFixed(3)).join(",");
    if (bboxCache.has(bbox)) return bboxCache.get(bbox);
    const res = await fetch(`${API}?f=json&limit=5000&bbox=${bbox}`, { signal: AbortSignal.timeout(15000) });
    const feats = (await res.json()).features || [];
    const ids = [];
    for (const f of feats) {
      const p = f.properties;
      if (!store.has(p.craterid)) store.set(p.craterid, { id: p.craterid, x: p.lon_e, y: p.lat, d: p.diamkm });
      ids.push(p.craterid);
    }
    bboxCache.set(bbox, ids);
    return ids;
  }

  // For the route planner: craters inside a box (throws if the service is unreachable)
  async function getForBbox(b) {
    await ready;
    const ids = await fetchBbox(b.xmin, b.ymin, b.xmax, b.ymax);
    scheduleRebuild();
    return ids.map(id => store.get(id));
  }

  // Craters coming from an imported route file
  function addCraters(list) {
    for (const c of list) if (c.id && !store.has(c.id)) store.set(c.id, c);
    scheduleRebuild();
  }

  // The planner tells which craters are no-go zones, so they are drawn differently
  function setBlocked(ids) { blockedIds = new Set(ids); scheduleRebuild(); }

  // ---------- loading for the visible area ----------
  async function loadView() {
    if (!view || !group?.visible || !view.extent) return;
    const e = view.extent;
    const w = Math.abs(e.xmax - e.xmin), h = Math.abs(e.ymax - e.ymin);
    if (Math.max(w, h) > settings.craterViewMaxDeg) return;          // too far out: don't load
    const tx0 = Math.floor(e.xmin / TILE), tx1 = Math.floor(e.xmax / TILE);
    const ty0 = Math.floor(Math.max(-90, e.ymin) / TILE), ty1 = Math.floor(Math.min(89.99, e.ymax) / TILE);
    const todo = [];
    for (let tx = tx0; tx <= tx1; tx++) for (let ty = ty0; ty <= ty1; ty++) {
      const key = `${tx},${ty}`;
      if (!tilesDone.has(key)) { tilesDone.add(key); todo.push([tx, ty]); }
    }
    if (!todo.length) return;
    await Promise.all(todo.map(([tx, ty]) =>
      fetchBbox(tx * TILE, ty * TILE, (tx + 1) * TILE, (ty + 1) * TILE)
        .catch(err => { tilesDone.delete(`${tx},${ty}`); console.warn("Crater tile failed:", err); })));
    scheduleRebuild();
  }

  // ---------- drawing ----------
  function scheduleRebuild() { clearTimeout(rebuildTimer); rebuildTimer = setTimeout(rebuild, 150); }

  function labelClasses() {
    const color = [255, 200, 140];
    const sym = view?.type === "3d"
      ? { type: "label-3d", symbolLayers: [{ type: "text", material: { color }, halo: { color: [0, 0, 0, 0.7], size: 1 },
          font: { family: "monospace" }, size: 9 }] }
      : { type: "text", color, haloColor: [0, 0, 0, 0.7], haloSize: 1, font: { family: "monospace", size: 8 } };
    const cls = (where, minScale) => ({ where, minScale, maxScale: 0, symbol: sym,
      labelExpressionInfo: { expression: "$feature.label" },
      labelPlacement: view?.type === "3d" ? "above-center" : "center-center",
      deconflictionStrategy: "static" });   // overlapping labels are hidden
    return [cls("d >= 30", 0), cls("d >= 10 AND d < 30", 6000000),
            cls("d >= 4 AND d < 10", 1500000), cls("d < 4", 400000)];
  }

  function rebuild() {
    if (!group) return;
    const list = [...store.values()].sort((a, b) => b.d - a.d).slice(0, MAX_SHOWN);
    const zones = [], points = [];
    list.forEach((c, i) => {
      const blocked = blockedIds.has(c.id) ? 1 : 0;
      const r = (c.d / 2) * (blocked ? settings.craterMargin : 1);
      const attributes = { oid: i + 1, id: c.id, d: c.d, blocked, label: `${blocked ? "⚠ " : ""}CRATER ${c.d.toFixed(1)} KM` };
      zones.push(new Graphic({ geometry: { type: "polygon", rings: [circle(c, r)], spatialReference: MARS_SR }, attributes }));
      points.push(new Graphic({ geometry: { type: "point", x: c.x, y: c.y, spatialReference: MARS_SR }, attributes: { ...attributes } }));
    });
    const fields = [
      { name: "oid", type: "oid" }, { name: "id", type: "string" }, { name: "d", type: "double", alias: "Diameter (km)" },
      { name: "blocked", type: "integer" }, { name: "label", type: "string" }
    ];
    const popupTemplate = { title: "Crater {id}", content: "Diameter: {d} km<br>Avoided by the route planner: {blocked}<br>Source: USGS Robbins crater database" };
    const zonesLayer = new FeatureLayer({
      title: "Crater zones", source: zones, fields, objectIdField: "oid", geometryType: "polygon",
      spatialReference: MARS_SR, popupTemplate, elevationInfo: { mode: "on-the-ground" },
      renderer: { type: "unique-value", field: "blocked",
        defaultSymbol: { type: "simple-fill", color: [0, 0, 0, 0], outline: { color: [255, 200, 140, 0.35], width: 0.7 } },
        uniqueValueInfos: [{ value: 1, symbol: { type: "simple-fill", color: [255, 170, 60, 0.12],
          outline: { color: [255, 170, 60, 0.85], width: 1, style: "dot" } } }] }
    });
    const labelsLayer = new FeatureLayer({
      title: "Crater labels", source: points, fields, objectIdField: "oid", geometryType: "point",
      spatialReference: MARS_SR, popupTemplate, elevationInfo: { mode: view?.type === "3d" ? "relative-to-ground" : "on-the-ground" },
      renderer: { type: "simple", symbol: view?.type === "3d"
        ? { type: "point-3d", symbolLayers: [{ type: "icon", resource: { primitive: "circle" }, material: { color: [0, 0, 0, 0] }, size: 1 }] }
        : { type: "simple-marker", size: 1, color: [0, 0, 0, 0], outline: null } },
      labelingInfo: labelClasses()
    });
    group.removeAll();
    group.addMany([zonesLayer, labelsLayer]);
  }

  // Called for every new 2D/3D view
  async function attach(v) {
    await ready;
    view = v;
    rebuild();   // labels/symbols differ between 2D and 3D
    reactiveUtils.when(() => v.stationary, () => { if (view === v) loadView(); });
  }

  return { getForBbox, setBlocked, addCraters, attach, loadView, store };
}