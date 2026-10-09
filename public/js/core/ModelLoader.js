// Cargador de modelos (ver docs/ARQUITECTURA.md, sección 5).
//
//   const loader = new ModelLoader({ api, store, bus, ifc, cad, viewer });
//   loader.start();              // api.listModels() + escucha de 'server:models'
//   loader.reconcile(records);   // carga nuevos (cola secuencial), descarga eliminados,
//                                // aplica cambios de georreferencia y de unidades CAD
//   loader.uploadFiles(files);   // presentador: sube archivos en serie con progreso
//   loader.isLoaded(id);
//
// Mantiene store.modelRecords y store.loading[modelId] = { name, kind, phase, progress, error? }
// (phase: 'upload' | 'download' | 'parse' | 'done' | 'error'). Emite en el bus: 'model:loaded'
// { modelId, kind, model }, 'model:unloaded' { modelId, kind }, 'model:error' { modelId, error }
// y 'toast'.

const EXT_KIND = { '.ifc': 'ifc', '.dxf': 'dxf', '.dwg': 'dwg' };
const PROGRESS_MIN_STEP = 0.01; // cambio mínimo de progreso que se publica en el store
const PROGRESS_MIN_MS = 80; // o tiempo mínimo entre publicaciones

const SYSTEM = { source: 'system' };

const clamp01 = (v) => Math.max(0, Math.min(1, Number.isFinite(Number(v)) ? Number(v) : 0));

function extensionOf(name) {
  const m = /\.[^./\\]+$/.exec(String(name || ''));
  return m ? m[0].toLowerCase() : '';
}

function errorMessage(err) {
  if (!err) return 'Error desconocido';
  if (typeof err === 'string') return err;
  return err.message || String(err);
}

// Claves para detectar cambios relevantes de un registro
function georefKey(rec) {
  const g = rec?.georef;
  if (!g) return 'null';
  return [g.eastings, g.northings, g.height, g.rotationDeg, g.scale].join('|');
}

function unitsKey(rec) {
  return rec?.cad?.units || 'auto';
}

function recordSignature(rec) {
  return [rec.kind, rec.size, rec.uploadedAt, georefKey(rec), unitsKey(rec)].join('#');
}

export class ModelLoader {
  constructor({ api, store, bus, ifc, cad, viewer }) {
    this.api = api;
    this.store = store;
    this.bus = bus;
    this.ifc = ifc;
    this.cad = cad;
    this.viewer = viewer;

    this._records = new Map(); // id -> ModelRecord más reciente
    this._loaded = new Map(); // id -> { record, kind, model } (record = el usado al cargar o actualizado después)
    this._queue = []; // ids pendientes de cargar (cola secuencial)
    this._current = null; // { id, record, controller, cancelled } carga en curso
    this._draining = false;
    this._failed = new Map(); // id -> { sig, phase } fallos que no se reintentan mientras el registro no cambie
    this._fitted = false; // ya se encuadró tras el primer modelo
    this._uploadSeq = 0;
    this._uploadChain = Promise.resolve(); // las subidas se encadenan: una a la vez
    this._pushes = 0; // mensajes 'server:models' recibidos (para descartar un listado HTTP desfasado)
    this._started = false;
    this._offs = [];
  }

  // ---------- API pública ----------

  async start() {
    if (this._started) return;
    this._started = true;
    this._offs.push(
      this.bus.on('server:models', (records) => {
        this._pushes += 1;
        this.reconcile(records);
      }),
      // Al reconectar se reintentan las descargas que fallaron por la red
      this.bus.on('sync:status', (e) => {
        if (e?.connected) this.retryFailed({ onlyDownload: true });
      }),
    );
    const pushesBefore = this._pushes;
    try {
      const records = await this.api.listModels();
      // Si mientras tanto el servidor difundió su lista, esa es más reciente que este listado
      if (this._pushes === pushesBefore) this.reconcile(records);
    } catch (err) {
      this._toast('error', `No se pudo obtener la lista de modelos: ${errorMessage(err)}`);
    }
  }

  isLoaded(id) {
    return this._loaded.has(id);
  }

  getLoaded(id) {
    return this._loaded.get(id)?.model ?? null;
  }

