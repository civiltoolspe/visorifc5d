// Servidor estático mínimo para desarrollo/pruebas aisladas de módulos del cliente
// (no implementa la API ni el WebSocket; para eso usar server/index.js).
// Uso: node tests/devserver.mjs [puerto]   → sirve public/ y /vendor/* igual que el servidor real.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NM = path.join(ROOT, 'node_modules');
const MOUNTS = [
  ['/vendor/three/', path.join(NM, 'three')],
  ['/vendor/web-ifc/', path.join(NM, 'web-ifc')],
  ['/vendor/three-mesh-bvh/', path.join(NM, 'three-mesh-bvh')],
  ['/vendor/camera-controls/', path.join(NM, 'camera-controls')],
  ['/vendor/dxf-parser/', path.join(NM, 'dxf-parser', 'dist')],
  ['/vendor/libredwg-web/', path.join(NM, '@mlightcad', 'libredwg-web')],
  ['/vendor/fonts/urbanist/', path.join(NM, '@fontsource', 'urbanist')],
  ['/fixtures/', path.join(ROOT, 'tests', 'fixtures')],
  ['/', path.join(ROOT, 'public')],
];
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.wasm': 'application/wasm',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.webp': 'image/webp', '.ifc': 'application/octet-stream', '.dxf': 'application/octet-stream', '.dwg': 'application/octet-stream',
};

export function startDevServer(port = 0) {
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    for (const [prefix, dir] of MOUNTS) {
      if (!url.startsWith(prefix)) continue;
      let file = path.join(dir, url.slice(prefix.length));
      if (!file.startsWith(dir)) break;
      if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
      if (!fs.existsSync(file)) continue;
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
      return;
    }
    res.writeHead(404); res.end('not found');
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const s = await startDevServer(Number(process.argv[2] || 8099));
  console.log(`devserver en http://127.0.0.1:${s.address().port}/`);
}
