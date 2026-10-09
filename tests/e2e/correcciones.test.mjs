// Pruebas de regresión de la ronda 1 de verificación (servidor REAL + todos los módulos reales):
//   1. Georreferencia por IfcSite: la tarjeta Ubicación y el diálogo muestran la posición real, no ceros.
//   2. IfcSpace: el dock (contadores, fila de Espacios, "Mostrar todo", aislamiento) refleja que están ocultos por defecto.
//   3. Vistas guardadas: sobreviven a recargar la página y a reiniciar el servidor; los espectadores no las guardan.
//   4. Vistas estándar (planta, alzados, isométrica) accesibles desde la interfaz.
//
// Uso: node tests/e2e/correcciones.test.mjs   (código de salida 0 = todo bien, 1 = algo falló)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  startServer, launchBrowser, openPage, uploadFixture, assert, waitFor, getSlice, waitForApp, elementStates, OUTPUT,
} from './helpers.mjs';

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

const shot = (page, name) => page.screenshot({ path: path.join(OUTPUT, `correcciones-${name}.png`) });
const text = async (locator) => (await locator.innerText()).replace(/\s+/g, ' ').trim();

async function open(browser, name, url, opts) {
  const h = await openPage(browser, url, opts);
  h.name = name;
  handles.push(h);
  return h;
}

// Vistas guardadas en el servidor (lectura directa de la API)
const serverViews = async (srv) => (await (await fetch(`${srv.url}/api/views`)).json()).items;

