import * as THREE from 'three';
import type { RNG } from '../util/noise';
import type { Props, ProtoName } from './props';
import type { Terrain } from './terrain';
import { FOOTPRINT } from './buildings';

export type SettlementKind = 'city' | 'town' | 'village';

/** A street inside a settlement (world coordinates), for drawing and for traffic. */
export interface Street {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  /** Carriageway width (m). */
  w: number;
}

export interface Town {
  name: string;
  x: number;
  z: number;
  y: number;
  r: number;
  rot: number;
  kind: SettlementKind;
  /** Straddles the front line: battle-damaged and fought over. */
  contested: boolean;
  enemySide: boolean;
  /** Street network, split at junctions (filled in by buildTown). */
  streets: Street[];
}

export const TOWN_NAMES = [
  'Volnovka', 'Krasny Brod', 'Sosnivka', 'Belaya Gorka', 'Pryluky', 'Zarechye', 'Olkhovets', 'Dubrava',
  'Lesnoye', 'Kamenka', 'Bystritsa', 'Hlynsk', 'Ozerne', 'Vyshnevo', 'Staritsa', 'Polyana',
  'Topolino', 'Verkhnya', 'Hrabove', 'Lisichki', 'Sokolets', 'Mykhailivka', 'Borovoe', 'Klenovka',
  'Zhuravli', 'Pervomaisk', 'Rudnya', 'Dibrova', 'Yablunivka', 'Chervone', 'Vodyane', 'Kalinovo',
  'Stepove', 'Zolotarivka', 'Nikolske', 'Hrushivka', 'Malyn', 'Hrebinka', 'Tarasivka', 'Lypova Dolyna',
  'Sadove', 'Myrne', 'Kvitneve', 'Zelenyi Hai', 'Pidhirne', 'Ternivka', 'Orikhiv', 'Kozachyi',
];
export const CITY_NAMES = ['Novohrad', 'Krasnodolsk', 'Zavodsk', 'Dniprovets', 'Slavutych'];

/** House paints: cream, butter, ochre, pale blue, mint, salmon, whitewash, lilac grey, pale green. */
const WALL_PAINT = [0xf3e9cf, 0xf1dc9c, 0xdfb874, 0xbfd4e4, 0xcadfba, 0xeac0a6, 0xf6f4ee, 0xd8d2db, 0xdbe4b4, 0xf6f4ee];
/** Panel blocks: bare concrete, or painted in faded pastels. */
const BLOCK_PAINT = [0xffffff, 0xf2ead8, 0xdfe6ea, 0xf0e2cf, 0xe4ead8];
/** Stalin-era and town-centre facades: cream, ochre, salmon, pale green, grey. */
const CENTRE_PAINT = [0xf0e2c4, 0xe6c88e, 0xe8c0a8, 0xd2dcc0, 0xd8d4cc, 0xf2d8b0];
/** Car paints: white, silver, black, navy, red, dark green, beige, sky blue. */
export const CAR_PAINT = [0xf2f2ee, 0xb8bcbf, 0x2a2c2e, 0x2a3a5a, 0x9a2a24, 0x2f4a36, 0xd6c8a4, 0x7aa0c4, 0xf2f2ee, 0xb8bcbf];

/** Lay out a settlement on its (already flattened) plateau. */
export function buildTown(t: Town, props: Props, terrain: Terrain, rng: RNG) {
  t.streets = [];
  if (t.kind === 'village') buildVillage(t, props, terrain, rng);
  else buildGrid(t, props, terrain, rng);
}

/** Local → world placement helpers for a settlement. */
function placer(t: Town, props: Props, terrain: Terrain) {
  const c = Math.cos(t.rot);
  const s = Math.sin(t.rot);
  const w = (lx: number, lz: number): [number, number] => [t.x + lx * c + lz * s, t.z - lx * s + lz * c];
  const put = (name: ProtoName, lx: number, lz: number, rot = 0, scale: number | [number, number, number] = 1, color?: number) => {
    const [x, z] = w(lx, lz);
    props.add(name, x, terrain.heightAt(x, z), z, t.rot + rot, scale, color);
  };
  const street = (ax: number, az: number, bx: number, bz: number, width: number) => {
    const [x0, z0] = w(ax, az);
    const [x1, z1] = w(bx, bz);
    t.streets.push({ ax: x0, az: z0, bx: x1, bz: z1, w: width });
  };
  return { w, put, street };
}

