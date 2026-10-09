// Normalizador DXF: salida de dxf-parser (+ escáner de grupos) → formato intermedio (IR).
// Módulo puro, importable desde Node y desde Web Workers.
//
// Formato intermedio (IR), compartido con normalizeDwg.js:
//   {
//     format: 'dxf' | 'dwg', version, insunits,
//     headerExtents: { min:[x,y,z]|null, max:[x,y,z]|null },   // informativo, NO fiable
//     layers: [{ name, aci, rgb, off, frozen }],
//     blocks: { [nombre]: { name, base:[x,y,z], entities: [...] } },
//     entities: [...]                                          // solo espacio modelo
//     stats: { skipped: { TIPO: n } }
//   }
// Cada entidad lleva { t, layer, aci, rgb } (aci: 256 = PorCapa, 0 = PorBloque, 1..255;
// rgb: 0xRRGGBB o null) más sus campos propios:
//   LINE{a,b}  POLY{pts:[x,y,z,bulge,...],closed,ext,is3d}  CIRCLE{c,r,ext}  ARC{c,r,a0,a1,ext}
//   ELLIPSE{c,major,ratio,a0,a1,ext}  SPLINE{degree,knots,ctrl,weights,fit,closed}  POINT{p}
//   INSERT{name,p,sx,sy,sz,rot,ext,cols,rows,dx,dy,attribs:[TEXT]}  DIMENSION{block}
//   TEXT{s,p,p2,h,rot,wf,obl,ha,va,ext,back,up}  MTEXT{s,p,h,w,attach,rot,dir,ext,spacing}
//   SOLID{pts,ext}  FACE{pts}  HATCH{solid,elev,loops,ext}

import { ACI_RGB } from './aci.js';
import {
  num, p3, ext3, extFromParts, degToRad, flatVertices, countSkipped, isSpaceBlock,
} from './irUtil.js';
import { cleanPlainText, parseMtext } from './textFormat.js';
import { readCommon, readHatch, readAttrib } from './dxfScan.js';

const TWO_PI = Math.PI * 2;

function colorOf(e) {
  const raw = e.colorIndex;
  const aci = raw === undefined || raw === null ? 256 : Math.abs(Math.trunc(raw));
  let rgb = null;
  if (e.color !== undefined && e.color !== null && Number.isFinite(e.color)) {
    const pal = aci >= 0 && aci <= 255 ? ACI_RGB[aci] : undefined;
    if (raw === undefined || e.color !== pal) rgb = e.color & 0xffffff;
  }
  return { aci, rgb };
}

function base(t, e) {
  const { aci, rgb } = colorOf(e);
  return { t, layer: e.layer || '0', aci, rgb };
}

