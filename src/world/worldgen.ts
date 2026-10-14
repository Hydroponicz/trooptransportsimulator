import * as THREE from 'three';
import { Noise2D, RNG } from '../util/noise';
import { ColliderSet } from './colliders';
import { Frontline } from './frontline';
import { Props } from './props';
import { Roads } from './roads';
import { buildRoadside } from './roadside';
import { buildSite, type Site, type SiteKind, type SiteDecor } from './sites';
import { PLAY_HALF, Terrain } from './terrain';
import { Vegetation } from './vegetation';
import { buildTown, TOWN_NAMES, type Town } from './towns';
import { groundDetailTexture } from '../util/textures';

export type EnemyKind = 'aa' | 'mg' | 'manpads';
export interface EnemyPos {
  pos: THREE.Vector3;
  kind: EnemyKind;
}

export interface World {
  seed: number;
  terrain: Terrain;
  front: Frontline;
  sites: Site[];
  base: Site;
  colliders: ColliderSet;
  vegetation: Vegetation;
  roads: Roads;
  towns: Town[];
  enemies: EnemyPos[];
  smokeSpots: THREE.Vector3[];
  windsocks: THREE.Object3D[];
  group: THREE.Group;
}

const NAMES: Record<SiteKind, string[]> = {
  base: ['Camp Anvil', 'Camp Liberty', 'Camp Ironside', 'Camp Bastion'],
  fob: ['FOB Viper', 'FOB Granite', 'FOB Hatchet', 'FOB Raven', 'FOB Sentinel', 'FOB Warhorse'],
  cop: ['COP Hammer', 'COP Spartan', 'COP Badger', 'COP Wolfhound', 'COP Tusk', 'COP Gauntlet', 'COP Mako', 'COP Rattler'],
  lz: ['LZ Alpha', 'LZ Bravo', 'LZ Charlie', 'LZ Delta', 'LZ Echo', 'LZ Foxtrot', 'LZ Golf', 'LZ Hotel', 'LZ India', 'LZ Juliet', 'LZ Kilo', 'LZ Lima'],
};

const RADIUS: Record<SiteKind, number> = { base: 175, fob: 112, cop: 64, lz: 34 };
const BLEND: Record<SiteKind, number> = { base: 110, fob: 80, cop: 70, lz: 45 };

