# Visor IFC 5D — Arquitectura (Fase 1)

Este documento es el **contrato** entre módulos. Cada módulo se implementó en
paralelo; si un módulo necesita algo de otro, se usa exactamente la API descrita
aquí. Archivos ya escritos y que NO deben cambiar su API:
`public/js/core/events.js`, `public/js/core/store.js`, `public/js/core/actions.js`,
`public/js/main.js` (orden de arranque).

La sección **12** recoge lo que cambió o se añadió durante la integración (extras de cada
módulo, convenciones que el contrato dejaba abiertas y correcciones). Ante una contradicción
entre el texto original y la sección 12, manda la sección 12.

## 1. Objetivo de la fase 1

- Visor IFC (three.js + web-ifc) con árbol espacial, propiedades, niveles,
  categorías, búsqueda, medición, caja de sección, vistas guardadas.
- Al seleccionar un elemento, el resto cambia de transparencia (modo fantasma);
  modos alternativos: aislar (ocultar el resto) y solo resaltar.
- Carga de planos DXF y DWG georreferenciados, alineados con los IFC.
- Servidor local (la PC del usuario) accesible desde la red local.
- **Modo presentación**: el anfitrión presenta; las demás PCs ven exactamente lo
  que hace (cámara, selección, visibilidad, pestaña de UI, cortes, mediciones,
  puntero láser) y **no pueden interactuar**.
- Fase 2 (fuera de alcance ahora, pero la arquitectura lo prevé): cronogramas
  MS Project XML, avance, costos (4D/5D). Por eso cada elemento IFC se indexa por
  `GlobalId` y el shader de estados admite un color de sobrescritura por elemento.

## 2. Tecnología y convenciones

- Sin bundler ni TypeScript. Módulos ES nativos servidos por Express.
- Navegadores objetivo: Chrome/Edge recientes (WebGL2).
- Import map (en `public/index.html`):

```json
{
  "imports": {
    "three": "/vendor/three/build/three.module.js",
    "three/addons/": "/vendor/three/examples/jsm/",
    "three-mesh-bvh": "/vendor/three-mesh-bvh/src/index.js",
    "camera-controls": "/vendor/camera-controls/dist/camera-controls.module.js",
    "web-ifc": "/vendor/web-ifc/web-ifc-api.js"
  }
}
```

- **Web Workers**: `new Worker(new URL('./x.worker.js', import.meta.url), { type: 'module' })`.
  Los import maps NO aplican dentro de workers: allí usar rutas absolutas
  (`/vendor/web-ifc/web-ifc-api.js`, `/vendor/three/build/three.module.js`, ...).
- Unidades: **metros**. Escena three.js: **Y arriba**, mano derecha.
- Coordenadas de mapa (E, N, H) → escena: `x = E − O.e`, `y = H − O.h`, `z = −(N − O.n)`,
  donde `O` es el origen global (`viewer.worldOrigin`). Una rotación de mapa θ
  (ángulo del eje X local respecto al Este, antihorario en planta) equivale a
  `object.rotation.y = θ`.
- Precisión: los vértices se guardan en Float32 **relativos a un ancla local**
  calculada en doble precisión; el grupo three.js se coloca en `ancla − O`.
  Nunca poner coordenadas UTM directamente en un BufferAttribute.
- Textos de UI y comentarios en **español**.
- Estilo de código: 2 espacios, comillas simples, punto y coma, clases ES.

## 3. Estructura de carpetas

```
server/                 Servidor Node (Express 5 + ws)
  index.js              arranque y cierre limpio (server.js, api.js, hub.js, roles.js, models.js, net.js, config.js)
public/
  index.html            shell de la app + import map
  css/                  tokens.css, layout.css, components.css, sidebar.css, hud.css, about.css
  config/acerca.json    datos del autor y de la aplicación para el diálogo Acerca de (editable; ver README)
  dev/                  sandboxes de cada módulo (viewer.html, ifc.html, cad.html, sync.html, ui-mock.html...)
  js/
    main.js             arranque (ya escrito)
    core/               events.js, store.js, actions.js (ya escritos), api.js, ModelLoader.js, ViewsPersistence.js
    viewer/             Viewer.js, WorldOrigin.js, SectionBox.js, MeasureTool.js
    ifc/                IfcManager.js, IfcModel.js, ifc.worker.js, ...
    cad/                CadManager.js, CadModel.js, cad.worker.js, ...
    sync/               SyncClient.js, Presentation.js
    ui/                 App.js (mountUI) y componentes
data/                   (gitignored) uploads/ y session.json
tests/
  fixtures/             IFC/DXF georreferenciados de prueba + downloads/ (muestras reales)
  e2e/                  pruebas Playwright (*.test.mjs): una por módulo + app.test.mjs (flujo completo y
                        georreferencia numérica) + presentation.test.mjs (multi-cliente) + correcciones.test.mjs
                        (regresiones de la ronda 1 de verificación) + acerca.test.mjs (diálogo Acerca de)
  run-all.mjs           ejecuta todas las pruebas (npm test)
```

## 4. Servidor (`server/index.js`)

- `npm start` → `node server/index.js`. Variables de entorno:
  `PORT` (8080), `HOST` (0.0.0.0), `PRESENTER_PIN` (opcional),
  `VIEWER_FREE_NAV` (`true` por defecto: los espectadores pueden navegar
  libremente cuando NO hay presentación activa), `MAX_UPLOAD_MB` (2048),
  `DATA_DIR` (`./data`), `ALLOWED_HOSTS` (nombres de host extra aceptados en la cabecera `Host`, separados por comas;
  admite `*.dominio`).
- Al arrancar imprime las URL locales y de red (os.networkInterfaces, IPv4 no internas).
- Estáticos: `public/` en `/`. Montajes `/vendor/*`:
  `three` → `node_modules/three/`, `web-ifc` → `node_modules/web-ifc/`,
  `three-mesh-bvh` → `node_modules/three-mesh-bvh/`,
  `camera-controls` → `node_modules/camera-controls/`,
  `dxf-parser` → `node_modules/dxf-parser/dist/`,
  `libredwg-web` → `node_modules/@mlightcad/libredwg-web/`,
  `fonts/urbanist` → `node_modules/@fontsource/urbanist/`.
  `.wasm` con `Content-Type: application/wasm`.
- **Cabecera `Host` (anti DNS rebinding, `server/hosts.js`)**: antes de cualquier otra ruta (HTTP) y antes del resto de
  comprobaciones de la mejora a WebSocket, se rechaza con `403` toda petición cuyo `Host` no sea una IP literal (v4/v6),
  `localhost` / `*.localhost`, `os.hostname()` (o `<nombre>.local`) o un nombre de `ALLOWED_HOSTS`. Un `Host` ausente (HTTP/1.0)
  se acepta. El rechazo se registra una vez por nombre en el log del servidor.
- **Rol**: `presenter` si la petición viene de loopback (127.0.0.1 / ::1 /
  ::ffff:127.0.0.1) o trae `X-Presenter-Pin` (HTTP) / `pin` (WS) igual a
  `PRESENTER_PIN`. Si no, `viewer`.
- `ModelRecord`:
  ```js
  {
    id: string,            // 10 caracteres [a-z0-9]
    name: string,          // nombre original del archivo
    kind: 'ifc' | 'dxf' | 'dwg',
    size: number,          // bytes
    uploadedAt: string,    // ISO
    georef: null | {       // sobrescritura manual (solo IFC); null = automática
      eastings: number, northings: number, height: number,
      rotationDeg: number, scale: number
    },
    cad: null | { units: 'auto'|'mm'|'cm'|'m'|'in'|'ft' }   // solo DXF/DWG
  }
  ```
