# Fase 2 — Diseño del servidor: multiproyecto y datos 5D

> Notas generadas por un agente de investigación (solo lectura) sobre el código de la fase 1.
> Son una propuesta de diseño, no código implementado. Verificar contra el código antes de aplicarlas.

## Resumen

Mapa completo del servidor de la fase 1 y diseño de menor riesgo para la fase 2. No modifiqué nada del repositorio (git status limpio; solo escribí scripts en el scratchpad). Línea base: `node tests/e2e/server.test.mjs` pasa 72/72 en este entorno, con Chromium y una IP de red 192.0.2.2, así que no se omite ninguna prueba. La recomendación central es que el proyecto "principal" siga usando las rutas heredadas (`DATA_DIR/session.json` y `DATA_DIR/uploads/`) y que la migración sea implícita, sin mover archivos. El proyecto activo es un estado global del servidor, persistido y difundido por WebSocket con mensajes nuevos aditivos. Los datos 4D/5D (presupuesto, versiones de cronograma, avance) van en archivos propios por proyecto, con rutas REST nuevas que no alteran las existentes. Los puntos que sí rompen pruebas actuales están enumerados en integrationNotes, sección 5. Los más sensibles: añadir campos a ModelRecord, añadir un slice a SYNCED_SLICES (rompe `sync.test.mjs` L346) y mover session.json/uploads.

## Notas de integración

NOTA PREVIA. El `data/` del usuario (IFC del terreno y de los bloques) y el expediente de OneDrive NO existen en este sandbox: `data/` está en .gitignore y `ls data` no devuelve nada. No pude reproducir el problema de los módulos vinculados. El servidor no parsea IFC: guarda y sirve los bytes sin tocarlos, con Range y ETag. Por tanto el fallo de visualización de los bloques es 100 % cliente (web-ifc, IfcManager o ifc.worker), no del servidor.

=====================================================================
PARTE 1. MAPA DEL SERVIDOR ACTUAL (rutas relativas a /home/user/visorifc5d)
=====================================================================

1.1 Arranque y ensamblado
- `server/index.js`: `loadConfig()` (L11), `createServer(config,{log})` (L15), `await visor.start()` (L16), banner de `net.js`. Cierre limpio en L44-61:
  - SIGINT/SIGTERM/SIGBREAK llaman a `apagar()`.
  - Un timer de 5 s fuerza `process.exit(0)`.
  - Imprime "Servidor detenido." y sale con código 0.
  - `unhandledRejection` solo se registra en log.
  - EADDRINUSE: mensaje "ya está en uso" y exit 1. EACCES/EPERM: mensaje propio y exit 1.
- `server/server.js` `createServer(config,{log})` (L26-137):
  - Crea `RoleResolver({pin})`.
  - Crea `ModelStore({uploadsDir,sessionFile,log})` y llama `models.load()` de forma síncrona antes de escuchar.
  - Crea `http.createServer()` y `PresentationHub({config,roles,models,log})`.
  - Devuelve `{app, server, hub, models, roles, config, get port, start(), stop()}`.
  - `start()` hace `server.listen(config.port, config.host)` y resuelve el puerto real (sirve PORT=0).
  - `stop()`:
    - Si no está escuchando, solo cierra el hub.
    - Si escucha, `server.close` más `hub.close()` más `closeIdleConnections`, con un timer de 2,5 s que llama `closeAllConnections`.
  - `server.requestTimeout = 0` (L80): las subidas largas no caducan.
- Orden de middleware HTTP en `server.js`:
  1. `hostPermitido` (HostGuard, anti DNS rebinding): 403 con mensaje que menciona ALLOWED_HOSTS. Aviso en log una vez por nombre de host.
  2. `X-Content-Type-Options: nosniff`.
  3. `app.use('/api', createApiRouter({config,models,roles,hub,getPort}))` (L59).
  4. `/vendor/*` con maxAge 1d (`vendorMounts` en `config.js`, `.wasm` con application/wasm).
  5. `public/` con `Cache-Control: no-cache` y ETag.
  6. 404.
  7. `manejadorErrores(log)` (`api.js`).
- Upgrade WS (`server.js` L82-98):
  - Orden de rechazos: URL inválida 400, Host no permitido 403, ruta distinta de `/ws` 404, `origenPermitido` 403.
  - Después `hub.handleUpgrade`.

1.2 Configuración (`server/config.js`, `loadConfig(env)`)
- Variables:
  - PORT (8080), HOST (0.0.0.0), PRESENTER_PIN, VIEWER_FREE_NAV (true).
  - MAX_UPLOAD_MB (2048, mínimo 0.001), DATA_DIR (./data), ALLOWED_HOSTS.
  - WS_HEARTBEAT_MS (30000, mínimo 50; solo pruebas).
- Campos derivados:
  - `uploadsDir = DATA_DIR/uploads`.
  - `sessionFile = DATA_DIR/session.json`.
  - `version` sale de package.json.
- Las pruebas pasan `DATA_DIR` por entorno.

1.3 API REST (`server/api.js`, `createApiRouter` L71). Errores: JSON `{error}` con mensajes en español.
Orden dentro del router:
1. `Cache-Control: no-store`.
2. Puerta de escritura (L81-88). Métodos no seguros (no GET/HEAD/OPTIONS):
   - `origenPermitido` (Origin debe coincidir con Host si existe): 403 'Origen no permitido'.
   - `roles.forRequest(req) !== 'presenter'`: 403 'Solo el presentador puede modificar los modelos'.
   - Esto va antes que cualquier 404 (el 403 tiene prioridad, hay prueba).
3. `/views` con parser JSON propio de 8 MB.
4. `express.json({limit:'1mb'})` (L109).
5. Rutas.
6. 404 'Ruta de la API no encontrada'.

