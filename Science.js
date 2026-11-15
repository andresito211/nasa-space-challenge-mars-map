// =====================================================================
//  SCIENCE LAYERS — NASA Mars Trek global maps (minerals, dust, thermal, roughness)
//
//  Trek serves 256-px tiles in a lon/lat grid; the Esri Mars basemap uses 512-px tiles
//  in the same lon/lat grid (Trek level n+1 = Esri level n). The layer below rebuilds
//  each 512-px Esri tile from the matching Trek tiles, so the Trek maps line up exactly
//  and work in both the 2D map and the 3D globe. Coarse products are simply enlarged
//  when you zoom in further than their resolution.
//
//  Tiles are only requested for what is on screen, and only for layers you switch on.
//  To add another Trek layer: find its id in a Trek link ("l=<id>") and its number of
//  zoom levels in .../tiles/Mars/EQ/<id>/1.0.0/WMTSCapabilities.xml, then add a line below.
// =====================================================================

const TREK_SCIENCE_LAYERS = [
  // id                                                   title                                             maxLevel opacity
  ["THEMIS_DayIR_ControlledMosaics_100m_v2_oct2018",   "Day infrared, THEMIS 100 m (mostly slope shading + surface)", 9, 0.85],
  ["THEMIS_NightIR_ControlledMosaics_100m_v2_oct2018", "Night infrared, THEMIS 100 m (bright = rocky, dark = dusty)", 9, 0.85],
  ["TES_Thermal_Inertia",                               "Thermal inertia, TES global (low = loose dust/sand)",        1, 0.75],
  ["tes_ruffdust",                                      "Dust cover index, TES",                                       2, 0.75],
  ["TES_Dust",                                          "Surface dust, TES",                                           1, 0.75],
  ["Mars_MGS_TES_Albedo_mosaic_global_7410m",           "Albedo (brightness), TES",                                    1, 0.75],
  ["TES_Clinopyroxene",                                 "Mineral: high-Ca pyroxene abundance, TES",                    1, 0.75],
  ["TES_Plagioclase",                                   "Mineral: plagioclase abundance, TES",                         1, 0.75],
  ["TES_Glass_Clay",                                    "Mineral: sheet silicates / high-Si glass, TES",               1, 0.75],
  ["mola_roughness",                                    "Surface roughness, MOLA",                                     1, 0.7]
];

async function initScienceLayers({ map, basemapLayer, loadModules }) {
  const [BaseTileLayer, GroupLayer, esriRequest] = await loadModules([
    "esri/layers/BaseTileLayer", "esri/layers/GroupLayer", "esri/request"
  ]);
  await basemapLayer.load();
  const tileInfo = basemapLayer.tileInfo;            // same tiling as the Esri Mars basemap
  const OUT = tileInfo.size[0];                       // 512

  // Small image cache shared by all Trek layers (avoids refetching when panning back)
  const cache = new Map();
  const getImage = (url, signal) => {
    if (!cache.has(url)) {
      const p = esriRequest(url, { responseType: "image", signal })
        .then(r => r.data).catch(() => null);         // missing tile (outside coverage) → transparent
      cache.set(url, p);
      if (cache.size > 600) cache.delete(cache.keys().next().value);
    }
    return cache.get(url);
  };

  const TrekTileLayer = BaseTileLayer.createSubclass({
    properties: { trekId: null, maxLevel: 1 },
    async fetchTile(level, row, col, options) {
      // Esri level L ↔ Trek level L+1. Beyond the Trek maximum, enlarge the deepest level.
      const srcLevel = Math.min(level + 1, this.maxLevel);
      const k = 2 ** (level + 1 - srcLevel);          // enlargement factor (1 = native)
      const size = OUT / k;                           // area of this tile in source pixels
      const x0 = col * size, y0 = row * size;         // tile position in the source level
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = OUT;
      const ctx = canvas.getContext("2d");
      ctx.imageSmoothingEnabled = k <= 2;
      const jobs = [];
      for (let tr = Math.floor(y0 / 256); tr <= Math.floor((y0 + size - 1) / 256); tr++) {
        for (let tc = Math.floor(x0 / 256); tc <= Math.floor((x0 + size - 1) / 256); tc++) {
          const url = `https://trek.nasa.gov/tiles/Mars/EQ/${this.trekId}/1.0.0//default/default028mm/${srcLevel}/${tr}/${tc}.png`;
          jobs.push(getImage(url, options?.signal).then(img => {
            if (img) ctx.drawImage(img, (tc * 256 - x0) * k, (tr * 256 - y0) * k, 256 * k, 256 * k);
          }));
        }
      }
      await Promise.all(jobs);
      return canvas;
    }
  });

  const group = new GroupLayer({ title: "Science (NASA Trek)", visibilityMode: "independent" });
  // added bottom-up so the LAYERS list shows them in the order of the table above
  for (const [trekId, title, maxLevel, opacity] of [...TREK_SCIENCE_LAYERS].reverse()) {
    group.add(new TrekTileLayer({
      trekId, title, maxLevel, opacity, visible: false,
      tileInfo, spatialReference: tileInfo.spatialReference, fullExtent: basemapLayer.fullExtent,
      copyright: "NASA Mars Trek"
    }));
  }
  map.add(group);
  return group;
}