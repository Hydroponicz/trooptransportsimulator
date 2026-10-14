import type * as THREE from 'three';

export interface AABB {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
  /** Blocks rotors but not wheels (bridge decks). */
  soft?: boolean;
}

const CELL = 64;

/** Static axis-aligned boxes for structures, bucketed in a coarse grid. */
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

  /** Returns the box containing p (with margin), if any. */
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
        p.z < b.maxZ + margin
      )
        return b;
    }
    return null;
  }

  /** Highest box top under a point (for things resting on structures), or -Infinity. */
  topAt(x: number, z: number, belowY: number): number {
    const arr = this.grid.get(this.key(Math.floor(x / CELL), Math.floor(z / CELL)));
    let best = -Infinity;
    if (!arr) return best;
    for (const b of arr) {
      if (x > b.minX && x < b.maxX && z > b.minZ && z < b.maxZ && b.maxY <= belowY + 0.5) best = Math.max(best, b.maxY);
    }
    return best;
  }
}
