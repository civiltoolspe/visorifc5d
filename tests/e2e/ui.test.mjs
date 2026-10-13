// Pruebas E2E de la interfaz (public/js/ui) con el contexto simulado public/dev/ui-mock.html.
// store/bus/actions son los reales; viewer, ifc, cad, loader, presentation y api son dobles.
// Uso: node tests/e2e/ui.test.mjs   (código de salida 0 = todo bien, 1 = algo falló)
import path from 'node:path';
import { startDevServer } from '../devserver.mjs';
import { launchBrowser, openPage, assert, waitFor, OUTPUT } from './helpers.mjs';

const PORT = Number(process.env.UI_TEST_PORT || 8106);
const IFC = 'ifcmock001';
const CAD = 'cadmock002';

const results = [];
let server;
let browser;

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

const url = (query = '') => `http://127.0.0.1:${PORT}/dev/ui-mock.html${query}`;
const shot = (page, name) => page.screenshot({ path: path.join(OUTPUT, `ui-${name}.png`) });

// Abre la UI simulada y espera a que monte
async function openMock(query = '', viewport = { width: 1600, height: 900 }) {
  const handle = await openPage(browser, url(query), { viewport });
  await handle.page.waitForFunction(() => document.documentElement.dataset.ready === 'true', null, { timeout: 20000 });
  await handle.page.waitForTimeout(250);
  return handle;
}

const state = (page, slice) => page.evaluate((s) => JSON.parse(JSON.stringify(window.__mock.store.get(s))), slice);
const viewerCalls = (page) => page.evaluate(() => window.__mock.viewer.calls.map((c) => c[0]));

