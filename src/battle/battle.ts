import * as THREE from 'three';
import type { World } from '../world/worldgen';
import type { Effects, SmokeEmitter } from '../fx/effects';
import type { AudioEngine } from '../audio';
import type { Threats } from '../game/threats';
import type { Heli } from '../heli/heli';
import type { RNG } from '../util/noise';
import { clamp } from '../util/math';
import { Campaign, enemyOf, SIDES, type SectorState, type Side } from './campaign';
import { SoldierRenderer, type Pose, type SoldierView } from './soldierRenderer';
import { Vehicle } from './vehicles';
import { TrenchLine, hedgehogs } from './fortifications';

type Role = 'rifle' | 'mg' | 'at' | 'engineer';
type SoldierState = 'hold' | 'advance' | 'retreat' | 'move' | 'dig' | 'dead';

interface Soldier extends SoldierView {
  id: number;
  role: Role;
  state: SoldierState;
  alive: boolean;
  home: THREE.Vector3;
  goal: THREE.Vector3 | null;
  inTrench: boolean;
  target: Target | null;
  cd: number;
  acquireT: number;
  deadT: number;
  boundT: number;
  burst: number;
  burstT: number;
  assault: number;
  aimT: number;
}

type Target = { soldier: Soldier } | { vehicle: Vehicle } | { heli: true };

interface Shell {
  t: number;
  at: THREE.Vector3;
  from: Side;
  hitVehicle: Vehicle | null;
  scale: number;
}

interface Front {
  s: SectorState;
  group: THREE.Group;
  lines: Record<Side, TrenchLine>;
  soldiers: Soldier[];
  vehicles: Vehicle[];
  wrecks: { v: Vehicle; smoke: SmokeEmitter; t: number }[];
  assaultT: number;
  artyT: Record<Side, number>;
  reinforceT: Record<Side, number>;
  rear: Record<Side, THREE.Vector3>;
  assaultId: number;
  assaultSide: Side | null;
  assaultStart: number;
}

const MAX_INF = 26;
/** How far troops sit below grade in a trench (chest-high parapet). */
const TRENCH_SINK = -0.45;
const LINE_OFFSET = 110;
const LINE_LEN = 320;
const ACTIVATE = 2300;
const DEACTIVATE = 3000;

export interface BattleHooks {
  radio(from: string, msg: string): void;
  onHeliHit(dmg: number): void;
}

/**
 * The visible war: turns nearby campaign sectors into soldiers, vehicles and
 * trench lines, fights it out, and writes every loss back to the campaign.
 */
export class Battle {
  group = new THREE.Group();
  private renderer = new SoldierRenderer(140);
  fronts = new Map<number, Front>();
  private shells: Shell[] = [];
  private nextId = 1;
  private soundBudget = 0;
  private views: SoldierView[] = [];
  private tmp = new THREE.Vector3();
  private tmp2 = new THREE.Vector3();
  private time = 0;
  private lastRadio = -999;

  constructor(
    private world: World,
    public campaign: Campaign,
    private effects: Effects,
    private audio: AudioEngine,
    private threats: Threats,
    private rng: RNG,
    private hooks: BattleHooks,
  ) {
    this.group.add(this.renderer.group);
  }

  // ---------------------------------------------------------------------------
  // Geometry helpers

  private linePoint(s: SectorState, side: Side, t: number, extra = 0): THREE.Vector2 {
    const z = s.zc + (t - 0.5) * LINE_LEN;
    const dir = side === 'blue' ? -1 : 1;
    const zig = 3.5 * Math.sin(z * 0.19) + 1.5 * Math.sin(z * 0.05 + s.id);
    return new THREE.Vector2(this.world.front.x(z) + dir * (LINE_OFFSET + extra) + zig, z);
  }

  private ground(x: number, z: number) {
    return this.world.terrain.heightAt(x, z);
  }

  sectorCenter(s: SectorState, out: THREE.Vector3) {
    return out.set(this.world.front.x(s.zc), 0, s.zc);
  }

  // ---------------------------------------------------------------------------
  // Spawning

  private makeSoldier(side: Side, role: Role, pos: THREE.Vector3, inTrench: boolean): Soldier {
    return {
      id: this.nextId++,
      side,
      role,
      pos: pos.clone(),
      home: pos.clone(),
      heading: side === 'blue' ? -Math.PI / 2 : Math.PI / 2,
      pose: inTrench ? 'kneel' : 'stand',
      phase: this.rng.range(0, 6),
      sink: inTrench ? TRENCH_SINK : 0,
      aiming: false,
      state: role === 'engineer' ? 'dig' : 'hold',
      alive: true,
      goal: null,
      inTrench,
      target: null,
      cd: this.rng.range(0.5, 3),
      acquireT: this.rng.range(0, 1.5),
      deadT: 0,
      boundT: 0,
      burst: 0,
      burstT: 0,
      assault: 0,
      aimT: 0,
    };
  }

