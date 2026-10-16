import * as THREE from 'three';
import { RNG, type Noise2D } from '../util/noise';
import { smoothstep } from '../util/math';
import { merge, part } from './props';
import { surf, withSurfaces } from './surfaces';
import { HALF, WORLD_SIZE, type Terrain } from './terrain';
import type { DistanceCuller } from './lod';
import type { ShadowCasters } from './shadows';

interface Tree {
  x: number;
  z: number;
  y: number;
  h: number;
  /** Crown radius. */
  r: number;
  /** Trunk radius at the ground, and the height where the crown starts. */
  tr: number;
  cb: number;
}

/** Per kind (spruce, broadleaf, dead, birch): trunk radius at the base and crown bottom, unscaled. */
const TRUNK = [0.34, 0.4, 0.3, 0.2];
const CROWN_BASE = [2.0, 2.85, 3.0, 3.5];

const GRID = 40;
/** 1.8 km chunks, for culling. */
// Small enough that the full-tree ring (shorter on lower graphics settings) culls tightly.
const CHUNKS = Math.round(WORLD_SIZE / 1200);
/** Full trees inside this distance (from the chunk's bounds), simple stand-ins out to the fog. */
const HI_DIST = 1000;
const LO_DIST = 7000;

const leaf = (g: THREE.BufferGeometry) => surf(g, 'foliage');
const wood = (g: THREE.BufferGeometry) => surf(g, 'bark');

/** Spruce: a tall trunk under four tiers of needles, narrowing to a spire. */
function pineGeo() {
  const p = [wood(part(new THREE.CylinderGeometry(0.14, 0.34, 8.6, 5, 1, true), 0x4a3a2a, 0, 4.3, 0))];
  const tiers = 4;
  for (let i = 0; i < tiers; i++) {
    const t = i / (tiers - 1);
    const r = 2.5 * (1 - t * 0.75);
    const h = 3.0 - t * 0.9;
    const y = 2.0 + t * 6.0;
    // Closed cones (with a base), so a tier isn't hollow seen from below.
    p.push(leaf(part(new THREE.ConeGeometry(r, h, 7), i % 2 ? 0x2c4a2a : 0x325230, 0, y + h / 2, 0, 0, i * 0.7, 0)));
  }
  return merge(p);
}
/** Broadleaf (oak, lime, poplar): a short trunk and a lumpy crown of overlapping leaf masses. */
function broadGeo() {
  const p = [wood(part(new THREE.CylinderGeometry(0.22, 0.4, 3.6, 5, 1, true), 0x4d3c29, 0, 1.8, 0))];
  p.push(wood(part(new THREE.CylinderGeometry(0.08, 0.16, 2.2, 5, 1, true), 0x4d3c29, 0.6, 3.6, 0, 0, 0, -0.5)));
  const blobs: [number, number, number, number][] = [[0, 5.0, 0, 2.5], [1.4, 4.4, 0.6, 1.8], [-1.3, 4.6, -0.5, 1.9], [0.3, 4.3, -1.4, 1.7], [-0.4, 6.1, 0.4, 1.7], [0.9, 5.7, 1.2, 1.5]];
  blobs.forEach(([x, y, z, r], i) => p.push(leaf(part(new THREE.IcosahedronGeometry(r, 0), i % 2 ? 0x4c6a2a : 0x557530, x, y, z, 0, i * 0.9, i * 0.4, 1, 0.85, 1))));
  return merge(p);
}
/** Birch: slender white trunk, light airy crown. */
function birchGeo() {
  const p = [wood(part(new THREE.CylinderGeometry(0.1, 0.2, 7.5, 5, 1, true), 0xe4e0d4, 0, 3.75, 0))];
  const blobs: [number, number, number, number][] = [[0, 6.2, 0, 1.5], [0.6, 5.0, 0.3, 1.2], [-0.5, 5.3, -0.4, 1.25], [0.1, 7.3, 0.1, 1.0]];
  blobs.forEach(([x, y, z, r], i) => p.push(leaf(part(new THREE.IcosahedronGeometry(r, 0), 0x6e8c34, x, y, z, 0, i * 1.1, 0, 0.9, 1.25, 0.9))));
  return merge(p);
}
function deadGeo() {
  return merge([
    wood(part(new THREE.CylinderGeometry(0.12, 0.3, 6, 5, 1, true), 0x2e2a24, 0, 3, 0)),
    wood(part(new THREE.CylinderGeometry(0.05, 0.1, 2.2, 4, 1, true), 0x2e2a24, 0.6, 4.2, 0, 0, 0, -0.8)),
    wood(part(new THREE.CylinderGeometry(0.05, 0.1, 1.8, 4, 1, true), 0x2e2a24, -0.5, 3.4, 0.2, 0.3, 0, 0.9)),
  ]);
}

