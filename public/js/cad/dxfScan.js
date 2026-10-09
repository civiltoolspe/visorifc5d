// Escáner de grupos DXF (código/valor) para lo que dxf-parser no cubre:
//  - entidades HATCH y ATTRIB (dxf-parser las ignora),
//  - dirección de extrusión (210/220/230) de CIRCLE, ELLIPSE, TEXT y MTEXT,
//  - banderas de TEXT (71 generación, 51 oblicuo) y el interlineado de MTEXT (44).
// Módulo puro, importable desde Node y desde Web Workers.

// Tipos de los que se guardan los grupos completos
const KEEP_GROUPS = new Set(['CIRCLE', 'ARC', 'ELLIPSE', 'TEXT', 'MTEXT', 'HATCH', 'ATTRIB', 'INSERT']);

// Devuelve:
//  {
//    decor:   Map<handle, { ext, gen, obl, spacing }>,
//    hatches: [{ container, g }],            // g = [código, valor, código, valor, ...]
//    attribs: Map<handleDelINSERT, [{ container, g }]>,
//  }
// `container` es '' para la sección ENTITIES o el nombre del bloque.
export function scanDxf(text) {
  const decor = new Map();
  const hatches = [];
  const attribs = new Map();
  const len = text.length;
  let pos = 0;

  function readLine() {
    let end = text.indexOf('\n', pos);
    if (end < 0) end = len;
    let line = text.slice(pos, end);
    pos = end + 1;
    if (line.length && line.charCodeAt(line.length - 1) === 13) line = line.slice(0, -1);
    return line;
  }

  let section = null;
  let container = '';
  let rec = null; // { type, g }
  let lastInsertHandle = null;
  let pendingSectionName = false;
  let pendingBlockName = false;

  function finish() {
    if (!rec) return;
    const { type, g } = rec;
    rec = null;
    if (type === 'INSERT') {
      lastInsertHandle = handleOf(g);
      return;
    }
    if (type === 'ATTRIB') {
      if (lastInsertHandle) {
        let arr = attribs.get(lastInsertHandle);
        if (!arr) attribs.set(lastInsertHandle, (arr = []));
        arr.push({ container, g });
      }
      return;
    }
    if (type === 'HATCH') {
      hatches.push({ container, g });
      return;
    }
    const handle = handleOf(g);
    if (!handle) return;
    const info = {};
    for (let i = 0; i < g.length; i += 2) {
      const c = g[i];
      if (c === 210) (info.ext ||= [0, 0, 1])[0] = parseFloat(g[i + 1]);
      else if (c === 220) (info.ext ||= [0, 0, 1])[1] = parseFloat(g[i + 1]);
      else if (c === 230) (info.ext ||= [0, 0, 1])[2] = parseFloat(g[i + 1]);
      else if (c === 71 && type === 'TEXT') info.gen = parseInt(g[i + 1], 10);
      else if (c === 51 && type === 'TEXT') info.obl = parseFloat(g[i + 1]);
      else if (c === 44 && type === 'MTEXT') info.spacing = parseFloat(g[i + 1]);
    }
    decor.set(handle, info);
  }

  while (pos < len) {
    const codeLine = readLine();
    if (pos > len) break;
    const valueLine = readLine();
    const code = parseInt(codeLine, 10);
    if (Number.isNaN(code)) continue;

    if (code === 0) {
      finish();
      if (valueLine === 'SECTION') {
        pendingSectionName = true;
        continue;
      }
      if (valueLine === 'ENDSEC') {
        section = null;
        container = '';
        lastInsertHandle = null;
        continue;
      }
      if (valueLine === 'EOF') break;
      if (section !== 'ENTITIES' && section !== 'BLOCKS') continue;
      if (valueLine === 'BLOCK') {
        pendingBlockName = true;
        lastInsertHandle = null;
        continue;
      }
      if (valueLine === 'ENDBLK') {
        container = '';
        lastInsertHandle = null;
        continue;
      }
      if (valueLine === 'SEQEND') {
        lastInsertHandle = null;
        continue;
      }
      if (KEEP_GROUPS.has(valueLine)) {
        rec = { type: valueLine, g: [] };
      }
      continue;
    }

    if (pendingSectionName && code === 2) {
      section = valueLine;
      container = '';
      pendingSectionName = false;
      continue;
    }
    if (pendingBlockName && code === 2) {
      container = valueLine;
      pendingBlockName = false;
      continue;
    }
    if (rec) rec.g.push(code, valueLine);
  }
  finish();
  return { decor, hatches, attribs };
}

