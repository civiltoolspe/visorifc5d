// Prueba E2E multi-cliente del modo presentación con el servidor REAL (server/index.js).
//
//   - presentador: Chromium en http://127.0.0.1:PUERTO (loopback => rol presenter)
//   - espectador 1: http://127.0.0.1:PUERTO/?role=viewer (el anfitrión previsualiza a un espectador)
//   - espectador 2: http://<IP de red>:PUERTO (espectador REAL: la IP del socket no es loopback)
//
// Cubre: roles, navegación libre sin presentación, EN VIVO + capa de bloqueo, que el espectador no
// pueda cambiar nada (clic, rueda, arrastre, teclado), réplica de cámara, selección, pestaña, nivel,
// sección, mediciones, visibilidad y proyección, puntero láser, espectador que entra a mitad, modelos
// subidos por el presentador, tomar el control, fin de la presentación y "Esperando al presentador".
//
// Uso: node tests/e2e/presentation.test.mjs   (UI_PRESENTATION_PORT cambia el puerto; 8210 por defecto)

import path from 'node:path';
import {
  startServer, launchBrowser, openPage, uploadFixture, assert, waitFor, getSlice, waitForApp,
  elementStates, findIfcPixel, waitIdle, waitCameraSettled, cameraDistance, lanIp, OUTPUT, FIXTURES,
} from './helpers.mjs';

const PORT = Number(process.env.UI_PRESENTATION_PORT || 8210);
// Tiempo máximo para que un espectador alcance la cámara del presentador. Con WebGL por software y la CPU saturada cada
// fotograma puede tardar ~1 s y el seguimiento necesita unas decenas: el tope es generoso porque waitFor sale en cuanto se cumple.
const CAMERA_FOLLOW_MS = 40000;

const results = [];
const handles = []; // contextos abiertos { context, errors, name }

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

const shot = (page, name) => page.screenshot({ path: path.join(OUTPUT, `presentation-${name}.png`) });

async function open(browser, name, url, viewport) {
  const h = await openPage(browser, url, viewport ? { viewport } : undefined);
  h.name = name;
  handles.push(h);
  return h;
}

// Foto de lo que un espectador NO debe poder cambiar
async function snapshot(page) {
  return page.evaluate(() => {
    const v = window.__visor;
    const s = v.store;
    return JSON.stringify({
      selection: s.get('selection'), visibility: s.get('visibility'), display: s.get('display'), storey: s.get('storey'),
      section: s.get('section'), measure: s.get('measure'), ui: s.get('ui'), models: s.get('models'), views: s.get('views'),
    });
  });
}

const cam = (page) => page.evaluate(() => window.__visor.viewer.getCameraState());
const inputEnabled = (page) => page.evaluate(() => window.__visor.viewer.inputEnabled);

