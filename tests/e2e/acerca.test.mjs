// Prueba E2E del diálogo "Acerca de" con el servidor REAL (server/index.js) y todos los módulos reales.
//
//   - presentador: Chromium en http://127.0.0.1:PUERTO (loopback => rol presenter)
//   - espectador: http://127.0.0.1:PUERTO/?role=viewer (el anfitrión previsualiza a un espectador)
//
// Cubre: apertura desde el botón de la cabecera y desde el logo; datos del autor (título, nombre, iniciales DB, correo mailto),
// versión de /api/info, licencias (MPL-2.0, GPL-3.0...); que NO haya GitHub ni filas de teléfono/colegiatura/etc.; Esc, foco
// atrapado y devuelto al botón; Esc sin limpiar la selección y sin atajos; diseño a 1600, 900 y 390 px; el espectador con la
// capa de bloqueo (abre y cierra el diálogo y el resto sigue bloqueado); que abrirlo en el presentador no cambie nada en el
// espectador ni envíe mensajes de sincronización; y acerca.json ausente, inválido o personalizado (se intercepta con page.route).
//
// Uso: node tests/e2e/acerca.test.mjs   (ACERCA_TEST_PORT cambia el puerto; 8400 por defecto)

import path from 'node:path';
import fs from 'node:fs';
import {
  startServer, launchBrowser, openPage, uploadFixture, assert, waitFor, getSlice, waitForApp, waitCameraSettled, OUTPUT, ROOT,
} from './helpers.mjs';

const PORT = Number(process.env.ACERCA_TEST_PORT || 8400);

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
    // Que un diálogo que quedó abierto no arrastre a las pruebas siguientes
    for (const h of handles) await h.page?.keyboard.press('Escape').catch(() => {});
  }
}

const shot = (page, name) => page.screenshot({ path: path.join(OUTPUT, `acerca-${name}.png`) });

async function open(browser, name, url, viewport) {
  const h = await openPage(browser, url, viewport ? { viewport } : undefined);
  h.name = name;
  handles.push(h);
  return h;
}

const ABOUT_BTN = '.status-cluster button[aria-label="Acerca de"]';
const DIALOG = '.about';

const dialogOpen = (page) => page.locator(DIALOG).count().then((n) => n > 0);
const waitDialog = (page, label = 'el diálogo Acerca de') => page.locator(DIALOG).waitFor({ state: 'visible', timeout: 5000 }).catch(() => { throw new Error(`no se abrió ${label}`); });
const waitClosed = (page) => waitFor(async () => !(await dialogOpen(page)), { timeout: 4000, label: 'el diálogo cerrado' });

// Foto de lo que NO debe cambiar al abrir/cerrar el diálogo
async function snapshot(page) {
  return page.evaluate(() => {
    const v = window.__visor;
    const s = v.store;
    return JSON.stringify({
      selection: s.get('selection'), visibility: s.get('visibility'), display: s.get('display'), storey: s.get('storey'),
      section: s.get('section'), measure: s.get('measure'), ui: s.get('ui'), models: s.get('models'), views: s.get('views'),
      cad: s.get('cad'), camera: v.viewer.getCameraState(),
    });
  });
}

// Qué hay en un punto de la página: 'lock' (capa de bloqueo), 'about' (tarjeta), 'backdrop' (fondo del diálogo) o la etiqueta del botón
function hit(page, x, y) {
  return page.evaluate(([px, py]) => {
    const el = document.elementFromPoint(px, py);
    if (!el) return 'nada';
    if (el.closest('.lock-layer')) return 'lock';
    if (el.closest('.about')) return 'about';
    if (el.classList.contains('about-backdrop')) return 'backdrop';
    return el.closest('button')?.getAttribute('aria-label') || el.className || el.tagName;
  }, [x, y]);
}

const center = (box) => ({ x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) });

// Abre una página con una respuesta simulada para /config/acerca.json (la ruta se instala ANTES de cargar la aplicación)
async function openWithAcerca(browser, url, respond) {
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  if (respond) await page.route('**/config/acerca.json', respond);
  await page.goto(url);
  await page.waitForFunction(() => document.documentElement.dataset.ready === 'true', null, { timeout: 30000 });
  return { context, page, errors };
}

async function openAbout(page) {
  await page.click(ABOUT_BTN);
  await waitDialog(page);
  await page.waitForTimeout(350); // termina la animación de entrada
}

