// Pruebas del servidor (API REST, WebSocket, roles, PIN, persistencia) y del cliente ApiClient.
// Uso: node tests/e2e/server.test.mjs   -> código de salida 0 si todo pasa, 1 si algo falla.
//
// Usa SOLO el puerto asignado (8101); los distintos servidores de prueba se arrancan en serie.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import nodeAssert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { FIXTURES, ROOT, assert, startServer } from './helpers.mjs';

const PORT = 8101;
const LOCAL = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ID_RE = /^[a-z0-9]{10}$/;

// IP no loopback de esta máquina (el servidor la verá como cliente "espectador")
const LAN_IP = Object.values(os.networkInterfaces()).flat()
  .find((n) => n && (n.family === 'IPv4' || n.family === 4) && !n.internal)?.address || null;
const LAN = LAN_IP ? `http://${LAN_IP}:${PORT}` : null;

const leerFixture = (rel) => fs.readFileSync(path.join(FIXTURES, rel));
const IFC4 = leerFixture('edificio_georef_ifc4.ifc');
const DXF = leerFixture('planta_georef.dxf');

// ---------------------------------------------------------------- mini ejecutor

const resultados = [];
let grupoActual = '';

async function prueba(nombre, fn, { requiereLan = false } = {}) {
  const etiqueta = `${grupoActual} > ${nombre}`;
  if (requiereLan && !LAN_IP) {
    resultados.push({ etiqueta, estado: 'omitida' });
    console.log(`  OMITIDA  ${nombre} (no hay IP de red no loopback)`);
    return;
  }
  const t0 = Date.now();
  try {
    await fn();
    resultados.push({ etiqueta, estado: 'ok' });
    console.log(`  OK       ${nombre} (${Date.now() - t0} ms)`);
  } catch (err) {
    resultados.push({ etiqueta, estado: 'fallo', err });
    console.log(`  FALLO    ${nombre}\n           ${String(err.message || err).split('\n').join('\n           ')}`);
  }
}

async function grupo(nombre, fn) {
  grupoActual = nombre;
  console.log(`\n${nombre}`);
  try {
    await fn();
  } catch (err) {
    resultados.push({ etiqueta: `${nombre} > (preparación)`, estado: 'fallo', err });
    console.log(`  FALLO    preparación del grupo\n           ${err.stack || err.message}`);
  }
}

// ---------------------------------------------------------------- servidores

async function puertoLibre(timeout = 6000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const ocupado = await new Promise((resolve) => {
      const s = net.connect(PORT, '127.0.0.1');
      s.once('connect', () => { s.destroy(); resolve(true); });
      s.once('error', () => resolve(false));
    });
    if (!ocupado) return;
    await sleep(100);
  }
  throw new Error(`El puerto ${PORT} sigue ocupado`);
}

// Detiene el servidor con SIGTERM y devuelve { code, log }.
async function detener(srv) {
  const salida = new Promise((resolve) => {
    if (srv.child.exitCode !== null) resolve(srv.child.exitCode);
    else srv.child.once('exit', (code) => resolve(code));
  });
  await srv.stop();
  const code = await Promise.race([salida, sleep(6000).then(() => 'timeout')]);
  await puertoLibre();
  return { code, log: srv.log() };
}

// Arranca un servidor con una carpeta de datos propia (opts.dataDir para reutilizarla).
async function conServidor({ env = {}, dataDir = null, conservar = false } = {}, fn) {
  await puertoLibre();
  const datos = dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'visor-srv-'));
  const srv = await startServer({ port: PORT, env: { DATA_DIR: datos, ...env } });
  srv.dataDir = datos;
  let salida;
  try {
    await fn(srv);
  } finally {
    cerrarClientesWs();
    salida = await detener(srv);
    if (!conservar) fs.rmSync(datos, { recursive: true, force: true });
  }
  return salida;
}

// ---------------------------------------------------------------- HTTP

