// Dock inferior plegable (vidrio marrón a naranja): "Resumen del modelo" y "Categorías".

import { h, clear, safe, setText } from './dom.js';
import { icon } from './icons.js';
import { Component } from './Component.js';
import { formatDate, formatInt, plural } from './format.js';
import { emptyState } from './widgets.js';

const FILLS = ['yellow', 'orange', 'light', 'yellow'];

export class Dock extends Component {
  constructor(ui) {
    super(ui);

    // ---- Resumen del modelo
    this.dateText = h('span', { text: formatDate() });
    this.statsEl = h('div', { class: 'stats' });
    this.summary = h(
      'section',
      { class: 'dock-card dock-card--summary', 'aria-label': 'Resumen del modelo' },
      h('header', { class: 'dock-card__head' }, h('h2', { class: 'dock-card__title', text: 'Resumen del modelo' }), h('span', { class: 'dock-date' }, icon('calendar', { size: 14 }), this.dateText)),
      this.statsEl,
    );

    // ---- Categorías
    this.catCount = h('span', { class: 'dock-card__count' });
    this.showAllBtn = h('button', { type: 'button', class: 'dock-link', title: 'Mostrar todo: categorías, elementos y modelos ocultos', on: { click: () => this._showAll() } }, 'Mostrar todo');
    this.catList = h('ul', { class: 'cat-list' });
    this.categories = h(
      'section',
      { class: 'dock-card dock-card--cats', 'aria-label': 'Categorías' },
      h('header', { class: 'dock-card__head' }, h('h2', { class: 'dock-card__title', text: 'Categorías' }), h('div', { class: 'dock-card__tools' }, this.catCount, this.showAllBtn)),
      this.catList,
    );

    // ---- Pestaña de plegado (como la de la referencia)
    this.handle = h(
      'button',
      { type: 'button', class: 'dock__handle', title: 'Plegar o desplegar el panel', 'aria-label': 'Plegar o desplegar el panel inferior', 'aria-expanded': 'true', on: { click: () => this.actions.toggleDock() } },
      h('span', { class: 'dock__handle-bar' }),
    );

    this.el = h('div', { class: 'dock' }, this.summary, this.categories, this.handle);

    this.watch(['visibility', 'display', 'models', 'storey', 'modelRecords', 'ui']);
    this._spacesAutoShown = false; // el aislamiento de Espacios encendió display.showSpaces (se apaga al quitarlo)
    this.onBus(['model:loaded', 'model:unloaded']);
    this.render();
  }

