// Unidades de dibujo CAD ($INSUNITS) y su conversión a metros.
// Módulo puro, importable desde Node y desde Web Workers.

// Código $INSUNITS → [etiqueta, metros por unidad]
const INSUNITS = {
  1: ['in', 0.0254],
  2: ['ft', 0.3048],
  3: ['mi', 1609.344],
  4: ['mm', 0.001],
  5: ['cm', 0.01],
  6: ['m', 1],
  7: ['km', 1000],
  8: ['µin', 0.0254e-6],
  9: ['mil', 0.0254e-3],
  10: ['yd', 0.9144],
  11: ['Å', 1e-10],
  12: ['nm', 1e-9],
  13: ['µm', 1e-6],
  14: ['dm', 0.1],
  15: ['dam', 10],
  16: ['hm', 100],
  17: ['Gm', 1e9],
  18: ['ua', 149597870700],
  19: ['al', 9460730472580800],
  20: ['pc', 30856775814913673],
  21: ['ft', 1200 / 3937],
  22: ['in', 100 / 3937],
  23: ['yd', 3600 / 3937],
  24: ['mi', 6336000 / 3937],
};

// Sobrescrituras permitidas en record.cad.units
const OVERRIDES = {
  mm: 0.001,
  cm: 0.01,
  m: 1,
  in: 0.0254,
  ft: 0.3048,
};

export const CAD_UNIT_OPTIONS = ['auto', 'mm', 'cm', 'm', 'in', 'ft'];

// Devuelve { units, unitScale, source } donde unitScale son metros por unidad de dibujo.
//  - override: 'auto' | 'mm' | 'cm' | 'm' | 'in' | 'ft' (record.cad.units)
//  - insunits: valor de $INSUNITS del archivo (0 o ausente = sin unidad → metros)
export function resolveUnits(insunits, override = 'auto') {
  const key = typeof override === 'string' ? override.toLowerCase() : 'auto';
  if (key !== 'auto' && Object.prototype.hasOwnProperty.call(OVERRIDES, key)) {
    return { units: key, unitScale: OVERRIDES[key], source: 'override' };
  }
  const code = Math.trunc(Number(insunits));
  const entry = INSUNITS[code];
  if (entry) return { units: entry[0], unitScale: entry[1], source: 'header' };
  return { units: 'm', unitScale: 1, source: 'default' };
}
