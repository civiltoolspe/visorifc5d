// Lectura (pura) de propiedades de un elemento IFC con web-ifc:
// atributos directos, conjuntos de propiedades, cantidades, tipo y materiales.
// Se usa desde el worker y desde Node (pruebas).

import { str, num, refId, refIds, safeLine, formatValue, formatNumber } from './ifcUtils.js';

// Atributos que son referencias o geometría y no aportan como "atributo directo"
const SKIP_ATTRIBUTES = new Set(['expressID', 'type', 'OwnerHistory', 'ObjectPlacement', 'Representation']);

// Unidad por defecto según el tipo de medida IFC
const MEASURE_UNIT = {
  IFCLENGTHMEASURE: 'LENGTHUNIT',
  IFCPOSITIVELENGTHMEASURE: 'LENGTHUNIT',
  IFCNONNEGATIVELENGTHMEASURE: 'LENGTHUNIT',
  IFCAREAMEASURE: 'AREAUNIT',
  IFCVOLUMEMEASURE: 'VOLUMEUNIT',
  IFCMASSMEASURE: 'MASSUNIT',
  IFCPLANEANGLEMEASURE: 'PLANEANGLEUNIT',
  IFCPOSITIVEPLANEANGLEMEASURE: 'PLANEANGLEUNIT',
  IFCTIMEMEASURE: 'TIMEUNIT',
};

function typeName(api, line) {
  try {
    return api.GetNameFromTypeCode(line.type);
  } catch {
    return '';
  }
}

function withUnit(text, unit) {
  return unit && text !== '' ? `${text} ${unit}` : text;
}

function unitOfValue(api, WebIFC, handle, wrapper, unitRef, units) {
  if (unitRef !== null && unitRef !== undefined) {
    const sym = units.symbolOfUnit ? units.symbolOfUnit(unitRef) : '';
    if (sym) return sym;
  }
  const measure = wrapper && typeof wrapper === 'object' && typeof wrapper.name === 'string' ? wrapper.name.toUpperCase() : '';
  const unitType = MEASURE_UNIT[measure];
  return unitType ? units.symbols[unitType] || '' : '';
}

function readProperty(api, WebIFC, handle, id, units, prefix = '') {
  const p = safeLine(api, handle, id);
  if (!p) return [];
  const name = prefix + str(p.Name);
  const t = p.type;
  const out = [];
  if (t === WebIFC.IFCPROPERTYSINGLEVALUE) {
    const v = p.NominalValue;
    const unit = unitOfValue(api, WebIFC, handle, v, refId(p.Unit), units);
    out.push({ name, value: withUnit(formatValue(v), unit) });
  } else if (t === WebIFC.IFCPROPERTYENUMERATEDVALUE) {
    out.push({ name, value: formatValue(p.EnumerationValues) });
  } else if (t === WebIFC.IFCPROPERTYBOUNDEDVALUE) {
    const lo = formatValue(p.LowerBoundValue);
    const hi = formatValue(p.UpperBoundValue);
    const sp = formatValue(p.SetPointValue);
    const unit = unitOfValue(api, WebIFC, handle, p.UpperBoundValue || p.LowerBoundValue || p.SetPointValue, refId(p.Unit), units);
    const parts = [];
    if (lo || hi) parts.push(`${lo || '…'} – ${hi || '…'}`);
    if (sp) parts.push(`valor de consigna ${sp}`);
    out.push({ name, value: withUnit(parts.join(' · '), unit) });
  } else if (t === WebIFC.IFCPROPERTYLISTVALUE) {
    const unit = unitOfValue(api, WebIFC, handle, Array.isArray(p.ListValues) ? p.ListValues[0] : null, refId(p.Unit), units);
    out.push({ name, value: withUnit(formatValue(p.ListValues), unit) });
  } else if (t === WebIFC.IFCPROPERTYTABLEVALUE) {
    const defining = formatValue(p.DefiningValues);
    const defined = formatValue(p.DefinedValues);
    out.push({ name, value: defining || defined ? `${defining} → ${defined}` : '' });
  } else if (t === WebIFC.IFCPROPERTYREFERENCEVALUE) {
    const ref = safeLine(api, handle, refId(p.PropertyReference));
    out.push({ name, value: ref ? str(ref.Name) || typeName(api, ref) : '' });
  } else if (t === WebIFC.IFCCOMPLEXPROPERTY) {
    const usage = str(p.UsageName);
    for (const sub of refIds(p.HasProperties)) {
      out.push(...readProperty(api, WebIFC, handle, sub, units, `${name}${usage ? ` (${usage})` : ''}.`));
    }
  } else {
    out.push({ name, value: '' });
  }
  return out;
}

