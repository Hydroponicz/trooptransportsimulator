import * as THREE from 'three';
import type { RNG } from '../util/noise';
import type { World, EnemyKind } from '../world/worldgen';
import type { Heli } from '../heli/heli';
import type { Effects } from '../fx/effects';
import type { AudioEngine } from '../audio';
import type { Site } from '../world/sites';
import { clamp } from '../util/math';

interface Shooter {
  pos: THREE.Vector3;
  kind: EnemyKind;
  cooldown: number;
  burst: number;
  burstT: number;
  los: boolean;
  losT: number;
  temp: boolean;
}

interface Bullet {
  p: THREE.Vector3;
  v: THREE.Vector3;
  life: number;
  dmg: number;
}

interface Flare {
  p: THREE.Vector3;
  v: THREE.Vector3;
  life: number;
}

interface Missile {
  p: THREE.Vector3;
  v: THREE.Vector3;
  life: number;
  target: Flare | null;
  speed: number;
  mesh: THREE.Mesh;
}

const RANGE: Record<EnemyKind, number> = { aa: 1400, mg: 650, manpads: 2600 };
/** How far onto the friendly side (m from the front) fixed positions will engage. */
const REACH: Record<EnemyKind, number> = { aa: -350, mg: -120, manpads: -450 };

export interface ThreatHooks {
  onHit(dmg: number): void;
  toast(msg: string, kind?: 'info' | 'good' | 'bad'): void;
}

/** Enemy fire against the player plus the ambient war along the front. */
export class Threats {
  group = new THREE.Group();
  shooters: Shooter[] = [];
  bullets: Bullet[] = [];
  missiles: Missile[] = [];
  flares: Flare[] = [];
  hotZones = new Map<number, { site: Site; timer: number; temps: Shooter[] }>();
  missileWarning = false;
  underFire = 0;
  private ambientT = 0;
  private ambientTracerT = 0;
  private flareCooldown = 0;
  private tmp = new THREE.Vector3();
  private tmp2 = new THREE.Vector3();
  private missileGeo = new THREE.CylinderGeometry(0.06, 0.06, 1.5, 6).rotateX(Math.PI / 2);
  private missileMat = new THREE.MeshBasicMaterial({ color: 0xdddddd });

  constructor(
    private world: World,
    private rng: RNG,
    private effects: Effects,
    private audio: AudioEngine,
    private hooks: ThreatHooks,
  ) {
    for (const e of world.enemies) this.shooters.push(this.mkShooter(e.pos, e.kind, false));
  }

  private mkShooter(pos: THREE.Vector3, kind: EnemyKind, temp: boolean): Shooter {
    return { pos: pos.clone().add(new THREE.Vector3(0, 1.6, 0)), kind, cooldown: this.rng.range(2, 8), burst: 0, burstT: 0, los: false, losT: this.rng.next(), temp };
  }

  /** Activate (or stand down) enemy activity around a site. */
  setHotZone(site: Site, on: boolean) {
    if (!on) {
      const z = this.hotZones.get(site.id);
      if (z) this.shooters = this.shooters.filter((s) => !z.temps.includes(s));
      this.hotZones.delete(site.id);
      return;
    }
    if (this.hotZones.has(site.id)) return;
    const temps: Shooter[] = [];
    const n = site.enemySide ? 3 : 2;
    for (let i = 0; i < n; i++) {
      // Enemy positions sit toward the enemy side (+x) of the zone.
      const a = this.rng.range(-1.1, 1.1);
      const r = this.rng.range(260, 480);
      const x = site.x + Math.cos(a) * r;
      const z = site.z + Math.sin(a) * r;
      const y = this.world.terrain.heightAt(x, z);
      temps.push(this.mkShooter(new THREE.Vector3(x, y, z), 'mg', true));
    }
    if (site.enemySide && this.rng.chance(0.5)) {
      const x = site.x + this.rng.range(600, 900);
      const z = site.z + this.rng.range(-300, 300);
      temps.push(this.mkShooter(new THREE.Vector3(x, this.world.terrain.heightAt(x, z), z), 'aa', true));
    }
    this.shooters.push(...temps);
    this.hotZones.set(site.id, { site, timer: this.rng.range(2, 5), temps });
  }

  clearHotZones() {
    for (const [, z] of this.hotZones) this.setHotZone(z.site, false);
  }

