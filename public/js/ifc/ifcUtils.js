// Utilidades puras para leer líneas devueltas por web-ifc (sin dependencias de three.js ni del DOM).
// Se importan tanto desde el Web Worker como desde Node (pruebas).

// Desenvuelve un valor de web-ifc ({ value, type, name }) a su valor primitivo.
export function val(x) {
  if (x === null || x === undefined) return null;
  if (typeof x === 'object' && !Array.isArray(x) && 'value' in x) return x.value;
  return x;
}

// Identificador express de una referencia ({ type: 5, value }) o null.
export function refId(x) {
  if (x && typeof x === 'object' && x.type === 5 && typeof x.value === 'number') return x.value;
  return null;
}

// Lista de ids de un atributo que es un conjunto de referencias.
export function refIds(x) {
  if (!x) return [];
  const list = Array.isArray(x) ? x : [x];
  const out = [];
  for (const it of list) {
    const id = refId(it);
    if (id !== null) out.push(id);
  }
  return out;
}

export function num(x, fallback = null) {
  const v = val(x);
  if (v === null || v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function str(x, fallback = '') {
  const v = val(x);
  if (v === null || v === undefined) return fallback;
  return String(v);
}

// Lee una línea de forma tolerante (devuelve null si el id no existe o falla).
export function safeLine(api, modelId, expressId, flatten = false, inverse = false, inverseKey = null) {
  try {
    const l = api.GetLine(modelId, expressId, flatten, inverse, inverseKey);
    return l || null;
  } catch {
    return null;
  }
}

// Ids de un tipo (vacío si el tipo no existe en el esquema).
export function lineIds(api, modelId, typeCode, includeInherited = false) {
  if (typeCode === undefined || typeCode === null) return [];
  try {
    const vec = api.GetLineIDsWithType(modelId, typeCode, includeInherited);
    const out = new Array(vec.size());
    for (let i = 0; i < out.length; i++) out[i] = vec.get(i);
    return out;
  } catch {
    return [];
  }
}

// Normaliza texto para búsquedas (minúsculas, sin acentos).
export function normalizeText(s) {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

const PREFIX = {
  EXA: 1e18, PETA: 1e15, TERA: 1e12, GIGA: 1e9, MEGA: 1e6, KILO: 1e3, HECTO: 1e2, DECA: 1e1,
  DECI: 1e-1, CENTI: 1e-2, MILLI: 1e-3, MICRO: 1e-6, NANO: 1e-9, PICO: 1e-12, FEMTO: 1e-15, ATTO: 1e-18,
};

const PREFIX_SYMBOL = {
  EXA: 'E', PETA: 'P', TERA: 'T', GIGA: 'G', MEGA: 'M', KILO: 'k', HECTO: 'h', DECA: 'da',
  DECI: 'd', CENTI: 'c', MILLI: 'm', MICRO: 'µ', NANO: 'n', PICO: 'p', FEMTO: 'f', ATTO: 'a',
};

const SI_SYMBOL = {
  METRE: 'm', SQUARE_METRE: 'm²', CUBIC_METRE: 'm³', GRAM: 'g', SECOND: 's', RADIAN: 'rad',
  KELVIN: 'K', AMPERE: 'A', MOLE: 'mol', CANDELA: 'cd', HERTZ: 'Hz', NEWTON: 'N', PASCAL: 'Pa',
  JOULE: 'J', WATT: 'W', VOLT: 'V', OHM: 'Ω', DEGREE_CELSIUS: '°C', LUMEN: 'lm', LUX: 'lx',
  COULOMB: 'C', FARAD: 'F', HENRY: 'H', WEBER: 'Wb', TESLA: 'T', SIEMENS: 'S', BECQUEREL: 'Bq',
  GRAY: 'Gy', SIEVERT: 'Sv', STERADIAN: 'sr',
};

// Metros por unidad de longitud de un IfcSIUnit / IfcConversionBasedUnit.
export function unitToMetres(api, WebIFC, modelId, unitId, depth = 0) {
  const u = safeLine(api, modelId, unitId);
  if (!u || depth > 3) return 1;
  const name = val(u.Name);
  if (u.type === WebIFC.IFCCONVERSIONBASEDUNIT) {
    const cf = safeLine(api, modelId, refId(u.ConversionFactor));
    if (cf) {
      const comp = num(cf.ValueComponent, 1);
      const unitRef = refId(cf.UnitComponent);
      const base = unitRef ? unitToMetres(api, WebIFC, modelId, unitRef, depth + 1) : 1;
      return comp * base;
    }
    return 1;
  }
  const prefix = val(u.Prefix);
  const factor = prefix && PREFIX[prefix] ? PREFIX[prefix] : 1;
  // Sólo se usa para longitudes; para AREA/VOLUME el valor no se utiliza como factor lineal
  return String(name).includes('METRE') ? factor : 1;
}

// Símbolo legible de una unidad (m, mm, m², ft, in, kg...).
export function unitSymbol(api, WebIFC, modelId, unitId) {
  const u = safeLine(api, modelId, unitId);
  if (!u) return '';
  const name = String(val(u.Name) ?? '');
  if (u.type === WebIFC.IFCCONVERSIONBASEDUNIT) {
    const lower = name.toLowerCase();
    const map = { foot: 'ft', inch: 'in', yard: 'yd', mile: 'mi', 'square foot': 'ft²', 'cubic foot': 'ft³', pound: 'lb', degree: '°' };
    return map[lower] || name.toLowerCase();
  }
  const prefix = val(u.Prefix);
  const base = SI_SYMBOL[name] || name.toLowerCase();
  if (!prefix || !PREFIX_SYMBOL[prefix]) return base;
  // m² con prefijo (p. ej. milli) se escribe mm²
  if (base === 'm²') return `${PREFIX_SYMBOL[prefix]}m²`;
  if (base === 'm³') return `${PREFIX_SYMBOL[prefix]}m³`;
  return `${PREFIX_SYMBOL[prefix]}${base}`;
}

// Lee la asignación de unidades del proyecto.
// Devuelve { lengthFactor, symbols: { LENGTHUNIT: 'm', AREAUNIT: 'm²', ... } }
export function readProjectUnits(api, WebIFC, modelId, projectLine) {
  const out = { lengthFactor: 1, symbols: { LENGTHUNIT: 'm', AREAUNIT: 'm²', VOLUMEUNIT: 'm³', MASSUNIT: 'kg', TIMEUNIT: 's', PLANEANGLEUNIT: 'rad' } };
  if (!projectLine) return out;
  const ctx = safeLine(api, modelId, refId(projectLine.UnitsInContext));
  if (!ctx) return out;
  for (const uid of refIds(ctx.Units)) {
    const u = safeLine(api, modelId, uid);
    if (!u) continue;
    const type = val(u.UnitType);
    if (!type) continue;
    out.symbols[type] = unitSymbol(api, WebIFC, modelId, uid);
    if (type === 'LENGTHUNIT') out.lengthFactor = unitToMetres(api, WebIFC, modelId, uid) || 1;
  }
  return out;
}

const nf = (() => {
  try {
    return new Intl.NumberFormat('es-PE', { maximumFractionDigits: 3, useGrouping: true });
  } catch {
    return null;
  }
})();

export function formatNumber(n) {
  if (!Number.isFinite(n)) return String(n);
  if (nf) return nf.format(n);
  return String(Math.round(n * 1000) / 1000);
}

// Valor legible de un valor IFC ya desenvuelto o crudo.
export function formatValue(x) {
  if (x === null || x === undefined) return '';
  if (Array.isArray(x)) return x.map(formatValue).filter((s) => s !== '').join(', ');
  if (typeof x === 'object') {
    if (x.type === 5) return `#${x.value}`;
    return formatValue(val(x));
  }
  if (typeof x === 'boolean') return x ? 'Sí' : 'No';
  if (typeof x === 'number') return formatNumber(x);
  if (x === '.T.' || x === 'TRUE') return 'Sí';
  if (x === '.F.' || x === 'FALSE') return 'No';
  if (x === '.U.' || x === 'UNKNOWN') return 'Desconocido';
  return String(x);
}
