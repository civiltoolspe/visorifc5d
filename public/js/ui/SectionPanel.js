// Panel de la caja de sección: deslizadores mínimo/máximo por eje (límites de section.getBounds()).
// Escribe en store.section mediante actions.setSection; los espectadores ven los cambios replicados.

import { h, safe, setText, clamp, setClass } from './dom.js';
import { icon } from './icons.js';
import { Component } from './Component.js';
import { formatCoord } from './format.js';
import { iconButton, textButton } from './widgets.js';

const AXES = [
  { key: 'x', index: 0, name: 'Eje X', hint: 'Oeste a este' },
  { key: 'y', index: 1, name: 'Altura', hint: 'Abajo a arriba' },
  { key: 'z', index: 2, name: 'Eje Z', hint: 'Norte a sur' },
];

export class SectionPanel extends Component {
  constructor(ui) {
    super(ui);
    this.bounds = null; // { min:[x,y,z], max:[x,y,z] }
    this.rows = [];

    for (const axis of AXES) this.rows.push(this._buildRow(axis));

    this.fitBtn = textButton({ label: 'A la selección', icon: 'isolate', title: 'Ajustar la caja a la selección', className: 'btn--sm', onClick: () => this._fitSelection() });
    this.resetBtn = textButton({ label: 'Restablecer', icon: 'refresh', className: 'btn--sm', onClick: () => this._reset() });
    this.el = h(
      'section',
      { class: 'panel-card tool-panel section-panel', hidden: true, 'aria-label': 'Caja de sección' },
      h(
        'header',
        { class: 'panel-card__head' },
        h('h3', { class: 'panel-card__title' }, icon('section', { size: 16 }), 'Sección'),
        iconButton({ icon: 'x', title: 'Desactivar la sección', className: 'btn--sm btn--ghost', size: 16, onClick: () => this.actions.setSection({ enabled: false }) }),
      ),
      ...this.rows.map((r) => r.el),
      h('div', { class: 'tool-panel__actions' }, this.fitBtn, this.resetBtn),
    );

    this.watch(['section', 'selection']);
    this.onBus(['model:loaded', 'model:unloaded', 'origin:changed'], () => {
      this.bounds = null;
      this.schedule();
    });
    this.render();
  }

  _buildRow(axis) {
    const track = h('div', { class: 'dual__track' }, h('div', { class: 'dual__fill' }));
    const minIn = h('input', { type: 'range', class: 'dual__in dual__in--min', 'aria-label': `${axis.name}: límite inferior`, title: `${axis.name}: límite inferior`, min: '0', max: '1', step: '0.001', value: '0' });
    const maxIn = h('input', { type: 'range', class: 'dual__in dual__in--max', 'aria-label': `${axis.name}: límite superior`, title: `${axis.name}: límite superior`, min: '0', max: '1', step: '0.001', value: '1' });
    const valueEl = h('span', { class: 'axis-row__value' });
    const el = h(
      'div',
      { class: 'axis-row' },
      h('div', { class: 'axis-row__head' }, h('span', { class: 'axis-row__name', text: axis.name }), h('span', { class: 'axis-row__hint', text: axis.hint }), valueEl),
      h('div', { class: 'dual' }, track, minIn, maxIn),
    );
    const row = { axis, el, minIn, maxIn, valueEl, fill: track.firstElementChild };
    minIn.addEventListener('input', () => this._onSlide(row, 'min'));
    maxIn.addEventListener('input', () => this._onSlide(row, 'max'));
    return row;
  }

  // Límites actuales (escena). Se recalculan al activar y cuando la caja se sale de ellos.
  _getBounds(sec) {
    if (!this.bounds) {
      const box = safe(() => this.ctx.section?.getBounds?.(), null);
      if (box && !box.isEmpty?.()) {
        this.bounds = { min: box.min.toArray(), max: box.max.toArray() };
      } else {
        this.bounds = { min: [...sec.min], max: [...sec.max] };
      }
    }
    // Si la caja recibida (p. ej. del presentador) sale de los límites, se amplían
    for (let i = 0; i < 3; i++) {
      if (Number.isFinite(sec.min[i]) && sec.min[i] < this.bounds.min[i]) this.bounds.min[i] = sec.min[i];
      if (Number.isFinite(sec.max[i]) && sec.max[i] > this.bounds.max[i]) this.bounds.max[i] = sec.max[i];
    }
    for (let i = 0; i < 3; i++) {
      if (!(this.bounds.max[i] > this.bounds.min[i])) this.bounds.max[i] = this.bounds.min[i] + 1;
    }
    return this.bounds;
  }

  _onSlide(row, side) {
    const sec = this.store.get('section');
    const b = this._getBounds(sec);
    const i = row.axis.index;
    const lo = b.min[i];
    const hi = b.max[i];
    let vmin = lo + (Number(row.minIn.value) / 1) * (hi - lo);
    let vmax = lo + (Number(row.maxIn.value) / 1) * (hi - lo);
    const gap = (hi - lo) * 0.002;
    if (side === 'min') vmin = Math.min(vmin, vmax - gap);
    else vmax = Math.max(vmax, vmin + gap);
    const min = [...sec.min];
    const max = [...sec.max];
    min[i] = vmin;
    max[i] = vmax;
    this.actions.setSection({ min, max });
  }

  _fitSelection() {
    const items = this.ui.selectionItems();
    const box = items.length ? safe(() => this.ctx.ifc?.getBoxOf?.(items), null) : null;
    if (box && !box.isEmpty?.() && this.ctx.section?.fitTo) {
      this.ctx.section.fitTo(box);
    } else {
      this.ui.toast('info', 'Selecciona un elemento para ajustar la sección a su caja.');
    }
    this.bounds = null;
    this.schedule();
  }

  _reset() {
    const section = this.ctx.section;
    this.bounds = null;
    if (section?.reset) section.reset();
    else {
      const box = safe(() => section?.getBounds?.(), null);
      if (box) section.fitTo?.(box);
    }
    this.schedule();
  }

  // Convierte un valor de escena en coordenada de mapa para mostrarlo (si se conoce el origen)
  _display(index, v) {
    const o = safe(() => this.ctx.viewer?.worldOrigin?.origin, null);
    if (!o) return v;
    if (index === 0) return v + o.e;
    if (index === 1) return v + o.h;
    return -v + o.n;
  }

  render() {
    const sec = this.store.get('section');
    const on = !!sec.enabled;
    this.el.hidden = !on;
    if (!on) {
      this.bounds = null;
      return;
    }
    const b = this._getBounds(sec);
    for (const row of this.rows) {
      const i = row.axis.index;
      const span = b.max[i] - b.min[i];
      const f = (v) => clamp((v - b.min[i]) / span, 0, 1);
      const a = f(sec.min[i]);
      const z = f(sec.max[i]);
      if (document.activeElement !== row.minIn) row.minIn.value = String(a);
      if (document.activeElement !== row.maxIn) row.maxIn.value = String(z);
      row.fill.style.left = `${a * 100}%`;
      row.fill.style.right = `${(1 - z) * 100}%`;
      let va = this._display(i, sec.min[i]);
      let vb = this._display(i, sec.max[i]);
      if (i === 2 && va > vb) [va, vb] = [vb, va];
      const digits = 2;
      setText(row.valueEl, `${formatCoord(va, digits)} – ${formatCoord(vb, digits)}`);
    }
    const hasSel = this.ui.selectionItems().length > 0;
    setClass(this.fitBtn, 'is-dim', !hasSel);
  }
}
