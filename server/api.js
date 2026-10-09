// API REST (/api): información del servidor y gestión de modelos.
//
//   GET    /api/info
//   GET    /api/models
//   POST   /api/models            (presentador) multipart, campo "file"
//   GET    /api/models/:id/file
//   PATCH  /api/models/:id        (presentador) { name?, georef?, cad? }
//   DELETE /api/models/:id        (presentador)
//   GET    /api/views             vistas guardadas -> { items }
//   PUT    /api/views             (presentador) { items } reemplaza la lista -> { items }
//
// Los errores se devuelven como { error: 'mensaje' } con el código HTTP adecuado.

import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import multer from 'multer';
import { HttpError } from './errors.js';
import { isValidId, kindFromName, renombrar, sanitizeFileName, validateViews } from './models.js';
import { lanUrls } from './net.js';
import { normalizeIp } from './roles.js';

const METODOS_SEGUROS = new Set(['GET', 'HEAD', 'OPTIONS']);
const MENSAJES_ESTADO = {
  400: 'Petición no válida',
  403: 'Acceso denegado',
  404: 'No encontrado',
  405: 'Método no permitido',
  416: 'Rango solicitado no satisfacible',
};

// Defensa contra peticiones entre sitios (CSRF): si el navegador envía Origin, debe coincidir con Host.
export function origenPermitido(req) {
  const origin = req.headers.origin;
  if (origin === undefined) return true; // clientes que no son navegadores
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

// Cabecera Content-Disposition con el nombre original (ASCII de respaldo + RFC 5987).
export function contentDisposition(nombre) {
  const ascii = nombre.replace(/[^\x20-\x7e]|["\\%;]/g, '_');
  const utf8 = encodeURIComponent(nombre).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}

function traducirErrorMulter(err, maxUploadMb) {
  if (err instanceof HttpError) return err;
  if (err instanceof multer.MulterError) {
    switch (err.code) {
      case 'LIMIT_FILE_SIZE':
        return new HttpError(413, `El archivo supera el tamaño máximo permitido (${maxUploadMb} MB)`);
      case 'LIMIT_UNEXPECTED_FILE':
        return new HttpError(400, 'Campo de archivo inesperado: envía un único archivo en el campo "file"');
      case 'LIMIT_FILE_COUNT':
        return new HttpError(400, 'Solo se puede subir un archivo por petición');
      default:
        return new HttpError(400, 'Formulario de subida inválido');
    }
  }
  if (/multipart|boundary|unexpected end of form|malformed/i.test(err?.message || '')) {
    return new HttpError(400, 'Formulario multipart inválido');
  }
  return err;
}

// deps: { config, models, roles, hub, getPort }
export function createApiRouter({ config, models, roles, hub, getPort }) {
  const router = express.Router();

  // Todo lo de /api es dinámico: nunca se guarda en caché (excepto el archivo de modelo, que fija la suya).
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  // Las operaciones que modifican datos son solo para presentadores y del mismo origen.
  router.use((req, res, next) => {
    if (METODOS_SEGUROS.has(req.method)) return next();
    if (!origenPermitido(req)) return next(new HttpError(403, 'Origen no permitido'));
    if (roles.forRequest(req) !== 'presenter') {
      return next(new HttpError(403, 'Solo el presentador puede modificar los modelos'));
    }
    return next();
  });

  // ---------- Vistas guardadas ----------
  // Van antes del lector JSON general porque llevan miniaturas (límite propio, más holgado).
  router.get('/views', (req, res) => {
    res.json({ items: models.getViews() });
  });

  router.put('/views', express.json({ limit: '8mb' }), (req, res, next) => {
    const cuerpo = req.body;
    if (cuerpo === null || typeof cuerpo !== 'object' || Array.isArray(cuerpo)) {
      return next(new HttpError(400, 'El cuerpo debe ser un objeto JSON { items }'));
    }
    try {
      res.json({ items: models.setViews(validateViews(cuerpo.items)) });
      return undefined;
    } catch (err) {
      return next(err);
    }
  });

  router.use(express.json({ limit: '1mb' }));

  // ---------- Información ----------
  router.get('/info', (req, res) => {
    const port = getPort();
    res.json({
      role: roles.forRequest(req),
      clientIp: normalizeIp(req.socket.remoteAddress),
      lanUrls: lanUrls(port),
      port,
      version: config.version,
      presenterPinEnabled: roles.pinEnabled,
      viewerFreeNav: config.viewerFreeNav,
    });
  });

  // ---------- Lista ----------
  router.get('/models', (req, res) => {
    res.json(models.list());
  });

  // ---------- Subida ----------
  const maxBytes = Math.floor(config.maxUploadMb * 1024 * 1024);
  const subir = multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => cb(null, config.uploadsDir),
      filename: (req, file, cb) => cb(null, path.basename(models.tmpPath())),
    }),
    limits: { fileSize: maxBytes, files: 1, fields: 8, parts: 12 },
    defParamCharset: 'utf8', // nombres con tildes/ñ llegan en UTF-8
    fileFilter: (req, file, cb) => {
      const nombre = sanitizeFileName(file.originalname);
      if (!kindFromName(nombre)) {
        return cb(new HttpError(400, 'Formato no admitido: solo se aceptan archivos .ifc, .dxf y .dwg'));
      }
      return cb(null, true);
    },
  }).single('file');

  router.post('/models', (req, res, next) => {
    subir(req, res, (errSubida) => {
      if (errSubida) return next(traducirErrorMulter(errSubida, config.maxUploadMb));
      const archivo = req.file;
      if (!archivo) return next(new HttpError(400, 'Falta el archivo: envíalo en el campo "file" (multipart/form-data)'));
      const nombre = sanitizeFileName(archivo.originalname);
      const kind = kindFromName(nombre);
      let destino = null;
      try {
        if (!kind) throw new HttpError(400, 'Formato no admitido: solo se aceptan archivos .ifc, .dxf y .dwg');
        if (!archivo.size) throw new HttpError(400, 'El archivo está vacío');
        const id = models.newId();
        destino = models.filePath(id, kind);
        renombrar(archivo.path, destino);
        const registro = models.add({ id, name: nombre, kind, size: archivo.size });
        destino = null; // ya registrado: no se borra
        res.status(201).location(`/api/models/${registro.id}`).json(registro);
        hub.broadcastModels();
        return undefined;
      } catch (err) {
        for (const f of [archivo.path, destino]) {
          if (f) { try { fs.unlinkSync(f); } catch { /* ya no existe */ } }
        }
        return next(err);
      }
    });
  });

  // ---------- Descarga ----------
  router.get('/models/:id/file', (req, res, next) => {
    const registro = models.get(req.params.id);
    const archivo = registro ? models.pathOf(registro.id) : null;
    if (!registro || !archivo) return next(new HttpError(404, 'Modelo no encontrado'));
    let stat;
    try {
      stat = fs.statSync(archivo);
    } catch {
      return next(new HttpError(404, 'El archivo del modelo ya no existe en el servidor'));
    }
    // ETag fuerte: un id nunca cambia de contenido, pero se incluye tamaño y fecha por seguridad
    res.set({
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': contentDisposition(registro.name),
      ETag: `"${registro.id}-${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`,
      'Cache-Control': 'no-cache',
    });
    return res.sendFile(path.basename(archivo), {
      root: path.dirname(archivo),
      dotfiles: 'allow',
      cacheControl: false,
      lastModified: true,
      acceptRanges: true,
    }, (err) => {
      if (!err || res.headersSent) return;
      next(err.code === 'ENOENT' ? new HttpError(404, 'El archivo del modelo ya no existe en el servidor') : err);
    });
  });

  // ---------- Modificación ----------
  router.patch('/models/:id', (req, res, next) => {
    if (!isValidId(req.params.id) || !models.get(req.params.id)) {
      return next(new HttpError(404, 'Modelo no encontrado'));
    }
    const cuerpo = req.body;
    if (cuerpo === null || typeof cuerpo !== 'object' || Array.isArray(cuerpo)) {
      return next(new HttpError(400, 'El cuerpo debe ser un objeto JSON { name?, georef?, cad? }'));
    }
    const parcial = {};
    for (const k of ['name', 'georef', 'cad']) {
      if (Object.prototype.hasOwnProperty.call(cuerpo, k)) parcial[k] = cuerpo[k];
    }
    try {
      const registro = models.update(req.params.id, parcial);
      res.json(registro);
      if (Object.keys(parcial).length) hub.broadcastModels();
      return undefined;
    } catch (err) {
      return next(err);
    }
  });

  // ---------- Eliminación ----------
  router.delete('/models/:id', (req, res, next) => {
    try {
      const eliminado = models.remove(req.params.id);
      if (!eliminado) return next(new HttpError(404, 'Modelo no encontrado'));
      res.status(204).end();
      hub.broadcastModels();
      return undefined;
    } catch (err) {
      return next(err);
    }
  });

  router.use((req, res, next) => next(new HttpError(404, 'Ruta de la API no encontrada')));

  return router;
}

// Manejador de errores final (JSON { error }).
export function manejadorErrores(log = () => {}) {
  // Express exige la firma de 4 argumentos para reconocer un manejador de errores
  // eslint-disable-next-line no-unused-vars
  return (err, req, res, next) => {
    let status = err.status || err.statusCode || 500;
    let mensaje = err.message;
    if (err.type === 'entity.parse.failed') {
      status = 400;
      mensaje = 'JSON inválido en el cuerpo de la petición';
    } else if (err.type === 'entity.too.large') {
      status = 413;
      mensaje = 'El cuerpo de la petición es demasiado grande';
    }
    if (!(err instanceof HttpError) && !err.type && status < 500) {
      // Errores de Express/send (rutas fuera de la carpeta, rangos inválidos...): mensaje en español
      mensaje = MENSAJES_ESTADO[status] || 'Petición no válida';
    }
    if (status >= 500) {
      log(`Error ${status} en ${req.method} ${req.originalUrl}: ${err.stack || err.message}`);
      mensaje = 'Error interno del servidor';
    }
    if (res.headersSent) return res.destroy();
    return res.status(status).json({ error: mensaje });
  };
}
