// Interfaz del visor: monta todos los paneles flotantes sobre #viewport.
//
//   mountUI(ctx)  con  ctx = { bus, store, actions, api, info, viewer, section, measure, ifc, cad,
//                              loader, sync, presentation }
//
// Regla de oro: la UI se dibuja desde el store y llama a acciones/gestores. Lo que está en slices
// sincronizados (pestaña activa, barra lateral, dock, selección, cortes...) nunca se guarda
// localmente, porque en modo presentación los espectadores replican el store del presentador.

import { h } from './dom.js';
import { logo } from './icons.js';
import { UiContext } from './UiContext.js';
import { Dialogs } from './Dialogs.js';
import { Toasts } from './Toasts.js';
import { Header } from './Header.js';
import { Toolbar } from './Toolbar.js';
import { ZoomControls, OrbitPad } from './ZoomControls.js';
import { StoreyPicker } from './StoreyPicker.js';
import { SelectionCard } from './SelectionCard.js';
import { Dock } from './Dock.js';
import { Sidebar } from './Sidebar.js';
import { PresentationPanel, ConnectionPanel, SettingsPanel } from './Panels.js';
import { StatusCluster } from './StatusCluster.js';
import { DropZone } from './DropZone.js';
import { LockLayer } from './LockLayer.js';
import { Shortcuts } from './Shortcuts.js';

export function mountUI(ctx) {
  const host = document.getElementById('ui-root') || document.body.appendChild(h('div', { id: 'ui-root' }));
  host.replaceChildren();

  const { store, actions } = ctx;
  const uiState = store.get('ui');
  const pres = store.get('presentation');

  const root = h('div', {
    class: 'ui',
    'data-role': pres.role,
    'data-sidebar': uiState.sidebarOpen ? 'open' : 'closed',
    'data-dock': uiState.dockOpen ? 'open' : 'closed',
    'data-locked': 'false',
    'data-live': 'false',
  });
  const layers = {
    popover: h('div', { class: 'popover-layer' }),
    modal: h('div', { class: 'modal-layer' }),
    toast: h('div', { class: 'toast-layer', role: 'region', 'aria-label': 'Notificaciones', 'aria-live': 'polite' }),
  };
  host.append(root);

  const ui = new UiContext(ctx, root, layers);
  new Dialogs(ui);
  const components = [];
  const add = (c) => {
    components.push(c);
    return c;
  };

  // ---- Paneles emergentes de la barra lateral
  const presentationPanel = add(new PresentationPanel(ui));
  const connectionPanel = add(new ConnectionPanel(ui));
  const settingsPanel = add(new SettingsPanel(ui));

  // ---- Estructura principal
  const glow = h('div', { class: 'glow', 'aria-hidden': 'true' });
  const sidebar = add(new Sidebar(ui, { presentationPanel, connectionPanel, settingsPanel }));
  const reopen = h(
    'button',
    { type: 'button', class: 'sidebar-reopen', title: 'Mostrar la barra lateral', 'aria-label': 'Mostrar la barra lateral', on: { click: () => actions.toggleSidebar(true) } },
    logo({ size: 48 }),
  );
  const header = add(new Header(ui));
  const toolbar = add(new Toolbar(ui));
  const zoom = add(new ZoomControls(ui));
  const orbit = add(new OrbitPad(ui));
  const level = add(new StoreyPicker(ui));
  const selection = add(new SelectionCard(ui));
  const dock = add(new Dock(ui));

  const bottomRow = h('div', { class: 'bottom-row' }, orbit.el, h('div', { class: 'spacer' }), h('div', { class: 'bottom-end' }, level.el, selection.el));

  root.append(glow, reopen, sidebar.el, header.el, toolbar.el, zoom.el, bottomRow, dock.el, layers.popover, layers.modal, layers.toast);

  add(new Toasts(ui));
  add(new StatusCluster(ui, presentationPanel));
  add(new DropZone(ui));

  // ---- Estado de la UI -> atributos del contenedor (diseño responsivo por CSS)
  const offs = [];
  offs.push(
    store.subscribe('ui', (next) => {
      root.dataset.sidebar = next.sidebarOpen ? 'open' : 'closed';
      root.dataset.dock = next.dockOpen ? 'open' : 'closed';
    }),
    store.subscribe('presentation', (next) => {
      root.dataset.role = next.role;
    }),
  );

  // ---- Zona libre del visor: los encuadres colocan el modelo fuera de la barra lateral y del dock
  const fitInsets = () => {
    const viewer = ctx.viewer;
    if (!viewer?.setFitInsets) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const insets = { left: 0, right: 0, top: 0, bottom: 0 };
    const sb = sidebar.el.getBoundingClientRect();
    if (root.dataset.sidebar === 'open' && sb.width > 0) insets.left = Math.max(0, sb.right + 12);
    const dk = dock.el.getBoundingClientRect();
    if (dk.height > 0) insets.bottom = Math.max(0, vh - dk.top + 8);
    insets.top = 16;
    if (vw < 700) insets.left = 0; // en pantallas estrechas la barra lateral es un cajón que se cierra
    viewer.setFitInsets(insets);
  };
  let insetTimer = 0;
  const scheduleInsets = () => {
    fitInsets();
    clearTimeout(insetTimer);
    insetTimer = setTimeout(fitInsets, 450); // tras las transiciones de la barra lateral y del dock
  };
  scheduleInsets();
  window.addEventListener('resize', scheduleInsets);
  offs.push(store.subscribe('ui', scheduleInsets), () => window.removeEventListener('resize', scheduleInsets), () => clearTimeout(insetTimer));
  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(scheduleInsets);
    ro.observe(sidebar.el);
    ro.observe(dock.el);
    offs.push(() => ro.disconnect());
  }

  // ---- Atajos y capa de bloqueo (la capa va la última: queda por encima de todo salvo del estado)
  add(new Shortcuts(ui, { onSearch: () => sidebar.focusSearch() }));
  add(new LockLayer(ui, [sidebar.el, header.el, toolbar.el, zoom.el, bottomRow, dock.el, layers.popover, layers.modal, reopen]));

  const api = {
    ui,
    root,
    components,
    dispose() {
      for (const off of offs.splice(0)) off();
      for (const c of components.splice(0).reverse()) {
        try {
          c.dispose();
        } catch (err) {
          console.warn('[ui] dispose', err);
        }
      }
      host.replaceChildren();
    },
  };
  root.__ui = api;
  return api;
}