  // Sincroniza el estado local con la lista de registros del servidor.
  reconcile(records) {
    if (!Array.isArray(records)) return;
    const list = records.filter((r) => r && typeof r.id === 'string' && r.id);
    this._records = new Map(list.map((r) => [r.id, r]));
    if (JSON.stringify(this.store.get('modelRecords')) !== JSON.stringify(list)) {
      this.store.set('modelRecords', list, SYSTEM);
    }

    // 1) Eliminados: cargados, en cola, en curso o con error
    for (const id of [...this._loaded.keys()]) if (!this._records.has(id)) this._removeModel(id);
    for (const id of [...this._failed.keys()]) {
      if (this._records.has(id)) continue;
      this._failed.delete(id);
      this._clearLoading(id);
    }
    const queued = this._queue.filter((id) => !this._records.has(id));
    this._queue = this._queue.filter((id) => this._records.has(id));
    for (const id of queued) this._forgetModelState(id);
    if (this._current && !this._records.has(this._current.id)) this._cancelCurrent();

    // 2) Cambios en los cargados y altas nuevas (en el orden del servidor)
    for (const rec of list) {
      const entry = this._loaded.get(rec.id);
      if (entry) {
        this._applyRecordChange(entry, rec);
        continue;
      }
      if (this._current?.id === rec.id || this._queue.includes(rec.id)) continue;
      const failed = this._failed.get(rec.id);
      if (failed && failed.sig === recordSignature(rec)) continue; // sin cambios: no se reintenta
      this._failed.delete(rec.id);
      this._enqueue(rec);
    }
    this._drain();
  }

  // Vuelve a intentar los modelos que fallaron (onlyDownload: solo fallos de red/descarga).
  retryFailed({ onlyDownload = false } = {}) {
    let any = false;
    for (const [id, f] of [...this._failed]) {
      if (onlyDownload && f.phase !== 'download') continue;
      const rec = this._records.get(id);
      this._failed.delete(id);
      if (!rec) continue;
      this._enqueue(rec);
      any = true;
    }
    if (any) this._drain();
  }

  // Sube archivos en serie (también entre llamadas sucesivas). Devuelve los ModelRecord creados.
  uploadFiles(files) {
    const list = Array.from(files || []);
    const run = () => this._uploadNow(list);
    const result = this._uploadChain.then(run, run);
    this._uploadChain = result.catch(() => {});
    return result;
  }

  async _uploadNow(list) {
    if (!list.length) return [];
    if (this.store.get('presentation')?.role === 'viewer') {
      this._toast('warning', 'Solo el presentador puede cargar modelos.');
      return [];
    }
    const valid = [];
    const rejected = [];
    for (const file of list) {
      if (EXT_KIND[extensionOf(file?.name)]) valid.push(file);
      else rejected.push(file?.name || 'archivo sin nombre');
    }
    if (rejected.length) {
      const names = rejected.slice(0, 3).join(', ') + (rejected.length > 3 ? '…' : '');
      this._toast(
        'warning',
        rejected.length === 1
          ? `"${names}" no es un formato compatible. Usa archivos .ifc, .dxf o .dwg.`
          : `${rejected.length} archivos no son compatibles (${names}). Usa archivos .ifc, .dxf o .dwg.`,
      );
    }

    const created = [];
    for (const file of valid) {
      const tempId = `upload-${++this._uploadSeq}`;
      const kind = EXT_KIND[extensionOf(file.name)];
      this._setLoading(tempId, { name: file.name, kind, phase: 'upload', progress: 0 });
      try {
        let last = 0;
        const rec = await this.api.uploadModel(file, (loaded, total) => {
          const p = total ? clamp01(loaded / total) : 0;
          if (p - last >= PROGRESS_MIN_STEP || p === 1) {
            last = p;
            this._setLoading(tempId, { progress: p });
          }
        });
        created.push(rec);
        this._toast('success', `"${file.name}" se subió correctamente.`);
        // Sin esperar al aviso del servidor (o si el WebSocket no está conectado): se incorpora ya
        if (rec?.id && !this._records.has(rec.id)) this.reconcile([...this._records.values(), rec]);
      } catch (err) {
        this._toast('error', `No se pudo subir "${file.name}": ${errorMessage(err)}`);
      } finally {
        this._clearLoading(tempId);
      }
    }
    return created;
  }

  dispose() {
    for (const off of this._offs) off();
    this._offs = [];
  }

  // ---------- Cola de carga ----------

  _enqueue(rec) {
    if (this._queue.includes(rec.id)) return;
    this._queue.push(rec.id);
    this._setLoading(rec.id, { name: rec.name, kind: rec.kind, phase: 'download', progress: 0, queued: true, error: undefined });
  }

  async _drain() {
    if (this._draining) return;
    this._draining = true;
    try {
      while (this._queue.length) {
        const id = this._queue.shift();
        const rec = this._records.get(id);
        if (!rec || this._loaded.has(id)) continue;
        await this._loadOne(rec);
      }
    } finally {
      this._draining = false;
    }
  }

