// Modo presentación (ver docs/ARQUITECTURA.md, sección 9).
//
//   const presentation = new Presentation({ sync, store, bus, viewer });
//   presentation.start(); presentation.stop(); presentation.toggle();
//   presentation.takeControl(); presentation.setLaser(true);
//
// Presentador ACTIVO: al activarse envía el estado completo y la cámara; después difunde
//   - los cambios de SYNCED_SLICES cuyo meta.source no sea 'remote' (agrupados ~30 ms, solo
//     los slices que cambiaron),
//   - la cámara ('viewer:camera', máx. ~20 Hz con envío final al detenerse),
//   - el puntero láser ('viewer:pointermove', máx. ~30 Hz; visible:false al salir del visor).
// ESPECTADOR (rol viewer, o presentador que no es el activo) con presentación activa: aplica
//   el estado con source 'remote', sigue la cámara con viewer.followCamera y dibuja el láser.
// Bloqueo de interacción: viewer.enableInput(false) según el rol y el estado de la presentación.
// La capa visual de bloqueo es responsabilidad de la UI (lee store.presentation).

import { SYNCED_SLICES } from '../core/store.js';
import { LaserPointer } from './LaserPointer.js';

const SYNCED = new Set(SYNCED_SLICES);

const STATE_FLUSH_MS = 30; // agrupación de cambios del store
const CAMERA_MIN_MS = 50; // ~20 Hz
const POINTER_MIN_MS = 33; // ~30 Hz
const POINTER_BEAT_MS = 1000; // reenvío del puntero quieto para que el espectador no lo oculte (caduca a los 3 s)

export class Presentation {
  constructor({ sync, store, bus, viewer }) {
    this.sync = sync;
    this.store = store;
    this.bus = bus;
    this.viewer = viewer;
    this.laser = new LaserPointer({ viewer });

    // Estado derivado
    this._broadcasting = false;
    this._following = false;
    this._locked = null; // null = aún no aplicado
    this._stopRequested = false;
    this._laserOn = !!store.get('presentation')?.laser;

    // Difusión
    this._pending = new Set(); // slices con cambios pendientes de enviar
    this._flushTimer = null;
    this._camPending = null;
    this._camTimer = null;
    this._camLast = 0;
    this._ptr = null; // último puntero local { x, y }
    this._ptrTimer = null;
    this._ptrLast = 0;
    this._ptrBeat = null;
    this._ptrVisible = false; // último estado enviado

    this._offs = [
      store.subscribe('presentation', () => this._refresh()),
      store.subscribeAll((changes, meta) => this._onStoreChange(changes, meta)),
      bus.on('viewer:camera', (cam) => this._onViewerCamera(cam)),
      bus.on('viewer:pointermove', (e) => this._onViewerPointer(e)),
      bus.on('viewer:pointerleave', () => this._onViewerPointerLeave()),
      bus.on('sync:welcome', (msg) => this._onWelcome(msg)),
      bus.on('sync:presentation', (msg) => this._onSyncPresentation(msg)),
      bus.on('sync:error', () => this._onSyncError()),
      bus.on('sync:state', (msg) => this._onSyncState(msg)),
      bus.on('sync:camera', (msg) => this._onSyncCamera(msg)),
      bus.on('sync:pointer', (msg) => this._onSyncPointer(msg)),
      bus.on('sync:status', (e) => this._onSyncStatus(e)),
    ];

    this._refresh();
  }

  // ---------- API pública ----------

  get isBroadcasting() {
    return this._broadcasting;
  }

  get isFollowing() {
    return this._following;
  }

  get isLocked() {
    return !!this._locked;
  }

  // Inicia la presentación. Si ya hay otra activa, toma el control de ella.
  start() {
    const p = this.store.get('presentation');
    if (!this._puedePresentar(p, 'iniciar una presentación')) return false;
    if (p.active) return p.isActivePresenter ? true : this.takeControl();
    return this.sync.startPresentation();
  }

  // Detiene la presentación activa (propia o, siendo presentador, la de otro presentador).
  stop() {
    const p = this.store.get('presentation');
    if (p.role !== 'presenter' || !p.active) return false;
    if (this._broadcasting) {
      // Se corta la difusión ya: no se debe enviar nada tras pedir el fin
      this._stopRequested = true;
      this._refresh();
    }
    return this.sync.stopPresentation();
  }

  toggle() {
    const p = this.store.get('presentation');
    if (p.active && p.isActivePresenter) return this.stop();
    return this.start();
  }

  // Toma el control de una presentación activa de otro presentador.
  takeControl() {
    const p = this.store.get('presentation');
    if (!this._puedePresentar(p, 'tomar el control')) return false;
    if (!p.active) return this.sync.startPresentation();
    if (p.isActivePresenter) return true;
    return this.sync.takeControl();
  }

