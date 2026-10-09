// Prueba E2E de la aplicación completa con el servidor REAL (server/index.js) y todos los módulos reales
// (viewer + IFC + CAD + sincronización + UI): flujo completo del presentador y georreferenciación numérica.
//
// Uso: node tests/e2e/app.test.mjs   (UI_APP_PORT cambia el puerto base; 8220 por defecto)

import fs from 'node:fs';
import path from 'node:path';
import {
  startServer, launchBrowser, openPage, uploadFixture, assert, waitFor, getSlice, waitForApp,
  elementStates, findIfcPixel, waitIdle, cameraDistance, lanIp, OUTPUT, FIXTURES,
} from './helpers.mjs';

const PORT = Number(process.env.UI_APP_PORT || 8220);
const results = [];
const handles = [];

async function test(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ok   ${name} (${Date.now() - t0} ms)`);
  } catch (err) {
    results.push({ name, ok: false, err });
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
}

const shot = (page, name) => page.screenshot({ path: path.join(OUTPUT, `app-${name}.png`) });
const cam = (page) => page.evaluate(() => window.__visor.viewer.getCameraState());
const near = (a, b, tol, what) => assert(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b} (tolerancia ${tol})`);

// Dónde cae en pantalla (px de la página) el centro de una caja de escena, y el centro de la zona libre del visor
// (la que no tapan la barra lateral ni el dock; ahí es donde deben quedar centrados los encuadres).
function screenCenters(page, boxArr) {
  return page.evaluate((b) => {
    const v = window.__visor.viewer;
    const THREE_V = v.camera.position.constructor;
    const c = new THREE_V((b[0] + b[3]) / 2, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2).project(v.camera);
    const r = v.canvas.getBoundingClientRect();
    const i = v.getFitInsets();
    return {
      px: r.left + ((c.x + 1) / 2) * r.width,
      py: r.top + ((1 - c.y) / 2) * r.height,
      freeX: r.left + (r.width + i.left - i.right) / 2,
      freeY: r.top + (r.height + i.top - i.bottom) / 2,
      insets: i,
    };
  }, boxArr);
}

async function open(browser, name, url, viewport) {
  const h = await openPage(browser, url, viewport ? { viewport } : undefined);
  h.name = name;
  handles.push(h);
  return h;
}

// Cajas de escena (en metros) de los modelos cargados: IFC completo, muros IFC y capa MUROS del DXF.
function sceneBoxes(page) {
  return page.evaluate(() => {
    const v = window.__visor;
    const arr = (b) => (b ? { min: b.min.toArray(), max: b.max.toArray() } : null);
    const out = { origin: v.viewer.worldOrigin.origin, ifc: {}, cad: {} };
    for (const m of v.ifc.getModels()) {
      const t = m.table;
      const walls = [];
      for (let i = 0; i < t.count; i++) if (/^IFCWALL/.test(t.typeNames[t.typeIdx[i]] ?? '')) walls.push({ modelId: m.id, expressId: t.expressIds[i] });
      out.ifc[m.record.name] = { id: m.id, box: arr(v.ifc.getModelBox(m.id)), walls: arr(v.ifc.getBoxOf(walls)), nWalls: walls.length, georef: v.ifc.getGeorefInfo(m.id) };
    }
    const Box3 = v.ifc.getModelBox(v.ifc.getModels()[0].id).constructor;
    for (const m of v.cad.getModels()) {
      const bx = new Box3();
      for (const o of m.layerObjects.get('MUROS') || []) {
        o.updateWorldMatrix(true, false);
        o.geometry.computeBoundingBox();
        bx.union(o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld));
      }
      out.cad[m.name] = { id: m.id, muros: bx.isEmpty() ? null : arr(bx), elevation: m.elevation, anchor: m.anchor, georeferenced: m.georeferenced, groupY: m.group.position.y, units: m.units };
    }
    out.baseElevation = v.ifc.getBaseElevation();
    out.storeys = v.ifc.getStoreys();
    return out;
  });
}

const boxDiff = (a, b, axes = [0, 1, 2]) => Math.max(...axes.flatMap((i) => [Math.abs(a.min[i] - b.min[i]), Math.abs(a.max[i] - b.max[i])]));

// Deja la selección vacía y el foco fuera de los campos de texto (los atajos no actúan dentro de ellos)
async function clearSelection(page) {
  await page.mouse.move(5, 5); // el puntero fuera del lienzo: sin hover
  await page.evaluate(() => { document.activeElement?.blur?.(); window.__visor.actions.clearSelection(); });
  await waitFor(async () => (await getSlice(page, 'selection')).items.length === 0, { timeout: 3000, label: 'selección vacía' });
}

