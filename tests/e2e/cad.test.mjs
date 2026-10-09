// Prueba E2E del módulo CAD (DXF/DWG georreferenciados).
// Uso: node tests/e2e/cad.test.mjs   (puerto 8104; sirve public/ con tests/devserver.mjs)
// Termina con código 0 si todo pasa y 1 si algo falla.
//
// Parte A (Node): lógica pura (colores, unidades, teselado, MTEXT), normalización de
//   planta_georef.dxf, DXF sintético con todas las entidades, lectura de DWG con libredwg-web.
// Parte B (navegador): carga con Web Worker en la página sandbox /dev/cad.html, render no vacío,
//   capas ocultas, cota automática, DWG, unidades y descarga.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { startDevServer } from '../devserver.mjs';
import {
  launchBrowser, openPage, assert, FIXTURES, OUTPUT, ROOT,
} from './helpers.mjs';

const PORT = 8104;
const BASE = `http://127.0.0.1:${PORT}`;
const CAD = path.join(ROOT, 'public', 'js', 'cad');
const imp = (f) => import(pathToFileURL(path.join(CAD, f)).href);

const results = [];
async function step(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  OK     ${name} (${Date.now() - t0} ms)`);
  } catch (err) {
    results.push({ name, ok: false, error: err });
    console.log(`  FALLA  ${name}\n         ${err.stack?.split('\n').slice(0, 3).join('\n         ') || err.message}`);
  }
}

const near = (a, b, tol, msg) => assert(Math.abs(a - b) <= tol, `${msg} (esperado ${b}, obtenido ${a}, tol ${tol})`);

// ---------------------------------------------------------------------------
// Utilidades de Node
// ---------------------------------------------------------------------------
const require = createRequire(import.meta.url);
const DxfParser = require('dxf-parser');
const THREE = await import('three');

let libInstance = null;
const loaders = {
  dxfParser: async () => DxfParser,
  libreDwg: async () => {
    if (!libInstance) {
      const mod = await import('@mlightcad/libredwg-web');
      libInstance = {
        lib: await mod.LibreDwg.create(path.join(ROOT, 'node_modules', '@mlightcad', 'libredwg-web', 'wasm')),
        Dwg_File_Type: mod.Dwg_File_Type,
      };
    }
    return libInstance;
  },
  triangulator: async () => (contour, holes) => THREE.ShapeUtils.triangulateShape(
    contour.map((p) => new THREE.Vector2(p.x, p.y)),
    holes.map((h) => h.map((p) => new THREE.Vector2(p.x, p.y))),
  ),
};

const toArrayBuffer = (buf) => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

// Segmentos de una capa en coordenadas de mapa [E1,N1,Z1,E2,N2,Z2] (Z de dibujo, sin cota)
function mapSegments(result, layer) {
  const part = result.parts.find((p) => p.layer.toUpperCase() === layer.toUpperCase());
  if (!part?.lines) return [];
  const a = result.anchor;
  const pos = part.lines.pos;
  const out = [];
  for (let i = 0; i < pos.length; i += 6) {
    out.push([
      pos[i] + a.e, -pos[i + 2] + a.n, pos[i + 1] + a.h,
      pos[i + 3] + a.e, -pos[i + 5] + a.n, pos[i + 4] + a.h,
    ]);
  }
  return out;
}

function segBox(segs) {
  const b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const s of segs) {
    for (const [x, y] of [[s[0], s[1]], [s[3], s[4]]]) {
      b.minX = Math.min(b.minX, x);
      b.maxX = Math.max(b.maxX, x);
      b.minY = Math.min(b.minY, y);
      b.maxY = Math.max(b.maxY, y);
    }
  }
  return b;
}

function hasEndpoint(segs, x, y, tol) {
  return segs.some((s) => Math.hypot(s[0] - x, s[1] - y) <= tol || Math.hypot(s[3] - x, s[4] - y) <= tol);
}

function fillArea(result, layer) {
  const part = result.parts.find((p) => p.layer.toUpperCase() === layer.toUpperCase());
  if (!part?.fills) return 0;
  const p = part.fills.pos; // escena: x = E, z = −N → el área en planta es la de (x, z)
  let area = 0;
  for (let i = 0; i < p.length; i += 9) {
    area += Math.abs((p[i + 3] - p[i]) * (p[i + 8] - p[i + 2]) - (p[i + 6] - p[i]) * (p[i + 5] - p[i + 2])) / 2;
  }
  return area;
}

const textsOf = (result, layer) => result.parts.find((p) => p.layer.toUpperCase() === layer.toUpperCase())?.texts?.strings || [];

// ---------------------------------------------------------------------------
// DXF sintético con una capa por característica probada
// ---------------------------------------------------------------------------
const g = (code, value) => `${code}\n${value}\n`;

function buildSyntheticDxf() {
  const layerDefs = [
    ['0', 7, 0], ['L_INS', 1, 0], ['L_NEST', 3, 0], ['L_CIRCLE', 5, 0], ['L_HATCH', 5, 0], ['L_ATT', 2, 0],
    ['L_TEXT', 7, 0], ['L_MTEXT', 7, 0], ['L_BULGE', 7, 0], ['L_CIRC2', 7, 0], ['L_SPLINE', 7, 0], ['L_ELL', 7, 0], ['L_DIM', 6, 0],
    ['L_ARC', 7, 0], ['L_COLOR', 7, 0], ['L_PT', 7, 0], ['L_FACE', 4, 0], ['L_SOLID', 3, 0],
    ['FRZ', 5, 1], ['OFF', -2, 0],
  ];
  let s = '';
  s += g(0, 'SECTION') + g(2, 'HEADER') + g(9, '$ACADVER') + g(1, 'AC1015') + g(9, '$INSUNITS') + g(70, 6) + g(0, 'ENDSEC');
  s += g(0, 'SECTION') + g(2, 'TABLES') + g(0, 'TABLE') + g(2, 'LAYER') + g(70, layerDefs.length);
  for (const [name, color, flags] of layerDefs) {
    s += g(0, 'LAYER') + g(2, name) + g(70, flags) + g(62, color) + g(6, 'CONTINUOUS');
  }
  s += g(0, 'ENDTAB') + g(0, 'ENDSEC');

  s += g(0, 'SECTION') + g(2, 'BLOCKS');
  // B1: base (1,1); línea en capa 0 con color PorBloque
  s += g(0, 'BLOCK') + g(8, 0) + g(2, 'B1') + g(70, 0) + g(10, 1) + g(20, 1) + g(30, 0) + g(3, 'B1') + g(1, '');
  s += g(0, 'LINE') + g(8, 0) + g(62, 0) + g(10, 1) + g(20, 1) + g(30, 0) + g(11, 3) + g(21, 1) + g(31, 0);
  s += g(0, 'ENDBLK') + g(8, 0);
  // NEST: INSERT anidado de B1 + círculo
  s += g(0, 'BLOCK') + g(8, 0) + g(2, 'NEST') + g(70, 0) + g(10, 0) + g(20, 0) + g(30, 0) + g(3, 'NEST') + g(1, '');
  s += g(0, 'INSERT') + g(8, 0) + g(2, 'B1') + g(10, 0) + g(20, 0) + g(30, 0);
  s += g(0, 'CIRCLE') + g(8, 0) + g(10, 0) + g(20, 0) + g(30, 0) + g(40, 1);
  s += g(0, 'ENDBLK') + g(8, 0);
  // ATT: definición de atributo + línea
  s += g(0, 'BLOCK') + g(8, 0) + g(2, 'ATT') + g(70, 2) + g(10, 0) + g(20, 0) + g(30, 0) + g(3, 'ATT') + g(1, '');
  s += g(0, 'ATTDEF') + g(5, 'D1') + g(8, 0) + g(10, 0) + g(20, 0) + g(30, 0) + g(40, 1) + g(1, 'DEF') + g(3, 'prompt') + g(2, 'TAG') + g(70, 0);
  s += g(0, 'LINE') + g(8, 0) + g(10, 0) + g(20, 0) + g(30, 0) + g(11, 1) + g(21, 0) + g(31, 0);
  s += g(0, 'ENDBLK') + g(8, 0);
  // *D1: bloque de cota
  s += g(0, 'BLOCK') + g(8, 0) + g(2, '*D1') + g(70, 1) + g(10, 0) + g(20, 0) + g(30, 0) + g(3, '*D1') + g(1, '');
  s += g(0, 'LINE') + g(8, 0) + g(10, 0) + g(20, 0) + g(30, 0) + g(11, 10) + g(21, 0) + g(31, 0);
  s += g(0, 'ENDBLK') + g(8, 0);
  s += g(0, 'ENDSEC');

  s += g(0, 'SECTION') + g(2, 'ENTITIES');
  // 1. INSERT en matriz 2×2, rotado 90°, escala 2, con la línea PorBloque de la capa 0 flotante
  s += g(0, 'INSERT') + g(5, 'E1') + g(8, 'L_INS') + g(2, 'B1') + g(10, 10) + g(20, 20) + g(30, 0)
    + g(41, 2) + g(42, 2) + g(43, 2) + g(50, 90) + g(70, 2) + g(71, 2) + g(44, 5) + g(45, 6);
  // 1b. INSERT anidado
  s += g(0, 'INSERT') + g(5, 'E1B') + g(8, 'L_NEST') + g(2, 'NEST') + g(10, 100) + g(20, 0) + g(30, 0);
  // 2. CIRCLE con extrusión (0,0,-1): el centro (5,5) se refleja en X
  s += g(0, 'CIRCLE') + g(5, 'E2') + g(8, 'L_CIRCLE') + g(10, 5) + g(20, 5) + g(30, 0) + g(40, 1)
    + g(210, 0) + g(220, 0) + g(230, -1);
  // 3. HATCH sólido: cuadrado 4×4 con hueco 1×1 (área 15)
  s += g(0, 'HATCH') + g(5, 'E3') + g(8, 'L_HATCH') + g(10, 0) + g(20, 0) + g(30, 0) + g(210, 0) + g(220, 0) + g(230, 1)
    + g(2, 'SOLID') + g(70, 1) + g(71, 0) + g(91, 2)
    + g(92, 3) + g(72, 0) + g(73, 1) + g(93, 4)
    + g(10, 100) + g(20, 100) + g(10, 104) + g(20, 100) + g(10, 104) + g(20, 104) + g(10, 100) + g(20, 104) + g(97, 0)
    + g(92, 2) + g(72, 0) + g(73, 1) + g(93, 4)
    + g(10, 101) + g(20, 101) + g(10, 102) + g(20, 101) + g(10, 102) + g(20, 102) + g(10, 101) + g(20, 102) + g(97, 0)
    + g(75, 0) + g(76, 1) + g(98, 1) + g(10, 0) + g(20, 0);
  // 4. INSERT con ATTRIB
  s += g(0, 'INSERT') + g(5, 'E4') + g(8, 'L_ATT') + g(66, 1) + g(2, 'ATT') + g(10, 50) + g(20, 50) + g(30, 0);
  s += g(0, 'ATTRIB') + g(5, 'E5') + g(8, 'L_ATT') + g(10, 50) + g(20, 50) + g(30, 0) + g(40, 0.5) + g(1, 'VALOR-1') + g(2, 'TAG') + g(70, 0);
  s += g(0, 'SEQEND') + g(8, 'L_ATT');
  // 5. TEXT con tilde
  s += g(0, 'TEXT') + g(5, 'E6') + g(8, 'L_TEXT') + g(10, 0) + g(20, 0) + g(30, 0) + g(40, 1) + g(1, 'Ubicación %%c20 %%d') + g(50, 0);
  // 6. MTEXT con códigos de formato
  s += g(0, 'MTEXT') + g(5, 'E7') + g(8, 'L_MTEXT') + g(10, 0) + g(20, -5) + g(30, 0) + g(40, 1) + g(71, 5)
    + g(1, '{\\fArial|b1;Hola}\\PMundo \\S1/2;') + g(50, 0);
  // 7. LWPOLYLINE con bulge 1 (semicírculo por debajo)
  s += g(0, 'LWPOLYLINE') + g(5, 'E8') + g(8, 'L_BULGE') + g(90, 2) + g(70, 0)
    + g(10, 0) + g(20, 0) + g(42, 1) + g(10, 2) + g(20, 0);
  // 7b. Círculo como polilínea cerrada de 2 vértices con bulge 1 en ambos
  s += g(0, 'LWPOLYLINE') + g(5, 'E8B') + g(8, 'L_CIRC2') + g(90, 2) + g(70, 1)
    + g(10, 0) + g(20, 0) + g(42, 1) + g(10, 2) + g(20, 0) + g(42, 1);
  // 8. SPLINE cuadrática (Bézier) de puntos de control (0,0) (1,2) (2,0)
  s += g(0, 'SPLINE') + g(5, 'E9') + g(8, 'L_SPLINE') + g(70, 8) + g(71, 2) + g(72, 6) + g(73, 3) + g(74, 0);
  for (const k of [0, 0, 0, 1, 1, 1]) s += g(40, k);
  s += g(10, 0) + g(20, 0) + g(30, 0) + g(10, 1) + g(20, 2) + g(30, 0) + g(10, 2) + g(20, 0) + g(30, 0);
  // 9. ELLIPSE completa
  s += g(0, 'ELLIPSE') + g(5, 'EA') + g(8, 'L_ELL') + g(10, 0) + g(20, 0) + g(30, 0) + g(11, 4) + g(21, 0) + g(31, 0)
    + g(40, 0.5) + g(41, 0) + g(42, 6.283185307179586) + g(210, 0) + g(220, 0) + g(230, 1);
  // 10. DIMENSION (vía su bloque)
  s += g(0, 'DIMENSION') + g(5, 'EB') + g(8, 'L_DIM') + g(2, '*D1') + g(10, 0) + g(20, 0) + g(30, 0) + g(11, 5) + g(21, 1) + g(31, 0)
    + g(70, 1) + g(71, 5) + g(13, 0) + g(23, 0) + g(33, 0) + g(14, 10) + g(24, 0) + g(34, 0);
  // 11. Capas congelada y apagada
  s += g(0, 'LINE') + g(5, 'EC') + g(8, 'FRZ') + g(10, 0) + g(20, 0) + g(30, 0) + g(11, 1) + g(21, 1) + g(31, 0);
  s += g(0, 'LINE') + g(5, 'ED') + g(8, 'OFF') + g(10, 0) + g(20, 0) + g(30, 0) + g(11, 1) + g(21, 2) + g(31, 0);
  // 12. ARC que cruza el eje X (350° → 10°)
  s += g(0, 'ARC') + g(5, 'EE') + g(8, 'L_ARC') + g(10, 0) + g(20, 0) + g(30, 0) + g(40, 3) + g(50, 350) + g(51, 10);
  // 13. Color verdadero rojo y ACI 7 / ACI 5
  s += g(0, 'LINE') + g(5, 'EF') + g(8, 'L_COLOR') + g(62, 5) + g(420, 16711680) + g(10, 0) + g(20, 0) + g(30, 0) + g(11, 1) + g(21, 0) + g(31, 0);
  s += g(0, 'LINE') + g(5, 'F0') + g(8, 'L_COLOR') + g(62, 7) + g(10, 0) + g(20, 1) + g(30, 0) + g(11, 1) + g(21, 1) + g(31, 0);
  s += g(0, 'LINE') + g(5, 'F1') + g(8, 'L_COLOR') + g(62, 5) + g(10, 0) + g(20, 2) + g(30, 0) + g(11, 1) + g(21, 2) + g(31, 0);
  // 14. POINT
  s += g(0, 'POINT') + g(5, 'F2') + g(8, 'L_PT') + g(10, 30) + g(20, 30) + g(30, 0);
  // 15. 3DFACE (triángulo con Z) y SOLID con el orden "bowtie" 1,2,4,3
  s += g(0, '3DFACE') + g(5, 'F3') + g(8, 'L_FACE') + g(10, 0) + g(20, 0) + g(30, 0) + g(11, 4) + g(21, 0) + g(31, 0)
    + g(12, 0) + g(22, 3) + g(32, 2) + g(13, 0) + g(23, 3) + g(33, 2);
  s += g(0, 'SOLID') + g(5, 'F4') + g(8, 'L_SOLID') + g(10, 0) + g(20, 0) + g(30, 0) + g(11, 2) + g(21, 0) + g(31, 0)
    + g(12, 0) + g(22, 2) + g(32, 0) + g(13, 2) + g(23, 2) + g(33, 0);
  s += g(0, 'ENDSEC') + g(0, 'EOF');
  return s;
}

// ---------------------------------------------------------------------------
// PARTE A: Node
// ---------------------------------------------------------------------------
console.log('Prueba del módulo CAD');
console.log('Parte A: lógica pura y normalización (Node)');

const aci = await imp('aci.js');
const unitsMod = await imp('units.js');
const matMod = await imp('mat.js');
const curves = await imp('curves.js');
const textFmt = await imp('textFormat.js');
const builder = await imp('geometryBuilder.js');
const proc = await imp('processCad.js');

await step('Colores ACI: paleta, blanco/negro → #2B2B2B', async () => {
  assert(aci.ACI_RGB.length === 256, 'la paleta debe tener 256 entradas');
  assert(aci.aciToRgb(1) === 0xff0000 && aci.aciToRgb(3) === 0x00ff00 && aci.aciToRgb(5) === 0x0000ff, 'ACI 1/3/5');
  assert(aci.aciToRgb(0) === null && aci.aciToRgb(256) === null, 'ACI 0 y 256 no son colores');
  assert(aci.inkForLightBackground(aci.aciToRgb(7)) === 0x2b2b2b, 'ACI 7 → #2B2B2B');
  assert(aci.inkForLightBackground(0x000000) === 0x2b2b2b, 'negro → #2B2B2B');
  assert(aci.inkForLightBackground(0xff0000) === 0xff0000, 'el rojo se respeta');
  assert(aci.rgbToHex(0x2b2b2b) === '#2b2b2b', 'rgbToHex');
});

await step('Unidades: $INSUNITS y sobrescritura', async () => {
  const U = unitsMod.resolveUnits;
  near(U(1).unitScale, 0.0254, 1e-12, 'pulgadas');
  near(U(2).unitScale, 0.3048, 1e-12, 'pies');
  near(U(4).unitScale, 0.001, 1e-12, 'mm');
  near(U(5).unitScale, 0.01, 1e-12, 'cm');
  near(U(6).unitScale, 1, 1e-12, 'm');
  assert(U(0).units === 'm' && U(0).unitScale === 1, 'sin unidad → metros');
  assert(U(undefined).units === 'm', 'ausente → metros');
  const o = U(4, 'cm');
  assert(o.units === 'cm' && o.unitScale === 0.01 && o.source === 'override', 'la sobrescritura gana al encabezado');
  assert(U(4, 'auto').units === 'mm', "'auto' usa el encabezado");
});

await step('OCS: extrusión (0,0,-1) refleja X', async () => {
  const { ax, ay, az } = matMod.ocsAxes([0, 0, -1]);
  assert(ax[0] === -1 && ax[1] === 0 && ay[1] === 1 && az[2] === -1, `ejes ${JSON.stringify({ ax, ay, az })}`);
  const m = matMod.matOcs([0, 0, -1]);
  const out = matMod.matApply(m, 5, 5, 0, [0, 0, 0]);
  assert(out[0] === -5 && out[1] === 5, `(5,5) → (${out})`);
  assert(matMod.isDefaultExtrusion([0, 0, 0]) && matMod.isDefaultExtrusion([0, 0, 1]) && !matMod.isDefaultExtrusion([0, 0, -1]), 'extrusión por defecto');
});

await step('Teselado: arcos, bulge, elipse y spline de de Boor', async () => {
  // Semicírculo por bulge = 1 de (0,0) a (2,0): pasa por (1,-1)
  const pts = [0, 0, 0];
  curves.appendBulgeSegment(pts, 0, 0, 0, 2, 0, 0, 1);
  let minY = 0;
  for (let i = 1; i < pts.length; i += 3) minY = Math.min(minY, pts[i]);
  near(minY, -1, 1e-6, 'flecha del semicírculo');
  near(pts[pts.length - 3], 2, 1e-12, 'termina en el punto final');
  // Todos los puntos del arco están a distancia 1 del centro (1,0)
  for (let i = 0; i < pts.length; i += 3) near(Math.hypot(pts[i] - 1, pts[i + 1]), 1, 1e-9, 'radio del bulge');
  // Arco 350° → 10° barre 20°
  const arc = curves.arcPoints(0, 0, 0, 3, (350 * Math.PI) / 180, (10 * Math.PI) / 180);
  near(arc[0], 3 * Math.cos((350 * Math.PI) / 180), 1e-9, 'inicio del arco');
  near(arc[arc.length - 3], 3 * Math.cos((10 * Math.PI) / 180), 1e-9, 'fin del arco');
  near(curves.arcSweep(6.1, 0.2), 0.2 + 2 * Math.PI - 6.1, 1e-9, 'barrido que cruza 0');
  // Elipse completa
  const el = curves.ellipsePoints([0, 0, 0], [4, 0, 0], [0, 0, 1], 0.5, 0, 2 * Math.PI);
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < el.length; i += 3) {
    maxX = Math.max(maxX, el[i]);
    maxY = Math.max(maxY, el[i + 1]);
  }
  near(maxX, 4, 1e-6, 'semieje mayor');
  near(maxY, 2, 1e-2, 'semieje menor');
  // B-spline cuadrática = Bézier: en u=0.5 pasa por (1,1)
  const sp = curves.bsplinePoints({ degree: 2, knots: [0, 0, 0, 1, 1, 1], ctrl: [0, 0, 0, 1, 2, 0, 2, 0, 0] });
  let found = false;
  for (let i = 0; i < sp.length; i += 3) if (Math.hypot(sp[i] - 1, sp[i + 1] - 1) < 1e-9) found = true;
  assert(found, 'la spline debe pasar por (1,1)');
  near(sp[0], 0, 1e-12, 'inicio de la spline');
  near(sp[sp.length - 3], 2, 1e-12, 'fin de la spline');
  // Spline cúbica con puntos de ajuste solamente (respaldo): pasa por los puntos dados
  const fit = curves.splinePoints({ degree: 3, knots: [], ctrl: [], fit: [0, 0, 0, 1, 1, 0, 2, 0, 0, 3, 1, 0] });
  assert(fit.length > 12, 'la interpolación debe generar más puntos que los de ajuste');
  let hits = 0;
  for (const [x, y] of [[0, 0], [1, 1], [2, 0], [3, 1]]) {
    for (let i = 0; i < fit.length; i += 3) if (Math.hypot(fit[i] - x, fit[i + 1] - y) < 1e-9) { hits++; break; }
  }
  assert(hits === 4, `la spline de ajuste debe pasar por sus puntos (${hits}/4)`);
});

await step('MTEXT y TEXT: códigos de formato', async () => {
  const P = textFmt.parseMtext;
  assert(P('{\\fArial|b1;Hola}\\PMundo').text === 'Hola\nMundo', 'fuente + salto de párrafo');
  assert(P('\\A1;\\H2.5;\\C1;Texto\\~duro').text === 'Texto duro', 'alineación, altura, color y espacio duro');
  assert(P('\\S1/2;').text === '1/2' && P('\\S3^4;').text === '3 4', 'fracciones apiladas');
  assert(P('\\U+00F3 \\\\ \\{').text === 'ó \\ {', 'unicode y escapes');
  assert(P('A\\P\\PB').lines.length === 3, 'varias líneas');
  assert(P('\\Lsub\\l y \\Osobre\\o').text === 'sub y sobre', 'subrayado/sobrerrayado descartados');
  assert(textFmt.cleanPlainText('%%c20 %%d %%p 5%%%') === 'Ø20 ° ± 5%', 'códigos %% de TEXT');
  assert(textFmt.cleanPlainText('Ubicaci\\U+00F3n') === 'Ubicación', '\\U+ en TEXT');
});

await step('Recorte de orejas de respaldo: área exacta de un polígono cóncavo', async () => {
  const poly = [[0, 0], [4, 0], [4, 4], [2, 1], [0, 4]].map(([x, y]) => ({ x, y }));
  const tris = builder.earClipTriangulate(poly);
  let area = 0;
  for (const [a, b, c] of tris) {
    area += Math.abs((poly[b].x - poly[a].x) * (poly[c].y - poly[a].y) - (poly[c].x - poly[a].x) * (poly[b].y - poly[a].y)) / 2;
  }
  near(area, 10, 1e-9, 'área del polígono en L');
});

await step('Decodificación de DXF: UTF-8 y página de códigos cp1252', async () => {
  const utf8 = Buffer.from(g(0, 'SECTION') + g(2, 'ENTITIES') + g(1, 'Ubicación'), 'utf8');
  assert(proc.decodeDxf(new Uint8Array(utf8)).includes('Ubicación'), 'UTF-8');
  const head = g(0, 'SECTION') + g(2, 'HEADER') + g(9, '$DWGCODEPAGE') + g(3, 'ANSI_1252') + g(0, 'ENDSEC') + g(1, 'Ubicación');
  const latin = Buffer.from(head, 'latin1'); // 0xF3 aislado: no es UTF-8 válido
  assert(proc.decodeDxf(new Uint8Array(latin)).includes('Ubicación'), 'cp1252');
  assert(proc.sniffFormat(new Uint8Array([0x41, 0x43, 0x31, 0x30, 0x33, 0x32, 0, 0])) === 'dwg', 'sniff DWG');
  assert(proc.sniffFormat(new Uint8Array(Buffer.from('  0\nSECTION\n'))) === 'dxf', 'sniff DXF');
});

// --- DXF sintético ---
let synth = null;
await step('DXF sintético: procesa todas las entidades sin errores', async () => {
  const text = buildSyntheticDxf();
  synth = await proc.processCad(toArrayBuffer(Buffer.from(text, 'utf8')), { kind: 'dxf', loaders });
  assert(synth.units === 'm' && synth.unitScale === 1, 'unidades m');
  assert(synth.stats.entities === 26, `entidades procesadas: ${synth.stats.entities} (se esperaban 26)`);
  const names = synth.layers.map((l) => l.name);
  for (const n of ['L_INS', 'L_NEST', 'L_CIRCLE', 'L_HATCH', 'L_ATT', 'L_TEXT', 'FRZ', 'OFF']) assert(names.includes(n), `falta la capa ${n}`);
});

await step('INSERT: matriz 2×2, rotación 90°, escala 2, punto base, capa 0 flotante y PorBloque', async () => {
  const segs = mapSegments(synth, 'L_INS');
  assert(segs.length === 4, `4 instancias esperadas, hay ${segs.length}`);
  // Origen de cada instancia: (10 − 6r, 20 + 5c); la línea (1,1)-(3,1) → vertical de longitud 4
  for (const [r, c] of [[0, 0], [0, 1], [1, 0], [1, 1]]) {
    const x = 10 - 6 * r;
    const y = 20 + 5 * c;
    const ok = segs.some((s) => Math.hypot(s[0] - x, s[1] - y) < 1e-4 && Math.hypot(s[3] - x, s[4] - (y + 4)) < 1e-4);
    assert(ok, `falta la instancia fila ${r}, columna ${c} en (${x}, ${y})`);
  }
  const part = synth.parts.find((p) => p.layer === 'L_INS');
  assert(part.lines.col[0] === 255 && part.lines.col[1] === 0 && part.lines.col[2] === 0, 'PorBloque hereda el rojo de la capa L_INS');
  assert(synth.layers.find((l) => l.name === 'L_INS').count === 4, 'cuenta de entidades expandidas');
});

await step('INSERT anidado: NEST → B1 + círculo', async () => {
  const segs = mapSegments(synth, 'L_NEST');
  const box = segBox(segs);
  assert(hasEndpoint(segs, 100, 0, 1e-4) && hasEndpoint(segs, 102, 0, 1e-4), 'la línea del bloque anidado va de (100,0) a (102,0)');
  near(box.minX, 99, 1e-3, 'círculo: xmin');
  near(box.maxX, 102, 1e-3, 'xmax (línea anidada)');
});

await step('CIRCLE con extrusión (0,0,-1): centro reflejado en X', async () => {
  const box = segBox(mapSegments(synth, 'L_CIRCLE'));
  near((box.minX + box.maxX) / 2, -5, 1e-3, 'centro X reflejado');
  near((box.minY + box.maxY) / 2, 5, 1e-3, 'centro Y');
  near(box.maxX - box.minX, 2, 1e-2, 'diámetro');
});

await step('HATCH sólido con hueco: relleno triangulado de área 15', async () => {
  near(fillArea(synth, 'L_HATCH'), 15, 1e-3, 'área del relleno');
  const segs = mapSegments(synth, 'L_HATCH');
  assert(segs.length === 8, `contornos: 2 lazos × 4 lados (hay ${segs.length})`);
});

await step('ATTRIB colgando de su INSERT', async () => {
  assert(textsOf(synth, 'L_ATT').includes('VALOR-1'), `textos de L_ATT: ${JSON.stringify(textsOf(synth, 'L_ATT'))}`);
  assert(!textsOf(synth, 'L_ATT').includes('DEF'), 'ATTDEF no se dibuja');
});

await step('TEXT con tilde y MTEXT con formato', async () => {
  assert(textsOf(synth, 'L_TEXT')[0] === 'Ubicación Ø20 °', `TEXT: ${JSON.stringify(textsOf(synth, 'L_TEXT'))}`);
  assert(textsOf(synth, 'L_MTEXT')[0] === 'Hola\nMundo 1/2', `MTEXT: ${JSON.stringify(textsOf(synth, 'L_MTEXT'))}`);
  const rec = synth.parts.find((p) => p.layer === 'L_MTEXT').texts.data;
  assert(rec[11] === 1 && rec[12] === 2, 'MTEXT centro-medio (attach 5) → ha=1, va=2');
});

await step('LWPOLYLINE con bulge, SPLINE, ELLIPSE y ARC', async () => {
  near(segBox(mapSegments(synth, 'L_BULGE')).minY, -1, 1e-3, 'flecha del bulge');
  const c2 = segBox(mapSegments(synth, 'L_CIRC2'));
  near(c2.minY, -1, 1e-3, 'polilínea cerrada de 2 vértices: abajo');
  near(c2.maxY, 1, 1e-3, 'polilínea cerrada de 2 vértices: arriba (el tramo de cierre con bulge)');
  const sp = mapSegments(synth, 'L_SPLINE');
  assert(hasEndpoint(sp, 1, 1, 1e-6), 'la spline pasa por (1,1)');
  const eb = segBox(mapSegments(synth, 'L_ELL'));
  near(eb.maxX - eb.minX, 8, 1e-3, 'ancho de la elipse');
  near(eb.maxY - eb.minY, 4, 5e-2, 'alto de la elipse');
  const ab = segBox(mapSegments(synth, 'L_ARC'));
  assert(ab.minX > 2.9 && ab.maxX < 3.001, `arco 350°→10°: x ∈ [${ab.minX}, ${ab.maxX}]`);
  assert(ab.minY < -0.5 && ab.maxY > 0.5, 'el arco cruza el eje X');
});

await step('DIMENSION (vía su bloque), POINT, 3DFACE y SOLID', async () => {
  const dim = mapSegments(synth, 'L_DIM');
  assert(hasEndpoint(dim, 0, 0, 1e-6) && hasEndpoint(dim, 10, 0, 1e-6), 'la cota expande su bloque *D1');
  const pt = segBox(mapSegments(synth, 'L_PT'));
  near((pt.minX + pt.maxX) / 2, 30, 1e-6, 'cruz del POINT centrada');
  assert(pt.maxX - pt.minX > 0.05 && pt.maxX - pt.minX < 1, 'la cruz es pequeña');
  assert(fillArea(synth, 'L_FACE') > 0, '3DFACE rellena');
  assert(mapSegments(synth, 'L_FACE').some((s) => Math.abs(s[2] - 2) < 1e-6 || Math.abs(s[5] - 2) < 1e-6), '3DFACE conserva la Z');
  // SOLID bowtie 1,2,4,3 → cuadrado 2×2 (área 4)
  near(fillArea(synth, 'L_SOLID'), 4, 1e-4, 'área del SOLID');
});

await step('Colores: verdadero, ACI 7 → #2B2B2B y ACI 5; capas apagadas/congeladas marcadas', async () => {
  const part = synth.parts.find((p) => p.layer === 'L_COLOR').lines;
  const col = (i) => [part.col[i * 6], part.col[i * 6 + 1], part.col[i * 6 + 2]];
  const segs = mapSegments(synth, 'L_COLOR');
  const colorOfY = (y) => col(segs.findIndex((s) => Math.abs(s[1] - y) < 1e-6));
  assert(colorOfY(0).join() === '255,0,0', `color verdadero rojo, obtenido ${colorOfY(0)}`);
  assert(colorOfY(1).join() === '43,43,43', `ACI 7 → #2B2B2B, obtenido ${colorOfY(1)}`);
  assert(colorOfY(2).join() === '0,0,255', `ACI 5 azul, obtenido ${colorOfY(2)}`);
  assert(synth.layers.find((l) => l.name === 'FRZ').hidden === true, 'capa congelada → hidden');
  assert(synth.layers.find((l) => l.name === 'OFF').hidden === true, 'capa apagada → hidden');
  assert(synth.layers.find((l) => l.name === 'L_INS').hidden === false, 'capa normal visible');
});

