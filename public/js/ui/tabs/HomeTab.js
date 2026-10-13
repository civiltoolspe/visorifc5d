// Pestaña Inicio: carga de archivos, tarjetas de modelos (progreso, georreferencia, acciones),
// resumen con cifras grandes y ubicación del proyecto.

import { h, clear, safe } from '../dom.js';
import { icon } from '../icons.js';
import { TabBase } from './TabBase.js';
import { bigNumber, card, emptyState, iconButton, progressBar, textButton } from '../widgets.js';
import { formatBytes, formatCoord, formatInt, formatNumber, georefPosition, pad2, plural, splitDecimals } from '../format.js';

const KIND_LABEL = { ifc: 'IFC', dxf: 'DXF', dwg: 'DWG' };

function bytesParts(bytes) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = Math.max(0, Number(bytes) || 0);
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return { value: v, unit: units[i] };
}

export class HomeTab extends TabBase {
  constructor(ui) {
    super(ui, 'models', 'Inicio');

    // ---- Carga de archivos (solo presentador)
    this.fileInput = h('input', { type: 'file', multiple: true, accept: '.ifc,.dxf,.dwg', hidden: true, 'aria-hidden': 'true', tabindex: '-1' });
    this.fileInput.addEventListener('change', () => {
      const files = [...this.fileInput.files];
      this.fileInput.value = '';
      if (files.length) this.ctx.loader?.uploadFiles?.(files);
    });
    this.uploadBtn = textButton({ label: 'Cargar IFC / DXF / DWG', icon: 'upload', className: 'btn--primary btn--block btn--lg', onClick: () => this.fileInput.click() });
    this.uploadCard = h(
      'section',
      { class: 'panel-card upload-card only-presenter', 'aria-label': 'Cargar archivos' },
      this.uploadBtn,
      h('p', { class: 'upload-card__hint', text: 'o arrastra los archivos sobre cualquier parte de la ventana' }),
      this.fileInput,
    );

    // ---- Modelos
    this.modelsCount = h('span', { class: 'panel-card__count' });
    this.modelsList = h('div', { class: 'models' });
    this.modelsCard = card({ title: 'Modelos', actions: this.modelsCount, children: [this.modelsList] });

    // ---- Resumen
    this.summaryBody = h('div', { class: 'summary' });
    this.summaryCard = card({ title: 'Resumen', className: 'summary-card', children: [this.summaryBody] });

    // ---- Ubicación
    this.locationBody = h('div', { class: 'location' });
    this.locationCard = card({ title: 'Ubicación', className: 'location-card', children: [this.locationBody] });

    this.el.append(this.uploadCard, this.modelsCard, this.summaryCard, this.locationCard);

    this.watch(['modelRecords', 'loading', 'models', 'storey', 'visibility', 'display', 'selection', 'cad', 'presentation']);
    this.onBus(['model:loaded', 'model:unloaded', 'model:error']);
  }

  draw() {
    const viewer = this.ui.isViewer();
    this.uploadCard.hidden = viewer;
    this._drawModels();
    this._drawSummary();
    this._drawLocation();
  }

  // ------------------------------------------------------------------ modelos
  _drawModels() {
    const records = this.ui.records();
    const loading = this.store.get('loading') || {};
    const ids = new Set(records.map((r) => r.id));
    const pending = Object.entries(loading).filter(([id, l]) => !ids.has(id) && l && l.phase !== 'done');
    clear(this.modelsList);
    this.modelsCount.textContent = records.length ? String(records.length) : '';

    if (!records.length && !pending.length) {
      this.modelsList.append(
        emptyState({
          icon: 'cube',
          title: 'Aún no hay modelos',
          text: this.ui.isViewer() ? 'Cuando el presentador cargue un modelo aparecerá aquí.' : 'Carga un IFC y, si quieres, un plano DXF o DWG georreferenciado.',
        }),
      );
      return;
    }
    for (const [id, l] of pending) this.modelsList.append(this._pendingCard(id, l));
    for (const rec of records) this.modelsList.append(this._modelCard(rec, loading[rec.id]));
  }