function handleOf(g) {
  for (let i = 0; i < g.length; i += 2) if (g[i] === 5) return g[i + 1];
  return null;
}

// ---------------------------------------------------------------------------
// Lectura de registros crudos (HATCH, ATTRIB)
// ---------------------------------------------------------------------------

const num = (s) => {
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
};
const int = (s) => {
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : 0;
};

// Propiedades comunes de un registro crudo
export function readCommon(g) {
  const out = { layer: '0', aci: 256, rgb: null, visible: true, paper: false, ext: null, handle: null };
  let ex;
  let ey;
  let ez;
  for (let i = 0; i < g.length; i += 2) {
    const c = g[i];
    const v = g[i + 1];
    if (c === 8) out.layer = v;
    else if (c === 62) out.aci = int(v);
    else if (c === 420) out.rgb = int(v) & 0xffffff;
    else if (c === 60) out.visible = int(v) === 0;
    else if (c === 67) out.paper = int(v) !== 0;
    else if (c === 5) out.handle = v;
    else if (c === 210) ex = num(v);
    else if (c === 220) ey = num(v);
    else if (c === 230) ez = num(v);
  }
  if (ex !== undefined || ey !== undefined || ez !== undefined) {
    out.ext = [ex ?? 0, ey ?? 0, ez ?? 1];
  }
  return out;
}

