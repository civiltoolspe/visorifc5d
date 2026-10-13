// IfcManager: carga y administra los modelos IFC, resuelve sus estados (selección, fantasma, aislamiento,
// niveles, hover...) a partir del store, atiende el picking y expone la API descrita en
// docs/ARQUITECTURA.md sección 7.
//
//   const ifc = new IfcManager({ viewer, store, bus, actions });
//   const model = await ifc.load(record, arrayBuffer, (phase, p) => {...});
//
// Todo el procesamiento de web-ifc ocurre en un Web Worker (ifc.worker.js); aquí sólo se construyen
// los objetos three.js a partir de los fragmentos que va entregando el worker.

import * as THREE from 'three';
import { IfcModel } from './IfcModel.js';
import { IfcWorkerClient } from './ifcWorkerClient.js';
import { typeLabel, typeLabelPlural } from './typeLabels.js';

const HOVER_INTERVAL_MS = 50;
const PROPS_CACHE_SIZE = 120;

function toArrayBuffer(x) {
  if (x instanceof ArrayBuffer) return x;
  if (ArrayBuffer.isView(x)) {
    if (x.byteOffset === 0 && x.byteLength === x.buffer.byteLength) return x.buffer;
    return x.buffer.slice(x.byteOffset, x.byteOffset + x.byteLength);
  }
  throw new Error('Se esperaba un ArrayBuffer con el contenido del IFC');
}

function emptyProperties() {
  return { attributes: [], psets: [], quantities: [], type: null, materials: [] };
}

export class IfcManager {
  constructor({ viewer, store, bus, actions }) {
    this.viewer = viewer;
    this.store = store;
    this.bus = bus;
    this.actions = actions;
    this.client = new IfcWorkerClient();
    this._models = new Map();
    this._propCache = new Map();
    this._loading = new Set(); // ids con carga en curso
    this._pendingGeoref = new Map(); // updateGeoref recibido antes de que el modelo exista
    this._raf = 0;
    this._needFull = false;
    this._needHover = false;
    this._clipSig = '';
    this._unsubs = [];
    this._lastMove = null;
    this._hoverTimer = null;
    this._lastHoverAt = 0;
    this._disposed = false;

    viewer.addPickProvider({ id: 'ifc', raycast: (raycaster) => this._raycast(raycaster) });
    this._subscribe();
  }

  // ------------------------------------------------------------------ suscripciones
  _subscribe() {
    const { store, bus } = this;
    const sub = (slice, fn) => this._unsubs.push(store.subscribe(slice, fn));
    sub('models', () => {
      for (const m of this._models.values()) this._applyVisibility(m);
      this.viewer.requestRender();
    });
    sub('selection', () => this._scheduleFull());
    sub('visibility', () => this._scheduleFull());
    sub('storey', () => this._scheduleFull());
    sub('display', (next, prev) => {
      const p = prev || {};
      if (next.ghostOpacity !== p.ghostOpacity || next.edges !== p.edges) {
        for (const m of this._models.values()) this._applyDisplayTo(m);
        this.viewer.requestRender();
      }
      if (next.selectionMode !== p.selectionMode || next.showSpaces !== p.showSpaces) this._scheduleFull();
    });
    sub('hover', () => this._scheduleHover());

    this._unsubs.push(bus.on('viewer:click', (e) => this._onClick(e)));
    this._unsubs.push(bus.on('viewer:dblclick', (e) => this._onDoubleClick(e)));
    this._unsubs.push(bus.on('viewer:pointermove', (e) => this._onPointerMove(e)));
    this._unsubs.push(bus.on('viewer:pointerleave', () => this._clearHover()));
    // Un rebase del origen global cambia la altura de los planos de corte en escena
    this._unsubs.push(bus.on('origin:changed', () => {
      this._clipSig = '';
      this._scheduleFull();
    }));
  }

  _applyVisibility(model) {
    const m = this.store.get('models') || {};
    model.group.visible = !(m[model.id] && m[model.id].visible === false);
  }

  _applyDisplayTo(model) {
    const d = this.store.get('display') || {};
    model.setGhostOpacity(typeof d.ghostOpacity === 'number' ? d.ghostOpacity : 0.12);
    model.setEdgesVisible(d.edges !== false);
  }

  // ------------------------------------------------------------------ resolución de estados
  _scheduleFull() {
    this._needFull = true;
    this._schedule();
  }

