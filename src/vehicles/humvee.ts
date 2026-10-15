import * as THREE from 'three';
import { clamp, smoothstep } from '../util/math';
import { mergeStatic } from '../util/mergeStatic';
import type { CabinLayout } from '../game/cargo';
import type { PlayerTarget } from '../game/target';

const G = 9.81;

export interface GroundEnv {
  /** Solid surface height: terrain, graded roads and bridge decks. */
  /** `below`: ignore surfaces above this height (overpasses). */
  surfaceAt(x: number, z: number, below?: number): number;
  normalAt(x: number, z: number, out: THREE.Vector3, below?: number): THREE.Vector3;
  /** Water depth above the surface at (x, z) (0 if dry). */
  waterDepth(x: number, z: number, below?: number): number;
  /** Tire grip multiplier (roads grip better than grass). */
  grip(x: number, z: number, below?: number): number;
  /** Is a point inside a structure or tree? */
  blocked(p: THREE.Vector3): boolean;
}

export interface DriveInput {
  throttle: number;
  brake: number;
  steer: number;
  handbrake: boolean;
}

/** Wheel mounts in the body frame (forward = −Z). */
const WHEELS = [
  { x: -0.98, z: -1.62, front: true },
  { x: 0.98, z: -1.62, front: true },
  { x: -0.98, z: 1.55, front: false },
  { x: 0.98, z: 1.55, front: false },
];
const MOUNT_Y = -0.25;

/** The open cargo bed (body frame): troop benches, a two-tier litter rack, one pallet. */
export const BED: CabinLayout = (() => {
  const F = 0.4;
  const seats: CabinLayout['seats'] = [];
  for (const z of [0.85, 1.75])
    for (const sx of [-1, 1]) seats.push({ pos: new THREE.Vector3(sx * 0.78, F, z), heading: (sx * Math.PI) / 2 });
  return {
    floor: F,
    hinge: new THREE.Vector3(0, F, 2.3),
    seats,
    litters: [new THREE.Vector3(0, F + 0.62, 1.5), new THREE.Vector3(0, F + 1.2, 1.5)],
    pallets: [new THREE.Vector3(0, F, 1.38)],
    hull: { halfWidth: 1.3, front: -2.7, back: 2.9 },
  };
})();
const REST = 0.5;
const RADIUS = 0.45;
const BUMPERS = [
  new THREE.Vector3(0, 0.1, -2.55),
  new THREE.Vector3(-1.1, 0.1, -2.3),
  new THREE.Vector3(1.1, 0.1, -2.3),
  new THREE.Vector3(0, 0.1, 2.45),
  new THREE.Vector3(-1.1, 0.4, 0),
  new THREE.Vector3(1.1, 0.4, 0),
];

const PROBES = [[1, 0], [-1, 0], [0, 1], [0, -1], [0.7, 0.7], [-0.7, 0.7], [0.7, -0.7], [-0.7, -0.7]];
const _v = new THREE.Vector3();
const _n = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _qi = new THREE.Quaternion();

