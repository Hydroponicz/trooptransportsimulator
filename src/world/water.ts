import * as THREE from 'three';
import { CELL, HALF, SEGS, TILE_CELLS, TILES, WATER_LEVEL, type Terrain } from './terrain';
import { FOG_COLOR, SUN_DIR } from './environment';

/**
 * River water: meshes over just the wet cells of the terrain grid (one per
 * terrain tile, so they cull), carrying the water depth and the downstream
 * direction per vertex. The shader does the rest: ripples that drift with
 * the current, sky reflection by Fresnel, sun glints, colour that goes from
 * clear over the shallows to dark green-brown in the channel, and foam
 * along the banks.
 */
export class Rivers {
  group = new THREE.Group();
  material: THREE.ShaderMaterial;

  constructor(terrain: Terrain) {
    this.material = new THREE.ShaderMaterial({
      transparent: true,
      fog: true,
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.fog,
        {
          time: { value: 0 },
          sunDir: { value: SUN_DIR.clone() },
          skyTop: { value: new THREE.Color(0x4f7fb8) },
          skyHorizon: { value: FOG_COLOR.clone() },
          deep: { value: new THREE.Color(0x24474a) },
          shallow: { value: new THREE.Color(0x4f7a62) },
          silt: { value: new THREE.Color(0x6d6a4c) },
        },
      ]),
      vertexShader: VERT,
      fragmentShader: FRAG,
    });
    this.build(terrain);
  }

  private build(terrain: Terrain) {
    const N = SEGS + 1;
    const H = terrain.heights;
    const wet = (ix: number, iz: number) => H[iz * N + ix] < WATER_LEVEL + 0.05;
    for (let tz = 0; tz < TILES; tz++)
      for (let tx = 0; tx < TILES; tx++) {
        const pos: number[] = [];
        const depth: number[] = [];
        const flow: number[] = [];
        const index: number[] = [];
        const ids = new Map<number, number>();
        const vert = (ix: number, iz: number) => {
          const k = iz * N + ix;
          let id = ids.get(k);
          if (id !== undefined) return id;
          id = pos.length / 3;
          ids.set(k, id);
          const x = -HALF + ix * CELL;
          const z = -HALF + iz * CELL;
          pos.push(x, WATER_LEVEL, z);
          depth.push(WATER_LEVEL - H[k]);
          const r = terrain.river(x, z);
          flow.push(r.dist < Infinity ? r.fx : 0, r.dist < Infinity ? r.fz : 0);
          return id;
        };
        for (let cz = tz * TILE_CELLS; cz < (tz + 1) * TILE_CELLS; cz++)
          for (let cx = tx * TILE_CELLS; cx < (tx + 1) * TILE_CELLS; cx++) {
            // A cell gets water if any corner is under it (the shader fades it out up the bank).
            if (!(wet(cx, cz) || wet(cx + 1, cz) || wet(cx, cz + 1) || wet(cx + 1, cz + 1))) continue;
            const a = vert(cx, cz);
            const b = vert(cx, cz + 1);
            const c = vert(cx + 1, cz + 1);
            const d = vert(cx + 1, cz);
            index.push(a, b, d, b, c, d);
          }
        if (!index.length) continue;
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        geo.setAttribute('depth', new THREE.Float32BufferAttribute(depth, 1));
        geo.setAttribute('flow', new THREE.Float32BufferAttribute(flow, 2));
        geo.setIndex(index);
        geo.computeBoundingSphere();
        const mesh = new THREE.Mesh(geo, this.material);
        mesh.matrixAutoUpdate = false;
        // Drawn after the terrain and roads so the banks show through the shallows.
        mesh.renderOrder = 1;
        this.group.add(mesh);
      }
    this.group.matrixAutoUpdate = false;
  }

  update(dt: number) {
    this.material.uniforms.time.value += dt;
  }
}