  _scheduleHover() {
    this._needHover = true;
    this._schedule();
  }

  _schedule() {
    if (this._raf || this._disposed) return;
    this._raf = requestAnimationFrame(() => {
      this._raf = 0;
      this._flush();
    });
  }

  _flush() {
    if (this._disposed) return;
    if (this._needFull) {
      this._needFull = false;
      this._needHover = false;
      this._resolveAll();
    } else if (this._needHover) {
      this._needHover = false;
      this._applyHover();
    }
  }

  // Fuerza la resolución inmediata (útil en pruebas).
  flushStates() {
    if (this._raf) {
      cancelAnimationFrame(this._raf);
      this._raf = 0;
    }
    this._needFull = true;
    this._flush();
  }

  _activeStorey() {
    const storey = this.store.get('storey') || {};
    if (!storey.active) return null;
    const m = this._models.get(storey.active.modelId);
    if (!m || !m.ready) return null;
    const idx = m.storeyIndexOf(storey.active.expressId);
    if (idx < 0) return null;
    return { model: m, idx, height: m.mapHeightOfStorey(idx) };
  }

  _resolveAll() {
    const { store } = this;
    const selection = (store.get('selection') || { items: [] }).items;
    const vis = store.get('visibility') || { hidden: {}, isolated: null, hiddenTypes: [] };
    const display = store.get('display') || {};
    const storey = store.get('storey') || { active: null, mode: 'cut', cutHeight: 1.2 };
    const hover = store.get('hover');
    const hiddenTypes = new Set((vis.hiddenTypes || []).map((t) => String(t).toUpperCase()));

    const selected = new Map();
    let total = 0;
    for (const it of selection) {
      const m = this._models.get(it.modelId);
      if (!m) continue;
      const list = selected.get(m.id) || [];
      for (const i of m.expandToIndices(it.expressId)) list.push(i);
      total += list.length;
      selected.set(m.id, list);
    }

    const active = this._activeStorey();
    this._updateClipping(active, storey);

    const resolveModels = (hasSelection) => {
      let selectedVisible = 0;
      for (const m of this._models.values()) {
        const ctx = {
          hiddenTypes,
          expand: (id) => m.expandToIndices(id),
          hiddenIds: (vis.hidden && vis.hidden[m.id]) || null,
          isolatedIds: vis.isolated ? vis.isolated[m.id] || [] : null,
          showSpaces: !!display.showSpaces,
          selectionMode: display.selectionMode || 'ghost',
          selected: selected.get(m.id) || [],
          hasSelection,
          hover: hover && hover.modelId === m.id ? m.table.indexOf(hover.expressId) : -1,
          storey: active
            ? {
                mode: storey.mode === 'only' ? 'only' : 'cut',
                height: active.height,
                sameModelIdx: active.model === m ? active.idx : -1,
                heights: m.storeyHeights(),
              }
            : null,
        };
        const stats = m.resolve(ctx);
        selectedVisible += stats?.selected || 0;
      }
      return selectedVisible;
    };
    // Si la selección existe pero está toda oculta (por tipo, nivel, aislamiento...), no se transparenta
    // el resto: no habría nada resaltado y el modelo entero se vería fantasma sin motivo.
    if (resolveModels(total > 0) === 0 && total > 0) resolveModels(false);
    for (const m of this._models.values()) this.bus.emit('ifc:states-changed', { modelId: m.id });
    this.viewer.requestRender();
  }

  _applyHover() {
    const hover = this.store.get('hover');
    for (const m of this._models.values()) {
      const idx = hover && hover.modelId === m.id ? m.table.indexOf(hover.expressId) : -1;
      if (m.setHover(idx)) this.bus.emit('ifc:states-changed', { modelId: m.id });
    }
    this.viewer.requestRender();
  }

  // Corte de planta: plano horizontal a (elevación del nivel + cutHeight)
  _updateClipping(active, storey) {
    let sig = 'none';
    let planes = [];
    if (active && storey.mode !== 'only') {
      const oh = this.viewer.worldOrigin.origin ? this.viewer.worldOrigin.origin.h : 0;
      const y = active.height + Number(storey.cutHeight || 0) - oh;
      sig = `cut:${y.toFixed(6)}`;
      planes = [new THREE.Plane(new THREE.Vector3(0, -1, 0), y)];
    }
    if (sig === this._clipSig) return;
    this._clipSig = sig;
    this.viewer.setClipping('storey', planes);
  }

