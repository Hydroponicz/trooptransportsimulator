import type { Roads } from '../world/roads';

/** A turn the route takes at a junction. `turn` is radians, + to the right. */
export interface Maneuver {
  /** Distance along the route (m). */
  s: number;
  x: number;
  z: number;
  turn: number;
  kind: 'left' | 'right' | 'slight-left' | 'slight-right' | 'straight' | 'sharp-left' | 'sharp-right';
}

export interface Route {
  /** Road points from where the player joins the road to where they leave it (x, z pairs). */
  pts: Float32Array;
  /** Distance along the route at each point. */
  cum: Float32Array;
  length: number;
  maneuvers: Maneuver[];
  /** Where the trip really starts and ends (off the road, e.g. inside a base). */
  from: { x: number; z: number };
  to: { x: number; z: number };
}

/** Prefer the better roads a little, like a satnav: a track counts as a bit longer than it is. */
const COST = { main: 1, secondary: 1.08, track: 1.3 } as const;
/** Turning round on the spot to go the other way counts as this much extra road. */
const UTURN = 350;
/** A road that stops this close to another (at a junction pad or a town square) joins it. */
const GAP = 25;

/** A piece of road between two junctions (pi = -1: a short link across a junction pad). */
interface Edge {
  pi: number;
  /** Sample range along the road. */
  a: number;
  b: number;
  n0: number;
  n1: number;
  len: number;
  cost: number;
}

/**
 * The road network as a graph for the ground vehicle's GPS: junctions and
 * road ends are nodes, pieces of road between them edges. Roads that stop a
 * few metres short of another (at a junction pad) are linked to it, at its
 * end or partway along it.
 */
export class RoadGraph {
  private nodeX: number[] = [];
  private nodeZ: number[] = [];
  private adj: number[][] = [];
  private edges: Edge[] = [];
  /** Per road: its edges in order along it. */
  private roadEdges: number[][] = [];
  /** Per road: cumulative length at each sample. */
  cum: Float32Array[] = [];
  /** Per road: which connected part of the network it is in. */
  comp: Int32Array;
  mainComp = 0;

