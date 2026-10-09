// Gestor de planos CAD (DXF/DWG) georreferenciados.
// Contrato: docs/ARQUITECTURA.md, sección 8.
//
//   const cad = new CadManager({ viewer, store, bus });
//   cad.setElevationProvider(() => ifc.getBaseElevation());
//   const model = await cad.load(record, arrayBuffer, onProgress);
//
// El parseo (DXF con dxf-parser, DWG con libredwg-web) y la construcción de búferes se hacen en
// un Web Worker; el hilo principal solo crea los objetos three.js (un LineSegments, una malla de
// rellenos y una malla de texto por capa) y los coloca con viewer.worldOrigin.

import * as THREE from 'three';
import { CadModel } from './CadModel.js';
import { GlyphAtlas, SRGB_TO_LINEAR } from './glyphAtlas.js';

const FILL_OPACITY = 0.35;
const AUTO_ELEVATION_OFFSET = 0.02; // m sobre el nivel más bajo del IFC
const GEO_THRESHOLD = 10000; // m
const WORKER_IDLE_MS = 60000;

export class CadManager {
  constructor({ viewer, store, bus }) {
    this.viewer = viewer;
    this.store = store;
    this.bus = bus;
    this._models = new Map(); // id → CadModel
    this._provider = null;
    this._atlas = null;
    this._worker = null;
    this._workerBroken = false;
    this._workerTimer = null;
    this._jobSeq = 0;
    this._jobs = new Map(); // id → { resolve, reject, onProgress }
    this._queue = Promise.resolve();
    this._loading = new Map(); // modelId → { cancelled } (cargas en curso)

    this._unsubs = [
      store.subscribe('cad', () => this._syncCad()),
      store.subscribe('models', () => this._syncVisibility()),
      bus.on('model:loaded', (e) => {
        if (e?.kind === 'ifc') this.refreshElevation();
      }),
      bus.on('model:unloaded', (e) => {
        // El evento de descarga puede no traer el tipo: se recalcula siempre (es barato)
        if (!e || e.kind === undefined || e.kind === 'ifc') this.refreshElevation();
      }),
    ];
  }

  // ---------------------------------------------------------------------------
  // API pública
  // ---------------------------------------------------------------------------

  setElevationProvider(fn) {
    this._provider = typeof fn === 'function' ? fn : null;
    this.refreshElevation();
  }

  has(modelId) {
    return this._models.has(modelId);
  }

  getModels() {
    return [...this._models.values()];
  }

  getModel(modelId) {
    return this._models.get(modelId) || null;
  }

  getLayers(modelId) {
    const m = this._models.get(modelId);
    return m ? m.layers.map((l) => ({ name: l.name, color: l.color, count: l.count })) : [];
  }

  // Caja de la geometría en coordenadas de escena (Box3) o null
  getBox(modelId) {
    const m = this._models.get(modelId);
    if (!m) return null;
    const { min, max } = m.extents;
    const wo = this.viewer.worldOrigin;
    const a = wo.mapToScene(min.e, min.n, min.h);
    const b = wo.mapToScene(max.e, max.n, max.h);
    return new THREE.Box3().setFromPoints([a, b]);
  }

  // Recalcula la cota automática de todos los planos (se llama al cargar/descargar IFC)
  refreshElevation() {
    for (const m of this._models.values()) this._applyElevation(m);
  }

  async load(record, arrayBuffer, onProgress) {
    if (this._models.has(record.id)) this.unload(record.id);
    const units = record.cad?.units || 'auto';
    const token = { cancelled: false };
    this._loading.set(record.id, token);
    onProgress?.('parse', 0);
    let result;
    try {
      result = await this._process(arrayBuffer, record.kind, units, (phase, p) => {
        const overall = phase === 'parse' ? p * 0.5 : phase === 'build' ? 0.5 + p * 0.4 : p;
        onProgress?.('parse', Math.min(0.9, overall));
      });
    } finally {
      if (this._loading.get(record.id) === token) this._loading.delete(record.id);
    }
    if (token.cancelled) {
      const err = new Error('Carga cancelada');
      err.cancelled = true;
      throw err;
    }
    if (result.stats?.truncated) {
      this.bus.emit('toast', {
        type: 'warning',
        message: `${record.name}: el plano es muy grande y solo se muestra una parte de su geometría.`,
      });
    }
    const model = this._buildModel(record, result);
    // La cota efectiva se calcula antes de registrar: el origen global usa el ancla con su cota
    model.elevation = this._effectiveElevation(model);
    this._models.set(model.id, model);

    const wo = this.viewer.worldOrigin;
    this.viewer.add(model.group);
    wo.register(model.group, model.anchor, { georeferenced: model.georeferenced });

    // Estado inicial del almacén: las capas apagadas/congeladas del archivo se ocultan
    // (origen 'system') salvo que ya exista una entrada (p. ej. enviada por el presentador).
    const cad = this.store.get('cad');
    if (!cad[model.id]) {
      const hiddenLayers = model.layers.filter((l) => l.hiddenInFile).map((l) => l.name);
      this.store.set('cad', { ...cad, [model.id]: { hiddenLayers, elevation: null } }, { source: 'system' });
    }
    this._applyHiddenLayers(model);
    this._applyElevation(model);
    this._applyModelVisibility(model);
    this._touchViewer();
    onProgress?.('parse', 1);
    return model;
  }