async function run() {
  const lan = lanIp();
  const server = await startServer({ port: PORT });
  let serverNoNav = null;
  const browser = await launchBrowser();
  console.log(`Presentación: servidor real en ${server.url}; IP de red: ${lan || '(ninguna)'}`);

  try {
    // Modelos que ya están en el servidor antes de abrir las pantallas
    await uploadFixture(server.url, 'edificio_georef_ifc4.ifc');
    await uploadFixture(server.url, 'edificio_site_ifc2x3.ifc');
    await uploadFixture(server.url, 'planta_georef.dxf');

    const P = await open(browser, 'presentador', server.url);
    const V1 = await open(browser, 'espectador-loopback', `${server.url}/?role=viewer`);
    const V2 = lan ? await open(browser, 'espectador-red', `http://${lan}:${PORT}`, { width: 1366, height: 768 }) : null;
    const viewers = [V1, V2].filter(Boolean);
    for (const h of [P, ...viewers]) await waitForApp(h.page, { ifc: 2, cad: 1 });
    await waitFor(async () => (await getSlice(P.page, 'presentation')).viewers === 1 + viewers.length, { label: 'clientes conectados', timeout: 15000 });

    // ------------------------------------------------------------------ roles y navegación libre
    await test('roles: la PC anfitriona presenta; el espectador por IP de red y ?role=viewer solo miran', async () => {
      assert((await getSlice(P.page, 'presentation')).role === 'presenter', 'la PC anfitriona debe ser presentador');
      assert((await getSlice(V1.page, 'presentation')).role === 'viewer', '?role=viewer debe ser espectador');
      if (V2) {
        const info = await V2.page.evaluate(() => window.__visor.info);
        assert(info.role === 'viewer', `la IP de red (${lan}) debe ser espectador, no ${info.role}`);
        const status = (await V2.page.request.post(`http://${lan}:${PORT}/api/models`, { multipart: { file: { name: 'x.ifc', mimeType: 'application/octet-stream', buffer: Buffer.from('ISO-10303-21;') } } })).status();
        assert(status === 403, `un espectador no debe poder subir (HTTP ${status})`);
        assert((await V2.page.locator('.dropzone, .btn--upload, .home-upload').count()) === 0
          || !(await V2.page.locator('button:has-text("Cargar IFC / DXF / DWG")').isVisible().catch(() => false)),
        'el espectador no debe ver el botón de carga');
      }
      for (const h of viewers) assert((await getSlice(h.page, 'presentation')).connected, `${h.name} sin WebSocket`);
    });

    await test('sin presentación: el espectador navega libremente (VIEWER_FREE_NAV) y el presentador no ve bloqueo', async () => {
      for (const h of viewers) {
        assert(await inputEnabled(h.page), `${h.name}: la navegación debería estar activa`);
        assert(await h.page.locator('.lock-layer').isHidden(), `${h.name}: no debería haber capa de bloqueo`);
        const before = await cam(h.page);
        await h.page.mouse.move(900, 400);
        await h.page.mouse.wheel(0, -400);
        await waitFor(async () => cameraDistance(before, await cam(h.page)) > 0.05, { timeout: 4000, label: `${h.name} navega con la rueda` });
      }
      assert(await P.page.locator('.btn--present').isVisible(), 'el presentador ve "Presentar"');
    });

    // ------------------------------------------------------------------ inicio de la presentación
    await test('Presentar: los espectadores muestran EN VIVO + capa de bloqueo; el presentador ve el contador', async () => {
      await P.page.click('.btn--present');
      for (const h of viewers) {
        await waitFor(async () => (await getSlice(h.page, 'presentation')).active, { timeout: 8000, label: `${h.name} EN VIVO` });
        await waitFor(() => h.page.locator('.lock-layer').isVisible(), { timeout: 5000, label: `${h.name} capa de bloqueo` });
        assert((await h.page.locator('.live-pill').first().textContent()).includes('EN VIVO'), `${h.name}: insignia EN VIVO`);
        assert(!(await inputEnabled(h.page)), `${h.name}: viewer.enableInput(false)`);
        assert((await h.page.locator('.lock-layer__label').textContent()).includes('solo visualización'), `${h.name}: texto del bloqueo`);
      }
      const p = await getSlice(P.page, 'presentation');
      assert(p.isActivePresenter && p.active, 'el presentador debe estar activo');
      await waitFor(async () => (await getSlice(P.page, 'presentation')).viewers === viewers.length, { timeout: 5000, label: 'viewers excluye al presentador' });
      const pill = await P.page.locator('.live-pill').first().textContent();
      assert(pill.includes(`${viewers.length} espectadores`), `el presentador debería ver "${viewers.length} espectadores": ${pill}`);
      assert(await P.page.locator('.status-cluster button:has-text("Detener")').isVisible(), 'botón Detener');
    });

    await test('el espectador no puede cambiar nada: clics, arrastre, rueda, teclado y paneles', async () => {
      const pc = await waitCameraSettled(P.page);
      for (const h of viewers) {
        // La cámara del espectador termina de seguir a la del presentador antes de empezar
        await waitFor(async () => cameraDistance(pc, await cam(h.page)) < 0.05, { timeout: CAMERA_FOLLOW_MS, label: `${h.name} alcanza la cámara del presentador` });
        await waitCameraSettled(h.page);
        const before = await snapshot(h.page);
        const camBefore = await cam(h.page);
        const pix = await findIfcPixel(h.page);
        assert(pix, `${h.name}: no hay elemento visible para probar`);
        await h.page.mouse.click(pix.px, pix.py);
        await h.page.mouse.dblclick(pix.px, pix.py);
        await h.page.mouse.click(pix.px, pix.py, { button: 'right' });
        await h.page.mouse.move(800, 400);
        await h.page.mouse.down();
        await h.page.mouse.move(900, 450, { steps: 6 });
        await h.page.mouse.up();
        await h.page.mouse.wheel(0, 500);
        // Pestañas, árbol, botones de la barra de herramientas y dock (todo bajo la capa de bloqueo)
        for (const [x, y] of [[150, 117], [210, 117], [236, 117], [1385, 155], [1431, 155], [1560, 155], [1553, 506], [480, 634], [520, 780]]) {
          await h.page.mouse.click(x, y);
        }
        for (const key of ['h', 'i', 'Shift+H', 'f', 'm', 'p', 'Escape', 'ArrowLeft', '/']) await h.page.keyboard.press(key);
        await h.page.waitForTimeout(500);
        const after = await snapshot(h.page);
        // Un arrastre o una rueda del espectador moverían la cámara metros; el seguimiento del presentador, milímetros
        assert(cameraDistance(camBefore, await cam(h.page)) < 0.15, `${h.name}: la cámara se movió ${cameraDistance(camBefore, await cam(h.page)).toFixed(2)} m por interacción del espectador`);
        if (before !== after) {
          const a = JSON.parse(before);
          const b = JSON.parse(after);
          const keys = Object.keys(a).filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
          throw new Error(`${h.name}: el estado cambió por interacción del espectador (${keys.map((k) => `${k}: ${JSON.stringify(a[k]).slice(0, 160)} -> ${JSON.stringify(b[k]).slice(0, 160)}`).join(' ; ')})`);
        }
        assert(!(await getSlice(h.page, 'presentation')).isActivePresenter, `${h.name}: no debe volverse presentador`);
      }
      // Y la presentación del anfitrión sigue intacta
      assert((await getSlice(P.page, 'presentation')).isActivePresenter, 'el presentador sigue activo');
      assert((await getSlice(P.page, 'selection')).items.length === 0, 'la selección del presentador no se alteró');
    });

    // ------------------------------------------------------------------ réplica
    let selected = null;
    await test('selección con clic real en el lienzo: se replica; el resto queda en fantasma en todos', async () => {
      selected = await findIfcPixel(P.page, { type: 'IFCWALL' });
      assert(selected, 'no se encontró un muro visible');
      await P.page.mouse.move(selected.px - 30, selected.py - 10);
      await P.page.mouse.move(selected.px, selected.py, { steps: 4 });
      await P.page.mouse.click(selected.px, selected.py);
      for (const h of [P, ...viewers]) {
        await waitFor(async () => (await getSlice(h.page, 'selection')).items.length === 1, { timeout: 6000, label: `${h.name} selección` });
        await waitFor(async () => { const s = await elementStates(h.page); return s[3] === 1 && s[1] === s.total - 1; }, { timeout: 8000, label: `${h.name} fantasma` });
        const sel = (await getSlice(h.page, 'selection')).items[0];
        assert(sel.expressId === selected.expressId && sel.modelId === selected.modelId, `${h.name}: elemento distinto`);
        assert(await h.page.locator('.sel').isVisible(), `${h.name}: tarjeta oscura`);
      }
      await shot(P.page, '01-presentador');
      await shot(V1.page, '02-espectador-bloqueado');
    });

    await test('modos de selección y visibilidad se replican (aislar, resaltar, ocultar, mostrar todo)', async () => {
      await P.page.click('.tool[data-tool="sel"]');
      await P.page.click('.seg__btn[data-value="isolate"]');
      for (const h of [P, ...viewers]) await waitFor(async () => { const s = await elementStates(h.page); return s[2] === s.total - 1 && s[3] === 1; }, { timeout: 8000, label: `${h.name} aislar` });
      await P.page.click('.seg__btn[data-value="highlight"]');
      for (const h of [P, ...viewers]) await waitFor(async () => { const s = await elementStates(h.page); return s[0] === s.total - 1 && s[3] === 1; }, { timeout: 8000, label: `${h.name} resaltar` });
      await P.page.click('.seg__btn[data-value="ghost"]');
      await P.page.keyboard.press('Escape'); // cierra el panel de ajustes
      for (const h of [P, ...viewers]) await waitFor(async () => { const s = await elementStates(h.page); return s[1] === s.total - 1; }, { timeout: 8000, label: `${h.name} fantasma` });
      await P.page.click('.sel-act--orange'); // Ocultar
      for (const h of [P, ...viewers]) {
        await waitFor(async () => { const s = await elementStates(h.page); return s[2] === 1 && s[3] === 0; }, { timeout: 8000, label: `${h.name} oculto` });
        assert((await getSlice(h.page, 'visibility')).hidden[selected.modelId]?.includes(selected.expressId), `${h.name}: visibility.hidden`);
      }
      await P.page.keyboard.press('Shift+H');
      for (const h of [P, ...viewers]) await waitFor(async () => { const s = await elementStates(h.page); return s[0] === s.total; }, { timeout: 8000, label: `${h.name} todo visible` });
      // Categoría: ojo del dock
      await P.page.locator('.cat').first().locator('.cat__eye').click();
      for (const h of [P, ...viewers]) await waitFor(async () => (await getSlice(h.page, 'visibility')).hiddenTypes.length === 1, { timeout: 6000, label: `${h.name} categoría oculta` });
      await P.page.locator('.cat').first().locator('.cat__eye').click();
      for (const h of [P, ...viewers]) await waitFor(async () => (await getSlice(h.page, 'visibility')).hiddenTypes.length === 0, { timeout: 6000, label: `${h.name} categoría visible` });
    });

    await test('pestaña de la UI y estado de la barra lateral se replican', async () => {
      for (const tab of ['tree', 'props', 'layers', 'views', 'models']) {
        await P.page.click(`.pill[data-tab="${tab}"]`);
        for (const h of viewers) {
          await waitFor(async () => (await getSlice(h.page, 'ui')).tab === tab, { timeout: 5000, label: `${h.name} pestaña ${tab}` });
          await waitFor(() => h.page.locator(`.tab--${tab}`).isVisible(), { timeout: 5000, label: `${h.name} panel ${tab}` });
        }
      }
      const pix = await findIfcPixel(P.page, { type: 'IFCWALL' });
      await P.page.mouse.click(pix.px, pix.py);
      await P.page.click('.pill[data-tab="props"]');
      await waitFor(() => V1.page.locator('.tab--props .psec').first().isVisible(), { timeout: 5000, label: 'propiedades en el espectador' });
      assert((await V1.page.locator('.props-guid__code').textContent()).length >= 20, 'GlobalId en las propiedades del espectador');
      await P.page.click('.dock__handle');
      for (const h of viewers) await waitFor(async () => (await getSlice(h.page, 'ui')).dockOpen === false, { timeout: 5000, label: `${h.name} dock plegado` });
      await P.page.click('.dock__handle');
      for (const h of viewers) await waitFor(async () => (await getSlice(h.page, 'ui')).dockOpen === true, { timeout: 5000, label: `${h.name} dock abierto` });
    });

    await test('cámara: orbitar con el ratón y zoom con la rueda en el presentador se siguen en los espectadores', async () => {
      const c0 = await cam(P.page);
      await P.page.mouse.move(850, 380);
      await P.page.mouse.down();
      await P.page.mouse.move(930, 420, { steps: 10 });
      await P.page.mouse.up();
      await P.page.mouse.wheel(0, -300);
      // La foto del presentador se toma cuando su cámara terminó de amortiguarse: antes se tomaba con solo "no hay
      // dibujos nuevos", y con la CPU saturada un fotograma lento daba por quieta una cámara que seguía moviéndose
      const c1 = await waitCameraSettled(P.page);
      assert(cameraDistance(c0, c1) > 0.2, 'la cámara del presentador debería haberse movido');
      for (const h of viewers) {
        await waitFor(async () => cameraDistance(c1, await cam(h.page)) < 0.05, { timeout: CAMERA_FOLLOW_MS, label: `${h.name} cámara` });
      }
      // Proyección ortogonal (planta) y vuelta a 3D
      await P.page.click('.tool[data-tool="proj"]');
      for (const h of viewers) {
        await waitFor(async () => (await cam(h.page)).projection === 'orthographic', { timeout: CAMERA_FOLLOW_MS, label: `${h.name} proyección ortogonal` });
        assert((await getSlice(h.page, 'display')).projection === 'orthographic', `${h.name}: display.projection`);
      }
      const c2 = await waitCameraSettled(P.page);
      const dir = (c) => { const d = c.position.map((v, i) => v - c.target[i]); const n = Math.hypot(...d); return d.map((v) => v / n); };
      for (const h of viewers) {
        await waitFor(async () => {
          const c = await cam(h.page);
          // En ortogonal la distancia de la cámara no es significativa: se comparan objetivo, zoom y dirección
          const dt = Math.max(...c.target.map((v, i) => Math.abs(v - c2.target[i])));
          const dd = Math.max(...dir(c).map((v, i) => Math.abs(v - dir(c2)[i])));
          return dt < 0.08 && dd < 0.01 && Math.abs(c.zoom / c2.zoom - 1) < 0.02;
        }, { timeout: CAMERA_FOLLOW_MS, label: `${h.name} cámara en planta` });
      }
      await P.page.click('.tool[data-tool="proj"]');
      for (const h of viewers) await waitFor(async () => (await cam(h.page)).projection === 'perspective', { timeout: CAMERA_FOLLOW_MS, label: `${h.name} proyección 3D` });
      await waitCameraSettled(P.page);
    });

    await test('selector de nivel y corte de planta se replican (estados y plano de recorte)', async () => {
      await P.page.click('.level__step[aria-label="Subir un nivel"]');
      const st = await getSlice(P.page, 'storey');
      assert(st.active, 'el presentador activó un nivel');
      for (const h of viewers) {
        await waitFor(async () => (await getSlice(h.page, 'storey')).active?.expressId === st.active.expressId, { timeout: 6000, label: `${h.name} nivel` });
        await waitFor(async () => (await elementStates(h.page))[2] > 0, { timeout: 8000, label: `${h.name} elementos superiores ocultos` });
        await waitFor(async () => (await h.page.evaluate(() => window.__visor.viewer.getClippingPlanes().length)) >= 1, { timeout: 8000, label: `${h.name} plano de corte` });
      }
      // El presentador aplica su propio nivel con su ritmo de dibujo (con la CPU saturada va por detrás de los espectadores):
      // se espera a que todos converjan en vez de leer una sola vez
      await waitFor(async () => (await elementStates(P.page))[2] > 0, { timeout: 30000, label: 'elementos superiores ocultos en el presentador' });
      for (const h of viewers) {
        await waitFor(async () => (await elementStates(h.page))[2] === (await elementStates(P.page))[2], { timeout: 30000, label: `${h.name}: mismos elementos ocultos que el presentador` });
      }
      await P.page.click('.seg--sm .seg__btn[data-value="only"]');
      for (const h of viewers) await waitFor(async () => (await getSlice(h.page, 'storey')).mode === 'only', { timeout: 6000, label: `${h.name} modo solo` });
      await P.page.click('.seg--sm .seg__btn[data-value="cut"]');
      for (const h of viewers) await waitFor(async () => (await getSlice(h.page, 'storey')).mode === 'cut', { timeout: 6000, label: `${h.name} modo corte` });
      await P.page.click('.level__name');
      await P.page.locator('.level-list__item', { hasText: 'Todos los niveles' }).click();
      for (const h of viewers) {
        await waitFor(async () => (await getSlice(h.page, 'storey')).active === null, { timeout: 6000, label: `${h.name} todos los niveles` });
        await waitFor(async () => (await elementStates(h.page))[2] === 0, { timeout: 8000, label: `${h.name} sin ocultos` });
      }
    });

    await test('caja de sección: el presentador la activa y la ajusta; los espectadores recortan igual', async () => {
      await P.page.click('.tool[data-tool="section"]');
      await waitFor(async () => (await getSlice(P.page, 'section')).enabled, { timeout: 5000, label: 'sección activa' });
      await waitFor(async () => { const s = await getSlice(P.page, 'section'); return s.max[0] > s.min[0]; }, { timeout: 5000, label: 'caja inicial' });
      // Recorta el eje X desde el deslizador máximo
      await P.page.locator('.section-panel .axis-row').first().locator('.dual__in--max').evaluate((el) => {
        el.value = String(Number(el.min) + (Number(el.max) - Number(el.min)) * 0.55);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      });
      const sec = await waitFor(async () => { const s = await getSlice(P.page, 'section'); return s.enabled && s; }, { timeout: 4000, label: 'sección del presentador' });
      for (const h of viewers) {
        await waitFor(async () => {
          const s = await getSlice(h.page, 'section');
          return s.enabled && Math.abs(s.max[0] - sec.max[0]) < 1e-6 && Math.abs(s.min[2] - sec.min[2]) < 1e-6;
        }, { timeout: 6000, label: `${h.name} sección` });
        await waitFor(async () => (await h.page.evaluate(() => window.__visor.viewer.getClippingPlanes().length)) >= 6, { timeout: 6000, label: `${h.name} 6 planos` });
      }
      await shot(V1.page, '03-espectador-seccion');
      await P.page.click('.tool[data-tool="section"]');
      for (const h of viewers) await waitFor(async () => !(await getSlice(h.page, 'section')).enabled, { timeout: 6000, label: `${h.name} sección apagada` });
    });

    await test('mediciones: se dibujan en los espectadores con la misma distancia y se pueden borrar solo desde el presentador', async () => {
      await P.page.click('.tool[data-tool="measure"]');
      // Puntos en la parte central del visor: la etiqueta (y su ×) no debe quedar bajo los chips de la cabecera
      const a = await findIfcPixel(P.page, { y0: 260, y1: 560 });
      const b = await findIfcPixel(P.page, { y0: 260, y1: 560, far: { px: a.px, py: a.py, minDist: 150 } });
      assert(a && b, 'no hay dos puntos del modelo alejados para medir');
      await P.page.mouse.click(a.px, a.py);
      await P.page.mouse.click(b.px, b.py);
      await waitFor(async () => (await getSlice(P.page, 'measure')).items.length === 1, { timeout: 5000, label: 'medición del presentador' });
      const dist = await P.page.locator('.measure-label:not(.measure-label--preview) .measure-label__dist').first().textContent();
      assert(/^\d+\.\d{3} m$/.test(dist.trim()), `formato de distancia: ${dist}`);
      for (const h of viewers) {
        await waitFor(async () => (await getSlice(h.page, 'measure')).items.length === 1, { timeout: 6000, label: `${h.name} medición` });
        await waitFor(() => h.page.locator('.measure-label:not(.measure-label--preview) .measure-label__dist').count().then((n) => n === 1), { timeout: 6000, label: `${h.name} etiqueta` });
        assert((await h.page.locator('.measure-label:not(.measure-label--preview) .measure-label__dist').first().textContent()).trim() === dist.trim(), `${h.name}: distancia distinta`);
        assert(!(await h.page.locator('.measure-label__del').first().isVisible().catch(() => false)), `${h.name}: el espectador no debe ver el botón de borrar`);
      }
      await P.page.click('.tool[data-tool="measure"]'); // sale del modo medir
      await P.page.click('button:has-text("Borrar todo")');
      for (const h of viewers) await waitFor(async () => (await getSlice(h.page, 'measure')).items.length === 0, { timeout: 6000, label: `${h.name} sin mediciones` });
    });

    await test('puntero láser: el presentador apunta y los espectadores ven el punto rojo', async () => {
      await P.page.mouse.move(700, 300);
      await P.page.mouse.move(820, 360, { steps: 8 });
      for (const h of viewers) {
        await waitFor(() => h.page.evaluate(() => window.__visor.presentation.laser.getState().visible), { timeout: 6000, label: `${h.name} láser visible` });
        const st = await h.page.evaluate(() => window.__visor.presentation.laser.getState());
        assert(Math.abs(st.ndcX - ((820 / 1600) * 2 - 1)) < 0.05 || h === V2, `${h.name}: ndcX ${st.ndcX}`);
        const red = await h.page.evaluate(() => {
          const c = document.querySelector('canvas.visor-laser');
          if (!c) return -1;
          const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
          let n = 0;
          for (let i = 0; i < d.length; i += 4) if (d[i] > 200 && d[i + 1] < 90 && d[i + 2] < 90 && d[i + 3] > 120) n++;
          return n;
        });
        assert(red > 20, `${h.name}: no hay píxeles rojos del láser (${red})`);
      }
      await shot(V1.page, '04-espectador-laser');
      // El láser se puede desactivar desde el panel de presentación
      await P.page.evaluate(() => window.__visor.presentation.setLaser(false));
      await P.page.mouse.move(900, 400, { steps: 4 });
      await waitFor(async () => !(await V1.page.evaluate(() => window.__visor.presentation.laser.getState().visible)), { timeout: 6000, label: 'láser apagado' });
      await P.page.evaluate(() => window.__visor.presentation.setLaser(true));
    });

    // ------------------------------------------------------------------ espectador que entra a mitad
    await test('un espectador que entra a mitad de la presentación recibe el estado completo (selección, ocultos, cámara)', async () => {
      await P.page.mouse.move(600, 500);
      await P.page.click('.pill[data-tab="tree"]');
      const pix = await findIfcPixel(P.page, { type: 'IFCWALL', skip: 3 });
      await P.page.mouse.click(pix.px, pix.py);
      await waitFor(async () => (await getSlice(P.page, 'selection')).items.length === 1, { timeout: 4000, label: 'selección nueva' });
      await P.page.locator('.cat').nth(1).locator('.cat__eye').click(); // oculta una categoría
      await waitIdle(P.page, 800);
      const pSel = (await getSlice(P.page, 'selection')).items;
      const pCam = await waitCameraSettled(P.page);
      const pHidden = (await getSlice(P.page, 'visibility')).hiddenTypes;
      const late = await open(browser, 'espectador-tardio', `${server.url}/?role=viewer`);
      await waitForApp(late.page, { ifc: 2, cad: 1 });
      await waitFor(async () => (await getSlice(late.page, 'presentation')).active, { timeout: 8000, label: 'tardío EN VIVO' });
      assert(JSON.stringify((await getSlice(late.page, 'selection')).items) === JSON.stringify(pSel), 'la selección del tardío no coincide');
      assert(JSON.stringify((await getSlice(late.page, 'visibility')).hiddenTypes) === JSON.stringify(pHidden), 'los tipos ocultos del tardío no coinciden');
      assert((await getSlice(late.page, 'ui')).tab === 'tree', 'pestaña del tardío');
      await waitFor(async () => cameraDistance(pCam, await cam(late.page)) < 0.08, { timeout: CAMERA_FOLLOW_MS, label: 'cámara del tardío' });
      await waitFor(async () => { const s = await elementStates(late.page); return s[3] === pSel.length && s[2] > 0; }, { timeout: 8000, label: 'estados del tardío' });
      assert(await late.page.locator('.lock-layer').isVisible(), 'el tardío está bloqueado');
      assert((await late.page.locator('.live-pill').first().textContent()).includes('EN VIVO'), 'insignia en el tardío');
      await P.page.locator('.cat').nth(1).locator('.cat__eye').click();
      await P.page.keyboard.press('Escape');
      await late.context.close();
    });

    // ------------------------------------------------------------------ modelos nuevos
    await test('un modelo que sube el presentador aparece solo en los espectadores', async () => {
      await P.page.click('.pill[data-tab="models"]');
      await P.page.locator('input[type=file]').first().setInputFiles(path.join(FIXTURES, 'downloads', 'example.ifc'));
      await waitFor(async () => (await getSlice(P.page, 'modelRecords')).length === 4, { timeout: 30000, label: 'registro nuevo en el presentador' });
      for (const h of [P, ...viewers]) {
        await waitFor(() => h.page.evaluate(() => window.__visor.ifc.getModels().length === 3), { timeout: 60000, label: `${h.name} carga el IFC nuevo` });
        assert((await getSlice(h.page, 'modelRecords')).some((r) => r.name === 'example.ifc'), `${h.name}: registro example.ifc`);
        assert((await h.page.locator('.model').count()) === 4, `${h.name}: tarjetas de modelo (${await h.page.locator('.model').count()})`);
      }
      // El espectador no debe haber re-encuadrado por su cuenta: sigue la cámara del presentador
      const pc = await waitCameraSettled(P.page);
      for (const h of viewers) await waitFor(async () => cameraDistance(pc, await cam(h.page)) < 0.08, { timeout: CAMERA_FOLLOW_MS, label: `${h.name} sigue la cámara tras la carga` });
      // Al eliminarlo el presentador, desaparece también de los espectadores
      await P.page.locator('.model', { hasText: 'example.ifc' }).locator('button[aria-label="Eliminar el modelo"]').click();
      await P.page.waitForSelector('.modal');
      await P.page.click('.modal button:has-text("Eliminar")');
      for (const h of [P, ...viewers]) {
        await waitFor(() => h.page.evaluate(() => window.__visor.ifc.getModels().length === 2), { timeout: 15000, label: `${h.name} descarga el IFC eliminado` });
        assert((await getSlice(h.page, 'modelRecords')).length === 3, `${h.name}: registros tras eliminar`);
      }
    });

    // ------------------------------------------------------------------ tomar el control
    await test('otro presentador (otra pestaña de la PC anfitriona) está bloqueado y puede tomar el control', async () => {
      const P2 = await open(browser, 'presentador-2', server.url);
      await waitForApp(P2.page, { ifc: 2, cad: 1 });
      await waitFor(async () => (await getSlice(P2.page, 'presentation')).active, { timeout: 8000, label: 'P2 ve la presentación' });
      assert(!(await getSlice(P2.page, 'presentation')).isActivePresenter, 'P2 no es el presentador activo');
      assert(await P2.page.locator('.lock-layer').isVisible(), 'P2 está bloqueado mientras otro presenta');
      const takeBtn = (pg) => pg.locator('.status-cluster button[aria-label^="Tomar el control"]');
      assert(await takeBtn(P2.page).isVisible(), 'P2 ve "Tomar control"');
      await takeBtn(P2.page).click();
      await waitFor(async () => (await getSlice(P2.page, 'presentation')).isActivePresenter, { timeout: 6000, label: 'P2 activo' });
      await waitFor(async () => !(await getSlice(P.page, 'presentation')).isActivePresenter, { timeout: 6000, label: 'P deja de ser activo' });
      await waitFor(() => P.page.locator('.lock-layer').isVisible(), { timeout: 5000, label: 'P bloqueado' });
      // Los espectadores ahora siguen a P2: su selección se replica desde P2
      const pix = await findIfcPixel(P2.page, { type: 'IFCWALL', skip: 1 });
      await P2.page.mouse.click(pix.px, pix.py);
      for (const h of viewers) {
        await waitFor(async () => { const it = (await getSlice(h.page, 'selection')).items; return it.length === 1 && it[0].expressId === pix.expressId; }, { timeout: 8000, label: `${h.name} sigue a P2` });
      }
      // Y devuelve el control
      await takeBtn(P.page).click();
      await waitFor(async () => (await getSlice(P.page, 'presentation')).isActivePresenter, { timeout: 6000, label: 'P recupera el control' });
      await P2.context.close();
      await waitFor(async () => (await getSlice(P.page, 'presentation')).active, { timeout: 4000, label: 'la presentación sigue al cerrar P2' });
    });

    // ------------------------------------------------------------------ fin
    await test('Detener: los espectadores se desbloquean y vuelven a navegar libremente', async () => {
      await P.page.locator('.status-cluster button:has-text("Detener")').click();
      for (const h of viewers) {
        await waitFor(async () => !(await getSlice(h.page, 'presentation')).active, { timeout: 6000, label: `${h.name} sin presentación` });
        await waitFor(() => h.page.locator('.lock-layer').isHidden(), { timeout: 5000, label: `${h.name} sin capa de bloqueo` });
        assert(await inputEnabled(h.page), `${h.name}: enableInput(true)`);
        assert((await h.page.locator('.live-pill').count()) === 0, `${h.name}: la insignia EN VIVO debe desaparecer`);
        const before = await cam(h.page);
        await h.page.mouse.move(900, 400);
        await h.page.mouse.wheel(0, 500);
        await waitFor(async () => cameraDistance(before, await cam(h.page)) > 0.05, { timeout: 4000, label: `${h.name} navega otra vez` });
        // Pero sigue sin poder subir ni borrar modelos
        if (h === V2) {
          const status = (await h.page.request.post(`http://${lan}:${PORT}/api/models`, { multipart: { file: { name: 'x.ifc', mimeType: 'application/octet-stream', buffer: Buffer.from('ISO-10303-21;') } } })).status();
          assert(status === 403, `${h.name}: un espectador de red no debe poder subir (${status})`);
        }
      }
      assert(await P.page.locator('.btn--present').isVisible(), 'el presentador vuelve a ver "Presentar"');
    });

    await test('si el presentador se desconecta a mitad de la presentación, la presentación termina y los espectadores se liberan', async () => {
      const P3 = await open(browser, 'presentador-3', server.url);
      await waitForApp(P3.page, { ifc: 2, cad: 1 });
      await P3.page.click('.btn--present');
      for (const h of viewers) await waitFor(() => h.page.locator('.lock-layer').isVisible(), { timeout: 6000, label: `${h.name} bloqueado` });
      await P3.context.close();
      for (const h of viewers) {
        await waitFor(() => h.page.locator('.lock-layer').isHidden(), { timeout: 8000, label: `${h.name} liberado` });
        assert(!(await getSlice(h.page, 'presentation')).active, `${h.name}: sin presentación`);
      }
    });

    await test('reconexión: un espectador que pierde el WebSocket vuelve solo y recibe la presentación en curso', async () => {
      await P.page.click('.btn--present');
      await waitFor(async () => (await getSlice(V1.page, 'presentation')).active, { timeout: 6000, label: 'V1 EN VIVO' });
      // Corta el socket del espectador (simula pérdida de red)
      await V1.page.evaluate(() => window.__visor.sync.ws?.close?.() || window.__visor.sync._ws?.close?.());
      await waitFor(async () => { const p = await getSlice(V1.page, 'presentation'); return p.connected && p.active; }, { timeout: 15000, label: 'V1 reconectado y siguiendo' });
      await waitFor(() => V1.page.locator('.lock-layer').isVisible(), { timeout: 5000, label: 'V1 bloqueado tras reconectar' });
      assert(!(await inputEnabled(V1.page)), 'V1 sin navegación tras reconectar');
      await P.page.locator('.status-cluster button:has-text("Detener")').click();
      await waitFor(() => V1.page.locator('.lock-layer').isHidden(), { timeout: 6000, label: 'V1 liberado' });
    });

    // ------------------------------------------------------------------ servidor sin navegación libre
    await test('VIEWER_FREE_NAV=false: sin presentación el espectador ve "Esperando al presentador" y no puede interactuar', async () => {
      serverNoNav = await startServer({ port: PORT + 1, env: { VIEWER_FREE_NAV: 'false' } });
      await uploadFixture(serverNoNav.url, 'edificio_georef_ifc4.ifc');
      const pv = await open(browser, 'espectador-sin-nav', `${serverNoNav.url}/?role=viewer`);
      await waitForApp(pv.page, { ifc: 1, cad: 0 });
      assert(await pv.page.locator('.lock-layer').isVisible(), 'bloqueado sin presentación');
      assert((await pv.page.locator('.lock-layer__label').textContent()).includes('Esperando al presentador'), 'mensaje de espera');
      assert(!(await inputEnabled(pv.page)), 'enableInput(false)');
      const pres = await open(browser, 'presentador-sin-nav', serverNoNav.url);
      await waitForApp(pres.page, { ifc: 1, cad: 0 });
      await pres.page.click('.btn--present');
      await waitFor(async () => (await getSlice(pv.page, 'presentation')).active, { timeout: 6000, label: 'espectador EN VIVO' });
      await pres.page.locator('.status-cluster button:has-text("Detener")').click();
      await waitFor(async () => !(await getSlice(pv.page, 'presentation')).active, { timeout: 6000, label: 'espectador sin presentación' });
      assert(await pv.page.locator('.lock-layer').isVisible(), 'sigue bloqueado: no hay navegación libre');
      assert((await pv.page.locator('.lock-layer__label').textContent()).includes('Esperando al presentador'), 'vuelve a esperar');
      await pv.context.close();
      await pres.context.close();
    });

    await test('sin errores de consola ni de página en ninguna pantalla', async () => {
      const lines = [];
      for (const h of handles) for (const e of h.errors) lines.push(`[${h.name}] ${e}`);
      assert(lines.length === 0, lines.slice(0, 8).join(' | '));
    });
  } finally {
    await browser.close().catch(() => {});
    await serverNoNav?.stop().catch(() => {});
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
