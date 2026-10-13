// Paneles emergentes de la barra lateral: Presentación, Conexión y Ajustes.

import { h, clear, copyText, safe, setText, setClass } from './dom.js';
import { icon } from './icons.js';
import { Component } from './Component.js';
import { Popover } from './overlay.js';
import { iconButton, segmented, switchControl, textButton } from './widgets.js';

// Normaliza una URL de red a "http://ip:puerto" (acepta URLs completas o solo la IP).
export function normalizeLanUrl(raw, port) {
  let url = String(raw || '').trim();
  if (!url) return '';
  if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
  if (port && !/:\d+(\/|$)/.test(url.replace(/^https?:\/\//i, ''))) url = `${url.replace(/\/$/, '')}:${port}`;
  return url;
}

export function lanUrlsOf(ui) {
  const p = ui.presentation;
  const port = ui.ctx.info?.port || (typeof location !== 'undefined' ? location.port : '');
  const list = (p.lanUrls || []).map((u) => normalizeLanUrl(u, port)).filter(Boolean);
  return [...new Set(list)];
}

export function viewersLabel(n) {
  return `${n} ${n === 1 ? 'espectador' : 'espectadores'}`;
}

// Comprueba el PIN contra el servidor; si es correcto recarga la página con el rol de presentador (el PIN queda en
// sessionStorage vía api.setPin y lo usan ApiClient y SyncClient). Devuelve true si el PIN era válido.
// Lo usan el panel Conexión y el campo de PIN de la pantalla bloqueada (StatusCluster).
export async function enterWithPin(ui, rawPin) {
  const pin = String(rawPin || '').trim();
  const api = ui.ctx.api;
  if (!pin || !api) return false;
  api.setPin(pin);
  try {
    const info = await api.getInfo();
    if (info.role === 'presenter') {
      ui.toast('success', 'PIN correcto. Entrando como presentador…');
      setTimeout(() => location.reload(), 400);
      return true;
    }
  } catch (err) {
    console.warn('[ui] comprobación del PIN', err);
  }
  api.setPin('');
  ui.toast('error', 'PIN incorrecto.');
  return false;
}

// ----------------------------------------------------------------------------------------
export class PresentationPanel extends Component {
  constructor(ui) {
    super(ui);
    this.popover = new Popover(ui, { className: 'popover--panel', align: 'end', label: 'Presentación' });
    this.el = this.popover.el;
    this.watch('presentation');
    this.render();
  }

  toggle(anchor) {
    this.popover.toggle(anchor);
  }

  dispose() {
    this.popover.dispose();
    super.dispose();
  }

  get isOpen() {
    return this.popover.isOpen;
  }

  render() {
    const ui = this.ui;
    const p = this.store.get('presentation');
    const isPresenter = p.role === 'presenter';
    const body = [];

    const live = !!p.active;
    body.push(
      h(
        'header',
        { class: 'pop-head' },
        h('h3', { class: 'pop-title', text: 'Presentación' }),
        live ? h('span', { class: 'live-tag' }, h('span', { class: 'live-tag__dot' }), 'EN VIVO') : h('span', { class: 'pop-tag', text: isPresenter ? 'Presentador' : 'Espectador' }),
      ),
    );

    if (isPresenter) {
      body.push(h('p', { class: 'pop-text', text: 'Muestra lo que haces a las demás PCs de la red. Los espectadores replican tu vista y no pueden interactuar.' }));
      if (!live) {
        body.push(this._action('play', 'Iniciar presentación', 'btn btn--primary btn--block', () => this.ctx.presentation?.start?.(), !p.connected));
      } else if (p.isActivePresenter) {
        body.push(
          h('div', { class: 'pop-stat' }, icon('users', { size: 16 }), h('span', { text: `${viewersLabel(p.viewers || 0)} conectados` })),
          this._action('stop', 'Detener presentación', 'btn btn--dark btn--block', () => this.ctx.presentation?.stop?.()),
        );
      } else {
        body.push(
          h('div', { class: 'pop-note' }, icon('alert', { size: 16 }), h('span', { text: `${p.presenterName || 'Otro presentador'} está presentando.` })),
          this._action('play', 'Tomar control', 'btn btn--primary btn--block', () => this.ctx.presentation?.takeControl?.()),
        );
      }
      if (!p.connected) body.push(h('p', { class: 'pop-hint pop-hint--warn', text: 'Sin conexión con el servidor. Reconectando…' }));

      // Direcciones de red
      const urls = lanUrlsOf(ui);
      body.push(h('h4', { class: 'pop-sub', text: 'Direcciones para los espectadores' }));
      if (urls.length) {
        const list = h('ul', { class: 'url-list' });
        for (const url of urls) {
          list.append(
            h(
              'li',
              { class: 'url-item' },
              h('span', { class: 'url-item__text', text: url, title: url }),
              iconButton({
                icon: 'copy',
                title: `Copiar ${url}`,
                className: 'btn--sm btn--ghost',
                size: 16,
                onClick: async () => {
                  const ok = await copyText(url);
                  ui.toast(ok ? 'success' : 'warning', ok ? 'Dirección copiada al portapapeles.' : 'No se pudo copiar. Selecciónala manualmente.');
                },
              }),
            ),
          );
        }
        body.push(list, h('p', { class: 'pop-hint', text: 'Abre una de estas direcciones en las otras PCs (misma red).' }));
      } else {
        body.push(h('p', { class: 'pop-hint', text: `No se detectó ninguna red local. Usa ${location.origin}.` }));
      }

      // Puntero láser
      const laser = switchControl({
        checked: p.laser !== false,
        label: 'Puntero láser',
        onChange: (v) => {
          if (this.ctx.presentation?.setLaser) this.ctx.presentation.setLaser(v);
          else this.store.patch('presentation', { laser: v }, { source: 'system' });
        },
      });
      body.push(
        h(
          'div',
          { class: 'pop-row' },
          h('span', { class: 'pop-row__label' }, icon('laser', { size: 16 }), h('span', { text: 'Puntero láser' })),
          laser.el,
        ),
        h('p', { class: 'pop-hint', text: 'Los espectadores ven un punto rojo donde apuntas con el cursor.' }),
      );
    } else {
      // Espectador
      let status = 'Sin presentación activa.';
      if (live) status = `Siguiendo a ${p.presenterName || 'el presentador'}.`;
      else if (p.viewerFreeNav === false) status = 'Esperando al presentador.';
      else status += ' Puedes navegar libremente por el modelo.';
      body.push(h('p', { class: 'pop-text', text: status }));
      body.push(h('p', { class: 'pop-hint', text: 'Cuando el presentador inicie una presentación verás exactamente lo que hace y no podrás interactuar.' }));
    }

    clear(this.el).append(...body);
    if (this.popover.isOpen) this.popover.position();
  }

  _action(iconName, label, cls, fn, disabled = false) {
    return textButton({ label, icon: iconName, className: cls, onClick: fn, disabled });
  }
}

// ----------------------------------------------------------------------------------------
export class ConnectionPanel extends Component {
  constructor(ui) {
    super(ui);
    this.popover = new Popover(ui, { className: 'popover--panel', align: 'end', label: 'Conexión' });
    this.el = this.popover.el;

    this.dot = h('span', { class: 'conn-dot' });
    this.statusEl = h('span', { class: 'pop-status__text' });
    this.roleEl = h('span', { class: 'kv__v' });
    this.viewersEl = h('span', { class: 'kv__v' });
    this.ipEl = h('span', { class: 'kv__v' });
    this.versionEl = h('span', { class: 'kv__v' });
    this.nameInput = h('input', { type: 'text', class: 'input', maxlength: '40', 'aria-label': 'Nombre de este equipo', placeholder: 'Nombre de este equipo' });
    this.saveName = () => {
      const value = this.nameInput.value.trim();
      if (!value) return;
      const applied = safe(() => this.ctx.sync?.setName?.(value), value);
      this.nameInput.value = applied || value;
      ui.toast('success', 'Nombre actualizado.');
    };
    this.nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.saveName();
    });
    this.retryBtn = textButton({
      label: 'Reintentar ahora',
      icon: 'refresh',
      className: 'btn--sm btn--block',
      onClick: () => safe(() => this.ctx.sync?.connect?.()),
    });

    // PIN de presentador (solo si el servidor lo exige): permite que otra PC de la red presente
    this.pinInput = h('input', { type: 'password', class: 'input', maxlength: '64', autocomplete: 'off', 'aria-label': 'PIN de presentador', placeholder: 'PIN de presentador' });
    this.pinInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.submitPin();
    });
    this.pinBtn = iconButton({ icon: 'check', title: 'Entrar como presentador', className: 'btn--sm', size: 16, onClick: () => this.submitPin() });
    this.pinExit = textButton({ label: 'Dejar de ser presentador', icon: 'stop', className: 'btn--sm btn--block', onClick: () => this.clearPin() });
    this.pinBox = h(
      'div',
      { class: 'pin-box', hidden: true },
      h('h4', { class: 'pop-sub', text: 'Presentar desde esta PC' }),
      h('p', { class: 'pop-hint', text: 'El servidor pide un PIN para que otra PC pueda presentar.' }),
      h('div', { class: 'row-gap' }, this.pinInput, this.pinBtn),
      this.pinExit,
    );

    this.el.append(
      h('header', { class: 'pop-head' }, h('h3', { class: 'pop-title', text: 'Conexión' })),
      h('div', { class: 'pop-status' }, this.dot, this.statusEl),
      h(
        'dl',
        { class: 'kv' },
        h('dt', { class: 'kv__k', text: 'Rol' }),
        h('dd', {}, this.roleEl),
        h('dt', { class: 'kv__k', text: 'Espectadores' }),
        h('dd', {}, this.viewersEl),
        h('dt', { class: 'kv__k', text: 'Tu dirección' }),
        h('dd', {}, this.ipEl),
        h('dt', { class: 'kv__k', text: 'Versión' }),
        h('dd', {}, this.versionEl),
      ),
      h('h4', { class: 'pop-sub', text: 'Nombre de este equipo' }),
      h('div', { class: 'row-gap' }, this.nameInput, iconButton({ icon: 'check', title: 'Guardar nombre', className: 'btn--sm', size: 16, onClick: () => this.saveName() })),
      this.pinBox,
      this.retryBtn,
    );
    this.watch('presentation');
    this.popover.onOpen = () => {
      const name = safe(() => this.ctx.sync?.getName?.(), '');
      if (name && document.activeElement !== this.nameInput) this.nameInput.value = name;
      this.render();
    };
    this.render();
  }

  toggle(anchor) {
    this.popover.toggle(anchor);
  }

  dispose() {
    this.popover.dispose();
    super.dispose();
  }

  // Comprueba el PIN contra el servidor y recarga la página con el rol de presentador
  async submitPin() {
    const ok = await enterWithPin(this.ui, this.pinInput.value);
    if (!ok) this.pinInput.value = '';
  }

  clearPin() {
    this.ctx.api?.setPin('');
    location.reload();
  }

  render() {
    const p = this.store.get('presentation');
    const pinOn = !!this.ctx.info?.presenterPinEnabled;
    const hasPin = !!safe(() => this.ctx.api?.getPin?.(), '');
    this.pinBox.hidden = !(pinOn && (p.role === 'viewer' || hasPin));
    this.pinInput.hidden = p.role === 'presenter';
    this.pinBtn.hidden = p.role === 'presenter';
    this.pinExit.hidden = !(hasPin && p.role === 'presenter');
    setClass(this.dot, 'is-on', p.connected);
    setText(this.statusEl, p.connected ? 'Conectado al servidor' : 'Sin conexión. Reconectando…');
    this.retryBtn.hidden = !!p.connected;
    setText(this.roleEl, p.role === 'presenter' ? 'Presentador (anfitrión)' : 'Espectador');
    setText(this.viewersEl, String(p.viewers ?? 0));
    setText(this.ipEl, this.ctx.info?.clientIp || '—');
    setText(this.versionEl, this.ctx.info?.version || '—');
  }
}

