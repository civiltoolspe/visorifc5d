// IfcModel: un modelo IFC cargado en la escena.
//
// Contiene el grupo three.js (colocado con WorldOrigin), los lotes de geometría fusionada con dos pasadas
// (normal/opaca y fantasma), las aristas, la textura de estados por elemento, la tabla de elementos,
// los niveles, el árbol espacial y el picking con three-mesh-bvh.
//
// Marcos de referencia:
//   * coordenadas locales del grupo = salida de web-ifc (Y arriba, metros, relativas a `offset`)
//   * el grupo se coloca en `ancla - origen global`, con rotation.y = θ y escala uniforme s (ver georef.js)

import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { ElementTable } from './elementTable.js';
import { createIfcMaterials, createStateUniforms } from './IfcMaterials.js';
import { resolveGeoreference, mapHeightOfModelZ } from './georef.js';
import { STATE, STATE_MASK, resolveStates, applyHover, clearHover, parseHexColor } from './IfcStates.js';
import { typeLabel } from './typeLabels.js';

const STATES_WIDTH = 2048;

export class IfcModel {
  // opts: { id, record, worldOrigin, requestRender }
  constructor({ id, record, worldOrigin, requestRender = () => {} }) {
    this.id = id;
    this.record = record;
    this.name = record?.name || id;
    this.kind = 'ifc';
    this.worldOrigin = worldOrigin;
    this.requestRender = requestRender;

    this.group = new THREE.Group();
    this.group.name = `ifc:${this.name}`;
    this.group.userData.ifcModelId = id;

    this.table = new ElementTable();
    this.ready = false;
    this.schema = '';
    this.lengthFactor = 1;
    this.offset = { x: 0, y: 0, z: 0 };
    this.mapConversion = null;
    this.georefOverride = record?.georef || null;
    this.georef = resolveGeoreference({});
    this.project = { name: '', longName: '', buildings: [], schema: '' };
    this.storeys = [];
    this.tree = null;
    this.stats = null;
    this._nodeMap = null;
    this._localBox = new THREE.Box3();
    this._boxCache = null;
    this._placed = false;

    // Estados por elemento (textura + copia en CPU)
    this._rows = 0;
    this.stateData = new Uint8Array(0);
    this.baseStates = new Uint8Array(0);
    this.overrides = null;
    this._overrideMap = null;
    this.stateTexture = null;
    this.uniforms = createStateUniforms(null, STATES_WIDTH);
    this.materials = createIfcMaterials(this.uniforms);
    this._allocStates(1);

    this._batches = []; // { geometry, mainMesh, ghostMesh, kind }
    this._edgeMeshes = [];
    this._pickMeshes = [];
    this._bvhQueue = [];
    this._bvhTimer = null;
    this._hasGhost = false;
    this._edgesVisible = true;
    this._hoverIdx = -1;
    this._disposed = false;
  }

  // Número de elementos dibujables cargados hasta ahora
  get elementCount() {
    return this.table.count;
  }

  // ------------------------------------------------------------------ colocación
  // Recibe el "frame" del worker (esquema, unidades, desplazamiento, georreferencia) y coloca el grupo.
  applyFrame(frame) {
    this.schema = frame.schema;
    this.lengthFactor = frame.lengthFactor || 1;
    this.offset = frame.offset;
    this.mapConversion = frame.mapConversion;
    this.project = { ...this.project, name: frame.project?.name || '', longName: frame.project?.longName || '', schema: frame.schema };
    this._computeGeoref();
    this._place();
  }

  _computeGeoref() {
    this.georef = resolveGeoreference({
      mapConversion: this.mapConversion,
      offset: this.offset,
      lengthFactor: this.lengthFactor,
      override: this.georefOverride,
    });
  }

  _place() {
    const g = this.georef;
    this.group.rotation.set(0, g.rotationRad, 0);
    this.group.scale.setScalar(g.scale);
    this.group.updateMatrixWorld(true);
    if (!this._placed) {
      this.worldOrigin.register(this.group, g.anchor, { georeferenced: g.georeferenced });
      this._placed = true;
    } else {
      this.worldOrigin.update(this.group, g.anchor, { georeferenced: g.georeferenced });
    }
    this.group.updateMatrixWorld(true);
  }