  // ------------------------------------------------------------------ interacción
  _pickIfc(ndc) {
    const hit = this.viewer.pick(ndc, { kinds: ['ifc'] });
    return hit && hit.kind === 'ifc' ? hit : null;
  }

  _onClick(e) {
    if (this.store.get('measure').active) return;
    if (e.button !== undefined && e.button !== 0) return;
    const hit = this._pickIfc(e.ndc);
    const modifier = !!(e.ctrlKey || e.metaKey || e.shiftKey);
    if (hit) {
      this.actions.select([{ modelId: hit.modelId, expressId: hit.expressId }], { toggle: modifier });
    } else if (!modifier) {
      this.actions.clearSelection();
    }
  }

  _onDoubleClick(e) {
    if (this.store.get('measure').active) return;
    const hit = this._pickIfc(e.ndc);
    if (!hit) return;
    const model = this._models.get(hit.modelId);
    const box = model ? model.getBoxOfExpressId(hit.expressId) : null;
    if (box) this.viewer.fitToBox(box, { smooth: true });
  }

  _onPointerMove(e) {
    this._lastMove = e;
    if (this._hoverTimer) return;
    const wait = Math.max(0, HOVER_INTERVAL_MS - (performance.now() - this._lastHoverAt));
    this._hoverTimer = setTimeout(() => {
      this._hoverTimer = null;
      this._lastHoverAt = performance.now();
      this._updateHover(this._lastMove);
    }, wait);
  }

  _updateHover(e) {
    if (!e || this._disposed) return;
    if (this.store.get('measure').active) {
      this._clearHover();
      return;
    }
    // Durante una órbita/desplazamiento no se calcula el hover
    const action = this.viewer.controls && this.viewer.controls.currentAction;
    if (action) return;
    if (!this._models.size) return;
    const hit = this._pickIfc(e.ndc);
    const next = hit ? { modelId: hit.modelId, expressId: hit.expressId } : null;
    const cur = this.store.get('hover');
    if ((cur && next && cur.modelId === next.modelId && cur.expressId === next.expressId) || (!cur && !next)) return;
    this.store.set('hover', next, { source: 'local' });
  }

  _clearHover() {
    if (this.store.get('hover')) this.store.set('hover', null, { source: 'local' });
  }

  _raycast(raycaster) {
    const hits = [];
    const planes = typeof this.viewer.getClippingPlanes === 'function' ? this.viewer.getClippingPlanes() : [];
    for (const m of this._models.values()) m.raycast(raycaster, hits, planes);
    hits.sort((a, b) => a.distance - b.distance);
    return hits;
  }

  // ------------------------------------------------------------------ carga y descarga
  // Carga un IFC. El ArrayBuffer se transfiere al worker (no debe reutilizarse después).
  // onProgress(phase, p): phase 'parse' | 'geometry', p de 0 a 1.
  async load(record, arrayBuffer, onProgress) {
    const id = record.id;
    if (this._models.has(id)) this.unload(id);
    const model = new IfcModel({
      id,
      record,
      worldOrigin: this.viewer.worldOrigin,
      requestRender: () => this.viewer.requestRender(),
    });
    this._applyDisplayTo(model);
    this._loading.add(id);
    this._pendingGeoref.delete(id);
    let placed = false;
    const handlers = {
      progress: (m) => {
        if (onProgress) {
          try { onProgress(m.phase, m.p); } catch (err) { console.error(err); }
        }
      },
      frame: (m) => {
        if (model._disposed) return;
        if (this._pendingGeoref.has(id)) {
          model.georefOverride = this._pendingGeoref.get(id);
          this._pendingGeoref.delete(id);
        }
        model.applyFrame(m.frame);
        this.viewer.add(model.group);
        this._models.set(id, model);
        placed = true;
        this._applyVisibility(model);
        this._scheduleFull();
      },
      chunk: (m) => {
        if (model._disposed) return;
        model.addChunk(m.chunk);
        // Los estados de los elementos nuevos se resuelven al instante para que no se vean un frame "normales"
        // (p. ej. los espacios, que están ocultos por defecto, o los fantasmas con una selección activa).
        this.flushStates();
      },
      warn: (m) => console.warn('[ifc]', m.message),
    };
    try {
      const result = await this.client.load(id, toArrayBuffer(arrayBuffer), handlers, {});
      if (model._disposed) throw new Error('Carga cancelada: el modelo se descargó mientras se procesaba');
      model.finalize(result);
    } catch (err) {
      this._loading.delete(id);
      if (placed && this._models.get(id) === model) {
        this._models.delete(id);
        this.viewer.remove(model.group);
      }
      model.dispose();
      if (!this._models.has(id)) this.client.close(id);
      this._scheduleFull();
      this.viewer.requestRender();
      throw err;
    }
    this._loading.delete(id);
    if (onProgress) onProgress('geometry', 1);
    this._scheduleFull();
    this.bus.emit('ifc:model-ready', { modelId: id });
    this.viewer.requestRender();
    return model;
  }

