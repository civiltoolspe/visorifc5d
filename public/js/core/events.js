// Bus de eventos mínimo compartido por todos los módulos.
// Uso: const off = bus.on('viewer:click', fn); bus.emit('viewer:click', payload); off();

export class EventBus {
  constructor() {
    this._handlers = new Map();
  }

  on(event, fn) {
    if (!this._handlers.has(event)) this._handlers.set(event, new Set());
    this._handlers.get(event).add(fn);
    return () => this.off(event, fn);
  }

  once(event, fn) {
    const off = this.on(event, (payload) => {
      off();
      fn(payload);
    });
    return off;
  }

  off(event, fn) {
    const set = this._handlers.get(event);
    if (set) set.delete(fn);
  }

  emit(event, payload) {
    const set = this._handlers.get(event);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        fn(payload);
      } catch (err) {
        console.error(`[bus] error en manejador de "${event}"`, err);
      }
    }
  }
}

export const bus = new EventBus();
