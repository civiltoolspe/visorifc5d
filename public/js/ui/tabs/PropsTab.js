// Pestaña Propiedades: atributos, Psets, cantidades, tipo y materiales del elemento seleccionado
// (await ifc.getProperties), en secciones plegables con buscador y botón para copiar el GlobalId.

import { h, clear, safe, setClass, debounce, copyText } from '../dom.js';
import { icon } from '../icons.js';
import { TabBase } from './TabBase.js';
import { emptyState, iconButton } from '../widgets.js';
import { formatPropValue, formatInt } from '../format.js';

const norm = (s) =>
  String(s ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase();

const keyOf = (it) => `${it.modelId}:${it.expressId}`;

export class PropsTab extends TabBase {
  constructor(ui) {
    super(ui, 'props', 'Propiedades');
    this.focusKey = null;
    this.query = '';
    this.toggled = new Map(); // título de sección -> abierta (decisión del usuario)
    this.token = 0;
    this.cache = new Map();

    this.headerEl = h('div', { class: 'props-head' });
    this.switcherEl = h('div', { class: 'props-switcher', hidden: true });
    this.searchInput = h('input', { type: 'text', class: 'input input--search', placeholder: 'Buscar propiedad…', 'aria-label': 'Buscar una propiedad', autocomplete: 'off', spellcheck: 'false' });
    const apply = debounce(() => {
      this.query = norm(this.searchInput.value.trim());
      this._applyFilter();
    }, 120);
    this.searchInput.addEventListener('input', apply);
    this.searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.searchInput.value) {
        e.stopPropagation();
        this.searchInput.value = '';
        this.query = '';
        this._applyFilter();
      }
    });
    this.addCleanup(() => apply.cancel());
    this.searchWrap = h('div', { class: 'input-icon props-search' }, icon('search', { size: 15 }), this.searchInput);
    this.bodyEl = h('div', { class: 'props-body' });
    this.el.append(this.headerEl, this.switcherEl, this.searchWrap, this.bodyEl);

    this.watch('selection');
    this.onBus(['model:loaded', 'model:unloaded']);
  }

  draw() {
    const items = this.ui.selectionItems();
    if (!items.length) {
      this.headerEl.replaceChildren();
      this.switcherEl.hidden = true;
      this.searchWrap.hidden = true;
      this.bodyEl.replaceChildren(emptyState({ icon: 'info', title: 'Ningún elemento seleccionado', text: 'Haz clic en un elemento del visor o del árbol para ver sus propiedades.' }));
      this.focusKey = null;
      this.token++;
      return;
    }
    this.searchWrap.hidden = false;
    let focus = items.find((it) => keyOf(it) === this.focusKey);
    if (!focus) focus = items[0];
    const changed = this.focusKey !== keyOf(focus);
    this.focusKey = keyOf(focus);

    this._drawHeader(focus, items);
    this._drawSwitcher(focus, items);
    if (changed || !this.bodyEl.firstElementChild || this.bodyEl.dataset.key !== this.focusKey) this._loadProps(focus);
  }

  _drawHeader(focus, items) {
    const info = this.ui.elementInfo(focus);
    const name = info?.name || info?.typeLabel || `Elemento ${focus.expressId}`;
    const guid = info?.globalId || '';
    const copyBtn = guid
      ? iconButton({
          icon: 'copy',
          title: 'Copiar GlobalId',
          className: 'btn--sm btn--ghost',
          size: 15,
          onClick: async () => {
            const ok = await copyText(guid);
            this.ui.toast(ok ? 'success' : 'warning', ok ? 'GlobalId copiado.' : 'No se pudo copiar el GlobalId.');
          },
        })
      : null;
    const fitBtn = iconButton({
      icon: 'fit',
      title: 'Encuadrar el elemento',
      className: 'btn--sm btn--ghost',
      size: 16,
      onClick: () => {
        const box = safe(() => this.ctx.ifc?.getBoxOf?.([focus]), null);
        if (box && !box.isEmpty?.()) safe(() => this.ctx.viewer?.fitToBox?.(box));
      },
    });
    this.headerEl.replaceChildren(
      h('div', { class: 'props-head__top' }, h('h2', { class: 'props-head__name', title: name, text: name }), fitBtn),
      h('p', { class: 'props-head__sub' }, h('span', { text: info?.typeLabel || 'Elemento' }), h('i', { class: 'sep', 'aria-hidden': 'true' }), h('span', { text: info?.storeyName || 'Sin nivel' })),
      guid ? h('div', { class: 'props-guid' }, h('span', { class: 'props-guid__label', text: 'GlobalId' }), h('code', { class: 'props-guid__code', title: guid, text: guid }), copyBtn) : null,
    );
  }

  _drawSwitcher(focus, items) {
    if (items.length < 2) {
      this.switcherEl.hidden = true;
      return;
    }
    const i = items.findIndex((it) => keyOf(it) === keyOf(focus));
    const go = (d) => {
      const n = items[(i + d + items.length) % items.length];
      this.focusKey = keyOf(n);
      this.draw();
    };
    this.switcherEl.hidden = false;
    this.switcherEl.replaceChildren(
      iconButton({ icon: 'chevron-left', title: 'Elemento anterior de la selección', className: 'btn--sm btn--ghost', size: 16, onClick: () => go(-1) }),
      h('span', { class: 'props-switcher__text', text: `${i + 1} de ${formatInt(items.length)} seleccionados` }),
      iconButton({ icon: 'chevron-right', title: 'Elemento siguiente de la selección', className: 'btn--sm btn--ghost', size: 16, onClick: () => go(1) }),
    );
  }

  async _loadProps(focus) {
    const key = keyOf(focus);
    const token = ++this.token;
    this.bodyEl.dataset.key = key;
    const cached = this.cache.get(key);
    if (cached) {
      this._renderProps(cached);
      return;
    }
    this.bodyEl.replaceChildren(h('div', { class: 'props-loading', role: 'status' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), h('span', { text: 'Leyendo propiedades…' })));
    let props = null;
    try {
      props = await this.ctx.ifc?.getProperties?.(focus.modelId, focus.expressId);
    } catch (err) {
      console.warn('[ui] propiedades', err);
    }
    if (token !== this.token || this._disposed) return;
    if (!props) {
      this.bodyEl.replaceChildren(emptyState({ icon: 'alert', title: 'No se pudieron leer las propiedades', text: 'El modelo no respondió. Inténtalo de nuevo.' }));
      return;
    }
    this.cache.set(key, props);
    if (this.cache.size > 30) this.cache.delete(this.cache.keys().next().value);
    this._renderProps(props);
  }

  // ------------------------------------------------------------------ secciones
  _renderProps(p) {
    const root = clear(this.bodyEl);
    const sections = [];
    const attrs = (p.attributes || []).filter((a) => a && a.name);
    if (attrs.length) sections.push({ title: 'Atributos', rows: attrs.map((a) => [a.name, formatPropValue(a.value)]), open: true });
    (p.quantities || []).forEach((q, i) => {
      if (!q?.props?.length) return;
      sections.push({ title: q.name ? `Cantidades · ${q.name}` : 'Cantidades', rows: q.props.map((r) => [r.name, `${formatPropValue(r.value)}${r.unit ? ` ${r.unit}` : ''}`]), open: i < 2 });
    });
    (p.psets || []).forEach((ps, i) => {
      if (!ps?.props?.length) return;
      sections.push({ title: ps.name || 'Conjunto de propiedades', rows: ps.props.map((r) => [r.name, formatPropValue(r.value)]), open: i < 2 });
    });
    if (p.type) {
      const typeName = p.type.name || 'Tipo';
      (p.type.psets || []).forEach((ps) => {
        if (!ps?.props?.length) return;
        sections.push({ title: `Tipo ${typeName} · ${ps.name || 'Propiedades'}`, rows: ps.props.map((r) => [r.name, formatPropValue(r.value)]), open: false });
      });
      if (!(p.type.psets || []).length) sections.push({ title: 'Tipo', rows: [['Nombre', typeName]], open: true });
    }
    if (p.materials?.length) sections.push({ title: 'Materiales', chips: p.materials, rows: p.materials.map((m) => ['', m]), open: true });

    if (!sections.length) {
      root.append(emptyState({ icon: 'info', title: 'Sin propiedades', text: 'Este elemento no tiene atributos ni conjuntos de propiedades.' }));
      return;
    }
    for (const s of sections) root.append(this._section(s));
    this._applyFilter();
  }

  _section(s) {
    const open = this.toggled.has(s.title) ? this.toggled.get(s.title) : s.open;
    const body = h('div', { class: 'psec__body', hidden: !open });
    if (s.chips) {
      body.append(h('div', { class: 'chips' }, ...s.chips.map((m) => h('span', { class: 'chip chip--soft', 'data-hay': norm(m), text: m }))));
    } else {
      const list = h('dl', { class: 'prop-list' });
      for (const [k, v] of s.rows) {
        list.append(h('div', { class: 'prop', 'data-hay': norm(`${k} ${v}`) }, h('dt', { class: 'prop__k', title: k, text: k }), h('dd', { class: 'prop__v', text: v })));
      }
      body.append(list);
    }
    const count = s.rows.length;
    const head = h(
      'button',
      { type: 'button', class: 'psec__head', 'aria-expanded': open ? 'true' : 'false' },
      icon('chevron-right', { size: 15, className: 'psec__caret' }),
      h('span', { class: 'psec__title', text: s.title }),
      h('span', { class: 'psec__count', text: String(count) }),
    );
    const el = h('section', { class: `psec${open ? ' is-open' : ''}`, 'data-title': norm(s.title), 'data-user-open': open ? '1' : '0' }, head, body);
    head.addEventListener('click', () => {
      const now = body.hidden;
      body.hidden = !now;
      this.toggled.set(s.title, now);
      el.dataset.userOpen = now ? '1' : '0';
      setClass(el, 'is-open', now);
      head.setAttribute('aria-expanded', now ? 'true' : 'false');
    });
    return el;
  }

  // Filtra filas por nombre o valor; con texto de búsqueda abre las secciones con coincidencias
  _applyFilter() {
    const q = this.query;
    for (const sec of this.bodyEl.querySelectorAll('.psec')) {
      const body = sec.querySelector('.psec__body');
      const rows = [...sec.querySelectorAll('[data-hay]')];
      if (!q) {
        for (const r of rows) r.hidden = false;
        sec.hidden = false;
        const open = sec.dataset.userOpen === '1';
        body.hidden = !open;
        setClass(sec, 'is-open', open);
        sec.querySelector('.psec__head').setAttribute('aria-expanded', open ? 'true' : 'false');
        continue;
      }
      const titleMatch = (sec.dataset.title || '').includes(q);
      let any = 0;
      for (const r of rows) {
        const hit = titleMatch || r.dataset.hay.includes(q);
        r.hidden = !hit;
        if (hit) any++;
      }
      sec.hidden = any === 0;
      body.hidden = any === 0;
      setClass(sec, 'is-open', any > 0);
      sec.querySelector('.psec__head').setAttribute('aria-expanded', any > 0 ? 'true' : 'false');
    }
  }
}
