import * as THREE from 'three';
import { ParticleSystem, type Downwash, type ParticleEnv } from './particles';
import { smokeAtlasTexture, softSpriteTexture } from '../util/textures';
import { SUN_DIR } from '../world/look';
import type { RNG } from '../util/noise';

interface Tracer {
  p: THREE.Vector3;
  v: THREE.Vector3;
  life: number;
  len: number;
  r: number;
  g: number;
  b: number;
}

const SMOKE_COLORS: Record<string, [number, number, number]> = {
  green: [0.35, 0.85, 0.35],
  red: [0.95, 0.25, 0.2],
  yellow: [0.98, 0.85, 0.25],
  purple: [0.6, 0.3, 0.85],
  white: [0.9, 0.9, 0.88],
};
/** Most burning wrecks smoking at once (the nearest). */
const MAX_PLUMES = 10;

export type SmokeColor = keyof typeof SMOKE_COLORS;

export interface SmokeEmitter {
  pos: THREE.Vector3;
  rate: number;
  color: [number, number, number];
  size: number;
  life: number;
  rise: number;
  acc: number;
  dark: boolean;
  /** signal: coloured smoke; plume: a burning wreck's fire and smoke column; trail: smoke streaming from something on fire in flight. */
  kind: 'signal' | 'plume' | 'trail';
  /** Size of the fire (plumes), 0.4..1.6. */
  scale: number;
  /** Where a moving emitter was last frame, so a trail is laid along the path. */
  last: THREE.Vector3 | null;
}

/** All transient visual effects: smoke, dust, fire, tracers, explosions, flashes. */
export class Effects {
  smoke: ParticleSystem;
  fire: ParticleSystem;
  group = new THREE.Group();
  private tracers: Tracer[] = [];
  private tracerGeo: THREE.BufferGeometry;
  private tracerPos: Float32Array;
  private tracerCol: Float32Array;
  private flash: THREE.PointLight;
  private flashT = 0;
  emitters: SmokeEmitter[] = [];
  downwash: Downwash = { active: false, x: 0, y: 0, z: 0, ground: 0, strength: 0, radius: 8, vi: 16 };
  wind = new THREE.Vector3();
  /** What smoke collides with (set once the world exists). */
  env: ParticleEnv | null = null;
  /** Scale on emission rates (graphics quality). */
  density = 1;
  private time = 0;
  private rankT = 0;
  private livePlumes = new Set<SmokeEmitter>();

  constructor(private rng: RNG) {
    this.smoke = new ParticleSystem(6000, smokeAtlasTexture(), false, { lit: true, cells: 2, collide: true });
    this.fire = new ParticleSystem(2500, softSpriteTexture(), true);
    this.smoke.sunDir.copy(SUN_DIR);
    this.smoke.points.renderOrder = 5;
    this.fire.points.renderOrder = 6;
    this.group.add(this.smoke.points, this.fire.points);
    const MAXT = 400;
    this.tracerPos = new Float32Array(MAXT * 6);
    this.tracerCol = new Float32Array(MAXT * 6);
    this.tracerGeo = new THREE.BufferGeometry();
    this.tracerGeo.setAttribute('position', new THREE.BufferAttribute(this.tracerPos, 3).setUsage(THREE.DynamicDrawUsage));
    this.tracerGeo.setAttribute('color', new THREE.BufferAttribute(this.tracerCol, 3).setUsage(THREE.DynamicDrawUsage));
    const lines = new THREE.LineSegments(
      this.tracerGeo,
      new THREE.LineBasicMaterial({ vertexColors: true, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, fog: false }),
    );
    lines.frustumCulled = false;
    this.group.add(lines);
    this.flash = new THREE.PointLight(0xffaa55, 0, 300, 1.5);
    this.group.add(this.flash);
  }

  setView(h: number, fov: number, fog: THREE.Fog) {
    this.smoke.setView(h, fov, fog);
    this.fire.setView(h, fov, fog);
  }

  tracer(p: THREE.Vector3, v: THREE.Vector3, life: number, color = 0xff6a30) {
    if (this.tracers.length >= 400) this.tracers.shift();
    const c = new THREE.Color(color);
    this.tracers.push({ p: p.clone(), v: v.clone(), life, len: Math.min(14, v.length() * 0.025), r: c.r * 3, g: c.g * 3, b: c.b * 3 });
  }