/** Far-away stand-in for any tree: a five-sided cone (white, tinted per instance). */
function farTree() {
  return merge([leaf(part(new THREE.ConeGeometry(2.3, 7.6, 5, 1, true), 0xffffff, 0, 4.8, 0))]);
}
/** Stand-in colours: spruce, broadleaf, dead, birch. */
const LO_TINT = [new THREE.Color(0x2f4c2c), new THREE.Color(0x52702e), new THREE.Color(0x3a352c), new THREE.Color(0x6a8634)];

/** A tree as generated: where, what, and how it's drawn. */
interface TreeRec extends Tree {
  kind: number;
  s: number;
  sy: number;
  rot: number;
  tint: number;
  tintG: number;
}

/** One chunk's trees (generated a few rows at a time), and its rotor/vehicle hit grid. */
interface ChunkData {
  trees: TreeRec[];
  grid: Map<number, TreeRec[]>;
  /** Rows of the placement grid done so far (of ROWS). */
  row: number;
  gen: Generator<void, void> | null;
  used: number;
}

/** What's drawn for a chunk now. */
interface Shown {
  state: 'hi' | 'lo';
  hi: THREE.InstancedMesh[];
  /** Per kind, the matrices handed to the shadow casters (to take back later). */
  shadowMats: THREE.Matrix4[][];
  lo: THREE.InstancedMesh | null;
}

const SPACING = 19;
const CHUNK = (HALF * 2) / CHUNKS;
const ROWS = Math.ceil(CHUNK / SPACING);
/** Chunks' worth of tree data kept round (generated again if needed). */
const KEEP_CHUNKS = 260;

/**
 * Forests, generated per 1.2 km chunk round the camera and forgotten far
 * from it. A chunk's trees come from its own seed, so it is the same every
 * time it's generated. Near chunks draw full trees (one instanced mesh per
 * kind, casting shadows through the near-caster copies), farther ones a
 * single stand-in per tree, out to the fog; nothing beyond. Hit tests
 * (rotor strikes, vehicles) generate the chunk's trees if they need to.
 */
export class Vegetation {
  group = new THREE.Group();
  /** Trees in the chunks generated so far. */
  count = 0;
  private data = new Map<number, ChunkData>();
  private shown = new Map<number, Shown>();
  private kinds: THREE.BufferGeometry[];
  private loGeo: THREE.BufferGeometry;
  private material: THREE.Material;
  private jobs: { key: number; want: 'hi' | 'lo'; d: number }[] = [];
  private planAt: THREE.Vector3 | null = null;
  private frame = 0;
  private seed: number;

  constructor(
    private terrain: Terrain,
    private noise: Noise2D,
    rng: RNG,
    private blocked: (x: number, z: number) => boolean,
    private culler: DistanceCuller,
    private shadows?: ShadowCasters,
  ) {
    this.kinds = [pineGeo(), broadGeo(), deadGeo(), birchGeo()];
    this.loGeo = farTree();
    this.material = withSurfaces(new THREE.MeshLambertMaterial({ vertexColors: true }));
    this.seed = rng.int(0, 1e9);
  }

  private chunkOf(x: number, z: number) {
    const cx = Math.min(CHUNKS - 1, Math.max(0, Math.floor((x + HALF) / CHUNK)));
    const cz = Math.min(CHUNKS - 1, Math.max(0, Math.floor((z + HALF) / CHUNK)));
    return cz * CHUNKS + cx;
  }

