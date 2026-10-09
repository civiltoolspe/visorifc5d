// Caja de sección: recorta el modelo con 6 planos alineados a los ejes y dibuja su contorno.
//
// Estado (store.section): { enabled, min:[x,y,z], max:[x,y,z] } en coordenadas de escena.
// Convención de three.js: se recorta el lado NEGATIVO de cada plano (distanceToPoint < 0),
// por eso los planos de la caja miran hacia dentro y se conserva el interior.

import * as THREE from 'three';
import { ACCENT_ORANGE, createFatLines, setFatLinePositions, disposeObject } from './overlayUtils.js';

const AXES = ['x', 'y', 'z'];

// Aristas de la caja como pares de índices de esquina (bit0 = x, bit1 = y, bit2 = z)
const EDGES = [
  [0, 1], [2, 3], [4, 5], [6, 7], // paralelas a X
  [0, 2], [1, 3], [4, 6], [5, 7], // paralelas a Y
  [0, 4], [1, 5], [2, 6], [3, 7], // paralelas a Z
];

const isFiniteVec = (v) => Array.isArray(v) && v.length >= 3 && v.slice(0, 3).every((n) => Number.isFinite(Number(n)));

export class SectionBox {
  constructor({ viewer, store, bus }) {
    this.viewer = viewer;
    this.store = store;
    this.bus = bus;

    this._box = new THREE.Box3();
    this._active = false;
    this._pendingFill = false;
    this._planes = Array.from({ length: 6 }, () => new THREE.Plane());

    this._lines = createFatLines({ color: ACCENT_ORANGE, linewidth: 1.6, opacity: 0.8, renderOrder: 5 });
    this._lines.name = 'sectionBoxLines';
    this._group = new THREE.Group();
    this._group.name = 'sectionBox';
    this._group.visible = false;
    this._group.add(this._lines);
    viewer.overlayRoot.add(this._group);

    this._offs = [
      store.subscribe('section', (next, _prev, meta) => this._onStore(next, meta)),
      bus.on('origin:changed', (payload) => this._onOriginChanged(payload)),
    ];
    this._onStore(store.get('section'), { source: 'system' });
  }

  // ---------------------------------------------------------------- API

  // Ajusta la caja a box3 (coordenadas de escena) y la escribe en el store.
  fitTo(box3) {
    if (!box3?.isBox3 || box3.isEmpty()) return;
    this.store.patch(
      'section',
      { min: box3.min.toArray(), max: box3.max.toArray() },
      { source: 'local' },
    );
  }

  // Límites para los deslizadores de la UI: lo visible (con holgura) unido a la caja actual.
  getBounds() {
    const box = this.viewer.getVisibleBox(new THREE.Box3());
    if (!box.isEmpty()) {
      const pad = Math.max(0.1, box.getSize(new THREE.Vector3()).length() * 0.01);
      box.expandByScalar(pad);
    }
    const sec = this.store.get('section');
    if (isFiniteVec(sec.min) && isFiniteVec(sec.max) && !this._isEmpty(sec)) {
      box.union(new THREE.Box3(new THREE.Vector3(...sec.min), new THREE.Vector3(...sec.max)));
    }
    if (box.isEmpty()) {
      const t = this.viewer.controls.getTarget(new THREE.Vector3(), false);
      box.setFromCenterAndSize(t, new THREE.Vector3(20, 20, 20));
    }
    return box;
  }

  // Caja actual en coordenadas de escena (clon) o null si no hay.
  getBox() {
    return this._active ? this._box.clone() : null;
  }

  isEnabled() {
    return !!this.store.get('section').enabled;
  }

  setEnabled(enabled) {
    this.store.patch('section', { enabled: !!enabled }, { source: 'local' });
  }

  // Reinicia la caja a la de lo visible (o la selección).
  reset() {
    const box = this._defaultBox();
    if (box) this.fitTo(box);
  }

  // Mueve una cara: axis 'x'|'y'|'z', side 'min'|'max', value en metros de escena.
  setFace(axis, side, value) {
    const i = AXES.indexOf(axis);
    if (i < 0 || (side !== 'min' && side !== 'max') || !Number.isFinite(value)) return;
    const sec = this.store.get('section');
    const arr = [...(isFiniteVec(sec[side]) ? sec[side] : [0, 0, 0])];
    arr[i] = value;
    this.store.patch('section', { [side]: arr }, { source: 'local' });
  }

