// Controles reutilizables: botones con icono, interruptores, segmentados, rangos y estados vacíos.

import { h, setClass } from './dom.js';
import { icon } from './icons.js';

// Botón con solo icono. Siempre lleva title y aria-label (accesibilidad).
export function iconButton({ icon: name, title, onClick = null, className = '', size = 18, disabled = false, attrs = {} } = {}) {
  const btn = h(
    'button',
    {
      type: 'button',
      class: `btn btn--icon ${className}`.trim(),
      title,
      'aria-label': title,
      disabled,
      ...attrs,
    },
    icon(name, { size }),
  );
  if (onClick) btn.addEventListener('click', onClick);
  return btn;
}

// Botón con texto (y opcionalmente icono).
export function textButton({ label, icon: name = null, title = null, onClick = null, className = '', size = 16, type = 'button', disabled = false } = {}) {
  const btn = h(
    'button',
    { type, class: `btn ${className}`.trim(), title: title || label, disabled },
    name ? icon(name, { size }) : null,
    h('span', { class: 'btn__label', text: label }),
  );
  if (onClick) btn.addEventListener('click', onClick);
  return btn;
}

// Interruptor accesible. Devuelve { el, set(checked) }.
export function switchControl({ checked = false, label, onChange }) {
  const input = h('input', { type: 'checkbox', class: 'switch__input', checked, 'aria-label': label });
  const el = h('label', { class: 'switch', title: label }, input, h('span', { class: 'switch__track' }, h('span', { class: 'switch__thumb' })));
  input.addEventListener('change', () => onChange?.(input.checked));
  return {
    el,
    input,
    set(v) {
      if (input.checked !== !!v) input.checked = !!v;
    },
  };
}

// Control segmentado (radiogroup). options: [{ value, label, icon?, title? }]
export function segmented(options, { value = null, onChange, className = '', ariaLabel = '' } = {}) {
  const buttons = new Map();
  const el = h('div', { class: `seg ${className}`.trim(), role: 'radiogroup', 'aria-label': ariaLabel });
  for (const opt of options) {
    const btn = h(
      'button',
      { type: 'button', class: 'seg__btn', role: 'radio', 'aria-checked': 'false', title: opt.title || opt.label, 'data-value': opt.value },
      opt.icon ? icon(opt.icon, { size: 16 }) : null,
      opt.label ? h('span', { text: opt.label }) : null,
    );
    btn.addEventListener('click', () => onChange?.(opt.value));
    buttons.set(opt.value, btn);
    el.append(btn);
  }
  const api = {
    el,
    set(v) {
      for (const [val, btn] of buttons) {
        const on = val === v;
        setClass(btn, 'is-on', on);
        btn.setAttribute('aria-checked', on ? 'true' : 'false');
      }
    },
  };
  api.set(value);
  return api;
}

// Deslizador con relleno (variable CSS --pct) para dar estilo a la pista.
export function rangeControl({ min = 0, max = 1, step = 0.01, value = 0, label, onInput, className = '' }) {
  const input = h('input', { type: 'range', class: `range ${className}`.trim(), min, max, step, value, 'aria-label': label, title: label });
  const paint = () => {
    const lo = Number(input.min);
    const hi = Number(input.max);
    const pct = hi > lo ? ((Number(input.value) - lo) / (hi - lo)) * 100 : 0;
    input.style.setProperty('--pct', `${pct}%`);
  };
  input.addEventListener('input', () => {
    paint();
    onInput?.(Number(input.value));
  });
  paint();
  return {
    el: input,
    paint,
    set(v) {
      if (document.activeElement !== input && Number(input.value) !== v) input.value = String(v);
      paint();
    },
    setBounds(lo, hi, st) {
      input.min = String(lo);
      input.max = String(hi);
      if (st) input.step = String(st);
      paint();
    },
  };
}

export function progressBar(value = 0, { indeterminate = false, className = '' } = {}) {
  const fill = h('span', { class: 'progress__fill' });
  const el = h('div', { class: `progress ${className}`.trim(), role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100' }, fill);
  const api = {
    el,
    set(v, indet = false) {
      const pct = Math.max(0, Math.min(1, Number(v) || 0)) * 100;
      fill.style.width = `${pct.toFixed(1)}%`;
      el.setAttribute('aria-valuenow', String(Math.round(pct)));
      setClass(el, 'is-indeterminate', indet);
    },
  };
  api.set(value, indeterminate);
  return api;
}

export function emptyState({ icon: name = 'info', title, text = '', action = null }) {
  return h(
    'div',
    { class: 'empty' },
    h('span', { class: 'empty__icon' }, icon(name, { size: 22 })),
    h('p', { class: 'empty__title', text: title }),
    text ? h('p', { class: 'empty__text', text }) : null,
    action,
  );
}

// Tarjeta de pestaña: cabecera con título (y acciones) y contenido.
export function card({ title = null, actions = null, className = '', children = [] } = {}) {
  return h(
    'section',
    { class: `panel-card ${className}`.trim() },
    title || actions ? h('header', { class: 'panel-card__head' }, title ? h('h3', { class: 'panel-card__title', text: title }) : null, actions) : null,
    ...children,
  );
}

// Cifra grande y fina con decimales en gris: bigNumber('72', '.34', '%')
export function bigNumber(intPart, decPart = '', unit = '', className = '') {
  return h(
    'span',
    { class: `num ${className}`.trim() },
    h('span', { class: 'num__int', text: intPart }),
    decPart ? h('span', { class: 'num__dec', text: decPart }) : null,
    unit ? h('span', { class: 'num__unit', text: unit }) : null,
  );
}

export function field({ label, input, hint = '', className = '' }) {
  return h('label', { class: `field ${className}`.trim() }, h('span', { class: 'field__label', text: label }), input, hint ? h('span', { class: 'field__hint', text: hint }) : null);
}

export function numberInput({ value = '', step = 'any', min = null, max = null, placeholder = '', label, unit = '', onInput = null }) {
  const input = h('input', { type: 'number', class: 'input', step, min, max, placeholder, value: value === null ? '' : String(value), 'aria-label': label, inputmode: 'decimal' });
  if (onInput) input.addEventListener('input', () => onInput(input.value));
  const wrap = unit ? h('span', { class: 'input-wrap' }, input, h('span', { class: 'input-wrap__unit', text: unit })) : input;
  return { el: wrap, input };
}
