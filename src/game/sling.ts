import * as THREE from 'three';
import type { Heli } from '../heli/heli';
import type { Terrain } from '../world/terrain';
import { merge, part } from '../world/props';
import { G } from '../heli/flight';

export type SlingModel = 'howitzer' | 'vehicle' | 'bladder' | 'container' | 'generator';

function slingGeo(model: SlingModel): { geo: THREE.BufferGeometry; height: number } {
  const box = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d);
  const cyl = (r: number, h: number) => new THREE.CylinderGeometry(r, r, h, 12);
  switch (model) {
    case 'howitzer':
      return {
        height: 2.3,
        geo: merge([
          part(box(2.2, 0.9, 2.4), 0x5a5e3e, 0, -1.2, 0),
          part(box(1.1, 0.7, 1.4), 0x4e5236, 0, -0.55, 0.2),
          part(cyl(0.16, 5.5), 0x3c3f2c, 0, -0.5, -3.2, Math.PI / 2 - 0.05, 0, 0),
          part(cyl(0.6, 0.35), 0x1b1b19, -1.25, -1.7, 0.2, 0, 0, Math.PI / 2),
          part(cyl(0.6, 0.35), 0x1b1b19, 1.25, -1.7, 0.2, 0, 0, Math.PI / 2),
          part(box(0.25, 0.25, 3.6), 0x4e5236, -0.7, -1.95, 2.6, 0, 0.2, 0),
          part(box(0.25, 0.25, 3.6), 0x4e5236, 0.7, -1.95, 2.6, 0, -0.2, 0),
        ]),
      };
    case 'vehicle':
      return {
        height: 2.0,
        geo: merge([
          part(box(2.2, 0.9, 4.6), 0x6b6440, 0, -1.0, 0),
          part(box(2.0, 0.8, 2.2), 0x6b6440, 0, -0.2, 0.3),
          part(box(1.9, 0.55, 0.05), 0x22262a, 0, -0.1, -0.82),
          ...[-1, 1].flatMap((sx) => [-1.5, 1.5].map((z) => part(cyl(0.45, 0.35), 0x1c1c1a, sx * 1.0, -1.55, z, 0, 0, Math.PI / 2))),
        ]),
      };
    case 'bladder':
      return {
        height: 1.4,
        geo: merge([
          part(new THREE.SphereGeometry(1, 16, 8), 0x2a2a22, 0, -0.7, 0, 0, 0, 0, 2.8, 0.7, 1.9),
          part(box(0.12, 0.12, 4.2), 0x8a7a3a, 0, -0.05, 0),
          part(box(4.6, 0.12, 0.12), 0x8a7a3a, 0, -0.05, 0),
        ]),
      };
    case 'container':
      return {
        height: 2.6,
        geo: merge([part(box(6.06, 2.6, 2.44), 0x7a5a3a, 0, -1.3, 0), part(box(6.0, 0.06, 2.4), 0x6a4a30, 0, -0.02, 0)]),
      };
    case 'generator':
      return {
        height: 1.9,
        geo: merge([
          part(box(3.2, 1.6, 1.8), 0x56603e, 0, -1.0, 0),
          part(box(0.6, 0.6, 0.6), 0x2a2a28, 1.0, 0.0, 0),
          part(box(3.4, 0.2, 2.0), 0x3a3a30, 0, -1.8, 0),
        ]),
      };
  }
}

const mat = new THREE.MeshLambertMaterial({ vertexColors: true });

/** A slung load: point mass hanging from its top attach point. */
export class SlingLoad {
  mesh: THREE.Mesh;
  /** Attach point (top center) in world space. */
  pos = new THREE.Vector3();
  vel = new THREE.Vector3();
  height: number;
  yaw = 0;
  spin = 0;
  onGround = true;
  maxImpact = 0;
  destroyed = false;

  constructor(
    readonly model: SlingModel,
    readonly mass: number,
  ) {
    const { geo, height } = slingGeo(model);
    this.height = height;
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
  }