  explosion(at: THREE.Vector3, scale = 1, flash = true) {
    const r = this.rng;
    for (let i = 0; i < 26 * scale; i++) {
      const s = 14 * scale;
      this.fire.emit({
        x: at.x,
        y: at.y + 1,
        z: at.z,
        vx: r.gauss() * s,
        vy: Math.abs(r.gauss()) * s + 3,
        vz: r.gauss() * s,
        life: r.range(0.35, 0.9),
        size0: 4 * scale,
        size1: 10 * scale,
        r: 1.6,
        g: 0.9,
        b: 0.35,
        r1: 0.6,
        g1: 0.15,
        b1: 0.05,
        alpha: 1,
        fadeIn: 0.02,
        drag: 3,
      });
    }
    for (let i = 0; i < 18 * scale; i++) {
      this.smoke.emit({
        x: at.x + r.gauss() * 2 * scale,
        y: at.y + 1 + r.range(0, 3) * scale,
        z: at.z + r.gauss() * 2 * scale,
        vx: r.gauss() * 4 * scale,
        vy: r.range(2, 8) * scale,
        vz: r.gauss() * 4 * scale,
        life: r.range(3, 7),
        size0: 6 * scale,
        size1: 22 * scale,
        r: 0.16,
        g: 0.15,
        b: 0.13,
        r1: 0.42,
        g1: 0.4,
        b1: 0.37,
        alpha: 0.85,
        fadeIn: 0.05,
        drag: 1.2,
        buoyancy: 2.5,
        wash: 0.5,
        heat: 0.9,
      });
    }
    // Dirt kicked up.
    for (let i = 0; i < 12 * scale; i++) {
      this.smoke.emit({
        x: at.x,
        y: at.y + 0.5,
        z: at.z,
        vx: r.gauss() * 6,
        vy: r.range(8, 20) * scale,
        vz: r.gauss() * 6,
        life: r.range(1.2, 2.2),
        size0: 2 * scale,
        size1: 6 * scale,
        r: 0.36,
        g: 0.3,
        b: 0.22,
        alpha: 0.9,
        drag: 0.6,
        buoyancy: -12,
        turb: 0.3,
      });
    }
    if (flash) {
      this.flash.position.copy(at).y += 4;
      this.flash.intensity = 4000 * scale;
      this.flashT = 0.25;
    }
  }

  sparks(at: THREE.Vector3, n = 6) {
    const r = this.rng;
    for (let i = 0; i < n; i++)
      this.fire.emit({
        x: at.x,
        y: at.y,
        z: at.z,
        vx: r.gauss() * 8,
        vy: r.gauss() * 8,
        vz: r.gauss() * 8,
        life: r.range(0.15, 0.4),
        size0: 0.5,
        size1: 0.2,
        r: 2,
        g: 1.6,
        b: 0.8,
        alpha: 1,
        fadeIn: 0.01,
        drag: 2,
        buoyancy: -9,
      });
  }

  /** A puff of dirt where a bullet lands. */
  impactPuff(at: THREE.Vector3) {
    const r = this.rng;
    this.smoke.emit({
      x: at.x,
      y: at.y + 0.3,
      z: at.z,
      vy: r.range(1, 4),
      life: 1.2,
      size0: 1,
      size1: 3.5,
      r: 0.45,
      g: 0.4,
      b: 0.3,
      alpha: 0.7,
      drag: 1,
    });
  }

  /**
   * Smoke from a spot. 'burning' is a burning wreck: flames, and a column of
   * dark smoke that climbs hundreds of metres, greying as it cools and leaning
   * downwind (rate sets its size: 7 is a tank). 'trail' follows its `pos`
   * (keep it updated) laying a smoke trail, for an aircraft going down.
   */
  addEmitter(pos: THREE.Vector3, kind: SmokeColor | 'burning' | 'trail', rate?: number): SmokeEmitter {
    const base = { pos: pos.clone(), acc: 0, last: null };
    const e: SmokeEmitter =
      kind === 'burning'
        ? { ...base, kind: 'plume', rate: 3.2, color: [0.1, 0.092, 0.085], size: 6, life: 70, rise: 8, dark: true, scale: THREE.MathUtils.clamp((rate ?? 6) / 7, 0.45, 1.6) }
        : kind === 'trail'
          ? { ...base, kind: 'trail', rate: rate ?? 40, color: [0.08, 0.075, 0.07], size: 3.5, life: 14, rise: 1, dark: true, scale: 1 }
          : { ...base, kind: 'signal', rate: rate ?? 22, color: SMOKE_COLORS[kind], size: 2, life: 15, rise: 1.6, dark: false, scale: 1 };
    this.emitters.push(e);
    return e;
  }

