// Teselado de curvas CAD: arcos, círculos, bulges de polilíneas, elipses y splines.
// Módulo puro, importable desde Node y desde Web Workers.
//
// Todas las funciones devuelven (o rellenan) arreglos planos [x, y, z, x, y, z, ...]
// en el sistema local de la entidad; el constructor de geometría los transforma.

const TWO_PI = Math.PI * 2;

// Paso angular máximo del teselado (6°): error de flecha ≈ 0,14 % del radio.
export const ARC_STEP = Math.PI / 30;

// Nº de segmentos para barrer `sweep` radianes.
export function arcSegmentCount(sweep, step = ARC_STEP) {
  return Math.max(1, Math.ceil(Math.abs(sweep) / step - 1e-9));
}

// Normaliza el barrido de un arco (a0 → a1 en sentido antihorario) a (0, 2π].
export function arcSweep(a0, a1) {
  let sweep = a1 - a0;
  if (!Number.isFinite(sweep)) return 0;
  while (sweep <= 1e-12) sweep += TWO_PI;
  while (sweep > TWO_PI + 1e-12) sweep -= TWO_PI;
  return sweep;
}

// Puntos de un arco circular (incluye ambos extremos).
export function arcPoints(cx, cy, cz, r, a0, a1, out = []) {
  const sweep = arcSweep(a0, a1);
  const n = arcSegmentCount(sweep);
  for (let i = 0; i <= n; i++) {
    const a = a0 + (sweep * i) / n;
    out.push(cx + r * Math.cos(a), cy + r * Math.sin(a), cz);
  }
  return out;
}

// Círculo completo como anillo cerrado (el último punto repite al primero).
export function circlePoints(cx, cy, cz, r, out = []) {
  const n = arcSegmentCount(TWO_PI);
  for (let i = 0; i <= n; i++) {
    const a = (TWO_PI * i) / n;
    out.push(cx + r * Math.cos(a), cy + r * Math.sin(a), cz);
  }
  return out;
}

// Añade a `out` los puntos intermedios y el final de un tramo de polilínea con bulge
// (bulge = tan(θ/4), positivo = antihorario). El punto inicial NO se añade: así las
// polilíneas se encadenan sin duplicados. z se interpola linealmente.
export function appendBulgeSegment(out, x1, y1, z1, x2, y2, z2, bulge) {
  if (!bulge || Math.abs(bulge) < 1e-12) {
    out.push(x2, y2, z2);
    return out;
  }
  const dx = x2 - x1;
  const dy = y2 - y1;
  const chord = Math.hypot(dx, dy);
  if (chord < 1e-12) {
    out.push(x2, y2, z2);
    return out;
  }
  const theta = 4 * Math.atan(bulge); // ángulo barrido con signo
  // Centro: punto medio + perpendicular izquierda * (1 - b²) / (4b) * cuerda
  const off = ((1 - bulge * bulge) / (4 * bulge)) * chord;
  const cx = (x1 + x2) / 2 + (-dy / chord) * off;
  const cy = (y1 + y2) / 2 + (dx / chord) * off;
  const r = Math.hypot(x1 - cx, y1 - cy);
  const a0 = Math.atan2(y1 - cy, x1 - cx);
  const n = arcSegmentCount(theta);
  for (let i = 1; i < n; i++) {
    const t = i / n;
    const a = a0 + theta * t;
    out.push(cx + r * Math.cos(a), cy + r * Math.sin(a), z1 + (z2 - z1) * t);
  }
  out.push(x2, y2, z2);
  return out;
}