async function run() {
  const server = await startServer({ port: PORT });
  const extra = []; // servidores adicionales a detener
  const browser = await launchBrowser();
  console.log(`App: servidor real en ${server.url}`);
  try {
    // ------------------------------------------------------------------ arranque
    const P = await open(browser, 'presentador', server.url);
    await test('arranca con el servidor real: sin modelos, sin errores y con la UI completa', async () => {
      await P.page.waitForFunction(() => document.documentElement.dataset.ready === 'true', null, { timeout: 30000 });
      for (const sel of ['.sidebar', '.header__title', '.toolbar-col', '.zoom', '.orbit', '.dock', '.status-cluster', 'canvas']) {
        assert(await P.page.locator(sel).first().isVisible(), `falta ${sel}`);
      }
      assert((await P.page.locator('.header__title').textContent()).trim() === 'Visor IFC 5D', 'título por defecto');
      const p = await getSlice(P.page, 'presentation');
      assert(p.role === 'presenter' && p.connected, `rol ${p.role}, conectado ${p.connected}`);
      assert(await P.page.locator('.btn--present').isEnabled(), 'botón Presentar activo');
      assert(P.errors.length === 0, P.errors.join(' | '));
      await shot(P.page, '00-vacio');
    });

    // ------------------------------------------------------------------ carga por la UI
    await test('subir un IFC desde la UI: se carga solo en el presentador (progreso, título, encuadre)', async () => {
      await P.page.locator('input[type=file]').first().setInputFiles(path.join(FIXTURES, 'edificio_georef_ifc4.ifc'));
      await waitFor(async () => (await getSlice(P.page, 'modelRecords')).length === 1, { timeout: 20000, label: 'registro del servidor' });
      await waitForApp(P.page, { ifc: 1, cad: 0 });
      const rec = (await getSlice(P.page, 'modelRecords'))[0];
      assert(rec.kind === 'ifc' && rec.name === 'edificio_georef_ifc4.ifc', 'registro del modelo');
      const loading = (await getSlice(P.page, 'loading'))[rec.id];
      assert(loading?.phase === 'done', `fase final: ${loading?.phase}`);
      assert((await getSlice(P.page, 'models'))[rec.id]?.visible === true, 'store.models[id].visible');
      await waitFor(async () => (await P.page.locator('.header__title').textContent()).includes('Proyecto Demo 5D'), { timeout: 5000, label: 'título del proyecto' });
      assert((await P.page.locator('.chip', { hasText: 'Edificio A' }).count()) >= 1, 'chip del edificio');
      assert((await P.page.locator('.model').count()) === 1, 'tarjeta del modelo');
      assert((await P.page.locator('.model .badge--ok').first().textContent()).includes('EPSG:32718'), 'insignia de georreferencia');
      // El primer modelo encuadra todo: queda centrado en la zona libre (fuera de la barra lateral y del dock)
      await waitIdle(P.page, 700);
      const box = await P.page.evaluate(() => { const v = window.__visor; const b = v.ifc.getModelBox(v.ifc.getModels()[0].id); return [...b.min.toArray(), ...b.max.toArray()]; });
      const sc = await screenCenters(P.page, box);
      assert(sc.insets.left > 300 && sc.insets.bottom > 100, `insets del visor: ${JSON.stringify(sc.insets)}`);
      assert(Math.abs(sc.px - sc.freeX) < 30 && Math.abs(sc.py - sc.freeY) < 30, `el modelo no quedó centrado en la zona libre: (${sc.px.toFixed(0)}, ${sc.py.toFixed(0)}) vs (${sc.freeX.toFixed(0)}, ${sc.freeY.toFixed(0)})`);
      const states = await elementStates(P.page);
      assert(states.total === 20 && states[0] === 20, `20 elementos normales (${JSON.stringify(states)})`);
      await shot(P.page, '01-modelo');
      assert(P.errors.length === 0, P.errors.join(' | '));
    });

    await test('resumen, niveles y categorías coinciden con el modelo (20 elementos, 2 niveles, 5 categorías)', async () => {
      const info = await P.page.evaluate(() => {
        const v = window.__visor;
        return { types: v.ifc.getTypeSummary(), storeys: v.ifc.getStoreys(), cats: [...document.querySelectorAll('.cat')].map((c) => c.getAttribute('data-type')) };
      });
      assert(info.types.length === 5 && info.types.reduce((a, t) => a + t.count, 0) === 20, 'categorías IFC');
      assert(info.storeys.length === 2 && info.storeys[1].mapHeight - info.storeys[0].mapHeight === 3, 'niveles a 3 m');
      assert(info.cats.length === 5, `tarjetas de categoría en el dock: ${info.cats.length}`);
      assert((await P.page.locator('.stat[data-stat="elements"] .stat__value').textContent()).trim() === '20', 'cifra de elementos');
      assert((await P.page.locator('.stat[data-stat="storeys"] .stat__value').textContent()).trim() === '2', 'cifra de niveles');
    });

    // ------------------------------------------------------------------ árbol y propiedades
    await test('árbol espacial: proyecto > terreno > edificio > niveles > elementos; seleccionar desde el árbol', async () => {
      await P.page.click('.pill[data-tab="tree"]');
      const rows = await P.page.locator('.tab--tree .trow').allTextContents();
      for (const t of ['Proyecto Demo 5D', 'Terreno', 'Edificio A', 'Nivel 1', 'Nivel 2']) assert(rows.some((r) => r.includes(t)), `falta ${t} en el árbol`);
      await P.page.locator('.trow.is-spatial', { hasText: 'Nivel 2' }).first().click();
      await waitFor(() => P.page.locator('.tab--tree .trow:not(.is-spatial)').count().then((n) => n === 10), { timeout: 5000, label: '10 elementos del Nivel 2' });
      await P.page.locator('.tab--tree .trow:not(.is-spatial)', { hasText: 'Muro Nivel 2 M02' }).first().click();
      await waitFor(async () => (await getSlice(P.page, 'selection')).items.length === 1, { timeout: 4000, label: 'selección' });
      await waitFor(async () => { const s = await elementStates(P.page); return s[3] === 1 && s[1] === 19; }, { timeout: 6000, label: 'resto en fantasma' });
      assert((await P.page.locator('.sel__name').textContent()).trim() === 'Muro Nivel 2 M02', 'nombre en la tarjeta oscura');
      assert((await P.page.locator('.sel__sub').textContent()).includes('Nivel 2'), 'nivel en la tarjeta');
    });

    await test('propiedades del elemento: atributos, Pset_WallCommon y CT_Partida; el buscador filtra', async () => {
      await P.page.click('.pill[data-tab="props"]');
      await waitFor(() => P.page.locator('.tab--props .psec').count().then((n) => n >= 3), { timeout: 6000, label: 'secciones de propiedades' });
      const text = await P.page.locator('.tab--props').innerText();
      for (const t of ['Pset_WallCommon', 'FireRating', 'EI60', 'CT_Partida', '02.01.02', 'IfcWall']) assert(text.includes(t), `falta "${t}" en las propiedades`);
      await P.page.fill('.tab--props input[type=search], .tab--props .input', 'FireRating');
      await waitFor(() => P.page.locator('.prop:visible').count().then((n) => n === 1), { timeout: 4000, label: 'filtro de propiedades' });
      await P.page.fill('.tab--props input[type=search], .tab--props .input', '');
      await P.page.evaluate(() => document.activeElement?.blur?.()); // los atajos no actúan con el foco en un campo
      await shot(P.page, '02-propiedades');
    });

    // ------------------------------------------------------------------ selección con clic real
    await test('clic real en el lienzo: selecciona el elemento, el resto queda en fantasma y aparece la tarjeta oscura', async () => {
      await P.page.keyboard.press('Escape');
      await waitFor(async () => (await getSlice(P.page, 'selection')).items.length === 0, { timeout: 3000, label: 'Esc limpia' });
      await P.page.click('.pill[data-tab="models"]');
      await waitFor(async () => (await elementStates(P.page))[0] === 20, { timeout: 5000, label: 'todo normal' });
      const pix = await findIfcPixel(P.page, { type: 'IFCWALL' });
      assert(pix, 'sin muro visible');
      await P.page.mouse.move(pix.px - 25, pix.py - 10);
      await P.page.mouse.move(pix.px, pix.py, { steps: 4 });
      // Hover
      await waitFor(async () => { const s = await elementStates(P.page); return s[4] === 1; }, { timeout: 4000, label: 'hover (estado 4)' });
      assert((await getSlice(P.page, 'hover'))?.expressId === pix.expressId, 'store.hover');
      await P.page.mouse.click(pix.px, pix.py);
      await waitFor(async () => { const s = await elementStates(P.page); return s[3] === 1 && s[1] === 19; }, { timeout: 6000, label: 'seleccionado + 19 fantasmas' });
      const sel = (await getSlice(P.page, 'selection')).items;
      assert(sel.length === 1 && sel[0].expressId === pix.expressId, 'selección = elemento clicado');
      assert(await P.page.locator('.sel').isVisible(), 'tarjeta oscura');
      assert((await P.page.locator('.sel__name').textContent()).trim() === pix.info.name, 'nombre del elemento');
      await shot(P.page, '03-seleccion-fantasma');
      // Ctrl+clic añade otro elemento
      const other = await findIfcPixel(P.page, { type: 'IFCSLAB' }) || await findIfcPixel(P.page, { type: 'IFCCOLUMN' });
      await P.page.keyboard.down('Control');
      await P.page.mouse.click(other.px, other.py);
      await P.page.keyboard.up('Control');
      await waitFor(async () => (await getSlice(P.page, 'selection')).items.length === 2, { timeout: 4000, label: 'Ctrl+clic añade' });
      assert((await P.page.locator('.sel__name').textContent()).includes('2 elementos'), 'tarjeta con 2 elementos');
      await P.page.keyboard.down('Control');
      await P.page.mouse.click(other.px, other.py);
      await P.page.keyboard.up('Control');
      await waitFor(async () => (await getSlice(P.page, 'selection')).items.length === 1, { timeout: 4000, label: 'Ctrl+clic quita' });
      // Clic en el vacío limpia
      await P.page.mouse.click(1000, 200);
      await waitFor(async () => (await getSlice(P.page, 'selection')).items.length === 0, { timeout: 4000, label: 'clic en vacío limpia' });
      await waitFor(async () => (await elementStates(P.page))[0] === 20, { timeout: 5000, label: 'sin fantasmas' });
      assert(await P.page.locator('.sel').isHidden(), 'la tarjeta desaparece');
    });

    await test('doble clic encuadra el elemento (la cámara se acerca y apunta a él)', async () => {
      const pix = await findIfcPixel(P.page, { type: 'IFCCOLUMN' });
      const before = await cam(P.page);
      const box = await P.page.evaluate((it) => { const b = window.__visor.ifc.getBoxOf([it]); return [...b.min.toArray(), ...b.max.toArray()]; }, { modelId: pix.modelId, expressId: pix.expressId });
      await P.page.mouse.dblclick(pix.px, pix.py);
      await waitFor(async () => cameraDistance(before, await cam(P.page)) > 1, { timeout: 5000, label: 'la cámara se mueve' });
      await waitIdle(P.page, 700);
      const after = await cam(P.page);
      const sc = await screenCenters(P.page, box);
      assert(Math.abs(sc.px - sc.freeX) < 6 && Math.abs(sc.py - sc.freeY) < 6, `el elemento no quedó en el centro de la zona libre: (${sc.px.toFixed(0)}, ${sc.py.toFixed(0)}) vs (${sc.freeX.toFixed(0)}, ${sc.freeY.toFixed(0)})`);
      assert(cameraDistance(before, after) > 1, 'la cámara se movió');
      await P.page.keyboard.press('f'); // sin selección: encuadra todo
      await waitIdle(P.page, 800);
      await P.page.keyboard.press('Escape');
    });

    await test('modos de selección: fantasma, aislar y resaltar (estados exactos y opacidad)', async () => {
      const pix = await findIfcPixel(P.page, { type: 'IFCWALL' });
      await P.page.mouse.click(pix.px, pix.py);
      await waitFor(async () => (await elementStates(P.page))[3] === 1, { timeout: 5000, label: 'seleccionado' });
      await P.page.click('.tool[data-tool="sel"]');
      await P.page.click('.seg__btn[data-value="isolate"]');
      await waitFor(async () => { const s = await elementStates(P.page); return s[2] === 19 && s[3] === 1; }, { timeout: 5000, label: 'aislar: 19 ocultos' });
      await P.page.click('.seg__btn[data-value="highlight"]');
      await waitFor(async () => { const s = await elementStates(P.page); return s[0] === 19 && s[3] === 1; }, { timeout: 5000, label: 'resaltar: 19 normales' });
      await P.page.click('.seg__btn[data-value="ghost"]');
      await waitFor(async () => { const s = await elementStates(P.page); return s[1] === 19 && s[3] === 1; }, { timeout: 5000, label: 'fantasma' });
      // La opacidad del fantasma llega al uniform del material
      await P.page.locator('.popover .range').evaluate((el) => { el.value = '0.4'; el.dispatchEvent(new Event('input', { bubbles: true })); });
      await waitFor(() => P.page.evaluate(() => Math.abs(window.__visor.ifc.getModels()[0].uniforms.uGhostOpacity.value - 0.4) < 1e-6), { timeout: 3000, label: 'uGhostOpacity' });
      await P.page.locator('.popover .range').evaluate((el) => { el.value = '0.12'; el.dispatchEvent(new Event('input', { bubbles: true })); });
      await P.page.keyboard.press('Escape');
      await P.page.keyboard.press('Escape');
    });

    await test('ocultar / aislar / mostrar todo (tarjeta y atajos H, I, Mayús+H) y categorías del dock', async () => {
      await waitFor(async () => (await getSlice(P.page, 'selection')).items.length >= 0, { timeout: 500 });
      if (!(await getSlice(P.page, 'selection')).items.length) {
        const pix = await findIfcPixel(P.page, { type: 'IFCWALL' });
        await P.page.mouse.click(pix.px, pix.py);
      }
      await waitFor(async () => (await elementStates(P.page))[3] === 1, { timeout: 5000, label: 'hay selección' });
      await P.page.click('.sel-act--orange'); // Ocultar
      await waitFor(async () => { const s = await elementStates(P.page); return s[2] === 1 && s[0] === 19; }, { timeout: 5000, label: 'uno oculto' });
      assert((await P.page.locator('.stat[data-stat="elements"]').textContent()).includes('1 oculto'), 'el resumen cuenta 1 oculto');
      await P.page.keyboard.press('Shift+H');
      await waitFor(async () => (await elementStates(P.page))[0] === 20, { timeout: 5000, label: 'mostrar todo' });
      const pix = await findIfcPixel(P.page, { type: 'IFCSLAB' }) || await findIfcPixel(P.page, { type: 'IFCWALL' });
      await P.page.mouse.click(pix.px, pix.py);
      await waitFor(async () => (await getSlice(P.page, 'selection')).items.length === 1, { timeout: 4000, label: 'selección' });
      await P.page.keyboard.press('i'); // aislar
      await waitFor(async () => { const s = await elementStates(P.page); return s[2] === 19; }, { timeout: 5000, label: 'aislado' });
      await P.page.keyboard.press('Shift+H');
      await waitFor(async () => { const s = await elementStates(P.page); return s[2] === 0 && s[3] === 1; }, { timeout: 5000, label: 'sin aislamiento (la selección sigue)' });
      await clearSelection(P.page);
      await waitFor(async () => (await elementStates(P.page))[0] === 20, { timeout: 5000, label: 'sin fantasmas' });
      // Categorías: ojo y aislar
      const cat = P.page.locator('.cat[data-type="IFCWALL"]');
      await cat.locator('.cat__eye').click();
      await waitFor(async () => (await elementStates(P.page))[2] === 8, { timeout: 5000, label: '8 muros ocultos' });
      await cat.locator('.cat__eye').click();
      await waitFor(async () => (await elementStates(P.page))[0] === 20, { timeout: 5000, label: 'muros visibles' });
      // Selección toda oculta (su categoría está apagada): el resto NO se transparenta
      const wallPix = await findIfcPixel(P.page, { type: 'IFCWALL' });
      await P.page.mouse.click(wallPix.px, wallPix.py);
      await waitFor(async () => { const s = await elementStates(P.page); return s[3] === 1 && s[1] === 19; }, { timeout: 5000, label: 'muro seleccionado' });
      await cat.locator('.cat__eye').click();
      await waitFor(async () => { const s = await elementStates(P.page); return s[2] === 8 && s[1] === 0 && s[3] === 0 && s[0] === 12; }, { timeout: 5000, label: 'selección oculta: el resto queda normal' });
      await cat.locator('.cat__eye').click();
      await waitFor(async () => { const s = await elementStates(P.page); return s[3] === 1 && s[1] === 19; }, { timeout: 5000, label: 'al mostrarla vuelve el fantasma' });
      await clearSelection(P.page);
      await waitFor(async () => (await elementStates(P.page))[0] === 20, { timeout: 5000, label: 'sin selección' });
      await cat.locator('.cat__main').click();
      await waitFor(async () => (await elementStates(P.page))[2] === 12, { timeout: 5000, label: 'categoría aislada' });
      await P.page.locator('.cat.is-isolated .cat__main').click();
      await waitFor(async () => (await elementStates(P.page))[0] === 20, { timeout: 5000, label: 'categoría restablecida' });
    });

    await test('buscador: encuentra por nombre, tipo y GlobalId, y selecciona el resultado', async () => {
      await P.page.fill('.search__input', 'ventana nivel 2');
      await waitFor(() => P.page.locator('.search-results .result').count().then((n) => n >= 1), { timeout: 4000, label: 'resultados' });
      assert((await P.page.locator('.search-results .result').first().textContent()).includes('Ventana'), 'primer resultado');
      await P.page.locator('.search-results .result').first().click();
      await waitFor(async () => (await getSlice(P.page, 'selection')).items.length === 1, { timeout: 4000, label: 'resultado seleccionado' });
      const gid = await P.page.evaluate(() => { const v = window.__visor; const it = v.store.get('selection').items[0]; return v.ifc.getElementInfo(it.modelId, it.expressId).globalId; });
      await P.page.fill('.search__input', gid);
      await waitFor(() => P.page.locator('.search-results .result').count().then((n) => n === 1), { timeout: 4000, label: 'resultado por GlobalId' });
      await P.page.fill('.search__input', '');
      await P.page.keyboard.press('Escape');
      await clearSelection(P.page);
      await waitIdle(P.page, 700);
    });

    // ------------------------------------------------------------------ niveles
    await test('selector de nivel: corte de planta (plano horizontal) y modo "solo", con elementos ocultos exactos', async () => {
      await clearSelection(P.page);
      await P.page.click('.level__step[aria-label="Subir un nivel"]');
      let st = await getSlice(P.page, 'storey');
      assert(st.active && st.mode === 'cut', 'nivel 1 en modo corte');
      await waitFor(async () => (await elementStates(P.page))[2] === 10, { timeout: 5000, label: '10 elementos superiores ocultos' });
      const plane = await P.page.evaluate(() => window.__visor.viewer.getClippingPlanes().map((p) => [p.normal.toArray(), p.constant]));
      assert(plane.length === 1 && plane[0][0][1] === -1, 'un plano horizontal hacia abajo');
      near(plane[0][1], 0 + 1.2, 0.01, 'altura del plano de corte (cota 0 + 1,2 m)');
      assert((await P.page.locator('.level__num').textContent()).trim() === '01', 'número 01');
      await waitFor(() => P.page.locator('.level__thumb-img').isVisible(), { timeout: 5000, label: 'miniatura en planta' });
      await shot(P.page, '04-nivel-corte');
      await P.page.click('.level__step[aria-label="Subir un nivel"]');
      await waitFor(async () => (await getSlice(P.page, 'storey')).active?.expressId !== st.active.expressId, { timeout: 4000, label: 'nivel 2' });
      await waitFor(async () => (await elementStates(P.page))[2] === 0, { timeout: 5000, label: 'nivel 2: nada superior' });
      const plane2 = await P.page.evaluate(() => window.__visor.viewer.getClippingPlanes().map((p) => p.constant));
      near(plane2[0], 3 + 1.2, 0.01, 'plano de corte del nivel 2');
      await P.page.click('.seg--sm .seg__btn[data-value="only"]');
      await waitFor(async () => (await elementStates(P.page))[2] === 10, { timeout: 5000, label: 'solo nivel 2: 10 ocultos' });
      assert((await P.page.evaluate(() => window.__visor.viewer.getClippingPlanes().length)) === 0, 'en modo solo no hay plano de corte');
      await P.page.click('.seg--sm .seg__btn[data-value="cut"]');
      await P.page.click('.level__name');
      await P.page.locator('.level-list__item', { hasText: 'Todos los niveles' }).click();
      await waitFor(async () => (await elementStates(P.page))[0] === 20, { timeout: 5000, label: 'todos los niveles' });
      await waitFor(() => P.page.evaluate(() => window.__visor.viewer.getClippingPlanes().length === 0), { timeout: 3000, label: 'sin planos al volver a todos' });
    });

    // ------------------------------------------------------------------ sección
    await test('caja de sección: activa con la caja del modelo, recorta con los deslizadores y toma la selección', async () => {
      await clearSelection(P.page);
      await P.page.click('.tool[data-tool="section"]');
      await waitFor(async () => { const s = await getSlice(P.page, 'section'); return s.enabled && s.max[0] > s.min[0]; }, { timeout: 5000, label: 'caja inicial' });
      assert((await P.page.evaluate(() => window.__visor.viewer.getClippingPlanes().length)) === 6, 'seis planos');
      const s0 = await getSlice(P.page, 'section');
      const box = await P.page.evaluate(() => { const b = window.__visor.ifc.getModelBox(window.__visor.ifc.getModels()[0].id); return { min: b.min.toArray(), max: b.max.toArray() }; });
      assert(s0.min[0] <= box.min[0] + 1e-6 && s0.max[0] >= box.max[0] - 1e-6 && s0.min[1] <= box.min[1] + 1e-6 && s0.max[1] >= box.max[1] - 1e-6, 'la caja inicial contiene el modelo');
      // Recorta la altura a la mitad: los elementos por encima quedan recortados en el picking
      await P.page.locator('.section-panel .axis-row').nth(1).locator('.dual__in--max').evaluate((el) => {
        el.value = String(Number(el.min) + (Number(el.max) - Number(el.min)) * 0.5);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      });
      const s1 = await waitFor(async () => { const s = await getSlice(P.page, 'section'); return s.max[1] < s0.max[1] - 0.5 && s; }, { timeout: 4000, label: 'sección recortada' });
      await waitIdle(P.page, 500);
      const hit = await P.page.evaluate((maxY) => {
        const v = window.__visor;
        const r = v.viewer.canvas.getBoundingClientRect();
        let above = 0;
        for (let py = 170; py < 560; py += 10) for (let px = 430; px < 1100; px += 10) {
          const h = v.viewer.pick({ x: ((px - r.left) / r.width) * 2 - 1, y: -(((py - r.top) / r.height) * 2 - 1) }, { kinds: ['ifc'] });
          if (h && h.point.y > maxY + 0.02) above++;
        }
        return above;
      }, s1.max[1]);
      assert(hit === 0, `el picking devolvió ${hit} impactos por encima del plano de sección`);
      await shot(P.page, '05-seccion');
      // "A la selección": la caja se ajusta al elemento seleccionado
      const pix = await findIfcPixel(P.page, { type: 'IFCWALL' });
      await P.page.mouse.click(pix.px, pix.py);
      await waitFor(async () => (await getSlice(P.page, 'selection')).items.length === 1, { timeout: 4000, label: 'selección para la sección' });
      await P.page.click('.section-panel button:has-text("A la selección")');
      const s2 = await waitFor(async () => { const s = await getSlice(P.page, 'section'); return s.max[0] - s.min[0] < (s0.max[0] - s0.min[0]) * 0.99 && s; }, { timeout: 4000, label: 'caja ajustada a la selección' });
      const eb = await P.page.evaluate((it) => { const b = window.__visor.ifc.getBoxOf([it]); return { min: b.min.toArray(), max: b.max.toArray() }; }, { modelId: pix.modelId, expressId: pix.expressId });
      assert(s2.min[0] <= eb.min[0] + 1e-3 && s2.max[0] >= eb.max[0] - 1e-3, 'la caja contiene el elemento');
      await P.page.click('.section-panel button:has-text("Restablecer")');
      await P.page.click('.tool[data-tool="section"]');
      await waitFor(async () => !(await getSlice(P.page, 'section')).enabled, { timeout: 4000, label: 'sección apagada' });
      assert((await P.page.evaluate(() => window.__visor.viewer.getClippingPlanes().length)) === 0, 'sin planos');
      await clearSelection(P.page);
    });

    // ------------------------------------------------------------------ medición
    await test('medición: dos puntos dan la distancia (m) y Δz; se borra con × y con "Borrar todo"; Esc cancela', async () => {
      await clearSelection(P.page);
      await waitIdle(P.page, 600);
      await P.page.keyboard.press('m');
      assert((await getSlice(P.page, 'measure')).active, 'M activa la medición');
      // En modo medir los clics no seleccionan
      // Puntos en la parte central del visor: la etiqueta (y su ×) no debe quedar bajo los chips de la cabecera
      const a = await findIfcPixel(P.page, { y0: 260, y1: 560 });
      const b = await findIfcPixel(P.page, { y0: 260, y1: 560, far: { px: a.px, py: a.py, minDist: 150 } });
      assert(a && b, 'no hay dos puntos del modelo alejados para medir');
      await P.page.mouse.click(a.px, a.py);
      await P.page.mouse.move((a.px + b.px) / 2, (a.py + b.py) / 2, { steps: 3 });
      await P.page.keyboard.press('Escape'); // cancela el punto en curso
      assert((await getSlice(P.page, 'measure')).items.length === 0, 'Esc cancela el punto sin crear medición');
      assert((await getSlice(P.page, 'measure')).active, 'sigue en modo medición tras cancelar el punto');
      await P.page.mouse.click(a.px, a.py);
      await P.page.mouse.click(b.px, b.py);
      await waitFor(async () => (await getSlice(P.page, 'measure')).items.length === 1, { timeout: 4000, label: 'medición creada' });
      assert((await getSlice(P.page, 'selection')).items.length === 0, 'medir no selecciona');
      const m = (await getSlice(P.page, 'measure')).items[0];
      const d = Math.hypot(m.a[0] - m.b[0], m.a[1] - m.b[1], m.a[2] - m.b[2]);
      const LABEL = '.measure-label:not(.measure-label--preview)';
      await waitFor(() => P.page.locator('.measure-label--preview').first().isHidden(), { timeout: 3000, label: 'la etiqueta elástica se oculta al crear la medición' });
      const label = (await P.page.locator(`${LABEL} .measure-label__dist`).first().textContent()).trim();
      assert(label === `${d.toFixed(3)} m`, `etiqueta "${label}" vs distancia calculada ${d.toFixed(3)} m`);
      assert((await P.page.locator(`${LABEL} .measure-label__dz`).first().textContent()).includes('Δz'), 'etiqueta Δz');
      await P.page.keyboard.press('Escape'); // sin punto pendiente: sale del modo medición
      await waitFor(async () => !(await getSlice(P.page, 'measure')).active, { timeout: 3000, label: 'sale del modo medir' });
      await shot(P.page, '06-medicion');
      await P.page.locator(`${LABEL} .measure-label__del`).first().click();
      await waitFor(async () => (await getSlice(P.page, 'measure')).items.length === 0, { timeout: 3000, label: 'medición borrada con ×' });
      // Dos mediciones y "Borrar todo"
      await P.page.evaluate(() => { const v = window.__visor; v.actions.addMeasure([0, 0, 0], [3, 0, 0]); v.actions.addMeasure([0, 1, 0], [0, 1, -4]); });
      await waitFor(() => P.page.locator(`${LABEL} .measure-label__dist`).count().then((n) => n === 2), { timeout: 3000, label: 'dos etiquetas' });
      const texts = (await P.page.locator(`${LABEL} .measure-label__dist`).allTextContents()).map((t) => t.trim()).sort();
      assert(texts[0] === '3.000 m' && texts[1] === '4.000 m', `etiquetas: ${texts}`);
      await P.page.click('button:has-text("Borrar todo")');
      await waitFor(async () => (await getSlice(P.page, 'measure')).items.length === 0, { timeout: 3000, label: 'borrar todo' });
    });

    // ------------------------------------------------------------------ vistas
    await test('vistas guardadas: guardar (miniatura), cambiar el estado, restaurar y borrar', async () => {
      const pix = await findIfcPixel(P.page, { type: 'IFCWALL' });
      await P.page.mouse.click(pix.px, pix.py);
      await waitFor(async () => (await getSlice(P.page, 'selection')).items.length === 1, { timeout: 4000, label: 'selección' });
      await P.page.click('.level__step[aria-label="Subir un nivel"]');
      await waitIdle(P.page, 600);
      const camA = await cam(P.page);
      const selA = (await getSlice(P.page, 'selection')).items;
      const stA = (await getSlice(P.page, 'storey')).active;
      await P.page.click('.pill[data-tab="views"]');
      await P.page.fill('.views-form input', 'Vista A');
      await P.page.click('.views-form .btn--primary');
      await waitFor(async () => (await getSlice(P.page, 'views')).items.length === 1, { timeout: 4000, label: 'vista guardada' });
      const view = (await getSlice(P.page, 'views')).items[0];
      assert(view.thumb?.startsWith('data:image'), 'la vista lleva miniatura');
      assert(await P.page.locator('.thumb.has-image').count() === 1, 'miniatura en la esquina');
      // Cambia todo: selección, nivel y cámara
      await P.page.click('.level__name');
      await P.page.locator('.level-list__item', { hasText: 'Todos los niveles' }).click();
      await P.page.keyboard.press('Escape');
      await P.page.click('.zoom button[aria-label="Alejar"]');
      await P.page.click('.zoom button[aria-label="Alejar"]');
      await waitIdle(P.page, 600);
      assert(cameraDistance(camA, await cam(P.page)) > 0.3, 'la cámara cambió');
      await P.page.locator('.view__open').first().click();
      await waitFor(async () => JSON.stringify((await getSlice(P.page, 'selection')).items) === JSON.stringify(selA), { timeout: 5000, label: 'selección restaurada' });
      assert((await getSlice(P.page, 'storey')).active?.expressId === stA.expressId, 'nivel restaurado');
      await waitFor(async () => cameraDistance(camA, await cam(P.page)) < 0.05, { timeout: 6000, label: 'cámara restaurada' });
      await P.page.locator('.view button[aria-label="Borrar esta vista"], .view button[title="Borrar esta vista"]').first().click();
      await waitFor(async () => (await getSlice(P.page, 'views')).items.length === 0, { timeout: 3000, label: 'vista borrada' });
      await P.page.click('.level__name');
      await P.page.locator('.level-list__item', { hasText: 'Todos los niveles' }).click();
      await P.page.keyboard.press('Escape');
      await P.page.click('.pill[data-tab="models"]');
    });

    await test('proyección: planta (ortogonal, vista cenital con el norte arriba) y vuelta a 3D; captura descargable', async () => {
      await P.page.click('.tool[data-tool="proj"]');
      await waitFor(async () => (await cam(P.page)).projection === 'orthographic', { timeout: 6000, label: 'ortogonal' });
      await waitIdle(P.page, 800);
      const c = await cam(P.page);
      assert(c.position[1] > c.target[1] + 1 && Math.abs(c.position[0] - c.target[0]) < 0.1, 'vista cenital');
      // En planta todo el modelo cabe en la zona libre: ninguna esquina queda bajo la barra lateral ni el dock
      const corners = await P.page.evaluate(() => {
        const v = window.__visor;
        const b = v.ifc.getModelBox(v.ifc.getModels()[0].id);
        const r = v.viewer.canvas.getBoundingClientRect();
        const ins = v.viewer.getFitInsets();
        const out = [];
        for (let i = 0; i < 8; i++) {
          const p = new b.min.constructor(i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z).project(v.viewer.camera);
          out.push({ x: r.left + ((p.x + 1) / 2) * r.width, y: r.top + ((1 - p.y) / 2) * r.height });
        }
        return { out, free: { x0: r.left + ins.left, x1: r.right - ins.right, y0: r.top + ins.top, y1: r.bottom - ins.bottom } };
      });
      for (const c of corners.out) {
        assert(c.x >= corners.free.x0 - 2 && c.x <= corners.free.x1 + 2 && c.y >= corners.free.y0 - 2 && c.y <= corners.free.y1 + 2,
          `esquina (${c.x.toFixed(0)}, ${c.y.toFixed(0)}) fuera de la zona libre ${JSON.stringify(corners.free)}`);
      }
      await shot(P.page, '07-planta');
      const [download] = await Promise.all([P.page.waitForEvent('download', { timeout: 15000 }), P.page.click('.tool[data-tool="shot"]')]);
      assert(/^visor-ifc-5d_\d{8}-\d{6}\.jpg$/.test(download.suggestedFilename()), `nombre de captura: ${download.suggestedFilename()}`);
      const file = await download.path();
      assert(fs.statSync(file).size > 5000, 'la captura no está vacía');
      await P.page.click('.tool[data-tool="proj"]');
      await waitFor(async () => (await cam(P.page)).projection === 'perspective', { timeout: 6000, label: 'perspectiva' });
      await waitIdle(P.page, 800);
    });

    await test('zoom, cruceta de órbita y teclado mueven la cámara real', async () => {
      const c0 = await cam(P.page);
      await P.page.click('.zoom button[aria-label="Acercar"]');
      await waitIdle(P.page, 500);
      const c1 = await cam(P.page);
      const dist = (c) => Math.hypot(...c.position.map((v, i) => v - c.target[i]));
      assert(dist(c1) < dist(c0) - 0.1, 'acercar reduce la distancia');
      await P.page.click('.orbit__left');
      await waitIdle(P.page, 500);
      assert(cameraDistance(c1, await cam(P.page)) > 0.1, 'la cruceta orbita');
    });

    // ------------------------------------------------------------------ georreferencia
    await test('GEORREFERENCIA: IFC4 (IfcMapConversion) + IFC2x3 (IfcSite en UTM) + DXF quedan alineados numéricamente', async () => {
      await P.page.locator('input[type=file]').first().setInputFiles([path.join(FIXTURES, 'edificio_site_ifc2x3.ifc'), path.join(FIXTURES, 'planta_georef.dxf')]);
      await waitForApp(P.page, { ifc: 2, cad: 1 });
      await waitIdle(P.page, 500);
      const fx = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'fixtures.json'), 'utf8'));
      const sb = await sceneBoxes(P.page);
      const a = sb.ifc['edificio_georef_ifc4.ifc'];
      const b = sb.ifc['edificio_site_ifc2x3.ifc'];
      const cad = sb.cad['planta_georef.dxf'];
      assert(a && b && cad, 'faltan modelos');
      // 1) Fuentes de georreferencia
      assert(a.georef.source === 'mapconversion' && a.georef.crs === 'EPSG:32718', `IFC4: ${a.georef.source} ${a.georef.crs}`);
      assert(b.georef.source === 'site', `IFC2x3: ${b.georef.source}`);
      near(a.georef.rotationDeg, fx.rotationDeg, 1e-6, 'rotación IfcMapConversion');
      // 2) Cajas de escena de ambos IFC coinciden (≤ 2 cm) en los tres ejes
      const dBox = boxDiff(a.box, b.box);
      assert(dBox <= 0.02, `cajas de los dos IFC difieren ${(dBox * 100).toFixed(2)} cm`);
      const dWalls = boxDiff(a.walls, b.walls);
      assert(dWalls <= 0.02, `cajas de los muros de los dos IFC difieren ${(dWalls * 100).toFixed(2)} cm`);
      assert(a.nWalls === 8 && b.nWalls === 8, 'ocho muros en cada IFC');
      // 3) La capa MUROS del DXF coincide en XZ con los muros IFC (≤ 2 cm)
      assert(cad.muros, 'el DXF no tiene la capa MUROS');
      const dCad = boxDiff(cad.muros, a.walls, [0, 2]);
      assert(dCad <= 0.02, `la capa MUROS difiere de los muros IFC ${(dCad * 100).toFixed(2)} cm en planta`);
      const dCad2 = boxDiff(cad.muros, b.walls, [0, 2]);
      assert(dCad2 <= 0.02, `la capa MUROS difiere de los muros del IFC2x3 ${(dCad2 * 100).toFixed(2)} cm en planta`);
      // 4) Contra las coordenadas de mapa de fixtures.json (esquinas exteriores del edificio)
      const o = sb.origin;
      const xs = Object.values(fx.buildingCornersMap).map(([e]) => e - o.e);
      const zs = Object.values(fx.buildingCornersMap).map(([, n]) => -(n - o.n));
      const expected = { min: [Math.min(...xs), 0, Math.min(...zs)], max: [Math.max(...xs), 0, Math.max(...zs)] };
      assert(boxDiff(a.walls, expected, [0, 2]) <= 0.02, `huella IFC4 vs esquinas de mapa de fixtures.json: ${(boxDiff(a.walls, expected, [0, 2]) * 100).toFixed(2)} cm`);
      assert(boxDiff(cad.muros, expected, [0, 2]) <= 0.02, `huella DXF vs esquinas de mapa de fixtures.json: ${(boxDiff(cad.muros, expected, [0, 2]) * 100).toFixed(2)} cm`);
      // 5) Cota automática del DXF = nivel más bajo del IFC + 0,02
      const lowest = Math.min(...sb.storeys.map((s) => s.mapHeight));
      near(lowest, fx.orthogonalHeight, 1e-6, 'nivel más bajo del IFC');
      near(sb.baseElevation, lowest, 1e-6, 'ifc.getBaseElevation()');
      near(cad.elevation, lowest + 0.02, 1e-6, 'cota automática del DXF');
      near(cad.groupY, cad.elevation - o.h, 1e-6, 'posición Y de la capa en la escena');
      assert(cad.georeferenced === true, 'el DXF debe ser georreferenciado');
      assert(Math.abs(a.box.min[1] + 0.2) < 0.02, 'la losa del nivel 1 llega a -0,20 m bajo la cota del nivel');
      await shot(P.page, '08-georef-tres-modelos');
      assert(P.errors.length === 0, P.errors.join(' | '));
    });

    await test('niveles federados: los dos IFC se agrupan en 2 niveles y "solo"/corte actúan sobre ambos', async () => {
      await clearSelection(P.page);
      assert((await P.page.locator('.stat[data-stat="storeys"] .stat__value').textContent()).trim() === '2', 'el dock cuenta 2 niveles (no 4)');
      await P.page.click('.level__step[aria-label="Subir un nivel"]');
      await waitFor(async () => (await elementStates(P.page))[2] === 20, { timeout: 6000, label: 'los dos IFC ocultan sus 10 elementos del nivel 2' });
      await P.page.click('.level__step[aria-label="Subir un nivel"]');
      await P.page.click('.seg--sm .seg__btn[data-value="only"]');
      await waitFor(async () => (await elementStates(P.page))[2] === 20, { timeout: 6000, label: 'solo nivel 2 en ambos IFC' });
      await P.page.click('.seg--sm .seg__btn[data-value="cut"]');
      await P.page.click('.level__name');
      await P.page.locator('.level-list__item', { hasText: 'Todos los niveles' }).click();
      await waitFor(async () => (await elementStates(P.page))[0] === 40, { timeout: 5000, label: 'todos los niveles' });
    });

    await test('capas CAD: ocultar la capa MUROS la quita del encuadre y del render; cota manual mueve el plano', async () => {
      await P.page.click('.pill[data-tab="layers"]');
      await P.page.waitForSelector('.layer');
      assert((await P.page.locator('.layer').count()) === 6, 'seis capas con geometría');
      const vis = () => P.page.evaluate(() => window.__visor.cad.getModels()[0].layerObjects.get('MUROS').every((o) => o.visible));
      assert(await vis(), 'MUROS visible');
      await P.page.locator('.layer', { hasText: 'MUROS' }).locator('.layer__eye').click();
      await waitFor(async () => !(await vis()), { timeout: 3000, label: 'MUROS oculta' });
      assert((await getSlice(P.page, 'cad'))[(await sceneBoxes(P.page)).cad['planta_georef.dxf'].id].hiddenLayers.includes('MUROS'), 'store.cad hiddenLayers');
      await P.page.locator('.layer', { hasText: 'MUROS' }).locator('.layer__eye').click();
      await waitFor(vis, { timeout: 3000, label: 'MUROS visible otra vez' });
      // Cota manual
      await P.page.click('.lmodel__elev .seg__btn[data-value="manual"]');
      await P.page.fill('.lmodel__elev input[type=number]', '151.5');
      await P.page.press('.lmodel__elev input[type=number]', 'Enter');
      const cadId = (await sceneBoxes(P.page)).cad['planta_georef.dxf'].id;
      await waitFor(async () => Math.abs((await sceneBoxes(P.page)).cad['planta_georef.dxf'].elevation - 151.5) < 1e-6, { timeout: 4000, label: 'cota manual' });
      near((await sceneBoxes(P.page)).cad['planta_georef.dxf'].groupY, 1.5, 1e-6, 'Y de la capa con cota manual');
      await P.page.click('.lmodel__elev .seg__btn[data-value="auto"]');
      await waitFor(async () => Math.abs((await sceneBoxes(P.page)).cad['planta_georef.dxf'].elevation - 150.02) < 1e-6, { timeout: 4000, label: 'cota automática' });
      assert((await getSlice(P.page, 'cad'))[cadId].elevation === null, 'cota automática = null');
      await shot(P.page, '09-capas-cad');
    });

    await test('georreferencia manual desde la UI: PATCH al servidor, el modelo se reubica sin recargar y se restablece', async () => {
      await P.page.click('.pill[data-tab="models"]');
      const before = (await sceneBoxes(P.page)).ifc['edificio_site_ifc2x3.ifc'].box;
      const card = P.page.locator('.model', { hasText: 'edificio_georef_ifc4.ifc' });
      await card.locator('button[aria-label="Configurar la georreferencia"]').click();
      await P.page.waitForSelector('.modal');
      assert((await P.page.locator('.detected').textContent()).includes('EPSG:32718'), 'muestra la georreferencia detectada');
      const loadedBefore = await P.page.evaluate(() => window.__visor.ifc.getModels().find((m) => m.record.name === 'edificio_georef_ifc4.ifc').group.uuid);
      const grid = '.modal .form-grid label';
      await P.page.fill(`${grid}:nth-child(1) input`, '279510');
      await P.page.fill(`${grid}:nth-child(2) input`, '8661010');
      await P.page.fill(`${grid}:nth-child(3) input`, '152');
      await P.page.fill(`${grid}:nth-child(4) input`, '15');
      await P.page.fill(`${grid}:nth-child(5) input`, '1');
      await P.page.click('.modal button:has-text("Guardar")');
      await waitFor(async () => (await getSlice(P.page, 'modelRecords')).find((r) => r.name === 'edificio_georef_ifc4.ifc')?.georef?.eastings === 279510, { timeout: 8000, label: 'registro con georef manual' });
      await waitFor(async () => (await sceneBoxes(P.page)).ifc['edificio_georef_ifc4.ifc'].georef.source === 'manual', { timeout: 6000, label: 'georef manual aplicada' });
      const sb = await sceneBoxes(P.page);
      const a = sb.ifc['edificio_georef_ifc4.ifc'];
      near(a.georef.eastings, 279510, 1e-6, 'Este manual');
      assert(Math.abs(a.walls.min[0] - sb.ifc['edificio_site_ifc2x3.ifc'].walls.min[0] - 10) < 0.05, 'el IFC4 se desplazó 10 m al este');
      const same = await P.page.evaluate(() => window.__visor.ifc.getModels().find((m) => m.record.name === 'edificio_georef_ifc4.ifc').group.uuid);
      assert(same === loadedBefore, 'el modelo no se recargó (mismo grupo)');
      assert(JSON.stringify(sb.ifc['edificio_site_ifc2x3.ifc'].box) === JSON.stringify(before), 'el otro IFC no se movió');
      // Restablecer
      await card.locator('button[aria-label="Configurar la georreferencia"]').click();
      await P.page.waitForSelector('.modal');
      await P.page.click('.modal button:has-text("Restablecer")');
      await waitFor(async () => (await getSlice(P.page, 'modelRecords')).find((r) => r.name === 'edificio_georef_ifc4.ifc')?.georef === null, { timeout: 8000, label: 'registro sin georef manual' });
      await waitFor(async () => { const s = await sceneBoxes(P.page); return boxDiff(s.ifc['edificio_georef_ifc4.ifc'].walls, s.ifc['edificio_site_ifc2x3.ifc'].walls) <= 0.02; }, { timeout: 6000, label: 'IFC4 vuelve a alinearse' });
      assert((await P.page.locator('.modal').count()) === 0, 'el diálogo se cierra');
    });

    await test('unidades CAD desde la UI: cambiar a "cm" recarga el plano reducido por 100 y volver a "auto" lo restituye', async () => {
      const dxf = P.page.locator('.model', { hasText: 'planta_georef.dxf' });
      const ext = () => P.page.evaluate(() => { const m = window.__visor.cad.getModels()[0]; return { w: m.extents.max.e - m.extents.min.e, units: m.units }; });
      const w0 = (await ext()).w;
      await dxf.locator('button[aria-label="Configurar unidades y cota del plano"]').click();
      await P.page.waitForSelector('.modal');
      await P.page.selectOption('.modal select', 'cm');
      await P.page.click('.modal button:has-text("Guardar")');
      await waitFor(async () => { const e = await ext(); return e.units === 'cm' && Math.abs(e.w - w0 / 100) < 1e-6 * w0; }, { timeout: 12000, label: 'plano en cm' });
      await dxf.locator('button[aria-label="Configurar unidades y cota del plano"]').click();
      await P.page.waitForSelector('.modal');
      await P.page.selectOption('.modal select', 'auto');
      await P.page.click('.modal button:has-text("Guardar")');
      await waitFor(async () => { const e = await ext(); return e.units === 'm' && Math.abs(e.w - w0) < 1e-6; }, { timeout: 12000, label: 'plano en m otra vez' });
      await waitForApp(P.page, { ifc: 2, cad: 1 });
    });

    await test('otros formatos: DXF real (example_2000.dxf) y DWG (example_2018.dwg) cargan sin errores', async () => {
      await P.page.locator('input[type=file]').first().setInputFiles([path.join(FIXTURES, 'downloads', 'example_2018.dwg'), path.join(FIXTURES, 'downloads', 'example_2000.dxf')]);
      await waitForApp(P.page, { ifc: 2, cad: 3 });
      const info = await P.page.evaluate(() => window.__visor.cad.getModels().map((m) => ({ name: m.name, kind: m.kind, layers: m.layers.length, box: m.extents })));
      assert(info.some((m) => m.kind === 'dwg' && m.layers > 3), 'DWG con capas');
      assert(info.some((m) => m.name === 'example_2000.dxf' && m.layers > 3), 'DXF real con capas');
      assert(P.errors.length === 0, P.errors.join(' | '));
      // Descargar un plano: borra el registro, libera el modelo y los demás siguen en su sitio
      const card = P.page.locator('.model', { hasText: 'example_2000.dxf' });
      await card.locator('button[aria-label="Eliminar el modelo"]').click();
      await P.page.waitForSelector('.modal');
      await P.page.click('.modal button:has-text("Eliminar")');
      await waitFor(async () => (await getSlice(P.page, 'modelRecords')).length === 5, { timeout: 8000, label: 'registro eliminado' });
      await waitForApp(P.page, { ifc: 2, cad: 2 });
      await shot(P.page, '10-varios-planos');
    });

    // ------------------------------------------------------------------ persistencia
    await test('al recargar la página los modelos del servidor se cargan solos y la georreferencia se conserva', async () => {
      await P.page.reload();
      await waitForApp(P.page, { ifc: 2, cad: 2 });
      await waitIdle(P.page, 600);
      const sb = await sceneBoxes(P.page);
      assert(boxDiff(sb.ifc['edificio_georef_ifc4.ifc'].walls, sb.ifc['edificio_site_ifc2x3.ifc'].walls) <= 0.02, 'IFC alineados tras recargar');
      assert(boxDiff(sb.cad['planta_georef.dxf'].muros, sb.ifc['edificio_georef_ifc4.ifc'].walls, [0, 2]) <= 0.02, 'DXF alineado tras recargar');
    });

    await test('el servidor sirve los archivos subidos íntegros y con Content-Length', async () => {
      const before = await (await fetch(`${server.url}/api/models`)).json();
      assert(before.length === 4, `registros antes: ${before.length}`);
      for (const r of before) {
        const res = await fetch(`${server.url}/api/models/${r.id}/file`);
        assert(res.ok && Number(res.headers.get('content-length')) === r.size, `descarga de ${r.name}`);
      }
    });

    // ------------------------------------------------------------------ AC20-FZK-Haus real
    await test('IFC real AC20-FZK-Haus.ifc (sin georreferencia): carga, selecciona, corta y mide sin errores', async () => {
      const s2 = await startServer({ port: PORT + 1 });
      extra.push(s2);
      const F = await open(browser, 'fzk', s2.url);
      await F.page.waitForFunction(() => document.documentElement.dataset.ready === 'true', null, { timeout: 30000 });
      await F.page.locator('input[type=file]').first().setInputFiles(path.join(FIXTURES, 'downloads', 'AC20-FZK-Haus.ifc'));
      await waitForApp(F.page, { ifc: 1, cad: 0 });
      await waitIdle(F.page, 800);
      const info = await F.page.evaluate(() => {
        const v = window.__visor;
        return { types: v.ifc.getTypeSummary().map((t) => `${t.label}:${t.count}`), proj: v.ifc.getProjectInfo(), storeys: v.ifc.getStoreys().length, georef: v.ifc.getGeorefInfo(v.ifc.getModels()[0].id).source };
      });
      assert(info.types.length >= 5 && info.storeys >= 2, `FZK: ${info.types.length} categorías, ${info.storeys} niveles`);
      const pix = await findIfcPixel(F.page, { type: 'IFCWALL' }) || await findIfcPixel(F.page);
      await F.page.mouse.click(pix.px, pix.py);
      await waitFor(async () => { const s = await elementStates(F.page); return s[3] >= 1 && s[1] > 10; }, { timeout: 8000, label: 'FZK: selección + fantasma' });
      await F.page.mouse.move(5, 5);
      await waitIdle(F.page, 700);
      await shot(F.page, '11-fzk-seleccion-fantasma');
      await F.page.click('.level__step[aria-label="Subir un nivel"]');
      await waitFor(async () => (await getSlice(F.page, 'storey')).active, { timeout: 4000, label: 'FZK: nivel' });
      await F.page.click('.tool[data-tool="section"]');
      await waitFor(async () => (await getSlice(F.page, 'section')).enabled, { timeout: 4000, label: 'FZK: sección' });
      await F.page.click('.tool[data-tool="section"]');
      await shot(F.page, '11-fzk-haus');
      assert(F.errors.length === 0, F.errors.join(' | '));
      await F.context.close();
    });

    // ------------------------------------------------------------------ PIN
    await test('PIN de presentador: otra PC de la red entra como presentador con el PIN desde la UI', async () => {
      const lan = lanIp();
      if (!lan) return console.log('       (sin IP de red: se omite)');
      const s3 = await startServer({ port: PORT + 2, env: { PRESENTER_PIN: '4321' } });
      extra.push(s3);
      await uploadFixture(s3.url, 'edificio_georef_ifc4.ifc');
      const R = await open(browser, 'otra-pc', `http://${lan}:${PORT + 2}`);
      await waitForApp(R.page, { ifc: 1, cad: 0 });
      assert((await getSlice(R.page, 'presentation')).role === 'viewer', 'sin PIN es espectador');
      assert(await R.page.locator('.btn--present').count() === 0, 'sin PIN no ve el botón Presentar');
      await R.page.click('.sidebar__icon[aria-label^="Conexión"]');
      await R.page.fill('input[aria-label="PIN de presentador"]', '0000');
      await R.page.press('input[aria-label="PIN de presentador"]', 'Enter');
      await waitFor(() => R.page.locator('.toast', { hasText: 'PIN incorrecto' }).count().then((n) => n >= 1), { timeout: 5000, label: 'aviso de PIN incorrecto' });
      assert((await getSlice(R.page, 'presentation')).role === 'viewer', 'con PIN erróneo sigue siendo espectador');
      await R.page.fill('input[aria-label="PIN de presentador"]', '4321');
      const nav = R.page.waitForNavigation({ timeout: 10000 }).catch(() => null);
      await R.page.press('input[aria-label="PIN de presentador"]', 'Enter');
      await nav;
      await waitForApp(R.page, { ifc: 1, cad: 0 });
      await waitFor(async () => (await getSlice(R.page, 'presentation')).role === 'presenter' && (await getSlice(R.page, 'presentation')).connected, { timeout: 10000, label: 'rol presentador por PIN' });
      await R.page.click('.btn--present');
      await waitFor(async () => (await getSlice(R.page, 'presentation')).isActivePresenter, { timeout: 5000, label: 'presenta con PIN' });
      // El anfitrión (loopback) ve la presentación de la otra PC y puede tomar el control
      const H = await open(browser, 'anfitrion', s3.url);
      await waitForApp(H.page, { ifc: 1, cad: 0 });
      await waitFor(async () => (await getSlice(H.page, 'presentation')).active, { timeout: 6000, label: 'anfitrión ve la presentación' });
      assert(await H.page.locator('.lock-layer').isVisible(), 'el anfitrión queda bloqueado mientras otro presenta');
      await H.context.close();
      await R.context.close();
    });

    await test('sin errores de consola ni de página en el flujo del presentador', async () => {
      const lines = [];
      for (const h of handles) for (const e of h.errors) lines.push(`[${h.name}] ${e}`);
      assert(lines.length === 0, lines.slice(0, 8).join(' | '));
    });
  } finally {
    await browser.close().catch(() => {});
    for (const s of extra) await s.stop().catch(() => {});
    await server.stop().catch(() => {});
  }
}

try {
  await run();
} catch (err) {
  console.error('Error fatal en las pruebas:', err);
  results.push({ name: 'ejecución', ok: false, err });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} pruebas correctas`);
if (failed.length) {
  console.log('Fallos:');
  for (const f of failed) console.log(` - ${f.name}: ${f.err?.message}`);
}
process.exit(failed.length ? 1 : 0);
