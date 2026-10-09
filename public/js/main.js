// Punto de entrada del visor. Crea los módulos y los conecta.
// El contrato de cada módulo está descrito en docs/ARQUITECTURA.md.

import { bus } from './core/events.js';
import { store } from './core/store.js';
import { createActions } from './core/actions.js';
import { ApiClient } from './core/api.js';
import { ModelLoader } from './core/ModelLoader.js';
import { Viewer } from './viewer/Viewer.js';
import { SectionBox } from './viewer/SectionBox.js';
import { MeasureTool } from './viewer/MeasureTool.js';
import { IfcManager } from './ifc/IfcManager.js';
import { CadManager } from './cad/CadManager.js';
import { SyncClient } from './sync/SyncClient.js';
import { Presentation } from './sync/Presentation.js';
import { mountUI } from './ui/App.js';

async function main() {
  const api = new ApiClient();
  const info = await api.getInfo();
  const params = new URLSearchParams(location.search);
  // ?role=viewer permite al anfitrión previsualizar la experiencia de un espectador
  const role = params.get('role') === 'viewer' ? 'viewer' : info.role;
  store.patch(
    'presentation',
    { role, lanUrls: info.lanUrls || [], viewerFreeNav: info.viewerFreeNav !== false },
    { source: 'system' },
  );

  const actions = createActions(store);
  const viewer = new Viewer(document.getElementById('viewport'), { bus, store });
  const section = new SectionBox({ viewer, store, bus });
  const measure = new MeasureTool({ viewer, store, bus, actions });
  const ifc = new IfcManager({ viewer, store, bus, actions });
  const cad = new CadManager({ viewer, store, bus });
  cad.setElevationProvider(() => ifc.getBaseElevation());

  const loader = new ModelLoader({ api, store, bus, ifc, cad, viewer });
  const sync = new SyncClient({ store, bus, info: { ...info, role } });
  const presentation = new Presentation({ sync, store, bus, viewer });

  const ctx = {
    bus, store, actions, api, info: { ...info, role },
    viewer, section, measure, ifc, cad, loader, sync, presentation,
  };
  mountUI(ctx);

  loader.start();
  sync.connect();

  // Acceso para depuración y pruebas E2E
  window.__visor = ctx;
  document.documentElement.dataset.ready = 'true';
  bus.emit('app:ready', ctx);
}

main().catch((err) => {
  console.error(err);
  const el = document.getElementById('fatal-error');
  if (el) {
    el.hidden = false;
    el.textContent = `No se pudo iniciar el visor: ${err.message}`;
  }
});