  constructor(
    private roads: Roads,
    towns: { x: number; z: number; r: number }[] = [],
  ) {
    const paths = roads.paths;
    for (const p of paths) {
      const c = new Float32Array(p.length);
      for (let i = 1; i < p.length; i++) c[i] = c[i - 1] + Math.hypot(p[i].x - p[i - 1].x, p[i].y - p[i - 1].y);
      this.cum.push(c);
    }
    // Road ends within a few metres of each other are the same junction.
    const cells = new Map<number, number[]>();
    const C = 8;
    const addNode = (x: number, z: number) => {
      const n = this.nodeX.length;
      this.nodeX.push(x);
      this.nodeZ.push(z);
      this.adj.push([]);
      return n;
    };
    const endNode = (x: number, z: number): number => {
      const cx = Math.floor(x / C);
      const cz = Math.floor(z / C);
      for (let i = -1; i <= 1; i++)
        for (let j = -1; j <= 1; j++)
          for (const n of cells.get((cx + i) * 100003 + (cz + j)) ?? []) if (Math.hypot(this.nodeX[n] - x, this.nodeZ[n] - z) < 6) return n;
      const n = addNode(x, z);
      const k = cx * 100003 + cz;
      const arr = cells.get(k);
      if (arr) arr.push(n);
      else cells.set(k, [n]);
      return n;
    };
    const ends = paths.map((p) => [endNode(p[0].x, p[0].y), endNode(p[p.length - 1].x, p[p.length - 1].y)]);
    // Roads that stop short of another: link the end to the other road's end
    // when that's close, else to a junction partway along it.
    const breaks: Map<number, number>[] = paths.map(() => new Map());
    const uses = new Int32Array(this.nodeX.length);
    for (const [a, b] of ends) uses[a]++, uses[b]++;
    const links: { from: number; pi: number; i: number; d: number; toEnd: number }[] = [];
    paths.forEach((p, pi) => {
      for (const [q, n] of [
        [p[0], ends[pi][0]],
        [p[p.length - 1], ends[pi][1]],
      ] as const) {
        // Already a junction with another road here.
        if (uses[n] > 1) continue;
        const hit = roads.nearest(q.x, q.y, GAP, (o) => o !== pi);
        if (!hit) continue;
        const op = paths[hit.pi];
        const along = this.cum[hit.pi][hit.i] + (this.cum[hit.pi][hit.i + 1] - this.cum[hit.pi][hit.i]) * hit.t;
        const total = this.cum[hit.pi][op.length - 1];
        if (along < 15) links.push({ from: n, pi: hit.pi, i: 0, d: Math.hypot(q.x - op[0].x, q.y - op[0].y), toEnd: ends[hit.pi][0] });
        else if (total - along < 15) links.push({ from: n, pi: hit.pi, i: op.length - 1, d: Math.hypot(q.x - op[op.length - 1].x, q.y - op[op.length - 1].y), toEnd: ends[hit.pi][1] });
        else {
          const i = hit.t < 0.5 ? hit.i : hit.i + 1;
          links.push({ from: n, pi: hit.pi, i, d: Math.hypot(q.x - op[i].x, q.y - op[i].y), toEnd: -1 });
          if (!breaks[hit.pi].has(i)) breaks[hit.pi].set(i, addNode(op[i].x, op[i].y));
        }
      }
    });
    // Roads that cross mid-way: a junction on each, joined.
    const cross: { na: [number, number]; nb: [number, number] }[] = [];
    const breakAt = (pi: number, i: number) => {
      const p = paths[pi];
      if (i <= 0) return { end: ends[pi][0] };
      if (i >= p.length - 1) return { end: ends[pi][1] };
      if (!breaks[pi].has(i)) breaks[pi].set(i, addNode(p[i].x, p[i].y));
      return { pi, i };
    };
    for (const c of roads.crossings()) {
      // The nearer sample of each crossing segment.
      const pick = (pi: number, i: number) => {
        const p = paths[pi];
        return Math.hypot(p[i].x - c.x, p[i].y - c.z) <= Math.hypot(p[i + 1].x - c.x, p[i + 1].y - c.z) ? i : i + 1;
      };
      const a = breakAt(c.pa, pick(c.pa, c.ia));
      const b = breakAt(c.pb, pick(c.pb, c.ib));
      cross.push({ na: 'end' in a ? [-1, a.end!] : [a.pi!, a.i!], nb: 'end' in b ? [-1, b.end!] : [b.pi!, b.i!] });
    }
    // Each road cut into edges at its ends and junctions.
    const addEdge = (e: Edge) => {
      const k = this.edges.length;
      this.edges.push(e);
      this.adj[e.n0].push(k);
      if (e.n1 !== e.n0) this.adj[e.n1].push(k);
      return k;
    };
    paths.forEach((p, pi) => {
      const cuts = [...breaks[pi].keys()].filter((i) => i > 0 && i < p.length - 1).sort((x, y) => x - y);
      const at = [0, ...cuts, p.length - 1];
      const list: number[] = [];
      for (let k = 1; k < at.length; k++) {
        const a = at[k - 1];
        const b = at[k];
        const n0 = k === 1 ? ends[pi][0] : breaks[pi].get(a)!;
        const n1 = k === at.length - 1 ? ends[pi][1] : breaks[pi].get(b)!;
        const len = this.cum[pi][b] - this.cum[pi][a];
        list.push(addEdge({ pi, a, b, n0, n1, len, cost: len * COST[roads.classes[pi]] }));
      }
      this.roadEdges.push(list);
    });
    const link = (n0: number, n1: number, cost = 1) => {
      if (n0 === n1) return;
      const len = Math.hypot(this.nodeX[n0] - this.nodeX[n1], this.nodeZ[n0] - this.nodeZ[n1]);
      addEdge({ pi: -1, a: 0, b: 0, n0, n1, len, cost: len * cost });
    };
    for (const l of links) link(l.from, l.toEnd >= 0 ? l.toEnd : breaks[l.pi].get(l.i)!);
    const crossNode = ([pi, v]: [number, number]) => (pi < 0 ? v : breaks[pi].get(v)!);
    for (const c of cross) link(crossNode(c.na), crossNode(c.nb));
    // Roads that end at a town's edge carry on through its streets: link each such end to the others.
    for (const t of towns) {
      const inside: number[] = [];
      for (let n = 0; n < this.nodeX.length; n++) if (Math.hypot(this.nodeX[n] - t.x, this.nodeZ[n] - t.z) < t.r * 1.1 && this.adj[n].length === 1) inside.push(n);
      for (let a = 0; a < inside.length; a++) for (let b = a + 1; b < inside.length; b++) link(inside[a], inside[b], 1.2);
    }
    // Connected parts, so routes are only planned on the part the vehicle can reach.
    const nodeComp = new Int32Array(this.nodeX.length).fill(-1);
    const sizes: number[] = [];
    for (let s0 = 0; s0 < nodeComp.length; s0++) {
      if (nodeComp[s0] >= 0) continue;
      const c = sizes.length;
      let size = 0;
      const stack = [s0];
      nodeComp[s0] = c;
      while (stack.length) {
        const n = stack.pop()!;
        size++;
        for (const e of this.adj[n]) {
          const E = this.edges[e];
          for (const o of [E.n0, E.n1])
            if (nodeComp[o] < 0) {
              nodeComp[o] = c;
              stack.push(o);
            }
        }
      }
      sizes.push(size);
    }
    this.comp = new Int32Array(paths.length);
    paths.forEach((_, pi) => (this.comp[pi] = nodeComp[ends[pi][0]]));
    this.mainComp = sizes.indexOf(Math.max(...sizes));
    this.parts = sizes.length;
  }