  /** Lay out a chunk's trees, a row of the placement grid at a time. */
  private *generate(key: number, d: ChunkData): Generator<void, void> {
    const cx = key % CHUNKS;
    const cz = (key - cx) / CHUNKS;
    const rng = new RNG((this.seed ^ Math.imul(cx + 1, 73856093) ^ Math.imul(cz + 1, 19349663)) >>> 0);
    const terrain = this.terrain;
    const noise = this.noise;
    const x0 = -HALF + cx * CHUNK;
    const z0 = -HALF + cz * CHUNK;
    for (let row = d.row; row < ROWS; row++) {
      const gz = z0 + (row + 0.5) * SPACING;
      for (let col = 0; col < ROWS; col++) {
        const gx = x0 + (col + 0.5) * SPACING;
        const x = gx + rng.range(-SPACING * 0.45, SPACING * 0.45);
        const z = gz + rng.range(-SPACING * 0.45, SPACING * 0.45);
        const pick = rng.next();
        const r1 = rng.next();
        const r2 = rng.next();
        const r3 = rng.next();
        const r4 = rng.next();
        if (x < x0 || x >= x0 + CHUNK || z < z0 || z >= z0 + CHUNK) continue;
        if (Math.abs(x) > HALF - 50 || Math.abs(z) > HALF - 50) continue;
        const forest = noise.fbm(x * 0.0011 + 40, z * 0.0011, 3) * 0.5 + 0.5;
        const sd = terrain.front.side(x, z);
        const nearFront = 1 - smoothstep(80, 450, Math.abs(sd));
        let p = smoothstep(0.5, 0.72, forest) * 0.8 + 0.015;
        p *= 1 - nearFront * 0.55;
        if (pick >= p) continue;
        // Heights worked out directly (so a chunk comes out the same whatever terrain is loaded).
        const y = terrain.groundAt(x, z);
        if (y < 2.5 || y > 520) continue;
        const e = 1.5;
        const hx = terrain.groundAt(x + e, z) - terrain.groundAt(x - e, z);
        const hz = terrain.groundAt(x, z + e) - terrain.groundAt(x, z - e);
        if (2 * e / Math.hypot(hx, 2 * e, hz) < 0.78) continue;
        if (this.blocked(x, z)) continue;
        const dead = r1 < nearFront * 0.85;
        // Spruce in the deep forest and up the hills; oak, lime and birch in the open country.
        const kind = dead ? 2 : forest > 0.62 || y > 150 ? (r2 < 0.8 ? 0 : r3 < 0.5 ? 1 : 3) : r2 < 0.3 ? 0 : r3 < 0.3 ? 3 : 1;
        const s = (0.8 + r4 * 0.75) * (kind === 2 ? 0.9 : 1);
        const h = (kind === 2 ? 6 : kind === 0 ? 10 : kind === 3 ? 8.2 : 7) * s;
        const r = (kind === 2 ? 0.8 : kind === 0 ? 2.4 : kind === 3 ? 1.6 : 2.6) * s;
        const t: TreeRec = {
          x,
          z,
          y,
          h,
          r,
          tr: TRUNK[kind] * s,
          cb: CROWN_BASE[kind] * s,
          kind,
          s,
          sy: s * rng.range(0.9, 1.15),
          rot: rng.range(0, Math.PI * 2),
          tint: rng.range(0.82, 1.12),
          tintG: rng.range(0.96, 1.04),
        };
        d.trees.push(t);
        const gk = Math.floor(x / GRID) + 1000 + (Math.floor(z / GRID) + 1000) * 3000;
        let arr = d.grid.get(gk);
        if (!arr) d.grid.set(gk, (arr = []));
        arr.push(t);
      }
      d.row = row + 1;
      yield;
    }
  }

  /** A chunk's trees, generated now if they aren't yet (or continued a little, given a deadline). */
  private chunk(key: number, deadline = Infinity): ChunkData | null {
    let d = this.data.get(key);
    if (!d) {
      d = { trees: [], grid: new Map(), row: 0, gen: null, used: this.frame };
      this.data.set(key, d);
    }
    d.used = this.frame;
    if (d.row < ROWS) {
      d.gen ??= this.generate(key, d);
      while (d.row < ROWS) {
        if (d.gen.next().done) break;
        if (performance.now() > deadline) return null;
      }
      d.gen = null;
      this.count += d.trees.length;
    }
    return d;
  }

