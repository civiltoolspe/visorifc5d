// Materiales del visor IFC: MeshLambertMaterial modificado con onBeforeCompile para leer el estado
// de cada elemento desde una DataTexture (texelFetch) y aplicar normal / fantasma / oculto / seleccionado / hover /
// color de sobrescritura sin reconstruir la geometría.
//
// Dos pasadas por lote (comparten la geometría):
//   pasada 0 (opaca o transparente por opacidad base): descarta FANTASMA y OCULTO
//   pasada 1 (fantasma): sólo dibuja FANTASMA, transparente, sin escribir profundidad
// El descarte se hace en el vertex shader (posición fuera del volumen de recorte), de modo que no genera fragmentos.

import * as THREE from 'three';

// Códigos de estado (deben coincidir con IfcStates.js)
const GLSL_STATES = `
const int IFC_NORMAL = 0;
const int IFC_GHOST = 1;
const int IFC_HIDDEN = 2;
const int IFC_SELECTED = 3;
const int IFC_HOVER = 4;
`;

export const SELECT_COLOR = '#FF6A13';
export const HOVER_COLOR = '#FFC21A';
export const SELECT_MIX = 0.35;
export const HOVER_MIX = 0.2;
export const GHOST_LIGHTEN = 0.7;

function srgbToLinearJs(c) {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function hexToLinearVec3(hex) {
  const v = parseInt(hex.slice(1), 16);
  const r = ((v >> 16) & 255) / 255;
  const g = ((v >> 8) & 255) / 255;
  const b = (v & 255) / 255;
  return `vec3(${srgbToLinearJs(r).toFixed(5)}, ${srgbToLinearJs(g).toFixed(5)}, ${srgbToLinearJs(b).toFixed(5)})`;
}

const COMMON_PARS = `
#include <common>
attribute float elementIndex;
uniform highp sampler2D uStates;
uniform int uStatesWidth;
uniform float uGhostOpacity;
bool ifcCull = false;
${GLSL_STATES}
vec3 ifcToLinear( vec3 c ) {
  return mix( c * 0.0773993808, pow( c * 0.9478672986 + vec3( 0.0521327014 ), vec3( 2.4 ) ), step( vec3( 0.04045 ), c ) );
}
`;

function colorBlock(pass) {
  const common = `
  {
    int ifcIdx = int( elementIndex + 0.5 );
    vec4 ifcTex = texelFetch( uStates, ivec2( ifcIdx % uStatesWidth, ifcIdx / uStatesWidth ), 0 );
    int ifcCode = int( ifcTex.r * 255.0 + 0.5 );
    int ifcState = ifcCode & 7;
    vec3 ifcBase = ifcToLinear( ( ifcCode & 128 ) != 0 ? ifcTex.gba : vColor.rgb );
    float ifcAlpha = vColor.a;
    vec3 ifcOut = ifcBase;
`;
  if (pass === 0) {
    return `${common}
    ifcCull = ( ifcState == IFC_GHOST || ifcState == IFC_HIDDEN );
    if ( ifcState == IFC_SELECTED ) ifcOut = mix( ifcBase, ${hexToLinearVec3(SELECT_COLOR)}, ${SELECT_MIX.toFixed(2)} );
    else if ( ifcState == IFC_HOVER ) ifcOut = mix( ifcBase, ${hexToLinearVec3(HOVER_COLOR)}, ${HOVER_MIX.toFixed(2)} );
    vColor = vec4( ifcOut, ifcAlpha );
  }
`;
  }
  return `${common}
    ifcCull = ( ifcState != IFC_GHOST );
    ifcOut = mix( ifcBase, vec3( 1.0 ), ${GHOST_LIGHTEN.toFixed(2)} );
    vColor = vec4( ifcOut, uGhostOpacity );
  }
`;
}

const CULL_BLOCK = `
#include <fog_vertex>
  if ( ifcCull ) gl_Position = vec4( 2.0, 2.0, 2.0, 1.0 );
`;

function patchLambert(material, pass, uniforms) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uStates = uniforms.uStates;
    shader.uniforms.uStatesWidth = uniforms.uStatesWidth;
    shader.uniforms.uGhostOpacity = uniforms.uGhostOpacity;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', COMMON_PARS)
      .replace('#include <color_vertex>', `#include <color_vertex>\n${colorBlock(pass)}`)
      .replace('#include <fog_vertex>', CULL_BLOCK);
  };
  material.customProgramCacheKey = () => `ifc-lambert-pass${pass}`;
  return material;
}

const EDGE_VERTEX = `
attribute float elementIndex;
uniform highp sampler2D uStates;
uniform int uStatesWidth;
varying vec4 vEdgeColor;
#include <clipping_planes_pars_vertex>
void main() {
  int idx = int( elementIndex + 0.5 );
  vec4 t = texelFetch( uStates, ivec2( idx % uStatesWidth, idx / uStatesWidth ), 0 );
  int st = int( t.r * 255.0 + 0.5 ) & 7;
  vec4 col = vec4( 0.17, 0.17, 0.18, 0.35 );
  if ( st == 1 ) col = vec4( 0.72, 0.72, 0.74, 0.15 );
  else if ( st == 3 ) col = vec4( 0.55, 0.20, 0.02, 0.95 );
  else if ( st == 4 ) col = vec4( 0.45, 0.32, 0.04, 0.60 );
  vEdgeColor = col;
  vec4 mvPosition = modelViewMatrix * vec4( position, 1.0 );
  gl_Position = projectionMatrix * mvPosition;
  if ( st == 2 ) gl_Position = vec4( 2.0, 2.0, 2.0, 1.0 );
  #include <clipping_planes_vertex>
}
`;

const EDGE_FRAGMENT = `
varying vec4 vEdgeColor;
#include <clipping_planes_pars_fragment>
void main() {
  #include <clipping_planes_fragment>
  gl_FragColor = vEdgeColor;
}
`;

// Uniformes compartidos por todos los materiales de un modelo.
export function createStateUniforms(texture, width) {
  return {
    uStates: { value: texture },
    uStatesWidth: { value: width },
    uGhostOpacity: { value: 0.12 },
  };
}

export function createIfcMaterials(uniforms) {
  // Sólo las caras opacas se desplazan hacia atrás en profundidad (para que las aristas se vean encima y para que
  // las superficies transparentes coplanares, como un vidrio al ras del muro, ganen la prueba de profundidad).
  const opaque = patchLambert(
    new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }),
    0,
    uniforms,
  );
  const transparent = patchLambert(
    new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide, transparent: true, depthWrite: false }),
    0,
    uniforms,
  );
  transparent.customProgramCacheKey = () => 'ifc-lambert-pass0-transparent';
  const ghost = patchLambert(
    new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.FrontSide, transparent: true, depthWrite: false }),
    1,
    uniforms,
  );
  const edges = new THREE.ShaderMaterial({
    vertexShader: EDGE_VERTEX,
    fragmentShader: EDGE_FRAGMENT,
    uniforms: {
      uStates: uniforms.uStates,
      uStatesWidth: uniforms.uStatesWidth,
    },
    transparent: true,
    depthWrite: false,
    depthTest: true,
    clipping: true,
  });
  return {
    opaque,
    transparent,
    ghost,
    edges,
    dispose() {
      opaque.dispose();
      transparent.dispose();
      ghost.dispose();
      edges.dispose();
    },
  };
}