  // Reubica el modelo sin recargar. override: { eastings, northings, height, rotationDeg, scale } | null
  updateGeoref(override) {
    this.georefOverride = override || null;
    this._computeGeoref();
    if (this._placed) this._place();
    this.requestRender();
  }

  getGeorefInfo() {
    const g = this.georef;
    return {
      source: g.source,
      crs: g.crs,
      eastings: g.eastings,
      northings: g.northings,
      height: g.height,
      rotationDeg: g.rotationDeg,
      scale: g.scale,
      anchor: { ...g.anchor },
      georeferenced: g.georeferenced,
      hasMapConversion: !!this.mapConversion,
    };
  }

  // ------------------------------------------------------------------ estados (textura)
  _allocStates(rows) {
    if (rows <= this._rows) return;
    const cap = STATES_WIDTH * rows;
    const data = new Uint8Array(cap * 4);
    if (this.stateData.length) data.set(this.stateData.subarray(0, Math.min(this.stateData.length, data.length)));
    const base = new Uint8Array(cap);
    if (this.baseStates.length) base.set(this.baseStates.subarray(0, Math.min(this.baseStates.length, cap)));
    const tex = new THREE.DataTexture(data, STATES_WIDTH, rows, THREE.RGBAFormat, THREE.UnsignedByteType);
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.flipY = false;
    tex.needsUpdate = true;
    const old = this.stateTexture;
    this.stateTexture = tex;
    this.stateData = data;
    this.baseStates = base;
    this._rows = rows;
    this.uniforms.uStates.value = tex;
    if (old) old.dispose();
    if (this._overrideMap) this._rebuildOverrides();
  }

  _ensureStates(count) {
    if (count <= this._rows * STATES_WIDTH) return;
    let rows = this._rows;
    while (rows * STATES_WIDTH < count) rows *= 2;
    this._allocStates(rows);
  }

  markStatesDirty() {
    if (this.stateTexture) this.stateTexture.needsUpdate = true;
    this.requestRender();
  }

  setGhostOpacity(v) {
    this.uniforms.uGhostOpacity.value = v;
  }

  setEdgesVisible(v) {
    this._edgesVisible = !!v;
    for (const e of this._edgeMeshes) e.visible = this._edgesVisible;
  }

  // Estado de un elemento (STATE.*)
  getElementState(expressId) {
    const i = this.table.indexOf(expressId);
    return i < 0 ? -1 : this.stateData[i * 4] & STATE_MASK;
  }

  // Resuelve todos los estados con el contexto dado (ver IfcStates.resolveStates).
  resolve(ctx) {
    const stats = resolveStates(this.table, this.stateData, this.baseStates, this.overrides, ctx);
    this._hoverIdx = ctx.hover >= 0 ? ctx.hover : -1;
    this._hasGhost = stats.ghost > 0;
    for (const b of this._batches) b.ghostMesh.visible = this._hasGhost;
    this.markStatesDirty();
    return stats;
  }

  // Cambia sólo el hover (actualización incremental).
  setHover(index) {
    if (index === this._hoverIdx) return false;
    if (this._hoverIdx >= 0 && this._hoverIdx < this.table.count) clearHover(this.stateData, this.baseStates, this.overrides, this._hoverIdx);
    this._hoverIdx = index;
    if (index >= 0 && index < this.table.count) applyHover(this.stateData, this.baseStates, this.overrides, index);
    this.markStatesDirty();
    return true;
  }

  setElementColors(map) {
    this._overrideMap = map && map.size ? new Map(map) : null;
    this._rebuildOverrides();
  }