  async _loadOne(rec) {
    const id = rec.id;
    const job = { id, record: rec, controller: new AbortController(), cancelled: false };
    this._current = job;
    const base = { name: rec.name, kind: rec.kind, queued: false, error: undefined };
    this._setLoading(id, { ...base, phase: 'download', progress: 0 });
    let phase = 'download';
    try {
      if (!EXT_KIND[`.${rec.kind}`]) throw new Error(`Tipo de modelo no soportado: ${rec.kind}`);
      // 1) Descarga con progreso
      const emit = this._throttledProgress(id);
      const buffer = await this.api.downloadModel(
        id,
        (loaded, total) => emit(clamp01(loaded / (total || rec.size || loaded || 1))),
        { signal: job.controller.signal },
      );
      if (job.cancelled) return this._abandonar(job);

      // 2) Procesamiento
      phase = 'parse';
      this._setLoading(id, { phase: 'parse', progress: 0 });
      const emitParse = this._throttledProgress(id);
      const onProgress = (stage, p) => {
        if (job.cancelled) return;
        emitParse(clamp01(p), stage);
      };
      const model = rec.kind === 'ifc'
        ? await this.ifc.load(rec, buffer, onProgress)
        : await this.cad.load(rec, buffer, onProgress);
      if (job.cancelled) return this._abandonar(job, { loaded: true });

      // 3) Registro del modelo cargado
      this._loaded.set(id, { record: rec, kind: rec.kind, model });
      this._failed.delete(id);
      this._ensureModelState(id);
      this._setLoading(id, { phase: 'done', progress: 1, stage: undefined });
      this.bus.emit('model:loaded', { modelId: id, kind: rec.kind, model });
      this._fitFirst();

      // Si el registro cambió mientras se cargaba (georreferencia, unidades), se aplica ahora
      const latest = this._records.get(id);
      if (latest && latest !== rec) this._applyRecordChange(this._loaded.get(id), latest);
    } catch (err) {
      if (job.cancelled || err?.cancelled) return this._abandonar(job, { loaded: this._hasInManager(rec) });
      const message = errorMessage(err);
      // Ya se informa con 'model:error', store.loading y un aviso: en consola basta una advertencia
      console.warn(`[loader] error cargando "${rec.name}"`, err);
      this._failed.set(id, { sig: recordSignature(this._records.get(id) || rec), phase });
      this._setLoading(id, { name: rec.name, kind: rec.kind, phase: 'error', progress: 0, error: message, queued: false });
      this.bus.emit('model:error', { modelId: id, error: message, message, name: rec.name });
      this._toast('error', `No se pudo cargar "${rec.name}": ${message}`);
    } finally {
      if (this._current === job) this._current = null;
    }
  }

  // Publica el progreso en el store con límite de frecuencia para no saturar a la UI.
  _throttledProgress(id) {
    let lastP = -1;
    let lastT = 0;
    return (p, stage) => {
      const now = performance.now();
      if (lastP >= 0 && p < 1 && (p - lastP < PROGRESS_MIN_STEP || now - lastT < PROGRESS_MIN_MS)) return;
      const cur = this.store.get('loading')[id];
      if (!cur || cur.phase === 'done' || cur.phase === 'error') return;
      lastP = p;
      lastT = now;
      this._setLoading(id, stage ? { progress: p, stage } : { progress: p });
    };
  }

  _hasInManager(rec) {
    try {
      return rec.kind === 'ifc' ? !!this.ifc.has?.(rec.id) : !!this.cad.has?.(rec.id);
    } catch {
      return false;
    }
  }

  // La carga en curso dejó de ser necesaria (modelo eliminado): se limpia lo que haya quedado
  _abandonar(job, { loaded = false } = {}) {
    if (loaded) this._unloadFromManager(job.record.kind, job.id);
    if (this._records.has(job.id)) {
      // No se eliminó: se descartó por otra razón (p. ej. recarga solicitada); se vuelve a encolar si falta
      if (!this._loaded.has(job.id) && !this._queue.includes(job.id)) this._enqueue(this._records.get(job.id));
      return;
    }
    this._forgetModelState(job.id);
  }

  _cancelCurrent() {
    const job = this._current;
    if (!job) return;
    job.cancelled = true;
    try {
      job.controller.abort();
    } catch { /* sin soporte de cancelación */ }
    // Los gestores cancelan el procesamiento en curso al descargar el modelo
    this._unloadFromManager(job.record.kind, job.id);
    this._forgetModelState(job.id);
  }

  // ---------- Cambios y descarga ----------

