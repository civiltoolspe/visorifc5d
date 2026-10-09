// Doble mínimo del Viewer para probar la sincronización de forma aislada.
// Reproduce la parte del contrato que usan Presentation y ModelLoader: la estructura del DOM
// (renderer.domElement dentro de un contenedor raíz), enableInput, followCamera, setCameraState,
// getCameraState, getAspect, stopFollow y fitAll. Registra todas las llamadas en `calls`.

export class SyncViewerDouble {
  constructor(container, { bus } = {}) {
    this.bus = bus;
    this.container = container;
    if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
    this.root = document.createElement('div');
    this.root.className = 'viewer-root';
    Object.assign(this.root.style, { position: 'absolute', inset: '0', background: '#eeeeed', overflow: 'hidden' });
    this.canvas = document.createElement('canvas');
    Object.assign(this.canvas.style, { position: 'absolute', inset: '0', width: '100%', height: '100%' });
    this.root.appendChild(this.canvas);
    container.appendChild(this.root);
    this.renderer = { domElement: this.canvas };

    this.inputEnabled = true;
    this.cam = {
      position: [10, 8, 10], target: [0, 0, 0], projection: 'perspective', zoom: 1, fov: 45,
    };
    this.calls = {
      enableInput: [], followCamera: [], setCameraState: [], fitAll: 0, stopFollow: 0,
    };
  }

  getAspect() {
    return this.root.clientWidth / Math.max(1, this.root.clientHeight);
  }

  getCameraState() {
    return JSON.parse(JSON.stringify(this.cam));
  }

  setCameraState(state, opts = {}) {
    this.calls.setCameraState.push({ state: JSON.parse(JSON.stringify(state)), opts });
    this.cam = JSON.parse(JSON.stringify(state));
    return Promise.resolve();
  }

  followCamera(state) {
    this.calls.followCamera.push(JSON.parse(JSON.stringify(state)));
  }

  stopFollow() {
    this.calls.stopFollow += 1;
  }

  enableInput(enabled) {
    const on = !!enabled;
    this.calls.enableInput.push(on);
    if (on === this.inputEnabled) return;
    this.inputEnabled = on;
    this.root.dataset.locked = on ? 'false' : 'true';
    if (!on) this.bus?.emit('viewer:pointerleave');
    this.bus?.emit('viewer:input', { enabled: on });
  }

  fitAll() {
    this.calls.fitAll += 1;
  }

  // Simula lo que haría el visor real al mover la cámara del presentador
  moveCamera(partial) {
    this.cam = { ...this.cam, ...partial };
    this.bus?.emit('viewer:camera', this.getCameraState());
  }

  // Simula el movimiento del puntero sobre el visor
  movePointer(x, y) {
    this.bus?.emit('viewer:pointermove', { ndc: { x, y }, clientX: 0, clientY: 0 });
  }

  leavePointer() {
    this.bus?.emit('viewer:pointerleave');
  }
}
