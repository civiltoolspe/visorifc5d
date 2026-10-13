// Determinación del rol (presenter | viewer) de cada conexión.
//
// El rol se decide por la IP del SOCKET (req.socket.remoteAddress); nunca se
// confía en X-Forwarded-For ni en cabeceras similares. Una conexión desde
// loopback (la propia PC anfitriona) es presentador. Otra PC puede serlo
// si envía el PIN correcto (cabecera X-Presenter-Pin en HTTP o campo pin del
// mensaje hello en WebSocket) cuando PRESENTER_PIN está definido.

import crypto from 'node:crypto';

// Quita el prefijo IPv4-mapeado de IPv6 ("::ffff:192.168.1.5" -> "192.168.1.5").
export function normalizeIp(addr) {
  if (!addr) return '';
  const a = String(addr);
  return a.startsWith('::ffff:') ? a.slice(7) : a;
}

export function isLoopback(addr) {
  const ip = normalizeIp(addr);
  return ip === '::1' || ip === '127.0.0.1' || ip.startsWith('127.');
}

function digest(texto) {
  return crypto.createHash('sha256').update(String(texto)).digest();
}

// Comparación en tiempo constante.
function mismoPin(a, b) {
  return crypto.timingSafeEqual(digest(a), digest(b));
}

export class RoleResolver {
  // limiteFallos: intentos de PIN erróneos permitidos por IP y ventana antes de ignorar los PIN de esa IP.
  constructor({ pin = null, limiteFallos = 30, ventanaMs = 60000 } = {}) {
    this.pin = pin;
    this.limiteFallos = limiteFallos;
    this.ventanaMs = ventanaMs;
    this._fallos = new Map(); // ip -> { n, hasta }
  }

  get pinEnabled() {
    return !!this.pin;
  }

  _bloqueada(ip) {
    const f = this._fallos.get(ip);
    if (!f) return false;
    if (Date.now() > f.hasta) {
      this._fallos.delete(ip);
      return false;
    }
    return f.n >= this.limiteFallos;
  }

  _registrarFallo(ip) {
    const ahora = Date.now();
    const f = this._fallos.get(ip);
    if (!f || ahora > f.hasta) this._fallos.set(ip, { n: 1, hasta: ahora + this.ventanaMs });
    else f.n += 1;
    // Limpieza ocasional para que el mapa no crezca sin límite
    if (this._fallos.size > 500) {
      for (const [k, v] of this._fallos) if (ahora > v.hasta) this._fallos.delete(k);
    }
  }

  // ¿Es válido este PIN para esta IP? (aplica el límite de intentos fallidos)
  pinValido(ip, pin) {
    if (!this.pin || typeof pin !== 'string' || pin === '') return false;
    if (this._bloqueada(ip)) return false;
    if (mismoPin(pin, this.pin)) return true;
    this._registrarFallo(ip);
    return false;
  }

  // remoteAddress: IP del socket; pin: PIN enviado por el cliente (o undefined).
  resolve(remoteAddress, pin) {
    if (isLoopback(remoteAddress)) return 'presenter';
    return this.pinValido(normalizeIp(remoteAddress), pin) ? 'presenter' : 'viewer';
  }

  // Rol de una petición HTTP de Express/Node.
  forRequest(req) {
    const pin = req.headers['x-presenter-pin'];
    return this.resolve(req.socket.remoteAddress, Array.isArray(pin) ? pin[0] : pin);
  }
}
