// Doble mínimo del Viewer para probar el módulo IFC de forma aislada.
// Implementa sólo lo que IfcManager usa del contrato del Viewer: escena three.js propia + WorldOrigin real,
// add/remove, requestRender, fitToBox, setClipping/getClippingPlanes, addPickProvider/pick y los eventos
// 'viewer:click', 'viewer:dblclick', 'viewer:pointermove' y 'viewer:pointerleave'.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { WorldOrigin } from '/js/viewer/WorldOrigin.js';

export class ViewerDouble {
  constructor(container, { bus, store }) {
    this.bus = bus;
    this.store = store;
    this.container = container;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0xeeeeed);
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.localClippingEnabled = true;
    container.appendChild(this.renderer.domElement);
    this.canvas = this.renderer.domElement;
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 5000);
    this.camera.position.set(25, 18, 25);
    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enableDamping = false;
    // IfcManager consulta controls.currentAction (camera-controls); 0 = sin acción
    Object.defineProperty(this.controls, 'currentAction', { get: () => (this._dragging ? 1 : 0) });
    this.controls.addEventListener('change', () => this.requestRender());

    this.worldOrigin = new WorldOrigin(bus);
    this.modelsRoot = new THREE.Group();
    this.overlayRoot = new THREE.Group();
    this.scene.add(this.modelsRoot, this.overlayRoot);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x9a9a98, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.8);
    sun.position.set(30, 60, 20);
    this.scene.add(sun);

    this._providers = new Map();
    this._clipGroups = new Map();
    this._clipUnion = [];
    this._raycaster = new THREE.Raycaster();
    this._needsRender = true;
    this._dragging = false;
    this._down = null;
    this.renderCount = 0;

    bus.on('origin:changed', ({ delta }) => {
      this.camera.position.add(delta);
      this.controls.target.add(delta);
      this.controls.update();
      this.requestRender();
    });

    this._resize();
    window.addEventListener('resize', () => this._resize());
    this._bindEvents();
    const loop = () => {
      if (this._needsRender) {
        this._needsRender = false;
        this._render();
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  _resize() {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.requestRender();
  }

  _render() {
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this.renderCount++;
  }

  requestRender() {
    this._needsRender = true;
  }

  add(obj) {
    this.modelsRoot.add(obj);
    this.requestRender();
  }

  remove(obj) {
    this.modelsRoot.remove(obj);
    this.requestRender();
  }

  getAspect() {
    return this.camera.aspect;
  }

  fitToBox(box, { padding = 1.15 } = {}) {
    if (!box || box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const radius = Math.max(size.length() / 2, 0.5);
    const dist = (radius * padding) / Math.sin((this.camera.fov * Math.PI) / 360);
    const dir = this.camera.position.clone().sub(this.controls.target);
    if (dir.lengthSq() < 1e-9) dir.set(1, 0.7, 1);
    dir.normalize();
    this.controls.target.copy(center);
    this.camera.position.copy(center).addScaledVector(dir, dist);
    this.camera.near = Math.max(0.05, dist / 1000);
    this.camera.far = dist * 20 + 1000;
    this.camera.updateProjectionMatrix();
    this.controls.update();
    this.requestRender();
  }

  fitAll() {
    const box = new THREE.Box3().setFromObject(this.modelsRoot);
    this.fitToBox(box);
  }

  setClipping(key, planes) {
    if (!planes || !planes.length) this._clipGroups.delete(key);
    else this._clipGroups.set(key, [...planes]);
    const union = [];
    for (const g of this._clipGroups.values()) union.push(...g);
    this._clipUnion = union;
    this.renderer.clippingPlanes = union;
    this.requestRender();
  }

  getClippingPlanes() {
    return [...this._clipUnion];
  }

  addPickProvider(provider) {
    this._providers.set(provider.id, provider);
    return () => this._providers.delete(provider.id);
  }

  pickAll(ndc, { kinds } = {}) {
    this.camera.updateMatrixWorld();
    this._raycaster.setFromCamera(new THREE.Vector2(ndc.x, ndc.y), this.camera);
    const out = [];
    for (const p of this._providers.values()) {
      for (const h of p.raycast(this._raycaster) || []) {
        if (kinds && !kinds.includes(h.kind)) continue;
        if (this._clipUnion.some((pl) => pl.distanceToPoint(h.point) < 0)) continue;
        out.push(h);
      }
    }
    return out.sort((a, b) => a.distance - b.distance);
  }

  pick(ndc, opts) {
    return this.pickAll(ndc, opts)[0] || null;
  }

  ndcFromEvent(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * 2 - 1, y: -(((e.clientY - r.top) / r.height) * 2 - 1) };
  }

  // Posición en píxeles (clientX/Y) del centro de un punto de la escena (para pruebas)
  projectToClient(vec3) {
    const v = vec3.clone().project(this.camera);
    const r = this.canvas.getBoundingClientRect();
    return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height };
  }

  _payload(e) {
    return {
      ndc: this.ndcFromEvent(e),
      clientX: e.clientX,
      clientY: e.clientY,
      button: e.button,
      shiftKey: e.shiftKey,
      ctrlKey: e.ctrlKey,
      metaKey: e.metaKey,
      altKey: e.altKey,
    };
  }

  _bindEvents() {
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => {
      this._down = { x: e.clientX, y: e.clientY };
      this._dragging = false;
    });
    c.addEventListener('pointermove', (e) => {
      if (this._down && Math.hypot(e.clientX - this._down.x, e.clientY - this._down.y) > 5) this._dragging = true;
      this.bus.emit('viewer:pointermove', { ndc: this.ndcFromEvent(e), clientX: e.clientX, clientY: e.clientY });
    });
    c.addEventListener('pointerup', (e) => {
      const d = this._down;
      this._down = null;
      const moved = d ? Math.hypot(e.clientX - d.x, e.clientY - d.y) : 0;
      this._dragging = false;
      if (moved < 5) this.bus.emit('viewer:click', this._payload(e));
    });
    c.addEventListener('dblclick', (e) => this.bus.emit('viewer:dblclick', this._payload(e)));
    c.addEventListener('pointerleave', () => this.bus.emit('viewer:pointerleave'));
  }
}