  // Comprueba rol y conexión antes de pedir algo al servidor; avisa al usuario si no se puede
  _puedePresentar(p, accion) {
    if (p.role !== 'presenter') {
      this.bus.emit('toast', { type: 'warning', message: `Solo el presentador puede ${accion}.` });
      return false;
    }
    if (!p.connected) {
      this.bus.emit('toast', { type: 'warning', message: 'Sin conexión con el servidor: no se puede presentar ahora.' });
      return false;
    }
    return true;
  }

  setLaser(on) {
    this.store.patch('presentation', { laser: !!on }, { source: 'system' });
  }

  dispose() {
    for (const off of this._offs) off();
    this._offs = [];
    this._cancelarEnvios();
    this.laser.dispose();
  }

  // ---------- Estado derivado ----------

  _refresh() {
    const p = this.store.get('presentation');
    const broadcasting = !!(p.active && p.isActivePresenter) && !this._stopRequested;
    const following = !!p.active && !p.isActivePresenter;
    // Bloqueado: espectador con presentación activa (o sin navegación libre) / presentador que
    // no es el activo mientras otro presenta
    const locked =
      (p.role === 'viewer' && (!!p.active || p.viewerFreeNav === false)) ||
      (p.role !== 'viewer' && following);

    if (locked !== this._locked) {
      this._locked = locked;
      try {
        this.viewer.enableInput(!locked);
      } catch (err) {
        console.error('[presentation] enableInput falló', err);
      }
    }

    if (following !== this._following) {
      this._following = following;
      if (following) this._alEmpezarASeguir();
      else this._alDejarDeSeguir();
    }

    if (broadcasting !== this._broadcasting) {
      this._broadcasting = broadcasting;
      if (broadcasting) this._alEmpezarADifundir();
      else this._alDejarDeDifundir();
    }

    const laserOn = !!p.laser;
    if (laserOn !== this._laserOn) {
      this._laserOn = laserOn;
      if (!laserOn) this._alApagarLaser();
    }
  }

  // ---------- Presentador activo: difusión ----------

  _alEmpezarADifundir() {
    this._cancelarEnvios();
    this._stopFollow();
    this.laser.hide();
    this.sync.sendState(this.store.snapshot(), true);
    let cam = null;
    try {
      cam = this.viewer.getCameraState();
    } catch (err) {
      console.error('[presentation] getCameraState falló', err);
    }
    if (cam) {
      this._camLast = performance.now();
      this.sync.sendCamera(cam);
    }
  }

  _alDejarDeDifundir() {
    // No se envía nada más
    this._cancelarEnvios();
  }

  _cancelarEnvios() {
    clearTimeout(this._flushTimer);
    clearTimeout(this._camTimer);
    clearTimeout(this._ptrTimer);
    clearInterval(this._ptrBeat);
    this._flushTimer = this._camTimer = this._ptrTimer = this._ptrBeat = null;
    this._pending.clear();
    this._camPending = null;
    this._ptr = null;
    this._ptrVisible = false;
  }

  _onStoreChange(changes, meta) {
    if (!this._broadcasting) return;
    if (meta?.source === 'remote') return; // evita el eco de lo recibido
    let any = false;
    for (const slice of Object.keys(changes)) {
      if (!SYNCED.has(slice)) continue;
      this._pending.add(slice);
      any = true;
    }
    if (any && !this._flushTimer) this._flushTimer = setTimeout(() => this._flushState(), STATE_FLUSH_MS);
  }

  _flushState() {
    this._flushTimer = null;
    if (!this._broadcasting || !this._pending.size) {
      this._pending.clear();
      return;
    }
    const slices = {};
    for (const slice of this._pending) slices[slice] = this.store.get(slice);
    this._pending.clear();
    this.sync.sendState(slices, false);
  }

  _onViewerCamera(cam) {
    if (!this._broadcasting || !cam) return;
    this._camPending = cam;
    if (this._camTimer) return; // ya hay un envío final programado: llevará la última cámara
    const wait = CAMERA_MIN_MS - (performance.now() - this._camLast);
    if (wait <= 0) this._flushCamera();
    else this._camTimer = setTimeout(() => this._flushCamera(), wait);
  }

  _flushCamera() {
    this._camTimer = null;
    if (!this._broadcasting || !this._camPending) return;
    const cam = this._camPending;
    this._camPending = null;
    this._camLast = performance.now();
    this.sync.sendCamera(cam);
  }

