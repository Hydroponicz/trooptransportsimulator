import * as THREE from 'three';
import { FOG_RANGE, FOG_SCALE_HEIGHT, HAZE, SKY_TOP, SUN_COLOR, SUN_DIR, SUN_HAZE } from './look';
import { Noise2D } from '../util/noise';

export { SUN_DIR } from './look';
export const FOG_COLOR = HAZE;

/**
 * Sky dome with drifting fair-weather cumulus, the sun and its light, and a
 * ring of far mountain ranges beyond the map so the horizon has depth.
 * (River water is in water.ts; the haze itself is in look.ts.)
 */
export class Environment {
  sun: THREE.DirectionalLight;
  hemi: THREE.HemisphereLight;
  sky: THREE.Mesh;
  /** Far ranges: follow the camera around (they're too far for parallax to matter). */
  ranges: THREE.Mesh;
  private skyMat: THREE.ShaderMaterial;

  constructor(scene: THREE.Scene) {
    scene.fog = new THREE.Fog(HAZE, FOG_SCALE_HEIGHT, FOG_RANGE);
    scene.background = HAZE;

    // Skylight from above, warm bounce from the sunlit ground below.
    this.hemi = new THREE.HemisphereLight(0xb4d0f0, 0x6b6040, 0.95);
    scene.add(this.hemi);

    this.sun = new THREE.DirectionalLight(SUN_COLOR, 3.3);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const sc = this.sun.shadow.camera;
    sc.left = -90;
    sc.right = 90;
    sc.top = 90;
    sc.bottom = -90;
    sc.near = 10;
    sc.far = 900;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.6;
    scene.add(this.sun);
    scene.add(this.sun.target);
    // Faint cool fill from the sky opposite the sun, so shadowed faces keep their shape.
    const fill = new THREE.DirectionalLight(0xbcd2ec, 0.35);
    fill.position.set(-SUN_DIR.x, 0.5, -SUN_DIR.z);
    scene.add(fill);

    this.skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        top: { value: SKY_TOP.clone() },
        horizon: { value: HAZE.clone() },
        sunHaze: { value: SUN_HAZE.clone() },
        sunDir: { value: SUN_DIR },
        time: { value: 0 },
      },
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = position;
          vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          gl_Position = p.xyww;
        }`,
      fragmentShader: SKY_FRAG,
    });
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(12000, 48, 24), this.skyMat);
    this.sky.frustumCulled = false;
    this.sky.renderOrder = -2;
    scene.add(this.sky);

    this.ranges = farRanges();
    scene.add(this.ranges);
  }

  update(dt: number) {
    this.skyMat.uniforms.time.value += dt;
  }

  /** Keep the shadow frustum centered on the area of interest. */
  follow(target: THREE.Vector3, cameraPos: THREE.Vector3) {
    this.sun.target.position.copy(target);
    this.sun.position.copy(target).addScaledVector(SUN_DIR, 400);
    this.sky.position.copy(cameraPos);
    this.ranges.position.set(cameraPos.x, 0, cameraPos.z);
  }
}

/**
 * Mountain ranges on the horizon, 9 km out all round: two overlapping ridgelines
 * (a nearer, darker one and a taller, paler one behind), forested low down,
 * bare rock higher, a little snow only on the very tops. The haze does the
 * rest, turning them blue with distance.
 */
function farRanges(): THREE.Mesh {
  const n = new Noise2D(9071);
  const SEG = 360;
  const rows = [0, 0.2, 0.45, 0.7, 0.88, 1];
  const pos: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  const forest = new THREE.Color(0x3d5a34);
  const rock = new THREE.Color(0x6a6862);
  const snow = new THREE.Color(0xe8ecef);
  const c = new THREE.Color();
  const layer = (R: number, base: number, amp: number, seed: number) => {
    const start = pos.length / 3;
    for (let i = 0; i <= SEG; i++) {
      const a = (i / SEG) * Math.PI * 2;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      const ridge = 1 - Math.abs(n.fbm(ca * 3.2 + seed, sa * 3.2 - seed, 4));
      const top = base + amp * (ridge * ridge * 0.8 + 0.25 * (n.fbm(ca * 9 + seed, sa * 9, 3) * 0.5 + 0.5));
      for (const r of rows) {
        const y = -120 + (top + 120) * r;
        // Slight bulge towards the camera low down, so the faces catch the light.
        const rr = R - (1 - r) * 500;
        pos.push(ca * rr, y, sa * rr);
        const t = y / Math.max(top, 1);
        c.copy(forest).lerp(rock, THREE.MathUtils.smoothstep(t, 0.35, 0.8));
        if (y > 1050) c.lerp(snow, THREE.MathUtils.smoothstep(y, 1050, 1250) * 0.7);
        col.push(c.r, c.g, c.b);
      }
    }
    const R2 = rows.length;
    for (let i = 0; i < SEG; i++)
      for (let k = 0; k < R2 - 1; k++) {
        const a = start + i * R2 + k;
        const b = start + (i + 1) * R2 + k;
        idx.push(a, a + 1, b, b, a + 1, b + 1);
      }
  };
  layer(9200, 520, 760, 5.3);
  layer(8600, 260, 520, 17.9);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }));
  mesh.frustumCulled = false;
  mesh.renderOrder = -1;
  return mesh;
}

const SKY_FRAG = /* glsl */ `
uniform vec3 top;
uniform vec3 horizon;
uniform vec3 sunHaze;
uniform vec3 sunDir;
uniform float time;
varying vec3 vDir;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) {
  float s = 0.0;
  float a = 0.5;
  for (int i = 0; i < 5; i++) {
    s += a * noise(p);
    p = p * 2.03 + vec2(1.7, 9.2);
    a *= 0.5;
  }
  return s;
}
float clouds(vec2 p) {
  // Broad coverage pattern times puffy detail: scattered cumulus, plenty of blue sky.
  float cover = smoothstep(0.4, 0.7, fbm(p * 0.22 + 3.0));
  float puff = fbm(p * 1.3);
  return smoothstep(0.5, 0.78, puff * 0.8 + cover * 0.5);
}

