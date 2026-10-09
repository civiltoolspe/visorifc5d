// Iconos SVG en línea propios (viewBox 24x24, trazo 1.75 redondeado).
// No se usan fuentes de iconos ni CDNs: el visor debe funcionar sin internet.
//
//   import { icon } from './icons.js';
//   button.append(icon('eye'));                    // 18 px por defecto
//   icon('plus', { size: 20, className: 'x' });

// Cada entrada es el contenido interno del <svg> (todo con stroke="currentColor" heredado).
const PATHS = {
  search: '<circle cx="11" cy="11" r="6.6"/><path d="M16 16l4.5 4.5"/>',
  cast:
    '<path d="M3.5 8V7.5A3 3 0 0 1 6.5 4.5h11a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3H14"/>' +
    '<path d="M3.5 12.2a7.3 7.3 0 0 1 7.3 7.3"/><path d="M3.5 16.4a3.1 3.1 0 0 1 3.1 3.1"/>' +
    '<circle cx="4" cy="19.5" r="0.6" fill="currentColor"/>',
  wifi:
    '<path d="M4.5 10.2a10.4 10.4 0 0 1 15 0"/><path d="M7.7 13.6a6 6 0 0 1 8.6 0"/>' +
    '<path d="M10.6 16.9a1.9 1.9 0 0 1 2.8 0"/><circle cx="12" cy="19.6" r="0.8" fill="currentColor"/>',
  'wifi-off':
    '<path d="M4.5 10.2a10.4 10.4 0 0 1 4-2.6"/><path d="M13 7.2a10.4 10.4 0 0 1 6.5 3"/>' +
    '<path d="M7.7 13.6a6 6 0 0 1 2.5-1.5"/><path d="M14.4 12.5a6 6 0 0 1 1.9 1.1"/>' +
    '<circle cx="12" cy="19.6" r="0.8" fill="currentColor"/><path d="M4 4l16 16"/>',
  sliders:
    '<path d="M4 7h8.2"/><path d="M17.8 7H20"/><circle cx="15" cy="7" r="2.3"/>' +
    '<path d="M4 17h2.2"/><path d="M11.8 17H20"/><circle cx="9" cy="17" r="2.3"/>',
  'panel-close':
    '<rect x="3.5" y="4.5" width="17" height="15" rx="4"/><path d="M9.5 4.5v15"/><path d="M15.6 9.6L13.2 12l2.4 2.4"/>',
  'panel-open':
    '<rect x="3.5" y="4.5" width="17" height="15" rx="4"/><path d="M9.5 4.5v15"/><path d="M13.4 9.6l2.4 2.4-2.4 2.4"/>',
  home:
    '<path d="M4 11.2l8-6.7 8 6.7"/><path d="M6 10v8.2A1.8 1.8 0 0 0 7.8 20h8.4a1.8 1.8 0 0 0 1.8-1.8V10"/><path d="M10 20v-5h4v5"/>',
  tree:
    '<rect x="3.5" y="4" width="5.2" height="4.6" rx="1.5"/><path d="M6.1 8.6V16a2.5 2.5 0 0 0 2.5 2.5H11"/>' +
    '<path d="M6.1 12.4H11"/><path d="M12.8 12.4h7.7"/><path d="M12.8 18.5h7.7"/>',
  info: '<circle cx="12" cy="12" r="8.6"/><path d="M12 11v5.2"/><circle cx="12" cy="7.9" r="0.55" fill="currentColor"/>',
  layers:
    '<path d="M12 3.6l8.6 4.6-8.6 4.6-8.6-4.6z"/><path d="M3.4 12.2l8.6 4.6 8.6-4.6"/><path d="M3.4 16.2l8.6 4.6 8.6-4.6"/>',
  bookmark: '<path d="M7.2 4h9.6a1.7 1.7 0 0 1 1.7 1.7V20l-6.5-4.1L5.5 20V5.7A1.7 1.7 0 0 1 7.2 4z"/>',
  eye:
    '<path d="M2.6 12S6 5.6 12 5.6 21.4 12 21.4 12 18 18.4 12 18.4 2.6 12 2.6 12z"/><circle cx="12" cy="12" r="2.8"/>',
  'eye-off':
    '<path d="M9.8 5.8a9 9 0 0 1 2.2-.2c6 0 9.4 6.4 9.4 6.4a16.6 16.6 0 0 1-2.7 3.5"/>' +
    '<path d="M6.5 7.4A16.3 16.3 0 0 0 2.6 12S6 18.4 12 18.4c1.5 0 2.8-.3 4-.9"/>' +
    '<path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/><path d="M3.8 3.8l16.4 16.4"/>',
  fit:
    '<path d="M4 8.6V6.2A2.2 2.2 0 0 1 6.2 4h2.4"/><path d="M15.4 4h2.4A2.2 2.2 0 0 1 20 6.2v2.4"/>' +
    '<path d="M20 15.4v2.4a2.2 2.2 0 0 1-2.2 2.2h-2.4"/><path d="M8.6 20H6.2A2.2 2.2 0 0 1 4 17.8v-2.4"/>' +
    '<circle cx="12" cy="12" r="2.7"/>',
  isolate:
    '<path d="M4 8.6V6.2A2.2 2.2 0 0 1 6.2 4h2.4"/><path d="M15.4 4h2.4A2.2 2.2 0 0 1 20 6.2v2.4"/>' +
    '<path d="M20 15.4v2.4a2.2 2.2 0 0 1-2.2 2.2h-2.4"/><path d="M8.6 20H6.2A2.2 2.2 0 0 1 4 17.8v-2.4"/>' +
    '<rect x="8.6" y="8.6" width="6.8" height="6.8" rx="1.8"/>',
  fullscreen:
    '<path d="M4 9V6.2A2.2 2.2 0 0 1 6.2 4H9"/><path d="M15 4h2.8A2.2 2.2 0 0 1 20 6.2V9"/>' +
    '<path d="M20 15v2.8a2.2 2.2 0 0 1-2.2 2.2H15"/><path d="M9 20H6.2A2.2 2.2 0 0 1 4 17.8V15"/>',
  'fullscreen-exit':
    '<path d="M9 4v2.8A2.2 2.2 0 0 1 6.8 9H4"/><path d="M20 9h-2.8A2.2 2.2 0 0 1 15 6.8V4"/>' +
    '<path d="M15 20v-2.8a2.2 2.2 0 0 1 2.2-2.2H20"/><path d="M4 15h2.8A2.2 2.2 0 0 1 9 17.2V20"/>',
  cube: '<path d="M12 3.4l7.9 4.4v8.4L12 20.6l-7.9-4.4V7.8z"/><path d="M4.1 7.8L12 12.2l7.9-4.4"/><path d="M12 12.2v8.4"/>',
  views:
    '<path d="M12 3.4l7.9 4.4v8.4L12 20.6l-7.9-4.4V7.8z"/><path d="M12 3.4l7.9 4.4L12 12.2 4.1 7.8z" fill="currentColor" fill-opacity="0.28"/>' +
    '<path d="M4.1 7.8L12 12.2l7.9-4.4"/><path d="M12 12.2v8.4"/>',
  plan:
    '<rect x="3.5" y="3.5" width="17" height="17" rx="3.4"/><path d="M3.5 10h6.6"/><path d="M10.1 3.5v3"/>' +
    '<path d="M10.1 10v2.6"/><path d="M13.9 20.5v-7.4h6.6"/>',
  ruler:
    '<path d="M3.6 15.3L15.3 3.6a1.6 1.6 0 0 1 2.3 0l2.8 2.8a1.6 1.6 0 0 1 0 2.3L8.7 20.4a1.6 1.6 0 0 1-2.3 0L3.6 17.6a1.6 1.6 0 0 1 0-2.3z"/>' +
    '<path d="M7.2 11.7l2 2"/><path d="M10 8.9l1.4 1.4"/><path d="M12.8 6.1l2 2"/>',
  section:
    '<path d="M4 8.2L12 4l8 4.2v7.6L12 20l-8-4.2z" stroke-opacity=".55"/><path d="M3 12.1h18" stroke-dasharray="2.4 2.6"/>' +
    '<path d="M12 4v16" stroke-opacity=".55"/>',
  edges:
    '<path d="M7.4 5.5h9.2"/><path d="M7.4 18.5h9.2"/><path d="M5.5 7.4v9.2"/><path d="M18.5 7.4v9.2"/>' +
    '<circle cx="5.5" cy="5.5" r="1.7"/><circle cx="18.5" cy="5.5" r="1.7"/>' +
    '<circle cx="5.5" cy="18.5" r="1.7"/><circle cx="18.5" cy="18.5" r="1.7"/>',
  camera:
    '<path d="M4 8.6A2.6 2.6 0 0 1 6.6 6h1.1l1.3-2h6l1.3 2h1.1A2.6 2.6 0 0 1 20 8.6v7.8a2.6 2.6 0 0 1-2.6 2.6H6.6A2.6 2.6 0 0 1 4 16.4z"/>' +
    '<circle cx="12" cy="12.4" r="3.3"/>',
  contrast: '<circle cx="12" cy="12" r="8.4"/><path d="M12 3.6a8.4 8.4 0 0 1 0 16.8z" fill="currentColor"/>',
  ghost:
    '<path d="M6 19.6V11a6 6 0 0 1 12 0v8.6l-2.4-1.9-1.8 1.9-1.8-1.9-1.8 1.9-1.8-1.9z"/>' +
    '<circle cx="9.8" cy="11" r="0.9" fill="currentColor"/><circle cx="14.2" cy="11" r="0.9" fill="currentColor"/>',
  sun:
    '<circle cx="12" cy="12" r="3.4"/><path d="M12 3.8v2.4"/><path d="M12 17.8v2.4"/><path d="M3.8 12h2.4"/><path d="M17.8 12h2.4"/>' +
    '<path d="M6.2 6.2l1.7 1.7"/><path d="M16.1 16.1l1.7 1.7"/><path d="M17.8 6.2l-1.7 1.7"/><path d="M7.9 16.1l-1.7 1.7"/>',
  plus: '<path d="M12 5.2v13.6"/><path d="M5.2 12h13.6"/>',
  minus: '<path d="M5.2 12h13.6"/>',
  'chevron-up': '<path d="M6.5 14.6L12 9.1l5.5 5.5"/>',
  'chevron-down': '<path d="M6.5 9.4l5.5 5.5 5.5-5.5"/>',
  'chevron-left': '<path d="M14.6 6.5L9.1 12l5.5 5.5"/>',
  'chevron-right': '<path d="M9.4 6.5l5.5 5.5-5.5 5.5"/>',
  'arrow-right': '<path d="M5 12h14"/><path d="M13.2 6.2L19 12l-5.8 5.8"/>',
  x: '<path d="M6.2 6.2l11.6 11.6"/><path d="M17.8 6.2L6.2 17.8"/>',
  trash:
    '<path d="M4.6 7h14.8"/><path d="M9.6 7V4.9a1.1 1.1 0 0 1 1.1-1.1h2.6a1.1 1.1 0 0 1 1.1 1.1V7"/>' +
    '<path d="M6.5 7l.8 11.3a2 2 0 0 0 2 1.9h5.4a2 2 0 0 0 2-1.9L17.5 7"/><path d="M10 11v5"/><path d="M14 11v5"/>',
  upload:
    '<path d="M12 15.4V4.6"/><path d="M7.6 8.9L12 4.5l4.4 4.4"/><path d="M4.6 14.8v2.7a2 2 0 0 0 2 2h10.8a2 2 0 0 0 2-2v-2.7"/>',
  download:
    '<path d="M12 4.6v10.8"/><path d="M7.6 11l4.4 4.4 4.4-4.4"/><path d="M4.6 14.8v2.7a2 2 0 0 0 2 2h10.8a2 2 0 0 0 2-2v-2.7"/>',
  copy:
    '<rect x="8.5" y="8.5" width="11" height="11" rx="3"/><path d="M15.5 8.5V7A2.5 2.5 0 0 0 13 4.5H7A2.5 2.5 0 0 0 4.5 7v6A2.5 2.5 0 0 0 7 15.5h1.5"/>',
  check: '<path d="M5 12.6l4.5 4.5L19 7.6"/>',
  laser:
    '<circle cx="12" cy="12" r="2.3" fill="currentColor"/><path d="M12 3.4v3.6"/><path d="M12 17v3.6"/><path d="M3.4 12H7"/><path d="M17 12h3.6"/>',
  move:
    '<path d="M12 3.5v17"/><path d="M3.5 12h17"/><path d="M9.2 6.3L12 3.5l2.8 2.8"/><path d="M9.2 17.7L12 20.5l2.8-2.8"/>' +
    '<path d="M6.3 9.2L3.5 12l2.8 2.8"/><path d="M17.7 9.2l2.8 2.8-2.8 2.8"/>',
  pin: '<path d="M12 20.8s6.4-5.4 6.4-10.8a6.4 6.4 0 1 0-12.8 0c0 5.4 6.4 10.8 6.4 10.8z"/><circle cx="12" cy="10" r="2.3"/>',
  globe:
    '<circle cx="12" cy="12" r="8.6"/><path d="M3.4 12h17.2"/>' +
    '<path d="M12 3.4c2.4 2.4 3.6 5.3 3.6 8.6s-1.2 6.2-3.6 8.6c-2.4-2.4-3.6-5.3-3.6-8.6S9.6 5.8 12 3.4z"/>',
  building:
    '<path d="M5 20.6V5.6A1.6 1.6 0 0 1 6.6 4h6.8A1.6 1.6 0 0 1 15 5.6v15"/><path d="M15 10h3.4a1.6 1.6 0 0 1 1.6 1.6v9"/>' +
    '<path d="M3.5 20.6h17"/><path d="M8.4 8h3.2"/><path d="M8.4 12h3.2"/><path d="M8.4 16h3.2"/>',
  calendar:
    '<rect x="4" y="5.4" width="16" height="14.6" rx="3.6"/><path d="M4 10.4h16"/><path d="M8.6 3.4v3.8"/><path d="M15.4 3.4v3.8"/>',
  refresh: '<path d="M19.6 12a7.6 7.6 0 1 1-2.5-5.6"/><path d="M19.6 4.6V9h-4.4"/>',
  link:
    '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  users:
    '<circle cx="9" cy="8.6" r="3.2"/><path d="M3.4 19.6a5.6 5.6 0 0 1 11.2 0"/>' +
    '<circle cx="17.2" cy="9.4" r="2.4"/><path d="M16.6 14.3a4.6 4.6 0 0 1 4.4 4.7"/>',
  play: '<path d="M8.2 5.6v12.8a.6.6 0 0 0 .9.5l10.2-6.4a.6.6 0 0 0 0-1L9.1 5.1a.6.6 0 0 0-.9.5z"/>',
  stop: '<rect x="6.4" y="6.4" width="11.2" height="11.2" rx="2.8"/>',
  file:
    '<path d="M7 3.6h6.6L19 9v10a1.5 1.5 0 0 1-1.5 1.5H7A1.5 1.5 0 0 1 5.5 19V5.1A1.5 1.5 0 0 1 7 3.6z"/><path d="M13.6 3.6V9H19"/>',
  pencil: '<path d="M4 20l1.1-4.2L16.6 4.3a2.1 2.1 0 0 1 3 3L8.1 18.9z"/><path d="M14.7 6.2l3 3"/>',
  alert: '<path d="M12 4.2l9 15.6H3z"/><path d="M12 10.2v4.2"/><circle cx="12" cy="17.1" r="0.55" fill="currentColor"/>',
  filter: '<path d="M4 5.6h16l-6.2 7.2v5.6l-3.6 1.6v-7.2z"/>',
  grid: '<rect x="4" y="4" width="6.6" height="6.6" rx="2"/><rect x="13.4" y="4" width="6.6" height="6.6" rx="2"/><rect x="4" y="13.4" width="6.6" height="6.6" rx="2"/><rect x="13.4" y="13.4" width="6.6" height="6.6" rx="2"/>',
  dot: '<circle cx="12" cy="12" r="3" fill="currentColor"/>',
  list: '<path d="M8.6 6.6H20"/><path d="M8.6 12H20"/><path d="M8.6 17.4H20"/><circle cx="4.7" cy="6.6" r="0.8" fill="currentColor"/><circle cx="4.7" cy="12" r="0.8" fill="currentColor"/><circle cx="4.7" cy="17.4" r="0.8" fill="currentColor"/>',
  crosshair: '<circle cx="12" cy="12" r="7.6"/><path d="M12 2.8v4.4"/><path d="M12 16.8v4.4"/><path d="M2.8 12h4.4"/><path d="M16.8 12h4.4"/>',
  key: '<circle cx="8.2" cy="15.8" r="3.8"/><path d="M11 13l8.4-8.4"/><path d="M16 8l2.6 2.6"/><path d="M13.4 10.6l1.8 1.8"/>',
  keyboard:
    '<rect x="3" y="6" width="18" height="12" rx="3.2"/><path d="M7 10h.01"/><path d="M11 10h.01"/><path d="M15 10h.01"/><path d="M8 14h8"/>',
  mail: '<rect x="3.5" y="5.5" width="17" height="13" rx="3.6"/><path d="M4.6 8.4l7.4 5 7.4-5"/>',
  phone:
    '<path d="M7.6 3.8h2.1l1.4 3.7-1.8 1.4a10.6 10.6 0 0 0 5.3 5.3l1.4-1.8 3.7 1.4v2.1a2.1 2.1 0 0 1-2.3 2.1A14.9 14.9 0 0 1 5.5 6.1a2.1 2.1 0 0 1 2.1-2.3z"/>',
  'id-card':
    '<rect x="3.5" y="5.5" width="17" height="13" rx="3.6"/><circle cx="9" cy="11" r="1.9"/><path d="M6.2 15.6a3.1 3.1 0 0 1 5.6 0"/>' +
    '<path d="M14.2 10h3.4"/><path d="M14.2 13.4h3.4"/>',
  external:
    '<path d="M13.2 4.8h6v6"/><path d="M19.2 4.8l-8 8"/><path d="M17.4 14.4v2.3a2.6 2.6 0 0 1-2.6 2.6H7.3a2.6 2.6 0 0 1-2.6-2.6V9.2a2.6 2.6 0 0 1 2.6-2.6h2.3"/>',
};

