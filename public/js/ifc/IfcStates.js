// Resolución de estados por elemento (módulo puro, sin three.js).
//
// Cada elemento tiene un código de estado que se escribe en la textura de estados leída por el shader:
//   R: bits 0-2 = estado (STATE.*), bit 7 = hay color de sobrescritura
//   G, B, A: color de sobrescritura (sRGB 0-255) cuando el bit 7 está activo
//
// Reglas (docs/ARQUITECTURA.md sección 7):
//   1. tipo en hiddenTypes, en hidden[modelo], fuera de isolated, o (modo 'only' y no es del nivel activo) -> OCULTO
//   2. modo 'cut' con nivel activo: elementos de niveles superiores -> OCULTO
//   3. con selección: seleccionados -> SELECCIONADO; resto según selectionMode
//      ('ghost' -> FANTASMA, 'isolate' -> OCULTO, 'highlight' -> NORMAL)
//   4. hover (sólo si no está oculto ni seleccionado) -> HOVER
// Los espacios (IfcSpace) están ocultos salvo display.showSpaces.

export const STATE = Object.freeze({ NORMAL: 0, GHOST: 1, HIDDEN: 2, SELECTED: 3, HOVER: 4 });
export const STATE_MASK = 7;
export const OVERRIDE_BIT = 128;

const EPS_HEIGHT = 1e-3; // m

// Marca los elementos de una lista de expressId. Con `expand` (id -> índices) también se admiten ids de nodos
// del árbol (niveles, edificios, agregados), que se expanden a los elementos dibujados que contienen.
function flagsFrom(ids, table, expand) {
  const flags = new Uint8Array(table.count);
  for (const id of ids) {
    if (expand) {
      for (const i of expand(id)) if (i >= 0 && i < flags.length) flags[i] = 1;
    } else {
      const i = table.indexOf(id);
      if (i >= 0) flags[i] = 1;
    }
  }
  return flags;
}

// Calcula los estados de un modelo y los escribe en `out` (Uint8Array RGBA de la textura).
//   table: ElementTable
//   out: Uint8Array (>= count * 4)
//   base: Uint8Array (>= count) recibe el estado sin hover (para actualizaciones incrementales)
//   overrides: { flags: Uint8Array(count), rgb: Uint8Array(count*3) } | null
//   ctx: {
//     hiddenTypes: Set<string>, hiddenIds: number[]|null, isolatedIds: number[]|null, showSpaces: boolean,
//     selectionMode: 'ghost'|'isolate'|'highlight', selected: Int32Array|number[] (índices), hasSelection: boolean,
//     hover: number (índice) | -1,
//     expand?: (expressId) => number[]   (opcional) expande ids de nodos del árbol a índices de elementos
//     storey: null | { mode: 'cut'|'only', height: number, sameModelIdx: number, heights: Float64Array|number[] }
//   }
// Devuelve { ghost, hidden, selected }.
export function resolveStates(table, out, base, overrides, ctx) {
  const n = table.count;
  const typeCount = table.typeNames.length;
  const typeHidden = new Uint8Array(typeCount);
  for (let t = 0; t < typeCount; t++) {
    const name = table.typeNames[t] || '';
    const cat = table.categoryOfTypeIdx(t);
    let hidden = ctx.hiddenTypes.has(name) || ctx.hiddenTypes.has(cat);
    if (!hidden && name === 'IFCSPACE' && !ctx.showSpaces) hidden = true;
    typeHidden[t] = hidden ? 1 : 0;
  }
  const manual = ctx.hiddenIds && ctx.hiddenIds.length ? flagsFrom(ctx.hiddenIds, table, ctx.expand) : null;
  const iso = ctx.isolatedIds ? flagsFrom(ctx.isolatedIds, table, ctx.expand) : null;
  const sel = new Uint8Array(n);
  for (let k = 0; k < ctx.selected.length; k++) {
    const i = ctx.selected[k];
    if (i >= 0 && i < n) sel[i] = 1;
  }
  const hasSelection = !!ctx.hasSelection;
  const mode = ctx.selectionMode;
  const storey = ctx.storey;
  let ghost = 0;
  let hiddenCount = 0;
  let selectedCount = 0;

  for (let i = 0; i < n; i++) {
    let st = STATE.NORMAL;
    let hidden = typeHidden[table.typeIdx[i]] === 1;
    if (!hidden && manual && manual[i]) hidden = true;
    if (!hidden && iso && !iso[i]) hidden = true;
    if (!hidden && storey) {
      const s = table.storeyIdx[i];
      if (storey.mode === 'only') {
        let ok;
        if (storey.sameModelIdx >= 0) ok = s === storey.sameModelIdx;
        else ok = s >= 0 && Math.abs(storey.heights[s] - storey.height) < 0.1;
        if (!ok) hidden = true;
      } else if (s >= 0 && storey.heights[s] > storey.height + EPS_HEIGHT) {
        hidden = true;
      }
    }
    if (hidden) {
      st = STATE.HIDDEN;
    } else if (hasSelection) {
      if (sel[i]) st = STATE.SELECTED;
      else if (mode === 'ghost') st = STATE.GHOST;
      else if (mode === 'isolate') st = STATE.HIDDEN;
    }
    if (st === STATE.GHOST) ghost++;
    else if (st === STATE.HIDDEN) hiddenCount++;
    else if (st === STATE.SELECTED) selectedCount++;
    base[i] = st;
    writeCode(out, overrides, i, st);
  }
  if (ctx.hover >= 0 && ctx.hover < n) applyHover(out, base, overrides, ctx.hover);
  return { ghost, hidden: hiddenCount, selected: selectedCount };
}

function writeCode(out, overrides, i, st) {
  const o = i * 4;
  if (overrides && overrides.flags[i]) {
    out[o] = st | OVERRIDE_BIT;
    out[o + 1] = overrides.rgb[i * 3];
    out[o + 2] = overrides.rgb[i * 3 + 1];
    out[o + 3] = overrides.rgb[i * 3 + 2];
  } else {
    out[o] = st;
  }
}

// El hover sólo se aplica a elementos normales o fantasma.
export function applyHover(out, base, overrides, index) {
  const b = base[index];
  if (b === STATE.NORMAL || b === STATE.GHOST) writeCode(out, overrides, index, STATE.HOVER);
}

// Quita el hover de un elemento y restaura su estado base.
export function clearHover(out, base, overrides, index) {
  writeCode(out, overrides, index, base[index]);
}

// Lee el estado resuelto de un elemento desde la textura (para pruebas y picking).
export function stateOf(out, index) {
  return out[index * 4] & STATE_MASK;
}

// Convierte '#rrggbb' en [r, g, b] (0-255). Devuelve null si no es válido.
export function parseHexColor(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) return null;
  const v = parseInt(m[1], 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}