async function run() {
  const server = await startServer({ port: PORT });
  const browser = await launchBrowser();
  console.log(`Acerca de: servidor real en ${server.url}`);

  try {
    await uploadFixture(server.url, 'edificio_georef_ifc4.ifc');
    const info = await (await fetch(`${server.url}/api/info`)).json();
    const P = await open(browser, 'presentador', server.url);
    const V = await open(browser, 'espectador', `${server.url}/?role=viewer`);
    for (const h of [P, V]) await waitForApp(h.page, { ifc: 1, cad: 0 });
    await P.context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: server.url }).catch(() => {});

    // ------------------------------------------------------------------ el archivo de datos
    await test('public/config/acerca.json: JSON válido con exactamente los campos acordados y sin GitHub', async () => {
      const file = path.join(ROOT, 'public', 'config', 'acerca.json');
      const raw = fs.readFileSync(file, 'utf8');
      const json = JSON.parse(raw);
      assert(JSON.stringify(Object.keys(json)) === JSON.stringify(['autor', 'aplicacion']), `claves de primer nivel: ${Object.keys(json)}`);
      assert(JSON.stringify(Object.keys(json.autor)) === JSON.stringify(['titulo', 'nombre', 'profesion', 'rol', 'correo']), `claves del autor: ${Object.keys(json.autor)}`);
      assert(JSON.stringify(Object.keys(json.aplicacion)) === JSON.stringify(['nombre', 'fase', 'descripcion', 'anio', 'hojaDeRuta']), `claves de la aplicación: ${Object.keys(json.aplicacion)}`);
      assert(json.autor.titulo === 'Ing. Civil' && json.autor.nombre === 'David Henry Bernilla Rodriguez', 'título y nombre exactos (sin tilde en Rodriguez)');
      assert(json.autor.correo === 'henrydavid.br.13@gmail.com' && json.autor.profesion === 'Ingeniero Civil', 'correo y profesión');
      assert(json.aplicacion.anio === 2026 && json.aplicacion.hojaDeRuta.length === 3, 'año y hoja de ruta');
      assert(!/github/i.test(raw), 'acerca.json no debe mencionar GitHub');
      // Y el servidor lo sirve tal cual
      const res = await fetch(`${server.url}/config/acerca.json`);
      assert(res.ok && (res.headers.get('content-type') || '').includes('json'), `GET /config/acerca.json: ${res.status} ${res.headers.get('content-type')}`);
      assert(JSON.stringify(await res.json()) === JSON.stringify(json), 'lo servido coincide con el archivo');
    });

    // ------------------------------------------------------------------ apertura y contenido
    await test('el botón de la cabecera abre el diálogo: autor, iniciales DB, correo, versión, red y licencias', async () => {
      const { page } = P;
      const btn = page.locator(ABOUT_BTN);
      assert(await btn.isVisible(), 'falta el botón Acerca de en la cabecera superior');
      assert((await btn.getAttribute('title')) === 'Acerca de', 'title="Acerca de"');
      // Va junto al botón de pantalla completa
      const [bFull, bAbout] = [await page.locator('.status-cluster button[aria-label="Pantalla completa"]').boundingBox(), await btn.boundingBox()];
      assert(Math.abs(bFull.y - bAbout.y) < 2 && Math.abs(bFull.x - bAbout.x) < 60, `el botón debe estar junto al de pantalla completa (${JSON.stringify(bFull)} / ${JSON.stringify(bAbout)})`);

      await openAbout(page);
      const d = page.locator(DIALOG);
      assert((await d.getAttribute('role')) === 'dialog' && (await d.getAttribute('aria-modal')) === 'true', 'role=dialog y aria-modal');
      const labelId = await d.getAttribute('aria-labelledby');
      assert(labelId, 'aria-labelledby');
      assert((await page.locator(`#${labelId}`).textContent()).includes('Visor IFC 5D'), 'aria-labelledby apunta al título');
      assert(await page.locator('.about__logo svg').isVisible(), 'logo de la app');

      // Autor
      assert((await page.locator('.about__degree').textContent()) === 'Ing. Civil', 'título "Ing. Civil"');
      assert((await page.locator('.about__name').textContent()) === 'David Henry Bernilla Rodriguez', 'nombre exacto');
      assert((await page.locator('.about__avatar').textContent()) === 'DB', 'iniciales DB');
      assert((await page.locator('.about__profession').textContent()) === 'Ingeniero Civil', 'profesión');
      assert((await page.locator('.about__role').textContent()) === 'Autor y desarrollador del Visor IFC 5D', 'rol');
      const mail = page.locator('a[href="mailto:henrydavid.br.13@gmail.com"]');
      assert((await mail.count()) === 1 && (await mail.textContent()) === 'henrydavid.br.13@gmail.com', 'correo con enlace mailto:');

      // Cabecera: aplicación, fase y versión de /api/info
      assert(info.version, '/api/info debe traer la versión');
      assert((await page.locator('.about__version').textContent()).includes(info.version), `versión ${info.version}`);
      assert((await page.locator('.about__phase').textContent()).includes('Fase 1'), 'fase');
      assert((await page.locator('.about__app-name').textContent()) === 'Visor IFC 5D', 'nombre de la aplicación');

      // Aplicación y red
      assert((await page.locator('.about__desc').textContent()).includes('seguimiento 5D'), 'descripción');
      assert((await page.locator('.about__role-badge').textContent()) === 'Presentador', 'rol de esta PC');
      const urls = await page.locator('.about__url-text').allTextContents();
      const lan = (await getSlice(page, 'presentation')).lanUrls;
      if (lan.length) {
        for (const u of lan) assert(urls.includes(u), `falta la URL de red ${u} (hay ${urls})`);
      } else {
        assert((await page.locator('.about__net .about__muted').count()) === 1, 'sin URLs de red debe indicarlo');
      }
      // Hoja de ruta
      const road = await page.locator('.about__road-item').allTextContents();
      assert(road.length === 3 && road[0].startsWith('Fase 2') && road[2] === 'Curva S y reportes de avance', `hoja de ruta: ${road}`);

      // Tecnologías y licencias
      const text = await d.innerText();
      for (const name of ['three.js', 'web-ifc', 'three-mesh-bvh', 'camera-controls', 'dxf-parser', 'LibreDWG', 'Express', 'ws', 'multer', 'Urbanist']) {
        assert(text.includes(name), `falta la tecnología ${name}`);
      }
      const lic = await page.locator('.about__tech-item').evaluateAll((els) => els.map((e) => `${e.querySelector('.about__tech-name').textContent}|${e.dataset.license}`));
      const expected = ['three.js|MIT', 'web-ifc|MPL-2.0', 'three-mesh-bvh|MIT', 'camera-controls|MIT', 'dxf-parser|MIT', 'LibreDWG (@mlightcad/libredwg-web)|GPL-3.0', 'Express|MIT', 'ws|MIT', 'multer|MIT', 'Urbanist|SIL OFL 1.1'];
      assert(JSON.stringify(lic) === JSON.stringify(expected), `licencias: ${lic.join(', ')}`);
      assert(text.includes('MPL-2.0') && text.includes('GPL-3.0'), 'debe mostrar MPL-2.0 y GPL-3.0');
      assert(/GPL.*redistribuir/i.test(await page.locator('.about__note').textContent()), 'nota breve sobre la GPL de LibreDWG');

      // Pie
      assert((await page.locator('.about__foot').textContent()) === '© 2026 Ing. Civil David Henry Bernilla Rodriguez', 'pie de página');
      await shot(page, '01-presentador');
      await page.keyboard.press('Escape');
      await waitClosed(page);
    });

    await test('sin GitHub (ni texto ni enlaces) y sin filas de teléfono, colegiatura ni otros datos no pedidos', async () => {
      const { page } = P;
      await openAbout(page);
      const html = (await page.locator(DIALOG).evaluate((el) => el.outerHTML)).toLowerCase();
      assert(!html.includes('github'), 'el diálogo no debe mencionar GitHub');
      assert((await page.locator(`${DIALOG} a[href*="github"]`).count()) === 0, 'ningún enlace a github.com');
      const hrefs = await page.locator(`${DIALOG} a[href]`).evaluateAll((els) => els.map((e) => e.getAttribute('href')));
      assert(JSON.stringify(hrefs) === JSON.stringify(['mailto:henrydavid.br.13@gmail.com']), `el único enlace debe ser el correo: ${hrefs}`);
      const fields = await page.locator('.about__contact').evaluateAll((els) => els.map((e) => e.dataset.field));
      assert(JSON.stringify(fields) === JSON.stringify(['correo']), `solo debe haber la fila de correo: ${fields}`);
      const author = (await page.locator('.about__author').innerText()).toLowerCase();
      for (const word of ['teléfono', 'telefono', 'colegiatura', 'empresa', 'ubicación', 'web', 'linkedin']) assert(!author.includes(word), `la tarjeta del autor no debe mostrar "${word}"`);
      await page.keyboard.press('Escape');
      await waitClosed(page);
    });

    await test('el botón copiar del correo copia la dirección y lo indica', async () => {
      const { page } = P;
      await openAbout(page);
      const btn = page.locator('.about__contact[data-field="correo"] .about__copy');
      await btn.click();
      await waitFor(() => btn.evaluate((el) => el.classList.contains('is-done')), { timeout: 3000, label: 'botón en estado copiado' });
      assert((await page.locator('.about__sr').textContent()) === 'Correo copiado', 'anuncio accesible');
      const clip = await page.evaluate(() => navigator.clipboard.readText()).catch(() => null);
      if (clip !== null) assert(clip === 'henrydavid.br.13@gmail.com', `portapapeles: ${clip}`);
      assert(await page.evaluate(() => !!document.activeElement.closest('.about')), 'el foco sigue dentro del diálogo tras copiar');
      await waitFor(() => btn.evaluate((el) => !el.classList.contains('is-done')), { timeout: 4000, label: 'el botón vuelve a su estado' });
      await page.keyboard.press('Escape');
      await waitClosed(page);
    });

    await test('el logo de la barra lateral abre el diálogo; × y clic en el fondo lo cierran y el foco vuelve al botón', async () => {
      const { page } = P;
      const logoBtn = page.locator('button.sidebar__logo');
      assert((await logoBtn.getAttribute('aria-label')).startsWith('Acerca de'), 'el logo debe ser un botón "Acerca de"');
      await logoBtn.click();
      await waitDialog(page, 'el diálogo desde el logo');
      assert(await page.evaluate(() => document.activeElement.classList.contains('about__close')), 'al abrir, el foco pasa al diálogo');
      await page.locator('.about__close').click();
      await waitClosed(page);
      assert(await page.evaluate(() => document.activeElement.classList.contains('sidebar__logo')), 'el foco debe volver al logo');

      // Clic en el fondo (fuera de la tarjeta)
      await openAbout(page);
      await page.mouse.click(6, 6);
      await waitClosed(page);
      assert(await page.evaluate(() => document.activeElement.classList.contains('about-btn')), 'el foco debe volver al botón de la cabecera');

      // Un arrastre que empieza dentro de la tarjeta y termina en el fondo NO cierra
      await openAbout(page);
      const box = await page.locator(DIALOG).boundingBox();
      await page.mouse.move(box.x + 40, box.y + box.height - 12);
      await page.mouse.down();
      await page.mouse.move(6, 6, { steps: 4 });
      await page.mouse.up();
      assert(await dialogOpen(page), 'soltar fuera un arrastre iniciado dentro no debe cerrar');
      await page.keyboard.press('Escape');
      await waitClosed(page);
    });

    await test('teclado: Enter abre, Esc cierra y el foco vuelve al botón', async () => {
      const { page } = P;
      await page.locator(ABOUT_BTN).focus();
      await page.keyboard.press('Enter');
      await waitDialog(page);
      await page.keyboard.press('Escape');
      await waitClosed(page);
      assert(await page.evaluate(() => document.activeElement === document.querySelector('.status-cluster button[aria-label="Acerca de"]')), 'el foco debe volver al botón Acerca de');
    });

    await test('el foco queda atrapado en el diálogo con Tab y Mayús+Tab', async () => {
      const { page } = P;
      await openAbout(page);
      const inside = () => page.evaluate(() => !!document.activeElement?.closest('.about'));
      const count = await page.evaluate(() => [...document.querySelectorAll('.about a[href], .about button:not([disabled])')].filter((e) => e.offsetParent).length);
      assert(count >= 3, `debería haber varios controles enfocables (${count})`);
      const first = await page.evaluate(() => document.activeElement.className);
      for (let i = 0; i < count * 2 + 3; i++) {
        await page.keyboard.press('Tab');
        assert(await inside(), `Tab ${i + 1}: el foco salió del diálogo`);
      }
      for (let i = 0; i < count * 2 + 3; i++) {
        await page.keyboard.press('Shift+Tab');
        assert(await inside(), `Mayús+Tab ${i + 1}: el foco salió del diálogo`);
      }
      // Desde el último control, Tab vuelve al primero (el botón ×)
      await page.evaluate(() => [...document.querySelectorAll('.about a[href], .about button:not([disabled])')].filter((e) => e.offsetParent).pop().focus());
      await page.keyboard.press('Tab');
      assert(await page.evaluate(() => document.activeElement.classList.contains('about__close')), `Tab desde el último control debe ir al primero (empezó en ${first})`);
      await page.keyboard.press('Shift+Tab');
      assert(await page.evaluate(() => document.activeElement.matches('.about a[href], .about button')) && (await inside()), 'Mayús+Tab desde el primero va al último');
      // Tras pulsar sobre texto no enfocable el foco sigue dentro
      await page.locator('.about__desc').click();
      await page.keyboard.press('Shift+Tab');
      assert(await inside(), 'Mayús+Tab tras un clic en el texto');
      await page.keyboard.press('Escape');
      await waitClosed(page);
    });

    // ------------------------------------------------------------------ Esc y atajos
    await test('Esc solo cierra el diálogo: no limpia la selección y los atajos no actúan con el diálogo abierto', async () => {
      const { page } = P;
      await page.evaluate(() => {
        const m = window.__visor.ifc.getModels()[0];
        window.__visor.actions.select([{ modelId: m.id, expressId: m.table.expressIds[0] }]);
      });
      assert((await getSlice(page, 'selection')).items.length === 1, 'hay una selección de partida');
      await waitCameraSettled(page);
      const before = await snapshot(page);

      await openAbout(page);
      await page.keyboard.press('Escape');
      await waitClosed(page);
      assert((await getSlice(page, 'selection')).items.length === 1, 'Esc no debe limpiar la selección existente');

      await openAbout(page);
      for (const key of ['h', 'i', 'Shift+H', 'f', 'm', 'p', '/', 'ArrowLeft']) await page.keyboard.press(key);
      await page.waitForTimeout(400);
      assert((await dialogOpen(page)), 'las teclas no cierran el diálogo');
      assert((await snapshot(page)) === before, 'ningún atajo debe cambiar el estado con el diálogo abierto');
      await page.keyboard.press('Escape');
      await waitClosed(page);
      assert((await snapshot(page)) === before, 'abrir y cerrar no cambia el estado');

      // Cerrado, Esc vuelve a limpiar la selección: los atajos siguen funcionando
      await page.keyboard.press('Escape');
      await waitFor(async () => (await getSlice(page, 'selection')).items.length === 0, { timeout: 3000, label: 'Esc limpia la selección con el diálogo cerrado' });
    });

    await test('Esc con una medición en curso solo cierra el diálogo', async () => {
      const { page } = P;
      await page.evaluate(() => window.__visor.actions.setMeasureActive(true));
      await waitFor(async () => (await getSlice(page, 'measure')).active, { timeout: 3000, label: 'medición activa' });
      await openAbout(page);
      await page.keyboard.press('Escape');
      await waitClosed(page);
      assert((await getSlice(page, 'measure')).active === true, 'Esc no debe salir del modo medición mientras cierra el diálogo');
      await page.evaluate(() => window.__visor.actions.setMeasureActive(false));
    });

    // ------------------------------------------------------------------ diseño
    await test('diseño: se desplaza si no cabe, no desborda y funciona a 900 px y en móvil', async () => {
      for (const [w, hgt, name] of [[1600, 900, '02-1600'], [900, 700, '03-900'], [390, 800, '04-movil']]) {
        const h = await open(browser, `diseno-${w}`, server.url, { width: w, height: hgt });
        await h.page.waitForFunction(() => document.documentElement.dataset.ready === 'true');
        await h.page.waitForTimeout(400);
        await openAbout(h.page);
        const m = await h.page.evaluate(() => {
          const card = document.querySelector('.about').getBoundingClientRect();
          const body = document.querySelector('.about__body');
          return {
            card: { x: card.x, y: card.y, w: card.width, h: card.height },
            sw: document.documentElement.scrollWidth, iw: window.innerWidth, sh: document.documentElement.scrollHeight, ih: window.innerHeight,
            bodyScroll: body.scrollHeight > body.clientHeight + 1, bodyOverflowX: body.scrollWidth > body.clientWidth + 1,
            overflowY: getComputedStyle(body).overflowY,
          };
        });
        assert(m.sw <= m.iw && m.sh <= m.ih, `desborde de página a ${w}px: ${JSON.stringify(m)}`);
        assert(m.card.x >= 0 && m.card.x + m.card.w <= w + 1 && m.card.y >= 0 && m.card.y + m.card.h <= hgt + 1, `la tarjeta debe caber en ${w}x${hgt}: ${JSON.stringify(m.card)}`);
        assert(m.card.h <= hgt * 0.86 + 1, `altura máxima ~86vh a ${w}px (${m.card.h} > ${hgt * 0.86})`);
        assert(!m.bodyOverflowX, `desborde horizontal dentro del diálogo a ${w}px`);
        assert(m.overflowY === 'auto' && m.bodyScroll, `con tanto contenido el cuerpo debe desplazarse a ${w}x${hgt} (${JSON.stringify(m)})`);
        // Al desplazar se llega a la última tecnología y al pie, que sigue visible
        await h.page.locator('.about__tech-item').last().scrollIntoViewIfNeeded();
        const vis = await h.page.evaluate(() => {
          const body = document.querySelector('.about__body').getBoundingClientRect();
          const last = document.querySelector('.about__tech-item:last-child').getBoundingClientRect();
          const foot = document.querySelector('.about__foot').getBoundingClientRect();
          return { lastInside: last.bottom <= body.bottom + 1 && last.top >= body.top - 1, footVisible: foot.bottom <= window.innerHeight + 1 };
        });
        assert(vis.lastInside && vis.footVisible, `tras desplazar: ${JSON.stringify(vis)}`);
        await shot(h.page, name);
        await h.page.keyboard.press('Escape');
        await waitClosed(h.page);
        await h.context.close();
      }
    });

    // ------------------------------------------------------------------ espectador con la capa de bloqueo
    await test('espectador con presentación activa: abre y cierra el Acerca de y la capa de bloqueo sigue impidiendo todo lo demás', async () => {
      await P.page.click('.btn--present');
      await waitFor(async () => (await getSlice(V.page, 'presentation')).active, { timeout: 8000, label: 'espectador EN VIVO' });
      await waitFor(() => V.page.locator('.lock-layer').isVisible(), { timeout: 5000, label: 'capa de bloqueo' });
      assert(!(await V.page.evaluate(() => window.__visor.viewer.inputEnabled)), 'viewer.enableInput(false)');
      await waitCameraSettled(V.page);
      const { page } = V;
      const before = await snapshot(page);
      const tab = center(await page.locator('.pill[data-tab="tree"]').boundingBox());
      const aboutBtn = center(await page.locator(ABOUT_BTN).boundingBox());

      // Antes: la capa recibe los clics (pestaña, árbol...) y el botón Acerca de queda por encima, como pantalla completa
      assert((await hit(page, tab.x, tab.y)) === 'lock', 'sobre la pestaña debe estar la capa de bloqueo');
      assert((await hit(page, aboutBtn.x, aboutBtn.y)) === 'Acerca de', 'el botón Acerca de debe quedar por encima de la capa');
      const full = center(await page.locator('.status-cluster button[aria-label="Pantalla completa"]').boundingBox());
      assert((await hit(page, full.x, full.y)) === 'Pantalla completa', 'pantalla completa sigue por encima de la capa');
      await page.mouse.click(tab.x, tab.y);
      assert((await getSlice(page, 'ui')).tab === 'models', 'el clic en la pestaña no debe cambiar store.ui.tab');

      // Abre con un clic real
      await page.mouse.click(aboutBtn.x, aboutBtn.y);
      await waitDialog(page, 'el diálogo en el espectador bloqueado');
      await page.waitForTimeout(350);
      assert(await page.locator('.lock-layer').isVisible(), 'la capa de bloqueo sigue activa debajo del diálogo');
      assert((await page.locator('.about__role-badge').textContent()) === 'Espectador', 'el rol de esta PC es Espectador');
      const card = center(await page.locator(DIALOG).boundingBox());
      assert((await hit(page, card.x, card.y)) === 'about', 'el diálogo debe estar por encima de la capa de bloqueo');
      assert((await hit(page, 8, 8)) === 'backdrop', 'el fondo del diálogo debe estar por encima de la capa de bloqueo');
      assert((await hit(page, tab.x, tab.y)) !== 'lock', 'con el diálogo abierto los clics ya no llegan ni a la capa');
      await shot(page, '05-espectador-bloqueado');

      // Con el diálogo abierto ningún atajo actúa y la rueda desplaza el diálogo, no el visor
      for (const key of ['h', 'i', 'Shift+H', 'f', 'm', 'p', '/', 'ArrowLeft']) await page.keyboard.press(key);
      await page.mouse.move(card.x, card.y);
      await page.mouse.wheel(0, 400);
      await page.waitForTimeout(300);
      assert((await page.locator('.about__body').evaluate((el) => el.scrollTop)) > 0, 'la rueda debe desplazar el cuerpo del diálogo');
      assert(await dialogOpen(page), 'las teclas no cierran el diálogo');
      assert((await snapshot(page)) === before, 'nada del estado ni de la cámara cambia con el diálogo abierto');

      // Esc cierra solo el diálogo
      await page.keyboard.press('Escape');
      await waitClosed(page);
      assert(await page.locator('.lock-layer').isVisible(), 'la capa de bloqueo sigue visible tras cerrar');
      assert(await page.evaluate(() => document.activeElement === document.querySelector('.status-cluster button[aria-label="Acerca de"]')), 'el foco vuelve al botón Acerca de');
      assert((await hit(page, tab.x, tab.y)) === 'lock', 'al cerrar, la capa vuelve a recibir los clics');
      await page.mouse.click(tab.x, tab.y);
      await page.mouse.dblclick(tab.x, tab.y);
      for (const key of ['h', 'i', 'f', 'm', 'Escape']) await page.keyboard.press(key);
      assert((await getSlice(page, 'ui')).tab === 'models', 'tras cerrar, un clic en la pestaña sigue sin cambiar store.ui.tab');
      assert(!(await page.evaluate(() => window.__visor.viewer.inputEnabled)), 'el visor sigue sin admitir entrada');

      // Se puede abrir y cerrar de nuevo con teclado, con × y con un clic en el fondo
      await page.locator(ABOUT_BTN).focus();
      await page.keyboard.press('Enter');
      await waitDialog(page);
      await page.locator('.about__close').click();
      await waitClosed(page);
      await page.mouse.click(aboutBtn.x, aboutBtn.y);
      await waitDialog(page);
      await page.mouse.click(8, 8);
      await waitClosed(page);
      assert(await page.locator('.lock-layer').isVisible(), 'la capa sigue bloqueando tras cerrar con el fondo');
      await page.waitForTimeout(400);
      assert((await snapshot(page)) === before, 'el espectador no cambió nada al abrir y cerrar el Acerca de');
      assert(!(await getSlice(page, 'presentation')).isActivePresenter, 'el espectador no debe volverse presentador');
    });

    await test('abrir el Acerca de en el presentador no cambia nada en el espectador ni envía mensajes de sincronización', async () => {
      const { page: p } = P;
      const { page: v } = V;
      assert((await getSlice(p, 'presentation')).isActivePresenter, 'el presentador sigue activo');
      await waitCameraSettled(p);
      await waitCameraSettled(v);
      await p.evaluate(() => {
        window.__sent = [];
        const original = WebSocket.prototype.send;
        WebSocket.prototype.send = function patched(data) {
          try { window.__sent.push(JSON.parse(data).t); } catch { window.__sent.push('?'); }
          return original.call(this, data);
        };
      });
      await p.waitForTimeout(500);
      const sync0 = () => p.evaluate(() => window.__sent.filter((t) => t !== 'ping'));
      const baseSent = (await sync0()).length;
      const vBefore = await snapshot(v);
      const vPres = JSON.stringify(await getSlice(v, 'presentation'));
      const pUi = JSON.stringify(await getSlice(p, 'ui'));

      await openAbout(p);
      assert((await p.locator('.about__role-badge').textContent()) === 'Presentador', 'rol del presentador');
      assert(!JSON.stringify(await getSlice(p, 'ui')).toLowerCase().includes('about'), 'el estado del diálogo no debe estar en store.ui');
      assert(await p.evaluate(() => !JSON.stringify(window.__visor.store.get('presentation')).toLowerCase().includes('about')), 'ni en store.presentation');
      await p.waitForTimeout(900);
      assert((await v.locator(DIALOG).count()) === 0, 'el espectador no debe ver el diálogo');
      assert((await snapshot(v)) === vBefore, 'el espectador no debe cambiar mientras el presentador tiene el Acerca de abierto');
      await p.keyboard.press('Escape');
      await waitClosed(p);
      await p.waitForTimeout(700);
      assert((await snapshot(v)) === vBefore, 'ni al cerrarlo');
      assert(JSON.stringify(await getSlice(v, 'presentation')) === vPres, 'la presentación del espectador no cambia');
      assert(JSON.stringify(await getSlice(p, 'ui')) === pUi, 'store.ui del presentador no cambia');
      const sent = (await sync0()).slice(baseSent);
      assert(sent.length === 0, `abrir y cerrar el Acerca de no debe enviar mensajes de sincronización: ${sent}`);
      assert((await v.locator('.lock-layer').isVisible()), 'el espectador sigue bloqueado');

      await P.page.locator('.status-cluster button:has-text("Detener")').click();
      await waitFor(async () => !(await getSlice(v, 'presentation')).active, { timeout: 6000, label: 'espectador sin presentación' });
    });

    // ------------------------------------------------------------------ utilidades puras
    await test('utilidades: iniciales y enlaces seguros', async () => {
      const r = await P.page.evaluate(async () => {
        const m = await import('/js/ui/AboutDialog.js');
        return {
          ini: ['David Henry Bernilla Rodriguez', 'María de los Ángeles Pérez López', 'Ana Pérez', 'Ana', '  ', 'juan carlos  perez  gomez'].map(m.inicialesDe),
          web: ['https://ejemplo.com/a', 'www.ejemplo.com', 'javascript:alert(1)', 'data:text/html,x', 'ftp://ejemplo.com', '', 'http://'].map(m.hrefWeb),
          tel: ['+51 (999) 111-222', '12', '999 111 222', ''].map(m.hrefTelefono),
          mail: ['a@b.co', 'a b@c.co', 'a@b', '"x"@b.co'].map(m.hrefCorreo),
          norm: m.normalizarAcerca({ autor: { nombre: '   ' }, aplicacion: { anio: 'x', hojaDeRuta: 'no' } }),
          vacio: m.normalizarAcerca(null),
        };
      });
      assert(JSON.stringify(r.ini) === JSON.stringify(['DB', 'MP', 'AP', 'A', '', 'JP']), `iniciales: ${JSON.stringify(r.ini)}`);
      assert(JSON.stringify(r.web) === JSON.stringify(['https://ejemplo.com/a', 'https://www.ejemplo.com/', null, null, null, null, null]), `hrefWeb: ${JSON.stringify(r.web)}`);
      assert(JSON.stringify(r.tel) === JSON.stringify(['tel:+51999111222', null, 'tel:999111222', null]), `hrefTelefono: ${JSON.stringify(r.tel)}`);
      assert(JSON.stringify(r.mail) === JSON.stringify(['mailto:a@b.co', null, null, null]), `hrefCorreo: ${JSON.stringify(r.mail)}`);
      assert(r.norm.autor.nombre === 'David Henry Bernilla Rodriguez' && r.norm.aplicacion.anio === 2026 && r.norm.aplicacion.hojaDeRuta.length === 0, `normalización: ${JSON.stringify(r.norm)}`);
      assert(r.vacio.autor.nombre === 'David Henry Bernilla Rodriguez' && r.vacio.aplicacion.hojaDeRuta.length === 3, 'null -> valores por defecto');
    });

    // ------------------------------------------------------------------ acerca.json ausente, inválido o personalizado
    const DEFAULTS_OK = async (page, label) => {
      await openAbout(page);
      assert((await page.locator('.about__degree').textContent()) === 'Ing. Civil', `${label}: título por defecto`);
      assert((await page.locator('.about__name').textContent()) === 'David Henry Bernilla Rodriguez', `${label}: nombre por defecto`);
      assert((await page.locator('.about__avatar').textContent()) === 'DB', `${label}: iniciales por defecto`);
      assert((await page.locator('a[href="mailto:henrydavid.br.13@gmail.com"]').count()) === 1, `${label}: correo por defecto`);
      assert((await page.locator('.about__road-item').count()) === 3, `${label}: hoja de ruta por defecto`);
      assert((await page.locator('.about__tech-item').count()) === 10, `${label}: licencias`);
      assert((await page.locator('.about__foot').textContent()) === '© 2026 Ing. Civil David Henry Bernilla Rodriguez', `${label}: pie por defecto`);
      assert(!(await page.locator(DIALOG).innerText()).toLowerCase().includes('github'), `${label}: sin GitHub`);
    };

    await test('acerca.json ausente (404): usa los valores por defecto sin romperse', async () => {
      const h = await openWithAcerca(browser, server.url, (route) => route.fulfill({ status: 404, contentType: 'text/plain', body: 'No encontrado' }));
      handles.push({ ...h, name: 'json-404' });
      await DEFAULTS_OK(h.page, '404');
      await shot(h.page, '06-json-ausente');
      // El 404 del propio archivo es lo único que el navegador registra como error de consola
      const other = h.errors.filter((e) => !/Failed to load resource/.test(e));
      assert(other.length === 0, `errores de consola: ${other.join(' | ')}`);
      h.errors.length = 0;
      await h.context.close();
    });

    for (const [nombre, cuerpo] of [['texto inválido', '{ esto no es json,, '], ['JSON de otro tipo (lista)', '[1, 2, 3]'], ['HTML en lugar de JSON', '<!doctype html><title>x</title>']]) {
      await test(`acerca.json con ${nombre}: usa los valores por defecto sin romperse`, async () => {
        const h = await openWithAcerca(browser, server.url, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: cuerpo }));
        handles.push({ ...h, name: `json-${nombre}` });
        await DEFAULTS_OK(h.page, nombre);
        await h.context.close();
      });
    }

    await test('acerca.json personalizado: muestra las filas opcionales solo con enlaces seguros y se vuelve a leer al abrir', async () => {
      const custom = {
        autor: {
          titulo: 'Arq.', nombre: 'Ana María Pérez Gómez', profesion: 'Arquitecta', rol: 'Coordinadora BIM', correo: 'ana@example.com',
          telefono: '+51 999 111 222', colegiatura: 'CAP 12345', empresa: 'Estudio X', ubicacion: 'Lima, Perú',
          web: 'https://example.com/ana', linkedin: 'javascript:alert(1)',
        },
        aplicacion: { nombre: 'Mi Visor', fase: '', anio: 2031, hojaDeRuta: [] },
      };
      let current = null; // null = el archivo real
      const h = await openWithAcerca(browser, server.url, (route) => (current ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(current) }) : route.continue()));
      handles.push({ ...h, name: 'json-personalizado' });
      const { page } = h;
      await DEFAULTS_OK(page, 'archivo real');
      await page.keyboard.press('Escape');
      await waitClosed(page);

      current = custom; // se edita el archivo con la página ya cargada: al abrir se vuelve a leer
      await page.click(ABOUT_BTN);
      await waitDialog(page);
      await waitFor(async () => (await page.locator('.about__name').textContent()) === 'Ana María Pérez Gómez', { timeout: 5000, label: 'datos nuevos del archivo' });
      assert((await page.locator('.about__degree').textContent()) === 'Arq.', 'título nuevo');
      assert((await page.locator('.about__avatar').textContent()) === 'AP', 'iniciales de Ana María Pérez Gómez');
      assert((await page.locator('.about__app-name').textContent()) === 'Mi Visor', 'nombre de la aplicación');
      assert((await page.locator('.about__phase').count()) === 1 && (await page.locator('.about__phase').isHidden()), 'la fase vacía no se muestra');
      assert((await page.locator('.about__road').count()) === 0, 'una hoja de ruta vacía oculta la sección');
      assert((await page.locator('.about__foot').textContent()) === '© 2031 Arq. Ana María Pérez Gómez', 'pie con año y nombre nuevos');
      const fields = await page.locator('.about__contact').evaluateAll((els) => els.map((e) => e.dataset.field));
      assert(JSON.stringify(fields) === JSON.stringify(['correo', 'telefono', 'colegiatura', 'empresa', 'ubicacion', 'web', 'linkedin']), `filas: ${fields}`);
      const tel = page.locator('a[href^="tel:"]');
      assert((await tel.getAttribute('href')) === 'tel:+51999111222', 'enlace tel:');
      const web = page.locator('.about__contact[data-field="web"] a');
      assert((await web.getAttribute('href')) === 'https://example.com/ana' && (await web.getAttribute('target')) === '_blank', 'la web se abre en una pestaña nueva');
      const rel = (await web.getAttribute('rel')).split(/\s+/);
      assert(rel.includes('noopener') && rel.includes('noreferrer'), `rel="noopener noreferrer": ${rel}`);
      assert((await page.locator('.about__contact[data-field="linkedin"] a').count()) === 0, 'javascript: no genera enlace');
      assert((await page.locator('.about__contact[data-field="linkedin"]').innerText()).includes('javascript:alert(1)'), 'se muestra como texto');
      assert((await page.locator(`${DIALOG} a[href^="javascript"]`).count()) === 0, 'ningún enlace javascript:');
      assert((await page.locator('.about__contact[data-field="colegiatura"]').innerText()).includes('CAP 12345'), 'colegiatura');
      await page.waitForTimeout(400); // termina el fundido de entrada antes de la captura
      await shot(page, '07-json-personalizado');
      await page.keyboard.press('Escape');
      await waitClosed(page);
      await h.context.close();
    });

    await test('sin errores de consola ni de página en ninguna pantalla', async () => {
      const lines = [];
      for (const h of handles) for (const e of h.errors) lines.push(`[${h.name}] ${e}`);
      assert(lines.length === 0, lines.slice(0, 8).join(' | '));
    });
  } finally {
    await browser.close().catch(() => {});
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
