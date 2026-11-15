// =====================================================================
//  MARS CLOCK — Martian date and local time from an Earth date
//  Algorithm: NASA GISS "Mars24" (Allison & McEwen 2000, Allison 1997).
//  Pure math, no data needed.
//
//  marsTime(date, lonE, latN) → {
//    ls        solar longitude (season): 0 = northern spring, 90 = N summer, 180 = N autumn, 270 = N winter
//    my        Mars Year (Clancy et al. numbering; MY 1 began 11 April 1955)
//    msd       Mars Sol Date (continuous sol count)
//    mtc       Coordinated Mars Time (hours, at 0° longitude)
//    lmst      Local Mean Solar Time at lonE (hours)
//    ltst      Local True Solar Time at lonE (hours; 12 = sun highest)
//    decl      solar declination (deg)
//    sunElev   sun elevation above the horizon at (latN, lonE) (deg)
//    sunrise, sunset   LTST hours at latN (null = polar day/night)
//  }
// =====================================================================

const MarsClock = (() => {
  const D2R = Math.PI / 180;
  const mod = (a, n) => ((a % n) + n) % n;
  const TT_MINUS_UTC = 69.184;          // seconds (TAI−UTC 37 s + 32.184 s), valid since 2017

  // perturbations from the other planets (Mars24, table 5)
  const PBS = [
    [0.0071, 2.2353, 49.409], [0.0057, 2.7543, 168.173], [0.0039, 1.1177, 191.837],
    [0.0037, 15.7866, 21.736], [0.0021, 2.1354, 15.704], [0.0020, 2.4694, 95.528],
    [0.0018, 32.8493, 49.095]
  ];

  function marsTime(date = new Date(), lonE = 0, latN = 0) {
    const jdUT = date.getTime() / 86400000 + 2440587.5;
    const jdTT = jdUT + TT_MINUS_UTC / 86400;
    const dt = jdTT - 2451545.0;                                  // days since J2000 (TT)

    const M = 19.3871 + 0.52402073 * dt;                          // mean anomaly (deg)
    const aFMS = 270.3871 + 0.524038496 * dt;                     // fictitious mean sun (deg)
    let pbs = 0;
    for (const [A, tau, phi] of PBS) pbs += A * Math.cos(D2R * ((0.985626 * dt) / tau + phi));
    const eoc = (10.691 + 3.0e-7 * dt) * Math.sin(D2R * M) + 0.623 * Math.sin(2 * D2R * M)
              + 0.050 * Math.sin(3 * D2R * M) + 0.005 * Math.sin(4 * D2R * M)
              + 0.0005 * Math.sin(5 * D2R * M) + pbs;              // equation of center (deg)
    const ls = mod(aFMS + eoc, 360);

    // equation of time (deg) → hours
    const eot = 2.861 * Math.sin(2 * D2R * ls) - 0.071 * Math.sin(4 * D2R * ls)
              + 0.002 * Math.sin(6 * D2R * ls) - eoc;

    const msd = (jdTT - 2451549.5) / 1.0274912517 + 44796.0 - 0.0009626;
    const mtc = mod(24 * msd, 24);
    const lmst = mod(mtc + lonE / 15, 24);
    const ltst = mod(lmst + eot / 15, 24);

    // Mars Year (MY 1 began at Ls 0 on 1955-04-11); fix the count right at the year boundary
    let my = Math.floor((jdTT - 2435208.5) / 686.9711) + 1;
    const frac = mod((jdTT - 2435208.5) / 686.9711, 1);
    if (ls > 300 && frac < 0.1) my -= 1;
    if (ls < 60 && frac > 0.9) my += 1;

    // sun position
    const decl = Math.asin(0.42565 * Math.sin(D2R * ls)) / D2R + 0.25 * Math.sin(D2R * ls);
    const H = (ltst - 12) * 15;                                   // hour angle (deg)
    const sinEl = Math.sin(D2R * latN) * Math.sin(D2R * decl) + Math.cos(D2R * latN) * Math.cos(D2R * decl) * Math.cos(D2R * H);
    const sunElev = Math.asin(Math.max(-1, Math.min(1, sinEl))) / D2R;
    const cosH0 = -Math.tan(D2R * latN) * Math.tan(D2R * decl);
    let sunrise = null, sunset = null;
    if (cosH0 > -1 && cosH0 < 1) {
      const H0 = Math.acos(cosH0) / D2R / 15;                     // hours
      sunrise = 12 - H0; sunset = 12 + H0;
    }
    return { ls, my, msd, sol: Math.floor(msd), mtc, lmst, ltst, decl, sunElev, sunrise, sunset };
  }

  const hhmm = (h) => {
    if (h == null) return "--:--";
    const m = Math.round(mod(h, 24) * 60) % 1440;
    return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  };
  const seasonName = (ls, latN = 1) => {
    const n = ["spring", "summer", "autumn", "winter"][Math.floor(mod(ls, 360) / 90)];
    const south = { spring: "autumn", summer: "winter", autumn: "spring", winter: "summer" };
    return latN >= 0 ? `N ${n}` : `S ${south[n]}`;
  };

  return { marsTime, hhmm, seasonName };
})();