import * as THREE from 'three';
import type { World } from '../world/worldgen';
import type { Effects, SmokeEmitter } from '../fx/effects';
import type { AudioEngine } from '../audio';
import type { PlayerTarget } from '../game/target';
import type { RNG } from '../util/noise';
import { clamp } from '../util/math';
import type { Battle } from './battle';
import type { Side } from './campaign';
import { merge, part } from '../world/props';

type JetKind = 'a10' | 'su25';
type Phase = 'ingress' | 'run' | 'egress' | 'down';

const SPEC: Record<JetKind, { speed: number; turn: number; callsign: string }> = {
  a10: { speed: 165, turn: 0.42, callsign: 'Hog' },
  su25: { speed: 205, turn: 0.36, callsign: 'Grach' },
};

function jetGeometry(kind: JetKind): THREE.BufferGeometry {
  const cyl = (r0: number, r1: number, l: number) => new THREE.CylinderGeometry(r0, r1, l, 10).rotateX(Math.PI / 2);
  const box = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d);
  if (kind === 'a10') {
    const gray = 0x6e767c;
    const dark = 0x4c5357;
    return merge([
      part(cyl(0.85, 0.75, 13), gray, 0, 0, 0.5),
      part(new THREE.ConeGeometry(0.85, 2.4, 10).rotateX(-Math.PI / 2), gray, 0, 0, -7.2),
      part(box(0.9, 0.55, 2.2), 0x2a3238, 0, 0.75, -4.6),
      part(box(17.5, 0.28, 2.7), gray, 0, -0.35, 0.2),
      part(cyl(0.68, 0.6, 3.4), dark, -1.35, 0.95, 3.6),
      part(cyl(0.68, 0.6, 3.4), dark, 1.35, 0.95, 3.6),
      part(box(5.6, 0.16, 1.7), gray, 0, 0.25, 6.8),
      part(box(0.16, 2.6, 1.7), gray, -2.75, 1.25, 6.8),
      part(box(0.16, 2.6, 1.7), gray, 2.75, 1.25, 6.8),
      part(box(0.18, 0.18, 1.2), 0x222222, 0, -0.35, -8.2),
    ]);
  }
  const camo = 0x7f7c5c;
  const belly = 0x9aa3a8;
  const wing = new THREE.Shape();
  wing.moveTo(-0.9, -1.6);
  wing.lineTo(-7.2, 1.4);
  wing.lineTo(-7.2, 2.6);
  wing.lineTo(-0.9, 2.4);
  wing.lineTo(0.9, 2.4);
  wing.lineTo(7.2, 2.6);
  wing.lineTo(7.2, 1.4);
  wing.lineTo(0.9, -1.6);
  wing.closePath();
  const wg = new THREE.ExtrudeGeometry(wing, { depth: 0.25, bevelEnabled: false }).rotateX(Math.PI / 2);
  return merge([
    part(cyl(0.8, 0.7, 12), camo, 0, 0, 0.8),
    part(new THREE.ConeGeometry(0.8, 3.2, 10).rotateX(-Math.PI / 2), belly, 0, 0, -6.8),
    part(box(0.85, 0.6, 2.4), 0x2a3238, 0, 0.7, -4.2),
    part(wg, camo, 0, 0.45, 0.6),
    part(cyl(0.55, 0.5, 6.5), belly, -1.05, -0.25, 1.8),
    part(cyl(0.55, 0.5, 6.5), belly, 1.05, -0.25, 1.8),
    part(box(5.2, 0.14, 1.5), camo, 0, 0.45, 6.6),
    part(box(0.16, 3.0, 2.4), camo, 0, 1.7, 6.2),
  ]);
}

const geos: Partial<Record<JetKind, THREE.BufferGeometry>> = {};
const mat = new THREE.MeshLambertMaterial({ vertexColors: true });

class Jet {
  mesh: THREE.Mesh;
  pos = new THREE.Vector3();
  dir = new THREE.Vector3();
  bank = 0;
  phase: Phase = 'ingress';
  waypoint = new THREE.Vector3();
  t = 0;
  fired = false;
  fireT = 0;
  doomed: boolean;
  smoke: SmokeEmitter | null = null;
  sound: ReturnType<AudioEngine['jet']> = null;
  lastDist = 0;
  flaresLeft = 6;
  constructor(
    readonly kind: JetKind,
    readonly side: Side,
    readonly target: THREE.Vector3,
    readonly runDir: THREE.Vector3,
    readonly name: string,
    doomed: boolean,
  ) {
    geos[kind] ??= jetGeometry(kind);
    this.mesh = new THREE.Mesh(geos[kind], mat);
    this.mesh.castShadow = true;
    this.doomed = doomed;
  }
  get speed() {
    return SPEC[this.kind].speed;
  }
}

