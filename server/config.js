// Configuración del servidor a partir de variables de entorno.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseHostList } from './hosts.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const FALSOS = new Set(['false', '0', 'no', 'off', 'n']);

function leerBooleano(valor, porDefecto) {
  if (valor === undefined || valor === null || String(valor).trim() === '') return porDefecto;
  return !FALSOS.has(String(valor).trim().toLowerCase());
}

function leerNumero(valor, porDefecto, { min = -Infinity, max = Infinity } = {}) {
  if (valor === undefined || valor === null || String(valor).trim() === '') return porDefecto;
  const n = Number(valor);
  if (!Number.isFinite(n) || n < min || n > max) return porDefecto;
  return n;
}

function leerVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    return String(pkg.version || '0.0.0');
  } catch {
    return '0.0.0';
  }
}

// Montajes de /vendor/* exactamente como el contrato (docs/ARQUITECTURA.md, sección 4).
export function vendorMounts(root = ROOT) {
  const nm = path.join(root, 'node_modules');
  return [
    ['/vendor/three', path.join(nm, 'three')],
    ['/vendor/web-ifc', path.join(nm, 'web-ifc')],
    ['/vendor/three-mesh-bvh', path.join(nm, 'three-mesh-bvh')],
    ['/vendor/camera-controls', path.join(nm, 'camera-controls')],
    ['/vendor/dxf-parser', path.join(nm, 'dxf-parser', 'dist')],
    ['/vendor/libredwg-web', path.join(nm, '@mlightcad', 'libredwg-web')],
    ['/vendor/fonts/urbanist', path.join(nm, '@fontsource', 'urbanist')],
  ];
}

// Lee la configuración desde un objeto de entorno (por defecto process.env).
export function loadConfig(env = process.env) {
  const dataDir = env.DATA_DIR && env.DATA_DIR.trim()
    ? path.resolve(env.DATA_DIR.trim())
    : path.join(ROOT, 'data');
  const pin = (env.PRESENTER_PIN || '').trim();
  return {
    root: ROOT,
    publicDir: path.join(ROOT, 'public'),
    host: (env.HOST || '0.0.0.0').trim() || '0.0.0.0',
    port: leerNumero(env.PORT, 8080, { min: 0, max: 65535 }),
    presenterPin: pin || null,
    // Nombres de host adicionales aceptados en la cabecera Host (ver server/hosts.js); IPs y localhost siempre se aceptan
    allowedHosts: parseHostList(env.ALLOWED_HOSTS),
    viewerFreeNav: leerBooleano(env.VIEWER_FREE_NAV, true),
    maxUploadMb: leerNumero(env.MAX_UPLOAD_MB, 2048, { min: 0.001 }),
    dataDir,
    uploadsDir: path.join(dataDir, 'uploads'),
    sessionFile: path.join(dataDir, 'session.json'),
    // Intervalo del latido ping/pong de WebSocket (ms). 30 s por defecto; solo se cambia en pruebas.
    heartbeatMs: leerNumero(env.WS_HEARTBEAT_MS, 30000, { min: 50 }),
    version: leerVersion(),
  };
}
