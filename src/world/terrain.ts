import * as THREE from 'three';
import type { Noise2D } from '../util/noise';
import { lerp, smoothstep } from '../util/math';
import type { Frontline } from './frontline';

export const WORLD_SIZE = 8000;
export const HALF = WORLD_SIZE / 2;
export const SEGS = 640;
export const CELL = WORLD_SIZE / SEGS;
export const WATER_LEVEL = 0;
/** Edge of the flyable area; beyond this the mountains wall things in. */
export const PLAY_HALF = HALF - 900;

const FIELDS = [0xa69a5e, 0x768c45, 0x7d6a4a, 0x8c9150, 0x9a8c55].map((c) => new THREE.Color(c));

export interface FlattenZone {
  x: number;
  z: number;
  radius: number;
  blend: number;
  height: number;
}

export interface Crater {
  x: number;
  z: number;
  r: number;
  depth: number;
}

const CRATER_CELL = 100;

export class Terrain {
  readonly heights = new Float32Array((SEGS + 1) * (SEGS + 1));
  flattens: FlattenZone[] = [];
  /** Settlements with farmland around them (for ground colouring). */
  farms: { x: number; z: number; rot: number; r: number }[] = [];
  craters: Crater[] = [];
  private craterGrid = new Map<number, Crater[]>();
  mesh!: THREE.Mesh;

  constructor(
    private n1: Noise2D,
    private n2: Noise2D,
    private n3: Noise2D,
    readonly front: Frontline,
  ) {}

  /** Natural terrain before any sites or craters are carved in. */
  baseHeight(x: number, z: number): number {
    // Rolling country: broad, low hills; ridges only well away from the front.
    const near = smoothstep(950, 250, Math.abs(this.front.side(x, z)));
    const c = this.n1.fbm(x * 0.00018, z * 0.00018, 4) * 0.5 + 0.5;
    let h = 14 + Math.pow(Math.max(0, c), 1.35) * 125 * (1 - 0.5 * near);
    const r = this.n2.ridged(x * 0.0007 + 31.7, z * 0.0007 - 17.3, 3);
    h += r * r * 45 * smoothstep(0.45, 0.8, c) * (1 - 0.85 * near);
    h += this.n3.fbm(x * 0.003, z * 0.003, 3) * 3.5 * (1 - 0.4 * near);
    // A meandering river valley with gentle banks.
    const rv = Math.abs(this.n2.fbm(x * 0.00018 + 91.1, z * 0.00018 - 44.2, 3));
    const cut = 1 - smoothstep(0.01, 0.06, rv);
    h = lerp(h, -4, Math.pow(cut, 1.4) * 0.95);
    // Mountains walling in the map edges.
    const d = Math.max(Math.abs(x), Math.abs(z));
    const e = smoothstep(HALF - 1100, HALF - 100, d);
    h += e * e * (420 + 220 * this.n1.fbm(x * 0.0015 + 5, z * 0.0015, 3));
    return h;
  }

  addCrater(c: Crater) {
    this.craters.push(c);
    const R = c.r * 1.6;
    const x0 = Math.floor((c.x - R + HALF) / CRATER_CELL);
    const x1 = Math.floor((c.x + R + HALF) / CRATER_CELL);
    const z0 = Math.floor((c.z - R + HALF) / CRATER_CELL);
    const z1 = Math.floor((c.z + R + HALF) / CRATER_CELL);
    for (let cx = x0; cx <= x1; cx++)
      for (let cz = z0; cz <= z1; cz++) {
        const k = cx + cz * 1000;
        let arr = this.craterGrid.get(k);
        if (!arr) this.craterGrid.set(k, (arr = []));
        arr.push(c);
      }
  }

  /** How strongly a point is inside a flatten zone (0..1). */
  siteInfluence(x: number, z: number): number {
    let best = 0;
    for (const f of this.flattens) {
      const R = f.radius + f.blend * 0.4;
      const dx = x - f.x;
      const dz = z - f.z;
      if (Math.abs(dx) > R || Math.abs(dz) > R) continue;
      best = Math.max(best, smoothstep(R, f.radius * 0.8, Math.hypot(dx, dz)));
    }
    return best;
  }