/**
 * Cities and towns: a street grid with blocks zoned by distance from the
 * centre. A plaza with a memorial at the heart; Stalin-era blocks, shops and
 * offices round it; panel-block estates with towers, schools, parks and
 * garages in the middle ring; five-storey blocks and petrol stations further
 * out; private houses behind board fences at the edge; and an industrial
 * quarter of factories and warehouses on one side. Contested towns get the
 * same plan, ruined.
 */
function buildGrid(t: Town, props: Props, terrain: Terrain, rng: RNG) {
  const { put, street } = placer(t, props, terrain);
  const city = t.kind === 'city';
  const R = t.r;
  const SX = city ? 110 : 84;
  const SZ = city ? 92 : 72;
  const ruinP = t.contested ? 0.8 : 0;
  const indAng = rng.range(-Math.PI, Math.PI);
  const inside = (x: number, z: number, m = 0) => Math.hypot(x, z) < R - m;

  // Streets: lines at half-spacings so the centre falls in the middle of a block (the plaza).
  // The two pairs round the centre are avenues.
  const nx = Math.floor(R / SX + 0.5);
  const nz = Math.floor(R / SZ + 0.5);
  const xs: { v: number; w: number }[] = [];
  const zs: { v: number; w: number }[] = [];
  for (let k = -nx; k < nx; k++) xs.push({ v: (k + 0.5) * SX, w: k === 0 || k === -1 ? (city ? 16 : 11) : city ? 10 : 8 });
  for (let k = -nz; k < nz; k++) zs.push({ v: (k + 0.5) * SZ, w: k === 0 || k === -1 ? (city ? 16 : 11) : city ? 10 : 8 });
  const span = (v: number) => Math.sqrt(Math.max(0, R * R - v * v)) * 0.97;
  for (const L of zs) {
    const h = span(L.v);
    if (h < 25) continue;
    put('slab', 0, L.v, 0, [h * 2, 1, L.w]);
    const cuts = [-h, ...xs.map((q) => q.v).filter((x) => Math.abs(x) < h), h];
    for (let i = 0; i + 1 < cuts.length; i++) street(cuts[i], L.v, cuts[i + 1], L.v, L.w);
  }
  for (const L of xs) {
    const h = span(L.v);
    if (h < 25) continue;
    put('slab', L.v, 0, 0, [L.w, 1, h * 2]);
    const cuts = [-h, ...zs.map((q) => q.v).filter((z) => Math.abs(z) < h), h];
    for (let i = 0; i + 1 < cuts.length; i++) street(L.v, cuts[i], L.v, cuts[i + 1], L.w);
  }
  // Avenue trees.
  if (!t.contested)
    for (const L of zs.filter((q) => q.w > 12))
      for (let x = -span(L.v) + 10; x < span(L.v) - 10; x += 14)
        for (const sd of [-1, 1]) if (!xs.some((q) => Math.abs(q.v - x) < q.w / 2 + 4)) put('streettree', x, L.v + sd * (L.w / 2 + 2), rng.range(0, 6), rng.range(0.85, 1.15));

  const ruin = (name: ProtoName): ProtoName | null => {
    if (!rng.chance(ruinP)) return name;
    if (name.startsWith('house') || name === 'farmhouse' || name === 'shed') return rng.chance(0.7) ? 'ruin_house' : 'rubble';
    if (name === 'parkedcar') return 'wreck';
    if (name === 'streettree' || name === 'playground' || name === 'kiosk' || name === 'busstop') return rng.chance(0.5) ? null : 'rubble';
    return rng.chance(0.75) ? 'ruin_apartment' : 'rubble';
  };
  const build = (name: ProtoName, x: number, z: number, rot: number, color?: number, scale: number | [number, number, number] = 1) => {
    const n = ruin(name);
    if (n) put(n, x, z, rot, scale, n === name ? color : undefined);
  };

  for (let i = 0; i < xs.length - 1; i++)
    for (let j = 0; j < zs.length - 1; j++) {
      const x0 = xs[i].v + xs[i].w / 2 + 3;
      const x1 = xs[i + 1].v - xs[i + 1].w / 2 - 3;
      const z0 = zs[j].v + zs[j].w / 2 + 3;
      const z1 = zs[j + 1].v - zs[j + 1].w / 2 - 3;
      const cx = (x0 + x1) / 2;
      const cz = (z0 + z1) / 2;
      const d = Math.hypot(cx, cz) / R;
      if (d > 1.02) continue;
      const bw = x1 - x0;
      const bd = z1 - z0;
      const ang = Math.atan2(cz, cx);
      const dAng = Math.abs(Math.atan2(Math.sin(ang - indAng), Math.cos(ang - indAng)));
      const centre = i === nx - 1 && j === nz - 1;
      const fringe = d > (city ? 0.8 : 0.62);
      const industrial = city ? dAng < 0.6 && d > 0.38 && !fringe : !t.contested && dAng < 0.4 && d > 0.55 && d < 0.85;

      // Fit a building of the given footprint, facing the given edge.
      const fits = (name: ProtoName, x: number, z: number, rot: number, m = 2) => {
        const fp = FOOTPRINT[name as keyof typeof FOOTPRINT] ?? [10, 10];
        const hx = (Math.abs(Math.cos(rot)) * fp[0] + Math.abs(Math.sin(rot)) * fp[1]) / 2;
        const hz = (Math.abs(Math.sin(rot)) * fp[0] + Math.abs(Math.cos(rot)) * fp[1]) / 2;
        return x - hx >= x0 - 0.5 && x + hx <= x1 + 0.5 && z - hz >= z0 - 0.5 && z + hz <= z1 + 0.5 && [[x - hx, z - hz], [x + hx, z - hz], [x - hx, z + hz], [x + hx, z + hz]].every(([a, b]) => inside(a, b, m));
      };
      const tryBuild = (name: ProtoName, x: number, z: number, rot: number, color?: number) => {
        if (!fits(name, x, z, rot)) return false;
        build(name, x, z, rot, color);
        return true;
      };
      // Buildings along the north and south edges (fronts to the street), returns the depth used.
      const edgeRow = (pick: () => ProtoName, gap: number, color: () => number | undefined) => {
        let used = 0;
        for (const side of [-1, 1]) {
          let x = x0;
          while (x < x1) {
            const name = pick();
            const fp = FOOTPRINT[name as keyof typeof FOOTPRINT] ?? [12, 10];
            if (x + fp[0] > x1) break;
            const z = side < 0 ? z0 + fp[1] / 2 + 1 : z1 - fp[1] / 2 - 1;
            tryBuild(name, x + fp[0] / 2, z, side < 0 ? Math.PI : 0, color());
            used = Math.max(used, fp[1] + 1);
            x += fp[0] + gap;
          }
        }
        return used;
      };
      const parkCars = (n: number) => {
        if (t.contested) return;
        for (let k = 0; k < n; k++) {
          const along = rng.range(x0 + 4, x1 - 4);
          const side = rng.chance(0.5) ? z0 + 1.2 : z1 - 1.2;
          if (inside(along, side, 4)) put('parkedcar', along, side, Math.PI / 2 + (rng.chance(0.5) ? 0 : Math.PI), 1, rng.pick(CAR_PAINT));
        }
      };
      const trees = (n: number, ax0 = x0 + 5, ax1 = x1 - 5, az0 = z0 + 5, az1 = z1 - 5) => {
        for (let k = 0; k < n; k++) {
          const x = rng.range(ax0, ax1);
          const z = rng.range(az0, az1);
          if (inside(x, z, 6)) build('streettree', x, z, rng.range(0, 6), undefined, rng.range(0.8, 1.2));
        }
      };

      if (centre) {
        // The town square: paving, a memorial, a fountain, trees and kiosks; the church faces it.
        put('plaza', cx, cz, 0, [bw, 1, bd], t.contested ? 0x8a867e : undefined);
        build('monument', cx, cz - bd * 0.15, 0);
        if (city) build('fountain', cx, cz + bd * 0.22, 0);
        for (let k = 0; k < 10; k++) {
          const a = (k / 10) * Math.PI * 2;
          build('streettree', cx + Math.cos(a) * bw * 0.42, cz + Math.sin(a) * bd * 0.4, a);
        }
        for (const sx of [-1, 1]) build('kiosk', cx + sx * bw * 0.3, cz + bd * 0.4, Math.PI, rng.pick([0xd8352c, 0x2f6a8a, 0xf2c23a]));
        build('busstop', cx + bw * 0.1, z1 - 1, 0);
        continue;
      }
      if (j === nz - 1 && i === nx && !city) {
        build('church', cx, cz, rng.chance(0.5) ? 0 : Math.PI, t.contested ? 0x9a948a : undefined);
        continue;
      }
      if (city && i === nx - 2 && j === nz - 1) {
        // Cathedral off the square.
        put(t.contested ? 'ruin_apartment' : 'church', cx, cz, Math.PI / 2, 1.5);
        trees(6);
        continue;
      }
      if (industrial) {
        // Works: a factory or two, warehouses, garages, and the odd chimney or water tower.
        let z = z0 + 13;
        tryBuild('factory', x0 + 26, z, 0) || tryBuild('warehouse', x0 + 16, z0 + 10, 0);
        if (rng.chance(0.6)) tryBuild('chimney', x0 + 3, z0 + 4, 0);
        z = z1 - 10;
        tryBuild('warehouse', x1 - 16, z, Math.PI) || tryBuild('garages', x1 - 14, z1 - 4, Math.PI);
        if (rng.chance(0.3)) tryBuild('watertower', cx, cz, 0);
        tryBuild('garages', x0 + 14, z1 - 4, Math.PI);
        parkCars(4);
        continue;
      }
      if (fringe) {
        // Private houses on long plots, board fences along the street, fruit trees in the gardens.
        for (const side of [-1, 1])
          for (let x = x0 + 8; x < x1 - 6; x += 17) {
            const z = side < 0 ? z0 + 9 : z1 - 9;
            if (!inside(x, z, 10)) continue;
            const name = rng.pick(['house_a', 'house_b', 'house_c', 'house_d', 'house_a', 'house_c'] as ProtoName[]);
            const c = new THREE.Color(rng.pick(WALL_PAINT)).multiplyScalar(rng.range(0.94, 1.03)).getHex();
            build(name, x, z, side < 0 ? Math.PI : 0, c);
            if (!t.contested) {
              const fz = side < 0 ? z0 + 0.6 : z1 - 0.6;
              build('fence_board', x - 6, fz, 0);
              build('fence_board', x + 6, fz, 0);
              if (rng.chance(0.6)) build('streettree', x + rng.range(-5, 5), side < 0 ? z0 + 19 : z1 - 19, rng.range(0, 6), undefined, rng.range(0.6, 0.85));
              if (rng.chance(0.25)) build('shed', x + 6, side < 0 ? z0 + 17 : z1 - 17, side < 0 ? Math.PI : 0, rng.pick([0xffffff, 0xd8c8a8]));
              if (rng.chance(0.3)) build('parkedcar', x + 5.5, side < 0 ? z0 + 4 : z1 - 4, side < 0 ? Math.PI : 0, rng.pick(CAR_PAINT));
            }
          }
        continue;
      }
      if (d < (city ? 0.3 : 0.4)) {
        // Town centre: perimeter blocks of Stalin-era flats, shops and offices round a courtyard.
        const used = edgeRow(
          () => rng.pick(city ? (['stalinka', 'shops', 'stalinka', 'office'] as ProtoName[]) : (['shops', 'apartment', 'shops'] as ProtoName[])),
          city ? 1 : 3,
          () => rng.pick(CENTRE_PAINT),
        );
        if (city) {
          for (const side of [-1, 1]) tryBuild('shops', side < 0 ? x0 + 7.6 : x1 - 7.6, cz, side < 0 ? -Math.PI / 2 : Math.PI / 2, rng.pick(CENTRE_PAINT));
        }
        trees(4, x0 + 18, x1 - 18, z0 + used + 4, z1 - used - 4);
        parkCars(6);
        continue;
      }
      if (city && d < 0.62 && rng.chance(0.12)) {
        // Park: trees, paths, a fountain or playground.
        trees(22);
        build(rng.chance(0.5) ? 'fountain' : 'playground', cx, cz, rng.range(0, 6));
        continue;
      }
      if (city && d < 0.62) {
        // Panel-block estate: slabs along the long sides, a tower, a playground, garages; or a school.
        if (rng.chance(0.15)) {
          tryBuild('school', cx, z0 + 7.6, Math.PI, rng.pick(CENTRE_PAINT));
          trees(6, x0 + 4, x1 - 4, z1 - 14, z1 - 4);
          continue;
        }
        const paint = () => rng.pick(BLOCK_PAINT);
        tryBuild('block9', x0 + 19, z0 + 7, Math.PI, paint()) || tryBuild('apartment', x0 + 13, z0 + 7, Math.PI, paint());
        tryBuild('block9', x1 - 19, z1 - 7, 0, paint()) || tryBuild('apartment', x1 - 13, z1 - 7, 0, paint());
        if (rng.chance(0.65)) tryBuild('tower16', x1 - 11, z0 + 11, Math.PI, paint());
        else tryBuild('apartment', x1 - 13, z0 + 7, Math.PI, paint());
        if (!t.contested) build('playground', x0 + 14, cz + 2, 0);
        tryBuild('garages', x0 + 14, z1 - 4, Math.PI);
        trees(8, x0 + 4, x1 - 4, z0 + 16, z1 - 16);
        parkCars(8);
        continue;
      }
      // Five-storey blocks in pairs, a petrol station on the avenues, shops on corners.
      const nearAvenue = xs[i].w > 12 || xs[i + 1].w > 12 || zs[j].w > 12 || zs[j + 1].w > 12;
      if (!t.contested && nearAvenue && rng.chance(0.25) && tryBuild('gasstation', x0 + 13, z0 + 9, Math.PI)) {
        tryBuild('apartment', x1 - 13, z1 - 7, 0, rng.pick(BLOCK_PAINT));
        continue;
      }
      const paint = () => rng.pick(BLOCK_PAINT);
      for (const [ax, az, r] of [[x0 + 13, z0 + 7, Math.PI], [x1 - 13, z0 + 7, Math.PI], [x0 + 13, z1 - 7, 0], [x1 - 13, z1 - 7, 0]] as const)
        if (!tryBuild('apartment', ax, az, r, paint()) && city) tryBuild('shops', ax, az, r, rng.pick(CENTRE_PAINT));
      if (!city) {
        // Town edges between the blocks: houses rather than more flats.
        for (let x = x0 + 8; x < x1 - 6; x += 17) {
          const z = cz;
          if (!inside(x, z, 10) || bw < 40) continue;
          const c = new THREE.Color(rng.pick(WALL_PAINT)).getHex();
          build(rng.pick(['house_a', 'house_c', 'house_b'] as ProtoName[]), x, z, rng.chance(0.5) ? 0 : Math.PI, c);
        }
      }
      trees(5, x0 + 4, x1 - 4, z0 + 15, z1 - 15);
      if (rng.chance(0.4)) build('kiosk', x0 + 2, cz, Math.PI / 2, rng.pick([0xd8352c, 0x2f6a8a, 0xf2c23a]));
      parkCars(5);
    }

  // Wrecks and debris in the streets of a fought-over town.
  if (t.contested) {
    for (let i = 0; i < 18; i++) {
      const a = rng.range(0, Math.PI * 2);
      const r = rng.range(15, R * 0.9);
      put(rng.chance(0.6) ? 'rubble' : 'wreck', Math.cos(a) * r, Math.sin(a) * r, rng.range(0, 6));
    }
  }
}