  private matrix(t: TreeRec, y: number) {
    _q.setFromAxisAngle(_up, t.rot);
    return new THREE.Matrix4().compose(_v.set(t.x, y - 0.2, t.z), _q, _s.set(t.s, t.sy, t.s));
  }

  private hide(key: number) {
    const sh = this.shown.get(key);
    if (!sh) return;
    for (const m of sh.hi) {
      this.group.remove(m);
      m.dispose();
    }
    sh.shadowMats.forEach((mats, k) => this.shadows?.remove(this.kinds[k], mats));
    if (sh.lo) {
      this.group.remove(sh.lo);
      sh.lo.dispose();
    }
    this.shown.delete(key);
  }

  /** Draw a chunk's trees: full trees (hi) or stand-ins (lo). */
  private show(key: number, state: 'hi' | 'lo', d: ChunkData) {
    this.hide(key);
    const sh: Shown = { state, hi: [], shadowMats: [[], [], [], []], lo: null };
    const c = new THREE.Color();
    if (state === 'hi') {
      for (let k = 0; k < 4; k++) {
        const list = d.trees.filter((t) => t.kind === k);
        if (!list.length) continue;
        const mesh = new THREE.InstancedMesh(this.kinds[k], this.material, list.length);
        const mats = list.map((t) => this.matrix(t, this.terrain.heightAt(t.x, t.z)));
        mats.forEach((m, i) => {
          mesh.setMatrixAt(i, m);
          const t = list[i];
          mesh.setColorAt(i, c.setRGB(t.tint, t.tint * t.tintG, t.tint * 0.95));
        });
        // Shadows come from the near-caster copies (see shadows.ts) when those are in use.
        mesh.castShadow = !this.shadows;
        this.shadows?.add(this.kinds[k], mats);
        sh.shadowMats[k] = mats;
        mesh.receiveShadow = true;
        mesh.computeBoundingSphere();
        this.group.add(mesh);
        sh.hi.push(mesh);
      }
    } else if (d.trees.length) {
      // Far away: every tree is one simple stand-in, tinted by kind, in a single draw call.
      const lo = new THREE.InstancedMesh(this.loGeo, this.material, d.trees.length);
      d.trees.forEach((t, i) => {
        lo.setMatrixAt(i, this.matrix(t, this.terrain.heightIfReady(t.x, t.z)));
        lo.setColorAt(i, c.setRGB(t.tint, t.tint * t.tintG, t.tint * 0.95).multiply(LO_TINT[t.kind]));
      });
      lo.computeBoundingSphere();
      this.group.add(lo);
      sh.lo = lo;
    }
    this.shown.set(key, sh);
  }

  /** Distance from the camera to a chunk's nearest point. */
  private chunkDist(key: number, cam: THREE.Vector3) {
    const cx = key % CHUNKS;
    const cz = (key - cx) / CHUNKS;
    const x0 = -HALF + cx * CHUNK;
    const z0 = -HALF + cz * CHUNK;
    const dx = Math.max(x0 - cam.x, 0, cam.x - (x0 + CHUNK));
    const dz = Math.max(z0 - cam.z, 0, cam.z - (z0 + CHUNK));
    return Math.hypot(dx, dz);
  }

