// Grupo superior de estado: botón Presentar / insignia EN VIVO, conexión, carga, pantalla completa y Acerca de.
// Estos controles quedan por encima de la capa de bloqueo (data-allow-locked).

import { h, clear, setClass } from './dom.js';
import { icon } from './icons.js';
import { Component } from './Component.js';
import { enterWithPin, viewersLabel } from './Panels.js';

function fullscreenElement() {
  return document.fullscreenElement || document.webkitFullscreenElement || null;
}

async function toggleFullscreen() {
  try {
    if (fullscreenElement()) await (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    else await (document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen).call(document.documentElement);
  } catch (err) {
    console.warn('[ui] pantalla completa', err);
  }
}

export class StatusCluster extends Component {
  constructor(ui, presentationPanel) {
    super(ui);
    this.panel = presentationPanel;
    this.el = h('div', { class: 'status-cluster', role: 'group', 'aria-label': 'Estado' });
    this.slot = h('div', { class: 'status-cluster__slot' });
    this.loadChip = h('span', { class: 'chip chip--load', role: 'status', hidden: true });
    this.connChip = h('span', { class: 'chip chip--warn', role: 'status', hidden: true, 'data-allow-locked': '' });
    this.fullBtn = h('button', {
      type: 'button',
      class: 'btn btn--icon btn--glass',
      title: 'Pantalla completa',
      'aria-label': 'Pantalla completa',
      'data-allow-locked': '',
      on: { click: toggleFullscreen },
    });
    // "Acerca de": inofensivo (no toca el store ni la cámara), así que sigue activo con la capa de bloqueo, como pantalla completa.
    // Va después del botón de pantalla completa en el DOM (el primer .btn--glass del grupo es el de pantalla completa).
    this.aboutBtn = h(
      'button',
      {
        type: 'button',
        class: 'btn btn--icon btn--glass about-btn',
        title: 'Acerca de',
        'aria-label': 'Acerca de',
        'aria-haspopup': 'dialog',
        'data-allow-locked': '',
        on: { click: (e) => ui.about?.open(e.currentTarget) },
      },
      icon('info', { size: 18 }),
    );
    ui.about?.setTrigger(this.aboutBtn);
    // PIN de presentador para una PC remota. Con la capa de bloqueo ("Esperando al presentador", presentación en curso) la barra
    // lateral queda inerte y con ella el panel Conexión, así que el campo vive aquí, por encima de la capa (data-allow-locked).
    this.pinToggle = h(
      'button',
      {
        type: 'button',
        class: 'btn btn--pill btn--sm pin-lock__toggle', // aspecto de vidrio propio (hud.css): el primer .btn--glass del grupo es el de pantalla completa
        title: 'Soy el presentador: entrar con el PIN',
        'aria-label': 'Entrar como presentador con PIN',
        'aria-expanded': 'false',
        'data-allow-locked': '',
        on: { click: () => this._setPinOpen(!this.pinOpen) },
      },
      icon('key', { size: 14 }),
      h('span', { text: 'Soy el presentador' }),
    );
    this.pinInput = h('input', {
      type: 'password',
      class: 'input pin-lock__input',
      maxlength: '64',
      autocomplete: 'off',
      'aria-label': 'Introduce el PIN de presentador',
      placeholder: 'PIN de presentador',
      'data-allow-locked': '',
    });
    this.pinSubmit = h(
      'button',
      { type: 'submit', class: 'btn btn--sm btn--primary btn--icon', title: 'Entrar como presentador', 'aria-label': 'Entrar como presentador', 'data-allow-locked': '' },
      icon('check', { size: 16 }),
    );
    this.pinForm = h(
      'form',
      {
        class: 'pin-lock__form',
        hidden: true,
        autocomplete: 'off',
        'data-allow-locked': '',
        on: {
          submit: async (e) => {
            e.preventDefault();
            this.pinSubmit.disabled = true;
            const ok = await enterWithPin(ui, this.pinInput.value);
            this.pinSubmit.disabled = false;
            if (!ok) {
              this.pinInput.value = '';
              this.pinInput.focus();
            }
          },
        },
      },
      this.pinInput,
      this.pinSubmit,
    );
    this.pinWrap = h('div', { class: 'pin-lock', hidden: true, 'data-allow-locked': '' }, this.pinToggle, this.pinForm);
    this.pinOpen = false;

    this.el.append(this.loadChip, this.connChip, this.slot, this.pinWrap, this.fullBtn, this.aboutBtn);
    ui.root.append(this.el);

    this.bar = h('div', { class: 'global-progress', hidden: true, role: 'progressbar', 'aria-label': 'Progreso de carga' }, h('span', { class: 'global-progress__fill' }));
    ui.root.append(this.bar);

    // La cabecera deja libre el espacio que ocupa este grupo (ancho variable)
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(() => {
        const w = Math.ceil(this.el.getBoundingClientRect().width);
        ui.root.style.setProperty('--cluster-w', `${w}px`);
      });
      ro.observe(this.el);
      this.addCleanup(() => ro.disconnect());
    }

    this.watch(['presentation', 'loading']);
    for (const evt of ['fullscreenchange', 'webkitfullscreenchange']) this.listen(document, evt, () => this._paintFullscreen());
    this.render();
  }

  _setPinOpen(open) {
    this.pinOpen = open;
    this.pinForm.hidden = !open;
    this.pinToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) this.pinInput.focus();
    else this.pinInput.value = '';
  }

  _paintFullscreen() {
    const on = !!fullscreenElement();
    const name = on ? 'fullscreen-exit' : 'fullscreen';
    const label = on ? 'Salir de pantalla completa' : 'Pantalla completa';
    this.fullBtn.title = label;
    this.fullBtn.setAttribute('aria-label', label);
    this.fullBtn.replaceChildren(icon(name, { size: 18 }));
  }

  render() {
    const ui = this.ui;
    const p = this.store.get('presentation');
    this._paintFullscreen();

    // Carga global
    const loading = Object.values(this.store.get('loading') || {}).filter((l) => l && l.phase !== 'done' && l.phase !== 'error');
    if (loading.length) {
      const avg = loading.reduce((a, l) => a + (Number(l.progress) || 0), 0) / loading.length;
      const pct = Math.round(avg * 100);
      this.loadChip.hidden = false;
      this.loadChip.replaceChildren(h('span', { class: 'spinner', 'aria-hidden': 'true' }), `Cargando ${loading.length === 1 ? '1 modelo' : `${loading.length} modelos`} · ${pct} %`);
      this.bar.hidden = false;
      this.bar.firstElementChild.style.width = `${Math.max(4, pct)}%`;
      this.bar.setAttribute('aria-valuenow', String(pct));
    } else {
      this.loadChip.hidden = true;
      this.bar.hidden = true;
    }

    // PIN de presentador: solo si el servidor lo exige, esta PC es espectadora y la capa de bloqueo le tapa el panel Conexión
    const showPin = !!ui.ctx.info?.presenterPinEnabled && p.role === 'viewer' && ui.isLocked();
    this.pinWrap.hidden = !showPin;
    if (!showPin && this.pinOpen) this._setPinOpen(false);

    // Conexión
    this.connChip.hidden = !!p.connected;
    if (!p.connected) {
      this.connChip.replaceChildren(h('span', { class: 'spinner spinner--sm', 'aria-hidden': 'true' }), 'Reconectando…');
    }

    // Presentación
    const slot = clear(this.slot);
    const live = !!p.active;
    if (p.role === 'presenter') {
      if (live && p.isActivePresenter) {
        slot.append(
          this._livePill(`${viewersLabel(p.viewers || 0)}`, true),
          h('button', { type: 'button', class: 'btn btn--pill btn--glass btn--sm', title: 'Detener la presentación (P)', 'aria-label': 'Detener la presentación', 'data-allow-locked': '', on: { click: () => this.ctx.presentation?.stop?.() } }, icon('stop', { size: 14 }), h('span', { text: 'Detener' })),
        );
      } else if (live) {
        slot.append(
          this._livePill(`Siguiendo a ${p.presenterName || 'otro presentador'}`, true),
          h('button', { type: 'button', class: 'btn btn--pill btn--primary btn--sm', title: 'Tomar el control de la presentación', 'aria-label': 'Tomar el control de la presentación', 'data-allow-locked': '', on: { click: () => this.ctx.presentation?.takeControl?.() } }, icon('play', { size: 14 }), h('span', { text: 'Tomar control' })),
        );
      } else {
        slot.append(
          h(
            'button',
            {
              type: 'button',
              class: 'btn btn--pill btn--primary btn--present',
              title: p.connected ? 'Presentar a las demás PCs (P)' : 'Sin conexión con el servidor',
              'aria-label': 'Presentar',
              disabled: !p.connected,
              'data-allow-locked': '',
              on: { click: () => this.ctx.presentation?.toggle?.() },
            },
            icon('play', { size: 15 }),
            h('span', { text: 'Presentar' }),
          ),
        );
      }
    } else if (live) {
      slot.append(this._livePill(`Siguiendo a ${p.presenterName || 'el presentador'}`, false));
    } else if (p.viewerFreeNav === false) {
      slot.append(h('span', { class: 'chip chip--muted', role: 'status' }, 'Esperando al presentador'));
    }
    // Si el panel estaba anclado a una insignia que se acaba de reconstruir, se reancla a la nueva
    if (this.panel.isOpen && !this.panel.popover.anchor?.isConnected) {
      const pill = this.slot.querySelector('.live-pill--button');
      if (pill) {
        this.panel.popover.anchor = pill;
        pill.setAttribute('aria-expanded', 'true');
      }
    }
    setClass(this.el, 'is-live', live);
    ui.root.dataset.live = live ? 'true' : 'false';
  }

  _livePill(text, interactive) {
    const inner = [h('span', { class: 'live-pill__dot' }), h('span', { class: 'live-pill__tag', text: 'EN VIVO' }), h('span', { class: 'live-pill__sep', text: '·' }), h('span', { class: 'live-pill__text', text })];
    if (!interactive) return h('span', { class: 'live-pill', role: 'status', 'data-allow-locked': '' }, ...inner);
    const btn = h(
      'button',
      {
        type: 'button',
        class: 'live-pill live-pill--button',
        title: 'Opciones de presentación',
        'aria-label': `En vivo, ${text}. Abrir opciones de presentación`,
        'aria-haspopup': 'dialog',
        'aria-expanded': this.panel.isOpen ? 'true' : 'false',
        'data-allow-locked': '',
      },
      ...inner,
      icon('chevron-down', { size: 14 }),
    );
    btn.addEventListener('click', () => this.panel.toggle(btn));
    return btn;
  }
}