  unload(modelId) {
    const pending = this._loading.get(modelId);
    if (pending) pending.cancelled = true;
    const m = this._models.get(modelId);
    if (!m) return;
    this._models.delete(modelId);
    this.viewer.worldOrigin.unregister(m.group);
    this.viewer.remove(m.group);
    m.dispose();
    if (!this._models.size && this._atlas) {
      this._atlas.dispose();
      this._atlas = null;
    }
    this._touchViewer();
  }

  dispose() {
    for (const off of this._unsubs) off?.();
    this._unsubs = [];
    for (const id of [...this._models.keys()]) this.unload(id);
    this._terminateWorker();
  }

  // ---------------------------------------------------------------------------
  // Estado del almacén → escena
  // ---------------------------------------------------------------------------

  // Avisa al visor de que cambió lo que se ve (límites de escena y nuevo fotograma)
  _touchViewer() {
    this.viewer.invalidateBounds?.();
    this.viewer.requestRender?.();
  }

  _syncCad() {
    for (const m of this._models.values()) {
      this._applyHiddenLayers(m);
      this._applyElevation(m);
    }
  }

  _syncVisibility() {
    for (const m of this._models.values()) this._applyModelVisibility(m);
  }

  _applyModelVisibility(m) {
    const entry = this.store.get('models')?.[m.id];
    const visible = entry ? entry.visible !== false : true;
    if (m.group.visible !== visible) {
      m.group.visible = visible;
      this._touchViewer();
    }
  }

  _applyHiddenLayers(m) {
    const entry = this.store.get('cad')?.[m.id];
    const hidden = new Set(entry?.hiddenLayers || []);
    if (m.setHiddenLayers(hidden)) this._touchViewer();
  }

  // Cota efectiva: manual si existe; si no, plano → cota del IFC + 2 cm (o 0); con Z propia → 0.
  _effectiveElevation(m) {
    const entry = this.store.get('cad')?.[m.id];
    const manual = entry?.elevation;
    if (typeof manual === 'number' && Number.isFinite(manual)) return manual;
    if (m.hasZ) return 0;
    let base = null;
    try {
      base = this._provider ? this._provider() : null;
    } catch {
      base = null;
    }
    return typeof base === 'number' && Number.isFinite(base) ? base + AUTO_ELEVATION_OFFSET : 0;
  }

  _applyElevation(m, force = false) {
    const next = this._effectiveElevation(m);
    if (!force && Math.abs(next - m.elevation) < 1e-9) return;
    m.elevation = next;
    this.viewer.worldOrigin.update(m.group, m.anchor, { georeferenced: m.georeferenced });
    this._touchViewer();
    this.bus.emit('cad:elevation', { modelId: m.id, elevation: next });
  }

  // ---------------------------------------------------------------------------
  // Construcción de objetos three.js
  // ---------------------------------------------------------------------------

  _getAtlas() {
    if (!this._atlas) {
      const aniso = this.viewer.renderer?.capabilities?.getMaxAnisotropy?.() ?? 4;
      this._atlas = new GlyphAtlas({ anisotropy: Math.min(8, aniso) });
    }
    return this._atlas;
  }

