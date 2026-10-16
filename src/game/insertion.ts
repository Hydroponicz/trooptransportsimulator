import * as THREE from 'three';
import type { World } from '../world/worldgen';
import type { Town } from '../world/towns';
import type { Site } from '../world/sites';
import { PLAY_HALF } from '../world/terrain';

/** A place to fast-rope troops into, with how much clear room it has. */
export interface InsertPoint {
  id: number;
  name: string;
  kind: 'plaza' | 'park' | 'street' | 'front' | 'lz';
  x: number;
  z: number;
  /** Ground height at the point. */
  y: number;
  /** Radius clear of buildings and trees, from the ground up through the rotor's height. */
  r: number;
  town?: Town;
  /** In a battle zone: under fire while the ropes are out. */
  hot: boolean;
}

const KIND_LABEL: Record<InsertPoint['kind'], string> = {
  plaza: 'town square',
  park: 'park',
  street: 'street junction',
  front: 'forward position',
  lz: 'landing zone',
};

/**
 * Fast-rope insertion points: the squares, park lawns and wide street
 * junctions in towns, positions just behind the friendly line in the sector
 * battles, and the landing zones. Each is checked for a column of clear air
 * (no buildings, poles or trees from the ground up to rotor height).
 */
export class Insertions {
  private nextId = 0;
  private v = new THREE.Vector3();

  constructor(
    private world: World,
    private battleZone: (t: Town) => boolean,
    private sectorName: (z: number) => string,
  ) {}

  /** The largest radius (up to maxR) around (x, z) with nothing solid from 1 to 24 m above the ground. */
  clearRadius(x: number, z: number, maxR: number): number {
    const { colliders, vegetation, terrain } = this.world;
    const blocked = (px: number, pz: number) => {
      const g = terrain.heightAt(px, pz);
      for (const h of [1.2, 4, 9, 16, 24]) {
        this.v.set(px, g + h, pz);
        if (colliders.hit(this.v) || vegetation.hit(this.v)) return true;
      }
      return false;
    };
    if (blocked(x, z)) return 0;
    let clear = 0;
    for (let r = 1; r <= maxR; r++) {
      const n = Math.max(8, Math.round(r * 2));
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        if (blocked(x + Math.cos(a) * r, z + Math.sin(a) * r)) return clear;
      }
      clear = r;
    }
    return clear;
  }

  private point(kind: InsertPoint['kind'], x: number, z: number, r: number, hot: boolean, name: string, town?: Town): InsertPoint {
    return { id: this.nextId++, name, kind, x, z, y: this.world.terrain.heightAt(x, z), r, town, hot };
  }

  /**
   * A square, park or junction in the town with room for the ropes (at least
   * 3.5 m clear). Parks and squares are picked more often than junctions
   * (there are far more junctions).
   */
  inTown(t: Town, rnd: () => number): InsertPoint | null {
    const spots = t.spots ?? [];
    const byKind = (k: InsertPoint['kind']) => spots.filter((s) => s.kind === k);
    for (let tries = 0; tries < 6 && spots.length; tries++) {
      const roll = rnd();
      let pool = byKind(roll < 0.4 ? 'park' : roll < 0.7 ? 'plaza' : 'street');
      if (!pool.length) pool = spots;
      const s = pool[Math.floor(rnd() * pool.length)];
      const r = this.clearRadius(s.x, s.z, Math.min(14, Math.ceil(s.r)));
      if (r >= 3.5) return this.point(s.kind, s.x, s.z, r, this.battleZone(t), `${t.name} ${KIND_LABEL[s.kind]}`, t);
    }
    return null;
  }

  /**
   * Open, level ground 480–700 m behind the friendly line, somewhere along the
   * front: within the battle's machine guns, beyond the reach of its missiles
   * and AA guns.
   */
  atFront(rnd: () => number): InsertPoint | null {
    const { front, terrain } = this.world;
    for (let tries = 0; tries < 20; tries++) {
      const z = (rnd() * 2 - 1) * (PLAY_HALF - 600);
      const x = front.x(z) - (480 + rnd() * 220);
      if (Math.abs(x) > PLAY_HALF - 300) continue;
      if (terrain.heightAt(x, z) < 2 || terrain.baseSlope(x, z) > 0.15) continue;
      const r = this.clearRadius(x, z, 18);
      if (r >= 8) return this.point('front', x, z, r, true, `${this.sectorName(z)} ${KIND_LABEL.front}`);
    }
    return null;
  }

  /** A landing zone, roped into instead of landed at. */
  atLz(s: Site): InsertPoint | null {
    const p = s.pads[0];
    const r = this.clearRadius(p.x, p.z, 16);
    return r >= 6 ? this.point('lz', p.x, p.z, r, s.enemySide || s.frontDist > -700, `${s.name}`) : null;
  }

  /** A site-like target for the mission system: one "pad" at the point. */
  site(p: InsertPoint): Site {
    const at = new THREE.Vector3(p.x, p.y, p.z);
    const fd = this.world.front.side(p.x, p.z);
    return {
      id: 800000 + p.id,
      name: p.name,
      kind: 'lz',
      x: p.x,
      z: p.z,
      y: p.y,
      rot: 0,
      radius: p.r,
      pads: [at],
      waits: [at.clone()],
      enemySide: fd > 0,
      frontDist: fd,
      services: { fuel: false, repair: false, hangar: false, flares: false },
      facilities: [],
    };
  }
}
