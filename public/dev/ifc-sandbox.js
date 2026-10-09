// Sandbox del módulo IFC: IfcManager real + doble mínimo del Viewer (ver ifc-viewer-double.js).
// Abrir con: node tests/devserver.mjs 8103  ->  http://127.0.0.1:8103/dev/ifc.html
// Parámetros: ?load=/fixtures/edificio_georef_ifc4.ifc,/fixtures/downloads/AC20-FZK-Haus.ifc

import * as THREE from 'three';
import { bus } from '/js/core/events.js';
import { createStore } from '/js/core/store.js';
import { createActions } from '/js/core/actions.js';
import { IfcManager } from '/js/ifc/IfcManager.js';
import { ViewerDouble } from '/dev/ifc-viewer-double.js';

const store = createStore();
const actions = createActions(store);
const viewer = new ViewerDouble(document.getElementById('viewport'), { bus, store });
const ifc = new IfcManager({ viewer, store, bus, actions });

const progressEl = document.getElementById('progress');
const infoEl = document.getElementById('info');
let seq = 0;

// Carga un IFC desde una URL del servidor de desarrollo.
async function loadUrl(url, { id, name, georef = null, fit = true } = {}) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`No se pudo descargar ${url}: ${res.status}`);
  const buf = await res.arrayBuffer();
  const record = {
    id: id || `m${++seq}${Math.random().toString(36).slice(2, 7)}`,
    name: name || url.split('/').pop(),
    kind: 'ifc',
    size: buf.byteLength,
    georef,
    cad: null,
  };
  const t0 = performance.now();
  const model = await ifc.load(record, buf, (phase, p) => {
    progressEl.textContent = `${record.name}: ${phase} ${(p * 100).toFixed(0)}%`;
  });
  progressEl.textContent = `${record.name}: listo (${Math.round(performance.now() - t0)} ms)`;
  if (!store.get('models')[record.id]) store.set('models', { ...store.get('models'), [record.id]: { visible: true } }, { source: 'system' });
  if (fit && ifc.getModels().length === 1) viewer.fitAll();
  return model;
}

store.subscribe('selection', ({ items }) => {
  const first = items[0];
  if (!first) {
    infoEl.textContent = 'Sin selección';
    return;
  }
  const info = ifc.getElementInfo(first.modelId, first.expressId);
  infoEl.textContent = info
    ? `${items.length} seleccionado(s)\n${info.typeLabel}: ${info.name}\nNivel: ${info.storeyName || '—'}\nGlobalId: ${info.globalId}`
    : `${items.length} seleccionado(s)`;
});

// Botonera
const hud = document.getElementById('hud');
function button(label, fn) {
  const b = document.createElement('button');
  b.textContent = label;
  b.addEventListener('click', () => fn(b));
  hud.appendChild(b);
  return b;
}
button('Georef IFC4', () => loadUrl('/fixtures/edificio_georef_ifc4.ifc'));
button('Sitio IFC2x3', () => loadUrl('/fixtures/edificio_site_ifc2x3.ifc'));
button('FZK Haus', () => loadUrl('/fixtures/downloads/AC20-FZK-Haus.ifc'));
button('Ejemplo', () => loadUrl('/fixtures/downloads/example.ifc'));
button('Fantasma', () => actions.setSelectionMode('ghost'));
button('Aislar', () => actions.setSelectionMode('isolate'));
button('Resaltar', () => actions.setSelectionMode('highlight'));
button('Aristas', () => actions.toggleEdges());
button('Espacios', () => actions.toggleSpaces());
button('Ocultar', () => actions.hideSelected());
button('Mostrar todo', () => actions.showAll());
button('Nivel 1 (corte)', () => {
  const s = ifc.getStoreys()[0];
  if (s) actions.setStorey({ modelId: s.modelId, expressId: s.expressId }, 'cut');
});
button('Nivel 2 (corte)', () => {
  const s = ifc.getStoreys()[1];
  if (s) actions.setStorey({ modelId: s.modelId, expressId: s.expressId }, 'cut');
});
button('Nivel 2 (solo)', () => {
  const s = ifc.getStoreys()[1];
  if (s) actions.setStorey({ modelId: s.modelId, expressId: s.expressId }, 'only');
});
button('Sin nivel', () => actions.setStorey(null));
button('Encuadrar', () => viewer.fitAll());

window.__t = { THREE, viewer, store, bus, actions, ifc, loadUrl };

const params = new URLSearchParams(location.search);
const toLoad = (params.get('load') || '').split(',').filter(Boolean);
(async () => {
  for (const url of toLoad) await loadUrl(url);
  requestAnimationFrame(() => requestAnimationFrame(() => { window.__ready = true; }));
})().catch((err) => {
  console.error(err);
  progressEl.textContent = `Error: ${err.message}`;
  window.__ready = true;
});