Rutas y validaciones:
- GET `/api/info` (todos) devuelve `{role, clientIp, lanUrls, port, version, presenterPinEnabled, viewerFreeNav}`.
- GET `/api/models` (todos) devuelve `ModelRecord[]` en orden de subida.
- POST `/api/models` (presentador). Multer diskStorage, campo `file`, `limits {fileSize: maxUploadMb, files:1, fields:8, parts:12}`, `defParamCharset:'utf8'`.
  - `fileFilter`: extensión .ifc/.dxf/.dwg en cualquier mayúscula, si no 400 'Formato no admitido: solo se aceptan archivos .ifc, .dxf y .dwg'.
  - El archivo llega como `uploads/tmp-<16hex>.part`.
  - Errores: 413 con el límite en MB, 400 si falta archivo, está vacío o el campo no es 'file', 400 'Formulario multipart inválido'.
  - Éxito:
    - `newId()` (10 chars [a-z0-9]).
    - `renombrar(tmp, uploads/<id>.<kind>)`.
    - `models.add()` (escribe session.json).
    - `201` más `Location` más el ModelRecord.
    - DESPUÉS de responder, `hub.broadcastModels()`.
  - Ante cualquier error borra el tmp y el destino.
  - No se valida el contenido del archivo (un "ISO-10303-21;" mínimo se acepta).
- GET `/api/models/:id/file` (todos). 404 si el id no es válido o no existe, o si falta el archivo en disco.
  - Cabeceras: `application/octet-stream`, `Content-Disposition` (ASCII más RFC5987), ETag `"<id>-<size hex>-<mtime hex>"`, `Cache-Control: no-cache`, Range/206, 304.
- PATCH `/api/models/:id` (presentador). El cuerpo debe ser un objeto (si no, 400). Solo se toman `name`, `georef`, `cad`; el resto se ignora.
  - `name`: texto, pasa por sanitizeFileName (sin rutas ni caracteres de control, máx 200), no vacío.
  - `georef`: solo IFC.
    - eastings y northings obligatorios, finitos, |valor| ≤ 1e9.
    - height por defecto 0 (|h| ≤ 1e7), rotationDeg por defecto 0 (≤ 3600), scale por defecto 1 (0 < scale ≤ 1e6).
    - `null` borra la georreferencia.
  - `cad`: solo DXF/DWG, `{units}` con units ∈ auto, mm, cm, m, in, ft. `null` equivale a `{units:'auto'}`.
  - Todo se valida antes de mutar. Si falla el guardado en disco, se revierte en memoria. Responde el ModelRecord y difunde `models` solo si hubo claves.
- DELETE `/api/models/:id` (presentador). 204 y difunde. Quita el registro, guarda session.json y luego borra el archivo (ENOENT tolerado).
- GET `/api/views` (todos) devuelve `{items}`.
- PUT `/api/views` (presentador, cuerpo hasta 8 MB). Reemplaza la lista completa y NO la difunde por WS (las vistas llegan a los espectadores solo vía el slice `views` de la presentación o con GET al arrancar). Validación `validateViews`:
  - Máximo 60 vistas.
  - id `^[A-Za-z0-9_-]{1,64}$` y único.
  - name texto, con / y \ cambiados por '-', ≤120.
  - camera: position y target son [x,y,z] finitos; zoom y fov finitos opcionales; projection 'orthographic' o 'perspective'.
  - state: solo las claves visibility, display, storey, section, selection, models, cad, cada una objeto; ≤ 300 000 caracteres de JSON.
  - thumb: null o `data:image/(jpeg|png|webp);base64,...` de ≤ 200 000 caracteres.
  - Se descartan los campos desconocidos.
- Manejador de errores (`manejadorErrores`):
  - `entity.parse.failed` es 400 'JSON inválido en el cuerpo de la petición'.
  - `entity.too.large` es 413.
  - Errores 5xx se registran y se devuelven como 'Error interno del servidor'.
  - Otros 4xx de Express/send se traducen a MENSAJES_ESTADO.
- Express es 5.3.0. `req.body` es `undefined` si no hubo parser: usar `?? null`. Los comodines deben ir nombrados (`/*splat`).

1.4 Almacenamiento (`server/models.js`, clase `ModelStore`)
- Archivos:
  - `DATA_DIR/uploads/<id>.<ext>`.
  - `DATA_DIR/session.json` = `{version:1, savedAt, models:[ModelRecord], views:[View]}`.
- `ModelRecord` tiene EXACTAMENTE 7 claves, en este orden: `id, name, kind, size, uploadedAt, georef, cad` (función `clonar`, L406). Una prueba hace deepEqual de `Object.keys`.
- `_guardar()` (L386) es escritura atómica:
  - Escribe `session.json.<pid>.tmp`, fsync y `renombrar()`.
  - `renombrar` reintenta 4 veces ante EPERM/EBUSY/EACCES (Windows/OneDrive/antivirus) con `Atomics.wait`.
  - Si falla, borra el tmp y revierte el estado en memoria.
  - Cada add/update/remove/setViews reescribe TODO el archivo (incluidas las miniaturas de vistas, hasta unos 12 MB).
- `load()` (L198):
  - Crea uploads y borra los `tmp-*.part` huérfanos.
  - Si session.json no existe, empieza vacío.
  - Si es ilegible (no ENOENT), lo renombra a `session.json.corrupto-<ts>`, avisa 'Aviso: session.json ilegible...' y empieza vacío.
  - `_normalizar` descarta registros con id/kind inválido o sin archivo y avisa '...ignoraron...'. Recalcula size desde stat. Revalida georef y cad.
  - Vistas inválidas: se ignoran todas, con aviso 'las vistas guardadas de session.json se ignoraron', y se conservan los modelos.
  - Los archivos huérfanos de uploads sin registro nunca se limpian.