function buildModel() {
  const olive = new THREE.MeshStandardMaterial({ color: 0x5f6343, roughness: 0.85 });
  const canvas = new THREE.MeshStandardMaterial({ color: 0x8a7d5a, roughness: 0.95 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x22241f, roughness: 0.8 });
  const glass = new THREE.MeshStandardMaterial({ color: 0x2a3a44, roughness: 0.1, metalness: 0.4, transparent: true, opacity: 0.45, depthWrite: false });
  const tire = new THREE.MeshStandardMaterial({ color: 0x151515, roughness: 0.95 });
  const group = new THREE.Group();
  const body = new THREE.Group();
  group.add(body);
  // Parts that would block the view from the driver's seat.
  const exterior: THREE.Mesh[] = [];
  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, parent: THREE.Object3D = body) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    m.receiveShadow = true;
    parent.add(m);
    return m;
  };
  add(new THREE.BoxGeometry(2.25, 0.8, 4.7), olive, 0, 0, 0);
  add(new THREE.BoxGeometry(2.1, 0.3, 1.6), olive, 0, 0.5, -1.45);
  // Two-door cab; the open cargo bed behind it carries the load in plain view.
  exterior.push(add(new THREE.BoxGeometry(2.05, 0.85, 1.4), olive, 0, 0.82, -0.3));
  exterior.push(add(new THREE.BoxGeometry(1.85, 0.5, 0.06), glass, 0, 0.9, -1.02));
  exterior.push(add(new THREE.BoxGeometry(1.6, 0.4, 0.06), glass, 0, 0.95, 0.42));
  for (const sx of [-1, 1]) {
    exterior.push(add(new THREE.BoxGeometry(0.06, 0.45, 0.8), glass, sx * 1.03, 0.92, -0.45));
    // Wheel arches / fenders.
    add(new THREE.BoxGeometry(0.4, 0.2, 1.2), olive, sx * 1.1, 0.25, -1.62);
    add(new THREE.BoxGeometry(0.4, 0.2, 1.2), olive, sx * 1.1, 0.25, 1.55);
  }
  // Cargo bed: low side walls, troop benches over the wheel wells, rails and tie-downs.
  const F = BED.floor;
  add(new THREE.BoxGeometry(2.0, 0.03, 1.95), dark, 0, F + 0.015, 1.38);
  for (const sx of [-1, 1]) {
    add(new THREE.BoxGeometry(0.08, 0.45, 1.98), olive, sx * 1.06, F + 0.22, 1.37);
    add(new THREE.BoxGeometry(0.34, 0.05, 1.8), canvas, sx * 0.84, F + 0.42, 1.38);
    add(new THREE.BoxGeometry(0.3, 0.38, 1.8), olive, sx * 0.86, F + 0.2, 1.38);
    add(new THREE.CylinderGeometry(0.025, 0.025, 1.9, 6).rotateX(Math.PI / 2), dark, sx * 1.06, F + 0.85, 1.38);
    for (const z of [0.5, 1.38, 2.26]) add(new THREE.CylinderGeometry(0.022, 0.022, 0.4, 5), dark, sx * 1.06, F + 0.65, z);
    for (const z of [0.7, 1.4, 2.1]) add(new THREE.TorusGeometry(0.05, 0.01, 4, 8).rotateX(Math.PI / 2), dark, sx * 0.62, F + 0.02, z);
  }
  exterior.push(add(new THREE.CylinderGeometry(0.55, 0.6, 0.28, 12), dark, 0, 1.38, 0.15));
  exterior.push(add(new THREE.BoxGeometry(0.9, 0.5, 0.06), dark, 0, 1.6, -0.25));
  exterior.push(add(new THREE.CylinderGeometry(0.05, 0.05, 1.1, 5).rotateX(Math.PI / 2), dark, 0, 1.6, -0.75));
  add(new THREE.CylinderGeometry(0.02, 0.03, 2.4, 4), dark, 0.9, 1.9, 1.9);
  add(new THREE.BoxGeometry(1.9, 0.35, 0.15), dark, 0, -0.05, -2.4);
  for (const sx of [-1, 1]) add(new THREE.BoxGeometry(0.25, 0.15, 0.05), new THREE.MeshBasicMaterial({ color: 0xfff6d0 }), sx * 0.75, 0.3, -2.38);
  // Interior, shown from the driver's seat.
  const interior = new THREE.Group();
  interior.visible = false;
  body.add(interior);
  const trim = new THREE.MeshStandardMaterial({ color: 0x3b3d34, roughness: 0.9 });
  const panel = new THREE.MeshStandardMaterial({ color: 0x2a2b27, roughness: 0.85 });
  const inside = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    interior.add(m);
    return m;
  };
  inside(new THREE.BoxGeometry(1.95, 0.24, 0.4), panel, 0, 0.6, -0.82); // dashboard
  inside(new THREE.BoxGeometry(0.32, 0.07, 0.03), new THREE.MeshBasicMaterial({ color: 0x1e2419 }), -0.5, 0.69, -0.62); // gauges
  inside(new THREE.TorusGeometry(0.18, 0.022, 6, 20), panel, -0.5, 0.62, -0.56).rotation.x = -0.9; // steering wheel
  inside(new THREE.CylinderGeometry(0.03, 0.03, 0.3, 6).rotateX(Math.PI / 2 - 0.9), panel, -0.5, 0.56, -0.66);
  for (const sx of [-1, 1]) {
    inside(new THREE.BoxGeometry(0.08, 0.7, 0.08), trim, sx * 0.97, 0.98, -1.0).rotation.x = -0.12; // A-pillars
    inside(new THREE.BoxGeometry(0.1, 0.7, 0.12), trim, sx * 0.97, 0.98, 0.12); // B-pillars
    inside(new THREE.BoxGeometry(0.06, 0.4, 1.35), trim, sx * 1.0, 0.48, -0.3); // door panels
  }
  inside(new THREE.BoxGeometry(2.0, 0.06, 0.12), trim, 0, 1.33, -1.0); // windscreen header
  inside(new THREE.BoxGeometry(2.0, 0.04, 1.4), trim, 0, 1.37, -0.3); // roof lining
  // Back wall with a window onto the bed.
  inside(new THREE.BoxGeometry(2.0, 0.38, 0.05), trim, 0, 0.57, 0.38);
  inside(new THREE.BoxGeometry(2.0, 0.1, 0.05), trim, 0, 1.3, 0.38);
  for (const sx of [-1, 1]) inside(new THREE.BoxGeometry(0.2, 0.5, 0.05), trim, sx * 0.9, 1.0, 0.38);
  inside(new THREE.BoxGeometry(0.25, 0.3, 1.2), panel, 0, 0.55, -0.1); // centre console
  // Rear door, hinged at the bottom.
  const door = new THREE.Group();
  door.position.set(0, -0.05, 2.36);
  body.add(door);
  add(new THREE.BoxGeometry(1.7, 0.95, 0.08), olive, 0, 0.47, 0, door);
  // Wheels.
  const wheelGeo = new THREE.CylinderGeometry(RADIUS, RADIUS, 0.38, 14).rotateZ(Math.PI / 2);
  const hubGeo = new THREE.CylinderGeometry(0.2, 0.2, 0.4, 8).rotateZ(Math.PI / 2);
  const wheels: { pivot: THREE.Group; spin: THREE.Group }[] = [];
  for (const w of WHEELS) {
    const pivot = new THREE.Group();
    pivot.position.set(w.x, MOUNT_Y - REST, w.z);
    body.add(pivot);
    const spin = new THREE.Group();
    pivot.add(spin);
    add(wheelGeo, tire, 0, 0, 0, spin);
    add(hubGeo, olive, 0, 0, 0, spin);
    wheels.push({ pivot, spin });
  }
  // Exterior shell (hidden from the driver's seat) and the rest of the static body → a few merged meshes.
  const shell = new THREE.Group();
  body.add(shell);
  for (const m of exterior) shell.add(m);
  mergeStatic(shell, new Set());
  mergeStatic(interior, new Set());
  mergeStatic(body, new Set<THREE.Object3D>([shell, interior, door, ...wheels.map((w) => w.pivot)]));
  mergeStatic(door, new Set());
  return { group, door, wheels, shell, interior };
}

