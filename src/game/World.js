import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { HorizontalTiltShiftShader } from 'three/addons/shaders/HorizontalTiltShiftShader.js';
import { VerticalTiltShiftShader } from 'three/addons/shaders/VerticalTiltShiftShader.js';

/*
  The world around the tower: a summit above a sea of clouds, with a live
  time of day (dawn, day, golden hour, sunset, night) and weather (clear,
  rain, snow, storm). Purely cosmetic: nothing here touches the game rules.
*/

// ---------------------------------------------------------------- helpers
const clamp01 = (v) => Math.min(1, Math.max(0, v));
const smooth = (a, b, v) => {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};
export const damp = (a, b, rate, dt) => a + (b - a) * (1 - Math.exp(-rate * dt));

function mulberry32(seed) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const hash2 = (x, y) => {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};
function vnoise(x, y) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi);
  const b = hash2(xi + 1, yi);
  const c = hash2(xi, yi + 1);
  const d = hash2(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function fbm(x, y, o = 5) {
  let s = 0;
  let a = 0.5;
  let f = 1;
  for (let i = 0; i < o; i++) {
    s += a * vnoise(x * f, y * f);
    f *= 2.03;
    a *= 0.5;
  }
  return s;
}
function ridged(x, y, o = 6) {
  let s = 0;
  let a = 0.5;
  let f = 1;
  let w = 1;
  for (let i = 0; i < o; i++) {
    let n = 1 - Math.abs(vnoise(x * f, y * f) * 2 - 1);
    n *= n * w;
    w = clamp01(n * 1.7);
    s += n * a;
    f *= 2.1;
    a *= 0.5;
  }
  return s;
}

// -------------------------------------------------------------- constants
export const H = 1.9; // visual floor thickness (the rules keep their own block height)
export const HH = H / 2;
const SEA_Y = -38; // cloud sea
const DAY_MS = 6 * 60 * 1000; // one full day/night cycle
const WEATHER_MIN_MS = 45_000;
const WEATHER_JITTER_MS = 20_000;
export const ELEV = THREE.MathUtils.degToRad(19); // camera elevation over the tower top
export const TOWER_F = 0.46; // where the tower top sits on screen (0 = bottom)
const HORIZON_F = 0.8; // where the horizon sits
const TAN_E = Math.tan(ELEV);
export const R = TAN_E / (HORIZON_F - TOWER_F);
export const T_BOT = -TAN_E - TOWER_F * R;
export const T_TOP = T_BOT + R;
const F_ANGLE = Math.atan2(-1, -1); // camera looks toward -x,-z

// Fired clay, sage, slate and butter: one family, graded by the light of the hour.
const PALETTE = [
  '#ece3d2', '#e4c9a0', '#d8a47c', '#c9805f', '#b56a58', '#9a6a72',
  '#7c7491', '#6f88a6', '#6f9ea3', '#86a88e', '#a9b384', '#d4c28a',
].map((c) => new THREE.Color(c));
const BASE_COLOR = new THREE.Color('#8b847b');

export function colorFor(level) {
  if (level === 0) return BASE_COLOR.clone();
  const u = (level - 1) * 0.42;
  const i = Math.floor(u) % PALETTE.length;
  const f = u - Math.floor(u);
  const c = PALETTE[i].clone().lerp(PALETTE[(i + 1) % PALETTE.length], f * f * (3 - 2 * f));
  return c.multiplyScalar(level % 2 ? 1 : 0.94);
}

// ------------------------------------------------ shared uniforms and fog
// Module level on purpose: every patched material shares these.
const U = {
  uTime: { value: 0 },
  uHaze: { value: new THREE.Color() },
  uGlowColor: { value: new THREE.Color() },
  uGlowDir: { value: new THREE.Vector3(0, 1, 0) },
  uFogDensity: { value: 0.0018 },
  uSeaY: { value: SEA_Y },
  uSnow: { value: 0 },
  uWet: { value: 0 },
  uRim: { value: new THREE.Color() },
  uFlash: { value: 0 },
};

const FOG_GLSL = /* glsl */ `
  uniform vec3 uHaze; uniform vec3 uGlowColor; uniform vec3 uGlowDir; uniform float uFogDensity; uniform float uSeaY; uniform float uFlash;
  vec3 hazeColor(vec3 dir) {
    float g = max(dot(dir, uGlowDir), 0.0);
    return uHaze + uGlowColor * (pow(g, 8.0) * 0.3 + pow(g, 40.0) * 0.5) + uFlash * vec3(0.55, 0.6, 0.75);
  }
  float fogAmount(float dist, float wy) {
    float h = exp(-max(wy - uSeaY, 0.0) * 0.02);
    float d = dist * uFogDensity * (0.45 + 0.8 * h);
    return 1.0 - exp(-d * d);
  }`;

// Height + sun-glow aware fog for every built-in material in this app.
THREE.ShaderChunk.fog_pars_vertex = '#ifdef USE_FOG\n varying vec3 vFogWP;\n#endif';
THREE.ShaderChunk.fog_vertex = `#ifdef USE_FOG
  vec4 fogWP = vec4(transformed, 1.0);
  #ifdef USE_INSTANCING
    fogWP = instanceMatrix * fogWP;
  #endif
  vFogWP = (modelMatrix * fogWP).xyz;
#endif`;
THREE.ShaderChunk.fog_pars_fragment = `#ifdef USE_FOG\n varying vec3 vFogWP;\n ${FOG_GLSL}\n#endif`;
THREE.ShaderChunk.fog_fragment = `#ifdef USE_FOG
  vec3 fogV = vFogWP - cameraPosition; float fogD = length(fogV);
  gl_FragColor.rgb = mix(gl_FragColor.rgb, hazeColor(fogV / fogD), fogAmount(fogD, vFogWP.y));
#endif`;

/** Adds weather (snow cap, wet sheen), contact darkening and a sky-coloured rim to a standard material. */
export function patch(mat, kind) {
  const block = kind === 'block';
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, U);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vLocal;\nvarying vec3 vWN;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvLocal = position;\nvWN = normalize(mat3(modelMatrix) * objectNormal);');
    const ao = block ? `mix(0.58, 1.0, smoothstep(${(-HH).toFixed(3)}, ${(-HH + 0.8).toFixed(3)}, vLocal.y))` : '1.0';
    const top = block ? 'smoothstep(0.5, 0.85, normalize(vWN).y)' : 'smoothstep(0.62, 0.9, normalize(vWN).y)';
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vLocal;\nvarying vec3 vWN;\nuniform float uSnow; uniform float uWet; uniform vec3 uRim;')
      .replace('#include <color_fragment>', `#include <color_fragment>
        float wAo = ${ao};
        float wSn = clamp(uSnow * 1.2, 0.0, 1.0) * ${top};
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.93, 0.95, 0.99), wSn);
        diffuseColor.rgb *= mix(1.0, 0.7, uWet * (1.0 - wSn));
        diffuseColor.rgb *= wAo;`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = mix(roughnessFactor, ${block ? '0.14' : '0.45'}, uWet * (1.0 - wSn));
        roughnessFactor = mix(roughnessFactor, 0.92, wSn);`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        float wFr = pow(1.0 - saturate(dot(normal, normalize(vViewPosition))), 3.0);
        totalEmissiveRadiance += uRim * wFr * wAo * ${block ? '1.0' : '0.5'};`);
  };
  mat.customProgramCacheKey = () => `world-${kind}`;
  return mat;
}

