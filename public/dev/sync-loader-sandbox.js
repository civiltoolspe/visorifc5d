// Sandbox del ModelLoader: store y bus reales con dobles de ApiClient, IfcManager, CadManager y Viewer.
// window.__t.make(opts) crea un conjunto independiente { api, ifc, cad, viewer, store, bus, loader, events, tracker }.
// opts: { role, presentation: { active, isActivePresenter }, apiMs, parseMs }

import { EventBus } from '/js/core/events.js';
import { createStore } from '/js/core/store.js';
import { ModelLoader } from '/js/core/ModelLoader.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Mide cuántas operaciones (descarga o procesamiento) se solapan: la cola debe ser secuencial
class Tracker {
  constructor() {
    this.busy = 0;
    this.maxBusy = 0;
    this.order = [];
  }
  enter(label) {
    this.busy += 1;
    this.maxBusy = Math.max(this.maxBusy, this.busy);
    this.order.push(`+${label}`);
  }
  leave(label) {
    this.busy -= 1;
    this.order.push(`-${label}`);
  }
}

class ApiDouble {
  constructor(tracker, { apiMs = 60 } = {}) {
    this.tracker = tracker;
    this.apiMs = apiMs;
    this.records = [];
    this.downloads = [];
    this.uploads = [];
    this.listCalls = 0;
    this.failDownload = new Set();
    this.failUpload = new Set();
    this.listDelay = 0;
    this._seq = 0;
  }

  async listModels() {
    this.listCalls += 1;
    if (this.listDelay) await sleep(this.listDelay);
    return JSON.parse(JSON.stringify(this.records));
  }

  async downloadModel(id, onProgress, opts = {}) {
    this.downloads.push(id);
    const rec = this.records.find((r) => r.id === id);
    const total = rec?.size || 100;
    this.tracker.enter(`dl:${id}`);
    try {
      if (this.failDownload.has(id)) {
        await sleep(10);
        throw new Error('No se encontró el recurso solicitado');
      }
      const steps = 4;
      for (let i = 1; i <= steps; i++) {
        await sleep(this.apiMs / steps);
        if (opts.signal?.aborted) throw new Error('Descarga cancelada.');
        onProgress?.((total * i) / steps, total);
      }
      return new ArrayBuffer(Math.min(total, 1024));
    } finally {
      this.tracker.leave(`dl:${id}`);
    }
  }

  async uploadModel(file, onProgress) {
    this.uploads.push(file.name);
    this.activeUploads = (this.activeUploads || 0) + 1;
    this.maxUploads = Math.max(this.maxUploads || 0, this.activeUploads);
    try {
      if (this.failUpload.has(file.name)) throw new Error('Solo el presentador puede realizar esta acción.');
      for (let i = 1; i <= 4; i++) {
        await sleep(15);
        onProgress?.(file.size * (i / 4), file.size);
      }
    } finally {
      this.activeUploads -= 1;
    }
    const kind = file.name.split('.').pop().toLowerCase();
    return {
      id: `up${++this._seq}`, name: file.name, kind, size: file.size, uploadedAt: new Date().toISOString(), georef: null,
      cad: kind === 'ifc' ? null : { units: 'auto' },
    };
  }
}

class ManagerDouble {
  constructor(kind, tracker, { parseMs = 50 } = {}) {
    this.kind = kind;
    this.tracker = tracker;
    this.parseMs = parseMs;
    this.models = new Map();
    this.calls = [];
    this.failParse = new Set();
    this._loading = new Map();
  }

  async load(record, buffer, onProgress) {
    this.calls.push({ op: 'load', id: record.id, georef: record.georef ?? null, units: record.cad?.units ?? null });
    const token = { cancelled: false };
    this._loading.set(record.id, token);
    this.tracker.enter(`parse:${record.id}`);
    try {
      onProgress?.('parse', 0);
      await sleep(this.parseMs / 2);
      onProgress?.('parse', 0.5);
      await sleep(this.parseMs / 2);
      if (this.failParse.has(record.id)) throw new Error('Archivo dañado');
      if (token.cancelled) {
        const err = new Error('Carga cancelada');
        err.cancelled = true;
        throw err;
      }
      onProgress?.(this.kind === 'ifc' ? 'geometry' : 'parse', 1);
      const model = { id: record.id, kind: record.kind, units: record.cad?.units ?? null };
      this.models.set(record.id, model);
      return model;
    } finally {
      this._loading.delete(record.id);
      this.tracker.leave(`parse:${record.id}`);
    }
  }

  unload(id) {
    this.calls.push({ op: 'unload', id });
    const t = this._loading.get(id);
    if (t) t.cancelled = true;
    this.models.delete(id);
  }

  has(id) {
    return this.models.has(id);
  }
}

class IfcDouble extends ManagerDouble {
  constructor(tracker, opts) {
    super('ifc', tracker, opts);
  }

  updateGeoref(id, georef) {
    this.calls.push({ op: 'updateGeoref', id, georef });
  }
}

function make({ role = 'presenter', presentation = {}, apiMs = 60, parseMs = 50 } = {}) {
  const bus = new EventBus();
  const store = createStore();
  store.patch('presentation', { role, ...presentation }, { source: 'system' });
  const tracker = new Tracker();
  const api = new ApiDouble(tracker, { apiMs });
  const ifc = new IfcDouble(tracker, { parseMs });
  const cad = new ManagerDouble('cad', tracker, { parseMs });
  const viewer = { fitCalls: 0, fitAll() { this.fitCalls += 1; } };
  const events = [];
  for (const evt of ['model:loaded', 'model:unloaded', 'model:error', 'toast']) {
    bus.on(evt, (payload) => events.push({ evt, payload: evt === 'model:loaded' ? { ...payload, model: undefined } : payload }));
  }
  // Historial de fases del store.loading por modelo
  const phases = {};
  store.subscribe('loading', (next) => {
    for (const [id, v] of Object.entries(next)) {
      const list = (phases[id] ||= []);
      if (list[list.length - 1] !== v.phase) list.push(v.phase);
    }
  });
  const loader = new ModelLoader({ api, store, bus, ifc, cad, viewer });
  return { bus, store, tracker, api, ifc, cad, viewer, events, phases, loader };
}

const rec = (id, kind, extra = {}) => ({
  id, name: `${id}.${kind}`, kind, size: 400, uploadedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, Number(id.replace(/\D/g, '')) || 0)).toISOString(),
  georef: null, cad: kind === 'ifc' ? null : { units: 'auto' }, ...extra,
});

async function waitUntil(fn, ms = 6000, label = 'condición') {
  const t0 = performance.now();
  while (performance.now() - t0 < ms) {
    if (await fn()) return true;
    await sleep(10);
  }
  throw new Error(`Tiempo agotado esperando ${label}`);
}

function expect(cond, msg) {
  if (!cond) throw new Error(`Aserción fallida: ${msg}`);
}

window.__t = { make, rec, sleep, waitUntil, expect };
window.__ready = true;