- `newId()` solo comprueba unicidad en su propio Map. `filePath(id,kind)` lanza ValidationError 404 con ids o kinds inválidos (anti path traversal).
- Exports reutilizables: `ID_RE, KINDS, CAD_UNITS, ValidationError, renombrar, isValidId, kindFromName, sanitizeFileName, validateGeoref, validateCad, validateName, MAX_VIEWS, validateViews`.

1.5 Roles (`server/roles.js`)
- `RoleResolver.resolve(remoteAddress, pin)`: loopback es presenter. Si no, presenter solo si `PRESENTER_PIN` está definido y el PIN coincide (comparación en tiempo constante con sha256 más `timingSafeEqual`). Si no, viewer.
- Límite de 30 PIN erróneos por IP y por 60 s; pasado el límite se ignoran incluso los PIN correctos de esa IP.
- El rol se decide con `req.socket.remoteAddress`. NUNCA se usa X-Forwarded-For.
- HTTP: cabecera `X-Presenter-Pin`. WS: `hello.pin` (tiene prioridad) o la cabecera `X-Presenter-Pin` de la mejora.

1.6 Hub WebSocket (`server/hub.js`, `PresentationHub`), ruta `/ws`
- Constantes:
  - MAX_PAYLOAD 32 MB (si se supera, ws cierra con 1009).
  - HELLO_TIMEOUT 10 s (cierra con 4001 y termina a 1 s).
  - Nombre de cliente ≤ 40.
  - SLICE_RE `^[A-Za-z][A-Za-z0-9_]{0,63}$`, MAX_SLICES 64 por mensaje.
  - BUFFER_EFIMERO_MAX 1 MB.
  - Latido ping/pong cada `config.heartbeatMs` (30 s): una conexión sin pong en el ciclo siguiente se termina.
- Estado: `clients` (Map id a conexión, solo tras hello), `_conexiones` (todas), `presentation {active, presenterId, presenterName}`, `lastState` (objeto por slice), `lastCamera`.
- Cliente a servidor (JSON de texto con campo `t`):
  - `ping` (válido antes de hello).
  - `hello {name, wantRole?:'viewer', pin?}`. El PRIMER hello decide el rol y el id (6 bytes hex) y responde welcome. Un hello posterior solo renombra o degrada a viewer (nunca asciende; degradar al presentador activo termina la presentación).
  - `presentation {active:boolean}` (presenter).
  - `take-control` (presenter, requiere presentación activa).
  - `state {slices, full?}`, `camera {cam}`, `pointer {p}`: solo el presentador ACTIVO.
  - Cualquier otro tipo recibe `error 'Mensaje desconocido: "..."'`. Hay pruebas que lo exigen. También dan error: mensajes binarios, JSON inválido, falta de `t`, y cualquier mensaje distinto de ping antes de hello.
- Servidor a cliente:
  - `welcome {clientId, role, presentation, state, camera, models, clients:{viewers,list:[{id,name,role}]}, viewerFreeNav}`. state y camera solo vienen con presentación activa.
  - `presentation {active, presenterId, presenterName}`.
  - `state {slices, full}`.
  - `camera {cam}` y `pointer {p}` (efímeros: se omiten para clientes con `bufferedAmount` > 1 MB).
  - `models {models}`, `clients {viewers, list}`, `error {message}`, `pong`.
- Reglas de estado:
  - `state` fusiona por slice en `lastState`; `full:true` lo reemplaza entero.
  - Iniciar y terminar la presentación limpia `lastState` y `lastCamera`.
  - `take-control` conserva ambos.
  - Si el presentador activo se desconecta, termina la presentación.
  - `viewers` = conectados menos el presentador activo.

1.7 Cómo se difunden los cambios
- `_difundir(obj, exceptoId, {efimero})` (L309) envía a TODOS los clientes registrados, sin filtro por rol ni por proyecto.
- Las rutas REST responden primero y llaman después `hub.broadcastModels()` (L293), que emite `{t:'models', models: models.list()}`. Solo POST/PATCH/DELETE de modelos difunden; las subidas rechazadas no difunden (hay prueba con `noRecibe('models')`).
- Las vistas NO se difunden.
- El estado de presentación se retransmite con `exceptoId` = presentador.
- Cliente: `SyncClient._procesar` (`public/js/sync/SyncClient.js` L289-314) hace switch sobre `t`:
  - `models` emite bus 'server:models' (array de ModelRecord).
  - Los tipos desconocidos emiten 'sync:unknown' (así los clientes viejos toleran mensajes nuevos).
  - `welcome` emite 'server:models' con `msg.models`.
- Reconexión con backoff 0,5 a 5 s; ping propio cada 20 s; se considera zombi tras 50 s sin mensajes.

1.8 Cliente que habla con el servidor
- `public/js/core/api.js` `ApiClient`: `getInfo, listModels, patchModel, deleteModel, getViews, putViews, uploadModel` (XHR con progreso), `downloadModel` (fetch en streaming), `fileUrl`, `getPin/setPin` (sessionStorage 'visor.pin' enviado como `X-Presenter-Pin`). `_json(method,url,body)` devuelve null con 204. Errores: `ApiError(message,status,cause)`; mensajes del servidor, o de respaldo por código; error de red con status 0.
- `public/js/core/ModelLoader.js`:
  - `start()` escucha 'server:models' y 'sync:status', y hace un listModels inicial. Descarta ese listado si ya llegó un push (`_pushes`).
  - `reconcile(records)`:
    - Guarda `store.modelRecords`.
    - Descarga los modelos eliminados con `_removeModel`/`_forgetModelState` (limpia models, loading, selection, visibility, storey, hover).
    - Aplica cambios de georef (`ifc.updateGeoref`) y de unidades CAD (recarga).
    - Encola los nuevos con carga secuencial: descarga, `ifc.load` o `cad.load`, bus 'model:loaded'.
  - `recordSignature = kind#size#uploadedAt#georef#units`, usada para no reintentar fallos.
  - `uploadFiles` encadena subidas en serie y se niega si el rol es viewer.
  - Consecuencia: reconcile con la lista de OTRO proyecto descarga los modelos viejos y carga los nuevos sin tocar ModelLoader. No limpia `store.cad[id]`, `section`, `measure` ni `views`; eso debe hacerlo un módulo nuevo.
