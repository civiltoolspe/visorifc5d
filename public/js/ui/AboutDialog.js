// Diálogo "Acerca de": autor, aplicación, red, hoja de ruta y licencias de terceros.
//
//   - Los datos del autor y de la aplicación se leen de /config/acerca.json (editable sin programar,
//     ver README). Si el archivo falta o no es válido se usan los valores por defecto de este módulo.
//   - El estado abierto/cerrado es LOCAL a este componente: no está en el store ni en ningún slice
//     sincronizado, así que abrirlo en el presentador no cambia nada en los espectadores.
//   - Es inofensivo (no toca el store ni la cámara): por eso su contenedor lleva data-allow-locked y
//     queda por encima de la capa de bloqueo, igual que el botón de pantalla completa. Al cerrarse, la
//     capa sigue bloqueando todo lo demás.
//   - Esc cierra solo el diálogo (su oyente se registra antes que el de los atajos y los detiene), el
//     foco queda atrapado dentro mientras está abierto y vuelve al botón que lo abrió.

import { h, copyText, setText } from './dom.js';
import { icon, logo } from './icons.js';
import { Component } from './Component.js';
import { lanUrlsOf } from './Panels.js';

export const ACERCA_URL = '/config/acerca.json';
const VERSION_POR_DEFECTO = '0.1.0';

// Valores por defecto: son los mismos que trae public/config/acerca.json.
export const ACERCA_POR_DEFECTO = Object.freeze({
  autor: Object.freeze({
    titulo: 'Ing. Civil',
    nombre: 'David Henry Bernilla Rodriguez',
    profesion: 'Ingeniero Civil',
    rol: 'Autor y desarrollador del Visor IFC 5D',
    correo: 'henrydavid.br.13@gmail.com',
  }),
  aplicacion: Object.freeze({
    nombre: 'Visor IFC 5D',
    fase: 'Fase 1 — Visor IFC/CAD georreferenciado y modo presentación',
    descripcion: 'Visor BIM para seguimiento 5D de obras: modelos IFC, planos DXF/DWG georreferenciados y presentaciones en red local.',
    anio: 2026,
    hojaDeRuta: Object.freeze([
      'Fase 2: lectura de cronogramas MS Project (XML)',
      'Avance, costos y tiempo de ejecución por partida (4D/5D) vinculados por GlobalId',
      'Curva S y reportes de avance',
    ]),
  }),
});

// Tecnologías y licencias de terceros (verificadas en node_modules/*/package.json).
export const TECNOLOGIAS = Object.freeze([
  { nombre: 'three.js', uso: 'Motor de gráficos 3D', licencia: 'MIT' },
  { nombre: 'web-ifc', uso: 'Lectura de modelos IFC (WebAssembly)', licencia: 'MPL-2.0' },
  { nombre: 'three-mesh-bvh', uso: 'Selección rápida de elementos en 3D', licencia: 'MIT' },
  { nombre: 'camera-controls', uso: 'Control de la cámara', licencia: 'MIT' },
  { nombre: 'dxf-parser', uso: 'Lectura de planos DXF', licencia: 'MIT' },
  {
    nombre: 'LibreDWG (@mlightcad/libredwg-web)',
    uso: 'Lectura de planos DWG',
    licencia: 'GPL-3.0',
    nota: 'LibreDWG se usa para leer archivos DWG. Su licencia GPL-3.0 aplica al redistribuir la aplicación.',
  },
  { nombre: 'Express', uso: 'Servidor web de esta PC', licencia: 'MIT' },
  { nombre: 'ws', uso: 'Conexión en vivo del modo presentación', licencia: 'MIT' },
  { nombre: 'multer', uso: 'Subida de archivos al servidor', licencia: 'MIT' },
  { nombre: 'Urbanist', uso: 'Tipografía de la interfaz', licencia: 'SIL OFL 1.1' },
]);