// ------------------------------------------------------------ time of day
const KEYS = [
  { t: 0.0, zen: '#08102a', hor: '#2c3a68', glow: '#5868a8', sun: '#b4c4f8', sunI: 0.9, hs: '#7084c4', hg: '#1e2440', hI: 1.6, cl: '#6273a3', cs: '#222c4c', stars: 1, exp: 2.0, ink: '#eef1ff' },
  { t: 0.2, zen: '#0e1838', hor: '#36447a', glow: '#6266a8', sun: '#b4c4f8', sunI: 0.8, hs: '#7084c4', hg: '#1e2440', hI: 1.5, cl: '#6470a0', cs: '#242c4e', stars: 0.85, exp: 1.9, ink: '#eef1ff' },
  { t: 0.245, zen: '#1b2a5e', hor: '#d08a88', glow: '#ff9878', sun: '#ff9a70', sunI: 0.3, hs: '#5d6ca6', hg: '#2c2438', hI: 0.7, cl: '#e2a196', cs: '#4b5080', stars: 0.25, exp: 1.3, ink: '#f3f2ff' },
  { t: 0.29, zen: '#4a73b5', hor: '#ffc69c', glow: '#ffad6a', sun: '#ffb57c', sunI: 2.0, hs: '#9db6e0', hg: '#6c5a56', hI: 0.9, cl: '#ffe0c4', cs: '#8e8fb2', stars: 0, exp: 1.05, ink: '#1b2238' },
  { t: 0.36, zen: '#4583d3', hor: '#cfe1f1', glow: '#fff0d6', sun: '#fff2de', sunI: 2.8, hs: '#bdd6f4', hg: '#8a8070', hI: 1.0, cl: '#f3f5f9', cs: '#93a6c4', stars: 0, exp: 0.95, ink: '#18213a' },
  { t: 0.5, zen: '#3373cc', hor: '#d4e5f3', glow: '#ffffff', sun: '#fffaf2', sunI: 3.1, hs: '#c3dbf6', hg: '#8e8676', hI: 1.05, cl: '#f5f7fa', cs: '#97aac6', stars: 0, exp: 0.92, ink: '#18213a' },
  { t: 0.64, zen: '#3f76c4', hor: '#e6dcc8', glow: '#ffe2b6', sun: '#ffe6c0', sunI: 2.8, hs: '#bccfe9', hg: '#8c7c68', hI: 1.0, cl: '#f7ecdc', cs: '#949db8', stars: 0, exp: 0.95, ink: '#18213a' },
  { t: 0.715, zen: '#4f6fae', hor: '#f3c79a', glow: '#ffb070', sun: '#ffb978', sunI: 2.3, hs: '#a9b6d8', hg: '#7c5b49', hI: 0.95, cl: '#f6d4ad', cs: '#7f86a6', stars: 0, exp: 1.0, ink: '#1d1f33' },
  { t: 0.75, zen: '#33427f', hor: '#f39a70', glow: '#ff8350', sun: '#ff8a55', sunI: 1.1, hs: '#7f82b8', hg: '#4b3041', hI: 0.85, cl: '#f0a88a', cs: '#59577f', stars: 0, exp: 1.1, ink: '#fff4ee' },
  { t: 0.785, zen: '#121a45', hor: '#8f4c70', glow: '#c0507a', sun: '#9c78b8', sunI: 0.3, hs: '#55609c', hg: '#221b36', hI: 0.95, cl: '#8a6488', cs: '#2c2e58', stars: 0.45, exp: 1.6, ink: '#f4f2ff' },
  { t: 0.83, zen: '#08102a', hor: '#2c3a68', glow: '#5868a8', sun: '#b4c4f8', sunI: 0.9, hs: '#7084c4', hg: '#1e2440', hI: 1.6, cl: '#6273a3', cs: '#222c4c', stars: 1, exp: 2.0, ink: '#eef1ff' },
  { t: 1.0, zen: '#08102a', hor: '#2c3a68', glow: '#5868a8', sun: '#b4c4f8', sunI: 0.9, hs: '#7084c4', hg: '#1e2440', hI: 1.6, cl: '#6273a3', cs: '#222c4c', stars: 1, exp: 2.0, ink: '#eef1ff' },
].map((k) => Object.fromEntries(Object.entries(k).map(([n, v]) => [n, typeof v === 'string' ? new THREE.Color(v) : v])));

/**
 * One continuous light path: the sun rises behind the tower on the right,
 * crosses behind the camera and sets behind the tower on the left; the moon
 * then climbs low behind the tower all night.
 */
function lightPath(t, out = new THREE.Vector3()) {
  let az;
  let el;
  let isSun;
  if (t >= 0.235 && t <= 0.775) {
    const s = (t - 0.235) / 0.54;
    az = THREE.MathUtils.degToRad(35 + 290 * s);
    el = Math.asin(Math.sin(Math.PI * s) * Math.sin(THREE.MathUtils.degToRad(64)));
    isSun = true;
  } else {
    const s = ((t - 0.775 + 1) % 1) / 0.46;
    az = THREE.MathUtils.degToRad(325 + 70 * s);
    el = Math.sin(Math.PI * s) * THREE.MathUtils.degToRad(15);
    isSun = false;
  }
  out.set(Math.cos(F_ANGLE + az) * Math.cos(el), Math.sin(el), Math.sin(F_ANGLE + az) * Math.cos(el));
  return { dir: out, el, isSun };
}
const NOON_ANTI_DIR = lightPath(0.5).dir.clone().negate(); // where the sun hides at night
const MIDNIGHT_MOON_DIR = lightPath(0.0).dir.clone(); // where the moon waits by day

// ---------------------------------------------------------------- weather
const WX = {
  clear: { rain: 0, snow: 0, storm: 0, over: 0, wind: 0.5 },
  rain: { rain: 1, snow: 0, storm: 0, over: 0.72, wind: 1.1 },
  snow: { rain: 0, snow: 1, storm: 0, over: 0.55, wind: 0.7 },
  storm: { rain: 1.4, snow: 0, storm: 1, over: 0.95, wind: 2.6 },
};
export const WEATHERS = Object.keys(WX);

