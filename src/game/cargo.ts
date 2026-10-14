import * as THREE from 'three';
import type { Terrain } from '../world/terrain';
import type { RNG } from '../util/noise';
import {
  SoldierRenderer,
  blendJoints,
  buckle,
  crouch,
  fly,
  gait,
  gunner,
  litterCarry,
  litterLift,
  lying,
  push,
  pull,
  randomSkin,
  rifleArms,
  rootMatrix,
  sit,
  standJoints,
  strap,
  throwOver,
  wave,
  type Joints,
  type Outfit,
  type RifleCarry,
  type SoldierInstance,
} from './soldiers';

export type ActorKind = 'soldier' | 'casualty' | 'pallet';

/** Where things go inside a carrier, in its body frame (forward = −Z). */
export interface CabinLayout {
  floor: number;
  /** Top of the ramp / tailgate: where the cabin floor starts. */
  hinge: THREE.Vector3;
  seats: { pos: THREE.Vector3; heading: number }[];
  /** Litter centres (bed height), litter axis along Z. */
  litters: THREE.Vector3[];
  /** Pallet centres on the floor. */
  pallets: THREE.Vector3[];
  /** Footprint people walk around on the ground: |x| < halfWidth, front < z < back. */
  hull: { halfWidth: number; front: number; back: number };
}

export interface CrewStation {
  pos: THREE.Vector3;
  heading: number;
}

export interface CrewContext {
  frame: THREE.Object3D;
  chiefSeat: THREE.Vector3;
  /** Door and window gunners. */
  gunners: CrewStation[];
  /** Pilot (right seat) and co-pilot. */
  pilots: CrewStation[];
  /** Hide the pilot when the camera is in his seat. */
  hidePilot: boolean;
  hinge: THREE.Vector3;
  rampT: number;
  marshalling: boolean;
  visible: boolean;
}

export interface LoadContext {
  canLoad: boolean;
  canUnload: boolean;
  rampEnd: THREE.Vector3;
  cabin: THREE.Vector3;
  heliPos: THREE.Vector3;
  rotorsTurning: boolean;
  /** Body frame of the carrier being loaded (helicopter or Humvee). */
  frame: THREE.Object3D;
  layout: CabinLayout;
  crew?: CrewContext;
}

type Space = 'world' | 'cabin';

/** One person: an instance for the renderer plus its own place and pose. */
class Person {
  inst: SoldierInstance;
  joints: Joints = standJoints();
  target: Joints = standJoints();
  pos = new THREE.Vector3();
  heading = 0;
  phase = Math.random() * 10;
  /** Reached the aisle beside its seat and is now sitting down. */
  sitting = false;
  constructor(outfit: Outfit, rifle: RifleCarry, rnd: () => number) {
    this.inst = { matrix: new THREE.Matrix4(), joints: this.joints, rifle, outfit, skin: randomSkin(rnd), visible: true };
  }
}

// ---------------------------------------------------------------- Props

const M = {
  alu: new THREE.MeshLambertMaterial({ color: 0xa0a29c }),
  pole: new THREE.MeshLambertMaterial({ color: 0x55573e }),
  canvas: new THREE.MeshLambertMaterial({ color: 0x4d5a3a }),
  blanket: new THREE.MeshLambertMaterial({ color: 0x6f7563 }),
  white: new THREE.MeshLambertMaterial({ color: 0xe8e6de }),
  ammo: new THREE.MeshLambertMaterial({ color: 0x59603f }),
  stencil: new THREE.MeshLambertMaterial({ color: 0xc9b24a }),
  box: new THREE.MeshLambertMaterial({ color: 0xb59c6b }),
  wrap: new THREE.MeshLambertMaterial({ color: 0xdfe6e8, transparent: true, opacity: 0.35, depthWrite: false }),
  strap: new THREE.MeshLambertMaterial({ color: 0xd8a72c }),
  jack: new THREE.MeshLambertMaterial({ color: 0xc23a22 }),
  dark: new THREE.MeshLambertMaterial({ color: 0x1d1d1b }),
};

function mesh(geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, parent: THREE.Object3D) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  parent.add(m);
  return m;
}

/** A litter: poles, canvas, blanket over the patient's legs, stanchion straps. */
function buildLitter() {
  const g = new THREE.Group();
  for (const sx of [-0.28, 0.28]) {
    mesh(new THREE.CylinderGeometry(0.022, 0.022, 2.3, 6).rotateX(Math.PI / 2), M.pole, sx, 0, 0, g);
    for (const sz of [-1.05, 1.05]) mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.2, 6).rotateX(Math.PI / 2), M.dark, sx, 0, sz, g);
    for (const sz of [-0.8, 0.8]) mesh(new THREE.BoxGeometry(0.04, 0.12, 0.04), M.pole, sx, -0.07, sz, g);
  }
  mesh(new THREE.BoxGeometry(0.56, 0.015, 1.85), M.canvas, 0, 0.01, 0, g);
  mesh(new THREE.BoxGeometry(0.5, 0.12, 1.0), M.blanket, 0, 0.1, -0.45, g);
  // Stanchion straps (shown once the litter is secured).
  const straps = new THREE.Group();
  for (const sz of [-0.6, 0.55]) mesh(new THREE.BoxGeometry(0.62, 0.02, 0.06), M.strap, 0, 0.2, sz, straps);
  straps.visible = false;
  g.add(straps);
  return { group: g, straps };
}

/** Stanchion poles at a litter rack (shown while a litter is there). */
function buildStanchions(y: number) {
  const g = new THREE.Group();
  for (const sx of [-0.33, 0.33]) for (const sz of [-1.05, 1.05]) mesh(new THREE.CylinderGeometry(0.025, 0.025, 1.6, 6), M.alu, sx, 0.8 - y, sz, g);
  return g;
}

