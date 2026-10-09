// Integración del módulo IFC con el Viewer real (sin UI). Útil para comprobar el contrato del Viewer.
// Abrir con: node tests/devserver.mjs 8103  ->  http://127.0.0.1:8103/dev/ifc-real.html?load=/fixtures/edificio_georef_ifc4.ifc

import * as THREE from 'three';
import { bus } from '/js/core/events.js';
import { createStore } from '/js/core/store.js';
import { createActions } from '/js/core/actions.js';
import { Viewer } from '/js/viewer/Viewer.js';
import { IfcManager } from '/js/ifc/IfcManager.js';

const store = createStore();
const actions = createActions(store);
const viewer = new Viewer(document.getElementById('viewport'), { bus, store });
const ifc = new IfcManager({ viewer, store, bus, actions });

async function loadUrl(url, { id, name, georef = null, fit = true } = {}) {
  const res = await fetch(url);
  const buf = await res.arrayBuffer();
  const record = { id: id || `m${Math.random().toString(36).slice(2, 8)}`, name: name || url.split('/').pop(), kind: 'ifc', size: buf.byteLength, georef, cad: null };
  const model = await ifc.load(record, buf);
  if (!store.get('models')[record.id]) store.set('models', { ...store.get('models'), [record.id]: { visible: true } }, { source: 'system' });
  if (fit && ifc.getModels().length === 1) viewer.fitAll({ smooth: false });
  return model;
}

window.__t = { THREE, viewer, store, bus, actions, ifc, loadUrl };

const params = new URLSearchParams(location.search);
(async () => {
  for (const url of (params.get('load') || '').split(',').filter(Boolean)) await loadUrl(url);
  requestAnimationFrame(() => requestAnimationFrame(() => { window.__ready = true; }));
})().catch((err) => {
  console.error(err);
  window.__ready = true;
});
