// Herramienta de medición de distancias entre dos puntos del modelo.
//
//  - Con store.measure.active, los clics del visor toman puntos con viewer.pick (cualquier tipo
//    de geometría); dos puntos → actions.addMeasure(a, b) (arrays en coordenadas de escena).
//  - Se dibujan TODAS las mediciones de store.measure.items (también las remotas): línea,
//    marcadores de tamaño constante y una etiqueta HTML (CSS2DRenderer) con la distancia y Δz.
//  - Mientras se mide: marcador del primer punto, línea elástica hasta el cursor e "imán" al
//    vértice más cercano cuando el impacto lo permite.
//  - Esc cancela el punto en curso.

import * as THREE from 'three';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import {
  createFatLines,
  setFatLinePositions,
  createDotTexture,
  createRingTexture,
  createMarkerPoints,
  disposeObject,
} from './overlayUtils.js';

const LINE_COLOR = 0x1f1f1f;
const PREVIEW_COLOR = 0xff6a13;
const SNAP_PX = 14; // radio de atracción a un vértice, en píxeles
const MIN_DZ = 1e-3; // m: por debajo no se muestra Δz

const STYLE_ID = 'measure-tool-style';
const CSS = `
.measure-layer { position: absolute; inset: 0; pointer-events: none; overflow: hidden; z-index: 2;
  font-family: 'Urbanist', system-ui, -apple-system, 'Segoe UI', sans-serif; }
.measure-label { pointer-events: none; }
.measure-label__card { position: relative; display: flex; flex-direction: column; align-items: center; gap: 1px;
  padding: 5px 12px 6px; border-radius: 12px; background: rgba(255,255,255,0.96); color: #1f1f1f;
  box-shadow: 0 6px 18px rgba(0,0,0,0.14), 0 1px 3px rgba(0,0,0,0.10); white-space: nowrap;
  transform: translateY(calc(-50% - 20px)); font-variant-numeric: tabular-nums; }
.measure-label--preview .measure-label__card { background: rgba(31,31,31,0.92); color: #fff; }
.measure-label__dist { font-size: 13px; font-weight: 600; letter-spacing: 0.01em; line-height: 1.2; }
.measure-label__dz { font-size: 11px; font-weight: 400; line-height: 1.2; color: #8a8a87; }
.measure-label--preview .measure-label__dz { color: #c9c9c6; }
.measure-label__del { position: absolute; top: -7px; right: -7px; width: 18px; height: 18px; padding: 0;
  display: flex; align-items: center; justify-content: center; border: 0; border-radius: 50%;
  background: #1f1f1f; color: #fff; font-family: inherit; font-size: 13px; font-weight: 600; line-height: 1;
  cursor: pointer; pointer-events: auto;
  box-shadow: 0 2px 6px rgba(0,0,0,0.25); transition: background 0.12s ease, transform 0.12s ease; }
.measure-label__del:hover { background: #ff6a13; transform: scale(1.12); }
.measure-label__del:focus-visible { outline: 2px solid #ff6a13; outline-offset: 2px; }
.measure-layer[data-locked="true"] .measure-label__del { display: none; }
`;

function injectStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}

const toArray = (v) => [v.x, v.y, v.z];
const sameVec = (a, b) => a && b && a[0] === b[0] && a[1] === b[1] && a[2] === b[2];

export class MeasureTool {
  // Formatea una distancia en metros: "12.345 m" (locale es-PE, 3 decimales).
  static formatDistance(value, locale = 'es-PE') {
    const f = new Intl.NumberFormat(locale, { minimumFractionDigits: 3, maximumFractionDigits: 3 });
    return `${f.format(value)} m`;
  }

