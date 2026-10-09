// Normalizador DWG: DwgDatabase de @mlightcad/libredwg-web → formato intermedio (IR).
// Ver la descripción del IR en normalizeDxf.js. Módulo puro (no importa libredwg-web).

import {
  num, p3, ext3, flatVertices, countSkipped, MODEL_SPACE_RE, isSpaceBlock,
} from './irUtil.js';
import { cleanPlainText, parseMtext } from './textFormat.js';

const TWO_PI = Math.PI * 2;

function base(t, e) {
  const aciRaw = e.colorIndex;
  const aci = aciRaw === undefined || aciRaw === null ? 256 : Math.abs(Math.trunc(aciRaw));
  const rgb = Number.isFinite(e.color) ? e.color & 0xffffff : null;
  return { t, layer: e.layer || '0', aci, rgb };
}

// Lazos de un HATCH de libredwg-web → aristas del IR
function mapHatchLoops(paths) {
  const loops = [];
  for (const path of paths || []) {
    if (Array.isArray(path.vertices) && !Array.isArray(path.edges)) {
      const pts = [];
      for (const v of path.vertices) pts.push(num(v.x), num(v.y), num(v.bulge));
      loops.push([{ k: 'P', pts, closed: path.isClosed !== false }]);
      continue;
    }
    const edges = [];
    for (const ed of path.edges || []) {
      switch (ed.type) {
        case 1:
          edges.push({ k: 'L', a: [num(ed.start?.x), num(ed.start?.y)], b: [num(ed.end?.x), num(ed.end?.y)] });
          break;
        case 2:
          edges.push({
            k: 'A',
            c: [num(ed.center?.x), num(ed.center?.y)],
            r: num(ed.radius),
            a0: num(ed.startAngle),
            a1: num(ed.endAngle, TWO_PI),
            ccw: ed.isCCW !== false,
          });
          break;
        case 3: {
          // `end` es el extremo del eje mayor relativo al centro; lengthOfMinorAxis es la razón menor/mayor
          const mx = num(ed.end?.x);
          const my = num(ed.end?.y);
          const mlen = Math.hypot(mx, my) || 1;
          let ratio = num(ed.lengthOfMinorAxis, 1);
          if (ratio > 1) ratio = ratio / mlen; // algunas versiones lo entregan como longitud absoluta
          edges.push({
            k: 'E',
            c: [num(ed.center?.x), num(ed.center?.y)],
            major: [mx, my],
            ratio,
            a0: num(ed.startAngle),
            a1: num(ed.endAngle, TWO_PI),
            ccw: ed.isCCW !== false,
          });
          break;
        }
        case 4: {
          const ctrl = [];
          const weights = [];
          let rational = false;
          for (const q of ed.controlPoints || []) {
            ctrl.push(num(q.x), num(q.y));
            if (q.weight !== undefined && q.weight !== 1) rational = true;
            weights.push(num(q.weight, 1));
          }
          const fit = [];
          for (const q of ed.fitDatum || []) fit.push(num(q.x), num(q.y));
          edges.push({
            k: 'S', degree: num(ed.degree, 3), knots: ed.knots || [], ctrl, weights: rational ? weights : null, fit,
          });
          break;
        }
        default:
          break;
      }
    }
    loops.push(edges);
  }
  return loops;
}