  _pendingCard(id, l) {
    const kind = (l.kind || String(l.name || '').split('.').pop() || '').toLowerCase();
    const bar = progressBar(l.progress, { indeterminate: !l.progress });
    const phaseText = l.phase === 'error' ? `Error: ${l.error || 'no se pudo cargar'}` : l.phase === 'upload' ? 'Subiendo al servidor' : 'Preparando';
    return h(
      'article',
      { class: `model is-loading${l.phase === 'error' ? ' is-error' : ''}`, 'data-model': id },
      h('div', { class: 'model__row' }, h('span', { class: `model__kind model__kind--${kind}`, text: KIND_LABEL[kind] || 'FILE' }), h('div', { class: 'model__text' }, h('h4', { class: 'model__name', title: l.name, text: l.name || 'Archivo' }), h('p', { class: 'model__meta', text: `${phaseText}… ${Math.round((l.progress || 0) * 100)} %` }))),
      bar.el,
    );
  }

  _modelCard(rec, load) {
    const ui = this.ui;
    const state = this.store.get('models')[rec.id];
    const visible = state?.visible !== false;
    const isIfc = rec.kind === 'ifc';
    const loaded = isIfc ? ui.ifcLoaded(rec.id) : ui.cadLoaded(rec.id);
    const busy = load && load.phase !== 'done' && load.phase !== 'error';
    const failed = load?.phase === 'error';

    const badges = [];
    if (loaded && isIfc) {
      const g = safe(() => this.ctx.ifc?.getGeorefInfo?.(rec.id), null);
      badges.push(this._georefBadge(g));
      const s = safe(() => this.ctx.ifc?.getModelSummary?.(rec.id), null);
      if (s) badges.push(h('span', { class: 'badge badge--plain' }, `${formatInt(s.elementCount)} ${plural(s.elementCount, 'elemento', 'elementos')}`));
    } else if (loaded) {
      const m = (safe(() => this.ctx.cad?.getModels?.(), []) || []).find((x) => x.id === rec.id);
      if (m) {
        badges.push(m.georeferenced ? h('span', { class: 'badge badge--ok' }, icon('pin', { size: 12 }), 'Georreferenciado') : h('span', { class: 'badge badge--warn' }, icon('alert', { size: 12 }), 'Sin georreferenciar'));
        badges.push(h('span', { class: 'badge badge--plain', text: `Unidades: ${m.units || 'm'}` }));
        const elev = this.store.get('cad')?.[rec.id]?.elevation;
        badges.push(h('span', { class: 'badge badge--plain', text: elev == null ? `Cota auto ${formatNumber(m.elevation ?? 0, 2)} m` : `Cota ${formatNumber(elev, 2)} m` }));
      }
    }

    const actions = h('div', { class: 'model__actions' });
    actions.append(
      iconButton({
        icon: visible ? 'eye' : 'eye-off',
        title: visible ? 'Ocultar el modelo' : 'Mostrar el modelo',
        className: `btn--sm btn--ghost${visible ? '' : ' is-off'}`,
        size: 17,
        disabled: !loaded,
        onClick: () => this.actions.setModelVisible(rec.id, !visible),
      }),
      iconButton({
        icon: 'fit',
        title: 'Encuadrar el modelo',
        className: 'btn--sm btn--ghost',
        size: 17,
        disabled: !loaded,
        onClick: () => this._fit(rec),
      }),
    );
    if (!ui.isViewer()) {
      actions.append(
        iconButton({
          icon: isIfc ? 'pin' : 'sliders',
          title: isIfc ? 'Configurar la georreferencia' : 'Configurar unidades y cota del plano',
          className: 'btn--sm btn--ghost',
          size: 17,
          disabled: !loaded && !failed,
          onClick: () => (isIfc ? ui.dialogs.georef(rec) : ui.dialogs.cad(rec)),
        }),
        iconButton({ icon: 'trash', title: 'Eliminar el modelo', className: 'btn--sm btn--ghost btn--danger-hover', size: 17, onClick: () => ui.dialogs.confirmDelete(rec) }),
      );
    }

    let progress = null;
    if (busy) {
      const bar = progressBar(load.progress, { indeterminate: !load.progress });
      progress = h('div', { class: 'model__progress' }, bar.el, h('span', { class: 'model__phase', text: `${load.phase === 'parse' ? 'Procesando' : load.phase === 'upload' ? 'Subiendo' : 'Descargando'}… ${Math.round((load.progress || 0) * 100)} %` }));
    } else if (failed) {
      progress = h(
        'div',
        { class: 'model__error', role: 'alert' },
        icon('alert', { size: 14 }),
        h('span', { text: load.error || 'No se pudo cargar el modelo.' }),
        this.ctx.loader?.retryFailed ? h('button', { type: 'button', class: 'dock-link dock-link--dark', on: { click: () => this.ctx.loader.retryFailed() } }, 'Reintentar') : null,
      );
    } else if (!loaded) {
      progress = h('p', { class: 'model__phase', text: 'En cola…' });
    }

    return h(
      'article',
      { class: `model${visible ? '' : ' is-hidden'}${busy ? ' is-loading' : ''}${failed ? ' is-error' : ''}`, 'data-model': rec.id },
      h(
        'div',
        { class: 'model__row' },
        h('span', { class: `model__kind model__kind--${rec.kind}`, text: KIND_LABEL[rec.kind] || String(rec.kind).toUpperCase() }),
        h('div', { class: 'model__text' }, h('h4', { class: 'model__name', title: rec.name, text: rec.name }), h('p', { class: 'model__meta', text: formatBytes(rec.size) })),
        actions,
      ),
      badges.length ? h('div', { class: 'model__badges' }, ...badges) : null,
      progress,
    );
  }