  placeAt(p: THREE.Vector3, terrain: Terrain, yaw = 0) {
    this.pos.set(p.x, terrain.surfaceAt(p.x, p.z) + this.height, p.z);
    this.vel.set(0, 0, 0);
    this.yaw = yaw;
    this.onGround = true;
    this.sync(null);
  }

  sync(hook: THREE.Vector3 | null) {
    this.mesh.position.copy(this.pos);
    if (hook) {
      // Tilt slightly along the rope direction.
      const d = hook.clone().sub(this.pos).normalize();
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d);
      const tilt = new THREE.Quaternion().slerpQuaternions(new THREE.Quaternion(), q, 0.6);
      this.mesh.quaternion.copy(tilt).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), this.yaw));
    } else {
      this.mesh.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), this.yaw);
    }
  }
}

export interface SlingHookResult {
  ok: boolean;
  msg: string;
}

const ROPE_LEN = 11;

/** Cargo hook, rope constraint and slung-load dynamics. */
export class SlingSystem {
  group = new THREE.Group();
  loads: SlingLoad[] = [];
  hooked: SlingLoad | null = null;
  tension = 0;
  onLoadImpact: ((load: SlingLoad, speed: number) => void) | null = null;
  private rope: THREE.Line;
  private ropePos = new Float32Array(13 * 3);
  private legs: THREE.LineSegments;
  private legPos = new Float32Array(8 * 3);
  private hookP = new THREE.Vector3();
  private hookV = new THREE.Vector3();