/** A 463L-style pallet with cargo and four tie-down straps that can be drawn on progressively. */
function buildPallet(ammo: boolean, rnd: () => number) {
  const g = new THREE.Group();
  mesh(new THREE.BoxGeometry(1.35, 0.06, 1.35), M.alu, 0, 0.03, 0, g);
  for (const sx of [-0.66, 0.66]) mesh(new THREE.BoxGeometry(0.04, 0.08, 1.35), M.dark, sx, 0.04, 0, g);
  let H = 0;
  if (ammo) {
    // Stacked ammo crates with stencil bands.
    const layers = 3;
    for (let ly = 0; ly < layers; ly++)
      for (let ix = 0; ix < 2; ix++)
        for (let iz = 0; iz < 3; iz++) {
          const y = 0.06 + 0.15 + ly * 0.31;
          mesh(new THREE.BoxGeometry(0.6, 0.3, 0.4), M.ammo, -0.31 + ix * 0.62, y, -0.42 + iz * 0.42, g);
          mesh(new THREE.BoxGeometry(0.61, 0.04, 0.41), M.stencil, -0.31 + ix * 0.62, y + 0.06, -0.42 + iz * 0.42, g);
        }
    H = 0.06 + layers * 0.31;
  } else {
    const layers = 3 + Math.floor(rnd() * 2);
    for (let ly = 0; ly < layers; ly++)
      for (let ix = 0; ix < 3; ix++) for (let iz = 0; iz < 3; iz++) mesh(new THREE.BoxGeometry(0.4, 0.27, 0.4), M.box, -0.42 + ix * 0.42, 0.06 + 0.14 + ly * 0.28, -0.42 + iz * 0.42, g);
    H = 0.06 + layers * 0.28;
    mesh(new THREE.BoxGeometry(1.3, H - 0.04, 1.3), M.wrap, 0, (H + 0.06) / 2, 0, g);
  }
  // Straps: two across X, two across Z; each is up one side, over the top, down the other.
  const straps: THREE.Object3D[][] = [];
  const W = 0.68;
  for (const [axis, off] of [['x', -0.35], ['x', 0.35], ['z', -0.35], ['z', 0.35]] as const) {
    const up = new THREE.Mesh(new THREE.BoxGeometry(0.05, H, 0.05).translate(0, H / 2, 0), M.strap);
    const top = new THREE.Mesh(new THREE.BoxGeometry(W * 2, 0.03, 0.05).translate(W, 0, 0), M.strap);
    const down = new THREE.Mesh(new THREE.BoxGeometry(0.05, H, 0.05).translate(0, -H / 2, 0), M.strap);
    const s = new THREE.Group();
    up.position.set(-W, 0, 0);
    top.position.set(-W, H + 0.01, 0);
    down.position.set(W, H, 0);
    s.add(up, top, down);
    if (axis === 'x') s.position.z = off;
    else {
      s.rotation.y = Math.PI / 2;
      s.position.x = off;
    }
    g.add(s);
    straps.push([up, top, down]);
  }
  return { group: g, straps, height: H };
}

/** Pallet jack: forks toward −Z, handle at +Z. */
function buildJack() {
  const g = new THREE.Group();
  for (const sx of [-0.24, 0.24]) {
    mesh(new THREE.BoxGeometry(0.16, 0.06, 1.15), M.jack, sx, 0.05, -0.55, g);
    mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.12, 6).rotateZ(Math.PI / 2), M.dark, sx, 0.035, -1.05, g);
  }
  mesh(new THREE.BoxGeometry(0.62, 0.22, 0.28), M.jack, 0, 0.14, 0.12, g);
  mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.16, 8).rotateZ(Math.PI / 2), M.dark, 0, 0.07, 0.2, g);
  const handle = new THREE.Group();
  handle.position.set(0, 0.25, 0.2);
  handle.rotation.x = 0.55;
  g.add(handle);
  mesh(new THREE.CylinderGeometry(0.025, 0.025, 1.0, 6).translate(0, 0.5, 0), M.dark, 0, 0, 0, handle);
  mesh(new THREE.BoxGeometry(0.34, 0.04, 0.04), M.dark, 0, 1.0, 0, handle);
  return g;
}

// ---------------------------------------------------------------- Actors

type State =
  | 'waiting' | 'pickup' | 'toRamp' | 'returning' | 'inCabin' | 'settle' | 'buckle' | 'seated'
  | 'lift' | 'secure' | 'toSeats' | 'lower' | 'pullOut' | 'stow' | 'strapping'
  | 'standUp' | 'unstrap' | 'getJack' | 'insert' | 'toLitter' | 'unrack' | 'exitCabin' | 'toRally' | 'arrived';

export class Actor {
  state: State = 'waiting';
  space: Space = 'world';
  /** Formation anchor (litter/pallet centre, or the soldier) in the current space. */
  pos = new THREE.Vector3();
  heading = 0;
  path: THREE.Vector3[] = [];
  people: Person[] = [];
  home = new THREE.Vector3();
  rally = new THREE.Vector3();
  timer = 0;
  step = 0;
  seats: number[] = [];
  spot = -1;
  /** Litter or pallet. */
  prop: THREE.Group | null = null;
  propPos = new THREE.Vector3();
  propHeading = 0;
  propLift = 0;
  jack: THREE.Group | null = null;
  jackPos = new THREE.Vector3();
  jackHeading = 0;
  jackOn = true;
  straps: THREE.Object3D[][] = [];
  strapGroup: THREE.Object3D | null = null;
  strapP = [0, 0, 0, 0];
  stanchions: THREE.Group | null = null;
  palletH = 1;
  /** Kept for the old API (the group's mesh). */
  mesh = new THREE.Group();
  constructor(readonly kind: ActorKind) {}
}

/** A batch of people or pallets that move together between carrier and ground. */
export class CargoGroup {
  actors: Actor[] = [];
  aboard = 0;
  dispatchTimer = 0;
  unloadedCount = 0;
  frame: THREE.Object3D | null = null;
  layout: CabinLayout | null = null;
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

const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _inv = new THREE.Matrix4();

const yawOf = (o: THREE.Object3D) => {
  const e = o.matrixWorld.elements;
  return Math.atan2(e[8], e[10]);
};
const fwd = (h: number, out = new THREE.Vector3()) => out.set(-Math.sin(h), 0, -Math.cos(h));
const turnTo = (cur: number, target: number, rate: number) => {
  let d = target - cur;
  d = Math.atan2(Math.sin(d), Math.cos(d));
  return cur + THREE.MathUtils.clamp(d, -rate, rate);
};

/** Spawns, animates and routes the people and cargo being loaded and unloaded. */
export class CargoManager {
  group = new THREE.Group();
  groups: CargoGroup[] = [];
  onBoard: ((g: CargoGroup, a: Actor) => void) | null = null;
  onUnboard: ((g: CargoGroup, a: Actor) => void) | null = null;
  private renderer = new SoldierRenderer(110);
  private taken = new WeakMap<THREE.Object3D, Set<string>>();
  private chief: Person;
  private gunners: Person[] = [];
  private pilots: Person[] = [];
  private chiefSeated = 1;
  private time = 0;

  constructor(
    private terrain: Terrain,
    private rng: RNG,
  ) {
    this.group.add(this.renderer.group);
    const rnd = () => this.rng.next();
    this.chief = new Person('crew', 'none', rnd);
    for (let i = 0; i < 2; i++) {
      this.gunners.push(new Person('crew', 'none', rnd));
      this.pilots.push(new Person('crew', 'none', rnd));
    }
  }

  private occupancy(frame: THREE.Object3D) {
    let s = this.taken.get(frame);
    if (!s) this.taken.set(frame, (s = new Set()));
    return s;
  }