  /** A free fighting position along a side's built trench. */
  private trenchSlot(f: Front, side: Side): THREE.Vector3 {
    const line = f.lines[side];
    const [a, b] = line.builtRange();
    for (let tries = 0; tries < 8; tries++) {
      const i = this.rng.int(a, b);
      const p = line.points[i];
      if (p.y < 0.6) continue;
      const taken = f.soldiers.some((s) => s.alive && s.side === side && s.home.distanceToSquared(p) < 9);
      if (!taken || tries === 7) return p.clone().add(new THREE.Vector3(this.rng.range(-0.4, 0.4), 0, this.rng.range(-0.8, 0.8)));
    }
    return line.points[Math.floor((a + b) / 2)].clone();
  }

  private materialize(s: SectorState) {
    const group = new THREE.Group();
    const rng = this.rng.fork();
    const lines = {} as Record<Side, TrenchLine>;
    for (const side of SIDES) {
      lines[side] = new TrenchLine(this.world.terrain, side, (t) => this.linePoint(s, side, t), LINE_LEN, s.fort[side], rng);
      group.add(lines[side].group);
    }
    group.add(
      hedgehogs(
        this.world.terrain,
        (t, off) => new THREE.Vector2(this.world.front.x(s.zc + (t - 0.5) * LINE_LEN) + off, s.zc + (t - 0.5) * LINE_LEN),
        rng,
        14,
      ),
    );
    const rear = {} as Record<Side, THREE.Vector3>;
    for (const side of SIDES) {
      const p = this.linePoint(s, side, 0.5, 420);
      rear[side] = new THREE.Vector3(p.x, this.ground(p.x, p.y), p.y);
    }
    const f: Front = {
      s,
      group,
      lines,
      soldiers: [],
      vehicles: [],
      wrecks: [],
      assaultT: rng.range(15, 40),
      artyT: { blue: rng.range(4, 15), red: rng.range(4, 15) },
      reinforceT: { blue: rng.range(10, 25), red: rng.range(10, 25) },
      rear,
      assaultId: 0,
      assaultSide: null,
      assaultStart: 0,
    };
    for (const side of SIDES) {
      const n = Math.min(MAX_INF, Math.floor(s.inf[side]));
      for (let i = 0; i < n; i++) {
        const role: Role = i % 7 === 3 ? 'mg' : i % 9 === 5 ? 'at' : 'rifle';
        f.soldiers.push(this.makeSoldier(side, role, this.trenchSlot(f, side), true));
      }
      if (s.fort[side] < 0.98 && n > 4) {
        for (const p of lines[side].digFronts()) {
          const e = this.makeSoldier(side, 'engineer', p.clone(), false);
          e.goal = p.clone();
          f.soldiers.push(e);
        }
      }
      const total = Math.min(3, Math.floor(s.armor[side]));
      const tanks = Math.min(2, Math.ceil(total * 0.6));
      for (let i = 0; i < total; i++) {
        const v = new Vehicle(this.nextId++, i < tanks ? 'tank' : 'apc', side, s.id);
        const p = this.linePoint(s, side, rng.range(0.15, 0.85), rng.range(60, 170));
        v.pos.set(p.x, this.ground(p.x, p.y), p.y);
        if (v.pos.y < 0.5) continue;
        v.heading = side === 'blue' ? -Math.PI / 2 : Math.PI / 2;
        v.task = v.kind === 'apc' ? 'support' : 'patrol';
        v.fireCd = rng.range(2, 8);
        this.placeVehicle(v);
        group.add(v.root);
        f.vehicles.push(v);
      }
    }
    this.group.add(group);
    this.fronts.set(s.id, f);
    this.campaign.active.add(s.id);
  }

  private dematerialize(f: Front) {
    // Survivors are already counted in the campaign (losses were written as they happened).
    for (const w of f.wrecks) this.effects.removeEmitter(w.smoke);
    for (const side of SIDES) f.lines[side].dispose();
    this.group.remove(f.group);
    this.fronts.delete(f.s.id);
    this.campaign.active.delete(f.s.id);
  }

  // ---------------------------------------------------------------------------
  // Main update

  update(dt: number, heli: Heli, camPos: THREE.Vector3) {
    this.time += dt;
    this.soundBudget = Math.min(16, this.soundBudget + dt * 14);
    this.campaign.tick(dt);

    // Activate sectors near the player, retire distant ones.
    // Keep the (up to) two sectors nearest the player live; swap out farther ones.
    const hp = heli.fm.pos;
    const ranked = this.campaign.sectors
      .map((s) => {
        this.sectorCenter(s, this.tmp);
        return { s, d: Math.hypot(this.tmp.x - hp.x, this.tmp.z - hp.z) };
      })
      .sort((a, b) => a.d - b.d);
    const want = new Set(ranked.filter((o) => o.d < ACTIVATE).slice(0, 2).map((o) => o.s.id));
    const needSlot = [...want].some((id) => !this.fronts.has(id));
    for (const { s, d } of ranked) {
      const f = this.fronts.get(s.id);
      if (f && (d > DEACTIVATE || (needSlot && !want.has(s.id)))) this.dematerialize(f);
    }
    for (const id of want) if (!this.fronts.has(id) && this.fronts.size < 2) this.materialize(this.campaign.sectors[id]);

    for (const f of this.fronts.values()) this.updateFront(f, dt, heli, camPos);
    this.updateShells(dt, heli, camPos);

    this.views.length = 0;
    for (const f of this.fronts.values()) for (const s of f.soldiers) this.views.push(s);
    this.renderer.render(this.views);
  }

