// Buscador de elementos del modelo (ifc.search) con resultados desplegables y navegación por teclado.

import { h, clear, safe, setClass, debounce, setText } from './dom.js';
import { icon } from './icons.js';
import { Component } from './Component.js';
import { shortGuid, formatInt } from './format.js';

const LIMIT = 50;

function highlight(text, query) {
  const t = String(text ?? '');
  const q = query.trim().toLowerCase();
  if (!q) return [t];
  const i = t.toLowerCase().indexOf(q.split(/\s+/)[0]);
  if (i < 0) return [t];
  const len = q.split(/\s+/)[0].length;
  return [t.slice(0, i), h('mark', { text: t.slice(i, i + len) }), t.slice(i + len)];
}

export class SearchBox extends Component {
  constructor(ui) {
    super(ui);
    this.results = [];
    this.activeIndex = -1;

    this.input = h('input', {
      type: 'text',
      class: 'search__input',
      placeholder: 'Buscar elementos',
      'aria-label': 'Buscar elementos del modelo',
      'aria-autocomplete': 'list',
      'aria-controls': 'search-results',
      autocomplete: 'off',
      spellcheck: 'false',
      enterkeyhint: 'search',
    });
    this.clearBtn = h('button', { type: 'button', class: 'search__clear', title: 'Borrar búsqueda', 'aria-label': 'Borrar búsqueda', hidden: true, on: { click: () => this.clear(true) } }, icon('x', { size: 14 }));
    this.el = h('div', { class: 'search' }, icon('search', { size: 17, className: 'search__icon' }), this.input, this.clearBtn);

    this.summaryEl = h('span', { class: 'search-results__count' });
    this.selectAllBtn = h('button', { type: 'button', class: 'dock-link dock-link--dark', on: { click: () => this._selectAll() } }, 'Seleccionar todos');
    this.listEl = h('div', { class: 'search-results__list', role: 'listbox', id: 'search-results' });
    this.panel = h('div', { class: 'search-results card-pop', hidden: true }, h('div', { class: 'search-results__head' }, this.summaryEl, this.selectAllBtn), this.listEl);

    this.run = debounce(() => this.search(), 110);
    this.input.addEventListener('input', () => {
      setClass(this.clearBtn, 'is-hidden', !this.input.value);
      this.clearBtn.hidden = !this.input.value;
      this.run();
    });
    this.input.addEventListener('keydown', (e) => this._onKey(e));
    this.input.addEventListener('focus', () => {
      if (this.input.value.trim()) this.search();
    });
    this.listen(document, 'pointerdown', (e) => {
      if (this.panel.hidden) return;
      if (this.el.contains(e.target) || this.panel.contains(e.target)) return;
      this.hide();
    }, true);
    this.addCleanup(() => this.run.cancel());
    this.onBus(['model:loaded', 'model:unloaded'], () => this.input.value.trim() && !this.panel.hidden && this.search());
  }

  focus() {
    this.input.focus();
    this.input.select();
  }

  hide() {
    this.panel.hidden = true;
    this.activeIndex = -1;
  }

  clear(focus = false) {
    this.input.value = '';
    this.clearBtn.hidden = true;
    this.hide();
    if (focus) this.input.focus();
  }

  search() {
    const q = this.input.value.trim();
    if (!q) {
      this.hide();
      return;
    }
    const hasIfc = (safe(() => this.ctx.ifc?.getModels?.(), []) || []).length > 0;
    this.results = hasIfc ? safe(() => this.ctx.ifc?.search?.(q, LIMIT), []) || [] : [];
    this.activeIndex = this.results.length ? 0 : -1;
    this.panel.hidden = false;
    clear(this.listEl);

    if (!hasIfc) {
      this.summaryEl.textContent = '';
      this.selectAllBtn.hidden = true;
      this.listEl.append(h('p', { class: 'search-results__empty', text: 'Carga un modelo IFC para buscar sus elementos.' }));
      return;
    }
    if (!this.results.length) {
      this.summaryEl.textContent = 'Sin resultados';
      this.selectAllBtn.hidden = true;
      this.listEl.append(h('p', { class: 'search-results__empty', text: `Ningún elemento coincide con “${q}”.` }));
      return;
    }
    const more = this.results.length >= LIMIT;
    setText(this.summaryEl, `${more ? `${LIMIT}+` : formatInt(this.results.length)} ${this.results.length === 1 ? 'resultado' : 'resultados'}`);
    this.selectAllBtn.hidden = this.results.length < 2;
    this.results.forEach((r, i) => {
      const item = h(
        'button',
        { type: 'button', class: `result${i === this.activeIndex ? ' is-active' : ''}`, role: 'option', 'aria-selected': i === this.activeIndex ? 'true' : 'false', 'data-index': String(i), id: `search-result-${i}` },
        h('span', { class: 'result__badge', text: (r.typeLabel || r.type || '?').charAt(0).toUpperCase() }),
        h('span', { class: 'result__text' }, h('span', { class: 'result__name' }, ...highlight(r.name || r.typeLabel, q)), h('span', { class: 'result__type', text: `${r.typeLabel || r.type}${r.globalId ? ` · ${shortGuid(r.globalId)}` : ''}` })),
      );
      item.addEventListener('click', () => this._pick(i));
      item.addEventListener('pointerenter', () => this._setActive(i, false));
      this.listEl.append(item);
    });
    if (more) this.listEl.append(h('p', { class: 'search-results__more', text: 'Hay más resultados: afina la búsqueda.' }));
  }

  _setActive(i, scroll = true) {
    const items = this.listEl.querySelectorAll('.result');
    if (!items.length) return;
    this.activeIndex = (i + items.length) % items.length;
    items.forEach((el, idx) => {
      const on = idx === this.activeIndex;
      el.classList.toggle('is-active', on);
      el.setAttribute('aria-selected', on ? 'true' : 'false');
      if (on && scroll) el.scrollIntoView({ block: 'nearest' });
    });
    this.input.setAttribute('aria-activedescendant', `search-result-${this.activeIndex}`);
  }

  _onKey(e) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (this.panel.hidden) this.search();
      else this._setActive(this.activeIndex + 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      this._setActive(this.activeIndex - 1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (this.activeIndex >= 0) this._pick(this.activeIndex);
      else this.search();
    } else if (e.key === 'Escape') {
      e.stopPropagation();
      if (!this.panel.hidden || this.input.value) {
        this.clear();
      } else this.input.blur();
    }
  }

  _pick(i) {
    const r = this.results[i];
    if (!r) return;
    const item = { modelId: r.modelId, expressId: r.expressId };
    this.actions.select([item]);
    const box = safe(() => this.ctx.ifc?.getBoxOf?.([item]), null);
    if (box && !box.isEmpty?.()) safe(() => this.ctx.viewer?.fitToBox?.(box));
    this.hide();
    this.input.blur();
  }

  _selectAll() {
    const items = this.results.map((r) => ({ modelId: r.modelId, expressId: r.expressId }));
    if (!items.length) return;
    this.actions.select(items);
    const box = safe(() => this.ctx.ifc?.getBoxOf?.(items), null);
    if (box && !box.isEmpty?.()) safe(() => this.ctx.viewer?.fitToBox?.(box));
    this.hide();
    this.input.blur();
    this.ui.toast('info', `${formatInt(items.length)} elementos seleccionados.`);
  }
}