  /** How many separate pieces the network is in (for tests). */
  parts = 0;

  get nodeCount() {
    return this.nodeX.length;
  }

  /** The edge of road pi that contains sample i. */
  private edgeAt(pi: number, i: number): Edge {
    for (const k of this.roadEdges[pi]) {
      const e = this.edges[k];
      if (i >= e.a && i < e.b) return e;
    }
    return this.edges[this.roadEdges[pi][this.roadEdges[pi].length - 1]];
  }

  /**
   * Shortest route by road from (ax, az) to (bx, bz). `heading` (radians,
   * 0 = north, clockwise) makes turning round cost extra when the vehicle is
   * already rolling. Null when there is no road near either end or they
   * aren't connected.
   */
  route(ax: number, az: number, bx: number, bz: number, heading?: number): Route | null {
    const R = this.roads;
    // Join the main network if it's near, else whatever road is nearest; finish on the same piece.
    const main = (pi: number) => this.comp[pi] === this.mainComp;
    const S = R.nearest(ax, az, 400, main) ?? R.nearest(ax, az, 400) ?? R.nearest(ax, az, 3000);
    if (!S) return null;
    const same = (pi: number) => this.comp[pi] === this.comp[S.pi];
    const D = R.nearest(bx, bz, 3000, same);
    if (!D) return null;
    const sAlong = this.cum[S.pi][S.i] + (this.cum[S.pi][S.i + 1] - this.cum[S.pi][S.i]) * S.t;
    const dAlong = this.cum[D.pi][D.i] + (this.cum[D.pi][D.i + 1] - this.cum[D.pi][D.i]) * D.t;
    const eS = this.edgeAt(S.pi, S.i);
    const eD = this.edgeAt(D.pi, D.i);
    const k = (e: Edge) => e.cost / (e.len || 1);
    // Which way along the start road is "ahead"?
    let fwdPenalty = 0;
    let backPenalty = 0;
    if (heading !== undefined) {
      const p = R.paths[S.pi];
      const tx = p[S.i + 1].x - p[S.i].x;
      const tz = p[S.i + 1].y - p[S.i].y;
      const along = (tx * Math.sin(heading) - tz * Math.cos(heading)) / (Math.hypot(tx, tz) || 1);
      if (along > 0.3) backPenalty = UTURN;
      else if (along < -0.3) fwdPenalty = UTURN;
    }
    const N = this.nodeX.length;
    const dist = new Float64Array(N).fill(Infinity);
    const prevEdge = new Int32Array(N).fill(-1);
    const prevNode = new Int32Array(N).fill(-1);
    const c0 = this.cum[S.pi];
    const startA = (sAlong - c0[eS.a]) * k(eS) + backPenalty;
    const startB = (c0[eS.b] - sAlong) * k(eS) + fwdPenalty;
    const heap = new Heap();
    if (startA < dist[eS.n0]) (dist[eS.n0] = startA), heap.push(eS.n0, startA);
    if (startB < dist[eS.n1]) (dist[eS.n1] = startB), heap.push(eS.n1, startB);
    while (heap.size) {
      const [n, dn] = heap.pop();
      if (dn > dist[n]) continue;
      for (const ei of this.adj[n]) {
        const e = this.edges[ei];
        const other = e.n0 === n ? e.n1 : e.n0;
        const nd = dn + e.cost;
        if (nd < dist[other]) {
          dist[other] = nd;
          prevEdge[other] = ei;
          prevNode[other] = n;
          heap.push(other, nd);
        }
      }
    }
    // Onto the destination edge from either end, or straight along it if we start on it.
    const c1 = this.cum[D.pi];
    const viaA = dist[eD.n0] + (dAlong - c1[eD.a]) * k(eD);
    const viaB = dist[eD.n1] + (c1[eD.b] - dAlong) * k(eD);
    const direct = eS === eD ? Math.abs(dAlong - sAlong) * k(eS) + (dAlong >= sAlong ? fwdPenalty : backPenalty) : Infinity;
    const best = Math.min(viaA, viaB, direct);
    if (!isFinite(best)) return null;

    // Lay out the points.
    const pts: number[] = [];
    const push = (x: number, z: number) => {
      const n = pts.length;
      if (n && Math.abs(pts[n - 2] - x) < 0.01 && Math.abs(pts[n - 1] - z) < 0.01) return;
      pts.push(x, z);
    };
    /** Samples of road pi strictly between distances `from` and `to` along it (either way round). */
    const along = (pi: number, from: number, to: number) => {
      const c = this.cum[pi];
      const p = R.paths[pi];
      if (to >= from) {
        for (let i = 0; i < p.length; i++) if (c[i] > from && c[i] < to) push(p[i].x, p[i].y);
      } else {
        for (let i = p.length - 1; i >= 0; i--) if (c[i] < from && c[i] > to) push(p[i].x, p[i].y);
      }
    };
    const junctions: { at: number; node: number }[] = [];
    const node = (n: number) => {
      push(this.nodeX[n], this.nodeZ[n]);
      junctions.push({ at: pts.length / 2 - 1, node: n });
    };
    push(S.x, S.z);
    if (best === direct) {
      along(S.pi, sAlong, dAlong);
    } else {
      const end = best === viaA ? eD.n0 : eD.n1;
      const chain: { e: Edge; from: number }[] = [];
      let first = end;
      for (let n = end; prevEdge[n] >= 0; n = prevNode[n]) {
        chain.push({ e: this.edges[prevEdge[n]], from: prevNode[n] });
        first = prevNode[n];
      }
      chain.reverse();
      along(S.pi, sAlong, first === eS.n0 && (first !== eS.n1 || startA <= startB) ? c0[eS.a] : c0[eS.b]);
      node(first);
      for (const { e, from } of chain) {
        const fwd = e.n0 === from;
        if (e.pi >= 0) {
          const c = this.cum[e.pi];
          along(e.pi, fwd ? c[e.a] : c[e.b], fwd ? c[e.b] : c[e.a]);
        }
        node(fwd ? e.n1 : e.n0);
      }
      along(D.pi, end === eD.n0 ? c1[eD.a] : c1[eD.b], dAlong);
    }
    push(D.x, D.z);
    const P = new Float32Array(pts);
    const cum = new Float32Array(P.length / 2);
    for (let i = 1; i < cum.length; i++) cum[i] = cum[i - 1] + Math.hypot(P[i * 2] - P[i * 2 - 2], P[i * 2 + 1] - P[i * 2 - 1]);
    const route: Route = { pts: P, cum, length: cum[cum.length - 1], maneuvers: [], from: { x: ax, z: az }, to: { x: bx, z: bz } };
    // A turn to call at each junction where there's a choice to make (short pad links merge into one).
    let last = -Infinity;
    for (const { at, node: n } of junctions) {
      if (this.adj[n].length < 3) continue;
      const s = cum[at];
      const a = pointAt(route, s - 25);
      const b = pointAt(route, s + 25);
      const x = P[at * 2];
      const z = P[at * 2 + 1];
      const h0 = Math.atan2(x - a.x, -(z - a.z));
      const h1 = Math.atan2(b.x - x, -(b.z - z));
      let turn = h1 - h0;
      turn = Math.atan2(Math.sin(turn), Math.cos(turn));
      const deg = (Math.abs(turn) * 180) / Math.PI;
      const side = turn > 0 ? 'right' : 'left';
      const kind: Maneuver['kind'] = deg < 20 ? 'straight' : deg < 50 ? (`slight-${side}` as const) : deg < 130 ? side : (`sharp-${side}` as const);
      if (s - last < 30 && route.maneuvers.length) {
        // Two junctions a pad apart: one turn, whichever is the bigger.
        const prev = route.maneuvers[route.maneuvers.length - 1];
        if (Math.abs(turn) > Math.abs(prev.turn)) route.maneuvers[route.maneuvers.length - 1] = { s: prev.s, x: prev.x, z: prev.z, turn, kind };
        continue;
      }
      route.maneuvers.push({ s, x, z, turn, kind });
      last = s;
    }
    return route;
  }
}