await step('Georreferencia del DXF sintético: ancla local, no georreferenciado', async () => {
  assert(Math.abs(synth.anchor.e) < 10000 && Math.abs(synth.anchor.n) < 10000, 'coordenadas locales');
  assert(synth.flat === !synth.hasZ, 'bandera flat coherente');
  assert(synth.hasZ === true, '3DFACE con Z → el dibujo tiene Z');
});

// --- Fixture georreferenciado ---
const fixtures = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'fixtures.json'), 'utf8'));
let planta = null;
await step('planta_georef.dxf: unidades m, capas y georreferencia', async () => {
  const buf = fs.readFileSync(path.join(FIXTURES, 'planta_georef.dxf'));
  planta = await proc.processCad(toArrayBuffer(buf), { kind: 'dxf', loaders });
  assert(planta.units === 'm' && planta.unitScale === 1 && planta.unitsSource === 'header', `unidades ${planta.units} (${planta.unitsSource})`);
  const names = planta.layers.map((l) => l.name);
  for (const n of ['MUROS', 'EJES', 'LOTE', 'TEXTOS', 'ARBOLES', 'MOBILIARIO']) assert(names.includes(n), `falta la capa ${n} (hay ${names})`);
  assert(Math.abs(planta.anchor.e) > 10000 && Math.abs(planta.anchor.n) > 10000, `ancla UTM ${JSON.stringify(planta.anchor)}`);
  assert(Number.isInteger(planta.anchor.e) && Number.isInteger(planta.anchor.n), 'ancla redondeada');
  // Ancla = centro de la caja REAL (EXTMIN/EXTMAX del archivo son 1e20 y se ignoran)
  near(planta.anchor.e, (planta.extents.min.e + planta.extents.max.e) / 2, 0.5, 'ancla E = centro de la caja');
  near(planta.anchor.n, (planta.extents.min.n + planta.extents.max.n) / 2, 0.5, 'ancla N = centro de la caja');
  assert(planta.flat === true && planta.hasZ === false, 'plano 2D sin Z');
});

