// Contexto simulado para desarrollar y probar la UI sin los demás módulos.
// store / bus / actions son los REALES de core; viewer, ifc, cad, loader, presentation, sync, api y
// section/measure son dobles con datos plausibles (árbol, propiedades, tipos, niveles, capas).
//
// Parámetros de la URL:
//   ?role=viewer         PC de espectador (la presentación activa se simula con &active=1)
//   ?active=1            presentación activa (con role=presenter: soy el presentador)
//   ?empty=1             sin modelos cargados
//   ?freenav=0           el servidor no permite navegación libre a los espectadores

import * as THREE from 'three';
import { EventBus } from '/js/core/events.js';
import { createStore } from '/js/core/store.js';
import { createActions } from '/js/core/actions.js';
import { mountUI } from '/js/ui/App.js';

const params = new URLSearchParams(location.search);
const role = params.get('role') === 'viewer' ? 'viewer' : 'presenter';
const wantActive = params.get('active') === '1';
const empty = params.get('empty') === '1';

const bus = new EventBus();
const store = createStore();
const actions = createActions(store);

// ------------------------------------------------------------------ datos del modelo simulado
const IFC_ID = 'ifcmock001';
const CAD_ID = 'cadmock002';

const TYPES = [
  ['IFCWALL', 'Muro', 'Muros', ['Muro básico: Interior 138 mm', 'Muro básico: Exterior 250 mm', 'Muro básico: Tabique 100 mm']],
  ['IFCSLAB', 'Losa', 'Losas', ['Losa: Aligerada 200 mm', 'Losa: Maciza 150 mm']],
  ['IFCCOLUMN', 'Columna', 'Columnas', ['Columna rectangular: 300x600', 'Columna circular: Ø400']],
  ['IFCBEAM', 'Viga', 'Vigas', ['Viga: 300x500', 'Viga: 250x400']],
  ['IFCDOOR', 'Puerta', 'Puertas', ['Puerta simple: 0.90 x 2.10', 'Puerta doble: 1.60 x 2.10']],
  ['IFCWINDOW', 'Ventana', 'Ventanas', ['Ventana fija: 1.50 x 1.20', 'Ventana corrediza: 2.00 x 1.20']],
  ['IFCSTAIR', 'Escalera', 'Escaleras', ['Escalera monolítica']],
  ['IFCRAILING', 'Baranda', 'Barandas', ['Baranda de vidrio', 'Baranda metálica']],
  ['IFCFURNISHINGELEMENT', 'Mobiliario', 'Mobiliario', ['Mesa comedor', 'Silla', 'Sofá 3 plazas', 'Cocina isla']],
];

const STOREY_DEFS = [
  { name: 'Sótano', elevation: -3.0, count: 64 },
  { name: 'Nivel 1', elevation: 0.0, count: 650 }, // más de 300 hijos: prueba de "mostrar más"
  { name: 'Nivel 2', elevation: 3.2, count: 120 },
  { name: 'Nivel 3', elevation: 6.4, count: 118 },
  { name: 'Azotea', elevation: 9.6, count: 40 },
];

const BASE_H = 150;
let nextId = 100;
const elements = new Map(); // expressId -> info
const guid = (n) => {
  const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$';
  let s = '';
  let x = Math.imul(n + 7, 2654435761) >>> 0;
  for (let i = 0; i < 22; i++) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    s += chars[(x >>> 8) % 64];
  }
  return s;
};

