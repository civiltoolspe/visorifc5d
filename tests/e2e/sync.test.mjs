// Prueba E2E del módulo SINCRONIZACIÓN / MODO PRESENTACIÓN + cargador de modelos.
// Uso: node tests/e2e/sync.test.mjs   (puerto 8105)
// Termina con código 0 si todo pasa y 1 si algo falla.
//
// El servidor WebSocket de la prueba es un doble mínimo con el paquete "ws" que sigue el protocolo
// del contrato (docs/ARQUITECTURA.md, sección 4). Los estáticos los sirve tests/devserver.mjs
// (el mismo servidor HTTP atiende la mejora a WebSocket en /ws).

import { WebSocketServer } from 'ws';
import { startDevServer } from '../devserver.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { launchBrowser, openPage, assert, waitFor, startServer, uploadFixture, FIXTURES } from './helpers.mjs';

const PORT = 8105;
const BASE = `http://127.0.0.1:${PORT}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------------------------
// Servidor WebSocket falso (protocolo del contrato)
// ---------------------------------------------------------------------------------------------
class FakeHub {
  constructor(httpServer) {
    this.wss = new WebSocketServer({ noServer: true });
    this.conns = new Map(); // id -> conexión registrada
    this.log = []; // { id, name, msg } todo lo que llega de los clientes
    this.presentation = { active: false, presenterId: null, presenterName: '' };
    this.lastState = {};
    this.lastCamera = null;
    this.models = [];
    this.config = { viewerFreeNav: true };
    this._seq = 0;
    httpServer.on('upgrade', (req, socket, head) => {
      if (new URL(req.url, 'http://x').pathname !== '/ws') {
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this._connect(ws));
    });
  }

  _connect(ws) {
    const conn = { ws, id: null, name: '', role: null };
    ws.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString('utf8'));
      } catch {
        return this._send(conn, { t: 'error', message: 'Mensaje inválido: no es JSON' });
      }
      this.log.push({ id: conn.id, name: conn.name || msg.name, msg });
      this._handle(conn, msg);
    });
    ws.on('close', () => {
      if (!conn.id || this.conns.get(conn.id) !== conn) return;
      this.conns.delete(conn.id);
      if (this.presentation.active && this.presentation.presenterId === conn.id) this._endPresentation();
      this._broadcastClients();
    });
  }

  _send(conn, obj) {
    if (conn.ws.readyState === 1) conn.ws.send(JSON.stringify(obj));
  }

  _broadcast(obj, exceptId = null) {
    for (const c of this.conns.values()) if (c.id !== exceptId) this._send(c, obj);
  }

  _clientsInfo() {
    const list = [...this.conns.values()].map((c) => ({ id: c.id, name: c.name, role: c.role }));
    const hasPresenter = this.presentation.active && this.conns.has(this.presentation.presenterId);
    return { viewers: list.length - (hasPresenter ? 1 : 0), list };
  }

  _broadcastClients() {
    this._broadcast({ t: 'clients', ...this._clientsInfo() });
  }

  _presentationInfo() {
    const { active, presenterId, presenterName } = this.presentation;
    return { active, presenterId, presenterName };
  }

  _endPresentation() {
    this.presentation = { active: false, presenterId: null, presenterName: '' };
    this.lastState = {};
    this.lastCamera = null;
    this._broadcast({ t: 'presentation', ...this._presentationInfo() });
  }

  _handle(conn, msg) {
    if (msg.t === 'ping') return this._send(conn, { t: 'pong' });
    if (msg.t === 'hello') return this._hello(conn, msg);
    if (!conn.id) return this._send(conn, { t: 'error', message: 'Debes enviar "hello" primero' });
    const mutating = ['presentation', 'take-control', 'state', 'camera', 'pointer'];
    if (mutating.includes(msg.t) && conn.role !== 'presenter') {
      return this._send(conn, { t: 'error', message: 'Solo el presentador puede hacer eso' });
    }
    const isActive = this.presentation.active && this.presentation.presenterId === conn.id;
    switch (msg.t) {
      case 'presentation':
        if (msg.active) {
          if (this.presentation.active) {
            return this._send(conn, { t: 'error', message: 'Ya hay una presentación activa; usa "tomar el control"' });
          }
          this.presentation = { active: true, presenterId: conn.id, presenterName: conn.name };
          this.lastState = {};
          this.lastCamera = null;
          this._broadcast({ t: 'presentation', ...this._presentationInfo() });
          this._broadcastClients();
        } else if (this.presentation.active) {
          this._endPresentation();
          this._broadcastClients();
        } else {
          this._send(conn, { t: 'presentation', ...this._presentationInfo() });
        }
        return undefined;
      case 'take-control':
        if (!this.presentation.active) return this._send(conn, { t: 'error', message: 'No hay una presentación activa' });
        this.presentation = { active: true, presenterId: conn.id, presenterName: conn.name };
        this._broadcast({ t: 'presentation', ...this._presentationInfo() });
        this._broadcastClients();
        return undefined;
      case 'state':
        if (!isActive) return this._send(conn, { t: 'error', message: 'No hay una presentación activa' });
        if (msg.full) this.lastState = {};
        Object.assign(this.lastState, msg.slices);
        this._broadcast({ t: 'state', slices: msg.slices, full: !!msg.full }, conn.id);
        return undefined;
      case 'camera':
        if (!isActive) return this._send(conn, { t: 'error', message: 'No hay una presentación activa' });
        this.lastCamera = msg.cam;
        this._broadcast({ t: 'camera', cam: msg.cam }, conn.id);
        return undefined;
      case 'pointer':
        if (!isActive) return this._send(conn, { t: 'error', message: 'No hay una presentación activa' });
        this._broadcast({ t: 'pointer', p: msg.p }, conn.id);
        return undefined;
      default:
        return this._send(conn, { t: 'error', message: `Mensaje desconocido: ${msg.t}` });
    }
  }

  _hello(conn, msg) {
    if (!conn.id) {
      conn.role = msg.wantRole === 'viewer' ? 'viewer' : 'presenter'; // todo es loopback
      conn.id = `c${++this._seq}`;
      conn.name = String(msg.name || `Espectador ${this._seq}`);
      this.conns.set(conn.id, conn);
      this._send(conn, {
        t: 'welcome',
        clientId: conn.id,
        role: conn.role,
        presentation: this._presentationInfo(),
        state: this.presentation.active ? this.lastState : {},
        camera: this.presentation.active ? this.lastCamera : null,
        models: this.models,
        clients: this._clientsInfo(),
        viewerFreeNav: this.config.viewerFreeNav,
      });
      this._broadcastClients();
      return;
    }
    // hello posterior: cambio de nombre
    const name = String(msg.name || conn.name);
    if (name !== conn.name) {
      conn.name = name;
      if (this.presentation.active && this.presentation.presenterId === conn.id) {
        this.presentation.presenterName = name;
        this._broadcast({ t: 'presentation', ...this._presentationInfo() });
      }
      this._broadcastClients();
    }
  }

  // ---------- Ayudas para la prueba ----------
  msgs(id, t) {
    return this.log.filter((e) => e.id === id && (!t || e.msg.t === t)).map((e) => e.msg);
  }

  helloOf(name) {
    return this.log.filter((e) => e.msg.t === 'hello' && e.msg.name === name).map((e) => e.msg);
  }

  kick(id) {
    this.conns.get(id)?.ws.terminate();
  }

  sendTo(id, obj) {
    const c = this.conns.get(id);
    if (c) this._send(c, obj);
  }

  sendRaw(id, text) {
    const c = this.conns.get(id);
    if (c && c.ws.readyState === 1) c.ws.send(text);
  }

  broadcastModels(models) {
    this.models = models;
    this._broadcast({ t: 'models', models });
  }

  close() {
    for (const c of this.conns.values()) c.ws.terminate();
    this.wss.close();
  }
}

// ---------------------------------------------------------------------------------------------
// Marco de pruebas
// ---------------------------------------------------------------------------------------------
const results = [];
async function step(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  OK     ${name} (${Date.now() - t0} ms)`);
  } catch (err) {
    results.push({ name, ok: false, error: err });
    console.log(`  FALLA  ${name}\n         ${err.message}`);
  }
}

const near = (a, b, tol, msg) => assert(Math.abs(a - b) <= tol, `${msg} (esperado ${b}, obtenido ${a}, tol ${tol})`);

const server = await startDevServer(PORT);
const hub = new FakeHub(server);
const browser = await launchBrowser();
const opened = []; // contextos abiertos, para cerrarlos al final

async function openSync(query = '', viewport = { width: 1100, height: 700 }) {
  const o = await openPage(browser, `${BASE}/dev/sync.html?${query}`, { viewport });
  opened.push(o);
  await o.page.waitForFunction(() => window.__ready === true, null, { timeout: 90000 });
  return o;
}

const pres = (page) => page.evaluate(() => ({ ...window.__t.store.get('presentation') }));
const waitPres = (page, pred, label, timeout = 8000) =>
  waitFor(async () => pred(await pres(page)), { timeout, interval: 40, label });
const inputOf = (page) => page.evaluate(() => window.__t.viewer.inputEnabled);
const calls = (page) => page.evaluate(() => JSON.parse(JSON.stringify(window.__t.viewer.calls)));
const storeGet = (page, slice) => page.evaluate((s) => JSON.parse(JSON.stringify(window.__t.store.get(s))), slice);

