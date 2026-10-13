// Cliente RPC del worker de IFC (hilo principal).
// Cada petición lleva un id; el worker responde con mensajes 'progress', 'frame', 'chunk', 'warn',
// y finalmente 'result' o 'error'.

export class IfcWorkerClient {
  constructor() {
    this.worker = null;
    this._seq = 1;
    this._pending = new Map();
  }

  _ensure() {
    if (this.worker) return;
    this.worker = new Worker(new URL('./ifc.worker.js', import.meta.url), { type: 'module' });
    this.worker.onmessage = (ev) => this._onMessage(ev.data);
    this.worker.onerror = (ev) => {
      const message = ev && ev.message ? ev.message : 'error desconocido';
      this._failAll(new Error(`El procesador de IFC (worker) falló: ${message}`));
      // se recrea en la próxima petición
      try { this.worker.terminate(); } catch { /* sin efecto */ }
      this.worker = null;
    };
    this.worker.onmessageerror = () => {
      this._failAll(new Error('El procesador de IFC devolvió un mensaje ilegible'));
    };
  }

  _failAll(err) {
    const pending = [...this._pending.values()];
    this._pending.clear();
    for (const p of pending) p.reject(err);
  }

  _onMessage(msg) {
    const p = this._pending.get(msg.id);
    if (!p) return;
    switch (msg.type) {
      case 'result':
        this._pending.delete(msg.id);
        p.resolve(msg.result);
        break;
      case 'error':
        this._pending.delete(msg.id);
        p.reject(new Error(msg.message));
        break;
      default:
        if (p.handlers && typeof p.handlers[msg.type] === 'function') {
          try {
            p.handlers[msg.type](msg);
          } catch (err) {
            // un error en un manejador aborta la carga para no dejar el modelo a medias
            this._pending.delete(msg.id);
            p.reject(err);
          }
        }
    }
  }

  request(payload, { transfer = [], handlers = null } = {}) {
    this._ensure();
    const id = this._seq++;
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject, handlers });
      try {
        this.worker.postMessage({ id, ...payload }, transfer);
      } catch (err) {
        this._pending.delete(id);
        reject(err);
      }
    });
  }

  // Carga un IFC. handlers: { progress({phase,p}), frame({frame}), chunk({chunk}), warn({message}) }
  // El ArrayBuffer se transfiere al worker (queda inutilizable en el hilo principal).
  load(modelId, buffer, handlers, options = {}) {
    return this.request({ op: 'load', modelId, buffer, options }, { transfer: [buffer], handlers });
  }

  properties(modelId, expressId) {
    return this.request({ op: 'properties', modelId, expressId });
  }

  close(modelId) {
    if (!this.worker) return Promise.resolve(true);
    return this.request({ op: 'close', modelId }).catch(() => false);
  }

  dispose() {
    this._failAll(new Error('Worker de IFC liberado'));
    if (this.worker) this.worker.terminate();
    this.worker = null;
  }
}