// Elipse: centro c, vector del semieje mayor `major`, normal `normal` (extrusión),
// razón menor/mayor y parámetros a0..a1 (radianes, paramétricos).
export function ellipsePoints(c, major, normal, ratio, a0, a1, out = []) {
  const mx = major[0];
  const my = major[1];
  const mz = major[2];
  const mlen = Math.hypot(mx, my, mz);
  if (mlen < 1e-12) return out;
  let nx = normal?.[0] ?? 0;
  let ny = normal?.[1] ?? 0;
  let nz = normal?.[2] ?? 1;
  const nlen = Math.hypot(nx, ny, nz);
  if (nlen < 1e-12) {
    nx = 0;
    ny = 0;
    nz = 1;
  } else {
    nx /= nlen;
    ny /= nlen;
    nz /= nlen;
  }
  // eje menor = (N × mayor) normalizado * |mayor| * razón
  let ux = ny * mz - nz * my;
  let uy = nz * mx - nx * mz;
  let uz = nx * my - ny * mx;
  const ulen = Math.hypot(ux, uy, uz) || 1;
  const k = (mlen * ratio) / ulen;
  ux *= k;
  uy *= k;
  uz *= k;
  const sweep = arcSweep(a0, a1);
  const n = arcSegmentCount(sweep);
  for (let i = 0; i <= n; i++) {
    const t = a0 + (sweep * i) / n;
    const ct = Math.cos(t);
    const st = Math.sin(t);
    out.push(
      c[0] + mx * ct + ux * st,
      c[1] + my * ct + uy * st,
      c[2] + mz * ct + uz * st,
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// Splines B (de Boor) racionales
// ---------------------------------------------------------------------------

function findSpan(n, p, u, U) {
  if (u >= U[n + 1]) return n;
  if (u <= U[p]) return p;
  let lo = p;
  let hi = n + 1;
  let mid = (lo + hi) >> 1;
  while (u < U[mid] || u >= U[mid + 1]) {
    if (u < U[mid]) hi = mid;
    else lo = mid;
    mid = (lo + hi) >> 1;
  }
  return mid;
}

function basisFuns(span, u, p, U, N) {
  const left = new Array(p + 1).fill(0);
  const right = new Array(p + 1).fill(0);
  N[0] = 1;
  for (let j = 1; j <= p; j++) {
    left[j] = u - U[span + 1 - j];
    right[j] = U[span + j] - u;
    let saved = 0;
    for (let r = 0; r < j; r++) {
      const den = right[r + 1] + left[j - r];
      const temp = den === 0 ? 0 : N[r] / den;
      N[r] = saved + right[r + 1] * temp;
      saved = left[j - r] * temp;
    }
    N[j] = saved;
  }
}

// Vector de nudos uniforme y abrazado ("clamped") para n+1 puntos de control.
export function clampedUniformKnots(count, degree) {
  const knots = [];
  const interior = count - degree - 1;
  for (let i = 0; i <= degree; i++) knots.push(0);
  for (let i = 1; i <= interior; i++) knots.push(i / (interior + 1));
  for (let i = 0; i <= degree; i++) knots.push(1);
  return knots;
}

// Evalúa una B-spline en el parámetro u. ctrl es plano [x,y,z,...]; weights opcional.
export function evalBSpline(degree, knots, ctrl, weights, u, out = [0, 0, 0]) {
  const count = ctrl.length / 3;
  const n = count - 1;
  const span = findSpan(n, degree, u, knots);
  const N = new Array(degree + 1).fill(0);
  basisFuns(span, u, degree, knots, N);
  let x = 0;
  let y = 0;
  let z = 0;
  let w = 0;
  for (let i = 0; i <= degree; i++) {
    const idx = span - degree + i;
    const wi = weights ? (weights[idx] ?? 1) : 1;
    const f = N[i] * wi;
    x += f * ctrl[idx * 3];
    y += f * ctrl[idx * 3 + 1];
    z += f * ctrl[idx * 3 + 2];
    w += f;
  }
  if (Math.abs(w) < 1e-14) w = 1;
  out[0] = x / w;
  out[1] = y / w;
  out[2] = z / w;
  return out;
}

// Teselado de una spline con puntos de control + nudos. Devuelve arreglo plano.
//  spline: { degree, knots: number[], ctrl: number[] plano, weights?: number[] }
export function bsplinePoints(spline, out = []) {
  const ctrl = spline.ctrl;
  const count = ctrl.length / 3;
  let degree = Math.max(1, Math.trunc(spline.degree) || 3);
  if (count < 2) return out;
  if (count < degree + 1) degree = count - 1;
  let knots = spline.knots;
  if (!knots || knots.length !== count + degree + 1 || !knots.every(Number.isFinite)) {
    knots = clampedUniformKnots(count, degree);
  }
  const weights = spline.weights && spline.weights.length === count ? spline.weights : null;
  const u0 = knots[degree];
  const u1 = knots[count];
  if (!(u1 > u0)) return out;
  // Intervalos de nudos distintos dentro del dominio
  const spans = [];
  for (let i = degree; i < count; i++) {
    if (knots[i + 1] > knots[i] + 1e-12) spans.push([knots[i], knots[i + 1]]);
  }
  if (!spans.length) return out;
  const target = Math.min(1500, Math.max(24, count * 6));
  const perSpan = Math.max(2, Math.ceil(target / spans.length));
  const tmp = [0, 0, 0];
  let first = true;
  for (const [a, b] of spans) {
    for (let i = first ? 0 : 1; i <= perSpan; i++) {
      const u = i === perSpan ? b : a + ((b - a) * i) / perSpan;
      evalBSpline(degree, knots, ctrl, weights, u, tmp);
      out.push(tmp[0], tmp[1], tmp[2]);
    }
    first = false;
  }
  return out;
}

// Spline que interpola puntos de ajuste (Catmull-Rom centrípeto). pts es plano.
export function fitSplinePoints(pts, closed = false, out = []) {
  const n = pts.length / 3;
  if (n < 2) return out;
  if (n === 2) {
    out.push(pts[0], pts[1], pts[2], pts[3], pts[4], pts[5]);
    return out;
  }
  const P = (i) => {
    let k = i;
    if (closed) k = ((i % n) + n) % n;
    else if (k < 0) k = 0;
    else if (k > n - 1) k = n - 1;
    return [pts[k * 3], pts[k * 3 + 1], pts[k * 3 + 2]];
  };
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const segs = closed ? n : n - 1;
  const SUB = 12;
  for (let s = 0; s < segs; s++) {
    let p0 = P(s - 1);
    const p1 = P(s);
    const p2 = P(s + 1);
    let p3 = P(s + 2);
    if (!closed) {
      // Extremos abiertos: reflejar el vecino para conservar la tangente
      if (s === 0) p0 = [2 * p1[0] - p2[0], 2 * p1[1] - p2[1], 2 * p1[2] - p2[2]];
      if (s === segs - 1) p3 = [2 * p2[0] - p1[0], 2 * p2[1] - p1[1], 2 * p2[2] - p1[2]];
    }
    const eps = 1e-9;
    const t0 = 0;
    const t1 = t0 + Math.max(Math.sqrt(dist(p0, p1)), eps);
    const t2 = t1 + Math.max(Math.sqrt(dist(p1, p2)), eps);
    const t3 = t2 + Math.max(Math.sqrt(dist(p2, p3)), eps);
    if (s === 0) out.push(p1[0], p1[1], p1[2]);
    for (let i = 1; i <= SUB; i++) {
      const t = t1 + ((t2 - t1) * i) / SUB;
      const q = [0, 0, 0];
      for (let k = 0; k < 3; k++) {
        const a1 = ((t1 - t) / (t1 - t0)) * p0[k] + ((t - t0) / (t1 - t0)) * p1[k];
        const a2 = ((t2 - t) / (t2 - t1)) * p1[k] + ((t - t1) / (t2 - t1)) * p2[k];
        const a3 = ((t3 - t) / (t3 - t2)) * p2[k] + ((t - t2) / (t3 - t2)) * p3[k];
        const b1 = ((t2 - t) / (t2 - t0)) * a1 + ((t - t0) / (t2 - t0)) * a2;
        const b2 = ((t3 - t) / (t3 - t1)) * a2 + ((t - t1) / (t3 - t1)) * a3;
        q[k] = ((t2 - t) / (t2 - t1)) * b1 + ((t - t1) / (t2 - t1)) * b2;
      }
      out.push(q[0], q[1], q[2]);
    }
  }
  return out;
}

// Teselado general de una spline normalizada:
//  { degree, knots, ctrl (plano), weights, fit (plano), closed }
export function splinePoints(spline, out = []) {
  const hasCtrl = spline.ctrl && spline.ctrl.length >= 6;
  if (hasCtrl) {
    const before = out.length;
    bsplinePoints(spline, out);
    if (out.length > before) return out;
  }
  if (spline.fit && spline.fit.length >= 6) return fitSplinePoints(spline.fit, !!spline.closed, out);
  if (hasCtrl) {
    // Último recurso: polígono de control
    for (let i = 0; i < spline.ctrl.length; i++) out.push(spline.ctrl[i]);
  }
  return out;
}