// ----------------------------------------------------------------- pieces
function makeSky() {
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      ...U,
      uZenith: { value: new THREE.Color() },
      uHorizon: { value: new THREE.Color() },
      uSunDir: { value: new THREE.Vector3() },
      uMoonDir: { value: new THREE.Vector3() },
      uSunDisc: { value: new THREE.Color() },
      uSunVis: { value: 0 },
      uMoonVis: { value: 0 },
      uStars: { value: 0 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() { vDir = position; vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_Position = p.xyww; }`,
    fragmentShader: /* glsl */ `
      ${FOG_GLSL}
      uniform vec3 uZenith, uHorizon, uSunDir, uMoonDir, uSunDisc; uniform float uSunVis, uMoonVis, uStars, uTime;
      varying vec3 vDir;
      float h31(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
      float n2(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
        float a = h31(vec3(i, 1.0)), b = h31(vec3(i + vec2(1, 0), 1.0)), c = h31(vec3(i + vec2(0, 1), 1.0)), d = h31(vec3(i + 1.0, 1.0));
        return mix(mix(a, b, f.x), mix(c, d, f.x), f.y); }
      void main() {
        vec3 d = normalize(vDir);
        float y = d.y;
        vec3 col = mix(uHorizon, uZenith, pow(smoothstep(-0.01, 0.32, y), 0.75));
        float sg = max(dot(d, uSunDir), 0.0);
        float gg = max(dot(d, uGlowDir), 0.0);
        col += uGlowColor * (pow(gg, 5.0) * 0.35 + pow(gg, 60.0) * 0.5) * step(-0.1, y);
        col = mix(col, hazeColor(d), smoothstep(0.02, -0.06, y));
        col += uSunDisc * smoothstep(0.99955, 0.99975, sg) * uSunVis;
        float mg = dot(d, uMoonDir);
        if (mg > 0.999) {
          vec3 t1 = normalize(cross(uMoonDir, vec3(0.0, 1.0, 0.0))), t2 = cross(t1, uMoonDir);
          vec2 q = vec2(dot(d - uMoonDir, t1), dot(d - uMoonDir, t2)) / 0.0105;
          float disc = smoothstep(1.0, 0.92, length(q));
          float lit = smoothstep(-0.55, 0.15, q.x + 0.35 * sqrt(max(0.0, 1.0 - q.y * q.y)));
          float mare = 0.82 + 0.18 * n2(q * 3.0 + 4.0);
          col = mix(col, vec3(1.0, 0.97, 0.92) * 2.2 * mare * mix(0.06, 1.0, lit), disc * uMoonVis);
        }
        col += vec3(0.6, 0.68, 1.0) * pow(max(mg, 0.0), 30.0) * 0.18 * uMoonVis;
        vec3 sp = d * 230.0, id = floor(sp), f = fract(sp) - 0.5;
        float r = h31(id);
        vec3 off = vec3(h31(id + 1.7), h31(id + 3.1), h31(id + 5.3)) - 0.5;
        float s = step(0.962, r) * smoothstep(0.17, 0.0, length(f - off * 0.6));
        s *= 0.55 + 0.45 * sin(uTime * (1.3 + r * 3.0) + r * 60.0);
        float band = exp(-pow(dot(d, normalize(vec3(0.35, 0.55, 0.75))) * 3.2, 2.0));
        col += vec3(0.85, 0.9, 1.0) * (s * (1.6 + band * 1.5) + band * 0.025) * uStars * smoothstep(0.0, 0.12, y);
        col += uFlash * vec3(0.45, 0.5, 0.7) * smoothstep(-0.1, 0.4, y);
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(1500, 48, 24), mat);
  sky.renderOrder = -10;
  sky.frustumCulled = false;
  return sky;
}

function makeSea() {
  const mat = new THREE.ShaderMaterial({
    fog: false,
    uniforms: {
      ...U,
      uWindOff: { value: new THREE.Vector2() },
      uCloudLit: { value: new THREE.Color() },
      uCloudShade: { value: new THREE.Color() },
      uLightDir: { value: new THREE.Vector3(0, 1, 0) },
    },
    vertexShader: /* glsl */ 'varying vec3 vWP; void main() { vec4 w = modelMatrix * vec4(position, 1.0); vWP = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }',
    fragmentShader: /* glsl */ `
      ${FOG_GLSL}
      uniform vec2 uWindOff; uniform vec3 uCloudLit, uCloudShade, uLightDir; uniform float uTime;
      varying vec3 vWP;
      float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
      float noise(vec2 p) { vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y); }
      float fbm(vec2 p) { float s = 0.0, a = 0.5; mat2 m = mat2(1.6, 1.2, -1.2, 1.6); for (int i = 0; i < 5; i++) { s += a * noise(p); p = m * p; a *= 0.5; } return s; }
      float field(vec2 p) { float b = fbm(p * 0.45 + 3.0); float n = fbm(p) * 0.6 + fbm(p * 3.1 + vec2(7.3, 1.7) + uTime * 0.004) * 0.25 + b * 0.35; return smoothstep(0.25, 0.85, n); }
      void main() {
        vec2 p = (vWP.xz + uWindOff * 0.6) * 0.0105;
        float h = field(p);
        vec2 ld = normalize(uLightDir.xz + 1e-4) * 0.03;
        float hs = field(p + ld);
        float lit = clamp(0.5 + (h - hs) * 4.0, 0.0, 1.0);
        vec3 c = mix(uCloudShade, uCloudLit, clamp(lit * 0.6 + h * 0.55, 0.0, 1.0));
        c *= 0.62 + 0.38 * h;
        vec3 v = vWP - cameraPosition; float dist = length(v);
        c = mix(c, hazeColor(v / dist), clamp(fogAmount(dist, vWP.y) * 1.15, 0.0, 1.0));
        gl_FragColor = vec4(c, 1.0);
      }`,
  });
  const sea = new THREE.Mesh(new THREE.CircleGeometry(2600, 96), mat);
  sea.rotation.x = -Math.PI / 2;
  sea.position.y = SEA_Y;
  return sea;
}

function makeRanges() {
  const segA = 360;
  const segR = 56;
  const r0 = 150;
  const r1 = 1150;
  const pos = [];
  const idx = [];
  for (let j = 0; j <= segR; j++) {
    const r = r0 + (r1 - r0) * Math.pow(j / segR, 1.5);
    for (let i = 0; i < segA; i++) {
      const a = (i / segA) * Math.PI * 2;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      const h = ridged(x * 0.0042 + 3.1, z * 0.0042 - 7.7);
      const amp = 215 * smooth(150, 300, r) * (0.75 + 0.25 * vnoise(x * 0.002, z * 0.002));
      pos.push(x, SEA_Y - 45 + Math.pow(h, 1.6) * amp, z);
    }
  }
  for (let j = 0; j < segR; j++) {
    for (let i = 0; i < segA; i++) {
      const a = j * segA + i;
      const b = j * segA + ((i + 1) % segA);
      idx.push(a, b, a + segA, b, b + segA, a + segA);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  const n = g.attributes.normal;
  const col = [];
  const rockA = new THREE.Color('#4a5160');
  const rockB = new THREE.Color('#6d6a6c');
  const snow = new THREE.Color('#e9eef5');
  const tmp = new THREE.Color();
  for (let i = 0; i < pos.length / 3; i++) {
    const x = pos[i * 3];
    const y = pos[i * 3 + 1];
    const z = pos[i * 3 + 2];
    tmp.copy(rockA).lerp(rockB, vnoise(x * 0.03, z * 0.03));
    const s = smooth(SEA_Y + 55, SEA_Y + 75, y + (vnoise(x * 0.05, z * 0.05) - 0.5) * 40) * smooth(0.45, 0.7, n.getY(i));
    tmp.lerp(snow, s);
    col.push(tmp.r, tmp.g, tmp.b);
  }
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  return new THREE.Mesh(g, patch(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 }), 'terrain'));
}

/** A rock spire. With `plateau` it is the flat-topped summit the tower stands on. */
function makeSpire({ top, seed, scale = 1, plateau = true, flare = 0.08, rough = 1 }) {
  const prof = [];
  for (let y = -140; y < -3.5; y += 2) {
    const dep = -y - 2.5;
    // a slight waist under the rim, then a buttressed flare, so it reads as rock, not a cone
    const waist = plateau ? -1.2 * Math.exp(-((dep - 9) ** 2) / 40) : 0;
    prof.push([11.2 + Math.pow(dep, 1.5) * flare + dep * 0.12 + waist, y]);
  }
  if (plateau) {
    prof.push([11.2, -HH - 1.7], [11.0, -HH - 0.85], [10.6, -HH - 0.28], [10.0, -HH - 0.04]);
    for (let i = 6; i >= 0; i--) prof.push([(10 * i) / 7, -HH]);
  } else {
    prof.push([8, -1.5], [5, 1.5], [2.2, 4.5], [0, 6]);
  }
  const g0 = new THREE.LatheGeometry(prof.map(([r, y]) => new THREE.Vector2(r, y)), 128);
  g0.deleteAttribute('normal');
  g0.deleteAttribute('uv');
  const g = mergeVertices(g0);
  g0.dispose();
  const p = g.attributes.position;
  const ox = seed * 17.3;
  const oz = seed * 9.1;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    const z = p.getZ(i);
    const r = Math.hypot(x, z);
    if ((plateau && r < 7.6) || r < 0.01) continue;
    const depth = -HH - y;
    if (plateau && depth < 0.1) {
      p.setY(i, y + (fbm(x * 0.25, z * 0.25, 3) - 0.5) * 0.18 * smooth(7.6, 9.5, r));
      continue;
    }
    const a = Math.atan2(z, x);
    const amp = (depth < 1.5 ? 0.25 : 0.6 + Math.min(depth, 60) * 0.11) * rough;
    const fins = ridged(Math.cos(a) * 2.2 + ox, Math.sin(a) * 2.2 + oz + y * 0.012, 4) - 0.45; // vertical rock fins
    const lobes = fbm(Math.cos(a) * 0.9 + ox, Math.sin(a) * 0.9 + oz + y * 0.006, 3) - 0.5; // big buttresses
    const ledges = fbm(Math.cos(a) * 1.6 + oz, y * 0.09 + ox, 3) - 0.5; // broken horizontal shelves
    const strata = Math.sin(y * 0.6 + fbm(x * 0.05, z * 0.05, 3) * 7) * 0.5;
    const d = fins * amp * 1.6 + lobes * amp * 3.2 + ledges * amp * 1.4 + strata * amp * 0.25;
    p.setXYZ(i, x + (x / r) * d, y, z + (z / r) * d);
  }
  g.computeVertexNormals();
  const nn = g.attributes.normal;
  const col = [];
  const tmp = new THREE.Color();
  const grassA = new THREE.Color('#6d8650');
  const grassB = new THREE.Color('#8a9a5b');
  const soil = new THREE.Color('#77664f');
  const rockA = new THREE.Color('#7a7068');
  const rockB = new THREE.Color('#4d4643');
  const snow = new THREE.Color('#e7ecf3');
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    const z = p.getZ(i);
    const ny = nn.getY(i);
    tmp.copy(rockA).lerp(rockB, smooth(0.3, 0.75, fbm(x * 0.1, y * 0.25 + z * 0.1, 3)));
    if (plateau) {
      tmp.lerp(soil, smooth(-3.5, -1.6, y) * 0.6);
      tmp.lerp(grassA.clone().lerp(grassB, vnoise(x * 0.35, z * 0.35)), smooth(0.72, 0.9, ny) * smooth(-6, -2.2, y));
    } else {
      tmp.lerp(snow, smooth(0.55, 0.8, ny) * smooth(-30, -10, y));
    }
    tmp.multiplyScalar(0.5 + 0.5 * smooth(SEA_Y - 10, -10, y));
    col.push(tmp.r, tmp.g, tmp.b);
  }
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  const m = new THREE.Mesh(g, patch(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.93 }), 'terrain'));
  m.receiveShadow = plateau;
  m.scale.setScalar(scale);
  m.position.copy(top);
  return m;
}

