// Modelo CAD cargado: grupo three.js + metadatos georreferenciados.
//
// Convención de alturas:
//   - Los vértices guardan la cota del dibujo relativa a `drawingAnchor.h` (cota Z del propio dibujo).
//   - La cota de colocación `elevation` (m) se suma a la Z del dibujo: H = Z + elevation.
//   - `anchor` es el ancla de mapa con la que el grupo está registrado en WorldOrigin:
//         { e, n, h: drawingAnchor.h + elevation }
//     de modo que la posición de escena del grupo es mapToScene(anchor) y los vértices
//     (relativos al ancla del dibujo) quedan en  y = (Z + cota) − O.h.

export class CadModel {
  constructor({
    id, name, kind, group, units, unitScale, insunits, unitsSource, georeferenced,
    drawingAnchor, drawingExtents, hasZ, elevation, layers, layerObjects, stats, version,
  }) {
    this.id = id;
    this.name = name;
    this.kind = kind; // 'dxf' | 'dwg'
    this.group = group; // THREE.Group
    this.units = units; // 'mm' | 'cm' | 'm' | 'in' | 'ft' ...
    this.unitScale = unitScale; // metros por unidad de dibujo
    this.insunits = insunits;
    this.unitsSource = unitsSource; // 'header' | 'override' | 'default'
    this.georeferenced = georeferenced;
    this.drawingAnchor = drawingAnchor; // { e, n, h } (h = centro Z del dibujo, redondeado)
    this.drawingExtents = drawingExtents; // { min:{e,n,h}, max:{e,n,h} } sin cota de colocación
    this.hasZ = hasZ; // el dibujo tiene cotas Z propias (no es plano)
    this.elevation = elevation; // cota efectiva (m)
    this.layers = layers; // [{ name, color, count, hiddenInFile }]
    this.layerObjects = layerObjects; // Map<nombre de capa, Object3D[]>
    this.stats = stats;
    this.version = version;
  }

  // Ancla de mapa con la que se registra el grupo en WorldOrigin
  get anchor() {
    return {
      e: this.drawingAnchor.e,
      n: this.drawingAnchor.n,
      h: this.drawingAnchor.h + this.elevation,
    };
  }

  // Extensión real de la geometría en coordenadas de mapa (incluye la cota de colocación)
  get extents() {
    const { min, max } = this.drawingExtents;
    return {
      min: { e: min.e, n: min.n, h: min.h + this.elevation },
      max: { e: max.e, n: max.n, h: max.h + this.elevation },
    };
  }

  // ¿Es un dibujo plano? (sin cotas Z propias: la cota automática solo aplica a estos)
  get flat() {
    return !this.hasZ;
  }

  setLayerHidden(name, hidden) {
    const objs = this.layerObjects.get(name);
    if (!objs) return;
    for (const o of objs) o.visible = !hidden;
  }

  // Aplica un conjunto de capas ocultas; devuelve true si algo cambió
  setHiddenLayers(hiddenSet) {
    let changed = false;
    for (const [name, objs] of this.layerObjects) {
      const visible = !hiddenSet.has(name);
      for (const o of objs) {
        if (o.visible !== visible) {
          o.visible = visible;
          changed = true;
        }
      }
    }
    return changed;
  }

  isLayerVisible(name) {
    const objs = this.layerObjects.get(name);
    return !!objs && objs.some((o) => o.visible);
  }

  dispose() {
    this.group.removeFromParent();
    const materials = new Set();
    this.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) materials.add(o.material);
    });
    for (const m of materials) m.dispose();
    this.layerObjects.clear();
  }
}
