import * as THREE from 'three';
import type { RNG } from '../util/noise';
import type { Frontline } from './frontline';
import type { Props } from './props';
import type { Terrain } from './terrain';

/** Field plots: 95 × 60 m, laid out on a grid turned to each village's axis. */
export const FIELD_U = 95;
export const FIELD_V = 60;
/** Crop rows run along the plot (u), this far apart. */
export const ROW_SPACING = 1.4;
/** Fields reach this far beyond the village edge. */
export const FIELD_REACH = 720;

/** What a plot is used for. The shader, the 3D crops and the farm machinery all read this. */
export const enum Crop {
  Wheat = 0,
  Barley = 1,
  Green = 2,
  Plough = 3,
  Rapeseed = 4,
  Sunflower = 5,
  Hay = 6,
  Pasture = 7,
  Yard = 8,
  None = 255,
}

/**
 * Colour of each crop seen from a little way off (linear RGB): the ground
 * shader paints plots with it and the 3D plants are coloured to match, so a
 * field looks the same before and after its plants appear.
 */
export const CROP_COLOR: [number, number, number][] = [
  [0.56, 0.43, 0.16], // wheat
  [0.5, 0.46, 0.22], // barley
  [0.18, 0.32, 0.08], // young green crop / beet
  [0.25, 0.18, 0.11], // ploughed
  [0.62, 0.56, 0.08], // rapeseed in flower
  [0.24, 0.3, 0.07], // sunflowers (leaves with heads)
  [0.27, 0.33, 0.13], // hay meadow
  [0.2, 0.32, 0.1], // pasture
  [0.3, 0.26, 0.18], // farmyard
];

/** Grid index range per farm (cells −10..9 across, −16..15 along), and the texture row layout. */
const CX0 = -10;
const CX1 = 9;
const CZ0 = -16;
const CZ1 = 15;
const NX = CX1 - CX0 + 1;
const NZ = CZ1 - CZ0 + 1;

export interface Farm {
  id: number;
  x: number;
  z: number;
  rot: number;
  r: number;
  /** Far enough from the fighting for farm work and civilian life. */
  peaceful: boolean;
  kinds: Uint8Array;
}

export interface FieldHit {
  farm: Farm;
  cx: number;
  cz: number;
  kind: Crop;
  /** Position inside the plot (0..FIELD_U, 0..FIELD_V). */
  u: number;
  v: number;
}

/**
 * The farmland round every town and village: which crop each plot carries
 * (a texture for the terrain shader, one row per farm), fenced pastures with
 * cattle, farmyards with their houses, barns and machinery, and hay fields
 * with bales. Plots too close to the front lie fallow (no machinery, no
 * livestock).
 */
export class Farmland {
  farms: Farm[] = [];
  texture: THREE.DataTexture;
  private grid = new Map<number, Farm[]>();

  /** `keepOut`: bases, outposts and landing zones; no plot may touch one. */
  constructor(terrain: Terrain, front: Frontline, rng: RNG, keepOut: { x: number; z: number; radius: number }[] = []) {
    const data = new Uint8Array(NX * NZ * Math.max(1, terrain.farms.length));
    terrain.farms.forEach((f, id) => {
      const kinds = new Uint8Array(NX * NZ).fill(Crop.None);
      const peaceful = Math.abs(front.side(f.x, f.z)) > 1500;
      for (let cz = CZ0; cz <= CZ1; cz++)
        for (let cx = CX0; cx <= CX1; cx++) {
          const d = Math.hypot((cx + 0.5) * FIELD_U, (cz + 0.5) * FIELD_V);
          if (d < f.r + 60 || d > f.r + FIELD_REACH - 40) continue;
          // Keep clear of military sites: test the plot's corners and middle against each perimeter.
          const c = Math.cos(f.rot);
          const s = Math.sin(f.rot);
          const pts = [[0, 0], [1, 0], [0, 1], [1, 1], [0.5, 0.5]].map(([a, b]) => {
            const U = (cx + a) * FIELD_U;
            const V = (cz + b) * FIELD_V;
            return [f.x + U * c + V * s, f.z - U * s + V * c];
          });
          if (keepOut.some((k) => pts.some(([x, z]) => Math.hypot(x - k.x, z - k.z) < k.radius + 60))) continue;
          const near = d < f.r + 320;
          const roll = rng.next();
          let k: Crop;
          if (roll < 0.1) continue;
          else if (near && roll < 0.24) k = Crop.Pasture;
          else if (roll < 0.33) k = Crop.Hay;
          else {
            const q = rng.next();
            k = q < 0.26 ? Crop.Wheat : q < 0.38 ? Crop.Barley : q < 0.54 ? Crop.Green : q < 0.68 ? Crop.Plough : q < 0.8 ? Crop.Rapeseed : Crop.Sunflower;
          }
          kinds[(cx - CX0) + (cz - CZ0) * NX] = k;
        }
      const farm: Farm = { id, x: f.x, z: f.z, rot: f.rot, r: f.r, peaceful, kinds };
      this.farms.push(farm);
      data.set(kinds, id * NX * NZ);
      const R = f.r + FIELD_REACH;
      for (let gx = Math.floor((f.x - R) / 500); gx <= Math.floor((f.x + R) / 500); gx++)
        for (let gz = Math.floor((f.z - R) / 500); gz <= Math.floor((f.z + R) / 500); gz++) {
          const k = gx + 1000 + (gz + 1000) * 3000;
          let arr = this.grid.get(k);
          if (!arr) this.grid.set(k, (arr = []));
          arr.push(farm);
        }
    });
    this.texture = new THREE.DataTexture(data, NX * NZ, Math.max(1, terrain.farms.length), THREE.RedFormat, THREE.UnsignedByteType);
    this.texture.needsUpdate = true;
  }

