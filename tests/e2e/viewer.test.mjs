// Prueba E2E del módulo VISOR 3D (Viewer + SectionBox + MeasureTool).
// Uso: node tests/e2e/viewer.test.mjs   (puerto 8102; sirve public/ con tests/devserver.mjs)
// Termina con código 0 si todo pasa y 1 si algo falla.

import path from 'node:path';
import { startDevServer } from '../devserver.mjs';
import { launchBrowser, openPage, assert, waitFor, OUTPUT } from './helpers.mjs';

const PORT = 8102;
const URL = `http://127.0.0.1:${PORT}/dev/viewer.html`;
const VIEWPORT = { width: 960, height: 600 };

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
const vecNear = (a, b, tol, msg) => a.forEach((v, i) => near(v, b[i], tol, `${msg}[${i}]`));

const server = await startDevServer(PORT);
const browser = await launchBrowser();
let exitCode = 0;

try {
  const { page, errors } = await openPage(browser, URL, { viewport: VIEWPORT });
  const frames = (n = 2) =>
    page.evaluate(
      (count) =>
        new Promise((resolve) => {
          let i = 0;
          const f = () => (++i >= count ? resolve() : requestAnimationFrame(f));
          requestAnimationFrame(f);
        }),
      n,
    );
  const shot = (name) => page.screenshot({ path: path.join(OUTPUT, `viewer-${name}.png`) });

  console.log('Prueba del visor 3D');
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 90000 });

  // Utilidades dentro de la página
  await page.evaluate(() => {
    const { THREE, viewer } = window.__t;
    const h = (window.__h = {});
    h.ndcOf = (p) => {
      viewer.getCameraState();
      viewer.camera.updateMatrixWorld();
      const v = new THREE.Vector3(...p).project(viewer.camera);
      return { x: v.x, y: v.y, z: v.z };
    };
    h.pxOf = (p) => {
      const n = h.ndcOf(p);
      const r = viewer.canvas.getBoundingClientRect();
      return { x: r.left + ((n.x + 1) / 2) * r.width, y: r.top + ((1 - n.y) / 2) * r.height };
    };
    h.loadImage = (url) =>
      new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('imagen inválida'));
        img.src = url;
      });
    // Devuelve los píxeles de un dataURL
    h.pixels = async (url) => {
      const img = await h.loadImage(url);
      const c = document.createElement('canvas');
      c.width = img.width;
      c.height = img.height;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      return { w: img.width, h: img.height, data: ctx.getImageData(0, 0, img.width, img.height).data };
    };
    // Fracción de píxeles distintos del fondo (la columna 0 de cada fila es fondo)
    h.nonBg = async (url) => {
      const { w, h: hh, data } = await h.pixels(url);
      let n = 0;
      for (let y = 0; y < hh; y++) {
        const o = y * w * 4;
        for (let x = 0; x < w; x++) {
          const i = o + x * 4;
          const d = Math.max(Math.abs(data[i] - data[o]), Math.abs(data[i + 1] - data[o + 1]), Math.abs(data[i + 2] - data[o + 2]));
          if (d > 10) n++;
        }
      }
      return { w, h: hh, fraction: n / (w * hh) };
    };
    h.pixelAt = async (url, x, y) => {
      const { w, data } = await h.pixels(url);
      const i = (Math.round(y) * w + Math.round(x)) * 4;
      return [data[i], data[i + 1], data[i + 2]];
    };
    // Registro de eventos del bus
    h.log = [];
    for (const name of ['viewer:click', 'viewer:dblclick', 'viewer:pointermove', 'viewer:pointerleave', 'viewer:camera', 'viewer:resize']) {
      window.__t.bus.on(name, (payload) => h.log.push({ name, payload, t: performance.now() }));
    }
    h.count = (name) => h.log.filter((e) => e.name === name).length;
    h.clearLog = () => (h.log.length = 0);
  });

  await step('WebGL2 disponible y sin errores al iniciar', async () => {
    const info = await page.evaluate(() => {
      const { viewer } = window.__t;
      const gl = viewer.renderer.getContext();
      return {
        webgl2: viewer.renderer.capabilities.isWebGL2,
        clipping: viewer.renderer.localClippingEnabled,
        colorSpace: viewer.renderer.outputColorSpace,
        alpha: gl.getContextAttributes().alpha,
        antialias: gl.getContextAttributes().antialias,
        pr: viewer.renderer.getPixelRatio(),
        sceneIsolated: viewer.scene !== viewer.overlayScene && viewer.modelsRoot.parent === viewer.scene && viewer.overlayRoot.parent === viewer.overlayScene,
      };
    });
    assert(info.webgl2, 'se esperaba WebGL2');
    assert(info.clipping, 'localClippingEnabled debe estar activo');
    assert(info.colorSpace === 'srgb', `outputColorSpace = ${info.colorSpace}`);
    assert(info.alpha, 'el canvas debe ser transparente (alpha)');
    assert(info.pr <= 2, 'pixelRatio <= 2');
    assert(info.sceneIsolated, 'modelsRoot y overlayRoot deben estar en escenas distintas');
    assert(errors.length === 0, `errores de consola: ${errors.join(' | ')}`);
  });

  await step('render no vacío sobre el fondo degradado', async () => {
    const url = await page.evaluate(() => window.__t.viewer.screenshot({ mime: 'image/png' }));
    assert(url.startsWith('data:image/png;base64,'), 'dataURL PNG');
    const r = await page.evaluate((u) => window.__h.nonBg(u), url);
    assert(r.fraction > 0.04, `fracción de píxeles distintos del fondo = ${r.fraction.toFixed(4)}`);
    const corner = await page.evaluate((u) => window.__h.pixelAt(u, 0, 0), url);
    const bottom = await page.evaluate(async (u) => {
      const { w, h, data } = await window.__h.pixels(u);
      const i = ((h - 1) * w + 0) * 4;
      return [data[i], data[i + 1], data[i + 2]];
    }, url);
    vecNear(corner, [243, 243, 242], 3, 'fondo arriba (#F3F3F2)');
    vecNear(bottom, [231, 231, 230], 3, 'fondo abajo (#E7E7E6)');
    await shot('01-iso');
  });

  await step('render bajo demanda: no se redibuja sin cambios', async () => {
    await frames(3);
    const before = await page.evaluate(() => window.__t.viewer.renderCount);
    await frames(12);
    const idle = await page.evaluate(() => window.__t.viewer.renderCount);
    assert(idle === before, `se renderizó en reposo (${before} → ${idle})`);
    await page.evaluate(() => window.__t.viewer.requestRender());
    await frames(2);
    const after = await page.evaluate(() => window.__t.viewer.renderCount);
    assert(after === before + 1, `requestRender debe renderizar exactamente una vez (${before} → ${after})`);
  });

  await step('fitAll encuadra todo lo visible (y no hace nada si no hay nada)', async () => {
    const r = await page.evaluate(async () => {
      const { THREE, viewer, group } = window.__t;
      // Alejamos la cámara y encuadramos
      await viewer.setCameraState({ position: [80, 60, 80], target: [30, 0, 5], projection: 'perspective', zoom: 1, fov: 45 }, { smooth: false });
      await viewer.fitAll({ smooth: false });
      const box = new THREE.Box3().setFromObject(group);
      let maxAbs = 0;
      for (let i = 0; i < 8; i++) {
        const n = window.__h.ndcOf([i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z]);
        maxAbs = Math.max(maxAbs, Math.abs(n.x), Math.abs(n.y));
        if (n.z < -1 || n.z > 1) throw new Error('esquina fuera del frustum en profundidad');
      }
      const center = box.getCenter(new THREE.Vector3()).toArray();
      const state = viewer.getCameraState();
      // Sin nada visible no cambia la cámara
      group.visible = false;
      await viewer.fitAll({ smooth: false });
      const same = JSON.stringify(viewer.getCameraState()) === JSON.stringify(state);
      group.visible = true;
      return { maxAbs, center, target: state.target, same };
    });
    assert(r.maxAbs <= 1.0001, `una esquina queda fuera de la pantalla (|ndc| máx = ${r.maxAbs})`);
    assert(r.maxAbs > 0.6, `el encuadre es demasiado holgado (|ndc| máx = ${r.maxAbs})`);
    vecNear(r.target, r.center, 1e-3, 'objetivo = centro de la caja');
    assert(r.same, 'fitAll sin contenido visible no debe mover la cámara');
  });

  await step('setView: top (norte arriba), front, back, left, right, iso, bottom', async () => {
    const r = await page.evaluate(async () => {
      const { viewer } = window.__t;
      const out = {};
      for (const v of ['top', 'bottom', 'front', 'back', 'left', 'right', 'iso']) {
        await viewer.setView(v, { smooth: false });
        const s = viewer.getCameraState();
        const t = s.target;
        const north = window.__h.ndcOf([t[0], t[1], t[2] - 1]);
        const east = window.__h.ndcOf([t[0] + 1, t[1], t[2]]);
        const origin = window.__h.ndcOf(t);
        out[v] = {
          d: [s.position[0] - t[0], s.position[1] - t[1], s.position[2] - t[2]],
          northUp: north.y - origin.y,
          eastRight: east.x - origin.x,
        };
      }
      return out;
    });
    const len = (d) => Math.hypot(...d);
    // top: cámara encima, norte (-Z) hacia arriba de la pantalla, este a la derecha
    assert(r.top.d[1] > 0.999 * len(r.top.d), 'top: la cámara debe estar encima del objetivo');
    assert(r.top.northUp > 0, 'top: el norte (-Z) debe quedar arriba en pantalla');
    assert(r.top.eastRight > 0, 'top: el este (+X) debe quedar a la derecha');
    assert(r.bottom.d[1] < -0.999 * len(r.bottom.d), 'bottom: la cámara debe estar debajo');
    assert(r.bottom.eastRight > 0, 'bottom: el este debe quedar a la derecha');
    // front: cámara al sur mirando al norte
    assert(r.front.d[2] > 0.999 * len(r.front.d), 'front: la cámara debe estar al sur (+Z)');
    assert(r.front.eastRight > 0, 'front: el este debe quedar a la derecha');
    assert(r.back.d[2] < -0.999 * len(r.back.d), 'back: la cámara debe estar al norte (-Z)');
    assert(r.back.eastRight < 0, 'back: el este debe quedar a la izquierda');
    assert(r.left.d[0] < -0.999 * len(r.left.d), 'left: cámara al oeste');
    assert(r.right.d[0] > 0.999 * len(r.right.d), 'right: cámara al este');
    assert(r.iso.d[0] > 0 && r.iso.d[1] > 0 && r.iso.d[2] > 0, 'iso: cámara en un octante elevado');
    // todas conservan la distancia
    const dTop = len(r.top.d);
    for (const v of Object.keys(r)) near(len(r[v].d), dTop, 1e-6 * dTop, `distancia en ${v}`);
  });

  await step('setView suave toma el camino corto en acimut y termina en la vista', async () => {
    const r = await page.evaluate(async () => {
      const { viewer } = window.__t;
      await viewer.setView('front', { smooth: false });
      viewer.setView('back', { smooth: true });
      let steps = 0;
      const t0 = performance.now();
      while (performance.now() - t0 < 6000) {
        await new Promise((res) => requestAnimationFrame(res));
        steps++;
        const s = viewer.getCameraState();
        const t = s.target;
        if (Math.abs(s.position[2] - t[2]) > 0.99 * Math.hypot(s.position[0] - t[0], s.position[1] - t[1], s.position[2] - t[2]) && s.position[2] < t[2]) break;
      }
      const s = viewer.getCameraState();
      return { steps, z: s.position[2] - s.target[2] };
    });
    assert(r.z < 0, `no llegó a la vista trasera (dz=${r.z})`);
    assert(r.steps > 2, 'la transición debe tomar varios frames');
  });

  await step('cambio de proyección conserva el encuadre y el objetivo', async () => {
    const r = await page.evaluate(async () => {
      const { viewer, store, actions } = window.__t;
      await viewer.setView('iso', { smooth: false });
      await viewer.fitAll({ smooth: false });
      const s0 = viewer.getCameraState();
      // Sondas en el plano del objetivo perpendicular a la visual (allí perspectiva y ortográfica coinciden)
      viewer.camera.updateMatrixWorld();
      const right = new window.__t.THREE.Vector3().setFromMatrixColumn(viewer.camera.matrixWorld, 0);
      const up = new window.__t.THREE.Vector3().setFromMatrixColumn(viewer.camera.matrixWorld, 1);
      const t = s0.target;
      const probes = [t, [t[0] + right.x * 3, t[1] + right.y * 3, t[2] + right.z * 3], [t[0] + up.x * 2, t[1] + up.y * 2, t[2] + up.z * 2]];
      const before = probes.map((p) => window.__h.ndcOf(p));
      viewer.setProjection('orthographic');
      const s1 = viewer.getCameraState();
      const after = probes.map((p) => window.__h.ndcOf(p));
      const storeProj = store.get('display').projection;
      // y de vuelta, esta vez desde el store (acciones de la UI)
      actions.setProjection('perspective');
      const s2 = viewer.getCameraState();
      const back = probes.map((p) => window.__h.ndcOf(p));
      return { s0, s1, s2, before, after, back, storeProj, type: viewer.camera.type };
    });
    assert(r.s1.projection === 'orthographic', 'estado ortográfico');
    assert(r.storeProj === 'orthographic', 'el store refleja la proyección');
    vecNear(r.s1.target, r.s0.target, 1e-9, 'objetivo (orto)');
    vecNear(r.s2.target, r.s0.target, 1e-9, 'objetivo (de vuelta)');
    for (let i = 0; i < 3; i++) {
      near(r.after[i].x, r.before[i].x, 2e-3, `sonda ${i} x (orto)`);
      near(r.after[i].y, r.before[i].y, 2e-3, `sonda ${i} y (orto)`);
    }
    for (let i = 0; i < 3; i++) {
      near(r.back[i].x, r.before[i].x, 1e-6, `sonda ${i} x (vuelta)`);
      near(r.back[i].y, r.before[i].y, 1e-6, `sonda ${i} y (vuelta)`);
    }
    assert(r.s2.projection === 'perspective' && r.type === 'PerspectiveCamera', 'volvió a perspectiva');
    vecNear(r.s2.position, r.s0.position, 1e-6, 'posición tras ida y vuelta');
  });

  await step('rueda: en perspectiva dolly, en ortográfica zoom', async () => {
    await page.evaluate(() => window.__t.viewer.setView('iso', { smooth: false }));
    await frames(2);
    const dist = () => page.evaluate(() => {
      const s = window.__t.viewer.getCameraState();
      return Math.hypot(...s.position.map((v, i) => v - s.target[i]));
    });
    const d0 = await dist();
    await page.mouse.move(480, 300);
    await page.mouse.wheel(0, -300);
    await waitFor(async () => (await dist()) < d0 * 0.9, { timeout: 8000, label: 'dolly por rueda' });
    const z0 = await page.evaluate(() => {
      window.__t.viewer.setProjection('orthographic');
      return window.__t.viewer.camera.zoom;
    });
    await frames(2);
    await page.mouse.wheel(0, -300);
    const z1 = await waitFor(async () => {
      const z = await page.evaluate(() => window.__t.viewer.camera.zoom);
      return z > z0 * 1.1 ? z : null;
    }, { timeout: 8000, label: 'zoom por rueda en ortográfica' });
    assert(z1 > z0, 'el zoom ortográfico debe aumentar');
    await page.evaluate(() => window.__t.viewer.setProjection('perspective'));
    await page.evaluate(() => window.__t.viewer.fitAll({ smooth: false }));
    await page.evaluate(() => window.__t.viewer.setView('iso', { smooth: false }));
  });

  await step('navegación: zoom hacia el cursor y desplazamiento 1:1 en ambas proyecciones', async () => {
    await page.evaluate(() => {
      const { THREE, viewer } = window.__t;
      // punto del plano del objetivo (perpendicular a la visual), a la derecha y arriba del centro
      window.__q = () => {
        const s = viewer.getCameraState();
        viewer.camera.updateMatrixWorld();
        const right = new THREE.Vector3().setFromMatrixColumn(viewer.camera.matrixWorld, 0);
        const up = new THREE.Vector3().setFromMatrixColumn(viewer.camera.matrixWorld, 1);
        return new THREE.Vector3(...s.target).addScaledVector(right, 4).addScaledVector(up, 1.5);
      };
      window.__px = (p) => {
        viewer.getCameraState();
        const v = p.clone().project(viewer.camera);
        const r = viewer.canvas.getBoundingClientRect();
        return { x: ((v.x + 1) / 2) * r.width, y: ((1 - v.y) / 2) * r.height };
      };
    });
    const still = () => page.evaluate(async () => {
      let n = 0;
      let last = '';
      for (let i = 0; i < 400 && n < 5; i++) {
        await new Promise((res) => requestAnimationFrame(res));
        const cur = JSON.stringify(window.__t.viewer.getCameraState());
        n = cur === last ? n + 1 : 0;
        last = cur;
      }
    });
    for (const proj of ['perspective', 'orthographic']) {
      await page.evaluate(async (p) => {
        window.__t.viewer.setProjection(p);
        await window.__t.viewer.setView('iso', { smooth: false });
        await window.__t.viewer.fitAll({ smooth: false });
      }, proj);
      await frames(2);
      // zoom con la rueda sobre un punto cualquiera del plano del objetivo
      const q0 = await page.evaluate(() => {
        window.__Q = window.__q();
        return window.__px(window.__Q);
      });
      await page.mouse.move(q0.x, q0.y);
      await page.mouse.wheel(0, -300);
      await still();
      const q1 = await page.evaluate(() => window.__px(window.__Q));
      const zoomed = await page.evaluate(() => {
        const s = window.__t.viewer.getCameraState();
        return s.projection === 'orthographic' ? s.zoom : Math.hypot(...s.position.map((v, i) => v - s.target[i]));
      });
      near(q1.x, q0.x, 2, `${proj}: el punto bajo el cursor se mantiene (x)`);
      near(q1.y, q0.y, 2, `${proj}: el punto bajo el cursor se mantiene (y)`);
      assert(zoomed > 0, 'estado válido');
      // desplazamiento con el botón derecho: el punto sigue al cursor 1:1
      const p0 = await page.evaluate(() => {
        window.__Q = window.__q();
        return window.__px(window.__Q);
      });
      await page.mouse.move(400, 300);
      await page.mouse.down({ button: 'right' });
      await page.mouse.move(480, 340, { steps: 8 });
      await page.mouse.up({ button: 'right' });
      await still();
      const p1 = await page.evaluate(() => window.__px(window.__Q));
      near(p1.x - p0.x, 80, 2, `${proj}: desplazamiento horizontal 1:1`);
      near(p1.y - p0.y, 40, 2, `${proj}: desplazamiento vertical 1:1`);
      // y el botón central también desplaza
      await page.mouse.move(400, 300);
      await page.mouse.down({ button: 'middle' });
      await page.mouse.move(360, 300, { steps: 6 });
      await page.mouse.up({ button: 'middle' });
      await still();
      const p2 = await page.evaluate(() => window.__px(window.__Q));
      near(p2.x - p1.x, -40, 2, `${proj}: el botón central también desplaza`);
    }
    await page.evaluate(async () => {
      window.__t.viewer.setProjection('perspective');
      await window.__t.viewer.setView('iso', { smooth: false });
      await window.__t.viewer.fitAll({ smooth: false });
    });
  });

  await step('fitToBox: relleno exacto en perspectiva y ortográfica, conserva la dirección', async () => {
    const r = await page.evaluate(async () => {
      const { THREE, viewer } = window.__t;
      const box = new THREE.Box3(new THREE.Vector3(-3, 0, -2), new THREE.Vector3(5, 4, 6));
      const corners = () => {
        let maxAbs = 0;
        for (let i = 0; i < 8; i++) {
          const n = window.__h.ndcOf([i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z]);
          maxAbs = Math.max(maxAbs, Math.abs(n.x), Math.abs(n.y));
        }
        return maxAbs;
      };
      const out = {};
      await viewer.setView('iso', { smooth: false });
      const dir0 = viewer.getCameraState();
      const d0 = new THREE.Vector3(...dir0.position).sub(new THREE.Vector3(...dir0.target)).normalize();
      await viewer.fitToBox(box, { smooth: false, padding: 1.15 });
      out.persp = corners();
      const s1 = viewer.getCameraState();
      const d1 = new THREE.Vector3(...s1.position).sub(new THREE.Vector3(...s1.target)).normalize();
      out.dirDot = d0.dot(d1);
      out.target = s1.target;
      out.center = box.getCenter(new THREE.Vector3()).toArray();
      await viewer.fitToBox(box, { smooth: false, padding: 1.4 });
      out.perspWide = corners();
      viewer.setProjection('orthographic');
      await viewer.fitToBox(box, { smooth: false, padding: 1.15 });
      out.ortho = corners();
      await viewer.setView('top', { smooth: false, fit: true });
      out.orthoTopFit = (() => {
        const all = new THREE.Box3().setFromObject(window.__t.group);
        let m = 0;
        for (let i = 0; i < 8; i++) {
          const n = window.__h.ndcOf([i & 1 ? all.max.x : all.min.x, i & 2 ? all.max.y : all.min.y, i & 4 ? all.max.z : all.min.z]);
          m = Math.max(m, Math.abs(n.x), Math.abs(n.y));
        }
        return m;
      })();
      viewer.setProjection('perspective');
      return out;
    });
    near(r.persp, 1 / 1.15, 0.012, 'perspectiva: la esquina límite queda a 1/padding');
    near(r.perspWide, 1 / 1.4, 0.012, 'perspectiva con padding 1.4');
    near(r.ortho, 1 / 1.15, 0.012, 'ortográfica: la esquina límite queda a 1/padding');
    assert(r.dirDot > 0.99999, 'fitToBox conserva la dirección de la vista');
    vecNear(r.target, r.center, 1e-6, 'objetivo = centro de la caja');
    assert(r.orthoTopFit <= 1.0001 && r.orthoTopFit > 0.8, `planta ortográfica encuadrada (|ndc| = ${r.orthoTopFit})`);
    await page.evaluate(() => window.__t.viewer.setView('iso', { smooth: false }));
    await page.evaluate(() => window.__t.viewer.fitAll({ smooth: false }));
  });

  await step('setFitInsets: los encuadres quedan centrados en la zona libre (perspectiva y ortográfica) y los insets absurdos se ignoran', async () => {
    const r = await page.evaluate(async () => {
      const { THREE, viewer } = window.__t;
      const box = new THREE.Box3(new THREE.Vector3(-3, 0, -2), new THREE.Vector3(5, 4, 6));
      const size = viewer.getSize();
      const ins = { left: 300, right: 40, top: 20, bottom: 160 };
      viewer.setFitInsets(ins);
      const free = { x0: ins.left, x1: size.width - ins.right, y0: ins.top, y1: size.height - ins.bottom };
      const measure = () => {
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (let i = 0; i < 8; i++) {
          const n = window.__h.ndcOf([i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z]);
          const px = ((n.x + 1) / 2) * size.width;
          const py = ((1 - n.y) / 2) * size.height;
          minX = Math.min(minX, px); maxX = Math.max(maxX, px); minY = Math.min(minY, py); maxY = Math.max(maxY, py);
        }
        const c = window.__h.ndcOf(box.getCenter(new THREE.Vector3()).toArray());
        return { minX, maxX, minY, maxY, cx: ((c.x + 1) / 2) * size.width, cy: ((1 - c.y) / 2) * size.height };
      };
      const out = { free, readBack: viewer.getFitInsets() };
      await viewer.setView('iso', { smooth: false });
      await viewer.fitToBox(box, { smooth: false, padding: 1.15 });
      out.persp = measure();
      viewer.setProjection('orthographic');
      await viewer.fitToBox(box, { smooth: false, padding: 1.15 });
      out.ortho = measure();
      await viewer.setView('top', { smooth: false, fit: true });
      viewer.setProjection('perspective');
      // Insets que dejan menos del 40 % del visor: se ignoran (encuadre centrado en toda la ventana)
      viewer.setFitInsets({ left: size.width * 0.7 });
      await viewer.setView('iso', { smooth: false });
      await viewer.fitToBox(box, { smooth: false, padding: 1.15 });
      out.ignored = measure();
      out.size = size;
      viewer.setFitInsets({});
      await viewer.fitToBox(box, { smooth: false, padding: 1.15 });
      return out;
    });
    assert(r.readBack.left === 300 && r.readBack.bottom === 160, 'getFitInsets devuelve los valores fijados');
    for (const [name, m] of [['perspectiva', r.persp], ['ortográfica', r.ortho]]) {
      // El centro de la caja (no el de su rectángulo en pantalla, que en perspectiva se descentra) cae en el de la zona libre
      near(m.cx, (r.free.x0 + r.free.x1) / 2, 1.5, `${name}: centro horizontal de la caja en la zona libre`);
      near(m.cy, (r.free.y0 + r.free.y1) / 2, 1.5, `${name}: centro vertical de la caja en la zona libre`);
      assert(m.minX >= r.free.x0 - 1 && m.maxX <= r.free.x1 + 1 && m.minY >= r.free.y0 - 1 && m.maxY <= r.free.y1 + 1, `${name}: la caja cabe en la zona libre`);
      assert(m.maxX - m.minX > (r.free.x1 - r.free.x0) * 0.6 || m.maxY - m.minY > (r.free.y1 - r.free.y0) * 0.6, `${name}: la caja aprovecha la zona libre`);
    }
    near(r.ignored.cx, r.size.width / 2, 1.5, 'insets absurdos: centrado en toda la ventana');
    await page.evaluate(() => window.__t.viewer.fitAll({ smooth: false }));
  });

  await step('zoomStep y orbitStep (botones de la UI)', async () => {
    const r = await page.evaluate(async () => {
      const { viewer } = window.__t;
      // espera a que la cámara deje de moverse (5 frames seguidos sin cambio)
      const settle = async () => {
        let still = 0;
        let last = '';
        for (let i = 0; i < 400 && still < 5; i++) {
          await new Promise((res) => requestAnimationFrame(res));
          const cur = JSON.stringify(viewer.getCameraState());
          still = cur === last ? still + 1 : 0;
          last = cur;
        }
      };
      await viewer.setView('iso', { smooth: false });
      await viewer.fitAll({ smooth: false });
      const dist = () => {
        const s = viewer.getCameraState();
        return Math.hypot(...s.position.map((v, i) => v - s.target[i]));
      };
      const out = {};
      const d0 = dist();
      viewer.zoomStep(1);
      await settle();
      out.zoomIn = dist() / d0;
      viewer.zoomStep(-1);
      await settle();
      out.zoomBack = dist() / d0;
      const az0 = viewer.controls.azimuthAngle;
      const pol0 = viewer.controls.polarAngle;
      viewer.orbitStep(30, 0);
      await settle();
      out.dAz = viewer.controls.azimuthAngle - az0;
      viewer.orbitStep(0, 10);
      await settle();
      out.dPol = viewer.controls.polarAngle - pol0;
      viewer.setProjection('orthographic');
      const z0 = viewer.camera.zoom;
      viewer.zoomStep(1);
      await settle();
      out.zOrtho = viewer.camera.zoom / z0;
      viewer.setProjection('perspective');
      return out;
    });
    near(r.zoomIn, 0.8, 0.01, 'zoomStep(+1) acerca un 20 %');
    near(r.zoomBack, 1.0, 0.01, 'zoomStep(-1) lo deshace');
    near(r.dAz, (30 * Math.PI) / 180, 0.01, 'orbitStep(30, 0) gira 30° en acimut');
    near(r.dPol, -(10 * Math.PI) / 180, 0.01, 'orbitStep(0, 10) sube la cámara 10° (el ángulo polar disminuye)');
    near(r.zOrtho, 1.25, 0.01, 'zoomStep(+1) en ortográfica multiplica el zoom por 1,25');
    await page.evaluate(() => window.__t.viewer.setView('iso', { smooth: false }));
    await page.evaluate(() => window.__t.viewer.fitAll({ smooth: false }));
  });

  await step('pick con proveedor de prueba: cercano primero, ordenado, filtro por tipo', async () => {
    const r = await page.evaluate(() => {
      const { viewer, boxes } = window.__t;
      const c = (b) => b.position.toArray();
      const ndcAzul = window.__h.ndcOf(c(boxes.azul));
      const hit = viewer.pick(ndcAzul);
      const all = viewer.pickAll(ndcAzul);
      const ndcNaranja = window.__h.ndcOf(c(boxes.naranja));
      const soloCad = viewer.pick(ndcNaranja, { kinds: ['cad'] });
      const soloIfc = viewer.pick(ndcNaranja, { kinds: ['ifc'] });
      const nada = viewer.pick({ x: -0.99, y: 0.99 });
      return {
        hit: hit && { expressId: hit.expressId, kind: hit.kind, modelId: hit.modelId, d: hit.distance, hasPoint: !!hit.point?.isVector3, obj: hit.object?.name },
        distances: all.map((h) => h.distance),
        ids: all.map((h) => h.expressId),
        soloCad: soloCad && soloCad.expressId,
        soloIfc: soloIfc && soloIfc.expressId,
        nada,
      };
    });
    assert(r.hit && r.hit.expressId === 3 && r.hit.kind === 'ifc' && r.hit.modelId === 'm1', `pick azul = ${JSON.stringify(r.hit)}`);
    assert(r.hit.hasPoint && r.hit.obj === 'azul', 'el impacto debe traer point y object');
    assert(r.distances.length >= 3, `pickAll debe traer varios impactos (${r.distances.length})`);
    assert(r.distances.every((d, i) => i === 0 || d >= r.distances[i - 1]), 'pickAll ordenado por distancia');
    assert(r.ids[0] === 3, 'el primero es el azul');
    assert(r.soloCad === 5, `kinds=['cad'] debe devolver el naranja (${r.soloCad})`);
    assert(r.soloIfc !== 5 && r.soloIfc !== null, `kinds=['ifc'] no debe devolver el naranja (${r.soloIfc})`);
    assert(r.nada === null, 'pick en el vacío devuelve null');
  });

  await step('pick en ortográfica alcanza geometría detrás del plano de cámara', async () => {
    const r = await page.evaluate(async () => {
      const { viewer, boxes } = window.__t;
      await viewer.setView('top', { smooth: false });
      viewer.setProjection('orthographic');
      // cámara ortográfica muy cerca del objetivo: la escena queda parcialmente detrás
      const s = viewer.getCameraState();
      await viewer.setCameraState({ ...s, position: [s.target[0], s.target[1] + 0.5, s.target[2] + 0.001] }, { smooth: false });
      const ndc = window.__h.ndcOf(boxes.verde.position.toArray());
      const hit = viewer.pick(ndc);
      viewer.setProjection('perspective');
      return hit && hit.expressId;
    });
    assert(r === 4, `en planta ortográfica debe golpear el verde (más alto), obtuvo ${r}`);
    await page.evaluate(async () => {
      await window.__t.viewer.setView('iso', { smooth: false });
      await window.__t.viewer.fitAll({ smooth: false });
    });
  });

  await step('el recorte descarta impactos del lado recortado', async () => {
    const r = await page.evaluate(() => {
      const { THREE, viewer, boxes } = window.__t;
      const center = boxes.azul.position.clone();
      const ndc = window.__h.ndcOf(center.toArray());
      const first = viewer.pick(ndc);
      const camPos = viewer.camera.position.clone();
      const dir = center.clone().sub(camPos).normalize();
      // Plano perpendicular a la visual que recorta todo lo anterior al centro del cubo
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(dir, center);
      viewer.setClipping('test', [plane]);
      const afterClip = viewer.pickAll(ndc);
      const n = viewer.getClippingPlanes().length;
      const clippedOk = afterClip.every((h) => plane.distanceToPoint(h.point) >= -1e-4);
      const firstAfter = afterClip[0];
      viewer.setClipping('test', []);
      const restored = viewer.pick(ndc);
      return {
        n,
        clippedOk,
        d0: first.distance,
        d1: firstAfter && firstAfter.distance,
        dc: center.distanceTo(camPos),
        restoredSame: restored.distance === first.distance,
        left: viewer.getClippingPlanes().length,
      };
    });
    assert(r.n === 1, 'getClippingPlanes devuelve el plano');
    assert(r.clippedOk, 'ningún impacto debe quedar en el lado recortado');
    assert(r.d1 > r.d0 && r.d1 >= r.dc - 1e-3, `el primer impacto tras recortar debe estar detrás del plano (d0=${r.d0}, d1=${r.d1}, centro=${r.dc})`);
    assert(r.restoredSame, 'al quitar el recorte vuelve el primer impacto');
    assert(r.left === 0, 'sin planos al limpiar el grupo');
  });

  await step('grupos de recorte se combinan y la superposición NO se recorta', async () => {
    const r = await page.evaluate(async () => {
      const { THREE, viewer, actions } = window.__t;
      await viewer.setView('iso', { smooth: false });
      await viewer.fitAll({ smooth: false });
      const p = (nx, ny, nz, c) => new THREE.Plane(new THREE.Vector3(nx, ny, nz), c);
      viewer.setClipping('a', [p(1, 0, 0, 100)]);
      viewer.setClipping('b', [p(0, 1, 0, 100), p(0, 0, 1, 100)]);
      const n3 = viewer.getClippingPlanes().length;
      viewer.setClipping('a', []);
      const n2 = viewer.getClippingPlanes().length;
      viewer.setClipping('b', null);
      const n0 = viewer.getClippingPlanes().length;
      // Recorta TODO el modelo; una medición (superposición) debe seguir viéndose
      actions.clearMeasures();
      actions.addMeasure([-4, 0.3, 3], [4, 0.3, 3]);
      const visibleBefore = await window.__h.nonBg(viewer.screenshot({ mime: 'image/png' }));
      viewer.setClipping('todo', [p(0, -1, 0, -1000)]); // distancia = -y - 1000 < 0 en todo el modelo
      const url = viewer.screenshot({ mime: 'image/png' });
      const { w, h, data } = await window.__h.pixels(url);
      let dark = 0;
      let colored = 0;
      for (let i = 0; i < w * h; i++) {
        const R = data[i * 4], G = data[i * 4 + 1], B = data[i * 4 + 2];
        if (R < 70 && G < 70 && B < 70) dark++;
        if (Math.max(R, G, B) - Math.min(R, G, B) > 50 && !(R > 240 && G > 90 && G < 130)) colored++; // cubos de color
      }
      viewer.setClipping('todo', []);
      actions.clearMeasures();
      return { n3, n2, n0, dark, colored, before: visibleBefore.fraction };
    });
    assert(r.n3 === 3 && r.n2 === 2 && r.n0 === 0, `combinación de grupos: ${r.n3}/${r.n2}/${r.n0}`);
    assert(r.colored < 30, `el modelo recortado no debe verse (píxeles de color = ${r.colored})`);
    assert(r.dark > 150, `la medición (superposición) debe seguir visible con el modelo recortado (píxeles oscuros = ${r.dark})`);
  });

  await step('eventos: click sin arrastre, dblclick, botón derecho', async () => {
    await frames(2);
    await page.evaluate(() => window.__h.clearLog());
    await page.mouse.click(480, 400);
    await frames(2);
    let log = await page.evaluate(() => window.__h.log.filter((e) => e.name === 'viewer:click').map((e) => e.payload));
    assert(log.length === 1, `clics = ${log.length}`);
    near(log[0].ndc.x, 0, 2e-3, 'ndc.x del clic');
    near(log[0].ndc.y, -(400 / 600) * 2 + 1, 2e-3, 'ndc.y del clic');
    assert(log[0].button === 0 && log[0].clientX === 480 && log[0].clientY === 400, 'payload del clic');
    assert(['shiftKey', 'ctrlKey', 'metaKey', 'altKey'].every((k) => k in log[0]), 'payload con modificadores');

    await page.keyboard.down('Shift');
    await page.mouse.click(300, 300);
    await page.keyboard.up('Shift');
    await frames(2);
    log = await page.evaluate(() => window.__h.log.filter((e) => e.name === 'viewer:click').map((e) => e.payload));
    assert(log.length === 2 && log[1].shiftKey === true, 'el clic con Shift lo marca');

    await page.mouse.click(600, 300, { button: 'right' });
    await frames(2);
    log = await page.evaluate(() => window.__h.log.filter((e) => e.name === 'viewer:click').map((e) => e.payload));
    assert(log.length === 3 && log[2].button === 2, 'el clic derecho informa button=2');

    await page.mouse.dblclick(500, 350);
    await frames(2);
    const dbl = await page.evaluate(() => window.__h.log.filter((e) => e.name === 'viewer:dblclick').map((e) => e.payload));
    assert(dbl.length === 1 && dbl[0].clientX === 500, `dblclick = ${dbl.length}`);
  });

  await step('eventos: un arrastre (>= 5 px) orbita y NO genera clic', async () => {
    await page.evaluate(() => window.__h.clearLog());
    const s0 = await page.evaluate(() => window.__t.viewer.getCameraState());
    await page.mouse.move(480, 300);
    await page.mouse.down();
    await page.mouse.move(520, 310, { steps: 6 });
    await page.mouse.move(560, 330, { steps: 6 });
    await page.mouse.up();
    await frames(30);
    const r = await page.evaluate(() => ({ clicks: window.__h.count('viewer:click'), s: window.__t.viewer.getCameraState() }));
    assert(r.clicks === 0, `el arrastre emitió ${r.clicks} clics`);
    const moved = Math.hypot(...r.s.position.map((v, i) => v - s0.position[i]));
    assert(moved > 0.5, `la cámara debe haber orbitado (movió ${moved})`);

    // un clic con desplazamiento < 5 px sí cuenta
    await page.mouse.move(400, 300);
    await page.mouse.down();
    await page.mouse.move(402, 301);
    await page.mouse.up();
    await frames(2);
    assert((await page.evaluate(() => window.__h.count('viewer:click'))) === 1, 'un clic con 2 px de deriva sigue siendo clic');
  });

  await step('eventos: pointermove máx. 1 por frame, pointerleave', async () => {
    await frames(3);
    await page.evaluate(() => window.__h.clearLog());
    await page.evaluate(() => {
      const c = window.__t.viewer.canvas;
      for (let i = 0; i < 30; i++) {
        c.dispatchEvent(new PointerEvent('pointermove', { clientX: 100 + i, clientY: 200, bubbles: true, pointerId: 1, pointerType: 'mouse' }));
      }
    });
    await frames(3);
    const moves = await page.evaluate(() => window.__h.log.filter((e) => e.name === 'viewer:pointermove').map((e) => e.payload));
    assert(moves.length === 1, `30 movimientos en un mismo frame deben emitir 1 evento (${moves.length})`);
    assert(moves[0].clientX === 129 && moves[0].ndc && typeof moves[0].ndc.x === 'number', 'se emite el último movimiento');
    await page.evaluate(() => window.__t.viewer.canvas.dispatchEvent(new PointerEvent('pointerleave', { bubbles: false, pointerId: 1 })));
    await frames(2);
    assert((await page.evaluate(() => window.__h.count('viewer:pointerleave'))) === 1, 'pointerleave se emite');
  });

  await step('eventos: viewer:camera máx. 1 por frame y solo si cambió', async () => {
    await frames(4);
    await page.evaluate(() => window.__h.clearLog());
    await page.evaluate(() => {
      const { viewer } = window.__t;
      const s = viewer.getCameraState();
      // varios cambios en la misma tarea → un único evento con el estado final
      viewer.setCameraState({ ...s, position: [s.position[0] + 1, s.position[1], s.position[2]] }, { smooth: false });
      viewer.setCameraState({ ...s, position: [s.position[0] + 2, s.position[1], s.position[2]] }, { smooth: false });
      viewer.setCameraState({ ...s, position: [s.position[0] + 3, s.position[1], s.position[2]] }, { smooth: false });
    });
    await frames(5);
    const cams = await page.evaluate(() => window.__h.log.filter((e) => e.name === 'viewer:camera').map((e) => e.payload));
    assert(cams.length === 1, `eventos de cámara = ${cams.length}`);
    assert(cams[0].projection === 'perspective' && cams[0].position.length === 3 && cams[0].target.length === 3 && 'zoom' in cams[0] && 'fov' in cams[0], 'forma de CameraState');
    // sin cambios no hay más eventos aunque se pida renderizar
    await page.evaluate(() => window.__t.viewer.requestRender());
    await frames(4);
    assert((await page.evaluate(() => window.__h.count('viewer:camera'))) === 1, 'sin cambios no se emite viewer:camera');
    await page.evaluate(() => window.__t.viewer.fitAll({ smooth: false }));
    await page.evaluate(() => window.__t.viewer.setView('iso', { smooth: false }));
  });

  await step('enableInput(false) bloquea eventos y controles; true los restaura', async () => {
    await frames(3);
    await page.evaluate(() => {
      window.__t.viewer.enableInput(false);
      window.__h.clearLog();
    });
    const s0 = await page.evaluate(() => window.__t.viewer.getCameraState());
    await page.mouse.click(480, 400);
    await page.mouse.dblclick(480, 400);
    await page.mouse.move(300, 300);
    await page.mouse.down();
    await page.mouse.move(400, 360, { steps: 5 });
    await page.mouse.up();
    await page.mouse.wheel(0, -400);
    await frames(20);
    const r = await page.evaluate(() => ({
      click: window.__h.count('viewer:click'),
      dbl: window.__h.count('viewer:dblclick'),
      move: window.__h.count('viewer:pointermove'),
      s: window.__t.viewer.getCameraState(),
      enabled: window.__t.viewer.controls.enabled,
      flag: window.__t.viewer.inputEnabled,
    }));
    assert(r.click === 0 && r.dbl === 0 && r.move === 0, `eventos con el visor bloqueado: ${JSON.stringify(r)}`);
    assert(!r.enabled && !r.flag, 'controles desactivados');
    vecNear(r.s.position, s0.position, 1e-9, 'la cámara no debe moverse al bloquear');
    await page.evaluate(() => window.__t.viewer.enableInput(true));
    await page.mouse.click(480, 400);
    await frames(2);
    assert((await page.evaluate(() => window.__h.count('viewer:click'))) === 1, 'tras desbloquear vuelve a emitir clics');
  });

  await step('resize: ResizeObserver actualiza canvas, cámaras y emite viewer:resize', async () => {
    await page.evaluate(() => window.__h.clearLog());
    await page.evaluate(() => {
      const el = document.getElementById('viewport');
      el.style.inset = 'auto';
      el.style.left = '0';
      el.style.top = '0';
      el.style.width = '700px';
      el.style.height = '420px';
    });
    await waitFor(() => page.evaluate(() => window.__h.count('viewer:resize') >= 1), { timeout: 8000, label: 'viewer:resize' });
    const r = await page.evaluate(() => {
      const { viewer } = window.__t;
      const ev = window.__h.log.filter((e) => e.name === 'viewer:resize').pop().payload;
      const rect = viewer.canvas.getBoundingClientRect();
      return { ev, w: rect.width, h: rect.height, bw: viewer.canvas.width, bh: viewer.canvas.height, aspect: viewer.getAspect(), pa: viewer.perspCamera.aspect, oa: (viewer.orthoCamera.right - viewer.orthoCamera.left) / (viewer.orthoCamera.top - viewer.orthoCamera.bottom), pr: viewer.renderer.getPixelRatio() };
    });
    assert(r.ev.width === 700 && r.ev.height === 420, `payload ${JSON.stringify(r.ev)}`);
    near(r.ev.aspect, 700 / 420, 1e-9, 'aspect del evento');
    assert(Math.round(r.w) === 700 && Math.round(r.h) === 420, 'tamaño CSS del canvas');
    assert(r.bw === Math.round(700 * r.pr) && r.bh === Math.round(420 * r.pr), 'búfer de dibujo');
    near(r.pa, 700 / 420, 1e-9, 'aspect de la cámara en perspectiva');
    near(r.oa, 700 / 420, 1e-9, 'aspect de la cámara ortográfica');
    const px = await page.evaluate(() => window.__t.viewer.screenshot({ mime: 'image/png' })).then((u) => page.evaluate((x) => window.__h.nonBg(x), u));
    assert(px.fraction > 0.02, 'sigue renderizando tras redimensionar');
    await page.evaluate(() => {
      const el = document.getElementById('viewport');
      el.style.inset = '0';
      el.style.width = '';
      el.style.height = '';
    });
    await waitFor(() => page.evaluate(() => Math.round(window.__t.viewer.getSize().width) === 960), { timeout: 8000, label: 'restaurar tamaño' });
    await page.evaluate(() => window.__t.viewer.fitAll({ smooth: false }));
  });

  await step('screenshot devuelve dataURL compuesto sobre fondo claro (también otro tamaño y PNG)', async () => {
    const r = await page.evaluate(async () => {
      const { viewer } = window.__t;
      const wBefore = viewer.canvas.width;
      const a = viewer.screenshot();
      const b = viewer.screenshot({ width: 320 });
      const c = viewer.screenshot({ width: 200, height: 200, mime: 'image/png' });
      const d = viewer.screenshot({ width: 1200, height: 300, mime: 'image/png' });
      const dims = {};
      for (const [k, u] of Object.entries({ a, b, c, d })) {
        const img = await window.__h.loadImage(u);
        dims[k] = [img.width, img.height, u.slice(0, 22)];
      }
      const px = await window.__h.pixelAt(c, 0, 0);
      const fr = await window.__h.nonBg(c);
      return { dims, wBefore, wAfter: viewer.canvas.width, px, fr: fr.fraction, size: viewer.getSize() };
    });
    assert(r.dims.a[2].startsWith('data:image/jpeg'), 'por defecto JPEG');
    assert(r.dims.a[0] === r.wAfter && r.wBefore === r.wAfter, 'captura por defecto = tamaño del canvas y el canvas no cambia');
    assert(r.dims.b[0] === 320 && r.dims.b[1] === Math.round(320 / (r.size.width / r.size.height)), `captura de ancho 320: ${r.dims.b}`);
    assert(r.dims.c[0] === 200 && r.dims.c[1] === 200 && r.dims.c[2].startsWith('data:image/png'), `captura 200x200: ${r.dims.c}`);
    assert(r.dims.d[0] === 1200 && r.dims.d[1] === 300, `captura 1200x300: ${r.dims.d}`);
    vecNear(r.px, [243, 243, 242], 3, 'fondo claro en la esquina de la captura');
    assert(r.fr > 0.03, `la captura 200x200 no debe estar vacía (${r.fr})`);
    await frames(3);
    const ok = await page.evaluate(() => ({ w: window.__t.viewer.canvas.width, h: window.__t.viewer.canvas.height, size: window.__t.viewer.getSize(), pr: window.__t.viewer.renderer.getPixelRatio() }));
    assert(ok.w === Math.round(ok.size.width * ok.pr) && ok.h === Math.round(ok.size.height * ok.pr), 'el búfer vuelve al tamaño original tras capturas');
    await shot('02-tras-capturas');
  });

  await step('renderTopView: miniatura cenital, norte arriba, sin alterar la vista principal', async () => {
    const r = await page.evaluate(async () => {
      const { THREE, viewer, group } = window.__t;
      const box = new THREE.Box3().setFromObject(group);
      const before = JSON.stringify(viewer.getCameraState());
      const url = viewer.renderTopView({ box, width: 300, height: 200 });
      const after = JSON.stringify(viewer.getCameraState());
      const { w, h, data } = await window.__h.pixels(url);
      const cls = { green: [0, 0], red: [0, 0], orange: [0, 0], blue: [0, 0] };
      const acc = { green: [0, 0, 0], red: [0, 0, 0], orange: [0, 0, 0], blue: [0, 0, 0] };
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4;
          const [R, G, B] = [data[i], data[i + 1], data[i + 2]];
          let k = null;
          if (G > R + 25 && G > B + 25) k = 'green';
          else if (R > G + 60 && R > B + 60 && G < 120) k = 'red';
          else if (R > 200 && G > 130 && G < 190 && B < 110) k = 'orange';
          else if (B > R + 40 && B > G + 15) k = 'blue';
          if (k) {
            acc[k][0] += x;
            acc[k][1] += y;
            acc[k][2]++;
          }
        }
      }
      const cen = {};
      for (const k of Object.keys(acc)) cen[k] = acc[k][2] ? [acc[k][0] / acc[k][2] / w, acc[k][1] / acc[k][2] / h, acc[k][2]] : null;
      const px = await window.__h.pixelAt(url, 0, 0);
      return { w, h, mimeOk: url.startsWith('data:image/jpeg'), same: before === after, cen, px, rt: viewer.renderer.getRenderTarget() === null, planes: viewer.renderer.clippingPlanes.length };
    });
    assert(r.w === 300 && r.h === 200 && r.mimeOk, `dimensiones/mime ${r.w}x${r.h}`);
    assert(r.same, 'la cámara principal no debe cambiar');
    assert(r.rt && r.planes === 0, 'se restauran el render target y los planos');
    for (const k of ['green', 'red', 'orange', 'blue']) assert(r.cen[k] && r.cen[k][2] > 20, `no se ve el cubo ${k}`);
    assert(r.cen.green[1] < 0.5, `el verde (norte) debe quedar en la mitad superior: y=${r.cen.green[1]}`);
    assert(r.cen.blue[1] > 0.5, `el azul (sur) debe quedar en la mitad inferior: y=${r.cen.blue[1]}`);
    assert(r.cen.red[0] < 0.5, `el rojo (oeste) debe quedar a la izquierda: x=${r.cen.red[0]}`);
    assert(r.cen.orange[0] > 0.5, `el naranja (este) debe quedar a la derecha: x=${r.cen.orange[0]}`);
    // el fondo es claro (conversión lineal → sRGB correcta)
    assert(r.px[0] > 225 && r.px[0] < 250, `fondo de la miniatura = ${r.px}`);
  });

  await step('renderTopView recorta lo que está sobre box.max.y', async () => {
    const r = await page.evaluate(async () => {
      const { THREE, viewer, group } = window.__t;
      const box = new THREE.Box3().setFromObject(group);
      const low = box.clone();
      low.max.y = 0.2; // por debajo de la cara superior de la losa (0.3): solo se ve el interior
      const full = viewer.renderTopView({ box, width: 200, height: 140 });
      const cut = viewer.renderTopView({ box: low, width: 200, height: 140 });
      const count = async (url) => {
        const { w, h, data } = await window.__h.pixels(url);
        let n = 0;
        for (let i = 0; i < w * h; i++) if (data[i * 4 + 1] > data[i * 4] + 25 && data[i * 4 + 1] > data[i * 4 + 2] + 25) n++;
        return n;
      };
      return { gFull: await count(full), gCut: await count(cut) };
    });
    assert(r.gFull > 20, 'el verde se ve en la miniatura completa');
    assert(r.gCut < r.gFull * 0.25, `con el recorte el verde debe desaparecer casi por completo (${r.gFull} → ${r.gCut})`);
  });

  await step('medición vía store dibuja etiquetas (Δz solo si > 1 mm) y las borra', async () => {
    await page.evaluate(() => {
      const { actions, store } = window.__t;
      actions.clearMeasures();
      actions.addMeasure([-4, 0.3, 3], [4, 0.3, 3]); // 8 m horizontal
      actions.addMeasure([-3, 0.3, 0], [-3, 2.5, 0]); // 2.2 m vertical
      actions.addMeasure([1, 0.3, 2], [1, 0.3005, 2]); // 0.5 mm: sin Δz
      return store.get('measure').items.length;
    });
    await frames(3);
    const r = await page.evaluate(() => {
      const fmt = new Intl.NumberFormat('es-PE', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
      const labels = [...document.querySelectorAll('.measure-label:not(.measure-label--preview)')].map((el) => ({
        dist: el.querySelector('.measure-label__dist').textContent,
        dz: el.querySelector('.measure-label__dz').textContent,
        dzVisible: getComputedStyle(el.querySelector('.measure-label__dz')).display !== 'none',
        shown: el.style.display !== 'none',
        hasDel: !!el.querySelector('.measure-label__del'),
      }));
      return { labels, f8: `${fmt.format(8)} m`, f22: `${fmt.format(2.2)} m` };
    });
    assert(r.labels.length === 3, `etiquetas = ${r.labels.length}`);
    assert(r.labels[0].dist === r.f8 && !r.labels[0].dzVisible, `etiqueta 1: ${JSON.stringify(r.labels[0])} (esperado ${r.f8})`);
    assert(/^\d+[.,]\d{3} m$/.test(r.labels[0].dist), `formato de la distancia: ${r.labels[0].dist}`);
    assert(r.labels[1].dist === r.f22 && r.labels[1].dzVisible && r.labels[1].dz === `Δz ${r.f22}`, `etiqueta 2: ${JSON.stringify(r.labels[1])}`);
    assert(!r.labels[2].dzVisible, 'Δz < 1 mm no se muestra');
    assert(r.labels.every((l) => l.hasDel), 'cada etiqueta tiene botón ×');
    await shot('03-mediciones');

    // la línea y los marcadores se dibujan en la superposición (sin recorte)
    const url = await page.evaluate(() => window.__t.viewer.screenshot({ mime: 'image/png' }));
    const dark = await page.evaluate(async (u) => {
      const { w, h, data } = await window.__h.pixels(u);
      let n = 0;
      for (let i = 0; i < w * h; i++) if (data[i * 4] < 70 && data[i * 4 + 1] < 70 && data[i * 4 + 2] < 70) n++;
      return n;
    }, url);
    assert(dark > 150, `la línea de medición debe verse (píxeles oscuros = ${dark})`);

    // borrar con ×
    const before = await page.evaluate(() => window.__t.store.get('measure').items.length);
    await page.locator('.measure-label__del').first().click({ force: true });
    await frames(2);
    const after = await page.evaluate(() => ({ n: window.__t.store.get('measure').items.length, labels: document.querySelectorAll('.measure-label:not(.measure-label--preview)').length }));
    assert(after.n === before - 1 && after.labels === before - 1, `× debe borrar una medición (${before} → ${after.n}/${after.labels})`);
  });

  await step('con el visor bloqueado se ocultan los botones ×', async () => {
    const visible = (locked) => page.evaluate((lk) => {
      window.__t.viewer.enableInput(!lk);
      const btn = document.querySelector('.measure-label__del');
      return btn ? getComputedStyle(btn).display : 'sin-boton';
    }, locked);
    assert((await visible(true)) === 'none', 'bloqueado: botón oculto');
    assert((await visible(false)) !== 'none', 'desbloqueado: botón visible');
  });

  await step('medición interactiva: dos clics, línea elástica, Esc cancela', async () => {
    const r1 = await page.evaluate(async () => {
      const { viewer, actions } = window.__t;
      actions.clearMeasures();
      actions.setMeasureActive(true);
      await viewer.setView('iso', { smooth: false });
      await viewer.fitAll({ smooth: false });
      return { p1: window.__h.pxOf([-4, 0.3, 3]), p2: window.__h.pxOf([4, 0.3, 3]), cursor: viewer.canvas.style.cursor };
    });
    assert(r1.cursor === 'crosshair', 'cursor de cruz al medir');
    await frames(3);
    await page.mouse.click(r1.p1.x, r1.p1.y);
    await frames(2);
    assert(await page.evaluate(() => window.__t.measure.hasPending()), 'tras el primer clic hay un punto pendiente');
    await page.mouse.move(r1.p2.x, r1.p2.y, { steps: 4 });
    await frames(4);
    const prev = await page.evaluate(() => {
      const el = document.querySelector('.measure-label--preview');
      return el ? { text: el.querySelector('.measure-label__dist').textContent, shown: el.style.display !== 'none' } : null;
    });
    assert(prev && prev.shown && /\d/.test(prev.text), `la línea elástica debe mostrar su etiqueta: ${JSON.stringify(prev)}`);
    await shot('04-elastica');
    await page.mouse.click(r1.p2.x, r1.p2.y);
    await frames(3);
    const items = await page.evaluate(() => ({ items: window.__t.store.get('measure').items, pending: window.__t.measure.hasPending() }));
    assert(items.items.length === 1 && !items.pending, `una medición creada (${items.items.length})`);
    const [it] = items.items;
    near(it.a[1], 0.3, 0.02, 'a.y sobre la losa');
    near(it.b[1], 0.3, 0.02, 'b.y sobre la losa');
    near(Math.hypot(it.b[0] - it.a[0], it.b[2] - it.a[2]), 8, 0.3, 'distancia aproximada entre los puntos');
    assert(typeof it.id === 'string', 'la medición tiene id (actions.addMeasure)');

    // Esc cancela el punto en curso
    await page.mouse.click(r1.p1.x, r1.p1.y);
    await frames(2);
    assert(await page.evaluate(() => window.__t.measure.hasPending()), 'nuevo punto pendiente');
    await page.keyboard.press('Escape');
    await frames(2);
    const after = await page.evaluate(() => ({ pending: window.__t.measure.hasPending(), prev: !!document.querySelector('.measure-label--preview') && document.querySelector('.measure-label--preview').style.display !== 'none' }));
    assert(!after.pending && !after.prev, 'Esc cancela el punto y oculta la vista previa');
    // un clic en el vacío no hace nada
    await page.mouse.click(40, 560);
    await frames(2);
    assert(!(await page.evaluate(() => window.__t.measure.hasPending())), 'clic en el vacío no crea punto');
    await page.evaluate(() => window.__t.actions.setMeasureActive(false));
    await frames(2);
    assert((await page.evaluate(() => window.__t.viewer.canvas.style.cursor)) === '', 'el cursor se restablece');
    // con la medición inactiva, los clics no crean puntos
    await page.mouse.click(r1.p1.x, r1.p1.y);
    await frames(2);
    assert(!(await page.evaluate(() => window.__t.measure.hasPending())), 'inactiva: sin puntos');
  });

  await step('origen global: rebase desplaza cámara, mediciones y sección sin saltos en pantalla', async () => {
    const r = await page.evaluate(async () => {
      const { THREE, viewer, store, actions, group, boxes } = window.__t;
      const wo = viewer.worldOrigin;
      actions.clearMeasures();
      actions.addMeasure([-3, 0.3, 0], [3, 0.3, 0]);
      actions.setSection({ enabled: true, min: [-10, -1, -10], max: [10, 10, 10] });
      await new Promise((res) => setTimeout(res, 50));
      await viewer.setView('iso', { smooth: false });
      await viewer.fitAll({ smooth: false });
      const o0 = { ...wo.origin };
      const s0 = viewer.getCameraState();
      const m0 = store.get('measure').items[0];
      const sec0 = store.get('section');
      const gpos0 = group.position.clone();
      const ndc0 = window.__h.ndcOf(boxes.azul.getWorldPosition(new THREE.Vector3()).toArray());
      const map0 = wo.sceneToMap(boxes.azul.getWorldPosition(new THREE.Vector3()));
      wo.rebase({ e: o0.e + 10, n: o0.n - 20, h: o0.h + 1 });
      await new Promise((res) => requestAnimationFrame(res));
      const s1 = viewer.getCameraState();
      const m1 = store.get('measure').items[0];
      const sec1 = store.get('section');
      const ndc1 = window.__h.ndcOf(boxes.azul.getWorldPosition(new THREE.Vector3()).toArray());
      const map1 = wo.sceneToMap(boxes.azul.getWorldPosition(new THREE.Vector3()));
      const gpos1 = group.position.clone();
      const labelsHidden = document.querySelectorAll('.measure-label').length;
      const out = {
        o0, o1: { ...wo.origin }, s0, s1, m0, m1, sec0, sec1, ndc0, ndc1, map0, map1,
        gdelta: gpos1.clone().sub(gpos0).toArray(),
        mapToScene: wo.mapToScene(279500, 8661000, 150).toArray(),
        gpos1: gpos1.toArray(),
        labelsHidden,
      };
      // dejamos todo como estaba
      wo.rebase(o0);
      await new Promise((res) => requestAnimationFrame(res));
      out.backCam = viewer.getCameraState();
      actions.setSection({ enabled: false });
      actions.clearMeasures();
      return out;
    });
    // delta = escenaNueva − escenaVieja = (old.e − new.e, old.h − new.h, −(old.n − new.n))
    const delta = [-10, -1, -20];
    vecNear(r.gdelta, delta, 1e-9, 'el grupo del modelo se desplaza delta');
    vecNear(r.s1.position.map((v, i) => v - r.s0.position[i]), delta, 1e-6, 'la cámara se desplaza delta');
    vecNear(r.s1.target.map((v, i) => v - r.s0.target[i]), delta, 1e-6, 'el objetivo se desplaza delta');
    vecNear(r.m1.a.map((v, i) => v - r.m0.a[i]), delta, 1e-6, 'medición.a se desplaza delta');
    vecNear(r.m1.b.map((v, i) => v - r.m0.b[i]), delta, 1e-6, 'medición.b se desplaza delta');
    vecNear(r.sec1.min.map((v, i) => v - r.sec0.min[i]), delta, 1e-6, 'sección.min se desplaza delta');
    vecNear(r.sec1.max.map((v, i) => v - r.sec0.max[i]), delta, 1e-6, 'sección.max se desplaza delta');
    near(r.ndc1.x, r.ndc0.x, 1e-6, 'sin salto en pantalla (x)');
    near(r.ndc1.y, r.ndc0.y, 1e-6, 'sin salto en pantalla (y)');
    vecNear([r.map1.e, r.map1.n, r.map1.h], [r.map0.e, r.map0.n, r.map0.h], 1e-6, 'coordenadas de mapa del cubo no cambian');
    vecNear([r.o1.e - r.o0.e, r.o1.n - r.o0.n, r.o1.h - r.o0.h], [10, -20, 1], 1e-9, 'nuevo origen');
    vecNear(r.mapToScene, r.gpos1, 1e-9, 'mapToScene(ancla) = posición del grupo registrado');
    vecNear(r.backCam.position, r.s0.position, 1e-6, 'al volver el origen la cámara regresa');
  });

  await step('followCamera: interpolación continua y cambio de proyección', async () => {
    const r = await page.evaluate(async () => {
      const { viewer } = window.__t;
      await viewer.setView('iso', { smooth: false });
      await viewer.fitAll({ smooth: false });
      viewer.enableInput(false); // como un espectador en presentación
      const s0 = viewer.getCameraState();
      const goal = { position: [s0.position[0] - 10, s0.position[1] + 6, s0.position[2] + 8], target: [1, 2, -1], projection: 'perspective', zoom: 1, fov: 45 };
      viewer.followCamera(goal);
      const dist = () => {
        const s = viewer.getCameraState();
        return Math.hypot(...s.position.map((v, i) => v - goal.position[i]));
      };
      const d0 = dist();
      const samples = [];
      const t0 = performance.now();
      while (performance.now() - t0 < 8000) {
        await new Promise((res) => requestAnimationFrame(res));
        samples.push(dist());
        if (samples[samples.length - 1] < 1e-3) break;
      }
      const sEnd = viewer.getCameraState();
      // ahora cambia de proyección siguiendo un estado ortográfico
      const goal2 = { position: [30, 25, 30], target: [0, 1, 0], projection: 'orthographic', zoom: 5, fov: 45 };
      viewer.followCamera(goal2);
      const t1 = performance.now();
      while (performance.now() - t1 < 8000) {
        await new Promise((res) => requestAnimationFrame(res));
        const s = viewer.getCameraState();
        if (s.projection === 'orthographic' && Math.abs(s.zoom - 5) < 1e-3 && Math.hypot(...s.position.map((v, i) => v - goal2.position[i])) < 1e-3) break;
      }
      const s2 = viewer.getCameraState();
      const out = { d0, samples, sEnd, goal, s2, goal2, proj: viewer.camera.type };
      viewer.enableInput(true);
      viewer.setProjection('perspective');
      return out;
    });
    assert(r.samples.length > 3, `el seguimiento debe tomar varios frames (${r.samples.length})`);
    assert(r.samples[0] < r.d0 && r.samples[0] > 0, 'tras el primer frame ya se acerca pero no llega de golpe');
    let monotone = true;
    for (let i = 1; i < r.samples.length; i++) if (r.samples[i] > r.samples[i - 1] + 1e-9) monotone = false;
    assert(monotone, 'la distancia al objetivo debe decrecer monótonamente');
    vecNear(r.sEnd.position, r.goal.position, 2e-3, 'posición final del seguimiento');
    vecNear(r.sEnd.target, r.goal.target, 2e-3, 'objetivo final del seguimiento');
    assert(r.s2.projection === 'orthographic' && r.proj === 'OrthographicCamera', 'el seguimiento cambia la proyección');
    near(r.s2.zoom, 5, 5e-3, 'zoom ortográfico seguido');
    vecNear(r.s2.position, r.goal2.position, 2e-3, 'posición ortográfica seguida');
  });

  await step('followCamera: converge según el tiempo transcurrido, no según el número de fotogramas (fotogramas lentos)', async () => {
    const r = await page.evaluate(async () => {
      const { viewer } = window.__t;
      const raf = () => new Promise((res) => requestAnimationFrame(res));
      await viewer.setView('iso', { smooth: false });
      await viewer.fitAll({ smooth: false });
      await raf();
      await raf();
      viewer.enableInput(false); // como un espectador en presentación
      const s0 = viewer.getCameraState();
      const goal = { position: [s0.position[0] - 10, s0.position[1] + 6, s0.position[2] + 8], target: [1, 2, -1], projection: 'perspective', zoom: 1, fov: 45 };
      const dist = () => Math.hypot(...viewer.getCameraState().position.map((v, i) => v - goal.position[i]));
      viewer.followCamera(goal);
      const d0 = dist();
      // Un fotograma lento (WebGL por software, equipo cargado): el hilo principal se bloquea 650 ms antes del siguiente dibujo
      const t = performance.now();
      while (performance.now() - t < 650) { /* bloqueo deliberado */ }
      await raf();
      const dSlow = dist();
      viewer.stopFollow();
      viewer.enableInput(true);
      return { d0, dSlow };
    });
    assert(r.d0 > 10, `la meta debe estar lejos (${r.d0.toFixed(2)} m)`);
    // Con el tope antiguo (0,1 s) un fotograma lento solo avanzaba el 76 % (quedaban ~3 m); por tiempo real queda < 2 cm
    assert(r.dSlow < 0.05, `tras un fotograma de 650 ms la cámara debe estar prácticamente en la meta (a ${r.dSlow.toFixed(3)} m de ${r.d0.toFixed(2)})`);
  });

  await step('isCameraMoving: verdadero durante el amortiguado y el seguimiento, falso al asentarse', async () => {
    const r = await page.evaluate(async () => {
      const { viewer } = window.__t;
      const raf = () => new Promise((res) => requestAnimationFrame(res));
      const settle = async () => {
        const t0 = performance.now();
        while (viewer.isCameraMoving() && performance.now() - t0 < 15000) await raf();
        return !viewer.isCameraMoving();
      };
      await viewer.setView('iso', { smooth: false });
      await viewer.fitAll({ smooth: false });
      const quiet0 = await settle();
      const s0 = viewer.getCameraState();
      // Movimiento amortiguado de los controles
      viewer.setCameraState({ ...s0, position: [s0.position[0] + 6, s0.position[1] + 2, s0.position[2]] }, { smooth: true });
      const movingSmooth = viewer.isCameraMoving();
      const quiet1 = await settle();
      // Seguimiento de cámara
      const s1 = viewer.getCameraState();
      viewer.followCamera({ ...s1, position: [s1.position[0] - 4, s1.position[1], s1.position[2]] });
      const movingFollow = viewer.isCameraMoving();
      const quiet2 = await settle();
      const end = viewer.getCameraState();
      return { quiet0, movingSmooth, quiet1, movingFollow, quiet2, moved: Math.hypot(...end.position.map((v, i) => v - s1.position[i])) };
    });
    assert(r.quiet0, 'tras un encuadre sin animación la cámara está quieta');
    assert(r.movingSmooth, 'isCameraMoving debe ser verdadero justo tras un setCameraState suave');
    assert(r.quiet1, 'la cámara se asienta tras el amortiguado');
    assert(r.movingFollow, 'isCameraMoving debe ser verdadero con un seguimiento en curso');
    assert(r.quiet2, 'la cámara se asienta al terminar el seguimiento');
    near(r.moved, 4, 1e-2, 'el seguimiento llegó a la meta');
  });

  await step('caja de sección: planos, recorte visible, contorno naranja y picks', async () => {
    await page.evaluate(async () => {
      const { viewer, actions } = window.__t;
      actions.setSection({ enabled: false });
      await viewer.setView('iso', { smooth: false });
      await viewer.fitAll({ smooth: false });
    });
    await frames(3);
    // 1) Activar con la caja vacía → toma lo visible y escribe en el store
    const r1 = await page.evaluate(async () => {
      const { THREE, viewer, store, actions, group } = window.__t;
      actions.setSection({ enabled: true, min: [0, 0, 0], max: [0, 0, 0] });
      await Promise.resolve();
      await new Promise((res) => requestAnimationFrame(res));
      const sec = store.get('section');
      const vis = new THREE.Box3().setFromObject(group);
      return {
        sec,
        vis: { min: vis.min.toArray(), max: vis.max.toArray() },
        planes: viewer.getClippingPlanes().length,
        lines: viewer.overlayRoot.children.some((c) => c.name === 'sectionBox' && c.visible),
      };
    });
    assert(r1.planes === 6, `planos de recorte = ${r1.planes}`);
    assert(r1.lines, 'contorno visible en overlayRoot');
    for (let i = 0; i < 3; i++) {
      assert(r1.sec.min[i] <= r1.vis.min[i] + 1e-6 && r1.sec.max[i] >= r1.vis.max[i] - 1e-6, `la caja debe contener lo visible (eje ${i}): ${JSON.stringify(r1.sec)} vs ${JSON.stringify(r1.vis)}`);
      assert(r1.sec.min[i] > r1.vis.min[i] - 1 && r1.sec.max[i] < r1.vis.max[i] + 1, `la caja no debe ser mucho mayor (eje ${i})`);
    }

    // 2) El contorno se dibuja en la superposición: difiere del render sin sección solo en las líneas
    const d = await page.evaluate(async () => {
      const { viewer, actions } = window.__t;
      const on = viewer.screenshot({ mime: 'image/png' });
      actions.setSection({ enabled: false });
      const off = viewer.screenshot({ mime: 'image/png' });
      actions.setSection({ enabled: true });
      const a = await window.__h.pixels(on);
      const b = await window.__h.pixels(off);
      let n = 0;
      let rb = 0;
      for (let i = 0; i < a.w * a.h; i++) {
        const dd = Math.abs(a.data[i * 4] - b.data[i * 4]) + Math.abs(a.data[i * 4 + 1] - b.data[i * 4 + 1]) + Math.abs(a.data[i * 4 + 2] - b.data[i * 4 + 2]);
        if (dd > 30) {
          n++;
          rb += a.data[i * 4] - a.data[i * 4 + 2];
        }
      }
      return { n, meanRB: n ? rb / n : 0 };
    });
    assert(d.n > 100, `el contorno debe ser visible (píxeles distintos = ${d.n})`);
    assert(d.meanRB > 60, `el contorno debe ser naranja (R−B medio = ${d.meanRB})`);

    // 3) Recortar: se conserva x <= 0. El azul (x = 2) desaparece del render y de los picks
    const r3 = await page.evaluate(async () => {
      const { viewer, actions, boxes } = window.__t;
      const ndcAzul = window.__h.ndcOf(boxes.azul.position.toArray());
      const ndcRojo = window.__h.ndcOf(boxes.rojo.position.toArray());
      const before = viewer.pick(ndcAzul);
      actions.setSection({ min: [-8, -1, -6], max: [0.5, 8, 6] });
      await new Promise((res) => requestAnimationFrame(res));
      const azul = viewer.pick(ndcAzul);
      const rojo = viewer.pick(ndcRojo);
      const url = viewer.screenshot({ mime: 'image/png' });
      const rect = viewer.canvas.getBoundingClientRect();
      const px = window.__h.pxOf(boxes.azul.position.toArray());
      const pr = window.__h.pxOf(boxes.rojo.position.toArray());
      const colAzul = await window.__h.pixelAt(url, px.x - rect.left, px.y - rect.top);
      const colRojo = await window.__h.pixelAt(url, pr.x - rect.left, pr.y - rect.top);
      return { before: before && before.expressId, azul: azul && azul.expressId, rojo: rojo && rojo.expressId, colAzul, colRojo, planes: viewer.getClippingPlanes() .map((p) => [p.normal.toArray(), p.constant]) };
    });
    assert(r3.before === 3, 'antes del recorte el pick da el azul');
    assert(r3.azul !== 3, `el azul recortado no debe poder seleccionarse (${r3.azul})`);
    assert(r3.rojo === 2, `el rojo (dentro) sigue seleccionable (${r3.rojo})`);
    assert(!(r3.colAzul[2] > r3.colAzul[0] + 40), `el píxel del azul no debe ser azul tras recortar: ${r3.colAzul}`);
    assert(r3.colRojo[0] > r3.colRojo[2] + 40, `el píxel del rojo sigue rojo: ${r3.colRojo}`);
    await shot('05-seccion');

    // 4) API de SectionBox
    const r4 = await page.evaluate(() => {
      const { THREE, section, store, viewer } = window.__t;
      const b = section.getBounds();
      const sec = store.get('section');
      section.fitTo(new THREE.Box3(new THREE.Vector3(-1, 0, -1), new THREE.Vector3(1, 2, 1)));
      const fit = store.get('section');
      section.setFace('x', 'max', 3);
      const face = store.get('section').max;
      return {
        bounds: b.isBox3 && !b.isEmpty() && b.min.x <= sec.min[0] && b.max.x >= sec.max[0],
        fit: [fit.min, fit.max],
        face,
        enabled: section.isEnabled(),
        planeCount: viewer.getClippingPlanes().length,
      };
    });
    assert(r4.bounds, 'getBounds devuelve una Box3 que contiene la caja actual');
    vecNear(r4.fit[0], [-1, 0, -1], 1e-9, 'fitTo.min');
    vecNear(r4.fit[1], [1, 2, 1], 1e-9, 'fitTo.max');
    vecNear(r4.face, [3, 2, 1], 1e-9, 'setFace');
    assert(r4.enabled && r4.planeCount === 6, 'sigue activa');

    // 5) Desactivar → sin planos y sin contorno
    const r5 = await page.evaluate(() => {
      const { actions, viewer } = window.__t;
      actions.setSection({ enabled: false });
      return { planes: viewer.getClippingPlanes().length, lines: viewer.overlayRoot.children.some((c) => c.name === 'sectionBox' && c.visible) };
    });
    assert(r5.planes === 0 && !r5.lines, 'desactivada: sin planos ni contorno');
    // 6) Estado remoto con caja vacía no genera recorte ni se autocompleta
    const r6 = await page.evaluate(async () => {
      const { store, viewer } = window.__t;
      store.set('section', { enabled: true, min: [0, 0, 0], max: [0, 0, 0] }, { source: 'remote' });
      await Promise.resolve();
      await new Promise((res) => requestAnimationFrame(res));
      const out = { planes: viewer.getClippingPlanes().length, max: store.get('section').max };
      store.set('section', { enabled: false, min: [0, 0, 0], max: [0, 0, 0] }, { source: 'remote' });
      return out;
    });
    assert(r6.planes === 0 && r6.max.every((v) => v === 0), 'remoto vacío: no se autocompleta ni recorta');
  });

  await step('pantallas de alta densidad: pixelRatio limitado a 2', async () => {
    const ctx = await browser.newContext({ viewport: { width: 500, height: 320 }, deviceScaleFactor: 3 });
    const p2 = await ctx.newPage();
    const errs = [];
    p2.on('pageerror', (e) => errs.push(e.message));
    await p2.goto(URL);
    await p2.waitForFunction(() => window.__ready === true, null, { timeout: 90000 });
    const r = await p2.evaluate(async () => {
      const { viewer } = window.__t;
      const url = viewer.screenshot({ mime: 'image/png' });
      const img = await new Promise((res) => {
        const i = new Image();
        i.onload = () => res(i);
        i.src = url;
      });
      return { dpr: window.devicePixelRatio, pr: viewer.renderer.getPixelRatio(), cw: viewer.canvas.width, ch: viewer.canvas.height, iw: img.width, ih: img.height };
    });
    await ctx.close();
    assert(r.dpr === 3 && r.pr === 2, `pixelRatio = ${r.pr} con DPR ${r.dpr}`);
    assert(r.cw === 1000 && r.ch === 640, `búfer ${r.cw}x${r.ch}`);
    assert(r.iw === 1000 && r.ih === 640, `captura ${r.iw}x${r.ih}`);
    assert(errs.length === 0, `errores: ${errs.join(' | ')}`);
  });

  await step('un segundo Viewer vacío funciona y se libera por completo (Viewer, SectionBox, MeasureTool)', async () => {
    const r = await page.evaluate(async () => {
      const { Viewer } = await import('/js/viewer/Viewer.js');
      const { SectionBox } = await import('/js/viewer/SectionBox.js');
      const { MeasureTool } = await import('/js/viewer/MeasureTool.js');
      const { EventBus } = await import('/js/core/events.js');
      const { createStore } = await import('/js/core/store.js');
      const { createActions } = await import('/js/core/actions.js');
      const div = document.createElement('div');
      div.style.cssText = 'position:absolute;left:0;top:0;width:200px;height:120px';
      document.body.appendChild(div);
      const store = createStore();
      const bus = new EventBus();
      const actions = createActions(store);
      const v = new Viewer(div, { bus, store });
      const section = new SectionBox({ viewer: v, store, bus });
      const measure = new MeasureTool({ viewer: v, store, bus, actions });
      await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
      const out = { hadCanvas: !!div.querySelector('canvas'), emptyBox: v.getVisibleBox().isEmpty() };
      await v.fitAll({ smooth: false }); // sin contenido no hace nada
      out.topView = v.renderTopView({ width: 64, height: 40 });
      out.shot = v.screenshot({ width: 80 }).slice(0, 15);
      // la sección vacía usa un cubo alrededor del objetivo
      actions.setSection({ enabled: true });
      await Promise.resolve();
      out.sectionSize = store.get('section').max.map((m, i) => m - store.get('section').min[i]);
      out.planes = v.getClippingPlanes().length;
      actions.addMeasure([0, 0, 0], [1, 0, 0]);
      await new Promise((res) => requestAnimationFrame(res));
      out.labels = div.querySelectorAll('.measure-label:not(.measure-label--preview)').length;
      measure.dispose();
      section.dispose();
      out.labelsAfter = div.querySelectorAll('.measure-label, .measure-layer').length;
      out.planesAfter = v.getClippingPlanes().length;
      out.overlayChildren = v.overlayRoot.children.length;
      v.dispose();
      out.gone = !div.querySelector('canvas');
      div.remove();
      return out;
    });
    assert(r.hadCanvas && r.gone, 'dispose retira el canvas');
    assert(r.emptyBox, 'sin modelos la caja visible está vacía');
    assert(r.topView.startsWith('data:image/jpeg'), 'renderTopView sin contenido devuelve una imagen');
    assert(r.shot.startsWith('data:image/jpeg'), 'screenshot sin contenido devuelve una imagen');
    assert(r.sectionSize.every((d) => Math.abs(d - 10) < 1e-6) && r.planes === 6, `sección sin contenido: ${r.sectionSize}`);
    assert(r.labels === 1, 'la medición del segundo visor dibuja su etiqueta');
    assert(r.labelsAfter === 0 && r.planesAfter === 0 && r.overlayChildren === 0, `dispose limpia etiquetas, planos y superposición (${JSON.stringify(r)})`);
  });

  await step('sin errores de consola durante toda la prueba', async () => {
    assert(errors.length === 0, `errores: ${errors.join(' | ')}`);
  });

  await page.context().close();
} catch (err) {
  console.error('Error inesperado en la prueba:', err);
  results.push({ name: 'ejecución', ok: false, error: err });
} finally {
  await browser.close();
  server.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} pasos correctos`);
if (failed.length) {
  exitCode = 1;
  for (const f of failed) console.log(` - ${f.name}: ${f.error?.message}`);
}
process.exit(exitCode);
