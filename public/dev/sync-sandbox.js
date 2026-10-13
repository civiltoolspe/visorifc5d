// Sandbox del módulo de sincronización: store y bus reales + SyncClient y Presentation reales.
// Parámetros de la URL:
//   role=viewer      simula ?role=viewer (el SyncClient pide el rol de espectador)
//   name=Ana         nombre del cliente (localStorage 'visor.name')
//   pin=1234         PIN de presentador (sessionStorage 'visor.pin')
//   w=1000&h=500     tamaño del contenedor del visor (para probar la corrección de aspecto)
//   freenav=0        viewerFreeNav inicial = false
//   real=1           usa el Viewer real en lugar del doble
//   ping=300         intervalo de latido en ms
//   noconnect=1      no conecta automáticamente

import { EventBus } from '/js/core/events.js';
import { createStore } from '/js/core/store.js';
import { createActions } from '/js/core/actions.js';
import { SyncClient } from '/js/sync/SyncClient.js';
import { Presentation } from '/js/sync/Presentation.js';
import { SyncViewerDouble } from '/dev/sync-viewer-double.js';

const params = new URLSearchParams(location.search);
const role = params.get('role') === 'viewer' ? 'viewer' : 'presenter';
if (params.get('name')) localStorage.setItem('visor.name', params.get('name'));
if (params.get('pin')) sessionStorage.setItem('visor.pin', params.get('pin'));

const container = document.getElementById('viewport');
container.style.width = `${params.get('w') || 800}px`;
container.style.height = `${params.get('h') || 600}px`;

const bus = new EventBus();
const store = createStore();
const actions = createActions(store);
store.patch('presentation', { role, viewerFreeNav: params.get('freenav') !== '0' }, { source: 'system' });

let viewer;
if (params.get('real') === '1') {
  const THREE = await import('three');
  const { Viewer } = await import('/js/viewer/Viewer.js');
  viewer = new Viewer(container, { bus, store });
  const mat = new THREE.MeshStandardMaterial({ color: 0xcccccc });
  const box = new THREE.Mesh(new THREE.BoxGeometry(10, 6, 8), mat);
  box.position.set(0, 3, 0);
  viewer.add(box);
  const box2 = new THREE.Mesh(new THREE.BoxGeometry(3, 9, 3), mat);
  box2.position.set(9, 4.5, 4);
  viewer.add(box2);
  viewer.fitAll({ smooth: false });
  window.THREE = THREE;
} else {
  viewer = new SyncViewerDouble(container, { bus });
}

// Registro de cambios del store para las pruebas
const storeLog = [];
store.subscribeAll((changes, meta) => storeLog.push({ slices: Object.keys(changes), source: meta?.source }));
const events = [];
for (const evt of ['sync:status', 'sync:welcome', 'sync:presentation', 'sync:clients', 'sync:error', 'sync:unknown', 'toast', 'server:models']) {
  bus.on(evt, (payload) => events.push({ evt, payload }));
}

const sync = new SyncClient({
  store, bus, info: { role }, pingMs: Number(params.get('ping')) || undefined,
});
const presentation = new Presentation({ sync, store, bus, viewer });

window.__t = { store, bus, actions, viewer, sync, presentation, storeLog, events, params };
if (params.get('noconnect') !== '1') sync.connect();

const hud = document.getElementById('hud');
const renderHud = () => {
  const p = store.get('presentation');
  hud.textContent = `${role} · ${p.connected ? 'conectado' : 'sin conexión'} · activa: ${p.active} · yo: ${p.isActivePresenter}\n${sync.getName()}`;
};
store.subscribe('presentation', renderHud);
renderHud();
window.__ready = true;