void main() {
  vec3 d = normalize(vDir);
  float h = max(d.y, 0.0);
  float sunAmt = max(dot(d, sunDir), 0.0);
  // Deep blue overhead, paling to the haze at the horizon, warmer toward the sun.
  vec3 hz = mix(horizon, sunHaze, pow(sunAmt, 4.0) * 0.6);
  vec3 col = mix(hz, top, pow(h, 0.45));
  col = mix(col, hz * 1.04, exp(-h * 18.0) * 0.6);

  if (d.y > 0.0) {
    // Cloud layer: project onto a plane overhead, drifting with the wind.
    vec2 uv = d.xz / (d.y + 0.12) * 4.2 + vec2(time * 0.006, time * 0.002);
    float c = clouds(uv);
    // Light from the sun side: sample a little toward the sun; denser there = shadowed.
    float toward = clouds(uv + sunDir.xz * 0.06);
    float lit = clamp(0.62 + (c - toward) * 1.8, 0.0, 1.0);
    vec3 cloudCol = mix(vec3(0.66, 0.71, 0.8), vec3(1.05, 1.02, 0.97), lit);
    cloudCol += vec3(1.0, 0.9, 0.75) * pow(sunAmt, 12.0) * 0.4;
    float fade = smoothstep(0.02, 0.2, d.y);
    col = mix(col, mix(hz, cloudCol, 0.35 + 0.65 * fade), c * fade * 0.95);
  }
  col += vec3(1.0, 0.88, 0.65) * (pow(sunAmt, 900.0) * 6.0 + pow(sunAmt, 24.0) * 0.18);
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;
