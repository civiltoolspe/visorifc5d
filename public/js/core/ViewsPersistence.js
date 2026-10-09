// Persistencia de las vistas guardadas (store.views) en el servidor, para que no se pierdan al recargar la página,
// al abrir la app desde otro navegador o al reiniciar el servidor.
//
//   const persistence = new ViewsPersistence({ api, store, bus });
//   await persistence.start();     // carga las vistas del servidor y empieza a guardar los cambios del presentador
//   await persistence.flush();     // guarda ya lo pendiente (pruebas)
//   persistence.dispose();
//
// - Cualquier PC carga las vistas guardadas al arrancar (si no hay una presentación que ya las controle).
// - Solo el presentador las guarda (PUT /api/views); los cambios 'remote' (estado recibido del presentador) y
//   'system' (la propia carga) nunca se vuelven a enviar.
// - Los cambios se agrupan (~500 ms) y nunca hay dos guardados a la vez.

const SAVE_DELAY_MS = 500;

export class ViewsPersistence {
  constructor({ api, store, bus, delay = SAVE_DELAY_MS } = {}) {
    this.api = api;
    this.store = store;
    this.bus = bus;
    this.delay = delay;
    this.loaded = false;
    this._dirty = false; // hubo cambios locales antes de terminar la carga o con un guardado en curso
    this._timer = null;
    this._saving = null;
    this._warned = false;
    this._unsub = store.subscribe('views', (next, prev, meta) => this._onViews(next, meta));
  }

  _isPresenter() {
    return this.store.get('presentation').role === 'presenter';
  }

  async start() {
    let items = [];
    try {
      items = await this.api.getViews();
    } catch (err) {
      console.warn('[vistas] no se pudieron cargar las vistas guardadas:', err?.message || err);
    }
    this.loaded = true;
    const pres = this.store.get('presentation');
    const followingOther = !!pres.active && !pres.isActivePresenter; // el presentador manda su propia lista
    const local = this.store.get('views').items || [];
    if (!followingOther && items.length) {
      // Lo guardado va primero; lo creado localmente mientras cargaba se conserva detrás
      const known = new Set(items.map((v) => v.id));
      const merged = [...items, ...local.filter((v) => !known.has(v.id))];
      this.store.set('views', { ...this.store.get('views'), items: merged }, { source: 'system' });
    }
    if (this._dirty) this._schedule();
    return this.store.get('views').items;
  }

  _onViews(next, meta) {
    if (!meta || meta.source === 'remote' || meta.source === 'system') return;
    if (!this._isPresenter()) return;
    this._dirty = true;
    if (this.loaded) this._schedule();
  }

  _schedule() {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.flush(), this.delay);
  }

  // Guarda ahora si hay cambios. Devuelve una promesa que se resuelve cuando no queda nada pendiente.
  async flush() {
    clearTimeout(this._timer);
    this._timer = null;
    if (this._saving) {
      await this._saving;
      if (this._dirty) return this.flush();
      return undefined;
    }
    if (!this._dirty || !this.loaded || !this._isPresenter()) return undefined;
    this._dirty = false;
    const items = this.store.get('views').items || [];
    this._saving = this.api
      .putViews(items)
      .then(() => {
        this._warned = false;
      })
      .catch((err) => {
        this._dirty = true;
        console.warn('[vistas] no se pudieron guardar:', err?.message || err);
        if (!this._warned) {
          this._warned = true;
          this.bus?.emit('toast', { type: 'warning', message: `No se pudieron guardar las vistas en el servidor: ${err?.message || 'error desconocido'}` });
        }
      })
      .finally(() => {
        this._saving = null;
      });
    await this._saving;
    // Si falló, se reintenta en el siguiente cambio (no en bucle); si llegaron cambios durante el guardado, se repite
    if (this._dirty && !this._warned) return this.flush();
    return undefined;
  }

  dispose() {
    clearTimeout(this._timer);
    this._unsub?.();
  }
}
