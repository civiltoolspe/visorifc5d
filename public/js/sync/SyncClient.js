// Cliente WebSocket del modo presentación (ver docs/ARQUITECTURA.md, secciones 4 y 9).
//
//   const sync = new SyncClient({ store, bus, info });
//   sync.connect();                       // ws(s)://host/ws con reconexión y latido
//   sync.startPresentation(); sync.stopPresentation(); sync.takeControl();
//   sync.sendState(slices, full); sync.sendCamera(cam); sync.sendPointer(p);
//
// Emite en el bus: 'sync:status' { connected }, 'sync:welcome', 'sync:presentation',
// 'sync:state', 'sync:camera', 'sync:pointer', 'sync:clients' y 'server:models' (ModelRecord[]).
// Mantiene store.presentation (source 'system'). Los mensajes desconocidos se ignoran.

const NAME_KEY = 'visor.name';
const PIN_KEY = 'visor.pin';
const NAME_MAX = 40;

const PING_MS = 20000; // latido del cliente
const STALE_MS = 50000; // sin ningún mensaje del servidor durante este tiempo: se cierra y se reconecta
const BACKOFF_MIN_MS = 500;
const BACKOFF_MAX_MS = 5000;
const TOAST_DEDUPE_MS = 5000;

// Acceso tolerante al almacenamiento del navegador (puede lanzar en ventanas privadas o con datos bloqueados)
function storageGet(kind, key) {
  try {
    return globalThis[kind]?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function storageSet(kind, key, value) {
  try {
    globalThis[kind]?.setItem(key, value);
  } catch { /* sin almacenamiento: el valor queda solo en memoria */ }
}

function randomSuffix(n = 4) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < n; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

function cleanName(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, NAME_MAX);
}

export class SyncClient {
  // options: { url, pingMs } para pruebas; por defecto ws(s)://host/ws y latido de 20 s.
  constructor({ store, bus, info = {}, url = null, pingMs = PING_MS } = {}) {
    this.store = store;
    this.bus = bus;
    this.info = info || {};
    this.url = url;
    this.pingMs = pingMs;

    this.ws = null;
    this.connected = false; // true tras recibir 'welcome'
    this.clientId = null;
    this.clients = { viewers: 0, list: [] };
    this.reconnectAttempts = 0;

    this._name = null;
    this._manualClose = false;
    this._reconnectTimer = null;
    this._pingTimer = null;
    this._lastRx = 0;
    this._toastSeen = new Map(); // mensaje -> marca de tiempo del último aviso
    this._onOnline = () => this._reconectarYa();
    this._listening = false;
  }

  // Retardo de reconexión: 0,5 s · 2^intento con tope de 5 s y jitter descendente (75 %–100 %).
  // `rand` en [0,1) se puede inyectar para pruebas.
  static backoffDelay(attempt, rand = Math.random()) {
    const base = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** Math.max(0, attempt));
    return Math.round(base * (0.75 + 0.25 * rand));
  }

  // ---------- Nombre del cliente ----------

  getName() {
    if (this._name) return this._name;
    let name = cleanName(storageGet('localStorage', NAME_KEY));
    if (!name) {
      name = `PC-${randomSuffix(4)}`;
      storageSet('localStorage', NAME_KEY, name);
    }
    this._name = name;
    return name;
  }

  // Guarda el nombre y, si hay conexión, lo reenvía al servidor con un nuevo hello.
  setName(name) {
    const clean = cleanName(name);
    if (!clean) return this.getName();
    this._name = clean;
    storageSet('localStorage', NAME_KEY, clean);
    if (this.connected) this._sendHello();
    return clean;
  }

  // ---------- Conexión ----------

  _url() {
    if (this.url) return this.url;
    const proto = globalThis.location?.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${globalThis.location?.host}/ws`;
  }

  _wantsViewer() {
    if (this.info?.role === 'viewer') return true;
    try {
      return new URLSearchParams(globalThis.location?.search || '').get('role') === 'viewer';
    } catch {
      return false;
    }
  }

  _pin() {
    const pin = storageGet('sessionStorage', PIN_KEY);
    return pin ? String(pin) : '';
  }

  connect() {
    this._manualClose = false;
    if (!this._listening && typeof globalThis.addEventListener === 'function') {
      globalThis.addEventListener('online', this._onOnline);
      this._listening = true;
    }
    if (this.ws && (this.ws.readyState === 0 || this.ws.readyState === 1)) return;
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = null;

    let ws;
    try {
      ws = new WebSocket(this._url());
    } catch (err) {
      console.error('[sync] no se pudo abrir el WebSocket', err);
      this._programarReconexion();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this._lastRx = Date.now();
      this._sendHello();
      this._iniciarLatido();
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      this._lastRx = Date.now();
      this._procesar(ev.data);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this._alCerrar();
    };
    ws.onerror = () => { /* el cierre posterior dispara la reconexión */ };
  }

  // Cierra la conexión actual y abre otra al instante. Hace falta tras cambiar el PIN de presentador
  // (api.setPin), porque el servidor decide el rol solo con el primer hello de cada conexión.
  reconnect() {
    this._manualClose = false;
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = null;
    const ws = this.ws;
    if (ws) {
      this.ws = null;
      this._detenerLatido();
      try { ws.close(1000, 'reconectando'); } catch { /* ya cerrado */ }
      this._marcarDesconectado();
    }
    this.reconnectAttempts = 0;
    this.connect();
  }

  // Cierra la conexión sin reconectar (p. ej. al descartar la aplicación).
  disconnect() {
    this._manualClose = true;
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = null;
    this._detenerLatido();
    if (this._listening) {
      globalThis.removeEventListener?.('online', this._onOnline);
      this._listening = false;
    }
    const ws = this.ws;
    if (ws) {
      this.ws = null;
      try { ws.close(1000, 'cliente cerrado'); } catch { /* ya cerrado */ }
      this._marcarDesconectado();
    }
  }

  _sendHello() {
    const msg = { t: 'hello', name: this.getName() };
    if (this._wantsViewer()) msg.wantRole = 'viewer';
    const pin = this._pin();
    if (pin) msg.pin = pin;
    this.send(msg);
  }

  // Envía un mensaje JSON. Devuelve false si no hay conexión abierta.
  send(msg) {
    const ws = this.ws;
    if (!ws || ws.readyState !== 1) return false;
    try {
      ws.send(JSON.stringify(msg));
      return true;
    } catch (err) {
      console.error('[sync] no se pudo enviar el mensaje', err);
      return false;
    }
  }

  _alCerrar() {
    this._detenerLatido();
    this.ws = null;
    this._marcarDesconectado();
    if (!this._manualClose) this._programarReconexion();
  }

  // Estado de la presentación en el cliente cuando no hay conexión: no se puede seguir a nadie
  // y el servidor ya terminó la presentación si quien presentaba era esta PC.
  _marcarDesconectado() {
    if (!this.connected) return;
    this.connected = false;
    this.clientId = null;
    this.store.patch('presentation', {
      connected: false,
      clientId: null,
      active: false,
      presenterId: null,
      presenterName: '',
      isActivePresenter: false,
      viewers: 0,
    }, { source: 'system' });
    this.bus.emit('sync:status', { connected: false });
  }

  _programarReconexion() {
    if (this._manualClose || this._reconnectTimer) return;
    const delay = SyncClient.backoffDelay(this.reconnectAttempts);
    this.reconnectAttempts += 1;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this.connect();
    }, delay);
  }

  // Al volver la red se reintenta sin esperar al temporizador.
  _reconectarYa() {
    if (this._manualClose) return;
    if (this.ws && (this.ws.readyState === 0 || this.ws.readyState === 1)) return;
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = null;
    this.connect();
  }

  _iniciarLatido() {
    this._detenerLatido();
    this._pingTimer = setInterval(() => {
      const ws = this.ws;
      if (!ws || ws.readyState !== 1) return;
      if (Date.now() - this._lastRx > STALE_MS) {
        // Conexión zombi (suspensión del equipo, Wi-Fi caído): se fuerza el cierre para reconectar
        try { ws.close(); } catch { /* ya cerrada */ }
        // Algunos navegadores tardan en emitir 'close': se adelanta el tratamiento
        setTimeout(() => { if (this.ws === ws) this._alCerrar(); }, 1000);
        return;
      }
      this.send({ t: 'ping' });
    }, this.pingMs);
  }

  _detenerLatido() {
    clearInterval(this._pingTimer);
    this._pingTimer = null;
  }

  // ---------- Mensajes entrantes ----------

  _procesar(data) {
    if (typeof data !== 'string') return;
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return; // basura: se ignora
    }
    if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') return;
    switch (msg.t) {
      case 'welcome': return this._alBienvenida(msg);
      case 'presentation': return this._alPresentacion(msg);
      case 'state': return this.bus.emit('sync:state', msg);
      case 'camera': return this.bus.emit('sync:camera', msg);
      case 'pointer': return this.bus.emit('sync:pointer', msg);
      case 'models':
        if (Array.isArray(msg.models)) this.bus.emit('server:models', msg.models);
        return undefined;
      case 'clients': return this._alClientes(msg);
      case 'error': return this._alError(msg);
      case 'pong': return undefined;
      default:
        // Mensaje de una versión más nueva del servidor: se informa por si alguien lo quiere
        return this.bus.emit('sync:unknown', msg);
    }
  }

  _datosPresentacion(p) {
    const active = !!p?.active;
    const presenterId = p?.presenterId ?? null;
    return {
      active,
      presenterId,
      presenterName: typeof p?.presenterName === 'string' ? p.presenterName : '',
      isActivePresenter: active && !!this.clientId && presenterId === this.clientId,
    };
  }

  _alBienvenida(msg) {
    this.clientId = typeof msg.clientId === 'string' && msg.clientId ? msg.clientId : null;
    this.reconnectAttempts = 0;
    const wasConnected = this.connected;
    this.connected = true;
    const clients = msg.clients && typeof msg.clients === 'object' ? msg.clients : null;
    if (clients) this.clients = { viewers: Number(clients.viewers) || 0, list: Array.isArray(clients.list) ? clients.list : [] };

    const patch = {
      connected: true,
      clientId: this.clientId,
      ...this._datosPresentacion(msg.presentation),
      viewers: this.clients.viewers,
    };
    if (msg.role === 'presenter' || msg.role === 'viewer') patch.role = msg.role;
    if (typeof msg.viewerFreeNav === 'boolean') patch.viewerFreeNav = msg.viewerFreeNav;
    this.store.patch('presentation', patch, { source: 'system' });

    if (!wasConnected) this.bus.emit('sync:status', { connected: true });
    this.bus.emit('sync:welcome', msg);
    if (clients) this.bus.emit('sync:clients', { t: 'clients', viewers: this.clients.viewers, list: this.clients.list });
    if (Array.isArray(msg.models)) this.bus.emit('server:models', msg.models);
  }

  _alPresentacion(msg) {
    this.store.patch('presentation', this._datosPresentacion(msg), { source: 'system' });
    this.bus.emit('sync:presentation', msg);
  }

  _alClientes(msg) {
    this.clients = {
      viewers: Number(msg.viewers) || 0,
      list: Array.isArray(msg.list) ? msg.list : [],
    };
    this.store.patch('presentation', { viewers: this.clients.viewers }, { source: 'system' });
    this.bus.emit('sync:clients', msg);
  }

  _alError(msg) {
    const message = typeof msg.message === 'string' && msg.message ? msg.message : 'Error del servidor de sincronización';
    console.warn('[sync] el servidor rechazó una acción:', message);
    this.bus.emit('sync:error', { message });
    // Aviso al usuario, sin repetir el mismo texto durante unos segundos
    const now = Date.now();
    const last = this._toastSeen.get(message) || 0;
    if (now - last < TOAST_DEDUPE_MS) return;
    this._toastSeen.set(message, now);
    this.bus.emit('toast', { type: 'warning', message });
  }

  // ---------- API de envío ----------

  startPresentation() {
    return this.send({ t: 'presentation', active: true });
  }

  stopPresentation() {
    return this.send({ t: 'presentation', active: false });
  }

  takeControl() {
    return this.send({ t: 'take-control' });
  }

  sendState(slices, full = false) {
    return this.send({ t: 'state', slices, full: !!full });
  }

  sendCamera(cam) {
    return this.send({ t: 'camera', cam });
  }

  sendPointer(p) {
    return this.send({ t: 'pointer', p });
  }
}