  /** Create a group waiting in formation at a spot, facing toward `face`. */
  spawnWaiting(kind: ActorKind, count: number, unitMass: number, at: THREE.Vector3, face: THREE.Vector3): CargoGroup {
    const g = new CargoGroup(kind, count, unitMass);
    const dir = Math.atan2(face.x - at.x, face.z - at.z) + Math.PI;
    const cols = kind === 'soldier' ? 4 : 2;
    const spacing = kind === 'soldier' ? 1.5 : 3.4;
    const rnd = () => this.rng.next();
    for (let i = 0; i < count; i++) {
      const a = new Actor(kind);
      const cx = (i % cols) - (cols - 1) / 2;
      const cz = Math.floor(i / cols);
      const lx = cx * spacing + this.rng.range(-0.2, 0.2);
      const lz = cz * spacing * (kind === 'soldier' ? 1 : 1.3);
      // Formation axes: across = (cos d, -sin d), back = (sin d, cos d) in xz.
      a.home.set(at.x + lx * Math.cos(dir) + lz * Math.sin(dir), 0, at.z - lx * Math.sin(dir) + lz * Math.cos(dir));
      a.home.y = this.terrain.heightAt(a.home.x, a.home.z);
      a.pos.copy(a.home);
      a.heading = dir;
      if (kind === 'soldier') a.people.push(new Person('infantry', 'sling', rnd));
      else if (kind === 'casualty') {
        a.people.push(new Person('medic', 'back', rnd), new Person('medic', 'back', rnd), new Person('patient', 'none', rnd));
        const l = buildLitter();
        a.prop = l.group;
        a.strapGroup = l.straps;
        this.group.add(l.group);
      } else {
        a.people.push(new Person('infantry', 'back', rnd));
        const p = buildPallet(unitMass > 800, rnd);
        a.prop = p.group;
        a.straps = p.straps;
        a.palletH = p.height;
        a.strapP = [0, 0, 0, 0];
        a.jack = buildJack();
        this.group.add(p.group, a.jack);
      }
      for (const pr of [a.prop, a.jack]) if (pr) pr.matrixAutoUpdate = false;
      g.actors.push(a);
    }
    this.groups.push(g);
    return g;
  }

  /** Create a group already aboard (not used by current missions; kept for the API). */
  spawnAboard(kind: ActorKind, count: number, unitMass: number): CargoGroup {
    const g = new CargoGroup(kind, count, unitMass);
    for (let i = 0; i < count; i++) {
      const a = new Actor(kind);
      a.state = 'arrived';
      g.actors.push(a);
    }
    g.aboard = count;
    this.groups.push(g);
    return g;
  }

  remove(g: CargoGroup) {
    for (const a of g.actors) {
      for (const pr of [a.prop, a.jack, a.stanchions]) if (pr) pr.parent?.remove(pr);
      if (g.frame) {
        const occ = this.occupancy(g.frame);
        for (const s of a.seats) occ.delete(`seat:${s}`);
        if (a.spot >= 0) occ.delete(`${a.kind}:${a.spot}`);
      }
    }
    this.groups = this.groups.filter((x) => x !== g);
  }

  clear() {
    for (const g of [...this.groups]) this.remove(g);
  }

  setRally(g: CargoGroup, at: THREE.Vector3) {
    g.actors.forEach((a, i) => {
      const ang = (i / Math.max(1, g.total)) * Math.PI * 1.2 - 0.6;
      const r = (a.kind === 'soldier' ? 4 : 7) + (i % 3) * 2.5;
      a.rally.set(at.x + Math.sin(ang) * r, 0, at.z + Math.cos(ang) * r);
      a.rally.y = this.terrain.heightAt(a.rally.x, a.rally.z);
    });
  }

  // ---------------------------------------------------------------- helpers

  private frameOf(g: CargoGroup, ctx: LoadContext) {
    return g.frame ?? ctx.frame;
  }

  private toCabin(a: Actor, frame: THREE.Object3D) {
    _inv.copy(frame.matrixWorld).invert();
    const yaw = yawOf(frame);
    a.pos.applyMatrix4(_inv);
    a.heading -= yaw;
    for (const p of a.people) {
      p.pos.applyMatrix4(_inv);
      p.heading -= yaw;
    }
    a.propPos.applyMatrix4(_inv);
    a.propHeading -= yaw;
    a.jackPos.applyMatrix4(_inv);
    a.jackHeading -= yaw;
    a.space = 'cabin';
  }

  private toWorld(a: Actor, frame: THREE.Object3D) {
    const yaw = yawOf(frame);
    a.pos.applyMatrix4(frame.matrixWorld);
    a.heading += yaw;
    for (const p of a.people) {
      p.pos.applyMatrix4(frame.matrixWorld);
      p.heading += yaw;
    }
    a.propPos.applyMatrix4(frame.matrixWorld);
    a.propHeading += yaw;
    a.jackPos.applyMatrix4(frame.matrixWorld);
    a.jackHeading += yaw;
    a.space = 'world';
  }

  /**
   * World-space waypoints from `from` to `to` that walk around the carrier
   * instead of through it (shortest path via the corners of its footprint).
   * The returned list ends with `to`.
   */
  private around(from: THREE.Vector3, to: THREE.Vector3, frame: THREE.Object3D, L: CabinLayout): THREE.Vector3[] {
    const h = L.hull;
    _inv.copy(frame.matrixWorld).invert();
    const a = from.clone().applyMatrix4(_inv);
    const b = to.clone().applyMatrix4(_inv);
    const m = 1.1;
    const nodes = [a, b];
    for (const x of [-h.halfWidth - m, h.halfWidth + m]) for (const z of [h.front - m, h.back + m]) nodes.push(new THREE.Vector3(x, 0, z));
    // Does a segment cut through the footprint (shrunk a touch so edges and corners are walkable)?
    const blocked = (p: THREE.Vector3, q: THREE.Vector3) => {
      const x0 = -h.halfWidth + 0.05, x1 = h.halfWidth - 0.05, z0 = h.front + 0.05, z1 = h.back - 0.05;
      let t0 = 0, t1 = 1;
      const dx = q.x - p.x, dz = q.z - p.z;
      for (const [d, lo, hi, o] of [[dx, x0, x1, p.x], [dz, z0, z1, p.z]] as const) {
        if (Math.abs(d) < 1e-9) {
          if (o <= lo || o >= hi) return false;
        } else {
          let ta = (lo - o) / d, tb = (hi - o) / d;
          if (ta > tb) [ta, tb] = [tb, ta];
          t0 = Math.max(t0, ta);
          t1 = Math.min(t1, tb);
          if (t0 >= t1) return false;
        }
      }
      return true;
    };
    const flat = (p: THREE.Vector3, q: THREE.Vector3) => Math.hypot(p.x - q.x, p.z - q.z);
    // Dijkstra over six nodes.
    const dist = nodes.map(() => Infinity);
    const prev = nodes.map(() => -1);
    const done = nodes.map(() => false);
    dist[0] = 0;
    for (;;) {
      let u = -1;
      for (let i = 0; i < nodes.length; i++) if (!done[i] && dist[i] < Infinity && (u < 0 || dist[i] < dist[u])) u = i;
      if (u < 0 || u === 1) break;
      done[u] = true;
      for (let v = 0; v < nodes.length; v++) {
        if (done[v] || v === u || blocked(nodes[u], nodes[v])) continue;
        const d = dist[u] + flat(nodes[u], nodes[v]);
        if (d < dist[v]) (dist[v] = d), (prev[v] = u);
      }
    }
    const out: THREE.Vector3[] = [to.clone()];
    if (dist[1] === Infinity) return out;
    for (let i = prev[1]; i > 0; i = prev[i]) out.unshift(nodes[i].clone().applyMatrix4(frame.matrixWorld));
    return out;
  }

  /** Walk around the carrier to a point behind the ramp, then up to the ramp end. */
  private toRampPath(from: THREE.Vector3, ctx: LoadContext): THREE.Vector3[] {
    const stage = this.stagePoint(ctx, ctx.frame);
    return [...this.around(from, stage, ctx.frame, ctx.layout), ctx.rampEnd.clone()];
  }

