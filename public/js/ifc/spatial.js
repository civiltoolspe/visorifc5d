// Lectura (pura) de la estructura espacial de un modelo IFC con web-ifc:
// nombres de elementos, contención en niveles, niveles con su elevación real y árbol espacial.
// Se usa desde el worker y desde Node (pruebas).

import { str, num, refId, refIds, lineIds, safeLine } from './ifcUtils.js';
import { typeLabel } from './typeLabels.js';

// Tipos de contenedores espaciales que nunca se dibujan como elementos
const SPATIAL_TYPES = new Set([
  'IFCPROJECT', 'IFCSITE', 'IFCBUILDING', 'IFCBUILDINGSTOREY',
  'IFCFACILITY', 'IFCFACILITYPART', 'IFCBRIDGE', 'IFCBRIDGEPART', 'IFCROAD', 'IFCROADPART',
  'IFCRAILWAY', 'IFCRAILWAYPART', 'IFCMARINEFACILITY', 'IFCMARINEPART', 'IFCEXTERNALSPATIALELEMENT',
  'IFCSPATIALZONE',
]);

export function isSpatialType(typeName) {
  return SPATIAL_TYPES.has(typeName);
}

// Lee GlobalId y Name de cada elemento (en el orden de `expressIds`).
export function readElementNames(api, handle, expressIds) {
  const n = expressIds.length;
  const names = new Array(n);
  const globalIds = new Array(n);
  for (let i = 0; i < n; i++) {
    const line = safeLine(api, handle, expressIds[i]);
    names[i] = line ? str(line.Name) : '';
    globalIds[i] = line ? str(line.GlobalId) : '';
  }
  return { names, globalIds };
}

