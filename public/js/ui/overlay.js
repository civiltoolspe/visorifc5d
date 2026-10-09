// Popover anclado a un botón y Modal centrado. Ambos se registran en el UiContext para que
// los atajos (Esc) sepan si hay algo abierto encima.

import { h, clamp } from './dom.js';
import { icon } from './icons.js';

const MARGIN = 12;

export class Popover {
  // align: 'start' | 'end' | 'center' respecto al ancla; placement: 'bottom' | 'top'
  constructor(ui, { className = '', align = 'end', placement = 'bottom', offset = 10, label = '', onOpen = null, onClose = null } = {}) {
    this.ui = ui;
    this.align = align;
    this.placement = placement;
    this.offset = offset;
    this.onOpen = onOpen;
    this.onClose = onClose;
    this.anchor = null;
    this.el = h('div', { class: `popover ${className}`.trim(), role: 'dialog', 'aria-label': label, hidden: true });
    ui.layers.popover.append(this.el);
    ui.popovers.add(this);

    this._onDown = (e) => {
      if (!this.isOpen) return;
      const t = e.target;
      if (this.el.contains(t) || this.anchor?.contains(t)) return;
      this.close();
    };
    this._onResize = () => this.isOpen && this.position();
  }

  get isOpen() {
    return !this.el.hidden;
  }

  setContent(...nodes) {
    this.el.replaceChildren(...nodes.flat().filter(Boolean));
    if (this.isOpen) this.position();
  }

  open(anchor) {
    this.ui.closePopovers(this);
    this.anchor = anchor || this.anchor;
    this.el.hidden = false;
    this.el.classList.remove('is-in');
    this.position();
    // Reinicia la animación de entrada
    void this.el.offsetWidth;
    this.el.classList.add('is-in');
    this.anchor?.setAttribute?.('aria-expanded', 'true');
    document.addEventListener('pointerdown', this._onDown, true);
    window.addEventListener('resize', this._onResize);
    this.onOpen?.(this);
  }

  close() {
    if (!this.isOpen) return;
    this.el.hidden = true;
    this.el.classList.remove('is-in');
    this.anchor?.setAttribute?.('aria-expanded', 'false');
    document.removeEventListener('pointerdown', this._onDown, true);
    window.removeEventListener('resize', this._onResize);
    this.onClose?.(this);
  }

  toggle(anchor) {
    if (this.isOpen && (!anchor || anchor === this.anchor)) this.close();
    else this.open(anchor);
  }

  position() {
    if (!this.anchor?.isConnected) return;
    const a = this.anchor.getBoundingClientRect();
    const el = this.el;
    el.style.left = '0px';
    el.style.top = '0px';
    const w = el.offsetWidth;
    const hgt = el.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = this.align === 'end' ? a.right - w : this.align === 'center' ? a.left + a.width / 2 - w / 2 : a.left;
    let top = this.placement === 'top' ? a.top - hgt - this.offset : a.bottom + this.offset;
    if (this.placement === 'bottom' && top + hgt > vh - MARGIN && a.top - hgt - this.offset > MARGIN) top = a.top - hgt - this.offset;
    if (this.placement === 'top' && top < MARGIN && a.bottom + this.offset + hgt < vh - MARGIN) top = a.bottom + this.offset;
    left = clamp(left, MARGIN, Math.max(MARGIN, vw - w - MARGIN));
    top = clamp(top, MARGIN, Math.max(MARGIN, vh - hgt - MARGIN));
    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(top)}px`;
    el.style.maxHeight = `${Math.max(160, vh - 2 * MARGIN)}px`;
  }

  dispose() {
    this.close();
    this.ui.popovers.delete(this);
    this.el.remove();
  }
}

export class Modal {
  constructor(ui, { title = '', subtitle = '', width = 460, dismissable = true, className = '' } = {}) {
    this.ui = ui;
    this.dismissable = dismissable;
    this.result = undefined;
    this._resolve = null;
    this._opener = null;

    this.titleEl = h('h2', { class: 'modal__title', text: title });
    this.subtitleEl = h('p', { class: 'modal__subtitle', text: subtitle, hidden: !subtitle });
    this.closeBtn = h(
      'button',
      { class: 'btn btn--icon btn--ghost modal__close', type: 'button', title: 'Cerrar', 'aria-label': 'Cerrar', on: { click: () => this.close(false) } },
      icon('x', { size: 18 }),
    );
    this.body = h('div', { class: 'modal__body' });
    this.footer = h('div', { class: 'modal__footer' });
    this.card = h(
      'div',
      { class: `modal ${className}`.trim(), role: 'dialog', 'aria-modal': 'true', 'aria-label': title, style: { width: `min(${width}px, calc(100vw - 32px))` } },
      h('header', { class: 'modal__header' }, h('div', { class: 'modal__heading' }, this.titleEl, this.subtitleEl), dismissable ? this.closeBtn : null),
      this.body,
      this.footer,
    );
    this.backdrop = h('div', { class: 'modal-backdrop', on: { pointerdown: (e) => e.target === this.backdrop && this.dismissable && this.close(false) } }, this.card);

    this._onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        e.preventDefault();
        if (this.dismissable) this.close(false);
      } else if (e.key === 'Tab') this._trapTab(e);
    };
  }

  setTitle(title, subtitle = '') {
    this.titleEl.textContent = title;
    this.subtitleEl.textContent = subtitle;
    this.subtitleEl.hidden = !subtitle;
    this.card.setAttribute('aria-label', title);
  }

  open() {
    this.ui.closePopovers();
    this._opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.ui.layers.modal.append(this.backdrop);
    this.ui.modals.add(this);
    document.addEventListener('keydown', this._onKey, true);
    void this.backdrop.offsetWidth; // fuerza el reflujo para que la entrada se anime
    this.backdrop.classList.add('is-in');
    const first = this.card.querySelector('[data-autofocus], input:not([disabled]), select, textarea') || this.card.querySelector('.btn--primary, .btn--danger');
    first?.focus?.();
    return new Promise((resolve) => {
      this._resolve = resolve;
    });
  }

  close(result = false) {
    if (!this.ui.modals.has(this)) return;
    this.ui.modals.delete(this);
    document.removeEventListener('keydown', this._onKey, true);
    this.backdrop.remove();
    this._opener?.focus?.();
    const resolve = this._resolve;
    this._resolve = null;
    resolve?.(result);
  }

  _trapTab(e) {
    const focusables = [...this.card.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')].filter((el) => el.offsetParent !== null);
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }
}
