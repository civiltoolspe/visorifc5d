// Cliente de la API REST del servidor (ver docs/ARQUITECTURA.md, sección 5).
//
//   const api = new ApiClient();
//   await api.getInfo();                              // rol, URL de red, versión...
//   await api.listModels();                           // ModelRecord[]
//   await api.uploadModel(file, (loaded, total) => {}); // XMLHttpRequest para tener progreso
//   await api.downloadModel(id, (loaded, total) => {}); // fetch + stream; devuelve ArrayBuffer
//   await api.patchModel(id, { georef, cad, name });
//   await api.deleteModel(id);
//   await api.getViews();                             // vistas guardadas: View[]
//   await api.putViews(items);                        // presentador: reemplaza la lista guardada en el servidor
//
// Si hay un PIN de presentador guardado (sessionStorage 'visor.pin'), se envía en
// la cabecera X-Presenter-Pin de cada petición. Los errores son instancias de
// ApiError con un mensaje legible en español (tomado de { error } del servidor).

const PIN_KEY = 'visor.pin';

export class ApiError extends Error {
  constructor(message, status = 0, cause = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    if (cause) this.cause = cause;
  }
}

// Mensajes de respaldo cuando el servidor no devuelve { error }
const MENSAJES_ESTADO = {
  400: 'La petición no es válida.',
  403: 'Solo el presentador puede realizar esta acción.',
  404: 'No se encontró el recurso solicitado (¿el modelo fue eliminado?).',
  413: 'El archivo es demasiado grande para el servidor.',
  500: 'Error interno del servidor.',
  502: 'El servidor no está disponible.',
  503: 'El servidor no está disponible.',
};

const MENSAJE_RED = 'No se pudo conectar con el servidor. Revisa que siga encendido y que estés en la misma red.';

// Extrae el mensaje de error de un cuerpo de respuesta (texto JSON { error } o texto plano).
function mensajeDeCuerpo(texto, status) {
  if (texto) {
    try {
      const data = JSON.parse(texto);
      if (data && typeof data.error === 'string' && data.error) return data.error;
    } catch { /* no era JSON */ }
  }
  return MENSAJES_ESTADO[status] || `El servidor respondió con el error ${status}.`;
}

export class ApiClient {
  constructor({ base = '' } = {}) {
    this.base = String(base).replace(/\/+$/, '');
    this._pinMemoria = '';
  }

  // ---------- PIN de presentador ----------

  getPin() {
    try {
      const v = sessionStorage.getItem(PIN_KEY);
      if (v !== null) return v;
    } catch { /* sessionStorage no disponible */ }
    return this._pinMemoria;
  }

  setPin(pin) {
    const valor = pin == null ? '' : String(pin).trim();
    this._pinMemoria = valor;
    try {
      if (valor) sessionStorage.setItem(PIN_KEY, valor);
      else sessionStorage.removeItem(PIN_KEY);
    } catch { /* sessionStorage no disponible: queda solo en memoria */ }
  }

  _headers(extra = {}) {
    const headers = { ...extra };
    const pin = this.getPin();
    if (pin) headers['X-Presenter-Pin'] = pin;
    return headers;
  }

  // ---------- Utilidades ----------

  fileUrl(id) {
    return `${this.base}/api/models/${encodeURIComponent(id)}/file`;
  }

  // Petición JSON; devuelve el cuerpo ya interpretado (o null si es 204).
  async _json(method, url, body) {
    const init = { method, headers: this._headers({ Accept: 'application/json' }) };
    if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    let res;
    try {
      res = await fetch(`${this.base}${url}`, init);
    } catch (err) {
      throw new ApiError(MENSAJE_RED, 0, err);
    }
    const texto = await res.text().catch(() => '');
    if (!res.ok) throw new ApiError(mensajeDeCuerpo(texto, res.status), res.status);
    if (res.status === 204 || !texto) return null;
    try {
      return JSON.parse(texto);
    } catch (err) {
      throw new ApiError('Respuesta inválida del servidor.', res.status, err);
    }
  }

  // ---------- Información y modelos ----------

  getInfo() {
    return this._json('GET', '/api/info');
  }

  listModels() {
    return this._json('GET', '/api/models');
  }

  patchModel(id, partial) {
    return this._json('PATCH', `/api/models/${encodeURIComponent(id)}`, partial || {});
  }

  async deleteModel(id) {
    await this._json('DELETE', `/api/models/${encodeURIComponent(id)}`);
  }

  // ---------- Vistas guardadas ----------

  async getViews() {
    const data = await this._json('GET', '/api/views');
    return Array.isArray(data?.items) ? data.items : [];
  }

