// Pestaña Vistas: guardar la vista actual (miniatura + nombre), restaurar y borrar.
// Las vistas viven en store.views (sincronizado).

import { h, clear, safe } from '../dom.js';
import { icon } from '../icons.js';
import { TabBase } from './TabBase.js';
import { emptyState, iconButton, textButton } from '../widgets.js';

export class ViewsTab extends TabBase {
  constructor(ui) {
    super(ui, 'views', 'Vistas');

    this.nameInput = h('input', { type: 'text', class: 'input', maxlength: '60', placeholder: 'Nombre de la vista', 'aria-label': 'Nombre de la vista a guardar', autocomplete: 'off' });
    this.nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this._save();
    });
    this.saveBtn = textButton({ label: 'Guardar vista', icon: 'bookmark', className: 'btn--primary', onClick: () => this._save() });
    this.form = h('section', { class: 'panel-card views-form' }, h('h3', { class: 'panel-card__title', text: 'Guardar la vista actual' }), h('p', { class: 'muted', text: 'Guarda la cámara, la visibilidad, los cortes y la selección.' }), h('div', { class: 'row-gap' }, this.nameInput, this.saveBtn));
    this.listEl = h('div', { class: 'views' });
    this.el.append(this.form, this.listEl);

    this.watch('views');
  }

  _save() {
    const viewer = this.ctx.viewer;
    const items = this.store.get('views').items;
    const name = this.nameInput.value.trim() || `Vista ${items.length + 1}`;
    const camera = safe(() => viewer?.getCameraState?.(), null);
    if (!camera) {
      this.ui.toast('warning', 'No se pudo leer la cámara del visor.');
      return;
    }
    const thumb = safe(() => viewer?.screenshot?.({ width: 320, height: 180 }), null);
    this.actions.saveView(name, camera, thumb);
    this.nameInput.value = '';
    this.ui.toast('success', `Vista “${name}” guardada.`);
  }

  _restore(view) {
    this.actions.applyViewState(view);
    safe(() => this.ctx.viewer?.setCameraState?.(view.camera));
  }

  draw() {
    const items = this.store.get('views').items;
    const list = clear(this.listEl);
    if (!items.length) {
      list.append(emptyState({ icon: 'bookmark', title: 'Aún no hay vistas guardadas', text: 'Encuadra el modelo como quieras y pulsa “Guardar vista”.' }));
      return;
    }
    // La más reciente primero
    for (const view of [...items].reverse()) {
      const thumb = view.thumb ? h('img', { class: 'view__thumb', src: view.thumb, alt: '', draggable: 'false' }) : h('span', { class: 'view__thumb view__thumb--empty' }, icon('camera', { size: 22 }));
      const open = h(
        'button',
        { type: 'button', class: 'view__open', title: `Restaurar la vista “${view.name}”`, 'aria-label': `Restaurar la vista ${view.name}` },
        thumb,
        h('span', { class: 'view__text' }, h('span', { class: 'view__name', text: view.name }), h('span', { class: 'view__meta', text: view.camera?.projection === 'orthographic' ? 'Ortogonal' : 'Perspectiva' })),
      );
      open.addEventListener('click', () => this._restore(view));
      list.append(
        h(
          'article',
          { class: 'view', 'data-view': view.id },
          open,
          h(
            'div',
            { class: 'view__actions' },
            iconButton({ icon: 'refresh', title: 'Restaurar esta vista', className: 'btn--sm btn--ghost', size: 16, onClick: () => this._restore(view) }),
            iconButton({ icon: 'trash', title: 'Borrar esta vista', className: 'btn--sm btn--ghost btn--danger-hover', size: 16, onClick: () => this.actions.removeView(view.id) }),
          ),
        ),
      );
    }
  }
}