function makeBoulders() {
  const group = new THREE.Group();
  const rnd = mulberry32(11);
  const mat = patch(new THREE.MeshStandardMaterial({ color: '#70675f', roughness: 0.9 }), 'terrain');
  const v = new THREE.Vector3();
  for (let k = 0; k < 7; k++) {
    const geo = new THREE.IcosahedronGeometry(1, 2);
    const bp = geo.attributes.position;
    for (let i = 0; i < bp.count; i++) {
      v.fromBufferAttribute(bp, i);
      v.multiplyScalar(0.8 + 0.4 * fbm(v.x * 1.3 + k * 9, v.y * 1.3 + v.z, 3));
      bp.setXYZ(i, v.x, v.y, v.z);
    }
    geo.computeVertexNormals();
    const b = new THREE.Mesh(geo, mat);
    const a = rnd() * Math.PI * 2;
    const rr = 8.4 + rnd() * 2.0;
    const s = 0.45 + rnd() * 0.9;
    b.scale.set(s * (1 + rnd() * 0.4), s * 0.7, s);
    b.position.set(Math.cos(a) * rr, -HH + s * 0.15, Math.sin(a) * rr);
    b.rotation.y = rnd() * 6;
    b.castShadow = true;
    b.receiveShadow = true;
    group.add(b);
  }
  return group;
}

