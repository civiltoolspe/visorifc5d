// Columna de herramientas arriba a la derecha: miniatura de la última vista o captura y botones
// (encuadrar, 3D/planta, medir, sección, aristas, captura, ajustes de selección).

import { h, safe, setClass, setText, setAttr } from './dom.js';
import { icon } from './icons.js';
import { Component } from './Component.js';
import { Popover } from './overlay.js';
import { SectionPanel } from './SectionPanel.js';
import { formatDateLong, formatPercent, timestampForFile } from './format.js';
import { rangeControl, segmented, switchControl, textButton } from './widgets.js';

const SELECTION_MODES = [
  { value: 'ghost', label: 'Fantasma', icon: 'ghost', title: 'Fantasma: el resto se vuelve transparente' },
  { value: 'isolate', label: 'Aislar', icon: 'isolate', title: 'Aislar: se oculta el resto' },
  { value: 'highlight', label: 'Resaltar', icon: 'sun', title: 'Resaltar: solo se marca la selección' },
];

// Vistas estándar (viewer.setView). Todas son ortogonales salvo la isométrica, que vuelve a la perspectiva.
// `dir` = dirección objetivo → cámara de Viewer.VIEW_DIRS (para marcar la vista actual). Z de la escena = sur.
const STANDARD_VIEWS = [
  { value: 'top', label: 'Planta', title: 'Planta (desde arriba)', dir: [0, 1, 0] },
  { value: 'front', label: 'Frontal', title: 'Frontal (desde el sur)', dir: [0, 0, 1] },
  { value: 'back', label: 'Posterior', title: 'Posterior (desde el norte)', dir: [0, 0, -1] },
  { value: 'left', label: 'Izquierda', title: 'Lateral izquierdo (desde el oeste)', dir: [-1, 0, 0] },
  { value: 'right', label: 'Derecha', title: 'Lateral derecho (desde el este)', dir: [1, 0, 0] },
  { value: 'bottom', label: 'Inferior', title: 'Inferior (desde abajo)', dir: [0, -1, 0] },
  { value: 'iso', label: 'Isométrica', title: 'Isométrica (perspectiva)', dir: [1, 0.8, 1] },
];

export class Toolbar extends Component {
  constructor(ui) {
    super(ui);
    this.lastCapture = null; // { dataUrl, at }
    this.buttons = new Map();

    // Miniatura
    this.thumbImg = h('img', { class: 'thumb__img', alt: '', draggable: 'false', hidden: true });
    this.thumbEmpty = h('span', { class: 'thumb__empty' }, icon('camera', { size: 20 }), h('span', { text: 'Sin vistas guardadas' }));
    this.thumbLabel = h('span', { class: 'thumb__label' });
    this.thumbDate = h('span', { class: 'thumb__date' });
    this.thumb = h(
      'button',
      { type: 'button', class: 'thumb', title: 'Vistas guardadas', 'aria-label': 'Abrir las vistas guardadas', on: { click: () => this.actions.setTab('views') } },
      this.thumbImg,
      this.thumbEmpty,
      h('span', { class: 'thumb__meta' }, this.thumbLabel, this.thumbDate),
    );

    // Botones
    this.row = h('div', { class: 'tools', role: 'toolbar', 'aria-label': 'Herramientas del visor' });
    this._tool('fit', 'fit', 'Encuadrar selección o todo (F)', () => this.ui.fitSelectionOrAll());
    this._tool('proj', 'cube', 'Vista 3D: cambiar a planta', () => this._toggleProjection(), true);
    this._tool('views', 'views', 'Vistas estándar (planta, alzados, isométrica)', (e) => this.standardViews.toggle(e.currentTarget), true);
    this._tool('measure', 'ruler', 'Medir distancias (M)', () => this.actions.setMeasureActive(!this.store.get('measure').active), true);
    this._tool('section', 'section', 'Caja de sección', () => this._toggleSection(), true);
    this._tool('edges', 'edges', 'Aristas', () => this.actions.toggleEdges(), true);
    this._tool('shot', 'camera', 'Captura de pantalla (descarga una imagen)', () => this._capture());
    this._tool('sel', 'contrast', 'Ajustes de selección', (e) => this.selectionPanel.toggle(e.currentTarget), true);

    // Panel de ajustes de selección (popover)
    this.selectionPanel = new SelectionSettings(ui);
    this.selectionPanel.popover.onClose = () => this.schedule();
    this.selectionPanel.popover.onOpen = () => this.schedule();

    // Panel de vistas estándar (popover)
    this.standardViews = new StandardViews(ui);
    this.standardViews.popover.onClose = () => this.schedule();
    this.standardViews.popover.onOpen = () => {
      this.standardViews.render(); // marca la vista actual
      this.schedule();
    };

    // Subpaneles
    this.measureInfo = this._buildMeasureInfo();
    this.section = new SectionPanel(ui);

    this.el = h('div', { class: 'toolbar-col' }, this.thumb, this.row, this.measureInfo.el, this.section.el);

    this.watch(['display', 'measure', 'section', 'views']);
    this.render();
  }