- `public/js/core/ViewsPersistence.js`: `start()` hace GET views y las fusiona. Solo el presentador hace PUT /api/views (agrupado 500 ms, sin guardados simultáneos); `flush()`; los cambios con source 'remote' o 'system' no se reenvían.
- `public/js/main.js`: instancia `api`, `Viewer`, `IfcManager`, `CadManager`, `ModelLoader`, `SyncClient`, `Presentation`, `ViewsPersistence`, expone `window.__visor = ctx` y `document.documentElement.dataset.ready='true'`.
- `public/js/core/store.js`: `SYNCED_SLICES = models, selection, visibility, display, storey, section, cad, ui, measure, views`. Slices locales: `modelRecords`, `presentation`, `hover`, `loading`.
- `public/js/sync/Presentation.js`: difunde con `store.snapshot()` (todos los SYNCED_SLICES, full:true) al empezar, y luego los slices que cambian (agrupados 30 ms). Los cambios con source 'system' también se difunden; solo 'remote' se filtra.

1.9 Pruebas y cómo se arranca el servidor
- Las pruebas NO usan `createServer` en proceso. `tests/e2e/helpers.mjs` `startServer({port,env})` lanza `node server/index.js` como proceso hijo con PORT, HOST=0.0.0.0 y `DATA_DIR=mkdtemp`, y espera a `GET /api/info` ok (15 s). `server.test.mjs` usa su propio `conServidor` (puerto 8101 fijo, DATA_DIR propio, SIGTERM y espera del puerto libre).
- Verifiqué en un script de scratchpad que `createServer(loadConfig({DATA_DIR,PORT:'0',HOST:'127.0.0.1'}), {log})` más `await visor.start()` funciona en proceso. Devuelve el puerto real y `visor.stop()` cierra bien. Sirve para pruebas unitarias nuevas.
- Puertos usados: server 8101, viewer 8102, ifc 8103, cad 8104, sync 8105, ui 8106, presentation 8210 (+1), app 8220 (+1,+2), correcciones2 8230 (+3), acerca 8440; correcciones usa aleatorios 9100-9499; startServer por defecto usa 9000-9899. Libres: 8107, 8108.
- `tests/run-all.mjs` ejecuta en serie cada `tests/e2e/*.test.mjs` (sort alfabético, 10 min por archivo). Un archivo nuevo se incluye solo.
- Los ayudantes de `server.test.mjs` (prueba, grupo, conServidor, ClienteWs, conectarWs, subir, patch) son locales al archivo, no exportados. Para una prueba nueva hay que duplicarlos o moverlos a helpers.mjs (solo añadiendo exports).

=====================================================================
PARTE 2. DISEÑO MULTI-PROYECTO (menor riesgo)
=====================================================================

2.1 Principios
- Compatibilidad total: todas las rutas y mensajes WS actuales siguen igual y operan sobre el proyecto ACTIVO. Lo nuevo es aditivo.
- ModelRecord NO cambia (7 claves). La pertenencia a un proyecto es implícita (un ModelStore por proyecto).
- El proyecto "principal" usa las rutas heredadas. La migración es implícita: si no existe `DATA_DIR/projects.json`, el registro es `[principal]`, activo, sin escribir nada. Así los usuarios actuales no cambian y es trivial revertir.

2.2 Layout en disco
- `DATA_DIR/session.json` y `DATA_DIR/uploads/`: proyecto `principal` (heredado, intacto).
- `DATA_DIR/projects.json` (se crea al crear el primer proyecto extra o cambiar de activo): `{version:1, activeId, projects:[{id,name,description,createdAt}]}`, escritura atómica.
- `DATA_DIR/projects/<id>/session.json` y `uploads/`: proyectos extra.
- `DATA_DIR/projects/<id>/` (para TODOS los proyectos, también `principal`) guarda los datos 4D/5D: `budget.json`, `schedules.json` (índice), `schedules/<sid>.xml`, `schedules/<sid>.json`, `progress.jsonl`, `links.json`.
- Ids de proyecto: `PROJECT_ID_RE=/^[a-z0-9]{3,16}$/`. El principal es `principal`; los nuevos usan el generador de 10 chars. El nombre visible nunca se usa en rutas.
- Máximo 50 proyectos. El nombre pasa por `validateName` y se recorta a 80. 'principal' no se puede borrar (409).

2.3 Proyecto activo compartido
- Estado global del servidor, persistido en `projects.json.activeId`. Todos los clientes (presentador y espectadores) ven el mismo proyecto, de modo que en presentación queda compartido por construcción.
- Cambio: `PUT /api/projects/active {id}` (presentador). Debe declararse ANTES de `/projects/:pid`.
- Qué hace el servidor al cambiar, en este orden:
  1. Persiste.
  2. Responde.
  3. `hub.broadcastProject()` emite `{t:'project', activeId, project:{id,name}, projects:[{id,name}]}`.
  4. `hub.broadcastModels()` emite `{t:'models', models: <lista del nuevo activo>}`.
  5. Si había presentación activa: `lastState={}` y `lastCamera=null`, sin terminarla.