  constructor({ viewer, store, bus, actions }) {
    this.viewer = viewer;
    this.store = store;
    this.bus = bus;
    this.actions = actions;
    this.locale = 'es-PE';

    injectStyle();

    this.group = new THREE.Group();
    this.group.name = 'measure';
    viewer.overlayRoot.add(this.group);

    // Capa HTML de etiquetas (sin eventos salvo el botón ×)
    this.labelRenderer = new CSS2DRenderer();
    this.layer = this.labelRenderer.domElement;
    this.layer.className = 'measure-layer';
    this.layer.dataset.locked = viewer.inputEnabled ? 'false' : 'true';
    viewer.root.appendChild(this.layer);
    const { width, height } = viewer.getSize();
    this.labelRenderer.setSize(width, height);

    this._dotTexture = createDotTexture({ fill: '#FF6A13', ring: '#FFFFFF' });
    this._ringTexture = createRingTexture({ color: '#FF6A13' });
    this._snapDotTexture = createDotTexture({ fill: '#1F1F1F', ring: '#FFFFFF', ringWidth: 0.22 });

    this._items = new Map(); // id -> { a, b, line, points, label, el }
    this._pending = null; // Vector3 | null (primer punto de la medición en curso)
    this._hover = null; // { point, snapped } | null
    this._itemsRef = null;

    this._buildPreview();

    this._offs = [
      store.subscribe('measure', (next, prev) => this._onStore(next, prev)),
      bus.on('viewer:click', (e) => this._onClick(e)),
      bus.on('viewer:pointermove', (e) => this._onPointerMove(e)),
      bus.on('viewer:pointerleave', () => this._setHover(null)),
      bus.on('viewer:resize', ({ width: w, height: h }) => this.labelRenderer.setSize(w, h)),
      bus.on('viewer:input', ({ enabled }) => this._onInput(enabled)),
      bus.on('origin:changed', (payload) => this._onOriginChanged(payload)),
      viewer.onAfterRender(() => this.labelRenderer.render(viewer.overlayScene, viewer.camera)),
    ];
    this._onKey = (e) => {
      if (e.key === 'Escape' && this._pending) this.cancel();
    };
    window.addEventListener('keydown', this._onKey);

    this._syncItems(store.get('measure').items);
    this._applyActive(store.get('measure').active);
  }

  // ---------------------------------------------------------------- API

  // Cancela el punto en curso (si lo hay).
  cancel() {
    if (!this._pending) return;
    this._pending = null;
    this._updatePreview(null);
    this.viewer.requestRender();
  }

  hasPending() {
    return !!this._pending;
  }

  formatDistance(value) {
    return MeasureTool.formatDistance(value, this.locale);
  }

  dispose() {
    for (const off of this._offs) off();
    this._offs = [];
    window.removeEventListener('keydown', this._onKey);
    for (const id of [...this._items.keys()]) this._removeItem(id);
    this.viewer.overlayRoot.remove(this.group);
    disposeObject(this.group);
    this._dotTexture.dispose();
    this._ringTexture.dispose();
    this._snapDotTexture.dispose();
    this.layer.remove();
    this.viewer.renderer.domElement.style.cursor = '';
    this.viewer.requestRender();
  }

  // ---------------------------------------------------------------- store

  _onStore(next, prev) {
    if (next.items !== this._itemsRef) this._syncItems(next.items);
    if (next.active !== prev.active) this._applyActive(next.active);
  }

  _applyActive(active) {
    this.viewer.renderer.domElement.style.cursor = active ? 'crosshair' : '';
    if (!active) {
      this._pending = null;
      this._updatePreview(null);
      this._setHover(null);
    }
    this.viewer.requestRender();
  }

  _onInput(enabled) {
    this.layer.dataset.locked = enabled ? 'false' : 'true';
    if (!enabled) {
      this._pending = null;
      this._updatePreview(null);
      this._setHover(null);
    }
    this.viewer.requestRender();
  }

  // Reconcilia los objetos 3D/HTML con store.measure.items (alta, cambio y baja por id).
  _syncItems(items) {
    this._itemsRef = items;
    const seen = new Set();
    for (const it of items) {
      seen.add(it.id);
      const cur = this._items.get(it.id);
      if (cur && sameVec(cur.src.a, it.a) && sameVec(cur.src.b, it.b)) continue;
      if (cur) this._removeItem(it.id);
      this._addItem(it);
    }
    for (const id of [...this._items.keys()]) if (!seen.has(id)) this._removeItem(id);
    this.viewer.requestRender();
  }