await step('Huella de MUROS contiene las esquinas del IFC (≤ 1 mm)', async () => {
  const segs = mapSegments(planta, 'MUROS');
  assert(segs.length >= 8, `segmentos de MUROS: ${segs.length}`);
  for (const [name, [e, n]] of Object.entries(fixtures.buildingCornersMap)) {
    assert(hasEndpoint(segs, e, n, 0.001), `esquina ${name} (${e}, ${n}) no está en MUROS a 1 mm`);
  }
});

await step('INSERT de ARBOL expandido 4 veces, con su escala 1,2', async () => {
  const { ir } = await proc.parseToIr(toArrayBuffer(fs.readFileSync(path.join(FIXTURES, 'planta_georef.dxf'))), { kind: 'dxf', loaders });
  const inserts = ir.entities.filter((e) => e.t === 'INSERT' && e.name === 'ARBOL');
  assert(inserts.length === 4, `INSERT de ARBOL: ${inserts.length}`);
  assert(planta.stats.blockRefs === 4, `bloques expandidos: ${planta.stats.blockRefs}`);
  assert(planta.layers.find((l) => l.name === 'ARBOLES').count === 12, 'círculo + 2 líneas por árbol = 12 entidades');
  const segs = mapSegments(planta, 'ARBOLES');
  for (const ins of inserts) {
    const [x, y] = ins.p;
    // Línea horizontal del bloque (−1,0)-(1,0) × 1,2 centrada en el punto de inserción (con la rotación del plano)
    const ok = segs.some((s) => Math.hypot((s[0] + s[3]) / 2 - x, (s[1] + s[4]) / 2 - y) < 1e-3
      && Math.abs(Math.hypot(s[3] - s[0], s[4] - s[1]) - 2.4) < 1e-3);
    assert(ok, `no se encontró la cruz del árbol en (${x}, ${y})`);
  }
});