/**
 * A village strung along its street (with a lane or two off it): houses
 * behind board fences with long gardens and fruit trees, a shop and a bus
 * stop, a chapel in the bigger ones, and farmyards at the ends of the street
 * with barns, sheds, haystacks and a tractor in the machinery shed.
 */
function buildVillage(t: Town, props: Props, terrain: Terrain, rng: RNG) {
  const { put, street } = placer(t, props, terrain);
  const R = t.r;
  const len = R * 1.9;
  put('slab', 0, 0, 0, [len, 1, 6.5]);
  street(-len / 2, 0, len / 2, 0, 6.5);
  // A lane off the main street in larger villages.
  const lanes: number[] = R > 75 ? [rng.range(-R * 0.4, R * 0.4)] : [];
  for (const lx of lanes) {
    put('slab', lx, R * 0.4, 0, [5, 1, R * 0.8]);
    street(lx, 0, lx, R * 0.8, 5);
  }
  const used: [number, number][] = [];
  const free = (x: number, z: number, m: number) => !used.some(([a, b]) => Math.hypot(a - x, b - z) < m) && !lanes.some((lx) => Math.abs(lx - x) < 7 && z > 0);
  const house = (x: number, z: number, rot: number) => {
    if (!free(x, z, 13)) return;
    used.push([x, z]);
    const c = new THREE.Color(rng.pick(WALL_PAINT)).multiplyScalar(rng.range(0.94, 1.03)).getHex();
    put(rng.pick(['house_a', 'house_c', 'house_a', 'house_b', 'house_d', 'farmhouse'] as ProtoName[]), x, z, rot, 1, c);
    const fz = z > 0 ? z - 9.5 : z + 9.5;
    if (Math.abs(fz) > 3.5) {
      put('fence_board', x - 4, fz, 0);
      put('fence_board', x + 4, fz, 0);
    }
    // Garden behind: fruit trees, a shed, sometimes a car in the yard.
    const back = z > 0 ? 1 : -1;
    for (let k = 0; k < rng.int(1, 3); k++) put('streettree', x + rng.range(-6, 6), z + back * rng.range(11, 22), rng.range(0, 6), rng.range(0.55, 0.8));
    if (rng.chance(0.45)) put('shed', x + rng.range(-5, 5), z + back * 12, rng.range(-0.1, 0.1), 1, rng.pick([0xffffff, 0xd8c8a8, 0xb8c8d8]));
    if (rng.chance(0.25)) put('parkedcar', x + 6, z - back * 4, z > 0 ? 0 : Math.PI, 1, rng.pick(CAR_PAINT));
  };
  for (let x = -len / 2 + 14; x < len / 2 - 14; x += rng.range(17, 22))
    for (const side of [-1, 1]) if (rng.chance(0.85)) house(x, side * 13, side > 0 ? Math.PI : 0);
  for (const lx of lanes) for (let z = 22; z < R * 0.8; z += 19) for (const sd of [-1, 1]) if (rng.chance(0.8)) house(lx + sd * 12, z, (sd * Math.PI) / 2 + Math.PI);
  // Shop and bus stop by the middle; a chapel in bigger villages.
  put('kiosk', rng.range(-8, 8), 6.5, Math.PI, 1, rng.pick([0xd8352c, 0x2f6a8a, 0xf2c23a]));
  put('busstop', rng.range(-20, 20), -5.5, 0);
  if (R > 80 && free(0, -36, 18)) put('church', 0, -36, Math.PI / 2, 0.75);
  // Farmyards at the ends of the street.
  for (const end of [-1, 1]) {
    const fx = end * (len / 2 + 22);
    const fz = rng.range(-20, 20);
    put('barn', fx, fz, Math.PI / 2 + rng.range(-0.1, 0.1));
    put('machineshed', fx + end * 4, fz + 30, Math.PI / 2);
    put('tractor_parked', fx + end * 4, fz + 30, Math.PI / 2 + Math.PI, 1, rng.pick([0xb8352c, 0x2f5a9a, 0x3f7a3a]));
    if (rng.chance(0.6)) put('silo', fx - end * 14, fz - 12);
    for (let k = 0; k < 3; k++) put('haystack', fx + end * rng.range(10, 24), fz + rng.range(-28, 0), rng.range(0, 6), rng.range(0.8, 1.1));
  }
}