- `ModelLoader.reconcile` cambia los modelos solo con ese `models`. El presentador activo debe reenviar `sendState(snapshot, true)` al terminar de cargar. Eso es un listener nuevo (en un módulo nuevo tipo `ProjectSession`, no en ModelLoader) sobre 'server:project'.
- `welcome` añade `activeProjectId` y `projects`. `GET /api/info` añade `activeProjectId`. Son campos de primer nivel: seguros para las pruebas.
- Alternativa más cara, NO recomendada ahora: proyecto por cliente (hello con projectId, filtro de `broadcastModels` por conexión, seguimiento forzado al presentador). Toca el hub a fondo.

2.4 REST nuevo y refactor mínimo de `api.js`
- `GET /api/projects` devuelve `{activeId, items:[{id,name,description,createdAt}]}` (`?counts=1` opcional).
- `POST /api/projects {name,description?}` devuelve 201.
- `PATCH /api/projects/:pid` renombra.
- `DELETE /api/projects/:pid`: 204. Si era el activo, pasa a principal y difunde. Hace `fs.rmSync` del directorio del proyecto.
- Refactor de `createApiRouter`:
  - Un middleware `resolveActive` que pone `req.project = projects.active()` AL INICIO de la petición. Nunca re-resolver al terminar una subida larga.
  - Un sub-router `scoped = express.Router({mergeParams:true})` con las rutas de modelos, vistas y datos 4D, montado dos veces:
    - `router.use('/projects/:pid', validarPid, scoped)`.
    - `router.use(resolveActive, scoped)` como alias heredado.
  - Validé este patrón con Express 5.3.0: el alias heredado y el explícito funcionan, un pid inválido da 404 limpio, los parsers JSON internos se respetan y lo desconocido cae al 404 final.
- Cambios en los 8 handlers existentes: `models.` pasa a `req.project.models.`, y multer `destination: (req)=>req.project.uploadsDir` y `filename: req.project.models.tmpPath()`.
- `hub.broadcastModels(project)` solo emite si `project.id===activeId`.
- Las descargas (`GET /models/:id/file`) y PATCH/DELETE heredados conviene resolverlos con `projects.locateModel(id)` en TODOS los proyectos, para no dar 404 transitorios durante un cambio. Para eso `ModelStore.newId()` debe recibir un `isTaken` global (cambio mínimo y opcional).
- Cabecera opcional `X-Project-Id` en peticiones de escritura: si llega y no es el activo, 409. Evita que un PUT /views o POST /models caiga en el proyecto equivocado durante un cambio. El ApiClient puede enviarla.
- Generalizar el mensaje 403 a 'Solo el presentador puede modificar los datos'. Las pruebas solo buscan la subcadena 'presentador'.

2.5 Archivos
- NUEVOS:
  - `server/storage.js`: `writeJsonAtomic`, `readJsonQuarantine` (copia a `.corrupto-<ts>`), `appendJsonLine`. Reutiliza `renombrar` importándola de `models.js`; no hace falta tocar models.js.
  - `server/projects.js`: `ProjectRegistry`. Carga eagerly `principal` (conserva los logs de arranque que verifican las pruebas) y el resto de forma perezosa. API: `list, get, active, create, update, remove, setActive, locateModel, paths`.
  - Rutas en un archivo propio (por ejemplo `server/routes4d.js`), importado desde `api.js`.
- TOCAR:
  - `server/server.js`: sustituir `new ModelStore` por el registro. El hub recibe una fachada `models` con `list()` del activo. Mantener `visor.models` como getter del activo.
  - `server/api.js`: lo anterior.
  - `server/hub.js`: `welcome` (L143), `broadcastProject()`, `broadcastData()`, reset de lastState.
  - `server/config.js`: `projectsFile`, `projectsDir`, `maxImportMb` (env `MAX_IMPORT_MB`, 64).
  - `server/models.js`: solo el hook `isTaken`.
  - `server/index.js` (comentario de variables) y README.md/docs/ARQUITECTURA.md.
  - Cliente:
    - `public/js/core/api.js`: métodos nuevos, SIN cambiar los existentes. Dejar `getViews/putViews` en `/api/views`.
    - `public/js/sync/SyncClient.js`: casos 'project' y 'data' antes del `default`. Emiten 'server:project' y 'server:data'. No cambiar el payload de 'server:models'.
    - `public/js/core/ViewsPersistence.js`: `reload()` más `flush()` antes de cambiar de proyecto (si no, ediciones pendientes se guardarían en el proyecto nuevo).
    - `public/js/core/store.js` y `main.js`: cambios solo aditivos. La doc declara estos archivos como "no cambiar API".

=====================================================================
PARTE 3. PARTIDAS, CRONOGRAMAS Y AVANCE
=====================================================================

3.1 Principios
- Datos fuera de session.json (que se reescribe entero y lleva miniaturas). Un archivo por colección, escritura atómica con `storage.js`.
- El vínculo cronograma-partida es por CÓDIGO DE PARTIDA, no por id de tarea: al subir un cronograma nuevo se recalcula.
- El vínculo elemento-partida vive en el IFC (parámetro compartido de Revit, por ejemplo COD_PARTIDA). El servidor guarda solo `GlobalId` (22 chars `[0-9A-Za-z_$]`).
- Rutas siempre bajo `/api/projects/:pid/...`; los alias sin pid existen por el montaje doble.
- Lectura para todos los roles; escritura con la puerta de presentador existente.
- Cada colección tiene `rev` entero incremental (ETag).
- Tras escribir: responder y luego `hub.broadcastData(projectId, kind, {rev, items?})` con `{t:'data', projectId, kind:'budget'|'schedules'|'progress'|'links', rev}`. Incluir `items` solo si son ≤ 100; si no, el cliente vuelve a pedir.