  _applyRecordChange(entry, rec) {
    const prev = entry.record;
    entry.record = rec;
    if (entry.kind === 'ifc') {
      if (georefKey(prev) === georefKey(rec)) return;
      try {
        this.ifc.updateGeoref(rec.id, rec.georef ?? null);
      } catch (err) {
        console.error('[loader] updateGeoref falló', err);
        this._toast('error', `No se pudo aplicar la georreferencia de "${rec.name}": ${errorMessage(err)}`);
      }
      return;
    }
    // CAD: un cambio de unidades exige reprocesar el archivo
    if (unitsKey(prev) !== unitsKey(rec)) this._reloadModel(rec.id);
  }

  _reloadModel(id) {
    const entry = this._loaded.get(id);
    const rec = this._records.get(id);
    if (!entry || !rec) return;
    this._unloadFromManager(entry.kind, id);
    this._loaded.delete(id);
    this.bus.emit('model:unloaded', { modelId: id, kind: entry.kind });
    // Se conservan models[id] y cad[id] (visibilidad y capas ocultas) y se carga de nuevo
    this._queue = this._queue.filter((q) => q !== id);
    this._queue.unshift(id);
    this._setLoading(id, { name: rec.name, kind: rec.kind, phase: 'download', progress: 0, queued: true, error: undefined });
  }

  // El registro desapareció del servidor: se descarga y se limpia todo su estado
  _removeModel(id) {
    const entry = this._loaded.get(id);
    if (!entry) return;
    this._unloadFromManager(entry.kind, id);
    this._loaded.delete(id);
    this._forgetModelState(id);
    this.bus.emit('model:unloaded', { modelId: id, kind: entry.kind });
    if (!this._loaded.size) this._fitted = false; // el siguiente primer modelo vuelve a encuadrarse
  }

  _unloadFromManager(kind, id) {
    try {
      if (kind === 'ifc') this.ifc.unload(id);
      else this.cad.unload(id);
    } catch (err) {
      console.error(`[loader] no se pudo descargar "${id}"`, err);
    }
  }

  _fitFirst() {
    if (this._fitted) return;
    this._fitted = true;
    const p = this.store.get('presentation') || {};
    // Un espectador en una presentación activa sigue la cámara del presentador
    if (p.active && !p.isActivePresenter) return;
    try {
      this.viewer.fitAll();
    } catch (err) {
      console.error('[loader] fitAll falló', err);
    }
  }

  // ---------- Estado en el store ----------

  _setLoading(id, partial) {
    const cur = this.store.get('loading') || {};
    const next = { ...cur[id], ...partial };
    for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k];
    this.store.set('loading', { ...cur, [id]: next }, SYSTEM);
  }

  _clearLoading(id) {
    const cur = this.store.get('loading') || {};
    if (!(id in cur)) return;
    const { [id]: _quitado, ...rest } = cur;
    this.store.set('loading', rest, SYSTEM);
  }

  // models[id] = { visible: true } si no existe
  _ensureModelState(id) {
    const models = this.store.get('models') || {};
    if (models[id]) return;
    this.store.set('models', { ...models, [id]: { visible: true } }, SYSTEM);
  }

  // Limpia loading, models y las referencias al modelo en selección, visibilidad y nivel activo
  _forgetModelState(id) {
    this._clearLoading(id);
    const { store } = this;

    const models = store.get('models') || {};
    if (id in models) {
      const { [id]: _m, ...rest } = models;
      store.set('models', rest, SYSTEM);
    }

    const selection = store.get('selection');
    if (selection?.items?.some((it) => it.modelId === id)) {
      store.set('selection', { items: selection.items.filter((it) => it.modelId !== id) }, SYSTEM);
    }

    const vis = store.get('visibility');
    if (vis && (id in (vis.hidden || {}) || (vis.isolated && id in vis.isolated))) {
      const { [id]: _h, ...hidden } = vis.hidden || {};
      let isolated = vis.isolated;
      if (isolated && id in isolated) {
        const { [id]: _i, ...restIso } = isolated;
        // Si solo se aislaba este modelo, deja de haber aislamiento (un objeto vacío ocultaría todo)
        isolated = Object.keys(restIso).length ? restIso : null;
      }
      store.set('visibility', { ...vis, hidden, isolated }, SYSTEM);
    }

    const storey = store.get('storey');
    if (storey?.active?.modelId === id) store.set('storey', { ...storey, active: null }, SYSTEM);

    const hover = store.get('hover');
    if (hover?.modelId === id) store.set('hover', null, SYSTEM);
  }

  _toast(type, message) {
    this.bus.emit('toast', { type, message });
  }
}
