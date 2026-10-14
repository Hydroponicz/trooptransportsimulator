import * as THREE from 'three';
import type { Terrain } from '../world/terrain';
import type { RNG } from '../util/noise';

export type ActorKind = 'soldier' | 'casualty' | 'pallet';

type ActorState = 'waiting' | 'toRamp' | 'climb' | 'aboard' | 'descend' | 'toRally' | 'arrived' | 'returning';

const mats = {
  uniform: new THREE.MeshLambertMaterial({ color: 0x6d6a4c }),
  gear: new THREE.MeshLambertMaterial({ color: 0x4a4935 }),
  skin: new THREE.MeshLambertMaterial({ color: 0xb08a6a }),
  helmet: new THREE.MeshLambertMaterial({ color: 0x55573e }),
  rifle: new THREE.MeshLambertMaterial({ color: 0x1e1e1c }),
  stretcher: new THREE.MeshLambertMaterial({ color: 0x3f4a33 }),
  pallet: new THREE.MeshLambertMaterial({ color: 0x7a6440 }),
  crate: new THREE.MeshLambertMaterial({ color: 0x5e6342 }),
  strap: new THREE.MeshLambertMaterial({ color: 0xc9a43a }),
};
const geos = {
  leg: new THREE.BoxGeometry(0.2, 0.85, 0.22).translate(0, -0.42, 0),
  torso: new THREE.BoxGeometry(0.5, 0.65, 0.3),
  pack: new THREE.BoxGeometry(0.42, 0.5, 0.22),
  head: new THREE.BoxGeometry(0.24, 0.26, 0.26),
  helmet: new THREE.SphereGeometry(0.19, 8, 5, 0, Math.PI * 2, 0, Math.PI / 2),
  arm: new THREE.BoxGeometry(0.14, 0.6, 0.16).translate(0, -0.28, 0),
  rifle: new THREE.BoxGeometry(0.07, 0.12, 0.9),
};

interface Rig {
  root: THREE.Group;
  legL: THREE.Object3D;
  legR: THREE.Object3D;
  armL: THREE.Object3D;
  armR: THREE.Object3D;
}

function soldier(lying = false): Rig {
  const root = new THREE.Group();
  const add = (g: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number, parent: THREE.Object3D = root) => {
    const mesh = new THREE.Mesh(g, m);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    parent.add(mesh);
    return mesh;
  };
  const legL = add(geos.leg, mats.uniform, -0.12, 0.88, 0);
  const legR = add(geos.leg, mats.uniform, 0.12, 0.88, 0);
  add(geos.torso, mats.uniform, 0, 1.2, 0);
  add(geos.pack, mats.gear, 0, 1.25, 0.25);
  add(geos.head, mats.skin, 0, 1.68, 0);
  add(geos.helmet, mats.helmet, 0, 1.76, 0);
  const armL = add(geos.arm, mats.uniform, -0.33, 1.48, 0);
  const armR = add(geos.arm, mats.uniform, 0.33, 1.48, 0);
  if (!lying) add(geos.rifle, mats.rifle, 0.1, 1.1, -0.35);
  return { root, legL, legR, armL, armR };
}

