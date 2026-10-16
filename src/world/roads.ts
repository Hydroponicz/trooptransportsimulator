import * as THREE from 'three';
import type { RNG } from '../util/noise';
import { CELL, HALF, SEGS, WATER_LEVEL, type Terrain } from './terrain';
import type { ColliderSet } from './colliders';
import { gravelTexture, roadTexture } from '../util/textures';

const GRID = 50;

function inPolygon(poly: THREE.Vector2[], x: number, z: number): boolean {
  let inside = false;
  for (let i = 0, k = poly.length - 1; i < poly.length; k = i++) {
    const a = poly[i];
    const b = poly[k];
    if (a.y > z !== b.y > z && x < ((b.x - a.x) * (z - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

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
const _near = new Map<number, { d: number; w: number; wh: number }>();

interface Seg {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  path: number;
  i: number;
  /** Scratch: last query that collected this segment. */
  stamp?: number;
}

const NO_DECKS: Roads['decks'] = [];
const NO_PADS: never[] = [];

/** Dirt roads connecting sites. Also answers "how far is this point from a road". */
export class Roads {
  readonly paths: THREE.Vector2[][] = [];
  readonly classes: RoadClass[] = [];
  /** Roads built for civilian traffic between towns (indices into paths). */
  readonly civilian = new Set<number>();
  /** Site gates (for the entry control points) with the junction outside each. */
  readonly gates: { x: number; z: number; dx: number; dz: number; junction: THREE.Vector2; site: string }[] = [];
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

  /**
   * Lay a road from A to B. `straight` roads (site access roads) don't wander;
   * `leaveA`/`leaveB` are directions the road heads off in from each end, so
   * roads leave a junction outward rather than cutting back past the site.
   */
  add(
    ax: number,
    az: number,
    bx: number,
    bz: number,
    rng: RNG,
    cls: RoadClass = 'secondary',
    opts: { straight?: boolean; leaveA?: THREE.Vector2; leaveB?: THREE.Vector2; freeEnd?: boolean; freeStart?: boolean } = {},
  ) {
    this.classes.push(cls);
    if (opts.freeEnd) this.freeEnds.add(this.paths.length);
    if (opts.freeStart) this.freeStarts.add(this.paths.length);
    const A = new THREE.Vector2(ax, az);
    const B = new THREE.Vector2(bx, bz);
    let pts = [A];
    const span = A.distanceTo(B);
    // How far to run out along a leave direction: full when the other end is
    // straight ahead, little or nothing when it is off to the side (no hooks).
    const reach = (from: THREE.Vector2, dir: THREE.Vector2, to: THREE.Vector2) => {
      const ahead = dir.dot(to.clone().sub(from).normalize());
      return ahead <= 0.1 ? 0 : Math.min(120, span * 0.2) * Math.min(1, (ahead - 0.1) / 0.6);
    };
    if (opts.leaveA && span > 250) {
      const r = reach(A, opts.leaveA, B);
      if (r > 15) pts.push(A.clone().addScaledVector(opts.leaveA, r));
    }
    if (opts.leaveB && span > 250) {
      const r = reach(B, opts.leaveB, A);
      if (r > 15) pts.push(B.clone().addScaledVector(opts.leaveB, r));
    }
    pts.push(B);
    for (let depth = 0; depth < (opts.straight ? 0 : 5); depth++) {
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
    // Centripetal Catmull-Rom: no loops or cusps where control points are unevenly spaced.
    const curve = new THREE.CatmullRomCurve3(pts.map((q) => new THREE.Vector3(q.x, 0, q.y)), false, 'centripetal');
    const total = curve.getLength();
    const samples = curve.getSpacedPoints(Math.max(4, Math.floor(total / 7))).map((q) => new THREE.Vector2(q.x, q.z));
    // Round off tight corners so curves are drivable (ends stay put).
    for (let it = 0; it < 24; it++) {
      const prev = samples.map((q) => q.clone());
      for (let i = 1; i < samples.length - 1; i++) {
        samples[i].x = prev[i].x * 0.5 + (prev[i - 1].x + prev[i + 1].x) * 0.25;
        samples[i].y = prev[i].y * 0.5 + (prev[i - 1].y + prev[i + 1].y) * 0.25;
      }
    }
    this.paths.push(samples);
    const pathIndex = this.paths.length - 1;
    for (let i = 1; i < samples.length; i++) this.index({ ax: samples[i - 1].x, az: samples[i - 1].y, bx: samples[i].x, bz: samples[i].y, path: pathIndex, i: i - 1 });
  }

  /** Split road `pi` at sample k (for a T-junction); returns the new road's index. */
  split(pi: number, k: number): number {
    const path = this.paths[pi];
    const tail = this.paths.length;
    this.paths.push(path.slice(k));
    this.paths[pi] = path.slice(0, k + 1);
    this.classes.push(this.classes[pi]);
    // The split point isn't a real road end: both pieces take their height
    // there from the profile, not the raw ground.
    if (this.freeEnds.has(pi)) this.freeEnds.add(tail);
    this.freeEnds.add(pi);
    this.freeStarts.add(tail);
    // Segments from sample k on now belong to the tail (each is one object shared by its cells).
    for (let i = k; i < path.length - 1; i++) {
      const seg = this.findSeg(path[i], pi, i);
      if (seg) {
        seg.path = tail;
        seg.i = i - k;
      }
    }
    return this.paths.length - 1;
  }

  /** Roads whose far end may sit on a cut or embankment (site access roads). */
  private freeEnds = new Set<number>();
  private freeStarts = new Set<number>();

  /** Drivable junction pads (fill the corners where roads meet). */
  private padSurf: { x: number; z: number; y: number; fillets: THREE.Vector2[][]; rank: number }[] = [];
  static readonly PAD_R = 11;

  /** Per road: whether its start / end meets another road's end. */
  private endLinks: [boolean, boolean][] = [];

  /** Undo the most recent add() (used when a candidate road is rejected). */
  removeLast() {
    const pi = this.paths.length - 1;
    const pts = this.paths.pop()!;
    this.classes.pop();
    this.freeEnds.delete(pi);
    this.freeStarts.delete(pi);
    // Its segments were the last indexed: drop them from just the cells they were put in.
    const done = new Set<number>();
    for (let i = 1; i < pts.length; i++)
      this.forCells(pts[i - 1].x, pts[i - 1].y, pts[i].x, pts[i].y, (k) => {
        if (done.has(k)) return;
        done.add(k);
        const arr = this.grid.get(k);
        if (!arr) return;
        let n = arr.length;
        while (n > 0 && arr[n - 1].path === pi) n--;
        if (n < arr.length) arr.length = n;
        if (!n) this.grid.delete(k);
      });
  }

  /** The indexed segment of road pi starting at sample i (at point a). */
  private findSeg(a: THREE.Vector2, pi: number, i: number): Seg | null {
    const arr = this.grid.get(Math.floor(a.x / GRID) + 1000 + (Math.floor(a.y / GRID) + 1000) * 3000);
    return arr?.find((g) => g.path === pi && g.i === i) ?? null;
  }

  /** How many samples of road `pi` (away from its ends) run alongside another road. */
  overlap(pi: number): number {
    const path = this.paths[pi];
    let n = 0;
    for (let i = 4; i < path.length - 4; i++) if (this.distanceExcept(path[i].x, path[i].y, pi) < this.outer(pi) + 2) n++;
    return n;
  }

  /** Extra paved pads at T-junctions. */
  readonly junctionPads: THREE.Vector2[] = [];

  /** Each grid cell a segment is indexed into (its box, grown by 12 m). */
  private forCells(ax: number, az: number, bx: number, bz: number, fn: (k: number) => void) {
    const m = 12;
    for (let cx = Math.floor((Math.min(ax, bx) - m) / GRID); cx <= Math.floor((Math.max(ax, bx) + m) / GRID); cx++)
      for (let cz = Math.floor((Math.min(az, bz) - m) / GRID); cz <= Math.floor((Math.max(az, bz) + m) / GRID); cz++) fn(cx + 1000 + (cz + 1000) * 3000);
  }

  private index(s: Seg) {
    this.forCells(s.ax, s.az, s.bx, s.bz, (k) => {
      let arr = this.grid.get(k);
      if (!arr) this.grid.set(k, (arr = []));
      arr.push(s);
    });
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
    // Every road point, bucketed, so a raised road can tell where another passes beneath it.
    const PG = 20;
    const pts = new Map<number, number[]>();
    this.paths.forEach((path, pi) =>
      path.forEach((p) => {
        const k = Math.floor(p.x / PG) * 100003 + Math.floor(p.y / PG);
        let arr = pts.get(k);
        if (!arr) pts.set(k, (arr = []));
        arr.push(pi);
      }),
    );
    const crossedBy = (pi: number, x: number, z: number) => {
      for (let gx = Math.floor((x - 12) / PG); gx <= Math.floor((x + 12) / PG); gx++)
        for (let gz = Math.floor((z - 12) / PG); gz <= Math.floor((z + 12) / PG); gz++)
          for (const o of pts.get(gx * 100003 + gz) ?? [])
            if (o !== pi && this.paths[o].some((q) => Math.hypot(q.x - x, q.y - z) < 12)) return true;
      return false;
    };
    for (const path of this.paths) {
      const n = path.length;
      const free = this.freeEnds.has(this.heights.length);
      const freeStart = this.freeStarts.has(this.heights.length);
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
        if (!freeStart) road[0] = ground[0];
        if (!free) road[n - 1] = ground[n - 1];
        for (let i = 0; i < n; i++) if (pins[i] !== null && this.terrain.siteInfluence(path[i].x, path[i].y) <= 0.6) road[i] = pins[i]!;
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
      // Fixed points: site pads sit on the ground; where this road meets one
      // already graded it takes that road's height (ends included); other
      // ends sit on the ground.
      const onPad = path.map(() => false);
      for (let i = 0; i < n; i++) {
        const end = (i === 0 && !freeStart) || (i === n - 1 && !free);
        if (this.terrain.siteInfluence(path[i].x, path[i].y) > 0.6) road[i] = ground[i];
        else if (pins[i] !== null) road[i] = pins[i]!;
        else if (end) road[i] = ground[i];
        else continue;
        onPad[i] = true;
      }
      const STEEP = 0.3;
      // Near a junction the road stays nearly level for ~30 m, so it doesn't
      // climb away over the shoulder of the road it joins.
      const cap = path.map(() => STEEP);
      for (let i = 0; i < n; i++) {
        if (pins[i] === null) continue;
        let along = 0;
        for (let k = i; k < n && along < 30; k++) {
          cap[k] = Math.min(cap[k], 0.06);
          if (k + 1 < n) along += path[k + 1].distanceTo(path[k]);
        }
        along = 0;
        for (let k = i; k >= 0 && along < 30; k--) {
          cap[k] = Math.min(cap[k], 0.06);
          if (k > 0) along += path[k].distanceTo(path[k - 1]);
        }
      }
      for (let it = 0; it < 3; it++) {
        for (let i = 1; i < n; i++) {
          if (onPad[i]) continue;
          const g = cap[i] * path[i].distanceTo(path[i - 1]);
          road[i] = Math.min(road[i - 1] + g, Math.max(road[i - 1] - g, road[i]));
        }
        for (let i = n - 2; i >= 0; i--) {
          if (onPad[i]) continue;
          const g = cap[i] * path[i].distanceTo(path[i + 1]);
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
      // (Not right at a junction: there it stays on an embankment so the
      // roads can meet on solid ground.)
      // Also where it is carried over another road: a bridge, not an earth bank across it.
      const pi = this.heights.length;
      const raised = (k: number) => ground[k] < 1.4 || (road[k] - ground[k] > 2.5 && (cap[k] >= STEEP || crossedBy(pi, path[k].x, path[k].y)));
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
    // Junction pads: the paved area where roads meet, shaped as the outline
    // around each road's mouth (no circles), at the junction's height.
    this.padSurf = [];
    const seenJ = new Set<string>();
    for (const j of [...this.gates.map((g) => g.junction), ...this.junctionPads]) {
      const kj = `${Math.round(j.x)},${Math.round(j.y)}`;
      if (seenJ.has(kj)) continue;
      seenJ.add(kj);
      let y: number | null = null;
      // Each road leaving the junction: outward direction and carriageway half-width.
      const arms: { a: THREE.Vector2; hw: number }[] = [];
      let rank = 0;
      this.paths.forEach((p, pi) => {
        const atStart = p[0].distanceTo(j) < 1;
        const atEnd = p[p.length - 1].distanceTo(j) < 1;
        if (!atStart && !atEnd) return;
        if (y === null) y = this.heights[pi][atStart ? 0 : p.length - 1];
        const far = atStart ? p[Math.min(2, p.length - 1)] : p[Math.max(0, p.length - 3)];
        arms.push({ a: far.clone().sub(j).normalize(), hw: this.hw(pi) });
        rank = Math.max(rank, { track: 0, secondary: 1, main: 2 }[this.classes[pi]]);
      });
      if (y === null || arms.length < 2) continue;
      // Corner fillets between neighbouring arms (sorted around the junction):
      // a curved infill from one road's edge to the next, like a kerb radius.
      arms.sort((p, q) => Math.atan2(p.a.y, p.a.x) - Math.atan2(q.a.y, q.a.x));
      const fillets: THREE.Vector2[][] = [];
      for (let k = 0; k < arms.length; k++) {
        const A = arms[k];
        const B = arms[(k + 1) % arms.length];
        let ang = Math.atan2(B.a.y, B.a.x) - Math.atan2(A.a.y, A.a.x);
        if (ang <= 0) ang += Math.PI * 2;
        if (ang > Math.PI * 0.85) continue; // nearly straight through: nothing to fill
        const nA = new THREE.Vector2(-A.a.y, A.a.x); // A's edge facing B
        const nB = new THREE.Vector2(B.a.y, -B.a.x); // B's edge facing A
        const r = 9 + Math.max(A.hw, B.hw);
        const PA = j.clone().addScaledVector(nA, A.hw).addScaledVector(A.a, r);
        const PB = j.clone().addScaledVector(nB, B.hw).addScaledVector(B.a, r);
        // Kerb control point: where the two edge lines meet.
        const oA = j.clone().addScaledVector(nA, A.hw);
        const oB = j.clone().addScaledVector(nB, B.hw);
        const den = A.a.x * B.a.y - A.a.y * B.a.x;
        let C = PA.clone().add(PB).multiplyScalar(0.5);
        if (Math.abs(den) > 1e-3) {
          const t = ((oB.x - oA.x) * B.a.y - (oB.y - oA.y) * B.a.x) / den;
          if (t > 0 && t < r * 2) C = oA.clone().addScaledVector(A.a, t);
        }
        const poly = [j.clone(), PA];
        for (let q = 1; q < 8; q++) {
          const u = q / 8;
          poly.push(new THREE.Vector2(
            (1 - u) * (1 - u) * PA.x + 2 * u * (1 - u) * C.x + u * u * PB.x,
            (1 - u) * (1 - u) * PA.y + 2 * u * (1 - u) * C.y + u * u * PB.y,
          ));
        }
        poly.push(PB);
        fillets.push(poly);
      }
      this.padSurf.push({ x: j.x, z: j.y, y, fillets, rank });
    }
    const ends = this.paths.flatMap((p) => [p[0], p[p.length - 1]]);
    const linked = (q: THREE.Vector2, self: number) => ends.some((e, k) => Math.floor(k / 2) !== self && e.distanceTo(q) < 1);
    this.endLinks = this.paths.map((p, pi) => [linked(p[0], pi), linked(p[p.length - 1], pi)]);
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
      // Pass under bridges, except where the roads actually join.
      if (d > 0.5 && this.spans[s.path].some((sp) => s.i >= sp.a && s.i + 1 <= sp.b)) continue;
      const h = this.heights[s.path];
      best = d;
      y = h[s.i] + (h[s.i + 1] - h[s.i]) * t;
    }
    return y;
  }

  /**
   * Blend the terrain toward the road profile in a corridor round each road:
   * handed to the terrain as a per-vertex adjustment, so any tile's heights
   * can be worked out on their own. Within 13 m of a road the ground takes
   * the road's level, fading out by 32 m; where corridors overlap the nearest
   * road wins (ties to the earlier road, as when this ran road by road over
   * the whole grid). Site pads keep their shape; under bridges only ground
   * that would poke through the deck is cut.
   */
  private cutAndFill() {
    const t = this.terrain;
    const CORE = 13;
    const EDGE = 32;
    const cand: Seg[] = [];
    let stamp = 0;
    const bridged = this.paths.map((_, pi) => {
      const spans = this.spans[pi];
      return (i: number) => spans.some((sp) => i > sp.a && i + 1 < sp.b);
    });
    // Cells with a road within reach: a vertex within 32 m of a road is in, or next to,
    // a cell that road is indexed in (cells are 50 m). Everywhere else nothing changes.
    const MN = Math.ceil((HALF * 2) / GRID) + 4;
    const M0 = Math.floor(-HALF / GRID) - 2;
    const near = new Uint8Array(MN * MN);
    for (const k of this.grid.keys()) {
      const cz = Math.floor(k / 3000) - 1000;
      const cx = (k % 3000) - 1000;
      for (let dz = -1; dz <= 1; dz++)
        for (let dx = -1; dx <= 1; dx++) {
          const i = cx + dx - M0;
          const j = cz + dz - M0;
          if (i >= 0 && j >= 0 && i < MN && j < MN) near[j * MN + i] = 1;
        }
    }
    const isNear = (cx: number, cz: number) => {
      const mi = cx - M0;
      const mj = cz - M0;
      return mi >= 0 && mj >= 0 && mi < MN && mj < MN && near[mj * MN + mi] === 1;
    };
    t.setOverlay((x, z, h) => {
      if (!isNear(Math.floor(x / GRID), Math.floor(z / GRID))) return h;
      // Segments within reach: each is indexed in every cell its box (grown 12 m) touches,
      // so the cells round (x, z) out to 32 m hold every one that can be in range.
      cand.length = 0;
      stamp++;
      for (let cx = Math.floor((x - EDGE) / GRID); cx <= Math.floor((x + EDGE) / GRID); cx++)
        for (let cz = Math.floor((z - EDGE) / GRID); cz <= Math.floor((z + EDGE) / GRID); cz++) {
          const arr = this.grid.get(cx + 1000 + (cz + 1000) * 3000);
          if (arr)
            for (const g of arr)
              if (g.stamp !== stamp) {
                g.stamp = stamp;
                cand.push(g);
              }
        }
      if (!cand.length) return h;
      const inf = t.siteInfluence(x, z);
      if (inf > 0.95) return h;
      cand.sort((p, q) => p.path - q.path || p.i - q.i);
      // (Float32 like the grids this once filled, so the result is the same to the bit.)
      let W = 0;
      let D = 1e9;
      let C = 0;
      let TGT = 0;
      for (const g of cand) {
        const dx = g.bx - g.ax;
        const dz = g.bz - g.az;
        const l2 = dx * dx + dz * dz || 1;
        const u = Math.max(0, Math.min(1, ((x - g.ax) * dx + (z - g.az) * dz) / l2));
        const d = Math.hypot(x - (g.ax + dx * u), z - (g.az + dz * u));
        if (d > EDGE) continue;
        let w = d < CORE ? 1 : 1 - (d - CORE) / (EDGE - CORE);
        if (d > CORE) w *= 1 - inf;
        if (w > W || (w === W && d < D)) {
          const road = this.heights[g.path];
          D = Math.fround(d);
          C = bridged[g.path](g.i) ? 1 : 0;
          W = Math.fround(w);
          TGT = Math.fround(road[g.i] + (road[g.i + 1] - road[g.i]) * u - 0.15);
        }
      }
      if (W <= 0) return h;
      if (C && h < TGT - 0.5) return h;
      const sm = W * W * (3 - 2 * W);
      return Math.fround(h + (TGT - 0.5 * C - h) * sm);
    }, isNear, GRID);
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
    // Per road: on it if within its half-width of the centreline; the height is
    // a smooth kernel-weighted average of nearby sample heights, which is
    // continuous everywhere (picking a nearest segment leaves seams in bends).
    const near = _near;
    near.clear();
    const R = 10;
    const acc = (path: number, d: number, px: number, pz: number, h: number) => {
      const dd = Math.hypot(x - px, z - pz);
      let n = near.get(path);
      if (!n) near.set(path, (n = { d: Infinity, w: 0, wh: 0 }));
      if (d < n.d) n.d = d;
      if (dd < R) {
        const w = (1 - dd / R) * (1 - dd / R);
        n.w += w;
        n.wh += w * h;
      }
    };
    for (const s of arr) {
      const dx = s.bx - s.ax;
      const dz = s.bz - s.az;
      const l2 = dx * dx + dz * dz || 1;
      const raw = ((x - s.ax) * dx + (z - s.az) * dz) / l2;
      const last = s.i === this.paths[s.path].length - 2;
      // A road's surface stops at its end (no flat disc beyond it, which at a
      // junction would sit above the road you arrive on).
      // Ends that meet another road reach a little further, closing gaps on
      // the outside of a bend at the joint.
      const len0 = Math.sqrt(l2);
      const links = this.endLinks[s.path];
      const reachA = (links?.[0] ? 3 : 0.35) / len0;
      const reachB = (links?.[1] ? 3 : 0.35) / len0;
      const beyond = (s.i === 0 && raw < -reachA) || (last && raw > 1 + reachB);
      const t = Math.max(0, Math.min(1, raw));
      const d = beyond ? Infinity : Math.hypot(x - (s.ax + dx * t), z - (s.az + dz * t));
      const h = this.heights[s.path];
      acc(s.path, d, s.ax, s.az, h[s.i]);
      if (last) acc(s.path, Infinity, s.bx, s.bz, h[s.i + 1]);
    }
    let best = -Infinity;
    near.forEach((n, path) => {
      if (n.d > this.outer(path) || n.w <= 0) return;
      const y = n.wh / n.w + 0.12;
      if (y > best && y <= below) best = y;
    });
    if (best === -Infinity)
      for (const pd of this.padsNear(x, z))
        if (Math.hypot(x - pd.x, z - pd.z) < 30 && pd.y + 0.12 <= below && pd.fillets.some((f) => inPolygon(f, x, z))) best = Math.max(best, pd.y + 0.12);
    return best;
  }

  /** Is p against a bridge guard rail (just off the deck edge, at deck height)? */
  bridgeRail(p: THREE.Vector3): boolean {
    // Where another road joins, its lane is open.
    if (this.surfaceAt(p.x, p.z, p.y + 1.6) > p.y - 2.2) return false;
    if (this.padsNear(p.x, p.z).some((pd) => Math.hypot(pd.x - p.x, pd.z - p.z) < Roads.PAD_R + 4)) return false;
    for (const d of this.decksNear(p.x, p.z)) {
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


  /** Junction pads bucketed by grid cell, each in every cell within 30 m (rebuilt if they change). */
  private padGrid = new Map<number, Roads['padSurf']>();
  private padGridOf: Roads['padSurf'] | null = null;
  private padGridCount = -1;

  private padsNear(x: number, z: number): Roads['padSurf'] {
    if (this.padGridOf !== this.padSurf || this.padGridCount !== this.padSurf.length) {
      this.padGridOf = this.padSurf;
      this.padGridCount = this.padSurf.length;
      this.padGrid.clear();
      for (const pd of this.padSurf)
        for (let cx = Math.floor((pd.x - 30) / GRID); cx <= Math.floor((pd.x + 30) / GRID); cx++)
          for (let cz = Math.floor((pd.z - 30) / GRID); cz <= Math.floor((pd.z + 30) / GRID); cz++) {
            const k = cx + 1000 + (cz + 1000) * 3000;
            let arr = this.padGrid.get(k);
            if (!arr) this.padGrid.set(k, (arr = []));
            arr.push(pd);
          }
    }
    return this.padGrid.get(Math.floor(x / GRID) + 1000 + (Math.floor(z / GRID) + 1000) * 3000) ?? NO_PADS;
  }

  /** Decks bucketed by grid cell (rebuilt if more are added). */
  private deckGrid = new Map<number, Roads['decks']>();
  private deckCount = -1;

  /** Decks near (x, z). */
  private decksNear(x: number, z: number): Roads['decks'] {
    if (this.deckCount !== this.decks.length) {
      this.deckCount = this.decks.length;
      this.deckGrid.clear();
      for (const d of this.decks) {
        const m = d.w + 2;
        for (let cx = Math.floor((Math.min(d.x0, d.x1) - m) / GRID); cx <= Math.floor((Math.max(d.x0, d.x1) + m) / GRID); cx++)
          for (let cz = Math.floor((Math.min(d.z0, d.z1) - m) / GRID); cz <= Math.floor((Math.max(d.z0, d.z1) + m) / GRID); cz++) {
            const k = cx + 1000 + (cz + 1000) * 3000;
            let arr = this.deckGrid.get(k);
            if (!arr) this.deckGrid.set(k, (arr = []));
            arr.push(d);
          }
      }
    }
    return this.deckGrid.get(Math.floor(x / GRID) + 1000 + (Math.floor(z / GRID) + 1000) * 3000) ?? NO_DECKS;
  }

  /** Deck height if (x, z) is on a bridge, else −Infinity. */
  bridgeHeightAt(x: number, z: number): number {
    let best = -Infinity;
    for (const d of this.decksNear(x, z)) {
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
    // Snap each end to the nearest road end (a site's access road ends inside it).
    const snap = (x: number, z: number) => {
      let best: string | null = null;
      let bd = 260;
      for (const p of this.paths)
        for (const q of [p[0], p[p.length - 1]]) {
          const d = Math.hypot(q.x - x, q.y - z);
          if (d < bd) (bd = d), (best = key(q.x, q.y));
        }
      return best;
    };
    const src = snap(ax, az);
    const dst = snap(bx, bz);
    if (!src || !dst || !adj.has(src) || !adj.has(dst)) return null;
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
    // The road end nearest the site centre is its access road's motor-pool end;
    // the stop is a few samples out from it, still inside the site.
    void radius;
    let best: { pi: number; i: number; d: number } | null = null;
    this.paths.forEach((path, pi) => {
      for (const i of [0, path.length - 1]) {
        const d = Math.hypot(path[i].x - x, path[i].y - z);
        if (d < 260 && (!best || d < best.d)) best = { pi, i: i === 0 ? Math.min(3, path.length - 1) : Math.max(0, path.length - 4), d };
      }
    });
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
    // Paved junction areas.
    // Junction surface matches the best road meeting there.
    const padMats = [
      new THREE.MeshLambertMaterial({ map: gravelTexture(), color: 0xa08e6c, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -3 }),
      new THREE.MeshLambertMaterial({ map: roadTexture('plainworn'), polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -3 }),
      new THREE.MeshLambertMaterial({ map: roadTexture('plain'), polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -3 }),
    ];
    for (const pd of this.padSurf) {
      const pos: number[] = [];
      const uv: number[] = [];
      const Y = (x: number, z: number) => Math.max(this.terrain.heightAt(x, z), pd.y) + 0.09;
      // Fan out from the junction centre over each fillet.
      for (const f of pd.fillets)
        for (let i = 1; i + 1 < f.length; i++)
          for (const q of [f[0], f[i + 1], f[i]]) {
            pos.push(q.x, Y(q.x, q.y), q.y);
            uv.push(q.x / 10, q.y / 10);
          }
      if (!pos.length) continue;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      geo.computeVertexNormals();
      if ((geo.getAttribute('normal') as THREE.BufferAttribute).getY(0) < 0) {
        const p = geo.getAttribute('position') as THREE.BufferAttribute;
        for (let i = 0; i < p.count; i += 3) {
          const t = [p.getX(i + 1), p.getY(i + 1), p.getZ(i + 1)];
          p.setXYZ(i + 1, p.getX(i + 2), p.getY(i + 2), p.getZ(i + 2));
          p.setXYZ(i + 2, t[0], t[1], t[2]);
        }
        geo.computeVertexNormals();
      }
      const m = new THREE.Mesh(geo, padMats[pd.rank]);
      m.receiveShadow = true;
      this.group.add(m);
    }
    this.paths.forEach((path, pi) => {
      const cls = this.classes[pi];
      const { hw, shoulder: sh } = ROAD_SPEC[cls];
      const n = path.length;
      const ground = path.map((p) => this.terrain.heightAt(p.x, p.y));
      const road = this.heights[pi];
      const onBridge = new Array<boolean>(n).fill(false);
      // Bridges are always paved: on a dirt track the deck (and a short
      // apron either side) gets asphalt.
      const paved = new Array<boolean>(n).fill(cls !== 'track');
      for (const sp of this.spans[pi]) {
        for (let k = sp.a; k <= sp.b; k++) onBridge[k] = true;
        for (let k = Math.max(0, sp.a - 2); k <= Math.min(n - 1, sp.b + 2); k++) paved[k] = true;
        this.buildBridge(path, road, ground, sp.a, sp.b, hw + sh, concrete, colliders);
      }
      const dist = [0];
      for (let i = 1; i < n; i++) dist.push(dist[i - 1] + path[i].distanceTo(path[i - 1]));

      // Carriageway: three columns across (left edge, centre, right edge).
      const cols = [-hw, 0, hw];
      const pos = new Float32Array(n * 3 * 3);
      const uv = new Float32Array(n * 3 * 2);
      const idx: number[] = [];
      const idxPaved: number[] = [];
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
          const into = cls === 'track' && paved[i] && paved[i - 1] ? idxPaved : idx;
          for (let c = 0; c < 2; c++) {
            const a0 = (i - 1) * 3 + c;
            const b0 = i * 3 + c;
            into.push(a0, a0 + 1, b0, a0 + 1, b0 + 1, b0);
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
        // Higher classes over lower where they cross; within a class, a small per-road
        // step (it wraps, so the offset stays small on a big network).
        polygonOffsetUnits: -(4 + rank[cls] * 40 + (pi % 32)),
      });
      const geo = mk(pos, uv, [...idx, ...idxPaved]);
      let mesh: THREE.Mesh;
      if (idxPaved.length) {
        geo.addGroup(0, idx.length, 0);
        geo.addGroup(idx.length, idxPaved.length, 1);
        const asphalt = new THREE.MeshLambertMaterial({ map: textures.secondary, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: mat.polygonOffsetUnits });
        mesh = new THREE.Mesh(geo, [mat, asphalt]);
      } else mesh = new THREE.Mesh(geo, mat);
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
    // Boxes are written straight into one buffer from a unit-box template
    // (much cheaper than a BoxGeometry per part plus a merge).
    const tpl = Roads.unitBox();
    const pos: number[] = [];
    const nor: number[] = [];
    const uv: number[] = [];
    const deckW = half * 2 + 0.8;
    for (let i = a; i < b; i++) {
      const p0 = path[i];
      const p1 = path[i + 1];
      const len = p0.distanceTo(p1) + 0.3;
      const ang = Math.atan2(-(p1.y - p0.y), p1.x - p0.x);
      const y = (road[i] + road[i + 1]) / 2;
      const cx = (p0.x + p1.x) / 2;
      const cz = (p0.y + p1.y) / 2;
      const co = Math.cos(ang);
      const si = Math.sin(ang);
      const box = (sx: number, sy: number, sz: number, ox: number, oy: number, oz: number) => {
        const tp = tpl.p;
        const tn = tpl.n;
        for (let k = 0; k < tp.length; k += 3) {
          const lx = tp[k] * sx + ox;
          const lz = tp[k + 2] * sz + oz;
          pos.push(cx + lx * co + lz * si, y + tp[k + 1] * sy + oy, cz - lx * si + lz * co);
          nor.push(tn[k] * co + tn[k + 2] * si, tn[k + 1], -tn[k] * si + tn[k + 2] * co);
        }
        for (let k = 0; k < tpl.uv.length; k++) uv.push(tpl.uv[k]);
      };
      box(len, 0.8, deckW, 0, -0.35, 0);
      // Parapets with a kerb inside them (left open where roads meet).
      const atPad = this.padsNear(cx, cz).some((pd) => Math.hypot(pd.x - cx, pd.z - cz) < Roads.PAD_R + 6);
      if (!atPad)
        for (const sd of [1, -1]) {
          box(len, 0.95, 0.3, 0, 0.5, sd * (half + 0.25));
          box(len, 0.18, 0.6, 0, 0.12, sd * (half - 0.15));
        }
      // Girder under the deck edges.
      for (const sd of [1, -1]) box(len, 1.2, 0.5, 0, -1.3, sd * (half - 1.2));
      if ((i - a) % 3 === 1) {
        const bottom = Math.min(ground[i], 0) - 3;
        const h = y - 0.7 - bottom;
        if (h > 0.5) {
          box(1.8, h, half * 2 - 1.5, 0, -0.7 - h / 2, 0);
          box(2.4, 0.8, half * 2 + 0.2, 0, -1.3, 0);
        }
      }
      this.decks.push({ x0: p0.x, z0: p0.y, x1: p1.x, z1: p1.y, y0: road[i] + 0.05, y1: road[i + 1] + 0.05, w: half });
      colliders?.add({ soft: true, minX: cx - len / 2 - half, maxX: cx + len / 2 + half, minY: y - 1, maxY: y + 1, minZ: cz - len / 2 - half, maxZ: cz + len / 2 + half });
    }
    if (!pos.length) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    const mesh = new THREE.Mesh(g, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.group.add(mesh);
    this.bridgeCount++;
  }

  bridgeCount = 0;

  private static boxTpl?: { p: Float32Array; n: Float32Array; uv: Float32Array };
  private static unitBox() {
    if (!Roads.boxTpl) {
      const g = new THREE.BoxGeometry(1, 1, 1).toNonIndexed();
      Roads.boxTpl = { p: g.attributes.position.array as Float32Array, n: g.attributes.normal.array as Float32Array, uv: g.attributes.uv.array as Float32Array };
    }
    return Roads.boxTpl;
  }
}