/** A drivable HMMWV with raycast-style suspension and a simple tire model. */
export class Humvee implements PlayerTarget {
  readonly kind = 'ground' as const;
  group: THREE.Group;
  private door: THREE.Group;
  private wheelMeshes: { pivot: THREE.Group; spin: THREE.Group }[];
  pos = new THREE.Vector3();
  vel = new THREE.Vector3();
  quat = new THREE.Quaternion();
  angVel = new THREE.Vector3();
  emptyMass = 2700;
  payload = 0;
  hp = 100;
  /** Knocked out by enemy fire or a crash: burning, undrivable until recovered. */
  destroyed = false;
  readonly hitHalfLength = 2.3;
  readonly hitRadius = 1.3;
  readonly agl = 0.5;
  onDamage: ((amount: number, source: string) => void) | null = null;
  onDestroyed: ((source: string) => void) | null = null;

  damage(amount: number, source: string) {
    if (this.destroyed || amount <= 0) return;
    this.hp = Math.max(0, this.hp - amount);
    this.onDamage?.(amount, source);
    if (this.hp <= 0) {
      this.destroyed = true;
      this.input.throttle = 0;
      this.input.handbrake = true;
      this.onDestroyed?.(source);
    }
  }

  /** Fresh vehicle (after recovery to the motor pool). */
  repair() {
    this.hp = 100;
    this.destroyed = false;
    this.group.traverse((o) => {
      const mat = (o as THREE.Mesh).isMesh ? ((o as THREE.Mesh).material as THREE.MeshStandardMaterial) : null;
      if (mat?.userData.baseColor !== undefined) mat.color.setHex(mat.userData.baseColor);
    });
  }

