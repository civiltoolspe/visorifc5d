// Pruebas del módulo IFC.
//   (a) En Node: georreferencia, unidades, propiedades, aristas, estados y búsqueda con los módulos puros + web-ifc (build Node).
//   (b) En el navegador (devserver en el puerto 8103): carga real con worker, textura de estados, picking,
//       selección/aislamiento, tipos ocultos, niveles, alineación de dos IFC y escalabilidad.
// Uso: node tests/e2e/ifc.test.mjs      (código de salida 0 si todo pasa, 1 si algo falla)

import fs from 'node:fs';
import path from 'node:path';
import * as WebIFC from 'web-ifc';
import { startDevServer } from '../devserver.mjs';
import { FIXTURES, launchBrowser, waitFor } from './helpers.mjs';
import { runIfcPipeline, getElementProperties } from '../../public/js/ifc/ifcPipeline.js';
import { resolveGeoreference, webPointToMap } from '../../public/js/ifc/georef.js';
import { ElementTable } from '../../public/js/ifc/elementTable.js';
import { resolveStates, STATE, OVERRIDE_BIT } from '../../public/js/ifc/IfcStates.js';
import { computeEdges, ChunkBuilder, CLASS_OPAQUE } from '../../public/js/ifc/geometry.js';
import { typeLabel, typeLabelPlural, humanizeIfcType, categoryType } from '../../public/js/ifc/typeLabels.js';
import { formatValue, normalizeText } from '../../public/js/ifc/ifcUtils.js';

const PORT = 8103;
const results = [];
let currentSection = '';

function section(name) {
  currentSection = name;
  console.log(`\n== ${name}`);
}

async function test(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    results.push({ ok: true, name: `${currentSection} / ${name}` });
    console.log(`  ok   ${name} (${Date.now() - t0} ms)`);
  } catch (err) {
    results.push({ ok: false, name: `${currentSection} / ${name}`, err });
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
}

function check(cond, msg) {
  if (!cond) throw new Error(msg);
}

function near(a, b, tol, msg) {
  if (!(Math.abs(a - b) <= tol)) throw new Error(`${msg}: esperado ${b} ± ${tol}, obtenido ${a}`);
}

const fixtureExpected = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'fixtures.json'), 'utf8'));

// ---------------------------------------------------------------------------------------------
// Utilidades Node
// ---------------------------------------------------------------------------------------------
let nodeApi = null;
async function getNodeApi() {
  if (!nodeApi) {
    nodeApi = new WebIFC.IfcAPI();
    await nodeApi.Init();
  }
  return nodeApi;
}

async function runNode(source) {
  const api = await getNodeApi();
  const buf = typeof source === 'string' && !source.startsWith('ISO-')
    ? fs.readFileSync(source)
    : Buffer.from(source);
  const data = new Uint8Array(buf);
  let frame = null;
  const chunks = [];
  const phases = new Set();
  const out = await runIfcPipeline({
    api,
    WebIFC,
    data,
    hooks: { frame: (f) => { frame = f; }, chunk: (c) => chunks.push(c), progress: (ph) => phases.add(ph) },
  });
  const georef = resolveGeoreference({ mapConversion: frame.mapConversion, offset: frame.offset, lengthFactor: frame.lengthFactor });
  // Índice de elemento -> tipo, a partir de los fragmentos
  const typeDict = [];
  const types = [];
  const ids = [];
  for (const c of chunks) {
    c.typeDictAdd.forEach((t, i) => { typeDict[c.typeDictStart + i] = t; });
    for (let i = 0; i < c.elements.expressIds.length; i++) {
      ids.push(c.elements.expressIds[i]);
      types.push(typeDict[c.elements.typeIdx[i]]);
    }
  }
  return { api, ...out, frame, chunks, georef, ids, types, phases };
}

// Vértices (en coordenadas de mapa) de los elementos que cumplen el filtro
function mapVertices(run, filter) {
  const pts = [];
  for (const c of run.chunks) {
    for (const b of c.batches) {
      for (let i = 0; i < b.positions.length / 3; i++) {
        const ei = b.elementIndex[i];
        if (!filter(ei)) continue;
        pts.push(webPointToMap(run.georef, b.positions[i * 3], b.positions[i * 3 + 1], b.positions[i * 3 + 2]));
      }
    }
  }
  return pts;
}

function nearestDistance(pts, target) {
  let best = Infinity;
  for (const p of pts) {
    const d = Math.hypot(p.e - target[0], p.n - target[1], p.h - target[2]);
    if (d < best) best = d;
  }
  return best;
}

// IFC mínimo con unidades en milímetros (para probar escalas y unidades)
function makeMmIfc({ mapConversion = null } = {}) {
  const mc = mapConversion
    ? `#30=IFCPROJECTEDCRS('EPSG:32718','UTM',$,$,$,$,${mapConversion.mapUnit ? '#31' : '$'});\n${mapConversion.mapUnit ? '#31=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);\n' : ''}#32=IFCMAPCONVERSION(#10,#30,${mapConversion.e},${mapConversion.n},${mapConversion.h},${mapConversion.a ?? 1.},${mapConversion.o ?? 0.},${mapConversion.scale ?? 1.});\n`
    : '';
  const site = mapConversion
    ? '#18=IFCCARTESIANPOINT((0.,0.,0.));'
    : '#18=IFCCARTESIANPOINT((279500000.,8661000000.,150000.));';
  return `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');
FILE_NAME('mm.ifc','2026-10-09T14:58:25',(''),(''),'x','x','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('3weeWyvIb0$9hRbA4iwBg0',$,'Proyecto mm',$,$,$,$,(#10),#5);
#2=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);
#3=IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.);
#4=IFCSIUNIT(*,.VOLUMEUNIT.,$,.CUBIC_METRE.);
#5=IFCUNITASSIGNMENT((#2,#3,#4));
#6=IFCCARTESIANPOINT((0.,0.,0.));
#7=IFCDIRECTION((0.,0.,1.));
#8=IFCDIRECTION((1.,0.,0.));
#9=IFCAXIS2PLACEMENT3D(#6,#7,#8);
#10=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#9,$);
#11=IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,#10,$,.MODEL_VIEW.,$);
${mc}#14=IFCSITE('2rhQ0IuJX9xBGKKbYmpAbb',$,'Terreno',$,$,#22,$,$,$,$,$,$,$,$);
#15=IFCBUILDING('2Bdj1PDsv9rgHJc_Dze17y',$,'Edificio A',$,$,#27,$,$,$,$,$,$);
#16=IFCRELAGGREGATES('2QwR13Xx99pe0Rs7XWijHP',$,$,$,#1,(#14));
#17=IFCRELAGGREGATES('3GvziLo1nCT9VEUrKe_u6g',$,$,$,#14,(#15));
${site}
#19=IFCDIRECTION((0.,0.,1.));
#20=IFCDIRECTION((1.,0.,0.));
#21=IFCAXIS2PLACEMENT3D(#18,#19,#20);
#22=IFCLOCALPLACEMENT($,#21);
#23=IFCCARTESIANPOINT((0.,0.,0.));
#26=IFCAXIS2PLACEMENT3D(#23,#19,#20);
#27=IFCLOCALPLACEMENT(#22,#26);
#43=IFCBUILDINGSTOREY('0uAvDTIUX9HuoB_ok2Aefc',$,'Nivel 1',$,$,#49,$,$,$,3000.);
#44=IFCRELAGGREGATES('3C9sVYdQL7O93TzVyukSXj',$,$,$,#15,(#43));
#45=IFCCARTESIANPOINT((0.,0.,3000.));
#48=IFCAXIS2PLACEMENT3D(#45,#19,#20);
#49=IFCLOCALPLACEMENT(#27,#48);
#51=IFCCARTESIANPOINTLIST2D(((0.,0.),(12000.,0.),(12000.,8000.),(0.,8000.)));
#52=IFCINDEXEDPOLYCURVE(#51,$,$);
#54=IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,$,#52);
#55=IFCEXTRUDEDAREASOLID(#54,$,#7,200.);
#56=IFCSHAPEREPRESENTATION(#11,'Body','SweptSolid',(#55));
#57=IFCPRODUCTDEFINITIONSHAPE($,$,(#56));
#58=IFCCARTESIANPOINT((0.,0.,0.));
#59=IFCAXIS2PLACEMENT3D(#58,#19,#20);
#69=IFCLOCALPLACEMENT(#49,#59);
#50=IFCSLAB('2rKlVxxVv9IPdsxPhNb92n',$,'Losa mm',$,$,#69,#57,$,$);
#64=IFCRELCONTAINEDINSPATIALSTRUCTURE('18n0HLFDTBVBHdE2$3xEXe',$,$,$,(#50),#43);
ENDSEC;
END-ISO-10303-21;
`;
}