function buildTree() {
  const storeys = [];
  const storeyNodes = [];
  for (const def of STOREY_DEFS) {
    const storeyId = nextId++;
    const kids = [];
    for (let i = 0; i < def.count; i++) {
      const t = TYPES[(i * 7 + storeyId) % TYPES.length];
      const expressId = nextId++;
      const name = `${t[3][i % t[3].length]} [${expressId}]`;
      elements.set(expressId, { expressId, type: t[0], typeLabel: t[1], name, storeyName: def.name, storeyId, globalId: guid(expressId) });
      kids.push({ expressId, type: t[0], typeLabel: t[1], name, children: [], isSpatial: false });
    }
    storeyNodes.push({ expressId: storeyId, type: 'IFCBUILDINGSTOREY', typeLabel: 'Nivel', name: def.name, children: kids, isSpatial: true });
    storeys.push({ modelId: IFC_ID, expressId: storeyId, name: def.name, elevation: def.elevation, mapHeight: BASE_H + def.elevation, elementCount: def.count });
  }
  const building = { expressId: nextId++, type: 'IFCBUILDING', typeLabel: 'Edificio', name: 'Torre A', children: storeyNodes, isSpatial: true };
  const site = { expressId: nextId++, type: 'IFCSITE', typeLabel: 'Emplazamiento', name: 'Lote Miraflores', children: [building], isSpatial: true };
  const project = { expressId: nextId++, type: 'IFCPROJECT', typeLabel: 'Proyecto', name: 'Edificio Residencial Miraflores', children: [site], isSpatial: true };
  return { project, storeys };
}

const { project: TREE, storeys: STOREYS } = buildTree();

function descendants(node, out = []) {
  for (const c of node.children) {
    if (!c.isSpatial) out.push(c.expressId);
    descendants(c, out);
  }
  return out;
}
const nodeIndex = new Map();
(function index(n) {
  nodeIndex.set(n.expressId, n);
  n.children.forEach(index);
})(TREE);

const CAD_LAYERS = [
  ['0', '#2B2B2B', 120], ['A-WALL', '#1B1B1B', 842], ['A-DOOR', '#FF6A13', 64], ['A-GLAZ', '#2E9BFF', 48], ['A-FLOR', '#8C8C8C', 210],
  ['A-ANNO-TEXT', '#2B2B2B', 312], ['A-ANNO-DIMS', '#E5412B', 190], ['S-COLS', '#FFC21A', 72], ['S-GRID', '#3FBF6A', 28], ['A-FURN', '#8B5A2B', 156],
  ['LOTE', '#FF3B8D', 4], ['EJES', '#00B8D9', 18], ['Defpoints', '#BDBDBD', 6],
];

// ------------------------------------------------------------------ registros
const records = empty
  ? []
  : [
      { id: IFC_ID, name: 'Edificio_Residencial_Miraflores.ifc', kind: 'ifc', size: 48.2 * 1024 * 1024, uploadedAt: new Date().toISOString(), georef: null, cad: null },
      { id: CAD_ID, name: 'Planta_Georef_UTM18S.dxf', kind: 'dxf', size: 3.4 * 1024 * 1024, uploadedAt: new Date().toISOString(), georef: null, cad: { units: 'auto' } },
    ];
let recordsRef = records;
const loaded = new Set(records.map((r) => r.id));
let georefOverride = null;