  /** A point on the ground a little behind the ramp end, lined up with it. */
  private stagePoint(ctx: LoadContext, frame: THREE.Object3D) {
    const p = this.rampLocal(ctx, frame);
    p.z += 1.6;
    return p.applyMatrix4(frame.matrixWorld);
  }

  /** Ramp end in the carrier's frame. */
  private rampLocal(ctx: LoadContext, frame: THREE.Object3D) {
    _inv.copy(frame.matrixWorld).invert();
    return ctx.rampEnd.clone().applyMatrix4(_inv);
  }

  /** Move the formation anchor along its path; returns true when the path is done. */
  private follow(a: Actor, dt: number, speed: number, faceBack = false): boolean {
    let budget = speed * dt;
    while (a.path.length && budget > 0) {
      const t = a.path[0];
      const d = _v.copy(t).sub(a.pos);
      if (a.space === 'world') d.y = 0;
      const dist = d.length();
      if (dist > 0.05) a.heading = turnTo(a.heading, Math.atan2(d.x, d.z) + (faceBack ? 0 : Math.PI), dt * 6);
      if (dist <= budget) {
        a.pos.x = t.x;
        a.pos.z = t.z;
        if (a.space === 'cabin') a.pos.y = t.y;
        a.path.shift();
        budget -= dist;
      } else {
        a.pos.addScaledVector(d, budget / dist);
        budget = 0;
      }
    }
    if (a.space === 'world') a.pos.y = this.terrain.heightAt(a.pos.x, a.pos.z);
    return a.path.length === 0;
  }

  /** Walk one person straight toward a point (cabin or world space); true on arrival. */
  private walkPerson(p: Person, target: THREE.Vector3, dt: number, speed: number, space: Space): boolean {
    const d = _v.copy(target).sub(p.pos);
    d.y = 0;
    const dist = d.length();
    if (dist > 0.05) p.heading = turnTo(p.heading, Math.atan2(d.x, d.z) + Math.PI, dt * 7);
    if (dist <= speed * dt) {
      p.pos.x = target.x;
      p.pos.z = target.z;
      p.pos.y = space === 'world' ? this.terrain.heightAt(p.pos.x, p.pos.z) : target.y;
      gait(p.target, p.phase, 0);
      return true;
    }
    p.pos.addScaledVector(d, (speed * dt) / dist);
    if (space === 'world') p.pos.y = this.terrain.heightAt(p.pos.x, p.pos.z);
    else p.pos.y = target.y;
    p.phase += dt * speed * 2.6;
    gait(p.target, p.phase, speed);
    return false;
  }

  private freeSeat(frame: THREE.Object3D, layout: CabinLayout, nearZ?: number, side?: number): number {
    const occ = this.occupancy(frame);
    let best = -1;
    let bd = Infinity;
    layout.seats.forEach((s, i) => {
      if (occ.has(`seat:${i}`)) return;
      if (side !== undefined && Math.sign(s.pos.x) !== side) return;
      const d = nearZ === undefined ? i : Math.abs(s.pos.z - nearZ);
      if (d < bd) (bd = d), (best = i);
    });
    if (best >= 0) occ.add(`seat:${best}`);
    return best;
  }

  private freeSpot(frame: THREE.Object3D, list: THREE.Vector3[], kind: ActorKind): number {
    const occ = this.occupancy(frame);
    for (let i = 0; i < list.length; i++)
      if (!occ.has(`${kind}:${i}`)) {
        occ.add(`${kind}:${i}`);
        return i;
      }
    return -1;
  }

  private release(a: Actor, frame: THREE.Object3D) {
    const occ = this.occupancy(frame);
    for (const s of a.seats) occ.delete(`seat:${s}`);
    if (a.spot >= 0) occ.delete(`${a.kind}:${a.spot}`);
    a.seats = [];
    a.spot = -1;
  }

  // ---------------------------------------------------------------- update

  update(dt: number, ctx: LoadContext) {
    this.time += dt;
    ctx.frame.updateMatrixWorld(true);
    ctx.crew?.frame.updateMatrixWorld(true);
    const instances: SoldierInstance[] = [];
    for (const g of this.groups) {
      g.dispatchTimer -= dt;
      g.frame?.updateMatrixWorld(true);
      // Loading: send the next one in.
      if (ctx.canLoad && g.dispatchTimer <= 0 && (!g.frame || g.frame === ctx.frame)) {
        const a = g.actors.find((x) => x.state === 'waiting');
        if (a && this.dispatchLoad(g, a, ctx)) g.dispatchTimer = a.kind === 'soldier' ? 0.55 : a.kind === 'casualty' ? 2.5 : 5;
      }
      // Unloading: rear-most first.
      if (ctx.canUnload && g.dispatchTimer <= 0 && g.layout) {
        const seated = g.actors.filter((x) => x.state === 'seated');
        if (seated.length) {
          const pick = seated.reduce((p, q) => (this.rearZ(g, q) > this.rearZ(g, p) ? q : p));
          this.dispatchUnload(g, pick);
          g.dispatchTimer = pick.kind === 'soldier' ? 0.5 : pick.kind === 'casualty' ? 3 : 6;
        }
      }
      for (const a of g.actors) {
        if (a.kind === 'soldier') this.updateSoldier(g, a, dt, ctx);
        else if (a.kind === 'casualty') this.updateLitter(g, a, dt, ctx);
        else this.updatePallet(g, a, dt, ctx);
        this.place(g, a, ctx, dt, instances);
      }
    }
    if (ctx.crew) this.updateCrew(dt, ctx.crew, instances);
    this.renderer.render(instances);
  }

  private rearZ(g: CargoGroup, a: Actor) {
    const L = g.layout!;
    if (a.kind === 'soldier') return L.seats[a.seats[0]]?.pos.z ?? 0;
    return (a.kind === 'casualty' ? L.litters[a.spot]?.z : L.pallets[a.spot]?.z) ?? 0;
  }

  private dispatchLoad(g: CargoGroup, a: Actor, ctx: LoadContext): boolean {
    const frame = ctx.frame;
    const L = ctx.layout;
    if (a.kind === 'soldier') {
      const s = this.freeSeat(frame, L);
      if (s < 0) return false;
      a.seats = [s];
      a.people[0].inst.rifle = 'hands';
    } else if (a.kind === 'casualty') {
      const spot = this.freeSpot(frame, L.litters, 'casualty');
      if (spot < 0) return false;
      a.spot = spot;
      const z = L.litters[spot].z;
      a.seats = [this.freeSeat(frame, L, z, -1), this.freeSeat(frame, L, z, 1)];
      a.state = 'pickup';
      a.path = [];
      a.timer = 0;
      g.frame = frame;
      g.layout = L;
      return true;
    } else {
      const spot = this.freeSpot(frame, L.pallets, 'pallet');
      if (spot < 0) return false;
      a.spot = spot;
      a.seats = [this.freeSeat(frame, L, L.pallets[spot].z)];
    }
    g.frame = frame;
    g.layout = L;
    a.state = 'toRamp';
    a.path = this.toRampPath(a.pos, ctx);
    return true;
  }

  private dispatchUnload(g: CargoGroup, a: Actor) {
    a.state = 'standUp';
    a.timer = 0;
    a.step = 0;
    g.aboard--;
  }