function puffAtlas() {
  const S = 256;
  const c = document.createElement('canvas');
  c.width = S;
  c.height = S;
  const g = c.getContext('2d');
  const rnd = mulberry32(7);
  for (let cell = 0; cell < 4; cell++) {
    const ox = (cell % 2) * 128;
    const oy = Math.floor(cell / 2) * 128;
    for (let i = 0; i < 30; i++) {
      const a = rnd() * Math.PI * 2;
      const rr = Math.sqrt(rnd());
      const x = ox + 64 + Math.cos(a) * rr * 28;
      const y = oy + 68 + Math.sin(a) * rr * 16 - (1 - rr) * 12;
      const r = 12 + rnd() * 18 * (1 - rr * 0.4);
      const gr = g.createRadialGradient(x, y, 0, x, y, r);
      gr.addColorStop(0, 'rgba(255,255,255,0.32)');
      gr.addColorStop(0.5, 'rgba(255,255,255,0.14)');
      gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr;
      g.beginPath();
      g.arc(x, y, r, 0, Math.PI * 2);
      g.fill();
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.NoColorSpace;
  return t;
}

function makePuffs({ count, seed, place, wrap, drift, opacity, aspect = 0.6, tex, cloudColors, windOff }) {
  const rnd = mulberry32(seed);
  const base = new THREE.PlaneGeometry(1, 1);
  const g = new THREE.InstancedBufferGeometry();
  g.index = base.index;
  g.setAttribute('position', base.attributes.position);
  g.setAttribute('uv', base.attributes.uv);
  const c = new Float32Array(count * 3);
  const s = new Float32Array(count);
  const sd = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const p = place(rnd);
    c.set([p.x, p.y, p.z], i * 3);
    s[i] = p.s;
    sd[i] = rnd();
  }
  g.setAttribute('aCenter', new THREE.InstancedBufferAttribute(c, 3));
  g.setAttribute('aScale', new THREE.InstancedBufferAttribute(s, 1));
  g.setAttribute('aSeed', new THREE.InstancedBufferAttribute(sd, 1));
  g.instanceCount = count;
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    fog: false,
    uniforms: {
      ...U,
      ...cloudColors,
      uTex: { value: tex },
      uWindOff: { value: windOff },
      uDrift: { value: drift },
      uWrap: { value: wrap },
      uCamDist: { value: 60 },
      uOpacity: { value: opacity },
      uAspect: { value: aspect },
    },
    vertexShader: /* glsl */ `
      attribute vec3 aCenter; attribute float aScale; attribute float aSeed;
      uniform vec2 uWindOff; uniform float uDrift, uWrap, uCamDist, uAspect;
      varying vec2 vUv; varying float vFade; varying vec3 vWP; varying float vSeed;
      void main() {
        vec3 c = aCenter;
        c.xz += uWindOff * uDrift * (0.8 + aSeed * 0.4);
        float edge = 1.0;
        if (uWrap > 0.0) {
          c.xz = mod(c.xz + uWrap * 0.5, uWrap) - uWrap * 0.5;
          edge = smoothstep(uWrap * 0.5, uWrap * 0.4, max(abs(c.x), abs(c.z)));
        }
        vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
        vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
        vec3 wp = c + (right * position.x + up * position.y * uAspect) * aScale;
        vWP = wp; vUv = uv; vSeed = aSeed;
        float dc = distance(cameraPosition, c);
        vFade = edge * smoothstep(uCamDist * 0.5, uCamDist * 0.95, dc) * smoothstep(9.0, 24.0, length(c.xz));
        gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      ${FOG_GLSL}
      uniform sampler2D uTex; uniform vec3 uCloudLit, uCloudShade; uniform float uOpacity;
      varying vec2 vUv; varying float vFade; varying vec3 vWP; varying float vSeed;
      void main() {
        float idx = floor(vSeed * 4.0);
        vec2 cell = vec2(mod(idx, 2.0), floor(idx / 2.0));
        float a = texture2D(uTex, vec2((cell.x + vUv.x) * 0.5, 0.5 * (1.0 - cell.y) + 0.5 * vUv.y)).a;
        a = smoothstep(0.02, 0.85, a) * vFade * uOpacity;
        if (a < 0.004) discard;
        float lit = smoothstep(0.15, 0.95, vUv.y * 0.85 + a * 0.3);
        vec3 c = mix(uCloudShade, uCloudLit, lit);
        vec3 v = vWP - cameraPosition; float dist = length(v); vec3 vd = v / dist;
        c += uGlowColor * pow(max(dot(vd, uGlowDir), 0.0), 5.0) * (1.0 - a) * 1.1;
        c = mix(c, hazeColor(vd), fogAmount(dist, vWP.y));
        gl_FragColor = vec4(c, a);
      }`,
  });
  const m = new THREE.Mesh(g, mat);
  m.frustumCulled = false;
  base.dispose();
  return m;
}

function makeRain(N, { center, wind }) {
  const rand = new Float32Array(N * 2 * 4);
  const end = new Float32Array(N * 2);
  const pos = new Float32Array(N * 2 * 3);
  const rnd = mulberry32(21);
  for (let i = 0; i < N; i++) {
    const r4 = [rnd(), rnd(), rnd(), rnd()];
    rand.set(r4, i * 8);
    rand.set(r4, i * 8 + 4);
    end[i * 2] = 0;
    end[i * 2 + 1] = 1;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aRand', new THREE.BufferAttribute(rand, 4));
  g.setAttribute('aEnd', new THREE.BufferAttribute(end, 1));
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    fog: false,
    uniforms: {
      uTime: U.uTime,
      uRain: { value: 0 },
      uCenter: { value: center },
      uBox: { value: new THREE.Vector3(70, 80, 70) },
      uWind: { value: wind },
      uColor: { value: new THREE.Color() },
    },
    vertexShader: /* glsl */ `
      attribute vec4 aRand; attribute float aEnd;
      uniform float uTime, uRain; uniform vec3 uCenter, uBox; uniform vec2 uWind;
      varying float vA; varying float vEnd;
      void main() {
        float sp = 44.0 * (0.85 + 0.3 * aRand.x);
        vec3 vel = vec3(uWind.x * 7.0, -sp, uWind.y * 7.0);
        vec3 p = aRand.xyz * uBox + vel * uTime;
        p = uCenter + mod(p - uCenter + uBox * 0.5, uBox) - uBox * 0.5;
        p -= normalize(vel) * aEnd * 1.7;
        vA = step(aRand.w, uRain / 1.4); vEnd = aEnd;
        gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor; varying float vA; varying float vEnd;
      void main() { if (vA < 0.5) discard; gl_FragColor = vec4(uColor, mix(0.36, 0.0, vEnd)); }`,
  });
  const m = new THREE.LineSegments(g, mat);
  m.frustumCulled = false;
  return m;
}

