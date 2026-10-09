// Visor IFC 5D - servidor local (Express 5 + WebSocket).
// Uso: npm start   (o: node server/index.js)
//
// Variables de entorno: PORT (8080), HOST (0.0.0.0), PRESENTER_PIN, VIEWER_FREE_NAV (true),
// MAX_UPLOAD_MB (2048), DATA_DIR (./data), ALLOWED_HOSTS (nombres de host extra aceptados, separados por comas).

import { loadConfig } from './config.js';
import { bannerArranque } from './net.js';
import { createServer } from './server.js';

const config = loadConfig();
let visor;

try {
  visor = createServer(config, { log: (m) => console.log(m) });
  await visor.start();
} catch (err) {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  No se pudo iniciar: el puerto ${config.port} ya está en uso.`);
    console.error('  Cierra el otro programa o elige otro puerto, por ejemplo:');
    console.error('    Windows (PowerShell):  $env:PORT=8081; npm start');
    console.error('    Linux / macOS:         PORT=8081 npm start\n');
  } else if (err.code === 'EACCES' || err.code === 'EPERM') {
    console.error(`\n  No se pudo iniciar: sin permiso (${err.syscall || 'acceso'} ${err.path || `puerto ${config.port}`}).\n`);
  } else {
    console.error(`\n  No se pudo iniciar el servidor: ${err.message}`);
    console.error(`  Carpeta de datos: ${config.dataDir}\n`);
  }
  process.exit(1);
}

console.log(bannerArranque({
  port: visor.port,
  host: config.host,
  version: config.version,
  dataDir: config.dataDir,
  pinEnabled: !!config.presenterPin,
  viewerFreeNav: config.viewerFreeNav,
  maxUploadMb: config.maxUploadMb,
  allowedHosts: config.allowedHosts,
}));

let cerrando = false;
async function apagar(senal) {
  if (cerrando) return;
  cerrando = true;
  console.log(`\n  Cerrando el servidor (${senal})...`);
  // Si algo impide el cierre limpio, se fuerza la salida a los 5 s
  setTimeout(() => process.exit(0), 5000).unref();
  try {
    await visor.stop();
  } catch (err) {
    console.error(`  Error al cerrar: ${err.message}`);
  }
  console.log('  Servidor detenido.');
  process.exit(0);
}

process.on('SIGINT', () => apagar('SIGINT'));
process.on('SIGTERM', () => apagar('SIGTERM'));
if (process.platform === 'win32') process.on('SIGBREAK', () => apagar('SIGBREAK'));
process.on('unhandledRejection', (err) => {
  console.error('  Promesa rechazada sin manejar:', err);
});