function quantityValue(api, WebIFC, handle, q, units) {
  const t = q.type;
  let raw = null;
  let unitType = null;
  if (t === WebIFC.IFCQUANTITYLENGTH) { raw = q.LengthValue; unitType = 'LENGTHUNIT'; }
  else if (t === WebIFC.IFCQUANTITYAREA) { raw = q.AreaValue; unitType = 'AREAUNIT'; }
  else if (t === WebIFC.IFCQUANTITYVOLUME) { raw = q.VolumeValue; unitType = 'VOLUMEUNIT'; }
  else if (t === WebIFC.IFCQUANTITYWEIGHT) { raw = q.WeightValue; unitType = 'MASSUNIT'; }
  else if (t === WebIFC.IFCQUANTITYTIME) { raw = q.TimeValue; unitType = 'TIMEUNIT'; }
  else if (t === WebIFC.IFCQUANTITYCOUNT) { raw = q.CountValue; unitType = null; }
  else return null;
  const n = num(raw, null);
  let unit = '';
  const unitRef = refId(q.Unit);
  if (unitRef !== null && units.symbolOfUnit) unit = units.symbolOfUnit(unitRef);
  if (!unit && unitType) unit = units.symbols[unitType] || '';
  return { value: n === null ? formatValue(raw) : formatNumber(n), unit };
}

// Lee un conjunto de propiedades o de cantidades.
function readDefinition(api, WebIFC, handle, id, units, target) {
  const ps = safeLine(api, handle, id);
  if (!ps) return;
  const name = str(ps.Name) || typeName(api, ps);
  if (ps.type === WebIFC.IFCPROPERTYSET) {
    const props = [];
    for (const pid of refIds(ps.HasProperties)) props.push(...readProperty(api, WebIFC, handle, pid, units));
    target.psets.push({ name, props });
  } else if (ps.type === WebIFC.IFCELEMENTQUANTITY) {
    const props = [];
    for (const qid of refIds(ps.Quantities)) {
      const q = safeLine(api, handle, qid);
      if (!q) continue;
      const qv = quantityValue(api, WebIFC, handle, q, units);
      if (qv) props.push({ name: str(q.Name), value: qv.value, unit: qv.unit });
    }
    target.quantities.push({ name, props });
  } else if (ps.type === WebIFC.IFCPROPERTYSETDEFINITIONSET) {
    for (const sub of refIds(ps.PropertySetDefinitions || ps.Definitions)) readDefinition(api, WebIFC, handle, sub, units, target);
  }
}

// Descripción legible de un material (o juego de materiales).
function describeMaterial(api, WebIFC, handle, id, units, out, depth = 0) {
  if (depth > 4) return;
  const m = safeLine(api, handle, id);
  if (!m) return;
  const t = m.type;
  const lenSym = units.symbols.LENGTHUNIT || '';
  if (t === WebIFC.IFCMATERIAL) {
    const n = str(m.Name);
    if (n) out.push(n);
  } else if (t === WebIFC.IFCMATERIALLAYERSETUSAGE) {
    describeMaterial(api, WebIFC, handle, refId(m.ForLayerSet), units, out, depth + 1);
  } else if (t === WebIFC.IFCMATERIALLAYERSET) {
    for (const lid of refIds(m.MaterialLayers)) describeMaterial(api, WebIFC, handle, lid, units, out, depth + 1);
  } else if (t === WebIFC.IFCMATERIALLAYER) {
    const mat = safeLine(api, handle, refId(m.Material));
    const n = mat ? str(mat.Name) : str(m.Name);
    const th = num(m.LayerThickness, null);
    if (n) out.push(th !== null ? `${n} (${formatNumber(th)} ${lenSym})`.trim() : n);
  } else if (t === WebIFC.IFCMATERIALPROFILESETUSAGE) {
    describeMaterial(api, WebIFC, handle, refId(m.ForProfileSet), units, out, depth + 1);
  } else if (t === WebIFC.IFCMATERIALPROFILESET) {
    for (const pid of refIds(m.MaterialProfiles)) describeMaterial(api, WebIFC, handle, pid, units, out, depth + 1);
  } else if (t === WebIFC.IFCMATERIALPROFILE) {
    const mat = safeLine(api, handle, refId(m.Material));
    const n = mat ? str(mat.Name) : '';
    const prof = safeLine(api, handle, refId(m.Profile));
    const pn = prof ? str(prof.ProfileName) : '';
    const label = [n, pn && pn !== n ? `perfil ${pn}` : ''].filter(Boolean).join(' – ');
    if (label) out.push(label);
  } else if (t === WebIFC.IFCMATERIALCONSTITUENTSET) {
    for (const cid of refIds(m.MaterialConstituents)) describeMaterial(api, WebIFC, handle, cid, units, out, depth + 1);
  } else if (t === WebIFC.IFCMATERIALCONSTITUENT) {
    const mat = safeLine(api, handle, refId(m.Material));
    const n = mat ? str(mat.Name) : '';
    const cn = str(m.Name);
    const label = [n, cn && cn !== n ? `(${cn})` : ''].filter(Boolean).join(' ');
    if (label) out.push(label);
  } else if (t === WebIFC.IFCMATERIALLIST) {
    for (const mid of refIds(m.Materials)) describeMaterial(api, WebIFC, handle, mid, units, out, depth + 1);
  } else {
    const n = str(m.Name);
    if (n) out.push(n);
  }
}