  /** Scorch the paint when knocked out. */
  scorch() {
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      const mat = m.isMesh ? (m.material as THREE.MeshStandardMaterial) : null;
      if (!mat?.color || mat.transparent) return;
      // Materials are shared between parts: remember the paint once, on the material.
      if (mat.userData.baseColor === undefined) mat.userData.baseColor = mat.color.getHex();
      mat.color.setHex(0x1c1b18);
    });
  }
  input: DriveInput = { throttle: 0, brake: 0, steer: 0, handbrake: true };
  steerAngle = 0;
  doorsOpen = false;
  doorT = 0;
  contacts = 0;
  speed = 0;
  loadFactor = 1;
  pitch = 0;
  roll = 0;
  heading = 0;
  waterDepth = 0;
  stalled = false;
  engineLoad = 0;
  private comp = [0, 0, 0, 0];
  private spin = [0, 0, 0, 0];
  private prevVel = new THREE.Vector3();
  private settled = false;
  onImpact: ((speed: number) => void) | null = null;
  /** One damage event per bump, not one per physics step while scraping. */
  private impactCool = 0;
  private impact(sp: number) {
    if (this.impactCool > 0) return;
    this.impactCool = 0.5;
    this.onImpact?.(sp);
  }

  constructor() {
    const m = buildModel();
    this.group = m.group;
    this.door = m.door;
    this.wheelMeshes = m.wheels;
    this.shell = m.shell;
    this.interior = m.interior;
  }

  private shell: THREE.Group;
  private interior: THREE.Group;
  /** Driver's-seat view: hide the cab shell, show the dashboard and frame. */
  setInteriorView(on: boolean) {
    if (this.interior.visible === on) return;
    this.interior.visible = on;
    this.shell.visible = !on;
  }

  get mass() {
    return this.emptyMass + this.payload;
  }
  get groundSpeed() {
    return Math.hypot(this.vel.x, this.vel.z);
  }
  get onGround() {
    return this.contacts >= 3;
  }
  get loadable() {
    return this.contacts >= 3 && this.groundSpeed < 0.6;
  }
  get rampDown() {
    return this.doorT > 0.95;
  }

  place(at: THREE.Vector3, heading: number, env: GroundEnv) {
    this.pos.set(at.x, env.surfaceAt(at.x, at.z) - MOUNT_Y + REST + RADIUS - 0.1, at.z);
    this.vel.set(0, 0, 0);
    this.angVel.set(0, 0, 0);
    this.quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), -heading);
    this.stalled = false;
    this.settled = false;
    this.sync();
  }

  worldPoint(local: THREE.Vector3, out: THREE.Vector3) {
    return out.copy(local).applyQuaternion(this.quat).add(this.pos);
  }
  rampEndWorld(out: THREE.Vector3) {
    return this.worldPoint(_v.set(0, -0.7, 3.4), out);
  }
  cabinWorld(out: THREE.Vector3) {
    return this.worldPoint(_v.set(0, 0.6, 1.4), out);
  }
  get cabinFrame(): THREE.Object3D {
    return this.group;
  }
  get cabinLayout(): CabinLayout {
    return BED;
  }

  step(dt: number, env: GroundEnv) {
    this.impactCool = Math.max(0, this.impactCool - dt);
    const m = this.mass;
    const q = this.quat;
    _qi.copy(q).invert();
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
    this.pitch = Math.asin(clamp(fwd.y, -1, 1));
    this.roll = Math.atan2(-right.y, up.y);
    this.heading = Math.atan2(fwd.x, -fwd.z);
    this.speed = this.vel.dot(fwd);
    const inp = this.input;
    const absSpeed = Math.abs(this.speed);

    // Water: slows you down; deep water floods the engine.
    this.waterDepth = env.waterDepth(this.pos.x, this.pos.z, this.pos.y + 0.3);
    if (this.waterDepth > 1.3) this.stalled = true;

    // Steering: lots of lock at parking speed, little at highway speed.
    const maxSteer = 0.62 - 0.48 * smoothstep(3, 28, absSpeed);
    const want = clamp(inp.steer, -1, 1) * maxSteer;
    this.steerAngle += clamp(want - this.steerAngle, -2.2 * dt, 2.2 * dt);

    const scale = m / 2700;
    const I = _v.set(3300 * scale, 3900 * scale, 1700 * scale);
    const Ix = I.x;
    const Iy = I.y;
    const Iz = I.z;
    const F = new THREE.Vector3(0, -m * G, 0);
    const T = new THREE.Vector3();
    const omegaW = this.angVel.clone().applyQuaternion(q);
    const k = (m * G) / 4 / 0.16;
    const c = 2 * 0.55 * Math.sqrt((k * m) / 4);
    const mw = m / 4;
    const throttle = this.stalled ? 0 : clamp(inp.throttle, -1, 1);
    const top = throttle >= 0 ? 31 : 9;
    const driveForce = 15000 * throttle * Math.max(0, 1 - absSpeed / top);
    this.engineLoad = Math.abs(throttle);
    let contacts = 0;
    let impact = 0;

    WHEELS.forEach((w, wi) => {
      const rL = new THREE.Vector3(w.x, MOUNT_Y, w.z);
      const r = rL.applyQuaternion(q);
      const mx = this.pos.x + r.x;
      const my = this.pos.y + r.y;
      const mz = this.pos.z + r.z;
      const ground = env.surfaceAt(mx, mz, my + 0.3);
      const length = my - ground - RADIUS;
      let comp = REST - length;
      if (comp <= 0) {
        this.comp[wi] = 0;
        this.spin[wi] += throttle * 20 * dt;
        return;
      }
      contacts++;
      env.normalAt(mx, mz, _n, my + 0.3);
      const vp = new THREE.Vector3().crossVectors(omegaW, r).add(this.vel);
      const vn = vp.dot(_n);
      if (vn < -4) impact = Math.max(impact, -vn);
      comp = Math.min(comp, REST + 0.15);
      let Fs = Math.max(0, k * comp - c * vn);
      if (comp > REST) Fs += k * 6 * (comp - REST);
      this.comp[wi] = comp;
      // Tire frame on the ground plane.
      const steer = w.front ? this.steerAngle : 0;
      const fw = fwd.clone().multiplyScalar(Math.cos(steer)).addScaledVector(right, Math.sin(steer));
      fw.addScaledVector(_n, -fw.dot(_n)).normalize();
      const sd = new THREE.Vector3().crossVectors(fw, _n).normalize();
      const vLong = vp.dot(fw);
      const vLat = vp.dot(sd);
      const grip = env.grip(mx, mz, my + 0.3) * (this.waterDepth > 0.3 ? 0.6 : 1);
      // Handbrake: locks the rear wheels at speed (slides), holds all four when slow (parking).
      const parking = inp.handbrake && absSpeed < 3;
      const rearLocked = inp.handbrake && !w.front && !parking;
      // Rolling resistance, plus engine braking when off the throttle.
      let fLong = driveForce / 4 - vLong * (Math.abs(throttle) < 0.05 ? 160 : 12);
      const brakeForce = parking ? 30000 : rearLocked ? 12000 : 24000 * inp.brake;
      if (brakeForce > 0) fLong -= Math.sign(vLong) * Math.min(Math.abs(vLong) * (mw / dt) * 0.5, brakeForce / 4);
      let fLat = -vLat * (mw / dt) * 0.32;
      const mu = grip * (rearLocked ? 0.45 : 1.0);
      const lim = mu * Fs;
      const tot = Math.hypot(fLong, fLat);
      if (tot > lim && tot > 0) {
        fLong *= lim / tot;
        fLat *= lim / tot;
      }
      const fSus = _n.clone().multiplyScalar(Fs);
      const fTire = fw.clone().multiplyScalar(fLong).addScaledVector(sd, fLat);
      F.add(fSus).add(fTire);
      T.add(new THREE.Vector3().crossVectors(r, fSus));
      // Tire forces act through a lowered point: keeps it from tipping on every corner.
      const rT = r.clone().addScaledVector(up, -r.dot(up) * 0.65);
      T.add(new THREE.Vector3().crossVectors(rT, fTire));
      this.spin[wi] += (vLong / RADIUS) * dt;
    });
    this.contacts = contacts;
    if (impact > 6) this.impact(impact);

    // Air and water drag.
    const sp = this.vel.length();
    F.addScaledVector(this.vel, -0.9 * sp);
    if (this.waterDepth > 0.2) F.addScaledVector(this.vel, -m * 0.9 * Math.min(1.2, this.waterDepth));

    // Parked: stop creeping.
    const still = contacts >= 3 && Math.abs(throttle) < 0.01 && sp < 0.15 && this.angVel.lengthSq() < 0.002;
    if (still && (inp.handbrake || inp.brake > 0 || sp < 0.05)) this.settled = true;
    if (!still) this.settled = false;

    this.prevVel.copy(this.vel);
    const prevPos = this.pos.clone();
    if (this.settled) {
      this.vel.set(0, 0, 0);
      this.angVel.set(0, 0, 0);
    } else {
      this.vel.addScaledVector(F, dt / m);
      this.pos.addScaledVector(this.vel, dt);
      const tb = T.applyQuaternion(_qi);
      const w = this.angVel;
      w.x += (tb.x / Ix) * dt;
      w.y += (tb.y / Iy) * dt;
      w.z += (tb.z / Iz) * dt;
      w.multiplyScalar(Math.exp(-0.6 * dt));
      const wl = w.length();
      if (wl > 1e-7) {
        _q.setFromAxisAngle(_v.copy(w).divideScalar(wl), wl * dt);
        q.multiply(_q).normalize();
      }
    }

    // Bump into buildings, walls and trees.
    for (const b of BUMPERS) {
      const p = this.worldPoint(b, new THREE.Vector3());
      if (env.blocked(p)) {
        // Find which way is free to get a contact normal, so a glancing
        // scrape slides along the wall and only a head-on hit stops you.
        const n = new THREE.Vector3();
        const probe = new THREE.Vector3();
        for (const [dx, dz] of PROBES) if (!env.blocked(probe.set(p.x + dx * 0.8, p.y, p.z + dz * 0.8))) n.x += dx, n.z += dz;
        if (n.lengthSq() < 0.01) n.set(-this.vel.x, 0, -this.vel.z);
        n.normalize();
        const vn = this.vel.dot(n);
        const hitSpeed = Math.max(0, -vn);
        // Undo the horizontal move only, so a bumper on a wall can't hang the truck in the air.
        this.pos.x = prevPos.x;
        this.pos.z = prevPos.z;
        if (vn < 0) this.vel.addScaledVector(n, -vn * 1.25);
        this.vel.multiplyScalar(0.92);
        this.angVel.multiplyScalar(0.7);
        if (hitSpeed > 5) this.impact(hitSpeed);
        break;
      }
    }

    const acc = _v.copy(this.vel).sub(this.prevVel).divideScalar(dt);
    acc.y += G;
    this.loadFactor = acc.dot(up) / G;
  }

  /** Visuals: wheels, suspension travel, steering, door. */
  update(dt: number) {
    this.doorT = clamp(this.doorT + (this.doorsOpen ? dt : -dt) / 1.4, 0, 1);
    this.door.rotation.x = smoothstep(0, 1, this.doorT) * 1.45;
    WHEELS.forEach((w, i) => {
      const wm = this.wheelMeshes[i];
      wm.pivot.position.y = MOUNT_Y - (REST - this.comp[i]);
      wm.pivot.rotation.y = w.front ? -this.steerAngle : 0;
      wm.spin.rotation.x = -this.spin[i];
    });
    this.sync();
  }

  sync() {
    this.group.position.copy(this.pos);
    this.group.quaternion.copy(this.quat);
  }

  /** Upside down or on its side for a while → offer recovery. */
  get flipped() {
    return new THREE.Vector3(0, 1, 0).applyQuaternion(this.quat).y < 0.3;
  }
}
