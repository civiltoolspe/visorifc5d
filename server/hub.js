// Concentrador WebSocket del modo presentación (ruta /ws).
//
// Protocolo (mensajes JSON con campo t) descrito en docs/ARQUITECTURA.md, sección 4.
//
// Máquina de estado de la presentación:
//   - presenterId: cliente que la inició (o que tomó el control). Solo él puede
//     enviar state / camera / pointer, y solo mientras la presentación esté activa.
//   - lastState: último estado completo (slices fusionados por slice; full:true reemplaza todo).
//   - lastCamera: última cámara recibida. Ambos se limpian al iniciar/terminar una presentación.
//   - Si el presentador activo se desconecta, la presentación termina.

import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import { normalizeIp } from './roles.js';

export const MAX_PAYLOAD = 32 * 1024 * 1024; // 32 MB (el estado puede incluir miniaturas de vistas)
const HELLO_TIMEOUT_MS = 10000;
const NOMBRE_MAX = 40;
const SLICE_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const MAX_SLICES = 64;
// Si un espectador acumula más de esto sin leer, se descartan cámara y puntero (son efímeros).
const BUFFER_EFIMERO_MAX = 1024 * 1024;

const esObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function limpiarNombre(valor, porDefecto) {
  const n = typeof valor === 'string'
    ? valor.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
    : '';
  return (n || porDefecto).slice(0, NOMBRE_MAX);
}