export class Actor {
  mesh: THREE.Group;
  rigs: Rig[] = [];
  pos = new THREE.Vector3();
  home = new THREE.Vector3();
  rally = new THREE.Vector3();
  heading = 0;
  state: ActorState = 'waiting';
  phase = Math.random() * 10;
  speed: number;
  timer = 0;
  climbFrom = new THREE.Vector3();
  constructor(readonly kind: ActorKind) {
    this.mesh = new THREE.Group();
    if (kind === 'soldier') {
      const r = soldier();
      this.rigs.push(r);
      this.mesh.add(r.root);
      this.speed = 4.2;
    } else if (kind === 'casualty') {
      const a = soldier();
      const b = soldier();
      a.root.position.z = -1.1;
      b.root.position.z = 1.1;
      this.rigs.push(a, b);
      const bed = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.08, 2.0), mats.stretcher);
      bed.position.y = 0.95;
      const patient = soldier(true);
      patient.root.rotation.x = -Math.PI / 2;
      patient.root.position.set(0, 1.1, 0.85);
      this.mesh.add(a.root, b.root, bed, patient.root);
      this.speed = 2.2;
    } else {
      const pusher = soldier();
      pusher.root.position.z = 1.0;
      this.rigs.push(pusher);
      const pal = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.15, 1.3), mats.pallet);
      pal.position.set(0, 0.12, -0.5);
      const crate = new THREE.Mesh(new THREE.BoxGeometry(1.2, 1.1, 1.2), mats.crate);
      crate.position.set(0, 0.75, -0.5);
      crate.castShadow = true;
      const strap = new THREE.Mesh(new THREE.BoxGeometry(1.22, 0.08, 1.22), mats.strap);
      strap.position.set(0, 0.9, -0.5);
      this.mesh.add(pal, crate, strap, pusher.root);
      this.speed = 1.8;
    }
  }

  animate(dt: number, moving: boolean, crouch: boolean) {
    this.phase += dt * (moving ? this.speed * 2.6 : 0);
    const s = moving ? Math.sin(this.phase) * 0.7 : 0;
    for (const r of this.rigs) {
      r.legL.rotation.x = s;
      r.legR.rotation.x = -s;
      r.armL.rotation.x = this.kind === 'soldier' ? -s * 0.6 : -1.2;
      r.armR.rotation.x = this.kind === 'soldier' ? (moving ? -0.9 : -0.4) : -1.2;
      r.root.position.y = crouch && !moving && this.kind === 'soldier' ? -0.45 : 0;
      r.root.rotation.x = crouch && !moving && this.kind === 'soldier' ? 0.25 : 0;
    }
  }
}

export interface LoadContext {
  canLoad: boolean;
  canUnload: boolean;
  rampEnd: THREE.Vector3;
  cabin: THREE.Vector3;
  heliPos: THREE.Vector3;
  rotorsTurning: boolean;
}

/** A batch of people or pallets that move together between helicopter and ground. */
export class CargoGroup {
  actors: Actor[] = [];
  aboard = 0;
  dispatchTimer = 0;
  unloadedCount = 0;
  constructor(
    readonly kind: ActorKind,
    readonly total: number,
    readonly unitMass: number,
  ) {}
  get allAboard() {
    return this.aboard === this.total;
  }
  get allOff() {
    return this.unloadedCount === this.total;
  }
}

/** Spawns, animates and routes cargo actors. */
export class CargoManager {
  group = new THREE.Group();
  groups: CargoGroup[] = [];
  onBoard: ((g: CargoGroup, a: Actor) => void) | null = null;
  onUnboard: ((g: CargoGroup, a: Actor) => void) | null = null;
  private tmp = new THREE.Vector3();

  constructor(
    private terrain: Terrain,
    private rng: RNG,
  ) {}

  /** Create a group waiting in formation at a spot, facing toward `face`. */
  spawnWaiting(kind: ActorKind, count: number, unitMass: number, at: THREE.Vector3, face: THREE.Vector3): CargoGroup {
    const g = new CargoGroup(kind, count, unitMass);
    const dir = Math.atan2(face.x - at.x, face.z - at.z);
    const cols = kind === 'soldier' ? 4 : 3;
    const spacing = kind === 'soldier' ? 1.6 : 3.2;
    for (let i = 0; i < count; i++) {
      const a = new Actor(kind);
      const cx = (i % cols) - (cols - 1) / 2;
      const cz = Math.floor(i / cols);
      const lx = cx * spacing + this.rng.range(-0.2, 0.2);
      const lz = -cz * spacing;
      a.home.set(at.x + lx * Math.cos(dir) + lz * Math.sin(dir), 0, at.z - lx * Math.sin(dir) + lz * Math.cos(dir));
      a.home.y = this.terrain.heightAt(a.home.x, a.home.z);
      a.pos.copy(a.home);
      a.heading = dir;
      a.state = 'waiting';
      g.actors.push(a);
      this.group.add(a.mesh);
    }
    this.groups.push(g);
    return g;
  }

  /** Create a group already inside the helicopter (for missions that start loaded). */
  spawnAboard(kind: ActorKind, count: number, unitMass: number): CargoGroup {
    const g = new CargoGroup(kind, count, unitMass);
    for (let i = 0; i < count; i++) {
      const a = new Actor(kind);
      a.state = 'aboard';
      a.mesh.visible = false;
      g.actors.push(a);
      this.group.add(a.mesh);
    }
    g.aboard = count;
    this.groups.push(g);
    return g;
  }