// ------------------------------------------------------------------ viewer simulado
function drawFake(ctx2, w, h, { top = false, tint = '#6b4a35' } = {}) {
  ctx2.clearRect(0, 0, w, h);
  const g = ctx2.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, '#f3f3f2');
  g.addColorStop(1, '#e7e7e6');
  ctx2.fillStyle = g;
  ctx2.fillRect(0, 0, w, h);
  const s = Math.min(w, h) * 0.05;
  const cx = w * 0.56;
  const cy = h * 0.5;
  const P = (x, y, z) => (top ? [cx + (x - 6) * s * 1.1, cy + (z - 4) * s * 1.1] : [cx + (x - z) * s * 0.87, cy + (x + z) * s * 0.5 - y * s * 0.9 + s * 1.5]);
  ctx2.lineWidth = 1;
  ctx2.strokeStyle = 'rgba(70,70,70,.55)';
  const floors = top ? [0] : [0, 3.2, 6.4, 9.6];
  for (const y of floors) {
    ctx2.beginPath();
    for (const [x, z] of [[0, 0], [12, 0], [12, 8], [0, 8], [0, 0]]) {
      const [px, py] = P(x, y, z);
      ctx2.lineTo(px, py);
    }
    ctx2.stroke();
    for (let i = 1; i < 12; i += 2) {
      ctx2.beginPath();
      ctx2.moveTo(...P(i, y, 0));
      ctx2.lineTo(...P(i, y, 8));
      ctx2.stroke();
    }
    for (let k = 1; k < 8; k += 2) {
      ctx2.beginPath();
      ctx2.moveTo(...P(0, y, k));
      ctx2.lineTo(...P(12, y, k));
      ctx2.stroke();
    }
  }
  if (!top) {
    for (const [x, z] of [[0, 0], [12, 0], [12, 8], [0, 8], [6, 0], [6, 8]]) {
      ctx2.beginPath();
      ctx2.moveTo(...P(x, 0, z));
      ctx2.lineTo(...P(x, 9.6, z));
      ctx2.stroke();
    }
  }
  // volúmenes marrones (mobiliario / muros) como en la referencia
  ctx2.fillStyle = tint;
  const blocks = [[1, 0, 1, 4, 1.4, 1.2], [5, 0, 1, 1.2, 1.4, 5], [1, 3.2, 5, 5, 1.2, 1.1], [7, 3.2, 1, 1.2, 1.4, 5.5], [2, 6.4, 2, 4, 1.2, 1.2]];
  for (const [x, y, z, dx, dy, dz] of blocks) {
    const a = P(x, y + dy, z), b = P(x + dx, y + dy, z), c = P(x + dx, y + dy, z + dz), d = P(x, y + dy, z + dz);
    ctx2.fillStyle = top ? tint : '#8a6347';
    ctx2.beginPath(); ctx2.moveTo(...a); ctx2.lineTo(...b); ctx2.lineTo(...c); ctx2.lineTo(...d); ctx2.closePath(); ctx2.fill();
    if (!top) {
      const e = P(x + dx, y, z), f = P(x + dx, y, z + dz);
      ctx2.fillStyle = '#5d3f2b';
      ctx2.beginPath(); ctx2.moveTo(...b); ctx2.lineTo(...e); ctx2.lineTo(...f); ctx2.lineTo(...c); ctx2.closePath(); ctx2.fill();
      const i = P(x, y, z + dz);
      ctx2.fillStyle = '#734f38';
      ctx2.beginPath(); ctx2.moveTo(...d); ctx2.lineTo(...c); ctx2.lineTo(...f); ctx2.lineTo(...i); ctx2.closePath(); ctx2.fill();
    }
  }
}

function makeViewer() {
  const container = document.getElementById('viewport');
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block';
  container.append(canvas);
  const paint = () => {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = container.clientWidth;
    const h = container.clientHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    const c = canvas.getContext('2d');
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawFake(c, w, h);
  };
  paint();
  window.addEventListener('resize', paint);

  let camera = { position: [30, 24, 30], target: [0, 4, 0], projection: 'perspective', zoom: 1, fov: 50 };
  const calls = [];
  const rec = (name, ...args) => calls.push([name, ...args]);
  const viewer = {
    calls,
    inputEnabled: true,
    worldOrigin: { origin: { e: 279500, n: 8661000, h: BASE_H } },
    fitToBox: (box) => rec('fitToBox', box),
    fitAll: () => rec('fitAll'),
    setView: (name, opts) => rec('setView', name, opts),
    zoomStep: (d) => rec('zoomStep', d),
    orbitStep: (dx, dy) => rec('orbitStep', dx, dy),
    getCameraState: () => ({ ...camera }),
    setCameraState: (s) => {
      camera = { ...s };
      rec('setCameraState', s);
    },
    getVisibleBox: () => new THREE.Box3(new THREE.Vector3(-20, -3, -15), new THREE.Vector3(20, 12, 15)),
    enableInput(on) {
      viewer.inputEnabled = !!on;
      rec('enableInput', !!on);
    },
    screenshot({ width, height } = {}) {
      const w = width || container.clientWidth;
      const h = height || Math.round((w * container.clientHeight) / container.clientWidth);
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      drawFake(c.getContext('2d'), w, h);
      rec('screenshot', w, h);
      return c.toDataURL('image/jpeg', 0.8);
    },
    renderTopView({ width = 240, height = 150 } = {}) {
      const c = document.createElement('canvas');
      c.width = width;
      c.height = height;
      drawFake(c.getContext('2d'), width, height, { top: true });
      rec('renderTopView', width, height);
      return c.toDataURL('image/jpeg', 0.8);
    },
  };
  return viewer;
}

