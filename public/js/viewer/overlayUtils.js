// Utilidades compartidas por las ayudas de superposición (caja de sección, medición):
// líneas con grosor en píxeles y marcadores de tamaño constante en pantalla.

import * as THREE from 'three';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';

export const ACCENT_ORANGE = 0xff6a13;

// Segmentos con grosor constante en píxeles (la resolución la fija LineSegments2 al renderizar).
export function createFatLines({
  color = ACCENT_ORANGE,
  linewidth = 2,
  opacity = 1,
  renderOrder = 10,
  depthTest = false,
} = {}) {
  const geometry = new LineSegmentsGeometry();
  const material = new LineMaterial({
    color,
    linewidth,
    transparent: true,
    opacity,
    depthTest,
    depthWrite: false,
    worldUnits: false,
  });
  const lines = new LineSegments2(geometry, material);
  lines.frustumCulled = false;
  lines.renderOrder = renderOrder;
  return lines;
}

// Actualiza los vértices (xyz, xyz por segmento). Reutiliza el búfer si el tamaño no cambia.
export function setFatLinePositions(lines, positions) {
  const geometry = lines.geometry;
  const start = geometry.attributes.instanceStart;
  if (start && start.data.array.length === positions.length) {
    start.data.array.set(positions);
    start.data.needsUpdate = true;
    return;
  }
  geometry.setPositions(positions instanceof Float32Array ? positions : new Float32Array(positions));
}

// Textura circular para marcadores: disco de color con anillo blanco opcional.
export function createDotTexture({ fill = '#FF6A13', ring = '#FFFFFF', ringWidth = 0.18, size = 64 } = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const c = size / 2;
  ctx.clearRect(0, 0, size, size);
  if (ring) {
    ctx.beginPath();
    ctx.arc(c, c, c - 1, 0, Math.PI * 2);
    ctx.fillStyle = ring;
    ctx.fill();
  }
  ctx.beginPath();
  ctx.arc(c, c, c - 1 - (ring ? size * ringWidth : 0), 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.generateMipmaps = false;
  texture.minFilter = THREE.LinearFilter;
  return texture;
}

// Textura de anillo hueco (marcador de "imán" a un vértice).
export function createRingTexture({ color = '#FF6A13', size = 64, width = 0.14 } = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const c = size / 2;
  ctx.clearRect(0, 0, size, size);
  ctx.lineWidth = size * width;
  ctx.strokeStyle = color;
  ctx.beginPath();
  ctx.arc(c, c, c - ctx.lineWidth, 0, Math.PI * 2);
  ctx.stroke();
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.generateMipmaps = false;
  texture.minFilter = THREE.LinearFilter;
  return texture;
}

// Puntos de tamaño constante en píxeles (no se escalan con la distancia).
export function createMarkerPoints({ texture, size = 11, renderOrder = 12, count = 1 } = {}) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
  const material = new THREE.PointsMaterial({
    size,
    sizeAttenuation: false,
    map: texture,
    color: 0xffffff,
    transparent: true,
    alphaTest: 0.02,
    depthTest: false,
    depthWrite: false,
  });
  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  points.renderOrder = renderOrder;
  return points;
}

// Libera geometría, materiales y texturas de un objeto (y sus hijos).
export function disposeObject(root) {
  root.traverse((o) => {
    o.geometry?.dispose?.();
    const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    for (const m of mats) {
      m.map?.dispose?.();
      m.dispose?.();
    }
  });
}