  /** Clear of the ramp: now it counts as delivered. */
  private offloaded(g: CargoGroup, a: Actor) {
    g.unloadedCount++;
    this.onUnboard?.(g, a);
  }

  private secured(g: CargoGroup, a: Actor) {
    a.state = 'seated';
    g.aboard++;
    this.onBoard?.(g, a);
  }

  // ---------------------------------------------------------------- soldiers

  private updateSoldier(g: CargoGroup, a: Actor, dt: number, ctx: LoadContext) {
    const p = a.people[0];
    const frame = this.frameOf(g, ctx);
    const L = g.layout ?? ctx.layout;
    const seat = L.seats[a.seats[0]];
    const near = ctx.rotorsTurning && a.space === 'world' && a.pos.distanceTo(ctx.heliPos) < 60;
    switch (a.state) {
      case 'waiting': {
        a.heading = turnTo(a.heading, Math.atan2(ctx.heliPos.x - a.pos.x, ctx.heliPos.z - a.pos.z) + Math.PI, dt * 3);
        if (near) crouch(p.target);
        else {
          Object.assign(p.target, standJoints());
          p.target.headYaw = Math.sin(this.time * 0.3 + p.phase) * 0.4;
        }
        p.inst.rifle = near ? 'hands' : 'sling';
        break;
      }
      case 'toRamp': {
        if (!ctx.canLoad) {
          this.release(a, frame);
          a.state = 'returning';
          a.path = this.around(a.pos, a.home, frame, L);
          break;
        }
        p.phase += dt * 3.6 * 2.6;
        rifleArms(gait(p.target, p.phase, 3.6));
        if (this.follow(a, dt, 3.6)) {
          this.toCabin(a, frame);
          // Up the ramp, along the aisle, to just in front of the seat.
          a.path = [L.hinge.clone(), new THREE.Vector3(0, L.floor, seat.pos.z), new THREE.Vector3(seat.pos.x * 0.45, L.floor, seat.pos.z)];
          a.state = 'inCabin';
        }
        break;
      }
      case 'returning': {
        p.phase += dt * 3.6 * 2.6;
        rifleArms(gait(p.target, p.phase, 3.6));
        if (this.follow(a, dt, 3.6)) a.state = 'waiting';
        if (ctx.canLoad) a.state = 'waiting';
        break;
      }
      case 'inCabin': {
        p.phase += dt * 2.2 * 2.6;
        rifleArms(gait(p.target, p.phase, 2.2));
        if (this.follow(a, dt, 2.2)) {
          a.state = 'settle';
          a.timer = 0;
        }
        break;
      }
      case 'settle': {
        // Turn, back up to the seat and sit down.
        a.timer += dt;
        a.heading = turnTo(a.heading, seat.heading, dt * 5);
        const k = Math.min(1, a.timer / 0.8);
        a.pos.lerp(seat.pos, Math.min(1, dt * 4));
        sit(p.target);
        if (k < 0.5) p.target.hip = 0.75;
        if (a.timer > 0.8) {
          a.state = 'buckle';
          a.timer = 0;
        }
        break;
      }
      case 'buckle': {
        a.timer += dt;
        a.pos.lerp(seat.pos, Math.min(1, dt * 6));
        buckle(p.target, a.timer);
        if (a.timer > 1.3) this.secured(g, a);
        break;
      }
      case 'seated': {
        a.pos.copy(seat.pos);
        a.heading = seat.heading;
        sit(p.target);
        // Idle: look around, the odd glance out the back.
        p.target.headYaw = Math.sin(this.time * 0.35 + p.phase * 3) * 0.55;
        p.target.head = -0.1 + Math.sin(this.time * 0.21 + p.phase) * 0.12;
        break;
      }
      case 'standUp': {
        a.timer += dt;
        Object.assign(p.target, standJoints());
        if (a.timer > 0.6) {
          a.path = [new THREE.Vector3(seat.pos.x * 0.45, L.floor, seat.pos.z), new THREE.Vector3(0, L.floor, seat.pos.z), L.hinge.clone(), this.rampLocal(ctx, frame)];
          a.state = 'exitCabin';
          this.release(a, frame);
        }
        break;
      }
      case 'exitCabin': {
        p.phase += dt * 2.4 * 2.6;
        rifleArms(gait(p.target, p.phase, 2.4));
        if (this.follow(a, dt, 2.4)) {
          this.toWorld(a, frame);
          this.offloaded(g, a);
          const stage = this.stagePoint(ctx, frame);
          a.path = [stage, ...this.around(stage, a.rally, frame, L)];
          a.state = 'toRally';
        }
        break;
      }
      case 'toRally': {
        p.phase += dt * 3.4 * 2.6;
        rifleArms(gait(p.target, p.phase, 3.4));
        if (this.follow(a, dt, 3.4)) {
          a.state = 'arrived';
          a.timer = 0;
        }
        break;
      }
      case 'arrived': {
        a.timer += dt;
        crouch(p.target);
        if (a.timer > 10) p.inst.visible = false;
        break;
      }
    }
    if (a.kind === 'soldier') {
      p.pos.copy(a.pos);
      p.heading = a.heading;
    }
  }

  // ---------------------------------------------------------------- litters

  private litterFormation(a: Actor, dt: number, speed: number, moving: boolean, frontFirst = true) {
    const f = fwd(a.heading, _w);
    const [front, back, patient] = a.people;
    front.pos.copy(a.pos).addScaledVector(f, 1.25);
    back.pos.copy(a.pos).addScaledVector(f, -1.25);
    front.heading = a.heading;
    back.heading = a.heading;
    if (moving) {
      front.phase += dt * speed * 2.6;
      back.phase = front.phase + Math.PI;
    }
    litterCarry(front.target, front.phase, moving ? speed : 0, frontFirst);
    litterCarry(back.target, back.phase, moving ? speed : 0, !frontFirst);
    a.propPos.copy(a.pos);
    a.propPos.y += 0.8;
    a.propHeading = a.heading;
    patient.pos.copy(a.propPos);
    patient.heading = a.heading;
  }