  _rebuildOverrides() {
    if (!this._overrideMap) {
      this.overrides = null;
      return;
    }
    const cap = this._rows * STATES_WIDTH;
    const flags = new Uint8Array(cap);
    const rgb = new Uint8Array(cap * 3);
    for (const [id, hex] of this._overrideMap) {
      const i = this.table.indexOf(id);
      const c = parseHexColor(hex);
      if (i >= 0 && c) {
        flags[i] = 1;
        rgb[i * 3] = c[0]; rgb[i * 3 + 1] = c[1]; rgb[i * 3 + 2] = c[2];
      }
    }
    this.overrides = { flags, rgb };
  }

  // ------------------------------------------------------------------ geometría
  // Incorpora un fragmento del worker: tabla de elementos + lotes + aristas.
  addChunk(chunk) {
    const e = chunk.elements;
    this.table.appendChunk(e, chunk.typeDictStart, chunk.typeDictAdd);
    this._ensureStates(this.table.count);
    const boxes = e.boxes;
    for (let i = 0; i < boxes.length; i += 6) {
      this._localBox.expandByPoint(_v1.set(boxes[i], boxes[i + 1], boxes[i + 2]));
      this._localBox.expandByPoint(_v1.set(boxes[i + 3], boxes[i + 4], boxes[i + 5]));
    }
    for (const b of chunk.batches) this._addBatch(b);
    if (chunk.edges) this._addEdges(chunk.edges);
    if (this._overrideMap && e.expressIds.length) this._rebuildOverrides();
    this.requestRender();
  }