interface Bomb {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  mesh: THREE.Mesh;
  side: Side;
}

export interface AirHooks {
  radio(from: string, msg: string): void;
}

/** AI close air support: A-10s for us, Su-25s for them. */
export class AirOps {
  group = new THREE.Group();
  jets: Jet[] = [];
  private bombs: Bomb[] = [];
  private next = 25;
  private flight = 0;
  private bombGeo = new THREE.CylinderGeometry(0.18, 0.18, 2.2, 6).rotateX(Math.PI / 2);
  private bombMat = new THREE.MeshLambertMaterial({ color: 0x3f4433 });
  private tmp = new THREE.Vector3();

  constructor(
    private world: World,
    private battle: Battle,
    private effects: Effects,
    private audio: AudioEngine,
    private rng: RNG,
    private hooks: AirHooks,
  ) {}

  private ground(x: number, z: number) {
    return this.world.terrain.surfaceAt(x, z);
  }

  /** Schedule a strike near the player when there is something to see. */
  private plan(player: PlayerTarget) {
    const hp = player.pos;
    const side: Side = this.rng.chance(0.55) ? 'blue' : 'red';
    let target = this.battle.strikeTarget(side, hp);
    if (!target) {
      // Nothing live nearby: hit somewhere along the front within sight.
      const z = clamp(hp.z + this.rng.range(-900, 900), -2900, 2900);
      const fx = this.world.front.x(z);
      if (Math.abs(hp.x - fx) > 3500) return false;
      const x = fx + (side === 'blue' ? 1 : -1) * this.rng.range(150, 500);
      target = new THREE.Vector3(x, this.ground(x, z), z);
    }
    const runDir = new THREE.Vector3(side === 'blue' ? 1 : -1, 0, this.rng.range(-0.5, 0.5)).normalize();
    const kind: JetKind = side === 'blue' ? 'a10' : 'su25';
    const n = this.rng.chance(0.6) ? 2 : 1;
    this.flight++;
    for (let i = 0; i < n; i++) {
      const name = `${SPEC[kind].callsign} ${this.flight}-${i + 1}`;
      const doomed = this.rng.chance(0.08);
      const tgt = target.clone().add(new THREE.Vector3(this.rng.range(-25, 25), 0, this.rng.range(-25, 25)));
      tgt.y = this.ground(tgt.x, tgt.z);
      const jet = new Jet(kind, side, tgt, runDir, name, doomed);
      // Enter from the friendly rear, offset for the wingman.
      const start = tgt.clone().addScaledVector(runDir, -this.rng.range(4200, 5200));
      start.z += this.rng.range(-1500, 1500) + i * 180;
      start.x = clamp(start.x, -3950, 3950);
      start.y = 700 + i * 40;
      jet.pos.copy(start);
      jet.waypoint.copy(tgt).addScaledVector(runDir, -2300 - i * 400);
      jet.waypoint.y = tgt.y + 420;
      jet.dir.copy(jet.waypoint).sub(start).normalize();
      jet.t = -i * 3;
      jet.sound = this.audio.jet();
      this.group.add(jet.mesh);
      this.jets.push(jet);
    }
    const d = target.distanceTo(hp);
    if (d < 3500) {
      if (side === 'blue') this.hooks.radio(`${SPEC.a10.callsign} ${this.flight}-1`, `In from the ${runDir.x > 0 ? 'west' : 'east'}, tally target, cleared hot. Keep your head down.`);
      else this.hooks.radio('Brigade TOC', 'Enemy fast movers inbound on the line! All aircraft, watch your altitude.');
    }
    return true;
  }