  _tool(id, iconName, title, onClick, toggle = false) {
    const btn = h('button', { type: 'button', class: 'btn btn--icon btn--glass tool', title, 'aria-label': title, 'data-tool': id }, icon(iconName, { size: 19 }));
    if (toggle) btn.setAttribute('aria-pressed', 'false');
    btn.addEventListener('click', (e) => onClick(e));
    this.buttons.set(id, btn);
    this.row.append(btn);
    return btn;
  }

  _buildMeasureInfo() {
    const text = h('span', { class: 'measure-info__text' });
    const clearBtn = textButton({
      label: 'Borrar todo',
      icon: 'trash',
      className: 'btn--sm btn--ghost',
      onClick: () => this.actions.clearMeasures(),
    });
    const stopBtn = textButton({ label: 'Terminar', icon: 'check', className: 'btn--sm', onClick: () => this.actions.setMeasureActive(false) });
    const el = h('section', { class: 'panel-card tool-panel measure-info', hidden: true, 'aria-label': 'Medición' }, h('div', { class: 'measure-info__row' }, icon('ruler', { size: 16 }), text), h('div', { class: 'tool-panel__actions' }, clearBtn, stopBtn));
    return { el, text, clearBtn, stopBtn };
  }

  _toggleProjection() {
    const d = this.store.get('display');
    const viewer = this.ctx.viewer;
    if (d.projection === 'orthographic') {
      this.actions.setProjection('perspective');
      safe(() => viewer?.setView?.('iso', { fit: true }));
    } else {
      this.actions.setProjection('orthographic');
      safe(() => viewer?.setView?.('top', { fit: true }));
    }
  }

  _toggleSection() {
    const sec = this.store.get('section');
    this.actions.setSection({ enabled: !sec.enabled });
  }

  _capture() {
    const viewer = this.ctx.viewer;
    if (!viewer?.screenshot) {
      this.ui.toast('warning', 'La captura no está disponible todavía.');
      return;
    }
    try {
      const full = viewer.screenshot({ mime: 'image/jpeg', quality: 0.92 });
      const small = viewer.screenshot({ width: 320, height: 180 });
      this.lastCapture = { dataUrl: small, at: new Date() };
      const a = h('a', { href: full, download: `visor-ifc-5d_${timestampForFile()}.jpg`, style: { display: 'none' } });
      document.body.append(a);
      a.click();
      a.remove();
      this.ui.toast('success', 'Captura guardada en tus descargas.');
      this.schedule();
    } catch (err) {
      console.error(err);
      this.ui.toast('error', 'No se pudo generar la captura.');
    }
  }

  render() {
    const d = this.store.get('display');
    const m = this.store.get('measure');
    const sec = this.store.get('section');
    const views = this.store.get('views')?.items || [];

    // Miniatura: última vista guardada o, si no hay, la última captura
    const last = views[views.length - 1] || null;
    const src = last?.thumb || this.lastCapture?.dataUrl || '';
    if (src) {
      if (this.thumbImg.getAttribute('src') !== src) this.thumbImg.src = src;
      this.thumbImg.hidden = false;
      this.thumbEmpty.hidden = true;
      setText(this.thumbLabel, last?.name || 'Captura');
      setText(this.thumbDate, last ? 'Vista guardada' : formatDateLong(this.lastCapture?.at || new Date()));
    } else {
      this.thumbImg.hidden = true;
      this.thumbEmpty.hidden = false;
      setText(this.thumbLabel, '');
      setText(this.thumbDate, '');
    }
    setClass(this.thumb, 'has-image', !!src);

    const plan = d.projection === 'orthographic';
    const projBtn = this.buttons.get('proj');
    projBtn.replaceChildren(icon(plan ? 'plan' : 'cube', { size: 19 }));
    const projTitle = plan ? 'Vista en planta (ortogonal): cambiar a 3D' : 'Vista 3D (perspectiva): cambiar a planta';
    setAttr(projBtn, 'title', projTitle);
    setAttr(projBtn, 'aria-label', projTitle);
    this._pressed('proj', plan);
    this._pressed('measure', !!m.active);
    this._pressed('section', !!sec.enabled);
    this._pressed('edges', !!d.edges);
    this._pressed('sel', this.selectionPanel.popover.isOpen);
    this._pressed('views', this.standardViews.popover.isOpen);

    // Información de medición
    const showMeasure = !!m.active || m.items.length > 0;
    this.measureInfo.el.hidden = !showMeasure;
    if (showMeasure) {
      const n = m.items.length;
      const msg = m.active ? `Haz clic en dos puntos del modelo.${n ? ` ${n} ${n === 1 ? 'medición' : 'mediciones'}.` : ''}` : `${n} ${n === 1 ? 'medición' : 'mediciones'} en pantalla.`;
      setText(this.measureInfo.text, msg);
      this.measureInfo.clearBtn.hidden = n === 0;
      this.measureInfo.stopBtn.hidden = !m.active;
    }
  }

