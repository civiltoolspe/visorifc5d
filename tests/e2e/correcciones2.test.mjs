// Pruebas de regresión de la ronda 2 de verificación (servidor REAL + todos los módulos reales):
//   1. PIN de presentador con la pantalla bloqueada (VIEWER_FREE_NAV=false o presentación en curso): una PC remota puede
//      escribir el PIN desde un campo accesible aunque la capa de bloqueo tape la barra lateral (panel Conexión).
//   2. Dock "Resumen del modelo" y ficha OCULTOS: los modelos ocultos con el ojo de su tarjeta cuentan como ocultos
//      (elementos y categorías) y "Mostrar todo" los devuelve.
//   3. DNS rebinding: una página con Host/Origin de otro dominio no puede usar el servidor aunque el socket sea loopback
//      (la parte HTTP/WebSocket está en server.test.mjs; aquí se comprueba con el navegador y la aplicación completa).
//
// Uso: node tests/e2e/correcciones2.test.mjs   (código de salida 0 = todo bien, 1 = algo falló)

import path from 'node:path';
import { chromium } from 'playwright';
import {
  startServer, launchBrowser, openPage, uploadFixture, assert, waitFor, getSlice, waitForApp, lanIp, OUTPUT,
} from './helpers.mjs';

const PORT = Number(process.env.CORRECCIONES2_PORT || 8230);
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

const shot = (page, name) => page.screenshot({ path: path.join(OUTPUT, `correcciones2-${name}.png`) });
const text = async (locator) => (await locator.innerText()).replace(/\s+/g, ' ').trim();

async function open(browser, name, url, opts) {
  const h = await openPage(browser, url, opts);
  h.name = name;
  handles.push(h);
  return h;
}

// Foto de lo que un espectador bloqueado no debe poder cambiar
const snapshot = (page) => page.evaluate(() => {
  const s = window.__visor.store;
  return JSON.stringify(['selection', 'visibility', 'display', 'storey', 'section', 'measure', 'ui', 'models'].map((k) => s.get(k)));
});