  update(dt: number, player: PlayerTarget, camPos: THREE.Vector3) {
    this.next -= dt;
    if (this.next <= 0) this.next = this.plan(player) ? this.rng.range(45, 100) : 20;

    for (let i = this.jets.length - 1; i >= 0; i--) {
      const j = this.jets[i];
      j.t += dt;
      if (j.t < 0) {
        j.mesh.visible = false;
        continue;
      }
      j.mesh.visible = true;
      if (this.fly(j, dt, camPos)) {
        j.sound?.stop();
        this.effects.removeEmitter(j.smoke);
        this.group.remove(j.mesh);
        this.jets.splice(i, 1);
      }
    }

    for (let i = this.bombs.length - 1; i >= 0; i--) {
      const b = this.bombs[i];
      b.vel.y -= 9.81 * dt;
      b.vel.multiplyScalar(Math.exp(-0.05 * dt));
      b.pos.addScaledVector(b.vel, dt);
      b.mesh.position.copy(b.pos);
      b.mesh.lookAt(this.tmp.copy(b.pos).add(b.vel));
      if (b.pos.y <= this.ground(b.pos.x, b.pos.z)) {
        b.pos.y = this.ground(b.pos.x, b.pos.z);
        this.battle.addImpact(b.pos, 2.4, b.side);
        this.group.remove(b.mesh);
        this.bombs.splice(i, 1);
      }
    }
  }

