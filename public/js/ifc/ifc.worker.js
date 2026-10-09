// Web Worker de IFC: ejecuta web-ifc fuera del hilo principal.
//
// Protocolo (mensajes con id de petición):
//   -> { id, op: 'load', modelId, buffer, options }      (el ArrayBuffer se transfiere)
//   <- { id, type: 'progress', phase: 'parse'|'geometry', p }
//   <- { id, type: 'frame', frame }                        (esquema, unidades, desplazamiento, georreferencia)
//   <- { id, type: 'chunk', chunk }                        (lotes de geometría + elementos; ArrayBuffers transferidos)
//   <- { id, type: 'result', result }                      (tabla de nombres, niveles, árbol espacial)
//   -> { id, op: 'properties', modelId, expressId }  <- { id, type: 'result', result }
//   -> { id, op: 'close', modelId }                  <- { id, type: 'result', result: true }
//   <- { id, type: 'error', message }
//
// En los workers no aplica el import map: se usan rutas absolutas. Se fuerza un solo hilo (Init(undefined, true))
// porque el servidor no envía las cabeceras COOP/COEP necesarias para SharedArrayBuffer.

import * as WebIFC from '/vendor/web-ifc/web-ifc-api.js';
import { runIfcPipeline, getElementProperties } from './ifcPipeline.js';

let apiPromise = null;
const sessions = new Map(); // modelId -> { handle, units }
const cancelled = new Set(); // modelId descargados mientras se cargaban

function getApi() {
  if (!apiPromise) {
    apiPromise = (async () => {
      const api = new WebIFC.IfcAPI();
      api.SetWasmPath('/vendor/web-ifc/', true);
      await api.Init(undefined, true);
      try {
        if (WebIFC.LogLevel && WebIFC.LogLevel.LOG_LEVEL_ERROR !== undefined) api.SetLogLevel(WebIFC.LogLevel.LOG_LEVEL_ERROR);
      } catch {
        // el nivel de log es opcional
      }
      return api;
    })();
  }
  return apiPromise;
}

function transferablesOf(chunk) {
  const list = [];
  for (const b of chunk.batches) {
    list.push(b.positions.buffer, b.normals.buffer, b.colors.buffer, b.elementIndex.buffer, b.indices.buffer);
  }
  if (chunk.edges) list.push(chunk.edges.positions.buffer, chunk.edges.elementIndex.buffer);
  const e = chunk.elements;
  list.push(e.expressIds.buffer, e.typeIdx.buffer, e.boxes.buffer);
  return list;
}

async function handleLoad(msg) {
  const { id, modelId, buffer, options } = msg;
  cancelled.delete(modelId);
  const api = await getApi();
  const post = (type, payload, transfer) => self.postMessage({ id, type, ...payload }, transfer || []);
  const data = new Uint8Array(buffer);
  const out = await runIfcPipeline({
    api,
    WebIFC,
    data,
    options: options || {},
    hooks: {
      progress: (phase, p) => post('progress', { phase, p }),
      frame: (frame) => post('frame', { frame }),
      chunk: (chunk) => post('chunk', { chunk }, transferablesOf(chunk)),
      warn: (err) => post('warn', { message: String(err && err.message ? err.message : err) }),
    },
  });
  const old = sessions.get(modelId);
  if (old) {
    try { api.CloseModel(old.handle); } catch { /* ya cerrado */ }
  }
  if (cancelled.has(modelId)) {
    // el modelo se descargó mientras se procesaba: se libera de inmediato
    cancelled.delete(modelId);
    sessions.delete(modelId);
    try { api.CloseModel(out.handle); } catch { /* ya cerrado */ }
  } else {
    sessions.set(modelId, { handle: out.handle, units: out.units });
  }
  post('result', { result: out.result });
}

async function handleProperties(msg) {
  const api = await getApi();
  const session = sessions.get(msg.modelId);
  if (!session) throw new Error('Modelo no cargado en el worker');
  const result = getElementProperties({ api, WebIFC, handle: session.handle, units: session.units, expressId: msg.expressId });
  self.postMessage({ id: msg.id, type: 'result', result });
}

async function handleClose(msg) {
  const api = await getApi();
  const session = sessions.get(msg.modelId);
  if (session) {
    try { api.CloseModel(session.handle); } catch { /* ya cerrado */ }
    sessions.delete(msg.modelId);
  } else {
    // puede haber una carga en curso de ese modelo: se cerrará al terminar
    cancelled.add(msg.modelId);
  }
  self.postMessage({ id: msg.id, type: 'result', result: true });
}

self.onmessage = async (ev) => {
  const msg = ev.data;
  try {
    if (msg.op === 'load') await handleLoad(msg);
    else if (msg.op === 'properties') await handleProperties(msg);
    else if (msg.op === 'close') await handleClose(msg);
    else if (msg.op === 'ping') self.postMessage({ id: msg.id, type: 'result', result: 'pong' });
    else throw new Error(`Operación desconocida: ${msg.op}`);
  } catch (err) {
    self.postMessage({ id: msg.id, type: 'error', message: err && err.message ? err.message : String(err) });
  }
};
