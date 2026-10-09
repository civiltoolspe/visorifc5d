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
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
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