  _buildModel(record, r) {
    const group = new THREE.Group();
    group.name = `cad:${record.id}`;
    group.userData.cadModelId = record.id;
    group.userData.kind = 'cad';

    const lineMat = new THREE.LineBasicMaterial({ vertexColors: true, toneMapped: false });
    const fillMat = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: FILL_OPACITY,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    });
    let textMat = null;

    const layerObjects = new Map();
    const track = (name, obj, kind) => {
      obj.name = `${name} (${kind})`;
      obj.userData.cadModelId = record.id;
      obj.userData.cadLayer = name;
      obj.userData.cadKind = kind;
      if (!layerObjects.has(name)) layerObjects.set(name, []);
      layerObjects.get(name).push(obj);
      group.add(obj);
    };

    for (const part of r.parts) {
      if (part.lines) {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(part.lines.pos, 3));
        geo.setAttribute('color', new THREE.BufferAttribute(toLinear(part.lines.col), 3));
        const obj = new THREE.LineSegments(geo, lineMat);
        track(part.layer, obj, 'lines');
      }
      if (part.fills) {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(part.fills.pos, 3));
        geo.setAttribute('color', new THREE.BufferAttribute(toLinear(part.fills.col), 3));
        const obj = new THREE.Mesh(geo, fillMat);
        obj.renderOrder = -1;
        track(part.layer, obj, 'fill');
      }
      if (part.texts) {
        const atlas = this._getAtlas();
        const laid = atlas.layout(part.texts.data, part.texts.strings);
        if (laid) {
          if (!textMat) {
            textMat = new THREE.MeshBasicMaterial({
              map: atlas.texture,
              vertexColors: true,
              transparent: true,
              alphaTest: 0.02,
              depthWrite: false,
              side: THREE.DoubleSide,
              toneMapped: false,
            });
          }
          const geo = new THREE.BufferGeometry();
          geo.setAttribute('position', new THREE.BufferAttribute(laid.position, 3));
          geo.setAttribute('uv', new THREE.BufferAttribute(laid.uv, 2));
          geo.setAttribute('color', new THREE.BufferAttribute(laid.color, 3));
          geo.setIndex(new THREE.BufferAttribute(laid.index, 1));
          const obj = new THREE.Mesh(geo, textMat);
          obj.renderOrder = 1;
          track(part.layer, obj, 'text');
        }
      }
    }
    const hiddenSet = new Set(r.layers.filter((l) => l.hidden).map((l) => l.name));
    const layers = r.layers.map((l) => ({
      name: l.name, color: l.color, count: l.count, hiddenInFile: hiddenSet.has(l.name),
    }));
    const georeferenced = Math.abs(r.anchor.e) > GEO_THRESHOLD || Math.abs(r.anchor.n) > GEO_THRESHOLD;

    return new CadModel({
      id: record.id,
      name: record.name,
      kind: r.kind,
      group,
      units: r.units,
      unitScale: r.unitScale,
      insunits: r.insunits,
      unitsSource: r.unitsSource,
      georeferenced,
      drawingAnchor: r.anchor,
      drawingExtents: r.extents,
      hasZ: r.hasZ,
      elevation: 0,
      layers,
      layerObjects,
      stats: r.stats,
      version: r.version,
    });
  }

  // ---------------------------------------------------------------------------
  // Web Worker
  // ---------------------------------------------------------------------------

  _process(buffer, kind, units, onProgress) {
    const run = () => this._runJob(buffer, kind, units, onProgress);
    // Un solo trabajo a la vez (libredwg-web mantiene estado global en WASM)
    const p = this._queue.then(run, run);
    this._queue = p.catch(() => {});
    return p;
  }

  async _runJob(buffer, kind, units, onProgress) {
    if (!this._workerBroken && typeof Worker !== 'undefined') {
      try {
        return await this._runInWorker(buffer, kind, units, onProgress);
      } catch (err) {
        if (!err?.workerStartFailure) throw err;
        console.warn('[cad] el Web Worker no pudo iniciarse; se procesa en el hilo principal', err);
        this._workerBroken = true;
      }
    }
    const [{ processCad }, { browserLoaders }] = await Promise.all([
      import('./processCad.js'),
      import('./loaders.browser.js'),
    ]);
    return processCad(buffer.slice(0), { kind, units, loaders: browserLoaders, onProgress });
  }

  _ensureWorker() {
    if (this._worker) return this._worker;
    const worker = new Worker(new URL('./cad.worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (ev) => {
      const msg = ev.data;
      const job = this._jobs.get(msg?.id);
      if (!job) return;
      if (msg.type === 'progress') {
        job.onProgress?.(msg.phase, msg.p);
      } else if (msg.type === 'done') {
        this._jobs.delete(msg.id);
        job.resolve(msg.result);
        this._armIdleTimer();
      } else if (msg.type === 'error') {
        this._jobs.delete(msg.id);
        job.reject(new Error(msg.message));
        this._armIdleTimer();
      }
    };
    worker.onerror = (ev) => {
      // Fallo al cargar/ejecutar el script del worker
      const err = new Error(ev?.message || 'Error en el worker de CAD');
      err.workerStartFailure = true;
      for (const [id, job] of this._jobs) {
        this._jobs.delete(id);
        job.reject(err);
      }
      this._terminateWorker();
    };
    this._worker = worker;
    return worker;
  }

  _runInWorker(buffer, kind, units, onProgress) {
    return new Promise((resolve, reject) => {
      let worker;
      try {
        worker = this._ensureWorker();
      } catch (err) {
        err.workerStartFailure = true;
        reject(err);
        return;
      }
      clearTimeout(this._workerTimer);
      const id = ++this._jobSeq;
      this._jobs.set(id, { resolve, reject, onProgress });
      // Se envía una copia: el ArrayBuffer del llamador sigue siendo utilizable
      const copy = buffer.slice(0);
      worker.postMessage({ id, buffer: copy, kind, units }, [copy]);
    });
  }

  _armIdleTimer() {
    clearTimeout(this._workerTimer);
    if (this._jobs.size) return;
    this._workerTimer = setTimeout(() => {
      if (!this._jobs.size) this._terminateWorker();
    }, WORKER_IDLE_MS);
  }

  _terminateWorker() {
    clearTimeout(this._workerTimer);
    if (this._worker) {
      this._worker.terminate();
      this._worker = null;
    }
  }
}

// Colores sRGB (bytes) → lineales Float32 (espacio de trabajo de three.js)
function toLinear(bytes) {
  const out = new Float32Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = SRGB_TO_LINEAR[bytes[i]];
  return out;
}
