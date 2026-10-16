import * as THREE from 'three';

export interface EmitOpts {
  x: number;
  y: number;
  z: number;
  vx?: number;
  vy?: number;
  vz?: number;
  life: number;
  size0: number;
  size1: number;
  r: number;
  g: number;
  b: number;
  alpha: number;
  /** Fraction of life spent fading in. */
  fadeIn?: number;
  /** Fraction of life spent fading out (at the end). */
  fadeOut?: number;
  /** How quickly it takes up the air's motion (wind, wash), 1/s. */
  drag?: number;
  /** Upward acceleration (negative = falls). Positive lift dies away over the particle's life (the smoke cools). */
  buoyancy?: number;
  /** Pushed around by rotor downwash. */
  wash?: number;
  /** Multiply color toward this at end of life. */
  r1?: number;
  g1?: number;
  b1?: number;
  /** Lit from below by fire for its first second or so (0..1). */
  heat?: number;
  /** Slides along buildings and the ground instead of passing through (default: the system's setting). */
  collide?: boolean;
  /** Scale on the swirl of the air (default 1). */
  turb?: number;
}

/** The rotor's wake: a column of air driven down through the disc that fans out across the surface below. */
export interface Downwash {
  active: boolean;
  x: number;
  y: number;
  z: number;
  /** Surface under the rotor (ground, water or roof). */
  ground: number;
  /** 0..~1.3: thrust against weight, times rotor RPM. */
  strength: number;
  /** Rotor disc radius (m). */
  radius: number;
  /** Air speed through the disc at full strength (m/s). */
  vi: number;
}

/** What the particles collide with. */
export interface ParticleEnv {
  /** Ground or water height. */
  ground(x: number, z: number): number;
  /** Nothing is solid above this height near (x, z). */
  ceiling(x: number, z: number): number;
  /** The building/structure box the point is inside, if any. */
  solid(p: THREE.Vector3): { minX: number; maxX: number; minZ: number; maxZ: number; maxY: number } | null;
}

export interface ParticleFrame {
  dw: Downwash | null;
  wind: THREE.Vector3;
  camera: THREE.Camera;
  env: ParticleEnv | null;
  time: number;
}

/** Only particles this close to the camera are tested against buildings (the ground is always tested). */
const COLLIDE_RANGE = 900;
const BUCKETS = 1024;
const _p = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _v = new THREE.Vector3();

/**
 * Pool-based camera-facing particles in a single draw call.
 *
 * Lit smoke: each sprite is a cell of a billow atlas whose RGB holds the
 * puff's surface normal and A its density, turned to a random angle. The
 * fragment shader lights it with the sun (wrapped, thinner at the sunlit
 * edge, glowing through the thin parts when the sun is behind it), the sky
 * from above and the ground's bounce from below, plus the fire's glow on
 * young smoke. Particles are sorted back to front every frame.
 *
 * Motion: each particle relaxes toward the air's velocity (wind, stronger
 * with height, plus a slow swirl, plus the rotor's wake) at its drag rate.
 * Smoke slides along the ground and around buildings: a move that would end
 * inside one is split by axis, the blocked part of the velocity turned along
 * the wall (toward the nearer corner, and up), so wash-driven smoke spills
 * round a building rather than through it.
 */
export class ParticleSystem {
  readonly points: THREE.Points;
  private n: number;
  private pos: Float32Array;
  private col: Float32Array;
  private size: Float32Array;
  private data: Float32Array;
  private vel: Float32Array;
  private life: Float32Array;
  private maxLife: Float32Array;
  private s0: Float32Array;
  private s1: Float32Array;
  private c0: Float32Array;
  private c1: Float32Array;
  private a0: Float32Array;
  private fade: Float32Array;
  private fadeOut: Float32Array;
  private drag: Float32Array;
  private buoy: Float32Array;
  private wash: Float32Array;
  private heat: Float32Array;
  private spin: Float32Array;
  private turb: Float32Array;
  private coll: Uint8Array;
  /** Ground under each particle, refreshed every few frames. */
  private gnd: Float32Array;
  private frame = 0;
  private index: Uint32Array;
  private depthKey: Uint16Array;
  private alive_: Uint32Array;
  private counts = new Uint32Array(BUCKETS);
  private cursor = 0;
  private material: THREE.ShaderMaterial;
  private collideDefault: boolean;
  alive = 0;
  /** Scale on how far from the camera particles collide (graphics quality). */
  collideRange = COLLIDE_RANGE;