// Estructura espacial.
//   elements: { expressIds: Int32Array|number[], typeNames: string[], names: string[], boxes: Float32Array(6n) }
//   offsetZ: componente Z del desplazamiento de web-ifc (para convertir y' <-> Z del modelo)
//   lengthFactor: metros por unidad de longitud del archivo
// Devuelve { storeys, storeyIdx, tree, buildings }
//   storeys: [{ expressId, name, zModel, elevationAttr, source }] ordenados por elevación (zModel en metros, Z arriba)
//   storeyIdx: Int32Array por elemento (índice en storeys o -1)
export function readSpatialStructure(api, WebIFC, handle, { elements, offsetZ = 0, lengthFactor = 1 }) {
  const count = elements.expressIds.length;
  const indexOfId = new Map();
  for (let i = 0; i < count; i++) indexOfId.set(elements.expressIds[i], i);

  // Relaciones de agregación y contención
  const aggParent = new Map();
  const aggChildren = new Map();
  for (const rid of lineIds(api, handle, WebIFC.IFCRELAGGREGATES)) {
    const r = safeLine(api, handle, rid);
    if (!r) continue;
    const parent = refId(r.RelatingObject);
    if (parent === null) continue;
    const kids = refIds(r.RelatedObjects);
    for (const k of kids) aggParent.set(k, parent);
    const list = aggChildren.get(parent);
    if (list) list.push(...kids);
    else aggChildren.set(parent, kids);
  }
  const containerOf = new Map();
  const contained = new Map();
  for (const rid of lineIds(api, handle, WebIFC.IFCRELCONTAINEDINSPATIALSTRUCTURE)) {
    const r = safeLine(api, handle, rid);
    if (!r) continue;
    const structure = refId(r.RelatingStructure);
    if (structure === null) continue;
    const kids = refIds(r.RelatedElements);
    for (const k of kids) if (!containerOf.has(k)) containerOf.set(k, structure);
    const list = contained.get(structure);
    if (list) list.push(...kids);
    else contained.set(structure, kids);
  }

  // Niveles
  const storeyRecords = [];
  for (const sid of lineIds(api, handle, WebIFC.IFCBUILDINGSTOREY)) {
    const line = safeLine(api, handle, sid);
    if (!line) continue;
    const elevAttr = num(line.Elevation, null);
    let zModel = null;
    let source = 'placement';
    const placementId = refId(line.ObjectPlacement);
    if (placementId !== null) {
      try {
        const m = api.GetWorldTransformMatrix(handle, placementId);
        if (m && m.length >= 16 && Number.isFinite(m[14])) zModel = m[14] * lengthFactor;
      } catch {
        zModel = null;
      }
    }
    storeyRecords.push({
      expressId: sid,
      name: str(line.Name) || str(line.LongName) || `Nivel ${sid}`,
      zModel,
      elevationAttr: elevAttr === null ? null : elevAttr * lengthFactor,
      source,
    });
  }
  const storeyOfNode = new Map();
  storeyRecords.forEach((s, i) => storeyOfNode.set(s.expressId, i));

  // Nivel contenedor de cada elemento (también para partes agregadas)
  const rawStoreyIdx = new Int32Array(count).fill(-1);
  const storeyAncestor = (node) => {
    let cur = node;
    for (let guard = 0; guard < 32 && cur !== undefined; guard++) {
      const s = storeyOfNode.get(cur);
      if (s !== undefined) return s;
      cur = aggParent.get(cur);
    }
    return -1;
  };
  for (let i = 0; i < count; i++) {
    let cur = elements.expressIds[i];
    for (let guard = 0; guard < 32 && cur !== undefined; guard++) {
      const own = storeyOfNode.get(cur);
      if (own !== undefined) {
        rawStoreyIdx[i] = own;
        break;
      }
      const cont = containerOf.get(cur);
      if (cont !== undefined) {
        rawStoreyIdx[i] = storeyAncestor(cont);
        break;
      }
      cur = aggParent.get(cur);
    }
  }

  // Respaldo de elevación: atributo Elevation (+ cota del edificio) y, por último, el mínimo Y de los elementos
  const minYOfStorey = new Float64Array(storeyRecords.length).fill(Infinity);
  for (let i = 0; i < count; i++) {
    const s = rawStoreyIdx[i];
    if (s < 0) continue;
    const y = elements.boxes[i * 6 + 1];
    if (y < minYOfStorey[s]) minYOfStorey[s] = y;
  }
  // Cota Z (metros, marco del modelo) de la colocación del primer ancestro que la tenga
  const ancestorPlacementZ = (id) => {
    let cur = aggParent.get(id);
    for (let guard = 0; guard < 8 && cur !== undefined; guard++) {
      const l = safeLine(api, handle, cur);
      const pid = l ? refId(l.ObjectPlacement) : null;
      if (pid !== null) {
        try {
          const m = api.GetWorldTransformMatrix(handle, pid);
          if (m && m.length >= 16 && Number.isFinite(m[14])) return m[14] * lengthFactor;
        } catch {
          return 0;
        }
      }
      cur = aggParent.get(cur);
    }
    return 0;
  };
  storeyRecords.forEach((s, i) => {
    if (s.zModel !== null) return;
    if (s.elevationAttr !== null) {
      s.zModel = ancestorPlacementZ(s.expressId) + s.elevationAttr;
      s.source = 'attribute';
    } else if (Number.isFinite(minYOfStorey[i])) {
      s.zModel = minYOfStorey[i] + offsetZ;
      s.source = 'elements';
    } else {
      s.zModel = 0;
      s.source = 'none';
    }
  });

  // Orden por elevación
  const order = storeyRecords.map((_, i) => i).sort((a, b) => {
    const d = storeyRecords[a].zModel - storeyRecords[b].zModel;
    return d !== 0 ? d : storeyRecords[a].name.localeCompare(storeyRecords[b].name);
  });
  const remap = new Int32Array(storeyRecords.length);
  order.forEach((oldIdx, newIdx) => { remap[oldIdx] = newIdx; });
  const storeys = order.map((i) => ({ ...storeyRecords[i] }));
  const storeyIdx = new Int32Array(count);
  const perStorey = new Int32Array(storeys.length);
  for (let i = 0; i < count; i++) {
    const s = rawStoreyIdx[i];
    storeyIdx[i] = s < 0 ? -1 : remap[s];
    if (s >= 0) perStorey[remap[s]]++;
  }
  storeys.forEach((s, i) => { s.elementCount = perStorey[i]; });

  // Árbol espacial
  const typeCache = new Map();
  const typeNameOf = (id) => {
    const idx = indexOfId.get(id);
    if (idx !== undefined) return elements.typeNames[idx];
    let t = typeCache.get(id);
    if (t === undefined) {
      try {
        t = String(api.GetNameFromTypeCode(api.GetLineType(handle, id))).toUpperCase();
      } catch {
        t = 'IFCROOT';
      }
      typeCache.set(id, t);
    }
    return t;
  };
  const nameCache = new Map();
  const nameOf = (id) => {
    const idx = indexOfId.get(id);
    if (idx !== undefined) return elements.names[idx];
    let n = nameCache.get(id);
    if (n === undefined) {
      const l = safeLine(api, handle, id);
      n = l ? str(l.Name) || str(l.LongName) : '';
      nameCache.set(id, n);
    }
    return n;
  };

  // Padres agregados no espaciales que contienen elementos dibujados (p. ej. un muro cortina)
  const keepParents = new Set();
  for (let i = 0; i < count; i++) {
    let p = aggParent.get(elements.expressIds[i]);
    for (let guard = 0; guard < 16 && p !== undefined; guard++) {
      if (SPATIAL_TYPES.has(typeNameOf(p))) break;
      keepParents.add(p);
      p = aggParent.get(p);
    }
  }
  const isPartOfKeptParent = (id) => {
    const p = aggParent.get(id);
    return p !== undefined && !SPATIAL_TYPES.has(typeNameOf(p)) && (indexOfId.has(p) || keepParents.has(p));
  };

  const visited = new Set();
  const buildNode = (id, depth) => {
    visited.add(id);
    const type = typeNameOf(id);
    const spatial = SPATIAL_TYPES.has(type);
    const node = {
      expressId: id,
      type,
      typeLabel: typeLabel(type),
      name: nameOf(id) || typeLabel(type),
      children: [],
      isSpatial: spatial,
      hasGeometry: indexOfId.has(id),
    };
    if (depth > 24) return node;
    const spatialKids = [];
    const elementKids = [];
    const consider = (cid, viaAggregate) => {
      if (visited.has(cid)) return;
      const ctype = typeNameOf(cid);
      if (SPATIAL_TYPES.has(ctype)) {
        spatialKids.push(cid);
        return;
      }
      const drawn = indexOfId.has(cid);
      if (!drawn && !keepParents.has(cid)) return;
      // Las partes agregadas cuelgan de su padre, no del contenedor espacial
      if (!viaAggregate && isPartOfKeptParent(cid)) return;
      elementKids.push(cid);
    };
    for (const cid of aggChildren.get(id) || []) consider(cid, true);
    for (const cid of contained.get(id) || []) consider(cid, false);
    // Los niveles se listan de menor a mayor elevación
    spatialKids.sort((a, b) => {
      const sa = storeyOfNode.get(a);
      const sb = storeyOfNode.get(b);
      return sa !== undefined && sb !== undefined ? storeyRecords[sa].zModel - storeyRecords[sb].zModel : 0;
    });
    for (const cid of spatialKids) {
      if (!visited.has(cid)) node.children.push(buildNode(cid, depth + 1));
    }
    const uniq = [...new Set(elementKids)].filter((cid) => !visited.has(cid));
    const keyed = uniq.map((cid) => ({ cid, key: `${typeNameOf(cid)}\u0000${nameOf(cid)}` }));
    keyed.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.cid - b.cid));
    for (const { cid } of keyed) {
      if (!visited.has(cid)) node.children.push(buildNode(cid, depth + 1));
    }
    return node;
  };

  const projects = lineIds(api, handle, WebIFC.IFCPROJECT);
  let tree;
  if (projects.length) {
    tree = buildNode(projects[0], 0);
  } else {
    tree = { expressId: -2, type: 'IFCPROJECT', typeLabel: typeLabel('IFCPROJECT'), name: 'Proyecto', children: [], isSpatial: true, hasGeometry: false };
  }
  // Elementos no alcanzables desde el proyecto
  const orphans = [];
  for (let i = 0; i < count; i++) {
    const id = elements.expressIds[i];
    if (!visited.has(id)) orphans.push(id);
  }
  if (orphans.length) {
    const group = { expressId: -1, type: 'GROUP', typeLabel: 'Grupo', name: 'Sin nivel asignado', children: [], isSpatial: true, hasGeometry: false };
    for (const id of orphans) {
      if (!visited.has(id)) group.children.push(buildNode(id, 1));
    }
    tree.children.push(group);
  }

  const buildings = [];
  for (const bid of lineIds(api, handle, WebIFC.IFCBUILDING)) {
    const l = safeLine(api, handle, bid);
    const n = l ? str(l.Name) || str(l.LongName) : '';
    if (n) buildings.push(n);
  }

  return { storeys, storeyIdx, tree, buildings };
}