function readMaterials(api, WebIFC, handle, objectId, units) {
  const out = [];
  const inv = safeLine(api, handle, objectId, false, true, 'HasAssociations');
  if (!inv) return out;
  for (const rid of refIds(inv.HasAssociations)) {
    const rel = safeLine(api, handle, rid);
    if (!rel || rel.type !== WebIFC.IFCRELASSOCIATESMATERIAL) continue;
    describeMaterial(api, WebIFC, handle, refId(rel.RelatingMaterial), units, out);
  }
  return out;
}

// Construye el objeto `units` que esperan las funciones: { symbols, symbolOfUnit }
export function makeUnitContext(symbols, symbolOfUnit) {
  return { symbols, symbolOfUnit };
}

// Lee todas las propiedades legibles de un elemento.
// Devuelve { attributes, psets, quantities, type: {name, psets}|null, materials }
export function readElementProperties(api, WebIFC, handle, expressId, units) {
  const result = { attributes: [], psets: [], quantities: [], type: null, materials: [] };
  const line = safeLine(api, handle, expressId);
  if (!line) return result;

  // --- Atributos directos ---
  result.attributes.push({ name: 'Clase IFC', value: typeName(api, line) });
  result.attributes.push({ name: 'ExpressID', value: String(expressId) });
  for (const key of Object.keys(line)) {
    if (SKIP_ATTRIBUTES.has(key)) continue;
    const raw = line[key];
    if (raw === null || raw === undefined) continue;
    if (Array.isArray(raw)) {
      if (raw.some((x) => x && x.type === 5)) continue;
    } else if (typeof raw === 'object' && raw.type === 5) {
      continue;
    }
    const text = formatValue(raw);
    if (text === '') continue;
    result.attributes.push({ name: key, value: text });
  }

  // --- Propiedades, cantidades y tipo ---
  const relIds = new Set();
  const inv1 = safeLine(api, handle, expressId, false, true, 'IsDefinedBy');
  if (inv1) for (const id of refIds(inv1.IsDefinedBy)) relIds.add(id);
  const inv2 = safeLine(api, handle, expressId, false, true, 'IsTypedBy');
  if (inv2) for (const id of refIds(inv2.IsTypedBy)) relIds.add(id);

  let typeObjectId = null;
  for (const rid of relIds) {
    const rel = safeLine(api, handle, rid);
    if (!rel) continue;
    if (rel.type === WebIFC.IFCRELDEFINESBYPROPERTIES) {
      for (const did of refIds(rel.RelatingPropertyDefinition)) readDefinition(api, WebIFC, handle, did, units, result);
    } else if (rel.type === WebIFC.IFCRELDEFINESBYTYPE) {
      typeObjectId = refId(rel.RelatingType);
    }
  }

  if (typeObjectId !== null) {
    const t = safeLine(api, handle, typeObjectId);
    if (t) {
      const tgt = { psets: [], quantities: [] };
      for (const pid of refIds(t.HasPropertySets)) readDefinition(api, WebIFC, handle, pid, units, tgt);
      result.type = { name: str(t.Name) || typeName(api, t), className: typeName(api, t), psets: [...tgt.psets, ...tgt.quantities] };
    }
  }

  // --- Materiales (del elemento o, si no tiene, de su tipo) ---
  result.materials = readMaterials(api, WebIFC, handle, expressId, units);
  if (!result.materials.length && typeObjectId !== null) {
    result.materials = readMaterials(api, WebIFC, handle, typeObjectId, units);
  }
  result.materials = [...new Set(result.materials)];
  return result;
}

