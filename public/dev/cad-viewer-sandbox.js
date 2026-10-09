// Sandbox CAD con el Viewer real (integración): el mismo CadManager que usará main.js,
// con el store, el bus y las acciones reales. Expone window.__cadViewer para las pruebas.
// Abrir con: node tests/devserver.mjs 8104  →  http://127.0.0.1:8104/dev/cad-viewer.html

import * as THREE from 'three';
import { bus } from '/js/core/events.js';
import { createStore } from '/js/core/store.js';
import { createActions } from '/js/core/actions.js';
import { Viewer } from '/js/viewer/Viewer.js';
import { CadManager } from '/js/cad/CadManager.js';

const store = createStore();
const actions = createActions(store);
const viewer = new Viewer(document.getElementById('viewport'), { bus, store });
const cad = new CadManager({ viewer, store, bus });
let ifcElevation = null;
cad.setElevationProvider(() => ifcElevation);

let seq = 0;
async function loadUrl(url, { name, kind, units = 'auto', id } = {}) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`No se pudo descargar ${url}: ${res.status}`);
  const buffer = await res.arrayBuffer();
  const fileName = name || url.split('/').pop();
  const record = {
    id: id || `cad${++seq}`,
    name: fileName,
    kind: kind || (fileName.toLowerCase().endsWith('.dwg') ? 'dwg' : 'dxf'),
    cad: { units },
  };
  const model = await cad.load(record, buffer);
  bus.emit('model:loaded', { modelId: record.id, kind: record.kind, model });
  return model;
}

// Cuenta píxeles de color saturado (líneas/texto de capa) y oscuros de una captura del visor
async function pixelStats() {
  const url = viewer.screenshot({ mime: 'image/png' });
  const img = new Image();
  img.src = url;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  let colored = 0;
  let dark = 0;
  for (let i = 0; i < d.length; i += 4) {
    const mx = Math.max(d[i], d[i + 1], d[i + 2]);
    const mn = Math.min(d[i], d[i + 1], d[i + 2]);
    if (mx - mn > 60) colored++;
    else if (mx < 110) dark++;
  }
  return { width: c.width, height: c.height, colored, dark };
}

window.__cadViewer = {
  THREE, viewer, store, bus, actions, cad, loadUrl, pixelStats,
  setIfcElevation(v, { refresh = true } = {}) {
    ifcElevation = v;
    if (refresh) cad.refreshElevation();
  },
};
document.documentElement.dataset.ready = 'true';
