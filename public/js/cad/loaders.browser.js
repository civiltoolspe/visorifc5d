// Cargadores de dependencias de terceros para el Web Worker del navegador.
// Los import maps NO aplican dentro de workers: se usan rutas absolutas servidas por Express
// (/vendor/...). Cada cargador se memoriza (se descarga/instancia una sola vez por worker).

let dxfParserPromise = null;
let libreDwgPromise = null;
let triangulatorPromise = null;

// dxf-parser: el UMD (dist/dxf-parser.js) se evalúa como un módulo CommonJS mínimo; su
// versión ESM tiene importaciones sin extensión y no carga en el navegador.
function loadDxfParser() {
  if (!dxfParserPromise) {
    dxfParserPromise = (async () => {
      const res = await fetch('/vendor/dxf-parser/dxf-parser.js');
      if (!res.ok) throw new Error(`No se pudo cargar dxf-parser (${res.status})`);
      const code = await res.text();
      const mod = { exports: {} };
      // eslint-disable-next-line no-new-func
      new Function('module', 'exports', `${code}\n//# sourceURL=/vendor/dxf-parser/dxf-parser.js`)(mod, mod.exports);
      const DxfParser = mod.exports?.default || mod.exports;
      if (typeof DxfParser !== 'function') throw new Error('dxf-parser no exportó una clase válida');
      return DxfParser;
    })();
    dxfParserPromise.catch(() => { dxfParserPromise = null; });
  }
  return dxfParserPromise;
}

// libredwg-web (WASM). El .wasm se localiza en /vendor/libredwg-web/wasm/.
function loadLibreDwg() {
  if (!libreDwgPromise) {
    libreDwgPromise = (async () => {
      const mod = await import('/vendor/libredwg-web/dist/libredwg-web.js');
      const lib = await mod.LibreDwg.create('/vendor/libredwg-web/wasm');
      return { lib, Dwg_File_Type: mod.Dwg_File_Type };
    })();
    libreDwgPromise.catch(() => { libreDwgPromise = null; });
  }
  return libreDwgPromise;
}

// Triangulador de polígonos con huecos (earcut de three.js: ShapeUtils). Solo se carga si hace falta.
function loadTriangulator() {
  if (!triangulatorPromise) {
    triangulatorPromise = (async () => {
      const THREE = await import('/vendor/three/build/three.module.js');
      return (contour, holes) => THREE.ShapeUtils.triangulateShape(
        contour.map((p) => new THREE.Vector2(p.x, p.y)),
        holes.map((h) => h.map((p) => new THREE.Vector2(p.x, p.y))),
      );
    })();
    triangulatorPromise.catch(() => { triangulatorPromise = null; });
  }
  return triangulatorPromise;
}

export const browserLoaders = {
  dxfParser: loadDxfParser,
  libreDwg: loadLibreDwg,
  triangulator: loadTriangulator,
};