  _georefBadge(g) {
    if (!g || g.source === 'none') return h('span', { class: 'badge badge--warn', title: 'El modelo no trae georreferencia; usa el botón de ubicación para indicarla.' }, icon('alert', { size: 12 }), 'Sin georreferencia');
    if (g.source === 'manual') return h('span', { class: 'badge badge--accent', title: 'Georreferencia indicada manualmente' }, icon('pin', { size: 12 }), 'Georreferencia manual');
    const label = g.source === 'site' ? 'Georreferenciado (sitio)' : g.crs ? `Georreferenciado · ${g.crs}` : 'Georreferenciado';
    return h('span', { class: 'badge badge--ok', title: g.source === 'site' ? 'Coordenadas tomadas de IfcSite' : 'IfcMapConversion' }, icon('pin', { size: 12 }), label);
  }

  _fit(rec) {
    const box = rec.kind === 'ifc' ? safe(() => this.ctx.ifc?.getModelBox?.(rec.id), null) : safe(() => this.ctx.cad?.getBox?.(rec.id), null);
    if (box && !box.isEmpty?.()) safe(() => this.ctx.viewer?.fitToBox?.(box));
    else this.ui.toast('info', 'El modelo aún no tiene geometría para encuadrar.');
  }

  // ------------------------------------------------------------------ resumen
  _drawSummary() {
    const ui = this.ui;
    const records = ui.records();
    const storeys = ui.storeys();
    const st = this.store.get('storey');
    const totalBytes = records.reduce((a, r) => a + (Number(r.size) || 0), 0);
    const { value, unit } = bytesParts(totalBytes);
    const parts = splitDecimals(value, unit === 'B' ? 0 : 2);

    const types = ui.typeSummary();
    const totalEls = types.reduce((a, t) => a + t.count, 0);
    // Ocultos de verdad: por tipo (incluye los espacios mientras "Mostrar espacios" esté apagado), a mano y por modelo oculto
    const hiddenN = ui.visibilitySummary(types).hidden;
    const selN = ui.selectionItems().length;

    const root = clear(this.summaryBody);

    root.append(h('div', { class: 'summary__head' }, h('span', { class: 'summary__label', text: 'Peso total de los modelos' })));
    root.append(h('div', { class: 'summary__num' }, bigNumber(parts.int, parts.dec, unit)));

    // Gráfico de barras finas: elementos por nivel
    const chart = h('div', { class: `chart${storeys.length > 28 ? ' chart--dense' : ''}`, role: 'img', 'aria-label': 'Elementos por nivel' });
    const max = Math.max(1, ...storeys.map((s) => s.elementCount || 0));
    const hasActive = !!st.active;
    let activeStorey = null;
    if (storeys.length) {
      storeys.forEach((s, i) => {
        const on = hasActive && ui.storeyMatches(s, st.active);
        if (on) activeStorey = s;
        const frac = s.elementCount ? Math.max(0.14, Math.sqrt(s.elementCount / max)) : 0.35;
        const bar = h('button', {
          type: 'button',
          class: `chart__bar${on ? ' is-on' : ''}${hasActive && !on ? ' is-dim' : ''}`,
          style: { '--h': `${Math.round(frac * 100)}%` },
          title: `${s.name || `Nivel ${i + 1}`}: ${formatInt(s.elementCount || 0)} elementos`,
          'aria-label': `${s.name || `Nivel ${i + 1}`}: ${formatInt(s.elementCount || 0)} elementos`,
          'aria-pressed': on ? 'true' : 'false',
          on: { click: () => this.actions.setStorey(on ? null : { modelId: s.modelId, expressId: s.expressId }) },
        });
        chart.append(bar);
      });
    } else {
      for (let i = 0; i < 30; i++) chart.append(h('span', { class: 'chart__bar chart__bar--ghost', style: { '--h': `${24 + ((i * 37) % 30)}%` } }));
    }
    root.append(
      h(
        'div',
        { class: 'chart-wrap' },
        h('div', { class: 'chart__legend' }, h('strong', { text: formatInt(totalEls) }), h('span', { text: plural(totalEls, 'ELEMENTO', 'ELEMENTOS') })),
        h('div', { class: 'chart__marker', 'aria-hidden': 'true' }),
        chart,
        h('div', { class: 'chart__caption' }, h('span', { class: 'chart__title', text: activeStorey ? activeStorey.name || 'Nivel activo' : storeys.length ? 'Todos los niveles' : 'Sin niveles' }), h('span', { class: 'chart__sub', text: storeys.length ? 'Elementos por nivel' : 'Carga un IFC' })),
      ),
    );

    // Fichas pequeñas
    const tile = (iconName, cls, label, n, onClick, title) =>
      h(
        'button',
        { type: 'button', class: `tile ${cls}`, title, 'aria-label': `${label}: ${n}. ${title}`, on: { click: onClick } },
        h('span', { class: 'tile__icon' }, icon(iconName, { size: 15 })),
        h('span', { class: 'tile__arrow' }, icon('arrow-right', { size: 14 })),
        h('span', { class: 'tile__label', text: label }),
        h('span', { class: 'tile__value', text: n < 100 ? pad2(n) : formatInt(n) }),
      );
    root.append(
      h(
        'div',
        { class: 'tiles' },
        tile('eye-off', 'tile--yellow', 'OCULTOS', hiddenN, () => this._showAll(), 'Mostrar todo'),
        tile('isolate', 'tile--orange', 'SELECCIONADOS', selN, () => this.actions.setTab('props'), 'Ver propiedades'),
      ),
    );
  }