async function run() {
  const browser = await launchBrowser();
  const servers = [];
  const newServer = async (opts) => {
    const s = await startServer(opts || {});
    servers.push(s);
    return s;
  };

  try {
    // ================================================================== 1. Georreferencia por IfcSite
    {
      const srv = await newServer();
      await uploadFixture(srv.url, 'edificio_site_ifc2x3.ifc');
      const P = await open(browser, 'site', srv.url);
      await waitForApp(P.page, { ifc: 1 });
      const page = P.page;
      const modelId = await page.evaluate(() => window.__visor.ifc.getModels()[0].id);
      const boxOf = () => page.evaluate((id) => { const b = window.__visor.ifc.getModelBox(id); return [b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z]; }, modelId);

      await test('IFC con coordenadas de IfcSite: la tarjeta Ubicación muestra E/N reales, no 0.00', async () => {
        const info = await page.evaluate((id) => window.__visor.ifc.getGeorefInfo(id), modelId);
        assert(info.source === 'site' && info.eastings === 0 && info.northings === 0, `precondición: source=${info.source}`);
        assert(Math.abs(info.anchor.e - 279500) < 0.01 && Math.abs(info.anchor.n - 8661000) < 0.01, `ancla ${JSON.stringify(info.anchor)}`);
        const kv = page.locator('dl[data-georef-source="site"]');
        await waitFor(() => kv.isVisible(), { timeout: 5000, label: 'tarjeta de ubicación' });
        const t = await text(kv);
        assert(/Este 279500\.00/.test(t) && /Norte 8661000\.00/.test(t), `tarjeta: ${t}`);
        assert(!/Este 0\.00/.test(t) && !/Norte 0\.00/.test(t), `la tarjeta no debe mostrar ceros: ${t}`);
        const card = await text(kv.locator('xpath=ancestor::*[contains(@class,"panel-card") or contains(@class,"card")][1]'));
        assert(/Cota base/.test(card) && /150/.test(card) && /\.00/.test(card), `la cota base sigue siendo 150.00: ${card}`);
        await shot(page, '01-ubicacion-site');
      });

      await test('diálogo de georreferencia (IfcSite): posición real, nota explicativa y desplazamiento 0 sin mover el modelo', async () => {
        const before = await boxOf();
        await page.click('button[title="Configurar la georreferencia"]');
        const detected = page.locator('.detected--site');
        await waitFor(() => detected.isVisible(), { timeout: 5000, label: 'diálogo' });
        const t = await text(detected);
        assert(/Este \(E\) 279500\.000/.test(t) && /Norte \(N\) 8661000\.000/.test(t) && /Altura \(H\) 150\.000/.test(t), `detectada: ${t}`);
        assert(await detected.locator('[data-note="site"]').isVisible(), 'falta la nota de IfcSite');
        assert(/desplazamiento/i.test(await text(detected.locator('[data-note="site"]'))), 'la nota debe explicar que es un desplazamiento');
        const form = await text(page.locator('.modal .form-grid'));
        assert(/Desplazamiento en metros/.test(form), `las pistas del formulario deben hablar de desplazamiento: ${form}`);
        await page.waitForTimeout(400); // animación de entrada del modal
        await shot(page, '02-dialogo-site');
        // Guardar sin editar no mueve el modelo
        await page.click('.modal button:has-text("Guardar")');
        await waitFor(async () => (await page.locator('.modal').count()) === 0, { timeout: 8000, label: 'cierre del diálogo' });
        await waitFor(async () => (await page.evaluate((id) => window.__visor.ifc.getGeorefInfo(id).source, modelId)) === 'manual', { timeout: 8000, label: 'georef manual' });
        await page.waitForTimeout(300);
        const after = await boxOf();
        const dev = Math.max(...before.map((v, i) => Math.abs(v - after[i])));
        assert(dev < 1e-6, `el modelo se movió ${dev} m al guardar el diálogo sin editar`);
      });
      await P.context.close();

      // IFC4 con IfcMapConversion: la tarjeta sigue mostrando los valores del archivo y el diálogo no lleva la nota
      const srv4 = await newServer();
      await uploadFixture(srv4.url, 'edificio_georef_ifc4.ifc');
      const Q = await open(browser, 'ifc4', srv4.url);
      await waitForApp(Q.page, { ifc: 1 });
      await test('IFC4 (IfcMapConversion): la tarjeta y el diálogo siguen mostrando la conversión del archivo', async () => {
        const kv = Q.page.locator('dl[data-georef-source="mapconversion"]');
        await waitFor(() => kv.isVisible(), { timeout: 5000, label: 'tarjeta de ubicación' });
        const t = await text(kv);
        assert(/Este 279500\.00/.test(t) && /Norte 8661000\.00/.test(t) && /Rotación 15\.00°/.test(t), `tarjeta: ${t}`);
        await Q.page.click('button[title="Configurar la georreferencia"]');
        await waitFor(() => Q.page.locator('.detected--mapconversion').isVisible(), { timeout: 5000, label: 'diálogo' });
        assert((await Q.page.locator('[data-note="site"]').count()) === 0, 'la nota de IfcSite no aplica a IfcMapConversion');
        const t2 = await text(Q.page.locator('.detected--mapconversion'));
        assert(/Este \(E\) 279500\.000/.test(t2) && /Rotación 15\.0000°/.test(t2), `detectada: ${t2}`);
        assert(!/Desplazamiento en metros/.test(await text(Q.page.locator('.modal .form-grid'))), 'las pistas son de coordenadas, no de desplazamiento');
        await Q.page.click('.modal button:has-text("Cancelar")');
      });
      await Q.context.close();
    }

    // ================================================================== 2. IfcSpace en el dock
    {
      const srv = await newServer();
      await uploadFixture(srv.url, 'downloads/AC20-FZK-Haus.ifc');
      const P = await open(browser, 'espacios', srv.url);
      const page = P.page;
      await waitForApp(page, { ifc: 1 });
      await waitFor(async () => (await elementStates(page)).total > 0, { timeout: 15000, label: 'estados de elementos' });
      const row = page.locator('li.cat[data-type="IFCSPACE"]');
      const foot = (key) => text(page.locator(`.stat[data-stat="${key}"] .stat__foot`));
      const displaySpaces = () => page.evaluate(() => window.__visor.store.get('display').showSpaces);
      const states = async () => {
        const s = await elementStates(page);
        return { normal: s[0], hidden: s[2], total: s.total };
      };
      const settle = () => page.waitForTimeout(450);

      await test('IfcSpace oculto por defecto: contadores y fila de Espacios lo reflejan', async () => {
        const s = await states();
        assert(s.hidden === 7 && s.normal === 83 && s.total === 90, `estados: ${JSON.stringify(s)}`);
        const el = await foot('elements');
        assert(/83 visibles/.test(el) && /7 ocultos/.test(el), `elementos: ${el}`);
        const cats = await foot('categories');
        assert(/9 visibles/.test(cats) && /1 oculta/.test(cats), `categorías: ${cats}`);
        assert(/is-hidden/.test(await row.getAttribute('class')), 'la fila Espacios debe estar oculta');
        assert((await row.locator('.cat__eye').getAttribute('aria-pressed')) === 'true', 'el ojo de Espacios debe estar tachado');
        assert(/7/.test(await text(page.locator('.tile--yellow'))), `la ficha OCULTOS debe contar los 7 espacios: ${await text(page.locator('.tile--yellow'))}`);
        await shot(page, '03-espacios-ocultos');
      });

      await test('el ojo de Espacios los muestra y los oculta de verdad (y mueve "Mostrar espacios" de Ajustes)', async () => {
        await row.locator('.cat__eye').click();
        await settle();
        assert((await displaySpaces()) === true, 'showSpaces debería ser true');
        const s = await states();
        assert(s.hidden === 0 && s.normal === 90, `al mostrar: ${JSON.stringify(s)}`);
        assert(!/is-hidden/.test(await row.getAttribute('class')), 'la fila ya no está oculta');
        const el = await foot('elements');
        assert(/90 visibles/.test(el) && !/oculto/.test(el), `elementos: ${el}`);
        assert(/10 visibles/.test(await foot('categories')), `categorías: ${await foot('categories')}`);
        // Ajustes de selección: el interruptor coincide
        await page.click('.tool[data-tool="sel"]');
        await waitFor(() => page.locator('.popover:not([hidden]) .switch__input').isVisible().catch(() => false) || page.locator('.popover:not([hidden])').first().isVisible(), { timeout: 3000, label: 'ajustes de selección' });
        const switchOn = await page.locator('.popover:not([hidden]) .switch__input').first().isChecked();
        assert(switchOn === true, 'el interruptor "Mostrar espacios" debe estar activo');
        await page.keyboard.press('Escape');
        // y de vuelta
        await row.locator('.cat__eye').click();
        await settle();
        assert((await displaySpaces()) === false, 'showSpaces debería volver a false');
        const s2 = await states();
        assert(s2.hidden === 7 && s2.normal === 83, `al ocultar: ${JSON.stringify(s2)}`);
        assert(/is-hidden/.test(await row.getAttribute('class')), 'la fila vuelve a estar oculta');
        assert(/83 visibles/.test(await foot('elements')) && /7 ocultos/.test(await foot('elements')), `elementos: ${await foot('elements')}`);
      });

      await test('Aislar Espacios los dibuja (no deja la pantalla vacía) y al quitarlo vuelven a ocultarse', async () => {
        await row.locator('.cat__main').click();
        await settle();
        assert((await displaySpaces()) === true, 'aislar Espacios enciende showSpaces');
        const s = await states();
        assert(s.normal === 7 && s.hidden === 83, `aislado: ${JSON.stringify(s)}`);
        assert(/is-isolated/.test(await row.getAttribute('class')), 'la fila debe marcarse como aislada');
        await row.locator('.cat__main').click();
        await settle();
        assert((await displaySpaces()) === false, 'al quitar el aislamiento los espacios vuelven a ocultarse');
        const s2 = await states();
        assert(s2.normal === 83 && s2.hidden === 7, `sin aislar: ${JSON.stringify(s2)}`);
        assert(!/is-isolated/.test(await row.getAttribute('class')), 'sin marca de aislamiento');
        // aislar otra categoría no marca Espacios ni activa showSpaces
        const wall = page.locator('li.cat[data-type="IFCWALL"]');
        await wall.locator('.cat__main').click();
        await settle();
        assert((await displaySpaces()) === false, 'aislar Muros no enciende los espacios');
        assert(/is-isolated/.test(await wall.getAttribute('class')), 'Muros aislado');
        await wall.locator('.cat__main').click();
        await settle();
      });

      await test('"Mostrar todo" del dock y de la ficha OCULTOS también muestran los espacios', async () => {
        const link = page.locator('.dock-link', { hasText: 'Mostrar todo' });
        assert(await link.isVisible(), 'el enlace Mostrar todo debe verse mientras haya categorías ocultas (Espacios)');
        await link.click();
        await settle();
        assert((await displaySpaces()) === true, 'showSpaces tras Mostrar todo');
        assert((await states()).hidden === 0, `estados: ${JSON.stringify(await states())}`);
        assert(!(await link.isVisible()), 'sin nada oculto el enlace desaparece');
        // ocultar de nuevo y usar la ficha OCULTOS
        await row.locator('.cat__eye').click();
        await settle();
        assert((await states()).hidden === 7, 'precondición: 7 ocultos');
        await page.locator('.tile--yellow').click();
        await settle();
        assert((await displaySpaces()) === true && (await states()).hidden === 0, 'la ficha OCULTOS muestra todo');
      });
      await test('sin errores de consola (espacios)', async () => {
        assert(P.errors.length === 0, P.errors.join(' | '));
      });
      await P.context.close();
    }

    // ================================================================== 3. Vistas guardadas persistentes
    {
      const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-views-e2e-'));
      const port = 9100 + Math.floor(Math.random() * 400);
      let srv = await newServer({ port, env: { DATA_DIR: dataDir } });
      await uploadFixture(srv.url, 'edificio_georef_ifc4.ifc');
      const P = await open(browser, 'vistas', srv.url);
      const page = P.page;
      await waitForApp(page, { ifc: 1 });
      const names = (p) => p.evaluate(() => window.__visor.store.get('views').items.map((v) => v.name));
      let savedCam;

      await test('guardar una vista en la pestaña Vistas la guarda en el servidor (con miniatura)', async () => {
        await page.click('.pill[data-tab="views"]');
        // una cámara reconocible
        await page.evaluate(() => window.__visor.viewer.setCameraState({ position: [30, 22, 28], target: [4, 2, -3], projection: 'perspective', zoom: 1, fov: 45 }, { smooth: false }));
        await page.waitForTimeout(300);
        savedCam = await page.evaluate(() => window.__visor.viewer.getCameraState());
        await page.fill('.views-form input', 'Fachada norte');
        await page.click('.views-form button:has-text("Guardar vista")');
        await waitFor(async () => (await serverViews(srv)).length === 1, { timeout: 6000, label: 'vista guardada en el servidor' });
        const [v] = await serverViews(srv);
        assert(v.name === 'Fachada norte', `nombre: ${v.name}`);
        assert(/^data:image\/jpeg;base64,/.test(v.thumb || ''), 'la miniatura debe guardarse');
        assert(v.camera.position.every((n, i) => Math.abs(n - savedCam.position[i]) < 1e-6), 'cámara guardada');
        assert(v.state.display && v.state.visibility, 'estado guardado');
        const sesion = JSON.parse(fs.readFileSync(path.join(dataDir, 'session.json'), 'utf8'));
        assert(sesion.views.length === 1 && sesion.models.length === 1, 'session.json lleva modelos y vistas');
      });

      await test('al recargar la página (F5) las vistas siguen ahí y se pueden restaurar', async () => {
        await page.reload();
        await waitForApp(page, { ifc: 1 });
        await waitFor(async () => (await names(page)).length === 1, { timeout: 6000, label: 'vistas tras recargar' });
        assert((await names(page))[0] === 'Fachada norte', 'nombre tras recargar');
        await page.click('.pill[data-tab="views"]');
        assert((await page.locator('.view').count()) === 1, 'la lista de la pestaña Vistas la muestra');
        assert(await page.locator('.view .view__thumb').first().evaluate((el) => el.tagName === 'IMG'), 'con su miniatura');
        // mover la cámara y restaurar
        await page.evaluate(() => window.__visor.viewer.setCameraState({ position: [-40, 10, 5], target: [0, 0, 0], projection: 'perspective', zoom: 1, fov: 45 }, { smooth: false }));
        await page.waitForTimeout(200);
        await page.click('.view .view__open');
        await waitFor(async () => {
          const c = await page.evaluate(() => window.__visor.viewer.getCameraState());
          return c.position.every((n, i) => Math.abs(n - savedCam.position[i]) < 0.05);
        }, { timeout: 6000, label: 'cámara restaurada' });
        // recargar no duplica ni guarda de más: el servidor sigue con una sola vista
        assert((await serverViews(srv)).length === 1, 'el servidor sigue con 1 vista');
      });

      await test('un espectador carga las vistas del servidor pero nunca las guarda', async () => {
        const V = await open(browser, 'espectador-vistas', `${srv.url}/?role=viewer`);
        await waitForApp(V.page, { ifc: 1 });
        await waitFor(async () => (await names(V.page)).length === 1, { timeout: 6000, label: 'vistas en el espectador' });
        assert((await getSlice(V.page, 'presentation')).role === 'viewer', 'rol espectador');
        await V.page.evaluate(() => { const v = window.__visor; v.actions.saveView('Vista del espectador', v.viewer.getCameraState(), null); });
        await V.page.waitForTimeout(1300);
        const items = await serverViews(srv);
        assert(items.length === 1 && items[0].name === 'Fachada norte', `el servidor no debe cambiar: ${JSON.stringify(items.map((v) => v.name))}`);
        await V.context.close();
      });

      await P.context.close(); // sin pestañas abiertas que intenten reconectar mientras se reinicia el servidor
      await test('las vistas sobreviven a reiniciar el servidor', async () => {
        await srv.stop();
        srv = await newServer({ port, env: { DATA_DIR: dataDir } });
        // stop() borró su carpeta temporal propia, no la nuestra
        assert(fs.existsSync(path.join(dataDir, 'session.json')), 'session.json sigue en disco');
        const Q = await open(browser, 'vistas-reinicio', srv.url);
        await waitForApp(Q.page, { ifc: 1 });
        await waitFor(async () => (await names(Q.page)).length === 1, { timeout: 6000, label: 'vistas tras reiniciar el servidor' });
        assert((await names(Q.page))[0] === 'Fachada norte', 'nombre tras reiniciar');
        // borrar desde la UI se guarda también
        await Q.page.click('.pill[data-tab="views"]');
        await Q.page.click('.view button[title="Borrar esta vista"]');
        await waitFor(async () => (await serverViews(srv)).length === 0, { timeout: 6000, label: 'borrado en el servidor' });
        await Q.page.reload();
        await waitForApp(Q.page, { ifc: 1 });
        await Q.page.waitForTimeout(600);
        assert((await names(Q.page)).length === 0, 'tras borrar y recargar no queda ninguna');
        assert(Q.errors.length === 0, Q.errors.join(' | '));
        await Q.context.close();
      });


      await test('si el servidor rechaza el guardado, el presentador recibe un aviso (sin romper la app)', async () => {
        const R = await open(browser, 'vistas-error', srv.url);
        await waitForApp(R.page, { ifc: 1 });
        await R.page.route('**/api/views', (route) => (route.request().method() === 'PUT' ? route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"disco lleno"}' }) : route.continue()));
        await R.page.evaluate(() => { const v = window.__visor; v.actions.saveView('X', v.viewer.getCameraState(), null); });
        await waitFor(() => R.page.locator('.toast', { hasText: 'No se pudieron guardar las vistas' }).first().isVisible(), { timeout: 6000, label: 'aviso de error' });
        assert((await names(R.page)).length === 1, 'la vista sigue en memoria');
        await R.context.close();
      });
      fs.rmSync(dataDir, { recursive: true, force: true });
    }

    // ================================================================== 4. Vistas estándar en la UI
    {
      const srv = await newServer();
      await uploadFixture(srv.url, 'edificio_georef_ifc4.ifc');
      const P = await open(browser, 'vistas-estandar', srv.url);
      const page = P.page;
      await waitForApp(page, { ifc: 1 });
      const dirOf = () => page.evaluate(() => {
        const c = window.__visor.viewer.getCameraState();
        const d = c.position.map((v, i) => v - c.target[i]);
        const l = Math.hypot(...d) || 1;
        return { dir: d.map((v) => v / l), projection: window.__visor.store.get('display').projection };
      });
      const EXPECT = {
        top: [0, 1, 0], bottom: [0, -1, 0], front: [0, 0, 1], back: [0, 0, -1], left: [-1, 0, 0], right: [1, 0, 0],
        iso: [1 / Math.hypot(1, 0.8, 1), 0.8 / Math.hypot(1, 0.8, 1), 1 / Math.hypot(1, 0.8, 1)],
      };

      await test('el botón "Vistas estándar" abre un panel con las 7 vistas', async () => {
        await page.click('.tool[data-tool="views"]');
        const seg = page.locator('.seg--views');
        await waitFor(() => seg.isVisible(), { timeout: 3000, label: 'panel de vistas' });
        const labels = await seg.locator('.seg__btn').allInnerTexts();
        assert(labels.join(',') === 'Planta,Frontal,Posterior,Izquierda,Derecha,Inferior,Isométrica', `botones: ${labels.join(',')}`);
        await page.waitForTimeout(300);
        await shot(page, '04-vistas-estandar');
        await page.keyboard.press('Escape');
        await waitFor(async () => !(await seg.isVisible()), { timeout: 3000, label: 'cierre con Esc' });
      });

      for (const name of ['top', 'front', 'back', 'left', 'right', 'bottom', 'iso']) {
        await test(`vista estándar "${name}": orienta la cámara y ajusta la proyección`, async () => {
          if (!(await page.locator('.seg--views').isVisible())) await page.click('.tool[data-tool="views"]');
          await page.click(`.seg--views .seg__btn[data-value="${name}"]`);
          const want = EXPECT[name];
          await waitFor(async () => {
            const { dir } = await dirOf();
            return dir[0] * want[0] + dir[1] * want[1] + dir[2] * want[2] > 0.999;
          }, { timeout: 8000, label: `cámara en vista ${name}` });
          const { projection } = await dirOf();
          assert(projection === (name === 'iso' ? 'perspective' : 'orthographic'), `proyección ${projection}`);
          assert(!(await page.locator('.seg--views').isVisible()), 'el panel se cierra al elegir');
          // al reabrir, la vista actual aparece marcada
          await page.click('.tool[data-tool="views"]');
          const on = await page.locator('.seg--views .seg__btn.is-on').getAttribute('data-value');
          assert(on === name, `la vista marcada debería ser ${name} y es ${on}`);
          await page.keyboard.press('Escape');
        });
      }

      await test('tras una vista estándar el modelo queda encuadrado dentro de la zona libre', async () => {
        await page.click('.tool[data-tool="views"]');
        await page.click('.seg--views .seg__btn[data-value="front"]');
        await waitFor(async () => (await dirOf()).dir[2] > 0.999, { timeout: 8000, label: 'vista frontal' });
        await page.waitForTimeout(600);
        const fit = await page.evaluate(() => {
          const v = window.__visor.viewer;
          const box = window.__visor.ifc.getModelBox(window.__visor.ifc.getModels()[0].id);
          const r = v.canvas.getBoundingClientRect();
          let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
          for (let i = 0; i < 8; i++) {
            const p = new box.min.constructor(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).project(v.camera);
            const x = r.left + ((p.x + 1) / 2) * r.width;
            const y = r.top + ((1 - p.y) / 2) * r.height;
            minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
          }
          return { minX, maxX, minY, maxY, insets: v.getFitInsets(), w: r.width, h: r.height };
        });
        assert(fit.minX >= fit.insets.left - 2 && fit.maxX <= fit.w - fit.insets.right + 2, `encuadre horizontal: ${JSON.stringify(fit)}`);
        assert(fit.minY >= fit.insets.top - 2 && fit.maxY <= fit.h - fit.insets.bottom + 2, `encuadre vertical: ${JSON.stringify(fit)}`);
      });

      await test('el botón 3D/planta y el centro de la cruceta siguen funcionando', async () => {
        const p0 = (await dirOf()).projection;
        await page.click('.tool[data-tool="proj"]');
        await waitFor(async () => (await dirOf()).projection !== p0, { timeout: 4000, label: 'cambio de proyección' });
        await page.click('.tool[data-tool="proj"]');
        await waitFor(async () => (await dirOf()).projection === p0, { timeout: 4000, label: 'proyección original' });
        await page.click('.orbit__center');
        await waitFor(async () => {
          const d = await dirOf();
          return d.dir[1] > 0.5 && d.dir[0] > 0.5;
        }, { timeout: 8000, label: 'isométrica desde la cruceta' });
      });
      await test('sin errores de consola (vistas estándar)', async () => {
        assert(P.errors.length === 0, P.errors.join(' | '));
      });
      await P.context.close();
    }

    await test('sin errores de consola ni de página en el resto de sesiones', async () => {
      const lines = [];
      for (const h of handles) for (const e of h.errors) {
        // el aviso del guardado rechazado es intencional (la prueba fuerza un 500)
        if (h.name === 'vistas-error' && /500|disco lleno|vistas/i.test(e)) continue;
        lines.push(`[${h.name}] ${e}`);
      }
      assert(lines.length === 0, lines.slice(0, 8).join(' | '));
    });
  } finally {
    await browser.close().catch(() => {});
    for (const s of servers) await s.stop().catch(() => {});
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
