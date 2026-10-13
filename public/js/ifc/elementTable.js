// Tabla de elementos de un modelo IFC: expressId <-> índice, tipo, nombre, GlobalId, nivel y caja.
// Módulo puro (sin three.js): lo usan IfcModel, el resolvedor de estados y las pruebas en Node.

import { normalizeText } from './ifcUtils.js';
import { typeLabel, typeLabelPlural, categoryType } from './typeLabels.js';

export class ElementTable {
  constructor() {
    this.count = 0;
    this.capacity = 0;
    this.expressIds = new Int32Array(0);
    this.typeIdx = new Uint16Array(0);
    this.storeyIdx = new Int32Array(0); // -1 = sin nivel
    this.boxes = new Float32Array(0); // 6 por elemento: min xyz, max xyz (coordenadas locales del grupo)
    this.names = [];
    this.globalIds = [];
    this.typeNames = []; // índice de tipo -> 'IFCWALL'
    this._index = new Map();
    this._guidIndex = null;
    this._haystack = null;
    this._catCache = new Map();
  }

  _grow(min) {
    if (min <= this.capacity) return;
    const cap = Math.max(min, Math.max(1024, this.capacity * 2));
    const ids = new Int32Array(cap); ids.set(this.expressIds.subarray(0, this.count));
    const ty = new Uint16Array(cap); ty.set(this.typeIdx.subarray(0, this.count));
    const st = new Int32Array(cap).fill(-1); st.set(this.storeyIdx.subarray(0, this.count));
    const bx = new Float32Array(cap * 6); bx.set(this.boxes.subarray(0, this.count * 6));
    this.expressIds = ids; this.typeIdx = ty; this.storeyIdx = st; this.boxes = bx;
    this.capacity = cap;
  }

  // Añade los elementos de un fragmento del worker.
  appendChunk(elements, typeDictStart = 0, typeDictAdd = []) {
    for (let i = 0; i < typeDictAdd.length; i++) this.typeNames[typeDictStart + i] = typeDictAdd[i];
    const n = elements.expressIds.length;
    if (!n) return 0;
    this._grow(this.count + n);
    this.expressIds.set(elements.expressIds, this.count);
    this.typeIdx.set(elements.typeIdx, this.count);
    this.boxes.set(elements.boxes, this.count * 6);
    for (let i = 0; i < n; i++) {
      this._index.set(elements.expressIds[i], this.count + i);
      this.names.push('');
      this.globalIds.push('');
    }
    this.count += n;
    this._haystack = null;
    this._guidIndex = null;
    return n;
  }

  setNames(names, globalIds) {
    const n = Math.min(this.count, names.length);
    for (let i = 0; i < n; i++) {
      this.names[i] = names[i];
      this.globalIds[i] = globalIds[i];
    }
    this._haystack = null;
    this._guidIndex = null;
  }

  setStoreys(storeyIdx) {
    this.storeyIdx.set(storeyIdx.subarray ? storeyIdx.subarray(0, this.count) : storeyIdx.slice(0, this.count), 0);
  }

  indexOf(expressId) {
    const i = this._index.get(expressId);
    return i === undefined ? -1 : i;
  }

  has(expressId) {
    return this._index.has(expressId);
  }

  typeOf(i) {
    return this.typeNames[this.typeIdx[i]] || 'IFCPRODUCT';
  }

  categoryOf(i) {
    return this.categoryOfTypeIdx(this.typeIdx[i]);
  }

  categoryOfTypeIdx(t) {
    let c = this._catCache.get(t);
    if (c === undefined) {
      c = categoryType(this.typeNames[t] || '');
      this._catCache.set(t, c);
    }
    return c;
  }

  // Caja local de un elemento [minx, miny, minz, maxx, maxy, maxz]
  boxOf(i) {
    return this.boxes.subarray(i * 6, i * 6 + 6);
  }

  findByGlobalId(globalId) {
    if (!this._guidIndex) {
      this._guidIndex = new Map();
      for (let i = 0; i < this.count; i++) if (this.globalIds[i]) this._guidIndex.set(this.globalIds[i], i);
    }
    const i = this._guidIndex.get(String(globalId));
    return i === undefined ? -1 : i;
  }

  // Resumen por categoría: [{ type, label, count }] ordenado por cantidad.
  typeSummary() {
    const counts = new Map();
    for (let i = 0; i < this.count; i++) {
      const c = this.categoryOf(i);
      counts.set(c, (counts.get(c) || 0) + 1);
    }
    return [...counts].map(([type, count]) => ({ type, label: typeLabelPlural(type), count })).sort((a, b) => b.count - a.count);
  }

  _buildHaystack() {
    const hs = new Array(this.count);
    for (let i = 0; i < this.count; i++) {
      const t = this.typeOf(i);
      hs[i] = normalizeText(`${this.names[i]} ${t} ${typeLabel(t)} ${typeLabelPlural(t)} ${this.globalIds[i]}`);
    }
    this._haystack = hs;
  }

  // Búsqueda por nombre, tipo, etiqueta de tipo y GlobalId (sin mayúsculas ni acentos). Devuelve índices.
  search(query, limit = 50) {
    const q = normalizeText(query).trim();
    if (!q) return [];
    if (!this._haystack) this._buildHaystack();
    const tokens = q.split(/\s+/).filter(Boolean);
    const exact = [];
    const rest = [];
    for (let i = 0; i < this.count; i++) {
      const h = this._haystack[i];
      let ok = true;
      for (const tk of tokens) {
        if (!h.includes(tk)) { ok = false; break; }
      }
      if (!ok) continue;
      const name = normalizeText(this.names[i]);
      if (name === q || name.startsWith(q) || this.globalIds[i] === query.trim()) exact.push(i);
      else rest.push(i);
      if (exact.length >= limit) break;
    }
    return exact.concat(rest).slice(0, limit);
  }
}