  render() {
    const ui = this.ui;
    const vis = this.store.get('visibility');
    const ui$ = this.store.get('ui');
    const types = ui.typeSummary();
    const storeys = ui.storeys();
    const records = ui.records();
    const modelsState = this.store.get('models') || {};
    const st = this.store.get('storey');

    this.handle.setAttribute('aria-expanded', ui$.dockOpen ? 'true' : 'false');
    setText(this.dateText, formatDate());

    // ---------- Resumen ----------
    // Tipos ocultos de verdad: los de la lista más IfcSpace mientras "Mostrar espacios" esté apagado; y los modelos
    // ocultos con el ojo de su tarjeta cuentan como ocultos (ui.visibilitySummary)
    const hiddenTypeSet = ui.effectiveHiddenTypes(types);
    const { total, hidden: hiddenEls, visible: visibleEls, visibleCategories: visCats } = ui.visibilitySummary(types);
    const visModels = records.filter((r) => modelsState[r.id]?.visible !== false).length;
    const ifcCount = records.filter((r) => r.kind === 'ifc').length;
    const cadCount = records.length - ifcCount;
    const activeStorey = st.active ? storeys.find((s) => ui.storeyMatches(s, st.active)) : null;

    const stats = [
      {
        key: 'elements',
        value: formatInt(total),
        label: plural(total, 'elemento', 'elementos'),
        frac: total ? visibleEls / total : 0,
        left: `${formatInt(visibleEls)} ${plural(visibleEls, 'visible', 'visibles')}`,
        right: hiddenEls ? `${formatInt(hiddenEls)} ${plural(hiddenEls, 'oculto', 'ocultos')}` : '',
        rightWarn: true,
      },
      {
        key: 'storeys',
        value: formatInt(storeys.length),
        label: plural(storeys.length, 'nivel', 'niveles'),
        frac: storeys.length ? (activeStorey ? 1 : 1) : 0,
        left: activeStorey ? activeStorey.name || 'Nivel activo' : 'Todos los niveles',
        right: activeStorey ? (st.mode === 'only' ? 'Solo' : 'Corte') : '',
      },
      {
        key: 'categories',
        value: formatInt(types.length),
        label: plural(types.length, 'categoría', 'categorías'),
        frac: types.length ? visCats / types.length : 0,
        left: `${formatInt(visCats)} ${plural(visCats, 'visible', 'visibles')}`,
        right: types.length - visCats ? `${types.length - visCats} ${plural(types.length - visCats, 'oculta', 'ocultas')}` : '',
        rightWarn: true,
      },
      {
        key: 'models',
        value: formatInt(records.length),
        label: plural(records.length, 'modelo', 'modelos'),
        frac: records.length ? visModels / records.length : 0,
        left: `${ifcCount} IFC`,
        right: cadCount ? `${cadCount} CAD` : '',
      },
    ];

    clear(this.statsEl);
    stats.forEach((s, i) => {
      const bar = h('span', { class: `stat__bar stat__bar--${FILLS[i]}` }, h('i', { style: { width: `${Math.round(s.frac * 100)}%` } }));
      this.statsEl.append(
        h(
          'div',
          { class: 'stat', 'data-stat': s.key },
          h('div', { class: 'stat__top' }, h('span', { class: 'stat__value', text: s.value }), h('span', { class: 'stat__label', text: s.label })),
          bar,
          h('div', { class: 'stat__foot' }, h('span', { text: s.left }), s.right ? h('span', { class: s.rightWarn ? 'is-warn' : '', text: s.right }) : null),
        ),
      );
    });

    // ---------- Categorías ----------
    const totalCount = types.reduce((a, t) => a + t.count, 0) || 1;
    const all = types.map((t) => t.type);
    const isolatedType = this._isolatedType(types, new Set(vis.hiddenTypes || []));
    setText(this.catCount, types.length ? `${types.length}` : '');
    const anyModelHidden = Object.values(modelsState).some((m) => m && m.visible === false);
    this.showAllBtn.hidden = !(vis.hiddenTypes?.length || hiddenTypeSet.size || vis.isolated || anyModelHidden);

    clear(this.catList);
    if (!types.length) {
      this.catList.append(h('li', { class: 'cat-list__empty' }, emptyState({ icon: 'layers', title: 'Sin categorías', text: 'Carga un modelo IFC para ver sus categorías.' })));
      return;
    }
    for (const t of types) {
      const hidden = hiddenTypeSet.has(t.type);
      const share = Math.round((t.count / totalCount) * 100);
      const isolated = isolatedType === t.type;
      const eye = h(
        'button',
        {
          type: 'button',
          class: 'cat__eye',
          title: hidden ? `Mostrar ${t.label}` : `Ocultar ${t.label}`,
          'aria-label': hidden ? `Mostrar ${t.label}` : `Ocultar ${t.label}`,
          'aria-pressed': hidden ? 'true' : 'false',
          on: { click: () => this._setTypeHidden(t.type, !hidden) },
        },
        icon(hidden ? 'eye-off' : 'eye', { size: 17 }),
      );
      const main = h(
        'button',
        {
          type: 'button',
          class: 'cat__main',
          title: isolated ? `Quitar el aislamiento de ${t.label}` : `Aislar ${t.label}`,
          'aria-label': isolated ? `Quitar el aislamiento de ${t.label}` : `Aislar la categoría ${t.label}`,
          'aria-pressed': isolated ? 'true' : 'false',
          on: { click: () => this._toggleIsolate(t.type, all) },
        },
        h('span', { class: 'cat__badge', text: (t.label || t.type).trim().charAt(0).toUpperCase() }),
        h('span', { class: 'cat__text' }, h('span', { class: 'cat__name', text: t.label || t.type }), h('span', { class: 'cat__sub', text: `${formatInt(t.count)} ${plural(t.count, 'elemento', 'elementos')}` })),
        h('span', { class: 'cat__share' }, h('span', { class: 'cat__pct', text: `${share}%` }), h('span', { class: 'cat__bar' }, h('i', { style: { width: `${Math.max(2, share)}%` } }))),
      );
      this.catList.append(h('li', { class: `cat${hidden ? ' is-hidden' : ''}${isolated ? ' is-isolated' : ''}`, 'data-type': t.type }, main, eye));
    }
  }