  dispose() {
    for (const off of this._offs) off();
    this._offs = [];
    this.viewer.setClipping('section', []);
    this.viewer.overlayRoot.remove(this._group);
    disposeObject(this._group);
    this.viewer.requestRender();
  }

  // ---------------------------------------------------------------- interno

  _isEmpty(sec) {
    return !isFiniteVec(sec.min) || !isFiniteVec(sec.max) || AXES.every((_, i) => Number(sec.min[i]) === Number(sec.max[i]));
  }

  _defaultBox() {
    let box = null;
    const items = this.store.get('selection')?.items || [];
    if (items.length) box = this.viewer.getSelectionBox(items);
    if (!box) box = this.viewer.getVisibleBox(new THREE.Box3());
    if (!box || box.isEmpty()) {
      const t = this.viewer.controls.getTarget(new THREE.Vector3(), false);
      return new THREE.Box3().setFromCenterAndSize(t, new THREE.Vector3(10, 10, 10));
    }
    box = box.clone();
    box.expandByScalar(Math.max(0.05, box.getSize(new THREE.Vector3()).length() * 0.01));
    return box;
  }

  _onStore(sec, meta) {
    if (!sec) return;
    if (sec.enabled && this._isEmpty(sec) && meta?.source !== 'remote') {
      // Al activarse con la caja vacía se rellena con lo visible. Se difiere a un microtask
      // para no emitir una notificación anidada dentro de la del store (los demás
      // suscriptores recibirían primero el valor nuevo y después el viejo).
      if (!this._pendingFill) {
        this._pendingFill = true;
        queueMicrotask(() => {
          this._pendingFill = false;
          const cur = this.store.get('section');
          if (cur.enabled && this._isEmpty(cur)) this.reset();
        });
      }
    }
    this._apply(sec);
  }

  _apply(sec) {
    const valid = sec.enabled && !this._isEmpty(sec);
    if (!valid) {
      this._active = false;
      this._group.visible = false;
      this.viewer.setClipping('section', []);
      this.viewer.requestRender();
      return;
    }
    const min = new THREE.Vector3();
    const max = new THREE.Vector3();
    for (let i = 0; i < 3; i++) {
      const a = Number(sec.min[i]);
      const b = Number(sec.max[i]);
      min.setComponent(i, Math.min(a, b));
      max.setComponent(i, Math.max(a, b));
    }
    this._box.set(min, max);
    this._active = true;

    // Interior de la caja: cada plano mira hacia dentro (se recorta lo que queda fuera)
    this._planes[0].set(new THREE.Vector3(1, 0, 0), -min.x);
    this._planes[1].set(new THREE.Vector3(-1, 0, 0), max.x);
    this._planes[2].set(new THREE.Vector3(0, 1, 0), -min.y);
    this._planes[3].set(new THREE.Vector3(0, -1, 0), max.y);
    this._planes[4].set(new THREE.Vector3(0, 0, 1), -min.z);
    this._planes[5].set(new THREE.Vector3(0, 0, -1), max.z);
    this.viewer.setClipping('section', this._planes);

    const corners = [];
    for (let i = 0; i < 8; i++) {
      corners.push([i & 1 ? max.x : min.x, i & 2 ? max.y : min.y, i & 4 ? max.z : min.z]);
    }
    const positions = new Float32Array(EDGES.length * 6);
    EDGES.forEach(([a, b], i) => {
      positions.set(corners[a], i * 6);
      positions.set(corners[b], i * 6 + 3);
    });
    setFatLinePositions(this._lines, positions);
    this._group.visible = true;
    this.viewer.requestRender();
  }

  // La caja está en coordenadas de escena: al cambiar el origen global se desplaza igual.
  _onOriginChanged(payload) {
    const d = payload?.delta;
    const sec = this.store.get('section');
    if (!d || this._isEmpty(sec)) return;
    const shift = (v) => [Number(v[0]) + d.x, Number(v[1]) + d.y, Number(v[2]) + d.z];
    this.store.patch('section', { min: shift(sec.min), max: shift(sec.max) }, { source: 'system' });
  }
}