  private craterOffset(x: number, z: number): number {
    const k = Math.floor((x + HALF) / CRATER_CELL) + Math.floor((z + HALF) / CRATER_CELL) * 1000;
    const arr = this.craterGrid.get(k);
    if (!arr) return 0;
    let off = 0;
    for (const c of arr) {
      const u = Math.hypot(x - c.x, z - c.z) / c.r;
      if (u < 1) off -= c.depth * (1 - u * u);
      if (u < 1.6) {
        const q = (u - 1.05) / 0.22;
        off += c.depth * 0.35 * Math.exp(-q * q);
      }
    }
    return off;
  }

  finalHeight(x: number, z: number): number {
    let h = this.baseHeight(x, z);
    for (const f of this.flattens) {
      const R = f.radius + f.blend;
      const dx = x - f.x;
      const dz = z - f.z;
      if (Math.abs(dx) > R || Math.abs(dz) > R) continue;
      const d = Math.hypot(dx, dz);
      if (d < R) h = lerp(h, f.height, smoothstep(R, f.radius, d));
    }
    return h + this.craterOffset(x, z);
  }

  build(detailTex: THREE.Texture) {
    const N = SEGS + 1;
    const pos = new Float32Array(N * N * 3);
    const uv = new Float32Array(N * N * 2);
    for (let iz = 0; iz < N; iz++) {
      for (let ix = 0; ix < N; ix++) {
        const x = -HALF + ix * CELL;
        const z = -HALF + iz * CELL;
        const h = this.finalHeight(x, z);
        const i = iz * N + ix;
        this.heights[i] = h;
        pos[i * 3] = x;
        pos[i * 3 + 1] = h;
        pos[i * 3 + 2] = z;
        uv[i * 2] = x / 18;
        uv[i * 2 + 1] = z / 18;
      }
    }
    const index = new Uint32Array(SEGS * SEGS * 6);
    let k = 0;
    for (let iz = 0; iz < SEGS; iz++) {
      for (let ix = 0; ix < SEGS; ix++) {
        const a = iz * N + ix;
        const b = (iz + 1) * N + ix;
        const c = (iz + 1) * N + ix + 1;
        const d = iz * N + ix + 1;
        index[k++] = a;
        index[k++] = b;
        index[k++] = d;
        index[k++] = b;
        index[k++] = c;
        index[k++] = d;
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setIndex(new THREE.BufferAttribute(index, 1));
    geo.computeVertexNormals();

    const nrm = geo.getAttribute('normal') as THREE.BufferAttribute;
    const col = new Float32Array(N * N * 3);
    const C = (hex: number) => new THREE.Color(hex);
    const grass = C(0x6a7a40);
    const grass2 = C(0x87894f);
    const forest = C(0x4f6233);
    const rock = C(0x7c776c);
    const sand = C(0x9d9070);
    const mud = C(0x5e5440);
    const scorched = C(0x4a4436);
    const siteDirt = C(0x9a8a66);
    const tmp = new THREE.Color();
    for (let i = 0; i < N * N; i++) {
      const x = pos[i * 3];
      const h = pos[i * 3 + 1];
      const z = pos[i * 3 + 2];
      const ny = nrm.getY(i);
      const n = this.n3.fbm(x * 0.002, z * 0.002, 3) * 0.5 + 0.5;
      const f = this.n1.fbm(x * 0.0012 + 40, z * 0.0012, 2) * 0.5 + 0.5;
      tmp.copy(grass).lerp(grass2, smoothstep(0.35, 0.75, n));
      tmp.lerp(forest, smoothstep(0.55, 0.75, f) * 0.6);
      tmp.lerp(sand, smoothstep(4, 0.5, h));
      tmp.lerp(mud, smoothstep(0, -3, h));
      tmp.lerp(rock, smoothstep(0.86, 0.72, ny) * 0.85 + smoothstep(260, 420, h) * 0.5);
      const sd = Math.abs(this.front.side(x, z));
      const scorch = (1 - smoothstep(60, 520, sd)) * (0.45 + 0.55 * smoothstep(0.3, 0.6, n));
      tmp.lerp(scorched, scorch * 0.75);
      const crater = this.craterOffset(x, z);
      if (crater < -0.3) tmp.lerp(scorched, Math.min(1, -crater / 3) * 0.8);
      // Patchwork fields around villages.
      for (const fm of this.farms) {
        const dx = x - fm.x;
        const dz = z - fm.z;
        const d = Math.hypot(dx, dz);
        if (d > fm.r + 750 || d < fm.r * 0.85 || h < 1.5 || ny < 0.93) continue;
        const u = dx * Math.cos(fm.rot) - dz * Math.sin(fm.rot);
        const v = dx * Math.sin(fm.rot) + dz * Math.cos(fm.rot);
        const cx = Math.floor(u / 95);
        const cz = Math.floor(v / 60);
        const hsh = (((cx * 73856093) ^ (cz * 19349663)) >>> 0) % 5;
        const fc = FIELDS[hsh];
        tmp.lerp(fc, smoothstep(fm.r + 750, fm.r + 450, d) * smoothstep(fm.r * 0.85, fm.r * 1.1, d) * 0.55);
      }
      tmp.lerp(siteDirt, this.siteInfluence(x, z) * 0.85);
      col[i * 3] = tmp.r;
      col[i * 3 + 1] = tmp.g;
      col[i * 3 + 2] = tmp.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.computeBoundingSphere();

    const mat = new THREE.MeshLambertMaterial({ vertexColors: true, map: detailTex });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.receiveShadow = true;
    this.mesh.matrixAutoUpdate = false;
    return this.mesh;
  }

  /** Height exactly matching the rendered triangle mesh. */
  heightAt(x: number, z: number): number {
    const N = SEGS + 1;
    let gx = (x + HALF) / CELL;
    let gz = (z + HALF) / CELL;
    gx = Math.min(Math.max(gx, 0), SEGS - 1e-4);
    gz = Math.min(Math.max(gz, 0), SEGS - 1e-4);
    const ix = Math.floor(gx);
    const iz = Math.floor(gz);
    const fx = gx - ix;
    const fz = gz - iz;
    const H = this.heights;
    const ha = H[iz * N + ix];
    const hb = H[(iz + 1) * N + ix];
    const hc = H[(iz + 1) * N + ix + 1];
    const hd = H[iz * N + ix + 1];
    if (fx + fz <= 1) return ha + (hd - ha) * fx + (hb - ha) * fz;
    return hc + (hb - hc) * (1 - fx) + (hd - hc) * (1 - fz);
  }

  /** Surface the gear rests on: ground or water. */
  surfaceAt(x: number, z: number): number {
    return Math.max(this.heightAt(x, z), WATER_LEVEL);
  }

  normalAt(x: number, z: number, out: THREE.Vector3): THREE.Vector3 {
    const e = 1.5;
    const hx = this.heightAt(x + e, z) - this.heightAt(x - e, z);
    const hz = this.heightAt(x, z + e) - this.heightAt(x, z - e);
    return out.set(-hx, 2 * e, -hz).normalize();
  }

  /** Slope (0 = flat, 1 = 45°) of the natural terrain, for placement. */
  baseSlope(x: number, z: number): number {
    const e = 8;
    const hx = this.baseHeight(x + e, z) - this.baseHeight(x - e, z);
    const hz = this.baseHeight(x, z + e) - this.baseHeight(x, z - e);
    return Math.hypot(hx, hz) / (2 * e);
  }

  /** True if the straight line from a to b clears the terrain. */
  lineOfSight(ax: number, ay: number, az: number, bx: number, by: number, bz: number, steps = 24): boolean {
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      const x = ax + (bx - ax) * t;
      const y = ay + (by - ay) * t;
      const z = az + (bz - az) * t;
      if (this.heightAt(x, z) > y) return false;
    }
    return true;
  }
}