  _addItem(src) {
    const a = new THREE.Vector3(...src.a);
    const b = new THREE.Vector3(...src.b);

    const line = createFatLines({ color: LINE_COLOR, linewidth: 2, opacity: 0.9, renderOrder: 10 });
    setFatLinePositions(line, new Float32Array([a.x, a.y, a.z, b.x, b.y, b.z]));

    const points = createMarkerPoints({ texture: this._dotTexture, size: 12, renderOrder: 12, count: 2 });
    points.geometry.attributes.position.array.set([a.x, a.y, a.z, b.x, b.y, b.z]);

    const { object, el } = this._makeLabel(a, b, { id: src.id, deletable: true });
    this.group.add(line, points, object);
    this._items.set(src.id, { src, line, points, label: object, el });
  }

  _removeItem(id) {
    const it = this._items.get(id);
    if (!it) return;
    this.group.remove(it.line, it.points, it.label);
    it.line.geometry.dispose();
    it.line.material.dispose();
    it.points.geometry.dispose();
    it.points.material.dispose();
    it.el.remove();
    this._items.delete(id);
  }

  // Etiqueta HTML con la distancia y, si procede, Δz. Devuelve el CSS2DObject y su elemento.
  _makeLabel(a, b, { id = null, deletable = false, preview = false } = {}) {
    const el = document.createElement('div');
    el.className = `measure-label${preview ? ' measure-label--preview' : ''}`;
    const card = document.createElement('div');
    card.className = 'measure-label__card';
    const dist = document.createElement('span');
    dist.className = 'measure-label__dist';
    const dz = document.createElement('span');
    dz.className = 'measure-label__dz';
    card.append(dist, dz);
    if (deletable) {
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'measure-label__del';
      del.textContent = '×';
      del.title = 'Eliminar medición';
      del.setAttribute('aria-label', 'Eliminar medición');
      del.addEventListener('pointerdown', (e) => e.stopPropagation());
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        if (this.viewer.inputEnabled) this.actions.removeMeasure(id);
      });
      card.appendChild(del);
    }
    el.appendChild(card);
    const object = new CSS2DObject(el);
    object.userData.parts = { dist, dz };
    this._fillLabel(object, a, b);
    return { object, el };
  }

  // Actualiza texto y posición (punto medio) de una etiqueta creada con _makeLabel.
  _fillLabel(object, a, b) {
    const { dist, dz } = object.userData.parts;
    const dzv = Math.abs(b.y - a.y);
    dist.textContent = this.formatDistance(a.distanceTo(b));
    if (dzv > MIN_DZ) {
      dz.textContent = `Δz ${this.formatDistance(dzv)}`;
      dz.style.display = '';
    } else {
      dz.textContent = '';
      dz.style.display = 'none';
    }
    object.position.copy(a).lerp(b, 0.5);
  }

  // ---------------------------------------------------------------- vista previa (línea elástica)

  _buildPreview() {
    this._previewLine = createFatLines({ color: PREVIEW_COLOR, linewidth: 2, opacity: 0.85, renderOrder: 11 });
    setFatLinePositions(this._previewLine, new Float32Array(6));
    this._previewStart = createMarkerPoints({ texture: this._dotTexture, size: 12, renderOrder: 13 });
    this._hoverDot = createMarkerPoints({ texture: this._snapDotTexture, size: 9, renderOrder: 14 });
    this._hoverRing = createMarkerPoints({ texture: this._ringTexture, size: 20, renderOrder: 14 });
    const { object, el } = this._makeLabel(new THREE.Vector3(), new THREE.Vector3(), { preview: true });
    this._previewLabel = object;
    this._previewEl = el;
    for (const o of [this._previewLine, this._previewStart, this._hoverDot, this._hoverRing, this._previewLabel]) {
      o.visible = false;
      this.group.add(o);
    }
  }

  _updatePreview(end) {
    const start = this._pending;
    this._previewStart.visible = !!start;
    if (start) this._setPointPosition(this._previewStart, start);
    const showLine = !!(start && end && start.distanceTo(end) > 1e-6);
    this._previewLine.visible = showLine;
    this._previewLabel.visible = showLine;
    if (showLine) {
      setFatLinePositions(this._previewLine, new Float32Array([start.x, start.y, start.z, end.x, end.y, end.z]));
      this._fillLabel(this._previewLabel, start, end);
    }
  }

  _setPointPosition(points, v) {
    points.geometry.attributes.position.setXYZ(0, v.x, v.y, v.z);
    points.geometry.attributes.position.needsUpdate = true;
  }

  _setHover(hover) {
    this._hover = hover;
    const show = !!hover;
    this._hoverDot.visible = show && !hover.snapped;
    this._hoverRing.visible = show && hover.snapped;
    if (show) {
      this._setPointPosition(hover.snapped ? this._hoverRing : this._hoverDot, hover.point);
    }
    this.viewer.requestRender();
  }

  // ---------------------------------------------------------------- interacción

  _active() {
    return this.store.get('measure').active && this.viewer.inputEnabled;
  }

  _onClick(e) {
    if (!this._active() || e.button !== 0) return;
    const hit = this._pickPoint(e.ndc);
    if (!hit) return;
    const point = hit.point;
    if (!this._pending) {
      this._pending = point.clone();
      this._updatePreview(point);
      this._setHover(hit);
      this.viewer.requestRender();
      return;
    }
    const start = this._pending;
    this._pending = null;
    this._updatePreview(null);
    this._setHover(hit);
    if (start.distanceTo(point) > 1e-4) this.actions.addMeasure(toArray(start), toArray(point));
    this.viewer.requestRender();
  }

  _onPointerMove(e) {
    if (!this._active()) return;
    if (e.buttons) {
      // arrastrando la cámara: sin marcador
      if (this._hover) this._setHover(null);
      return;
    }
    const hit = this._pickPoint(e.ndc);
    this._setHover(hit);
    if (this._pending) {
      this._updatePreview(hit ? hit.point : null);
      this.viewer.requestRender();
    }
  }

  // Primer impacto bajo el cursor (cualquier tipo), atraído al vértice más cercano si procede.
  _pickPoint(ndc) {
    const hit = this.viewer.pick(ndc);
    if (!hit) return null;
    const snapped = this._snap(hit, ndc);
    return snapped ? { point: snapped, snapped: true } : { point: hit.point.clone(), snapped: false };
  }

  _snap(hit, ndc) {
    const obj = hit.object;
    const geo = obj?.geometry;
    const pos = geo?.attributes?.position;
    if (!pos || pos.itemSize < 3) return null;
    let ids = null;
    if (hit.face && Number.isInteger(hit.face.a)) {
      ids = [hit.face.a, hit.face.b, hit.face.c];
    } else if (obj.isPoints && Number.isInteger(hit.index)) {
      ids = [hit.index];
    } else if (Number.isInteger(hit.index) && hit.faceIndex == null) {
      const i = hit.index;
      ids = geo.index ? [geo.index.getX(i), geo.index.getX(i + 1)] : [i, i + 1];
    }
    if (!ids) return null;

    const { width, height } = this.viewer.getSize();
    const planes = this.viewer.getClippingPlanes();
    const v = new THREE.Vector3();
    const p = new THREE.Vector3();
    let best = null;
    let bestPx = SNAP_PX;
    obj.updateWorldMatrix(true, false);
    for (const id of ids) {
      if (!(id >= 0 && id < pos.count)) continue;
      v.fromBufferAttribute(pos, id).applyMatrix4(obj.matrixWorld);
      if (planes.some((pl) => pl.distanceToPoint(v) < -1e-4)) continue;
      p.copy(v).project(this.viewer.camera);
      if (p.z < -1 || p.z > 1) continue;
      const px = Math.hypot(((p.x - ndc.x) * width) / 2, ((p.y - ndc.y) * height) / 2);
      if (px < bestPx) {
        bestPx = px;
        best = v.clone();
      }
    }
    return best;
  }

  // Las mediciones guardadas están en coordenadas de escena: se desplazan con el origen.
  _onOriginChanged(payload) {
    const d = payload?.delta;
    if (!d) return;
    const shift = (arr) => [arr[0] + d.x, arr[1] + d.y, arr[2] + d.z];
    if (this._pending) this._pending.add(new THREE.Vector3(d.x, d.y, d.z));
    const items = this.store.get('measure').items;
    if (items.length) {
      this.store.patch(
        'measure',
        { items: items.map((it) => ({ ...it, a: shift(it.a), b: shift(it.b) })) },
        { source: 'system' },
      );
    }
    this._setHover(null);
  }
}
