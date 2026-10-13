// Utilidades mínimas para construir DOM sin librerías.
//
//   h('button', { class: 'btn', title: 'Hola', on: { click: fn } }, icon('eye'), 'Texto')

export function h(tag, props = null, ...children) {
  const el = document.createElement(tag);
  if (props) applyProps(el, props);
  append(el, children);
  return el;
}

function applyProps(el, props) {
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    switch (key) {
      case 'class':
        el.className = value;
        break;
      case 'style':
        if (typeof value === 'string') el.style.cssText = value;
        else {
          for (const [k, v] of Object.entries(value)) {
            if (k.startsWith('--')) el.style.setProperty(k, v);
            else el.style[k] = v;
          }
        }
        break;
      case 'dataset':
        for (const [k, v] of Object.entries(value)) el.dataset[k] = v;
        break;
      case 'text':
        el.textContent = value;
        break;
      case 'on':
        for (const [type, fn] of Object.entries(value)) el.addEventListener(type, fn);
        break;
      case 'value':
      case 'checked':
      case 'disabled':
      case 'hidden':
      case 'selected':
        el[key] = value;
        break;
      default:
        el.setAttribute(key, value === true ? '' : String(value));
    }
  }
}

export function append(parent, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    parent.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return parent;
}

export function clear(el) {
  el.replaceChildren();
  return el;
}

export function setClass(el, name, on) {
  if (el) el.classList.toggle(name, !!on);
}

// Asigna textContent solo si cambia (evita reflujos y pérdida de selección de texto).
export function setText(el, text) {
  const t = String(text ?? '');
  if (el && el.textContent !== t) el.textContent = t;
}

export function setAttr(el, name, value) {
  if (!el) return;
  if (value === null || value === undefined || value === false) {
    if (el.hasAttribute(name)) el.removeAttribute(name);
  } else {
    const v = value === true ? '' : String(value);
    if (el.getAttribute(name) !== v) el.setAttribute(name, v);
  }
}

export function debounce(fn, ms = 120) {
  let timer = null;
  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, ms);
  };
  wrapped.cancel = () => {
    clearTimeout(timer);
    timer = null;
  };
  wrapped.flush = (...args) => {
    wrapped.cancel();
    fn(...args);
  };
  return wrapped;
}

// Ejecuta fn como máximo una vez por fotograma (con los últimos argumentos).
export function rafThrottle(fn) {
  let pending = false;
  let lastArgs = null;
  const wrapped = (...args) => {
    lastArgs = args;
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      fn(...lastArgs);
    });
  };
  return wrapped;
}

// Agrupa llamadas del mismo ciclo de eventos en una sola (microtarea).
export function microBatch(fn) {
  let queued = false;
  return () => {
    if (queued) return;
    queued = true;
    Promise.resolve().then(() => {
      queued = false;
      fn();
    });
  };
}

export function isEditable(target) {
  if (!target || !(target instanceof Element)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT') {
    const type = (target.getAttribute('type') || 'text').toLowerCase();
    return !['button', 'checkbox', 'radio', 'range', 'submit', 'reset', 'file', 'color'].includes(type);
  }
  return tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

export function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

// Ejecuta fn y devuelve su resultado; ante un error registra y devuelve fallback.
// La UI debe sobrevivir a módulos de otros agentes que fallen o aún no existan.
export function safe(fn, fallback = null) {
  try {
    const v = fn();
    return v === undefined ? fallback : v;
  } catch (err) {
    console.warn('[ui]', err);
    return fallback;
  }
}

export async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* se intenta el método alternativo */
  }
  try {
    const ta = h('textarea', { value: text, style: { position: 'fixed', opacity: '0', left: '-9999px' } });
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

// Almacenamiento local tolerante (puede lanzar en ventanas privadas).
export const local = {
  get(key, fallback = null) {
    try {
      const v = localStorage.getItem(key);
      return v === null ? fallback : v;
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* sin almacenamiento */
    }
  },
};