  // "Mostrar todo": quita ocultaciones y aislamientos y también muestra los espacios (ocultos por defecto).
  _showAll() {
    this.actions.showAll();
    if (!this.store.get('display').showSpaces) this.actions.toggleSpaces(true);
  }

  // ------------------------------------------------------------------ ubicación
  _drawLocation() {
    const root = clear(this.locationBody);
    const ifcRec = this.ui.records().find((r) => r.kind === 'ifc' && this.ui.ifcLoaded(r.id));
    if (!ifcRec) {
      root.append(h('p', { class: 'muted', text: 'Cuando cargues un IFC verás aquí su cota base y su georreferencia.' }));
      return;
    }
    const g = safe(() => this.ctx.ifc?.getGeorefInfo?.(ifcRec.id), null);
    const base = safe(() => this.ctx.ifc?.getBaseElevation?.(), null);
    const parts = splitDecimals(Number.isFinite(base) ? base : g?.height, 2);
    root.append(
      h('div', { class: 'location__head' }, h('span', { class: 'summary__label', text: 'Cota base' }), h('span', { class: `badge ${g && g.source !== 'none' ? 'badge--ok' : 'badge--warn'}`, text: g && g.source !== 'none' ? g.crs || 'Georreferenciado' : 'Local' })),
      h('div', { class: 'summary__num' }, bigNumber(parts.int, parts.dec, 'm')),
    );
    const pos = georefPosition(g);
    if (pos) {
      const kv = h('dl', { class: 'kv kv--grid', 'data-georef-source': g.source, title: pos.fromAnchor ? 'Punto de referencia del modelo según las coordenadas de su IfcSite' : '' });
      const add = (k, v) => kv.append(h('dt', { class: 'kv__k', text: k }), h('dd', {}, h('span', { class: 'kv__v', text: v })));
      add('Este', formatCoord(pos.eastings, 2));
      add('Norte', formatCoord(pos.northings, 2));
      add('Rotación', `${formatNumber(g.rotationDeg ?? 0, 2)}°`);
      add('Escala', formatNumber(g.scale ?? 1, 4));
      root.append(kv);
    }
  }
}
