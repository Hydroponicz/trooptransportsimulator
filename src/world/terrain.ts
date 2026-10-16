import * as THREE from 'three';
import type { Noise2D } from '../util/noise';
import { lerp, smoothstep } from '../util/math';
import type { Frontline } from './frontline';
import { CROP_COLOR, FIELD_GLSL } from './farms';

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
/** WORLD_SCALE of the 9-tile (14.4 km) theater the content counts were tuned on. */
export const BASE_SCALE = ((9 * TILE_CELLS * CELL) / 2 - 900) / 3100;

/** LOD rings for terrain tiles (distance from the camera to the tile's nearest point). */
const LOD_DIST = [1400, 2800, 5000, 7500];
const LOD_STRIDE = [1, 2, 4, 8, 16];
/** Skirts hang below tile edges to hide cracks between LOD levels. */
const SKIRT = 40;


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

/** Vertices along a tile's side (its edges are shared with the neighbours). */
const TV = TILE_CELLS + 1;

/** One tile's grid: heights, and land-cover colours once something asks for them. */
interface TileData {
  h: Float32Array;
  c: Float32Array | null;
}

export class Terrain {
  /**
   * Ground heights live per tile and are worked out the first time something
   * asks: the natural height (noise, rivers, flattened sites, craters), then,
   * once the roads are graded, their cuttings and embankments (overlay).
   */
  private tileData = new Map<number, TileData>();
  private lastKey = -1;
  private lastTile: TileData | null = null;
  /** Final adjustment of each grid height (road cut and fill), set once the roads are graded. */
  private overlay: ((x: number, z: number, h: number) => number) | null = null;
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

  /**
   * Set the per-vertex height adjustment (once, after the roads are graded).
   * Tiles already worked out are adjusted in place rather than recomputed.
   */
  setOverlay(fn: (x: number, z: number, h: number) => number) {
    this.overlay = fn;
    for (const [key, d] of this.tileData) {
      const tx = key % TILES;
      const tz = (key - tx) / TILES;
      for (let iz = 0; iz < TV; iz++)
        for (let ix = 0; ix < TV; ix++) {
          const i = iz * TV + ix;
          d.h[i] = fn(-HALF + (tx * TILE_CELLS + ix) * CELL, -HALF + (tz * TILE_CELLS + iz) * CELL, d.h[i]);
        }
      d.c = null;
    }
  }

  private data(tx: number, tz: number): TileData {
    const key = tz * TILES + tx;
    if (key === this.lastKey) return this.lastTile!;
    let d = this.tileData.get(key);
    if (!d) {
      d = { h: new Float32Array(TV * TV), c: null };
      const ov = this.overlay;
      for (let iz = 0; iz < TV; iz++)
        for (let ix = 0; ix < TV; ix++) {
          const x = -HALF + (tx * TILE_CELLS + ix) * CELL;
          const z = -HALF + (tz * TILE_CELLS + iz) * CELL;
          const h = Math.fround(this.finalHeight(x, z));
          d.h[iz * TV + ix] = ov ? ov(x, z, h) : h;
        }
      this.tileData.set(key, d);
    }
    this.lastKey = key;
    this.lastTile = d;
    return d;
  }

  /** Ground height at grid vertex (gx, gz), 0..SEGS each way. */
  vertexHeight(gx: number, gz: number): number {
    const tx = gx >= SEGS ? TILES - 1 : (gx / TILE_CELLS) | 0;
    const tz = gz >= SEGS ? TILES - 1 : (gz / TILE_CELLS) | 0;
    return this.data(tx, tz).h[(gz - tz * TILE_CELLS) * TV + (gx - tx * TILE_CELLS)];
  }

  /** Land-cover colours of a tile's vertices (worked out on first use). */
  private tileColors(tx: number, tz: number): Float32Array {
    const d = this.data(tx, tz);
    if (d.c) return d.c;
    const c = new Float32Array(TV * TV * 3);
    for (let iz = 0; iz < TV; iz++)
      for (let ix = 0; ix < TV; ix++) {
        this.vertexColor(tx * TILE_CELLS + ix, tz * TILE_CELLS + iz, _col);
        const i = (iz * TV + ix) * 3;
        c[i] = _col.r;
        c[i + 1] = _col.g;
        c[i + 2] = _col.b;
      }
    // (Computing the colours may have touched neighbouring tiles; this one's record still holds.)
    d.c = c;
    return c;
  }

