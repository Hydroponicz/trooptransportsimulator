import * as THREE from 'three';
import type { RNG } from '../util/noise';
import { CELL, HALF, SEGS, WATER_LEVEL, type Terrain } from './terrain';
import type { ColliderSet } from './colliders';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { gravelTexture, roadTexture } from '../util/textures';

const GRID = 50;

/** Main supply routes are paved two-lane roads, the rest narrower and rougher. */
export type RoadClass = 'main' | 'secondary' | 'track';
export const ROAD_SPEC: Record<RoadClass, { hw: number; shoulder: number }> = {
  main: { hw: 5, shoulder: 1.6 },
  secondary: { hw: 4.2, shoulder: 1.2 },
  track: { hw: 3.6, shoulder: 0.9 },
};

export interface RailSeg {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  y0: number;
  y1: number;
}
const _near = new Map<number, { d: number; y: number }>();

interface Seg {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  path: number;
  i: number;
}

/** Dirt roads connecting sites. Also answers "how far is this point from a road". */
export class Roads {
  readonly paths: THREE.Vector2[][] = [];
  readonly classes: RoadClass[] = [];
  private grid = new Map<number, Seg[]>();
  group = new THREE.Group();

  constructor(private terrain: Terrain) {}

  /** Half-width of the carriageway of a road. */
  hw(path: number): number {
    return ROAD_SPEC[this.classes[path]].hw;
  }
  /** Half-width including the gravel shoulders (what wheels can drive on). */
  outer(path: number): number {
    const sp = ROAD_SPEC[this.classes[path]];
    return sp.hw + sp.shoulder;
  }