- REST (JSON; errores `{ error: 'mensaje' }`):
  - `GET  /api/info` → `{ role, clientIp, lanUrls: string[], port, version, presenterPinEnabled, viewerFreeNav }`
  - `GET  /api/models` → `ModelRecord[]` (orden de subida)
  - `POST /api/models` (presentador) multipart campo `file` → `201 ModelRecord`. Solo .ifc .dxf .dwg.
  - `GET  /api/models/:id/file` → binario (Content-Length, ETag, soporta caché)
  - `PATCH /api/models/:id` (presentador) `{ name?, georef?, cad? }` → `ModelRecord`
  - `DELETE /api/models/:id` (presentador) → `204`
  - `GET  /api/views` → `{ items: View[] }` (vistas guardadas; cualquier rol)
  - `PUT  /api/views` (presentador) `{ items: View[] }` → `{ items }`; reemplaza la lista completa. `View = { id, name, camera, state, thumb }`
    (ver `actions.saveView`). Se valida: ≤ 60 vistas, ids `[A-Za-z0-9_-]{1,64}` únicos, `camera` con `position`/`target` `[x,y,z]` finitos,
    `state` solo con los slices `visibility, display, storey, section, selection, models, cad` (≤ 300 000 caracteres),
    `thumb` null o `data:image/(jpeg|png|webp);base64,…` (≤ 200 000 caracteres). Cuerpo máximo 8 MB (ruta propia, antes del
    lector JSON de 1 MB).
  - Persistencia en `DATA_DIR/session.json` (`{ version, savedAt, models, views }`, escritura atómica) y archivos en
    `DATA_DIR/uploads/<id>.<ext>`. Si las `views` de un `session.json` no son válidas se ignoran (con aviso) y los modelos se conservan.
  - Validar ids (sin path traversal), extensiones y tamaño.
- WebSocket en `/ws`, mensajes JSON con campo `t`:
  - Cliente → servidor:
    - `{ t:'hello', name, wantRole?: 'viewer', pin? }` (primer mensaje)
    - `{ t:'ping' }`
    - Solo rol presentador: `{ t:'presentation', active: boolean }`, `{ t:'take-control' }`,
      `{ t:'state', slices: { [slice]: value }, full?: boolean }`, `{ t:'camera', cam }`,
      `{ t:'pointer', p: { x, y, aspect, visible } }`
  - Servidor → cliente:
    - `{ t:'welcome', clientId, role, presentation: { active, presenterId, presenterName }, state, camera, models, clients: { viewers, list }, viewerFreeNav }`
    - `{ t:'presentation', active, presenterId, presenterName }`
    - `{ t:'state', slices, full }`  (solo reenvía los del presentador activo; guarda `lastState` fusionando por slice)
    - `{ t:'camera', cam }` (guarda la última)
    - `{ t:'pointer', p }` (no se guarda)
    - `{ t:'models', models }` (ante cualquier cambio de modelos)
    - `{ t:'clients', viewers, list: [{ id, name, role }] }` (al entrar/salir alguien)
    - `{ t:'error', message }`, `{ t:'pong' }`
  - Reglas: solo el **presentador activo** (quien inició o tomó el control) puede
    emitir `state/camera/pointer`, y solo se reenvían con presentación activa
    (a todos los demás clientes). Si el presentador activo se desconecta, la
    presentación termina. `lastState`/`camera` se limpian al iniciar una nueva.
    Mensajes de un `viewer` que intenten mutar se rechazan con `error`.
  - `wantRole: 'viewer'` degrada a espectador (cualquiera puede degradarse).

## 5. Núcleo del cliente (`public/js/core/`)

### events.js (escrito)
`bus.on(evt, fn) → off`, `bus.once`, `bus.off`, `bus.emit(evt, payload)`.

### store.js (escrito)
Slices y significado: ver el archivo. `store.get/set/patch/setMany/subscribe/subscribeAll/snapshot`.
`meta.source`: `'local' | 'remote' | 'system'`. `SYNCED_SLICES` se transmiten en presentación.

### actions.js (escrito)
`createActions(store)` → `select, clearSelection, hideSelected, isolateSelected, showAll /* también devuelve los modelos
ocultos con el ojo de su tarjeta */,
setTypeHidden, setModelVisible, setSelectionMode, setGhostOpacity, toggleEdges,
setProjection, toggleSpaces, setStorey, setStoreyMode, setCutHeight, setSection,
setCadLayerHidden, setCadLayersHidden, setCadElevation, setTab, toggleSidebar, toggleDock,
setMeasureActive, addMeasure, removeMeasure, clearMeasures, saveView, removeView, applyViewState`.

### api.js (`ApiClient`) — lo implementa el agente del servidor
```js
new ApiClient({ base = '' } = {})
api.getInfo() → Promise<Info>
api.listModels() → Promise<ModelRecord[]>
api.uploadModel(file, onProgress?(loaded, total)) → Promise<ModelRecord>   // XHR para progreso
api.downloadModel(id, onProgress?(loaded, total)) → Promise<ArrayBuffer>   // fetch + stream para progreso
api.patchModel(id, partial) → Promise<ModelRecord>
api.deleteModel(id) → Promise<void>
api.getViews() → Promise<View[]>                  // GET /api/views
api.putViews(items) → Promise<View[]>             // PUT /api/views (presentador)
api.fileUrl(id) → string
api.setPin(pin) / api.getPin()    // sessionStorage 'visor.pin'; se envía como X-Presenter-Pin
```

### ViewsPersistence.js (`ViewsPersistence`)
```js
new ViewsPersistence({ api, store, bus, delay = 500 })
await persistence.start()   // GET /api/views → store.views (source 'system'); empieza a guardar
await persistence.flush()   // guarda ya lo pendiente
persistence.dispose()
```
- Mantiene `store.views` sincronizado con el servidor: cualquier PC carga las vistas guardadas al arrancar (salvo que siga a otro
  presentador, cuya lista manda). **Solo el presentador** guarda (`PUT /api/views`, agrupado ~500 ms, sin guardados simultáneos);
  los cambios `remote` y `system` nunca se reenvían. Si el guardado falla emite un `toast` de aviso una vez. `main.js` lo crea
  tras `Presentation` y lo expone como `ctx.viewsPersistence`.

### ModelLoader.js (`ModelLoader`) — lo implementa el agente de sincronización
```js
new ModelLoader({ api, store, bus, ifc, cad, viewer })
loader.start()                 // api.listModels() + escucha bus 'server:models'
loader.reconcile(records)      // carga nuevos (cola secuencial), descarga eliminados,
                               // aplica cambios de georef (ifc.updateGeoref) y de cad.units (recarga)
loader.uploadFiles(files)      // presentador: sube con api.uploadModel; el servidor difunde 'models'
loader.isLoaded(id) → boolean
```
- Mantiene `store.modelRecords` (local) y `store.loading[modelId] = { name, kind, phase:'download'|'parse'|'done'|'error', progress: 0..1, error? }`.
- Al cargar un modelo nuevo: si `store.models[id]` no existe, lo crea `{ visible: true }` (source 'system').
- Tras cargar el **primer** modelo, `viewer.fitAll()` salvo que esta PC sea espectador en una presentación activa.
- Eventos: `bus.emit('model:loaded', { modelId, kind, model })`, `'model:unloaded' { modelId }`, `'model:error' { modelId, error }`.