  _addBatch(b) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(b.positions, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(b.normals, 4, true));
    geo.setAttribute('color', new THREE.BufferAttribute(b.colors, 4, true));
    geo.setAttribute('elementIndex', new THREE.BufferAttribute(b.elementIndex, 1));
    geo.setIndex(new THREE.BufferAttribute(b.indices, 1));
    geo.computeBoundingSphere();
    geo.computeBoundingBox();
    const transparent = b.kind === 'transparent';
    const main = new THREE.Mesh(geo, transparent ? this.materials.transparent : this.materials.opaque);
    main.renderOrder = transparent ? 1 : 0;
    const ghost = new THREE.Mesh(geo, this.materials.ghost);
    ghost.renderOrder = 2;
    ghost.visible = this._hasGhost;
    main.userData.ifcModelId = this.id;
    ghost.userData.ifcModelId = this.id;
    main.name = `ifc-lote-${this._batches.length}`;
    ghost.name = `ifc-fantasma-${this._batches.length}`;
    this.group.add(main, ghost);
    this._batches.push({ geometry: geo, mainMesh: main, ghostMesh: ghost, kind: b.kind });
    this._pickMeshes.push(main);
    this._bvhQueue.push(main);
    this._scheduleBvh();
  }

  _addEdges(edges) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(edges.positions, 3));
    geo.setAttribute('elementIndex', new THREE.BufferAttribute(edges.elementIndex, 1));
    geo.computeBoundingSphere();
    const lines = new THREE.LineSegments(geo, this.materials.edges);
    lines.renderOrder = 3;
    lines.visible = this._edgesVisible;
    lines.name = `ifc-aristas-${this._edgeMeshes.length}`;
    lines.userData.ifcModelId = this.id;
    // Las aristas no participan en el picking
    lines.raycast = () => {};
    this.group.add(lines);
    this._edgeMeshes.push(lines);
  }

  // BVH diferido: se construye de a un lote por turno para no bloquear la interfaz.
  _scheduleBvh() {
    if (this._bvhTimer !== null || this._disposed) return;
    this._bvhTimer = setTimeout(() => {
      this._bvhTimer = null;
      const mesh = this._bvhQueue.shift();
      if (mesh) this._ensureBvh(mesh);
      if (this._bvhQueue.length) this._scheduleBvh();
    }, 8);
  }

  _ensureBvh(mesh) {
    const geo = mesh.geometry;
    if (!geo.boundsTree) geo.boundsTree = new MeshBVH(geo, { indirect: true });
    return geo.boundsTree;
  }

  // ------------------------------------------------------------------ finalización
  // Recibe el resultado final del worker (nombres, niveles, árbol).
  finalize(result) {
    this.table.setNames(result.names, result.globalIds);
    this.table.setStoreys(result.storeyIdx);
    this.storeys = result.storeys;
    this.tree = result.tree;
    this.project = { ...result.project };
    this.stats = result.stats;
    this._nodeMap = null;
    this.ready = true;
    this.requestRender();
  }

  // ------------------------------------------------------------------ niveles
  // Cota de mapa (H) de un nivel (índice en this.storeys)
  mapHeightOfStorey(i) {
    return mapHeightOfModelZ(this.georef, this.storeys[i].zModel);
  }

  storeyHeights() {
    return this.storeys.map((_, i) => this.mapHeightOfStorey(i));
  }

  storeyIndexOf(expressId) {
    return this.storeys.findIndex((s) => s.expressId === expressId);
  }

  getStoreys() {
    const oh = this.worldOrigin.origin ? this.worldOrigin.origin.h : 0;
    return this.storeys.map((s, i) => {
      const mapHeight = this.mapHeightOfStorey(i);
      return {
        modelId: this.id,
        expressId: s.expressId,
        name: s.name,
        elevation: mapHeight - oh,
        mapHeight,
        elementCount: s.elementCount,
      };
    });
  }

  // ------------------------------------------------------------------ árbol y elementos
  _nodes() {
    if (!this._nodeMap) {
      const map = new Map();
      const walk = (n) => {
        map.set(n.expressId, n);
        for (const c of n.children) walk(c);
      };
      if (this.tree) walk(this.tree);
      this._nodeMap = map;
    }
    return this._nodeMap;
  }

  // Ids de los elementos dibujados bajo un nodo del árbol (incluido él mismo si tiene geometría).
  getDescendantElementIds(expressId) {
    const out = [];
    const node = this._nodes().get(expressId);
    if (!node) return this.table.has(expressId) ? [expressId] : [];
    const walk = (n) => {
      if (this.table.has(n.expressId)) out.push(n.expressId);
      for (const c of n.children) walk(c);
    };
    walk(node);
    return out;
  }

  // Índices de tabla que corresponden a un item de selección (expande agregados y contenedores).
  expandToIndices(expressId) {
    const node = this._nodes().get(expressId);
    if (node && node.children.length) {
      const out = [];
      for (const id of this.getDescendantElementIds(expressId)) out.push(this.table.indexOf(id));
      return out;
    }
    const i = this.table.indexOf(expressId);
    return i >= 0 ? [i] : [];
  }

  getElementInfo(expressId) {
    const i = this.table.indexOf(expressId);
    if (i >= 0) {
      const type = this.table.typeOf(i);
      const s = this.table.storeyIdx[i] >= 0 ? this.storeys[this.table.storeyIdx[i]] : null;
      return {
        modelId: this.id,
        expressId,
        globalId: this.table.globalIds[i] || '',
        type,
        typeLabel: typeLabel(type),
        name: this.table.names[i] || typeLabel(type),
        storeyName: s ? s.name : '',
        storeyId: s ? s.expressId : null,
      };
    }
    const node = this._nodes().get(expressId);
    if (!node) return null;
    return {
      modelId: this.id,
      expressId,
      globalId: '',
      type: node.type,
      typeLabel: node.typeLabel,
      name: node.name,
      storeyName: '',
      storeyId: null,
    };
  }

  // ------------------------------------------------------------------ cajas
  // Caja (escena) de la geometría cargada del modelo.
  // Con el grupo girado (IfcMapConversion con rotación) transformar la caja local del modelo entero
  // la infla: la caja del conjunto girado es mayor que la unión de las cajas de sus elementos girados.
  // Por eso, con rotación se une elemento a elemento (exacto para elementos prismáticos) y se cachea.
  getBox() {
    if (this._localBox.isEmpty()) return null;
    this.group.updateMatrixWorld(true);
    const m = this.group.matrixWorld;
    const e = m.elements;
    if (Math.abs(e[2]) < 1e-12 && Math.abs(e[8]) < 1e-12) return this._localBox.clone().applyMatrix4(m);
    const key = `${this.table.count}|${Array.prototype.join.call(e, ',')}`;
    if (this._boxCache?.key === key) return this._boxCache.box.clone();
    const out = new THREE.Box3();
    const bx = this.table.boxes;
    for (let i = 0, n = this.table.count * 6; i < n; i += 6) {
      if (!(bx[i] <= bx[i + 3])) continue; // elemento sin geometría
      for (let k = 0; k < 4; k++) {
        const x = k & 1 ? bx[i + 3] : bx[i];
        const z = k & 2 ? bx[i + 5] : bx[i + 2];
        out.expandByPoint(_v1.set(x, bx[i + 1], z).applyMatrix4(m));
        out.expandByPoint(_v1.set(x, bx[i + 4], z).applyMatrix4(m));
      }
    }
    if (out.isEmpty()) return this._localBox.clone().applyMatrix4(m);
    this._boxCache = { key, box: out };
    return out.clone();
  }

  // Caja (escena) de un elemento por índice de tabla.
  getElementBoxByIndex(i, target = new THREE.Box3()) {
    const b = this.table.boxOf(i);
    target.min.set(b[0], b[1], b[2]);
    target.max.set(b[3], b[4], b[5]);
    this.group.updateMatrixWorld(true);
    return target.applyMatrix4(this.group.matrixWorld);
  }

  // Caja (escena) de un elemento o nodo del árbol por expressId
  getBoxOfExpressId(expressId, target = new THREE.Box3()) {
    const out = new THREE.Box3();
    let any = false;
    for (const i of this.expandToIndices(expressId)) {
      out.union(this.getElementBoxByIndex(i, target.clone()));
      any = true;
    }
    return any ? out : null;
  }

  // ------------------------------------------------------------------ picking
  // Añade a `out` los impactos del rayo (en coordenadas de escena), más cercano por elemento.
  //   clipPlanes: THREE.Plane[] activos (se descartan impactos recortados)
  raycast(raycaster, out, clipPlanes = []) {
    if (!this.group.visible || !this._pickMeshes.length) return;
    this.group.updateMatrixWorld(true);
    const proxy = {
      ray: raycaster.ray,
      near: raycaster.near,
      far: raycaster.far,
      firstHitOnly: false,
      camera: raycaster.camera,
      params: raycaster.params,
      layers: raycaster.layers,
    };
    const tmp = [];
    for (const mesh of this._pickMeshes) {
      const bvh = this._ensureBvh(mesh);
      bvh.raycastObject3D(mesh, proxy, tmp);
    }
    if (!tmp.length) return;
    const best = new Map();
    for (const h of tmp) {
      const geo = h.object.geometry;
      const vi = geo.index.getX(h.faceIndex * 3);
      const ei = geo.getAttribute('elementIndex').getX(vi);
      if ((this.stateData[ei * 4] & STATE_MASK) === STATE.HIDDEN) continue;
      let clipped = false;
      for (const p of clipPlanes) {
        if (p.distanceToPoint(h.point) < 0) { clipped = true; break; }
      }
      if (clipped) continue;
      const prev = best.get(ei);
      if (!prev || h.distance < prev.distance) best.set(ei, h);
    }
    for (const [ei, h] of best) {
      out.push({
        distance: h.distance,
        point: h.point.clone(),
        kind: 'ifc',
        modelId: this.id,
        expressId: this.table.expressIds[ei],
        object: h.object,
      });
    }
  }

  // ------------------------------------------------------------------ liberación
  dispose() {
    this._disposed = true;
    if (this._bvhTimer !== null) clearTimeout(this._bvhTimer);
    this._bvhTimer = null;
    this._bvhQueue.length = 0;
    this.worldOrigin.unregister(this.group);
    if (this.group.parent) this.group.parent.remove(this.group);
    for (const b of this._batches) {
      b.geometry.boundsTree = undefined;
      b.geometry.dispose();
    }
    for (const e of this._edgeMeshes) e.geometry.dispose();
    this.materials.dispose();
    if (this.stateTexture) this.stateTexture.dispose();
    this._batches.length = 0;
    this._edgeMeshes.length = 0;
    this._pickMeshes.length = 0;
    this.group.clear();
  }
}

const _v1 = new THREE.Vector3();
