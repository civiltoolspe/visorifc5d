// Georreferenciación de modelos IFC (módulo puro: se usa en el worker, en el hilo principal y en Node).
//
// Convenciones verificadas empíricamente con web-ifc 0.0.78 (COORDINATE_TO_ORIGIN = true):
//  * La geometría que entrega web-ifc ya está en Y arriba: (x, y, z)_ifc -> (x, z, -y).
//  * GetCoordinationMatrix() devuelve la traslación APLICADA a la geometría (en metros, Y arriba):
//      v_web = v_real_yup + t     con  t = (m[12], m[13], m[14])
//    Por lo tanto las coordenadas reales del modelo (Z arriba, metros) son:
//      X = x' - t.x,   Y = t.z - z',   Z = y' - t.y
//    y el "desplazamiento" del origen local de web-ifc respecto al sistema del modelo es
//      offset = (X0, Y0, Z0) = (-t.x, t.z, -t.y).
//  * Las coordenadas locales del grupo three.js son exactamente (x', y', z') de web-ifc, de modo que el grupo
//    se coloca con: ancla = conversión a mapa de `offset`, rotation.y = θ y scale = s.

import { val, num, str, refId, refIds, lineIds, safeLine, readProjectUnits } from './ifcUtils.js';

// Por encima de este valor (m) una coordenada se considera georreferenciada (igual que WorldOrigin)
export const GEO_THRESHOLD = 10000;

// Desplazamiento del origen local de web-ifc respecto del sistema del modelo (Z arriba, metros).
export function offsetFromCoordinationMatrix(m) {
  if (!m || m.length < 16) return { x: 0, y: 0, z: 0 };
  const ox = -m[12];
  const oy = m[14];
  const oz = -m[13];
  return { x: ox || 0, y: oy || 0, z: oz || 0 };
}

// Lee los parámetros de IfcMapConversion (IFC4+) o de ePSet_MapConversion (IFC2x3).
// Devuelve null si el modelo no declara georreferencia. Los valores son los del archivo (sin convertir).
export function readMapConversion(api, WebIFC, modelId, { projectId = null, lengthFactor = 1 } = {}) {
  let found = null;

  // IFC4 / IFC4X3: IfcMapConversion + IfcProjectedCRS
  const ids = lineIds(api, modelId, WebIFC.IFCMAPCONVERSION);
  if (ids.length) {
    const mc = safeLine(api, modelId, ids[0]);
    if (mc) {
      const crs = safeLine(api, modelId, refId(mc.TargetCRS));
      let mapUnitFactor = null;
      if (crs && refId(crs.MapUnit)) {
        mapUnitFactor = unitFactorOf(api, WebIFC, modelId, refId(crs.MapUnit));
      }
      found = {
        eastings: num(mc.Eastings, 0),
        northings: num(mc.Northings, 0),
        orthogonalHeight: num(mc.OrthogonalHeight, 0),
        xAxisAbscissa: num(mc.XAxisAbscissa, null),
        xAxisOrdinate: num(mc.XAxisOrdinate, null),
        scale: num(mc.Scale, 1),
        crsName: crs ? str(crs.Name) || str(crs.Description) : '',
        crsDescription: crs ? str(crs.Description) : '',
        mapUnitFactor,
        origin: 'IfcMapConversion',
      };
    }
  }

  // IFC2x3 (o IFC4 sin IfcMapConversion): ePSet_MapConversion / ePSet_ProjectedCRS asignados al IfcProject
  if (!found && projectId) {
    const psets = readProjectPsets(api, WebIFC, modelId, projectId);
    const mcp = psets.get('epset_mapconversion');
    if (mcp) {
      const crsp = psets.get('epset_projectedcrs');
      found = {
        eastings: num(mcp.Eastings, 0),
        northings: num(mcp.Northings, 0),
        orthogonalHeight: num(mcp.OrthogonalHeight, 0),
        xAxisAbscissa: num(mcp.XAxisAbscissa, null),
        xAxisOrdinate: num(mcp.XAxisOrdinate, null),
        scale: num(mcp.Scale, 1),
        crsName: crsp ? str(crsp.Name) || str(crsp.Description) : '',
        crsDescription: crsp ? str(crsp.Description) : '',
        mapUnitFactor: null,
        origin: 'ePSet_MapConversion',
      };
    }
  }
  if (found) found.lengthFactor = lengthFactor;
  return found;
}

function unitFactorOf(api, WebIFC, modelId, unitId) {
  const u = safeLine(api, modelId, unitId);
  if (!u) return null;
  // Se reutiliza la lógica de readProjectUnits a través de un IfcUnitAssignment ficticio no es posible;
  // se calcula directamente.
  const name = String(val(u.Name) ?? '');
  if (u.type === WebIFC.IFCCONVERSIONBASEDUNIT) {
    const cf = safeLine(api, modelId, refId(u.ConversionFactor));
    if (!cf) return null;
    const base = refId(cf.UnitComponent) ? unitFactorOf(api, WebIFC, modelId, refId(cf.UnitComponent)) : 1;
    return num(cf.ValueComponent, 1) * (base ?? 1);
  }
  if (!name.includes('METRE')) return null;
  const prefixes = { KILO: 1e3, HECTO: 1e2, DECA: 10, DECI: 0.1, CENTI: 0.01, MILLI: 0.001, MICRO: 1e-6 };
  const p = val(u.Prefix);
  return p && prefixes[p] ? prefixes[p] : 1;
}