export function normalizeDwg(db) {
  const stats = { skipped: {} };
  const header = db.header || {};

  const ir = {
    format: 'dwg',
    version: header.ACADVER || '',
    insunits: num(header.INSUNITS, 0),
    headerExtents: {
      min: header.EXTMIN ? p3(header.EXTMIN) : null,
      max: header.EXTMAX ? p3(header.EXTMAX) : null,
    },
    layers: [],
    blocks: {},
    entities: [],
    stats,
  };

  // --- Capas ---
  for (const l of db.tables?.LAYER?.entries || []) {
    const idx = Math.trunc(num(l.colorIndex, 256));
    const aci = idx >= 1 && idx <= 255 ? idx : 7;
    // libredwg-web entrega color verdadero de capa en `color` solo si colorIndex = 256 y color ≠ blanco por defecto
    let rgb = null;
    if (idx === 256 && Number.isFinite(l.color) && (l.color & 0xffffff) !== 0xffffff) rgb = l.color & 0xffffff;
    ir.layers.push({ name: l.name, aci, rgb, off: !!l.off, frozen: !!l.frozen });
  }

  // --- Entidades ---
  function mapText(t, e, kind) {
    // `t` es la parte textual (TEXT: la propia entidad; ATTRIB: e.text)
    const s = cleanPlainText(t.text);
    if (!s) return null;
    const hasAlign = t.endPoint && (num(t.endPoint.x) !== 0 || num(t.endPoint.y) !== 0);
    const gen = num(t.generationFlag, 0);
    return {
      ...base('TEXT', e),
      s,
      p: [num(t.startPoint?.x), num(t.startPoint?.y), num(t.startPoint?.z)],
      p2: hasAlign ? [num(t.endPoint.x), num(t.endPoint.y), num(t.endPoint.z)] : null,
      h: num(t.textHeight, 1),
      rot: num(t.rotation),
      wf: num(t.xScale, 1) || 1,
      obl: num(t.obliqueAngle),
      ha: Math.trunc(num(t.halign)),
      va: Math.trunc(num(t.valign)),
      ext: ext3(t.extrusionDirection),
      back: (gen & 2) !== 0,
      up: (gen & 4) !== 0,
      kind,
    };
  }

  function mapEntity(e, out) {
    if (!e || e.isVisible === false || e.isInPaperSpace) return;
    switch (e.type) {
      case 'LINE':
        out.push({ ...base('LINE', e), a: p3(e.startPoint), b: p3(e.endPoint) });
        return;
      case 'LWPOLYLINE': {
        const v = e.vertices || [];
        if (v.length < 2) return;
        out.push({
          ...base('POLY', e),
          pts: flatVertices(v, num(e.elevation)),
          closed: (num(e.flag) & 512) !== 0,
          ext: ext3(e.extrusionDirection),
          is3d: false,
        });
        return;
      }
      case 'POLYLINE2D':
      case 'POLYLINE3D':
      case 'POLYLINE': {
        let v = e.vertices || [];
        if (v.length < 2) return;
        // Puntos de control de spline (bandera 16) no forman parte de la curva
        if (v.some((x) => (num(x.flag) & 8) !== 0)) v = v.filter((x) => (num(x.flag) & 16) === 0);
        const is3d = e.type === 'POLYLINE3D';
        out.push({
          ...base('POLY', e),
          pts: flatVertices(v, num(e.elevation)),
          closed: (num(e.flag) & 1) !== 0,
          ext: is3d ? null : ext3(e.extrusionDirection),
          is3d,
        });
        return;
      }
      case 'CIRCLE':
        if (!(e.radius > 0)) return;
        out.push({ ...base('CIRCLE', e), c: p3(e.center), r: e.radius, ext: ext3(e.extrusionDirection) });
        return;
      case 'ARC':
        if (!(e.radius > 0)) return;
        out.push({
          ...base('ARC', e), c: p3(e.center), r: e.radius, a0: num(e.startAngle), a1: num(e.endAngle, TWO_PI), ext: ext3(e.extrusionDirection),
        });
        return;
      case 'ELLIPSE':
        out.push({
          ...base('ELLIPSE', e),
          c: p3(e.center),
          major: p3(e.majorAxisEndPoint),
          ratio: num(e.axisRatio, 1),
          a0: num(e.startAngle, 0),
          a1: num(e.endAngle, TWO_PI),
          ext: ext3(e.extrusionDirection),
        });
        return;
      case 'SPLINE': {
        const ctrl = [];
        for (const q of e.controlPoints || []) ctrl.push(num(q.x), num(q.y), num(q.z));
        const fit = [];
        for (const q of e.fitPoints || []) fit.push(num(q.x), num(q.y), num(q.z));
        if (ctrl.length < 6 && fit.length < 6) return;
        const weights = Array.isArray(e.weights) && e.weights.length === ctrl.length / 3 && e.weights.some((w) => w !== 1)
          ? e.weights.map((w) => num(w, 1)) : null;
        out.push({
          ...base('SPLINE', e),
          degree: num(e.degree, 3),
          knots: e.knots || [],
          ctrl,
          weights,
          fit,
          closed: (num(e.flag) & 1) !== 0,
        });
        return;
      }
      case 'POINT':
        out.push({ ...base('POINT', e), p: p3(e.position) });
        return;
      case 'INSERT': {
        if (!e.name) return;
        const attribs = [];
        for (const a of e.attribs || []) {
          if (a.isVisible === false || (num(a.flags) & 1) !== 0) continue;
          const t = a.text ? mapText({ ...a.text }, a, 0) : null;
          if (t) attribs.push(t);
        }
        out.push({
          ...base('INSERT', e),
          name: e.name,
          p: p3(e.insertionPoint),
          sx: e.xScale === undefined ? 1 : num(e.xScale, 1),
          sy: e.yScale === undefined ? 1 : num(e.yScale, 1),
          sz: e.zScale === undefined ? 1 : num(e.zScale, 1),
          rot: num(e.rotation),
          ext: ext3(e.extrusionDirection),
          cols: Math.max(1, Math.trunc(num(e.columnCount, 1)) || 1),
          rows: Math.max(1, Math.trunc(num(e.rowCount, 1)) || 1),
          dx: num(e.columnSpacing),
          dy: num(e.rowSpacing),
          attribs,
        });
        return;
      }
      case 'DIMENSION':
        if (!e.name) return;
        out.push({ ...base('DIMENSION', e), block: e.name });
        return;
      case 'TEXT': {
        const t = mapText(e, e, 0);
        if (t) out.push(t);
        return;
      }
      case 'MTEXT': {
        if (!e.text) return;
        const dir = e.direction ? p3(e.direction) : null;
        out.push({
          ...base('MTEXT', e),
          s: parseMtext(e.text).text,
          p: p3(e.insertionPoint),
          h: num(e.textHeight, 1) || 1,
          w: num(e.rectWidth),
          attach: Math.trunc(num(e.attachmentPoint, 1)) || 1,
          rot: num(e.rotation),
          dir: dir && Math.hypot(dir[0], dir[1], dir[2]) > 1e-12 ? dir : null,
          ext: ext3(e.extrusionDirection),
          spacing: num(e.lineSpacing, 1) || 1,
        });
        return;
      }
      case 'ATTDEF': {
        // Solo atributos constantes y visibles
        const flags = num(e.flags);
        if ((flags & 2) === 0 || (flags & 1) !== 0 || !e.text) return;
        const t = mapText({ ...e.text }, e, 0);
        if (t) out.push(t);
        return;
      }
      case 'ATTRIB':
        // Los ATTRIB cuelgan de su INSERT (e.attribs); los sueltos se ignoran para no duplicarlos
        return;
      case 'SOLID':
      case 'TRACE': {
        const pts = [e.corner1, e.corner2, e.corner3, e.corner4].filter(Boolean).map((q) => p3(q));
        if (pts.length < 3) return;
        out.push({ ...base('SOLID', e), pts, ext: ext3(e.extrusionDirection) });
        return;
      }
      case '3DFACE': {
        const pts = [e.corner1, e.corner2, e.corner3, e.corner4].filter(Boolean).map((q) => p3(q));
        if (pts.length < 3) return;
        out.push({ ...base('FACE', e), pts });
        return;
      }
      case 'HATCH': {
        const loops = mapHatchLoops(e.boundaryPaths);
        if (!loops.length) return;
        out.push({
          ...base('HATCH', e),
          solid: num(e.solidFill) === 1 || num(e.gradientFlag) === 1,
          elev: 0,
          loops,
          ext: ext3(e.extrusionDirection),
        });
        return;
      }
      default:
        countSkipped(stats, e.type);
    }
  }

  const records = db.tables?.BLOCK_RECORD?.entries || [];
  // Un DWG mal formado puede traer VARIOS registros "*Model_Space" (uno con las entidades y otros
  // vacíos, en cualquier orden): el espacio modelo es la unión de todos, sin repetir entidades.
  let modelEntities = null;
  const modelHandles = new Set();
  for (const b of records) {
    if (MODEL_SPACE_RE.test(b.name)) {
      modelEntities = modelEntities || [];
      for (const e of b.entities || []) {
        if (e?.handle !== undefined && e.handle !== null) {
          if (modelHandles.has(e.handle)) continue;
          modelHandles.add(e.handle);
        }
        modelEntities.push(e);
      }
      continue;
    }
    if (isSpaceBlock(b.name)) continue;
    const entities = [];
    for (const e of b.entities || []) mapEntity(e, entities);
    // Con nombres de bloque repetidos (DWG mal formado) prevalece el que tiene más geometría
    const previo = ir.blocks[b.name];
    if (previo && previo.entities.length >= entities.length) continue;
    ir.blocks[b.name] = { name: b.name, base: p3(b.basePoint), entities };
  }
  // Sin registro de espacio modelo, o con todos vacíos: las entidades de la base que no son de papel
  if (!modelEntities?.length) modelEntities = (db.entities || []).filter((e) => !e.isInPaperSpace);
  for (const e of modelEntities) mapEntity(e, ir.entities);

  return ir;
}