  async putViews(items) {
    const data = await this._json('PUT', '/api/views', { items: Array.isArray(items) ? items : [] });
    return Array.isArray(data?.items) ? data.items : [];
  }

  // Sube un archivo (.ifc, .dxf, .dwg). Usa XMLHttpRequest porque fetch no informa del progreso de subida.
  // onProgress(loaded, total) con bytes enviados. Opcional: { signal } (AbortSignal) para cancelar.
  uploadModel(file, onProgress, { signal } = {}) {
    return new Promise((resolve, reject) => {
      if (!file) {
        reject(new ApiError('No se seleccionó ningún archivo.'));
        return;
      }
      const form = new FormData();
      form.append('file', file, file.name || 'modelo');

      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${this.base}/api/models`);
      xhr.responseType = 'text';
      const headers = this._headers();
      for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);

      let ultimoTotal = file.size;
      if (typeof onProgress === 'function' && xhr.upload) {
        xhr.upload.onprogress = (e) => {
          if (!e.lengthComputable) return;
          ultimoTotal = e.total;
          onProgress(e.loaded, e.total);
        };
      }
      xhr.onload = () => {
        const texto = xhr.responseText || '';
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            if (typeof onProgress === 'function') onProgress(ultimoTotal, ultimoTotal);
            resolve(JSON.parse(texto));
          } catch (err) {
            reject(new ApiError('Respuesta inválida del servidor.', xhr.status, err));
          }
          return;
        }
        reject(new ApiError(mensajeDeCuerpo(texto, xhr.status), xhr.status));
      };
      xhr.onerror = () => reject(new ApiError(MENSAJE_RED));
      xhr.ontimeout = () => reject(new ApiError('La subida tardó demasiado y se canceló.'));
      xhr.onabort = () => reject(new ApiError('Subida cancelada.'));

      if (signal) {
        if (signal.aborted) {
          reject(new ApiError('Subida cancelada.'));
          return;
        }
        signal.addEventListener('abort', () => xhr.abort(), { once: true });
      }
      xhr.send(form);
    });
  }

  // Descarga un modelo como ArrayBuffer leyendo el cuerpo en streaming para informar del progreso.
  // onProgress(loaded, total): total es 0 si el servidor no indica Content-Length.
  async downloadModel(id, onProgress, { signal } = {}) {
    let res;
    try {
      res = await fetch(this.fileUrl(id), { headers: this._headers(), signal });
    } catch (err) {
      if (err?.name === 'AbortError') throw new ApiError('Descarga cancelada.', 0, err);
      throw new ApiError(MENSAJE_RED, 0, err);
    }
    if (!res.ok) {
      const texto = await res.text().catch(() => '');
      throw new ApiError(mensajeDeCuerpo(texto, res.status), res.status);
    }
    const total = Number(res.headers.get('Content-Length')) || 0;
    const informar = typeof onProgress === 'function' ? onProgress : null;

    // Sin streaming disponible: se descarga de una vez
    if (!res.body || typeof res.body.getReader !== 'function') {
      const buffer = await res.arrayBuffer();
      if (informar) informar(buffer.byteLength, total || buffer.byteLength);
      return buffer;
    }

    const lector = res.body.getReader();
    let cargado = 0;
    // Con tamaño conocido se reserva el búfer final una sola vez (evita duplicar memoria en modelos grandes)
    let destino = total ? new Uint8Array(total) : null;
    const trozos = [];
    try {
      for (;;) {
        const { done, value } = await lector.read();
        if (done) break;
        if (destino && cargado + value.byteLength <= destino.byteLength) {
          destino.set(value, cargado);
        } else {
          // Llegó más de lo anunciado (o no había tamaño): pasa a acumular trozos
          if (destino) {
            trozos.push(destino.subarray(0, cargado));
            destino = null;
          }
          trozos.push(value);
        }
        cargado += value.byteLength;
        if (informar) informar(cargado, total);
      }
    } catch (err) {
      if (err?.name === 'AbortError') throw new ApiError('Descarga cancelada.', 0, err);
      throw new ApiError('Se interrumpió la descarga del modelo.', 0, err);
    }

    if (destino) {
      // Si llegaron menos bytes de los anunciados se recorta
      return cargado === destino.byteLength ? destino.buffer : destino.slice(0, cargado).buffer;
    }
    const unido = new Uint8Array(cargado);
    let pos = 0;
    for (const t of trozos) {
      unido.set(t, pos);
      pos += t.byteLength;
    }
    return unido.buffer;
  }
}
