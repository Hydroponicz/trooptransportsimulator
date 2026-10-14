import * as THREE from 'three';
import type { RNG } from '../util/noise';
import { WATER_LEVEL, type Terrain } from './terrain';
import type { ColliderSet } from './colliders';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

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

  /** Road surface height per path sample (bridge decks over water). */
  readonly heights: number[][] = [];

  /** Road surface height at a sample, interpolated (for vehicles). */
  heightOn(path: number, s: number): number {
    const h = this.heights[path];
    const i = Math.max(0, Math.min(h.length - 1, Math.floor(s)));
    const j = Math.min(h.length - 1, i + 1);
    return h[i] + (h[j] - h[i]) * (s - i);
  }

  build(colliders?: ColliderSet): THREE.Group {
    const mat = new THREE.MeshLambertMaterial({
      vertexColors: true,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });
    const concrete = new THREE.MeshLambertMaterial({ color: 0x8f8d86 });
    const base = new THREE.Color(0x8c7854);
    const asphalt = new THREE.Color(0x55534e);
    for (const path of this.paths) {
      const n = path.length;
      const ground = path.map((p) => this.terrain.heightAt(p.x, p.y));
      const road = ground.slice();
      const onBridge = new Array<boolean>(n).fill(false);
      // Find wet stretches and span them with a bridge.
      for (let i = 0; i < n; i++) {
        if (ground[i] >= 1.4) continue;
        let j = i;
        while (j + 1 < n && ground[j + 1] < 1.4) j++;
        const a = Math.max(0, i - 2);
        const b = Math.min(n - 1, j + 2);
        const deck = Math.max(ground[a], ground[b], WATER_LEVEL + 3.2) + 0.4;
        for (let k = a; k <= b; k++) {
          road[k] = deck;
          onBridge[k] = true;
        }
        // Approach ramps.
        for (let k = 1; k <= 5; k++) {
          const t = 1 - k / 6;
          if (a - k >= 0 && !onBridge[a - k]) road[a - k] = Math.max(ground[a - k], ground[a - k] + (deck - ground[a - k]) * t);
          if (b + k < n && !onBridge[b + k]) road[b + k] = Math.max(ground[b + k], ground[b + k] + (deck - ground[b + k]) * t);
        }
        this.buildBridge(path, road, ground, a, b, concrete, colliders);
        i = b;
      }
      this.heights.push(road);

      const W = 6;
      const pos = new Float32Array(n * 2 * 3);
      const col = new Float32Array(n * 2 * 3);
      const idx: number[] = [];
      for (let i = 0; i < n; i++) {
        const p = path[i];
        const pa = path[Math.max(0, i - 1)];
        const pb = path[Math.min(n - 1, i + 1)];
        const tx = pb.x - pa.x;
        const tz = pb.y - pa.y;
        const tl = Math.hypot(tx, tz) || 1;
        const nx = -tz / tl;
        const nz = tx / tl;
        for (let s2 = 0; s2 < 2; s2++) {
          const side = s2 === 0 ? 1 : -1;
          const x = p.x + nx * side * W * 0.5;
          const z = p.y + nz * side * W * 0.5;
          const j = (i * 2 + s2) * 3;
          pos[j] = x;
          pos[j + 1] = onBridge[i] || road[i] > ground[i] + 0.3 ? road[i] + 0.05 : Math.max(this.terrain.heightAt(x, z), road[i] - 0.5) + 0.12;
          pos[j + 2] = z;
          const v = 0.9 + Math.random() * 0.15;
          const c = onBridge[i] ? asphalt : base;
          col[j] = c.r * v;
          col[j + 1] = c.g * v;
          col[j + 2] = c.b * v;
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

  /** Concrete deck, railings and piers between samples a..b. */
  private buildBridge(path: THREE.Vector2[], road: number[], ground: number[], a: number, b: number, mat: THREE.Material, colliders?: ColliderSet) {
    const parts: THREE.BufferGeometry[] = [];
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    for (let i = a; i < b; i++) {
      const p0 = path[i];
      const p1 = path[i + 1];
      const len = p0.distanceTo(p1) + 0.3;
      const ang = Math.atan2(-(p1.y - p0.y), p1.x - p0.x);
      const y = (road[i] + road[i + 1]) / 2;
      const cx = (p0.x + p1.x) / 2;
      const cz = (p0.y + p1.y) / 2;
      q.setFromAxisAngle(up, ang);
      const place = (g: THREE.BufferGeometry, ox: number, oy: number, oz: number) => {
        g.applyQuaternion(q);
        const off = new THREE.Vector3(ox, oy, oz).applyQuaternion(q);
        g.translate(cx + off.x, y + off.y, cz + off.z);
        parts.push(g);
      };
      place(new THREE.BoxGeometry(len, 0.8, 8), 0, -0.35, 0);
      place(new THREE.BoxGeometry(len, 0.9, 0.25), 0, 0.5, 3.9);
      place(new THREE.BoxGeometry(len, 0.9, 0.25), 0, 0.5, -3.9);
      if ((i - a) % 3 === 1) {
        const bottom = Math.min(ground[i], 0) - 3;
        const h = y - 0.7 - bottom;
        if (h > 0.5) place(new THREE.BoxGeometry(1.6, h, 6.5), 0, -0.7 - h / 2, 0);
      }
      colliders?.add({ minX: cx - len / 2 - 4, maxX: cx + len / 2 + 4, minY: y - 1, maxY: y + 1, minZ: cz - len / 2 - 4, maxZ: cz + len / 2 + 4 });
    }
    if (!parts.length) return;
    const g = mergeGeometries(parts.map((x) => x.toNonIndexed()), false)!;
    g.computeVertexNormals();
    const mesh = new THREE.Mesh(g, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.group.add(mesh);
    this.bridgeCount++;
  }

  bridgeCount = 0;
}