// ----------------------------------------------------------------------------------------
const SHORTCUTS = [
  ['Esc', 'Limpiar selección o cancelar medición'],
  ['H', 'Ocultar la selección'],
  ['I', 'Aislar la selección'],
  ['Mayús + H', 'Mostrar todo'],
  ['F', 'Encuadrar selección o todo'],
  ['M', 'Activar o desactivar la medición'],
  ['P', 'Presentar o detener'],
  ['/', 'Buscar elementos'],
];

export class SettingsPanel extends Component {
  constructor(ui) {
    super(ui);
    this.popover = new Popover(ui, { className: 'popover--panel', align: 'end', label: 'Ajustes' });
    this.el = this.popover.el;

    this.edges = switchControl({ checked: false, label: 'Aristas', onChange: (v) => this.actions.toggleEdges(v) });
    this.spaces = switchControl({ checked: false, label: 'Mostrar espacios', onChange: (v) => this.actions.toggleSpaces(v) });
    this.projection = segmented(
      [
        { value: 'perspective', label: 'Perspectiva', icon: 'cube', title: 'Proyección en perspectiva' },
        { value: 'orthographic', label: 'Ortogonal', icon: 'plan', title: 'Proyección ortogonal' },
      ],
      { onChange: (v) => this.actions.setProjection(v), ariaLabel: 'Proyección' },
    );

    const kbd = h('dl', { class: 'shortcut-list' });
    for (const [key, text] of SHORTCUTS) {
      kbd.append(h('dt', {}, ...key.split(' + ').flatMap((k, i) => (i ? ['+', h('kbd', { text: k })] : [h('kbd', { text: k })]))), h('dd', { text: text }));
    }

    this.el.append(
      h('header', { class: 'pop-head' }, h('h3', { class: 'pop-title', text: 'Ajustes' })),
      h('h4', { class: 'pop-sub', text: 'Visualización' }),
      h('div', { class: 'pop-row' }, h('span', { class: 'pop-row__label', text: 'Aristas de los elementos' }), this.edges.el),
      h('div', { class: 'pop-row' }, h('span', { class: 'pop-row__label', text: 'Mostrar espacios (IfcSpace)' }), this.spaces.el),
      h('div', { class: 'pop-row pop-row--stack' }, h('span', { class: 'pop-row__label', text: 'Proyección' }), this.projection.el),
      h('h4', { class: 'pop-sub', text: 'Atajos de teclado' }),
      kbd,
    );
    this.watch('display');
    this.render();
  }

  toggle(anchor) {
    this.popover.toggle(anchor);
  }

  dispose() {
    this.popover.dispose();
    super.dispose();
  }

  render() {
    const d = this.store.get('display');
    this.edges.set(d.edges);
    this.spaces.set(d.showSpaces);
    this.projection.set(d.projection);
  }
}