## 6. Visor (`public/js/viewer/`)

### Viewer.js
```js
new Viewer(container, { bus, store })
viewer.scene, viewer.renderer, viewer.camera (cámara activa), viewer.controls (CameraControls)
viewer.worldOrigin            // instancia de WorldOrigin
viewer.modelsRoot             // THREE.Group con los grupos de los modelos
viewer.overlayRoot            // THREE.Group para ayudas (medición, caja de sección)
viewer.requestRender()        // render bajo demanda (no renderizar en cada frame si nada cambia)
viewer.add(obj) / viewer.remove(obj)          // dentro de modelsRoot
viewer.getCameraState() → CameraState
viewer.setCameraState(state, { smooth = true } = {})
viewer.followCamera(state)    // para espectadores: interpolación continua suave hacia el estado recibido
viewer.stopFollow()           // cancela el seguimiento en curso
viewer.isCameraMoving()       // true si la cámara aún se mueve (amortiguado de los controles o seguimiento en curso); las pruebas E2E lo usan para esperar a que se asiente
viewer.fitToBox(box3, { smooth = true, padding = 1.15 } = {})
viewer.fitAll({ smooth })     // caja de todo lo visible en modelsRoot
viewer.setProjection('perspective' | 'orthographic')   // también reacciona a store.display.projection
viewer.setView('top'|'bottom'|'front'|'back'|'left'|'right'|'iso')
viewer.zoomStep(+1|-1), viewer.orbitStep(dxDeg, dyDeg)   // botones de la UI
viewer.setClipping(key, planes /* THREE.Plane[] */)     // grupos con nombre: 'section', 'storey'; se combinan en renderer.clippingPlanes
viewer.getClippingPlanes() → THREE.Plane[]
viewer.addPickProvider({ id, raycast(raycaster) → Hit[] })
viewer.pick(ndc, { kinds } = {}) → Hit | null   // más cercano, descartando lo recortado por los planos activos
viewer.pickAll(ndc, opts) → Hit[]
viewer.screenshot({ width, height, mime = 'image/jpeg', quality = 0.85 } = {}) → dataURL
viewer.renderTopView({ box, width, height }) → dataURL    // miniatura en planta (para selector de niveles)
viewer.enableInput(bool)      // false = bloqueado (espectador en presentación)
viewer.ndcFromEvent(evt) → { x, y }
viewer.getAspect() → number
viewer.dispose()
```
- `CameraState = { position:[x,y,z], target:[x,y,z], projection:'perspective'|'orthographic', zoom:number, fov:number }`
- `Hit = { distance, point: THREE.Vector3, kind: 'ifc'|'cad'|'other', modelId, expressId?, object? }`
- Eventos emitidos en `bus`:
  - `'viewer:click'` `{ ndc:{x,y}, clientX, clientY, button, shiftKey, ctrlKey, metaKey, altKey }` (pointerup sin arrastre, < 5 px)
  - `'viewer:dblclick'` (mismo payload)
  - `'viewer:pointermove'` `{ ndc, clientX, clientY }` (máx. 1 por frame)
  - `'viewer:pointerleave'`
  - `'viewer:camera'` `CameraState` (máx. 1 por frame, solo si cambió)
  - `'viewer:resize'` `{ width, height, aspect }`