/** The point `s` metres along a route (clamped to its ends). */
export function pointAt(r: Route, s: number): { x: number; z: number } {
  const c = r.cum;
  if (s <= 0) return { x: r.pts[0], z: r.pts[1] };
  if (s >= r.length) return { x: r.pts[r.pts.length - 2], z: r.pts[r.pts.length - 1] };
  let lo = 0;
  let hi = c.length - 1;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (c[m] <= s) lo = m;
    else hi = m;
  }
  const t = (s - c[lo]) / (c[hi] - c[lo] || 1);
  return { x: r.pts[lo * 2] + (r.pts[hi * 2] - r.pts[lo * 2]) * t, z: r.pts[lo * 2 + 1] + (r.pts[hi * 2 + 1] - r.pts[lo * 2 + 1]) * t };
}

/** Binary min-heap of (node, key). */
class Heap {
  private n: number[] = [];
  private k: number[] = [];
  get size() {
    return this.n.length;
  }
  push(node: number, key: number) {
    const n = this.n;
    const k = this.k;
    let i = n.length;
    n.push(node);
    k.push(key);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= key) break;
      n[i] = n[p];
      k[i] = k[p];
      i = p;
    }
    n[i] = node;
    k[i] = key;
  }
  pop(): [number, number] {
    const n = this.n;
    const k = this.k;
    const top: [number, number] = [n[0], k[0]];
    const ln = n.pop()!;
    const lk = k.pop()!;
    if (n.length) {
      let i = 0;
      for (;;) {
        let c = i * 2 + 1;
        if (c >= n.length) break;
        if (c + 1 < n.length && k[c + 1] < k[c]) c++;
        if (k[c] >= lk) break;
        n[i] = n[c];
        k[i] = k[c];
        i = c;
      }
      n[i] = ln;
      k[i] = lk;
    }
    return top;
  }
}

