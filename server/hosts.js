// Validación de la cabecera Host (defensa contra "DNS rebinding").
//
// Una página maliciosa puede hacer que su dominio resuelva a 127.0.0.1 y así hablar con este servidor
// desde el navegador de la PC anfitriona: Host y Origin valdrían lo mismo (el dominio del atacante), la
// comprobación Origin == Host pasaría y, como el socket es loopback, el rol sería "presentador". Por eso solo se
// atienden peticiones cuyo Host sea una dirección que el atacante no puede controlar:
//   - una IP literal (v4 o v6): un navegador que llega por IP nunca resuelve nombres, no hay rebinding posible;
//   - localhost y *.localhost;
//   - el nombre de esta PC (os.hostname()) y su forma mDNS "<nombre>.local";
//   - los nombres que el administrador añada en ALLOWED_HOSTS (p. ej. un nombre DNS de la oficina).

import net from 'node:net';
import os from 'node:os';

// Nombre de host (minúsculas, sin puerto, sin corchetes IPv6 ni punto final) de una cabecera Host, o null si es inválida.
export function hostnameOf(header) {
  if (typeof header !== 'string') return null;
  const h = header.trim().toLowerCase();
  if (!h || h.length > 255) return null;
  let name;
  if (h.startsWith('[')) {
    const fin = h.indexOf(']');
    if (fin < 0) return null;
    name = h.slice(1, fin);
    if (!/^(:\d{1,5})?$/.test(h.slice(fin + 1))) return null;
  } else {
    const partes = h.split(':');
    if (partes.length > 2) return null;
    if (partes.length === 2 && !/^\d{1,5}$/.test(partes[1])) return null;
    name = partes[0];
  }
  if (name.endsWith('.') && !net.isIP(name)) name = name.slice(0, -1);
  return name || null;
}

// Convierte "a.com, *.b.com ,C" en ['a.com', '*.b.com', 'c'].
export function parseHostList(texto) {
  return String(texto || '')
    .split(/[,\s;]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export class HostGuard {
  // extra: nombres adicionales ("pc-oficina.lan" o "*.empresa.local"); hostname: nombre de esta PC (pruebas).
  constructor({ extra = [], hostname = os.hostname() } = {}) {
    this.exact = new Set(['localhost']);
    this.suffixes = ['.localhost'];
    const propio = String(hostname || '').trim().toLowerCase();
    if (propio) {
      this.exact.add(propio);
      this.exact.add(`${propio}.local`);
      const corto = propio.split('.')[0];
      if (corto) {
        this.exact.add(corto);
        this.exact.add(`${corto}.local`);
      }
    }
    for (const patron of extra) {
      const p = String(patron).trim().toLowerCase();
      if (!p) continue;
      if (p.startsWith('*.')) this.suffixes.push(p.slice(1));
      else this.exact.add(p);
    }
  }

  // ¿Se atiende una petición con esta cabecera Host?
  allows(header) {
    // HTTP/1.0 sin Host: ningún navegador lo envía, así que no hay rebinding posible
    if (header === undefined) return true;
    const name = hostnameOf(header);
    if (!name) return false;
    if (net.isIP(name)) return true;
    if (this.exact.has(name)) return true;
    return this.suffixes.some((s) => name.endsWith(s) && name.length > s.length);
  }
}
