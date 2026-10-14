import * as THREE from 'three';
import type { RNG } from '../util/noise';
import type { Terrain } from './terrain';

const GRID = 50;

interface Seg {
  ax: number;
  az: number;
  bx: number;
  bz: number;
}

/** Dirt roads connecting sites. Also answers "how far is this point from a road". */
export class Roads {
  readonly paths: THREE.Vector2[][] = [];
  private grid = new Map<number, Seg[]>();
  group = new THREE.Group();

  constructor(private terrain: Terrain) {}

  add(ax: number, az: number, bx: number, bz: number, rng: RNG) {
    let pts = [new THREE.Vector2(ax, az), new THREE.Vector2(bx, bz)];
    for (let depth = 0; depth < 5; depth++) {
      const next: THREE.Vector2[] = [pts[0]];
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1];
        const b = pts[i];
        const len = a.distanceTo(b);
        const mid = a.clone().add(b).multiplyScalar(0.5);
        const perp = new THREE.Vector2(-(b.y - a.y), b.x - a.x).normalize();
        mid.addScaledVector(perp, rng.gauss() * len * 0.1);
        next.push(mid, b);
      }
      pts = next;
    }
    const curve = new THREE.SplineCurve(pts);
    const total = curve.getLength();
    const samples = curve.getSpacedPoints(Math.max(4, Math.floor(total / 7)));
    this.paths.push(samples);
    for (let i = 1; i < samples.length; i++) this.index({ ax: samples[i - 1].x, az: samples[i - 1].y, bx: samples[i].x, bz: samples[i].y });
  }

  private index(s: Seg) {
    const m = 12;
    for (let cx = Math.floor((Math.min(s.ax, s.bx) - m) / GRID); cx <= Math.floor((Math.max(s.ax, s.bx) + m) / GRID); cx++)
      for (let cz = Math.floor((Math.min(s.az, s.bz) - m) / GRID); cz <= Math.floor((Math.max(s.az, s.bz) + m) / GRID); cz++) {
        const k = cx + 1000 + (cz + 1000) * 3000;
        let arr = this.grid.get(k);
        if (!arr) this.grid.set(k, (arr = []));
        arr.push(s);
      }
  }

  distance(x: number, z: number): number {
    const arr = this.grid.get(Math.floor(x / GRID) + 1000 + (Math.floor(z / GRID) + 1000) * 3000);
    if (!arr) return Infinity;
    let best = Infinity;
    for (const s of arr) {
      const dx = s.bx - s.ax;
      const dz = s.bz - s.az;
      const l2 = dx * dx + dz * dz || 1;
      const t = Math.max(0, Math.min(1, ((x - s.ax) * dx + (z - s.az) * dz) / l2));
      best = Math.min(best, Math.hypot(x - (s.ax + dx * t), z - (s.az + dz * t)));
    }
    return best;
  }

  build(): THREE.Group {
    const mat = new THREE.MeshLambertMaterial({
      vertexColors: true,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });
    const base = new THREE.Color(0x8c7854);
    for (const path of this.paths) {
      const W = 6;
      const n = path.length;
      const pos = new Float32Array(n * 2 * 3);
      const col = new Float32Array(n * 2 * 3);
      const idx: number[] = [];
      for (let i = 0; i < n; i++) {
        const p = path[i];
        const a = path[Math.max(0, i - 1)];
        const b = path[Math.min(n - 1, i + 1)];
        const tx = b.x - a.x;
        const tz = b.y - a.y;
        const tl = Math.hypot(tx, tz) || 1;
        const nx = -tz / tl;
        const nz = tx / tl;
        for (let s = 0; s < 2; s++) {
          const side = s === 0 ? 1 : -1;
          const x = p.x + nx * side * W * 0.5;
          const z = p.y + nz * side * W * 0.5;
          const j = (i * 2 + s) * 3;
          pos[j] = x;
          pos[j + 1] = Math.max(this.terrain.heightAt(x, z), this.terrain.heightAt(p.x, p.y) - 0.5) + 0.12;
          pos[j + 2] = z;
          const v = 0.9 + Math.random() * 0.15;
          col[j] = base.r * v;
          col[j + 1] = base.g * v;
          col[j + 2] = base.b * v;
        }
        if (i > 0) {
          const a0 = (i - 1) * 2;
          const b0 = i * 2;
          idx.push(a0, b0, a0 + 1, a0 + 1, b0, b0 + 1);
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
      geo.setIndex(idx);
      geo.computeVertexNormals();
      // Make sure the strip faces up regardless of winding.
      const nr = geo.getAttribute('normal');
      if (nr.count && nr.getY(0) < 0) {
        geo.setIndex(idx.map((_, k) => idx[k - (k % 3) + (2 - (k % 3))]));
        geo.computeVertexNormals();
      }
      const mesh = new THREE.Mesh(geo, mat);
      mesh.receiveShadow = true;
      this.group.add(mesh);
    }
    return this.group;
  }
}