// Campos del autor que se leen del JSON y su longitud máxima. Los de teléfono en adelante son opcionales:
// si no están o vienen vacíos, la fila correspondiente no se muestra.
const CAMPOS_AUTOR = [
  ['titulo', 60],
  ['profesion', 120],
  ['rol', 160],
  ['correo', 120],
  ['telefono', 40],
  ['colegiatura', 60],
  ['empresa', 120],
  ['ubicacion', 120],
  ['web', 200],
  ['linkedin', 200],
];

// Palabras que no cuentan para las iniciales ("María de los Ángeles Pérez" -> M, P)
const PARTICULAS = new Set(['de', 'del', 'la', 'las', 'los', 'y', 'e', 'da', 'do', 'di', 'van', 'von']);

// ---------------------------------------------------------------------------------------------
// Datos: lectura y normalización de acerca.json

function esObjeto(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

// Texto limpio de una sola línea y de longitud acotada ('' si no es texto ni número).
function limpiar(valor, max = 200) {
  if (typeof valor === 'number' && Number.isFinite(valor)) valor = String(valor);
  if (typeof valor !== 'string') return '';
  return valor.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function copiaPorDefecto() {
  const d = ACERCA_POR_DEFECTO;
  return { autor: { ...d.autor }, aplicacion: { ...d.aplicacion, hojaDeRuta: [...d.aplicacion.hojaDeRuta] } };
}

function normalizarAutor(raw, porDefecto) {
  if (!esObjeto(raw)) return porDefecto;
  const nombre = limpiar(raw.nombre, 120);
  if (!nombre) return porDefecto; // un autor sin nombre no tiene sentido: se usa el de por defecto
  const autor = { nombre };
  for (const [campo, max] of CAMPOS_AUTOR) autor[campo] = limpiar(raw[campo], max);
  return autor;
}

function normalizarAplicacion(raw, porDefecto) {
  if (!esObjeto(raw)) return porDefecto;
  const tiene = (k) => Object.prototype.hasOwnProperty.call(raw, k);
  const anio = Number(raw.anio);
  let hojaDeRuta = porDefecto.hojaDeRuta;
  if (tiene('hojaDeRuta')) hojaDeRuta = Array.isArray(raw.hojaDeRuta) ? raw.hojaDeRuta.map((x) => limpiar(x, 200)).filter(Boolean).slice(0, 12) : [];
  return {
    nombre: limpiar(raw.nombre, 80) || porDefecto.nombre,
    fase: tiene('fase') ? limpiar(raw.fase, 160) : porDefecto.fase,
    descripcion: tiene('descripcion') ? limpiar(raw.descripcion, 500) : porDefecto.descripcion,
    anio: Number.isInteger(anio) && anio >= 1900 && anio <= 2999 ? anio : porDefecto.anio,
    hojaDeRuta,
  };
}

// Convierte el contenido de acerca.json (ya interpretado) en datos listos para dibujar.
// Siempre devuelve un objeto utilizable: lo que no es válido se sustituye por los valores por defecto.
export function normalizarAcerca(raw) {
  const def = copiaPorDefecto();
  if (!esObjeto(raw)) return def;
  return { autor: normalizarAutor(raw.autor, def.autor), aplicacion: normalizarAplicacion(raw.aplicacion, def.aplicacion) };
}

// Lee /config/acerca.json. Devuelve null si falta, no se puede leer o no es JSON válido.
async function cargarAcerca() {
  try {
    const opciones = { cache: 'no-store', headers: { Accept: 'application/json' } };
    if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) opciones.signal = AbortSignal.timeout(8000);
    const res = await fetch(ACERCA_URL, opciones);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw = await res.json();
    if (!esObjeto(raw)) throw new Error('el JSON debe ser un objeto');
    return normalizarAcerca(raw);
  } catch (err) {
    console.warn('[acerca] se usan los datos por defecto:', err?.message || err);
    return null;
  }
}

// Iniciales del nombre: primera letra del primer nombre y del primer apellido. Con cuatro palabras o más
// (dos nombres y dos apellidos) el primer apellido es la tercera: "David Henry Bernilla Rodriguez" -> DB.
export function inicialesDe(nombre) {
  const palabras = limpiar(nombre, 160).split(' ').filter((w) => w && !PARTICULAS.has(w.toLowerCase()));
  if (!palabras.length) return '';
  const apellido = palabras.length >= 4 ? palabras[2] : palabras[1];
  const letra = (w) => (w ? w.match(/\p{L}/u)?.[0] || '' : '');
  return (letra(palabras[0]) + letra(apellido)).toLocaleUpperCase('es');
}

// ---------------------------------------------------------------------------------------------
// Enlaces seguros

const RE_CORREO = /^[^\s@<>"'()[\],;:\\]+@[^\s@<>"'()[\],;:\\]+\.[^\s@<>"'()[\],;:\\]+$/;

export function hrefCorreo(correo) {
  return RE_CORREO.test(correo) ? `mailto:${correo}` : null;
}

export function hrefTelefono(telefono) {
  const num = String(telefono || '').replace(/(?!^\+)[^\d]/g, '');
  return num.replace(/\D/g, '').length >= 5 ? `tel:${num}` : null;
}

// Solo esquemas http/https. Sin esquema ("www.ejemplo.com") se asume https; cualquier otro esquema
// (javascript:, data:...) no genera enlace.
export function hrefWeb(valor) {
  const s = String(valor || '').trim();
  if (!s) return null;
  const conEsquema = /^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s.replace(/^\/\//, '')}`;
  try {
    const u = new URL(conEsquema);
    return (u.protocol === 'http:' || u.protocol === 'https:') && u.hostname ? u.href : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------

let contador = 0;

export class AboutDialog extends Component {
  constructor(ui) {
    super(ui);
    this.data = copiaPorDefecto();
    this._clave = JSON.stringify(this.data);
    this._seq = 0;
    this.el = null; // contenedor (fondo) mientras el diálogo está abierto
    this.card = null;
    this.opener = null;
    this.trigger = null; // botón al que devolver el foco si el que abrió ya no sirve
    this._timers = new Set();

    // Esc y Tab: el oyente se registra antes que los de Shortcuts y LockLayer (App.js construye este
    // componente primero), de modo que Esc cierra solo el diálogo y no llega a limpiar la selección.
    this.listen(window, 'keydown', (e) => this._onKey(e), true);
    this.watch('presentation'); // rol y URLs de red
    this.recargar(); // precarga: la primera apertura ya muestra los datos del archivo
  }

  get isOpen() {
    return !!this.el;
  }

  // Botón de la cabecera al que devolver el foco cuando quien abrió el diálogo ya no está disponible
  setTrigger(el) {
    this.trigger = el;
  }

  // Vuelve a leer acerca.json (así los cambios del archivo se ven sin recargar la página) y, si cambió
  // algo con el diálogo abierto, lo redibuja.
  async recargar() {
    const seq = ++this._seq;
    const siguiente = (await cargarAcerca()) || copiaPorDefecto();
    if (this._disposed || seq !== this._seq) return;
    const clave = JSON.stringify(siguiente);
    if (clave === this._clave) return;
    this.data = siguiente;
    this._clave = clave;
    if (this.isOpen) this._pintarTodo();
  }

  open(opener = null) {
    if (this.isOpen) {
      this.closeBtn.focus({ preventScroll: true });
      return;
    }
    const activo = document.activeElement;
    this.opener = opener instanceof HTMLElement ? opener : activo instanceof HTMLElement && activo !== document.body ? activo : null;
    this.ui.closePopovers();
    this._construir();
    this.ui.root.append(this.el);
    void this.el.offsetWidth; // fuerza el reflujo para animar la entrada
    this.el.classList.add('is-in');
    this.closeBtn.focus({ preventScroll: true });
    this.recargar();
  }

  close() {
    if (!this.isOpen) return;
    const el = this.el;
    this.el = null;
    this.card = null;
    for (const t of this._timers) clearTimeout(t);
    this._timers.clear();
    el.remove();
    this._devolverFoco();
  }

  render() {
    if (this.isOpen) this._pintarRed();
  }

  dispose() {
    this.close();
    super.dispose();
  }

  // ---------------------------------------------------------------- teclado y foco

  _onKey(e) {
    if (!this.isOpen) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopImmediatePropagation();
      this.close();
    } else if (e.key === 'Tab') {
      this._atraparTab(e);
    }
  }

  _enfocables() {
    const sel = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    return [...this.card.querySelectorAll(sel)].filter((el) => el.offsetParent !== null);
  }

  _atraparTab(e) {
    const lista = this._enfocables();
    if (!lista.length) {
      e.preventDefault();
      this.card.focus({ preventScroll: true });
      return;
    }
    const primero = lista[0];
    const ultimo = lista[lista.length - 1];
    const activo = document.activeElement;
    if (!this.card.contains(activo) || activo === this.card) {
      e.preventDefault();
      (e.shiftKey ? ultimo : primero).focus();
    } else if (e.shiftKey && activo === primero) {
      e.preventDefault();
      ultimo.focus();
    } else if (!e.shiftKey && activo === ultimo) {
      e.preventDefault();
      primero.focus();
    }
  }

  _devolverFoco() {
    const usable = (el) => el instanceof HTMLElement && el.isConnected && !el.hidden && !el.closest('[inert]');
    const destino = usable(this.opener) ? this.opener : usable(this.trigger) ? this.trigger : null;
    this.opener = null;
    destino?.focus({ preventScroll: true });
  }

  // ---------------------------------------------------------------- construcción

  _construir() {
    const tituloId = `about-title-${++contador}`;
    this.closeBtn = h(
      'button',
      { type: 'button', class: 'btn btn--icon btn--ghost about__close', title: 'Cerrar', 'aria-label': 'Cerrar', on: { click: () => this.close() } },
      icon('x', { size: 18 }),
    );
    this.nameEl = h('span', { class: 'about__app-name' });
    this.phaseEl = h('p', { class: 'about__phase' });
    this.versionEl = h('span', { class: 'about__version' });
    this.bodyEl = h('div', { class: 'about__body' });
    this.footEl = h('footer', { class: 'about__foot' });
    this.liveEl = h('span', { class: 'about__sr', role: 'status', 'aria-live': 'polite' });

    const head = h(
      'header',
      { class: 'about__head' },
      h('span', { class: 'about__logo', 'aria-hidden': 'true' }, logo({ size: 56 })),
      h(
        'div',
        { class: 'about__heading' },
        h('h2', { class: 'about__title', id: tituloId }, h('span', { class: 'about__eyebrow', text: 'Acerca de ' }), this.nameEl),
        h('div', { class: 'about__meta' }, this.versionEl, this.phaseEl),
      ),
      this.closeBtn,
    );
    this.card = h(
      'div',
      { class: 'about', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': tituloId, tabindex: '-1' },
      head,
      this.bodyEl,
      this.footEl,
      this.liveEl,
    );

    // Se cierra al hacer clic en el fondo, pero no al soltar allí un arrastre empezado dentro del diálogo
    let pulsoEnFondo = false;
    this.el = h(
      'div',
      {
        class: 'about-backdrop',
        'data-allow-locked': '',
        on: {
          pointerdown: (e) => {
            pulsoEnFondo = e.target === this.el;
          },
          click: (e) => {
            if (e.target === this.el && pulsoEnFondo) this.close();
            pulsoEnFondo = false;
          },
        },
      },
      this.card,
    );
    this._pintarTodo();
  }

  _version() {
    return limpiar(this.ctx.info?.version, 40) || VERSION_POR_DEFECTO;
  }

  _pintarTodo() {
    const { autor, aplicacion: app } = this.data;
    const activo = document.activeElement;
    const teniaFoco = this.bodyEl.contains(activo);

    setText(this.nameEl, app.nombre);
    setText(this.phaseEl, app.fase);
    this.phaseEl.hidden = !app.fase;
    setText(this.versionEl, `Versión ${this._version()}`);

    this.netEl = this._bloqueRed();
    this._claveRed = null;
    this.bodyEl.replaceChildren(...[this._tarjetaAutor(autor), this._seccionApp(app), this._seccionRuta(app), this._seccionTecnologias()].filter(Boolean));
    this._pintarRed();

    const pie = [autor.titulo, autor.nombre].filter(Boolean).join(' ');
    setText(this.footEl, `© ${app.anio} ${pie}`);

    if (teniaFoco) this.closeBtn.focus({ preventScroll: true });
  }

  // ---------------------------------------------------------------- autor

  _tarjetaAutor(autor) {
    const filas = [];
    const fila = (campo, nombreIcono, etiqueta, valor, extra = null) => {
      filas.push(
        h(
          'li',
          { class: 'about__contact', 'data-field': campo },
          h('span', { class: 'about__contact-icon', 'aria-hidden': 'true' }, icon(nombreIcono, { size: 17 })),
          h('span', { class: 'about__contact-text' }, h('span', { class: 'about__contact-label', text: etiqueta }), valor),
          extra,
        ),
      );
    };
    const enlace = (texto, href, externo = false) => {
      if (!href) return h('span', { class: 'about__contact-value', text: texto });
      const a = h('a', { class: 'about__link', href, text: texto });
      if (externo) {
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.title = 'Se abre en una pestaña nueva';
        a.append(icon('external', { size: 13, className: 'about__link-ext' }));
      }
      return a;
    };

    if (autor.correo) fila('correo', 'mail', 'Correo', enlace(autor.correo, hrefCorreo(autor.correo)), this._botonCopiar(autor.correo, 'Copiar el correo', 'Correo copiado'));
    if (autor.telefono) fila('telefono', 'phone', 'Teléfono', enlace(autor.telefono, hrefTelefono(autor.telefono)));
    if (autor.colegiatura) fila('colegiatura', 'id-card', 'Colegiatura', h('span', { class: 'about__contact-value', text: autor.colegiatura }));
    if (autor.empresa) fila('empresa', 'building', 'Empresa', h('span', { class: 'about__contact-value', text: autor.empresa }));
    if (autor.ubicacion) fila('ubicacion', 'pin', 'Ubicación', h('span', { class: 'about__contact-value', text: autor.ubicacion }));
    if (autor.web) fila('web', 'globe', 'Web', enlace(autor.web, hrefWeb(autor.web), true));
    if (autor.linkedin) fila('linkedin', 'link', 'LinkedIn', enlace(autor.linkedin, hrefWeb(autor.linkedin), true));

    return h(
      'section',
      { class: 'about__author', 'aria-label': 'Autor' },
      h('div', { class: 'about__avatar', 'aria-hidden': 'true', text: inicialesDe(autor.nombre) }),
      h(
        'div',
        { class: 'about__who' },
        autor.titulo ? h('span', { class: 'about__degree', text: autor.titulo }) : null,
        h('h3', { class: 'about__name', text: autor.nombre }),
        autor.profesion ? h('p', { class: 'about__profession', text: autor.profesion }) : null,
        autor.rol ? h('p', { class: 'about__role', text: autor.rol }) : null,
      ),
      filas.length ? h('ul', { class: 'about__contacts' }, ...filas) : null,
    );
  }

  // Botón "copiar": cambia a un check un instante y lo anuncia a los lectores de pantalla.
  _botonCopiar(texto, titulo, aviso) {
    const btn = h('button', { type: 'button', class: 'btn btn--icon btn--sm btn--ghost about__copy', title: titulo, 'aria-label': titulo }, icon('copy', { size: 15 }));
    btn.addEventListener('click', async () => {
      const ok = await copyText(texto);
      if (!this.isOpen || !btn.isConnected) return;
      if (!this.card.contains(document.activeElement)) btn.focus({ preventScroll: true }); // el respaldo de copyText mueve el foco
      btn.classList.toggle('is-done', ok);
      btn.replaceChildren(icon(ok ? 'check' : 'alert', { size: 15 }));
      setText(this.liveEl, ok ? aviso : 'No se pudo copiar');
      const t = setTimeout(() => {
        this._timers.delete(t);
        if (!btn.isConnected) return;
        btn.classList.remove('is-done');
        btn.replaceChildren(icon('copy', { size: 15 }));
        setText(this.liveEl, '');
      }, 1800);
      this._timers.add(t);
    });
    return btn;
  }

  // ---------------------------------------------------------------- aplicación y red

  _seccionApp(app) {
    return h(
      'section',
      { class: 'about__sec about__sec--app' },
      h('h3', { class: 'about__h', text: 'Aplicación' }),
      app.descripcion ? h('p', { class: 'about__desc', text: app.descripcion }) : null,
      this.netEl,
    );
  }

  _bloqueRed() {
    return h('dl', { class: 'about__net' });
  }

  // Rol de esta PC y direcciones de red (store.presentation.lanUrls). Solo lectura: se repinta si cambia el store.
  _pintarRed() {
    if (!this.netEl) return;
    const rol = this.ui.isViewer() ? 'Espectador' : 'Presentador';
    const urls = lanUrlsOf(this.ui);
    const clave = `${rol}|${urls.join('|')}`;
    if (clave === this._claveRed && this.netEl.childElementCount) return; // sin cambios: no se reconstruye (conserva el foco y el aviso de copiado)
    this._claveRed = clave;
    const valorUrls = urls.length
      ? h(
          'ul',
          { class: 'about__urls' },
          ...urls.map((u) => h('li', { class: 'about__url' }, h('code', { class: 'about__url-text', text: u }), this._botonCopiar(u, `Copiar ${u}`, 'Dirección copiada'))),
        )
      : h('span', { class: 'about__muted', text: 'Sin dirección de red detectada: el visor solo se ve en esta PC.' });
    const enfocado = this.netEl.contains(document.activeElement);
    this.netEl.replaceChildren(
      h('dt', { class: 'about__net-k', text: 'Esta PC' }),
      h('dd', { class: 'about__net-v' }, h('span', { class: `badge about__role-badge about__role-badge--${rol === 'Espectador' ? 'viewer' : 'presenter'}`, text: rol })),
      h('dt', { class: 'about__net-k', text: 'Red local' }),
      h('dd', { class: 'about__net-v' }, valorUrls),
    );
    if (enfocado) this.closeBtn.focus({ preventScroll: true });
  }

  // ---------------------------------------------------------------- hoja de ruta

  _seccionRuta(app) {
    if (!app.hojaDeRuta.length) return null;
    return h(
      'section',
      { class: 'about__sec about__sec--road' },
      h('h3', { class: 'about__h', text: 'Hoja de ruta' }),
      h('ol', { class: 'about__road' }, ...app.hojaDeRuta.map((t) => h('li', { class: 'about__road-item' }, h('span', { text: t })))),
    );
  }

  // ---------------------------------------------------------------- tecnologías y licencias

  _seccionTecnologias() {
    const claseLicencia = (l) => (l === 'GPL-3.0' ? 'badge--accent' : l === 'MPL-2.0' ? 'badge--warn' : 'badge--plain');
    const notas = TECNOLOGIAS.filter((t) => t.nota);
    return h(
      'section',
      { class: 'about__sec about__sec--tech' },
      h('h3', { class: 'about__h', text: 'Tecnologías y licencias de terceros' }),
      h(
        'ul',
        { class: 'about__tech' },
        ...TECNOLOGIAS.map((t) =>
          h(
            'li',
            { class: 'about__tech-item', 'data-license': t.licencia },
            h('span', { class: 'about__tech-main' }, h('strong', { class: 'about__tech-name', text: t.nombre }), h('span', { class: 'about__tech-use', text: t.uso })),
            h('span', { class: `badge ${claseLicencia(t.licencia)} about__tech-license`, text: t.licencia }),
          ),
        ),
      ),
      ...notas.map((t) => h('p', { class: 'about__note' }, icon('alert', { size: 15 }), h('span', { text: t.nota }))),
    );
  }
}