  private updateFront(f: Front, dt: number, heli: Heli, camPos: THREE.Vector3) {
    const s = f.s;
    // --- Construction ---------------------------------------------------
    for (const side of SIDES) {
      const line = f.lines[side];
      const diggers = f.soldiers.filter((x) => x.alive && x.side === side && x.role === 'engineer' && x.state === 'dig' && x.goal && x.pos.distanceTo(x.goal) < 1.5);
      if (diggers.length && s.fort[side] < 1) {
        s.fort[side] = Math.min(1, s.fort[side] + diggers.length * dt * 0.0035);
        if (Math.abs(s.fort[side] - line.progress) > 0.008) {
          line.setProgress(s.fort[side]);
          // Follow the ends of the trench as it grows.
          const fronts = line.digFronts();
          diggers.forEach((d, i) => d.goal!.copy(fronts[i % 2]));
        }
      }
    }

    // --- Assaults ---------------------------------------------------------
    f.assaultT -= dt;
    if (f.assaultT <= 0) {
      f.assaultT = this.rng.range(50, 110);
      this.launchAssault(f, heli);
    }
    if (f.assaultSide) {
      const group = f.soldiers.filter((x) => x.assault === f.assaultId);
      const alive = group.filter((x) => x.alive);
      if (group.length && (alive.length < group.length * 0.45 || this.time - f.assaultStart > 75)) {
        for (const x of alive) if (x.state === 'advance') x.state = 'retreat';
        f.assaultSide = null;
      } else if (!alive.some((x) => x.state === 'advance')) f.assaultSide = null;
    }

    // --- Artillery ------------------------------------------------------
    for (const side of SIDES) {
      f.artyT[side] -= dt;
      if (f.artyT[side] <= 0) {
        f.artyT[side] = this.rng.range(14, 28) / Math.max(0.35, s.arty[side]);
        const enemy = f.lines[enemyOf(side)];
        const [a, b] = enemy.builtRange();
        const p = enemy.points[this.rng.int(a, b)];
        const acc = 26 / Math.max(0.6, s.arty[side]);
        const x = p.x + this.rng.gauss() * acc;
        const z = p.z + this.rng.gauss() * acc;
        this.shells.push({ t: this.rng.range(0, 0.6), at: new THREE.Vector3(x, this.ground(x, z), z), from: side, hitVehicle: null, scale: 1.3 });
      }
    }

    // --- Reinforcements --------------------------------------------------
    for (const side of SIDES) {
      f.reinforceT[side] -= dt;
      if (f.reinforceT[side] > 0) continue;
      f.reinforceT[side] = this.rng.range(25, 45);
      const alive = f.soldiers.filter((x) => x.alive && x.side === side && x.role !== 'engineer').length;
      const reserve = Math.floor(s.inf[side]) - alive;
      if (alive >= MAX_INF || reserve < 1) continue;
      const apc = f.vehicles.find((v) => !v.dead && v.side === side && v.kind === 'apc' && v.task === 'support');
      if (apc) {
        apc.task = 'ferry';
        apc.carrying = Math.min(6, reserve, MAX_INF - alive);
        apc.goal = f.rear[side].clone();
      } else {
        const n = Math.min(4, reserve, MAX_INF - alive);
        for (let i = 0; i < n; i++) {
          const p = f.rear[side].clone().add(new THREE.Vector3(this.rng.range(-6, 6), 0, this.rng.range(-12, 12)));
          p.y = this.ground(p.x, p.z);
          const sol = this.makeSoldier(side, i === 0 && this.rng.chance(0.3) ? 'mg' : 'rifle', p, false);
          sol.state = 'move';
          sol.goal = this.trenchSlot(f, side);
          sol.home = sol.goal.clone();
          f.soldiers.push(sol);
        }
      }
    }

    // --- Soldiers ---------------------------------------------------------
    for (let i = f.soldiers.length - 1; i >= 0; i--) {
      const sol = f.soldiers[i];
      if (!sol.alive) {
        sol.deadT += dt;
        if (sol.deadT > 50) f.soldiers.splice(i, 1);
        continue;
      }
      this.updateSoldier(f, sol, dt, heli, camPos);
    }

    // --- Vehicles ---------------------------------------------------------
    for (const v of f.vehicles) if (!v.dead) this.updateVehicle(f, v, dt, heli, camPos);
    for (let i = f.wrecks.length - 1; i >= 0; i--) {
      const w = f.wrecks[i];
      w.t += dt;
      if (w.t > 40) w.smoke.rate = Math.max(1, w.smoke.rate * Math.exp(-dt * 0.05));
      if (w.t > 180) {
        this.effects.removeEmitter(w.smoke);
        f.group.remove(w.v.root);
        f.vehicles = f.vehicles.filter((x) => x !== w.v);
        f.wrecks.splice(i, 1);
      }
    }
  }

