// Constructor de geometría CAD: formato intermedio (IR) → búferes por capa.
// Módulo puro (sin three.js ni DOM), importable desde Node y desde Web Workers.
//
// Hace:
//  - expansión recursiva de INSERT/DIMENSION con matrices (escala, rotación, filas/columnas,
//    punto base, OCS de extrusión), con capa 0 flotante y color PorBloque heredado;
//  - teselado de arcos, círculos, bulges, elipses y splines;
//  - rellenos (SOLID, 3DFACE, HATCH sólido) triangulados;
//  - registros de texto (la composición de glifos se hace en el hilo principal con el atlas);
//  - ancla en doble precisión = centro redondeado de la caja REAL de la geometría y
//    conversión a coordenadas de escena locales (Float32 relativos al ancla):
//        x = E − ancla.e,   y = Z − ancla.h,   z = −(N − ancla.n)
//
// Las coordenadas del dibujo, tras aplicar unidades, se interpretan como coordenadas de mapa
// (E = x, N = y, Z = z).

import { ACI_RGB, inkForLightBackground, rgbToHex } from './aci.js';
import {
  matIdentity, matMul, matTranslate, matScale, matRotZ, matApply, matApplyVec, matOcs,
} from './mat.js';
import {
  arcPoints, circlePoints, appendBulgeSegment, ellipsePoints, splinePoints,
} from './curves.js';

// Columnas de cada registro de texto (ver CadModel/glyphAtlas)
export const TEXT_STRIDE = 19;
export const TEXT_FIELDS = [
  'px', 'py', 'pz', 'ux', 'uy', 'uz', 'vx', 'vy', 'vz',
  'h', 'wf', 'ha', 'va', 'wrapEm', 'spacing', 'rgb', 'kind', 'fitMode', 'fitLen',
];

const MAX_DEPTH = 12;
const MAX_VERTICES = 8_000_000; // tope de seguridad de vértices de línea + relleno (≈ 4 M de segmentos)
const MAX_ARRAY_INSTANCES = 100_000;
const POINT_MIN_HALF = 0.03; // semilado mínimo de la cruz de un POINT (m)
const POINT_MAX_HALF = 0.3; // semilado máximo (m)
const POINT_REL_HALF = 0.0008; // fracción de la diagonal del dibujo
const FLAT_TOLERANCE = 1e-3; // m

// ---------------------------------------------------------------------------
// Búferes crecientes
// ---------------------------------------------------------------------------

class GrowF64 {
  constructor(cap = 256) {
    this.a = new Float64Array(cap);
    this.n = 0;
  }

  ensure(extra) {
    if (this.n + extra <= this.a.length) return;
    let cap = this.a.length * 2;
    while (cap < this.n + extra) cap *= 2;
    const b = new Float64Array(cap);
    b.set(this.a.subarray(0, this.n));
    this.a = b;
  }

  push3(x, y, z) {
    this.ensure(3);
    const a = this.a;
    a[this.n++] = x;
    a[this.n++] = y;
    a[this.n++] = z;
  }
}

class GrowU8 {
  constructor(cap = 256) {
    this.a = new Uint8Array(cap);
    this.n = 0;
  }

  push3(r, g, b) {
    if (this.n + 3 > this.a.length) {
      const c = new Uint8Array(this.a.length * 2);
      c.set(this.a.subarray(0, this.n));
      this.a = c;
    }
    this.a[this.n++] = r;
    this.a[this.n++] = g;
    this.a[this.n++] = b;
  }
}

// ---------------------------------------------------------------------------
// Triangulación de respaldo (sin huecos) cuando no se inyecta una
// ---------------------------------------------------------------------------

function polygonArea2(pts) {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    a += (pts[j].x * pts[i].y) - (pts[i].x * pts[j].y);
  }
  return a / 2;
}

// Quita el último punto si repite al primero (los triangulados esperan anillos abiertos).
function dedupeEnd(pts) {
  const n = pts.length;
  if (n > 2 && Math.abs(pts[n - 1].x - pts[0].x) < 1e-12 && Math.abs(pts[n - 1].y - pts[0].y) < 1e-12) pts.pop();
  return pts;
}