const TEMPLATES = new Map();

function template(name) {
  let t = TEMPLATES.get(name);
  if (!t) {
    const inner = PATHS[name] ?? PATHS.dot;
    t = document.createElement('template');
    t.innerHTML =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
      inner +
      '</svg>';
    TEMPLATES.set(name, t);
  }
  return t;
}

export function hasIcon(name) {
  return name in PATHS;
}

// Devuelve un <svg> nuevo. size en px (cuadrado).
export function icon(name, { size = 18, className = '', strokeWidth = null } = {}) {
  const el = template(name).content.firstElementChild.cloneNode(true);
  el.setAttribute('width', String(size));
  el.setAttribute('height', String(size));
  el.classList.add('icon');
  if (name) el.classList.add(`icon-${name}`);
  if (className) for (const c of className.split(/\s+/).filter(Boolean)) el.classList.add(c);
  if (strokeWidth != null) el.setAttribute('stroke-width', String(strokeWidth));
  return el;
}

// Logo del visor: cuadrado amarillo con dos bloques negros escalonados (edificio abstracto).
export function logo({ size = 44, className = '' } = {}) {
  const t = document.createElement('template');
  t.innerHTML =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="${size}" height="${size}" role="img" aria-label="Visor IFC 5D">` +
    '<rect width="64" height="64" rx="17" fill="#FFC21A"/>' +
    '<rect x="12" y="11" width="22" height="26" rx="6.5" fill="#1B1B1B"/>' +
    '<rect x="30" y="27" width="22" height="26" rx="6.5" fill="#1B1B1B"/>' +
    '<rect x="30" y="27" width="4.5" height="10" fill="#FFC21A"/>' +
    '<circle cx="45" cy="19" r="4.2" fill="#FF6A13"/>' +
    '</svg>';
  const el = t.content.firstElementChild;
  if (className) el.setAttribute('class', className);
  return el;
}
