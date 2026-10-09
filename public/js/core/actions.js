// Acciones de alto nivel sobre el store. La UI, los atajos de teclado y la
// interacción con el visor deben usar estas funciones para que la semántica
// sea idéntica en todas partes (y por tanto en el modo presentación).

let _seq = 0;
const uid = (p) => `${p}${Date.now().toString(36)}${(_seq++).toString(36)}`;

const sameItem = (a, b) => a.modelId === b.modelId && a.expressId === b.expressId;

function groupByModel(items) {
  const out = {};
  for (const { modelId, expressId } of items) {
    (out[modelId] ||= []).push(expressId);
  }
  return out;
}

export function createActions(store) {
  const A = {
    // ---------- Selección ----------
    // items: [{ modelId, expressId }]
    select(items, { additive = false, toggle = false } = {}) {
      const current = store.get('selection').items;
      let next;
      if (toggle) {
        next = [...current];
        for (const it of items) {
          const i = next.findIndex((c) => sameItem(c, it));
          if (i >= 0) next.splice(i, 1);
          else next.push(it);
        }
      } else if (additive) {
        next = [...current];
        for (const it of items) if (!next.some((c) => sameItem(c, it))) next.push(it);
      } else {
        next = [...items];
      }
      store.set('selection', { items: next });
    },

    clearSelection() {
      if (store.get('selection').items.length) store.set('selection', { items: [] });
    },

    // ---------- Visibilidad de elementos ----------
    hideElements(items) {
      if (!items.length) return;
      const vis = store.get('visibility');
      const hidden = { ...vis.hidden };
      for (const [modelId, ids] of Object.entries(groupByModel(items))) {
        hidden[modelId] = [...new Set([...(hidden[modelId] || []), ...ids])];
      }
      store.patch('visibility', { hidden });
    },

    hideSelected() {
      const items = store.get('selection').items;
      A.hideElements(items);
      A.clearSelection();
    },

    isolateElements(items) {
      if (!items.length) return;
      store.patch('visibility', { isolated: groupByModel(items) });
    },

    isolateSelected() {
      A.isolateElements(store.get('selection').items);
    },

    showAll() {
      store.patch('visibility', { hidden: {}, isolated: null, hiddenTypes: [] });
    },

    setTypeHidden(type, hidden) {
      const T = String(type).toUpperCase();
      const cur = store.get('visibility').hiddenTypes;
      const next = hidden ? [...new Set([...cur, T])] : cur.filter((t) => t !== T);
      store.patch('visibility', { hiddenTypes: next });
    },

    // ---------- Modelos ----------
    setModelVisible(modelId, visible) {
      const models = store.get('models');
      store.set('models', { ...models, [modelId]: { ...(models[modelId] || {}), visible } });
    },

    // ---------- Visualización ----------
    setSelectionMode(mode) {
      store.patch('display', { selectionMode: mode });
    },
    setGhostOpacity(value) {
      store.patch('display', { ghostOpacity: Math.max(0, Math.min(1, Number(value))) });
    },
    toggleEdges(force) {
      const edges = typeof force === 'boolean' ? force : !store.get('display').edges;
      store.patch('display', { edges });
    },
    setProjection(projection) {
      store.patch('display', { projection });
    },
    toggleSpaces(force) {
      const showSpaces = typeof force === 'boolean' ? force : !store.get('display').showSpaces;
      store.patch('display', { showSpaces });
    },

    // ---------- Niveles ----------
    // active: { modelId, expressId } | null
    setStorey(active, mode) {
      store.patch('storey', mode ? { active, mode } : { active });
    },
    setStoreyMode(mode) {
      store.patch('storey', { mode });
    },
    setCutHeight(h) {
      store.patch('storey', { cutHeight: Number(h) });
    },

    // ---------- Sección ----------
    setSection(partial) {
      store.patch('section', partial);
    },

    // ---------- CAD ----------
    setCadLayerHidden(modelId, layer, hidden) {
      const cad = store.get('cad');
      const cur = cad[modelId] || { hiddenLayers: [], elevation: null };
      const set = new Set(cur.hiddenLayers);
      if (hidden) set.add(layer);
      else set.delete(layer);
      store.set('cad', { ...cad, [modelId]: { ...cur, hiddenLayers: [...set] } });
    },
    setCadLayersHidden(modelId, layers, hidden) {
      const cad = store.get('cad');
      const cur = cad[modelId] || { hiddenLayers: [], elevation: null };
      const set = new Set(cur.hiddenLayers);
      for (const l of layers) hidden ? set.add(l) : set.delete(l);
      store.set('cad', { ...cad, [modelId]: { ...cur, hiddenLayers: [...set] } });
    },
    // elevation: number (cota en metros, coordenadas de mapa) | null (automática)
    setCadElevation(modelId, elevation) {
      const cad = store.get('cad');
      const cur = cad[modelId] || { hiddenLayers: [], elevation: null };
      store.set('cad', { ...cad, [modelId]: { ...cur, elevation } });
    },

    // ---------- UI ----------
    setTab(tab) {
      store.patch('ui', { tab, sidebarOpen: true });
    },
    toggleSidebar(force) {
      const open = typeof force === 'boolean' ? force : !store.get('ui').sidebarOpen;
      store.patch('ui', { sidebarOpen: open });
    },
    toggleDock(force) {
      const open = typeof force === 'boolean' ? force : !store.get('ui').dockOpen;
      store.patch('ui', { dockOpen: open });
    },

    // ---------- Medición ----------
    setMeasureActive(active) {
      store.patch('measure', { active: !!active });
    },
    addMeasure(a, b) {
      const m = store.get('measure');
      store.patch('measure', { items: [...m.items, { id: uid('m'), a, b }] });
    },
    removeMeasure(id) {
      const m = store.get('measure');
      store.patch('measure', { items: m.items.filter((it) => it.id !== id) });
    },
    clearMeasures() {
      store.patch('measure', { items: [] });
    },

    // ---------- Vistas guardadas ----------
    // camera: CameraState ; thumb: dataURL pequeño (opcional)
    saveView(name, camera, thumb = null) {
      const s = store.getAll();
      const view = {
        id: uid('v'),
        name,
        camera,
        thumb,
        state: {
          visibility: s.visibility,
          display: s.display,
          storey: s.storey,
          section: s.section,
          selection: s.selection,
          models: s.models,
          cad: s.cad,
        },
      };
      store.patch('views', { items: [...store.get('views').items, view] });
      return view;
    },
    removeView(id) {
      store.patch('views', { items: store.get('views').items.filter((v) => v.id !== id) });
    },
    // Restaura el estado de una vista (la cámara la aplica quien llama con viewer.setCameraState)
    applyViewState(view) {
      store.setMany({ ...view.state });
    },
  };
  return A;
}