  /** Mark a plot (e.g. under a farmyard) and keep the texture in step. */
  private setKind(f: Farm, cx: number, cz: number, k: Crop) {
    const i = (cx - CX0) + (cz - CZ0) * NX;
    f.kinds[i] = k;
    (this.texture.image.data as Uint8Array)[f.id * NX * NZ + i] = k;
    this.texture.needsUpdate = true;
  }

  kindAt(f: Farm, cx: number, cz: number): Crop {
    if (cx < CX0 || cx > CX1 || cz < CZ0 || cz > CZ1) return Crop.None;
    return f.kinds[(cx - CX0) + (cz - CZ0) * NX] as Crop;
  }

  /** The plot under a world point, if any. */
  fieldAt(x: number, z: number): FieldHit | null {
    const arr = this.grid.get(Math.floor(x / 500) + 1000 + (Math.floor(z / 500) + 1000) * 3000);
    if (!arr) return null;
    for (const f of arr) {
      const dx = x - f.x;
      const dz = z - f.z;
      const c = Math.cos(f.rot);
      const s = Math.sin(f.rot);
      const u = dx * c - dz * s;
      const v = dx * s + dz * c;
      const cx = Math.floor(u / FIELD_U);
      const cz = Math.floor(v / FIELD_V);
      const kind = this.kindAt(f, cx, cz);
      if (kind === Crop.None) continue;
      return { farm: f, cx, cz, kind, u: u - cx * FIELD_U, v: v - cz * FIELD_V };
    }
    return null;
  }

  /** World position of a point given in a plot's own coordinates. */
  toWorld(f: Farm, cx: number, cz: number, u: number, v: number, out = new THREE.Vector3()) {
    const U = cx * FIELD_U + u;
    const V = cz * FIELD_V + v;
    const c = Math.cos(f.rot);
    const s = Math.sin(f.rot);
    // Inverse of (u, v) = R(rot)·(dx, dz).
    return out.set(f.x + U * c + V * s, 0, f.z - U * s + V * c);
  }

  /** World yaw (props convention) of a plot's u axis. */
  yaw(f: Farm) {
    return f.rot;
  }

