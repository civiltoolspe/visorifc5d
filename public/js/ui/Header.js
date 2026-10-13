// Cabecera sobre el visor: título grande (proyecto IFC) y chips de edificio y fecha.

import { h, safe, setText } from './dom.js';
import { icon } from './icons.js';
import { Component } from './Component.js';
import { formatDate } from './format.js';

const DEFAULT_TITLE = 'Visor IFC 5D';

function chip(iconName, textEl, title) {
  return h('span', { class: 'chip chip--soft', title }, icon(iconName, { size: 15 }), textEl);
}

export class Header extends Component {
  constructor(ui) {
    super(ui);
    this.titleEl = h('h1', { class: 'header__title', text: DEFAULT_TITLE });
    this.buildingText = h('span', { class: 'chip__text', text: 'Sin modelo' });
    this.dateText = h('span', { class: 'chip__text', text: formatDate() });
    this.el = h(
      'header',
      { class: 'header' },
      this.titleEl,
      h('div', { class: 'header__chips' }, chip('building', this.buildingText, 'Edificio'), chip('calendar', this.dateText, 'Fecha')),
    );
    this.onBus(['model:loaded', 'model:unloaded']);
    this.watch('modelRecords');
    this.render();
  }

  render() {
    const info = safe(() => this.ctx.ifc?.getProjectInfo?.(), null);
    const title = (info?.name || info?.longName || '').trim() || DEFAULT_TITLE;
    setText(this.titleEl, title);
    this.titleEl.title = title;

    let building = 'Sin modelo';
    if (info) {
      const list = info.buildings || [];
      building = list.length ? (list.length > 1 ? `${list[0]} +${list.length - 1}` : list[0]) : info.longName || 'Edificio';
    } else if (this.ui.records().length) {
      building = 'Sin modelo IFC';
    }
    setText(this.buildingText, building);
    setText(this.dateText, formatDate());
  }
}
