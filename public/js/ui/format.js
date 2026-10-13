// Formato de números, fechas y tamaños (es-PE).

const LOCALE = 'es-PE';

const intFmt = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 0 });
const dateFmt = new Intl.DateTimeFormat(LOCALE, { day: '2-digit', month: '2-digit', year: 'numeric' });
const dateLongFmt = new Intl.DateTimeFormat(LOCALE, { day: 'numeric', month: 'short', year: 'numeric' });
const timeFmt = new Intl.DateTimeFormat(LOCALE, { hour: '2-digit', minute: '2-digit' });

export function formatInt(n) {
  return Number.isFinite(n) ? intFmt.format(n) : '—';
}

export function formatNumber(n, digits = 2) {
  if (!Number.isFinite(n)) return '—';
  return new Intl.NumberFormat(LOCALE, { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n);
}

// Hasta `max` decimales, sin ceros sobrantes (para valores de propiedades).
export function formatFlexible(n, max = 3) {
  if (!Number.isFinite(n)) return '—';
  return new Intl.NumberFormat(LOCALE, { maximumFractionDigits: max }).format(n);
}

// Coordenadas de mapa: sin separador de miles (279500.00), con decimales fijos.
export function formatCoord(n, digits = 2) {
  if (!Number.isFinite(n)) return '—';
  return new Intl.NumberFormat(LOCALE, { minimumFractionDigits: digits, maximumFractionDigits: digits, useGrouping: false }).format(n);
}

export function formatDate(date = new Date()) {
  return dateFmt.format(date);
}

export function formatDateLong(date = new Date()) {
  return dateLongFmt.format(date);
}

export function formatTime(date = new Date()) {
  return timeFmt.format(date);
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)} ${units[i]}`;
}

// Separa un número en parte entera y decimales para la tipografía de cifras grandes:
// splitDecimals(72.34, 2) -> { int: '72', dec: '.34' }
export function splitDecimals(n, digits = 2) {
  if (!Number.isFinite(n)) return { int: '—', dec: '' };
  const [i, d] = n.toFixed(digits).split('.');
  const intPart = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 0 }).format(Number(i));
  return { int: n < 0 && Number(i) === 0 ? `-${intPart}` : intPart, dec: d ? `.${d}` : '' };
}

export function pad2(n) {
  return String(n).padStart(2, '0');
}

// GlobalId corto (los 8 primeros caracteres) para tarjetas compactas.
export function shortGuid(guid) {
  if (!guid) return '—';
  return guid.length > 9 ? `${guid.slice(0, 8)}…` : guid;
}

export function formatMeters(n, digits = 2) {
  return Number.isFinite(n) ? `${formatNumber(n, digits)} m` : '—';
}

export function plural(n, one, many) {
  return n === 1 ? one : many;
}

// Valor de una propiedad IFC para mostrar.
export function formatPropValue(value) {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'boolean') return value ? 'Sí' : 'No';
  if (typeof value === 'number') return formatFlexible(value, 4);
  if (Array.isArray(value)) return value.map(formatPropValue).join(', ');
  if (typeof value === 'object') {
    if ('value' in value) return formatPropValue(value.value);
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

export function timestampForFile(date = new Date()) {
  const p = pad2;
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

// 0..1 -> '12 %'
export function formatPercent(v) {
  return Number.isFinite(v) ? `${Math.round(v * 100)} %` : '—';
}

// Posición de mapa que se muestra de una georreferencia IFC (resultado de ifc.getGeorefInfo):
//   - 'mapconversion' y 'manual': el origen de la conversión (Eastings / Northings / OrthogonalHeight).
//   - 'site': el archivo no trae conversión (sus coordenadas ya están en el mapa, p. ej. un IfcSite en UTM), así que
//     la conversión equivalente vale 0, 0, 0; lo útil para el usuario es dónde está el modelo: se muestra el punto de
//     referencia (`anchor`) con el que se coloca en el mapa.
// Devuelve { eastings, northings, height, fromAnchor } o null si no hay georreferencia.
export function georefPosition(info) {
  if (!info || info.source === 'none') return null;
  if (info.source === 'site' && info.anchor) {
    return { eastings: info.anchor.e, northings: info.anchor.n, height: info.anchor.h, fromAnchor: true };
  }
  return { eastings: info.eastings, northings: info.northings, height: info.height, fromAnchor: false };
}