await step('Texto "LOTE 01 - Planta de Ubicación" con tilde, sobre la capa TEXTOS', async () => {
  const t = textsOf(planta, 'TEXTOS');
  assert(t.includes('LOTE 01 - Planta de Ubicación'), `textos: ${JSON.stringify(t)}`);
  assert(t.length === 8 && ['1', '2', '3', '4', 'A', 'B', 'C'].every((x) => t.includes(x)), 'ejes numerados y lettered');
  const data = planta.parts.find((p) => p.layer === 'TEXTOS').texts.data;
  const idx = t.indexOf('LOTE 01 - Planta de Ubicación');
  near(data[idx * 19 + 9], 0.8, 1e-6, 'altura del texto');
});

await step('Lote con arco (bulge) teselado y relleno ausente', async () => {
  const segs = mapSegments(planta, 'LOTE');
  assert(segs.length > 8, `LOTE debe tener un arco teselado (${segs.length} segmentos)`);
  assert(!planta.parts.find((p) => p.layer === 'LOTE').fills, 'sin rellenos');
});

await step('Sobrescritura de unidades (cm): escala y ancla', async () => {
  const buf = fs.readFileSync(path.join(FIXTURES, 'planta_georef.dxf'));
  const r = await proc.processCad(toArrayBuffer(buf), { kind: 'dxf', units: 'cm', loaders });
  assert(r.units === 'cm' && r.unitScale === 0.01 && r.unitsSource === 'override', 'unidades cm');
  near(r.anchor.e, Math.round(279505 * 0.01), 1, 'ancla E escalada');
});

await step('DXF real (example_2000.dxf, 1,4 MB): unidades mm y carga rápida', async () => {
  const buf = fs.readFileSync(path.join(FIXTURES, 'downloads', 'example_2000.dxf'));
  const t0 = performance.now();
  const r = await proc.processCad(toArrayBuffer(buf), { kind: 'dxf', loaders });
  const ms = performance.now() - t0;
  console.log(`         example_2000.dxf: ${ms.toFixed(0)} ms, ${r.stats.entities} entidades, ${r.stats.segments} segmentos`);
  assert(r.units === 'mm' && r.unitScale === 0.001, 'INSUNITS 4 = mm');
  assert(r.stats.entities > 100 && r.stats.segments > 1000, 'geometría no vacía');
  assert(ms < 4000, `carga lenta: ${ms.toFixed(0)} ms`);
  const names = r.layers.map((l) => l.name);
  assert(names.includes('Tavolo 3') && names.includes('Tavolo 2'), `capas: ${names}`);
  assert(textsOf(r, 'Tavolo 3').some((s) => s.includes('teksto simpla')), 'TEXT presente');
  assert(textsOf(r, 'Tavolo 3').some((s) => s.includes('Teksto granda nur por testi.\nAlia linio.')), 'MTEXT multilínea');
});

await step('DWG con libredwg-web: example_2018.dwg y example_2000.dwg', async () => {
  const outs = {};
  for (const f of ['example_2018.dwg', 'example_2000.dwg']) {
    const buf = fs.readFileSync(path.join(FIXTURES, 'downloads', f));
    const { ir, format } = await proc.parseToIr(toArrayBuffer(buf), { kind: 'dwg', loaders });
    assert(format === 'dwg', 'formato dwg');
    const n = ir.entities.length + Object.values(ir.blocks).reduce((a, b) => a + b.entities.length, 0);
    assert(ir.entities.length > 0 && n > 100, `${f}: entidades normalizadas ${ir.entities.length} (+bloques ${n})`);
    assert(ir.insunits === 4, `${f}: INSUNITS ${ir.insunits}`);
    const r = await proc.processCad(toArrayBuffer(buf), { kind: 'dwg', loaders });
    assert(r.kind === 'dwg' && r.units === 'mm', `${f}: unidades ${r.units}`);
    assert(r.stats.segments > 1000 && r.layers.length >= 3, `${f}: segmentos ${r.stats.segments}, capas ${r.layers.length}`);
    assert(r.layers.map((l) => l.name).includes('Tavolo 3'), `${f}: capa Tavolo 3`);
    assert(r.stats.blockRefs >= 10, `${f}: bloques expandidos ${r.stats.blockRefs}`);
    outs[f] = r;
  }
  // El mismo dibujo en DXF y DWG debe producir geometría equivalente
  const dxf = await proc.processCad(toArrayBuffer(fs.readFileSync(path.join(FIXTURES, 'downloads', 'example_2000.dxf'))), { kind: 'dxf', loaders });
  const dwg = outs['example_2018.dwg'];
  const diff = Math.abs(dxf.stats.segments - dwg.stats.segments) / Math.max(dxf.stats.segments, dwg.stats.segments);
  assert(diff < 0.02, `DXF vs DWG: ${dxf.stats.segments} vs ${dwg.stats.segments} segmentos`);
  near(dxf.anchor.e, dwg.anchor.e, 2, 'ancla E DXF/DWG');
  near(dxf.anchor.n, dwg.anchor.n, 2, 'ancla N DXF/DWG');
});

