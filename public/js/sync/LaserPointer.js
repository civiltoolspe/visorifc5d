// Puntero láser del presentador, dibujado en las PCs espectadoras.
//
// Crea un <canvas> superpuesto al contenedor del visor (viewer.renderer.domElement.parentElement)
// con pointer-events: none. Dibuja un punto rojo (#FF2D2D) con halo y una estela que se
// desvanece en ~300 ms. Los estilos van en línea (esta capa no depende de ningún CSS externo).
//
//   const laser = new LaserPointer({ viewer });
//   laser.update({ x, y, aspect, visible });   // NDC del presentador + su relación de aspecto
//   laser.hide();
//   laser.getState();                           // para pruebas y depuración
//   laser.dispose();
//
// Corrección de aspecto: la cámara del espectador replica el alto vertical de la del presentador,
// de modo que un punto del mundo ocupa el mismo y NDC; en x se compensa con
// x' = x · aspectPresentador / aspectLocal.

const COLOR = '#FF2D2D';
const TRAIL_MS = 300; // duración de la estela
const IDLE_MS = 3000; // sin mensajes durante este tiempo: se oculta
const FADE_MS = 180; // desvanecimiento al ocultarse
const SMOOTH_MS = 45; // constante de tiempo del suavizado de la cabeza (los mensajes llegan a ~30 Hz)
const HEAD_RADIUS = 6;
const HALO_RADIUS = 22;
const OFFSCREEN_ALPHA = 0.4;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export class LaserPointer {
  constructor({ viewer, trailMs = TRAIL_MS, idleMs = IDLE_MS } = {}) {
    this.viewer = viewer;
    this.trailMs = trailMs;
    this.idleMs = idleMs;

    this.canvas = null;
    this.ctx = null;
    this._raf = 0;
    this._idleTimer = null;
    this._visible = false; // objetivo lógico (lo que pide el presentador)
    this._hiddenAt = 0;
    this._target = { x: 0, y: 0 }; // px, posición objetivo en el overlay
    this._head = null; // px, posición dibujada (suavizada)
    this._trail = []; // { x, y, t }
    this._last = { ndcX: 0, ndcY: 0, offscreen: false };
    this._lastTick = 0;
    this._dpr = 1;
    this._size = { w: 0, h: 0 };
  }

  // ---------- API ----------

  // p: { x, y, aspect, visible } enviado por el presentador
  update(p) {
    if (!p || typeof p !== 'object') return;
    if (p.visible === false) {
      this.hide();
      return;
    }
    const x = Number(p.x);
    const y = Number(p.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    if (!this._ensureCanvas()) return;
    this._measure();

    const aspectLocal = this._aspectLocal();
    const aspectRemote = Number(p.aspect);
    const k = Number.isFinite(aspectRemote) && aspectRemote > 0 && aspectLocal > 0 ? aspectRemote / aspectLocal : 1;
    const xc = x * k;
    const offscreen = Math.abs(xc) > 1 || Math.abs(y) > 1;
    const nx = clamp(xc, -1, 1);
    const ny = clamp(y, -1, 1);
    this._last = { ndcX: xc, ndcY: y, offscreen };
    this._target = {
      x: ((nx + 1) / 2) * this._size.w,
      y: ((1 - ny) / 2) * this._size.h,
    };
    if (!this._visible || !this._head) this._head = { ...this._target };
    this._visible = true;
    this._hiddenAt = 0;
    this._syncDataset();

    clearTimeout(this._idleTimer);
    this._idleTimer = setTimeout(() => this.hide(), this.idleMs);
    this._schedule();
  }

  hide() {
    clearTimeout(this._idleTimer);
    this._idleTimer = null;
    if (!this._visible) return;
    this._visible = false;
    this._hiddenAt = performance.now();
    this._syncDataset();
    this._schedule();
  }

  getState() {
    return {
      visible: this._visible,
      ndcX: this._last.ndcX,
      ndcY: this._last.ndcY,
      offscreen: this._last.offscreen,
      px: this._target.x,
      py: this._target.y,
      width: this._size.w,
      height: this._size.h,
      attached: !!this.canvas?.isConnected,
    };
  }

  dispose() {
    clearTimeout(this._idleTimer);
    cancelAnimationFrame(this._raf);
    this._raf = 0;
    this._visible = false;
    this.canvas?.remove();
    this.canvas = null;
    this.ctx = null;
  }

  // ---------- Capa de dibujo ----------

  _host() {
    const v = this.viewer;
    return v?.renderer?.domElement?.parentElement || v?.container || document.body;
  }

  _ensureCanvas() {
    const host = this._host();
    if (!host) return false;
    if (this.canvas && this.canvas.parentElement === host) return true;
    this.canvas?.remove();
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
    const c = document.createElement('canvas');
    c.className = 'visor-laser';
    c.setAttribute('aria-hidden', 'true');
    Object.assign(c.style, {
      position: 'absolute',
      left: '0',
      top: '0',
      width: '100%',
      height: '100%',
      pointerEvents: 'none',
      zIndex: '40',
    });
    c.dataset.visible = 'false';
    host.appendChild(c);
    this.canvas = c;
    this.ctx = c.getContext('2d');
    return !!this.ctx;
  }

  _measure() {
    const c = this.canvas;
    const w = Math.max(1, c.clientWidth || this._host().clientWidth || 1);
    const h = Math.max(1, c.clientHeight || this._host().clientHeight || 1);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (w !== this._size.w || h !== this._size.h || dpr !== this._dpr || c.width !== Math.round(w * dpr)) {
      this._size = { w, h };
      this._dpr = dpr;
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
    }
  }

  _aspectLocal() {
    const a = typeof this.viewer?.getAspect === 'function' ? Number(this.viewer.getAspect()) : NaN;
    if (Number.isFinite(a) && a > 0) return a;
    return this._size.w / Math.max(1, this._size.h);
  }

  _syncDataset() {
    const d = this.canvas?.dataset;
    if (!d) return;
    d.visible = this._visible ? 'true' : 'false';
    d.px = this._target.x.toFixed(1);
    d.py = this._target.y.toFixed(1);
  }

  _schedule() {
    if (!this._raf) this._raf = requestAnimationFrame((t) => this._tick(t));
  }

  _tick(t) {
    this._raf = 0;
    if (!this.ctx) return;
    this._measure();
    const now = performance.now();
    const dt = this._lastTick ? clamp(now - this._lastTick, 0, 100) : 16;
    this._lastTick = now;

    const fade = this._visible ? 1 : clamp(1 - (now - this._hiddenAt) / FADE_MS, 0, 1);

    if (this._visible && this._head) {
      const k = 1 - Math.exp(-dt / SMOOTH_MS);
      this._head.x += (this._target.x - this._head.x) * k;
      this._head.y += (this._target.y - this._head.y) * k;
      const last = this._trail[this._trail.length - 1];
      if (!last || Math.hypot(last.x - this._head.x, last.y - this._head.y) > 0.5) {
        this._trail.push({ x: this._head.x, y: this._head.y, t: now });
      }
    }
    while (this._trail.length && now - this._trail[0].t > this.trailMs) this._trail.shift();

    this._draw(now, fade);

    const animating = this._visible || fade > 0 || this._trail.length > 0;
    if (animating) {
      this._schedule();
    } else {
      this._lastTick = 0;
      this._head = null;
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }
  }

  _draw(now, fade) {
    const ctx = this.ctx;
    const dpr = this._dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const base = (this._last.offscreen ? OFFSCREEN_ALPHA : 1) * fade;
    if (base <= 0 && !this._trail.length) return;

    // Estela: segmentos con grosor y opacidad decrecientes según la edad
    ctx.lineCap = 'round';
    for (let i = 1; i < this._trail.length; i++) {
      const a = this._trail[i - 1];
      const b = this._trail[i];
      const life = clamp(1 - (now - b.t) / this.trailMs, 0, 1);
      if (life <= 0) continue;
      ctx.strokeStyle = COLOR;
      ctx.globalAlpha = 0.55 * life * Math.max(base, 0.25 * fade);
      ctx.lineWidth = 2 + HEAD_RADIUS * 0.9 * life;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }

    if (!this._head || base <= 0) {
      ctx.globalAlpha = 1;
      return;
    }
    const { x, y } = this._head;
    // Halo
    const g = ctx.createRadialGradient(x, y, 0, x, y, HALO_RADIUS);
    g.addColorStop(0, 'rgba(255,45,45,0.55)');
    g.addColorStop(0.45, 'rgba(255,45,45,0.22)');
    g.addColorStop(1, 'rgba(255,45,45,0)');
    ctx.globalAlpha = base;
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, HALO_RADIUS, 0, Math.PI * 2);
    ctx.fill();
    // Punto
    ctx.fillStyle = COLOR;
    ctx.beginPath();
    ctx.arc(x, y, HEAD_RADIUS, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
}
