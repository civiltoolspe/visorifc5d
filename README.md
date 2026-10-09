# Visor IFC 5D

Visor web de modelos **IFC** con planos **DXF/DWG georreferenciados**, pensado para
mostrar avances, costos y tiempos de ejecución de cada partida (4D/5D). Esta es la
**Fase 1**: el visor IFC propiamente dicho, un servidor local en tu PC y un
**modo presentación** para que otras PCs de la red vean en vivo lo que haces.

- Visor 3D con [three.js](https://threejs.org/) + [web-ifc](https://github.com/ThatOpen/engine_web-ifc) (HTML, CSS y módulos ES nativos, sin bundler).
- Tu PC es el servidor: las demás PCs solo abren una dirección en el navegador.
- Al seleccionar un elemento, el resto se vuelve transparente (modo fantasma); también se puede aislar o solo resaltar.
- Planos DXF y DWG georreferenciados que se alinean con los IFC.
- Modo presentación: los espectadores ven exactamente lo que haces (cámara, selección, cortes, mediciones, puntero láser) y **no pueden interactuar**.

La arquitectura completa y el contrato entre módulos están en [`docs/ARQUITECTURA.md`](docs/ARQUITECTURA.md).

## Requisitos

- **Node.js 20 o superior** (en la PC que hará de servidor).
- Navegador reciente con WebGL2: Chrome o Edge (en la PC anfitriona y en las de los espectadores).
- Las PCs deben estar en la **misma red local** (cable o Wi-Fi) que la PC anfitriona.

## Instalación

```bash
git clone <url-del-repositorio> visorifc5d
cd visorifc5d
npm install
```

Todas las dependencias (three.js, web-ifc, camera-controls, dxf-parser, libredwg-web, Express, ws,
multer...) se sirven desde `node_modules`; no hay paso de compilación.

## Arranque

```bash
npm start
```

Al arrancar, el servidor imprime las direcciones de acceso, por ejemplo:

```
  Visor IFC 5D v0.1.0 - servidor iniciado

  Anfitrión / presentador (esta PC):
    http://localhost:8080

  Espectadores (otras PCs de la red local):
    http://192.168.1.20:8080
```

Para detenerlo pulsa `Ctrl+C` (cierra las conexiones y guarda el estado de forma ordenada).
`npm run dev` arranca con recarga automática del servidor (`node --watch`) para desarrollo.

### Variables de entorno

| Variable          | Valor por defecto | Descripción                                                                                           |
| ----------------- | ----------------- | ----------------------------------------------------------------------------------------------------- |
| `PORT`            | `8080`            | Puerto TCP del servidor.                                                                              |
| `HOST`            | `0.0.0.0`         | Interfaz de escucha. `0.0.0.0` = visible en la red local; `127.0.0.1` = solo esta PC.                 |
| `PRESENTER_PIN`   | (vacío)           | PIN opcional que permite presentar desde otra PC (ver [Roles](#modo-presentación-y-roles)).           |
| `VIEWER_FREE_NAV` | `true`            | Si es `true`, los espectadores navegan libremente cuando **no** hay una presentación activa.          |
| `MAX_UPLOAD_MB`   | `2048`            | Tamaño máximo de un archivo subido, en MB.                                                            |
| `ALLOWED_HOSTS`   | (vacío)           | Nombres de host extra aceptados en la cabecera `Host`, separados por comas (`pc-oficina.lan, *.empresa.local`). Ver [Seguridad](#seguridad). |
| `DATA_DIR`        | `./data`          | Carpeta donde se guardan los modelos subidos (`uploads/`) y el estado de la sesión (`session.json`).  |

Ejemplos:

```powershell
# Windows (PowerShell)
$env:PORT = 8081; $env:PRESENTER_PIN = "4821"; npm start
```

```bat
:: Windows (cmd)
set PORT=8081&& set PRESENTER_PIN=4821&& npm start
```

```bash
# Linux / macOS
PORT=8081 PRESENTER_PIN=4821 npm start
```

## Abrir el visor y compartirlo en la red local

1. **En la PC anfitriona** (la que ejecuta `npm start`) abre **`http://localhost:8080`**.
   Esa PC es automáticamente el **presentador**: puede subir modelos y presentar.
   Usa siempre `localhost` o `127.0.0.1`; si abres la dirección de red (`http://192.168.x.x:8080`)
   desde la misma PC, el servidor te verá como una PC remota (espectador).
2. **En las demás PCs** abre en el navegador una de las **URL de red** que imprimió el servidor
   (por ejemplo `http://192.168.1.20:8080`). También puedes copiarla desde el panel de presentación
   de la interfaz.
3. Los modelos que subas desde la PC anfitriona se guardan en el servidor (`DATA_DIR`) y se
   descargan automáticamente en cada PC conectada.

### Firewall de Windows

Si las otras PCs no pueden abrir la dirección (se queda cargando o da error de conexión), casi siempre
es el Firewall de Windows de la PC anfitriona, que bloquea las conexiones entrantes al puerto del servidor.

**Opción 1 - línea de comandos.** Abre PowerShell o `cmd` **como administrador** y ejecuta
(cambia `8080` si usas otro puerto):

```bat
netsh advfirewall firewall add rule name="Visor IFC 5D" dir=in action=allow protocol=TCP localport=8080
```

Para quitar la regla más adelante:

```bat
netsh advfirewall firewall delete rule name="Visor IFC 5D"
```

**Opción 2 - interfaz gráfica.**

1. Panel de control -> Sistema y seguridad -> **Firewall de Windows Defender** -> *Configuración avanzada*.
2. *Reglas de entrada* -> **Nueva regla...** -> tipo **Puerto** -> **TCP** -> *Puertos locales específicos*: `8080`.
3. **Permitir la conexión** -> marca el perfil **Privado** (y *Dominio* si corresponde; evita *Público*) -> ponle el nombre "Visor IFC 5D".

Otra alternativa es aceptar el aviso de Windows ("Permitir acceso") la primera vez que arranca Node.js,
marcando *Redes privadas*.

Además: ambas PCs deben estar en la misma red, y algunas redes Wi-Fi de oficinas o invitados aíslan
los equipos entre sí (aislamiento de clientes); en ese caso usa cable o una red sin aislamiento.

## Modo presentación y roles

El servidor decide el **rol** de cada conexión por la **dirección IP del socket**:

| Rol           | Quién                                                                                                  | Qué puede hacer                                                                                   |
| ------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| **Presentador** | La propia PC anfitriona (`localhost`), o una PC remota que envíe el PIN correcto (si hay `PRESENTER_PIN`). | Subir/editar/eliminar modelos, iniciar y detener la presentación, tomar el control.               |
| **Espectador**  | Cualquier otra PC de la red.                                                                         | Ver. En presentación sigue en vivo al presentador y no puede interactuar. Sin presentación y con `VIEWER_FREE_NAV=true` puede navegar libremente (sin subir ni borrar modelos). |

Cómo se usa:

1. El presentador pulsa **Presentar** (o la tecla `P`). Todas las PCs conectadas pasan a seguirlo:
   cámara, selección, visibilidad, pestaña activa, cortes, mediciones y **puntero láser**.
   Los espectadores ven la insignia "EN VIVO" y una capa de bloqueo que impide cualquier interacción
   (solo se permite la pantalla completa).
2. El panel de presentación muestra cuántos espectadores hay conectados y la URL de red para copiar.
3. Al volver a pulsar **Presentar** la presentación termina. Si el presentador cierra la pestaña o
   pierde la conexión, la presentación termina sola. Quien entra tarde recibe de inmediato el estado
   y la cámara actuales.
4. **Tomar control**: otro presentador (otra pestaña de la PC anfitriona o una PC con PIN) puede
   asumir la presentación; el presentador anterior pasa a ser espectador.

### PIN para presentar desde otra PC

Si defines `PRESENTER_PIN` (por ejemplo `PRESENTER_PIN=4821`), una PC remota que presente ese PIN
obtiene el rol de presentador. El PIN viaja en la cabecera `X-Presenter-Pin` (HTTP) y en el campo `pin`
del mensaje `hello` (WebSocket). El navegador lo guarda solo en la pestaña (`sessionStorage`, clave
`visor.pin`) y no se imprime en ninguna parte.

**Desde la interfaz:** en la otra PC abre el panel **Conexión** (icono de wifi de la barra lateral), escribe el PIN en
*Presentar desde esta PC* y pulsa Intro; si es correcto la página se recarga con el rol de presentador. Para volver
a ser espectador usa *Dejar de ser presentador*.

Cuando la pantalla está bloqueada (`VIEWER_FREE_NAV=false` sin presentación: "Esperando al presentador", o una presentación en
curso) la barra lateral no responde y el panel Conexión no se puede abrir. En ese caso aparece arriba, junto al botón de
pantalla completa, el botón **Soy el presentador**: despliega un campo para el PIN con el mismo efecto (solo se muestra si el
servidor tiene `PRESENTER_PIN` y esta PC es espectadora; sin presentación activa permite entrar con el PIN y luego presentar,
y con una presentación en curso, tomar el control). (Alternativa por consola:
`sessionStorage.setItem('visor.pin', '4821'); location.reload();`.)

Tras demasiados PIN erróneos desde una misma IP (30 por minuto) el servidor deja de aceptar PIN de esa
IP durante un minuto.

### Previsualizar como espectador

En la PC anfitriona abre `http://localhost:8080/?role=viewer` en otra pestaña o ventana para ver
exactamente la experiencia de un espectador sin necesitar otra PC.

## Formatos soportados

| Formato            | Notas                                                                                                      |
| ------------------ | ---------------------------------------------------------------------------------------------------------- |
| **IFC 2x3 / IFC 4** | Lectura con web-ifc en un Web Worker (la interfaz no se congela). Árbol espacial, propiedades, niveles, categorías. |
| **DXF**            | Leído con `dxf-parser`. Líneas, polilíneas (con bulge), círculos, arcos, elipses, splines, textos, bloques (INSERT), cotas, hatch... |
| **DWG**            | Leído con `@mlightcad/libredwg-web` (LibreDWG compilado a WebAssembly).                                      |

> **Aviso de licencia:** `@mlightcad/libredwg-web` se distribuye bajo **GPL-3.0** (deriva de GNU LibreDWG).
> Para uso interno en tu red local no hay problema, pero si **distribuyes** este visor junto con esa
> dependencia debes cumplir los términos de la GPL-3.0 (entre otros, ofrecer el código fuente de la
> combinación bajo la misma licencia). Si necesitas evitarlo, no uses la carga de DWG y convierte tus
> planos a DXF (el resto del visor no depende de esa librería).

Solo se aceptan las extensiones `.ifc`, `.dxf` y `.dwg` (no distingue mayúsculas).

## Georreferenciación

El visor coloca todos los modelos en **coordenadas de mapa** (Este, Norte, cota) y los alinea entre sí.
Internamente trabaja en metros, con un origen global en doble precisión, de modo que las coordenadas
UTM (cientos de miles o millones de metros) no producen temblores ni pérdida de precisión.

**IFC**

1. **`IfcMapConversion`** (IFC4, con `IfcProjectedCRS`): se usan `Eastings`, `Northings`, `OrthogonalHeight`,
   la rotación (`XAxisAbscissa`, `XAxisOrdinate`) y `Scale`. En IFC2x3 se lee el `ePSet_MapConversion` si existe.
2. **Coordenadas de sitio**: si no hay conversión pero el modelo ya viene con coordenadas grandes
   (p. ej. `IfcSite` colocado directamente en UTM), se usan tal cual.
3. **Sobrescritura manual**: desde la tarjeta del modelo (solo presentador) puedes fijar Este, Norte, cota,
   rotación y escala. Se guarda en el servidor y se aplica a todas las PCs sin recargar el archivo. Con coordenadas
   de sitio (punto 2) el diálogo muestra la posición real del modelo y los valores manuales se suman como un
   desplazamiento (0, 0, 0 = sin mover).

**DXF / DWG**

- Las coordenadas del dibujo se interpretan como **coordenadas de mapa** (E, N) después de aplicar las unidades.
- **Unidades**: se leen de `$INSUNITS` (pulgadas, pies, milímetros, centímetros, metros; "sin unidad" = metros)
  y se pueden sobrescribir por plano (`auto`, `mm`, `cm`, `m`, `in`, `ft`).
- **Cota (H)**: se puede fijar a mano por plano; si no, un plano 2D se coloca automáticamente sobre el
  nivel más bajo del primer IFC cargado (+2 cm para evitar el parpadeo) o a 0 si no hay IFC.
- El color 7 de AutoCAD (blanco/negro) se dibuja oscuro porque el fondo del visor es claro.

Para comprobar la alineación puedes usar los archivos de `tests/fixtures/`: el IFC georreferenciado, el IFC
con `IfcSite` en UTM y el DXF con la huella del edificio, ejes y lote deben coincidir.

## Selección, transparencia y herramientas

- **Seleccionar** un elemento: el resto pasa a modo **fantasma** (transparente). Alternativas: **aislar**
  (ocultar el resto) o **solo resaltar**; la opacidad del fantasma es ajustable.
- `Ctrl`/`Shift` + clic suma o quita elementos a la selección; doble clic encuadra el elemento.
- **Niveles**: selector de nivel con corte de planta o "solo este nivel".
- **Medición** de distancias, **caja de sección**, **vistas guardadas** con miniatura (se guardan en el servidor:
  sobreviven a recargar la página y a reiniciar), búsqueda de elementos, ocultar categorías, aristas, proyección
  perspectiva/planta, **vistas estándar** (planta, frontal, posterior, izquierda, derecha, inferior e isométrica) y
  captura de pantalla. Los espacios (`IfcSpace`) están ocultos por defecto; se muestran desde su categoría o desde
  *Ajustes de selección*.

### Atajos de teclado

| Tecla       | Acción                                           |
| ----------- | ------------------------------------------------ |
| `Esc`       | Limpiar la selección / cancelar la medición      |
| `H`         | Ocultar la selección                             |
| `I`         | Aislar la selección                              |
| `Shift + H` | Mostrar todo                                     |
| `F`         | Encuadrar la selección (o todo si no hay)        |
| `M`         | Activar o desactivar la medición                 |
| `P`         | Iniciar o detener la presentación                |

## API del servidor

Útil para pruebas y para integraciones futuras. Todos los errores devuelven `{ "error": "mensaje" }`.

| Método y ruta                 | Rol         | Descripción                                                                  |
| ----------------------------- | ----------- | ---------------------------------------------------------------------------- |
| `GET /api/info`               | todos       | Rol de quien consulta, IP, URL de red, puerto, versión, PIN activo, navegación libre. |
| `GET /api/models`             | todos       | Lista de modelos (en orden de subida).                                       |
| `POST /api/models`            | presentador | Sube un archivo (`multipart/form-data`, campo `file`). Responde `201` con el registro. |
| `GET /api/models/:id/file`    | todos       | Descarga el archivo (con `Content-Length`, `ETag` y `If-None-Match` -> `304`). |
| `PATCH /api/models/:id`       | presentador | Cambia `name`, `georef` (solo IFC) o `cad.units` (solo DXF/DWG).             |
| `DELETE /api/models/:id`      | presentador | Elimina el modelo y su archivo (`204`).                                      |
| `GET /api/views`              | todos       | Vistas guardadas (`{ items }`).                                              |
| `PUT /api/views`              | presentador | Reemplaza la lista de vistas guardadas (`{ items }`, hasta 60, miniaturas incluidas). |
| `WebSocket /ws`               | todos       | Sincronización de la presentación (mensajes JSON; ver `docs/ARQUITECTURA.md`, sección 4). |

El registro de modelos y las vistas guardadas se guardan en `DATA_DIR/session.json` (escritura atómica) y se recargan al arrancar;
los archivos están en `DATA_DIR/uploads/<id>.<ext>`.

## Seguridad

- Pensado para una **red local de confianza**. No lo expongas directamente a Internet.
- **No lo publiques con túneles ni proxies inversos en la misma PC** (ngrok, cloudflared, nginx...): el servidor
  decide el rol por la IP del socket y no confía en `X-Forwarded-For`, así que todo el tráfico del túnel
  parecería venir de `localhost` y se trataría como presentador.
- Las peticiones que modifican datos (subir, editar, borrar, WebSocket) rechazan orígenes de otro sitio web
  (`Origin` distinto de `Host`), para que una página abierta en el navegador del anfitrión no pueda manipular el servidor.
- **Defensa contra DNS rebinding**: una página maliciosa puede hacer que su dominio resuelva a `127.0.0.1`; entonces `Host` y
  `Origin` coinciden (el dominio del atacante) y, como el socket es loopback, la petición pasaría por presentador. Por eso el
  servidor atiende (HTTP y WebSocket) solo cabeceras `Host` que un atacante no controla: **cualquier IP** (`192.168.1.20:8080`,
  `[::1]`), `localhost` y `*.localhost`, el **nombre de esta PC** (`os.hostname()` y `<nombre>.local`) y los nombres de
  `ALLOWED_HOSTS`. Lo demás recibe `403` y un aviso en la consola del servidor (una vez por nombre). Si abres el visor con un nombre
  DNS propio (p. ej. `visor.empresa.local`), añádelo: `ALLOWED_HOSTS=visor.empresa.local` (admite comodines `*.empresa.local`).
- El PIN (si lo usas) se compara en tiempo constante y con límite de intentos; úsalo solo en redes de confianza,
  porque el tráfico no está cifrado (HTTP).

## Pruebas

```bash
npm test                      # ejecuta todas las pruebas de tests/e2e/*.test.mjs en serie
node tests/run-all.mjs server # solo las pruebas cuyo nombre contenga "server"
node tests/e2e/server.test.mjs # una prueba concreta
npm run fixtures              # regenera los archivos de tests/fixtures (requiere Python 3)
```

- Cada prueba es un script Node que imprime sus resultados y termina con código `0` si todo pasa y `1` si algo falla;
  `tests/run-all.mjs` las lanza como procesos hijo (10 minutos de límite cada una), muestra su salida, resume
  PASS/FAIL y sale con código distinto de cero si alguna falla.
- Las pruebas de navegador usan [Playwright](https://playwright.dev/) con Chromium y WebGL2 por software
  (SwiftShader), por lo que son lentas: usan modelos pequeños. Si Playwright no encuentra Chromium, ejecuta
  `npx playwright install chromium`.
- `server.test.mjs` prueba el servidor real: API REST, estáticos, roles por IP (incluye una conexión desde la
  IP de red de la propia máquina), PIN, persistencia, cierre limpio, WebSocket con varios clientes y el
  cliente `ApiClient`.
- `app.test.mjs` y `presentation.test.mjs` prueban la aplicación completa con el servidor real y todos los módulos
  reales: flujo del presentador (subida, árbol, propiedades, selección con clic real y modo fantasma, niveles, sección,
  medición, vistas), **georreferencia con comprobación numérica** (los dos IFC y el DXF deben coincidir a ≤ 2 cm) y el modo
  presentación con varios navegadores (presentador, espectador `?role=viewer` y espectador real por la IP de red).
  Las demás pruebas (`viewer`, `ifc`, `cad`, `sync`, `ui`) cubren cada módulo por separado con dobles de los otros.
  Las capturas quedan en `tests/output/` (ignorada por git).
- `correcciones.test.mjs` reúne las pruebas de regresión de la ronda de verificación (georreferencia de `IfcSite`,
  espacios en el dock, vistas guardadas persistentes y vistas estándar) con el servidor y los módulos reales.
  `correcciones2.test.mjs` hace lo mismo con la ronda 2: PIN con la pantalla bloqueada, contadores del dock con modelos
  ocultos y DNS rebinding simulado en Chromium (`server.test.mjs` cubre además la cabecera `Host` y `ALLOWED_HOSTS`).
- `tests/fixtures/`: IFC4 con `IfcMapConversion` (EPSG:32718), el mismo edificio en IFC2x3 con `IfcSite` en UTM,
  un DXF georreferenciado y `fixtures.json` con los valores esperados; `downloads/` contiene muestras reales. También hay tres
  DWG R2000 con las mismas coordenadas UTM que el DXF, generados una sola vez con LibreDWG (`dxf2dwg`) y que `npm run fixtures`
  no regenera: `planta_georef_m.dwg` (metros), `planta_georef_mm.dwg` (milímetros) y `dwg_modelspace_duplicado.dwg` (mal
  formado, con dos registros `*Model_Space`).
- `node tests/devserver.mjs [puerto]` sirve solo los archivos estáticos (sin API ni WebSocket) para desarrollar
  módulos del cliente de forma aislada.

## Estructura del proyecto

```
server/                 Servidor Node (Express 5 + ws)
  index.js              arranque, mensajes de consola y cierre limpio
  server.js             ensamblado: estáticos, /vendor, API y mejora a WebSocket
  config.js             variables de entorno y montajes /vendor
  api.js                API REST (/api)
  models.js             registro de modelos, validaciones y persistencia
  hub.js                WebSocket: modo presentación (estado, cámara, puntero, clientes)
  roles.js              rol por IP / PIN con límite de intentos
  hosts.js              validación de la cabecera Host (defensa contra DNS rebinding)
  net.js                direcciones de red y mensaje de arranque
public/
  index.html            shell de la aplicación + import map
  css/                  tokens.css, layout.css, components.css, sidebar.css, hud.css
  js/
    main.js             arranque
    core/               events.js, store.js, actions.js, api.js, ModelLoader.js
    viewer/             Viewer.js, WorldOrigin.js, SectionBox.js, MeasureTool.js
    ifc/                IfcManager.js, IfcModel.js, worker de web-ifc...
    cad/                CadManager.js, CadModel.js, worker de DXF/DWG...
    sync/               SyncClient.js, Presentation.js
    ui/                 App.js y componentes de la interfaz
data/                   (ignorada por git) uploads/ y session.json
docs/                   ARQUITECTURA.md y la imagen de referencia de diseño
tests/
  fixtures/             IFC/DXF georreferenciados de prueba + downloads/ (muestras reales)
  e2e/                  pruebas (*.test.mjs)
  run-all.mjs           ejecutor de todas las pruebas
```

## Solución de problemas

- **"el puerto 8080 ya está en uso"**: cierra el otro programa o arranca con otro `PORT`.
- **Las otras PCs no cargan la página**: revisa el [firewall](#firewall-de-windows), que estén en la misma red y
  que uses la URL de red (no `localhost`) en esas PCs.
- **Mi PC aparece como espectador**: abre `http://localhost:8080` (no la IP de red) en la PC anfitriona.
- **"Dirección de acceso no permitida" (403)**: abriste el visor con un nombre de host que el servidor no reconoce (un DNS propio,
  un túnel...). Usa la IP de la PC o `localhost`, o añade el nombre a `ALLOWED_HOSTS` (el aviso de la consola lo indica).
- **Un espectador no puede subir modelos**: es lo esperado; solo el presentador (o quien use el PIN) puede.
- **Subida rechazada por tamaño**: sube `MAX_UPLOAD_MB`.
- **Los cambios de código no llegan a los espectadores**: el servidor envía los archivos de `public/` con
  revalidación (`Cache-Control: no-cache` + ETag), basta recargar la página (`F5`).

## Hoja de ruta - Fase 2 (4D/5D)

La Fase 2 convierte el visor en una herramienta de seguimiento de obra. La arquitectura ya lo prevé:
cada elemento IFC se indexa por su `GlobalId` y el sistema de estados admite un color de sobrescritura por elemento.

- **Cronogramas de MS Project (XML)**: importar `.xml` de Microsoft Project (tareas, jerarquía/WBS, fechas
  de inicio y fin, duraciones, dependencias, % completado, recursos y costos).
- **Vinculación partida - elementos**: asociar cada tarea o partida con elementos del modelo por `GlobalId`
  (por conjuntos de propiedades, códigos o selección manual) y guardarla en el servidor.
- **4D (tiempo)**: línea de tiempo con reproducción; los elementos aparecen y se colorean según su estado
  (no iniciado, en curso, terminado, atrasado) en la fecha elegida, también en modo presentación.
- **5D (costos)**: costo presupuestado, ejecutado y por ejecutar por partida; costo acumulado en el tiempo
  (curva S) y resumen por categoría o nivel.
- **Avance real vs. planificado**: registrar el avance de cada partida y compararlo con el cronograma
  (indicadores de atraso, "listo para revisión", riesgo alto), con colores en el modelo.
- **Paneles de la referencia de diseño**: progreso total, progreso por especialidad y "Planned progress /
  Installed" en el dock inferior.
