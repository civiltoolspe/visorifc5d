// Registro de modelos subidos (IFC / DXF / DWG) con persistencia en disco.
//
// Archivos:  <DATA_DIR>/uploads/<id>.<ext>
// Registro:  <DATA_DIR>/session.json  (escritura atómica: temporal + rename)
//
// ModelRecord:
//   { id, name, kind: 'ifc'|'dxf'|'dwg', size, uploadedAt, georef: null|{...}, cad: null|{ units } }

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { HttpError } from './errors.js';

export const ID_RE = /^[a-z0-9]{10}$/;
export const KINDS = ['ifc', 'dxf', 'dwg'];
export const CAD_UNITS = ['auto', 'mm', 'cm', 'm', 'in', 'ft'];
const ALFABETO = 'abcdefghijklmnopqrstuvwxyz0123456789';
const NOMBRE_MAX = 200;

export class ValidationError extends HttpError {
  constructor(message, status = 400) {
    super(status, message);
    this.name = 'ValidationError';
  }
}

// En Windows un antivirus o el indexador pueden bloquear un archivo unos milisegundos:
// rename se reintenta unas pocas veces antes de fallar.
export function renombrar(origen, destino) {
  for (let intento = 0; ; intento += 1) {
    try {
      fs.renameSync(origen, destino);
      return;
    } catch (err) {
      if (intento >= 4 || !['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30 * (intento + 1));
    }
  }
}

// ---------- Validaciones ----------

export function isValidId(id) {
  return typeof id === 'string' && ID_RE.test(id);
}

// Extensión permitida (insensible a mayúsculas) -> 'ifc' | 'dxf' | 'dwg' | null
export function kindFromName(name) {
  const ext = path.extname(String(name || '')).toLowerCase().slice(1);
  return KINDS.includes(ext) ? ext : null;
}

// Deja solo el nombre base: sin rutas, sin caracteres de control, longitud acotada.
export function sanitizeFileName(raw) {
  let n = String(raw ?? '');
  try { n = n.normalize('NFC'); } catch { /* cadena no normalizable: se deja tal cual */ }
  n = n.replace(/[\u0000-\u001f\u007f]/g, '');
  n = n.split(/[\\/]/).pop() || '';
  n = n.trim();
  if (n.length > NOMBRE_MAX) {
    const ext = path.extname(n);
    n = n.slice(0, NOMBRE_MAX - ext.length) + ext;
  }
  return n;
}

function numeroFinito(v, campo) {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new ValidationError(`georef.${campo} debe ser un número finito`);
  }
  return v;
}

// Valida la sobrescritura manual de georreferencia y devuelve el objeto normalizado.
// eastings y northings son obligatorios; height=0, rotationDeg=0 y scale=1 por defecto.
export function validateGeoref(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError('georef debe ser un objeto { eastings, northings, height, rotationDeg, scale } o null');
  }
  if (value.eastings === undefined || value.northings === undefined) {
    throw new ValidationError('georef requiere eastings y northings');
  }
  const eastings = numeroFinito(value.eastings, 'eastings');
  const northings = numeroFinito(value.northings, 'northings');
  const height = numeroFinito(value.height === undefined ? 0 : value.height, 'height');
  const rotationDeg = numeroFinito(value.rotationDeg === undefined ? 0 : value.rotationDeg, 'rotationDeg');
  const scale = numeroFinito(value.scale === undefined ? 1 : value.scale, 'scale');
  if (Math.abs(eastings) > 1e9 || Math.abs(northings) > 1e9) {
    throw new ValidationError('georef: las coordenadas están fuera de rango');
  }
  if (Math.abs(height) > 1e7) throw new ValidationError('georef.height está fuera de rango');
  if (Math.abs(rotationDeg) > 3600) throw new ValidationError('georef.rotationDeg está fuera de rango');
  if (!(scale > 0) || scale > 1e6) throw new ValidationError('georef.scale debe ser mayor que 0');
  return { eastings, northings, height, rotationDeg, scale };
}

