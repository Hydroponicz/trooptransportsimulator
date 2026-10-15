import * as THREE from 'three';
import type { World } from '../world/worldgen';
import type { RNG } from '../util/noise';
import type { Effects } from '../fx/effects';
import { ROAD_SPEC } from '../world/roads';
import { buildVehicle, type VehicleKind, type VehicleModel } from '../vehicles/models';

/** One direction of travel along a road, offset into its right-hand lane. */
interface Lane {
  pts: THREE.Vector2[];
  /** Cumulative distance at each point. */
  cum: number[];
  pi: number;
  dir: 1 | -1;
  from: string;
  to: string;
  cruise: number;
  track: boolean;
}

interface Car {
  id: number;
  m: VehicleModel;
  pos: THREE.Vector2;
  y: number;
  /** Heading: forward = (sin h, cos h). */
  h: number;
  v: number;
  steer: number;
  lane: Lane;
  seg: number;
  queue: Lane[];
  pause: number;
  cruiseMul: number;
  pitch: number;
  roll: number;
  yawRate: number;
  accel: number;
  waitT: number;
  honkT: number;
  blockedBy: Car | null;
  leader: Car | null;
  choices: Map<string, Lane>;
  dustT: number;
  /** Backing up out of a stand-off. */
  reverseT: number;
  stuckT: number;
}

export interface TrafficObstacles {
  /** Player Humvee position (if any). */
  humvee?: THREE.Vector3;
  /** Helicopter position when it is on or near the ground. */
  heli?: THREE.Vector3;
}

function segDist(p: THREE.Vector2, a: THREE.Vector2, b: THREE.Vector2): number {
  const dx = b.x - a.x;
  const dz = b.y - a.y;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dz) / (dx * dx + dz * dz || 1)));
  return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dz * t));
}

const key = (p: THREE.Vector2) => `${Math.round(p.x * 2)},${Math.round(p.y * 2)}`;
const _v3 = new THREE.Vector3();

/**
 * Supply traffic driving the whole road network: smooth steering along the
 * right-hand lane, slowing for bends, following each other in convoys, and
 * braking for the player, the helicopter and anything else in the way.
 */
export class Traffic {
  group = new THREE.Group();
  private cars: Car[] = [];
  private lanesFrom = new Map<string, Lane[]>();
  /** Horn callback (position of the honking vehicle). */
  onHonk: ((at: THREE.Vector3) => void) | null = null;

  constructor(
    private world: World,
    private rng: RNG,
    private effects: Effects,
  ) {
    const roads = world.roads;
    const lanes: Lane[] = [];
    roads.paths.forEach((path, pi) => {
      if (path.length < 2) return;
      const cls = roads.classes[pi];
      const off = ROAD_SPEC[cls].hw * 0.5;
      const cruise = cls === 'main' ? 15 : cls === 'secondary' ? 11.5 : 8.5;
      for (const dir of [1, -1] as const) {
        const src = dir === 1 ? path : [...path].reverse();
        const n = src.length;
        const pts: THREE.Vector2[] = [];
        for (let i = 0; i < n; i++) {
          const a = src[Math.max(0, i - 1)];
          const b = src[Math.min(n - 1, i + 1)];
          const tx = b.x - a.x;
          const tz = b.y - a.y;
          const tl = Math.hypot(tx, tz) || 1;
          // Right-hand side of the direction of travel (right = (−tz, tx)).
          pts.push(new THREE.Vector2(src[i].x - (tz / tl) * off, src[i].y + (tx / tl) * off));
        }
        const cum = [0];
        for (let i = 1; i < n; i++) cum.push(cum[i - 1] + pts[i].distanceTo(pts[i - 1]));
        const lane: Lane = { pts, cum, pi, dir, from: key(src[0]), to: key(src[n - 1]), cruise, track: cls === 'track' };
        lanes.push(lane);
        if (!this.lanesFrom.has(lane.from)) this.lanesFrom.set(lane.from, []);
        this.lanesFrom.get(lane.from)!.push(lane);
      }
    });

    // Convoys of 1–3 spread over the network.
    const total = lanes.reduce((s, l) => s + l.cum[l.cum.length - 1], 0) / 2;
    const groups = Math.max(6, Math.min(34, Math.round(total / 1500)));
    const long = lanes.filter((l) => l.pts.length > 30);
    let id = 0;
    for (let g = 0; g < groups && long.length; g++) {
      const lane = rng.pick(long);
      const size = rng.chance(0.45) ? 1 : rng.int(2, 3);
      const kinds: VehicleKind[] = size === 1 ? [rng.pick(['cargo', 'hmmwv', 'tanker', 'mrap'] as VehicleKind[])] : ['mrap', ...Array.from({ length: size - 1 }, () => rng.pick(['cargo', 'cargo', 'tanker'] as VehicleKind[]))];
      if (size > 1 && rng.chance(0.4)) kinds[0] = 'hmmwv';
      const start = rng.int(10 + size * 4, lane.pts.length - 12);
      let leader: Car | null = null;
      kinds.forEach((kind, k) => {
        const seg = Math.max(1, start - k * 4);
        const car = this.spawn(id++, kind, lane, seg, leader);
        leader ??= car;
      });
    }
  }

