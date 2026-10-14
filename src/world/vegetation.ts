import * as THREE from 'three';
import type { Noise2D, RNG } from '../util/noise';
import { smoothstep } from '../util/math';
import { merge, part } from './props';
import { HALF, type Terrain } from './terrain';

interface Tree {
  x: number;
  z: number;
  y: number;
  h: number;
  r: number;
}

const GRID = 40;
const CHUNKS = 5;

function pineGeo() {
  return merge([
    part(new THREE.CylinderGeometry(0.22, 0.32, 2.6, 5, 1, true), 0x4a3a28, 0, 1.3, 0),
    part(new THREE.ConeGeometry(2.3, 5, 6), 0x34502c, 0, 4.4, 0),
    part(new THREE.ConeGeometry(1.6, 3.6, 6), 0x3b5a30, 0, 6.8, 0),
  ]);
}
function broadGeo() {
  return merge([
    part(new THREE.CylinderGeometry(0.25, 0.38, 3.2, 5, 1, true), 0x4d3c29, 0, 1.6, 0),
    part(new THREE.IcosahedronGeometry(2.7, 0), 0x56682f, 0, 4.8, 0, 0, 0, 0, 1, 0.8, 1),
  ]);
}
function deadGeo() {
  return merge([
    part(new THREE.CylinderGeometry(0.12, 0.3, 6, 5, 1, true), 0x2e2a24, 0, 3, 0),
    part(new THREE.CylinderGeometry(0.05, 0.1, 2.2, 4, 1, true), 0x2e2a24, 0.6, 4.2, 0, 0, 0, -0.8),
    part(new THREE.CylinderGeometry(0.05, 0.1, 1.8, 4, 1, true), 0x2e2a24, -0.5, 3.4, 0.2, 0.3, 0, 0.9),
  ]);
}

/** Instanced forests, chunked for culling, with a point-vs-tree hit test for rotor strikes. */
export class Vegetation {
  group = new THREE.Group();
  private grid = new Map<number, Tree[]>();
  count = 0;

  constructor(terrain: Terrain, noise: Noise2D, rng: RNG, blocked: (x: number, z: number) => boolean) {
    const kinds = [pineGeo(), broadGeo(), deadGeo()];
    const material = new THREE.MeshLambertMaterial({ vertexColors: true });
    const buckets: THREE.Matrix4[][][] = [];
    const colors: THREE.Color[][][] = [];
    for (let c = 0; c < CHUNKS * CHUNKS; c++) {
      buckets.push([[], [], []]);
      colors.push([[], [], []]);
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
        const kind = dead ? 2 : forest > 0.62 || y > 150 ? (rng.chance(0.8) ? 0 : 1) : rng.chance(0.35) ? 0 : 1;
        const s = rng.range(0.8, 1.55) * (kind === 2 ? 0.9 : 1);
        q.setFromAxisAngle(up, rng.range(0, Math.PI * 2));
        const m = new THREE.Matrix4().compose(new THREE.Vector3(x, y - 0.2, z), q, new THREE.Vector3(s, s * rng.range(0.9, 1.15), s));
        const cx = Math.min(CHUNKS - 1, Math.floor(((x + HALF) / (HALF * 2)) * CHUNKS));
        const cz = Math.min(CHUNKS - 1, Math.floor(((z + HALF) / (HALF * 2)) * CHUNKS));
        const ci = cz * CHUNKS + cx;
        buckets[ci][kind].push(m);
        const v = rng.range(0.82, 1.12);
        colors[ci][kind].push(new THREE.Color(v, v * rng.range(0.96, 1.04), v * 0.95));
        const h = (kind === 2 ? 6 : kind === 0 ? 8.5 : 7) * s;
        const r = (kind === 2 ? 0.8 : kind === 0 ? 2.2 : 2.6) * s;
        this.insert({ x, z, y, h, r });
      }
    }
    for (let ci = 0; ci < CHUNKS * CHUNKS; ci++)
      for (let k = 0; k < 3; k++) {
        const list = buckets[ci][k];
        if (!list.length) continue;
        const mesh = new THREE.InstancedMesh(kinds[k], material, list.length);
        list.forEach((m, i) => {
          mesh.setMatrixAt(i, m);
          mesh.setColorAt(i, colors[ci][k][i]);
        });
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.computeBoundingSphere();
        this.group.add(mesh);
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