function peticion({ host = '127.0.0.1', method = 'GET', path: ruta = '/', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host, port: PORT, method, path: ruta, headers, agent: false }, (res) => {
      const trozos = [];
      res.on('data', (d) => trozos.push(d));
      res.on('end', () => {
        const buf = Buffer.concat(trozos);
        resolve({ status: res.statusCode, headers: res.headers, buf, text: buf.toString('utf8') });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const json = (r) => JSON.parse(r.text);

async function subir(base, nombre, bytes, { headers = {}, campo = 'file' } = {}) {
  const form = new FormData();
  form.append(campo, new Blob([bytes]), nombre);
  return fetch(`${base}/api/models`, { method: 'POST', body: form, headers });
}

async function patch(base, id, cuerpo, { headers = {}, crudo = false } = {}) {
  return fetch(`${base}/api/models/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: crudo ? cuerpo : JSON.stringify(cuerpo),
  });
}

async function esperaError(promesa, status, trozoMensaje) {
  const r = await promesa;
  assert(r.status === status, `se esperaba HTTP ${status} y llegó ${r.status}`);
  const data = await r.json();
  assert(typeof data.error === 'string' && data.error.length > 0, 'la respuesta debe traer { error }');
  if (trozoMensaje) assert(data.error.includes(trozoMensaje), `el mensaje "${data.error}" debería incluir "${trozoMensaje}"`);
}

// ---------------------------------------------------------------- WebSocket

const clientesWs = new Set();
function cerrarClientesWs() {
  for (const c of clientesWs) { try { c.ws.terminate(); } catch { /* ya cerrado */ } }
  clientesWs.clear();
}

class ClienteWs {
  constructor(ws) {
    this.ws = ws;
    this.cola = [];
    this.cierre = null;
    ws.on('message', (data, esBinario) => {
      if (esBinario) return;
      this.cola.push(JSON.parse(data.toString('utf8')));
    });
    ws.on('close', (code) => { this.cierre = code; });
    ws.on('error', () => { /* los fallos se observan por el cierre o el timeout */ });
    clientesWs.add(this);
  }

  send(obj) { this.ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj)); }

  // Espera (y consume) el primer mensaje con t === tipo que cumpla `donde`.
  async espera(tipo, { donde = () => true, timeout = 3000 } = {}) {
    const t0 = Date.now();
    for (;;) {
      const i = this.cola.findIndex((m) => m.t === tipo && donde(m));
      if (i >= 0) return this.cola.splice(i, 1)[0];
      if (Date.now() - t0 > timeout) {
        throw new Error(`Tiempo agotado esperando "${tipo}" (cola: ${JSON.stringify(this.cola.map((m) => m.t))})`);
      }
      await sleep(15);
    }
  }

  // Comprueba que NO llega ningún mensaje de ese tipo durante `ms`.
  async noRecibe(tipo, ms = 250) {
    await sleep(ms);
    const m = this.cola.find((x) => x.t === tipo);
    if (m) throw new Error(`No se esperaba "${tipo}" y llegó: ${JSON.stringify(m).slice(0, 200)}`);
  }

  vaciar() { this.cola.length = 0; }
  cerrar() { this.ws.close(); }
}

async function conectarWs({ host = '127.0.0.1', name, wantRole, pin, headers, hello = true, ruta = '/ws', autoPong = true } = {}) {
  const opciones = {};
  if (headers) opciones.headers = headers;
  if (!autoPong) opciones.autoPong = false;
  const ws = new WebSocket(`ws://${host}:${PORT}${ruta}`, opciones);
  const cli = new ClienteWs(ws);
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
    ws.once('unexpected-response', (req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
  });
  if (hello) {
    const msg = { t: 'hello', name };
    if (wantRole) msg.wantRole = wantRole;
    if (pin !== undefined) msg.pin = pin;
    cli.send(msg);
    cli.welcome = await cli.espera('welcome');
    cli.id = cli.welcome.clientId;
  }
  return cli;
}

const lan = (opts = {}) => conectarWs({ host: LAN_IP, ...opts });

// ================================================================= PRUEBAS

await grupo('REST: información, estáticos y modelos', async () => {
  await conServidor({}, async (srv) => {
    await prueba('/api/info desde 127.0.0.1 es presentador', async () => {
      const r = await fetch(`${LOCAL}/api/info`);
      assert(r.status === 200, `estado ${r.status}`);
      assert(/application\/json/.test(r.headers.get('content-type')), 'debe ser JSON');
      const info = await r.json();
      nodeAssert.equal(info.role, 'presenter');
      nodeAssert.equal(info.clientIp, '127.0.0.1');
      nodeAssert.equal(info.port, PORT);
      nodeAssert.equal(typeof info.version, 'string');
      nodeAssert.equal(info.presenterPinEnabled, false);
      nodeAssert.equal(info.viewerFreeNav, true);
      assert(Array.isArray(info.lanUrls), 'lanUrls debe ser un arreglo');
      if (LAN_IP) assert(info.lanUrls.includes(`http://${LAN_IP}:${PORT}`), `lanUrls debe incluir la URL de red (${info.lanUrls})`);
      for (const u of info.lanUrls) assert(!u.includes('127.0.0.1'), 'lanUrls no debe incluir direcciones internas');
    });

    await prueba('el arranque imprime URL local, URL de red y aviso del firewall de Windows', async () => {
      const log = srv.log();
      assert(log.includes(`http://localhost:${PORT}`), 'falta la URL local');
      if (LAN_IP) assert(log.includes(`http://${LAN_IP}:${PORT}`), 'falta la URL de red');
      assert(/Firewall de\s+Windows/i.test(log) && log.includes('netsh'), 'falta el aviso del firewall');
    });

    await prueba('estáticos: public/ con no-cache + ETag y 304 al revalidar', async () => {
      const r = await peticion({ path: '/js/main.js' });
      nodeAssert.equal(r.status, 200);
      nodeAssert.equal(r.headers['cache-control'], 'no-cache');
      assert(/^text\/javascript/.test(r.headers['content-type']), `content-type ${r.headers['content-type']}`);
      assert(r.headers.etag, 'falta ETag');
      const r2 = await peticion({ path: '/js/main.js', headers: { 'If-None-Match': r.headers.etag } });
      nodeAssert.equal(r2.status, 304);
    });

    await prueba('estáticos: /vendor/* con caché de 1 día y tipos MIME correctos', async () => {
      const casos = [
        ['/vendor/three/build/three.module.js', /^text\/javascript/],
        ['/vendor/three/examples/jsm/renderers/CSS2DRenderer.js', /^text\/javascript/],
        ['/vendor/web-ifc/web-ifc-api.js', /^text\/javascript/],
        ['/vendor/web-ifc/web-ifc.wasm', /^application\/wasm$/],
        ['/vendor/three-mesh-bvh/src/index.js', /^text\/javascript/],
        ['/vendor/camera-controls/dist/camera-controls.module.js', /^text\/javascript/],
        ['/vendor/dxf-parser/dxf-parser.js', /^text\/javascript/],
        ['/vendor/libredwg-web/dist/libredwg-web.js', /^text\/javascript/],
        ['/vendor/libredwg-web/wasm/libredwg-web.wasm', /^application\/wasm$/],
        ['/vendor/fonts/urbanist/400.css', /^text\/css/],
      ];
      for (const [ruta, tipo] of casos) {
        const r = await peticion({ method: 'HEAD', path: ruta });
        nodeAssert.equal(r.status, 200, `${ruta} -> ${r.status}`);
        assert(tipo.test(r.headers['content-type']), `${ruta}: content-type ${r.headers['content-type']}`);
        assert(/max-age=86400/.test(r.headers['cache-control'] || ''), `${ruta}: cache-control ${r.headers['cache-control']}`);
      }
    });

    await prueba('rutas inexistentes: 404 en JSON', async () => {
      const r1 = await peticion({ path: '/api/no-existe' });
      nodeAssert.equal(r1.status, 404);
      assert(typeof json(r1).error === 'string', 'debe traer { error }');
      const r2 = await peticion({ path: '/no-existe.txt' });
      nodeAssert.equal(r2.status, 404);
    });

    let ifc;
    let dxf;
    await prueba('subir IFC devuelve 201 con el ModelRecord exacto', async () => {
      const r = await subir(LOCAL, 'edificio_georef_ifc4.ifc', IFC4);
      nodeAssert.equal(r.status, 201);
      ifc = await r.json();
      nodeAssert.deepEqual(Object.keys(ifc), ['id', 'name', 'kind', 'size', 'uploadedAt', 'georef', 'cad']);
      assert(ID_RE.test(ifc.id), `id inválido: ${ifc.id}`);
      nodeAssert.equal(ifc.name, 'edificio_georef_ifc4.ifc');
      nodeAssert.equal(ifc.kind, 'ifc');
      nodeAssert.equal(ifc.size, IFC4.length);
      assert(!Number.isNaN(Date.parse(ifc.uploadedAt)) && new Date(ifc.uploadedAt).toISOString() === ifc.uploadedAt, 'uploadedAt debe ser ISO');
      nodeAssert.equal(ifc.georef, null);
      nodeAssert.equal(ifc.cad, null);
      assert(fs.existsSync(path.join(srv.dataDir, 'uploads', `${ifc.id}.ifc`)), 'el archivo debe quedar en uploads/<id>.ifc');
      const sobrantes = fs.readdirSync(path.join(srv.dataDir, 'uploads')).filter((f) => f.startsWith('tmp-'));
      nodeAssert.deepEqual(sobrantes, []);
    });

    await prueba('subir DXF: kind dxf y cad { units: auto }; el listado respeta el orden de subida', async () => {
      const r = await subir(LOCAL, 'planta_georef.dxf', DXF);
      nodeAssert.equal(r.status, 201);
      dxf = await r.json();
      nodeAssert.equal(dxf.kind, 'dxf');
      nodeAssert.deepEqual(dxf.cad, { units: 'auto' });
      nodeAssert.equal(dxf.georef, null);
      const lista = await (await fetch(`${LOCAL}/api/models`)).json();
      nodeAssert.deepEqual(lista.map((m) => m.id), [ifc.id, dxf.id]);
      nodeAssert.deepEqual(lista[0], ifc);
    });

    await prueba('descarga: bytes idénticos, Content-Length, ETag, Content-Disposition y 304', async () => {
      const r = await peticion({ path: `/api/models/${ifc.id}/file` });
      nodeAssert.equal(r.status, 200);
      assert(r.buf.equals(IFC4), 'los bytes descargados deben coincidir con el archivo subido');
      nodeAssert.equal(Number(r.headers['content-length']), IFC4.length);
      assert(r.headers.etag, 'falta ETag');
      assert(/filename\*=UTF-8''edificio_georef_ifc4\.ifc/.test(r.headers['content-disposition']), r.headers['content-disposition']);
      const r2 = await peticion({ path: `/api/models/${ifc.id}/file`, headers: { 'If-None-Match': r.headers.etag } });
      nodeAssert.equal(r2.status, 304);
      assert(r2.buf.length === 0, 'el 304 no lleva cuerpo');
      const r3 = await peticion({ path: `/api/models/${ifc.id}/file`, headers: { Range: 'bytes=0-9' } });
      nodeAssert.equal(r3.status, 206);
      assert(r3.buf.equals(IFC4.subarray(0, 10)), 'el rango debe devolver los primeros 10 bytes');
      const d = await peticion({ path: `/api/models/${dxf.id}/file` });
      assert(d.buf.equals(DXF), 'el DXF descargado debe ser idéntico');
    });

    await prueba('nombres con tildes/ñ se conservan (UTF-8) y se codifican en Content-Disposition', async () => {
      const nombre = 'Edificio año ñandú.ifc';
      const r = await subir(LOCAL, nombre, IFC4);
      nodeAssert.equal(r.status, 201);
      const rec = await r.json();
      nodeAssert.equal(rec.name, nombre);
      const d = await peticion({ path: `/api/models/${rec.id}/file` });
      const m = /filename\*=UTF-8''([^;]+)/.exec(d.headers['content-disposition']);
      assert(m && decodeURIComponent(m[1]) === nombre, d.headers['content-disposition']);
      assert(/^[\x20-\x7e]+$/.test(d.headers['content-disposition']), 'la cabecera debe ser ASCII');
      nodeAssert.equal((await fetch(`${LOCAL}/api/models/${rec.id}`, { method: 'DELETE' })).status, 204);
    });

    await prueba('PATCH georef: persiste, se refleja en el listado y se puede borrar con null', async () => {
      const g = { eastings: 279500, northings: 8661000, height: 150, rotationDeg: 15, scale: 1 };
      const r = await patch(LOCAL, ifc.id, { georef: g });
      nodeAssert.equal(r.status, 200);
      const rec = await r.json();
      nodeAssert.deepEqual(rec.georef, g);
      nodeAssert.equal(rec.id, ifc.id);
      const lista = await (await fetch(`${LOCAL}/api/models`)).json();
      nodeAssert.deepEqual(lista.find((m) => m.id === ifc.id).georef, g);
      const r2 = await patch(LOCAL, ifc.id, { name: 'Edificio Torre A.ifc', georef: null });
      const rec2 = await r2.json();
      nodeAssert.equal(rec2.georef, null);
      nodeAssert.equal(rec2.name, 'Edificio Torre A.ifc');
      // valores por defecto de los campos opcionales
      const r3 = await patch(LOCAL, ifc.id, { georef: { eastings: 10, northings: 20 } });
      nodeAssert.deepEqual((await r3.json()).georef, { eastings: 10, northings: 20, height: 0, rotationDeg: 0, scale: 1 });
      await patch(LOCAL, ifc.id, { georef: null });
    });

    await prueba('PATCH georef inválido se rechaza con 400 y mensaje en español', async () => {
      await esperaError(patch(LOCAL, ifc.id, { georef: { eastings: 'abc', northings: 1 } }), 400, 'eastings');
      await esperaError(patch(LOCAL, ifc.id, { georef: { eastings: 1, northings: '2' } }), 400, 'northings');
      await esperaError(patch(LOCAL, ifc.id, { georef: { eastings: 1, northings: 2, rotationDeg: null } }), 400, 'rotationDeg');
      await esperaError(patch(LOCAL, ifc.id, '{"georef":{"eastings":1e999,"northings":1}}', { crudo: true }), 400, 'finito');
      await esperaError(patch(LOCAL, ifc.id, { georef: { eastings: 1, northings: 2, scale: 0 } }), 400, 'scale');
      await esperaError(patch(LOCAL, ifc.id, { georef: { northings: 2 } }), 400, 'eastings');
      await esperaError(patch(LOCAL, ifc.id, { georef: 5 }), 400);
      const rec = (await (await fetch(`${LOCAL}/api/models`)).json()).find((m) => m.id === ifc.id);
      nodeAssert.equal(rec.georef, null);
    });

    await prueba('PATCH cad.units: lista permitida; georef solo IFC; cad solo DXF/DWG', async () => {
      for (const units of ['auto', 'mm', 'cm', 'm', 'in', 'ft']) {
        const r = await patch(LOCAL, dxf.id, { cad: { units } });
        nodeAssert.equal(r.status, 200);
        nodeAssert.deepEqual((await r.json()).cad, { units });
      }
      await esperaError(patch(LOCAL, dxf.id, { cad: { units: 'km' } }), 400, 'cad.units');
      await esperaError(patch(LOCAL, dxf.id, { cad: { units: 5 } }), 400, 'cad.units');
      await esperaError(patch(LOCAL, dxf.id, { georef: { eastings: 1, northings: 2 } }), 400, 'IFC');
      await esperaError(patch(LOCAL, ifc.id, { cad: { units: 'm' } }), 400, 'DXF');
      const r = await patch(LOCAL, dxf.id, { cad: null });
      nodeAssert.deepEqual((await r.json()).cad, { units: 'auto' });
    });

    await prueba('PATCH: nombre vacío, cuerpo no objeto, JSON roto e id inexistente', async () => {
      await esperaError(patch(LOCAL, ifc.id, { name: '' }), 400, 'name');
      await esperaError(patch(LOCAL, ifc.id, { name: 5 }), 400, 'name');
      await esperaError(patch(LOCAL, ifc.id, [1, 2]), 400);
      await esperaError(patch(LOCAL, ifc.id, '{no es json', { crudo: true }), 400, 'JSON');
      await esperaError(patch(LOCAL, 'zzzzzzzzzz', { name: 'x.ifc' }), 404, 'no encontrado');
      await esperaError(patch(LOCAL, 'corto', { name: 'x.ifc' }), 404);
      const r = await patch(LOCAL, ifc.id, {});
      nodeAssert.equal(r.status, 200);
    });

    await prueba('rechaza extensiones no permitidas (400) y acepta mayúsculas', async () => {
      for (const nombre of ['malo.txt', 'malo.exe', 'malo', 'malo.ifc.exe', '.ifc', 'malo.ifcx', 'malo.zip']) {
        await esperaError(subir(LOCAL, nombre, Buffer.from('ISO-10303-21;')), 400, '.ifc');
      }
      const casos = [['MODELO.IFC', 'ifc'], ['Plano.DWG', 'dwg'], ['x.DxF', 'dxf']];
      for (const [nombre, kind] of casos) {
        const r = await subir(LOCAL, nombre, Buffer.from('contenido de prueba'));
        nodeAssert.equal(r.status, 201, `${nombre}`);
        const rec = await r.json();
        nodeAssert.equal(rec.kind, kind);
        nodeAssert.equal(rec.name, nombre);
        assert(fs.existsSync(path.join(srv.dataDir, 'uploads', `${rec.id}.${kind}`)), 'archivo con extensión en minúsculas');
        nodeAssert.equal((await fetch(`${LOCAL}/api/models/${rec.id}`, { method: 'DELETE' })).status, 204);
      }
      const sobrantes = fs.readdirSync(path.join(srv.dataDir, 'uploads')).filter((f) => f.startsWith('tmp-'));
      nodeAssert.deepEqual(sobrantes, [], 'no deben quedar temporales de las subidas rechazadas');
    });

    await prueba('rechaza subidas sin archivo, vacías, con otro campo o sin multipart', async () => {
      await esperaError(subir(LOCAL, 'a.ifc', Buffer.alloc(0)), 400, 'vacío');
      await esperaError(subir(LOCAL, 'a.ifc', IFC4, { campo: 'archivo' }), 400, '"file"');
      await esperaError(fetch(`${LOCAL}/api/models`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }), 400, 'file');
      await esperaError(fetch(`${LOCAL}/api/models`, { method: 'POST' }), 400);
    });

    await prueba('path traversal: ids falsos, nombres con rutas y rutas estáticas', async () => {
      const rutas = [
        '/api/models/..%2f..%2fpackage.json/file',
        '/api/models/../../package.json/file',
        '/api/models/%2e%2e%2f%2e%2e%2fpackage.json/file',
        '/api/models/%00/file',
        '/api/models/ABCDEFGHIJ/file',
        '/api/models/abcdefghijk/file',
        `/api/models/${ifc.id}%2f..%2f..%2fpackage.json/file`,
      ];
      for (const ruta of rutas) {
        const r = await peticion({ path: ruta });
        assert(r.status === 404 || r.status === 400, `${ruta} -> ${r.status}`);
        assert(!r.text.includes('visorifc5d'), `${ruta} filtró package.json`);
      }
      const estaticas = [
        '/../package.json', '/%2e%2e/package.json', '/..%2fpackage.json', '/vendor/three/../../package.json',
        '/vendor/three/..%2f..%2fpackage.json', '/vendor/web-ifc/%2e%2e/%2e%2e/package.json', '/js/../../package.json',
      ];
      for (const ruta of estaticas) {
        const r = await peticion({ path: ruta });
        assert(!(r.status === 200 && r.text.includes('visorifc5d')), `${ruta} filtró package.json (${r.status})`);
      }
      // El nombre de archivo con rutas se reduce al nombre base y no escapa de uploads/
      for (const nombre of ['../../evil.ifc', '..\\..\\evil2.dxf', '/etc/evil3.dwg']) {
        const r = await subir(LOCAL, nombre, Buffer.from('contenido'));
        nodeAssert.equal(r.status, 201, nombre);
        const rec = await r.json();
        assert(!/[\\/]/.test(rec.name), `el nombre conserva rutas: ${rec.name}`);
        assert(ID_RE.test(rec.id), 'id válido');
        assert(fs.existsSync(path.join(srv.dataDir, 'uploads', `${rec.id}.${rec.kind}`)), 'archivo dentro de uploads/');
        await fetch(`${LOCAL}/api/models/${rec.id}`, { method: 'DELETE' });
      }
      const fuera = ['evil.ifc', 'evil2.dxf', 'evil3.dwg'].filter((f) => fs.existsSync(path.join(srv.dataDir, f)) || fs.existsSync(path.join(srv.dataDir, '..', f)));
      nodeAssert.deepEqual(fuera, []);
    });

    await prueba('rol viewer desde la IP de red: info, listado y descarga sí; POST/PATCH/DELETE = 403', async () => {
      const info = await (await fetch(`${LAN}/api/info`)).json();
      nodeAssert.equal(info.role, 'viewer');
      nodeAssert.equal(info.clientIp, LAN_IP);
      nodeAssert.equal((await fetch(`${LAN}/api/models`)).status, 200);
      const d = await fetch(`${LAN}/api/models/${ifc.id}/file`);
      nodeAssert.equal(d.status, 200);
      nodeAssert.equal((await d.arrayBuffer()).byteLength, IFC4.length);
      await esperaError(subir(LAN, 'a.ifc', IFC4), 403, 'presentador');
      await esperaError(patch(LAN, ifc.id, { name: 'hack.ifc' }), 403, 'presentador');
      await esperaError(fetch(`${LAN}/api/models/${ifc.id}`, { method: 'DELETE' }), 403, 'presentador');
      // el 403 tiene prioridad sobre el 404
      await esperaError(fetch(`${LAN}/api/models/zzzzzzzzzz`, { method: 'DELETE' }), 403);
      const lista = await (await fetch(`${LOCAL}/api/models`)).json();
      assert(lista.some((m) => m.id === ifc.id), 'el modelo no debe haberse borrado');
      assert(lista.find((m) => m.id === ifc.id).name !== 'hack.ifc', 'el nombre no debe haber cambiado');
    }, { requiereLan: true });

    await prueba('el rol no depende de X-Forwarded-For ni de cabeceras manipulables', async () => {
      const r = await peticion({ host: LAN_IP, path: '/api/info', headers: { 'X-Forwarded-For': '127.0.0.1', 'X-Real-IP': '127.0.0.1', Forwarded: 'for=127.0.0.1' } });
      nodeAssert.equal(json(r).role, 'viewer');
      const r2 = await peticion({ host: LAN_IP, method: 'DELETE', path: `/api/models/${ifc.id}`, headers: { 'X-Forwarded-For': '127.0.0.1' } });
      nodeAssert.equal(r2.status, 403);
    }, { requiereLan: true });

    await prueba('peticiones entre sitios (Origin distinto de Host) se rechazan; mismo origen se acepta', async () => {
      const cuerpo = (nombre) => {
        const b = '----visorTest';
        return {
          headers: { 'Content-Type': `multipart/form-data; boundary=${b}` },
          body: Buffer.concat([
            Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="${nombre}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
            Buffer.from('contenido'),
            Buffer.from(`\r\n--${b}--\r\n`),
          ]),
        };
      };
      const mal = cuerpo('csrf.ifc');
      const r = await peticion({ method: 'POST', path: '/api/models', headers: { ...mal.headers, Origin: 'http://evil.example' }, body: mal.body });
      nodeAssert.equal(r.status, 403);
      const r0 = await peticion({ method: 'POST', path: '/api/models', headers: { ...mal.headers, Origin: 'null' }, body: mal.body });
      nodeAssert.equal(r0.status, 403);
      const bien = cuerpo('origen.ifc');
      const r2 = await peticion({ method: 'POST', path: '/api/models', headers: { ...bien.headers, Origin: LOCAL }, body: bien.body });
      nodeAssert.equal(r2.status, 201);
      await fetch(`${LOCAL}/api/models/${json(r2).id}`, { method: 'DELETE' });
      const lista = await (await fetch(`${LOCAL}/api/models`)).json();
      assert(!lista.some((m) => m.name === 'csrf.ifc'), 'la subida entre sitios no debe haberse registrado');
    });

    await prueba('DELETE: 204, desaparece del listado, borra el archivo y da 404 después', async () => {
      const r = await fetch(`${LOCAL}/api/models/${dxf.id}`, { method: 'DELETE' });
      nodeAssert.equal(r.status, 204);
      nodeAssert.equal(await r.text(), '');
      const lista = await (await fetch(`${LOCAL}/api/models`)).json();
      assert(!lista.some((m) => m.id === dxf.id), 'ya no debe estar en el listado');
      assert(!fs.existsSync(path.join(srv.dataDir, 'uploads', `${dxf.id}.dxf`)), 'el archivo debe borrarse del disco');
      nodeAssert.equal((await fetch(`${LOCAL}/api/models/${dxf.id}/file`)).status, 404);
      await esperaError(fetch(`${LOCAL}/api/models/${dxf.id}`, { method: 'DELETE' }), 404, 'no encontrado');
      const r2 = await fetch(`${LOCAL}/api/models/${ifc.id}`, { method: 'DELETE' });
      nodeAssert.equal(r2.status, 204);
      nodeAssert.deepEqual(await (await fetch(`${LOCAL}/api/models`)).json(), []);
    });
  });
});

await grupo('WebSocket: presentación', async () => {
  await conServidor({}, async () => {
    let A;
    let B;
    let C;
    const cam = { position: [10, 8, 12], target: [0, 1, 0], projection: 'perspective', zoom: 1, fov: 50 };

    await prueba('welcome del primer cliente (presentador local) con todos los campos', async () => {
      A = await conectarWs({ name: 'Anfitrión' });
      const w = A.welcome;
      nodeAssert.equal(typeof w.clientId, 'string');
      assert(w.clientId.length > 0, 'clientId vacío');
      nodeAssert.equal(w.role, 'presenter');
      nodeAssert.deepEqual(w.presentation, { active: false, presenterId: null, presenterName: '' });
      nodeAssert.deepEqual(w.state, {});
      nodeAssert.equal(w.camera, null);
      nodeAssert.deepEqual(w.models, []);
      nodeAssert.equal(w.viewerFreeNav, true);
      nodeAssert.equal(w.clients.viewers, 1);
      nodeAssert.deepEqual(w.clients.list, [{ id: A.id, name: 'Anfitrión', role: 'presenter' }]);
    });

    await prueba('clientes desde la IP de red entran como viewer y se difunde "clients" con el conteo', async () => {
      A.vaciar();
      B = await lan({ name: 'Ana' });
      nodeAssert.equal(B.welcome.role, 'viewer');
      nodeAssert.equal(B.welcome.clients.viewers, 2);
      nodeAssert.equal(B.welcome.clients.list.length, 2);
      const m1 = await A.espera('clients', { donde: (m) => m.list.length === 2 });
      nodeAssert.equal(m1.viewers, 2);
      C = await lan({ name: 'Beto' });
      nodeAssert.equal(C.welcome.clients.viewers, 3);
      const m2 = await A.espera('clients', { donde: (m) => m.list.length === 3 });
      nodeAssert.equal(m2.viewers, 3);
      nodeAssert.deepEqual(m2.list.map((c) => c.name).sort(), ['Ana', 'Anfitrión', 'Beto']);
      assert(m2.list.every((c) => ['presenter', 'viewer'].includes(c.role) && typeof c.id === 'string'), 'cada elemento tiene id, name, role');
    }, { requiereLan: true });

    await prueba('el presentador inicia la presentación: todos reciben "presentation" y baja el conteo de viewers', async () => {
      for (const c of [A, B, C]) c.vaciar();
      A.send({ t: 'presentation', active: true });
      for (const c of [A, B, C]) {
        const m = await c.espera('presentation');
        nodeAssert.deepEqual(m, { t: 'presentation', active: true, presenterId: A.id, presenterName: 'Anfitrión' });
      }
      const cl = await B.espera('clients');
      nodeAssert.equal(cl.viewers, 2, 'viewers excluye al presentador activo');
    }, { requiereLan: true });

    await prueba('un viewer no puede enviar state/camera/pointer ni controlar la presentación (error)', async () => {
      for (const c of [A, B, C]) c.vaciar();
      const intentos = [
        { t: 'state', slices: { selection: { items: [] } } },
        { t: 'camera', cam },
        { t: 'pointer', p: { x: 0, y: 0, aspect: 1, visible: true } },
        { t: 'presentation', active: false },
        { t: 'presentation', active: true },
        { t: 'take-control' },
      ];
      for (const msg of intentos) {
        B.send(msg);
        const e = await B.espera('error');
        assert(typeof e.message === 'string' && e.message.length > 0, `error sin mensaje para ${msg.t}`);
      }
      await C.noRecibe('state');
      await C.noRecibe('camera');
      await C.noRecibe('pointer');
      await C.noRecibe('presentation');
      await A.noRecibe('state');
    }, { requiereLan: true });

    await prueba('el presentador reenvía state, camera y pointer a los demás (no a sí mismo)', async () => {
      for (const c of [A, B, C]) c.vaciar();
      const slices = { selection: { items: [{ modelId: 'm1', expressId: 5 }] }, display: { ghostOpacity: 0.3 } };
      A.send({ t: 'state', slices });
      A.send({ t: 'camera', cam });
      const p = { x: 0.25, y: -0.5, aspect: 1.6, visible: true };
      A.send({ t: 'pointer', p });
      for (const c of [B, C]) {
        const s = await c.espera('state');
        nodeAssert.deepEqual(s, { t: 'state', slices, full: false });
        nodeAssert.deepEqual((await c.espera('camera')).cam, cam);
        nodeAssert.deepEqual((await c.espera('pointer')).p, p);
      }
      await A.noRecibe('state');
      await A.noRecibe('camera');
      await A.noRecibe('pointer');
    }, { requiereLan: true });

    await prueba('quien entra tarde recibe el lastState fusionado por slice y la última cámara', async () => {
      A.send({ t: 'state', slices: { selection: { items: [] } } });
      A.send({ t: 'state', slices: { ui: { tab: 'tree', sidebarOpen: true, dockOpen: true } } });
      const cam2 = { ...cam, position: [1, 2, 3] };
      A.send({ t: 'camera', cam: cam2 });
      await B.espera('camera', { donde: (m) => m.cam.position[0] === 1 });
      await B.espera('state', { donde: (m) => m.slices.ui });
      const D = await lan({ name: 'Dani' });
      nodeAssert.equal(D.welcome.presentation.active, true);
      nodeAssert.equal(D.welcome.presentation.presenterId, A.id);
      nodeAssert.equal(D.welcome.presentation.presenterName, 'Anfitrión');
      nodeAssert.deepEqual(D.welcome.state, {
        selection: { items: [] },
        display: { ghostOpacity: 0.3 },
        ui: { tab: 'tree', sidebarOpen: true, dockOpen: true },
      });
      nodeAssert.deepEqual(D.welcome.camera, cam2);
      D.cerrar();
    }, { requiereLan: true });

    await prueba('state con full:true reemplaza todo el lastState y se reenvía con full:true', async () => {
      B.vaciar();
      A.send({ t: 'state', full: true, slices: { ui: { tab: 'props', sidebarOpen: true, dockOpen: false } } });
      const s = await B.espera('state');
      nodeAssert.equal(s.full, true);
      const E = await lan({ name: 'Eli' });
      nodeAssert.deepEqual(E.welcome.state, { ui: { tab: 'props', sidebarOpen: true, dockOpen: false } });
      assert(E.welcome.camera !== null, 'la cámara se conserva tras un state completo');
      E.cerrar();
    }, { requiereLan: true });

    await prueba('validación de mensajes del presentador: slices inválidos y nombres peligrosos', async () => {
      A.vaciar();
      A.send({ t: 'state', slices: 'no soy un objeto' });
      await A.espera('error');
      A.send({ t: 'state', slices: [1, 2] });
      await A.espera('error');
      A.send('{"t":"state","slices":{"__proto__":{"polluted":true}}}');
      await A.espera('error');
      A.send({ t: 'camera', cam: 'x' });
      await A.espera('error');
      A.send({ t: 'pointer' });
      await A.espera('error');
      A.send({ t: 'presentation', active: 'si' });
      await A.espera('error');
      nodeAssert.equal({}.polluted, undefined);
    });

    let A2;
    await prueba('take-control transfiere la presentación (solo rol presenter) y reajusta quién puede emitir', async () => {
      A2 = await conectarWs({ name: 'Segundo' });
      for (const c of [A, A2, B, C]) c.vaciar();
      A2.send({ t: 'take-control' });
      for (const c of [A, A2, B, C]) {
        const m = await c.espera('presentation');
        nodeAssert.deepEqual(m, { t: 'presentation', active: true, presenterId: A2.id, presenterName: 'Segundo' });
        // viewers = conectados - presentador activo (el anterior presentador vuelve a contar como espectador)
        const cl = await c.espera('clients', { donde: (x) => x.list.some((e) => e.id === A2.id) });
        nodeAssert.equal(cl.viewers, cl.list.length - 1);
      }
      // A (ya no activo) ahora no puede emitir
      A.vaciar();
      A.send({ t: 'state', slices: { display: { ghostOpacity: 0.9 } } });
      assert((await A.espera('error')).message.length > 0, 'A debe recibir error');
      A.send({ t: 'presentation', active: true });
      await A.espera('error');
      // A2 sí
      B.vaciar();
      A2.send({ t: 'state', slices: { display: { ghostOpacity: 0.5 } } });
      nodeAssert.deepEqual((await B.espera('state')).slices, { display: { ghostOpacity: 0.5 } });
      // un viewer no puede tomar el control
      B.send({ t: 'take-control' });
      await B.espera('error');
    }, { requiereLan: true });

    await prueba('hello posterior cambia el nombre y se difunde "clients" (y "presentation" si es el presentador)', async () => {
      for (const c of [A, A2, B, C]) c.vaciar();
      B.send({ t: 'hello', name: '  Ana   María ' });
      const cl = await A.espera('clients', { donde: (m) => m.list.some((c) => c.id === B.id && c.name === 'Ana María') });
      assert(cl.list.length >= 4, 'la lista conserva a todos');
      A2.send({ t: 'hello', name: 'Presentador 2' });
      const p = await C.espera('presentation');
      nodeAssert.equal(p.presenterName, 'Presentador 2');
    }, { requiereLan: true });

    await prueba('si el presentador activo se desconecta la presentación termina y se difunde', async () => {
      for (const c of [A, B, C]) c.vaciar();
      A2.cerrar();
      for (const c of [A, B, C]) {
        const m = await c.espera('presentation');
        nodeAssert.deepEqual(m, { t: 'presentation', active: false, presenterId: null, presenterName: '' });
      }
      const cl = await B.espera('clients', { donde: (m) => !m.list.some((c) => c.id === A2.id) });
      nodeAssert.equal(cl.viewers, cl.list.length, 'sin presentador activo viewers = conectados');
      // un nuevo cliente ve la presentación detenida y sin estado
      const F = await lan({ name: 'Fer' });
      nodeAssert.equal(F.welcome.presentation.active, false);
      nodeAssert.deepEqual(F.welcome.state, {});
      nodeAssert.equal(F.welcome.camera, null);
      F.cerrar();
    }, { requiereLan: true });

    await prueba('take-control sin presentación activa devuelve error; stop lo puede pedir cualquier presentador', async () => {
      A.vaciar();
      A.send({ t: 'take-control' });
      await A.espera('error');
      // A inicia, y un segundo presentador la detiene
      const A3 = await conectarWs({ name: 'Tercero' });
      A.send({ t: 'presentation', active: true });
      await A3.espera('presentation', { donde: (m) => m.active });
      A.send({ t: 'state', slices: { display: { ghostOpacity: 0.2 } } });
      A.send({ t: 'camera', cam });
      await sleep(100);
      A3.send({ t: 'presentation', active: false });
      const m = await A.espera('presentation', { donde: (x) => !x.active });
      nodeAssert.equal(m.presenterId, null);
      // al reiniciar, lastState y cámara parten de cero
      A.send({ t: 'presentation', active: true });
      await A.espera('presentation', { donde: (x) => x.active });
      const G = await lan({ name: 'Gabi' });
      nodeAssert.deepEqual(G.welcome.state, {});
      nodeAssert.equal(G.welcome.camera, null);
      nodeAssert.equal(G.welcome.presentation.active, true);
      G.cerrar();
      A3.cerrar();
      A.send({ t: 'presentation', active: false });
      await A.espera('presentation', { donde: (x) => !x.active });
    }, { requiereLan: true });

    await prueba('wantRole viewer degrada a espectador (incluso desde loopback) y un hello posterior también', async () => {
      const V = await conectarWs({ name: 'Previsualización', wantRole: 'viewer' });
      nodeAssert.equal(V.welcome.role, 'viewer');
      V.send({ t: 'presentation', active: true });
      await V.espera('error');
      const P = await conectarWs({ name: 'Otro presentador' });
      nodeAssert.equal(P.welcome.role, 'presenter');
      P.send({ t: 'hello', name: 'Otro presentador', wantRole: 'viewer' });
      await P.espera('clients', { donde: (m) => m.list.some((c) => c.id === P.id && c.role === 'viewer') });
      P.send({ t: 'presentation', active: true });
      await P.espera('error');
      // y no se puede volver a ascender
      P.send({ t: 'hello', name: 'Otro presentador' });
      await sleep(100);
      P.send({ t: 'presentation', active: true });
      await P.espera('error');
      V.cerrar();
      P.cerrar();
    });

    await prueba('degradarse siendo el presentador activo termina la presentación', async () => {
      const P = await conectarWs({ name: 'Efímero' });
      P.send({ t: 'presentation', active: true });
      await A.espera('presentation', { donde: (m) => m.active && m.presenterId === P.id });
      A.vaciar();
      P.send({ t: 'hello', name: 'Efímero', wantRole: 'viewer' });
      const m = await A.espera('presentation', { donde: (x) => !x.active });
      nodeAssert.equal(m.presenterId, null);
      P.cerrar();
    });

    await prueba('mensajes inválidos devuelven error y el servidor sigue funcionando', async () => {
      const X = await conectarWs({ name: 'Raro' });
      X.vaciar();
      X.send('esto no es json');
      assert((await X.espera('error')).message.length > 0, 'JSON inválido');
      X.send('[1,2,3]');
      await X.espera('error');
      X.send({ sinT: 1 });
      await X.espera('error');
      X.send({ t: 'inventado' });
      await X.espera('error');
      X.send({ t: 5 });
      await X.espera('error');
      X.ws.send(Buffer.from([1, 2, 3, 4]));
      await X.espera('error');
      X.send({ t: 'ping' });
      await X.espera('pong');
      X.cerrar();
    });

    await prueba('antes de hello solo se acepta ping; el resto devuelve error', async () => {
      const Y = await conectarWs({ hello: false });
      Y.send({ t: 'ping' });
      await Y.espera('pong');
      Y.send({ t: 'state', slices: {} });
      assert((await Y.espera('error')).message.includes('hello'), 'debe pedir hello');
      Y.send({ t: 'hello', name: '' });
      const w = await Y.espera('welcome');
      assert(w.clients.list.find((c) => c.id === w.clientId).name.length > 0, 'nombre por defecto');
      Y.cerrar();
    });

    await prueba('los cambios de modelos (subida, PATCH, borrado) se difunden como "models" a todos', async () => {
      for (const c of [A, B, C]) c.vaciar();
      const r = await subir(LOCAL, 'difusion.ifc', IFC4);
      const rec = await r.json();
      for (const c of [A, B, C]) {
        const m = await c.espera('models');
        nodeAssert.deepEqual(m.models, [rec]);
      }
      // quien entra después los recibe en welcome
      const H = await lan({ name: 'Hugo' });
      nodeAssert.deepEqual(H.welcome.models, [rec]);
      H.cerrar();
      for (const c of [A, B, C]) c.vaciar();
      await patch(LOCAL, rec.id, { name: 'renombrado.ifc' });
      for (const c of [A, B, C]) nodeAssert.equal((await c.espera('models')).models[0].name, 'renombrado.ifc');
      for (const c of [A, B, C]) c.vaciar();
      await fetch(`${LOCAL}/api/models/${rec.id}`, { method: 'DELETE' });
      for (const c of [A, B, C]) nodeAssert.deepEqual((await c.espera('models')).models, []);
    }, { requiereLan: true });

    await prueba('una subida rechazada (403/400) no difunde "models"', async () => {
      for (const c of [A, B]) c.vaciar();
      await subir(LAN, 'a.ifc', IFC4);
      await subir(LOCAL, 'a.txt', IFC4);
      await A.noRecibe('models');
      await B.noRecibe('models');
    }, { requiereLan: true });

    await prueba('al salir un cliente se difunde "clients" actualizado', async () => {
      A.vaciar();
      const temporal = await lan({ name: 'Temporal' });
      await A.espera('clients', { donde: (m) => m.list.some((c) => c.id === temporal.id) });
      A.vaciar();
      temporal.cerrar();
      const cl = await A.espera('clients', { donde: (m) => !m.list.some((c) => c.id === temporal.id) });
      assert(cl.list.some((c) => c.id === A.id), 'A sigue en la lista');
    }, { requiereLan: true });

    await prueba('mensaje mayor que maxPayload (32 MB) cierra la conexión con código 1009', async () => {
      const Z = await conectarWs({ name: 'Gigante' });
      try {
        Z.ws.send('x'.repeat(33 * 1024 * 1024));
      } catch { /* el cierre puede adelantarse al envío */ }
      const t0 = Date.now();
      while (Z.cierre === null && Date.now() - t0 < 8000) await sleep(50);
      nodeAssert.equal(Z.cierre, 1009);
    });

    await prueba('un mensaje grande pero válido (5 MB de estado) se reenvía completo', async () => {
      const P = await conectarWs({ name: 'Con miniaturas' });
      P.send({ t: 'presentation', active: true });
      await P.espera('presentation', { donde: (m) => m.active });
      B.vaciar();
      const grande = 'a'.repeat(5 * 1024 * 1024);
      P.send({ t: 'state', slices: { views: { items: [{ id: 'v1', thumb: grande }] } } });
      const s = await B.espera('state', { timeout: 8000 });
      nodeAssert.equal(s.slices.views.items[0].thumb.length, grande.length);
      P.cerrar();
      await B.espera('presentation', { donde: (m) => !m.active });
    }, { requiereLan: true });

    await prueba('mejora WebSocket: solo /ws; origen distinto se rechaza', async () => {
      await conectarWs({ ruta: '/otra', hello: false }).then(
        () => { throw new Error('/otra no debería aceptar WebSocket'); },
        (e) => assert(/404/.test(e.message), `esperaba 404, llegó: ${e.message}`),
      );
      await conectarWs({ headers: { Origin: 'http://evil.example' }, hello: false }).then(
        () => { throw new Error('un origen ajeno no debería aceptarse'); },
        (e) => assert(/403/.test(e.message), `esperaba 403, llegó: ${e.message}`),
      );
      const ok = await conectarWs({ headers: { Origin: LOCAL }, name: 'Mismo origen' });
      nodeAssert.equal(ok.welcome.role, 'presenter');
      ok.cerrar();
    });
  });
});

await grupo('Persistencia y cierre limpio', async () => {
  const datos = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-persist-'));
  let ifc;
  let dxf;
  try {
    await prueba('subir, modificar, detener con SIGTERM (código 0) y recargar session.json al arrancar', async () => {
      const salida = await conServidor({ dataDir: datos, conservar: true }, async () => {
        ifc = await (await subir(LOCAL, 'torre.ifc', IFC4)).json();
        dxf = await (await subir(LOCAL, 'planta.dxf', DXF)).json();
        const g = { eastings: 279500.5, northings: 8661000.25, height: 150, rotationDeg: 15, scale: 1 };
        ifc = await (await patch(LOCAL, ifc.id, { georef: g })).json();
        dxf = await (await patch(LOCAL, dxf.id, { cad: { units: 'cm' } })).json();
        const sesion = JSON.parse(fs.readFileSync(path.join(datos, 'session.json'), 'utf8'));
        nodeAssert.equal(sesion.models.length, 2);
        const tmp = fs.readdirSync(datos).filter((f) => f.endsWith('.tmp'));
        nodeAssert.deepEqual(tmp, [], 'la escritura atómica no debe dejar temporales');
      });
      nodeAssert.equal(salida.code, 0, `código de salida ${salida.code}`);
      assert(salida.log.includes('Servidor detenido'), 'debe informar del cierre limpio');

      await conServidor({ dataDir: datos, conservar: true }, async () => {
        const lista = await (await fetch(`${LOCAL}/api/models`)).json();
        nodeAssert.deepEqual(lista, [ifc, dxf]);
        const d = await peticion({ path: `/api/models/${ifc.id}/file` });
        assert(d.buf.equals(IFC4), 'el archivo sigue disponible tras reiniciar');
        // los ids nuevos no chocan con los existentes
        const nuevo = await (await subir(LOCAL, 'otro.ifc', IFC4)).json();
        assert(nuevo.id !== ifc.id && nuevo.id !== dxf.id, 'id único');
      });
    });

    await prueba('SIGINT también cierra limpio con código 0', async () => {
      await puertoLibre();
      const srv = await startServer({ port: PORT, env: { DATA_DIR: datos } });
      const salida = new Promise((resolve) => srv.child.once('exit', (code) => resolve(code)));
      srv.child.kill('SIGINT');
      const code = await Promise.race([salida, sleep(6000).then(() => 'timeout')]);
      await srv.stop();
      nodeAssert.equal(code, 0);
      assert(srv.log().includes('SIGINT'), 'el cierre debe mencionar la señal');
      await puertoLibre();
    });

    await prueba('registros cuyo archivo no existe se ignoran al recargar', async () => {
      const uploads = path.join(datos, 'uploads');
      const antes = JSON.parse(fs.readFileSync(path.join(datos, 'session.json'), 'utf8')).models.length;
      assert(antes >= 2, 'precondición');
      fs.unlinkSync(path.join(uploads, `${dxf.id}.dxf`));
      const salida = await conServidor({ dataDir: datos, conservar: true }, async (srv) => {
        const lista = await (await fetch(`${LOCAL}/api/models`)).json();
        assert(!lista.some((m) => m.id === dxf.id), 'el registro sin archivo debe ignorarse');
        assert(lista.some((m) => m.id === ifc.id), 'el IFC sigue');
        assert(/ignoraron/.test(srv.log()), 'debe avisar de los registros ignorados');
      });
      nodeAssert.equal(salida.code, 0);
    });

    await prueba('session.json corrupto: se conserva copia y el servidor arranca vacío', async () => {
      fs.writeFileSync(path.join(datos, 'session.json'), '{ esto no es json');
      await conServidor({ dataDir: datos, conservar: true }, async () => {
        nodeAssert.deepEqual(await (await fetch(`${LOCAL}/api/models`)).json(), []);
        const copias = fs.readdirSync(datos).filter((f) => f.startsWith('session.json.corrupto-'));
        nodeAssert.equal(copias.length, 1);
        // sigue siendo operativo
        nodeAssert.equal((await subir(LOCAL, 'nuevo.ifc', IFC4)).status, 201);
      });
    });

    await prueba('puerto ocupado: mensaje en español y código de salida 1', async () => {
      await puertoLibre();
      const ocupante = net.createServer();
      await new Promise((resolve) => ocupante.listen(PORT, '0.0.0.0', resolve));
      try {
        const hijo = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
          env: { ...process.env, PORT: String(PORT), DATA_DIR: datos },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let salida = '';
        hijo.stdout.on('data', (d) => { salida += d; });
        hijo.stderr.on('data', (d) => { salida += d; });
        const code = await new Promise((resolve) => hijo.once('exit', resolve));
        nodeAssert.equal(code, 1);
        assert(/ya está en uso/.test(salida), `mensaje: ${salida}`);
      } finally {
        await new Promise((resolve) => ocupante.close(resolve));
      }
    });

    await prueba('los temporales de subidas interrumpidas se limpian al arrancar', async () => {
      const uploads = path.join(datos, 'uploads');
      fs.writeFileSync(path.join(uploads, 'tmp-deadbeef.part'), 'restos');
      await conServidor({ dataDir: datos, conservar: true }, async () => {
        assert(!fs.existsSync(path.join(uploads, 'tmp-deadbeef.part')), 'el temporal debe borrarse');
      });
    });
  } finally {
    fs.rmSync(datos, { recursive: true, force: true });
  }
});

await grupo('Vistas guardadas (GET/PUT /api/views y persistencia)', async () => {
  const THUMB = `data:image/jpeg;base64,${Buffer.from('miniatura-de-prueba').toString('base64')}`;
  const vista = (id, extra = {}) => ({
    id,
    name: `Vista ${id}`,
    camera: { position: [10, 8, 10], target: [0, 0, 0], projection: 'perspective', zoom: 1, fov: 45 },
    state: { visibility: { hidden: {}, isolated: null, hiddenTypes: ['IFCSPACE'] }, display: { selectionMode: 'ghost', ghostOpacity: 0.12, edges: true, projection: 'perspective', showSpaces: false } },
    thumb: THUMB,
    ...extra,
  });
  const putViews = (base, items, headers = {}) => fetch(`${base}/api/views`, { method: 'PUT', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ items }) });
  const datos = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-views-'));
  try {
    await prueba('PUT (presentador) guarda la lista, GET la devuelve igual y session.json la contiene junto a los modelos', async () => {
      await conServidor({ dataDir: datos, conservar: true }, async () => {
        nodeAssert.deepEqual(await (await fetch(`${LOCAL}/api/views`)).json(), { items: [] });
        const ifc = await (await subir(LOCAL, 'torre.ifc', IFC4)).json();
        const items = [vista('v1'), vista('v2', { thumb: null })];
        const r = await putViews(LOCAL, items);
        nodeAssert.equal(r.status, 200);
        nodeAssert.deepEqual(await r.json(), { items });
        nodeAssert.deepEqual(await (await fetch(`${LOCAL}/api/views`)).json(), { items });
        const sesion = JSON.parse(fs.readFileSync(path.join(datos, 'session.json'), 'utf8'));
        nodeAssert.deepEqual(sesion.views, items);
        nodeAssert.equal(sesion.models.length, 1, 'las vistas no deben pisar los modelos');
        // modificar un modelo vuelve a escribir session.json sin perder las vistas
        await patch(LOCAL, ifc.id, { name: 'torre-2.ifc' });
        nodeAssert.deepEqual(JSON.parse(fs.readFileSync(path.join(datos, 'session.json'), 'utf8')).views, items);
        nodeAssert.deepEqual(fs.readdirSync(datos).filter((f) => f.endsWith('.tmp')), []);
      });
    });

    await prueba('las vistas sobreviven a reiniciar el servidor y se pueden vaciar', async () => {
      await conServidor({ dataDir: datos, conservar: true }, async () => {
        const { items } = await (await fetch(`${LOCAL}/api/views`)).json();
        nodeAssert.deepEqual(items.map((v) => v.id), ['v1', 'v2']);
        nodeAssert.equal(items[0].thumb, THUMB);
        nodeAssert.equal(items[0].camera.projection, 'perspective');
        const vacio = await putViews(LOCAL, []);
        nodeAssert.equal(vacio.status, 200);
        nodeAssert.deepEqual(await (await fetch(`${LOCAL}/api/views`)).json(), { items: [] });
      });
      await conServidor({ dataDir: datos, conservar: true }, async () => {
        nodeAssert.deepEqual(await (await fetch(`${LOCAL}/api/views`)).json(), { items: [] });
      });
    });

    await prueba('validación: formato, límites y campos desconocidos (400 con mensaje en español)', async () => {
      await conServidor({ dataDir: datos, conservar: true }, async () => {
        await esperaError(putViews(LOCAL, 'no-es-lista'), 400, 'lista');
        await esperaError(putViews(LOCAL, [vista('../x')]), 400, 'id');
        await esperaError(putViews(LOCAL, [vista('a'), vista('a')]), 400, 'repetido');
        await esperaError(putViews(LOCAL, [vista('a', { camera: { position: [0, 0], target: [0, 0, 0] } })]), 400, 'camera.position');
        await esperaError(putViews(LOCAL, [vista('a', { camera: { position: [0, 0, 'x'], target: [0, 0, 0] } })]), 400, 'finitos');
        await esperaError(putViews(LOCAL, [vista('a', { thumb: 'http://evil.example/x.png' })]), 400, 'thumb');
        await esperaError(putViews(LOCAL, [vista('a', { thumb: 'data:text/html;base64,PHNjcmlwdD4=' })]), 400, 'thumb');
        await esperaError(putViews(LOCAL, [vista('a', { state: 'x' })]), 400, 'state');
        await esperaError(putViews(LOCAL, Array.from({ length: 61 }, (_, i) => vista(`m${i}`))), 400, 'máximo');
        await esperaError(fetch(`${LOCAL}/api/views`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '[1,2]' }), 400, 'objeto');
        await esperaError(fetch(`${LOCAL}/api/views`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{roto' }), 400, 'JSON');
        // una petición inválida no cambia lo guardado; campos desconocidos y nombres con rutas se normalizan
        nodeAssert.deepEqual(await (await fetch(`${LOCAL}/api/views`)).json(), { items: [] });
        const r = await putViews(LOCAL, [vista('ok1', { name: '  ../../etc/pasaporte  ', extra: 'se descarta', state: { ...vista('x').state, otro: { a: 1 } } })]);
        nodeAssert.equal(r.status, 200);
        const [v] = (await r.json()).items;
        nodeAssert.equal(v.name, '..-..-etc-pasaporte', 'el nombre se recorta y no conserva separadores de ruta');
        assert(!('extra' in v) && !('otro' in v.state), 'solo se guardan los campos conocidos');
        // cuerpos grandes (hasta 8 MB) se aceptan: 60 vistas con miniaturas de ~100 KB (las reales pesan ~20 KB)
        const grande = Array.from({ length: 60 }, (_, i) => vista(`g${i}`, { thumb: `data:image/jpeg;base64,${'A'.repeat(100000)}` }));
        nodeAssert.equal((await putViews(LOCAL, grande)).status, 200);
        await esperaError(putViews(LOCAL, [vista('a', { thumb: `data:image/jpeg;base64,${'A'.repeat(200001)}` })]), 400, 'thumb');
        await putViews(LOCAL, []);
      });
    });

    await prueba('rol viewer (IP de red): puede leer las vistas pero no guardarlas (403)', async () => {
      await conServidor({ dataDir: datos, conservar: true }, async () => {
        nodeAssert.equal((await putViews(LOCAL, [vista('p1')])).status, 200);
        nodeAssert.equal((await fetch(`${LAN}/api/views`)).status, 200);
        nodeAssert.deepEqual((await (await fetch(`${LAN}/api/views`)).json()).items.map((v) => v.id), ['p1']);
        await esperaError(putViews(LAN, [vista('hack')]), 403, 'presentador');
        await esperaError(putViews(LAN, [vista('hack')], { 'X-Forwarded-For': '127.0.0.1' }), 403);
        await esperaError(putViews(LOCAL, [vista('hack')], { Origin: 'http://evil.example' }), 403, 'Origen');
        nodeAssert.deepEqual((await (await fetch(`${LOCAL}/api/views`)).json()).items.map((v) => v.id), ['p1']);
      });
    }, { requiereLan: true });

    await prueba('session.json con vistas inválidas: se ignoran las vistas y los modelos se conservan', async () => {
      await conServidor({ dataDir: datos, conservar: true }, async (srv) => {
        const ifc = await (await subir(LOCAL, 'x.ifc', IFC4)).json();
        const archivo = path.join(datos, 'session.json');
        const sesion = JSON.parse(fs.readFileSync(archivo, 'utf8'));
        sesion.views = [{ id: 'roto' }];
        fs.writeFileSync(archivo, JSON.stringify(sesion));
        srv.__ifc = ifc;
      });
      await conServidor({ dataDir: datos, conservar: true }, async (srv) => {
        nodeAssert.deepEqual(await (await fetch(`${LOCAL}/api/views`)).json(), { items: [] });
        assert((await (await fetch(`${LOCAL}/api/models`)).json()).length >= 1, 'los modelos deben conservarse');
        assert(/vistas guardadas/.test(srv.log()), 'debe avisar de que las vistas se ignoraron');
      });
    });
  } finally {
    fs.rmSync(datos, { recursive: true, force: true });
  }
});

await grupo('Límite de tamaño de subida (MAX_UPLOAD_MB=1)', async () => {
  await conServidor({ env: { MAX_UPLOAD_MB: '1' } }, async (srv) => {
    await prueba('un archivo mayor que el límite devuelve 413 y no deja restos', async () => {
      await esperaError(subir(LOCAL, 'grande.ifc', Buffer.alloc(1.5 * 1024 * 1024, 65)), 413, '1 MB');
      nodeAssert.deepEqual(fs.readdirSync(path.join(srv.dataDir, 'uploads')), []);
      nodeAssert.deepEqual(await (await fetch(`${LOCAL}/api/models`)).json(), []);
    });
    await prueba('un archivo dentro del límite se acepta', async () => {
      const r = await subir(LOCAL, 'pequeno.ifc', Buffer.alloc(600 * 1024, 66));
      nodeAssert.equal(r.status, 201);
      nodeAssert.equal((await r.json()).size, 600 * 1024);
    });
  });
});

await grupo('VIEWER_FREE_NAV=false', async () => {
  await conServidor({ env: { VIEWER_FREE_NAV: 'false' } }, async () => {
    await prueba('se refleja en /api/info y en welcome', async () => {
      nodeAssert.equal((await (await fetch(`${LOCAL}/api/info`)).json()).viewerFreeNav, false);
      const c = await conectarWs({ name: 'x' });
      nodeAssert.equal(c.welcome.viewerFreeNav, false);
      c.cerrar();
    });
  });
});

await grupo('PIN de presentador y ApiClient en el navegador', async () => {
  await conServidor({ env: { PRESENTER_PIN: '1234' } }, async (srv) => {
    await prueba('/api/info informa de que el PIN está activo, sin revelarlo', async () => {
      const r = await peticion({ path: '/api/info' });
      nodeAssert.equal(json(r).presenterPinEnabled, true);
      assert(!r.text.includes('1234'), 'el PIN no debe aparecer en la respuesta');
      nodeAssert.equal(json(r).role, 'presenter', 'loopback sigue siendo presentador sin PIN');
      assert(!srv.log().includes('1234'), 'el PIN no debe imprimirse en el arranque');
    });

    let idLan;
    await prueba('desde la IP de red: sin PIN o con PIN erróneo es viewer (403); con PIN correcto sube, edita y borra', async () => {
      nodeAssert.equal(json(await peticion({ host: LAN_IP, path: '/api/info' })).role, 'viewer');
      nodeAssert.equal(json(await peticion({ host: LAN_IP, path: '/api/info', headers: { 'X-Presenter-Pin': '9999' } })).role, 'viewer');
      await esperaError(subir(LAN, 'a.ifc', IFC4), 403, 'presentador');
      await esperaError(subir(LAN, 'a.ifc', IFC4, { headers: { 'X-Presenter-Pin': '12345' } }), 403);
      const bien = { 'X-Presenter-Pin': '1234' };
      nodeAssert.equal(json(await peticion({ host: LAN_IP, path: '/api/info', headers: bien })).role, 'presenter');
      const r = await subir(LAN, 'con_pin.ifc', IFC4, { headers: bien });
      nodeAssert.equal(r.status, 201);
      idLan = (await r.json()).id;
      nodeAssert.equal((await patch(LAN, idLan, { name: 'renombrado_pin.ifc' }, { headers: bien })).status, 200);
      nodeAssert.equal((await patch(LAN, idLan, { name: 'sin_pin.ifc' })).status, 403);
    }, { requiereLan: true });

    await prueba('WebSocket con PIN en el hello: presentador; PIN erróneo o wantRole viewer: espectador', async () => {
      const a = await lan({ name: 'PC remota', pin: '1234' });
      nodeAssert.equal(a.welcome.role, 'presenter');
      const b = await lan({ name: 'PC mala', pin: '0000' });
      nodeAssert.equal(b.welcome.role, 'viewer');
      const c = await lan({ name: 'PC sin pin' });
      nodeAssert.equal(c.welcome.role, 'viewer');
      const d = await lan({ name: 'PC degradada', pin: '1234', wantRole: 'viewer' });
      nodeAssert.equal(d.welcome.role, 'viewer');
      // la PC remota puede presentar
      a.send({ t: 'presentation', active: true });
      const m = await c.espera('presentation', { donde: (x) => x.active });
      nodeAssert.equal(m.presenterId, a.id);
      // PIN por cabecera de la mejora WebSocket
      const e = await lan({ name: 'PC cabecera', headers: { 'X-Presenter-Pin': '1234' } });
      nodeAssert.equal(e.welcome.role, 'presenter');
      for (const x of [a, b, c, d, e]) x.cerrar();
    }, { requiereLan: true });

    // ----- ApiClient (public/js/core/api.js) en un navegador real -----
    let navegador = null;
    try {
      navegador = await chromium.launch({ args: ['--proxy-server=direct://'] });
    } catch (err) {
      resultados.push({ etiqueta: `${grupoActual} > (navegador)`, estado: 'fallo', err });
      console.log(`  FALLO    no se pudo abrir Chromium: ${err.message}`);
    }
    if (navegador) {
      const abrir = async (base) => {
        const contexto = await navegador.newContext();
        const pagina = await contexto.newPage();
        const errores = [];
        pagina.on('pageerror', (e) => errores.push(e.message));
        await pagina.goto(`${base}/api/info`); // documento del mismo origen desde el que importar el módulo
        return { contexto, pagina, errores };
      };
      const ejemplo = leerFixture('downloads/example.ifc');
      const sha = crypto.createHash('sha256').update(ejemplo).digest('hex');

      await prueba('ApiClient (anfitrión): getInfo, listModels, upload con progreso, download con progreso, patch, delete', async () => {
        const { contexto, pagina, errores } = await abrir(LOCAL);
        try {
          const res = await pagina.evaluate(async ({ b64, nombre }) => {
            const { ApiClient, ApiError } = await import('/js/core/api.js');
            const api = new ApiClient();
            const out = {};
            const info = await api.getInfo();
            out.role = info.role;
            out.pinEnabled = info.presenterPinEnabled;
            const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
            const subidas = [];
            const rec = await api.uploadModel(new File([bytes], nombre), (l, t) => subidas.push([l, t]));
            out.rec = rec;
            out.subidas = subidas;
            out.lista = (await api.listModels()).map((m) => m.id);
            out.fileUrl = api.fileUrl(rec.id);
            const descargas = [];
            const buf = await api.downloadModel(rec.id, (l, t) => descargas.push([l, t]));
            out.esArrayBuffer = buf instanceof ArrayBuffer;
            out.tam = buf.byteLength;
            const h = await crypto.subtle.digest('SHA-256', buf);
            out.sha = [...new Uint8Array(h)].map((x) => x.toString(16).padStart(2, '0')).join('');
            out.descargas = descargas;
            out.sinProgreso = (await api.downloadModel(rec.id)).byteLength;
            out.patch = await api.patchModel(rec.id, { georef: { eastings: 1, northings: 2, height: 3, rotationDeg: 4, scale: 1 } });
            try {
              await api.patchModel(rec.id, { georef: { eastings: 'x', northings: 2 } });
              out.errPatch = null;
            } catch (e) {
              out.errPatch = { esApiError: e instanceof ApiError, status: e.status, message: e.message };
            }
            out.del = await api.deleteModel(rec.id);
            try {
              await api.downloadModel(rec.id);
              out.errDescarga = null;
            } catch (e) {
              out.errDescarga = { status: e.status, message: e.message };
            }
            try {
              await api.deleteModel(rec.id);
              out.errDel = null;
            } catch (e) {
              out.errDel = { status: e.status, message: e.message };
            }
            return out;
          }, { b64: ejemplo.toString('base64'), nombre: 'example.ifc' });

          nodeAssert.equal(res.role, 'presenter');
          nodeAssert.equal(res.pinEnabled, true);
          assert(ID_RE.test(res.rec.id) && res.rec.kind === 'ifc' && res.rec.size === ejemplo.length, JSON.stringify(res.rec));
          assert(res.subidas.length >= 1, 'la subida debe informar de progreso');
          const ult = res.subidas[res.subidas.length - 1];
          assert(ult[0] === ult[1] && ult[1] >= ejemplo.length, `último progreso de subida: ${ult}`);
          assert(res.lista.includes(res.rec.id), 'listModels incluye el modelo subido');
          nodeAssert.equal(res.fileUrl, `/api/models/${res.rec.id}/file`);
          assert(res.esArrayBuffer, 'downloadModel devuelve ArrayBuffer');
          nodeAssert.equal(res.tam, ejemplo.length);
          nodeAssert.equal(res.sha, sha);
          assert(res.descargas.length >= 1, 'la descarga debe informar de progreso');
          const ud = res.descargas[res.descargas.length - 1];
          nodeAssert.deepEqual(ud, [ejemplo.length, ejemplo.length]);
          assert(res.descargas.every((d, i) => i === 0 || d[0] >= res.descargas[i - 1][0]), 'el progreso es monótono');
          nodeAssert.equal(res.sinProgreso, ejemplo.length);
          nodeAssert.equal(res.patch.georef.eastings, 1);
          assert(res.errPatch && res.errPatch.esApiError && res.errPatch.status === 400, JSON.stringify(res.errPatch));
          assert(/finito/.test(res.errPatch.message), `mensaje legible: ${res.errPatch.message}`);
          nodeAssert.equal(res.del, undefined);
          assert(res.errDescarga && res.errDescarga.status === 404 && /no encontrado/i.test(res.errDescarga.message), JSON.stringify(res.errDescarga));
          assert(res.errDel && res.errDel.status === 404, JSON.stringify(res.errDel));
          nodeAssert.deepEqual(errores, []);
        } finally {
          await contexto.close();
        }
      });

      await prueba('ApiClient: setPin/getPin con sessionStorage y cabecera X-Presenter-Pin', async () => {
        const { contexto, pagina } = await abrir(LOCAL);
        try {
          const res = await pagina.evaluate(async () => {
            const { ApiClient } = await import('/js/core/api.js');
            const api = new ApiClient();
            const out = { inicial: api.getPin() };
            api.setPin('  4321 ');
            out.guardado = api.getPin();
            out.storage = sessionStorage.getItem('visor.pin');
            const otro = new ApiClient();
            out.otroCliente = otro.getPin();
            api.setPin('');
            out.borrado = sessionStorage.getItem('visor.pin');
            out.trasBorrar = api.getPin();
            return out;
          });
          nodeAssert.deepEqual(res, { inicial: '', guardado: '4321', storage: '4321', otroCliente: '4321', borrado: null, trasBorrar: '' });
        } finally {
          await contexto.close();
        }
      });

      if (LAN) {
        await prueba('ApiClient (otra PC): rol viewer, 403 legible al subir; con setPin correcto pasa a presentador', async () => {
          const { contexto, pagina } = await abrir(LAN);
          try {
            const res = await pagina.evaluate(async () => {
              const { ApiClient } = await import('/js/core/api.js');
              const api = new ApiClient();
              const out = { rol1: (await api.getInfo()).role };
              const f = new File([new Uint8Array([1, 2, 3])], 'x.ifc');
              try { await api.uploadModel(f); out.err1 = null; } catch (e) { out.err1 = { status: e.status, message: e.message }; }
              try { await api.deleteModel('abcdefghij'); out.err2 = null; } catch (e) { out.err2 = { status: e.status, message: e.message }; }
              api.setPin('0000');
              out.rolMalo = (await api.getInfo()).role;
              api.setPin('1234');
              out.rol2 = (await api.getInfo()).role;
              const rec = await api.uploadModel(f);
              out.rec = rec.id;
              await api.deleteModel(rec.id);
              out.lista = (await api.listModels()).some((m) => m.id === rec.id);
              api.setPin('');
              out.rol3 = (await api.getInfo()).role;
              return out;
            });
            nodeAssert.equal(res.rol1, 'viewer');
            assert(res.err1 && res.err1.status === 403 && /presentador/i.test(res.err1.message), JSON.stringify(res.err1));
            assert(res.err2 && res.err2.status === 403, JSON.stringify(res.err2));
            nodeAssert.equal(res.rolMalo, 'viewer');
            nodeAssert.equal(res.rol2, 'presenter');
            assert(ID_RE.test(res.rec), 'subida con PIN correcto');
            nodeAssert.equal(res.lista, false);
            nodeAssert.equal(res.rol3, 'viewer');
          } finally {
            await contexto.close();
          }
        });
      }

      await prueba('ApiClient: error de red con mensaje legible en español', async () => {
        const { contexto, pagina } = await abrir(LOCAL);
        try {
          const res = await pagina.evaluate(async () => {
            const { ApiClient } = await import('/js/core/api.js');
            const api = new ApiClient({ base: 'http://127.0.0.1:1' }); // puerto cerrado
            const out = {};
            try { await api.listModels(); } catch (e) { out.lista = e.message; }
            try { await api.uploadModel(new File([new Uint8Array(3)], 'x.ifc')); } catch (e) { out.subida = e.message; }
            try { await api.downloadModel('abcdefghij'); } catch (e) { out.descarga = e.message; }
            return out;
          });
          for (const k of ['lista', 'subida', 'descarga']) {
            assert(typeof res[k] === 'string' && /servidor/i.test(res[k]), `${k}: ${res[k]}`);
          }
        } finally {
          await contexto.close();
        }
      });
      await navegador.close();
    }

    await prueba('el límite de intentos de PIN no deja entrar a quien lo adivina por fuerza bruta', async () => {
      // más de 30 PIN erróneos desde la misma IP bloquean los intentos siguientes (incluso con el PIN correcto)
      for (let i = 0; i < 40; i += 1) {
        await peticion({ host: LAN_IP, path: '/api/info', headers: { 'X-Presenter-Pin': String(1000 + i) } });
      }
      const r = await peticion({ host: LAN_IP, path: '/api/info', headers: { 'X-Presenter-Pin': '1234' } });
      nodeAssert.equal(json(r).role, 'viewer');
      // el anfitrión (loopback) no se ve afectado
      nodeAssert.equal(json(await peticion({ path: '/api/info' })).role, 'presenter');
    }, { requiereLan: true });
  });
});

await grupo('Cabecera Host (defensa contra DNS rebinding)', async () => {
  const { hostnameOf, HostGuard } = await import('../../server/hosts.js');
  const propio = os.hostname().toLowerCase();

  await prueba('hostnameOf extrae el nombre y descarta cabeceras mal formadas', async () => {
    nodeAssert.equal(hostnameOf('Localhost:8080'), 'localhost');
    nodeAssert.equal(hostnameOf('LOCALHOST.:8080'), 'localhost');
    nodeAssert.equal(hostnameOf('192.168.1.5:8080'), '192.168.1.5');
    nodeAssert.equal(hostnameOf('[::1]:8080'), '::1');
    nodeAssert.equal(hostnameOf('[::1]'), '::1');
    nodeAssert.equal(hostnameOf('pc-henry'), 'pc-henry');
    for (const malo of ['', '   ', '[::1', '[::1]x', 'a:b:c', 'evil.com:abc', 'evil.com:123456', undefined, null, 'x'.repeat(300)]) {
      nodeAssert.equal(hostnameOf(malo), null, `"${String(malo).slice(0, 20)}" debe ser inválida`);
    }
  });

  await prueba('HostGuard acepta IP, localhost, el nombre de la PC y ALLOWED_HOSTS; rechaza dominios ajenos', async () => {
    const g = new HostGuard({ extra: ['pc-oficina.lan', '*.empresa.test'], hostname: 'PC-Henry' });
    for (const ok of ['localhost:80', 'a.localhost', '127.0.0.1:8080', '10.0.0.7', '[::1]:8080', '[fe80::1]', 'pc-henry', 'pc-henry.local:8080',
      'pc-oficina.lan', 'PC-Oficina.LAN:9000', 'x.empresa.test', 'a.b.empresa.test']) {
      assert(g.allows(ok), `debe aceptar "${ok}"`);
    }
    assert(g.allows(undefined), 'sin cabecera Host (HTTP/1.0) se acepta: ningún navegador lo hace');
    for (const mal of ['evil.example', 'evil.example:8080', 'localhost.evil.example', '127.0.0.1.evil.example', 'pc-henry.evil.example',
      'empresa.test', 'xempresa.test', 'evil.pc-oficina.lan', 'localhost@evil.example', '', 'a:b:c', '.localhost']) {
      assert(!g.allows(mal), `debe rechazar "${mal}"`);
    }
  });

  await conServidor({}, async (srv) => {
    const evil = `evil.example:${PORT}`;
    const ataque = { Host: evil, Origin: `http://${evil}` }; // un rebinding real: Host == Origin == dominio del atacante

    await prueba('con Host/Origin de otro dominio (rebinding) la subida, el borrado y el rol se rechazan aunque el socket sea loopback', async () => {
      const real = await peticion({
        method: 'POST', path: '/api/models',
        headers: { ...ataque, 'Content-Type': 'multipart/form-data; boundary=----h' },
        body: Buffer.concat([
          Buffer.from('------h\r\nContent-Disposition: form-data; name="file"; filename="rebinding.ifc"\r\nContent-Type: application/octet-stream\r\n\r\n'),
          IFC4,
          Buffer.from('\r\n------h--\r\n'),
        ]),
      });
      nodeAssert.equal(real.status, 403, `POST con Host ajeno: ${real.status}`);
      assert(/ALLOWED_HOSTS/.test(json(real).error), `el mensaje debe explicar cómo permitir el nombre: ${real.text}`);
      nodeAssert.deepEqual(await (await fetch(`${LOCAL}/api/models`)).json(), [], 'no debe haberse guardado ningún modelo');

      const info = await peticion({ path: '/api/info', headers: ataque });
      nodeAssert.equal(info.status, 403, 'ni siquiera /api/info con Host ajeno');
      assert(!/presenter/.test(info.text), 'no debe revelar el rol de presentador');
      for (const [method, ruta] of [['DELETE', '/api/models/abcdefghij'], ['PATCH', '/api/models/abcdefghij'], ['PUT', '/api/views'], ['GET', '/api/models'], ['GET', '/'], ['GET', '/js/main.js']]) {
        const x = await peticion({ method, path: ruta, headers: ataque });
        nodeAssert.equal(x.status, 403, `${method} ${ruta} con Host ajeno: ${x.status}`);
      }
    });

    await prueba('WebSocket con Host/Origin de otro dominio se rechaza con 403 (no llega a ser presentador)', async () => {
      await nodeAssert.rejects(conectarWs({ headers: ataque, name: 'Rebinding', wantRole: 'presenter' }), /403/);
    });

    await prueba('los Host legítimos siguen funcionando: localhost, 127.0.0.1, [::1], IP de red, nombre de la PC', async () => {
      const validos = ['localhost', `localhost:${PORT}`, '127.0.0.1', `127.0.0.1:${PORT}`, `[::1]:${PORT}`, 'foo.localhost', propio, `${propio}.local:${PORT}`];
      if (LAN_IP) validos.push(`${LAN_IP}:${PORT}`);
      for (const host of validos) {
        const r = await peticion({ path: '/api/info', headers: { Host: host } });
        nodeAssert.equal(r.status, 200, `Host ${host}: ${r.status} ${r.text.slice(0, 80)}`);
        nodeAssert.equal(json(r).role, 'presenter', `Host ${host} desde loopback`);
      }
      const ws = await conectarWs({ headers: { Host: `localhost:${PORT}`, Origin: `http://localhost:${PORT}` }, name: 'Local' });
      nodeAssert.equal(ws.welcome.role, 'presenter');
      // dominios que solo "parecen" locales
      for (const host of [`localhost.evil.example:${PORT}`, `127.0.0.1.evil.example:${PORT}`, `${propio}.evil.example`]) {
        const r = await peticion({ path: '/api/info', headers: { Host: host } });
        nodeAssert.equal(r.status, 403, `Host "${host}" debe rechazarse: ${r.status}`);
      }
    });

    await prueba('el rechazo se registra una sola vez por nombre, con la pista de ALLOWED_HOSTS', async () => {
      for (let i = 0; i < 3; i++) await peticion({ path: '/api/info', headers: { Host: 'raro.example' } });
      const veces = srv.log().split('"raro.example"').length - 1;
      nodeAssert.equal(veces, 1, `se esperaba 1 aviso y hubo ${veces}`);
      assert(/ALLOWED_HOSTS/.test(srv.log()), 'el aviso debe nombrar ALLOWED_HOSTS');
    });
  });

  // Variable de entorno ALLOWED_HOSTS
  await conServidor({ env: { ALLOWED_HOSTS: 'pc-oficina.lan, *.empresa.test' } }, async () => {
    await prueba('ALLOWED_HOSTS añade nombres exactos y comodines *.dominio', async () => {
      for (const host of [`pc-oficina.lan:${PORT}`, 'visor.empresa.test', `a.b.empresa.test:${PORT}`]) {
        nodeAssert.equal((await peticion({ path: '/api/info', headers: { Host: host } })).status, 200, `Host ${host}`);
      }
      for (const host of ['empresa.test', 'visor.empresa.test.evil.example', 'otra.lan']) {
        nodeAssert.equal((await peticion({ path: '/api/info', headers: { Host: host } })).status, 403, `Host ${host}`);
      }
    });
  });
});

await grupo('Latido (ping/pong de WebSocket)', async () => {
  await conServidor({ env: { WS_HEARTBEAT_MS: '300' } }, async () => {
    await prueba('una conexión que no responde a los ping se termina; una normal se mantiene', async () => {
      const normal = await conectarWs({ name: 'Vivo' });
      const muerto = await conectarWs({ name: 'Muerto', autoPong: false }); // no responde a los ping
      const t0 = Date.now();
      // el servidor pasa de "vivo" a "sin respuesta" y termina la conexión en ~2 intervalos
      while (normal.cierre === null && Date.now() - t0 < 1800) await sleep(50);
      nodeAssert.equal(normal.cierre, null, 'la conexión que responde no debe cerrarse');
      normal.send({ t: 'ping' });
      await normal.espera('pong');
      const cl = await normal.espera('clients', { donde: (m) => !m.list.some((c) => c.id === muerto.id), timeout: 4000 });
      assert(cl.list.some((c) => c.id === normal.id), 'el cliente vivo sigue en la lista');
    });
  });
});

// ---------------------------------------------------------------- resumen

cerrarClientesWs();
const ok = resultados.filter((r) => r.estado === 'ok').length;
const fallos = resultados.filter((r) => r.estado === 'fallo');
const omitidas = resultados.filter((r) => r.estado === 'omitida').length;
console.log(`\nResumen: ${ok} correctas, ${fallos.length} con fallo, ${omitidas} omitidas (de ${resultados.length})`);
for (const f of fallos) console.log(`  FALLO: ${f.etiqueta}\n         ${String(f.err?.message || f.err).split('\n')[0]}`);
if (!LAN_IP) console.log('Aviso: no se encontró una IP de red no loopback; se omitieron las pruebas de rol viewer.');
process.exit(fallos.length ? 1 : 0);
