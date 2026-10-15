import * as THREE from 'three';

/**
 * Procedural surfaces for the world's models.
 *
 * Every model part carries a `surf` vertex attribute naming what it is made
 * of. The shader patch below turns that into detail at the pixel: plaster
 * mottling and a plinth, brick courses, clay roof tiles, corrugated sheet,
 * boards, precast concrete panels, window glass that reflects the sky,
 * canvas, sandbags, rock, foliage and bark. Each pattern also feeds a small
 * bump (so the sun picks out the texture) and parts darken towards their
 * base, which grounds buildings and props on the terrain. Patterns live in
 * object space, so they stay put on instanced and scaled models.
 *
 * The attribute's fraction flags parts that ignore the per-instance tint:
 * a house's walls take its paint colour while its roof, windows and trim keep
 * theirs.
 */
export const SURF = {
  plain: 0,
  plaster: 1,
  brick: 2,
  tile: 3,
  metal: 4,
  wood: 5,
  concrete: 6,
  glass: 7,
  canvas: 8,
  sandbag: 9,
  rock: 10,
  foliage: 11,
  bark: 12,
  paint: 13,
  hay: 14,
  sheet: 15,
  mesh: 16,
} as const;
export type SurfName = keyof typeof SURF;

/** Mark a geometry part as made of `kind`; `tint` false keeps its own colour under instance tints. */
export function surf<T extends THREE.BufferGeometry>(g: T, kind: SurfName, tint = true): T {
  const n = g.getAttribute('position').count;
  const v = SURF[kind] + (tint ? 0 : 0.5);
  g.setAttribute('surf', new THREE.BufferAttribute(new Float32Array(n).fill(v), 1));
  return g;
}

const VERT_PARS = /* glsl */ `
attribute float surf;
varying float vSurf;
varying vec3 vObjPos;
varying vec3 vObjNrm;
varying vec3 vInstOff;
`;

const VERT_BEGIN = /* glsl */ `
vSurf = surf;
vObjPos = position;
vObjNrm = normal;
#ifdef USE_INSTANCING
  vInstOff = instanceMatrix[3].xyz;
#else
  vInstOff = vec3(0.0);
#endif
`;

const COLOR_VERTEX = /* glsl */ `
#if defined( USE_COLOR ) || defined( USE_INSTANCING_COLOR )
  vColor = vec3( 1.0 );
#endif
#ifdef USE_COLOR
  vColor *= color;
#endif
#ifdef USE_INSTANCING_COLOR
  vColor.xyz *= mix( instanceColor.xyz, vec3( 1.0 ), step( 0.25, fract( surf ) ) );
#endif
`;

const FRAG_PARS = /* glsl */ `
varying float vSurf;
varying vec3 vObjPos;
varying vec3 vObjNrm;
varying vec3 vInstOff;
float sHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float sNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(sHash(i), sHash(i + vec2(1.0, 0.0)), u.x), mix(sHash(i + vec2(0.0, 1.0)), sHash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float sFbm(vec2 p) { return sNoise(p) * 0.55 + sNoise(p * 2.1 + 7.3) * 0.3 + sNoise(p * 4.3 - 3.1) * 0.15; }
// Surface coordinates: across and up a wall (or along and up a roof slope), or plan for flat faces.
vec2 sUV(vec3 p, vec3 n) {
  if (abs(n.y) > 0.92) return p.xz;
  vec2 t = normalize(vec2(-n.z, n.x));
  return vec2(dot(p.xz, t), p.y);
}
// 1 where a pattern of this period is well resolved on screen, falling to 0 as it would alias.
float sRes(vec2 uv, float period) {
  float w = max(length(fwidth(uv)), 1e-5);
  return 1.0 - smoothstep(period * 0.12, period * 0.4, w);
}
vec3 sBump(vec3 pos, vec3 nrm, float h) {
  vec3 dx = dFdx(pos);
  vec3 dy = dFdy(pos);
  vec3 r1 = cross(dy, nrm);
  vec3 r2 = cross(nrm, dx);
  float det = dot(dx, r1) * (float(gl_FrontFacing) * 2.0 - 1.0);
  vec2 dh = vec2(dFdx(h), dFdy(h));
  vec3 grad = sign(det) * (dh.x * r1 + dh.y * r2);
  return normalize(abs(det) * nrm - grad);
}
`;