// HATCH → { solid, elevation, loops: [ { kind, ... } ] }
// Cada lazo es una lista de aristas:
//   { k:'L', a:[x,y], b:[x,y] }
//   { k:'A', c:[x,y], r, a0, a1, ccw }                (radianes)
//   { k:'E', c:[x,y], major:[x,y], ratio, a0, a1, ccw }
//   { k:'S', degree, knots, ctrl:[x,y,...], weights, fit:[x,y,...] }
//   { k:'P', pts:[x,y,bulge,...], closed }            (lazo de polilínea)
export function readHatch(g) {
  const n = g.length / 2;
  const code = (k) => g[k * 2];
  const val = (k) => g[k * 2 + 1];
  const out = { solid: false, gradient: false, elevation: 0, loops: [] };
  let i = 0;
  while (i < n && code(i) !== 91) {
    const c = code(i);
    if (c === 30) out.elevation = num(val(i));
    else if (c === 70) out.solid = int(val(i)) === 1;
    else if (c === 450) out.gradient = int(val(i)) === 1;
    i++;
  }
  if (i >= n) return out;
  const nPaths = int(val(i));
  i++;
  for (let p = 0; p < nPaths; p++) {
    while (i < n && code(i) !== 92) i++;
    if (i >= n) break;
    const flag = int(val(i));
    i++;
    if (flag & 2) {
      // Lazo de polilínea
      let hasBulge = false;
      let closed = true;
      while (i < n && code(i) !== 93) {
        if (code(i) === 72) hasBulge = int(val(i)) !== 0;
        else if (code(i) === 73) closed = int(val(i)) !== 0;
        i++;
      }
      if (i >= n) break;
      const count = int(val(i));
      i++;
      const pts = [];
      for (let k = 0; k < count; k++) {
        while (i < n && code(i) !== 10) i++;
        if (i >= n) break;
        const x = num(val(i));
        i++;
        let y = 0;
        if (code(i) === 20) {
          y = num(val(i));
          i++;
        }
        let bulge = 0;
        if (hasBulge && code(i) === 42) {
          bulge = num(val(i));
          i++;
        }
        pts.push(x, y, bulge);
      }
      out.loops.push([{ k: 'P', pts, closed }]);
    } else {
      while (i < n && code(i) !== 93) i++;
      if (i >= n) break;
      const edgeCount = int(val(i));
      i++;
      const edges = [];
      for (let e = 0; e < edgeCount; e++) {
        while (i < n && code(i) !== 72) i++;
        if (i >= n) break;
        const type = int(val(i));
        i++;
        const take = (c) => {
          if (i < n && code(i) === c) {
            const v = num(val(i));
            i++;
            return v;
          }
          return null;
        };
        if (type === 1) {
          const ax = take(10);
          const ay = take(20);
          const bx = take(11);
          const by = take(21);
          edges.push({ k: 'L', a: [ax ?? 0, ay ?? 0], b: [bx ?? 0, by ?? 0] });
        } else if (type === 2) {
          const cx = take(10);
          const cy = take(20);
          const r = take(40);
          const a0 = take(50);
          const a1 = take(51);
          const ccw = take(73);
          edges.push({
            k: 'A', c: [cx ?? 0, cy ?? 0], r: r ?? 0,
            a0: ((a0 ?? 0) * Math.PI) / 180, a1: ((a1 ?? 360) * Math.PI) / 180, ccw: ccw === null ? true : ccw !== 0,
          });
        } else if (type === 3) {
          const cx = take(10);
          const cy = take(20);
          const mx = take(11);
          const my = take(21);
          const ratio = take(40);
          const a0 = take(50);
          const a1 = take(51);
          const ccw = take(73);
          edges.push({
            k: 'E', c: [cx ?? 0, cy ?? 0], major: [mx ?? 1, my ?? 0], ratio: ratio ?? 1,
            a0: ((a0 ?? 0) * Math.PI) / 180, a1: ((a1 ?? 360) * Math.PI) / 180, ccw: ccw === null ? true : ccw !== 0,
          });
        } else if (type === 4) {
          const degree = take(94);
          const rational = take(73);
          take(74);
          const nKnots = take(95) ?? 0;
          const nCtrl = take(96) ?? 0;
          const knots = [];
          for (let k = 0; k < nKnots; k++) {
            const kv = take(40);
            if (kv === null) break;
            knots.push(kv);
          }
          const ctrl = [];
          const weights = [];
          for (let k = 0; k < nCtrl; k++) {
            const x = take(10);
            if (x === null) break;
            const y = take(20) ?? 0;
            ctrl.push(x, y);
            if (rational) weights.push(take(42) ?? 1);
            else if (code(i) === 42) {
              i++;
            }
          }
          const fit = [];
          if (i < n && code(i) === 97) {
            i++;
            while (i < n && code(i) === 11) {
              fit.push(num(val(i)), num(val(i + 1)));
              i += 2;
            }
            if (i < n && code(i) === 12) i += 2;
            if (i < n && code(i) === 13) i += 2;
          }
          edges.push({
            k: 'S', degree: degree ?? 3, knots, ctrl, weights: rational && weights.length === ctrl.length / 2 ? weights : null, fit,
          });
        }
      }
      out.loops.push(edges);
    }
  }
  // Datos de relleno degradado (450) posteriores a los contornos
  for (; i < n; i++) {
    if (code(i) === 450) out.gradient = int(val(i)) === 1;
  }
  return out;
}

// ATTRIB → campos de texto
export function readAttrib(g) {
  const common = readCommon(g);
  const out = {
    ...common,
    text: '',
    tag: '',
    p: [0, 0, 0],
    p2: null,
    height: 1,
    wf: 1,
    rot: 0,
    obl: 0,
    style: '',
    gen: 0,
    ha: 0,
    va: 0,
    invisible: false,
  };
  for (let i = 0; i < g.length; i += 2) {
    const c = g[i];
    const v = g[i + 1];
    switch (c) {
      case 1: out.text = v; break;
      case 2: out.tag = v; break;
      case 7: out.style = v; break;
      case 10: out.p[0] = num(v); break;
      case 20: out.p[1] = num(v); break;
      case 30: out.p[2] = num(v); break;
      case 11: (out.p2 ||= [0, 0, 0])[0] = num(v); break;
      case 21: (out.p2 ||= [0, 0, 0])[1] = num(v); break;
      case 31: (out.p2 ||= [0, 0, 0])[2] = num(v); break;
      case 40: out.height = num(v); break;
      case 41: out.wf = num(v) || 1; break;
      case 50: out.rot = (num(v) * Math.PI) / 180; break;
      case 51: out.obl = (num(v) * Math.PI) / 180; break;
      case 70: out.invisible = (int(v) & 1) !== 0; break;
      case 71: out.gen = int(v); break;
      case 72: out.ha = int(v); break;
      case 74: out.va = int(v); break;
      default: break;
    }
  }
  return out;
}