  private updateLitter(g: CargoGroup, a: Actor, dt: number, ctx: LoadContext) {
    const frame = this.frameOf(g, ctx);
    const L = g.layout ?? ctx.layout;
    const [front, back, patient] = a.people;
    lying(patient.target, this.time + patient.phase);
    switch (a.state) {
      case 'waiting': {
        // Litter on the ground, the team kneeling either side of it.
        a.propPos.copy(a.pos);
        a.propPos.y += 0.2;
        a.propHeading = a.heading;
        const side = _w.set(Math.cos(a.heading), 0, -Math.sin(a.heading));
        front.pos.copy(a.pos).addScaledVector(side, -0.75);
        back.pos.copy(a.pos).addScaledVector(side, 0.75);
        front.heading = a.heading - Math.PI / 2;
        back.heading = a.heading + Math.PI / 2;
        crouch(front.target);
        crouch(back.target);
        front.inst.rifle = 'back';
        back.inst.rifle = 'back';
        patient.pos.copy(a.propPos);
        patient.heading = a.heading;
        for (const p of [front, back]) p.pos.y = this.terrain.heightAt(p.pos.x, p.pos.z);
        break;
      }
      case 'pickup': {
        a.timer += dt;
        // Turn the litter toward the ramp and lift it.
        if (!a.path.length) a.path = this.toRampPath(a.pos, ctx);
        const aim = a.path[0];
        a.heading = turnTo(a.heading, Math.atan2(aim.x - a.pos.x, aim.z - a.pos.z) + Math.PI, dt * 2);
        this.litterFormation(a, dt, 0, false);
        a.propPos.y = a.pos.y + 0.2 + Math.min(1, a.timer / 0.9) * 0.6;
        patient.pos.copy(a.propPos);
        if (a.timer > 1.0) {
          a.state = 'toRamp';
        }
        break;
      }
      case 'toRamp': {
        this.litterFormation(a, dt, 1.6, true);
        if (this.follow(a, dt, 1.6)) {
          this.toCabin(a, frame);
          const spot = L.litters[a.spot];
          a.path = [L.hinge.clone(), new THREE.Vector3(0, L.floor, spot.z)];
          a.state = 'inCabin';
        }
        break;
      }
      case 'inCabin': {
        this.litterFormation(a, dt, 1.2, true);
        if (this.follow(a, dt, 1.2)) {
          a.state = 'lift';
          a.timer = 0;
        }
        break;
      }
      case 'lift': {
        // Line up with the rack and raise or lower the litter onto it.
        a.timer += dt;
        a.heading = turnTo(a.heading, 0, dt * 3);
        this.litterFormation(a, dt, 0, false);
        const spot = L.litters[a.spot];
        const k = Math.min(1, a.timer / 1.4);
        a.propPos.y = THREE.MathUtils.lerp(L.floor + 0.8, spot.y, k);
        patient.pos.copy(a.propPos);
        const high = spot.y > L.floor + 0.8;
        if (high) {
          litterLift(front.target, k);
          litterLift(back.target, k);
        } else {
          crouch(front.target);
          crouch(back.target);
          front.target.armL = front.target.armR = 0.6;
          back.target.armL = back.target.armR = 0.6;
        }
        if (a.timer > 1.5) {
          a.state = 'secure';
          a.timer = 0;
          a.stanchions = buildStanchions(spot.y - L.floor);
          a.stanchions.matrixAutoUpdate = false;
          this.group.add(a.stanchions);
        }
        break;
      }
      case 'secure': {
        a.timer += dt;
        const spot = L.litters[a.spot];
        const high = spot.y > L.floor + 0.8;
        for (const p of [front, back]) high ? throwOver(p.target, a.timer) : strap(p.target, a.timer);
        if (a.timer > 1.1 && a.strapGroup) a.strapGroup.visible = true;
        if (a.timer > 1.8) {
          a.state = 'toSeats';
          a.timer = 0;
        }
        break;
      }
      case 'toSeats': {
        // Each bearer walks to his seat beside the litter and sits.
        let done = 0;
        [front, back].forEach((p, i) => {
          const seat = L.seats[a.seats[i]];
          if (!seat) {
            done++;
            return;
          }
          const front2 = _w.set(seat.pos.x * 0.45, L.floor, seat.pos.z);
          if (p.sitting || this.walkPerson(p, front2, dt, 1.6, 'cabin')) {
            p.sitting = true;
            p.pos.lerp(seat.pos, Math.min(1, dt * 4));
            p.heading = turnTo(p.heading, seat.heading, dt * 5);
            sit(p.target);
            if (p.pos.distanceTo(seat.pos) < 0.05) done++;
          }
        });
        if (done === 2) this.secured(g, a);
        break;
      }
      case 'seated': {
        [front, back].forEach((p, i) => {
          const seat = L.seats[a.seats[i]];
          if (seat) {
            p.pos.copy(seat.pos);
            p.heading = seat.heading;
          }
          sit(p.target);
          // Keep an eye on the patient.
          p.target.headYaw = (i ? -1 : 1) * 0.5 + Math.sin(this.time * 0.4 + p.phase) * 0.3;
        });
        break;
      }
      case 'standUp': {
        a.timer += dt;
        for (const p of [front, back]) {
          Object.assign(p.target, standJoints());
          p.sitting = false;
        }
        if (a.timer > 0.6) {
          a.state = 'toLitter';
          a.timer = 0;
        }
        break;
      }
      case 'toLitter': {
        const spot = L.litters[a.spot];
        const ends = [new THREE.Vector3(0, L.floor, spot.z - 1.25), new THREE.Vector3(0, L.floor, spot.z + 1.25)];
        let done = 0;
        [front, back].forEach((p, i) => {
          if (this.walkPerson(p, ends[i], dt, 1.6, 'cabin')) {
            p.heading = turnTo(p.heading, 0, dt * 5);
            done++;
          }
        });
        if (done === 2) {
          a.state = 'unrack';
          a.timer = 0;
          if (a.strapGroup) a.strapGroup.visible = false;
        }
        break;
      }
      case 'unrack': {
        a.timer += dt;
        const spot = L.litters[a.spot];
        a.pos.set(0, L.floor, spot.z);
        a.heading = 0;
        const k = Math.min(1, a.timer / 1.2);
        this.litterFormation(a, dt, 0, false);
        a.propPos.y = THREE.MathUtils.lerp(spot.y, L.floor + 0.8, k);
        patient.pos.copy(a.propPos);
        if (a.timer > 1.3) {
          if (a.stanchions) this.group.remove(a.stanchions);
          a.stanchions = null;
          this.release(a, frame);
          a.path = [L.hinge.clone(), this.rampLocal(ctx, frame)];
          a.state = 'exitCabin';
        }
        break;
      }
      case 'exitCabin': {
        // Out feet first: the carry heads aft, toward the ramp.
        this.litterFormation(a, dt, 1.2, true);
        if (this.follow(a, dt, 1.2)) {
          this.toWorld(a, frame);
          this.offloaded(g, a);
          const stage = this.stagePoint(ctx, frame);
          a.path = [stage, ...this.around(stage, a.rally, frame, L)];
          a.state = 'toRally';
        }
        break;
      }
      case 'toRally': {
        this.litterFormation(a, dt, 1.6, true);
        if (this.follow(a, dt, 1.6)) {
          a.state = 'arrived';
          a.timer = 0;
        }
        break;
      }
      case 'arrived': {
        a.timer += dt;
        this.litterFormation(a, dt, 0, false);
        a.propPos.y = a.pos.y + 0.2 + Math.max(0, 0.6 - a.timer) ;
        patient.pos.copy(a.propPos);
        crouch(front.target);
        crouch(back.target);
        if (a.timer > 12) for (const p of a.people) p.inst.visible = false;
        break;
      }
    }
    if (a.state === 'waiting' || a.state === 'arrived') a.propPos.y = Math.max(a.propPos.y, a.pos.y + 0.2);
  }

  // ---------------------------------------------------------------- pallets