// IFC sintético grande (cuadrícula de columnas, muros y muebles repartidos en niveles)
function makeBigIfc(count, perLevel = 400) {
  const L = [];
  L.push('ISO-10303-21;', 'HEADER;', "FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');", "FILE_NAME('big.ifc','2026-10-09T00:00:00',(''),(''),'x','x','');", "FILE_SCHEMA(('IFC4'));", 'ENDSEC;', 'DATA;');
  L.push("#1=IFCPROJECT('3weeWyvIb0$9hRbA4iwBg0',$,'Proyecto Grande',$,$,'Sintetico',$,(#10),#5);");
  L.push('#2=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);', '#3=IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.);', '#4=IFCSIUNIT(*,.VOLUMEUNIT.,$,.CUBIC_METRE.);', '#5=IFCUNITASSIGNMENT((#2,#3,#4));');
  L.push('#6=IFCCARTESIANPOINT((0.,0.,0.));', '#7=IFCDIRECTION((0.,0.,1.));', '#8=IFCDIRECTION((1.,0.,0.));', '#9=IFCAXIS2PLACEMENT3D(#6,#7,#8);');
  L.push("#10=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#9,$);");
  L.push("#11=IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,#10,$,.MODEL_VIEW.,$);");
  L.push("#12=IFCPROJECTEDCRS('EPSG:32718','UTM 18S',$,$,$,$,$);");
  L.push('#13=IFCMAPCONVERSION(#10,#12,279500.,8661000.,150.,1.,0.,1.);');
  L.push("#14=IFCSITE('2rhQ0IuJX9xBGKKbYmpAbb',$,'Terreno',$,$,#22,$,$,$,$,$,$,$,$);");
  L.push("#15=IFCBUILDING('2Bdj1PDsv9rgHJc_Dze17y',$,'Edificio Grande',$,$,#27,$,$,$,$,$,$);");
  L.push("#16=IFCRELAGGREGATES('2QwR13Xx99pe0Rs7XWijHP',$,$,$,#1,(#14));", "#17=IFCRELAGGREGATES('3GvziLo1nCT9VEUrKe_u6g',$,$,$,#14,(#15));");
  L.push('#18=IFCCARTESIANPOINT((0.,0.,0.));', '#21=IFCAXIS2PLACEMENT3D(#18,#7,#8);', '#22=IFCLOCALPLACEMENT($,#21);', '#26=IFCAXIS2PLACEMENT3D(#18,#7,#8);', '#27=IFCLOCALPLACEMENT(#22,#26);');
  L.push("#28=IFCSURFACESTYLE('a',.BOTH.,(#29));", '#29=IFCSURFACESTYLESHADING(#30,$);', '#30=IFCCOLOURRGB($,0.8,0.6,0.4);');
  L.push("#31=IFCSURFACESTYLE('b',.BOTH.,(#32));", '#32=IFCSURFACESTYLESHADING(#33,$);', '#33=IFCCOLOURRGB($,0.4,0.6,0.8);');
  const levels = Math.ceil(count / perLevel);
  const storeys = [];
  for (let s = 0; s < levels; s++) {
    const sid = 200 + s * 4;
    storeys.push(sid);
    L.push(`#${sid}=IFCBUILDINGSTOREY('S${String(s).padStart(20, '0')}A',$,'Nivel ${s + 1}',$,$,#${sid + 3},$,$,$,${s * 3}.);`);
    L.push(`#${sid + 1}=IFCCARTESIANPOINT((0.,0.,${s * 3}.));`, `#${sid + 2}=IFCAXIS2PLACEMENT3D(#${sid + 1},#7,#8);`, `#${sid + 3}=IFCLOCALPLACEMENT(#27,#${sid + 2});`);
  }
  L.push(`#17000=IFCRELAGGREGATES('3C9sVYdQL7O93TzVyukSXj',$,$,$,#15,(${storeys.map((x) => `#${x}`).join(',')}));`);
  let id = 20000;
  let k = 0;
  const contained = storeys.map(() => []);
  for (let s = 0; s < levels; s++) {
    for (let e = 0; e < perLevel && k < count; e++, k++) {
      const x = (e % 25) * 2.5;
      const y = Math.floor(e / 25) * 2.5;
      const kind = e % 3;
      const w = kind === 0 ? 0.3 : kind === 1 ? 2.0 : 0.4;
      const d = kind === 0 ? 0.3 : kind === 1 ? 0.2 : 0.4;
      const h = kind === 2 ? 0.9 : 2.8;
      const b = id;
      id += 12;
      const type = kind === 0 ? 'IFCCOLUMN' : kind === 1 ? 'IFCWALL' : 'IFCFURNISHINGELEMENT';
      L.push(`#${b}=IFCCARTESIANPOINT((${x}.,${y}.,0.));`, `#${b + 1}=IFCAXIS2PLACEMENT3D(#${b},#7,#8);`, `#${b + 2}=IFCLOCALPLACEMENT(#${storeys[s] + 3},#${b + 1});`);
      L.push(`#${b + 3}=IFCRECTANGLEPROFILEDEF(.AREA.,$,#${b + 4},${w},${d});`, `#${b + 4}=IFCAXIS2PLACEMENT2D(#${b + 5},$);`, `#${b + 5}=IFCCARTESIANPOINT((0.,0.));`);
      L.push(`#${b + 6}=IFCEXTRUDEDAREASOLID(#${b + 3},#9,#7,${h});`, `#${b + 7}=IFCSHAPEREPRESENTATION(#11,'Body','SweptSolid',(#${b + 6}));`, `#${b + 8}=IFCPRODUCTDEFINITIONSHAPE($,$,(#${b + 7}));`);
      L.push(`#${b + 9}=IFCSTYLEDITEM(#${b + 6},(#${kind === 1 ? 28 : 31}),$);`);
      L.push(`#${b + 10}=${type}('E${String(b).padStart(20, '0')}A',$,'${type.slice(3)} ${s + 1}-${e}',$,$,#${b + 2},#${b + 8},$${type === 'IFCFURNISHINGELEMENT' ? '' : ',$'});`);
      contained[s].push(b + 10);
    }
  }
  for (let s = 0; s < levels; s++) {
    if (contained[s].length) L.push(`#${18000 + s}=IFCRELCONTAINEDINSPATIALSTRUCTURE('R${String(s).padStart(20, '0')}A',$,$,$,(${contained[s].map((x) => `#${x}`).join(',')}),#${storeys[s]});`);
  }
  L.push('ENDSEC;', 'END-ISO-10303-21;');
  return L.join('\n');
}

// ---------------------------------------------------------------------------------------------
// (a) Pruebas en Node
// ---------------------------------------------------------------------------------------------
async function nodeTests() {
  section('Node: georreferencia');
  const georefFile = path.join(FIXTURES, 'edificio_georef_ifc4.ifc');
  const siteFile = path.join(FIXTURES, 'edificio_site_ifc2x3.ifc');
  const corners = fixtureExpected.buildingCornersMap;
  const cornerList = [corners.origen, corners.esq_x, corners.esq_xy, corners.esq_y];

  await test('IFC4 con IfcMapConversion: esquinas exteriores coinciden con fixtures.json (<= 1 cm)', async () => {
    const run = await runNode(georefFile);
    check(run.georef.source === 'mapconversion', `fuente ${run.georef.source}`);
    check(run.georef.crs === fixtureExpected.crs, `crs ${run.georef.crs}`);
    near(run.georef.rotationDeg, fixtureExpected.rotationDeg, 1e-9, 'rotación');
    const walls = new Set();
    run.ids.forEach((_, i) => { if (run.types[i] === 'IFCWALL') walls.add(i); });
    check(walls.size === 8, `muros: ${walls.size}`);
    const pts = mapVertices(run, (ei) => walls.has(ei));
    for (const c of cornerList) {
      const d = nearestDistance(pts, c);
      check(d <= 0.01, `esquina ${c.join(',')} a ${d.toFixed(4)} m`);
    }
  });

  await test('IFC2x3 con IfcSite en UTM (sin IfcMapConversion): mismas esquinas (<= 1 cm)', async () => {
    const run = await runNode(siteFile);
    check(run.georef.source === 'site', `fuente ${run.georef.source}`);
    check(run.georef.georeferenced, 'debe considerarse georreferenciado');
    const walls = new Set();
    run.ids.forEach((_, i) => { if (run.types[i] === 'IFCWALL') walls.add(i); });
    const pts = mapVertices(run, (ei) => walls.has(ei));
    for (const c of cornerList) {
      const d = nearestDistance(pts, c);
      check(d <= 0.01, `esquina ${c.join(',')} a ${d.toFixed(4)} m`);
    }
    // Rango real del edificio completo: E, N, H esperados (la losa del nivel 1 baja 0.2 m bajo la cota 150)
    const all = mapVertices(run, () => true);
    const e = all.map((p) => p.e); const n = all.map((p) => p.n); const h = all.map((p) => p.h);
    near(Math.min(...e), 279497.93, 0.01, 'E mín'); near(Math.max(...e), 279511.59, 0.01, 'E máx');
    near(Math.min(...n), 8661000, 0.01, 'N mín'); near(Math.max(...n), 8661010.83, 0.01, 'N máx');
    near(Math.max(...h), 155.8, 0.01, 'H máx');
  });

  await test('Ambos IFC dan las mismas coordenadas de mapa por elemento', async () => {
    const a = await runNode(georefFile);
    const b = await runNode(siteFile);
    const pa = mapVertices(a, () => true);
    const pb = mapVertices(b, () => true);
    const ext = (pts) => ({ e: [Math.min(...pts.map((p) => p.e)), Math.max(...pts.map((p) => p.e))], n: [Math.min(...pts.map((p) => p.n)), Math.max(...pts.map((p) => p.n))], h: [Math.min(...pts.map((p) => p.h)), Math.max(...pts.map((p) => p.h))] });
    const ea = ext(pa); const eb = ext(pb);
    for (const k of ['e', 'n', 'h']) {
      near(ea[k][0], eb[k][0], 0.01, `${k} mín`);
      near(ea[k][1], eb[k][1], 0.01, `${k} máx`);
    }
  });

  await test('Sobrescritura manual de georreferencia tiene prioridad', async () => {
    const run = await runNode(georefFile);
    const g = resolveGeoreference({
      mapConversion: run.frame.mapConversion,
      offset: run.frame.offset,
      lengthFactor: run.frame.lengthFactor,
      override: { eastings: 100, northings: 200, height: 5, rotationDeg: 90, scale: 1 },
    });
    check(g.source === 'manual', g.source);
    near(g.anchor.e, 100, 1e-9, 'ancla E'); near(g.anchor.n, 200, 1e-9, 'ancla N'); near(g.anchor.h, 5, 1e-9, 'ancla H');
    const p = webPointToMap(g, 1, 0, 0); // +x local -> +N con rotación de 90°
    near(p.e, 100, 1e-9, 'E'); near(p.n, 201, 1e-9, 'N');
  });

  await test('Modelo en milímetros con IfcSite en UTM: escala y niveles correctos', async () => {
    const run = await runNode(makeMmIfc());
    check(run.frame.lengthFactor === 0.001, `factor de longitud ${run.frame.lengthFactor}`);
    check(run.georef.source === 'site', run.georef.source);
    const pts = mapVertices(run, () => true);
    const e = pts.map((p) => p.e); const n = pts.map((p) => p.n); const h = pts.map((p) => p.h);
    near(Math.min(...e), 279500, 1e-3, 'E mín'); near(Math.max(...e), 279512, 1e-3, 'E máx');
    near(Math.min(...n), 8661000, 1e-3, 'N mín'); near(Math.max(...n), 8661008, 1e-3, 'N máx');
    near(Math.min(...h), 153, 1e-3, 'H mín'); near(Math.max(...h), 153.2, 1e-3, 'H máx');
    near(run.result.storeys[0].zModel, 153, 1e-6, 'elevación del nivel (m, marco del modelo)');
  });

  await test('IFC2x3 con ePSet_MapConversion / ePSet_ProjectedCRS: misma georreferencia que el IFC4', async () => {
    // Se parte del IFC2x3 con el sitio en UTM y se lleva el sitio a coordenadas locales; la georreferencia pasa a los Psets
    let text = fs.readFileSync(siteFile, 'utf8');
    text = text.replace('#28=IFCCARTESIANPOINT((279500.,8661000.,150.));', '#28=IFCCARTESIANPOINT((0.,0.,0.));')
      .replace('#30=IFCDIRECTION((0.9659258262890683,0.25881904510252074,0.));', '#30=IFCDIRECTION((1.,0.,0.));');
    const props = [
      "#9001=IFCPROPERTYSINGLEVALUE('Eastings',$,IFCLENGTHMEASURE(279500.),$);",
      "#9002=IFCPROPERTYSINGLEVALUE('Northings',$,IFCLENGTHMEASURE(8661000.),$);",
      "#9003=IFCPROPERTYSINGLEVALUE('OrthogonalHeight',$,IFCLENGTHMEASURE(150.),$);",
      "#9004=IFCPROPERTYSINGLEVALUE('XAxisAbscissa',$,IFCREAL(0.9659258262890683),$);",
      "#9005=IFCPROPERTYSINGLEVALUE('XAxisOrdinate',$,IFCREAL(0.25881904510252074),$);",
      "#9006=IFCPROPERTYSINGLEVALUE('Scale',$,IFCREAL(1.),$);",
      "#9007=IFCPROPERTYSET('0AAAAAAAAAAAAAAAAAAAAA',$,'ePSet_MapConversion',$,(#9001,#9002,#9003,#9004,#9005,#9006));",
      "#9008=IFCPROPERTYSINGLEVALUE('Name',$,IFCLABEL('EPSG:32718'),$);",
      "#9009=IFCPROPERTYSET('0BBBBBBBBBBBBBBBBBBBBB',$,'ePSet_ProjectedCRS',$,(#9008));",
      "#9010=IFCRELDEFINESBYPROPERTIES('0CCCCCCCCCCCCCCCCCCCCC',$,$,$,(#9),#9007);",
      "#9011=IFCRELDEFINESBYPROPERTIES('0DDDDDDDDDDDDDDDDDDDDD',$,$,$,(#9),#9009);",
    ].join('\n');
    text = text.replace('ENDSEC;\nEND-ISO-10303-21;', `${props}\nENDSEC;\nEND-ISO-10303-21;`);
    check(text.includes('ePSet_MapConversion'), 'no se pudo preparar el IFC de prueba');
    const run = await runNode(text);
    check(run.frame.schema === 'IFC2X3', run.frame.schema);
    check(run.georef.source === 'mapconversion' && run.georef.crs === 'EPSG:32718', JSON.stringify(run.georef));
    const walls = new Set();
    run.ids.forEach((_, i) => { if (run.types[i] === 'IFCWALL') walls.add(i); });
    const pts = mapVertices(run, (ei) => walls.has(ei));
    for (const c of cornerList) {
      const d = nearestDistance(pts, c);
      check(d <= 0.01, `esquina ${c.join(',')} a ${d.toFixed(4)} m`);
    }
  });

  await test('Modelo en pies con IfcMapConversion (Scale = 0.3048, MapUnit = metro): coordenadas en metros', async () => {
    const feet = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');
FILE_NAME('ft.ifc','2026-10-09T14:58:25',(''),(''),'x','x','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('3weeWyvIb0$9hRbA4iwBg0',$,'Proyecto ft',$,$,$,$,(#10),#5);
#2=IFCCONVERSIONBASEDUNIT(#60,.LENGTHUNIT.,'FOOT',#61);
#60=IFCDIMENSIONALEXPONENTS(1,0,0,0,0,0,0);
#61=IFCMEASUREWITHUNIT(IFCLENGTHMEASURE(0.3048),#62);
#62=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#5=IFCUNITASSIGNMENT((#2));
#6=IFCCARTESIANPOINT((0.,0.,0.));
#7=IFCDIRECTION((0.,0.,1.));
#8=IFCDIRECTION((1.,0.,0.));
#9=IFCAXIS2PLACEMENT3D(#6,#7,#8);
#10=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#9,$);
#11=IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,#10,$,.MODEL_VIEW.,$);
#30=IFCPROJECTEDCRS('EPSG:32718','UTM',$,$,$,$,#62);
#32=IFCMAPCONVERSION(#10,#30,500000.,7000000.,100.,1.,0.,0.3048);
#14=IFCSITE('2rhQ0IuJX9xBGKKbYmpAbb',$,'Terreno',$,$,#22,$,$,$,$,$,$,$,$);
#16=IFCRELAGGREGATES('2QwR13Xx99pe0Rs7XWijHP',$,$,$,#1,(#14));
#18=IFCCARTESIANPOINT((0.,0.,0.));
#21=IFCAXIS2PLACEMENT3D(#18,#7,#8);
#22=IFCLOCALPLACEMENT($,#21);
#51=IFCCARTESIANPOINTLIST2D(((0.,0.),(40.,0.),(40.,20.),(0.,20.)));
#52=IFCINDEXEDPOLYCURVE(#51,$,$);
#54=IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,$,#52);
#55=IFCEXTRUDEDAREASOLID(#54,$,#7,1.);
#56=IFCSHAPEREPRESENTATION(#11,'Body','SweptSolid',(#55));
#57=IFCPRODUCTDEFINITIONSHAPE($,$,(#56));
#69=IFCLOCALPLACEMENT(#22,#21);
#50=IFCSLAB('2rKlVxxVv9IPdsxPhNb92n',$,'Losa ft',$,$,#69,#57,$,$);
#64=IFCRELCONTAINEDINSPATIALSTRUCTURE('18n0HLFDTBVBHdE2$3xEXe',$,$,$,(#50),#14);
ENDSEC;
END-ISO-10303-21;
`;
    const run = await runNode(feet);
    near(run.frame.lengthFactor, 0.3048, 1e-9, 'factor de longitud (pies)');
    near(run.georef.scale, 1, 1e-9, 'escala efectiva');
    const pts = mapVertices(run, () => true);
    near(Math.min(...pts.map((p) => p.e)), 500000, 1e-3, 'E mín'); near(Math.max(...pts.map((p) => p.e)), 500012.192, 1e-3, 'E máx');
    near(Math.min(...pts.map((p) => p.n)), 7000000, 1e-3, 'N mín'); near(Math.max(...pts.map((p) => p.n)), 7000006.096, 1e-3, 'N máx');
    near(Math.max(...pts.map((p) => p.h)), 100.3048, 1e-3, 'H máx');
    const props = getElementProperties({ api: run.api, WebIFC, handle: run.handle, units: run.units, expressId: 50 });
    check(props.attributes.some((a) => a.name === 'Name' && a.value === 'Losa ft'), 'propiedades en un modelo en pies');
  });

  await test('Elevación del nivel: respaldo por atributo Elevation y por los elementos cuando falta la colocación', async () => {
    const base = makeMmIfc();
    const attr = await runNode(base.replace("'Nivel 1',$,$,#49,$,$,$,3000.)", "'Nivel 1',$,$,$,$,$,$,3000.)"));
    check(attr.result.storeys[0].source === 'attribute', attr.result.storeys[0].source);
    near(attr.result.storeys[0].zModel, 153, 1e-6, 'Elevation + cota del ancestro');
    const none = await runNode(base.replace("'Nivel 1',$,$,#49,$,$,$,3000.)", "'Nivel 1',$,$,$,$,$,$,$)"));
    check(none.result.storeys[0].source === 'elements', none.result.storeys[0].source);
    near(none.result.storeys[0].zModel, 153, 1e-6, 'mínimo de los elementos');
  });

  await test('IfcMapConversion en modelo en mm (Scale = 0.001, MapUnit = metro)', async () => {
    const run = await runNode(makeMmIfc({ mapConversion: { e: 500000, n: 7000000, h: 100, scale: 0.001, mapUnit: true } }));
    near(run.georef.scale, 1, 1e-9, 'escala efectiva');
    const pts = mapVertices(run, () => true);
    near(Math.min(...pts.map((p) => p.e)), 500000, 1e-3, 'E mín'); near(Math.max(...pts.map((p) => p.e)), 500012, 1e-3, 'E máx');
    near(Math.min(...pts.map((p) => p.n)), 7000000, 1e-3, 'N mín');
    near(Math.max(...pts.map((p) => p.h)), 103.2, 1e-3, 'H máx');
  });

  await test('IfcMapConversion sin MapUnit usa la unidad del proyecto (mm)', async () => {
    const run = await runNode(makeMmIfc({ mapConversion: { e: 500000000, n: 7000000000, h: 100000, scale: 1 } }));
    const pts = mapVertices(run, () => true);
    near(Math.min(...pts.map((p) => p.e)), 500000, 1e-3, 'E mín'); near(Math.max(...pts.map((p) => p.e)), 500012, 1e-3, 'E máx');
    near(Math.max(...pts.map((p) => p.h)), 103.2, 1e-3, 'H máx');
  });

  await test('Modelo sin geometría, archivo inválido y muestra IFC2x3 real', async () => {
    const empty = await runNode("ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n#1=IFCPROJECT('3weeWyvIb0$9hRbA4iwBg0',$,'Vacío',$,$,$,$,$,$);\nENDSEC;\nEND-ISO-10303-21;\n");
    check(empty.result.elementCount === 0 && empty.frame && empty.result.project.name === 'Vacío', 'modelo vacío');
    let failed = false;
    try {
      await runNode('esto no es un IFC');
    } catch (err) {
      failed = /IFC/.test(err.message);
    }
    check(failed, 'un archivo inválido debe rechazarse con un mensaje claro');
    const ex = await runNode(path.join(FIXTURES, 'downloads', 'example.ifc'));
    check(ex.frame.schema === 'IFC2X3' && ex.result.elementCount > 100 && ex.result.storeys.length === 2, `example.ifc: ${ex.result.elementCount} elementos`);
    check(ex.georef.source === 'none' && !ex.georef.georeferenced, ex.georef.source);
  });

  section('Node: tabla de elementos, niveles y árbol');
  await test('Fixture IFC4: 20 elementos, 2 niveles a 3 m, 10 elementos por nivel', async () => {
    const run = await runNode(georefFile);
    check(run.result.elementCount === 20, `elementos ${run.result.elementCount}`);
    check(run.result.storeys.length === 2, 'niveles');
    const [a, b] = run.result.storeys;
    check(a.name === 'Nivel 1' && b.name === 'Nivel 2', 'nombres de niveles');
    near(b.zModel - a.zModel, 3, 1e-9, 'separación entre niveles');
    check(a.elementCount === fixtureExpected.elementsPerStorey['Nivel 1'], `elementos nivel 1: ${a.elementCount}`);
    check(b.elementCount === fixtureExpected.elementsPerStorey['Nivel 2'], `elementos nivel 2: ${b.elementCount}`);
    check(run.phases.has('parse') && run.phases.has('geometry'), 'fases de progreso');
  });

  await test('Nombres, GlobalId y tipos en MAYÚSCULAS', async () => {
    const run = await runNode(georefFile);
    const i = run.ids.indexOf(70);
    check(i >= 0, 'muro #70 en la tabla');
    check(run.result.names[i] === 'Muro Nivel 1 M01', run.result.names[i]);
    check(run.result.globalIds[i] === '1UnJUTA6f0$9v425NGG3u7', run.result.globalIds[i]);
    check(run.types[i] === 'IFCWALL', run.types[i]);
  });

  await test('IfcOpeningElement nunca se dibuja; los IfcSpace se cargan aparte', async () => {
    const run = await runNode(path.join(FIXTURES, 'downloads', 'AC20-FZK-Haus.ifc'));
    check(!run.types.includes('IFCOPENINGELEMENT'), 'hay aperturas dibujadas');
    check(run.types.filter((t) => t === 'IFCSPACE').length === 7, `espacios: ${run.types.filter((t) => t === 'IFCSPACE').length}`);
    check(run.result.storeys.length === 2, 'niveles FZK');
    near(run.result.storeys[1].zModel - run.result.storeys[0].zModel, 2.7, 1e-6, 'Dachgeschoss a 2.7 m');
    check(run.result.project.name === 'Projekt-FZK-Haus', run.result.project.name);
    check(run.result.project.schema === 'IFC4', run.result.project.schema);
  });

  await test('Árbol espacial: proyecto > terreno > edificio > niveles > elementos', async () => {
    const run = await runNode(georefFile);
    const t = run.result.tree;
    check(t.type === 'IFCPROJECT' && t.isSpatial, 'raíz');
    const site = t.children[0];
    check(site.type === 'IFCSITE', 'sitio');
    const building = site.children[0];
    check(building.type === 'IFCBUILDING', 'edificio');
    const storeys = building.children.filter((c) => c.type === 'IFCBUILDINGSTOREY');
    check(storeys.length === 2, 'niveles en el árbol');
    check(storeys[0].name === 'Nivel 1' && storeys[1].name === 'Nivel 2', 'niveles ordenados por elevación');
    check(storeys[0].children.length === 10, `hijos del nivel 1: ${storeys[0].children.length}`);
    const leaf = storeys[0].children[0];
    check(!leaf.isSpatial && typeof leaf.typeLabel === 'string' && leaf.typeLabel.length > 0, 'hoja con etiqueta');
  });

  section('Node: propiedades');
  await test('Muro: atributos, Pset_WallCommon y CT_Partida', async () => {
    const run = await runNode(georefFile);
    const props = getElementProperties({ api: run.api, WebIFC, handle: run.handle, units: run.units, expressId: 70 });
    const names = props.psets.map((p) => p.name);
    check(names.includes('Pset_WallCommon'), `psets: ${names}`);
    check(names.includes('CT_Partida'), `psets: ${names}`);
    const ct = props.psets.find((p) => p.name === 'CT_Partida');
    check(ct.props.find((x) => x.name === 'Codigo').value === '02.01.01', 'Codigo');
    const common = props.psets.find((p) => p.name === 'Pset_WallCommon');
    check(common.props.find((x) => x.name === 'IsExternal').value === 'Sí', 'IsExternal debe leerse como "Sí"');
    check(props.attributes.some((a) => a.name === 'Name' && a.value === 'Muro Nivel 1 M01'), 'atributo Name');
    check(props.attributes.some((a) => a.name === 'GlobalId'), 'atributo GlobalId');
  });

  await test('Muro del FZK: cantidades con unidad, tipo y materiales', async () => {
    const run = await runNode(path.join(FIXTURES, 'downloads', 'AC20-FZK-Haus.ifc'));
    const i = run.types.findIndex((t) => t === 'IFCWALLSTANDARDCASE');
    check(i >= 0, 'muro estándar');
    const props = getElementProperties({ api: run.api, WebIFC, handle: run.handle, units: run.units, expressId: run.ids[i] });
    check(props.quantities.length > 0, 'cantidades');
    const q = props.quantities[0].props;
    check(q.some((x) => x.unit === 'm²' || x.unit === 'm³' || x.unit === 'm'), `unidades: ${JSON.stringify(q.slice(0, 3))}`);
    check(props.type && props.type.name, 'tipo del elemento');
    check(props.materials.length > 0, 'materiales');
  });

  section('Node: aristas, estados y búsqueda');
  await test('computeEdges: un cubo tiene 12 aristas; un plano sólo su contorno', async () => {
    // cubo con vértices duplicados por cara (como entrega web-ifc)
    const faces = [
      [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]], [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]],
      [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]], [[0, 1, 0], [1, 1, 0], [1, 1, 1], [0, 1, 1]],
      [[0, 0, 0], [0, 1, 0], [0, 1, 1], [0, 0, 1]], [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]],
    ];
    const v = [];
    const idx = [];
    faces.forEach((f, fi) => {
      f.forEach((p) => v.push(p[0], p[1], p[2], 0, 0, 1));
      const b = fi * 4;
      idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
    });
    const edges = computeEdges(new Float32Array(v), 24, new Uint32Array(idx), 36, 30);
    check(edges.length / 6 === 12, `aristas del cubo: ${edges.length / 6}`);
    const plane = computeEdges(new Float32Array([0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, 1, 0, 0, 0, 1, 0, 1, 0, 0, 0, 1]), 4, new Uint32Array([0, 1, 2, 0, 2, 3]), 6, 30);
    check(plane.length / 6 === 4, `aristas del cuadrado: ${plane.length / 6}`);
  });

  await test('ChunkBuilder: transforma instancias (traslación, reflexión invierte el sentido) y revierte elementos fallidos', async () => {
    // triángulo en el plano XY con normal +Z
    const verts = new Float32Array([0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 1]);
    const idx = new Uint32Array([0, 1, 2]);
    const identityAt = (x, y, z) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
    const b = new ChunkBuilder({ edges: false });
    b.beginElement(0);
    b.addPlaced(verts, 3, idx, 3, identityAt(10, 20, 30), [1, 0, 0, 1], CLASS_OPAQUE, 1);
    const box0 = b.endElement();
    near(box0[0], 10, 1e-6, 'caja min x'); near(box0[5], 30, 1e-6, 'caja max z');
    // reflexión en X: det < 0, normal sin cambiar de lado y triángulo con sentido invertido
    b.beginElement(1);
    b.addPlaced(verts, 3, idx, 3, [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], [0, 1, 0, 1], CLASS_OPAQUE, 2);
    b.endElement();
    // elemento fallido: se revierte
    b.beginElement(2);
    b.addPlaced(verts, 3, idx, 3, identityAt(0, 0, 0), [0, 0, 1, 1], CLASS_OPAQUE, 3);
    b.abortElement();
    const out = b.flush();
    const batch = out.batches[0];
    check(batch.kind === 'opaque' && batch.positions.length === 18 && batch.indices.length === 6, `vértices ${batch.positions.length / 3}`);
    check(batch.indices[3] === 3 && batch.indices[4] === 5 && batch.indices[5] === 4, 'la reflexión invierte el sentido');
    check(batch.normals[2] === 127 && batch.normals[4 * 3 + 2] === 127, 'normales +Z');
    check(batch.colors[0] === 255 && batch.colors[1] === 0 && batch.colors[4 * 3 + 1] === 255, 'colores por vértice');
    check(batch.elementIndex[0] === 0 && batch.elementIndex[3] === 1, 'índice de elemento por vértice');
    check(b.flush() === null, 'sin restos tras vaciar');
  });

  await test('resolveStates: fantasma, aislar, resaltar, tipos, niveles y color de sobrescritura', async () => {
    const t = new ElementTable();
    t.appendChunk({
      expressIds: Int32Array.from([10, 11, 12, 13, 14]),
      typeIdx: Uint16Array.from([0, 0, 1, 2, 3]),
      boxes: new Float32Array(30),
    }, 0, ['IFCWALL', 'IFCSLAB', 'IFCWALLSTANDARDCASE', 'IFCSPACE']);
    t.setStoreys(Int32Array.from([0, 0, 1, 1, 0]));
    const out = new Uint8Array(5 * 4);
    const base = new Uint8Array(5);
    const baseCtx = {
      hiddenTypes: new Set(), hiddenIds: null, isolatedIds: null, showSpaces: false, selectionMode: 'ghost',
      selected: [], hasSelection: false, hover: -1, storey: null,
    };
    const st = (i) => out[i * 4] & 7;
    let r = resolveStates(t, out, base, null, baseCtx);
    check([0, 1, 2, 3].every((i) => st(i) === STATE.NORMAL), 'sin selección todo normal');
    check(st(4) === STATE.HIDDEN, 'los espacios están ocultos por defecto');
    r = resolveStates(t, out, base, null, { ...baseCtx, showSpaces: true });
    check(st(4) === STATE.NORMAL, 'showSpaces muestra espacios');
    r = resolveStates(t, out, base, null, { ...baseCtx, selected: [1], hasSelection: true });
    check(st(1) === STATE.SELECTED && st(0) === STATE.GHOST && st(2) === STATE.GHOST && r.ghost === 3, 'modo fantasma');
    resolveStates(t, out, base, null, { ...baseCtx, selected: [1], hasSelection: true, selectionMode: 'isolate' });
    check(st(1) === STATE.SELECTED && st(0) === STATE.HIDDEN && st(3) === STATE.HIDDEN, 'modo aislar');
    resolveStates(t, out, base, null, { ...baseCtx, selected: [1], hasSelection: true, selectionMode: 'highlight' });
    check(st(1) === STATE.SELECTED && st(0) === STATE.NORMAL, 'modo resaltar');
    resolveStates(t, out, base, null, { ...baseCtx, hiddenTypes: new Set(['IFCWALL']) });
    check(st(0) === STATE.HIDDEN && st(1) === STATE.HIDDEN && st(2) === STATE.NORMAL && st(3) === STATE.HIDDEN, 'tipo IFCWALL oculta también IFCWALLSTANDARDCASE');
    resolveStates(t, out, base, null, { ...baseCtx, hiddenIds: [10], isolatedIds: [10, 11, 12] });
    check(st(0) === STATE.HIDDEN && st(1) === STATE.NORMAL && st(3) === STATE.HIDDEN, 'ocultos manuales y aislamiento');
    // niveles: nivel 0 a 0 m, nivel 1 a 3 m
    const heights = [0, 3];
    resolveStates(t, out, base, null, { ...baseCtx, storey: { mode: 'cut', height: 0, sameModelIdx: 0, heights } });
    check(st(0) === STATE.NORMAL && st(2) === STATE.HIDDEN && st(3) === STATE.HIDDEN, 'corte: niveles superiores ocultos');
    resolveStates(t, out, base, null, { ...baseCtx, storey: { mode: 'only', height: 3, sameModelIdx: 1, heights } });
    check(st(0) === STATE.HIDDEN && st(2) === STATE.NORMAL && st(3) === STATE.NORMAL, 'solo el nivel activo');
    // color de sobrescritura
    const ov = { flags: Uint8Array.from([0, 1, 0, 0, 0]), rgb: new Uint8Array(15) };
    ov.rgb.set([10, 200, 30], 3);
    resolveStates(t, out, base, ov, { ...baseCtx, selected: [1], hasSelection: true });
    check((out[4] & OVERRIDE_BIT) !== 0 && out[5] === 10 && out[6] === 200 && out[7] === 30, 'bit y color de sobrescritura');
  });

  await test('Búsqueda insensible a mayúsculas y acentos; GlobalId; categorías', async () => {
    const t = new ElementTable();
    t.appendChunk({
      expressIds: Int32Array.from([1, 2, 3]),
      typeIdx: Uint16Array.from([0, 1, 2]),
      boxes: new Float32Array(18),
    }, 0, ['IFCPIPESEGMENT', 'IFCWALLSTANDARDCASE', 'IFCDOOR']);
    t.setNames(['Tubería de agua', 'Muro cortafuego', 'Puerta P-01'], ['GUID_A', 'GUID_B', 'GUID_C']);
    check(t.search('TUBERIA').length === 1 && t.search('TUBERIA')[0] === 0, 'acentos y mayúsculas');
    check(t.search('muros')[0] === 1, 'etiqueta de tipo en plural');
    check(t.search('ifcdoor')[0] === 2, 'nombre de tipo');
    check(t.search('guid_c')[0] === 2, 'GlobalId');
    check(t.findByGlobalId('GUID_B') === 1 && t.findByGlobalId('nada') === -1, 'findByGlobalId');
    const summary = t.typeSummary();
    check(summary.some((s) => s.type === 'IFCWALL' && s.label === 'Muros' && s.count === 1), 'IFCWALLSTANDARDCASE se agrupa en IFCWALL');
    check(normalizeText('Tubería') === 'tuberia', 'normalizeText');
  });

  await test('Etiquetas de tipo en español con respaldo legible', async () => {
    check(typeLabel('IFCWALL') === 'Muro' && typeLabelPlural('IFCWALL') === 'Muros', 'muros');
    check(typeLabelPlural('IFCSLAB') === 'Losas' && typeLabelPlural('IFCCOLUMN') === 'Columnas' && typeLabelPlural('IFCBEAM') === 'Vigas', 'básicos');
    check(typeLabelPlural('IFCDOOR') === 'Puertas' && typeLabelPlural('IFCWINDOW') === 'Ventanas' && typeLabelPlural('IFCSTAIR') === 'Escaleras', 'huecos y escaleras');
    check(typeLabelPlural('IFCRAILING') === 'Barandas' && typeLabelPlural('IFCROOF') === 'Techos' && typeLabelPlural('IFCCURTAINWALL') === 'Muros cortina', 'barandas, techos, muros cortina');
    check(typeLabelPlural('IFCSPACE') === 'Espacios' && typeLabelPlural('IFCSANITARYTERMINAL') === 'Aparatos sanitarios' && typeLabelPlural('IFCFLOWTERMINAL') === 'Terminales de flujo', 'espacios y terminales');
    check(typeLabelPlural('IFCPIPESEGMENT') === 'Tuberías' && typeLabelPlural('IFCDUCTSEGMENT') === 'Ductos', 'tuberías y ductos');
    check(humanizeIfcType('IFCDISTRIBUTIONCHAMBERELEMENT') !== '' && typeLabel('IFCMYSTERYTHING') === 'Mysterything', 'respaldo');
    check(typeLabel('IFCFLOWMOVINGDEVICE').length > 0 && categoryType('IFCWALLSTANDARDCASE') === 'IFCWALL', 'categoría');
    check(formatValue(true) === 'Sí' && formatValue(false) === 'No', 'booleanos');
  });
}

// ---------------------------------------------------------------------------------------------
// (b) Pruebas en el navegador
// ---------------------------------------------------------------------------------------------
async function newPage(browser, { routes = {} } = {}) {
  const context = await browser.newContext({ viewport: { width: 1100, height: 760 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  for (const [pattern, body] of Object.entries(routes)) {
    await page.route(pattern, (route) => route.fulfill({ body, contentType: 'application/octet-stream' }));
  }
  await page.goto(`http://127.0.0.1:${PORT}/dev/ifc.html`);
  await waitFor(() => page.evaluate(() => !!window.__t), { timeout: 30000, label: 'sandbox listo' });
  return { context, page, errors };
}

async function browserTests() {
  // Si ya hay un servidor de desarrollo en el puerto (p. ej. lanzado a mano) se reutiliza
  let server = null;
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/dev/ifc.html`);
    if (!r.ok) throw new Error('sin respuesta');
    console.log(`  (se reutiliza el servidor existente en el puerto ${PORT})`);
  } catch {
    server = await startDevServer(PORT);
  }
  const browser = await launchBrowser();
  try {
    // ---------------------------------------------------------------- escenario A: FZK Haus
    section('Navegador: AC20-FZK-Haus.ifc');
    {
      const { context, page, errors } = await newPage(browser);
      const phases = await page.evaluate(async () => {
        const seen = [];
        const t = window.__t;
        const res = await fetch('/fixtures/downloads/AC20-FZK-Haus.ifc');
        const buf = await res.arrayBuffer();
        const model = await t.ifc.load({ id: 'fzk', name: 'FZK', kind: 'ifc', georef: null }, buf, (phase, p) => seen.push(`${phase}:${p.toFixed(2)}`));
        t.store.set('models', { fzk: { visible: true } }, { source: 'system' });
        t.viewer.fitAll();
        return { seen, ready: model.ready };
      });
      await test('carga con progreso de las fases parse y geometry', async () => {
        check(phases.ready, 'modelo listo');
        check(phases.seen.some((s) => s.startsWith('parse:')) && phases.seen.some((s) => s.startsWith('geometry:')), `fases: ${phases.seen.slice(0, 6)}`);
        check(phases.seen.at(-1) === 'geometry:1.00', `última fase ${phases.seen.at(-1)}`);
      });

      await test('tabla de elementos, resumen por categoría e información de proyecto', async () => {
        const r = await page.evaluate(() => {
          const { ifc } = window.__t;
          const m = ifc.getModels()[0];
          const walls = ifc.getTypeSummary().find((s) => s.type === 'IFCWALL');
          return { count: m.table.count, walls, project: ifc.getProjectInfo(), storeys: ifc.getStoreys(), has: ifc.has('fzk'), summary: ifc.getModelSummary('fzk') };
        });
        check(r.summary.elementCount === r.count && r.summary.storeyCount === 2 && r.summary.schema === 'IFC4' && r.summary.triangles > 10000, JSON.stringify(r.summary));
        check(r.count >= 83, `elementos ${r.count}`);
        check(r.walls && r.walls.count === 13 && r.walls.label === 'Muros', `muros ${JSON.stringify(r.walls)}`);
        check(r.project.name === 'Projekt-FZK-Haus' && r.project.schema === 'IFC4' && r.project.buildings.includes('FZK-Haus'), JSON.stringify(r.project));
        check(r.storeys.length === 2, 'niveles');
        near(r.storeys[1].mapHeight - r.storeys[0].mapHeight, 2.7, 1e-6, 'diferencia de niveles');
        near(r.storeys[1].elevation - r.storeys[0].elevation, 2.7, 1e-6, 'elevación en escena');
        check(r.has, 'has()');
      });

      await test('propiedades de un muro incluyen cantidades y materiales', async () => {
        const r = await page.evaluate(async () => {
          const { ifc } = window.__t;
          const m = ifc.getModels()[0];
          let id = null;
          for (let i = 0; i < m.table.count; i++) if (m.table.typeOf(i) === 'IFCWALLSTANDARDCASE') { id = m.table.expressIds[i]; break; }
          const p = await ifc.getProperties('fzk', id);
          return { id, quantities: p.quantities.length, psets: p.psets.length, materials: p.materials, attrs: p.attributes.map((a) => a.name) };
        });
        check(r.quantities > 0 && r.materials.length > 0, JSON.stringify(r));
        check(r.attrs.includes('GlobalId') && r.attrs.includes('Name'), 'atributos');
      });

      await test('los espacios están ocultos salvo display.showSpaces', async () => {
        const r = await page.evaluate(() => {
          const { ifc, actions } = window.__t;
          const m = ifc.getModels()[0];
          const spaceId = m.table.expressIds[[...Array(m.table.count).keys()].find((i) => m.table.typeOf(i) === 'IFCSPACE')];
          ifc.flushStates();
          const before = ifc.getElementState('fzk', spaceId);
          actions.toggleSpaces(true);
          ifc.flushStates();
          const after = ifc.getElementState('fzk', spaceId);
          actions.toggleSpaces(false);
          ifc.flushStates();
          return { before, after };
        });
        check(r.before === 2 && r.after === 0, JSON.stringify(r));
      });

      await test('store.visibility.hiddenTypes oculta tipos (IFCWALL incluye IFCWALLSTANDARDCASE)', async () => {
        const r = await page.evaluate(() => {
          const { ifc, actions } = window.__t;
          const m = ifc.getModels()[0];
          const wallIdx = [...Array(m.table.count).keys()].filter((i) => m.table.typeOf(i) === 'IFCWALLSTANDARDCASE');
          const winIdx = [...Array(m.table.count).keys()].filter((i) => m.table.typeOf(i) === 'IFCWINDOW');
          actions.setTypeHidden('IFCWALL', true);
          ifc.flushStates();
          const hiddenWalls = wallIdx.every((i) => (m.stateData[i * 4] & 7) === 2);
          const windowsVisible = winIdx.every((i) => (m.stateData[i * 4] & 7) === 0);
          actions.showAll();
          ifc.flushStates();
          const restored = wallIdx.every((i) => (m.stateData[i * 4] & 7) === 0);
          return { n: wallIdx.length, hiddenWalls, windowsVisible, restored };
        });
        check(r.n === 13 && r.hiddenWalls && r.windowsVisible && r.restored, JSON.stringify(r));
      });

      await test('selección: seleccionado = 3 y el resto fantasma; modo aislar oculta el resto; resaltar los deja normales', async () => {
        const r = await page.evaluate(() => {
          const { ifc, actions } = window.__t;
          const m = ifc.getModels()[0];
          const visibleIdx = [...Array(m.table.count).keys()].filter((i) => m.table.typeOf(i) !== 'IFCSPACE');
          const wallIdx = visibleIdx.find((i) => m.table.typeOf(i) === 'IFCWALLSTANDARDCASE');
          const wallId = m.table.expressIds[wallIdx];
          const st = (i) => m.stateData[i * 4] & 7;
          actions.select([{ modelId: 'fzk', expressId: wallId }]);
          ifc.flushStates();
          const ghost = visibleIdx.filter((i) => i !== wallIdx).every((i) => st(i) === 1);
          const sel = st(wallIdx);
          actions.setSelectionMode('isolate');
          ifc.flushStates();
          const isolated = visibleIdx.filter((i) => i !== wallIdx).every((i) => st(i) === 2) && st(wallIdx) === 3;
          actions.setSelectionMode('highlight');
          ifc.flushStates();
          const highlight = visibleIdx.filter((i) => i !== wallIdx).every((i) => st(i) === 0);
          actions.setSelectionMode('ghost');
          actions.clearSelection();
          ifc.flushStates();
          const cleared = visibleIdx.every((i) => st(i) === 0);
          return { ghost, sel, isolated, highlight, cleared };
        });
        check(r.ghost && r.sel === 3 && r.isolated && r.highlight && r.cleared, JSON.stringify(r));
      });

      await test('cambio de estado se aplica en el siguiente frame y emite ifc:states-changed', async () => {
        const r = await page.evaluate(async () => {
          const { ifc, actions, bus } = window.__t;
          const m = ifc.getModels()[0];
          let fired = 0;
          bus.on('ifc:states-changed', () => { fired++; });
          const id = m.table.expressIds[0];
          actions.select([{ modelId: 'fzk', expressId: id }]);
          const immediately = m.stateData[0] & 7;
          await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
          const later = m.stateData[0] & 7;
          actions.clearSelection();
          await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
          return { immediately, later, fired };
        });
        check(r.immediately === 0 && r.later === 3 && r.fired >= 1, JSON.stringify(r));
      });

      await test('corte de planta: plano horizontal y niveles superiores ocultos; modo "solo"', async () => {
        const r = await page.evaluate(() => {
          const { ifc, actions, viewer, store } = window.__t;
          const m = ifc.getModels()[0];
          const [s0, s1] = ifc.getStoreys();
          actions.setStorey({ modelId: s0.modelId, expressId: s0.expressId }, 'cut');
          ifc.flushStates();
          const planes = viewer.getClippingPlanes();
          const plane = planes[0];
          const upperIdx = [...Array(m.table.count).keys()].filter((i) => m.table.storeyIdx[i] === 1 && m.table.typeOf(i) !== 'IFCSPACE');
          const lowerIdx = [...Array(m.table.count).keys()].filter((i) => m.table.storeyIdx[i] === 0 && m.table.typeOf(i) !== 'IFCSPACE');
          const st = (i) => m.stateData[i * 4] & 7;
          const upperHidden = upperIdx.every((i) => st(i) === 2);
          const lowerVisible = lowerIdx.every((i) => st(i) === 0);
          // altura del plano en escena = elevación del nivel + cutHeight
          const y = plane.constant; // normal (0,-1,0): y <= constant se conserva
          const expected = s0.elevation + store.get('storey').cutHeight;
          actions.setStorey({ modelId: s1.modelId, expressId: s1.expressId }, 'only');
          ifc.flushStates();
          const onlyPlanes = viewer.getClippingPlanes().length;
          const onlyLowerHidden = lowerIdx.every((i) => st(i) === 2);
          const onlyUpperVisible = upperIdx.every((i) => st(i) === 0);
          actions.setStorey(null);
          ifc.flushStates();
          const cleared = viewer.getClippingPlanes().length === 0 && [...Array(m.table.count).keys()].filter((i) => m.table.typeOf(i) !== 'IFCSPACE').every((i) => st(i) === 0);
          return { planes: planes.length, n: [plane.normal.x, plane.normal.y, plane.normal.z], y, expected, upperHidden, lowerVisible, onlyPlanes, onlyLowerHidden, onlyUpperVisible, cleared, nu: upperIdx.length, nl: lowerIdx.length };
        });
        check(r.planes === 1 && r.n[1] === -1, JSON.stringify(r));
        near(r.y, r.expected, 1e-6, 'altura del plano de corte');
        check(r.upperHidden && r.lowerVisible && r.nu > 0 && r.nl > 0, JSON.stringify(r));
        check(r.onlyPlanes === 0 && r.onlyLowerHidden && r.onlyUpperVisible && r.cleared, JSON.stringify(r));
      });

      await test('picking: el rayo hacia un muro devuelve ese muro; los ocultos se omiten', async () => {
        const r = await page.evaluate(() => {
          const { ifc, viewer, THREE } = window.__t;
          const m = ifc.getModels()[0];
          // un muro exterior visible: el de mayor área proyectada en la dirección de la cámara
          const dir = viewer.camera.position.clone().sub(viewer.controls.target).normalize();
          let best = null;
          for (let i = 0; i < m.table.count; i++) {
            if (m.table.typeOf(i) !== 'IFCWALLSTANDARDCASE') continue;
            const box = m.getElementBoxByIndex(i);
            const c = box.getCenter(new THREE.Vector3());
            // se apunta al centro del elemento; se acepta el primer muro cuyo centro sea el impacto más cercano
            const ndc = c.clone().project(viewer.camera);
            const hit = viewer.pick({ x: ndc.x, y: ndc.y }, { kinds: ['ifc'] });
            if (hit && hit.expressId === m.table.expressIds[i]) { best = { id: m.table.expressIds[i], hit: hit.expressId, kind: hit.kind, model: hit.modelId, dist: hit.distance }; break; }
          }
          return best;
        });
        check(r && r.id === r.hit && r.kind === 'ifc' && r.model === 'fzk' && r.dist > 0, JSON.stringify(r));
        const hidden = await page.evaluate(() => {
          const { ifc, viewer, actions, THREE } = window.__t;
          const m = ifc.getModels()[0];
          const wallIdx = [...Array(m.table.count).keys()].find((i) => m.table.typeOf(i) === 'IFCWALLSTANDARDCASE');
          const box = m.getElementBoxByIndex(wallIdx);
          const ndc = box.getCenter(new THREE.Vector3()).project(viewer.camera);
          const before = viewer.pick({ x: ndc.x, y: ndc.y }, { kinds: ['ifc'] });
          actions.setTypeHidden('IFCWALL', true);
          ifc.flushStates();
          const after = viewer.pick({ x: ndc.x, y: ndc.y }, { kinds: ['ifc'] });
          actions.showAll();
          ifc.flushStates();
          return { before: before && before.expressId, after: after && after.expressId, wall: m.table.expressIds[wallIdx] };
        });
        check(hidden.before !== null && hidden.after !== hidden.wall, JSON.stringify(hidden));
      });

      await test('clic real: selecciona; clic en vacío limpia; Ctrl+clic alterna; doble clic no rompe', async () => {
        const target = await page.evaluate(() => {
          const { ifc, viewer, THREE } = window.__t;
          const m = ifc.getModels()[0];
          for (let i = 0; i < m.table.count; i++) {
            if (m.table.typeOf(i) !== 'IFCWALLSTANDARDCASE') continue;
            const box = m.getElementBoxByIndex(i);
            const c = box.getCenter(new THREE.Vector3());
            const ndc = c.clone().project(viewer.camera);
            const hit = viewer.pick({ x: ndc.x, y: ndc.y }, { kinds: ['ifc'] });
            if (hit && hit.expressId === m.table.expressIds[i]) {
              const p = viewer.projectToClient(c);
              return { id: m.table.expressIds[i], x: p.x, y: p.y };
            }
          }
          return null;
        });
        check(target, 'no hay un muro visible para hacer clic');
        await page.mouse.click(target.x, target.y);
        await page.waitForTimeout(150);
        let sel = await page.evaluate(() => window.__t.store.get('selection').items);
        check(sel.length === 1 && sel[0].expressId === target.id, `selección tras clic: ${JSON.stringify(sel)}`);
        // Ctrl+clic en el mismo elemento lo quita
        await page.keyboard.down('Control');
        await page.mouse.click(target.x, target.y);
        await page.keyboard.up('Control');
        await page.waitForTimeout(150);
        sel = await page.evaluate(() => window.__t.store.get('selection').items);
        check(sel.length === 0, `Ctrl+clic debía alternar: ${JSON.stringify(sel)}`);
        // seleccionar de nuevo y clic en el vacío
        await page.mouse.click(target.x, target.y);
        await page.waitForTimeout(100);
        await page.mouse.click(1090, 740);
        await page.waitForTimeout(150);
        sel = await page.evaluate(() => window.__t.store.get('selection').items);
        check(sel.length === 0, `clic en vacío debía limpiar: ${JSON.stringify(sel)}`);
        // doble clic encuadra (no debe lanzar errores)
        await page.mouse.dblclick(target.x, target.y);
        await page.waitForTimeout(150);
      });

      await test('hover: el puntero sobre un elemento lo marca (estado 4) y fuera lo quita', async () => {
        await page.evaluate(() => { const { actions, viewer } = window.__t; actions.clearSelection(); viewer.fitAll(); });
        await page.waitForTimeout(200);
        const target = await page.evaluate(() => {
          const { ifc, viewer, THREE } = window.__t;
          const m = ifc.getModels()[0];
          for (let i = 0; i < m.table.count; i++) {
            if (m.table.typeOf(i) !== 'IFCWALLSTANDARDCASE') continue;
            const c = m.getElementBoxByIndex(i).getCenter(new THREE.Vector3());
            const ndc = c.clone().project(viewer.camera);
            const hit = viewer.pick({ x: ndc.x, y: ndc.y }, { kinds: ['ifc'] });
            if (hit && hit.expressId === m.table.expressIds[i]) {
              const p = viewer.projectToClient(c);
              return { id: m.table.expressIds[i], x: p.x, y: p.y };
            }
          }
          return null;
        });
        await page.mouse.move(target.x - 3, target.y - 3);
        await page.mouse.move(target.x, target.y);
        await waitFor(() => page.evaluate(() => !!window.__t.store.get('hover')), { timeout: 5000, label: 'hover' });
        await page.waitForTimeout(150);
        const r = await page.evaluate(() => {
          const { ifc, store } = window.__t;
          const h = store.get('hover');
          return { h, state: ifc.getElementState(h.modelId, h.expressId) };
        });
        check(r.h.expressId === target.id && r.state === 4, JSON.stringify(r));
        await page.mouse.move(1090, 740);
        await waitFor(() => page.evaluate(() => !window.__t.store.get('hover')), { timeout: 5000, label: 'hover fuera' });
        await page.waitForTimeout(150);
        const st = await page.evaluate((id) => window.__t.ifc.getElementState('fzk', id), target.id);
        check(st === 0, `estado tras salir: ${st}`);
      });

      await test('color de sobrescritura (setElementColors) y búsqueda', async () => {
        const r = await page.evaluate(() => {
          const { ifc, actions } = window.__t;
          const m = ifc.getModels()[0];
          const id = m.table.expressIds[2];
          ifc.setElementColors('fzk', new Map([[id, '#10c81e']]));
          ifc.flushStates();
          const o = 2 * 4;
          const withColor = { code: m.stateData[o], r: m.stateData[o + 1], g: m.stateData[o + 2], b: m.stateData[o + 3] };
          ifc.setElementColors('fzk', null);
          ifc.flushStates();
          const without = m.stateData[o];
          const found = ifc.search('Haustuer');
          const byGuid = ifc.findByGlobalId(m.table.globalIds[2]);
          return { withColor, without, found: found.length, byGuid, id };
        });
        check((r.withColor.code & 128) !== 0 && r.withColor.r === 0x10 && r.withColor.g === 0xc8 && r.withColor.b === 0x1e, JSON.stringify(r.withColor));
        check((r.without & 128) === 0, 'la sobrescritura debe poder quitarse');
        check(r.found >= 1 && r.byGuid && r.byGuid.expressId === r.id, JSON.stringify(r));
      });

      await test('descarga: unload elimina el modelo y libera el worker', async () => {
        const r = await page.evaluate(() => {
          const { ifc, viewer } = window.__t;
          ifc.unload('fzk');
          return { has: ifc.has('fzk'), models: ifc.getModels().length, children: viewer.modelsRoot.children.length, origin: viewer.worldOrigin.origin };
        });
        check(!r.has && r.models === 0 && r.children === 0 && r.origin === null, JSON.stringify(r));
      });

      await test('sin errores de consola ni de página', async () => {
        check(errors.length === 0, errors.join(' | '));
      });
      await context.close();
    }

    // ---------------------------------------------------------------- escenario B: dos IFC georreferenciados
    section('Navegador: IFC4 con IfcMapConversion + IFC2x3 con IfcSite en UTM');
    {
      const { context, page, errors } = await newPage(browser);
      const idA = 'geo4';
      const idB = 'site23';
      await page.evaluate(async () => {
        const { loadUrl } = window.__t;
        await loadUrl('/fixtures/edificio_georef_ifc4.ifc', { id: 'geo4', name: 'georef4' });
        await loadUrl('/fixtures/edificio_site_ifc2x3.ifc', { id: 'site23', name: 'site23' });
      });

      await test('georreferencia por modelo y origen global en UTM', async () => {
        const r = await page.evaluate(() => {
          const { ifc, viewer } = window.__t;
          return { a: ifc.getGeorefInfo('geo4'), b: ifc.getGeorefInfo('site23'), origin: viewer.worldOrigin.origin };
        });
        check(r.a.source === 'mapconversion' && r.a.crs === 'EPSG:32718', JSON.stringify(r.a));
        near(r.a.eastings, 279500, 1e-6, 'E'); near(r.a.northings, 8661000, 1e-6, 'N'); near(r.a.height, 150, 1e-6, 'H');
        near(r.a.rotationDeg, 15, 1e-9, 'rotación'); near(r.a.scale, 1, 1e-12, 'escala');
        check(r.b.source === 'site', JSON.stringify(r.b));
        check(r.origin && Math.abs(r.origin.e - 279500) < 5 && Math.abs(r.origin.n - 8661000) < 5, JSON.stringify(r.origin));
      });

      await test('niveles: 2 por modelo, 3 m de separación, cotas de mapa 150 y 153; elevación base', async () => {
        const r = await page.evaluate(() => {
          const { ifc } = window.__t;
          return { storeys: ifc.getStoreys(), base: ifc.getBaseElevation(), a: ifc.getModels()[0].getStoreys() };
        });
        check(r.storeys.length === 4, `niveles ${r.storeys.length}`);
        check(r.a.length === 2 && r.a[0].name === 'Nivel 1' && r.a[1].name === 'Nivel 2', JSON.stringify(r.a));
        near(r.a[1].elevation - r.a[0].elevation, 3, 1e-6, 'separación en escena');
        near(r.a[0].mapHeight, 150, 1e-6, 'cota nivel 1'); near(r.a[1].mapHeight, 153, 1e-6, 'cota nivel 2');
        near(r.base, 150, 1e-6, 'cota base');
        check(r.a.every((s) => s.elementCount === 10), 'elementos por nivel');
      });

      await test('alineación: los elementos homónimos de ambos IFC coinciden en la escena (<= 1 cm)', async () => {
        const r = await page.evaluate(() => {
          const { ifc } = window.__t;
          const out = [];
          for (const name of ['Muro Nivel 1 M01', 'Muro Nivel 2 M03', 'Losa Nivel 1', 'Ventana Nivel 2', 'Mueble Nivel 1 2']) {
            const hits = ifc.search(name, 10).filter((h) => h.name === name);
            const a = hits.find((h) => h.modelId === 'geo4');
            const b = hits.find((h) => h.modelId === 'site23');
            const ba = ifc.getBoxOf([{ modelId: a.modelId, expressId: a.expressId }]);
            const bb = ifc.getBoxOf([{ modelId: b.modelId, expressId: b.expressId }]);
            const d = Math.max(...[ba.min.x - bb.min.x, ba.min.y - bb.min.y, ba.min.z - bb.min.z, ba.max.x - bb.max.x, ba.max.y - bb.max.y, ba.max.z - bb.max.z].map(Math.abs));
            out.push({ name, d });
          }
          return out;
        });
        for (const x of r) check(x.d <= 0.01, `${x.name}: desfase ${x.d.toFixed(4)} m`);
      });

      await test('cajas del modelo: con rotación del IfcMapConversion getModelBox es exacta (coincide con el IFC2x3 y con la unión de elementos)', async () => {
        const r = await page.evaluate(() => {
          const { ifc } = window.__t;
          const boxOf = (id) => {
            const b = ifc.getModelBox(id);
            return [b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z];
          };
          const unionOf = (id) => {
            const m = ifc.getModel(id);
            const items = [];
            for (let i = 0; i < m.table.count; i++) items.push({ modelId: id, expressId: m.table.expressIds[i] });
            const b = ifc.getBoxOf(items);
            return [b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z];
          };
          return { geo4: boxOf('geo4'), site23: boxOf('site23'), union4: unionOf('geo4'), rot: ifc.getModel('geo4').group.rotation.y };
        });
        const d = (a, b) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));
        check(Math.abs(r.rot) > 0.2, `el IFC4 debe estar girado (rotación ${r.rot})`);
        check(d(r.geo4, r.site23) <= 0.01, `cajas de los dos IFC difieren ${(d(r.geo4, r.site23) * 100).toFixed(2)} cm`);
        check(d(r.geo4, r.union4) <= 0.01, `getModelBox difiere de la unión de elementos ${(d(r.geo4, r.union4) * 100).toFixed(2)} cm`);
      });

      await test('búsqueda: por nombre, tipo en español y GlobalId (sin mayúsculas ni acentos)', async () => {
        const r = await page.evaluate(() => {
          const { ifc } = window.__t;
          return {
            muros: ifc.search('MURO NIVEL 1').length,
            ventana: ifc.search('ventanas').length,
            guid: ifc.search('1UnJUTA6f0$9v425NGG3u7'),
            found: ifc.findByGlobalId('1UnJUTA6f0$9v425NGG3u7'),
          };
        });
        check(r.muros >= 8, `muros ${r.muros}`);
        check(r.ventana >= 4, `ventanas ${r.ventana}`);
        check(r.guid.length === 1 && r.guid[0].name === 'Muro Nivel 1 M01' && r.found.expressId === 70, JSON.stringify(r));
      });

      await test('propiedades del muro incluyen Pset_WallCommon y CT_Partida', async () => {
        const p = await page.evaluate(async () => window.__t.ifc.getProperties('geo4', 70));
        const names = p.psets.map((x) => x.name);
        check(names.includes('Pset_WallCommon') && names.includes('CT_Partida'), `psets: ${names}`);
        check(p.psets.find((x) => x.name === 'CT_Partida').props.some((x) => x.name === 'Codigo' && x.value === '02.01.01'), 'Codigo');
      });

      await test('selección con dos modelos: seleccionado 3, el resto fantasma en ambos; picking devuelve el muro', async () => {
        const r = await page.evaluate(() => {
          const { ifc, actions, viewer, THREE } = window.__t;
          const a = ifc.getModel('geo4');
          const b = ifc.getModel('site23');
          const wallIdxA = a.table.indexOf(70);
          actions.select([{ modelId: 'geo4', expressId: 70 }]);
          ifc.flushStates();
          const stA = (i) => a.stateData[i * 4] & 7;
          const stB = (i) => b.stateData[i * 4] & 7;
          const onlyOneSel = stA(wallIdxA) === 3;
          const othersA = [...Array(a.table.count).keys()].filter((i) => i !== wallIdxA).every((i) => stA(i) === 1);
          const othersB = [...Array(b.table.count).keys()].every((i) => stB(i) === 1);
          actions.clearSelection();
          ifc.flushStates();
          // picking al muro: se mira un punto del muro a 20% de su longitud (evita la ventana)
          const box = a.table.boxOf(wallIdxA);
          const local = new THREE.Vector3(box[0] + (box[3] - box[0]) * 0.2, (box[1] + box[4]) / 2, (box[2] + box[5]) / 2);
          const world = local.clone().applyMatrix4(a.group.matrixWorld);
          viewer.fitAll();
          const ndc = world.clone().project(viewer.camera);
          const hits = viewer.pickAll({ x: ndc.x, y: ndc.y }, { kinds: ['ifc'] });
          return { onlyOneSel, othersA, othersB, hit: hits[0] && { modelId: hits[0].modelId, expressId: hits[0].expressId }, n: hits.length };
        });
        check(r.onlyOneSel && r.othersA && r.othersB, JSON.stringify(r));
        // los dos modelos son coincidentes: el primer impacto es el muro de cualquiera de los dos
        check(r.hit && r.hit.expressId !== undefined && r.n >= 1, JSON.stringify(r));
      });

      await test('updateGeoref reubica sin recargar y se restaura con null', async () => {
        const r = await page.evaluate(() => {
          const { ifc, viewer } = window.__t;
          const m = ifc.getModel('geo4');
          const boxBefore = ifc.getModelBox('geo4');
          const posBefore = m.group.position.clone();
          ifc.updateGeoref('geo4', { eastings: 279510, northings: 8661020, height: 160, rotationDeg: 45, scale: 1 });
          const info = ifc.getGeorefInfo('geo4');
          const posMid = m.group.position.clone();
          const rot = m.group.rotation.y;
          const boxMid = ifc.getModelBox('geo4');
          ifc.updateGeoref('geo4', null);
          const infoAfter = ifc.getGeorefInfo('geo4');
          const posAfter = m.group.position.clone();
          const boxAfter = ifc.getModelBox('geo4');
          return {
            infoSource: info.source, infoRot: info.rotationDeg, rotY: rot, afterSource: infoAfter.source,
            moved: posMid.distanceTo(posBefore), back: posAfter.distanceTo(posBefore),
            boxMoved: Math.abs(boxMid.min.y - boxBefore.min.y), boxBack: Math.abs(boxAfter.min.y - boxBefore.min.y) + Math.abs(boxAfter.min.x - boxBefore.min.x),
            origin: viewer.worldOrigin.origin,
          };
        });
        check(r.infoSource === 'manual' && Math.abs(r.infoRot - 45) < 1e-9 && Math.abs(r.rotY - Math.PI / 4) < 1e-9, JSON.stringify(r));
        check(r.moved > 5 && r.back < 1e-9 && r.afterSource === 'mapconversion', JSON.stringify(r));
        check(r.boxMoved > 5 && r.boxBack < 1e-6, JSON.stringify(r));
      });

      await test('sin errores de consola ni de página', async () => {
        check(errors.length === 0, errors.join(' | '));
      });
      await context.close();
    }

    // ---------------------------------------------------------------- escenario D: render real con estados
    section('Navegador: render con estados (píxeles del canvas)');
    {
      const { context, page, errors } = await newPage(browser);
      await page.evaluate(async () => { await window.__t.loadUrl('/fixtures/edificio_georef_ifc4.ifc', { id: 'geo4' }); });
      const measure = () => page.evaluate(() => {
        const { viewer, ifc } = window.__t;
        ifc.flushStates();
        viewer._render();
        const c = viewer.canvas;
        const tmp = document.createElement('canvas');
        tmp.width = c.width; tmp.height = c.height;
        const g = tmp.getContext('2d');
        g.drawImage(c, 0, 0);
        const d = g.getImageData(0, 0, tmp.width, tmp.height).data;
        let tinted = 0; let brown = 0; let bg = 0; let diff = 0;
        for (let i = 0; i < d.length; i += 4) {
          const r = d[i]; const gg = d[i + 1]; const b = d[i + 2];
          diff += Math.abs(r - 238) + Math.abs(gg - 238) + Math.abs(b - 237);
          if (Math.abs(r - 238) < 4 && Math.abs(gg - 238) < 4 && Math.abs(b - 237) < 4) { bg++; continue; }
          if (r > 150 && r - b > 35) tinted++;
          else if (r - b > 40 && r < 150) brown++;
        }
        return { tinted, brown, bg, diff };
      });
      const px = {};
      px.initial = await measure();
      await page.evaluate(() => window.__t.actions.select([{ modelId: 'geo4', expressId: 70 }]));
      px.ghost = await measure();
      await page.evaluate(() => window.__t.actions.setSelectionMode('isolate'));
      px.isolate = await measure();
      await page.evaluate(() => window.__t.actions.setSelectionMode('ghost'));
      await page.evaluate(() => window.__t.actions.setGhostOpacity(0));
      px.ghost0 = await measure();
      await page.evaluate(() => window.__t.actions.setGhostOpacity(0.6));
      px.ghost60 = await measure();
      await page.evaluate(() => { window.__t.actions.setGhostOpacity(0.12); window.__t.actions.clearSelection(); window.__t.actions.setTypeHidden('IFCWALL', true); });
      px.noWalls = await measure();

      await test('el color original se ve sin selección y el elemento seleccionado se tiñe de naranja', async () => {
        check(px.initial.tinted < 50 && px.initial.brown > 1500, JSON.stringify(px.initial));
        check(px.ghost.tinted > 10000, `píxeles teñidos con selección: ${px.ghost.tinted}`);
      });
      await test('modo fantasma: el resto pierde su color (mobiliario casi invisible); aislar deja sólo el seleccionado', async () => {
        check(px.ghost.brown < px.initial.brown * 0.3, `mobiliario ${px.ghost.brown} vs ${px.initial.brown}`);
        check(px.isolate.bg > px.ghost.bg + 50000, `fondo ${px.isolate.bg} vs ${px.ghost.bg}`);
      });
      await test('la opacidad del fantasma controla cuánto se ve el resto', async () => {
        // con opacidad 0 sólo quedan las aristas tenues de los fantasmas
        check(px.ghost0.bg > px.ghost.bg + 3000 && px.ghost0.bg >= px.isolate.bg - 40000, `opacidad 0: ${px.ghost0.bg}, 0.12: ${px.ghost.bg}, aislado: ${px.isolate.bg}`);
        check(px.ghost0.diff < px.ghost.diff && px.ghost60.diff > px.ghost.diff * 1.2, `diferencia con el fondo: 0=${px.ghost0.diff}, 0.12=${px.ghost.diff}, 0.6=${px.ghost60.diff}`);
      });
      await test('ocultar un tipo quita sus píxeles; las aristas y los lotes fantasma respetan el estado', async () => {
        check(px.noWalls.tinted === 0 && px.noWalls.bg > px.initial.bg + 10000, JSON.stringify(px.noWalls));
        const r = await page.evaluate(() => {
          const { ifc, actions } = window.__t;
          const m = ifc.getModel('geo4');
          actions.showAll();
          actions.clearSelection();
          ifc.flushStates();
          const ghostHidden = m._batches.every((b) => b.ghostMesh.visible === false);
          actions.select([{ modelId: 'geo4', expressId: 70 }]);
          ifc.flushStates();
          const ghostVisible = m._batches.every((b) => b.ghostMesh.visible === true);
          actions.toggleEdges(false);
          const edgesOff = m._edgeMeshes.length > 0 && m._edgeMeshes.every((e) => e.visible === false);
          actions.toggleEdges(true);
          const edgesOn = m._edgeMeshes.every((e) => e.visible === true);
          actions.clearSelection();
          actions.setModelVisible('geo4', false);
          const groupHidden = m.group.visible === false;
          const pickWhenHidden = window.__t.viewer.pick({ x: 0, y: 0 }, { kinds: ['ifc'] });
          actions.setModelVisible('geo4', true);
          return { ghostHidden, ghostVisible, edgesOff, edgesOn, groupHidden, pickWhenHidden: pickWhenHidden === null, opacity: m.uniforms.uGhostOpacity.value };
        });
        check(r.ghostHidden && r.ghostVisible && r.edgesOff && r.edgesOn && r.groupHidden && r.pickWhenHidden, JSON.stringify(r));
        near(r.opacity, 0.12, 1e-9, 'uniforme de opacidad del fantasma');
      });

      await test('archivo inválido: se rechaza con un mensaje claro y el visor sigue funcionando', async () => {
        const r = await page.evaluate(async () => {
          const { ifc, loadUrl } = window.__t;
          let message = '';
          try {
            await ifc.load({ id: 'malo', name: 'malo.ifc', kind: 'ifc' }, new TextEncoder().encode('esto no es un IFC').buffer);
          } catch (err) {
            message = err.message;
          }
          const stillThere = ifc.has('malo');
          await loadUrl('/fixtures/edificio_site_ifc2x3.ifc', { id: 'despues', fit: false });
          return { message, stillThere, after: ifc.getModel('despues').table.count };
        });
        check(/IFC/.test(r.message) && !r.stillThere && r.after === 20, JSON.stringify(r));
      });

      await test('modelo sin geometría: carga sin error y sin cajas', async () => {
        const r = await page.evaluate(async () => {
          const { ifc } = window.__t;
          const txt = "ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n#1=IFCPROJECT('3weeWyvIb0$9hRbA4iwBg0',$,'Vacío',$,$,$,$,$,$);\nENDSEC;\nEND-ISO-10303-21;\n";
          const m = await ifc.load({ id: 'vacio', name: 'vacio.ifc', kind: 'ifc' }, new TextEncoder().encode(txt).buffer);
          const res = { ready: m.ready, box: ifc.getModelBox('vacio'), count: m.table.count, tree: ifc.getSpatialTree('vacio').type };
          ifc.unload('vacio');
          return res;
        });
        check(r.ready && r.box === null && r.count === 0 && r.tree === 'IFCPROJECT', JSON.stringify(r));
      });

      await test('sin errores de consola ni de página', async () => {
        // el error del archivo inválido se informa como excepción (no como error de consola del worker)
        check(errors.length === 0, errors.join(' | '));
      });
      await context.close();
    }

    // ---------------------------------------------------------------- escenario E: modo presentación y cancelación
    section('Navegador: estado remoto antes de que cargue el modelo y descarga durante la carga');
    {
      const big = makeBigIfc(6000, 500);
      const { context, page, errors } = await newPage(browser, { routes: { '**/big/model.ifc': Buffer.from(big) } });
      await test('el estado que llega antes que el modelo (presentación) se aplica al terminar de cargar', async () => {
        const r = await page.evaluate(async () => {
          const { store, ifc, actions, loadUrl } = window.__t;
          // Estado remoto: selección de un elemento, modo aislar, tipo oculto y nivel activo
          store.setMany({
            selection: { items: [{ modelId: 'geo4', expressId: 70 }] },
            display: { ...store.get('display'), selectionMode: 'isolate' },
            visibility: { hidden: {}, isolated: null, hiddenTypes: ['IFCCOLUMN'] },
          }, { source: 'remote' });
          await loadUrl('/fixtures/edificio_georef_ifc4.ifc', { id: 'geo4' });
          const m = ifc.getModel('geo4');
          const st = (id) => m.stateData[m.table.indexOf(id) * 4] & 7;
          const out = { wall: st(70), other: st(101), column: st(194) };
          store.setMany({ selection: { items: [] }, visibility: { hidden: {}, isolated: null, hiddenTypes: [] } }, { source: 'remote' });
          actions.setSelectionMode('ghost');
          ifc.flushStates();
          return out;
        });
        check(r.wall === 3 && r.other === 2 && r.column === 2, JSON.stringify(r));
      });

      await test('descargar un modelo mientras se carga lo cancela sin dejar restos', async () => {
        const r = await page.evaluate(async () => {
          const { ifc, viewer } = window.__t;
          const res = await fetch('/big/model.ifc');
          const buf = await res.arrayBuffer();
          const p = ifc.load({ id: 'cancelado', name: 'cancelado.ifc', kind: 'ifc' }, buf);
          const t0 = performance.now();
          while (!ifc.has('cancelado') && performance.now() - t0 < 20000) await new Promise((r2) => setTimeout(r2, 5));
          const sawFrame = ifc.has('cancelado');
          ifc.unload('cancelado');
          let message = '';
          try { await p; } catch (err) { message = err.message; }
          await new Promise((r2) => setTimeout(r2, 300));
          return { sawFrame, message, has: ifc.has('cancelado'), children: viewer.modelsRoot.children.length, origin: viewer.worldOrigin.origin };
        });
        check(r.sawFrame && /cancelada/i.test(r.message) && !r.has, JSON.stringify(r));
        check(r.children === 1, `quedan ${r.children} modelos en la escena (debe quedar sólo geo4)`);
      });

      await test('después de la cancelación se puede cargar otro modelo con normalidad', async () => {
        const r = await page.evaluate(async () => {
          const m = await window.__t.loadUrl('/fixtures/edificio_site_ifc2x3.ifc', { id: 'otro', fit: false });
          return { ready: m.ready, count: m.table.count };
        });
        check(r.ready && r.count === 20, JSON.stringify(r));
      });

      await test('sin errores de consola ni de página', async () => {
        check(errors.length === 0, errors.join(' | '));
      });
      await context.close();
    }

    // ---------------------------------------------------------------- escenario F: georreferencia manual y origen global
    section('Navegador: sobrescritura manual de georreferencia y origen global');
    {
      const { context, page, errors } = await newPage(browser);
      await page.evaluate(async () => { await window.__t.loadUrl('/fixtures/edificio_georef_ifc4.ifc', { id: 'geo4' }); });
      await test('pasar a coordenadas locales reubica el origen global; restaurar vuelve a UTM sin perder precisión', async () => {
        const r = await page.evaluate(() => {
          const { ifc, viewer } = window.__t;
          const m = ifc.getModel('geo4');
          const events = [];
          window.__t.bus.on('origin:changed', (e) => events.push(e.origin));
          const pos0 = m.group.position.length();
          ifc.updateGeoref('geo4', { eastings: 10, northings: 20, height: 5, rotationDeg: 0, scale: 1 });
          const local = { source: ifc.getGeorefInfo('geo4').source, geo: ifc.getGeorefInfo('geo4').georeferenced, pos: m.group.position.length(), origin: { ...viewer.worldOrigin.origin } };
          ifc.updateGeoref('geo4', null);
          const back = { source: ifc.getGeorefInfo('geo4').source, geo: ifc.getGeorefInfo('geo4').georeferenced, pos: m.group.position.length(), origin: { ...viewer.worldOrigin.origin } };
          ifc.updateGeoref('geo4', { eastings: 279500, northings: 8661000, height: 150, rotationDeg: 15, scale: 2 });
          const box2 = ifc.getModelBox('geo4');
          ifc.updateGeoref('geo4', null);
          const box1 = ifc.getModelBox('geo4');
          return { pos0, local, back, events: events.length, sizeRatio: box2.getSize(new window.__t.THREE.Vector3()).y / box1.getSize(new window.__t.THREE.Vector3()).y };
        });
        check(r.local.source === 'manual' && !r.local.geo && r.local.pos < 100 && Math.abs(r.local.origin.e - 10) < 1, JSON.stringify(r.local));
        check(r.back.source === 'mapconversion' && r.back.geo && r.back.pos < 100 && Math.abs(r.back.origin.e - 279500) < 5, JSON.stringify(r.back));
        check(r.events >= 2, `eventos origin:changed: ${r.events}`);
        near(r.sizeRatio, 2, 1e-6, 'escala manual duplica la altura del modelo');
      });
      await test('sin errores de consola ni de página', async () => {
        check(errors.length === 0, errors.join(' | '));
      });
      await context.close();
    }

    // ---------------------------------------------------------------- escenario C: escalabilidad
    section('Navegador: modelo sintético grande (carga progresiva, worker, UI fluida)');
    {
      const big = makeBigIfc(9000, 500);
      const { context, page, errors } = await newPage(browser, { routes: { '**/big/model.ifc': Buffer.from(big) } });
      const info = await page.evaluate(async () => {
        const t = window.__t;
        let maxGap = 0;
        let last = performance.now();
        const iv = setInterval(() => { const n = performance.now(); maxGap = Math.max(maxGap, n - last - 20); last = n; }, 20);
        const chunkCounts = [];
        const model0 = performance.now();
        t.bus.on('ifc:states-changed', () => chunkCounts.push(Math.round(performance.now() - model0)));
        const phases = new Set();
        const res = await fetch('/big/model.ifc');
        const buf = await res.arrayBuffer();
        const m = await t.ifc.load({ id: 'big', name: 'big', kind: 'ifc', georef: null }, buf, (ph) => phases.add(ph));
        clearInterval(iv);
        t.store.set('models', { big: { visible: true } }, { source: 'system' });
        t.viewer.fitAll();
        return {
          maxGap, count: m.table.count, batches: m._batches.length, statesEvents: chunkCounts.length, phases: [...phases],
          bufDetached: buf.byteLength, ms: Math.round(performance.now() - model0), storeys: m.storeys.length, stats: m.stats,
        };
      });
      console.log(`       (9000 elementos: ${info.ms} ms, ${info.stats.triangles} triángulos, mayor bloqueo del hilo principal ${Math.round(info.maxGap)} ms, ${info.batches} lotes)`);

      await test('carga completa con varios fragmentos y el ArrayBuffer se transfiere al worker', async () => {
        check(info.count === 9000, `elementos ${info.count}`);
        check(info.batches >= 2 && info.statesEvents >= 2, `fragmentos ${info.batches}/${info.statesEvents}`);
        check(info.bufDetached === 0, 'el ArrayBuffer debe haberse transferido');
        check(info.phases.includes('parse') && info.phases.includes('geometry'), info.phases.join(','));
        check(info.storeys === 18, `niveles ${info.storeys}`);
      });

      await test('el hilo principal no se congela durante la carga (< 1.5 s de bloqueo)', async () => {
        check(info.maxGap < 1500, `bloqueo de ${Math.round(info.maxGap)} ms`);
      });

      await test('selección y picking sobre el modelo grande', async () => {
        const r = await page.evaluate(() => {
          const { ifc, actions, viewer, THREE } = window.__t;
          const m = ifc.getModel('big');
          const t0 = performance.now();
          actions.select([{ modelId: 'big', expressId: m.table.expressIds[1234] }]);
          ifc.flushStates();
          const tSel = performance.now() - t0;
          const sel = m.stateData[1234 * 4] & 7;
          const ghost = m.stateData[0] & 7;
          const c = m.getElementBoxByIndex(1234).getCenter(new THREE.Vector3());
          const ndc = c.clone().project(viewer.camera);
          const hit = viewer.pick({ x: ndc.x, y: ndc.y }, { kinds: ['ifc'] });
          actions.clearSelection();
          ifc.flushStates();
          return { tSel, sel, ghost, hit: hit && hit.expressId, id: m.table.expressIds[1234] };
        });
        check(r.sel === 3 && r.ghost === 1 && r.tSel < 250, JSON.stringify(r));
        check(r.hit !== null, 'el picking debe devolver algún elemento en el centro del elemento');
      });

      await test('sin errores de consola ni de página', async () => {
        check(errors.length === 0, errors.join(' | '));
      });
      await context.close();
    }
  } finally {
    await browser.close();
    if (server) await new Promise((res) => server.close(res));
  }
}

// ---------------------------------------------------------------------------------------------
async function main() {
  const t0 = Date.now();
  try {
    await nodeTests();
  } catch (err) {
    results.push({ ok: false, name: 'Node (error inesperado)', err });
    console.log(`  FAIL Node: ${err.stack}`);
  }
  try {
    await browserTests();
  } catch (err) {
    results.push({ ok: false, name: 'Navegador (error inesperado)', err });
    console.log(`  FAIL Navegador: ${err.stack}`);
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} pruebas correctas en ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  if (failed.length) {
    console.log('Fallidas:');
    for (const f of failed) console.log(` - ${f.name}: ${f.err.message}`);
    process.exit(1);
  }
  process.exit(0);
}

main();
