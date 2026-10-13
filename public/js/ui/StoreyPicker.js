// Selector de nivel (abajo, al centro): ▲ número ▼, nombre del nivel, opción "Todos",
// miniatura en planta (viewer.renderTopView) y modo corte / solo con altura de corte.
// Todo el estado vive en store.storey (sincronizado).

import { h, safe, setClass, setText, debounce } from './dom.js';
import { icon } from './icons.js';
import { Component } from './Component.js';
import { Popover } from './overlay.js';
import { formatNumber, formatInt, pad2 } from './format.js';
import { rangeControl, segmented } from './widgets.js';

const THUMB_W = 240;
const THUMB_H = 150;

export class StoreyPicker extends Component {
  constructor(ui) {
    super(ui);
    this.thumbCache = new Map();
    this.thumbKey = null;

    this.upBtn = h('button', { type: 'button', class: 'btn btn--icon btn--bare level__step', title: 'Subir un nivel', 'aria-label': 'Subir un nivel', on: { click: () => this._step(1) } }, icon('chevron-up', { size: 17 }));
    this.downBtn = h('button', { type: 'button', class: 'btn btn--icon btn--bare level__step', title: 'Bajar un nivel', 'aria-label': 'Bajar un nivel', on: { click: () => this._step(-1) } }, icon('chevron-down', { size: 17 }));
    this.numEl = h('span', { class: 'level__num', 'aria-live': 'polite' });

    this.nameBtn = h('button', { type: 'button', class: 'level__name', title: 'Elegir nivel', 'aria-haspopup': 'listbox', 'aria-expanded': 'false', on: { click: () => this.listPopover.toggle(this.nameBtn) } });
    this.nameText = h('span', { class: 'level__name-text' });
    this.nameBtn.append(this.nameText, icon('chevron-down', { size: 14 }));
    this.metaEl = h('span', { class: 'level__meta' });
    this.allBtn = h('button', { type: 'button', class: 'chip chip--soft chip--btn', title: 'Mostrar todos los niveles', on: { click: () => this.actions.setStorey(null) } }, 'Todos');

    this.thumbImg = h('img', { class: 'level__thumb-img', alt: 'Vista en planta del nivel', draggable: 'false', hidden: true });
    this.thumbEmpty = h('span', { class: 'level__thumb-empty' }, icon('plan', { size: 22 }));
    this.thumb = h('div', { class: 'level__thumb' }, this.thumbImg, this.thumbEmpty);

    this.mode = segmented(
      [
        { value: 'cut', label: 'Corte', title: 'Corte: se ve el edificio cortado a la altura indicada sobre el nivel' },
        { value: 'only', label: 'Solo', title: 'Solo: se muestra únicamente este nivel' },
      ],
      { onChange: (v) => this.actions.setStoreyMode(v), ariaLabel: 'Modo del nivel', className: 'seg--sm' },
    );
    this.cutValue = h('span', { class: 'level__cut-value' });
    this.cutRange = rangeControl({ min: 0.1, max: 3.5, step: 0.05, value: 1.2, label: 'Altura de corte sobre el nivel', onInput: (v) => this.actions.setCutHeight(v) });
    this.cutBox = h('div', { class: 'level__cut' }, h('div', { class: 'level__cut-top' }, h('span', { class: 'level__cut-label', text: 'Altura de corte' }), this.cutValue), this.cutRange.el);

    this.el = h(
      'div',
      { class: 'level card-glass', role: 'group', 'aria-label': 'Selector de nivel' },
      h('div', { class: 'level__stepper' }, this.upBtn, this.numEl, this.downBtn),
      h('div', { class: 'level__main' }, h('div', { class: 'level__head' }, this.nameBtn, this.allBtn), this.metaEl, this.thumb),
      h('div', { class: 'level__side' }, this.mode.el, this.cutBox),
    );

    // Lista de niveles (popover)
    this.listPopover = new Popover(ui, { className: 'popover--list', align: 'start', placement: 'top', label: 'Niveles', onOpen: () => this._renderList(), onClose: () => this.nameBtn.setAttribute('aria-expanded', 'false') });
    this.listPopover.el.setAttribute('role', 'listbox');

    this._queueThumb = debounce(() => this._afterMainFrame(() => this._paintThumb()), 140);
    this.watch(['storey', 'modelRecords']);
    this.onBus(['model:loaded', 'model:unloaded'], () => {
      this.thumbCache.clear();
      this.schedule();
    });
    this.addCleanup(() => this._queueThumb.cancel());
    this.render();
  }

  _list() {
    return this.ui.storeys();
  }

  _index(list, active) {
    return active ? list.findIndex((s) => this.ui.storeyMatches(s, active)) : -1;
  }

  // dir > 0 sube (mayor elevación). Desde "Todos" sube al primer nivel; bajar desde el primero vuelve a "Todos".
  _step(dir) {
    const list = this._list();
    if (!list.length) return;
    const active = this.store.get('storey').active;
    const i = this._index(list, active);
    const next = i + dir;
    if (next < 0) this.actions.setStorey(null);
    else if (next >= list.length) return;
    else this.actions.setStorey({ modelId: list[next].modelId, expressId: list[next].expressId });
  }