  remove(g: CargoGroup) {
    for (const a of g.actors) this.group.remove(a.mesh);
    this.groups = this.groups.filter((x) => x !== g);
  }

  clear() {
    for (const g of [...this.groups]) this.remove(g);
  }

  setRally(g: CargoGroup, at: THREE.Vector3) {
    g.actors.forEach((a, i) => {
      const ang = (i / g.total) * Math.PI * 1.2 - 0.6;
      const r = 3 + (i % 3) * 2;
      a.rally.set(at.x + Math.sin(ang) * r, 0, at.z + Math.cos(ang) * r);
      a.rally.y = this.terrain.heightAt(a.rally.x, a.rally.z);
    });
  }

  private walk(a: Actor, target: THREE.Vector3, dt: number, onGround: boolean): boolean {
    const d = this.tmp.copy(target).sub(a.pos);
    if (onGround) d.y = 0;
    const dist = d.length();
    const step = a.speed * dt;
    if (dist <= step + 0.05) {
      a.pos.x = target.x;
      a.pos.z = target.z;
      if (!onGround) a.pos.y = target.y;
      return true;
    }
    a.pos.addScaledVector(d, step / dist);
    a.heading = Math.atan2(d.x, d.z) + Math.PI;
    return false;
  }

  update(dt: number, ctx: LoadContext) {
    const nearHeli = (a: Actor) => ctx.rotorsTurning && a.pos.distanceTo(ctx.heliPos) < 60;
    for (const g of this.groups) {
      g.dispatchTimer -= dt;
      for (const a of g.actors) {
        let moving = false;
        switch (a.state) {
          case 'waiting':
            if (ctx.canLoad && g.dispatchTimer <= 0) {
              a.state = 'toRamp';
              g.dispatchTimer = a.kind === 'soldier' ? 0.35 : 1.6;
            } else {
              // Face the helicopter, crouched against the rotor wash.
              a.heading = Math.atan2(ctx.heliPos.x - a.pos.x, ctx.heliPos.z - a.pos.z) + Math.PI;
            }
            break;
          case 'toRamp':
            if (!ctx.canLoad) {
              a.state = 'returning';
              break;
            }
            moving = true;
            if (this.walk(a, ctx.rampEnd, dt, true)) {
              a.state = 'climb';
              a.climbFrom.copy(a.pos);
            }
            break;
          case 'climb':
            moving = true;
            if (this.walk(a, ctx.cabin, dt, false)) {
              a.state = 'aboard';
              a.mesh.visible = false;
              g.aboard++;
              this.onBoard?.(g, a);
            }
            break;
          case 'returning':
            moving = true;
            if (this.walk(a, a.home, dt, true)) a.state = 'waiting';
            if (ctx.canLoad) a.state = 'toRamp';
            break;
          case 'aboard':
            if (ctx.canUnload && g.dispatchTimer <= 0) {
              a.state = 'descend';
              a.pos.copy(ctx.cabin);
              a.mesh.visible = true;
              g.dispatchTimer = a.kind === 'soldier' ? 0.4 : 1.6;
              g.aboard--;
              g.unloadedCount++;
              this.onUnboard?.(g, a);
            }
            break;
          case 'descend':
            moving = true;
            if (this.walk(a, ctx.rampEnd, dt, false)) a.state = 'toRally';
            break;
          case 'toRally':
            moving = true;
            if (this.walk(a, a.rally, dt, true)) {
              a.state = 'arrived';
              a.timer = 6 + Math.random() * 4;
            }
            break;
          case 'arrived':
            a.timer -= dt;
            if (a.timer <= 0) a.mesh.visible = false;
            break;
        }
        if (a.state !== 'climb' && a.state !== 'descend' && a.state !== 'aboard') {
          a.pos.y = this.terrain.heightAt(a.pos.x, a.pos.z);
        }
        a.mesh.position.copy(a.pos);
        a.mesh.rotation.y = a.heading;
        a.animate(dt, moving, nearHeli(a));
      }
    }
  }
}
