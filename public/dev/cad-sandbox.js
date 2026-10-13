// Sandbox del módulo CAD: doble mínimo del Viewer (escena propia + WorldOrigin real +
// add/remove/requestRender) con el store, el bus y las acciones reales.
// Expone window.__cadSandbox para las pruebas E2E.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EventBus } from '/js/core/events.js';
import { createStore } from '/js/core/store.js';
import { createActions } from '/js/core/actions.js';
import { WorldOrigin } from '/js/viewer/WorldOrigin.js';
import { CadManager } from '/js/cad/CadManager.js';

const bus = new EventBus();
const store = createStore();
const actions = createActions(store);

// ---------------------------------------------------------------------------
// Doble mínimo del Viewer
// ---------------------------------------------------------------------------
const container = document.getElementById('viewport');
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.setClearColor(0xf3f3f2, 1);
renderer.localClippingEnabled = true;
container.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xf3f3f2);
const camera = new THREE.PerspectiveCamera(45, 1, 0.05, 50000);
camera.position.set(0, 60, 60);
const controls = new OrbitControls(camera, renderer.domElement);
controls.addEventListener('change', () => viewer.requestRender());

const modelsRoot = new THREE.Group();
modelsRoot.name = 'modelsRoot';
scene.add(modelsRoot);

let renderQueued = false;
const viewer = {
  scene,
  renderer,
  camera,
  controls,
  modelsRoot,
  worldOrigin: new WorldOrigin(bus),
  add(obj) { modelsRoot.add(obj); this.requestRender(); },
  remove(obj) { modelsRoot.remove(obj); this.requestRender(); },
  requestRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      renderNow();
    });
  },
  fitToBox(box) {
    if (!box || box.isEmpty()) return;
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(size.x, size.z, 1) * 0.75;
    camera.position.set(center.x, center.y + radius * 1.6, center.z + radius * 0.6);
    controls.target.copy(center);
    camera.near = Math.max(0.05, radius / 500);
    camera.far = radius * 100 + 1000;
    camera.updateProjectionMatrix();
    controls.update();
    this.requestRender();
  },
};

bus.on('origin:changed', ({ delta }) => {
  camera.position.add(delta);
  controls.target.add(delta);
  controls.update();
  viewer.requestRender();
});

function resize() {
  const w = container.clientWidth || window.innerWidth;
  const h = container.clientHeight || window.innerHeight;
  renderer.setSize(w, h, false);
  renderer.domElement.style.width = '100%';
  renderer.domElement.style.height = '100%';
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  viewer.requestRender();
}
window.addEventListener('resize', resize);

function renderNow() {
  renderer.render(scene, camera);
}

// ---------------------------------------------------------------------------
// Gestor CAD
// ---------------------------------------------------------------------------
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
  const t0 = performance.now();
  const model = await cad.load(record, buffer, (phase, p) => {
    log(`${fileName}: ${phase} ${(p * 100).toFixed(0)}%`);
  });
  model.loadMs = Math.round(performance.now() - t0);
  bus.emit('model:loaded', { modelId: record.id, kind: record.kind, model });
  log(`${fileName}: ${model.loadMs} ms, ${model.layers.length} capas, ancla ${JSON.stringify(model.anchor)}`);
  viewer.fitToBox(cad.getBox(record.id));
  renderLayers();
  return model;
}

function log(text) {
  document.getElementById('log').textContent = text;
}

function renderLayers() {
  const host = document.getElementById('layers');
  host.textContent = '';
  for (const m of cad.getModels()) {
    const title = document.createElement('div');
    title.style.fontWeight = '600';
    title.textContent = `${m.name} (${m.units}${m.georeferenced ? ', georref.' : ''}) cota ${m.elevation.toFixed(2)}`;
    host.appendChild(title);
    const hidden = new Set(store.get('cad')[m.id]?.hiddenLayers || []);
    for (const l of cad.getLayers(m.id)) {
      const label = document.createElement('label');
      label.className = 'layer';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !hidden.has(l.name);
      cb.addEventListener('change', () => actions.setCadLayerHidden(m.id, l.name, !cb.checked));
      const sw = document.createElement('span');
      sw.className = 'swatch';
      sw.style.background = l.color;
      label.append(cb, sw, document.createTextNode(`${l.name} (${l.count})`));
      host.appendChild(label);
    }
  }
}