  removeEmitter(e: SmokeEmitter | null | undefined) {
    if (!e) return;
    const i = this.emitters.indexOf(e);
    if (i >= 0) this.emitters.splice(i, 1);
  }

  private emitPlume(e: SmokeEmitter, far: boolean) {
    const r = this.rng;
    const s = e.scale;
    const grow = far ? 1.5 : 1;
    const [cr, cg, cb] = e.color;
    const life = e.life * r.range(0.8, 1.15) * (0.75 + 0.25 * s);
    this.smoke.emit({
      x: e.pos.x + r.gauss() * 1.2 * s,
      y: e.pos.y + r.range(0, 2),
      z: e.pos.z + r.gauss() * 1.2 * s,
      vx: this.wind.x * 0.4 + r.gauss() * 0.8,
      vy: e.rise * (0.8 + 0.3 * s) + r.range(0, 3),
      vz: this.wind.z * 0.4 + r.gauss() * 0.8,
      life,
      size0: e.size * s * grow,
      size1: (60 + 50 * s) * grow * r.range(0.8, 1.2),
      r: cr,
      g: cg,
      b: cb,
      r1: 0.74,
      g1: 0.7,
      b1: 0.66,
      alpha: far ? 0.7 : 0.55,
      fadeIn: 0.02,
      fadeOut: 0.45,
      drag: 0.15,
      buoyancy: 1.4 + 0.7 * s,
      wash: 0.6,
      heat: 0.6,
      turb: 1.4,
    });
  }

  private emitFlame(e: SmokeEmitter) {
    const r = this.rng;
    const s = e.scale;
    this.fire.emit({
      x: e.pos.x + r.gauss() * 1.3 * s,
      y: e.pos.y - 0.8 + r.range(0, 0.6),
      z: e.pos.z + r.gauss() * 1.3 * s,
      vx: this.wind.x * 0.3,
      vy: r.range(3, 7) * (0.7 + 0.3 * s),
      vz: this.wind.z * 0.3,
      life: r.range(0.5, 1.3),
      size0: r.range(3.5, 6.5) * s,
      size1: 1.5 * s,
      r: 1.6,
      g: 0.75,
      b: 0.25,
      r1: 1.1,
      g1: 0.3,
      b1: 0.06,
      alpha: 0.85,
      fadeIn: 0.08,
      drag: 1.5,
      buoyancy: 4,
      turb: 1.5,
    });
  }