  /**
   * Summer in eastern Europe: fresh meadow greens, drier yellow-green on the
   * rises, dark forest floor, grey limestone on the steeps.
   */
  private vertexColor(gx: number, gz: number, out: THREE.Color): THREE.Color {
    const x = -HALF + gx * CELL;
    const z = -HALF + gz * CELL;
    const h = this.vertexHeight(gx, gz);
    const ny = this.gridNormal(gx, gz, _nrm).y;
    const n = this.n3.fbm(x * 0.002, z * 0.002, 3) * 0.5 + 0.5;
    const f = this.n1.fbm(x * 0.0012 + 40, z * 0.0012, 2) * 0.5 + 0.5;
    const P = PALETTE;
    out.copy(P.grass).lerp(P.grass2, smoothstep(0.35, 0.75, n));
    out.lerp(P.forest, smoothstep(0.55, 0.75, f) * 0.6);
    // River flats: lush grass on the floodplain, a narrow strip of sand
    // and pebbles at the waterline, silt on the bed.
    out.lerp(P.lush, smoothstep(7, 3, h) * 0.55);
    out.lerp(P.sand, smoothstep(2.2, 0.6, h) * 0.85);
    out.lerp(P.mud, smoothstep(0.3, -2.5, h));
    // High ground: alpine meadow, then rock on the steep faces and the tops.
    out.lerp(P.alpine, smoothstep(180, 320, h) * 0.6);
    out.lerp(P.rock, Math.min(1, smoothstep(0.86, 0.7, ny) * 0.85 + smoothstep(380, 560, h) * 0.6));
    const sd = Math.abs(this.front.side(x, z));
    const scorch = (1 - smoothstep(60, 520, sd)) * (0.45 + 0.55 * smoothstep(0.3, 0.6, n));
    out.lerp(P.scorched, scorch * 0.75);
    const crater = this.craterOffset(x, z);
    if (crater < -0.3) out.lerp(P.scorched, Math.min(1, -crater / 3) * 0.8);
    // Bases and outposts: packed earth and gravel, worn grass in patches.
    const site = this.siteInfluence(x, z);
    if (site > 0) {
      // Tracks and bare patches every few tens of metres where vehicles and boots wear the grass away.
      const wear = this.n3.fbm(x * 0.018 + 7, z * 0.018 - 3, 2) * 0.5 + 0.5;
      _col2.copy(out).lerp(P.wornGrass, 0.5);
      out.lerp(_col2, site * 0.6).lerp(P.siteDirt, site * smoothstep(0.42, 0.62, wear) * 0.8);
    }
    return out;
  }