async function run() {
  const lan = lanIp();
  const browser = await launchBrowser();
  const servers = [];
  const newServer = async (opts) => {
    const s = await startServer(opts);
    servers.push(s);
    return s;
  };
  console.log(`Ronda 2: IP de red ${lan || '(ninguna)'}`);

  try {
    // ================================================================== 1. PIN con la pantalla bloqueada
    {
      const PIN = '4821';
      const srv = await newServer({ port: PORT, env: { PRESENTER_PIN: PIN, VIEWER_FREE_NAV: 'false' } });
      await uploadFixture(srv.url, 'edificio_georef_ifc4.ifc');
      const remote = lan ? `http://${lan}:${PORT}` : `${srv.url}/?role=viewer`;

      const V = await open(browser, 'remoto-pin', remote);
      await waitForApp(V.page, { ifc: 1 });
      const vp = V.page;
      const pinInput = vp.locator('.pin-lock__input');
      const toggle = vp.locator('.pin-lock__toggle');

      await test('PIN + VIEWER_FREE_NAV=false: la PC remota ve "Esperando al presentador" y un acceso al PIN por encima de la capa de bloqueo', async () => {
        assert((await getSlice(vp, 'presentation')).role === 'viewer', 'la PC remota debe ser espectadora');
        assert(await vp.locator('.lock-layer').isVisible(), 'debe estar bloqueada');
        assert((await vp.locator('.lock-layer__label').textContent()).includes('Esperando al presentador'), 'mensaje de espera');
        await waitFor(() => toggle.isVisible(), { timeout: 5000, label: 'botón de PIN' });
        // alcanzable con un puntero real: el elemento bajo el centro del botón es el propio botón, no la capa de bloqueo
        const box = await toggle.boundingBox();
        const top = await vp.evaluate(({ x, y }) => {
          const e = document.elementFromPoint(x, y);
          return e && (e.closest('.pin-lock__toggle') ? 'toggle' : e.className || e.tagName);
        }, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
        assert(top === 'toggle', `bajo el botón de PIN hay: ${top}`);
        assert(!(await pinInput.isVisible()), 'el campo no se ve hasta pulsar el botón');
        await shot(vp, '01-bloqueado-con-pin');
      });

      await test('lo demás sigue bloqueado: el icono Conexión, el visor y los atajos no responden mientras el campo de PIN está abierto', async () => {
        await toggle.click();
        await waitFor(() => pinInput.isVisible(), { timeout: 3000, label: 'campo de PIN' });
        const before = await snapshot(vp);
        // clic real sobre el icono Conexión (inerte, tapado por la capa) y sobre el visor
        const wifi = await vp.locator('button[title^="Conexión"]').boundingBox();
        await vp.mouse.click(wifi.x + wifi.width / 2, wifi.y + wifi.height / 2);
        await vp.mouse.click(900, 450);
        await vp.mouse.wheel(0, -300);
        await pinInput.focus();
        await vp.keyboard.type('hifmp'); // atajos del visor (ocultar, aislar, encuadrar, medir, presentar): ninguno debe actuar
        await vp.waitForTimeout(300);
        assert((await snapshot(vp)) === before, 'el estado cambió con la pantalla bloqueada');
        assert((await pinInput.inputValue()) === 'hifmp', 'el campo sí recibe el teclado');
        await shot(vp, '01b-campo-pin-abierto');
        assert(await vp.locator('.lock-layer').isVisible(), 'la capa de bloqueo sigue activa');
        assert(!(await vp.evaluate(() => window.__visor.viewer.inputEnabled)), 'el visor sigue sin entrada');
        assert((await getSlice(vp, 'presentation')).role === 'viewer', 'sigue siendo espectador');
      });

      await test('un PIN incorrecto se rechaza (aviso, campo vacío, sigue espectador y bloqueado)', async () => {
        await pinInput.fill('0000');
        await pinInput.press('Enter');
        await waitFor(async () => /PIN incorrecto/.test(await vp.locator('.toast-layer').innerText()), { timeout: 5000, label: 'aviso de PIN incorrecto' });
        await waitFor(async () => (await pinInput.inputValue()) === '', { timeout: 3000, label: 'campo vacío' });
        assert((await vp.evaluate(() => sessionStorage.getItem('visor.pin'))) === null || (await vp.evaluate(() => sessionStorage.getItem('visor.pin'))) === '', 'el PIN erróneo no debe quedar guardado');
        assert((await getSlice(vp, 'presentation')).role === 'viewer' && (await vp.locator('.lock-layer').isVisible()), 'sigue siendo espectador bloqueado');
      });

      await test('un PIN correcto recarga la página como presentador: ya no hay bloqueo y aparece "Presentar"', async () => {
        await pinInput.fill(PIN);
        await Promise.all([
          vp.waitForEvent('load', { timeout: 15000 }),
          pinInput.press('Enter'),
        ]);
        await waitForApp(vp, { ifc: 1 });
        assert((await getSlice(vp, 'presentation')).role === 'presenter', 'debe ser presentador');
        assert(await vp.locator('.btn--present').isVisible(), 'botón Presentar');
        assert(await vp.locator('.lock-layer').isHidden(), 'sin capa de bloqueo');
        assert(await vp.locator('.pin-lock').isHidden(), 'el acceso al PIN desaparece para un presentador');
        assert(await vp.evaluate(() => window.__visor.viewer.inputEnabled), 'el visor responde');
      });

      await test('con una presentación en curso, la PC remota (espectadora) también puede entrar con PIN y tomar el control', async () => {
        const P = await open(browser, 'anfitrion', srv.url);
        await waitForApp(P.page, { ifc: 1 });
        await P.page.click('.btn--present');
        const W = await open(browser, 'remoto-en-vivo', remote);
        await waitForApp(W.page, { ifc: 1 });
        await waitFor(async () => (await getSlice(W.page, 'presentation')).active, { timeout: 10000, label: 'presentación en curso' });
        assert((await W.page.locator('.lock-layer__label').textContent()).includes('solo visualización'), 'texto del bloqueo en presentación');
        await waitFor(() => W.page.locator('.pin-lock__toggle').isVisible(), { timeout: 5000, label: 'botón de PIN en presentación' });
        await W.page.locator('.pin-lock__toggle').click();
        await W.page.locator('.pin-lock__input').fill(PIN);
        await Promise.all([W.page.waitForEvent('load', { timeout: 15000 }), W.page.locator('.pin-lock__input').press('Enter')]);
        await waitForApp(W.page, { ifc: 1 });
        await waitFor(async () => { const p = await getSlice(W.page, 'presentation'); return p.role === 'presenter' && p.active; }, { timeout: 10000, label: 'presentador siguiendo' });
        assert(await W.page.locator('.status-cluster button:has-text("Tomar control")').isVisible(), 'puede tomar el control');
        await P.page.locator('.status-cluster button:has-text("Detener")').click();
        await P.context.close();
        await W.context.close();
      });
      await V.context.close();

      await test('el anfitrión (loopback) nunca ve el acceso al PIN; con ?role=viewer sí, porque queda bloqueado', async () => {
        const P = await open(browser, 'anfitrion-2', srv.url);
        await waitForApp(P.page, { ifc: 1 });
        assert(await P.page.locator('.pin-lock').isHidden(), 'el presentador no necesita PIN');
        const Q = await open(browser, 'anfitrion-como-espectador', `${srv.url}/?role=viewer`);
        await waitForApp(Q.page, { ifc: 1 });
        assert(await Q.page.locator('.lock-layer').isVisible(), 'bloqueado');
        assert(await Q.page.locator('.pin-lock__toggle').isVisible(), 'el acceso al PIN se ve');
        await P.context.close();
        await Q.context.close();
      });
    }

    // ------------------------------------------------------------------ sin PIN en el servidor no hay acceso al PIN
    {
      const srv = await newServer({ port: PORT + 1, env: { VIEWER_FREE_NAV: 'false' } });
      await uploadFixture(srv.url, 'edificio_georef_ifc4.ifc');
      await test('servidor sin PRESENTER_PIN: la pantalla bloqueada no ofrece ningún campo de PIN', async () => {
        const V = await open(browser, 'sin-pin', lan ? `http://${lan}:${PORT + 1}` : `${srv.url}/?role=viewer`);
        await waitForApp(V.page, { ifc: 1 });
        assert(await V.page.locator('.lock-layer').isVisible(), 'bloqueado');
        assert(await V.page.locator('.pin-lock').isHidden(), 'no debe verse el acceso al PIN');
        assert((await V.page.locator('.pin-lock__input').isVisible()) === false, 'ni el campo');
        await V.context.close();
      });
    }

    // ================================================================== 2. Dock con modelos ocultos
    {
      const srv = await newServer({ port: PORT + 2 });
      await uploadFixture(srv.url, 'edificio_georef_ifc4.ifc');
      await uploadFixture(srv.url, 'downloads/AC20-FZK-Haus.ifc');
      const P = await open(browser, 'dock-modelos', srv.url);
      const page = P.page;
      await waitForApp(page, { ifc: 2 });
      await page.waitForTimeout(500);

      const foot = (key) => text(page.locator(`.stat[data-stat="${key}"] .stat__foot`));
      const statValue = (key) => text(page.locator(`.stat[data-stat="${key}"] .stat__top`));
      const tile = () => text(page.locator('.tile--yellow .tile__value'));
      const settle = () => page.waitForTimeout(450);

      // Datos reales por modelo
      const info = await page.evaluate(() => {
        const v = window.__visor;
        const out = {};
        for (const m of v.ifc.getModels()) {
          const s = v.ifc.getModelSummary(m.id);
          out[m.name] = { id: m.id, total: s.elementCount, types: s.types.map((t) => [t.type, t.count]) };
        }
        return out;
      });
      const nameIfc4 = Object.keys(info).find((n) => /georef_ifc4/.test(n));
      const nameFzk = Object.keys(info).find((n) => /FZK/i.test(n));
      assert(nameIfc4 && nameFzk, `modelos: ${Object.keys(info)}`);
      const A = info[nameIfc4];
      const F = info[nameFzk];
      const total = A.total + F.total;
      const allTypes = new Set([...A.types.map((t) => t[0]), ...F.types.map((t) => t[0])]);
      const onlyFzkTypes = F.types.filter(([t]) => !A.types.some(([u]) => u === t));
      const hasSpaces = allTypes.has('IFCSPACE');
      const spaces = (hasSpaces ? [...A.types, ...F.types].filter(([t]) => t === 'IFCSPACE').reduce((a, [, n]) => a + n, 0) : 0);
      const eye = (modelId) => page.locator(`article.model[data-model="${modelId}"] button[title="Ocultar el modelo"], article.model[data-model="${modelId}"] button[title="Mostrar el modelo"]`);
      assert(onlyFzkTypes.length > 0, 'precondición: FZK tiene categorías que el otro IFC no tiene');

      await test('ambos modelos visibles: el resumen cuenta todo (espacios aparte, ocultos por defecto)', async () => {
        const el = await foot('elements');
        assert(new RegExp(`${total - spaces} visibles`).test(el), `elementos: ${el} (total ${total}, espacios ${spaces})`);
        assert((await statValue('elements')).startsWith(String(total)), `total: ${await statValue('elements')}`);
        const cats = await foot('categories');
        assert(new RegExp(`${allTypes.size - (hasSpaces ? 1 : 0)} visibles`).test(cats), `categorías: ${cats}`);
        assert((await tile()) === String(spaces).padStart(2, '0'), `ficha OCULTOS: ${await tile()}`);
      });

      await test('ocultar un modelo con el ojo de su tarjeta: sus elementos pasan a "ocultos" en el dock y en la ficha OCULTOS', async () => {
        await eye(F.id).click();
        await settle();
        assert(await page.evaluate((id) => window.__visor.store.get('models')[id]?.visible === false, F.id), 'precondición: el modelo quedó oculto');
        const el = await foot('elements');
        // FZK completo + los espacios del otro modelo (si los tuviera)
        const aSpaces = A.types.filter(([t]) => t === 'IFCSPACE').reduce((a, [, n]) => a + n, 0);
        const hidden = F.total + aSpaces;
        assert(new RegExp(`${total - hidden} visibles`).test(el) && new RegExp(`${hidden} ocultos`).test(el), `elementos: ${el} (esperado ${total - hidden} visibles, ${hidden} ocultos)`);
        assert((await statValue('elements')).startsWith(String(total)), 'el total no cambia');
        // las categorías que solo tiene FZK dejan de contar como visibles
        const visCats = A.types.filter(([t]) => t !== 'IFCSPACE').length;
        const cats = await foot('categories');
        assert(new RegExp(`${visCats} visibles`).test(cats), `categorías: ${cats} (esperado ${visCats} visibles)`);
        assert(new RegExp(`${allTypes.size - visCats} ocultas`).test(cats), `categorías ocultas: ${cats}`);
        assert((await tile()) === String(hidden), `ficha OCULTOS: ${await tile()} (esperado ${hidden})`);
        assert(await page.locator('.dock-link', { hasText: 'Mostrar todo' }).isVisible(), 'el enlace "Mostrar todo" se ofrece también por un modelo oculto');
        await shot(page, '02-dock-modelo-oculto');
      });

      await test('un elemento ocultado a mano o por tipo dentro del modelo oculto no se cuenta dos veces', async () => {
        const fzkHiddenType = F.types.find(([t]) => t !== 'IFCSPACE')[0];
        const typeInA = A.types.find(([t]) => t === fzkHiddenType);
        await page.evaluate((t) => window.__visor.actions.setTypeHidden(t, true), fzkHiddenType);
        await page.evaluate(({ id }) => {
          const v = window.__visor;
          const m = v.ifc.getModels().find((x) => x.id === id);
          v.actions.hideElements([{ modelId: id, expressId: m.table.expressIds[0] }]);
        }, { id: F.id });
        await settle();
        const aSpaces = A.types.filter(([t]) => t === 'IFCSPACE').reduce((a, [, n]) => a + n, 0);
        const hiddenInA = (typeInA && typeInA[0] !== 'IFCSPACE' ? typeInA[1] : 0) + aSpaces;
        const expected = F.total + hiddenInA;
        const el = await foot('elements');
        assert(new RegExp(`${expected} ocultos`).test(el) && new RegExp(`${total - expected} visibles`).test(el), `elementos: ${el} (esperado ${expected} ocultos)`);
        assert((await tile()) === String(expected), `ficha OCULTOS: ${await tile()} (esperado ${expected})`);
      });

      await test('"Mostrar todo" del dock devuelve el modelo oculto, los tipos y los elementos ocultos', async () => {
        await page.locator('.dock-link', { hasText: 'Mostrar todo' }).click();
        await settle();
        const st = await page.evaluate(() => ({ models: window.__visor.store.get('models'), vis: window.__visor.store.get('visibility'), spaces: window.__visor.store.get('display').showSpaces }));
        assert(Object.values(st.models).every((m) => m.visible !== false), `modelos: ${JSON.stringify(st.models)}`);
        assert(st.vis.hiddenTypes.length === 0 && Object.keys(st.vis.hidden).length === 0, `visibilidad: ${JSON.stringify(st.vis)}`);
        const el = await foot('elements');
        assert(new RegExp(`${total} visibles`).test(el) && !/oculto/.test(el), `elementos: ${el}`);
        assert((await tile()) === '00', `ficha OCULTOS: ${await tile()}`);
        const gone = await eye(F.id).getAttribute('title');
        assert(gone === 'Ocultar el modelo', `el ojo vuelve a estar abierto: ${gone}`);
      });

      await test('la ficha OCULTOS y Mayús+H también devuelven un modelo oculto; mostrarlo con su ojo restaura los contadores', async () => {
        // tras "Mostrar todo" los espacios están visibles: lo único oculto es lo que se oculte ahora
        assert((await tile()) === '00', `precondición: nada oculto (${await tile()})`);
        await eye(A.id).click();
        await settle();
        let el = await foot('elements');
        assert(new RegExp(`${total - A.total} visibles`).test(el) && new RegExp(`${A.total} ocultos`).test(el), `con el IFC4 oculto: ${el}`);
        assert((await tile()) === String(A.total), `ficha OCULTOS con el IFC4 oculto: ${await tile()} (esperado ${A.total})`);
        // mostrarlo con su ojo restaura los contadores
        await eye(A.id).click();
        await settle();
        el = await foot('elements');
        assert(new RegExp(`${total} visibles`).test(el) && !/oculto/.test(el) && (await tile()) === '00', `al mostrarlo: ${el} / ${await tile()}`);
        // la ficha OCULTOS ("Mostrar todo") devuelve el modelo oculto
        await eye(A.id).click();
        await settle();
        await page.locator('.tile--yellow').click();
        await settle();
        assert(await page.evaluate(() => Object.values(window.__visor.store.get('models')).every((m) => m.visible !== false)), 'la ficha OCULTOS debe devolver los modelos ocultos');
        assert(/ojo|Ocultar el modelo/.test((await eye(A.id).getAttribute('title')) || ''), 'el ojo de la tarjeta vuelve a estar abierto');
        // y el atajo Mayús+H
        await eye(F.id).click();
        await settle();
        assert(await page.evaluate((id) => window.__visor.store.get('models')[id].visible === false, F.id), 'precondición: FZK oculto');
        assert(new RegExp(`${F.total} ocultos`).test(await foot('elements')), `con FZK oculto: ${await foot('elements')}`);
        await page.mouse.move(900, 450);
        await page.keyboard.press('Shift+H');
        await settle();
        assert(await page.evaluate(() => Object.values(window.__visor.store.get('models')).every((m) => m.visible !== false)), 'Mayús+H debe devolver los modelos ocultos');
        assert(new RegExp(`${total} visibles`).test(await foot('elements')), `tras Mayús+H: ${await foot('elements')}`);
      });

      await test('sin errores de consola (dock con modelos ocultos)', async () => {
        assert(P.errors.length === 0, P.errors.join(' | '));
      });
    }

    // ================================================================== 3. DNS rebinding desde el navegador
    {
      const srv = await newServer({ port: PORT + 3 });
      // Chromium resuelve evil.test a 127.0.0.1 (lo que haría un servidor DNS malicioso tras el "rebinding")
      const evilBrowser = await chromium.launch({
        args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--proxy-server=direct://', '--host-resolver-rules=MAP evil.test 127.0.0.1',
          // Chromium reciente ya frena por sí mismo las peticiones de una página "pública" hacia loopback (Private Network Access);
          // se desactiva para simular un navegador sin esa defensa (Firefox, Safari, versiones antiguas): la protección del servidor
          // no debe depender de que el navegador la aplique.
          '--disable-web-security'],
      });
      try {
        await test('DNS rebinding real en Chromium: una página en evil.test no puede subir, leer ni ser presentador en el servidor del anfitrión', async () => {
          const origin = `http://evil.test:${PORT + 3}`;
          const ctx = await evilBrowser.newContext();
          const pg = await ctx.newPage();
          // la "página del atacante" se sirve por interceptación; el resto de peticiones sale a la red (127.0.0.1 vía la regla DNS)
          await pg.route(`${origin}/attack.html`, (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>x</title>' }));
          await pg.goto(`${origin}/attack.html`);
          const res = await pg.evaluate(async () => {
            const out = {};
            const fd = new FormData();
            fd.append('file', new Blob(['ISO-10303-21;\nEND-ISO-10303-21;\n']), 'rebinding.ifc');
            out.upload = (await fetch('/api/models', { method: 'POST', body: fd })).status;
            const info = await fetch('/api/info');
            out.info = info.status;
            out.infoBody = await info.text();
            out.models = (await fetch('/api/models')).status;
            out.page = (await fetch('/js/main.js')).status;
            return out;
          });
          assert(res.upload === 403 && res.info === 403 && res.models === 403 && res.page === 403, `respuestas con Host ajeno: ${JSON.stringify(res)}`);
          assert(!/presenter/.test(res.infoBody), 'no debe revelar el rol de presentador');
          // y la navegación directa tampoco muestra la aplicación
          const resp = await pg.goto(`${origin}/`).catch(() => null);
          assert(resp && resp.status() === 403, `navegar a evil.test: ${resp && resp.status()}`);
          const lista = await (await fetch(`${srv.url}/api/models`)).json();
          assert(lista.length === 0, `no debe haberse guardado ningún modelo: ${JSON.stringify(lista)}`);
          await ctx.close();
        });
      } finally {
        await evilBrowser.close().catch(() => {});
      }
      await test('la aplicación sigue abriéndose con localhost, 127.0.0.1 y la IP de red', async () => {
        const urls = [`http://localhost:${PORT + 3}`, `http://127.0.0.1:${PORT + 3}`];
        if (lan) urls.push(`http://${lan}:${PORT + 3}`);
        for (const url of urls) {
          const P = await open(browser, `host-${url}`, url);
          await waitForApp(P.page, { ifc: 0 });
          assert((await getSlice(P.page, 'presentation')).connected, `${url}: sin WebSocket`);
          await P.context.close();
        }
      });
    }

    await test('sin errores de consola ni de página en las pantallas con PIN', async () => {
      const lines = [];
      for (const h of handles) {
        for (const e of h.errors) lines.push(`[${h.name}] ${e}`);
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