store.subscribe('cad', renderLayers);
bus.on('cad:elevation', renderLayers);

// Edificio de referencia opcional (?building=1): caja 12×8×6 m en la ubicación del IFC de pruebas
function addReferenceBuilding() {
  const geo = new THREE.BoxGeometry(12, 6, 8);
  geo.translate(6, 3, -4); // esquina en el origen local, X → Este, −Z → Norte
  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0xbbbbbb, transparent: true, opacity: 0.4 }));
  mesh.rotation.y = (15 * Math.PI) / 180;
  const holder = new THREE.Group();
  holder.add(mesh);
  viewer.add(holder);
  viewer.worldOrigin.register(holder, { e: 279500, n: 8661000, h: 150 }, { georeferenced: true });
  return holder;
}

// ---------------------------------------------------------------------------
// Medición de píxeles (prueba de "render no vacío")
// ---------------------------------------------------------------------------
function pixelStats() {
  renderNow();
  const src = renderer.domElement;
  const c = document.createElement('canvas');
  c.width = src.width;
  c.height = src.height;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(src, 0, 0);
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  const bg = [0xf3, 0xf3, 0xf2];
  let nonBg = 0;
  let colored = 0;
  let dark = 0;
  for (let i = 0; i < d.length; i += 4) {
    const diff = Math.abs(d[i] - bg[0]) + Math.abs(d[i + 1] - bg[1]) + Math.abs(d[i + 2] - bg[2]);
    if (diff > 30) {
      nonBg++;
      if (Math.max(d[i], d[i + 1], d[i + 2]) - Math.min(d[i], d[i + 1], d[i + 2]) > 60) colored++;
      else if (Math.max(d[i], d[i + 1], d[i + 2]) < 110) dark++;
    }
  }
  return { width: c.width, height: c.height, nonBackground: nonBg, colored, dark };
}

// ---------------------------------------------------------------------------
// Interfaz de la página
// ---------------------------------------------------------------------------
document.querySelectorAll('[data-load]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const units = document.getElementById('units').value;
    loadUrl(btn.dataset.load, { units }).catch((e) => log(`Error: ${e.message}`));
  });
});
document.getElementById('file').addEventListener('change', async (ev) => {
  const file = ev.target.files?.[0];
  if (!file) return;
  const url = URL.createObjectURL(file);
  try {
    await loadUrl(url, { name: file.name, units: document.getElementById('units').value });
  } catch (e) {
    log(`Error: ${e.message}`);
  } finally {
    URL.revokeObjectURL(url);
  }
});
document.getElementById('ifcElev').addEventListener('change', (ev) => {
  const v = ev.target.value;
  ifcElevation = v === '' ? null : Number(v);
  cad.refreshElevation();
});
document.getElementById('manualElev').addEventListener('change', (ev) => {
  const v = ev.target.value;
  for (const m of cad.getModels()) actions.setCadElevation(m.id, v === '' ? null : Number(v));
});

resize();
if (new URLSearchParams(location.search).get('building') === '1') addReferenceBuilding();

window.__cadSandbox = {
  THREE, viewer, store, bus, actions, cad, loadUrl, pixelStats, addReferenceBuilding,
  render: renderNow,
  // refresh = false: solo cambia el valor del proveedor (el gestor se entera por el bus)
  setIfcElevation(v, { refresh = true } = {}) {
    ifcElevation = v;
    if (refresh) cad.refreshElevation();
  },
  screenshot: () => { renderNow(); return renderer.domElement.toDataURL('image/png'); },
  getAtlasInk(ch) {
    return cad._atlas ? cad._atlas.glyphInk(ch) : -1;
  },
};
document.documentElement.dataset.ready = 'true';
