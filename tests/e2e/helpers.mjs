// Utilidades compartidas por las pruebas E2E.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const FIXTURES = path.join(ROOT, 'tests', 'fixtures');
export const OUTPUT = path.join(ROOT, 'tests', 'output');
fs.mkdirSync(OUTPUT, { recursive: true });

// Arranca el servidor real (server/index.js) en un puerto y carpeta de datos temporales.
export async function startServer({ port, env = {} } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-data-'));
  const p = port || 9000 + Math.floor(Math.random() * 900);
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    env: { ...process.env, PORT: String(p), HOST: '0.0.0.0', DATA_DIR: dataDir, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  const url = `http://127.0.0.1:${p}`;
  const t0 = Date.now();
  while (Date.now() - t0 < 15000) {
    try {
      const r = await fetch(`${url}/api/info`);
      if (r.ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  return {
    url, port: p, dataDir, child,
    log: () => log,
    async stop() {
      child.kill();
      await new Promise((r) => setTimeout(r, 200));
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

// Chromium sin cabeza con WebGL2 por software (SwiftShader).
export async function launchBrowser() {
  return chromium.launch({
    // --proxy-server=direct://: las pruebas son solo locales; un proxy del entorno (HTTPS_PROXY) rechaza
    // los WebSocket hacia la IP de red de esta máquina (192.0.2.2 en el contenedor) con un 403.
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--proxy-server=direct://'],
  });
}

// Abre una página y recoge errores de consola/página.
export async function openPage(browser, url, { viewport = { width: 1600, height: 900 } } = {}) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  await page.goto(url);
  return { context, page, errors };
}

// Sube un archivo de fixtures al servidor (como presentador, desde loopback).
export async function uploadFixture(serverUrl, relPath) {
  const file = path.join(FIXTURES, relPath);
  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(file)]), path.basename(file));
  const r = await fetch(`${serverUrl}/api/models`, { method: 'POST', body: form });
  if (!r.ok) throw new Error(`upload ${relPath}: ${r.status} ${await r.text()}`);
  return r.json();
}

export function assert(cond, msg) {
  if (!cond) throw new Error(`Aserción fallida: ${msg}`);
}

export async function waitFor(fn, { timeout = 60000, interval = 200, label = 'condición' } = {}) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeout) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) { last = e; }
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`Tiempo agotado esperando ${label} (último: ${last})`);
}

// ---------------------------------------------------------------------------
// Ayudas para las pruebas de la aplicación completa (tests/e2e/app.test.mjs y presentation.test.mjs)
// ---------------------------------------------------------------------------

// Primera IPv4 no interna de esta máquina (la que verían las otras PCs) o null si no hay.
export function lanIp() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) if (ni.family === 'IPv4' && !ni.internal) return ni.address;
  }
  return null;
}

// Copia JSON de un slice del store de la página.
export function getSlice(page, slice) {
  return page.evaluate((s) => JSON.parse(JSON.stringify(window.__visor.store.get(s))), slice);
}

// Espera a que la app monte y cargue los modelos indicados ({ ifc, cad } = cantidad).
export async function waitForApp(page, { ifc = 0, cad = 0, timeout = 90000 } = {}) {
  await page.waitForFunction(() => document.documentElement.dataset.ready === 'true', null, { timeout: 30000 });
  await waitFor(
    () => page.evaluate(({ ifc, cad }) => {
      const v = window.__visor;
      const loading = Object.values(v.store.get('loading') || {});
      return v.ifc.getModels().length === ifc && v.cad.getModels().length === cad && !loading.some((l) => l.phase !== 'done' && l.phase !== 'error');
    }, { ifc, cad }),
    { timeout, label: `carga de ${ifc} IFC y ${cad} CAD` },
  );
  await page.waitForTimeout(300);
}