// Recorte de orejas para un polígono simple (ignora los huecos).
export function earClipTriangulate(contour, _holes = []) {
  const n = contour.length;
  if (n < 3) return [];
  const idx = [];
  const ccw = polygonArea2(contour) > 0;
  for (let i = 0; i < n; i++) idx.push(ccw ? i : n - 1 - i);
  const tris = [];
  const cross = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const inside = (p, a, b, c) => cross(a, b, p) >= 0 && cross(b, c, p) >= 0 && cross(c, a, p) >= 0;
  let guard = n * n + 10;
  while (idx.length > 3 && guard-- > 0) {
    let clipped = false;
    for (let i = 0; i < idx.length; i++) {
      const ia = idx[(i + idx.length - 1) % idx.length];
      const ib = idx[i];
      const ic = idx[(i + 1) % idx.length];
      const a = contour[ia];
      const b = contour[ib];
      const c = contour[ic];
      if (cross(a, b, c) <= 1e-14) continue;
      let ok = true;
      for (const k of idx) {
        if (k === ia || k === ib || k === ic) continue;
        if (inside(contour[k], a, b, c)) {
          ok = false;
          break;
        }
      }
      if (ok) {
        tris.push([ia, ib, ic]);
        idx.splice(i, 1);
        clipped = true;
        break;
      }
    }
    if (!clipped) break;
  }
  if (idx.length === 3) tris.push([idx[0], idx[1], idx[2]]);
  return tris;
}

// ---------------------------------------------------------------------------
// Geometría 2D auxiliar para lazos de HATCH
// ---------------------------------------------------------------------------

function pointInPolygon(x, y, flat) {
  let inside = false;
  const n = flat.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = flat[i * 2];
    const yi = flat[i * 2 + 1];
    const xj = flat[j * 2];
    const yj = flat[j * 2 + 1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function loopArea(flat) {
  let a = 0;
  const n = flat.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    a += flat[j * 2] * flat[i * 2 + 1] - flat[i * 2] * flat[j * 2 + 1];
  }
  return Math.abs(a / 2);
}

// Agrupa los lazos de un HATCH en { outer, holes } según la regla par-impar.
export function groupHatchLoops(loops) {
  const items = loops
    .filter((l) => l.length >= 6)
    .map((flat) => ({ flat, area: loopArea(flat) }))
    .sort((a, b) => b.area - a.area);
  if (items.length > 300) return items.map((it) => ({ outer: it.flat, holes: [] }));
  const groups = [];
  const groupOf = new Map();
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    // punto de prueba: primer vértice que no esté sobre el borde de otro lazo (se prueba con varios)
    let containers = null;
    const tries = Math.min(4, it.flat.length / 2);
    for (let t = 0; t < tries; t++) {
      const px = it.flat[t * 2];
      const py = it.flat[t * 2 + 1];
      const c = [];
      for (let j = 0; j < i; j++) if (pointInPolygon(px, py, items[j].flat)) c.push(j);
      if (!containers || c.length > containers.length) containers = c;
      if (c.length) break;
    }
    const depth = containers ? containers.length : 0;
    if (depth % 2 === 0) {
      const g = { outer: it.flat, holes: [] };
      groups.push(g);
      groupOf.set(i, g);
    } else {
      const parent = containers[containers.length - 1];
      const g = groupOf.get(parent);
      if (g) g.holes.push(it.flat);
    }
  }
  return groups;
}

// ---------------------------------------------------------------------------
// Constructor principal
// ---------------------------------------------------------------------------

