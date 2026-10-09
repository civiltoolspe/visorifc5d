// Núcleo del visor 3D (three.js): escena, cámaras, controles de órbita, render bajo
// demanda, picking, planos de recorte y eventos de puntero.
// Contrato: docs/ARQUITECTURA.md, sección 6.
//
// Decisiones de diseño:
//  - Dos escenas: `scene` (modelos, sujeta a los planos de recorte globales) y
//    `overlayScene` (ayudas: caja de sección, mediciones). La segunda se dibuja después,
//    SIN recorte y conservando el búfer de profundidad: cada ayuda decide con
//    `material.depthTest` si queda tapada por el modelo o siempre encima.
//  - Fondo: el canvas es transparente (alpha) y detrás hay un degradado CSS sutil
//    (#F3F3F2 → #E7E7E6) en el contenedor `.viewer-root`, como la imagen de referencia.
//  - Cámara ortográfica: el frustum mide ORTHO_H metros de alto con zoom = 1; la altura
//    visible es ORTHO_H / zoom. Al cambiar de proyección se conserva el encuadre en el
//    plano del objetivo.

import * as THREE from 'three';
import CameraControls from 'camera-controls';
import { WorldOrigin } from './WorldOrigin.js';

CameraControls.install({
  THREE: {
    Vector2: THREE.Vector2,
    Vector3: THREE.Vector3,
    Vector4: THREE.Vector4,
    Quaternion: THREE.Quaternion,
    Matrix4: THREE.Matrix4,
    Spherical: THREE.Spherical,
    Box3: THREE.Box3,
    Sphere: THREE.Sphere,
    Raycaster: THREE.Raycaster,
  },
});

export const ORTHO_H = 100; // altura visible (m) de la cámara ortográfica con zoom = 1
export const BG_TOP = '#F3F3F2';
export const BG_BOTTOM = '#E7E7E6';

const DEG = THREE.MathUtils.DEG2RAD;
const DEFAULT_FOV = 45;
const CLICK_SLOP = 5; // px: por encima de esto el gesto es un arrastre, no un clic
const FOLLOW_TAU = 0.07; // s: constante de tiempo del seguimiento de cámara
// s: tope del tiempo real entre fotogramas que usa el seguimiento. Es MAYOR que el de los controles (0.1 s) para que, con
// fotogramas lentos (WebGL por software, PC con poca GPU, equipo cargado), el seguimiento dependa del tiempo transcurrido
// y no del número de fotogramas: con el tope de 0.1 s cada fotograma lento solo avanzaba ~76 % del camino.
const FOLLOW_MAX_DT = 0.5;
const TILT = 1e-4; // rad: inclinación mínima en vistas cenitales (evita la singularidad del polo)
const MAX_CAPTURE = 4096;
const EMPTY_PLANES = [];

// Direcciones (objetivo → cámara) de las vistas estándar. Escena: +X este, +Y arriba, -Z norte.
const VIEW_DIRS = {
  top: [0, Math.cos(TILT), Math.sin(TILT)], // planta con el norte (-Z) hacia arriba
  bottom: [0, -Math.cos(TILT), Math.sin(TILT)], // planta de techo reflejada, este a la derecha
  front: [0, 0, 1], // cámara al sur, mirando hacia el norte
  back: [0, 0, -1],
  left: [-1, 0, 0], // cámara al oeste, mirando hacia el este
  right: [1, 0, 0],
  iso: [1, 0.8, 1],
};

const UP = new THREE.Vector3(0, 1, 0);
const ZERO = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _d = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _qi = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _sph = new THREE.Spherical();
const _box = new THREE.Box3();

const wrapPi = (x) => x - Math.PI * 2 * Math.round(x / (Math.PI * 2));
const finite3 = (arr) => Array.isArray(arr) && arr.length >= 3 && arr.slice(0, 3).every((n) => Number.isFinite(Number(n)));
const isClipped = (point, planes) => planes.some((pl) => pl.distanceToPoint(point) < -1e-4);

export class Viewer {
  constructor(container, { bus, store } = {}) {
    if (!container) throw new Error('Viewer: se requiere un contenedor HTML');
    this.container = container;
    this.bus = bus;
    this.store = store;

    this._disposed = false;
    this._offs = [];
    this._listeners = [];
    this._afterRender = new Set();
    this._clipGroups = new Map();
    this._clipUnion = EMPTY_PLANES;
    this._pickProviders = new Map();
    this._inputEnabled = true;
    this._needsRender = true;
    this._followGoal = null;
    this._cameraBusy = false; // los controles avanzaron la cámara en el último fotograma
    this._lastTime = 0;
    this._width = 1;
    this._height = 1;
    this._fitInsets = { left: 0, right: 0, top: 0, bottom: 0 }; // zona del visor tapada por paneles de la UI (px CSS)
    this._pixelRatio = 1;
    this._pointers = new Map();
    this._down = null;
    this._pendingMove = null;
    this._pointerInside = false;
    this._lastCam = new Float64Array(12).fill(NaN);
    this._lastProjection = null;
    this._bounds = null; // { center, radius, time }
    this._boundsDirty = true;
    this._topCamera = null;
    this.renderCount = 0;
    this.selectionBoxProvider = null;

    this._initDom(container);
    this._initRenderer();
    this._initScene();
    this._initCameras();
    this._initControls();
    this._initEvents();
    this._initBindings();

    this._resize(true);
    this._ro = new ResizeObserver(() => this._resize(false));
    this._ro.observe(this.root);
    this._raf = requestAnimationFrame(this._tick);
  }

  // ---------------------------------------------------------------- inicialización

  _initDom(container) {
    if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
    this.root = document.createElement('div');
    this.root.className = 'viewer-root';
    Object.assign(this.root.style, {
      position: 'absolute',
      inset: '0',
      overflow: 'hidden',
      // La UI puede cambiar el fondo definiendo --viewer-bg en el contenedor
      background: `var(--viewer-bg, linear-gradient(180deg, ${BG_TOP} 0%, ${BG_BOTTOM} 100%))`,
    });
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'viewer-canvas';
    Object.assign(this.canvas.style, { display: 'block', width: '100%', height: '100%', outline: 'none' });
    this.canvas.tabIndex = -1;
    this.root.appendChild(this.canvas);
    container.insertBefore(this.root, container.firstChild);
  }

