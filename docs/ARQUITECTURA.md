# Visor IFC 5D — Arquitectura (Fase 1)

Este documento es el **contrato** entre módulos. Cada módulo se implementa en
paralelo; si un módulo necesita algo de otro, se usa exactamente la API descrita
aquí. Archivos ya escritos y que NO deben cambiar su API:
`public/js/core/events.js`, `public/js/core/store.js`, `public/js/core/actions.js`,
`public/js/main.js` (orden de arranque).

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
server/                 Servidor Node (Express + ws)
  index.js              arranque, estáticos, /vendor, API REST, WebSocket
public/
  index.html            shell de la app + import map
  css/                  tokens.css, layout.css, components.css
  js/
    main.js             arranque (ya escrito)
    core/               events.js, store.js, actions.js (ya escritos), api.js, ModelLoader.js
    viewer/             Viewer.js, WorldOrigin.js, SectionBox.js, MeasureTool.js
    ifc/                IfcManager.js, IfcModel.js, ifc.worker.js, ...
    cad/                CadManager.js, CadModel.js, cad.worker.js, ...
    sync/               SyncClient.js, Presentation.js
    ui/                 App.js (mountUI) y componentes
data/                   (gitignored) uploads/ y session.json
tests/
  fixtures/             IFC/DXF georreferenciados de prueba + downloads/ (muestras reales)
  e2e/                  pruebas Playwright (*.test.mjs)
  run-all.mjs           ejecuta todas las pruebas
```

## 4. Servidor (`server/index.js`)

- `npm start` → `node server/index.js`. Variables de entorno:
  `PORT` (8080), `HOST` (0.0.0.0), `PRESENTER_PIN` (opcional),
  `VIEWER_FREE_NAV` (`true` por defecto: los espectadores pueden navegar
  libremente cuando NO hay presentación activa), `MAX_UPLOAD_MB` (2048),
  `DATA_DIR` (`./data`).
- Al arrancar imprime las URL locales y de red (os.networkInterfaces, IPv4 no internas).
- Estáticos: `public/` en `/`. Montajes `/vendor/*`:
  `three` → `node_modules/three/`, `web-ifc` → `node_modules/web-ifc/`,
  `three-mesh-bvh` → `node_modules/three-mesh-bvh/`,
  `camera-controls` → `node_modules/camera-controls/`,
  `dxf-parser` → `node_modules/dxf-parser/dist/`,
  `libredwg-web` → `node_modules/@mlightcad/libredwg-web/`,
  `fonts/urbanist` → `node_modules/@fontsource/urbanist/`.
  `.wasm` con `Content-Type: application/wasm`.
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
  - Persistencia en `DATA_DIR/session.json` y archivos en `DATA_DIR/uploads/<id>.<ext>`.
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
`createActions(store)` → `select, clearSelection, hideSelected, isolateSelected, showAll,
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
api.fileUrl(id) → string
api.setPin(pin) / api.getPin()    // sessionStorage 'visor.pin'; se envía como X-Presenter-Pin
```

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

### WorldOrigin.js
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
  la cámara con `viewer.followCamera(cam)` (si la proyección difiere, cambiarla), dibuja el puntero
  láser (punto rojo con estela sobre el visor; corrige x por la relación de aspecto:
  `x' = x · aspectPresentador / aspectLocal`) y bloquea toda interacción: `viewer.enableInput(false)` y
  la UI muestra una capa de bloqueo (lo hace la UI observando `store.presentation`).
- Sin presentación activa: si `viewerFreeNav` el espectador navega libremente (no puede subir/borrar
  modelos); si no, sigue bloqueado con el mensaje "Esperando al presentador".

## 10. UI (`public/index.html`, `public/css/`, `public/js/ui/`)

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
  3D/planta (proyección), medir, sección, aristas, captura de pantalla, ajustes de selección
  (modo fantasma/aislar/resaltar + opacidad).
- **Derecha**: zoom + / −.
- **Abajo izquierda**: cruceta de órbita (↑ ↓ ← →).
- **Abajo centro**: selector de nivel (▲ 02 ▼ + nombre + miniatura en planta + modo corte/solo).
- **Tarjeta oscura de selección**: nombre, tipo, nivel, GlobalId corto, botón → propiedades;
  acciones ocultar / aislar / mostrar todo.
- **Dock inferior** (vidrio marrón→naranja, plegable): "Resumen del modelo" y "Categorías"
  (tipo, cantidad, ojo, clic = aislar categoría).
- **Presentación**: botón "Presentar" (presentador) con contador de espectadores, URL de red para
  copiar, toggle de puntero láser, "Tomar control". Para espectadores: insignia "EN VIVO · Siguiendo a
  {nombre}", capa de bloqueo que impide toda interacción (solo se permite pantalla completa).
- Toasts, diálogo de georreferencia manual (E, N, H, rotación, escala), atajos de teclado:
  Esc (limpiar selección / cancelar medición), H (ocultar selección), I (aislar), Shift+H (mostrar todo),
  F (encuadrar selección o todo), M (medir), P (presentar).
- Iconos SVG en línea propios (sin fuentes de iconos externas). Fuente Urbanist desde `/vendor/fonts/urbanist/`.
- `#fatal-error` (oculto) para errores de arranque.
