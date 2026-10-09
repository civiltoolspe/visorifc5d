// Controles de zoom (+ / −) a la derecha y cruceta de órbita abajo a la izquierda.
// Se mantienen pulsados para repetir el movimiento.

import { h, safe } from './dom.js';
import { icon } from './icons.js';
import { Component } from './Component.js';

const REPEAT_DELAY = 320;
const REPEAT_EVERY = 110;

// Botón que ejecuta fn al pulsar y se repite mientras se mantiene presionado.
function repeatButton({ iconName, title, size = 18, className = '', fn }) {
  const btn = h('button', { type: 'button', class: `btn btn--icon ${className}`.trim(), title, 'aria-label': title }, icon(iconName, { size }));
  let delay = null;
  let timer = null;
  const stop = () => {
    clearTimeout(delay);
    clearInterval(timer);
    delay = timer = null;
  };
  btn.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    btn.focus({ preventScroll: true });
    fn();
    stop();
    delay = setTimeout(() => {
      timer = setInterval(fn, REPEAT_EVERY);
    }, REPEAT_DELAY);
  });
  for (const type of ['pointerup', 'pointerleave', 'pointercancel', 'blur']) btn.addEventListener(type, stop);
  // Activación con teclado (Enter/Espacio) sin pasar por pointerdown
  btn.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      fn();
    }
  });
  btn._stop = stop;
  return btn;
}

export class ZoomControls extends Component {
  constructor(ui) {
    super(ui);
    const v = () => this.ctx.viewer;
    this.zoomIn = repeatButton({ iconName: 'plus', title: 'Acercar', className: 'zoom__btn', fn: () => safe(() => v()?.zoomStep?.(1)) });
    this.zoomOut = repeatButton({ iconName: 'minus', title: 'Alejar', className: 'zoom__btn', fn: () => safe(() => v()?.zoomStep?.(-1)) });
    this.el = h('div', { class: 'zoom card-glass', role: 'group', 'aria-label': 'Zoom' }, this.zoomIn, h('span', { class: 'zoom__sep' }), this.zoomOut);
    this.addCleanup(() => {
      this.zoomIn._stop();
      this.zoomOut._stop();
    });
  }
}

// Silueta en cruz de la cruceta (brazos con extremos redondos y esquinas interiores suaves)
const ORBIT_PATH =
  'M38 18A18 18 0 0 1 74 18L74 28A10 10 0 0 0 84 38L94 38A18 18 0 0 1 94 74L84 74A10 10 0 0 0 74 84L74 94' +
  'A18 18 0 0 1 38 94L38 84A10 10 0 0 0 28 74L18 74A18 18 0 0 1 18 38L28 38A10 10 0 0 0 38 28Z';

function orbitBackground() {
  const t = document.createElement('template');
  t.innerHTML = `<svg class="orbit__bg" viewBox="0 0 112 112" aria-hidden="true" focusable="false"><path d="${ORBIT_PATH}"/></svg>`;
  return t.content.firstElementChild;
}

export class OrbitPad extends Component {
  constructor(ui) {
    super(ui);
    const v = () => this.ctx.viewer;
    const step = (dx, dy) => () => safe(() => v()?.orbitStep?.(dx, dy));
    const up = repeatButton({ iconName: 'chevron-up', title: 'Orbitar hacia arriba', size: 17, className: 'orbit__btn orbit__up', fn: step(0, 10) });
    const down = repeatButton({ iconName: 'chevron-down', title: 'Orbitar hacia abajo', size: 17, className: 'orbit__btn orbit__down', fn: step(0, -10) });
    const left = repeatButton({ iconName: 'chevron-left', title: 'Orbitar a la izquierda', size: 17, className: 'orbit__btn orbit__left', fn: step(-10, 0) });
    const right = repeatButton({ iconName: 'chevron-right', title: 'Orbitar a la derecha', size: 17, className: 'orbit__btn orbit__right', fn: step(10, 0) });
    const home = h('button', { type: 'button', class: 'orbit__center', title: 'Vista isométrica', 'aria-label': 'Vista isométrica', on: { click: () => safe(() => v()?.setView?.('iso')) } }, h('span', { class: 'orbit__dot' }));
    this.el = h('div', { class: 'orbit', role: 'group', 'aria-label': 'Órbita de cámara' }, orbitBackground(), up, left, home, right, down);
    this.addCleanup(() => [up, down, left, right].forEach((b) => b._stop()));
  }
}
