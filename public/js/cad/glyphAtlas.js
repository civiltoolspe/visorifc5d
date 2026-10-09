// Atlas de glifos para el texto CAD (solo hilo principal: usa canvas 2D).
//
// - Latin-1 completo (0x20–0xFF) en una rejilla de 16×16 celdas de 64 px, con mipmaps.
//   Las posiciones 0x80–0x9F (controles en Latin-1) alojan los símbolos de cp1252
//   (€ – — ‘ ’ “ ” • … ™ …).
// - Tipografía sans-serif del sistema. La textura es RGBA con color blanco y la forma del glifo
//   en el canal alfa (el color final viene de los colores por vértice).
// - La composición de un conjunto de textos produce una única malla (un draw call por capa).

import * as THREE from 'three';
import { TEXT_STRIDE } from './geometryBuilder.js';

const ATLAS_SIZE = 1024;
const CELL = 64;
const COLS = ATLAS_SIZE / CELL; // 16
const FONT_PX = 44; // tamaño de la tipografía dentro de la celda
const PAD = 10; // margen izquierdo del glifo dentro de su celda (px)
const BASELINE = 48; // distancia de la línea base al borde superior de la celda (px)
const MTEXT_PITCH = 1.667; // interlineado base de MTEXT en alturas de texto

// Unicode → posición de cp1252 en 0x80–0x9F (más algunos símbolos CAD)
const EXTRA_TO_SLOT = new Map([
  [0x20ac, 0x80], [0x201a, 0x82], [0x0192, 0x83], [0x201e, 0x84], [0x2026, 0x85], [0x2020, 0x86],
  [0x2021, 0x87], [0x02c6, 0x88], [0x2030, 0x89], [0x0160, 0x8a], [0x2039, 0x8b], [0x0152, 0x8c],
  [0x017d, 0x8e], [0x2018, 0x91], [0x2019, 0x92], [0x201c, 0x93], [0x201d, 0x94], [0x2022, 0x95],
  [0x2013, 0x96], [0x2014, 0x97], [0x02dc, 0x98], [0x2122, 0x99], [0x0161, 0x9a], [0x203a, 0x9b],
  [0x0153, 0x9c], [0x017e, 0x9e], [0x0178, 0x9f],
  [0x2205, 0xd8], // ∅ → Ø
  [0x2300, 0xd8], // ⌀ → Ø
  [0x03a9, 0xd8],
]);
const SLOT_TO_CHAR = new Map();
for (const [cp, slot] of EXTRA_TO_SLOT) {
  if (slot >= 0x80 && slot <= 0x9f) SLOT_TO_CHAR.set(slot, String.fromCodePoint(cp));
}