  dropFlares(heli: Heli): boolean {
    if (this.flareCooldown > 0 || heli.flares <= 0 || heli.crashed) return false;
    this.flareCooldown = 0.5;
    const n = Math.min(2, heli.flares);
    heli.flares -= n;
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(heli.fm.quat);
    for (let i = 0; i < n; i++) {
      const side = i % 2 ? 1 : -1;
      this.flares.push({
        p: heli.fm.pos.clone().addScaledVector(right, side * 2).add(new THREE.Vector3(0, -1, 2)),
        v: heli.fm.vel.clone().multiplyScalar(0.85).addScaledVector(right, side * 18).add(new THREE.Vector3(0, -4, 0)),
        life: 3.2,
      });
    }
    // Each salvo has a good chance to decoy every inbound missile.
    for (const m of this.missiles) if (!m.target && this.rng.chance(0.65)) m.target = this.flares[this.flares.length - 1];
    this.audio.flare();
    return true;
  }

  update(dt: number, heli: Heli, camPos: THREE.Vector3) {
    const fm = heli.fm;
    const hp = fm.pos;
    const terrain = this.world.terrain;
    this.flareCooldown -= dt;
    this.underFire = Math.max(0, this.underFire - dt);
    const alive = !heli.crashed;

    // --- Shooters -------------------------------------------------------
    const heliSide = this.world.front.side(hp.x, hp.z);
    for (const s of this.shooters) {
      const dist = s.pos.distanceTo(hp);
      if (dist > RANGE[s.kind] || !alive || (!s.temp && heliSide < REACH[s.kind])) {
        s.burst = 0;
        continue;
      }
      s.losT -= dt;
      if (s.losT <= 0) {
        s.losT = 0.5;
        s.los = terrain.lineOfSight(s.pos.x, s.pos.y + 0.5, s.pos.z, hp.x, hp.y, hp.z, 30);
      }
      if (!s.los) {
        s.burst = 0;
        continue;
      }
      s.cooldown -= dt;
      if (s.kind === 'manpads') {
        if (s.cooldown <= 0 && fm.agl > 5) {
          s.cooldown = this.rng.range(28, 45);
          this.launchMissile(s.pos);
        }
        continue;
      }
      if (s.burst <= 0 && s.cooldown <= 0) {
        s.burst = s.kind === 'aa' ? this.rng.int(6, 10) : this.rng.int(12, 22);
        s.cooldown = s.kind === 'aa' ? this.rng.range(2.5, 4.5) : this.rng.range(1.5, 3.5);
        this.audio.gunshot(s.pos.distanceTo(camPos), s.kind === 'aa');
      }
      if (s.burst > 0) {
        s.burstT -= dt;
        while (s.burstT <= 0 && s.burst > 0) {
          s.burstT += s.kind === 'aa' ? 0.11 : 0.075;
          s.burst--;
          this.fire(s, heli, dist);
        }
      }
    }

    // --- Bullets --------------------------------------------------------
    const axisA = this.tmp.set(0, 0, -7).applyQuaternion(fm.quat).add(hp);
    const axisB = this.tmp2.set(0, 0.5, 7).applyQuaternion(fm.quat).add(hp);
    for (let i = this.bullets.length - 1; i >= 0; i--) {
      const b = this.bullets[i];
      const p0 = b.p.clone();
      b.v.y -= 4 * dt;
      b.p.addScaledVector(b.v, dt);
      b.life -= dt;
      let dead = b.life <= 0;
      if (!dead && alive && p0.distanceToSquared(hp) < 160 * 160) {
        if (segSegDist(p0, b.p, axisA, axisB) < 2.3) {
          dead = true;
          heli.damage(b.dmg, 'Ground fire');
          this.hooks.onHit(b.dmg);
          this.effects.sparks(b.p, 8);
          this.audio.hit();
          this.underFire = 3;
        }
      }
      if (!dead && b.p.y < terrain.heightAt(b.p.x, b.p.z)) {
        dead = true;
        if (b.p.distanceToSquared(camPos) < 1500 * 1500) this.effects.impactPuff(b.p);
      }
      if (dead) this.bullets.splice(i, 1);
    }

    // --- Missiles & flares ---------------------------------------------
    for (let i = this.flares.length - 1; i >= 0; i--) {
      const f = this.flares[i];
      f.v.y -= 9.8 * dt;
      f.v.multiplyScalar(Math.exp(-1.2 * dt));
      f.p.addScaledVector(f.v, dt);
      f.life -= dt;
      this.effects.fire.emit({ x: f.p.x, y: f.p.y, z: f.p.z, life: 0.25, size0: 3.5, size1: 1, r: 2, g: 1.7, b: 1.1, alpha: 1, fadeIn: 0.01 });
      this.effects.smoke.emit({ x: f.p.x, y: f.p.y, z: f.p.z, life: 2.5, size0: 1, size1: 4, r: 0.85, g: 0.85, b: 0.85, alpha: 0.35, drag: 1.5 });
      if (f.life <= 0) this.flares.splice(i, 1);
    }
    let warning = false;
    for (let i = this.missiles.length - 1; i >= 0; i--) {
      const m = this.missiles[i];
      m.life -= dt;
      m.speed = Math.min(520, m.speed + 300 * dt);
      const tgt = m.target && this.flares.includes(m.target) ? m.target.p : m.target ? null : hp;
      if (tgt) {
        const tgo = m.p.distanceTo(tgt) / m.speed;
        const lead = m.target ? tgt.clone() : tgt.clone().addScaledVector(fm.vel, tgo * 0.9);
        const want = lead.sub(m.p).normalize();
        const cur = m.v.clone().normalize();
        const ang = cur.angleTo(want);
        const maxTurn = 1.4 * dt;
        if (ang > 1e-4) cur.lerp(want, Math.min(1, maxTurn / ang)).normalize();
        m.v.copy(cur).multiplyScalar(m.speed);
      }
      m.p.addScaledVector(m.v, dt);
      m.mesh.position.copy(m.p);
      m.mesh.lookAt(this.tmp.copy(m.p).add(m.v));
      this.effects.smoke.emit({ x: m.p.x, y: m.p.y, z: m.p.z, life: 3, size0: 1.2, size1: 5, r: 0.9, g: 0.9, b: 0.88, alpha: 0.6, drag: 1, buoyancy: 0.3 });
      this.effects.fire.emit({ x: m.p.x, y: m.p.y, z: m.p.z, life: 0.08, size0: 2.5, size1: 1, r: 2, g: 1.5, b: 0.8, alpha: 1, fadeIn: 0.01 });
      if (!m.target) warning = true;
      let boom = m.life <= 0 || m.p.y < terrain.heightAt(m.p.x, m.p.z);
      if (!boom && !m.target && alive && m.p.distanceTo(hp) < 9) {
        boom = true;
        heli.damage(48, 'Missile');
        this.hooks.onHit(48);
        this.audio.hit();
      }
      if (!boom && m.target && m.p.distanceTo(m.target.p) < 6) boom = true;
      if (boom) {
        this.effects.explosion(m.p, 0.6);
        this.audio.explosion(m.p.distanceTo(camPos), 0.7);
        this.group.remove(m.mesh);
        this.missiles.splice(i, 1);
      }
    }
    this.missileWarning = warning;
    this.audio.setMissileWarning(warning && alive);

    // --- Hot zones: mortar harassment --------------------------------
    for (const [, z] of this.hotZones) {
      const d = Math.hypot(hp.x - z.site.x, hp.z - z.site.z);
      if (d > 1000) continue;
      z.timer -= dt;
      if (z.timer <= 0) {
        z.timer = this.rng.range(3, 8);
        const x = z.site.x + this.rng.gauss() * 55;
        const zz = z.site.z + this.rng.gauss() * 55;
        const at = new THREE.Vector3(x, terrain.heightAt(x, zz), zz);
        this.effects.explosion(at, 0.9);
        this.audio.explosion(at.distanceTo(camPos), 0.9);
        const dh = at.distanceTo(hp);
        if (dh < 16 && alive) {
          const dmg = (1 - dh / 16) * 22;
          heli.damage(dmg, 'Mortar');
          this.hooks.onHit(dmg);
        }
      }
    }

    this.updateAmbient(dt, camPos);
  }

