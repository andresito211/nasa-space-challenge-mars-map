// =====================================================================
//  CLIMATE — typical Mars weather at a place and time, from climate.json
//
//  climate.json holds, for one or more sites, a table of typical values for each
//  season (12 steps of solar longitude Ls) × each local hour (LTST 0–23):
//  air and ground temperature, pressure, wind speed and direction, dust opacity
//  and a dust-devil activity index. It is loaded ONCE; every lookup is local math
//  (season and hour come from the Mars clock), so the app never waits on the network.
//
//  The included file has APPROXIMATE values for Jezero. Tables made from the
//  Mars Climate Database can replace it (same format; more sites = more coverage).
// =====================================================================

const Climate = (() => {
  let table = null;
  const VARS = ["air_temp_C", "ground_temp_C", "pressure_Pa", "wind_ms", "wind_from_deg", "dust_tau", "dust_devil_index"];
  const SCALE_HEIGHT_M = 11100;
  const toR = Math.PI / 180;

  async function load(url = "climate.json") {
    try {
      const t = await (await fetch(url, { cache: "no-cache" })).json();
      if (t.format !== "mars-climate-table") throw new Error("not a climate table");
      table = t;
      console.log(`Climate table loaded: ${t.sites.length} site(s)`);
    } catch (err) {
      console.warn("No climate table — weather features disabled:", err);
      table = null;
    }
    return !!table;
  }

  // distance in degrees of arc between two lon/lat points (for picking the nearest sites)
  const arc = (a, b) => {
    const c = Math.sin(a.lat * toR) * Math.sin(b.lat * toR) + Math.cos(a.lat * toR) * Math.cos(b.lat * toR) * Math.cos((a.lon - b.lon) * toR);
    return Math.acos(Math.max(-1, Math.min(1, c))) / toR;
  };

  // value of one variable of one site at (ls, hour), interpolating in both (cyclic)
  function lookup(site, v, ls, hour) {
    const L = table.ls, H = table.hours, grid = site.vars[v];
    const nL = L.length, nH = H.length, stepL = 360 / nL, stepH = 24 / nH;
    const li = ((ls % 360) + 360) % 360 / stepL, hi = ((hour % 24) + 24) % 24 / stepH;
    const l0 = Math.floor(li) % nL, l1 = (l0 + 1) % nL, fl = li - Math.floor(li);
    const h0 = Math.floor(hi) % nH, h1 = (h0 + 1) % nH, fh = hi - Math.floor(hi);
    if (v === "wind_from_deg") {                       // directions: interpolate as vectors
      let x = 0, y = 0;
      for (const [l, wl] of [[l0, 1 - fl], [l1, fl]]) for (const [h, wh] of [[h0, 1 - fh], [h1, fh]]) {
        x += wl * wh * Math.sin(grid[l][h] * toR); y += wl * wh * Math.cos(grid[l][h] * toR);
      }
      return (Math.atan2(x, y) / toR + 360) % 360;
    }
    const a = grid[l0][h0] * (1 - fh) + grid[l0][h1] * fh;
    const b = grid[l1][h0] * (1 - fh) + grid[l1][h1] * fh;
    return a * (1 - fl) + b * fl;
  }

  // Typical conditions at a place and Earth time.
  // Uses the nearest site (blending the two nearest when there are several), with
  // simple corrections for elevation: pressure by the scale height, air −1 °C per km.
  function at(date, lat, lon, elevM = null) {
    if (!table) return null;
    const sites = table.sites.map(s => ({ s, d: arc({ lat, lon }, s) })).sort((a, b) => a.d - b.d).slice(0, 2);
    const mt = MarsClock.marsTime(date, lon, lat);
    let weights = sites.length === 2 && sites[0].d > 0.01
      ? [1 / sites[0].d, 1 / sites[1].d] : [1];
    const wsum = weights.reduce((a, b) => a + b, 0);
    const out = { site: sites[0].s.name, siteDistDeg: sites[0].d, ls: mt.ls, ltst: mt.ltst, sunElev: mt.sunElev,
                  sunrise: mt.sunrise, sunset: mt.sunset, my: mt.my, approximate: /APPROXIMATE/.test(table.source || "") };
    for (const v of VARS) {
      if (v === "wind_from_deg") { out[v] = lookup(sites[0].s, v, mt.ls, mt.ltst); continue; }
      out[v] = weights.reduce((acc, w, i) => acc + (w / wsum) * lookup(sites[i].s, v, mt.ls, mt.ltst), 0);
    }
    if (elevM != null && Number.isFinite(elevM)) {
      const ref = sites[0].s.elev_m ?? elevM;
      out.pressure_Pa *= Math.exp(-(elevM - ref) / SCALE_HEIGHT_M);
      out.air_temp_C -= (elevM - ref) / 1000;
    }
    return out;
  }

  return { load, at, get loaded() { return !!table; }, get source() { return table?.source; } };
})();