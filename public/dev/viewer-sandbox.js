// Sandbox de desarrollo del visor 3D: usa el Viewer, la caja de sección y la medición reales
// con unas cajas de colores y un proveedor de picking de prueba (simula al del IFC).
// Abrir con: node tests/devserver.mjs 8102  →  http://127.0.0.1:8102/dev/viewer.html

import * as THREE from 'three';
import { bus } from '/js/core/events.js';
import { createStore } from '/js/core/store.js';
import { createActions } from '/js/core/actions.js';
import { Viewer } from '/js/viewer/Viewer.js';
import { SectionBox } from '/js/viewer/SectionBox.js';
import { MeasureTool } from '/js/viewer/MeasureTool.js';

const store = createStore();
const actions = createActions(store);
const viewer = new Viewer(document.getElementById('viewport'), { bus, store });
const section = new SectionBox({ viewer, store, bus });
const measure = new MeasureTool({ viewer, store, bus, actions });

// Grupo "modelo" georreferenciado (UTM 18S) registrado en el origen global
const group = new THREE.Group();
group.name = 'edificio-prueba';
viewer.worldOrigin.register(group, { e: 279500, n: 8661000, h: 150 });
viewer.add(group);

const boxes = {};
function addBox(name, size, pos, color, { kind = 'ifc', expressId } = {}) {
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(...size),
    new THREE.MeshStandardMaterial({ color, roughness: 0.9, metalness: 0, side: THREE.DoubleSide }),
  );
  mesh.position.set(...pos);
  mesh.name = name;
  mesh.userData = { kind, modelId: 'm1', expressId };
  group.add(mesh);
  boxes[name] = mesh;
  return mesh;
}

addBox('losa', [12, 0.3, 8], [0, 0.15, 0], 0xf2efe9, { expressId: 1 });
addBox('rojo', [2, 2, 2], [-3, 1.3, 0], 0xc8503c, { expressId: 2 });
addBox('azul', [2, 3, 2], [2, 1.8, 1], 0x4f78b5, { expressId: 3 });
addBox('verde', [1, 5, 1], [0, 2.8, -2.5], 0x5b9a61, { expressId: 4 });
addBox('naranja', [1.5, 1.5, 1.5], [4.5, 1.05, -2], 0xe8a23a, { kind: 'cad', expressId: 5 });

// Proveedor de picking de prueba: replica la forma del que registrará IfcManager
const pickMeshes = Object.values(boxes);
viewer.addPickProvider({
  id: 'test',
  raycast(raycaster) {
    return raycaster.intersectObjects(pickMeshes, false).map((h) => ({
      distance: h.distance,
      point: h.point,
      face: h.face,
      kind: h.object.userData.kind,
      modelId: h.object.userData.modelId,
      expressId: h.object.userData.expressId,
      object: h.object,
    }));
  },
});

// Botonera mínima para probar a mano
const hud = document.getElementById('hud');
function button(label, fn) {
  const b = document.createElement('button');
  b.textContent = label;
  b.addEventListener('click', fn);
  hud.appendChild(b);
}
button('Encuadrar', () => viewer.fitAll());
for (const v of ['top', 'front', 'back', 'left', 'right', 'iso']) button(v, () => viewer.setView(v));
button('Persp/Orto', () => actions.setProjection(viewer.projection === 'perspective' ? 'orthographic' : 'perspective'));
button('Sección', () => actions.setSection({ enabled: !store.get('section').enabled }));
button('Medir', () => actions.setMeasureActive(!store.get('measure').active));
button('Borrar medidas', () => actions.clearMeasures());

window.__t = { THREE, viewer, section, measure, store, bus, actions, group, boxes, pickMeshes };

viewer.fitAll({ smooth: false });
requestAnimationFrame(() => requestAnimationFrame(() => {
  window.__ready = true;
}));