  _renderList() {
    const list = this._list();
    const active = this.store.get('storey').active;
    const root = h('div', { class: 'level-list' });
    root.append(
      h(
        'button',
        { type: 'button', class: `level-list__item${!active ? ' is-on' : ''}`, role: 'option', 'aria-selected': String(!active), on: { click: () => this._pick(null) } },
        h('span', { class: 'level-list__num', text: '—' }),
        h('span', { class: 'level-list__name', text: 'Todos los niveles' }),
      ),
    );
    for (let i = list.length - 1; i >= 0; i--) {
      const s = list[i];
      const on = this.ui.storeyMatches(s, active);
      root.append(
        h(
          'button',
          { type: 'button', class: `level-list__item${on ? ' is-on' : ''}`, role: 'option', 'aria-selected': String(on), on: { click: () => this._pick(s) } },
          h('span', { class: 'level-list__num', text: pad2(i + 1) }),
          h('span', { class: 'level-list__name', text: s.name || `Nivel ${i + 1}` }),
          h('span', { class: 'level-list__elev', text: `${formatNumber(s.mapHeight, 2)} m` }),
          h('span', { class: 'level-list__count', text: s.elementCount != null ? `${formatInt(s.elementCount)} el.` : '' }),
        ),
      );
    }
    this.listPopover.setContent(root);
  }

  _pick(storey) {
    this.listPopover.close();
    this.actions.setStorey(storey ? { modelId: storey.modelId, expressId: storey.expressId } : null);
  }

  render() {
    const list = this._list();
    const st = this.store.get('storey');
    this.el.hidden = list.length === 0;
    if (!list.length) return;

    const i = this._index(list, st.active);
    const current = i >= 0 ? list[i] : null;
    setText(this.numEl, current ? pad2(i + 1) : '—');
    setText(this.nameText, current ? current.name || `Nivel ${i + 1}` : 'Todos los niveles');
    setText(
      this.metaEl,
      current
        ? `Cota ${formatNumber(current.mapHeight, 2)} m${current.elementCount != null ? ` · ${formatInt(current.elementCount)} elementos` : ''}`
        : `${list.length} ${list.length === 1 ? 'nivel' : 'niveles'} en el modelo`,
    );
    this.upBtn.disabled = i >= list.length - 1;
    this.downBtn.disabled = i < 0;
    this.allBtn.hidden = !current;

    this.mode.set(st.mode);
    for (const b of this.mode.el.querySelectorAll('button')) b.disabled = !current;
    const showCut = !!current && st.mode === 'cut';
    this.cutBox.hidden = !showCut;
    this.cutRange.set(st.cutHeight);
    setText(this.cutValue, `${formatNumber(st.cutHeight, 2)} m`);
    setClass(this.el, 'is-all', !current);
    if (this.listPopover.isOpen) this._renderList();

    this._queueThumb();
  }

  // ---------- Miniatura en planta ----------
  _boxFor(current) {
    const ifc = this.ctx.ifc;
    if (!ifc) return null;
    if (current) {
      // Un nivel puede agrupar los niveles homónimos de varios IFC federados
      let union = null;
      for (const m of current.members || [{ modelId: current.modelId, expressId: current.expressId }]) {
        const ids = safe(() => ifc.getDescendants?.(m.modelId, m.expressId), null);
        let box = null;
        if (ids?.length) box = safe(() => ifc.getBoxOf(ids.map((expressId) => ({ modelId: m.modelId, expressId }))), null);
        if (!box || box.isEmpty?.()) box = safe(() => ifc.getModelBox?.(m.modelId), null);
        if (box && !box.isEmpty?.()) union = union ? union.union(box) : box.clone();
      }
      return union;
    }
    let all = null;
    for (const m of safe(() => ifc.getModels?.(), []) || []) {
      const b = safe(() => ifc.getModelBox?.(m.id), null);
      if (b && !b.isEmpty?.()) {
        if (!all) all = b.clone();
        else all.union(b);
      }
    }
    return all;
  }

  // Ejecuta fn después de que el visor dibuje un fotograma (como mucho tras 400 ms). La miniatura se renderiza a una
  // textura aparte, compila variantes de shader y lee píxeles: en WebGL por software tarda ~1 s la primera vez, y así
  // el modelo ya está en pantalla cuando se genera. Sin contador de renders (dobles de prueba) se ejecuta de inmediato.
  _afterMainFrame(fn) {
    const viewer = this.ctx.viewer;
    const mark = viewer?.renderCount;
    if (!Number.isFinite(mark)) {
      fn();
      return;
    }
    const t0 = performance.now();
    const wait = () => {
      if (this._disposed) return;
      if (viewer.renderCount > mark || performance.now() - t0 > 400) setTimeout(() => !this._disposed && fn(), 0);
      else requestAnimationFrame(wait);
    };
    requestAnimationFrame(wait);
  }

  _paintThumb() {
    if (this._disposed || this.el.hidden) return;
    const viewer = this.ctx.viewer;
    if (!viewer?.renderTopView) return;
    const list = this._list();
    const st = this.store.get('storey');
    const i = this._index(list, st.active);
    const current = i >= 0 ? list[i] : null;
    const key = current ? `${current.modelId}:${current.expressId}` : `all:${list.length}`;
    let url = this.thumbCache.get(key);
    if (!url) {
      const box = this._boxFor(current);
      if (!box) {
        this._showThumb('');
        return;
      }
      url = safe(() => viewer.renderTopView({ box, width: THUMB_W, height: THUMB_H }), '');
      if (url) this.thumbCache.set(key, url);
    }
    this.thumbKey = key;
    this._showThumb(url);
  }

  _showThumb(url) {
    if (url) {
      if (this.thumbImg.getAttribute('src') !== url) this.thumbImg.src = url;
      this.thumbImg.hidden = false;
      this.thumbEmpty.hidden = true;
    } else {
      this.thumbImg.hidden = true;
      this.thumbEmpty.hidden = false;
    }
  }

  dispose() {
    this.listPopover.dispose();
    super.dispose();
  }
}