  /** Returns true when the jet is finished. */
  private fly(j: Jet, dt: number, camPos: THREE.Vector3): boolean {
    const spec = SPEC[j.kind];
    const toTarget = Math.hypot(j.target.x - j.pos.x, j.target.z - j.pos.z);
    const horiz = this.tmp.set(j.dir.x, 0, j.dir.z).normalize();
    const ahead = (j.target.x - j.pos.x) * horiz.x + (j.target.z - j.pos.z) * horiz.z;

    // --- Phase logic -----------------------------------------------------
    if (j.phase === 'ingress' && Math.hypot(j.waypoint.x - j.pos.x, j.waypoint.z - j.pos.z) < 350) {
      j.phase = 'run';
    }
    if (j.phase === 'run') {
      // Glide slope down onto the target.
      j.waypoint.copy(j.target);
      j.waypoint.y = j.target.y + clamp(60 + toTarget * 0.17, 60, 420);
      this.weapons(j, toTarget, ahead, dt, camPos);
      if (toTarget < 320 || ahead < 0) {
        j.phase = 'egress';
        const home = j.side === 'blue' ? -1 : 1;
        j.waypoint.set(home * 4300, j.pos.y + 600, j.pos.z + this.rng.range(-1500, 1500));
        if (j.doomed) {
          j.phase = 'down';
          j.smoke = this.effects.addEmitter(j.pos, 'burning', 30);
          this.hooks.radio(j.name, j.side === 'blue' ? "I'm hit, I'm hit! Punching out!" : 'Enemy aircraft hit and going down!');
        }
      }
    }
    if (j.phase === 'egress') {
      // Pop flares climbing away.
      if (j.flaresLeft > 0 && this.rng.chance(dt * 4)) {
        j.flaresLeft--;
        for (const s of [-1, 1])
          this.effects.fire.emit({ x: j.pos.x, y: j.pos.y - 1, z: j.pos.z, vx: j.dir.x * 60 + s * 25, vy: -10, vz: j.dir.z * 60, life: 2.4, size0: 5, size1: 2, r: 2, g: 1.7, b: 1.2, alpha: 1, fadeIn: 0.01, drag: 0.8, buoyancy: -6 });
      }
      if (Math.abs(j.pos.x) > 4250 || j.t > 120) return true;
    }

    // --- Steering ----------------------------------------------------------
    if (j.phase === 'down') {
      j.dir.y = Math.max(-0.6, j.dir.y - dt * 0.12);
      j.bank += dt * 1.6;
      j.dir.normalize();
      if (j.smoke) j.smoke.pos.copy(j.pos);
    } else {
      const want = this.tmp.copy(j.waypoint).sub(j.pos).normalize();
      const turn = spec.turn * dt;
      const bx = j.dir.x;
      const bz = j.dir.z;
      const ang = j.dir.angleTo(want);
      if (ang > 1e-4) j.dir.lerp(want, Math.min(1, turn / ang)).normalize();
      // Terrain floor.
      const floor = this.ground(j.pos.x + j.dir.x * 300, j.pos.z + j.dir.z * 300) + 45;
      if (j.pos.y < floor) j.dir.y = Math.max(j.dir.y, 0.15);
      // (before × after).y > 0 means a left turn → left wing down (positive roll about the nose axis).
      const hb = Math.hypot(bx, bz) || 1;
      const ha = Math.hypot(j.dir.x, j.dir.z) || 1;
      const yawRate = Math.asin(clamp(((bz / hb) * (j.dir.x / ha) - (bx / hb) * (j.dir.z / ha)), -1, 1)) / dt;
      const targetBank = clamp(Math.atan((yawRate * j.speed) / 9.81), -1.2, 1.2);
      j.bank += (targetBank - j.bank) * Math.min(1, dt * 3);
    }
    j.pos.addScaledVector(j.dir, j.speed * dt);
    // Orientation: nose along dir (model faces −Z), rolled by bank.
    const m = new THREE.Matrix4().lookAt(new THREE.Vector3(), j.dir, new THREE.Vector3(0, 1, 0));
    j.mesh.quaternion.setFromRotationMatrix(m).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), j.bank));
    j.mesh.position.copy(j.pos);

    // Sound with doppler.
    const d = j.pos.distanceTo(camPos);
    j.sound?.update(d, (j.lastDist - d) / Math.max(dt, 1e-3));
    j.lastDist = d;

    if (j.phase === 'down' && j.pos.y <= this.ground(j.pos.x, j.pos.z) + 2) {
      this.battle.addImpact(j.pos, 2.6, j.side === 'blue' ? 'red' : 'blue');
      this.effects.addEmitter(new THREE.Vector3(j.pos.x, this.ground(j.pos.x, j.pos.z) + 1, j.pos.z), 'burning', 10);
      return true;
    }
    return false;
  }

  private weapons(j: Jet, dist: number, ahead: number, dt: number, camPos: THREE.Vector3) {
    if (j.kind === 'a10') {
      // GAU-8 gun run: a 2 s burst walking a line of impacts through the target.
      if (!j.fired && dist < 1250) {
        j.fired = true;
        j.fireT = 0;
        this.audio.brrrt(j.pos.distanceTo(camPos), 2);
      }
      if (j.fired && j.fireT < 2) {
        j.fireT += dt;
        const k = j.fireT / 2;
        const aim = j.target.clone().addScaledVector(j.runDir, -45 + 90 * k);
        const muzzle = j.pos.clone().addScaledVector(j.dir, 9);
        for (let n = 0; n < 4; n++) {
          const hit = aim.clone().add(new THREE.Vector3(this.rng.gauss() * 3, 0, this.rng.gauss() * 3));
          hit.y = this.ground(hit.x, hit.z);
          const v = hit.clone().sub(muzzle).normalize().multiplyScalar(1050);
          if (n % 2 === 0) this.effects.tracer(muzzle, v, muzzle.distanceTo(hit) / 1050, 0xffe08a);
          this.battle.gunImpact(hit, camPos);
        }
        this.effects.fire.emit({ x: muzzle.x, y: muzzle.y, z: muzzle.z, life: 0.05, size0: 3, size1: 1.5, r: 2, g: 1.6, b: 0.7, alpha: 1, fadeIn: 0.01 });
      }
    } else {
      // Su-25: rocket salvo, then two bombs released on a level-bombing solution.
      if (!j.fired && dist < 1000) {
        j.fired = true;
        for (let n = 0; n < 10; n++) {
          const from = j.pos.clone().add(new THREE.Vector3(this.rng.gauss() * 3, -1, this.rng.gauss() * 3));
          const hit = j.target.clone().add(new THREE.Vector3(this.rng.gauss() * 18, 0, this.rng.gauss() * 18));
          hit.y = this.ground(hit.x, hit.z);
          const fl = from.distanceTo(hit) / 600;
          this.effects.tracer(from, hit.clone().sub(from).normalize().multiplyScalar(600), fl, 0xffd27a);
          for (let s = 0; s < 4; s++) {
            const p = from.clone().lerp(hit, s / 4);
            this.effects.smoke.emit({ x: p.x, y: p.y, z: p.z, life: 3, size0: 1.5, size1: 5, r: 0.85, g: 0.85, b: 0.82, alpha: 0.45, drag: 1, fadeIn: s * 0.1 + 0.05 });
          }
          this.battle.addImpact(hit, 0.8, j.side, fl + n * 0.05);
        }
      }
      // Bomb release: time to fall ≈ distance-ahead / speed.
      const h = j.pos.y - j.target.y;
      const tFall = Math.sqrt((2 * Math.max(h, 10)) / 9.81);
      if (j.fired && j.fireT === 0 && ahead < j.speed * tFall * 0.95) {
        j.fireT = 1;
        for (const off of [-2.5, 2.5]) {
          const mesh = new THREE.Mesh(this.bombGeo, this.bombMat);
          const pos = j.pos.clone().add(new THREE.Vector3(off * j.dir.z, -1.2, -off * j.dir.x));
          this.group.add(mesh);
          this.bombs.push({ pos, vel: j.dir.clone().multiplyScalar(j.speed), mesh, side: j.side });
        }
      }
    }
  }
}
