// Base de las pestañas de la barra lateral. Solo la pestaña activa se dibuja; las demás
// marcan "sucio" y se actualizan al mostrarse.

import { h } from '../dom.js';
import { Component } from '../Component.js';

export class TabBase extends Component {
  constructor(ui, id, label) {
    super(ui);
    this.id = id;
    this.label = label;
    this.active = false;
    this._dirty = true;
    this.el = h('div', {
      class: `tab tab--${id}`,
      role: 'tabpanel',
      id: `tab-${id}`,
      'aria-label': label,
      'aria-labelledby': `pill-${id}`,
      hidden: true,
    });
  }

  setActive(on) {
    const was = this.active;
    this.active = !!on;
    this.el.hidden = !on;
    if (on) {
      if (this._dirty || !was) this.render();
      this.onShow();
    }
  }

  onShow() {}

  render() {
    if (!this.active) {
      this._dirty = true;
      return;
    }
    this._dirty = false;
    this.draw();
  }

  draw() {}
}
