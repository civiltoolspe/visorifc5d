// Web Worker de CAD (módulo): parsea DXF/DWG, normaliza y construye los búferes por capa.
// Protocolo:
//   → { id, buffer: ArrayBuffer, kind: 'dxf'|'dwg', units: 'auto'|'mm'|... }
//   ← { type: 'progress', id, phase, p }
//   ← { type: 'done', id, result }        (los búferes viajan transferidos)
//   ← { type: 'error', id, message }

import { processCad } from './processCad.js';
import { collectTransferables } from './geometryBuilder.js';
import { browserLoaders } from './loaders.browser.js';

self.onmessage = async (ev) => {
  const { id, buffer, kind, units } = ev.data || {};
  if (id === undefined) return;
  let lastPhase = '';
  let lastTime = 0;
  const onProgress = (phase, p) => {
    const now = Date.now();
    if (phase === lastPhase && now - lastTime < 80 && p < 1) return;
    lastPhase = phase;
    lastTime = now;
    self.postMessage({ type: 'progress', id, phase, p });
  };
  try {
    const result = await processCad(buffer, { kind, units, loaders: browserLoaders, onProgress });
    self.postMessage({ type: 'done', id, result }, collectTransferables(result));
  } catch (err) {
    self.postMessage({ type: 'error', id, message: err?.message || String(err) });
  }
};
