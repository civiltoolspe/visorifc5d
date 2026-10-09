// Estado observable de la aplicación, dividido en "slices".
//
// Reglas:
//  - Los valores de un slice se tratan como inmutables: nunca mutar el objeto
//    devuelto por get(); usar set()/patch() con objetos nuevos.
//  - meta.source indica el origen del cambio:
//      'local'  -> acción del usuario en esta PC
//      'remote' -> estado recibido del presentador (sincronización)
//      'system' -> cambios internos (carga de modelos, etc.)
//  - Los slices de SYNCED_SLICES son los que el presentador transmite a los
//    espectadores. Los demás son locales a cada PC.

export const SYNCED_SLICES = [
  'models',
  'selection',
  'visibility',
  'display',
  'storey',
  'section',
  'cad',
  'ui',
  'measure',
  'views',
];

export function initialState() {
  return {
    // { [modelId]: { visible: boolean } }
    models: {},
    // Elementos IFC seleccionados: [{ modelId, expressId }]
    selection: { items: [] },
    // hidden:   { [modelId]: number[] }   elementos ocultos manualmente
    // isolated: { [modelId]: number[] } | null   si no es null, solo se ven esos
    // hiddenTypes: string[]   tipos IFC ocultos (en MAYÚSCULAS, p. ej. 'IFCWALL')
    visibility: { hidden: {}, isolated: null, hiddenTypes: [] },
    // selectionMode: 'ghost' (transparentar el resto) | 'isolate' (ocultar el resto) | 'highlight'
    display: {
      selectionMode: 'ghost',
      ghostOpacity: 0.12,
      edges: true,
      projection: 'perspective',
      showSpaces: false,
    },
    // active: { modelId, expressId } | null ; mode: 'cut' (corte de planta) | 'only' (solo ese nivel)
    storey: { active: null, mode: 'cut', cutHeight: 1.2 },
    // Caja de sección en coordenadas de escena
    section: { enabled: false, min: [0, 0, 0], max: [0, 0, 0] },
    // { [modelId]: { hiddenLayers: string[], elevation: number|null } }  (null = automática)
    cad: {},
    // tab: 'models' | 'tree' | 'props' | 'layers' | 'views'
    ui: { tab: 'models', sidebarOpen: true, dockOpen: true },
    // items: [{ id, a: [x,y,z], b: [x,y,z] }] en coordenadas de escena
    measure: { active: false, items: [] },
    // Vistas guardadas: [{ id, name, camera, state, thumb }]
    views: { items: [] },
    // --- Slices locales (no sincronizados) ---
    // Registros de modelos publicados por el servidor (ModelRecord[]); la fuente de verdad es el servidor
    modelRecords: [],
    presentation: {
      connected: false,
      role: 'viewer', // 'presenter' | 'viewer'
      clientId: null,
      active: false,
      presenterId: null,
      presenterName: '',
      isActivePresenter: false,
      viewers: 0,
      laser: true,
      viewerFreeNav: true,
      lanUrls: [],
    },
    // { modelId, expressId } | null
    hover: null,
    // Progreso de cargas: { [modelId]: { name, phase, progress, error } }
    loading: {},
  };
}

export function createStore(initial = initialState()) {
  let state = { ...initial };
  const sliceListeners = new Map();
  const allListeners = new Set();

  function notify(changes, meta) {
    for (const [slice, value] of Object.entries(changes)) {
      const set = sliceListeners.get(slice);
      if (!set) continue;
      for (const fn of [...set]) {
        try {
          fn(value.next, value.prev, meta);
        } catch (err) {
          console.error(`[store] error en suscriptor de "${slice}"`, err);
        }
      }
    }
    const flat = {};
    for (const [slice, value] of Object.entries(changes)) flat[slice] = value.next;
    for (const fn of [...allListeners]) {
      try {
        fn(flat, meta);
      } catch (err) {
        console.error('[store] error en suscriptor global', err);
      }
    }
  }

  const store = {
    get(slice) {
      return state[slice];
    },

    getAll() {
      return state;
    },

    // Reemplaza el valor completo de un slice.
    set(slice, value, meta = { source: 'local' }) {
      const prev = state[slice];
      if (prev === value) return;
      state = { ...state, [slice]: value };
      notify({ [slice]: { prev, next: value } }, normalizeMeta(meta));
    },

    // Mezcla superficial (Object.assign) sobre un slice de tipo objeto.
    patch(slice, partial, meta = { source: 'local' }) {
      const prev = state[slice];
      const next = { ...prev, ...partial };
      state = { ...state, [slice]: next };
      notify({ [slice]: { prev, next } }, normalizeMeta(meta));
    },

    // Aplica varios slices a la vez (una sola notificación global).
    setMany(slices, meta = { source: 'local' }) {
      const changes = {};
      const nextState = { ...state };
      for (const [slice, value] of Object.entries(slices)) {
        if (state[slice] === value) continue;
        changes[slice] = { prev: state[slice], next: value };
        nextState[slice] = value;
      }
      if (!Object.keys(changes).length) return;
      state = nextState;
      notify(changes, normalizeMeta(meta));
    },

    // fn(next, prev, meta). Devuelve función para desuscribirse.
    subscribe(slice, fn) {
      if (!sliceListeners.has(slice)) sliceListeners.set(slice, new Set());
      sliceListeners.get(slice).add(fn);
      return () => sliceListeners.get(slice)?.delete(fn);
    },

    // fn(changes: { [slice]: value }, meta). Devuelve función para desuscribirse.
    subscribeAll(fn) {
      allListeners.add(fn);
      return () => allListeners.delete(fn);
    },

    // Instantánea de los slices sincronizados (para el modo presentación).
    snapshot(slices = SYNCED_SLICES) {
      const out = {};
      for (const s of slices) out[s] = state[s];
      return out;
    },
  };
  return store;
}

function normalizeMeta(meta) {
  if (!meta || typeof meta !== 'object') return { source: 'local' };
  return meta.source ? meta : { ...meta, source: 'local' };
}

export const store = createStore();

// Ayudas para claves de elementos
export const elementKey = (modelId, expressId) => `${modelId}:${expressId}`;
export function parseElementKey(key) {
  const i = key.lastIndexOf(':');
  return { modelId: key.slice(0, i), expressId: Number(key.slice(i + 1)) };
}