  private launchAssault(f: Front, heli: Heli) {
    const s = f.s;
    const pb = this.campaign.power(s, 'blue');
    const pr = this.campaign.power(s, 'red');
    const side: Side = this.rng.chance(pr / Math.max(1, pb + pr)) ? 'red' : 'blue';
    const pool = f.soldiers.filter((x) => x.alive && x.side === side && x.state === 'hold' && (x.role === 'rifle' || x.role === 'mg'));
    if (pool.length < 8) return;
    const anchor = this.rng.pick(pool).home;
    pool.sort((a, b) => a.home.distanceToSquared(anchor) - b.home.distanceToSquared(anchor));
    const n = this.rng.int(4, Math.min(9, pool.length - 3));
    f.assaultId++;
    f.assaultSide = side;
    f.assaultStart = this.time;
    const enemyLine = f.lines[enemyOf(side)];
    for (const x of pool.slice(0, n)) {
      // Head for the nearest point of the enemy trench.
      let best = enemyLine.points[0];
      for (const p of enemyLine.points) if (p.distanceToSquared(x.home) < best.distanceToSquared(x.home)) best = p;
      x.goal = best.clone().add(new THREE.Vector3(this.rng.range(-3, 3), 0, this.rng.range(-8, 8)));
      x.state = 'advance';
      x.assault = f.assaultId;
      x.inTrench = false;
      x.sink = 0;
      x.pose = 'run';
      x.boundT = this.rng.range(2, 4);
    }
    // Armor pushes up in support.
    for (const v of f.vehicles)
      if (!v.dead && v.side === side && v.kind === 'tank') {
        const p = this.linePoint(s, side, this.rng.range(0.25, 0.75), -this.rng.range(10, 40));
        v.goal = new THREE.Vector3(p.x, 0, p.y);
        v.pause = 0;
      }
    this.sectorCenter(s, this.tmp);
    const near = Math.hypot(this.tmp.x - heli.fm.pos.x, this.tmp.z - heli.fm.pos.z) < 2200;
    if (near && this.time - this.lastRadio > 45) {
      this.lastRadio = this.time;
      if (side === 'red') this.hooks.radio(`${s.name} TOC`, 'Enemy assault on our line! All callsigns, troops in contact.');
      else this.hooks.radio(`${s.name} TOC`, 'Friendly platoon is pushing on the enemy trench. Expect heavy contact.');
    }
  }

  // ---------------------------------------------------------------------------
  // Soldiers

  private enemyTargets(f: Front, sol: Soldier) {
    return f.soldiers.filter((x) => x.alive && x.side !== sol.side);
  }

  private acquire(f: Front, sol: Soldier, heli: Heli): Target | null {
    const eye = sol.pos.y + (sol.inTrench ? 1.0 : 1.5);
    const terrain = this.world.terrain;
    // Enemy troops fire on a helicopter that comes close.
    if (sol.side === 'red' && !heli.crashed && sol.role !== 'engineer') {
      const hp = heli.fm.pos;
      const d = sol.pos.distanceTo(hp);
      if (d < 450 && heli.fm.agl < 200 && (d < 250 || this.rng.chance(0.5)) && terrain.lineOfSight(sol.pos.x, eye, sol.pos.z, hp.x, hp.y, hp.z, 16)) return { heli: true };
    }
    if (sol.role === 'at') {
      let best: Vehicle | null = null;
      let bd = 380;
      for (const v of f.vehicles) {
        if (v.dead || v.side === sol.side) continue;
        const d = v.pos.distanceTo(sol.pos);
        if (d < bd) {
          bd = d;
          best = v;
        }
      }
      if (best && terrain.lineOfSight(sol.pos.x, eye, sol.pos.z, best.pos.x, best.pos.y + 1.5, best.pos.z, 14)) return { vehicle: best };
    }
    const enemies = this.enemyTargets(f, sol);
    // Check the few nearest candidates for line of sight.
    const cands = enemies
      .map((e) => ({ e, d: e.pos.distanceToSquared(sol.pos) }))
      .filter((o) => o.d < 420 * 420)
      .sort((a, b) => a.d - b.d)
      .slice(0, 4);
    for (const { e } of cands) {
      const ey = e.pos.y + (e.inTrench ? 0.9 : e.pose === 'prone' ? 0.4 : 1.3);
      if (terrain.lineOfSight(sol.pos.x, eye, sol.pos.z, e.pos.x, ey, e.pos.z, 14)) return { soldier: e };
    }
    if (sol.role === 'mg') {
      for (const v of f.vehicles) if (!v.dead && v.side !== sol.side && v.pos.distanceTo(sol.pos) < 500) return { vehicle: v };
    }
    return null;
  }

  private targetPos(t: Target, heli: Heli, out: THREE.Vector3): THREE.Vector3 | null {
    if ('heli' in t) return out.copy(heli.fm.pos);
    if ('vehicle' in t) return t.vehicle.dead ? null : out.copy(t.vehicle.pos).setY(t.vehicle.pos.y + 1.4);
    const s = t.soldier;
    if (!s.alive) return null;
    return out.copy(s.pos).setY(s.pos.y + (s.inTrench ? 0.9 : s.pose === 'prone' ? 0.3 : 1.2) + s.sink * 0);
  }

  private faceToward(sol: Soldier, p: THREE.Vector3) {
    sol.heading = Math.atan2(p.x - sol.pos.x, p.z - sol.pos.z) + Math.PI;
  }