  add(ax: number, az: number, bx: number, bz: number, rng: RNG, cls: RoadClass = 'secondary') {
    this.classes.push(cls);
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
    const pathIndex = this.paths.length - 1;
    for (let i = 1; i < samples.length; i++) this.index({ ax: samples[i - 1].x, az: samples[i - 1].y, bx: samples[i].x, bz: samples[i].y, path: pathIndex, i: i - 1 });
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

  /** Distance to the nearest road other than `skip` (for gaps at junctions). */
  distanceExcept(x: number, z: number, skip: number): number {
    const arr = this.grid.get(Math.floor(x / GRID) + 1000 + (Math.floor(z / GRID) + 1000) * 3000);
    if (!arr) return Infinity;
    let best = Infinity;
    for (const s of arr) {
      if (s.path === skip) continue;
      const dx = s.bx - s.ax;
      const dz = s.bz - s.az;
      const l2 = dx * dx + dz * dz || 1;
      const t = Math.max(0, Math.min(1, ((x - s.ax) * dx + (z - s.az) * dz) / l2));
      best = Math.min(best, Math.hypot(x - (s.ax + dx * t), z - (s.az + dz * t)) - this.outer(s.path));
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

  /** Sample ranges [a, b] of each path that are carried by a bridge. */
  private spans: { a: number; b: number }[][] = [];
  /** Bridge deck segments for vehicles to drive on. */
  readonly decks: { x0: number; z0: number; x1: number; z1: number; y0: number; y1: number; w: number }[] = [];
  /** Roadside guard rails (solid to vehicles), bucketed by grid cell. */
  private railGrid = new Map<number, RailSeg[]>();

  addRail(r: RailSeg) {
    const m = 1;
    for (let cx = Math.floor((Math.min(r.x0, r.x1) - m) / GRID); cx <= Math.floor((Math.max(r.x0, r.x1) + m) / GRID); cx++)
      for (let cz = Math.floor((Math.min(r.z0, r.z1) - m) / GRID); cz <= Math.floor((Math.max(r.z0, r.z1) + m) / GRID); cz++) {
        const k = cx + 1000 + (cz + 1000) * 3000;
        let arr = this.railGrid.get(k);
        if (!arr) this.railGrid.set(k, (arr = []));
        arr.push(r);
      }
  }

  /**
   * Engineer the roads: a smooth, grade-limited profile per road (bridges
   * slope bank to bank), then cut and fill the terrain to match.
   * Must run after sites/towns are flattened and before anything is placed
   * along the roads.
   */
  grade() {
    const MAX_GRADE = 0.085;
    const MIN_DECK = WATER_LEVEL + 3.6;
    for (const path of this.paths) {
      const n = path.length;
      const ground = path.map((p) => this.terrain.heightAt(p.x, p.y));
      const spans: { a: number; b: number }[] = [];
      for (let i = 0; i < n; i++) {
        if (ground[i] >= 1.4) continue;
        let j = i;
        while (j + 1 < n && ground[j + 1] < 1.4) j++;
        spans.push({ a: Math.max(0, i - 2), b: Math.min(n - 1, j + 2) });
        i = j + 2;
      }
      const inSpan = (k: number) => spans.some((sp) => k > sp.a && k < sp.b);
      // Smooth the dry ground profile.
      const road = ground.map((_, i) => {
        if (inSpan(i)) return ground[i];
        let sum = 0;
        let cnt = 0;
        for (let k = Math.max(0, i - 4); k <= Math.min(n - 1, i + 4); k++) {
          if (inSpan(k)) continue;
          sum += ground[k];
          cnt++;
        }
        return cnt ? sum / cnt : ground[i];
      });
      const applyDecks = () => {
        for (const sp of spans) {
          const ya = Math.max(road[sp.a], MIN_DECK);
          const yb = Math.max(road[sp.b], MIN_DECK);
          for (let k = sp.a; k <= sp.b; k++) road[k] = Math.max(MIN_DECK, ya + (yb - ya) * ((k - sp.a) / Math.max(1, sp.b - sp.a)));
        }
      };
      applyDecks();
      // Where this road meets or runs alongside one already graded, it joins
      // at that road's height (no steps at junctions). Viaducts above stay
      // overpasses.
      const pins = path.map((p) => this.joinHeight(p.x, p.y, this.heights.length));
      // Limit the grade in both directions; road ends stay on their plateaus.
      for (let it = 0; it < 4; it++) {
        road[0] = ground[0];
        road[n - 1] = ground[n - 1];
        for (let i = 0; i < n; i++) if (pins[i] !== null) road[i] = pins[i]!;
        for (let i = 1; i < n; i++) {
          const g = MAX_GRADE * path[i].distanceTo(path[i - 1]);
          road[i] = Math.min(road[i - 1] + g, Math.max(road[i - 1] - g, road[i]));
        }
        for (let i = n - 2; i >= 0; i--) {
          const g = MAX_GRADE * path[i].distanceTo(path[i + 1]);
          road[i] = Math.min(road[i + 1] + g, Math.max(road[i + 1] - g, road[i]));
        }
        for (const sp of spans) for (let k = sp.a; k <= sp.b; k++) road[k] = Math.max(road[k], MIN_DECK);
      }
      // Where a pad sits too high or low for the grade limit to reach in time,
      // the last stretch becomes a steeper approach ramp that meets the pad.
      const onPad = path.map((p, i) => i === 0 || i === n - 1 || this.terrain.siteInfluence(p.x, p.y) > 0.6);
      for (let i = 0; i < n; i++) {
        if (onPad[i]) road[i] = ground[i];
        else if (pins[i] !== null) {
          road[i] = pins[i]!;
          onPad[i] = true;
        }
      }
      const STEEP = 0.3;
      for (let it = 0; it < 2; it++) {
        for (let i = 1; i < n; i++) {
          if (onPad[i]) continue;
          const g = STEEP * path[i].distanceTo(path[i - 1]);
          road[i] = Math.min(road[i - 1] + g, Math.max(road[i - 1] - g, road[i]));
        }
        for (let i = n - 2; i >= 0; i--) {
          if (onPad[i]) continue;
          const g = STEEP * path[i].distanceTo(path[i + 1]);
          road[i] = Math.min(road[i + 1] + g, Math.max(road[i + 1] - g, road[i]));
        }
      }
      // Round off the kinks (vertical curves) so grade changes are gradual.
      for (let it = 0; it < 12; it++) {
        const prev = road.slice();
        for (let i = 1; i < n - 1; i++) if (!onPad[i]) road[i] = prev[i - 1] * 0.25 + prev[i] * 0.5 + prev[i + 1] * 0.25;
      }
      for (const sp of spans) for (let k = sp.a; k <= sp.b; k++) road[k] = Math.max(road[k], MIN_DECK);
      // Anything carried well above the ground (valley crossings) becomes a
      // viaduct on piers rather than a tall earth embankment.
      const raised = (k: number) => ground[k] < 1.4 || road[k] - ground[k] > 2.5;
      const bridges: { a: number; b: number }[] = [];
      for (let i = 0; i < n; i++) {
        if (!raised(i)) continue;
        let j = i;
        while (j + 1 < n && raised(j + 1)) j++;
        const a = Math.max(0, i - 1);
        const b = Math.min(n - 1, j + 1);
        if (b - a >= 2) bridges.push({ a, b });
        i = j;
      }
      this.heights.push(road);
      this.spans.push(bridges);
    }
    this.cutAndFill();
  }

  /** Height of an already graded road (index < upto) at a point within 7 m of it, unless it is bridged there. */
  private joinHeight(x: number, z: number, upto: number): number | null {
    const arr = this.grid.get(Math.floor(x / GRID) + 1000 + (Math.floor(z / GRID) + 1000) * 3000);
    if (!arr) return null;
    let best = 7;
    let y: number | null = null;
    for (const s of arr) {
      if (s.path >= upto) continue;
      const dx = s.bx - s.ax;
      const dz = s.bz - s.az;
      const l2 = dx * dx + dz * dz || 1;
      const t = Math.max(0, Math.min(1, ((x - s.ax) * dx + (z - s.az) * dz) / l2));
      const d = Math.hypot(x - (s.ax + dx * t), z - (s.az + dz * t));
      if (d >= best) continue;
      if (this.spans[s.path].some((sp) => s.i >= sp.a && s.i + 1 <= sp.b)) continue;
      const h = this.heights[s.path];
      best = d;
      y = h[s.i] + (h[s.i + 1] - h[s.i]) * t;
    }
    return y;
  }

  /** Blend terrain toward the road profile in a corridor around each road. */
  private cutAndFill() {
    const t = this.terrain;
    const N = SEGS + 1;
    const target = new Float32Array(N * N);
    const weight = new Float32Array(N * N);
    const dist = new Float32Array(N * N).fill(1e9);
    const cutOnly = new Uint8Array(N * N);
    const CORE = 13;
    const EDGE = 32;
    this.paths.forEach((path, pi) => {
      const road = this.heights[pi];
      const spans = this.spans[pi];
      for (let i = 0; i + 1 < path.length; i++) {
        // Under bridges, only cut away ground that would stick up through the
        // deck; abutment segments blend in fully.
        const bridged = spans.some((sp) => i > sp.a && i + 1 < sp.b);
        const a = path[i];
        const b = path[i + 1];
        const x0 = Math.floor((Math.min(a.x, b.x) - EDGE + HALF) / CELL);
        const x1 = Math.ceil((Math.max(a.x, b.x) + EDGE + HALF) / CELL);
        const z0 = Math.floor((Math.min(a.y, b.y) - EDGE + HALF) / CELL);
        const z1 = Math.ceil((Math.max(a.y, b.y) + EDGE + HALF) / CELL);
        const dx = b.x - a.x;
        const dz = b.y - a.y;
        const l2 = dx * dx + dz * dz || 1;
        for (let iz = Math.max(0, z0); iz <= Math.min(SEGS, z1); iz++)
          for (let ix = Math.max(0, x0); ix <= Math.min(SEGS, x1); ix++) {
            const x = -HALF + ix * CELL;
            const z = -HALF + iz * CELL;
            const u = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.y) * dz) / l2));
            const d = Math.hypot(x - (a.x + dx * u), z - (a.y + dz * u));
            if (d > EDGE) continue;
            let w = d < CORE ? 1 : 1 - (d - CORE) / (EDGE - CORE);
            // Site pads keep their shape, but the roadway itself is always cut
            // through (otherwise a road skirting a raised pad runs into a wall).
            const inf = t.siteInfluence(x, z);
            if (inf > 0.95) continue;
            if (d > CORE) w *= 1 - inf;
            const idx = iz * N + ix;
            // Nearest road wins among full-weight claims (wide corridors overlap).
            if (w > weight[idx] || (w === weight[idx] && d < dist[idx])) {
              dist[idx] = d;
              cutOnly[idx] = bridged ? 1 : 0;
              weight[idx] = w;
              target[idx] = road[i] + (road[i + 1] - road[i]) * u - 0.15;
            }
          }
      }
    });
    for (let i = 0; i < N * N; i++) {
      const w = weight[i];
      if (w <= 0) continue;
      if (cutOnly[i] && t.heights[i] < target[i] - 0.5) continue;
      const s = w * w * (3 - 2 * w);
      t.heights[i] += (target[i] - 0.5 * cutOnly[i] - t.heights[i]) * s;
    }
    t.refreshMesh();
  }

  /**
   * The graded road surface (including bridge decks) if (x, z) is on a road,
   * else −Infinity. Vehicles drive on this, so roads are perfectly smooth.
   * Where roads cross at different heights, `below` picks the highest surface
   * under that height (so you can drive under a viaduct).
   */
  surfaceAt(x: number, z: number, below = Infinity): number {
    const arr = this.grid.get(Math.floor(x / GRID) + 1000 + (Math.floor(z / GRID) + 1000) * 3000);
    if (!arr || !this.heights.length) return -Infinity;
    // Per road, the nearest segment decides (taking the max over neighbouring
    // segments would turn every slope into a staircase).
    const near = _near;
    near.clear();
    for (const s of arr) {
      const dx = s.bx - s.ax;
      const dz = s.bz - s.az;
      const l2 = dx * dx + dz * dz || 1;
      const t = Math.max(0, Math.min(1, ((x - s.ax) * dx + (z - s.az) * dz) / l2));
      const d = Math.hypot(x - (s.ax + dx * t), z - (s.az + dz * t));
      if (d > this.outer(s.path)) continue;
      const cur = near.get(s.path);
      if (cur && cur.d <= d) continue;
      const h = this.heights[s.path];
      near.set(s.path, { d, y: h[s.i] + (h[s.i + 1] - h[s.i]) * t + 0.12 });
    }
    let best = -Infinity;
    for (const { y } of near.values()) if (y > best && y <= below) best = y;
    return best;
  }

  /** Is p against a bridge guard rail (just off the deck edge, at deck height)? */
  bridgeRail(p: THREE.Vector3): boolean {
    // Where another road joins, its lane is open.
    if (this.surfaceAt(p.x, p.z, p.y + 1.6) > p.y - 2.2) return false;
    for (const d of this.decks) {
      const dx = d.x1 - d.x0;
      const dz = d.z1 - d.z0;
      const l2 = dx * dx + dz * dz || 1;
      const u = ((p.x - d.x0) * dx + (p.z - d.z0) * dz) / l2;
      if (u < 0 || u > 1) continue;
      const off = Math.hypot(p.x - (d.x0 + dx * u), p.z - (d.z0 + dz * u));
      const y = d.y0 + (d.y1 - d.y0) * u;
      if (off > d.w + 0.1 && off < d.w + 1.4 && p.y > y - 0.6 && p.y < y + 1.6) return true;
    }
    // Guard rails along embankments and curves.
    const arr = this.railGrid.get(Math.floor(p.x / GRID) + 1000 + (Math.floor(p.z / GRID) + 1000) * 3000);
    if (arr)
      for (const r of arr) {
        const dx = r.x1 - r.x0;
        const dz = r.z1 - r.z0;
        const l2 = dx * dx + dz * dz || 1;
        const u = Math.max(0, Math.min(1, ((p.x - r.x0) * dx + (p.z - r.z0) * dz) / l2));
        if (Math.hypot(p.x - (r.x0 + dx * u), p.z - (r.z0 + dz * u)) > 0.4) continue;
        const y = r.y0 + (r.y1 - r.y0) * u;
        if (p.y > y - 0.4 && p.y < y + 1.1) return true;
      }
    return false;
  }


  /** Deck height if (x, z) is on a bridge, else −Infinity. */
  bridgeHeightAt(x: number, z: number): number {
    let best = -Infinity;
    for (const d of this.decks) {
      const dx = d.x1 - d.x0;
      const dz = d.z1 - d.z0;
      const l2 = dx * dx + dz * dz || 1;
      const u = ((x - d.x0) * dx + (z - d.z0) * dz) / l2;
      if (u < -0.05 || u > 1.05) continue;
      const uc = Math.max(0, Math.min(1, u));
      if (Math.hypot(x - (d.x0 + dx * uc), z - (d.z0 + dz * uc)) > d.w + 0.5) continue;
      best = Math.max(best, d.y0 + (d.y1 - d.y0) * uc);
    }
    return best;
  }

  /** Length of the shortest road route between two points on the network (null if not connected). */
  route(ax: number, az: number, bx: number, bz: number): number | null {
    const key = (x: number, z: number) => `${Math.round(x / 10)},${Math.round(z / 10)}`;
    const adj = new Map<string, { to: string; w: number }[]>();
    const link = (u: string, v: string, w: number) => {
      if (!adj.has(u)) adj.set(u, []);
      adj.get(u)!.push({ to: v, w });
    };
    for (const p of this.paths) {
      let len = 0;
      for (let i = 1; i < p.length; i++) len += p[i].distanceTo(p[i - 1]);
      const u = key(p[0].x, p[0].y);
      const v = key(p[p.length - 1].x, p[p.length - 1].y);
      link(u, v, len);
      link(v, u, len);
    }
    const src = key(ax, az);
    const dst = key(bx, bz);
    if (!adj.has(src) || !adj.has(dst)) return null;
    const dist = new Map<string, number>([[src, 0]]);
    const open = new Set([src]);
    while (open.size) {
      let cur = '';
      let cd = Infinity;
      for (const k of open) if ((dist.get(k) ?? Infinity) < cd) (cd = dist.get(k)!), (cur = k);
      open.delete(cur);
      if (cur === dst) return cd;
      for (const e of adj.get(cur) ?? []) {
        const nd = cd + e.w;
        if (nd < (dist.get(e.to) ?? Infinity)) {
          dist.set(e.to, nd);
          open.add(e.to);
        }
      }
    }
    return null;
  }

  private colliders?: ColliderSet;
  private stops = new Map<string, { road: THREE.Vector3; wait: THREE.Vector3; heading: number }>();

  /**
   * A roadside stop for ground vehicles at a site: a point on the road where it
   * comes into the site, and a clear spot beside it where passengers and
   * cargo wait. `heading` points along the road, out of the site.
   */
  curbside(x: number, z: number, radius: number): { road: THREE.Vector3; wait: THREE.Vector3; heading: number } | null {
    const key = `${Math.round(x)},${Math.round(z)}`;
    const cached = this.stops.get(key);
    if (cached) return cached;
    const want = Math.max(28, Math.min(60, radius * 0.55));
    let best: { pi: number; i: number; err: number } | null = null;
    this.paths.forEach((path, pi) =>
      path.forEach((q, i) => {
        const err = Math.abs(Math.hypot(q.x - x, q.y - z) - want);
        if (err < 12 && (!best || err < best.err)) best = { pi, i, err };
      }),
    );
    if (!best) return null;
    const { pi, i } = best as { pi: number; i: number };
    const path = this.paths[pi];
    const q = path[i];
    const a = path[Math.max(0, i - 1)];
    const b = path[Math.min(path.length - 1, i + 1)];
    let tx = b.x - a.x;
    let tz = b.y - a.y;
    const tl = Math.hypot(tx, tz) || 1;
    tx /= tl;
    tz /= tl;
    // Point the heading away from the site centre.
    if (tx * (q.x - x) + tz * (q.y - z) < 0) {
      tx = -tx;
      tz = -tz;
    }
    const roadY = this.heights[pi][i];
    const road = new THREE.Vector3(q.x, roadY, q.y);
    // Wait beside the road on whichever side is clear, a little toward the site.
    let wait: THREE.Vector3 | null = null;
    const ob = this.outer(pi);
    for (const base of [ob + 2.5, -(ob + 2.5), ob + 5.5, -(ob + 5.5), ob + 8.5, -(ob + 8.5)]) {
      const off = base;
      const w = new THREE.Vector3(q.x - tz * off - tx * 3, 0, q.y + tx * off - tz * 3);
      w.y = this.terrain.heightAt(w.x, w.z);
      let clear = this.distanceExcept(w.x, w.z, pi) > 1.5 && this.distance(w.x, w.z) > ob + 1.5;
      for (const [dx, dz] of [[0, 0], [3, 0], [-3, 0], [0, 3], [0, -3]])
        if (clear && this.colliders?.hit(new THREE.Vector3(w.x + dx, w.y + 1, w.z + dz), 1)) clear = false;
      if (clear) {
        wait = w;
        break;
      }
    }
    if (!wait) wait = new THREE.Vector3(q.x - tz * (ob + 2.5), this.terrain.heightAt(q.x - tz * (ob + 2.5), q.y + tx * (ob + 2.5)), q.y + tx * (ob + 2.5));
    const stop = { road, wait, heading: Math.atan2(tx, -tz) };
    this.stops.set(key, stop);
    return stop;
  }

  build(colliders?: ColliderSet): THREE.Group {
    this.colliders = colliders;
    const concrete = new THREE.MeshLambertMaterial({ color: 0x8f8d86 });
    const textures: Record<RoadClass, THREE.Texture> = { main: roadTexture('main'), secondary: roadTexture('secondary'), track: roadTexture('track') };
    const rank: Record<RoadClass, number> = { main: 2, secondary: 1, track: 0 };
    // Shoulders draw under every carriageway, so junctions stay clean.
    const shoulderMat = new THREE.MeshLambertMaterial({ vertexColors: true, map: gravelTexture(), polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 });
    const gravel = new THREE.Color(0x8a8172);
    const verge = new THREE.Color(0x6f6650);
    this.paths.forEach((path, pi) => {
      const cls = this.classes[pi];
      const { hw, shoulder: sh } = ROAD_SPEC[cls];
      const n = path.length;
      const ground = path.map((p) => this.terrain.heightAt(p.x, p.y));
      const road = this.heights[pi];
      const onBridge = new Array<boolean>(n).fill(false);
      for (const sp of this.spans[pi]) {
        for (let k = sp.a; k <= sp.b; k++) onBridge[k] = true;
        this.buildBridge(path, road, ground, sp.a, sp.b, hw + sh, concrete, colliders);
      }
      const dist = [0];
      for (let i = 1; i < n; i++) dist.push(dist[i - 1] + path[i].distanceTo(path[i - 1]));

      // Carriageway: three columns across (left edge, centre, right edge).
      const cols = [-hw, 0, hw];
      const pos = new Float32Array(n * 3 * 3);
      const uv = new Float32Array(n * 3 * 2);
      const idx: number[] = [];
      // Shoulders: per side, columns at the carriageway edge, shoulder edge and verge.
      const scol = [hw - 0.05, hw + sh, hw + sh + 1.6];
      const spos = new Float32Array(n * 6 * 3);
      const scl = new Float32Array(n * 6 * 3);
      const suv = new Float32Array(n * 6 * 2);
      const sidx: number[] = [];
      for (let i = 0; i < n; i++) {
        const p = path[i];
        const pa = path[Math.max(0, i - 1)];
        const pb = path[Math.min(n - 1, i + 1)];
        const tx = pb.x - pa.x;
        const tz = pb.y - pa.y;
        const tl = Math.hypot(tx, tz) || 1;
        const nx = -tz / tl;
        const nz = tx / tl;
        const yAt = (x: number, z: number) => (onBridge[i] ? road[i] + 0.14 : Math.max(road[i], this.terrain.heightAt(x, z)) + 0.08);
        cols.forEach((o, c) => {
          const x = p.x + nx * o;
          const z = p.y + nz * o;
          const j = i * 3 + c;
          pos[j * 3] = x;
          pos[j * 3 + 1] = yAt(x, z);
          pos[j * 3 + 2] = z;
          uv[j * 2] = c / 2;
          uv[j * 2 + 1] = dist[i] / 12;
        });
        if (i > 0) {
          for (let c = 0; c < 2; c++) {
            const a0 = (i - 1) * 3 + c;
            const b0 = i * 3 + c;
            idx.push(a0, a0 + 1, b0, a0 + 1, b0 + 1, b0);
          }
        }
        for (let sd = 0; sd < 2; sd++) {
          const side = sd === 0 ? 1 : -1;
          scol.forEach((o, c) => {
            const x = p.x + nx * o * side;
            const z = p.y + nz * o * side;
            const j = i * 6 + sd * 3 + c;
            const t = this.terrain.heightAt(x, z);
            spos[j * 3] = x;
            spos[j * 3 + 1] = c === 2 ? t + 0.04 : c === 0 ? yAt(x, z) - 0.01 : Math.max(road[i] - 0.06, t) + 0.07;
            spos[j * 3 + 2] = z;
            const col = c === 2 ? verge : gravel;
            const v = 0.92 + Math.random() * 0.12;
            scl[j * 3] = col.r * v;
            scl[j * 3 + 1] = col.g * v;
            scl[j * 3 + 2] = col.b * v;
            suv[j * 2] = (o * side) / 4;
            suv[j * 2 + 1] = dist[i] / 4;
          });
          if (i > 0 && !(onBridge[i] && onBridge[i - 1])) {
            for (let c = 0; c < 2; c++) {
              const a0 = (i - 1) * 6 + sd * 3 + c;
              const b0 = i * 6 + sd * 3 + c;
              if (side > 0) sidx.push(a0, a0 + 1, b0, a0 + 1, b0 + 1, b0);
              else sidx.push(a0, b0, a0 + 1, a0 + 1, b0, b0 + 1);
            }
          }
        }
      }
      const mk = (P: Float32Array, U: Float32Array, I: number[], C?: Float32Array) => {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(P, 3));
        g.setAttribute('uv', new THREE.BufferAttribute(U, 2));
        if (C) g.setAttribute('color', new THREE.BufferAttribute(C, 3));
        g.setIndex(I);
        g.computeVertexNormals();
        // Make sure the strip faces up regardless of winding.
        const nr = g.getAttribute('normal');
        let up = 0;
        for (let k = 0; k < nr.count; k += 7) up += nr.getY(k);
        if (up < 0) {
          g.setIndex(I.map((_, k) => I[k - (k % 3) + (2 - (k % 3))]));
          g.computeVertexNormals();
        }
        return g;
      };
      const mat = new THREE.MeshLambertMaterial({
        map: textures[cls],
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -(4 + rank[cls] * 40 + pi),
      });
      const mesh = new THREE.Mesh(mk(pos, uv, idx), mat);
      mesh.receiveShadow = true;
      this.group.add(mesh);
      const smesh = new THREE.Mesh(mk(spos, suv, sidx, scl), shoulderMat);
      smesh.receiveShadow = true;
      this.group.add(smesh);
    });
    return this.group;
  }

  /** Concrete deck, parapets and piers between samples a..b. */
  private buildBridge(path: THREE.Vector2[], road: number[], ground: number[], a: number, b: number, half: number, mat: THREE.Material, colliders?: ColliderSet) {
    const parts: THREE.BufferGeometry[] = [];
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const deckW = half * 2 + 0.8;
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
      place(new THREE.BoxGeometry(len, 0.8, deckW), 0, -0.35, 0);
      // Parapets with a kerb inside them.
      for (const sd of [1, -1]) {
        place(new THREE.BoxGeometry(len, 0.95, 0.3), 0, 0.5, sd * (half + 0.25));
        place(new THREE.BoxGeometry(len, 0.18, 0.6), 0, 0.12, sd * (half - 0.15));
      }
      // Girder under the deck edges.
      for (const sd of [1, -1]) place(new THREE.BoxGeometry(len, 1.2, 0.5), 0, -1.3, sd * (half - 1.2));
      if ((i - a) % 3 === 1) {
        const bottom = Math.min(ground[i], 0) - 3;
        const h = y - 0.7 - bottom;
        if (h > 0.5) {
          place(new THREE.BoxGeometry(1.8, h, half * 2 - 1.5), 0, -0.7 - h / 2, 0);
          place(new THREE.BoxGeometry(2.4, 0.8, half * 2 + 0.2), 0, -1.3, 0);
        }
      }
      this.decks.push({ x0: p0.x, z0: p0.y, x1: p1.x, z1: p1.y, y0: road[i] + 0.05, y1: road[i + 1] + 0.05, w: half });
      colliders?.add({ soft: true, minX: cx - len / 2 - half, maxX: cx + len / 2 + half, minY: y - 1, maxY: y + 1, minZ: cz - len / 2 - half, maxZ: cz + len / 2 + half });
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