3.2 Presupuesto (S10), `budget.json`
- Partida: `{code, name, unit, qty, unitPrice, total, type:'title'|'item', parent, order}`.
  - code: `^[0-9A-Za-z][0-9A-Za-z._\-/ ]{0,39}$`, único, sensible a mayúsculas.
  - parent: el código del título padre, derivado del punto final si no viene.
  - name ≤ 300, unit ≤ 16, qty y unitPrice finitos ≥ 0 (≤ 1e12).
  - total = round(qty·unitPrice, 2) para partidas y Σ hijos para títulos.
- Objeto: `{rev, currency:'PEN', source:{fileName,importedAt,sha256,size}, items}`. Máximo 100 000 partidas.
- Rutas:
  - `GET /budget`.
  - `PUT /budget` (JSON ≤ 32 MB, con parser propio ANTES del `express.json` de 1 MB, como /views).
  - `POST /budget/import` (multipart `file` más `mode=replace|merge`, `dryRun=1` para vista previa). Devuelve `{rev, counts, warnings:[{row,message}]}`.
- Importador `server/import/s10.js`: acepta .csv (UTF-8 o Windows-1252; delimitador `;`, `,` o tab; decimal coma o punto), .xlsx y .json canónico.
  - Mapea cabeceras por sinónimos: Item, Código, Partida; Descripción; Und, Unidad; Metrado, Cantidad; Precio, P.U.; Parcial, Total.
  - Fila sin unidad ni metrado = título.
  - No hay lector de XML/zip/xlsx en node_modules.

3.3 Versiones de cronograma (MS Project XML)
- Meta: `{id, name, fileName, size, uploadedAt, projectName, dataDate, start, finish, taskCount, codeSource:{used, matched, total}, stats:{unmatchedTasks, partidasWithoutTask}}`.
- Índice `schedules.json` = `{version:1, rev, currentId, baselineId, items:[meta]}`. Máximo 50 versiones. Archivos: `schedules/<sid>.xml` (original inmutable) y `schedules/<sid>.json` (tareas normalizadas).
- Rutas:
  - `GET /schedules`.
  - `POST /schedules` (multipart `file` .xml más `name`, `codeSource`, `codeRegex`; `makeCurrent`). Parsea y valida antes de guardar.
  - `GET /schedules/:sid` (`{...meta, tasks, byCode}`).
  - `GET /schedules/:sid/file` (descarga el XML con `contentDisposition`).
  - `PATCH /schedules/:sid` (name).
  - `PUT /schedules/current {id}` (declararlo antes de `/:sid`) y `PUT /schedules/baseline`.
  - `DELETE /schedules/:sid`.
- Tarea normalizada: `{uid, id, wbs, outline, level, name, summary, milestone, start, finish, durationDays, percentComplete, baselineStart?, baselineFinish?, predecessors:[{uid,type,lag}], code}`.
  - Fechas MSPDI sin zona horaria: guardarlas como cadenas locales, sin convertir.
  - Duración ISO `PT80H0M0S` convertida con `MinutesPerDay` (por defecto 480).
  - La tarea UID 0 (resumen del proyecto) se omite.
  - `byCode[code] = {start, finish, taskUids, percentComplete}`: varias tareas pueden compartir un código.
- Resolución del código con `codeSource` = 'auto' | 'wbs' | 'name' | 'text:<n|alias>' | 'outline'. En 'auto' prueba, por este orden de desempate:
  1. Campo extendido cuyo Alias coincide con partida/código/item (los `ExtendedAttribute` referencian `FieldID` y los alias salen de `ExtendedAttributes` del proyecto).
  2. WBS.
  3. Prefijo del nombre (regex por defecto `^\s*([0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)`).
  4. Outline.
  Elige el de mayor coincidencia con los códigos del presupuesto y lo informa en `codeSource`.
- Parser: sin dependencias en el repo hay dos caminos.
  - (a) Dependencias con versión exacta: `fast-xml-parser` (5.11.2, el registro npm responde desde este sandbox) y, si se quiere .xlsx, `fflate` 0.8.3. Configurar límites de expansión de entidades.
  - (b) Un tokenizador XML propio en `server/import/xml.js` (sirve para MSPDI y xlsx). Cero dependencias, pero más código que probar (BOM, CDATA, entidades, namespace por defecto `http://schemas.microsoft.com/project`).
  - Recomendación: (a) para el XML y CSV más .json canónico en la v1 de presupuesto, dejando .xlsx para después.
- Import con parser propio de multer en memoria: `limits.fileSize = maxImportMb` (64 MB). Registrar su propio filtro y mensajes (no reutilizar el de .ifc/.dxf/.dwg). No usar `uploads/` para temporales: una prueba exige que quede vacío tras un 413.

3.4 Avance por elemento, `progress.jsonl` (solo anexar)
- Registro: `{id, globalId, code, date:'YYYY-MM-DD', pct:0..100, qty?, author?, note?, at, batchId}`.
  - `author` ≤ 40, `note` ≤ 200, `qty` ≥ 0 opcional (cantidad del elemento en la unidad de la partida, para ponderar).
  - El "actual" de un elemento a una fecha es el último registro con fecha ≤ asOf (desempate por `at`).
  - Corrección: línea tombstone `{del:id}`. Compactar con reescritura atómica cuando haya muchos tombstones.
  - Índice en memoria `Map<globalId, registros[]>`, reconstruido al cargar. Límite de 2 millones de registros.
- Rutas:
  - `POST /progress` (JSON ≤ 8 MB, lote ≤ 5000). Valida cada ítem y rechaza el lote entero si hay errores (`{error, details:[{index,message}]}`). Aviso, no error, si `code` no está en el presupuesto.
  - `DELETE /progress/:id` y `DELETE /progress/batches/:batchId`.
  - `GET /progress?asOf=&code=&globalId=&after=&limit=` (paginado).
  - `GET /progress/state?asOf=` devuelve `{rev, asOf, elements:{[globalId]:{code,pct,date}}}` (lo que necesita el visor para colorear).
  - `GET /progress/summary?asOf=` devuelve por partida `{code, elements, pct, qtyDone, amountDone}` y los totales. Es el 5D: avance ponderado por qty (o igual si falta), valorizado = pct·metrado de la partida·precio unitario.