// ------------------------------------------------------------------ ifc simulado
function makeIfc() {
  const typeCounts = new Map();
  for (const e of elements.values()) typeCounts.set(e.type, (typeCounts.get(e.type) || 0) + 1);
  return {
    has: (id) => id === IFC_ID && loaded.has(id),
    getModels: () => (loaded.has(IFC_ID) ? [{ id: IFC_ID }] : []),
    getProjectInfo: () => (loaded.has(IFC_ID) ? { name: TREE.name, longName: 'Edificio Residencial', buildings: ['Torre A'], schema: 'IFC4' } : null),
    getSpatialTree: (id) => (id === IFC_ID ? TREE : { expressId: -2, type: 'IFCPROJECT', typeLabel: 'Proyecto', name: '', children: [], isSpatial: true }),
    getDescendants: (id, expressId) => descendants(nodeIndex.get(expressId) || { children: [] }),
    getStoreys: () => (loaded.has(IFC_ID) ? STOREYS : []),
    getModelSummary: (id) => (id === IFC_ID ? { modelId: id, name: 'mock', schema: 'IFC4', elementCount: elements.size, storeyCount: STOREYS.length, categoryCount: typeCounts.size } : null),
    getTypeSummary: () =>
      loaded.has(IFC_ID)
        ? TYPES.map((t) => ({ type: t[0], label: t[2], count: typeCounts.get(t[0]) || 0 })).sort((a, b) => b.count - a.count)
        : [],
    getElementInfo: (modelId, expressId) => {
      const e = elements.get(expressId);
      return e ? { modelId, ...e } : null;
    },
    async getProperties(modelId, expressId) {
      await new Promise((r) => setTimeout(r, 120));
      const e = elements.get(expressId);
      if (!e) return { attributes: [], psets: [], quantities: [], type: null, materials: [] };
      return {
        attributes: [
          { name: 'Name', value: e.name },
          { name: 'GlobalId', value: e.globalId },
          { name: 'ObjectType', value: e.name.split(' [')[0] },
          { name: 'Tag', value: String(expressId) },
          { name: 'PredefinedType', value: 'NOTDEFINED' },
        ],
        psets: [
          { name: 'Pset_WallCommon', props: [{ name: 'IsExternal', value: expressId % 2 === 0 }, { name: 'FireRating', value: '2 h' }, { name: 'LoadBearing', value: false }, { name: 'Reference', value: `${e.type}-${expressId}` }, { name: 'ThermalTransmittance', value: 0.3456 }] },
          { name: 'Datos de identidad', props: [{ name: 'Fase de creación', value: 'Obra nueva' }, { name: 'Marca de tipo', value: 'M-01' }] },
          { name: 'Restricciones', props: [{ name: 'Nivel base', value: e.storeyName }, { name: 'Desfase de base', value: 0 }] },
        ],
        quantities: [{ name: 'BaseQuantities', props: [{ name: 'Length', value: 4.25, unit: 'm' }, { name: 'Height', value: 3.0, unit: 'm' }, { name: 'GrossVolume', value: 1.7595, unit: 'm³' }, { name: 'NetArea', value: 12.75, unit: 'm²' }] }],
        type: { name: e.name.split(' [')[0], psets: [{ name: 'Pset_TypeCommon', props: [{ name: 'Manufacturer', value: 'Genérico' }] }] },
        materials: ['Concreto 210 kg/cm²', 'Acabado pintura látex'],
      };
    },
    search(query, limit = 50) {
      const q = String(query).toLowerCase();
      const out = [];
      for (const e of elements.values()) {
        if (e.name.toLowerCase().includes(q) || e.typeLabel.toLowerCase().includes(q) || e.globalId === query) {
          out.push({ modelId: IFC_ID, expressId: e.expressId, name: e.name, type: e.type, typeLabel: e.typeLabel, globalId: e.globalId });
          if (out.length >= limit) break;
        }
      }
      return out;
    },
    findByGlobalId: () => null,
    getBoxOf: (items) => (items?.length ? new THREE.Box3(new THREE.Vector3(-2, 0, -2), new THREE.Vector3(2, 3, 2)) : null),
    getModelBox: () => new THREE.Box3(new THREE.Vector3(-20, -3, -15), new THREE.Vector3(20, 12, 15)),
    getBaseElevation: () => BASE_H - 3,
    getGeorefInfo: (id) =>
      georefOverride
        ? { source: 'manual', crs: '', ...georefOverride }
        : { source: 'mapconversion', crs: 'EPSG:32718', eastings: 279500, northings: 8661000, height: 150, rotationDeg: 15, scale: 1 },
    updateGeoref: () => {},
    setElementColors: () => {},
  };
}

