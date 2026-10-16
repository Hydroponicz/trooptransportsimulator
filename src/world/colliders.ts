import * as THREE from 'three';

export interface AABB {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
  /** Blocks rotors but not wheels (bridge decks). */
  soft?: boolean;
  /** What it is (prototype name), for debugging. */
  tag?: string;
  /**
   * The structure's real shape: solid parts in the prototype's own frame, and
   * the placement that maps the world into that frame. Without it the box is
   * solid all through.
   */
  solids?: Solid[];
  place?: Placement;
}

/** Shape of a solid part. */
export const enum SolidKind {
  Box = 0,
  /** Upright cylinder filling the box's footprint circle. */
  Cylinder = 1,
  /** Half cylinder lying along local Z, its axis along the bottom of the box (a hangar). */
  Arch = 2,
  /** Walls up to `k` of the height, then a ridge along local Z (gables, tents). */
  Gable = 3,
}

/** One solid part of a prototype: an oriented box (or shape inside it) in the prototype's frame. */
export interface Solid {
  kind: SolidKind;
  /** Centre. */
  cx: number;
  cy: number;
  cz: number;
  /** Box axes (unit columns of its rotation), row-major 3×3: x axis = r[0], r[3], r[6]. */
  r: number[];
  hx: number;
  hy: number;
  hz: number;
  /** Gable: fraction of the height that is vertical wall. */
  k: number;
}

/** World → prototype frame for a placement turned about Y and scaled. */
export interface Placement {
  x: number;
  y: number;
  z: number;
  c: number;
  s: number;
  isx: number;
  isy: number;
  isz: number;
}

const CELL = 64;
const _l = new THREE.Vector3();

/** Is the prototype-frame point inside the solid (grown by margin)? */
function inSolid(o: Solid, px: number, py: number, pz: number, m: number): boolean {
  const dx = px - o.cx;
  const dy = py - o.cy;
  const dz = pz - o.cz;
  const r = o.r;
  const ax = dx * r[0] + dy * r[3] + dz * r[6];
  const ay = dx * r[1] + dy * r[4] + dz * r[7];
  const az = dx * r[2] + dy * r[5] + dz * r[8];
  if (Math.abs(ax) > o.hx + m || Math.abs(ay) > o.hy + m || Math.abs(az) > o.hz + m) return false;
  switch (o.kind) {
    case SolidKind.Cylinder: {
      const rr = Math.max(o.hx, o.hz) + m;
      return ax * ax + az * az < rr * rr;
    }
    case SolidKind.Arch: {
      const yb = ay + o.hy;
      const rr = o.hx + m;
      return ax * ax + yb * yb < rr * rr;
    }
    case SolidKind.Gable: {
      const yn = (ay + o.hy) / (2 * o.hy);
      if (yn <= o.k) return true;
      return Math.abs(ax) <= (o.hx * (1 - yn)) / (1 - o.k) + m;
    }
    default:
      return true;
  }
}

/**
 * Top of a solid at a point of the prototype frame (its upper surface there),
 * or -Infinity when the point is outside its footprint. Tilted parts (pitched
 * roof planes) aren't something to stand on and are skipped.
 */
function solidTop(o: Solid, px: number, pz: number): number {
  const r = o.r;
  // Upright only: the solid's own y axis along the prototype's.
  if (r[4] < 0.999) return -Infinity;
  const dx = px - o.cx;
  const dz = pz - o.cz;
  const ax = dx * r[0] + dz * r[6];
  const az = dx * r[2] + dz * r[8];
  if (Math.abs(ax) > o.hx || Math.abs(az) > o.hz) return -Infinity;
  const bottom = o.cy - o.hy;
  switch (o.kind) {
    case SolidKind.Cylinder: {
      const rr = Math.max(o.hx, o.hz);
      return ax * ax + az * az < rr * rr ? o.cy + o.hy : -Infinity;
    }
    case SolidKind.Arch:
      return bottom + Math.sqrt(Math.max(0, o.hx * o.hx - ax * ax));
    case SolidKind.Gable: {
      const wall = 2 * o.hy * o.k;
      return bottom + wall + (2 * o.hy - wall) * (1 - Math.abs(ax) / o.hx);
    }
    default:
      return o.cy + o.hy;
  }
}