- Opcional: `links.json` para vínculos elemento-partida manuales (`GET /links`, `POST /links {set:[{globalId,code}], unset:[]}`).
- Curva S/planificado-vs-real: calcularla en cliente a partir de los tres GET (menor riesgo).

3.5 Presentación del estado 4D
- Para compartir fecha, versión de cronograma y modo de color, crear un slice sincronizado nuevo (por ejemplo `fourD`). El hub NO necesita cambios: acepta cualquier slice con nombre válido.
- Coste: añadirlo a `SYNCED_SLICES` rompe una aserción de `sync.test.mjs` (ver 5.3).

=====================================================================
PARTE 4. ORDEN DE IMPLEMENTACIÓN
=====================================================================
1. Infraestructura sin cambio de comportamiento: `storage.js`, `ProjectRegistry` con solo `principal`, fachada para el hub, `req.project` y sub-router montado dos veces. Correr TODO `npm test`; debe quedar idéntico.
2. Proyectos: CRUD, activo, mensajes WS 'project', estado en `welcome` e `info`. Prueba nueva `tests/e2e/proyectos.test.mjs` (puerto 8107).
3. Presupuesto: store, validación, importador S10, rutas, pruebas.
4. Cronogramas: store, parser MSPDI, resolución de códigos, rutas. Las pruebas necesitan un XML MSPDI sintético (no hay ninguno en el repo; el real lo aporta el usuario).
5. Avance: store JSONL, rutas, summary, difusión 'data'.
6. Cliente: `api.js`, `SyncClient`, `ViewsPersistence.reload`, store y `main.js`, UI.
7. Documentación (README sección API, ARQUITECTURA sección 13, lista de pruebas de 12.8).

=====================================================================
PARTE 5. QUÉ PRUEBAS EXISTENTES PUEDEN ROMPERSE
=====================================================================
5.1 `tests/e2e/server.test.mjs`
- L~296: `deepEqual(Object.keys(ifc), ['id','name','kind','size','uploadedAt','georef','cad'])`. También `deepEqual(lista[0], ifc)`, `deepEqual(lista, [ifc, dxf])` tras reinicio y `deepEqual(m.models,[rec])`. Romperían si se añade cualquier campo a ModelRecord (por ejemplo `projectId`).
- Mensajes WS comparados con `deepEqual` estricto (no añadir claves):
  - `presentation` (`{t,active,presenterId,presenterName}`).
  - `state` hacia espectadores (`{t,slices,full}`).
  - `welcome.presentation` y `welcome.state`.
  - Las entradas de `clients.list` (`{id,name,role}`).
  - Se pueden añadir claves en el primer nivel de `welcome`, `models` e `info` (las pruebas comprueban campos sueltos).
- Rutas de disco: `DATA_DIR/session.json` y `DATA_DIR/uploads/<id>.<kind>` (L297, 305, 421, 543, 905, 938, 950-956, 1015-1021, 1083). Mover estos archivos rompe las pruebas.
- L1104: `readdirSync(uploads)` debe ser `[]` tras un 413. Nada auxiliar en `uploads/`.
- L907 y L1021: `readdirSync(DATA_DIR).filter(f=>f.endsWith('.tmp'))` debe ser `[]`. Los temporales de escritura atómica deben desaparecer siempre.
- L954: exactamente 1 copia `session.json.corrupto-*`. Cargar cada archivo una sola vez.
- Textos de log exigidos: 'Servidor detenido', 'SIGINT', 'ignoraron', 'vistas guardadas', 'ya está en uso', URL local/de red, aviso del Firewall con `netsh`, y que el PIN no se imprima.
- Una prueba exige que `GET /api/no-existe` dé 404 JSON, y las de path traversal esperan 404 o 400 para ids falsos. Los `:pid` nuevos necesitan validación por regex con 404 y no 500.
- `PUT /api/views` hasta 8 MB (60 vistas con miniaturas de 100 KB) debe seguir dando 200.
- La puerta 403 se comprueba con 'presentador' y 'Origen'.
- Los `noRecibe('state'|'presentation'|'camera'|'pointer'|'models')` no deben recibir mensajes espontáneos. No emitir 'project' ni 'data' al conectarse.
- `{t:'inventado'}` debe seguir dando `error`. No añadir tipos cliente-servidor nuevos sin pruebas.
5.2 `tests/e2e/correcciones.test.mjs`
- L250-251: `session.json` con `views.length===1 && models.length===1`.
- L312: `page.route('**/api/views')` simula un PUT con 500. Si el cliente pasa a `/api/projects/:pid/views`, deja de interceptarse y el test falla. Mantener `getViews/putViews` en `/api/views`.
5.3 `tests/e2e/sync.test.mjs`
- L345-346: el estado completo debe traer exactamente los slices `cad,display,measure,models,section,selection,storey,ui,views,visibility`. Añadir un slice a `SYNCED_SLICES` exige actualizar esa cadena.
- L566: debe haber exactamente 1 'sync:unknown' para `t:'zzz'`. No usar ese nombre.
- Usa un hub falso (`welcome` sin campos nuevos) y los sandboxes `public/dev/sync-integration.js`, `sync-loader-sandbox.js` y `sync-sandbox.js`, que construyen `ModelLoader`, `SyncClient` y `Presentation` con firmas actuales y una `api` doble. Nuevos parámetros deben ser opcionales, y ModelLoader/SyncClient no deben llamar a métodos nuevos de api en `start()`. `viewsPersistence` no se instancia allí.
- L571-574: 'server:models' debe seguir siendo un array de ModelRecord.
5.4 `app.test.mjs`, `presentation.test.mjs`, `correcciones2.test.mjs`, `acerca.test.mjs`
- Usan el servidor real y todo el cliente: cualquier paso nuevo en `main.js` que falle o tarde con un servidor sin datos 4D los rompe. Debe tolerar 404 o respuestas vacías. `window.__visor` y `dataset.ready` deben seguir igual.
5.5 Pruebas nuevas
- Puertos 8107 y 8108 y un archivo nuevo para no hinchar `server.test.mjs`.
- Cubrir: migración (arrancar con un DATA_DIR de fase 1 y verificar que `principal` conserva modelos y vistas), CRUD de proyectos, cambio de activo con `models` y `project` por WS, 403 para viewers, importes con archivos inválidos, ids con traversal, `X-Project-Id` desfasado, límites, y reinicio del servidor.

