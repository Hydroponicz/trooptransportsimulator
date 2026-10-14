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
  drag?: number;
  /** Upward acceleration (negative = falls). */
  buoyancy?: number;
  /** Pushed around by rotor downwash. */
  wash?: number;
  /** Multiply color toward this at end of life. */
  r1?: number;
  g1?: number;
  b1?: number;
}

export interface Downwash {
  active: boolean;
  x: number;
  y: number;
  z: number;
  ground: number;
  strength: number;
}

/** Pool-based camera-facing particles in a single draw call. */
export class ParticleSystem {
  readonly points: THREE.Points;
  private n: number;
  private pos: Float32Array;
  private col: Float32Array;
  private size: Float32Array;
  private vel: Float32Array;
  private life: Float32Array;
  private maxLife: Float32Array;
  private s0: Float32Array;
  private s1: Float32Array;
  private c0: Float32Array;
  private c1: Float32Array;
  private a0: Float32Array;
  private fade: Float32Array;
  private drag: Float32Array;
  private buoy: Float32Array;
  private wash: Float32Array;
  private cursor = 0;
  private material: THREE.ShaderMaterial;
  alive = 0;

  constructor(max: number, texture: THREE.Texture, additive: boolean) {
    this.n = max;
    this.pos = new Float32Array(max * 3);
    this.col = new Float32Array(max * 4);
    this.size = new Float32Array(max);
    this.vel = new Float32Array(max * 3);
    this.life = new Float32Array(max);
    this.maxLife = new Float32Array(max);
    this.s0 = new Float32Array(max);
    this.s1 = new Float32Array(max);
    this.c0 = new Float32Array(max * 3);
    this.c1 = new Float32Array(max * 3);
    this.a0 = new Float32Array(max);
    this.fade = new Float32Array(max);
    this.drag = new Float32Array(max);
    this.buoy = new Float32Array(max);
    this.wash = new Float32Array(max);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('pcolor', new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('size', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    this.material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      uniforms: {
        map: { value: texture },
        scale: { value: 600 },
        fogColor: { value: new THREE.Color() },
        fogNear: { value: 900 },
        fogFar: { value: 7500 },
        additive: { value: additive ? 1 : 0 },
      },
      vertexShader: /* glsl */ `
        attribute float size; attribute vec4 pcolor;
        uniform float scale;
        varying vec4 vColor; varying float vDepth;
        void main() {
          vColor = pcolor;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vDepth = -mv.z;
          gl_PointSize = size * scale / max(0.5, -mv.z);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D map; uniform vec3 fogColor; uniform float fogNear; uniform float fogFar; uniform float additive;
        varying vec4 vColor; varying float vDepth;
        void main() {
          vec4 t = texture2D(map, gl_PointCoord);
          float a = vColor.a * t.a;
          if (a < 0.004) discard;
          float f = smoothstep(fogNear, fogFar, vDepth);
          vec3 c = vColor.rgb * t.rgb;
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
    this.material.uniforms.fogNear.value = fog.near;
    this.material.uniforms.fogFar.value = fog.far;
  }

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
    this.drag[i] = o.drag ?? 0.5;
    this.buoy[i] = o.buoyancy ?? 0;
    this.wash[i] = o.wash ?? 0;
  }

  update(dt: number, dw: Downwash | null) {
    let alive = 0;
    const { pos, vel, life, col, size } = this;
    for (let i = 0; i < this.n; i++) {
      if (life[i] <= 0) continue;
      life[i] -= dt;
      const p = i * 3;
      if (life[i] <= 0) {
        pos[p + 1] = -1e5;
        col[i * 4 + 3] = 0;
        continue;
      }
      alive++;
      const t = 1 - life[i] / this.maxLife[i];
      const dr = Math.exp(-this.drag[i] * dt);
      vel[p] *= dr;
      vel[p + 1] = vel[p + 1] * dr + this.buoy[i] * dt;
      vel[p + 2] *= dr;
      if (dw && dw.active && this.wash[i] > 0) {
        const dx = pos[p] - dw.x;
        const dz = pos[p + 2] - dw.z;
        const d2 = dx * dx + dz * dz;
        const below = dw.y - pos[p + 1];
        if (d2 < 1600 && below > -4) {
          const d = Math.sqrt(d2) + 0.5;
          const fall = Math.max(0, 1 - d / 40) * dw.strength * this.wash[i];
          const nearGround = pos[p + 1] - dw.ground < 6;
          vel[p] += (dx / d) * fall * (nearGround ? 60 : 15) * dt;
          vel[p + 2] += (dz / d) * fall * (nearGround ? 60 : 15) * dt;
          vel[p + 1] += (nearGround ? 4 : -25) * fall * dt;
        }
      }
      pos[p] += vel[p] * dt;
      pos[p + 1] += vel[p + 1] * dt;
      pos[p + 2] += vel[p + 2] * dt;
      const fi = this.fade[i];
      const a = this.a0[i] * Math.min(1, t / Math.max(0.001, fi)) * (1 - Math.max(0, (t - 0.4) / 0.6));
      const c = i * 4;
      col[c] = this.c0[p] + (this.c1[p] - this.c0[p]) * t;
      col[c + 1] = this.c0[p + 1] + (this.c1[p + 1] - this.c0[p + 1]) * t;
      col[c + 2] = this.c0[p + 2] + (this.c1[p + 2] - this.c0[p + 2]) * t;
      col[c + 3] = a;
      size[i] = this.s0[i] + (this.s1[i] - this.s0[i]) * Math.sqrt(t);
    }
    this.alive = alive;
    const g = this.points.geometry;
    (g.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (g.getAttribute('pcolor') as THREE.BufferAttribute).needsUpdate = true;
    (g.getAttribute('size') as THREE.BufferAttribute).needsUpdate = true;
  }
}