// No hay ningún DWG georreferenciado en el repositorio y libredwg-web no puede escribir DWG (solo lee y exporta DXF), así que
// "DWG con UTM" se prueba desplazando las entidades del espacio modelo en la base de datos que devuelve el libredwg REAL
// (la lectura binaria del DWG es real; solo se suman E/N a sus coordenadas antes de normalizar).
await step('DWG georreferenciado (UTM): la ruta DWG conserva E/N con error < 1 mm y el ancla cuenta como georreferenciada', async () => {
  const E0 = 279500;
  const N0 = 8661000;
  const real = (await loaders.libreDwg()).lib;
  const { Dwg_File_Type } = await loaders.libreDwg();
  // Solo se conservan los tipos cuyas coordenadas se desplazan por completo (LINE, LWPOLYLINE, ARC, CIRCLE): con el resto
  // (texto, cotas, hatch...) habría puntos sin mover y la extensión mezclaría coordenadas con y sin UTM.
  const KEEP = new Set(['LINE', 'LWPOLYLINE', 'ARC', 'CIRCLE']);
  const SHIFT_POINTS = ['startPoint', 'endPoint', 'center'];
  const moved = (dE, dN) => ({
    libreDwg: async () => ({
      Dwg_File_Type,
      lib: {
        dwg_read_data: (...a) => real.dwg_read_data(...a),
        dwg_free: (...a) => real.dwg_free(...a),
        convert(dwg) {
          const db = real.convert(dwg);
          const sh = (e) => {
            const o = { ...e };
            for (const k of SHIFT_POINTS) if (o[k]) o[k] = { ...o[k], x: o[k].x + dE, y: o[k].y + dN };
            if (o.vertices) o.vertices = o.vertices.map((v) => ({ ...v, x: v.x + dE, y: v.y + dN }));
            return o;
          };
          const tables = {
            ...db.tables,
            BLOCK_RECORD: {
              ...db.tables.BLOCK_RECORD,
              entries: db.tables.BLOCK_RECORD.entries.map((b) => (/^\*Model_Space$/i.test(b.name) ? { ...b, entities: (b.entities || []).filter((e) => KEEP.has(e.type)).map(sh) } : b)),
            },
          };
          return { ...db, tables, entities: [] };
        },
      },
    }),
  });
  const buf = toArrayBuffer(fs.readFileSync(path.join(FIXTURES, 'downloads', 'example_2000.dwg')));
  const zero = await proc.processCad(buf.slice(0), { kind: 'dwg', loaders: { ...loaders, ...moved(0, 0) }, units: 'm' });
  const utm = await proc.processCad(buf.slice(0), { kind: 'dwg', loaders: { ...loaders, ...moved(E0, N0) }, units: 'm' });
  near(utm.extents.min.e - zero.extents.min.e, E0, 0.001, 'desplazamiento E de la extensión');
  near(utm.extents.min.n - zero.extents.min.n, N0, 0.001, 'desplazamiento N de la extensión');
  near(utm.extents.max.e - zero.extents.max.e, E0, 0.001, 'desplazamiento E máximo');
  near(utm.extents.max.n - zero.extents.max.n, N0, 0.001, 'desplazamiento N máximo');
  near(utm.anchor.e - zero.anchor.e, E0, 0.001, 'ancla E');
  near(utm.anchor.n - zero.anchor.n, N0, 0.001, 'ancla N');
  // CadManager marca "georreferenciado" cuando |E| o |N| del ancla supera 10 000 m (GEO_THRESHOLD)
  assert(Math.abs(utm.anchor.e) > 10000 && Math.abs(utm.anchor.n) > 10000, `el ancla UTM ${JSON.stringify(utm.anchor)} debe contar como georreferenciada`);
  assert(!(Math.abs(zero.anchor.e) > 10000 || Math.abs(zero.anchor.n) > 10000), 'el mismo dibujo sin UTM no debe contar como georreferenciado');
  assert(utm.stats.segments === zero.stats.segments, 'el desplazamiento no cambia la cantidad de geometría');
  // Los vértices (en coordenadas de mapa) de una capa con líneas se desplazan exactamente E0/N0
  const layer = utm.layers.find((l) => mapSegments(utm, l.name).length)?.name;
  assert(layer, 'alguna capa con líneas');
  const a = mapSegments(zero, layer);
  const b = mapSegments(utm, layer);
  assert(a.length === b.length && a.length > 0, `segmentos de ${layer}: ${a.length} vs ${b.length}`);
  let dev = 0;
  for (let i = 0; i < a.length; i += 1) {
    dev = Math.max(dev, Math.abs(b[i][0] - a[i][0] - E0), Math.abs(b[i][1] - a[i][1] - N0));
  }
  assert(dev < 0.001, `desviación máxima de vértices ${dev} m`);
});

// DWG REALES con coordenadas UTM (sin desplazar nada en memoria): se generaron con LibreDWG (dxf2dwg, R2000) a partir de
// planta_georef.dxf, uno en metros (INSUNITS=6) y otro en milímetros (INSUNITS=4). Cierran el hueco de la ronda 2: ya hay un
// DWG georreferenciado de verdad en el repositorio.
await step('DWG real georreferenciado (UTM) en m y en mm: misma planta que el DXF (MUROS al milímetro) y unidades por INSUNITS', async () => {
  const dxf = await proc.processCad(toArrayBuffer(fs.readFileSync(path.join(FIXTURES, 'planta_georef.dxf'))), { kind: 'dxf', loaders });
  const ref = mapSegments(dxf, 'MUROS');
  assert(ref.length > 0, 'MUROS en el DXF');
  for (const [file, units] of [['planta_georef_m.dwg', 'm'], ['planta_georef_mm.dwg', 'mm']]) {
    const r = await proc.processCad(toArrayBuffer(fs.readFileSync(path.join(FIXTURES, file))), { kind: 'dwg', loaders });
    assert(r.kind === 'dwg' && r.units === units, `${file}: unidades ${r.units} (esperado ${units})`);
    assert(Math.abs(r.anchor.e) > 10000 && Math.abs(r.anchor.n) > 10000, `${file}: georreferenciado ${JSON.stringify(r.anchor)}`);
    near(r.anchor.e, dxf.anchor.e, 0.001, `${file}: ancla E`);
    near(r.anchor.n, dxf.anchor.n, 0.001, `${file}: ancla N`);
    const got = mapSegments(r, 'MUROS');
    assert(got.length === ref.length, `${file}: segmentos MUROS ${got.length} vs DXF ${ref.length}`);
    let dev = 0;
    for (let i = 0; i < ref.length; i += 1) for (let k = 0; k < 6; k += 1) dev = Math.max(dev, Math.abs(ref[i][k] - got[i][k]));
    assert(dev < 0.001, `${file}: desviación MUROS respecto al DXF ${dev} m`);
    near(r.extents.min.e, dxf.extents.min.e, 0.001, `${file}: extensión E mín`);
    near(r.extents.max.n, dxf.extents.max.n, 0.001, `${file}: extensión N máx`);
  }
});

// Robustez ante un DWG mal formado: la tabla BLOCK_RECORD con DOS registros "*Model_Space" (uno con las entidades y otro
// vacío). Antes solo quedaba el último y el plano fallaba con "no contiene geometría visible" aunque las entidades estaban en el archivo.
await step('DWG con dos registros "*Model_Space" (mal formado): se unen las entidades en vez de quedarse con el último', async () => {
  // a) Archivo REAL generado con LibreDWG (dxf2dwg) a partir de planta_georef.dxf: tiene el registro vacío DESPUÉS del completo
  const buf = toArrayBuffer(fs.readFileSync(path.join(FIXTURES, 'dwg_modelspace_duplicado.dwg')));
  const real = await loaders.libreDwg();
  const db = real.lib.convert(real.lib.dwg_read_data(buf.slice(0), real.Dwg_File_Type.DWG));
  const spaces = db.tables.BLOCK_RECORD.entries.filter((b) => /^\*Model_Space$/i.test(b.name));
  assert(spaces.length === 2 && spaces[0].entities.length > 0 && spaces[1].entities.length === 0, 'el fixture debe tener dos *Model_Space (el último vacío)');
  const r = await proc.processCad(buf.slice(0), { kind: 'dwg', loaders, units: 'm' });
  assert(r.kind === 'dwg' && r.stats.segments > 0, `el DWG mal formado debe cargar geometría (segmentos ${r.stats.segments})`);
  assert(Math.abs(r.anchor.e) > 10000 && Math.abs(r.anchor.n) > 10000, `sigue georreferenciado: ${JSON.stringify(r.anchor)}`);
  const capas = Object.fromEntries(r.layers.map((l) => [l.name, l.count]));
  assert(capas.MUROS === 2 && capas.EJES === 11 && capas.TEXTOS === 8, `capas ${JSON.stringify(capas)}`);
  // Debe coincidir con el mismo plano en DXF (capa MUROS) al milímetro
  const dxf = await proc.processCad(toArrayBuffer(fs.readFileSync(path.join(FIXTURES, 'planta_georef.dxf'))), { kind: 'dxf', loaders });
  const a = mapSegments(dxf, 'MUROS');
  const b = mapSegments(r, 'MUROS');
  assert(a.length > 0 && a.length === b.length, `segmentos MUROS DXF ${a.length} vs DWG ${b.length}`);
  let dev = 0;
  for (let i = 0; i < a.length; i += 1) for (let k = 0; k < 6; k += 1) dev = Math.max(dev, Math.abs(a[i][k] - b[i][k]));
  assert(dev < 0.001, `desviación MUROS DXF/DWG ${dev} m`);

  // b) Variantes sintéticas sobre un DWG real (example_2000.dwg): el resultado debe ser idéntico al del archivo bien formado
  const con = (transform) => ({
    libreDwg: async () => ({
      Dwg_File_Type: real.Dwg_File_Type,
      lib: {
        dwg_read_data: (...x) => real.lib.dwg_read_data(...x),
        dwg_free: (...x) => real.lib.dwg_free(...x),
        convert(dwg) {
          const d = real.lib.convert(dwg);
          const entries = d.tables.BLOCK_RECORD.entries.slice();
          return transform({ ...d, tables: { ...d.tables, BLOCK_RECORD: { ...d.tables.BLOCK_RECORD, entries } } });
        },
      },
    }),
  });
  const ejemplo = toArrayBuffer(fs.readFileSync(path.join(FIXTURES, 'downloads', 'example_2000.dwg')));
  const base = await proc.processCad(ejemplo.slice(0), { kind: 'dwg', loaders, units: 'm' });
  const idx = (d) => d.tables.BLOCK_RECORD.entries.findIndex((b) => /^\*Model_Space$/i.test(b.name));
  const variantes = {
    'registro vacío antes': (d) => { const e = d.tables.BLOCK_RECORD.entries; e.unshift({ ...e[idx(d)], handle: 'ZZ1', entities: [] }); return d; },
    'registro vacío después': (d) => { const e = d.tables.BLOCK_RECORD.entries; e.push({ ...e[idx(d)], handle: 'ZZ2', entities: [] }); return d; },
    'entidades repartidas en dos registros': (d) => {
      const e = d.tables.BLOCK_RECORD.entries;
      const m = e[idx(d)];
      const mitad = Math.floor(m.entities.length / 2);
      e[idx(d)] = { ...m, entities: m.entities.slice(0, mitad) };
      e.push({ ...m, handle: 'ZZ3', entities: m.entities.slice(mitad) });
      return d;
    },
    'mismas entidades en los dos registros (sin duplicar)': (d) => { const e = d.tables.BLOCK_RECORD.entries; e.push({ ...e[idx(d)], handle: 'ZZ4' }); return d; },
    'sin entidades en ningún registro: usa las de la base': (d) => {
      const e = d.tables.BLOCK_RECORD.entries;
      const m = e[idx(d)];
      return { ...d, entities: m.entities, tables: { ...d.tables, BLOCK_RECORD: { ...d.tables.BLOCK_RECORD, entries: e.map((x) => (x === m ? { ...m, entities: [] } : x)) } } };
    },
  };
  for (const [nombre, tr] of Object.entries(variantes)) {
    const v = await proc.processCad(ejemplo.slice(0), { kind: 'dwg', loaders: { ...loaders, ...con(tr) }, units: 'm' });
    assert(v.stats.segments === base.stats.segments, `${nombre}: segmentos ${v.stats.segments} != ${base.stats.segments}`);
    assert(v.layers.length === base.layers.length, `${nombre}: capas ${v.layers.length} != ${base.layers.length}`);
  }
});

