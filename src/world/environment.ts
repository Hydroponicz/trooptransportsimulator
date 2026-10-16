import * as THREE from 'three';
import { CLOUD_BASE, CLOUD_COVER_GLSL, CLOUD_SHIFT, CLOUD_TOP, FOG_RANGE, FOG_SCALE_HEIGHT, HAZE, SKY_TOP, SUN_COLOR, SUN_DIR, SUN_HAZE } from './look';
import { Noise2D } from '../util/noise';
import { cloudNoiseTexture } from '../util/textures';

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
  /**
   * The clouds change slowly, so instead of marching through them for every
   * sky pixel every frame they are rendered into a sky panorama (x =
   * azimuth, y = sqrt of the sine of the elevation, so the horizon gets the
   * most texels): the light they scatter toward the camera (rgb) and how much
   * of the sky behind shows through (a). The panorama is refreshed a band at
   * a time, all of it every few frames.
   */
  private cloudRT: THREE.WebGLRenderTarget;
  private cloudMat: THREE.ShaderMaterial;
  private cloudScene = new THREE.Scene();
  private cloudCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private noise = cloudNoiseTexture();
  private slice = 0;
  private slices = 8;
  private fresh = false;
  private blank = true;
  /** Band where the current full redraw began. */
  private restart = 0;
  private steps = -1;
  private camPos = new THREE.Vector3(0, 300, 0);
  private time = 0;

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
        cloudTex: { value: null },
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

    this.cloudMat = new THREE.ShaderMaterial({
      uniforms: {
        time: { value: 0 },
        sunDir: { value: SUN_DIR },
        noiseTex: { value: this.noise },
        camPos: { value: this.camPos },
        shift: { value: new THREE.Vector2() },
        sunCol: { value: SUN_COLOR.clone().multiplyScalar(1.0) },
        skyTop: { value: SKY_TOP.clone() },
        haze: { value: HAZE.clone() },
        sunHaze: { value: SUN_HAZE.clone() },
      },
      defines: { STEPS: 0, LSTEPS: 0 },
      vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: CLOUD_FRAG,
      depthTest: false,
      depthWrite: false,
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.cloudMat);
    quad.frustumCulled = false;
    this.cloudScene.add(quad);
    this.cloudRT = this.makeRT(1024, 256);
    this.setCloudQuality(48);

    this.ranges = farRanges();
    scene.add(this.ranges);
  }

  private makeRT(w: number, h: number) {
    const rt = new THREE.WebGLRenderTarget(w, h, {
      depthBuffer: false,
      type: THREE.HalfFloatType,
      magFilter: THREE.LinearFilter,
      minFilter: THREE.LinearFilter,
      wrapS: THREE.RepeatWrapping,
      generateMipmaps: false,
    });
    rt.scissorTest = true;
    return rt;
  }

  /**
   * Cloud detail: steps marched through the layer per texel (more = smoother,
   * finer clouds; 0 = flat painted clouds for slow GPUs).
   */
  setCloudQuality(steps: number) {
    if (steps === this.steps) return;
    this.steps = steps;
    const [w, h] = steps >= 32 ? [2048, 512] : steps > 0 ? [1536, 384] : [1024, 256];
    if (this.cloudRT.width !== w) {
      this.cloudRT.dispose();
      this.cloudRT = this.makeRT(w, h);
    }
    this.skyMat.uniforms.cloudTex.value = this.cloudRT.texture;
    this.cloudMat.defines.STEPS = steps;
    this.cloudMat.defines.LSTEPS = steps >= 32 ? 4 : 3;
    this.cloudMat.needsUpdate = true;
    this.slices = steps >= 32 ? 48 : steps > 0 ? 32 : 4;
    this.slice = 0;
    this.blank = true;
    this.redraw();
  }

  private redraw() {
    this.fresh = false;
    this.restart = this.slice;
  }

  /** Drift the clouds and refresh a strip of the cloud panorama (four a frame while it is redrawn). */
  update(dt: number, renderer?: THREE.WebGLRenderer) {
    this.time += dt;
    // The cumulus drift with the upper wind.
    CLOUD_SHIFT.x += 7 * dt;
    CLOUD_SHIFT.y += 2.5 * dt;
    if (!renderer) return;
    const u = this.cloudMat.uniforms;
    u.time.value = this.time;
    u.shift.value.set(CLOUD_SHIFT.x, CLOUD_SHIFT.y);
    const rt = this.cloudRT;
    const prev = renderer.getRenderTarget();
    if (this.blank) {
      // New panorama: start from a clear sky.
      this.blank = false;
      rt.scissor.set(0, 0, rt.width, rt.height);
      const cc = renderer.getClearColor(new THREE.Color());
      const ca = renderer.getClearAlpha();
      renderer.setRenderTarget(rt);
      renderer.setClearColor(0x000000, 1);
      renderer.clear(true, false, false);
      renderer.setClearColor(cc, ca);
    }
    // One strip of azimuth a frame, horizon to zenith, so every frame costs the same
    // (rows near the horizon march far further than those overhead). After a jump, a few.
    const per = this.fresh ? 1 : 4;
    const strip = Math.ceil(rt.width / this.slices);
    for (let n = 0; n < per; n++) {
      rt.scissor.set(this.slice * strip, 0, strip, rt.height);
      rt.viewport.set(0, 0, rt.width, rt.height);
      renderer.setRenderTarget(rt);
      renderer.render(this.cloudScene, this.cloudCam);
      this.slice = (this.slice + 1) % this.slices;
      if (this.slice === this.restart) this.fresh = true;
    }
    renderer.setRenderTarget(prev);
  }

  /** Keep the shadow frustum centered on the area of interest. */
  follow(target: THREE.Vector3, cameraPos: THREE.Vector3) {
    this.sun.target.position.copy(target);
    this.sun.position.copy(target).addScaledVector(SUN_DIR, 400);
    this.sky.position.copy(cameraPos);
    // A jump (respawn, map teleport): redraw the whole panorama, not a band.
    if (this.camPos.distanceToSquared(cameraPos) > 300 * 300) this.redraw();
    this.camPos.copy(cameraPos);
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

/**
 * Cloud panorama pass. Each texel marches its view ray through the cumulus
 * layer: coverage from the shared cover field (look.ts) sets where clouds
 * grow and how tall; 3D Perlin-Worley noise gives them billowy shape, eroded
 * at the edges by finer cellular noise. Each sample is lit by a short march
 * toward the sun (Beer's law, plus a softer term standing in for light
 * scattered many times inside the cloud), a two-lobed phase function (the
 * bright silver lining toward the sun) and sky light from above. Distant
 * clouds sink into the horizon haze.
 */
const CLOUD_FRAG = /* glsl */ `
precision highp float;
precision highp sampler3D;
uniform float time;
uniform vec3 sunDir;
uniform sampler3D noiseTex;
uniform vec3 camPos;
uniform vec2 shift;
uniform vec3 sunCol;
uniform vec3 skyTop;
uniform vec3 haze;
uniform vec3 sunHaze;
varying vec2 vUv;
${CLOUD_COVER_GLSL}
#define BASE ${CLOUD_BASE.toFixed(1)}
#define TOP ${CLOUD_TOP.toFixed(1)}

float hg(float c, float g) {
  float g2 = g * g;
  return (1.0 - g2) / pow(1.0 + g2 - 2.0 * g * c, 1.5);
}

float density(vec3 p, float cov, bool detail) {
  float h = (p.y - BASE) / (TOP - BASE);
  // Taller towers where the cover is thick; flat bases, rounded tops.
  float top = 0.25 + 0.75 * cov;
  float prof = smoothstep(0.0, 0.06, h) * (1.0 - smoothstep(top * 0.45, top, h));
  vec3 q = vec3(p.x + shift.x, p.y - time * 0.6, p.z + shift.y) * (1.0 / 2100.0);
  float sh = texture(noiseTex, q).r * 0.75 + texture(noiseTex, q * 2.7 + 0.31).r * 0.25;
  float c = 0.1 + 0.6 * cov;
  float d = clamp((sh * prof - (1.0 - c)) / c, 0.0, 1.0);
  if (detail && d > 0.0) {
    // Cauliflower billows on top, ragged wisps underneath.
    float det = texture(noiseTex, q * 6.3 + vec3(time * 0.0015, 0.0, 0.0)).g;
    det = mix(1.0 - det, det, smoothstep(0.1, 0.5, h));
    d = clamp((d - det * 0.38) / 0.62, 0.0, 1.0);
  }
  return d;
}

void main() {
  float az = (vUv.x - 0.5) * 6.2831853;
  float se = vUv.y * vUv.y;
  float ce = sqrt(max(0.0, 1.0 - se * se));
  vec3 d = vec3(ce * cos(az), se, ce * sin(az));
  vec3 o = camPos;
  o.y = min(o.y, BASE - 60.0);
  vec4 res = vec4(0.0, 0.0, 0.0, 1.0);
  float sunAmt = max(dot(normalize(vec3(d.x, 0.02, d.z)), sunDir), 0.0);
  vec3 hz = mix(haze, sunHaze, pow(sunAmt, 4.0) * 0.6);
  if (d.y > 0.004) {
    float t0 = (BASE - o.y) / d.y;
    float t1 = (TOP - o.y) / d.y;
#if STEPS > 0
    if (t0 < 70000.0) {
      t1 = min(t1, t0 + 14000.0);
      float dt = (t1 - t0) / float(STEPS);
      float t = t0 + dt * cloudHash(gl_FragCoord.xy * 1.37);
      float T = 1.0;
      vec3 L = vec3(0.0);
      float tHit = 0.0;
      float wHit = 0.0;
      float cosT = dot(d, sunDir);
      float phase = mix(hg(cosT, 0.6), hg(cosT, -0.25), 0.4);
      const float SIG = 0.04;
      for (int i = 0; i < STEPS; i++) {
        vec3 p = o + d * t;
        vec2 cq = p.xz + shift;
        float cov = cloudCover(cq);
        if (cov > 0.02) {
          float dens = density(p, cov, true);
          if (dens > 0.004) {
            float ld = 0.0;
            float ls = 60.0;
            vec3 lp = p;
            for (int j = 0; j < LSTEPS; j++) {
              lp += sunDir * ls;
              ld += density(lp, cov, false) * ls;
              ls *= 1.75;
            }
            float h = clamp((p.y - BASE) / (TOP - BASE), 0.0, 1.0);
            float beer = exp(-ld * SIG) + 0.35 * exp(-ld * SIG * 0.18);
            float powder = mix(1.0, 1.0 - exp(-ld * SIG * 2.0 - 0.15), 0.6 * (1.0 - max(cosT, 0.0)));
            vec3 amb = mix(haze * 0.55, skyTop * 0.9 + vec3(0.32, 0.34, 0.38), h);
            vec3 lum = sunCol * beer * powder * phase * 1.35 + amb;
            float ext = dens * SIG;
            float Ts = exp(-ext * dt);
            float w = T * (1.0 - Ts);
            L += lum * w;
            tHit += t * w;
            wHit += w;
            T *= Ts;
            if (T < 0.015) break;
          }
        }
        t += dt;
      }
      float dist = wHit > 0.0 ? tHit / wHit : t0;
      // Aerial perspective: far clouds fade into the haze.
      float k = exp(-dist / 24000.0);
      L = mix(hz * (1.0 - T), L, k);
      res = vec4(L, T);
    }
#else
    // Painted fallback: the cover field on a plane, given body by the noise.
    vec2 cq = o.xz + d.xz * min(t0, 60000.0) + shift;
    float cov = cloudCover(cq);
    float sh = texture(noiseTex, vec3(cq * (1.0 / 2100.0), 0.3)).r;
    float c = 0.1 + 0.6 * cov;
    float a = clamp((sh - (1.0 - c)) / c * 2.2, 0.0, 1.0);
    float lit = texture(noiseTex, vec3((cq + sunDir.xz * 300.0) * (1.0 / 2100.0), 0.3)).r;
    vec3 col = mix(vec3(0.62, 0.67, 0.76), vec3(1.15, 1.1, 1.02), clamp(0.7 + (sh - lit) * 3.0, 0.0, 1.0));
    float k = exp(-t0 / 24000.0);
    col = mix(hz, col, k);
    res = vec4(col * a, 1.0 - a);
#endif
  }
  gl_FragColor = res;
}`;

const SKY_FRAG = /* glsl */ `
uniform vec3 top;
uniform vec3 horizon;
uniform vec3 sunHaze;
uniform vec3 sunDir;
uniform sampler2D cloudTex;
varying vec3 vDir;

void main() {
  vec3 d = normalize(vDir);
  float h = max(d.y, 0.0);
  float sunAmt = max(dot(d, sunDir), 0.0);
  // Deep blue overhead, paling to the haze at the horizon, warmer toward the sun.
  vec3 hz = mix(horizon, sunHaze, pow(sunAmt, 4.0) * 0.6);
  vec3 col = mix(hz, top, pow(h, 0.45));
  col = mix(col, hz * 1.04, exp(-h * 18.0) * 0.6);
  // Richer blue at right angles to the sun (Rayleigh), a soft aureole round it (Mie).
  float c = dot(d, sunDir);
  col *= 1.0 - 0.08 * (1.0 - c * c) * smoothstep(0.1, 0.6, h);
  col += sunHaze * (pow(sunAmt, 10.0) * 0.22 + pow(sunAmt, 60.0) * 0.35);

  float vis = 1.0;
  if (d.y > 0.0) {
    vec4 cl = texture2D(cloudTex, vec2(atan(d.z, d.x) / 6.2831853 + 0.5, sqrt(h)));
    cl = mix(vec4(0.0, 0.0, 0.0, 1.0), cl, smoothstep(0.0, 0.012, h));
    col = col * cl.a + cl.rgb;
    vis = cl.a * cl.a * cl.a;
  }
  // The sun's disc, slightly darker at its limb.
  float disc = smoothstep(0.99985, 0.99993, c);
  col += vec3(1.0, 0.9, 0.72) * (disc * 18.0 * (0.75 + 0.25 * smoothstep(0.99985, 1.0, c))) * vis;
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;
