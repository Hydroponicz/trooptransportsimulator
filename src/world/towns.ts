import * as THREE from 'three';
import type { RNG } from '../util/noise';
import type { Props, ProtoName } from './props';
import type { Terrain } from './terrain';

export interface Town {
  name: string;
  x: number;
  z: number;
  y: number;
  r: number;
  rot: number;
  /** Straddles the front line: battle-damaged and fought over. */
  contested: boolean;
  enemySide: boolean;
}

export const TOWN_NAMES = [
  'Volnovka', 'Krasny Brod', 'Sosnivka', 'Belaya Gorka', 'Pryluky', 'Zarechye', 'Olkhovets', 'Dubrava',
  'Lesnoye', 'Kamenka', 'Bystritsa', 'Hlynsk', 'Ozerne', 'Vyshnevo', 'Staritsa', 'Polyana',
  'Topolino', 'Verkhnya', 'Hrabove', 'Lisichki', 'Sokolets', 'Mykhailivka', 'Borovoe', 'Klenovka',
  'Zhuravli', 'Pervomaisk', 'Rudnya', 'Dibrova', 'Yablunivka', 'Chervone', 'Vodyane', 'Kalinovo',
  'Stepove', 'Zolotarivka', 'Nikolske', 'Hrushivka',
];

/** House paints: cream, butter, ochre, pale blue, mint, salmon, whitewash, lilac grey, pale green. */
const WALL_PAINT = [0xf3e9cf, 0xf1dc9c, 0xdfb874, 0xbfd4e4, 0xcadfba, 0xeac0a6, 0xf6f4ee, 0xd8d2db, 0xdbe4b4, 0xf6f4ee];
/** Panel blocks: bare concrete, or painted in faded pastels. */
const BLOCK_PAINT = [0xffffff, 0xf2ead8, 0xdfe6ea, 0xf0e2cf, 0xe4ead8];

const STREET = 42;
const AVENUE = 38;

/** Lay out streets and buildings for a town on its (already flattened) plateau. */
export function buildTown(t: Town, props: Props, terrain: Terrain, rng: RNG) {
  const c = Math.cos(t.rot);
  const s = Math.sin(t.rot);
  const w = (lx: number, lz: number): [number, number] => [t.x + lx * c + lz * s, t.z - lx * s + lz * c];
  const put = (name: ProtoName, lx: number, lz: number, rot = 0, scale: number | [number, number, number] = 1, color?: number) => {
    const [x, z] = w(lx, lz);
    props.add(name, x, terrain.heightAt(x, z), z, t.rot + rot, scale, color);
  };
  const ruinP = t.contested ? 0.82 : 0.04;
  const R = t.r;

  // Streets: parallel roads every STREET m, cross streets every 2×AVENUE m.
  for (let lz = -Math.floor(R / STREET) * STREET; lz <= R; lz += STREET) {
    const half = Math.sqrt(Math.max(0, R * R - lz * lz)) * 0.95;
    if (half < 20) continue;
    put('slab', 0, lz, 0, [half * 2, 1, 7]);
  }
  for (let lx = -Math.floor(R / (AVENUE * 2)) * AVENUE * 2; lx <= R; lx += AVENUE * 2) {
    const half = Math.sqrt(Math.max(0, R * R - lx * lx)) * 0.95;
    if (half < 20) continue;
    put('slab', lx, 0, 0, [7, 1, half * 2]);
  }

  // Town square with a church.
  put('church', 0, 0, rng.chance(0.5) ? 0 : Math.PI, 1, t.contested && rng.chance(0.5) ? 0x9a948a : undefined);

  // Building lots between the streets.
  const LOT = 14;
  const used = new Set<string>();
  for (let lz = -R; lz <= R; lz += LOT) {
    for (let lx = -R; lx <= R; lx += LOT) {
      const d = Math.hypot(lx, lz);
      if (d > R - 8 || d < 22) continue;
      const mz = ((lz % STREET) + STREET) % STREET;
      const mx = ((lx % (AVENUE * 2)) + AVENUE * 2) % (AVENUE * 2);
      if (mz < 8 || mz > STREET - 8 || mx < 7 || mx > AVENUE * 2 - 7) continue;
      const key = `${lx},${lz}`;
      if (used.has(key)) continue;
      const density = 0.85 - (d / R) * 0.5;
      if (!rng.chance(density)) continue;
      // Face the nearest street.
      const rot = mz < STREET / 2 ? Math.PI : 0;
      const ruined = rng.chance(ruinP * (1 - (d / R) * 0.2));
      const central = d < R * 0.45;
      if (central && rng.chance(0.3) && !used.has(`${lx + LOT},${lz}`)) {
        used.add(`${lx + LOT},${lz}`);
        put(ruined ? 'ruin_apartment' : 'apartment', lx + LOT / 2, lz, rot, 1, ruined ? undefined : rng.pick(BLOCK_PAINT));
      } else if (ruined) {
        put(rng.chance(0.7) ? 'ruin_house' : 'rubble', lx, lz, rot + rng.range(-0.1, 0.1));
      } else {
        const kind: ProtoName = rng.pick(['house_a', 'house_b', 'house_c', 'house_a', 'house_d', 'house_c'] as ProtoName[]);
        // Rendered walls in the region's pastels (the brick house ignores the tint).
        const c = new THREE.Color(rng.pick(WALL_PAINT));
        const v = rng.range(0.94, 1.03);
        put(kind, lx, lz, rot + rng.range(-0.05, 0.05), 1, c.multiplyScalar(v).getHex());
      }
      used.add(key);
    }
  }

  // Debris and wrecks in the streets of a fought-over town.
  if (t.contested) {
    for (let i = 0; i < 14; i++) {
      const a = rng.range(0, Math.PI * 2);
      const r = rng.range(15, R * 0.9);
      put(rng.chance(0.6) ? 'rubble' : 'wreck', Math.cos(a) * r, Math.sin(a) * r, rng.range(0, 6));
    }
  } else {
    // Farm buildings on the outskirts.
    for (let i = 0; i < 3; i++) {
      const a = rng.range(0, Math.PI * 2);
      put('barn', Math.cos(a) * (R + 25), Math.sin(a) * (R + 25), a);
      if (rng.chance(0.7)) put('silo', Math.cos(a) * (R + 25) + 12, Math.sin(a) * (R + 25) + 6);
    }
  }
}