await step('libredwg-web no lee DXF: el DXF se procesa con dxf-parser', async () => {
  const { lib, Dwg_File_Type } = await loaders.libreDwg();
  const buf = fs.readFileSync(path.join(FIXTURES, 'planta_georef.dxf'));
  const r = lib.dwg_read_data(toArrayBuffer(buf), Dwg_File_Type.DXF);
  console.log(`         libredwg-web ${r ? 'SÍ' : 'no'} lee DXF (dwg_read_data(DXF) → ${r === undefined ? 'undefined' : r})`);
  assert(!r, 'si una versión nueva lee DXF, conviene reevaluar el camino único de lectura');
});

await step('Errores claros: DXF binario, archivo vacío', async () => {
  let msg = '';
  try {
    await proc.processCad(toArrayBuffer(Buffer.from('AutoCAD Binary DXF\r\n\x1a\x00xxxx')), { kind: 'dxf', loaders });
  } catch (e) {
    msg = e.message;
  }
  assert(/binario/i.test(msg), `mensaje DXF binario: "${msg}"`);
  msg = '';
  try {
    await proc.processCad(toArrayBuffer(Buffer.from(g(0, 'SECTION') + g(2, 'ENTITIES') + g(0, 'ENDSEC') + g(0, 'EOF'))), { kind: 'dxf', loaders });
  } catch (e) {
    msg = e.message;
  }
  assert(/geometr/i.test(msg), `mensaje sin geometría: "${msg}"`);
});

