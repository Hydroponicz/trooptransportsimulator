import * as THREE from 'three';
import { ParticleSystem, type Downwash } from './particles';
import { smokeSpriteTexture, softSpriteTexture } from '../util/textures';
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
  downwash: Downwash = { active: false, x: 0, y: 0, z: 0, ground: 0, strength: 0 };
  wind = new THREE.Vector3();

  constructor(private rng: RNG) {
    this.smoke = new ParticleSystem(4000, smokeSpriteTexture(), false);
    this.fire = new ParticleSystem(1500, softSpriteTexture(), true);
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
        buoyancy: 1.5,
        wash: 0.5,
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

  addEmitter(pos: THREE.Vector3, kind: SmokeColor | 'burning', rate?: number): SmokeEmitter {
    const e: SmokeEmitter =
      kind === 'burning'
        ? { pos: pos.clone(), rate: rate ?? 6, color: [0.12, 0.11, 0.1], size: 9, life: 22, rise: 5, acc: 0, dark: true }
        : { pos: pos.clone(), rate: rate ?? 22, color: SMOKE_COLORS[kind], size: 2.2, life: 9, rise: 1.6, acc: 0, dark: false };
    this.emitters.push(e);
    return e;
  }

  removeEmitter(e: SmokeEmitter | null | undefined) {
    if (!e) return;
    const i = this.emitters.indexOf(e);
    if (i >= 0) this.emitters.splice(i, 1);
  }

  update(dt: number, camPos: THREE.Vector3) {
    const r = this.rng;
    for (const e of this.emitters) {
      const d = e.pos.distanceTo(camPos);
      if (d > 7000) continue;
      e.acc += e.rate * dt * (d > 3000 ? 0.3 : 1);
      while (e.acc >= 1) {
        e.acc -= 1;
        const [cr, cg, cb] = e.color;
        this.smoke.emit({
          x: e.pos.x + r.gauss() * 0.4,
          y: e.pos.y,
          z: e.pos.z + r.gauss() * 0.4,
          vx: this.wind.x * 0.6 + r.gauss() * 0.6,
          vy: e.rise + r.range(0, 1.5),
          vz: this.wind.z * 0.6 + r.gauss() * 0.6,
          life: e.life * r.range(0.8, 1.2),
          size0: e.size,
          size1: e.dark ? e.size * 4 : e.size * 6,
          r: cr,
          g: cg,
          b: cb,
          r1: e.dark ? 0.35 : cr * 0.9 + 0.1,
          g1: e.dark ? 0.34 : cg * 0.9 + 0.1,
          b1: e.dark ? 0.32 : cb * 0.9 + 0.1,
          alpha: e.dark ? 0.7 : 0.85,
          fadeIn: 0.04,
          drag: 0.25,
          buoyancy: e.dark ? 0.8 : 0.15,
          wash: 1,
        });
        if (e.dark && r.chance(0.35))
          this.fire.emit({
            x: e.pos.x + r.gauss() * 1.2,
            y: e.pos.y - 0.5,
            z: e.pos.z + r.gauss() * 1.2,
            vy: r.range(2, 5),
            life: r.range(0.4, 0.9),
            size0: 3,
            size1: 1.5,
            r: 1.5,
            g: 0.7,
            b: 0.2,
            alpha: 0.9,
            fadeIn: 0.05,
          });
      }
    }
    this.smoke.update(dt, this.downwash);
    this.fire.update(dt, null);

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
