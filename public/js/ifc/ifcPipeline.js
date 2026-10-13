// Tubería de carga de un IFC con web-ifc (módulo puro: se ejecuta en el worker y también en Node).
//
//  1. Abre el modelo (COORDINATE_TO_ORIGIN = true) y lee esquema, unidades y georreferencia.
//  2. Recorre la geometría con StreamAllMeshes, fusiona las instancias en lotes (geometry.js) y las entrega
//     por fragmentos (`hooks.chunk`) para poder mostrar el modelo de forma progresiva.
//  3. Al terminar lee nombres, GlobalId, niveles y árbol espacial.
//
// `api` y `WebIFC` se inyectan para que el mismo código funcione con la build de navegador y la de Node.

import { ChunkBuilder, CLASS_OPAQUE, CLASS_TRANSPARENT } from './geometry.js';
import { offsetFromCoordinationMatrix, readMapConversion, readProjectBasics } from './georef.js';
import { readElementNames, readSpatialStructure } from './spatial.js';
import { readElementProperties, makeUnitContext } from './properties.js';
import { unitSymbol } from './ifcUtils.js';

export const DEFAULT_OPTIONS = {
  circleSegments: 16,
  flushVertices: 250000,
  flushMs: 1500,
  edgeAngleDeg: 30,
  edges: true,
};

// Color y opacidad con que se dibujan los espacios (IfcSpace) cuando se activa "mostrar espacios"
const SPACE_COLOR = [0.45, 0.68, 0.92, 0.28];

class Grow {
  constructor(Type, stride = 1) {
    this.Type = Type;
    this.stride = stride;
    this.buf = new Type(1024 * stride);
    this.length = 0; // elementos (no floats)
  }

  push(...values) {
    if ((this.length + 1) * this.stride > this.buf.length) {
      const next = new this.Type(this.buf.length * 2);
      next.set(this.buf);
      this.buf = next;
    }
    const o = this.length * this.stride;
    for (let i = 0; i < this.stride; i++) this.buf[o + i] = values[i];
    this.length++;
  }

  slice(from, to = this.length) {
    return this.buf.slice(from * this.stride, to * this.stride);
  }
}

function makeSkipSet(WebIFC) {
  return new Set([WebIFC.IFCOPENINGELEMENT, WebIFC.IFCOPENINGSTANDARDCASE, WebIFC.IFCVIRTUALELEMENT].filter((x) => x !== undefined));
}

// Carga completa de un modelo. Devuelve { handle, units, result }.
//   data: Uint8Array con el contenido del IFC
//   hooks: { progress(phase, p), frame(frame), chunk(chunk), now() }
export async function runIfcPipeline({ api, WebIFC, data, hooks = {}, options = {} }) {
  const opt = { ...DEFAULT_OPTIONS, ...options };
  const progress = hooks.progress || (() => {});
  const now = hooks.now || (() => Date.now());
  const tStart = now();

  progress('parse', 0);
  let handle;
  try {
    handle = api.OpenModel(data, { COORDINATE_TO_ORIGIN: true, CIRCLE_SEGMENTS: opt.circleSegments });
  } catch (err) {
    throw new Error(`No se pudo abrir el archivo IFC (${err && err.message ? err.message : err})`);
  }
  if (handle === undefined || handle === null || handle < 0) {
    throw new Error('web-ifc no pudo abrir el archivo IFC (formato inválido o esquema no soportado)');
  }
  try {
    return await processOpenModel({ api, WebIFC, handle, opt, hooks, progress, now, tStart });
  } catch (err) {
    try { api.CloseModel(handle); } catch { /* ya cerrado */ }
    const detail = err && err.message ? err.message : String(err);
    throw new Error(`No se pudo interpretar el archivo IFC (${detail})`);
  }
}