export function generateWorld(seed: number, onProgress?: (msg: string) => void): World {
  const rng = new RNG(seed);
  const n1 = new Noise2D(seed ^ 0x1234);
  const n2 = new Noise2D(seed ^ 0x5678);
  const n3 = new Noise2D(seed ^ 0x9abc);
  const front = new Frontline(new Noise2D(seed ^ 0xdef0));
  const terrain = new Terrain(n1, n2, n3, front);
  const sites: Site[] = [];
  const towns: Town[] = [];
  const townNames = [...TOWN_NAMES];
  const names = Object.fromEntries(Object.entries(NAMES).map(([k, v]) => [k, [...v]])) as Record<SiteKind, string[]>;
  const takeName = (k: SiteKind) => {
    const arr = names[k];
    return arr.splice(Math.floor(rng.next() * arr.length), 1)[0] ?? `${k.toUpperCase()} ${sites.length}`;
  };

  /** Max height deviation across an area: lower = flatter. */
  const roughness = (x: number, z: number, r: number) => {
    const c = terrain.baseHeight(x, z);
    let dev = 0;
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2;
      for (const f of [0.5, 1]) dev = Math.max(dev, Math.abs(terrain.baseHeight(x + Math.cos(a) * r * f, z + Math.sin(a) * r * f) - c));
    }
    return dev;
  };

  const place = (kind: SiteKind, xr: (z: number) => [number, number], zr: [number, number], tries = 40): Site | null => {
    const radius = RADIUS[kind];
    let best: { x: number; z: number; score: number } | null = null;
    for (let i = 0; i < tries; i++) {
      const z = rng.range(zr[0], zr[1]);
      const [xa, xb] = xr(z);
      const x = rng.range(xa, xb);
      if (Math.abs(x) > PLAY_HALF - radius || Math.abs(z) > PLAY_HALF - radius) continue;
      if (terrain.baseHeight(x, z) < 6) continue;
      if (sites.some((s) => Math.hypot(s.x - x, s.z - z) < s.radius + radius + 220)) continue;
      if (towns.some((t) => Math.hypot(t.x - x, t.z - z) < t.r + radius + 150)) continue;
      const score = roughness(x, z, radius + 30);
      if (!best || score < best.score) best = { x, z, score };
    }
    if (!best) return null;
    let h = 0;
    for (let i = 0; i < 9; i++) {
      const a = (i / 8) * Math.PI * 2;
      const r = i === 8 ? 0 : radius * 0.7;
      h += terrain.baseHeight(best.x + Math.cos(a) * r, best.z + Math.sin(a) * r);
    }
    h = Math.max(4, h / 9);
    const fd = front.side(best.x, best.z);
    const site: Site = {
      id: sites.length,
      name: takeName(kind),
      kind,
      x: best.x,
      z: best.z,
      y: h,
      rot: kind === 'lz' ? 0 : Math.round(rng.range(-2, 2)) * (Math.PI / 2) + rng.range(-0.3, 0.3),
      radius,
      pads: [],
      waits: [],
      enemySide: fd > 0,
      frontDist: fd,
      services: {
        fuel: kind !== 'lz' && kind !== 'cop',
        repair: kind === 'base' || kind === 'fob',
        hangar: kind === 'base',
        flares: kind !== 'lz',
      },
    };
    sites.push(site);
    terrain.flattens.push({ x: site.x, z: site.z, radius, blend: BLEND[kind], height: h });
    return site;
  };

  onProgress?.('Surveying terrain');
  const base = place('base', () => [-2900, -2200], [-1200, 1200], 80)!;
  const bands = (n: number, lo: number, hi: number) =>
    Array.from({ length: n }, (_, i) => [lo + ((hi - lo) * i) / n, lo + ((hi - lo) * (i + 1)) / n] as [number, number]);
  for (const zr of bands(3, -2700, 2700)) place('fob', (z) => [-1800, front.x(z) - 1000], zr, 50);
  for (const zr of bands(6, -2900, 2900)) place('cop', (z) => [front.x(z) - 650, front.x(z) - 280], zr, 40);
  // Towns: some straddle the front (contested), others sit safely behind either line.
  const placeTown = (contested: boolean, xr: (z: number) => [number, number], zr: [number, number], rr: [number, number]) => {
    let best: { x: number; z: number; r: number; score: number } | null = null;
    for (let i = 0; i < 40; i++) {
      const z = rng.range(zr[0], zr[1]);
      const [xa, xb] = xr(z);
      const x = rng.range(xa, xb);
      const r = rng.range(rr[0], rr[1]);
      if (Math.abs(x) > PLAY_HALF - r - 100 || Math.abs(z) > PLAY_HALF - r - 100) continue;
      if (terrain.baseHeight(x, z) < 6) continue;
      if (sites.some((s) => Math.hypot(s.x - x, s.z - z) < s.radius + r + 140)) continue;
      if (towns.some((t) => Math.hypot(t.x - x, t.z - z) < t.r + r + 400)) continue;
      const score = roughness(x, z, r);
      if (!best || score < best.score) best = { x, z, r, score };
    }
    if (!best) return;
    let h = 0;
    for (let i = 0; i < 9; i++) {
      const a = (i / 8) * Math.PI * 2;
      const rr2 = i === 8 ? 0 : best.r * 0.7;
      h += terrain.baseHeight(best.x + Math.cos(a) * rr2, best.z + Math.sin(a) * rr2);
    }
    h = Math.max(5, h / 9);
    const town: Town = {
      name: townNames.splice(Math.floor(rng.next() * townNames.length), 1)[0] ?? 'Town',
      x: best.x,
      z: best.z,
      y: h,
      r: best.r,
      rot: rng.range(-0.6, 0.6),
      contested,
      enemySide: front.side(best.x, best.z) > 0,
    };
    towns.push(town);
    terrain.flattens.push({ x: town.x, z: town.z, radius: town.r + 10, blend: 170, height: h });
    if (!contested) terrain.farms.push({ x: town.x, z: town.z, rot: town.rot, r: town.r });
  };
  for (const zr of bands(3, -2600, 2600)) placeTown(true, (z) => [front.x(z) - 90, front.x(z) + 90], zr, [150, 190]);
  for (const zr of bands(4, -2700, 2700)) placeTown(false, (z) => [-2600, front.x(z) - 1000], zr, [85, 120]);
  for (const zr of bands(2, -2400, 2400)) placeTown(false, (z) => [front.x(z) + 900, 2800], zr, [85, 115]);

  for (const zr of bands(7, -2900, 2900)) place('lz', (z) => [front.x(z) - 1500, front.x(z) - 200], zr, 30);
  for (const zr of bands(4, -2600, 2600)) place('lz', (z) => [front.x(z) + 250, front.x(z) + 1100], zr, 30);

  // Shell craters along the front.
  const nearSite = (x: number, z: number, m: number) =>
    sites.some((s) => Math.hypot(s.x - x, s.z - z) < s.radius + m) || towns.some((t) => Math.hypot(t.x - x, t.z - z) < t.r + m);
  for (let i = 0; i < 340; i++) {
    const z = rng.range(-PLAY_HALF, PLAY_HALF);
    const x = front.x(z) + rng.gauss() * 230;
    if (nearSite(x, z, 60)) continue;
    terrain.addCrater({ x, z, r: rng.range(6, 17), depth: rng.range(1.2, 3.2) });
  }

  onProgress?.('Raising terrain');
  const detail = groundDetailTexture();
  const group = new THREE.Group();
  group.add(terrain.build(detail));

  onProgress?.('Building outposts');
  const colliders = new ColliderSet();
  const props = new Props(colliders);
  const decor: SiteDecor = { group: new THREE.Group(), windsocks: [] };
  for (const s of sites) buildSite(s, props, terrain, rng.fork(), decor);
  for (const t of towns) buildTown(t, props, terrain, rng.fork());

  // Enemy positions on the far side of the line.
  const enemies: EnemyPos[] = [];
  const enemyPlace = (kind: EnemyKind, lo: number, hi: number, n: number) => {
    let made = 0;
    for (let t = 0; t < n * 10 && made < n; t++) {
      const z = rng.range(-PLAY_HALF + 200, PLAY_HALF - 200);
      const x = front.x(z) + rng.range(lo, hi);
      if (Math.abs(x) > PLAY_HALF - 100) continue;
      if (nearSite(x, z, 220)) continue;
      const y = terrain.heightAt(x, z);
      if (y < 2) continue;
      enemies.push({ pos: new THREE.Vector3(x, y, z), kind });
      props.add(kind === 'aa' ? 'aagun' : 'sandbag', x, y, z, rng.range(0, 6));
      if (kind !== 'aa') {
        props.add('sandbag', x + 1.6, y, z + 0.8, rng.range(0, 6));
        props.add('sandbag', x - 1.2, y, z + 1.4, rng.range(0, 6));
      }
      made++;
    }
  };
  enemyPlace('aa', 450, 1900, 8);
  enemyPlace('mg', 120, 900, 18);
  enemyPlace('manpads', 400, 1700, 5);

  // Burning wrecks along the front.
  const smokeSpots: THREE.Vector3[] = [];
  for (let i = 0; i < 14; i++) {
    const z = rng.range(-PLAY_HALF + 300, PLAY_HALF - 300);
    const x = front.x(z) + rng.gauss() * 160;
    if (nearSite(x, z, 40)) continue;
    const y = terrain.heightAt(x, z);
    if (y < 1) continue;
    props.add('wreck', x, y, z, rng.range(0, 6));
    smokeSpots.push(new THREE.Vector3(x, y + 1.5, z));
  }

  onProgress?.('Grading roads');
  const roads = new Roads(terrain);
  const fobs = sites.filter((s) => s.kind === 'fob');
  const cops = sites.filter((s) => s.kind === 'cop');
  for (const f of fobs) roads.add(base.x, base.z, f.x, f.z, rng, 'main');
  for (const c of cops) {
    const f = fobs.reduce((a, b) => (Math.hypot(a.x - c.x, a.z - c.z) < Math.hypot(b.x - c.x, b.z - c.z) ? a : b));
    roads.add(f.x, f.z, c.x, c.z, rng, 'secondary');
  }
  // Every town gets a road: rear villages to the nearest friendly hub, contested
  // towns to the nearest outpost, enemy villages to the nearest enemy-side town.
  const hubs = [base, ...fobs, ...cops];
  const dist = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z);
  for (const t of towns) {
    let from: { x: number; z: number } | null = null;
    if (t.enemySide && !t.contested) {
      const others = towns.filter((o) => o !== t && (o.contested || o.enemySide));
      if (others.length) from = others.reduce((a, b) => (dist(a, t) < dist(b, t) ? a : b));
    } else {
      from = hubs.reduce((a, b) => (dist(a, t) < dist(b, t) ? a : b));
    }
    if (from) {
      // Stop at the edge of town; the town's own streets take it from there.
      const d = Math.hypot(from.x - t.x, from.z - t.z) || 1;
      const ex = t.x + ((from.x - t.x) / d) * t.r * 0.85;
      const ez = t.z + ((from.z - t.z) / d) * t.r * 0.85;
      roads.add(from.x, from.z, ex, ez, rng, 'track');
    }
  }
  roads.grade();
  // Clear a lane: walls get gates, and anything else sitting on a road is removed.
  // Large buildings are tested over their whole footprint, not just their center.
  props.removeAllWhere((x, z, box) => {
    if (roads.distance(x, z) < 9) return true;
    if (!box) return false;
    const x0 = box.minX - 3, x1 = box.maxX + 3, z0 = box.minZ - 3, z1 = box.maxZ + 3;
    const nx = Math.max(1, Math.ceil((x1 - x0) / 3)), nz = Math.max(1, Math.ceil((z1 - z0) / 3));
    for (let i = 0; i <= nx; i++)
      for (let j = 0; j <= nz; j++) if (roads.distance(x0 + ((x1 - x0) * i) / nx, z0 + ((z1 - z0) * j) / nz) < 7.5) return true;
    return false;
  }, ['slab']);
  group.add(roads.build(colliders));

  // Power lines, guard rails, fences, lights, signs and checkpoints.
  group.add(buildRoadside(roads, terrain, sites, towns, front, props, rng.fork()));

  // Rock outcrops and hay bales.
  for (let i = 0; i < 900; i++) {
    const x = rng.range(-PLAY_HALF, PLAY_HALF);
    const z = rng.range(-PLAY_HALF, PLAY_HALF);
    const y = terrain.heightAt(x, z);
    if (y < 2 || nearSite(x, z, 20) || roads.distance(x, z) < 13) continue;
    const slope = terrain.baseSlope(x, z);
    if (slope > 0.18 || rng.chance(0.15)) {
      const n = rng.int(1, 4);
      for (let k = 0; k < n; k++) props.add('rock', x + rng.range(-4, 4), y - 0.3, z + rng.range(-4, 4), rng.range(0, 6), rng.range(0.8, 2.6));
    }
  }
  for (const fm of terrain.farms)
    for (let i = 0; i < 30; i++) {
      const a = rng.range(0, Math.PI * 2);
      const r = rng.range(fm.r + 60, fm.r + 450);
      const x = fm.x + Math.cos(a) * r;
      const z = fm.z + Math.sin(a) * r;
      const y = terrain.heightAt(x, z);
      if (y < 2 || roads.distance(x, z) < 13 || roads.distance(x + 13, z) < 13 || nearSite(x, z, 10)) continue;
      const bales = rng.int(2, 6);
      for (let k = 0; k < bales; k++) props.add('haybale', x + k * 2.2, terrain.heightAt(x + k * 2.2, z), z, rng.range(-0.2, 0.2));
    }

  onProgress?.('Planting forests');
  const inFarmland = (x: number, z: number) =>
    terrain.farms.some((f) => Math.hypot(f.x - x, f.z - z) < f.r + 600) && n3.noise(x * 0.02, z * 0.02) > -0.55;
  const blocked = (x: number, z: number) =>
    nearSite(x, z, 28) ||
    roads.distance(x, z) < 14 ||
    inFarmland(x, z) ||
    enemies.some((e) => Math.abs(e.pos.x - x) < 14 && Math.abs(e.pos.z - z) < 14);
  const vegetation = new Vegetation(terrain, n3, rng.fork(), blocked);
  group.add(vegetation.group);
  group.add(props.build());
  group.add(decor.group);

  return {
    seed,
    terrain,
    front,
    sites,
    base,
    colliders,
    vegetation,
    roads,
    towns,
    enemies,
    smokeSpots,
    windsocks: decor.windsocks,
    group,
  };
}