  /** Loader pushing (behind) or towing (ahead) the pallet on its jack. */
  private palletFormation(a: Actor, dt: number, speed: number, moving: boolean, towing: boolean) {
    const f = fwd(a.heading, _w);
    const loader = a.people[0];
    a.propPos.copy(a.pos);
    a.propPos.y += 0.1;
    a.propHeading = a.heading;
    a.jackPos.copy(a.pos);
    a.jackHeading = towing ? a.heading + Math.PI : a.heading;
    loader.pos.copy(a.pos).addScaledVector(f, towing ? 1.4 : -1.35);
    loader.heading = a.heading;
    if (moving) loader.phase += dt * speed * 2.6;
    if (towing) {
      gait(loader.target, loader.phase, moving ? speed : 0);
      loader.target.armR = -0.35;
      loader.target.elbowR = 0.2;
      loader.target.lean = 0.15;
    } else push(loader.target, loader.phase, moving ? speed : 0);
  }

  private corner(a: Actor, L: CabinLayout, k: number) {
    const c = L.pallets[a.spot];
    const xs = [-0.95, 0.95, 0.95, -0.95];
    const zs = [-0.35, -0.35, 0.35, 0.35];
    // Straps 0,1 run across X (kneel at their ends on alternating sides); 2,3 across Z.
    if (k < 2) return new THREE.Vector3(xs[k * 2] * (k ? -1 : 1), L.floor, c.z + zs[k * 2]);
    return new THREE.Vector3(c.x + (k === 2 ? -0.35 : 0.35), L.floor, c.z + (k === 2 ? 0.95 : -0.95));
  }

  private setStraps(a: Actor) {
    a.straps.forEach((s, i) => {
      const p = a.strapP[i];
      const [up, top, down] = s;
      up.scale.y = Math.max(0.001, Math.min(1, p * 3));
      top.scale.x = Math.max(0.001, Math.min(1, p * 3 - 1));
      down.scale.y = Math.max(0.001, Math.min(1, p * 3 - 2));
      up.visible = p > 0.01;
      top.visible = p > 0.34;
      down.visible = p > 0.67;
    });
  }

  private updatePallet(g: CargoGroup, a: Actor, dt: number, ctx: LoadContext) {
    const frame = this.frameOf(g, ctx);
    const L = g.layout ?? ctx.layout;
    const loader = a.people[0];
    switch (a.state) {
      case 'waiting': {
        this.palletFormation(a, dt, 0, false, false);
        loader.target.lean = 0;
        loader.target.armL = loader.target.armR = 0.6;
        break;
      }
      case 'toRamp': {
        if (!ctx.canLoad) {
          this.release(a, frame);
          a.state = 'returning';
          a.path = this.around(a.pos, a.home, frame, L);
          break;
        }
        this.palletFormation(a, dt, 1.4, true, false);
        if (this.follow(a, dt, 1.4)) {
          this.toCabin(a, frame);
          a.path = [L.hinge.clone(), new THREE.Vector3(0, L.floor, L.pallets[a.spot].z)];
          a.state = 'inCabin';
        }
        break;
      }
      case 'returning': {
        this.palletFormation(a, dt, 1.4, true, false);
        if (this.follow(a, dt, 1.4) || ctx.canLoad) a.state = 'waiting';
        break;
      }
      case 'inCabin': {
        this.palletFormation(a, dt, 1.0, true, false);
        if (this.follow(a, dt, 1.0)) {
          a.state = 'lower';
          a.timer = 0;
        }
        break;
      }
      case 'lower': {
        a.timer += dt;
        a.heading = turnTo(a.heading, 0, dt * 3);
        this.palletFormation(a, dt, 0, false, false);
        a.propPos.y = a.pos.y + 0.1 * (1 - Math.min(1, a.timer / 0.6));
        if (a.timer > 0.7) {
          a.state = 'pullOut';
          a.timer = 0;
          a.propPos.y = a.pos.y;
        }
        break;
      }
      case 'pullOut': {
        // Draw the jack back out from under the pallet.
        a.timer += dt;
        const k = Math.min(1, a.timer / 1.6);
        const c = L.pallets[a.spot];
        a.propPos.set(c.x, L.floor, c.z);
        a.propHeading = 0;
        a.jackPos.set(0, L.floor, c.z + k * 1.7);
        a.jackHeading = 0;
        loader.pos.set(0, L.floor, c.z + 1.35 + k * 1.7);
        loader.heading = 0;
        loader.phase += dt * 2.5;
        pull(loader.target, loader.phase);
        if (a.timer > 1.7) {
          a.state = 'stow';
          a.timer = 0;
        }
        break;
      }
      case 'stow': {
        // Park the jack in front of the loader's seat, by the wall.
        const seat = L.seats[a.seats[0]];
        const park = new THREE.Vector3(seat ? seat.pos.x * 0.62 : 0.8, L.floor, seat ? seat.pos.z : L.pallets[a.spot].z + 2);
        const walkTo = park.clone().add(new THREE.Vector3(0, 0, 1.3));
        const arrived = this.walkPerson(loader, walkTo, dt, 1.0, 'cabin');
        push(loader.target, loader.phase, arrived ? 0 : 1);
        a.jackPos.copy(loader.pos).addScaledVector(fwd(loader.heading, _w), 1.3);
        a.jackHeading = loader.heading;
        if (arrived) {
          a.jackPos.copy(park);
          a.jackHeading = 0;
          a.state = 'strapping';
          a.step = 0;
          a.timer = 0;
        }
        break;
      }
      case 'strapping': {
        // Each corner: walk there, kneel, run the strap over and ratchet it down.
        const target = this.corner(a, L, a.step);
        if (loader.pos.distanceTo(target) > 0.08) {
          this.walkPerson(loader, target, dt, 1.4, 'cabin');
          a.timer = 0;
        } else {
          a.timer += dt;
          const c = L.pallets[a.spot];
          loader.heading = turnTo(loader.heading, Math.atan2(c.x - loader.pos.x, c.z - loader.pos.z) + Math.PI, dt * 6);
          if (a.timer < 0.7) throwOver(loader.target, a.timer / 0.7);
          else strap(loader.target, a.timer);
          a.strapP[a.step] = Math.min(1, a.timer / 1.4);
          if (a.timer > 1.6) {
            a.step++;
            a.timer = 0;
            if (a.step >= 4) a.state = 'toSeats';
          }
        }
        this.setStraps(a);
        break;
      }
      case 'toSeats': {
        const seat = L.seats[a.seats[0]];
        if (!seat) {
          this.secured(g, a);
          break;
        }
        const front2 = _w.set(seat.pos.x * 0.45, L.floor, seat.pos.z + 0.01);
        if (loader.sitting || this.walkPerson(loader, front2, dt, 1.6, 'cabin')) {
          loader.sitting = true;
          loader.pos.lerp(seat.pos, Math.min(1, dt * 4));
          loader.heading = turnTo(loader.heading, seat.heading, dt * 5);
          sit(loader.target);
          if (loader.pos.distanceTo(seat.pos) < 0.05) this.secured(g, a);
        }
        break;
      }
      case 'seated': {
        const seat = L.seats[a.seats[0]];
        if (seat) {
          loader.pos.copy(seat.pos);
          loader.heading = seat.heading;
        }
        sit(loader.target);
        loader.target.headYaw = Math.sin(this.time * 0.3 + loader.phase) * 0.5;
        break;
      }
      case 'standUp': {
        a.timer += dt;
        Object.assign(loader.target, standJoints());
        loader.sitting = false;
        if (a.timer > 0.6) {
          a.state = 'unstrap';
          a.step = 3;
          a.timer = 0;
        }
        break;
      }
      case 'unstrap': {
        const target = this.corner(a, L, a.step);
        if (loader.pos.distanceTo(target) > 0.08) {
          this.walkPerson(loader, target, dt, 1.4, 'cabin');
          a.timer = 0;
        } else {
          a.timer += dt;
          strap(loader.target, a.timer);
          a.strapP[a.step] = Math.max(0, 1 - a.timer / 0.8);
          if (a.timer > 0.9) {
            a.step--;
            a.timer = 0;
            if (a.step < 0) a.state = 'getJack';
          }
        }
        this.setStraps(a);
        break;
      }
      case 'getJack': {
        // Fetch the jack and bring it round behind the pallet, forks toward it.
        const c = L.pallets[a.spot];
        const grab = a.jackPos.clone().add(new THREE.Vector3(0, 0, 1.3));
        if (a.step < 1) {
          if (this.walkPerson(loader, grab, dt, 1.6, 'cabin')) a.step = 1;
        } else {
          const behind = new THREE.Vector3(0, L.floor, c.z + 1.7 + 1.35);
          const arrived = this.walkPerson(loader, behind, dt, 1.0, 'cabin');
          push(loader.target, loader.phase, arrived ? 0 : 1);
          a.jackPos.copy(loader.pos).addScaledVector(fwd(loader.heading, _w), 1.3);
          a.jackHeading = loader.heading;
          if (arrived) {
            a.state = 'insert';
            a.timer = 0;
          }
        }
        break;
      }
      case 'insert': {
        // Slide the forks in, pump the pallet up, then turn to tow it out.
        a.timer += dt;
        const c = L.pallets[a.spot];
        const k = Math.min(1, a.timer / 1.4);
        a.jackPos.set(0, L.floor, c.z + 1.7 * (1 - k));
        a.jackHeading = 0;
        loader.pos.set(0, L.floor, c.z + 1.35 + 1.7 * (1 - k));
        loader.heading = 0;
        loader.phase += dt * 2.5;
        push(loader.target, loader.phase, k < 1 ? 1 : 0);
        if (a.timer > 1.4) a.propPos.y = L.floor + Math.min(0.1, (a.timer - 1.4) * 0.2);
        if (a.timer > 2.0) {
          this.release(a, frame);
          // Tow it aft: the anchor is the pallet, the loader walks ahead of it.
          a.pos.set(c.x, L.floor, c.z);
          a.heading = Math.PI;
          a.path = [L.hinge.clone(), this.rampLocal(ctx, frame)];
          a.state = 'exitCabin';
        }
        break;
      }
      case 'exitCabin': {
        this.palletFormation(a, dt, 1.0, true, true);
        if (this.follow(a, dt, 1.0)) {
          this.toWorld(a, frame);
          this.offloaded(g, a);
          const stage = this.stagePoint(ctx, frame);
          a.path = [stage, ...this.around(stage, a.rally, frame, L)];
          a.state = 'toRally';
        }
        break;
      }
      case 'toRally': {
        this.palletFormation(a, dt, 1.3, true, true);
        if (this.follow(a, dt, 1.3)) {
          a.state = 'arrived';
          a.timer = 0;
        }
        break;
      }
      case 'arrived': {
        a.timer += dt;
        this.palletFormation(a, dt, 0, false, true);
        a.propPos.y = a.pos.y + 0.1 * Math.max(0, 1 - a.timer);
        loader.target.armR = 0.2;
        if (a.timer > 12) loader.inst.visible = false;
        break;
      }
    }
  }

