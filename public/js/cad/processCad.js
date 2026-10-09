// Orquestador del procesamiento de un archivo CAD (DXF/DWG) a búferes por capa.
// Módulo puro: no depende del DOM ni de rutas de navegador. Las dependencias de terceros
// (dxf-parser, libredwg-web, triangulador) se inyectan mediante `loaders`:
//
//   loaders = {
//     dxfParser():      Promise<clase DxfParser>,
//     libreDwg():       Promise<{ lib, Dwg_File_Type }>,
//     triangulator():   Promise<(contour:{x,y}[], holes:{x,y}[][]) => number[][]>   (opcional)
//   }
//
// Lo usan el Web Worker (cad.worker.js, con cargadores de navegador) y las pruebas de Node.

import { scanDxf } from './dxfScan.js';
import { normalizeDxf } from './normalizeDxf.js';
import { normalizeDwg } from './normalizeDwg.js';
import { buildGeometry } from './geometryBuilder.js';
import { resolveUnits } from './units.js';

// Detecta el formato por el contenido: los DWG empiezan por "AC10xx"; el resto se trata como DXF.
export function sniffFormat(bytes, hint = null) {
  if (bytes.length >= 6 && bytes[0] === 0x41 && bytes[1] === 0x43 && bytes[2] >= 0x30 && bytes[2] <= 0x39
    && bytes[3] >= 0x30 && bytes[3] <= 0x39) {
    return 'dwg';
  }
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 22));
  if (head.startsWith('AutoCAD Binary DXF')) return 'dxf-binary';
  if (hint === 'dwg' || hint === 'dxf') {
    // Contenido ambiguo: se respeta la indicación del registro
    return hint;
  }
  return 'dxf';
}

const CODEPAGES = {
  ANSI_1250: 'windows-1250',
  ANSI_1251: 'windows-1251',
  ANSI_1252: 'windows-1252',
  ANSI_1253: 'windows-1253',
  ANSI_1254: 'windows-1254',
  ANSI_1255: 'windows-1255',
  ANSI_1256: 'windows-1256',
  ANSI_1257: 'windows-1257',
  ANSI_1258: 'windows-1258',
  ANSI_932: 'shift_jis',
  ANSI_936: 'gbk',
  ANSI_949: 'euc-kr',
  ANSI_950: 'big5',
  DOS437: 'ibm437',
  DOS850: 'ibm850',
  DOS852: 'ibm852',
  LATIN1: 'iso-8859-1',
};

// Decodifica un DXF de texto: UTF-8 (R2007+) y, si no es válido, la página de códigos del archivo.
export function decodeDxf(bytes) {
  let start = 0;
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) start = 3;
  const view = start ? bytes.subarray(start) : bytes;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(view);
  } catch {
    // continúa con la página de códigos
  }
  let label = 'windows-1252';
  const head = new TextDecoder('latin1').decode(view.subarray(0, Math.min(view.length, 20000)));
  const m = /\$DWGCODEPAGE\s*\r?\n\s*3\s*\r?\n\s*([^\r\n]+)/.exec(head);
  if (m) {
    const key = m[1].trim().toUpperCase();
    if (CODEPAGES[key]) label = CODEPAGES[key];
  }
  try {
    return new TextDecoder(label).decode(view);
  } catch {
    return new TextDecoder('latin1').decode(view);
  }
}

// Parsea y normaliza (sin construir geometría). Útil para pruebas.
//  → { ir, format }
export async function parseToIr(buffer, { kind = null, loaders, onProgress } = {}) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const format = sniffFormat(bytes, kind);
  if (format === 'dxf-binary') {
    throw new Error('El DXF binario no está soportado. Guárdalo como DXF de texto (ASCII).');
  }
  onProgress?.('parse', 0.05);

  if (format === 'dwg') {
    const { lib, Dwg_File_Type } = await loaders.libreDwg();
    onProgress?.('parse', 0.2);
    const arrayBuffer = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
      ? bytes.buffer
      : bytes.slice().buffer;
    const dwg = lib.dwg_read_data(arrayBuffer, Dwg_File_Type.DWG);
    if (!dwg) throw new Error('No se pudo leer el DWG (versión no soportada o archivo dañado).');
    let db;
    try {
      db = lib.convert(dwg);
    } finally {
      try {
        lib.dwg_free(dwg);
      } catch {
        // la memoria se libera al terminar el worker
      }
    }
    onProgress?.('parse', 0.6);
    return { ir: normalizeDwg(db), format: 'dwg' };
  }

  const text = decodeDxf(bytes);
  onProgress?.('parse', 0.15);
  const DxfParser = await loaders.dxfParser();
  let dxf;
  try {
    dxf = new DxfParser().parseSync(text);
  } catch (err) {
    throw new Error(`No se pudo leer el DXF: ${err?.message || err}`);
  }
  if (!dxf) throw new Error('No se pudo leer el DXF.');
  onProgress?.('parse', 0.45);
  const scan = scanDxf(text);
  onProgress?.('parse', 0.6);
  return { ir: normalizeDxf(dxf, scan), format: 'dxf' };
}

// Procesamiento completo: bytes → { kind, units, unitScale, unitsSource, insunits, anchor, extents, ... }
//  options: { kind?: 'dxf'|'dwg', units?: 'auto'|'mm'|..., loaders, onProgress }
export async function processCad(buffer, options = {}) {
  const { kind = null, units = 'auto', loaders, onProgress } = options;
  const { ir, format } = await parseToIr(buffer, { kind, loaders, onProgress });
  const resolved = resolveUnits(ir.insunits, units);
  const geometry = await buildGeometry(ir, {
    unitScale: resolved.unitScale,
    getTriangulator: loaders.triangulator ? () => loaders.triangulator() : null,
    onProgress,
  });
  return {
    kind: format,
    version: ir.version,
    insunits: ir.insunits,
    units: resolved.units,
    unitScale: resolved.unitScale,
    unitsSource: resolved.source,
    ...geometry,
  };
}
