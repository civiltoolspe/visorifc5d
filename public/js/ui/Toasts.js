// Notificaciones flotantes: escucha el evento 'toast' del bus ({ type, message, timeout }).

import { h } from './dom.js';
import { icon } from './icons.js';
import { Component } from './Component.js';

const DEFAULT_TIMEOUT = { info: 4200, success: 3800, warning: 6500, error: 9000 };
const MAX_VISIBLE = 4;
const ICONS = { info: 'info', success: 'check', warning: 'alert', error: 'alert' };

export class Toasts extends Component {
  constructor(ui) {
    super(ui);
    this.layer = ui.layers.toast;
    this.items = new Map(); // elemento -> { timer, message }
    this.onBus('toast', (payload) => this.show(payload));
    this.addCleanup(() => {
      for (const item of this.items.values()) clearTimeout(item.timer);
      this.items.clear();
    });
  }

  show({ type = 'info', message = '', timeout } = {}) {
    const text = String(message || '').trim();
    if (!text) return null;
    const kind = ['info', 'success', 'warning', 'error'].includes(type) ? type : 'info';

    // Mismo mensaje ya visible: se reinicia su temporizador en lugar de apilar copias
    for (const [el, item] of this.items) {
      if (item.message === text && item.type === kind) {
        this._arm(el, item, timeout);
        el.classList.remove('is-pulse');
        void el.offsetWidth;
        el.classList.add('is-pulse');
        return el;
      }
    }

    const el = h(
      'div',
      { class: `toast toast--${kind}`, role: kind === 'error' ? 'alert' : 'status' },
      h('span', { class: 'toast__icon' }, icon(ICONS[kind], { size: 16 })),
      h('span', { class: 'toast__msg', text }),
      h('button', { type: 'button', class: 'toast__close', title: 'Cerrar aviso', 'aria-label': 'Cerrar aviso', on: { click: () => this.dismiss(el) } }, icon('x', { size: 14 })),
    );
    const item = { timer: null, message: text, type: kind, hover: false };
    this.items.set(el, item);
    el.addEventListener('pointerenter', () => {
      item.hover = true;
      clearTimeout(item.timer);
    });
    el.addEventListener('pointerleave', () => {
      item.hover = false;
      this._arm(el, item, 1800);
    });
    this.layer.append(el);
    void el.offsetWidth; // fuerza el reflujo para que la entrada se anime
    el.classList.add('is-in');
    this._arm(el, item, timeout);

    while (this.items.size > MAX_VISIBLE) this.dismiss(this.items.keys().next().value, true);
    return el;
  }

  _arm(el, item, timeout) {
    clearTimeout(item.timer);
    const ms = Number.isFinite(timeout) ? timeout : DEFAULT_TIMEOUT[item.type];
    if (ms <= 0) return;
    item.timer = setTimeout(() => this.dismiss(el), ms);
  }

  dismiss(el, immediate = false) {
    const item = this.items.get(el);
    if (!item) return;
    clearTimeout(item.timer);
    this.items.delete(el);
    if (immediate) {
      el.remove();
      return;
    }
    el.classList.remove('is-in');
    el.classList.add('is-out');
    setTimeout(() => el.remove(), 260);
  }

  render() {}

  dispose() {
    this.el = null;
    super.dispose();
    this.layer.replaceChildren();
  }
}
