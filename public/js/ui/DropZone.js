// Arrastrar y soltar archivos sobre toda la ventana (solo presentador) con overlay visual.
// Los espectadores nunca pueden subir; aun así se evita que el navegador abra el archivo soltado.

import { h } from './dom.js';
import { icon } from './icons.js';
import { Component } from './Component.js';

const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');

export class DropZone extends Component {
  constructor(ui) {
    super(ui);
    this.depth = 0;
    this.hideTimer = null;
    this.el = h(
      'div',
      { class: 'drop-overlay', hidden: true, 'aria-hidden': 'true' },
      h(
        'div',
        { class: 'drop-overlay__card' },
        h('span', { class: 'drop-overlay__icon' }, icon('upload', { size: 30 })),
        h('strong', { class: 'drop-overlay__title', text: 'Suelta aquí tus archivos' }),
        h('span', { class: 'drop-overlay__sub', text: 'Modelos IFC y planos DXF o DWG georreferenciados' }),
      ),
    );
    ui.root.append(this.el);

    const canUpload = () => this.ui.isPresenter() && !this.ui.isLocked();
    const show = () => {
      this.el.hidden = !canUpload();
      clearTimeout(this.hideTimer);
      // Si dejan de llegar eventos dragover (se soltó fuera o se canceló), se oculta
      this.hideTimer = setTimeout(() => this._hide(), 400);
    };

    this.listen(window, 'dragenter', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      this.depth++;
      show();
    }, true);
    this.listen(window, 'dragover', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = canUpload() ? 'copy' : 'none';
      show();
    }, true);
    this.listen(window, 'dragleave', (e) => {
      if (!hasFiles(e)) return;
      this.depth = Math.max(0, this.depth - 1);
      if (this.depth === 0) this._hide();
    }, true);
    this.listen(window, 'drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      this._hide();
      const files = [...(e.dataTransfer?.files || [])];
      if (!files.length) return;
      if (!canUpload()) {
        this.ui.toast('warning', 'Solo el presentador puede cargar modelos.');
        return;
      }
      this.ctx.loader?.uploadFiles?.(files);
    }, true);
    this.addCleanup(() => clearTimeout(this.hideTimer));
  }

  _hide() {
    this.depth = 0;
    clearTimeout(this.hideTimer);
    this.el.hidden = true;
  }
}