  private walk(sol: Soldier, goal: THREE.Vector3, speed: number, dt: number): boolean {
    const dx = goal.x - sol.pos.x;
    const dz = goal.z - sol.pos.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.6) return true;
    const step = Math.min(d, speed * dt);
    sol.pos.x += (dx / d) * step;
    sol.pos.z += (dz / d) * step;
    sol.pos.y = this.ground(sol.pos.x, sol.pos.z);
    sol.heading = Math.atan2(dx, dz) + Math.PI;
    sol.phase += dt * speed * 2.6;
    return false;
  }

  private updateSoldier(f: Front, sol: Soldier, dt: number, heli: Heli, camPos: THREE.Vector3) {
    sol.aimT = Math.max(0, sol.aimT - dt);
    sol.aiming = sol.aimT > 0;
    let canFire = true;
    switch (sol.state) {
      case 'dig':
        if (sol.goal && !this.walk(sol, sol.goal, 2.2, dt)) {
          sol.pose = 'run';
          canFire = false;
        } else {
          sol.pose = 'dig';
          sol.phase += dt * 5;
          canFire = false;
          // Drop the shovel when the enemy gets close.
          if (sol.target && 'soldier' in sol.target && sol.target.soldier.pos.distanceTo(sol.pos) < 150) canFire = true;
        }
        break;
      case 'move':
        if (sol.goal && this.walk(sol, sol.goal, 3.6, dt)) {
          sol.state = 'hold';
          sol.inTrench = true;
          sol.sink = TRENCH_SINK;
        } else {
          sol.pose = 'run';
          canFire = false;
        }
        break;
      case 'advance':
        // Bounding: rush for a few seconds, drop prone and fire, repeat.
        sol.boundT -= dt;
        if (sol.boundT <= 0) {
          if (sol.pose === 'run') {
            sol.pose = 'prone';
            sol.boundT = this.rng.range(3, 5.5);
          } else {
            sol.pose = 'run';
            sol.boundT = this.rng.range(2, 4);
          }
        }
        if (sol.pose === 'run') {
          canFire = false;
          if (sol.goal && this.walk(sol, sol.goal, 3.4, dt)) {
            // Took the position: fight from here.
            sol.state = 'hold';
            sol.home.copy(sol.pos);
            sol.inTrench = true;
            sol.sink = TRENCH_SINK;
          }
        }
        break;
      case 'retreat':
        if (this.walk(sol, sol.home, 3.8, dt)) {
          sol.state = 'hold';
          sol.inTrench = true;
          sol.sink = TRENCH_SINK;
        } else {
          sol.pose = 'run';
          canFire = false;
        }
        break;
      default:
        // In a trench: duck down, stand up to the parapet to fire.
        sol.pose = sol.inTrench ? (sol.aiming ? 'stand' : 'kneel') : 'prone';
    }

    // Targeting.
    sol.acquireT -= dt;
    if (sol.acquireT <= 0) {
      sol.acquireT = this.rng.range(0.9, 1.6);
      sol.target = this.acquire(f, sol, heli);
    }
    if (!canFire || !sol.target) return;
    const tp = this.targetPos(sol.target, heli, this.tmp2);
    if (!tp) {
      sol.target = null;
      return;
    }
    if (sol.state === 'hold' || sol.pose === 'prone' || sol.pose === 'kneel') this.faceToward(sol, tp);

    sol.cd -= dt;
    if (sol.burst <= 0 && sol.cd <= 0) {
      const ammo = f.s.ammo[sol.side];
      if (sol.role === 'at') {
        sol.cd = this.rng.range(14, 22);
        this.fireRocket(f, sol, tp, camPos);
        return;
      }
      sol.burst = sol.role === 'mg' ? this.rng.int(8, 14) : this.rng.int(2, 5);
      sol.cd = (sol.role === 'mg' ? this.rng.range(2, 4) : this.rng.range(1.5, 3.5)) / clamp(ammo, 0.5, 1.6);
      this.sound(sol.pos, camPos, sol.role === 'mg' ? 'mg' : 'rifle');
    }
    if (sol.burst > 0) {
      sol.burstT -= dt;
      while (sol.burstT <= 0 && sol.burst > 0) {
        sol.burstT += sol.role === 'mg' ? 0.09 : 0.18;
        sol.burst--;
        sol.aimT = 0.4;
        this.fireRound(f, sol, tp, heli, sol.burst === 0, camPos);
      }
    }
  }

  private muzzle(sol: Soldier, out: THREE.Vector3) {
    const fx = -Math.sin(sol.heading);
    const fz = -Math.cos(sol.heading);
    const h = sol.pose === 'prone' ? 0.35 : sol.pose === 'kneel' ? 1.0 : 1.4;
    return out.set(sol.pos.x + fx * 0.7, sol.pos.y + sol.sink + h, sol.pos.z + fz * 0.7);
  }

  private fireRound(f: Front, sol: Soldier, tp: THREE.Vector3, heli: Heli, last: boolean, camPos: THREE.Vector3) {
    const from = this.muzzle(sol, new THREE.Vector3());
    const target = sol.target!;
    if ('heli' in target) {
      this.threats.shootAt(from, heli, 'mg');
      return;
    }
    const dir = tp.clone().sub(from);
    const dist = dir.length();
    dir.normalize();
    const spread = sol.role === 'mg' ? 0.02 : 0.012;
    dir.x += this.rng.gauss() * spread;
    dir.y += this.rng.gauss() * spread * 0.6;
    dir.z += this.rng.gauss() * spread;
    const v = dir.normalize().multiplyScalar(760);
    if (sol.role === 'mg' || this.rng.chance(0.5)) this.effects.tracer(from, v, Math.min(1.2, dist / 760 + 0.1), sol.side === 'blue' ? 0xff5a3a : 0x7dff6a);
    if (from.distanceToSquared(camPos) < 900 * 900)
      this.effects.fire.emit({ x: from.x, y: from.y, z: from.z, life: 0.05, size0: 1.2, size1: 0.6, r: 2, g: 1.6, b: 0.7, alpha: 1, fadeIn: 0.01 });
    if (!last) return;
    // Resolve the burst.
    if ('soldier' in target) {
      const e = target.soldier;
      const fort = f.s.fort[e.side];
      const cover = e.inTrench ? 0.22 + (1 - fort) * 0.3 : e.pose === 'prone' ? 0.5 : 1;
      const base = sol.role === 'mg' ? 0.09 : 0.04;
      const p = base * clamp(f.s.ammo[sol.side], 0.5, 1.6) * cover * Math.max(0.15, 1 - dist / 460);
      if (this.rng.chance(p)) this.kill(f, e);
      else if (this.rng.chance(0.2)) this.effects.impactPuff(tp.clone().add(new THREE.Vector3(this.rng.gauss() * 2, -0.8, this.rng.gauss() * 2)));
    }
  }

  private fireRocket(f: Front, sol: Soldier, tp: THREE.Vector3, camPos: THREE.Vector3) {
    const from = this.muzzle(sol, new THREE.Vector3());
    const target = sol.target!;
    const dist = from.distanceTo(tp);
    const hit = 'vehicle' in target ? this.rng.chance(0.4) : this.rng.chance(0.25);
    const at = hit ? tp.clone() : tp.clone().add(new THREE.Vector3(this.rng.gauss() * 10, 0, this.rng.gauss() * 10));
    at.y = Math.max(at.y, this.ground(at.x, at.z));
    const v = at.clone().sub(from).normalize().multiplyScalar(240);
    this.effects.tracer(from, v, dist / 240, 0xffd27a);
    for (let k = 0; k < 6; k++)
      this.effects.smoke.emit({ x: from.x, y: from.y, z: from.z, vx: -v.x * 0.01 + this.rng.gauss(), vy: 0.5, vz: -v.z * 0.01 + this.rng.gauss(), life: 2.5, size0: 1, size1: 4, r: 0.85, g: 0.85, b: 0.82, alpha: 0.6, drag: 1.5 });
    this.sound(from, camPos, 'rocket');
    this.shells.push({ t: dist / 240, at, from: sol.side, hitVehicle: hit && 'vehicle' in target ? target.vehicle : null, scale: 0.7 });
  }

  private kill(f: Front, e: Soldier) {
    if (!e.alive) return;
    e.alive = false;
    e.pose = 'dead';
    e.sink = 0;
    e.aiming = false;
    e.heading += this.rng.range(-1, 1);
    this.campaign.casualty(f.s.id, e.side, 'inf');
  }

  // ---------------------------------------------------------------------------
  // Vehicles

  private placeVehicle(v: Vehicle) {
    const n = this.world.terrain.normalAt(v.pos.x, v.pos.z, this.tmp);
    const tilt = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), n);
    const yaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), v.heading);
    v.root.position.copy(v.pos);
    v.root.quaternion.copy(tilt).multiply(yaw);
    v.parts.turret.rotation.y = v.turretYaw;
  }

  private drive(v: Vehicle, goal: THREE.Vector3, dt: number): boolean {
    const dx = goal.x - v.pos.x;
    const dz = goal.z - v.pos.z;
    const d = Math.hypot(dx, dz);
    if (d < 6) return true;
    const want = Math.atan2(dx, dz) + Math.PI;
    let dh = want - v.heading;
    dh = Math.atan2(Math.sin(dh), Math.cos(dh));
    v.heading += clamp(dh, -0.5 * dt, 0.5 * dt);
    if (Math.abs(dh) < 0.7) {
      const sp = v.speed * (1 - Math.abs(dh) / 1.2);
      const nx = v.pos.x - Math.sin(v.heading) * sp * dt;
      const nz = v.pos.z - Math.cos(v.heading) * sp * dt;
      if (this.ground(nx, nz) > 0.4) {
        v.pos.x = nx;
        v.pos.z = nz;
      } else return true;
    }
    v.pos.y = this.ground(v.pos.x, v.pos.z);
    return false;
  }

  private updateVehicle(f: Front, v: Vehicle, dt: number, heli: Heli, camPos: THREE.Vector3) {
    const s = f.s;
    // Movement.
    if (v.pause > 0) v.pause -= dt;
    else if (v.task === 'ferry' && v.goal) {
      if (this.drive(v, v.goal, dt)) {
        // At the rear: load up, then head for the line.
        v.task = 'return';
        const p = this.linePoint(s, v.side, this.rng.range(0.3, 0.7), 30);
        v.goal = new THREE.Vector3(p.x, 0, p.y);
        v.pause = 4;
      }
    } else if (v.task === 'return' && v.goal) {
      if (this.drive(v, v.goal, dt)) {
        // Dismount at the line.
        const back = new THREE.Vector3(Math.sin(v.heading), 0, Math.cos(v.heading)).multiplyScalar(4);
        for (let i = 0; i < v.carrying; i++) {
          const p = v.pos.clone().add(back).add(new THREE.Vector3(this.rng.range(-1.5, 1.5), 0, this.rng.range(-1.5, 1.5)));
          p.y = this.ground(p.x, p.z);
          const sol = this.makeSoldier(v.side, i === 0 ? 'mg' : i === 1 && this.rng.chance(0.5) ? 'at' : 'rifle', p, false);
          sol.state = 'move';
          sol.goal = this.trenchSlot(f, v.side);
          sol.home = sol.goal.clone();
          f.soldiers.push(sol);
        }
        v.carrying = 0;
        v.task = 'support';
        v.goal = null;
        v.pause = 6;
      }
    } else {
      if (!v.goal || this.drive(v, v.goal, dt)) {
        if (v.goal) v.pause = this.rng.range(6, 18);
        const p = this.linePoint(s, v.side, this.rng.range(0.15, 0.85), this.rng.range(50, 170));
        v.goal = new THREE.Vector3(p.x, 0, p.y);
      }
    }

    // Targeting.
    v.acquireT -= dt;
    if (v.acquireT <= 0) {
      v.acquireT = 2;
      v.target = null;
      const eye = v.pos.y + 2.6;
      const terrain = this.world.terrain;
      if (v.kind === 'tank') {
        let best: Vehicle | null = null;
        let bd = 1600;
        for (const o of f.vehicles) {
          if (o.dead || o.side === v.side) continue;
          const d = o.pos.distanceTo(v.pos);
          if (d < bd && terrain.lineOfSight(v.pos.x, eye, v.pos.z, o.pos.x, o.pos.y + 1.6, o.pos.z, 20)) {
            bd = d;
            best = o;
          }
        }
        if (best) v.target = best;
      }
      if (!v.target) {
        if (v.side === 'red' && v.kind === 'apc' && !heli.crashed && heli.fm.pos.distanceTo(v.pos) < 700 && heli.fm.agl < 250) {
          const hp = heli.fm.pos;
          if (terrain.lineOfSight(v.pos.x, eye, v.pos.z, hp.x, hp.y, hp.z, 20)) v.target = 'heli';
        }
      }
      if (!v.target) {
        const enemies = f.soldiers.filter((x) => x.alive && x.side !== v.side && x.pos.distanceTo(v.pos) < (v.kind === 'tank' ? 900 : 550));
        if (enemies.length) {
          const e = this.rng.pick(enemies);
          if (terrain.lineOfSight(v.pos.x, eye, v.pos.z, e.pos.x, e.pos.y + 1, e.pos.z, 16)) v.target = e;
        }
      }
    }
    const tgt = v.target;
    let tp: THREE.Vector3 | null = null;
    if (tgt === 'heli') tp = heli.fm.pos;
    else if (tgt instanceof Vehicle) tp = tgt.dead ? null : tgt.pos;
    else if (tgt && (tgt as Soldier).alive) tp = (tgt as Soldier).pos;
    if (!tp) {
      v.target = null;
      v.turretYaw *= Math.exp(-dt * 0.5);
      this.placeVehicle(v);
      return;
    }
    // Turret slews toward the target (turret yaw is relative to the hull).
    const want = Math.atan2(tp.x - v.pos.x, tp.z - v.pos.z) + Math.PI - v.heading;
    let dy = want - v.turretYaw;
    dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    v.turretYaw += clamp(dy, -0.7 * dt, 0.7 * dt);
    this.placeVehicle(v);
    v.fireCd -= dt;
    if (Math.abs(dy) > 0.08 || v.fireCd > 0) return;
    const muzzle = v.muzzleWorld(new THREE.Vector3());
    const dist = muzzle.distanceTo(tp);
    if (v.kind === 'tank') {
      v.fireCd = this.rng.range(7, 12) / clamp(s.ammo[v.side], 0.5, 1.6);
      const isVeh = tgt instanceof Vehicle;
      const hit = this.rng.chance(isVeh ? 0.38 : 0.3);
      const at = tp.clone();
      if (!hit) at.add(new THREE.Vector3(this.rng.gauss() * 14, 0, this.rng.gauss() * 14));
      at.y = this.ground(at.x, at.z) + (hit && isVeh ? 1.2 : 0);
      const vel = at.clone().sub(muzzle).normalize().multiplyScalar(1500);
      this.effects.tracer(muzzle, vel, dist / 1500, 0xfff0b0);
      for (let k = 0; k < 10; k++)
        this.effects.smoke.emit({ x: muzzle.x, y: muzzle.y, z: muzzle.z, vx: vel.x * 0.004 + this.rng.gauss() * 2, vy: this.rng.range(0, 2), vz: vel.z * 0.004 + this.rng.gauss() * 2, life: 3, size0: 2, size1: 7, r: 0.75, g: 0.72, b: 0.66, alpha: 0.6, drag: 1.2 });
      this.effects.fire.emit({ x: muzzle.x, y: muzzle.y, z: muzzle.z, life: 0.12, size0: 6, size1: 3, r: 2, g: 1.5, b: 0.6, alpha: 1, fadeIn: 0.01 });
      this.sound(muzzle, camPos, 'cannon');
      this.shells.push({ t: dist / 1500, at, from: v.side, hitVehicle: hit && isVeh ? (tgt as Vehicle) : null, scale: 1 });
    } else {
      // APC autocannon/MG bursts.
      v.fireCd = this.rng.range(2.5, 5);
      this.sound(muzzle, camPos, 'mg');
      for (let k = 0; k < 8; k++) {
        if (tgt === 'heli') {
          this.threats.shootAt(muzzle, heli, 'mg');
          continue;
        }
        const dir = tp.clone().setY(tp.y + 1).sub(muzzle).normalize();
        dir.x += this.rng.gauss() * 0.02;
        dir.y += this.rng.gauss() * 0.01;
        dir.z += this.rng.gauss() * 0.02;
        this.effects.tracer(muzzle.clone().addScaledVector(dir, -k * 3), dir.multiplyScalar(800), dist / 800, v.side === 'blue' ? 0xff5a3a : 0x7dff6a);
      }
      if (tgt && !(tgt instanceof Vehicle) && tgt !== 'heli') {
        const e = tgt as Soldier;
        const cover = e.inTrench ? 0.3 : e.pose === 'prone' ? 0.6 : 1;
        if (this.rng.chance(0.12 * cover)) this.kill(f, e);
      }
    }
  }

  private destroyVehicle(f: Front, v: Vehicle) {
    if (v.dead) return;
    v.wreck();
    this.effects.explosion(v.pos.clone().setY(v.pos.y + 1.5), 1.8);
    const smoke = this.effects.addEmitter(v.pos.clone().setY(v.pos.y + 2), 'burning', 7);
    f.wrecks.push({ v, smoke, t: 0 });
    this.campaign.casualty(f.s.id, v.side, 'armor');
    // Crew/passengers lost with it.
    if (v.carrying > 0) for (let i = 0; i < v.carrying; i++) this.campaign.casualty(f.s.id, v.side, 'inf');
    v.carrying = 0;
  }

  // ---------------------------------------------------------------------------
  // Shells, rockets and artillery impacts

  private updateShells(dt: number, heli: Heli, camPos: THREE.Vector3) {
    for (let i = this.shells.length - 1; i >= 0; i--) {
      const sh = this.shells[i];
      sh.t -= dt;
      if (sh.t > 0) continue;
      this.shells.splice(i, 1);
      const d = sh.at.distanceTo(camPos);
      this.effects.explosion(sh.at, sh.scale, d < 2500);
      this.audio.explosion(d, sh.scale);
      for (const f of this.fronts.values()) {
        if (sh.hitVehicle && f.vehicles.includes(sh.hitVehicle) && !sh.hitVehicle.dead) {
          sh.hitVehicle.hp--;
          this.effects.sparks(sh.at, 14);
          if (sh.hitVehicle.hp <= 0) this.destroyVehicle(f, sh.hitVehicle);
        }
        for (const s of f.soldiers) {
          if (!s.alive) continue;
          const r = s.pos.distanceTo(sh.at);
          const lethal = 6 * sh.scale;
          if (r > lethal * 2) continue;
          let p = r < lethal ? 0.6 : 0.2;
          if (s.inTrench) p *= 1 - f.s.fort[s.side] * 0.6;
          if (this.rng.chance(p)) this.kill(f, s);
        }
        if (!sh.hitVehicle && sh.scale >= 1.2)
          for (const v of f.vehicles) if (!v.dead && v.pos.distanceTo(sh.at) < 7 && this.rng.chance(0.4)) {
            v.hp--;
            if (v.hp <= 0) this.destroyVehicle(f, v);
          }
      }
      const dh = sh.at.distanceTo(heli.fm.pos);
      if (dh < 18 && !heli.crashed) {
        const dmg = (1 - dh / 18) * 18 * sh.scale;
        heli.damage(dmg, 'Shellfire');
        this.hooks.onHeliHit(dmg);
      }
    }
  }

  private sound(at: THREE.Vector3, camPos: THREE.Vector3, kind: 'rifle' | 'mg' | 'cannon' | 'rocket') {
    const d = at.distanceTo(camPos);
    if (d > 2600 || this.soundBudget < 1) return;
    this.soundBudget -= kind === 'cannon' ? 0.5 : 1;
    if (kind === 'cannon') this.audio.explosion(d, 0.45);
    else if (kind === 'rocket') this.audio.gunshot(d, true);
    else this.audio.gunshot(d, kind === 'mg');
  }

  /** Summary for UI: per-sector numbers. */
  sectorInfo() {
    return this.campaign.sectors.map((s) => ({
      s,
      x: this.world.front.x(s.zc),
      z: s.zc,
      control: this.campaign.control(s),
      active: this.fronts.has(s.id),
    }));
  }
}

export type { Pose };
