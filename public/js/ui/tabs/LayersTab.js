// Pestaña Capas CAD: capas por plano (color, ojo, conteo), todas / ninguna y cota del plano
// (automática o manual). El estado vive en store.cad (sincronizado).

import { h, clear, safe, setClass, debounce } from '../dom.js';
import { icon } from '../icons.js';
import { TabBase } from './TabBase.js';
import { emptyState, iconButton, segmented, textButton } from '../widgets.js';
import { formatInt, formatNumber } from '../format.js';

const norm = (s) =>
  String(s ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase();

const FILTER_MIN_LAYERS = 10;

export class LayersTab extends TabBase {
  constructor(ui) {
    super(ui, 'layers', 'Capas CAD');
    this.filters = new Map(); // modelId -> texto del filtro
    this.refs = new Map(); // modelId -> { layers: Map<name, { row, btn }>, modelBtn, ... }
    this.root = h('div', { class: 'layers' });
    this.el.append(this.root);

    this.watch(['modelRecords', 'presentation'], () => this.schedule());
    this.watch(['cad', 'models'], () => (this.active ? this._refreshStates() : (this._dirty = true)));
    this.onBus(['model:loaded', 'model:unloaded']);
  }

  _cadRecords() {
    return this.ui.records().filter((r) => r.kind !== 'ifc');
  }

  draw() {
    const root = clear(this.root);
    this.refs.clear();
    const records = this._cadRecords();
    if (!records.length) {
      root.append(
        emptyState({
          icon: 'layers',
          title: 'Sin planos CAD',
          text: this.ui.isViewer() ? 'Cuando el presentador cargue un DXF o DWG sus capas aparecerán aquí.' : 'Carga un plano DXF o DWG georreferenciado desde la pestaña Inicio.',
          action: this.ui.isViewer() ? null : textButton({ label: 'Ir a Inicio', icon: 'home', className: 'btn--sm', onClick: () => this.actions.setTab('models') }),
        }),
      );
      return;
    }
    for (const rec of records) root.append(this._modelBlock(rec));
    this._refreshStates();
  }

  _modelBlock(rec) {
    const ui = this.ui;
    const loaded = ui.cadLoaded(rec.id);
    const m = (safe(() => this.ctx.cad?.getModels?.(), []) || []).find((x) => x.id === rec.id) || null;
    const layers = loaded ? safe(() => this.ctx.cad?.getLayers?.(rec.id), []) || [] : [];
    const refs = { layers: new Map(), modelBtn: null, filterEmpty: null };
    this.refs.set(rec.id, refs);

    // ---- Cabecera
    refs.modelBtn = h('button', { type: 'button', class: 'btn btn--icon btn--sm btn--ghost' });
    refs.modelBtn.addEventListener('click', () => {
      const visible = this.store.get('models')[rec.id]?.visible !== false;
      this.actions.setModelVisible(rec.id, !visible);
    });
    const head = h(
      'header',
      { class: 'lmodel__head' },
      h('span', { class: `model__kind model__kind--${rec.kind}`, text: String(rec.kind).toUpperCase() }),
      h('div', { class: 'model__text' }, h('h4', { class: 'model__name', title: rec.name, text: rec.name }), h('p', { class: 'model__meta', text: loaded ? `${formatInt(layers.length)} ${layers.length === 1 ? 'capa' : 'capas'}${m?.units ? ` · unidades ${m.units}` : ''}` : 'Cargando…' })),
      h(
        'div',
        { class: 'model__actions' },
        refs.modelBtn,
        iconButton({
          icon: 'fit',
          title: 'Encuadrar el plano',
          className: 'btn--sm btn--ghost',
          size: 17,
          disabled: !loaded,
          onClick: () => {
            const box = safe(() => this.ctx.cad?.getBox?.(rec.id), null);
            if (box && !box.isEmpty?.()) safe(() => this.ctx.viewer?.fitToBox?.(box));
          },
        }),
      ),
    );

    const block = h('section', { class: 'panel-card lmodel', 'data-model': rec.id }, head);
    if (!loaded) {
      block.append(h('p', { class: 'muted', text: 'El plano todavía se está procesando.' }));
      return block;
    }

    // ---- Barra de capas: todas / ninguna / filtro
    const allBtn = textButton({ label: 'Todas', icon: 'eye', className: 'btn--sm', title: 'Mostrar todas las capas', onClick: () => this.actions.setCadLayersHidden(rec.id, layers.map((l) => l.name), false) });
    const noneBtn = textButton({ label: 'Ninguna', icon: 'eye-off', className: 'btn--sm', title: 'Ocultar todas las capas', onClick: () => this.actions.setCadLayersHidden(rec.id, layers.map((l) => l.name), true) });
    const bar = h('div', { class: 'lmodel__bar' }, allBtn, noneBtn);
    block.append(bar);

    let filterInput = null;
    if (layers.length >= FILTER_MIN_LAYERS) {
      filterInput = h('input', { type: 'text', class: 'input input--search', placeholder: 'Filtrar capas…', 'aria-label': 'Filtrar capas', autocomplete: 'off', spellcheck: 'false', value: this.filters.get(rec.id) || '' });
      const apply = debounce(() => {
        this.filters.set(rec.id, filterInput.value);
        this._applyLayerFilter(rec.id);
      }, 100);
      filterInput.addEventListener('input', apply);
      block.append(h('div', { class: 'input-icon lmodel__filter' }, icon('filter', { size: 15 }), filterInput));
    }

    // ---- Lista
    const list = h('ul', { class: 'layer-list' });
    if (!layers.length) list.append(h('li', { class: 'muted pad', text: 'El plano no tiene capas.' }));
    for (const l of layers) {
      const btn = h('button', { type: 'button', class: 'layer__eye' });
      btn.addEventListener('click', () => {
        const hidden = (this.store.get('cad')[rec.id]?.hiddenLayers || []).includes(l.name);
        this.actions.setCadLayerHidden(rec.id, l.name, !hidden);
      });
      const row = h(
        'li',
        { class: 'layer', 'data-hay': norm(l.name) },
        h('span', { class: 'layer__swatch', style: { background: l.color || '#2b2b2b' }, 'aria-hidden': 'true' }),
        h('span', { class: 'layer__name', title: l.name, text: l.name || '(sin nombre)' }),
        h('span', { class: 'layer__count', text: formatInt(l.count) }),
        btn,
      );
      refs.layers.set(l.name, { row, btn });
      list.append(row);
    }
    refs.filterEmpty = h('li', { class: 'muted pad', text: 'Ninguna capa coincide con el filtro.', hidden: true });
    list.append(refs.filterEmpty);
    block.append(list);

    // ---- Cota del plano
    block.append(this._elevationBox(rec, m, refs));
    return block;
  }

  _elevationBox(rec, m, refs) {
    const viewerOnly = this.ui.isViewer();
    const seg = segmented(
      [
        { value: 'auto', label: 'Automática', title: 'Cota automática: sobre el nivel más bajo del IFC' },
        { value: 'manual', label: 'Manual', title: 'Cota manual en metros (coordenada de mapa H)' },
      ],
      {
        ariaLabel: 'Cota del plano',
        className: 'seg--sm',
        onChange: (v) => {
          if (viewerOnly) return;
          if (v === 'auto') this.actions.setCadElevation(rec.id, null);
          else this.actions.setCadElevation(rec.id, Number.isFinite(m?.elevation) ? Math.round(m.elevation * 100) / 100 : 0);
        },
      },
    );
    const input = h('input', { type: 'number', class: 'input', step: '0.01', inputmode: 'decimal', 'aria-label': 'Cota manual del plano en metros', disabled: viewerOnly });
    const apply = () => {
      const v = Number(input.value);
      if (input.value === '' || !Number.isFinite(v)) {
        this.ui.toast('warning', 'Escribe una cota válida en metros.');
        return;
      }
      this.actions.setCadElevation(rec.id, v);
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') apply();
    });
    const applyBtn = iconButton({ icon: 'check', title: 'Aplicar la cota', className: 'btn--sm', size: 16, onClick: apply, disabled: viewerOnly });
    refs.elev = { seg, input, applyBtn, hint: h('p', { class: 'field__hint' }) };
    return h(
      'div',
      { class: 'lmodel__elev' },
      h('div', { class: 'lmodel__elev-head' }, h('span', { class: 'field__label', text: 'Cota del plano (H)' }), seg.el),
      h('div', { class: 'row-gap' }, h('span', { class: 'input-wrap' }, input, h('span', { class: 'input-wrap__unit', text: 'm' })), applyBtn),
      refs.elev.hint,
    );
  }

  _applyLayerFilter(modelId) {
    const refs = this.refs.get(modelId);
    if (!refs) return;
    const q = norm((this.filters.get(modelId) || '').trim());
    let shown = 0;
    for (const { row } of refs.layers.values()) {
      const hit = !q || row.dataset.hay.includes(q);
      row.hidden = !hit;
      if (hit) shown++;
    }
    if (refs.filterEmpty) refs.filterEmpty.hidden = !(q && shown === 0);
  }

  // Actualización en sitio (sin reconstruir) ante cambios de capas, cota o visibilidad
  _refreshStates() {
    const cadState = this.store.get('cad') || {};
    const modelsState = this.store.get('models') || {};
    for (const [modelId, refs] of this.refs) {
      const st = cadState[modelId] || { hiddenLayers: [], elevation: null };
      const hidden = new Set(st.hiddenLayers || []);
      for (const [name, { row, btn }] of refs.layers) {
        const off = hidden.has(name);
        setClass(row, 'is-hidden', off);
        const want = off ? 'eye-off' : 'eye';
        if (btn.dataset.icon !== want) {
          btn.dataset.icon = want;
          btn.replaceChildren(icon(want, { size: 16 }));
          btn.title = off ? `Mostrar la capa ${name}` : `Ocultar la capa ${name}`;
          btn.setAttribute('aria-label', btn.title);
          btn.setAttribute('aria-pressed', off ? 'true' : 'false');
        }
      }
      const visible = modelsState[modelId]?.visible !== false;
      if (refs.modelBtn) {
        const want = visible ? 'eye' : 'eye-off';
        if (refs.modelBtn.dataset.icon !== want) {
          refs.modelBtn.dataset.icon = want;
          refs.modelBtn.replaceChildren(icon(want, { size: 17 }));
          refs.modelBtn.title = visible ? 'Ocultar el plano' : 'Mostrar el plano';
          refs.modelBtn.setAttribute('aria-label', refs.modelBtn.title);
        }
        setClass(refs.modelBtn, 'is-off', !visible);
      }
      if (refs.elev) {
        const manual = st.elevation !== null && st.elevation !== undefined;
        refs.elev.seg.set(manual ? 'manual' : 'auto');
        const m = (safe(() => this.ctx.cad?.getModels?.(), []) || []).find((x) => x.id === modelId);
        const effective = m?.elevation;
        if (document.activeElement !== refs.elev.input) refs.elev.input.value = manual ? String(st.elevation) : Number.isFinite(effective) ? effective.toFixed(2) : '';
        refs.elev.input.disabled = !manual || this.ui.isViewer();
        refs.elev.applyBtn.disabled = !manual || this.ui.isViewer();
        refs.elev.hint.textContent = manual
          ? 'Cota fija en metros (coordenada de mapa).'
          : `Automática: nivel más bajo del IFC + 0,02 m${Number.isFinite(effective) ? ` (${formatNumber(effective, 2)} m)` : ''}.`;
      }
      this._applyLayerFilter(modelId);
    }
  }
}