  build(detailTex: THREE.Texture) {
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

    const mat = this.material(detailTex);
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

  /** Up to this many farms (nearest the camera) get their fields drawn. */
  static readonly FIELD_FARMS = 12;
  private farmUniform = { value: Array.from({ length: Terrain.FIELD_FARMS }, () => new THREE.Vector4(0, 0, 0, -1)) };
  private farmIdUniform = { value: new Array<number>(Terrain.FIELD_FARMS).fill(0) };
  /** Crop per plot, one row per farm (set by worldgen once the farmland is laid out). */
  readonly fieldTex = { value: new THREE.DataTexture(new Uint8Array([255]), 1, 1, THREE.RedFormat) as THREE.Texture };

  /**
   * Terrain material: vertex colours for the land cover, plus in the shader
   * a large-scale tint so meadows aren't uniform, a detail texture sampled at
   * two scales so it doesn't visibly tile, and the patchwork of fields around
   * villages, with crop rows and hedgerow margins, drawn crisply per pixel.
   */
  private material(detailTex: THREE.Texture) {
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true, map: detailTex });
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.farms = this.farmUniform;
      sh.uniforms.farmIds = this.farmIdUniform;
      sh.uniforms.fieldTex = this.fieldTex;
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;\nvarying vec3 vWNrm;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWPos = position;\nvWNrm = normal;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\n' + TERRAIN_FRAG_PARS)
        .replace('#include <map_fragment>', TERRAIN_MAP_FRAGMENT);
    };
    return mat;
  }

  /** Pick the farms nearest the camera for the field shader. */
  private updateFields(cam: THREE.Vector3) {
    const list = this.farms
      .map((f, id) => ({ f, id, d: Math.hypot(f.x - cam.x, f.z - cam.z) - f.r }))
      .sort((a, b) => a.d - b.d)
      .slice(0, Terrain.FIELD_FARMS);
    this.farmUniform.value.forEach((v, i) => {
      const e = list[i];
      if (e) v.set(e.f.x, e.f.z, e.f.rot, e.f.r);
      else v.set(0, 0, 0, -1);
      this.farmIdUniform.value[i] = e ? e.id : 0;
    });
  }

  /** Smooth normal at a grid vertex from its neighbours' heights. */
  private gridNormal(ix: number, iz: number, out: THREE.Vector3) {
    const xl = Math.max(0, ix - 1);
    const xr = Math.min(SEGS, ix + 1);
    const zd = Math.max(0, iz - 1);
    const zu = Math.min(SEGS, iz + 1);
    const hx = (this.vertexHeight(xr, iz) - this.vertexHeight(xl, iz)) / ((xr - xl) * CELL);
    const hz = (this.vertexHeight(ix, zu) - this.vertexHeight(ix, zd)) / ((zu - zd) * CELL);
    return out.set(-hx, 1, -hz).normalize();
  }

  /** Copy a tile's heights (and colours, the first time) into its mesh. */
  private fillTile(t: { mesh: THREE.Mesh; cx: number; cz: number }, colours: boolean) {
    const T = TILE_CELLS + 1;
    const C = colours ? this.tileColors(t.cx, t.cz) : null;
    const geo = t.mesh.geometry;
    const pos = geo.getAttribute('position') as THREE.BufferAttribute;
    const nrm = geo.getAttribute('normal') as THREE.BufferAttribute;
    const col = geo.getAttribute('color') as THREE.BufferAttribute;
    const uv = geo.getAttribute('uv') as THREE.BufferAttribute;
    const n = new THREE.Vector3();
    const ox = t.cx * TILE_CELLS;
    const oz = t.cz * TILE_CELLS;
    const put = (v: number, gx: number, gz: number, drop: number) => {
      const x = -HALF + gx * CELL;
      const z = -HALF + gz * CELL;
      pos.setXYZ(v, x, this.vertexHeight(gx, gz) - drop, z);
      this.gridNormal(gx, gz, n);
      nrm.setXYZ(v, n.x, n.y, n.z);
      if (C) {
        const ci = ((gz - oz) * T + (gx - ox)) * 3;
        col.setXYZ(v, C[ci], C[ci + 1], C[ci + 2]);
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
    this.updateFields(cam);
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
    let gx = (x + HALF) / CELL;
    let gz = (z + HALF) / CELL;
    gx = Math.min(Math.max(gx, 0), SEGS - 1e-4);
    gz = Math.min(Math.max(gz, 0), SEGS - 1e-4);
    const ix = Math.floor(gx);
    const iz = Math.floor(gz);
    const fx = gx - ix;
    const fz = gz - iz;
    // A tile holds its far edge too, so a cell's four corners are always in one tile.
    const tx = (ix / TILE_CELLS) | 0;
    const tz = (iz / TILE_CELLS) | 0;
    const H = this.data(tx, tz).h;
    const i = (iz - tz * TILE_CELLS) * TV + (ix - tx * TILE_CELLS);
    const ha = H[i];
    const hb = H[i + TV];
    const hc = H[i + TV + 1];
    const hd = H[i + 1];
    if (fx + fz <= 1) return ha + (hd - ha) * fx + (hb - ha) * fz;
    return hc + (hb - hc) * (1 - fx) + (hd - hc) * (1 - fz);
  }

  /** Land-cover colour (linear RGB) at the nearest grid vertex. */
  groundColor(x: number, z: number, out: THREE.Color): THREE.Color {
    const ix = Math.min(SEGS, Math.max(0, Math.round((x + HALF) / CELL)));
    const iz = Math.min(SEGS, Math.max(0, Math.round((z + HALF) / CELL)));
    const tx = ix >= SEGS ? TILES - 1 : (ix / TILE_CELLS) | 0;
    const tz = iz >= SEGS ? TILES - 1 : (iz / TILE_CELLS) | 0;
    const C = this.tileColors(tx, tz);
    const i = ((iz - tz * TILE_CELLS) * TV + (ix - tx * TILE_CELLS)) * 3;
    return out.setRGB(C[i], C[i + 1], C[i + 2]);
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

const _nrm = new THREE.Vector3();
const _col = new THREE.Color();
const _col2 = new THREE.Color();
const PALETTE = {
  grass: new THREE.Color(0x58793a),
  grass2: new THREE.Color(0x878f4a),
  forest: new THREE.Color(0x3d5528),
  rock: new THREE.Color(0x837f76),
  alpine: new THREE.Color(0x6d7a48),
  sand: new THREE.Color(0xb0a27a),
  mud: new THREE.Color(0x5a5442),
  lush: new THREE.Color(0x58773a),
  scorched: new THREE.Color(0x4a4436),
  siteDirt: new THREE.Color(0x948a68),
  wornGrass: new THREE.Color(0x6c8540),
};

const TERRAIN_FRAG_PARS = /* glsl */ `
varying vec3 vWPos;
varying vec3 vWNrm;
uniform vec4 farms[${Terrain.FIELD_FARMS}];
uniform float farmIds[${Terrain.FIELD_FARMS}];
${FIELD_GLSL}
float tHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float tNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(tHash(i), tHash(i + vec2(1.0, 0.0)), u.x), mix(tHash(i + vec2(0.0, 1.0)), tHash(i + vec2(1.0, 1.0)), u.x), u.y);
}
// Field colours (shared with the 3D crops, see CROP_COLOR): wheat, barley, green crop, ploughed, rapeseed, sunflowers, hay, pasture, farmyard.
const vec3 FIELD_C[9] = vec3[9](${CROP_COLOR.map((c) => `vec3(${c.map((v) => v.toFixed(3)).join(', ')})`).join(', ')});
`;

const TERRAIN_MAP_FRAGMENT = /* glsl */ `
#ifdef USE_MAP
  // Detail texture at two scales (the second rotated) so it doesn't tile visibly.
  vec2 duv = vMapUv;
  vec4 d1 = texture2D(map, duv);
  vec4 d2 = texture2D(map, mat2(0.8, -0.6, 0.6, 0.8) * duv * 0.29 + vec2(0.37, 0.11));
  float camDist = length(vWPos - cameraPosition);
  vec4 texelColor = mix(d1, d2, 0.45);
  // Up close the grain is crisp; far off it fades so the land doesn't shimmer.
  texelColor.rgb = mix(texelColor.rgb, vec3(0.86), smoothstep(400.0, 2500.0, camDist));
  diffuseColor *= texelColor;
#endif
  {
    vec2 wp = vWPos.xz;
    // Large-scale variation: lusher hollows, sun-dried patches.
    float m = tNoise(wp * 0.0032) * 0.6 + tNoise(wp * 0.011) * 0.4;
    diffuseColor.rgb *= mix(vec3(0.9, 0.96, 0.86), vec3(1.08, 1.04, 0.94), m);
    // Fields around villages.
    float flat_ = smoothstep(0.93, 0.97, normalize(vWNrm).y) * smoothstep(1.5, 3.0, vWPos.y);
    // Where two villages' fields overlap, the lower-numbered farm owns the plot (as on the CPU side).
    int bestKind = -1;
    float bestId = 1e9;
    float bestD = 0.0;
    vec2 bestIn = vec2(0.0);
    vec2 bestCell = vec2(0.0);
    for (int k = 0; k < ${Terrain.FIELD_FARMS}; k++) {
      vec4 f = farms[k];
      if (f.w < 0.0 || farmIds[k] >= bestId) continue;
      vec2 dlt = wp - f.xy;
      float d = length(dlt);
      if (d > f.w + 750.0 || d < f.w + 30.0) continue;
      float c = cos(f.z);
      float s = sin(f.z);
      float u = dlt.x * c - dlt.y * s;
      float v = dlt.x * s + dlt.y * c;
      vec2 cell = floor(vec2(u / 95.0, v / 60.0));
      int kind = fieldKind(int(farmIds[k] + 0.5), cell);
      if (kind < 0) continue;
      bestKind = kind;
      bestId = farmIds[k];
      bestD = d - f.w;
      bestCell = cell;
      bestIn = vec2(u - cell.x * 95.0, v - cell.y * 60.0);
    }
    if (bestKind >= 0) {
      int kind = bestKind;
      vec2 cell = bestCell;
      vec2 inCell = bestIn;
      vec3 fc = FIELD_C[kind];
      bool rowed = kind <= 5;
      // Crop rows along the field (faded with distance so they don't alias).
      float rowFade = 1.0 - smoothstep(60.0, 260.0, camDist);
      float rows = 0.5 + 0.5 * sin(inCell.y * 6.2832 / 1.4);
      if (rowed) fc *= 1.0 - rowFade * (kind == 3 ? 0.22 : 0.12) * rows;
      // Under standing crops, close up the ground between the plants is soil in their shade;
      // further out the plot takes the crop's own colour (the plants fade in over the same distance).
      if (kind <= 5 && kind != 3) fc = mix(fc * vec3(0.55, 0.5, 0.45), fc, smoothstep(35.0, 105.0, camDist));
      // Pasture: trampled paths and darker tufts; farmyard: packed earth and gravel.
      if (kind == 7) fc *= 0.85 + 0.3 * tNoise(wp * 0.35);
      if (kind == 8) fc *= 0.8 + 0.35 * tNoise(wp * 0.6);
      fc *= 0.92 + 0.16 * tNoise(wp * 0.05 + cell * 3.1);
      // Grassy margins and hedgerows between fields.
      float edge = min(min(inCell.x, 95.0 - inCell.x), min(inCell.y, 60.0 - inCell.y));
      float margin = 1.0 - smoothstep(1.2, 2.6, edge);
      fc = mix(fc, vec3(0.16, 0.27, 0.08), margin * 0.85);
      float w = smoothstep(750.0, 450.0, bestD) * smoothstep(30.0, 90.0, bestD) * flat_;
      diffuseColor.rgb = mix(diffuseColor.rgb, fc, w * 0.92);
    }
  }
`;