/**
 * Follows the vehicle along its route: how far along it is, the next turn,
 * and a fresh route when it leaves the planned road.
 */
export class Gps {
  route: Route | null = null;
  /** Distance along the route the vehicle has got to. */
  progress = 0;
  /** How far the vehicle is from the route line. */
  offRoute = 0;
  /** Set while a new route is being worked out after leaving the old one. */
  recalculating = false;
  private dest: { x: number; z: number } | null = null;
  private idx = 0;
  private offT = 0;
  private sinceRoute = 0;
  /** Closest the vehicle has been to the route's start before joining it. */
  private joinDist = Infinity;
  readonly graph: RoadGraph;

  constructor(roads: Roads, towns: { x: number; z: number; r: number }[] = []) {
    this.graph = new RoadGraph(roads, towns);
  }

  /** Point the GPS at a destination (null switches it off). */
  setDestination(d: { x: number; z: number } | null) {
    if (!d) {
      this.dest = null;
      this.route = null;
      return;
    }
    if (this.dest && Math.hypot(this.dest.x - d.x, this.dest.z - d.z) < 25) return;
    this.dest = { x: d.x, z: d.z };
    this.route = null;
  }

  get destination() {
    return this.dest;
  }

  update(dt: number, x: number, z: number, heading: number, speed: number) {
    if (!this.dest) return;
    this.sinceRoute += dt;
    if (!this.route) {
      this.plan(x, z, heading, speed);
      return;
    }
    const r = this.route;
    // Nearest point on the route ahead of (or a little behind) where we were.
    const P = r.pts;
    const n = r.cum.length;
    const search = (lo: number, hi: number) => {
      let best = Infinity;
      let bi = this.idx;
      let bs = this.progress;
      for (let i = Math.max(0, lo); i < Math.min(n - 1, hi); i++) {
        const ax = P[i * 2];
        const az = P[i * 2 + 1];
        const dx = P[i * 2 + 2] - ax;
        const dz = P[i * 2 + 3] - az;
        const l2 = dx * dx + dz * dz || 1;
        const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
        const d = Math.hypot(x - (ax + dx * t), z - (az + dz * t));
        if (d < best) {
          best = d;
          bi = i;
          bs = r.cum[i] + (r.cum[i + 1] - r.cum[i]) * t;
        }
      }
      return { best, bi, bs };
    };
    let f = search(this.idx - 10, this.idx + 120);
    if (f.best > 30) {
      const all = search(0, n);
      if (all.best < f.best - 5) f = all;
    }
    this.idx = f.bi;
    this.progress = f.bs;
    // Before joining the route (still in the base, say), distance to its start counts as on course.
    const toStart = Math.hypot(x - P[0], z - P[1]);
    this.offRoute = this.progress < 1 ? Math.min(f.best, toStart) : f.best;
    // Lost: off the planned road, or (not on it yet) heading somewhere else entirely.
    const lost = this.progress > 1 ? f.best > 30 : this.offRoute > 150 && this.offRoute > this.joinDist + 60;
    if (this.progress <= 1) this.joinDist = Math.min(this.joinDist, this.offRoute);
    this.offT = lost ? this.offT + dt : 0;
    this.recalculating = this.offT > 0.6;
    if (this.offT > 2 && this.sinceRoute > 2) this.plan(x, z, heading, speed);
  }