/** The highest top of one structure under (x, z), no higher than maxY, or -Infinity. */
export function colliderTop(b: AABB, x: number, z: number, maxY: number): number {
  if (x < b.minX || x > b.maxX || z < b.minZ || z > b.maxZ || b.minY > maxY) return -Infinity;
  if (!b.solids || !b.place) return b.maxY <= maxY ? b.maxY : -Infinity;
  const P = b.place;
  const dx = x - P.x;
  const dz = z - P.z;
  const lx = (P.c * dx - P.s * dz) * P.isx;
  const lz = (P.s * dx + P.c * dz) * P.isz;
  let best = -Infinity;
  for (const o of b.solids) {
    const t = P.y + solidTop(o, lx, lz) / P.isy;
    if (t <= maxY && t > best) best = t;
  }
  return best;
}

/** Is the world point inside the collider's actual shape (grown by margin)? */
export function inShape(b: AABB, p: THREE.Vector3, margin = 0): boolean {
  if (!b.solids || !b.place) return true;
  const P = b.place;
  const dx = p.x - P.x;
  const dz = p.z - P.z;
  _l.set((P.c * dx - P.s * dz) * P.isx, (p.y - P.y) * P.isy, (P.s * dx + P.c * dz) * P.isz);
  const m = margin * Math.max(P.isx, P.isy, P.isz);
  for (const o of b.solids) if (inSolid(o, _l.x, _l.y, _l.z, m)) return true;
  return false;
}

/** Static structures, bucketed in a coarse grid: a bounding box each, and the real shape where known. */
export class ColliderSet {
  private grid = new Map<number, AABB[]>();
  count = 0;

  private key(cx: number, cz: number) {
    return (cx + 512) + (cz + 512) * 1024;
  }

  add(b: AABB) {
    this.count++;
    for (let cx = Math.floor(b.minX / CELL); cx <= Math.floor(b.maxX / CELL); cx++)
      for (let cz = Math.floor(b.minZ / CELL); cz <= Math.floor(b.maxZ / CELL); cz++) {
        const k = this.key(cx, cz);
        let arr = this.grid.get(k);
        if (!arr) this.grid.set(k, (arr = []));
        arr.push(b);
      }
  }

  remove(b: AABB) {
    for (const [k, arr] of this.grid) {
      const i = arr.indexOf(b);
      if (i >= 0) {
        arr.splice(i, 1);
        if (!arr.length) this.grid.delete(k);
      }
    }
    this.count--;
  }

  /**
   * The highest structure top under (x, z) that is no higher than `maxY`
   * (a roof, a loading dock, the top of a wall), for things that stand or
   * land on buildings; -Infinity where there is none. Bridge decks don't
   * count (roads.ts carries those).
   */
  topAt(x: number, z: number, maxY: number): number {
    const arr = this.grid.get(this.key(Math.floor(x / CELL), Math.floor(z / CELL)));
    let best = -Infinity;
    if (!arr) return best;
    for (const b of arr) if (!b.soft) best = Math.max(best, colliderTop(b, x, z, maxY));
    return best;
  }

  /** Every collider once (for picking buildings by type). */
  *all(): Generator<AABB> {
    const seen = new Set<AABB>();
    for (const arr of this.grid.values())
      for (const b of arr)
        if (!seen.has(b)) {
          seen.add(b);
          yield b;
        }
  }

  /** Returns the structure containing p (with margin), if any. */
  hit(p: THREE.Vector3, margin = 0, solidOnly = false): AABB | null {
    const arr = this.grid.get(this.key(Math.floor(p.x / CELL), Math.floor(p.z / CELL)));
    if (!arr) return null;
    for (const b of arr) {
      if (solidOnly && b.soft) continue;
      if (
        p.x > b.minX - margin &&
        p.x < b.maxX + margin &&
        p.y > b.minY - margin &&
        p.y < b.maxY + margin &&
        p.z > b.minZ - margin &&
        p.z < b.maxZ + margin &&
        inShape(b, p, margin)
      )
        return b;
    }
    return null;
  }
}
