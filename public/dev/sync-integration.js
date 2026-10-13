// Integración sin UI: arranque equivalente a public/js/main.js con el servidor REAL
// (API REST + WebSocket), Viewer, IfcManager y CadManager reales, ModelLoader, SyncClient y Presentation.
// Se usa desde tests/e2e/sync.test.mjs (parte de integración) y para depuración manual.
// Parámetros: role=viewer, name=<nombre>

import { bus } from '/js/core/events.js';
import { store } from '/js/core/store.js';
import { createActions } from '/js/core/actions.js';
import { ApiClient } from '/js/core/api.js';
import { ModelLoader } from '/js/core/ModelLoader.js';
import { Viewer } from '/js/viewer/Viewer.js';
import { IfcManager } from '/js/ifc/IfcManager.js';
import { CadManager } from '/js/cad/CadManager.js';
import { SyncClient } from '/js/sync/SyncClient.js';
import { Presentation } from '/js/sync/Presentation.js';

const params = new URLSearchParams(location.search);
if (params.get('name')) localStorage.setItem('visor.name', params.get('name'));

const api = new ApiClient();
const info = await api.getInfo();
const role = params.get('role') === 'viewer' ? 'viewer' : info.role;
store.patch('presentation', { role, lanUrls: info.lanUrls || [], viewerFreeNav: info.viewerFreeNav !== false }, { source: 'system' });

const actions = createActions(store);
const viewer = new Viewer(document.getElementById('viewport'), { bus, store });
const ifc = new IfcManager({ viewer, store, bus, actions });
const cad = new CadManager({ viewer, store, bus });
cad.setElevationProvider(() => ifc.getBaseElevation());
const loader = new ModelLoader({ api, store, bus, ifc, cad, viewer });
const sync = new SyncClient({ store, bus, info: { ...info, role } });
const presentation = new Presentation({ sync, store, bus, viewer });

const events = [];
for (const evt of ['model:loaded', 'model:unloaded', 'model:error', 'toast']) {
  bus.on(evt, (payload) => events.push({ evt, payload: evt === 'model:loaded' ? { ...payload, model: undefined } : payload }));
}

loader.start();
sync.connect();

window.__visor = { bus, store, actions, api, info: { ...info, role }, viewer, ifc, cad, loader, sync, presentation, events };
window.__ready = true;