- Con `enableInput(false)` NO se emiten click/dblclick/pointermove y los controles no responden.
- Aspecto: fondo claro (degradado sutil #F3F3F2 → #E7E7E6 o `scene.background` claro),
  luz hemisférica + direccional suave, `renderer.localClippingEnabled = true`,
  antialias, `outputColorSpace = SRGB`, pixelRatio ≤ 2.
- `camera-controls` (instalar con `CameraControls.install({ THREE })`), con transiciones suaves.
- Teclas de navegación las gestiona la UI (no el visor).

### WorldOrigin.js (YA ESCRITO — usarlo tal cual)
```js
new WorldOrigin(bus)
wo.origin → { e, n, h } | null
wo.register(object3D, anchor /* {e,n,h} */, { georeferenced = false } = {})
   // fija object3D.position = mapToScene(anchor). Si origin es null → origin = ancla redondeada a 1 m.
   // Si el origen lo fijó un modelo NO georreferenciado y llega uno georreferenciado (|E| o |N| > 10000),
   // hace rebase al nuevo.
wo.update(object3D, anchor)
wo.unregister(object3D)       // si no queda nada registrado, origin = null
wo.mapToScene(e, n, h, target?) → THREE.Vector3
wo.sceneToMap(vec3) → { e, n, h }
wo.rebase(newOrigin)          // reposiciona todo lo registrado; bus.emit('origin:changed', { delta: Vector3 })
```
El Viewer desplaza la cámara con `delta` en un rebase para que la vista no salte.

### SectionBox.js
```js
new SectionBox({ viewer, store, bus })
```
- Reacciona a `store.section` (`enabled`, `min`, `max` en escena). Al activarse con caja
  vacía (min == max) usa la caja de lo visible (o de la selección si hay) y la escribe en el store.
- Crea 6 planos → `viewer.setClipping('section', planes)`; dibuja el contorno de la caja
  (líneas naranja #FF6A13 tenues) en `viewer.overlayRoot`.
- `section.fitTo(box3)`, `section.getBounds()` (límites para los deslizadores de la UI).

### MeasureTool.js
```js
new MeasureTool({ viewer, store, bus, actions })
```
- Con `store.measure.active`, los clics del visor (bus `viewer:click`) toman puntos con
  `viewer.pick` (cualquier tipo). Dos puntos → `actions.addMeasure(a, b)` (arrays escena).
  Mientras se mide: marcador del primer punto y línea elástica al cursor.
- Dibuja **todas** las mediciones de `store.measure.items` (también las recibidas en remoto):
  línea + etiqueta HTML (CSS2DRenderer de `three/addons/renderers/CSS2DRenderer.js`) con la
  distancia en metros (`12.345 m`) y Δz. Botón × en la etiqueta para borrar (solo si se puede interactuar).
- Esc cancela el punto en curso.

## 7. IFC (`public/js/ifc/`)

```js
new IfcManager({ viewer, store, bus, actions })
await ifc.load(record /* ModelRecord */, arrayBuffer, onProgress?(phase, p)) → IfcModel
ifc.unload(modelId)
ifc.has(modelId) → boolean
ifc.getModels() → IfcModel[]
ifc.getProjectInfo() → { name, longName, buildings: string[], schema } | null   // del primer IFC
ifc.getSpatialTree(modelId) → TreeNode   // { expressId, type, typeLabel, name, children: TreeNode[], isSpatial }
ifc.getStoreys() → [{ modelId, expressId, name, elevation /* y escena */, mapHeight, elementCount }]  // ordenados por elevación
ifc.getTypeSummary() → [{ type /* 'IFCWALL' */, label /* 'Muros' */, count }]
ifc.getElementInfo(modelId, expressId) → { modelId, expressId, globalId, type, typeLabel, name, storeyName, storeyId } | null
await ifc.getProperties(modelId, expressId) → {
  attributes: [{ name, value }],
  psets: [{ name, props: [{ name, value }] }],
  quantities: [{ name, props: [{ name, value, unit }] }],
  type: { name, psets: [...] } | null,
  materials: string[]
}
ifc.search(query, limit = 50) → [{ modelId, expressId, name, type, typeLabel, globalId }]
ifc.findByGlobalId(globalId) → { modelId, expressId } | null      // para la fase 2 (cronograma)
ifc.getBoxOf(items) → THREE.Box3 | null          // escena
ifc.getModelBox(modelId) → THREE.Box3 | null
ifc.getBaseElevation() → number | null           // cota de mapa (H) del nivel más bajo del primer IFC; null si no hay IFC
ifc.getGeorefInfo(modelId) → { source: 'mapconversion'|'site'|'manual'|'none', crs, eastings, northings, height, rotationDeg, scale }
ifc.updateGeoref(modelId, georefOverride | null) // reubica sin recargar
ifc.setElementColors(modelId, Map<expressId, '#rrggbb'> | null)   // sobrescritura de color (fase 2: 4D/5D)
```

Requisitos clave:
- **web-ifc en un Web Worker** (la UI no se congela). Ajustes: `COORDINATE_TO_ORIGIN: true`
  y recuperar la matriz con `GetCoordinationMatrix` para reconstruir las coordenadas reales en
  doble precisión.
- **Georreferencia**: IFC4 `IfcMapConversion` (+ `IfcProjectedCRS.Name`); IFC2x3 `ePSet_MapConversion`
  si existe; si no hay ninguno pero las coordenadas del modelo ya son grandes (p. ej. IfcSite colocado en
  UTM), se usan tal cual (`source: 'site'`). Sobrescritura manual desde `record.georef`.
  Fórmulas IfcMapConversion (θ = atan2(XAxisOrdinate, XAxisAbscissa), s = Scale):
  `E = Eastings + s·(x·cosθ − y·sinθ)`, `N = Northings + s·(x·sinθ + y·cosθ)`, `H = OrthogonalHeight + z`
  (x, y, z coordenadas del modelo, Z arriba, en metros).
- **Render escalable**: geometría fusionada por material (color+opacidad), con atributo por vértice
  `elementIndex`; estados por elemento en una `DataTexture` (texelFetch) leída por el shader
  (onBeforeCompile). Dos pasadas por lote: opaca (descarta fantasmas/ocultos) y fantasma
  (transparente, depthWrite false, solo fantasmas). Estados: normal, fantasma, oculto, seleccionado,
  hover, color de sobrescritura. Cambiar estados = actualizar la textura (sin reconstruir geometría).
- Aristas (estilo plano arquitectónico de la referencia): `LineSegments` fusionadas con el mismo
  `elementIndex` y la misma textura de estados; se activan con `store.display.edges`.
- Selección resaltada: color original con tinte naranja #FF6A13 suave + aristas más oscuras.
  Fantasma: blanco/gris claro con opacidad `display.ghostOpacity`.
- **Picking** con `three-mesh-bvh` (registrar `viewer.addPickProvider({ id:'ifc', raycast })`);
  ignorar elementos ocultos; los fantasmas sí se pueden seleccionar.
- IfcOpeningElement nunca se dibuja; IfcSpace oculto salvo `display.showSpaces`.
- Resolución de estados (se recalcula ante cambios en `models, selection, visibility, display, storey, hover`):
  1. modelo oculto → grupo invisible.
  2. tipo en `hiddenTypes`, en `hidden[modelId]`, fuera de `isolated` (si no es null),
     o (storey.mode === 'only' y el elemento no es del nivel activo) → OCULTO.
  3. storey.mode === 'cut' con nivel activo: elementos de niveles superiores → OCULTO y plano de corte
     horizontal a `elevación del nivel + cutHeight` → `viewer.setClipping('storey', [plane])`.
  4. Con selección: seleccionados → SELECCIONADO; resto según `selectionMode`:
     'ghost' → FANTASMA, 'isolate' → OCULTO, 'highlight' → NORMAL.
  5. `hover` (solo si no está oculto) → HOVER (tinte sutil).
- Interacción (dentro de IfcManager): `viewer:click` → pick IFC → `actions.select([...], { toggle: ctrl/meta/shift })`;
  clic en vacío → `actions.clearSelection()` (salvo con modificador). `viewer:dblclick` → encuadrar el
  elemento. `viewer:pointermove` → `store.set('hover', ..., { source: 'local' })` (throttle ~50 ms).
  Ignorar clics si `store.measure.active`.
- Nombres legibles de tipos IFC en español (IFCWALL → 'Muros', IFCSLAB → 'Losas', IFCCOLUMN → 'Columnas', ...).

## 8. CAD (`public/js/cad/`)

```js
new CadManager({ viewer, store, bus })
cad.setElevationProvider(fn /* () => number | null */)
await cad.load(record, arrayBuffer, onProgress?(phase, p)) → CadModel
cad.unload(modelId), cad.has(modelId), cad.getModels() → CadModel[]
cad.getLayers(modelId) → [{ name, color: '#rrggbb', count }]
cad.getBox(modelId) → THREE.Box3 | null
cad.refreshElevation()   // recalcula la cota automática (se llama al cargar/descargar IFC)
```
`CadModel = { id, name, kind:'dxf'|'dwg', group, units, unitScale, extents:{ min:{e,n,h}, max:{e,n,h} }, anchor:{e,n,h}, georeferenced, elevation, layers }`
- Parseo en **Web Worker**: DXF con `dxf-parser` (UMD `/vendor/dxf-parser/dxf-parser.js` vía
  `importScripts` en un worker clásico, o equivalente); DWG con `@mlightcad/libredwg-web`
  (`/vendor/libredwg-web/dist/libredwg-web.js`, wasm en `/vendor/libredwg-web/wasm/`). Ambos se normalizan a
  un formato intermedio común y se convierten a búferes Float32 relativos al ancla.
- Entidades: LINE, LWPOLYLINE/POLYLINE (con bulge → arcos), CIRCLE, ARC, ELLIPSE, SPLINE,
  POINT, INSERT (bloques anidados, escala, rotación, filas/columnas), TEXT, MTEXT, DIMENSION
  (vía su bloque), SOLID, 3DFACE, HATCH (contornos; relleno sólido semitransparente), ATTRIB.
- Unidades: `$INSUNITS` (1 in, 2 ft, 4 mm, 5 cm, 6 m; 0 = sin unidad → m), sobrescribible con `record.cad.units`.
- Georreferencia: las coordenadas del dibujo se interpretan como coordenadas de mapa (E, N) tras aplicar
  unidades. `georeferenced = true` si |E| o |N| > 10000 m. Cota (H): `store.cad[id].elevation` si no es null;
  si es null y el dibujo es plano → `elevationProvider()` + 0.02 m (o 0 si no hay IFC).
- Colores: ACI/true color, ByLayer/ByBlock; el color 7 (blanco/negro) se dibuja oscuro (#2B2B2B) porque el fondo es claro.
- Un objeto por capa (LineSegments con colores por vértice; mallas para rellenos; texto) para que
  `store.cad[id].hiddenLayers` solo cambie `visible`.
- Texto: atlas de glifos en canvas (Latin-1, tipografía sans), quads fusionados por capa; un draw call por capa.

## 9. Sincronización y presentación (`public/js/sync/`)

```js
new SyncClient({ store, bus, info })
sync.connect()                 // ws(s)://host/ws, reconexión con backoff; envía hello { name, wantRole, pin }
sync.send(msg)
sync.startPresentation(), sync.stopPresentation(), sync.takeControl()
sync.sendState(slices, full = false), sync.sendCamera(cam), sync.sendPointer(p)
```
- Emite en `bus`: `'sync:status' { connected }`, `'sync:welcome' msg`, `'sync:presentation' msg`,
  `'sync:state' msg`, `'sync:camera' msg`, `'sync:pointer' msg`, `'sync:clients' msg`,
  `'server:models' ModelRecord[]`.
- Actualiza `store.presentation` (`connected, role, clientId, active, presenterId, presenterName,
  isActivePresenter, viewers`) con `source: 'system'`.

```js
new Presentation({ sync, store, bus, viewer })
presentation.start(), presentation.stop(), presentation.toggle(), presentation.takeControl()
presentation.setLaser(bool)
```
- **Presentador activo**: al iniciar envía `state` completo (`store.snapshot()`, full=true) + cámara;
  luego difunde cambios de `SYNCED_SLICES` con `meta.source !== 'remote'` (agrupados ~30 ms),
  la cámara (bus `viewer:camera`, ~20 Hz) y el puntero láser (`viewer:pointermove`, ~30 Hz,
  `{ x, y }` en NDC + `aspect` del presentador).
- **Espectador** con presentación activa: aplica `state` con `store.setMany(slices, { source: 'remote' })`,
  la cámara con `viewer.followCamera(cam)` (si la proyección difiere, cambiarla; el seguimiento usa el tiempo real
  entre fotogramas, con tope de 0,5 s, para converger igual de rápido con fotogramas lentos), dibuja el puntero
  láser (punto rojo con estela sobre el visor; corrige x por la relación de aspecto:
  `x' = x · aspectPresentador / aspectLocal`) y bloquea toda interacción: `viewer.enableInput(false)` y
  la UI muestra una capa de bloqueo (lo hace la UI observando `store.presentation`).
- Sin presentación activa: si `viewerFreeNav` el espectador navega libremente (no puede subir/borrar
  modelos); si no, sigue bloqueado con el mensaje "Esperando al presentador".

## 10. Eventos transversales del bus

- `'toast'` `{ type: 'info'|'success'|'warning'|'error', message, timeout? }` → la UI muestra una notificación.
- `'model:loaded'`, `'model:unloaded'`, `'model:error'` (ModelLoader).
- `'origin:changed'` `{ delta, origin }` (WorldOrigin).
- `'ifc:states-changed'` `{ modelId }` (IfcManager, tras recalcular estados; útil para la UI).
- `'app:ready'` ctx (main.js).

## 11. UI (`public/index.html`, `public/css/`, `public/js/ui/`)

`mountUI(ctx)` con `ctx = { bus, store, actions, api, info, viewer, section, measure, ifc, cad, loader, sync, presentation }`.

Diseño según la imagen de referencia (fondo gris claro, tarjetas blancas muy redondeadas con
sombra suave, tipografía Urbanist fina, acentos amarillo #FFC21A y naranja #FF6A13, píldoras negras
para el estado activo, paneles inferiores en "vidrio" marrón/naranja):

- `#viewport` ocupa toda la ventana detrás de los paneles flotantes.
- **Barra lateral izquierda** (tarjeta blanca): logo amarillo, buscador de elementos, iconos
  (presentación, conexión, ajustes). Fila de pestañas tipo píldora: Inicio (modelos + resumen),
  Árbol, Propiedades, Capas CAD, Vistas. Contenido de la pestaña activa (`store.ui.tab`).
  - Inicio: botón "Cargar IFC / DXF / DWG" + soltar archivos (solo presentador), tarjetas de modelos
    (nombre, tipo, tamaño, insignia de georreferencia, ojo, encuadrar, configurar georref/unidades/cota,
    eliminar), progreso de carga, resumen (nº de elementos, niveles, categorías) con cifras grandes finas.
  - Árbol: árbol espacial con búsqueda, ojo por nodo, clic = seleccionar, doble clic = encuadrar.
  - Propiedades: atributos, Psets, cantidades, tipo, materiales del elemento seleccionado.
  - Capas CAD: capas por plano con color, ojo, todas/ninguna, cota del plano.
  - Vistas: guardar vista (miniatura + nombre), restaurar, borrar.
- **Cabecera** sobre el visor: título grande = nombre del proyecto IFC (o "Visor IFC 5D"),
  chips (edificio, fecha).
- **Arriba a la derecha**: miniatura (última vista guardada o captura) y botones: encuadrar todo,
  3D/planta (proyección), vistas estándar, medir, sección, aristas, captura de pantalla, ajustes de selección
  (modo fantasma/aislar/resaltar + opacidad). *Vistas estándar* (`.tool[data-tool="views"]`) abre un panel con
  Planta, Frontal, Posterior, Izquierda, Derecha, Inferior e Isométrica (`viewer.setView(name, { fit: true })`; todas pasan
  a proyección ortogonal salvo la isométrica, que vuelve a perspectiva) y marca la vista cuya dirección coincide con la actual.
- **Derecha**: zoom + / −.
- **Abajo izquierda**: cruceta de órbita (↑ ↓ ← →).
- **Abajo centro**: selector de nivel (▲ 02 ▼ + nombre + miniatura en planta + modo corte/solo).
- **Tarjeta oscura de selección**: nombre, tipo, nivel, GlobalId corto, botón → propiedades;
  acciones ocultar / aislar / mostrar todo.
- **Dock inferior** (vidrio marrón→naranja, plegable): "Resumen del modelo" y "Categorías"
  (tipo, cantidad, ojo, clic = aislar categoría). Los contadores y los ojos reflejan lo realmente oculto: `ui.effectiveHiddenTypes()`
  añade IfcSpace a `visibility.hiddenTypes` mientras `display.showSpaces` sea false (valor por defecto). `ui.visibilitySummary()`
  (`UiContext`) calcula los contadores de elementos y categorías del dock y la ficha OCULTOS de la pestaña Inicio: un elemento
  cuenta como oculto por su tipo, a mano **o porque su modelo está oculto con el ojo de la tarjeta** (`models[id].visible === false`),
  sin contarlo dos veces; una categoría que solo existe en modelos ocultos no cuenta como visible.
- **Presentación**: botón "Presentar" (presentador) con contador de espectadores, URL de red para
  copiar, toggle de puntero láser, "Tomar control". Para espectadores: insignia "EN VIVO · Siguiendo a
  {nombre}", capa de bloqueo que impide toda interacción (solo se permite pantalla completa).
- **Acerca de** (`AboutDialog.js`, `css/about.css`): diálogo modal con el logo, la fase y la versión (`ctx.info.version`), la tarjeta del autor
  (avatar con iniciales, correo con `mailto:` y botón copiar; filas opcionales de teléfono, colegiatura, empresa, ubicación, web y LinkedIn solo
  si el JSON las trae), la descripción, el rol de esta PC y las URL de red (`store.presentation.lanUrls`), la hoja de ruta y las tecnologías con su
  licencia. Los datos salen de `public/config/acerca.json` (se vuelve a leer en cada apertura; si falta o es inválido se usan los valores por
  defecto embebidos en el módulo, y un campo de `aplicacion` con un tipo inesperado toma también su valor por defecto; si el servidor responde
  404 no se vuelve a pedir hasta recargar la página). Se abre con el botón `i` junto a pantalla completa (`StatusCluster`, `data-allow-locked`: también para el
  espectador con la capa de bloqueo) o con el logo de la barra lateral. Su estado abierto/cerrado es **local** (`ui.about.isOpen`, nunca un slice
  sincronizado): abrirlo no cambia nada en los espectadores. Va por encima de la capa de bloqueo (`--z-about`), Esc solo lo cierra (su oyente de
  teclado se registra antes que el de `Shortcuts`, que además se desactiva mientras está abierto; si Esc se mantiene pulsado, las repeticiones
  posteriores al cierre también se detienen hasta soltar la tecla), atrapa el foco y lo devuelve al botón que lo abrió.
- Toasts, diálogo de georreferencia manual (E, N, H, rotación, escala), atajos de teclado:
  Esc (limpiar selección / cancelar medición), H (ocultar selección), I (aislar), Shift+H (mostrar todo),
  F (encuadrar selección o todo), M (medir), P (presentar).
- Iconos SVG en línea propios (sin fuentes de iconos externas). Fuente Urbanist desde `/vendor/fonts/urbanist/`.
- `#fatal-error` (oculto) para errores de arranque.

## 12. Notas de integración (fase 1)

Resumen de lo verificado de punta a punta con el servidor real (`tests/e2e/app.test.mjs` y
`tests/e2e/presentation.test.mjs`) y de lo que los módulos añadieron o precisaron respecto al texto anterior.

### 12.1 Arranque (`main.js`)
- Además del orden original, `main.js` registra `viewer.setSelectionBoxProvider((items) => ifc.getBoxOf(items))`
  (la caja de sección usa la selección IFC al activarse) y expone `window.__visor = ctx` (depuración y pruebas).
- `?role=viewer` en la PC anfitriona previsualiza la experiencia de un espectador.

### 12.2 Servidor y `ApiClient`
- `ModelRecord` de DXF/DWG nace con `cad = { units: 'auto' }`; en IFC `cad = null` y `georef = null`.
  `PATCH` valida: `georef` solo en IFC (E y N numéricos obligatorios; `height = 0`, `rotationDeg = 0`, `scale = 1`
  si faltan), `cad` solo en DXF/DWG; los campos desconocidos se ignoran.
- Rol por IP del socket (loopback = presentador); no se confía en `X-Forwarded-For`. Con `PRESENTER_PIN`, una PC
  remota presenta enviando el PIN (`X-Presenter-Pin` / `hello.pin`); la UI lo pide en el panel *Conexión*
  (`api.setPin(pin)` + recarga). `SyncClient` lee el mismo PIN de `sessionStorage['visor.pin']`.
- Seguridad añadida: `POST/PATCH/DELETE` y la mejora a WebSocket con cabecera `Origin` distinta de `Host` se rechazan
  con 403; 30 PIN erróneos por minuto y por IP como máximo. Ronda 2: además se valida el propio `Host` (ver sección 4,
  `server/hosts.js`), porque con DNS rebinding `Host` y `Origin` valen lo mismo y el socket es loopback (rol presentador).
- `clients.viewers` = conectados menos el presentador activo (sin presentación activa son todos los conectados).
  `welcome.state` / `welcome.camera` solo traen datos con presentación activa; `lastState` y la cámara se limpian al
  iniciar y al terminar. `take-control` los conserva (el nuevo presentador envía su estado completo con `full: true`).
- `ApiClient`: `uploadModel(file, onProgress, { signal })`, `downloadModel(id, onProgress, { signal })`
  (`total = 0` si no hay `Content-Length`), clase `ApiError` (mensajes en español, `status`, `cause`).
- Pruebas con Chromium: cualquier proxy del entorno (`HTTPS_PROXY`) rechaza los WebSocket hacia la IP de red de la
  propia máquina con un 403; `launchBrowser()` usa `--proxy-server=direct://`.

### 12.3 Visor (`Viewer`, `SectionBox`, `MeasureTool`)
- Dos escenas: `scene` (modelos, con recorte) y `overlayScene` (ayudas, sin recorte). Render bajo demanda.
- `CameraState.zoom` en ortográfica = `ORTHO_H / altura visible en metros` (`ORTHO_H = 100`, exportado); en perspectiva
  vale 1. Las dos cámaras no comparten distancia: en ortográfica solo importa la dirección `position - target`.
- **Zona libre (nuevo)**: `viewer.setFitInsets({ left, right, top, bottom })` (px CSS) indica qué parte del visor
  tapan los paneles flotantes. `fitAll`, `fitToBox` y `setView(..., { fit: true })` encuadran y centran el modelo en
  la zona libre (el objetivo de la cámara se desplaza). `mountUI` lo calcula desde la barra lateral y el dock y lo
  actualiza al cambiar el tamaño o plegar paneles. Sin insets (sandboxes) el comportamiento es el de siempre.
  `viewer.getFitInsets()` devuelve los valores actuales.
- `viewer:click` se emite para cualquier botón (`button`: 0, 1, 2); IfcManager y MeasureTool filtran `button === 0`.
  `viewer:pointermove` añade `buttons` y `pointerType`. Eventos extra: `viewer:input { enabled }`,
  `viewer:projection { projection }`.
- `SectionBox` rellena una caja vacía en un microtask: tras `actions.setSection({ enabled: true })` el store tiene
  `min == max` hasta que termine la tarea síncrona (leer el store tras `await Promise.resolve()` o suscribirse).
- `MeasureTool`: distancia con `Intl es-PE` y 3 decimales (`12.345 m`), `Δz` solo si supera 1 mm. La etiqueta elástica
  (`.measure-label--preview`) existe siempre y se oculta con `display: none` cuando no hay medición en curso.
- `renderTopView` y `screenshot` no incluyen las etiquetas HTML.

### 12.4 IFC
- `ifc.load(record, arrayBuffer, onProgress)` **transfiere** el `ArrayBuffer` al worker (queda con `byteLength 0`).
  `ifc.has(id)` es true desde el primer fragmento (carga progresiva); `ifc.getModels()` solo devuelve modelos terminados.
- `element.type` es la clase real en MAYÚSCULAS (`IFCWALLSTANDARDCASE`); `getTypeSummary` y `visibility.hiddenTypes`
  tratan las variantes `*STANDARDCASE` / `*ELEMENTEDCASE` como su clase base (`IFCWALL`...). Etiquetas: singular en
  `typeLabel` / `search`, plural en `getTypeSummary().label`.
- `TreeNode` añade `hasGeometry`; los elementos sin nivel cuelgan de `{ expressId: -1, type: 'GROUP', name: 'Sin nivel asignado' }`.
  `visibility.hidden`, `visibility.isolated` y `selection.items` aceptan también `expressId` de nodos del árbol (se
  expanden con `ifc.getDescendants(modelId, expressId)`).
- Estados (`ifc.getElementState`): 0 normal, 1 fantasma, 2 oculto, 3 seleccionado, 4 hover, -1 desconocido.
  **Regla añadida**: si la selección existe pero queda toda oculta (por tipo, nivel, aislamiento...), no se transparenta
  el resto (no habría nada resaltado).
- `IfcModel.getBox()` es exacto con modelos girados (`IfcMapConversion` con rotación): une las cajas de los elementos
  girados en lugar de girar la caja local del conjunto (que la inflaba hasta decenas de cm).
- Georreferencia (`ifc.getGeorefInfo`): `source` = `mapconversion | site | manual | none`, más `anchor`, `georeferenced`,
  `hasMapConversion`. Una sobrescritura manual significa "posición de mapa del origen del modelo" (semántica IfcMapConversion).
  Eventos extra: `ifc:model-ready { modelId }`, `ifc:georef-changed { modelId }`. Extras: `getModel`, `getDescendants`,
  `getModelSummary` (incluye `types: [{ type, label, count }]` del modelo), `flushStates`.
- Niveles federados: con `storey.mode === 'only'` o `'cut'`, el nivel activo se compara por cota de mapa (±0,1 m) entre
  modelos; la UI (`UiContext.storeys()`) agrupa los niveles homónimos de varios IFC en un solo nivel (`members`).

### 12.5 CAD
- DXF: `dxf-parser` + barrido de grupos (`dxfScan.js`); DWG: `libredwg-web` (no lee DXF). Ambos se normalizan a un
  formato intermedio común. `cad.load` no transfiere el buffer (envía una copia).
- `CadModel` añade `drawingAnchor`, `drawingExtents`, `hasZ`, `flat`, `insunits`, `unitsSource`, `stats`, `layerObjects`
  (Map capa → objetos three.js) y `setHiddenLayers()`. `anchor.h` incluye la cota efectiva. `getLayers` solo lista capas
  con geometría y devuelve el color realmente dibujado.
- Estado inicial: si no existe `store.cad[id]`, se crea (source `system`) con `hiddenLayers` = capas apagadas del archivo y
  `elevation: null`. Cota efectiva: `elevation` numérica si existe; 0 en dibujos con Z propia; si no, `elevationProvider() + 0,02`.
- Emite `cad:elevation { modelId, elevation }`. No registra proveedor de picking (la medición no se ancla a líneas CAD).
- Un plano georreferenciado y un IFC sin georreferenciar (o al revés) quedan muy separados: las coordenadas del dibujo se
  interpretan literalmente como mapa. Con modelos muy lejanos del origen la precisión de render baja.

### 12.6 Sincronización y presentación
- `bus 'model:unloaded'` lleva `{ modelId, kind }`; `'model:error'` lleva `{ modelId, error: string, message, name }`.
- `store.loading[id]` añade `kind`, `queued` y `stage`; las entradas `done` no se eliminan (la UI las oculta) y se borran al
  descargar el modelo. Fases: `upload` (id temporal `upload-n`), `download`, `parse`, `done`, `error`.
- `SyncClient`: `reconnect()` (hay que llamarlo tras `api.setPin()`), `disconnect()`, `getName()`, `setName()`; eventos
  extra `sync:error`, `sync:unknown`; `'server:models'` se emite en cada `welcome`. Al desconectarse pone
  `store.presentation` en `connected/active/isActivePresenter: false` (el espectador queda libre hasta reconectar).
- `Presentation` filtra el estado remoto a `SYNCED_SLICES`; solo difunde cambios de slices cuya referencia cambia.
  Expone `isBroadcasting`, `isFollowing`, `isLocked` y `laser` (`getState()` para pruebas). El canvas del láser es
  `canvas.visor-laser` (z-index 40).
- Espectadores: `store.models` se reemplaza por el del presentador mientras dura la presentación; la UI y los gestores
  toleran que falte `models[id]`. La cámara se sigue con `viewer.followCamera` (no cambia el aspecto: un visor más
  estrecho recorta los lados).
- `ModelLoader`: `retryFailed({ onlyDownload })`, `getLoaded(id)`, `dispose()`. Al eliminar un modelo limpia
  `models`, `loading`, `selection`, `visibility` y `storey` del modelo. `uploadFiles` no sube con rol `viewer`.

### 12.7 UI
- Se añadieron `public/css/sidebar.css` y `public/css/hud.css`. Aislar una categoría hace un único
  `store.patch('visibility', { hiddenTypes: [todos los demás] })`; mostrar elementos desde el árbol edita
  `visibility.hidden` con `store.patch`.
- Tras `api.patchModel` / `api.deleteModel` la UI llama a `loader.reconcile` sin esperar la difusión `models`.
- `LockLayer` (data-lock-layer) cubre toda la ventana y bloquea puntero, rueda y teclado; solo los elementos con
  `data-allow-locked` (pantalla completa, Acerca de, EN VIVO, Detener / Tomar control) siguen activos. El diálogo *Acerca de* (`AboutDialog`)
  se monta en `ui.root` con `data-allow-locked` y `--z-about` (100, por encima de la capa y del grupo de estado): el espectador lo abre y lo cierra
  como la pantalla completa y, al cerrarse, la capa sigue bloqueando todo lo demás. No se registra en `ui.modals` (LockLayer los cierra al bloquear).
- Panel *Conexión*: nombre del equipo y, si el servidor exige PIN, campo "PIN de presentador" (comprueba el PIN con
  `GET /api/info`, y si el rol pasa a `presenter` recarga la página). La comprobación es `enterWithPin(ui, pin)` (`ui/Panels.js`).
  Con la capa de bloqueo la barra lateral queda inerte y el panel es inalcanzable, así que `StatusCluster` incluye
  `.pin-lock` (botón *Soy el presentador* + campo `.pin-lock__input` + OK, todo `data-allow-locked`), visible solo si
  `info.presenterPinEnabled`, el rol es `viewer` y `ui.isLocked()`; usa el mismo `enterWithPin`.
- `store.views.items` no guarda la fecha de creación.

### 12.8 Pruebas
- `npm test` ejecuta en serie `acerca`, `app`, `cad`, `correcciones`, `correcciones2`, `ifc`, `presentation`, `server`, `sync`, `ui` y `viewer`. Las pruebas de
  módulo usan dobles de los demás módulos; `app` y `presentation` usan el servidor real y todos los módulos reales.
- `app.test.mjs` verifica numéricamente la georreferencia: cajas de los dos IFC (≤ 2 cm), huella de la capa MUROS del DXF
  contra los muros IFC y contra las esquinas de `fixtures.json` (≤ 2 cm), y cota automática del DXF = nivel más bajo + 0,02 m.
- `presentation.test.mjs` abre un presentador, un espectador `?role=viewer` y un espectador real por la IP de red.
- `correcciones.test.mjs` (servidor y módulos reales) cubre las regresiones de la ronda 1: georreferencia de IfcSite, IfcSpace en el
  dock, persistencia de vistas (recarga, reinicio del servidor, espectador) y vistas estándar. `server.test.mjs` valida
  `GET/PUT /api/views` y `cad.test.mjs` el DWG con coordenadas UTM.

### 12.9 Correcciones de la ronda 1 de verificación
- **Georreferencia por IfcSite** (`source: 'site'`): la conversión equivalente vale 0, 0, 0 (las coordenadas del archivo ya son de
  mapa), así que la tarjeta *Ubicación* y el diálogo *Georreferencia detectada* muestran el punto de referencia (`anchor`) mediante
  `georefPosition(info)` (`ui/format.js`). En ese caso el diálogo explica que E, N y H manuales son un **desplazamiento** sobre
  las coordenadas del archivo (0, 0, 0 = sin mover). `IfcManager.getGeorefInfo` no cambia.
- **IfcSpace en el dock**: la fila *Espacios*, el contador de elementos/categorías y la ficha *OCULTOS* cuentan los espacios como
  ocultos mientras `display.showSpaces` sea false. El ojo de Espacios gobierna a la vez `visibility.hiddenTypes` y `display.showSpaces`
  (queda en sintonía con el interruptor de Ajustes); aislar Espacios enciende `showSpaces` mientras dure el aislamiento; *Mostrar todo*
  del dock y de la ficha OCULTOS también muestra los espacios (`actions.showAll` y Mayús+H no los tocan).
- **Vistas guardadas persistentes**: `GET/PUT /api/views` + `ViewsPersistence` (arriba). Sobreviven a recargar la página, a abrir la
  app desde otro navegador y a reiniciar el servidor. Los espectadores las cargan pero nunca las guardan (el servidor responde 403).
- **Vistas estándar** en la UI (ver sección 11).
- **Primer render tras cargar un modelo**: la miniatura del selector de niveles (`renderTopView`) se genera después de que el visor
  dibuje un fotograma (`StoreyPicker._afterMainFrame`), de modo que el modelo aparece antes. El bloqueo de ~1 s del primer dibujo
  es compilación/JIT de shaders de SwiftShader en puntos de sincronización de la GPU (`getExtension`, `getProgramInfoLog`,
  `readPixels`), no un defecto del código: `renderer.compileAsync` no lo reduce con WebGL por software. Pendiente de medir con GPU real.
- **DWG georreferenciado**: no existe ningún DWG real con coordenadas UTM en el repositorio (libredwg-web no escribe DWG), por lo que
  la ruta DWG se prueba desplazando las entidades de la base de datos que devuelve el libredwg real (`cad.test.mjs`).

### 12.10 Correcciones de la ronda 2 de verificación
- **PIN con la pantalla bloqueada** (menor): con `PRESENTER_PIN` y `VIEWER_FREE_NAV=false` la capa de bloqueo cubría el icono
  *Conexión*, así que una PC remota no podía escribir el PIN desde la interfaz. Ahora el grupo superior de estado ofrece
  *Soy el presentador* (`.pin-lock`, ver 12.7) mientras haya bloqueo. Prueba: `correcciones2.test.mjs` (puntero real, PIN erróneo y
  correcto, presentación en curso + *Tomar control*, sin PIN no hay campo, el resto sigue bloqueado).
- **Contadores del dock con modelos ocultos** (menor): "N visibles" y las categorías ignoraban los modelos ocultos con el ojo. Ahora
  `ui.visibilitySummary()` (sección 11) los cuenta como ocultos, igual que la ficha OCULTOS de Inicio; `actions.showAll` (dock,
  ficha, tarjeta de selección y Mayús+H) también devuelve los modelos ocultos para que el contador vuelva a cero.
  `ifc.getModelSummary(id).types` aporta el desglose por categoría de cada modelo.
- **DNS rebinding** (menor, seguridad): la guarda `Origin == Host` no bastaba porque `Host` nunca se validaba. Ahora el servidor
  rechaza (403, HTTP y WebSocket) los `Host` que no sean IP, `localhost`, el nombre de la PC o `ALLOWED_HOSTS` (sección 4).
  Pruebas: `server.test.mjs` (cabeceras manipuladas, WebSocket, comodines) y `correcciones2.test.mjs` (Chromium con una regla DNS
  `evil.test -> 127.0.0.1` y `--disable-web-security` para saltarse la defensa propia de Chromium).
- **DWG georreferenciado real** (limitación de la verificación, sin cambios de código): sigue sin existir en el repositorio un DWG
  con coordenadas UTM y libredwg-web no escribe DWG; la ruta DWG georreferenciada solo se prueba de forma indirecta (`cad.test.mjs`
  desplaza las entidades que devuelve el libredwg real; los `example_*.dwg` reales dan las mismas extensiones que el DXF equivalente).
  Pendiente de confirmar con un DWG exportado de AutoCAD con coordenadas UTM en la PC de destino.

### 12.11 Correcciones de la ronda 3 de verificación
- **DWG con varios registros `*Model_Space`** (menor, robustez): un DWG mal formado puede traer en `BLOCK_RECORD` más de un registro de
  espacio modelo (uno con las entidades y otro vacío). `normalizeDwg` se quedaba con el último y el plano fallaba con "El dibujo no
  contiene geometría visible en el espacio modelo" aunque las entidades existían. Ahora une las entidades de todos los registros (sin
  repetir las que comparten `handle`), cae a `db.entities` (las que no son de papel) si todos están vacíos y, ante bloques con el mismo
  nombre, conserva el que tiene más geometría. Pruebas (`cad.test.mjs`): fixture real `tests/fixtures/dwg_modelspace_duplicado.dwg`
  (generado con LibreDWG, registro vacío después del completo, comparado con el DXF al milímetro) y variantes sobre `example_2000.dwg`
  (registro vacío antes/después, entidades repartidas, mismas entidades repetidas, todos vacíos).
- **DWG georreferenciado real** (cierra la limitación de 12.10): se añadieron `tests/fixtures/planta_georef_m.dwg` y
  `planta_georef_mm.dwg`, DWG R2000 con coordenadas UTM generados con LibreDWG a partir de `planta_georef.dxf` (INSUNITS 6 y 4).
  `cad.test.mjs` comprueba unidades por INSUNITS, ancla georreferenciada y capa MUROS idéntica al DXF (≤ 1 mm). Sigue pendiente
  confirmar con un DWG exportado de AutoCAD en la PC de destino.
- **Prueba de presentación sensible al tiempo** (menor): `presentation.test.mjs` fallaba de forma intermitente con la CPU saturada
  ("Tiempo agotado esperando espectador-loopback cámara"). Causa raíz: la prueba tomaba la "foto" de la cámara del presentador con
  `waitIdle` (contador de dibujos quieto durante 600 ms), pero con WebGL por software y la CPU cargada un fotograma tarda más que eso,
  así que la foto se tomaba con el amortiguado a medias y los espectadores (que sí llegan a la cámara final) nunca igualaban esa foto
  vieja. El producto replicaba bien (diferencia final 0). Arreglo: `Viewer.isCameraMoving()` y el ayudante `waitCameraSettled`
  (`helpers.mjs`), que espera a que la cámara se asiente de verdad (y lanza si no lo hace); `waitIdle` también espera a la cámara; los
  topes de espera de seguimiento subieron a 40 s (`waitFor` sale en cuanto se cumple). Otras comparaciones del mismo tipo (nivel y
  elementos ocultos del presentador, que el visor aplica en el siguiente `requestAnimationFrame`) ahora esperan a converger.
  Se comprobó con 6 procesos al 100 % de CPU en 4 núcleos.
- **Seguimiento de cámara independiente de la tasa de fotogramas**: `Viewer._tick` limitaba el `dt` a 0,1 s también para el
  seguimiento, así que con fotogramas lentos cada fotograma solo avanzaba ~76 % del camino y el espectador tardaba muchos fotogramas
  en alcanzar al presentador. Ahora el seguimiento usa el tiempo real entre fotogramas con tope de 0,5 s (`FOLLOW_MAX_DT`); los
  controles siguen con 0,1 s. Prueba: `viewer.test.mjs` bloquea el hilo 650 ms y exige llegar a < 5 cm de la meta en un fotograma.
- **Primer dibujo tras cargar un modelo (~1,5-2,3 s con WebGL por software)**: sin cambios. Es un coste fijo de compilación de
  shaders de SwiftShader (ya descrito en 12.9, `compileAsync` no lo reduce) y no se puede medir sin una GPU real. Pendiente de medir en la PC de destino.
