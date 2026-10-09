// Tarjeta oscura de selección: nombre, tipo, nivel, GlobalId corto, acceso a propiedades y
// acciones ocultar / aislar / mostrar todo. Con varios elementos muestra "N elementos".

import { h, clear, setClass, setText, copyText } from './dom.js';
import { icon } from './icons.js';
import { Component } from './Component.js';
import { shortGuid, formatInt, plural } from './format.js';

export class SelectionCard extends Component {
  constructor(ui) {
    super(ui);
    this.nameEl = h('h2', { class: 'sel__name' });
    this.subEl = h('p', { class: 'sel__sub' });
    this.guidBtn = h('button', { type: 'button', class: 'sel__guid', title: 'Copiar GlobalId', 'aria-label': 'Copiar GlobalId' });
    this.guidBtn.addEventListener('click', async () => {
      const guid = this.guidBtn.dataset.guid;
      if (!guid) return;
      const ok = await copyText(guid);
      this.ui.toast(ok ? 'success' : 'warning', ok ? 'GlobalId copiado.' : 'No se pudo copiar el GlobalId.');
    });
    this.propsBtn = h('button', { type: 'button', class: 'btn btn--icon btn--onDark', title: 'Ver propiedades', 'aria-label': 'Ver propiedades del elemento', on: { click: () => this.actions.setTab('props') } }, icon('arrow-right', { size: 18 }));
    this.clearBtn = h('button', { type: 'button', class: 'btn btn--icon btn--onDark', title: 'Limpiar selección (Esc)', 'aria-label': 'Limpiar selección', on: { click: () => this.actions.clearSelection() } }, icon('x', { size: 16 }));

    this.hideBtn = this._act('Ocultar', 'eye-off', 'Ocultar la selección (H)', 'sel-act--orange', () => this.actions.hideSelected());
    this.isolateBtn = this._act('Aislar', 'isolate', 'Aislar la selección (I)', 'sel-act--yellow', () => this.actions.isolateSelected());
    this.showBtn = this._act('Mostrar todo', 'eye', 'Mostrar todo (Mayús + H)', 'sel-act--grey', () => this.actions.showAll());
    this.showCount = h('span', { class: 'sel-act__count', hidden: true });
    this.showBtn.append(this.showCount);

    this.el = h(
      'div',
      { class: 'sel card-dark', role: 'region', 'aria-label': 'Elemento seleccionado', hidden: true },
      h('div', { class: 'sel__top' }, h('div', { class: 'sel__titles' }, this.nameEl, this.subEl), h('div', { class: 'sel__btns' }, this.guidBtn, this.propsBtn, this.clearBtn)),
      h('div', { class: 'sel__acts' }, this.hideBtn, this.isolateBtn, this.showBtn),
    );

    this.watch(['selection', 'visibility']);
    this.onBus(['model:loaded', 'model:unloaded']);
    this.render();
  }

  _act(label, iconName, title, cls, fn) {
    return h('button', { type: 'button', class: `sel-act ${cls}`, title, 'aria-label': title, on: { click: fn } }, icon(iconName, { size: 15 }), h('span', { class: 'sel-act__label', text: label }));
  }

  render() {
    const items = this.ui.selectionItems();
    const vis = this.store.get('visibility');
    const hiddenN = this.ui.hiddenCount() + (vis.hiddenTypes?.length || 0);
    const anyFilter = hiddenN > 0 || !!vis.isolated;
    this.el.hidden = items.length === 0;
    setClass(this.showBtn, 'is-active', anyFilter);
    this.showCount.hidden = !hiddenN;
    setText(this.showCount, hiddenN ? formatInt(hiddenN) : '');
    if (!items.length) return;

    if (items.length === 1) {
      const info = this.ui.elementInfo(items[0]);
      setText(this.nameEl, info?.name || info?.typeLabel || `Elemento ${items[0].expressId}`);
      const parts = [info?.typeLabel || 'Elemento', info?.storeyName || 'Sin nivel'];
      setText(this.subEl, parts.join(' · '));
      this.guidBtn.dataset.guid = info?.globalId || '';
      this.guidBtn.hidden = !info?.globalId;
      clear(this.guidBtn).append(icon('copy', { size: 13 }), h('span', { text: shortGuid(info?.globalId) }));
      this.guidBtn.title = info?.globalId ? `GlobalId: ${info.globalId} (clic para copiar)` : 'Copiar GlobalId';
    } else {
      setText(this.nameEl, `${formatInt(items.length)} elementos`);
      const counts = new Map();
      const storeys = new Set();
      for (const it of items.slice(0, 2000)) {
        const info = this.ui.elementInfo(it);
        const label = info?.typeLabel || 'Elemento';
        counts.set(label, (counts.get(label) || 0) + 1);
        if (info?.storeyName) storeys.add(info.storeyName);
      }
      const top = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([label, n]) => `${n} ${label.toLowerCase()}`);
      const more = counts.size > 2 ? ` y ${counts.size - 2} ${plural(counts.size - 2, 'tipo más', 'tipos más')}` : '';
      const level = storeys.size === 1 ? ` · ${[...storeys][0]}` : storeys.size > 1 ? ` · ${storeys.size} niveles` : '';
      setText(this.subEl, `${top.join(', ')}${more}${level}`);
      this.guidBtn.hidden = true;
      this.guidBtn.dataset.guid = '';
    }
  }
}