// ------------------------------------------------------------------ cad simulado
function makeCad() {
  const model = { id: CAD_ID, name: 'Planta_Georef_UTM18S.dxf', kind: 'dxf', units: 'm', unitsSource: 'header', georeferenced: true, elevation: BASE_H - 3 + 0.02, hasZ: false, flat: true };
  return {
    has: (id) => id === CAD_ID && loaded.has(id),
    getModels: () => (loaded.has(CAD_ID) ? [model] : []),
    getLayers: (id) => (id === CAD_ID ? CAD_LAYERS.map(([name, color, count]) => ({ name, color, count })) : []),
    getBox: () => new THREE.Box3(new THREE.Vector3(-14, -3, -10), new THREE.Vector3(14, -3, 10)),
    setElevationProvider: () => {},
    refreshElevation: () => {},
  };
}

// ------------------------------------------------------------------ módulos auxiliares simulados
function makeLoader() {
  const reconcile = (list) => {
    recordsRef = list;
    for (const id of [...loaded]) if (!list.some((r) => r.id === id)) {
      loaded.delete(id);
      bus.emit('model:unloaded', { modelId: id });
    }
    store.set('modelRecords', list, { source: 'system' });
  };
  return {
    reconcile,
    isLoaded: (id) => loaded.has(id),
    retryFailed: () => {},
    uploadFiles: async (files) => {
      const created = [];
      for (const file of files) {
        const tempId = `upload-${Math.random().toString(36).slice(2, 6)}`;
        const kind = file.name.split('.').pop().toLowerCase();
        for (const p of [0.2, 0.55, 1]) {
          store.set('loading', { ...store.get('loading'), [tempId]: { name: file.name, kind, phase: 'upload', progress: p } }, { source: 'system' });
          await new Promise((r) => setTimeout(r, 80));
        }
        const { [tempId]: _x, ...rest } = store.get('loading');
        store.set('loading', rest, { source: 'system' });
        const rec = { id: `m${Math.random().toString(36).slice(2, 11)}`, name: file.name, kind, size: file.size, uploadedAt: new Date().toISOString(), georef: null, cad: kind === 'ifc' ? null : { units: 'auto' } };
        created.push(rec);
        reconcile([...store.get('modelRecords'), rec]);
        bus.emit('toast', { type: 'success', message: `"${file.name}" se subió correctamente.` });
      }
      return created;
    },
  };
}