  /**
   * Keep the right chunks round the camera (full trees near, stand-ins out to
   * the fog, both scaled by the graphics setting), working nearest first a
   * few milliseconds a frame (budgetMs; Infinity does it all now).
   */
  stream(cam: THREE.Vector3, budgetMs = 3) {
    this.frame++;
    const hiR = HI_DIST * this.culler.scales.lod;
    const loR = LO_DIST * this.culler.scales.far;
    if (!this.planAt || this.planAt.distanceToSquared(cam) > 40 * 40 || (this.jobs.length === 0 && this.frame % 30 === 0)) {
      this.planAt = (this.planAt ?? new THREE.Vector3()).copy(cam);
      const want = new Map<number, 'hi' | 'lo'>();
      const r = Math.ceil(loR / CHUNK) + 1;
      const c = this.chunkOf(cam.x, cam.z);
      const ccx = c % CHUNKS;
      const ccz = (c - ccx) / CHUNKS;
      for (let cz = Math.max(0, ccz - r); cz <= Math.min(CHUNKS - 1, ccz + r); cz++)
        for (let cx = Math.max(0, ccx - r); cx <= Math.min(CHUNKS - 1, ccx + r); cx++) {
          const key = cz * CHUNKS + cx;
          const d = this.chunkDist(key, cam);
          if (d < hiR) want.set(key, 'hi');
          else if (d < loR) want.set(key, 'lo');
        }
      // Hide what's no longer wanted (with a margin, so a chunk on the line doesn't flicker).
      for (const [key, sh] of this.shown) {
        const w = want.get(key);
        const d = this.chunkDist(key, cam);
        if (!w && d > loR + 200) this.hide(key);
        else if (!w || (w === 'lo' && sh.state === 'hi' && d < hiR + 150)) want.delete(key);
      }
      this.jobs = [...want].filter(([key, w]) => this.shown.get(key)?.state !== w).map(([key, w]) => ({ key, want: w, d: this.chunkDist(key, cam) }));
      this.jobs.sort((a, b) => b.d - a.d);
    }
    const deadline = performance.now() + budgetMs;
    while (this.jobs.length && performance.now() < deadline) {
      const j = this.jobs[this.jobs.length - 1];
      const d = this.chunk(j.key, deadline);
      if (!d) break;
      this.show(j.key, j.want, d);
      this.jobs.pop();
    }
    for (const key of this.shown.keys()) {
      const d = this.data.get(key);
      if (d) d.used = this.frame;
    }
    // Forget the least recently used chunks' trees beyond what we keep.
    if (this.data.size > KEEP_CHUNKS && this.frame % 60 === 0) {
      const old = [...this.data].filter(([key, d]) => !this.shown.has(key) && d.row >= ROWS).sort((a, b) => a[1].used - b[1].used);
      for (let i = 0; i < old.length && this.data.size > KEEP_CHUNKS; i++) {
        this.count -= old[i][1].trees.length;
        this.data.delete(old[i][0]);
      }
    }
  }

  /** Is a world point inside a tree's crown/trunk volume? */
  hit(p: THREE.Vector3): boolean {
    const gx = Math.floor(p.x / GRID);
    const gz = Math.floor(p.z / GRID);
    for (let dz = -1; dz <= 1; dz++)
      for (let dx = -1; dx <= 1; dx++) {
        const cxw = (gx + dx + 0.5) * GRID;
        const czw = (gz + dz + 0.5) * GRID;
        const arr = this.chunk(this.chunkOf(cxw, czw))!.grid.get(gx + dx + 1000 + (gz + dz + 1000) * 3000);
        if (!arr) continue;
        for (const t of arr) {
          const ddx = p.x - t.x;
          const ddz = p.z - t.z;
          if (p.y > t.y + t.h || p.y < t.y - 1) continue;
          // The trunk below the crown (vehicles pass under the branches), the crown above it.
          const rr = p.y < t.y + t.cb ? t.tr + 0.05 : t.r * 0.84;
          if (ddx * ddx + ddz * ddz < rr * rr) return true;
        }
      }
    return false;
  }

  /** Any tree within radius of a ground point? */
  near(x: number, z: number, radius: number): boolean {
    const gx = Math.floor(x / GRID);
    const gz = Math.floor(z / GRID);
    const span = Math.ceil(radius / GRID);
    for (let dz = -span; dz <= span; dz++)
      for (let dx = -span; dx <= span; dx++) {
        const arr = this.chunk(this.chunkOf((gx + dx + 0.5) * GRID, (gz + dz + 0.5) * GRID))!.grid.get(gx + dx + 1000 + (gz + dz + 1000) * 3000);
        if (!arr) continue;
        for (const t of arr) if (Math.hypot(x - t.x, z - t.z) < radius) return true;
      }
    return false;
  }
}

const _q = new THREE.Quaternion();
const _up = new THREE.Vector3(0, 1, 0);
const _v = new THREE.Vector3();
const _s = new THREE.Vector3();