export function normalizeDxf(dxf, scan = null) {
  const stats = { skipped: {} };
  const header = dxf.header || {};
  const decor = scan?.decor || new Map();

  const ir = {
    format: 'dxf',
    version: header.$ACADVER || '',
    insunits: num(header.$INSUNITS, 0),
    headerExtents: {
      min: header.$EXTMIN ? p3(header.$EXTMIN) : null,
      max: header.$EXTMAX ? p3(header.$EXTMAX) : null,
    },
    layers: [],
    blocks: {},
    entities: [],
    stats,
  };

  // --- Capas ---
  const layers = dxf.tables?.layer?.layers || {};
  for (const l of Object.values(layers)) {
    const aci = Math.abs(Math.trunc(num(l.colorIndex, 7))) || 7;
    let rgb = null;
    if (Number.isFinite(l.color) && l.color !== ACI_RGB[aci]) rgb = l.color & 0xffffff;
    ir.layers.push({
      name: l.name,
      aci,
      rgb,
      off: l.visible === false,
      frozen: !!l.frozen,
    });
  }

  // --- Entidades ---
  function mapAttribs(handle) {
    const list = scan?.attribs?.get(handle);
    if (!list) return [];
    const out = [];
    for (const rec of list) {
      const a = readAttrib(rec.g);
      if (a.invisible || a.visible === false || !a.text) continue;
      out.push({
        t: 'TEXT',
        layer: a.layer,
        aci: Math.abs(a.aci),
        rgb: a.rgb,
        s: cleanPlainText(a.text),
        p: a.p,
        p2: a.p2,
        h: a.height,
        rot: a.rot,
        wf: a.wf,
        obl: a.obl,
        ha: a.ha,
        va: a.va,
        ext: a.ext && ext3({ x: a.ext[0], y: a.ext[1], z: a.ext[2] }),
        back: (a.gen & 2) !== 0,
        up: (a.gen & 4) !== 0,
      });
    }
    return out;
  }

  function mapEntity(e, out) {
    if (!e || e.visible === false || e.inPaperSpace) return;
    const d = e.handle ? decor.get(e.handle) : undefined;
    switch (e.type) {
      case 'LINE': {
        const v = e.vertices || [];
        if (v.length < 2) return;
        out.push({ ...base('LINE', e), a: p3(v[0]), b: p3(v[1]) });
        return;
      }
      case 'LWPOLYLINE': {
        const v = e.vertices || [];
        if (v.length < 2) return;
        const ext = extFromParts(e.extrusionDirectionX, e.extrusionDirectionY, e.extrusionDirectionZ);
        out.push({
          ...base('POLY', e),
          pts: flatVertices(v, num(e.elevation)),
          closed: !!e.shape,
          ext,
          is3d: false,
        });
        return;
      }
      case 'POLYLINE': {
        let v = e.vertices || [];
        if (e.isPolyfaceMesh) {
          const locs = v.filter((x) => x.faceA === undefined);
          for (const f of v) {
            if (f.faceA === undefined) continue;
            const idx = [f.faceA, f.faceB, f.faceC, f.faceD].filter((k) => k !== undefined && k !== 0);
            const pts = idx.map((k) => locs[Math.abs(k) - 1]).filter(Boolean).map((q) => p3(q));
            if (pts.length >= 3) out.push({ ...base('FACE', e), pts });
          }
          return;
        }
        if (e.is3dPolygonMesh) {
          countSkipped(stats, 'POLYLINE(malla)');
          return;
        }
        if (v.length < 2) return;
        // Descartar los puntos de control de ajuste por spline si existen los vértices ajustados
        if (v.some((x) => x.splineVertex)) v = v.filter((x) => !x.splineControlPoint);
        out.push({
          ...base('POLY', e),
          pts: flatVertices(v),
          closed: !!e.shape,
          ext: e.is3dPolyline ? null : ext3(e.extrusionDirection),
          is3d: !!e.is3dPolyline,
        });
        return;
      }
      case 'CIRCLE': {
        if (!e.center || !(e.radius > 0)) return;
        out.push({ ...base('CIRCLE', e), c: p3(e.center), r: e.radius, ext: d?.ext ? ext3({ x: d.ext[0], y: d.ext[1], z: d.ext[2] }) : null });
        return;
      }
      case 'ARC': {
        if (!e.center || !(e.radius > 0)) return;
        let ext = extFromParts(e.extrusionDirectionX, e.extrusionDirectionY, e.extrusionDirectionZ);
        if (!ext && d?.ext) ext = ext3({ x: d.ext[0], y: d.ext[1], z: d.ext[2] });
        out.push({
          ...base('ARC', e), c: p3(e.center), r: e.radius, a0: num(e.startAngle), a1: num(e.endAngle, TWO_PI), ext,
        });
        return;
      }
      case 'ELLIPSE': {
        if (!e.center || !e.majorAxisEndPoint) return;
        out.push({
          ...base('ELLIPSE', e),
          c: p3(e.center),
          major: p3(e.majorAxisEndPoint),
          ratio: num(e.axisRatio, 1),
          a0: num(e.startAngle, 0),
          a1: num(e.endAngle, TWO_PI),
          ext: d?.ext ? ext3({ x: d.ext[0], y: d.ext[1], z: d.ext[2] }) : null,
        });
        return;
      }
      case 'SPLINE': {
        const ctrl = [];
        for (const q of e.controlPoints || []) ctrl.push(num(q.x), num(q.y), num(q.z));
        const fit = [];
        for (const q of e.fitPoints || []) fit.push(num(q.x), num(q.y), num(q.z));
        if (ctrl.length < 6 && fit.length < 6) return;
        out.push({
          ...base('SPLINE', e),
          degree: num(e.degreeOfSplineCurve, 3),
          knots: e.knotValues || [],
          ctrl,
          weights: null,
          fit,
          closed: !!e.closed,
        });
        return;
      }
      case 'POINT': {
        if (!e.position) return;
        out.push({ ...base('POINT', e), p: p3(e.position) });
        return;
      }
      case 'INSERT': {
        if (!e.name) return;
        out.push({
          ...base('INSERT', e),
          name: e.name,
          p: p3(e.position),
          sx: e.xScale === undefined ? 1 : num(e.xScale, 1),
          sy: e.yScale === undefined ? 1 : num(e.yScale, 1),
          sz: e.zScale === undefined ? 1 : num(e.zScale, 1),
          rot: degToRad(e.rotation),
          ext: ext3(e.extrusionDirection),
          cols: Math.max(1, Math.trunc(num(e.columnCount, 1)) || 1),
          rows: Math.max(1, Math.trunc(num(e.rowCount, 1)) || 1),
          dx: num(e.columnSpacing),
          dy: num(e.rowSpacing),
          attribs: e.handle ? mapAttribs(e.handle) : [],
        });
        return;
      }
      case 'DIMENSION': {
        if (!e.block) return;
        out.push({ ...base('DIMENSION', e), block: e.block });
        return;
      }
      case 'TEXT': {
        if (!e.text) return;
        const gen = d?.gen ?? 0;
        out.push({
          ...base('TEXT', e),
          s: cleanPlainText(e.text),
          p: p3(e.startPoint),
          p2: e.endPoint ? p3(e.endPoint) : null,
          h: num(e.textHeight, 1),
          rot: degToRad(e.rotation),
          wf: num(e.xScale, 1) || 1,
          obl: degToRad(d?.obl ?? 0),
          ha: Math.trunc(num(e.halign)),
          va: Math.trunc(num(e.valign)),
          ext: d?.ext ? ext3({ x: d.ext[0], y: d.ext[1], z: d.ext[2] }) : null,
          back: (gen & 2) !== 0,
          up: (gen & 4) !== 0,
        });
        return;
      }
      case 'MTEXT': {
        if (!e.text) return;
        const dir = e.directionVector ? p3(e.directionVector) : null;
        out.push({
          ...base('MTEXT', e),
          s: parseMtext(e.text).text,
          p: p3(e.position),
          h: num(e.height, 1) || 1,
          w: num(e.width),
          attach: Math.trunc(num(e.attachmentPoint, 1)) || 1,
          rot: degToRad(e.rotation),
          dir: dir && Math.hypot(dir[0], dir[1], dir[2]) > 1e-12 ? dir : null,
          ext: d?.ext ? ext3({ x: d.ext[0], y: d.ext[1], z: d.ext[2] }) : null,
          spacing: num(d?.spacing, 1) || 1,
        });
        return;
      }
      case 'ATTDEF': {
        // Solo los atributos constantes y visibles se dibujan como texto
        if (!e.constant || e.invisible || !e.text) return;
        out.push({
          ...base('TEXT', e),
          s: cleanPlainText(e.text),
          p: p3(e.startPoint),
          p2: e.endPoint ? p3(e.endPoint) : null,
          h: num(e.textHeight, 1),
          rot: degToRad(e.rotation),
          wf: num(e.scale, 1) || 1,
          obl: 0,
          ha: 0,
          va: 0,
          ext: null,
          back: false,
          up: false,
        });
        return;
      }
      case 'SOLID': {
        const pts = (e.points || []).filter((q) => q && Number.isFinite(q.x)).map((q) => p3(q));
        if (pts.length < 3) return;
        out.push({ ...base('SOLID', e), pts, ext: ext3(e.extrusionDirection) });
        return;
      }
      case '3DFACE': {
        const pts = (e.vertices || []).filter((q) => q && Number.isFinite(q.x)).map((q) => p3(q));
        if (pts.length < 3) return;
        out.push({ ...base('FACE', e), pts });
        return;
      }
      default:
        countSkipped(stats, e.type);
    }
  }

  function mapHatches(containerName, out) {
    if (!scan) return;
    for (const h of scan.hatches) {
      if (h.container !== containerName) continue;
      const common = readCommon(h.g);
      if (!common.visible || common.paper) continue;
      const data = readHatch(h.g);
      if (!data.loops.length) continue;
      out.push({
        t: 'HATCH',
        layer: common.layer,
        aci: Math.abs(common.aci),
        rgb: common.rgb,
        solid: data.solid || data.gradient,
        elev: data.elevation,
        loops: data.loops,
        ext: common.ext && ext3({ x: common.ext[0], y: common.ext[1], z: common.ext[2] }),
      });
    }
  }

  for (const e of dxf.entities || []) mapEntity(e, ir.entities);
  mapHatches('', ir.entities);

  for (const [name, b] of Object.entries(dxf.blocks || {})) {
    if (isSpaceBlock(name)) continue;
    const entities = [];
    for (const e of b.entities || []) mapEntity(e, entities);
    mapHatches(b.name || name, entities);
    ir.blocks[name] = { name, base: b.position ? p3(b.position) : [0, 0, 0], entities };
  }

  return ir;
}
