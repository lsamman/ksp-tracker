// Kepler helpers. Elements follow KSP's Orbit: inc/lan/argPe in degrees, maae in radians,
// sma/positions in metres, times in universal time (seconds).
export const TAU = Math.PI * 2;
const D2R = Math.PI / 180;

function wrap(m) { m %= TAU; return m < 0 ? m + TAU : m; }

function solveEllipse(M, e) {
  M = wrap(M);
  let E = e < 0.8 ? M : Math.PI;
  for (let i = 0; i < 40; i++) {
    const d = (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
    E -= d;
    if (Math.abs(d) < 1e-12) break;
  }
  return E;
}

function solveHyperbola(M, e) {
  let H = Math.asinh(M / e);
  for (let i = 0; i < 60; i++) {
    const d = (e * Math.sinh(H) - H - M) / (e * Math.cosh(H) - 1);
    H -= d;
    if (Math.abs(d) < 1e-12) break;
  }
  return H;
}

export function meanMotion(o, mu) { return Math.sqrt(mu / Math.abs(o.sma ** 3)); }

// rotate a perifocal (x,y) into the parent frame, then map KSP z-up to three.js y-up
function rotate(o, x, y) {
  const w = o.argPe * D2R, i = o.inc * D2R, O = o.lan * D2R;
  const x1 = x * Math.cos(w) - y * Math.sin(w), y1 = x * Math.sin(w) + y * Math.cos(w);
  const y2 = y1 * Math.cos(i), z2 = y1 * Math.sin(i);
  const x3 = x1 * Math.cos(O) - y2 * Math.sin(O), y3 = x1 * Math.sin(O) + y2 * Math.cos(O);
  return [x3, z2, -y3];
}

// position at eccentric anomaly E (closed orbits only)
export function pointAtE(o, E) {
  const b = o.sma * Math.sqrt(1 - o.ecc * o.ecc);
  return rotate(o, o.sma * (Math.cos(E) - o.ecc), b * Math.sin(E));
}

// position (metres, three axes) relative to the orbited body at time t
export function stateAt(o, mu, t) {
  const M = o.maae + meanMotion(o, mu) * (t - o.epoch);
  if (o.ecc < 1) {
    const E = solveEllipse(M, o.ecc);
    return pointAtE(o, E);
  }
  const H = solveHyperbola(M, o.ecc);
  const a = o.sma;
  return rotate(o, a * (Math.cosh(H) - o.ecc), -a * Math.sqrt(o.ecc * o.ecc - 1) * Math.sinh(H));
}

// sampled path: full ellipse for bound orbits with no end, otherwise time-sampled
export function samplePath(o, mu, steps = 160) {
  const pts = [];
  const finiteEnd = Number.isFinite(o.endUT) && Number.isFinite(o.startUT);
  if (o.ecc < 1 && (!finiteEnd || o.trans === 'FINAL' || o.trans === 'INITIAL')) {
    for (let k = 0; k <= steps; k++) pts.push(pointAtE(o, (k / steps) * TAU));
    return pts;
  }
  const t0 = finiteEnd ? o.startUT : o.epoch;
  let t1 = finiteEnd ? o.endUT : o.epoch + 3600 * 24 * 100;
  if (o.ecc < 1 && o.period && t1 - t0 > o.period) t1 = t0 + o.period;
  for (let k = 0; k <= steps; k++) pts.push(stateAt(o, mu, t0 + ((t1 - t0) * k) / steps));
  return pts;
}

// seconds until the next periapsis / apoapsis (bound orbits)
export function timeToApsis(o, mu, t) {
  const n = meanMotion(o, mu);
  const M = wrap(o.maae + n * (t - o.epoch));
  return { pe: wrap(-M) / n, ap: wrap(Math.PI - M) / n };
}