  constructor(max: number, texture: THREE.Texture, additive: boolean, opts: { lit?: boolean; cells?: number; collide?: boolean } = {}) {
    this.n = max;
    this.collideDefault = opts.collide ?? false;
    this.pos = new Float32Array(max * 3);
    this.col = new Float32Array(max * 4);
    this.size = new Float32Array(max);
    this.data = new Float32Array(max * 4);
    this.vel = new Float32Array(max * 3);
    this.life = new Float32Array(max);
    this.maxLife = new Float32Array(max);
    this.s0 = new Float32Array(max);
    this.s1 = new Float32Array(max);
    this.c0 = new Float32Array(max * 3);
    this.c1 = new Float32Array(max * 3);
    this.a0 = new Float32Array(max);
    this.fade = new Float32Array(max);
    this.fadeOut = new Float32Array(max);
    this.drag = new Float32Array(max);
    this.buoy = new Float32Array(max);
    this.wash = new Float32Array(max);
    this.heat = new Float32Array(max);
    this.spin = new Float32Array(max);
    this.turb = new Float32Array(max);
    this.coll = new Uint8Array(max);
    this.gnd = new Float32Array(max);
    this.index = new Uint32Array(max);
    this.depthKey = new Uint16Array(max);
    this.alive_ = new Uint32Array(max);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('pcolor', new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('size', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('pdata', new THREE.BufferAttribute(this.data, 4).setUsage(THREE.DynamicDrawUsage));
    geo.setIndex(new THREE.BufferAttribute(this.index, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setDrawRange(0, 0);
    const cells = opts.cells ?? 1;
    this.material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      defines: { LIT: opts.lit ? 1 : 0, CELLS: cells.toFixed(1) },
      uniforms: {
        map: { value: texture },
        scale: { value: 600 },
        fogColor: { value: new THREE.Color() },
        fogNear: { value: 900 },
        fogFar: { value: 7500 },
        additive: { value: additive ? 1 : 0 },
        sunV: { value: new THREE.Vector3(0, 1, 0) },
        upV: { value: new THREE.Vector3(0, 1, 0) },
        sunCol: { value: new THREE.Color(1.0, 0.93, 0.8) },
        skyCol: { value: new THREE.Color(0.58, 0.66, 0.78) },
        groundCol: { value: new THREE.Color(0.32, 0.3, 0.26) },
        heatCol: { value: new THREE.Color(1.6, 0.62, 0.18) },
      },
      vertexShader: /* glsl */ `
        attribute float size; attribute vec4 pcolor; attribute vec4 pdata;
        uniform float scale;
        varying vec4 vColor; varying vec4 vData; varying float vDepth; varying float vSize;
        void main() {
          vColor = pcolor;
          vData = pdata;
          vSize = size;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vDepth = -mv.z;
          gl_PointSize = size * scale / max(0.5, -mv.z);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D map; uniform vec3 fogColor; uniform float fogNear; uniform float fogFar; uniform float additive;
        uniform vec3 sunV; uniform vec3 upV; uniform vec3 sunCol; uniform vec3 skyCol; uniform vec3 groundCol; uniform vec3 heatCol;
        varying vec4 vColor; varying vec4 vData; varying float vDepth; varying float vSize;
        void main() {
          vec2 pc = gl_PointCoord - 0.5;
          pc.y = -pc.y;
          float ca = cos(vData.x);
          float sa = sin(vData.x);
          vec2 rc = vec2(ca * pc.x - sa * pc.y, sa * pc.x + ca * pc.y);
          if (dot(rc, rc) > 0.25) discard;
          float cell = vData.y;
          vec2 cxy = vec2(mod(cell, CELLS), floor(cell / CELLS));
          vec4 t = texture2D(map, (rc + 0.5 + cxy) / CELLS);
          float a = vColor.a * t.a;
          // Fade puffs the camera is inside rather than letting them fill the screen.
          a *= smoothstep(vSize * 0.12, vSize * 0.6, vDepth);
          if (a < 0.004) discard;
          float f = smoothstep(fogNear, fogFar, vDepth);
          #if LIT
            vec3 n = t.rgb * 2.0 - 1.0;
            n.xy = vec2(ca * n.x + sa * n.y, -sa * n.x + ca * n.y);
            n = normalize(n);
            float thick = t.a;
            float wrap = clamp(dot(n, sunV) * 0.55 + 0.45, 0.0, 1.0);
            // Sun behind the puff: light comes through its thin edges.
            float behind = pow(max(0.0, -sunV.z), 3.0);
            float sky = dot(n, upV) * 0.5 + 0.5;
            vec3 amb = mix(groundCol, skyCol, sky);
            vec3 light = amb * 0.55 + sunCol * (wrap * wrap * (0.95 - 0.35 * thick) + behind * (1.0 - thick) * 0.55);
            vec3 c = vColor.rgb * light + heatCol * vData.z * (0.35 + 0.65 * (1.0 - sky)) ;
          #else
            vec3 c = vColor.rgb * t.rgb;
          #endif
          if (additive > 0.5) { a *= 1.0 - f; }
          else { c = mix(c, fogColor, f); }
          gl_FragColor = vec4(c, a);
        }`,
    });
    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
    for (let i = 0; i < max; i++) this.pos[i * 3 + 1] = -1e5;
  }

  setView(viewportHeight: number, fovDeg: number, fog: THREE.Fog) {
    this.material.uniforms.scale.value = viewportHeight / (2 * Math.tan((fovDeg * Math.PI) / 360));
    this.material.uniforms.fogColor.value.copy(fog.color);
    // The scene fog is a height fog (see world/look.ts); particles use a simple linear fade.
    this.material.uniforms.fogNear.value = 900;
    this.material.uniforms.fogFar.value = 9000;
  }

  /** World sun direction, for lighting. */
  sunDir = new THREE.Vector3(0, 1, 0);

  emit(o: EmitOpts) {
    // Find a dead slot near the cursor; overwrite the oldest if full.
    let i = this.cursor;
    for (let k = 0; k < 64; k++) {
      const j = (this.cursor + k) % this.n;
      if (this.life[j] <= 0) {
        i = j;
        break;
      }
    }
    this.cursor = (i + 1) % this.n;
    const p = i * 3;
    this.pos[p] = o.x;
    this.pos[p + 1] = o.y;
    this.pos[p + 2] = o.z;
    this.vel[p] = o.vx ?? 0;
    this.vel[p + 1] = o.vy ?? 0;
    this.vel[p + 2] = o.vz ?? 0;
    this.life[i] = o.life;
    this.maxLife[i] = o.life;
    this.s0[i] = o.size0;
    this.s1[i] = o.size1;
    this.c0[p] = o.r;
    this.c0[p + 1] = o.g;
    this.c0[p + 2] = o.b;
    this.c1[p] = o.r1 ?? o.r;
    this.c1[p + 1] = o.g1 ?? o.g;
    this.c1[p + 2] = o.b1 ?? o.b;
    this.a0[i] = o.alpha;
    this.fade[i] = o.fadeIn ?? 0.1;
    this.fadeOut[i] = o.fadeOut ?? 0.6;
    this.drag[i] = o.drag ?? 0.5;
    this.buoy[i] = o.buoyancy ?? 0;
    this.wash[i] = o.wash ?? 0;
    this.heat[i] = o.heat ?? 0;
    this.turb[i] = o.turb ?? 1;
    this.coll[i] = (o.collide ?? this.collideDefault) ? 1 : 0;
    this.gnd[i] = NaN;
    const h = Math.sin(i * 12.9898 + o.x * 0.37) * 43758.5453;
    const rnd = h - Math.floor(h);
    this.data[i * 4] = rnd * 6.2832;
    this.data[i * 4 + 1] = (i * 7 + Math.floor(rnd * 97)) % 4;
    // Big puffs turn slowly.
    this.spin[i] = (rnd - 0.5) * (1.2 / (1 + o.size0 * 0.25));
  }

  update(dt: number, fr: ParticleFrame) {
    let alive = 0;
    const { pos, vel, life, col, size, data } = this;
    const dw = fr.dw && fr.dw.active ? fr.dw : null;
    const wx = fr.wind.x;
    const wz = fr.wind.z;
    const T = fr.time;
    const cam = fr.camera.position;
    fr.camera.getWorldDirection(_fwd);
    const env = fr.env;
    const cr2 = this.collideRange * this.collideRange;
    const aliveIdx = this.alive_;
    const keys = this.depthKey;
    let maxD = 1;
    const frame = this.frame++;
    for (let i = 0; i < this.n; i++) {
      if (life[i] <= 0) continue;
      life[i] -= dt;
      const p = i * 3;
      if (life[i] <= 0) {
        pos[p + 1] = -1e5;
        col[i * 4 + 3] = 0;
        continue;
      }
      const t = 1 - life[i] / this.maxLife[i];
      const sz = this.s0[i] + (this.s1[i] - this.s0[i]) * Math.sqrt(t);
      let x = pos[p];
      let y = pos[p + 1];
      let z = pos[p + 2];
      let vx = vel[p];
      let vy = vel[p + 1];
      let vz = vel[p + 2];
      const dr = this.drag[i];
      let g = this.gnd[i];
      if (env && ((i + frame) & 3) === 0) g = this.gnd[i] = env.ground(x, z);
      else if (g !== g) g = this.gnd[i] = env ? env.ground(x, z) : y - 30;
      const agl = y - g;

      // The air's velocity here: wind (stronger with height), swirl, rotor wake.
      const hk = (0.55 + 0.45 * Math.min(1, Math.max(0, agl) / 60)) * (1 + Math.max(0, agl) / 700);
      let ax = wx * hk;
      let ay = 0;
      let az = wz * hk;
      const tb = this.turb[i] * (1 + sz * 0.04);
      if (tb > 0) {
        const ph = i * 0.731;
        ax += tb * Math.sin(y * 0.11 + z * 0.071 + T * 0.7 + ph) * 1.2;
        az += tb * Math.sin(x * 0.093 - y * 0.053 + T * 0.53 - ph) * 1.2;
        ay += tb * Math.sin(x * 0.061 + z * 0.057 + T * 0.6 + ph) * 0.35;
      }
      let k = 1 - Math.exp(-dr * dt);
      if (dw && this.wash[i] > 0) {
        const dx = x - dw.x;
        const dz = z - dw.z;
        const r = Math.sqrt(dx * dx + dz * dz) + 0.01;
        const R = dw.radius;
        const below = dw.y - y;
        if (r < R * 7 && below > -R * 0.4) {
          const vi = dw.vi * dw.strength;
          const hg = Math.max(0, y - dw.ground);
          // Rotor height over the surface: the wall jet only forms in ground effect.
          const ge = Math.max(0, 1 - (dw.y - dw.ground) / (R * 4.5));
          const rr = r / R;
          const column = Math.exp(-rr * rr * rr * rr) * Math.min(1, Math.max(0, (below + R * 0.4) / (R * 0.4)));
          const jet = ge * Math.exp(-hg / (R * 0.35)) * Math.min(1.6, 1 / Math.max(0.6, rr)) * Math.min(1, Math.max(0, (rr - 0.3) / 0.7));
          const roll = ge * Math.exp(-((rr - 2.6) * (rr - 2.6))) * Math.exp(-hg / R);
          const w = Math.min(1, Math.max(column, jet, roll * 0.5)) * this.wash[i];
          if (w > 0.001) {
            const out = vi * (1.25 * jet + 0.15 * column);
            const tx = (dx / r) * out;
            const tz = (dz / r) * out;
            const ty = -vi * column * (1 - 0.8 * jet) + vi * 0.3 * roll;
            ax += (tx - ax) * w;
            az += (tz - az) * w;
            ay += (ty - ay) * w;
            k = Math.max(k, 1 - Math.exp(-4 * w * dt));
          }
        }
      }
      vx += (ax - vx) * k;
      vz += (az - vz) * k;
      vy += (ay - vy) * k;
      const b = this.buoy[i];
      vy += (b > 0 ? b * (1 - t) * (1 - t) : b) * dt;

      let nx = x + vx * dt;
      let ny = y + vy * dt;
      let nz = z + vz * dt;
      if (env && this.coll[i]) {
        // Ground: settle onto it and spread out.
        const lift = Math.min(sz * 0.18, 2);
        // Close to the ground: look it up where the particle is going; higher up the cached height will do.
        const gn = (ny - g < 6 ? (this.gnd[i] = env.ground(nx, nz)) : g) + lift;
        if (ny < gn) {
          ny = gn;
          if (vy < 0) {
            const hs = Math.sqrt(vx * vx + vz * vz) + 0.01;
            const sp = -vy * 0.5;
            vx += (vx / hs) * sp;
            vz += (vz / hs) * sp;
            vy = 0;
          }
        }
        // Buildings near the camera.
        const cdx = nx - cam.x;
        const cdz = nz - cam.z;
        // Test what will be stored (float32), so a particle pressed to a wall can't round into it.
        nx = Math.fround(nx);
        ny = Math.fround(ny);
        nz = Math.fround(nz);
        if (cdx * cdx + cdz * cdz < cr2 && Math.min(y, ny) < env.ceiling(nx, nz) && env.solid(_p.set(nx, ny, nz))) {
          const inside = env.solid(_p.set(x, y, z));
          if (inside) {
            // Inside already (emitted against a wall): out through the nearest face.
            const dxm = x - inside.minX;
            const dxp = inside.maxX - x;
            const dzm = z - inside.minZ;
            const dzp = inside.maxZ - z;
            const dy = inside.maxY - y;
            const m = Math.min(dxm, dxp, dzm, dzp, dy);
            nx = x;
            ny = y;
            nz = z;
            if (m === dy) (ny = inside.maxY + 0.05), (vy = Math.max(vy, 0));
            else if (m === dxm) (nx = inside.minX - 0.05), (vx = Math.min(vx, 0));
            else if (m === dxp) (nx = inside.maxX + 0.05), (vx = Math.max(vx, 0));
            else if (m === dzm) (nz = inside.minZ - 0.05), (vz = Math.min(vz, 0));
            else (nz = inside.maxZ + 0.05), (vz = Math.max(vz, 0));
          } else {
            // Move one axis at a time; turn what is blocked along the wall.
            _p.set(x, y, z);
            _p.x = nx;
            const bx = env.solid(_p);
            if (bx) _p.x = x;
            _p.z = nz;
            const bz = env.solid(_p);
            if (bz) _p.z = z;
            _p.y = ny;
            const by = env.solid(_p);
            if (by) _p.y = y;
            if (bx) {
              const m = Math.abs(vx) * 0.8;
              const side = z > (bx.minZ + bx.maxZ) / 2 ? 1 : -1;
              vz += side * m * 0.75;
              vy += m * 0.45;
              vx *= -0.08;
            }
            if (bz) {
              const m = Math.abs(vz) * 0.8;
              const side = x > (bz.minX + bz.maxX) / 2 ? 1 : -1;
              vx += side * m * 0.75;
              vy += m * 0.45;
              vz *= -0.08;
            }
            if (by) {
              const m = Math.abs(vy) * 0.6;
              const hs = Math.sqrt(vx * vx + vz * vz);
              if (hs > 0.2) {
                vx += (vx / hs) * m;
                vz += (vz / hs) * m;
              } else {
                const ex = x - (by.minX + by.maxX) / 2;
                const ez = z - (by.minZ + by.maxZ) / 2;
                const el = Math.sqrt(ex * ex + ez * ez) + 0.01;
                vx += (ex / el) * m;
                vz += (ez / el) * m;
              }
              vy *= -0.05;
            }
            nx = _p.x;
            ny = _p.y;
            nz = _p.z;
          }
        }
      }
      pos[p] = nx;
      pos[p + 1] = ny;
      pos[p + 2] = nz;
      vel[p] = vx;
      vel[p + 1] = vy;
      vel[p + 2] = vz;

      const fi = this.fade[i];
      const fo = this.fadeOut[i];
      const a = this.a0[i] * Math.min(1, t / Math.max(0.001, fi)) * Math.min(1, (1 - t) / Math.max(0.001, fo));
      const c = i * 4;
      const tc = t * (1.6 - 0.6 * t);
      col[c] = this.c0[p] + (this.c1[p] - this.c0[p]) * tc;
      col[c + 1] = this.c0[p + 1] + (this.c1[p + 1] - this.c0[p + 1]) * tc;
      col[c + 2] = this.c0[p + 2] + (this.c1[p + 2] - this.c0[p + 2]) * tc;
      col[c + 3] = a;
      size[i] = sz;
      data[c] += this.spin[i] * dt;
      const age = this.maxLife[i] - life[i];
      data[c + 2] = this.heat[i] * Math.max(0, 1 - age / (1.6 + 0.012 * this.maxLife[i]));

      // Depth along the view, for sorting.
      const d = (nx - cam.x) * _fwd.x + (ny - cam.y) * _fwd.y + (nz - cam.z) * _fwd.z;
      if (d < -sz) continue;
      const dd = Math.sqrt(Math.max(0, d));
      if (dd > maxD) maxD = dd;
      aliveIdx[alive] = i;
      keys[alive] = Math.min(65535, dd * 64);
      alive++;
    }
    this.alive = alive;

    // Back to front: counting sort on sqrt(depth).
    const counts = this.counts;
    counts.fill(0);
    const sc = (BUCKETS - 1) / (maxD * 64);
    for (let j = 0; j < alive; j++) {
      const bk = BUCKETS - 1 - Math.floor(keys[j] * sc);
      keys[j] = bk;
      counts[bk]++;
    }
    let sum = 0;
    for (let bk = 0; bk < BUCKETS; bk++) {
      const c = counts[bk];
      counts[bk] = sum;
      sum += c;
    }
    const idx = this.index;
    for (let j = 0; j < alive; j++) idx[counts[keys[j]]++] = aliveIdx[j];

    const geo = this.points.geometry;
    geo.setDrawRange(0, alive);
    for (const name of ['position', 'pcolor', 'size', 'pdata']) {
      const at = geo.getAttribute(name) as THREE.BufferAttribute;
      at.needsUpdate = true;
    }
    geo.index!.needsUpdate = true;

    // Lighting in view space.
    const u = this.material.uniforms;
    const view = fr.camera.matrixWorldInverse;
    u.sunV.value.copy(this.sunDir).transformDirection(view);
    u.upV.value.copy(_v.set(0, 1, 0)).transformDirection(view);
  }
}