// Psets del IfcProject: Map(nombre en minúsculas -> { propiedad: valor }).
function readProjectPsets(api, WebIFC, modelId, projectId) {
  const out = new Map();
  const proj = safeLine(api, modelId, projectId, false, true, 'IsDefinedBy');
  if (!proj) return out;
  for (const relId of refIds(proj.IsDefinedBy)) {
    const rel = safeLine(api, modelId, relId);
    if (!rel) continue;
    const defIds = refIds(rel.RelatingPropertyDefinition);
    for (const did of defIds) {
      const ps = safeLine(api, modelId, did);
      if (!ps) continue;
      const name = str(ps.Name).toLowerCase();
      if (!name.startsWith('epset_')) continue;
      const props = {};
      for (const pid of refIds(ps.HasProperties)) {
        const p = safeLine(api, modelId, pid);
        if (p && p.Name) props[str(p.Name)] = p.NominalValue;
      }
      out.set(name, props);
    }
  }
  return out;
}

// Calcula la colocación del modelo en coordenadas de mapa.
//   mapConversion: resultado de readMapConversion (o null)
//   offset: desplazamiento del origen local de web-ifc (offsetFromCoordinationMatrix)
//   lengthFactor: metros por unidad de longitud del archivo
//   override: { eastings, northings, height, rotationDeg, scale } | null (sobrescritura manual, en metros)
// Devuelve { source, crs, eastings, northings, height, rotationDeg, rotationRad, scale, anchor, georeferenced }
// donde eastings/northings/height/scale son los de una "conversión equivalente" en metros:
//   E = eastings + scale * (X cosθ - Y sinθ)   N = northings + scale * (X sinθ + Y cosθ)   H = height + scale * Z
// con (X, Y, Z) coordenadas del modelo en metros (Z arriba).
export function resolveGeoreference({ mapConversion = null, offset = { x: 0, y: 0, z: 0 }, lengthFactor = 1, override = null } = {}) {
  let source = 'none';
  let crs = null;
  let eastings = 0;
  let northings = 0;
  let height = 0;
  let rotationRad = 0;
  let scale = 1;

  if (override && isFiniteOverride(override)) {
    source = 'manual';
    eastings = Number(override.eastings);
    northings = Number(override.northings);
    height = Number(override.height) || 0;
    rotationRad = ((Number(override.rotationDeg) || 0) * Math.PI) / 180;
    scale = Number(override.scale) > 0 ? Number(override.scale) : 1;
    crs = mapConversion?.crsName || null;
  } else if (mapConversion) {
    const mf = mapConversion.mapUnitFactor ?? lengthFactor ?? 1;
    const sc = mapConversion.scale > 0 ? mapConversion.scale : 1;
    eastings = mf * mapConversion.eastings;
    northings = mf * mapConversion.northings;
    height = mf * mapConversion.orthogonalHeight;
    // escala efectiva sobre coordenadas del modelo en metros
    scale = (mf * sc) / (lengthFactor || 1);
    const a = mapConversion.xAxisAbscissa;
    const o = mapConversion.xAxisOrdinate;
    rotationRad = a === null && o === null ? 0 : Math.atan2(o ?? 0, a ?? 1);
    crs = mapConversion.crsName || null;
    const trivial = eastings === 0 && northings === 0 && height === 0 && rotationRad === 0 && Math.abs(scale - 1) < 1e-12;
    if (trivial && isLarge(offset)) {
      source = 'site';
    } else {
      source = 'mapconversion';
    }
  } else if (isLarge(offset)) {
    source = 'site';
  }

  const c = Math.cos(rotationRad);
  const s = Math.sin(rotationRad);
  const anchor = {
    e: eastings + scale * (offset.x * c - offset.y * s),
    n: northings + scale * (offset.x * s + offset.y * c),
    h: height + scale * offset.z,
  };
  const georeferenced = Math.abs(anchor.e) > GEO_THRESHOLD || Math.abs(anchor.n) > GEO_THRESHOLD;
  return {
    source,
    crs,
    eastings,
    northings,
    height,
    rotationRad,
    rotationDeg: (rotationRad * 180) / Math.PI,
    scale,
    anchor,
    georeferenced,
  };
}

function isLarge(offset) {
  return Math.abs(offset.x) > GEO_THRESHOLD || Math.abs(offset.y) > GEO_THRESHOLD;
}

function isFiniteOverride(o) {
  return o && Number.isFinite(Number(o.eastings)) && Number.isFinite(Number(o.northings));
}

// Convierte un punto de la geometría de web-ifc (x', y', z'; Y arriba, relativo al origen local) a coordenadas de mapa.
export function webPointToMap(georef, x, y, z) {
  const c = Math.cos(georef.rotationRad);
  const s = Math.sin(georef.rotationRad);
  // coordenadas locales Z arriba relativas al ancla: (x', -z', y')
  const lx = x;
  const ly = -z;
  const lz = y;
  return {
    e: georef.anchor.e + georef.scale * (lx * c - ly * s),
    n: georef.anchor.n + georef.scale * (lx * s + ly * c),
    h: georef.anchor.h + georef.scale * lz,
  };
}

// Altura de mapa (H) de una cota Z del modelo (metros, Z arriba).
export function mapHeightOfModelZ(georef, zModel) {
  return georef.height + georef.scale * zModel;
}

// Lee la información básica del proyecto y las unidades.
export function readProjectBasics(api, WebIFC, modelId) {
  const ids = lineIds(api, modelId, WebIFC.IFCPROJECT);
  const projectId = ids.length ? ids[0] : null;
  const line = projectId ? safeLine(api, modelId, projectId) : null;
  const units = readProjectUnits(api, WebIFC, modelId, line);
  return {
    projectId,
    name: line ? str(line.Name) : '',
    longName: line ? str(line.LongName) : '',
    units,
  };
}