  constructor(private terrain: Terrain) {
    const rg = new THREE.BufferGeometry();
    rg.setAttribute('position', new THREE.BufferAttribute(this.ropePos, 3));
    this.rope = new THREE.Line(rg, new THREE.LineBasicMaterial({ color: 0x1a1a14 }));
    this.rope.frustumCulled = false;
    this.rope.visible = false;
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.BufferAttribute(this.legPos, 3));
    this.legs = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: 0x2a2a20 }));
    this.legs.frustumCulled = false;
    this.legs.visible = false;
    this.group.add(this.rope, this.legs);
  }

  add(load: SlingLoad) {
    this.loads.push(load);
    this.group.add(load.mesh);
  }

  remove(load: SlingLoad) {
    if (this.hooked === load) this.hooked = null;
    this.loads = this.loads.filter((l) => l !== load);
    this.group.remove(load.mesh);
  }

  /** Nearest load the hook could reach, and why/why not. */
  hookStatus(heli: Heli): { load: SlingLoad | null; horiz: number; height: number } {
    heli.hookWorld(this.hookP);
    let best: SlingLoad | null = null;
    let bd = Infinity;
    for (const l of this.loads) {
      if (l.destroyed) continue;
      const d = Math.hypot(l.pos.x - this.hookP.x, l.pos.z - this.hookP.z);
      if (d < bd) {
        bd = d;
        best = l;
      }
    }
    return { load: best, horiz: bd, height: best ? this.hookP.y - best.pos.y : 0 };
  }

  tryHook(heli: Heli): SlingHookResult {
    if (this.hooked) return { ok: false, msg: 'Already carrying a load' };
    const { load, horiz, height } = this.hookStatus(heli);
    if (!load || horiz > 30) return { ok: false, msg: 'No load beneath the aircraft' };
    if (horiz > 3.5) return { ok: false, msg: `Hook not over load (${horiz.toFixed(1)} m off)` };
    if (height < 0.6) return { ok: false, msg: 'Too low — hook is touching the load' };
    if (height > ROPE_LEN - 0.5) return { ok: false, msg: `Too high for the ground crew (${height.toFixed(0)} m)` };
    if (heli.fm.groundSpeed > 2.5) return { ok: false, msg: 'Stabilize your hover first' };
    this.hooked = load;
    load.maxImpact = 0;
    return { ok: true, msg: `Load hooked — ${(load.mass / 1000).toFixed(1)} t` };
  }

  release(): SlingLoad | null {
    const l = this.hooked;
    this.hooked = null;
    if (l) l.maxImpact = 0;
    return l;
  }

  step(dt: number, heli: Heli) {
    for (const l of this.loads) {
      if (l.destroyed) continue;
      const free = l !== this.hooked;
      if (free && l.onGround && l.vel.lengthSq() < 1e-4) continue;
      // Gravity & drag.
      l.vel.y -= G * dt;
      const sp = l.vel.length();
      if (sp > 0.01) l.vel.addScaledVector(l.vel, -Math.min(0.5, ((6 * sp) / l.mass) * dt));
      l.pos.addScaledVector(l.vel, dt);
      // Ground.
      const ground = this.terrain.surfaceAt(l.pos.x, l.pos.z) + l.height;
      if (l.pos.y <= ground) {
        const impact = -l.vel.y;
        if (!l.onGround && impact > 1) {
          l.maxImpact = Math.max(l.maxImpact, impact);
          this.onLoadImpact?.(l, impact);
        }
        l.pos.y = ground;
        if (l.vel.y < 0) l.vel.y = 0;
        const f = Math.exp(-6 * dt);
        l.vel.x *= f;
        l.vel.z *= f;
        l.onGround = true;
      } else if (l.pos.y > ground + 0.05) {
        l.onGround = false;
      }
      l.spin *= Math.exp(-0.3 * dt);
    }

    const l = this.hooked;
    let stepTension = 0;
    if (!l) {
      this.tension = 0;
      return;
    }
    heli.hookWorld(this.hookP);
    heli.hookVelocity(this.hookV);
    const n = l.pos.clone().sub(this.hookP);
    const dist = n.length();
    if (dist > ROPE_LEN && dist > 1e-4) {
      n.divideScalar(dist);
      const mH = heli.fm.mass;
      const mL = l.mass;
      const vr = l.vel.clone().sub(this.hookV).dot(n);
      // Baumgarte-style bias pulls the rope back to length.
      const bias = ((dist - ROPE_LEN) * 0.2) / dt;
      const jn = (vr + bias) / (1 / mL + 1 / mH);
      if (jn > 0) {
        l.vel.addScaledVector(n, -jn / mL);
        heli.fm.applyImpulse(n.clone().multiplyScalar(jn), this.hookP);
        stepTension = jn / dt;
        // Swinging loads pick up a little spin.
        l.spin += (Math.random() - 0.5) * 0.002 * Math.min(5, vr);
      }
      l.pos.copy(this.hookP).addScaledVector(n, ROPE_LEN + (dist - ROPE_LEN) * 0.6);
    }
    this.tension += (stepTension - this.tension) * Math.min(1, dt * 4);
    l.yaw += l.spin * dt;
  }

  /** Update visuals once per frame. */
  render(heli: Heli) {
    const l = this.hooked;
    for (const ld of this.loads) if (ld !== l) ld.sync(null);
    if (!l) {
      this.rope.visible = false;
      this.legs.visible = false;
      return;
    }
    heli.hookWorld(this.hookP);
    l.sync(this.hookP);
    const a = this.hookP;
    const b = l.pos;
    const dist = a.distanceTo(b);
    const sag = Math.max(0, ROPE_LEN - dist) * 0.5;
    for (let i = 0; i <= 12; i++) {
      const t = i / 12;
      this.ropePos[i * 3] = a.x + (b.x - a.x) * t;
      this.ropePos[i * 3 + 1] = a.y + (b.y - a.y) * t - Math.sin(t * Math.PI) * sag;
      this.ropePos[i * 3 + 2] = a.z + (b.z - a.z) * t;
    }
    this.rope.geometry.attributes.position.needsUpdate = true;
    this.rope.visible = true;
    // Four short legs from the attach point to the load's corners.
    const box = new THREE.Box3().setFromObject(l.mesh);
    const corners = [
      [box.min.x, box.min.z],
      [box.max.x, box.min.z],
      [box.max.x, box.max.z],
      [box.min.x, box.max.z],
    ];
    const cy = l.pos.y - l.height * 0.35;
    corners.forEach(([x, z], i) => {
      this.legPos.set([b.x, b.y + 0.6, b.z, b.x + (x - b.x) * 0.8, cy, b.z + (z - b.z) * 0.8], i * 6);
    });
    this.legs.geometry.attributes.position.needsUpdate = true;
    this.legs.visible = true;
  }
}
