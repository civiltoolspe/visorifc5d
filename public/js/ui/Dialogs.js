// Diálogos modales: confirmación de borrado, georreferencia manual de un IFC y
// unidades / cota de un plano CAD. Solo el presentador puede abrirlos (modifican datos del servidor).

import { h, safe } from './dom.js';
import { icon } from './icons.js';
import { Modal } from './overlay.js';
import { field, numberInput, segmented, textButton } from './widgets.js';
import { formatCoord, formatNumber, georefPosition } from './format.js';

const SOURCE_LABEL = {
  mapconversion: 'Automática (IfcMapConversion)',
  site: 'Automática (coordenadas de IfcSite)',
  manual: 'Manual',
  none: 'Sin georreferencia',
};

const CAD_UNITS = [
  { value: 'auto', label: 'Automática (según el archivo)' },
  { value: 'mm', label: 'Milímetros (mm)' },
  { value: 'cm', label: 'Centímetros (cm)' },
  { value: 'm', label: 'Metros (m)' },
  { value: 'in', label: 'Pulgadas (in)' },
  { value: 'ft', label: 'Pies (ft)' },
];

function errMessage(err) {
  return err?.message || String(err || 'Error desconocido');
}

export class Dialogs {
  constructor(ui) {
    this.ui = ui;
    this.ctx = ui.ctx;
    ui.dialogs = this;
  }

  // Aplica el registro actualizado localmente (sin esperar a la difusión del servidor).
  _applyRecords(records) {
    safe(() => this.ctx.loader?.reconcile?.(records));
  }

  _guardPresenter() {
    if (this.ui.isViewer()) {
      this.ui.toast('warning', 'Solo el presentador puede modificar los modelos.');
      return false;
    }
    return true;
  }

  // ------------------------------------------------------------------ confirmación
  confirm({ title, message, confirmLabel = 'Aceptar', cancelLabel = 'Cancelar', danger = false, details = null }) {
    const modal = new Modal(this.ui, { title, width: 420, className: 'modal--confirm' });
    modal.body.append(h('p', { class: 'modal__text', text: message }), details ? h('p', { class: 'modal__note', text: details }) : null);
    const cancel = textButton({ label: cancelLabel, className: 'btn--ghost', onClick: () => modal.close(false) });
    const ok = textButton({ label: confirmLabel, className: danger ? 'btn--danger' : 'btn--primary', onClick: () => modal.close(true) });
    ok.dataset.autofocus = '';
    modal.footer.append(cancel, ok);
    return modal.open();
  }

  async confirmDelete(rec) {
    if (!this._guardPresenter()) return false;
    const yes = await this.confirm({
      title: 'Eliminar modelo',
      message: `¿Eliminar “${rec.name}”?`,
      details: 'El archivo se borrará del servidor y desaparecerá para todos los espectadores. Esta acción no se puede deshacer.',
      confirmLabel: 'Eliminar',
      danger: true,
    });
    if (!yes) return false;
    try {
      await this.ctx.api.deleteModel(rec.id);
      this._applyRecords(this.ui.records().filter((r) => r.id !== rec.id));
      this.ui.toast('success', `“${rec.name}” se eliminó.`);
      return true;
    } catch (err) {
      this.ui.toast('error', `No se pudo eliminar “${rec.name}”: ${errMessage(err)}`);
      return false;
    }
  }