  private plan(x: number, z: number, heading: number, speed: number) {
    const d = this.dest!;
    this.route = this.graph.route(x, z, d.x, d.z, speed > 2 ? heading : undefined);
    this.idx = 0;
    this.progress = 0;
    this.joinDist = Infinity;
    this.offT = 0;
    this.sinceRoute = 0;
    this.recalculating = false;
  }

  /** Road distance left (plus the straight bits off the road at either end). */
  get remaining(): number {
    const r = this.route;
    if (!r) return this.dest ? Infinity : 0;
    const end = pointAt(r, r.length);
    return Math.max(0, r.length - this.progress) + Math.hypot(r.to.x - end.x, r.to.z - end.z);
  }

  /** The next turn ahead, if any. */
  get next(): Maneuver | null {
    const r = this.route;
    if (!r) return null;
    for (const m of r.maneuvers) if (m.s > this.progress + 3 && m.kind !== 'straight') return m;
    return null;
  }

  /** The turn after `m`, if it comes soon after (for "then turn left"). */
  after(m: Maneuver): Maneuver | null {
    const r = this.route;
    if (!r) return null;
    for (const o of r.maneuvers) if (o.s > m.s + 1 && o.kind !== 'straight') return o.s - m.s < 250 ? o : null;
    return null;
  }
}