  /**
   * Farmyards, fenced pastures with cattle, bales on the hay fields. Anything
   * that ends up on a road is cleared later with the rest of the props.
   */
  populate(props: Props, terrain: Terrain, rng: RNG, blocked: (x: number, z: number) => boolean) {
    const at = (f: Farm, cx: number, cz: number, u: number, v: number) => {
      const p = this.toWorld(f, cx, cz, u, v);
      p.y = terrain.heightAt(p.x, p.z);
      return p;
    };
    const flat = (p: THREE.Vector3) => terrain.normalAt(p.x, p.z, new THREE.Vector3()).y > 0.93 && p.y > 2;
    for (const f of this.farms) {
      // One or two farmyards on plots near the village.
      let yards = 0;
      for (let tries = 0; tries < 30 && yards < (f.r > 80 ? 2 : 1); tries++) {
        const cx = rng.int(CX0, CX1);
        const cz = rng.int(CZ0, CZ1);
        const d = Math.hypot((cx + 0.5) * FIELD_U, (cz + 0.5) * FIELD_V);
        if (d > f.r + 350 || this.kindAt(f, cx, cz) === Crop.None) continue;
        const c = at(f, cx, cz, FIELD_U / 2, FIELD_V / 2);
        if (!flat(c) || blocked(c.x, c.z)) continue;
        this.setKind(f, cx, cz, Crop.Yard);
        yards++;
        const put = (name: Parameters<Props['add']>[0], u: number, v: number, rot: number, color?: number, scale = 1) => {
          const p = at(f, cx, cz, u, v);
          if (!blocked(p.x, p.z)) props.add(name, p.x, p.y, p.z, f.rot + rot, scale, color);
        };
        put('farmhouse', 22, 18, Math.PI / 2, rng.pick([0xf3e9cf, 0xf6f4ee, 0xbfd4e4, 0xf1dc9c]));
        put('barn', 62, 20, 0);
        put('machineshed', 64, 46, Math.PI / 2);
        put('tractor_parked', 64, 46, Math.PI / 2, rng.pick([0xb8352c, 0x2f5a9a, 0x3f7a3a]));
        if (rng.chance(0.7)) put('silo', 82, 12, 0);
        if (rng.chance(0.5)) put('silo', 82, 22, 0);
        put('shed', 30, 42, 0, 0xffffff);
        for (let k = 0; k < 3; k++) put('haystack', 40 + k * 7, 52, 0, undefined, rng.range(0.8, 1.1));
        // Board fence along the front of the yard.
        for (let u = 4; u < FIELD_U - 4; u += 4) if (u < 40 || u > 52) put('fence_board', u, 2, 0);
      }
      // Pastures: post-and-rail fence round the plot, a herd grazing (peaceful farms only).
      for (let cz = CZ0; cz <= CZ1; cz++)
        for (let cx = CX0; cx <= CX1; cx++) {
          const k = this.kindAt(f, cx, cz);
          if (k === Crop.Pasture) {
            const edge = (u0: number, v0: number, u1: number, v1: number) => {
              const len = Math.hypot(u1 - u0, v1 - v0);
              const n = Math.floor(len / 6);
              for (let i = 0; i < n; i++) {
                const t = (i + 0.5) / n;
                const u = u0 + (u1 - u0) * t;
                const v = v0 + (v1 - v0) * t;
                // Gate gap half-way along the first side.
                if (v0 === v1 && v0 === 1 && Math.abs(u - FIELD_U / 2) < 4) continue;
                put6(u, v, Math.atan2(-(v1 - v0), u1 - u0));
              }
            };
            const put6 = (u: number, v: number, rot: number) => {
              const p = at(f, cx, cz, u, v);
              if (!blocked(p.x, p.z)) props.add('fence_rail', p.x, p.y, p.z, f.rot + rot, 1);
            };
            edge(1, 1, FIELD_U - 1, 1);
            edge(1, FIELD_V - 1, FIELD_U - 1, FIELD_V - 1);
            edge(1, 1, 1, FIELD_V - 1);
            edge(FIELD_U - 1, 1, FIELD_U - 1, FIELD_V - 1);
            if (f.peaceful) {
              const n = rng.int(5, 12);
              const hx = rng.range(15, FIELD_U - 15);
              const hz = rng.range(12, FIELD_V - 12);
              for (let i = 0; i < n; i++) {
                const p = at(f, cx, cz, THREE.MathUtils.clamp(hx + rng.gauss() * 10, 4, FIELD_U - 4), THREE.MathUtils.clamp(hz + rng.gauss() * 8, 4, FIELD_V - 4));
                if (!blocked(p.x, p.z)) props.add('cow', p.x, p.y, p.z, rng.range(0, Math.PI * 2), rng.range(0.92, 1.08), rng.pick([0x6a4a32, 0xf2f0ea, 0x8a5a3a, 0x3a3532, 0xc9b49a]));
              }
            }
          } else if (k === Crop.Hay && rng.chance(0.6)) {
            // Round bales left in rows after baling.
            for (let v = 10; v < FIELD_V - 6; v += 14)
              for (let u = 8; u < FIELD_U - 6; u += rng.range(9, 16)) {
                const p = at(f, cx, cz, u, v + rng.range(-1.5, 1.5));
                if (!blocked(p.x, p.z)) props.add('haybale', p.x, p.y, p.z, f.rot + rng.range(-0.3, 0.3));
              }
          }
        }
    }
  }
}

/** GLSL: texture lookup of a plot's crop (−1 when there is none). Reads uniforms farms[], farmIds[] and fieldTex. */
export const FIELD_GLSL = /* glsl */ `
uniform sampler2D fieldTex;
int fieldKind(int farm, vec2 cell) {
  ivec2 c = ivec2(cell) - ivec2(${CX0}, ${CZ0});
  if (c.x < 0 || c.x >= ${NX} || c.y < 0 || c.y >= ${NZ}) return -1;
  int k = int(texelFetch(fieldTex, ivec2(c.x + c.y * ${NX}, farm), 0).r * 255.0 + 0.5);
  return k == 255 ? -1 : k;
}
`;