// Tabla sRGB (0–255) → lineal (para los colores por vértice)
const SRGB_TO_LINEAR = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  SRGB_TO_LINEAR[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
export { SRGB_TO_LINEAR };

// Posición del glifo para un punto de código (o -1 si es un carácter de control)
export function slotOf(cp) {
  if (cp === 0x09) return 0x20;
  if (cp < 0x20) return -1;
  if (cp < 0x80 || (cp >= 0xa0 && cp <= 0xff)) return cp;
  const s = EXTRA_TO_SLOT.get(cp);
  if (s !== undefined) return s;
  return 0x3f; // '?'
}

export class GlyphAtlas {
  constructor({ anisotropy = 4 } = {}) {
    this.cell = CELL;
    this.advances = new Float32Array(256); // avance en px a FONT_PX
    this.capPx = FONT_PX * 0.716;
    this.texture = this._build(anisotropy);
  }

  _build(anisotropy) {
    const canvas = document.createElement('canvas');
    canvas.width = ATLAS_SIZE;
    canvas.height = ATLAS_SIZE;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.clearRect(0, 0, ATLAS_SIZE, ATLAS_SIZE);
    ctx.font = `${FONT_PX}px "Segoe UI", "Helvetica Neue", Arial, "DejaVu Sans", "Liberation Sans", sans-serif`;
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    ctx.fillStyle = '#ffffff';
    const hm = ctx.measureText('H');
    if (hm.actualBoundingBoxAscent > FONT_PX * 0.4) this.capPx = hm.actualBoundingBoxAscent;
    for (let slot = 0x20; slot < 256; slot++) {
      if (slot >= 0x7f && slot < 0xa0 && !SLOT_TO_CHAR.has(slot)) continue;
      const ch = SLOT_TO_CHAR.get(slot) ?? String.fromCharCode(slot);
      const col = slot % COLS;
      const row = Math.floor(slot / COLS);
      const x = col * CELL + PAD;
      const y = row * CELL + BASELINE;
      this.advances[slot] = ctx.measureText(ch).width;
      ctx.fillText(ch, x, y);
    }
    // El avance del espacio duro y de los vacíos
    if (!this.advances[0x20]) this.advances[0x20] = FONT_PX * 0.3;
    this.advances[0xa0] = this.advances[0x20];
    const img = ctx.getImageData(0, 0, ATLAS_SIZE, ATLAS_SIZE);
    const data = img.data;
    // RGB blanco en todos los píxeles: evita franjas oscuras al generar los mipmaps
    for (let i = 0; i < data.length; i += 4) {
      data[i] = 255;
      data[i + 1] = 255;
      data[i + 2] = 255;
    }
    this.coverage = img.data; // se conserva para pruebas (alfa por celda)
    const tex = new THREE.DataTexture(data, ATLAS_SIZE, ATLAS_SIZE, THREE.RGBAFormat, THREE.UnsignedByteType);
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.anisotropy = anisotropy;
    tex.colorSpace = THREE.NoColorSpace;
    tex.needsUpdate = true;
    return tex;
  }

  // Píxeles con alfa > 0 de la celda de un carácter (comprobación de que el glifo se dibujó)
  glyphInk(ch) {
    const slot = slotOf(ch.codePointAt(0));
    if (slot < 0) return 0;
    const col = slot % COLS;
    const row = Math.floor(slot / COLS);
    let n = 0;
    for (let y = 0; y < CELL; y++) {
      for (let x = 0; x < CELL; x++) {
        if (this.coverage[((row * CELL + y) * ATLAS_SIZE + col * CELL + x) * 4 + 3] > 16) n++;
      }
    }
    return n;
  }

  // Ancho de una línea en px (a FONT_PX)
  _lineWidth(line) {
    let w = 0;
    for (const ch of line) {
      const slot = slotOf(ch.codePointAt(0));
      if (slot >= 0) w += this.advances[slot];
    }
    return w;
  }

  // Parte las líneas de un MTEXT en palabras para ajustarlas al ancho (en px)
  _wrap(lines, maxPx) {
    const out = [];
    for (const line of lines) {
      if (this._lineWidth(line) <= maxPx) {
        out.push(line);
        continue;
      }
      const words = line.split(' ');
      let cur = '';
      for (const w of words) {
        const cand = cur ? `${cur} ${w}` : w;
        if (cur && this._lineWidth(cand) > maxPx) {
          out.push(cur);
          cur = w;
        } else {
          cur = cand;
        }
      }
      out.push(cur);
    }
    return out;
  }

  // Compone los textos de una capa en un único conjunto de quads.
  //  data: Float32Array con TEXT_STRIDE columnas por texto; strings: string[] en el mismo orden.
  // → { position, uv, color, index, glyphs } (Float32Array/Uint32Array) o null si no hay glifos
  layout(data, strings) {
    let maxChars = 0;
    for (const s of strings) maxChars += s.length;
    if (!maxChars) return null;
    const position = new Float32Array(maxChars * 12);
    const uv = new Float32Array(maxChars * 8);
    const color = new Float32Array(maxChars * 12);
    let g = 0; // glifos emitidos
    const cap = this.capPx;
    const inv = 1 / ATLAS_SIZE;

    for (let i = 0; i < strings.length; i++) {
      const o = i * TEXT_STRIDE;
      const px = data[o];
      const py = data[o + 1];
      const pz = data[o + 2];
      let ux = data[o + 3];
      let uy = data[o + 4];
      let uz = data[o + 5];
      let vx = data[o + 6];
      let vy = data[o + 7];
      let vz = data[o + 8];
      const h = data[o + 9];
      const wf = data[o + 10] || 1;
      const ha = data[o + 11];
      const va = data[o + 12];
      const wrapEm = data[o + 13];
      const spacing = data[o + 14] || 1;
      const rgb = data[o + 15] | 0;
      const kind = data[o + 16];
      const fitMode = data[o + 17];
      const fitLen = data[o + 18];
      const r = SRGB_TO_LINEAR[(rgb >> 16) & 255];
      const gC = SRGB_TO_LINEAR[(rgb >> 8) & 255];
      const b = SRGB_TO_LINEAR[rgb & 255];

      let lines = strings[i].split('\n');
      if (kind === 1 && wrapEm > 0) lines = this._wrap(lines, (wrapEm * cap) / wf);
      const n = lines.length;
      const widths = lines.map((l) => this._lineWidth(l));

      // Ajuste a un ancho dado (TEXT alineado / ajustado)
      let sx = 1;
      let sy = 1;
      if (fitMode && n === 1 && widths[0] > 0) {
        const natural = (widths[0] / cap) * wf;
        const f = fitLen / natural;
        if (Number.isFinite(f) && f > 0) {
          sx = f;
          if (fitMode === 1) sy = f;
        }
      }
      ux *= h * sx;
      uy *= h * sx;
      uz *= h * sx;
      vx *= h * sy;
      vy *= h * sy;
      vz *= h * sy;

      // Posición vertical de la primera línea base (en alturas de texto)
      const pitch = MTEXT_PITCH * spacing;
      const block = 1 + (n - 1) * pitch;
      let base0;
      if (kind === 1) {
        if (va === 3) base0 = -1;
        else if (va === 2) base0 = -1 + block / 2;
        else base0 = block - 1;
      } else if (va === 3) base0 = -1;
      else if (va === 2) base0 = -0.5;
      else if (va === 1) base0 = 0.3;
      else base0 = 0;

      for (let li = 0; li < n; li++) {
        const line = lines[li];
        const wTH = (widths[li] / cap) * wf; // ancho en alturas de texto
        const x0 = ha === 1 ? -wTH / 2 : ha === 2 ? -wTH : 0;
        const baseY = base0 - li * pitch;
        let pen = 0; // px
        for (const ch of line) {
          const slot = slotOf(ch.codePointAt(0));
          if (slot < 0) continue;
          const adv = this.advances[slot];
          if (slot !== 0x20 && slot !== 0xa0) {
            const col = slot % COLS;
            const row = Math.floor(slot / COLS);
            const gx0 = x0 + ((pen - PAD) / cap) * wf;
            const gx1 = gx0 + (CELL / cap) * wf;
            const gy0 = baseY - (CELL - BASELINE) / cap;
            const gy1 = baseY + BASELINE / cap;
            const k = g * 12;
            // vértices: (gx0,gy0) (gx1,gy0) (gx1,gy1) (gx0,gy1)
            position[k] = px + ux * gx0 + vx * gy0;
            position[k + 1] = py + uy * gx0 + vy * gy0;
            position[k + 2] = pz + uz * gx0 + vz * gy0;
            position[k + 3] = px + ux * gx1 + vx * gy0;
            position[k + 4] = py + uy * gx1 + vy * gy0;
            position[k + 5] = pz + uz * gx1 + vz * gy0;
            position[k + 6] = px + ux * gx1 + vx * gy1;
            position[k + 7] = py + uy * gx1 + vy * gy1;
            position[k + 8] = pz + uz * gx1 + vz * gy1;
            position[k + 9] = px + ux * gx0 + vx * gy1;
            position[k + 10] = py + uy * gx0 + vy * gy1;
            position[k + 11] = pz + uz * gx0 + vz * gy1;
            const u0 = col * CELL * inv;
            const u1 = (col + 1) * CELL * inv;
            // DataTexture sin flipY: la fila 0 de los datos (arriba en el canvas) está en v = 0
            const vTop = row * CELL * inv;
            const vBot = (row + 1) * CELL * inv;
            const t = g * 8;
            uv[t] = u0;
            uv[t + 1] = vBot;
            uv[t + 2] = u1;
            uv[t + 3] = vBot;
            uv[t + 4] = u1;
            uv[t + 5] = vTop;
            uv[t + 6] = u0;
            uv[t + 7] = vTop;
            for (let c = 0; c < 4; c++) {
              color[k + c * 3] = r;
              color[k + c * 3 + 1] = gC;
              color[k + c * 3 + 2] = b;
            }
            g++;
          }
          pen += adv;
        }
      }
    }
    if (!g) return null;
    const index = new Uint32Array(g * 6);
    for (let q = 0; q < g; q++) {
      const v = q * 4;
      const k = q * 6;
      index[k] = v;
      index[k + 1] = v + 1;
      index[k + 2] = v + 2;
      index[k + 3] = v;
      index[k + 4] = v + 2;
      index[k + 5] = v + 3;
    }
    return {
      position: position.slice(0, g * 12),
      uv: uv.slice(0, g * 8),
      color: color.slice(0, g * 12),
      index,
      glyphs: g,
    };
  }

  dispose() {
    this.texture.dispose();
  }
}
