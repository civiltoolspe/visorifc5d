// Utilidades compartidas por los normalizadores DXF y DWG.
// Módulo puro, importable desde Node y desde Web Workers.

import { isDefaultExtrusion } from './mat.js';

const DEG = Math.PI / 180;

export function num(v, fallback = 0) {
  if (v === undefined || v === null || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export const degToRad = (d) => num(d) * DEG;

// {x,y,z} → [x,y,z] (z ausente = 0)
export function p3(p) {
  if (!p) return [0, 0, 0];
  return [num(p.x), num(p.y), num(p.z)];
}

// Dirección de extrusión → [x,y,z] o null si es la normal por defecto / nula.
export function ext3(p) {
  if (!p) return null;
  const v = [num(p.x), num(p.y), num(p.z)];
  return isDefaultExtrusion(v) ? null : v;
}

export function extFromParts(x, y, z) {
  if (x === undefined && y === undefined && z === undefined) return null;
  const v = [num(x), num(y), num(z, 1)];
  return isDefaultExtrusion(v) ? null : v;
}

export const MODEL_SPACE_RE = /^\*model_space$/i;
export const PAPER_SPACE_RE = /^\*paper_space/i;

export function isSpaceBlock(name) {
  return MODEL_SPACE_RE.test(name) || PAPER_SPACE_RE.test(name);
}

// Contador de entidades omitidas por tipo
export function countSkipped(stats, type) {
  stats.skipped[type] = (stats.skipped[type] || 0) + 1;
}

// Convierte un tramo de polilínea a la forma plana del IR: [x,y,z,bulge, ...]
export function flatVertices(list, zDefault = 0) {
  const out = new Array(list.length * 4);
  for (let i = 0; i < list.length; i++) {
    const v = list[i];
    out[i * 4] = num(v.x);
    out[i * 4 + 1] = num(v.y);
    out[i * 4 + 2] = num(v.z, zDefault);
    out[i * 4 + 3] = num(v.bulge);
  }
  return out;
}
