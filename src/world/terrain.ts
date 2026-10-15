import * as THREE from 'three';
import type { Noise2D } from '../util/noise';
import { lerp, smoothstep } from '../util/math';
import type { Frontline } from './frontline';

/** Terrain tiles: 128 cells (1.6 km) square, so every LOD stride divides them. */
export const TILE_CELLS = 128;
export const TILES = 9;
export const SEGS = TILE_CELLS * TILES;
/** 12.5 m grid. */
export const CELL = 12.5;
export const WORLD_SIZE = SEGS * CELL;
export const HALF = WORLD_SIZE / 2;
export const WATER_LEVEL = 0;
/** Edge of the flyable area; beyond this the mountains wall things in. */
export const PLAY_HALF = HALF - 900;
/** How much bigger (per side) the play area is than the original 6.2 km map; content ranges scale by this. */
export const WORLD_SCALE = PLAY_HALF / 3100;

/** LOD rings for terrain tiles (distance from the camera to the tile's nearest point). */
const LOD_DIST = [1400, 2800, 5000, 7500];
const LOD_STRIDE = [1, 2, 4, 8, 16];
/** Skirts hang below tile edges to hide cracks between LOD levels. */
const SKIRT = 40;

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

/** Smooth minimum (polynomial, blend width k). */
function smin(a: number, b: number, k: number) {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

/**
 * Ground height across a river valley at distance d from the centreline:
 * a rounded channel about 3.5 m deep, banks up to 2.6 m, a floodplain rising
 * to ~4 m, then valley sides that start at ~2° and steepen slowly.
 */
export function riverProfile(d: number, w: number, plain: number) {
  if (d < w) {
    const u = d / w;
    return -3.6 * (1 - u * u);
  }
  const bank = 14;
  if (d < w + bank) return 2.6 * smoothstep(0, 1, (d - w) / bank);
  const fp = d - w - bank;
  if (fp < plain) return 2.6 + 1.4 * (fp / plain);
  const v = fp - plain;
  return 4 + 0.035 * v + 0.00011 * v * v;
}

/** River distance grid spacing and size. */
const RG = 20;
const RN = Math.ceil(WORLD_SIZE / RG) + 1;

const CRATER_CELL = 100;
const FGRID = 200;
const NONE: FlattenZone[] = [];

export class Terrain {
  readonly heights = new Float32Array((SEGS + 1) * (SEGS + 1));
  flattens: FlattenZone[] = [];
  /** Settlements with farmland around them (for ground colouring). */
  farms: { x: number; z: number; rot: number; r: number }[] = [];
  craters: Crater[] = [];
  private craterGrid = new Map<number, Crater[]>();
  /** Flatten zones bucketed on a coarse grid (rebuilt when the list grows). */
  private flattenGrid = new Map<number, FlattenZone[]>();
  private flattenCount = -1;
  /** All terrain tiles. */
  mesh!: THREE.Group;
  private tiles: { mesh: THREE.Mesh; cx: number; cz: number; lod: number }[] = [];
  private lodIndex: THREE.BufferAttribute[] = [];
  private colors!: Float32Array;

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
    // Ridges only on high ground (skip the noise where they'd be weighted to zero).
    const rw = smoothstep(0.45, 0.8, c);
    if (rw > 0) {
      const r = this.n2.ridged(x * 0.0007 + 31.7, z * 0.0007 - 17.3, 3);
      h += r * r * 45 * rw * (1 - 0.85 * near);
    }
    h += this.n3.fbm(x * 0.003, z * 0.003, 3) * 3.5 * (1 - 0.4 * near);
    // Rivers: a channel with low banks, a floodplain, and valley sides that
    // rise gently (a few degrees) back up to the hills.
    const rv = this.river(x, z, h);
    if (rv.weight > 0) h = lerp(h, smin(h, riverProfile(rv.dist, rv.width, rv.plain), 12), rv.weight);
    // Mountains walling in the map edges.
    const d = Math.max(Math.abs(x), Math.abs(z));
    const e = smoothstep(HALF - 1100, HALF - 100, d);
    if (e > 0) h += e * e * (420 + 220 * this.n1.fbm(x * 0.0015 + 5, z * 0.0015, 3));
    return h;
  }

  private _river = { dist: Infinity, width: 0, plain: 0, weight: 0, fx: 0, fz: 0 };
  /** Distance (m) to the nearest river centreline on a coarse grid (built on first use). */
  private riverDist: Float32Array | null = null;
  private riverField(x: number, z: number) {
    return this.n2.fbm(x * 0.00018 + 91.1, z * 0.00018 - 44.2, 3);
  }

  /** Exact distance transform of the river centrelines (zero crossings of the field). */
  private buildRiverDist() {
    const n = RN;
    const f = new Float32Array(n * n);
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) f[j * n + i] = this.riverField(-HALF + i * RG, -HALF + j * RG);
    const INF = 1e12;
    const d2 = new Float64Array(n * n).fill(INF);
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) {
        const v = f[j * n + i];
        if ((i + 1 < n && v * f[j * n + i + 1] <= 0) || (j + 1 < n && v * f[(j + 1) * n + i] <= 0)) d2[j * n + i] = 0;
        if ((i > 0 && v * f[j * n + i - 1] <= 0) || (j > 0 && v * f[(j - 1) * n + i] <= 0)) d2[j * n + i] = 0;
      }
    // Felzenszwalb & Huttenlocher: 1D squared-distance passes along columns, then rows.
    const g = new Float64Array(n);
    const v = new Int32Array(n);
    const zb = new Float64Array(n + 1);
    const pass = (get: (k: number) => number, set: (k: number, val: number) => void) => {
      for (let q = 0; q < n; q++) g[q] = get(q);
      let k = 0;
      v[0] = 0;
      zb[0] = -Infinity;
      zb[1] = Infinity;
      for (let q = 1; q < n; q++) {
        let sx = (g[q] + q * q - (g[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
        while (sx <= zb[k]) {
          k--;
          sx = (g[q] + q * q - (g[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
        }
        k++;
        v[k] = q;
        zb[k] = sx;
        zb[k + 1] = Infinity;
      }
      k = 0;
      for (let q = 0; q < n; q++) {
        while (zb[k + 1] < q) k++;
        set(q, (q - v[k]) * (q - v[k]) + g[v[k]]);
      }
    };
    for (let i = 0; i < n; i++) pass((q) => d2[q * n + i], (q, val) => (d2[q * n + i] = val));
    for (let j = 0; j < n; j++) pass((q) => d2[j * n + q], (q, val) => (d2[j * n + q] = val));
    const out = new Float32Array(n * n);
    for (let k = 0; k < n * n; k++) out[k] = Math.sqrt(d2[k]) * RG;
    this.riverDist = out;
  }

  private gridRiverDist(x: number, z: number) {
    if (!this.riverDist) this.buildRiverDist();
    const D = this.riverDist!;
    const gx = Math.min(Math.max((x + HALF) / RG, 0), RN - 1.001);
    const gz = Math.min(Math.max((z + HALF) / RG, 0), RN - 1.001);
    const i = Math.floor(gx);
    const j = Math.floor(gz);
    const fx = gx - i;
    const fz = gz - j;
    const a = D[j * RN + i] + (D[j * RN + i + 1] - D[j * RN + i]) * fx;
    const b = D[(j + 1) * RN + i] + (D[(j + 1) * RN + i + 1] - D[(j + 1) * RN + i]) * fx;
    return a + (b - a) * fz;
  }

  /**
   * The river field near (x, z): distance to the nearest river centreline
   * (rivers follow the zero line of a noise field, so they meander and
   * branch), the river's half-width and floodplain width there, and the unit
   * downstream direction (fx, fz). weight is 0 far from any river (or, given
   * the natural ground height, where the valley would not cut into it).
   */
  river(x: number, z: number, ground = Infinity) {
    const r = this._river;
    const far = this.gridRiverDist(x, z);
    // Skip points the valley can't reach: even the widest valley is above the ground there.
    if (far > 1900 || riverProfile(far - 20, 29, 200) > ground + 12) {
      r.weight = 0;
      r.dist = Infinity;
      return r;
    }
    r.weight = 1;
    r.dist = far;
    r.fx = r.fz = 0;
    if (far < 130) {
      const f = this.riverField(x, z);
      const e = 15;
      const gx = (this.riverField(x + e, z) - f) / e;
      const gz = (this.riverField(x, z + e) - f) / e;
      const g = Math.hypot(gx, gz) || 1e-6;
      // Close to the line the field's own gradient gives the distance to the
      // metre; further out (where the gradient can fade) use the grid.
      const near = Math.abs(f) / Math.max(g, 0.00005);
      const t = smoothstep(35, 90, Math.min(near, far + 20));
      r.dist = near + (far - near) * t;
      // Flow runs along the river: perpendicular to the field's gradient.
      r.fx = -gz / g;
      r.fz = gx / g;
    }
    r.width = 20 + 9 * this.n3.fbm(x * 0.0004 + 12.3, z * 0.0004 - 7.1, 2);
    r.plain = 110 + 90 * this.n1.fbm(x * 0.0005 - 3.3, z * 0.0005 + 8.8, 2);
    return r;
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

  /** Flatten zones whose influence might reach (x, z). */
  private flattensNear(x: number, z: number): FlattenZone[] {
    if (this.flattenCount !== this.flattens.length) {
      this.flattenCount = this.flattens.length;
      this.flattenGrid.clear();
      for (const f of this.flattens) {
        const R = f.radius + f.blend;
        for (let cx = Math.floor((f.x - R + HALF) / FGRID); cx <= Math.floor((f.x + R + HALF) / FGRID); cx++)
          for (let cz = Math.floor((f.z - R + HALF) / FGRID); cz <= Math.floor((f.z + R + HALF) / FGRID); cz++) {
            const k = cx + cz * 1000;
            let arr = this.flattenGrid.get(k);
            if (!arr) this.flattenGrid.set(k, (arr = []));
            arr.push(f);
          }
      }
    }
    return this.flattenGrid.get(Math.floor((x + HALF) / FGRID) + Math.floor((z + HALF) / FGRID) * 1000) ?? NONE;
  }

  /** How strongly a point is inside a flatten zone (0..1). */
  siteInfluence(x: number, z: number): number {
    let best = 0;
    for (const f of this.flattensNear(x, z)) {
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
    for (const f of this.flattensNear(x, z)) {
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
    for (let iz = 0; iz < N; iz++)
      for (let ix = 0; ix < N; ix++) this.heights[iz * N + ix] = this.finalHeight(-HALF + ix * CELL, -HALF + iz * CELL);

    // Farms bucketed so each vertex only looks at the few nearby.
    const FG = 400;
    const farmGrid = new Map<number, typeof this.farms>();
    for (const fm of this.farms) {
      const R = fm.r + 750;
      for (let cx = Math.floor((fm.x - R + HALF) / FG); cx <= Math.floor((fm.x + R + HALF) / FG); cx++)
        for (let cz = Math.floor((fm.z - R + HALF) / FG); cz <= Math.floor((fm.z + R + HALF) / FG); cz++) {
          const k = cx + cz * 1000;
          let arr = farmGrid.get(k);
          if (!arr) farmGrid.set(k, (arr = []));
          arr.push(fm);
        }
    }

    const col = (this.colors = new Float32Array(N * N * 3));
    const C = (hex: number) => new THREE.Color(hex);
    const grass = C(0x6a7a40);
    const grass2 = C(0x87894f);
    const forest = C(0x4f6233);
    const rock = C(0x7c776c);
    const sand = C(0x9d9070);
    const mud = C(0x5a5442);
    const lush = C(0x58773a);
    const scorched = C(0x4a4436);
    const siteDirt = C(0x9a8a66);
    const tmp = new THREE.Color();
    const nrm = new THREE.Vector3();
    for (let iz = 0; iz < N; iz++)
      for (let ix = 0; ix < N; ix++) {
        const i = iz * N + ix;
        const x = -HALF + ix * CELL;
        const z = -HALF + iz * CELL;
        const h = this.heights[i];
        const ny = this.gridNormal(ix, iz, nrm).y;
        const n = this.n3.fbm(x * 0.002, z * 0.002, 3) * 0.5 + 0.5;
        const f = this.n1.fbm(x * 0.0012 + 40, z * 0.0012, 2) * 0.5 + 0.5;
        tmp.copy(grass).lerp(grass2, smoothstep(0.35, 0.75, n));
        tmp.lerp(forest, smoothstep(0.55, 0.75, f) * 0.6);
        // River flats: lush grass on the floodplain, a narrow strip of sand
        // and pebbles at the waterline, silt on the bed.
        tmp.lerp(lush, smoothstep(7, 3, h) * 0.55);
        tmp.lerp(sand, smoothstep(2.2, 0.6, h) * 0.85);
        tmp.lerp(mud, smoothstep(0.3, -2.5, h));
        tmp.lerp(rock, smoothstep(0.86, 0.72, ny) * 0.85 + smoothstep(260, 420, h) * 0.5);
        const sd = Math.abs(this.front.side(x, z));
        const scorch = (1 - smoothstep(60, 520, sd)) * (0.45 + 0.55 * smoothstep(0.3, 0.6, n));
        tmp.lerp(scorched, scorch * 0.75);
        const crater = this.craterOffset(x, z);
        if (crater < -0.3) tmp.lerp(scorched, Math.min(1, -crater / 3) * 0.8);
        // Patchwork fields around villages.
        const farms = farmGrid.get(Math.floor((x + HALF) / FG) + Math.floor((z + HALF) / FG) * 1000);
        if (farms)
          for (const fm of farms) {
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

    // Shared index buffers: one per LOD stride, the grid plus skirts round the edge.
    const T = TILE_CELLS + 1;
    const skirtBase = T * T;
    for (const st of LOD_STRIDE) {
      const idx: number[] = [];
      for (let z = 0; z < TILE_CELLS; z += st)
        for (let x = 0; x < TILE_CELLS; x += st) {
          const a = z * T + x;
          const b = (z + st) * T + x;
          const c = (z + st) * T + x + st;
          const d = z * T + x + st;
          idx.push(a, b, d, b, c, d);
        }
      // Skirt vertices: edge e (0 north z=0, 1 east x=max, 2 south z=max, 3 west x=0), position k along it.
      const edge = (e: number, k: number) => (e === 0 ? k : e === 1 ? k * T + TILE_CELLS : e === 2 ? TILE_CELLS * T + k : k * T);
      for (let e = 0; e < 4; e++)
        for (let k = 0; k < TILE_CELLS; k += st) {
          const a = edge(e, k);
          const b = edge(e, k + st);
          const sa = skirtBase + e * T + k;
          const sb = skirtBase + e * T + k + st;
          // Both windings, so the skirt shows from either side.
          idx.push(a, sa, b, b, sa, sb, a, b, sa, b, sb, sa);
        }
      this.lodIndex.push(new THREE.BufferAttribute(new Uint32Array(idx), 1));
    }

    const mat = new THREE.MeshLambertMaterial({ vertexColors: true, map: detailTex });
    this.mesh = new THREE.Group();
    for (let cz = 0; cz < TILES; cz++)
      for (let cx = 0; cx < TILES; cx++) {
        const nv = T * T + 4 * T;
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(nv * 3), 3));
        geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nv * 3), 3));
        geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(nv * 3), 3));
        geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(nv * 2), 2));
        geo.setIndex(this.lodIndex[LOD_STRIDE.length - 1]);
        const m = new THREE.Mesh(geo, mat);
        m.receiveShadow = true;
        m.matrixAutoUpdate = false;
        this.mesh.add(m);
        this.tiles.push({ mesh: m, cx, cz, lod: LOD_STRIDE.length - 1 });
        this.fillTile(this.tiles[this.tiles.length - 1], true);
      }
    this.mesh.matrixAutoUpdate = false;
    return this.mesh;
  }

  /** Smooth normal at a grid vertex from its neighbours' heights. */
  private gridNormal(ix: number, iz: number, out: THREE.Vector3) {
    const N = SEGS + 1;
    const H = this.heights;
    const xl = Math.max(0, ix - 1);
    const xr = Math.min(SEGS, ix + 1);
    const zd = Math.max(0, iz - 1);
    const zu = Math.min(SEGS, iz + 1);
    const hx = (H[iz * N + xr] - H[iz * N + xl]) / ((xr - xl) * CELL);
    const hz = (H[zu * N + ix] - H[zd * N + ix]) / ((zu - zd) * CELL);
    return out.set(-hx, 1, -hz).normalize();
  }

  /** Copy heights (and colours, the first time) from the global grid into a tile's vertices. */
  private fillTile(t: { mesh: THREE.Mesh; cx: number; cz: number }, colours: boolean) {
    const N = SEGS + 1;
    const T = TILE_CELLS + 1;
    const geo = t.mesh.geometry;
    const pos = geo.getAttribute('position') as THREE.BufferAttribute;
    const nrm = geo.getAttribute('normal') as THREE.BufferAttribute;
    const col = geo.getAttribute('color') as THREE.BufferAttribute;
    const uv = geo.getAttribute('uv') as THREE.BufferAttribute;
    const n = new THREE.Vector3();
    const ox = t.cx * TILE_CELLS;
    const oz = t.cz * TILE_CELLS;
    const put = (v: number, gx: number, gz: number, drop: number) => {
      const gi = gz * N + gx;
      const x = -HALF + gx * CELL;
      const z = -HALF + gz * CELL;
      pos.setXYZ(v, x, this.heights[gi] - drop, z);
      this.gridNormal(gx, gz, n);
      nrm.setXYZ(v, n.x, n.y, n.z);
      if (colours) {
        col.setXYZ(v, this.colors[gi * 3], this.colors[gi * 3 + 1], this.colors[gi * 3 + 2]);
        uv.setXY(v, x / 18, z / 18);
      }
    };
    for (let z = 0; z < T; z++) for (let x = 0; x < T; x++) put(z * T + x, ox + x, oz + z, 0);
    const base = T * T;
    for (let k = 0; k < T; k++) {
      put(base + k, ox + k, oz, SKIRT);
      put(base + T + k, ox + TILE_CELLS, oz + k, SKIRT);
      put(base + 2 * T + k, ox + k, oz + TILE_CELLS, SKIRT);
      put(base + 3 * T + k, ox, oz + k, SKIRT);
    }
    pos.needsUpdate = true;
    nrm.needsUpdate = true;
    if (colours) {
      col.needsUpdate = true;
      uv.needsUpdate = true;
    }
    geo.computeBoundingSphere();
    geo.computeBoundingBox();
  }

  /** Pick each tile's level of detail from its distance to the camera. */
  updateLod(cam: THREE.Vector3) {
    const size = TILE_CELLS * CELL;
    for (const t of this.tiles) {
      const x0 = -HALF + t.cx * size;
      const z0 = -HALF + t.cz * size;
      const dx = Math.max(x0 - cam.x, 0, cam.x - (x0 + size));
      const dz = Math.max(z0 - cam.z, 0, cam.z - (z0 + size));
      const d = Math.hypot(dx, dz);
      let lod = 0;
      while (lod < LOD_DIST.length && d >= LOD_DIST[lod]) lod++;
      if (lod !== t.lod) {
        t.lod = lod;
        t.mesh.geometry.setIndex(this.lodIndex[lod]);
      }
    }
  }

  /** Push edited heights back into the mesh (after road grading, etc). */
  refreshMesh() {
    for (const t of this.tiles) this.fillTile(t, false);
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