  // Devuelve el tipo aislado si todos los demás están ocultos; si no, null.
  // `hiddenSet` es la lista de visibility.hiddenTypes; Espacios solo cuenta como aislado si además se dibujan.
  _isolatedType(types, hiddenSet) {
    if (types.length < 2) return null;
    const visible = types.filter((t) => !hiddenSet.has(t.type));
    if (visible.length !== 1) return null;
    if (visible[0].type === 'IFCSPACE' && !this.store.get('display').showSpaces) return null;
    return visible[0].type;
  }

  // Los espacios (IfcSpace) dependen de dos controles: la lista de tipos ocultos y display.showSpaces ("Mostrar espacios"
  // de Ajustes). Su ojo gobierna los dos a la vez para que la fila, el contador y el interruptor digan lo mismo.
  _setTypeHidden(type, hide) {
    if (type !== 'IFCSPACE') {
      this.actions.setTypeHidden(type, hide);
      return;
    }
    const vis = this.store.get('visibility');
    const rest = (vis.hiddenTypes || []).filter((t) => t !== 'IFCSPACE');
    this.store.setMany({
      visibility: { ...vis, hiddenTypes: hide ? [...rest, 'IFCSPACE'] : rest },
      display: { ...this.store.get('display'), showSpaces: !hide },
    });
    this._spacesAutoShown = false;
  }

  // "Mostrar todo": quita ocultaciones y aislamientos y también muestra los espacios.
  _showAll() {
    const display = this.store.get('display');
    this.actions.showAll();
    if (!display.showSpaces) this.actions.toggleSpaces(true);
    this._spacesAutoShown = false;
  }

  _toggleIsolate(type, all) {
    const vis = this.store.get('visibility');
    const display = this.store.get('display');
    const isolated = this._isolatedType(
      all.map((t) => ({ type: t })),
      new Set(vis.hiddenTypes || []),
    );
    if (isolated === type) {
      // Quitar el aislamiento; si lo encendió Espacios, se vuelve a ocultar como estaba
      const back = this._spacesAutoShown && display.showSpaces;
      this._spacesAutoShown = false;
      this.store.setMany(back ? { visibility: { ...vis, hiddenTypes: [] }, display: { ...display, showSpaces: false } } : { visibility: { ...vis, hiddenTypes: [] } });
      return;
    }
    const hiddenTypes = all.filter((t) => t !== type);
    // Aislar Espacios no dibujaría nada si siguen ocultos por defecto: se encienden mientras dure el aislamiento
    if (type === 'IFCSPACE' && !display.showSpaces) {
      this._spacesAutoShown = true;
      this.store.setMany({ visibility: { ...vis, hiddenTypes }, display: { ...display, showSpaces: true } });
      return;
    }
    this.store.patch('visibility', { hiddenTypes });
  }
}
