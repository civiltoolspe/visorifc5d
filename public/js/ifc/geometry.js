// Procesado puro de geometría: fusión de instancias de web-ifc en lotes y cálculo de aristas.
// Sin dependencias de three.js ni del DOM (se usa desde el worker y desde Node).
//
// Entrada (por cada geometría colocada de web-ifc):
//   vértices: Float32 entrelazado [x y z nx ny nz] (en unidades del modelo)
//   índices: Uint32
//   matriz plana (columna-mayor, 16) que incluye escala de unidades, rotación Y-arriba y desplazamiento de coordinación
// Salida: lotes con posiciones Float32 (relativas al origen local de web-ifc), normales Int8 (x4),
// colores Uint8 RGBA (sRGB), atributo elementIndex (Float32) e índices Uint32.

export const CLASS_OPAQUE = 0;
export const CLASS_TRANSPARENT = 1;

// --------------------------------------------------------------------------------------------
// Aristas
// --------------------------------------------------------------------------------------------

function nextPow2(n) {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

// Búferes de trabajo reutilizables (evitan asignar decenas de arreglos por cada geometría pequeña).
const scratch = {};
function work(name, Type, size) {
  let a = scratch[name];
  if (!a || a.length < size) {
    a = new Type(Math.max(size, a ? a.length * 2 : 256));
    scratch[name] = a;
  }
  return a;
}

// Calcula las aristas "duras" de una malla: las de contorno (un solo triángulo) y aquellas donde el
// ángulo entre las normales de los triángulos vecinos supera el umbral. Los vértices duplicados
// (misma posición) se sueldan antes de buscar vecinos.
// verts: Float32Array entrelazado (stride 6); devuelve Float32Array con 6 floats por segmento.
export function computeEdges(verts, vcount, idx, icount, angleDeg = 30) {
  const triCount = Math.floor(icount / 3);
  if (triCount === 0 || vcount === 0) return new Float32Array(0);

  // Caja para fijar la tolerancia de soldadura
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < vcount; i++) {
    const s = i * 6;
    const x = verts[s], y = verts[s + 1], z = verts[s + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  const diag = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ);
  if (!(diag > 0)) return new Float32Array(0);
  const q = 1 / (diag * 1e-6);

  // Soldadura de vértices con tabla hash de direccionamiento abierto
  const cap = nextPow2(vcount * 2 + 2);
  const mask = cap - 1;
  const slots = work('slots', Int32Array, cap);
  slots.fill(-1, 0, cap);
  const qx = work('qx', Int32Array, vcount);
  const qy = work('qy', Int32Array, vcount);
  const qz = work('qz', Int32Array, vcount);
  const weld = work('weld', Int32Array, vcount);
  for (let i = 0; i < vcount; i++) {
    const s = i * 6;
    const ix = Math.round((verts[s] - minX) * q) | 0;
    const iy = Math.round((verts[s + 1] - minY) * q) | 0;
    const iz = Math.round((verts[s + 2] - minZ) * q) | 0;
    qx[i] = ix; qy[i] = iy; qz[i] = iz;
    let h = (Math.imul(ix, 73856093) ^ Math.imul(iy, 19349663) ^ Math.imul(iz, 83492791)) & mask;
    for (;;) {
      const c = slots[h];
      if (c === -1) {
        slots[h] = i;
        weld[i] = i;
        break;
      }
      if (qx[c] === ix && qy[c] === iy && qz[c] === iz) {
        weld[i] = c;
        break;
      }
      h = (h + 1) & mask;
    }
  }

  // Normales de cara
  const fn = work('fn', Float32Array, triCount * 3);
  const valid = work('valid', Uint8Array, triCount);
  const minArea2 = diag * diag * 1e-14;
  for (let t = 0; t < triCount; t++) {
    const a = idx[t * 3] * 6, b = idx[t * 3 + 1] * 6, c = idx[t * 3 + 2] * 6;
    const ux = verts[b] - verts[a], uy = verts[b + 1] - verts[a + 1], uz = verts[b + 2] - verts[a + 2];
    const vx = verts[c] - verts[a], vy = verts[c + 1] - verts[a + 1], vz = verts[c + 2] - verts[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len > minArea2) {
      fn[t * 3] = nx / len; fn[t * 3 + 1] = ny / len; fn[t * 3 + 2] = nz / len;
      valid[t] = 1;
    } else {
      valid[t] = 0;
    }
  }

  // Aristas: tabla hash (lo, hi) -> triángulo + 1 la primera vez; -1 cuando ya se resolvió
  const cosT = Math.cos((angleDeg * Math.PI) / 180);
  const ecap = nextPow2(triCount * 6 + 2);
  const emask = ecap - 1;
  const eLo = work('eLo', Int32Array, ecap);
  const eHi = work('eHi', Int32Array, ecap);
  const eTri = work('eTri', Int32Array, ecap);
  eLo.fill(-1, 0, ecap);
  let out = work('edgeOut', Float32Array, 6 * 64);
  let outLen = 0;
  const pushEdge = (va, vb) => {
    if (outLen + 6 > out.length) {
      const bigger = new Float32Array(out.length * 2);
      bigger.set(out.subarray(0, outLen));
      out = bigger;
      scratch.edgeOut = bigger;
    }
    const a = va * 6, b = vb * 6;
    out[outLen++] = verts[a]; out[outLen++] = verts[a + 1]; out[outLen++] = verts[a + 2];
    out[outLen++] = verts[b]; out[outLen++] = verts[b + 1]; out[outLen++] = verts[b + 2];
  };
  for (let t = 0; t < triCount; t++) {
    if (!valid[t]) continue;
    for (let e = 0; e < 3; e++) {
      const wa = weld[idx[t * 3 + e]];
      const wb = weld[idx[t * 3 + ((e + 1) % 3)]];
      if (wa === wb) continue;
      const lo = wa < wb ? wa : wb;
      const hi = wa < wb ? wb : wa;
      let h = (Math.imul(lo, 73856093) ^ Math.imul(hi, 19349663)) & emask;
      for (;;) {
        const l = eLo[h];
        if (l === -1) {
          eLo[h] = lo; eHi[h] = hi; eTri[h] = t + 1;
          break;
        }
        if (l === lo && eHi[h] === hi) {
          const prev = eTri[h];
          if (prev > 0) {
            const o = (prev - 1) * 3;
            const dot = fn[o] * fn[t * 3] + fn[o + 1] * fn[t * 3 + 1] + fn[o + 2] * fn[t * 3 + 2];
            if (dot < cosT) pushEdge(lo, hi);
            eTri[h] = -1;
          }
          break;
        }
        h = (h + 1) & emask;
      }
    }
  }
  // Aristas de contorno: las que sólo tienen un triángulo
  for (let h = 0; h < ecap; h++) {
    if (eLo[h] !== -1 && eTri[h] > 0) pushEdge(eLo[h], eHi[h]);
  }
  return out.slice(0, outLen);
}

// --------------------------------------------------------------------------------------------
// Constructor de lotes
// --------------------------------------------------------------------------------------------

class MeshBuf {
  constructor() {
    this.vcap = 0;
    this.icap = 0;
    this.vcount = 0;
    this.icount = 0;
    this.pos = new Float32Array(0);
    this.nrm = new Int8Array(0);
    this.col = new Uint8Array(0);
    this.eid = new Float32Array(0);
    this.idx = new Uint32Array(0);
  }

  ensure(addV, addI) {
    const needV = this.vcount + addV;
    if (needV > this.vcap) {
      const cap = Math.max(needV, Math.max(4096, this.vcap * 2));
      const pos = new Float32Array(cap * 3); pos.set(this.pos.subarray(0, this.vcount * 3));
      const nrm = new Int8Array(cap * 4); nrm.set(this.nrm.subarray(0, this.vcount * 4));
      const col = new Uint8Array(cap * 4); col.set(this.col.subarray(0, this.vcount * 4));
      const eid = new Float32Array(cap); eid.set(this.eid.subarray(0, this.vcount));
      this.pos = pos; this.nrm = nrm; this.col = col; this.eid = eid;
      this.vcap = cap;
    }
    const needI = this.icount + addI;
    if (needI > this.icap) {
      const cap = Math.max(needI, Math.max(8192, this.icap * 2));
      const idx = new Uint32Array(cap); idx.set(this.idx.subarray(0, this.icount));
      this.idx = idx;
      this.icap = cap;
    }
  }

  take() {
    if (!this.vcount || !this.icount) {
      this.vcount = 0; this.icount = 0;
      return null;
    }
    const out = {
      positions: this.pos.slice(0, this.vcount * 3),
      normals: this.nrm.slice(0, this.vcount * 4),
      colors: this.col.slice(0, this.vcount * 4),
      elementIndex: this.eid.slice(0, this.vcount),
      indices: this.idx.slice(0, this.icount),
    };
    this.vcount = 0;
    this.icount = 0;
    return out;
  }
}

class EdgeBuf {
  constructor() {
    this.cap = 0;
    this.count = 0; // vértices (2 por segmento)
    this.pos = new Float32Array(0);
    this.eid = new Float32Array(0);
  }

  ensure(addV) {
    const need = this.count + addV;
    if (need > this.cap) {
      const cap = Math.max(need, Math.max(4096, this.cap * 2));
      const pos = new Float32Array(cap * 3); pos.set(this.pos.subarray(0, this.count * 3));
      const eid = new Float32Array(cap); eid.set(this.eid.subarray(0, this.count));
      this.pos = pos; this.eid = eid; this.cap = cap;
    }
  }

  take() {
    if (!this.count) return null;
    const out = { positions: this.pos.slice(0, this.count * 3), elementIndex: this.eid.slice(0, this.count) };
    this.count = 0;
    return out;
  }
}

function srgbByte(v) {
  const n = Math.round(v * 255);
  return n < 0 ? 0 : n > 255 ? 255 : n;
}

export class ChunkBuilder {
  constructor({ edgeAngleDeg = 30, edges = true, maxEdgeTriangles = 200000, edgeCacheFloats = 6_000_000 } = {}) {
    this.edgeAngleDeg = edgeAngleDeg;
    this.edgesEnabled = edges;
    this.maxEdgeTriangles = maxEdgeTriangles;
    this.edgeCacheFloats = edgeCacheFloats;
    this.classes = [new MeshBuf(), new MeshBuf()];
    this.edgeBuf = new EdgeBuf();
    this._edgeCache = new Map();
    this._edgeCacheSize = 0;
    this._cur = -1;
    this._mark = null;
    this._box = new Float64Array(6);
    this._boxValid = false;
  }

  get pendingVertices() {
    return this.classes[0].vcount + this.classes[1].vcount + this.edgeBuf.count;
  }

  beginElement(index) {
    this._cur = index;
    const [a, b] = this.classes;
    this._mark = [a.vcount, a.icount, b.vcount, b.icount, this.edgeBuf.count];
    this._box[0] = this._box[1] = this._box[2] = Infinity;
    this._box[3] = this._box[4] = this._box[5] = -Infinity;
    this._boxValid = false;
  }

  // Descarta lo añadido desde beginElement (si el procesado del elemento falló a mitad).
  abortElement() {
    if (!this._mark) return;
    const [a, b] = this.classes;
    [a.vcount, a.icount, b.vcount, b.icount, this.edgeBuf.count] = this._mark;
    this._boxValid = false;
  }

  // Devuelve la caja del elemento (Float32Array de 6: min xyz, max xyz) o null si no aportó triángulos.
  endElement() {
    if (!this._boxValid) return null;
    const b = this._box;
    return new Float32Array([b[0], b[1], b[2], b[3], b[4], b[5]]);
  }

  _edgesFor(key, verts, vcount, idx, icount) {
    if (key !== undefined) {
      const hit = this._edgeCache.get(key);
      if (hit) return hit;
    }
    if (icount / 3 > this.maxEdgeTriangles) return null;
    const segs = computeEdges(verts, vcount, idx, icount, this.edgeAngleDeg);
    if (key !== undefined) {
      if (this._edgeCacheSize + segs.length > this.edgeCacheFloats) {
        this._edgeCache.clear();
        this._edgeCacheSize = 0;
      }
      this._edgeCache.set(key, segs);
      this._edgeCacheSize += segs.length;
    }
    return segs;
  }

  // Añade una geometría colocada.
  //   verts: Float32Array entrelazado (stride 6), vcount vértices
  //   idx: Uint32Array, icount índices
  //   m: matriz plana de 16 (columna-mayor)
  //   rgba: [r, g, b, a] en 0..1; cls: CLASS_OPAQUE | CLASS_TRANSPARENT
  //   geometryKey: identificador de la geometría (para la caché de aristas)
  //   withEdges: false para no generar aristas (p. ej. espacios)
  addPlaced(verts, vcount, idx, icount, m, rgba, cls, geometryKey, withEdges = true) {
    if (vcount === 0 || icount < 3) return false;
    const a = m[0], b = m[4], c = m[8], tx = m[12];
    const d = m[1], e = m[5], f = m[9], ty = m[13];
    const g = m[2], h = m[6], i2 = m[10], tz = m[14];

    // Cofactores para transformar normales (n' ∝ sign(det) * C * n)
    const c00 = e * i2 - f * h, c01 = f * g - d * i2, c02 = d * h - e * g;
    const c10 = c * h - b * i2, c11 = a * i2 - c * g, c12 = b * g - a * h;
    const c20 = b * f - c * e, c21 = c * d - a * f, c22 = a * e - b * d;
    const det = a * c00 + b * c01 + c * c02;
    if (!Number.isFinite(det) || det === 0) return false;
    const sgn = det < 0 ? -1 : 1;

    const buf = this.classes[cls];
    buf.ensure(vcount, icount);
    const base = buf.vcount;
    const pos = buf.pos, nrm = buf.nrm, col = buf.col, eid = buf.eid;
    const r = srgbByte(rgba[0]), gg = srgbByte(rgba[1]), bb = srgbByte(rgba[2]), aa = srgbByte(rgba[3]);
    const cur = this._cur;
    const box = this._box;
    let minX = box[0], minY = box[1], minZ = box[2], maxX = box[3], maxY = box[4], maxZ = box[5];

    for (let i = 0; i < vcount; i++) {
      const s = i * 6;
      const x = verts[s], y = verts[s + 1], z = verts[s + 2];
      const px = a * x + b * y + c * z + tx;
      const py = d * x + e * y + f * z + ty;
      const pz = g * x + h * y + i2 * z + tz;
      const vi = base + i;
      const o3 = vi * 3;
      pos[o3] = px; pos[o3 + 1] = py; pos[o3 + 2] = pz;
      if (px < minX) minX = px; if (px > maxX) maxX = px;
      if (py < minY) minY = py; if (py > maxY) maxY = py;
      if (pz < minZ) minZ = pz; if (pz > maxZ) maxZ = pz;

      const nx = verts[s + 3], ny = verts[s + 4], nz = verts[s + 5];
      let wx = (c00 * nx + c01 * ny + c02 * nz) * sgn;
      let wy = (c10 * nx + c11 * ny + c12 * nz) * sgn;
      let wz = (c20 * nx + c21 * ny + c22 * nz) * sgn;
      const len = Math.hypot(wx, wy, wz);
      const o4 = vi * 4;
      if (len > 1e-12) {
        const k = 127 / len;
        nrm[o4] = Math.round(wx * k); nrm[o4 + 1] = Math.round(wy * k); nrm[o4 + 2] = Math.round(wz * k);
      } else {
        nrm[o4] = 0; nrm[o4 + 1] = 127; nrm[o4 + 2] = 0;
      }
      nrm[o4 + 3] = 0;
      col[o4] = r; col[o4 + 1] = gg; col[o4 + 2] = bb; col[o4 + 3] = aa;
      eid[vi] = cur;
    }
    box[0] = minX; box[1] = minY; box[2] = minZ; box[3] = maxX; box[4] = maxY; box[5] = maxZ;
    this._boxValid = true;

    const out = buf.idx;
    let o = buf.icount;
    if (det < 0) {
      // Reflexión: se invierte el sentido de los triángulos
      for (let t = 0; t < icount; t += 3) {
        out[o++] = base + idx[t];
        out[o++] = base + idx[t + 2];
        out[o++] = base + idx[t + 1];
      }
    } else {
      for (let t = 0; t < icount; t++) out[o++] = base + idx[t];
    }
    buf.vcount += vcount;
    buf.icount += icount;

    if (this.edgesEnabled && withEdges) {
      const segs = this._edgesFor(geometryKey, verts, vcount, idx, icount);
      if (segs && segs.length) {
        const n = segs.length / 3; // vértices
        const eb = this.edgeBuf;
        eb.ensure(n);
        let ep = eb.count * 3;
        for (let s = 0; s < segs.length; s += 3) {
          const x = segs[s], y = segs[s + 1], z = segs[s + 2];
          eb.pos[ep++] = a * x + b * y + c * z + tx;
          eb.pos[ep++] = d * x + e * y + f * z + ty;
          eb.pos[ep++] = g * x + h * y + i2 * z + tz;
        }
        eb.eid.fill(cur, eb.count, eb.count + n);
        eb.count += n;
      }
    }
    return true;
  }

  // Extrae lo acumulado como un fragmento listo para transferir (o null si no hay nada).
  flush() {
    const batches = [];
    const opaque = this.classes[CLASS_OPAQUE].take();
    if (opaque) batches.push({ kind: 'opaque', ...opaque });
    const transparent = this.classes[CLASS_TRANSPARENT].take();
    if (transparent) batches.push({ kind: 'transparent', ...transparent });
    const edges = this.edgeBuf.take();
    if (!batches.length && !edges) return null;
    return { batches, edges };
  }
}