// Valida las opciones de un DXF/DWG: { units } con unidades de la lista permitida.
export function validateCad(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError('cad debe ser un objeto { units } o null');
  }
  const units = value.units === undefined ? 'auto' : value.units;
  if (!CAD_UNITS.includes(units)) {
    throw new ValidationError(`cad.units debe ser uno de: ${CAD_UNITS.join(', ')}`);
  }
  return { units };
}

export function validateName(value) {
  if (typeof value !== 'string') throw new ValidationError('name debe ser un texto');
  const n = sanitizeFileName(value);
  if (!n) throw new ValidationError('name no puede estar vacío');
  return n;
}

// ---------- Vistas guardadas ----------
// Vista = { id, name, camera, state, thumb }: la crea el presentador desde la pestaña Vistas (ver actions.saveView).
// El servidor las guarda en session.json para que sobrevivan a recargas de página y reinicios.

export const MAX_VIEWS = 60;
const VIEW_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const VIEW_STATE_KEYS = ['visibility', 'display', 'storey', 'section', 'selection', 'models', 'cad'];
const VIEW_NAME_MAX = 120;
const VIEW_THUMB_MAX = 200_000; // caracteres del data URL (una miniatura de 320x180 JPEG pesa ~20 000)
const VIEW_STATE_MAX = 300_000; // caracteres del JSON de state (la selección o lo oculto puede ser grande)
const THUMB_RE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]*$/;

