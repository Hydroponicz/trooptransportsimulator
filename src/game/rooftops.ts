import * as THREE from 'three';
import type { World } from '../world/worldgen';
import type { Town } from '../world/towns';
import { colliderTop, type AABB } from '../world/colliders';
import type { Site } from '../world/sites';

/** Flat-roofed buildings tall enough to be worth a rooftop insertion, and what to call them. */
const ROOF_LABEL: Record<string, string> = {
  block9: 'apartment block',
  tower16: 'tower block',
  stalinka: 'old apartment block',
  shops: 'shopping block',
  office: 'office building',
  school: 'school',
  apartment: 'apartment building',
  warehouse: 'warehouse',
  ruin_apartment: 'ruined apartment block',
};

/** A flat, clear patch on a roof: where a team is put down. */
export interface Rooftop {
  id: number;
  town: Town;
  x: number;
  z: number;
  /** Roof deck height. */
  y: number;
  /** Radius of the clear, flat patch around (x, z). */
  clear: number;
  tag: string;
}

/**
 * Finds rooftop drop points in towns: the deck of a tall flat-roofed
 * building (the most common top over its footprint, so lift rooms and
 * parapets don't count), and on it the spot with the most clear, flat room
 * around it. Worked out per building on first use.
 */
export class Rooftops {
  private byTown: Map<Town, AABB[]> | null = null;
  private found = new Map<AABB, Rooftop | null>();
  private nextId = 0;

  constructor(private world: World) {}

  private buildings(t: Town): AABB[] {
    if (!this.byTown) {
      this.byTown = new Map(this.world.towns.map((tw) => [tw, [] as AABB[]]));
      for (const b of this.world.colliders.all()) {
        if (!b.tag || !(b.tag in ROOF_LABEL)) continue;
        const cx = (b.minX + b.maxX) / 2;
        const cz = (b.minZ + b.maxZ) / 2;
        let best: Town | null = null;
        let bd = Infinity;
        for (const tw of this.world.towns) {
          const d = Math.hypot(tw.x - cx, tw.z - cz);
          if (d < tw.r * 1.15 && d < bd) (bd = d), (best = tw);
        }
        if (best) this.byTown.get(best)!.push(b);
      }
    }
    return this.byTown.get(t) ?? [];
  }

  /** Does the town have any candidate buildings at all? */
  hasRoofs(t: Town) {
    return this.buildings(t).length > 0;
  }

  /** A usable rooftop in the town with at least `minClear` metres of clear roof around the drop point. */
  pick(t: Town, rnd: () => number, minClear = 3): Rooftop | null {
    const list = this.buildings(t);
    for (let tries = 0; tries < 8 && list.length; tries++) {
      const r = this.roofOf(list[Math.floor(rnd() * list.length)], t);
      if (r && r.clear >= minClear) return r;
    }
    return null;
  }

  private roofOf(b: AABB, t: Town): Rooftop | null {
    const cached = this.found.get(b);
    if (cached !== undefined) return cached;
    const top = (x: number, z: number) => colliderTop(b, x, z, b.maxY + 0.5);
    const ground = this.world.terrain.heightAt((b.minX + b.maxX) / 2, (b.minZ + b.maxZ) / 2);
    // The deck: the most common top over the footprint (at least two storeys up).
    const pts: [number, number, number][] = [];
    const counts = new Map<number, number>();
    for (let x = b.minX + 1; x < b.maxX; x += 2)
      for (let z = b.minZ + 1; z < b.maxZ; z += 2) {
        const y = top(x, z);
        if (y < ground + 6) continue;
        pts.push([x, z, y]);
        const k = Math.round(y * 4);
        counts.set(k, (counts.get(k) ?? 0) + 1);
      }
    let level = -Infinity;
    let n = 0;
    for (const [k, c] of counts) if (c > n) (n = c), (level = k / 4);
    // The point on the deck with the widest clear, level circle around it.
    let best: { x: number; z: number; clear: number } | null = null;
    for (const [x, z, y] of pts) {
      if (Math.abs(y - level) > 0.15) continue;
      let clear = 0;
      for (let r = 1; r <= 7; r++) {
        let ok = true;
        for (let i = 0; i < 12 && ok; i++) {
          const a = (i / 12) * Math.PI * 2;
          if (Math.abs(top(x + Math.cos(a) * r, z + Math.sin(a) * r) - level) > 0.2) ok = false;
        }
        if (!ok) break;
        clear = r;
      }
      if (!best || clear > best.clear) best = { x, z, clear };
    }
    const out = best && best.clear >= 2 ? { id: this.nextId++, town: t, x: best.x, z: best.z, y: level, clear: best.clear, tag: b.tag! } : null;
    this.found.set(b, out);
    return out;
  }

  /** Is this point on the roof (at deck height, give or take a step)? */
  onRoof(r: Rooftop, x: number, z: number): boolean {
    return Math.abs(this.world.colliders.topAt(x, z, r.y + 0.6) - r.y) < 0.4;
  }

  /** A site-like target for the mission system: one "pad" on the roof, nothing to walk to. */
  site(r: Rooftop): Site {
    const p = new THREE.Vector3(r.x, r.y, r.z);
    const fd = this.world.front.side(r.x, r.z);
    return {
      id: 900000 + r.id,
      name: `${r.town.name} ${ROOF_LABEL[r.tag] ?? 'building'} roof`,
      kind: 'lz',
      x: r.x,
      z: r.z,
      y: r.y,
      rot: 0,
      radius: r.clear,
      pads: [p],
      waits: [p.clone()],
      enemySide: fd > 0,
      frontDist: fd,
      services: { fuel: false, repair: false, hangar: false, flares: false },
      facilities: [],
    };
  }
}

/** Fought over: the town straddles the front, or the front runs close by. */
export function battleZone(world: World, t: Town): boolean {
  return t.contested || Math.abs(world.front.side(t.x, t.z)) < 900;
}