let exitCode = 0;
let serversOpen = true;
try {
  console.log('Prueba de sincronización y modo presentación');

  // ===========================================================================================
  // Parte 1: SyncClient + Presentation con el hub falso
  // ===========================================================================================
  const P = await openSync('name=Anfitrion&w=1000&h=500&ping=300'); // presentador, aspecto 2
  const V = await openSync('role=viewer&name=Ana&pin=1234&w=800&h=600'); // espectador, aspecto 1,333
  const pPage = P.page;
  const vPage = V.page;
  let pId;
  let vId;

  await step('backoff exponencial 0,5 s → 5 s con jitter', async () => {
    const d = await vPage.evaluate(async () => {
      const { SyncClient } = await import('/js/sync/SyncClient.js');
      const f = SyncClient.backoffDelay;
      return {
        a0lo: f(0, 0), a0hi: f(0, 0.999), a1: f(1, 1), a2: f(2, 1), a3: f(3, 1), a4lo: f(4, 0), a4hi: f(4, 1), a9: f(9, 1), a30: f(30, 1),
      };
    });
    assert(d.a0lo >= 350 && d.a0lo <= 400, `primer intento mínimo ${d.a0lo}`);
    assert(d.a0hi <= 500 && d.a0hi >= 450, `primer intento máximo ${d.a0hi}`);
    assert(d.a1 === 1000 && d.a2 === 2000 && d.a3 === 4000, `escalado 1 s → 2 s → 4 s (${d.a1}, ${d.a2}, ${d.a3})`);
    assert(d.a4lo >= 3500 && d.a4hi === 5000, `tope de 5 s (${d.a4lo}, ${d.a4hi})`);
    assert(d.a9 === 5000 && d.a30 === 5000, 'el tope se mantiene');
  });

  await step('welcome actualiza store.presentation (presentador y espectador)', async () => {
    await waitPres(pPage, (p) => p.connected && p.clientId, 'presentador conectado');
    await waitPres(vPage, (p) => p.connected && p.clientId, 'espectador conectado');
    const p = await pres(pPage);
    const v = await pres(vPage);
    pId = p.clientId;
    vId = v.clientId;
    assert(p.role === 'presenter', `rol del presentador: ${p.role}`);
    assert(v.role === 'viewer', `rol del espectador: ${v.role}`);
    assert(p.active === false && p.isActivePresenter === false && p.presenterId === null, 'sin presentación activa');
    assert(typeof pId === 'string' && pId && pId !== vId, 'clientId distintos');
    assert(v.viewerFreeNav === true, 'viewerFreeNav del servidor');
    await waitPres(pPage, (x) => x.viewers === 2, 'contador de clientes (2)');
    // eventos del bus
    const evs = await pPage.evaluate(() => window.__t.events.map((e) => e.evt));
    assert(evs.includes('sync:status') && evs.includes('sync:welcome') && evs.includes('sync:clients') && evs.includes('server:models'),
      `eventos emitidos: ${evs.join(',')}`);
  });

  await step('hello: nombre, wantRole y PIN', async () => {
    const hp = hub.helloOf('Anfitrion')[0];
    const hv = hub.helloOf('Ana')[0];
    assert(hp && hp.wantRole === undefined && hp.pin === undefined, `hello del presentador: ${JSON.stringify(hp)}`);
    assert(hv && hv.wantRole === 'viewer' && hv.pin === '1234', `hello del espectador: ${JSON.stringify(hv)}`);
    // nombre por defecto PC-xxxx (contexto nuevo sin nombre guardado)
    const extra = await openSync('noconnect=1');
    const name = await extra.page.evaluate(() => window.__t.sync.getName());
    assert(/^PC-[A-Z0-9]{4}$/.test(name), `nombre por defecto: ${name}`);
    const saved = await extra.page.evaluate(() => localStorage.getItem('visor.name'));
    assert(saved === name, 'el nombre generado se guarda en localStorage');
    await extra.context.close();
  });

  await step('setName guarda y reenvía hello si hay conexión', async () => {
    const before = hub.helloOf('Anfitrion').length;
    const out = await pPage.evaluate(() => {
      window.__t.sync.setName('Host');
      return localStorage.getItem('visor.name');
    });
    assert(out === 'Host', 'se guarda en localStorage');
    await waitFor(() => hub.helloOf('Host').length === 1, { timeout: 3000, label: 'hello con el nombre nuevo' });
    assert(before === 1, 'hello inicial único');
  });

  await step('latido: ping periódico al servidor', async () => {
    await waitFor(() => hub.msgs(pId, 'ping').length >= 2, { timeout: 4000, label: '2 pings' });
  });

  await step('sin presentación el espectador navega libremente', async () => {
    assert((await inputOf(vPage)) === true, 'entrada habilitada');
    const c = await calls(vPage);
    assert(!c.enableInput.includes(false), `nunca se bloqueó: ${JSON.stringify(c.enableInput)}`);
  });

  await step('iniciar presentación: confirmación, estado completo y cámara', async () => {
    await pPage.evaluate(() => {
      const { actions, store, viewer } = window.__t;
      actions.select([{ modelId: 'm1', expressId: 7 }]);
      actions.setGhostOpacity(0.33);
      store.set('models', { m1: { visible: true } });
      viewer.cam = { position: [11, 12, 13], target: [1, 2, 3], projection: 'perspective', zoom: 1, fov: 45 };
      window.__t.presentation.start();
    });
    await waitPres(pPage, (p) => p.active && p.isActivePresenter, 'presentador activo');
    await waitPres(vPage, (p) => p.active && !p.isActivePresenter && p.presenterName === 'Host', 'espectador ve la presentación');
    const full = await waitFor(() => hub.msgs(pId, 'state').find((m) => m.full === true), { timeout: 4000, label: 'state full' });
    const keys = Object.keys(full.slices).sort().join(',');
    assert(keys === 'cad,display,measure,models,section,selection,storey,ui,views,visibility', `slices del estado completo: ${keys}`);
    assert(full.slices.selection.items[0].expressId === 7 && full.slices.display.ghostOpacity === 0.33, 'valores del estado completo');
    const cam = await waitFor(() => hub.msgs(pId, 'camera')[0], { timeout: 4000, label: 'cámara inicial' });
    assert(JSON.stringify(cam.cam.position) === '[11,12,13]', 'cámara inicial del presentador');
    // el hub falso solo acepta el estado tras la confirmación: orden presentation → state → camera
    const order = hub.log.filter((e) => e.id === pId && ['presentation', 'state', 'camera'].includes(e.msg.t)).map((e) => e.msg.t);
    assert(order.slice(0, 3).join(',') === 'presentation,state,camera', `orden de envío: ${order.join(',')}`);

    // el espectador aplica el estado como 'remote'
    await waitFor(async () => (await storeGet(vPage, 'selection')).items?.[0]?.expressId === 7, { timeout: 4000, label: 'selección en el espectador' });
    assert((await storeGet(vPage, 'display')).ghostOpacity === 0.33, 'display remoto');
    assert((await storeGet(vPage, 'models')).m1?.visible === true, 'models remoto');
    const log = await vPage.evaluate(() => window.__t.storeLog.filter((e) => e.slices.includes('selection')));
    assert(log.length && log.every((e) => e.source === 'remote'), `origen de los cambios: ${JSON.stringify(log)}`);
    await waitFor(async () => (await calls(vPage)).followCamera.length > 0, { timeout: 4000, label: 'followCamera' });
    const fc = (await calls(vPage)).followCamera.at(-1);
    assert(JSON.stringify(fc.position) === '[11,12,13]' && JSON.stringify(fc.target) === '[1,2,3]', 'followCamera con la cámara del presentador');
    // bloqueo
    assert((await inputOf(vPage)) === false, 'espectador bloqueado');
    assert((await inputOf(pPage)) === true, 'presentador no bloqueado');
  });

  await step('difusión agrupada: solo los slices cambiados, en un único mensaje', async () => {
    const before = hub.msgs(pId, 'state').length;
    await pPage.evaluate(() => {
      const { actions } = window.__t;
      actions.select([{ modelId: 'm1', expressId: 8 }, { modelId: 'm1', expressId: 9 }]);
      actions.toggleEdges(false);
      actions.setTab('props');
    });
    await sleep(250);
    const msgs = hub.msgs(pId, 'state').slice(before);
    assert(msgs.length === 1, `mensajes de estado: ${msgs.length}`);
    assert(msgs[0].full === false, 'no es completo');
    assert(Object.keys(msgs[0].slices).sort().join(',') === 'display,selection,ui', `slices: ${Object.keys(msgs[0].slices)}`);
    await waitFor(async () => (await storeGet(vPage, 'selection')).items.length === 2, { timeout: 3000, label: 'selección remota' });
    assert((await storeGet(vPage, 'display')).edges === false, 'aristas remotas');
    assert((await storeGet(vPage, 'ui')).tab === 'props', 'pestaña remota');
  });

  await step('sin eco: los cambios con source remote no se reenvían', async () => {
    const before = hub.msgs(pId, 'state').length;
    await pPage.evaluate(() => {
      window.__t.store.setMany({ section: { enabled: true, min: [0, 0, 0], max: [1, 1, 1] } }, { source: 'remote' });
    });
    await sleep(200);
    assert(hub.msgs(pId, 'state').length === before, 'no se envió nada');
    // control: un cambio local sí se envía
    await pPage.evaluate(() => window.__t.actions.setSection({ enabled: false }));
    await waitFor(() => hub.msgs(pId, 'state').length === before + 1, { timeout: 2000, label: 'cambio local enviado' });
  });

  await step('cámara: throttle ~50 ms y envío final', async () => {
    const before = hub.msgs(pId, 'camera').length;
    await pPage.evaluate(async () => {
      for (let i = 1; i <= 24; i++) {
        window.__t.viewer.moveCamera({ position: [i, i, i] });
        await new Promise((r) => setTimeout(r, 6));
      }
    });
    await sleep(300);
    const sent = hub.msgs(pId, 'camera').slice(before);
    assert(sent.length >= 2 && sent.length <= 8, `cámaras enviadas: ${sent.length} (24 eventos en ~150 ms)`);
    assert(JSON.stringify(sent.at(-1).cam.position) === '[24,24,24]', 'el último mensaje es la cámara final');
    await waitFor(async () => JSON.stringify((await calls(vPage)).followCamera.at(-1).position) === '[24,24,24]', { timeout: 3000, label: 'cámara final en el espectador' });
  });

  await step('láser: posición corregida por aspecto y capa superpuesta', async () => {
    // Presentador (aspecto 2) apunta a x=0.5, y=-0.25; espectador (aspecto 4/3): x' = 0.75
    await pPage.evaluate(() => window.__t.viewer.movePointer(0.5, -0.25));
    await waitFor(async () => (await vPage.evaluate(() => window.__t.presentation.laser.getState().visible)), { timeout: 3000, label: 'láser visible' });
    const st = await vPage.evaluate(() => window.__t.presentation.laser.getState());
    near(st.ndcX, 0.75, 1e-3, 'ndc x corregido');
    near(st.ndcY, -0.25, 1e-3, 'ndc y');
    near(st.px, 700, 1.5, 'px x');
    near(st.py, 375, 1.5, 'px y');
    assert(!st.offscreen, 'dentro del visor');
    // la capa es un canvas dentro del contenedor del visor, sin capturar eventos
    const layer = await vPage.evaluate(() => {
      const c = document.querySelector('canvas.visor-laser');
      const parent = window.__t.viewer.renderer.domElement.parentElement;
      return c && { inParent: c.parentElement === parent, pe: getComputedStyle(c).pointerEvents };
    });
    assert(layer && layer.inParent && layer.pe === 'none', `capa láser: ${JSON.stringify(layer)}`);
    // el punto rojo se dibuja donde corresponde (se espera a que el suavizado converja)
    await sleep(500);
    const px = await vPage.evaluate(() => {
      const c = document.querySelector('canvas.visor-laser');
      const dpr = c.width / c.clientWidth;
      const d = c.getContext('2d').getImageData(Math.round(700 * dpr), Math.round(375 * dpr), 1, 1).data;
      const far = c.getContext('2d').getImageData(Math.round(100 * dpr), Math.round(100 * dpr), 1, 1).data;
      return { r: d[0], g: d[1], b: d[2], a: d[3], farA: far[3] };
    });
    assert(px.r > 200 && px.g < 110 && px.b < 110 && px.a > 200, `píxel central rojo: ${JSON.stringify(px)}`);
    assert(px.farA === 0, 'el resto de la capa es transparente');
    // fuera del visor local: se ancla al borde y se marca
    await pPage.evaluate(() => window.__t.viewer.movePointer(0.9, 0));
    await waitFor(async () => (await vPage.evaluate(() => window.__t.presentation.laser.getState())).offscreen, { timeout: 3000, label: 'láser fuera' });
    const off = await vPage.evaluate(() => window.__t.presentation.laser.getState());
    near(off.px, 800, 1.5, 'anclado al borde derecho');
  });

  await step('láser: latido con el puntero quieto y visible:false al salir', async () => {
    const before = hub.msgs(pId, 'pointer').length;
    await sleep(2300);
    const beats = hub.msgs(pId, 'pointer').slice(before);
    assert(beats.length >= 2 && beats.every((m) => m.p.visible === true && m.p.aspect === 2), `latidos: ${beats.length}`);
    await pPage.evaluate(() => window.__t.viewer.leavePointer());
    await waitFor(() => hub.msgs(pId, 'pointer').at(-1)?.p.visible === false, { timeout: 2000, label: 'visible:false' });
    await waitFor(async () => !(await vPage.evaluate(() => window.__t.presentation.laser.getState().visible)), { timeout: 3000, label: 'láser oculto' });
    // tras el desvanecimiento no queda nada dibujado
    await sleep(500);
    const a = await vPage.evaluate(() => {
      const c = document.querySelector('canvas.visor-laser');
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let max = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i] > max) max = d[i];
      return max;
    });
    assert(a === 0, `capa vacía tras ocultarse (alfa máx. ${a})`);
    // sin más movimientos no hay más mensajes (el latido se detuvo)
    const n = hub.msgs(pId, 'pointer').length;
    await sleep(1300);
    assert(hub.msgs(pId, 'pointer').length === n, 'el latido se detuvo');
  });

  await step('láser: se oculta tras 3 s sin mensajes', async () => {
    hub.sendTo(vId, { t: 'pointer', p: { x: 0, y: 0, aspect: 4 / 3, visible: true } });
    await waitFor(async () => vPage.evaluate(() => window.__t.presentation.laser.getState().visible), { timeout: 2000, label: 'visible' });
    await sleep(2300);
    assert(await vPage.evaluate(() => window.__t.presentation.laser.getState().visible), 'sigue visible a los 2,3 s');
    await waitFor(async () => !(await vPage.evaluate(() => window.__t.presentation.laser.getState().visible)), { timeout: 2500, label: 'oculto por inactividad' });
  });

  await step('láser desactivado: no se envía puntero (visible:false una vez)', async () => {
    const before = hub.msgs(pId, 'pointer').length;
    await pPage.evaluate(() => window.__t.presentation.setLaser(false));
    await waitFor(() => hub.msgs(pId, 'pointer').length === before + 1, { timeout: 2000, label: 'visible:false' });
    assert(hub.msgs(pId, 'pointer').at(-1).p.visible === false, 'mensaje de ocultar');
    await pPage.evaluate(() => {
      window.__t.viewer.movePointer(0.1, 0.1);
      window.__t.viewer.movePointer(0.2, 0.2);
    });
    await sleep(250);
    assert(hub.msgs(pId, 'pointer').length === before + 1, 'sin más mensajes con el láser apagado');
    assert((await pres(pPage)).laser === false, 'store.presentation.laser = false');
    await pPage.evaluate(() => window.__t.presentation.setLaser(true));
    await pPage.evaluate(() => window.__t.viewer.movePointer(-0.5, 0.5));
    await waitFor(() => hub.msgs(pId, 'pointer').length === before + 2 && hub.msgs(pId, 'pointer').at(-1).p.visible, { timeout: 2000, label: 'láser de nuevo' });
    await pPage.evaluate(() => window.__t.viewer.leavePointer());
  });

  let v2;
  await step('espectador que entra durante la presentación recibe estado y cámara en welcome', async () => {
    v2 = await openSync('role=viewer&name=Beto&w=900&h=500');
    await waitPres(v2.page, (p) => p.connected && p.active && p.presenterName === 'Host', 'welcome con presentación activa');
    await waitFor(async () => (await storeGet(v2.page, 'selection')).items.length === 2, { timeout: 4000, label: 'estado del welcome' });
    assert((await storeGet(v2.page, 'ui')).tab === 'props', 'ui del welcome');
    const c = await calls(v2.page);
    assert(c.setCameraState.length >= 1, 'se aplicó la cámara del welcome');
    assert(c.setCameraState[0].opts.smooth === false, 'cámara inmediata (smooth:false)');
    assert(JSON.stringify(c.setCameraState[0].state.position) === '[24,24,24]', 'cámara del welcome = última del presentador');
    assert((await inputOf(v2.page)) === false, 'bloqueado desde el inicio');
    const log = await v2.page.evaluate(() => window.__t.storeLog.filter((e) => e.slices.includes('selection')));
    assert(log.every((e) => e.source === 'remote'), 'estado aplicado como remote');
  });

  let p2;
  let p2Id;
  await step('segundo presentador: bloqueado y siguiendo; tomar el control y devolverlo', async () => {
    p2 = await openSync('name=Segundo&w=1000&h=500');
    await waitPres(p2.page, (p) => p.connected && p.role === 'presenter' && p.active, 'segundo presentador conectado');
    p2Id = (await pres(p2.page)).clientId;
    let p = await pres(p2.page);
    assert(!p.isActivePresenter, 'no es el presentador activo');
    assert((await inputOf(p2.page)) === false, 'presentador no activo queda bloqueado mientras otro presenta');
    await waitFor(async () => (await storeGet(p2.page, 'selection')).items.length === 2, { timeout: 4000, label: 'sigue el estado' });

    // toma el control
    await p2.page.evaluate(() => window.__t.presentation.takeControl());
    await waitPres(p2.page, (x) => x.isActivePresenter, 'toma el control');
    await waitPres(pPage, (x) => x.active && !x.isActivePresenter && x.presenterName === 'Segundo', 'el original deja de ser activo');
    assert((await inputOf(p2.page)) === true, 'el nuevo presentador queda desbloqueado');
    assert((await inputOf(pPage)) === false, 'el anterior queda bloqueado');
    const full = await waitFor(() => hub.msgs(p2Id, 'state').find((m) => m.full), { timeout: 3000, label: 'estado completo del nuevo presentador' });
    assert(full.slices.selection.items.length === 2, 'estado completo del nuevo presentador');
    await waitFor(() => hub.msgs(p2Id, 'camera').length >= 1, { timeout: 3000, label: 'cámara del nuevo presentador' });

    // el anterior no envía nada más
    const nP = hub.log.filter((e) => e.id === pId && ['state', 'camera', 'pointer'].includes(e.msg.t)).length;
    await pPage.evaluate(() => {
      window.__t.actions.select([{ modelId: 'm1', expressId: 99 }]);
      window.__t.viewer.moveCamera({ position: [5, 5, 5] });
      window.__t.viewer.movePointer(0.3, 0.3);
    });
    await sleep(250);
    const nP2 = hub.log.filter((e) => e.id === pId && ['state', 'camera', 'pointer'].includes(e.msg.t)).length;
    assert(nP2 === nP, 'el presentador desplazado no difunde');
    // ... y los cambios del nuevo sí llegan a todos
    await p2.page.evaluate(() => window.__t.actions.select([{ modelId: 'm1', expressId: 55 }]));
    await waitFor(async () => (await storeGet(vPage, 'selection')).items[0]?.expressId === 55, { timeout: 3000, label: 'cambio del nuevo presentador' });
    await waitFor(async () => (await storeGet(pPage, 'selection')).items[0]?.expressId === 55, { timeout: 3000, label: 'el anterior también lo sigue' });

    // devuelve el control
    await pPage.evaluate(() => window.__t.presentation.takeControl());
    await waitPres(pPage, (x) => x.isActivePresenter, 'recupera el control');
    await waitPres(p2.page, (x) => x.active && !x.isActivePresenter, 'el segundo deja de ser activo');
    assert((await inputOf(pPage)) === true && (await inputOf(p2.page)) === false, 'bloqueos tras devolver el control');
    p = await pres(vPage);
    assert(p.presenterName === 'Host', 'el espectador ve de nuevo a Host');
  });

  await step('mensajes desconocidos o corruptos no rompen al cliente', async () => {
    hub.sendTo(vId, { t: 'zzz', x: 1 });
    hub.sendTo(vId, { sinT: true });
    hub.sendRaw(vId, 'esto no es json');
    hub.sendRaw(vId, '[1,2,3]');
    await sleep(150);
    await pPage.evaluate(() => window.__t.actions.select([{ modelId: 'm1', expressId: 1 }]));
    await waitFor(async () => (await storeGet(vPage, 'selection')).items[0]?.expressId === 1, { timeout: 3000, label: 'el espectador sigue funcionando' });
    const unknown = await vPage.evaluate(() => window.__t.events.filter((e) => e.evt === 'sync:unknown').length);
    assert(unknown === 1, `un mensaje desconocido notificado (${unknown})`);
    assert(V.errors.length === 0, `sin errores en la página: ${V.errors.join(' | ')}`);
  });

  await step('server:models y errores del servidor (aviso sin repetir)', async () => {
    const list = [{ id: 'abc', name: 'x.ifc', kind: 'ifc', size: 1, uploadedAt: new Date().toISOString(), georef: null, cad: null }];
    hub.broadcastModels(list);
    await waitFor(async () => vPage.evaluate(() => window.__t.events.some((e) => e.evt === 'server:models' && e.payload.length === 1 && e.payload[0].id === 'abc')), { timeout: 3000, label: 'server:models' });
    hub.sendTo(vId, { t: 'error', message: 'Falla de prueba' });
    hub.sendTo(vId, { t: 'error', message: 'Falla de prueba' });
    await sleep(200);
    const toasts = await vPage.evaluate(() => window.__t.events.filter((e) => e.evt === 'toast' && e.payload.message === 'Falla de prueba'));
    assert(toasts.length === 1 && toasts[0].payload.type === 'warning', `avisos: ${toasts.length}`);
  });

  await step('espectador nunca envía state/camera/pointer/presentation', async () => {
    const bad = hub.log.filter((e) => e.id === vId && ['state', 'camera', 'pointer', 'presentation', 'take-control'].includes(e.msg.t));
    assert(bad.length === 0, `mensajes de mutación del espectador: ${bad.length}`);
  });

  await step('detener: espectadores desbloqueados y el presentador no envía nada más', async () => {
    await pPage.evaluate(() => window.__t.presentation.stop());
    await waitPres(pPage, (x) => !x.active && !x.isActivePresenter, 'presentación detenida');
    await waitPres(vPage, (x) => !x.active, 'espectador ve el fin');
    assert((await hub.msgs(pId, 'presentation').at(-1).active) === false, 'se envió active:false');
    await waitFor(async () => (await inputOf(vPage)) === true, { timeout: 3000, label: 'espectador desbloqueado' });
    assert((await inputOf(v2.page)) === true, 'segundo espectador desbloqueado');
    assert((await inputOf(p2.page)) === true, 'presentador no activo desbloqueado');
    assert((await calls(vPage)).stopFollow >= 1, 'se detuvo el seguimiento de cámara');
    assert(!(await vPage.evaluate(() => window.__t.presentation.laser.getState().visible)), 'láser oculto');
    const n = hub.log.filter((e) => e.id === pId && ['state', 'camera', 'pointer'].includes(e.msg.t)).length;
    await pPage.evaluate(() => {
      window.__t.actions.select([{ modelId: 'm1', expressId: 123 }]);
      window.__t.viewer.moveCamera({ position: [9, 9, 9] });
      window.__t.viewer.movePointer(0.2, 0.2);
    });
    await sleep(250);
    const n2 = hub.log.filter((e) => e.id === pId && ['state', 'camera', 'pointer'].includes(e.msg.t)).length;
    assert(n2 === n, 'nada más tras detener');
    assert((await storeGet(vPage, 'selection')).items[0]?.expressId !== 123, 'el espectador no recibe cambios');
  });

  await step('viewerFreeNav=false: el espectador queda bloqueado sin presentación', async () => {
    hub.config.viewerFreeNav = false;
    const v3 = await openSync('role=viewer&name=Carla');
    await waitPres(v3.page, (p) => p.connected && p.viewerFreeNav === false, 'viewerFreeNav falso desde welcome');
    await waitFor(async () => (await inputOf(v3.page)) === false, { timeout: 3000, label: 'bloqueado sin presentación' });
    // al terminar una presentación sigue bloqueado
    await pPage.evaluate(() => window.__t.presentation.start());
    await waitPres(v3.page, (p) => p.active, 'presentación vista');
    await pPage.evaluate(() => window.__t.presentation.stop());
    await waitPres(v3.page, (p) => !p.active, 'fin de presentación');
    assert((await inputOf(v3.page)) === false, 'sigue bloqueado');
    // el presentador no se bloquea nunca por viewerFreeNav
    assert((await inputOf(pPage)) === true, 'el presentador siempre puede navegar');
    await v3.context.close();
    hub.config.viewerFreeNav = true;
  });

  await step('reconexión: tras cerrar el socket el cliente vuelve con nuevo clientId', async () => {
    const oldId = (await pres(vPage)).clientId;
    hub.kick(oldId);
    await waitPres(vPage, (p) => !p.connected, 'desconexión detectada', 3000);
    const t0 = Date.now();
    await waitPres(vPage, (p) => p.connected && p.clientId && p.clientId !== oldId, 'reconexión', 6000);
    assert(Date.now() - t0 < 4000, `reconexión rápida (${Date.now() - t0} ms)`);
    const evs = await vPage.evaluate(() => window.__t.events.filter((e) => e.evt === 'sync:status').map((e) => e.payload.connected));
    assert(evs.includes(false) && evs.at(-1) === true, `sync:status: ${evs.join(',')}`);
    assert((await vPage.evaluate(() => window.__t.sync.reconnectAttempts)) === 0, 'intentos reiniciados tras conectar');
    vId = (await pres(vPage)).clientId;
  });

  await step('reconexión durante una presentación: welcome devuelve el estado y el bloqueo', async () => {
    await pPage.evaluate(() => {
      window.__t.actions.select([{ modelId: 'm1', expressId: 321 }]);
      window.__t.presentation.start();
    });
    await waitPres(vPage, (p) => p.active, 'presentación activa');
    await waitFor(async () => (await storeGet(vPage, 'selection')).items[0]?.expressId === 321, { timeout: 3000, label: 'estado recibido' });
    const oldId = (await pres(vPage)).clientId;
    hub.kick(oldId);
    await waitPres(vPage, (p) => !p.connected && !p.active, 'desconexión: se limpia el estado de la presentación', 3000);
    await waitFor(async () => (await inputOf(vPage)) === true, { timeout: 2000, label: 'desbloqueado sin conexión (viewerFreeNav)' });
    await waitPres(vPage, (p) => p.connected && p.active && p.clientId !== oldId, 'reconectado y presentación activa', 6000);
    await waitFor(async () => (await inputOf(vPage)) === false, { timeout: 3000, label: 'bloqueado de nuevo' });
    assert((await storeGet(vPage, 'selection')).items[0]?.expressId === 321, 'estado restaurado por el welcome');
    vId = (await pres(vPage)).clientId;
  });

  await step('reconnect(): abre otra conexión al instante (p. ej. tras cambiar el PIN)', async () => {
    const oldId = (await pres(vPage)).clientId;
    const t0 = Date.now();
    await vPage.evaluate(() => {
      sessionStorage.setItem('visor.pin', '9999');
      window.__t.sync.reconnect();
    });
    await waitPres(vPage, (p) => p.connected && p.clientId && p.clientId !== oldId, 'nueva conexión', 3000);
    assert(Date.now() - t0 < 1500, `reconexión inmediata (${Date.now() - t0} ms)`);
    const hellos = hub.log.filter((e) => e.msg.t === 'hello' && e.msg.name === 'Ana');
    assert(hellos.at(-1).msg.pin === '9999', 'el nuevo hello lleva el PIN actualizado');
    vId = (await pres(vPage)).clientId;
  });

  await step('sin conexión no se puede presentar (aviso)', async () => {
    const off = await openSync('noconnect=1&name=Offline');
    const r = await off.page.evaluate(() => {
      const ok = window.__t.presentation.start();
      return { ok, toasts: window.__t.events.filter((e) => e.evt === 'toast').map((e) => e.payload.type) };
    });
    assert(r.ok === false && r.toasts.includes('warning'), `start() sin conexión: ${JSON.stringify(r)}`);
    await off.context.close();
  });

  await step('si cae el presentador la presentación termina y al volver ya no es el activo', async () => {
    hub.kick(pId);
    await waitPres(pPage, (p) => !p.connected && !p.isActivePresenter, 'presentador desconectado', 3000);
    await waitPres(vPage, (p) => !p.active, 'los espectadores ven el fin', 3000);
    await waitPres(pPage, (p) => p.connected && p.clientId && p.clientId !== pId, 'presentador reconectado', 6000);
    const p = await pres(pPage);
    assert(!p.active && !p.isActivePresenter, 'no retoma la presentación sola');
    pId = p.clientId;
  });

  // Limpieza de la parte 1
  for (const o of [v2, p2]) await o?.context.close();

  // ===========================================================================================
  // Parte 2: integración con el Viewer REAL (cámara, proyección, bloqueo y láser)
  // ===========================================================================================
  await step('Viewer real: el espectador sigue cámara y proyección, y queda bloqueado', async () => {
    const PR = await openSync('real=1&name=HostReal&w=900&h=500');
    const VR = await openSync('real=1&role=viewer&name=VerReal&w=700&h=500');
    await waitPres(PR.page, (p) => p.connected, 'presentador real conectado');
    await waitPres(VR.page, (p) => p.connected, 'espectador real conectado');
    await PR.page.evaluate(() => {
      const { viewer } = window.__t;
      viewer.setCameraState({ position: [30, 22, 30], target: [0, 3, 0], projection: 'perspective', zoom: 1, fov: 45 }, { smooth: false });
      window.__t.presentation.start();
    });
    await waitPres(VR.page, (p) => p.active, 'presentación vista');
    await waitFor(async () => VR.page.evaluate(() => window.__t.viewer.inputEnabled === false), { timeout: 3000, label: 'visor real bloqueado' });
    const near3 = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 0.5);
    await waitFor(async () => {
      const cam = await VR.page.evaluate(() => window.__t.viewer.getCameraState());
      return near3(cam.position, [30, 22, 30]) && near3(cam.target, [0, 3, 0]);
    }, { timeout: 8000, label: 'cámara real seguida' });
    // movimiento posterior de la cámara
    await PR.page.evaluate(() => window.__t.viewer.setCameraState({ position: [-20, 15, 25], target: [2, 3, 1], projection: 'perspective', zoom: 1, fov: 45 }, { smooth: false }));
    await waitFor(async () => {
      const cam = await VR.page.evaluate(() => window.__t.viewer.getCameraState());
      return near3(cam.position, [-20, 15, 25]) && near3(cam.target, [2, 3, 1]);
    }, { timeout: 8000, label: 'cámara real seguida (2)' });
    // proyección (viaja por store.display.projection y por la cámara)
    await PR.page.evaluate(() => window.__t.actions.setProjection('orthographic'));
    await waitFor(async () => (await VR.page.evaluate(() => window.__t.viewer.getCameraState().projection)) === 'orthographic', { timeout: 8000, label: 'proyección ortogonal' });
    // láser sobre el visor real
    await PR.page.evaluate(() => window.__t.bus.emit('viewer:pointermove', { ndc: { x: 0.3, y: 0.2 }, clientX: 0, clientY: 0 }));
    await waitFor(async () => VR.page.evaluate(() => window.__t.presentation.laser.getState().visible), { timeout: 4000, label: 'láser real' });
    const st = await VR.page.evaluate(() => window.__t.presentation.laser.getState());
    near(st.ndcX, 0.3 * (900 / 500) / (700 / 500), 0.01, 'corrección de aspecto con el visor real');
    const where = await VR.page.evaluate(() => {
      const c = document.querySelector('canvas.visor-laser');
      return c.parentElement === window.__t.viewer.renderer.domElement.parentElement;
    });
    assert(where, 'el láser vive dentro del contenedor del visor real');
    // al detener se desbloquea
    await PR.page.evaluate(() => window.__t.presentation.stop());
    await waitFor(async () => VR.page.evaluate(() => window.__t.viewer.inputEnabled === true), { timeout: 4000, label: 'visor real desbloqueado' });
    assert(PR.errors.length === 0 && VR.errors.length === 0, `errores de página: ${[...PR.errors, ...VR.errors].join(' | ')}`);
    await PR.context.close();
    await VR.context.close();
  });

  // ===========================================================================================
  // Parte 3: ModelLoader con dobles de ApiClient / IfcManager / CadManager / Viewer
  // ===========================================================================================
  const L = await openPage(browser, `${BASE}/dev/sync-loader.html`);
  opened.push(L);
  await L.page.waitForFunction(() => window.__ready === true, null, { timeout: 30000 });
  const lp = L.page;

  await step('ModelLoader: start() lista, carga en cola secuencial y actualiza store.loading / models', async () => {
    const r = await lp.evaluate(async () => {
      const { make, rec, waitUntil, expect } = window.__t;
      const b = make({ apiMs: 40, parseMs: 40 });
      window.b1 = b;
      b.api.records = [rec('a1', 'ifc'), rec('b2', 'dxf'), rec('c3', 'dwg')];
      await b.loader.start();
      expect(b.api.listCalls === 1, 'listModels una vez');
      expect(b.store.get('modelRecords').map((x) => x.id).join() === 'a1,b2,c3', 'modelRecords');
      const early = Object.keys(b.store.get('loading')).join();
      expect(early === 'a1,b2,c3', `loading en cola: ${early}`);
      expect(b.store.get('loading').b2.queued === true && b.store.get('loading').b2.phase === 'download', 'b2 en cola');
      await waitUntil(() => ['a1', 'b2', 'c3'].every((id) => b.loader.isLoaded(id)), 8000, 'las tres cargas');
      expect(b.tracker.maxBusy === 1, `cargas solapadas: ${b.tracker.maxBusy} (${b.tracker.order.join(' ')})`);
      const order = b.events.filter((e) => e.evt === 'model:loaded').map((e) => `${e.payload.modelId}:${e.payload.kind}`).join();
      expect(order === 'a1:ifc,b2:dxf,c3:dwg', `orden de model:loaded ${order}`);
      expect(JSON.stringify(b.store.get('models')) === JSON.stringify({ a1: { visible: true }, b2: { visible: true }, c3: { visible: true } }), 'models[id] = { visible: true }');
      expect(b.viewer.fitCalls === 1, `fitAll tras el primer modelo: ${b.viewer.fitCalls}`);
      const ld = b.store.get('loading');
      expect(['a1', 'b2', 'c3'].every((id) => ld[id].phase === 'done' && ld[id].progress === 1), 'fase done');
      expect(b.phases.a1.join() === 'download,parse,done', `fases de a1: ${b.phases.a1}`);
      expect(b.ifc.calls.filter((c) => c.op === 'load').length === 1 && b.cad.calls.filter((c) => c.op === 'load').length === 2, 'ifc.load / cad.load según kind');
      return { order: b.tracker.order.join(' ') };
    });
    assert(r.order.startsWith('+dl:a1 -dl:a1 +parse:a1 -parse:a1 +dl:b2'), `secuencia de operaciones: ${r.order}`);
  });

  await step('ModelLoader: descarga eliminados y limpia loading, models y referencias', async () => {
    await lp.evaluate(async () => {
      const { rec, expect } = window.__t;
      const b = window.b1;
      b.store.set('selection', { items: [{ modelId: 'b2', expressId: 1 }, { modelId: 'a1', expressId: 2 }] });
      b.store.patch('visibility', { hidden: { b2: [1], a1: [4] }, isolated: { b2: [3] } });
      b.store.set('storey', { active: { modelId: 'b2', expressId: 9 }, mode: 'cut', cutHeight: 1.2 });
      const all = b.store.get('modelRecords');
      b.loader.reconcile(all.filter((r) => r.id !== 'b2'));
      expect(b.cad.calls.some((c) => c.op === 'unload' && c.id === 'b2'), 'cad.unload(b2)');
      expect(!b.loader.isLoaded('b2') && b.loader.isLoaded('a1'), 'isLoaded');
      expect(!('b2' in b.store.get('models')) && !('b2' in b.store.get('loading')), 'models/loading sin b2');
      expect(b.store.get('selection').items.length === 1 && b.store.get('selection').items[0].modelId === 'a1', 'selección depurada');
      const vis = b.store.get('visibility');
      expect(!('b2' in vis.hidden) && vis.hidden.a1[0] === 4 && vis.isolated === null, `visibilidad depurada: ${JSON.stringify(vis)}`);
      expect(b.store.get('storey').active === null, 'nivel activo depurado');
      const ev = b.events.find((e) => e.evt === 'model:unloaded');
      expect(ev && ev.payload.modelId === 'b2' && ev.payload.kind === 'dxf', 'model:unloaded { modelId, kind }');
      expect(b.store.get('modelRecords').length === 2, 'modelRecords actualizado');
      // se vuelve a añadir b2 para los siguientes pasos
      b.loader.reconcile(all);
      await window.__t.waitUntil(() => b.loader.isLoaded('b2'), 5000, 'b2 de nuevo');
    });
  });

  await step('ModelLoader: cambio de georef → updateGeoref sin recargar', async () => {
    await lp.evaluate(() => {
      const { expect } = window.__t;
      const b = window.b1;
      const g = { eastings: 279500, northings: 8661000, height: 150, rotationDeg: 15, scale: 1 };
      const loads0 = b.ifc.calls.filter((c) => c.op === 'load').length;
      const next = b.store.get('modelRecords').map((r) => (r.id === 'a1' ? { ...r, georef: g } : { ...r }));
      b.loader.reconcile(next);
      const up = b.ifc.calls.filter((c) => c.op === 'updateGeoref');
      expect(up.length === 1 && up[0].id === 'a1' && up[0].georef.eastings === 279500, `updateGeoref: ${JSON.stringify(up)}`);
      expect(b.ifc.calls.filter((c) => c.op === 'load').length === loads0, 'no se recargó');
      b.loader.reconcile(next.map((r) => ({ ...r })));
      expect(b.ifc.calls.filter((c) => c.op === 'updateGeoref').length === 1, 'sin cambios no se vuelve a llamar');
      b.loader.reconcile(b.store.get('modelRecords').map((r) => (r.id === 'a1' ? { ...r, georef: null } : { ...r })));
      const up2 = b.ifc.calls.filter((c) => c.op === 'updateGeoref');
      expect(up2.length === 2 && up2[1].georef === null, 'quitar la sobrescritura envía null');
    });
  });

  await step('ModelLoader: cambio de unidades CAD → descarga y recarga conservando models y cad', async () => {
    await lp.evaluate(async () => {
      const { expect, waitUntil } = window.__t;
      const b = window.b1;
      b.store.set('models', { ...b.store.get('models'), c3: { visible: false } });
      b.store.set('cad', { c3: { hiddenLayers: ['MUROS'], elevation: 12 } });
      const loadsBefore = b.cad.calls.filter((c) => c.op === 'load' && c.id === 'c3').length;
      const unloadedBefore = b.events.filter((e) => e.evt === 'model:unloaded' && e.payload.modelId === 'c3').length;
      const next = b.store.get('modelRecords').map((r) => (r.id === 'c3' ? { ...r, cad: { units: 'mm' } } : { ...r }));
      b.loader.reconcile(next);
      expect(!b.loader.isLoaded('c3'), 'descargado de inmediato');
      expect(b.cad.calls.some((c) => c.op === 'unload' && c.id === 'c3'), 'cad.unload(c3)');
      expect(b.store.get('models').c3.visible === false, 'models[c3] se conserva durante la recarga');
      await waitUntil(() => b.loader.isLoaded('c3'), 6000, 'recarga de c3');
      const loads = b.cad.calls.filter((c) => c.op === 'load' && c.id === 'c3');
      expect(loads.length === loadsBefore + 1 && loads.at(-1).units === 'mm', `recarga con unidades nuevas: ${JSON.stringify(loads)}`);
      expect(b.store.get('models').c3.visible === false, 'la visibilidad del usuario se conserva');
      expect(b.store.get('cad').c3.hiddenLayers[0] === 'MUROS' && b.store.get('cad').c3.elevation === 12, 'store.cad se conserva');
      expect(b.events.filter((e) => e.evt === 'model:unloaded' && e.payload.modelId === 'c3').length === unloadedBefore + 1, 'model:unloaded emitido');
      expect(b.viewer.fitCalls === 1, 'no se vuelve a encuadrar');
    });
  });

  await step('ModelLoader: errores no detienen la cola ni se reintentan en bucle', async () => {
    await lp.evaluate(async () => {
      const { rec, expect, waitUntil } = window.__t;
      const b = window.b1;
      b.api.failDownload.add('d4');
      b.ifc.failParse.add('f6');
      const base = b.store.get('modelRecords');
      const all = [...base, rec('d4', 'dxf'), rec('e5', 'ifc'), rec('f6', 'ifc')];
      b.api.records = all;
      b.loader.reconcile(all);
      await waitUntil(() => b.loader.isLoaded('e5') && b.store.get('loading').d4?.phase === 'error' && b.store.get('loading').f6?.phase === 'error', 8000, 'errores y e5 cargado');
      const ld = b.store.get('loading');
      expect(ld.d4.error === 'No se encontró el recurso solicitado', `error de descarga: ${ld.d4.error}`);
      expect(ld.f6.error === 'Archivo dañado', `error de procesamiento: ${ld.f6.error}`);
      const evErr = b.events.filter((e) => e.evt === 'model:error');
      expect(evErr.length === 2 && evErr.every((e) => typeof e.payload.error === 'string' && e.payload.modelId), `model:error: ${JSON.stringify(evErr)}`);
      const toasts = b.events.filter((e) => e.evt === 'toast' && e.payload.type === 'error');
      expect(toasts.length === 2 && /d4\.dxf/.test(toasts[0].payload.message), `toasts de error: ${toasts.length}`);
      expect(!b.ifc.has('f6'), 'sin modelo a medias');
      // reconciliar de nuevo no reintenta
      const dl = b.api.downloads.filter((id) => id === 'd4').length;
      b.loader.reconcile(all.map((r) => ({ ...r })));
      await window.__t.sleep(300);
      expect(b.api.downloads.filter((id) => id === 'd4').length === dl, 'd4 no se reintenta mientras el registro no cambie');
      expect(b.events.filter((e) => e.evt === 'model:error').length === 2, 'sin nuevos errores');
      // un cambio en el registro (unidades) habilita un nuevo intento
      b.api.failDownload.delete('d4');
      b.loader.reconcile(all.map((r) => (r.id === 'd4' ? { ...r, cad: { units: 'm' } } : { ...r })));
      await waitUntil(() => b.loader.isLoaded('d4'), 6000, 'reintento de d4');
      expect(b.store.get('loading').d4.phase === 'done' && b.store.get('loading').d4.error === undefined, 'd4 recuperado');
      // retryFailed vuelve a intentar los demás
      expect(b.store.get('loading').f6.phase === 'error', 'f6 sigue en error');
      b.ifc.failParse.delete('f6');
      b.loader.retryFailed();
      await waitUntil(() => b.loader.isLoaded('f6'), 6000, 'retryFailed(f6)');
      // un registro eliminado con error limpia su entrada
      b.api.failDownload.add('g7');
      b.loader.reconcile([...b.store.get('modelRecords'), rec('g7', 'dxf')]);
      await waitUntil(() => b.store.get('loading').g7?.phase === 'error', 6000, 'g7 con error');
      b.loader.reconcile(b.store.get('modelRecords').filter((r) => r.id !== 'g7'));
      expect(!('g7' in b.store.get('loading')), 'se limpia el error de un modelo eliminado');
    });
  });

  await step('ModelLoader: eliminar un modelo mientras se carga no deja restos', async () => {
    await lp.evaluate(async () => {
      const { make, rec, expect, waitUntil, sleep } = window.__t;
      // a) eliminado durante la descarga
      let b = make({ apiMs: 200, parseMs: 100 });
      b.loader.reconcile([rec('x1', 'ifc')]);
      await waitUntil(() => b.store.get('loading').x1?.queued === false, 3000, 'x1 en curso');
      b.loader.reconcile([]);
      await sleep(600);
      expect(!b.loader.isLoaded('x1') && !b.ifc.has('x1'), 'x1 no queda cargado (descarga)');
      expect(Object.keys(b.store.get('loading')).length === 0 && Object.keys(b.store.get('models')).length === 0, 'sin restos en el store');
      expect(!b.events.some((e) => e.evt === 'model:loaded') && !b.events.some((e) => e.evt === 'toast' && e.payload.type === 'error'), 'sin eventos de carga ni error');
      // b) eliminado durante el procesamiento
      b = make({ apiMs: 40, parseMs: 300 });
      b.loader.reconcile([rec('x2', 'dxf')]);
      await waitUntil(() => b.store.get('loading').x2?.phase === 'parse', 3000, 'x2 procesando');
      b.loader.reconcile([]);
      await sleep(700);
      expect(!b.loader.isLoaded('x2') && !b.cad.has('x2'), 'x2 no queda cargado (procesamiento)');
      expect(Object.keys(b.store.get('loading')).length === 0, 'sin restos de loading');
      expect(!b.events.some((e) => e.evt === 'toast' && e.payload.type === 'error'), 'cancelar no es un error');
      // c) eliminado y vuelto a añadir enseguida: termina cargado
      b = make({ apiMs: 120, parseMs: 80 });
      const r = rec('x3', 'ifc');
      b.loader.reconcile([r]);
      await waitUntil(() => b.store.get('loading').x3?.queued === false, 3000, 'x3 en curso');
      b.loader.reconcile([]);
      b.loader.reconcile([r]);
      await waitUntil(() => b.loader.isLoaded('x3'), 6000, 'x3 cargado tras volver a añadirse');
      await sleep(300);
      expect(b.ifc.has('x3') && b.store.get('loading').x3.phase === 'done', 'x3 consistente');
    });
  });

  await step('ModelLoader: espectador en presentación activa no encuadra; primer modelo nuevo sí tras vaciar', async () => {
    await lp.evaluate(async () => {
      const { make, rec, expect, waitUntil } = window.__t;
      const s = make({ role: 'viewer', presentation: { active: true, isActivePresenter: false } });
      s.loader.reconcile([rec('v1', 'ifc')]);
      await waitUntil(() => s.loader.isLoaded('v1'), 5000, 'v1');
      expect(s.viewer.fitCalls === 0, 'espectador siguiendo: sin fitAll');
      // presentador: encuadra el primero y, tras vaciar, el siguiente primero
      const b = make({ role: 'presenter' });
      b.loader.reconcile([rec('p1', 'ifc'), rec('p2', 'dxf')]);
      await waitUntil(() => b.loader.isLoaded('p1') && b.loader.isLoaded('p2'), 6000, 'p1 y p2');
      expect(b.viewer.fitCalls === 1, 'solo tras el primero');
      b.loader.reconcile([]);
      expect(!b.loader.isLoaded('p1') && !b.loader.isLoaded('p2'), 'vaciado');
      b.loader.reconcile([rec('p3', 'ifc')]);
      await waitUntil(() => b.loader.isLoaded('p3'), 5000, 'p3');
      expect(b.viewer.fitCalls === 2, `encuadra de nuevo el primer modelo tras vaciar (${b.viewer.fitCalls})`);
    });
  });

  await step('ModelLoader: start() escucha server:models y descarta un listado HTTP desfasado', async () => {
    await lp.evaluate(async () => {
      const { make, rec, expect, waitUntil, sleep } = window.__t;
      const b = make({ apiMs: 20, parseMs: 20 });
      b.api.records = [rec('h1', 'ifc')];
      b.api.listDelay = 120;
      const starting = b.loader.start();
      b.bus.emit('server:models', [rec('h2', 'dxf')]); // el servidor difundió antes de que llegara el listado
      await starting;
      await waitUntil(() => b.loader.isLoaded('h2'), 5000, 'h2');
      await sleep(200);
      expect(!b.loader.isLoaded('h1') && !b.api.downloads.includes('h1'), 'el listado desfasado no se aplicó');
      // un mensaje posterior de bus reconcilia
      b.bus.emit('server:models', [rec('h2', 'dxf'), rec('h3', 'ifc')]);
      await waitUntil(() => b.loader.isLoaded('h3'), 5000, 'h3');
      b.bus.emit('server:models', [rec('h3', 'ifc')]);
      expect(!b.loader.isLoaded('h2') && b.loader.isLoaded('h3'), 'server:models elimina h2');
    });
  });

  await step('ModelLoader: uploadFiles filtra extensiones, sube en serie y avisa', async () => {
    await lp.evaluate(async () => {
      const { make, expect, waitUntil } = window.__t;
      const b = make({ role: 'presenter' });
      const seen = [];
      b.store.subscribe('loading', (next) => {
        for (const [id, v] of Object.entries(next)) if (id.startsWith('upload-')) seen.push(`${id}:${v.phase}`);
      });
      const files = [new File(['abc'], 'a.ifc'), new File(['txt'], 'notas.txt'), new File(['dxfdata'], 'plano.DXF'), new File(['x'], 'malo.dwg')];
      b.api.failUpload.add('malo.dwg');
      const created = await b.loader.uploadFiles(files);
      expect(created.length === 2 && created.map((r) => r.name).join() === 'a.ifc,plano.DXF', `registros subidos: ${created.map((r) => r.name)}`);
      expect(b.api.uploads.join() === 'a.ifc,plano.DXF,malo.dwg', `orden de subida: ${b.api.uploads}`);
      expect(seen.includes('upload-1:upload') && seen.includes('upload-2:upload') && seen.includes('upload-3:upload'), `ids temporales: ${seen}`);
      expect(!Object.keys(b.store.get('loading')).some((id) => id.startsWith('upload-')), 'las entradas upload-n se eliminan al terminar');
      const toasts = b.events.filter((e) => e.evt === 'toast').map((e) => `${e.payload.type}:${e.payload.message}`);
      expect(toasts.filter((t) => t.startsWith('warning:')).length === 1 && /notas\.txt/.test(toasts.find((t) => t.startsWith('warning:'))), `aviso de extensión: ${toasts}`);
      expect(toasts.filter((t) => t.startsWith('success:')).length === 2, `avisos de éxito: ${toasts}`);
      expect(toasts.filter((t) => t.startsWith('error:')).length === 1 && /malo\.dwg/.test(toasts.find((t) => t.startsWith('error:'))), `aviso de error: ${toasts}`);
      // sin WebSocket los registros se incorporan por sí solos y se cargan
      await waitUntil(() => b.loader.isLoaded('up1') && b.loader.isLoaded('up2'), 6000, 'modelos subidos cargados');
      expect(b.store.get('modelRecords').length === 2, 'modelRecords incluye lo subido');
      // llamadas simultáneas: las subidas se encadenan (una a la vez)
      const c = make({ role: 'presenter' });
      const [r1, r2] = await Promise.all([
        c.loader.uploadFiles([new File(['1'], 'u1.ifc'), new File(['2'], 'u2.dxf')]),
        c.loader.uploadFiles([new File(['3'], 'u3.dwg')]),
      ]);
      expect(r1.length === 2 && r2.length === 1, 'registros de las dos llamadas');
      expect(c.api.uploads.join() === 'u1.ifc,u2.dxf,u3.dwg' && c.api.maxUploads === 1, `subidas encadenadas: ${c.api.uploads} (máx. simultáneas ${c.api.maxUploads})`);
      // espectador: no puede subir
      const v = make({ role: 'viewer' });
      const out = await v.loader.uploadFiles([new File(['abc'], 'b.ifc')]);
      expect(out.length === 0 && v.api.uploads.length === 0, 'el espectador no sube');
      expect(v.events.some((e) => e.evt === 'toast' && e.payload.type === 'warning'), 'aviso al espectador');
      // todo rechazado
      const none = await b.loader.uploadFiles([new File(['x'], 'foto.png')]);
      expect(none.length === 0, 'extensiones no soportadas');
    });
  });

  await step('ModelLoader: sin errores de página', async () => {
    assert(L.errors.length === 0, `errores: ${L.errors.join(' | ')}`);
  });

  // Errores de consola de las páginas de la parte 1
  await step('Sin errores de página en presentador ni espectador', async () => {
    const all = [...P.errors, ...V.errors];
    assert(all.length === 0, `errores: ${all.join(' | ')}`);
  });

  // Se liberan el hub falso y el servidor estático: la parte 4 usa el servidor real en el mismo puerto
  for (const o of opened.splice(0)) await o.context.close().catch(() => {});
  hub.close();
  await new Promise((r) => server.close(r));
  serversOpen = false;

  // ===========================================================================================
  // Parte 4: integración con el servidor REAL (API REST + WebSocket), Viewer, IFC y CAD reales
  // ===========================================================================================
  console.log('\nIntegración con el servidor real');
  const real = await startServer({ port: PORT });
  try {
    assert(real.child.exitCode === null, `el servidor real no arrancó:\n${real.log()}`);
    const rec = {};
    rec.ifc = await uploadFixture(real.url, 'edificio_georef_ifc4.ifc');
    rec.dxf = await uploadFixture(real.url, 'planta_georef.dxf');
    const open4 = async (query) => {
      const o = await openPage(browser, `${real.url}/dev/sync-integration.html?${query}`, { viewport: { width: 900, height: 600 } });
      opened.push(o);
      await o.page.waitForFunction(() => window.__ready === true, null, { timeout: 90000 });
      return o;
    };
    const ev = (page, fn, arg) => page.evaluate(fn, arg);
    const waitEval = (page, fn, arg, label, timeout = 120000) =>
      waitFor(() => page.evaluate(fn, arg), { timeout, interval: 150, label });
    const loadedAll = (page, ids) =>
      waitEval(page, (list) => list.every((id) => window.__visor.loader.isLoaded(id)), ids, 'modelos cargados');

    const RP = await open4('name=Host');
    const RV = await open4('role=viewer&name=Ana');
    const rp = RP.page;
    const rv = RV.page;

    await step('Real: el presentador carga IFC y DXF del servidor con estado y encuadre', async () => {
      await loadedAll(rp, [rec.ifc.id, rec.dxf.id]);
      const r = await ev(rp, ({ ifcId, dxfId }) => {
        const v = window.__visor;
        const ld = v.store.get('loading');
        return {
          role: v.store.get('presentation').role,
          ifcCount: v.ifc.getModels().length,
          cadCount: v.cad.getModels().length,
          models: v.store.get('models'),
          phases: [ld[ifcId]?.phase, ld[dxfId]?.phase],
          events: v.events.filter((e) => e.evt === 'model:loaded').map((e) => `${e.payload.modelId}:${e.payload.kind}`),
          records: v.store.get('modelRecords').length,
        };
      }, { ifcId: rec.ifc.id, dxfId: rec.dxf.id });
      assert(r.role === 'presenter', `rol: ${r.role}`);
      assert(r.ifcCount === 1 && r.cadCount === 1, `modelos en los gestores: ${r.ifcCount}/${r.cadCount}`);
      assert(r.models[rec.ifc.id]?.visible === true && r.models[rec.dxf.id]?.visible === true, 'models[id].visible');
      assert(r.phases.join() === 'done,done', `fases: ${r.phases}`);
      assert(r.events.length === 2 && r.events[0].endsWith(':ifc'), `eventos model:loaded: ${r.events}`);
      assert(r.records === 2, 'modelRecords');
      // fitAll tras el primer modelo: el objetivo de la cámara cae dentro de la caja del IFC
      await sleep(1500);
      const fit = await ev(rp, (id) => {
        const v = window.__visor;
        const box = v.ifc.getModelBox(id);
        const cam = v.viewer.getCameraState();
        const c = box.getCenter(new box.min.constructor());
        const size = box.getSize(new box.min.constructor()).length();
        const d = Math.hypot(cam.target[0] - c.x, cam.target[1] - c.y, cam.target[2] - c.z);
        return { d, size };
      }, rec.ifc.id);
      assert(fit.d < fit.size * 0.6, `el encuadre apunta al modelo (distancia ${fit.d.toFixed(1)}, tamaño ${fit.size.toFixed(1)})`);
    });

    await step('Real: el espectador (?role=viewer) carga los mismos modelos y tiene rol viewer', async () => {
      await loadedAll(rv, [rec.ifc.id, rec.dxf.id]);
      const r = await ev(rv, () => {
        const p = window.__visor.store.get('presentation');
        return { role: p.role, connected: p.connected, viewers: p.viewers };
      });
      assert(r.role === 'viewer' && r.connected, `espectador: ${JSON.stringify(r)}`);
      await waitEval(rp, () => window.__visor.store.get('presentation').viewers >= 2, null, 'contador de clientes', 10000);
    });

    let elem;
    await step('Real: presentar → selección, cámara y proyección llegan al espectador real', async () => {
      // elemento IFC (primer hijo no espacial del árbol)
      elem = await ev(rp, (id) => {
        const tree = window.__visor.ifc.getSpatialTree(id);
        let found = null;
        const walk = (n) => {
          if (found) return;
          if (!n.isSpatial) { found = n.expressId; return; }
          for (const c of n.children) walk(c);
        };
        walk(tree);
        return found;
      }, rec.ifc.id);
      assert(Number.isInteger(elem), `elemento IFC de prueba: ${elem}`);
      await ev(rp, () => window.__visor.presentation.start());
      await waitEval(rv, () => window.__visor.store.get('presentation').active, null, 'presentación vista', 10000);
      assert(await ev(rv, () => window.__visor.viewer.inputEnabled === false), 'visor del espectador bloqueado');
      await ev(rp, ({ id, e }) => window.__visor.actions.select([{ modelId: id, expressId: e }]), { id: rec.ifc.id, e: elem });
      await waitEval(rv, ({ id, e }) => {
        const it = window.__visor.store.get('selection').items;
        return it.length === 1 && it[0].modelId === id && it[0].expressId === e;
      }, { id: rec.ifc.id, e: elem }, 'selección en el espectador', 10000);
      await ev(rp, () => window.__visor.viewer.setCameraState({ position: [-40, 30, 40], target: [0, 4, 0], projection: 'perspective', zoom: 1, fov: 45 }, { smooth: false }));
      await waitEval(rv, () => {
        const c = window.__visor.viewer.getCameraState();
        return Math.abs(c.position[0] + 40) < 1 && Math.abs(c.position[1] - 30) < 1 && Math.abs(c.position[2] - 40) < 1;
      }, null, 'cámara en el espectador', 10000);
      await ev(rp, () => window.__visor.actions.setProjection('orthographic'));
      await waitEval(rv, () => window.__visor.viewer.getCameraState().projection === 'orthographic', null, 'proyección en el espectador', 10000);
      // el estado del espectador se aplicó como remoto: su store coincide con el del presentador
      await waitEval(rv, () => window.__visor.store.get('display').projection === 'orthographic', null, 'display.projection remoto', 10000);
    });

    let up;
    await step('Real: subir un IFC desde el presentador → el servidor lo difunde y ambos lo cargan', async () => {
      const b64 = fs.readFileSync(path.join(FIXTURES, 'edificio_site_ifc2x3.ifc')).toString('base64');
      const created = await ev(rp, async (data) => {
        const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
        const out = await window.__visor.loader.uploadFiles([
          new File([bytes], 'edificio_site.ifc'),
          new File(['no soportado'], 'leeme.txt'),
        ]);
        return out.map((r) => ({ id: r.id, name: r.name, kind: r.kind }));
      }, b64);
      assert(created.length === 1 && created[0].kind === 'ifc', `subida: ${JSON.stringify(created)}`);
      up = created[0];
      await loadedAll(rp, [up.id]);
      await loadedAll(rv, [up.id]);
      const r = await ev(rp, () => {
        const v = window.__visor;
        return {
          leftovers: Object.keys(v.store.get('loading')).filter((k) => k.startsWith('upload-')),
          toasts: v.events.filter((e) => e.evt === 'toast').map((e) => `${e.payload.type}:${e.payload.message}`),
        };
      });
      assert(r.leftovers.length === 0, 'sin entradas upload-n');
      assert(r.toasts.some((t) => t.startsWith('success:')) && r.toasts.some((t) => t.startsWith('warning:') && /leeme\.txt/.test(t)), `avisos: ${r.toasts}`);
      assert(await ev(rv, () => window.__visor.ifc.getModels().length) === 2, 'el espectador tiene 2 IFC');
    });

    await step('Real: PATCH de georreferencia → ifc.updateGeoref en ambas PCs sin recargar', async () => {
      const before = await ev(rv, (id) => window.__visor.ifc.getModel(id) && true, rec.ifc.id);
      assert(before, 'modelo presente en el espectador');
      const geo = { eastings: 279600, northings: 8661100, height: 151, rotationDeg: 0, scale: 1 };
      await ev(rp, ({ id, g }) => window.__visor.api.patchModel(id, { georef: g }), { id: rec.ifc.id, g: geo });
      for (const page of [rp, rv]) {
        await waitEval(page, (id) => {
          const g = window.__visor.ifc.getGeorefInfo(id);
          return g && g.source === 'manual' && g.eastings === 279600;
        }, rec.ifc.id, 'georreferencia manual aplicada', 20000);
      }
      const loads = await ev(rv, () => window.__visor.events.filter((e) => e.evt === 'model:loaded').length);
      assert(loads === 3, `no hubo recarga del IFC (eventos model:loaded: ${loads})`);
    });

    await step('Real: PATCH de unidades CAD → el plano se recarga en ambas PCs', async () => {
      const scaleOf = (page) => ev(page, (id) => window.__visor.cad.getModels().find((m) => m.id === id)?.unitScale, rec.dxf.id);
      const s0 = await scaleOf(rp);
      await ev(rp, (id) => window.__visor.api.patchModel(id, { cad: { units: 'mm' } }), rec.dxf.id);
      for (const page of [rp, rv]) {
        await waitEval(page, (id) => {
          const m = window.__visor.cad.getModels().find((x) => x.id === id);
          return m && m.unitScale === 0.001 && window.__visor.loader.isLoaded(id);
        }, rec.dxf.id, 'plano recargado en milímetros', 60000);
      }
      assert(s0 !== 0.001, `la escala inicial era distinta (${s0})`);
      const ev2 = await ev(rv, (id) => window.__visor.events.filter((e) => e.evt === 'model:unloaded' && e.payload.modelId === id).length, rec.dxf.id);
      assert(ev2 === 1, 'model:unloaded del plano emitido una vez');
    });

    await step('Real: DELETE de un modelo → ambas PCs lo descargan y limpian su estado', async () => {
      await ev(rp, (id) => window.__visor.api.deleteModel(id), up.id);
      for (const page of [rp, rv]) {
        await waitEval(page, (id) => {
          const v = window.__visor;
          return !v.loader.isLoaded(id) && !v.ifc.has(id) && !(id in v.store.get('models')) && !(id in v.store.get('loading'));
        }, up.id, 'modelo eliminado', 20000);
        assert(await ev(page, () => window.__visor.store.get('modelRecords').length) === 2, 'modelRecords actualizado');
      }
    });

    await step('Real: detener la presentación desbloquea al espectador', async () => {
      await ev(rp, () => window.__visor.presentation.stop());
      await waitEval(rv, () => window.__visor.viewer.inputEnabled === true && !window.__visor.store.get('presentation').active, null, 'espectador libre', 10000);
    });

    await step('Real: sin errores de página', async () => {
      const all = [...RP.errors, ...RV.errors];
      assert(all.length === 0, `errores: ${all.slice(0, 5).join(' | ')}`);
    });
  } finally {
    for (const o of opened.splice(0)) await o.context.close().catch(() => {});
    await real.stop();
  }
} catch (err) {
  console.error('Error inesperado en la prueba:', err);
  exitCode = 1;
} finally {
  for (const o of opened) await o.context.close().catch(() => {});
  await browser.close().catch(() => {});
  if (serversOpen) {
    hub.close();
    await new Promise((r) => server.close(r));
  }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} pasos correctos`);
if (failed.length || exitCode) exitCode = 1;
process.exit(exitCode);