function esObjeto(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function vector3(v, campo) {
  if (!Array.isArray(v) || v.length !== 3 || !v.every((n) => typeof n === 'number' && Number.isFinite(n))) {
    throw new ValidationError(`views: ${campo} debe ser [x, y, z] con números finitos`);
  }
  return [v[0], v[1], v[2]];
}

function validateViewCamera(cam) {
  if (!esObjeto(cam)) throw new ValidationError('views: camera debe ser un objeto');
  const projection = cam.projection === 'orthographic' ? 'orthographic' : 'perspective';
  const out = { position: vector3(cam.position, 'camera.position'), target: vector3(cam.target, 'camera.target'), projection };
  for (const k of ['zoom', 'fov']) {
    if (cam[k] === undefined) continue;
    if (typeof cam[k] !== 'number' || !Number.isFinite(cam[k])) throw new ValidationError(`views: camera.${k} debe ser un número finito`);
    out[k] = cam[k];
  }
  return out;
}

function validateViewState(state) {
  if (!esObjeto(state)) throw new ValidationError('views: state debe ser un objeto');
  const out = {};
  for (const k of VIEW_STATE_KEYS) {
    if (state[k] === undefined) continue;
    if (!esObjeto(state[k])) throw new ValidationError(`views: state.${k} debe ser un objeto`);
    out[k] = state[k];
  }
  if (JSON.stringify(out).length > VIEW_STATE_MAX) throw new ValidationError('views: el estado de una vista es demasiado grande');
  return out;
}

// Valida la lista de vistas y devuelve una copia normalizada (solo los campos conocidos).
export function validateViews(value) {
  if (!Array.isArray(value)) throw new ValidationError('items debe ser una lista de vistas');
  if (value.length > MAX_VIEWS) throw new ValidationError(`Se admiten como máximo ${MAX_VIEWS} vistas guardadas`);
  const ids = new Set();
  return value.map((raw) => {
    if (!esObjeto(raw)) throw new ValidationError('views: cada vista debe ser un objeto');
    if (typeof raw.id !== 'string' || !VIEW_ID_RE.test(raw.id)) throw new ValidationError('views: id de vista inválido');
    if (ids.has(raw.id)) throw new ValidationError('views: id de vista repetido');
    ids.add(raw.id);
    if (typeof raw.name !== 'string') throw new ValidationError('views: name debe ser un texto');
    const name = sanitizeFileName(raw.name.replace(/[\\/]/g, '-')).slice(0, VIEW_NAME_MAX) || 'Vista';
    let thumb = null;
    if (raw.thumb !== null && raw.thumb !== undefined) {
      if (typeof raw.thumb !== 'string' || raw.thumb.length > VIEW_THUMB_MAX || !THUMB_RE.test(raw.thumb)) {
        throw new ValidationError('views: thumb debe ser una imagen data URL pequeña');
      }
      thumb = raw.thumb;
    }
    return { id: raw.id, name, camera: validateViewCamera(raw.camera), state: validateViewState(raw.state), thumb };
  });
}

// ---------- Almacén ----------

export class ModelStore {
  constructor({ uploadsDir, sessionFile, log = () => {} }) {
    this.uploadsDir = uploadsDir;
    this.sessionFile = sessionFile;
    this.log = log;
    this._models = new Map(); // id -> record (orden de inserción = orden de subida)
    this._views = []; // vistas guardadas (ver validateViews)
  }

  // Crea carpetas, limpia restos de subidas interrumpidas y recarga session.json.
  load() {
    fs.mkdirSync(this.uploadsDir, { recursive: true });
    for (const f of fs.readdirSync(this.uploadsDir)) {
      if (f.startsWith('tmp-') && f.endsWith('.part')) {
        try { fs.unlinkSync(path.join(this.uploadsDir, f)); } catch { /* ya no existe */ }
      }
    }
    this._models.clear();
    this._views = [];
    let data = null;
    try {
      data = JSON.parse(fs.readFileSync(this.sessionFile, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') {
        const copia = `${this.sessionFile}.corrupto-${Date.now()}`;
        this.log(`Aviso: session.json ilegible (${err.message}); se guarda copia en ${copia}`);
        try { fs.renameSync(this.sessionFile, copia); } catch { /* sin copia */ }
      }
      return;
    }
    const lista = Array.isArray(data?.models) ? data.models : [];
    let ignorados = 0;
    for (const raw of lista) {
      const rec = this._normalizar(raw);
      if (rec) this._models.set(rec.id, rec);
      else ignorados += 1;
    }
    if (ignorados) this.log(`Aviso: ${ignorados} registro(s) de session.json se ignoraron (archivo inexistente o datos inválidos).`);
    if (data?.views !== undefined) {
      try {
        this._views = validateViews(data.views);
      } catch (err) {
        this.log(`Aviso: las vistas guardadas de session.json se ignoraron (${err.message}).`);
      }
    }
  }

  // ---------- Vistas guardadas ----------

  getViews() {
    return structuredClone(this._views);
  }

  // Reemplaza la lista completa (ya validada con validateViews) y la guarda en disco.
  setViews(items) {
    const antes = this._views;
    this._views = validateViews(items);
    try {
      this._guardar();
    } catch (err) {
      this._views = antes;
      throw err;
    }
    return this.getViews();
  }

  // Valida un registro leído de disco; devuelve null si hay que ignorarlo.
  _normalizar(raw) {
    if (!raw || typeof raw !== 'object') return null;
    if (!isValidId(raw.id) || this._models.has(raw.id)) return null;
    if (!KINDS.includes(raw.kind)) return null;
    const file = this.filePath(raw.id, raw.kind);
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      return null;
    }
    if (!stat.isFile()) return null;
    const subida = new Date(raw.uploadedAt);
    let georef = null;
    if (raw.kind === 'ifc' && raw.georef) {
      try { georef = validateGeoref(raw.georef); } catch { georef = null; }
    }
    let cad = null;
    if (raw.kind !== 'ifc') {
      try { cad = validateCad(raw.cad ?? {}); } catch { cad = { units: 'auto' }; }
    }
    return {
      id: raw.id,
      name: sanitizeFileName(raw.name) || `${raw.id}.${raw.kind}`,
      kind: raw.kind,
      size: stat.size,
      uploadedAt: Number.isNaN(subida.getTime()) ? stat.mtime.toISOString() : subida.toISOString(),
      georef,
      cad,
    };
  }

  // Ruta del archivo de un modelo. Solo acepta ids y tipos válidos (sin path traversal).
  filePath(id, kind) {
    if (!isValidId(id) || !KINDS.includes(kind)) throw new ValidationError('Identificador de modelo inválido', 404);
    return path.join(this.uploadsDir, `${id}.${kind}`);
  }

  // Ruta del archivo de un modelo existente, o null.
  pathOf(id) {
    const rec = isValidId(id) ? this._models.get(id) : null;
    return rec ? this.filePath(rec.id, rec.kind) : null;
  }

  newId() {
    for (;;) {
      let id = '';
      for (let i = 0; i < 10; i += 1) id += ALFABETO[crypto.randomInt(ALFABETO.length)];
      if (!this._models.has(id)) return id;
    }
  }

  tmpPath() {
    return path.join(this.uploadsDir, `tmp-${crypto.randomBytes(8).toString('hex')}.part`);
  }

  list() {
    return [...this._models.values()].map(clonar);
  }

  get(id) {
    const rec = isValidId(id) ? this._models.get(id) : null;
    return rec ? clonar(rec) : null;
  }

  // Registra un modelo cuyo archivo YA está en su ubicación definitiva.
  add({ id, name, kind, size }) {
    const rec = {
      id,
      name,
      kind,
      size,
      uploadedAt: new Date().toISOString(),
      georef: null,
      cad: kind === 'ifc' ? null : { units: 'auto' },
    };
    this._models.set(id, rec);
    try {
      this._guardar();
    } catch (err) {
      this._models.delete(id);
      throw err;
    }
    return clonar(rec);
  }

  // Aplica { name?, georef?, cad? }. Valida todo antes de modificar nada.
  update(id, partial) {
    const rec = isValidId(id) ? this._models.get(id) : null;
    if (!rec) return null;
    const cambios = {};
    if (partial.name !== undefined) cambios.name = validateName(partial.name);
    if (partial.georef !== undefined) {
      if (rec.kind !== 'ifc') throw new ValidationError('La georreferenciación manual solo aplica a modelos IFC');
      cambios.georef = partial.georef === null ? null : validateGeoref(partial.georef);
    }
    if (partial.cad !== undefined) {
      if (rec.kind === 'ifc') throw new ValidationError('Las opciones CAD solo aplican a modelos DXF/DWG');
      cambios.cad = partial.cad === null ? { units: 'auto' } : validateCad(partial.cad);
    }
    const antes = clonar(rec);
    Object.assign(rec, cambios);
    try {
      this._guardar();
    } catch (err) {
      this._models.set(id, antes);
      throw err;
    }
    return clonar(rec);
  }

  // Elimina el registro y su archivo. Devuelve el registro eliminado o null.
  remove(id) {
    const rec = isValidId(id) ? this._models.get(id) : null;
    if (!rec) return null;
    this._models.delete(id);
    try {
      this._guardar();
    } catch (err) {
      this._models.set(id, rec);
      throw err;
    }
    try {
      fs.unlinkSync(this.filePath(rec.id, rec.kind));
    } catch (err) {
      if (err.code !== 'ENOENT') this.log(`Aviso: no se pudo borrar el archivo de ${id}: ${err.message}`);
    }
    return clonar(rec);
  }

  // Escritura atómica: archivo temporal en la misma carpeta + rename.
  _guardar() {
    fs.mkdirSync(path.dirname(this.sessionFile), { recursive: true });
    const tmp = `${this.sessionFile}.${process.pid}.tmp`;
    const contenido = JSON.stringify({ version: 1, savedAt: new Date().toISOString(), models: [...this._models.values()], views: this._views }, null, 2);
    let fd = null;
    try {
      fd = fs.openSync(tmp, 'w');
      fs.writeSync(fd, contenido);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = null;
      renombrar(tmp, this.sessionFile);
    } catch (err) {
      if (fd !== null) { try { fs.closeSync(fd); } catch { /* ya cerrado */ } }
      try { fs.unlinkSync(tmp); } catch { /* no existe */ }
      throw err;
    }
  }
}

function clonar(rec) {
  return {
    id: rec.id,
    name: rec.name,
    kind: rec.kind,
    size: rec.size,
    uploadedAt: rec.uploadedAt,
    georef: rec.georef ? { ...rec.georef } : null,
    cad: rec.cad ? { ...rec.cad } : null,
  };
}