  _pressed(id, on) {
    const btn = this.buttons.get(id);
    if (!btn) return;
    setClass(btn, 'is-on', on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  }

  dispose() {
    this.selectionPanel.dispose();
    this.standardViews.dispose();
    this.section.dispose();
    super.dispose();
  }
}

// ----------------------------------------------------------------------------------------
class StandardViews extends Component {
  constructor(ui) {
    super(ui);
    this.popover = new Popover(ui, { className: 'popover--panel', align: 'end', label: 'Vistas estándar' });
    this.el = this.popover.el;
    this.seg = segmented(
      STANDARD_VIEWS.map(({ value, label, title }) => ({ value, label, title })),
      { onChange: (v) => this.go(v), ariaLabel: 'Vistas estándar', className: 'seg--stack seg--views' },
    );
    this.el.append(
      h('header', { class: 'pop-head' }, h('h3', { class: 'pop-title', text: 'Vistas estándar' })),
      h('p', { class: 'pop-text', text: 'Planta y alzados en proyección ortogonal; la isométrica vuelve a la perspectiva.' }),
      this.seg.el,
    );
  }

  toggle(anchor) {
    this.popover.toggle(anchor);
  }

  // Cambia la proyección según la vista y orienta la cámara encuadrando lo visible.
  go(name) {
    const view = STANDARD_VIEWS.find((v) => v.value === name);
    if (!view) return;
    const wantOrtho = name !== 'iso';
    if ((this.store.get('display').projection === 'orthographic') !== wantOrtho) {
      this.actions.setProjection(wantOrtho ? 'orthographic' : 'perspective');
    }
    safe(() => this.ctx.viewer?.setView?.(name, { fit: true }));
    this.popover.close();
  }

  // Marca la vista cuya dirección coincide con la de la cámara actual.
  render() {
    const cam = safe(() => this.ctx.viewer?.getCameraState?.(), null);
    let active = null;
    if (cam?.position && cam?.target) {
      const d = cam.position.map((v, i) => v - cam.target[i]);
      const len = Math.hypot(...d) || 1;
      let best = 0.999;
      for (const v of STANDARD_VIEWS) {
        const vl = Math.hypot(...v.dir);
        const dot = (d[0] * v.dir[0] + d[1] * v.dir[1] + d[2] * v.dir[2]) / (len * vl);
        if (dot > best) {
          best = dot;
          active = v.value;
        }
      }
    }
    this.seg.set(active);
  }

  dispose() {
    this.popover.dispose();
    super.dispose();
  }
}

// ----------------------------------------------------------------------------------------
class SelectionSettings extends Component {
  constructor(ui) {
    super(ui);
    this.popover = new Popover(ui, { className: 'popover--panel', align: 'end', label: 'Ajustes de selección' });
    this.el = this.popover.el;

    this.mode = segmented(SELECTION_MODES, { onChange: (v) => this.actions.setSelectionMode(v), ariaLabel: 'Qué pasa con el resto al seleccionar', className: 'seg--stack' });
    this.opacityValue = h('span', { class: 'pop-row__value' });
    this.opacity = rangeControl({ min: 0, max: 1, step: 0.01, value: 0.12, label: 'Opacidad del resto de elementos', onInput: (v) => this.actions.setGhostOpacity(v) });
    this.spaces = switchControl({ checked: false, label: 'Mostrar espacios', onChange: (v) => this.actions.toggleSpaces(v) });

    this.el.append(
      h('header', { class: 'pop-head' }, h('h3', { class: 'pop-title', text: 'Al seleccionar un elemento' })),
      h('p', { class: 'pop-text', text: 'Elige qué ocurre con el resto del modelo.' }),
      this.mode.el,
      h('div', { class: 'pop-row pop-row--stack' }, h('div', { class: 'pop-row__top' }, h('span', { class: 'pop-row__label', text: 'Opacidad del resto' }), this.opacityValue), this.opacity.el),
      h('div', { class: 'pop-row' }, h('span', { class: 'pop-row__label', text: 'Mostrar espacios (IfcSpace)' }), this.spaces.el),
    );
    this.watch('display');
    this.render();
  }

  toggle(anchor) {
    this.popover.toggle(anchor);
  }

  render() {
    const d = this.store.get('display');
    this.mode.set(d.selectionMode);
    this.opacity.set(d.ghostOpacity);
    this.opacity.el.disabled = d.selectionMode !== 'ghost';
    setText(this.opacityValue, formatPercent(d.ghostOpacity));
    this.spaces.set(d.showSpaces);
  }

  dispose() {
    this.popover.dispose();
    super.dispose();
  }
}