=====================================================================
PARTE 6. SEGURIDAD Y LÍMITES NUEVOS
=====================================================================
- Parser XML: sin resolver entidades externas y con límite de expansión. El tamaño máximo lo fija `maxImportMb`. El análisis síncrono de un XML grande bloquea el bucle de eventos unos cientos de ms; si molesta, moverlo a un worker_thread.
- Escritura 4D con rol presenter: quien registre avance desde otro equipo necesita el PRESENTER_PIN. Si se quiere un rol "editor" aparte, es una decisión de producto.
- Windows/OneDrive: si `DATA_DIR` queda dentro de OneDrive, los bloqueos EBUSY/EPERM ya se reintentan en `renombrar`. El anexado a JSONL con `appendFileSync` es síncrono, por lo que no hay vaciado pendiente al cerrar.

## Riesgos

- Cualquier campo nuevo en ModelRecord (p. ej. projectId, discipline, level) rompe server.test.mjs (~L296 deepEqual de Object.keys, deepEqual de listas y de m.models). Mantener 7 claves o actualizar esas pruebas a propósito.
- Mover session.json o uploads/ a una carpeta de proyecto rompe unas 15 aserciones de server.test.mjs y correcciones.test.mjs. El proyecto principal debe conservar las rutas heredadas.
- Añadir un slice (p. ej. fourD) a SYNCED_SLICES rompe sync.test.mjs L346, que compara la lista exacta de slices del estado completo. Hay que actualizar esa prueba en el mismo cambio.
- Cambiar el cliente de vistas a /api/projects/:pid/views deja de coincidir con el page.route('**/api/views') de correcciones.test.mjs L312. Mantener getViews/putViews en /api/views.
- Condición de carrera al cambiar de proyecto: una subida larga (multer ya eligió destino) o un PUT /views pendiente podrían caer en el proyecto equivocado. Mitigación: fijar req.project al inicio de la petición, cabecera opcional X-Project-Id con 409, y que ViewsPersistence haga flush() antes de cambiar.
- Si se cambia de proyecto durante una presentación, lastState en el hub queda obsoleto (selection, models, visibility de otro proyecto). Hay que limpiar lastState/lastCamera y que el presentador reenvíe el estado completo, o los espectadores que entren tarde recibirán datos incoherentes.
- ModelLoader.reconcile descarga y carga modelos al cambiar de proyecto, pero no limpia store.cad[id], section, measure ni views. Debe hacerlo un módulo nuevo (ProjectSession) sin editar ModelLoader, porque sync-loader-sandbox.js usa una api doble.
- session.json se reescribe completo en cada cambio y las vistas pueden pesar unos 12 MB. No guardar datos 4D/5D ahí; avance en JSONL y presupuesto/cronogramas en archivos propios.
- No existe parser XML, zip ni xlsx en node_modules. Hay que elegir entre añadir dependencias con versión exacta (fast-xml-parser 5.11.2, fflate 0.8.3; el registro npm responde desde este sandbox) o escribir un tokenizador propio. En ambos casos fijar límites de expansión de entidades y de tamaño (MAX_IMPORT_MB).
- No hay ningún MSPDI real ni exportación real de S10 en el repo ni en el sandbox. Dónde guarda el usuario el código de partida en MS Project (WBS, campo Texto con alias, prefijo del nombre) y qué columnas exporta S10 son hipótesis; la detección 'auto' y los sinónimos de cabecera deben validarse con los archivos reales del expediente.
- Express 5: req.body es undefined sin parser (usar ?? null) y los comodines deben ir nombrados. La ruta PUT /projects/active y PUT /schedules/current deben declararse antes de /:pid y /:sid o se interpretarán como ids.
- Todas las escrituras usan la puerta de presentador (loopback o PIN). El registro de avance desde otros equipos exige compartir el PIN, y cualquier presentador puede cambiar el proyecto activo aunque otro presente, igual que hoy con DELETE /api/models. Es una decisión de producto, no un fallo técnico.
- Los mensajes WS nuevos ('project', 'data') son seguros para clientes viejos (caen en sync:unknown), pero el servidor sigue respondiendo error a cualquier tipo cliente-servidor desconocido; mantener las escrituras 4D solo por REST evita tocar _alMensaje.
- La documentación declara store.js, actions.js y main.js como contrato 'sin cambios de API'. La fase 2 necesita cambios aditivos en store.js y main.js; conviene registrarlo en la sección 13 de ARQUITECTURA.md.
- El problema de los módulos vinculados no se puede reproducir aquí: falta el data/ del usuario (gitignored). El servidor sirve los bytes del IFC sin parsearlos, así que la causa está en el cliente (web-ifc, IfcManager o ifc.worker, posiblemente georreferencia o desplazamiento de origen). Hay que obtener esos IFC para diagnosticarlo.