/** Albedo pattern and bump height per surface type (runs after the vertex colour is applied). */
const FRAG_COLOR = /* glsl */ `
#include <color_fragment>
float sH = 0.0;
vec3 sGlass = vec3(0.0);
{
  int kind = int(floor(vSurf + 0.01));
  vec3 n = normalize(vObjNrm);
  vec3 p = vObjPos;
  vec2 uv = sUV(p, n);
  float dist = length(vViewPosition);
  float near = 1.0 - smoothstep(60.0, 260.0, dist);
  float ao = mix(0.66, 1.0, smoothstep(0.0, 1.4, p.y));
  float k = 1.0;
  // How well this surface's fine pattern is resolved here (set per kind below).
  float res = 1.0;
  if (kind == 1) {
    // Plaster: mottled, rain-streaked, with a darker rendered plinth.
    k = 0.92 + 0.1 * sFbm(uv * 0.8) + 0.05 * sNoise(uv * 7.0);
    k *= 1.0 - 0.1 * smoothstep(0.55, 0.9, sNoise(vec2(uv.x * 2.5, uv.y * 0.25)));
    if (p.y < 0.6) diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.32, 0.31, 0.29), 0.75);
    sH = sNoise(uv * 11.0) * 0.25;
  } else if (kind == 2) {
    // Brick: staggered courses, each brick its own shade, recessed mortar.
    res = sRes(uv, 0.17);
    vec2 b = uv / vec2(0.5, 0.17);
    b.x += 0.5 * mod(floor(b.y), 2.0);
    vec2 f = fract(b);
    float mortar = 1.0 - step(0.07, f.y) * step(0.04, f.x);
    k = 0.85 + 0.25 * sHash(floor(b)) + 0.06 * sNoise(uv * 9.0);
    k = mix(k, 1.25, mortar * 0.8);
    sH = -mortar * 0.6;
  } else if (kind == 3) {
    // Clay tiles: overlapping courses down the slope, barrel profile across, weathered unevenly.
    res = sRes(uv, 0.22);
    vec2 b = uv / vec2(0.32, 0.22);
    b.x += 0.5 * mod(floor(b.y), 2.0);
    vec2 f = fract(b);
    k = 0.82 + 0.26 * sHash(floor(b)) + 0.1 * sFbm(uv * 0.6);
    k *= 0.75 + 0.25 * f.y;
    sH = f.y * 0.5 + 0.35 * sin(f.x * 6.2832);
    // Lichen and soot patches.
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.2, 0.2, 0.15), smoothstep(0.62, 0.85, sFbm(uv * 0.35)) * 0.45);
  } else if (kind == 4 || kind == 15) {
    // Corrugated sheet (4: steel, ribs up the wall; 15: asbestos-cement roofing, waves down the slope).
    float pitch = kind == 4 ? 0.12 : 0.18;
    res = sRes(uv, pitch);
    float w = sin(uv.x * 6.2832 / pitch);
    k = 0.93 + 0.07 * w + 0.08 * sFbm(uv * 0.5);
    float rust = smoothstep(0.6, 0.85, sFbm(vec2(uv.x * 0.9, uv.y * 0.18)));
    diffuseColor.rgb = mix(diffuseColor.rgb, kind == 4 ? vec3(0.32, 0.17, 0.08) : vec3(0.22, 0.26, 0.12), rust * 0.5);
    sH = w * 0.5;
  } else if (kind == 5) {
    // Boards: horizontal planks, dark gaps, grain along each board.
    res = sRes(uv, 0.19);
    float row = uv.y / 0.19;
    float f = fract(row);
    float gap = 1.0 - smoothstep(0.0, 0.08, f) * smoothstep(1.0, 0.92, f);
    float plank = sHash(vec2(floor(row), floor(uv.x / 3.1)));
    k = 0.8 + 0.3 * plank + 0.12 * sNoise(vec2(uv.x * 0.8, row * 9.0));
    k *= 1.0 - gap * 0.45;
    sH = -gap * 0.5;
  } else if (kind == 6) {
    // Precast concrete: panel joints, mottling, rain stains.
    vec2 pn = uv / vec2(3.0, 2.9);
    vec2 f = fract(pn);
    float joint = 1.0 - step(0.012, f.x) * step(0.015, f.y);
    k = 0.88 + 0.12 * sFbm(uv * 0.7) + 0.06 * sHash(floor(pn));
    k *= 1.0 - 0.12 * smoothstep(0.5, 0.9, sNoise(vec2(uv.x * 1.8, uv.y * 0.2)));
    k *= 1.0 - joint * 0.35;
    sH = -joint * 0.4 + sNoise(uv * 13.0) * 0.12;
  } else if (kind == 7) {
    // Glass: dark, reflecting the sky above and the ground below.
    vec3 V = normalize(vViewPosition);
    vec3 R = reflect(-V, normalize(vNormal));
    // World-space height of the reflected ray (view space rotated back).
    float ry = dot(viewMatrix[1].xyz, R);
    vec3 sky = mix(vec3(0.16, 0.17, 0.15), vec3(0.42, 0.55, 0.72), smoothstep(-0.15, 0.5, ry));
    float fres = 0.25 + 0.6 * pow(1.0 - abs(dot(V, normalize(vNormal))), 3.0);
    sGlass = sky * fres * 0.8;
    k = 0.45;
    ao = 1.0;
  } else if (kind == 8) {
    // Canvas: weave, seams, sagging between the frame.
    k = 0.9 + 0.08 * sNoise(uv * 24.0) + 0.08 * sFbm(uv * 0.9);
    float seam = 1.0 - smoothstep(0.0, 0.04, abs(fract(uv.x / 1.3) - 0.5) - 0.46);
    k *= 1.0 - seam * 0.15;
    sH = sin(uv.x * 6.2832 / 1.3) * 0.3;
  } else if (kind == 9) {
    // Sandbags: stacked courses of stuffed bags.
    res = sRes(uv, 0.16);
    vec2 b = uv / vec2(0.55, 0.16);
    b.x += 0.5 * mod(floor(b.y), 2.0);
    vec2 f = fract(b) * 2.0 - 1.0;
    float bulge = (1.0 - f.x * f.x * f.x * f.x) * (1.0 - f.y * f.y);
    k = 0.72 + 0.32 * bulge + 0.1 * sHash(floor(b));
    sH = bulge * 0.8;
  } else if (kind == 10) {
    // Rock: lumpy, banded, lichen-spotted.
    vec3 q = p + vInstOff;
    float r = sFbm(q.xz * 0.9 + q.y * 1.3);
    k = 0.75 + 0.4 * r;
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.42, 0.45, 0.28), smoothstep(0.65, 0.9, sNoise(q.xz * 2.2 + q.y)) * 0.4 * step(0.3, n.y));
    sH = r;
    ao = mix(0.8, 1.0, smoothstep(0.0, 0.6, p.y));
  } else if (kind == 11) {
    // Foliage: clumps of leaves catching the light, darker inside the crown.
    vec3 q = p * 1.1 + vInstOff * 0.37;
    float c = sNoise(q.xy * 1.4 + q.z) * 0.6 + sNoise(q.zy * 3.1 - q.x) * 0.4;
    k = 0.7 + 0.5 * c;
    k *= mix(0.78, 1.08, smoothstep(0.0, 1.0, p.y / 7.0));
    diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(1.15, 1.2, 0.8), smoothstep(0.6, 0.85, c) * 0.35);
    sH = c * 1.4;
    ao = 1.0;
  } else if (kind == 12) {
    // Bark: vertical fissures.
    float a = atan(p.z, p.x) * 3.0;
    float f = sNoise(vec2(a * 2.0, p.y * 1.2 + vInstOff.x));
    k = 0.7 + 0.45 * f;
    sH = f;
    ao = mix(0.75, 1.0, smoothstep(0.0, 1.0, p.y));
  } else if (kind == 13) {
    // Painted metal: faint panel shading and road dirt up from the bottom.
    k = 0.94 + 0.08 * sFbm(uv * 1.2);
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.3, 0.26, 0.2), (1.0 - smoothstep(0.2, 1.1, p.y)) * 0.45);
  } else if (kind == 14) {
    // Hay: straw texture wound round the bale.
    k = 0.85 + 0.25 * sNoise(vec2(atan(p.y - 0.75, p.z) * 6.0, p.x * 18.0)) + 0.1 * sNoise(uv * 20.0);
    sH = k;
  } else if (kind == 16) {
    // HESCO: welded wire mesh over the fabric liner, in metre-square cells.
    res = sRes(uv, 0.7);
    vec2 f = fract(uv / vec2(0.75, 0.7));
    float wire = 1.0 - step(0.03, f.x) * step(0.03, f.y);
    k = 0.86 + 0.1 * sFbm(uv * 1.6) + 0.06 * sNoise(uv * 18.0);
    k = mix(k, 1.3, wire * 0.6);
    sH = wire * 0.5 + (1.0 - f.x * (1.0 - f.x) * 4.0) * -0.3;
  } else {
    k = 0.94 + 0.1 * sNoise(uv * 0.8);
  }
  // Fine patterns fade to their average as they shrink on screen, so they never shimmer.
  k = mix(0.95, k, res);
  diffuseColor.rgb *= k * ao;
  sH *= near * res;
}
`;

const FRAG_NORMAL = /* glsl */ `
#include <normal_fragment_maps>
normal = sBump(-vViewPosition, normal, sH * 0.035);
`;

const FRAG_EMISSIVE = /* glsl */ `
#include <emissivemap_fragment>
totalEmissiveRadiance += sGlass;
`;

/** Give a vertex-coloured Lambert material the procedural surfaces. */
export function withSurfaces<T extends THREE.MeshLambertMaterial>(mat: T): T {
  mat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\n' + VERT_PARS)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n' + VERT_BEGIN)
      .replace('#include <color_vertex>', COLOR_VERTEX);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\n' + FRAG_PARS)
      .replace('#include <color_fragment>', FRAG_COLOR)
      .replace('#include <normal_fragment_maps>', FRAG_NORMAL)
      .replace('#include <emissivemap_fragment>', FRAG_EMISSIVE);
  };
  mat.customProgramCacheKey = () => 'surfaces';
  return mat;
}