  unload(modelId) {
    const m = this._models.get(modelId);
    if (!m) return;
    this._models.delete(modelId);
    this.viewer.remove(m.group);
    m.dispose();
    this.client.close(modelId);
    for (const key of [...this._propCache.keys()]) if (key.startsWith(`${modelId}:`)) this._propCache.delete(key);
    const hover = this.store.get('hover');
    if (hover && hover.modelId === modelId) this.store.set('hover', null, { source: 'system' });
    this._scheduleFull();
    this.viewer.requestRender();
  }

  has(modelId) {
    return this._models.has(modelId);
  }

  getModel(modelId) {
    return this._models.get(modelId) || null;
  }

  // Modelos IFC cargados por completo, en orden de carga.
  getModels() {
    return [...this._models.values()].filter((m) => m.ready);
  }

  _firstModel() {
    for (const m of this._models.values()) if (m.ready) return m;
    return null;
  }

  // ------------------------------------------------------------------ consultas
  getProjectInfo() {
    const m = this._firstModel();
    if (!m) return null;
    const p = m.project;
    return { name: p.name || '', longName: p.longName || '', buildings: [...(p.buildings || [])], schema: p.schema || m.schema };
  }

  getSpatialTree(modelId) {
    const m = this._models.get(modelId);
    if (m && m.tree) return m.tree;
    return { expressId: -2, type: 'IFCPROJECT', typeLabel: typeLabel('IFCPROJECT'), name: m ? m.project.name || m.name : '', children: [], isSpatial: true, hasGeometry: false };
  }

  // Ids de los elementos dibujados que cuelgan de un nodo del árbol (para ocultar/aislar/seleccionar niveles).
  getDescendants(modelId, expressId) {
    const m = this._models.get(modelId);
    return m ? m.getDescendantElementIds(expressId) : [];
  }

  getStoreys() {
    const all = [];
    for (const m of this._models.values()) if (m.ready) all.push(...m.getStoreys());
    return all.sort((a, b) => a.mapHeight - b.mapHeight);
  }

  // Resumen de un modelo para la UI: { modelId, name, schema, elementCount, storeyCount, categoryCount, types, triangles, vertices, loadMs, ready }
  // `types` = [{ type, label, count }] solo de este modelo (el global está en getTypeSummary()).
  getModelSummary(modelId) {
    const m = this._models.get(modelId);
    if (!m) return null;
    const st = m.stats || {};
    const types = m.table.typeSummary();
    return {
      modelId,
      name: m.name,
      schema: m.project.schema || m.schema,
      elementCount: m.table.count,
      storeyCount: m.storeys.length,
      categoryCount: types.length,
      types,
      triangles: st.triangles || 0,
      vertices: st.vertices || 0,
      loadMs: st.ms || 0,
      ready: m.ready,
    };
  }

  getTypeSummary() {
    const counts = new Map();
    for (const m of this._models.values()) {
      for (const { type, count } of m.table.typeSummary()) counts.set(type, (counts.get(type) || 0) + count);
    }
    return [...counts]
      .map(([type, count]) => ({ type, label: typeLabelPlural(type), count }))
      .sort((a, b) => b.count - a.count);
  }

  getElementInfo(modelId, expressId) {
    const m = this._models.get(modelId);
    return m ? m.getElementInfo(expressId) : null;
  }

  // Estado resuelto de un elemento (0 normal, 1 fantasma, 2 oculto, 3 seleccionado, 4 hover) o -1.
  getElementState(modelId, expressId) {
    const m = this._models.get(modelId);
    return m ? m.getElementState(expressId) : -1;
  }

