// Barra lateral izquierda: logo, buscador, iconos de presentación / conexión / ajustes y
// las píldoras de pestañas (Inicio, Árbol, Propiedades, Capas, Vistas). La pestaña activa y la
// apertura de la barra viven en store.ui (sincronizado con los espectadores).

import { h, setClass, setAttr } from './dom.js';
import { icon, logo } from './icons.js';
import { Component } from './Component.js';
import { SearchBox } from './SearchBox.js';
import { HomeTab } from './tabs/HomeTab.js';
import { TreeTab } from './tabs/TreeTab.js';
import { PropsTab } from './tabs/PropsTab.js';
import { LayersTab } from './tabs/LayersTab.js';
import { ViewsTab } from './tabs/ViewsTab.js';

const TAB_DEFS = [
  { id: 'models', label: 'Inicio', icon: 'home' },
  { id: 'tree', label: 'Árbol', icon: 'tree' },
  { id: 'props', label: 'Propiedades', icon: 'info' },
  { id: 'layers', label: 'Capas CAD', icon: 'layers' },
  { id: 'views', label: 'Vistas', icon: 'bookmark' },
];

export class Sidebar extends Component {
  constructor(ui, { presentationPanel, connectionPanel, settingsPanel }) {
    super(ui);
    this.panels = { presentationPanel, connectionPanel, settingsPanel };

    this.search = new SearchBox(ui);

    // ---- Cabecera: logo + buscador + iconos
    const iconBtn = (name, title, onClick) =>
      h('button', { type: 'button', class: 'btn btn--icon btn--bare sidebar__icon', title, 'aria-label': title, 'aria-haspopup': 'dialog', 'aria-expanded': 'false', on: { click: onClick } }, icon(name, { size: 18 }));
    this.presentBtn = iconBtn('cast', 'Presentación', (e) => presentationPanel.toggle(e.currentTarget));
    this.connBtn = iconBtn('wifi', 'Conexión', (e) => connectionPanel.toggle(e.currentTarget));
    this.settingsBtn = iconBtn('sliders', 'Ajustes', (e) => settingsPanel.toggle(e.currentTarget));
    this.presentDot = h('i', { class: 'icon-dot', 'aria-hidden': 'true' });
    this.connDot = h('i', { class: 'icon-dot icon-dot--ok', 'aria-hidden': 'true' });
    this.presentBtn.append(this.presentDot);
    this.connBtn.append(this.connDot);
    this.collapseBtn = h('button', { type: 'button', class: 'btn btn--icon btn--bare sidebar__icon', title: 'Ocultar la barra lateral', 'aria-label': 'Ocultar la barra lateral', on: { click: () => this.actions.toggleSidebar(false) } }, icon('panel-close', { size: 18 }));

    // El logo abre el "Acerca de" (diálogo local: no cambia el store)
    this.logoBtn = h(
      'button',
      { type: 'button', class: 'sidebar__logo', title: 'Acerca de Visor IFC 5D', 'aria-label': 'Acerca de Visor IFC 5D', 'aria-haspopup': 'dialog', on: { click: (e) => ui.about?.open(e.currentTarget) } },
      logo({ size: 44 }),
    );

    this.head = h(
      'div',
      { class: 'sidebar__head' },
      h('div', { class: 'sidebar__row' }, this.logoBtn, this.search.el, h('div', { class: 'sidebar__icons' }, this.presentBtn, this.connBtn, this.settingsBtn, this.collapseBtn)),
      this.search.panel,
    );

    // ---- Píldoras
    this.pills = h('div', { class: 'pills', role: 'tablist', 'aria-label': 'Secciones de la barra lateral' });
    this.pillBtns = new Map();
    for (const def of TAB_DEFS) {
      const btn = h(
        'button',
        { type: 'button', class: 'pill', role: 'tab', id: `pill-${def.id}`, title: def.label, 'aria-label': def.label, 'aria-controls': `tab-${def.id}`, 'aria-selected': 'false', 'data-tab': def.id },
        icon(def.icon, { size: 19 }),
        h('span', { class: 'pill__label', text: def.label }),
      );
      btn.addEventListener('click', () => this.actions.setTab(def.id));
      btn.addEventListener('keydown', (e) => this._onPillKey(e, def.id));
      this.pillBtns.set(def.id, btn);
      this.pills.append(btn);
    }

    // ---- Pestañas
    this.tabs = {
      models: new HomeTab(ui),
      tree: new TreeTab(ui),
      props: new PropsTab(ui),
      layers: new LayersTab(ui),
      views: new ViewsTab(ui),
    };
    this.content = h('div', { class: 'sidebar__content' });
    for (const tab of Object.values(this.tabs)) this.content.append(tab.el);

    this.el = h('aside', { class: 'sidebar card', 'aria-label': 'Barra lateral' }, this.head, this.pills, this.content);

    this.watch(['ui', 'presentation']);
    this.render();
  }

  _onPillKey(e, id) {
    const ids = TAB_DEFS.map((d) => d.id);
    const i = ids.indexOf(id);
    let next = null;
    if (e.key === 'ArrowRight') next = ids[(i + 1) % ids.length];
    else if (e.key === 'ArrowLeft') next = ids[(i - 1 + ids.length) % ids.length];
    else if (e.key === 'Home') next = ids[0];
    else if (e.key === 'End') next = ids[ids.length - 1];
    if (!next) return;
    e.preventDefault();
    this.actions.setTab(next);
    this.pillBtns.get(next)?.focus();
  }

  focusSearch() {
    if (!this.store.get('ui').sidebarOpen) this.actions.toggleSidebar(true);
    requestAnimationFrame(() => this.search.focus());
  }

  render() {
    const ui$ = this.store.get('ui');
    const p = this.store.get('presentation');
    const tab = this.tabs[ui$.tab] ? ui$.tab : 'models';
    for (const [id, btn] of this.pillBtns) {
      const on = id === tab;
      setClass(btn, 'is-on', on);
      setAttr(btn, 'aria-selected', on ? 'true' : 'false');
      btn.tabIndex = on ? 0 : -1;
    }
    if (tab !== this._lastTab) {
      this.content.scrollTop = 0;
      this._lastTab = tab;
    }
    for (const [id, t] of Object.entries(this.tabs)) t.setActive(id === tab);

    // Indicadores de los iconos
    setClass(this.presentDot, 'is-on', !!p.active);
    setClass(this.connDot, 'is-off', !p.connected);
    this.connBtn.replaceChildren(icon(p.connected ? 'wifi' : 'wifi-off', { size: 18 }), this.connDot);
    this.connBtn.title = p.connected ? 'Conexión: conectado' : 'Conexión: reconectando…';
    this.connBtn.setAttribute('aria-label', this.connBtn.title);
    this.presentBtn.title = p.active ? 'Presentación en vivo' : 'Presentación';
    this.presentBtn.setAttribute('aria-label', this.presentBtn.title);
  }

  dispose() {
    for (const t of Object.values(this.tabs)) t.dispose();
    this.search.dispose();
    super.dispose();
  }
}