export class PresentationHub {
  // config: { viewerFreeNav, heartbeatMs }, roles: RoleResolver, models: ModelStore
  constructor({ config, roles, models, log = () => {} }) {
    this.config = config;
    this.roles = roles;
    this.models = models;
    this.log = log;
    this.wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });
    this.clients = new Map(); // clientId -> conexión registrada (ya envió hello)
    this._conexiones = new Set(); // todas las conexiones abiertas (incluidas las que no enviaron hello)
    this.presentation = { active: false, presenterId: null, presenterName: '' };
    this.lastState = {};
    this.lastCamera = null;
    this._seqEspectador = 0;
    this._latido = setInterval(() => this._latir(), config.heartbeatMs);
    this._latido.unref?.();
  }

  // ---------- Entrada de conexiones ----------

  handleUpgrade(req, socket, head) {
    this.wss.handleUpgrade(req, socket, head, (ws) => this._alConectar(ws, req));
  }

  _alConectar(ws, req) {
    const pinCabecera = req.headers['x-presenter-pin'];
    const conn = {
      ws,
      ip: normalizeIp(req.socket.remoteAddress),
      remoteAddress: req.socket.remoteAddress,
      pinCabecera: Array.isArray(pinCabecera) ? pinCabecera[0] : pinCabecera,
      id: null, // se asigna con hello
      name: '',
      role: null,
      vivo: true,
      temporizadorHello: null,
    };
    this._conexiones.add(conn);
    conn.temporizadorHello = setTimeout(() => {
      if (conn.id) return;
      try { ws.close(4001, 'Se esperaba el mensaje hello'); } catch { /* ya cerrada */ }
      setTimeout(() => ws.terminate(), 1000).unref?.();
    }, HELLO_TIMEOUT_MS);
    conn.temporizadorHello.unref?.();

    ws.on('pong', () => { conn.vivo = true; });
    ws.on('message', (data, esBinario) => {
      conn.vivo = true;
      try {
        this._alMensaje(conn, data, esBinario);
      } catch (err) {
        this.log(`Error procesando mensaje WebSocket: ${err.stack || err.message}`);
        this._error(conn, 'Error interno al procesar el mensaje');
      }
    });
    ws.on('close', () => this._alDesconectar(conn));
    ws.on('error', () => { /* los errores de socket terminan en 'close' */ });
  }

  _alDesconectar(conn) {
    clearTimeout(conn.temporizadorHello);
    this._conexiones.delete(conn);
    if (!conn.id || this.clients.get(conn.id) !== conn) return;
    this.clients.delete(conn.id);
    if (this.presentation.active && this.presentation.presenterId === conn.id) {
      this._terminarPresentacion();
    }
    this._difundirClientes();
  }

  // ---------- Mensajes entrantes ----------

  _alMensaje(conn, data, esBinario) {
    if (esBinario) return this._error(conn, 'Solo se admiten mensajes de texto JSON');
    let msg;
    try {
      msg = JSON.parse(data.toString('utf8'));
    } catch {
      return this._error(conn, 'Mensaje inválido: no es JSON');
    }
    if (!esObjeto(msg) || typeof msg.t !== 'string') {
      return this._error(conn, 'Mensaje inválido: falta el campo "t"');
    }
    if (msg.t === 'ping') return this._enviar(conn, { t: 'pong' });
    if (msg.t === 'hello') return this._hello(conn, msg);
    if (!conn.id) return this._error(conn, 'Debes enviar "hello" antes de cualquier otro mensaje');

    switch (msg.t) {
      case 'presentation': return this._msgPresentacion(conn, msg);
      case 'take-control': return this._msgTomarControl(conn);
      case 'state': return this._msgEstado(conn, msg);
      case 'camera': return this._msgCamara(conn, msg);
      case 'pointer': return this._msgPuntero(conn, msg);
      default: return this._error(conn, `Mensaje desconocido: "${msg.t.slice(0, 40)}"`);
    }
  }

  _hello(conn, msg) {
    const quiereEspectador = msg.wantRole === 'viewer';
    if (!conn.id) {
      // Primer hello: se decide el rol. El PIN del hello tiene prioridad sobre el de la cabecera de la mejora a WebSocket.
      const pin = typeof msg.pin === 'string' && msg.pin !== '' ? msg.pin : conn.pinCabecera;
      let role = this.roles.resolve(conn.remoteAddress, pin);
      if (quiereEspectador) role = 'viewer';
      conn.role = role;
      conn.id = crypto.randomBytes(6).toString('hex');
      this._seqEspectador += role === 'viewer' ? 1 : 0;
      conn.name = limpiarNombre(msg.name, role === 'presenter' ? 'Presentador' : `Espectador ${this._seqEspectador}`);
      clearTimeout(conn.temporizadorHello);
      this.clients.set(conn.id, conn);
      this._enviar(conn, {
        t: 'welcome',
        clientId: conn.id,
        role: conn.role,
        presentation: this._infoPresentacion(),
        state: this.presentation.active ? this.lastState : {},
        camera: this.presentation.active ? this.lastCamera : null,
        models: this.models.list(),
        clients: this._infoClientes(),
        viewerFreeNav: !!this.config.viewerFreeNav,
      });
      this._difundirClientes();
      return;
    }

    // Hello posterior: cambio de nombre y/o degradación a espectador (nunca se asciende).
    let cambio = false;
    const nombre = limpiarNombre(msg.name, conn.name);
    if (nombre !== conn.name) {
      conn.name = nombre;
      cambio = true;
      if (this.presentation.active && this.presentation.presenterId === conn.id) {
        this.presentation.presenterName = nombre;
        this._difundir({ t: 'presentation', ...this._infoPresentacion() });
      }
    }
    if (quiereEspectador && conn.role !== 'viewer') {
      conn.role = 'viewer';
      cambio = true;
      if (this.presentation.active && this.presentation.presenterId === conn.id) this._terminarPresentacion();
    }
    if (cambio) this._difundirClientes();
  }

  _exigirPresentador(conn, accion) {
    if (conn.role !== 'presenter') {
      this._error(conn, `Solo el presentador puede ${accion}`);
      return false;
    }
    return true;
  }

  _exigirPresentadorActivo(conn, accion) {
    if (!this._exigirPresentador(conn, accion)) return false;
    if (!this.presentation.active) {
      this._error(conn, 'No hay una presentación activa');
      return false;
    }
    if (this.presentation.presenterId !== conn.id) {
      this._error(conn, 'No eres el presentador activo; usa "tomar el control" primero');
      return false;
    }
    return true;
  }

  _msgPresentacion(conn, msg) {
    if (typeof msg.active !== 'boolean') return this._error(conn, 'El campo "active" debe ser booleano');
    if (!this._exigirPresentador(conn, 'iniciar o detener la presentación')) return;
    if (msg.active) {
      if (this.presentation.active) {
        if (this.presentation.presenterId === conn.id) {
          // Ya presentaba: solo se reenvía el estado actual de la presentación
          this._enviar(conn, { t: 'presentation', ...this._infoPresentacion() });
          return;
        }
        return this._error(conn, 'Ya hay una presentación activa; usa "tomar el control"');
      }
      this.presentation = { active: true, presenterId: conn.id, presenterName: conn.name };
      this.lastState = {};
      this.lastCamera = null;
      this._difundir({ t: 'presentation', ...this._infoPresentacion() });
      this._difundirClientes();
      return;
    }
    if (!this.presentation.active) {
      // Ya estaba detenida: se confirma el estado actual al solicitante
      this._enviar(conn, { t: 'presentation', ...this._infoPresentacion() });
      return;
    }
    this._terminarPresentacion();
    this._difundirClientes();
  }

  _msgTomarControl(conn) {
    if (!this._exigirPresentador(conn, 'tomar el control de la presentación')) return;
    if (!this.presentation.active) return this._error(conn, 'No hay una presentación activa');
    if (this.presentation.presenterId === conn.id) {
      this._enviar(conn, { t: 'presentation', ...this._infoPresentacion() });
      return;
    }
    // Se conserva lastState/lastCamera: el nuevo presentador envía su estado completo al asumir
    this.presentation = { active: true, presenterId: conn.id, presenterName: conn.name };
    this._difundir({ t: 'presentation', ...this._infoPresentacion() });
    this._difundirClientes();
  }

  _msgEstado(conn, msg) {
    if (!this._exigirPresentadorActivo(conn, 'enviar el estado')) return;
    if (!esObjeto(msg.slices)) return this._error(conn, 'El campo "slices" debe ser un objeto');
    const claves = Object.keys(msg.slices);
    if (claves.length > MAX_SLICES) return this._error(conn, 'Demasiados slices en un mensaje');
    for (const k of claves) {
      if (!SLICE_RE.test(k)) return this._error(conn, `Nombre de slice inválido: "${k.slice(0, 40)}"`);
    }
    const full = msg.full === true;
    if (full) this.lastState = {};
    for (const k of claves) this.lastState[k] = msg.slices[k];
    this._difundir({ t: 'state', slices: msg.slices, full }, conn.id);
  }

  _msgCamara(conn, msg) {
    if (!this._exigirPresentadorActivo(conn, 'enviar la cámara')) return;
    if (!esObjeto(msg.cam)) return this._error(conn, 'El campo "cam" debe ser un objeto');
    this.lastCamera = msg.cam;
    this._difundir({ t: 'camera', cam: msg.cam }, conn.id, { efimero: true });
  }

  _msgPuntero(conn, msg) {
    if (!this._exigirPresentadorActivo(conn, 'enviar el puntero')) return;
    if (!esObjeto(msg.p)) return this._error(conn, 'El campo "p" debe ser un objeto');
    this._difundir({ t: 'pointer', p: msg.p }, conn.id, { efimero: true });
  }

  // ---------- Estado de la presentación ----------

  _terminarPresentacion() {
    this.presentation = { active: false, presenterId: null, presenterName: '' };
    this.lastState = {};
    this.lastCamera = null;
    this._difundir({ t: 'presentation', ...this._infoPresentacion() });
  }

  _infoPresentacion() {
    const { active, presenterId, presenterName } = this.presentation;
    return { active, presenterId, presenterName };
  }

  // viewers = clientes conectados excepto el presentador activo
  _infoClientes() {
    const lista = [...this.clients.values()].map((c) => ({ id: c.id, name: c.name, role: c.role }));
    const hayPresentador = this.presentation.active && this.clients.has(this.presentation.presenterId);
    return { viewers: lista.length - (hayPresentador ? 1 : 0), list: lista };
  }

  _difundirClientes() {
    const { viewers, list } = this._infoClientes();
    this._difundir({ t: 'clients', viewers, list });
  }

  // Avisa a todos los clientes de un cambio en la lista de modelos (subida, PATCH, borrado).
  broadcastModels() {
    this._difundir({ t: 'models', models: this.models.list() });
  }

  // ---------- Envío ----------

  _enviar(conn, obj) {
    if (conn.ws.readyState === conn.ws.OPEN) conn.ws.send(JSON.stringify(obj));
  }

  _error(conn, message) {
    this._enviar(conn, { t: 'error', message });
  }

  // Envía a todos los clientes registrados (salvo exceptoId). Los mensajes efímeros
  // (cámara, puntero) se omiten para clientes con la cola de salida saturada.
  _difundir(obj, exceptoId = null, { efimero = false } = {}) {
    const texto = JSON.stringify(obj);
    for (const c of this.clients.values()) {
      if (c.id === exceptoId || c.ws.readyState !== c.ws.OPEN) continue;
      if (efimero && c.ws.bufferedAmount > BUFFER_EFIMERO_MAX) continue;
      c.ws.send(texto);
    }
  }

  // ---------- Latido y cierre ----------

  _latir() {
    for (const conn of this._conexiones) {
      if (!conn.vivo) {
        conn.ws.terminate();
        continue;
      }
      conn.vivo = false;
      try { conn.ws.ping(); } catch { /* conexión ya cerrada */ }
    }
  }

  close() {
    clearInterval(this._latido);
    for (const conn of this._conexiones) {
      clearTimeout(conn.temporizadorHello);
      try { conn.ws.close(1001, 'Servidor detenido'); } catch { /* ya cerrada */ }
    }
    // Las conexiones que no completen el cierre en 1,5 s se terminan a la fuerza
    const restantes = [...this._conexiones];
    setTimeout(() => restantes.forEach((c) => c.ws.terminate()), 1500).unref?.();
    this.wss.close();
  }
}