  private fire(s: Shooter, heli: Heli, dist: number) {
    const fm = heli.fm;
    const speed = s.kind === 'aa' ? 950 : 820;
    const tof = dist / speed;
    const aim = fm.pos.clone().addScaledVector(fm.vel, tof * this.rng.range(0.75, 1.1));
    const dir = aim.sub(s.pos).normalize();
    // Harder to hit fast, low movers; easier to hit a hovering target.
    const spread = (s.kind === 'aa' ? 0.011 : 0.017) * (1 + fm.groundSpeed / 30) + 0.004 + (fm.agl < 25 ? 0.006 : 0);
    dir.x += this.rng.gauss() * spread;
    dir.y += this.rng.gauss() * spread + 0.002;
    dir.z += this.rng.gauss() * spread;
    dir.normalize();
    const v = dir.multiplyScalar(speed);
    const p = s.pos.clone();
    this.bullets.push({ p, v, life: 3, dmg: s.kind === 'aa' ? 3.2 : 0.8 });
    this.effects.tracer(p, v, 3, s.kind === 'aa' ? 0xffb050 : 0x7dff6a);
    this.effects.fire.emit({ x: p.x, y: p.y, z: p.z, life: 0.06, size0: 2, size1: 1, r: 2, g: 1.6, b: 0.6, alpha: 1, fadeIn: 0.01 });
  }