  _initRenderer() {
    const renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      alpha: true,
      stencil: false,
      powerPreference: 'high-performance',
    });
    renderer.setClearColor(0x000000, 0);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.autoClear = false;
    renderer.info.autoReset = false; // las estadísticas abarcan las dos pasadas (modelo + superposición)
    renderer.localClippingEnabled = true;
    renderer.clippingPlanes = EMPTY_PLANES;
    this.renderer = renderer;
  }

  _initScene() {
    this.scene = new THREE.Scene();
    this.modelsRoot = new THREE.Group();
    this.modelsRoot.name = 'modelsRoot';
    this.scene.add(this.modelsRoot);

    // Luces suaves. En three r155+ las intensidades son físicas: un material blanco mate
    // necesita ~π de irradiancia para verse blanco, de ahí los valores > 1.
    this.hemiLight = new THREE.HemisphereLight(0xffffff, 0xd9d6d2, 1.7);
    this.sunLight = new THREE.DirectionalLight(0xffffff, 1.5);
    this.sunLight.position.set(-0.45, 1, 0.7);
    this.fillLight = new THREE.DirectionalLight(0xffffff, 0.45);
    this.fillLight.position.set(0.7, 0.35, -0.6);
    this.scene.add(this.hemiLight, this.sunLight, this.fillLight);

    this.overlayScene = new THREE.Scene();
    this.overlayRoot = new THREE.Group();
    this.overlayRoot.name = 'overlayRoot';
    this.overlayScene.add(this.overlayRoot);

    this.worldOrigin = new WorldOrigin(this.bus);
    this._raycaster = new THREE.Raycaster();
    this.raycaster = this._raycaster;
    this._addBuiltinProvider();
  }

  _initCameras() {
    this.perspCamera = new THREE.PerspectiveCamera(DEFAULT_FOV, 1, 0.1, 2000);
    this.perspCamera.position.set(28, 22, 28);
    this.orthoCamera = new THREE.OrthographicCamera(-ORTHO_H / 2, ORTHO_H / 2, ORTHO_H / 2, -ORTHO_H / 2, -2000, 2000);
    this.orthoCamera.position.set(28, 22, 28);
    this.camera = this.perspCamera;
  }

  _initControls() {
    const c = new CameraControls(this.perspCamera, this.canvas);
    c.smoothTime = 0.12;
    c.draggingSmoothTime = 0.08;
    c.dollyToCursor = true;
    c.dollySpeed = 0.9;
    c.minDistance = 0.1;
    c.maxDistance = 1e5;
    c.minZoom = 0.002;
    c.maxZoom = 10000;
    this.controls = c;
    this._configureControls();
    c.setLookAt(28, 22, 28, 0, 0, 0, false);
    c.update(0);
  }

  // Botón izquierdo orbita; derecho y central desplazan; la rueda hace zoom hacia el cursor
  // (dolly en perspectiva, zoom en ortográfica).
  _configureControls() {
    const A = CameraControls.ACTION;
    const persp = this.camera.isPerspectiveCamera;
    const c = this.controls;
    c.mouseButtons.left = A.ROTATE;
    c.mouseButtons.middle = A.TRUCK;
    c.mouseButtons.right = A.TRUCK;
    c.mouseButtons.wheel = persp ? A.DOLLY : A.ZOOM;
    // En perspectiva truckSpeed = 2 hace que el punto siga al cursor 1:1; en ortográfica
    // camera-controls mide el desplazamiento sobre el ancho completo, así que basta 1.
    c.truckSpeed = persp ? 2 : 1;
    c.touches.one = A.TOUCH_ROTATE;
    c.touches.two = persp ? A.TOUCH_DOLLY_TRUCK : A.TOUCH_ZOOM_TRUCK;
    c.touches.three = A.TOUCH_TRUCK;
  }

  _listen(target, type, fn, options) {
    target.addEventListener(type, fn, options);
    this._listeners.push([target, type, fn, options]);
  }

  _initEvents() {
    const el = this.canvas;
    this._listen(el, 'pointerdown', this._onPointerDown);
    this._listen(el, 'pointermove', this._onPointerMove);
    this._listen(el, 'pointerup', this._onPointerUp);
    this._listen(el, 'pointercancel', this._onPointerCancel);
    this._listen(el, 'pointerleave', this._onPointerLeave);
    this._listen(el, 'dblclick', this._onDblClick);
    // Limpieza de punteros soltados fuera del canvas (no generan clic)
    this._listen(window, 'pointerup', this._onWindowPointerEnd);
    this._listen(window, 'pointercancel', this._onWindowPointerEnd);
    this._listen(el, 'webglcontextlost', (e) => e.preventDefault());
    this._listen(el, 'webglcontextrestored', () => this.requestRender());
    this._listen(document, 'visibilitychange', () => {
      if (!document.hidden) this.requestRender();
    });
  }

  _initBindings() {
    if (this.store) {
      this._offs.push(
        this.store.subscribe('display', (next) => {
          if (next?.projection && next.projection !== this.projection) this._applyProjection(next.projection);
        }),
      );
      const proj = this.store.get('display')?.projection;
      if (proj === 'orthographic') this._applyProjection('orthographic');
    }
    if (this.bus) {
      this._offs.push(this.bus.on('origin:changed', (payload) => this._onOriginChanged(payload)));
    }
  }

  // ---------------------------------------------------------------- estado básico

  get projection() {
    return this.camera.isOrthographicCamera ? 'orthographic' : 'perspective';
  }

  get inputEnabled() {
    return this._inputEnabled;
  }

  getAspect() {
    return this._width / this._height;
  }

  getSize() {
    return { width: this._width, height: this._height };
  }

  requestRender() {
    this._needsRender = true;
  }

  add(obj) {
    this.modelsRoot.add(obj);
    this.invalidateBounds();
    this.requestRender();
    return obj;
  }

  remove(obj) {
    this.modelsRoot.remove(obj);
    this.invalidateBounds();
    this.requestRender();
    return obj;
  }

  // Marca como obsoletos los límites de escena (cercanos/lejanos de cámara, fitAll).
  invalidateBounds() {
    this._boundsDirty = true;
  }

  // Suscribe una función que se llama tras cada render (p. ej. CSS2DRenderer). Devuelve la baja.
  onAfterRender(fn) {
    this._afterRender.add(fn);
    return () => this._afterRender.delete(fn);
  }

  // Proveedor de la caja de la selección (lo usa SectionBox): (items) => THREE.Box3 | null
  setSelectionBoxProvider(fn) {
    this.selectionBoxProvider = fn;
  }

  getSelectionBox(items) {
    const provider =
      this.selectionBoxProvider || globalThis.__visor?.ifc?.getBoxOf?.bind(globalThis.__visor.ifc);
    if (!provider || !items?.length) return null;
    try {
      const box = provider(items);
      return box && !box.isEmpty() ? box : null;
    } catch (err) {
      console.error('[viewer] error al obtener la caja de la selección', err);
      return null;
    }
  }

  // ---------------------------------------------------------------- bucle de render

  _tick = (now) => {
    if (this._disposed) return;
    this._raf = requestAnimationFrame(this._tick);
    const elapsed = this._lastTime ? (now - this._lastTime) / 1000 : 0;
    const dt = Math.min(elapsed, 0.1);
    this._lastTime = now;
    let need = this._needsRender;
    if (this._followGoal && this._stepFollow(Math.min(elapsed, FOLLOW_MAX_DT))) need = true;
    this._cameraBusy = this.controls.update(dt);
    if (this._cameraBusy) need = true;
    this._flushPointer();
    if (need) this._render();
  };

  _render() {
    if (this._disposed) return;
    this._updateClipRange();
    this._emitCameraIfChanged();
    const r = this.renderer;
    r.info.reset();
    r.clear(true, true, false);
    r.clippingPlanes = this._clipUnion;
    r.render(this.scene, this.camera);
    r.clippingPlanes = EMPTY_PLANES;
    if (this.overlayRoot.children.length) r.render(this.overlayScene, this.camera);
    for (const fn of this._afterRender) {
      try {
        fn(this);
      } catch (err) {
        console.error('[viewer] error en onAfterRender', err);
      }
    }
    this._needsRender = false;
    this.renderCount++;
  }

  // Aplica a la cámara el estado actual de los controles (sin avanzar transiciones).
  _syncCamera() {
    if (this.controls.update(0)) this._needsRender = true;
  }

  _resize(initial) {
    const w = Math.max(1, this.root.clientWidth || this.container.clientWidth || 300);
    const h = Math.max(1, this.root.clientHeight || this.container.clientHeight || 150);
    const pr = Math.min(window.devicePixelRatio || 1, 2);
    if (!initial && w === this._width && h === this._height && pr === this._pixelRatio) return;
    this._width = w;
    this._height = h;
    this._pixelRatio = pr;
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h, false);
    this._updateCameraAspect();
    this.bus?.emit('viewer:resize', { width: w, height: h, aspect: w / h });
    this._needsRender = true;
    // Redimensionar vacía el canvas: se redibuja de inmediato para evitar un parpadeo.
    if (!initial) this._render();
  }

  _updateCameraAspect(aspect = this.getAspect()) {
    this.perspCamera.aspect = aspect;
    this.perspCamera.updateProjectionMatrix();
    const o = this.orthoCamera;
    o.left = (-ORTHO_H * aspect) / 2;
    o.right = (ORTHO_H * aspect) / 2;
    o.top = ORTHO_H / 2;
    o.bottom = -ORTHO_H / 2;
    o.updateProjectionMatrix();
  }

  // Ajusta near/far a la escena para conservar precisión de profundidad.
  _updateClipRange() {
    const cam = this.camera;
    const sph = this._getSceneSphere();
    const target = this.controls.getTarget(_b, false);
    let near;
    let far;
    if (cam.isPerspectiveCamera) {
      const dC = cam.position.distanceTo(sph.center);
      const dT = cam.position.distanceTo(target);
      far = (dC + sph.radius) * 1.1 + 1;
      near = Math.max(0.005, Math.min(dT * 0.02, far / 2000));
    } else {
      cam.getWorldDirection(_a);
      const depth = _c.copy(sph.center).sub(cam.position).dot(_a);
      near = depth - sph.radius * 1.1 - 1;
      far = depth + sph.radius * 1.1 + 1;
    }
    if (Math.abs(cam.near - near) > 1e-6 * Math.max(1, Math.abs(near)) || Math.abs(cam.far - far) > 1e-6 * far) {
      cam.near = near;
      cam.far = far;
      cam.updateProjectionMatrix();
    }
  }

  _getSceneSphere() {
    const now = performance.now();
    if (!this._bounds || this._boundsDirty || now - this._bounds.time > 750) {
      this.modelsRoot.updateMatrixWorld(true);
      const box = this.getVisibleBox(_box);
      if (box.isEmpty()) {
        const t = this.controls.getTarget(new THREE.Vector3(), false);
        this._bounds = { center: t, radius: 50, time: now };
      } else {
        const center = box.getCenter(new THREE.Vector3());
        this._bounds = { center, radius: Math.max(box.getSize(_d).length() / 2, 1), time: now };
      }
      this._boundsDirty = false;
    }
    return this._bounds;
  }

  // ---------------------------------------------------------------- cámara

  _readState() {
    const p = this.camera.position;
    const t = this.controls.getTarget(_d, false);
    return {
      position: [p.x, p.y, p.z],
      target: [t.x, t.y, t.z],
      projection: this.projection,
      zoom: this.camera.zoom,
      fov: this.perspCamera.fov,
    };
  }

  getCameraState() {
    this._syncCamera();
    return this._readState();
  }

  _emitCameraIfChanged() {
    const s = this._readState();
    const cur = this._lastCam;
    const vals = [...s.position, ...s.target, s.zoom, s.fov];
    let changed = this._lastProjection !== s.projection;
    for (let i = 0; i < vals.length && !changed; i++) {
      const tol = 1e-7 * Math.max(1, Math.abs(vals[i]));
      if (!(Math.abs(vals[i] - cur[i]) <= tol)) changed = true;
    }
    if (!changed) return;
    for (let i = 0; i < vals.length; i++) cur[i] = vals[i];
    this._lastProjection = s.projection;
    this.bus?.emit('viewer:camera', s);
  }

  _normalizeState(state) {
    if (!state || !finite3(state.position) || !finite3(state.target)) return null;
    const position = new THREE.Vector3(...state.position.slice(0, 3).map(Number));
    const target = new THREE.Vector3(...state.target.slice(0, 3).map(Number));
    if (position.distanceToSquared(target) < 1e-12) position.z += 0.01;
    const zoom = Number.isFinite(Number(state.zoom)) && Number(state.zoom) > 0 ? Number(state.zoom) : 1;
    const fovIn = Number(state.fov);
    const fov = Number.isFinite(fovIn) && fovIn >= 1 && fovIn <= 170 ? fovIn : this.perspCamera.fov;
    return {
      position,
      target,
      zoom,
      fov,
      projection: state.projection === 'orthographic' ? 'orthographic' : 'perspective',
    };
  }

  // Mueve la cámara tomando el camino más corto en acimut. position/target: Vector3.
  _moveCamera(position, target, zoom, smooth) {
    const c = this.controls;
    const goalTheta = Math.atan2(position.x - target.x, position.z - target.z);
    const curTheta = c.azimuthAngle;
    const p1 = c.setLookAt(position.x, position.y, position.z, target.x, target.y, target.z, !!smooth);
    const p2 = c.zoomTo(zoom, !!smooth);
    if (smooth) c.rotateAzimuthTo(curTheta + wrapPi(goalTheta - curTheta), true);
    else this._syncCamera();
    this.requestRender();
    return Promise.all([p1, p2]);
  }

  setCameraState(state, { smooth = true } = {}) {
    const s = this._normalizeState(state);
    if (!s) return Promise.resolve();
    this._followGoal = null;
    if (s.projection !== this.projection) {
      this._applyProjection(s.projection);
      this._syncProjectionToStore(s.projection);
    }
    this._setFov(s.fov);
    return this._moveCamera(s.position, s.target, s.zoom, smooth);
  }

  _setFov(fov) {
    if (Math.abs(this.perspCamera.fov - fov) > 1e-6) {
      this.perspCamera.fov = fov;
      this.perspCamera.updateProjectionMatrix();
      this.requestRender();
    }
  }

  // Para espectadores: interpolación exponencial continua hacia el estado recibido.
  followCamera(state) {
    const s = this._normalizeState(state);
    if (!s) return;
    this._followGoal = s;
    this.requestRender();
  }

  stopFollow() {
    this._followGoal = null;
  }

  // true mientras la cámara tiene un movimiento pendiente: el amortiguado de los controles aún avanza, hay un seguimiento de
  // cámara en curso o un gesto acaba de fijar un valor final que el bucle todavía no recorrió. Sirve para esperar a que la
  // cámara se asiente (p. ej. pruebas E2E). No usa `controls.active`: tras un movimiento instantáneo (setLookAt sin
  // animación) esa propiedad se queda activa porque el evento "rest" no llega a dispararse.
  isCameraMoving() {
    if (this._followGoal || this._cameraBusy) return true;
    const c = this.controls;
    const eps = 1e-3; // m
    const dp = c.getPosition(_a, false).distanceTo(c.getPosition(_b, true));
    const dt = c.getTarget(_a, false).distanceTo(c.getTarget(_b, true));
    return dp > eps || dt > eps;
  }

  _stepFollow(dt) {
    const g = this._followGoal;
    if (!g) return false;
    if (g.projection !== this.projection) this._applyProjection(g.projection);
    this._setFov(g.fov);
    const c = this.controls;
    const curPos = c.getPosition(_a, false).clone();
    const curTarget = c.getTarget(_b, false).clone();
    const curZoom = this.camera.zoom;
    const a = dt <= 0 ? 0 : 1 - Math.exp(-dt / FOLLOW_TAU);

    const target = curTarget.clone().lerp(g.target, a);
    // offset (objetivo → cámara): dirección por slerp y distancia geométrica
    const offC = curPos.clone().sub(curTarget);
    const offG = g.position.clone().sub(g.target);
    const dC = Math.max(offC.length(), 1e-6);
    const dG = Math.max(offG.length(), 1e-6);
    const dirC = offC.clone().divideScalar(dC);
    const dirG = offG.clone().divideScalar(dG);
    _q.setFromUnitVectors(dirC, dirG);
    _qi.identity().slerp(_q, a);
    const dir = dirC.clone().applyQuaternion(_qi).normalize();
    const dist = Math.exp(Math.log(dC) + (Math.log(dG) - Math.log(dC)) * a);
    const position = target.clone().addScaledVector(dir, dist);
    const zoom = Math.exp(Math.log(curZoom) + (Math.log(g.zoom) - Math.log(curZoom)) * a);

    const scale = Math.max(1, dG);
    const done =
      position.distanceTo(g.position) < 1e-5 * scale &&
      target.distanceTo(g.target) < 1e-5 * scale &&
      Math.abs(zoom - g.zoom) < 1e-5 * g.zoom;
    if (done) {
      c.setLookAt(g.position.x, g.position.y, g.position.z, g.target.x, g.target.y, g.target.z, false);
      c.zoomTo(g.zoom, false);
      this._followGoal = null;
    } else {
      c.setLookAt(position.x, position.y, position.z, target.x, target.y, target.z, false);
      c.zoomTo(zoom, false);
    }
    return true;
  }

  // ---------------------------------------------------------------- proyección

  _switchCamera(projection) {
    const cam = projection === 'orthographic' ? this.orthoCamera : this.perspCamera;
    this.camera = cam;
    this.controls.camera = cam;
    this._configureControls();
    this._updateCameraAspect();
  }

  // Cambia de cámara conservando el encuadre. No toca el store.
  _applyProjection(projection) {
    const next = projection === 'orthographic' ? 'orthographic' : 'perspective';
    if (next === this.projection) return false;
    this._syncCamera();
    const target = this.controls.getTarget(new THREE.Vector3(), false);
    const position = this.camera.position.clone();
    const tanHalf = Math.tan((this.perspCamera.fov * DEG) / 2);
    let zoom = 1;
    if (next === 'orthographic') {
      const dist = Math.max(position.distanceTo(target), 1e-3);
      zoom = (ORTHO_H / (2 * dist * tanHalf)) * this.perspCamera.zoom;
    } else {
      const visibleH = ORTHO_H / this.orthoCamera.zoom;
      const dist = Math.max(visibleH / (2 * tanHalf), 0.05);
      const dir = position.clone().sub(target);
      if (dir.lengthSq() < 1e-12) dir.set(1, 0.8, 1);
      position.copy(target).addScaledVector(dir.normalize(), dist);
      this.perspCamera.zoom = 1;
      this.perspCamera.updateProjectionMatrix();
    }
    this._switchCamera(next);
    this.controls.setLookAt(position.x, position.y, position.z, target.x, target.y, target.z, false);
    this.controls.zoomTo(zoom, false);
    this._syncCamera();
    this.invalidateBounds();
    this.requestRender();
    this.bus?.emit('viewer:projection', { projection: next });
    return true;
  }

  _syncProjectionToStore(projection) {
    const display = this.store?.get('display');
    if (display && display.projection !== projection) {
      this.store.patch('display', { projection }, { source: 'local' });
    }
  }

  setProjection(projection) {
    const p = projection === 'orthographic' ? 'orthographic' : 'perspective';
    const changed = this._applyProjection(p);
    this._syncProjectionToStore(p);
    return changed;
  }

  // ---------------------------------------------------------------- encuadre

  // Caja (escena) de los objetos visibles de modelsRoot, a partir de geometry.boundingBox.
  getVisibleBox(target = new THREE.Box3()) {
    target.makeEmpty();
    this.modelsRoot.updateMatrixWorld(true);
    const tmp = new THREE.Box3();
    this.modelsRoot.traverseVisible((o) => {
      const g = o.geometry;
      if (!g || o.isSprite || o.userData?.excludeFromFit) return;
      if (!g.boundingBox) {
        if (!g.attributes?.position) return;
        g.computeBoundingBox();
      }
      const bb = g.boundingBox;
      if (!bb || bb.isEmpty()) return;
      tmp.copy(bb).applyMatrix4(o.matrixWorld);
      if (![tmp.min.x, tmp.min.y, tmp.min.z, tmp.max.x, tmp.max.y, tmp.max.z].every(Number.isFinite)) return;
      target.union(tmp);
    });
    return target;
  }

  _basisFromDir(dir) {
    _m.lookAt(dir, ZERO, UP);
    const x = new THREE.Vector3();
    const y = new THREE.Vector3();
    const z = new THREE.Vector3();
    _m.extractBasis(x, y, z);
    return { x, y, z };
  }

  // Zona del visor que tapan los paneles flotantes de la UI (en píxeles CSS). Los encuadres (fitAll, fitToBox,
  // setView con fit) colocan el modelo en la parte libre en lugar de en el centro de toda la ventana.
  setFitInsets({ left = 0, right = 0, top = 0, bottom = 0 } = {}) {
    const n = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0);
    this._fitInsets = { left: n(left), right: n(right), top: n(top), bottom: n(bottom) };
  }

  getFitInsets() {
    return { ...this._fitInsets };
  }

  // Insets aplicables: si los paneles dejan menos del 40 % del ancho o del alto, se ignoran.
  _effectiveInsets() {
    const { left, right, top, bottom } = this._fitInsets;
    const W = Math.max(this._width, 1);
    const H = Math.max(this._height, 1);
    if (W - left - right < W * 0.4 || H - top - bottom < H * 0.4) return { left: 0, right: 0, top: 0, bottom: 0, fw: W, fh: H, W, H };
    return { left, right, top, bottom, fw: W - left - right, fh: H - top - bottom, W, H };
  }

  // Encuadra la caja mirando desde `dir` (objetivo → cámara).
  _fitFromDirection(box, dir, padding, smooth) {
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const radius = Math.max(size.length() / 2, 0.25);
    const { x, y, z } = this._basisFromDir(dir);
    const ins = this._effectiveInsets();
    const tanV = Math.tan((this.perspCamera.fov * DEG) / 2);
    // La caja debe caber en la zona libre (fw × fh de un visor de W × H píxeles)
    const tanH = (tanV * ins.fw) / ins.H;
    const tanVfree = (tanV * ins.fh) / ins.H;
    let dist = 0;
    let zMax = -Infinity;
    let maxX = 0;
    let maxY = 0;
    for (let i = 0; i < 8; i++) {
      _a.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).sub(center);
      const xc = Math.abs(_a.dot(x));
      const yc = Math.abs(_a.dot(y));
      const zc = _a.dot(z);
      zMax = Math.max(zMax, zc);
      maxX = Math.max(maxX, xc);
      maxY = Math.max(maxY, yc);
      dist = Math.max(dist, zc + (xc * padding) / tanH, zc + (yc * padding) / tanVfree);
    }
    let zoom = 1;
    let position;
    let worldPerPixel;
    if (this.camera.isPerspectiveCamera) {
      dist = Math.max(dist, zMax + radius * 0.1 + 0.05);
      worldPerPixel = (2 * dist * tanV) / ins.H;
    } else {
      const visibleH = Math.max((2 * padding * maxY * ins.H) / ins.fh, (2 * padding * maxX * ins.H) / ins.fw, 0.05);
      zoom = ORTHO_H / visibleH;
      worldPerPixel = visibleH / ins.H;
    }
    // La caja debe quedar centrada en la zona libre: el objetivo se desplaza al lado contrario
    const target = center.clone();
    const dx = (ins.left - ins.right) / 2;
    const dy = (ins.top - ins.bottom) / 2;
    if (dx || dy) target.addScaledVector(x, -dx * worldPerPixel).addScaledVector(y, dy * worldPerPixel);
    position = target.clone().addScaledVector(dir, this.camera.isPerspectiveCamera ? dist : radius * 2.5);
    return this._moveCamera(position, target, zoom, smooth);
  }

  _currentDirection() {
    const p = this.controls.getPosition(_a, true);
    const t = this.controls.getTarget(_b, true);
    const dir = new THREE.Vector3().subVectors(p, t);
    if (dir.lengthSq() < 1e-12) return new THREE.Vector3(...VIEW_DIRS.iso).normalize();
    return dir.normalize();
  }

  fitToBox(box, { smooth = true, padding = 1.15 } = {}) {
    if (!box?.isBox3 || box.isEmpty()) return Promise.resolve();
    return this._fitFromDirection(box, this._currentDirection(), padding, smooth);
  }

  fitAll({ smooth = true, padding = 1.15 } = {}) {
    const box = this.getVisibleBox(new THREE.Box3());
    if (box.isEmpty()) return Promise.resolve();
    return this.fitToBox(box, { smooth, padding });
  }

  // Vistas estándar. Conserva el objetivo y la distancia/zoom actuales; con { fit: true }
  // encuadra además todo lo visible.
  setView(name, { smooth = true, fit = false } = {}) {
    const d = VIEW_DIRS[name];
    if (!d) return Promise.resolve();
    this._followGoal = null;
    const dir = new THREE.Vector3(...d).normalize();
    if (fit) {
      const box = this.getVisibleBox(new THREE.Box3());
      if (!box.isEmpty()) return this._fitFromDirection(box, dir, 1.15, smooth);
    }
    const target = this.controls.getTarget(new THREE.Vector3(), true);
    const radius = this.controls.getSpherical(_sph, true).radius;
    const position = target.clone().addScaledVector(dir, radius);
    return this._moveCamera(position, target, this._zoomEnd(), smooth);
  }

  _zoomEnd() {
    return this.controls._zoomEnd ?? this.camera.zoom;
  }

  // +1 acerca, -1 aleja (hacia el centro de la pantalla).
  zoomStep(dir = 1) {
    const f = dir > 0 ? 0.8 : 1.25;
    if (this.camera.isPerspectiveCamera) {
      this.controls.dollyTo(this.controls.getSpherical(_sph, true).radius * f, true);
    } else {
      this.controls.zoomTo(this._zoomEnd() / f, true);
    }
    this.requestRender();
  }

  // dxDeg > 0 mueve la cámara hacia la derecha alrededor del objetivo; dyDeg > 0 la sube.
  orbitStep(dxDeg = 0, dyDeg = 0) {
    this.controls.rotate(dxDeg * DEG, -dyDeg * DEG, true);
    this.requestRender();
  }

  _onOriginChanged(payload) {
    const d = payload?.delta;
    if (!d) return;
    const delta = new THREE.Vector3(d.x, d.y, d.z);
    this._syncCamera();
    const pos = this.camera.position.clone().add(delta);
    const target = this.controls.getTarget(new THREE.Vector3(), false).add(delta);
    const zoom = this.camera.zoom;
    this.controls.setLookAt(pos.x, pos.y, pos.z, target.x, target.y, target.z, false);
    this.controls.zoomTo(zoom, false);
    if (this._followGoal) {
      this._followGoal.position.add(delta);
      this._followGoal.target.add(delta);
    }
    this._syncCamera();
    this.invalidateBounds();
    this.requestRender();
  }

  // ---------------------------------------------------------------- recortes

  // Grupos con nombre ('section', 'storey', ...); se combinan en renderer.clippingPlanes.
  setClipping(key, planes) {
    if (!planes || !planes.length) this._clipGroups.delete(key);
    else this._clipGroups.set(key, [...planes]);
    const union = [];
    for (const group of this._clipGroups.values()) union.push(...group);
    this._clipUnion = union.length ? union : EMPTY_PLANES;
    this.requestRender();
  }

  getClippingPlanes() {
    return [...this._clipUnion];
  }

  // ---------------------------------------------------------------- picking

  _addBuiltinProvider() {
    // Objetos con userData.pickable (útil para ayudas y pruebas); los modelos registran el suyo.
    this._pickProviders.set('viewer:builtin', {
      id: 'viewer:builtin',
      raycast: (raycaster) => {
        const objects = [];
        this.modelsRoot.traverseVisible((o) => {
          if (o.userData?.pickable && (o.isMesh || o.isLine || o.isPoints)) objects.push(o);
        });
        if (!objects.length) return [];
        return raycaster.intersectObjects(objects, false).map((h) => ({
          ...h,
          kind: h.object.userData.kind || 'other',
          modelId: h.object.userData.modelId ?? null,
          expressId: h.object.userData.expressId,
        }));
      },
    });
  }

  // provider: { id, raycast(raycaster) → Hit[] }. Devuelve la función para darlo de baja.
  addPickProvider(provider) {
    if (!provider || typeof provider.raycast !== 'function') throw new Error('Viewer: proveedor de picking inválido');
    const id = provider.id ?? `provider-${this._pickProviders.size}`;
    this._pickProviders.set(id, { ...provider, id });
    return () => this.removePickProvider(id);
  }

  removePickProvider(id) {
    return this._pickProviders.delete(id);
  }

  // Tamaño en el mundo de un píxel a cierta distancia de la cámara.
  getWorldPerPixel(distance) {
    const cam = this.camera;
    if (cam.isPerspectiveCamera) {
      return (2 * Math.max(distance, 1e-6) * Math.tan((cam.fov * DEG) / 2)) / cam.zoom / this._height;
    }
    return ORTHO_H / cam.zoom / this._height;
  }

  _prepareRay(ndc) {
    this._syncCamera();
    const cam = this.camera;
    cam.updateMatrixWorld();
    const rc = this._raycaster;
    rc.near = 0;
    rc.far = Infinity;
    rc.setFromCamera(new THREE.Vector2(ndc.x, ndc.y), cam);
    let shift = 0;
    const target = this.controls.getTarget(_b, false);
    if (cam.isOrthographicCamera) {
      // El origen del rayo ortográfico está en el plano de la cámara: se retrasa para que
      // alcance también lo que queda detrás de ese plano.
      const sph = this._getSceneSphere();
      cam.getWorldDirection(_a);
      shift = Math.max(0, sph.radius + Math.abs(_c.copy(sph.center).sub(cam.position).dot(_a)) + 1);
      rc.ray.origin.addScaledVector(_a, -shift);
    }
    const wpp = this.getWorldPerPixel(cam.position.distanceTo(target));
    rc.params.Line.threshold = wpp * 6;
    rc.params.Points.threshold = wpp * 8;
    rc.userData = { worldPerPixel: (d) => this.getWorldPerPixel(d) };
    return { raycaster: rc, shift };
  }

  _normalizeHit(h, ray) {
    if (!h) return null;
    let point = h.point;
    if (!point) {
      if (!Number.isFinite(h.distance)) return null;
      point = ray.raycaster.ray.at(h.distance, new THREE.Vector3());
    } else if (!point.isVector3) {
      point = new THREE.Vector3(point.x, point.y, point.z);
    }
    const distance = (Number.isFinite(h.distance) ? h.distance : ray.raycaster.ray.origin.distanceTo(point)) - ray.shift;
    return { ...h, point, distance, kind: h.kind || 'other' };
  }

  // Todos los impactos de todos los proveedores, ordenados por distancia. Se descartan los
  // que caen en el lado recortado de algún plano activo. opts.kinds filtra por tipo.
  pickAll(ndc, { kinds } = {}) {
    if (!ndc) return [];
    const ray = this._prepareRay(ndc);
    const kindSet = kinds ? new Set(Array.isArray(kinds) ? kinds : [kinds]) : null;
    const planes = this._clipUnion;
    const out = [];
    for (const provider of this._pickProviders.values()) {
      let hits;
      try {
        hits = provider.raycast(ray.raycaster);
      } catch (err) {
        console.error(`[viewer] error en el proveedor de picking "${provider.id}"`, err);
        continue;
      }
      if (!hits) continue;
      for (const raw of hits) {
        const hit = this._normalizeHit(raw, ray);
        if (!hit) continue;
        if (kindSet && !kindSet.has(hit.kind)) continue;
        if (planes.length && isClipped(hit.point, planes)) continue;
        out.push(hit);
      }
    }
    out.sort((p, q) => p.distance - q.distance);
    return out;
  }

  pick(ndc, opts) {
    return this.pickAll(ndc, opts)[0] ?? null;
  }

  ndcFromEvent(evt) {
    return this._ndc(evt.clientX, evt.clientY);
  }

  _ndc(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const w = rect.width || 1;
    const h = rect.height || 1;
    return { x: ((clientX - rect.left) / w) * 2 - 1, y: -(((clientY - rect.top) / h) * 2 - 1) };
  }

  // ---------------------------------------------------------------- entrada

  enableInput(enabled) {
    const on = !!enabled;
    if (on === this._inputEnabled) return;
    this._inputEnabled = on;
    this.controls.enabled = on;
    this._pointers.clear();
    this._down = null;
    const hadPointer = this._pendingMove !== null || this._pointerInside;
    this._pendingMove = null;
    this._pointerInside = false;
    this.root.dataset.locked = on ? 'false' : 'true';
    if (!on && hadPointer) this.bus?.emit('viewer:pointerleave');
    this.bus?.emit('viewer:input', { enabled: on });
  }

  _onPointerDown = (e) => {
    if (!this._inputEnabled) return;
    if (e.pointerType === 'mouse') this._pointers.clear();
    this._pointers.set(e.pointerId, true);
    if (this._pointers.size === 1) {
      this._down = { id: e.pointerId, x: e.clientX, y: e.clientY, button: e.button, moved: false, multi: false };
    } else if (this._down) {
      this._down.multi = true;
    }
  };

  _onPointerMove = (e) => {
    if (!this._inputEnabled) return;
    const d = this._down;
    if (d && !d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) >= CLICK_SLOP) d.moved = true;
    this._pendingMove = { clientX: e.clientX, clientY: e.clientY, buttons: e.buttons, pointerType: e.pointerType };
  };

  _onPointerUp = (e) => {
    this._pointers.delete(e.pointerId);
    const d = this._down;
    if (!this._inputEnabled) {
      this._down = null;
      return;
    }
    if (d && d.id === e.pointerId) {
      this._down = null;
      const moved = d.moved || Math.hypot(e.clientX - d.x, e.clientY - d.y) >= CLICK_SLOP;
      if (!moved && !d.multi) this.bus?.emit('viewer:click', this._pointerPayload(e, d.button));
    }
    if (this._pointers.size === 0) this._down = null;
  };

  _onPointerCancel = (e) => {
    this._pointers.delete(e.pointerId);
    this._down = null;
  };

  _onWindowPointerEnd = (e) => {
    this._pointers.delete(e.pointerId);
    if (this._pointers.size === 0) this._down = null;
  };

  _onPointerLeave = () => {
    this._pendingMove = null;
    if (!this._inputEnabled) return;
    this._pointerInside = false;
    this.bus?.emit('viewer:pointerleave');
  };

  _onDblClick = (e) => {
    if (!this._inputEnabled) return;
    this.bus?.emit('viewer:dblclick', this._pointerPayload(e, e.button));
  };

  _pointerPayload(e, button) {
    return {
      ndc: this._ndc(e.clientX, e.clientY),
      clientX: e.clientX,
      clientY: e.clientY,
      button,
      shiftKey: e.shiftKey,
      ctrlKey: e.ctrlKey,
      metaKey: e.metaKey,
      altKey: e.altKey,
    };
  }

  // Máximo un pointermove por frame.
  _flushPointer() {
    const m = this._pendingMove;
    if (!m) return;
    this._pendingMove = null;
    if (!this._inputEnabled) return;
    this._pointerInside = true;
    this.bus?.emit('viewer:pointermove', {
      ndc: this._ndc(m.clientX, m.clientY),
      clientX: m.clientX,
      clientY: m.clientY,
      buttons: m.buttons,
      pointerType: m.pointerType,
    });
  }

  // ---------------------------------------------------------------- capturas

  // Dibuja `src` sobre el degradado de fondo (la captura WebGL es transparente) y exporta.
  _compose(src, w, h, mime, quality) {
    const out = document.createElement('canvas');
    out.width = w;
    out.height = h;
    const ctx = out.getContext('2d');
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, BG_TOP);
    g.addColorStop(1, BG_BOTTOM);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    if (src) ctx.drawImage(src, 0, 0, w, h);
    return out.toDataURL(mime, quality);
  }

  // Renderiza y captura en la misma tarea (el búfer de dibujo no se conserva entre tareas).
  screenshot({ width, height, mime = 'image/jpeg', quality = 0.85 } = {}) {
    this._syncCamera();
    const cssW = this._width;
    const cssH = this._height;
    const aspect = cssW / cssH;
    let w = width;
    let h = height;
    if (!w && !h) {
      w = Math.round(cssW * this._pixelRatio);
      h = Math.round(cssH * this._pixelRatio);
    } else if (!h) h = Math.round(w / aspect);
    else if (!w) w = Math.round(h * aspect);
    w = Math.max(1, Math.min(MAX_CAPTURE, Math.round(w)));
    h = Math.max(1, Math.min(MAX_CAPTURE, Math.round(h)));

    const sameAspect = Math.abs(w / h - aspect) < 0.01;
    if (sameAspect && w <= this.canvas.width) {
      // Misma proporción: se renderiza tal cual y se reescala al exportar.
      this._render();
      return this._compose(this.canvas, w, h, mime, quality);
    }
    // Otra proporción o más resolución: se redimensiona el búfer temporalmente.
    const r = this.renderer;
    r.setPixelRatio(1);
    r.setSize(w, h, false);
    this._updateCameraAspect(w / h);
    this._render();
    const url = this._compose(this.canvas, w, h, mime, quality);
    r.setPixelRatio(this._pixelRatio);
    r.setSize(this._width, this._height, false);
    this._updateCameraAspect();
    this.requestRender();
    return url;
  }

  // Miniatura en planta (cámara ortográfica cenital, norte arriba) de la caja dada, sin
  // alterar la vista principal. Se recorta lo que queda por encima de box.max.y.
  renderTopView({ box, width = 320, height = 200, mime = 'image/jpeg', quality = 0.82, clipTop = true, padding = 1.06 } = {}) {
    const w = Math.max(1, Math.min(MAX_CAPTURE, Math.round(width)));
    const h = Math.max(1, Math.min(MAX_CAPTURE, Math.round(height)));
    const b = box?.isBox3 && !box.isEmpty() ? box.clone() : this.getVisibleBox(new THREE.Box3());
    if (b.isEmpty()) return this._compose(null, w, h, mime, quality);

    const center = b.getCenter(new THREE.Vector3());
    const size = b.getSize(new THREE.Vector3());
    const aspect = w / h;
    let halfW = Math.max(size.x, 0.1) * 0.5 * padding;
    let halfH = Math.max(size.z, 0.1) * 0.5 * padding;
    if (halfW / halfH > aspect) halfH = halfW / aspect;
    else halfW = halfH * aspect;

    const scene = this.getVisibleBox(new THREE.Box3());
    const minY = Math.min(b.min.y, scene.isEmpty() ? b.min.y : scene.min.y);
    const cam = (this._topCamera ||= new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 1000));
    cam.left = -halfW;
    cam.right = halfW;
    cam.top = halfH;
    cam.bottom = -halfH;
    cam.near = 0.01;
    cam.far = b.max.y + 1 - minY + 10;
    cam.up.set(0, 0, -1);
    cam.position.set(center.x, b.max.y + 1, center.z);
    cam.lookAt(center.x, b.max.y - 1, center.z);
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld(true);

    const r = this.renderer;
    const prevTarget = r.getRenderTarget();
    const prevColor = r.getClearColor(new THREE.Color());
    const prevAlpha = r.getClearAlpha();
    const rt = new THREE.WebGLRenderTarget(w, h, { samples: 4, depthBuffer: true });
    try {
      r.setRenderTarget(rt);
      r.setClearColor(0xf0f0ef, 1);
      r.clear(true, true, false);
      r.clippingPlanes = clipTop ? [new THREE.Plane(new THREE.Vector3(0, -1, 0), b.max.y)] : EMPTY_PLANES;
      r.render(this.scene, cam);
      const px = new Uint8Array(w * h * 4);
      r.readRenderTargetPixels(rt, 0, 0, w, h, px);
      return this._pixelsToDataURL(px, w, h, mime, quality);
    } finally {
      r.clippingPlanes = EMPTY_PLANES;
      r.setRenderTarget(prevTarget);
      r.setClearColor(prevColor, prevAlpha);
      rt.dispose();
      this.requestRender();
    }
  }

  // El render target almacena valores lineales: se convierten a sRGB y se voltea en Y.
  _pixelsToDataURL(px, w, h, mime, quality) {
    if (!Viewer._lut) {
      Viewer._lut = new Uint8Array(256);
      for (let i = 0; i < 256; i++) {
        const v = i / 255;
        const s = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
        Viewer._lut[i] = Math.round(Math.min(1, Math.max(0, s)) * 255);
      }
    }
    const lut = Viewer._lut;
    const img = new ImageData(w, h);
    const dst = img.data;
    for (let y = 0; y < h; y++) {
      let s = (h - 1 - y) * w * 4;
      let d = y * w * 4;
      for (let x = 0; x < w; x++, s += 4, d += 4) {
        dst[d] = lut[px[s]];
        dst[d + 1] = lut[px[s + 1]];
        dst[d + 2] = lut[px[s + 2]];
        dst[d + 3] = 255;
      }
    }
    const out = document.createElement('canvas');
    out.width = w;
    out.height = h;
    out.getContext('2d').putImageData(img, 0, 0);
    return out.toDataURL(mime, quality);
  }

  // ---------------------------------------------------------------- ciclo de vida

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    cancelAnimationFrame(this._raf);
    this._ro?.disconnect();
    for (const off of this._offs) {
      try {
        off();
      } catch {
        /* ignorar */
      }
    }
    for (const [target, type, fn, options] of this._listeners) target.removeEventListener(type, fn, options);
    this._listeners.length = 0;
    this._afterRender.clear();
    this.controls.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss?.();
    this.root.remove();
  }
}