const VERT = /* glsl */ `
attribute float depth;
attribute vec2 flow;
varying float vDepth;
varying vec2 vFlow;
varying vec3 vWorld;
#include <fog_pars_vertex>
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  vDepth = depth;
  vFlow = flow;
  vec4 mvPosition = viewMatrix * wp;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

const FRAG = /* glsl */ `
uniform float time;
uniform vec3 sunDir;
uniform vec3 skyTop;
uniform vec3 skyHorizon;
uniform vec3 deep;
uniform vec3 shallow;
uniform vec3 silt;
varying float vDepth;
varying vec2 vFlow;
varying vec3 vWorld;
#include <fog_pars_fragment>

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
// Ripple height field: long swells along the current plus fine chop.
float waves(vec2 p) {
  float h = noise(p * 0.11) * 0.6;
  h += noise(p * 0.27 + 3.1) * 0.3;
  h += noise(p * 0.63 - 7.7) * 0.14;
  h += noise(p * 1.4 + 1.9) * 0.06;
  return h;
}
vec3 rippleNormal(vec2 p, float strength) {
  float e = 0.35;
  float h = waves(p);
  float hx = waves(p + vec2(e, 0.0)) - h;
  float hz = waves(p + vec2(0.0, e)) - h;
  return normalize(vec3(-hx * strength, e, -hz * strength));
}

void main() {
  float depth = vDepth;
  vec2 flow = vFlow;
  float speed = 1.3;
  // Flow map: two copies of the ripples drift downstream half a cycle apart,
  // cross-faded, so they move with the current without smearing out.
  float T = 6.0;
  float p0 = fract(time / T);
  float p1 = fract(time / T + 0.5);
  float w0 = 1.0 - abs(2.0 * p0 - 1.0);
  vec2 xz = vWorld.xz;
  float dist = length(cameraPosition - vWorld);
  float strength = mix(0.9, 0.35, smoothstep(60.0, 900.0, dist));
  vec3 n0 = rippleNormal(xz - flow * speed * p0 * T, strength);
  vec3 n1 = rippleNormal(xz - flow * speed * p1 * T + 17.0, strength);
  // Plus a slow wind chop that ignores the current.
  vec3 nw = rippleNormal(xz * 2.3 + vec2(time * 0.6, time * 0.35), 0.3);
  vec3 n = normalize(mix(n1, n0, w0) + vec3(nw.x, 0.0, nw.z) * 0.6);

  vec3 V = normalize(cameraPosition - vWorld);
  float ndv = max(dot(n, V), 0.0);
  float fres = 0.16 + 0.84 * pow(1.0 - ndv, 4.0);
  vec3 R = reflect(-V, n);
  vec3 sky = mix(skyHorizon, skyTop, pow(max(R.y, 0.0), 0.55));
  float sd = max(dot(R, sunDir), 0.0);
  vec3 sun = vec3(1.0, 0.9, 0.7) * (pow(sd, 900.0) * 2.2 + pow(sd, 60.0) * 0.18);

  // Body colour: the bed shows through the shallows, then green-brown, then dark in the channel.
  float d = max(depth, 0.0);
  vec3 body = mix(silt, shallow, smoothstep(0.0, 1.0, d));
  body = mix(body, deep, smoothstep(0.8, 3.4, d));
  body *= 0.55 + 0.45 * max(sunDir.y, 0.0) + 0.15 * max(dot(n, sunDir), 0.0);
  vec3 col = mix(body, sky * 0.92, clamp(fres, 0.0, 0.85)) + sun;

  // Foam and froth: along the waterline, in streaks carried by the current.
  float edge = 1.0 - smoothstep(0.0, 0.55, depth);
  float streak = noise((xz - flow * speed * time) * vec2(0.9, 0.9) + vec2(noise(xz * 0.2) * 3.0));
  float foam = edge * smoothstep(0.45, 0.8, streak + edge * 0.35);
  col = mix(col, vec3(0.8, 0.82, 0.78), foam * 0.4);

  // Fade out up the bank so the shoreline follows the terrain, not the grid.
  float alpha = smoothstep(-0.05, 0.45, depth);
  alpha *= mix(0.7, 0.96, smoothstep(0.3, 2.5, d));
  alpha = max(alpha, foam * edge * 0.8 * step(-0.05, depth));
  gl_FragColor = vec4(col, alpha);
  #include <fog_fragment>
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;