async function run() {
  server = await startDevServer(PORT);
  browser = await launchBrowser();
  console.log(`UI: servidor de pruebas en el puerto ${PORT}`);

  // ------------------------------------------------------------------ montaje y pestañas
  await test('monta sin errores de consola y muestra los elementos principales', async () => {
    const { page, errors, context } = await openMock();
    for (const sel of ['.sidebar', '.header__title', '.toolbar-col', '.zoom', '.orbit', '.level', '.dock', '.status-cluster']) {
      assert(await page.locator(sel).first().isVisible(), `falta ${sel}`);
    }
    assert((await page.locator('.header__title').textContent()).includes('Edificio Residencial'), 'el título no usa ifc.getProjectInfo()');
    assert((await page.locator('html').getAttribute('lang')) === 'es', 'lang=es');
    const fontOk = await page.evaluate(() => document.fonts.check('300 20px Urbanist'));
    assert(fontOk, 'la fuente Urbanist no cargó');
    await shot(page, '01-inicio');
    assert(errors.length === 0, `errores de consola: ${errors.join(' | ')}`);
    await context.close();
  });

  await test('cambiar de pestaña actualiza store.ui.tab y el contenido', async () => {
    const { page, errors, context } = await openMock();
    for (const [tab, panel] of [['tree', '.tab--tree'], ['props', '.tab--props'], ['layers', '.tab--layers'], ['views', '.tab--views'], ['models', '.tab--models']]) {
      await page.click(`.pill[data-tab="${tab}"]`);
      assert((await state(page, 'ui')).tab === tab, `store.ui.tab debería ser ${tab}`);
      await waitFor(() => page.locator(panel).isVisible(), { timeout: 3000, label: `panel ${tab}` });
      assert((await page.locator(`.pill[data-tab="${tab}"]`).getAttribute('aria-selected')) === 'true', `aria-selected en ${tab}`);
    }
    // El estado remoto (presentador) también cambia la pestaña
    await page.evaluate(() => window.__mock.store.patch('ui', { tab: 'layers' }, { source: 'remote' }));
    await waitFor(() => page.locator('.tab--layers').isVisible(), { timeout: 3000, label: 'pestaña por estado remoto' });
    assert(errors.length === 0, `errores de consola: ${errors.join(' | ')}`);
    await context.close();
  });

  await test('barra lateral: ocultar y volver a mostrar desde el store', async () => {
    const { page, context } = await openMock();
    await page.click('.sidebar__icons button[aria-label="Ocultar la barra lateral"]');
    assert((await state(page, 'ui')).sidebarOpen === false, 'sidebarOpen=false');
    await waitFor(() => page.evaluate(() => document.querySelector('.ui').dataset.sidebar === 'closed'), { timeout: 3000, label: 'data-sidebar' });
    await page.click('.sidebar-reopen');
    assert((await state(page, 'ui')).sidebarOpen === true, 'sidebarOpen=true');
    await context.close();
  });

  // ------------------------------------------------------------------ árbol y selección
  await test('árbol: seleccionar actualiza store.selection y muestra la tarjeta oscura', async () => {
    const { page, errors, context } = await openMock();
    await page.click('.pill[data-tab="tree"]');
    await page.waitForSelector('.tab--tree .trow');
    // Nivel 2 está colapsado por defecto; se expande
    const storeyRow = page.locator('.trow', { hasText: 'Nivel 2' }).first();
    await storeyRow.click();
    const element = page.locator('.tab--tree .trow:not(.is-spatial)').first();
    await element.waitFor();
    const name = (await element.locator('.trow__name').textContent()).trim();
    await element.click();
    const sel = await state(page, 'selection');
    assert(sel.items.length === 1, `selection.items debería tener 1 elemento (${sel.items.length})`);
    await waitFor(() => page.locator('.sel').isVisible(), { timeout: 3000, label: 'tarjeta oscura' });
    assert((await page.locator('.sel__name').textContent()).trim() === name, 'el nombre de la tarjeta no coincide');
    assert((await page.locator('.sel__sub').textContent()).includes('Nivel 2'), 'la tarjeta debería indicar el nivel');
    await waitFor(() => element.evaluate((el) => el.classList.contains('is-selected')), { timeout: 3000, label: 'fila resaltada' });
    // Ctrl + clic añade a la selección
    await page.locator('.tab--tree .trow:not(.is-spatial)').nth(1).click({ modifiers: ['Control'] });
    assert((await state(page, 'selection')).items.length === 2, 'Ctrl+clic debería añadir');
    await waitFor(() => page.locator('.sel__name').textContent().then((t) => t.includes('2 elementos')), { timeout: 3000, label: 'N elementos' });
    await shot(page, '02-arbol-seleccion');
    assert(errors.length === 0, `errores de consola: ${errors.join(' | ')}`);
    await context.close();
  });

  await test('árbol: "mostrar más" con más de 300 hijos, doble clic encuadra y el ojo oculta/muestra', async () => {
    const { page, context } = await openMock();
    await page.click('.pill[data-tab="tree"]');
    await page.locator('.trow', { hasText: 'Nivel 1' }).first().click();
    await page.waitForSelector('.tmore');
    const before = await page.locator('.tab--tree .trow:not(.is-spatial)').count();
    assert(before === 300, `deberían dibujarse 300 hijos (hay ${before})`);
    await page.click('.tmore');
    const after = await page.locator('.tab--tree .trow:not(.is-spatial)').count();
    assert(after === 600, `tras "mostrar más" deberían ser 600 (hay ${after})`);

    const row = page.locator('.tab--tree .trow:not(.is-spatial)').first();
    await row.dblclick();
    assert((await viewerCalls(page)).includes('fitToBox'), 'doble clic debería llamar a viewer.fitToBox');

    await row.hover();
    await row.locator('.trow__eye').click();
    let vis = await state(page, 'visibility');
    assert(Object.values(vis.hidden).flat().length === 1, 'el ojo debería ocultar un elemento');
    await waitFor(() => row.evaluate((el) => el.classList.contains('is-hidden')), { timeout: 3000, label: 'fila oculta' });
    await row.locator('.trow__eye').click();
    vis = await state(page, 'visibility');
    assert(Object.values(vis.hidden).flat().length === 0, 'el ojo debería volver a mostrar');
    // Ojo de un nivel completo
    const storey = page.locator('.trow.is-spatial', { hasText: 'Nivel 1' }).first();
    await storey.hover();
    await storey.locator('.trow__eye').click();
    vis = await state(page, 'visibility');
    assert(Object.values(vis.hidden).flat().length === 650, `ocultar el nivel debería ocultar 650 (${Object.values(vis.hidden).flat().length})`);
    await storey.locator('.trow__eye').click();
    vis = await state(page, 'visibility');
    assert(Object.values(vis.hidden).flat().length === 0, 'mostrar el nivel debería quitar todos');
    await context.close();
  });

  await test('árbol: la selección hecha en el visor se revela y resalta en el árbol', async () => {
    const { page, context } = await openMock();
    await page.click('.pill[data-tab="tree"]');
    const id = await page.evaluate(() => window.__mock.STOREYS[3].expressId + 5);
    await page.evaluate((expressId) => window.__mock.actions.select([{ modelId: 'ifcmock001', expressId }]), id);
    await waitFor(() => page.locator('.trow.is-selected').count().then((n) => n === 1), { timeout: 4000, label: 'fila seleccionada revelada' });
    const inView = await page.locator('.trow.is-selected').evaluate((el) => {
      const r = el.getBoundingClientRect();
      const c = el.closest('.sidebar__content').getBoundingClientRect();
      return r.top >= c.top - 1 && r.bottom <= c.bottom + 1;
    });
    assert(inView, 'la fila seleccionada debería quedar a la vista');
    await context.close();
  });

  await test('árbol: el filtro muestra solo coincidencias', async () => {
    const { page, context } = await openMock();
    await page.click('.pill[data-tab="tree"]');
    await page.fill('.tab--tree .input--search', 'mesa comedor');
    await waitFor(() => page.locator('.tab--tree .trow:not(.is-spatial)').count().then((n) => n > 0 && n < 100), { timeout: 4000, label: 'filtro' });
    const names = await page.locator('.tab--tree .trow:not(.is-spatial) .trow__name').allTextContents();
    assert(names.every((n) => n.toLowerCase().includes('mesa comedor')), 'todas las filas deberían coincidir');
    await context.close();
  });

  // ------------------------------------------------------------------ propiedades
  await test('propiedades: secciones, buscador y botón de GlobalId', async () => {
    const { page, errors, context } = await openMock();
    await page.evaluate(() => window.__mock.actions.select([{ modelId: 'ifcmock001', expressId: 150 }]));
    await page.click('.pill[data-tab="props"]');
    await page.waitForSelector('.psec');
    assert((await page.locator('.psec').count()) >= 4, 'debería haber varias secciones');
    assert((await page.locator('.props-guid__code').textContent()).length >= 20, 'GlobalId visible');
    assert(await page.locator('button[aria-label="Copiar GlobalId"], button[title="Copiar GlobalId"]').first().isVisible(), 'botón copiar GlobalId');
    // Plegar / desplegar
    const head = page.locator('.psec__head').first();
    const body = page.locator('.psec').first().locator('.psec__body');
    const open = await body.isVisible();
    await head.click();
    assert((await body.isVisible()) !== open, 'la sección debería plegarse');
    // Buscador
    await page.fill('.props-search input', 'FireRating');
    await waitFor(() => page.locator('.prop:visible').count().then((n) => n === 1), { timeout: 3000, label: 'filtro de propiedades' });
    await shot(page, '03-propiedades');
    assert(errors.length === 0, `errores de consola: ${errors.join(' | ')}`);
    await context.close();
  });

  // ------------------------------------------------------------------ atajos
  await test('atajos: H oculta la selección, I aísla, Mayús+H muestra todo, Esc limpia, F/M/P', async () => {
    const { page, context } = await openMock();
    const pick = (expressId) => page.evaluate((id) => window.__mock.actions.select([{ modelId: 'ifcmock001', expressId: id }]), expressId);
    await pick(300);
    await page.keyboard.press('h');
    let vis = await state(page, 'visibility');
    assert(vis.hidden[IFC]?.includes(300), 'H debería ocultar el elemento seleccionado');
    assert((await state(page, 'selection')).items.length === 0, 'H limpia la selección');
    await page.keyboard.press('Shift+H');
    vis = await state(page, 'visibility');
    assert(Object.keys(vis.hidden).length === 0 || vis.hidden[IFC]?.length === 0, 'Mayús+H debería mostrar todo');
    await pick(301);
    await page.keyboard.press('i');
    vis = await state(page, 'visibility');
    assert(vis.isolated?.[IFC]?.includes(301), 'I debería aislar');
    await page.keyboard.press('Shift+H');
    assert((await state(page, 'visibility')).isolated === null, 'Mayús+H quita el aislamiento');
    await pick(302);
    await page.keyboard.press('Escape');
    assert((await state(page, 'selection')).items.length === 0, 'Esc debería limpiar la selección');
    await pick(303);
    await page.keyboard.press('f');
    assert((await viewerCalls(page)).includes('fitToBox'), 'F con selección encuadra la selección');
    await page.keyboard.press('Escape');
    await page.keyboard.press('f');
    assert((await viewerCalls(page)).includes('fitAll'), 'F sin selección encuadra todo');
    await page.keyboard.press('m');
    assert((await state(page, 'measure')).active === true, 'M activa la medición');
    await page.keyboard.press('Escape');
    assert((await state(page, 'measure')).active === false, 'Esc sale del modo medición');
    await page.keyboard.press('p');
    assert((await state(page, 'presentation')).active === true, 'P inicia la presentación');
    await page.keyboard.press('p');
    assert((await state(page, 'presentation')).active === false, 'P detiene la presentación');
    // Con el foco en un campo de texto los atajos no actúan
    await pick(304);
    await page.click('.search__input');
    await page.keyboard.type('hi');
    assert((await state(page, 'selection')).items.length === 1, 'escribir en el buscador no debe disparar atajos');
    await context.close();
  });

  await test('tarjeta de selección: ocultar, aislar y mostrar todo con los botones', async () => {
    const { page, context } = await openMock();
    await page.evaluate(() => window.__mock.actions.select([{ modelId: 'ifcmock001', expressId: 200 }]));
    await page.waitForSelector('.sel:not([hidden])');
    await page.click('.sel-act--yellow');
    assert((await state(page, 'visibility')).isolated?.[IFC]?.includes(200), 'el botón Aislar aísla');
    await page.click('.sel-act--grey');
    assert((await state(page, 'visibility')).isolated === null, 'Mostrar todo quita el aislamiento');
    await page.click('.sel-act--orange');
    assert((await state(page, 'visibility')).hidden[IFC]?.includes(200), 'el botón Ocultar oculta');
    await page.evaluate(() => window.__mock.actions.select([{ modelId: 'ifcmock001', expressId: 201 }]));
    await page.click('.sel .btn[aria-label="Ver propiedades del elemento"]');
    assert((await state(page, 'ui')).tab === 'props', 'la flecha lleva a Propiedades');
    await context.close();
  });

  // ------------------------------------------------------------------ herramientas
  await test('herramientas: aristas, planta/3D, medir, sección y ajustes de selección', async () => {
    const { page, errors, context } = await openMock();
    const edges0 = (await state(page, 'display')).edges;
    await page.click('.tool[data-tool="edges"]');
    assert((await state(page, 'display')).edges === !edges0, 'aristas alterna');
    await page.click('.tool[data-tool="proj"]');
    assert((await state(page, 'display')).projection === 'orthographic', 'planta = ortogonal');
    assert((await viewerCalls(page)).includes('setView'), 'planta pide viewer.setView');
    await page.click('.tool[data-tool="proj"]');
    assert((await state(page, 'display')).projection === 'perspective', 'vuelve a perspectiva');
    await page.click('.tool[data-tool="measure"]');
    assert((await state(page, 'measure')).active === true, 'medir activa');
    await waitFor(() => page.locator('.measure-info').isVisible(), { timeout: 3000, label: 'ayuda de medición' });
    await page.click('.tool[data-tool="measure"]');
    assert((await state(page, 'measure')).active === false, 'medir se desactiva');

    // Sección con deslizadores
    await page.click('.tool[data-tool="section"]');
    assert((await state(page, 'section')).enabled === true, 'sección activa');
    await waitFor(() => page.locator('.section-panel').isVisible(), { timeout: 3000, label: 'panel de sección' });
    assert((await page.locator('.section-panel input[type=range]').count()) === 6, 'seis deslizadores');
    await page.evaluate(() => window.__mock.actions.setSection({ min: [-20, 0, -15], max: [20, 10, 15] }));
    await page.waitForTimeout(100);
    const before = await state(page, 'section');
    await page.locator('.section-panel .axis-row').nth(1).locator('.dual__in--max').evaluate((el) => {
      el.value = '0.5';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const after = await state(page, 'section');
    assert(after.max[1] < before.max[1], `el deslizador de altura debería bajar el máximo (${before.max[1]} -> ${after.max[1]})`);
    await shot(page, '04-seccion');
    await page.click('.section-panel button[aria-label="Desactivar la sección"]');
    assert((await state(page, 'section')).enabled === false, 'sección se desactiva');

    // Ajustes de selección
    await page.click('.tool[data-tool="sel"]');
    await page.click('.seg__btn[data-value="isolate"]');
    assert((await state(page, 'display')).selectionMode === 'isolate', 'modo aislar');
    await page.click('.seg__btn[data-value="highlight"]');
    assert((await state(page, 'display')).selectionMode === 'highlight', 'modo resaltar');
    await page.click('.seg__btn[data-value="ghost"]');
    await page.locator('.popover .range').evaluate((el) => {
      el.value = '0.4';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    assert(Math.abs((await state(page, 'display')).ghostOpacity - 0.4) < 1e-6, 'opacidad del resto');
    await shot(page, '05-ajustes-seleccion');
    await page.keyboard.press('Escape');
    await waitFor(() => page.locator('.popover:visible').count().then((n) => n === 0), { timeout: 3000, label: 'popover cerrado con Esc' });

    // Captura descargable
    const [download] = await Promise.all([page.waitForEvent('download', { timeout: 5000 }), page.click('.tool[data-tool="shot"]')]);
    assert(/^visor-ifc-5d_\d{8}-\d{6}\.jpg$/.test(download.suggestedFilename()), `nombre de captura: ${download.suggestedFilename()}`);
    await waitFor(() => page.locator('.thumb.has-image').count().then((n) => n === 1), { timeout: 3000, label: 'miniatura de captura' });
    assert(errors.length === 0, `errores de consola: ${errors.join(' | ')}`);
    await context.close();
  });

  await test('zoom y cruceta llaman al visor', async () => {
    const { page, context } = await openMock();
    await page.click('.zoom button[aria-label="Acercar"]');
    await page.click('.zoom button[aria-label="Alejar"]');
    await page.click('.orbit__left');
    await page.click('.orbit__up');
    const calls = await page.evaluate(() => window.__mock.viewer.calls.filter((c) => ['zoomStep', 'orbitStep'].includes(c[0])));
    assert(calls.some((c) => c[0] === 'zoomStep' && c[1] === 1), 'zoomStep(+1)');
    assert(calls.some((c) => c[0] === 'zoomStep' && c[1] === -1), 'zoomStep(-1)');
    assert(calls.filter((c) => c[0] === 'orbitStep').length >= 2, 'orbitStep');
    await context.close();
  });

  // ------------------------------------------------------------------ nivel
  await test('selector de nivel: ▲▼, "Todos", modo corte/solo y altura de corte', async () => {
    const { page, context } = await openMock();
    await page.click('.level__step[aria-label="Subir un nivel"]');
    let st = await state(page, 'storey');
    assert(st.active?.modelId === IFC, 'subir desde Todos activa el primer nivel');
    const first = st.active.expressId;
    assert((await page.locator('.level__num').textContent()).trim() === '01', 'número 01');
    await page.click('.level__step[aria-label="Subir un nivel"]');
    st = await state(page, 'storey');
    assert(st.active.expressId !== first, 'sube de nivel');
    assert((await page.locator('.level__num').textContent()).trim() === '02', 'número 02');
    await page.click('.seg--sm .seg__btn[data-value="only"]');
    assert((await state(page, 'storey')).mode === 'only', 'modo solo');
    await page.click('.seg--sm .seg__btn[data-value="cut"]');
    await page.locator('.level__cut .range').evaluate((el) => {
      el.value = '2.2';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    assert(Math.abs((await state(page, 'storey')).cutHeight - 2.2) < 1e-6, 'altura de corte');
    await waitFor(() => page.locator('.level__thumb-img').isVisible(), { timeout: 4000, label: 'miniatura en planta' });
    assert((await page.evaluate(() => window.__mock.viewer.calls.some((c) => c[0] === 'renderTopView'))), 'usa viewer.renderTopView');
    await page.click('.level__name');
    await page.locator('.level-list__item', { hasText: 'Todos los niveles' }).click();
    assert((await state(page, 'storey')).active === null, 'opción Todos');
    await shot(page, '06-nivel');
    await context.close();
  });

  // ------------------------------------------------------------------ dock
  await test('dock: resumen, categorías (ojo y aislar) y plegado', async () => {
    const { page, context } = await openMock();
    assert((await page.locator('.stat').count()) === 4, 'cuatro cifras en el resumen');
    assert((await page.locator('.stat[data-stat="elements"] .stat__value').textContent()).trim() === '992', 'total de elementos');
    const cats = await page.locator('.cat').count();
    assert(cats === 9, `9 categorías (hay ${cats})`);
    // Ojo de la primera categoría
    const type = await page.locator('.cat').first().getAttribute('data-type');
    await page.locator('.cat').first().locator('.cat__eye').click();
    assert((await state(page, 'visibility')).hiddenTypes.includes(type), 'el ojo oculta la categoría');
    await page.locator('.cat').first().locator('.cat__eye').click();
    assert((await state(page, 'visibility')).hiddenTypes.length === 0, 'el ojo la vuelve a mostrar');
    // Aislar categoría
    await page.locator('.cat').nth(1).locator('.cat__main').click();
    const ht = (await state(page, 'visibility')).hiddenTypes;
    assert(ht.length === 8 && !ht.includes(await page.locator('.cat').nth(1).getAttribute('data-type')), 'aislar oculta las demás');
    await page.locator('.cat.is-isolated .cat__main').click();
    assert((await state(page, 'visibility')).hiddenTypes.length === 0, 'segundo clic restablece');
    await shot(page, '07-dock');
    // Plegar
    await page.click('.dock__handle');
    assert((await state(page, 'ui')).dockOpen === false, 'el dock se pliega (store.ui.dockOpen)');
    await waitFor(() => page.evaluate(() => document.querySelector('.ui').dataset.dock === 'closed'), { timeout: 3000, label: 'data-dock' });
    await page.waitForTimeout(500);
    await shot(page, '08-dock-plegado');
    await page.click('.dock__handle');
    assert((await state(page, 'ui')).dockOpen === true, 'el dock se despliega');
    await context.close();
  });

  // ------------------------------------------------------------------ capas CAD
  await test('capas CAD: ojo por capa, todas/ninguna y cota automática/manual', async () => {
    const { page, errors, context } = await openMock();
    await page.click('.pill[data-tab="layers"]');
    await page.waitForSelector('.layer');
    assert((await page.locator('.layer').count()) === 13, '13 capas');
    const hiddenBefore = (await state(page, 'cad'))[CAD].hiddenLayers;
    assert(hiddenBefore.includes('Defpoints'), 'capa Defpoints oculta de inicio');
    await page.locator('.layer', { hasText: 'A-WALL' }).locator('.layer__eye').click();
    assert((await state(page, 'cad'))[CAD].hiddenLayers.includes('A-WALL'), 'ocultar capa');
    await page.locator('.layer', { hasText: 'A-WALL' }).locator('.layer__eye').click();
    assert(!(await state(page, 'cad'))[CAD].hiddenLayers.includes('A-WALL'), 'mostrar capa');
    await page.click('.lmodel__bar button:has-text("Ninguna")');
    assert((await state(page, 'cad'))[CAD].hiddenLayers.length === 13, 'ninguna oculta todas');
    await page.click('.lmodel__bar button:has-text("Todas")');
    assert((await state(page, 'cad'))[CAD].hiddenLayers.length === 0, 'todas muestra todas');
    // Cota
    await page.click('.lmodel__elev .seg__btn[data-value="manual"]');
    assert(typeof (await state(page, 'cad'))[CAD].elevation === 'number', 'cota manual numérica');
    await page.fill('.lmodel__elev input[type=number]', '151.25');
    await page.press('.lmodel__elev input[type=number]', 'Enter');
    assert((await state(page, 'cad'))[CAD].elevation === 151.25, 'cota manual 151.25');
    await page.click('.lmodel__elev .seg__btn[data-value="auto"]');
    assert((await state(page, 'cad'))[CAD].elevation === null, 'cota automática = null');
    // Filtro de capas
    await page.fill('.lmodel__filter input', 'a-');
    await waitFor(() => page.locator('.layer:visible').count().then((n) => n > 0 && n < 13), { timeout: 3000, label: 'filtro de capas' });
    await shot(page, '09-capas');
    assert(errors.length === 0, `errores de consola: ${errors.join(' | ')}`);
    await context.close();
  });

  // ------------------------------------------------------------------ vistas
  await test('vistas: guardar, restaurar y borrar', async () => {
    const { page, context } = await openMock();
    await page.click('.pill[data-tab="views"]');
    await page.fill('.views-form input', 'Fachada principal');
    await page.click('.views-form .btn--primary');
    let views = await state(page, 'views');
    assert(views.items.length === 1 && views.items[0].name === 'Fachada principal', 'vista guardada');
    assert(views.items[0].thumb?.startsWith('data:image'), 'la vista lleva miniatura');
    assert((await viewerCalls(page)).includes('screenshot'), 'usa viewer.screenshot');
    // Cambia el estado y restaura
    await page.evaluate(() => window.__mock.actions.setSelectionMode('isolate'));
    await page.locator('.view__open').first().click();
    assert((await state(page, 'display')).selectionMode === 'ghost', 'restaurar vuelve al estado guardado');
    assert((await viewerCalls(page)).includes('setCameraState'), 'restaurar mueve la cámara');
    await waitFor(() => page.locator('.thumb.has-image').count().then((n) => n === 1), { timeout: 3000, label: 'miniatura de la última vista' });
    await page.locator('.view button[aria-label="Borrar esta vista"], .view button[title="Borrar esta vista"]').first().click();
    views = await state(page, 'views');
    assert(views.items.length === 0, 'vista borrada');
    await context.close();
  });

  // ------------------------------------------------------------------ inicio: modelos y diálogos
  await test('inicio: tarjetas de modelos con georreferencia, visibilidad y progreso', async () => {
    const { page, context } = await openMock();
    assert((await page.locator('.model').count()) === 2, 'dos tarjetas de modelos');
    assert((await page.locator('.model .badge--ok').first().textContent()).includes('EPSG:32718'), 'insignia de georreferencia');
    await page.locator('.model').first().locator('button[aria-label="Ocultar el modelo"]').click();
    assert((await state(page, 'models'))[IFC].visible === false, 'ojo del modelo');
    await page.locator('.model').first().locator('button[aria-label="Mostrar el modelo"]').click();
    // Progreso de carga desde store.loading
    await page.evaluate(() => window.__mock.store.set('loading', { 'upload-x': { name: 'Nuevo.ifc', kind: 'ifc', phase: 'upload', progress: 0.42 } }, { source: 'system' }));
    await waitFor(() => page.locator('.model.is-loading').count().then((n) => n === 1), { timeout: 3000, label: 'tarjeta en carga' });
    assert((await page.locator('.model.is-loading').textContent()).includes('42'), 'porcentaje visible');
    await waitFor(() => page.locator('.chip--load').isVisible(), { timeout: 3000, label: 'indicador global' });
    await shot(page, '10-carga');
    await page.evaluate(() => window.__mock.store.set('loading', {}, { source: 'system' }));
    await context.close();
  });

  await test('diálogo de georreferencia: guardar y restablecer usan api.patchModel', async () => {
    const { page, errors, context } = await openMock();
    await page.locator('.model').first().locator('button[aria-label="Configurar la georreferencia"]').click();
    await page.waitForSelector('.modal');
    assert((await page.locator('.detected').textContent()).includes('EPSG:32718'), 'muestra la georreferencia detectada');
    await page.fill('.modal .form-grid label:nth-child(1) input', '280000');
    await page.fill('.modal .form-grid label:nth-child(2) input', '8662000');
    await page.fill('.modal .form-grid label:nth-child(3) input', '120.5');
    await page.fill('.modal .form-grid label:nth-child(4) input', '30');
    await page.fill('.modal .form-grid label:nth-child(5) input', '1');
    await shot(page, '11-georef');
    await page.click('.modal .btn--primary');
    await waitFor(() => page.locator('.modal').count().then((n) => n === 0), { timeout: 3000, label: 'cierre del diálogo' });
    let call = await page.evaluate(() => window.__mock.api.calls.find((c) => c[0] === 'patchModel'));
    assert(call && call[1] === 'ifcmock001' && call[2].georef.eastings === 280000 && call[2].georef.rotationDeg === 30 && call[2].georef.height === 120.5, `patchModel georef: ${JSON.stringify(call)}`);
    // Validación: escala 0
    await page.locator('.model').first().locator('button[aria-label="Configurar la georreferencia"]').click();
    await page.fill('.modal .form-grid label:nth-child(5) input', '0');
    await page.click('.modal .btn--primary');
    assert(await page.locator('.form-error').isVisible(), 'valida la escala');
    // Restablecer
    await page.click('.modal__reset');
    await waitFor(() => page.locator('.modal').count().then((n) => n === 0), { timeout: 3000, label: 'cierre tras restablecer' });
    call = await page.evaluate(() => window.__mock.api.calls.filter((c) => c[0] === 'patchModel').pop());
    assert(call[2].georef === null, 'restablecer envía georef: null');
    assert(errors.length === 0, `errores de consola: ${errors.join(' | ')}`);
    await context.close();
  });

  await test('diálogo CAD (unidades y cota) y confirmación de borrado', async () => {
    const { page, context } = await openMock();
    await page.locator('.model').nth(1).locator('button[aria-label="Configurar unidades y cota del plano"]').click();
    await page.waitForSelector('.modal');
    await page.selectOption('.modal select', 'mm');
    await page.click('.modal .seg__btn[data-value="manual"]');
    await page.fill('.modal input[type=number]', '152.5');
    await shot(page, '12-cad');
    await page.click('.modal .btn--primary');
    await waitFor(() => page.locator('.modal').count().then((n) => n === 0), { timeout: 3000, label: 'cierre del diálogo CAD' });
    const call = await page.evaluate(() => window.__mock.api.calls.find((c) => c[0] === 'patchModel' && c[2].cad));
    assert(call && call[2].cad.units === 'mm', `patchModel cad.units: ${JSON.stringify(call)}`);
    assert((await state(page, 'cad'))[CAD].elevation === 152.5, 'actions.setCadElevation(152.5)');

    // Borrado: cancelar y confirmar
    await page.locator('.model').nth(1).locator('button[aria-label="Eliminar el modelo"]').click();
    await page.waitForSelector('.modal--confirm');
    await shot(page, '13-borrar');
    await page.click('.modal--confirm .btn--ghost');
    assert(!(await page.evaluate(() => window.__mock.api.calls.some((c) => c[0] === 'deleteModel'))), 'cancelar no borra');
    await page.locator('.model').nth(1).locator('button[aria-label="Eliminar el modelo"]').click();
    await page.click('.modal--confirm .btn--danger');
    await waitFor(() => page.evaluate(() => window.__mock.api.calls.some((c) => c[0] === 'deleteModel' && c[1] === 'cadmock002')), { timeout: 3000, label: 'api.deleteModel' });
    await waitFor(() => page.locator('.model').count().then((n) => n === 1), { timeout: 3000, label: 'tarjeta eliminada' });
    await context.close();
  });

  await test('carga de archivos: botón y arrastrar y soltar usan loader.uploadFiles', async () => {
    const { page, context } = await openMock();
    // Botón: el input de archivos está presente y acepta ifc/dxf/dwg
    assert((await page.locator('.upload-card input[type=file]').getAttribute('accept')) === '.ifc,.dxf,.dwg', 'accept del input');
    await page.setInputFiles('.upload-card input[type=file]', { name: 'Nuevo_modelo.ifc', mimeType: 'application/octet-stream', buffer: Buffer.from('ISO-10303-21;') });
    await waitFor(() => page.locator('.model').count().then((n) => n === 3), { timeout: 5000, label: 'modelo subido' });
    // Arrastrar y soltar sobre la ventana
    await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.items.add(new File(['x'], 'Plano.dxf', { type: 'application/octet-stream' }));
      window.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true, cancelable: true }));
    });
    await waitFor(() => page.locator('.drop-overlay').isVisible(), { timeout: 3000, label: 'overlay de soltar' });
    await shot(page, '14-soltar');
    await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.items.add(new File(['x'], 'Plano.dxf', { type: 'application/octet-stream' }));
      window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    });
    await waitFor(() => page.locator('.model').count().then((n) => n === 4), { timeout: 5000, label: 'modelo soltado' });
    assert(!(await page.locator('.drop-overlay').isVisible()), 'el overlay se oculta tras soltar');
    await context.close();
  });

  // ------------------------------------------------------------------ búsqueda
  await test('buscador: resultados de ifc.search, teclado y selección', async () => {
    const { page, context } = await openMock();
    await page.fill('.search__input', 'ventana');
    await page.waitForSelector('.result');
    assert((await page.locator('.result').count()) > 1, 'varios resultados');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    assert((await state(page, 'selection')).items.length === 1, 'Enter selecciona el resultado');
    assert((await viewerCalls(page)).includes('fitToBox'), 'encuadra el resultado');
    await page.fill('.search__input', 'viga');
    await page.waitForSelector('.result');
    await page.click('.search-results__head button');
    assert((await state(page, 'selection')).items.length > 1, '"Seleccionar todos" selecciona los resultados');
    await page.fill('.search__input', 'zzzz-no-existe');
    await waitFor(() => page.locator('.search-results__empty').isVisible(), { timeout: 3000, label: 'sin resultados' });
    await context.close();
  });

  // ------------------------------------------------------------------ presentación
  await test('presentador: Presentar/Detener, EN VIVO con espectadores, URLs de red y láser', async () => {
    const { page, errors, context } = await openMock();
    await page.click('.btn--present');
    assert((await state(page, 'presentation')).active === true, 'presentation.toggle()');
    await waitFor(() => page.locator('.live-pill').isVisible(), { timeout: 3000, label: 'píldora EN VIVO' });
    const text = await page.locator('.live-pill').textContent();
    assert(/EN VIVO/.test(text) && /espectadores/.test(text), `texto de la píldora: ${text}`);
    await page.click('.live-pill--button');
    await page.waitForSelector('.popover:visible');
    const urls = await page.locator('.url-item__text').allTextContents();
    assert(urls.includes('http://192.168.1.20:8080'), `URLs de red: ${urls}`);
    // Láser
    const laser0 = (await state(page, 'presentation')).laser;
    await page.locator('.popover:visible .switch__input').click({ force: true });
    assert((await state(page, 'presentation')).laser === !laser0, 'puntero láser');
    await shot(page, '15-presentacion');
    await page.keyboard.press('Escape');
    await page.click('.status-cluster button:has-text("Detener")');
    assert((await state(page, 'presentation')).active === false, 'Detener');
    assert(errors.length === 0, `errores de consola: ${errors.join(' | ')}`);
    await context.close();
  });

  await test('presentador que no es el activo: "Tomar control"', async () => {
    const { page, context } = await openMock();
    await page.evaluate(() => window.__mock.store.patch('presentation', { active: true, isActivePresenter: false, presenterName: 'Otra PC' }, { source: 'system' }));
    await waitFor(() => page.locator('.status-cluster button:has-text("Tomar control")').isVisible(), { timeout: 3000, label: 'botón Tomar control' });
    assert(await page.locator('.lock-layer').isVisible(), 'mientras otro presenta, esta PC queda bloqueada');
    await page.click('.status-cluster button:has-text("Tomar control")');
    assert((await state(page, 'presentation')).isActivePresenter === true, 'tomó el control');
    await waitFor(() => page.locator('.lock-layer').isHidden(), { timeout: 3000, label: 'sin bloqueo' });
    await context.close();
  });

  await test('espectador: capa de bloqueo, sin controles de edición y solo pantalla completa', async () => {
    const { page, errors, context } = await openMock('?role=viewer&active=1');
    assert(await page.locator('.lock-layer').isVisible(), 'capa de bloqueo visible');
    assert((await page.locator('.lock-layer__label').textContent()).includes('solo visualización'), 'texto de modo presentación');
    assert((await page.evaluate(() => getComputedStyle(document.querySelector('.lock-layer')).cursor)) === 'not-allowed', 'cursor not-allowed');
    assert((await page.locator('.live-pill').textContent()).includes('Siguiendo a Henry'), 'insignia EN VIVO con el nombre');
    assert((await page.locator('.upload-card').isHidden()) && (await page.locator('.model__actions button[aria-label="Eliminar el modelo"]').count()) === 0, 'sin subir ni borrar');
    assert((await page.locator('.model__actions button[aria-label="Configurar la georreferencia"]').count()) === 0, 'sin georreferencia');
    assert((await page.locator('.btn--present').count()) === 0, 'sin botón Presentar');
    assert((await page.evaluate(() => window.__mock.viewer.inputEnabled)) === false, 'viewer.enableInput(false)');

    // Un clic sobre el visor/paneles no hace nada: lo recibe la capa
    for (const [x, y] of [[800, 400], [200, 400], [1450, 155], [1000, 800]]) {
      const top = await page.evaluate(([px, py]) => document.elementFromPoint(px, py)?.className, [x, y]);
      assert(String(top).includes('lock-layer'), `en (${x},${y}) debería estar la capa de bloqueo (hay ${top})`);
      await page.mouse.click(x, y);
    }
    assert((await state(page, 'selection')).items.length === 0, 'los clics no cambian la selección');
    assert((await state(page, 'display')).edges === true, 'los clics no cambian los ajustes');
    // Teclado y rueda bloqueados
    await page.evaluate(() => window.__mock.actions.select([{ modelId: 'ifcmock001', expressId: 300 }]));
    await page.keyboard.press('h');
    await page.keyboard.press('i');
    await page.mouse.move(800, 400);
    await page.mouse.wheel(0, 400);
    const vis = await state(page, 'visibility');
    assert(Object.keys(vis.hidden).length === 0 && vis.isolated === null, 'los atajos no actúan con la capa de bloqueo');
    assert((await state(page, 'selection')).items.length === 1, 'la selección replicada se mantiene');
    // Solo se permite pantalla completa
    const fsTop = await page.evaluate(() => {
      const r = document.querySelector('.status-cluster .btn--glass').getBoundingClientRect();
      return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2).closest('button')?.getAttribute('aria-label');
    });
    assert(fsTop === 'Pantalla completa', `el botón de pantalla completa debe estar por encima (${fsTop})`);
    await shot(page, '16-espectador');

    // La UI replica el store del presentador
    await page.evaluate(() => {
      const { store } = window.__mock;
      store.setMany({ ui: { tab: 'props', sidebarOpen: true, dockOpen: false }, display: { ...store.get('display'), selectionMode: 'isolate' } }, { source: 'remote' });
    });
    await waitFor(() => page.locator('.tab--props').isVisible(), { timeout: 3000, label: 'pestaña replicada' });
    await waitFor(() => page.evaluate(() => document.querySelector('.ui').dataset.dock === 'closed'), { timeout: 3000, label: 'dock replicado' });
    await page.waitForSelector('.psec');
    assert(errors.length === 0, `errores de consola: ${errors.join(' | ')}`);
    await context.close();
  });

  await test('espectador sin presentación: navegación libre o "Esperando al presentador"', async () => {
    let h = await openMock('?role=viewer');
    assert(await h.page.locator('.lock-layer').isHidden(), 'con navegación libre y sin presentación no hay bloqueo');
    assert((await h.page.evaluate(() => window.__mock.viewer.inputEnabled)) === true, 'el visor admite entrada');
    assert((await h.page.locator('.upload-card').isHidden()), 'aun así no puede subir');
    await h.context.close();
    h = await openMock('?role=viewer&freenav=0');
    assert(await h.page.locator('.lock-layer').isVisible(), 'sin navegación libre sigue bloqueado');
    assert((await h.page.locator('.lock-layer__label').textContent()).includes('Esperando al presentador'), 'mensaje de espera');
    await shot(h.page, '17-esperando');
    await h.context.close();
  });

  await test('conexión: indicador y reconexión', async () => {
    const { page, context } = await openMock();
    await page.evaluate(() => window.__mock.store.patch('presentation', { connected: false }, { source: 'system' }));
    await waitFor(() => page.locator('.chip--warn').isVisible(), { timeout: 3000, label: 'aviso de reconexión' });
    assert((await page.locator('.chip--warn').textContent()).includes('Reconectando'), 'texto Reconectando');
    await page.click('.sidebar__icons button[aria-label^="Conexión"]');
    await page.waitForSelector('.popover:visible');
    assert((await page.locator('.popover:visible').textContent()).includes('Sin conexión'), 'el panel indica sin conexión');
    await page.keyboard.press('Escape');
    await page.evaluate(() => window.__mock.store.patch('presentation', { connected: true }, { source: 'system' }));
    await waitFor(() => page.locator('.chip--warn').isHidden(), { timeout: 3000, label: 'conectado de nuevo' });
    await context.close();
  });

  await test('avisos (toasts): se muestran, se agrupan y se cierran', async () => {
    const { page, context } = await openMock();
    await page.evaluate(() => {
      window.__mock.bus.emit('toast', { type: 'success', message: 'Modelo cargado' });
      window.__mock.bus.emit('toast', { type: 'error', message: 'Algo falló', timeout: 800 });
      window.__mock.bus.emit('toast', { type: 'success', message: 'Modelo cargado' });
    });
    await waitFor(() => page.locator('.toast').count().then((n) => n === 2), { timeout: 3000, label: 'dos avisos (sin duplicados)' });
    await shot(page, '18-avisos');
    await waitFor(() => page.locator('.toast--error').count().then((n) => n === 0), { timeout: 4000, label: 'el aviso caduca' });
    await page.click('.toast__close');
    await waitFor(() => page.locator('.toast').count().then((n) => n === 0), { timeout: 3000, label: 'cierre manual' });
    await context.close();
  });

  // ------------------------------------------------------------------ diseño y accesibilidad
  await test('responsive: 1280x720 y 900x700 sin desbordes y con barra lateral como cajón', async () => {
    for (const [w, hgt, name] of [[1280, 720, '19-1280'], [900, 700, '20-900']]) {
      const { page, context } = await openMock('', { width: w, height: hgt });
      await page.evaluate(() => window.__mock.actions.select([{ modelId: 'ifcmock001', expressId: 300 }]));
      await page.waitForTimeout(400);
      const overflow = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth, sh: document.documentElement.scrollHeight, ih: window.innerHeight }));
      assert(overflow.sw <= overflow.iw && overflow.sh <= overflow.ih, `desborde de página a ${w}px: ${JSON.stringify(overflow)}`);
      // Los elementos clave caben en la ventana
      for (const sel of ['.toolbar-col', '.dock', '.zoom', '.level', '.sel']) {
        const box = await page.locator(sel).first().boundingBox();
        assert(box && box.x >= -1 && box.x + box.width <= w + 1 && box.y >= -1, `${sel} fuera de la ventana a ${w}px (${JSON.stringify(box)})`);
      }
      await shot(page, name);
      if (w <= 900) {
        await page.click('.sidebar__icons button[aria-label="Ocultar la barra lateral"]');
        await waitFor(() => page.evaluate(() => document.querySelector('.ui').dataset.sidebar === 'closed'), { timeout: 3000, label: 'cajón cerrado' });
        await page.waitForTimeout(500);
        await shot(page, '21-900-cerrada');
      }
      await context.close();
    }
  });

  await test('accesibilidad: todos los botones tienen nombre y los textos están en español', async () => {
    const { page, context } = await openMock();
    await page.evaluate(() => window.__mock.actions.select([{ modelId: 'ifcmock001', expressId: 300 }]));
    for (const tab of ['models', 'tree', 'props', 'layers', 'views']) {
      await page.click(`.pill[data-tab="${tab}"]`);
      await page.waitForTimeout(150);
      const nameless = await page.evaluate(() =>
        [...document.querySelectorAll('button, [role=button], input, select')]
          .filter((el) => el.offsetParent !== null || el.getClientRects().length)
          .filter((el) => {
            const t = (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '').trim();
            const labelled = el.labels?.length || el.getAttribute('aria-labelledby');
            const placeholder = el.getAttribute('placeholder');
            return !t && !labelled && !placeholder;
          })
          .map((el) => el.outerHTML.slice(0, 120)),
      );
      assert(nameless.length === 0, `elementos sin nombre accesible en ${tab}: ${nameless.join(' ; ')}`);
    }
    await context.close();
  });

  await test('sin modelos: estados vacíos coherentes', async () => {
    const { page, errors, context } = await openMock('?empty=1');
    assert((await page.locator('.header__title').textContent()).trim() === 'Visor IFC 5D', 'título por defecto');
    assert((await page.locator('.empty').count()) >= 1, 'estado vacío de modelos');
    assert(await page.locator('.level').isHidden(), 'sin niveles no se muestra el selector');
    for (const tab of ['tree', 'props', 'layers', 'views']) {
      await page.click(`.pill[data-tab="${tab}"]`);
      assert(await page.locator(`.tab--${tab} .empty`).first().isVisible(), `estado vacío en ${tab}`);
    }
    await shot(page, '22-vacio');
    assert(errors.length === 0, `errores de consola: ${errors.join(' | ')}`);
    await context.close();
  });
}

try {
  await run();
} catch (err) {
  console.error('Error fatal en las pruebas:', err);
  results.push({ name: 'ejecución', ok: false, err });
} finally {
  await browser?.close().catch(() => {});
  await new Promise((r) => (server ? server.close(r) : r()));
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} pruebas correctas`);
if (failed.length) {
  console.log('Fallos:');
  for (const f of failed) console.log(` - ${f.name}: ${f.err?.message}`);
}
process.exit(failed.length ? 1 : 0);