  private spawn(id: number, kind: VehicleKind, lane: Lane, seg: number, leader: Car | null): Car {
    const m = buildVehicle(kind);
    this.group.add(m.group);
    const a = lane.pts[seg];
    const b = lane.pts[seg + 1];
    const car: Car = {
      id,
      m,
      pos: a.clone(),
      y: 0,
      h: Math.atan2(b.x - a.x, b.y - a.y),
      v: 0,
      steer: 0,
      lane,
      seg,
      queue: [],
      pause: this.rng.range(0, 4),
      cruiseMul: this.rng.range(0.9, 1.05),
      pitch: 0,
      roll: 0,
      yawRate: 0,
      accel: 0,
      waitT: 0,
      honkT: 0,
      blockedBy: null,
      leader,
      choices: new Map(),
      dustT: this.rng.range(0, 0.2),
      reverseT: 0,
      stuckT: 0,
    };
    car.y = this.surface(car.pos.x, car.pos.y, Infinity);
    this.cars.push(car);
    return car;
  }

  private surface(x: number, z: number, near: number): number {
    const r = this.world.roads.surfaceAt(x, z, near + 1.5);
    const t = this.world.terrain.heightAt(x, z);
    return r > -1e9 && t < r + 2 ? r - 0.1 : Math.max(t, r);
  }

  /** Pick the next lane at the end of `after` (convoys follow their leader's choices). */
  private nextLane(car: Car, after: Lane): Lane | null {
    let options = (this.lanesFrom.get(after.to) ?? []).filter((l) => !(l.pi === after.pi && l.dir === -after.dir));
    if (!options.length) return null;
    // Avoid hairpins (branches doubling back) when there's another way on.
    const n = after.pts.length;
    const inDir = after.pts[n - 1].clone().sub(after.pts[Math.max(0, n - 3)]).normalize();
    const turn = (l: Lane) => Math.acos(THREE.MathUtils.clamp(inDir.dot(l.pts[Math.min(2, l.pts.length - 1)].clone().sub(l.pts[0]).normalize()), -1, 1));
    const easy = options.filter((l) => turn(l) < 2.0);
    if (easy.length) options = easy;
    const led = car.leader?.choices.get(after.to);
    if (led && options.includes(led)) return led;
    const pick = this.rng.pick(options);
    car.choices.set(after.to, pick);
    if (car.choices.size > 24) car.choices.delete(car.choices.keys().next().value!);
    return pick;
  }

  /** A point `dist` metres ahead along the route (and the lane it lies on). */
  private ahead(car: Car, dist: number, out: THREE.Vector2): THREE.Vector2 {
    let lane = car.lane;
    let s = car.seg;
    // Start from the projection of the car onto its current segment.
    const a = lane.pts[s];
    const b = lane.pts[s + 1];
    const dx = b.x - a.x;
    const dz = b.y - a.y;
    const l2 = dx * dx + dz * dz || 1;
    const t = Math.max(0, Math.min(1, ((car.pos.x - a.x) * dx + (car.pos.y - a.y) * dz) / l2));
    let along = lane.cum[s] + t * Math.sqrt(l2) + dist;
    let q = 0;
    while (along > lane.cum[lane.cum.length - 1]) {
      const next = car.queue[q++];
      if (!next) return out.copy(lane.pts[lane.pts.length - 1]);
      along -= lane.cum[lane.cum.length - 1];
      lane = next;
      s = 0;
    }
    while (s < lane.pts.length - 2 && lane.cum[s + 1] < along) s++;
    const segLen = lane.cum[s + 1] - lane.cum[s] || 1;
    return out.copy(lane.pts[s]).lerp(lane.pts[s + 1], (along - lane.cum[s]) / segLen);
  }