// ---------------------------------------------------------------------------
// PARTE B: navegador
// ---------------------------------------------------------------------------
console.log('Parte B: navegador (Web Worker + three.js en /dev/cad.html)');
const server = await startDevServer(PORT);
const browser = await launchBrowser();
let page = null;
let pageErrors = [];
try {
  const opened = await openPage(browser, `${BASE}/dev/cad.html`, { viewport: { width: 1000, height: 700 } });
  page = opened.page;
  pageErrors = opened.errors;

  await step('Sandbox listo', async () => {
    await page.waitForFunction(() => document.documentElement.dataset.ready === 'true', null, { timeout: 90000 });
  });

  let plantaId = null;
  await step('Carga planta_georef.dxf con Web Worker y se registra en WorldOrigin', async () => {
    const r = await page.evaluate(async () => {
      const s = window.__cadSandbox;
      const m = await s.loadUrl('/fixtures/planta_georef.dxf');
      return {
        id: m.id,
        kind: m.kind,
        units: m.units,
        georef: m.georeferenced,
        elevation: m.elevation,
        anchor: m.anchor,
        layers: s.cad.getLayers(m.id),
        origin: s.viewer.worldOrigin.origin,
        worker: !!s.cad._worker && !s.cad._workerBroken,
        inScene: s.viewer.modelsRoot.children.includes(m.group),
        registered: !!s.viewer.worldOrigin.getAnchor(m.group),
        loadMs: m.loadMs,
        box: (() => {
          const b = s.cad.getBox(m.id);
          return [b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z];
        })(),
        pos: m.group.position.toArray(),
        isCad: s.cad.has(m.id) && s.cad.getModels().length === 1,
      };
    });
    plantaId = r.id;
    assert(r.worker, 'debe usarse el Web Worker');
    assert(r.kind === 'dxf' && r.units === 'm' && r.georef === true, `modelo ${JSON.stringify(r)}`);
    assert(r.elevation === 0, `sin IFC la cota automática es 0 (${r.elevation})`);
    assert(r.inScene && r.registered && r.isCad, 'el grupo debe estar en la escena y registrado');
    assert(r.layers.length === 6 && r.layers.every((l) => /^#[0-9a-f]{6}$/.test(l.color) && l.count > 0), `capas ${JSON.stringify(r.layers)}`);
    assert(r.origin.e === r.anchor.e && r.origin.n === r.anchor.n, 'el origen global adopta el ancla redondeada');
    near(r.pos[0], r.anchor.e - r.origin.e, 1e-9, 'posición X = ancla − origen');
    near(r.pos[2], -(r.anchor.n - r.origin.n), 1e-9, 'posición Z = −(ancla N − origen N)');
    // Caja de escena: la huella mide ~34 × 30 m alrededor del ancla
    near(r.box[3] - r.box[0], planta.extents.max.e - planta.extents.min.e, 1e-3, 'ancho de la caja de escena');
    near(r.box[5] - r.box[2], planta.extents.max.n - planta.extents.min.n, 1e-3, 'fondo de la caja de escena');
    console.log(`         carga en navegador: ${r.loadMs} ms`);
  });

  await step('Render no vacío (líneas coloreadas y texto)', async () => {
    const st = await page.evaluate(() => window.__cadSandbox.pixelStats());
    console.log(`         píxeles ≠ fondo: ${st.nonBackground}, coloreados: ${st.colored}, oscuros: ${st.dark}`);
    assert(st.nonBackground > 2500, `render casi vacío: ${st.nonBackground} píxeles`);
    assert(st.colored > 400, `faltan colores de capa: ${st.colored}`);
    await page.screenshot({ path: path.join(OUTPUT, 'cad-planta.png') });
  });

  await step('Atlas de glifos: tilde dibujada y un quad por glifo', async () => {
    const r = await page.evaluate((id) => {
      const s = window.__cadSandbox;
      const m = s.cad.getModel(id);
      const textObj = m.layerObjects.get('TEXTOS').find((o) => o.userData.cadKind === 'text');
      return {
        ink: s.getAtlasInk('ó'),
        inkE: s.getAtlasInk('E'),
        inkSpace: s.getAtlasInk(' '),
        indexCount: textObj.geometry.index.count,
        hasMap: !!textObj.material.map && textObj.material.map.generateMipmaps === true,
        calls: m.layerObjects.get('TEXTOS').filter((o) => o.userData.cadKind === 'text').length,
      };
    }, plantaId);
    assert(r.ink > 60 && r.inkE > 60, `glifos sin dibujar (ó=${r.ink}, E=${r.inkE})`);
    assert(r.inkSpace === 0, 'el espacio no pinta');
    // 31 glifos visibles: 1 2 3 4 A B C + "LOTE01-PlantadeUbicación" (24)
    assert(r.indexCount === 31 * 6, `quads de texto: ${r.indexCount / 6} (esperados 31)`);
    assert(r.hasMap && r.calls === 1, 'un solo objeto de texto con mipmaps por capa');
  });

  await step('Ocultar capa MUROS cambia la visibilidad y el render', async () => {
    const r = await page.evaluate((id) => {
      const s = window.__cadSandbox;
      const m = s.cad.getModel(id);
      const objs = m.layerObjects.get('MUROS');
      const before = s.pixelStats();
      s.actions.setCadLayerHidden(id, 'MUROS', true);
      const hidden = objs.map((o) => o.visible);
      const after = s.pixelStats();
      const others = m.layerObjects.get('EJES').every((o) => o.visible);
      s.actions.setCadLayerHidden(id, 'MUROS', false);
      const restored = objs.map((o) => o.visible);
      const again = s.pixelStats();
      return { before, after, again, hidden, restored, others, hiddenLayers: s.store.get('cad')[id].hiddenLayers };
    }, plantaId);
    assert(r.hidden.every((v) => v === false) && r.hidden.length > 0, 'los objetos de MUROS deben ocultarse');
    assert(r.others, 'las demás capas siguen visibles');
    assert(r.after.dark < r.before.dark, `píxeles oscuros: ${r.before.dark} → ${r.after.dark}`);
    assert(r.restored.every((v) => v === true), 'al mostrar de nuevo vuelven a ser visibles');
    assert(Math.abs(r.again.dark - r.before.dark) <= 2, 'el render se restituye');
    assert(r.hiddenLayers.length === 0, 'hiddenLayers vacío tras mostrar');
  });

  await step('Cota automática: IFC 150 → 150,02; manual; sin IFC → 0', async () => {
    const r = await page.evaluate((id) => {
      const s = window.__cadSandbox;
      const m = s.cad.getModel(id);
      const wo = s.viewer.worldOrigin;
      const snap = () => ({
        elevation: m.elevation,
        anchorH: wo.getAnchor(m.group).h,
        y: m.group.position.y,
        originH: wo.origin.h,
        extMinH: m.extents.min.h,
        boxY: s.cad.getBox(id).min.y,
      });
      const out = {};
      out.sinIfc = snap();
      s.setIfcElevation(150);
      out.ifc150 = snap();
      s.actions.setCadElevation(id, 152.5);
      out.manual = snap();
      s.actions.setCadElevation(id, null);
      out.auto = snap();
      // Cambia el proveedor sin refrescar y avisa por el bus como lo hace ModelLoader
      s.setIfcElevation(155, { refresh: false });
      out.sinAviso = snap();
      s.bus.emit('model:loaded', { modelId: 'ifc-x', kind: 'ifc' });
      out.conAviso = snap();
      s.setIfcElevation(null, { refresh: false });
      s.bus.emit('model:unloaded', { modelId: 'ifc-x', kind: 'ifc' });
      out.descarga = snap();
      s.setIfcElevation(150);
      return out;
    }, plantaId);
    near(r.sinIfc.elevation, 0, 1e-9, 'sin IFC');
    near(r.ifc150.elevation, 150.02, 1e-9, 'cota IFC 150 + 0,02');
    near(r.ifc150.anchorH, 150.02, 1e-9, 'ancla H registrada');
    near(r.ifc150.extMinH, 150.02, 1e-9, 'extensión con cota');
    near(r.ifc150.y, r.ifc150.anchorH - r.ifc150.originH, 1e-9, 'posición Y del grupo = ancla H − origen H');
    near(r.manual.elevation, 152.5, 1e-9, 'cota manual');
    near(r.manual.anchorH, 152.5, 1e-9, 'ancla con cota manual');
    near(r.auto.elevation, 150.02, 1e-9, 'vuelve a automática');
    near(r.sinAviso.elevation, 150.02, 1e-9, 'sin aviso no se recalcula');
    near(r.conAviso.elevation, 155.02, 1e-9, "el bus 'model:loaded' (ifc) recalcula");
    near(r.descarga.elevation, 0, 1e-9, "el bus 'model:unloaded' recalcula (sin IFC → 0)");
  });

  await step('Visibilidad del modelo (store.models) y capas del archivo', async () => {
    const r = await page.evaluate(async (id) => {
      const s = window.__cadSandbox;
      const m = s.cad.getModel(id);
      s.actions.setModelVisible(id, false);
      const off = m.group.visible;
      s.actions.setModelVisible(id, true);
      const on = m.group.visible;
      return { off, on };
    }, plantaId);
    assert(r.off === false && r.on === true, `visibilidad del grupo ${JSON.stringify(r)}`);
  });

  await step('Capas apagadas/congeladas del archivo → hiddenLayers (source system)', async () => {
    const text = buildSyntheticDxf();
    const r = await page.evaluate(async (dxfText) => {
      const s = window.__cadSandbox;
      const url = URL.createObjectURL(new Blob([dxfText], { type: 'text/plain' }));
      const calls = [];
      const off = s.store.subscribe('cad', (_n, _p, meta) => calls.push(meta.source));
      const m = await s.loadUrl(url, { name: 'sintetico.dxf', kind: 'dxf', id: 'sint' });
      off();
      URL.revokeObjectURL(url);
      const entry = s.store.get('cad')[m.id];
      const vis = (name) => m.layerObjects.get(name)?.every((o) => o.visible);
      // Área del relleno del HATCH (triangulado en el worker con ShapeUtils de three.js)
      const fill = m.layerObjects.get('L_HATCH').find((o) => o.userData.cadKind === 'fill');
      const p = fill.geometry.attributes.position.array;
      let hatchArea = 0;
      for (let i = 0; i < p.length; i += 9) {
        hatchArea += Math.abs((p[i + 3] - p[i]) * (p[i + 8] - p[i + 2]) - (p[i + 6] - p[i]) * (p[i + 5] - p[i + 2])) / 2;
      }
      return {
        hidden: entry.hiddenLayers, elevation: entry.elevation, sources: calls,
        frz: vis('FRZ'), off: vis('OFF'), ins: vis('L_INS'), hasZ: m.hasZ, modelElevation: m.elevation,
        layers: s.cad.getLayers(m.id).map((l) => l.name), hatchArea,
        fillOpacity: fill.material.opacity, fillTransparent: fill.material.transparent, fillDepthWrite: fill.material.depthWrite,
      };
    }, text);
    assert(r.hidden.includes('FRZ') && r.hidden.includes('OFF') && r.hidden.length === 2, `hiddenLayers: ${JSON.stringify(r.hidden)}`);
    assert(r.elevation === null, 'cota null = automática');
    assert(r.sources.includes('system'), `origen de la inicialización: ${r.sources}`);
    assert(r.frz === false && r.off === false && r.ins === true, 'FRZ/OFF ocultas, el resto visible');
    assert(r.hasZ === true && r.modelElevation === 0, `dibujo con Z (3DFACE) → cota 0 aunque haya IFC (${r.modelElevation})`);
    assert(r.layers.includes('L_HATCH'), 'capas listadas');
    near(r.hatchArea, 15, 1e-3, 'área del relleno del HATCH triangulado en el worker');
    assert(r.fillTransparent && r.fillDepthWrite === false && Math.abs(r.fillOpacity - 0.35) < 1e-9, 'relleno semitransparente (0,35) sin escribir profundidad');
    await page.evaluate(() => window.__cadSandbox.cad.unload('sint'));
  });

  await step('Carga example_2018.dwg (libredwg-web WASM en el worker): render no vacío', async () => {
    const r = await page.evaluate(async () => {
      const s = window.__cadSandbox;
      const m = await s.loadUrl('/fixtures/downloads/example_2018.dwg', { id: 'dwg1' });
      const st = s.pixelStats();
      return {
        kind: m.kind, units: m.units, layers: s.cad.getLayers(m.id), stats: m.stats, st, hasZ: m.hasZ,
        elevation: m.elevation, georef: m.georeferenced, loadMs: m.loadMs, ext: m.extents,
      };
    });
    console.log(`         DWG en navegador: ${r.loadMs} ms, ${r.stats.segments} segmentos`);
    assert(r.kind === 'dwg' && r.units === 'mm', `DWG ${r.kind} ${r.units}`);
    assert(r.layers.map((l) => l.name).includes('Tavolo 3'), 'capa Tavolo 3');
    assert(r.stats.entities > 100 && r.stats.segments > 1000, 'geometría del DWG');
    assert(r.st.nonBackground > 150, `render del DWG casi vacío (${r.st.nonBackground})`);
    assert(r.hasZ === true && r.elevation === 0, 'el DWG de ejemplo tiene Z → cota 0 con IFC de 150');
    assert(r.georef === false, 'coordenadas pequeñas: no georreferenciado');
    await page.screenshot({ path: path.join(OUTPUT, 'cad-dwg.png') });
  });

  await step('Respaldo sin Web Worker: el procesamiento se hace en el hilo principal', async () => {
    const r = await page.evaluate(async () => {
      const s = window.__cadSandbox;
      s.cad._workerBroken = true;
      try {
        const m = await s.loadUrl('/fixtures/planta_georef.dxf', { id: 'inline1' });
        return { layers: s.cad.getLayers(m.id).length, segments: m.stats.segments, anchor: m.anchor };
      } finally {
        s.cad._workerBroken = false;
        s.cad.unload('inline1');
      }
    });
    assert(r.layers === 6 && r.segments === 526, `resultado del respaldo ${JSON.stringify(r)}`);
  });

  await step('Varios planos a la vez, unidades sobrescritas (cm) y reproceso', async () => {
    const r = await page.evaluate(async () => {
      const s = window.__cadSandbox;
      const m = await s.loadUrl('/fixtures/planta_georef.dxf', { id: 'cm1', units: 'cm' });
      return { units: m.units, scale: m.unitScale, source: m.unitsSource, n: s.cad.getModels().length, anchorE: m.anchor.e };
    });
    assert(r.units === 'cm' && r.scale === 0.01 && r.source === 'override', `unidades ${JSON.stringify(r)}`);
    assert(r.n === 3, `modelos cargados: ${r.n}`);
    near(r.anchorE, 2795, 1, 'ancla E con cm');
    // Recarga con el mismo id: sustituye al anterior sin duplicar
    const again = await page.evaluate(async () => {
      const s = window.__cadSandbox;
      await s.loadUrl('/fixtures/planta_georef.dxf', { id: 'cm1', units: 'auto' });
      const m = s.cad.getModel('cm1');
      return { n: s.cad.getModels().length, units: m.units, children: s.viewer.modelsRoot.children.length };
    });
    assert(again.n === 3 && again.units === 'm', `recarga ${JSON.stringify(again)}`);
  });

  await step('La carga no congela la interfaz (example_2000.dxf)', async () => {
    const r = await page.evaluate(async () => {
      const s = window.__cadSandbox;
      let last = performance.now();
      let maxGap = 0;
      let stop = false;
      const tick = () => {
        const now = performance.now();
        maxGap = Math.max(maxGap, now - last);
        last = now;
        if (!stop) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      const t0 = performance.now();
      const m = await s.loadUrl('/fixtures/downloads/example_2000.dxf', { id: 'big' });
      const ms = performance.now() - t0;
      stop = true;
      return { ms, maxGap, segments: m.stats.segments };
    });
    console.log(`         example_2000.dxf: ${r.ms.toFixed(0)} ms, mayor pausa del hilo principal ${r.maxGap.toFixed(0)} ms`);
    assert(r.segments > 1000, 'cargado');
    assert(r.ms < 15000, `carga demasiado lenta: ${r.ms.toFixed(0)} ms`);
    assert(r.maxGap < 1500, `el hilo principal se bloqueó ${r.maxGap.toFixed(0)} ms`);
  });

  await step('Composición de texto: alineación, factor de ancho, altura, rotación y MTEXT', async () => {
    const r = await page.evaluate(async () => {
      const { GlyphAtlas } = await import('/js/cad/glyphAtlas.js');
      const atlas = new GlyphAtlas({ anisotropy: 1 });
      // Texto horizontal en escena: U = +X (Este), V = −Z (Norte)
      const rec = (o = {}) => {
        const d = new Float32Array(19);
        const v = {
          px: 0, py: 0, pz: 0, ux: 1, uy: 0, uz: 0, vx: 0, vy: 0, vz: -1, h: 2, wf: 1, ha: 0, va: 0, wrapEm: 0, spacing: 1, rgb: 0xff0000, kind: 0, fitMode: 0, fitLen: 0, ...o,
        };
        [v.px, v.py, v.pz, v.ux, v.uy, v.uz, v.vx, v.vy, v.vz, v.h, v.wf, v.ha, v.va, v.wrapEm, v.spacing, v.rgb, v.kind, v.fitMode, v.fitLen].forEach((x, i) => { d[i] = x; });
        return d;
      };
      // Caja de los vértices de los quads de la capa
      const box = (data, strings) => {
        const l = atlas.layout(data, strings);
        const b = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity, glyphs: l.glyphs, color: [l.color[0], l.color[1], l.color[2]] };
        for (let i = 0; i < l.position.length; i += 3) {
          b.minX = Math.min(b.minX, l.position[i]);
          b.maxX = Math.max(b.maxX, l.position[i]);
          b.minZ = Math.min(b.minZ, l.position[i + 2]);
          b.maxZ = Math.max(b.maxZ, l.position[i + 2]);
        }
        return b;
      };
      const out = {};
      out.left = box(rec({ ha: 0 }), ['AB']);
      out.center = box(rec({ ha: 1 }), ['AB']);
      out.right = box(rec({ ha: 2 }), ['AB']);
      out.wide = box(rec({ ha: 2, wf: 2 }), ['AB']);
      out.tall = box(rec({ ha: 2, h: 4 }), ['AB']);
      out.baseline = box(rec({ va: 0 }), ['A']);
      out.top = box(rec({ va: 3 }), ['A']);
      out.middle = box(rec({ va: 2 }), ['A']);
      out.mtext = box(rec({ kind: 1, va: 3 }), ['A\nA']);
      out.single = box(rec({ kind: 1, va: 3 }), ['A']);
      // Rotado 90° (U = +Z hacia el Sur, V = +X): la altura del texto va ahora a lo largo de X
      out.rot = box(rec({ ux: 0, uy: 0, uz: -1, vx: 1, vy: 0, vz: 0 }), ['AB']);
      out.fit = box(rec({ fitMode: 2, fitLen: 10, h: 1 }), ['AB']);
      out.spaces = atlas.layout(rec(), ['A B  C']).glyphs;
      out.latin = atlas.layout(rec(), ['ñÑáéíóúü°±Ø€']).glyphs;
      out.wrap = atlas.layout(rec({ kind: 1, wrapEm: 3 }), ['AAAA BBBB CCCC']).glyphs;
      out.empty = atlas.layout(rec(), ['   ']);
      atlas.dispose();
      return out;
    });
    const w = (b) => b.maxX - b.minX;
    // ancho de 'AB' en alturas de texto (h = 2): entre ~1 y ~2,2
    const wAB = w(r.left);
    assert(wAB > 2 && wAB < 6, `ancho de "AB": ${wAB}`);
    const shiftC = r.center.minX - r.left.minX;
    const shiftR = r.right.minX - r.left.minX;
    assert(shiftC < 0 && shiftR < 0, 'centrar/derecha desplazan el texto hacia la izquierda del punto');
    near(shiftR, 2 * shiftC, 1e-4, 'derecha = 2 × centro');
    // el desplazamiento del centro es la mitad del avance (w del texto sin márgenes de celda): rango razonable
    assert(Math.abs(shiftC) > 1 && Math.abs(shiftC) < 3, `desplazamiento centrado ${shiftC}`);
    near(r.wide.minX - r.wide.maxX, 2 * (r.right.minX - r.right.maxX), 1e-3, 'factor de ancho 2 duplica el ancho');
    near(w(r.tall) / w(r.right), 2, 1e-3, 'altura 4 duplica el tamaño (proporcional)');
    near(r.top.minZ - r.baseline.minZ, 2, 1e-4, 'va=arriba baja el texto una altura (h = 2)');
    near(r.middle.minZ - r.baseline.minZ, 1, 1e-4, 'va=medio baja media altura');
    near((r.mtext.maxZ - r.mtext.minZ) - (r.single.maxZ - r.single.minZ), 2 * 1.667, 1e-3, 'interlineado MTEXT = 1,667 alturas');
    assert(r.single.glyphs === 1 && r.mtext.glyphs === 2, 'un quad por glifo');
    near(r.rot.maxX - r.rot.minX, r.left.maxZ - r.left.minZ, 1e-4, 'al rotar 90° el alto del texto pasa al eje X');
    // TEXT "ajustado" (fit): el avance del texto se estira a fitLen alturas (h = 1 → 10 unidades)
    const naturalTH = -shiftR / 2; // avance natural en alturas de texto
    near(w(r.fit) / (w(r.left) / 2), 10 / naturalTH, 1e-3, 'factor de ajuste = fitLen / avance natural');
    assert(r.spaces === 3, `los espacios no generan quads (${r.spaces})`);
    assert(r.latin === 12, `Latin-1 y símbolos cp1252 (${r.latin})`);
    assert(r.wrap === 12, `ajuste de línea de MTEXT conserva los glifos (${r.wrap})`);
    assert(r.empty === null, 'texto en blanco no genera malla');
    assert(Math.abs(r.left.color[0] - 1) < 1e-6 && r.left.color[1] === 0, 'color rojo sRGB 255 → lineal 1');
  });

  await step('Descarga: grupo fuera de la escena y desregistrado de WorldOrigin', async () => {
    const r = await page.evaluate(() => {
      const s = window.__cadSandbox;
      const groups = s.cad.getModels().map((m) => m.group);
      const ids = s.cad.getModels().map((m) => m.id);
      for (const id of ids) s.cad.unload(id);
      return {
        remaining: s.cad.getModels().length,
        inScene: groups.some((g) => s.viewer.modelsRoot.children.includes(g)),
        registered: groups.some((g) => s.viewer.worldOrigin.getAnchor(g)),
        origin: s.viewer.worldOrigin.origin,
        has: ids.some((id) => s.cad.has(id)),
        box: ids.map((id) => s.cad.getBox(id)),
        atlas: s.cad._atlas,
      };
    });
    assert(r.remaining === 0 && !r.has, 'todos descargados');
    assert(!r.inScene && !r.registered, 'fuera de la escena y de WorldOrigin');
    assert(r.origin === null, 'sin modelos el origen global se libera');
    assert(r.box.every((b) => b === null), 'getBox devuelve null');
    assert(r.atlas === null, 'el atlas se libera con el último modelo');
  });

  await step('Integración con el Viewer real: encuadre, recorte de sección y cota', async () => {
    const real = await openPage(browser, `${BASE}/dev/cad-viewer.html`, { viewport: { width: 1000, height: 700 } });
    try {
      await real.page.waitForFunction(() => document.documentElement.dataset.ready === 'true', null, { timeout: 90000 });
      const r = await real.page.evaluate(async () => {
        const s = window.__cadViewer;
        const m = await s.loadUrl('/fixtures/planta_georef.dxf', { id: 'real1' });
        await s.viewer.fitAll({ smooth: false });
        await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
        const out = {};
        const box = s.viewer.getVisibleBox(new s.THREE.Box3());
        out.visibleBox = { empty: box.isEmpty(), sx: box.max.x - box.min.x, sz: box.max.z - box.min.z };
        out.full = await s.pixelStats();
        // Plano de sección que recorta la mitad Este del plano (x > centro)
        const c = box.getCenter(new s.THREE.Vector3());
        s.viewer.setClipping('section', [new s.THREE.Plane(new s.THREE.Vector3(-1, 0, 0), c.x)]);
        out.clipped = await s.pixelStats();
        s.viewer.setClipping('section', []);
        // Ocultar una capa cambia la caja visible (traverseVisible) y el render
        s.actions.setCadLayerHidden(m.id, 'LOTE', true);
        const box2 = s.viewer.getVisibleBox(new s.THREE.Box3());
        out.boxAfterHide = { sx: box2.max.x - box2.min.x };
        s.actions.setCadLayerHidden(m.id, 'LOTE', false);
        // Cota automática y rebase: un IFC "virtual" a 150 m
        s.setIfcElevation(150);
        out.elevation = m.elevation;
        out.origin = s.viewer.worldOrigin.origin;
        // Tras subir el plano 150 m se vuelve a encuadrar y debe verse de nuevo
        const before = out.full.colored;
        await s.viewer.fitAll({ smooth: false });
        await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
        out.cameraSane = s.viewer.camera.position.toArray().every(Number.isFinite);
        out.refit = await s.pixelStats();
        out.refit.before = before;
        return out;
      });
      assert(!r.visibleBox.empty, 'el visor ve la geometría CAD');
      assert(r.visibleBox.sx > 30 && r.visibleBox.sx < 40, `ancho de la caja visible: ${r.visibleBox.sx}`);
      assert(r.full.colored > 300, `render con el visor real casi vacío (${r.full.colored} píxeles de color)`);
      assert(r.clipped.colored < r.full.colored * 0.8, `el plano de sección debe recortar el CAD (${r.full.colored} → ${r.clipped.colored})`);
      assert(r.boxAfterHide.sx < r.visibleBox.sx, `ocultar el LOTE reduce la caja visible (${r.visibleBox.sx} → ${r.boxAfterHide.sx})`);
      near(r.elevation, 150.02, 1e-9, 'cota automática con el visor real');
      assert(r.cameraSane && r.origin.e === 279505, 'cámara y origen coherentes');
      assert(r.refit.colored > r.refit.before * 0.6, `tras cambiar la cota y reencuadrar el plano se ve (${r.refit.colored} vs ${r.refit.before})`);
      await real.page.screenshot({ path: path.join(OUTPUT, 'cad-viewer-real.png') });
      assert(real.errors.length === 0, `errores en la página del visor real: ${real.errors.join(' | ')}`);
    } finally {
      await real.context.close();
    }
  });

  await step('Sin errores de consola ni de página', async () => {
    assert(pageErrors.length === 0, `errores: ${pageErrors.join(' | ')}`);
  });
} catch (err) {
  results.push({ name: 'Ejecución de la parte B', ok: false, error: err });
  console.log(`  FALLA  Ejecución de la parte B\n         ${err.stack || err.message}`);
} finally {
  await browser.close().catch(() => {});
  await new Promise((r) => server.close(r));
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} pruebas correctas`);
if (failed.length) {
  console.log('Fallos:');
  for (const f of failed) console.log(` - ${f.name}: ${f.error?.message}`);
}
process.exit(failed.length ? 1 : 0);
