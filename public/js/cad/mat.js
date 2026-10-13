// Transformaciones afines 3x4 (fila mayor) en doble precisión.
// Módulo puro, importable desde Node y desde Web Workers.
//
// Una matriz es un Float64Array(12):
//   [ m00 m01 m02 m03,
//     m10 m11 m12 m13,
//     m20 m21 m22 m23 ]
// y transforma un punto como  p' = A·p + t.

export function matIdentity() {
  return Float64Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0);
}

export function matTranslate(x, y, z) {
  return Float64Array.of(1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z);
}

export function matScale(sx, sy, sz) {
  return Float64Array.of(sx, 0, 0, 0, 0, sy, 0, 0, 0, 0, sz, 0);
}

export function matRotZ(rad) {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return Float64Array.of(c, -s, 0, 0, s, c, 0, 0, 0, 0, 1, 0);
}

// Matriz cuyas columnas son los ejes x, y, z y la traslación t.
export function matFromAxes(ax, ay, az, t = [0, 0, 0]) {
  return Float64Array.of(
    ax[0], ay[0], az[0], t[0],
    ax[1], ay[1], az[1], t[1],
    ax[2], ay[2], az[2], t[2],
  );
}

// a · b  (se aplica primero b y después a)
export function matMul(a, b) {
  const o = new Float64Array(12);
  for (let r = 0; r < 3; r++) {
    const a0 = a[r * 4];
    const a1 = a[r * 4 + 1];
    const a2 = a[r * 4 + 2];
    o[r * 4] = a0 * b[0] + a1 * b[4] + a2 * b[8];
    o[r * 4 + 1] = a0 * b[1] + a1 * b[5] + a2 * b[9];
    o[r * 4 + 2] = a0 * b[2] + a1 * b[6] + a2 * b[10];
    o[r * 4 + 3] = a0 * b[3] + a1 * b[7] + a2 * b[11] + a[r * 4 + 3];
  }
  return o;
}

// Escribe en out[0..2] el punto transformado.
export function matApply(m, x, y, z, out) {
  out[0] = m[0] * x + m[1] * y + m[2] * z + m[3];
  out[1] = m[4] * x + m[5] * y + m[6] * z + m[7];
  out[2] = m[8] * x + m[9] * y + m[10] * z + m[11];
  return out;
}

// Escribe en out[0..2] el vector transformado (sin traslación).
export function matApplyVec(m, x, y, z, out) {
  out[0] = m[0] * x + m[1] * y + m[2] * z;
  out[1] = m[4] * x + m[5] * y + m[6] * z;
  out[2] = m[8] * x + m[9] * y + m[10] * z;
  return out;
}

export function matDet(m) {
  return (
    m[0] * (m[5] * m[10] - m[6] * m[9])
    - m[1] * (m[4] * m[10] - m[6] * m[8])
    + m[2] * (m[4] * m[9] - m[5] * m[8])
  );
}

// Factor de escala lineal medio en el plano XY (para decidir la finura del teselado).
export function matScaleXY(m) {
  const sx = Math.hypot(m[0], m[4], m[8]);
  const sy = Math.hypot(m[1], m[5], m[9]);
  return (sx + sy) / 2 || 1;
}

const EPS = 1e-9;

// ¿La dirección de extrusión es la normal por defecto (0,0,1) o nula/ausente?
export function isDefaultExtrusion(n) {
  if (!n) return true;
  const x = Number(n[0]) || 0;
  const y = Number(n[1]) || 0;
  const z = Number(n[2]) || 0;
  const len = Math.hypot(x, y, z);
  if (len < EPS) return true;
  return Math.abs(x / len) < EPS && Math.abs(y / len) < EPS && z / len > 0;
}

// Ejes del OCS (sistema de coordenadas del objeto) por el "algoritmo del eje arbitrario"
// de AutoCAD. Devuelve { ax, ay, az } unitarios. Ejemplo: normal (0,0,-1) → ax = (-1,0,0)
// (el eje X se refleja).
export function ocsAxes(n) {
  let x = Number(n?.[0]) || 0;
  let y = Number(n?.[1]) || 0;
  let z = Number(n?.[2]) || 0;
  const len = Math.hypot(x, y, z);
  if (len < EPS) return { ax: [1, 0, 0], ay: [0, 1, 0], az: [0, 0, 1] };
  x /= len;
  y /= len;
  z /= len;
  let ax;
  if (Math.abs(x) < 1 / 64 && Math.abs(y) < 1 / 64) {
    // Y × N = (1*z - 0*y, 0*x - 0*z, 0*y - 1*x)
    ax = [z, 0, -x];
  } else {
    // Z × N = (0*z - 1*y, 1*x - 0*z, 0)
    ax = [-y, x, 0];
  }
  const al = Math.hypot(ax[0], ax[1], ax[2]) || 1;
  ax = [ax[0] / al, ax[1] / al, ax[2] / al];
  // ay = N × ax
  const ay = [
    y * ax[2] - z * ax[1],
    z * ax[0] - x * ax[2],
    x * ax[1] - y * ax[0],
  ];
  return { ax, ay, az: [x, y, z] };
}

// Matriz OCS → WCS para la dirección de extrusión n (identidad si n es (0,0,1) o nula).
export function matOcs(n) {
  if (isDefaultExtrusion(n)) return matIdentity();
  const { ax, ay, az } = ocsAxes(n);
  return matFromAxes(ax, ay, az);
}