function makeSnow(N, { center, wind }) {
  const rand = new Float32Array(N * 4);
  const pos = new Float32Array(N * 3);
  const rnd = mulberry32(33);
  for (let i = 0; i < N * 4; i++) rand[i] = rnd();
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aRand', new THREE.BufferAttribute(rand, 4));
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    fog: false,
    uniforms: {
      uTime: U.uTime,
      uAmt: { value: 0 },
      uCenter: { value: center },
      uBox: { value: new THREE.Vector3(80, 80, 80) },
      uWind: { value: wind },
      uColor: { value: new THREE.Color() },
      uPx: { value: 800 },
    },
    vertexShader: /* glsl */ `
      attribute vec4 aRand;
      uniform float uTime, uAmt, uPx; uniform vec3 uCenter, uBox; uniform vec2 uWind;
      varying float vA;
      void main() {
        vec3 p = aRand.xyz * uBox;
        p.y -= uTime * (2.0 + aRand.w * 1.8);
        p.x += sin(uTime * 0.8 + aRand.w * 30.0) * 1.3 + uWind.x * uTime * 2.6;
        p.z += cos(uTime * 0.7 + aRand.x * 30.0) * 1.3 + uWind.y * uTime * 2.6;
        p = uCenter + mod(p - uCenter + uBox * 0.5, uBox) - uBox * 0.5;
        vec4 mv = viewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = (0.2 + aRand.w * 0.28) * uPx / -mv.z;
        vA = step(fract(aRand.w * 7.13 + aRand.y), uAmt);
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor; varying float vA;
      void main() { if (vA < 0.5) discard; float d = length(gl_PointCoord - 0.5); gl_FragColor = vec4(uColor, smoothstep(0.5, 0.1, d) * 0.9); }`,
  });
  const m = new THREE.Points(g, mat);
  m.frustumCulled = false;
  return m;
}

function makeGrade() {
  return new ShaderPass({
    uniforms: {
      tDiffuse: { value: null },
      uLift: { value: new THREE.Color() },
      uGain: { value: new THREE.Color(1, 1, 1) },
      uSat: { value: 1.08 },
      uContrast: { value: 1.04 },
      uVig: { value: 0.22 },
      uGrain: { value: 0.022 },
      uTime: { value: 0 },
    },
    vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: /* glsl */ `
      uniform sampler2D tDiffuse; uniform vec3 uLift, uGain; uniform float uSat, uContrast, uVig, uGrain, uTime; varying vec2 vUv;
      void main() {
        vec3 c = texture2D(tDiffuse, vUv).rgb;
        float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
        c = mix(vec3(l), c, uSat);
        c = (c - 0.5) * uContrast + 0.5;
        c = c * uGain + uLift * (1.0 - c);
        vec2 q = vUv - 0.5;
        c *= mix(1.0 - uVig, 1.0, smoothstep(0.85, 0.25, length(q * vec2(1.0, 1.2))));
        c += (fract(sin(dot(vUv * 1000.0 + fract(uTime), vec2(12.9898, 78.233))) * 43758.5453) - 0.5) * uGrain;
        gl_FragColor = vec4(c, 1.0);
      }`,
  });
}

// ------------------------------------------------------------------ World

/**
 * Builds the environment into `scene`, owns the lights and the post chain,
 * and advances the time of day and the weather.
 */
export class World {
  constructor({ renderer, scene, camera, small = false, time, weather }) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.clock = 0;
    this.dayT = Number.isFinite(time) ? ((time % 1) + 1) % 1 : Math.random();
    this.timeJump = null;

    this.wxName = WX[weather] ? weather : ['clear', 'clear', 'rain', 'snow', 'storm'][Math.floor(Math.random() * 5)];
    this.wxAuto = !WX[weather];
    this.wx = { ...WX[this.wxName] };
    this.wxNextAt = 0;
    this.nextStrike = 0;
    this.flashes = [];
    this.snowAcc = this.wxName === 'snow' ? 0.8 : 0;
    this.wetAcc = this.wxName === 'rain' || this.wxName === 'storm' ? 1 : 0;

    this.tmp = new THREE.Color();
    this.grey = new THREE.Color();
    this.zen = new THREE.Color();
    this.hor = new THREE.Color();
    this.lpDir = new THREE.Vector3();
    this.K = Object.fromEntries(Object.entries(KEYS[0]).map(([n, v]) => [n, v.isColor ? v.clone() : v]));
    this.info = { ink: '#eef1ff', night: true, minutes: 0, weather: this.wxName, icon: 'moon' };

    scene.fog = new THREE.FogExp2(0x000000, 0); // switches the custom fog chunks on