  /** Is a point inside any AI vehicle? (Used for the player's collisions.) */
  hit(p: THREE.Vector3): boolean {
    for (const c of this.cars) {
      const dx = p.x - c.pos.x;
      const dz = p.z - c.pos.y;
      if (dx * dx + dz * dz > 30) continue;
      const fx = Math.sin(c.h);
      const fz = Math.cos(c.h);
      const lz = dx * fx + dz * fz;
      const lx = dx * fz - dz * fx;
      if (Math.abs(lz) < c.m.length / 2 && Math.abs(lx) < c.m.width / 2 && p.y > c.y && p.y < c.y + c.m.height) return true;
    }
    return false;
  }

  update(dt: number, camPos: THREE.Vector3, obs: TrafficObstacles = {}) {
    if (dt <= 0) return;
    const colliders = this.world.colliders;
    const tmp = new THREE.Vector2();
    const tmp2 = new THREE.Vector2();
    for (const car of this.cars) {
      const wb = car.m.wheelbase;
      // Keep a couple of lanes planned ahead.
      while (car.queue.length < 2) {
        const last = car.queue[car.queue.length - 1] ?? car.lane;
        const n = this.nextLane(car, last);
        if (!n) break;
        car.queue.push(n);
      }
      // Advance along the lane.
      for (;;) {
        const L = car.lane;
        const a = L.pts[car.seg];
        const b = L.pts[car.seg + 1];
        const dx = b.x - a.x;
        const dz = b.y - a.y;
        const t = ((car.pos.x - a.x) * dx + (car.pos.y - a.y) * dz) / (dx * dx + dz * dz || 1);
        if (t < 1) break;
        if (car.seg < L.pts.length - 2) car.seg++;
        else if (car.queue.length) {
          car.lane = car.queue.shift()!;
          car.seg = 0;
        } else break;
      }
      // Hand over to the next lane once it's closer than the end of this one
      // (turning around at a dead end, or cutting a junction corner).
      if (car.queue.length && car.seg >= car.lane.pts.length - 3) {
        const L = car.lane;
        const dHere = segDist(car.pos, L.pts[car.seg], L.pts[car.seg + 1]);
        const nx = car.queue[0];
        for (let s2 = 0; s2 < Math.min(4, nx.pts.length - 1); s2++) {
          if (segDist(car.pos, nx.pts[s2], nx.pts[s2 + 1]) < dHere - 0.5) {
            car.lane = car.queue.shift()!;
            car.seg = s2;
            break;
          }
        }
      }
      // Distance left to the end of the lane (for stopping at dead ends).
      const remaining = (() => {
        const L = car.lane;
        const a = L.pts[car.seg];
        const b = L.pts[car.seg + 1];
        const dx = b.x - a.x;
        const dz = b.y - a.y;
        const l2 = dx * dx + dz * dz || 1;
        const t = ((car.pos.x - a.x) * dx + (car.pos.y - a.y) * dz) / l2;
        return L.cum[L.cum.length - 1] - (L.cum[car.seg] + t * Math.sqrt(l2));
      })();
      const atEnd = !car.queue.length && remaining < 8;
      if (atEnd && car.pause <= 0 && car.v < 0.5) {
        // Dead end (a motor pool or the edge of town): wait, then turn around.
        car.pause = this.rng.range(10, 30) * (car.leader ? 0.4 : 1);
        const back = (this.lanesFrom.get(car.lane.to) ?? []).find((l) => l.pi === car.lane.pi && l.dir === -car.lane.dir);
        if (back) car.queue.push(back);
      }

      // Steering: pure pursuit on a lookahead point.
      const look = THREE.MathUtils.clamp(5 + car.v * 0.7, 6, 16);
      const target = this.ahead(car, look, tmp);
      const fx = Math.sin(car.h);
      const fz = Math.cos(car.h);
      const tx = target.x - car.pos.x;
      const tz = target.y - car.pos.y;
      const alpha = Math.atan2(fx * tz - fz * tx, fx * tx + fz * tz);
      const want = THREE.MathUtils.clamp(Math.atan2(2 * wb * Math.sin(-alpha), look), -0.6, 0.6);
      car.steer += THREE.MathUtils.clamp(want - car.steer, -1.4 * dt, 1.4 * dt);

      // Target speed: lane cruise, slower for bends and U-turns.
      let vt = car.lane.cruise * car.cruiseMul;
      const p1 = this.ahead(car, 8, tmp2).clone();
      const p2 = this.ahead(car, 22, tmp2).clone();
      const p3 = this.ahead(car, 36, tmp2);
      const ang = Math.abs(Math.atan2((p2.x - p1.x) * (p3.y - p2.y) - (p2.y - p1.y) * (p3.x - p2.x), (p2.x - p1.x) * (p3.x - p2.x) + (p2.y - p1.y) * (p3.y - p2.y)));
      if (ang > 0.02) vt = Math.min(vt, Math.sqrt(2.6 / (ang / 14)));
      if (Math.abs(alpha) > 1) vt = Math.min(vt, 3);
      if (!car.queue.length) vt = Math.min(vt, Math.sqrt(Math.max(0, 2 * 2.5 * (remaining - 4))));
      if (atEnd) vt = 0;
      if (car.pause > 0) {
        car.pause -= dt;
        vt = 0;
      }

      // Look ahead along the route for anything in the way.
      const brake = 3.5;
      const range = Math.min(70, 10 + (car.v * car.v) / (2 * brake) + car.m.length);
      let gap = Infinity;
      let blocker: Car | null = null;
      let byPlayer = false;
      for (let d = car.m.length / 2; d < range && gap === Infinity; d += 2.5) {
        const q = this.ahead(car, d, tmp2);
        for (const o of this.cars) {
          if (o === car) continue;
          if (o.blockedBy === car && car.id < o.id) continue; // break deadlocks: lower id goes first
          if (Math.hypot(o.pos.x - q.x, o.pos.y - q.y) < 1.5 + o.m.width / 2) {
            gap = d - o.m.length / 2;
            blocker = o;
            break;
          }
        }
        if (gap !== Infinity) break;
        if (obs.humvee && Math.hypot(obs.humvee.x - q.x, obs.humvee.z - q.y) < 2.9) {
          gap = d - 2.5;
          byPlayer = true;
          break;
        }
        if (obs.heli && Math.hypot(obs.heli.x - q.x, obs.heli.z - q.y) < 13) {
          gap = d - 10;
          byPlayer = true;
          break;
        }
        if (colliders.hit(_v3.set(q.x, car.y + 1.2, q.y), 0.5, true)) {
          gap = d;
          break;
        }
      }
      // Direct check on the bodies ahead (catches cars off the lane line,
      // mid U-turn or cutting a corner).
      for (const o of this.cars) {
        if (o === car) continue;
        const dx = o.pos.x - car.pos.x;
        const dz = o.pos.y - car.pos.y;
        if (dx * dx + dz * dz > 30 * 30) continue;
        const lz = dx * fx + dz * fz;
        const lx = dx * fz - dz * fx;
        if (lz <= 0 || Math.abs(lx) > (car.m.width + o.m.width) / 2 + 0.5) continue;
        const g2 = lz - (car.m.length + o.m.length) / 2;
        // In a stand-off the lower id creeps on while the other backs away.
        if (o.blockedBy === car && car.id < o.id && o.reverseT > 0 && g2 > 1) continue;
        if (g2 < gap) {
          gap = g2 + car.m.length / 2;
          blocker = o;
        }
      }
      car.blockedBy = blocker;
      if (gap !== Infinity) vt = Math.min(vt, Math.sqrt(Math.max(0, 2 * brake * (gap - 5))));
      // Horn when the player has been blocking for a while.
      if (byPlayer && car.v < 0.5) {
        car.waitT += dt;
        car.honkT -= dt;
        if (car.waitT > 2.5 && car.honkT <= 0 && camPos.distanceToSquared(_v3.set(car.pos.x, car.y, car.pos.y)) < 250 * 250) {
          this.onHonk?.(_v3.clone());
          car.honkT = 4;
        }
      } else car.waitT = 0;

      // Stand-off: two vehicles blocking each other. After a few seconds the
      // higher id backs up for a moment to let the other through.
      const mutual = blocker && blocker.blockedBy === car;
      car.stuckT = mutual && car.v < 0.3 ? car.stuckT + dt : 0;
      if (car.stuckT > 4 && blocker && car.id > blocker.id && car.reverseT <= 0) car.reverseT = 2.5;
      if (car.reverseT > 0) {
        car.reverseT -= dt;
        vt = -2;
      }
      // Longitudinal: gentle acceleration, firmer braking.
      const dv = vt - car.v;
      const acc = dv > 0 ? Math.min(dv / dt, 1.6) : Math.max(dv / dt, gap !== Infinity ? -7 : -3.5);
      car.accel = acc;
      car.v = Math.max(car.reverseT > 0 ? -2 : 0, car.v + acc * dt);

      // Kinematic bicycle model.
      car.yawRate = (car.v / wb) * Math.tan(car.steer);
      car.h += car.yawRate * dt;
      car.pos.x += Math.sin(car.h) * car.v * dt;
      car.pos.y += Math.cos(car.h) * car.v * dt;

      // Never overlap another vehicle: push apart and kill the closing speed.
      for (const o of this.cars) {
        if (o === car) continue;
        const dx = car.pos.x - o.pos.x;
        const dz = car.pos.y - o.pos.y;
        const d = Math.hypot(dx, dz);
        const minD = (Math.min(car.m.length, car.m.width * 2) + Math.min(o.m.length, o.m.width * 2)) / 2;
        if (d >= minD || d < 1e-3) continue;
        const push = (minD - d) * 0.5;
        car.pos.x += (dx / d) * push;
        car.pos.y += (dz / d) * push;
        // Moving towards it? Stop.
        if ((Math.sin(car.h) * -dx + Math.cos(car.h) * -dz) * car.v > 0) car.v = Math.sign(car.v) * Math.min(Math.abs(car.v), 0.5);
      }

      // Ride height and body attitude from the road under each axle and side.
      const hf = Math.sin(car.h);
      const hc = Math.cos(car.h);
      const half = wb / 2;
      const tw = car.m.width * 0.4;
      const yc = this.surface(car.pos.x, car.pos.y, car.y);
      const yF = this.surface(car.pos.x + hf * half, car.pos.y + hc * half, car.y);
      const yB = this.surface(car.pos.x - hf * half, car.pos.y - hc * half, car.y);
      const yL = this.surface(car.pos.x - hc * tw, car.pos.y + hf * tw, car.y);
      const yR = this.surface(car.pos.x + hc * tw, car.pos.y - hf * tw, car.y);
      const k = 1 - Math.exp(-dt * 10);
      car.y += ((yc + (yF + yB) / 2) / 2 - car.y) * k;
      const pitchT = Math.atan2(yF - yB, wb) + car.accel * 0.006;
      const rollT = Math.atan2(yR - yL, tw * 2) - car.v * car.yawRate * 0.012;
      car.pitch += (pitchT - car.pitch) * (1 - Math.exp(-dt * 6));
      car.roll += (rollT - car.roll) * (1 - Math.exp(-dt * 6));

      // Pose the model (faces −Z) and animate wheels.
      const g = car.m.group;
      g.position.set(car.pos.x, car.y, car.pos.y);
      g.rotation.set(car.pitch, car.h + Math.PI, car.roll, 'YXZ');
      // Body sits on its springs: dives under braking, leans out of turns.
      car.m.body.rotation.set(car.accel * 0.004, 0, -car.v * car.yawRate * 0.006);
      for (const w of car.m.wheels) {
        w.spin.rotation.x -= (car.v * dt) / w.r;
        if (w.front) w.pivot.rotation.y = car.steer;
      }
      // Level of detail: animated parts up close, one merged mesh further out, nothing past 4 km.
      const d2 = camPos.distanceToSquared(g.position);
      const far = d2 > 220 * 220;
      g.visible = d2 < 4000 * 4000;
      if (car.m.far.visible !== far) {
        car.m.far.visible = far;
        car.m.body.visible = !far;
        for (const w of car.m.wheels) w.pivot.visible = !far;
      }

      // Dust off gravel tracks.
      car.dustT -= dt;
      if (car.lane.track && car.v > 4 && car.dustT <= 0 && camPos.distanceToSquared(g.position) < 1000 * 1000) {
        car.dustT = 0.18;
        this.effects.smoke.emit({
          x: car.pos.x - hf * (car.m.length / 2 + 0.5),
          y: car.y + 0.6,
          z: car.pos.y - hc * (car.m.length / 2 + 0.5),
          vy: 0.6,
          life: 2.5,
          size0: 2,
          size1: 6,
          r: 0.62,
          g: 0.56,
          b: 0.44,
          alpha: 0.28,
          drag: 1,
          wash: 0.5,
        });
      }
    }
  }
}