  // ------------------------------------------------------------------ georreferencia IFC
  async georef(rec) {
    if (!this._guardPresenter()) return false;
    const ifc = this.ctx.ifc;
    const info = safe(() => ifc?.getGeorefInfo?.(rec.id), null);
    const initial = rec.georef || (info && info.source !== 'none' ? info : null);
    const val = (v, d) => (Number.isFinite(Number(v)) && v !== null && v !== undefined ? Number(v) : d);
    const start = {
      eastings: val(initial?.eastings, 0),
      northings: val(initial?.northings, 0),
      height: val(initial?.height, 0),
      rotationDeg: val(initial?.rotationDeg, 0),
      scale: val(initial?.scale, 1),
    };

    const modal = new Modal(this.ui, { title: 'Georreferencia del modelo', subtitle: rec.name, width: 520, className: 'modal--georef' });

    // ---- Detectada
    const src = info?.source || 'none';
    const detected = h(
      'div',
      { class: `detected detected--${src}` },
      h('div', { class: 'detected__head' }, icon(src === 'none' ? 'alert' : 'pin', { size: 16 }), h('strong', { text: 'Georreferencia detectada' }), h('span', { class: 'badge', text: SOURCE_LABEL[src] || src })),
    );
    const pos = georefPosition(info);
    if (info && pos) {
      const kv = h('dl', { class: 'kv kv--grid kv--tight' });
      const add = (k, v) => kv.append(h('dt', { class: 'kv__k', text: k }), h('dd', {}, h('span', { class: 'kv__v', text: v })));
      if (info.crs) add('Sistema', info.crs);
      add('Este (E)', formatCoord(pos.eastings, 3));
      add('Norte (N)', formatCoord(pos.northings, 3));
      add('Altura (H)', formatCoord(pos.height, 3));
      add('Rotación', `${formatNumber(info.rotationDeg ?? 0, 4)}°`);
      add('Escala', formatNumber(info.scale ?? 1, 6));
      detected.append(kv);
      if (pos.fromAnchor) {
        detected.append(h('p', { class: 'modal__note', 'data-note': 'site', text: 'El archivo no trae IfcMapConversion: sus coordenadas ya están en el mapa (IfcSite). Arriba se indica el punto de referencia del modelo. En la georreferencia manual, E, N y H se suman como un desplazamiento sobre esas coordenadas (0, 0, 0 = sin mover).' }));
      }
    } else {
      detected.append(h('p', { class: 'modal__note', text: 'El archivo no incluye IfcMapConversion ni coordenadas de sitio. Indica a continuación dónde está en el mapa.' }));
    }

    // ---- Formulario
    // Con coordenadas de IfcSite (sin IfcMapConversion) la conversión equivalente es 0, 0, 0: lo que se escribe aquí
    // se suma a las coordenadas del archivo (desplazamiento), no sustituye la posición mostrada arriba.
    const siteShift = src === 'site' && !rec.georef;
    const fE = numberInput({ value: start.eastings, step: '0.001', label: 'Este (E)', unit: 'm' });
    const fN = numberInput({ value: start.northings, step: '0.001', label: 'Norte (N)', unit: 'm' });
    const fH = numberInput({ value: start.height, step: '0.001', label: 'Altura (H)', unit: 'm' });
    const fR = numberInput({ value: start.rotationDeg, step: '0.0001', label: 'Rotación', unit: '°' });
    const fS = numberInput({ value: start.scale, step: '0.000001', min: '0', label: 'Escala' });
    const errorEl = h('p', { class: 'form-error', role: 'alert', hidden: true });

    const form = h(
      'form',
      { class: 'form-grid', novalidate: true },
      field({ label: 'Este (E)', input: fE.el, hint: siteShift ? 'Desplazamiento en metros (0 = sin mover)' : 'Coordenada de mapa en metros' }),
      field({ label: 'Norte (N)', input: fN.el, hint: siteShift ? 'Desplazamiento en metros (0 = sin mover)' : 'Coordenada de mapa en metros' }),
      field({ label: 'Altura (H)', input: fH.el, hint: siteShift ? 'Desplazamiento en metros (0 = sin mover)' : 'Cota ortométrica del origen' }),
      field({ label: 'Rotación', input: fR.el, hint: 'Eje X local respecto al Este, antihorario' }),
      field({ label: 'Escala', input: fS.el, hint: 'Factor del modelo (1 = metros)' }),
    );
    modal.body.append(detected, h('h3', { class: 'modal__section', text: 'Georreferencia manual' }), form, errorEl);

    const showError = (msg) => {
      errorEl.textContent = msg;
      errorEl.hidden = !msg;
    };

    const save = async () => {
      const g = {
        eastings: Number(fE.input.value),
        northings: Number(fN.input.value),
        height: Number(fH.input.value),
        rotationDeg: Number(fR.input.value),
        scale: Number(fS.input.value),
      };
      if (![fE, fN, fH, fR, fS].every((f) => f.input.value.trim() !== '') || !Object.values(g).every(Number.isFinite)) {
        showError('Completa todos los campos con números válidos.');
        return;
      }
      if (!(g.scale > 0)) {
        showError('La escala debe ser mayor que cero.');
        return;
      }
      showError('');
      saveBtn.disabled = true;
      try {
        const updated = await this.ctx.api.patchModel(rec.id, { georef: g });
        this._applyRecords(this.ui.records().map((r) => (r.id === rec.id ? { ...r, ...(updated || {}), georef: updated?.georef ?? g } : r)));
        this.ui.toast('success', 'Georreferencia actualizada.');
        modal.close(true);
      } catch (err) {
        saveBtn.disabled = false;
        showError(`No se pudo guardar: ${errMessage(err)}`);
      }
    };

    const reset = async () => {
      resetBtn.disabled = true;
      try {
        const updated = await this.ctx.api.patchModel(rec.id, { georef: null });
        this._applyRecords(this.ui.records().map((r) => (r.id === rec.id ? { ...r, ...(updated || {}), georef: null } : r)));
        this.ui.toast('success', 'Se restableció la georreferencia automática.');
        modal.close(true);
      } catch (err) {
        resetBtn.disabled = false;
        showError(`No se pudo restablecer: ${errMessage(err)}`);
      }
    };

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      save();
    });
    const hasManual = !!rec.georef || src === 'manual';
    const resetBtn = textButton({ label: 'Restablecer', icon: 'refresh', title: 'Volver a la georreferencia automática del archivo', className: 'btn--ghost modal__reset', onClick: reset, disabled: !hasManual });
    const cancelBtn = textButton({ label: 'Cancelar', className: 'btn--ghost', onClick: () => modal.close(false) });
    const saveBtn = textButton({ label: 'Guardar', icon: 'check', className: 'btn--primary', onClick: save });
    modal.footer.append(resetBtn, h('span', { class: 'spacer' }), cancelBtn, saveBtn);
    return modal.open();
  }

  // ------------------------------------------------------------------ unidades y cota CAD
  async cad(rec) {
    if (!this._guardPresenter()) return false;
    const cadModel = (safe(() => this.ctx.cad?.getModels?.(), []) || []).find((m) => m.id === rec.id) || null;
    const cadState = this.ui.store.get('cad')?.[rec.id] || { elevation: null };
    const modal = new Modal(this.ui, { title: 'Plano CAD: unidades y cota', subtitle: rec.name, width: 500, className: 'modal--cad' });

    const select = h('select', { class: 'input select', 'aria-label': 'Unidades del dibujo' }, ...CAD_UNITS.map((u) => h('option', { value: u.value, text: u.label })));
    select.value = rec.cad?.units || 'auto';
    const unitsHint = cadModel
      ? `Unidades aplicadas: ${cadModel.units}${cadModel.unitsSource === 'header' ? ' (del encabezado del archivo)' : cadModel.unitsSource === 'override' ? ' (indicadas manualmente)' : ' (por defecto)'}.`
      : 'El plano aún se está procesando.';

    const manual = cadState.elevation !== null && cadState.elevation !== undefined;
    const effective = Number.isFinite(cadModel?.elevation) ? cadModel.elevation : 0;
    const mode = segmented(
      [
        { value: 'auto', label: 'Automática', title: 'Sobre el nivel más bajo del IFC' },
        { value: 'manual', label: 'Manual', title: 'Cota fija en metros' },
      ],
      { value: manual ? 'manual' : 'auto', ariaLabel: 'Cota del plano', onChange: (v) => syncMode(v) },
    );
    const elev = numberInput({ value: manual ? cadState.elevation : Math.round(effective * 100) / 100, step: '0.01', label: 'Cota manual', unit: 'm' });
    const elevHint = h('p', { class: 'field__hint' });
    const syncMode = (v) => {
      const isManual = v === 'manual';
      mode.set(v);
      elev.input.disabled = !isManual;
      elevHint.textContent = isManual ? 'Cota fija (H) en metros, en coordenadas de mapa.' : `Automática: nivel más bajo del IFC + 0,02 m (actual ${formatNumber(effective, 2)} m).`;
    };
    syncMode(manual ? 'manual' : 'auto');

    const errorEl = h('p', { class: 'form-error', role: 'alert', hidden: true });
    modal.body.append(
      h('div', { class: 'detected' }, h('div', { class: 'detected__head' }, icon('info', { size: 16 }), h('strong', { text: 'Georreferencia del plano' }), cadModel ? h('span', { class: `badge ${cadModel.georeferenced ? 'badge--ok' : 'badge--warn'}`, text: cadModel.georeferenced ? 'Georreferenciado' : 'Sin georreferenciar' }) : null), h('p', { class: 'modal__note', text: 'Las coordenadas del dibujo se interpretan como coordenadas de mapa (E, N) tras aplicar las unidades.' })),
      h('h3', { class: 'modal__section', text: 'Unidades' }),
      field({ label: 'Unidades del dibujo', input: select, hint: unitsHint }),
      h('h3', { class: 'modal__section', text: 'Cota (H)' }),
      h('div', { class: 'field' }, h('span', { class: 'field__label', text: 'Cota del plano' }), mode.el),
      field({ label: 'Cota manual', input: elev.el }),
      elevHint,
      errorEl,
    );
    const showError = (msg) => {
      errorEl.textContent = msg;
      errorEl.hidden = !msg;
    };

    const save = async () => {
      const wantManual = mode.el.querySelector('.is-on')?.dataset.value === 'manual';
      let elevation = null;
      if (wantManual) {
        elevation = Number(elev.input.value);
        if (elev.input.value.trim() === '' || !Number.isFinite(elevation)) {
          showError('Escribe una cota válida en metros.');
          return;
        }
      }
      showError('');
      saveBtn.disabled = true;
      try {
        const units = select.value;
        if ((rec.cad?.units || 'auto') !== units) {
          const updated = await this.ctx.api.patchModel(rec.id, { cad: { units } });
          this._applyRecords(this.ui.records().map((r) => (r.id === rec.id ? { ...r, ...(updated || {}), cad: updated?.cad ?? { units } } : r)));
        }
        this.ui.actions.setCadElevation(rec.id, elevation);
        this.ui.toast('success', 'Plano actualizado.');
        modal.close(true);
      } catch (err) {
        saveBtn.disabled = false;
        showError(`No se pudo guardar: ${errMessage(err)}`);
      }
    };
    const cancelBtn = textButton({ label: 'Cancelar', className: 'btn--ghost', onClick: () => modal.close(false) });
    const saveBtn = textButton({ label: 'Guardar', icon: 'check', className: 'btn--primary', onClick: save });
    modal.footer.append(h('span', { class: 'spacer' }), cancelBtn, saveBtn);
    return modal.open();
  }
}