// Cuenta elementos IFC por estado de dibujo: 0 normal, 1 fantasma, 2 oculto, 3 seleccionado, 4 hover.
export function elementStates(page, modelId = null) {
  return page.evaluate((only) => {
    const v = window.__visor;
    const out = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, total: 0 };
    for (const m of v.ifc.getModels()) {
      if (only && m.id !== only) continue;
      for (let i = 0; i < m.table.count; i++) {
        out[v.ifc.getElementState(m.id, m.table.expressIds[i])] += 1;
        out.total += 1;
      }
    }
    return out;
  }, modelId);
}

// Busca un píxel del lienzo (coordenadas de la página) sobre el que el visor encuentre un elemento IFC.
// opts: { x0, x1, y0, y1, step, type /* p. ej. 'IFCWALL' */, skip /* nº de aciertos a saltar */, far: { px, py, minDist } }
export function findIfcPixel(page, opts = {}) {
  return page.evaluate((o) => {
    const v = window.__visor;
    const r = v.viewer.canvas.getBoundingClientRect();
    const { x0 = 430, x1 = 1100, y0 = 170, y1 = 560, step = 12, type = null, far = null } = o;
    let skip = o.skip || 0;
    for (let py = y0; py < y1; py += step) {
      for (let px = x0; px < x1; px += step) {
        const ndc = { x: ((px - r.left) / r.width) * 2 - 1, y: -(((py - r.top) / r.height) * 2 - 1) };
        const h = v.viewer.pick(ndc, { kinds: ['ifc'] });
        if (!h || h.expressId == null) continue;
        const info = v.ifc.getElementInfo(h.modelId, h.expressId);
        if (type && info?.type !== type) continue;
        if (far && Math.hypot(px - far.px, py - far.py) < far.minDist) continue; // al menos minDist px del punto `far`
        if (skip-- > 0) continue;
        return { px, py, modelId: h.modelId, expressId: h.expressId, info };
      }
    }
    return null;
  }, opts);
}

// Espera a que el visor deje de redibujar Y a que su cámara no tenga ningún movimiento pendiente (amortiguado de los
// controles o seguimiento). Solo mirar el contador de dibujos no basta: con WebGL por software y el equipo cargado un
// fotograma puede tardar más que `quietMs`, y la espera acababa con la cámara a medio amortiguar. Si se agota `timeout`
// vuelve sin avisar; cuando el resultado importa (p. ej. se va a comparar una cámara) usar waitCameraSettled.
export async function waitIdle(page, quietMs = 400, timeout = 8000) {
  const t0 = Date.now();
  let last = -1;
  let since = Date.now();
  while (Date.now() - t0 < timeout) {
    const { n, moving } = await page.evaluate(() => {
      const v = window.__visor.viewer;
      return { n: v.renderCount, moving: typeof v.isCameraMoving === 'function' ? v.isCameraMoving() : false };
    });
    if (n !== last || moving) { last = n; since = Date.now(); } else if (Date.now() - since >= quietMs) return;
    await new Promise((r) => setTimeout(r, 100));
  }
}

// Espera a que la cámara de la página se asiente (sin amortiguado ni seguimiento pendientes) de forma estable durante
// `quietMs`. A diferencia de waitIdle, LANZA si no se asienta en `timeout` (el tiempo es generoso: con la CPU saturada
// cada fotograma por software puede tardar ~1 s y el amortiguado necesita unos 15). Devuelve el estado final de la cámara.
export async function waitCameraSettled(page, { quietMs = 500, timeout = 60000, label = 'la cámara' } = {}) {
  const t0 = Date.now();
  let since = null;
  while (Date.now() - t0 < timeout) {
    const moving = await page.evaluate(() => window.__visor.viewer.isCameraMoving());
    if (moving) since = null;
    else if (since === null) since = Date.now();
    else if (Date.now() - since >= quietMs) return page.evaluate(() => window.__visor.viewer.getCameraState());
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Tiempo agotado esperando que ${label} se asiente`);
}

// Distancia máxima entre dos CameraState (posición y objetivo, en metros) y diferencia de zoom relativa.
export function cameraDistance(a, b) {
  const d = (p, q) => Math.max(...p.map((v, i) => Math.abs(v - q[i])));
  return Math.max(d(a.position, b.position), d(a.target, b.target));
}