  // ---------------------------------------------------------------- crew

  private updateCrew(dt: number, crew: CrewContext, out: SoldierInstance[]) {
    if (!crew.visible) return;
    const F = crew.chiefSeat.y;
    // Crew chief: on the ramp marshalling when it's open, on his jump seat otherwise.
    const wantStand = crew.rampT > 0.6 ? 1 : 0;
    this.chiefSeated += ((1 - wantStand) - this.chiefSeated) * Math.min(1, dt * 1.5);
    const standAt = new THREE.Vector3(crew.hinge.x + 0.9, F, crew.hinge.z - 0.6);
    const c = this.chief;
    c.pos.lerpVectors(standAt, crew.chiefSeat, this.chiefSeated);
    if (this.chiefSeated > 0.6) {
      c.heading = turnTo(c.heading, Math.PI / 2, dt * 4);
      sit(c.target);
      c.target.headYaw = Math.sin(this.time * 0.25) * 0.6;
    } else {
      c.heading = turnTo(c.heading, Math.PI, dt * 4);
      if (crew.marshalling) wave(c.target, this.time);
      else {
        Object.assign(c.target, standJoints());
        c.target.headYaw = Math.sin(this.time * 0.5) * 0.5;
      }
    }
    if (Math.abs(this.chiefSeated - 0.5) < 0.45) {
      c.phase += dt * 4;
      gait(c.target, c.phase, 1.2);
    }
    const crewList = [c];
    crew.gunners.forEach((st, i) => {
      const g = this.gunners[i];
      if (!g) return;
      g.pos.copy(st.pos);
      g.heading = st.heading;
      gunner(g.target, this.time + i * 3.7);
      crewList.push(g);
    });
    crew.pilots.forEach((st, i) => {
      const pl = this.pilots[i];
      if (!pl || (i === 0 && crew.hidePilot)) return;
      pl.pos.copy(st.pos);
      pl.heading = st.heading;
      fly(pl.target, this.time + i * 5.1);
      crewList.push(pl);
    });
    for (const p of crewList) {
      blendJoints(p.joints, p.target, dt);
      rootMatrix(_m, p.pos, p.heading);
      p.inst.matrix.multiplyMatrices(crew.frame.matrixWorld, _m);
      out.push(p.inst);
    }
  }

  // ---------------------------------------------------------------- placement

  /** Write world matrices for everyone and everything in an actor. */
  private place(g: CargoGroup, a: Actor, ctx: LoadContext, dt: number, out: SoldierInstance[]) {
    const frame = this.frameOf(g, ctx);
    const space = a.space === 'cabin' ? frame.matrixWorld : null;
    const world = (m: THREE.Matrix4) => (space ? m.premultiply(space) : m);
    for (const p of a.people) {
      blendJoints(p.joints, p.target, dt);
      rootMatrix(p.inst.matrix, p.pos, p.heading);
      world(p.inst.matrix);
      out.push(p.inst);
    }
    if (a.prop) world(rootMatrix(a.prop.matrix, a.propPos, a.propHeading));
    if (a.jack) world(rootMatrix(a.jack.matrix, a.jackPos, a.jackHeading));
    if (a.stanchions) {
      const spot = (g.layout ?? ctx.layout).litters[a.spot];
      if (spot) world(rootMatrix(a.stanchions.matrix, spot, 0));
      else a.stanchions.visible = false;
    }
    // The patient lies on the litter's canvas.
    if (a.kind === 'casualty') {
      const pt = a.people[2];
      rootMatrix(_m, _v.copy(a.propPos).add(new THREE.Vector3(0, 0.02, 0)), a.propHeading + Math.PI);
      pt.inst.matrix.copy(_m);
      world(pt.inst.matrix);
    }
  }
}