  async getProperties(modelId, expressId) {
    const key = `${modelId}:${expressId}`;
    if (this._propCache.has(key)) {
      const v = this._propCache.get(key);
      this._propCache.delete(key);
      this._propCache.set(key, v);
      return v;
    }
    const m = this._models.get(modelId);
    if (!m || !m.ready) return emptyProperties();
    let props;
    try {
      props = await this.client.properties(modelId, expressId);
    } catch (err) {
      console.warn('[ifc] no se pudieron leer las propiedades', err);
      return emptyProperties();
    }
    this._propCache.set(key, props);
    if (this._propCache.size > PROPS_CACHE_SIZE) this._propCache.delete(this._propCache.keys().next().value);
    return props;
  }

  search(query, limit = 50) {
    const out = [];
    for (const m of this._models.values()) {
      if (!m.ready) continue;
      for (const i of m.table.search(query, limit)) {
        const type = m.table.typeOf(i);
        out.push({
          modelId: m.id,
          expressId: m.table.expressIds[i],
          name: m.table.names[i] || typeLabel(type),
          type,
          typeLabel: typeLabel(type),
          globalId: m.table.globalIds[i] || '',
        });
        if (out.length >= limit) return out;
      }
    }
    return out;
  }

  findByGlobalId(globalId) {
    for (const m of this._models.values()) {
      const i = m.table.findByGlobalId(globalId);
      if (i >= 0) return { modelId: m.id, expressId: m.table.expressIds[i] };
    }
    return null;
  }

  // Caja (escena) que engloba los elementos indicados. items: [{ modelId, expressId }]
  getBoxOf(items) {
    const box = new THREE.Box3();
    let any = false;
    for (const it of items || []) {
      const m = this._models.get(it.modelId);
      if (!m) continue;
      const b = m.getBoxOfExpressId(it.expressId);
      if (b) {
        box.union(b);
        any = true;
      }
    }
    return any ? box : null;
  }

  getModelBox(modelId) {
    const m = this._models.get(modelId);
    return m ? m.getBox() : null;
  }

  // Cota de mapa (H) del nivel más bajo del primer IFC cargado.
  getBaseElevation() {
    const m = this._firstModel();
    if (!m) return null;
    if (m.storeys.length) return Math.min(...m.storeyHeights());
    const box = m.getBox();
    if (box) return this.viewer.worldOrigin.sceneToMap(new THREE.Vector3(0, box.min.y, 0)).h;
    return null;
  }

  // ------------------------------------------------------------------ georreferencia y color
  getGeorefInfo(modelId) {
    const m = this._models.get(modelId);
    return m ? m.getGeorefInfo() : null;
  }

  updateGeoref(modelId, georefOverride) {
    const m = this._models.get(modelId);
    if (!m) {
      // el modelo aún no llegó a colocarse: la sobrescritura se aplicará al hacerlo
      if (this._loading.has(modelId)) this._pendingGeoref.set(modelId, georefOverride || null);
      return;
    }
    m.updateGeoref(georefOverride);
    // Si el modelo volvió a coordenadas locales y quedó lejos del origen global (p. ej. al quitar una
    // sobrescritura georreferenciada), se reubica el origen para no perder precisión al dibujar.
    const wo = this.viewer.worldOrigin;
    const p = m.group.position;
    if (!m.georef.georeferenced && (Math.abs(p.x) > 10000 || Math.abs(p.z) > 10000)) {
      const a = m.georef.anchor;
      wo.rebase({ e: Math.round(a.e), n: Math.round(a.n), h: Math.round(a.h) }, false);
    }
    this._clipSig = '';
    this._scheduleFull();
    this.bus.emit('ifc:georef-changed', { modelId });
    this.viewer.requestRender();
  }

  // Sobrescribe el color de elementos (fase 2: 4D/5D). map: Map<expressId, '#rrggbb'> | null
  setElementColors(modelId, map) {
    const m = this._models.get(modelId);
    if (!m) return;
    m.setElementColors(map);
    this._scheduleFull();
  }

  dispose() {
    this._disposed = true;
    if (this._raf) cancelAnimationFrame(this._raf);
    if (this._hoverTimer) clearTimeout(this._hoverTimer);
    for (const off of this._unsubs) off();
    this._unsubs = [];
    for (const id of [...this._models.keys()]) this.unload(id);
    this.client.dispose();
  }
}