  private launchMissile(from: THREE.Vector3) {
    const mesh = new THREE.Mesh(this.missileGeo, this.missileMat);
    this.group.add(mesh);
    this.missiles.push({ p: from.clone().add(new THREE.Vector3(0, 1.5, 0)), v: new THREE.Vector3(0, 60, 0), life: 11, target: null, speed: 60, mesh });
    this.hooks.toast('MISSILE LAUNCH — deploy flares [F] and break hard!', 'bad');
  }

  /** Distant artillery and harmless exchange of fire along the line. */
  private updateAmbient(dt: number, camPos: THREE.Vector3) {
    const front = this.world.front;
    const terrain = this.world.terrain;
    this.ambientT -= dt;
    if (this.ambientT <= 0) {
      this.ambientT = this.rng.range(1.2, 4);
      const z = clamp(camPos.z + this.rng.range(-2500, 2500), -3000, 3000);
      const x = front.x(z) + this.rng.gauss() * 220;
      const at = new THREE.Vector3(x, terrain.heightAt(x, z), z);
      const d = at.distanceTo(camPos);
      if (d > 250) {
        this.effects.explosion(at, this.rng.range(0.8, 1.6), d < 2500);
        this.audio.explosion(d, 1.2);
      }
    }
    this.ambientTracerT -= dt;
    if (this.ambientTracerT <= 0) {
      this.ambientTracerT = this.rng.range(0.6, 2.2);
      const z = clamp(camPos.z + this.rng.range(-1800, 1800), -3000, 3000);
      const fx = front.x(z);
      const friendly = this.rng.chance(0.5);
      const ax = fx + (friendly ? -1 : 1) * this.rng.range(80, 250);
      const az = z + this.rng.range(-60, 60);
      const a = new THREE.Vector3(ax, terrain.heightAt(ax, az) + 1.5, az);
      if (a.distanceTo(camPos) > 3500) return;
      const bx = fx + (friendly ? 1 : -1) * this.rng.range(80, 250);
      const bz = z + this.rng.range(-80, 80);
      const b = new THREE.Vector3(bx, terrain.heightAt(bx, bz) + 1.5, bz);
      const dir = b.sub(a).normalize();
      const n = this.rng.int(4, 10);
      for (let i = 0; i < n; i++) {
        const v = dir.clone().add(new THREE.Vector3(this.rng.gauss() * 0.02, this.rng.gauss() * 0.02 + 0.01, this.rng.gauss() * 0.02)).multiplyScalar(700);
        this.effects.tracer(a.clone().addScaledVector(v, -i * 0.07), v, 0.9, friendly ? 0xff5a3a : 0x7dff6a);
      }
      this.audio.gunshot(a.distanceTo(camPos), false);
    }
  }
}

/** Distance between two line segments (approximate, sampled). */
function segSegDist(a0: THREE.Vector3, a1: THREE.Vector3, b0: THREE.Vector3, b1: THREE.Vector3): number {
  let best = Infinity;
  const p = new THREE.Vector3();
  const line = new THREE.Line3(b0, b1);
  const q = new THREE.Vector3();
  for (let i = 0; i <= 8; i++) {
    p.lerpVectors(a0, a1, i / 8);
    line.closestPointToPoint(p, true, q);
    best = Math.min(best, p.distanceTo(q));
  }
  return best;
}