async function processOpenModel({ api, WebIFC, handle, opt, hooks, progress, now, tStart }) {
  const schema = String(api.GetModelSchema(handle) || '');
  const basics = readProjectBasics(api, WebIFC, handle);
  const lengthFactor = basics.units.lengthFactor || 1;
  const mapConversion = readMapConversion(api, WebIFC, handle, { projectId: basics.projectId, lengthFactor });
  const symbolCache = new Map();
  const units = makeUnitContext(basics.units.symbols, (unitId) => {
    if (!symbolCache.has(unitId)) symbolCache.set(unitId, unitSymbol(api, WebIFC, handle, unitId));
    return symbolCache.get(unitId);
  });
  progress('parse', 1);
  const tParsed = now();

  // ------------------------------------------------------------------ geometría
  const builder = new ChunkBuilder({ edgeAngleDeg: opt.edgeAngleDeg, edges: opt.edges });
  const skip = makeSkipSet(WebIFC);
  const expressIds = new Grow(Int32Array);
  const typeIdx = new Grow(Uint16Array);
  const boxes = new Grow(Float32Array, 6);
  const typeDict = [];
  const typeDictIndex = new Map(); // código -> índice
  let sentElements = 0;
  let sentTypes = 0;
  let frame = null;
  let lastFlush = now();
  let lastProgress = 0;
  let triangles = 0;
  let vertices = 0;
  let failed = 0;

  const sendFrame = (matrix) => {
    const offset = offsetFromCoordinationMatrix(matrix);
    frame = {
      schema,
      lengthFactor,
      offset,
      coordinationMatrix: matrix ? Array.from(matrix) : null,
      mapConversion,
      project: { name: basics.name, longName: basics.longName },
    };
    if (hooks.frame) hooks.frame(frame);
  };

  const flush = (force = false) => {
    const pending = builder.pendingVertices;
    if (!force && pending === 0 && sentElements === expressIds.length) return;
    const out = builder.flush();
    const chunk = {
      batches: out ? out.batches : [],
      edges: out ? out.edges : null,
      elements: {
        start: sentElements,
        expressIds: expressIds.slice(sentElements),
        typeIdx: typeIdx.slice(sentElements),
        boxes: boxes.slice(sentElements),
      },
      typeDictStart: sentTypes,
      typeDictAdd: typeDict.slice(sentTypes),
    };
    sentElements = expressIds.length;
    sentTypes = typeDict.length;
    lastFlush = now();
    if (hooks.chunk) hooks.chunk(chunk);
  };

  progress('geometry', 0);
  // Procesa la geometría de un elemento; si falla a mitad se descarta lo añadido y se sigue con el siguiente.
  const addElement = (mesh) => {
    const id = mesh.expressID;
    const code = api.GetLineType(handle, id);
    if (skip.has(code)) return;
    const isSpace = code === WebIFC.IFCSPACE;
    const geoms = mesh.geometries;
    const n = geoms.size();
    const elementIndex = expressIds.length;
    builder.beginElement(elementIndex);
    try {
      for (let g = 0; g < n; g++) {
        const pg = geoms.get(g);
        const geom = api.GetGeometry(handle, pg.geometryExpressID);
        try {
          const vFloats = geom.GetVertexDataSize();
          const iCount = geom.GetIndexDataSize();
          if (vFloats === 0 || iCount === 0) continue;
          const verts = api.GetVertexArray(geom.GetVertexData(), vFloats);
          const idx = api.GetIndexArray(geom.GetIndexData(), iCount);
          const col = pg.color;
          const rgba = isSpace ? SPACE_COLOR : [col.x, col.y, col.z, col.w < 0.05 ? 0.05 : col.w];
          const cls = rgba[3] < 0.999 ? CLASS_TRANSPARENT : CLASS_OPAQUE;
          const vcount = vFloats / 6;
          if (builder.addPlaced(verts, vcount, idx, iCount, pg.flatTransformation, rgba, cls, pg.geometryExpressID, !isSpace)) {
            triangles += iCount / 3;
            vertices += vcount;
          }
        } finally {
          geom.delete();
        }
      }
    } catch (err) {
      failed++;
      builder.abortElement();
      if (hooks.warn) hooks.warn(err);
      return;
    }
    const box = builder.endElement();
    if (box) {
      let ti = typeDictIndex.get(code);
      if (ti === undefined) {
        ti = typeDict.length;
        typeDictIndex.set(code, ti);
        typeDict.push(String(api.GetNameFromTypeCode(code)).toUpperCase());
      }
      expressIds.push(id);
      typeIdx.push(ti);
      boxes.push(box[0], box[1], box[2], box[3], box[4], box[5]);
    }
  };

  const processMesh = (mesh, index, total, scale, offset) => {
    try {
      if (!frame) sendFrame(api.GetCoordinationMatrix(handle));
      addElement(mesh);
      if (mesh.delete) mesh.delete();
      const t = now();
      if (builder.pendingVertices >= opt.flushVertices || (builder.pendingVertices > 0 && t - lastFlush > opt.flushMs)) flush();
      if (t - lastProgress > 120) {
        lastProgress = t;
        progress('geometry', total ? Math.min(0.99, offset + scale * ((index + 1) / total)) : 0);
      }
    } catch (err) {
      failed++;
      if (hooks.warn) hooks.warn(err);
    }
  };
  api.StreamAllMeshes(handle, (mesh, index, total) => processMesh(mesh, index, total, 0.97, 0));
  // StreamAllMeshes omite los IfcSpace: se piden aparte (se dibujan sólo con display.showSpaces)
  if (WebIFC.IFCSPACE !== undefined) {
    api.StreamAllMeshesWithTypes(handle, [WebIFC.IFCSPACE], (mesh, index, total) => processMesh(mesh, index, total, 0.02, 0.97));
  }
  if (!frame) sendFrame(api.GetCoordinationMatrix(handle));
  flush(true);
  const tGeometry = now();

  // ------------------------------------------------------------------ tablas y estructura
  const count = expressIds.length;
  const ids = expressIds.slice(0, count);
  const tIdx = typeIdx.slice(0, count);
  const allBoxes = boxes.slice(0, count);
  const elementTypeNames = new Array(count);
  for (let i = 0; i < count; i++) elementTypeNames[i] = typeDict[tIdx[i]];
  const { names, globalIds } = readElementNames(api, handle, ids);
  const tNames = now();
  const spatial = readSpatialStructure(api, WebIFC, handle, {
    elements: { expressIds: ids, typeNames: elementTypeNames, names, boxes: allBoxes },
    offsetZ: frame.offset.z,
    lengthFactor,
  });

  progress('geometry', 1);
  const result = {
    elementCount: count,
    names,
    globalIds,
    storeys: spatial.storeys,
    storeyIdx: spatial.storeyIdx,
    tree: spatial.tree,
    project: { name: basics.name, longName: basics.longName, buildings: spatial.buildings, schema },
    stats: {
      triangles,
      vertices,
      failedElements: failed,
      ms: now() - tStart,
      parseMs: tParsed - tStart,
      geometryMs: tGeometry - tParsed,
      namesMs: tNames - tGeometry,
      spatialMs: now() - tNames,
    },
  };
  return { handle, units, result };
}

// Propiedades de un elemento (el modelo debe seguir abierto).
export function getElementProperties({ api, WebIFC, handle, units, expressId }) {
  return readElementProperties(api, WebIFC, handle, expressId, units);
}
