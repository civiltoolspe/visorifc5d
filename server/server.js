// Ensamblado del servidor: Express (estáticos + API) y WebSocket sobre el mismo puerto.
import http from 'node:http';
import path from 'node:path';
import express from 'express';
import { createApiRouter, manejadorErrores, origenPermitido } from './api.js';
import { vendorMounts } from './config.js';
import { HttpError } from './errors.js';
import { HostGuard } from './hosts.js';
import { PresentationHub } from './hub.js';
import { ModelStore } from './models.js';
import { RoleResolver } from './roles.js';

// Tipos MIME que importan al navegador (módulos ES y WebAssembly).
function fijarTipos(res, archivo) {
  const ext = path.extname(archivo).toLowerCase();
  if (ext === '.wasm') res.setHeader('Content-Type', 'application/wasm');
  else if (ext === '.js' || ext === '.mjs' || ext === '.cjs') res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
}

function rechazarUpgrade(socket, codigo, texto) {
  socket.on('error', () => {});
  socket.write(`HTTP/1.1 ${codigo} ${texto}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

export function createServer(config, { log = console.log } = {}) {
  const roles = new RoleResolver({ pin: config.presenterPin });
  const models = new ModelStore({ uploadsDir: config.uploadsDir, sessionFile: config.sessionFile, log });
  models.load();

  const server = http.createServer();
  const hub = new PresentationHub({ config, roles, models, log });
  const getPort = () => server.address()?.port ?? config.port;

  // Solo se atienden Host conocidos (IPs, localhost, nombre de la PC, ALLOWED_HOSTS): evita el DNS rebinding
  const hostGuard = new HostGuard({ extra: config.allowedHosts });
  const hostsAvisados = new Set();
  const hostPermitido = (host) => {
    if (hostGuard.allows(host)) return true;
    const visto = String(host).slice(0, 80);
    if (hostsAvisados.size < 50 && !hostsAvisados.has(visto)) {
      hostsAvisados.add(visto);
      log(`Petición rechazada: la cabecera Host "${visto}" no está permitida. Si es un nombre legítimo de esta PC, añádelo a ALLOWED_HOSTS.`);
    }
    return false;
  };

  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    if (hostPermitido(req.headers.host)) return next();
    return next(new HttpError(403, 'Dirección de acceso no permitida: abre el visor con localhost, la IP de la PC anfitriona o un nombre incluido en ALLOWED_HOSTS'));
  });
  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    next();
  });

  app.use('/api', createApiRouter({ config, models, roles, hub, getPort }));

  // Dependencias del cliente (caché de 1 día; se revalidan por ETag después)
  for (const [montaje, carpeta] of vendorMounts(config.root)) {
    app.use(montaje, express.static(carpeta, { maxAge: '1d', index: false, setHeaders: fijarTipos }));
  }

  // Aplicación: siempre revalidar (ETag) para que los espectadores no usen código viejo
  app.use(express.static(config.publicDir, {
    cacheControl: false,
    setHeaders: (res, archivo) => {
      res.setHeader('Cache-Control', 'no-cache');
      fijarTipos(res, archivo);
    },
  }));

  app.use((req, res, next) => next(Object.assign(new Error('No encontrado'), { status: 404 })));
  app.use(manejadorErrores(log));

  server.on('request', app);
  // Las subidas de modelos grandes pueden tardar más de los 5 min por defecto
  server.requestTimeout = 0;

  server.on('upgrade', (req, socket, head) => {
    let pathname = '';
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch {
      return rechazarUpgrade(socket, 400, 'Bad Request');
    }
    if (!hostPermitido(req.headers.host)) return rechazarUpgrade(socket, 403, 'Forbidden');
    if (pathname !== '/ws') return rechazarUpgrade(socket, 404, 'Not Found');
    if (!origenPermitido(req)) return rechazarUpgrade(socket, 403, 'Forbidden');
    try {
      return hub.handleUpgrade(req, socket, head);
    } catch (err) {
      log(`Error en la mejora a WebSocket: ${err.message}`);
      return rechazarUpgrade(socket, 400, 'Bad Request');
    }
  });

  return {
    app,
    server,
    hub,
    models,
    roles,
    config,
    get port() {
      return getPort();
    },
    start() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(config.port, config.host, () => {
          server.off('error', reject);
          resolve(getPort());
        });
      });
    },
    stop() {
      return new Promise((resolve) => {
        if (!server.listening) {
          hub.close();
          resolve();
          return;
        }
        const temporizador = setTimeout(() => server.closeAllConnections?.(), 2500);
        temporizador.unref?.();
        server.close(() => {
          clearTimeout(temporizador);
          resolve();
        });
        hub.close();
        server.closeIdleConnections?.();
      });
    },
  };
}