//  ir:       formato intermedio de normalizeDxf/normalizeDwg
//  options:  { unitScale = 1, triangulate?: async (contour:{x,y}[], holes:{x,y}[][]) => number[][] | Promise,
//              onProgress?(phase, p) }
export async function buildGeometry(ir, options = {}) {
  const unitScale = options.unitScale > 0 ? options.unitScale : 1;
  const stats = {
    entities: 0, blockRefs: 0, segments: 0, triangles: 0, texts: 0, glyphs: 0,
    skipped: { ...(ir.stats?.skipped || {}) }, truncated: false,
  };

  // ---- Capas ----
  const layerMap = new Map(); // clave en mayúsculas → info
  const layerOrder = [];
  for (const l of ir.layers || []) {
    const key = String(l.name).toUpperCase();
    if (layerMap.has(key)) continue;
    const info = {
      name: l.name, key, aci: l.aci, rgb: l.rgb, off: !!l.off, frozen: !!l.frozen,
      declared: true, count: 0, acc: null,
    };
    layerMap.set(key, info);
    layerOrder.push(info);
  }

  function layerInfo(name) {
    const key = String(name).toUpperCase();
    let info = layerMap.get(key);
    if (!info) {
      info = { name, key, aci: 7, rgb: null, off: false, frozen: false, declared: false, count: 0, acc: null };
      layerMap.set(key, info);
      layerOrder.push(info);
    }
    return info;
  }

  function accOf(info) {
    if (!info.acc) {
      info.acc = {
        lineV: new GrowF64(), lineC: new GrowU8(),
        fillV: new GrowF64(), fillC: new GrowU8(),
        texts: new GrowF64(TEXT_STRIDE * 8), strings: [],
      };
    }
    return info.acc;
  }

  function layerInk(info) {
    const rgb = info.rgb != null ? info.rgb : (ACI_RGB[info.aci] ?? 0xffffff);
    return inkForLightBackground(rgb);
  }

  // ---- Bloques ----
  const blocks = ir.blocks || {};
  const blocksUpper = new Map();
  for (const [name, b] of Object.entries(blocks)) blocksUpper.set(name.toUpperCase(), b);
  const lookupBlock = (name) => blocks[name] || blocksUpper.get(String(name).toUpperCase()) || null;

  // ---- Caja real ----
  const bbox = { minE: Infinity, minN: Infinity, minZ: Infinity, maxE: -Infinity, maxN: -Infinity, maxZ: -Infinity };
  const grow = (e, n, z) => {
    if (e < bbox.minE) bbox.minE = e;
    if (e > bbox.maxE) bbox.maxE = e;
    if (n < bbox.minN) bbox.minN = n;
    if (n > bbox.maxN) bbox.maxN = n;
    if (z < bbox.minZ) bbox.minZ = z;
    if (z > bbox.maxZ) bbox.maxZ = z;
  };

  let vertexBudget = 0;
  const tmp = [0, 0, 0];
  const tmp2 = [0, 0, 0];

  function addSegment(info, ink, ax, ay, az, bx, by, bz) {
    if (vertexBudget > MAX_VERTICES) {
      stats.truncated = true;
      return;
    }
    if (!(Number.isFinite(ax) && Number.isFinite(ay) && Number.isFinite(az)
      && Number.isFinite(bx) && Number.isFinite(by) && Number.isFinite(bz))) return;
    const acc = accOf(info);
    const r = (ink >> 16) & 255;
    const g = (ink >> 8) & 255;
    const b = ink & 255;
    acc.lineV.push3(ax, ay, az);
    acc.lineV.push3(bx, by, bz);
    acc.lineC.push3(r, g, b);
    acc.lineC.push3(r, g, b);
    grow(ax, ay, az);
    grow(bx, by, bz);
    vertexBudget += 2;
    stats.segments++;
  }

  function addTriangle(info, ink, ax, ay, az, bx, by, bz, cx, cy, cz) {
    if (vertexBudget > MAX_VERTICES) {
      stats.truncated = true;
      return;
    }
    const acc = accOf(info);
    const r = (ink >> 16) & 255;
    const g = (ink >> 8) & 255;
    const b = ink & 255;
    acc.fillV.push3(ax, ay, az);
    acc.fillV.push3(bx, by, bz);
    acc.fillV.push3(cx, cy, cz);
    acc.fillC.push3(r, g, b);
    acc.fillC.push3(r, g, b);
    acc.fillC.push3(r, g, b);
    grow(ax, ay, az);
    grow(bx, by, bz);
    grow(cx, cy, cz);
    vertexBudget += 3;
    stats.triangles++;
  }

  // Transforma un arreglo plano local con M y devuelve Float64Array de puntos de mapa
  function transformFlat(M, flat) {
    const n = Math.floor(flat.length / 3);
    const out = new Float64Array(n * 3);
    for (let i = 0; i < n; i++) {
      matApply(M, flat[i * 3], flat[i * 3 + 1], flat[i * 3 + 2], tmp);
      out[i * 3] = tmp[0];
      out[i * 3 + 1] = tmp[1];
      out[i * 3 + 2] = tmp[2];
    }
    return out;
  }

  function emitPath(info, ink, world, closed) {
    const n = world.length / 3;
    for (let i = 0; i < n - 1; i++) {
      addSegment(info, ink,
        world[i * 3], world[i * 3 + 1], world[i * 3 + 2],
        world[i * 3 + 3], world[i * 3 + 4], world[i * 3 + 5]);
    }
    if (closed && n > 2) {
      const l = (n - 1) * 3;
      if (world[l] !== world[0] || world[l + 1] !== world[1] || world[l + 2] !== world[2]) {
        addSegment(info, ink, world[l], world[l + 1], world[l + 2], world[0], world[1], world[2]);
      }
    }
  }

  // ---- Resolución de capa y color ----
  const effLayer = (e, ctx) => (!e.layer || e.layer === '0' ? ctx.layer : e.layer);

  function inkOf(e, info, ctx) {
    if (e.rgb != null) return inkForLightBackground(e.rgb);
    const aci = e.aci;
    if (aci === 0) return ctx.ink != null ? ctx.ink : layerInk(info);
    if (aci >= 1 && aci <= 255) return inkForLightBackground(ACI_RGB[aci]);
    return layerInk(info);
  }

  // ---- Texto ----
  function pushTextRecord(info, ink, rec, str) {
    const acc = accOf(info);
    acc.texts.ensure(TEXT_STRIDE);
    const a = acc.texts.a;
    let o = acc.texts.n;
    for (let i = 0; i < TEXT_STRIDE; i++) a[o++] = rec[i];
    acc.texts.n = o;
    acc.strings.push(str);
    grow(rec[0], rec[1], rec[2]);
    stats.texts++;
    stats.glyphs += str.length;
  }

  function emitTextLike(e, info, ink, ctx) {
    const MO = e.ext ? matMul(ctx.M, matOcs(e.ext)) : ctx.M;
    let rot = e.rot || 0;
    let p = e.p;
    let ha = 0;
    let va = 0;
    let fitMode = 0;
    let fitLen = 0;
    let wrapEm = 0;
    let spacing = 1;
    let s;
    let kind = 0;
    let ux;
    let uy;

    if (e.t === 'MTEXT') {
      kind = 1;
      s = e.s;
      const attach = Math.min(9, Math.max(1, e.attach || 1));
      ha = (attach - 1) % 3;
      va = [3, 2, 1][Math.floor((attach - 1) / 3)];
      if (e.dir) {
        const dl = Math.hypot(e.dir[0], e.dir[1]) || 1;
        ux = e.dir[0] / dl;
        uy = e.dir[1] / dl;
      }
      wrapEm = e.w > 0 && e.h > 0 ? e.w / e.h : 0;
      spacing = e.spacing || 1;
    } else {
      s = e.s;
      ha = e.ha || 0;
      va = e.va || 0;
      if (ha === 3 || ha === 5) {
        const p2 = e.p2 || e.p;
        const dx = p2[0] - p[0];
        const dy = p2[1] - p[1];
        const len = Math.hypot(dx, dy);
        if (len > 1e-12 && e.h > 0) {
          rot = Math.atan2(dy, dx);
          fitLen = len / e.h;
          fitMode = ha === 3 ? 1 : 2;
        }
        ha = 0;
      } else if (ha === 4) {
        if (e.p2) p = e.p2;
        ha = 1;
        va = 2;
      } else if (ha !== 0 || va !== 0) {
        if (e.p2) p = e.p2;
      }
    }
    if (!s || !(e.h > 0)) return false;
    if (ux === undefined) {
      ux = Math.cos(rot);
      uy = Math.sin(rot);
    }
    let U = [ux, uy, 0];
    let V = [-uy, ux, 0];
    if (e.obl) {
      const t = Math.tan(e.obl);
      V = [V[0] + U[0] * t, V[1] + U[1] * t, 0];
    }
    if (e.back) U = [-U[0], -U[1], 0];
    if (e.up) V = [-V[0], -V[1], 0];
    matApply(MO, p[0], p[1], p[2], tmp);
    matApplyVec(MO, U[0], U[1], U[2], tmp2);
    const pw = [tmp[0], tmp[1], tmp[2]];
    const uw = [tmp2[0], tmp2[1], tmp2[2]];
    matApplyVec(MO, V[0], V[1], V[2], tmp2);
    const vw = [tmp2[0], tmp2[1], tmp2[2]];
    const rec = [
      pw[0], pw[1], pw[2], uw[0], uw[1], uw[2], vw[0], vw[1], vw[2],
      e.h, e.wf || 1, ha, va, wrapEm, spacing, ink, kind, fitMode, fitLen,
    ];
    pushTextRecord(info, ink, rec, s);
    return true;
  }

  // ---- Puntos y rellenos diferidos ----
  const deferredPoints = [];
  const deferredFills = [];

  function strip3(flat) {
    const out = new Array((flat.length / 3) * 2);
    for (let i = 0; i < flat.length / 3; i++) {
      out[i * 2] = flat[i * 3];
      out[i * 2 + 1] = flat[i * 3 + 1];
    }
    return out;
  }

  function reverse2(flat) {
    const out = new Array(flat.length);
    const n = flat.length / 2;
    for (let i = 0; i < n; i++) {
      out[i * 2] = flat[(n - 1 - i) * 2];
      out[i * 2 + 1] = flat[(n - 1 - i) * 2 + 1];
    }
    return out;
  }

  function hatchLoopPoints(edges) {
    const pts = [];
    for (const ed of edges) {
      let seg = null;
      switch (ed.k) {
        case 'L':
          seg = [ed.a[0], ed.a[1], ed.b[0], ed.b[1]];
          break;
        case 'A': {
          if (!(ed.r > 0)) break;
          seg = ed.ccw
            ? strip3(arcPoints(ed.c[0], ed.c[1], 0, ed.r, ed.a0, ed.a1))
            : reverse2(strip3(arcPoints(ed.c[0], ed.c[1], 0, ed.r, ed.a1, ed.a0)));
          break;
        }
        case 'E': {
          const c3 = [ed.c[0], ed.c[1], 0];
          const mj = [ed.major[0], ed.major[1], 0];
          seg = ed.ccw
            ? strip3(ellipsePoints(c3, mj, [0, 0, 1], ed.ratio, ed.a0, ed.a1))
            : reverse2(strip3(ellipsePoints(c3, mj, [0, 0, 1], ed.ratio, ed.a1, ed.a0)));
          break;
        }
        case 'S': {
          const ctrl = [];
          for (let i = 0; i < ed.ctrl.length; i += 2) ctrl.push(ed.ctrl[i], ed.ctrl[i + 1], 0);
          const fit = [];
          for (let i = 0; i < (ed.fit || []).length; i += 2) fit.push(ed.fit[i], ed.fit[i + 1], 0);
          seg = strip3(splinePoints({
            degree: ed.degree, knots: ed.knots, ctrl, weights: ed.weights, fit, closed: false,
          }));
          break;
        }
        case 'P': {
          const out3 = [];
          const v = ed.pts;
          const n = v.length / 3;
          if (n < 2) break;
          out3.push(v[0], v[1], 0);
          for (let i = 0; i < n - 1; i++) {
            appendBulgeSegment(out3, v[i * 3], v[i * 3 + 1], 0, v[(i + 1) * 3], v[(i + 1) * 3 + 1], 0, v[i * 3 + 2]);
          }
          if (ed.closed) {
            appendBulgeSegment(out3, v[(n - 1) * 3], v[(n - 1) * 3 + 1], 0, v[0], v[1], 0, v[(n - 1) * 3 + 2]);
          }
          seg = strip3(out3);
          break;
        }
        default:
          break;
      }
      if (!seg || seg.length < 4) continue;
      if (pts.length) {
        const lx = pts[pts.length - 2];
        const ly = pts[pts.length - 1];
        const dStart = Math.hypot(seg[0] - lx, seg[1] - ly);
        const dEnd = Math.hypot(seg[seg.length - 2] - lx, seg[seg.length - 1] - ly);
        if (dEnd + 1e-9 < dStart) seg = reverse2(seg);
        const d0 = Math.hypot(seg[0] - lx, seg[1] - ly);
        for (let i = d0 < 1e-9 ? 2 : 0; i < seg.length; i++) pts.push(seg[i]);
      } else {
        for (let i = 0; i < seg.length; i++) pts.push(seg[i]);
      }
    }
    return pts;
  }

  function processHatch(e, info, ink, ctx) {
    const MO = e.ext ? matMul(ctx.M, matOcs(e.ext)) : ctx.M;
    const loops2d = [];
    for (const edges of e.loops) {
      const flat = hatchLoopPoints(edges);
      if (flat.length < 6) continue;
      loops2d.push(flat);
      // Contorno como líneas
      const world = new Float64Array((flat.length / 2) * 3);
      for (let i = 0; i < flat.length / 2; i++) {
        matApply(MO, flat[i * 2], flat[i * 2 + 1], e.elev || 0, tmp);
        world[i * 3] = tmp[0];
        world[i * 3 + 1] = tmp[1];
        world[i * 3 + 2] = tmp[2];
      }
      emitPath(info, ink, world, true);
    }
    if (e.solid && loops2d.length) {
      deferredFills.push({ info, ink, loops: loops2d, M: MO, z: e.elev || 0 });
    }
  }

  // ---- Procesado de entidades ----
  let truncatedBlocks = false;

  function processEntity(e, ctx) {
    if (vertexBudget > MAX_VERTICES) {
      stats.truncated = true;
      return;
    }
    const layerName = effLayer(e, ctx);
    switch (e.t) {
      case 'LINE': {
        const info = layerInfo(layerName);
        const ink = inkOf(e, info, ctx);
        matApply(ctx.M, e.a[0], e.a[1], e.a[2], tmp);
        const ax = tmp[0];
        const ay = tmp[1];
        const az = tmp[2];
        matApply(ctx.M, e.b[0], e.b[1], e.b[2], tmp);
        addSegment(info, ink, ax, ay, az, tmp[0], tmp[1], tmp[2]);
        info.count++;
        stats.entities++;
        return;
      }
      case 'POLY': {
        const info = layerInfo(layerName);
        const ink = inkOf(e, info, ctx);
        const MO = e.ext && !e.is3d ? matMul(ctx.M, matOcs(e.ext)) : ctx.M;
        const v = e.pts;
        const n = v.length / 4;
        const local = [v[0], v[1], v[2]];
        for (let i = 0; i < n - 1; i++) {
          appendBulgeSegment(local, v[i * 4], v[i * 4 + 1], v[i * 4 + 2], v[i * 4 + 4], v[i * 4 + 5], v[i * 4 + 6], v[i * 4 + 3]);
        }
        // Tramo de cierre; con 2 vértices solo si hay bulge (círculo dibujado con dos arcos)
        if (e.closed && (n > 2 || v[(n - 1) * 4 + 3] !== 0)) {
          const l = (n - 1) * 4;
          appendBulgeSegment(local, v[l], v[l + 1], v[l + 2], v[0], v[1], v[2], v[l + 3]);
        }
        emitPath(info, ink, transformFlat(MO, local), false);
        info.count++;
        stats.entities++;
        return;
      }
      case 'CIRCLE': {
        const info = layerInfo(layerName);
        const ink = inkOf(e, info, ctx);
        const MO = e.ext ? matMul(ctx.M, matOcs(e.ext)) : ctx.M;
        emitPath(info, ink, transformFlat(MO, circlePoints(e.c[0], e.c[1], e.c[2], e.r)), false);
        info.count++;
        stats.entities++;
        return;
      }
      case 'ARC': {
        const info = layerInfo(layerName);
        const ink = inkOf(e, info, ctx);
        const MO = e.ext ? matMul(ctx.M, matOcs(e.ext)) : ctx.M;
        emitPath(info, ink, transformFlat(MO, arcPoints(e.c[0], e.c[1], e.c[2], e.r, e.a0, e.a1)), false);
        info.count++;
        stats.entities++;
        return;
      }
      case 'ELLIPSE': {
        const info = layerInfo(layerName);
        const ink = inkOf(e, info, ctx);
        const pts = ellipsePoints(e.c, e.major, e.ext || [0, 0, 1], e.ratio, e.a0, e.a1);
        if (!pts.length) return;
        emitPath(info, ink, transformFlat(ctx.M, pts), false);
        info.count++;
        stats.entities++;
        return;
      }
      case 'SPLINE': {
        const info = layerInfo(layerName);
        const ink = inkOf(e, info, ctx);
        const pts = splinePoints(e);
        if (pts.length < 6) return;
        emitPath(info, ink, transformFlat(ctx.M, pts), false);
        info.count++;
        stats.entities++;
        return;
      }
      case 'POINT': {
        const info = layerInfo(layerName);
        const ink = inkOf(e, info, ctx);
        matApply(ctx.M, e.p[0], e.p[1], e.p[2], tmp);
        // La cruz se dibuja al final: su tamaño depende de la diagonal del dibujo
        deferredPoints.push({ info, ink, x: tmp[0], y: tmp[1], z: tmp[2] });
        info.count++;
        stats.entities++;
        return;
      }
      case 'TEXT':
      case 'MTEXT': {
        const info = layerInfo(layerName);
        const ink = inkOf(e, info, ctx);
        if (emitTextLike(e, info, ink, ctx)) {
          info.count++;
          stats.entities++;
        }
        return;
      }
      case 'SOLID':
      case 'FACE': {
        const info = layerInfo(layerName);
        const ink = inkOf(e, info, ctx);
        const MO = e.t === 'SOLID' && e.ext ? matMul(ctx.M, matOcs(e.ext)) : ctx.M;
        let pts = e.pts;
        if (e.t === 'SOLID' && pts.length === 4) {
          // Orden de SOLID: 1, 2, 4, 3
          pts = [pts[0], pts[1], pts[3], pts[2]];
        }
        // Triángulo si el último vértice repite al penúltimo
        if (pts.length === 4) {
          const a = pts[2];
          const b = pts[3];
          if (a[0] === b[0] && a[1] === b[1] && a[2] === b[2]) pts = pts.slice(0, 3);
        }
        const w = pts.map((q) => matApply(MO, q[0], q[1], q[2], [0, 0, 0]));
        for (let i = 0; i < w.length; i++) {
          const a = w[i];
          const b = w[(i + 1) % w.length];
          addSegment(info, ink, a[0], a[1], a[2], b[0], b[1], b[2]);
        }
        for (let i = 1; i < w.length - 1; i++) {
          addTriangle(info, ink, w[0][0], w[0][1], w[0][2], w[i][0], w[i][1], w[i][2], w[i + 1][0], w[i + 1][1], w[i + 1][2]);
        }
        info.count++;
        stats.entities++;
        return;
      }
      case 'HATCH': {
        const info = layerInfo(layerName);
        const ink = inkOf(e, info, ctx);
        processHatch(e, info, ink, ctx);
        info.count++;
        stats.entities++;
        return;
      }
      case 'INSERT':
        processInsert(e, ctx, layerName);
        return;
      case 'DIMENSION':
        processDimension(e, ctx, layerName);
        return;
      default:
        stats.skipped[e.t] = (stats.skipped[e.t] || 0) + 1;
    }
  }

  function expandBlock(blk, name, M, layerName, ink, ctx) {
    const child = {
      M, layer: layerName, ink, depth: ctx.depth + 1, stack: new Set(ctx.stack).add(String(name).toUpperCase()),
    };
    for (const sub of blk.entities) processEntity(sub, child);
  }

  function processInsert(e, ctx, layerName) {
    const info = layerInfo(layerName);
    const ink = inkOf(e, info, ctx);
    const blk = lookupBlock(e.name);
    if (!blk) {
      stats.skipped['INSERT(bloque inexistente)'] = (stats.skipped['INSERT(bloque inexistente)'] || 0) + 1;
    } else if (ctx.depth >= MAX_DEPTH || ctx.stack.has(String(e.name).toUpperCase())) {
      truncatedBlocks = true;
      stats.skipped['INSERT(recursión)'] = (stats.skipped['INSERT(recursión)'] || 0) + 1;
    } else if (blk.entities.length) {
      const rows = Math.max(1, e.rows || 1);
      const cols = Math.max(1, e.cols || 1);
      const total = Math.min(rows * cols, MAX_ARRAY_INSTANCES);
      const O = matOcs(e.ext);
      const T = matTranslate(e.p[0], e.p[1], e.p[2]);
      const R = matRotZ(e.rot || 0);
      const S = matScale(e.sx, e.sy, e.sz);
      const B = matTranslate(-blk.base[0], -blk.base[1], -blk.base[2]);
      const pre = matMul(ctx.M, matMul(O, matMul(T, R)));
      const post = matMul(S, B);
      let made = 0;
      for (let r = 0; r < rows && made < total; r++) {
        for (let c = 0; c < cols && made < total; c++) {
          const offs = rows * cols > 1 ? matTranslate(c * e.dx, r * e.dy, 0) : matIdentity();
          const M = matMul(pre, matMul(offs, post));
          expandBlock(blk, e.name, M, layerName, ink, ctx);
          stats.blockRefs++;
          made++;
        }
      }
    }
    // Los atributos se expresan en el sistema del contenedor, no en el del bloque
    for (const a of e.attribs || []) processEntity(a, { ...ctx, layer: layerName, ink });
  }

  function processDimension(e, ctx, layerName) {
    const info = layerInfo(layerName);
    const ink = inkOf(e, info, ctx);
    const blk = lookupBlock(e.block);
    if (!blk) {
      stats.skipped['DIMENSION(sin bloque)'] = (stats.skipped['DIMENSION(sin bloque)'] || 0) + 1;
      return;
    }
    if (ctx.depth >= MAX_DEPTH || ctx.stack.has(String(e.block).toUpperCase())) return;
    const M = matMul(ctx.M, matTranslate(-blk.base[0], -blk.base[1], -blk.base[2]));
    expandBlock(blk, e.block, M, layerName, ink, ctx);
    stats.blockRefs++;
  }

  // ---- Recorrido ----
  const root = {
    M: matScale(unitScale, unitScale, unitScale), layer: '0', ink: null, depth: 0, stack: new Set(),
  };
  const total = ir.entities.length;
  for (let i = 0; i < total; i++) {
    processEntity(ir.entities[i], root);
    if (options.onProgress && (i & 0x3ff) === 0) options.onProgress('build', (i / total) * 0.8);
  }

  // ---- Rellenos de HATCH (triangulación) ----
  if (deferredFills.length) {
    let tri = options.triangulate || null;
    if (!tri && options.getTriangulator) {
      try {
        tri = await options.getTriangulator();
      } catch {
        tri = null;
      }
    }
    if (!tri) tri = earClipTriangulate;
    for (const job of deferredFills) {
      const groups = groupHatchLoops(job.loops);
      for (const g of groups) {
        // Se triangula en coordenadas relativas al primer vértice (más estable numéricamente)
        const x0 = g.outer[0];
        const y0 = g.outer[1];
        const toPts = (flat) => {
          const arr = [];
          for (let i = 0; i < flat.length / 2; i++) {
            arr.push({ x: flat[i * 2] - x0, y: flat[i * 2 + 1] - y0, ox: flat[i * 2], oy: flat[i * 2 + 1] });
          }
          return dedupeEnd(arr);
        };
        const contour = toPts(g.outer);
        const holes = g.holes.map(toPts);
        if (contour.length < 3) continue;
        let faces;
        try {
          faces = await tri(contour, holes);
        } catch {
          faces = earClipTriangulate(contour, holes);
        }
        const all = contour.concat(...holes);
        const world = all.map((q) => matApply(job.M, q.ox, q.oy, job.z, [0, 0, 0]));
        for (const f of faces) {
          const a = world[f[0]];
          const b = world[f[1]];
          const c = world[f[2]];
          if (!a || !b || !c) continue;
          addTriangle(job.info, job.ink, a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
        }
      }
    }
  }

  // ---- POINT: cruz proporcional al tamaño del dibujo ----
  if (deferredPoints.length) {
    for (const q of deferredPoints) grow(q.x, q.y, q.z);
    const diag = Math.hypot(bbox.maxE - bbox.minE, bbox.maxN - bbox.minN);
    const half = Math.min(POINT_MAX_HALF, Math.max(POINT_MIN_HALF, diag * POINT_REL_HALF));
    for (const q of deferredPoints) {
      addSegment(q.info, q.ink, q.x - half, q.y, q.z, q.x + half, q.y, q.z);
      addSegment(q.info, q.ink, q.x, q.y - half, q.z, q.x, q.y + half, q.z);
    }
  }

  if (!Number.isFinite(bbox.minE)) {
    throw new Error('El dibujo no contiene geometría visible en el espacio modelo.');
  }

  // ---- Ancla y extensión reales ----
  const hasZ = Math.max(Math.abs(bbox.minZ), Math.abs(bbox.maxZ)) >= FLAT_TOLERANCE;
  const anchor = {
    e: Math.round((bbox.minE + bbox.maxE) / 2),
    n: Math.round((bbox.minN + bbox.maxN) / 2),
    h: hasZ ? Math.round((bbox.minZ + bbox.maxZ) / 2) : 0,
  };
  const extents = {
    min: { e: bbox.minE, n: bbox.minN, h: bbox.minZ },
    max: { e: bbox.maxE, n: bbox.maxN, h: bbox.maxZ },
  };

  // ---- Conversión a escena local (Float32 relativos al ancla) ----
  const toScene = (g) => {
    const n = g.n / 3;
    const out = new Float32Array(g.n);
    const a = g.a;
    for (let i = 0; i < n; i++) {
      out[i * 3] = a[i * 3] - anchor.e;
      out[i * 3 + 1] = a[i * 3 + 2] - anchor.h;
      out[i * 3 + 2] = -(a[i * 3 + 1] - anchor.n);
    }
    return out;
  };

  const parts = [];
  const layers = [];
  for (const info of layerOrder) {
    if (info.count === 0 && !info.acc) continue;
    const acc = info.acc;
    layers.push({
      name: info.name,
      color: rgbToHex(layerInk(info)),
      count: info.count,
      hidden: info.off || info.frozen,
    });
    if (!acc) continue;
    const part = { layer: info.name, lines: null, fills: null, texts: null };
    if (acc.lineV.n) {
      part.lines = { pos: toScene(acc.lineV), col: acc.lineC.a.slice(0, acc.lineC.n) };
    }
    if (acc.fillV.n) {
      part.fills = { pos: toScene(acc.fillV), col: acc.fillC.a.slice(0, acc.fillC.n) };
    }
    if (acc.strings.length) {
      const src = acc.texts.a;
      const n = acc.strings.length;
      const data = new Float32Array(n * TEXT_STRIDE);
      for (let i = 0; i < n; i++) {
        const o = i * TEXT_STRIDE;
        const s = i * TEXT_STRIDE;
        // posición → escena local
        data[o] = src[s] - anchor.e;
        data[o + 1] = src[s + 2] - anchor.h;
        data[o + 2] = -(src[s + 1] - anchor.n);
        // vectores u y v → escena
        data[o + 3] = src[s + 3];
        data[o + 4] = src[s + 5];
        data[o + 5] = -src[s + 4];
        data[o + 6] = src[s + 6];
        data[o + 7] = src[s + 8];
        data[o + 8] = -src[s + 7];
        for (let k = 9; k < TEXT_STRIDE; k++) data[o + k] = src[s + k];
      }
      part.texts = { data, strings: acc.strings };
    }
    parts.push(part);
  }

  options.onProgress?.('build', 1);

  return {
    anchor,
    extents,
    hasZ,
    flat: !hasZ,
    layers,
    parts,
    stats: { ...stats, truncatedBlocks },
  };
}

// Buffers transferibles de un resultado de buildGeometry
export function collectTransferables(result) {
  const list = [];
  for (const p of result.parts) {
    if (p.lines) list.push(p.lines.pos.buffer, p.lines.col.buffer);
    if (p.fills) list.push(p.fills.pos.buffer, p.fills.col.buffer);
    if (p.texts) list.push(p.texts.data.buffer);
  }
  return list;
}