  _onViewerPointer(e) {
    if (!this._broadcasting || !this._laserOn) return;
    const ndc = e?.ndc;
    if (!ndc || !Number.isFinite(ndc.x) || !Number.isFinite(ndc.y)) return;
    this._ptr = { x: ndc.x, y: ndc.y };
    if (this._ptrTimer) return;
    const wait = POINTER_MIN_MS - (performance.now() - this._ptrLast);
    if (wait <= 0) this._flushPointer();
    else this._ptrTimer = setTimeout(() => this._flushPointer(), wait);
  }

  _punteroActual(visible) {
    let aspect = 1;
    try {
      aspect = this.viewer.getAspect();
    } catch { /* se usa 1 */ }
    return { x: this._ptr?.x ?? 0, y: this._ptr?.y ?? 0, aspect, visible };
  }

  _flushPointer() {
    this._ptrTimer = null;
    if (!this._broadcasting || !this._laserOn || !this._ptr) return;
    this._ptrLast = performance.now();
    this._ptrVisible = true;
    this.sync.sendPointer(this._punteroActual(true));
    // Latido: con el puntero quieto se reenvía para que el espectador no lo oculte por inactividad
    if (!this._ptrBeat) {
      this._ptrBeat = setInterval(() => {
        if (!this._broadcasting || !this._laserOn || !this._ptrVisible || !this._ptr) return;
        this.sync.sendPointer(this._punteroActual(true));
      }, POINTER_BEAT_MS);
    }
  }

  _onViewerPointerLeave() {
    if (!this._broadcasting) return;
    this._ocultarPunteroRemoto(false);
  }

  _alApagarLaser() {
    // Con el láser desactivado no se envía puntero; se avisa una vez para ocultar el actual
    if (this._broadcasting) this._ocultarPunteroRemoto(true);
  }

  // Cancela el puntero pendiente y avisa a los espectadores de que ya no es visible.
  // force: envía el mensaje aunque no se hubiera enviado ningún puntero visible.
  _ocultarPunteroRemoto(force) {
    clearTimeout(this._ptrTimer);
    clearInterval(this._ptrBeat);
    this._ptrTimer = this._ptrBeat = null;
    const estabaVisible = this._ptrVisible;
    this._ptrVisible = false;
    if (estabaVisible || force) this.sync.sendPointer(this._punteroActual(false));
    this._ptr = null;
  }

  // ---------- Espectador: aplicación de lo recibido ----------

  _alEmpezarASeguir() {
    this.laser.hide();
  }

  _alDejarDeSeguir() {
    this.laser.hide();
    this._stopFollow();
  }

  _stopFollow() {
    try {
      this.viewer.stopFollow?.();
    } catch { /* el visor puede no implementarlo */ }
  }

  _aplicarEstado(slices) {
    if (!slices || typeof slices !== 'object') return;
    const filtered = {};
    for (const [slice, value] of Object.entries(slices)) {
      if (SYNCED.has(slice)) filtered[slice] = value;
    }
    if (Object.keys(filtered).length) this.store.setMany(filtered, { source: 'remote' });
  }

  _onWelcome(msg) {
    this._stopRequested = false;
    this._refresh();
    if (!this._following) return;
    // Al entrar (o reconectar) durante una presentación se adopta ya su estado y su cámara
    this._aplicarEstado(msg?.state);
    if (msg?.camera) {
      try {
        this.viewer.setCameraState(msg.camera, { smooth: false });
      } catch (err) {
        console.error('[presentation] setCameraState falló', err);
      }
    }
  }

  _onSyncPresentation(msg) {
    // El fin pedido queda atendido cuando el servidor informa de otro estado que "presento yo".
    // (Un mensaje anterior a la confirmación, aún con presentación propia activa, no lo anula.)
    const miId = this.store.get('presentation').clientId;
    if (!msg?.active || msg.presenterId !== miId) this._stopRequested = false;
    this._refresh();
  }

  // Si el servidor rechazó el fin pedido, se reanuda según el estado real
  _onSyncError() {
    if (!this._stopRequested) return;
    this._stopRequested = false;
    this._refresh();
  }

  _onSyncStatus(e) {
    if (e && e.connected === false) {
      this._stopRequested = false;
      this._refresh();
    }
  }

  _onSyncState(msg) {
    if (!this._following) return;
    this._aplicarEstado(msg?.slices);
  }

  _onSyncCamera(msg) {
    if (!this._following || !msg?.cam) return;
    try {
      this.viewer.followCamera(msg.cam);
    } catch (err) {
      console.error('[presentation] followCamera falló', err);
    }
  }

  _onSyncPointer(msg) {
    if (!this._following || !msg?.p) return;
    this.laser.update(msg.p);
  }
}