  update(dt: number, camera: THREE.Camera) {
    const r = this.rng;
    const camPos = camera.position;
    this.time += dt;
    // Only the nearest plumes (bigger fires count as nearer) are kept going, so the pool lasts.
    this.rankT -= dt;
    if (this.rankT <= 0) {
      this.rankT = 0.5;
      const plumes = this.emitters.filter((e) => e.kind === 'plume');
      plumes.sort((a, b) => a.pos.distanceTo(camPos) / a.scale - b.pos.distanceTo(camPos) / b.scale);
      this.livePlumes = new Set(plumes.slice(0, Math.round(MAX_PLUMES * Math.max(0.5, this.density))));
    }
    for (const e of this.emitters) {
      const d = e.pos.distanceTo(camPos);
      if (e.kind === 'plume') {
        if (!this.livePlumes.has(e)) continue;
        // Columns are seen from far off; past 3 km they are drawn with fewer, bigger puffs.
        if (d > 10000) continue;
        const far = d > 3000;
        e.acc += e.rate * dt * (far ? 0.45 : 1) * this.density * (0.7 + 0.3 * e.scale);
        while (e.acc >= 1) {
          e.acc -= 1;
          this.emitPlume(e, far);
        }
        if (d < 2500) {
          const flames = 22 * e.scale * dt * this.density;
          for (let k = 0; k < Math.floor(flames) + (r.chance(flames % 1) ? 1 : 0); k++) this.emitFlame(e);
        }
        continue;
      }
      if (d > 7000) {
        e.last = null;
        continue;
      }
      e.acc += e.rate * dt * (d > 3000 ? 0.3 : 1) * (e.kind === 'signal' ? 1 : this.density);
      const from = e.last ?? e.pos;
      const count = Math.floor(e.acc);
      for (let k = 0; k < count; k++) {
        e.acc -= 1;
        const f = (k + r.next()) / Math.max(1, count);
        const [cr, cg, cb] = e.color;
        const x = from.x + (e.pos.x - from.x) * f;
        const y = from.y + (e.pos.y - from.y) * f;
        const z = from.z + (e.pos.z - from.z) * f;
        if (e.kind === 'trail') {
          this.smoke.emit({
            x: x + r.gauss() * 0.6,
            y: y + r.gauss() * 0.6,
            z: z + r.gauss() * 0.6,
            vx: r.gauss() * 1.5,
            vy: r.gauss() * 1.5,
            vz: r.gauss() * 1.5,
            life: e.life * r.range(0.8, 1.2),
            size0: e.size,
            size1: e.size * 7,
            r: cr,
            g: cg,
            b: cb,
            r1: 0.34,
            g1: 0.33,
            b1: 0.32,
            alpha: 0.8,
            fadeIn: 0.01,
            fadeOut: 0.5,
            drag: 0.5,
            buoyancy: 0.8,
            heat: 1,
          });
          if (r.chance(0.6)) this.fire.emit({ x, y, z, vx: r.gauss() * 2, vy: r.gauss() * 2, vz: r.gauss() * 2, life: r.range(0.2, 0.5), size0: 4.5, size1: 1.5, r: 1.7, g: 0.8, b: 0.3, alpha: 0.9, fadeIn: 0.02, drag: 1 });
          continue;
        }
        this.smoke.emit({
          x: x + r.gauss() * 0.25,
          y: y + 0.2,
          z: z + r.gauss() * 0.25,
          vx: this.wind.x * 0.5 + r.gauss() * 0.7,
          vy: e.rise + r.range(0, 1.5),
          vz: this.wind.z * 0.5 + r.gauss() * 0.7,
          life: e.life * r.range(0.8, 1.2),
          size0: e.size,
          size1: e.size * 6.5,
          r: cr,
          g: cg,
          b: cb,
          r1: cr * 0.8 + 0.1,
          g1: cg * 0.8 + 0.1,
          b1: cb * 0.8 + 0.1,
          alpha: 0.72,
          fadeIn: 0.03,
          fadeOut: 0.55,
          drag: 0.6,
          buoyancy: 0.35,
          wash: 1,
          turb: 0.8,
        });
      }
      e.last = e.kind === 'trail' ? (e.last ?? new THREE.Vector3()).copy(e.pos) : null;
    }
    this.smoke.update(dt, { dw: this.downwash, wind: this.wind, camera, env: this.env, time: this.time });
    this.fire.update(dt, { dw: null, wind: this.wind, camera, env: null, time: this.time });

    // Tracers.
    const tp = this.tracerPos;
    const tc = this.tracerCol;
    let k = 0;
    for (let i = this.tracers.length - 1; i >= 0; i--) {
      const t = this.tracers[i];
      t.life -= dt;
      if (t.life <= 0) {
        this.tracers.splice(i, 1);
        continue;
      }
      t.v.y -= 4 * dt;
      t.p.addScaledVector(t.v, dt);
    }
    for (const t of this.tracers) {
      const vl = t.v.length() || 1;
      tp[k * 6] = t.p.x;
      tp[k * 6 + 1] = t.p.y;
      tp[k * 6 + 2] = t.p.z;
      tp[k * 6 + 3] = t.p.x - (t.v.x / vl) * t.len;
      tp[k * 6 + 4] = t.p.y - (t.v.y / vl) * t.len;
      tp[k * 6 + 5] = t.p.z - (t.v.z / vl) * t.len;
      tc.set([t.r, t.g, t.b, t.r * 0.2, t.g * 0.2, t.b * 0.2], k * 6);
      k++;
    }
    this.tracerGeo.setDrawRange(0, k * 2);
    (this.tracerGeo.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (this.tracerGeo.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;

    if (this.flashT > 0) {
      this.flashT -= dt;
      this.flash.intensity *= Math.exp(-dt * 14);
      if (this.flashT <= 0) this.flash.intensity = 0;
    }
  }
}
