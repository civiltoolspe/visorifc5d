// Capa de bloqueo para el modo presentación.
//
// Se muestra cuando esta PC solo puede mirar:
//   - espectador con presentación activa, o sin navegación libre ("Esperando al presentador");
//   - presentador que no es el activo mientras otro presenta.
// Es transparente, cubre toda la ventana, captura los eventos de puntero, rueda y teclado y
// muestra el cursor "not-allowed". Solo los elementos marcados con data-allow-locked (botón de
// pantalla completa, insignia EN VIVO...) quedan por encima.

import { h } from './dom.js';
import { Component } from './Component.js';

const POINTER_EVENTS = [
  'pointerdown', 'pointerup', 'pointermove', 'pointercancel',
  'mousedown', 'mouseup', 'click', 'dblclick', 'auxclick', 'contextmenu',
  'touchstart', 'touchmove', 'touchend',
  'dragstart', 'dragenter', 'dragover', 'drop', 'selectstart',
];

export class LockLayer extends Component {
  constructor(ui, lockables) {
    super(ui);
    this.lockables = lockables; // elementos que se vuelven inertes mientras hay bloqueo
    this.locked = false;
    this.labelEl = h('div', { class: 'lock-layer__label', role: 'status' });
    this.el = h('div', { class: 'lock-layer', hidden: true, tabindex: '-1', role: 'presentation', 'data-lock-layer': '' }, this.labelEl);
    ui.root.append(this.el);

    const stop = (e) => {
      e.stopPropagation();
      if (e.cancelable) e.preventDefault();
    };
    for (const type of POINTER_EVENTS) this.el.addEventListener(type, stop);
    this.el.addEventListener('wheel', stop, { passive: false });

    // Teclado: con bloqueo no llega a ningún atajo ni al visor (salvo a los controles permitidos)
    this._onKey = (e) => {
      if (!this.locked) return;
      const t = e.target;
      if (t instanceof Element && t.closest('[data-allow-locked]')) return;
      e.stopImmediatePropagation();
      const functionKey = /^F\d{1,2}$/.test(e.key);
      if (!functionKey && !e.ctrlKey && !e.metaKey && e.cancelable) e.preventDefault();
    };
    for (const type of ['keydown', 'keyup', 'keypress']) this.listen(window, type, this._onKey, true);
    // La rueda con Ctrl (zoom del navegador) tampoco debe saltarse el bloqueo
    this.listen(window, 'wheel', (e) => {
      if (this.locked && !(e.target instanceof Element && e.target.closest('[data-allow-locked]'))) {
        e.stopImmediatePropagation();
        if (e.cancelable) e.preventDefault();
      }
    }, { capture: true, passive: false });

    this.watch('presentation');
    this.render();
  }

  render() {
    const p = this.store.get('presentation');
    const locked = this.ui.isLocked();
    const changed = locked !== this.locked;
    this.locked = locked;
    this.el.hidden = !locked;
    this.ui.root.dataset.locked = locked ? 'true' : 'false';

    let text = '';
    if (locked) {
      if (p.role === 'viewer' && !p.active) text = 'Esperando al presentador';
      else text = 'Modo presentación: solo visualización';
    }
    if (this.labelEl.textContent !== text) this.labelEl.textContent = text;

    for (const el of this.lockables) {
      if (!el) continue;
      if (locked) el.setAttribute('inert', '');
      else el.removeAttribute('inert');
    }

    if (changed) {
      if (locked) {
        // Quita el foco de cualquier campo y lo deja en la capa
        const active = document.activeElement;
        if (active instanceof HTMLElement && active !== document.body && !active.closest('[data-allow-locked]')) active.blur();
        this.ui.closePopovers();
        for (const m of [...this.ui.modals]) m.close(false);
      }
      try {
        this.ctx.viewer?.enableInput?.(!locked);
      } catch (err) {
        console.warn('[ui] enableInput', err);
      }
    }
  }
}