function makePresentation() {
  return {
    start() {
      store.patch('presentation', { active: true, isActivePresenter: true, presenterName: 'Anfitrión', viewers: 2 }, { source: 'system' });
      return true;
    },
    stop() {
      store.patch('presentation', { active: false, isActivePresenter: false, presenterName: '' }, { source: 'system' });
      return true;
    },
    toggle() {
      const p = store.get('presentation');
      return p.active && p.isActivePresenter ? this.stop() : this.start();
    },
    takeControl() {
      store.patch('presentation', { active: true, isActivePresenter: true, presenterName: 'Anfitrión' }, { source: 'system' });
      return true;
    },
    setLaser(on) {
      store.patch('presentation', { laser: !!on }, { source: 'system' });
    },
  };
}

function makeApi() {
  return {
    calls: [],
    async patchModel(id, partial) {
      this.calls.push(['patchModel', id, partial]);
      const rec = recordsRef.find((r) => r.id === id);
      if (!rec) throw new Error('Modelo no encontrado');
      if ('georef' in partial) georefOverride = partial.georef;
      return { ...rec, ...partial };
    },
    async deleteModel(id) {
      this.calls.push(['deleteModel', id]);
    },
    fileUrl: (id) => `/api/models/${id}/file`,
    getPin: () => '',
    setPin: () => {},
  };
}

// ------------------------------------------------------------------ arranque
const viewer = makeViewer();
const ifc = makeIfc();
const cad = makeCad();
const loader = makeLoader();
const presentation = makePresentation();
const api = makeApi();
const section = {
  getBounds: () => new THREE.Box3(new THREE.Vector3(-22, -3.5, -17), new THREE.Vector3(22, 13, 17)),
  fitTo: (box) => store.patch('section', { min: box.min.toArray(), max: box.max.toArray() }),
  reset() {
    this.fitTo(this.getBounds());
  },
};
const measure = { _pending: null, cancel() {} };
const sync = {
  name: 'PC-DEMO',
  getName() {
    return this.name;
  },
  setName(n) {
    this.name = n;
    return n;
  },
  connect() {
    store.patch('presentation', { connected: true }, { source: 'system' });
  },
};

store.patch(
  'presentation',
  {
    role,
    connected: true,
    clientId: 'mock-1',
    lanUrls: ['http://192.168.1.20:8080', 'http://10.0.0.15:8080'],
    viewerFreeNav: params.get('freenav') !== '0',
    viewers: role === 'presenter' ? 2 : 0,
  },
  { source: 'system' },
);

if (!empty) {
  store.set('modelRecords', records, { source: 'system' });
  store.set('models', { [IFC_ID]: { visible: true }, [CAD_ID]: { visible: true } }, { source: 'system' });
  store.set('cad', { [CAD_ID]: { hiddenLayers: ['Defpoints'], elevation: null } }, { source: 'system' });
}
if (wantActive) {
  store.patch('presentation', role === 'presenter' ? { active: true, isActivePresenter: true, presenterName: 'Anfitrión', viewers: 3 } : { active: true, isActivePresenter: false, presenterId: 'host', presenterName: 'Henry (anfitrión)' }, { source: 'system' });
}

const ctx = {
  bus,
  store,
  actions,
  api,
  info: { role, clientIp: '192.168.1.45', port: 8080, version: '0.1.0-mock', lanUrls: store.get('presentation').lanUrls, viewerFreeNav: true },
  viewer,
  section,
  measure,
  ifc,
  cad,
  loader,
  sync,
  presentation,
};

try {
  const ui = mountUI(ctx);
  window.__mock = { ctx, ui, store, actions, bus, viewer, api, ifc, cad, loader, presentation, TREE, STOREYS, elements };
  document.documentElement.dataset.ready = 'true';
  bus.emit('app:ready', ctx);
} catch (err) {
  console.error(err);
  const el = document.getElementById('fatal-error');
  el.hidden = false;
  el.textContent = `No se pudo montar la UI: ${err.message}`;
}
