// Origen global de la escena en coordenadas de mapa (doble precisión).
//
// Coordenadas de mapa (E, N, H) → escena (Y arriba):
//   x = E − O.e,  y = H − O.h,  z = −(N − O.n)
//
// Cada modelo registra su grupo three.js con un "ancla" (coordenadas de mapa
// de su origen local, en float64). La posición del grupo es ancla − O, de modo
// que los vértices Float32 se mantienen pequeños y no hay pérdida de precisión
// aunque el proyecto esté en UTM.

import * as THREE from 'three';

const GEO_THRESHOLD = 10000; // m: por encima se considera coordenada georreferenciada

export class WorldOrigin {
  constructor(bus) {
    this.bus = bus;
    this.origin = null; // { e, n, h }
    this._georeferenced = false; // el origen actual proviene de un modelo georreferenciado
    this._entries = new Map(); // object3D -> { anchor, georeferenced }
  }

  isSet() {
    return this.origin !== null;
  }

  static isGeoreferencedAnchor(anchor) {
    return Math.abs(anchor.e) > GEO_THRESHOLD || Math.abs(anchor.n) > GEO_THRESHOLD;
  }

  register(object3D, anchor, { georeferenced } = {}) {
    const geo = georeferenced ?? WorldOrigin.isGeoreferencedAnchor(anchor);
    this._entries.set(object3D, { anchor: { ...anchor }, georeferenced: geo });
    if (!this.origin) {
      this.origin = roundAnchor(anchor);
      this._georeferenced = geo;
    } else if (geo && !this._georeferenced) {
      // El origen lo fijó un modelo local: se reubica al primer modelo georreferenciado
      this.rebase(roundAnchor(anchor), true);
    }
    this._place(object3D, anchor);
    return object3D.position;
  }

  update(object3D, anchor, { georeferenced } = {}) {
    const entry = this._entries.get(object3D);
    if (!entry) return this.register(object3D, anchor, { georeferenced });
    entry.anchor = { ...anchor };
    if (georeferenced !== undefined) entry.georeferenced = georeferenced;
    if (entry.georeferenced && !this._georeferenced) {
      this.rebase(roundAnchor(anchor), true);
    }
    this._place(object3D, anchor);
    return object3D.position;
  }

  unregister(object3D) {
    this._entries.delete(object3D);
    if (this._entries.size === 0) {
      this.origin = null;
      this._georeferenced = false;
    }
  }

  getAnchor(object3D) {
    return this._entries.get(object3D)?.anchor ?? null;
  }

  mapToScene(e, n, h, target = new THREE.Vector3()) {
    const o = this.origin || { e: 0, n: 0, h: 0 };
    return target.set(e - o.e, h - o.h, -(n - o.n));
  }

  sceneToMap(v) {
    const o = this.origin || { e: 0, n: 0, h: 0 };
    return { e: v.x + o.e, n: -v.z + o.n, h: v.y + o.h };
  }

  // Cambia el origen y reposiciona todo lo registrado. Emite 'origin:changed'
  // con el desplazamiento que deben aplicar la cámara y las ayudas en escena.
  rebase(newOrigin, georeferenced = this._georeferenced) {
    const old = this.origin || { e: 0, n: 0, h: 0 };
    this.origin = { ...newOrigin };
    this._georeferenced = georeferenced;
    for (const [obj, entry] of this._entries) this._place(obj, entry.anchor);
    // Un punto fijo en el mapa se mueve en escena: delta = escenaNueva − escenaVieja
    const delta = new THREE.Vector3(old.e - newOrigin.e, old.h - newOrigin.h, -(old.n - newOrigin.n));
    this.bus?.emit('origin:changed', { delta, origin: { ...this.origin } });
  }

  _place(object3D, anchor) {
    this.mapToScene(anchor.e, anchor.n, anchor.h, object3D.position);
    object3D.updateMatrixWorld(true);
  }
}

function roundAnchor(a) {
  return { e: Math.round(a.e), n: Math.round(a.n), h: Math.round(a.h) };
}