    // lights
    this.hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 1);
    this.key = new THREE.DirectionalLight(0xffffff, 2);
    this.key.castShadow = true;
    const map = small ? 1024 : 2048;
    this.key.shadow.mapSize.set(map, map);
    Object.assign(this.key.shadow.camera, { left: -24, right: 24, top: 30, bottom: -30, near: 1, far: 220 });
    this.key.shadow.bias = -0.0004;
    this.key.shadow.normalBias = 0.05;
    this.key.shadow.camera.updateProjectionMatrix();
    this.lantern = new THREE.PointLight('#ffbe80', 0, 60, 1.1); // warm glow that rides the top of the tower after dark
    this.fill = new THREE.DirectionalLight('#b9c7ff', 0); // soft moonlight from the camera side so night stays readable
    scene.add(this.hemi, this.key, this.key.target, this.lantern, this.fill, this.fill.target);

    // environment
    this.sky = makeSky();
    this.sea = makeSea();
    scene.add(this.sky, this.sea, makeRanges());
    scene.add(makeSpire({ top: new THREE.Vector3(0, 0, 0), seed: 1 }));
    scene.add(makeSpire({ top: new THREE.Vector3(-150, -8, -105), seed: 2, scale: 1.6, plateau: false, flare: 0.1, rough: 1.3 }));
    scene.add(makeBoulders());

    this.windOff = new THREE.Vector2();
    this.wind = new THREE.Vector2(1, 0.3);
    this.precipCenter = new THREE.Vector3();
    this.cloudColors = { uCloudLit: { value: new THREE.Color() }, uCloudShade: { value: new THREE.Color() } };
    const tex = puffAtlas();
    const shared = { tex, cloudColors: this.cloudColors, windOff: this.windOff };
    this.puffs = [
      // the ragged top of the cloud sea, hugging the peak
      makePuffs({ ...shared, count: 48, seed: 3, wrap: 0, drift: 0, opacity: 0.42, aspect: 0.3, place: (r) => { const a = r() * 6.283; const d = 30 + r() * 80; return { x: Math.cos(a) * d, y: SEA_Y + 1 + r() * 4, z: Math.sin(a) * d, s: 50 + r() * 60 }; } }),
      // big banks far out on the sea
      makePuffs({ ...shared, count: small ? 90 : 140, seed: 5, wrap: 1400, drift: 1, opacity: 0.65, aspect: 0.32, place: (r) => ({ x: (r() - 0.5) * 1400, y: SEA_Y + r() * 10, z: (r() - 0.5) * 1400, s: 60 + r() * 90 }) }),
      // loose clouds drifting past the tower at altitude
      makePuffs({ ...shared, count: 46, seed: 9, wrap: 520, drift: 1.6, opacity: 0.55, place: (r) => ({ x: (r() - 0.5) * 520, y: -20 + r() * 70, z: (r() - 0.5) * 520, s: 22 + r() * 30 }) }),
    ];
    scene.add(...this.puffs);

    const precip = { center: this.precipCenter, wind: this.wind };
    this.rain = makeRain(small ? 1800 : 2600, precip);
    this.snow = makeSnow(small ? 2200 : 3200, precip);
    scene.add(this.rain, this.snow);

    this.boltMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(5, 5.5, 7), transparent: true, opacity: 0, depthWrite: false, fog: false, side: THREE.DoubleSide });
    this.bolt = new THREE.Mesh(new THREE.BufferGeometry(), this.boltMat);
    this.bolt.frustumCulled = false;
    scene.add(this.bolt);

    // post
    this.composer = new EffectComposer(renderer);
    this.composer.addPass(new RenderPass(scene, camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.32, 0.6, 0.92);
    this.composer.addPass(this.bloom);
    this.tiltH = new ShaderPass(HorizontalTiltShiftShader);
    this.tiltV = new ShaderPass(VerticalTiltShiftShader);
    this.composer.addPass(this.tiltH);
    this.composer.addPass(this.tiltV);
    this.composer.addPass(new OutputPass());
    this.grade = makeGrade();
    this.composer.addPass(this.grade);
    this.smaa = new SMAAPass(256, 256);
    this.composer.addPass(this.smaa);
  }

  /** `focus` is the screen row (0 = bottom) the tilt-shift keeps sharp. */
  setSize(w, h, dpr, focus) {
    this.composer.setPixelRatio(dpr);
    this.composer.setSize(w, h);
    this.tiltH.uniforms.h.value = 2.4 / w;
    this.tiltV.uniforms.v.value = 2.4 / h;
    this.setFocus(focus);
    this.snow.material.uniforms.uPx.value = (h * dpr) / R;
  }

  setFocus(focus) {
    this.tiltH.uniforms.r.value = focus;
    this.tiltV.uniforms.r.value = focus;
  }

  /** Skip smoothly to time of day `t` (0..1, 0 = midnight). */
  jumpTo(t) {
    this.timeJump = ((t % 1) + 1) % 1;
  }

  setWeather(name) {
    if (!WX[name]) {
      this.wxAuto = true;
      return;
    }
    this.wxAuto = false;
    this.wxName = name;
  }

  #pickWeather(score) {
    // The higher the climb, the colder it gets.
    const alt = Math.min(1, score / 40);
    const w = { clear: 3, rain: 1.3 * (1 - alt * 0.7), snow: 0.6 + alt * 2.4, storm: 0.7 };
    delete w[this.wxName];
    let r = Math.random() * Object.values(w).reduce((a, b) => a + b, 0);
    for (const [n, v] of Object.entries(w)) {
      r -= v;
      if (r <= 0) return n;
    }
    return 'clear';
  }

  #greyOf(c, k) {
    const l = c.r * 0.2126 + c.g * 0.7152 + c.b * 0.0722;
    return this.grey.setRGB(l * 0.92, l * 0.96, l * 1.04).multiplyScalar(k);
  }

  #sampleKeys(t) {
    let i = 0;
    while (i < KEYS.length - 2 && t >= KEYS[i + 1].t) i++;
    const a = KEYS[i];
    const b = KEYS[i + 1];
    let f = clamp01((t - a.t) / (b.t - a.t));
    f = f * f * (3 - 2 * f);
    const K = this.K;
    for (const n in a) {
      if (n === 't') continue;
      if (a[n].isColor) K[n].copy(a[n]).lerp(b[n], f);
      else K[n] = a[n] + (b[n] - a[n]) * f;
    }
  }

  #strike(now) {
    const a = F_ANGLE + (Math.random() - 0.5) * 1.3;
    const dist = 380 + Math.random() * 300;
    const bottom = new THREE.Vector3(Math.cos(a) * dist, SEA_Y + 15 + Math.random() * 30, Math.sin(a) * dist);
    let pts = [new THREE.Vector3(bottom.x + (Math.random() - 0.5) * 60, bottom.y + 240, bottom.z + (Math.random() - 0.5) * 60), bottom];
    for (let lvl = 0, amt = 40; lvl < 6; lvl++, amt *= 0.55) {
      const next = [pts[0]];
      for (let i = 1; i < pts.length; i++) {
        const m = pts[i - 1].clone().lerp(pts[i], 0.5);
        m.x += (Math.random() - 0.5) * amt;
        m.z += (Math.random() - 0.5) * amt;
        m.y += (Math.random() - 0.5) * amt * 0.3;
        next.push(m, pts[i]);
      }
      pts = next;
    }
    const toCam = this.camera.position.clone().sub(bottom).normalize();
    const verts = [];
    const side = new THREE.Vector3();
    for (let i = 1; i < pts.length; i++) {
      const a0 = pts[i - 1];
      const b0 = pts[i];
      const w = 1.1 * (1 - i / pts.length) + 0.5;
      side.copy(b0).sub(a0).cross(toCam).normalize().multiplyScalar(w);
      const p1 = a0.clone().add(side);
      const p2 = a0.clone().sub(side);
      const p3 = b0.clone().add(side);
      const p4 = b0.clone().sub(side);
      verts.push(...p1.toArray(), ...p2.toArray(), ...p3.toArray(), ...p2.toArray(), ...p4.toArray(), ...p3.toArray());
    }
    this.bolt.geometry.dispose();
    this.bolt.geometry = new THREE.BufferGeometry();
    this.bolt.geometry.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    this.flashes.push([now, 1], [now + 90, 0.35], [now + 160, 0.85]);
  }

  /**
   * Advances time and weather. `view` describes the camera rig:
   * { y (tower top), psi (camera heading), dist, score }.
   * Returns HUD info (ink colour, night, clock minutes, weather, icon).
   */
  update(dt, now, rawDt, view) {
    const { K, wx, hor, zen, tmp } = this;
    this.clock += dt;
    U.uTime.value = this.clock;
    this.grade.uniforms.uTime.value = this.clock;
    this.sky.position.copy(this.camera.position);
    for (const p of this.puffs) p.material.uniforms.uCamDist.value = view.dist;

    if (this.timeJump !== null) {
      const left = (this.timeJump - this.dayT + 1) % 1;
      this.dayT = (this.dayT + Math.min(left, rawDt * 0.11)) % 1;
      if (left < 0.001) this.timeJump = null;
    } else {
      this.dayT = (this.dayT + (dt * 1000) / DAY_MS) % 1;
    }
    this.#sampleKeys(this.dayT);

    // weather
    if (this.wxAuto && now > this.wxNextAt) {
      if (this.wxNextAt) this.wxName = this.#pickWeather(view.score);
      this.wxNextAt = now + WEATHER_MIN_MS + Math.random() * WEATHER_JITTER_MS;
    }
    const target = WX[this.wxName];
    for (const n in wx) wx[n] = damp(wx[n], target[n], 0.22, dt);
    this.snowAcc = clamp01(this.snowAcc + dt * (wx.snow > 0.3 ? 0.07 * wx.snow : -0.025));
    this.wetAcc = clamp01(this.wetAcc + dt * (wx.rain > 0.3 ? 0.2 : -0.03));
    U.uSnow.value = this.snowAcc;
    U.uWet.value = this.wetAcc * (1 - this.snowAcc);
    const o = wx.over;
    const st = wx.storm;

    // lightning
    if (st > 0.6 && now > this.nextStrike) {
      if (this.nextStrike) this.#strike(now);
      this.nextStrike = now + 3000 + Math.random() * 7000;
    }
    let flash = 0;
    for (const [ft, fa] of this.flashes) if (now >= ft) flash += fa * Math.exp(-(now - ft) / 70);
    while (this.flashes.length && now - this.flashes[0][0] > 1500) this.flashes.shift();
    U.uFlash.value = flash;
    this.boltMat.opacity = Math.min(1, flash * 1.4);

    // sun and moon
    const lp = lightPath(this.dayT, this.lpDir);
    const su = this.sky.material.uniforms;
    su.uSunDir.value.copy(lp.isSun ? lp.dir : NOON_ANTI_DIR);
    su.uMoonDir.value.copy(lp.isSun ? MIDNIGHT_MOON_DIR : lp.dir);
    su.uSunVis.value = lp.isSun ? (1 - o) * smooth(-0.03, 0.02, lp.el) : 0;
    su.uMoonVis.value = lp.isSun ? 0 : (1 - o) * smooth(-0.02, 0.03, lp.el);
    su.uSunDisc.value.copy(K.sun).multiplyScalar(14);
    su.uStars.value = K.stars * (1 - o);

    // overcast pulls everything toward a cool grey and dims the key light
    zen.copy(K.zen).lerp(this.#greyOf(K.zen, 1 - 0.5 * st), o * 0.85);
    hor.copy(K.hor).lerp(this.#greyOf(K.hor, 0.9 - 0.45 * st), o * 0.85);
    su.uZenith.value.copy(zen);
    su.uHorizon.value.copy(hor);
    U.uHaze.value.copy(hor);
    U.uGlowColor.value.copy(K.glow).multiplyScalar((1 - o * 0.8) * (lp.isSun ? 1 : 0.5));
    U.uGlowDir.value.copy(lp.dir);
    U.uFogDensity.value = 0.00105 * (1 + o * 2.2 + st * 1.0);
    U.uRim.value.copy(K.glow).multiplyScalar(0.22).add(tmp.copy(hor).multiplyScalar(0.12));

    this.key.color.copy(K.sun);
    this.key.intensity = K.sunI * (1 - o * 0.78);
    this.hemi.color.copy(K.hs).lerp(this.#greyOf(K.hs, 1), o * 0.6);
    this.hemi.groundColor.copy(K.hg);
    this.hemi.intensity = K.hI * (1 + o * 0.15) + flash * 2.5;
    this.renderer.toneMappingExposure = K.exp * (1 - st * 0.12);

    const cl = this.cloudColors.uCloudLit.value.copy(K.cl).lerp(this.#greyOf(K.cl, 0.85 - 0.4 * st), o * 0.75);
    const cs = this.cloudColors.uCloudShade.value.copy(K.cs).lerp(this.#greyOf(K.cs, 0.9 - 0.4 * st), o * 0.6);
    const seaU = this.sea.material.uniforms;
    seaU.uCloudLit.value.copy(cl);
    seaU.uCloudShade.value.copy(cs);
    seaU.uLightDir.value.copy(lp.dir);

    // wind
    const ws = 1.4 + wx.wind * 3.2;
    this.wind.set(Math.cos(now * 0.00005) * wx.wind, Math.sin(now * 0.00005) * wx.wind * 0.5 + 0.2 * wx.wind);
    this.windOff.x += dt * ws;
    this.windOff.y += dt * ws * 0.35;
    seaU.uWindOff.value.copy(this.windOff);

    const ru = this.rain.material.uniforms;
    ru.uRain.value = wx.rain;
    ru.uColor.value.copy(hor).multiplyScalar(1.3).addScalar(0.08 + flash);
    const snu = this.snow.material.uniforms;
    snu.uAmt.value = wx.snow;
    snu.uColor.value.copy(K.hs).lerp(tmp.setRGB(1, 1, 1), 0.6).multiplyScalar(0.55 + K.sunI * 0.15);

    // grade
    this.grade.uniforms.uLift.value.copy(zen).multiplyScalar(0.05);
    this.grade.uniforms.uGain.value.setRGB(1, 1, 1).lerp(tmp.copy(K.sun).multiplyScalar(1 / Math.max(K.sun.r, K.sun.g, K.sun.b)), 0.08);
    this.grade.uniforms.uSat.value = 1.0 - o * 0.2;

    // light rig follows the tower top
    const y = view.y;
    this.key.target.position.set(0, y, 0);
    this.key.position.copy(lp.dir).multiplyScalar(90).add(this.key.target.position);
    this.precipCenter.set(0, y, 0);
    const night = lp.isSun ? 1 - smooth(0.0, 0.22, lp.el) : 1;
    this.lantern.intensity = night * 18 * (1 - st * 0.3);
    this.lantern.position.set(4.5, y + H * 2.2, 4.5);
    this.fill.intensity = night * 1.9 * (1 - o * 0.35);
    this.fill.target.position.set(0, y, 0);
    this.fill.position.set(Math.cos(view.psi + 0.5) * 60, y + 55, Math.sin(view.psi + 0.5) * 60);

    // HUD info
    const info = this.info;
    info.ink = `#${K.ink.getHexString(THREE.SRGBColorSpace)}`;
    info.night = K.exp > 1.2;
    info.minutes = Math.floor(this.dayT * 24 * 60);
    info.weather = this.wxName;
    info.icon = this.wxName !== 'clear' ? this.wxName : lp.isSun ? (lp.el > 0.14 ? 'sun' : 'horizon') : 'moon';
    return info;
  }

  render(dt) {
    this.composer.render(dt);
  }

  dispose() {
    this.scene.traverse((o) => {
      o.geometry?.dispose();
      const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
      for (const m of mats) {
        m.uniforms?.uTex?.value?.dispose?.();
        m.dispose();
      }
    });
    this.key.shadow.map?.dispose();
    this.composer.dispose();
  }
}
