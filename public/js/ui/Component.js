// Base de los componentes de la UI.
//
// Principio: TODO lo que está en slices sincronizados (pestaña, selección, visibilidad...) se
// dibuja desde el store; en modo presentación el espectador replica el store del presentador y
// su UI debe verse igual. Los componentes se suscriben, agrupan los cambios del mismo ciclo en
// un solo render() y nunca guardan copia local de esos estados.

import { microBatch } from './dom.js';

export class Component {
  constructor(ui) {
    this.ui = ui;
    this.ctx = ui.ctx;
    this.store = ui.store;
    this.bus = ui.bus;
    this.actions = ui.actions;
    this.el = null;
    this._offs = [];
    this._disposed = false;
    this.schedule = microBatch(() => {
      if (!this._disposed) this.render();
    });
  }

  // Suscripción a uno o varios slices; llama a schedule() (render agrupado) o a fn.
  watch(slices, fn = null) {
    const list = Array.isArray(slices) ? slices : [slices];
    for (const slice of list) {
      this._offs.push(this.store.subscribe(slice, (next, prev, meta) => (fn ? fn(next, prev, meta, slice) : this.schedule())));
    }
  }

  // Suscripción a eventos del bus (por defecto vuelve a dibujar).
  onBus(events, fn = null) {
    const list = Array.isArray(events) ? events : [events];
    for (const evt of list) this._offs.push(this.bus.on(evt, fn ? (p) => fn(p, evt) : () => this.schedule()));
  }

  listen(target, type, fn, options) {
    target.addEventListener(type, fn, options);
    this._offs.push(() => target.removeEventListener(type, fn, options));
  }

  addCleanup(fn) {
    this._offs.push(fn);
  }

  render() {}

  dispose() {
    this._disposed = true;
    for (const off of this._offs.splice(0)) {
      try {
        off();
      } catch (err) {
        console.warn('[ui] limpieza', err);
      }
    }
    this.el?.remove();
  }
}
