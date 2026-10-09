// Atajos de teclado: Esc, H, I, Mayús+H, F, M, P (y "/" para buscar).
// Se desactivan si hay capa de bloqueo, si el foco está en un campo de texto o si hay un modal o el "Acerca de" abierto.

import { Component } from './Component.js';
import { isEditable, safe } from './dom.js';

export class Shortcuts extends Component {
  constructor(ui, { onSearch = null } = {}) {
    super(ui);
    this.onSearch = onSearch;
    // Fase de captura: Esc debe decidir antes que MeasureTool y los controles del visor
    this.listen(window, 'keydown', (e) => this._onKeyDown(e), true);
  }

  _onKeyDown(e) {
    if (e.defaultPrevented || e.isComposing) return;
    if (this.ui.isLocked()) return;
    if (this.ui.about?.isOpen) return; // "Acerca de": Esc y las demás teclas no deben tocar el visor
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    const inField = isEditable(e.target);

    if (e.key === 'Escape') {
      if (this.ui.hasOverlay()) {
        // Los modales gestionan su propio Esc; los popovers se cierran aquí
        if (!this.ui.modals.size) {
          this.ui.closeTopOverlay();
          e.preventDefault();
        }
        return;
      }
      if (inField) return; // el campo gestiona su Esc (limpiar, salir)
      const measure = this.store.get('measure');
      if (measure.active) {
        // Si hay un punto en curso, MeasureTool lo cancela; si no, se sale del modo medición
        if (!safe(() => this.ctx.measure?._pending, null)) this.actions.setMeasureActive(false);
        return;
      }
      this.actions.clearSelection();
      return;
    }

    if (inField || this.ui.modals.size) return;
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;

    switch (key) {
      case 'h':
        e.preventDefault();
        if (e.shiftKey) this.actions.showAll();
        else this.actions.hideSelected();
        break;
      case 'i':
        if (e.shiftKey) return;
        e.preventDefault();
        this.actions.isolateSelected();
        break;
      case 'f':
        if (e.shiftKey) return;
        e.preventDefault();
        this.ui.fitSelectionOrAll();
        break;
      case 'm':
        if (e.shiftKey) return;
        e.preventDefault();
        this.actions.setMeasureActive(!this.store.get('measure').active);
        break;
      case 'p':
        if (e.shiftKey || !this.ui.isPresenter()) return;
        e.preventDefault();
        this.ctx.presentation?.toggle?.();
        break;
      case '/':
        if (!this.onSearch) return;
        e.preventDefault();
        this.onSearch();
        break;
      default:
    }
  }
}
