import * as THREE from 'three';
import type { Noise2D, RNG } from '../util/noise';
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
  r: number;
}

const GRID = 40;
/** 1.8 km chunks, for culling. */
const CHUNKS = Math.round(WORLD_SIZE / 1800);
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

/** Instanced forests, chunked for culling, with a point-vs-tree hit test for rotor strikes. */
export class Vegetation {
  group = new THREE.Group();
  private grid = new Map<number, Tree[]>();
  count = 0;

  constructor(terrain: Terrain, noise: Noise2D, rng: RNG, blocked: (x: number, z: number) => boolean, culler: DistanceCuller, shadows?: ShadowCasters) {
    const kinds = [pineGeo(), broadGeo(), deadGeo(), birchGeo()];
    const loGeo = farTree();
    const material = withSurfaces(new THREE.MeshLambertMaterial({ vertexColors: true }));
    const buckets: THREE.Matrix4[][][] = [];
    // Per chunk, per kind (spruce, broadleaf, dead, birch).
    const colors: THREE.Color[][][] = [];
    for (let c = 0; c < CHUNKS * CHUNKS; c++) {
      buckets.push([[], [], [], []]);
      colors.push([[], [], [], []]);
    }
    const spacing = 19;
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const nrm = new THREE.Vector3();
    for (let gz = -HALF + 50; gz < HALF - 50; gz += spacing) {
      for (let gx = -HALF + 50; gx < HALF - 50; gx += spacing) {
        const x = gx + rng.range(-spacing * 0.45, spacing * 0.45);
        const z = gz + rng.range(-spacing * 0.45, spacing * 0.45);
        const forest = noise.fbm(x * 0.0011 + 40, z * 0.0011, 3) * 0.5 + 0.5;
        const sd = terrain.front.side(x, z);
        const nearFront = 1 - smoothstep(80, 450, Math.abs(sd));
        let p = smoothstep(0.5, 0.72, forest) * 0.8 + 0.015;
        p *= 1 - nearFront * 0.55;
        if (!rng.chance(p)) continue;
        const y = terrain.heightAt(x, z);
        if (y < 2.5 || y > 520) continue;
        terrain.normalAt(x, z, nrm);
        if (nrm.y < 0.78) continue;
        if (blocked(x, z)) continue;
        const dead = rng.chance(nearFront * 0.85);
        // Spruce in the deep forest and up the hills; oak, lime and birch in the open country.
        const kind = dead ? 2 : forest > 0.62 || y > 150 ? (rng.chance(0.8) ? 0 : rng.chance(0.5) ? 1 : 3) : rng.chance(0.3) ? 0 : rng.chance(0.3) ? 3 : 1;
        const s = rng.range(0.8, 1.55) * (kind === 2 ? 0.9 : 1);
        q.setFromAxisAngle(up, rng.range(0, Math.PI * 2));
        const m = new THREE.Matrix4().compose(new THREE.Vector3(x, y - 0.2, z), q, new THREE.Vector3(s, s * rng.range(0.9, 1.15), s));
        const cx = Math.min(CHUNKS - 1, Math.floor(((x + HALF) / (HALF * 2)) * CHUNKS));
        const cz = Math.min(CHUNKS - 1, Math.floor(((z + HALF) / (HALF * 2)) * CHUNKS));
        const ci = cz * CHUNKS + cx;
        buckets[ci][kind].push(m);
        const v = rng.range(0.82, 1.12);
        colors[ci][kind].push(new THREE.Color(v, v * rng.range(0.96, 1.04), v * 0.95));
        const h = (kind === 2 ? 6 : kind === 0 ? 10 : kind === 3 ? 8.2 : 7) * s;
        const r = (kind === 2 ? 0.8 : kind === 0 ? 2.4 : kind === 3 ? 1.6 : 2.6) * s;
        this.insert({ x, z, y, h, r });
      }
    }
    for (let ci = 0; ci < CHUNKS * CHUNKS; ci++) {
      // Full trees: one mesh per kind.
      let sphere: THREE.Sphere | null = null;
      for (let k = 0; k < 4; k++) {
        const list = buckets[ci][k];
        if (!list.length) continue;
        const mesh = new THREE.InstancedMesh(kinds[k], material, list.length);
        list.forEach((m, i) => {
          mesh.setMatrixAt(i, m);
          mesh.setColorAt(i, colors[ci][k][i]);
        });
        // Shadows come from the near-caster copies (see shadows.ts) when those are in use.
        mesh.castShadow = !shadows;
        shadows?.add(kinds[k], list);
        mesh.receiveShadow = true;
        mesh.computeBoundingSphere();
        this.group.add(mesh);
        culler.add(mesh, mesh.boundingSphere!.center, mesh.boundingSphere!.radius + 30, HI_DIST);
        sphere = sphere ? sphere.union(mesh.boundingSphere!) : mesh.boundingSphere!.clone();
      }
      if (!sphere) continue;
      // Far away: every tree in the chunk is one simple stand-in, tinted by kind, in a single draw call.
      const all = [0, 1, 2, 3].flatMap((k) => buckets[ci][k].map((m, i) => ({ m, c: colors[ci][k][i].clone().multiply(LO_TINT[k]) })));
      const lo = new THREE.InstancedMesh(loGeo, material, all.length);
      all.forEach(({ m, c }, i) => {
        lo.setMatrixAt(i, m);
        lo.setColorAt(i, c);
      });
      lo.computeBoundingSphere();
      this.group.add(lo);
      culler.add(lo, sphere.center, sphere.radius + 30, LO_DIST, HI_DIST);
    }
  }

  private insert(t: Tree) {
    this.count++;
    const k = Math.floor(t.x / GRID) + 1000 + (Math.floor(t.z / GRID) + 1000) * 3000;
    let arr = this.grid.get(k);
    if (!arr) this.grid.set(k, (arr = []));
    arr.push(t);
  }

  /** Is a world point inside a tree's crown/trunk volume? */
  hit(p: THREE.Vector3): boolean {
    const gx = Math.floor(p.x / GRID);
    const gz = Math.floor(p.z / GRID);
    for (let dz = -1; dz <= 1; dz++)
      for (let dx = -1; dx <= 1; dx++) {
        const arr = this.grid.get(gx + dx + 1000 + (gz + dz + 1000) * 3000);
        if (!arr) continue;
        for (const t of arr) {
          const ddx = p.x - t.x;
          const ddz = p.z - t.z;
          if (ddx * ddx + ddz * ddz < t.r * t.r * 0.7 && p.y < t.y + t.h && p.y > t.y - 1) return true;
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
        const arr = this.grid.get(gx + dx + 1000 + (gz + dz + 1000) * 3000);
        if (!arr) continue;
        for (const t of arr) if (Math.hypot(x - t.x, z - t.z) < radius) return true;
      }
    return false;
  }
}
